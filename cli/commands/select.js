import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parse } from '../index.js';
import { filmId, resolveWorldId, shown, worldFile } from '../lib/paths.js';
import { readPlan } from '../lib/plan.js';
import { readJson, sha256, writeJson } from '../lib/files.js';
import { maskOutline, readMask } from '../lib/outline.js';
import { connect, describeBilling, downloadResult, RefusedError, safeError, waitForProject, watchRefusals } from '../lib/sogni.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';

export const summary = 'Outline every clickable object with SAM 3 from its select clicks (and draw a preview to check it)';
export const usage = `node world select [world] [--only <place>-<object> ...] [--redo]

  Outlines every object that has select clicks and no outline yet. An object
  whose clicks (or still) changed since its outline was made is selected again
  automatically. --only <place>-<object> selects that object again even when
  nothing changed; --redo selects every object again.`;

export const SAM_MODEL = 'sam3_image_segment_bf16';
export const SAM_LONG_EDGE = 1536;

/** The SAM 3 prompt for an object's `select`: clicks (one object) or text (every match, e.g. a flock). */
export function samPrompt(select) {
  const points = [
    ...(select.positive ?? []).map(([x, y]) => ({ x, y, label: 'positive' })),
    ...(select.negative ?? []).map(([x, y]) => ({ x, y, label: 'negative' })),
  ];
  const boxes = select.box ? [{ x0: select.box[0], y0: select.box[1], x1: select.box[2], y1: select.box[3] }] : undefined;
  if (select.text) return { text: select.text, ...(boxes ? { boxes } : {}), threshold: select.threshold ?? 0.5, maxInstances: select.instances ?? 16 };
  return { points, ...(boxes ? { boxes } : {}), threshold: select.threshold ?? 0.5, multimask: true, maxInstances: 1 };
}

/** What an outline was made from: the clicks and the still. A change means it must be made again. */
export function selectionInputsHash(select, stillSha256) {
  return sha256(JSON.stringify({ prompt: samPrompt(select), cleanup: select.cleanup ?? null, still: stillSha256 }));
}

/**
 * Should this object be selected (again)? `previous` is its selections/<key>.json;
 * `current` is { inputsHash, prompt, stillSha256 } for the clicks and still now.
 * Returns 'resume' | 'select' | 'skip' | 'unknown' (a submit whose outcome is unknown).
 */
export function selectionAction(previous, current, { named = false, redo = false } = {}) {
  if (previous?.status === 'submitted' && previous.projectId) return 'resume';
  if (previous?.status === 'submitting' && !previous.projectId && !redo && !named) return 'unknown';
  if (!previous || redo || named) return 'select';
  const changed = previous.inputsHash
    ? previous.inputsHash !== current.inputsHash
    // Outlines made before hashes were recorded: compare the prompt and still they were made from.
    : JSON.stringify(previous.prompt) !== JSON.stringify(current.prompt) || previous.stillSha256 !== current.stillSha256;
  if (changed) return 'select';
  return previous.status === 'completed' || previous.status === 'failed' ? 'skip' : 'select';
}

/** The still, resampled once (Lanczos) so its long edge is 1536 px — SAM reads at most 2048. */
async function samSource(paths, place) {
  const still = readFileSync(join(paths.dir, place.still));
  const hash = sha256(still);
  const out = join(paths.cache, 'sam', `${place.id}-${hash.slice(0, 12)}-${SAM_LONG_EDGE}.png`);
  if (!existsSync(out)) {
    mkdirSync(join(paths.cache, 'sam'), { recursive: true });
    await sharp(still).resize(SAM_LONG_EDGE, SAM_LONG_EDGE, { fit: 'inside', kernel: 'lanczos3' }).png().toFile(out);
  }
  const bytes = readFileSync(out);
  const { width, height } = await sharp(bytes).metadata();
  return { bytes, width, height, stillSha256: hash, path: out };
}

/** The picture with the outline and clicks drawn on it, small enough to look at quickly. */
export async function drawPreview(source, outline, select, output) {
  const { width, height } = source;
  const dot = ([x, y], fill) => `<circle cx="${(x * width).toFixed(1)}" cy="${(y * height).toFixed(1)}" r="9" fill="${fill}" stroke="#fff" stroke-width="3"/>`;
  const box = select.box ? `<rect x="${select.box[0] * width}" y="${select.box[1] * height}" width="${(select.box[2] - select.box[0]) * width}" height="${(select.box[3] - select.box[1]) * height}" fill="none" stroke="#ffe600" stroke-width="2" stroke-dasharray="10 8"/>` : '';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${outline.width} ${outline.height}" preserveAspectRatio="none">
    <path d="${outline.path}" fill="#ff2bd6" fill-opacity="0.28" fill-rule="evenodd" stroke="#ff2bd6" stroke-width="3" stroke-linejoin="round"/>
    </svg>`;
  const marks = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${box}${(select.positive ?? []).map(p => dot(p, '#18c93a')).join('')}${(select.negative ?? []).map(p => dot(p, '#ff2a2a')).join('')}</svg>`;
  const composed = sharp(source.bytes).composite([{ input: Buffer.from(svg) }, { input: Buffer.from(marks) }]);
  let jpeg = await composed.clone().jpeg({ quality: 85 }).toBuffer();
  if (jpeg.length > 300_000) jpeg = await sharp(jpeg).jpeg({ quality: 72 }).toBuffer();
  if (jpeg.length > 300_000) jpeg = await sharp(jpeg).resize(1280, 1280, { fit: 'inside' }).jpeg({ quality: 72 }).toBuffer();
  writeFileSync(output, jpeg);
}

export async function run(argv) {
  const { values, world } = parse(argv, { only: { type: 'string', multiple: true }, redo: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const only = new Set(values.only ?? []);

  const known = plan.places.flatMap(place => place.objects.filter(o => o.select).map(o => filmId(place.id, o.id)));
  const unknownNames = [...only].filter(key => !known.includes(key));
  if (unknownNames.length) throw new Error(`No object with select clicks named ${unknownNames.join(', ')}. Use <place>-<object>: ${known.join(', ')}`);

  const todo = [];
  for (const place of plan.places) {
    for (const object of place.objects) {
      const key = filmId(place.id, object.id);
      if (!object.select || (only.size && !only.has(key))) continue;
      const file = join(paths.selections, `${key}.json`);
      const previous = existsSync(file) ? readJson(file) : null;
      const stillPath = worldFile(paths, place.still, `places.${place.id}.still`);
      const stillSha256 = existsSync(stillPath) ? sha256(readFileSync(stillPath)) : null;
      const inputsHash = stillSha256 ? selectionInputsHash(object.select, stillSha256) : null;
      const action = selectionAction(previous, { inputsHash, prompt: samPrompt(object.select), stillSha256 }, { named: only.has(key), redo: values.redo });
      if (action === 'unknown') {
        throw new Error(`${key}: the last run stopped while submitting, so whether Sogni received it is unknown. Check your recent jobs at https://app.sogni.ai, then select it again: node world select ${id} --only ${key}`);
      }
      if (action === 'skip') continue;
      if (action === 'resume') { todo.push({ place, object, key, file, inputsHash, resume: previous }); continue; }
      if (previous && ['completed', 'failed'].includes(previous.status) && !only.has(key) && !values.redo) log.step(`${key}: its clicks or still changed since the outline was made — selecting it again`);
      todo.push({ place, object, key, file, inputsHash });
    }
  }
  if (!todo.length) {
    log.ok('Every object with select clicks already has an outline');
    log.next(nextStep(id));
    return 0;
  }

  mkdirSync(paths.selections, { recursive: true });
  const session = await connect();
  const refusals = watchRefusals(session.client);
  let done = 0;
  const failed = [];
  try {
    log.step(`Signed in as ${session.username}. Billing: ${describeBilling(session.billing)}`);
    for (const { place, object, key, file, inputsHash, resume } of todo) {
      const source = await samSource(paths, place);
      const prompt = samPrompt(object.select);
      let journal = resume ?? {
        key, place: place.id, object: object.id, model: SAM_MODEL, prompt, inputsHash, stillSha256: source.stillSha256,
        width: source.width, height: source.height, status: 'submitting', startedAt: new Date().toISOString(),
      };
      try {
        let mask;
        if (resume) {
          // A run stopped while SAM was working: collect the same project, never submit it again.
          const result = await waitForProject(session.client, { projectId: journal.projectId, ownerPid: journal.pid }, { refusals, timeoutMs: 10 * 60_000 });
          ({ bytes: mask } = await downloadResult(session.client, result, { contentType: 'image/png' }));
        } else {
          writeJson(file, journal);
          const project = await refusals.creating(() => session.client.projects.create({
            type: 'image', modelId: SAM_MODEL, positivePrompt: 'Select the indicated object.', negativePrompt: '', stylePrompt: '',
            steps: 1, guidance: 1, numberOfMedia: 1, width: source.width, height: source.height, startingImage: source.bytes,
            sam3Prompt: prompt, network: 'fast', tokenType: session.billing.tokenType, billingMode: session.billing.mode,
          }));
          journal = { ...journal, projectId: project.id, status: 'submitted', appId: session.appId, pid: process.pid };
          writeJson(file, journal);
          const urls = await Promise.race([
            project.waitForCompletion(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('SAM 3 took longer than 10 minutes')), 10 * 60_000)),
          ]);
          const refused = refusals.get(journal.projectId);
          if (refused) throw new RefusedError(refused);
          const response = await fetch(urls[0], { signal: AbortSignal.timeout(90_000) });
          if (!response.ok) throw new Error(`mask download returned HTTP ${response.status}`);
          mask = Buffer.from(await response.arrayBuffer());
        }
        if (mask.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('the mask is not a PNG');
        const decoded = await readMask(mask);
        if (decoded.width !== source.width || decoded.height !== source.height) throw new Error(`mask is ${decoded.width}×${decoded.height}, expected ${source.width}×${source.height}`);
        const outline = maskOutline(decoded, object.select.cleanup ?? {});
        writeFileSync(join(paths.selections, `${key}.png`), mask);
        const preview = join(paths.selections, `${key}.preview.jpg`);
        await drawPreview(source, outline, object.select, preview);
        journal = {
          ...journal, status: 'completed', completedAt: new Date().toISOString(), maskSha256: sha256(mask),
          coverage: Number(outline.coverage.toFixed(6)), rawCoverage: Number(outline.rawCoverage.toFixed(6)), cleanup: outline.cleanup,
          outline: { width: outline.width, height: outline.height, path: outline.path },
          preview: `${key}.preview.jpg`,
        };
        writeJson(file, journal);
        done += 1;
        log.ok(`${key.padEnd(30)} ${(outline.coverage * 100).toFixed(2)}% of the picture, ${outline.cleanup.keptVertices} points → ${shown(preview)}`);
        if (outline.coverage > 0.6) log.warn(`${key}: the outline covers ${(outline.coverage * 100).toFixed(0)}% of the picture — SAM probably took the background. Move or add negative clicks`);
        if (outline.coverage < 0.002) log.warn(`${key}: the outline covers under 0.2% of the picture. A small object is fine to click (its label stays clickable, and the player adds a finger-sized margin round small outlines), but check the preview shows the whole object, not a speck of it`);
      } catch (error) {
        const message = error instanceof RefusedError ? error.message : safeError(error).message;
        journal = { ...journal, status: 'failed', failedAt: new Date().toISOString(), failure: error instanceof RefusedError ? error.failure : { message } };
        writeJson(file, journal);
        failed.push(key);
        log.fail(`${key}: ${message}`);
        if (/threshold|found nothing/i.test(message)) log.dim('SAM found nothing confident enough. Fewer, clearer clicks work better: one positive point in the middle of the object, a negative on what it grabs');
      }
    }
  } finally {
    refusals.stop();
    session.close();
  }
  log.info(`${done} outlined, ${failed.length} failed`);
  log.next(failed.length
    ? `open each ${shown(paths.selections)}/<place>-<object>.preview.jpg, fix the clicks for ${failed.join(', ')} in world.yaml, then: node world select ${id}   (changed clicks are selected again)`
    : `open each ${shown(paths.selections)}/<place>-<object>.preview.jpg and check the outline hugs the right thing. If not, move or add clicks in world.yaml and run node world select ${id} again (changed clicks are selected again). Then: ${nextStep(id)}`);
  return failed.length ? 1 : 0;
}
