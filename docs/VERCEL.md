# Deploying Meridian Conquest on Vercel

The application is static HTML, CSS and browser JavaScript. Vercel serves the
existing `dist` directory; Firebase continues to provide Authentication, Firestore
and Gemini through Firebase AI Logic. No billing upgrade, personal Gemini API key
or server function is needed for this hosting setup.

Production: [meridian-conquest.vercel.app](https://meridian-conquest.vercel.app).
The project is `mo-dawood/meridian-conquest`, created on 1 November 2026. The
production hostname is registered for Firebase Authentication and App Check, and
the spectator rules and index exemption are published.

## Update the existing project

The initial deployment uploaded the current local files directly with Vercel CLI;
it did not push a Git commit or enable automatic deployments from GitHub. This
checkout is linked through the ignored `.vercel` directory. To deploy updates:

```sh
npm run check
npx vercel deploy --prod
```

On another development computer, sign in with `npx vercel login`, then link to
the existing project with `npx vercel link --project meridian-conquest --scope mo-dawood`.
To use automatic Git deployments later, push the reviewed local changes before
connecting `Muhammed112/Meridian_Conquest_UI` to this project in Vercel settings.

Keep the Root Directory at the repository root so Vercel reads `vercel.json`.
The checked-in configuration selects these settings automatically:

| Setting          | Value          |
| ---------------- | -------------- |
| Framework preset | Other          |
| Build command    | Empty; skipped |
| Install command  | Empty; skipped |
| Output directory | `dist`         |

If the production hostname changes or a custom domain is added, register that
exact hostname using the next step. Do not authorize all of `vercel.app` or use
wildcards. The current production hostname already has these settings.

Only `dist` is publicly served. `.vercelignore` also limits CLI uploads to that
folder and `vercel.json`, excluding local credentials, logs, operator scripts and
the optional Firebase Functions source. The configuration revalidates HTML,
JavaScript and CSS so a later deployment does not keep using old application code.
Hash routes such as `/#game/id` and `/#live/id` need no server-side rewrite.

## Register the production hostname

Use the existing Firebase CLI sign-in on your development computer:

```sh
npm ci
npx firebase login
npm run hosting:domain -- https://your-game.vercel.app
```

Replace the example hostname with the one Vercel actually assigned. This command
previews additions without writing cloud settings. When the preview is correct:

```sh
npm run hosting:domain -- https://your-game.vercel.app --apply
```

The apply command adds the hostname to Authentication's authorized domains and
the existing reCAPTCHA Enterprise key's allowed domains. Existing Firebase
Hosting domains remain registered. The command backs up only domain settings to
the ignored `.firebase/hosting-domain-backups/` directory and verifies its writes.
It does not change users, campaign documents, passwords, sign-in providers,
billing or App Check enforcement. If a request fails after one update, run the
preview again; applying the remaining addition is safe to repeat.

Keep the existing `firebaseConfig.authDomain` in `dist/firebase-config.js`.
Vercel serves the game while Firebase retains its authentication action pages.
Never copy the private local App Check debug token into Vercel or public files.
The checked-in `dist/ai-local-config.js` already disables local-only overrides
when served statically.

## Publish future spectator permission changes separately

The current rules and indexes were published on 2 November 2026. For later
changes, review and test the local rules and index configuration, then publish
them to Firebase using this deliberately scoped command:

```sh
npx firebase deploy --only firestore:rules,firestore:indexes --project meridian-conquest-m112
```

This does not deploy Firebase Hosting or Cloud Functions, and does not migrate or
delete campaigns. It enables the separate public `liveGames` copies required by
live spectator links. The original private campaign collections stay owner-only.
Frontend deployments do not update these permissions automatically.
See [Firebase setup](FIREBASE.md) for details.

## Latest release: 2 November 2026

The current application was deployed to the existing Vercel production project as
`dpl_A8fruxnWELKJ6bTF8NEvmS8Y7inV`, with the canonical address
[meridian-conquest.vercel.app](https://meridian-conquest.vercel.app).
Its deployment address is
[meridian-conquest-6lawfd2ru-mo-dawood.vercel.app](https://meridian-conquest-6lawfd2ru-mo-dawood.vercel.app).
The canonical address is publicly accessible; deployment-specific addresses can
retain Vercel authentication protection.

This release includes the latest commentary and move validation, tutorial scroll
preservation, country flag images with roster abbreviations, the one-field
multiplayer country picker, the copy-live-link control and the homepage briefing
entrance. The optional Cloud Functions implementation remains undeployed, and the
Firebase Spark plan is unchanged.

Before publishing, formatting, lint, all 200 unit tests, all 15 isolated Firestore
emulator tests and all eight offline browser scripts passed. The matching rules
and indexes were published first, with the previous rules backed up privately.
The Firebase-hosted cloud, campaign-store, engine and room modules were compared
with the local executable code and matched. That host retains its previous UI;
this release's frontend was published to Vercel only.

After publishing, 294 non-audio frontend files matched the local files byte for
byte, including the flag assets. The homepage returned HTTP 200 without sign-in,
application files used revalidation headers, six private/operator paths returned
404 and the active Firestore rules matched the tested source.

Live checks passed account sign-in, country reservations, opening dice,
turn permissions, shared combat, automatic bot turns and reconnection. A separate
check verified real Gemini reports, saved-report reuse, versioned cloud saves,
new-campaign reload after removing its browser cache, anonymous spectator viewing
and sharing revocation. All temporary campaigns, room events, test accounts and
the test App Check attestation were removed.

The automated Gemini check used a temporary debug provider, as the previous
release did. It did not disable production App Check enforcement or certify an
ordinary browser's reCAPTCHA trust score. Existing user accounts and campaigns
were not migrated or deleted. Refresh existing Vercel tabs to load the release.

## Verify the deployed website

The quality update was published to Vercel and Firebase Hosting with matching
Firestore rules on 1 November 2026, with live checks continuing on 2 November.
Its campaign writer adds `saveRevision`, `historyHead` and event predecessor
fields. Future changes to this save protocol must update the rules and all
maintained frontends together; publishing only the frontend against older rules
rejects these save fields. Refresh existing tabs after a release. No existing
campaigns were bulk-migrated or deleted. See [compatibility strategy](DATABASE.md#compatibility-strategy).

The release passed formatting, lint, 199 unit tests, all eight offline browser
scripts and 14 Firestore emulator permission tests. The offline checks cover the
shared single-player/multiplayer layout, country choices, opening tie-breaks,
combat, reports, save conflicts and responsive layouts.

Both public hosts served exact copies of 24 checked frontend files and denied
access to private paths. The published rules matched the tested local source.
Live checks passed sign-in, saved-campaign loading, legacy save upgrades, Gemini
generation, saved-report reuse, the Settings toggle, delayed dice results and
anonymous spectator access and revocation. A separate fresh-account check
confirmed a new campaign reached Firestore and reloaded after removing its
browser recovery cache. Temporary test data was removed. The
automated browser required Firebase's temporary debug provider because reCAPTCHA
gave it a low trust score. The owner separately confirmed commentary appeared in
a normal browser. Production App Check protection remains enabled.

A separate live two-browser multiplayer check passed country reservations,
opening rolls, turn permissions, shared combat results, mobile layout and
reconnection. It ran with AI generation disabled and removed its temporary room,
events and accounts afterward.

Open the actual production URL and check:

1. Sign in and confirm an existing campaign loads. The same Firebase account
   retains its cloud campaigns; browser preferences and session caches belong to
   each website origin separately.
2. Complete a turn, refresh and verify the save. Check multiplayer joining and a
   turn with a friend.
3. Enable AI commentary and check a new report. App Check must accept the new
   domain; ordinary Gemini quotas and provider availability still apply.
4. Share a campaign and open the link in a signed-out/private browser. It must
   show live moves without gameplay or generation controls. Stop sharing and
   confirm that the link loses access.
5. Verify that visitors can reach the production URL without needing a Vercel
   account; project deployment protection must allow the intended audience.

The offline test suites remain useful, but cannot certify a deployment's real
domain authorization or cloud permissions. Creating a project or importing the
repository does not automatically finish those Firebase setup steps.

References: [Vercel static configuration](https://vercel.com/docs/project-configuration/vercel-json),
[deployment exclusions](https://vercel.com/docs/deployments/vercel-ignore),
[Firebase App Check](https://firebase.google.com/docs/app-check/web/recaptcha-enterprise-provider).
