// Preview by default; --apply updates only the password-reset message body and format.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { firebaseAdminToken } from './firebase-admin-access.mjs';
import { firebaseConfig } from '../dist/firebase-config.js';

/** Preview the requested email, or back up and apply only its body/format with --apply. */
async function main() {
  const body = (
    await readFile(new URL('../docs/email-templates/password-reset.html', import.meta.url), 'utf8')
  ).trim();
  assert.ok(body.includes('%LINK%'), 'The email must retain Firebase’s reset-link placeholder.');
  assert.ok(
    body.includes('%DISPLAY_NAME%'),
    'The email must retain the player nickname placeholder.',
  );
  const project = firebaseConfig?.projectId;
  assert.ok(project, 'Firebase is not configured.');
  const token = await firebaseAdminToken();
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${project}/config`;
  /** Limit template edits to reset-password fields and surface Firebase’s editing restriction. */
  async function api(method = 'GET', patch) {
    const mask =
      'notification.sendEmail.resetPasswordTemplate.body,notification.sendEmail.re' +
      'setPasswordTemplate.bodyFormat';
    const response = await fetch(method === 'PATCH' ? `${url}?updateMask=${mask}` : url, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: patch ? JSON.stringify(patch) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const data = await response.json();
    if (data.error?.message === 'EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED')
      throw new Error(
        'Firebase blocked email-template editing for this project' +
          ' (EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED). The template was not published. See' +
          ' docs/email-templates/SUPPORT.md for the prepared support request.',
      );
    if (!response.ok)
      throw new Error(`Email configuration: HTTP ${response.status} ${data.error?.message || ''}`);
    return data;
  }
  const before = await api();
  const apply = process.argv.includes('--apply');
  console.log(
    JSON.stringify(
      { project, mode: apply ? 'apply' : 'preview', body, bodyFormat: 'HTML' },
      null,
      2,
    ),
  );
  if (!apply) return;
  // Preserve the previous template privately before changing the two explicitly selected fields.
  const directory = new URL('../.firebase/auth-email-backups/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const backup = new URL(`${project}-${Date.now()}.json`, directory);
  await writeFile(
    backup,
    JSON.stringify(before.notification?.sendEmail?.resetPasswordTemplate || {}, null, 2),
    { flag: 'wx', mode: 0o600 },
  );
  await api('PATCH', {
    notification: { sendEmail: { resetPasswordTemplate: { body, bodyFormat: 'HTML' } } },
  });
  // Read back the server result; a successful PATCH alone does not prove the template was retained.
  const after = await api();
  assert.equal(after.notification?.sendEmail?.resetPasswordTemplate?.body, body);
  assert.equal(after.notification.sendEmail.resetPasswordTemplate.bodyFormat, 'HTML');
  console.log('Password-reset email updated and verified. No email was sent.');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
