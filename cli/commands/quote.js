import { parse } from '../index.js';
import { resolveWorldId } from '../lib/paths.js';
import { filmsOf, readPlan, revealSpeech } from '../lib/plan.js';
import { secondsOf } from '../lib/h3.js';
import { isSeedance } from '../lib/seedance.js';
import { connect, describeBilling, LINKS, quoteFilm } from '../lib/sogni.js';
import { log, usd } from '../lib/log.js';
import { canvasOf, filmBilling, filmRender, filmsToRender } from './render.js';
import { canaryStatus } from '../lib/canary.js';
import { gather, nextAction, nextStep } from './status.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ANCHOR_SCRIPT, speechEstimate, voiceRequest, voiceRuns } from './narrate.js';
import { SPEECH_MODELS } from '../lib/audio.js';
import { musicEstimate } from './music.js';
import { wantsFigure } from './figures.js';
import { figureEstimate, figureFiles } from '../lib/figures.js';
import { EDIT_MODEL } from '../lib/paint.js';
import { readJson } from '../lib/files.js';
import { filmId } from '../lib/paths.js';

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
  const narrate = [
    ...plan.places.filter(p => p.narration?.lines?.length && (values.all || !existsSync(join(paths.audio, 'narration', `${p.id}.json`)))),
    // A close look's line, spoken by the place's narrator.
    ...revealSpeech(plan).filter(r => values.all || !existsSync(join(paths.audio, 'narration', 'reveals', `${r.id}.json`))),
  ];
  const music = plan.music?.prompt && (values.all || !existsSync(join(paths.audio, 'music', 'music.json'))) ? plan.music : null;
  const figures = plan.places.flatMap(place => place.objects.filter(wantsFigure).map(object => filmId(place.id, object.id)))
    .filter(key => values.all || readJson(figureFiles(paths, key).receipt, null)?.status !== 'completed');
  if (!entries.length && !narrate.length && !music && !figures.length) {
    log.ok('Nothing left to make');
    log.next(nextStep(id));
    return 0;
  }

  const session = await connect();
  try {
    const rows = [];
    for (const { film, state } of entries) {
      const render = filmRender(film, canvas);
      const paying = filmBilling(film, session.billing);
      const quote = await quoteFilm(session.client, { model: render.model, width: render.width, height: render.height, frames: film.frames,
        keyframes: film.keyframes?.length ?? 0, tokenType: paying.tokenType, billingMode: paying.mode });
      rows.push({ film: film.id, kind: film.kind, state, model: render.model, frames: film.frames, seconds: Number(secondsOf(film.frames).toFixed(2)),
        ...quote, ...(isSeedance(render.model) ? { paidInTokens: true } : {}) });
    }
    const total = rows.reduce((sum, row) => ({ spark: sum.spark + row.spark, usd: sum.usd + row.usd, seconds: sum.seconds + row.seconds }), { spark: 0, usd: 0, seconds: 0 });
    // Seedance is a premium model an Unlimited plan does not cover: those rows are paid in tokens whatever the plan.
    const premium = rows.filter(row => row.paidInTokens);
    const premiumTotal = { spark: premium.reduce((sum, row) => sum + row.spark, 0), usd: premium.reduce((sum, row) => sum + row.usd, 0) };
    const covered = session.billing.mode === 'subscription';

    // Narration (one take per place) and music, priced by Sogni's own estimates.
    const audio = [];
    for (const place of narrate) {
      try {
        // One take per run of one voice (a conversation has several), each priced by its characters.
        const row = { item: `narration: ${place.id}`, usd: 0, token: 0 };
        for (const run of voiceRuns(place)) {
          const { request, needsSample } = voiceRequest(plan, paths, { ...place, narration: { ...place.narration, voice: run.voice, lines: run.lines } }, { quote: true });
          const estimate = await speechEstimate(session, request);
          row.usd += estimate.usd; row.token += estimate.token;
          // A designed voice is designed once on a fixed passage, then cloned for every place.
          if (needsSample && !audio.some(item => item.item === `voice design: ${needsSample} (once)`)) {
            audio.push({ item: `voice design: ${needsSample} (once)`, ...(await speechEstimate(session, { modelId: SPEECH_MODELS.design, positivePrompt: ANCHOR_SCRIPT })) });
          }
        }
        audio.push(row);
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
    if (figures.length) {
      try {
        const each = await figureEstimate(session);
        audio.push({ item: `figures: ${figures.length} (plate + Pixal3D + BiRefNet)`, usd: each.usd * figures.length, token: each.token * figures.length });
      } catch (error) {
        audio.push({ item: 'figures', error: error.message });
      }
    }
    // Close looks still to paint: three Qwen Image Edit candidates each.
    const looks = plan.places.flatMap(place => place.objects.filter(o => !o.goes && o.reveal?.paint && !o.reveal.still));
    if (looks.length) {
      try {
        const canvas = canvasOf(plan);
        const estimate = await session.client.projects.estimateCost({ network: 'fast', tokenType: session.billing.tokenType, model: EDIT_MODEL, imageCount: 3 * looks.length,
          stepCount: 20, previewCount: 0, guidance: 4, width: canvas.width, height: canvas.height, billingMode: session.billing.mode });
        audio.push({ item: `close looks: ${looks.length} (3 candidates each, Qwen Image Edit)`, usd: Number(estimate.usd), token: Number(estimate.token) });
      } catch (error) {
        audio.push({ item: 'close looks', error: error.message });
      }
    }
    const audioUsd = audio.reduce((sum, row) => sum + (row.usd || 0), 0);

    if (values.json) {
      const canary = canaryStatus(plan, paths);
      const canaryRows = rows.filter(row => canary.ids.includes(row.film));
      const canaryTotal = { spark: canaryRows.reduce((sum, row) => sum + row.spark, 0), usd: canaryRows.reduce((sum, row) => sum + row.usd, 0) };
      console.log(JSON.stringify({ billing: session.billing, covered, rows, total, ...(premium.length ? { paidInTokens: premiumTotal } : {}), audio, audioUsd, canary: { ...canary, total: canaryTotal } }, null, 2));
      return 0;
    }
    log.title(`Quote for ${id} — ${canvas.width}×${canvas.height} canvas, delivered at ${canvas.width * 2}×${canvas.height * 2}`);
    for (const row of rows) log.info(`${row.film.padEnd(34)} ${row.kind.padEnd(8)} ${row.seconds.toFixed(2).padStart(6)} s  ${row.spark.toFixed(0).padStart(5)} Spark  ${usd(row.usd).padStart(7)}${row.paidInTokens ? `  ${row.model}, paid in tokens` : ''}`);
    if (rows.length) log.step(`${rows.length} film${rows.length === 1 ? '' : 's'}, ${(total.seconds / 60).toFixed(1)} minutes of 2K film: ${total.spark.toFixed(0)} Spark (${usd(total.usd)}) at pay-as-you-go prices`);
    for (const row of audio) log.info(`${row.item.padEnd(34)} ${row.error ? `could not quote: ${row.error}` : `$${row.usd.toFixed(3)}`}`);
    if (audio.length) log.step(`Narration, music and figures: about $${audioUsd.toFixed(2)} at pay-as-you-go prices${rows.length ? `; everything together about ${usd(total.usd + audioUsd)}` : ''}`);
    const canary = canaryStatus(plan, paths);
    const canaryRows = rows.filter(row => canary.ids.includes(row.film));
    if (!['approved', 'none'].includes(canary.state) && canaryRows.length) {
      const spark = canaryRows.reduce((sum, row) => sum + row.spark, 0);
      const cost = canaryRows.reduce((sum, row) => sum + row.usd, 0);
      log.step(`The canary, rendered first (${canaryRows.map(row => row.film).join(' + ')}): ${spark.toFixed(0)} Spark (${usd(cost)}). The rest waits until the person approves it.`);
    }
    log.info(`Account: ${session.username} · Billing: ${describeBilling(session.billing)}`);
    if (premium.length) log.step(`${premium.length} Seedance film${premium.length === 1 ? '' : 's'}: ${premiumTotal.spark.toFixed(0)} Spark (${usd(premiumTotal.usd)}), paid from your token balance${covered ? ' (no Unlimited plan covers Seedance)' : ''}. Each take costs this again, so it is one take per film, and a retake only after its cause is fixed.`);
    if (covered) log.ok(premium.length ? 'Your Unlimited plan covers the MiniMax H3 renders: nothing is charged for them (fair-use limits apply).' : 'Your Unlimited plan covers these renders: nothing is charged (fair-use limits apply).');
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
