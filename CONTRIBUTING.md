# Working on Meridian Conquest

Use Node.js 24 LTS and `npm ci`. Dependencies and the lockfile belong together.
The browser application is buildless: maintained source lives in `dist`, despite
that directory's conventional name. Do not minify or hand-edit generated assets.

## Module boundaries

See [architecture](docs/ARCHITECTURE.md) and [database design](docs/DATABASE.md)
for diagrams and module responsibilities. Verification commands are listed below.

| Location                                                        | Responsibility                                                   |
| --------------------------------------------------------------- | ---------------------------------------------------------------- |
| `dist/app.js`                                                   | Compose services, session state, routing and rendering           |
| `dist/ui/`                                                      | Shared components, navigation, maps, campaign and battle screens |
| `dist/controllers/`                                             | UI actions and asynchronous NPC playback                         |
| `dist/engine.js`, `dist/npc-strategy.js`                        | Game rules and opponent decisions                                |
| `dist/motion.js`, `dist/audio.js`                               | Presentation timing and sound; never calculate combat results    |
| `dist/cloud.js`, `dist/rooms.js`                                | Account services, room transactions and subscriptions            |
| `dist/campaign-store.js`, `dist/campaign-history.js`            | Lazy histories, private record state and versioned commits       |
| `dist/controllers/campaigns.js`, `dist/controllers/settings.js` | Recovery, selected-campaign loading and settings edits           |
| `dist/game-schema.js`                                           | Storage codecs, trusted country metadata and record validation   |
| `dist/commentary.js`                                            | Event-time AI context, bounded queue, caching and fallback       |
| `dist/populations.js`, `scripts/update-populations.mjs`         | Validated population snapshots and source updates                |

Views receive their changing application dependencies through a context. Its
getters resolve the current session, campaign and animation frame at call time;
capturing those values at startup would leave stale account or battle state.
Controllers use the same explicit context. Pure game logic must remain usable
without a DOM, Firebase account or network connection.

Import static HTML and rendering helpers directly. Keep the context for values
that change with the session or animation. Reuse existing functions for repeated
behavior, choose names that describe intent, and add abstractions only when they
make the code easier to follow. Preserve gameplay and save compatibility when
refactoring.

Document public functions and non-obvious helpers with a short purpose comment.
Explain constraints at the relevant block: account-generation guards, immutable
history, compatible save formats, reading pauses and delayed dice results. A
comment should describe intent or a dependency that is easy to miss, rather than
repeat each statement. Update comments when changing behavior. Each test should
have a concise purpose comment explaining the regression or user guarantee it
protects, with extra comments for unusual fixtures, simulated failures and races.
Getters, simple delegates and obvious assertions do not need line-by-line narration.

Use a 100-character formatting target and keep maintained JavaScript within the
120-character lint limit, including templates. URLs and regular expressions are
exceptions. Embedded HTML formatting is disabled to preserve the exact whitespace
already emitted by views. Selected templates use `prettier-ignore` to retain
readable multiline interpolations; the line-length rule still checks them. When
reflowing a string, preserve its text and spaces, including in AI instructions.

Keep shared game calculations in one place. `conquestReward` and `armyValue` in
`dist/data.js` are used by the engine and planning code; `mergeCampaigns` preserves
the newest account save during both partial and complete loads. Browser scripts
share `scripts/lib/static-server.mjs` rather than duplicating HTTP servers.

Keep nicknames and source labels escaped before inserting HTML. Factual events
are immutable and must exclude generated commentary. Rendering and animation
must not consume randomness used for combat. Existing campaigns retain their
recorded population, starting army value, opponents, order and event history.

## Checks

```sh
npm run format
npm run check
npm run browsers:install
npm run test:browser
```

`check` verifies Prettier formatting, ESLint correctness rules and unit tests.
Browser tests use the pinned Playwright package and Chromium. Installed Chrome
is also supported; `MERIDIAN_BROWSER_PATH` can select another executable. They
exercise maps, setup, population failures, dice reveals and NPC casualty reports
at normal, fast and reduced-motion settings without calling Firebase or Gemini.

Install Java 21 and run `npm run test:rules` to test actual Firestore rules. The
dedicated configuration binds Firestore to `127.0.0.1:8180` and uses the fake
project `demo-meridian`. These tests refuse a different emulator address and
never modify production campaigns. GitHub Actions runs both check suites and
browser tests on pull requests and main-branch pushes once the workflow is pushed.

The separate `*-browser-test.mjs` scripts for nicknames, campaign loading,
multiplayer and Gemini can use the configured live Firebase project. Run them
deliberately as documented in their source: some create temporary accounts or
consume AI quotas. They are excluded from ordinary checks and CI.

## Database compatibility and security

Version 2 game records contain a `board` map and queryable `name`, `status` and
`round` fields. Event records contain typed `event` facts; context facts are stored
separately from narration. Room transactions persist a typed board and immutable
events together. Large payload/map fields have index exemptions.

The legacy JSON `payload` is dual-written temporarily so already deployed older
clients can still read saves. Readers support both formats. Existing event
documents are never rewritten; there is no bulk migration or deletion. Old rooms
upgrade on their next game transaction. Version 2 rooms cannot downgrade their
schema, change membership during play, or change their original country metadata.
An older client must refresh before it can make moves in an upgraded room; writes
that change only its legacy payload are rejected to prevent diverging boards.
Client validation also checks complete country snapshots, dice ranges and
reported losses. Firestore uses bounded checks that fit its evaluation limits.

Legacy payloads cannot be inspected inside Firestore rules, and browser-generated
dice are not authoritative. The free Spark setup is suitable for trusted friends;
it does not provide complete anti-cheat. Do not describe App Check or client
validation as proof of fair gameplay.

Campaign boards adopt version 2 during ordinary saves; loading history does not
rewrite event documents. New saves stage immutable events with predecessor links
then commit a revision and history head in a transaction. Readers follow that
head, excluding uncommitted branches. Once versioned, a board cannot accept a
stale revision or an older writer that omits its revision. Histories load in
250-document pages only when selected; a failed history never blocks another game. Publish the updated frontend before inviting people
using an older hosted client into new version 2 rooms.

## Tooling and private configuration

Firebase CLI and Playwright are project-local, pinned development dependencies.
`scripts/firebase-admin-access.mjs` isolates the CLI's private credential API and
checks its expected shape. Operator scripts require `npx firebase login`; ordinary
gameplay does not. Never print tokens or move `.firebase` into public assets.

The lockfile includes narrow development-only overrides for patched gRPC, UUID
and Pub/Sub tracing dependencies. Pub/Sub uses the stable W3C trace-context API
from OpenTelemetry Core. Recheck that compatibility and `npm audit` when updating
Firebase CLI; avoid broad forced dependency upgrades.

`dist/assets/world-paths.js`, the country catalogue and population snapshot are
generated files. Their source/update commands are in `package.json`, and their
licenses remain under `dist/assets`. Formatter and linter exclusions are limited
to generated assets, dependencies and ignored local configuration.

Firebase remains on Spark. Hosting/rule deployments are separate from checks;
Cloud Functions in `functions/` are an optional, undeployed alternative requiring
a different hosting/billing decision. Never deploy them as part of this cleanup.
