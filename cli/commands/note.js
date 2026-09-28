// note: what the agent saw in a take, shown beside it on the review page.
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId } from '../lib/paths.js';
import { addNote } from '../lib/takes.js';
import { findTake, takeArgs } from './reject.js';

export const summary = 'Leave a note on a take for the reviewer (what you saw, where to look)';
export const usage = `node world note [world] <film> <take> "text"

  Example: node world note harbour-ferry 2 "Clean crossing; the flag on the mast flickers at 6.5 s."`;

export async function run(argv) {
  const { positionals } = parse(argv);
  const { world, film, take, text } = takeArgs(positionals, 'note');
  const id = resolveWorldId(world);
  const { paths } = readPlan(id);
  const found = findTake(paths, film, take);
  addNote(paths, found.sha, 'agent', text);
  log.ok(`Noted on ${film} take ${take}.`);
  return 0;
}
