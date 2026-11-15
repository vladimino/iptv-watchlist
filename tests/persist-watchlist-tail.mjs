// AIR-480: persistWatchlist must not increment published generation on a live D1 pin (ADR 0142 decision 14).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const records=new Map();
let generationCalls=0,saveWatchlistCalls=0,saveWatchlistArg=null,saveJSONCalls=0;
const liveD1={value:null,throw:false};
const saveWatchlistResult={value:null};
const ctx=vm.createContext({
 Date,Map,Set,JSON,console,
 loadJSON:async(_env,key)=>{
  return records.has(key)?structuredClone(records.get(key)):null;
 },
 saveJSON:async(_env,key,value)=>{saveJSONCalls++;records.set(key,structuredClone(value));},
 PublishedEpg:{
  currentGeneration:async()=>{
   generationCalls++;
   if(liveD1.throw)throw new Error('published_epg_unavailable');
   return liveD1.value;
  },
  saveWatchlist:async(_env,next)=>{saveWatchlistCalls++;saveWatchlistArg=next;return saveWatchlistResult.value;}
 }
});
const worker=fs.readFileSync('src/worker.js','utf8');
vm.runInContext(worker.slice(worker.indexOf('async function persistWatchlist'),worker.indexOf('async function persistScan')),ctx);
const persist=async(env,run,report)=>{
 ctx.env=env;ctx.run=run;ctx.report=report;
 return vm.runInContext('(async()=>persistWatchlist(env,run,report))()',ctx);
};
const env={};
const film={id:'film:heat',title:'Heat',shows:[{channelId:'c',start:1}]};
const report={updatedAt:'2026-11-15T12:00:00.000Z',watchlistCount:1,films:[film]};

records.set('watchlist.json',{updatedAt:'2026-11-14T12:00:00.000Z',films:[{id:'film:heat',title:'Heat'}]});
liveD1.value={programmeRunId:'run-p',generation:41,phase:'published',fence:'f'};
generationCalls=0;saveWatchlistCalls=0;saveJSONCalls=0;
await persist(env,{},report);
assert.equal(generationCalls,1);
assert.equal(saveWatchlistCalls,0,'D1 pin: persistWatchlist does not call saveWatchlist');
assert.equal(saveJSONCalls,0);
assert.equal(records.get('watchlist.json').updatedAt,'2026-11-14T12:00:00.000Z','D1 pin: R2 watchlist is unchanged');

liveD1.value=null;
liveD1.throw=true;
generationCalls=0;saveWatchlistCalls=0;saveJSONCalls=0;
await assert.rejects(()=>persist(env,{},report),{message:'published_epg_unavailable'});
assert.equal(saveWatchlistCalls,0,'unreadable pin: persistWatchlist writes nothing');
assert.equal(saveJSONCalls,0);
assert.equal(records.get('watchlist.json').updatedAt,'2026-11-14T12:00:00.000Z');

liveD1.throw=false;
liveD1.value=null;
saveWatchlistResult.value=null;
generationCalls=0;saveWatchlistCalls=0;saveJSONCalls=0;
await persist(env,{},report);
assert.equal(saveWatchlistCalls,1,'R2: mismatched updatedAt still copies the watchlist');
assert.equal(saveJSONCalls,1,'R2 authority: saveWatchlist returns null and saveJSON writes');
assert.equal(saveWatchlistArg.updatedAt,report.updatedAt);
assert.equal(saveWatchlistArg.films[0].id,'film:heat');
assert.equal(saveWatchlistArg.films[0].shows,undefined);
assert.equal(records.get('watchlist.json').updatedAt,report.updatedAt);
assert.equal(records.get('watchlist.json').films[0].id,'film:heat');
assert.equal(records.get('watchlist.json').films[0].shows,undefined);

saveWatchlistCalls=0;saveJSONCalls=0;
await persist(env,{},report);
assert.equal(saveWatchlistCalls,0,'R2: matching updatedAt is a no-op');
assert.equal(saveJSONCalls,0);

records.set('watchlist.json',{updatedAt:'2026-11-14T12:00:00.000Z',films:[{id:'film:heat',title:'Heat'}]});
saveWatchlistResult.value=false;
saveWatchlistCalls=0;saveJSONCalls=0;
await assert.rejects(()=>persist(env,{},report),{message:'published_epg_fence'});
assert.equal(saveWatchlistCalls,1);
assert.equal(saveJSONCalls,0,'fenced saveWatchlist does not write R2');
assert.equal(records.get('watchlist.json').updatedAt,'2026-11-14T12:00:00.000Z');

console.log('persistWatchlist tail: D1 skip, unreadable reject, R2 stamp, fence ok');
