// agent: build a world with Sogni's own LLMs doing the agent's job, for
// people who don't have Claude Code, Codex or Hermes. Same pipeline, same
// checks, same rule that only the person approves a take. The agent asks
// what only the person can tell it, then plans, points, renders, screens and
// retakes, and stops where the person's judgement is needed.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parse } from '../index.js';
import { shown, worldPaths, filmId, loopId } from '../lib/paths.js';
import { filmsOf, readPlan, writePlan } from '../lib/plan.js';
import { lintPlan } from '../lib/lint.js';
import { readJson, writeJson } from '../lib/files.js';
import { filmState, listTakes, readNotes, readVerdicts, addNote, recordVerdict } from '../lib/takes.js';
import { connect, describeBilling } from '../lib/sogni.js';
import { Llm, MODELS } from '../lib/llm.js';
import { log, usd } from '../lib/log.js';
import { confirm, interview, loadBriefFile, missingAnswers, placePhotos, readBrief, writeBrief } from '../agent/brief.js';
import { writeBible, paintPlaces } from '../agent/concept.js';
import { lookAt, writePlace, writeWorld } from '../agent/write.js';
import { checkOutline, locate, selectionResult } from '../agent/point.js';
import { judgeTake, rewriteFilm } from '../agent/judge.js';
import { gather } from './status.js';
import { wantsFigure } from './figures.js';
import { figureFiles } from '../lib/figures.js';

export const summary = 'Let Sogni\'s own LLM be your agent: it plans, points, renders and screens; you direct and approve';
export const usage = `node world agent <world> [--brief <file>] [--until <stage>] [--retakes <n>]

  Builds the world end to end on your Sogni API key alone, with Sogni's LLMs
  (DeepSeek V4 Flash writes and judges, Qwen 3.6 points at objects) doing
  the work a coding agent would. It asks you what only you can say (what the
  world is about, who is in the photos, the story of each place), shows you
  the plan and the quote before spending, and leaves every approval to you
  on the review page. Stop it at any time; running it again picks up.

  --brief <file>   your answers in a file, for an unattended run (see
                   docs/agent.md). Standing approvals in it ("approvals:")
                   let it go on without asking.
  --until <stage>  stop after: plan, select, render, build, review (default:
                   review — it ends by opening your review page)
  --review-port <n>  where the review page is served (default 4700)
  --no-open        print the review page's address instead of opening it
  --retakes <n>    how many times it may rewrite and re-render a film it
                   rejected itself (default 2)

  Models: SOGNI_AGENT_MODEL (default ${MODELS.writer}),
          SOGNI_AGENT_POINTER_MODEL (default ${MODELS.pointer}).`;

const STAGES = ['plan', 'select', 'render', 'build', 'review'];

export async function run(argv) {
  const { values, world } = parse(argv, { brief: { type: 'string' }, until: { type: 'string', default: 'review' }, retakes: { type: 'string', default: '2' },
    'review-port': { type: 'string', default: '4700' }, 'no-open': { type: 'boolean', default: false } });
  if (!STAGES.includes(values.until)) throw new Error(`--until is one of ${STAGES.join(', ')}`);
  let brief = values.brief ? loadBriefFile(values.brief) : null;
  const id = world ?? brief?.id;
  if (!id) throw new Error(`Name the world: ${usage.split('\n')[0]}`);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('A world id uses lower-case letters, digits and dashes, e.g. "my-trip"');
  const paths = worldPaths(id);
  const stateFile = join(paths.dir, 'agent', 'state.json');

  // 1. The brief: the person's answers, asked once and kept.
  brief = { ...(readBrief(paths) ?? {}), ...(brief ?? {}) };
  if (missingAnswers(brief).length) {
    if (!process.stdin.isTTY) throw new Error(`The brief is missing: ${missingAnswers(brief).map(([k]) => k).join(', ')}. Pass --brief <file> or run this in a terminal`);
    log.title('A few questions first (only you can answer these)');
    brief = await interview(brief);
  }
  if (!existsSync(paths.plan)) {
    const { run: create } = await import('./new.js');
    await create([id, '--title', brief.title ?? id.split('-').map(w => w[0].toUpperCase() + w.slice(1)).join(' ')]);
  }
  writeBrief(paths, brief);
  const state = readJson(stateFile, {});
  const save = () => writeJson(stateFile, state);

  const session = await connect({ appId: `sogni-worlds-agent-${id}` });
  const llm = new Llm({ client: session.client, billing: session.billing, logFile: join(paths.dir, 'agent', 'llm.jsonl'), concurrency: Number(process.env.SOGNI_AGENT_CONCURRENCY || (session.tier === 'unlimited_pro' ? 4 : 2)) });
  const mature = Boolean(brief.paint?.mature || brief.mature);
  let closed = false;
  try {
    log.title(`Building "${id}" with Sogni's LLMs`);
    log.step(`Signed in as ${session.username}. Billing: ${describeBilling(session.billing)}`);
    log.dim(`Writer and judge: ${MODELS.writer}. Pointer: ${MODELS.pointer}. Every call is logged in ${shown(join(paths.dir, 'agent', 'llm.jsonl'))}`);

    // 2. Pictures: the person's photos in story order, or painted places.
    if (brief.photos?.length) {
      placePhotos(paths, brief);
    } else if (brief.paint) {
      const references = (brief.paint.references ?? []).map(ref => ({ ...ref, file: ref.file }));
      if (!state.bible) {
        log.step('Planning the world from your concept');
        const { imagePart } = await import('../lib/llm.js');
        const referenceParts = (await Promise.all(references.map(async (ref, i) => [{ type: 'text', text: `Reference ${i} (${ref.who}):` }, await imagePart(ref.file)]))).flat();
        state.bible = await writeBible(llm, { brief, referenceParts });
        save();
        log.ok(`"${state.bible.title}": ${state.bible.places.map(p => p.id + (p.ending.kind !== 'none' ? ` (${p.ending.kind})` : '')).join(' → ')}`);
      }
      await paintPlaces(llm, session, { paths, brief, bible: state.bible, references, say: log });
    } else {
      throw new Error('The brief has neither photos nor a concept to paint');
    }

    // 3. Stills.
    let status = gather(id);
    if (status.photosNotIngested || status.stillsMissing.length) {
      const { run: ingest } = await import('./ingest.js');
      await ingest([id]);
    }

    // 4. Look at every still.
    let { doc, plan } = readPlan(id);
    state.look ??= {};
    // Photos were numbered in the brief's order, and ingest keeps that order.
    const storyOf = place => brief.photos?.[plan.places.indexOf(place)]?.story ?? null;
    await Promise.all(plan.places.map(async place => {
      if (state.look[place.id]) return;
      log.step(`Looking at ${place.id}`);
      state.look[place.id] = await lookAt(llm, { stillPath: join(paths.dir, place.still), story: storyOf(place), about: brief.about });
      save();
    }));
    plan.places.forEach((place, i) => doc.setIn(['places', i, 'seen'], state.look[place.id].seen));
    writePlan(id, doc);

    // 5. The world's own fields: title, story, narrator, music.
    if (!state.world) {
      state.world = await writeWorld(llm, { brief, places: plan.places.map(p => ({ id: p.id, seen: state.look[p.id].seen })), given: state.bible ? { title: brief.title ?? state.bible.title, subtitle: state.bible.subtitle, story: state.bible.story } : {} });
      save();
    }
    ({ doc, plan } = readPlan(id));
    doc.set('title', state.world.title);
    doc.set('subtitle', state.world.subtitle);
    doc.set('story', state.world.story);
    doc.set('contentFilter', 'off');
    doc.set('order', brief.order ?? (brief.paint ? 'free' : 'linear'));
    if (brief.narration?.voice === 'design' && state.world.narrator) doc.set('voices', doc.createNode({ narrator: { design: state.world.narrator } }));
    if (brief.music && state.world.music) doc.set('music', doc.createNode({ prompt: state.world.music, seconds: brief.music.seconds ?? 120 }));
    if (brief.intro) doc.set('intro', doc.createNode(brief.intro));
    if (brief.map === false) doc.set('map', false);
    writePlan(id, doc);

    // 6. Write every place: title, narration, loop, objects and their films.
    ({ doc, plan } = readPlan(id));
    const bibleOf = place => state.bible?.places.find(p => p.id === place.id) ?? null;
    const context = {
      brief, mature, title: state.world.title, story: state.world.story, style: state.bible?.style ?? null,
      order: plan.order ?? 'linear',
      mechanics: brief.mechanics ?? {},
      links: (state.bible?.links ?? []).map(l => ({ from: l.from, to: l.to, via: `the ${l.via}`, why: 'a route in the world\'s plan' })),
      places: plan.places.map(place => {
        const b = bibleOf(place);
        const look = state.look[place.id];
        return {
          id: place.id, title: b?.title ?? place.title, still: place.still, seen: look.seen, framing: look.framing, people: look.people, clickable: look.clickable,
          story: storyOf(place), idea: b?.idea ?? null, must: b ? b.clickables : brief.photos?.[plan.places.indexOf(place)]?.objects ?? null,
          ending: b && b.ending.kind !== 'none' ? b.ending : null, collectible: b?.collectible || null,
        };
      }),
    };
    const stills = Object.fromEntries(plan.places.map(p => [p.id, join(paths.dir, p.still)]));
    state.places ??= {};
    for (const [index, place] of context.places.entries()) {
      if (state.places[place.id]) { place.titleWritten = state.places[place.id].answer.title; continue; }
      log.step(`Writing ${place.id}`);
      const { answer, review } = await writePlace(llm, { place, index, context, stillPath: stills[place.id], destinationStills: stills });
      state.places[place.id] = { answer, review };
      save();
      context.places[index].title = answer.title;
      context.places[index].titleWritten = answer.title;
      if (review.length) log.dim(`${place.id}: its own review fixed ${review.length} thing${review.length === 1 ? '' : 's'}: ${review.map(r => `${r.film} (${r.rule})`).join(', ')}`);
    }
    ({ doc, plan } = readPlan(id));
    plan.places.forEach((place, i) => {
      const a = state.places[place.id].answer;
      const extra = context.places[i];
      doc.setIn(['places', i, 'title'], a.title);
      if (a.chapter) doc.setIn(['places', i, 'chapter'], a.chapter);
      doc.setIn(['places', i, 'caption'], a.caption);
      if (a.narration.length && brief.narration?.voice !== 'none') doc.setIn(['places', i, 'narration'], doc.createNode({ voice: 'narrator', lines: a.narration }));
      if (extra.ending) doc.setIn(['places', i, 'ending'], doc.createNode({ kind: extra.ending.kind, title: extra.ending.title, text: extra.ending.text }));
      // An ending's card covers its picture, so it needs no loop of its own.
      if (extra.ending) doc.deleteIn(['places', i, 'loop']);
      else doc.setIn(['places', i, 'loop'], doc.createNode({ frames: 192, idea: a.loop.idea, action: a.loop.action, sound: a.loop.sound }));
      const existing = place.objects ?? [];
      doc.setIn(['places', i, 'objects'], doc.createNode(a.objects.map(o => {
        const before = existing.find(e => e.id === o.id);
        return clean({
          id: o.id, label: o.label, hint: o.hint, target: o.target,
          at: before?.at, select: before?.select,
          goes: o.goes || undefined, shortcut: o.goes && o.shortcut ? true : undefined, collect: o.collect ? true : undefined,
          film: { frames: o.film.frames, idea: o.film.idea, action: o.film.action, sound: o.film.sound },
        });
      })));
    });
    writePlan(id, doc);
    ({ plan } = readPlan(id));
    const errors = lintPlan(plan, paths).filter(f => f.level === 'error');
    for (const f of lintPlan(plan, paths)) (f.level === 'error' ? log.fail : log.warn)(`${f.where}: ${f.message}`);
    if (errors.length) throw new Error(`The plan still has ${errors.length} error${errors.length === 1 ? '' : 's'} after the agent's fixes; see above (node world lint ${id})`);
    log.ok(`The plan is written: ${plan.places.length} places, ${filmsOf(plan).length} films. Lint is clean.`);
    const { run: showPlan } = await import('./plan.js');
    await showPlan([id]);
    if (!await confirm(brief, 'plan', 'Is this the plan you want? Nothing has been spent yet.')) {
      log.next(`edit worlds/${id}/world.yaml or the brief, then run node world agent ${id} again`);
      return 0;
    }
    if (values.until === 'plan') return 0;

    // 7. Point at every object and trace it.
    ({ doc, plan } = readPlan(id));
    state.select ??= {};
    const { run: select } = await import('./select.js');
    for (const [pi, place] of plan.places.entries()) {
      for (const [oi, object] of place.objects.entries()) {
        const key = filmId(place.id, object.id);
        if (state.select[key]?.done) continue;
        const attempts = state.select[key]?.attempts ?? [];
        let feedback = attempts.at(-1)?.check?.what ?? null;
        for (let tries = attempts.length; tries < 4; tries++) {
          const located = await locate(llm, { stillPath: stills[place.id], target: object.target ?? object.label, feedback });
          ({ doc } = readPlan(id));
          const sel = tries === 3 && feedback ? { ...located.select, text: (object.target ?? object.label).replace(/^the\s+/i, ''), instances: 1 } : located.select;
          doc.setIn(['places', pi, 'objects', oi, 'select'], doc.createNode(sel, { flow: true }));
          doc.setIn(['places', pi, 'objects', oi, 'at'], doc.createNode(centre(sel.box), { flow: true }));
          writePlan(id, doc);
          await select([id, '--only', key]);
          const result = selectionResult(paths, key);
          const check = result?.status === 'completed' ? await checkOutline(llm, { previewPath: result.previewPath, target: object.target ?? object.label, coverage: result.coverage }) : { verdict: 'nothing', what: result?.failure?.message ?? 'SAM 3 found nothing' };
          attempts.push({ select: sel, coverage: result?.coverage ?? null, check });
          state.select[key] = { attempts, done: check.verdict === 'right' };
          save();
          log[check.verdict === 'right' ? 'ok' : 'warn'](`${key}: ${check.verdict} — ${check.what}`);
          if (check.verdict === 'right') break;
          feedback = `the traced outline was "${check.verdict}": ${check.what}`;
        }
        if (!state.select[key].done) {
          state.select[key].done = true;
          save();
          log.warn(`${key}: kept the last outline after 4 tries; check selections/${key}.preview.jpg`);
        }
      }
    }
    if (values.until === 'select') return 0;

    // 8. The quote, then rendering, screening and the agent's own retakes.
    const { run: quote } = await import('./quote.js');
    await quote([id]);
    if (!await confirm(brief, 'spend', 'Render the films for the price above?')) return 0;
    const skipCanary = brief.approvals?.canary === 'skip';
    const { run: render } = await import('./render.js');
    const { run: screen } = await import('./screen.js');
    state.retakes ??= {};
    // A film rejected since its direction was last written (by you on the review page, or after
    // `audit-clicks`) is rewritten from those reasons first: the same words would fail the same way.
    for (const film of filmsOf(plan)) {
      const takes = listTakes(paths, film.id);
      if (filmState(takes) !== 'rejected') continue;
      const rejectedAt = takes.map(t => t.verdict).filter(v => v?.verdict === 'rejected').map(v => v.at).sort().at(-1);
      const rewrittenAt = state.rewrites?.[film.id]?.at(-1)?.at;
      if (rewrittenAt && rewrittenAt > rejectedAt) continue;
      if ((state.retakes[film.id] ?? 0) >= Number(values.retakes)) {
        log.warn(`${film.id}: ${state.stuck?.[film.id] ? 'could not be rewritten within the rules' : `out of retakes (${values.retakes})`}; left for you`);
        continue;
      }
      state.retakes[film.id] = (state.retakes[film.id] ?? 0) + 1;
      await retakeOrLeave({ llm, id, paths, film, state, mature });
      save();
    }
    ({ plan } = readPlan(id));
    for (let round = 1; round <= Number(values.retakes) + 1; round++) {
      status = gather(id);
      const canaryOpen = !skipCanary && status.canary && !['approved', 'none'].includes(status.canary.state);
      const given = film => (state.retakes[film] ?? 0) <= Number(values.retakes);
      const todo = [...status.byState.unrendered, ...status.byState.failed, ...status.byState.rejected, ...status.byState.rendering].filter(given);
      if (todo.length) {
        log.title(`Rendering ${canaryOpen ? 'the canary' : `${todo.length} film${todo.length === 1 ? '' : 's'}`} (round ${round})`);
        await render([id, ...(canaryOpen ? ['--canary'] : [...(skipCanary ? ['--skip-canary'] : []), ...todo.flatMap(f => ['--only', f])]), '--yes']);
      }
      await screen([id]);
      ({ plan } = readPlan(id));
      const rejectedNow = await judgeNewTakes({ llm, plan, paths, state, mature });
      save();
      for (const film of rejectedNow) {
        if ((state.retakes[film.id] ?? 0) >= Number(values.retakes)) { log.warn(`${film.id}: out of retakes (${values.retakes}); left for you`); continue; }
        state.retakes[film.id] = (state.retakes[film.id] ?? 0) + 1;
        await retakeOrLeave({ llm, id, paths, film, state, mature });
      }
      save();
      status = gather(id);
      if (!skipCanary && status.canary && !['approved', 'none'].includes(status.canary.state) && !rejectedNow.length) {
        log.title('The canary is ready for you');
        log.info('Two films are rendered first so you can judge the look before the rest of the world is spent.');
        log.next(`node world review ${id}   — approve or reject both, then run node world agent ${id} again`);
        return 0;
      }
      if (!rejectedNow.length && !gather(id).byState.unrendered.length) break;
    }
    if (values.until === 'render') return 0;

    // 9. Narration, music, figures, the credit, and a build.
    ({ plan } = readPlan(id));
    if (plan.places.some(p => p.narration?.lines?.length)) { const { run: narrate } = await import('./narrate.js'); await narrate([id]); }
    if (plan.music) { const { run: music } = await import('./music.js'); await music([id]); }
    if (plan.places.some(p => p.objects.some(wantsFigure))) { const { run: figures } = await import('./figures.js'); await figures([id]); }
    // The credit says which models made the world. One the person wrote themselves is kept.
    ({ doc, plan } = readPlan(id));
    if (!plan.credit || plan.credit === state.credit) {
      state.credit = worldCredit({ logFile: join(paths.dir, 'agent', 'llm.jsonl'), plan, paths, painted: Boolean(brief.paint) });
      doc.set('credit', state.credit);
      writePlan(id, doc);
      save();
    }
    const drafts = brief.approvals?.review === 'drafts';
    const { run: build } = await import('./build.js');
    await build([id, ...(drafts ? ['--drafts'] : [])]);
    status = gather(id);
    log.title('Where it stands');
    log.info(`LLM: ${llm.totals.calls} calls, ${llm.totals.promptTokens.toLocaleString()} tokens in, ${llm.totals.completionTokens.toLocaleString()} out, about ${usd(llm.totals.usd)} at pay-as-you-go prices${session.billing.mode === 'subscription' ? ' (covered by your plan)' : ''}`);
    if (!status.unjudged.length) { log.next(`node world play ${id}`); return 0; }
    if (values.until === 'build') {
      log.next(`your verdicts: node world review ${id}   (${status.unjudged.length} take${status.unjudged.length === 1 ? '' : 's'} wait for you)${drafts ? `. Meanwhile the draft plays: node world play ${id}` : ''}`);
      return 0;
    }
    // 10. The person's turn: the agent opens the review page, where only they approve.
    session.close();
    closed = true;
    await openReview({ id, port: Number(values['review-port']), open: !values['no-open'], drafts, waiting: status.unjudged.length });
    return 0;
  } finally {
    if (!closed) session.close();
    log.dim(`LLM so far: ${llm.totals.calls} calls, ${usd(llm.totals.usd)} at pay-as-you-go prices, ${Math.round(llm.totals.seconds)} s`);
  }
}

/** Screened takes the agent hasn't looked at: keep (with a note for the person) or reject. */
async function judgeNewTakes({ llm, plan, paths, state, mature }) {
  const verdicts = readVerdicts(paths);
  const notes = readNotes(paths);
  const rejected = [];
  state.judged ??= {};
  const jobs = [];
  for (const film of filmsOf(plan)) {
    for (const take of listTakes(paths, film.id, verdicts, notes)) {
      if (take.journal.status !== 'completed' || take.verdict || !take.screen || state.judged[take.sha]) continue;
      jobs.push({ film, take });
    }
  }
  await Promise.all(jobs.map(async ({ film, take }) => {
    const from = plan.places.find(p => p.id === film.from);
    const to = plan.places.find(p => p.id === film.to);
    const object = film.object ? from.objects.find(o => o.id === film.object) : null;
    const result = await judgeTake(llm, { take, film, object, fromSeen: from.seen, toSeen: to.seen, cacheDir: join(paths.cache, 'judge'), mature });
    if (object && result.clickedThingLeads === false && result.verdict !== 'reject') {
      result.verdict = 'reject';
      result.defects = [...result.defects, { what: `the film ignores what was clicked ("${object.label}")`, when: 'throughout', cause: 'the route does not start with the clicked thing' }];
    }
    state.judged[take.sha] = { film: film.id, take: take.take, ...result };
    if (result.verdict === 'reject') {
      const reason = result.defects.map(d => `${d.what} (${d.when})`).join('; ') || result.summary;
      recordVerdict(paths, take.sha, { film: film.id, take: take.take, verdict: 'rejected', note: reason, by: 'agent' });
      log.fail(`${film.id} take ${take.take}: rejected — ${reason}`);
      rejected.push(film);
    } else {
      addNote(paths, take.sha, 'agent', result.summary);
      log.ok(`${film.id} take ${take.take}: looks sound — ${result.summary}`);
    }
  }));
  return rejected;
}

/** One film the agent cannot rewrite within its rules is left for the person; the others go on. */
async function retakeOrLeave(args) {
  try {
    await retake(args);
  } catch (error) {
    args.state.retakes[args.film.id] = 99; // JSON keeps a number (Infinity would come back as null)
    (args.state.stuck ??= {})[args.film.id] = { error: String(error.message).slice(0, 400), at: new Date().toISOString() };
    log.warn(`${args.film.id}: could not rewrite it within the rules (${String(error.message).slice(0, 160)}); leaving it for you`);
  }
}

/** Rewrite a rejected film's direction from the reasons it was rejected. */
async function retake({ llm, id, paths, film, state, mature }) {
  const { doc, plan } = readPlan(id);
  const verdicts = readVerdicts(paths);
  const takes = listTakes(paths, film.id, verdicts);
  const reasons = takes.filter(t => t.verdict?.verdict === 'rejected').map(t => `take ${t.take}: ${t.verdict.note}`);
  const pi = plan.places.findIndex(p => p.id === film.from);
  const place = plan.places[pi];
  const to = plan.places.find(p => p.id === film.to);
  const object = film.object ? place.objects.find(o => o.id === film.object) : null;
  const { diagnosis, film: next } = await rewriteFilm(llm, {
    film, label: object?.label, hint: object?.hint, target: object?.target ?? '', objectId: object?.id ?? '', reasons,
    fromStill: join(paths.dir, place.still), toStill: join(paths.dir, to.still), fromSeen: place.seen, toSeen: to.seen, mature,
  });
  const at = film.kind === 'loop' ? ['places', pi, 'loop'] : ['places', pi, 'objects', place.objects.indexOf(object), 'film'];
  doc.setIn([...at, 'frames'], film.kind === 'loop' ? 192 : next.frames);
  doc.setIn([...at, 'idea'], next.idea);
  doc.setIn([...at, 'action'], next.action);
  doc.setIn([...at, 'sound'], next.sound);
  writePlan(id, doc);
  state.rewrites ??= {};
  (state.rewrites[film.id] ??= []).push({ reasons, diagnosis, at: new Date().toISOString() });
  log.step(`${film.id}: rewrote the direction — ${diagnosis}`);
}

const centre = box => [Math.round(((box[0] + box[2]) / 2) * 1000) / 1000, Math.round(((box[1] + box[3]) / 2) * 1000) / 1000];
function clean(object) {
  for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
  return object;
}
export { loopId };

const MODEL_NAMES = {
  'deepseek-v4-flash-vision-exp-dspark-1m': 'DeepSeek V4 Flash',
  'qwen3.6-35b-a3b-gguf-iq4xs': 'Qwen 3.6',
};
const modelName = id => MODEL_NAMES[id] ?? id;

/**
 * Who made the world, from the agent's own call log: which model wrote the
 * places, which rewrote and screened the takes, which found the objects, and
 * the media models it used. Shown on the world's About panel.
 */
export function worldCredit({ logFile, plan, paths, painted }) {
  const calls = existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
  const by = test => [...new Set(calls.filter(c => test(c.purpose ?? '')).map(c => modelName(c.model)))];
  const list = names => names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  const writers = by(p => /^(write|review|revise|bible|look|world)/.test(p));
  const screeners = by(p => /^(judge|retake|audit)/.test(p));
  const pointers = by(p => /^locate/.test(p));
  const parts = [];
  if (writers.length && screeners.length && screeners.every(name => writers.includes(name))) parts.push(`written and screened by ${list(writers)}`);
  else {
    if (writers.length) parts.push(`written by ${list(writers)}`);
    if (screeners.length) parts.push(`retakes and screening by ${list(screeners)}`);
  }
  if (pointers.length) parts.push(`objects found by ${list(pointers)}`);
  const media = [];
  if (painted) media.push('pictures by Krea 2');
  media.push('films by MiniMax H3');
  if (plan.places.some(p => p.narration?.lines?.length)) media.push('voices by Qwen3-TTS');
  const music = readJson(join(paths.audio, 'music', 'music.json'), null);
  if (plan.music?.prompt && music?.status === 'completed') media.push(`music by ${/minimax_music3/.test(music.model ?? music.request?.model ?? '') ? 'MiniMax Music 3' : /ace_step/.test(music.model ?? music.request?.model ?? '') ? 'ACE-Step 1.5' : 'Sogni'}`);
  if (plan.places.some(p => p.objects.some(o => wantsFigure(o) && existsSync(figureFiles(paths, `${p.id}-${o.id}`).glb)))) media.push('figures by Pixal3D');
  const agent = parts.length ? `Planned by Sogni's own LLMs with the Sogni Worlds Kit agent: ${parts.join('; ')}.` : 'Made with the Sogni Worlds Kit.';
  return `${agent} ${media.join(', ').replace(/^./, c => c.toUpperCase())}, all on Sogni.`;
}

/**
 * Serve the review page, open it in the browser, and wait until the person is
 * done (Ctrl-C). Their verdicts land in review/verdicts.json as theirs; a film
 * they reject is rewritten from their note the next time the agent runs.
 */
async function openReview({ id, port, open, drafts, waiting }) {
  const { startReviewServer } = await import('./review.js');
  const { plan, paths } = readPlan(id);
  let server;
  for (let tries = 0; !server; tries++) {
    try {
      server = await startReviewServer({ plan, paths, port: port + tries, title: plan.title || id });
      port += tries;
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || tries >= 20) throw error;
    }
  }
  const url = `http://127.0.0.1:${port}/`;
  log.title('Your turn: the review page');
  log.ok(`${waiting} take${waiting === 1 ? '' : 's'} wait for your verdict at ${url}`);
  log.info('Approve the take you want for each film. Reject one with a note saying what is wrong: the next');
  log.info(`run of node world agent ${id} rewrites that film from your note and renders it again.`);
  if (drafts) log.info(`Meanwhile the whole world plays as a draft: node world play ${id}`);
  if (open) openInBrowser(url);
  log.dim('Your verdicts save as you click. Press Ctrl-C here when you are done.');
  await new Promise(done => process.once('SIGINT', () => { server.close(); done(); }));
  log.next(`node world agent ${id}   — rewrites what you rejected, then builds with what you approved`);
}

function openInBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* no browser here: the address is printed above */ }
}
