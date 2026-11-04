# Application architecture

Meridian Conquest uses browser ES modules and Firebase. Maintained frontend source
lives in `dist`; the name does not imply a generated or minified build. Views,
controllers, domain rules and persistence have explicit boundaries. A framework
or inheritance hierarchy is unnecessary for these responsibilities.

```mermaid
flowchart LR
  Input[Player and keyboard actions] --> Controllers[Controllers]
  Controllers --> Engine[GameEngine and BattleEngine]
  Engine --> Facts[Board and immutable events]
  Facts --> Views[Shared single-player and multiplayer views]
  Views --> Presentation[Map, motion and sound]
  Controllers --> Store[CampaignStore or room transactions]
  Store --> Firestore[(Cloud Firestore)]
  Auth[Firebase Authentication] --> Store
  Facts --> Queue[CommentaryQueue]
  Queue --> Gemini[Firebase AI Logic / Gemini]
  Gemini --> Checks[Format and factual-claim checks]
  Checks --> Reports[Separate saved AI reports]
  Reports --> Views
  Store --> Public[Explicit public spectator copy]
```

## Responsibilities

| Module                         | Owns                                                 | Boundary                                                  |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| `app.js`                       | Composition, route selection and rendering           | Reads current services through context getters            |
| `controllers/campaigns.js`     | Selected-history loading and recovery reconciliation | Never combines competing histories silently               |
| `controllers/settings.js`      | Nickname edits, preferences and status controls      | Reads the current account when an action runs             |
| `controllers/events.js`        | DOM event dispatch                                   | Routes moves to the game or room service                  |
| `controllers/npcs.js`          | Bot playback and reading pauses                      | Cancels when the route, campaign or permissions change    |
| `engine.js`                    | Legal moves, combat, rewards, turns and victory      | Does not depend on Firebase or the DOM                    |
| `npc-strategy.js`              | Deterministic board evaluation                       | Plans without changing the board or dice                  |
| `campaign-store.js`            | Board summaries, lazy history and versioned saves    | Owns private session, record and history state            |
| `rooms.js` and `room-setup.js` | Multiplayer transactions and opening rolls           | Membership and revision checks precede updates            |
| `game-schema.js`               | Storage codecs and validation                        | Supports existing records without rewriting them on reads |
| `commentary.js`                | Bounded queue, priorities, caching and Gemini setup  | Narration cannot change game rules                        |
| `commentary-validation.js`     | Verification anchors and explicit claim checks       | Rejects detected contradictions before persistence        |
| `ui/`                          | Escaped markup, focus restoration and layout         | Uses presentation copies during dice reveals              |

`GameEngine`, `BattleEngine`, `NpcStrategy`, `CampaignStore`, `CommentaryQueue`,
`MotionDirector` and `SoundDirector` encapsulate coherent responsibilities.
Campaign storage and queue bookkeeping use private class fields. Queue observers
receive copies of collections; they cannot clear pending requests or change
deduplication state. The engine retains its existing board getter for compatible
rendering and serialization. Gameplay controllers invoke engine methods rather
than duplicating battle calculations.

## Interaction and failure handling

Campaign cards require board summaries only. Opening a game or replay loads that
campaign's event history in pages of at most 250 documents. A failed history has
its own retry screen, while other games and new campaigns remain usable.
Complete browser recovery caches are preserved independently of partial lists.

A second device cannot silently overwrite a versioned save. Conflicts stop cloud
writes for that campaign, keep the current local recovery data and offer an
explicit reload. Loading a competing history first preserves the local branch in
a separate browser recovery entry. These copies remain on that browser; clearing
site storage removes them.

Before replacing the board markup, rendering captures the active control's
identity and text selection. It restores the equivalent usable control without
scrolling. When a completed action replaces its controls, focus moves to the new
action heading. Tutorial step focus and open dialogs retain precedence.

## AI preparation and correctness

Entering a private campaign or hosted multiplayer match prepares the model,
App Check attestation and cached authentication token when commentary is enabled.
Preparation makes no Gemini generation request. It reduces setup work on the
first report; provider response time and quotas still apply.

Requests include event-time facts and verification anchors. Responses must copy
those anchors exactly. Additional checks detect several explicit casualty-count
errors, reversed loss comparisons, premature outcomes, sports imagery and viewer-directed
wording. Recorded nicknames are excluded from wording checks. A detected contradiction is not saved as AI commentary. These checks
cannot establish the truth of every possible natural-language sentence. Human
review of live reports remains part of quality evaluation.

## Trust and cost boundary

Firebase remains on Spark. Authentication and rules enforce storage ownership,
membership and permitted transitions. Multiplayer rules additionally constrain
troop totals, captures, reinforcement destinations and spending, two-country
transfers, round advancement and attack resets. Dice and full combat calculations
are checked by the browser engine rather than an authoritative server.
Free-form AI text is not independently authoritative. Complete competitive
anti-cheat requires a trusted game service; this implementation does not claim it.

See [database design](DATABASE.md), [assessment evidence](ASSESSMENT.md) and
[contributor guidance](../CONTRIBUTING.md) for schema and verification details.
