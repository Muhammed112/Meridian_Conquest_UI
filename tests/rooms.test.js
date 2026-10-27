import test from 'node:test';
import assert from 'node:assert/strict';
import {newRoom,joinRoom,leaveRoom,startRoom,moveRoom,roomCode,normalizeRoomCode,readRoomGame} from '../dist/rooms.js';
const host={uid:'host',displayName:'Host'},friend={uid:'friend',displayName:'Friend'};
const lobby=()=>joinRoom(newRoom('ABC234',host),friend);
function started(seat=0){
  const result=startRoom(lobby(),'host');
  const game=JSON.parse(result.room.payload);game.position=game.order.indexOf(seat);game.budget=0;game.battle=null;game.attackUsed=false;
  return {...result.room,currentSeat:seat,controllerUid:seat<2?['host','friend'][seat]:'host',payload:JSON.stringify(game)};
}

test('room codes are six unambiguous characters and pasted codes normalize',()=>{
  assert.match(roomCode(),/^[A-HJ-NP-Z2-9]{6}$/);assert.equal(normalizeRoomCode(' abc234 '),'ABC234');
  for(const code of ['ABCD','ABC01I','ABC234/other','<html>'])assert.throws(()=>normalizeRoomCode(code));
});

test('account nicknames carry over to the lobby, started game and room reload for hosts and friends',()=>{
  const namedHost={uid:'host',displayName:'Meridian Goat'},namedFriend={uid:'friend',displayName:'Night Owl'};
  const room=joinRoom(newRoom('ABC234',namedHost),namedFriend);
  assert.equal(room.members.host.name,'Meridian Goat');assert.equal(room.members.friend.name,'Night Owl');
  const started=startRoom(room,'host').room,game=readRoomGame(started);
  assert.deepEqual(game.playerNames.slice(0,2),['Meridian Goat','Night Owl']);
  assert.ok(game.events[0].text.startsWith(game.playerNames[game.events[0].player]));
  namedFriend.displayName='Future nickname';
  assert.equal(readRoomGame(started).playerNames[1],'Night Owl','Existing matches retain the recorded nickname');
  assert.equal(joinRoom(newRoom('BCD345',namedHost),namedFriend).members.friend.name,'Future nickname');
});
test('friends join once, capacity is ten, and host start fills remaining countries with bots',()=>{
  let room=newRoom('ABC234',host);
  for(let n=1;n<10;n++)room=joinRoom(room,{uid:'p'+n,displayName:'Player '+n});
  assert.equal(joinRoom(room,host),room);assert.throws(()=>joinRoom(room,friend),/full/);
  const full=startRoom(room,host.uid),g=JSON.parse(full.room.payload);
  assert.equal(full.room.memberIds.length,10);assert.equal(g.countries.length,10);assert.equal(new Set(g.countries.map(c=>c.code)).size,10);
  assert.ok(g.playerNames.every(name=>!name.startsWith('Bot ')));
  const partial=startRoom(lobby(),host.uid),partialGame=JSON.parse(partial.room.payload);
  assert.equal(partialGame.playerNames.filter(name=>name.startsWith('Bot ')).length,8);
  assert.equal(partialGame.playerNames[1],'Friend');assert.equal(partialGame.mode,'multiplayer');
});
test('only the host starts a lobby and already-started rooms admit only existing players',()=>{
  assert.throws(()=>startRoom(lobby(),friend.uid),/host/);
  const room=started();assert.equal(joinRoom(room,friend),room);
  assert.throws(()=>joinRoom(room,{uid:'stranger'}),/already started/);
  assert.throws(()=>startRoom(room,host.uid),/already started/);
});
test('leaving a lobby removes only that player; host closure prevents further joining',()=>{
  const room=leaveRoom(lobby(),friend.uid);assert.deepEqual(room.memberIds,['host']);assert.equal(room.members.friend,undefined);
  const closed=leaveRoom(lobby(),host.uid);assert.equal(closed.status,'closed');assert.throws(()=>joinRoom(closed,friend),/closed/);
  assert.throws(()=>leaveRoom(started(),friend.uid),/keep your seat/);
});
test('stale, out-of-turn and bot-impersonation moves cannot modify the shared game',()=>{
  const room=started(1),original=JSON.stringify(room);
  assert.throws(()=>moveRoom(room,'host',room.revision,'end'),/Wait/);
  assert.throws(()=>moveRoom(room,'friend',room.revision-1,'end'),/changed/);
  assert.throws(()=>moveRoom(room,'friend',room.revision,'bot'),/Unknown/);
  assert.equal(JSON.stringify(room),original);
  const bots=started(2);assert.throws(()=>moveRoom(bots,'host',bots.revision,'roll'),/host controls/);
  const result=moveRoom(bots,'host',bots.revision,'bot');assert.equal(result.room.revision,bots.revision+1);assert.ok(result.events.length>0);
});
test('a friend can reinforce and attack using their own country rather than host seat zero',()=>{
  let room=started(1),game=JSON.parse(room.payload);game.budget=2;
  room={...room,payload:JSON.stringify(game)};
  const own=game.countries.find(c=>c.owner===1),enemy=game.countries.find(c=>c.owner!==1);
  let result=moveRoom(room,'friend',room.revision,'reinforce',{allocations:{[own.code]:2}});room=result.room;
  assert.equal(JSON.parse(room.payload).countries.find(c=>c.code===own.code).army,own.army+2);
  result=moveRoom(room,'friend',room.revision,'attack',{from:own.code,to:enemy.code});
  assert.equal(JSON.parse(result.room.payload).battle.from,own.code);
  assert.equal(result.events[0].player,1);
  assert.throws(()=>moveRoom(room,'friend',room.revision,'attack',{from:enemy.code,to:own.code}),/owned country/);
});
test('host elimination does not end a multiplayer match with other surviving friends',()=>{
  const room=started(1),game=JSON.parse(room.payload);
  for(const country of game.countries)if(country.owner===0)country.owner=1;
  const result=moveRoom({...room,payload:JSON.stringify(game)},'friend',room.revision,'end');
  assert.equal(result.room.status,'playing');assert.equal(JSON.parse(result.room.payload).status,'active');
});
test('event history in the room stays bounded while total sequence advances',()=>{
  const room=started(1),game=JSON.parse(room.payload),event=game.events[0];
  game.events=Array.from({length:80},(_,i)=>({...event,id:'old-'+i}));
  const source={...room,payload:JSON.stringify(game),eventCount:100};
  const result=moveRoom(source,'friend',source.revision,'end');
  assert.equal(JSON.parse(result.room.payload).events.length,80);assert.equal(result.room.eventCount,101);assert.equal(result.events.length,1);
});

test('shared country flags, names and geometry come from the local catalogue',()=>{
  const room=started(),g=JSON.parse(room.payload);g.countries[0].flag='<img src=x onerror=alert(1)>';g.countries[0].name='Fake country';g.countries[0].lon='bad coordinates';
  const safe=readRoomGame({...room,payload:JSON.stringify(g)});
  assert.equal(safe.countries[0].name,'South Africa');assert.equal(safe.countries[0].lon,25);assert.ok(!safe.countries[0].flag.includes('<'));
});
test('malformed shared armies and controller/board mismatches are rejected before display',()=>{
  const room=started(),g=JSON.parse(room.payload);g.countries[0].army='<img src=x onerror=alert(1)>';
  assert.throws(()=>readRoomGame({...room,payload:JSON.stringify(g)}),/invalid game/);
  assert.throws(()=>readRoomGame({...room,currentSeat:9}),/invalid game/);
});
