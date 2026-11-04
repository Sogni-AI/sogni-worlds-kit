#!/usr/bin/env node
// Runs `node <args>` (a test run) with a system temp folder of its own, then
// deletes that folder when the run passes, so no test can leave files behind in the shared one.
// Several test files made temporary folders they never removed (world-spend-,
// world-spend-accounting-, world-spending-sdk-, credit-): hundreds by 2026-11-04.
// TMPDIR is read by os.tmpdir() on every call and inherited by every child
// process, so commands a test spawns use the run's folder too.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sogni-world-tests-'));
// Ctrl-C reaches the test run too; the run stops, then this process decides what to keep.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {});
const result = spawnSync(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root }
});
if (result.error) throw result.error;
// A passing run leaves nothing worth keeping. A failed or stopped one keeps its files for inspection.
if (result.status === 0) rmSync(root, { recursive: true, force: true });
else process.stderr.write(`Kept this run's temp folder to inspect: ${root}\n`);
process.exit(result.status ?? 1);
