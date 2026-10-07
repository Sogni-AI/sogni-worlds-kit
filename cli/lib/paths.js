// Where everything lives. One world = one folder under worlds/<id>/.
import { existsSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const WORLDS = join(ROOT, 'worlds');
export const EXAMPLES = join(ROOT, 'examples');

/** Every path inside one world's folder. Only world.yaml is written by hand. */
export function worldPaths(id) {
  const dir = join(WORLDS, id);
  return {
    id,
    dir,
    plan: join(dir, 'world.yaml'),       // the plan: places, objects, films, voices, music
    photos: join(dir, 'photos'),         // your originals, never modified
    stills: join(dir, 'stills'),         // canonical stills made once by `ingest`, immutable
    keyframes: join(dir, 'keyframes'),   // optional extra stills pinned inside a film
    voices: join(dir, 'voices'),         // optional voice recordings you own, for cloning
    music: join(dir, 'music'),           // optional music you own
    selections: join(dir, 'selections'), // SAM 3 masks and traced outlines
    renders: join(dir, 'renders'),       // every take of every film, with its receipt
    audio: join(dir, 'audio'),           // narration and generated music, with receipts
    review: join(dir, 'review'),         // verdicts, notes, area notes and their marks/ pictures
    build: join(dir, 'build'),           // the finished world: world.json + media, ready to play
    cache: join(dir, '.cache'),          // derived scratch files, safe to delete
  };
}

export function listWorlds() {
  if (!existsSync(WORLDS)) return [];
  return readdirSync(WORLDS, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(WORLDS, entry.name, 'world.yaml')))
    .map(entry => entry.name)
    .sort();
}

/**
 * The world a command acts on: the id given, or the only world there is.
 * Commands take the id as their first positional argument.
 */
export function resolveWorldId(given) {
  const worlds = listWorlds();
  if (given) {
    if (!worlds.includes(given)) {
      throw new Error(`No world "${given}" in worlds/. ${worlds.length ? `Worlds here: ${worlds.join(', ')}` : 'Create one with: node world new <id>'}`);
    }
    return given;
  }
  if (worlds.length === 1) return worlds[0];
  if (worlds.length === 0) throw new Error('There is no world yet. Create one with: node world new <id>');
  throw new Error(`Say which world: ${worlds.join(', ')}`);
}

/** A path shown to people and agents: relative to the repo root when inside it, absolute otherwise. */
export const shown = path => {
  const rel = relative(ROOT, path);
  if (!rel) return '.';
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? resolve(path) : rel;
};

/**
 * Is a path from world.yaml a file inside the world's folder? A plan can come
 * from someone else, so a path must never reach outside it (an absolute path,
 * or one that climbs out with ..): the kit would read that file and upload it.
 */
export function isInsideWorld(worldDir, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || isAbsolute(relativePath)) return false;
  const rel = relative(worldDir, resolve(worldDir, relativePath));
  return Boolean(rel) && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** The absolute path of a file named in world.yaml; throws when it points outside the world. */
export function worldFile(paths, relativePath, what = 'a file') {
  if (!isInsideWorld(paths.dir, relativePath)) {
    throw new Error(`${what} "${relativePath}" is outside worlds/${paths.id}/: paths in world.yaml are relative to the world's folder (e.g. stills/harbour.jpg)`);
  }
  return resolve(paths.dir, relativePath);
}

/** The id of a film, derived from where it starts and what causes it. */
export const filmId = (placeId, objectId) => `${placeId}-${objectId}`;
export const loopId = placeId => `${placeId}-loop`;
