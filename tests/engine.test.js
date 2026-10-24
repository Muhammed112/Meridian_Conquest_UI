import test from 'node:test';
import assert from 'node:assert/strict';
import {GameEngine,BattleEngine,createRecordId} from '../dist/engine.js';
import {armyValue} from '../dist/data.js';

test('campaign and event IDs remain valid when an HTTP preview lacks randomUUID',()=>{
  let next=0;
  const source={getRandomValues(bytes){bytes.fill(0);bytes[0]=++next;return bytes;}};
  const first=createRecordId(source),second=createRecordId(source);
  assert.match(first,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first,second);
});

test('population bands include their upper bounds',()=>{assert.equal(armyValue(5),1);assert.equal(armyValue(5.01),2);assert.equal(armyValue(150),8);assert.equal(armyValue(150.01),9);});
test('paired dice preserve roll order and ties cause no loss',()=>{const values=[1,2,4,3,5,5];const result=BattleEngine.resolve(4,5,()=>values.shift());assert.deepEqual(result.pairs.map(p=>[p.a,p.d]),[[1,2],[4,3],[5,5]]);assert.equal(result.attackerLoss,1);assert.equal(result.defenderLoss,1);});
test('one soldier is always reserved in the attacking country',()=>{const result=BattleEngine.resolve(2,5,()=>3);assert.equal(result.pairs.length,1);assert.throws(()=>BattleEngine.resolve(1,5));});
test('first round grants no reinforcements and later rounds grant two per country',()=>{const g=GameEngine.create('Test','ZA');assert.equal(g.budget,0);g.round=2;g.position=g.order.indexOf(0);g.turnStarted=false;const e=new GameEngine(g);e.beginTurn();assert.equal(g.budget,2);e.beginTurn();assert.equal(g.budget,2);});
test('transfers cannot empty a country or move enemy troops',()=>{const g=GameEngine.create('Test','ZA',true),e=new GameEngine(g);e.reinforce({[g.countries[0].code]:g.budget});const a=g.countries[0],b=e.owned()[1],enemy=g.countries.find(c=>c.owner!==0);assert.throws(()=>e.transfer(a.code,b.code,a.army));assert.throws(()=>e.transfer(a.code,enemy.code,1));const previous=a.army;e.transfer(a.code,b.code,2);assert.equal(a.army,previous-2);});
test('conquest reward uses original strength, adds one garrison and forbids a second attack',()=>{const g=GameEngine.create('Test','ZA',true),e=new GameEngine(g);e.reinforce({[g.countries[0].code]:g.budget});const a=g.countries[0],d=g.countries.find(c=>c.owner!==0);d.army=1;d.value=9;const before=a.army;e.startAttack(a.code,d.code);let i=0;const result=e.roll(()=>i++%2===0?6:1);assert.equal(result.conquered,true);assert.equal(d.owner,0);assert.equal(d.army,1);assert.equal(a.army,before+3);assert.equal(g.lastBattle.reward,4);assert.throws(()=>e.startAttack(a.code,g.countries.find(c=>c.owner!==0).code));});
test('stopping an attack ends the turn and skips eliminated participants',()=>{const g=GameEngine.create('Test','ZA',true),e=new GameEngine(g);e.reinforce({[g.countries[0].code]:g.budget});const a=g.countries[0],d=g.countries.find(c=>c.owner!==0);e.startAttack(a.code,d.code);e.stopAttack();assert.notEqual(e.current,0);assert.equal(g.battle,null);assert.ok(e.owned().length>0);});
test('an in-progress battle survives JSON persistence',()=>{const g=GameEngine.create('Test','ZA',true),e=new GameEngine(g);e.reinforce({[g.countries[0].code]:g.budget});e.startAttack(g.countries[0].code,g.countries.find(c=>c.owner!==0).code);const restored=new GameEngine(JSON.parse(JSON.stringify(g)));let i=0;restored.roll(()=>i++%2===0?3:3);assert.equal(restored.game.battle.phase,1);assert.ok(restored.game.battle.pairs.length>0);});
