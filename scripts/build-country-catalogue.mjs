// Country metadata: mledoze/countries (ODbL 1.0). Populations: exam's Worldometers URL.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {readPopulationRows} from './update-populations.mjs';
import {legacyCountries} from '../dist/legacy-countries.js';
const source='https://www.worldometers.info/world-population/population-by-country/';
const repository='https://api.github.com/repos/mledoze/countries';
async function get(url,format='json'){
  const response=await fetch(url,{signal:AbortSignal.timeout(30000),headers:{Accept:format==='json'?'application/json':'text/plain','User-Agent':'Meridian-Conquest-catalogue/1.0'}});
  if(!response.ok)throw new Error('Country catalogue source returned HTTP '+response.status);
  return format==='json'?response.json():response.text();
}
const revision=(await get(repository+'/commits/master')).sha;
if(!/^[a-f0-9]{40}$/.test(revision))throw new Error('Country metadata revision is invalid.');
const metadataURL=`https://raw.githubusercontent.com/mledoze/countries/${revision}/countries.json`;
const [metadata,html,licence]=await Promise.all([get(metadataURL),get(source,'text'),get(`https://raw.githubusercontent.com/mledoze/countries/${revision}/LICENSE`,'text')]);
const {year,rows}=readPopulationRows(html);
const normalize=value=>value.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]/g,'');
const names=new Map(),codes=new Map(metadata.map(country=>[country.cca2,country]));
for(const country of metadata)for(const name of [country.name.common,country.name.official,...country.altSpellings])names.set(normalize(name),country);
const aliases={'turkey':'TR','czechia':'CZ','cabo-verde':'CV','sao-tome-and-principe':'ST','saint-vincent-and-the-grenadines':'VC','united-states-virgin-islands':'VI','turks-and-caicos-islands':'TC','saint-kitts-and-nevis':'KN','wallis-and-futuna-islands':'WF','saint-pierre-and-miquelon':'PM','holy-see':'VA'};
const original=new Map(legacyCountries.map(country=>[country.code,country])),records=[],populations={};
for(const row of rows){
  const country=codes.get(aliases[row.slug])||names.get(normalize(row.name));
  if(!country)throw new Error('No ISO metadata for '+row.name);
  const {cca2:code,ccn3:id,latlng}=country,old=original.get(code);
  assert.match(code,/^[A-Z]{2}$/);assert.match(id,/^\d{3}$/);assert.equal(populations[code],undefined,'Duplicate ISO code '+code);
  assert.ok(Number.isSafeInteger(row.population)&&row.population>0&&row.population<=2000000000);
  const record={id,code,name:code==='VA'?'Vatican City (Holy See)':old?.name||country.name.common,flag:old?.flag||String.fromCodePoint(...[...code].map(character=>character.charCodeAt(0)+127397)),lon:old?.lon??latlng[1],lat:old?.lat??latlng[0],populationSlug:row.slug};
  assert.ok(Number.isFinite(record.lon)&&record.lon>=-180&&record.lon<=180&&Number.isFinite(record.lat)&&record.lat>=-58&&record.lat<=85,'Invalid map position for '+row.name);
  assert.ok(!/[<>"\u0000-\u001f]/.test(record.name),'Invalid country name');
  records.push(record);populations[code]=row.population;
}
assert.ok(records.length>=230,'Worldometers country list is incomplete');
const order=new Map(legacyCountries.map((country,index)=>[country.code,index]));
records.sort((a,b)=>(order.get(a.code)??999)-(order.get(b.code)??999)||a.name.localeCompare(b.name,'en'));
for(const old of legacyCountries)assert.ok(records.some(record=>record.code===old.code),'Missing legacy country '+old.code);
// Write only after every source row and marker has been checked.
await writeFile(new URL('../dist/country-catalogue.js',import.meta.url),'// ISO names/codes/coordinates derived from '+metadataURL+' (ODbL 1.0).\n// See assets/COUNTRY_DATA_CREDITS.txt and COUNTRY_DATA_LICENSE.txt.\nexport const countryMetadata = '+JSON.stringify(records,null,2)+';\n');
const snapshot={version:2,source,year,fetchedAt:new Date().toISOString(),populations};
await writeFile(new URL('../dist/population-snapshot.js',import.meta.url),'// Last validated Worldometers snapshot; gameplay also works offline.\nexport const bundledPopulations = '+JSON.stringify(snapshot,null,2)+';\n');
await writeFile(new URL('../dist/assets/COUNTRY_DATA_LICENSE.txt',import.meta.url),licence);
await writeFile(new URL('../dist/assets/COUNTRY_DATA_CREDITS.txt',import.meta.url),`Country names, ISO codes and geographic coordinates: mledoze/countries\n${metadataURL}\nLicensed under Open Data Commons Open Database License (ODbL) 1.0.\nThe generated metadata database is available under the same licence at ../country-catalogue.js.\nOriginal Meridian country labels and marker positions are retained for saved-game compatibility.\n\nPopulation figures are read separately from the exam's specified source:\n${source}\nEstimate year: ${year}. Figures are annual estimates, not live clocks.\nCountries too small for the bundled map's outlines remain visible and selectable as markers and roster entries.\n`);
console.log(`Generated ${records.length} country/territory records and a ${year} population snapshot; Vatican City: ${populations.VA} people.`);
