// Small file helpers shared by every command: hashes, atomic JSON, journals.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const sha256File = path => sha256(readFileSync(path));

export function readJson(path, fallback = undefined) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Write JSON so a crash never leaves half a file: write a temporary file,
 * flush it to disk, then rename it over the target. With `exclusive`, fail if
 * the target already exists — that is how a render reserves its take before
 * anything is paid for, so two runs can never submit the same take twice.
 */
export function writeJson(path, value, { exclusive = false } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const target = exclusive ? path : `${path}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(target, exclusive ? 'wx' : 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (!exclusive) renameSync(target, path);
}
