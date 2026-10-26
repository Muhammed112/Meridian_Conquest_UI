import {aiConfig} from './ai-config.js';
import {COMMENTARY_VERSION,CommentaryQueue,commentaryContext,createGeminiGenerator,recentCommentaryTasks} from './commentary.js?v=match-commentary-20261026-1';
import {createRoomService} from './rooms.js';
import {firebaseConfig} from './firebase-config.js';

export const cloudEnabled=Boolean(firebaseConfig?.projectId);
export async function connectCloud({onSession,onCommentary,onError,onAIStatus=()=>{},onLoadState=()=>{},config=firebaseConfig,aiSettings=aiConfig,loadSDK,loadTimeout=30000}){
  if(!config?.projectId)return null;
  const base='https://www.gstatic.com/firebasejs/13.0.0/';
  const [appSDK,authSDK,dbSDK]=await Promise.all(['firebase-app.js','firebase-auth.js','firebase-firestore.js'].map(file=>loadSDK?loadSDK(file):import(base+file)));
  const app=appSDK.initializeApp(config),auth=authSDK.getAuth(app);
  // Configure persistence before restoring an account or allowing sign-in.
  // Refreshes keep the session; closing its tab/window clears the sign-in.
  await authSDK.setPersistence(auth,authSDK.browserSessionPersistence);
  const db=dbSDK.getFirestore(app);
  const {collection,doc,getDocs,query,orderBy,writeBatch,onSnapshot,getDoc,runTransaction,serverTimestamp}=dbSDK;
  let user=null,ready=false,queue=Promise.resolve(),stops=[],generation=0;
  const known=new Set();
  let preference=true;try{preference=globalThis.localStorage?.getItem('meridian-ai-commentary')!=='off';}catch{}
  const reportRef=task=>task.roomCode?doc(db,'rooms',task.roomCode,'aiReportsV2',task.eventId):doc(db,'users',task.uid,'games',task.gameId,'aiReportsV2',task.eventId);
  const narrator=new CommentaryQueue({
    enabled:Boolean(aiSettings.enabled&&preference),
    generate:createGeminiGenerator({app,base,settings:aiSettings,loadSDK}),
    lookup:async task=>{if(user?.uid!==task.uid)return null;const snap=await getDoc(reportRef(task));return snap.exists()?snap.data():null;},
    persist:async(task,text)=>{
      if(user?.uid!==task.uid)return null;
      return runTransaction(db,async tx=>{
        const ref=reportRef(task),snap=await tx.get(ref);if(user?.uid!==task.uid)return null;
        if(snap.exists())return snap.data();
        const result={eventId:task.eventId,eventType:task.context.event.type,text,status:'ready',source:'gemini',model:aiSettings.model,narrationVersion:COMMENTARY_VERSION,authorUid:task.uid,createdAt:serverTimestamp()};
        tx.set(ref,result);return result;
      });
    },
    onReport:(task,result)=>{if(user?.uid===task.uid&&!task.roomCode)onCommentary(task.gameId,task.eventId,result);},
    onStatus:onAIStatus
  });
  const service={
    get user(){return user;},
    get ready(){return ready;},
    reload:()=>loadAccount(user),
    async authenticate(kind,values){
      const email=String(values.get('email')||'').trim(),password=String(values.get('password')||'');
      if(kind==='reset')return authSDK.sendPasswordResetEmail(auth,email);
      if(kind==='signup'){
        const result=await authSDK.createUserWithEmailAndPassword(auth,email,password);
        await authSDK.updateProfile(result.user,{displayName:String(values.get('name')||'Commander').trim()});
        return result;
      }
      return authSDK.signInWithEmailAndPassword(auth,email,password);
    },
    signOut:()=>authSDK.signOut(auth),
    commentary:narrator,
    requestCommentary(game,{roomCode}={}){
      if(!user||!ready)throw new Error('Sign in and wait for your campaign to load.');
      service.setCommentaryEnabled(true);
      const tasks=recentCommentaryTasks(game,{uid:user.uid,roomCode});
      narrator.enqueue(tasks,{retry:true});return tasks.length;
    },
    setCommentaryEnabled(value){
      try{globalThis.localStorage?.setItem('meridian-ai-commentary',value?'on':'off');}catch{}
      narrator.setEnabled(Boolean(aiSettings.enabled&&value));
    },
    save(games){
      if(!user||!ready)return Promise.resolve();
      const uid=user.uid,token=generation,snapshot=JSON.parse(JSON.stringify(games));
      const task=queue.catch(()=>{}).then(async()=>{
        if(token!==generation)return;
        for(const game of snapshot){
          const gameRef=doc(db,'users',uid,'games',game.id);
          const {events,...board}=game;
          const entries=[];
          for(const [sequence,event] of events.entries()){
            const key=game.id+'/'+event.id;if(known.has(key))continue;
            const {commentary,commentaryVersion,...facts}=event;
            const context={event:facts,previousBoard:events[sequence-1]?.board||null,countries:game.countries.map(c=>({code:c.code,name:c.name})),recent:events.slice(Math.max(0,sequence-3),sequence).map(e=>({type:e.type,text:e.text}))};
            entries.push([doc(gameRef,'events',event.id),{sequence,type:event.type,context:JSON.stringify(context),payload:JSON.stringify(facts)},key,{key,uid,gameId:game.id,eventId:event.id,context:commentaryContext(game,event)}]);
          }
          // Publish the board only after all its immutable events are saved.
          entries.push([gameRef,{payload:JSON.stringify(board),updatedAt:game.updatedAt}]);
          for(let offset=0;offset<entries.length;offset+=400){
            if(token!==generation)return;
            const part=entries.slice(offset,offset+400),batch=writeBatch(db);
            for(const [ref,data] of part)batch.set(ref,data);
            await batch.commit();
            if(token!==generation)return;
            for(const [, ,key] of part)if(key)known.add(key);
            narrator.enqueue(part.filter(entry=>entry[3]).map(entry=>entry[3]));
          }
        }
      });
      queue=task;
      return task;
    }
  };
  const watched=new Set();
  function readCampaigns(target){
    let timer;
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error('Campaign loading timed out'),{code:'deadline-exceeded'})),loadTimeout);});
    return Promise.race([getDocs(target),deadline]).finally(()=>clearTimeout(timer));
  }
  async function loadAccount(next){
    const token=++generation;ready=false;user=next;narrator.reset();known.clear();stops.forEach(stop=>stop());stops=[];watched.clear();
    onLoadState({status:'loading'});
    onSession(next,[],false);
    if(!next){ready=true;onSession(null,[],true);onLoadState({status:'ready'});return;}
    try{
      const result=await readCampaigns(collection(db,'users',next.uid,'games'));
      if(token!==generation)return;
      const boards=result.docs.map(record=>({...JSON.parse(record.data().payload),events:[]}));
      // Show the campaign list before a long event history finishes downloading.
      // Gameplay and saving remain locked until the complete history is loaded.
      onSession(next,boards,false);
      const games=await Promise.all(result.docs.map(async(record,index)=>{
        const game=boards[index],eventDocs=await readCampaigns(query(collection(record.ref,'events'),orderBy('sequence')));
        return {...game,events:eventDocs.docs.map(event=>JSON.parse(event.data().payload))};
      }));
      if(token!==generation)return;
      for(const game of games)for(const event of game.events)known.add(game.id+'/'+event.id);
      ready=true;onSession(next,games.sort((a,b)=>b.updatedAt-a.updatedAt),true);
      onLoadState({status:'ready'});
      for(const game of games)subscribe(game.id,token);
    }catch(error){if(token!==generation)return;onLoadState({status:'error',error});onError(error);}
  }
  authSDK.onAuthStateChanged(auth,loadAccount,error=>{onLoadState({status:'error',error});onError(error);});
  function subscribe(id,token=generation){
    const key=token+'/'+id;if(watched.has(key))return;watched.add(key);
    for(const source of ['commentary','aiReports','aiReportsV2'])stops.push(onSnapshot(collection(db,'users',user.uid,'games',id,source),snapshot=>{
      if(token!==generation)return;
      for(const change of snapshot.docChanges())if(change.type!=='removed')onCommentary(id,change.doc.id,{...change.doc.data(),narrationVersion:source==='aiReportsV2'?COMMENTARY_VERSION:0});
    },onError));
  }
  const save=service.save;
  service.save=async games=>{const token=generation;await save(games);if(token===generation&&user&&ready)for(const game of games)subscribe(game.id);};
  service.rooms=createRoomService({db,sdk:dbSDK,getUser:()=>user,onEvents:(code,room,game,events)=>{
    if(user?.uid!==room.hostUid)return;
    narrator.enqueue(events.map(event=>({key:'room/'+code+'/'+event.id,uid:user.uid,roomCode:code,eventId:event.id,context:commentaryContext(game,event)})));
  }});
  return service;
}
