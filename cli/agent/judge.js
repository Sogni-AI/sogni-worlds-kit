// Judging takes and fixing directions. The agent may reject a take that is
// clearly broken (the reject-on-sight list) and must say why; it never
// approves one. A rejected film gets a rewritten direction that removes the
// cause, never just another seed.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { frameImage } from '../lib/screen.js';
import { clickCauses, lintDirection } from '../lib/lint.js';
import { imagePart } from '../lib/llm.js';
import { FRAME_GRID, writerSystem } from './prompts.js';

const REJECT_ON_SIGHT = [
  'a dissolve or crossfade between the two pictures, or a fade through black',
  'a morph (a wall that becomes a sky, a person who becomes another person)',
  'a hard cut or a sudden jump in the middle',
  'invented lettering on signs, patches or number plates',
  'a real person\'s face drifting into someone else\'s',
  'smeared struts from a bridge or tower route',
  'a frozen tail (the last seconds don\'t move) or a flash at a loop\'s seam',
  'the film plainly ignores its direction (the camera goes somewhere else)',
  'the film ignores what the visitor clicked: the clicked thing plays no part, or the film does something other than its label promises',
];

const JUDGE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'clickedThingLeads', 'defects', 'summary'],
  properties: {
    verdict: { type: 'string', enum: ['keep', 'reject'] },
    clickedThingLeads: { type: 'boolean' },
    defects: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['what', 'when', 'cause'], properties: { what: { type: 'string' }, when: { type: 'string' }, cause: { type: 'string' } } } },
    summary: { type: 'string', minLength: 10 },
  },
};

/** Up to eight frames of the take: flagged ones, the opening at fixed times, then the rest spread out. */
async function takeFrames(take, cacheDir) {
  const total = take.screen?.probe?.frames ?? take.journal.frames;
  const flagged = (take.screen?.flags ?? []).filter(f => Number.isInteger(f.frame)).map(f => f.frame);
  // The opening at fixed times (whether the clicked thing leads shows in the first seconds), then the rest spread out.
  const early = [12, 36].map(f => Math.min(total - 1, f));
  const spread = [0, 0.35, 0.7, 1].map(t => Math.min(total - 1, Math.round(t * (total - 1))));
  const wanted = [...new Set([...flagged.slice(0, 2), ...early, ...spread])].sort((a, b) => a - b).slice(0, 8);
  mkdirSync(cacheDir, { recursive: true });
  const parts = [];
  for (const frame of wanted) {
    const path = join(cacheDir, `${take.film}-t${take.take}-f${frame}.jpg`);
    writeFileSync(path, await sharp(await frameImage(take.files.video, frame)).resize(1024, 1024, { fit: 'inside' }).jpeg({ quality: 85 }).toBuffer());
    parts.push({ type: 'text', text: `Frame ${frame} of ${total} (${(frame / 24).toFixed(1)} s):` }, await imagePart(path));
  }
  return parts;
}

/** Look at one finished take. Returns { verdict: keep|reject, defects, summary }. */
export async function judgeTake(llm, { take, film, object = null, fromSeen, toSeen, cacheDir, mature = false }) {
  const flags = (take.screen?.flags ?? []).map(f => `${f.severity}: ${f.message}${Number.isInteger(f.frame) ? ` (frame ${f.frame})` : ''}`);
  const text = [
    `A ${film.kind} film, take ${take.take} of "${film.id}". It should start on the picture described as: ${fromSeen}`,
    object ? `The visitor clicked: ${object.target || object.label}, labelled "${object.label}"${object.hint ? ` (${object.hint})` : ''}. That thing must lead the film and the film must do what the label promises; "clickedThingLeads" says whether it does, judged from the frames.` : 'It is the place\'s living picture (nothing was clicked).',
    film.kind === 'crossing' ? `and end on the picture described as: ${toSeen}` : 'and end back on the same picture.',
    `Its direction: ${film.action}`,
    `Its sound: ${film.sound}`,
    flags.length ? `The automatic screen flagged: ${flags.join(' | ')}` : 'The automatic screen flagged nothing.',
    '',
    'Look at the frames below, in order. Reject the take only for one of these defects, which nobody should have to watch:',
    ...REJECT_ON_SIGHT.map(d => `- ${d}`),
    'Anything else (a slightly different motion, a small detail) is for the person to judge: keep it. Two frames that differ a lot are normal in a crossing that travels.',
    'Reply with JSON {"verdict": "keep" | "reject", "clickedThingLeads": true | false (true for a living picture), "defects": [{"what", "when" (frame numbers or seconds), "cause" (which words of the direction most likely caused it)}], "summary": "one or two sentences for the person: what happens in this take and anything worth checking"}. A film whose clicked thing plays no part is rejected.',
  ].join('\n');
  return llm.json({
    system: `You screen short generated films for a person who will make the final call. You are careful and literal: you report what the frames show.${mature ? ' The world is an 18+ horror world; gore and frightening imagery are intended, not defects.' : ''}`,
    user: [{ type: 'text', text }, ...await takeFrames(take, cacheDir)],
    schema: JUDGE_SCHEMA,
    purpose: `judge-${film.id}-t${take.take}`,
    maxTokens: 3000,
    temperature: 0.1,
  });
}

const RETAKE_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['diagnosis', 'film'],
  properties: {
    diagnosis: { type: 'string', minLength: 10 },
    film: {
      type: 'object', additionalProperties: false, required: ['frames', 'idea', 'action', 'sound'],
      properties: { frames: { type: 'integer', enum: FRAME_GRID }, idea: { type: 'string' }, action: { type: 'string', minLength: 150 }, sound: { type: 'string', minLength: 20 } },
    },
  },
};

/** Rewrite a rejected film's direction so the observed defect has no cause left in the words. */
export async function rewriteFilm(llm, { film, label, hint, target = '', objectId = '', reasons, fromStill, toStill, fromSeen, toSeen, mature }) {
  const kind = film.kind;
  const text = [
    `This ${kind} film was rejected. Rewrite its direction so the defect cannot happen again. Another seed on the same words repeats the same failure: change the words that caused it (the route, the camera move, what passes through the frame, the length), and keep everything that was right.`,
    `Why it was rejected: ${reasons.join(' | ')}`,
    label ? `What the visitor clicked: "${label}" (${hint ?? ''}). That object must still cause the film and lead it: keep the route through it, and change how it happens, never what it is.` : 'It is the place\'s loop.',
    `Start picture (seen): ${fromSeen}`,
    kind === 'crossing' ? `End picture (seen): ${toSeen}` : 'It ends back on the start picture.',
    `The rejected direction: ${JSON.stringify({ frames: film.frames, idea: film.idea, action: film.action, sound: film.sound })}`,
    `Reply with JSON {"diagnosis": "which words caused the defect and what you changed", "film": {"frames", "idea", "action", "sound"}}.${kind === 'loop' ? ' A loop is always 192 frames.' : ''}`,
  ].join('\n');
  const drift = answer => (label ? clickCauses({ label, target, id: objectId }, answer.film) : null);
  const check = answer => lintDirection({ ...answer.film, kind }, `${label ?? ''} ${hint ?? ''} ${answer.film.idea}`)
    .filter(f => f.level === 'error' || ['face-turn', 'dark-screen', 'static'].includes(f.rule))
    .map(f => `${f.level === 'error' ? '' : '(warning) '}film ${f.field}: ${f.message}`)
    // A retake changes how the clicked thing does it, never what was clicked: drifting off it is an error here.
    .concat(drift(answer) ? [`film action: ${drift(answer)}. Keep the route through ${target || label}`] : [])
    .concat(kind === 'loop' && answer.film.frames !== 192 ? ['a loop is 192 frames'] : [])
    // The same words render the same failure: a rewrite has to change the action or the sound.
    .concat(answer.film.action.trim() === String(film.action).trim() && answer.film.sound.trim() === String(film.sound).trim() ? ['film: the direction is unchanged; change the words that caused the rejection'] : []);
  return llm.json({
    system: writerSystem({ mature }),
    user: [
      { type: 'text', text },
      { type: 'text', text: 'The start picture:' }, await imagePart(fromStill),
      ...(kind === 'crossing' ? [{ type: 'text', text: 'The end picture:' }, await imagePart(toStill)] : []),
    ],
    schema: RETAKE_SCHEMA,
    check,
    rounds: 4,
    purpose: `retake-${film.id}`,
    maxTokens: 8000,
  });
}
