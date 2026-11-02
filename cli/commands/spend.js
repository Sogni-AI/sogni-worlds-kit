import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from '../index.js';
import { resolveWorldId, worldPaths } from '../lib/paths.js';
import { connect } from '../lib/sogni.js';
import { clientSpending } from '../lib/spending.js';
import { importSpendingJournals, recordAttempt, recordCoverage, recordFunding, recordRefund, recordSelection, spendingReport } from '../lib/spending.js';

export const summary = 'Project lifetime spending: used clips, all attempts, credits and cash.';
export const usage = `node world spend [world] [--json]
  --project <directory>  An external/custom project's directory instead of a kit world.
  --record <file.json>   Import {type:"attempt"|"funding"|"refund"|"selection"|"coverage", data:{...}}.
  --import-journals     Import existing Kit media receipts locally, once.
  --reconcile <id>      One authenticated cost lookup for a known Sogni project; repeatable.
  --used <project-id>    Record a used clip; repeat for every clip in this selection.
  --selection <name>     Selection name (default: clips); replaces that selection.

Reports make no network calls. --reconcile is explicit and never polls. A funding
receipt needs kind credit|purchase, provider, currency, amount, cashUSD and a
stable reference. A credit may also declare creditValueUSD. A refunded charge
needs attemptId, reference, usd and tokens. See docs/project-spending.md.`;

export async function run(argv) {
  const { values, world } = parse(argv, { json: { type: 'boolean' }, project: { type: 'string' }, record: { type: 'string' }, 'import-journals': { type: 'boolean' }, reconcile: { type: 'string', multiple: true }, used: { type: 'string', multiple: true }, selection: { type: 'string' } });
  const dir = values.project ? resolve(values.project) : worldPaths(resolveWorldId(world)).dir;
  if (values['import-journals']) importSpendingJournals(dir);
  if (values.record) {
    const bytes = readFileSync(values.record);
    if (bytes.length > 64 * 1024) throw new Error('Import one small receipt at a time');
    const entries = JSON.parse(bytes);
    for (const entry of Array.isArray(entries) ? entries : [entries]) {
      if (entry.type === 'funding') recordFunding(dir, entry.data);
      else if (entry.type === 'refund') recordRefund(dir, entry.data);
      else if (entry.type === 'attempt') recordAttempt(dir, entry.data);
      else if (entry.type === 'selection') recordSelection(dir, entry.data.name, entry.data.projectIds, { unidentified: entry.data.unidentified ?? 0 });
      else if (entry.type === 'coverage') recordCoverage(dir, entry.data);
      else throw new Error('Receipt type must be attempt, funding, refund, selection or coverage');
    }
  }
  if (values.used) recordSelection(dir, values.selection ?? 'clips', values.used);
  if (values.reconcile) {
    const session = await connect({ worldDir: dir });
    try { for (const id of new Set(values.reconcile)) await clientSpending(session.client).readActual(id); }
    finally { session.close(); }
  }
  const report = spendingReport(dir);
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else {
    const money = value => { const [whole, fraction = ''] = value.split('.'); return `$${whole}.${fraction.padEnd(2, '0')}`; };
    const line = (name, t) => `${name}: ${money(t.usd)} settled usage; ${t.settled}/${t.attempts} charges confirmed${t.unknown ? `, ${t.unknown} unknown (not zero)` : ''}${t.estimates ? `; ${money(t.estimatedUSD)} quoted for ${t.estimates} unresolved attempt${t.estimates === 1 ? '' : 's'}` : ''}`;
    console.log(line('Project lifetime, all generation types', report.project));
    console.log(line('Used clips (full cost of each unique source attempt)', report.clips.used));
    console.log(line('All clips, including rerolls/failures', report.clips.allAttempts));
    for (const [name, t] of [['Project usage', report.project], ['Used clips', report.clips.used], ['All clips', report.clips.allAttempts]]) {
      for (const [currency, value] of Object.entries(t.currencies)) console.log(`  ${name} · ${currency}: ${value}`);
    }
    if (report.project.planValueUSD !== '0') console.log(`Covered by subscription: ${money(report.project.planValueUSD)} of plan value, excluded from usage charges.`);
    console.log(`Cash paid for funding: ${money(report.funding.cashUSD)}. Credits received: ${money(report.funding.creditValueUSD)} declared value${report.funding.creditsWithoutUSDValue ? `; ${report.funding.creditsWithoutUSDValue} receipts have no USD value` : ''}.`);
    for (const [currency, value] of Object.entries(report.funding.currencies)) console.log(`  ${currency}: ${value}`);
    console.log('Funding and usage are separate totals; they are never added together. Account balances are not project spending.');
    if (!report.coverage) console.log('Historical coverage has not been established; earlier charges or funding may be missing.');
    else console.log(`Coverage: tracked since ${report.coverage.trackedSince}. ${report.coverage.historicalCoverage}`);
    if (report.selectedProjectsWithoutReceipts.length) console.log(`Used clips missing receipts: ${report.selectedProjectsWithoutReceipts.join(', ')}`);
    if (report.selectedClipsWithoutProjectIds) console.log(`Used clips without project IDs: ${report.selectedClipsWithoutProjectIds}; their costs are unresolved.`);
    if (!Object.keys(report.selections).length && report.clips.allAttempts.attempts) console.log('Used clip selection has not been recorded yet; build the approved world or import its current selection.');
    console.log(`Ledger: ${report.file}`);
  }
  return 0;
}
