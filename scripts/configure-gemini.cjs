// Configure the Gemini proxy and App Check using the Firebase CLI sign-in.
// Access tokens stay in memory; only a public reCAPTCHA site key is written.
const path = require('node:path');
const fs = require('node:fs/promises');
const project = 'meridian-conquest-m112',
  number = '126865630748',
  app = '1:126865630748:web:2fdd0ba05023a30c64e1d9';
/** Configure Spark-compatible App Check and public settings; no secret key is written to dist. */
async function main() {
  const { firebaseAdminToken } = await import('./firebase-admin-access.mjs');
  const token = await firebaseAdminToken();
  /** Keep administration requests bounded and preserve status codes needed for setup fallbacks. */
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, {
      method,
      signal: AbortSignal.timeout(20000),
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) {
      const error = new Error(response.status + ': ' + (data.error?.message || 'Request failed'));
      error.status = response.status;
      throw error;
    }
    return data;
  }
  // Refuse an unexpected paid-project setup rather than silently changing the agreed Spark workflow.
  const billing = await api(
    'https://cloudbilling.googleapis.com/v1/projects/' + project + '/billingInfo',
  );
  if (billing.billingEnabled)
    throw new Error('This setup expects the project to remain on the free Spark plan.');
  const op = await api(
    'https://serviceusage.googleapis.com/v1/projects/' + number + '/services:batchEnable',
    'POST',
    { serviceIds: ['firebaseappcheck.googleapis.com', 'recaptchaenterprise.googleapis.com'] },
  );
  for (let n = 0; n < 30; n++) {
    const state = await api('https://serviceusage.googleapis.com/v1/' + op.name);
    if (state.error) throw new Error(state.error.message);
    if (state.done) break;
    if (n === 29) throw new Error('API activation still pending');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  console.log('App Check APIs enabled; billing remains disabled.');
  const configUrl =
    'https://firebaseappcheck.googleapis.com/v1/projects/' +
    number +
    '/apps/' +
    encodeURIComponent(app) +
    '/recaptchaEnterpriseConfig';
  let siteKey;
  try {
    siteKey = (await api(configUrl)).siteKey;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  // Reuse a configured or named key so rerunning setup does not create redundant reCAPTCHA keys.
  if (!siteKey) {
    const keyUrl = 'https://recaptchaenterprise.googleapis.com/v1/projects/' + project + '/keys';
    const keys = await api(keyUrl);
    const existing = keys.keys?.find((key) => key.displayName === 'Meridian Gemini App Check');
    const key =
      existing ||
      (await api(keyUrl, 'POST', {
        displayName: 'Meridian Gemini App Check',
        webSettings: {
          allowedDomains: [project + '.web.app', project + '.firebaseapp.com'],
          integrationType: 'SCORE',
        },
      }));
    siteKey = key.name.split('/').pop();
    await api(configUrl + '?updateMask=siteKey,tokenTtl', 'PATCH', { siteKey, tokenTtl: '3600s' });
  }
  await api(
    'https://firebaseappcheck.googleapis.com/v1/projects/' +
      number +
      '/services/firebaseml.googleapis.com?updateMask=enforcementMode',
    'PATCH',
    { enforcementMode: 'ENFORCED' },
  );
  console.log('Gemini App Check configured for the hosting domains.');
  const aiUrl =
    'https://firebasevertexai.googleapis.com/v1beta/projects/' +
    project +
    '/locations/global/config';
  await api(aiUrl + '?updateMask=trafficFilter.firebaseAuthRequired', 'PATCH', {
    trafficFilter: { firebaseAuthRequired: true },
  });
  console.log('Gemini requests require a signed-in user.');
  // The public browser key must not authorize direct Gemini Developer API calls.
  const { firebaseConfig } = await import('../dist/firebase-config.js');
  const lookup = await api(
    'https://apikeys.googleapis.com/v2/keys:lookupKey?keyString=' +
      encodeURIComponent(firebaseConfig.apiKey),
  );
  const keyUrl = 'https://apikeys.googleapis.com/v2/' + lookup.name;
  const key = await api(keyUrl),
    restrictions = key.restrictions || {};
  const required = [
    'identitytoolkit.googleapis.com',
    'securetoken.googleapis.com',
    'firestore.googleapis.com',
    'firebaseinstallations.googleapis.com',
    'firebaseappcheck.googleapis.com',
    'firebasevertexai.googleapis.com',
  ];
  const targets = (restrictions.apiTargets || []).filter(
    (item) => item.service !== 'generativelanguage.googleapis.com',
  );
  for (const service of required)
    if (!targets.some((item) => item.service === service)) targets.push({ service });
  await api(keyUrl + '?updateMask=restrictions', 'PATCH', {
    restrictions: { ...restrictions, apiTargets: targets },
  });
  console.log('Public Firebase key restricted to Firebase services.');
  // The site key is public attestation configuration; the administrator credential stays in memory.
  const config = { enabled: true, model: 'gemini-3.5-flash-lite', siteKey };
  await fs.writeFile(
    path.join(__dirname, '../dist/ai-config.js'),
    '// Public Gemini/App Check configuration. No secret API key belongs' +
      ' here.\nexport const aiConfig = ' +
      JSON.stringify(config, null, 2) +
      ';\n',
  );
  console.log('Public AI configuration saved.');
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
