// screen: automatic checks on every new take, before anyone watches it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan, filmsOf, placeById } from '../lib/plan.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { writeJson, sha256File } from '../lib/files.js';
import { listTakes } from '../lib/takes.js';
import { contactSheet, screenTake } from '../lib/screen.js';

/** The opening strip: where the clicked thing has to move first. */
const OPENING_SECONDS = [0, 0.3, 0.6, 0.9, 1.3, 1.7, 2.2, 2.7];

export const summary = 'Check new takes for dissolves, cuts, bad endpoints, frozen tails and silence';
export const usage = `node world screen [world] [--only <film> ...] [--force]

  For every finished take that has not been screened: checks its size, frames
  and sound, whether it starts on its first still and lands on its last, and
  looks for the defects that get a film rejected on sight (a dissolve or
  crossfade, a hard cut, a structure break, a frozen tail, a flash at a loop's
  seam). A fast camera move is a "check" note, not a flag. Writes
  take-<n>.screen.json, a contact sheet take-<n>.sheet.jpg and a full-size
  frame for every flagged or noted moment. Then LOOK at them: screening cannot
  read lettering.`;

export async function run(argv) {
  const { values, world } = parse(argv, { only: { type: 'string', multiple: true }, force: { type: 'boolean', default: false } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const only = values.only?.length ? new Set(values.only) : null;
  const films = filmsOf(plan).filter(film => !only || only.has(film.id));
  if (only) for (const name of only) if (!films.some(film => film.id === name)) throw new Error(`No film "${name}" in the plan`);

  let screened = 0, flagged = 0;
  const toLook = [];
  for (const film of films) {
    for (const take of listTakes(paths, film.id)) {
      if (take.journal.status !== 'completed' || !existsSync(take.files.video)) continue;
      if (existsSync(take.files.screen) && !values.force) continue;
      if (take.verdict && !values.force) continue;
      const fromStill = stillOf(paths, plan, film.from);
      const toStill = stillOf(paths, plan, film.to);
      log.step(`Screening ${film.id} take ${take.take}`);
      const result = await screenTake({
        video: take.files.video,
        journal: { ...take.journal, kind: take.journal.kind ?? film.kind },
        fromStill, toStill,
        sheetPath: take.files.sheet,
        framesDir: join(paths.renders, film.id, `take-${take.take}.frames`),
      });
      // A crossing or moment has to start with what was clicked: its first seconds, densely, for looking at that.
      const opening = film.object ? join(paths.renders, film.id, `take-${take.take}.opening.jpg`) : null;
      if (opening) await contactSheet(take.files.video, opening, { frames: result.probe?.frames, at: OPENING_SECONDS.map(s => Math.round(s * (result.probe?.fps || 24))) });
      const sha = sha256File(take.files.video);
      if (take.journal.sha256 && sha !== take.journal.sha256) {
        result.flags.unshift({ code: 'changed', severity: 'error', message: 'The file no longer matches its render receipt (SHA-256)' });
      }
      writeJson(take.files.screen, { sha256: sha, screenedAt: new Date().toISOString(), probe: result.probe, flags: result.flags,
        metrics: result.metrics, sheet: `take-${take.take}.sheet.jpg`, frames: result.flaggedFrames.map(path => shown(path)) });
      screened++;
      const errors = result.flags.filter(f => f.severity === 'error');
      const warns = result.flags.filter(f => f.severity === 'warn');
      const notes = result.flags.filter(f => f.severity === 'note');
      if (!errors.length && !warns.length) log.ok(`${film.id} take ${take.take}: nothing flagged${notes.length ? `, ${notes.length} note(s)` : ''} (it still needs eyes)`);
      else {
        flagged++;
        (errors.length ? log.fail : log.warn)(`${film.id} take ${take.take}: ${errors.length + warns.length} flag(s)`);
      }
      for (const flag of [...errors, ...warns, ...notes]) log.info(`${{ error: 'ERROR', warn: 'look ', note: 'check' }[flag.severity]} ${flag.message}`);
      log.dim(`sheet ${shown(take.files.sheet)}${opening ? ` · opening ${shown(opening)}` : ''}${result.flaggedFrames.length ? ` · frames ${shown(join(paths.renders, film.id, `take-${take.take}.frames`))}/` : ''}`);
      toLook.push(`${film.id} ${take.take}`);
    }
  }

  if (!screened) {
    log.ok('Every finished take is already screened.');
    log.next(nextStep(id));
    return 0;
  }
  log.title(`${screened} take(s) screened, ${flagged} with something to look at`);
  log.info('Now look at every contact sheet, and every flagged frame at full size. Numbers only say where to look.');
  log.info('For a crossing or moment, the opening strip (take-<n>.opening.jpg, its first 2.7 s) shows whether the clicked thing moves first.');
  log.info('Reject on sight: a dissolve or crossfade, a morph, a hard cut, invented text or signs, a face that');
  log.info('changes, a camera that leaves the picture it should land on. Everything else goes to the review page.');
  log.info('Screening cannot read lettering: check every sign, patch, logo and number plate on the sheets yourself.');
  log.info(`  node world note ${id} <film> <take> "what you saw"      (shown to the reviewer)`);
  log.info(`  node world reject ${id} <film> <take> "why"             (the reviewer never sees it)`);
  log.next(nextStep(id));
  return 0;
}

function stillOf(paths, plan, placeId) {
  const place = placeById(plan, placeId);
  if (!place?.still) return null;
  const path = join(paths.dir, place.still);
  return existsSync(path) ? path : null;
}
