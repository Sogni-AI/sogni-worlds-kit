import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintPlot } from '../cli/lib/lint.js';
import { storyText } from '../cli/agent/story.js';
import { bibleProblems, storyProblems } from '../cli/agent/concept.js';

const places = ['office', 'club', 'pier', 'hill'].map(id => ({ id, title: id, objects: [] }));
const plan = plot => ({ id: 'noir', order: 'linear', places: [...places, { id: 'dead', title: 'Dead', ending: { kind: 'death', title: 'You took the money', text: 'She never shared.' }, objects: [] }], plot });
const good = {
  promise: 'A noir mystery: the client is the killer.',
  truth: 'Vera drowned her sister on Sunday and hired a detective to be seen looking.',
  cast: [{ name: 'Vera Lane', who: 'the client; the killer' }, { name: 'Eleanor Lane', who: 'her sister' }],
  beats: { office: 'The hook.', club: 'The fight.', pier: 'The turn.', hill: 'The choice.' },
  twists: [{ twist: 'The client is the killer.', at: 'pier', clues: [{ at: 'office', clue: 'Her glove is stained.' }, { at: 'club', clue: 'The sisters fought.' }] }],
};
const errors = findings => findings.filter(f => f.level === 'error').map(f => f.where);
const warnings = findings => findings.filter(f => f.level === 'warn').map(f => f.where);

test('a world without a plot, or with a well-shaped one, has nothing to say', () => {
  assert.deepEqual(lintPlot(plan(undefined)), []);
  assert.deepEqual(lintPlot(plan(good)), []);
});

test('the plot names real places, gives each person one name and plants every twist before it lands', () => {
  assert.deepEqual(errors(lintPlot(plan({ ...good, twists: [{ ...good.twists[0], clues: [{ at: 'office', clue: 'a' }, { at: 'hill', clue: 'b' }] }] }))), ['plot.twists[0].clues[1]'], 'a clue after the twist');
  assert.deepEqual(errors(lintPlot(plan({ ...good, twists: [{ ...good.twists[0], clues: [{ at: 'office', clue: 'a' }, { at: 'pier', clue: 'b' }] }] }))), ['plot.twists[0].clues[1]'], 'a clue where the twist lands');
  assert.deepEqual(warnings(lintPlot(plan({ ...good, twists: [{ ...good.twists[0], clues: [{ at: 'office', clue: 'a' }] }] }))), ['plot.twists[0].clues'], 'one clue is a cheat');
  assert.deepEqual(errors(lintPlot(plan({ ...good, twists: [{ ...good.twists[0], at: 'roof' }] }))), ['plot.twists[0].at']);
  assert.deepEqual(errors(lintPlot(plan({ ...good, cast: [...good.cast, { name: 'Vera Lane', who: 'again' }] }))), ['plot.cast[2]']);
  assert.deepEqual(errors(lintPlot(plan({ ...good, beats: { ...good.beats, roof: 'x' } }))), ['plot.beats.roof']);
  assert.deepEqual(warnings(lintPlot(plan({ ...good, beats: { office: 'x', club: 'y', pier: 'z' } }))), ['plot.beats'], 'every place that is not an ending has a beat');
  assert.deepEqual(errors(lintPlot(plan({ ...good, villain: 'x' }))), ['plot']);
  // A free world has no order, so where a clue sits is not checked.
  assert.deepEqual(lintPlot({ ...plan({ ...good, twists: [{ ...good.twists[0], clues: [{ at: 'hill', clue: 'a' }, { at: 'club', clue: 'b' }] }] }), order: 'free' }), []);
});

test('the editor reads the plot, then every word a visitor meets in order', () => {
  const p = plan(good);
  p.places[0].narration = { lines: ['She paid in old bills.'] };
  p.places[0].objects = [{ id: 'glove', label: 'Turn the glove over', hint: 'A down payment', reveal: { line: 'Dried blood on the palm.' }, film: { idea: 'A hand turns the glove.' } }, { id: 'door', label: 'Out into the rain', goes: 'club', film: {} }];
  const text = storyText(p);
  for (const words of ['Promise: A noir mystery', 'Cast: Vera Lane (the client; the killer)', 'Twist at pier: The client is the killer. — planted: office: Her glove is stained.', 'Narrator: She paid in old bills.', 'Click "Turn the glove over" [A down payment]: a close look.', 'Narrator over the close look: Dried blood on the palm.', 'Click "Out into the rain": goes to club.', 'Ending card: You took the money: She never shared.']) {
    assert.ok(text.includes(words), words);
  }
  assert.ok(text.indexOf('## office') < text.indexOf('## club') && text.indexOf('## club') < text.indexOf('## pier'));
});

test('the built-in agent\'s bible keeps the same plot rules', () => {
  const place = (id, ending = 'none') => ({ id, title: id, idea: 'x', style: '', prompt: 'p', characters: [], clickables: ['door', 'glove'], ending: { kind: ending, title: '', text: '' }, collectible: '' });
  const bible = plot => ({ title: 't', subtitle: 's', story: 's', plot, style: 's', characters: [],
    places: [place('office'), place('club'), place('pier')], links: [{ from: 'office', via: 'door', to: 'club' }, { from: 'club', via: 'door', to: 'pier' }] });
  const plot = { promise: 'p', truth: 't', cast: [{ name: 'Vera', who: 'w' }], beats: [{ place: 'office', beat: 'b' }, { place: 'club', beat: 'b' }, { place: 'pier', beat: 'b' }],
    twists: [{ twist: 'The client did it.', at: 'pier', clues: [{ at: 'office', clue: 'a' }, { at: 'club', clue: 'b' }] }] };
  assert.deepEqual(bibleProblems(bible(plot), { count: 3 }), []);
  const late = bibleProblems(bible({ ...plot, twists: [{ ...plot.twists[0], clues: [{ at: 'office', clue: 'a' }, { at: 'pier', clue: 'b' }] }] }), { count: 3 });
  assert.equal(late.length, 1);
  assert.match(late[0], /does not meet before the twist/);
  assert.match(bibleProblems(bible({ ...plot, beats: plot.beats.slice(0, 2) }), { count: 3 }).join(' '), /"pier" has no plot beat/);
  assert.match(bibleProblems(bible({ ...plot, cast: [{ name: 'Vera', who: 'a' }, { name: 'vera', who: 'b' }] }), { count: 3 }).join(' '), /share a name/);
});

test('a story with fatal choices also has the ending a visitor earns by choosing well', () => {
  const story = kinds => ({ places: kinds.map((kind, i) => ({ id: `p${i}`, title: 'x', beat: 'b', ending: { kind, title: '', text: '' } })), plot: { promise: 'p', truth: 't', cast: [], twists: [] } });
  assert.match(storyProblems(story(['none', 'none', 'death', 'death']), { count: 2, mechanics: { endings: true } }).join(' '), /choosing well/);
  assert.deepEqual(storyProblems(story(['none', 'none', 'death', 'end']), { count: 2, mechanics: { endings: true } }), []);
  assert.deepEqual(storyProblems(story(['none', 'none']), { count: 2, mechanics: {} }), [], 'no fatal choices, no ending required');
});
