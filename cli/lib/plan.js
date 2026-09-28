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
//                           film: { frames, idea, action, sound, keyframes: [{ image, frame }] }
//
// Coordinates are fractions of the still's width and height (0..1).
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { parseDocument, stringify } from 'yaml';
import { worldPaths, filmId, loopId } from './paths.js';
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
 * Every film the plan asks for, in story order:
 *   loop      a living photograph: the place's still at both ends, static camera
 *   crossing  a journey from one place's still to another's, caused by an object
 *   moment    something that happens here, caused by an object, ending back on the still
 */
export function filmsOf(plan) {
  const films = [];
  for (const place of plan.places) {
    if (place.loop) {
      films.push({ id: loopId(place.id), kind: 'loop', from: place.id, to: place.id, object: null, ...place.loop, frames: place.loop.frames ?? LOOP_FRAMES });
    }
    for (const object of place.objects) {
      if (!object.film) continue;
      films.push({
        id: filmId(place.id, object.id),
        kind: object.goes ? 'crossing' : 'moment',
        from: place.id,
        to: object.goes ?? place.id,
        object: object.id,
        ...object.film,
      });
    }
  }
  return films;
}

/** The place after this one in a linear story (the last returns to the first). */
export function nextPlaceId(plan, placeId) {
  const ids = plan.places.map(place => place.id);
  const index = ids.indexOf(placeId);
  return index < 0 ? null : ids[(index + 1) % ids.length];
}
