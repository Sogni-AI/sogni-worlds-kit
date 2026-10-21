import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { greyFrames, analyseFrames, screenTake, cameraPath, cameraMoves, changeStretches, W, H } from '../cli/lib/screen.js';
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

// A textured strip panned fast: 300 px a second across a 192 px frame, the
// correlation between neighbouring thumbnails stays low for the whole film.
const strip = (pattern, speed) => `nullsrc=size=2100x160:rate=24,geq=lum='${pattern}':cb=128:cr=128,crop=192:128:x=t*${speed}:y=16`;
const TEXTURE_A = '128+50*sin(X/9)*cos(Y/7)+40*sin(X/31+Y/13)+25*cos(X/67)';
const TEXTURE_B = '128+60*cos(X/5+Y/3)*sin(Y/11)+30*sin(X/17)';

test('a fast pan is a "check" note, never a structure break or a cut', async () => {
  const video = join(dir, 'fast-pan.mp4');
  await syntheticVideo(video, { source: strip(TEXTURE_A, 300), seconds: 6 });
  const result = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  assert.deepEqual(codes(result).filter(code => ['hard-cut', 'structure-break'].includes(code)), []);
  const notes = result.flags.filter(flag => flag.code === 'fast-motion');
  assert.equal(notes.length, 1, codes(result).join(', '));
  assert.equal(notes[0].severity, 'note');
});

test('a cut hidden in a fast pan is still found', async () => {
  const video = join(dir, 'fast-cut.mp4');
  await ffmpeg(['-f', 'lavfi', '-i', strip(TEXTURE_A, 300), '-f', 'lavfi', '-i', strip(TEXTURE_B, 300),
    '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-filter_complex',
    '[0:v]trim=0:3,setpts=PTS-STARTPTS[a];[1:v]trim=3:6,setpts=PTS-STARTPTS[b];[a][b]concat=n=2:v=1[v]',
    '-map', '[v]', '-map', '2:a', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', video]);
  const result = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  const cut = result.flags.find(flag => ['hard-cut', 'structure-break'].includes(flag.code) && Math.abs(flag.frame - 72) <= 1);
  assert.ok(cut, codes(result).join(', '));
  assert.equal(cut.severity, 'warn');
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

test('a still living photograph is "barely moves", never a frozen tail', async () => {
  const video = join(dir, 'still-loop.mp4');
  await syntheticVideo(video, { source: 'color=c=0x335577:size=192x128:rate=24,drawbox=x=40:y=30:w=60:h=40:color=white:t=fill', seconds: 4 });
  const loop = analyseFrames(await greyFrames(video), { kind: 'loop' });
  assert.ok(codes(loop).includes('barely-moves'), codes(loop).join(', '));
  assert.ok(!codes(loop).includes('frozen-tail'));
  const crossing = analyseFrames(await greyFrames(video), { kind: 'crossing' });
  assert.ok(codes(crossing).includes('frozen-tail'), codes(crossing).join(', '));
});

test('a moment in which only a small light comes on and goes off is "little happens"; one where something moves is not', async () => {
  // A room with a small lamp that glows for a second and a half, then nothing; the camera never moves.
  const glow = join(dir, 'glow-moment.mp4');
  await syntheticVideo(glow, { source: "color=c=0x335577:size=192x128:rate=24,drawbox=x=40:y=30:w=60:h=40:color=white:t=fill,drawbox=x=150:y=90:w=12:h=12:color=orange:t=fill:enable='between(t,1,2.5)'", seconds: 6 });
  const quiet = analyseFrames(await greyFrames(glow), { kind: 'moment' });
  assert.ok(codes(quiet).includes('little-happens'), codes(quiet).join(', '));
  assert.ok(!codes(quiet).includes('frozen-tail'), 'the whole film is the problem, not its tail');
  // Something crosses the picture and leaves again.
  const event = join(dir, 'event-moment.mp4');
  await syntheticVideo(event, { source: "color=c=0x335577:size=SIZE:rate=24[bg];color=c=white:size=80x70:rate=24[box];[bg][box]overlay=x='-80+60*t':y=30:shortest=1", seconds: 6 });
  assert.ok(!codes(analyseFrames(await greyFrames(event), { kind: 'moment' })).includes('little-happens'));
});

test('a nearly inaudible take is flagged "quiet" (a silent one stays "silent")', async () => {
  const still = join(dir, 'q.png');
  await ffmpeg(['-f', 'lavfi', '-i', 'color=c=0x446688:size=192x128,drawbox=x=30:y=30:w=60:h=40:color=white:t=fill', '-frames:v', '1', still]);
  const clip = async (name, gain) => {
    const video = join(dir, `${name}.mp4`);
    await ffmpeg(['-loop', '1', '-i', still, '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-filter_complex', `[1:a]volume=${gain}[a]`,
      '-map', '0:v', '-map', '[a]', '-t', '3', '-r', '24', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', video]);
    return screenTake({ video, journal: { kind: 'loop', width: 96, height: 64, frames: 72 }, fromStill: still, toStill: still, sheetPath: join(dir, `${name}.sheet.jpg`), framesDir: join(dir, `${name}.frames`) });
  };
  // lavfi's sine starts at -18 dBFS: -25 dB more lands near -46 LUFS, -45 dB below the -50 silence line.
  const quiet = await clip('quiet', '-25dB');
  assert.ok(codes(quiet).includes('quiet'), `${codes(quiet)} at ${quiet.metrics.loudness?.lufs} LUFS`);
  assert.ok(codes(await clip('silent', '-45dB')).includes('silent'));
  assert.ok(!codes(await clip('normal', '0dB')).some(code => ['quiet', 'silent'].includes(code)));
});

// A textured still and the same still zoomed in about its centre and back out again (the
// dolly yo-yo of a loop that must land where it began), against one that never moves.
const STILL = `nullsrc=size=SIZE:rate=24,geq=lum='${TEXTURE_A}':cb=128:cr=128`;
test('a loop whose camera pushes in and back is flagged; a locked one and a brief wobble are not', async () => {
  const yoyo = join(dir, 'yoyo.mp4');
  // Zoom up to 15% and back over 6 s.
  await syntheticVideo(yoyo, { source: `${STILL.replace('SIZE', '384x256')},zoompan=z='1+0.15*sin(PI*on/144)':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=192x128:fps=24`, seconds: 6 });
  const moved = cameraMoves(cameraPath(await greyFrames(yoyo), await greyFrames(yoyo, W * 2, H * 2)));
  assert.deepEqual(moved.flags.map(f => f.code), ['camera-moves']);
  assert.match(moved.flags[0].message, /pushes in about 1[4-6]%/);
  assert.ok(moved.metrics.cameraZoom >= 0.13);

  const locked = join(dir, 'locked.mp4');
  await syntheticVideo(locked, { source: STILL, seconds: 6 });
  assert.deepEqual(cameraMoves(cameraPath(await greyFrames(locked), await greyFrames(locked, W * 2, H * 2))).flags, []);

  // Darkness and a figure crossing close to the lens match nothing well: never read as a push-in or a slide.
  const dark = join(dir, 'lights-out.mp4');
  await syntheticVideo(dark, { source: `${STILL.replace('SIZE', '192x128')},geq=lum='if(between(T,2,3.5),12,lum(X,Y))':cb=128:cr=128`, seconds: 6 });
  const darkPath = cameraPath(await greyFrames(dark), await greyFrames(dark, W * 2, H * 2));
  assert.ok(darkPath.every(p => p.unsure || (p.zoom === 0 && p.shift === 0)), 'no move measured in the dark');
  const passer = join(dir, 'passer.mp4');
  await syntheticVideo(passer, { source: `${STILL.replace('SIZE', '192x128')}[bg];nullsrc=size=150x128:rate=24,geq=lum='60+60*sin(X/3)':cb=128:cr=128[fg];[bg][fg]overlay=x='-150+t*60':y=0`, seconds: 6 });
  const passed = cameraMoves(cameraPath(await greyFrames(passer), await greyFrames(passer, W * 2, H * 2)));
  assert.ok(!passed.flags.some(f => /pushes in|pulls back|slides/.test(f.message)), passed.flags.map(f => f.message).join(' | '));

  // One sample off (a wobble) is not a move: a move lasts a second.
  const path = Array.from({ length: 20 }, (_, i) => ({ frame: (i + 1) * 6, zoom: i === 9 ? 0.07 : 0, shift: 0, r: 0.9 }));
  assert.deepEqual(cameraMoves(path).flags, []);
  // A slide held for a second is a move too.
  const slide = path.map(p => ({ ...p, zoom: 0, shift: 0.08 }));
  assert.equal(cameraMoves(slide).flags.length, 1);
});

test('the change strips centre on where a picture turns into another', async () => {
  const video = join(dir, 'turn.mp4');
  // Three seconds of one texture, then a half-second crossfade into another.
  await ffmpeg(['-f', 'lavfi', '-i', strip(TEXTURE_A, 0), '-f', 'lavfi', '-i', strip(TEXTURE_B, 0), '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000',
    '-filter_complex', '[0:v]trim=0:3.5,setpts=PTS-STARTPTS[a];[1:v]trim=0:3,setpts=PTS-STARTPTS[b];[a][b]xfade=transition=fade:duration=0.5:offset=3[v]',
    '-map', '[v]', '-map', '2:a', '-t', '6', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', video]);
  const [first] = changeStretches(await greyFrames(video));
  assert.ok(first && first.frame >= 70 && first.frame <= 86, `centred on the crossfade (frame ${first?.frame})`);
});
