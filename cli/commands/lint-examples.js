import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument } from 'yaml';
import { EXAMPLES } from '../lib/paths.js';
import { lintPlan } from '../lib/lint.js';
import { report } from './lint.js';

export const summary = 'Lint the example plans in examples/ (run by npm run check)';
export const usage = 'node world lint-examples';

export async function run() {
  let errors = 0;
  for (const name of readdirSync(EXAMPLES).sort()) {
    const file = join(EXAMPLES, name, 'world.yaml');
    if (!existsSync(file)) continue;
    const plan = parseDocument(readFileSync(file, 'utf8')).toJS();
    plan.places ??= [];
    for (const place of plan.places) place.objects ??= [];
    plan.voices ??= {};
    plan.order ??= 'linear';
    // Examples ship without their photographs, so only the plan itself is checked.
    errors += report(lintPlan(plan, { dir: join(EXAMPLES, name) }, { checkFiles: false }), { title: `examples/${name}/world.yaml` });
  }
  return errors ? 1 : 0;
}
