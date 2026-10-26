// Preview the current narrator on recorded game fixtures. Uses the private
// localhost App Check setup and one temporary account, then removes the account.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {firebaseConfig as config} from '../dist/firebase-config.js';
import {aiConfig} from '../dist/ai-config.js';
import {GameEngine} from '../dist/engine.js';
import {commentaryContext,parseCommentaryBatch} from '../dist/commentary.js';
const {chromium}=createRequire(import.meta.url)(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
async function json(url,body,headers={}){const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(100000),headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw new Error(response.status+': '+(data.error?.message||'Request failed'));return data;}
const auth=(method,body)=>json(`https://identitytoolkit.googleapis.com/v1/accounts:${method}?key=${config.apiKey}`,body);
let user,browser;
try{
 const credentials={email:`meridian-preview-${randomUUID()}@example.invalid`,password:randomUUID()+'Aa1!',returnSecureToken:true};user=await auth('signUp',credentials);
 const battle=GameEngine.create('Narration fixture','ZA',true),engine=new GameEngine(battle);battle.round=1;battle.budget=0;battle.events=[];
 battle.countries[0].army=6;battle.countries[1].army=5;engine.event('turn','A new turn.');engine.startAttack('ZA','BR');
 const rolls=[1,6,6,1,6,1,3,3,3,3];engine.roll(()=>rolls.shift());const pressure=battle.events.at(-1);
 const tasks=[{eventId:pressure.id,context:commentaryContext(battle,pressure)}];
 engine.roll(()=>3);battle.events.at(-1).commentary='No losses this time. Both armies come through intact.';
 engine.roll(()=>3);tasks.push({eventId:battle.events.at(-1).id,context:commentaryContext(battle,battle.events.at(-1))});
 const lead=GameEngine.create('Territorial tie fixture','ZA',true),leader=new GameEngine(lead);lead.round=1;lead.budget=0;lead.events=[];
 lead.countries.forEach((country,index)=>{country.owner=index<3?0:index<6?1:index-4;});lead.countries[0].army=6;lead.countries[3].army=1;
 leader.event('turn','Three countries each for the two leaders.');leader.startAttack(lead.countries[0].code,lead.countries[3].code);let n=0;leader.roll(()=>++n%2?6:1);
 const capture=lead.events.findLast(event=>event.type==='conquest');tasks.push({eventId:capture.id,context:commentaryContext(lead,capture)});
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({ignoreHTTPSErrors:true});
 await page.goto('http://localhost:8081/#signin');await page.waitForFunction(()=>{const button=document.querySelector('#auth-form button[type="submit"]');return button&&!button.disabled;});
 await page.locator('#email').fill(credentials.email);await page.locator('#password').fill(credentials.password);await page.locator('#auth-form button[type="submit"]').click();await page.waitForURL('**/#campaigns');
 page.on('response',async response=>{if(response.url().includes('firebasevertexai.googleapis.com')&&response.status()>=400){const data=await response.json().catch(()=>({}));console.log('Model request status:',response.status(),data.error?.message);}});
 const selectedModel=process.env.COMMENTARY_PREVIEW_MODEL||aiConfig.model;
 const start=Date.now();console.log('Requesting '+selectedModel+' on pressure, stalemate and lead-change fixtures.');
 const raw=await page.evaluate(async({tasks,selectedModel})=>{
  const [{getApp},{createGeminiGenerator},{aiConfig}]=await Promise.all([import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),import('./commentary.js?v=match-commentary-20261026-1'),import('./ai-config.js')]);
  return createGeminiGenerator({app:getApp(),base:'https://www.gstatic.com/firebasejs/13.0.0/',settings:{...aiConfig,model:selectedModel}})(tasks);
 },{tasks,selectedModel});
 const reports=parseCommentaryBatch(raw,tasks);assert.equal(reports.size,3);
 for(const [index,task] of tasks.entries())console.log(['Pressure','Stalemate','Lead change'][index]+': '+reports.get(task.eventId));
 console.log('Model response: '+((Date.now()-start)/1000).toFixed(1)+'s');
}finally{await browser?.close();if(user){await auth('delete',{idToken:user.idToken});console.log('Temporary preview account removed; no campaigns were written.');}}
