// What the built-in agent knows: the kit's own craft rules, read from docs/
// at run time so the agent and a coding agent always follow the same text,
// plus one worked place from the example world as the bar to meet.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { EXAMPLES, ROOT } from '../lib/paths.js';

const doc = name => readFileSync(join(ROOT, 'docs', name), 'utf8');

/** directing-films.md without its table of contents. */
export function directingRules() {
  return doc('directing-films.md').replace(/## Contents[\s\S]*?\n## /, '## ');
}

/**
 * The example place: "The Road to Aoraki" from The Long White Cloud — a
 * loop, a crossing through cloud, a shortcut and a moment, in the shape the
 * agent answers in. It is far from any place a new world starts with.
 */
export function examplePlace() {
  const world = parse(readFileSync(join(EXAMPLES, 'the-long-white-cloud', 'world.yaml'), 'utf8'));
  const place = world.places.find(p => p.id === 'red-car');
  const next = world.places.find(p => p.id === 'aoraki');
  return {
    seen: place.seen,
    nextSeen: next.seen,
    answer: {
      title: place.title,
      chapter: place.chapter,
      caption: place.caption,
      narration: place.narration.lines.map(line => (typeof line === 'string' ? line : line.text)),
      loop: { idea: place.loop.idea, action: place.loop.action, sound: place.loop.sound },
      objects: place.objects.map(o => ({
        id: o.id,
        target: { camera: 'the camera the woman holds up to her eye', car: 'the red car at the right edge', mirror: 'the red car’s wing mirror' }[o.id],
        label: o.label,
        hint: o.hint,
        goes: o.goes ?? null,
        shortcut: Boolean(o.shortcut),
        film: { frames: o.film.frames, idea: o.film.idea, action: o.film.action, sound: o.film.sound },
      })),
    },
  };
}

/** The writer's standing instructions. */
export function writerSystem({ mature = false } = {}) {
  return [
    'You are the writing and planning assistant built into the Sogni Worlds Kit. A person is the director of their world; you do the labour of planning it: you look at their pictures, write what is in them, and write the short films that bring each picture to life and carry the visitor from one place to the next.',
    'Every film is rendered by MiniMax H3 (first-and-last-frame, two-stage). The kit wraps your `action` and `sound` in the exact document the model expects. Follow the craft rules below exactly; each one cost a rejected film to learn.',
    'Write in plain, concrete English, like a skilled cinematographer briefing a camera crew. Describe only what can be seen or heard. Positive facts only. Never invent names, places, dates or events the person did not give you; use what they told you and what is visible.',
    mature ? 'This world is marked 18+ by its owner, who has authorised graphic horror, gore and frightening imagery. Write at the intensity the person asked for; do not soften it. Describe gore and threat concretely and physically, as events on screen.' : null,
    'You answer in JSON. Inside a JSON string, write a quotation mark as \\" (for lettering such as a sign reading \\"OPEN\\"); an unescaped one ends the text early and the film is rendered from half a direction.',
    '\n# The craft rules (docs/directing-films.md)\n',
    directingRules(),
  ].filter(Boolean).join('\n');
}

export const FRAME_GRID = [124, 141, 158, 175, 192, 209, 226, 243, 260, 277, 294, 311, 328, 345, 362];
