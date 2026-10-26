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
import { validateWorld, mediaEntries } from '../cli/lib/worldjson.js';
import { measureFilm, fastStart } from '../cli/lib/delivery.js';
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
      { id: 'b', title: 'Place B', still: 'stills/b.jpg', music: { file: 'music/b.wav', credit: 'Mine' },
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

  mkdirSync(paths.music, { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=330:sample_rate=44100', '-t', '2', join(paths.music, 'b.wav')]);

  const result = await buildWorld({ paths, plan, say: quiet });
  assert.deepEqual(result.issues, []);
  const world = JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8'));
  assert.deepEqual(validateWorld(world), []);
  assert.equal(world.places[1].music.src, 'audio/music-b.mp3', 'a place\'s own WAV track is served as MP3');
  assert.deepEqual(world.aspect, { width: 192, height: 128 });
  assert.equal(world.start, 'a');
  assert.deepEqual(world.order, ['a', 'b']);

  const [a, b] = world.places;
  assert.equal(a.still, 'stills/a.webp', 'a PNG still is served as WebP');
  assert.equal(b.still, 'stills/b.webp', 'and so is a JPEG one');
  assert.equal((await sharp(join(paths.build, a.still)).metadata()).format, 'webp');
  assert.deepEqual(result.delivery, [], 'everything it serves is in the web formats');
  // Every film streams through the profile: capped, a keyframe every 2 s, its index at the front.
  for (const { ref } of mediaEntries(world).filter(e => e.kind === 'film')) {
    const film = await measureFilm(join(paths.build, ref));
    assert.ok(await fastStart(join(paths.build, ref)), `${ref} starts fast`);
    assert.ok(film.longestGop <= 2 + 1 / 24 + 1e-3, `${ref}: ${film.longestGop} s between keyframes`);
    assert.ok(film.withinCap, `${ref} stays inside its cap`);
  }
  const card = await sharp(join(paths.build, 'social.jpg')).metadata();
  assert.deepEqual([card.format, card.width, card.height], ['jpeg', 1200, 630], 'the social card');
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

test('build: a close look ships its still, its line and its film back; a loop sits under the narrator, a film at the voice', async () => {
  const { loudness } = await import('../cli/lib/screen.js');
  const { FILM_LUFS } = await import('../cli/lib/finish.js');
  const paths = pathsAt(tempDir('build-reveal'), 'look');
  mkdirSync(paths.stills, { recursive: true });
  mkdirSync(paths.reveals, { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.stills, 'a.jpg'));
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#774433' } }).jpeg().toFile(join(paths.reveals, 'a-glove.jpg'));
  const plan = {
    id: 'look', title: 'Look', order: 'free', voices: { narrator: { design: 'a low voice' } }, music: null,
    places: [{ id: 'a', title: 'Place A', still: 'stills/a.jpg', loop: { frames: 124, action: 'x', sound: 'y' }, objects: [
      { id: 'glove', label: 'Turn the glove over', at: [0.5, 0.8], film: { frames: 124 },
        reveal: { still: 'reveals/a-glove.jpg', line: 'Blood on the palm.', done: 'Set it down', back: { frames: 124 } } },
      { id: 'coat', label: 'Lift the coat', at: [0.8, 0.3], film: { frames: 124 }, reveal: { still: 'reveals/a-glove.jpg', back: { frames: 124 } } },
      { id: 'note', label: 'Unfold the note', at: [0.3, 0.3], film: { frames: 124 }, reveal: { still: 'reveals/a-glove.jpg', line: 'It reads Midnight.' } },
    ] }],
  };
  const still = 'testsrc2=size=SIZE:rate=24';
  await take(paths, 'a-loop', 1, { kind: 'loop', seconds: 2, source: still, verdict: 'approved', tone: 300 });
  await take(paths, 'a-glove', 1, { kind: 'reveal', seconds: 2, source: still, verdict: 'approved', tone: 500 });
  await take(paths, 'a-glove-back', 1, { kind: 'back', seconds: 2, source: still, verdict: 'approved', tone: 700 });
  // The coat's film into its close look is approved, its film back is not: the coat stays out.
  await take(paths, 'a-coat', 1, { kind: 'reveal', seconds: 2, source: still, verdict: 'approved', tone: 800 });
  // The note writes no film back: build plays its film in backwards.
  await take(paths, 'a-note', 1, { kind: 'reveal', seconds: 3, source: 'testsrc2=size=SIZE:rate=24', verdict: 'approved', tone: 900 });
  const spoken = join(paths.audio, 'narration', 'reveals');
  mkdirSync(spoken, { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=f=220:sample_rate=24000', '-t', '2', join(spoken, 'a-glove.mp3')]);
  writeJson(join(spoken, 'a-glove.json'), { status: 'completed', mp3: 'a-glove.mp3', lines: [{ text: 'Blood on the palm.', start: 0.1, end: 1.8 }] });

  const result = await buildWorld({ paths, plan, say: quiet });
  assert.deepEqual(result.issues, []);
  const world = JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8'));
  assert.deepEqual(validateWorld(world), []);
  const [place] = world.places;
  assert.deepEqual(place.hotspots.map(h => h.id), ['glove', 'note'], 'a close look whose written film back is not ready stays out of the world');
  assert.ok(result.missing.some(m => m.film === 'a-coat-back'));
  const { reveal } = place.hotspots[0];
  assert.equal(reveal.still, 'stills/reveals/a-glove.webp');
  assert.ok(existsSync(join(paths.build, reveal.still)));
  assert.equal(reveal.done, 'Set it down');
  assert.equal(reveal.narration.src, 'audio/narration-reveal-a-glove.mp3');
  assert.equal(reveal.narration.lines[0].text, 'Blood on the palm.');
  assert.ok(existsSync(join(paths.build, reveal.back.src)) && existsSync(join(paths.build, reveal.back.src720)));
  assert.equal(place.hotspots[0].rewind, undefined, 'a close look is not a crossing: nothing to rewind');
  // The note's film back is its film in, backwards, frame for frame.
  const note = place.hotspots[1];
  assert.equal(note.reveal.back.src, 'films/a-note-back.mp4');
  const forward = await greyFrames(join(paths.build, note.film.src));
  const backward = await greyFrames(join(paths.build, note.reveal.back.src));
  assert.equal(backward.length, forward.length);
  for (const i of [0, 30, 71]) assert.ok(correlation(forward[i], backward[forward.length - 1 - i]) > 0.98, `frame ${i}`);

  // One scene level for films and loops, under the narrator; the reversed film back carries the loop's sound.
  const loop = await loudness(join(paths.build, place.loop.src));
  const film = await loudness(join(paths.build, place.hotspots[0].film.src));
  assert.ok(Math.abs(loop.lufs - FILM_LUFS) <= 1.5, `loop at ${loop.lufs} LUFS`);
  assert.ok(Math.abs(film.lufs - FILM_LUFS) <= 1.5, `film at ${film.lufs} LUFS`);
  const { probe } = await import('../cli/lib/media.js');
  assert.ok((await probe(join(paths.build, note.reveal.back.src))).audioChannels, 'the film back has the room\'s sound');

  // A new level re-levels the finished sound and leaves the picture's encode alone.
  const manifestPath = join(paths.build, '.manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest['films/a-loop.mp4'].lufs = -14;
  writeJson(manifestPath, manifest);
  const before = await greyFrames(join(paths.build, place.loop.src));
  const steps = [];
  await buildWorld({ paths, plan, say: { ...quiet, step: text => steps.push(text) } });
  assert.deepEqual(steps, ["Levelling a-loop's sound"]);
  const after = await greyFrames(join(paths.build, place.loop.src));
  assert.ok(before.every((frame, i) => correlation(frame, after[i]) > 0.999), 'the picture is untouched');
});

test('a film into a close look stops counting once its close look is painted again', async () => {
  const { listTakes, approvedTake } = await import('../cli/lib/takes.js');
  const { filmsOf } = await import('../cli/lib/plan.js');
  const paths = pathsAt(tempDir('stale'), 'stale');
  mkdirSync(paths.stills, { recursive: true });
  mkdirSync(paths.reveals, { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.stills, 'a.jpg'));
  const close = join(paths.reveals, 'a-glove.jpg');
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#774433' } }).jpeg().toFile(close);
  const plan = { places: [{ id: 'a', still: 'stills/a.jpg', objects: [{ id: 'glove', film: { frames: 124 }, reveal: { still: 'reveals/a-glove.jpg' } }] }] };
  const [film] = filmsOf(plan);
  const sha = await take(paths, film.id, 1, { kind: 'reveal', seconds: 1, source: 'testsrc2=size=SIZE:rate=24', verdict: 'approved' });
  // What render records: the stills it was made between.
  const journal = join(paths.renders, film.id, 'take-1.json');
  writeJson(journal, { ...JSON.parse(readFileSync(journal, 'utf8')), references: [
    { role: 'first', path: film.first, sha256: sha256File(join(paths.stills, 'a.jpg')) },
    { role: 'last', path: film.last, sha256: sha256File(close) }] });
  assert.equal(approvedTake(listTakes(paths, film.id, undefined, undefined, film))?.sha, sha);
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#117744' } }).jpeg().toFile(close);
  const takes = listTakes(paths, film.id, undefined, undefined, film);
  assert.equal(takes[0].stale, true);
  assert.equal(approvedTake(takes), null, 'rendered to another picture: no longer approved');
});
