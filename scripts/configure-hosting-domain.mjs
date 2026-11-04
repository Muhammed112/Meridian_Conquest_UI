// Operator-only domain setup. Preview by default; credentials never enter dist.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { firebaseConfig } from '../dist/firebase-config.js';
import { aiConfig } from '../dist/ai-config.js';
import { firebaseAdminToken } from './firebase-admin-access.mjs';

/** Accept one HTTPS production hostname, never a wildcard or shared hosting suffix. */
export function hostingDomain(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Provide your deployment URL.');
  const input = value.trim();
  const url = new URL(input.includes('://') ? input : 'https://' + input);
  const domain = url.hostname;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    domain.length > 253 ||
    !domain.includes('.') ||
    !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^[\d.]+$/.test(domain) ||
    /\.(?:localhost|local|invalid)$/.test(domain) ||
    ['vercel.app', 'web.app', 'firebaseapp.com'].includes(domain)
  )
    throw new Error('Use your exact HTTPS deployment hostname, without a path or wildcard.');
  return domain;
}

/** Preview or append one hosting domain using narrowly scoped configuration updates. */
export async function configureHostingDomain({
  domain: input,
  projectId,
  projectNumber,
  siteKey,
  request,
  apply = false,
  beforeApply = async () => {},
}) {
  const domain = hostingDomain(input);
  if (
    !/^[a-z][a-z0-9-]+$/.test(projectId || '') ||
    (projectNumber != null && !/^\d+$/.test(projectNumber)) ||
    !/^[\w-]+$/.test(siteKey || '')
  )
    throw new Error('The Firebase project and App Check site key must be configured first.');
  const authURL = `https://identitytoolkit.googleapis.com/admin/v2/projects/${projectId}/config`;
  // reCAPTCHA returns canonical names using the project number, even for ID-based requests.
  const keyName = `projects/${projectNumber || projectId}/keys/${siteKey}`;
  const keyURL = 'https://recaptchaenterprise.googleapis.com/v1/' + keyName;
  // Read both configurations before considering a write; an unreadable key must not alter Auth.
  const [auth, key] = await Promise.all([request(authURL), request(keyURL)]);
  if (
    !Array.isArray(auth.authorizedDomains) ||
    auth.authorizedDomains.some((item) => typeof item !== 'string') ||
    key.name !== keyName ||
    !Array.isArray(key.webSettings?.allowedDomains) ||
    key.webSettings.allowedDomains.some((item) => typeof item !== 'string') ||
    key.webSettings.allowAllDomains === true
  )
    throw new Error('Hosting domain settings need manual review; no configuration was changed.');
  const authDomains = [...new Set([...auth.authorizedDomains, domain])];
  const captchaDomains = [...new Set([...key.webSettings.allowedDomains, domain])];
  const plan = {
    projectId,
    domain,
    mode: apply ? 'apply' : 'preview',
    addAuthenticationDomain: !auth.authorizedDomains.includes(domain),
    addAppCheckDomain: !key.webSettings.allowedDomains.includes(domain),
  };
  if (!apply || (!plan.addAuthenticationDomain && !plan.addAppCheckDomain)) return plan;

  // Back up only domain settings, not the complete Auth config or any SMTP credentials.
  await beforeApply({
    projectId,
    domain,
    authorizedDomains: auth.authorizedDomains,
    recaptchaKey: keyName,
    allowedDomains: key.webSettings.allowedDomains,
  });
  // Narrow update masks preserve unrelated settings; either addition is safe to repeat after failure.
  if (plan.addAppCheckDomain)
    await request(keyURL + '?updateMask=webSettings.allowedDomains', 'PATCH', {
      name: keyName,
      webSettings: { allowedDomains: captchaDomains },
    });
  if (plan.addAuthenticationDomain)
    await request(authURL + '?updateMask=authorizedDomains', 'PATCH', {
      authorizedDomains: authDomains,
    });
  const [savedAuth, savedKey] = await Promise.all([request(authURL), request(keyURL)]);
  if (
    !authDomains.every((item) => savedAuth.authorizedDomains?.includes(item)) ||
    !captchaDomains.every((item) => savedKey.webSettings?.allowedDomains?.includes(item))
  )
    throw new Error(
      'Domain verification failed. Run the preview again to inspect current settings.',
    );
  return { ...plan, verified: true };
}

/** Use the signed-in Firebase CLI account; this command never deploys a site or rules. */
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || !args.length) {
    console.log('Usage: npm run hosting:domain -- https://your-game.vercel.app [--apply]');
    console.log('Without --apply, the command reads settings and previews additions only.');
    return;
  }
  const domain = hostingDomain(args[0]);
  if (args.slice(1).some((arg) => arg !== '--apply'))
    throw new Error('Unknown option. Use --help.');
  const token = await firebaseAdminToken();
  const result = await configureHostingDomain({
    domain,
    projectId: firebaseConfig?.projectId,
    projectNumber: firebaseConfig?.messagingSenderId,
    siteKey: aiConfig.siteKey,
    apply: args.includes('--apply'),
    async request(url, method = 'GET', body) {
      const response = await fetch(url, {
        method,
        signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!response.ok)
        throw new Error(
          `Hosting configuration request failed (HTTP ${response.status}). ` +
            'Run the preview again before retrying any partially applied setup.',
        );
      return response.json();
    },
    async beforeApply(settings) {
      const directory = new URL('../.firebase/hosting-domain-backups/', import.meta.url);
      await mkdir(directory, { recursive: true });
      await writeFile(
        new URL(`${domain}-${Date.now()}.json`, directory),
        JSON.stringify(settings),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
    },
  });
  console.log(JSON.stringify(result, null, 2));
}

// Unit tests import the validator/planner without acquiring credentials or contacting Firebase.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
