# Firebase and AI commentary setup

The app supports Firebase Email/Password Authentication, account-specific Firestore campaigns, immutable event documents and Gemini commentary through Firebase AI Logic. Without a configuration in `dist/firebase-config.js`, the original local demo still works.

## Connected project

- Firebase project: `meridian-conquest-m112` ([console](https://console.firebase.google.com/project/meridian-conquest-m112/overview))
- Web app: `Meridian Conquest Web`
- Firestore: `(default)`, Standard edition, `europe-west1`
- Local default project: `.firebaserc`
- Public app configuration: `dist/firebase-config.js`

Email/password Authentication is enabled. Authorized domains are `localhost`, `meridian-conquest-m112.firebaseapp.com` and `meridian-conquest-m112.web.app`. Firestore security rules and indexes are deployed.

Sign-in uses Firebase session persistence. Refreshing the page keeps the user signed in; closing the signed-in tab or browser window ends that session. Campaigns remain saved in Firestore and load after the next sign-in.

The project remains on the free Spark plan with billing disabled. Gemini commentary uses Firebase AI Logic with the Gemini Developer API, not Cloud Functions. The app is published at https://meridian-conquest-m112.web.app; multiplayer is available at https://meridian-conquest-m112.web.app/#multiplayer.

## Gemini configuration

`dist/ai-config.js` contains public settings: the enabled flag, `gemini-3.6-flash` model name and reCAPTCHA Enterprise site key. There is no personal Gemini API key in the app. Firebase AI Logic handles authorization to Gemini through its managed proxy. The public Firebase key is restricted to Firebase services and cannot call the Gemini Developer API directly.

The connected project has the Gemini Developer API provider enabled, requires Firebase Authentication for AI requests and enforces App Check for Firebase AI Logic. The App Check service identifier is `firebaseml.googleapis.com`. The reCAPTCHA site key allows the two Firebase hosting domains. App Check enforcement for Authentication and Firestore has not been enabled by this setup.

Open the Settings gear to enable or disable **Gemini battle commentary**. This preference is stored on the device. Generation is enabled by default for signed-in gameplay. Existing saved events are not sent again when a campaign or room is opened. **Generate commentary** requests the latest three eligible events without current-version reports, including completed campaigns. Legacy reports can therefore be refreshed without overwriting or deleting them. Only the host can request shared multiplayer reports. The panel exposes queue, generation and actionable failure status.

For local development, run `firebase login` and `npm run dev`, then open http://localhost:8081. The server registers/reuses an App Check debug token under `.firebase/app-check-debug.json`, outside the public `dist` folder and ignored by Git. It supplies the token only from the loopback server, checks the request hostname, uses no-store responses and never prints it. Set `MERIDIAN_PORT` if 8081 is busy. The development server currently uses the installed Firebase CLI under Windows APPDATA. Revoke its token in Firebase App Check when local development access is no longer wanted.

The public `dist/ai-local-config.js` is an empty stub. The development server overrides that URL in memory; no debug token is placed in a deployable file. The browser enables the debug provider only on loopback addresses. VS Code Live Server and other static servers can still play and save, but local commentary directs you to `npm run dev`. The live browser verification script instead registers an ephemeral debug token and deletes it during cleanup. See [Firebase's debug-provider guide](https://firebase.google.com/docs/app-check/web/debug-provider).

## Connect a different project

1. Sign in with `firebase login`, create a Firebase project and register a Web app. Keep the Spark plan if you want free quotas only.
2. Create Cloud Firestore and enable Email/Password Authentication. Add your hosting domains to authorized domains.
3. Copy the public Web app configuration to `dist/firebase-config.js` and select the project with `firebase use --add`.
4. In Firebase AI Logic, enable the Gemini Developer API provider. Configure Firebase Authentication requirements for AI requests.
5. Register your Web app with App Check using reCAPTCHA Enterprise, allow your hosting domains and enforce App Check for Firebase AI Logic.
6. Set the public site key and a supported free model in `dist/ai-config.js`. If changing the model, update the model allowlist in `firestore.rules` too.
7. Deploy with `firebase deploy --only firestore,hosting`. No Cloud Functions or billing upgrade is needed for this path.

`scripts/configure-gemini.cjs` is an idempotent setup helper for the connected Meridian project, using the existing Firebase CLI sign-in. It configures App Check, authentication requirements and the public Firebase key restrictions, and refuses to proceed if billing is enabled. It assumes the AI Logic provider is already enabled. Its project identifiers are specific to this project.

The older `functions/` implementation remains available as an optional server-side alternative. It is not deployed. That alternative requires an eligible billing plan and a Gemini key stored with `firebase functions:secrets:set GEMINI_API_KEY`; do not deploy it when staying on Spark.

## How it works

Signing in loads that account's campaigns and creates a separate browser recovery cache. Existing local demo campaigns are not silently uploaded into a new account. New campaigns save their board separately from their event history, avoiding the Firestore document-size limit for a growing history. Events have a sequence number and cannot be edited by browser clients. Large payload fields are exempt from indexing.

Campaign cards appear as soon as the board documents load, before long event histories finish downloading. Cached campaigns remain visible while loading or after a connection failure. Gameplay and cloud saves stay locked until all histories finish loading. Failed or stalled reads show a persistent error with **Retry loading**, rather than an empty campaign list. Reads time out after thirty seconds; late replies from an older load or account are ignored. The dashboard shows the signed-in email to help identify the account holding a save.

The commentary queue handles new attack, dice, retreat, held, conquest, elimination, victory and NPC decision events after their factual records are saved. It sends recorded facts, the event board, the previous board, country names and eight preceding event descriptions to Gemini. The snapshot includes commander standings, tied or outright territorial leaders, and losses accumulated within the recorded attack. A consistent commentator voice explains meaningful consequences in one or two short sentences (normally 16?40 words; capped at 60 words and 500 characters). It avoids repeating the factual log and reserves excitement for actual turning points. NPC explanations come from the strategy engine. Each report is matched to its own event ID and displayed below the factual report without restarting dice animations or changing gameplay.

Requests batch up to six events with at least twelve seconds between batches. A maximum of 24 pending events prevents fast-forward from building an unlimited backlog; excess older pending events keep their factual reports. A request failure leaves the facts visible and applies a one-minute cooldown before processing more new events. There is no automatic historical backfill. Free Gemini quotas and availability still apply.

Current reports are stored once under `users/{uid}/games/{gameId}/aiReportsV2/{eventId}`, or `rooms/{code}/aiReportsV2/{eventId}` in multiplayer, with `narrationVersion: 2`. The original `aiReports` collections remain readable and unchanged. New-version reports take precedence even if an older listener replies later. **Generate commentary** can upgrade the latest three legacy or missing reports; the original version is preserved. Transactions reuse existing reports, and replays/reloads read saved results without generating them again. Up to three strictly earlier commentary snippets are supplied as wording memory, not factual evidence. Memory is bounded and isolated by account and campaign/room; late or later-event reports are excluded when narrating an older event. Concurrent browser tabs can still make duplicate model requests before either result is saved. Signing out discards queued work and late responses.

In multiplayer, only the host browser requests and saves commentary; friends receive the same reports through a Firestore listener. The host must keep the room open. Rejoining loads existing reports and starts generation only for subsequent events.

Dice results are calculated and saved immediately, while presentation keeps the preceding troop counts, ownership and field reports until the dice animation finishes. Loss reports, conquest and victory then appear together. Fast playback uses the shorter roll duration; reduced motion shows results immediately. The reveal does not change the dice, NPC decisions or stored game history.

## Access and current boundaries

Firestore rules isolate each user's campaigns. Unauthenticated visitors cannot write. Owners may create one AI report for an existing eligible campaign event; multiplayer reports may be created only by the host and read only by room members. Reports have a fixed schema, an allowlisted model and narration version, bounded text and a server timestamp, and cannot be updated or deleted by clients. The older server-only `commentary` collection still rejects client writes. Because generation runs through the browser, these rules cannot prove the text came from Gemini: a campaign owner or room host can submit their own report text. Commentary is advisory and never changes game state. Existing share links remain read-only embedded snapshots, not live Firestore subscriptions. Generated commentary already present in an embedded snapshot is not currently imported by the snapshot decoder.

Game moves and dice still run in the browser, and signed-in owners can submit their own campaign data. This integration provides authentication and cloud storage, not authoritative server-side anti-cheat enforcement. Avoid playing one campaign concurrently in multiple tabs or devices: board saves currently use last-write-wins. A failed initial account load keeps play locked rather than overwriting remote campaigns.

## Verification

Run `npm run check` for engine regression tests and commentary context tests. After connecting the actual project, verify signup, sign-in, reset email, sign-out, account isolation, save/reload, dice and conquest commentary, fast-forward, replay and temporary disconnection. Firestore rules have also passed live access checks in the connected project. Local tests cover factual context, batched generation, deduplication, cache reuse, sign-out cancellation and failure fallback. Live checks are separate from the local suite.

To repeat the explicit live Firebase smoke test, run `node scripts/firebase-smoke-test.mjs` after `firebase login`. It creates two temporary accounts, tests access with their Firebase user tokens, and removes only its own test accounts and documents. Cleanup uses the Firebase CLI account's administrator access.

For read-only reproduction of an existing campaign, set `CAMPAIGN_TEST_PATH` to `users/<owner uid>/games/<campaign id>` and run `node scripts/campaign-load-browser-test.mjs`. It reads the saved board and history into memory, then tests rendering, loading failures, retry and cache recovery in an isolated browser with mocked Firebase writes. It does not modify the original campaign or account.

Run `node scripts/gemini-browser-test.mjs` to verify a real Gemini response, saved-report reuse and the settings toggle. It creates one temporary account and campaign plus an App Check debug attestation, then removes all of them. It requires Firebase CLI administrator access, Chrome and the temporary Playwright installation described below. Set `GEMINI_TEST_ORIGIN` to the hosting URL to check the published version. Set `GEMINI_TEST_STANDARD_APPCHECK=1` on that domain to exercise normal reCAPTCHA attestation instead of the debug provider.

With `npm run dev` running, `node scripts/commentary-preview.mjs` previews the narrator on attack pressure, repeated tied dice and a capture that breaks a territorial tie. It uses the real browser SDK, prints the generated lines and response time, and removes its temporary account without writing campaigns. `COMMENTARY_PREVIEW_MODEL` can select another model for comparison. Gemini 3.6 Flash was selected after these previews returned in about eight seconds; the tested 3.8 request took nearly two minutes. Model requests have a thirty-second timeout so slow generation does not leave the queue stuck.

## Multiplayer rooms

Open **Multiplayer** in the navigation. Sign in, create a room and share its six-character code. Friends enter the code to join the lobby. The host starts the match when everyone has joined; remaining seats become bots, for ten countries in total. Existing players can rejoin a started match with the same code; new players cannot join after the start.

Rooms use Firestore transactions and live listeners on the Spark plan. Each action checks the room revision to reject stale moves. Security rules restrict starts to the host and game updates to the current human player or the host for a bot turn. Lobby membership is limited to ten distinct accounts. Event history is append-only and the room document retains the latest eighty events for display.

The host's browser runs the bots and must keep the room open. A disconnected human retains their seat, and the match waits for them when their turn comes. Host migration and automatic replacement of disconnected humans are not included. A host can close a lobby; players can leave before it starts. After starting, navigation away does not surrender a seat.

As with single-player gameplay, moves and dice are calculated in the browser. These room rules enforce membership, turn ownership and revision changes, but they do not validate every game calculation against an authoritative server. Use this version for games among trusted friends. A room code acts as an invitation: signed-in people who know it can read the room.

Multiplayer verification includes the automated room unit tests and a two-user desktop/mobile browser run: code joining, bot fill, lobby impersonation denial, active-turn permissions, shared attacks/dice, host-generated Gemini reports delivered to both players, report overwrite denial, automatic bot turns, reload reconnection and tab-close sign-out. All temporary test data and App Check debug attestations are removed by the live test script. `scripts/multiplayer-browser-test.mjs` uses a temporary Playwright installation under the system temp directory and a locally installed Chrome executable; these browser tools are not runtime app dependencies.
