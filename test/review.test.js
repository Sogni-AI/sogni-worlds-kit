import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { applyVerdict, approveBuild, awaitingFilms, currentBuildTakes, startReviewServer } from '../cli/commands/review.js';
import { readVerdicts, recordVerdict, filmState, listTakes } from '../cli/lib/takes.js';
import { writeJson, sha256File } from '../cli/lib/files.js';
import { reviewPage } from '../cli/lib/review-page.js';
import { canaryStatus } from '../cli/lib/canary.js';
import { pathsAt, tempDir } from './helpers.js';

function fixture() {
  const paths = pathsAt(tempDir('review'));
  mkdirSync(paths.stills, { recursive: true });
  writeFileSync(join(paths.stills, 'a.jpg'), 'current picture');
  const plan = { title: 'Review test', places: [{ id: 'a', still: 'stills/a.jpg', loop: {}, objects: [] }] };
  return { paths, plan };
}

function take(paths, film, n, { first = sha256File(join(paths.stills, 'a.jpg')), verdict } = {}) {
  const dir = join(paths.renders, film);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `take-${n}.mp4`);
  writeFileSync(file, `${film} take ${n}`);
  const sha = sha256File(file);
  writeJson(join(dir, `take-${n}.json`), { status: 'completed', sha256: sha, references: [{ role: 'first', sha256: first }] });
  if (verdict) recordVerdict(paths, sha, { film, take: n, verdict, by: 'you' });
  return sha;
}

function build(paths, sha) {
  writeJson(join(paths.build, 'world.json'), { draft: true, places: [{ id: 'a', loop: { src: 'films/a-loop.mp4' }, hotspots: [] }] });
  writeJson(join(paths.build, '.manifest.json'), { 'films/a-loop.mp4': { source: `${sha}+fit 192x128` } });
}

test('an approval from an old page never passes newer takes', () => {
  const { paths, plan } = fixture();
  const older = take(paths, 'a-loop', 1);
  const chosen = take(paths, 'a-loop', 2);
  const newer = take(paths, 'a-loop', 3);
  assert.equal(applyVerdict(plan, paths, { sha: chosen, verdict: 'approved' }), null);
  assert.equal(readVerdicts(paths)[older].verdict, 'passed');
  assert.equal(readVerdicts(paths)[newer], undefined);
  assert.deepEqual(awaitingFilms(plan, paths)[0].takes.map(t => t.take), [3]);
});

test('a stale approval is refused and previously auto-passed current takes can be reviewed again', () => {
  const { paths, plan } = fixture();
  const stale = take(paths, 'a-loop', 3, { first: 'old picture', verdict: 'approved' });
  const current = take(paths, 'a-loop', 8, { verdict: 'passed' });
  assert.match(applyVerdict(plan, paths, { sha: stale, verdict: 'approved' }), /pictures.*changed/);
  const films = awaitingFilms(plan, paths);
  assert.deepEqual(films[0].takes.map(t => t.take), [8]);
  assert.equal(films[0].ref, null, 'a stale take is not an approved baseline');
  assert.equal(filmState(listTakes(paths, 'a-loop', undefined, undefined, { first: 'stills/a.jpg' })), 'unjudged');
  assert.equal(canaryStatus(plan, paths).state, 'unjudged', 'the stale approval cannot clear the canary gate');
  assert.equal(applyVerdict(plan, paths, { sha: current, verdict: 'approved' }), null);
  assert.deepEqual(awaitingFilms(plan, paths), []);
});

test('bulk approval uses the draft build sources, leaving newer and alternative takes unjudged', () => {
  const { paths, plan } = fixture();
  const old = take(paths, 'a-loop', 1);
  const chosen = take(paths, 'a-loop', 2);
  build(paths, chosen);
  const snapshot = currentBuildTakes(plan, paths);
  const newer = take(paths, 'a-loop', 3);
  assert.deepEqual(snapshot.takes, [{ film: 'a-loop', take: 2, sha: chosen }]);
  assert.equal(approveBuild(plan, paths, { ...snapshot, confirmed: true }), null);
  assert.equal(readVerdicts(paths)[chosen].verdict, 'approved');
  assert.equal(readVerdicts(paths)[old], undefined);
  assert.equal(readVerdicts(paths)[newer], undefined);
  assert.equal(currentBuildTakes(plan, paths).pending, 0);
});

test('bulk approval needs confirmation of the same build and checks source bytes before saving', () => {
  const { paths, plan } = fixture();
  const sha = take(paths, 'a-loop', 1);
  build(paths, sha);
  const snapshot = currentBuildTakes(plan, paths);
  assert.match(approveBuild(plan, paths, snapshot), /not confirmed/);
  writeJson(join(paths.build, 'world.json'), { places: [{ id: 'a', title: 'changed', loop: { src: 'films/a-loop.mp4' }, hotspots: [] }] });
  assert.match(approveBuild(plan, paths, { ...snapshot, confirmed: true }), /build has changed/);
  const updated = currentBuildTakes(plan, paths);
  writeFileSync(join(paths.renders, 'a-loop', 'take-1.mp4'), 'replacement bytes');
  assert.match(approveBuild(plan, paths, { ...updated, confirmed: true }), /take 1 has changed/);
  assert.deepEqual(readVerdicts(paths), {});
});

test('bulk approval cannot restore a rejected or stale source', () => {
  const { paths, plan } = fixture();
  const sha = take(paths, 'a-loop', 1);
  build(paths, sha);
  const snapshot = currentBuildTakes(plan, paths);
  recordVerdict(paths, sha, { film: 'a-loop', take: 1, verdict: 'rejected', by: 'you' });
  assert.match(approveBuild(plan, paths, { ...snapshot, confirmed: true }), /changed|no longer/);
  assert.equal(readVerdicts(paths)[sha].verdict, 'rejected');
  take(paths, 'a-loop', 1, { first: 'old picture', verdict: 'passed' });
  assert.match(currentBuildTakes(plan, paths).error, /changed|no longer/);
});

test('refreshing the running review server rereads the plan and newly completed takes', async t => {
  const { paths, plan } = fixture();
  take(paths, 'a-loop', 1);
  let latest = plan;
  const server = await startReviewServer({ plan, paths, port: 0, title: plan.title, loadPlan: () => latest });
  t.after(() => new Promise(done => server.close(done)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const page = async () => {
    const response = await fetch(url);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return response.text();
  };
  assert.match(await page(), /a-loop/);
  latest = structuredClone(plan);
  latest.title = 'Changed plan';
  latest.places[0].objects.push({ id: 'door', film: {} });
  const newer = take(paths, 'a-door', 1);
  const html = await page();
  assert.match(html, /Changed plan/);
  assert.match(html, new RegExp(newer));
  const data = JSON.parse(/const DATA = (.*);<\/script>/.exec(html)[1]);
  const denied = await fetch(`${url}/approve-build`, { method: 'POST', body: '{}' });
  assert.equal(denied.status, 403);
  const verdict = await fetch(`${url}/verdict`, { method: 'POST', headers: { 'x-review-token': data.token }, body: JSON.stringify({ sha: newer, verdict: 'approved' }) });
  assert.equal(verdict.status, 200, 'new plan films can be judged without restarting');
});

test('review page scripts parse and expose the exact-build confirmation', () => {
  const html = reviewPage({ title: 'Test', token: 'token', films: [], build: { worldSha: 'sha', takes: [{ film: 'a-loop', take: 2, sha: 'take' }], pending: 1 } });
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Script(script));
  assert.match(html, /Approve this build’s takes/);
  assert.match(html, /if \(!confirm\(/);
});
