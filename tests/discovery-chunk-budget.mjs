// D1 paged discovery chunk: lease heartbeat, bounded wall budget, concurrent ledger read and timings.
// Local sqlite stand-ins only. Nothing here calls Cloudflare, TMDB or production D1.
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

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-chunk-budget-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'chunk-'+(databases++)+'.sqlite');
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=spawnSync('sqlite3',['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const hotStart=Date.now()+3600000;
const RUN='run-budget';
// 20,001 observations put the ledger above READ_CAP, which is what routes a chunk to the paged path.
const WIDE=20001;
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
async function fixture({latencyMs=0,onQuery=null,extraHot=0,decisions={},decided=[]}={}){
 const file=migrated();
 const db=d1Standin(file,{latencyMs:0});
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const setup={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
 const lease=await Authority.acquireLease(setup,{programmeRunId:null});
 setup.discoveryLease=lease.lease;
 const hot=[...HOT.map(hotItem),...decided.map((key,index)=>hotItem({key,year:2005,lastAiring:hotStart+30000+index}))];
 for(let index=0;index<extraHot;index++)hot.push(hotItem({key:'x-'+String(index).padStart(3,'0'),year:1980+index%10,lastAiring:hotStart+1000+index}));
 await Authority.ingestLedger(setup,{programmeRunId:RUN,handoff:true,lease:lease.lease,items:(async function*(){for(const item of hot)yield item;})()});
 const rows=[];
 for(let index=0;index<WIDE-hot.length;index++)rows.push(`('active','w${String(index).padStart(5,'0')}','active','${RUN}','t','T',1990,'',0,1,NULL,NULL,'{"seenInLatestSnapshot":false,"lastSeenAt":1,"title":"T","normalizedTitle":"t","year":1990,"durations":[90]}')`);
 for(let index=0;index<rows.length;index+=400)sql(file,'INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES '+rows.slice(index,index+400).join(','));
 if(Object.keys(decisions).length)await Authority.routeWrite(setup,'epg/discovery-resolution.json',decisions);
 await Authority.releaseLease(setup,lease.lease);
 // The chunk's own handle: the queries it makes pay `latencyMs`; `onQuery` can end the lease mid-chunk.
 const chunkDb=d1Standin(file,{latencyMs,onQuery});
 const env={DB:chunkDb,BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 return {file,env,db:chunkDb};
}

// The discovery source as a vm context, with a controllable clock and a TMDB stub that records its queries.
function chunkContext({clock,onFetch}){
 const realNow=Date.now.bind(Date);
 const FakeDate=class extends Date{static now(){return realNow()+clock.offset;}};
 const searched=[];
 const context=vm.createContext({console,Date:FakeDate,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const query=new URL(url).searchParams.get('query');searched.push(query);if(onFetch)onFetch(query,searched.length);return Promise.resolve(new Response(JSON.stringify({results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:Authority,pinEpg:async value=>value,
  loadJSON:async(target,key)=>{const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 vm.runInContext(fs.readFileSync('src/sources.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/discovery.js','utf8'),context);
 return {context,searched};
}
const statusPayload=file=>sql(file,'SELECT payload_json FROM discovery_status')[0]?.payload_json??null;
const decisionCount=file=>Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision')[0].n);
const leaseRow=file=>sql(file,'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1')[0];

// 1. The concurrent walk reads exactly what the sequential pages read: every key once, each page at most LEDGER_PAGE,
// shows attached, and a held or loading authority fails closed.
{
 const {file,env}=await fixture();
 const sequential=[];
 for(let after='';;){const page=await Authority.readObservationPage(env,{after});sequential.push(...page.items);if(!page.more)break;after=page.after;}
 const concurrent=[];let maxPage=0,batches=0;
 const walked=await Authority.walkObservationPages(env,{concurrency:4,beforeBatch(){batches++;},onPage(items){maxPage=Math.max(maxPage,items.length);concurrent.push(...items);}});
 assert.equal(walked.items,WIDE);
 assert.equal(walked.pages,Math.ceil(WIDE/Authority.LEDGER_PAGE));
 assert.equal(batches,Math.ceil(walked.pages/4));
 assert.ok(maxPage<=Authority.LEDGER_PAGE);
 assert.deepEqual(concurrent.map(item=>item.key),sequential.map(item=>item.key));
 assert.equal(new Set(concurrent.map(item=>item.key)).size,WIDE);
 assert.deepEqual(concurrent.find(item=>item.key==='h-a').shows,sequential.find(item=>item.key==='h-a').shows);
 assert.equal(concurrent.find(item=>item.key==='h-a').shows.length,1);
 sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){throw new Error('held walks nothing');}}),error=>error.code==='discovery_fence');
 sql(file,"UPDATE discovery_authority SET cutover='open' WHERE id=1");
 sql(file,"UPDATE discovery_transfer SET state='loading' WHERE id=1");
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){}}),error=>error.code==='discovery_incomplete');
 sql(file,"UPDATE discovery_transfer SET state='committed' WHERE id=1");
 // A generation that moves under the walk is a fence error, not a quietly torn read.
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}}),error=>error.code==='discovery_fence');
}

// 2. The concurrent walk is faster than the sequential one under D1 round-trip latency, with the same result.
{
 const {env,file}=await fixture();
 const slow=d1Standin(file,{latencyMs:20});
 const slowEnv={...env,DB:slow};
 let t=Date.now();
 for(let after='';;){const page=await Authority.readObservationPage(slowEnv,{after});if(!page.more)break;after=page.after;}
 const sequentialMs=Date.now()-t;
 t=Date.now();
 await Authority.walkObservationPages(slowEnv,{concurrency:4,onPage(){}});
 const concurrentMs=Date.now()-t;
 if(process.env.CHUNK_BUDGET_REPORT)console.log(JSON.stringify({rows:WIDE,pages:Math.ceil(WIDE/Authority.LEDGER_PAGE),latencyMsPerQuery:20,sequentialMs,concurrentMs}));
 assert.ok(concurrentMs<sequentialMs*0.7,`concurrent ${concurrentMs} ms vs sequential ${sequentialMs} ms`);
}

// 3. A successful chunk renews its lease on the walk and records its timings, with eligibility and priority as before.
{
 const decisions={
  'h-x-verified':{status:'verified',filmId:'tmdb_1',tmdbId:'1'},
  'h-x-terminal':{status:'no_confident_match',attempts:5,terminalReason:'repeated_uncertain_match'},
  'h-x-backoff':{status:'no_confident_match',attempts:1,retryAt:new Date(Date.now()+86400000).toISOString()},
 };
 const {file,env}=await fixture({decisions,decided:Object.keys(decisions)});
 const {context,searched}=chunkContext({clock:{offset:0}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 assert.ok(lease.lease);
 // Less than the renew margin left on the lease the chunk holds.
 lease.lease.expiresAt=Date.now()+30000;
 const before=leaseRow(file).expires_at;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(result.paged,true);
 assert.equal(result.stage,'complete');
 assert.equal(result.checked,HOT.length);
 assert.equal(result.remaining,0);
 // hot, then has a year (its value does not rank), then the latest airing, then the key; `h-e` has no year.
 const order=[...new Set(searched.map(title=>title.replace('Film ','')))];
 assert.deepEqual(order,['h-b','h-c','h-d','h-a','h-e']);
 assert.ok(result.timings.renewals>=1,'a lease with less than the margin left is renewed on the first batch');
 assert.ok(result.timings.firstRenewMs>=0&&result.timings.firstRenewMs<result.timings.totalMs+1);
 assert.equal(result.timings.pages,Math.ceil(WIDE/Authority.LEDGER_PAGE));
 assert.equal(result.timings.concurrency,4);
 assert.ok(Number(leaseRow(file).expires_at)>Number(before),'the renewal moved the lease expiry forward');
 const summary=JSON.parse(statusPayload(file));
 assert.equal(summary.timings.pages,result.timings.pages);
 assert.equal(summary.hopId,lease.lease.id);
 const trace=context.chunkSummary(result);
 assert.equal(trace.timings.renewals,result.timings.renewals);
 assert.equal(JSON.stringify(trace).includes('Film h-'),false,'diagnostics carry no candidate titles');
 await Authority.releaseLease(env,lease.lease);
}

// 4. The chunk stops at its wall budget but always takes one candidate, and it stops at the TMDB call cap.
{
 const {file,env}=await fixture();
 const clock={offset:0};
 const {context,searched}=chunkContext({clock});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 clock.offset=41000;
 const slow=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(slow.checked,1,'a chunk past its budget still takes the first candidate');
 assert.equal(slow.stage,'partial');
 assert.equal(slow.remaining,HOT.length-1);
 assert.equal(searched.length,2,'one candidate is a ru-RU and a uk-UA search');
 await Authority.releaseLease(env,lease.lease);
 assert.ok(statusPayload(file));
}
{
 const {env}=await fixture({extraHot:20});
 const clock={offset:0};
 const {context,searched}=chunkContext({clock});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const capped=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(searched.length,16);
 assert.equal(capped.checked,8);
 assert.equal(capped.stage,'partial');
 assert.equal(capped.remaining,HOT.length+20-8);
 await Authority.releaseLease(env,lease.lease);
}

// 5. A lease that is gone is never revived: the chunk fails closed before any write, wherever it finds out.
async function lostLease({failAt,mutate}){
 const clock={offset:0};
 const state={file:null,fired:false};
 const base=await fixture();
 state.file=base.file;
 const onQuery=text=>{if(!state.fired&&state.ready&&mutate(text,state)){state.fired=true;}};
 const env={...base.env,DB:d1Standin(base.file,{onQuery})};
 const {context}=chunkContext({clock,onFetch(){if(failAt==='final'&&!state.fired){state.fired=true;sql(base.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');}}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 state.ready=true;state.lease=lease.lease;
 if(failAt==='heartbeat')lease.lease.expiresAt=Date.now()+30000;
 const statusBefore=statusPayload(base.file),decisionsBefore=decisionCount(base.file);
 let error=null;
 try{await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);}catch(e){error=e;}
 assert.ok(error,'the chunk must not complete');
 assert.equal(error.name,'LeaseLostError');
 assert.equal(error.message,'resolver lease lost');
 assert.equal(statusPayload(base.file),statusBefore,'no status write after the lease is lost');
 assert.equal(decisionCount(base.file),decisionsBefore);
 return {error,file:base.file,lease:lease.lease};
}
{
 // Expired during the walk: found at the next heartbeat, before the TMDB phase.
 const lost=await lostLease({failAt:'heartbeat',mutate:(text,state)=>{if(/FROM discovery_observation_show/.test(text)){sql(state.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');state.lease.expiresAt=Date.now()+30000;return true;}return false;}});
 assert.equal(lost.error.timings.failedAt,'heartbeat');
 assert.equal(lost.error.timings.renewals,1,'the first batch renewed; the next found the lease gone');
 assert.equal(Number(leaseRow(lost.file).expires_at),1,'an expired lease stays expired');
}
{
 // Another hop took the lease during the walk: this hop cannot renew or write.
 const lost=await lostLease({failAt:'heartbeat',mutate:(text,state)=>{if(/FROM discovery_observation_show/.test(text)){sql(state.file,"UPDATE discovery_lease SET lease_id='other-hop', expires_at="+(Date.now()+80000)+' WHERE id=1');state.lease.expiresAt=Date.now()+30000;return true;}return false;}});
 assert.equal(lost.error.timings.failedAt,'heartbeat');
 assert.equal(leaseRow(lost.file).lease_id,'other-hop');
}
{
 // The lease ends during the TMDB phase while no renewal is due: the final fence refuses the write.
 const lost=await lostLease({failAt:'final',mutate:()=>false});
 assert.equal(lost.error.timings.failedAt,'final');
 assert.equal(Number(leaseRow(lost.file).expires_at),1);
}

// 6. A lost lease reaches the diagnostics as a bounded timings object and no other candidate detail.
{
 const context=chunkContext({clock:{offset:0}}).context;
 const timings=context.diagnosticTimings({walkMs:12.6,pages:41,renewals:1,firstRenewMs:3,sinceStartMs:108000,failedAt:'final',title:'secret',extra:9});
 assert.deepEqual({...timings},{walkMs:13,pages:41,renewals:1,firstRenewMs:3,sinceStartMs:108000,failedAt:'final'});
 assert.equal(context.diagnosticTimings(null),null);
 assert.equal(context.diagnosticTimings({failedAt:'elsewhere'}),null);
}
console.log('discovery chunk budget ok');
