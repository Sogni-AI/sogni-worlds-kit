// Figures: a collectible object stood up in 3D, so the visitor who finds it
// can pick it up and turn it over. The object is cut out of its own picture
// (its SAM 3 outline, refined by BiRefNet) and reconstructed by Pixal3D, so
// what turns in the viewer is the thing that stood in the picture, not a
// stand-in for it.
//
//   figures/<place>-<object>.region.png   the crop around the object (outside its outline whited out)
//   figures/<place>-<object>.matte.png    BiRefNet's matte of the region
//   figures/<place>-<object>.png          the cut-out on transparency: what Pixal3D sees, and the icon
//   figures/<place>-<object>.glb          the mesh
//   figures/<place>-<object>.json         receipt: inputs, jobs, mesh stats (written before anything is paid for)
import { join } from 'node:path';
import sharp from 'sharp';
import { RefusedError, watchRefusals } from './sogni.js';

export const FIGURE_MODELS = Object.freeze({
  matte: 'birefnet_image_background_removal_fp16',
  mesh: 'pixal3d_int8_i23d',
});

/**
 * The mesh a browser can carry: about 60,000 triangles and a 2K texture make
 * an 8–12 MB GLB that still holds a face. Pixal3D's defaults (700,000
 * triangles, 4K textures) are for offline engines. Each value may only lower
 * Pixal3D's work.
 */
export const FIGURE_QUALITY = Object.freeze({ meshTargetFaces: 60_000, textureSize: 2048, normalMapSize: 1024, ambientOcclusionSize: 512 });

/** A little air around the object, so nothing is clipped at the frame edge. */
const MARGIN = 0.04;
/** Context around the object in the crop BiRefNet sees. */
const CONTEXT = 0.1;
/** BiRefNet's limits: no more lopsided than this, and at least 384 px on the short side (met by enlarging, see MIN_REGION). */
const MAX_RATIO = 1.9;
/** A cut-out larger than this is scaled down: the mesh weight is set by the budget above, not by the pixels. */
const MAX_SIDE = 1024;
/** A region smaller than this on its long side is enlarged before it is matted (768 / 1.9 clears BiRefNet's 384). */
const MIN_REGION = 768;

export const figureFiles = (paths, key) => {
  const dir = join(paths.dir, 'figures');
  return { dir, region: join(dir, `${key}.region.png`), matte: join(dir, `${key}.matte.png`), cutout: join(dir, `${key}.png`), glb: join(dir, `${key}.glb`), receipt: join(dir, `${key}.json`) };
};

/**
 * What Pixal3D is told the object is. It hands the words to its own SAM 3,
 * which answers to a plain head noun ("telescope"), not to a phrase ("a brass
 * telescope on a wooden tripod"): the noun before the first preposition or verb.
 */
export function headNoun(text) {
  const words = String(text ?? '').toLowerCase().replace(/[^a-z\s-]/g, ' ').split(/\s+/).filter(Boolean);
  const stop = /^(on|in|at|by|with|from|of|near|beside|behind|under|over|against|above|below|inside|outside|that|which|who|where|holding|leaning|floating|standing|sitting|hanging|lying|resting|set|and)$/;
  const head = [];
  for (const word of words) {
    if (stop.test(word) && head.length) break;
    if (!/^(the|a|an|his|her|their|its|this|that)$/.test(word)) head.push(word);
  }
  return head.at(-1) ?? 'object';
}

/** One channel (a mask or matte) at a given size: sharp keeps three channels for a grey RGB file unless told. */
async function grey(input, width, height) {
  const { data, info } = await sharp(input, { failOn: 'none' }).resize(width, height, { fit: 'fill' }).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 1 || data.length !== width * height) throw new Error('could not read the mask as one channel');
  return data;
}

/** Three channels of colour, whatever the file holds. */
async function colour(input) {
  const { data, info } = await sharp(input, { failOn: 'none' }).rotate().removeAlpha().toColourspace('srgb').raw().toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) throw new Error(`expected a colour picture (got ${info.channels} channels)`);
  return { data, width: info.width, height: info.height };
}

const grow = (start, span, limit, wanted) => {
  if (span >= wanted) return [start, span];
  const width = Math.min(wanted, limit);
  return [Math.max(0, Math.min(limit - width, start - Math.round((width - span) / 2))), width];
};

/**
 * The region BiRefNet looks at: the object's box with a margin, grown to
 * BiRefNet's limits, exactly as it stands in the picture (whiting out the
 * surroundings makes BiRefNet take the whole cut shape, sky and all, for the
 * subject). Also returns the outline over the same region, widened a little:
 * BiRefNet draws the real edge, the outline says which thing is meant.
 */
export async function regionOf({ source, mask }) {
  const { data: rgb, width, height } = await colour(source);
  const sized = await grey(mask, width, height);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (sized[y * width + x] < 128) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (maxX < 0) throw new Error('the outline selects nothing');
  // Tight around the object, with some context: BiRefNet takes the most striking thing in its
  // crop, so a small flower in a wide crop loses to a glowing mushroom beside it.
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * CONTEXT) + 2;
  let [x0, y0] = [Math.max(0, minX - pad), Math.max(0, minY - pad)];
  let [w, h] = [Math.min(width - 1, maxX + pad) - x0 + 1, Math.min(height - 1, maxY + pad) - y0 + 1];
  const shortest = Math.ceil(Math.max(w, h) / MAX_RATIO);
  [x0, w] = grow(x0, w, width, w <= h ? shortest : 0);
  [y0, h] = grow(y0, h, height, h < w ? shortest : 0);
  const reach = Math.max(4, Math.round(Math.max(maxX - minX, maxY - minY) * 0.025));
  const widened = await grey(await sharp(sized, { raw: { width, height, channels: 1 } }).blur(reach).png().toBuffer(), width, height);
  const extract = { left: x0, top: y0, width: w, height: h };
  // A small object is enlarged (Lanczos) so BiRefNet and Pixal3D get a usable picture of it.
  const scale = Math.max(1, MIN_REGION / Math.max(w, h));
  const size = [Math.round(w * scale), Math.round(h * scale)];
  const png = await sharp(rgb, { raw: { width, height, channels: 3 } }).extract(extract).resize(...size, { kernel: 'lanczos3' }).png().toBuffer();
  const outline = await sharp(widened, { raw: { width, height, channels: 1 } }).extract(extract).resize(...size).png().toBuffer();
  return { png, outline, crop: { x: x0, y: y0, width: w, height: h }, scale: Math.round(scale * 100) / 100, source: { width, height } };
}

/**
 * The region on transparency: BiRefNet's matte, kept only where the widened
 * outline reaches (so a neighbour BiRefNet also liked is dropped), trimmed to
 * the object plus a margin and capped in size.
 */
export async function cutoutOf(regionPng, mattePng, outlinePng) {
  const { data: rgb, width, height } = await colour(regionPng);
  const matte = await grey(mattePng, width, height);
  const outline = await grey(outlinePng, width, height);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, on = 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const alpha = Math.round(matte[i] * Math.min(1, outline[i] / 96));
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha;
    if (alpha < 128) continue;
    on++;
    const x = i % width, y = Math.floor(i / width);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (on < 64) throw new Error('BiRefNet found no object inside the outline');
  const pad = Math.round(Math.max(maxX - minX, maxY - minY) * MARGIN);
  const left = Math.max(0, minX - pad), top = Math.max(0, minY - pad);
  const w = Math.min(width - 1, maxX + pad) - left + 1, h = Math.min(height - 1, maxY + pad) - top + 1;
  let image = sharp(rgba, { raw: { width, height, channels: 4 } }).extract({ left, top, width: w, height: h });
  if (Math.max(w, h) > MAX_SIDE) image = sharp(await image.png().toBuffer()).resize(MAX_SIDE, MAX_SIDE, { fit: 'inside', kernel: 'lanczos3' });
  return { png: await image.png().toBuffer(), coverage: on / (width * height) };
}

/** Submit one image job and download its single result. */
async function oneResult(session, params, { minutes, what }) {
  const refusals = watchRefusals(session.client);
  try {
    const project = await refusals.creating(() => session.client.projects.create({
      type: 'image', numberOfMedia: 1, numberOfPreviews: 0, negativePrompt: '', stylePrompt: '',
      network: 'fast', tokenType: session.billing.tokenType, billingMode: session.billing.mode, ...params,
    }));
    const urls = await Promise.race([
      project.waitForCompletion(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} took longer than ${minutes} minutes`)), minutes * 60_000)),
    ]);
    const refused = refusals.get(project.id);
    if (refused) throw new RefusedError(refused);
    const url = urls?.find(Boolean);
    if (!url) throw new Error(`Sogni returned no ${what}`);
    // A result written a moment ago can 404 for a few seconds.
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
      if (response.ok) return { projectId: project.id, bytes: Buffer.from(await response.arrayBuffer()) };
      if (attempt >= 5) throw new Error(`downloading the ${what} failed (HTTP ${response.status})`);
      await new Promise(wait => setTimeout(wait, 4000 * (attempt + 1)));
    }
  } finally {
    refusals.stop();
  }
}

/** BiRefNet's matte of a region: greyscale, white is the object. */
export async function matteJob(session, regionPng) {
  const { width, height } = await sharp(regionPng).metadata();
  const { projectId, bytes } = await oneResult(session, {
    modelId: FIGURE_MODELS.matte, positivePrompt: 'Remove the background.', steps: 1, guidance: 1,
    sizePreset: 'custom', width, height, startingImage: regionPng, outputFormat: 'png',
  }, { minutes: 20, what: 'matte' });
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('the matte is not a PNG');
  return { projectId, png: bytes };
}

/** Pixal3D's mesh of a cut-out. */
export async function meshJob(session, cutoutPng, noun, quality = FIGURE_QUALITY) {
  const options = await session.client.projects.getModelOptions?.(FIGURE_MODELS.mesh).catch(() => null);
  const { projectId, bytes } = await oneResult(session, {
    modelId: FIGURE_MODELS.mesh, positivePrompt: noun,
    steps: options?.steps?.default ?? 1, guidance: options?.guidance?.default ?? 0,
    startingImage: cutoutPng, ...quality,
  }, { minutes: 45, what: '3D model' });
  const glb = inspectGlb(bytes);
  if (!glb.triangles) throw new Error('the 3D model has no geometry');
  if (glb.triangles > quality.meshTargetFaces * 1.2) throw new Error(`the 3D model has ${glb.triangles} triangles, over its budget of ${quality.meshTargetFaces}`);
  return { projectId, bytes, glb };
}

/** What one figure costs: the BiRefNet cut-out and the Pixal3D mesh, priced by Sogni. */
export async function figureEstimate(session) {
  let usd = 0, token = 0;
  for (const [model, size] of [[FIGURE_MODELS.matte, 768], [FIGURE_MODELS.mesh, 1024]]) {
    const options = await session.client.projects.getModelOptions(model).catch(() => null);
    const estimate = await session.client.projects.estimateCost({ network: 'fast', tokenType: session.billing.tokenType, model, imageCount: 1,
      stepCount: options?.steps?.default ?? 1, previewCount: 0, guidance: options?.guidance?.default ?? 1, width: size, height: size, billingMode: session.billing.mode });
    usd += Number(estimate.usd);
    token += Number(estimate.token);
  }
  return { usd, token };
}

/** Read a GLB's header and glTF JSON without a 3D library: a mesh is checked, never trusted. */
export function inspectGlb(bytes) {
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF') throw new Error('the 3D model is not a GLB');
  if (bytes.readUInt32LE(4) !== 2 || bytes.readUInt32LE(8) !== bytes.length) throw new Error('the GLB header does not match the file');
  let offset = 12, json = null;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(offset), type = bytes.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) json = JSON.parse(bytes.subarray(offset + 8, offset + 8 + length).toString('utf8').replace(/[\s\0]+$/, ''));
    offset += 8 + length + ((4 - (length % 4)) % 4);
  }
  if (!json) throw new Error('the GLB has no glTF JSON');
  const accessors = json.accessors ?? [];
  const primitives = (json.meshes ?? []).flatMap(mesh => mesh.primitives ?? []);
  const triangles = primitives.reduce((sum, p) => sum + Math.floor(((p.indices !== undefined ? accessors[p.indices] : accessors[p.attributes?.POSITION])?.count ?? 0) / 3), 0);
  return { triangles, materials: (json.materials ?? []).length, textures: (json.textures ?? []).length, bytes: bytes.length };
}
