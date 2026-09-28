// play: open a world in the player on this computer.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from '../index.js';
import { log } from '../lib/log.js';
import { listWorlds, resolveWorldId, worldPaths, shown } from '../lib/paths.js';
import { runVite } from '../lib/player.js';

export const summary = 'Play a world in your browser (no world, or "example": The Long White Cloud)';
export const usage = `node world play [world|example] [--port 5173]

  Starts the player on http://localhost:<port>/ with worlds/<world>/build/world.json
  (run \`node world build\` first). With no world yet, or "example", it plays the
  bundled example, The Long White Cloud, streamed from Sogni's CDN. Ctrl-C to stop.`;

export async function run(argv) {
  const { values, world } = parse(argv, { port: { type: 'string', default: '5173' } });
  const env = { ...process.env, PORT: values.port };
  delete env.WORLD;
  let label = 'The Long White Cloud (the bundled example)';
  if (world !== 'example' && (world || listWorlds().length)) {
    const id = resolveWorldId(world);
    const built = join(worldPaths(id).build, 'world.json');
    if (!existsSync(built)) {
      log.fail(`${shown(built)} does not exist yet.`);
      log.next(`node world build ${id}`);
      return 1;
    }
    env.WORLD = id;
    label = id;
  }
  log.ok(`Playing ${label} on http://localhost:${values.port}/`);
  log.dim('Tap to begin (browsers only play sound after a tap). Ctrl-C to stop.');
  let child;
  const stop = () => child?.kill('SIGINT');
  process.on('SIGINT', stop);
  try {
    return await runVite(['--port', values.port, '--strictPort'], { env, onSpawn: c => { child = c; } });
  } finally {
    process.off('SIGINT', stop);
  }
}
