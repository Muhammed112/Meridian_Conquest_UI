import {firebaseConfig} from './firebase-config.js';

export const cloudEnabled=Boolean(firebaseConfig?.projectId);
export async function connectCloud({onSession,onCommentary,onError,config=firebaseConfig,loadSDK}){
  if(!config?.projectId)return null;
  const base='https://www.gstatic.com/firebasejs/12.5.0/';
  const [appSDK,authSDK,dbSDK]=await Promise.all(['firebase-app.js','firebase-auth.js','firebase-firestore.js'].map(file=>loadSDK?loadSDK(file):import(base+file)));
  const app=appSDK.initializeApp(config),auth=authSDK.getAuth(app);
  // Configure persistence before restoring an account or allowing sign-in.
  // Refreshes keep the session; closing its tab/window clears the sign-in.
  await authSDK.setPersistence(auth,authSDK.browserSessionPersistence);
  const db=dbSDK.getFirestore(app);
  const {collection,doc,getDocs,query,orderBy,writeBatch,onSnapshot}=dbSDK;
  let user=null,ready=false,queue=Promise.resolve(),stops=[],generation=0;
  const known=new Set();
  const service={
    get user(){return user;},
    get ready(){return ready;},
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
            const {commentary,...facts}=event;
            const context={event:facts,previousBoard:events[sequence-1]?.board||null,countries:game.countries.map(c=>({code:c.code,name:c.name})),recent:events.slice(Math.max(0,sequence-3),sequence).map(e=>({type:e.type,text:e.text}))};
            entries.push([doc(gameRef,'events',event.id),{sequence,type:event.type,context:JSON.stringify(context),payload:JSON.stringify(facts)},key]);
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
          }
        }
      });
      queue=task;
      return task;
    }
  };
  authSDK.onAuthStateChanged(auth,async next=>{
    const token=++generation;ready=false;user=next;known.clear();stops.forEach(stop=>stop());stops=[];watched.clear();
    onSession(next,[],false);
    if(!next){ready=true;onSession(null,[],true);return;}
    try{
      const result=await getDocs(collection(db,'users',next.uid,'games')),games=[];
      for(const record of result.docs){
        const game=JSON.parse(record.data().payload),eventDocs=await getDocs(query(collection(record.ref,'events'),orderBy('sequence')));
        game.events=eventDocs.docs.map(event=>{known.add(game.id+'/'+event.id);return JSON.parse(event.data().payload);});
        games.push(game);
      }
      if(token!==generation)return;
      ready=true;onSession(next,games.sort((a,b)=>b.updatedAt-a.updatedAt),true);
      for(const game of games)subscribe(game.id,token);
    }catch(error){if(token!==generation)return;onError(error);}
  },onError);
  const watched=new Set();
  function subscribe(id,token=generation){
    const key=token+'/'+id;if(watched.has(key))return;watched.add(key);
    stops.push(onSnapshot(collection(db,'users',user.uid,'games',id,'commentary'),snapshot=>{
      if(token!==generation)return;
      for(const change of snapshot.docChanges())if(change.type!=='removed')onCommentary(id,change.doc.id,change.doc.data());
    },onError));
  }
  const save=service.save;
  service.save=async games=>{const token=generation;await save(games);if(token===generation&&user&&ready)for(const game of games)subscribe(game.id);};
  return service;
}
