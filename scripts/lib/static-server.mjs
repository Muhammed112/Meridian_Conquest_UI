import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

/** Serve browser fixtures on a free loopback port; callers close the server in finally. */
export async function startTestServer(directory = 'dist') {
  const root = await realpath(path.resolve(directory));
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      // Resolve symlinks as well as '..' before checking the public-file boundary.
      const file = await realpath(
        path.resolve(root, '.' + decodeURIComponent(pathname === '/' ? '/index.html' : pathname)),
      );
      if (!file.startsWith(root + path.sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      res
        .writeHead(200, {
          'Content-Type':
            {
              '.js': 'text/javascript',
              '.html': 'text/html',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
              '.mp3': 'audio/mpeg',
              '.ogg': 'audio/ogg',
            }[path.extname(file)] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        .end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  // Port zero avoids conflicts between independent suites and never exposes fixtures beyond loopback.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return server;
}
