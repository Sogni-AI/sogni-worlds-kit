#!/usr/bin/env node
// Publish the kit's agent skill (skills/sogni-worlds) to ClawHub as
// @sogni-ai/sogni-worlds, beside @sogni-ai/sogni-creative-agent-skill.
//
// The skill is the way in: an agent that installs it clones this repository and
// follows AGENTS.md. So it is published only from a commit GitHub already has
// (origin/main contains it), staged from that commit (never the working tree),
// and only at the kit's version: package.json's version, which the skill's
// `metadata.version` must match. ClawHub never takes a version twice, so a
// changed skill is published by bumping both. It refuses a version older than
// ClawHub's latest, and does nothing when ClawHub already lists the version.
//
//   npm run publish:clawhub -- --changelog "What changed for someone using the skill"
//   npm run publish:clawhub -- --dry-run          # stage and preview only
//   npm run check:clawhub                         # exit 1 when ClawHub lacks the kit's version
//
// The ClawHub CLI is the exact devDependency in package.json; this runs that
// copy, never an unpinned npx. Publishing needs a login that is a member of @sogni-ai.

import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLAWHUB_OWNER = 'sogni-ai';
const CLAWHUB_SLUG = 'sogni-worlds';
const CLAWHUB_NAME = 'Sogni Worlds';
const CLAWHUB_REF = `@${CLAWHUB_OWNER}/${CLAWHUB_SLUG}`;
const CLAWHUB_BIN = join(repoRoot, 'node_modules', '.bin', 'clawhub');
const SKILL_DIR = 'skills/sogni-worlds';
const SOURCE_REPO = 'Sogni-AI/sogni-worlds-kit';
const BRANCH = 'main';
// Copied beside SKILL.md: the kit's license.
const EXTRA_FILES = ['LICENSE'];
// Any of these makes ClawHub classify the upload as a code plugin.
const FORBIDDEN = ['package.json', 'openclaw.plugin.json', 'openclaw-plugin.mjs'];

function fail(message) {
  console.error(`publish-clawhub: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const opts = { dryRun: false, check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--changelog') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) fail(`${arg} needs a value`);
      opts.changelog = value;
      i += 1;
    } else fail(`unknown argument ${arg}`);
  }
  return opts;
}

const run = (cmd, args, options = {}) => execFileSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
const clawhub = args => run(CLAWHUB_BIN, args);

function compareVersions(left, right) {
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

/** The kit's version at a commit, and the skill's own, which must be the same. */
function versionsAt(commit) {
  const kit = JSON.parse(run('git', ['show', `${commit}:package.json`])).version;
  const skill = run('git', ['show', `${commit}:${SKILL_DIR}/SKILL.md`]);
  const front = /^---\n([\s\S]*?)\n---/.exec(skill);
  if (!front) fail(`${SKILL_DIR}/SKILL.md at ${commit.slice(0, 7)} has no frontmatter`);
  const meta = parseYaml(front[1]);
  return { kit, skill: String(meta?.metadata?.version ?? ''), name: meta?.name };
}

/** What ClawHub lists: its latest version and every version, or nothing before the first publish. */
function clawhubState() {
  let out;
  try {
    out = clawhub(['inspect', CLAWHUB_REF, '--versions', '--limit', '200', '--json']);
  } catch (error) {
    const text = String(error.stderr ?? error.message).trim();
    if (/not found/i.test(text)) return { latest: null, versions: [], moderation: null };
    fail(`clawhub inspect ${CLAWHUB_REF} failed: ${text}`);
  }
  const data = JSON.parse(out.slice(out.indexOf('{')));
  const versions = (data.versions?.items ?? data.versions ?? []).map(entry => entry.version);
  return { latest: data.skill?.tags?.latest ?? null, versions, moderation: data.moderation ?? null };
}

function listFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

/** The skill's folder and the kit's license, as they are at `commit`. */
function stage(commit) {
  const workDir = mkdtempSync(join(tmpdir(), 'sogni-worlds-clawhub-'));
  const treeDir = join(workDir, 'tree');
  const stageDir = join(workDir, CLAWHUB_SLUG);
  mkdirSync(treeDir);
  const archive = spawnSync('git', ['archive', '--format=tar', commit, SKILL_DIR, ...EXTRA_FILES], { cwd: repoRoot, maxBuffer: 1 << 26 });
  if (archive.status !== 0) fail(`git archive ${commit} failed: ${archive.stderr}`);
  const untar = spawnSync('tar', ['-x', '-C', treeDir], { input: archive.stdout });
  if (untar.status !== 0) fail(`extracting ${commit} failed: ${untar.stderr}`);
  cpSync(join(treeDir, SKILL_DIR), stageDir, { recursive: true });
  for (const file of EXTRA_FILES) {
    if (!existsSync(join(treeDir, file))) fail(`${commit.slice(0, 7)} has no ${file}`);
    cpSync(join(treeDir, file), join(stageDir, file));
  }
  const staged = listFiles(stageDir).map(file => relative(stageDir, file)).sort();
  const forbidden = staged.filter(path => FORBIDDEN.includes(path));
  if (forbidden.length) fail(`staged skill contains ${forbidden.join(', ')}`);
  return { workDir, stageDir, staged };
}

const opts = parseArgs(process.argv.slice(2));
if (!existsSync(CLAWHUB_BIN)) fail('the pinned ClawHub CLI is not installed. Run: npm install');

// What GitHub has: the skill tells every agent to clone it.
try {
  run('git', ['fetch', '--quiet', 'origin', BRANCH]);
} catch (error) {
  fail(`git fetch origin ${BRANCH} failed: ${String(error.stderr ?? error.message).trim()}`);
}

if (opts.check) {
  const { kit, skill } = versionsAt(`origin/${BRANCH}`);
  if (skill !== kit) fail(`on origin/${BRANCH} the skill's metadata.version is ${skill || 'missing'} but package.json is ${kit}`);
  const { latest } = clawhubState();
  if (latest === kit) {
    console.log(`ClawHub ${CLAWHUB_REF} matches the kit: ${kit}`);
    process.exit(0);
  }
  fail(`ClawHub ${CLAWHUB_REF} is at ${latest ?? 'nothing (not listed yet)'}, the kit on ${BRANCH} is ${kit}. If ${kit} was published in the last hour it is still in ClawHub's security scans; otherwise run npm run publish:clawhub -- --changelog "…"`);
}

const commit = run('git', ['rev-parse', 'HEAD']).trim();
try {
  run('git', ['merge-base', '--is-ancestor', commit, `origin/${BRANCH}`]);
} catch {
  const why = `HEAD ${commit.slice(0, 7)} is not on origin/${BRANCH} yet. Push it first: the skill points every agent at what GitHub has.`;
  if (!opts.dryRun) fail(why);
  console.log(`Note (dry run): ${why}`);
}
const { kit: version, skill: skillVersion, name } = versionsAt(commit);
if (name !== CLAWHUB_SLUG) fail(`the skill is named ${name}, not ${CLAWHUB_SLUG}`);
if (skillVersion !== version) fail(`${SKILL_DIR}/SKILL.md metadata.version is ${skillVersion || 'missing'}; package.json is ${version}. Make them the same.`);
if (!opts.dryRun && !opts.changelog) fail('say what changed for someone using the skill: --changelog "…"');
if (run('git', ['status', '--porcelain', '--', SKILL_DIR, 'LICENSE', 'package.json']).trim()) {
  console.log(`Note: ${SKILL_DIR} has uncommitted changes; they are not published (the commit is).`);
}

let login = '';
try {
  login = clawhub(['whoami']).trim().split('\n').pop();
} catch (error) {
  fail(`not logged in to ClawHub (${String(error.stderr ?? error.message).trim()}). Log in with ./node_modules/.bin/clawhub login as a member of @${CLAWHUB_OWNER}.`);
}

const before = clawhubState();
if (before.versions.includes(version)) {
  console.log(`ClawHub ${CLAWHUB_REF} already has ${version} (latest ${before.latest}). To publish a changed skill, bump package.json's version and the skill's metadata.version together.`);
  process.exit(0);
}
if (before.latest && compareVersions(version, before.latest) < 0) {
  fail(`ClawHub's latest is ${before.latest}; publishing the older ${version} would move latest back to it.`);
}

const { workDir, stageDir, staged } = stage(commit);
const changelog = opts.changelog ?? '(dry run)';
console.log(`Staged ${staged.join(', ')} from ${commit.slice(0, 7)} in ${stageDir}`);
console.log(`Publishing ${CLAWHUB_REF}@${version} as ${login}${before.latest ? `, replacing latest ${before.latest}` : ' (its first version)'}`);
console.log(`Changelog: ${changelog}`);

const publishArgs = [
  'publish', stageDir,
  '--owner', CLAWHUB_OWNER,
  '--slug', CLAWHUB_SLUG,
  '--name', CLAWHUB_NAME,
  '--version', version,
  '--changelog', changelog,
  '--source-repo', SOURCE_REPO,
  '--source-commit', commit,
  '--source-ref', BRANCH,
  '--source-path', SKILL_DIR,
];
if (opts.dryRun) {
  const result = spawnSync(CLAWHUB_BIN, [...publishArgs, '--dry-run'], { cwd: repoRoot, stdio: 'inherit' });
  if (result.status !== 0) fail(`clawhub publish --dry-run exited ${result.status}; the staged files are in ${stageDir}`);
  console.log(`Dry run only. The staged files are in ${stageDir}`);
  process.exit(0);
}
const result = spawnSync(CLAWHUB_BIN, [...publishArgs, '--json'], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
if (result.status !== 0) fail(`clawhub publish exited ${result.status}. Publishing needs a member of @${CLAWHUB_OWNER}. The staged files are in ${stageDir}`);
rmSync(workDir, { recursive: true, force: true });
const published = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));

// ClawHub hides a new version until its security scans pass (minutes; once over two hours).
if (published.publicationStatus === 'pending') {
  console.log(`ClawHub accepted ${version} and is running its security scans. It stays hidden until they pass.`);
  console.log(`Do not publish ${version} again. npm run check:clawhub confirms when ClawHub's latest is ${version}.`);
  process.exit(0);
}
const after = clawhubState();
if (!after.versions.includes(version)) fail(`clawhub publish reported ${published.publicationStatus ?? 'no status'}, but ClawHub does not list ${version}.`);
console.log(`ClawHub ${CLAWHUB_REF} lists ${version}; latest ${after.latest}; scan verdict ${after.moderation?.verdict ?? 'unknown'}.`);
