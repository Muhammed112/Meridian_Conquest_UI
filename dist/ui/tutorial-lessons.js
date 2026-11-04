// Rule references match the numbered sections in the supplied Instructions.txt.
// The adviser introduces each rule and example alongside one clear practice task.
// The covers arrays map lessons to brief requirements; they do not grant gameplay permissions.
export const tutorialLessons = {
  welcome: {
    title: 'Welcome, Commander.',
    summary: 'One world. Ten countries. Bring every country under your command to win.',
    task: 'Start the practice mission when you are ready.',
    next: 'Start practising',
    notes: [
      'You begin with one country against nine computer-controlled opponents, each with one country.',
    ],
    details: [
      'Sign in, choose a starting country and difficulty, and the game randomly' +
        ' selects nine other countries for your rivals.',
      'Population determines each starting army: 1 to 9 soldiers. Armies can grow' +
        ' beyond nine during play. This guided practice uses preset armies and' +
        ' starts in round two.',
    ],
    covers: [1, 2],
  },
  map: {
    title: 'Meet your battlefield.',
    summary: 'The map and roster show who owns every country and how many soldiers are there.',
    task: 'Select South Africa on the map or in the world roster.',
    notes: [
      'Colours and P# identify commanders. Everyone’s current soldier counts' +
        ' remain visible throughout the game.',
    ],
    covers: [3],
  },
  reinforce: {
    title: 'Build your next move.',
    summary:
      'From round two, each country you own supplies two reinforcements at the start of your turn.',
    task: 'Use + to assign both soldiers to South Africa, then confirm. Auto deploy works too.',
    notes: [
      'Deploy the entire budget before attacking or transferring. In round one,' +
        ' you use only your starting soldiers.',
    ],
    details: [
      'A turn is one player’s chance to act. A round finishes after every' +
        ' surviving player has taken one turn. The first player is chosen randomly,' +
        ' so you may watch opponents before your first move.',
      'Own 1 country → receive 2 soldiers. Own 3 → receive 6. Put them all in one' +
        ' country or split them between your countries: for example, 4 in one and 2' +
        ' in another.',
    ],
    covers: [4, 5, 6, 7],
  },
  attack: {
    title: 'Pick your moment.',
    summary:
      'Choose your attacking country and any enemy target. Distance and borders do' +
      ' not limit your reach.',
    task: 'Choose a target on the map or in Target country, then select Launch attack.',
    notes: [
      'You need at least 2 soldiers to attack. Leave 1 behind: a country with 5' +
        ' has 4 available to fight.',
      'You get one attack against one target per turn. A weaker target is a sensible first battle.',
    ],
    details: [
      'A country with only one soldier cannot attack. You can roll several times' +
        ' against your chosen target, but cannot switch targets or launch another' +
        ' attack that turn.',
    ],
    covers: [9, 10, 11],
  },
  dice: {
    title: 'Let the dice decide.',
    summary:
      'Each matching pair is a separate fight. Compare the dice individually,' +
      ' never add their totals.',
    task: 'Select Roll the dice to play the opening exchange.',
    notes: [
      'Each die represents one fighting soldier and rolls from 1 to 6. More' +
        ' soldiers improve your options, but do not guarantee victory.',
      'Both sides roll the smaller of your available attackers and the defender’s soldiers.',
    ],
    details: [
      'With 3 soldiers against 5, you leave 1 behind, so both sides roll 2 dice.',
      'Your first die fights their first die, your second fights their second, and' +
        ' so on. A 5 against a 2 defeats one defender. A 4 against a 4 costs neither' +
        ' side a soldier; other pairs still resolve normally.',
      'Practice rolls are guided examples. Real battles use random dice.',
    ],
    covers: [12, 13, 14, 15],
  },
  losses: {
    title: 'Two pairs. Two outcomes.',
    summary:
      'You started with 10 soldiers against 2 defenders. One soldier fell on each' +
      ' side: now it is 9 against 1.',
    task: 'Compare the paired dice and phase summary, then continue the lesson.',
    next: 'Continue the lesson',
    notes: [
      'Your 1 lost to their 2. Your 4 beat their 3. Each losing pair cost exactly one soldier.',
    ],
    details: [
      'If your attacking force falls to 1 soldier, the attack stops automatically.' +
        ' You keep your own country and its last soldier. The defender keeps the' +
        ' target and its remaining soldiers; a failed attack does not give them your' +
        ' country.',
    ],
    covers: [16, 18],
  },
  conquer: {
    title: 'Keep the pressure on.',
    summary:
      'The defender now has one soldier, so each side rolls only one die in the next exchange.',
    task: 'Select Roll next phase to continue this same attack.',
    notes: [
      'The number of pairs is recalculated after every exchange. Continue while' +
        ' you have at least 2 soldiers and the defender still has soldiers.',
      'Rolling again continues your one attack; it does not give you another target this turn.',
    ],
    covers: [17],
  },
  conquest: {
    title: 'A new foothold.',
    summary:
      'The last defender has fallen. The country changes to your colour and you' +
      ' earn a capture bonus immediately.',
    task: 'Check your new territory, then practise moving soldiers into it.',
    next: 'Practise transferring',
    notes: [
      'The bonus is half the captured country’s original starting strength,' +
        ' rounded down, with a minimum of 2.',
      'You have used this turn’s attack. One earned soldier garrisons the new' +
        ' country; you can transfer more into it.',
    ],
    details: [
      'Original strength 9 → bonus 4. Original strength 1 → bonus 2. This' +
        ' immediate bonus is separate from your regular start-of-turn' +
        ' reinforcements.',
      'Losing your starting country does not eliminate you while you still own' +
        ' another. Only losing every country eliminates a commander: they receive no' +
        ' more reinforcements or turns. Own all 10 to win.',
    ],
    covers: [20, 21, 26],
  },
  transfer: {
    title: 'Secure what you captured.',
    summary:
      'Transfers move your existing soldiers between countries you own. They' +
      ' create no extra soldiers.',
    task: 'Select Transfer soldiers, choose a source, destination and amount, then confirm.',
    notes: [
      'Keep at least 1 soldier in the source country. Check the resulting counts' +
        ' to judge each country’s defence.',
      'You need at least two owned countries and cannot transfer during an attack.',
    ],
    details: [
      'After a capture, choose how many more soldiers to move into the new' +
        ' country. On your next turn it contributes reinforcements and can launch an' +
        ' attack if it has at least 2 soldiers. You still get just one attack per' +
        ' turn, however many countries you own.',
    ],
    covers: [8, 22, 23],
  },
  diplomacy: {
    title: 'A temporary ally.',
    summary:
      'Diplomacy lets commanders agree to cooperate for three rounds. The pact' +
      ' covers every country each ally owns.',
    task: 'Open Diplomacy, choose an available rival commander, then select Offer three-round pact.',
    notes: [
      'An NPC weighs your military support, common threats and trust before' +
        ' accepting. Your practice rivals have enough reason to cooperate.',
      'Each commander can have one ally and propose one pact per turn. Deploy' +
        ' all reinforcements and finish any battle before making an offer.',
    ],
    details: [
      'For example, two commanders with two countries each can cooperate' +
        ' against a rival who controls four. They still take separate turns' +
        ' and choose their own attacks.',
      'A pact does not combine armies, change dice or grant an extra attack.' +
        ' Soldiers still transfer only between countries belonging to the same commander.',
    ],
    covers: [],
  },
  'diplomacy-result': {
    title: 'Your pact is agreed.',
    summary:
      'Your ally accepted. The Diplomacy panel now shows your ally, three rounds' +
      ' remaining and the trust between your commanders.',
    task: 'Check the accepted pact in Diplomacy, then continue to end your turn.',
    next: 'Continue the lesson',
    notes: [
      'The pact expires after three rounds. An ally being eliminated, or only' +
        ' the two allies remaining, also ends it. One commander must still' +
        ' control all ten countries to win.',
      'Allied countries remain attackable. Attacking your ally breaks the pact' +
        ' and lowers their trust, making future agreements harder.',
    ],
    details: [
      'NPC allies generally avoid attacking you, but can betray an ally who' +
        ' controls most of the board and threatens to win. Watch their decisions' +
        ' in Field reports.',
      'This practice offer changed only diplomacy. Both commanders kept their' +
        ' armies, countries and normal reinforcements; your earlier attack' +
        ' still used this turn’s single attack.',
    ],
    covers: [],
  },
  end: {
    title: 'Pass command.',
    summary: 'Attacking is optional. End your turn when you are happy with your position.',
    task: 'Select End turn or Skip turn to let the next commander act.',
    notes: [
      'Deploy all reinforcements before skipping. Waiting can preserve soldiers' +
        ' until you receive more on a later turn.',
      'A round completes when every surviving commander has taken a turn.' +
        ' Eliminated commanders are skipped.',
    ],
    covers: [24],
  },
  bots: {
    title: 'Read your opponents.',
    summary:
      'Bots reinforce, transfer and decide whether to attack, continue or stop, just as players do.',
    task: 'Read the bot’s deployment decision, then continue to your next practice turn.',
    next: 'Continue to your next turn',
    notes: [
      'Real games pause for five seconds before each bot decision takes effect.' +
        ' Fast forward shortens these pauses in single-player; moves and battles' +
        ' still appear.',
    ],
    details: [
      'Watch the short decision explanations and Field reports to follow' +
        ' opponents. For this practice, the remaining bots deploy and pass so you' +
        ' can try another turn at your own pace.',
    ],
    covers: [25],
  },
  retreat: {
    title: 'Know when to stop.',
    summary:
      'Your two countries now supply four reinforcements. You can split them and' +
      ' attack from either country with at least 2 soldiers.',
    task: 'Deploy all four soldiers, attack a non-allied rival, then select Stop attack & end turn.',
    notes: [
      'Stopping immediately ends your turn. Both sides keep their remaining' +
        ' soldiers and the defender keeps the target.',
      'Soldiers already lost do not return. If an attack instead fails at 1' +
        ' soldier, your own country stays yours.',
    ],
    covers: [19],
  },
  reports: {
    title: 'Follow the whole match.',
    summary:
      'Field reports record decisions, rolls and losses. AI commentary adds' +
      ' play-by-play for the whole game.',
    task: 'Open the AI commentary tab to see the labelled tutorial example.',
    notes: [
      'Live Gemini commentary runs when enabled in Settings. It can arrive later;' +
        ' gameplay continues independently.',
      'Pin reports to keep them visible. The arrow collapses the panel and Unpin' +
        ' returns it below the map.',
    ],
    covers: [],
  },
  settings: {
    title: 'Make it comfortable.',
    summary:
      'Adjust your nickname, music, sound effects, animations and AI commentary in Settings.',
    task: 'Open the Settings gear, then close it to continue.',
    notes: [
      'Your nickname carries into new multiplayer rooms. Reduced motion removes' +
        ' movement and tumbling, while preserving reading pauses.',
    ],
    covers: [],
  },
  complete: {
    title: 'Ready for your own campaign.',
    summary:
      'You have reinforced, fought, captured, transferred, made an alliance and stopped an attack.' +
      ' Your next command is yours.',
    task: 'Create a real campaign or return to the war room.',
    notes: [
      'To play with friends, create a multiplayer room and share its six-character' +
        ' code, or join with a friend’s code. Everyone sees the same board and takes their own turn.',
      'The host starts once friends have joined. Bots fill any remaining seats' +
        ' up to ten; keep the host’s room open for bot turns.',
      'Campaigns save to your signed-in account. My campaigns lets you resume,' +
        ' replay events or share a viewing-only snapshot.',
    ],
    covers: [],
  },
};
