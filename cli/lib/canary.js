// The canary: one crossing and one loop, rendered first and judged by a person
// before anything else in the world is spent on. `render` refuses the rest
// until both are approved, and `next` never suggests otherwise.
import { filmsOf } from './plan.js';
import { filmState, listTakes, readNotes, readVerdicts } from './takes.js';

/** The first crossing and the first loop in story order (the first film when a world has neither). */
export function canaryFilms(plan) {
  const films = filmsOf(plan);
  const picked = [films.find(film => film.kind === 'crossing'), films.find(film => film.kind === 'loop')].filter(Boolean);
  return picked.length ? picked : films.slice(0, 1);
}

// When canary films are in different states, the one that most needs doing is reported.
const PRECEDENCE = ['rendering', 'failed', 'rejected', 'unrendered', 'unjudged'];

/**
 * Where the canary stands: `approved`, or the first state still in the way,
 * with the films in that state. { ids, films: [{ id, state }], state, waiting }
 */
export function canaryStatus(plan, paths, verdicts = readVerdicts(paths), notes = readNotes(paths)) {
  const films = canaryFilms(plan).map(film => ({ id: film.id, state: filmState(listTakes(paths, film.id, verdicts, notes)) }));
  if (!films.length) return { ids: [], films, state: 'none', waiting: [] };
  const state = films.every(film => film.state === 'approved') ? 'approved' : PRECEDENCE.find(s => films.some(film => film.state === s));
  return { ids: films.map(film => film.id), films, state, waiting: films.filter(film => film.state === state).map(film => film.id) };
}

/** What stands between the canary and approval, as { why, command }; null once approved. */
export function canaryNext(status, id) {
  const only = status.waiting.map(film => `--only ${film}`).join(' ');
  switch (status.state) {
    case 'approved': case 'none': return null;
    case 'rendering': return { why: 'the canary is still rendering', command: `node world render ${id} --canary   (picks it up; nothing is submitted twice)` };
    case 'unrendered': return { why: 'the canary is not rendered yet', command: `node world quote ${id}   — then: node world render ${id} --canary` };
    case 'failed': return { why: `the canary (${status.waiting.join(', ')}) failed to render`, command: `node world render ${id} ${only}` };
    case 'rejected': return { why: `the canary (${status.waiting.join(', ')}) was rejected`, command: `rewrite that film's direction in world.yaml for what the verdict says went wrong, then: node world render ${id} ${only}` };
    default: return { why: 'the canary awaits a verdict', command: `node world screen ${id}   — look at both takes, then the person reviews them: node world review ${id}` };
  }
}

/**
 * Why a render run may not go ahead: it would render films other than the
 * canary before the canary is approved. Returns an error message or null.
 */
export function canaryGate(status, selectedIds, id) {
  if (['approved', 'none'].includes(status.state)) return null;
  const others = selectedIds.filter(film => !status.ids.includes(film));
  if (!others.length) return null;
  const next = canaryNext(status, id);
  return `The canary (${status.ids.join(' and ')}) is not approved yet, so the other ${others.length} film${others.length === 1 ? '' : 's'} wait${others.length === 1 ? 's' : ''}: a person judges one crossing and one loop before the rest of the world is spent on.\n`
    + `  Now: ${next.command}\n  (${next.why})\n`
    + '  Only if the person has agreed to skip the canary: add --skip-canary';
}
