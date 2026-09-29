// screen: automatic checks on every new take, before anyone watches it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan, filmsOf, placeById } from '../lib/plan.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { writeJson, sha256File } from '../lib/files.js';
import { listTakes } from '../lib/takes.js';
import { screenTake } from '../lib/screen.js';

export const summary = 'Check new takes for dissolves, cuts, bad endpoints, frozen tails and silence';
export const usage = `node world screen [world] [--only <film> ...] [--force]

  For every finished take that has not been screened: checks its size, frames
  and sound, whether it starts on its first still and lands on its last, and
  looks for the defects that get a film rejected on sight (a dissolve or
  crossfade, a hard cut, a structure break, a frozen tail, a flash at a loop's
  seam). Writes take-<n>.screen.json, a contact sheet take-<n>.sheet.jpg and a
  full-size frame for every flagged moment. Then LOOK at them.`;

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
      const sha = sha256File(take.files.video);
      if (take.journal.sha256 && sha !== take.journal.sha256) {
        result.flags.unshift({ code: 'changed', severity: 'error', message: 'The file no longer matches its render receipt (SHA-256)' });
      }
      writeJson(take.files.screen, { sha256: sha, screenedAt: new Date().toISOString(), probe: result.probe, flags: result.flags,
        metrics: result.metrics, sheet: `take-${take.take}.sheet.jpg`, frames: result.flaggedFrames.map(path => shown(path)) });
      screened++;
      const errors = result.flags.filter(f => f.severity === 'error');
      const warns = result.flags.filter(f => f.severity === 'warn');
      if (!result.flags.length) log.ok(`${film.id} take ${take.take}: nothing flagged (it still needs eyes)`);
      else {
        flagged++;
        (errors.length ? log.fail : log.warn)(`${film.id} take ${take.take}: ${result.flags.length} flag(s)`);
        for (const flag of [...errors, ...warns]) log.info(`${flag.severity === 'error' ? 'ERROR' : 'look '} ${flag.message}`);
      }
      log.dim(`sheet ${shown(take.files.sheet)}${result.flaggedFrames.length ? ` · frames ${shown(join(paths.renders, film.id, `take-${take.take}.frames`))}/` : ''}`);
      toLook.push(`${film.id} ${take.take}`);
    }
  }

  if (!screened) {
    log.ok('Every finished take is already screened.');
    log.next(`node world next ${id}`);
    return 0;
  }
  log.title(`${screened} take(s) screened, ${flagged} with something to look at`);
  log.info('Now look at every contact sheet, and every flagged frame at full size. Numbers only say where to look.');
  log.info('Reject on sight: a dissolve or crossfade, a morph, a hard cut, invented text or signs, a face that');
  log.info('changes, a camera that leaves the picture it should land on. Everything else goes to the review page.');
  log.info(`  node world note ${id} <film> <take> "what you saw"      (shown to the reviewer)`);
  log.info(`  node world reject ${id} <film> <take> "why"             (the reviewer never sees it)`);
  log.next(`node world review ${id}`);
  return 0;
}

function stillOf(paths, plan, placeId) {
  const place = placeById(plan, placeId);
  if (!place?.still) return null;
  const path = join(paths.dir, place.still);
  return existsSync(path) ? path : null;
}
