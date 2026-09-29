// reject: the agent turns down a take that is clearly broken, so the person
// reviewing never has to watch it. Agents can reject; only a person approves,
// on the review page.
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId } from '../lib/paths.js';
import { listTakes, recordVerdict } from '../lib/takes.js';

export const summary = 'Turn down a clearly broken take before the reviewer sees it';
export const usage = `node world reject [world] <film> <take> "reason"

  For takes with a defect nobody should have to watch: a dissolve or crossfade,
  a morph, a hard cut, invented text, a face that changes. Say what and when:
    node world reject harbour-ferry 1 "Crossfades into the beach at 4-6 s"
  Then fix the direction in world.yaml (a new seed alone rarely fixes a
  repeated defect) and render the film again.`;

export async function run(argv) {
  const { positionals } = parse(argv);
  const { world, film, take, text } = takeArgs(positionals, 'reject');
  const id = resolveWorldId(world);
  const { paths } = readPlan(id);
  const found = findTake(paths, film, take);
  if (found.verdict?.by === 'you') {
    throw new Error(`${film} take ${take} was already judged by you (${found.verdict.verdict}); an agent does not overrule that`);
  }
  recordVerdict(paths, found.sha, { film, take, verdict: 'rejected', note: text, by: 'agent' });
  log.ok(`Rejected ${film} take ${take}: ${text}`);
  log.info('Fix the direction in world.yaml for the defect you saw, then render it again.');
  log.next(nextStep(id));
  return 0;
}

/** [world] <film> <take> "text" */
export function takeArgs(positionals, verb) {
  const args = [...positionals];
  if (args.length === 4) {
    const [world, film, take, text] = args;
    return { world, film, take: Number(take), text: text.trim() };
  }
  if (args.length === 3) {
    const [film, take, text] = args;
    return { world: undefined, film, take: Number(take), text: text.trim() };
  }
  throw new Error(`Usage: node world ${verb} [world] <film> <take> "${verb === 'reject' ? 'reason' : 'text'}"`);
}

export function findTake(paths, film, take) {
  if (!Number.isInteger(take) || take < 1) throw new Error('The take is a number, e.g. 2');
  const takes = listTakes(paths, film);
  if (!takes.length) throw new Error(`No takes of "${film}" yet`);
  const found = takes.find(t => t.take === take);
  if (!found) throw new Error(`${film} has takes ${takes.map(t => t.take).join(', ')}, not ${take}`);
  if (found.journal.status !== 'completed' || !found.sha) throw new Error(`${film} take ${take} has not finished rendering`);
  return found;
}
