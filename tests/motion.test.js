import test from 'node:test';
import assert from 'node:assert/strict';
import {GameEngine} from '../dist/engine.js';
import {MotionDirector,countryMotion,diceMotion,diceFaceAt,DICE_ROLL_DURATION,mapEffects,mapOverlay,motionPose,routeGeometry,countryPoint,casualtyMarkers,resolveReducedMotion,presentationGame,rollPending} from '../dist/motion.js';

function scenario(options={}){
  let time=0;
  const game=GameEngine.create('Motion test','ZA',true),engine=new GameEngine(game);
  const motion=new MotionDirector({now:()=>time,...options});
  motion.frame(game);
  return {game,engine,motion,advance:ms=>time+=ms};
}
function deploy(engine){engine.reinforce({[engine.owned()[0].code]:engine.game.budget});}
function conquer(engine){
  const from=engine.owned()[0],to=engine.game.countries.find(c=>c.owner!==engine.current);
  engine.startAttack(from.code,to.code);
  let i=0;engine.roll(()=>i++%2===0?6:1);
  return {from,to};
}

test('SVG flight positions progress from the source through the arc to the destination',()=>{
  const {game}=scenario(),from=game.countries[0],to=game.countries[1],geometry=routeGeometry(from,to);
  const flight={...geometry,kind:'flight',start:100,duration:2000};
  const start=motionPose(flight,100),middle=motionPose(flight,1100),end=motionPose(flight,2100);
  assert.deepEqual([start.x,start.y],countryPoint(from));
  assert.deepEqual([end.x,end.y],countryPoint(to));
  assert.equal(middle.x,(geometry.x1+geometry.x2)/2);
  assert.equal(middle.y,.25*geometry.y1+.5*geometry.cy+.25*geometry.y2);
  assert.equal(middle.opacity,1);assert.equal(end.opacity,0);
  const missile=motionPose({...flight,rotate:true},600);
  assert.ok(Number.isFinite(missile.angle));assert.notEqual(missile.angle,0);
});

test('both countries receive their own exact casualty badge from the same dice phase',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  const from=engine.owned()[0],to=game.countries.find(c=>c.owner!==engine.current);
  engine.startAttack(from.code,to.code);
  const dice=[1,6,6,1,6,1,3,3];engine.roll(()=>dice.shift());
  const frame=motion.frame(game),before=JSON.stringify(game);
  assert.equal(frame.roll.attackerLoss,1);assert.equal(frame.roll.defenderLoss,2);
  assert.match(casualtyMarkers(frame,from),new RegExp(`data-country="${from.code}" data-loss="1"`));
  assert.match(casualtyMarkers(frame,to),new RegExp(`data-country="${to.code}" data-loss="2"`));
  assert.match(casualtyMarkers(frame,to,{roster:true}),/−2<\/span>/);
  assert.match(mapEffects(frame,game.countries),/class="missile-flight"/);
  assert.equal(JSON.stringify(game),before,'visual missiles and labels must not change battle results');
});

test('ties launch a visual missile without inventing casualties',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  engine.startAttack(engine.owned()[0].code,game.countries.find(c=>c.owner!==engine.current).code);
  engine.roll(()=>3);const frame=motion.frame(game),markup=mapEffects(frame,game.countries);
  assert.match(markup,/class="missile-flight"/);assert.doesNotMatch(markup,/class="casualty-marker"/);
  for(const c of game.countries)assert.equal(casualtyMarkers(frame,c,{roster:true}),'');
});

test('older shared records recover casualties from board changes when loss metadata is missing',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  engine.startAttack(engine.owned()[0].code,game.countries.find(c=>c.owner!==engine.current).code);
  const dice=[1,6,6,1,6,1,3,3];engine.roll(()=>dice.shift());
  const event=game.events.at(-1);delete event.attackerLoss;delete event.defenderLoss;event.pairs=[];
  const frame=motion.frame(game);
  assert.equal(frame.roll.attackerLoss,1);assert.equal(frame.roll.defenderLoss,2);
});

test('casualties appear after the dice settle and finish before the label lifetime ends',()=>{
  const label={kind:'label',start:DICE_ROLL_DURATION,duration:1700,x:10,y:20};
  assert.equal(motionPose(label,500).opacity,0);
  assert.equal(motionPose(label,1500).opacity,1);
  assert.ok(motionPose(label,1500).y<20);
  assert.equal(motionPose(label,3000).opacity,0);
  assert.equal(motionPose({...label,until:1400},1500).opacity,0,'a later revealed phase replaces the earlier country label');
});

test('an explicit animation choice can override the system reduced-motion preference',()=>{
  assert.equal(resolveReducedMotion('auto',true),true);
  assert.equal(resolveReducedMotion('full',true),false);
  assert.equal(resolveReducedMotion('reduced',false),true);
  assert.equal(resolveReducedMotion(null,false),false);
});

test('the frame renderer advances real SVG transforms and stops after the flight completes',()=>{
  const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  let time=0,next=0;const callbacks=new Map();
  globalThis.requestAnimationFrame=callback=>{callbacks.set(++next,callback);return next;};
  globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  const attrs=new Map(Object.entries({'data-motion-kind':'flight','data-motion-start':'0','data-motion-duration':'2000','data-motion-x1':'0','data-motion-y1':'0','data-motion-cx':'50','data-motion-cy':'-50','data-motion-x2':'100','data-motion-y2':'0'}));
  const node={style:{},hasAttribute:key=>attrs.has(key),getAttribute:key=>attrs.get(key),setAttribute:(key,value)=>attrs.set(key,value)};
  const root={querySelectorAll:()=>[node],contains:element=>element===node};
  try{
    const motion=new MotionDirector({now:()=>time});motion.animate(root);
    assert.match(attrs.get('transform'),/translate\(0 0\)/);
    const tick=at=>{time=at;const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback();};
    tick(1000);assert.match(attrs.get('transform'),/translate\(50 -25\)/);assert.equal(node.style.opacity,'1');
    tick(2100);assert.equal(node.style.opacity,'0');assert.equal(callbacks.size,0);
    motion.reset();
  }finally{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});

test('resuming an existing battle shows its route without replaying historical rolls',()=>{
  const {game,engine}=scenario();deploy(engine);
  engine.startAttack(engine.owned()[0].code,game.countries.find(c=>c.owner!==engine.current).code);
  engine.roll(()=>3);
  const restored=JSON.parse(JSON.stringify(game));
  const frame=new MotionDirector().frame(restored);
  assert.deepEqual(frame.effects,[]);
  assert.equal(frame.route.from,restored.battle.from);
  assert.equal(frame.route.to,restored.battle.to);
  assert.equal(diceMotion(frame,restored.battle.pairs).className,'');
});

test('batched reinforcements and transfers report the exact changes from each event',()=>{
  const {game,engine,motion}=scenario(),from=engine.owned()[0],to=engine.owned()[1],budget=game.budget;
  deploy(engine);engine.transfer(from.code,to.code,2);
  const before=JSON.stringify(game),frame=motion.frame(game);
  assert.deepEqual(frame.effects.find(e=>e.kind==='reinforce').changes,[{code:from.code,amount:budget}]);
  const transfer=frame.effects.find(e=>e.kind==='transfer');
  assert.equal(transfer.from,from.code);assert.equal(transfer.to,to.code);assert.equal(transfer.amount,2);
  assert.equal(JSON.stringify(game),before,'presentation must not change the saved game');
});

test('transfer squads carry the exact soldier count between the correct countries',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  const [from,to]=engine.owned();engine.transfer(from.code,to.code,3);
  const before=JSON.stringify(game),frame=motion.frame(game),markup=mapEffects(frame,game.countries);
  assert.match(markup,new RegExp(`data-troop-count="3" data-from="${from.code}" data-to="${to.code}"`));
  assert.equal(JSON.stringify(game),before);
  assert.equal(game.events.at(-1).from,from.code);
  assert.equal(game.events.at(-1).to,to.code);
  assert.equal(game.events.at(-1).amount,3);
});

test('attack squads use the force committed at launch even if a later roll already changed the army',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  const from=engine.owned()[0],to=game.countries.find(c=>c.owner!==engine.current),committed=from.army-1;
  engine.startAttack(from.code,to.code);let i=0;engine.roll(()=>i++%2===0?1:6);
  const frame=motion.frame(game),attack=frame.effects.find(e=>e.kind==='attack');
  assert.ok(from.army-1<committed);assert.equal(attack.amount,committed);
  assert.match(mapEffects(frame,game.countries),new RegExp(`data-troop-count="${committed}" data-from="${from.code}" data-to="${to.code}"`));
});

test('a replay starting with a transfer can animate its route without an earlier board snapshot',()=>{
  const {game,engine}=scenario();deploy(engine);
  const [from,to]=engine.owned();engine.transfer(from.code,to.code,2);
  const transfer=game.events.at(-1);engine.event('decision','Surveying the next opportunity.');
  const replay={...game,events:[transfer,game.events.at(-1)]},motion=new MotionDirector({now:()=>0});
  motion.frame(replay,{view:'history',replay:1});
  const frame=motion.frame(replay,{view:'history',replay:0}),effect=frame.effects.find(e=>e.kind==='transfer');
  assert.equal(effect.from,from.code);assert.equal(effect.to,to.code);assert.equal(effect.amount,2);
  assert.equal(frame.route.kind,'transfer');
});

test('older transfers without movement metadata still animate from their saved board changes',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  const [from,to]=engine.owned();engine.transfer(from.code,to.code,2);
  const event=game.events.at(-1);delete event.from;delete event.to;delete event.amount;
  const effect=motion.frame(game).effects.find(e=>e.kind==='transfer');
  assert.equal(effect.from,from.code);assert.equal(effect.to,to.code);assert.equal(effect.amount,2);
});

test('redrawing a moving squad retains its original progress and the effect eventually disappears',()=>{
  const {game,engine,motion,advance}=scenario();deploy(engine);
  const [from,to]=engine.owned();engine.transfer(from.code,to.code,2);
  const first=motion.frame(game).effects.find(e=>e.kind==='transfer');
  advance(500);const frame=motion.frame(game),same=frame.effects.find(e=>e.kind==='transfer');
  assert.equal(same.id,first.id);assert.equal(same.age,500);
  assert.equal(frame.effects.filter(e=>e.kind==='transfer').length,1);
  assert.match(mapEffects(frame,game.countries),/data-motion-kind="flight"/);
  advance(4000);assert.equal(motion.frame(game).effects.find(e=>e.kind==='transfer'),undefined);
});

test('redraws advance an effect instead of restarting or duplicating it',()=>{
  const {game,engine,motion,advance}=scenario();deploy(engine);conquer(engine);
  const first=motion.frame(game),capture=first.effects.find(e=>e.kind==='capture');
  assert.equal(capture.delay,first.roll.rollDuration);
  advance(300);engine.event('decision','Reading the current board.');
  const redraw=motion.frame(game),same=redraw.effects.find(e=>e.kind==='capture');
  assert.equal(same.id,capture.id);assert.equal(same.age,300);
  assert.equal(redraw.effects.filter(e=>e.kind==='capture').length,1);
  assert.match(countryMotion(redraw,game.countries.find(c=>c.code===same.code)).style,/--capture-delay:800ms/);
  advance(3000);assert.deepEqual(motion.frame(game).effects,[]);
});

test('dice, loss effects and capture rewards stay tied to the correct countries',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  const {from,to}=conquer(engine),frame=motion.frame(game);
  assert.equal(frame.route.from,from.code);assert.equal(frame.route.to,to.code);
  assert.equal(frame.roll.defenderLoss,4);assert.equal(frame.roll.attackerLoss,0);
  assert.equal(diceMotion(frame,game.lastBattle.pairs).className,'dice-rolling');
  assert.equal(diceMotion(frame,[]).className,'');
  const capture=frame.effects.find(e=>e.kind==='capture');
  assert.equal(capture.previousOwner,1);assert.equal(capture.owner,0);
  assert.deepEqual(capture.changes,[{code:from.code,amount:3},{code:to.code,amount:1}]);
  assert.match(mapEffects(frame,game.countries),/−4/);
});

test('fast playback shortens visual effects while leaving game records unchanged',()=>{
  const {game,engine,motion}=scenario();deploy(engine);conquer(engine);
  const before=JSON.stringify(game),frame=motion.frame(game,{fast:true});
  assert.equal(frame.roll.rollDuration,DICE_ROLL_DURATION/2);
  assert.ok(frame.roll.rollDuration<750,'dice settle within the shortest existing NPC pause');
  assert.equal(JSON.stringify(game),before);
});

test('reduced motion consumes events without particles, tumbling or a later backlog',()=>{
  const {game,engine,motion}=scenario({reducedMotion:true});deploy(engine);conquer(engine);
  const frame=motion.frame(game);
  assert.equal(frame.reduced,true);assert.deepEqual(frame.effects,[]);
  assert.equal(mapEffects(frame,game.countries),'');assert.equal(mapOverlay(frame),'');
  assert.equal(diceMotion(frame,game.lastBattle.pairs).className,'');
  motion.setReducedMotion(false);
  assert.deepEqual(motion.frame(game).effects,[]);
  engine.endTurn();assert.equal(motion.frame(game).turn.player,engine.current);
});

test('replay animates only the selected event and never edits campaign history',()=>{
  const {game,engine,motion}=scenario();deploy(engine);conquer(engine);
  motion.frame(game,{view:'history',replay:0});
  const index=game.events.findIndex(e=>e.type==='dice'),before=JSON.stringify(game);
  const frame=motion.frame(game,{view:'history',replay:index});
  assert.equal(frame.roll.id,game.events[index].id);
  assert.equal(frame.effects.length,1);
  assert.equal(JSON.stringify(game),before);
  assert.equal(motion.frame(game,{view:'history',replay:index}).effects.length,1);
});

test('the victory celebration follows the final dice and capture, then expires',()=>{
  const {game,engine,motion,advance}=scenario();deploy(engine);
  const enemy=game.countries[1];
  for(const c of game.countries)c.owner=0;
  enemy.owner=1;enemy.army=1;
  engine.event('campaign','The last opposing country remains.');
  motion.frame(game);conquer(engine);
  const frame=motion.frame(game),capture=frame.effects.find(e=>e.kind==='capture');
  assert.equal(game.winner,0);assert.equal(frame.victory.player,0);
  assert.ok(frame.victory.delay>capture.delay);
  assert.match(mapOverlay(frame),/The world is yours\./);
  advance(5000);assert.equal(motion.frame(game).victory,undefined);
  assert.equal(mapOverlay(motion.frame(game)),'');
});

// The visual roll cannot consume randomness used by combat or NPCs.
test('cosmetic dice cycle through faces and settle on the stored value without changing RNG',()=>{
  const random=Math.random;Math.random=()=>{throw new Error('Cosmetic dice must not use battle randomness');};
  try{
    const faces=Array.from({length:8},(_,i)=>diceFaceAt(4,i*75,DICE_ROLL_DURATION,0));
    assert.equal(new Set(faces).size,6);
    assert.equal(diceFaceAt(4,DICE_ROLL_DURATION,DICE_ROLL_DURATION),4);
    assert.equal(diceFaceAt(2,DICE_ROLL_DURATION+500,DICE_ROLL_DURATION),2);
  }finally{Math.random=random;}
});

test('the mounted dice update visible pips, announce completion and stop their animation frame',()=>{
  const oldRequest=globalThis.requestAnimationFrame,oldCancel=globalThis.cancelAnimationFrame;
  let time=0,next=0;const callbacks=new Map();
  globalThis.requestAnimationFrame=callback=>{callbacks.set(++next,callback);return next;};
  globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
  const pips=Array.from({length:9},()=>({style:{}})),attributes=new Map([['data-die-final','4']]);
  const node={dataset:{},getAttribute:key=>attributes.get(key),setAttribute:(key,value)=>attributes.set(key,value),querySelectorAll:()=>pips};
  const status={textContent:''},tray={dataset:{},querySelector:()=>status};
  const root={contains:()=>true,querySelectorAll:selector=>selector==='[data-motion-kind]'?[]:selector==='.dice-rolling'?[tray]:[node]};
  try{
    const motion=new MotionDirector({now:()=>time});motion.animate(root,{roll:{startedAt:0,rollDuration:DICE_ROLL_DURATION},reduced:false});
    assert.equal(attributes.get('aria-label'),'Rolling die');assert.equal(tray.dataset.rolling,'true');
    const faces=new Set([node.dataset.displayFace]);
    const tick=at=>{time=at;const [id,callback]=callbacks.entries().next().value;callbacks.delete(id);callback();faces.add(node.dataset.displayFace);};
    for(let i=1;i<7;i++)tick(i*75);
    assert.equal(faces.size,6);tick(DICE_ROLL_DURATION);
    assert.equal(node.dataset.displayFace,'4');assert.equal(pips.filter(pip=>pip.style.opacity==='1').length,4);
    assert.equal(tray.dataset.rolling,'false');assert.equal(status.textContent,'Roll complete');
    assert.equal(attributes.get('aria-label'),'Die roll 4');assert.equal(callbacks.size,0);motion.reset();
  }finally{globalThis.requestAnimationFrame=oldRequest;globalThis.cancelAnimationFrame=oldCancel;}
});

test('army counts, ownership, event outcomes and victory wait for the dice to settle without changing saved results',()=>{
  const {game,engine,motion,advance}=scenario();deploy(engine);
  for(const country of game.countries)country.owner=0;
  const enemy=game.countries[1];enemy.owner=1;enemy.army=1;
  engine.event('campaign','The final opponent remains.');motion.frame(game);
  const before=structuredClone(game.countries);conquer(engine);
  const saved=JSON.stringify(game),frame=motion.frame(game),shown=presentationGame(game,frame);
  assert.equal(rollPending(frame),true);assert.deepEqual(shown.countries,before);
  assert.equal(shown.winner,null);assert.equal(shown.presentationPending,true);
  assert.equal(shown.events.some(event=>['dice','conquest','victory'].includes(event.type)&&event.id===frame.roll.id),false);
  assert.equal(shown.events.at(-1).type,'attack');assert.equal(game.winner,0);assert.equal(JSON.stringify(game),saved);
  advance(DICE_ROLL_DURATION);assert.equal(presentationGame(game,motion.frame(game)),game);
});

test('fast playback uses the shorter reveal clock and reduced motion shows results immediately',()=>{
  const {game,engine,motion,advance}=scenario();deploy(engine);conquer(engine);
  const frame=motion.frame(game,{fast:true});assert.equal(frame.roll.rollDuration,DICE_ROLL_DURATION/2);
  advance(DICE_ROLL_DURATION/2-1);assert.equal(rollPending(motion.frame(game,{fast:true})),true);
  advance(1);assert.equal(presentationGame(game,motion.frame(game,{fast:true})),game);
  const reduced=scenario({reducedMotion:true});deploy(reduced.engine);conquer(reduced.engine);
  assert.equal(presentationGame(reduced.game,reduced.motion.frame(reduced.game)),reduced.game);
});

test('multiplayer history trimming retains the new roll and serialized dice still animate',()=>{
  const {game,engine,motion}=scenario();deploy(engine);
  while(game.events.length<80)engine.event('turn','Recorded turn.');motion.frame(game);
  conquer(engine);game.events=game.events.slice(-80);
  const frame=motion.frame(game);assert.equal(frame.roll.id,game.events.findLast(event=>event.type==='dice').id);
  assert.equal(diceMotion(frame,structuredClone(frame.roll.pairs)).className,'dice-rolling');
});
