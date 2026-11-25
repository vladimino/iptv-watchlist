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
import {sqliteSync} from './sqlite-session.mjs';
import {nonFunctional} from './suite-gate.mjs';

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
async function fixture({latencyMs=0,onQuery=null,extraHot=0,mix=0,decisions={},decided=[],catalog={},items=[]}={}){
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
 const filler=WIDE-hot.length;
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
function chunkContext({clock,onFetch,respond=null,fetchStatus=null,throwTimeout=false,sync=null,authority=Authority,published=null}){
 const queueRefreshes=[];
 const realNow=Date.now.bind(Date);
 const FakeDate=class extends Date{static now(){return realNow()+clock.offset;}};
 const searched=[],timeouts=[];
 const signals={timeout(ms){timeouts.push(ms);return AbortSignal.timeout(ms);}};
 const context=vm.createContext({console,Date:FakeDate,Promise,URL,URLSearchParams,AbortSignal:signals,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url),query=parsed.searchParams.get('query');searched.push(query);if(onFetch)onFetch(query,searched.length);if(throwTimeout){const error=new Error('The operation was aborted');error.name='TimeoutError';return Promise.reject(error);}if(fetchStatus)return Promise.resolve(new Response(JSON.stringify({}),{status:fetchStatus,headers:{'Content-Type':'application/json','Retry-After':'60'}}));return Promise.resolve(new Response(JSON.stringify(respond?respond(parsed):{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:authority,pinEpg:async value=>value,
  refreshPredictionQueue:async(target,report,trigger)=>{queueRefreshes.push(trigger);},
  loadJSON:async(target,key)=>{if(key==='sync.json')return sync;if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:published?published():RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 return {context,searched,timeouts,queueRefreshes};
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
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){throw new Error('held walks nothing');}}),error=>error.code==='discovery_unavailable','a held cutover is refused (ADR 0162)');
 sql(file,"UPDATE discovery_authority SET cutover='open' WHERE id=1");
 sql(file,"UPDATE discovery_transfer SET state='loading' WHERE id=1");
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){}}),error=>error.code==='discovery_incomplete');
 sql(file,"UPDATE discovery_transfer SET state='committed' WHERE id=1");
 // A generation that moves under the walk is a fence error, not a quietly torn read.
 await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}}),error=>error.code==='discovery_fence');
}

// 2. The concurrent walk is faster than the sequential one under D1 round-trip latency. That ratio is the runner clock, so the core suite does not gate on it.
await nonFunctional('discovery-chunk-budget-concurrent-walk',async()=>{
 const {env,file}=await fixture();
 // AIR-374: 5 ms per query (was 20 ms): each page costs several queries, so the sequential walk idled 5.3 s at 20 ms; at 5 ms it takes 1.5 s and the concurrent walk is still about 0.17 of it, against the unchanged 0.7 bound.
 const latency=Number(process.env.CHUNK_BUDGET_LATENCY)||5;
 const slow=d1Standin(file,{latencyMs:latency});
 const slowEnv={...env,DB:slow};
 let t=Date.now();
 for(let after='';;){const page=await Authority.readObservationPage(slowEnv,{after});if(!page.more)break;after=page.after;}
 const sequentialMs=Date.now()-t;
 t=Date.now();
 await Authority.walkObservationPages(slowEnv,{concurrency:4,onPage(){}});
 const concurrentMs=Date.now()-t;
 if(process.env.CHUNK_BUDGET_REPORT)console.log(JSON.stringify({rows:WIDE,pages:Math.ceil(WIDE/Authority.LEDGER_PAGE),latencyMsPerQuery:latency,sequentialMs,concurrentMs}));
 assert.ok(concurrentMs<sequentialMs*0.7,`concurrent ${concurrentMs} ms vs sequential ${sequentialMs} ms`);
});
if(process.env.CHUNK_BUDGET_ONLY_WALK){console.log('walk report done');process.exit(0);}

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
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,null,Date.now()-4000);
 assert.equal(result.paged,true);
 // AIR-353: the gap between the start of the request's preflight and the chunk's own clock is reported.
 assert.ok(result.timings.preChunkMs>=4000&&result.timings.preChunkMs<60000,'preChunkMs '+result.timings.preChunkMs);
 assert.equal(context.chunkSummary(result).timings.preChunkMs,result.timings.preChunkMs);
 assert.equal(result.stage,'complete');
 assert.equal(result.checked,HOT.length);
 assert.equal(result.remaining,0);
 // Within the selected page, hot then year then latest airing then key; `h-e` has no year.
 const order=[...new Set(searched.map(title=>title.replace('Film ','')))];
 assert.deepEqual(order,['h-b','h-c','h-d','h-a','h-e']);
 assert.ok(result.timings.renewals>=1,'a lease with less than the margin left is renewed on the first selection query');
 assert.ok(result.timings.firstRenewMs>=0&&result.timings.firstRenewMs<result.timings.totalMs+1);
 assert.ok(result.timings.pages>=1&&result.timings.pages<=Authority.SELECT_QUERIES);
 assert.equal(result.timings.concurrency,1);
 assert.ok(Number(leaseRow(file).expires_at)>Number(before),'the renewal moved the lease expiry forward');
 const summary=JSON.parse(statusPayload(file));
 assert.equal(summary.timings.pages,result.timings.pages);
 // The stored status carries only the time up to its own write; the finished checkpoint is measured after it.
 assert.equal(typeof summary.timings.preCommitMs,'number');
 assert.equal(summary.timings.totalMs,null);
 assert.equal(summary.timings.checkpointMs,null);
 for(const field of ['statusMs','checkpointMs','totalMs'])assert.equal(typeof result.timings[field],'number',field);
 assert.ok(result.timings.totalMs>=result.timings.preCommitMs);
 assert.equal(summary.hopId,lease.lease.id);
 const trace=context.chunkSummary(result);
 assert.equal(trace.timings.renewals,result.timings.renewals);
 assert.equal(JSON.stringify(trace).includes('Film h-'),false,'diagnostics carry no candidate titles');
 await Authority.releaseLease(env,lease.lease);
}

// 4. The chunk stops at its wall budget. A chunk that cannot take any candidate before the budget ends says so and backs off.
{
 const {file,env}=await fixture();
 const clock={offset:0};
 const {context,searched}=chunkContext({clock});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 clock.offset=41000;
 const spent=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(spent.checked,0,'no candidate is started past the budget');
 assert.equal(searched.length,0,'and no TMDB request is made');
 assert.equal(spent.error,'wall_budget');
 assert.ok(Date.parse(spent.retryAt)>Date.now(),'a budget stop with candidates waiting backs off instead of repeating');
 assert.equal(spent.stage,'partial');
 assert.ok(statusPayload(file));
 // The next chunk sees the back-off and reads nothing.
 clock.offset=0;
 const again=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(again.stage,'backoff');
 assert.equal(searched.length,0);
 await Authority.releaseLease(env,lease.lease);
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
async function lostLease({failAt,mutate,budget}){
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
 try{await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,null,null,budget);}catch(e){error=e;}
 assert.ok(error,'the chunk must not complete');
 assert.equal(error.name,'LeaseLostError');
 assert.equal(error.message,'resolver lease lost');
 // Only the cheap-pass checkpoint may have been stored before the loss (a loss during the walk stores nothing); never a final summary.
 const storedStatus=statusPayload(base.file);
 if(storedStatus!==statusBefore)assert.equal(JSON.parse(storedStatus).checkpoint,'cheap_pass','no final status after the lease is lost');
 if(failAt==='final'){
  assert.equal(sql(base.file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE json_extract(payload_json,'$.deferReason')='wall_budget'")[0].n,decisionCount(base.file));
  assert.ok(decisionCount(base.file)<=1,'only the pre-TMDB fairness fence may land before the lost lease');
 }else assert.equal(decisionCount(base.file),decisionsBefore);
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
 // AIR-682: the same loss under the Workflow's 300 s budget still fails closed at the heartbeat.
 const lost=await lostLease({budget:300000,failAt:'heartbeat',mutate:(text,state)=>{if(/FROM discovery_observation_show/.test(text)){sql(state.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');state.lease.expiresAt=Date.now()+30000;return true;}return false;}});
 assert.equal(lost.error.timings.failedAt,'heartbeat');
 assert.equal(Number(leaseRow(lost.file).expires_at),1,'an expired lease stays expired under a 300 s budget');
}
{
 // AIR-682: another hop took the lease under a 300 s budget: this hop cannot renew or write.
 const lost=await lostLease({budget:300000,failAt:'heartbeat',mutate:(text,state)=>{if(/FROM discovery_observation_show/.test(text)){sql(state.file,"UPDATE discovery_lease SET lease_id='other-hop', expires_at="+(Date.now()+80000)+' WHERE id=1');state.lease.expiresAt=Date.now()+30000;return true;}return false;}});
 assert.equal(lost.error.timings.failedAt,'heartbeat');
}
{
 // Another hop took the lease during the walk: this hop cannot renew or write.
 const lost=await lostLease({failAt:'heartbeat',mutate:(text,state)=>{if(/FROM discovery_observation_show/.test(text)){sql(state.file,"UPDATE discovery_lease SET lease_id='other-hop', expires_at="+(Date.now()+80000)+' WHERE id=1');state.lease.expiresAt=Date.now()+30000;return true;}return false;}});
 assert.equal(lost.error.timings.failedAt,'heartbeat');
 assert.equal(leaseRow(lost.file).lease_id,'other-hop');
}
{
 // The lease ends during the TMDB phase while no renewal is due: the first fenced write refuses and the renewal confirms the loss.
 const lost=await lostLease({failAt:'final',mutate:()=>false});
 assert.equal(lost.error.timings.failedAt,'write','the first write of the TMDB phase finds the lease gone');
 assert.equal(Number(leaseRow(lost.file).expires_at),1);
}

// 7. The TMDB call cap is enforced at the request boundary: a candidate needing a request past it stops the loop.
// Fifteen candidates whose Film is already in the catalog need only the detail request (15 requests); the sixteenth is
// unknown, its first search is request 16 and its second search would make 17.
const movieFor=(id,title)=>({id,title,original_title:title,release_date:'2000-06-01',runtime:100,overview:'x',genres:[{id:18,name:'Drama'}],credits:{cast:[],crew:[]},translations:{translations:[]},alternative_titles:{titles:[]}});
const knownFilm=index=>{const key='mix'+String(index).padStart(2,'0'),tmdb=1000+index;return {id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2000};};
{
 const catalog={};for(let index=0;index<15;index++){const film=knownFilm(index);catalog[film.id]=film;}
 const {file,env}=await fixture({mix:16,catalog});
 const {context,searched}=chunkContext({clock:{offset:0},respond(url){
  if(url.pathname.includes('/movie/')){const id=Number(url.pathname.split('/').pop());return movieFor(id,'Film mix'+String(id-1000).padStart(2,'0'));}
  return {results:[]};
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(searched.length,16,'exactly the cap, never 17');
 assert.equal(result.tmdbCalls,16);
 assert.equal(result.checked,15,'the candidate that would pass the cap is not counted');
 assert.equal(result.deferred,1,'the TMDB-touched remainder is fenced, not left as head-of-line');
 assert.equal(result.error,null,'normal budget exhaustion is not a failure');
 assert.equal(result.retryAt,null,'and sets no series retry time');
 assert.equal(result.stage,'partial');
 assert.equal(result.remaining,16+HOT.length-15-1);
 assert.equal(decisionCount(file),16);
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE json_extract(payload_json,'$.deferReason')='wall_budget'")[0].n,1);
 await Authority.releaseLease(env,lease.lease);
}

// 8. A slow D1 that made the old full-ledger walk miss its budget still selects candidates: the chunk
// does not issue the page-start ROW_NUMBER query, and it starts TMDB work.
{
 const clock={offset:0};
 const base=await fixture();
 let numbered=0;
 const env={...base.env,DB:d1Standin(base.file,{onQuery(text){
  if(/ROW_NUMBER/.test(text))numbered++;
  if(/FROM discovery_observation/.test(text))clock.offset+=2000;
 }})};
 const {context,searched}=chunkContext({clock});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 let checkpoints=0;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;});
 assert.equal(numbered,0,'the paged chunk no longer walks page starts');
 assert.ok(result.checked>0,'keyset selection still takes a candidate');
 assert.ok(searched.length>0);
 assert.equal(result.error,null);
 assert.equal(checkpoints,1,'the checkpoint is still written');
 assert.ok(statusPayload(base.file));
 assert.ok(result.timings.walkMs>=0);
 await Authority.releaseLease(env,lease.lease);
}
{
 const {env}=await fixture();
 let pages=0;
 const stopped=await Authority.walkObservationPages(env,{shouldStop:()=>true,onPage(){pages++;}});
 assert.equal(stopped.complete,false);
 assert.equal(pages,0);
 const whole=await Authority.walkObservationPages(env,{shouldStop:()=>false,onPage(){pages++;}});
 assert.equal(whole.complete,true);
 assert.equal(whole.items,WIDE);
}

// 9. A TMDB request is given only the time left: its own timeout is cut, and a request with less than the minimum left is not made.
{
 const base=await fixture();
 const clock={offset:0};
 // The first request takes 21 s, the second 11 s: the second is made with 11 s left and carries a timeout cut to it, and the
 // next candidate, which would need a request and two writes past the durable-write deadline, is not started.
 const {context,searched,timeouts}=chunkContext({clock,onFetch(query,n){clock.offset+=n===1?21000:11000;}});
 const lease=await Authority.acquireLease(base.env,{programmeRunId:RUN});base.env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(base.env,{films:[]},24,lease.lease);
 assert.ok(searched.length>=2,'at least one candidate makes two locale requests');
 assert.equal(timeouts[0],12000);
 assert.ok(timeouts.some(ms=>ms<12000&&ms>=2000),'a later request carries the shortened timeout: '+timeouts);
 await Authority.releaseLease(base.env,lease.lease);
}

// 10. The durable checkpoint is measured separately: delayed status and continuation writes show in their own fields,
// not in a total taken before them.
{
 const base=await fixture();
 const env={...base.env,DB:d1Standin(base.file,{onBatch:async statements=>{if(statements.some(item=>/discovery_status/.test(item.text)))await new Promise(resolve=>setTimeout(resolve,120));}})};
 const {context}=chunkContext({clock:{offset:0}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{await new Promise(resolve=>setTimeout(resolve,150));});
 assert.ok(result.timings.statusMs>=110,'status write '+result.timings.statusMs);
 assert.ok(result.timings.checkpointMs>=140,'checkpoint '+result.timings.checkpointMs);
 assert.ok(result.timings.totalMs>=result.timings.preCommitMs+result.timings.statusMs+result.timings.checkpointMs-5,'the total covers the writes');
 const stored=JSON.parse(statusPayload(base.file)).timings;
 assert.equal(stored.totalMs,null,'a stored status never claims a finished checkpoint');
 assert.equal(stored.statusMs,null);
 await Authority.releaseLease(env,lease.lease);
}


// 11. The paged chunk resolves its candidates and stores the result, one Film and one decision each, and never repeats
// a candidate it has decided: a second chunk makes progress instead of searching the same titles again.
{
 const {file,env}=await fixture({mix:3});
 const detail=url=>{const id=Number(url.pathname.split('/').pop());return movieFor(id,'Film mix'+String(id-1000).padStart(2,'0'));};
 const respond=url=>{
  if(url.pathname.includes('/movie/'))return detail(url);
  const title=url.searchParams.get('query'),index=Number(title.slice(-2));
  // mix00 matches; every other title matches nothing.
  return {results:index===0?[{id:1000,title,original_title:title,release_date:'2000-06-01'}]:[]};
 };
 const first=chunkContext({clock:{offset:0},respond});
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const one=await first.context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(one.stage,'complete');
 assert.equal(one.error,null);
 assert.equal(one.added,1);
 assert.equal(one.checked,3+HOT.length,'all eight actionable candidates were resolved');
 assert.equal(one.remaining,0);
 const decisionsNow=Object.fromEntries(sql(file,'SELECT observation_key, status, film_id FROM discovery_decision').map(row=>[row.observation_key,row]));
 assert.equal(decisionsNow.mix00.status,'verified');
 assert.equal(decisionsNow.mix00.film_id,'tmdb_1000');
 assert.equal(decisionsNow.mix01.status,'no_confident_match');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE state='current'")[0].n,1);
 assert.equal(sql(file,"SELECT canonical_identity FROM discovery_admission")[0].canonical_identity,'tmdb:1000');
 assert.equal(new Set(sql(file,'SELECT observation_key AS k FROM discovery_decision_history').map(row=>row.k)).size,3+HOT.length);
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n),2*(3+HOT.length),'fairness fence then outcome');
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_score')[0].n),3+HOT.length,'the score preview holds this chunk');
 assert.deepEqual(first.queueRefreshes,[],'the chunk does not refresh the prediction queue; the runner does');
 assert.equal(JSON.parse(statusPayload(file)).checked,3+HOT.length);
 await Authority.releaseLease(env,lease.lease);
 // A second chunk has nothing left: no search, no write, no repeat.
 const second=chunkContext({clock:{offset:0},respond});
 lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const historyBefore=Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n);
 const two=await second.context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(second.searched.length,0,'no title is searched twice');
 assert.equal(two.stage,'complete');
 assert.equal(two.remaining,0);
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n),historyBefore,'and nothing is rewritten');
 assert.deepEqual(second.queueRefreshes,[]);
 await Authority.releaseLease(env,lease.lease);
}

// 12. The cheap pass: screened non-film candidates, known aliases and touched hot Films, a bounded part per chunk.
{
 const nonfilm=index=>({...hotItem({key:'nf'+String(index).padStart(2,'0'),year:null,lastAiring:hotStart+200000+index}),title:'Show: episode '+index,normalizedTitle:'show episode '+index});
 const items=[];for(let index=0;index<45;index++)items.push(nonfilm(index));
 items.push({...hotItem({key:'alias1',year:1999,lastAiring:hotStart+300000}),title:'Known Alias',normalizedTitle:'known alias',confirmedTmdbId:'777'});
 items.push(hotItem({key:'touch1',year:1998,lastAiring:hotStart+310000}));
 const touchFilm={id:'tmdb_2000',tmdbId:'2000',canonicalIdentity:'tmdb:2000',title:'Film touch1',original:'Film touch1',year:1998};
 const decisions={touch1:{status:'verified',filmId:'tmdb_2000',tmdbId:'2000',identitySource:'tmdb_detail'}};
 const {file,env}=await fixture({items,decisions,catalog:{tmdb_2000:touchFilm}});
 const run=()=>chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const first=run();
 const one=await first.context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 // The first 40 decisions in key order: the alias (`alias1` sorts first) and 39 screened ones.
 assert.equal(one.screenedOut+one.reused,40,'at most 40 decisions of the cheap pass are written per chunk');
 assert.equal(one.screenedOut,39);
 assert.equal(one.reused,1);
 assert.equal(one.cheapRemaining,6,'six screened decisions are left; the touched Film fit in its own batch');
 assert.equal(one.touched,1);
 assert.equal(one.stage,'partial','cheap work left keeps the chunk partial');
 const touched=JSON.parse(sql(file,"SELECT payload_json FROM discovery_admission WHERE film_id='tmdb_2000'")[0].payload_json);
 assert.equal(touched.showsProgrammeRunId,RUN,'the hot Film took the candidate airings');
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE status='excluded_nonfilm'")[0].n),39);
 assert.equal(first.searched.some(title=>/Show/.test(title)),false,'a screened title is not searched');
 await Authority.releaseLease(env,lease.lease);
 // The next chunk finds the rest again and writes only that.
 lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const history=Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n);
 const two=await run().context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(two.screenedOut,6);
 assert.equal(two.reused,0);
 assert.equal(two.cheapRemaining,0);
 assert.equal(two.touched,0,'an already touched Film is not rewritten');
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE status='excluded_nonfilm'")[0].n),45);
 assert.equal(sql(file,"SELECT status FROM discovery_decision WHERE observation_key='alias1'")[0].status,'verified');
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n),history+6,'only the new decisions add history');
 await Authority.releaseLease(env,lease.lease);
}

// 12b. ADR 0178 (A1), review of PR 796: the fence of a revoked owner assign survives the screening transition. An observation
// with a revoked-assign fence for id 41 is screened as non-film in one chunk and then gains a confirmed id 41 (a confirmed
// id outranks title screening): the cheap pass must not re-verify the revoked id, and the fence must still be stored.
{
 const item={...hotItem({key:'rv1',year:null,lastAiring:hotStart+400000}),title:'Show: episode 9',normalizedTitle:'show episode 9'};
 const fence={tmdbId:'41',requestId:'req-original-000001',revokedBy:'req-revoke-00000001',at:'2026-11-19T11:00:00.000Z'};
 const decisions={rv1:{status:'needs_verification',attempts:1,evidenceKey:Authority.evidenceKey(item),terminalReason:null,retryAt:null,revokedOwnerAssign:fence}};
 const {file,env}=await fixture({items:[item],decisions});
 const stored=()=>JSON.parse(sql(file,"SELECT payload_json FROM discovery_decision WHERE observation_key='rv1'")[0].payload_json);
 assert.deepEqual(stored().revokedOwnerAssign,fence,'the seeded decision carries the fence');
 const run=()=>chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 await run().context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(stored().status,'excluded_nonfilm','the title is screened as non-film');
 assert.deepEqual(stored().revokedOwnerAssign,fence,'the screening transition keeps the fence');
 await Authority.releaseLease(env,lease.lease);
 // The observation now names the revoked id as its confirmed id, which outranks the title screening.
 sql(file,"UPDATE discovery_observation SET confirmed_tmdb_id='41', payload_json=json_set(payload_json,'$.confirmedTmdbId','41') WHERE observation_key='rv1'");
 lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 await run().context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 const after=stored();
 assert.notEqual(after.status,'verified','the revoked id is not silently re-verified from the confirmed id');
 assert.notEqual(String(after.tmdbId??''),'41');
 assert.deepEqual(after.revokedOwnerAssign,fence,'the fence is still stored');
 await Authority.releaseLease(env,lease.lease);
}

// 13. A decision the owner stores while the chunk works stands: the chunk skips that key and overwrites nothing.
{
 const {file,env}=await fixture({mix:1});
 const owner={status:'verified',filmId:'tmdb_5',tmdbId:'5',identitySource:'owner'};
 let fired=false;
 const {context}=chunkContext({clock:{offset:0},respond:()=>({results:[]}),onFetch(){
  if(!fired){fired=true;sql(file,`UPDATE discovery_decision SET status='verified', tmdb_id='5', media_kind='movie', film_id='tmdb_5', decision_hash='owner-hash', payload_json='${JSON.stringify(owner)}', retry_at=NULL WHERE observation_key='mix00'`);}
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(sql(file,"SELECT decision_hash FROM discovery_decision WHERE observation_key='mix00'")[0].decision_hash,'owner-hash');
 assert.equal(sql(file,"SELECT json_extract(payload_json,'$.deferReason') AS d FROM discovery_decision WHERE observation_key='mix00'")[0].d,null);
 assert.equal(result.error,null);
 assert.equal(result.checked,HOT.length,'the owner key is not counted as this hop\'s TMDB identity');
 await Authority.releaseLease(env,lease.lease);
}

// 14. A Film whose identity belongs to another film id is not merged: the chunk stops, backs off and keeps the decision unwritten.
{
 const clash={id:'legacy_1000',tmdbId:'1000',canonicalIdentity:'tmdb:1000',title:'Legacy'};
 const {file,env}=await fixture({mix:1,catalog:{legacy_1000:clash}});
 const {context}=chunkContext({clock:{offset:0},respond(url){
  if(url.pathname.includes('/movie/'))return movieFor(1000,'Film mix00');
  const title=url.searchParams.get('query');
  return {results:title==='Film mix00'?[{id:1000,title,original_title:title,release_date:'2000-06-01'}]:[]};
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(result.error,'admission_identity_conflict');
 assert.ok(Date.parse(result.retryAt)>Date.now());
 assert.equal(result.added,0);
 assert.equal(sql(file,"SELECT json_extract(payload_json,'$.deferReason') AS d FROM discovery_decision WHERE observation_key='mix00'")[0].d,'wall_budget','identity is not stored; the pre-TMDB fence may stand');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission")[0].n,1);
 await Authority.releaseLease(env,lease.lease);
}

// 14b. ADR 0179 decision 1 (review of PR 799): the no-poster seed follows the COMMITTED verified admission and nothing else.
{
 const NEG='epg/catalog-poster-negatives.json';
 const run=async(detail,catalog={})=>{
  const {file,env}=await fixture({mix:1,catalog});
  const {context}=chunkContext({clock:{offset:0},respond(url){
   if(url.pathname.includes('/movie/'))return detail;
   const title=url.searchParams.get('query');
   return {results:title==='Film mix00'?[{id:1000,title,original_title:title,release_date:'2000-06-01'}]:[]};
  }});
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
  const object=await env.BUCKET.get(NEG);
  const index=object?JSON.parse(await object.text()).entries:null;
  const admitted=Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission")[0].n);
  await Authority.releaseLease(env,lease.lease);
  return {result,index,admitted};
 };
 // a committed new Film whose complete detail says poster_path:null: remembered, no second request
 let out=await run({...movieFor(1000,'Film mix00'),poster_path:null});
 assert.equal(out.result.added,1);assert.ok(out.admitted>=1);assert.equal(out.index['1000'].status,'no_poster_on_tmdb','seeded after the commit');
 // a poster that exists, a missing key and a malformed value are never seeded
 out=await run({...movieFor(1000,'Film mix00'),poster_path:'/real.jpg'});assert.equal(out.result.added,1);assert.equal(out.index,null,'a real poster is not a verdict');
 out=await run(movieFor(1000,'Film mix00'));assert.equal(out.result.added,1);assert.equal(out.index,null,'a missing poster_path is an incomplete answer, never remembered');
 out=await run({...movieFor(1000,'Film mix00'),poster_path:''});assert.equal(out.index,null,'an empty poster_path is not a verdict');
 // a refused admission (the identity belongs to another film id) leaves no remembered answer although the detail was verified
 out=await run({...movieFor(1000,'Film mix00'),poster_path:null},{legacy_1000:{id:'legacy_1000',tmdbId:'1000',canonicalIdentity:'tmdb:1000',title:'Legacy'}});
 assert.equal(out.result.error,'admission_identity_conflict');assert.equal(out.result.added,0);assert.equal(out.index,null,'an uncommitted candidate leaves no 90-day marker');
}


// 15. The continuation, not only the chunk: cheap work left with no candidate left keeps the series going. Through
// `advanceDiscovery` the persisted record stays `paused` with chunks to run, the contract's nextAction is `continue`, the
// next step finishes the cheap work and only then does the record become `complete`.
{
 const nonfilm=index=>({...hotItem({key:'nf'+String(index).padStart(2,'0'),year:null,lastAiring:hotStart+200000+index}),title:'Show: episode '+index,normalizedTitle:'show episode '+index});
 const items=[];for(let index=0;index<45;index++)items.push(nonfilm(index));
 const {file,env}=await fixture({items});
 const {context}=chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 const continuation=()=>{const row=sql(file,'SELECT payload_json FROM discovery_continuation')[0];return row?.payload_json?JSON.parse(row.payload_json):null;};
 const first=await context.advanceDiscovery(env,{});
 assert.equal(first.remaining,5,'unscreened current rows remain; remaining is the SQL set, not the page');
 assert.ok(first.cheapRemaining>0,'and cheap work is left: '+first.cheapRemaining);
 assert.equal(continuation().stage,'paused');
 assert.equal(continuation().reason,null);
 assert.ok(continuation().remainingChunks>0,'the series is not over');
 assert.equal(first.discovery.nextAction,'continue');
 assert.equal(first.diagnostic.chunk.cheapRemaining,first.cheapRemaining,'the step diagnostic carries it');
 const second=await context.advanceDiscovery(env,{});
 assert.equal(second.cheapRemaining,0);
 assert.equal(second.stage,'complete');
 assert.equal(continuation().stage,'complete');
 assert.equal(second.discovery.nextAction,'stop');
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE status='excluded_nonfilm'")[0].n),45);
}

// 16. A slow D1 write path: the cheap pass, the candidate writes and the preview are checked against the clock between
// atomic writes. Already written decisions are kept and counted, work that does not fit is left for the next chunk, and
// the final status and checkpoint are still written inside the budget.
{
 const nonfilm=index=>({...hotItem({key:'nf'+String(index).padStart(2,'0'),year:null,lastAiring:hotStart+200000+index}),title:'Show: episode '+index,normalizedTitle:'show episode '+index});
 const items=[];for(let index=0;index<45;index++)items.push(nonfilm(index));
 const base=await fixture({items});
 const clock={offset:0};
 // Every D1 write batch costs three virtual seconds.
 const env={...base.env,DB:d1Standin(base.file,{onBatch(){clock.offset+=3000;}})};
 const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 let checkpoints=0;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;});
 const stored=Number(sql(base.file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE status='excluded_nonfilm'")[0].n);
 assert.ok(stored>0&&stored<40,'some of the cheap pass is written, not all: '+stored);
 assert.equal(result.screenedOut,stored,'the counters match what is stored');
 assert.equal(result.cheapRemaining,45-stored,'what was not written is counted');
 assert.equal(result.stage,'partial');
 assert.equal(checkpoints,1,'the checkpoint is written');
 assert.ok(result.timings.totalMs<=40000,'the chunk finishes inside the budget: '+result.timings.totalMs);
 assert.ok(result.timings.writeMaxMs>=3000,'the slowest write is measured: '+result.timings.writeMaxMs);
 assert.ok(searched.length>0,'unresolved candidates still start TMDB when cheap writes are slow');
 assert.ok(result.tmdbCalls>0||result.deferred>0||result.checked>0,'candidate work is not starved by the cheap pass');
 assert.ok(statusPayload(base.file));
 await Authority.releaseLease(env,lease.lease);
}
{
 // Candidate writes at 2 virtual seconds per batch: only the candidates whose request and two writes fit are started, and
 // each one that is started is stored whole.
 const base=await fixture({mix:6});
 const clock={offset:0};
 const env={...base.env,DB:d1Standin(base.file,{onBatch(){clock.offset+=2000;}})};
 const movie=(id)=>movieFor(id,'Film mix'+String(id-1000).padStart(2,'0'));
 const {context}=chunkContext({clock,respond(url){
  if(url.pathname.includes('/movie/'))return movie(Number(url.pathname.split('/').pop()));
  const title=url.searchParams.get('query'),index=Number(title.slice(-2));
  return {results:index<6?[{id:1000+index,title,original_title:title,release_date:'2000-06-01'}]:[]};
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(result.timings.preChunkMs,null,'a chunk started without a request entry time reports none');
 const decisions=Number(sql(base.file,'SELECT COUNT(*) AS n FROM discovery_decision')[0].n);
 assert.ok(result.checked>0&&result.checked<6+HOT.length,'some candidates are resolved, not all: '+result.checked);
 assert.equal(decisions,result.checked,'every counted candidate has its decision');
 assert.equal(Number(sql(base.file,"SELECT COUNT(*) AS n FROM discovery_admission")[0].n),result.added,'and every added Film its admission');
 assert.ok(result.timings.totalMs<=40000,'inside the budget: '+result.timings.totalMs);
 assert.equal(result.error,null);
 assert.equal(result.stage,'partial');
 await Authority.releaseLease(env,lease.lease);
}
{
 // A D1 that takes five seconds per batch still checkpoints inside 40 s. Candidate TMDB may start when the
 // yield leaves headroom; series wall_budget only if nothing could start.
 const base=await fixture({mix:3});
 const clock={offset:0};
 const env={...base.env,DB:d1Standin(base.file,{onBatch(){clock.offset+=5000;}})};
 const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 let checkpoints=0;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;});
 assert.equal(checkpoints,1);
 assert.ok(result.timings.totalMs<=40000,'the checkpoint is inside the budget: '+result.timings.totalMs);
 if(searched.length===0){
  assert.equal(result.error,'wall_budget');
  assert.ok(Date.parse(result.retryAt)>Date.now());
 }else{
  assert.notEqual(result.error,'wall_budget');
 }
 await Authority.releaseLease(env,lease.lease);
}

// 6. A lost lease reaches the diagnostics as a bounded timings object and no other candidate detail.
{
 const context=chunkContext({clock:{offset:0}}).context;
 const timings=context.diagnosticTimings({walkMs:12.6,pages:41,renewals:1,firstRenewMs:3,sinceStartMs:108000,failedAt:'final',title:'secret',extra:9});
 assert.deepEqual({...timings},{walkMs:13,pages:41,renewals:1,firstRenewMs:3,sinceStartMs:108000,failedAt:'final'});
 assert.equal(context.diagnosticTimings(null),null);
 assert.equal(context.diagnosticTimings({failedAt:'elsewhere'}),null);
}

// 17. Query-side selection: wrap past the last key, refuse a held marker, and advance selectAfter so the next chunk
// does not repeat a decided observation.
{
 const {env}=await fixture();
 const wrapped=await Authority.selectActionableObservations(env,{after:'zzz'});
 assert.equal(wrapped.wrapped,true);
 assert.ok(wrapped.items.some(row=>row.candidate.key==='h-a'),'the wrap returns the first current key');
}
{
 const {file,env}=await fixture();
 sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(()=>Authority.selectActionableObservations(env,{}),error=>error.code==='discovery_unavailable');
}
{
 const {file,env}=await fixture({mix:2});
 const respond=url=>{
  if(url.pathname.includes('/movie/')){const id=Number(url.pathname.split('/').pop());return movieFor(id,'Film mix'+String(id-1000).padStart(2,'0'));}
  return {results:[]};
 };
 const first=chunkContext({clock:{offset:0},respond});
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const one=await first.context.resolveDiscoveryChunk(env,{films:[]},1,lease.lease);
 assert.equal(one.checked,1);
 const firstKey=sql(file,'SELECT observation_key AS k FROM discovery_decision')[0].k;
 await Authority.releaseLease(env,lease.lease);
 const second=chunkContext({clock:{offset:0},respond});
 lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const two=await second.context.resolveDiscoveryChunk(env,{films:[]},1,lease.lease);
 assert.equal(two.checked,1);
 const secondKey=sql(file,`SELECT observation_key AS k FROM discovery_decision WHERE observation_key<>'${firstKey}'`);
 assert.equal(secondKey.length,1,'the second chunk writes a different key');
 await Authority.releaseLease(env,lease.lease);
}

// 18. remaining and stage follow the global SQL set, not the selected page. 80 extra current rows and limit=1:
// the first chunk stays partial, remaining stays above zero, and later chunks do not rewrite a decided key.
{
 const {file,env}=await fixture({extraHot:80});
 const respond=()=>({results:[]});
 const keys=new Set();
 let remaining=null;
 for(let n=0;n<3;n++){
  const {context}=chunkContext({clock:{offset:0},respond});
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(env,{films:[]},1,lease.lease);
  assert.equal(result.checked,1);
  assert.equal(result.stage,'partial');
  assert.ok(result.remaining>1,'global remaining, not the processed page: '+result.remaining);
  const written=sql(file,'SELECT observation_key AS k FROM discovery_decision').map(row=>row.k);
  assert.equal(written.length,n+1,'each chunk adds one decision');
  for(const key of written)keys.add(key);
  remaining=result.remaining;
  await Authority.releaseLease(env,lease.lease);
 }
 assert.equal(keys.size,3);
 assert.ok(remaining<=80+HOT.length-3);
 const jumped=chunkContext({clock:{offset:0},respond});
 sql(file,"UPDATE discovery_status SET payload_json=json_set(payload_json,'$.selectAfter','zzz')");
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const wrapped=await jumped.context.resolveDiscoveryChunk(env,{films:[]},1,lease.lease);
 assert.equal(wrapped.checked,1);
 const afterWrap=sql(file,'SELECT observation_key AS k FROM discovery_decision').map(row=>row.k);
 assert.equal(new Set(afterWrap).size,4,'wrap does not rewrite a decided key');
 await Authority.releaseLease(env,lease.lease);
}

// 19. SQL eligibility matches resolutionActionability for evidence, retry, terminal, owner rejection and
// standing exclusions. Same-evidence excluded_nonfilm stays out (screen-rule follow-up). Verified rows are
// touches, not the TMDB page. Historical (no current show) is out.
{
 const historical={key:'hist1',title:'Film hist1',normalizedTitle:'film hist1',year:1991,durations:[100],shows:[{channelId:'c',channel:'C',start:1,end:2}],seenInLatestSnapshot:true,lastAiring:1};
 const {file,env}=await fixture({items:[historical]});
 const now=Date.now(),future=new Date(now+86400000).toISOString();
 const ev=row=>sql(file,`SELECT evidence_key AS k FROM discovery_observation WHERE observation_key='${row}'`)[0].k;
 const write=(key,decision)=>sql(file,`INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES ('${key}','${RUN}',1,'${decision.status}',${decision.attempts??'NULL'},${decision.evidence_key==null?'NULL':`'${decision.evidence_key}'`},${decision.terminal_reason==null?'NULL':`'${decision.terminal_reason}'`},${decision.retry_at==null?'NULL':`'${decision.retry_at}'`},NULL,NULL,NULL,'hash','${JSON.stringify(decision.payload)}')`);
 write('h-a',{status:'no_confident_match',attempts:5,evidence_key:ev('h-a'),terminal_reason:'repeated_uncertain_match',retry_at:null,payload:{status:'no_confident_match',terminalReason:'repeated_uncertain_match',evidenceKey:ev('h-a')}});
 write('h-b',{status:'no_confident_match',attempts:1,evidence_key:ev('h-b'),terminal_reason:null,retry_at:future,payload:{status:'no_confident_match',retryAt:future,evidenceKey:ev('h-b')}});
 write('h-c',{status:'excluded_nonfilm',attempts:1,evidence_key:ev('h-c'),terminal_reason:null,retry_at:null,payload:{status:'excluded_nonfilm',evidenceKey:ev('h-c')}});
 write('h-d',{status:'excluded_nonfilm',attempts:1,evidence_key:'old-evidence',terminal_reason:null,retry_at:null,payload:{status:'excluded_nonfilm',evidenceKey:'old-evidence'}});
 write('h-e',{status:'no_confident_match',attempts:1,evidence_key:ev('h-e'),terminal_reason:null,retry_at:null,payload:{status:'no_confident_match',rejectedTmdbIds:['9'],evidenceKey:ev('h-e')}});
 const selected=await Authority.selectActionableObservations(env,{now,pageSize:80});
 const keys=new Set(selected.items.map(row=>row.candidate.key));
 assert.equal(keys.has('hist1'),false,'historical current-flag without a window show is out');
 assert.equal(keys.has('h-a'),false,'same-evidence terminal is out');
 assert.equal(keys.has('h-b'),false,'same-evidence retry fence is out');
 assert.equal(keys.has('h-c'),false,'same-evidence excluded_nonfilm is out');
 assert.equal(keys.has('h-d'),true,'excluded_nonfilm with a new evidence_key is in');
 assert.equal(keys.has('h-e'),true,'an owner rejection on an uncertain decision stays selectable');
 sql(file,"UPDATE discovery_observation SET evidence_key='changed' WHERE observation_key='h-a'");
 const changed=await Authority.selectActionableObservations(env,{now,pageSize:80});
 assert.ok(changed.items.some(row=>row.candidate.key==='h-a'),'a new evidence_key lifts the terminal fence');
}

// 20. Verified touch cursor rotates: more than 38 current verified rows, two chunks, later keys get a turn.
{
 const items=[],decisions={},catalog={};
 for(let index=0;index<45;index++){
  const key='v'+String(index).padStart(2,'0'),tmdb=String(3000+index);
  items.push(hotItem({key,year:1995,lastAiring:hotStart+400000+index}));
  decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'tmdb_detail'};
  catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:1995};
 }
 const {file,env}=await fixture({items,decisions,catalog});
 const run=()=>chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 let lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const one=await run().context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.ok(one.touched>0);
 const firstTouched=sql(file,"SELECT film_id AS id FROM discovery_admission WHERE payload_json LIKE '%showsProgrammeRunId%' ORDER BY film_id");
 await Authority.releaseLease(env,lease.lease);
 lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const two=await run().context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 const secondTouched=sql(file,"SELECT film_id AS id FROM discovery_admission WHERE payload_json LIKE '%showsProgrammeRunId%' ORDER BY film_id");
 assert.ok(secondTouched.length>firstTouched.length,'the second chunk touches a later verified page');
 assert.notEqual(one.touchAfter,two.touchAfter);
 await Authority.releaseLease(env,lease.lease);
}

// 21. EXPLAIN QUERY PLAN of the COUNT on schema 13+ is recorded; sqlite stand-in time is not production D1.
{
 const file=path.join(root,'chunk-explain.sqlite');
 const migrations=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal','0013_film_person_authority','0014_localization_source','0015_film_admission','0016_tmdb_retirement_decision','0017_epg_orchestration','0018_projector_window'];
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+migrations.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'explain migration failed');
 const plan=sqliteSync(['-bail',file],{input:'EXPLAIN QUERY PLAN '+Authority.ACTIONABLE_COUNT_SQL.replace(/\?/g,'0')+';',encoding:'utf8'});
 if(plan.status!==0)throw new Error(plan.stderr||'explain failed');
 const text=String(plan.stdout||'');
 assert.match(text,/SCAN|SEARCH/i);
 fs.writeFileSync(path.join(root,'air-425-count-plan.txt'),text);
 const waitingPlan=sqliteSync(['-bail',file],{input:'EXPLAIN QUERY PLAN '+Authority.WAITING_RETRY_SQL.replace(/\?/g,'0')+';',encoding:'utf8'});
 if(waitingPlan.status!==0)throw new Error(waitingPlan.stderr||'waiting explain failed');
 const waitingText=String(waitingPlan.stdout||'');
 assert.match(waitingText,/SCAN|SEARCH/i);
 fs.writeFileSync(path.join(root,'air-492-waiting-retry-plan.txt'),waitingText);
}

// 22. AIR-492: a slow TMDB candidate that cannot be stored does not pause the series or stick as head-of-line.
{
 const {file,env}=await fixture({extraHot:8});
 const clock={offset:0};
 const {context,searched}=chunkContext({clock,onFetch(){clock.offset+=30000;}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const starved=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(starved.checked,0);
 assert.equal(starved.deferred,1);
 assert.equal(starved.error,null);
 assert.equal(starved.retryAt,null);
 assert.ok(searched.length>=1);
 assert.equal(starved.stage,'partial');
 const hop=context.continuationAfterChunk(starved,20,'hop-1',new Date().toISOString(),RUN);
 assert.notEqual(hop.reason,'backoff');
 assert.equal(hop.retryAt,null);
 assert.equal(hop.remainingChunks,19);
 const deferred=sql(file,"SELECT observation_key AS k, retry_at AS r, status AS s, json_extract(payload_json,'$.deferReason') AS d FROM discovery_decision");
 assert.equal(deferred.length,1);
 assert.equal(deferred[0].d,'wall_budget');
 assert.equal(deferred[0].s,null);
 assert.ok(Date.parse(deferred[0].r)>Date.now());
 const firstKey=deferred[0].k;
 await Authority.releaseLease(env,lease.lease);
 clock.offset=0;
 const next=chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 const lease2=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease2.lease;
 const progressed=await next.context.resolveDiscoveryChunk(env,{films:[]},24,lease2.lease);
 assert.ok(progressed.checked>0,'other eligible keys move after a budget defer');
 const keys=sql(file,'SELECT observation_key AS k FROM discovery_decision').map(row=>row.k);
 assert.ok(keys.some(key=>key!==firstKey),'a different observation is stored');
 assert.equal(keys.filter(key=>key===firstKey).length,1,'the deferred key is not rewritten as checked');
 await Authority.releaseLease(env,lease2.lease);
}

{
 const {env}=await fixture({extraHot:4});
 const clock={offset:0};
 const {context,searched}=chunkContext({clock,fetchStatus:429});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const limited=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.match(String(limited.error),/429/);
 assert.ok(Date.parse(limited.retryAt)>Date.now());
 assert.ok(searched.length>=1);
 const hop=context.continuationAfterChunk(limited,20,'hop-1',new Date().toISOString(),RUN);
 assert.equal(hop.reason,'backoff');
 await Authority.releaseLease(env,lease.lease);
}

{
 const {env}=await fixture();
 const clock={offset:0};
 const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const ok=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(ok.error,null);
 assert.equal(ok.deferred,0);
 assert.equal(ok.checked,HOT.length);
 assert.ok(searched.length>=HOT.length);
 await Authority.releaseLease(env,lease.lease);
}

{
 const {file,env}=await fixture();
 sql(file,"UPDATE discovery_observation SET seen_in_latest=0 WHERE observation_key<>'h-b'");
 const clock={offset:0};
 const {context}=chunkContext({clock,onFetch(){clock.offset+=30000;}});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const starved=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(starved.checked,0);
 assert.equal(starved.deferred,1);
 assert.equal(starved.remaining,0);
 assert.ok(starved.waitingRetry>=1);
 assert.equal(starved.stage,'partial');
 assert.ok(starved.retryAt);
 const hop=context.continuationAfterChunk(starved,20,'hop-1',new Date().toISOString(),RUN);
 assert.equal(hop.stage,'paused');
 assert.notEqual(hop.stage,'complete');
 assert.equal(hop.reason,'backoff');
 await Authority.releaseLease(env,lease.lease);
 sql(file,"UPDATE discovery_decision SET retry_at='2020-01-01T00:00:00.000Z' WHERE json_extract(payload_json,'$.deferReason')='wall_budget'");
 sql(file,"UPDATE discovery_status SET retry_at=NULL, payload_json=json_set(payload_json,'$.retryAt',null)");
 const later=chunkContext({clock:{offset:0},respond:()=>({results:[]})});
 const lease2=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease2.lease;
 const resumed=await later.context.resolveDiscoveryChunk(env,{films:[]},24,lease2.lease);
 assert.equal(resumed.checked,1,'the same generation processes the deferred key after retryAt');
 assert.equal(resumed.stage,'complete');
 assert.equal(resumed.remaining,0);
 assert.equal(resumed.waitingRetry,0);
 await Authority.releaseLease(env,lease2.lease);
}

{
 const {file,env}=await fixture({extraHot:8});
 const runLate=async()=>{
  const clock={offset:0};
  const {context}=chunkContext({clock,onFetch(){clock.offset+=36000;}});
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  let checkpoints=0;
  const late=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;});
  await Authority.releaseLease(env,lease.lease);
  return {late,checkpoints};
 };
 const first=await runLate();
 assert.equal(first.late.deferred,1,'a late TMDB still stores the pre-request fairness fence');
 assert.equal(first.late.error,null);
 assert.equal(first.checkpoints,1);
 assert.ok(first.late.timings.totalMs<=40000,'checkpoint stays inside the wall: '+first.late.timings.totalMs);
 assert.notEqual(first.late.stage,'complete');
 const firstKeys=sql(file,"SELECT observation_key AS k FROM discovery_decision WHERE json_extract(payload_json,'$.deferReason')='wall_budget'").map(row=>row.k);
 assert.equal(firstKeys.length,1);
 const remainingAfterFirst=first.late.remaining;
 const second=await runLate();
 assert.equal(second.late.error,null);
 assert.ok(second.late.timings.totalMs<=40000,'second late hop still checkpoints: '+second.late.timings.totalMs);
 const allKeys=sql(file,"SELECT observation_key AS k FROM discovery_decision WHERE json_extract(payload_json,'$.deferReason')='wall_budget'").map(row=>row.k);
 assert.ok(allKeys.some(key=>key!==firstKeys[0]),'a consecutive late hop fences a different eligible key');
 assert.ok(second.late.remaining<remainingAfterFirst||second.late.checked>0,'eligible work moves without a new generation');
}

{
 const {file,env}=await fixture({extraHot:2});
 const clock={offset:0};
 const {context}=chunkContext({clock,throwTimeout:true});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const timed=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(timed.deferred,1);
 assert.equal(timed.error,null);
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE json_extract(payload_json,'$.deferReason')='wall_budget'")[0].n,1);
 await Authority.releaseLease(env,lease.lease);
}

{
 const {file,env}=await fixture({extraHot:4});
 const clock={offset:0};
 const {context}=chunkContext({clock,onFetch(query){
  clock.offset+=30000;
  const key=String(query||'').replace(/^Film /,'');
  const row=sql(file,`SELECT evidence_key AS k FROM discovery_observation WHERE observation_key='${key}'`)[0];
  if(!row)return;
  sql(file,`UPDATE discovery_decision SET status='no_confident_match', attempts=5, evidence_key='${row.k}', terminal_reason='repeated_uncertain_match', retry_at=NULL, decision_hash='owner-hash', payload_json='${JSON.stringify({status:'no_confident_match',attempts:5,terminalReason:'repeated_uncertain_match',evidenceKey:row.k,owner:true})}' WHERE observation_key='${key}'`);
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const raced=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 const owner=sql(file,"SELECT json_extract(payload_json,'$.owner') AS o, json_extract(payload_json,'$.deferReason') AS d FROM discovery_decision");
 assert.ok(owner.some(row=>row.o===1||row.o===true),'owner decision stands');
 assert.equal(owner.filter(row=>(row.o===1||row.o===true)&&row.d==='wall_budget').length,0);
 await Authority.releaseLease(env,lease.lease);
}

// 17. AIR-492 16 Nov 2026: ~19 verified replay assignments at ~2.8 s plus unresolved candidates must not
// series-backoff with 0 TMDB. Two hops both start candidate work; the 40 s wall and 16-call cap stay.
{
 const decided=[];
 const decisions={};
 const catalog={};
 for(let index=0;index<19;index++){
  const key='rep'+String(index).padStart(2,'0');
  const tmdb=String(4000+index);
  decided.push(key);
  decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'tmdb_detail'};
  catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2005};
 }
 const {file,env}=await fixture({decided,decisions,catalog,extraHot:12});
 const runHop=async()=>{
  const clock={offset:0};
  const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{onBatch(){clock.offset+=2800;}})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  await Authority.releaseLease(hopEnv,lease.lease);
  return {result,searched};
 };
 const first=await runHop();
 assert.notEqual(first.result.error,'wall_budget','slow replay must not set series wall_budget while candidates wait');
 assert.ok(first.searched.length>0,'first hop starts TMDB: '+first.searched.length);
 assert.ok(first.result.tmdbCalls>0);
 assert.equal(first.result.retryAt,null);
 assert.ok(first.result.timings.totalMs<=40000,'inside the wall: '+first.result.timings.totalMs);
 const second=await runHop();
 assert.notEqual(second.result.error,'wall_budget');
 assert.ok(second.searched.length>0||second.result.checked>0||second.result.deferred>0,'second hop still moves eligible work');
 assert.ok(second.result.timings.totalMs<=40000,'second hop inside the wall: '+second.result.timings.totalMs);
}

// 23. AIR-523 17 Nov 2026: a NEW programme generation holds thousands of already verified identities and no assigned row. The batched replay runs first in the
// chunk, owns its own slice of the budget, restores real assignments from the new run's observation rows on the first hop, and still leaves candidate time:
// unresolved work neither displaces it nor is displaced by it. With a fast D1 the whole set is restored in one hop and the cursor wraps to the start.
{
 const replayCount=Authority.REPLAY_PAGE+54,decided=[],decisions={},catalog={};
 for(let index=0;index<replayCount;index++){
  const key='rep'+String(index).padStart(3,'0');
  const tmdb=String(5000+index);
  decided.push(key);
  decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'owner'};
  catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2005};
 }
 const {file,env}=await fixture({decided,decisions,catalog,extraHot:30});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-17T10:00:00Z','x','2026-11-17T10:00:00Z')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const assignedRows=()=>Number(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE basis='discovery'")[0].n);
 const publishedBefore=sql(file,'SELECT generation, watchlist_generation, programme_run_id FROM published_epg_authority')[0];
 const runHop=async({slowMs=0,sync=null}={})=>{
  const clock={offset:0};
  const {context,searched}=chunkContext({clock,sync,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{onBatch(){clock.offset+=slowMs;}})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  await Authority.releaseLease(hopEnv,lease.lease);
  return {result,searched};
 };
 assert.equal(assignedRows(),0);
 // Slow D1 (2.8 s per write batch): real, bounded progress on the first hop, candidates still start, the wall holds, nothing but Discovery state moves.
 const slow=await runHop({slowMs:2800});
 const afterSlow=assignedRows();
 assert.ok(afterSlow>=20,'the first hop restores real assignments despite 30 unresolved candidates and a slow D1: '+afterSlow);
 assert.ok(slow.result.assignment.bulkObservations>0&&slow.result.assignment.assigned>=afterSlow-slow.result.assignment.replayed,'the summary reports the batched replay');
 assert.ok(slow.searched.length>0,'candidate work still starts: '+slow.searched.length);
 assert.notEqual(slow.result.error,'wall_budget');
 assert.ok(slow.result.timings.totalMs<=40000,'inside the wall: '+slow.result.timings.totalMs);
 assert.ok(slow.result.timings.replayMs<=10000+2800,'the replay keeps to its own slice of the budget: '+slow.result.timings.replayMs);
 assert.equal(slow.result.assignment.bulkComplete,false,'a slow hop leaves the cursor mid-circle');
 assert.equal(slow.result.stage,'partial','unfinished replay keeps the series going');
 // A page of 96 rows is three write batches: at 2.8 s each it may not finish inside the slice. The cursor then stays at the page start, which is harmless because the
 // rows already written are no longer selected; the next hop must continue from there and restore more, not rescan the same rows.
 const stored=JSON.parse(statusPayload(file));
 assert.ok(typeof stored.replayAfter==='string'&&stored.programmeRunId===RUN,'the replay cursor belongs to the status of this run');
 const resumed=await runHop({slowMs:2800});
 assert.ok(assignedRows()>afterSlow,'the next slow hop continues and restores more: '+afterSlow+' then '+assignedRows());
 assert.ok(resumed.result.assignment.assigned>0);
 // AIR-535 review: the clock is the generation-matched completion receipt of sync.json. D1 `published_at` (2026-11-17T10:00:00Z, the scan time) differs from the receipt on purpose.
 const stats=JSON.parse(statusPayload(file)).replayStats;
 assert.equal(stats.programmeRunId,RUN);
 assert.equal(stats.epgCompletedAt,null,'no receipt was supplied: the clock is unknown, never the D1 scan time');
 assert.equal(stats.clock,null);assert.equal(stats.firstAssignedSinceCompletedMs,null,'no interval without a clock');
 assert.equal(stats.chunks,2,'two replay chunks so far');
 assert.equal(stats.coverage.basis,'verified_slots_upper_bound');
 assert.equal(stats.coverage.assigned,assignedRows(),'coverage counts every Discovery row of the run, not only this chunk');
 assert.equal(stats.coverage.verifiedSlots,replayCount,'the denominator is the verified observations slots (an upper bound of the eligible ones)');
 assert.ok(stats.firstAssignedAt);
 assert.equal(Boolean(stats.lapCompletedAt),assignedRows()===replayCount,'the lap is stamped complete exactly when every verified observation has its slot');
 // Clock cases on a fresh status each time. scan (D1) 10:00, receipt 11:15, the chunk runs at the real now: the interval is now minus the RECEIPT.
 const receipt='2026-11-17T11:15:00.000Z',cases=[
  ['complete',{runId:RUN,stage:'complete',completedAt:receipt,updatedAt:'2026-11-17T10:59:00.000Z'},receipt,false],
  ['recovered run keeps its receipt',{runId:RUN,stage:'complete',completedAt:receipt,error:'seal_unit'},receipt,true],
  ['legacy record without completedAt',{runId:RUN,stage:'complete',updatedAt:'2026-11-17T11:16:00.000Z'},'2026-11-17T11:16:00.000Z',false],
  ['in flight',{runId:RUN,stage:'epg',updatedAt:receipt},null,null],
  ['another run',{runId:'run-other',stage:'complete',completedAt:receipt},null,null],
  ['complete with an error and no completedAt',{runId:RUN,stage:'complete',error:'x',updatedAt:receipt},null,null],
  ['receipt in the future gives a negative interval, unclamped',{runId:RUN,stage:'complete',completedAt:'2099-01-01T00:00:00.000Z'},'2099-01-01T00:00:00.000Z',false]
 ];
 for(const [label,record,expectedAt,recovered] of cases){
  sql(file,"UPDATE discovery_status SET payload_json=json_remove(payload_json,'$.replayStats','$.replayLapAt')");
  await runHop({slowMs:2800,sync:record});
  const one=JSON.parse(statusPayload(file)).replayStats;
  assert.equal(one.epgCompletedAt,expectedAt,label);assert.equal(one.epgCompletionRecovered,recovered,label);
  assert.equal(one.clock,expectedAt?'sync_completion_receipt':null,label);
  const t50=one.coverageMilestones.t50;
  assert.ok(t50&&t50.at,label+': every verified slot is already assigned, so the milestones are stamped');
  if(expectedAt)assert.equal(t50.sinceCompletedMs,Date.parse(t50.at)-Date.parse(expectedAt),label+': measured against the receipt, not the scan time');
  else assert.equal(t50.sinceCompletedMs,null,label+': no clock, no interval');
  if(expectedAt==='2099-01-01T00:00:00.000Z')assert.ok(t50.sinceCompletedMs<0,'a negative interval is not clamped to zero');
 }
 // A hop retried under the same lease after its status was saved reads that status as prior: its chunk is counted once.
 {
  sql(file,"UPDATE discovery_status SET payload_json=json_remove(payload_json,'$.replayStats','$.replayLapAt')");
  const clock={offset:0};
  const {context}=chunkContext({clock,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  const first=JSON.parse(statusPayload(file)).replayStats.chunks;
  await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  const second=JSON.parse(statusPayload(file)).replayStats.chunks;
  await Authority.releaseLease(hopEnv,lease.lease);
  assert.equal(second,first,'a retried hop under the same lease is not counted twice');
 }
 assert.deepEqual(sql(file,'SELECT generation, watchlist_generation, programme_run_id FROM published_epg_authority')[0],publishedBefore,'only the EPG sync moves the published generation');
 // Uniqueness and provenance: one Film per slot, every row a Discovery row of this run.
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM (SELECT channel_id, start_ms FROM published_epg_show WHERE programme_run_id='"+RUN+"' GROUP BY channel_id, start_ms HAVING COUNT(*)>1)")[0].n),0);
 // A new EPG generation: the stored cursor belongs to the previous run and must not carry over. The new run has no assigned rows; the lowest verified key is restored first.
 // Force a mid-lap cursor (at this page size a slow hop may leave it at the page start) so the test still proves a cursor of another run is ignored.
 sql(file,"UPDATE discovery_status SET payload_json=json_set(payload_json,'$.replayAfter','rep"+String(replayCount-1).padStart(3,'0')+"')");
 assert.ok(JSON.parse(statusPayload(file)).replayAfter);
 sql(file,'DELETE FROM published_epg_show');
 sql(file,"UPDATE discovery_status SET payload_json=json_set(payload_json,'$.programmeRunId','run-previous')");
 const nextGeneration=await runHop({slowMs:2800});
 assert.ok(nextGeneration.result.assignment.bulkObservations>0);
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='rep000'")[0].n)>0,true,'a cursor stored for another run is ignored: the new run starts at its first key');
 // The next natural hops finish the circle; with a fast D1 that is one hop.
 let hops=0,last;
 do{last=await runHop();hops++;}while(last.result.assignment.bulkComplete===false&&hops<5);
 assert.equal(last.result.assignment.bulkComplete,true,'the circle completes');
 assert.equal(assignedRows(),replayCount,'every verified observation of the new run has its slot');
 const again=await runHop();
 assert.equal(again.result.assignment.bulkObservations,0,'a finished replay finds nothing to do and costs one select');
 assert.equal(assignedRows(),replayCount);
}

// 24. The replay of a new generation is not paced by the series backoff. On a D1 so slow that no TMDB request fits after the replay, a chunk whose replay wrote assigned rows
// and has more to restore stores no `wall_budget` and no retry time, so the next chunk follows at once; a chunk that restored nothing (or finished the lap) still backs off.
{
 const decided=[],decisions={},catalog={};
 for(let index=0;index<120;index++){
  const key='rep'+String(index).padStart(3,'0');
  const tmdb=String(7000+index);
  decided.push(key);
  decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'owner'};
  catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2005};
 }
 const {file,env}=await fixture({decided,decisions,catalog,extraHot:30});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-17T10:00:00Z','x','2026-11-17T10:00:00Z')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const assignedRows=()=>Number(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE basis='discovery'")[0].n);
 const runHop=async slowMs=>{
  const clock={offset:0};
  const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{onBatch(){clock.offset+=slowMs;}})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  await Authority.releaseLease(hopEnv,lease.lease);
  return {result,searched};
 };
 // 9 s per write batch: the replay writes, and no TMDB request fits afterwards.
 const first=await runHop(9000);
 assert.ok(first.result.assignment.assigned>0&&first.result.assignment.bulkComplete===false,'the replay restored rows and has more to do');
 assert.equal(first.searched.length,0,'the premise: no TMDB request fit after the replay');
 assert.equal(first.result.error,null,'no wall_budget while the replay makes progress');
 assert.equal(first.result.retryAt,null,'no series backoff while the replay makes progress');
 assert.equal(first.result.stage,'partial');
 // The next chunk continues the circle at once.
 const before=assignedRows();
 const second=await runHop(9000);
 assert.ok(assignedRows()>before&&second.result.retryAt==null);
 // Nothing left to restore: with candidates waiting and no TMDB started, the series backs off as before.
 let guard=0;while(guard++<40&&assignedRows()<120){await runHop(0);}
 assert.equal(assignedRows(),120);
 const idle=await runHop(9000);
 assert.equal(idle.result.assignment.assigned,0);
 assert.equal(idle.searched.length,0);
 assert.equal(idle.result.error,'wall_budget','without replay progress the five-minute backoff still protects a slow D1');
 assert.ok(idle.result.retryAt);
}

// 25. AIR-523, 18 Nov 2026: after the assignments of a new generation were restored, about 200 verified observations stayed unassignable (evidence drift),
// and every chunk scanned them again: no row written, the TMDB candidates never started, a five-minute backoff each time. A completed lap now rests for
// 30 minutes in the same run: the next chunks skip the replay and start TMDB; the next lap after the rest picks up an observation that became assignable.
{
 const decided=[],decisions={},catalog={};
 for(let index=0;index<210;index++){
  const key='drf'+String(index).padStart(3,'0');
  const tmdb=String(8000+index);
  decided.push(key);
  // An anchored duration of 100 minutes against slots of under a minute: never eligible, so `evidence_drift`.
  decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'tmdb_detail',anchor:[100]};
  catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2005};
 }
 // An owner-confirmed identity whose Film has no record yet: `film_absent` until the record exists.
 decided.push('late');decisions.late={status:'verified',filmId:'tmdb_9999',tmdbId:'9999',identitySource:'owner'};
 const {file,env}=await fixture({decided,decisions,catalog,extraHot:30});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-18T00:00:00Z','x','2026-11-18T00:00:00Z')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const runHop=async({slowMs=2800,offset=0}={})=>{
  const clock={offset};
  const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{onBatch(){clock.offset+=slowMs;}})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  await Authority.releaseLease(hopEnv,lease.lease);
  return {result,searched};
 };
 const lap=await runHop();
 assert.equal(lap.result.assignment.assigned,0);
 assert.ok(lap.result.assignment.evidence_drift>=210&&lap.result.assignment.film_absent>=1,'the lap meets the unassignable observations once');
 assert.equal(lap.result.assignment.bulkComplete,true,'the lap reaches the end of the keys and completes');
 assert.ok(JSON.parse(statusPayload(file)).replayLapAt,'the completed lap is stored with the run');
 // The next chunks of the same run rest the replay: nothing is scanned again, and the TMDB candidates get the time.
 for(let hop=0;hop<2;hop++){
  const rested=await runHop();
  assert.equal(rested.result.assignment.bulkResting,true);
  assert.equal(rested.result.assignment.bulkObservations,0,'no rescan of the unassignable observations');
  assert.equal(rested.result.assignment.bulkComplete,true,'a resting replay is not reported as unfinished work');
  assert.ok(rested.searched.length>0,'TMDB candidates start while the replay rests: '+rested.searched.length);
  assert.notEqual(rested.result.error,'wall_budget');
 }
 // The Film record appears during the rest; the next lap, 31 minutes after the completed one, assigns it. No assignment is lost.
 const setup={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const held=await Authority.acquireLease(setup,{programmeRunId:RUN});setup.discoveryLease=held.lease;
 await Authority.upsertAdmissions(setup,{tmdb_9999:{id:'tmdb_9999',tmdbId:'9999',canonicalIdentity:'tmdb:9999',title:'Film late',original:'Film late',year:2005}},{lease:held.lease});
 await Authority.releaseLease(setup,held.lease);
 // The stand-in's clock shifts Date.now() but not new Date(), so the 31 minutes are put on the stored lap time instead of on the clock.
 sql(file,`UPDATE discovery_status SET payload_json=json_set(payload_json,'$.replayLapAt','${new Date(Date.now()-31*60*1000).toISOString()}')`);
 const relap=await runHop();
 assert.equal(relap.result.assignment.bulkResting,false);
 assert.ok(relap.result.assignment.bulkObservations>0,'the rest ends and a new lap runs');
 assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE basis='discovery' AND match_reason='late'")[0].n),1,'the observation that became assignable is assigned');
 // A new generation does not inherit the rest of the previous one: the lap time is run-scoped like the cursor.
 sql(file,"UPDATE discovery_status SET payload_json=json_set(payload_json,'$.programmeRunId','run-previous')");
 const fresh=await runHop();
 assert.equal(fresh.result.assignment.bulkResting,false,'another run starts with a lap');
}
// 26. AIR-535 review: the page of the replay against the TMDB work of the SAME full 40-second hop. Both page sizes run the same mixed fixture (verified observations that need replay plus 30
// unresolved candidates) on the same modelled D1 (a read costs `readMs`, a write batch `batchMs`, on the fake clock). Compared: TMDB requests started, candidates checked, the
// time TMDB and the replay each took, the rows restored and the hop's wall. Modelled, not measured: it shows no displacement of TMDB work by the wider page, nothing about production latency.
{
 const compare=async({readMs,batchMs,page})=>{
  const decided=[],decisions={},catalog={};
  for(let index=0;index<Authority.REPLAY_PAGE*3;index++){
   const key='cmp'+String(index).padStart(3,'0'),tmdb=String(9000+index);
   decided.push(key);decisions[key]={status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,identitySource:'owner'};
   catalog['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Film '+key,original:'Film '+key,year:2005};
  }
  const {file,env}=await fixture({decided,decisions,catalog,extraHot:30});
  sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-17T10:00:00Z','x','2026-11-17T10:00:00Z')`);
  sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
  const clock={offset:0};
  const authority=new Proxy(Authority,{get:(target,prop)=>prop==='replayUnassignedSlots'?(e,spec,ctx)=>target.replayUnassignedSlots(e,{...spec,limit:page},ctx):target[prop]});
  const {context,searched}=chunkContext({clock,authority,respond:()=>({results:[]})});
  const hopEnv={...env,DB:d1Standin(file,{onQuery(){clock.offset+=readMs;},onBatch(){clock.offset+=batchMs;}})};
  const lease=await Authority.acquireLease(hopEnv,{programmeRunId:RUN});hopEnv.discoveryLease=lease.lease;
  const result=await context.resolveDiscoveryChunk(hopEnv,{films:[]},24,lease.lease);
  await Authority.releaseLease(hopEnv,lease.lease);
  const assigned=Number(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE basis='discovery'")[0].n);
  return {page,tmdbStarted:searched.length,checked:result.checked,tmdbCalls:result.tmdbCalls,tmdbMs:result.timings.tmdbMs,replayMs:result.timings.replayMs,totalMs:result.timings.totalMs,assigned,error:result.error};
 };
 const rows=[];
 for(const [label,readMs,batchMs] of [['fast D1, 50 ms per round trip',50,50],['100 ms per round trip',100,100],['slow writes, 2.8 s per batch, 50 ms reads',50,2800]]){
  const before=await compare({readMs,batchMs,page:40}),after=await compare({readMs,batchMs,page:Authority.REPLAY_PAGE});
  rows.push({label,before,after});
  if(process.env.IPTV_PRINT_TIMELINE)console.log(label,JSON.stringify({before,after}));
  assert.ok(after.tmdbStarted>=before.tmdbStarted,label+': the wider page starts at least as many TMDB requests: '+before.tmdbStarted+' -> '+after.tmdbStarted);
  assert.ok(after.checked>=before.checked&&after.tmdbCalls>=before.tmdbCalls,label+': checked and TMDB calls do not fall');
  assert.ok(after.assigned>=before.assigned,label+': at least as many rows restored: '+before.assigned+' -> '+after.assigned);
  assert.ok(after.replayMs<=10000+batchMs,label+': the replay keeps to its slice: '+after.replayMs);
  // With 2.8 s batches the existing path already ends about 50 ms past 40 s (an in-flight batch cannot be pre-empted); the wider page must not make the hop longer.
  assert.ok(after.totalMs<=before.totalMs+250&&after.totalMs<=41000,label+': the hop is no longer than with a page of 40: '+before.totalMs+' -> '+after.totalMs);
  assert.ok(after.replayMs<=before.replayMs+250,label+': the same rows are not restored more slowly: '+before.replayMs+' -> '+after.replayMs);
 }
 if(process.env.IPTV_PRINT_TIMELINE)console.log(JSON.stringify(rows));
}

// AIR-682 (owner decision, 25 Nov 2026): a caller that passes a 300 s chunk budget (the Workflow) runs longer than the 40 s default. Correctness only: one coherent clock.
// The resolver VM clock and the imported DiscoveryAuthority (which reads the host Date.now for acquire, renew and expiry) share one virtual offset, so a lease that is not
// renewed in time really expires. Every D1 write batch costs 3 virtual seconds and every TMDB request 5; 25 eligible candidates make the 16-request cap the stop.
async function sharedClockChunk({budget=300000,disturb=null,mix=20}={}){
 const base=await fixture({mix});
 const clock={offset:0},state={published:RUN,fired:false,firedAtMs:null,decisionsAtFire:null,statusBefore:statusPayload(base.file)};
 const env={...base.env,DB:d1Standin(base.file,{onBatch(){clock.offset+=3000;}})};
 const {context,searched}=chunkContext({clock,published:()=>state.published,onFetch(){
  clock.offset+=5000;
  // A late disturbance: only after the chunk has been running longer than the original 90 s lease TTL.
  if(disturb&&!state.fired&&clock.offset>95000){state.fired=true;state.firedAtMs=clock.offset;state.decisionsAtFire=decisionCount(base.file);state.pending=disturb(base,state);}
 },respond(url){
  if(url.pathname.includes('/movie/')){const id=Number(url.pathname.split('/').pop());return movieFor(id,'Film mix'+String(id-1000).padStart(2,'0'));}
  const title=url.searchParams.get('query'),index=Number(title.slice(-2));
  return {results:index<20?[{id:1000+index,title,original_title:title,release_date:'2000-06-01'}]:[]};
 }});
 // The host clock is patched only after the resolver context captured the real one, so the offset is applied once to each.
 const hostNow=Date.now;Date.now=()=>hostNow.call(Date)+clock.offset;
 let result=null,error=null,checkpoints=0,leaseExpiresAt=null,nowAtEnd=null;
 try{
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  try{result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;},null,budget??undefined);}catch(e){error=e;}
  nowAtEnd=Date.now();leaseExpiresAt=Number(leaseRow(base.file).expires_at);
 }finally{Date.now=hostNow;}
 return {base,state,result,error,checkpoints,searched,leaseExpiresAt,nowAtEnd,clock};
}
{
 // Happy path: a chunk far beyond the original 90 s lease TTL keeps its lease through successive renewals, hits the 16-request cap, and checkpoints once.
 const run=await sharedClockChunk();
 assert.equal(run.error,null,'the long chunk is not cut short by its lease');
 assert.ok(run.result.timings.totalMs>=run.clock.offset&&run.result.timings.totalMs<run.clock.offset+3000,'the chunk clock and the virtual clock agree (the real time of the run is a few ms): '+run.result.timings.totalMs+' vs '+run.clock.offset);
 assert.ok(run.result.timings.totalMs>90000,'the chunk runs longer than the original 90 s lease TTL: '+run.result.timings.totalMs);
 assert.ok(run.result.timings.totalMs<=300000,'and still inside 300 s: '+run.result.timings.totalMs);
 assert.ok(run.result.timings.renewals>=2,'successive heartbeat renewals: '+run.result.timings.renewals);
 assert.ok(run.leaseExpiresAt>run.nowAtEnd,'the persisted lease is still valid at the end of the chunk on the same clock');
 assert.equal(run.searched.length,16,'the TMDB cap is reached and holds');
 assert.equal(run.result.tmdbCalls,16);
 assert.equal(run.result.error,null);
 assert.equal(run.result.stage,'partial');
 assert.equal(run.checkpoints,1,'one durable checkpoint');
 assert.ok(statusPayload(run.base.file),'the final status is durable');
 assert.equal(decisionCount(run.base.file),run.result.checked,'every counted candidate has its decision');
}
{
 // The same chunk under the 40 s default stops long before: the default is unchanged.
 const run=await sharedClockChunk({budget:null});
 assert.equal(run.error,null);
 assert.ok(run.result.timings.totalMs<=40000,'the default budget is 40 s: '+run.result.timings.totalMs);
 assert.ok(run.searched.length<16,'fewer TMDB requests fit in 40 s: '+run.searched.length);
}
for(const [name,disturb] of [
 ['the lease expires late',(base)=>sql(base.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1')],
 ['another hop owns the lease late',(base)=>sql(base.file,"UPDATE discovery_lease SET lease_id='other-hop', expires_at="+(Date.now()+80000)+' WHERE id=1')],
 ['the programme generation changes late',async(base,state)=>{state.published='run-other';sql(base.file,"UPDATE discovery_authority SET programme_run_id='run-other', generation=generation+1 WHERE id=1");await base.env.BUCKET.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:'run-other'}));}],
]){
 const run=await sharedClockChunk({disturb});
 assert.ok(run.state.fired&&run.state.firedAtMs>95000,name+': the disturbance came after the original TTL: '+run.state.firedAtMs);
 if(name==='the programme generation changes late'){
  assert.equal(run.error,null,name);
  assert.equal(run.result.stage,'programme_changed',name+': fails closed');
 }else{
  assert.ok(run.error,name+': the chunk must not complete');
  assert.equal(run.error.name,'LeaseLostError',name);
  assert.equal(run.checkpoints,0,name+': no checkpoint is written for a lost lease');
 }
 assert.equal(decisionCount(run.base.file),run.state.decisionsAtFire,name+': no decision is written after the disturbance');
 const storedStatus=statusPayload(run.base.file);
 if(name!=='the programme generation changes late'&&storedStatus!==run.state.statusBefore)assert.equal(JSON.parse(storedStatus).checkpoint,'cheap_pass',name+': no final status after the lease is lost');
}

console.log('discovery chunk budget ok');
