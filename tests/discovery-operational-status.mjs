// AIR-430. The operational Discovery status reads only small authoritative records in one consistent snapshot, never the ledger, the decisions or the
// catalog, and a Discovery commit cannot make it fail with `discovery_fence`; the detailed status keeps its snapshot fence and does. The Worker runs in a
// vm on an in-memory R2 and a real Discovery authority on a local sqlite D1 stand-in (migrations to 0018). Local stand-ins only; nothing here calls
// Cloudflare, TMDB or production, and nothing here starts a Discovery chunk.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {d1Standin} from './d1-standin.mjs';
import {migrated,sql} from './discovery-paged-write.mjs';
import {MemoryBucket} from './memory-bucket.mjs';

const BIG_TABLES=/FROM\s+(discovery_observation|discovery_observation_show|discovery_decision|discovery_decision_history|discovery_admission|discovery_segment|discovery_score|discovery_intent)\b|JOIN\s+discovery_(observation|decision|admission)/i;
// 0012-0018 on top of the discovery chain, so the projector window and the seal tables exist as in production.
const later=['0012_discovery_seal','0013_film_person_authority','0014_localization_source','0015_film_admission','0016_tmdb_retirement_decision','0017_epg_orchestration','0018_projector_window'];
function world({ledger=0,mode='d1'}={}){
 const file=migrated();
 for(const name of later)sql(file,fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 sql(file,"UPDATE discovery_authority SET mode='"+mode+"', cutover='open' WHERE id=1");
 const seen={statements:[],queries:0,batched:0,storm:false,writes:0};
 const db=d1Standin(file,{
  onQuery:text=>{seen.queries++;seen.statements.push(text);if(!/^\s*SELECT/i.test(text))seen.writes++;if(seen.storm&&BIG_TABLES.test(text))sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');},
  onBatch:statements=>{for(const item of statements){seen.batched++;seen.statements.push(item.text);if(!/^\s*SELECT/i.test(item.text))seen.writes++;}},
 });
 return {file,db,seen,ledger};
}
async function seed(w,{ledger=0}){
 const bucket=new MemoryBucket(),env={DB:w.db,BUCKET:bucket,discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 const items=async function*(){for(let n=0;n<Math.max(1,ledger);n++)yield {key:'obs-'+n,title:'Film '+n,normalizedTitle:'film '+n,year:2000+n%20,durations:[100],shows:[],seenInLatestSnapshot:true,lastAiring:Date.now()};};
 await Authority.ingestLedger(env,{programmeRunId:'run-1',handoff:true,lease:taken.lease,items:items()});
 return {env,lease:taken.lease};
}
const iso=ms=>new Date(ms).toISOString();
function put(w,table,columns,values){sql(w.file,'DELETE FROM '+table+' WHERE id=1');sql(w.file,'INSERT INTO '+table+' (id,'+columns.join(',')+") VALUES (1,"+values.map(v=>v===null?'NULL':typeof v==='number'?String(v):"'"+String(v).replace(/'/g,"''")+"'").join(',')+')');}
function continuation(w,record){put(w,'discovery_continuation',['revision','programme_run_id','payload_json'],[1,record.programmeRunId||null,JSON.stringify(record)]);}
function status(w,record){put(w,'discovery_status',['programme_run_id','generation','retry_at','payload_json'],[record.programmeRunId||null,1,null,JSON.stringify(record)]);}
function workflow(w,record){put(w,'discovery_workflow',['revision','instance_id','programme_run_id','series','payload_json'],[1,record.instanceId||null,record.programmeRunId||null,Number.isInteger(record.series)?record.series:null,JSON.stringify(record)]);}

function worker(w,extra={}){
 const bucket=new MemoryBucket();
 const env={DB:w.db,BUCKET:bucket,...extra};
 const logs=[];const capture={log:()=>{},info:()=>{},error:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,setTimeout,encodeURIComponent,decodeURIComponent,DiscoveryAuthority:Authority});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/discovery-workflow.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
 ctx.env=env;
 const get=async path=>{const r=await ctx.worker.fetch(new Request('https://site.example'+path),env);let data=null;try{data=await r.json();}catch{}return {status:r.status,data};};
 return {env,get,logs,bucket,ctx};
}
const OPERATIONAL='/api/enrichment/pipeline/status?view=operational',DETAILED='/api/enrichment/pipeline/status';

// 1. A small ledger and a large one: the same bounded statements, none against the ledger, decisions, catalog or segments, all reads.
const measures={};
for(const ledger of [3,1500]){
 const w=world(),{env:seedEnv}=await seed(w,{ledger});
 const at=Date.now();
 continuation(w,{stage:'running',reason:null,at:iso(at-60000),hopId:'hop-1',remainingChunks:7,nextCatchUpAt:null,retryAt:null,programmeRunId:'run-1'});
 status(w,{programmeRunId:'run-1',hopId:'hop-1',stage:'chunk',checked:24,remaining:480,cheapRemaining:120,startedAt:iso(at-90000),finishedAt:iso(at-61000)});
 workflow(w,{phase:'running',instanceId:'wf-1',series:3,programmeRunId:'run-1',updatedAt:iso(at-30000),reason:null,chunksThisInstance:5});
 sql(w.file,"UPDATE discovery_authority SET published_programme_run_id='run-1', programme_run_id='run-1' WHERE id=1");
 const h=worker(w,{DISCOVERY_EXECUTOR:'workflow'});
 w.seen.statements.length=0;w.seen.queries=0;w.seen.batched=0;w.seen.writes=0;
 const t0=performance.now(),r=await h.get(OPERATIONAL),ms=performance.now()-t0;
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const body=r.data;
 assert.equal(body.view,'operational');assert.equal(body.schemaVersion,1);assert.equal(body.source,'d1_snapshot');assert.equal(body.authority.state,'ready');
 assert.equal(body.programmeRunId,'run-1');assert.equal(body.publishedProgrammeRunId,'run-1');
 assert.equal(body.discovery.state,'running');assert.equal(body.discovery.remainingChunks,7);
 assert.equal(body.backlog.chunks.state,'known');assert.equal(body.backlog.chunks.source,'continuation');assert.equal(body.backlog.chunks.remainingChunks,7);assert.equal(body.backlog.ledger.state,'known');assert.equal(body.backlog.ledger.source,'status');assert.equal(body.backlog.ledger.remaining,480);assert.equal(body.backlog.ledger.cheapRemaining,120);assert.equal(body.backlog.ledger.observedAt,iso(at-61000),'the ledger counts carry the time of the chunk that stored them');assert.equal(body.backlog.chunks.observedAt,iso(at-60000),'the chunk budget carries the continuation time');assert.equal(body.executor.workflowSource,'snapshot');
 assert.equal(body.executor.phase,'running');assert.equal(body.executor.series,3);
 assert.equal(body.unavailable.length,0,JSON.stringify(body.unavailable));
 assert.ok(!w.seen.statements.some(text=>BIG_TABLES.test(text)),'no statement touches the ledger, decisions, catalog or segments: '+w.seen.statements.filter(text=>BIG_TABLES.test(text)).slice(0,2).join(' | '));
 assert.equal(w.seen.writes,0,'every statement is a read');
 assert.equal(h.bucket.putCount??0,0);
 measures[ledger]={queries:w.seen.queries+w.seen.batched,batched:w.seen.batched,ms};
 // The same world read in detail, quiet: what the operational view avoids.
 await h.bucket.put('programme.json',JSON.stringify({runId:'run-1',films:[]}));
 w.seen.statements.length=0;w.seen.queries=0;w.seen.batched=0;const t1=performance.now(),full=await h.get(DETAILED),fullMs=performance.now()-t1;
 assert.equal(full.status,200,'the detailed view still answers when nothing changes: '+JSON.stringify(full.data).slice(0,200));assert.ok(Object.hasOwn(full.data,'candidates')&&Object.hasOwn(full.data,'statuses'),'its fields are unchanged');
 measures[ledger].detailedQueries=w.seen.queries+w.seen.batched;measures[ledger].detailedMs=fullMs;
 console.log('ledger',ledger,'observations: operational',measures[ledger].queries,'statements (of which',measures[ledger].batched,'in one batch)',ms.toFixed(0),'ms; detailed',measures[ledger].detailedQueries,'statements',fullMs.toFixed(0),'ms');
 // The same record set read directly: one snapshot, at most 7 statements.
 const direct=await Authority.readOperationalSnapshot({DB:w.db});
 assert.equal(direct.handled,true);assert.ok(direct.statements<=7);assert.equal(measures[ledger].batched,7,'the snapshot is one batch of 7 single-row SELECTs');
 void seedEnv;
}
assert.equal(measures[3].queries,measures[1500].queries,'the cost does not follow the ledger: '+JSON.stringify(measures));
assert.ok(measures[1500].detailedQueries>measures[3].detailedQueries,'the detailed view does follow the ledger: '+JSON.stringify(measures));

// 2. A writer moves the authority generation on every ledger statement: the detailed status (a long scan under a snapshot fence) is refused, the
//    operational status stays readable. Eight concurrent reads agree.
{
 const w=world(),{env:seedEnv}=await seed(w,{ledger:900});
 const at=Date.now();
 continuation(w,{stage:'running',reason:null,at:iso(at-60000),hopId:'hop-9',remainingChunks:3,programmeRunId:'run-1'});
 status(w,{programmeRunId:'run-1',hopId:'hop-9',stage:'chunk',checked:24,remaining:200,finishedAt:iso(at-70000)});
 sql(w.file,"UPDATE discovery_authority SET published_programme_run_id='run-1', programme_run_id='run-1' WHERE id=1");
 const h=worker(w);
 h.bucket.put?.('programme.json',JSON.stringify({runId:'run-1',films:[]}));
 w.seen.storm=true;
 const detailed=await h.get(DETAILED);
 assert.notEqual(detailed.status,200,'the detailed scan is refused while the ledger changes under it: '+JSON.stringify(detailed.data).slice(0,200));
 const many=await Promise.all(Array.from({length:8},()=>h.get(OPERATIONAL)));
 for(const r of many){assert.equal(r.status,200);assert.equal(r.data.view,'operational');assert.equal(r.data.authority.state,'ready');assert.equal(r.data.discovery.remainingChunks,3);}
 assert.equal(new Set(many.map(r=>JSON.stringify(r.data.discovery))).size,1,'concurrent reads agree');
 void seedEnv;
}


// 3. Every honest state of the authority and the records.
{
 const at=Date.now();
 // 3a. Held cutover: answered as held, records not served, nothing thrown.
 const held=world();await seed(held,{ledger:2});sql(held.file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 let r=await worker(held).get(OPERATIONAL);
 assert.equal(r.status,200);assert.equal(r.data.authority.state,'held');assert.ok(r.data.unavailable.includes('records'));assert.equal(r.data.backlog.chunks.state,'unknown');assert.equal(r.data.backlog.ledger.state,'unknown');
 // 3b. A loading transfer: records are still served, the state says loading.
 const loading=world();await seed(loading,{ledger:2});continuation(loading,{stage:'idle',reason:'idle',at:iso(at-1000),remainingChunks:0,programmeRunId:'run-1'});sql(loading.file,"UPDATE discovery_transfer SET state='loading', programme_run_id='run-1' WHERE id=1");
 r=await worker(loading).get(OPERATIONAL);assert.equal(r.status,200);assert.equal(r.data.authority.state,'loading');assert.equal(r.data.lastCheckpoint.stage,'idle');
 // 3c. Unavailable D1: a typed answer, no invented records, no write.
 const broken=world();const bad={...broken.db,prepare(){throw new Error('D1_ERROR: network connection lost');},batch(){throw new Error('D1_ERROR: network connection lost');}};
 r=await worker({...broken,db:bad}).get(OPERATIONAL);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.authority.state,'unavailable');assert.ok(r.data.unavailable.includes('authority'));assert.equal(r.data.source,'none');assert.equal(r.data.backlog.ledger.state,'unknown');
 // 3d. No checkpoint yet: unknown, never a zero. A checkpoint older than the stale limit is stale and keeps its own time.
 const empty=world();await seed(empty,{ledger:1});
 r=await worker(empty).get(OPERATIONAL);assert.equal(r.status,200);assert.equal(r.data.backlog.chunks.state,'unknown');assert.equal(r.data.backlog.chunks.remainingChunks,null);assert.equal(r.data.backlog.ledger.state,'unknown');assert.equal(r.data.backlog.ledger.remaining,null);assert.equal(r.data.lastCheckpoint,null);
 const stale=world();await seed(stale,{ledger:1});const old=at-5*3600000;
 continuation(stale,{stage:'running',reason:null,at:iso(old),hopId:'h',remainingChunks:4,programmeRunId:'run-1'});status(stale,{programmeRunId:'run-1',hopId:'h',stage:'chunk',remaining:90,finishedAt:iso(old+1000)});
 r=await worker(stale).get(OPERATIONAL);assert.equal(r.data.backlog.ledger.state,'stale');assert.equal(r.data.backlog.ledger.remaining,90);assert.equal(r.data.backlog.ledger.observedAt,iso(old+1000));assert.ok(r.data.backlog.ledger.ageMs>=4*3600000);assert.equal(r.data.backlog.chunks.state,'stale');
 // 3e. Empty backlog: the stored zero is reported as a zero from its checkpoint.
 const drained=world();await seed(drained,{ledger:1});continuation(drained,{stage:'complete',reason:'complete',at:iso(at-1000),remainingChunks:0,programmeRunId:'run-1'});status(drained,{programmeRunId:'run-1',stage:'complete',remaining:0,cheapRemaining:0,finishedAt:iso(at-2000)});
 r=await worker(drained).get(OPERATIONAL);assert.equal(r.data.backlog.ledger.state,'known');assert.equal(r.data.backlog.ledger.remaining,0);assert.equal(r.data.backlog.chunks.remainingChunks,0);assert.equal(r.data.discovery.nextAction,'stop');
 // 3f. A stopped Workflow at its step cap with a backlog and a successor series: reported as the executor's own record.
 const capped=world();await seed(capped,{ledger:1});continuation(capped,{stage:'idle',reason:'chunk_budget',at:iso(at-5000),remainingChunks:9,nextCatchUpAt:iso(at+600000),programmeRunId:'run-1'});
 workflow(capped,{phase:'stopped',reason:'step_cap',instanceId:'wf-old',series:4,programmeRunId:'run-1',updatedAt:iso(at-4000),successor:{instanceId:'wf-new',series:5}});
 r=await worker(capped,{DISCOVERY_EXECUTOR:'workflow'}).get(OPERATIONAL);
 assert.equal(r.data.executor.phase,'stopped');assert.equal(r.data.executor.waitingReason,'step_cap');assert.equal(r.data.executor.series,4);assert.equal(r.data.discovery.remainingChunks,9);assert.equal(r.data.backlog.chunks.remainingChunks,9);
 // 3g. A projector window that is held is visible; an expired one is idle.
 const windowed=world();await seed(windowed,{ledger:1});sql(windowed.file,"INSERT INTO projector_window (id,state,owner,requested_at,expires_at) VALUES (1,'held','projector',"+(at-1000)+","+(at+120000)+") ON CONFLICT(id) DO UPDATE SET state='held', owner='projector', requested_at="+(at-1000)+", expires_at="+(at+120000));
 r=await worker(windowed).get(OPERATIONAL);assert.equal(r.data.projectorWindow.state,'held');assert.ok(r.data.projectorWindow.expiresAt);
 sql(windowed.file,"UPDATE projector_window SET expires_at="+(at-5000)+" WHERE id=1");r=await worker(windowed).get(OPERATIONAL);assert.equal(r.data.projectorWindow.state,'idle');
 // 3h. Generation handoff: the published programme moved on while the continuation still names the old one.
 const handoff=world();await seed(handoff,{ledger:1});continuation(handoff,{stage:'running',reason:null,at:iso(at-90000),hopId:'old',remainingChunks:2,programmeRunId:'run-old'});
 sql(handoff.file,"UPDATE discovery_authority SET programme_run_id='run-new', published_programme_run_id='run-new' WHERE id=1");
 r=await worker(handoff).get(OPERATIONAL);assert.equal(r.data.publishedProgrammeRunId,'run-new');assert.equal(r.data.programmeRunId,'run-new');assert.equal(r.data.continuationHealth.generationConflict,true,'the old continuation is flagged against the published programme');
 // 3i. A record that cannot be parsed is named and not replaced by another source.
 const damaged=world();await seed(damaged,{ledger:1});sql(damaged.file,"DELETE FROM discovery_status WHERE id=1");sql(damaged.file,"INSERT INTO discovery_status (id,programme_run_id,generation,retry_at,payload_json) VALUES (1,'run-1',1,NULL,'{broken')");
 r=await worker(damaged).get(OPERATIONAL);assert.equal(r.status,200);assert.ok(r.data.unavailable.includes('status'));assert.equal(r.data.lastChunk,null);
}

// 3j. AIR-430 review: the backlog facts keep their own time and generation. A stale status next to a fresh continuation stays stale and is not refreshed
//     by the continuation; counts of another programme are withheld as foreign, never shown as current.
{
 const at=Date.now(),old=at-5*3600000;
 const mixed=world();await seed(mixed,{ledger:1});
 continuation(mixed,{stage:'running',reason:null,at:iso(at-30000),hopId:'h',remainingChunks:6,programmeRunId:'run-1'});
 status(mixed,{programmeRunId:'run-1',hopId:'h0',stage:'chunk',remaining:777,cheapRemaining:55,finishedAt:iso(old)});
 sql(mixed.file,"UPDATE discovery_authority SET published_programme_run_id='run-1', programme_run_id='run-1' WHERE id=1");
 let r=await worker(mixed).get(OPERATIONAL);
 assert.equal(r.data.backlog.chunks.state,'known');assert.equal(r.data.backlog.chunks.remainingChunks,6);assert.equal(r.data.backlog.chunks.observedAt,iso(at-30000));
 assert.equal(r.data.backlog.ledger.state,'stale','5-hour-old counts are not made fresh by a fresh continuation');assert.equal(r.data.backlog.ledger.observedAt,iso(old));assert.equal(r.data.backlog.ledger.remaining,777);assert.ok(r.data.backlog.ledger.ageMs>=4.9*3600000);
 // A status without any time cannot be dated: unknown, values withheld.
 status(mixed,{programmeRunId:'run-1',stage:'chunk',remaining:5});
 r=await worker(mixed).get(OPERATIONAL);assert.equal(r.data.backlog.ledger.state,'unknown');assert.equal(r.data.backlog.ledger.remaining,null);
 // Generation handoff with different counts per record: the published programme is run-new; the continuation (run-old, 2 chunks) and the status (run-old, 100) are foreign.
 const handoff=world();await seed(handoff,{ledger:1});
 continuation(handoff,{stage:'running',reason:null,at:iso(at-1000),hopId:'old',remainingChunks:2,programmeRunId:'run-old'});status(handoff,{programmeRunId:'run-old',stage:'chunk',remaining:100,finishedAt:iso(at-2000)});
 sql(handoff.file,"UPDATE discovery_authority SET programme_run_id='run-new', published_programme_run_id='run-new' WHERE id=1");
 r=await worker(handoff).get(OPERATIONAL);
 for(const [name,field] of [['chunks','remainingChunks'],['ledger','remaining']]){assert.equal(r.data.backlog[name].state,'foreign',name);assert.equal(r.data.backlog[name][field],null,name+': foreign values are withheld');assert.equal(r.data.backlog[name].programmeRunId,'run-old',name+': the generation they belong to is named');}
 // The same run for both, and the published one: both known.
 status(handoff,{programmeRunId:'run-new',stage:'chunk',remaining:41,finishedAt:iso(at-3000)});continuation(handoff,{stage:'running',reason:null,at:iso(at-1500),hopId:'new',remainingChunks:8,programmeRunId:'run-new'});
 r=await worker(handoff).get(OPERATIONAL);assert.equal(r.data.backlog.ledger.state,'known');assert.equal(r.data.backlog.ledger.remaining,41);assert.equal(r.data.backlog.chunks.remainingChunks,8);
}

// 3k. AIR-430 review: the executor facts come from the Workflow record of the same snapshot. A Workflow transition that lands after the batch (here: while the
//     platform liveness of the instance is being observed) does not mix a newer instance or series into the earlier continuation and authority; the liveness
//     is labeled as a separate observation.
{
 const at=Date.now();
 const w=world();await seed(w,{ledger:1});
 continuation(w,{stage:'running',reason:null,at:iso(at-5000),hopId:'h',remainingChunks:4,programmeRunId:'run-1'});
 workflow(w,{phase:'running',instanceId:'wf-A',series:1,programmeRunId:'run-1',updatedAt:iso(at-2000),reason:null});
 sql(w.file,"UPDATE discovery_authority SET published_programme_run_id='run-1', programme_run_id='run-1' WHERE id=1");
 let lookups=0;
 const binding={async get(id){lookups++;workflow(w,{phase:'running',instanceId:'wf-B',series:2,programmeRunId:'run-1',updatedAt:iso(Date.now()),reason:null});return {status:async()=>({status:'running'})};}};
 const h=worker(w,{DISCOVERY_EXECUTOR:'workflow',DISCOVERY_WORKFLOW:binding});
 w.seen.statements.length=0;
 const r=await h.get(OPERATIONAL);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(lookups,1,'the platform is asked once, for the snapshot\'s instance');
 assert.equal(r.data.executor.instanceId,'wf-A');assert.equal(r.data.executor.series,1,'the executor is the record of the snapshot, not the one written meanwhile');
 assert.equal(r.data.executor.workflowSource,'snapshot');assert.equal(r.data.executor.liveness,'running');assert.equal(r.data.executor.livenessObserved.source,'workflow_binding');assert.equal(r.data.executor.livenessObserved.atomicWithSnapshot,false);
 assert.equal(w.seen.statements.filter(text=>/FROM\s+discovery_workflow/i.test(text)).length,1,'the Workflow table is read once, in the snapshot batch');
 // The next read sees the new record, again as one snapshot.
 const next=await h.get(OPERATIONAL);assert.equal(next.data.executor.instanceId,'wf-B');assert.equal(next.data.executor.series,2);
}

// 4. Outside D1 authority the same view reads the small R2 objects, each on its own; one that fails is named.
{
 const w=world({mode:'r2'});await seed(w,{ledger:1}).catch(()=>{});
 const h=worker(w);const at=Date.now();
 await h.bucket.put('epg/resolver-continuation.json',JSON.stringify({stage:'idle',reason:'chunk_budget',at:iso(at-1000),remainingChunks:5,programmeRunId:'run-r2'}));
 await h.bucket.put('epg/discovery-status.json',JSON.stringify({programmeRunId:'run-r2',stage:'chunk',remaining:33,finishedAt:iso(at-2000)}));
 await h.bucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:'run-r2'}));
 const r=await h.get(OPERATIONAL);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.source,'r2_objects');assert.equal(r.data.authority.state,'r2');assert.equal(r.data.publishedProgrammeRunId,'run-r2');assert.equal(r.data.backlog.ledger.remaining,33);assert.equal(r.data.backlog.ledger.state,'known');
 const originalGet=h.bucket.get.bind(h.bucket);h.bucket.get=async key=>{if(key==='epg/discovery-status.json')throw new Error('R2 down');return originalGet(key);};
 const partial=await h.get(OPERATIONAL);assert.equal(partial.status,200);assert.ok(partial.data.unavailable.includes('status'));assert.equal(partial.data.lastChunk,null);assert.equal(partial.data.discovery.remainingChunks,5,'the other records are still served');
}

// 5. The contract: no `view` and `view=detailed` are the unchanged status, an unknown view is refused before any read, the alias path serves both views,
//    and the MCP tool takes the same argument.
{
 const w=world();await seed(w,{ledger:3});const h=worker(w);await h.bucket.put('programme.json',JSON.stringify({runId:'run-1',films:[]}));
 const plain=await h.get(DETAILED),detailed=await h.get(DETAILED+'?view=detailed');
 assert.equal(plain.status,200);assert.equal(detailed.status,200);assert.deepEqual(Object.keys(plain.data),Object.keys(detailed.data),'detailed is the default body');assert.equal(plain.data.view,undefined,'the legacy body gains no field');
 w.seen.statements.length=0;const bad=await h.get(DETAILED+'?view=everything');assert.equal(bad.status,400);assert.equal(w.seen.statements.length,0,'an invalid view is refused before any read');
 const alias=await h.get('/api/enrichment/discovery/status?view=operational');assert.equal(alias.status,200);assert.equal(alias.data.view,'operational');
}
console.log('discovery operational status tests passed');
