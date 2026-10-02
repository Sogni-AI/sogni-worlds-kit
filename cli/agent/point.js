// Pointing at objects: Qwen 3.6 places a box and clicks on the thing the
// plan names (it is trained on 0–1000 grounding coordinates and is far more
// accurate at this than the writer), SAM 3 traces it, and the writer looks at
// the traced overlay and says whether it is the right thing, all of it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { imagePart, MODELS } from '../lib/llm.js';
import { readJson } from '../lib/files.js';

const point = { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number', minimum: 0, maximum: 1000 } };
const POINT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['found', 'box', 'positive', 'negative'],
  properties: {
    found: { type: 'boolean' },
    box: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'number', minimum: 0, maximum: 1000 } },
    positive: { type: 'array', minItems: 1, maxItems: 4, items: point },
    negative: { type: 'array', maxItems: 4, items: point },
  },
};

const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'what'],
  properties: {
    verdict: { type: 'string', enum: ['right', 'too-much', 'too-little', 'wrong-thing', 'nothing'] },
    what: { type: 'string' },
  },
};

const unit = v => Math.round(Math.min(1, Math.max(0, v / 1000)) * 1000) / 1000;

/** Ask Qwen where `target` is. Returns select clicks in the kit's 0–1 fractions. */
export async function locate(llm, { stillPath, target, feedback = null }) {
  const answer = await llm.json({
    model: MODELS.pointer,
    system: 'You locate objects in pictures precisely. Coordinates are integers from 0 to 1000 across the picture\'s width (x, left to right) and height (y, top to bottom).',
    user: [
      await imagePart(stillPath),
      { type: 'text', text: [
        `Find this one object: ${target}.`,
        'Reply with JSON: {"found": true|false, "box": [x0, y0, x1, y1] tightly around the whole object, "positive": 1–3 points well inside the object (on its most solid, typical part, away from its edges), "negative": 0–3 points on neighbouring things that touch or overlap it and must stay out of the outline (the wall behind a door, the person next to the one you want)}. Coordinates are 0–1000.',
        feedback ? `A previous attempt went wrong: ${feedback}. Place the box and points to fix that.` : null,
      ].filter(Boolean).join('\n') },
    ],
    schema: POINT_SCHEMA,
    purpose: 'locate',
    maxTokens: 1024,
    temperature: 0.2,
  });
  const box = answer.box.map(unit);
  const [x0, x1] = [Math.min(box[0], box[2]), Math.max(box[0], box[2])];
  const [y0, y1] = [Math.min(box[1], box[3]), Math.max(box[1], box[3])];
  return {
    found: answer.found,
    select: {
      positive: answer.positive.map(([x, y]) => [unit(x), unit(y)]),
      ...(answer.negative.length ? { negative: answer.negative.map(([x, y]) => [unit(x), unit(y)]) } : {}),
      box: [x0, y0, x1, y1],
    },
  };
}

/** Is the traced outline the whole object and only it? */
export async function checkOutline(llm, { previewPath, target, coverage }) {
  return llm.json({
    system: 'You check image-segmentation results. A magenta tint shows the traced region; green dots are the clicks on the object, red dots the clicks to exclude, a yellow dashed box the search box.',
    user: [
      await imagePart(previewPath),
      { type: 'text', text: `The magenta region should be exactly this one object: ${target}. It covers ${(coverage * 100).toFixed(1)}% of the picture. Only the visible part of the object counts: parts hidden behind a person or thing in front of it are correctly left out, and that is "right". Reply with JSON {"verdict": "right" | "too-much" (it also takes other things) | "too-little" (it misses a large visible part of the object) | "wrong-thing" | "nothing" (no magenta region), "what": "one sentence: what the magenta region actually covers, and what visible part is missing or extra"}. Small ragged edges are fine.` },
    ],
    schema: CHECK_SCHEMA,
    purpose: 'check-outline',
    maxTokens: 1024,
    temperature: 0.1,
  });
}

/** What the last select of an object produced. */
export function selectionResult(paths, key) {
  const file = join(paths.selections, `${key}.json`);
  if (!existsSync(file)) return null;
  const json = readJson(file);
  return { ...json, previewPath: json.preview ? join(paths.selections, json.preview) : null };
}
