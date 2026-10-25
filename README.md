# Meridian Conquest

A responsive, interactive frontend based on the supplied Figma design. The source is buildless HTML, CSS and ES modules, with separate UI, sample-data and game-engine files.

## Run locally

Serve the `dist` folder using any static web server, for example `python3 -m http.server 8080 --directory dist`, then open http://localhost:8080.

Run `npm run check` for JavaScript syntax checks and the battle-rule tests. No dependency installation is needed.

## Included

Welcome, account-form previews, separate saved campaigns, searchable country setup, four difficulty levels, an interactive world map, reinforcement allocation, transfers, paired-dice combat, strategic NPC turns, fast playback, browser-local recovery, read-only shared snapshots and chronological replay. A real Natural Earth map is included locally through world-atlas (ISC, Natural Earth public-domain geometry).

Choose Easy, Medium, Hard or Extreme before starting. Each campaign stores its own level and shows it on the board, campaign card and replay. Changing the selection does not redraw opponents. Medium retains the previous balanced strategy. Easy favours larger advantages, retreats sooner and gives the human commander more breathing room. Hard and Extreme concentrate more troops for attacks, prioritise eliminations and strong rivals, estimate follow-up opportunities and hopeless large battles, and apply increasing pressure to the human commander. Levels change NPC planning rather than dice, reinforcement amounts, transfer rules or animation speed. Tuning is centralised in `dist/difficulty.js`.

This release starts the campaign list empty, removes the old `meridian-conquest-ui-v1` campaign collection on load, and never generates sample campaigns. New games save under `meridian-conquest-ui-v2` and remain available after reload. The profile and unrelated browser data are left intact. Sample-board creation remains available only as a deterministic engine fixture for automated tests.

The map includes flowing attack arrows, gold capture ripples and colour transitions, commander-coloured soldier squads and moving count badges during transfers and attack launches, plus floating troop changes, tumbling dice with delayed result highlights, short battle impacts, commander turn highlights and announcements, shared map/roster hover feedback, a pulsing selection and a final map zoom with a gold victory banner and brief confetti. Effects follow new campaign events and replay steps. Troops and missiles move through frame-by-frame SVG transforms in JavaScript. Red casualty badges show each affected country's actual losses on the map and roster after the dice settle; missiles are visual only. An Animations control lets players choose full or reduced motion, starting with their system preference. Asset versioning refreshes the changed animation code and styles. Resuming a save does not replay old combat effects. Animation state is never saved into the campaign or used for dice rolls and NPC decisions.

## Audio and dice presentation

Music preloads while the first screen is open, without playing or creating an AudioContext. Sound starts after the first pointer or keyboard interaction, as required by browsers. Music files use 128 kbps MP3, and the menu and campaign tracks have their opening silence removed. Scene changes use a short fade; the current music continues until the incoming track actually starts, preventing a loading gap. The Settings gear is available throughout the app and contains animation controls and sound settings. Sound settings include independent Music and Sound effects sliders, Mute all, a test chime and credits. Preferences are saved separately from campaigns. Music and active effects pause when the tab is hidden. Fast playback lowers battle effect levels and shortens the dice rattle; sounds are capped to avoid a wall of overlapping effects. Opening a save consumes its earlier events silently, while replay steps play the selected event's cues.

Menus use Decisions by Kevin MacLeod. Entering a campaign crossfades to a separate orchestral track, Lost Frontier, for planning and ordinary replay; active battles use the quieter mix of Mechanolith, returning to the campaign track after the result. Leaving the board or replay restores the menu theme. Kenney CC0 samples supply button clicks, footsteps, dice rattle/landing and impacts. Original Web Audio synthesis supplies missile whooshes and turn, reinforcement, capture, victory, defeat and invalid-action cues. Local assets, source links and license notices are in dist/assets/audio; required music attribution is also visible in Sound settings. No API keys or external audio requests are needed during play.

Dice now visibly change faces and bounce for 1.1 seconds (0.55 seconds in fast playback), then reveal the exact stored battle result. Casualty badges and capture effects share that roll clock. Cosmetic faces use a deterministic animation clock rather than random numbers, and leave the combat rules, NPC strategy, saved event records and normal action pauses unchanged. Reduced motion retains static dice and immediate casualty feedback without tumbling.

## Integration boundary

This app supports optional Firebase Authentication, Firestore saves and backend Gemini commentary. Without Firebase configuration it runs as a local demo with preview account forms. With Firebase connected, credentials are sent securely to Firebase Authentication and campaigns are saved under the signed-in account. Shared links currently contain read-only snapshots rather than live server sessions. Country populations are illustrative.

Game rules and dice still execute in the browser. To enforce authoritative gameplay and prevent owners from editing their own game data, move `GameEngine` operations into backend functions. Live spectators are also a separate remaining feature. The prototype conquest allocation assigns one earned soldier to the occupied country and leaves the remaining reward in the origin; confirm the examiner's intended reward-allocation convention before finalising the backend.

## Firebase and AI commentary

See [the setup guide](docs/FIREBASE.md) to connect a Firebase project, enable email/password accounts, save campaigns in Firestore and generate Gemini battle commentary on the server. The Gemini key belongs in Secret Manager, never in the public web configuration.
