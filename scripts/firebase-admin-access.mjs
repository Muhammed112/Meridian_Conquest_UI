// Operator-only helper. Firebase CLI credentials stay in memory, outside dist.
import { createRequire } from 'node:module';
import path from 'node:path';
/** Load and validate the pinned CLI’s private credential adapter in operator scripts only. */
export function firebaseCliAuth() {
  const require = createRequire(import.meta.url);
  const cliRoot = path.dirname(require.resolve('firebase-tools/package.json'));
  // The CLI has no public credential API. Keep this version-pinned adapter in
  // one operator-only module; the browser never receives these credentials.
  const auth = require(path.join(cliRoot, 'lib/auth.js'));
  if (
    typeof auth.getGlobalDefaultAccount !== 'function' ||
    typeof auth.getAccessToken !== 'function'
  ) {
    throw new Error('Unsupported Firebase CLI authentication API. Check the pinned CLI version.');
  }
  return auth;
}
/** Refresh the signed-in operator’s access token in memory without printing or persisting it. */
export async function firebaseAdminToken() {
  const cli = firebaseCliAuth();
  const account = cli.getGlobalDefaultAccount();
  if (!account) throw new Error('Run npx firebase login first.');
  return (
    await cli.getAccessToken(account.tokens.refresh_token, [
      'https://www.googleapis.com/auth/cloud-platform',
    ])
  ).access_token;
}
