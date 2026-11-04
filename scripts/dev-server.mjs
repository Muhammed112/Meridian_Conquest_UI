import { localAppCheck } from './local-app-check.mjs';
// Serves the game on loopback only. The private App Check debug token is kept
// outside dist, excluded from Git/Hosting, and never printed.
import { createServer } from 'node:http';

import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from '../dist/firebase-config.js';
import { createLocalPopulationSource } from './local-populations.mjs';
const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  root = path.join(workspace, 'dist');

const debug = await localAppCheck({
  config: firebaseConfig,
  cache: path.join(workspace, '.firebase', 'app-check-debug.json'),
});
const types = {
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.png': 'image/png',
};
const localPopulations = await createLocalPopulationSource({
  file: path.join(workspace, '.firebase', 'population-cache.json'),
  onError: () =>
    console.warn(
      'Worldometers is unavailable or failed validation; keeping the saved population snapshot.',
    ),
});
const server = createServer(async (req, res) => {
  try {
    const request = new URL(req.url, 'http://' + req.headers.host);
    if (!['localhost', '127.0.0.1'].includes(request.hostname)) {
      res.writeHead(403).end();
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.pathname === '/population-data.json') {
      res
        .writeHead(200, { 'Content-Type': 'application/json' })
        .end(JSON.stringify(localPopulations.snapshot));
      return;
    }
    // This dynamic module is available only from the loopback server, never from public dist assets.
    if (request.pathname === '/ai-local-config.js') {
      res
        .writeHead(200, { 'Content-Type': 'text/javascript' })
        .end(
          'export const localDevelopment=true; export const localAppCheckDebugToken=' +
            JSON.stringify(debug?.token || null) +
            ';',
        );
      return;
    }
    // Resolve symlinks and traversal before exposing a file, keeping private workspace files outside root.
    const file = await realpath(
      path.resolve(
        root,
        '.' + decodeURIComponent(request.pathname === '/' ? '/index.html' : request.pathname),
      ),
    );
    if (!file.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    res
      .writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' })
      .end(await readFile(file));
  } catch {
    res.writeHead(404).end();
  }
});
server.on('error', (error) => {
  console.error(
    error.code === 'EADDRINUSE'
      ? 'Port is busy. Set MERIDIAN_PORT to another port.'
      : error.message,
  );
  process.exitCode = 1;
});
server.listen(Number(process.env.MERIDIAN_PORT || 8081), '127.0.0.1', () =>
  console.log('Meridian Conquest: http://localhost:' + server.address().port),
);
// Serve the offline snapshot immediately; failed background refreshes cannot prevent game startup.
void localPopulations.refresh();
setInterval(() => void localPopulations.refresh(), 3600000).unref();
