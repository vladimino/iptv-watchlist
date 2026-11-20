// AIR-552: the compiled ratings seed is applied AFTER the D1 overlays. It fills only a missing own `actualRating`, an own `null` wins, and a seed-only id creates a key.
// The membership design that replaces the raw view-index object must keep this layer; this fixture pins the current rule on the real functions.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const source=fs.readFileSync('src/enrichment.js','utf8');
const pick=name=>{const start=source.indexOf('function '+name+'(');assert(start>=0,name);let depth=0,i=source.indexOf('{',start);for(let j=i;j<source.length;j++){if(source[j]==='{')depth++;if(source[j]==='}'&&--depth===0)return source.slice(start,j+1);}throw new Error(name);};
const ctx=vm.createContext({JSON,Object});
vm.runInContext('const INITIAL_PERSONAL_RATINGS={seedOnly:4,seedNull:3,seedD1:2,seedEmpty:5};',ctx);
vm.runInContext(pick('cloneJSON')+pick('applyRatingsSeed')+pick('overlayRatingsSeed'),ctx);
// The shape right after the D1 overlays: a rating_known=1 row gives an own actualRating (null when cleared), rating_known=0 and a missing row give none.
const overlaid={rawOnly:{},seedEmpty:{},seedNull:{actualRating:null,watched:true},seedD1:{actualRating:4.5},d1Only:{actualRating:3}};
const before=JSON.stringify(overlaid);
const seeded=JSON.parse(vm.runInContext('JSON.stringify(overlayRatingsSeed('+before+'))',ctx));
assert.equal(seeded.seedEmpty.actualRating,5,'an entry without an own actualRating takes the seed');
assert.equal(seeded.seedNull.actualRating,null,'an own null (explicit clear) wins over the seed');
assert.equal(seeded.seedNull.watched,true,'other fields are untouched');
assert.equal(seeded.seedD1.actualRating,4.5,'a ratings_view rating wins over the seed');
assert.deepEqual(seeded.seedOnly,{actualRating:4},'a seed-only id creates a key');
assert.equal('actualRating' in seeded.rawOnly,false,'a non-seed id is untouched');
assert.deepEqual(Object.keys(seeded).sort(),['d1Only','rawOnly','seedD1','seedEmpty','seedNull','seedOnly'],'membership is raw keys, D1 aliases and seed ids');
assert.equal(JSON.stringify(overlaid),before,'the overlay reads a copy and never mutates its input');
// An empty seed (the committed one) adds nothing.
const empty=vm.createContext({JSON,Object});vm.runInContext('const INITIAL_PERSONAL_RATINGS={};'+pick('cloneJSON')+pick('applyRatingsSeed')+pick('overlayRatingsSeed'),empty);
assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(overlayRatingsSeed('+before+'))',empty)),overlaid,'an empty seed changes nothing');
console.log('View index seed membership: own null wins, seed fills only a missing rating, seed-only id adds a key, empty seed inert passed');
