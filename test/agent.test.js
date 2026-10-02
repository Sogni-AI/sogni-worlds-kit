import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { checkShape, extractJson, grammarOf } from '../cli/lib/llm.js';
import { placeProblems, routesFor } from '../cli/agent/write.js';
import { buildWorld } from '../cli/commands/build.js';
import { writeJson, sha256File } from '../cli/lib/files.js';
import { recordVerdict } from '../cli/lib/takes.js';
import { lintPlan } from '../cli/lib/lint.js';
import { validateWorld, FORMAT } from '../cli/lib/worldjson.js';
import { tempDir, pathsAt, syntheticVideo } from './helpers.js';

const quiet = { step() {}, ok() {}, warn() {}, info() {}, fail() {}, title() {}, next() {}, dim() {} };

test('extractJson finds the object in fenced, wrapped or thinking replies', () => {
  assert.deepEqual(extractJson('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('<think>maybe {"no": 1}</think>Here it is: {"a": [1, "}"]} done'), { a: [1, '}'] });
  assert.throws(() => extractJson('no json here'), /no JSON/);
});

test('checkShape reports missing keys, wrong types, enums and sizes in words', () => {
  const schema = { type: 'object', required: ['title', 'frames', 'objects'], properties: {
    title: { type: 'string', minLength: 3 }, frames: { type: 'integer', enum: [124, 141] },
    objects: { type: 'array', minItems: 2, items: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } } };
  assert.deepEqual(checkShape({ title: 'Door', frames: 124, objects: [{ id: 'a' }, { id: 'b' }] }, schema), []);
  const problems = checkShape({ title: 'Do', frames: 130, objects: [{}] }, schema);
  assert.ok(problems.some(p => /title is too short/.test(p)));
  assert.ok(problems.some(p => /frames must be one of 124, 141/.test(p)));
  assert.ok(problems.some(p => /objects needs at least 2/.test(p)));
  assert.ok(problems.some(p => /objects\[0\]\.id is missing/.test(p)));
});

test('the grammar sent to the server leaves out text lengths, so no sentence is cut off', () => {
  const grammar = grammarOf({ type: 'object', properties: { story: { type: 'string', minLength: 60, maxLength: 900 }, n: { type: 'integer', minimum: 0, maximum: 3 } } });
  assert.deepEqual(grammar, { type: 'object', properties: { story: { type: 'string' }, n: { type: 'integer' } } });
});

const film = (over = {}) => ({ frames: 243, idea: 'Through the door.', sound: 'The door creaks and boots scuff on stone.',
  action: 'Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: a red door in a grassy hill. The camera glides through the doorway into a passage and out into a rainforest clearing.', ...over });
const loop = { idea: 'Wind.', sound: 'Wind in the grass.', action: 'Live-action, cinematic, a static wide shot holds the position and framing established by Picture 1: a red door in a grassy hill; the grass ripples and the lantern flickers in the breeze.' };

test('a place answer must take its required route, use real places and its own title', () => {
  const context = { title: 'My Trip', order: 'linear', places: [{ id: 'door' }, { id: 'forest' }, { id: 'haka' }] };
  const place = context.places[0];
  const required = routesFor('door', context);
  assert.deepEqual(required.map(r => r.to), ['forest']);
  const answer = { title: 'My Trip', loop, objects: [
    { id: 'door', label: 'Duck through', hint: 'x', goes: 'moon', film: film() },
    { id: 'door', label: 'Again', hint: 'x', goes: 'door', film: film() },
  ] };
  const problems = placeProblems(answer, { place, context, required });
  assert.ok(problems.some(p => /goes to "moon", which is not a place/.test(p)));
  assert.ok(problems.some(p => /two objects share the id "door"/.test(p)));
  assert.ok(problems.some(p => /goes to this same place/.test(p)));
  assert.ok(problems.some(p => /must have "goes": "forest"/.test(p)));
  assert.ok(problems.some(p => /already the world's or another place's title/.test(p)));
});

test('lint warnings come back as "(warning)" problems; errors stay plain', () => {
  const context = { title: 'T', order: 'free', places: [{ id: 'a' }, { id: 'b' }] };
  const place = context.places[0];
  const dark = film({ action: `${film().action} Darkness fills the view as it passes the door.` });
  const negation = film({ sound: 'Nothing but wind.' });
  const problems = placeProblems({ title: 'A', loop, objects: [{ id: 'x', label: 'Go', hint: 'h', goes: 'b', film: dark }, { id: 'y', label: 'Go', hint: 'h', goes: '', film: negation }] }, { place, context, required: [] });
  assert.ok(problems.some(p => p.startsWith('(warning)') && /dark screen/.test(p)));
  assert.ok(problems.some(p => !p.startsWith('(warning)') && /negation|state only what is there/.test(p)));
});

test('lint accepts endings, collectibles and intro; flags their misuse', () => {
  const paths = pathsAt(tempDir('lint-ending'), 'w');
  const plan = {
    id: 'w', title: 'W', order: 'free', canvas: '1344x768', voices: {}, start: 'room', intro: { tagline: 'Hi', warning: '18+' }, map: false,
    places: [
      { id: 'room', title: 'Room', still: 'stills/room.jpg', seen: 's', objects: [
        { id: 'bed', label: 'Lean in', at: [0.5, 0.5], goes: 'dead', film: film() },
        { id: 'toy', label: 'A figure', at: [0.2, 0.5], collect: true, film: film({ frames: 141 }) },
        { id: 'bad', label: 'Bad', at: [0.2, 0.5], collect: true, goes: 'dead', film: film() },
      ] },
      { id: 'dead', title: 'Dead', still: 'stills/dead.jpg', seen: 's', ending: { kind: 'death', title: 'You leaned in' }, objects: [] },
    ],
  };
  const findings = lintPlan(plan, paths, { checkFiles: false });
  assert.ok(!findings.some(f => f.where.startsWith('places.dead') && f.level === 'error'), 'a death ending is fine');
  assert.ok(findings.some(f => f.where === 'places.room.objects.bad' && /collectible stays in its place/.test(f.message)));
  plan.places[1].ending = { kind: 'boom' };
  plan.intro.colour = 'red';
  const worse = lintPlan(plan, paths, { checkFiles: false });
  assert.ok(worse.some(f => f.where === 'places.dead.ending' && /kind is death/.test(f.message)));
  assert.ok(worse.some(f => f.where === 'places.dead.ending' && /title/.test(f.message)));
  assert.ok(worse.some(f => f.where === 'intro' && /unknown field "colour"/.test(f.message)));
});

test('world.json carries intro, map, draft, endings and collectibles, and rejects their misuse', () => {
  const world = {
    format: FORMAT, id: 'w', title: 'W', aspect: { width: 2688, height: 1536 }, start: 'room', order: null,
    intro: { eyebrow: 'A ride', tagline: 'Hi', warning: '18+', begin: 'Begin the ride' }, map: false, draft: true,
    places: [
      { id: 'room', title: 'Room', still: 's.jpg', hotspots: [
        { id: 'bed', label: 'Lean in', at: [0.5, 0.5], to: 'dead', film: { src: 'a.mp4' } },
        { id: 'toy', label: 'A figure', at: [0.2, 0.5], collect: true, film: { src: 'b.mp4' } },
      ] },
      { id: 'dead', title: 'Dead', still: 'd.jpg', ending: { kind: 'death', title: 'You leaned in', text: 'He told you.' }, hotspots: [] },
    ],
  };
  assert.deepEqual(validateWorld(world), []);
  world.places[0].hotspots[1].to = 'dead';
  world.places[1].ending = { kind: 'win' };
  world.intro.colour = 'red';
  const issues = validateWorld(world);
  assert.ok(issues.some(i => /a collectible stays in its place/.test(i)));
  assert.ok(issues.some(i => /ending: \{ kind/.test(i)));
  assert.ok(issues.some(i => /unknown field "colour"/.test(i)));
});

test('build --drafts plays unjudged takes, never rejected ones, and marks the world a draft', async () => {
  const paths = pathsAt(tempDir('drafts'), 'mini');
  mkdirSync(paths.stills, { recursive: true });
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#335577' } }).jpeg().toFile(join(paths.stills, 'a.jpg'));
  await sharp({ create: { width: 192, height: 128, channels: 3, background: '#aa3333' } }).jpeg().toFile(join(paths.stills, 'end.jpg'));
  const plan = {
    id: 'mini', title: 'Mini', order: 'free', voices: {}, music: null, intro: { tagline: 'Careful.' }, map: false,
    places: [
      { id: 'a', title: 'A', still: 'stills/a.jpg', loop: { frames: 124 }, objects: [
        { id: 'door', label: 'Lean in', at: [0.4, 0.5], goes: 'end', film: { frames: 124 } },
        { id: 'toy', label: 'A tin soldier', at: [0.7, 0.5], collect: true, film: { frames: 124 } },
      ] },
      { id: 'end', title: 'The End', still: 'stills/end.jpg', ending: { kind: 'death', title: 'You leaned in', text: 'He told you how to leave.' }, objects: [] },
    ],
  };
  const make = async (film, n, verdict, tone) => {
    const video = join(paths.renders, film, `take-${n}.mp4`);
    await syntheticVideo(video, { source: 'testsrc2=size=SIZE:rate=24', seconds: 2, tone });
    const sha = sha256File(video);
    writeJson(join(paths.renders, film, `take-${n}.json`), { film, take: n, width: 96, height: 64, frames: 48, status: 'completed', sha256: sha });
    if (verdict) recordVerdict(paths, sha, { film, take: n, verdict, note: '', by: 'agent' });
  };
  await make('a-loop', 1, null, 300);
  await make('a-door', 1, null, 400);
  await make('a-door', 2, 'rejected', 500);
  await make('a-toy', 1, null, 600);

  const plain = await buildWorld({ paths, plan, say: quiet });
  assert.equal(plain.films, 0, 'without --drafts nothing unapproved is used');

  const result = await buildWorld({ paths, plan, drafts: true, say: quiet });
  assert.deepEqual(result.issues, []);
  const world = JSON.parse(readFileSync(join(paths.build, 'world.json'), 'utf8'));
  assert.equal(world.draft, true);
  assert.equal(world.map, false);
  assert.deepEqual(world.intro, { tagline: 'Careful.' });
  assert.deepEqual(world.places[1].ending, { kind: 'death', title: 'You leaned in', text: 'He told you how to leave.' });
  const [door, toy] = world.places[0].hotspots;
  assert.equal(door.to, 'end');
  assert.ok(door.rewind?.src, 'a fatal crossing gets a rewind');
  assert.equal(toy.collect, true);
  assert.ok(result.unapproved.includes('a-door take 1'), 'the rejected take 2 is never used; take 1 is');
  assert.deepEqual(result.deadEnds, ['end'], 'buildWorld still lists it; the report leaves endings out');
});
