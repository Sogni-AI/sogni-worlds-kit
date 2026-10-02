// Painting a place when there is no photograph: Krea 2 on Sogni, through the
// same SDK and API key as everything else. A painted still is then ingested
// exactly like a photograph and is just as immutable afterwards.
import { RefusedError, watchRefusals } from './sogni.js';

/**
 * The image models a painted world uses. Identity Edit keeps the same
 * character (from up to two context pictures) in a new place. The Dark Beast
 * variants are the same models tuned for horror and gore, for worlds the
 * person has marked 18+.
 */
export const PAINT_MODELS = Object.freeze({
  text: 'krea2_turbo_fp8_scaled',
  edit: 'krea2_identity_edit_v1_2',
  darkText: 'dark_beast_krea2_fp8',
  darkEdit: 'dark_beast_krea2_identity_edit_v1_2',
});

/** The reviewed step counts: 8 for text-to-image, 10 for an edit. */
const STEPS = { text: 8, edit: 10 };

/** Painted stills are made at this size per canvas (twice the film canvas is out of the models' range). */
export const PAINT_SIZES = Object.freeze({
  '1344x768': [1344, 768],
  '1152x768': [1152, 768],
  '1152x864': [1152, 864],
  '992x992': [992, 992],
  '768x1344': [768, 1344],
});

export function paintModel({ edit, dark }) {
  if (edit) return dark ? PAINT_MODELS.darkEdit : PAINT_MODELS.edit;
  return dark ? PAINT_MODELS.darkText : PAINT_MODELS.text;
}

/**
 * Paint `count` candidates of one prompt. `context` is a list of image
 * buffers (at most two) for Identity Edit. Returns PNG buffers.
 */
export async function paint(session, { prompt, width, height, seed, context = [], count = 1, dark = false, contentFilter = false }) {
  if (context.length > 2) throw new Error('Identity Edit takes at most two context pictures');
  const edit = context.length > 0;
  const modelId = paintModel({ edit, dark });
  const refusals = watchRefusals(session.client);
  try {
    const project = await refusals.creating(() => session.client.projects.create({
      type: 'image',
      modelId,
      positivePrompt: prompt,
      negativePrompt: '',
      stylePrompt: '',
      steps: edit ? STEPS.edit : STEPS.text,
      guidance: 1,
      numberOfMedia: count,
      numberOfPreviews: 0,
      sizePreset: 'custom',
      width,
      height,
      ...(Number.isInteger(seed) ? { seed } : {}),
      ...(edit ? { contextImages: context } : {}),
      outputFormat: 'png',
      disableNSFWFilter: !contentFilter,
      network: 'fast',
      tokenType: session.billing.tokenType,
      billingMode: session.billing.mode,
    }));
    const urls = await Promise.race([
      project.waitForCompletion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('painting took longer than 15 minutes')), 15 * 60_000)),
    ]);
    const refused = refusals.get(project.id);
    if (refused) throw new RefusedError(refused);
    const images = [];
    for (const url of urls.filter(Boolean)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`downloading a painted still failed (HTTP ${response.status})`);
      images.push(Buffer.from(await response.arrayBuffer()));
    }
    if (!images.length) throw new Error('Sogni returned no pictures (the safe-content filter may have withheld them)');
    return { modelId, projectId: project.id, images };
  } finally {
    refusals.stop();
  }
}
