// A served film's last frame is encoded as sharply as the rest: encodeFilm feeds x264 a held second after the film,
// forces an IDR on the last real frame and cuts the tail off again by stream copy, proving the cut every time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ffmpeg, run, FFMPEG, FFPROBE, probe } from '../cli/lib/media.js';
import { finishFilm, rewindFilm } from '../cli/lib/finish.js';
import { assertKeptFrames, bitrateProfile, encodeFilm, filmIssues, LOSSLESS, vbvLowest } from '../cli/lib/delivery.js';
import { tempDir } from './helpers.js';

const keyFlags = async path => (await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', path]))
  .toString('utf8').split('\n').filter(Boolean).map(line => line.includes('K'));
const audioHash = async path => (await run(FFMPEG, ['-v', 'error', '-i', path, '-map', '0:a', '-c', 'copy', '-f', 'streamhash', '-hash', 'sha256', '-'])).toString('utf8');

/**
 * 61 frames with a hard cut at frame 30, so x264 puts a scene-cut keyframe there and the 2 s grid no longer lands on
 * the last frame: the case a held tail alone cannot cut cleanly.
 */
async function sceneCut(path, { codec = LOSSLESS, size = '384x256' } = {}) {
  await ffmpeg(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=24:duration=1.25`, '-f', 'lavfi', '-i', `mandelbrot=size=${size}:rate=24`,
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2.55',
    '-filter_complex', '[1:v]trim=end_frame=31,setpts=PTS-STARTPTS[b];[0:v][b]concat=n=2:v=1:a=0,format=yuv420p[v]', '-map', '[v]', '-map', '2:a',
    ...codec, '-c:a', 'aac', path]);
  return path;
}

test('the buffer model: a film at the cap keeps its buffer, a burst past cap and buffer empties it', () => {
  const profile = bitrateProfile(1920, 1080);
  assert.ok(vbvLowest(Array(240).fill(profile.maxrate / 24), profile, 24) > 0);
  assert.ok(vbvLowest([profile.bufsize * 0.95, ...Array(23).fill(profile.maxrate / 24)], profile, 24) < 0);
});

test('the cut proof refuses kept frames that are not exactly the padded encode\'s first frames', () => {
  assert.doesNotThrow(() => assertKeptFrames(['a', 'b'], ['a', 'b', 'b', 'b'], 2));
  assert.throws(() => assertKeptFrames(['a', 'x'], ['a', 'b', 'b'], 2), /kept frame 1 differs/);
  assert.throws(() => assertKeptFrames(['a'], ['a', 'b', 'b'], 2), /kept 1 frames, not 2/);
  assert.throws(() => assertKeptFrames(['a', 'b'], ['a', 'b'], 2), /no held tail/);
});

test('encodeFilm ends any film on a keyframe at its own length, off the 2 s grid too, with the sound copied', async () => {
  const dir = tempDir('last-frame');
  const master = await sceneCut(join(dir, 'master.mp4'));
  for (const [name, width, height] of [['film.mp4', 384, 256], ['film-720.mp4', 192, 128]]) {
    const out = join(dir, name);
    const result = await encodeFilm(master, out, { width, height, fps: 24 });
    const keys = await keyFlags(out);
    assert.equal(keys.length, 61, name);
    assert.equal(keys.at(-1), true, `${name} ends on a keyframe`);
    assert.ok(keys.slice(1, -1).some(Boolean), `${name} keeps its scene-cut keyframe, off the 2 s grid`);
    assert.equal(await audioHash(out), await audioHash(master), `${name} carries the master's sound as it is`);
    assert.equal(result.frames, 61);
    assert.ok(result.bufferLowestBits >= 0);
    assert.deepEqual(await filmIssues(out, name), []);
  }
  assert.deepEqual(readdirSync(dir).filter(name => name.startsWith('.')), [], 'no padded or cut encodes left behind');
});

test('finished films, their phone copies and their rewinds all end on a keyframe; no lossless master is left behind', async () => {
  const dir = tempDir('last-frame-finish');
  const take = await sceneCut(join(dir, 'take.mp4'), { codec: ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18'] });
  const films = join(dir, 'films');
  const main = join(films, 'main.mp4'), half = join(films, 'main-720.mp4'), back = join(films, 'back.mp4'), back720 = join(films, 'back-720.mp4');
  const info = await finishFilm(take, main, half);
  await rewindFilm(main, back, back720);
  for (const file of [main, half, back, back720]) {
    const keys = await keyFlags(file);
    assert.equal(keys.length, info.frames, file);
    assert.equal(keys.at(-1), true, `${file} ends on a keyframe`);
    assert.deepEqual(await filmIssues(file, file), []);
  }
  assert.equal((await probe(half)).width, 192);
  assert.deepEqual(readdirSync(films).sort(), ['back-720.mp4', 'back.mp4', 'main-720.mp4', 'main.mp4']);
});
