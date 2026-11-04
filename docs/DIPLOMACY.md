# Temporary NPC alliances

After deploying reinforcements, select **Diplomacy** beneath **Launch attack**.
The existing action card switches to diplomacy. **Battle planning** returns to
the attack controls. Negotiation is also available after a battle finishes.

Choose a surviving NPC commander and offer a three-round pact. Each commander
can have one ally, and can make one offer per turn. NPCs consider military
support, common threats and their trust in the proposer. A refusal records its
reason; it does not use the attack allowance.

A pact applies to all countries belonging to either commander, including later
conquests. Both commanders keep their own soldiers, reinforcements and turns.
Transfers remain limited to one commander's countries. Each turn still permits
one attack, using the existing dice, casualty and conquest-reward rules.

Allied countries remain selectable targets. A warning identifies an attack that
will break a pact. Launching it ends the alliance immediately and lowers the
betrayed commander's trust. NPCs normally avoid their ally, but may betray an
ally whose expansion threatens to win the game; the decision records its reason.

The panel shows the ally, remaining rounds, expiry round and their trust in you.
A pact made in round 4 expires at the start of round 7. It also ends if an ally
is eliminated or only the allied commanders remain. Victory still requires one
commander to own all ten countries.

In multiplayer, human players may negotiate with NPCs on their own turns.
Human-to-human proposals are outside this version. Room permissions, turn
ownership and revision checks still apply.

## Saves and recorded facts

Diplomacy uses bounded snapshots attached to new factual events. This preserves
old saves, provides event-time commentary, and retains trust when a multiplayer
room trims its recent history. Existing reports are never rewritten.

The board schema and Firebase permissions are unchanged. Public spectators may
read the recorded facts but cannot negotiate or play turns. No extra AI request
is needed for an NPC to evaluate an offer; its strategy runs with the game rules.
