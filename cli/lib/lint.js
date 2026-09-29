// What `node world lint` checks. Two kinds of findings:
//   error  the render would be wrong or wasted; `render` refuses until it is fixed
//   warn   worth a look; often a real problem, sometimes deliberate
//
// The direction rules follow MiniMax's own H3 Base prompt guide and the
// defects that got real takes rejected (docs/directing-films.md explains each).
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { assemblePrompt, CANVASES, isValidFrames, PROMPT_LIMIT, VALID_FRAMES } from './h3.js';
import { filmsOf, placeById } from './plan.js';
import { isInsideWorld } from './paths.js';

const ID = /^[a-z0-9][a-z0-9-]*$/;
const NEGATION = /\b(no|not|never|without|nothing|none|nobody|neither|nor|don't|doesn't|didn't|isn't|aren't|won't|cannot|can't)\b/i;
const MUSIC = /\b(music|songs?|melod(?:y|ies|ic)|doo[- ]wop|soundtrack|instrumental|orchestral|singing|sings|musical|club bass|dance beats?|rock[- ]and[- ]roll|jazz|techno)\b/i;
/** A film about music may show and sound it: the label, hint or idea names singing, a song, dancing or an instrument. */
const MUSIC_CONCEPT = /\b(dance|dances|dancing|sing|sings|singing|singers?|song|songs|music|musical|musicians?|band|choir|concert|guitar|guitarist|piano|drums?|drummer|violin|fiddle|ukulele|trumpet|saxophone|waiata|busker)\b/i;
const TRANSITION_WORDS = /\b(cross[- ]?dissolv\w*|cross[- ]?fad\w*|dissolv(?:e|es|ing)|fad(?:e|es|ing) (?:in|out|to|from|into)|morph(?:s|ing)? (?:into|through))\b/i;
const MATERIALIZES = /\b(?:mirror|frame|door|doorway|portal)\b[^.!?\n]{0,40}\b(?:materializ\w*|appears? out of nowhere|pops? into existence)\b/i;
const DARK_SCREEN = /\b(?:black|dark(?:ness)?)\b[^.!?\n]{0,65}\b(?:fills?|covers?|conceals?|hides?)\b[^.!?\n]{0,30}\b(?:lens|screen|frame|view)\b|\b(?:lens|screen|frame|view)\b[^.!?\n]{0,40}\b(?:goes|turns|becomes) (?:black|dark)\b/i;

/**
 * Sentences whose camera runs onto, along, over or through a bridge, tower or
 * any lattice of struts. H3 flies such a route through the structure and the
 * struts smear across the lens (a real crossing failed this twice). Pass a
 * lattice far below or far to one side, or go around it.
 */
const LATTICE = String.raw`(?:bridges?|towers?|struts?|girders?|gantry|gantries|scaffold(?:ing)?|pylons?|trusses|truss|mesh sides)`;
const CAMERA_MOVES = String.raw`(?:glides?|flies|fly|travels?|pass(?:es)?|moves?|swoops?|drifts?|cross(?:es)?|races?|rushes|dives?|sweeps?|descends?|rises?|climbs?|cranes?|pushes|push|tracks?|follows?)`;
const THROUGH = new RegExp(String.raw`\b${CAMERA_MOVES}\b(?:\s+[\w’'-]+){0,3}?\s+(?:onto|along|over|across|through|between|under|past)\b[^.,;:]*\b${LATTICE}`, 'i');
const CLEAR = /\bfar (?:below|beneath|off|away|to (?:the|one) (?:left|right|side))\b|\bin the distance\b/i;
export const throughLattice = action => String(action).split(/(?<=[.!?])\s+/).filter(sentence => THROUGH.test(sentence) && !CLEAR.test(sentence));

const spoken = text => text.replace(/<d>[\s\S]*?<\/d>/g, '');
const unquoted = text => text.replace(/"[^"]*"|“[^”]*”/g, '');

/**
 * Findings for one film's direction: `action` is the [Shot 1] body (what the
 * camera and the picture do, in one continuous shot), `sound` is the
 * soundscape. `concept` is the label, hint and idea, used to allow music in a
 * film that is about music.
 */
/** Birdsong is ambience, not music: "a tūī sings", "skylarks singing". */
const BIRDSONG = /(?<!\p{L})(?:birds?|songbirds?|tūī|tui|skylarks?|larks?|bellbirds?|blackbirds?|thrush(?:es)?|robins?|magpies?|finch(?:es)?|wrens?|warblers?|nightingales?|cicadas?|frogs?|whales?)(?:[\s,]+[\p{L}’'-]+){0,4}?[\s,]+(?:sings?|singing)(?!\p{L})/giu;

/**
 * The direction rules, each with an id a film can `allow` (with a reason)
 * when a take made with it was approved anyway. An allowed error is printed
 * as a warning, so the exception stays visible.
 */
export const RULES = {
  frames: 'frames on the H3 grid',
  length: 'enough description',
  opening: 'opens on Picture 1',
  'one-shot': 'one continuous shot',
  negation: 'no negations',
  capitals: 'no capitals',
  timestamps: 'no timestamps',
  sound: 'a soundscape',
  dialogue: 'dialogue markup',
  sentences: 'capitalised sentences',
  music: 'no unrequested music',
  transition: 'no fades, dissolves or morphs',
  materialize: 'no materializing props',
  lattice: 'no routes through bridges or towers',
  'dark-screen': 'no dark-screen crossings',
  static: 'static camera for loops and moments',
  keyframes: 'valid keyframes',
  'prompt-length': 'prompt within 7000 characters',
};

/**
 * Findings for one film's direction: `action` is the [Shot 1] body (what the
 * camera and the picture do, in one continuous shot), `sound` is the
 * soundscape. `concept` is the label, hint and idea, used to allow music in a
 * film that is about music. `film.allow` lists rule ids to downgrade.
 */
export function lintDirection(film, concept = '') {
  const issues = [];
  const allowed = new Set(Array.isArray(film.allow) ? film.allow : Object.keys(film.allow ?? {}));
  // Every finding names the field it is about, and quotes the words that set it off.
  const error = (rule, field, message) => issues.push(allowed.has(rule) ? { level: 'warn', rule, field, message: `allowed: ${message}` } : { level: 'error', rule, field, message });
  const warn = (rule, field, message) => issues.push({ level: 'warn', rule, field, message: allowed.has(rule) ? `allowed: ${message}` : message });
  const action = String(film.action ?? '').replace(/\s+/g, ' ').trim();
  const sound = String(film.sound ?? '').replace(/\s+/g, ' ').trim();
  const fields = { action, sound };
  const quote = match => `"${String(match).slice(0, 60)}"`;

  if (!isValidFrames(film.frames)) error('frames', 'frames', `frames must be one of ${VALID_FRAMES.join(', ')} (got ${film.frames})`);
  if (action.length < 120) error('length', 'action', 'describe the motion in more detail (under 120 characters)');
  if (!/established by Picture 1/.test(action)) error('opening', 'action', 'open on the first frame: "…, a wide shot begins in (or: holds) the position and framing established by Picture 1: …"');
  const shot = /\[Shot [2-9]\]/.exec(action);
  if (shot) error('one-shot', 'action', `${quote(shot[0])} — keep one continuous shot`);
  for (const [field, text] of Object.entries(fields)) {
    const plain = unquoted(spoken(text));
    const negation = NEGATION.exec(plain);
    if (negation) error('negation', field, `${quote(negation[0])} — state only what is there; a negation names the thing you do not want`);
    const capitals = /\b[A-Z]{3,}\b/.exec(plain.replace(/\[English\]/g, ''));
    if (capitals) error('capitals', field, `${quote(capitals[0])} — no words in capitals (put visible lettering in "double quotes")`);
    const lowerStart = /[.!?]\s+[a-z][\w’'-]*/.exec(plain);
    if (lowerStart) error('sentences', field, `${quote(lowerStart[0].replace(/^[.!?]\s+/, ''))} — start every sentence with a capital letter`);
    const musical = spoken(text).replace(BIRDSONG, '');
    const music = MUSIC.exec(musical);
    if (!MUSIC_CONCEPT.test(concept) && music) error('music', field, `${quote(music[0])} — describe dialogue, ambience and physical sounds only; this asks for music the film is not about`);
  }
  const clock = /\b\d{1,2}:\d{2}(\.\d+)?\b/.exec(action);
  if (clock) error('timestamps', 'action', `${quote(clock[0])} — no timestamps inside one shot; order events with words ("as it clears the crest…")`);
  if (!sound) error('sound', 'sound', 'describe the soundscape: ambience, physical sounds, non-verbal human sounds');
  if (/<d>/.test(sound)) error('dialogue', 'sound', 'spoken words belong in the action, never in the sound');
  const badDialogue = /<d>(?!\[English\] )/.exec(`${action}\n${sound}`);
  if (badDialogue) error('dialogue', /<d>(?!\[English\] )/.test(action) ? 'action' : 'sound', 'write every spoken line as <d>[English] the words</d>');
  // What the picture does. A sound that "fades into the wind" is fine; a picture that fades or dissolves is not.
  const transition = TRANSITION_WORDS.exec(spoken(action));
  if (transition) error('transition', 'action', `${quote(transition[0])} — describe a physical crossing; fades, dissolves and morphs are rejected on sight`);
  const materializes = MATERIALIZES.exec(spoken(action));
  if (materializes) error('materialize', 'action', `${quote(materializes[0])} — the object that carries the crossing must already be in the picture; it cannot materialize`);
  for (const sentence of throughLattice(action)) error('lattice', 'action', `"${sentence.slice(0, 90)}…" — route the camera far below, far to one side or around the structure; flying along or through a bridge or tower smears its struts`);
  const dark = DARK_SCREEN.exec(spoken(action));
  if (dark) warn('dark-screen', 'action', `${quote(dark[0])} — a dark screen is not a physical crossing: keep the occluding surface and its moving edge visible`);
  if (film.kind === 'loop' && !/\bstatic\b/i.test(action)) error('static', 'action', 'a living photograph keeps the camera still: "a static wide shot holds the position and framing established by Picture 1: …"');
  if (film.kind === 'moment' && !/\bstatic\b/i.test(action)) warn('static', 'action', 'a moment ends on the same picture it starts from; a static camera is the safe way to get there');
  const keyframes = film.keyframes ?? [];
  if (keyframes.length > 8) error('keyframes', 'keyframes', 'at most 8 keyframes');
  for (const keyframe of keyframes) {
    if (!Number.isInteger(keyframe?.frame) || keyframe.frame < 1 || keyframe.frame > film.frames - 2) error('keyframes', 'keyframes', `keyframe frame must be a whole number from 1 to ${film.frames - 2} (got ${keyframe?.frame})`);
    if (!keyframe?.image) error('keyframes', 'keyframes', 'each keyframe needs an image');
  }
  if (!issues.some(issue => issue.level === 'error')) {
    const prompt = assemblePrompt(film);
    if (prompt.length > PROMPT_LIMIT) error('prompt-length', 'action', `the assembled prompt is ${prompt.length} characters; H3 reads ${PROMPT_LIMIT}`);
  }
  for (const rule of allowed) if (!RULES[rule]) issues.push({ level: 'error', rule: 'allow', field: 'allow', message: `allow names an unknown rule "${rule}" (rules: ${Object.keys(RULES).join(', ')})` });
  return issues;
}

const inUnit = point => Array.isArray(point) && point.length === 2 && point.every(v => typeof v === 'number' && v >= 0 && v <= 1);

/**
 * Every finding for a plan: [{ level, where, message }]. `checkFiles: false`
 * skips files that only exist on the machine that ingested the photos (used
 * for the examples, which ship without their photographs).
 */
export function lintPlan(plan, paths, { checkFiles = true } = {}) {
  const findings = [];
  const add = (level, where, message) => findings.push({ level, where, message });
  const file = relative => join(paths.dir, relative);
  // Paths come from the plan, which may come from someone else: never outside the world's folder.
  const contained = (where, label, relative) => {
    if (relative === undefined || relative === null || relative === '') return true;
    if (isInsideWorld(paths.dir, relative)) return true;
    add('error', where, `${label} "${relative}" is outside the world's folder: use a path inside it, such as stills/harbour.jpg`);
    return false;
  };

  if (!ID.test(String(plan.id ?? ''))) add('error', 'id', 'use lower-case letters, digits and dashes');
  if (!plan.title) add('warn', 'title', 'give the world a title');
  if (!plan.canvas) add('warn', 'canvas', 'not set yet: `node world ingest` picks it from your photos');
  else if (!CANVASES.some(c => `${c.width}x${c.height}` === plan.canvas || c.name === plan.canvas)) add('error', 'canvas', `use one of ${CANVASES.map(c => `${c.width}x${c.height}`).join(', ')}`);
  if (!['linear', 'free'].includes(plan.order)) add('error', 'order', 'use linear or free');
  if (!plan.places.length) add('warn', 'places', 'no places yet: put photos in photos/ and run `node world ingest`');

  const ids = new Set();
  for (const place of plan.places) {
    const where = `places.${place.id}`;
    if (!ID.test(String(place.id ?? ''))) add('error', where, 'place id: use lower-case letters, digits and dashes');
    if (ids.has(place.id)) add('error', where, 'two places share this id');
    ids.add(place.id);
    if (!place.still) add('error', where, 'no still: run `node world ingest`');
    else if (contained(where, 'still', place.still) && checkFiles && !existsSync(file(place.still))) add('error', where, `${place.still} is missing`);
    contained(where, 'photo', place.photo);
    if (!place.title) add('warn', where, 'give the place a title');
    if (!place.seen) add('warn', where, 'write `seen`: what is really in the picture, after looking at it at full size');
    if (place.narration) {
      // lines: "text" in the narration's voice, or { voice, text } for another speaker.
      const voice = place.narration.voice;
      if (voice && !plan.voices[voice]) add('error', `${where}.narration`, `voice "${voice}" is not defined under voices`);
      const lines = place.narration.lines;
      if (!Array.isArray(lines) || !lines.length) add('error', `${where}.narration`, 'add at least one line');
      for (const line of Array.isArray(lines) ? lines : []) {
        const text = typeof line === 'string' ? line : line?.text;
        if (!text) add('error', `${where}.narration`, 'each line is "text" or { voice, text }');
        const lineVoice = typeof line === 'object' ? line?.voice : null;
        if (lineVoice && !plan.voices[lineVoice]) add('error', `${where}.narration`, `voice "${lineVoice}" is not defined under voices`);
        if (!voice && !lineVoice) add('error', `${where}.narration`, 'say which voice reads it: narration.voice, or voice on the line');
      }
    }
    const objectIds = new Set();
    for (const object of place.objects) {
      const at = `${where}.objects.${object.id}`;
      if (!ID.test(String(object.id ?? ''))) add('error', at, 'object id: use lower-case letters, digits and dashes');
      if (objectIds.has(object.id)) add('error', at, 'two objects in this place share this id');
      objectIds.add(object.id);
      if (object.id === 'loop') add('error', at, '"loop" is reserved for the living photograph');
      if (!object.label) add('error', at, 'give it a label: what happens, as an action ("Duck through the round door")');
      if (object.at !== undefined && !inUnit(object.at)) add('error', at, '`at` is [x, y] with each between 0 and 1');
      if (object.at === undefined && !object.select?.positive?.length) add('warn', at, 'add `at` (where the label sits)');
      if (object.select) {
        const { positive = [], negative = [], box, text } = object.select;
        if (!positive.length && !text) add('error', `${at}.select`, 'click at least one positive point on the object (or give `text`)');
        for (const point of [...positive, ...negative]) if (!inUnit(point)) add('error', `${at}.select`, `point ${JSON.stringify(point)} is outside 0..1`);
        if (box !== undefined && !(Array.isArray(box) && box.length === 4 && box.every(v => v >= 0 && v <= 1) && box[0] < box[2] && box[1] < box[3])) {
          add('error', `${at}.select`, 'box is [x0, y0, x1, y1] with x0 < x1 and y0 < y1, all within 0..1');
        }
      } else if (object.film) add('warn', at, 'no `select` clicks: it will have a label but no outline');
      if (object.goes !== undefined && object.goes !== null) {
        if (object.goes === place.id) add('error', at, 'a film that returns here is a moment: remove `goes`');
        else if (!plan.places.some(p => p.id === object.goes)) add('error', at, `goes to "${object.goes}", which is not a place`);
      }
      if (!object.film) add('warn', at, 'no film yet: nothing happens when it is clicked');
    }
  }
  if (plan.start && plan.places.length && !ids.has(plan.start)) add('error', 'start', `"${plan.start}" is not a place`);

  for (const film of filmsOf(plan)) {
    const place = placeById(plan, film.from);
    const object = film.object ? place.objects.find(o => o.id === film.object) : null;
    const concept = [object?.label, object?.hint, film.idea].filter(Boolean).join(' ');
    for (const issue of lintDirection(film, concept)) add(issue.level, `films.${film.id}${issue.field ? `.${issue.field}` : ''}`, issue.message);
    for (const keyframe of film.keyframes ?? []) {
      if (keyframe?.image && contained(`films.${film.id}.keyframes`, 'keyframe image', keyframe.image) && checkFiles && !existsSync(file(keyframe.image))) add('error', `films.${film.id}.keyframes`, `keyframe ${keyframe.image} is missing`);
    }
  }

  for (const [name, voice] of Object.entries(plan.voices)) {
    if (voice?.clone) {
      if (!voice.transcript) add('error', `voices.${name}`, 'a cloned voice needs the exact transcript of its recording');
      if (contained(`voices.${name}`, 'recording', voice.clone) && checkFiles && !existsSync(file(voice.clone))) add('error', `voices.${name}`, `${voice.clone} is missing`);
    } else if (!voice?.design) add('error', `voices.${name}`, 'give `clone` (a recording you own) or `design` (a description)');
  }
  if (plan.music) {
    if (plan.music.file) {
      if (contained('music', 'music file', plan.music.file) && checkFiles && !existsSync(file(plan.music.file))) add('error', 'music', `${plan.music.file} is missing`);
    } else if (!plan.music.prompt) add('error', 'music', 'give a `prompt` to generate music, or a `file` you have the rights to');
  }

  // Can a visitor reach every place?
  if (plan.places.length > 1) {
    const start = plan.start || plan.places[0].id;
    const seen = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const place = placeById(plan, queue.shift());
      for (const object of place?.objects ?? []) {
        if (object.goes && object.film && !seen.has(object.goes)) { seen.add(object.goes); queue.push(object.goes); }
      }
    }
    for (const place of plan.places) if (!seen.has(place.id)) add('warn', `places.${place.id}`, `no film leads here from "${start}"`);
    if (plan.order === 'linear') {
      plan.places.forEach((place, index) => {
        const next = plan.places[index + 1];
        if (next && !place.objects.some(o => o.goes === next.id)) add('warn', `places.${place.id}`, `a story told in order needs a way on to the next place, "${next.id}"`);
      });
    }
  }
  return findings;
}
