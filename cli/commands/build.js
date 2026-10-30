// build: assemble the finished world from what you approved.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import sharp from 'sharp';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan, filmsOf, nextPlaceId } from '../lib/plan.js';
import { resolveWorldId, shown, filmId, loopId, backId, worldFile } from '../lib/paths.js';
import { readJson, writeJson, sha256File } from '../lib/files.js';
import { listTakes, approvedTake, filmState, readVerdicts, readNotes } from '../lib/takes.js';
import { canvasByName, delivered } from '../lib/h3.js';
import { isSeedance } from '../lib/seedance.js';
import { finishFilm, rewindFilm, relevelFilm, cleanPartials, FILM_LUFS } from '../lib/finish.js';
import { validateWorld, FORMAT } from '../lib/worldjson.js';
import { deliveryIssues, writeServedStill, writeIcon, writeSocialCard, WEB_AUDIO, SOCIAL } from '../lib/delivery.js';
import { ffmpeg } from '../lib/media.js';
import { figureFiles } from '../lib/figures.js';
import { wantsFigure } from './figures.js';

export const summary = 'Assemble the playable world (build/world.json) from your approved takes';
export const usage = `node world build [world] [--force] [--drafts]

  Finishes every approved take for the web (full size and half size through
  Sogni's streaming profile, levelled sound), renders a rewind for every
  crossing, writes the stills as WebP and a JPEG social card, copies outlines,
  narration and music, checks every file against the web formats
  (docs/hosting.md › What a world serves) and writes build/world.json. Films
  without an approved take are left out and listed. --force re-encodes everything.

  --drafts  also use the newest take nobody has rejected for a film with no
            approved take yet, so the whole world can be played before every
            film is judged. The player marks such a world "Draft". Approving
            is still done on the review page (individually or for all takes
            in this build). A draft cannot be submitted to the gallery.
            Approve before hosting, then build again without --drafts for
            the finished world. Unchanged films are not re-encoded.`;

// The picture's recipe. The sound's level is kept beside it (`lufs`): a new level re-levels the
// sound of the films already finished, in seconds, and never re-encodes a picture.
// film-v2: Sogni's streaming profile (CRF 23 capped by size, a keyframe every 2 s) and WebP stills.
const RECIPE = 'film-v2';
/** What a film finished before levels were recorded was levelled to. */
const FIRST_LUFS = -14;

export async function run(argv) {
  const { values, world } = parse(argv, { force: { type: 'boolean', default: false }, drafts: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);
  const usable = takes => approvedTake(takes) ?? (values.drafts ? draftTake(takes) : null);
  if (!filmsOf(plan).some(film => usable(listTakes(paths, film.id, verdicts, notes, film)))) {
    log.warn('Nothing is playable yet: no film has an approved take, so there is nothing to build.');
    log.next(nextStep(id));
    return 0;
  }
  log.title(`Building ${plan.title || id}`);
  const result = await buildWorld({ paths, plan, force: values.force, drafts: values.drafts });
  report(result, id);
  return result.issues.length || result.delivery.length ? 1 : 0;
}

/**
 * Build a world into paths.build. Pure over its inputs (paths + plan), so it
 * can be run on any world folder, including the synthetic ones in the tests.
 */
export async function buildWorld({ paths, plan, force = false, drafts = false, say = log }) {
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
  const unapproved = [];
  for (const film of filmsOf(plan)) {
    const takes = listTakes(paths, film.id, verdicts, notes, film);
    let take = approvedTake(takes);
    if (!take && drafts) {
      take = draftTake(takes);
      if (take) unapproved.push(`${film.id} take ${take.take}`);
    }
    if (!take) { missing.push({ film: film.id, kind: film.kind, state: filmState(takes) }); continue; }
    if (!existsSync(take.files.video)) throw new Error(`${film.id} take ${take.take} is ${take.verdict?.verdict === 'approved' ? 'approved' : 'the draft'} but its file is gone: ${shown(take.files.video)}`);
    if (sha256File(take.files.video) !== take.sha) throw new Error(`${film.id} take ${take.take} no longer matches the file that was rendered (SHA-256 changed)`);
    const base = join(out, 'films', film.id);
    const main = `${base}.mp4`, half = `${base}-720.mp4`;
    // A Seedance take is sized onto the canvas; a take rendered from a push-in's crop gets its push-in in front.
    const { finishing, source } = finishingOf(paths, plan, film, take);
    let info = manifest[`films/${film.id}.mp4`]?.info;
    if (!fresh(`films/${film.id}.mp4`, source, [main, half]) || !info) {
      say.step(`Finishing ${film.id} (take ${take.take})`);
      info = await finishFilm(take.files.video, main, half, { lufs: FILM_LUFS, ...finishing });
      manifest[`films/${film.id}.mp4`] = { source, recipe: RECIPE, info, lufs: FILM_LUFS };
      writeJson(manifestPath, manifest);
    } else if ((manifest[`films/${film.id}.mp4`].lufs ?? FIRST_LUFS) !== FILM_LUFS) {
      say.step(`Levelling ${film.id}'s sound`);
      for (const file of [main, half]) await relevelFilm(file, FILM_LUFS);
      manifest[`films/${film.id}.mp4`].lufs = FILM_LUFS;
      writeJson(manifestPath, manifest);
    }
    const entry = { film, take, info, src: rel(out, main), src720: rel(out, half), rewind: null };
    if (film.kind === 'crossing') {
      const back = `${base}-rewind.mp4`, back720 = `${base}-rewind-720.mp4`;
      if (!fresh(`films/${film.id}-rewind.mp4`, source, [back, back720])) {
        say.step(`Rewinding ${film.id}`);
        await rewindFilm(main, back, back720);
        manifest[`films/${film.id}-rewind.mp4`] = { source, recipe: RECIPE, lufs: FILM_LUFS };
        writeJson(manifestPath, manifest);
      } else if ((manifest[`films/${film.id}-rewind.mp4`].lufs ?? FIRST_LUFS) !== FILM_LUFS) {
        for (const file of [back, back720]) await relevelFilm(file, FILM_LUFS);
        manifest[`films/${film.id}-rewind.mp4`].lufs = FILM_LUFS;
        writeJson(manifestPath, manifest);
      }
      entry.rewind = { src: rel(out, back), src720: rel(out, back720), seconds: info.seconds };
    }
    films.set(film.id, entry);
  }

  // Stills: the canonical picture of every place, served as WebP at its own size.
  const stills = {};
  let stillSize = null;
  for (const place of plan.places) {
    if (!place.still) throw new Error(`Place "${place.id}" has no still. Run: node world ingest`);
    const source = worldFile(paths, place.still, `places.${place.id}.still`);
    if (!existsSync(source)) throw new Error(`Place "${place.id}": ${place.still} is missing. Run: node world ingest`);
    const target = join(out, 'stills', `${place.id}.webp`);
    const sha = sha256File(source);
    if (!fresh(`stills/${place.id}.webp`, sha, [target])) {
      await writeServedStill(source, target);
      manifest[`stills/${place.id}.webp`] = { source: sha, recipe: RECIPE };
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
  // Reveals: the close look an object's film lands on, the line said over it, and the film back to
  // the place. An object whose film back is not ready yet stays out of the world: without it the
  // visitor would be left in the close look, or cut out of it.
  const reveals = {};
  for (const place of plan.places) for (const object of place.objects) {
    const reveal = !object.goes ? object.reveal : null;
    const key = filmId(place.id, object.id);
    if (!reveal?.still || !films.has(key)) continue;
    // The film back: the one the plan wrote, or the film in played backwards (the object lands exactly where it was).
    let back = films.get(backId(place.id, object.id));
    if (reveal.back && !back) { reveals[key] = null; continue; }
    if (!back) {
      // Its sound is the place's loop (the room carries on, and the loop it hands over to sounds the
      // same); without a loop, the film in's own sound, forwards (a reversed creak is not a set-down).
      const entry = films.get(key);
      const loop = films.get(loopId(place.id));
      const base = join(out, 'films', backId(place.id, object.id));
      const [main, half] = [`${base}.mp4`, `${base}-720.mp4`];
      const source = `${entry.take.sha}+${loop?.take.sha ?? 'own'}`;
      if (!fresh(`films/${backId(place.id, object.id)}.mp4`, source, [main, half]) || manifest[`films/${backId(place.id, object.id)}.mp4`]?.lufs !== FILM_LUFS) {
        say.step(`Reversing ${key} to put it back`);
        await rewindFilm(join(out, entry.src), main, half, { sound: loop ? join(out, loop.src) : 'forward' });
        manifest[`films/${backId(place.id, object.id)}.mp4`] = { source, recipe: RECIPE, lufs: FILM_LUFS };
        writeJson(manifestPath, manifest);
      }
      back = { src: rel(out, main), src720: rel(out, half), info: entry.info };
    }
    const source = worldFile(paths, reveal.still, `places.${place.id}.objects.${object.id}.reveal.still`);
    if (!existsSync(source)) throw new Error(`${key}: the reveal still ${reveal.still} is missing. Run: node world reveals`);
    // In their own folder: a place may be called what an object's close look is (<place>-<object>).
    mkdirSync(join(out, 'stills', 'reveals'), { recursive: true });
    const target = join(out, 'stills', 'reveals', `${key}.webp`);
    const sha = sha256File(source);
    if (!fresh(`stills/reveals/${key}.webp`, sha, [target])) {
      await writeServedStill(source, target);
      manifest[`stills/reveals/${key}.webp`] = { source: sha, recipe: RECIPE };
    }
    let spoken;
    const receiptPath = join(paths.audio, 'narration', 'reveals', `${key}.json`);
    const receipt = reveal.line && existsSync(receiptPath) ? readJson(receiptPath) : null;
    if (receipt?.status === 'completed' && receipt.mp3 && existsSync(join(paths.audio, 'narration', 'reveals', receipt.mp3))) {
      const audio = join(out, 'audio', `narration-reveal-${key}.mp3`);
      mkdirSync(join(out, 'audio'), { recursive: true });
      copyFileSync(join(paths.audio, 'narration', 'reveals', receipt.mp3), audio);
      spoken = { src: rel(out, audio), lines: receipt.lines.map(line => clean({ text: line.text, speaker: line.speaker, start: line.start, end: line.end })) };
    } else if (reveal.line) {
      spoken = { lines: [{ text: String(reveal.line) }] };
      missing.push({ film: `the reveal line of ${key}`, kind: 'narration', state: 'unrendered' });
    }
    reveals[key] = clean({ still: rel(out, target), narration: spoken, done: reveal.done || undefined, back: { src: back.src, src720: back.src720, seconds: back.info.seconds } });
  }

  // A place's own track (a file the person has the rights to) in place of the world's while they are there.
  const placeMusic = {};
  for (const place of plan.places) {
    if (place.music === undefined) continue;
    if (place.music === null) { placeMusic[place.id] = null; continue; }
    const source = place.music.file ? join(paths.dir, place.music.file) : null;
    if (source && existsSync(source)) {
      // Served as it is when every browser streams it; anything else (WAV, AIFF, Ogg) as MP3.
      const web = WEB_AUDIO.includes(extname(source).toLowerCase());
      const target = join(out, 'audio', `music-${place.id}${web ? extname(source) : '.mp3'}`);
      mkdirSync(join(out, 'audio'), { recursive: true });
      const sha = sha256File(source);
      if (web) copyFileSync(source, target);
      else if (!fresh(rel(out, target), sha, [target])) {
        say.step(`Encoding ${place.music.file} as MP3`);
        await ffmpeg(['-i', source, '-vn', '-map_metadata', '-1', '-c:a', 'libmp3lame', '-b:a', '192k', '-write_xing', '1', target]);
        manifest[rel(out, target)] = { source: sha, recipe: RECIPE };
      }
      placeMusic[place.id] = clean({ src: rel(out, target), volume: place.music.volume, underFilms: place.music.underFilms, credit: place.music.credit });
    } else {
      missing.push({ film: `music of ${place.id}`, kind: 'music', state: 'unrendered' });
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
  // Figures: the mesh and a small icon of each collectible that has one (node world figures).
  const figures = {};
  for (const place of plan.places) for (const object of place.objects) {
    const key = filmId(place.id, object.id);
    const files = figureFiles(paths, key);
    if (!wantsFigure(object) || readJson(files.receipt, null)?.status !== 'completed' || !existsSync(files.glb)) continue;
    mkdirSync(join(out, 'figures'), { recursive: true });
    const model = join(out, 'figures', `${key}.glb`);
    const icon = join(out, 'figures', `${key}.webp`);
    copyFileSync(files.glb, model);
    await writeIcon(files.cutout, icon);
    figures[key] = { model: rel(out, model), icon: rel(out, icon), name: object.figureName ?? figureName(object.label ?? object.id) };
  }
  const places = plan.places.map(place => {
    const loop = films.get(loopId(place.id));
    const hotspots = [];
    for (const object of place.objects) {
      const entry = films.get(filmId(place.id, object.id));
      if (!entry || reveals[filmId(place.id, object.id)] === null) continue;
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
        collect: object.collect && !object.goes ? true : undefined,
        figure: figures[filmId(place.id, object.id)],
        details: object.details ? clean({ title: object.details.title, text: object.details.text, facts: object.details.facts }) : undefined,
        film: { src: entry.src, src720: entry.src720, seconds: entry.info.seconds },
        reveal: reveals[filmId(place.id, object.id)],
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
      ending: place.ending ? clean({ kind: place.ending.kind, title: place.ending.title, text: place.ending.text || undefined }) : undefined,
      music: placeMusic[place.id],
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
    intro: plan.intro ? clean({ ...plan.intro }) : undefined,
    map: plan.map === false ? false : undefined,
    draft: unapproved.length ? true : undefined,
    places,
  });
  const issues = validateWorld(world);
  // The card a link to the world shows (social sites, the Sogni gallery): its opening still.
  const opening = places.find(place => place.id === world.start)?.still;
  if (opening) await writeSocialCard(join(out, opening), join(out, SOCIAL.file));
  // Every file it serves, in the web formats: nothing outside them reaches a host.
  const delivery = issues.length ? [] : (await deliveryIssues(world, out)).issues;
  writeJson(manifestPath, manifest);
  if (!issues.length && !delivery.length) writeJson(join(out, 'world.json'), world);

  // What a visitor can and cannot do.
  const reachable = new Set([world.start]);
  for (const place of places) for (const h of place.hotspots) if (h.to) reachable.add(h.to);
  const deadEnds = places.filter(p => !p.hotspots.some(h => h.to)).map(p => p.id);
  const unreachable = places.filter(p => !reachable.has(p.id)).map(p => p.id);
  return { world, issues, delivery, missing, deadEnds, unreachable, films: films.size, out, unapproved };
}

function report({ world, issues, delivery = [], missing, deadEnds, unreachable, films, out, unapproved = [] }, id) {
  if (issues.length) {
    log.fail('world.json would not be valid:');
    for (const issue of issues) log.info(issue);
    return;
  }
  if (delivery.length) {
    log.fail(`world.json not written: the world would serve media outside the web formats (${delivery.length} problem${delivery.length === 1 ? '' : 's'}):`);
    for (const issue of delivery) log.info(issue);
    log.info(`A file build made: node world build ${id} --force encodes it again. A file you placed by hand: convert it (docs/hosting.md › What a world serves).`);
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
  if (unapproved.length) log.warn(`A draft: ${unapproved.length} film${unapproved.length === 1 ? ' has' : 's have'} no approved take yet and use${unapproved.length === 1 ? 's' : ''} the newest unrejected one (${unapproved.join(', ')}). A draft cannot be submitted to the gallery. Before hosting, approve individually or use "Approve this build’s takes" on node world review ${id}, then build again without --drafts. Unchanged films are not re-encoded.`);
  const endings = new Set(world.places.filter(p => p.ending).map(p => p.id));
  deadEnds = deadEnds.filter(id => !endings.has(id));
  if (deadEnds.length) log.warn(`No way on from: ${deadEnds.join(', ')}`);
  if (unreachable.length) log.warn(`Nothing leads to: ${unreachable.join(', ')}`);
  log.next(nextStep(id));
}

/**
 * How a take is finished beyond the usual encode, and the manifest's key for
 * it: the take's hash alone for an H3 take as rendered (so worlds built before
 * stay as they are), with what was added for the rest. The push-in is the one
 * the take was rendered from (its receipt), never the plan's, which may have
 * changed since.
 */
export function finishingOf(paths, plan, film, take) {
  const finishing = {};
  if (isSeedance(take.journal.model) && plan.canvas) finishing.size = delivered(canvasByName(String(plan.canvas)));
  const pushIn = film.kind === 'crossing' ? take.journal.pushIn : null;
  if (pushIn) finishing.pushIn = { ...pushIn, still: worldFile(paths, film.first, `places.${film.from}.still`) };
  const extra = [finishing.size ? `fit ${finishing.size.width}x${finishing.size.height}` : null, pushIn ? `push-in ${JSON.stringify(pushIn)}` : null].filter(Boolean);
  return { finishing, source: extra.length ? `${take.sha}+${extra.join('+')}` : take.sha };
}

const rel = (from, path) => relative(from, path).split('\\').join('/');
/** For a draft build: the newest finished take that nobody rejected. */
const draftTake = takes => takes.filter(t => !t.stale && t.journal.status === 'completed' && t.sha && t.verdict?.verdict !== 'rejected').at(-1) ?? null;
const clamp01 = value => Math.min(1, Math.max(0, Number(value)));
/** Drop undefined fields so the JSON stays tidy (and valid: no stray keys). */
function clean(object) {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
  return object;
}

/** What a figure is called in the collection: its label without the verb ("Touch the neon lotus" → "The neon lotus"). */
export function figureName(label) {
  const match = /^[A-Za-z']+\s+((?:the|a|an|his|her|their|its|your)\s+.+)$/i.exec(String(label).trim());
  const name = match ? match[1] : String(label).trim();
  return name.charAt(0).toUpperCase() + name.slice(1);
}
