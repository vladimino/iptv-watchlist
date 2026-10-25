import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

function harness(){
 const records=new Map(),etags=new Map();let revision=0,calls=0;
 const env={SCORED_RESOLUTION:'on',TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};}}};
 const live=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,fetch:async()=>{calls++;return new Response(JSON.stringify({total_pages:1,results:[]}));}});
 for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),live);
 live.env=env;live.records=records;live.calls=()=>calls;
 return live;
}
const now=Date.now();
const show={channelId:'n',channel:'N',start:now,end:now+3600000};
function seed(live,item,decision,film){
 live.records.set('programme.json',{runId:'run-1',films:film?[{id:film.id,tmdbId:film.tmdbId,title:film.title,titleStatus:'reviewed'}]:[]});
 live.records.set('epg/discovery-latest.json',{programmeRunId:'run-1',items:[item]});
 live.records.set('epg/discovered-films.json',film?{[film.id]:film}:{});
 if(decision)live.records.set('epg/discovery-resolution.json',{[item.key]:decision});
}
async function run(item,decision,film){
 const live=harness();
 seed(live,item,decision,film);
 const result=await vm.runInContext('resolveDiscoveryBatch(env,{runId:"run-1",films:records.get("programme.json").films},4)',live);
 return {result,decision:live.records.get('epg/discovery-resolution.json')?.[item.key],film:film?live.records.get('epg/discovered-films.json')[film.id]:null,calls:live.calls()};
}
const short={key:'11 14|',title:'11:14',normalizedTitle:'11 14',year:null,duration:82,durations:[82],seenInLatestSnapshot:true,shows:[show],lastAiring:now,confirmedTmdbId:'9282'};
const kept=await run(short,{status:'verified',tmdbId:'9282',filmId:'tmdb_9282',identitySource:'known_epg_alias',checkedAt:'2026-10-01T00:00:00.000Z'},{id:'tmdb_9282',tmdbId:'9282',title:'11:14',titleStatus:'reviewed',aliases:[],shows:[]});
assert.equal(kept.calls,0);
assert.equal(kept.decision.identitySource,'known_epg_alias');
assert.equal(kept.decision.checkedAt,'2026-10-01T00:00:00.000Z');
assert.equal(kept.film.title,'11:14');
assert.equal(kept.film.titleStatus,'reviewed');
const fresh={...short,key:'короткое|',title:'Короткое',normalizedTitle:'короткое',confirmedTmdbId:'1'};
const created=await run(fresh,null,{id:'tmdb_1',tmdbId:'1',title:'Короткое',titleStatus:'reviewed',aliases:[],shows:[]});
assert.equal(created.calls,0);
assert.equal(created.decision.status,'verified');
assert.equal(created.decision.identitySource,'known_epg_alias');
assert.equal(created.decision.tmdbId,'1');
assert.equal(created.film.titleStatus,'reviewed');
const doc=fs.readFileSync('docs/evidence/scored-resolver/air-100-rollout.md','utf8');
assert.match(doc,/not a cutover/);
assert.match(doc,/CANDIDATE_DISCOVERY` stays unset/);
assert.match(doc,/known_epg_alias/);
assert.match(doc,/14896/);
console.log('AIR-100 rollout passed');
