// Read-only reproduction of a saved campaign in an isolated browser profile.
// Firebase administrator credentials and campaign data remain in memory.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const require=createRequire(import.meta.url);
const {chromium}=require(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
const cli=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
const account=cli.getGlobalDefaultAccount(),token=(await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform'])).access_token;
const gamePath=process.env.CAMPAIGN_TEST_PATH;
assert.match(gamePath||'',/^users\/[A-Za-z0-9_-]+\/games\/[A-Za-z0-9_-]+$/,'Set CAMPAIGN_TEST_PATH to users/<owner uid>/games/<campaign id>');
const base='https://firestore.googleapis.com/v1/projects/meridian-conquest-m112/databases/(default)/documents/'+gamePath;
async function read(url,body){const res=await fetch(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await res.json();assert.ok(res.ok,data.error?.message);return data;}
const [document,history]=await Promise.all([read(base),read(base+':runQuery',{structuredQuery:{from:[{collectionId:'events'}],orderBy:[{field:{fieldPath:'sequence'},direction:'ASCENDING'}]}})]);
const game=JSON.parse(document.fields.payload.stringValue);game.events=history.filter(row=>row.document).map(row=>JSON.parse(row.document.fields.payload.stringValue));
const root=path.resolve('dist');let browser;
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}const target=file===root?path.join(root,'index.html'):file;res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg'}[path.extname(target)]||'application/octet-stream'});res.end(await readFile(target));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/firebase-config.js',route=>route.fulfill({contentType:'text/javascript',body:'export const firebaseConfig=null;'}));
 await page.addInitScript(game=>localStorage.setItem('meridian-conquest-ui-v2',JSON.stringify([game])),game);
 const origin='http://localhost:'+server.address().port;
 await page.goto(origin+'/#campaigns');await page.locator('.campaign-card').waitFor();assert.ok((await page.locator('.campaign-card').innerText()).includes(game.name));
 await page.locator(`a[href="#game/${game.id}"]`).click();await page.locator('.game-heading').waitFor();await page.reload();await page.locator('.game-heading').waitFor();
 assert.deepEqual(errors,[]);console.log(`PASS: existing saved campaign renders its card, board and reload with ${game.events.length} events`);
 await page.close();
 const cloudPage=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});
 cloudPage.on('pageerror',error=>errors.push(error.message));
 const source=await readFile(path.join(root,'cloud.js'),'utf8');
 const {events,...board}=game;
 const fixture=`
 import {connectCloud as realConnect} from './cloud-under-test.js';
 export const cloudEnabled=true;
 const board=${JSON.stringify(board)},events=${JSON.stringify(events)},db={};
 const ref=(...parts)=>({path:parts.filter(p=>p!==db).map(p=>p.path||p).join('/')});
 window.campaignHistoryMode=sessionStorage.getItem('campaign-history-mode')||'hold';window.campaignWrites=0;
 const user={uid:'campaign-loading-check',email:'campaign-owner@example.invalid',displayName:'Commander'};
 const sdk={initializeApp:()=>({}),getAuth:()=>({}),getFirestore:()=>db,browserSessionPersistence:{},setPersistence:async()=>{},
 onAuthStateChanged:(_,callback)=>{queueMicrotask(()=>callback(user));},doc:ref,collection:ref,query:r=>r,orderBy:()=>({}),
 getDocs:async target=>{
  if(target.path.endsWith('/games'))return {docs:[{ref:ref(db,'users',user.uid,'games',board.id),data:()=>({payload:JSON.stringify(board)})}]};
  while(window.campaignHistoryMode==='hold')await new Promise(resolve=>setTimeout(resolve,25));
  if(window.campaignHistoryMode==='fail')throw Object.assign(new Error('Temporary connection failure'),{code:'unavailable'});
  return {docs:events.map(event=>({data:()=>({payload:JSON.stringify(event)})}))};
 },onSnapshot:()=>()=>{},writeBatch:()=>({set(){},async commit(){window.campaignWrites++;}})};
 export function connectCloud(options){return realConnect({...options,aiSettings:{enabled:false},loadSDK:async()=>sdk});}
 `;
 await cloudPage.route('**/cloud.js*',route=>route.fulfill({contentType:'text/javascript',body:fixture}));
 await cloudPage.route('**/cloud-under-test.js',route=>route.fulfill({contentType:'text/javascript',body:source}));
 await cloudPage.goto(origin+'/#campaigns');
 await cloudPage.locator('.campaign-card').waitFor();
 assert.match(await cloudPage.locator('#app').innerText(),/Loading your saved campaigns/);
 assert.equal(await cloudPage.getByText('No campaigns in sight.',{exact:true}).count(),0);
 assert.equal(await cloudPage.evaluate(()=>window.campaignWrites),0);
 await cloudPage.evaluate(()=>{window.campaignHistoryMode='fail';});
 await cloudPage.getByRole('button',{name:'Retry loading'}).waitFor();
 assert.equal(await cloudPage.locator('.campaign-card').count(),1);assert.equal(await cloudPage.evaluate(()=>window.campaignWrites),0);
 console.log('PASS: slow/failed cloud history keeps the campaign visible, shows the actual load state and makes no save writes');
 await cloudPage.evaluate(()=>{window.campaignHistoryMode='pass';});
 await cloudPage.getByRole('button',{name:'Retry loading'}).click();
 await cloudPage.waitForFunction(count=>JSON.parse(localStorage.getItem('meridian-cloud-cache-campaign-loading-check'))?.[0]?.events.length===count,events.length);
 await cloudPage.locator(`a[href="#game/${game.id}"]`).click();await cloudPage.locator('.game-heading').waitFor();
 await cloudPage.evaluate(()=>sessionStorage.setItem('campaign-history-mode','hold'));await cloudPage.reload();
 await cloudPage.locator('.campaign-card').waitFor();
 assert.equal(await cloudPage.evaluate(()=>JSON.parse(localStorage.getItem('meridian-cloud-cache-campaign-loading-check'))[0].events.length),game.events.length);
 assert.equal(await cloudPage.evaluate(()=>window.campaignWrites),0);
 await cloudPage.evaluate(()=>{window.campaignHistoryMode='pass';});await cloudPage.locator('.game-heading').waitFor();
 assert.deepEqual(errors,[]);console.log('PASS: retry restores complete history and reload preserves the account recovery cache');
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
