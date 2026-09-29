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
