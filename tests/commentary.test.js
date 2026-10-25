import test from 'node:test';
import assert from 'node:assert/strict';
import {GameEngine} from '../dist/engine.js';
import {parseContext,cleanCommentary,narratedTypes} from '../functions/commentary.js';

test('commentary context preserves actual dice losses and immutable board facts',()=>{
  const game=GameEngine.create('Commentary fixture','ZA',true);
  const engine=new GameEngine(game);game.position=game.order.indexOf(0);game.budget=0;game.battle=null;game.attackUsed=false;
  const attacker=game.countries[0],defender=game.countries.find(c=>c.owner!==0);attacker.army=5;defender.army=3;
  engine.startAttack(attacker.code,defender.code);
  const before=structuredClone(game.countries.map(c=>({code:c.code,owner:c.owner,army:c.army})));
  let n=0;engine.roll(()=>++n%2?6:1);
  const event=game.events.findLast(e=>e.type==='dice');
  const context=parseContext(JSON.stringify({event,previousBoard:before}));
  assert.equal(context.event.attackerLoss,0);assert.equal(context.event.defenderLoss,3);
  assert.equal(context.event.board.find(c=>c.code===defender.code).army,0);
  assert.equal(context.previousBoard.find(c=>c.code===defender.code).army,3);
  assert.equal(game.events.findLast(e=>e.type==='conquest').country,defender.code);
});
test('invalid, oversized and non-narrated events cannot become LLM requests',()=>{
  for(const raw of ['bad JSON','{}',JSON.stringify({event:{type:'turn',text:'turn'}}),'x'.repeat(60001)])assert.throws(()=>parseContext(raw));
  assert.equal(narratedTypes.has('decision'),true);
});
test('empty responses fall back and commentary stays short and plain text',()=>{
  assert.throws(()=>cleanCommentary('  '));
  assert.throws(()=>cleanCommentary(undefined));
  assert.equal(cleanCommentary('  Brazil\n holds.  '),'Brazil holds.');
  assert.equal(cleanCommentary(Array(80).fill('word').join(' ')).split(' ').length,35);
});
