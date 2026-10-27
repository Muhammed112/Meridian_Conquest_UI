import {parse} from 'parse5';
import {writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {POPULATION_SOURCE,POPULATION_SCHEMA_VERSION,populationCountries,validatePopulationSnapshot,validatePopulationUpdate} from '../dist/population-schema.js';
import {firebaseConfig} from '../dist/firebase-config.js';

const children=node=>node.childNodes||[];
const descendants=(node,tag)=>children(node).flatMap(child=>[...(child.tagName===tag?[child]:[]),...descendants(child,tag)]);
const text=node=>node.nodeName==='#text'?node.value:children(node).map(text).join('');
export function readPopulationRows(html){
  if(typeof html!=='string'||html.length>2000000)throw new Error('Invalid Worldometers response.');
  const document=parse(html),tables=descendants(document,'table');
  const candidates=tables.map(table=>({table,headings:descendants(table,'th').map(cell=>text(cell).trim().replace(/\s+/g,' '))}));
  const matching=candidates.filter(({headings})=>headings.some(h=>/^Population\s+(20\d\d)$/.test(h))&&headings.some(h=>/^Country\b/.test(h)));
  if(matching.length!==1)throw new Error('Worldometers population table could not be identified.');
  const {table,headings}=matching[0],column=headings.findIndex(h=>/^Population\s+(20\d\d)$/.test(h)),year=Number(headings[column].match(/20\d\d/)[0]);
  const rows=[];
  for(const row of descendants(table,'tr')){
    const cells=children(row).filter(node=>node.tagName==='td');
    const link=cells.flatMap(cell=>descendants(cell,'a')).find(node=>node.attrs?.some(attr=>attr.name==='href'&&/^\/world-population\/[^/]+-population\/?$/.test(attr.value)));
    const href=link?.attrs.find(attr=>attr.name==='href')?.value,slug=href?.match(/^\/world-population\/(.+)-population\/?$/)?.[1];
    if(!slug)continue;
    // data-order attributes are scaled sorting keys, not population counts.
    const visible=cells[column]?text(cells[column]).trim():'';
    if(!/^(?:\d{1,3}(?:,\d{3})+|\d+)$/.test(visible)||rows.some(row=>row.slug===slug))throw new Error('Invalid or duplicate population for '+slug+'.');
    rows.push({slug,name:text(link).trim(),population:Number(visible.replaceAll(',',''))});
  }
  return {year,rows};
}
export function parsePopulationTable(html,now=Date.now()){
  const {year,rows}=readPopulationRows(html),codes=new Map(Object.entries(populationCountries).map(([code,slug])=>[slug,code])),populations={};
  for(const row of rows){const code=codes.get(row.slug);if(code)populations[code]=row.population;}
  const missing=Object.keys(populationCountries).filter(code=>populations[code]===undefined);
  if(missing.length)throw new Error('Worldometers is missing required countries: '+missing.join(', ')+'.');
  return validatePopulationSnapshot({version:POPULATION_SCHEMA_VERSION,source:POPULATION_SOURCE,year,fetchedAt:new Date(now).toISOString(),populations},now);
}
export async function fetchPopulations(fetcher=fetch,now=Date.now()){
  const response=await fetcher(POPULATION_SOURCE,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'Meridian-Conquest-population-updater/1.0','Accept':'text/html'}});
  if(!response.ok)throw new Error('Worldometers returned HTTP '+response.status+'.');
  if(!response.headers.get('content-type')?.includes('text/html'))throw new Error('Worldometers did not return HTML.');
  return parsePopulationTable(await response.text(),now);
}
export const populationDocument=firebaseConfig?.projectId?`projects/${firebaseConfig.projectId}/databases/(default)/documents/publicData/populations`:null;
export const populationURL=populationDocument?'https://firestore.googleapis.com/v1/'+populationDocument:null;
export async function publishedPopulations(fetcher=fetch){
  if(!populationURL)throw new Error('Configure Firebase before publishing population data.');
  const response=await fetcher(populationURL,{signal:AbortSignal.timeout(10000)});
  if(response.status===404)return null;
  if(!response.ok)throw new Error('Could not read the last published population snapshot (HTTP '+response.status+').');
  const document=await response.json();
  if(typeof document.updateTime!=='string')throw new Error('Published population revision is missing.');
  return {snapshot:validatePopulationSnapshot(JSON.parse(document.fields?.payload?.stringValue),Date.now(),{allowLegacy:true}),updateTime:document.updateTime};
}
async function publish(snapshot,previous,{admin=false}={}){
  let token;
  if(admin){const {firebaseAdminToken}=await import('./firebase-admin-access.mjs');token=await firebaseAdminToken();}
  else{
    const email=process.env.POPULATION_UPDATER_EMAIL,password=process.env.POPULATION_UPDATER_PASSWORD;
    if(!email||!password)throw new Error('Population updater credentials are not configured.');
    const response=await fetch('https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key='+firebaseConfig.apiKey,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password,returnSecureToken:true})});
    const auth=await response.json();if(!response.ok||!auth.idToken)throw new Error('Population updater sign-in failed (HTTP '+response.status+').');token=auth.idToken;
  }
  const saved=await fetch(`https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents:commit`,{method:'POST',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({writes:[{update:{name:populationDocument,fields:{payload:{stringValue:JSON.stringify(snapshot)}}},currentDocument:previous?{updateTime:previous.updateTime}:{exists:false},updateTransforms:[{fieldPath:'updatedAt',setToServerValue:'REQUEST_TIME'}]}]})});
  if(!saved.ok)throw new Error('Population publication failed (HTTP '+saved.status+'); the previous snapshot remains available.');
}
export async function updatePopulations({publishRemote=false,writeBundle=false,admin=false}={}){
  const snapshot=await fetchPopulations();
  let bundledPopulations;
  try{({bundledPopulations}=await import('../dist/population-snapshot.js'));}
  catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND'||!writeBundle||publishRemote)throw error;bundledPopulations=snapshot;}
  const previous=publishRemote?await publishedPopulations():null;
  validatePopulationUpdate(snapshot,previous?.snapshot||bundledPopulations);
  if(publishRemote)await publish(snapshot,previous,{admin});
  if(writeBundle){
    const file=fileURLToPath(new URL('../dist/population-snapshot.js',import.meta.url)),temporary=file+'.tmp';
    await writeFile(temporary,'// Last validated Worldometers snapshot; gameplay also works offline.\nexport const bundledPopulations = '+JSON.stringify(snapshot,null,2)+';\n');
    await rename(temporary,file);
  }
  console.log(`Validated ${Object.keys(snapshot.populations).length} countries from Worldometers (${snapshot.year}).${publishRemote?' Published for new campaigns.':''}${writeBundle?' Offline snapshot saved.':''}`);
  return snapshot;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))updatePopulations({publishRemote:process.argv.includes('--publish')||process.argv.includes('--publish-admin'),writeBundle:process.argv.includes('--write-bundle'),admin:process.argv.includes('--publish-admin')}).catch(error=>{console.error(error.message);process.exitCode=1;});
