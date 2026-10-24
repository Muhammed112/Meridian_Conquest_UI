import test from 'node:test';
import assert from 'node:assert/strict';
import {SoundDirector,SoundEventCursor,soundCuesFor,audioSettings,AUDIO_STORAGE_KEY} from '../dist/audio.js';
import {GameEngine} from '../dist/engine.js';
import {MotionDirector,DICE_ROLL_DURATION} from '../dist/motion.js';

test('mute and volumes survive reload separately from campaign saves, including blocked storage',()=>{
  const values=new Map([['meridian-conquest-ui-v2','keep campaign']]);
  const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const sound=new SoundDirector({storage});sound.setSettings({muted:true,music:.37,effects:.81});
  assert.deepEqual(new SoundDirector({storage}).settings,{muted:true,music:.37,effects:.81});
  assert.ok(values.has(AUDIO_STORAGE_KEY));assert.equal(values.get('meridian-conquest-ui-v2'),'keep campaign');
  assert.deepEqual(audioSettings({music:-10,effects:12}),{muted:false,music:0,effects:1});
  assert.deepEqual(audioSettings(null),{muted:false,music:.22,effects:.6});
  assert.doesNotThrow(()=>new SoundDirector({storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}}).setSettings({muted:true}));
});

test('opening saves is silent and redraws never repeat an event, while replay plays only its selected step',()=>{
  const game=GameEngine.create('Audio test','ZA',true),engine=new GameEngine(game),cursor=new SoundEventCursor();
  assert.deepEqual(cursor.read(game),[]);
  engine.reinforce({[engine.owned()[0].code]:game.budget});
  const event=game.events.at(-1);
  assert.deepEqual(cursor.read(game),[event]);assert.deepEqual(cursor.read(game),[]);
  assert.deepEqual(cursor.read(game,{view:'history',replay:0}),[]);
  assert.deepEqual(cursor.read(game,{view:'history',replay:1}),[game.events[1]]);
  assert.deepEqual(cursor.read(game,{view:'history',replay:1}),[]);
  assert.deepEqual(cursor.read(game,{view:'game'}),[]);
});

test('muted events are consumed without an audio backlog or campaign mutation',()=>{
  const sound=new SoundDirector({storage:null}),game=GameEngine.create('Silent battle','ZA',true),engine=new GameEngine(game);
  sound.observe(game,{view:'game'});sound.setSettings({muted:true});
  engine.reinforce({[engine.owned()[0].code]:game.budget});
  const before=JSON.stringify(game);sound.observe(game,{view:'game'});
  assert.equal(sound.cursor.count,game.events.length);assert.equal(sound.pending.size,0);
  sound.setSettings({muted:false});sound.observe(game,{view:'game'});
  assert.equal(sound.pending.size,0);assert.equal(JSON.stringify(game),before);
});

test('one impact per dice phase shares the casualty clock and ties produce no casualty sound',()=>{
  for(const fast of [false,true]){
    const game=GameEngine.create('Sound timing','ZA',true),engine=new GameEngine(game),motion=new MotionDirector({now:()=>0});motion.frame(game);
    engine.reinforce({[engine.owned()[0].code]:game.budget});
    engine.startAttack(engine.owned()[0].code,game.countries.find(c=>c.owner!==0).code);
    let i=0;engine.roll(()=>i++%2?1:6);
    const frame=motion.frame(game,{fast}),event=game.events.findLast(e=>e.type==='dice');
    const cues=soundCuesFor(event,{fast,rollDuration:frame.roll.rollDuration});
    const impacts=cues.filter(c=>c.sound==='impact');
    assert.equal(impacts.length,1);assert.equal(impacts[0].delay,DICE_ROLL_DURATION*(fast?.5:1));
    assert.ok(impacts[0].delay<(fast?750:3000));
  }
  assert.equal(soundCuesFor({type:'dice',attackerLoss:0,defenderLoss:0,pairs:[{a:3,d:3}]}).some(c=>c.sound==='impact'),false);
});

test('hiding the tab or muting cancels pending cues and stops active voices',async()=>{
  const sound=new SoundDirector({storage:null});let fired=false,stopped=0;
  sound.later(()=>{fired=true;},1);sound.voices.add({stop(){stopped++;}});
  sound.setHidden(true);assert.equal(sound.pending.size,0);assert.equal(stopped,1);
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(fired,false);
  sound.later(()=>{fired=true;},1);sound.setSettings({muted:true});
  await new Promise(resolve=>setTimeout(resolve,10));assert.equal(fired,false);
});

test('entering a campaign changes the menu theme and leaving or ending a battle restores the right theme',()=>{
  const sound=new SoundDirector({storage:null}),game=GameEngine.create('Music transitions','ZA',true),engine=new GameEngine(game);
  const scenes=[];sound.syncMusic=()=>scenes.push(sound.scene);
  try{
    sound.observe(null,{view:'welcome'});assert.equal(sound.scene,'menu');
    sound.observe(game,{view:'campaigns'});assert.equal(sound.scene,'menu');
    sound.observe(game,{view:'game'});assert.equal(sound.scene,'planning');
    engine.reinforce({[engine.owned()[0].code]:game.budget});
    engine.startAttack(engine.owned()[0].code,game.countries.find(c=>c.owner!==0).code);
    sound.observe(game,{view:'game'});assert.equal(sound.scene,'battle');
    sound.observe(game,{view:'campaigns'});assert.equal(sound.scene,'menu');
    sound.observe(game,{view:'setup'});assert.equal(sound.scene,'menu');
    sound.observe(game,{view:'game'});assert.equal(sound.scene,'battle','resuming a live battle uses its own track');
    engine.stopAttack();sound.observe(game,{view:'game'});assert.equal(sound.scene,'planning');
    sound.observe(game,{view:'history',replay:0});assert.equal(sound.scene,'planning');
    sound.observe(null,{view:'welcome'});assert.equal(sound.scene,'menu');
    assert.deepEqual(scenes,['planning','battle','menu','battle','planning','menu']);
  }finally{clearTimeout(sound.sceneTimer);sound.cancelEffects();}
});

test('music buffers on page load without starting playback or creating an audio context',()=>{
  const previousAudio=globalThis.Audio,previousDocument=globalThis.document,previousContext=globalThis.AudioContext;
  const elements=[];let played=0,loaded=0,contexts=0;
  globalThis.Audio=class {constructor(){this.dataset={};this.paused=true;}addEventListener(){}load(){loaded++;}play(){played++;return Promise.resolve();}};
  globalThis.document={body:{append:element=>elements.push(element)}};
  globalThis.AudioContext=class {constructor(){contexts++;}};
  try{
    const sound=new SoundDirector({storage:null});
    assert.equal(elements.length,3);assert.equal(loaded,3);assert.equal(played,0);assert.equal(contexts,0);
    assert.equal(sound.unlocked,false);
    assert.ok(elements.every(element=>element.preload==='auto'));
    assert.equal(new Set(elements.map(element=>element.src)).size,3);
    assert.ok(elements.every(element=>element.src.includes('v=quick-start-20261024-1')));
    sound.prepareMusic();assert.equal(elements.length,3,'preparing again reuses existing buffers');
  }finally{globalThis.Audio=previousAudio;globalThis.document=previousDocument;globalThis.AudioContext=previousContext;}
});

function pendingMusic(){
  const sound=new SoundDirector({storage:null});let beginPlanning;
  const track=(playing=false)=>({gain:{gain:{targets:[],cancelScheduledValues(){},setTargetAtTime(value){this.targets.push(value);}}},element:{paused:!playing,readyState:playing?4:0,pauseCount:0,pause(){this.paused=true;this.pauseCount++;},play(){this.paused=false;return new Promise(resolve=>{beginPlanning=resolve;});}}});
  sound.context={currentTime:0,state:'running'};sound.unlocked=true;sound.activeMusic='menu';sound.scene='planning';
  sound.tracks={menu:track(true),planning:track(),battle:track()};
  return {sound,ready:()=>{sound.tracks.planning.element.readyState=4;beginPlanning();}};
}

test('the outgoing music stays audible until the incoming track is ready, then fades quickly',async()=>{
  const {sound,ready}=pendingMusic();
  try{
    sound.syncMusic();
    assert.equal(sound.activeMusic,'menu');assert.equal(sound.tracks.menu.element.paused,false);
    assert.deepEqual(sound.tracks.menu.gain.gain.targets,[],'loading a track must not fade the current music into silence');
    ready();await Promise.resolve();
    assert.equal(sound.activeMusic,'planning');assert.equal(sound.tracks.planning.gain.gain.targets.at(-1),1);
    assert.equal(sound.tracks.menu.gain.gain.targets.at(-1),0);
    sound.setSettings({muted:true});
    assert.ok(Object.values(sound.tracks).every(track=>track.element.paused));
  }finally{for(const track of Object.values(sound.tracks))clearTimeout(track.pauseTimer);}
});

test('a track finishing its load after mute cannot restart the soundtrack',async()=>{
  const {sound,ready}=pendingMusic();sound.syncMusic();sound.setSettings({muted:true});
  ready();await Promise.resolve();
  assert.equal(sound.activeMusic,null);assert.equal(sound.tracks.planning.element.paused,true);
  assert.ok(sound.tracks.planning.gain.gain.targets.every(value=>value===0));
});
