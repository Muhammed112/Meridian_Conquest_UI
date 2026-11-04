import { chromium } from './lib/browser.mjs';
// Preview the current narrator on recorded game fixtures. Uses the private
// localhost App Check setup and one temporary account, then removes the account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { firebaseConfig as config } from '../dist/firebase-config.js';
import { aiConfig } from '../dist/ai-config.js';
import { GameEngine } from '../dist/engine.js';
import { commentaryContext, parseCommentaryBatch } from '../dist/commentary.js';

/** Make bounded fixture/auth requests without logging their tokens or request bodies. */
async function json(url, body, headers = {}) {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(100000),
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(response.status + ': ' + (data.error?.message || 'Request failed'));
  return data;
}
const auth = (method, body) =>
  json(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${config.apiKey}`, body);
/** Build a recorded battle with known losses so narration can be checked against facts. */
function pressureFixture(player) {
  const battle = GameEngine.create('Narration fixture', 'ZA', true),
    engine = new GameEngine(battle),
    attacker = battle.countries[player],
    defender = battle.countries[player + 1];
  battle.round = 1;
  battle.position = battle.order.indexOf(player);
  battle.budget = 0;
  battle.events = [];
  attacker.army = 6;
  defender.army = 5;
  engine.event('turn', 'A new turn.');
  engine.startAttack(attacker.code, defender.code);
  const rolls = [1, 6, 6, 1, 6, 1, 3, 3, 3, 3];
  engine.roll(() => rolls.shift());
  return { battle, engine, event: battle.events.at(-1) };
}
/** Exercise recorded outcomes independently so later victory facts cannot leak into earlier reports. */
function outcomeFixture(type) {
  const game = GameEngine.create('Outcome fixture', 'ZA', true);
  Object.assign(game, {
    round: 1,
    position: game.order.indexOf(1),
    budget: 0,
    events: [],
    battle: null,
    attackUsed: false,
  });
  if (type === 'victory')
    game.countries.forEach((country, index) => {
      country.owner = index === 2 ? 2 : 1;
    });
  const attacker = game.countries[1],
    defender = game.countries[2],
    engine = new GameEngine(game);
  attacker.army = type === 'held' ? 2 : 6;
  defender.army = 1;
  engine.event('turn', 'A new turn.');
  engine.startAttack(attacker.code, defender.code);
  if (type === 'retreat') engine.stopAttack();
  else {
    let roll = 0;
    engine.roll(() => (++roll % 2 ? (type === 'held' ? 1 : 6) : type === 'held' ? 6 : 1));
  }
  const event = game.events.findLast((item) => item.type === type);
  assert.ok(event, 'The engine must record the requested outcome.');
  return { eventId: event.id, context: commentaryContext(game, event) };
}
let user, browser;
try {
  const credentials = {
    email: `meridian-preview-${randomUUID()}@example.invalid`,
    password: randomUUID() + 'Aa1!',
    returnSecureToken: true,
  };
  user = await auth('signUp', credentials);
  // Include both sides of a match and recorded outcomes so quality checks do not favour the human seat.
  const { battle, engine, event: pressure } = pressureFixture(0);
  const tasks = [{ eventId: pressure.id, context: commentaryContext(battle, pressure) }];
  engine.roll(() => 3);
  battle.events.at(-1).commentary = 'No losses this time. Both armies come through intact.';
  engine.roll(() => 3);
  tasks.push({
    eventId: battle.events.at(-1).id,
    context: commentaryContext(battle, battle.events.at(-1)),
  });
  const bot = pressureFixture(1);
  tasks.push({ eventId: bot.event.id, context: commentaryContext(bot.battle, bot.event) });
  const lead = GameEngine.create('Territorial tie fixture', 'ZA', true),
    leader = new GameEngine(lead);
  lead.round = 1;
  lead.position = lead.order.indexOf(1);
  lead.budget = 0;
  lead.events = [];
  lead.countries.forEach((country, index) => {
    country.owner = index < 2 ? 0 : index < 5 ? 1 : index < 8 ? 2 : index - 5;
  });
  lead.countries[2].army = 6;
  lead.countries[5].army = 1;
  leader.event('turn', 'Three countries each for the two leaders.');
  leader.startAttack(lead.countries[2].code, lead.countries[5].code);
  let n = 0;
  leader.roll(() => (++n % 2 ? 6 : 1));
  const capture = lead.events.findLast((event) => event.type === 'conquest');
  tasks.push({ eventId: capture.id, context: commentaryContext(lead, capture) });
  for (const type of ['retreat', 'held', 'elimination', 'victory'])
    tasks.push(outcomeFixture(type));
  browser = await chromium.launch({
    headless: true,
  });
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  const origin = process.env.COMMENTARY_PREVIEW_ORIGIN || 'http://localhost:8081';
  await page.goto(origin + '/#signin');
  await page.waitForFunction(() => {
    const button = document.querySelector('#auth-form button[type="submit"]');
    return button && !button.disabled;
  });
  await page.locator('#email').fill(credentials.email);
  await page.locator('#password').fill(credentials.password);
  await page.locator('#auth-form button[type="submit"]').click();
  await page.waitForURL(/#(?:campaigns|tutorial)/);
  page.on('response', async (response) => {
    if (response.url().includes('firebasevertexai.googleapis.com') && response.status() >= 400) {
      const data = await response.json().catch(() => ({}));
      console.log('Model request status:', response.status(), data.error?.message);
    }
  });
  const selectedModel = process.env.COMMENTARY_PREVIEW_MODEL || aiConfig.model;
  const start = Date.now();
  console.log(
    'Requesting ' + selectedModel + ' on human/bot combat, stalemate and recorded outcomes.',
  );
  const raw = await page.evaluate(
    async ({ tasks, selectedModel }) => {
      const [{ getApp }, { createGeminiGenerator }, { aiConfig }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
        import('./commentary.js?v=match-commentary-20261026-1'),
        import('./ai-config.js'),
      ]);
      const generate = createGeminiGenerator({
        app: getApp(),
        base: 'https://www.gstatic.com/firebasejs/13.0.0/',
        settings: { ...aiConfig, model: selectedModel },
      });
      const responses = [];
      for (let index = 0; index < tasks.length; index += 6)
        responses.push(await generate(tasks.slice(index, index + 6)));
      return responses;
    },
    { tasks, selectedModel },
  );
  // Run actual responses through the application's factual gate, not just the provider's JSON parser.
  const reports = new Map(
    raw.flatMap((response, index) => [
      ...parseCommentaryBatch(response, tasks.slice(index * 6, index * 6 + 6)),
    ]),
  );
  assert.equal(reports.size, tasks.length);
  const labels = [
    'Human pressure',
    'Stalemate',
    'Bot pressure',
    'Bot lead change',
    'Retreat',
    'Defence holds',
    'Elimination',
    'Victory',
  ];
  // Check whole-match perspective and premature outcome claims against each event's original facts.
  for (const [index, task] of tasks.entries()) {
    const text = reports.get(task.eventId);
    console.log(labels[index] + ': ' + text);
    assert.doesNotMatch(
      text,
      /\b(?:you|your|yours|yourself)\b/i,
      'Narration must address the whole match',
    );
    if (task.context.event.type === 'dice')
      assert.doesNotMatch(
        text,
        /\b(?:retreat\w*|counterattack\w*|counter-attack\w*|strik\w* back|conquer\w*|captur\w*|eliminat\w*|victory)\b/i,
        'Dice exchanges must not invent another action or confirm a later outcome',
      );
  }
  for (const task of tasks.slice(2))
    assert.doesNotMatch(
      reports.get(task.eventId),
      /\bCommander 1\b/i,
      'Bot battle reports must not focus on an unrelated human commander',
    );
  console.log('PASS: real Gemini uses third-person match commentary for human and bot action.');
  console.log('Model response: ' + ((Date.now() - start) / 1000).toFixed(1) + 's');
} finally {
  await browser?.close();
  if (user) {
    await auth('delete', { idToken: user.idToken });
    console.log('Temporary preview account removed; no campaigns were written.');
  }
}
