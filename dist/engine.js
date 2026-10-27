import {catalogue,armyValue,commanders,populationReference} from './data.js';
import {NpcStrategy} from './npc-strategy.js';
import {difficultyFor} from './difficulty.js';
import {playerNickname} from './profile.js';

export const CAMPAIGN_STORAGE_KEY='meridian-conquest-ui-v2';
export const LEGACY_CAMPAIGN_STORAGE_KEY='meridian-conquest-ui-v1';

// Also correct the display of older reports without rewriting saved events.
export function reportText(game,event){
  return event.type==='turn'&&event.player===0&&game.mode!=='multiplayer'&&typeof event.text==='string'
    ?event.text.replace(/^You['’]s turn\b/,'Your turn'):event.text;
}

export function createRecordId(source=globalThis.crypto){
  if(typeof source.randomUUID==='function')return source.randomUUID();
  // Local HTTP previews may expose getRandomValues without randomUUID.
  const bytes=source.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export class LocalGameRepository {
  constructor(key=CAMPAIGN_STORAGE_KEY){this.key=key;}
  load(){
    // The requested clean start removes only the previous campaign collection.
    // New campaigns use v2 and survive subsequent loads. Profile data is separate.
    if(this.key===CAMPAIGN_STORAGE_KEY){try{localStorage.removeItem(LEGACY_CAMPAIGN_STORAGE_KEY);}catch{}}
    try{return JSON.parse(localStorage.getItem(this.key))||null;}catch{return null;}
  }
  save(games){try{localStorage.setItem(this.key,JSON.stringify(games));return true;}catch{return false;}}
}

export class BattleEngine {
  static resolve(attacker,defender,roll=()=>Math.floor(Math.random()*6)+1){
    const count=Math.min(attacker-1,defender);
    if(count<1)throw new Error('The attacking country needs at least two soldiers.');
    const pairs=Array.from({length:count},(_,i)=>({index:i+1,a:roll(),d:roll()}));
    return {pairs,attackerLoss:pairs.filter(p=>p.a<p.d).length,defenderLoss:pairs.filter(p=>p.a>p.d).length};
  }
}

export class GameEngine {
  constructor(game){this.game=game;}
  static create(name,start='ZA',sample=false,difficulty='medium',nickname=null){
    const chosen=catalogue.find(x=>x.code===start)||catalogue[0];
    let others=sample?catalogue.slice(0,10).filter(x=>x.code!==chosen.code).slice(0,9):catalogue.filter(x=>x.code!==chosen.code).map(x=>({x,r:Math.random()})).sort((a,b)=>a.r-b.r).slice(0,9).map(({x})=>x);
    if(others.length<9)others.push(...catalogue.filter(x=>x.code!==chosen.code&&!others.includes(x)).slice(0,9-others.length));
    const order=[0,1,2,3,4,5,6,7,8,9];
    if(!sample){const first=Math.floor(Math.random()*10);order.push(...order.splice(0,first));}
    const game={id:createRecordId(),name:name.trim()||'New Meridian',start:chosen.code,difficulty:difficultyFor(difficulty).id,round:1,position:0,order,turnStarted:false,budget:0,attackUsed:false,battle:null,winner:null,status:'active',createdAt:Date.now(),updatedAt:Date.now(),events:[],countries:[chosen,...others].map((c,i)=>({...c,owner:i,value:armyValue(c.population),army:armyValue(c.population)}))};
    game.populationSource={...populationReference};
    if(nickname)game.playerNames=[playerNickname(nickname),...commanders.slice(1)];
    const engine=new GameEngine(game);
    if(sample){game.round=3;game.countries[0].army=9;game.countries[4].owner=0;game.countries[4].army=3;game.countries[1].army=4;engine.event('campaign','A new round begins. Every decision redraws the world.');engine.event('conquest',`${game.countries[4].name} is now under your command.`,{country:game.countries[4].code});}
    engine.beginTurn();
    return game;
  }
  get current(){return this.game.order[this.game.position];}
  owned(player=this.current){return this.game.countries.filter(c=>c.owner===player);}
  event(type,text,detail={}){this.game.events.push({id:createRecordId(),type,text,round:this.game.round,player:this.current,at:Date.now(),...detail,board:this.game.countries.map(c=>({code:c.code,owner:c.owner,army:c.army}))});this.game.updatedAt=Date.now();}
  beginTurn(){
    const g=this.game;if(g.turnStarted||g.winner!==null)return;
    g.turnStarted=true;g.attackUsed=false;g.battle=null;g.budget=g.round>1?this.owned().length*2:0;
    const text=`${(g.playerNames||commanders)[this.current]}'s turn${g.budget?` · ${g.budget} reinforcements available`:''}.`;
    this.event('turn',reportText(g,{type:'turn',player:this.current,text}));
  }
  reinforce(allocations){
    const g=this.game;const owned=this.owned();
    const total=Object.values(allocations).reduce((a,b)=>a+Number(b),0);
    if(total!==g.budget||owned.some(c=>!Number.isInteger(allocations[c.code]||0)||(allocations[c.code]||0)<0)||Object.keys(allocations).some(code=>!owned.find(c=>c.code===code)))throw new Error('Allocate the complete reinforcement budget to your own countries.');
    for(const c of owned)c.army+=allocations[c.code]||0;
    const amount=g.budget;g.budget=0;this.event('reinforce',`${amount} soldiers deployed across ${owned.length} controlled ${owned.length===1?'country':'countries'}.`);
  }
  transfer(from,to,amount){
    const g=this.game;const a=g.countries.find(c=>c.code===from),b=g.countries.find(c=>c.code===to);
    if(g.battle||g.budget||!a||!b||a===b||a.owner!==this.current||b.owner!==this.current||!Number.isInteger(amount)||amount<1||a.army-amount<1)throw new Error('Choose two owned countries and leave at least one soldier behind.');
    a.army-=amount;b.army+=amount;this.event('transfer',`${amount} soldiers moved from ${a.name} to ${b.name}.`,{from,to,amount});
  }
  startAttack(from,to){
    const g=this.game;const a=g.countries.find(c=>c.code===from),b=g.countries.find(c=>c.code===to);
    if(g.budget||g.attackUsed||g.battle||!a||!b||a.owner!==this.current||b.owner===this.current||a.army<2)throw new Error('Choose an owned country with at least two soldiers and an enemy target.');
    g.attackUsed=true;g.battle={from,to,pairs:[],phase:0,attackerLoss:0,defenderLoss:0};
    this.event('attack',`${a.name} launches an attack on ${b.name}.`,{from,to});
  }
  roll(roll){
    const g=this.game;if(!g.battle)throw new Error('No battle is in progress.');
    const b=g.battle,a=g.countries.find(c=>c.code===b.from),d=g.countries.find(c=>c.code===b.to);
    const result=BattleEngine.resolve(a.army,d.army,roll);a.army-=result.attackerLoss;d.army-=result.defenderLoss;
    Object.assign(b,result,{phase:b.phase+1});
    this.event('dice',`${a.name} loses ${result.attackerLoss}; ${d.name} loses ${result.defenderLoss}.`,{from:a.code,to:d.code,pairs:result.pairs,attackerLoss:result.attackerLoss,defenderLoss:result.defenderLoss});
    if(d.army===0){
      const previous=d.owner,reward=Math.max(2,Math.floor(d.value/2));
      d.owner=this.current;d.army=1;a.army+=reward-1;
      g.battle=null;g.lastBattle={...b,outcome:'conquest',reward,country:d.name};
      this.event('conquest',`${d.name} conquered. +${reward} soldiers earned; one garrisons the new territory.`,{country:d.code,reward});
      if(!this.owned(previous).length)this.event('elimination',`${(g.playerNames||commanders)[previous]} has been eliminated.`);
      if(this.owned().length===10){g.winner=this.current;g.status=g.mode==='multiplayer'?'finished':this.current===0?'won':'lost';this.event('victory',`${(g.playerNames||commanders)[this.current]} controls all ten countries.`);}
      return {finished:true,conquered:true};
    }
    if(a.army===1){g.lastBattle={...b,outcome:'held'};g.battle=null;this.event('held',`${d.name} holds. One soldier remains in ${a.name}.`);return {finished:true,conquered:false};}
    return {finished:false};
  }
  stopAttack(){if(!this.game.battle)return;this.event('retreat','The attack is stopped. Remaining troops hold their positions.');this.game.lastBattle={...this.game.battle,outcome:'stopped'};this.game.battle=null;this.endTurn();}
  endTurn(){
    const g=this.game;if(g.winner!==null)return;if(g.battle||g.budget)throw new Error('Finish the current action before ending your turn.');
    do{g.position=(g.position+1)%g.order.length;if(g.position===0)g.round++;}while(!this.owned().length);
    g.turnStarted=false;g.lastBattle=null;this.beginTurn();
    if(g.mode!=='multiplayer'&&!this.owned(0).length)g.status='lost';
  }
  npcPlan(){
    return NpcStrategy.attack(this.game,this.current);
  }
  npcReinforcements(){return NpcStrategy.reinforcements(this.game,this.current);}
  npcTransfers(){return NpcStrategy.defenceTransfers(this.game,this.current);}
  npcBattleDecision(options){return NpcStrategy.battleDecision(this.game,options);}
}
