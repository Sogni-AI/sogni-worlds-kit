// The state of every film: its takes, what screening found, and what you decided.
//
//   renders/<film>/take-<n>.json         render journal + receipt (written before anything is paid for)
//   renders/<film>/take-<n>.mp4          the film exactly as Sogni returned it
//   renders/<film>/take-<n>.screen.json  automatic checks (`screen`)
//   renders/<film>/take-<n>.sheet.jpg    contact sheet for looking at it quickly
//   review/verdicts.json                 { <sha256>: { film, take, verdict, note, by, at } }
//   review/notes.json                    { <sha256>: [{ by, text, at }] }
//
// Verdicts are pinned to the exact file (its SHA-256), never to a name, so a
// re-rendered file can never inherit an approval it did not earn.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, writeJson } from './files.js';

export const VERDICTS = ['approved', 'rejected', 'passed'];

export const takeFiles = (paths, film, take) => {
  const base = join(paths.renders, film, `take-${take}`);
  return { journal: `${base}.json`, video: `${base}.mp4`, screen: `${base}.screen.json`, sheet: `${base}.sheet.jpg` };
};

export const verdictsFile = paths => join(paths.review, 'verdicts.json');
export const notesFile = paths => join(paths.review, 'notes.json');
export const readVerdicts = paths => readJson(verdictsFile(paths), {});
export const readNotes = paths => readJson(notesFile(paths), {});

export function recordVerdict(paths, sha, entry) {
  if (!VERDICTS.includes(entry.verdict)) throw new Error(`Verdict must be one of ${VERDICTS.join(', ')}`);
  const verdicts = readVerdicts(paths);
  verdicts[sha] = { ...entry, at: new Date().toISOString() };
  writeJson(verdictsFile(paths), verdicts);
}

export function addNote(paths, sha, by, text) {
  const notes = readNotes(paths);
  (notes[sha] ??= []).push({ by, text, at: new Date().toISOString() });
  writeJson(notesFile(paths), notes);
}

/** Every take of one film, oldest first, with its receipt, checks and verdict. */
export function listTakes(paths, film, verdicts = readVerdicts(paths), notes = readNotes(paths)) {
  const dir = join(paths.renders, film);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map(name => /^take-(\d+)\.json$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number)
    .sort((a, b) => a - b)
    .map(take => {
      const files = takeFiles(paths, film, take);
      const journal = readJson(files.journal);
      const screen = existsSync(files.screen) ? readJson(files.screen) : null;
      const sha = journal.sha256 ?? null;
      return {
        film,
        take,
        files,
        journal,
        screen,
        sha,
        verdict: sha ? verdicts[sha] ?? null : null,
        notes: sha ? notes[sha] ?? [] : [],
      };
    });
}

/** The next take number for a film. */
export const nextTake = takes => (takes.at(-1)?.take ?? 0) + 1;

/**
 * Where a film stands, from the latest decision backwards:
 *   approved    a take was approved (the newest approved take is used)
 *   unjudged    a finished take awaits a verdict (screened or not)
 *   rendering   a take was submitted and has not finished
 *   failed      the newest take failed and nothing better exists
 *   rejected    every finished take was rejected: rewrite the direction, then render again
 *   unrendered  no take yet
 */
export function filmState(takes) {
  if (takes.some(t => t.verdict?.verdict === 'approved')) return 'approved';
  if (takes.some(t => t.journal.status === 'completed' && !t.verdict)) return 'unjudged';
  if (takes.some(t => ['submitting', 'submitted'].includes(t.journal.status))) return 'rendering';
  const latest = takes.at(-1);
  if (!latest) return 'unrendered';
  if (latest.journal.status === 'failed') return 'failed';
  return 'rejected';
}

/** The take a build uses: the newest approved one. */
export const approvedTake = takes => takes.filter(t => t.verdict?.verdict === 'approved').at(-1) ?? null;
