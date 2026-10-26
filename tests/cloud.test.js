import test from 'node:test';
import assert from 'node:assert/strict';
import {connectCloud} from '../dist/cloud.js';

async function fixture({persistenceError=null,read=async()=>({docs:[]}),loadTimeout=30000}={}){
  let session,fail=false;
  const writes=[],subscriptions=[],errors=[],sessions=[],loadStates=[];
  const sessionPersistence={type:'SESSION'},authInstance={};
  const ref=(...segments)=>{const path=segments.filter(s=>s!==db).map(s=>s.path||s).join('/');return {path};};
  const db={};
  const sdk={
    initializeApp:()=>({}),getAuth:()=>authInstance,getFirestore:()=>db,
    browserSessionPersistence:sessionPersistence,
    async setPersistence(auth,persistence){
      assert.equal(auth,authInstance);
      assert.equal(persistence,sessionPersistence);
      assert.equal(session,undefined,'Account restoration must wait for session persistence');
      if(persistenceError)throw persistenceError;
    },
    onAuthStateChanged:(_,callback)=>{session=callback;},
    collection:ref,doc:ref,query:value=>value,orderBy:()=>({}),
    getDocs:read,
    onSnapshot:(target)=>{subscriptions.push(target.path);return ()=>{};},
    writeBatch:()=>{
      const batch=[];
      return {set:(target,value)=>batch.push([target.path,value]),commit:async()=>{if(fail)throw new Error('offline');writes.push(batch);}};
    }
  };
  const service=await connectCloud({config:{projectId:'test'},aiSettings:{enabled:false},loadSDK:async()=>sdk,loadTimeout,onSession:(user,games,ready)=>sessions.push({user,games,ready}),onLoadState:state=>loadStates.push(state),onCommentary:()=>{},onError:e=>errors.push(e)});
  return {service,writes,subscriptions,errors,sessions,loadStates,login:uid=>session(uid?{uid}:null),setFailure:value=>{fail=value;}};
}
const game=()=>({id:'g1',updatedAt:123,countries:[{code:'ZA',name:'South Africa'}],events:[{id:'e1',type:'dice',text:'Recorded losses',commentary:'Generated text',board:[{code:'ZA',army:5}]}]});

test('account restoration uses tab-session persistence before accessing private campaigns',async()=>{
  const f=await fixture();await f.login('owner');
  assert.equal(f.service.user.uid,'owner');assert.equal(f.service.ready,true);
});

test('unavailable session persistence prevents authentication startup',async()=>{
  const error=new Error('Session storage unavailable');
  await assert.rejects(fixture({persistenceError:error}),error);
});

test('signed-out clients do not write or subscribe to private campaigns',async()=>{
  const f=await fixture();await f.login(null);await f.service.save([game()]);
  assert.equal(f.writes.length,0);assert.equal(f.subscriptions.length,0);
});
test('campaign events are saved immutably and narration is excluded from model facts',async()=>{
  const f=await fixture();await f.login('owner');await f.service.save([game()]);
  assert.equal(f.writes.length,1);
  const batch=f.writes[0];
  assert.equal(batch[0][0],'users/owner/games/g1/events/e1');
  assert.equal(batch[1][0],'users/owner/games/g1');
  assert.equal(JSON.parse(batch[0][1].payload).commentary,undefined);
  assert.equal(JSON.parse(batch[0][1].context).event.commentary,undefined);
  assert.equal(batch[0][1].sequence,0);
  await f.service.save([game()]);
  assert.equal(f.writes[1].length,1);assert.equal(f.subscriptions.length,3);
});
test('a failed batch can retry its events instead of treating them as already saved',async()=>{
  const f=await fixture();await f.login('owner');f.setFailure(true);
  await assert.rejects(f.service.save([game()]));f.setFailure(false);await f.service.save([game()]);
  assert.equal(f.writes[0][0][0],'users/owner/games/g1/events/e1');
});
test('queued saves from an old account cannot write into a new account',async()=>{
  const f=await fixture();await f.login('old');
  const pending=f.service.save([game()]);await f.login('new');await pending;
  assert.equal(f.writes.length,0);assert.equal(f.subscriptions.length,0);
  await f.service.save([game()]);assert.ok(f.writes[0].every(([path])=>path.startsWith('users/new/')));
});

const savedRecord={ref:{path:'users/owner/games/g1'},data:()=>({payload:JSON.stringify(game())})};
const savedHistory={docs:[{data:()=>({payload:JSON.stringify(game().events[0])})}]};

test('campaign cards load before a long history and saving stays locked until it completes',async()=>{
  let release,started;
  const pending=new Promise(resolve=>{release=resolve;}),loading=new Promise(resolve=>{started=resolve;});
  const f=await fixture({read:async target=>{if(target.path.endsWith('/games'))return {docs:[savedRecord]};started();return pending;}});
  const login=f.login('owner');await loading;
  assert.equal(f.service.ready,false);
  assert.equal(f.sessions.at(-1).games[0].id,'g1');assert.deepEqual(f.sessions.at(-1).games[0].events,[]);
  await f.service.save([game()]);assert.equal(f.writes.length,0);
  release(savedHistory);await login;
  assert.equal(f.service.ready,true);assert.equal(f.sessions.at(-1).games[0].events[0].id,'e1');
});

test('failed history loads report an error without claiming an empty account and can be retried',async()=>{
  let failed=true;
  const f=await fixture({read:async target=>{if(target.path.endsWith('/games'))return {docs:[savedRecord]};if(failed)throw Object.assign(new Error('Offline'),{code:'unavailable'});return savedHistory;}});
  await f.login('owner');assert.equal(f.service.ready,false);assert.equal(f.loadStates.at(-1).status,'error');
  assert.equal(f.sessions.at(-1).games[0].id,'g1');assert.equal(f.sessions.some(s=>s.ready),false);
  await f.service.save([game()]);assert.equal(f.writes.length,0);
  failed=false;await f.service.reload();assert.equal(f.loadStates.at(-1).status,'ready');assert.equal(f.service.ready,true);
  await f.service.save([game()]);assert.equal(f.writes[0].length,1,'Previously saved events must not be rewritten after retry');
});

test('a late campaign response from a previous account is never displayed for the next account',async()=>{
  let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=await fixture({read:async target=>target.path.startsWith('users/old/')?pending:{docs:[]}});
  const old=f.login('old');await f.login('new');const count=f.sessions.length;
  release({docs:[savedRecord]});await old;
  assert.equal(f.sessions.length,count);assert.equal(f.service.user.uid,'new');assert.deepEqual(f.sessions.at(-1).games,[]);
});

test('a stalled campaign read becomes a retryable error and its late response cannot replace a retry',async()=>{
  let release,blocked=true;
  const pending=new Promise(resolve=>{release=resolve;});
  const f=await fixture({loadTimeout:5,read:async()=>blocked?pending:{docs:[]}});
  await f.login('owner');assert.equal(f.service.ready,false);assert.equal(f.loadStates.at(-1).error.code,'deadline-exceeded');
  blocked=false;await f.service.reload();const count=f.sessions.length;
  release({docs:[savedRecord]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.sessions.length,count);assert.equal(f.service.ready,true);assert.deepEqual(f.sessions.at(-1).games,[]);
});
