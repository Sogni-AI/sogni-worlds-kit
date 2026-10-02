// audit-clicks: does each film start with what the visitor clicked?
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, extname, join, resolve } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { readPlan, filmsOf, placeById } from '../lib/plan.js';
import { resolveWorldId, shown, filmId } from '../lib/paths.js';
import { writeJson } from '../lib/files.js';
import { approvedTake, listTakes } from '../lib/takes.js';
import { connect } from '../lib/sogni.js';
import { Llm, MODELS } from '../lib/llm.js';
import { selectionResult } from '../agent/point.js';
import { auditClick } from '../agent/clicks.js';

export const summary = 'Check that every film starts with the thing its click names (a Sogni vision LLM)';
export const usage = `node world audit-clicks [world] [--only <film> ...] [--text]
node world audit-clicks --manifest <clicks.json> --out <report.json>

  The label on a clickable thing is a promise: "Follow the lanterns to the
  city" has to start with the lanterns. A film that starts somewhere else
  feels broken however good it looks. For every object's film, a Sogni vision
  LLM (${MODELS.writer}) looks at the still with the clicked thing marked and
  at frames from the film's first seconds, and says aligned, weak or
  misaligned, with a one-sentence fix. It is a screener, not a verdict: on
  197 hand-checked clicks it caught 35 of 44 real problems with 59 false
  alarms. Look at every film it flags, and at each opening strip yourself. It judges the approved take (else the newest
  finished one); a film with no take, or every film with --text, is judged
  from its written direction. Writes review/click-audit.json.

  --manifest audits films from outside a kit world (any player's hotspots):
  a JSON array of { name, label, hint?, target?, still, at: [x, y], video?,
  destination?, direction? }, where still and video are files or https URLs
  and at is the click in 0–1 fractions.

  Each check is one LLM call on your Sogni account (spark, billed like chat).`;

export async function run(argv) {
  const { values, world } = parse(argv, {
    only: { type: 'string', multiple: true },
    text: { type: 'boolean', default: false },
    manifest: { type: 'string' },
    out: { type: 'string' },
  });
  const clicks = values.manifest ? await fromManifest(values.manifest, values.out) : fromWorld(world, values);
  if (!clicks.items.length) { log.warn('No films with a clickable object to audit.'); return 0; }

  const session = await connect({ appId: `sogni-worlds-audit-${Date.now()}` });
  const llm = new Llm({ client: session.client, billing: session.billing, logFile: clicks.logFile, concurrency: Number(process.env.SOGNI_AGENT_CONCURRENCY || (session.tier === 'unlimited_pro' ? 4 : 2)) });
  const results = [];
  try {
    log.title(`Auditing ${clicks.items.length} click(s) with ${MODELS.writer}`);
    await Promise.all(clicks.items.map(async item => {
      try {
        const answer = await auditClick(llm, { ...item, cacheDir: clicks.cacheDir });
        results.push({ name: item.name, label: item.label, ...answer });
        const mark = { aligned: log.ok, weak: log.warn, misaligned: log.fail }[answer.verdict];
        mark(`${item.name} "${item.label}": ${answer.verdict} (${answer.basis}) — ${answer.why}${answer.fix ? ` Fix: ${answer.fix}` : ''}`);
      } catch (error) {
        results.push({ name: item.name, label: item.label, verdict: 'error', why: error.message });
        log.fail(`${item.name}: ${error.message}`);
      }
    }));
  } finally {
    session.close();
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  writeJson(clicks.out, { at: new Date().toISOString(), model: MODELS.writer, results });
  const count = verdict => results.filter(r => r.verdict === verdict).length;
  log.title(`${count('aligned')} aligned, ${count('weak')} weak, ${count('misaligned')} misaligned${count('error') ? `, ${count('error')} not checked` : ''}`);
  log.info(`Report: ${shown(clicks.out)}. A misaligned film needs its direction rewritten to start with the clicked thing (docs/directing-films.md), then a retake; a weak one is for you to watch.`);
  log.dim(`${llm.totals.calls} LLM call(s), ${llm.totals.promptTokens + llm.totals.completionTokens} tokens`);
  return count('misaligned') ? 2 : 0;
}

function fromWorld(world, values) {
  const id = resolveWorldId(world);
  const { plan, paths } = readPlan(id);
  const only = values.only?.length ? new Set(values.only) : null;
  const mature = Boolean(plan.mature) || /18\+/.test(plan.intro?.warning ?? '');
  const items = [];
  for (const film of filmsOf(plan)) {
    if (!film.object || (only && !only.has(film.id))) continue;
    const place = placeById(plan, film.from);
    const object = place.objects.find(o => o.id === film.object);
    const takes = listTakes(paths, film.id);
    // The take a build plays: the approved one, else (in a draft) the newest one nobody rejected.
    const take = values.text ? null : approvedTake(takes) ?? takes.filter(t => t.journal.status === 'completed' && existsSync(t.files.video) && t.verdict?.verdict !== 'rejected').at(-1) ?? null;
    const to = film.kind === 'crossing' ? placeById(plan, film.to) : null;
    const selection = selectionResult(paths, filmId(place.id, object.id));
    items.push({
      name: film.id,
      label: object.label,
      hint: object.hint ?? '',
      target: object.target ?? '',
      still: join(paths.dir, place.still),
      at: object.at ?? [0.5, 0.5],
      outline: selection?.status === 'completed' ? selection.previewPath : null,
      video: take?.files.video ?? null,
      direction: film.action,
      destination: to ? `${to.title}: ${to.seen ?? ''}` : '',
      mature,
    });
  }
  return { items, cacheDir: join(paths.cache, 'click-audit'), out: join(paths.review, 'click-audit.json'), logFile: join(paths.dir, 'agent', 'llm.jsonl') };
}

async function fromManifest(file, outFile) {
  const manifestPath = resolve(file);
  const list = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(list)) throw new Error('The manifest is a JSON array of clicks');
  const base = dirname(manifestPath);
  const cacheDir = join(base, '.click-audit-cache');
  mkdirSync(cacheDir, { recursive: true });
  const local = async source => {
    if (!source) return null;
    if (!/^https?:\/\//.test(source)) return resolve(base, source);
    const path = join(cacheDir, createHash('sha1').update(source).digest('hex').slice(0, 16) + (extname(new URL(source).pathname) || '.bin'));
    if (!existsSync(path)) {
      const response = await fetch(source);
      if (!response.ok) throw new Error(`${source}: HTTP ${response.status}`);
      writeFileSync(path, Buffer.from(await response.arrayBuffer()));
    }
    return path;
  };
  const items = [];
  for (const entry of list) {
    for (const key of ['name', 'label', 'still', 'at']) if (entry[key] == null) throw new Error(`Manifest entry ${JSON.stringify(entry).slice(0, 80)} has no ${key}`);
    items.push({ ...entry, still: await local(entry.still), video: await local(entry.video) });
  }
  const out = resolve(outFile ?? file.replace(/\.json$/, '') + '.report.json');
  return { items, cacheDir, out, logFile: join(dirname(out), 'click-audit.llm.jsonl') };
}
