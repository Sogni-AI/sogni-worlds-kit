import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { parse } from '../index.js';
import { filmId, listWorlds, shown, worldPaths } from '../lib/paths.js';
import { filmsOf, readPlan } from '../lib/plan.js';
import { lintPlan } from '../lib/lint.js';
import { describeNote, filmState, listTakes, readNotes, readStillNotes, readVerdicts } from '../lib/takes.js';
import { canaryNext, canaryStatus } from '../lib/canary.js';
import { readRenderLock } from '../lib/renderlock.js';
import { readJson } from '../lib/files.js';
import { PHOTO_EXTENSIONS } from '../lib/stills.js';
import { log } from '../lib/log.js';
import { wantsFigure } from './figures.js';
import { figureFiles } from '../lib/figures.js';

export const summary = 'Where this world stands: places, outlines, films by state, audio, build — and what to do next';
export const usage = 'node world status [world] [--json]';

const mtime = path => (existsSync(path) ? statSync(path).mtimeMs : 0);

/** Everything `next` needs to decide, gathered from the world's folder. */
export function gather(id) {
  const paths = worldPaths(id);
  if (!existsSync(paths.plan)) return { id, exists: false };
  const { plan } = readPlan(id);
  const photos = existsSync(paths.photos) ? readdirSync(paths.photos).filter(n => PHOTO_EXTENSIONS.includes(extname(n).toLowerCase())).length : 0;
  const findings = lintPlan(plan, paths);
  const stillsMissing = plan.places.filter(p => !p.still || !existsSync(join(paths.dir, p.still))).map(p => p.id);
  const indexed = existsSync(join(paths.stills, 'index.json')) ? Object.values(readJson(join(paths.stills, 'index.json'))).map(e => e.photo) : [];
  const photosNotIngested = existsSync(paths.photos)
    ? readdirSync(paths.photos).filter(n => PHOTO_EXTENSIONS.includes(extname(n).toLowerCase())).filter(n => !indexed.includes(`photos/${n}`)).length
    : 0;
  const films = filmsOf(plan);
  const planWritten = plan.places.length > 0 && plan.places.every(p => p.title && (p.loop || p.objects.length || p.ending)) && films.length > 0;

  const selections = { needed: [], done: 0, failed: [] };
  for (const place of plan.places) {
    for (const object of place.objects) {
      if (!object.select) continue;
      const key = filmId(place.id, object.id);
      const file = join(paths.selections, `${key}.json`);
      const status = existsSync(file) ? readJson(file).status : null;
      if (status === 'completed') selections.done += 1;
      else if (status === 'failed') selections.failed.push(key);
      else selections.needed.push(key);
    }
  }

  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);
  const byState = { unrendered: [], rendering: [], failed: [], unjudged: [], rejected: [], approved: [] };
  let takes = 0;
  let finishedTakes = 0;
  const unscreened = [];
  const unlooked = [];
  const unjudged = [];
  const feedback = [];
  for (const film of films) {
    const list = listTakes(paths, film.id, verdicts, notes);
    takes += list.length;
    const state = filmState(list);
    byState[state].push(film.id);
    // What the person said about the latest rejected take: read it before rewriting the direction.
    const rejected = state === 'rejected' ? list.filter(t => t.verdict?.verdict === 'rejected').at(-1) : null;
    if (rejected) feedback.push({ film: film.id, take: rejected.take, verdict: rejected.verdict.note ?? '', notes: rejected.notes.filter(n => n.by !== 'agent') });
    for (const take of list) {
      if (take.journal.status === 'completed') finishedTakes += 1;
      if (take.journal.status !== 'completed' || take.verdict) continue;
      unjudged.push(`${film.id} take ${take.take}`);
      if (!take.screen) unscreened.push(`${film.id} take ${take.take}`);
      else if (!take.notes.some(n => n.by === 'agent')) unlooked.push({ film: film.id, take: take.take });
    }
  }

  const narrated = plan.places.filter(p => p.narration?.lines?.length);
  const narrationNeeded = narrated.filter(p => !existsSync(join(paths.audio, 'narration', `${p.id}.json`))).map(p => p.id);
  const musicNeeded = Boolean(plan.music) && !existsSync(join(paths.audio, 'music', 'music.json'));
  // A collectible with an outline and no 3D figure yet (node world figures).
  const figuresNeeded = plan.places.flatMap(p => (p.objects ?? []).filter(wantsFigure).map(o => `${p.id}-${o.id}`))
    .filter(key => existsSync(join(paths.selections, `${key}.png`)) && readJson(figureFiles(paths, key).receipt, null)?.status !== 'completed');
  const builtAt = mtime(join(paths.build, 'world.json'));
  const inputsAt = Math.max(mtime(paths.plan), mtime(join(paths.review, 'verdicts.json')));
  return {
    id, exists: true, title: plan.title, photos, photosNotIngested, places: plan.places.length, stillsMissing, planWritten,
    errors: findings.filter(f => f.level === 'error'), warnings: findings.filter(f => f.level === 'warn'),
    selections, films: films.length, takes, finishedTakes, byState, unscreened, unlooked, unjudged, feedback,
    stillNotes: Object.entries(readStillNotes(paths)).flatMap(([place, list]) => list.map(note => ({ place, ...note }))),
    canary: canaryStatus(plan, paths, verdicts, notes),
    renderLock: readRenderLock(paths),
    narrationNeeded, narratedPlaces: narrated.length, hasMusic: Boolean(plan.music), musicNeeded, figuresNeeded, built: builtAt > 0, buildStale: builtAt > 0 && builtAt < inputsAt,
  };
}

/** The single next action, in the order a world is built. Returns { why, command }. */
export function nextAction(s) {
  const id = s.id;
  if (!s.exists) return { why: 'there is no world yet', command: `node world new ${id}` };
  if (!s.places && !s.photos) return { why: 'no photos yet', command: `interview the person first (AGENTS.md › 2. Interview the person): what the world is about and its title, who is in the photos, and the ORDER of the places. Then copy their full-size photos into worlds/${id}/photos/ named in that order (01-harbour.jpg, 02-ferry.jpg, …; the number sets the order and is dropped from the place id, which can't change later), then: node world ingest ${id}` };
  if (s.photosNotIngested || s.stillsMissing.length) return { why: 'photos are waiting to become stills', command: `node world ingest ${id}` };
  if (!s.planWritten) return { why: 'the plan is not written yet', command: `look at every still in worlds/${id}/stills/ at full size, then write the plan in worlds/${id}/world.yaml — seen, title, loop and objects with films for each place (AGENTS.md › 4. Write the plan). Check it with: node world lint ${id}` };
  if (s.errors.length) return { why: `world.yaml has ${s.errors.length} error${s.errors.length === 1 ? '' : 's'}`, command: `node world lint ${id}   — fix each ✗, then run it again` };
  if (s.renderLock) {
    const canaryOpen = s.canary && !['approved', 'none'].includes(s.canary.state);
    const meanwhile = s.unscreened.length ? `; meanwhile, screen the takes that have finished: node world screen ${id}` : '';
    return {
      why: `a render is running (pid ${s.renderLock.pid}, started ${s.renderLock.startedAt})`,
      command: `wait for it to finish${meanwhile}. If it was interrupted, node world render ${id}${canaryOpen ? ' --canary' : ''} picks up where it stopped (nothing is submitted twice)`,
    };
  }
  if (!s.takes && !s.selections.done) {
    const then = s.selections.needed.length ? `node world select ${id}` : `node world quote ${id}   — then: node world render ${id} --canary`;
    return { why: 'the plan is ready and nothing has been spent', command: `show the person the plan (node world plan ${id}) and get their OK before anything is spent, then: ${then}` };
  }
  if (s.selections.needed.length) return { why: `${s.selections.needed.length} object${s.selections.needed.length === 1 ? ' needs' : 's need'} outlines`, command: `node world select ${id}` };
  if (s.selections.failed.length) return { why: `SAM 3 could not outline ${s.selections.failed.join(', ')}`, command: `change their select clicks in world.yaml (changed clicks are selected again automatically), then: node world select ${id}` };
  if (!s.takes) return { why: 'nothing rendered yet', command: `node world quote ${id}   — then: node world render ${id} --canary` };
  const canary = s.canary && !['approved', 'none'].includes(s.canary.state) ? canaryNext(s.canary, id) : null;
  if (canary && s.canary.state !== 'unjudged') return canary;
  if (s.byState.rendering.length) return { why: `${s.byState.rendering.length} film${s.byState.rendering.length === 1 ? ' is' : 's are'} still rendering`, command: `node world render ${id}   (picks them up; nothing is submitted twice)` };
  if (s.unscreened.length) return { why: `${s.unscreened.length} new take${s.unscreened.length === 1 ? '' : 's'} not screened`, command: `node world screen ${id}` };
  if (s.unlooked.length) {
    const first = s.unlooked[0];
    return { why: `${s.unlooked.length} take${s.unlooked.length === 1 ? '' : 's'} not looked at yet`, command: `look at each new take's contact sheet and frames (worlds/${id}/renders/<film>/take-<n>.sheet.jpg and screen.json); reject a broken take: node world reject ${id} ${first.film} ${first.take} "<what is wrong>", or note what you saw: node world note ${id} ${first.film} ${first.take} "<what you saw>"` };
  }
  if (s.unjudged.length) return { why: `${s.unjudged.length} take${s.unjudged.length === 1 ? ' awaits' : 's await'} your verdict`, command: `node world review ${id}   — the person who owns the world approves or rejects each take` };
  if (s.byState.rejected.length) return { why: `${s.byState.rejected.join(', ')} ${s.byState.rejected.length === 1 ? 'was' : 'were'} rejected`, command: `read what the person said first (node world status ${id} lists their verdict and area notes; open each area note's picture), then rewrite the direction in world.yaml for what went wrong, then: node world render ${id} --only ${s.byState.rejected.join(' --only ')}` };
  if (s.byState.failed.length) return { why: `${s.byState.failed.join(', ')} failed to render`, command: `node world render ${id} --only ${s.byState.failed.join(' --only ')}` };
  if (canary) return canary;
  if (s.byState.unrendered.length) return { why: `${s.byState.unrendered.length} film${s.byState.unrendered.length === 1 ? '' : 's'} not rendered yet`, command: `node world quote ${id}   — then: node world render ${id}` };
  if (s.narrationNeeded.length) return { why: `narration for ${s.narrationNeeded.length} place${s.narrationNeeded.length === 1 ? '' : 's'} not recorded`, command: `node world narrate ${id}` };
  if (s.musicNeeded) return { why: 'the music is not made yet', command: `node world music ${id}` };
  if (s.figuresNeeded?.length) return { why: `${s.figuresNeeded.length} collectible${s.figuresNeeded.length === 1 ? ' has' : 's have'} no 3D figure yet`, command: `node world figures ${id} --cutouts   — look at the cut-outs, then: node world figures ${id}` };
  if (!s.built || s.buildStale) return { why: s.built ? 'the build is older than your latest decisions' : 'every film is approved', command: `node world build ${id}` };
  return { why: 'the world is built', command: `node world play ${id}   — then: node world export ${id}` };
}

/**
 * The same next step `node world next` prints, for any command's closing
 * hint, so no command suggests building or rendering the rest of the world
 * while the canary still waits.
 */
export function nextStep(id) {
  const next = nextAction(gather(id));
  return `${next.command}\n      (${next.why})`;
}

export async function run(argv) {
  const { values, world } = parse(argv, { json: { type: 'boolean' } });
  const worlds = listWorlds();
  const id = world ?? (worlds.length === 1 ? worlds[0] : null);
  if (!id) {
    log.info(worlds.length ? `Worlds: ${worlds.join(', ')}` : 'No worlds yet.');
    log.next(worlds.length ? `node world status <id>` : 'node world new <id>');
    return 0;
  }
  const s = gather(id);
  const next = nextAction(s);
  if (values.json) {
    console.log(JSON.stringify({ ...s, errors: s.errors?.length, warnings: s.warnings?.length, next }, null, 2));
    return 0;
  }
  if (!s.exists) {
    log.next(next.command);
    return 0;
  }
  log.title(`${s.title || id} — worlds/${id}`);
  log.info(`places      ${s.places} (${s.photos} photos${s.stillsMissing.length ? `, ${s.stillsMissing.length} without a still` : ''})`);
  log.info(`plan        ${s.planWritten ? 'written' : 'not written yet'}; ${s.errors.length} lint errors, ${s.warnings.length} warnings`);
  log.info(`outlines    ${s.selections.done} done, ${s.selections.needed.length} to make, ${s.selections.failed.length} failed`);
  const names = { approved: 'approved', unjudged: 'awaiting a verdict', rendering: 'rendering', rejected: 'rejected', failed: 'failed', unrendered: 'not rendered yet' };
  const states = Object.entries(s.byState).filter(([, list]) => list.length).map(([state, list]) => `${list.length} ${names[state]}`).join(', ');
  log.info(`films       ${s.films} planned${states ? `: ${states}` : ''}`);
  log.info(`takes       ${s.finishedTakes} finished${s.takes > s.finishedTakes ? `, ${s.takes - s.finishedTakes} in progress or failed` : ''}`);
  if (s.canary.state !== 'none') log.info(`canary      ${s.canary.ids.join(' + ')}: ${s.canary.state === 'approved' ? 'approved — the rest of the world can render' : s.canary.state}`);
  if (s.renderLock) log.info(`rendering   a render is running (pid ${s.renderLock.pid}, started ${s.renderLock.startedAt})`);
  if (s.unjudged.length) log.info(`to judge    ${s.unjudged.length} take${s.unjudged.length === 1 ? '' : 's'}`);
  for (const f of s.feedback) {
    log.info(`rejected    ${f.film} take ${f.take}${f.verdict ? `: "${f.verdict}"` : ''}`);
    for (const note of f.notes) log.dim(`              ${describeNote(note)}`);
  }
  if (s.stillNotes.length) {
    log.info(`pictures    ${s.stillNotes.length} area note${s.stillNotes.length === 1 ? '' : 's'} on stills`);
    for (const note of s.stillNotes) log.dim(`              ${note.place}: ${describeNote(note)}`);
  }
  const narrationState = !s.narratedPlaces ? 'none planned'
    : `${s.narratedPlaces - s.narrationNeeded.length} of ${s.narratedPlaces} place${s.narratedPlaces === 1 ? '' : 's'} recorded`;
  const musicState = !s.hasMusic ? 'none planned' : s.musicNeeded ? 'to make' : 'made';
  log.info(`audio       narration ${narrationState}; music ${musicState}`);
  log.info(`build       ${s.built ? (s.buildStale ? 'out of date' : `up to date (${shown(join(worldPaths(id).build, 'world.json'))})`) : 'not built'}`);
  log.next(`${next.command}\n      (${next.why})`);
  return 0;
}
