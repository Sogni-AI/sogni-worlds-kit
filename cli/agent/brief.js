// The director's brief: what the person told the agent, kept in
// worlds/<id>/brief.yaml so a run can stop and pick up again. The agent asks
// for anything missing (in the terminal), or reads it all from --brief for an
// unattended run. It never invents what only the person can say.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parse, stringify } from 'yaml';
import { PHOTO_EXTENSIONS, slug } from '../lib/stills.js';

export const briefFile = paths => join(paths.dir, 'brief.yaml');

export function readBrief(paths) {
  const file = briefFile(paths);
  return existsSync(file) ? parse(readFileSync(file, 'utf8')) ?? {} : null;
}

export function writeBrief(paths, brief) {
  mkdirSync(paths.dir, { recursive: true });
  writeFileSync(briefFile(paths), `# What the person told the agent. Edit freely; the agent re-reads it.\n${stringify(brief, { lineWidth: 0 })}`);
}

/** Load a brief file given on the command line; relative files in it resolve from its folder. */
export function loadBriefFile(path) {
  const full = resolve(path);
  const brief = parse(readFileSync(full, 'utf8')) ?? {};
  const base = resolve(full, '..');
  const fix = file => (file && !isAbsolute(file) ? resolve(base, file) : file);
  for (const photo of brief.photos ?? []) photo.file = fix(photo.file);
  for (const ref of brief.paint?.references ?? []) ref.file = fix(ref.file);
  if (brief.narration?.recording) brief.narration.recording = fix(brief.narration.recording);
  return brief;
}

/** What the agent still needs from the person, as questions. */
export function missingAnswers(brief) {
  const questions = [];
  if (!brief.about) questions.push(['about', 'What is this world about, in a sentence or two?']);
  if (!brief.photos?.length && !brief.paint?.concept) questions.push(['source', 'Do you have photographs (give the folder), or should the places be painted (describe the world you imagine)?']);
  if (brief.photos?.length && !brief.people) questions.push(['people', 'Who is in the photos, and how should the films treat anyone else in them (keep them as they are, keep them small in the background, or leave them out of the action)?']);
  if (!brief.narration) questions.push(['narration', 'Narration: none, or a designed voice (describe it)?']);
  if (brief.music === undefined) questions.push(['music', 'Music: none, or describe the mood?']);
  return questions;
}

/** Ask the person in the terminal. Returns the updated brief. */
export async function interview(brief) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (const [key, question] of missingAnswers(brief)) {
      const answer = (await rl.question(`\n${question}\n> `)).trim();
      if (key === 'source') {
        const folder = resolve(answer.replace(/^~(?=\/)/, process.env.HOME ?? '~'));
        if (existsSync(folder)) {
          const names = readdirSync(folder).filter(n => PHOTO_EXTENSIONS.includes(extname(n).toLowerCase())).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
          brief.photos = names.map(name => ({ file: join(folder, name), story: '' }));
          for (const photo of brief.photos) {
            photo.story = (await rl.question(`\n${basename(photo.file)}: where is this and what happened there?\n> `)).trim();
          }
        } else {
          brief.paint = { concept: answer, places: 3 };
        }
      } else if (key === 'narration') {
        brief.narration = /^none$/i.test(answer) ? { voice: 'none' } : { voice: 'design', description: answer };
      } else if (key === 'music') {
        brief.music = /^none$/i.test(answer) ? null : { mood: answer };
      } else {
        brief[key] = answer;
      }
    }
    return brief;
  } finally {
    rl.close();
  }
}

/** Ask one yes/no question; an unattended brief answers it from `approvals`. */
export async function confirm(brief, key, question) {
  const standing = brief.approvals?.[key];
  if (standing !== undefined) return standing === true || standing === 'yes' || standing === 'skip' || standing === 'drafts';
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y/i.test((await rl.question(`\n${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Copy the person's photos into photos/ named in story order, so the place
 * ids come out as the agent will refer to them. Never modifies the originals.
 */
export function placePhotos(paths, brief) {
  mkdirSync(paths.photos, { recursive: true });
  const placed = [];
  brief.photos.forEach((photo, index) => {
    if (!existsSync(photo.file)) throw new Error(`The brief names a photo that is not there: ${photo.file}`);
    const id = photo.id ?? slug(photo.file);
    const name = `${String(index + 1).padStart(2, '0')}-${id}${extname(photo.file).toLowerCase()}`;
    const target = join(paths.photos, name);
    if (!existsSync(target)) copyFileSync(photo.file, target);
    placed.push({ ...photo, id, name });
  });
  return placed;
}
