import test from 'node:test';
import assert from 'node:assert/strict';
import {connectCloud} from '../dist/cloud.js';

async function fixture({persistenceError=null}={}){
  let session,fail=false;
  const writes=[],subscriptions=[],errors=[];
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
    getDocs:async()=>({docs:[]}),
    onSnapshot:(target)=>{subscriptions.push(target.path);return ()=>{};},
    writeBatch:()=>{
      const batch=[];
      return {set:(target,value)=>batch.push([target.path,value]),commit:async()=>{if(fail)throw new Error('offline');writes.push(batch);}};
    }
  };
  const service=await connectCloud({config:{projectId:'test'},loadSDK:async()=>sdk,onSession:()=>{},onCommentary:()=>{},onError:e=>errors.push(e)});
  return {service,writes,subscriptions,errors,login:uid=>session(uid?{uid}:null),setFailure:value=>{fail=value;}};
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
  assert.equal(f.writes[1].length,1);assert.equal(f.subscriptions.length,1);
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
