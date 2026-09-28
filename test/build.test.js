import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildWorld } from '../cli/commands/build.js';
import { writeJson, sha256File } from '../cli/lib/files.js';
import { recordVerdict } from '../cli/lib/takes.js';
import { ffmpeg, probe } from '../cli/lib/media.js';
import { greyFrames, correlation } from '../cli/lib/screen.js';
import { validateWorld } from '../cli/lib/worldjson.js';
import { tempDir, pathsAt, syntheticVideo } from './helpers.js';

const quiet = { step() {}, ok() {}, warn() {}, info() {}, fail() {}, title() {}, next() {}, dim() {} };

async function take(paths, film, number, { kind, seconds, source, verdict, tone }) {
  const video = join(paths.renders, film, `take-${number}.mp4`);
  // Verdicts are keyed by SHA-256: give every synthetic take its own bytes.
  await syntheticVideo(video, { source, seconds, tone });
  const sha = sha256File(video);
  writeJson(join(paths.renders, film, `take-${number}.json`), {
    film, take: number, kind, width: 96, height: 64, frames: Math.round(seconds * 24), status: 'completed', sha256: sha,
  });
  if (verdict) recordVerdict(paths, sha, { film, take: number, verdict, note: '', by: 'you' });
  return sha;
}

test('build assembles a playable world from approved takes only', async () => {
  const paths = pathsAt(tempDir('build'), 'mini');
  mkdirSync(paths.stills, { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).png().toFile(join(paths.stills, 'a.png'));
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#aa7733' } }).jpeg().toFile(join(paths.stills, 'b.jpg'));

  const plan = {
    id: 'mini', title: 'Mini', order: 'linear', voices: {}, music: null,
    places: [
      { id: 'a', title: 'Place A', still: 'stills/a.png', caption: 'Hello', narration: { lines: ['Hello.', 'This is A.'] },
        loop: { frames: 124, action: 'x', sound: 'y' },
        objects: [
          { id: 'door', label: 'Open the door', at: [0.4, 0.5], goes: 'b', film: { frames: 124 } },
          { id: 'bird', label: 'Watch the bird', at: [0.8, 0.2], film: { frames: 124 } },
        ] },
      { id: 'b', title: 'Place B', still: 'stills/b.jpg',
        objects: [{ id: 'path', label: 'Walk back', select: { positive: [[0.3, 0.6]] }, goes: 'a', film: { frames: 124 } }] },
    ],
  };
  const pan = 'testsrc2=size=640x240:rate=24,crop=192:128:x=t*40:y=40';
  await take(paths, 'a-loop', 1, { kind: 'loop', seconds: 2, source: 'testsrc2=size=SIZE:rate=24', verdict: 'approved' });
  await take(paths, 'a-door', 1, { kind: 'crossing', seconds: 2, source: pan, verdict: 'rejected' });
  await take(paths, 'a-door', 2, { kind: 'crossing', seconds: 5, source: pan, verdict: 'approved' });
  await take(paths, 'a-bird', 1, { kind: 'moment', seconds: 2, source: 'testsrc2=size=SIZE:rate=24', tone: 660 });
  await take(paths, 'b-path', 1, { kind: 'crossing', seconds: 3, source: pan, verdict: 'approved' });
  writeJson(join(paths.selections, 'a-door.json'), { outline: { width: 1536, height: 1024, path: 'M10 10L100 10L100 100Z' } });
  mkdirSync(join(paths.audio, 'narration'), { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:sample_rate=24000', '-t', '2', join(paths.audio, 'narration', 'a.mp3')]);
  writeJson(join(paths.audio, 'narration', 'a.json'), { status: 'completed', mp3: 'a.mp3',
    lines: [{ text: 'Hello.', start: 0.1, end: 0.8 }, { text: 'This is A.', start: 1.0, end: 1.9 }] });

  const result = await buildWorld({ paths, plan, say: quiet });
  assert.deepEqual(result.issues, []);
  const world = JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8'));
  assert.deepEqual(validateWorld(world), []);
  assert.deepEqual(world.aspect, { width: 192, height: 128 });
  assert.equal(world.start, 'a');
  assert.deepEqual(world.order, ['a', 'b']);

  const [a, b] = world.places;
  assert.equal(a.still, 'stills/a.jpg');
  assert.ok(a.loop?.src, 'the approved loop is in');
  assert.deepEqual(a.hotspots.map(h => h.id), ['door'], 'the unjudged moment stays out');
  assert.equal(a.hotspots[0].to, 'b');
  assert.equal(a.hotspots[0].next, true);
  assert.equal(a.hotspots[0].outline.path, 'M10 10L100 10L100 100Z');
  assert.equal(a.narration.src, 'audio/narration-a.mp3');
  assert.equal(a.narration.lines[1].start, 1.0);
  assert.deepEqual(b.hotspots[0].at, [0.3, 0.6], 'label falls back to the first SAM click');
  assert.equal(b.hotspots[0].next, true, 'the last place leads back to the first');
  assert.ok(result.missing.some(m => m.film === 'a-bird' && m.state === 'unjudged'));

  // The approved take (5 s), not the rejected one (2 s), finished at full and half size.
  const door = await probe(join(paths.build, a.hotspots[0].film.src));
  const door720 = await probe(join(paths.build, a.hotspots[0].film.src720));
  assert.equal(door.frames, 120);
  assert.deepEqual([door720.width, door720.height], [96, 64]);
  // The rewind is the film backwards, frame for frame, across its 2-second pieces.
  const forward = await greyFrames(join(paths.build, a.hotspots[0].film.src));
  const backward = await greyFrames(join(paths.build, a.hotspots[0].rewind.src));
  assert.equal(backward.length, forward.length);
  for (const i of [0, 30, 47, 48, 49, 95, 119]) {
    assert.ok(correlation(forward[i], backward[forward.length - 1 - i]) > 0.98, `frame ${i}`);
  }
  assert.ok(existsSync(join(paths.build, a.hotspots[0].rewind.src720)));

  // A second build re-encodes nothing.
  const steps = [];
  await buildWorld({ paths, plan, say: { ...quiet, step: text => steps.push(text) } });
  assert.deepEqual(steps, []);
});
