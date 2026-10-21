// reveals: paint the close look each examined object's film lands on.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan, writePlan } from '../lib/plan.js';
import { resolveWorldId, shown, filmId, worldFile } from '../lib/paths.js';
import { readJson, writeJson, sha256 } from '../lib/files.js';
import { connect } from '../lib/sogni.js';
import { edit, PAINT_SIZES } from '../lib/paint.js';
import { maskBox } from '../lib/figures.js';
import { correlation } from '../lib/screen.js';
import { canvasOf, contentFilterOff } from './render.js';
import { nextStep } from './status.js';

export const summary = 'Paint the close look an object\'s film lands on: the place\'s own picture, zoomed in, with only the object changed (Qwen Image Edit)';
export const usage = `node world reveals [world] [--only <place-object> ...] [--count <n>] [--force]
node world reveals [world] --pick <place-object> <n>

  An object with a reveal holds on a close look: its film carries the visitor
  from the place's still into that picture (the glove turned over in a hand,
  the letter unfolded under the lamp, her face as she answers), the narrator
  says its line there or the figure is turned over, and the film runs back to
  put it down. The close look is the place's own still, cropped around the
  object and zoomed (reveal.zoom, 1 to 3; by default the object fills about
  two fifths of the width), then edited by Qwen Image Edit 2511 to show only
  what reveal.paint describes. The room around it keeps its geometry, so the
  film into it is a straight push-in: a repainted room makes the film morph
  the furniture on the way.

  Paints --count candidates (default 3) into reveals/candidates/, beside the
  zoomed crop they were made from (<place>-<object>.zoom.png). Look at each at
  full size: the room exactly as in the crop (no lamp, chair or wall added,
  moved or removed), the object and every person as in the place, and any
  writing exactly the words reveal.paint names. Then pick one:
  --pick copies it to reveals/<place>-<object>.jpg (from then on as fixed as a
  still) and writes reveal.still into world.yaml. Write reveal.seen from
  looking at it. --force paints new candidates for a reveal that has a still.`;

export async function run(argv) {
  const { values, world, positionals } = parse(argv, {
    only: { type: 'string', multiple: true }, count: { type: 'string', default: '3' }, force: { type: 'boolean', default: false },
    pick: { type: 'string' },
  });
  // --pick <place-object> <n>: the number is the last word; the world, when named, the first.
  if (values.pick && !/^\d+$/.test(positionals.at(-1) ?? '')) throw new Error(`Say which candidate: node world reveals --pick ${values.pick} <n> (the n in reveals/candidates/${values.pick}-<n>.png)`);
  const id = resolveWorldId(values.pick && positionals.length < 2 ? undefined : world);
  const { doc, plan, paths } = readPlan(id);
  if (values.pick) return pickCandidate({ id, doc, plan, paths, key: values.pick, n: Number(positionals.at(-1) ?? NaN) });

  const only = values.only?.length ? new Set(values.only) : null;
  const count = Math.min(4, Math.max(1, Number(values.count) || 3));
  const todo = [];
  for (const place of plan.places) for (const object of place.objects ?? []) {
    const key = filmId(place.id, object.id);
    const reveal = !object.goes ? object.reveal : null;
    if (!reveal?.paint || (only && !only.has(key))) continue;
    // Painted already (picked, or candidates waiting to be picked): paint again only when asked.
    if (!values.force && (reveal.still || existsSync(join(paths.reveals, 'candidates', `${key}.json`)))) continue;
    todo.push({ place, object, key, reveal });
  }
  if (only) for (const key of only) if (!todo.some(t => t.key === key)) log.warn(`${key}: no reveal with \`paint\`, or it is painted already (pick a candidate, or --force paints new ones)`);
  if (!todo.length) { log.ok('Every close look is painted.'); log.next(nextStep(id)); return 0; }

  const canvas = canvasOf(plan);
  const [width, height] = PAINT_SIZES[`${canvas.width}x${canvas.height}`] ?? [canvas.width, canvas.height];
  const dir = join(paths.reveals, 'candidates');
  mkdirSync(dir, { recursive: true });
  // Painting again keeps the earlier candidates, moved aside, so nothing looked at is lost.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const { key } of todo) {
    const mine = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+\\.png|\\.json|\\.zoom\\.png)$`);
    const earlier = readdirSync(dir).filter(name => mine.test(name));
    if (!earlier.length) continue;
    mkdirSync(join(dir, 'earlier', stamp), { recursive: true });
    for (const name of earlier) renameSync(join(dir, name), join(dir, 'earlier', stamp, name));
  }
  const session = await connect({ appId: `sogni-worlds-reveals-${id}` });
  const failed = [];
  try {
    log.title(`Painting ${todo.length} close look${todo.length === 1 ? '' : 's'}, ${count} candidate${count === 1 ? '' : 's'} each`);
    for (const { place, object, key, reveal } of todo) {
      try {
        const stillPath = worldFile(paths, place.still, `places.${place.id}.still`);
        const frame = await closeFrame({ paths, key, object, stillPath, zoom: reveal.zoom });
        // The zoomed crop is the context: the edit keeps its room and changes only what paint says.
        const zoomed = await sharp(stillPath).extract(frame.crop).resize(width, height, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer();
        writeFileSync(join(dir, `${key}.zoom.png`), zoomed);
        const prompt = closeLookPrompt(reveal.paint);
        log.step(`${key}: ${frame.zoom}× on the object · ${String(reveal.paint).slice(0, 80)}${String(reveal.paint).length > 80 ? '…' : ''}`);
        const { images, modelId, projectId } = await edit(session, { prompt, context: [zoomed], width, height, count, contentFilter: !contentFilterOff(plan) });
        const files = [], kept = [];
        for (const [index, bytes] of images.entries()) {
          const file = join(dir, `${key}-${index + 1}.png`);
          writeFileSync(file, bytes);
          files.push(file);
          kept.push(await roomKept(zoomed, bytes, frame.object));
        }
        writeJson(join(dir, `${key}.json`), { key, modelId, projectId, prompt, width, height, ...frame, roomKept: kept, sha256: images.map(sha256), paintedAt: new Date().toISOString() });
        log.ok(`${key}: ${files.map((file, i) => `${shown(file)} (room kept ${kept[i]})`).join(', ')}`);
        if (kept.some(k => k < ROOM_KEPT)) log.warn(`${key}: a candidate under ${ROOM_KEPT} changed the room around the object (furniture added, moved or gone); the film into it would morph it`);
      } catch (error) {
        failed.push(`${key}: ${error.message}`);
        log.fail(`${key}: ${error.message}`);
      }
    }
  } finally {
    session.close();
  }
  log.info('Look at every candidate at full size beside its .zoom.png: the room unchanged (nothing added, moved or removed), the object and every person as in the place, any writing exactly the words reveal.paint names.');
  log.info(`Then pick one: node world reveals ${id} --pick <place-object> <n>   (or change reveal.paint and paint again with --force)`);
  return failed.length ? 1 : 0;
}

/** Make candidate n the reveal's still: a JPEG at the canvas size, recorded in world.yaml. */
async function pickCandidate({ id, doc, plan, paths, key, n }) {
  const found = plan.places.flatMap((place, pi) => (place.objects ?? []).map((object, oi) => ({ place, object, pi, oi }))).find(({ place, object }) => filmId(place.id, object.id) === key);
  if (!found?.object.reveal) throw new Error(`"${key}" is not an object with a reveal`);
  const source = join(paths.reveals, 'candidates', `${key}-${n}.png`);
  if (!Number.isInteger(n) || !existsSync(source)) throw new Error(`No candidate ${Number.isNaN(n) ? '' : n} for ${key}: name one of the files in ${shown(join(paths.reveals, 'candidates'))}/, e.g. --pick ${key} 1`);
  const canvas = canvasOf(plan);
  const relative = `reveals/${key}.jpg`;
  const target = join(paths.dir, relative);
  const before = existsSync(target) ? sha256(readFileSync(target)) : null;
  mkdirSync(paths.reveals, { recursive: true });
  await sharp(source).resize(canvas.width, canvas.height, { fit: 'cover' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(target);
  const after = sha256(readFileSync(target));
  writeJson(join(paths.reveals, `${key}.json`), { key, candidate: n, source: shown(source), sha256: after, pickedAt: new Date().toISOString() });
  doc.setIn(['places', found.pi, 'objects', found.oi, 'reveal', 'still'], relative);
  if (before && before !== after) {
    // A new picture: its old description is wrong, and every take rendered to or from the old one no longer counts.
    doc.deleteIn(['places', found.pi, 'objects', found.oi, 'reveal', 'seen']);
    log.warn(`${key}: a new close look. Its films are rendered again; write its seen afresh, and the film's arrival to match it`);
  }
  writePlan(id, doc);
  log.ok(`${key}: ${shown(target)} is its close look. Look at it at full size and write reveal.seen, then lint.`);
  log.next(nextStep(id));
  return 0;
}

/** Below this, a candidate's room differs from the zoomed crop enough to be worth a look before choosing it. */
export const ROOM_KEPT = 0.8;

/** What Qwen Image Edit is told: the zoomed crop exactly as it is, with only the plan's change. */
export const closeLookPrompt = paint => [
  'The same picture, with the same framing, room, light, colours, furniture and people exactly where they are, sharp and finely detailed.',
  `The only change: ${String(paint).replace(/\s+/g, ' ').trim().replace(/[^.!?]$/, '$&.')}`,
  'Nothing else is added, moved or removed.',
].join(' ');

/**
 * Where the close look is in the place's still: a crop of the canvas's shape
 * around the object (its outline's box, else its first click, else its label
 * point), zoomed so the object fills about two fifths of the width, at most
 * 2× (or `zoom`, up to 3×), set a little above the object so a hand lifting it
 * stays in frame. Also returns the object's box inside the crop.
 */
export async function closeFrame({ paths, key, object, stillPath, zoom }) {
  const { width: W, height: H } = await sharp(stillPath).metadata();
  const aspect = W / H;
  const mask = join(paths.selections, `${key}.png`);
  const point = object.select?.positive?.[0] ?? object.at ?? [0.5, 0.5];
  const box = (existsSync(mask) ? await maskBox(mask, W, H) : null)
    ?? { x: point[0] * W - W * 0.05, y: point[1] * H - H * 0.05, width: W * 0.1, height: H * 0.1 };
  // By default no deeper than 2×: a small object's crop is soft, and the hand in the film brings it closer.
  const wanted = Number.isFinite(zoom) ? W / Math.min(3, Math.max(1, zoom)) : Math.max(box.width / 0.4, (box.height / 0.6) * aspect, W / 2);
  const cw = Math.round(Math.min(W, Math.max(W / 3, wanted)));
  const ch = Math.min(H, Math.round(cw / aspect));
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2 - 0.12 * ch;
  const left = Math.round(Math.min(W - cw, Math.max(0, cx - cw / 2)));
  const top = Math.round(Math.min(H - ch, Math.max(0, cy - ch / 2)));
  return { crop: { left, top, width: cw, height: ch }, zoom: Math.round((W / cw) * 100) / 100,
    object: { x: (box.x - left) / cw, y: (box.y - top) / ch, width: box.width / cw, height: box.height / ch } };
}

/**
 * How much of the room a candidate kept: the correlation of its layout (the
 * picture at 48×27, so the sharper detail the edit adds does not count) with
 * the zoomed crop's, outside the object's box grown by half its size on each
 * side, where the change belongs. A repainted room (a lamp added, a wall
 * moved) is what makes the film into it morph; 1 is the same room.
 */
export async function roomKept(zoomPng, candidatePng, object) {
  const [w, h] = [48, 27];
  const layout = async png => {
    const grey = await sharp(png).resize(w, h, { fit: 'fill', kernel: 'cubic' }).greyscale().raw().toBuffer();
    const x0 = Math.floor((object.x - object.width / 2) * w), y0 = Math.floor((object.y - object.height / 2) * h);
    const x1 = Math.ceil((object.x + object.width * 1.5) * w), y1 = Math.ceil((object.y + object.height * 1.5) * h);
    const out = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < x0 || x >= x1 || y < y0 || y >= y1) out.push(grey[y * w + x]);
    return out;
  };
  return +correlation(await layout(zoomPng), await layout(candidatePng)).toFixed(2);
}
