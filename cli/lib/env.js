// Credentials and billing settings. One API key configures this kit and the
// Sogni Creative Agent Skill alike: SOGNI_API_KEY in the environment, in this
// repo's .env, or in ~/.config/sogni/credentials (the file the skill's setup writes).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from './paths.js';

export const CREDENTIALS_FILE = process.env.SOGNI_CREDENTIALS_PATH || join(homedir(), '.config', 'sogni', 'credentials');

/** KEY=VALUE lines; # comments; optional quotes. */
export function parseEnvFile(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trim().startsWith('#')) continue;
    values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

let loaded = false;
/** Load the repo's .env into process.env without overriding anything already set. */
export function loadEnv() {
  if (loaded) return;
  loaded = true;
  const file = join(ROOT, '.env');
  if (!existsSync(file)) return;
  for (const [key, value] of Object.entries(parseEnvFile(readFileSync(file, 'utf8')))) {
    if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
  }
}

/**
 * The credentials to sign in with, and where they came from. An API key is the
 * supported path; username and password are accepted for accounts without one.
 */
export function sogniCredentials() {
  loadEnv();
  if (process.env.SOGNI_API_KEY) return { apiKey: process.env.SOGNI_API_KEY, source: 'SOGNI_API_KEY' };
  if (existsSync(CREDENTIALS_FILE)) {
    const values = parseEnvFile(readFileSync(CREDENTIALS_FILE, 'utf8'));
    if (values.SOGNI_API_KEY) return { apiKey: values.SOGNI_API_KEY, source: CREDENTIALS_FILE };
  }
  if (process.env.SOGNI_USERNAME && process.env.SOGNI_PASSWORD) {
    return { username: process.env.SOGNI_USERNAME, password: process.env.SOGNI_PASSWORD, source: 'SOGNI_USERNAME/SOGNI_PASSWORD' };
  }
  return null;
}

/**
 * How renders are paid for. Unset means: an active Unlimited plan pays
 * ("subscription"), otherwise your token balance ("tokens"). The choice is
 * always printed before anything is submitted; nothing switches silently.
 */
export function billingPreference() {
  loadEnv();
  const mode = (process.env.SOGNI_BILLING_MODE || '').trim().toLowerCase();
  if (mode && !['subscription', 'tokens', 'auto'].includes(mode)) {
    throw new Error(`SOGNI_BILLING_MODE must be subscription, tokens or auto (got "${mode}")`);
  }
  const raw = (process.env.SOGNI_TOKEN_TYPE || '').trim().toLowerCase();
  const tokenType = ['', 'undefined', 'null'].includes(raw) ? 'spark' : raw;
  if (!['spark', 'sogni'].includes(tokenType)) throw new Error(`SOGNI_TOKEN_TYPE must be spark or sogni (got "${tokenType}")`);
  return { mode: mode || null, tokenType };
}
