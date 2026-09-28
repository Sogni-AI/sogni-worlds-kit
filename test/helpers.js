// Shared test helpers: throwaway world folders and tiny synthetic films.
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { worldPaths } from '../cli/lib/paths.js';
import { ffmpeg } from '../cli/lib/media.js';

export const tempDir = prefix => mkdtempSync(join(process.env.SOGNI_WORLD_TEST_TMP || tmpdir(), `sogni-world-${prefix}-`));

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
