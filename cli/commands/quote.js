import { parse } from '../index.js';
import { resolveWorldId } from '../lib/paths.js';
import { filmsOf, readPlan } from '../lib/plan.js';
import { MODEL, secondsOf } from '../lib/h3.js';
import { connect, describeBilling, LINKS, quoteFilm } from '../lib/sogni.js';
import { log, usd } from '../lib/log.js';
import { canvasOf, filmsToRender } from './render.js';

export const summary = 'Price the films still to render (free: nothing is submitted)';
export const usage = 'node world quote [world] [--all] [--json]';

export async function run(argv) {
  const { values, world } = parse(argv, { all: { type: 'boolean' }, json: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const canvas = canvasOf(plan);
  const entries = values.all
    ? filmsOf(plan).map(film => ({ film, state: 'all' }))
    : filmsToRender(plan, paths).filter(entry => entry.state !== 'rendering');
  if (!entries.length) {
    log.ok('Nothing left to render');
    return 0;
  }

  const session = await connect();
  try {
    const rows = [];
    for (const { film, state } of entries) {
      const quote = await quoteFilm(session.client, { model: MODEL, width: canvas.width, height: canvas.height, frames: film.frames,
        keyframes: film.keyframes?.length ?? 0, tokenType: session.billing.tokenType, billingMode: session.billing.mode });
      rows.push({ film: film.id, kind: film.kind, state, frames: film.frames, seconds: Number(secondsOf(film.frames).toFixed(2)), ...quote });
    }
    const total = rows.reduce((sum, row) => ({ spark: sum.spark + row.spark, usd: sum.usd + row.usd, seconds: sum.seconds + row.seconds }), { spark: 0, usd: 0, seconds: 0 });
    const covered = session.billing.mode === 'subscription';
    if (values.json) {
      console.log(JSON.stringify({ billing: session.billing, covered, rows, total }, null, 2));
      return 0;
    }
    log.title(`Quote for ${id} — ${canvas.width}×${canvas.height} canvas, delivered at ${canvas.width * 2}×${canvas.height * 2}`);
    for (const row of rows) log.info(`${row.film.padEnd(34)} ${row.kind.padEnd(8)} ${row.seconds.toFixed(2).padStart(6)} s  ${row.spark.toFixed(0).padStart(5)} Spark  ${usd(row.usd).padStart(7)}`);
    log.step(`${rows.length} film${rows.length === 1 ? '' : 's'}, ${(total.seconds / 60).toFixed(1)} minutes of 2K film: ${total.spark.toFixed(0)} Spark (${usd(total.usd)}) at pay-as-you-go prices`);
    log.info(`Account: ${session.username} · Billing: ${describeBilling(session.billing)}`);
    if (covered) log.ok('Your Unlimited plan covers these renders: nothing is charged (fair-use limits apply).');
    else log.info(`Retakes add to this. An Unlimited plan covers every film instead: ${LINKS.plans}`);
    const firstRun = filmsOf(plan).every(film => !filmsToRender(plan, paths, { only: [film.id] })[0].takes.length);
    log.next(`node world render ${id}${firstRun ? ' --canary' : ''}`);
    return 0;
  } finally {
    session.close();
  }
}
