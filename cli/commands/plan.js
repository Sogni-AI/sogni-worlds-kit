import { parse } from '../index.js';
import { resolveWorldId } from '../lib/paths.js';
import { filmsOf, readPlan } from '../lib/plan.js';
import { secondsOf } from '../lib/h3.js';
import { canaryFilms } from '../lib/canary.js';
import { log } from '../lib/log.js';

export const summary = 'Show the plan as a table to approve before anything is spent: places, what to click, where it leads';
export const usage = `node world plan [world] [--markdown]

  One row per film: the place, what you click, what happens (where it goes, or a
  moment that stays), the one-line idea and its length. Loops, narration and
  music are listed per place. The canary (rendered first) is marked.
  --markdown prints a Markdown table to paste into a message.`;

const cut = (text, width) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
};

/** Plan rows: one per film, in story order. */
export function planRows(plan) {
  const canary = new Set(canaryFilms(plan).map(film => film.id));
  const titles = Object.fromEntries(plan.places.map(place => [place.id, place.title || place.id]));
  return filmsOf(plan).map(film => {
    const object = film.object ? plan.places.find(p => p.id === film.from)?.objects.find(o => o.id === film.object) : null;
    return {
      film: film.id,
      place: titles[film.from],
      click: film.kind === 'loop' ? '(the living photograph)' : object?.label ?? film.object,
      happens: film.kind === 'crossing' ? `goes to ${titles[film.to]}${object?.shortcut ? ' (shortcut)' : ''}` : film.kind === 'moment' ? 'a moment, stays here' : 'loops',
      idea: film.idea ?? '',
      seconds: Number.isFinite(film.frames) ? secondsOf(film.frames) : null,
      canary: canary.has(film.id),
    };
  });
}

export async function run(argv) {
  const { values, world } = parse(argv, { markdown: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan } = readPlan(id);
  const rows = planRows(plan);
  const narrated = plan.places.filter(p => p.narration?.lines?.length).map(p => p.title || p.id);
  const music = !plan.music ? 'none' : plan.music.file ? `your file ${plan.music.file}` : `generated: "${cut(plan.music.prompt, 80)}"`;

  if (values.markdown) {
    console.log(`**${plan.title || id}**${plan.story ? ` — ${cut(plan.story, 200)}` : ''}\n`);
    console.log('| Place | Click | What happens | Idea | Length |\n| --- | --- | --- | --- | --- |');
    for (const r of rows) console.log(`| ${r.place} | ${r.click}${r.canary ? ' ★' : ''} | ${r.happens} | ${cut(r.idea, 120)} | ${r.seconds ? `${r.seconds.toFixed(1)} s` : '?'} |`);
    console.log(`\n★ rendered first (the canary) · narration: ${narrated.length ? narrated.join(', ') : 'none'} · music: ${music}`);
    return 0;
  }

  log.title(`${plan.title || id} — the plan`);
  if (plan.story) log.info(cut(plan.story, 300));
  let lastPlace = null;
  for (const r of rows) {
    if (r.place !== lastPlace) { console.log(`\n  ${r.place}`); lastPlace = r.place; }
    log.info(`  ${r.canary ? '★' : ' '} ${cut(r.click, 34).padEnd(34)} ${cut(r.happens, 30).padEnd(30)} ${r.seconds ? `${r.seconds.toFixed(1).padStart(5)} s` : '    ?'}  ${cut(r.idea, 80)}`);
  }
  console.log('');
  log.info(`★ rendered first, as the canary · ${rows.length} film${rows.length === 1 ? '' : 's'} · narration: ${narrated.length ? narrated.join(', ') : 'none'} · music: ${music}`);
  log.next(`show this to the person (node world plan ${id} --markdown gives a table to paste), get their OK, then: node world next ${id}`);
  return 0;
}
