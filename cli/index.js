// The command line. Each command is one file in cli/commands/ exporting
// `summary`, `usage` and `run(argv)`. `node world help` lists them in the
// order a world is built.
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './lib/env.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** In the order you use them. */
export const COMMANDS = [
  ['Set up', ['setup', 'doctor']],
  ['Plan', ['new', 'ingest', 'lint', 'plan', 'quote']],
  ['Make', ['select', 'render', 'narrate', 'music']],
  ['Judge', ['screen', 'note', 'reject', 'review']],
  ['Finish', ['build', 'play', 'export']],
  ['Where am I?', ['status', 'next']],
];

export async function main(argv) {
  loadEnv();
  const [name, ...rest] = argv;
  if (!name || name === 'help' || name === '--help' || name === '-h') return help(rest[0]);
  const file = join(HERE, 'commands', `${name}.js`);
  if (!existsSync(file)) {
    console.error(`Unknown command "${name}". Run: node world help`);
    return 1;
  }
  const command = await import(file);
  if (rest.includes('--help') || rest.includes('-h')) {
    console.log(`${command.summary}\n\nUsage: ${command.usage}`);
    return 0;
  }
  return command.run(rest);
}

async function help(name) {
  if (name) return main([name, '--help']);
  console.log('Build a Sogni World from your photos. Usage: node world <command> [world] [options]\n');
  for (const [group, names] of COMMANDS) {
    console.log(group);
    for (const commandName of names) {
      const file = join(HERE, 'commands', `${commandName}.js`);
      const summary = existsSync(file) ? (await import(file)).summary : '(not available)';
      console.log(`  ${commandName.padEnd(9)} ${summary}`);
    }
  }
  console.log('\nLost? `node world next` prints the one thing to do now. Details: node world help <command>');
  return 0;
}

/**
 * Parse a command's arguments. `options` follows node:util parseArgs; the
 * first positional is the world id (optional when there is only one world).
 */
export function parse(argv, options = {}) {
  const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  return { values, positionals, world: positionals[0] };
}
