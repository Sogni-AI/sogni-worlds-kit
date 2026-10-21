// world.yaml: the plan of one world. Your agent writes it, you approve it, and
// every command reads it. Reference: docs/world-yaml.md. Shape, in short:
//
//   id, title, subtitle, story, order (linear|free), start, canvas, contentFilter
//   voices:  { <name>: { clone: voices/x.m4a, transcript } | { design: "..." } }
//   music:   { prompt, seconds } | { file, credit }
//   places:  - id, photo, still, title, chapter, caption, seen,
//              narration: { voice, lines: [...] },
//              loop:      { frames, idea, action, sound },
//              objects:   - id, label, hint, at: [x, y],
//                           select: { positive: [[x, y]], negative: [[x, y]], box: [x0, y0, x1, y1] },
//                           goes: <place id>   (omit for a moment that stays here),
//                           shortcut: true|false,
//                           film: { frames, idea, action, sound, camera, keyframes: [{ image, frame }] },
//                           reveal: { paint, still, seen, line, done,
//                                     back: { frames, idea, action, sound } }   (a moment that holds on a close look)
//
// Coordinates are fractions of the still's width and height (0..1).
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseDocument, stringify } from 'yaml';
import { worldPaths, filmId, loopId, backId } from './paths.js';
import { LOOP_FRAMES } from './h3.js';

export function readPlan(id) {
  const paths = worldPaths(id);
  if (!existsSync(paths.plan)) throw new Error(`worlds/${id}/world.yaml is missing`);
  const text = readFileSync(paths.plan, 'utf8');
  const doc = parseDocument(text, { keepSourceTokens: false });
  if (doc.errors.length) throw new Error(`worlds/${id}/world.yaml does not parse: ${doc.errors[0].message}`);
  return { doc, plan: normalize(doc.toJS() ?? {}), paths };
}

/** Write a plan back, keeping the comments and order already in the file. */
export function writePlan(id, doc) {
  const { plan } = worldPaths(id);
  const tmp = `${plan}.${process.pid}.tmp`;
  writeFileSync(tmp, doc.toString({ lineWidth: 0 }));
  renameSync(tmp, plan);
}

export const toYaml = value => stringify(value, { lineWidth: 0 });

function normalize(plan) {
  plan.places = Array.isArray(plan.places) ? plan.places : [];
  for (const place of plan.places) {
    place.objects = Array.isArray(place.objects) ? place.objects : [];
  }
  plan.voices = plan.voices ?? {};
  plan.order = plan.order ?? 'linear';
  return plan;
}

export const placeById = (plan, id) => plan.places.find(place => place.id === id);

/**
 * Every film the plan asks for, in story order, each with the stills it
 * starts and ends on (`first`, `last`: paths inside the world's folder):
 *   loop      a living photograph: the place's still at both ends, a locked camera
 *   crossing  a journey from one place's still to another's, caused by an object
 *   moment    something that happens here, caused by an object, ending back on the still
 *   reveal    an object's film into a close look (its reveal still), where the
 *             world holds while the visitor reads, listens or turns a figure over
 *   back      the film from that close look back to the place's still
 */
export function filmsOf(plan) {
  const films = [];
  const stillOf = id => placeById(plan, id)?.still;
  for (const place of plan.places) {
    if (place.loop) {
      films.push({ id: loopId(place.id), kind: 'loop', from: place.id, to: place.id, object: null, ...place.loop, frames: place.loop.frames ?? LOOP_FRAMES, first: place.still, last: place.still });
    }
    for (const object of place.objects) {
      if (!object.film) continue;
      const reveal = !object.goes && object.reveal ? object.reveal : null;
      films.push({
        id: filmId(place.id, object.id),
        kind: object.goes ? 'crossing' : reveal ? 'reveal' : 'moment',
        from: place.id,
        to: object.goes ?? place.id,
        object: object.id,
        ...object.film,
        first: place.still,
        last: object.goes ? stillOf(object.goes) : reveal ? reveal.still : place.still,
      });
      if (reveal?.back) {
        films.push({ id: backId(place.id, object.id), kind: 'back', from: place.id, to: place.id, object: object.id, ...reveal.back, first: reveal.still, last: place.still });
      }
    }
  }
  return films;
}

/**
 * A picture a person can look at and mark: a place's still (by place id), or
 * an object's close look (by <place>-<object>). Returns { id, still } or null.
 */
export function pictureById(plan, id) {
  const place = placeById(plan, id);
  if (place) return { id: place.id, still: place.still };
  for (const p of plan.places) for (const object of p.objects ?? []) {
    if (object.reveal?.still && `${p.id}-${object.id}` === id) return { id, still: object.reveal.still };
  }
  return null;
}

/** The picture id of a film's first and last stills (see pictureById). */
export function endPictures(film) {
  const close = `${film.from}-${film.object}`;
  if (film.kind === 'reveal') return { from: film.from, to: close };
  if (film.kind === 'back') return { from: close, to: film.from };
  return { from: film.from, to: film.to };
}

/** What a film's first and last stills show (their `seen`), to write and judge it against. */
export function endsSeen(plan, film) {
  const place = placeById(plan, film.from);
  const reveal = film.object ? place?.objects.find(object => object.id === film.object)?.reveal : null;
  const close = reveal?.seen || reveal?.paint || '';
  if (film.kind === 'reveal') return { fromSeen: place?.seen ?? '', toSeen: close };
  if (film.kind === 'back') return { fromSeen: close, toSeen: place?.seen ?? '' };
  return { fromSeen: place?.seen ?? '', toSeen: placeById(plan, film.to)?.seen ?? '' };
}

/**
 * Every object's reveal line, as something to speak: `<place>-<object>`, in the
 * reveal's own voice, else its place's narrator, else the world's first voice,
 * so the clue is said by the voice that tells the rest of the story.
 */
export function revealSpeech(plan) {
  const out = [];
  for (const place of plan.places) for (const object of place.objects ?? []) {
    const line = object.reveal?.line;
    if (!line || object.goes) continue;
    const voice = object.reveal.voice ?? place.narration?.voice ?? Object.keys(plan.voices ?? {})[0];
    out.push({ id: `${place.id}-${object.id}`, reveal: true, narration: { voice, speaker: place.narration?.speaker, lines: [String(line)] } });
  }
  return out;
}

/** The place after this one in a linear story (the last returns to the first). */
export function nextPlaceId(plan, placeId) {
  const ids = plan.places.map(place => place.id);
  const index = ids.indexOf(placeId);
  return index < 0 ? null : ids[(index + 1) % ids.length];
}
