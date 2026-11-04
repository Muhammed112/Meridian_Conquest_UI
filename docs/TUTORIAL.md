# Tutorial coverage

The interactive tutorial covers the 26 numbered sections in the supplied
`Instructions.txt`. An adviser welcomes the commander and types the explanations,
rules and examples into a dialogue above the map. One practice task appears at a
time; a pointing hand identifies its control and brings it into view when needed.

| Item | Instruction                                                                                           | Tutorial lesson                                                   |
| ---- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1    | Control all ten countries against nine opponents                                                      | Welcome, Commander                                                |
| 2    | Sign in, choose a country, random rivals and population-based starting armies                         | Welcome, Commander, including its examples                        |
| 3    | Read every country's ownership and current soldier count                                              | Meet your battlefield                                             |
| 4    | Turns, complete rounds and a random first commander                                                   | Build your next move, expanded explanation; Pass command          |
| 5    | Round one has no reinforcements; attack with two soldiers or skip                                     | Build your next move; Pick your moment; Pass command              |
| 6    | Two reinforcements per owned country from round two                                                   | Build your next move                                              |
| 7    | Allocate or split reinforcements, including the 4 + 2 example                                         | Build your next move, expanded explanation; Know when to stop     |
| 8    | Transfer between owned countries, leave one behind and avoid transfers during battle                  | Secure what you captured                                          |
| 9    | Attack from an owned country with at least two soldiers                                               | Pick your moment                                                  |
| 10   | Any enemy can be targeted regardless of distance; prefer a weaker first target                        | Pick your moment                                                  |
| 11   | One target per turn, with repeated rolls in the same attack                                           | Pick your moment; Keep the pressure on                            |
| 12   | Each die represents a soldier, rolls from 1 to 6, and cannot guarantee victory                        | Let the dice decide                                               |
| 13   | Use the smaller fighting force, including the 3-versus-5 example                                      | Let the dice decide, expanded explanation                         |
| 14   | Compare matching pairs individually, never add their totals                                           | Let the dice decide; Two pairs. Two outcomes                      |
| 15   | Equal dice cause no loss; other pairs resolve normally                                                | Let the dice decide, visual and expanded explanation              |
| 16   | The exact 10-versus-2 example: 1 and 4 against 2 and 3, leaving 9 against 1                           | Played in the opening practice battle; Two pairs. Two outcomes    |
| 17   | Recalculate the number of pairs when continuing an attack                                             | Keep the pressure on; the next practice roll has one pair         |
| 18   | A failed attack leaves the attacker its own country and final soldier                                 | Two pairs. Two outcomes, expanded explanation; Know when to stop  |
| 19   | Stopping ends the turn, preserves remaining troops and does not restore losses                        | Practised in Know when to stop                                    |
| 20   | Defeat the last defender to capture; no second target that turn                                       | Practised in A new foothold                                       |
| 21   | Immediate capture bonus, minimum two, rounding and examples of original strengths 9 and 1             | A new foothold, including its expanded explanation                |
| 22   | Choose how many soldiers to transfer into a captured country and check the resulting counts           | Practised in Secure what you captured                             |
| 23   | The new country supplies reinforcements and can attack next turn; still one attack per turn           | Secure what you captured, expanded explanation; Know when to stop |
| 24   | Optional attacks, skipping and waiting for later reinforcements                                       | Pass command                                                      |
| 25   | Bots reinforce, transfer, attack or stop; decisions and battles remain visible in fast forward        | Read your opponents                                               |
| 26   | Survive while owning any country; elimination removes future turns and reinforcements; own ten to win | A new foothold, expanded explanation; Welcome, Commander          |

The existing game automatically garrisons a captured country with one earned
soldier. The transfer lesson explains that the player chooses how many additional
soldiers to move there, preserving the application's current capture rules.

After transferring soldiers, the learner uses the real Diplomacy panel to offer
an NPC a three-round pact. A second lesson explains the accepted pact, trust,
expiry and betrayal, while preserving separate armies, normal turns and the
single-commander victory condition. The tutorial does not require betrayal.

The tutorial also teaches the Field reports and AI commentary tabs, pinning,
settings, nicknames, saving, replay and sharing. Multiplayer room codes are
explained at completion without requiring a pretend room-code exercise.

The practice board remains separate from campaign storage, multiplayer rooms and
Gemini requests. Guided dice and battle animations use the normal game engine and
animation preference. Dialogue and pointer motion respect reduced-motion settings.
Recorded losses and rewards remain hidden until the normal dice clock settles.

Run `node scripts/tutorial-browser-test.mjs` to check the complete desktop and
mobile flow with fake accounts, plus reduced motion and save isolation. Ordinary
unit checks verify instruction coverage and the supplied battle example.
