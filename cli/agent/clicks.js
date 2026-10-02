// Does each film answer its click? The visitor taps a thing whose label makes
// a promise ("Follow the lanterns to the city"); the film has to start with
// that thing doing what the label says. A film that starts somewhere else
// feels broken however good it looks, and it is the fault people find most
// often by hand. A vision model looks at the still with the tapped thing
// marked and at frames from the film's opening, and says whether they agree.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { frameImage } from '../lib/screen.js';
import { probe } from '../lib/media.js';
import { imagePart } from '../lib/llm.js';

const AUDIT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['clicked', 'firstMotion', 'clickedThingLeads', 'doesWhatLabelSays', 'verdict', 'why', 'fix'],
  properties: {
    clicked: { type: 'string' },
    firstMotion: { type: 'string' },
    clickedThingLeads: { type: 'boolean' },
    doesWhatLabelSays: { type: 'boolean' },
    verdict: { type: 'string', enum: ['aligned', 'weak', 'misaligned'] },
    why: { type: 'string' },
    fix: { type: 'string' },
  },
};

/** The still with the tapped thing ringed (or its traced outline, when there is one). */
async function markedStill(stillPath, at, out) {
  const image = sharp(stillPath, { failOn: 'none' }).rotate();
  const { width, height } = await image.metadata();
  const scale = Math.min(1, 1024 / Math.max(width, height));
  const [w, h] = [Math.round(width * scale), Math.round(height * scale)];
  const r = Math.round(Math.max(w, h) * 0.045);
  const [x, y] = [Math.round(at[0] * w), Math.round(at[1] * h)];
  const ring = Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="#ff00ff" stroke-width="${Math.max(3, Math.round(r / 6))}"/><circle cx="${x}" cy="${y}" r="${Math.max(3, Math.round(r / 6))}" fill="#ff00ff"/></svg>`);
  await image.resize(w, h).composite([{ input: ring }]).jpeg({ quality: 88 }).toFile(out);
  return out;
}

/**
 * Frames from the opening of a film, where the click has to show, at fixed
 * times (a share of a long film would leave one frame for its first two
 * seconds), then its middle and last frame.
 */
async function openingFrames(video, cacheDir, name) {
  const info = await probe(video);
  const total = Math.max(1, info.frames);
  const fps = info.fps || 24;
  const early = [0.3, 0.8, 1.4, 2.2].map(s => Math.round(s * fps));
  const picks = [...new Set([...early, Math.round(total / 2), total - 1].map(f => Math.min(total - 1, Math.max(0, f))))].sort((a, b) => a - b);
  const parts = [];
  for (const frame of picks) {
    const path = join(cacheDir, `${name}-f${frame}.jpg`);
    if (!existsSync(path)) writeFileSync(path, await sharp(await frameImage(video, frame)).resize(768, 768, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer());
    parts.push({ type: 'text', text: `Frame ${frame} of ${total} (${(frame / fps).toFixed(1)} s${frame === total - 1 ? ', the last frame' : ''}):` }, await imagePart(path, { longEdge: 768 }));
  }
  return parts;
}

/**
 * Audit one click. `still` is the picture the visitor tapped, `at` where (0–1
 * fractions), `video` the rendered film (or null: then the direction alone is
 * judged). Returns the model's answer plus `basis` ("film" or "direction").
 */
export async function auditClick(llm, { name, label, hint = '', target = '', still, at, video = null, direction = '', destination = '', outline = null, cacheDir, mature = false }) {
  mkdirSync(cacheDir, { recursive: true });
  const marked = outline && existsSync(outline) ? outline : await markedStill(still, at, join(cacheDir, `${name}-marked.jpg`));
  const text = [
    `A visitor to an interactive film world taps a thing in the picture below (ringed in magenta${outline ? ', or tinted magenta' : ''}). Its label says "${label}"${hint ? ` and its hint says "${hint}"` : ''}.${target ? ` The thing is: ${target}.` : ''}`,
    destination ? `The film then takes the visitor to: ${destination}.` : 'The film then plays and returns to the same picture.',
    'The label is a promise. The film\'s first action has to be aimed at the tapped thing: the thing itself moves, opens, lights or speaks; or a character goes straight to it and does what the label says to it (picks it, tips it, climbs into it); or the camera goes straight to it, along it or through it. A film whose first action heads somewhere else (another person, another object, a doorway that is not the tapped one, a camera move elsewhere) is misaligned, however good it looks, even when it reaches the right destination.',
    'Weak means the visible action contradicts the label (it says go inside and the film never goes in), not that some word is not acted out in full. Judge only what pictures can show: sound verbs (ring, hear, listen, ask, answer, call) are kept by the right thing being the focus. A label that only names the thing ("The telescope") promises only that the film starts with it. The destination\'s description is where the film ends, not part of the promise. In an 18+ world, a choice that ends in a death is fine if the visitor first does the labelled thing. Use only the words given here: do not quote hints or labels that are not above.',
    video ? 'Judge the frames of the rendered film below, which show what actually happened. The written direction is only context.' : 'There is no rendered film yet: judge the written direction.',
    direction ? `The written direction: ${direction}` : null,
    'Reply with JSON {"clicked": "what the marked thing is, in a few words", "firstMotion": "what happens first in the film, in a sentence", "clickedThingLeads": true if the film’s first action is aimed at the tapped thing, "doesWhatLabelSays": true if the film does what the label promises, "verdict": "aligned" | "weak" (it starts with the thing, but the label promises something it barely does) | "misaligned", "why": "one or two sentences", "fix": "one sentence: how the film should begin instead so the click and the film agree, keeping the same destination (empty when aligned)"}.',
  ].filter(Boolean).join('\n');
  const user = [
    { type: 'text', text },
    { type: 'text', text: 'The picture, with the tapped thing marked:' }, await imagePart(marked),
    ...(video ? await openingFrames(video, cacheDir, name) : []),
  ];
  const ask = round => llm.json({
    system: `You check interactive films against what the visitor clicked. You are literal: you report what the pictures show, not what the words hoped for. Left and right are as seen in the picture.${mature ? ' The world is an 18+ horror world; gore and frightening imagery are intended.' : ''}`,
    user,
    schema: AUDIT_SCHEMA,
    purpose: `audit-click-${name}${round ? `-${round}` : ''}`,
    maxTokens: 2000,
    temperature: round ? 0.4 : 0.1,
  });
  // One answer is not stable enough to fail a film on: a flag is asked twice more and the majority stands.
  const answers = [await ask(0)];
  if (answers[0].verdict !== 'aligned') answers.push(await ask(1), await ask(2));
  const votes = answers.map(a => a.verdict);
  const count = v => votes.filter(x => x === v).length;
  const verdict = votes.length === 1 ? votes[0] : count('aligned') >= 2 ? 'aligned' : count('misaligned') >= 2 ? 'misaligned' : 'weak';
  const chosen = answers.find(a => a.verdict === verdict) ?? answers[0];
  return { ...chosen, verdict, votes, basis: video ? 'film' : 'direction' };
}
