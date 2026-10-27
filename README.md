# Meridian Conquest

A responsive, interactive frontend based on the supplied Figma design. The source is buildless HTML, CSS and ES modules, with separate UI, country-data and game-engine files.

## Run locally

Serve the `dist` folder using any static web server, for example `python3 -m http.server 8080 --directory dist`, then open http://localhost:8080.

For Gemini commentary on localhost, sign in with `firebase login` and run `npm run dev`. Open http://localhost:8081. This server binds only to your computer and configures a private App Check development token outside `dist`, under the ignored `.firebase/` directory. It never prints or deploys the token. Plain static servers support gameplay and saves; use the development server for local AI requests.

Run `npm ci` once, then `npm run check` for JavaScript syntax checks and regression tests. Population updater dependencies run only in development and GitHub Actions; the browser remains buildless.

## Included

Welcome, account-form previews, separate saved campaigns, searchable country setup, four difficulty levels, an interactive world map, reinforcement allocation, transfers, paired-dice combat, strategic NPC turns, fast playback, browser-local recovery, read-only shared snapshots and chronological replay. A real Natural Earth map is included locally through world-atlas (ISC, Natural Earth public-domain geometry).

Choose Easy, Medium, Hard or Extreme before starting. Each campaign stores its own level and shows it on the board, campaign card and replay. Changing the selection does not redraw opponents. Medium retains the previous balanced strategy. Easy favours larger advantages, retreats sooner and gives the human commander more breathing room. Hard and Extreme concentrate more troops for attacks, prioritise eliminations and strong rivals, estimate follow-up opportunities and hopeless large battles, and apply increasing pressure to the human commander. Levels change NPC planning rather than dice, reinforcement amounts, transfer rules or animation speed. Tuning is centralised in `dist/difficulty.js`.

Each NPC battle phase records the reason for continuing or stopping, including the forces available. The same explanation is visible during fast-forward. Safety stops after 20 single-player phases or 30 multiplayer phases use an explicit regrouping explanation and the saved battle phase, so reloading does not reset that limit.

This release starts the campaign list empty, removes the old `meridian-conquest-ui-v1` campaign collection on load, and never generates sample campaigns. New games save under `meridian-conquest-ui-v2` and remain available after reload. The profile and unrelated browser data are left intact. Sample-board creation remains available only as a deterministic engine fixture for automated tests.

The map includes flowing attack arrows, gold capture ripples and colour transitions, commander-coloured soldier squads and moving count badges during transfers and attack launches, plus floating troop changes, tumbling dice with delayed result highlights, short battle impacts, commander turn highlights and announcements, shared map/roster hover feedback, a pulsing selection and a final map zoom with a gold victory banner and brief confetti. Effects follow new campaign events and replay steps. Troops and missiles move through frame-by-frame SVG transforms in JavaScript. Red casualty badges show each affected country's actual losses on the map and roster after the dice settle; missiles are visual only. An Animations control lets players choose full or reduced motion, starting with their system preference. Asset versioning refreshes the changed animation code and styles. Resuming a save does not replay old combat effects. Animation state is never saved into the campaign or used for dice rolls and NPC decisions.

## Audio and dice presentation

Music preloads while the first screen is open, without playing or creating an AudioContext. Sound starts after the first pointer or keyboard interaction, as required by browsers. Music files use 128 kbps MP3, and the menu and campaign tracks have their opening silence removed. Scene changes use a short fade; the current music continues until the incoming track actually starts, preventing a loading gap. The Settings gear is available throughout the app and contains animation controls and sound settings. Sound settings include independent Music and Sound effects sliders, Mute all, a test chime and credits. Preferences are saved separately from campaigns. Music and active effects pause when the tab is hidden. Fast playback lowers battle effect levels and shortens the dice rattle; sounds are capped to avoid a wall of overlapping effects. Opening a save consumes its earlier events silently, while replay steps play the selected event's cues.

Menus use Decisions by Kevin MacLeod. Entering a campaign crossfades to a separate orchestral track, Lost Frontier, for planning and ordinary replay; active battles use the quieter mix of Mechanolith, returning to the campaign track after the result. Leaving the board or replay restores the menu theme. Kenney CC0 samples supply button clicks, footsteps, dice rattle/landing and impacts. Original Web Audio synthesis supplies missile whooshes and turn, reinforcement, capture, victory, defeat and invalid-action cues. Local assets, source links and license notices are in dist/assets/audio; required music attribution is also visible in Sound settings. No API keys or external audio requests are needed during play.

Dice now visibly change faces and bounce for 1.1 seconds (0.55 seconds in fast playback), then reveal the exact stored battle result. Casualty badges and capture effects share that roll clock. Cosmetic faces use a deterministic animation clock rather than random numbers, and leave the combat rules, NPC strategy, saved event records and normal action pauses unchanged. Reduced motion retains static dice and immediate casualty feedback without tumbling.

## Integration boundary

This app supports optional Firebase Authentication, Firestore saves and Gemini commentary through Firebase AI Logic. Without Firebase configuration it runs as a local demo with preview account forms. With Firebase connected, credentials are sent securely to Firebase Authentication and campaigns are saved under the signed-in account. Shared links currently contain read-only snapshots rather than live server sessions.

## Population data

All 234 countries and territories in the exam's [Worldometers population-by-country table](https://www.worldometers.info/world-population/population-by-country/) are selectable, including Vatican City. Setup shows exact population counts, the estimate year and the snapshot date. Initial soldier bands use the unrounded counts, including populations below 100,000. These are annual estimates, not the site's per-second population clock. Small countries remain visible and selectable through their map markers and roster entries even when the bundled map has no outline for them.

Names, ISO codes and coordinates derive from [mledoze/countries](https://github.com/mledoze/countries), with the original 24 countries' labels and map positions preserved for saved games. The generated metadata is available under ODbL 1.0; source attribution and the licence are in `dist/assets/COUNTRY_DATA_CREDITS.txt` and `COUNTRY_DATA_LICENSE.txt`. Population figures remain sourced separately from Worldometers. `npm run catalogue:refresh` regenerates the full catalogue and offline snapshot; review its changes before deploying. Population snapshots use version 2; the original 24-country reference can be upgraded without changing any saved game.

Run `npm run dev` and open http://localhost:8081 for automatic local updates. The development server checks Worldometers on startup and once per day while running, caching the last validated snapshot under the ignored `.firebase/population-cache.json`. It serves that snapshot immediately from `/population-data.json`; gameplay never waits for the source website. A source outage, missing country, changed table format, older year or unexpected change over 25% leaves the previous snapshot in place. Failed source checks retry after an hour. A large legitimate revision needs manual review. The browser also caches its working snapshot separately from campaigns.

Updates affect new games and the unsaved setup preview. Existing campaigns and rooms retain their saved populations, armies and conquest rewards. No player campaign is rewritten by the updater. A plain static server uses the bundled snapshot or public Firestore reference instead; use the development server for local source checks. Checks pause when your local server is off. Firebase stays on Spark; no Cloud Function or billing upgrade is used.

An optional **Update country populations** GitHub Action is prepared locally but is **not activated**. If committed and pushed later, it can check daily at 05:23 UTC (07:23 South Africa time) and publish `publicData/populations` for hosted clients while your computer is off. Its dedicated Firebase account has encrypted credentials in GitHub Actions Secrets and is excluded from gameplay access. The scheduled job depends on the repository's GitHub Actions allowance and may be delayed by GitHub.

Use `npm run populations:update` to refresh the bundled offline snapshot locally, then redeploy Hosting to distribute that bundle. See [Firebase setup](docs/FIREBASE.md#population-updates) for the one-time scheduler setup and recovery steps.

An operator signed in with the Firebase CLI can run `npm run populations:publish` to publish the validated reference to Firestore. This command writes only `publicData/populations` and uses a revision precondition; it does not migrate campaigns or enable billing. New snapshots, nicknames and other local UI changes require a Hosting deployment to reach the public website.

Game rules and dice still execute in the browser. To enforce authoritative gameplay and prevent owners from editing their own game data, move `GameEngine` operations into backend functions. Live spectators are also a separate remaining feature. The prototype conquest allocation assigns one earned soldier to the occupied country and leaves the remaining reward in the origin; confirm the examiner's intended reward-allocation convention before finalising the backend.

## Firebase and AI commentary

Gemini 3.6 Flash adds match-aware commentary beneath new battle reports in campaigns and multiplayer. Its commentator follows the event-time standings, territorial lead changes and battle pressure, with recent wording memory to avoid repetitive stat readouts. Open the Settings gear to switch it on or off. Use **Generate commentary** above the field reports to narrate the three latest eligible saved events without current-version reports. This also refreshes older commentary while preserving the original reports. The panel shows queued, generating and error states. Reports are saved by event ID, so reloading and replaying reuse them. Turns continue if the model is slow or a free quota is exhausted.

The connected project uses Firebase AI Logic with the Gemini Developer API on the free Spark plan. Requests require sign-in and App Check; no personal Gemini API key goes in the browser. See [the setup guide](docs/FIREBASE.md) for configuration, local development and access boundaries.

## Play with friends

Choose your **Player nickname** when signing up, or open **Settings → Player nickname** (also available by clicking your profile). Nicknames are 2–32 characters and save to your Firebase account. The same nickname is used automatically when you create or join multiplayer rooms and when you start a new single-player campaign. Existing games keep their recorded player names and history.

[Open multiplayer](https://meridian-conquest-m112.web.app/#multiplayer).

Choose **Multiplayer**, create a room and share the six-character code. Signed-in friends join the lobby, and the host starts once everyone is ready. Bots fill the remaining seats up to ten players. Everyone sees the board, troop counts, dice and field reports update live. Keep the host's room open for bot turns; a returning player can sign in and use the same code to reclaim their seat. See [Firebase setup](docs/FIREBASE.md#multiplayer-rooms) for the hosting and trust boundaries.
