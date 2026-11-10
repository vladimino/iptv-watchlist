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

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-chunk-budget-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'chunk-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
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
 const rows=[];
 for(let index=0;index<WIDE-hot.length;index++)rows.push(`('active','w${String(index).padStart(5,'0')}','active','${RUN}','t','T',1990,'',0,1,NULL,NULL,'{"seenInLatestSnapshot":false,"lastSeenAt":1,"title":"T","normalizedTitle":"t","year":1990,"durations":[90]}')`);
 for(let index=0;index<rows.length;index+=400)sql(file,'INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES '+rows.slice(index,index+400).join(','));
 if(Object.keys(decisions).length)await Authority.routeWrite(setup,'epg/discovery-resolution.json',decisions);
 if(Object.keys(catalog).length)await Authority.upsertAdmissions(setup,catalog,{lease:lease.lease});
 await Authority.releaseLease(setup,lease.lease);
 // The chunk's own handle: the queries it makes pay `latencyMs`; `onQuery` can end the lease mid-chunk.
 const chunkDb=d1Standin(file,{latencyMs,onQuery});
 const env={DB:chunkDb,BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 return {file,env,db:chunkDb};
}

// The discovery source as a vm context, with a controllable clock and a TMDB stub that records its queries.
function chunkContext({clock,onFetch,respond=null}){
 const queueRefreshes=[];
 const realNow=Date.now.bind(Date);
 const FakeDate=class extends Date{static now(){return realNow()+clock.offset;}};
 const searched=[],timeouts=[];
 const signals={timeout(ms){timeouts.push(ms);return AbortSignal.timeout(ms);}};
 const context=vm.createContext({console,Date:FakeDate,Promise,URL,URLSearchParams,AbortSignal:signals,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url),query=parsed.searchParams.get('query');searched.push(query);if(onFetch)onFetch(query,searched.length);return Promise.resolve(new Response(JSON.stringify(respond?respond(parsed):{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:Authority,pinEpg:async value=>value,
  refreshPredictionQueue:async(target,report,trigger)=>{queueRefreshes.push(trigger);},
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
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
 const latency=Number(process.env.CHUNK_BUDGET_LATENCY)||20;
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
}
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
 // Only the cheap-pass checkpoint may have been stored before the loss (a loss during the walk stores nothing); never a final summary.
 const storedStatus=statusPayload(base.file);
 if(storedStatus!==statusBefore)assert.equal(JSON.parse(storedStatus).checkpoint,'cheap_pass','no final status after the lease is lost');
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
 // The lease ends during the TMDB phase while no renewal is due: the first fenced write refuses and the renewal confirms the loss.
 const lost=await lostLease({failAt:'final',mutate:()=>false});
 assert.equal(lost.error.timings.failedAt,'write','the first write of the TMDB phase finds the lease gone');
 assert.equal(Number(leaseRow(lost.file).expires_at),1);
}

// 7. The TMDB call cap is enforced at the request boundary: a candidate needing a request past it stops the loop.
// Fifteen candidates whose Film is already in the catalog need only the detail request (15 requests); the sixteenth is
// unknown, its first search is request 16 and its second search would make 17.
const movieFor=(id,title)=>({id,title,original_title:title,release_date:'2000-06-01',runtime:100,overview:'x',credits:{cast:[],crew:[]},translations:{translations:[]},alternative_titles:{titles:[]}});
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
 assert.equal(result.error,null,'normal budget exhaustion is not a failure');
 assert.equal(result.retryAt,null,'and sets no retry time');
 assert.equal(result.stage,'partial');
 assert.equal(result.remaining,16+HOT.length-15);
 assert.equal(decisionCount(file),15,'the sixteenth candidate has no decision');
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
 assert.equal(searched.length,2,'one candidate, two locales; the next request has no time left');
 assert.equal(result.checked,1);
 assert.equal(result.error,null);
 assert.equal(timeouts[0],12000);
 assert.ok(timeouts.some(ms=>ms<12000&&ms>=2000),'the second request carries the shortened timeout: '+timeouts);
 assert.equal(timeouts.filter(ms=>ms<12000).length,1);
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
 assert.equal(Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n),3+HOT.length,'one history row per decision');
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

// 13. A decision the owner stores while the chunk works stands: the chunk skips that key and overwrites nothing.
{
 const {file,env}=await fixture({mix:1});
 const owner={status:'verified',filmId:'tmdb_5',tmdbId:'5',identitySource:'owner'};
 let fired=false;
 const {context}=chunkContext({clock:{offset:0},respond:()=>({results:[]}),onFetch(){
  if(!fired){fired=true;sql(file,`INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, evidence_key, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES ('mix00','${RUN}',1,'verified',NULL,'5','movie','tmdb_5','owner-hash','${JSON.stringify(owner)}')`);}
 }});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease);
 assert.equal(sql(file,"SELECT decision_hash FROM discovery_decision WHERE observation_key='mix00'")[0].decision_hash,'owner-hash');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision_history WHERE observation_key='mix00'")[0].n,0);
 assert.equal(result.error,null);
 assert.equal(result.checked,1+HOT.length,'the candidate counts as handled');
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
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_decision WHERE observation_key='mix00'")[0].n,0,'no decision without its Film');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission")[0].n,1);
 await Authority.releaseLease(env,lease.lease);
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
 assert.equal(first.remaining,0,'every candidate is decided');
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
 assert.equal(searched.length,0,'no candidate is started with no time to store it');
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
 // A D1 that takes five seconds per batch: the final writes alone need most of the budget, so no candidate is started, the
 // chunk says it made no progress and backs off, and its checkpoint is still stored inside the budget.
 const base=await fixture({mix:3});
 const clock={offset:0};
 const env={...base.env,DB:d1Standin(base.file,{onBatch(){clock.offset+=5000;}})};
 const {context,searched}=chunkContext({clock,respond:()=>({results:[]})});
 const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
 let checkpoints=0;
 const result=await context.resolveDiscoveryChunk(env,{films:[]},24,lease.lease,async()=>{checkpoints++;});
 assert.equal(searched.length,0);
 assert.equal(result.checked,0);
 assert.equal(result.error,'wall_budget');
 assert.ok(Date.parse(result.retryAt)>Date.now());
 assert.equal(checkpoints,1);
 assert.ok(result.timings.totalMs<=40000,'the checkpoint is inside the budget: '+result.timings.totalMs);
 assert.equal(Number(sql(base.file,'SELECT COUNT(*) AS n FROM discovery_decision')[0].n),0);
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
 await assert.rejects(()=>Authority.selectActionableObservations(env,{}),error=>error.code==='discovery_fence');
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
console.log('discovery chunk budget ok');
