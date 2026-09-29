import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { acquireRenderLock, lockFile, readRenderLock } from '../cli/lib/renderlock.js';
import { tempDir, pathsAt } from './helpers.js';

test('a render holds the lock while it runs and removes it when done', () => {
  const paths = pathsAt(tempDir('lock'));
  const release = acquireRenderLock(paths, ['a-door']);
  const lock = JSON.parse(readFileSync(lockFile(paths), 'utf8'));
  assert.equal(lock.pid, process.pid);
  assert.deepEqual(lock.films, ['a-door']);
  assert.ok(!Number.isNaN(Date.parse(lock.startedAt)));
  assert.equal(readRenderLock(paths)?.pid, process.pid);
  release();
  assert.ok(!existsSync(lockFile(paths)));
  assert.equal(readRenderLock(paths), null);
});

test('a lock left by a process that is gone is ignored', () => {
  const paths = pathsAt(tempDir('lock'));
  mkdirSync(paths.renders, { recursive: true });
  writeFileSync(lockFile(paths), JSON.stringify({ pid: 999999, startedAt: '2026-09-29T08:00:00.000Z' }));
  assert.equal(readRenderLock(paths, () => false), null);
  const release = acquireRenderLock(paths, [], () => false);
  assert.equal(JSON.parse(readFileSync(lockFile(paths), 'utf8')).pid, process.pid);
  release();
});

test('a second render refuses to start beside a live one, and never removes its lock', () => {
  const paths = pathsAt(tempDir('lock'));
  mkdirSync(paths.renders, { recursive: true });
  writeFileSync(lockFile(paths), JSON.stringify({ pid: 4242, startedAt: '2026-09-29T08:00:00.000Z' }));
  const alive = pid => pid === 4242;
  assert.equal(readRenderLock(paths, alive)?.pid, 4242);
  assert.throws(() => acquireRenderLock(paths, [], alive), /already running \(pid 4242, started 2026-09-29T08:00:00.000Z\)/);
  assert.equal(JSON.parse(readFileSync(lockFile(paths), 'utf8')).pid, 4242);
});
