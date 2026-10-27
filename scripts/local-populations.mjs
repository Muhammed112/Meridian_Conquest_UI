import {readFile,writeFile,mkdir,rename} from 'node:fs/promises';
import path from 'node:path';
import {bundledPopulations} from '../dist/population-snapshot.js';
import {validatePopulationUpdate} from '../dist/population-schema.js';
import {fetchPopulations} from './update-populations.mjs';

// Local-only source updater. Never writes campaigns, Firebase or files in dist.
export async function createLocalPopulationSource({file,fetchSnapshot=fetchPopulations,now=()=>Date.now(),onError=()=>{}}){
  let snapshot=structuredClone(bundledPopulations),checkedAt=0,retryAfter=0,pending=null;
  try{
    const saved=JSON.parse(await readFile(file,'utf8'));
    snapshot=validatePopulationUpdate(saved.snapshot,snapshot,now());
    checkedAt=Number.isFinite(saved.checkedAt)&&saved.checkedAt<=now()?saved.checkedAt:0;
  }catch{}
  async function refresh(){
    if(pending)return pending;
    if(now()<retryAfter||(checkedAt&&now()-checkedAt<86400000))return false;
    pending=(async()=>{
      try{
        const candidate=await fetchSnapshot(),next=validatePopulationUpdate(candidate,snapshot,now());
        // Persist before publishing so a disk error also retains last-good data.
        await mkdir(path.dirname(file),{recursive:true});
        await writeFile(file+'.tmp',JSON.stringify({snapshot:next,checkedAt:now()}));await rename(file+'.tmp',file);
        snapshot=next;checkedAt=now();retryAfter=0;return true;
      }catch(error){retryAfter=now()+3600000;onError(error);return false;}
    })();
    try{return await pending;}finally{pending=null;}
  }
  return {refresh,get snapshot(){return structuredClone(snapshot);}};
}
