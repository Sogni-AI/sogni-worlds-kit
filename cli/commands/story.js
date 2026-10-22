import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan } from '../lib/plan.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { writeJson } from '../lib/files.js';
import { lintPlot } from '../lib/lint.js';
import { connect } from '../lib/sogni.js';
import { Llm, MODELS } from '../lib/llm.js';
import { critiqueStory, storyWords } from '../agent/story.js';

export const summary = 'Have a story editor (a Sogni LLM) read a fictional world\'s plot and every line in order, and say what does not work yet';
export const usage = `node world story [world]

  For a world with a plot (a story you made up: docs/writing-the-story.md). A
  Sogni LLM (${MODELS.writer}) reads the plot, then every caption, label, hint,
  narrated line, close-look line and ending in the order a visitor meets them,
  and judges the story as a demanding editor: its shape, its twists (planted or
  from nowhere), whether every click moves it on, beats said twice, names that
  change, endings that are not earned. Prints a verdict and the findings and
  writes review/story.json. Fix every "fix" in world.yaml before you spend on
  films, and run it again. It costs a fraction of a cent of LLM time.`;

export async function run(argv) {
  const { world } = parse(argv);
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  if (!plan.plot) {
    log.warn(`${id} has no plot. A story you make up gets one first (docs/writing-the-story.md); a world of your own photographs keeps the story you lived, and this check is not for it.`);
    return 1;
  }
  const broken = lintPlot(plan).filter(f => f.level === 'error');
  if (broken.length) {
    for (const f of broken) log.fail(`${f.where}: ${f.message}`);
    log.info(`Fix the plot's shape first (node world lint ${id}).`);
    return 1;
  }

  const session = await connect({ appId: `sogni-worlds-story-${Date.now()}` });
  const llm = new Llm({ client: session.client, billing: session.billing, logFile: join(paths.dir, 'agent', 'llm.jsonl') });
  let answer;
  try {
    log.title(`Reading "${plan.title ?? id}" as a story editor (${MODELS.writer})`);
    answer = await critiqueStory(llm, { plan, about: plan.story ?? null });
  } finally {
    session.close();
  }
  const out = join(paths.review, 'story.json');
  writeJson(out, { at: new Date().toISOString(), model: MODELS.writer, words: storyWords(plan), ...answer });
  const mark = { strong: log.ok, 'needs work': log.warn, weak: log.fail }[answer.verdict];
  mark(`The story: ${answer.verdict}. ${answer.summary}`);
  for (const f of answer.findings) (f.severity === 'fix' ? log.fail : log.warn)(`${f.where}: ${f.problem}\n    Fix: ${f.fix}`);
  const fixes = answer.findings.filter(f => f.severity === 'fix').length;
  log.info(`Report: ${shown(out)}. ${fixes ? `Rewrite the plot and the words for the ${fixes} "fix" finding${fixes === 1 ? '' : 's'} before you spend on films, then run this again.` : 'Nothing breaks the story; weigh the rest.'}`);
  log.dim(`${llm.totals.calls} LLM call(s), ${llm.totals.promptTokens + llm.totals.completionTokens} tokens`);
  return fixes ? 2 : 0;
}
