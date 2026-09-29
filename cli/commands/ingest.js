import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { parse } from '../index.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { readPlan, writePlan } from '../lib/plan.js';
import { canvasByName, canvasFor, CANVASES, delivered } from '../lib/h3.js';
import { exposureOf, PHOTO_EXTENSIONS, planStill, readablePhoto, slug, uprightSize, writePreview, writeStill } from '../lib/stills.js';
import { readJson, sha256, sha256File, writeJson } from '../lib/files.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';

export const summary = 'Turn photos/ into canonical stills (one shared canvas) and add each as a place in world.yaml';
export const usage = 'node world ingest [world] [--canvas 3:2|16:9|4:3|1:1|2:3|9:16|3:4] [--force <place> ...]';

export async function run(argv) {
  const { values, world } = parse(argv, { canvas: { type: 'string' }, force: { type: 'string', multiple: true } });
  const id = resolveWorldId(world);
  const { doc, plan, paths } = readPlan(id);
  const force = new Set(values.force ?? []);

  const photos = existsSync(paths.photos)
    ? readdirSync(paths.photos).filter(name => PHOTO_EXTENSIONS.includes(extname(name).toLowerCase()) && !name.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    : [];
  if (!photos.length && !plan.places.length) throw new Error(`No photos in ${shown(paths.photos)}/ yet (JPEG, PNG, HEIC, WebP or TIFF, full size)`);

  // Read every photo's upright size first: the world shares one canvas.
  const entries = [];
  for (const name of photos) {
    const path = join(paths.photos, name);
    const bytes = readablePhoto(path, paths.cache);
    const { width, height, metadata } = await uprightSize(bytes);
    entries.push({ name, path, bytes, width, height, metadata, placeId: slug(name) });
  }

  let canvas;
  if (values.canvas) canvas = canvasByName(values.canvas);
  else if (plan.canvas) canvas = canvasByName(String(plan.canvas));
  else {
    const votes = new Map();
    for (const entry of entries) {
      const choice = canvasFor(entry.width, entry.height);
      votes.set(choice.name, (votes.get(choice.name) ?? 0) + 1);
    }
    const [winner] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    canvas = CANVASES.find(c => c.name === winner);
  }
  const canvasText = `${canvas.width}x${canvas.height}`;
  if (plan.canvas && String(plan.canvas) !== canvasText && canvasByName(String(plan.canvas)) !== canvas) {
    throw new Error(`world.yaml already uses canvas ${plan.canvas}; every still shares one canvas. Remove stills/ and the canvas line to start over`);
  }
  const target = delivered(canvas);
  log.step(`Canvas ${canvas.name} (${canvasText}); stills are written at up to ${target.width}×${target.height}, the size the films arrive at`);

  mkdirSync(paths.stills, { recursive: true });
  mkdirSync(join(paths.cache, 'preview'), { recursive: true });
  const indexPath = join(paths.stills, 'index.json');
  const index = readJson(indexPath, {});
  const usedIds = new Set(plan.places.map(place => place.id));
  const placesNode = doc.get('places', true);
  let added = 0;
  let written = 0;
  const smaller = [];

  for (const entry of entries) {
    const photoRelative = relative(paths.dir, entry.path);
    const existing = plan.places.find(place => place.photo === photoRelative);
    let placeId = existing?.id ?? entry.placeId;
    if (!existing) {
      let candidate = placeId;
      for (let n = 2; usedIds.has(candidate); n += 1) candidate = `${placeId}-${n}`;
      placeId = candidate;
      usedIds.add(placeId);
    }
    const stillRelative = `stills/${placeId}.jpg`;
    const stillPath = join(paths.dir, stillRelative);
    const layout = planStill(entry.width, entry.height, canvas);

    if (existsSync(stillPath) && !force.has(placeId)) {
      // Immutable: an existing still is never rewritten.
    } else {
      if (existsSync(stillPath)) log.warn(`${placeId}: rewriting its still because you passed --force; every film to or from it must be rendered again`);
      if (layout.removed > 0.08) log.warn(`${entry.name}: the ${canvas.name} crop removes ${(layout.removed * 100).toFixed(0)}% of the photo — consider --canvas ${canvasFor(entry.width, entry.height).name}`);
      if (layout.small) log.warn(`${entry.name}: only ${layout.crop.width}×${layout.crop.height} after cropping — below the ${canvas.width}×${canvas.height} canvas; films will look soft. Use a larger original if you have one`);
      await writeStill(entry.bytes, layout, stillPath);
      await writePreview(stillPath, join(paths.cache, 'preview', `${placeId}.jpg`));
      index[placeId] = {
        photo: photoRelative,
        photoSha256: sha256(entry.bytes),
        still: stillRelative,
        stillSha256: sha256File(stillPath),
        width: layout.size.width,
        height: layout.size.height,
        canvas: canvasText,
        crop: layout.crop,
        cropRemoved: Number(layout.removed.toFixed(4)),
        exposure: exposureOf(entry.metadata),
        madeAt: new Date().toISOString(),
      };
      written += 1;
      log.ok(`${placeId.padEnd(24)} ${entry.name} → ${stillRelative} (${layout.size.width}×${layout.size.height})`);
      if (!layout.small && (layout.size.width < target.width || layout.size.height < target.height)) smaller.push(`${entry.name} is ${layout.size.width}×${layout.size.height}`);
    }

    if (!existing) {
      const node = doc.createNode({ id: placeId, photo: photoRelative, still: stillRelative, title: '', seen: '' });
      if (placesNode && typeof placesNode.add === 'function') {
        placesNode.flow = false; // `places: []` in a new plan becomes a block list
        placesNode.add(node);
      }
      else doc.set('places', doc.createNode([node.toJSON()]));
      added += 1;
    }
  }

  writeJson(indexPath, index);
  doc.set('canvas', canvasText);
  if (!plan.start) {
    const first = doc.get('places', true)?.items?.[0];
    const firstId = first?.get?.('id');
    if (firstId) doc.set('start', firstId);
  }
  writePlan(id, doc);

  log.ok(`${written} still${written === 1 ? '' : 's'} written, ${added} place${added === 1 ? '' : 's'} added to ${shown(paths.plan)}`);
  if (smaller.length) {
    log.info(`Smaller than the films (${target.width}×${target.height}): ${smaller.join('; ')}. That works — stills are never enlarged — but a larger original of the same photo looks sharper.`);
  }
  log.info(`Full-size stills: ${shown(paths.stills)}/   1024-px copies for vision models that cap image size: ${shown(join(paths.cache, 'preview'))}/`);
  log.next(nextStep(id));
  return 0;
}
