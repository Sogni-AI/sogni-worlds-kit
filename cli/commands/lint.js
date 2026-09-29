import { parse } from '../index.js';
import { resolveWorldId, shown } from '../lib/paths.js';
import { readPlan } from '../lib/plan.js';
import { lintPlan } from '../lib/lint.js';
import { log } from '../lib/log.js';
import { nextStep } from './status.js';

export const summary = 'Check world.yaml: structure, story links and every film direction against the H3 rules';
export const usage = 'node world lint [world] [--json]';

/** Print findings; returns the number of errors. */
export function report(findings, { title } = {}) {
  const errors = findings.filter(f => f.level === 'error');
  const warnings = findings.filter(f => f.level === 'warn');
  if (title) log.title(title);
  for (const finding of errors) log.fail(`${finding.where}: ${finding.message}`);
  for (const finding of warnings) log.warn(`${finding.where}: ${finding.message}`);
  if (!errors.length && !warnings.length) log.ok('No findings');
  else log.info(`${errors.length} error${errors.length === 1 ? '' : 's'}, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`);
  return errors.length;
}

export async function run(argv) {
  const { values, world } = parse(argv, { json: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const findings = lintPlan(plan, paths);
  if (values.json) {
    console.log(JSON.stringify({ errors: findings.filter(f => f.level === 'error').length, findings }, null, 2));
    return findings.some(f => f.level === 'error') ? 1 : 0;
  }
  const errors = report(findings, { title: `Linting ${shown(paths.plan)}` });
  if (errors) {
    log.next(`fix the ✗ items in ${shown(paths.plan)}, then: node world lint ${id}`);
    return 1;
  }
  log.next(nextStep(id));
  return 0;
}
