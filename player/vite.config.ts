// The player's dev server and build.
//   npm run dev                 plays examples/the-long-white-cloud (streamed from Sogni's CDN)
//   WORLD=<id> npm run dev      plays worlds/<id>/build/world.json (what `node world play <id>` does)
//   npm run build:player        a static player that reads ./world.json beside it (what `node world export` uses)
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

const PLAYER = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(PLAYER, '..');

const TYPES: Record<string, string> = {
  '.json': 'application/json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4',
  '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.glb': 'model/gltf-binary',
};

const EXAMPLES = join(REPO, 'examples');
const WORLDS = join(REPO, 'worlds');

/**
 * The file a request may read, or null. Only two places are served: examples/**
 * and a world's finished build, worlds/<id>/build/**. Photos, voices, renders,
 * receipts and the repo's .env (which holds your API key) are never reachable,
 * whatever the request's encoding: no segment may start with "." (which also
 * rules out ".." and dotfiles), and the resolved path is checked again.
 */
export function servableFile(rawUrl: string): string | null {
  let url: string;
  try {
    url = decodeURIComponent(rawUrl.split('?')[0]);
  } catch {
    return null;
  }
  const segments = url.split(/[\\/]+/).filter(Boolean);
  if (segments.some(segment => segment.startsWith('.') || segment.includes('\0'))) return null;
  const file = resolve(REPO, ...segments);
  const inside = (root: string) => file.startsWith(root + sep);
  if (segments[0] === 'examples' && inside(EXAMPLES)) return file;
  if (segments[0] === 'worlds' && segments.length >= 4 && segments[2] === 'build' && inside(join(WORLDS, segments[1], 'build'))) return file;
  return null;
}

/** Serve examples/ and worlds/<id>/build/ from the repo, with byte ranges so video can seek. */
function repoFolders(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = (req.url ?? '').split('?')[0];
    if (!/^\/(worlds|examples)(\/|%2f|%5c)/i.test(path)) return next();
    const file = servableFile(path);
    if (!file || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end('Not found');
    }
    const size = statSync(file).size;
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (!(start >= 0 && start <= end && end < size)) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return stream(createReadStream(file, { start, end }), res);
    }
    res.setHeader('Content-Length', String(size));
    stream(createReadStream(file), res);
  };
  // A file removed or unreadable mid-stream ends that one response, never the dev server.
  const stream = (source: ReturnType<typeof createReadStream>, res: ServerResponse) => {
    source.on('error', () => res.destroy());
    source.pipe(res);
  };
  return {
    name: 'sogni-world-folders',
    configureServer: server => { server.middlewares.use(serve); },
    configurePreviewServer: server => { server.middlewares.use(serve); },
  };
}

export default defineConfig(({ command }) => {
  const world = process.env.WORLD;
  const defaultWorld = process.env.VITE_DEFAULT_WORLD
    ?? (command === 'serve' ? (world ? `/worlds/${world}/build/world.json` : '/examples/the-long-white-cloud/world.json') : '');
  return {
    root: PLAYER,
    base: './',
    envDir: PLAYER, // never the repo root: its .env holds your API key
    publicDir: join(PLAYER, 'public'),
    define: { 'import.meta.env.VITE_DEFAULT_WORLD': JSON.stringify(defaultWorld) },
    plugins: [repoFolders()],
    server: {
      port: Number(process.env.PORT ?? 5173),
      host: process.env.HOST ?? 'localhost',
      // Vite's own /@fs/ route may read only the player and its dependencies,
      // never a world's photos, voices or renders elsewhere in the repo.
      fs: { strict: true, allow: [PLAYER, join(REPO, 'node_modules')] },
    },
    build: {
      outDir: resolve(REPO, process.env.PLAYER_OUT ?? 'dist/player'),
      emptyOutDir: true,
      assetsDir: 'player-assets',
      // model-viewer (the 3D figure viewer) is one 1 MB chunk, loaded only when a figure is opened.
      chunkSizeWarningLimit: 1100,
    },
  };
});
