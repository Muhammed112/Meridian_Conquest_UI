// Explicit operator command. Inspection is the default; --apply backs up affected records first.
import { randomUUID } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { firebaseConfig } from '../dist/firebase-config.js';
import { firebaseAdminToken } from './firebase-admin-access.mjs';
import {
  normalizeCampaignCountries,
  selectCompatibleCountry,
} from '../dist/country-compatibility.js';
import {
  campaignRecord,
  readCampaignRecord,
  eventRecord,
  readEventRecord,
  factualEvent,
  validateGameBoard,
  validateGameEvent,
  encodeBoard,
} from '../dist/game-schema.js';
import { committedHistory } from '../dist/campaign-history.js';
import { spectatorPayload, readSpectatorGame } from '../dist/spectators.js';
import { findCountry, isPlayableCountry } from '../dist/data.js';
import { readRoomGame } from '../dist/rooms.js';
import { validateRoomSetup } from '../dist/room-setup.js';
import {
  createFirestoreRecords,
  decodeFields,
  patchDocument,
  createDocument,
  writeBatches,
} from './lib/firestore-records.mjs';

const excludedCode = (code) => findCountry(code) && !isPlayableCountry(code);
const needsSync = (game) => game?.countries?.some((country) => excludedCode(country.code));
const documentId = (document) => document.name.split('/').at(-1);
const relativePath = (document) => document.name.split('/documents/')[1];

/** Encode a fresh immutable chain; earlier event documents remain untouched as recovery history. */
function stageHistory(document, game, { sequenceStart = 0, predecessor = false } = {}) {
  return game.events.map((event, index) => {
    const context = {
      event: factualEvent(event),
      previousBoard: game.events[index - 1]?.board || null,
      countries: game.countries.map(({ code, name }) => ({ code, name })),
      recent: game.events
        .slice(Math.max(0, index - 3), index)
        .map(({ type, text }) => ({ type, text })),
    };
    return createDocument(document.name + '/events/' + event.id, {
      ...eventRecord(event, sequenceStart + index, game, predecessor ? context : undefined),
      ...(predecessor ? { previousEventId: game.events[index - 1]?.id || null } : {}),
    });
  });
}

/** Resolve the original committed branch before replacing any codes or event identifiers. */
function campaignHistory(game, raw, documents) {
  const codes = new Set(game.countries.map((country) => country.code));
  const records = documents.map((document) => {
    const record = decodeFields(document.fields);
    return { ...record, event: { id: documentId(document) }, source: record };
  });
  // REST pages arrive in document-name order; legacy histories depend on factual sequence order.
  records.sort((left, right) => left.sequence - right.sequence);
  const selected = committedHistory(records, raw.historyHead);
  if (!selected.length && raw.historyHead === undefined && !documents.length) {
    const embedded = game.events || [];
    for (const event of embedded) validateGameEvent(event, codes);
    return embedded;
  }
  return selected.map((record) => {
    const event = readEventRecord(record.source, codes);
    if (event.id !== record.event.id) throw new Error('Stored event identifiers do not match.');
    return event;
  });
}

/** Plan one account-owned campaign without changing its identity, turn state or immutable source. */
export function planCampaign(
  document,
  eventDocuments,
  { now = Date.now(), newEventId = randomUUID } = {},
) {
  const raw = decodeFields(document.fields),
    original = readCampaignRecord(raw);
  if (!needsSync(original)) return null;
  if (original.id !== documentId(document))
    throw new Error('Stored campaign identity does not match.');
  original.events = campaignHistory(original, raw, eventDocuments);
  const game = normalizeCampaignCountries(original, { newEventId });
  game.updatedAt = now;
  const revision = (raw.saveRevision || 0) + 1;
  if (!Number.isSafeInteger(revision)) throw new Error('Stored campaign revision is invalid.');
  return {
    kind: 'campaigns',
    document,
    eventDocuments,
    stagedWrites: stageHistory(document, game, { predecessor: true }),
    finalWrite: patchDocument(document, {
      ...campaignRecord(game),
      saveRevision: revision,
      historyHead: game.events.at(-1)?.id || null,
    }),
  };
}

/** Map lobby reservations and frozen opening selections through the same deterministic choice. */
function roomChoices(raw, mapping = new Map()) {
  const occupied = new Set([
    ...Object.values(raw.countryChoices || {}),
    ...(raw.initiative?.countries || []),
  ]);
  for (const code of occupied)
    if (excludedCode(code) && !mapping.has(code)) {
      const replacement = selectCompatibleCountry({ code }, occupied);
      mapping.set(code, replacement.code);
      occupied.add(replacement.code);
    }
  const code = (value) => mapping.get(value) || value;
  return {
    ...(raw.countryChoices
      ? {
          countryChoices: Object.fromEntries(
            Object.entries(raw.countryChoices).map(([id, value]) => [id, code(value)]),
          ),
        }
      : {}),
    ...(raw.initiative
      ? { initiative: { ...raw.initiative, countries: raw.initiative.countries.map(code) } }
      : {}),
  };
}

/** Plan an administrative room update; member seats, rolls, event count and combat stay fixed. */
export function planRoom(
  document,
  eventDocuments = [],
  { now = Date.now(), newEventId = randomUUID } = {},
) {
  const raw = decodeFields(document.fields),
    original = raw.payload ? readRoomGame(raw) : null;
  const affectedChoices =
    Object.values(raw.countryChoices || {}).some(excludedCode) ||
    raw.initiative?.countries.some(excludedCode);
  if (!needsSync(original) && !affectedChoices) return null;
  const game = original ? normalizeCampaignCountries(original, { newEventId }) : null,
    mapping = new Map();
  if (original)
    original.countries.forEach((country, index) => {
      if (country.code !== game.countries[index].code)
        mapping.set(country.code, game.countries[index].code);
    });
  const revision = raw.revision + 1;
  if (!Number.isSafeInteger(revision) || revision < 1)
    throw new Error('Stored room revision is invalid.');
  if (game) game.updatedAt = now;
  const changes = {
    ...roomChoices(raw, mapping),
    revision,
    updatedAt: now,
    ...(game
      ? {
          payload: JSON.stringify(game),
          ...(raw.schemaVersion === 2 ? { board: encodeBoard(game) } : {}),
        }
      : {}),
  };
  const sequenceStart = game ? raw.eventCount - game.events.length : 0;
  if (game && (!Number.isInteger(sequenceStart) || sequenceStart < 0))
    throw new Error('Stored room history count is invalid.');
  if (game) readRoomGame({ ...raw, ...changes });
  else validateRoomSetup({ ...raw, ...changes });
  return {
    kind: 'rooms',
    document,
    eventDocuments,
    stagedWrites: game && game !== original ? stageHistory(document, game, { sequenceStart }) : [],
    finalWrite: patchDocument(document, changes),
  };
}

/** Replace only an explicitly shared payload, retaining its owner, link and sharing permissions. */
export function planLiveGame(document, { now = Date.now(), newEventId = randomUUID } = {}) {
  const raw = decodeFields(document.fields),
    original = JSON.parse(raw.payload);
  if (!needsSync(original)) return null;
  // The browser reader already adapts old public payloads; inspect their raw codes first.
  readSpectatorGame(raw.payload);
  const game = normalizeCampaignCountries(validateGameBoard(original), { newEventId });
  game.updatedAt = now;
  const finalWrite = patchDocument(document, { payload: spectatorPayload(game) });
  finalWrite.updateTransforms = [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }];
  return { kind: 'liveGames', document, eventDocuments: [], stagedWrites: [], finalWrite };
}

/** Inspect only the three gameplay collections; load event subcollections only for affected games. */
export async function countryRecordPlans(store, options = {}) {
  const plans = [],
    counts = { campaigns: 0, rooms: 0, liveGames: 0 };
  const [games, rooms, liveGames] = await Promise.all([
    store.games(),
    store.collection('rooms'),
    store.collection('liveGames'),
  ]);
  for (const document of games) {
    counts.campaigns++;
    const raw = decodeFields(document.fields);
    if (!needsSync(readCampaignRecord(raw))) continue;
    const events = await store.collection(relativePath(document) + '/events');
    plans.push(planCampaign(document, events, options));
  }
  for (const document of rooms) {
    counts.rooms++;
    const plan = planRoom(document, [], options);
    if (!plan) continue;
    plan.eventDocuments = await store.collection(relativePath(document) + '/events');
    plans.push(plan);
  }
  for (const document of liveGames) {
    counts.liveGames++;
    const plan = planLiveGame(document, options);
    if (plan) plans.push(plan);
  }
  return { plans, counts };
}

/** Flush one ignored recovery file before staging any event or changing any live document. */
async function backupPlans(projectId, plans) {
  const directory = new URL('../.firebase/', import.meta.url);
  await mkdir(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-'),
    destination = new URL(
      `country-records-backup-${stamp}-${randomUUID().slice(0, 8)}.json`,
      directory,
    );
  const file = await open(destination, 'wx', 0o600);
  try {
    await file.writeFile(
      JSON.stringify({
        version: 1,
        projectId,
        createdAt: new Date().toISOString(),
        records: plans.map(({ kind, document, eventDocuments }) => ({
          kind,
          document,
          eventDocuments,
        })),
      }),
    );
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Execute prepared plans only after a successful backup; stale records fail their CAS unchanged. */
export async function applyCountryRecordPlans(plans, store, backup) {
  if (!plans.length) return;
  await backup(plans);
  for (const plan of plans) {
    for (const batch of writeBatches(plan.stagedWrites)) await store.commit(batch);
    await store.commit([plan.finalWrite]);
  }
}

/** Suppress CLI debugging while its private credential adapter refreshes an in-memory token. */
async function operatorToken() {
  const previous = process.env.DEBUG;
  delete process.env.DEBUG;
  try {
    return await firebaseAdminToken();
  } finally {
    if (previous !== undefined) process.env.DEBUG = previous;
  }
}

/** Default to counts only; applying is an explicit operator invocation, never an import side effect. */
export async function syncCountryRecords({
  apply = false,
  projectId = firebaseConfig?.projectId,
} = {}) {
  const token = await operatorToken(),
    store = createFirestoreRecords({ projectId, token }),
    { plans, counts } = await countryRecordPlans(store);
  if (apply)
    await applyCountryRecordPlans(plans, store, (records) => backupPlans(projectId, records));
  const affected = { campaigns: 0, rooms: 0, liveGames: 0, events: 0 };
  for (const plan of plans) {
    affected[plan.kind]++;
    affected.events += plan.stagedWrites.length;
  }
  console.log(
    JSON.stringify({
      project: projectId,
      mode: apply ? 'apply' : 'dry-run',
      scanned: counts,
      affected,
    }),
  );
  return { counts, affected };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--apply')) {
    console.error('Unsupported operator option.');
    process.exitCode = 1;
  } else
    syncCountryRecords({ apply: args.includes('--apply') }).catch(() => {
      console.error(
        'Country record synchronization stopped; inspect the saved backup before retrying.',
      );
      process.exitCode = 1;
    });
}
