// AIR-579: census of the whole-catalog reads of one Discovery chunk (the statement `... FROM discovery_admission WHERE state='current' ORDER BY film_id`, `readCatalog`).
// `resolveDiscoveryChunk` runs with a D1 stand-in migrated through 0011, not the current production schema. `refreshPredictionQueue` is stubbed and `CanonicalDiscoveryAdmission` is absent, so this measures direct chunk reads, not all production collaborators. Local sqlite only.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-chunk-budget-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
// AIR-374: the schema chain is applied once; every later database is a copy of that file (it holds no data), which skips 11 migration reads and a sqlite round trip per fixture.
let template=null;
const migrated=()=>{
 const file=path.join(root,'chunk-'+(databases++)+'.sqlite');
 if(template){fs.copyFileSync(template,file);return file;}
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 template=path.join(root,'template.sqlite');fs.copyFileSync(file,template);
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const hotStart=Date.now()+3600000;
const RUN='run-budget';
// 20,001 observations put the ledger above READ_CAP, which is what routes a chunk to the paged path.
const WIDE=Number(process.env.CHUNK_BUDGET_ROWS)||20001;
const HOT=[
 // Priority: hot first, then has a year, then the latest airing, then the key. `h-e` has no year.
 {key:'h-a',year:2001,lastAiring:hotStart+5000},
 {key:'h-b',year:2001,lastAiring:hotStart+9000},
 {key:'h-c',year:1990,lastAiring:hotStart+9000},
 {key:'h-d',year:2001,lastAiring:hotStart+9000},
 {key:'h-e',year:null,lastAiring:hotStart+20000},
];
const hotItem=(spec)=>({key:spec.key,title:'Film '+spec.key,normalizedTitle:'film '+spec.key,year:spec.year,durations:[100],shows:[{channelId:'c',channel:'C',start:spec.lastAiring,end:spec.lastAiring+1000}],seenInLatestSnapshot:true,lastAiring:spec.lastAiring});

// One migrated, opened, loaded database. `extraHot` adds more actionable candidates; `decisions` is the stored map.
async function fixture({wide=WIDE,latencyMs=0,onQuery=null,extraHot=0,mix=0,decisions={},decided=[],catalog={},items=[]}={}){
 const file=migrated();
 const db=d1Standin(file,{latencyMs:0});
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const setup={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
 const lease=await Authority.acquireLease(setup,{programmeRunId:null});
 setup.discoveryLease=lease.lease;
 const hot=[...HOT.map(hotItem),...items,...decided.map((key,index)=>hotItem({key,year:2005,lastAiring:hotStart+30000+index}))];
 // `mixNN` titles carry no punctuation, so the stub can answer a search for exactly that title.
 for(let index=0;index<mix;index++){const key='mix'+String(index).padStart(2,'0');hot.push({...hotItem({key,year:2000,lastAiring:hotStart+100000-index}),title:'Film '+key,normalizedTitle:'film '+key});}
 for(let index=0;index<extraHot;index++)hot.push(hotItem({key:'x-'+String(index).padStart(3,'0'),year:1980+index%10,lastAiring:hotStart+1000+index}));
 await Authority.ingestLedger(setup,{programmeRunId:RUN,handoff:true,lease:lease.lease,items:(async function*(){for(const item of hot)yield item;})()});
 // AIR-374: the filler observations are generated inside sqlite by a recursive CTE (the same rows as the 400-row INSERT texts built here before, 3 MB of SQL per fixture, 25 fixtures);
 // the key, the zero-padded counter and every other column are the same values.
 const filler=wide-hot.length;
 if(filler>0)sql(file,`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${filler-1}) INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) SELECT 'active','w'||printf('%05d',i),'active','${RUN}','t','T',1990,'',0,1,NULL,NULL,'{"seenInLatestSnapshot":false,"lastSeenAt":1,"title":"T","normalizedTitle":"t","year":1990,"durations":[90]}' FROM n`);
 if(Object.keys(decisions).length)await Authority.routeWrite(setup,'epg/discovery-resolution.json',decisions);
 if(Object.keys(catalog).length)await Authority.upsertAdmissions(setup,catalog,{lease:lease.lease});
 await Authority.releaseLease(setup,lease.lease);
 // The chunk's own handle: the queries it makes pay `latencyMs`; `onQuery` can end the lease mid-chunk.
 const chunkDb=d1Standin(file,{latencyMs,onQuery});
 const env={DB:chunkDb,BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 return {file,env,db:chunkDb};
}

// The discovery source as a vm context, with a controllable clock and a TMDB stub that records its queries.
function chunkContext({clock,onFetch,respond=null,fetchStatus=null,throwTimeout=false,sync=null,authority=Authority}){
 const queueRefreshes=[];
 const realNow=Date.now.bind(Date);
 const FakeDate=class extends Date{static now(){return realNow()+clock.offset;}};
 const searched=[],timeouts=[];
 const signals={timeout(ms){timeouts.push(ms);return AbortSignal.timeout(ms);}};
 const context=vm.createContext({console,Date:FakeDate,Promise,URL,URLSearchParams,AbortSignal:signals,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url),query=parsed.searchParams.get('query');searched.push(query);if(onFetch)onFetch(query,searched.length);if(throwTimeout){const error=new Error('The operation was aborted');error.name='TimeoutError';return Promise.reject(error);}if(fetchStatus)return Promise.resolve(new Response(JSON.stringify({}),{status:fetchStatus,headers:{'Content-Type':'application/json','Retry-After':'60'}}));return Promise.resolve(new Response(JSON.stringify(respond?respond(parsed):{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:authority,pinEpg:async value=>value,
  refreshPredictionQueue:async(target,report,trigger)=>{queueRefreshes.push(trigger);},
  loadJSON:async(target,key)=>{if(key==='sync.json')return sync;if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 return {context,searched,timeouts,queueRefreshes};
}
const statusPayload=file=>sql(file,'SELECT payload_json FROM discovery_status')[0]?.payload_json??null;
const decisionCount=file=>Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision')[0].n);
const leaseRow=file=>sql(file,'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1')[0];

const CATALOG=/FROM discovery_admission WHERE state='current' ORDER BY film_id/;
const FILMS=40;
const catalog={};
for(let n=1;n<=FILMS;n++)catalog['tmdb_'+n]={id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Catalog '+n,original:'Catalog '+n,year:2000,runtime:90,genres:[],actors:[],directors:[],aliases:[],shows:[]};

// One chunk per call; the number of whole-catalog statements per chunk, for the non-paged path (a small ledger) and for the paged path (a ledger above READ_CAP).
async function census(label,{extra}){
 let reads=0,statements=0;
 const {env}=await fixture({catalog,onQuery:text=>{statements++;if(CATALOG.test(text))reads++;},...extra});
 const {context}=chunkContext({clock:{offset:0},respond(url){return {results:[]};}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const perChunk=[];
 for(let chunk=0;chunk<3;chunk++){
  reads=0;statements=0;
  await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
  perChunk.push({catalogReads:reads,statements});
 }
 console.log(JSON.stringify({path:label,perChunk}));
 return perChunk;
}
const small=await census('non-paged (small ledger)',{extra:{wide:60}});
const paged=await census('paged (ledger above READ_CAP)',{extra:{}});
for(const chunk of small)assert.equal(chunk.catalogReads,1,'a non-paged chunk reads the whole catalog once');
for(const chunk of paged)assert.equal(chunk.catalogReads,1,'a paged chunk reads the whole catalog once');
console.log('discovery chunk catalog read census ok');
