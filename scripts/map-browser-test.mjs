// Compare the original and corrected map in Chrome using local game data only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {GameEngine} from '../dist/engine.js';

const {chromium}=createRequire(import.meta.url)(path.join(os.tmpdir(),'meridian-browser-tests/node_modules/playwright'));
const root=path.resolve('dist');
const original=execFileSync('git',['show','HEAD:dist/assets/world-paths.js'],{encoding:'utf8'});
const corrected=await readFile(path.join(root,'assets/world-paths.js'),'utf8');
let before=true,browser;
const server=createServer(async(req,res)=>{
  try{
    const file=path.resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
    if(file!==root&&!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
    const target=file===root?path.join(root,'index.html'):file;
    res.writeHead(200,{'Content-Type':{'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg'}[path.extname(target)]||'application/octet-stream'});res.end(await readFile(target));
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
try{
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true});
  const game=GameEngine.create('Map geometry check','CA',true);
  await page.addInitScript(g=>localStorage.setItem('meridian-conquest-ui-v2',JSON.stringify([g])),game);
  await page.route('**/firebase-config.js',route=>route.fulfill({contentType:'text/javascript',body:'export const firebaseConfig=null;'}));
  await page.route('**/assets/world-paths.js*',route=>route.fulfill({contentType:'text/javascript',body:before?original:corrected}));
  for(const label of ['before','after']){
    before=label==='before';
    if(before)await page.goto('http://localhost:'+server.address().port+'/#game/'+game.id);
    else await page.reload();
    await page.locator('.world-map .land').first().waitFor();
    const crossingCount=await page.locator('.world-map').evaluate(svg=>{
      let count=0;
      for(const node of svg.querySelectorAll('.land')){
        let last=null;
        for(const m of node.getAttribute('d').matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g)){
          const p=[Number(m[2]),Number(m[3])];
          if(m[1]==='L'&&last&&Math.abs(last[0]-p[0])>480&&last[1]>1&&last[1]<479&&p[1]>1&&p[1]<479)count++;
          last=p;
        }
      }
      return count;
    });
    if(before)assert.ok(crossingCount>0,'The original asset should reproduce the horizontal bands');
    else assert.equal(crossingCount,0,'The corrected map must have no lines joining opposite edges');
    assert.equal(await page.locator('.world-map .map-marker').count(),10);
    assert.equal(await page.locator('.play-dock,.play-dialog').count(),0,'Keep the restored gameplay layout');
    await page.locator('.map-viewport').screenshot({path:path.join(os.tmpdir(),'meridian-map-'+label+'.png')});
    console.log(label+': '+crossingCount+' incorrect cross-map segments; 10 country markers retained');
  }
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
