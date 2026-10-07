// The state of every film: its takes, what screening found, and what you decided.
//
//   renders/<film>/take-<n>.json         render journal + receipt (written before anything is paid for)
//   renders/<film>/take-<n>.mp4          the film exactly as Sogni returned it
//   renders/<film>/take-<n>.screen.json  automatic checks (`screen`)
//   renders/<film>/take-<n>.sheet.jpg    contact sheet for looking at it quickly
//   review/verdicts.json                 { <sha256>: { film, take, verdict, note, by, at } }
//   review/notes.json                    { <sha256>: [{ by, text, at, time?, box?, image? }] }
//   review/still-notes.json              { <place>: [{ by, text, at, box, image }] }
//   review/marks/<film|place>-…-<n>.jpg  an area note drawn on its frame, for agents to open
//
// An area note ("mark") is a note with a `box` [x, y, w, h] in 0–1 fractions of
// the picture and, on a take, the `time` in seconds it was drawn at.
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

export const stillNotesFile = paths => join(paths.review, 'still-notes.json');
export const readStillNotes = paths => readJson(stillNotesFile(paths), {});
export const marksDir = paths => join(paths.review, 'marks');

/** Add a note to a take. `extra` carries an area note's { time, box, image }. Returns the note. */
export function addNote(paths, sha, by, text, extra = {}) {
  const notes = readNotes(paths);
  const note = { by, text, at: new Date().toISOString(), ...extra };
  (notes[sha] ??= []).push(note);
  writeJson(notesFile(paths), notes);
  return note;
}

/** Add an area note to a place's still. Returns the note. */
export function addStillNote(paths, place, by, text, extra = {}) {
  const notes = readStillNotes(paths);
  const note = { by, text, at: new Date().toISOString(), ...extra };
  (notes[place] ??= []).push(note);
  writeJson(stillNotesFile(paths), notes);
  return note;
}

/** A valid area box: [x, y, w, h], each a 0–1 fraction, with some size. Returns it rounded, or null. */
export function normalBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || !box.every(n => typeof n === 'number' && Number.isFinite(n))) return null;
  let [x, y, w, h] = box;
  x = Math.min(1, Math.max(0, x)); y = Math.min(1, Math.max(0, y));
  w = Math.min(1 - x, Math.max(0, w)); h = Math.min(1 - y, Math.max(0, h));
  if (w < 0.005 || h < 0.005) return null;
  return [x, y, w, h].map(n => Math.round(n * 10000) / 10000);
}

/** One note as a line for the terminal: who, when and where, then the words. */
export function describeNote(note) {
  const where = [
    note.time !== undefined && note.time !== null ? `at ${Number(note.time).toFixed(1)} s` : null,
    note.box ? `area x ${note.box[0]}, y ${note.box[1]}, w ${note.box[2]}, h ${note.box[3]}` : null,
  ].filter(Boolean).join(', ');
  return `${note.by}${where ? ` (${where})` : ''}: ${note.text}${note.image ? `  → ${note.image}` : ''}`;
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
