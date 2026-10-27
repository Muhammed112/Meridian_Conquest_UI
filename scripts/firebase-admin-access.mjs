// Operator-only helper. Firebase CLI credentials stay in memory, outside dist.
import {createRequire} from 'node:module';
import path from 'node:path';
export async function firebaseAdminToken(){
  const require=createRequire(import.meta.url);
  const cli=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
  const account=cli.getGlobalDefaultAccount();if(!account)throw new Error('Run firebase login first.');
  return (await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform'])).access_token;
}
