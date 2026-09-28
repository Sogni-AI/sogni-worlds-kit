import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import { platform } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { parse } from '../index.js';
import { CREDENTIALS_FILE, sogniCredentials } from '../lib/env.js';
import { connect, describeBilling, LINKS } from '../lib/sogni.js';
import { log } from '../lib/log.js';
import { run as doctor } from './doctor.js';

export const summary = 'Connect your Sogni API key, check your plan, and install the Creative Agent Skill';
export const usage = 'node world setup [--key <api key>]   (without --key it asks; the key is saved where the Creative Agent Skill finds it too)';

const onPath = command => spawnSync(platform() === 'win32' ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;

/** The Sogni Creative Agent Skill, installed the way each agent expects it. */
export const SKILL_INSTALL = {
  'Claude Code': {
    command: 'claude',
    steps: ['In Claude Code, type:  /plugin marketplace add Sogni-AI/sogni-creative-agent-skill', 'then:                 /plugin install sogni-creative-agent@sogni'],
  },
  Codex: {
    command: 'codex',
    steps: ['codex plugin marketplace add Sogni-AI/sogni-creative-agent-skill', 'codex plugin add sogni-creative-agent@sogni'],
  },
  Hermes: {
    command: 'hermes',
    steps: ['hermes skills install skills-sh/sogni-ai/sogni-creative-agent-skill/sogni-creative-agent-skill', 'sogni-agent-hermes doctor   (after the npm install below)'],
  },
};
export const SKILL_CLI = ['npm install -g @sogni-ai/sogni-creative-agent-skill@latest', 'sogni-agent doctor'];

/** Save the key as SOGNI_API_KEY in the shared credentials file, keeping any other lines. */
export function saveKey(key, file = CREDENTIALS_FILE) {
  mkdirSync(dirname(file), { recursive: true });
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line && !/^\s*(export\s+)?SOGNI_API_KEY\s*=/.test(line)) : [];
  writeFileSync(file, `${[`SOGNI_API_KEY=${key}`, ...lines].join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

async function works() {
  try {
    const session = await connect();
    session.close();
    return session;
  } catch (error) {
    return { error };
  }
}

export async function run(argv) {
  const { values } = parse(argv, { key: { type: 'string' } });
  log.title('Sogni Worlds kit — setup');

  let session = null;
  if (values.key) {
    process.env.SOGNI_API_KEY = values.key.trim();
    session = await works();
    if (session.error) throw new Error(`That key did not sign in: ${session.error.message}`);
    saveKey(values.key.trim());
    log.ok(`Signed in as ${session.username}; key saved to ${CREDENTIALS_FILE} (readable only by you)`);
  } else if (sogniCredentials()) {
    session = await works();
    if (session.error) log.warn(`The saved key did not sign in (${session.error.message})`);
    else log.ok(`Already connected as ${session.username} (key from ${sogniCredentials().source})`);
  }

  if (!session || session.error) {
    if (!process.stdin.isTTY) {
      throw new Error(`No working API key. Get one at ${LINKS.apiKey}, then run in your own terminal: node world setup   (or: node world setup --key <key>)`);
    }
    log.info(`Get an API key at ${LINKS.apiKey}`);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const key = (await rl.question('Paste your Sogni API key: ')).trim();
    rl.close();
    if (!key) throw new Error('No key entered; nothing was saved');
    process.env.SOGNI_API_KEY = key;
    session = await works();
    if (session.error) throw new Error(`That key did not sign in: ${session.error.message}`);
    saveKey(key);
    log.ok(`Signed in as ${session.username}; key saved to ${CREDENTIALS_FILE} (readable only by you)`);
  }

  log.title('Your plan');
  if (session.tier === 'unlimited_pro') {
    log.ok('Unlimited Pro is active: every model a world uses is covered, four films render at once, and you get four times the daily fair-use capacity.');
  } else if (session.tier === 'unlimited') {
    log.ok('Unlimited is active: every model a world uses is covered.');
    log.info(`A 20-place world is ~60 films. Unlimited Pro ($50/mo) renders four at once instead of two and has 4× the daily capacity: ${LINKS.plans}`);
  } else {
    log.warn('No Unlimited plan on this account. Strongly recommended for building worlds:');
    log.info('A world is dozens of 2K films plus retakes. Unlimited ($20/mo) or Unlimited Pro ($50/mo) covers MiniMax H3,');
    log.info('SAM 3, voices, music and the LLM — no per-film charges. Without a plan, each 2K film costs roughly');
    log.info('$0.60–$1.20 in Spark, and you always see the quote before anything renders.');
    log.info(`Plans: ${LINKS.plans}   Subscribe: ${LINKS.subscribe}`);
  }
  log.info(`Billing for renders: ${describeBilling(session.billing)}`);

  log.title('The Sogni Creative Agent Skill');
  log.info('This kit renders worlds on its own; the skill lets your agent make anything else on Sogni —');
  log.info('new stills, keyframes, character edits, voices, music, 3D — with the same API key.');
  const agents = Object.entries(SKILL_INSTALL).filter(([, agent]) => onPath(agent.command));
  for (const [name, agent] of agents.length ? agents : Object.entries(SKILL_INSTALL)) {
    log.step(`${name}${agents.length ? ' (found)' : ''}`);
    for (const step of agent.steps) log.info(step);
  }
  log.step('Every agent: the command-line tool the skill runs');
  for (const step of SKILL_CLI) log.info(step);
  if (onPath('sogni-agent')) log.ok('sogni-agent is already installed');

  log.title('Checking everything');
  const code = await doctor([]);
  if (code === 0) log.next('node world new <id>   — then put your photos in worlds/<id>/photos/');
  return code;
}

