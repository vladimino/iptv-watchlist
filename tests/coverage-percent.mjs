import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {MemoryBucket} from './memory-bucket.mjs';

const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto,console,encodeURIComponent,decodeURIComponent});
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);

const examples=[[2257,2260,99.9],[1829,1832,99.8],[2234,2239,99.8],[9999,10000,99.9],[2260,2260,100]];
for(const [current,total,expected] of examples){
 assert.equal(context.coveragePercent(current,total),expected,`${current}/${total}`);
 assert.equal(context.coveragePercent(current,total)===100,current===total,`${current}/${total}`);
}
assert.equal(context.coveragePercent(0,0),100,'an empty denominator keeps the historical 100');
assert.equal(context.coveragePercent(1,0),100,'a zero denominator stays 100 rather than becoming a ratio');
assert.equal(context.coveragePercent(0,5),0);
assert.equal(context.coveragePercent(199,200),99.5);
assert.notEqual(context.coveragePercent(199,200),100);

const profile={version:1,profileHash:'hash-zz'};
const currentPrediction={tasteProfileVersion:1,tasteProfileHash:'hash-zz',fingerprintHash:'fp-zz',fingerprintSchemaVersion:1,predictionPromptVersion:1};
const now=Date.now();
const films=[],index={};
for(let i=0;i<200;i++){
 const id=`film-zz-${String(i).padStart(3,'0')}`;
 films.push({id,tmdbId:String(800000+i),shows:[{start:now}]});
 if(i<199)index[id]={fingerprintHash:'fp-zz',impactFeatures:{fingerprintHash:'fp-zz',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},prediction:currentPrediction};
}
const bucket=new MemoryBucket();
await bucket.put('programme.json',JSON.stringify({runId:'run-zz',films}));
await bucket.put('epg/discovered-films.json',JSON.stringify({}));
await bucket.put('enrichment/view-index.json',JSON.stringify(index));
await bucket.put('enrichment/profile/current.json',JSON.stringify(profile));
const snapshot=await context.predictionEventSnapshot({BUCKET:bucket},{priorityCount:1,coldRemaining:0});
assert.equal(snapshot.coverage.confirmedFilmsTotal,200);
assert.equal(snapshot.coverage.currentPredictionsTotal,199);
assert.equal(snapshot.coverage.windowFilmsTotal,200);
assert.equal(snapshot.coverage.windowCurrentPredictions,199);
assert.equal(snapshot.coverage.localPercent,context.coveragePercent(199,200));
assert.equal(snapshot.coverage.windowPercent,context.coveragePercent(199,200));
assert.notEqual(snapshot.coverage.localPercent,100);
assert.notEqual(snapshot.coverage.windowPercent,100);

const empty=new MemoryBucket();
await empty.put('programme.json',JSON.stringify({runId:'run-empty',films:[]}));
await empty.put('epg/discovered-films.json',JSON.stringify({}));
await empty.put('enrichment/view-index.json',JSON.stringify({}));
await empty.put('enrichment/profile/current.json',JSON.stringify(profile));
const blank=await context.predictionEventSnapshot({BUCKET:empty},null);
assert.equal(blank.coverage.confirmedFilmsTotal,0);
assert.equal(blank.coverage.currentPredictionsTotal,0);
assert.equal(blank.coverage.localPercent,100);
assert.equal(blank.coverage.windowPercent,100);

console.log('coverage percent: tenths, incomplete values stay below 100, and an empty denominator remains 100');
