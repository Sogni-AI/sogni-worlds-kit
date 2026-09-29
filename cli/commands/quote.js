import { parse } from '../index.js';
import { resolveWorldId } from '../lib/paths.js';
import { filmsOf, readPlan } from '../lib/plan.js';
import { MODEL, secondsOf } from '../lib/h3.js';
import { connect, describeBilling, LINKS, quoteFilm } from '../lib/sogni.js';
import { log, usd } from '../lib/log.js';
import { canvasOf, filmsToRender } from './render.js';
import { canaryStatus } from '../lib/canary.js';
import { gather, nextAction, nextStep } from './status.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { speechEstimate, voiceRequest } from './narrate.js';
import { musicEstimate } from './music.js';

export const summary = 'Price the films, narration and music still to make (free: nothing is submitted)';
export const usage = 'node world quote [world] [--all] [--json]';

export async function run(argv) {
  const { values, world } = parse(argv, { all: { type: 'boolean' }, json: { type: 'boolean' } });
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const canvas = canvasOf(plan);
  const entries = values.all
    ? filmsOf(plan).map(film => ({ film, state: 'all' }))
    : filmsToRender(plan, paths).filter(entry => entry.state !== 'rendering');
  const narrate = plan.places.filter(p => p.narration?.lines?.length && (values.all || !existsSync(join(paths.audio, 'narration', `${p.id}.json`))));
  const music = plan.music?.prompt && (values.all || !existsSync(join(paths.audio, 'music', 'music.json'))) ? plan.music : null;
  if (!entries.length && !narrate.length && !music) {
    log.ok('Nothing left to make');
    log.next(nextStep(id));
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

    // Narration (one take per place) and music, priced by Sogni's own estimates.
    const audio = [];
    for (const place of narrate) {
      try {
        const { request } = voiceRequest(plan, paths, place);
        audio.push({ item: `narration: ${place.id}`, ...(await speechEstimate(session, request)) });
      } catch (error) {
        audio.push({ item: `narration: ${place.id}`, error: error.message });
      }
    }
    if (music) {
      try {
        const estimate = await musicEstimate(session, music);
        audio.push({ item: `music: ${estimate.seconds} s`, usd: estimate.usd, token: estimate.token });
      } catch (error) {
        audio.push({ item: 'music', error: error.message });
      }
    }
    const audioUsd = audio.reduce((sum, row) => sum + (row.usd || 0), 0);

    if (values.json) {
      const canary = canaryStatus(plan, paths);
      const canaryRows = rows.filter(row => canary.ids.includes(row.film));
      const canaryTotal = { spark: canaryRows.reduce((sum, row) => sum + row.spark, 0), usd: canaryRows.reduce((sum, row) => sum + row.usd, 0) };
      console.log(JSON.stringify({ billing: session.billing, covered, rows, total, audio, audioUsd, canary: { ...canary, total: canaryTotal } }, null, 2));
      return 0;
    }
    log.title(`Quote for ${id} — ${canvas.width}×${canvas.height} canvas, delivered at ${canvas.width * 2}×${canvas.height * 2}`);
    for (const row of rows) log.info(`${row.film.padEnd(34)} ${row.kind.padEnd(8)} ${row.seconds.toFixed(2).padStart(6)} s  ${row.spark.toFixed(0).padStart(5)} Spark  ${usd(row.usd).padStart(7)}`);
    if (rows.length) log.step(`${rows.length} film${rows.length === 1 ? '' : 's'}, ${(total.seconds / 60).toFixed(1)} minutes of 2K film: ${total.spark.toFixed(0)} Spark (${usd(total.usd)}) at pay-as-you-go prices`);
    for (const row of audio) log.info(`${row.item.padEnd(34)} ${row.error ? `could not quote: ${row.error}` : `$${row.usd.toFixed(3)}`}`);
    if (audio.length) log.step(`Narration and music: about $${audioUsd.toFixed(2)} at pay-as-you-go prices${rows.length ? `; everything together about ${usd(total.usd + audioUsd)}` : ''}`);
    const canary = canaryStatus(plan, paths);
    const canaryRows = rows.filter(row => canary.ids.includes(row.film));
    if (!['approved', 'none'].includes(canary.state) && canaryRows.length) {
      const spark = canaryRows.reduce((sum, row) => sum + row.spark, 0);
      const cost = canaryRows.reduce((sum, row) => sum + row.usd, 0);
      log.step(`The canary, rendered first (${canaryRows.map(row => row.film).join(' + ')}): ${spark.toFixed(0)} Spark (${usd(cost)}). The rest waits until the person approves it.`);
    }
    log.info(`Account: ${session.username} · Billing: ${describeBilling(session.billing)}`);
    if (covered) log.ok('Your Unlimited plan covers these renders: nothing is charged (fair-use limits apply).');
    else log.info(`Retakes add to this. An Unlimited plan covers every film instead: ${LINKS.plans}`);
    // After a quote, `next` (quote, then render) moves on to its render step.
    const next = nextAction(gather(id));
    const render = /then: (node world render \S+(?: --canary)?)\s*$/.exec(next.command)?.[1];
    log.next(render ? `${render}\n      (${next.why})` : nextStep(id));
    return 0;
  } finally {
    session.close();
  }
}
