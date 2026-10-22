import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { checkForUpdate, readState, skipUpdateCheck, snoozeUpdate, updateNotice } from '../cli/lib/update-check.js';
import { refreshSkills, updateKit } from '../cli/commands/update.js';
import { tempDir } from './helpers.js';

// Git with no global or system config (signing, hooks, default branch) and a fixed
// author. Every repo is a temporary one: an "origin" folder and a clone of it.
const gitConfig = join(tempDir('gitconfig'), 'config');
writeFileSync(gitConfig, '');
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Kit', GIT_AUTHOR_EMAIL: 'kit@example.com', GIT_COMMITTER_NAME: 'Kit', GIT_COMMITTER_EMAIL: 'kit@example.com',
});

const git = (cwd, ...args) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};

/** A bare origin on main and a clone of it (`kit`). `commit` lands on origin after the clone was made. */
function repos() {
  const dir = tempDir('update');
  const origin = join(dir, 'origin.git'), seed = join(dir, 'seed'), kit = join(dir, 'kit');
  git(dir, 'init', '--quiet', '--bare', '-b', 'main', origin);
  git(dir, 'init', '--quiet', '-b', 'main', seed);
  git(seed, 'remote', 'add', 'origin', origin);
  const commit = (subject, files = { [`${subject}.txt`]: subject }) => {
    for (const [file, text] of Object.entries(files)) {
      mkdirSync(dirname(join(seed, file)), { recursive: true });
      writeFileSync(join(seed, file), text);
    }
    git(seed, 'add', '.');
    git(seed, 'commit', '--quiet', '-m', subject);
    git(seed, 'push', '--quiet', 'origin', 'main');
  };
  commit('The first kit', { 'package.json': '{}\n', 'README.md': 'kit\n', 'skills/sogni-worlds/SKILL.md': 'skill 1\n' });
  git(dir, 'clone', '--quiet', origin, kit);
  return { dir, kit, commit, home: join(dir, 'home'), statePath: join(dir, 'state.json'), origin };
}

const DAY = 24 * 60 * 60 * 1000;
function clock() {
  let time = Date.parse('2026-10-21T17:00:00Z');
  const now = () => time;
  now.add = ms => { time += ms; };
  return now;
}

test('the check counts the commits origin has that the clone lacks, and the notice says so once a day', () => {
  const { kit, commit, statePath } = repos();
  commit('Add the ferry');
  commit('Fix the lighthouse');
  const now = clock();
  assert.deepEqual(checkForUpdate({ root: kit, statePath, now }), { behind: 2, short: git(kit, 'rev-parse', 'HEAD').slice(0, 7) });
  assert.equal(readState(statePath)[kit].behind, 2, 'recorded under the clone’s own path');

  const started = [];
  const notice = () => updateNotice({ root: kit, statePath, now, env: {}, startCheck: root => started.push(root) });
  assert.equal(notice(), `[sogni-worlds] Update available: 2 new commits on the Kit (you have ${git(kit, 'rev-parse', 'HEAD').slice(0, 7)}). `
    + 'Run: node world update  (what changed: node world update --whats-new; not now: node world update --snooze)');
  assert.equal(notice(), null, 'once a day');
  assert.deepEqual(started, [], 'checked moments ago');
  now.add(DAY);
  assert.match(notice(), /: 2 new commits on the Kit/);
  assert.deepEqual(started, [kit], 'a day later the check runs again, in the background');
  assert.equal(notice(), null);
  assert.deepEqual(started, [kit], 'and only once that day');

  git(kit, 'pull', '--quiet', '--ff-only', 'origin', 'main');
  now.add(DAY);
  assert.equal(notice(), null, 'a manual pull ends the notice before the next check');
});

test('no check and no notice when opted out, in CI or a test, or in a download that is not a git clone', () => {
  const { kit, commit, statePath } = repos();
  assert.equal(skipUpdateCheck({ root: kit, env: {}, argv: ['status'] }), false);
  for (const env of [{ CI: 'true' }, { SOGNI_NO_UPDATE_CHECK: '1' }, { SOGNI_NO_UPDATE_CHECK: 'true' }, { NO_UPDATE_NOTIFIER: '1' },
    { NO_UPDATE_NOTIFIER: 'true' }, { NODE_ENV: 'test' }, { NODE_TEST_CONTEXT: 'child-v8' }]) {
    assert.equal(skipUpdateCheck({ root: kit, env, argv: ['status'] }), true, JSON.stringify(env));
  }
  assert.equal(skipUpdateCheck({ root: kit, env: { SOGNI_NO_UPDATE_CHECK: '0' }, argv: [] }), false);
  assert.equal(skipUpdateCheck({ root: kit, env: {}, argv: ['status', '--no-update-check'] }), true);
  assert.equal(skipUpdateCheck({ root: tempDir('zip'), env: {}, argv: [] }), true);

  commit('Add the ferry');
  checkForUpdate({ root: kit, statePath });
  const started = [];
  assert.equal(updateNotice({ root: kit, statePath, env: { SOGNI_NO_UPDATE_CHECK: '1' }, startCheck: root => started.push(root) }), null);
  assert.equal(updateNotice({ root: tempDir('zip'), statePath, env: {}, startCheck: root => started.push(root) }), null);
  assert.deepEqual(started, []);
  assert.match(checkForUpdate({ root: tempDir('zip'), statePath }).skipped, /not a git clone/);
});

test('a clone on another branch is a developer’s own: never checked, never told', () => {
  const { kit, commit, statePath } = repos();
  commit('Add the ferry');
  const now = clock();
  checkForUpdate({ root: kit, statePath, now });
  git(kit, 'switch', '--quiet', '-c', 'my-idea');
  assert.equal(updateNotice({ root: kit, statePath, now, env: {}, startCheck: () => {} }), null);
  assert.match(checkForUpdate({ root: kit, statePath, now }).skipped, /on my-idea, not main/);
});

test('not now pauses the notice for a day, then two days, then a week; an update starts the ladder again', () => {
  const { kit, commit, home, statePath } = repos();
  commit('Add the ferry');
  const now = clock();
  checkForUpdate({ root: kit, statePath, now });
  const notice = () => updateNotice({ root: kit, statePath, now, env: {}, startCheck: () => {} });
  for (const days of [1, 2, 7, 7]) {
    const { until, level } = snoozeUpdate({ root: kit, statePath, now });
    assert.equal(until - now(), days * DAY, `level ${level}`);
    now.add(until - now() - 1000);
    assert.equal(notice(), null, 'paused');
    now.add(1000);
    assert.match(notice() ?? '', /Update available/, 'back when the pause ends');
  }
  updateKit({ root: kit, home, statePath, now, install: () => true });
  assert.equal(snoozeUpdate({ root: kit, statePath, now }), null, 'nothing to pause after the update');
  commit('Fix the lighthouse');
  checkForUpdate({ root: kit, statePath, now });
  assert.equal(snoozeUpdate({ root: kit, statePath, now }).until - now(), DAY);
});

test('update refuses over local changes to tracked files, and lists them', () => {
  const { kit, commit, home, statePath } = repos();
  commit('Add the ferry');
  const before = git(kit, 'rev-parse', 'HEAD');
  writeFileSync(join(kit, 'README.md'), 'my own notes\n');
  writeFileSync(join(kit, 'mine.txt'), 'untracked files are not in the way\n');
  const result = updateKit({ root: kit, home, statePath, install: () => assert.fail('no npm install') });
  assert.match(result.refused, /local changes/);
  assert.deepEqual(result.files, ['README.md']);
  assert.equal(git(kit, 'rev-parse', 'HEAD'), before);
  assert.equal(readFileSync(join(kit, 'README.md'), 'utf8'), 'my own notes\n');

  git(kit, 'checkout', '--quiet', 'README.md');
  git(kit, 'switch', '--quiet', '-c', 'my-idea');
  assert.match(updateKit({ root: kit, home, statePath }).refused, /on my-idea, not main/);
  assert.match(updateKit({ root: tempDir('zip'), home, statePath }).refused, /not a git clone/);
});

test('update fast-forwards, lists what changed oldest first, and runs npm install only when the dependencies changed', () => {
  const { kit, commit, home, statePath, origin } = repos();
  commit('Add the ferry');
  commit('Fix the lighthouse');
  const now = clock();
  checkForUpdate({ root: kit, statePath, now });
  const installs = [];
  const install = root => installs.push(root) > 0;

  const first = updateKit({ root: kit, home, statePath, now, install });
  assert.deepEqual(first.subjects, ['Add the ferry', 'Fix the lighthouse']);
  assert.equal(first.installed, null);
  assert.deepEqual(installs, [], 'package.json and package-lock.json did not change');
  assert.equal(git(kit, 'rev-parse', 'HEAD'), git(origin, 'rev-parse', 'main'));
  now.add(DAY);
  assert.equal(updateNotice({ root: kit, statePath, now, env: {}, startCheck: () => {} }), null, 'the notice is cleared');

  commit('Update sharp', { 'package-lock.json': '{"lockfileVersion":3}\n' });
  const second = updateKit({ root: kit, home, statePath, now, install });
  assert.deepEqual(second.subjects, ['Update sharp']);
  assert.equal(second.installed, true);
  assert.deepEqual(installs, [kit]);

  assert.deepEqual(updateKit({ root: kit, home, statePath, now, install }).subjects, [], 'already up to date');
});

test('update refreshes a copied skill, and leaves a linked one alone', () => {
  const { kit, commit, home, statePath } = repos();
  const claude = join(home, '.claude', 'skills', 'sogni-worlds');
  mkdirSync(claude, { recursive: true });
  writeFileSync(join(claude, 'SKILL.md'), 'skill 1\n');
  mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
  symlinkSync(join(kit, 'skills', 'sogni-worlds'), join(home, '.codex', 'skills', 'sogni-worlds'), 'junction');
  assert.deepEqual(refreshSkills({ root: kit, home }), [], 'the same skill is not copied');

  commit('Teach the skill about updates', { 'skills/sogni-worlds/SKILL.md': 'skill 2\n' });
  const result = updateKit({ root: kit, home, statePath, install: () => true });
  assert.deepEqual(result.skills, [claude]);
  assert.equal(readFileSync(join(claude, 'SKILL.md'), 'utf8'), 'skill 2\n');
  assert.deepEqual(refreshSkills({ root: kit, home }), []);
});
