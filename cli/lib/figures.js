// Figures: a collectible object stood up in 3D, so the visitor who finds it
// can pick it up and turn it over. A thing in a picture is small, lies on a
// table and shows one side, and a mesh built from that cut-out is a blob with
// the table fused under it. So the object is first made again, alone: Qwen
// Image Edit draws it whole and detailed on a plain white plate from its
// picture (and from its close look, when it has one), the recipe the live
// worlds' figures were rebuilt with. Pixal3D builds the mesh from that plate;
// BiRefNet cuts it out for the collection's icon. Its outline only says where
// the object is: it is never used to cut anything out.
//
//   figures/<place>-<object>.context.png  the crop around the object in its place's picture
//   figures/<place>-<object>.plate.png    the object alone on white: what Pixal3D sees
//   figures/<place>-<object>.matte.png    BiRefNet's matte of the plate
//   figures/<place>-<object>.png          the plate cut out on transparency: the icon
//   figures/<place>-<object>.glb          the mesh
//   figures/<place>-<object>.json         receipt: inputs, jobs, mesh stats (written before anything is paid for)
import { join } from 'node:path';
import sharp from 'sharp';
import { RefusedError, watchRefusals } from './sogni.js';
import { edit, EDIT_MODEL } from './paint.js';

export const FIGURE_MODELS = Object.freeze({
  plate: EDIT_MODEL,
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
/** The scene around the object in the crop the plate is drawn from (a quarter of its size on each side). */
const CONTEXT = 0.25;
/** The plate's size: square, the long side Pixal3D reads best. */
export const PLATE = 1024;
/** A cut-out larger than this is scaled down: the icon is small. */
const MAX_SIDE = 1024;

export const figureFiles = (paths, key) => {
  const dir = join(paths.dir, 'figures');
  return { dir, context: join(dir, `${key}.context.png`), plate: join(dir, `${key}.plate.png`), matte: join(dir, `${key}.matte.png`),
    cutout: join(dir, `${key}.png`), glb: join(dir, `${key}.glb`), receipt: join(dir, `${key}.json`) };
};

/**
 * What Qwen Image Edit is told: the same object, alone, whole and detailed on
 * white, from its picture (the first reference is the close look when there is
 * one). `look` is the plan's words for it. A figure carries no writing: Pixal3D
 * paints its texture from the plate, and small lettering (a tag that read
 * "T. HALE" on the plate) comes out of the mesh as scribble, so any tag or
 * label is described plain. The plate itself is described as empty.
 */
export function platePrompt(look, { closeLook = false } = {}) {
  return [
    `Product photo of the exact same ${String(look).replace(/\s+/g, ' ').trim()} ${closeLook ? 'as in the first reference picture (the second shows it in its place)' : 'from the reference picture'}, shown alone and whole:`,
    'a front three-quarter view at eye level, centred and filling most of the frame, in its full three-dimensional shape with every side finely detailed,',
    'on a seamless plain white background under soft even studio light.',
    'Keep exactly the same shape, proportions, colours, materials and details as the reference; any tag, label or sign on it is plain and blank.',
    'The entire object is inside the picture with empty white margin on every side, nothing cut off by the frame edge, and nothing else in the picture.',
  ].join(' ');
}

/**
 * The crop of the object's place picture the plate is drawn from: its
 * outline's box with a quarter of its size around it on each side, enlarged
 * so its long side is PLATE (an enlarged crop of the real picture, never a mask).
 */
export async function plateContext({ source, mask }) {
  const { width, height } = await sharp(source).metadata();
  const box = await maskBox(mask, width, height);
  if (!box) throw new Error('the outline selects nothing');
  const mx = Math.round(box.width * CONTEXT), my = Math.round(box.height * CONTEXT);
  const left = Math.max(0, box.x - mx), top = Math.max(0, box.y - my);
  const crop = { left, top, width: Math.min(width - left, box.width + 2 * mx), height: Math.min(height - top, box.height + 2 * my) };
  const png = await sharp(source).rotate().extract(crop).resize(PLATE, PLATE, { fit: 'inside', kernel: 'lanczos3' }).png().toBuffer();
  return { png, crop };
}

/** The object alone on white, drawn by Qwen Image Edit from its context pictures. */
export async function plateJob(session, { contexts, prompt, seed, contentFilter = false }) {
  const { projectId, images } = await edit(session, { prompt, context: contexts, width: PLATE, height: PLATE, seed, count: 1, contentFilter });
  return { projectId, png: images[0] };
}

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

/** The box an object's outline covers in a picture of `width` × `height`, or null when it selects nothing. */
export async function maskBox(mask, width, height) {
  const sized = await grey(mask, width, height);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (sized[y * width + x] < 128) continue;
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/**
 * The plate on transparency: BiRefNet's matte (the plate holds the object
 * alone, so the whole matte is it), trimmed to the object plus a margin and
 * capped in size.
 */
export async function cutoutOf(platePng, mattePng) {
  const { data: rgb, width, height } = await colour(platePng);
  const matte = await grey(mattePng, width, height);
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, on = 0;
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const alpha = matte[i];
    rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alpha;
    if (alpha < 128) continue;
    on++;
    const x = i % width, y = Math.floor(i / width);
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  if (on < 64) throw new Error('BiRefNet found no object on the plate');
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

/** BiRefNet's matte of a picture: greyscale, white is the object. */
export async function matteJob(session, regionPng) {
  const { width, height } = await sharp(regionPng).metadata();
  const { projectId, bytes } = await oneResult(session, {
    modelId: FIGURE_MODELS.matte, positivePrompt: 'Remove the background.', steps: 1, guidance: 1,
    sizePreset: 'custom', width, height, startingImage: regionPng, outputFormat: 'png',
  }, { minutes: 20, what: 'matte' });
  if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('the matte is not a PNG');
  return { projectId, png: bytes };
}

/** Pixal3D's mesh of the plate (it finds the object on white itself). */
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

/** What one figure costs: the plate, the BiRefNet cut-out and the Pixal3D mesh, priced by Sogni. */
export async function figureEstimate(session) {
  let usd = 0, token = 0;
  for (const [model, size] of [[FIGURE_MODELS.plate, PLATE], [FIGURE_MODELS.matte, PLATE], [FIGURE_MODELS.mesh, PLATE]]) {
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
