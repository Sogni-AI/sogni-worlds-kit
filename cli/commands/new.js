import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { ROOT, shown, worldPaths } from '../lib/paths.js';
import { log } from '../lib/log.js';

export const summary = 'Start a new world: worlds/<id>/ with an empty plan and a photos/ folder';
export const usage = 'node world new <id> [--title "The Long White Cloud"]';

export async function run(argv) {
  const { values, world: id } = parse(argv, { title: { type: 'string' } });
  if (!id) throw new Error(`Give the world an id. ${usage}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('A world id uses lower-case letters, digits and dashes, e.g. "my-trip"');
  const paths = worldPaths(id);
  if (existsSync(paths.plan)) throw new Error(`${shown(paths.plan)} already exists; nothing was changed`);

  for (const dir of [paths.dir, paths.photos, paths.voices, paths.music, paths.keyframes]) mkdirSync(dir, { recursive: true });
  const title = values.title ?? id.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  const template = readFileSync(join(ROOT, 'templates', 'world.yaml'), 'utf8');
  writeFileSync(paths.plan, template.replace('__ID__', id).replace('__TITLE__', JSON.stringify(title)));

  log.ok(`Created ${shown(paths.dir)}/`);
  log.info(`world.yaml   the plan (your agent fills it in)`);
  log.info(`photos/      put your full-size photographs here, in story order by file name`);
  log.info(`voices/      optional: a recording of your own voice, to narrate in it`);
  log.info(`music/       optional: music you have the rights to`);
  log.next(`copy your photos into ${shown(paths.photos)}/, then: node world ingest ${id}`);
  return 0;
}
