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
import { paint, PAINT_SIZES } from '../lib/paint.js';
import { canvasOf, contentFilterOff } from './render.js';
import { nextStep } from './status.js';

export const summary = 'Paint the close look an object\'s film lands on (Krea 2 Identity Edit, from the place\'s still)';
export const usage = `node world reveals [world] [--only <place-object> ...] [--count <n>] [--force]
node world reveals [world] --pick <place-object> <n>

  An object with a reveal holds on a close look: its film carries the visitor
  from the place's still into that picture (the glove turned over in a hand,
  the letter unfolded under the lamp, her face as she answers), the narrator
  says its line there or the figure is turned over, and a second film puts it
  back. The close look is painted once from the place's own still with Sogni
  Krea 2 Identity Edit, so the light, the materials and the people stay the
  same, from the words in reveal.paint.

  Paints --count candidates (default 3) into reveals/candidates/. Look at each
  at full size: the object and every person exactly as in the place, and any
  writing real words, exactly the ones reveal.paint quotes. Then pick one:
  --pick copies it to reveals/<place>-<object>.jpg (from then on as fixed as a
  still) and writes reveal.still into world.yaml. Write reveal.seen from
  looking at it. --force paints new candidates for a reveal that has a still.`;

export async function run(argv) {
  const { values, world, positionals } = parse(argv, {
    only: { type: 'string', multiple: true }, count: { type: 'string', default: '3' }, force: { type: 'boolean', default: false },
    pick: { type: 'string' },
  });
  // --pick <place-object> <n>: the number is the last word; the world, when named, the first.
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
    if (reveal.still && !values.force) continue;
    todo.push({ place, object, key, reveal });
  }
  if (only) for (const key of only) if (!todo.some(t => t.key === key)) log.warn(`${key}: no reveal with \`paint\`, or it already has a still (--force paints new candidates)`);
  if (!todo.length) { log.ok('Every close look is painted.'); log.next(nextStep(id)); return 0; }

  const canvas = canvasOf(plan);
  const [width, height] = PAINT_SIZES[`${canvas.width}x${canvas.height}`] ?? [canvas.width, canvas.height];
  const dark = Boolean(plan.mature);
  const dir = join(paths.reveals, 'candidates');
  mkdirSync(dir, { recursive: true });
  // Painting again keeps the earlier candidates, moved aside, so nothing looked at is lost.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const { key } of todo) {
    const earlier = readdirSync(dir).filter(name => name.startsWith(`${key}-`) || name === `${key}.json`);
    if (!earlier.length) continue;
    mkdirSync(join(dir, 'earlier', stamp), { recursive: true });
    for (const name of earlier) renameSync(join(dir, name), join(dir, 'earlier', stamp, name));
  }
  const session = await connect({ appId: `sogni-worlds-reveals-${id}` });
  const failed = [];
  try {
    log.title(`Painting ${todo.length} close look${todo.length === 1 ? '' : 's'}, ${count} candidate${count === 1 ? '' : 's'} each`);
    for (const { place, key, reveal } of todo) {
      try {
        const still = readFileSync(worldFile(paths, place.still, `places.${place.id}.still`));
        // The place's still is the context: the edit keeps its light, its materials and its people.
        const prompt = `${String(reveal.paint).trim()}\nThe same scene, light, colours, materials and people as the reference picture, seen closer.`;
        log.step(`${key}: ${String(reveal.paint).slice(0, 90)}${String(reveal.paint).length > 90 ? '…' : ''}`);
        const { images, modelId, projectId } = await paint(session, { prompt, width, height, context: [still], count, dark, contentFilter: !contentFilterOff(plan) });
        const files = [];
        for (const [index, bytes] of images.entries()) {
          const file = join(dir, `${key}-${index + 1}.png`);
          writeFileSync(file, bytes);
          files.push(file);
        }
        writeJson(join(dir, `${key}.json`), { key, modelId, projectId, prompt, width, height, sha256: images.map(sha256), paintedAt: new Date().toISOString() });
        log.ok(`${key}: ${files.map(shown).join(', ')}`);
      } catch (error) {
        failed.push(`${key}: ${error.message}`);
        log.fail(`${key}: ${error.message}`);
      }
    }
  } finally {
    session.close();
  }
  log.info('Look at every candidate at full size: the object and every person as in the place, any writing real words (exactly what reveal.paint quotes).');
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
  if (existsSync(target) && found.object.reveal.still === relative) {
    const receipt = readJson(join(paths.reveals, `${key}.json`), null);
    // A still a film was rendered from stays as it is; painting again means a new close look and new films.
    if (receipt && receipt.candidate !== n) log.warn(`${key}: replacing the close look; the films into and out of it must be rendered again`);
  }
  mkdirSync(paths.reveals, { recursive: true });
  await sharp(source).resize(canvas.width, canvas.height, { fit: 'cover' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toFile(target);
  writeJson(join(paths.reveals, `${key}.json`), { key, candidate: n, source: shown(source), sha256: sha256(readFileSync(target)), pickedAt: new Date().toISOString() });
  doc.setIn(['places', found.pi, 'objects', found.oi, 'reveal', 'still'], relative);
  writePlan(id, doc);
  log.ok(`${key}: ${shown(target)} is its close look. Look at it at full size and write reveal.seen, then lint.`);
  log.next(nextStep(id));
  return 0;
}
