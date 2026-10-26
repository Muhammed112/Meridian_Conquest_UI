// Live browser integration check. Creates temporary accounts/rooms and cleans up
// only its own Firestore documents and Firebase Authentication accounts.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {firebaseConfig as config} from '../dist/firebase-config.js';
const require=createRequire(import.meta.url);
const {chromium}=require(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
const users=[],errors=[];let browser,server,roomCode='',debugName,admin;
const appCheck=`https://firebaseappcheck.googleapis.com/v1/projects/126865630748/apps/${encodeURIComponent(config.appId)}`;
const debugToken=randomUUID();
const base=`https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents`;
async function api(url,{method='GET',body,token,status=200}={}){
  const response=await fetch(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});
  const data=await response.json().catch(()=>({}));assert.equal(response.status,status,`${new URL(url).pathname}: ${data.error?.message||response.status}`);return data;
}
const auth=(action,body)=>api(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${config.apiKey}`,{method:'POST',body});
try{
  const cli=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
  const account=cli.getGlobalDefaultAccount();admin=(await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform'])).access_token;
  debugName=(await api(appCheck+'/debugTokens',{method:'POST',token:admin,body:{displayName:'Temporary multiplayer Gemini check',token:debugToken}})).name;
  for(const name of ['Host Check','Friend Check']){
    const credentials={email:`meridian-room-${randomUUID()}@example.invalid`,password:randomUUID()+'Aa1!',returnSecureToken:true};
    const result=await auth('signUp',credentials);users.push({...result,credentials});await auth('update',{idToken:result.idToken,displayName:name});
  }
  const root=path.resolve('dist');
  server=createServer(async(req,res)=>{
    try{
      const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
      if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
      const target=file===root?path.join(root,'index.html'):file;
      const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg'};
      res.writeHead(200,{'Content-Type':types[path.extname(target)]||'application/octet-stream'});res.end(await readFile(target));
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=process.env.MULTIPLAYER_TEST_ORIGIN||'http://localhost:'+server.address().port;
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const contexts=await Promise.all([browser.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),browser.newContext({ignoreHTTPSErrors:true,viewport:{width:390,height:844}})]);
  const pages=await Promise.all(contexts.map(c=>c.newPage()));
  for(const page of pages)page.on('pageerror',error=>errors.push(error.message));
  await pages[0].addInitScript(token=>{window.FIREBASE_APPCHECK_DEBUG_TOKEN=token;Math.random=()=>0.15;},debugToken);
  let friendAIRequests=0;
  pages[1].on('request',request=>{if(request.url().includes('firebasevertexai.googleapis.com')&&request.url().includes('generateContent'))friendAIRequests++;});
  for(let i=0;i<2;i++){
    const page=pages[i];await page.goto(origin+'/#signin');
    await page.waitForFunction(()=>{const node=document.querySelector('#auth-form button[type="submit"]');return node&&!node.disabled;});
    await page.locator('#email').fill(users[i].credentials.email);await page.locator('#password').fill(users[i].credentials.password);
    await page.locator('#auth-form button[type="submit"]').click();try{await page.waitForURL('**/#campaigns');}catch(error){console.log('Sign-in error:',await page.locator('#form-error').textContent().catch(()=>''),'Browser errors:',errors);throw error;}
    await page.goto(origin+'/#multiplayer');await page.locator('[data-room-form="create"]').waitFor();
  }
  console.log('PASS: desktop and mobile users sign in and open multiplayer');
  const [host,friend]=pages;
  await host.locator('[data-room-form="create"] input[name="name"]').fill('Browser room check');
  await host.locator('[data-room-form="create"] button').click();
  await host.locator('.room-code-bar strong').waitFor();roomCode=await host.locator('.room-code-bar strong').innerText();
  assert.match(roomCode,/^[A-HJ-NP-Z2-9]{6}$/);
  await friend.locator('[data-room-form="join"] input').fill(roomCode.toLowerCase());await friend.locator('[data-room-form="join"] button').click();
  await friend.locator('.room-seats').waitFor();
  await host.waitForFunction(()=>document.querySelectorAll('.room-seat:not(.room-bot)').length===2);
  assert.equal(await host.locator('.room-bot').count(),8);assert.equal(await friend.locator('[data-room-action="start"]').count(),0);
  console.log('PASS: code joining updates both lobbies and reserves eight bot seats');
  const lobbyRecord=await api(`${base}/rooms/${roomCode}`,{token:users[0].idToken});
  await api(`${base}/rooms/${roomCode}`,{status:403});
  const forged=structuredClone(lobbyRecord.fields);
  forged.members.mapValue.fields[users[0].localId].mapValue.fields.name.stringValue='Impersonated host';
  forged.revision.integerValue=String(Number(forged.revision.integerValue)+1);
  await api(`${base}/rooms/${roomCode}`,{token:users[1].idToken,method:'PATCH',body:{fields:forged},status:403});
  console.log('PASS: anonymous room reads and another member impersonation are denied');
  await host.locator('[data-room-action="start"]').click();
  await friend.locator('.room-country').first().waitFor();await host.locator('.room-country').first().waitFor();
  assert.equal(await friend.locator('.room-country').count(),10);
  await friend.locator('[data-room-form="attack"]').waitFor();
  assert.equal(await host.locator('[data-room-form="attack"]').count(),0);
  const record=await api(`${base}/rooms/${roomCode}`,{token:users[0].idToken});
  await api(`${base}/rooms/${roomCode}`,{token:users[0].idToken,method:'PATCH',body:{fields:record.fields},status:403});
  console.log('PASS: only the active friend has controls; Firestore denies an out-of-turn host write');
  await friend.locator('[data-room-form="attack"] button').click();await friend.locator('[data-room-action="roll"]').waitFor();
  await friend.locator('[data-room-action="roll"]').click();await friend.locator('.room-dice').waitFor();
  await host.locator('.room-dice').waitFor();
  console.log('PASS: friend attacks and both clients receive dice results');
  for(const page of [host,friend])await page.waitForFunction(()=>[...document.querySelectorAll('.activity-copy .ai-commentary')].filter(node=>node.textContent.includes('AI commentary:')).length>=2,null,{timeout:90000});
  const displayed=await Promise.all([host,friend].map(page=>page.locator('[data-commentary-event]').evaluateAll(nodes=>Object.fromEntries(nodes.filter(n=>n.textContent).map(n=>[n.dataset.commentaryEvent,n.textContent])))));
  assert.deepEqual(displayed[0],displayed[1]);assert.equal(friendAIRequests,0);
  const savedReports=await api(`${base}/rooms/${roomCode}/aiReportsV2`,{token:users[0].idToken});
  assert.ok(savedReports.documents.every(doc=>doc.fields.authorUid.stringValue===users[0].localId));
  const original=savedReports.documents[0];
  await api('https://firestore.googleapis.com/v1/'+original.name,{token:users[1].idToken,method:'PATCH',body:{fields:original.fields},status:403});
  console.log('PASS: host generates shared Gemini reports; friends receive them without model requests and cannot overwrite them');
  await friend.reload();await friend.locator('.room-country').first().waitFor();
  assert.equal(await friend.locator('.room-country').count(),10);
  await host.screenshot({path:path.join(os.tmpdir(),'meridian-multiplayer-desktop.png'),fullPage:true});
  await friend.screenshot({path:path.join(os.tmpdir(),'meridian-multiplayer-mobile.png'),fullPage:true});
  const mobileOverflow=await friend.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);assert.equal(mobileOverflow,false,'Mobile page overflows horizontally');
  if(await friend.locator('[data-room-action="retreat"]').count())await friend.locator('[data-room-action="retreat"]').click();
  else await friend.locator('[data-room-action="end"]').click();
  await host.locator('.room-board-grid .event-meta').filter({hasText:'DECISION'}).first().waitFor();
  console.log('PASS: the host automatically advances bot decisions after the friend ends their turn');
  await host.goto(origin+'/#multiplayer');
  await friend.close();const reopened=await contexts[1].newPage();await reopened.goto(origin+'/#multiplayer/'+roomCode);
  await reopened.locator('[data-room-action="signin"]').waitFor();
  console.log('PASS: reload reconnects to the same match, while closing the tab requires sign-in');
  assert.deepEqual(errors,[]);
}finally{
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));
  let cleanupError;
  try{
    if(roomCode){
      for(const group of ['events','aiReports','aiReportsV2']){
        const records=await api(`${base}/rooms/${roomCode}/${group}?pageSize=100`,{token:admin});
        for(const doc of records.documents||[])await api('https://firestore.googleapis.com/v1/'+doc.name,{method:'DELETE',token:admin});
      }
      await api(`${base}/rooms/${roomCode}`,{method:'DELETE',token:admin});
    }
  }catch(error){cleanupError=error;}
  for(const user of users)try{await auth('delete',{idToken:user.idToken});}catch(error){cleanupError??=error;}
  if(debugName)try{await api('https://firebaseappcheck.googleapis.com/v1/'+debugName,{method:'DELETE',token:admin});}catch(error){cleanupError??=error;}
  if(cleanupError)throw cleanupError;
  console.log('Temporary room, events and test accounts removed.');
}
