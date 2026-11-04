import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAppCheck } from '../scripts/local-app-check.mjs';

// A developer without CLI access must still start the game without triggering privileged App Check
// requests.
test('a fresh checkout can start without CLI credentials or contacting the App Check API', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = () => assert.fail('Signed-out development must not call the App Check API');
  const warnings = [],
    options = {
      config: { appId: 'test-app' },
      cache: new URL('../.firebase/missing-' + randomUUID() + '.json', import.meta.url),
      warn: (message) => warnings.push(message),
    };
  try {
    assert.equal(
      await localAppCheck({ ...options, getAuth: () => ({ getGlobalDefaultAccount: () => null }) }),
      null,
    );
    assert.match(warnings[0], /npx firebase login/);
    assert.equal(
      await localAppCheck({
        ...options,
        getAuth: () => {
          throw new Error('CLI unavailable');
        },
      }),
      null,
    );
    assert.match(warnings[1], /Gameplay and saves remain available/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
