// Dry run by default; --apply grants only the database viewer role to PDF recipients.
import { writeFile, mkdir } from 'node:fs/promises';
import { firebaseAdminToken } from './firebase-admin-access.mjs';
import { firebaseConfig } from '../dist/firebase-config.js';
const project = firebaseConfig.projectId,
  role = 'roles/datastore.viewer';
const recipients = ['ammarcanani@gmail.com', 'mc.tanner@uct.ac.za', 'ridewaan.hanslo@uct.ac.za'];
const token = await firebaseAdminToken(),
  base = 'https://cloudresourcemanager.googleapis.com/v1/projects/' + project;
async function api(url, method = 'GET', body) {
  const response = await fetch(url, {
    method,
    signal: AbortSignal.timeout(20000),
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw Object.assign(
      new Error('Access setup: HTTP ' + response.status + ' ' + (data.error?.message || '')),
      { status: response.status },
    );
  return data;
}
const policy = () =>
  api(base + ':getIamPolicy', 'POST', { options: { requestedPolicyVersion: 3 } });
async function main() {
  const definition = await api('https://iam.googleapis.com/v1/' + role),
    permissions = definition.includedPermissions || [];
  if (
    !['datastore.entities.get', 'datastore.entities.list', 'resourcemanager.projects.get'].every(
      (permission) => permissions.includes(permission),
    ) ||
    ['datastore.entities.create', 'datastore.entities.update', 'datastore.entities.delete'].some(
      (permission) => permissions.includes(permission),
    )
  )
    throw new Error('The database viewer role does not have the expected read-only permissions.');
  console.log(
    JSON.stringify({
      project,
      role,
      recipients,
      mode: process.argv.includes('--apply') ? 'apply' : 'dry run',
      databaseRead: true,
      databaseWrite: false,
    }),
  );
  const before = await policy();
  if (!process.argv.includes('--apply')) return;
  const directory = new URL('../.firebase/', import.meta.url),
    backup = new URL('iam-before-examiner-access.json', directory);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(backup, JSON.stringify(before, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const failures = [];
  for (const email of recipients) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await policy(),
          member = 'user:' + email;
        let binding = current.bindings?.find(
          (binding) => binding.role === role && !binding.condition,
        );
        if (binding?.members.includes(member)) break;
        if (!binding) {
          binding = { role, members: [] };
          (current.bindings ??= []).push(binding);
        }
        binding.members.push(member);
        try {
          await api(base + ':setIamPolicy', 'POST', { policy: current });
          break;
        } catch (error) {
          if (error.status !== 409 || attempt === 2) throw error;
        }
      }
      console.log('Read-only Firestore access granted: ' + email);
    } catch (error) {
      failures.push(email);
      console.error(email + ': ' + error.message);
    }
  }
  const after = await policy();
  for (const email of recipients) {
    const confirmed = after.bindings?.some(
      (binding) =>
        binding.role === role && !binding.condition && binding.members.includes('user:' + email),
    );
    console.log(JSON.stringify({ examiner: email, role, confirmed }));
    if (!confirmed && !failures.includes(email)) failures.push(email);
  }
  // Check that every previous binding and member survived the additive update.
  for (const old of before.bindings || []) {
    const saved = after.bindings?.find(
      (binding) =>
        binding.role === old.role &&
        JSON.stringify(binding.condition) === JSON.stringify(old.condition),
    );
    if (!saved || old.members.some((member) => !saved.members.includes(member)))
      throw new Error('An existing project binding changed unexpectedly.');
  }
  if (failures.length) process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
