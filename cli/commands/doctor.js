import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { parse } from '../index.js';
import { CREDENTIALS_FILE, sogniCredentials } from '../lib/env.js';
import { FFMPEG, FFPROBE, hasTool } from '../lib/media.js';
import { connect, describeBilling, LINKS, sdkVersion, TIER_NAMES } from '../lib/sogni.js';
import { log } from '../lib/log.js';

export const summary = 'Check Node, ffmpeg, your API key, your plan and the Creative Agent Skill';
export const usage = 'node world doctor [--json] [--offline]';

export const FFMPEG_INSTALL = {
  darwin: 'brew install ffmpeg',
  win32: 'winget install Gyan.FFmpeg',
  linux: 'sudo apt install ffmpeg   (or your distribution’s package manager)',
};

const onPath = command => spawnSync(platform() === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;

/** Every check as { name, ok, detail, fix?, optional? }. */
export async function checks({ offline = false } = {}) {
  const results = [];
  const add = (name, ok, detail, fix, optional = false) => results.push({ name, ok, detail, ...(fix ? { fix } : {}), ...(optional ? { optional } : {}) });

  const [major, minor] = process.versions.node.split('.').map(Number);
  add('node', major > 20 || (major === 20 && minor >= 10), `Node ${process.versions.node}`, 'Install Node 20.10 or newer from https://nodejs.org');
  const ffmpegOk = hasTool(FFMPEG) && hasTool(FFPROBE);
  add('ffmpeg', ffmpegOk, ffmpegOk ? 'ffmpeg and ffprobe found' : 'ffmpeg or ffprobe is missing', FFMPEG_INSTALL[platform()] ?? FFMPEG_INSTALL.linux);
  add('sdk', true, `@sogni-ai/sogni-client ${sdkVersion()}`);

  const credentials = sogniCredentials();
  add('api-key', Boolean(credentials), credentials ? `found in ${credentials.source}` : 'no API key', `node world setup   (get a key at ${LINKS.apiKey})`);

  if (credentials && !offline) {
    let session;
    try {
      session = await connect();
      add('sign-in', true, `signed in as ${session.username ?? 'unknown'}`);
      add('plan', Boolean(session.tier), session.tier ? `${TIER_NAMES[session.tier]} is active` : 'no Unlimited plan',
        `Recommended: an Unlimited plan covers every model a world uses (${LINKS.plans}); subscribe at ${LINKS.subscribe}`, true);
      add('billing', true, describeBilling(session.billing));
    } catch (error) {
      add('sign-in', false, error.message, `Check the key at ${LINKS.apiKey}, then: node world setup`);
    } finally {
      session?.close();
    }
  }

  const skill = onPath('sogni-agent');
  add('creative-skill', skill, skill ? 'sogni-agent (Sogni Creative Agent Skill) is installed' : 'the Sogni Creative Agent Skill CLI is not installed',
    'npm install -g @sogni-ai/sogni-creative-agent-skill@latest && sogni-agent doctor', true);
  return results;
}

export async function run(argv) {
  const { values } = parse(argv, { json: { type: 'boolean' }, offline: { type: 'boolean' } });
  const results = await checks({ offline: values.offline });
  const failed = results.filter(r => !r.ok && !r.optional);
  if (values.json) {
    console.log(JSON.stringify({ ok: failed.length === 0, credentialsFile: CREDENTIALS_FILE, checks: results }, null, 2));
    return failed.length ? 1 : 0;
  }
  log.title('Sogni Worlds kit — doctor');
  for (const result of results) {
    if (result.ok) log.ok(`${result.name.padEnd(15)} ${result.detail}`);
    else if (result.optional) log.warn(`${result.name.padEnd(15)} ${result.detail}`);
    else log.fail(`${result.name.padEnd(15)} ${result.detail}`);
    if (!result.ok && result.fix) log.dim(`fix: ${result.fix}`);
  }
  if (failed.length) {
    log.next(failed[0].fix ?? 'fix the item marked ✗ above');
    return 1;
  }
  log.next('node world new <id>   (or `node world next` if you already have a world)');
  return 0;
}
