import { parse } from '../index.js';
import { listWorlds } from '../lib/paths.js';
import { gather, nextAction } from './status.js';

export const summary = 'Print the one thing to do now (agents: run this after every step)';
export const usage = 'node world next [world] [--json]';

export async function run(argv) {
  const { values, world } = parse(argv, { json: { type: 'boolean' } });
  const worlds = listWorlds();
  const id = world ?? (worlds.length === 1 ? worlds[0] : null);
  const next = id
    ? nextAction(gather(id))
    : worlds.length
      ? { why: `there are ${worlds.length} worlds`, command: `node world next <id>   (one of: ${worlds.join(', ')})` }
      : { why: 'there is no world yet', command: 'node world doctor   — then: node world new <id>' };
  if (values.json) console.log(JSON.stringify(next));
  else console.log(`${next.command}\n(${next.why})`);
  return 0;
}
