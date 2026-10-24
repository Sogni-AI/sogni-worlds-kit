import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { pushInIssues, pushInRegion, pushInStart, pushInView } from '../cli/lib/pushin.js';
import { finishFilm } from '../cli/lib/finish.js';
import { finishingOf } from '../cli/commands/build.js';
import { takeSpec } from '../cli/commands/render.js';
import { ffmpeg, probe } from '../cli/lib/media.js';
import { correlation, greyFrames, mad } from '../cli/lib/screen.js';
import { tempDir, pathsAt } from './helpers.js';

test('a push-in lands on 1/zoom of the picture centred on its point, kept inside the picture', () => {
  assert.deepEqual(pushInRegion(2000, 1000, { at: [0.5, 0.5], zoom: 2 }), { left: 500, top: 250, width: 1000, height: 500 });
  assert.deepEqual(pushInRegion(2000, 1000, { at: [0.05, 0.95], zoom: 2 }), { left: 0, top: 500, width: 1000, height: 500 }, 'a point by the edge');
  const region = pushInRegion(2000, 1000, { at: [0.2, 0.3], zoom: 2.5 });
  assert.deepEqual(pushInView(2000, 1000, region, 0, 18), { left: 0, top: 0, width: 2000, height: 1000 }, 'it starts on the whole still');
  // Every step keeps the crop inside the view and moves monotonically towards it, arriving on it.
  let last = pushInView(2000, 1000, region, 0, 18);
  for (let k = 1; k <= 18; k++) {
    const view = pushInView(2000, 1000, region, k, 18);
    assert.ok(view.width < last.width && view.left <= region.left + 1e-9 && view.left + view.width >= region.left + region.width - 1e-9, `frame ${k}`);
    last = view;
  }
  for (const key of ['left', 'top', 'width', 'height']) assert.ok(Math.abs(last[key] - region[key]) < 1e-9, key);
});

test('lint: a push-in belongs to a crossing, with a point, a zoom of 1.25 to 3 and an optional length', () => {
  assert.deepEqual(pushInIssues({ at: [0.3, 0.6], zoom: 2 }, 'crossing'), []);
  assert.deepEqual(pushInIssues({ at: [0.3, 0.6], zoom: 2, frames: 24 }, 'crossing'), []);
  assert.equal(pushInIssues({ at: [0.3, 0.6], zoom: 2 }, 'moment').length, 1);
  assert.equal(pushInIssues({ at: [1.3, 0.6], zoom: 4, frames: 2, speed: 1 }, 'crossing').length, 4);
});

/** A picture with something to see everywhere: a colour ramp under a grid of discs. */
async function still(path, width, height) {
  const discs = Array.from({ length: 40 }, (_, i) => `<circle cx="${(i % 8) * width / 8 + width / 16}" cy="${Math.floor(i / 8) * height / 5 + height / 10}" r="${height / 14}" fill="hsl(${i * 37} 70% 50%)"/>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g"><stop offset="0" stop-color="#203040"/><stop offset="1" stop-color="#d0a060"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>${discs}</svg>`;
  await sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toFile(path);
}

test('a crossing with a push-in: rendered from the crop, finished with the push-in in front, on the still’s colours, its sound after it', async () => {
  const dir = tempDir('pushin');
  const paths = pathsAt(dir, 'map');
  mkdirSync(paths.stills, { recursive: true });
  const map = join(paths.stills, 'map.jpg');
  await still(map, 384, 256);
  await sharp({ create: { width: 384, height: 256, channels: 3, background: '#556677' } }).jpeg().toFile(join(paths.stills, 'harbour.jpg'));
  const pushIn = { at: [0.7, 0.3], zoom: 2 };

  // render: the first picture sent is the crop, recorded with the take.
  const plan = { canvas: '1344x768', contentFilter: 'off', places: [] };
  const film = { id: 'map-harbour', kind: 'crossing', from: 'map', to: 'harbour', object: 'harbour', first: 'stills/map.jpg', last: 'stills/harbour.jpg',
    frames: 141, pushIn, action: 'x', sound: 'y' };
  const spec = await takeSpec(plan, paths, film, 1);
  assert.deepEqual(spec.journal.pushIn, pushIn);
  assert.equal(spec.refs[0].send, spec.start, 'the crop is the first picture');
  assert.ok(spec.journal.references.some(ref => ref.role === 'push-in'));
  assert.equal(spec.journal.references.find(ref => ref.role === 'first').path, 'stills/map.jpg', 'staleness still follows the place’s still');
  const crop = join(dir, 'crop.jpg');
  writeFileSync(crop, await pushInStart(map, pushIn, { width: 384, height: 256 }));
  const expected = await sharp(map).extract({ left: 173, top: 13, width: 192, height: 128 }).resize(384, 256).raw().greyscale().toBuffer();
  assert.ok(correlation(await sharp(crop).greyscale().raw().toBuffer(), expected) > 0.97, 'the crop is that part of the still');

  // The take, as a model would return it: starts on the crop, a second long, with sound.
  const take = join(dir, 'take.mp4');
  await ffmpeg(['-loop', '1', '-framerate', '24', '-i', crop, '-f', 'lavfi', '-i', 'sine=f=440:sample_rate=48000', '-t', '1',
    '-vf', 'scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-color_range', 'tv', '-colorspace', 'bt709',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', take]);
  // build: the push-in the take was rendered from, in front of it.
  const { finishing, source } = finishingOf(paths, { canvas: '1344x768' }, film, { sha: 'abc', journal: { pushIn } });
  assert.equal(source, `abc+push-in ${JSON.stringify(pushIn)}`);
  const out = join(dir, 'film.mp4');
  const info = await finishFilm(take, out, join(dir, 'film-720.mp4'), { ...finishing, size: { width: 384, height: 256 } });
  assert.equal(info.frames, 18 + 24);
  const frames = await greyFrames(out);
  const [whole] = await greyFrames(map);
  const [takeStart] = await greyFrames(take);
  assert.ok(correlation(frames[0], whole) > 0.98, 'the finished film opens on the whole still');
  assert.ok(correlation(frames[18], takeStart) > 0.98, 'and the take follows the push-in from its first frame');
  for (let k = 1; k < 24; k++) assert.ok(mad(frames[k - 1], frames[k]) < 12, `no jump at frame ${k}`);
  // Colour: the first frame shows the still's colours (a push-in in another colour space jumps where the film takes over).
  const first = await sharp(await ffmpeg(['-i', out, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'])).raw().toBuffer();
  const source1 = await sharp(map).raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < source1.length; i++) diff += Math.abs(first[i] - source1[i]);
  assert.ok(diff / source1.length < 6, `mean colour difference ${(diff / source1.length).toFixed(2)}`);
  // The film's sound starts with the film, after the push-in's three quarters of a second.
  const pcm = await ffmpeg(['-i', out, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-']);
  const rms = (from, to) => { let sum = 0, n = 0; for (let i = Math.floor(from * 8000); i < Math.floor(to * 8000); i++) { const v = pcm.readInt16LE(i * 2); sum += v * v; n++; } return Math.sqrt(sum / n); };
  assert.ok(rms(0, 0.6) < 30 && rms(0.9, 1.5) > 1000, `before ${rms(0, 0.6).toFixed(0)}, after ${rms(0.9, 1.5).toFixed(0)}`);
  const half = await probe(join(dir, 'film-720.mp4'));
  assert.deepEqual([half.width, half.height], [192, 128]);
});
