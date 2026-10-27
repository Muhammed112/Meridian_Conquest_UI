import test from 'node:test';
import assert from 'node:assert/strict';
import {worldPaths} from '../dist/assets/world-paths.js';
import {catalogue} from '../dist/data.js';
import {legacyCountries} from '../dist/legacy-countries.js';
import {countryPoint} from '../dist/motion.js';

function segments(d){
  const result=[];let previous=null,start=null;
  for(const match of d.matchAll(/([ML])(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)|(Z)/g)){
    if(match[4]){if(previous&&start)result.push([previous,start]);previous=start;continue;}
    const point=[Number(match[2]),Number(match[3])];
    if(match[1]==='M')start=point;
    else if(previous)result.push([previous,point]);
    previous=point;
  }
  return result;
}

test('country outlines never join opposite map edges through the visible interior',()=>{
  for(const country of worldPaths){
    for(const [a,b] of segments(country.d)){
      const crossesInterior=Math.abs(a[0]-b[0])>480&&a[1]>1&&a[1]<479&&b[1]>1&&b[1]<479;
      assert.equal(crossesInterior,false,`${country.name}: ${a} to ${b} crosses the map`);
    }
  }
});

test('map retains original outlines, gives every country a visible marker, and separates the map seams',()=>{
  const identified=worldPaths.filter(c=>c.id&&c.id!=='null');
  assert.equal(new Set(identified.map(c=>c.id)).size,identified.length);
  for(const country of legacyCountries)assert.ok(worldPaths.some(p=>p.id===country.id),country.name);
  for(const country of catalogue){const [x,y]=countryPoint(country);assert.ok(Number.isFinite(x)&&x>=0&&x<=960&&Number.isFinite(y)&&y>=0&&y<=480,'Missing visible marker for '+country.name);}
  for(const id of ['242','643']){
    const shape=worldPaths.find(country=>country.id===id);
    assert.ok(shape.d.match(/M/g).length>1,'Seam-crossing geometry needs separate rings');
  }
});
