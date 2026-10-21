import { test } from 'node:test';
import assert from 'node:assert/strict';
import { filmsOf, nextPlaceId } from '../cli/lib/plan.js';
import { planMarkdown } from '../cli/commands/plan.js';

const plan = {
  places: [
    { id: 'harbour', loop: { action: 'a', sound: 'b' }, objects: [
      { id: 'ferry', goes: 'beach', film: { frames: 243, action: 'x', sound: 'y' } },
      { id: 'gull', film: { frames: 141, action: 'x', sound: 'y' } },
      { id: 'sign' },
    ] },
    { id: 'beach', objects: [] },
  ],
};

test('films: a loop per place with one, a crossing per object that goes, a moment per object that stays', () => {
  const films = filmsOf(plan);
  assert.deepEqual(films.map(f => [f.id, f.kind, f.from, f.to, f.frames]), [
    ['harbour-loop', 'loop', 'harbour', 'harbour', 192],
    ['harbour-ferry', 'crossing', 'harbour', 'beach', 243],
    ['harbour-gull', 'moment', 'harbour', 'harbour', 141],
  ]);
});

test('the next place in a linear story wraps to the first', () => {
  assert.equal(nextPlaceId(plan, 'harbour'), 'beach');
  assert.equal(nextPlaceId(plan, 'beach'), 'harbour');
  assert.equal(nextPlaceId(plan, 'nowhere'), null);
});

test('the Markdown plan shows every word of the story and each idea, pipes escaped', () => {
  const story = 'A long story. '.repeat(30).trim();
  const idea = 'The ferry pulls away from the wharf | gulls lift off the pilings and wheel over the wake, '.repeat(4).trim();
  const long = { title: 'Trip', story, places: [
    { id: 'harbour', loop: { frames: 124, action: 'a', sound: 'b' }, objects: [{ id: 'ferry', label: 'The ferry', goes: 'beach', film: { frames: 243, action: 'x', sound: 'y', idea } }] },
    { id: 'beach', objects: [], narration: { lines: [{ text: 'The sand was warm. '.repeat(10).trim() }] } },
  ] };
  const markdown = planMarkdown(long, 'trip');
  assert.ok(markdown.includes(story));
  assert.ok(markdown.includes(idea.replace(/\|/g, '\\|')));
  assert.ok(markdown.includes('The sand was warm. '.repeat(10).trim()));
  assert.ok(!markdown.includes('…'));
});

test('a reveal is two films: into the close look, and back to the place, each with its own stills', () => {
  const films = filmsOf({ places: [
    { id: 'office', still: 'stills/office.jpg', objects: [
      { id: 'glove', film: { frames: 141, action: 'in', sound: 's' }, reveal: { still: 'reveals/office-glove.jpg', back: { frames: 124, action: 'out', sound: 's' } } },
      { id: 'coat', goes: 'street', film: { frames: 243, action: 'x', sound: 'y' }, reveal: { still: 'ignored.jpg' } },
    ] },
    { id: 'street', still: 'stills/street.jpg', objects: [] },
  ] });
  assert.deepEqual(films.map(f => [f.id, f.kind, f.first, f.last, f.frames]), [
    ['office-glove', 'reveal', 'stills/office.jpg', 'reveals/office-glove.jpg', 141],
    ['office-glove-back', 'back', 'reveals/office-glove.jpg', 'stills/office.jpg', 124],
    ['office-coat', 'crossing', 'stills/office.jpg', 'stills/street.jpg', 243],
  ]);
});

test('a close look is painted, picked and described before its films: next says which, in that order', async () => {
  const { nextAction } = await import('../cli/commands/status.js');
  const base = { id: 'w', exists: true, places: 1, photos: 1, photosNotIngested: 0, stillsMissing: [], planWritten: true, errors: [], takes: 1,
    selections: { needed: [], failed: [], done: 1 }, revealsNeeded: [], revealsToPick: [], revealsUnseen: [] };
  assert.match(nextAction({ ...base, revealsNeeded: ['a-glove'] }).command, /^node world reveals w$/);
  assert.match(nextAction({ ...base, revealsToPick: ['a-glove'] }).command, /--pick a-glove <n>/);
  assert.match(nextAction({ ...base, revealsUnseen: ['a-glove'] }).command, /write its reveal\.seen, rewrite the object's film/);
});

test('the room a close look keeps: 1 for the same room, low for a repainted one', async () => {
  const sharp = (await import('sharp')).default;
  const { roomKept } = await import('../cli/commands/reveals.js');
  const scene = (shift) => sharp({ create: { width: 480, height: 270, channels: 3, background: '#203040' } })
    .composite([{ input: { create: { width: 120, height: 200, channels: 3, background: '#c0a060' } }, left: 40 + shift, top: 30 },
      { input: { create: { width: 90, height: 60, channels: 3, background: '#e0e0e0' } }, left: 300, top: 160 - shift }]).png().toBuffer();
  const object = { x: 0.6, y: 0.55, width: 0.2, height: 0.25 };
  const room = await scene(0);
  assert.equal(await roomKept(room, room, object), 1);
  assert.ok(await roomKept(room, await scene(200), object) < 0.8, 'the furniture moved');
});
