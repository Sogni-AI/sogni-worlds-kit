// A running render leaves renders/.render.lock (its pid and when it started),
// so `next` and `status` can say "wait for it" instead of suggesting another
// render, and a second render of the same world refuses to start beside it.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const lockFile = paths => join(paths.renders, '.render.lock');

/** Is a process with this pid alive? (EPERM means it is, but not ours.) */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** The running render's lock, or null when there is none or its process is gone. */
export function readRenderLock(paths, alive = isAlive) {
  const file = lockFile(paths);
  if (!existsSync(file)) return null;
  let lock;
  try {
    lock = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  return alive(lock?.pid) ? lock : null;
}

/**
 * Take the lock for this process, or throw if another live render holds it.
 * Returns a function that releases it (also released when the process exits).
 */
export function acquireRenderLock(paths, films, alive = isAlive) {
  const held = readRenderLock(paths, alive);
  if (held && held.pid !== process.pid) {
    throw new Error(`A render of this world is already running (pid ${held.pid}, started ${held.startedAt}). Wait for it to finish; run this again afterwards if anything is left`);
  }
  mkdirSync(paths.renders, { recursive: true });
  const file = lockFile(paths);
  writeFileSync(file, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), films }, null, 2)}\n`);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    process.off('exit', release);
    try {
      const current = JSON.parse(readFileSync(file, 'utf8'));
      if (current.pid === process.pid) rmSync(file, { force: true });
    } catch { /* already gone */ }
  };
  process.on('exit', release);
  return release;
}
