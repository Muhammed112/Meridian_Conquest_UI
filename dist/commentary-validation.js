/** Copy event-time verification anchors; an unknown phase loss is explicitly -1. */
export function commentaryFacts(context) {
  const event = context.event;
  return {
    eventType: event.type,
    from: event.from || context.match?.battle?.from || '',
    to: event.to || context.match?.battle?.to || '',
    attackerLoss: Number.isInteger(event.attackerLoss) ? event.attackerLoss : -1,
    defenderLoss: Number.isInteger(event.defenderLoss) ? event.defenderLoss : -1,
  };
}

const numberWords = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
];
const countPattern = '(\\d+|' + numberWords.join('|') + ')';
const readCount = (value) =>
  /^\d+$/.test(value) ? Number(value) : numberWords.indexOf(value.toLowerCase());
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Exclude recorded nicknames from wording checks, including names outside the current battle. */
function narrationProse(text, match) {
  const names = [
    match?.battle?.attacker?.name,
    match?.battle?.defender?.name,
    ...(match?.standings || []).map((commander) => commander.name),
  ];
  // Replace longer names first so one player's name cannot partially mask another's name.
  return [...new Set(names.filter(Boolean))]
    .sort((left, right) => right.length - left.length)
    .reduce((prose, name) => prose.replaceAll(name, 'Commander'), text);
}

/** Check explicit claims against facts. Unrestricted prose still needs human quality evaluation. */
export function commentaryIssues(text, context, facts) {
  const expected = commentaryFacts(context);
  const issues = [];
  if (!facts || Object.entries(expected).some(([key, value]) => facts[key] !== value))
    issues.push('The verification facts do not match the recorded event.');
  // Legal player names may contain words or punctuation that are unusual in narration.
  const prose = narrationProse(text, context.match);
  if (/\b(?:you|your|yours|yourself)\b/i.test(prose))
    issues.push('The report addresses the viewer instead of the match.');
  if (/<\/?[a-z][^>]*>/i.test(prose))
    issues.push('The report contains markup instead of plain prose.');
  if (
    /\b(?:soccer|football|goalkeepers?|strikers?|offside|touchline|referee|scoreboard|on the pitch|kick[- ]?off|half[- ]?time|penalty kick|scores? a goal)\b/i.test(
      prose,
    )
  )
    issues.push('The report introduces sports imagery outside the recorded strategy game.');
  if (
    expected.eventType !== 'victory' &&
    /\b(?:victory|wins? the (?:game|match)|world conqueror)\b/i.test(prose)
  )
    issues.push('The report announces victory before its recorded event.');
  if (
    !['conquest', 'elimination', 'victory'].includes(expected.eventType) &&
    /\b(?:has conquered|has captured|conquers|captures|is conquered|was conquered|is captured|was captured|has seized)\b/i.test(
      prose,
    )
  )
    issues.push('The report announces a conquest before its recorded event.');
  if (
    !['elimination', 'victory'].includes(expected.eventType) &&
    /\b(?:has been eliminated|is eliminated|was eliminated|eliminates)\b/i.test(prose)
  )
    issues.push('The report announces elimination before its recorded event.');
  if (expected.eventType !== 'dice') return issues;
  if (/\b(?:conquer\w*|captur\w*|eliminat\w*|victory|retreat\w*|counterattack\w*)\b/i.test(prose))
    issues.push('A dice exchange announces an outcome or action that has not happened.');
  // Explicit numbers and comparative claims are checked independently of the copied anchors.
  const countryName = (code) => context.countries?.find((country) => country.code === code)?.name;
  for (const side of ['attacker', 'defender']) {
    const loss = expected[side + 'Loss'];
    if (loss < 0) continue;
    const otherLoss = expected[(side === 'attacker' ? 'defender' : 'attacker') + 'Loss'];
    const country = countryName(expected[side === 'attacker' ? 'from' : 'to']);
    const subjects = [country, side, context.match?.battle?.[side]?.name].filter(Boolean);
    for (const subject of subjects) {
      const prefix = '\\b' + escapePattern(subject) + '\\s+';
      const casualty = new RegExp(
        prefix +
          '(?:loses?|lost|suffers?|suffered|takes?|took|sustains?|sustained)\\s+' +
          '(?:(?:exactly|only|another)\\s+)?' +
          countPattern +
          '\\s+(?:soldiers?|troops?|casualt(?:y|ies)|losses?)',
        'ig',
      );
      for (const match of text.matchAll(casualty))
        if (readCount(match[1]) !== loss) issues.push('An explicit casualty count is incorrect.');
      const more =
        '(?:suffers?|takes?|absorbs?)\\s+(?:the\\s+)?(?:heavier|greater|more)\\s+(?:losses|casualties)';
      if (new RegExp(prefix + more, 'i').test(text) && loss <= otherLoss)
        issues.push('The report reverses the balance of losses.');
      if (
        new RegExp(prefix + '(?:takes?|suffers?)\\s+no\\s+(?:losses|casualties)', 'i').test(text) &&
        loss !== 0
      )
        issues.push('A participant with recorded casualties is described as unharmed.');
    }
  }
  const both = new RegExp(
    'both\\s+(?:sides|countries|armies)\\s+(?:lose|lost|suffer)\\s+' +
      countPattern +
      '\\s+(?:soldiers?|troops?|casualt(?:y|ies))',
    'i',
  ).exec(text);
  if (
    both &&
    (readCount(both[1]) !== expected.attackerLoss || readCount(both[1]) !== expected.defenderLoss)
  )
    issues.push('The report gives both participants an incorrect shared loss count.');
  if (
    /\b(?:neither side loses|both sides emerge unscathed|bloodless exchange|no soldiers (?:are |were )?lost)\b/i.test(
      text,
    ) &&
    expected.attackerLoss + expected.defenderLoss > 0
  )
    issues.push('An exchange with casualties is described as bloodless.');
  return [...new Set(issues)];
}
