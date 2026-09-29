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

const flat = text => String(text ?? '').replace(/\s+/g, ' ').trim();
/** Table-safe text: the person approves what they read, so nothing is cut. */
const cell = text => flat(text).replace(/\|/g, '\\|');
/** Wrap text to lines of at most `width` characters, for the terminal. */
const wrap = (text, width) => {
  const lines = [];
  let line = '';
  for (const word of flat(text).split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
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

const narratedPlaces = plan => plan.places.filter(p => p.narration?.lines?.length);
const musicOf = plan => (!plan.music ? 'none' : plan.music.file ? `your file ${plan.music.file}` : `generated: "${flat(plan.music.prompt)}"`);
const lineText = line => flat(typeof line === 'string' ? line : line?.text);

/** The plan as Markdown to paste into a message: every word, nothing cut. */
export function planMarkdown(plan, id) {
  const out = [`**${plan.title || id}**${plan.story ? ` — ${flat(plan.story)}` : ''}\n`];
  out.push('| Place | Click | What happens | Idea | Length |\n| --- | --- | --- | --- | --- |');
  for (const r of planRows(plan)) out.push(`| ${cell(r.place)} | ${cell(r.click)}${r.canary ? ' ★' : ''} | ${cell(r.happens)} | ${cell(r.idea)} | ${r.seconds ? `${r.seconds.toFixed(1)} s` : '?'} |`);
  out.push(`\n★ rendered first (the canary) · music: ${musicOf(plan)}`);
  const narrated = narratedPlaces(plan);
  if (narrated.length) {
    out.push('\n**Narration**');
    for (const place of narrated) out.push(`- ${place.title || place.id}: ${place.narration.lines.map(line => `“${lineText(line)}”`).join(' ')}`);
  }
  return out.join('\n');
}

export async function run(argv) {
  const { values, world } = parse(argv, { markdown: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan } = readPlan(id);
  if (values.markdown) {
    console.log(planMarkdown(plan, id));
    return 0;
  }
  const rows = planRows(plan);
  const narrated = narratedPlaces(plan).map(p => p.title || p.id);
  const music = musicOf(plan);

  log.title(`${plan.title || id} — the plan`);
  if (plan.story) for (const line of wrap(plan.story, 96)) log.info(line);
  let lastPlace = null;
  for (const r of rows) {
    if (r.place !== lastPlace) { console.log(`\n  ${r.place}`); lastPlace = r.place; }
    log.info(`  ${r.canary ? '★' : ' '} ${r.click} → ${r.happens}${r.seconds ? ` (${r.seconds.toFixed(1)} s)` : ''}`);
    for (const line of wrap(r.idea, 90)) log.info(`      ${line}`);
  }
  if (narrated.length) {
    console.log('\n  Narration');
    for (const place of narratedPlaces(plan)) for (const line of wrap(`${place.title || place.id}: ${place.narration.lines.map(l => `“${lineText(l)}”`).join(' ')}`, 92)) log.info(`  ${line}`);
  }
  console.log('');
  log.info(`★ rendered first, as the canary · ${rows.length} film${rows.length === 1 ? '' : 's'} · narration: ${narrated.length ? narrated.join(', ') : 'none'} · music: ${music}`);
  log.next(`show this to the person (node world plan ${id} --markdown gives a table to paste), get their OK, then: node world next ${id}`);
  return 0;
}
