import { spawnSync } from 'node:child_process';
import { cpSync, lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { ROOT } from '../lib/paths.js';
import { checkForUpdate, clearNotice, git, kitHead, optedOut, snoozeUpdate, STATE_FILE } from '../lib/update-check.js';

export const summary = 'Update the kit to the newest version, and your installed sogni-worlds skill';
export const usage = `node world update [--check | --whats-new | --snooze]

  Pulls the newest kit from GitHub (on main, never over your own changes), runs
  npm install when the dependencies changed, and refreshes the sogni-worlds skill
  you copied into ~/.claude/skills or ~/.codex/skills. Every command checks for
  an update once a day; turn that off with SOGNI_NO_UPDATE_CHECK=1.

  --check      check now and say whether an update is there
  --whats-new  list what the update brings, without updating
  --snooze     not now: pause the notice for a day, then two days, then a week`;

const SHOWN = 30;

/** Where docs/agents.md copies the skill. Hermes reads it from this repo, so it is always current. */
export const skillCopies = home => [join(home, '.claude', 'skills', 'sogni-worlds'), join(home, '.codex', 'skills', 'sogni-worlds')];

/** Copy the repo's skill over each installed copy whose SKILL.md differs. A symlink already follows the repo. */
export function refreshSkills({ root = ROOT, home = homedir() } = {}) {
  const source = join(root, 'skills', 'sogni-worlds');
  const skill = readFileSync(join(source, 'SKILL.md'), 'utf8');
  const read = file => { try { return readFileSync(file, 'utf8'); } catch { return null; } };
  return skillCopies(home).filter(dir => {
    let stat;
    try { stat = lstatSync(dir); } catch { return false; }
    if (!stat.isDirectory() || read(join(dir, 'SKILL.md')) === skill) return false;
    cpSync(source, dir, { recursive: true });
    return true;
  });
}

const npmInstall = root => spawnSync('npm', ['install'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }).status === 0;

const subjects = (root, range) => git(root, ['log', '--reverse', '--format=%s', range]).out.split('\n').filter(Boolean);

/**
 * Fast-forward main from origin. Refuses on another branch and over local
 * changes to tracked files. Returns { from, to, subjects, installed, skills }
 * (installed: null when the dependencies did not change), or { refused, files? }.
 */
export function updateKit({ root = ROOT, home = homedir(), statePath = STATE_FILE, now = Date.now, install = npmInstall } = {}) {
  const head = kitHead(root);
  if (!head) return { refused: 'This kit is not a git clone (a downloaded zip?), so it cannot update itself. Get the newest with: git clone https://github.com/Sogni-AI/sogni-worlds-kit' };
  if (head.branch !== 'main') return { refused: `This clone is on ${head.branch}, not main, so it is yours to update. To follow the kit: git switch main, then node world update` };
  const changed = git(root, ['status', '--porcelain', '--untracked-files=no']).out;
  if (changed) {
    return { refused: 'These files have local changes, and an update never overwrites them. Commit or stash them (git stash), then run node world update again:', files: changed.split('\n').map(line => line.slice(3)) };
  }
  const pull = git(root, ['-c', 'advice.diverging=false', 'pull', '--ff-only', '--quiet', 'origin', 'main'], 120_000);
  if (!pull.ok) return { refused: `git could not fast-forward main from origin: ${pull.err}` };
  const to = git(root, ['rev-parse', 'HEAD']).out;
  const range = `${head.sha}..${to}`;
  const brought = to === head.sha ? [] : subjects(root, range);
  const dependencies = brought.length > 0 && Boolean(git(root, ['diff', '--name-only', range, '--', 'package.json', 'package-lock.json']).out);
  const installed = dependencies ? install(root) : null;
  const skills = refreshSkills({ root, home });
  clearNotice({ root, statePath, now });
  return { from: head.sha, to, subjects: brought, installed, skills };
}

function list(lines) {
  for (const line of lines.slice(0, SHOWN)) log.info(line);
  if (lines.length > SHOWN) log.dim(`…and ${lines.length - SHOWN} more (git log)`);
}

export async function run(argv) {
  const { values } = parse(argv, { check: { type: 'boolean' }, 'whats-new': { type: 'boolean' }, snooze: { type: 'boolean' } });

  if (values.snooze) {
    const snooze = snoozeUpdate();
    if (!snooze) log.ok('There is no update notice to pause.');
    else log.ok(`Update notices paused until ${new Date(snooze.until).toLocaleString()}. Update any time: node world update`);
    return 0;
  }

  if (values.check || values['whats-new']) {
    if (values.check && optedOut()) {
      log.ok('Update checks are off (SOGNI_NO_UPDATE_CHECK or NO_UPDATE_NOTIFIER). Update any time: node world update');
      return 0;
    }
    const result = checkForUpdate();
    if (result.skipped) {
      log.warn(`Could not check for an update: ${result.skipped}.`);
      return values.check ? 0 : 1;
    }
    if (!result.behind) {
      log.ok(`The kit is up to date (${result.short}).`);
      return 0;
    }
    log.ok(`Update available: ${result.behind} new commit${result.behind === 1 ? '' : 's'} on the Kit (you have ${result.short}).`);
    if (values['whats-new']) list(subjects(ROOT, 'HEAD..origin/main'));
    log.next(values['whats-new'] ? 'node world update' : 'node world update   (what changed: node world update --whats-new)');
    return 0;
  }

  log.title('Sogni Worlds kit — update');
  const result = updateKit();
  if (result.refused) {
    log.fail(result.refused);
    for (const file of result.files ?? []) log.info(file);
    return 1;
  }
  if (!result.subjects.length) log.ok(`The kit is up to date (${result.to.slice(0, 7)}).`);
  else {
    log.ok(`Updated ${result.from.slice(0, 7)} → ${result.to.slice(0, 7)}: ${result.subjects.length} new commit${result.subjects.length === 1 ? '' : 's'}`);
    list(result.subjects);
  }
  if (result.installed === true) log.ok('The dependencies changed, so npm install ran.');
  if (result.installed === false) log.fail('The dependencies changed, and npm install failed. Run it yourself: npm install');
  for (const dir of result.skills) log.ok(`Refreshed the sogni-worlds skill in ${dir}. Start a new agent session to load it.`);
  log.next('node world next');
  return result.installed === false ? 1 : 0;
}
