import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { greyFrames, analyseFrames, screenTake } from '../cli/lib/screen.js';
import { ffmpeg } from '../cli/lib/media.js';
import { tempDir, syntheticVideo } from './helpers.js';

const dir = tempDir('screen');
const codes = result => result.flags.map(flag => flag.code);

test('a smooth pan raises no cut or dissolve', async () => {
  const video = join(dir, 'pan.mp4');
  await syntheticVideo(video, { source: 'testsrc2=size=640x240:rate=24,crop=192:128:x=t*40:y=40', seconds: 6 });
  const result = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  assert.deepEqual(codes(result).filter(code => ['hard-cut', 'dissolve', 'structure-break'].includes(code)), []);
});

test('a hard cut is found at the cut', async () => {
  const video = join(dir, 'cut.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=192x128:rate=24', '-f', 'lavfi', '-i', 'mandelbrot=size=192x128:rate=24',
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-filter_complex',
    '[0:v]trim=0:3,setpts=PTS-STARTPTS[a];[1:v]trim=0:3,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]',
    '-map', '[v]', '-map', '2:a', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', video]);
  const result = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  const cut = result.flags.find(flag => flag.code === 'hard-cut');
  assert.ok(cut, 'hard cut flagged');
  assert.ok(Math.abs(cut.frame - 72) <= 1, `at frame ${cut.frame}`);
});

test('a crossfade between two pictures is flagged as a dissolve', async () => {
  const a = join(dir, 'a.png'), b = join(dir, 'b.png'), video = join(dir, 'fade.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x224466:size=192x128,drawbox=x=20:y=20:w=80:h=60:color=yellow:t=fill', '-frames:v', '1', a]);
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0xdd8833:size=192x128,drawgrid=w=24:h=24:t=3:c=white', '-frames:v', '1', b]);
  await ffmpeg(['-loop', '1', '-i', a, '-loop', '1', '-i', b, '-f', 'lavfi', '-i', 'sine=f=300:sample_rate=48000', '-filter_complex',
    '[0:v]fps=24,trim=0:3,setpts=PTS-STARTPTS[x];[1:v]fps=24,trim=0:3,setpts=PTS-STARTPTS[y];[x][y]xfade=transition=fade:duration=2:offset=0.5,format=yuv420p[v]',
    '-map', '[v]', '-map', '2:a', '-t', '2.5', '-c:v', 'libx264', '-c:a', 'aac', video]);
  const journal = { kind: 'crossing', width: 96, height: 64, frames: 60 };
  const result = await screenTake({ video, journal, fromStill: a, toStill: b, sheetPath: join(dir, 'fade.sheet.jpg'), framesDir: join(dir, 'fade.frames') });
  assert.ok(codes(result).includes('dissolve'), codes(result).join(', '));
  assert.ok(result.metrics.firstFrameMatch > 0.9 && result.metrics.lastFrameMatch > 0.9, 'lands on both stills');
  assert.ok(!codes(result).includes('size'), 'delivered at twice the canvas');
  assert.ok(result.flaggedFrames.length >= 1, 'flagged frames exported');
});
