import {GameEngine} from './engine.js';
import {commanders,catalogue,savedCountryPopulation} from './data.js';
import {playerNickname} from './profile.js';

export const ROOM_CAPACITY=10;
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function roomCode(source=globalThis.crypto){
  return Array.from(source.getRandomValues(new Uint8Array(6)),n=>alphabet[n%alphabet.length]).join('');
}
export function normalizeRoomCode(value){
  const code=String(value||'').trim().toUpperCase();
  if(!/^[A-HJ-NP-Z2-9]{6}$/.test(code))throw new Error('Enter a valid six-character room code.');
  return code;
}
const playerName=user=>playerNickname(user.displayName);
export function newRoom(code,user,{name='Friends campaign',difficulty='medium'}={}){
  const now=Date.now();
  return {code,hostUid:user.uid,memberIds:[user.uid],members:{[user.uid]:{name:playerName(user)}},name:String(name).trim().slice(0,50)||'Friends campaign',difficulty:['easy','medium','hard','extreme'].includes(difficulty)?difficulty:'medium',status:'lobby',createdAt:now,updatedAt:now,revision:0,currentSeat:0,controllerUid:user.uid,winnerSeat:-1,eventCount:0,payload:''};
}
export function joinRoom(room,user){
  if(room.memberIds.includes(user.uid)){
    if(room.status==='closed')throw new Error('This room has been closed.');
    return room;
  }
  if(room.status!=='lobby')throw new Error('This match has already started.');
  if(room.memberIds.length>=ROOM_CAPACITY)throw new Error('This room is full.');
  return {...room,members:{...room.members,[user.uid]:{name:playerName(user)}},memberIds:[...room.memberIds,user.uid],updatedAt:Date.now(),revision:room.revision+1};
}
export function leaveRoom(room,uid){
  if(room.status!=='lobby')throw new Error('Started matches keep your seat. Use the room code to reconnect.');
  if(!room.memberIds.includes(uid))throw new Error('You are not in this room.');
  if(uid===room.hostUid)return {...room,status:'closed',updatedAt:Date.now(),revision:room.revision+1};
  const members={...room.members};delete members[uid];
  return {...room,members,memberIds:room.memberIds.filter(id=>id!==uid),updatedAt:Date.now(),revision:room.revision+1};
}
export function startRoom(room,uid){
  if(uid!==room.hostUid)throw new Error('Only the host can start the match.');
  if(room.status!=='lobby')throw new Error('This match has already started.');
  const game=GameEngine.create(room.name,'ZA',false,room.difficulty);
  game.mode='multiplayer';game.status='active';
  game.playerNames=Array.from({length:10},(_,seat)=>room.members[room.memberIds[seat]]?.name||`Bot ${commanders[seat]==='You'?'Meridian':commanders[seat]}`);
  game.events=[];game.turnStarted=false;new GameEngine(game).beginTurn();
  return pack(room,game,game.events);
}
function pack(room,game,events){
  const currentSeat=game.order[game.position];
  return {room:{...room,status:game.winner===null?'playing':'finished',payload:JSON.stringify({...game,events:game.events.slice(-80)}),currentSeat,controllerUid:room.memberIds[currentSeat]||room.hostUid,winnerSeat:game.winner??-1,revision:room.revision+1,eventCount:room.eventCount+events.length,updatedAt:Date.now()},events};
}
// Shared room state comes from other browsers. Validate it before rendering
// and rebuild country labels/geometry from the trusted local catalogue.
export function readRoomGame(room){
  const g=JSON.parse(room.payload),integer=(n,min,max)=>Number.isInteger(n)&&n>=min&&n<=max;
  const invalid=()=>{throw new Error('This room contains invalid game data. Ask the host to create a new room.');};
  if(!g||!Array.isArray(g.countries)||g.countries.length!==10||new Set(g.countries.map(c=>c.code)).size!==10
    ||!Array.isArray(g.order)||g.order.length!==10||new Set(g.order).size!==10||g.order.some(n=>!integer(n,0,9))
    ||!integer(g.position,0,9)||g.order[g.position]!==room.currentSeat||!integer(g.round,1,100000)
    ||!integer(g.budget,0,100000)||!(g.winner===null||integer(g.winner,0,9))||(g.winner??-1)!==room.winnerSeat
    ||!Array.isArray(g.events)||g.events.length>80)invalid();
  g.countries=g.countries.map(country=>{
    const original=catalogue.find(c=>c.code===country.code);
    if(!original||!integer(country.owner,0,9)||!integer(country.army,0,100000))invalid();
    let saved;try{saved=savedCountryPopulation(country);}catch{invalid();}
    return {...original,...saved,owner:country.owner,army:country.army};
  });
  const codes=new Set(g.countries.map(c=>c.code));
  const pairs=value=>{if(!Array.isArray(value)||value.some(p=>!p||!integer(p.a,1,6)||!integer(p.d,1,6)))invalid();return value;};
  for(const event of g.events){
    if(!event||typeof event.id!=='string'||typeof event.type!=='string'||typeof event.text!=='string'||!integer(event.round,1,100000)
      ||!Array.isArray(event.board)||event.board.some(c=>!codes.has(c.code)||!integer(c.owner,0,9)||!integer(c.army,0,100000)))invalid();
    if(event.pairs)pairs(event.pairs);
  }
  if(g.battle){if(!codes.has(g.battle.from)||!codes.has(g.battle.to)||!integer(g.battle.phase,0,100000))invalid();pairs(g.battle.pairs);}
  if(g.lastBattle?.pairs)pairs(g.lastBattle.pairs);
  g.playerNames=Array.from({length:10},(_,seat)=>room.members[room.memberIds[seat]]?.name||`Bot ${commanders[seat]==='You'?'Meridian':commanders[seat]}`);
  g.mode='multiplayer';
  return g;
}
export function moveRoom(room,uid,revision,action,values={}){
  if(room.status!=='playing')throw new Error('This match is not active.');
  if(room.revision!==revision)throw new Error('The board changed. Review the latest move and try again.');
  if(uid!==room.controllerUid)throw new Error('Wait for your turn.');
  const game=readRoomGame(room),e=new GameEngine(game),count=game.events.length;
  const bot=e.current>=room.memberIds.length;
  if(bot){
    if(action!=='bot'||uid!==room.hostUid)throw new Error('The host controls bot turns.');
    if(game.budget){const plan=e.npcReinforcements();e.event('decision',plan.reason);e.reinforce(plan.allocations);}
    else if(game.battle){
      const plan=e.npcBattleDecision({phaseLimit:30});
      if(!plan.continue){e.event('decision',plan.reason);e.stopAttack();}
      else e.roll();
    }else if(!game.attackUsed){
      for(const move of e.npcTransfers()){e.event('decision',move.reason);e.transfer(move.from,move.to,move.amount);}
      const plan=e.npcPlan();e.event('decision',plan.reason);
      if(plan.from)e.startAttack(plan.from.code,plan.to.code);else e.endTurn();
    }else{
      for(const move of e.npcTransfers()){e.event('decision',move.reason);e.transfer(move.from,move.to,move.amount);}
      e.endTurn();
    }
  }else{
    switch(action){
      case 'reinforce':if(!game.budget)throw new Error('There are no reinforcements to deploy.');e.reinforce(values.allocations);break;
      case 'transfer':e.transfer(values.from,values.to,values.amount);break;
      case 'attack':e.startAttack(values.from,values.to);break;
      case 'roll':if(!game.battle)throw new Error('No battle is in progress.');e.roll();break;
      case 'retreat':if(!game.battle)throw new Error('No battle is in progress.');e.stopAttack();break;
      case 'end':e.endTurn();break;
      default:throw new Error('Unknown multiplayer move.');
    }
  }
  return pack(room,game,game.events.slice(count));
}
export function createRoomService({db,sdk,getUser,onEvents=()=>{}}){
  const {doc,collection,runTransaction,onSnapshot}=sdk;
  const user=()=>{const value=getUser();if(!value)throw new Error('Sign in to play with friends.');return value;};
  const ref=code=>doc(db,'rooms',normalizeRoomCode(code));
  const persist=(tx,target,result)=>{
    tx.set(target,result.room);
    for(const [index,event] of result.events.entries())tx.set(doc(target,'events',event.id),{sequence:result.room.eventCount-result.events.length+index,payload:JSON.stringify(event)});
  };
  return {
    async create(options){
      const account=user();
      for(let attempt=0;attempt<5;attempt++){
        const code=roomCode(),target=ref(code);
        const created=await runTransaction(db,async tx=>{if((await tx.get(target)).exists())return false;tx.set(target,newRoom(code,account,options));return true;});
        if(created)return code;
      }
      throw new Error('Could not reserve a room code. Try again.');
    },
    async join(code){
      const account=user(),target=ref(code);
      await runTransaction(db,async tx=>{const snap=await tx.get(target);if(!snap.exists())throw new Error('Room not found. Check the code.');const old=snap.data(),next=joinRoom(old,account);if(next!==old)tx.set(target,next);});
      return normalizeRoomCode(code);
    },
    async leave(code){const account=user(),target=ref(code);await runTransaction(db,async tx=>{const snap=await tx.get(target);if(!snap.exists())return;tx.set(target,leaveRoom(snap.data(),account.uid));});},
    async start(code){const account=user(),target=ref(code);await runTransaction(db,async tx=>{const snap=await tx.get(target);if(!snap.exists())throw new Error('Room not found.');persist(tx,target,startRoom(snap.data(),account.uid));});},
    async move(code,revision,action,values){const account=user(),target=ref(code);await runTransaction(db,async tx=>{const snap=await tx.get(target);if(!snap.exists())throw new Error('Room not found.');persist(tx,target,moveRoom(snap.data(),account.uid,revision,action,values));});},
    watch(code,onChange,onError,onReport=()=>{}){
      const account=user(),target=ref(code);let count=null;
      const roomStop=onSnapshot(target,snap=>{
        const room=snap.exists()?snap.data():null;
        if(room?.payload){
          const game=readRoomGame(room);
          if(count!==null&&room.eventCount>count)onEvents(code,room,game,game.events.slice(-Math.min(game.events.length,room.eventCount-count)));
          count=room.eventCount;
        }else if(room)count=room.eventCount;
        onChange(room);
      },onError);
      const reportStops=['aiReports','aiReportsV2'].map(source=>onSnapshot(collection(target,source),snapshot=>{
        if(getUser()?.uid!==account.uid)return;
        for(const change of snapshot.docChanges())if(change.type!=='removed')onReport(change.doc.id,{...change.doc.data(),narrationVersion:source==='aiReportsV2'?2:0});
      },onError));
      return ()=>{roomStop();reportStops.forEach(stop=>stop());};
    }
  };
}
