// Exercise the shared fixture server locally; no Firebase or external requests are made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../scripts/lib/static-server.mjs';

// The shared browser-test server must load real modules without allowing traversal into private
// project files.
test('browser fixtures serve modules without exposing files outside the public directory', async () => {
  const server = await startTestServer();
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [route, contentType] of [
      ['/', 'text/html'],
      ['/engine.js', 'text/javascript'],
    ]) {
      const response = await fetch(origin + route);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), new RegExp(contentType));
      assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
    for (const route of ['/%2e%2e%2fREADME.md', '/%ZZ', '/missing-fixture.js']) {
      const response = await fetch(origin + route);
      assert.ok([403, 404].includes(response.status), route);
      await response.text();
    }
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
