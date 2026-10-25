// Explicit live integration test: creates two temporary accounts and removes
// only those accounts and the exact test documents in finally.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {firebaseConfig} from '../dist/firebase-config.js';
import {GameEngine} from '../dist/engine.js';

const config=firebaseConfig;
if(!config?.projectId)throw new Error('Firebase is not configured');
const base=`https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
const users=[],documents=[];
async function request(url,{token,method='GET',body,status=200}={}){
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));
  assert.equal(response.status,status,`${method} ${new URL(url).pathname}: ${data.error?.message||response.status}`);
  return data;
}
const auth=(action,body)=>request(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`,{method:'POST',body});
const fields=value=>Object.fromEntries(Object.entries(value).map(([key,item])=>[key,typeof item==='number'?{integerValue:String(item)}:{stringValue:item}]));
async function main(){
  try{
    for(let n=0;n<2;n++){
      const credentials={email:`meridian-check-${randomUUID()}@example.invalid`,password:randomUUID()+'Aa1!',returnSecureToken:true};
      const result=await auth('signUp',credentials);users.push({...result,credentials});
    }
    const [owner,other]=users;
    const signedIn=await auth('signInWithPassword',owner.credentials);
    assert.equal(signedIn.localId,owner.localId);
    console.log('PASS: email/password signup and sign-in');
    const game=GameEngine.create('Temporary integration check','ZA');
    const {events,...board}=game;
    const gamePath=`users/${owner.localId}/games/${game.id}`;
    documents.push(gamePath);
    await request(`${base}/${gamePath}`,{token:owner.idToken,method:'PATCH',body:{fields:fields({payload:JSON.stringify(board),updatedAt:game.updatedAt})}});
    const saved=await request(`${base}/${gamePath}`,{token:signedIn.idToken});
    assert.equal(JSON.parse(saved.fields.payload.stringValue).id,game.id);
    console.log('PASS: campaign save and reload');
    for(const token of [undefined,other.idToken]){
      await request(`${base}/${gamePath}`,{token,status:403});
      await request(`${base}/${gamePath}`,{token,method:'PATCH',body:{fields:fields({payload:'{}',updatedAt:1})},status:403});
    }
    console.log('PASS: visitors and other accounts cannot read or change the campaign');
    const event=events[0],eventPath=gamePath+'/events/'+event.id;
    documents.push(eventPath);
    const eventBody={fields:fields({sequence:0,type:event.type,context:JSON.stringify({event}),payload:JSON.stringify(event)})};
    await request(`${base}/${eventPath}`,{token:owner.idToken,method:'PATCH',body:eventBody});
    await request(`${base}/${eventPath}`,{token:owner.idToken,method:'PATCH',body:eventBody,status:403});
    const history=await request(`${base}/${gamePath}:runQuery`,{token:owner.idToken,method:'POST',body:{structuredQuery:{from:[{collectionId:'events'}],orderBy:[{field:{fieldPath:'sequence'},direction:'ASCENDING'}]}}});
    assert.equal(JSON.parse(history[0].document.fields.payload.stringValue).id,event.id);
    console.log('PASS: ordered event history loads and existing events cannot be overwritten');
    await request(`${base}/${gamePath}/commentary/${event.id}`,{token:owner.idToken,method:'PATCH',body:{fields:fields({status:'ready',text:'Forged commentary'})},status:403});
    console.log('PASS: clients cannot forge server commentary');
  }finally{
    let cleanupError;
    try{
      if(documents.length){
        const require=createRequire(import.meta.url);
        const cliAuth=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
        const account=cliAuth.getGlobalDefaultAccount();
        const token=await cliAuth.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform']);
        for(const doc of documents.reverse())await request(`${base}/${doc}`,{token:token.access_token,method:'DELETE'});
      }
    }catch(error){cleanupError=error;}
    for(const user of users){
      try{await auth('delete',{idToken:user.idToken});}catch(error){cleanupError??=error;}
    }
    if(cleanupError)throw cleanupError;
    console.log('Temporary test accounts and documents removed.');
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
