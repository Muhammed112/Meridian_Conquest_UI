# Assessment evidence and demonstration checklist

This maps the supplied INF4001N marksheet's fourteen four-mark criteria to
implementation and verification evidence. It is not a prediction or guarantee of
the examiner's score.

| Criterion                            | Evidence                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Database layer                       | `cloud.js`, private `CampaignStore`, room service and storage codecs                                 |
| Database connection                  | Firebase Authentication, Firestore reads/writes, listeners and scoped error handling                 |
| Database design                      | [Schema and compatibility strategy](DATABASE.md), immutable events and separate AI reports           |
| Coding structure                     | [Module boundaries](ARCHITECTURE.md), focused controllers, lint and formatting checks                |
| Object-oriented concepts             | Game, battle, strategy, storage, queue, motion and sound classes; private storage/queue state        |
| Validation and controls              | Engine boundary tests, record validation and actual Firestore emulator permissions                   |
| Functionality                        | Paired dice, population bands, transfers, reinforcements, elimination and victory regression tests   |
| Lists, search, filtering and viewing | Searchable setup/cards, status filters, lazy paginated histories and isolated recovery tests         |
| User interface                       | Shared game screen, readable action feedback, responsive layouts and delayed battle results          |
| Ease of navigation                   | Keyboard focus retention, report-tab arrow keys, tutorial, replay and campaign-specific retry        |
| Authentication and authorization     | Owner-only campaigns, controlled room writes and anonymous read-only live links                      |
| Sophistication and complexity        | Strategic NPCs, opening dice, multiplayer, replay, live spectators, motion and audio                 |
| AI application                       | Event-time narration, priority queue, setup preparation, caching and [AI evaluation](#ai-evaluation) |
| Evidence of effort                   | Maintained source, automated checks, integration scripts, documentation and asset attribution        |

## Reproducible checks

```sh
npm ci
npm run check
npm run browsers:install
npm run test:browser
npm run test:rules
npm run test:ai
```

Use Node.js 24 LTS and Java 21 for the emulator. Offline browser checks exercise
desktop, tablet and phone layouts without a real account or AI quota. Tests also
cover damaged records, a stalled history, another accessible campaign, recovery,
large paginated histories, interrupted uploads, concurrent saves, map controls,
report tabs, tutorial isolation and spectator revocation.

## AI evaluation

The local quality review passed formatting, lint, 199 unit tests, all eight
browser scripts and 14 Firestore emulator tests. The permission tests include
nine-country split reinforcement, a winning conquest, extended bot turns and
concurrent-save protection. A separate comparison with the saved pre-change
engine matched 1,182 legal action steps across all four difficulty levels.

The real Gemini preview produced all four reports with matching verification
anchors in 5.9 seconds on that run. Its temporary account was removed and no
campaigns were written. This is one observed latency, not a response-time promise.
The quality update and its matching Firestore rules were published on 1 November 2026. Live checks through 2 November verified existing-campaign loading, legacy
save upgrades, new-campaign save/reload without the browser recovery cache,
Gemini generation and reuse, spectator revocation and two-player gameplay. Both
public hosts served the checked frontend files. Temporary test accounts and data
were removed. See the [release evidence](VERCEL.md#verify-the-deployed-website)
for deployment details and the automated App Check limitation.

The offline corpus includes twenty reviewed examples of supported and incorrect
casualty prose: human/bot names, unequal losses, ties, zero casualties, numerical
and written counts, reversed comparisons and premature outcomes. Additional tests
verify exact response anchors, rejection before persistence, private queue state
and preparing Gemini without generating reports. This corpus checks known
regressions; it is not a statistical evaluation of unrestricted generated prose.

The 2 November local refinements passed 200 unit tests and 15 Firestore emulator
tests. Added cases reject enemy troop transfers, funding of rivals, troop removal
during reinforcement, transfers involving three countries, fractional armies and
early round advances. Legal nine-country reinforcement, final conquest and
extended bot turns remain covered. The updated prompt and wording checks also
passed an eight-scenario real-Gemini preview: human/bot pressure, stalemate, a
territorial lead change, retreat, defence holding, elimination and victory.
The two model requests took 10.3 seconds on that run, and the temporary account
was removed without writing campaigns. These refinements and the later UI updates
were published to Vercel with matching Firestore rules and indexes on 2 November.
The release passed 200 unit tests, 15 emulator tests and all eight offline browser
scripts. Live checks passed saving/reloading, Gemini generation and reuse, live
spectator revocation and two-player gameplay; temporary test data was removed.
See the [latest release evidence](VERCEL.md#latest-release-2-november-2026).

For a deliberate real-model evaluation, start `npm run dev`, then run
`npm run commentary:preview`. It signs in a temporary account, generates reports
for known human pressure, stalemate, bot combat and a territorial lead change,
checks their format, anchors and selected factual claims, and reports elapsed
time. It removes its temporary account and writes no campaigns. It requires the
operator's local App Check setup and consumes normal Gemini quota. Read each
generated line for naturalness and unsupported implications, in addition to the
automatic checks.

## Examiner demonstration

1. Sign in, choose a country, start a ten-country single-player campaign and show
   the population source and starting-army bands.
2. Allocate reinforcements from round two, including a split allocation. Show
   that a country retains at least one soldier after transfers.
3. Demonstrate paired dice, a tie, losses appearing after the animation,
   conquest rewards, retreat and the one-attack-per-turn rule.
4. Observe NPC decisions and their reasons at normal and fast speed. Show a
   bot-versus-bot event and an AI report tied to recorded facts.
5. Reload a campaign, search/filter the list, review chronological replay and
   open another campaign independently of a failed history.
6. Share a campaign, open it while signed out, observe live updates and confirm
   visitors have no move controls. Revoke sharing and verify access disappears.
7. Demonstrate multiplayer country reservations, each human's opening roll,
   tie-breaks, bot fill, viewer-relative controls and reconnection.
8. Complete the main controls with a keyboard and check a phone-sized viewport.

## Submission checklist

- Include maintained source, public configuration, tests, lockfiles, this
  documentation and required third-party asset licences in the source ZIP.
- Exclude `.firebase`, `.vercel`, `.git`, `node_modules`, debug logs, local App
  Check tokens, administrator credentials and private environment files.
- Supply the current deployed URL and a working application test account through
  the university's required submission channel. Keep its password out of source.
- Confirm the documented examiner database grants still apply to the three
  accounts listed in the original brief. Application sign-in and database-console
  access are separate permissions.
- Follow the original brief's ZIP, README and Amathuba submission requirements.
  No script in this project submits the assignment automatically.
