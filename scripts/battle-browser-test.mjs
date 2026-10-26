// Local-only rendering checks; no Firebase account or saved campaign is changed.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import os from 'node:os';
import {GameEngine} from '../dist/engine.js';
const {chromium}=createRequire(import.meta.url)(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
const root=path.resolve('dist');let browser;
const server=createServer(async(req,res)=>{try{const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}const target=file===root?path.join(root,'index.html'):file;res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg'}[path.extname(target)]||'application/octet-stream'});res.end(await readFile(target));}catch{res.writeHead(404).end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
 browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
 for(const mode of ['normal','fast','reduced']){
  const game=GameEngine.create('Battle reveal check','ZA',true);
  game.round=1;game.position=game.order.indexOf(0);game.turnStarted=false;game.events=[];
  for(const country of game.countries)country.owner=0;
  game.countries[0].army=9;game.countries[1].owner=1;game.countries[1].army=1;new GameEngine(game).beginTurn();
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({game,mode})=>{localStorage.setItem('meridian-conquest-ui-v2',JSON.stringify([game]));localStorage.setItem('meridian-motion-preference',mode==='reduced'?'reduced':'full');}, {game,mode});
  await page.route('**/firebase-config.js',route=>route.fulfill({contentType:'text/javascript',body:'export const firebaseConfig=null;'}));
  await page.goto('http://localhost:'+server.address().port+'/#game/'+game.id);await page.locator('#attack-from').selectOption('ZA');
  if(mode==='fast')await page.locator('.game-heading [data-action="fast"]').click();
  await page.locator('[data-action="start-attack"]').click();
  await page.evaluate(async()=>{const {BattleEngine}=await import('./engine.js');const original=BattleEngine.resolve;BattleEngine.resolve=(a,d)=>{let n=0;return original(a,d,()=>++n%2?6:1);};});
  const time=new Date('2026-10-26T12:00:00Z');await page.clock.install({time});await page.clock.pauseAt(new Date(time.getTime()+1000));
  await page.locator('[data-action="roll"]').dispatchEvent('click');
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('meridian-conquest-ui-v2'))[0].winner===0);
  if(mode!=='reduced'){
   assert.equal(await page.locator('.result-title').count(),0);assert.match(await page.locator('.action-panel').innerText(),/Results appear when they settle/);
   assert.equal(await page.locator('[data-map-country="ZA"].country-row .army-count').innerText(),'9');
   assert.doesNotMatch(await page.locator('.activity-feed').innerText(),/loses|conquered|controls all ten/);
   assert.doesNotMatch(await page.locator('.dice-pair').first().getAttribute('aria-label'),/loses/);
   await page.clock.runFor((mode==='fast'?550:1100)-1);assert.equal(await page.locator('.result-title').count(),0);
   await page.clock.runFor(30);
  }
  assert.match(await page.locator('.result-title').innerText(),/The world is yours/);
  assert.match(await page.locator('.activity-feed').innerText(),/conquered/);
  assert.notEqual(await page.locator('[data-map-country="ZA"].country-row .army-count').innerText(),'9');
  assert.deepEqual(errors,[]);console.log('PASS: '+mode+' playback reveals conquest, ownership, counts and victory at the correct time');await page.close();
 }
 for(const mode of ['normal','fast','reduced']){
  const game=GameEngine.create('Bot phase summaries','ZA',true);
  game.round=1;game.position=game.order.indexOf(0);game.turnStarted=false;game.events=[];
  game.countries[1].army=6;game.countries[2].army=5;new GameEngine(game).beginTurn();
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(({game,mode})=>{localStorage.setItem('meridian-conquest-ui-v2',JSON.stringify([game]));localStorage.setItem('meridian-motion-preference',mode==='reduced'?'reduced':'full');},{game,mode});
  await page.route('**/firebase-config.js',route=>route.fulfill({contentType:'text/javascript',body:'export const firebaseConfig=null;'}));
  await page.goto('http://localhost:'+server.address().port+'/#game/'+game.id);
  await page.locator('.game-heading').waitFor();
  if(mode==='fast')await page.locator('.game-heading [data-action="fast"]').click();
  await page.evaluate(async()=>{
   const {GameEngine,BattleEngine}=await import('./engine.js'),original=BattleEngine.resolve;
   GameEngine.prototype.npcPlan=function(){return {from:this.game.countries[1],to:this.game.countries[2],reason:'Bot battle display fixture.'};};
   GameEngine.prototype.npcBattleDecision=()=>({continue:true,reason:'Continue the recorded attack.'});
   window.botRollTimes=[];
   const rolls=[[1,6,6,1,6,1,3,3,3,3],[1,6,1,6,6,1],[3,3,3,3],[6,1,6,1]];
   BattleEngine.resolve=(a,d)=>{const values=[...(rolls[window.botRollTimes.length]||[3,3])];window.botRollTimes.push(performance.now());return original(a,d,()=>values.shift()||3);};
  });
  const time=new Date('2026-10-26T12:00:00Z');await page.clock.install({time});await page.clock.pauseAt(new Date(time.getTime()+1000));
  await page.locator('[data-action="end-turn"]').first().dispatchEvent('click');
  await page.clock.runFor(mode==='fast'?1668:5000);
  for(const [index,losses] of [[1,[1,2]],[2,[2,1]],[3,[0,0]],[4,[0,2]]]){
   const duration=mode==='reduced'?0:mode==='fast'?550:1100;
   if(duration){
    assert.match(await page.locator('.action-panel').innerText(),/Results appear when they settle/);
    assert.doesNotMatch(await page.locator('.action-panel').innerText(),/Phase \d+:/);
    await page.clock.runFor(duration-10);assert.doesNotMatch(await page.locator('.action-panel').innerText(),/Phase \d+:/);
    await page.clock.runFor(20);
   }
   const expected=`Phase ${index}: ${game.countries[1].name} lost ${losses[0]}; ${game.countries[2].name} lost ${losses[1]}.`;
   assert.ok((await page.locator('.action-panel').innerText()).includes(expected),'Missing settled bot result: '+expected);
   if(index===3)assert.match(await page.locator('.action-panel').innerText(),/A stand-off/);
   if(index===4)assert.match(await page.locator('.recent-conquest').innerText(),/conquered/);
   if(index<4){const remaining=await page.evaluate(pause=>Math.max(0,Math.ceil(window.botRollTimes.at(-1)+pause-performance.now())+1),mode==='fast'?1000:3000);await page.clock.runFor(remaining);}
  }
  assert.deepEqual(errors,[]);console.log('PASS: '+mode+' bot attacks show each phase summary after settling, including ties and conquest');await page.close();
 }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
