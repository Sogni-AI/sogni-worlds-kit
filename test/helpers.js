// Shared test helpers: throwaway world folders and tiny synthetic films.
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { worldPaths } from '../cli/lib/paths.js';
import { ffmpeg } from '../cli/lib/media.js';

// Throwaway folders are removed when the test file's process exits. They were never deleted: the delivery tests alone
// left 60 folders (2.4 GiB of films) in the system temp folder in a day, which helped fill a 3.6 TB disk on 2026-11-04.
const tempDirs = [];
process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
export const tempDir = prefix => {
  const dir = mkdtempSync(join(process.env.SOGNI_WORLD_TEST_TMP || tmpdir(), `sogni-world-${prefix}-`));
  tempDirs.push(dir);
  return dir;
};

/** The same layout as worlds/<id>/, rooted anywhere. */
export function pathsAt(dir, id = 'test') {
  const real = worldPaths(id);
  return Object.fromEntries(Object.entries(real).map(([key, value]) =>
    [key, key === 'id' ? id : value.startsWith(real.dir) ? join(dir, value.slice(real.dir.length)) : value]));
}

/** A small synthetic video with sound: `source` is an ffmpeg lavfi video graph. */
export async function syntheticVideo(path, { source, seconds, size = '192x128', tone = 440 }) {
  mkdirSync(dirname(path), { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', source.replace('SIZE', size), '-f', 'lavfi', '-i', `sine=f=${tone}:sample_rate=48000`,
    '-t', String(seconds), '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', path]);
}
