// Painting a place when there is no photograph: Krea 2 on Sogni, through the
// same SDK and API key as everything else. A painted still is then ingested
// exactly like a photograph and is just as immutable afterwards.
import { RefusedError, watchRefusals } from './sogni.js';
import { matureWorld } from './plan.js';

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

/**
 * The models that edit a picture: a close look (the place's own picture,
 * zoomed, with only the object changed) and a figure's clean plate (the object
 * alone on white). Mark's routing (2026-11-01); Qwen Image Edit, an older
 * model, is never used:
 *   things   FLUX 3 Image Klein: places, props, writing, a figure's plate
 *   people   Krea 2 Identity Edit: a close look with a person in it (reveal.people)
 *   mature   Dark Beast Krea 2 Identity Edit: every edit in an 18+ world
 *   premium  GPT Image 2.5 Sunburst: every other edit when the person chose
 *            `edits: premium` (paid from Premium Spark; an Unlimited plan does not cover it)
 */
export const EDIT_MODELS = Object.freeze({
  things: 'flux3_image_klein_sd_int8_convrot',
  people: 'krea2_identity_edit_v1_2',
  mature: 'dark_beast_krea2_identity_edit_v1_2',
  premium: 'gpt-image-2.5-sunburst',
});

/** GPT Image 2.5's quality when the person pays for the best edit. */
export const PREMIUM_QUALITY = 'high';

/** GPT Image 2.5 is a premium vendor model no Unlimited plan covers: like Seedance, it always pays in tokens. */
export const editBillingMode = (model, billing) => (model === EDIT_MODELS.premium ? 'tokens' : billing.mode);

/** The model for one edit in this world: `people` when the picture shows a person. */
export function editModel(plan, { people = false } = {}) {
  if (matureWorld(plan)) return EDIT_MODELS.mature;
  if (plan.edits === 'premium') return EDIT_MODELS.premium;
  return people ? EDIT_MODELS.people : EDIT_MODELS.things;
}

/** An edit model's own settings: its tier's defaults, and GPT Image's quality. */
async function editSettings(session, model) {
  if (model === EDIT_MODELS.premium) return { gptImageQuality: PREMIUM_QUALITY };
  const options = await session.client.projects.getModelOptions?.(model).catch(() => null);
  return {
    ...(options?.steps?.default !== undefined ? { steps: options.steps.default } : {}),
    ...(options?.guidance?.default !== undefined ? { guidance: options.guidance.default } : {}),
    ...(options?.sampler?.default ? { sampler: options.sampler.default } : {}),
    ...(options?.scheduler?.default ? { scheduler: options.scheduler.default } : {}),
  };
}

/** What `count` edits by `model` at this size cost, priced by Sogni (nothing is submitted). */
export async function editEstimate(session, { model, count, width, height }) {
  const options = await session.client.projects.getModelOptions(model);
  const estimate = await session.client.projects.estimateCost({ network: 'fast', tokenType: session.billing.tokenType, model, imageCount: count,
    stepCount: options?.steps?.default ?? 1, previewCount: 0, guidance: options?.guidance?.default ?? 1, width, height,
    ...(model === EDIT_MODELS.premium ? { gptImageQuality: PREMIUM_QUALITY } : {}), billingMode: editBillingMode(model, session.billing) });
  return { usd: Number(estimate.usd), token: Number(estimate.token) };
}

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

/**
 * `count` results of one edit instruction by `model` (from editModel) on one
 * or two context pictures, at the model's own settings. Returns PNG buffers.
 */
export async function edit(session, { model, prompt, context, width, height, seed, count = 1, contentFilter = false }) {
  // Every edit model takes two pictures (Krea 2 Identity Edit's limit); the kit never sends more.
  if (!context?.length || context.length > 2) throw new Error('an edit takes one or two context pictures');
  const settings = await editSettings(session, model);
  const refusals = watchRefusals(session.client);
  try {
    const project = await refusals.creating(() => session.client.projects.create({
      type: 'image', modelId: model, positivePrompt: prompt, negativePrompt: '', stylePrompt: '',
      ...settings,
      numberOfMedia: count, numberOfPreviews: 0, sizePreset: 'custom', width, height,
      ...(Number.isInteger(seed) ? { seed } : {}), contextImages: context, outputFormat: 'png',
      disableNSFWFilter: !contentFilter, network: 'fast', tokenType: session.billing.tokenType, billingMode: editBillingMode(model, session.billing),
    }));
    const urls = await Promise.race([
      project.waitForCompletion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('the edit took longer than 15 minutes')), 15 * 60_000)),
    ]);
    const refused = refusals.get(project.id);
    if (refused) throw new RefusedError(refused);
    const images = [];
    for (const url of urls.filter(Boolean)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`downloading an edited picture failed (HTTP ${response.status})`);
      images.push(Buffer.from(await response.arrayBuffer()));
    }
    if (!images.length) throw new Error('Sogni returned no pictures (the safe-content filter may have withheld them)');
    return { modelId: model, projectId: project.id, images };
  } finally {
    refusals.stop();
  }
}
