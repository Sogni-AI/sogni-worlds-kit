import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyMark, awaitingFilms } from '../cli/commands/review.js';
import { rewriteFilm } from '../cli/agent/judge.js';
import { describeNote, listTakes, normalBox, personsMarks, readStillNotes } from '../cli/lib/takes.js';
import { ffmpeg } from '../cli/lib/media.js';
import { tempDir, pathsAt, syntheticVideo } from './helpers.js';

const film = { frames: 192, action: 'x', sound: 'y' };
const plan = { places: [{ id: 'a', still: 'stills/a.jpg', objects: [], loop: film }] };

/** A world with one place still and one finished loop take. */
async function world() {
  const paths = pathsAt(tempDir('marks'));
  mkdirSync(paths.stills, { recursive: true });
  await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=192x128', '-frames:v', '1', join(paths.stills, 'a.jpg')]);
  await syntheticVideo(join(paths.renders, 'a-loop', 'take-1.mp4'), { source: 'testsrc=size=SIZE:rate=24', seconds: 2 });
  writeFileSync(join(paths.renders, 'a-loop', 'take-1.json'), JSON.stringify({ status: 'completed', sha256: 'sha-loop', projectId: 'p' }));
  return paths;
}

test('an area box is clamped to the picture and must have some size', () => {
  assert.deepEqual(normalBox([0.1, 0.2, 0.3, 0.4]), [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(normalBox([0.9, -0.5, 0.5, 0.7]), [0.9, 0, 0.1, 0.7]);
  assert.equal(normalBox([0.1, 0.2, 0, 0.4]), null);
  assert.equal(normalBox([0.1, 0.2, 0.3]), null);
  assert.equal(normalBox('0.1,0.2,0.3,0.4'), null);
});

test('an area note on a take is saved with its time, box and a picture of the frame', async () => {
  const paths = await world();
  const note = await applyMark(plan, paths, { sha: 'sha-loop', time: 1.234, box: [0.5, 0.25, 0.2, 0.3], text: 'smoke from this house only' });
  assert.equal(note.by, 'you');
  assert.equal(note.time, 1.23);
  assert.deepEqual(note.box, [0.5, 0.25, 0.2, 0.3]);
  assert.ok(existsSync(join(paths.review, 'marks', 'a-loop-take-1-1.jpg')));
  const [take] = listTakes(paths, 'a-loop');
  assert.equal(take.notes.length, 1);
  assert.match(describeNote(take.notes[0]), /^you \(at 1\.2 s, area x 0\.5, y 0\.25, w 0\.2, h 0\.3\): smoke from this house only {2}→ .*a-loop-take-1-1\.jpg$/);
  // The page carries it with the take, ready to draw.
  assert.deepEqual(awaitingFilms(plan, paths)[0].takes[0].notes[0].box, [0.5, 0.25, 0.2, 0.3]);
});

test('an area note on a still is kept by place', async () => {
  const paths = await world();
  const note = await applyMark(plan, paths, { still: 'a', box: [0.1, 0.1, 0.2, 0.2], text: 'this cottage' });
  assert.equal(note.time, undefined);
  assert.deepEqual(readStillNotes(paths).a.map(n => n.text), ['this cottage']);
  assert.ok(existsSync(join(paths.review, 'marks', 'a-still-1.jpg')));
  assert.deepEqual(awaitingFilms(plan, paths)[0].stillNotes.a.map(n => n.text), ['this cottage']);
});

test('an area note needs a box, words and a take or picture that exists', async () => {
  const paths = await world();
  assert.match(await applyMark(plan, paths, { sha: 'sha-loop', box: [0, 0, 0, 0], text: 'x' }), /Drag a box/);
  assert.match(await applyMark(plan, paths, { sha: 'sha-loop', box: [0, 0, 0.5, 0.5], text: '  ' }), /Say what/);
  assert.match(await applyMark(plan, paths, { sha: 'nope', box: [0, 0, 0.5, 0.5], text: 'x' }), /not in this world/);
  assert.match(await applyMark(plan, paths, { still: 'zz', box: [0, 0, 0.5, 0.5], text: 'x' }), /not in this world/);
});

test('a retake shows the writer the person\'s area notes and the frames they drew on', async () => {
  const paths = await world();
  await applyMark(plan, paths, { sha: 'sha-loop', time: 0.5, box: [0.5, 0.25, 0.2, 0.3], text: 'smoke from this house only' });
  const [take] = listTakes(paths, 'a-loop');
  const marks = personsMarks(take);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].time, 0.5);
  assert.ok(existsSync(marks[0].image), 'the marked frame is found from the note');
  let request;
  const llm = { json: async args => { request = args; return { diagnosis: 'the smoke was everywhere', film: { frames: 192, idea: 'i', action: 'smoke rises from the one chimney', sound: 'wind' } }; } };
  const loop = { id: 'a-loop', kind: 'loop', frames: 192, idea: 'x', action: 'x', sound: 'y' };
  await rewriteFilm(llm, { film: loop, reasons: ['take 1: too much smoke'], marks, fromStill: join(paths.stills, 'a.jpg'), toStill: join(paths.stills, 'a.jpg'), fromSeen: 'a cottage', toSeen: 'a cottage', mature: false });
  const texts = request.user.filter(part => part.type === 'text').map(part => part.text);
  assert.match(texts[0], /drew a red box on a frame/);
  assert.ok(texts.some(text => text.startsWith('Take 1 at 0.5 s, the red box: "smoke from this house only"')));
  assert.equal(request.user.filter(part => part.type === 'image_url').length, 2, 'the start picture and the marked frame');
});
