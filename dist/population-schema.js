import {countryMetadata} from './country-catalogue.js';
import {legacyCountries} from './legacy-countries.js';
export const POPULATION_SOURCE='https://www.worldometers.info/world-population/population-by-country/';
export const POPULATION_SCHEMA_VERSION=2;
export const populationCountries=Object.freeze(Object.fromEntries(countryMetadata.map(country=>[country.code,country.populationSlug])));
export function validatePopulationSnapshot(value,now=Date.now(),{allowLegacy=false}={}){
  const invalid=()=>{throw new Error('Population data failed validation; keeping the previous snapshot.');};
  const legacy=allowLegacy&&value?.version===1,codes=legacy?legacyCountries.map(country=>country.code):Object.keys(populationCountries);
  if(!value||value.version!==(legacy?1:POPULATION_SCHEMA_VERSION)||value.source!==POPULATION_SOURCE||!Number.isInteger(value.year)||value.year<2020||value.year>new Date(now).getUTCFullYear()+1
    ||typeof value.fetchedAt!=='string'||!Number.isFinite(Date.parse(value.fetchedAt))||Date.parse(value.fetchedAt)>now+300000
    ||Date.parse(value.fetchedAt)<Date.UTC(value.year-1,0,1)||!value.populations||typeof value.populations!=='object'
    ||Object.keys(value.populations).length!==codes.length)invalid();
  const populations={};
  for(const code of codes){
    const count=value.populations[code];
    if(!Number.isSafeInteger(count)||count<1||count>2000000000)invalid();
    populations[code]=count;
  }
  return {version:legacy?1:POPULATION_SCHEMA_VERSION,source:POPULATION_SOURCE,year:value.year,fetchedAt:new Date(value.fetchedAt).toISOString(),populations};
}
export function validatePopulationUpdate(candidate,previous,now=Date.now()){
  const next=validatePopulationSnapshot(candidate,now),old=validatePopulationSnapshot(previous,now,{allowLegacy:true});
  if(next.year<old.year||Date.parse(next.fetchedAt)<Date.parse(old.fetchedAt))throw new Error('Population snapshot is older than the saved data.');
  if(Object.keys(old.populations).some(code=>Math.abs(next.populations[code]/old.populations[code]-1)>0.25))throw new Error('Unexpected population change exceeds 25%; manual review is required.');
  return next;
}
