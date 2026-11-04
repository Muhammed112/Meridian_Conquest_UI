import { readFile } from 'node:fs/promises';
import { campaignRecord, eventRecord } from '../../dist/game-schema.js';

/** Use real cloud/store modules with an isolated SDK, configurable failures and no Firebase writes. */
export async function installCampaignFixture(page, games, { damaged = false } = {}) {
  // Use production codecs and predecessor links so tests exercise the actual versioned save format.
  const records = games.flatMap((game) => {
    const path = 'users/quality-review/games/' + game.id;
    return [
      [
        path,
        { ...campaignRecord(game), saveRevision: 1, historyHead: game.events.at(-1)?.id || null },
      ],
      ...game.events.map((event, sequence) => [
        path + '/events/' + event.id,
        {
          ...eventRecord(event, sequence, game),
          previousEventId: game.events[sequence - 1]?.id || null,
        },
      ]),
    ];
  });
  if (damaged) records.push(['users/quality-review/games/damaged', { payload: '{broken' }]);
  await page.addInitScript(
    ({ records }) => {
      const documents = new Map(records);
      globalThis.historyModes = {};
      globalThis.historyReads = [];
      globalThis.campaignWrites = 0;
      const db = {};
      const ref = (...parts) => ({
        path: parts
          .filter((part) => part !== db)
          .map((part) => part.path || part)
          .join('/'),
      });
      const snapshot = (target) => ({
        exists: () => documents.has(target.path),
        data: () => structuredClone(documents.get(target.path)),
      });
      /** Model immutable event commits and count writes to catch accidental saves during loading. */
      function batch() {
        const writes = [];
        return {
          set: (target, value) => writes.push([target.path, value]),
          async commit() {
            for (const [path] of writes)
              if (path.includes('/events/') && documents.has(path))
                throw new Error('Immutable event rewrite.');
            for (const [path, value] of writes) documents.set(path, structuredClone(value));
            globalThis.campaignWrites += writes.length;
          },
        };
      }
      globalThis.fixtureSDK = {
        initializeApp: () => ({}),
        getAuth: () => ({}),
        getFirestore: () => db,
        browserSessionPersistence: {},
        setPersistence: async () => {},
        onAuthStateChanged: (_, callback) =>
          queueMicrotask(() =>
            callback({
              uid: 'quality-review',
              displayName: 'Review player',
            }),
          ),
        collection: ref,
        doc: ref,
        query: (target) => target,
        orderBy: () => ({}),
        where: () => ({}),
        getDoc: async (target) => snapshot(target),
        async getDocs(target) {
          if (target.path === 'liveGames') return { docs: [] };
          // Tests can stall or fail one history while unrelated campaign headers remain readable.
          if (target.path.endsWith('/events')) {
            const id = target.path.split('/').at(-2);
            globalThis.historyReads.push(id);
            while (globalThis.historyModes[id] === 'hold')
              await new Promise((resolve) => setTimeout(resolve, 25));
            if (globalThis.historyModes[id] === 'fail')
              throw Object.assign(new Error('Temporary history failure.'), { code: 'unavailable' });
          }
          return {
            docs: [...documents]
              .filter(
                ([path]) =>
                  path.startsWith(target.path + '/') &&
                  !path.slice(target.path.length + 1).includes('/'),
              )
              .map(([path, value]) => ({
                id: path.split('/').at(-1),
                ref: { path },
                data: () => structuredClone(value),
              }))
              .sort((left, right) => (left.data().sequence || 0) - (right.data().sequence || 0)),
          };
        },
        onSnapshot: () => () => {},
        writeBatch: batch,
        async runTransaction(_db, update) {
          const writes = batch();
          await update({ get: async (target) => snapshot(target), set: writes.set });
          await writes.commit();
        },
      };
    },
    { records },
  );
  const source = await readFile(new URL('../../dist/cloud.js', import.meta.url), 'utf8');
  // Replace only the SDK boundary; the real cloud/store modules still handle reads and recovery.
  await page.route(/\/cloud\.js(?:\?.*)?$/, (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
      import { connectCloud as connect } from './cloud-under-test.js';
      export const cloudEnabled = true;
      export function connectCloud(options) {
        return connect({ ...options, config: { projectId: 'offline-review' },
          aiSettings: { enabled: false }, loadSDK: async () => globalThis.fixtureSDK });
      }`,
    }),
  );
  await page.route('**/cloud-under-test.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: source }),
  );
  await page.route('**/firebase-config.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: 'export const firebaseConfig=null;',
    }),
  );
}
