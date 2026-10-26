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

import {COMMENTARY_VERSION,CommentaryQueue,commentaryContext,parseCommentaryBatch,recentCommentaryTasks,commentaryErrorMessage,applyCommentary,cleanCommentary as cleanLiveCommentary} from '../dist/commentary.js';
const task=(id,type='dice')=>({key:'g/'+id,eventId:id,context:{event:{id,type,text:'Recorded result'}}});
const response=tasks=>JSON.stringify({reports:tasks.map(t=>({eventId:t.eventId,text:'The recorded battle continues.'}))});
function queue(options={}){
 const writes=[],seen=[];
 const q=new CommentaryQueue({generate:async tasks=>{seen.push(tasks);return response(tasks);},persist:async(t,text)=>{writes.push(t.eventId);return {status:'ready',text};},setTimer:()=>1,clearTimer:()=>{},...options});
 return {q,writes,seen};
}
test('only fresh eligible events are generated, once, in bounded batches',async()=>{
 const {q,writes,seen}=queue();q.enqueue([task('a'),task('a'),task('turn','turn'),...Array.from({length:7},(_,i)=>task('n'+i))]);
 await q.drain();assert.equal(seen.length,1);assert.equal(seen[0].length,6);assert.equal(new Set(writes).size,6);
 await q.drain();assert.equal(writes.length,8);assert.equal(q.pending.length,0);
});
test('saved commentary is reused without making a model request',async()=>{
 const generated=[],reported=[];
 const {q}=queue({lookup:async()=>({status:'ready',text:'Saved report.'}),generate:async()=>{generated.push(true);},onReport:(_,result)=>reported.push(result.text)});
 q.enqueue([task('cached')]);await q.drain();assert.equal(generated.length,0);assert.deepEqual(reported,['Saved report.']);
});
test('signing out during a model request discards its response without saving',async()=>{
 let release,started;
 const gate=new Promise(resolve=>{release=resolve;}),running=new Promise(resolve=>{started=resolve;});
 const {q,writes}=queue({generate:async tasks=>{started();await gate;return response(tasks);}});
 q.enqueue([task('old-session')]);const pending=q.drain();await running;q.reset();release();await pending;
 assert.deepEqual(writes,[]);
});
test('disabled commentary makes no requests and quota errors keep factual gameplay available',async()=>{
 const off=queue({enabled:false});off.q.enqueue([task('off')]);await off.q.drain();assert.equal(off.seen.length,0);
 const broken=queue({generate:async()=>{throw new Error('429 quota');}});broken.q.enqueue([task('quota')]);await broken.q.drain();
 assert.equal(broken.q.status,'unavailable');assert.deepEqual(broken.writes,[]);assert.equal(broken.q.running,false);
});
test('fast-forward queue stays bounded instead of building an unlimited commentary backlog',()=>{
 const {q}=queue();q.enqueue(Array.from({length:100},(_,i)=>task('event'+i)));assert.equal(q.pending.length,24);assert.equal(q.pending[0].eventId,'event76');
});
test('Gemini output is matched to requested event IDs and incomplete output is rejected',()=>{
 const result=parseCommentaryBatch(JSON.stringify({reports:[{eventId:'unrelated',text:'Ignore'},{eventId:'a',text:'Valid report.'}]}),[task('a')]);
 assert.equal(result.size,1);assert.equal(result.get('a'),'Valid report.');
 assert.throws(()=>parseCommentaryBatch('{"reports":[]}',[task('a')]));
});
test('narration context excludes previous AI text and preserves the event board rather than the later board',()=>{
 const game=GameEngine.create('Facts','ZA',true),event=game.events[0];event.commentary='Generated claim';
 const before=JSON.stringify(event.board);game.countries[0].army+=20;
 const context=commentaryContext(game,event);assert.equal(context.event.commentary,undefined);assert.equal(JSON.stringify(context.event.board),before);
});

test('saved campaigns can request only the latest three missing eligible reports without replaying their whole history',()=>{
 const game=GameEngine.create('Saved game','ZA',true),source=game.events[0];
 game.events=Array.from({length:20},(_,i)=>({...source,id:'saved'+i,type:'dice'}));game.events.at(-1).commentary='Already saved.';game.events.at(-1).commentaryVersion=COMMENTARY_VERSION;
 const tasks=recentCommentaryTasks(game,{uid:'owner'});
 assert.deepEqual(tasks.map(task=>task.eventId),['saved16','saved17','saved18']);assert.ok(tasks.every(task=>task.uid==='owner'&&task.gameId===game.id));
});

test('match context uses the event snapshot, recorded battle totals and strictly earlier narration',()=>{
 const game=GameEngine.create('Match story','ZA',true),engine=new GameEngine(game);
 game.round=1;game.budget=0;game.position=game.order.indexOf(0);game.events=[];game.countries[0].army=6;game.countries[1].army=5;
 engine.event('turn','Start of the recorded turn.');engine.startAttack('ZA','BR');game.events.at(-1).commentary='An earlier opening line.';
 const values=[1,6,6,1,6,1,3,3,3,3];engine.roll(()=>values.shift());const event=game.events.at(-1);
 engine.event('decision','A later decision which must not leak.');game.events.at(-1).commentary='Future commentary.';
 game.round=99;game.countries[0].army=900;game.countries[1].owner=0;
 const context=commentaryContext(game,event);
 assert.equal(context.match.round,1);assert.equal(context.match.battle.phase,1);assert.equal(context.match.battle.attackerLoss,1);assert.equal(context.match.battle.defenderLoss,2);
 assert.equal(context.match.battle.remaining.find(c=>c.code==='BR').army,3);
 assert.equal(context.match.standings.find(row=>row.player===1).countries,1);
 assert.deepEqual(context.previousCommentary.map(item=>item.text),['An earlier opening line.']);assert.doesNotMatch(JSON.stringify(context),/Future commentary|later decision/);
 const snapshot=JSON.stringify(context);event.board[0].army=12345;assert.equal(JSON.stringify(context),snapshot,'Queued context must remain an immutable event snapshot');
});

test('territorial ties and lead changes are explicit and a new turn does not inherit the previous battle',()=>{
 const game=GameEngine.create('Leader story','ZA',true),engine=new GameEngine(game);game.events=[];
 game.countries.forEach((c,i)=>{c.owner=i<4?i%2:i;c.army=10+i;});engine.event('turn','Before the capture.');
 game.countries[1].owner=0;engine.event('conquest','A recorded capture.',{country:game.countries[1].code});
 const context=commentaryContext(game,game.events.at(-1));assert.deepEqual(context.match.previousTerritorialLeaders.sort(),[0,1]);assert.deepEqual(context.match.territorialLeaders,[0]);
 engine.event('attack','A previous attack.',{from:'ZA',to:'BR'});engine.event('turn','A new commander takes over.');engine.event('decision','Planning a new move.');
 assert.equal(commentaryContext(game,game.events.at(-1)).match.battle,null);
});

test('wording memory stays within a campaign and never exposes a later event to an earlier report',async()=>{
 const {q,seen}=queue();const past=task('past');past.gameId='same';q.enqueue([past]);await q.drain();
 const present=task('present');present.gameId='same';present.context.recent=[{id:'past'}];q.enqueue([present]);await q.drain();
 assert.equal(seen[1][0].context.previousCommentary[0].eventId,'past');
 const earlier=task('earlier');earlier.gameId='same';earlier.context.recent=[];q.enqueue([earlier]);await q.drain();assert.deepEqual(seen[2][0].context.previousCommentary,[]);
 const other=task('other');other.gameId='different';other.context.recent=[{id:'past'}];q.enqueue([other]);await q.drain();assert.deepEqual(seen[3][0].context.previousCommentary,[]);
 q.reset();assert.equal(q.memory.size,0);
});

test('legacy reports can be upgraded while late legacy listeners cannot overwrite the new commentary',()=>{
 const game=GameEngine.create('Upgrade','ZA',true),event=game.events.find(e=>e.type==='conquest');event.commentary='Old stat summary.';
 assert.ok(recentCommentaryTasks(game,{uid:'owner'}).some(task=>task.eventId===event.id));
 assert.equal(applyCommentary(event,{status:'ready',text:'A new match-aware report.',narrationVersion:COMMENTARY_VERSION}),true);
 assert.equal(applyCommentary(event,{status:'ready',text:'A late old report.',narrationVersion:0}),false);
 assert.equal(event.commentary,'A new match-aware report.');assert.equal(recentCommentaryTasks(game,{uid:'owner'}).some(task=>task.eventId===event.id),false);
});

test('live narration allows two concise sentences while retaining storage limits and plain text',()=>{
 const text='The lead changes hands. '+Array(38).fill('word').join(' ')+'.';assert.equal(cleanLiveCommentary(text),text);
 const bounded=cleanLiveCommentary(Array(100).fill('longwordhere').join(' '));assert.ok(bounded.length<=500);assert.ok(bounded.split(' ').length<=60);
});

test('failed reports expose an actionable status and can be explicitly requested again',async()=>{
 let calls=0;
 const {q,writes}=queue({generate:async tasks=>{if(++calls===1)throw Object.assign(new Error('Local setup'),{code:'commentary/local-setup-required'});return response(tasks);}});
 q.enqueue([task('retry')]);await q.drain();assert.equal(q.states.get('g/retry'),'failed');assert.match(q.errorMessage,/npm run dev/);
 q.enqueue([task('retry')],{retry:true});await q.drain();assert.deepEqual(writes,['retry']);assert.equal(q.states.get('g/retry'),'ready');assert.equal(q.errorMessage,'');
 assert.match(commentaryErrorMessage(new Error('429 quota exhausted')),/usage limit/);
});
