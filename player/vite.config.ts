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
  '.wav': 'audio/wav', '.ogg': 'audio/ogg',
};

/** Serve worlds/ and examples/ from the repo, with byte ranges so video can seek. */
function repoFolders(): Plugin {
  const serve = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = decodeURIComponent((req.url ?? '').split('?')[0]);
    if (!url.startsWith('/worlds/') && !url.startsWith('/examples/')) return next();
    const file = resolve(REPO, `.${url}`);
    if (!file.startsWith(REPO + sep) || !existsSync(file) || !statSync(file).isFile()) {
      res.statusCode = 404;
      return res.end(`Not found: ${url}`);
    }
    const size = statSync(file).size;
    res.setHeader('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');
    const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(end - start + 1));
      return createReadStream(file, { start, end }).pipe(res);
    }
    res.setHeader('Content-Length', String(size));
    createReadStream(file).pipe(res);
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
    server: { port: Number(process.env.PORT ?? 5173), host: process.env.HOST ?? 'localhost' },
    build: {
      outDir: resolve(REPO, process.env.PLAYER_OUT ?? 'dist/player'),
      emptyOutDir: true,
      assetsDir: 'player-assets',
    },
  };
});
