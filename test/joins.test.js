import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { joinsReport, joinsOf } from '../cli/lib/joins.js';
import { sheetFrames } from '../cli/lib/screen.js';
import { ffmpeg } from '../cli/lib/media.js';
import { tempDir } from './helpers.js';

const dir = tempDir('joins');

// Three 2-second shots cut together: a test pattern, a fractal, a coloured gradient.
async function threeShots(path) {
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=192x128:rate=24', '-f', 'lavfi', '-i', 'mandelbrot=size=192x128:rate=24',
    '-f', 'lavfi', '-i', 'gradients=size=192x128:rate=24:speed=0.05', '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-filter_complex',
    '[0:v]trim=0:2,setpts=PTS-STARTPTS[a];[1:v]trim=0:2,setpts=PTS-STARTPTS[b];[2:v]trim=0:2,setpts=PTS-STARTPTS[c];[a][b][c]concat=n=3:v=1[v]',
    '-map', '[v]', '-map', '3:a', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', path]);
}

test('every cut of a stitched film is found, shown on both sides, and every shot gets a sheet', async () => {
  const video = join(dir, 'three.mp4');
  await threeShots(video);
  const out = join(dir, 'three.joins');
  const report = await joinsReport(video, { out });
  assert.deepEqual(report.cuts.map(c => c.frame).map(f => Math.round(f / 24)), [2, 4], `cuts at ${report.cuts.map(c => c.frame)}`);
  assert.equal(report.shots.length, 3);
  for (const path of [...report.sheets, ...report.shots.map(s => s.sheet), ...report.fullFrames]) assert.ok(existsSync(path), path);
  const meta = await sharp(report.sheets[0]).metadata();
  assert.equal(meta.height, 2 * 128 * 480 / 192, 'one row per cut');
  assert.ok(meta.width > 6 * 480, 'six frames per row, with a divider');
  const full = await sharp(report.fullFrames[0]).metadata();
  assert.equal(full.width, 192, 'the frames either side of a cut are full size');
  assert.ok(JSON.parse(readFileSync(join(out, 'joins.json'), 'utf8')).cuts.length === 2);
});

test('given cut times replace detection', async () => {
  const video = join(dir, 'three.mp4');
  const report = await joinsReport(video, { out: join(dir, 'three.given'), at: [3] });
  assert.deepEqual(report.cuts.map(c => c.frame), [72]);
  assert.equal(report.shots.length, 2);
});

test('jumps a few frames apart (a flash) are one join', () => {
  assert.deepEqual(joinsOf([10, 40, 41, 42, 43, 90]), [{ from: 10, to: 10 }, { from: 40, to: 43 }, { from: 90, to: 90 }]);
});

test('a take is judged from at least 24 frames, three a second when longer', () => {
  assert.equal(sheetFrames(121).length, 24);
  assert.equal(sheetFrames(241).length, 31);
  assert.equal(sheetFrames(10).length, 10);
  assert.ok(sheetFrames(5000).length <= 72);
  const picks = sheetFrames(121);
  assert.equal(picks[0], 0); assert.equal(picks.at(-1), 120);
});
