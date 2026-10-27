// Serves the game on loopback only. The private App Check debug token is kept
// outside dist, excluded from Git/Hosting, and never printed.
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir,realpath} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {firebaseConfig} from '../dist/firebase-config.js';
import {createLocalPopulationSource} from './local-populations.mjs';
const workspace=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),root=path.join(workspace,'dist');
const require=createRequire(import.meta.url);
const cli=require(path.join(process.env.APPDATA,'npm/node_modules/firebase-tools/lib/auth.js'));
const account=cli.getGlobalDefaultAccount();if(!account)throw new Error('Run firebase login first.');
const admin=(await cli.getAccessToken(account.tokens.refresh_token,['https://www.googleapis.com/auth/cloud-platform'])).access_token;
const base='https://firebaseappcheck.googleapis.com/v1',app=`projects/${firebaseConfig.messagingSenderId}/apps/${encodeURIComponent(firebaseConfig.appId)}`;
const cache=path.join(workspace,'.firebase','app-check-debug.json');
async function api(name,{method='GET',body}={}){const response=await fetch(base+'/'+name,{method,headers:{Authorization:'Bearer '+admin,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json().catch(()=>({}));if(!response.ok)throw Object.assign(new Error('Local App Check setup: '+(data.error?.message||response.status)),{status:response.status});return data;}
let debug;
try{debug=JSON.parse(await readFile(cache,'utf8'));if(debug.appId!==firebaseConfig.appId||!debug.token||!debug.name)debug=null;}catch(error){if(error.code!=='ENOENT'&&!(error instanceof SyntaxError))throw error;}
if(debug)try{await api(debug.name);}catch(error){if(error.status===404)debug=null;else throw error;}
if(!debug){const token=randomUUID(),record=await api(app+'/debugTokens',{method:'POST',body:{displayName:'Meridian local development',token}});debug={appId:firebaseConfig.appId,name:record.name,token};await mkdir(path.dirname(cache),{recursive:true});await writeFile(cache,JSON.stringify(debug),{mode:0o600});}
const types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.svg':'image/svg+xml','.mp3':'audio/mpeg','.ogg':'audio/ogg','.png':'image/png'};
const localPopulations=await createLocalPopulationSource({file:path.join(workspace,'.firebase','population-cache.json'),onError:()=>console.warn('Worldometers is unavailable or failed validation; keeping the saved population snapshot.')});
const server=createServer(async(req,res)=>{
 try{
  const request=new URL(req.url,'http://'+req.headers.host);
  if(!['localhost','127.0.0.1'].includes(request.hostname)){res.writeHead(403).end();return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(request.pathname==='/population-data.json'){res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(localPopulations.snapshot));return;}
  if(request.pathname==='/ai-local-config.js'){res.writeHead(200,{'Content-Type':'text/javascript'}).end('export const localAppCheckDebugToken='+JSON.stringify(debug.token)+';');return;}
  const file=await realpath(path.resolve(root,'.'+decodeURIComponent(request.pathname==='/'?'/index.html':request.pathname)));
  if(!file.startsWith(root+path.sep)){res.writeHead(403).end();return;}
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'}).end(await readFile(file));
 }catch{res.writeHead(404).end();}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?'Port is busy. Set MERIDIAN_PORT to another port.':error.message);process.exitCode=1;});
server.listen(Number(process.env.MERIDIAN_PORT||8081),'127.0.0.1',()=>console.log('Meridian Conquest with local Gemini commentary: http://localhost:'+server.address().port));
void localPopulations.refresh();
setInterval(()=>void localPopulations.refresh(),3600000).unref();
