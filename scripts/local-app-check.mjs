import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { firebaseCliAuth } from './firebase-admin-access.mjs';

/**
 * Restore or register a private loopback debug token; missing CLI credentials never block
 * gameplay.
 */
export async function localAppCheck({
  config,
  cache,
  warn = console.warn,
  getAuth = firebaseCliAuth,
}) {
  let saved = null;
  try {
    const candidate = JSON.parse(await readFile(cache, 'utf8'));
    if (candidate.appId === config?.appId && typeof candidate.token === 'string' && candidate.name)
      saved = candidate;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError))
      warn('Local AI configuration could not be read. Gameplay remains available.');
  }
  if (!config?.appId) return null;
  try {
    const cli = getAuth(),
      account = cli.getGlobalDefaultAccount();
    if (!account) {
      if (!saved) warn('For local AI commentary, run npx firebase login and restart npm run dev.');
      return saved;
    }
    const admin = (
      await cli.getAccessToken(account.tokens.refresh_token, [
        'https://www.googleapis.com/auth/cloud-platform',
      ])
    ).access_token;
    /** Read/register only App Check debug records using the operator's in-memory credential. */
    async function request(name, body) {
      const response = await fetch('https://firebaseappcheck.googleapis.com/v1/' + name, {
        method: body ? 'POST' : 'GET',
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok)
        throw Object.assign(new Error('App Check setup failed'), { status: response.status });
      return response.json();
    }
    // Check that a cached token still exists remotely; a revoked token should be replaced locally.
    if (saved) {
      try {
        await request(saved.name);
        return saved;
      } catch (error) {
        if (error.status !== 404) throw error;
        saved = null;
      }
    }
    const token = randomUUID();
    const record = await request(
      `projects/${config.messagingSenderId}/apps/${encodeURIComponent(config.appId)}/debugTokens`,
      { displayName: 'Meridian local development', token },
    );
    const debug = { appId: config.appId, name: record.name, token };
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(cache, JSON.stringify(debug), { mode: 0o600 });
    return debug;
  } catch {
    warn(
      'Local AI setup is unavailable. Gameplay and saves remain available. Sign in' +
        ' with npx firebase login to enable local commentary.',
    );
    return saved;
  }
}
