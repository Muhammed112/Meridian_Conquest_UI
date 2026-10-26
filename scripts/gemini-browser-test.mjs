// Real Gemini integration check with one temporary user and a short-lived
// App Check debug attestation. No key or token is printed or saved to disk.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {firebaseConfig as config} from '../dist/firebase-config.js';
import {aiConfig} from '../dist/ai-config.js';
import {GameEngine} from '../dist/engine.js';
const require=createRequire(import.meta.url),cli=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
const {chromium}=require(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
const account=cli.getGlobalDefaultAccount(),admin=(await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform'])).access_token;
const base=`https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
const appCheck=`https://firebaseappcheck.googleapis.com/v1/projects/126865630748/apps/${encodeURIComponent(config.appId)}`;
const fields=value=>Object.fromEntries(Object.entries(value).map(([k,v])=>[k,typeof v==='number'?{integerValue:String(v)}:{stringValue:v}]));
let user,browser,server,debugName,gamePath;const debugToken=randomUUID(),errors=[];let requests=0;
async function api(url,{method='GET',token,body,status=200}={}){
 const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({}));
 assert.equal(response.status,status,`${new URL(url).pathname}: ${data.error?.message||response.status}`);return data;
}
const auth=(action,body)=>api(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`,{method:'POST',body});
try{
 if(!process.env.GEMINI_TEST_STANDARD_APPCHECK){const debug=await api(appCheck+'/debugTokens',{method:'POST',token:admin,body:{displayName:'Temporary Gemini integration check',token:debugToken}});debugName=debug.name;}
 const credentials={email:`meridian-gemini-${randomUUID()}@example.invalid`,password:randomUUID()+'Aa1!',returnSecureToken:true};user=await auth('signUp',credentials);
 const game=GameEngine.create('Gemini integration check','ZA',true);game.round=1;game.position=game.order.indexOf(0);game.turnStarted=false;game.events=[];const engine=new GameEngine(game);engine.beginTurn();engine.event('decision','South Africa prepares to challenge an opposing country.');
 const {events,...board}=game;gamePath=`users/${user.localId}/games/${game.id}`;
 await api(base+'/'+gamePath,{method:'PATCH',token:user.idToken,body:{fields:fields({payload:JSON.stringify(board),updatedAt:game.updatedAt})}});
 for(const [sequence,event] of events.entries())await api(base+'/'+gamePath+'/events/'+event.id,{method:'PATCH',token:user.idToken,body:{fields:fields({sequence,type:event.type,context:JSON.stringify({event}),payload:JSON.stringify(event)})}});
 const legacyText='South Africa prepares an attack.',legacyEvent=events.at(-1);
 await api(base+'/'+gamePath+'/aiReports/'+legacyEvent.id,{method:'PATCH',token:admin,body:{fields:fields({eventId:legacyEvent.id,eventType:legacyEvent.type,text:legacyText,status:'ready',source:'gemini',model:'gemini-3.5-flash-lite',authorUid:user.localId})}});
 const root=path.resolve('dist');server=createServer(async(req,res)=>{
  try{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}const target=file===root?path.join(root,'index.html'):file;res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.ogg':'audio/ogg','.mp3':'audio/mpeg'}[path.extname(target)]||'application/octet-stream'});res.end(await readFile(target));}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 await page.addInitScript(token=>{if(token)window.FIREBASE_APPCHECK_DEBUG_TOKEN=token;Math.random=()=>0.01;},process.env.GEMINI_TEST_STANDARD_APPCHECK?null:debugToken);
 page.on('request',async request=>{
  if(request.url().includes('firebasevertexai.googleapis.com')&&request.url().includes('generateContent')){
   console.log('Gemini request started.');
   const headers=await request.allHeaders().catch(()=>null);if(!headers)return;
   if(!headers['x-firebase-appcheck']||!headers.authorization?.startsWith('Firebase '))errors.push({request:'Missing AI request attestation or sign-in'});
  }
 });
 page.on('response',async response=>{
  if(['firebasevertexai.googleapis.com','firebaseappcheck.googleapis.com','firebaseinstallations.googleapis.com'].includes(new URL(response.url()).host)){
   if(response.status()>=400){const data=await response.json().catch(()=>({}));errors.push({status:response.status(),message:data.error?.message});console.log('Gemini/Firebase request error:',response.status(),data.error?.message);}
  }
  if(response.url().includes('firebasevertexai.googleapis.com')&&response.url().includes('generateContent'))requests++;
 });
 page.on('pageerror',error=>errors.push({browser:error.message}));
 page.on('requestfailed',request=>{if(request.url().includes('gstatic.com/firebasejs'))errors.push({request:new URL(request.url()).pathname,error:request.failure()?.errorText});});
 const origin=process.env.GEMINI_TEST_ORIGIN||'http://localhost:'+server.address().port;
 await page.goto(origin+'/#signin');
 try{await page.waitForFunction(()=>{const submit=document.querySelector('#auth-form button[type="submit"]');return submit&&!submit.disabled;});}
 catch(error){
  const detail=await page.evaluate(async()=>{try{const {connectCloud}=await import('./cloud.js');await connectCloud({onSession(){},onCommentary(){},onError(){}});return 'connected';}catch(error){return error.message;}});
  console.log('Sign-in initialization:',JSON.stringify(errors),detail);throw error;
 }
 await page.locator('#email').fill(credentials.email);await page.locator('#password').fill(credentials.password);await page.locator('#auth-form button[type="submit"]').click();await page.waitForURL('**/#campaigns');
 await page.locator(`a[href="#game/${game.id}"]`).first().waitFor();
 await page.goto(origin+'/#game/'+game.id);
 try{await page.locator('[data-action="start-attack"]').waitFor();}
 catch(error){console.log('Campaign display:',await page.locator('#app').innerText(),JSON.stringify(errors));throw error;}
 assert.equal(requests,0);
 console.log('PASS: loading a saved campaign does not generate historical commentary');
 await page.locator('.activity-copy .ai-commentary').filter({hasText:legacyText}).waitFor();
 await page.locator('[data-action="request-commentary"]').click();
 try{await page.waitForFunction(({uid,eventId})=>JSON.parse(localStorage.getItem('meridian-cloud-cache-'+uid))?.some(game=>game.events.some(event=>event.id===eventId&&event.commentaryVersion===2)),{uid:user.localId,eventId:legacyEvent.id},{timeout:120000});}
 catch(error){console.log('Gemini response errors:',JSON.stringify(errors));await page.locator('[data-action="settings"]').click();console.log('AI status:',await page.locator('#ai-status').textContent());throw error;}
 const legacy=await api(base+'/'+gamePath+'/aiReports/'+legacyEvent.id,{token:user.idToken});assert.equal(legacy.fields.text.stringValue,legacyText);
 console.log('PASS: Generate commentary upgrades a legacy report while preserving the original');
 await page.locator('[data-action="start-attack"]').click();
 await page.evaluate(async()=>{const {BattleEngine}=await import('./engine.js');const original=BattleEngine.resolve;BattleEngine.resolve=(attacker,defender)=>{BattleEngine.resolve=original;const values=[1,6,6,1,6,1,3,3];return original(attacker,defender,()=>values.shift()||3);};});
 await page.locator('[data-action="roll"]').click();
 assert.match(await page.locator('.action-panel').innerText(),/Results appear when they settle/);
 assert.doesNotMatch(await page.locator('.activity-feed').innerText(),/loses 1|loses 2/);
 await page.waitForFunction(()=>document.querySelector('.action-panel .commentary')?.textContent.includes('South Africa lost 1'));
 console.log('PASS: army losses and field reports reveal only after the dice settle');
 try{await page.waitForFunction(()=>[...document.querySelectorAll('.activity-copy .ai-commentary')].filter(node=>node.textContent.includes('AI commentary:')).length>=3,null,{timeout:90000});}
 catch(error){console.log('Gemini response errors:',JSON.stringify(errors));await page.locator('[data-action="settings"]').click();console.log('AI status:',await page.locator('#ai-status').textContent());throw error;}
 const reports=await api(base+'/'+gamePath+'/aiReportsV2',{token:user.idToken});assert.ok(reports.documents.length>=3);
 assert.ok(reports.documents.every(doc=>doc.fields.model.stringValue===aiConfig.model&&doc.fields.narrationVersion.integerValue==='2'));
 console.log('PASS: real Gemini attack and dice reports appear and are saved separately from the game');
 for(const doc of reports.documents)console.log('New commentary ['+doc.fields.eventType.stringValue+']:',doc.fields.text.stringValue);
 const previous=requests;await page.reload();await page.waitForFunction(()=>[...document.querySelectorAll('.activity-copy .ai-commentary')].filter(node=>node.textContent.includes('AI commentary:')).length>=3);
 assert.equal(requests,previous);console.log('PASS: reload reuses saved Gemini reports without new generation');
 await page.locator('[data-action="settings"]').click();await page.locator('#ai-enabled').uncheck();await page.locator('[data-action="close-settings"]').click();
 await page.locator('[data-action="roll"]').click();assert.equal(requests,previous);
 console.log('PASS: commentary can be turned off while battle controls keep working');
 assert.deepEqual(errors,[]);
}finally{
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
 let failure;
 try{if(gamePath){for(const group of ['events','aiReports','aiReportsV2','commentary']){const result=await api(base+'/'+gamePath+'/'+group+'?pageSize=100',{token:admin});for(const doc of result.documents||[])await api('https://firestore.googleapis.com/v1/'+doc.name,{method:'DELETE',token:admin});}await api(base+'/'+gamePath,{method:'DELETE',token:admin});}}catch(error){failure=error;}
 if(user)try{await auth('delete',{idToken:user.idToken});}catch(error){failure??=error;}
 if(debugName)try{await api('https://firebaseappcheck.googleapis.com/v1/'+debugName,{method:'DELETE',token:admin});}catch(error){failure??=error;}
 if(failure)throw failure;console.log('Temporary campaign, reports, account and test attestation removed.');
}
