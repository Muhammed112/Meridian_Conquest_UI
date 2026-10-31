import { firebaseCliAuth } from './firebase-admin-access.mjs';
// One-time setup: dedicated updater credentials go only into GitHub Secrets.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { firebaseConfig } from '../dist/firebase-config.js';
const repo = 'Muhammed112/Meridian_Conquest_UI';
let githubToken;
async function github(route, method = 'GET', body) {
  const response = await fetch('https://api.github.com/repos/' + repo + route, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: {
      Authorization: 'Bearer ' + githubToken,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) throw new Error('GitHub ' + route + ' failed (HTTP ' + response.status + ').');
  return response.status === 204 ? null : response.json();
}
async function main() {
  let credential;
  try {
    credential = execFileSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new Error('GitHub Credential Manager is unavailable.');
  }
  githubToken = credential
    .split(/\r?\n/)
    .find((line) => line.startsWith('password='))
    ?.slice(9);
  if (!githubToken) throw new Error('GitHub credentials are unavailable.');
  const key = await github('/actions/secrets/public-key');
  const permissions = await github('/actions/permissions');
  console.log(
    'GitHub Actions ' +
      (permissions.enabled ? 'enabled' : 'disabled') +
      '; repository secrets are accessible.',
  );
  if (process.argv.includes('--inspect')) return;
  if (process.argv.includes('--dispatch')) {
    await github('/actions/workflows/populations.yml/dispatches', 'POST', { ref: 'main' });
    console.log(
      'Daily population workflow dispatched: https://github.com/' +
        repo +
        '/actions/workflows/populations.yml',
    );
    return;
  }
  if (process.argv.includes('--status')) {
    const runs = await github('/actions/workflows/populations.yml/runs?per_page=1');
    for (const run of runs.workflow_runs || [])
      console.log(
        JSON.stringify({
          id: run.id,
          status: run.status,
          conclusion: run.conclusion,
          url: run.html_url,
        }),
      );
    return;
  }
  if (!permissions.enabled) throw new Error('Enable GitHub Actions for this repository first.');
  const require = createRequire(import.meta.url),
    cli = firebaseCliAuth(),
    sodium = require('libsodium-wrappers');
  await sodium.ready;
  const account = cli.getGlobalDefaultAccount();
  if (!account) throw new Error('Run firebase login first.');
  const token = (
    await cli.getAccessToken(account.tokens.refresh_token, [
      'https://www.googleapis.com/auth/cloud-platform',
    ])
  ).access_token;
  const base = 'https://identitytoolkit.googleapis.com/v1/projects/' + firebaseConfig.projectId;
  const api = async (route, body) => {
    const response = await fetch(base + route, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok)
      throw new Error(
        'Firebase updater setup ' + route + ' failed (HTTP ' + response.status + ').',
      );
    return response.json();
  };
  const email = 'population-updater@' + firebaseConfig.projectId + '.invalid',
    password = randomBytes(36).toString('base64url');
  const found = await api('/accounts:lookup', { email: [email] }),
    old = found.users?.[0];
  if (old && !JSON.parse(old.customAttributes || '{}').populationUpdater)
    throw new Error('An unrelated account has the updater address; no account was changed.');
  const user =
    old || (await api('/accounts', { email, password, displayName: 'Population data updater' }));
  const uid = user.localId;
  if (!uid) throw new Error('Firebase did not return the updater account ID.');
  await api('/accounts:update', {
    localId: uid,
    password,
    customAttributes: JSON.stringify({ populationUpdater: true }),
  });
  for (const [name, value] of Object.entries({
    POPULATION_UPDATER_EMAIL: email,
    POPULATION_UPDATER_PASSWORD: password,
  })) {
    const encrypted = sodium.to_base64(
      sodium.crypto_box_seal(
        sodium.from_string(value),
        sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL),
      ),
      sodium.base64_variants.ORIGINAL,
    );
    await github('/actions/secrets/' + name, 'PUT', {
      encrypted_value: encrypted,
      key_id: key.key_id,
    });
  }
  console.log(
    'Dedicated population updater configured. Credentials encrypted in GitHub Secrets; no administrator token is stored.',
  );
  if (process.argv.includes('--verify')) {
    process.env.POPULATION_UPDATER_EMAIL = email;
    process.env.POPULATION_UPDATER_PASSWORD = password;
    const { updatePopulations, populationDocument, populationURL } =
      await import('./update-populations.mjs');
    const snapshot = await updatePopulations({ publishRemote: true });
    const signIn = async (email, password) => {
      const response = await fetch(
        'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=' +
          firebaseConfig.apiKey,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
      );
      const value = await response.json();
      assert.ok(response.ok && value.idToken, 'Fixture sign-in must succeed');
      return value.idToken;
    };
    const updaterToken = await signIn(email, password),
      documents = `https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
    for (const route of [`/users/${uid}/games/permission-check`, '/rooms/ZZZ999']) {
      const response = await fetch(documents + route, {
        headers: { Authorization: 'Bearer ' + updaterToken },
      });
      assert.equal(response.status, 403, 'Updater cannot access gameplay data');
    }
    const publicRead = await fetch(populationURL);
    assert.equal(publicRead.status, 200, 'Public snapshot is readable without sign-in');
    let fixture;
    try {
      const fixturePassword = randomBytes(30).toString('base64url'),
        fixtureEmail =
          'meridian-population-check-' + randomBytes(8).toString('hex') + '@example.invalid';
      fixture = await api('/accounts', {
        email: fixtureEmail,
        password: fixturePassword,
        displayName: 'Temporary population rules check',
      });
      const playerToken = await signIn(fixtureEmail, fixturePassword);
      for (const player of [null, playerToken]) {
        const response = await fetch(documents + ':commit', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(player ? { Authorization: 'Bearer ' + player } : {}),
          },
          body: JSON.stringify({
            writes: [
              {
                update: {
                  name: populationDocument,
                  fields: { payload: { stringValue: JSON.stringify(snapshot) } },
                },
                updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }],
              },
            ],
          }),
        });
        assert.equal(
          response.status,
          403,
          'Players and anonymous requests cannot publish population figures',
        );
      }
    } finally {
      if (fixture?.localId) await api('/accounts:delete', { localId: fixture.localId });
    }
    console.log(
      'PASS: public reads; updater-only publication; updater gameplay access denied; player and anonymous writes denied; temporary account removed.',
    );
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
