// Isolated operator tests: no credentials, accounts or cloud configuration are changed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { hostingDomain, configureHostingDomain } from '../scripts/configure-hosting-domain.mjs';

/** Keep realistic existing settings so tests detect destructive domain replacements. */
function fixture() {
  const projectId = 'meridian-test';
  const siteKey = 'site-key';
  const auth = { authorizedDomains: ['localhost', 'existing.web.app'], signIn: { email: true } };
  const key = {
    name: `projects/${projectId}/keys/${siteKey}`,
    webSettings: {
      allowedDomains: ['existing.web.app'],
      integrationType: 'SCORE',
      allowAllDomains: false,
    },
  };
  const writes = [];
  const backups = [];
  const options = {
    projectId,
    siteKey,
    domain: 'https://my-game.vercel.app',
    async beforeApply(settings) {
      backups.push(structuredClone(settings));
    },
    async request(url, method = 'GET', body) {
      if (method === 'PATCH') {
        writes.push({ url, body });
        assert.equal(backups.length, 1, 'Back up original domain lists before the first write');
        if (url.includes('identitytoolkit')) auth.authorizedDomains = body.authorizedDomains;
        else key.webSettings.allowedDomains = body.webSettings.allowedDomains;
      }
      return structuredClone(url.includes('identitytoolkit') ? auth : key);
    },
  };
  return { options, auth, key, writes, backups };
}

// Hosting authorization must accept one exact production host without permitting an entire shared
// domain.
test('hosting setup accepts exact HTTPS hostnames and refuses broad or local authorization', () => {
  assert.equal(hostingDomain(' HTTPS://My-Game.vercel.app/ '), 'my-game.vercel.app');
  assert.equal(hostingDomain('game.example.com'), 'game.example.com');
  for (const value of [
    '',
    'http://game.vercel.app',
    'localhost',
    'test.localhost',
    '127.0.0.1',
    'vercel.app',
    'web.app',
    'firebaseapp.com',
    '*.vercel.app',
    'game.vercel.app/path',
    'game.vercel.app?query=1',
    'game.vercel.app#game/one',
    'game.vercel.app:8080',
    'https://user:password@game.vercel.app',
  ])
    assert.throws(() => hostingDomain(value), value);
});

// Inspecting a setup plan must remain read-only so operators can review it before authorizing
// changes.
test('preview never writes remote settings or creates a backup', async () => {
  const { options, writes, backups } = fixture();
  const plan = await configureHostingDomain(options);
  assert.equal(plan.mode, 'preview');
  assert.equal(plan.addAuthenticationDomain, true);
  assert.equal(plan.addAppCheckDomain, true);
  assert.deepEqual(writes, []);
  assert.deepEqual(backups, []);
});

// Adding a host must preserve existing sign-in and App Check restrictions, including when rerun
// later.
test('applying adds one domain, keeps existing domains and protections, and is idempotent', async () => {
  const { options, auth, key, writes, backups } = fixture();
  const result = await configureHostingDomain({ ...options, apply: true });
  assert.equal(result.verified, true);
  assert.deepEqual(auth.authorizedDomains, ['localhost', 'existing.web.app', 'my-game.vercel.app']);
  assert.deepEqual(key.webSettings.allowedDomains, ['existing.web.app', 'my-game.vercel.app']);
  assert.deepEqual(auth.signIn, { email: true });
  assert.equal(key.webSettings.allowAllDomains, false);
  assert.equal(key.webSettings.integrationType, 'SCORE');
  assert.deepEqual(Object.keys(backups[0]).sort(), [
    'allowedDomains',
    'authorizedDomains',
    'domain',
    'projectId',
    'recaptchaKey',
  ]);
  assert.ok(writes[0].url.endsWith('?updateMask=webSettings.allowedDomains'));
  assert.ok(writes[1].url.endsWith('?updateMask=authorizedDomains'));
  assert.deepEqual(Object.keys(writes[1].body), ['authorizedDomains']);
  await configureHostingDomain({ ...options, apply: true });
  assert.equal(writes.length, 2, 'Repeated setup does not write unchanged settings');
});

// Google APIs use different project identifiers; mixing them must not produce a partial hosting
// setup.
test('App Check uses the canonical project number while Auth retains the project ID', async () => {
  const { options, key, writes } = fixture();
  const projectNumber = '123456789';
  key.name = `projects/${projectNumber}/keys/${options.siteKey}`;
  const result = await configureHostingDomain({ ...options, projectNumber, apply: true });
  assert.equal(result.verified, true);
  assert.equal(writes[0].body.name, key.name);
  assert.ok(writes[0].url.includes('/projects/' + projectNumber + '/keys/'));
  assert.ok(writes[1].url.includes('/projects/' + options.projectId + '/config'));
  await assert.rejects(
    configureHostingDomain({ ...options, projectNumber: '../other-project', apply: true }),
    /must be configured/,
  );
  assert.equal(writes.length, 2, 'Invalid project numbers cannot trigger more writes');
});

// Unreadable or overly permissive existing settings must stop the operation before any partial
// mutation.
test('unreadable or unexpectedly broad configuration cannot trigger partial writes', async () => {
  const { options, key, writes } = fixture();
  await assert.rejects(
    configureHostingDomain({
      ...options,
      apply: true,
      request: async () => {
        throw new Error('Permission denied');
      },
    }),
    /Permission denied/,
  );
  key.webSettings.allowAllDomains = true;
  await assert.rejects(configureHostingDomain({ ...options, apply: true }), /manual review/);
  assert.deepEqual(writes, []);
});

// A failed local backup must block remote edits so the operator retains a recovery path.
test('failure to make the local backup prevents cloud changes', async () => {
  const { options, writes } = fixture();
  await assert.rejects(
    configureHostingDomain({
      ...options,
      apply: true,
      beforeApply: async () => {
        throw new Error('Storage unavailable');
      },
    }),
    /Storage unavailable/,
  );
  assert.deepEqual(writes, []);
});
