# Firebase and AI commentary setup

The app supports Firebase Email/Password Authentication, account-specific Firestore campaigns, immutable event documents and server-generated Gemini commentary. Without a configuration in `dist/firebase-config.js`, the original local demo still works.

## Connected project

- Firebase project: `meridian-conquest-m112` ([console](https://console.firebase.google.com/project/meridian-conquest-m112/overview))
- Web app: `Meridian Conquest Web`
- Firestore: `(default)`, Standard edition, `europe-west1`
- Local default project: `.firebaserc`
- Public app configuration: `dist/firebase-config.js`

Email/password Authentication is enabled. Authorized domains are `localhost`, `meridian-conquest-m112.firebaseapp.com` and `meridian-conquest-m112.web.app`. Firestore security rules and indexes are deployed.

Sign-in uses Firebase session persistence. Refreshing the page keeps the user signed in; closing the signed-in tab or browser window ends that session. Campaigns remain saved in Firestore and load after the next sign-in.

The project remains on the free Spark plan at the owner's request. The commentary function and Hosting have not been deployed, and no Gemini secret has been set. Battle reports continue to use factual game-event text. The server commentary code is prepared for a later deployment.

Live checks passed for signup/sign-in, campaign save/reload, denial of visitor and other-account access, ordered event history, event immutability and denial of browser-created commentary. Temporary accounts and documents used for these checks were removed.

## Connect a different project

1. Run `firebase login` in your terminal. Do not put authorization codes or service-account files in the repository.
2. Create a Firebase project, register a Web app and create Cloud Firestore in production mode. Choose the database region deliberately; it cannot simply be changed afterward. The function currently uses `europe-west1`.
3. Enable Authentication > Sign-in method > Email/Password. Add your hosting domain and localhost to authorized domains when needed.
4. Copy the public Web app configuration into `dist/firebase-config.js`, replacing `null` with the configuration object. This is public application configuration, not a Gemini secret.
5. Run `firebase use --add` and select the new project. This creates a local project alias.
6. Run `npm install --prefix functions`.
7. Store the Gemini key with `firebase functions:secrets:set GEMINI_API_KEY`. Enter it privately into the CLI prompt. Never put it in frontend code or chat.
8. Deploy with `firebase deploy --only firestore,functions,hosting`. Set `GEMINI_MODEL` when prompted to a text-generation model available to your Google AI project. The code does not assume a legacy model is available to new projects.

Cloud Functions deployment requires an eligible billing plan. Link billing yourself in the Firebase console before deploying functions; this setup does not authorize upgrading a plan or creating a billing account. Hosting and Firestore access also require the corresponding services to be enabled.

## How it works

Signing in loads that account's campaigns and creates a separate browser recovery cache. Existing local demo campaigns are not silently uploaded into a new account. New campaigns save their board separately from their event history, avoiding the Firestore document-size limit for a growing history. Events have a sequence number and cannot be edited by browser clients. Large payload fields are exempt from indexing.

The server function handles attack, dice, retreat, held, conquest, elimination, victory and NPC decision events. It sends the recorded facts, previous board, country names and three recent event descriptions to Gemini. NPC explanations come from the existing strategy engine. Results are stored separately, keyed by event ID, and displayed under the original factual report. Out-of-order replies attach to their own events; dice animations are not restarted. Replays reuse saved commentary. Fast-forward does not wait for model calls.

The function claims a processing lease in a Firestore transaction. Duplicate deliveries reuse completed results. A crash after a model response but before saving can still incur a second model request on retry. Transient errors retry for up to ten minutes; permanent failures leave the factual report intact. Gemini output is advisory narration and may still contain errors; it never modifies the game state.

## Access and current boundaries

Firestore rules isolate each user's campaigns. Unauthenticated visitors cannot write, and browsers cannot write generated commentary. Existing share links remain read-only embedded snapshots, not live Firestore subscriptions. Generated commentary already present in an embedded snapshot is not currently imported by the snapshot decoder.

Game moves and dice still run in the browser, and signed-in owners can submit their own campaign data. This integration provides authentication and cloud storage, not authoritative server-side anti-cheat enforcement. Avoid playing one campaign concurrently in multiple tabs or devices: board saves currently use last-write-wins. A failed initial account load keeps play locked rather than overwriting remote campaigns.

## Verification

Run `npm run check` for engine regression tests and commentary context tests. After connecting the actual project, verify signup, sign-in, reset email, sign-out, account isolation, save/reload, dice and conquest commentary, fast-forward, replay and temporary disconnection. Firestore rules have also passed live access checks in the connected project. The Gemini event trigger still needs an end-to-end test when it is deployed. Passing local tests does not imply that AI commentary or Hosting is deployed.

To repeat the explicit live Firebase smoke test, run `node scripts/firebase-smoke-test.mjs` after `firebase login`. It creates two temporary accounts, tests access with their Firebase user tokens, and removes only its own test accounts and documents. Cleanup uses the Firebase CLI account's administrator access.
