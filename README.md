# Meridian Conquest

A responsive, interactive frontend based on the supplied Figma design. The source is buildless HTML, CSS and ES modules, with separate UI, country-data and game-engine files.

## Run locally

Use Node.js 24 LTS (also specified in `.nvmrc`). Run `npm ci`, then `npm run dev` and open http://localhost:8081. No build step is needed. Gameplay and saves work without an administrator CLI login.

For Gemini commentary on localhost, sign in with `npx firebase login` and restart `npm run dev`. This server binds only to your computer and configures a private App Check development token outside `dist`, under the ignored `.firebase/` directory. It never prints or deploys the token. You can also serve `dist` with any static server, such as `python3 -m http.server 8080 --directory dist`; local AI requires the development server's App Check setup.

Run `npm run check` for formatting, linting (including syntax checks) and unit tests. Run `npm run browsers:install` once, then `npm run test:browser` for offline gameplay checks. Security-rule tests use Java 21 and `npm run test:rules`; they target only the isolated `demo-meridian` emulator on port 8180. Development dependencies are never bundled into the browser. See [contributor notes](CONTRIBUTING.md) for module boundaries and validation details.

## Vercel deployment

Live game: [meridian-conquest.vercel.app](https://meridian-conquest.vercel.app).

The 2 November 2026 release includes the homepage briefing reveal, local flag
images with roster abbreviations, the tutorial scroll fix, one-field multiplayer
country search and the latest commentary and move validation. Matching Firestore
rules and indexes are published. See the [release checks](docs/VERCEL.md#latest-release-2-november-2026).

The repository includes `vercel.json` for static hosting: framework **Other**, no build or dependency installation, and `dist` as the public directory. Gameplay, Firebase saves and Gemini keep using the same browser code and Firebase project. No personal Gemini API key is needed in Vercel.

See [Vercel setup](docs/VERCEL.md) for future deployments and hostname changes. The production domain is registered for Firebase/Gemini, and the spectator rules and index exemption are published. Publishing the frontend alone does not update Firestore permissions. The current release was deployed directly from local files; automatic GitHub deployments are not connected.

## Design and verification

See the [architecture diagram](docs/ARCHITECTURE.md), [database schema](docs/DATABASE.md) and [assessment demonstration checklist](docs/ASSESSMENT.md). Campaign cards load without downloading every history; opening a campaign loads its events in bounded pages. Damaged histories have individual retries. Versioned saves detect competing changes and keep a local recovery copy when reloading. Keyboard focus survives gameplay redraws and phase changes.

Run `npm run test:ai` for the reviewed commentary checks. Entering a campaign prepares Gemini/App Check when commentary is enabled, without generating an extra report. Fresh generated reports are checked for matching event anchors and several explicit factual contradictions before saving. Human review remains necessary for unrestricted prose quality.

## Included

Welcome, account-form previews, separate saved campaigns, searchable country setup, four difficulty levels, an interactive world map, reinforcement allocation, transfers, paired-dice combat, strategic NPC turns, fast playback, browser-local recovery, live read-only spectator links, legacy shared snapshots and chronological replay. A real Natural Earth map is included locally through world-atlas (ISC, Natural Earth public-domain geometry).

Replay autoplay advances every five seconds so dice animations can finish and events remain readable. Pause playback or use the previous/next controls to review events at your own pace.

Choose Easy, Medium, Hard or Extreme before starting. Each campaign stores its own level and shows it on the board, campaign card and replay. Changing the selection does not redraw opponents. Medium retains the previous balanced strategy. Easy favours larger advantages, retreats sooner and gives the human commander more breathing room. Hard and Extreme concentrate more troops for attacks, prioritise eliminations and strong rivals, estimate follow-up opportunities and hopeless large battles, and apply increasing pressure to the human commander. Levels change NPC planning rather than dice, reinforcement amounts, transfer rules or animation speed. Tuning is centralised in `dist/difficulty.js`.

Each NPC battle phase records the reason for continuing or stopping, including the forces available. The same explanation is visible during fast-forward. Safety stops after 20 single-player phases or 30 multiplayer phases use an explicit regrouping explanation and the saved battle phase, so reloading does not reset that limit.

This release starts the campaign list empty, removes the old `meridian-conquest-ui-v1` campaign collection on load, and never generates saved sample campaigns. New games save under `meridian-conquest-ui-v2` and remain available after reload. The profile and unrelated browser data are left intact. Sample boards are used only for automated tests and the in-memory welcome preview.

The welcome map loops through attacks, troop transfers and captures using the gameplay engine and its existing visual effects. Its scripted board stays in memory, makes no AI requests and never changes saved campaigns. The preview stops when the tab is hidden or you leave the welcome page, restarts when the tab becomes visible, and stays static with reduced motion enabled.

The map includes flowing attack arrows, gold capture ripples and colour transitions, commander-coloured soldier squads and moving count badges during transfers and attack launches, plus floating troop changes, tumbling dice with delayed result highlights, short battle impacts, commander turn highlights and announcements, shared map/roster hover feedback, a pulsing selection and a final map zoom with a gold victory banner and brief confetti. Effects follow new campaign events and replay steps. Troops and missiles move through frame-by-frame SVG transforms in JavaScript. Red casualty badges show each affected country's actual losses on the map and roster after the dice settle; missiles are visual only. An Animations control lets players choose full or reduced motion, starting with their system preference. Asset versioning refreshes the changed animation code and styles. Resuming a save does not replay old combat effects. Animation state is never saved into the campaign or used for dice rolls and NPC decisions.

## Audio and dice presentation

Music preloads while the first screen is open, without playing or creating an AudioContext. Sound starts after the first pointer or keyboard interaction, as required by browsers. Music files use 128 kbps MP3, and the menu and campaign tracks have their opening silence removed. Scene changes use a short fade; the current music continues until the incoming track actually starts, preventing a loading gap. The Settings gear is available throughout the app and contains animation controls and sound settings. Sound settings include independent Music and Sound effects sliders, Mute all, a test chime and credits. Preferences are saved separately from campaigns. Music and active effects pause when the tab is hidden. Fast playback lowers battle effect levels and shortens the dice rattle; sounds are capped to avoid a wall of overlapping effects. Opening a save consumes its earlier events silently, while replay steps play the selected event's cues.

Menus use Decisions by Kevin MacLeod. Entering a campaign crossfades to a separate orchestral track, Lost Frontier, for planning and ordinary replay; active battles use the quieter mix of Mechanolith, returning to the campaign track after the result. Leaving the board or replay restores the menu theme. Kenney CC0 samples supply button clicks, footsteps, dice rattle/landing and impacts. Original Web Audio synthesis supplies missile whooshes and turn, reinforcement, capture, victory, defeat and invalid-action cues. Local audio assets are in dist/assets/audio; music attribution is visible in Sound settings. No API keys or external audio requests are needed during play.

Dice now visibly change faces and bounce for 1.1 seconds (0.55 seconds in fast playback), then reveal the exact stored battle result. Casualty badges and capture effects share that roll clock. Cosmetic faces use a deterministic animation clock rather than random numbers, and leave the combat rules, NPC strategy, saved event records and normal action pauses unchanged. Reduced motion retains static dice and immediate casualty feedback without tumbling.

In single-player and multiplayer, bots show each decision for five seconds before reinforcing, transferring, attacking, rolling again or retreating. Single-player **Fast forward** shortens this reading pause. Reduced motion keeps the full reading pause at normal speed. Gameplay continues independently of AI commentary requests.

Select **Diplomacy** under **Launch attack** to offer an NPC a temporary alliance
in the same action card. Pacts last three rounds and cover both commanders' countries,
while armies and turns stay separate. Betrayal lowers trust; only one commander can
win. See [alliance rules and save behaviour](docs/DIPLOMACY.md).

New players with no saved campaigns enter an interactive tutorial after signing in. A simple guide beside the game controls gives one instruction at a time, with longer explanations under **Rules & examples**. It covers all 26 sections of the supplied instructions; see the [coverage checklist](docs/TUTORIAL.md). It uses the normal map and game controls for reinforcements, attacks, dice results, conquest, transfers and retreat, followed by reports, settings and a practice multiplayer room code. Practice uses preset armies and guided dice, including the 10-versus-2 battle example; it creates no saved campaign, room or Gemini requests. Skip whenever you want, or replay from **Interactive tutorial** in My campaigns or **How to play**. The offer and completion are remembered separately for each account in this browser; clearing browser storage or using another device can show it again. Refreshing practice restarts the lesson.

## Integration boundary

This app supports optional Firebase Authentication, Firestore saves and Gemini commentary through Firebase AI Logic. Without Firebase configuration it runs as a local demo with preview account forms. With Firebase connected, credentials are sent securely to Firebase Authentication and campaigns are saved under the signed-in account. Sharing a signed-in campaign creates an opt-in live spectator link. Existing embedded snapshot links still work.

## Population data

Choose from 233 countries and territories from the exam's [Worldometers population-by-country table](https://www.worldometers.info/world-population/population-by-country/), including Vatican City. Setup shows exact population counts, the estimate year and the snapshot date. Initial soldier bands use the unrounded counts, including populations below 100,000. These are annual estimates, not the site's per-second population clock. Small countries remain visible and selectable through their map markers and roster entries even when the bundled map has no outline for them.

Names, ISO codes and coordinates derive from [mledoze/countries](https://github.com/mledoze/countries), with the original 24 countries' labels and map positions preserved for saved games. The generated metadata is available under ODbL 1.0; source attribution and the licence are in `dist/assets/COUNTRY_DATA_CREDITS.txt` and `COUNTRY_DATA_LICENSE.txt`. Population figures remain sourced separately from Worldometers. `npm run catalogue:refresh` regenerates the full catalogue and offline snapshot; review its changes before deploying. Population snapshots use version 2; the original 24-country reference can be upgraded without changing any saved game.

Setup country flags use bundled SVG images from
[flag-icons 7.3.2](https://github.com/lipis/flag-icons/tree/v7.3.2), with its original
licence in `dist/assets/flags/LICENSE`. The images work independently of native
flag-emoji support and do not require an external image service during play.

Run `npm run dev` and open http://localhost:8081 for automatic local updates. The development server checks Worldometers on startup and once per day while running, caching the last validated snapshot under the ignored `.firebase/population-cache.json`. It serves that snapshot immediately from `/population-data.json`; gameplay never waits for the source website. A source outage, missing country, changed table format, older year or unexpected change over 25% leaves the previous snapshot in place. Failed source checks retry after an hour. A large legitimate revision needs manual review. The browser also caches its working snapshot separately from campaigns.

Updates affect new games and the unsaved setup preview. Existing campaigns and rooms retain their saved populations, armies and conquest rewards. No player campaign is rewritten by the updater. A plain static server uses the bundled snapshot or public Firestore reference instead; use the development server for local source checks. Checks pause when your local server is off. Firebase stays on Spark; no Cloud Function or billing upgrade is used.

The **Update country populations** GitHub Action is included in the GitHub backup. When enabled in the repository's Actions settings, it checks daily at 05:23 UTC (07:23 South Africa time) and publishes `publicData/populations` for hosted clients while your computer is off. Its dedicated Firebase account has encrypted credentials in GitHub Actions Secrets and is excluded from gameplay access. The scheduled job depends on the repository's GitHub Actions allowance and may be delayed by GitHub.

Use `npm run populations:update` to refresh the bundled offline snapshot locally, then redeploy Hosting to distribute that bundle. See [Firebase setup](docs/FIREBASE.md#population-updates) for the one-time scheduler setup and recovery steps.

An operator signed in with the Firebase CLI can run `npm run populations:publish` to publish the validated reference to Firestore. This command writes only `publicData/populations` and uses a revision precondition; it does not migrate campaigns or enable billing. New snapshots, nicknames and other local UI changes require a Hosting deployment to reach the public website.

Game rules and dice execute in the browser to keep Firebase Spark free. Multiplayer validates room membership, turn ownership, revisions, structured board fields and immutable starting-country data. It cannot prove that a participant generated fair random dice: fully authoritative competitive play requires a trusted server. Live spectator links apply to shared single-player campaigns; multiplayer rooms retain their existing member-only permissions.

Use the share icon on a campaign card to copy a live viewing link. Visitors need no account and see the board, recent field reports and available AI commentary update as the owner plays. Only the signed-in owner can play turns or publish changes. **Stop sharing** on the campaign card revokes the link. Private campaigns remain owner-only; sharing publishes an explicit gameplay copy under `liveGames`, without email addresses or account credentials. The recent history is bounded to 60 events, while the owner's complete private history is retained. The owner must keep the game open for play to continue; closing it leaves the last published position visible. Deploy the frontend, Firestore rules and index exemptions together to enable this feature on the public site. A localhost link is accessible only on that computer.

## Firebase and AI commentary

Gemini 3.5 Flash-Lite adds brief, match-aware reports in the AI commentary tab in campaigns and multiplayer. A compact prompt and minimal reasoning reduce generation work. Each match keeps only its most important pending event, choosing the newest when priorities match, so fast-forward skips stale AI requests. Victories, eliminations and conquests take precedence over routine exchanges; all factual reports and NPC explanations remain visible. Its commentator follows the event-time standings, territorial lead changes and battle pressure, with recent wording memory to avoid repetitive stat readouts. Turning it on in Settings immediately requests recent action in the open campaign or hosted multiplayer match; new events continue automatically. **Generate commentary** remains an optional retry for saved events. Both paths consider the three latest eligible saved events without current-version reports and select the most important. This also refreshes older commentary while preserving the original reports. The panel shows queued, generating and error states. Reports are saved by event ID, so reloading and replaying reuse them. Turns continue if the model is slow or a free quota is exhausted.

Use the **Field reports** and **AI commentary** tabs to switch between the factual game log and generated reports. Commentary status and the optional Generate commentary button are in the AI tab. **Pin reports** keeps the existing panel at the bottom of the screen, aligned with the map column. Gameplay maps fill their panel's width, preserving the map's proportions, without title bars, badges or footer captions. Overlapping country labels move apart using thick, solid connectors in their commander's colour. Country markers keep their geographic positions, and labels remain clickable on the campaign map. Opening the panel brings the map into view when needed; subsequent reports do not move the page. Use its arrow to collapse or expand it, or **Unpin** to return it beneath the map. Selecting a tab also expands a collapsed panel. The tab, pin and collapse choices stay in place as turns and reports update, in campaigns and multiplayer; these controls do not change saved games.

When reports are expanded and pinned, the whole map card scales proportionally to fit above them, leaving room for the map controls. The map fills the card without empty side strips. Collapsing or unpinning reports restores the full-width map.

New commentary uses impartial, third-person play-by-play for the whole match, including bot-versus-bot battles. It names the countries and commanders involved rather than addressing the viewer or giving advice. Saved nicknames remain unchanged; legacy "You" labels use a neutral commander name only in AI context. Previously saved reports retain their original wording.

The narrator uses concise military strategy commentary with event-specific guidance for plans, retreat, defence, conquest, elimination and victory. Before new reports are saved, wording checks reject detected sports imagery, premature outcomes and explicit casualty contradictions. Recorded nicknames are exempt from these wording checks. `npm run commentary:preview` evaluates eight real-model scenarios in two bounded requests without writing campaigns; unrestricted prose still needs human review.

The connected project uses Firebase AI Logic with the Gemini Developer API on the free Spark plan. Requests require sign-in and App Check; no personal Gemini API key goes in the browser. See [the setup guide](docs/FIREBASE.md) for configuration, local development and access boundaries.

## Play with friends

Choose your **Player nickname** when signing up, or open **Settings → Player nickname** (also available by clicking your profile). Nicknames are 2–32 characters and save to your Firebase account. The same nickname is used automatically when you create or join multiplayer rooms and when you start a new single-player campaign. Existing games keep their recorded player names and history.

[Open multiplayer](https://meridian-conquest.vercel.app/#multiplayer).

Choose **Multiplayer**, create a room and share the six-character code. Each signed-in friend reserves a different starting country. Once everyone has chosen, the host opens **Roll for first turn**; empty seats receive distinct countries and automatic bot rolls. Each human clicks **Roll my die**. The highest roll goes first; the host opens a tie-break when needed, and only tied leaders reroll. Once a winner is known, the host starts the match. Remaining turns follow lobby seat order from that winner.

Multiplayer reuses the single-player game screen: the same roster, map, reinforcement steppers, attack and transfer controls, dice, and report tabs. Ownership and controls are relative to each viewer's seat; waiting friends cannot submit another player's move. Keep the host's room open for bot turns. A returning player can sign in and use the same code to reclaim their seat, country and recorded opening roll. Existing started matches retain their countries and order. See [Firebase setup](docs/FIREBASE.md#multiplayer-rooms) for the hosting and trust boundaries.
