// build: assemble the finished world from what you approved.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import sharp from 'sharp';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan, filmsOf, nextPlaceId } from '../lib/plan.js';
import { resolveWorldId, shown, filmId, loopId, worldFile } from '../lib/paths.js';
import { readJson, writeJson, sha256File } from '../lib/files.js';
import { listTakes, approvedTake, filmState, readVerdicts, readNotes } from '../lib/takes.js';
import { canvasByName, delivered } from '../lib/h3.js';
import { finishFilm, rewindFilm, levelAudio, cleanPartials } from '../lib/finish.js';
import { validateWorld, FORMAT } from '../lib/worldjson.js';

export const summary = 'Assemble the playable world (build/world.json) from your approved takes';
export const usage = `node world build [world] [--force]

  Finishes every approved take for the web (full size and half size, levelled
  sound), renders a rewind for every crossing, copies stills, outlines,
  narration and music, and writes build/world.json. Films without an approved
  take are left out and listed. --force re-encodes everything.`;

const RECIPE = 'film-v1';

export async function run(argv) {
  const { values, world } = parse(argv, { force: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);
  if (!filmsOf(plan).some(film => approvedTake(listTakes(paths, film.id, verdicts, notes)))) {
    log.warn('Nothing is playable yet: no film has an approved take, so there is nothing to build.');
    log.next(nextStep(id));
    return 0;
  }
  log.title(`Building ${plan.title || id}`);
  const result = await buildWorld({ paths, plan, force: values.force });
  report(result, id);
  return result.issues.length ? 1 : 0;
}

/**
 * Build a world into paths.build. Pure over its inputs (paths + plan), so it
 * can be run on any world folder, including the synthetic ones in the tests.
 */
export async function buildWorld({ paths, plan, force = false, say = log }) {
  const out = paths.build;
  mkdirSync(join(out, 'films'), { recursive: true });
  mkdirSync(join(out, 'stills'), { recursive: true });
  cleanPartials(join(out, 'films'));
  const manifestPath = join(out, '.manifest.json');
  const manifest = force ? {} : readJson(manifestPath, {});
  const fresh = (key, source, files) => !force && manifest[key]?.source === source && manifest[key]?.recipe === RECIPE && files.every(existsSync);
  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);

  const films = new Map();
  const missing = [];
  for (const film of filmsOf(plan)) {
    const takes = listTakes(paths, film.id, verdicts, notes);
    const take = approvedTake(takes);
    if (!take) { missing.push({ film: film.id, kind: film.kind, state: filmState(takes) }); continue; }
    if (!existsSync(take.files.video)) throw new Error(`${film.id} take ${take.take} is approved but its file is gone: ${shown(take.files.video)}`);
    if (sha256File(take.files.video) !== take.sha) throw new Error(`${film.id} take ${take.take} no longer matches the file that was approved (SHA-256 changed)`);
    const base = join(out, 'films', film.id);
    const main = `${base}.mp4`, half = `${base}-720.mp4`;
    let info = manifest[`films/${film.id}.mp4`]?.info;
    if (!fresh(`films/${film.id}.mp4`, take.sha, [main, half]) || !info) {
      say.step(`Finishing ${film.id} (take ${take.take})`);
      info = await finishFilm(take.files.video, main, half);
      manifest[`films/${film.id}.mp4`] = { source: take.sha, recipe: RECIPE, info };
      writeJson(manifestPath, manifest);
    }
    const entry = { film, take, info, src: rel(out, main), src720: rel(out, half), rewind: null };
    if (film.kind === 'crossing') {
      const back = `${base}-rewind.mp4`, back720 = `${base}-rewind-720.mp4`;
      if (!fresh(`films/${film.id}-rewind.mp4`, take.sha, [back, back720])) {
        say.step(`Rewinding ${film.id}`);
        await rewindFilm(main, back, back720);
        manifest[`films/${film.id}-rewind.mp4`] = { source: take.sha, recipe: RECIPE };
        writeJson(manifestPath, manifest);
      }
      entry.rewind = { src: rel(out, back), src720: rel(out, back720), seconds: info.seconds };
    }
    films.set(film.id, entry);
  }

  // Stills: the canonical picture of every place, as JPEG.
  const stills = {};
  let stillSize = null;
  for (const place of plan.places) {
    if (!place.still) throw new Error(`Place "${place.id}" has no still. Run: node world ingest`);
    const source = worldFile(paths, place.still, `places.${place.id}.still`);
    if (!existsSync(source)) throw new Error(`Place "${place.id}": ${place.still} is missing. Run: node world ingest`);
    const target = join(out, 'stills', `${place.id}.jpg`);
    const sha = sha256File(source);
    if (!fresh(`stills/${place.id}.jpg`, sha, [target])) {
      if (/\.jpe?g$/i.test(extname(source))) copyFileSync(source, target);
      else await sharp(source).jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toFile(target);
      manifest[`stills/${place.id}.jpg`] = { source: sha, recipe: RECIPE };
    }
    stills[place.id] = rel(out, target);
    stillSize ??= await sharp(target).metadata();
  }

  // Narration and music, made by `narrate` and `music`.
  const narration = {};
  for (const place of plan.places) {
    const lines = place.narration?.lines ?? [];
    if (!lines.length) continue;
    const receiptPath = join(paths.audio, 'narration', `${place.id}.json`);
    const receipt = existsSync(receiptPath) ? readJson(receiptPath) : null;
    if (receipt?.status === 'completed' && receipt.mp3 && existsSync(join(paths.audio, 'narration', receipt.mp3))) {
      const target = join(out, 'audio', `narration-${place.id}.mp3`);
      mkdirSync(join(out, 'audio'), { recursive: true });
      copyFileSync(join(paths.audio, 'narration', receipt.mp3), target);
      narration[place.id] = { src: rel(out, target), lines: receipt.lines.map(line => clean({ text: line.text, speaker: line.speaker, start: line.start, end: line.end })) };
    } else {
      // Without a recording the lines show at reading pace.
      const speaker = place.narration.speaker;
      narration[place.id] = { lines: lines.map(text => clean({ text: String(text), speaker })) };
      missing.push({ film: `narration of ${place.id}`, kind: 'narration', state: 'unrendered' });
    }
  }
  let music = null;
  if (plan.music) {
    const receiptPath = join(paths.audio, 'music', 'music.json');
    const receipt = existsSync(receiptPath) ? readJson(receiptPath) : null;
    if (receipt?.status === 'completed' && existsSync(join(paths.audio, 'music', receipt.mp3))) {
      const target = join(out, 'audio', 'music.mp3');
      mkdirSync(join(out, 'audio'), { recursive: true });
      copyFileSync(join(paths.audio, 'music', receipt.mp3), target);
      music = clean({ src: rel(out, target), volume: plan.music.volume ?? 1, underFilms: plan.music.underFilms ?? 0.5, credit: plan.music.credit ?? receipt.credit });
    } else {
      missing.push({ film: 'music', kind: 'music', state: 'unrendered' });
    }
  }

  // The world.
  const linear = (plan.order ?? 'linear') === 'linear';
  const canvas = plan.canvas ? delivered(canvasByName(String(plan.canvas))) : null;
  const firstFilm = [...films.values()][0]?.info;
  const aspect = canvas ?? (firstFilm ? { width: firstFilm.width, height: firstFilm.height } : { width: stillSize.width, height: stillSize.height });
  const places = plan.places.map(place => {
    const loop = films.get(loopId(place.id));
    const hotspots = [];
    for (const object of place.objects) {
      const entry = films.get(filmId(place.id, object.id));
      if (!entry) continue;
      const selectionPath = join(paths.selections, `${place.id}-${object.id}.json`);
      const selection = existsSync(selectionPath) ? readJson(selectionPath) : null;
      const at = object.at ?? object.select?.positive?.[0] ?? null;
      const isNext = linear && Boolean(object.goes) && object.goes === nextPlaceId(plan, place.id);
      hotspots.push(clean({
        id: object.id,
        label: object.label ?? object.id,
        hint: object.hint,
        at: at ? [clamp01(at[0]), clamp01(at[1])] : [0.5, 0.5],
        outline: selection?.outline ? { width: selection.outline.width, height: selection.outline.height, path: selection.outline.path } : null,
        to: object.goes ?? null,
        next: object.goes ? isNext : undefined,
        shortcut: object.goes ? Boolean(object.shortcut ?? (linear && !isNext)) && !isNext : undefined,
        film: { src: entry.src, src720: entry.src720, seconds: entry.info.seconds },
        rewind: object.goes ? entry.rewind : undefined,
      }));
    }
    return clean({
      id: place.id,
      title: place.title || place.id,
      chapter: place.chapter || undefined,
      caption: place.caption || undefined,
      still: stills[place.id],
      loop: loop ? { src: loop.src, src720: loop.src720, seconds: loop.info.seconds } : null,
      narration: narration[place.id] ?? null,
      hotspots,
    });
  });
  const world = clean({
    format: FORMAT,
    id: plan.id,
    title: plan.title || plan.id,
    subtitle: plan.subtitle || undefined,
    credit: plan.credit || 'Made with Sogni',
    aspect,
    start: plan.start || plan.places[0]?.id,
    order: linear ? plan.places.map(place => place.id) : null,
    music,
    places,
  });
  const issues = validateWorld(world);
  writeJson(manifestPath, manifest);
  if (!issues.length) writeJson(join(out, 'world.json'), world);

  // What a visitor can and cannot do.
  const reachable = new Set([world.start]);
  for (const place of places) for (const h of place.hotspots) if (h.to) reachable.add(h.to);
  const deadEnds = places.filter(p => !p.hotspots.some(h => h.to)).map(p => p.id);
  const unreachable = places.filter(p => !reachable.has(p.id)).map(p => p.id);
  return { world, issues, missing, deadEnds, unreachable, films: films.size, out };
}

function report({ world, issues, missing, deadEnds, unreachable, films, out }, id) {
  if (issues.length) {
    log.fail('world.json would not be valid:');
    for (const issue of issues) log.info(issue);
    return;
  }
  const hotspots = world.places.reduce((n, p) => n + p.hotspots.length, 0);
  const loops = world.places.filter(p => p.loop).length;
  const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  log.ok(`${shown(join(out, 'world.json'))}: ${count(world.places.length, 'place', 'places')}, ${count(hotspots, 'thing to click', 'things to click')}, ${count(loops, 'living photograph', 'living photographs')} (${count(films, 'film', 'films')} finished)`);
  if (missing.length) {
    log.warn(`Not in the world yet (${missing.length}):`);
    for (const m of missing) log.info(`${m.film} — ${m.state}`);
  }
  if (deadEnds.length) log.warn(`No way on from: ${deadEnds.join(', ')}`);
  if (unreachable.length) log.warn(`Nothing leads to: ${unreachable.join(', ')}`);
  log.next(nextStep(id));
}

const rel = (from, path) => relative(from, path).split('\\').join('/');
const clamp01 = value => Math.min(1, Math.max(0, Number(value)));
/** Drop undefined fields so the JSON stays tidy (and valid: no stray keys). */
function clean(object) {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
  return object;
}

