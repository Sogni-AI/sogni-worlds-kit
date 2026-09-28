// Running the player's dev server and build (player/vite.config.ts).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { ROOT } from './paths.js';

export const PLAYER_CONFIG = join(ROOT, 'player', 'vite.config.ts');

/** Vite's command-line entry, run with this Node so it works the same on every OS. */
export function viteBin() {
  const pkgPath = createRequire(join(ROOT, 'package.json')).resolve('vite/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = join(dirname(pkgPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.vite ?? 'bin/vite.js');
  if (!existsSync(bin)) throw new Error('Vite is not installed. Run: npm install');
  return bin;
}

/** Run vite with the player config; resolves with its exit code. */
export function runVite(args, { env = process.env, onSpawn } = {}) {
  const child = spawn(process.execPath, [viteBin(), ...args, '--config', PLAYER_CONFIG], { cwd: ROOT, env, stdio: 'inherit' });
  onSpawn?.(child);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => resolve(code ?? 0));
  });
}
