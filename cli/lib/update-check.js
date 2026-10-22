// Is there a newer kit? Once a day a detached child fetches origin's main and
// counts the commits this clone lacks; commands only read the answer from a
// small state file, so the check never slows or breaks them. Only a clone on
// main is checked: a downloaded zip has no git, and any other branch is a
// developer's own. `node world update` applies the update.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJson } from './files.js';
import { ROOT } from './paths.js';

/** One file for every clone, keyed by the clone's path, beside the Creative Agent Skill's own check. */
export const STATE_FILE = join(homedir(), '.config', 'sogni', 'worlds-kit-update.json');
/** `node world <this>` is the background check itself. */
export const CHECK_FLAG = '--__update-check';
const DAY = 24 * 60 * 60 * 1000;
/** Each "not now" pauses the notice longer: a day, two days, then a week. */
export const SNOOZE_MS = [DAY, 2 * DAY, 7 * DAY];

/** Run git in the clone: { ok, out, err }. Never prompts, never throws. */
export function git(root, args, timeout = 10_000) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  return { ok: result.status === 0, out: result.stdout?.trimEnd() ?? '', err: result.stderr?.trim() || result.error?.message || '' };
}

/** The clone's commit and branch, or null when the kit is not a git clone. */
export function kitHead(root = ROOT) {
  if (!existsSync(join(root, '.git'))) return null;
  const result = git(root, ['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']);
  const [sha, branch] = result.out.split('\n');
  return result.ok && sha && branch ? { sha, short: sha.slice(0, 7), branch } : null;
}

const on = value => value === '1' || value === 'true';
export const optedOut = (env = process.env) => on(env.SOGNI_NO_UPDATE_CHECK) || on(env.NO_UPDATE_NOTIFIER);

/** Opted out, CI, a test run, an npm script, or not a git clone: no check and no notice. */
export function skipUpdateCheck({ argv = [], env = process.env, root = ROOT } = {}) {
  return optedOut(env) || argv.includes('--no-update-check') || Boolean(env.CI) || env.NODE_ENV === 'test'
    || Boolean(env.NODE_TEST_CONTEXT) || Boolean(env.npm_lifecycle_event) || !existsSync(join(root, '.git'));
}

export function readState(statePath = STATE_FILE) {
  try {
    return readJson(statePath, {});
  } catch {
    return {};
  }
}

function saveEntry(statePath, root, entry) {
  try {
    writeJson(statePath, { ...readState(statePath), [root]: entry });
  } catch {
    // best effort: a missing notice never matters more than the command
  }
}

/**
 * Fetch origin's main and count the commits this clone lacks, and record it.
 * Returns { behind, short } or { skipped: why }.
 */
export function checkForUpdate({ root = ROOT, statePath = STATE_FILE, now = Date.now } = {}) {
  const head = kitHead(root);
  if (!head) return { skipped: 'this kit is not a git clone' };
  if (head.branch !== 'main') return { skipped: `this clone is on ${head.branch}, not main` };
  const entry = readState(statePath)[root] ?? {};
  if (!git(root, ['fetch', '--quiet', 'origin', 'main'], 15_000).ok) {
    saveEntry(statePath, root, { ...entry, checkedAt: now() });
    return { skipped: 'could not reach origin' };
  }
  const latest = git(root, ['rev-parse', 'origin/main']).out;
  const behind = Number(git(root, ['rev-list', '--count', 'HEAD..origin/main']).out) || 0;
  saveEntry(statePath, root, { ...readState(statePath)[root], checkedAt: now(), latest, behind });
  return { behind, short: head.short };
}

/** The check runs in a detached child, so a slow network never holds a command up. */
export function startBackgroundCheck(root = ROOT) {
  const child = spawn(process.execPath, [join(root, 'world.js'), CHECK_FLAG], { cwd: root, detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
}

export const noticeText = (behind, short) =>
  `[sogni-worlds] Update available: ${behind} new commit${behind === 1 ? '' : 's'} on the Kit (you have ${short}). `
  + 'Run: node world update  (what changed: node world update --whats-new; not now: node world update --snooze)';

/**
 * Before every command: start the daily check when it is due, and return the
 * notice when one is due (at most once a day, never while snoozed). Reads one
 * small file, and runs git only on the day it has something to say.
 */
export function updateNotice({ argv = [], env = process.env, root = ROOT, statePath = STATE_FILE, now = Date.now, startCheck = startBackgroundCheck } = {}) {
  try {
    if (skipUpdateCheck({ argv, env, root })) return null;
    const entry = readState(statePath)[root] ?? {};
    if (!entry.checkedAt || now() - entry.checkedAt >= DAY) {
      saveEntry(statePath, root, { ...entry, checkedAt: now() }); // one check a day, even when it fails
      startCheck(root);
    }
    if (!entry.behind || now() < (entry.snooze?.until ?? 0) || now() - (entry.notifiedAt ?? 0) < DAY) return null;
    // Count again against the commit that was fetched: a manual pull, or a switch off main, ends the notice.
    const head = kitHead(root);
    const behind = head?.branch === 'main' ? Number(git(root, ['rev-list', '--count', `HEAD..${entry.latest}`]).out) || 0 : 0;
    if (!behind) return null;
    saveEntry(statePath, root, { ...readState(statePath)[root], notifiedAt: now() });
    return noticeText(behind, head.short);
  } catch {
    return null;
  }
}

/** "Not now": the next notice waits a day, then two days, then a week; updating starts the ladder again. */
export function snoozeUpdate({ root = ROOT, statePath = STATE_FILE, now = Date.now } = {}) {
  const entry = readState(statePath)[root] ?? {};
  const head = kitHead(root);
  if (!entry.behind || !head) return null;
  const level = Math.min((entry.snooze?.head === head.sha ? entry.snooze.level : 0) + 1, SNOOZE_MS.length);
  const snooze = { head: head.sha, level, until: now() + SNOOZE_MS[level - 1] };
  saveEntry(statePath, root, { ...entry, snooze });
  return snooze;
}

/** After an update: nothing to announce, and the snooze ladder starts again. */
export const clearNotice = ({ root = ROOT, statePath = STATE_FILE, now = Date.now } = {}) =>
  saveEntry(statePath, root, { checkedAt: now(), behind: 0 });
