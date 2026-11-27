// AIR-534: a discovery_fence that is only a CAS collision on discovery_authority.generation must not end the series as programme_changed.
// The pure plan first, then the real chunk against a sqlite stand-in with a recording TMDB stub. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const verified=extra=>({status:'verified',filmId:'member-1',tmdbId:'101',identitySource:'tmdb_detail',anchor:[90],evidenceKey:'film r|2001|90|c:1',...extra});

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-revalidation-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'r-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-reval',MIN=60000,START=Date.now()+3600000;
// A controllable clock for the chunk's own code: the stub below can move it forward when TMDB answers, to cross the persist limit between the read and the writes.
const published={run:'run-reval'};
const clock={offset:0},advance={ms:0};
class SteppedDate extends Date{static now(){return super.now()+clock.offset;}}

async function world({durations,decision,movieRuntime=96,failFetch=false,fillers=0,cachedRuntime=90,observed={title:'Film R',normalized:'film r'},catalog=null,movieTitles={translations:[],alternatives:[]},authority=Authority}){
 clock.offset=0;advance.ms=0;
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const setup={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(setup,{programmeRunId:null});
 setup.discoveryLease=taken.lease;
 const item={key:observed.normalized+'|2001',title:observed.title,normalizedTitle:observed.normalized,year:2001,durations:[...durations],duration:durations[0],shows:durations.map((minutes,index)=>({channelId:'c'+index,channel:'C'+index,start:START+index*4*3600000,end:START+index*4*3600000+minutes*MIN})),seenInLatestSnapshot:true,lastAiring:START};
 await Authority.ingestLedger(setup,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield item;for(let index=0;index<fillers;index++)yield {key:'filler '+index+'|2005',title:'Filler '+index,normalizedTitle:'filler '+index,year:2005,durations:[100],duration:100,shows:[{channelId:'f',channel:'F',start:START+index*1000,end:START+index*1000+100*MIN}],seenInLatestSnapshot:true,lastAiring:START+index*1000+1};})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
 sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:'101',shows:[]}]})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const stored={...decision,evidenceKey:sql(file,`SELECT evidence_key FROM discovery_observation WHERE observation_key='${item.key}'`)[0].evidence_key};
 const wrote=await Authority.writeDecisionDelta(setup,{[item.key]:{previous:null,next:stored}},{lease:taken.lease});
 assert.deepEqual(wrote.written,[item.key],JSON.stringify(wrote));
 if(catalog){const seeded=await Authority.upsertAdmissions(setup,{[catalog.id]:catalog},{lease:taken.lease});assert.deepEqual(seeded.written,[catalog.id],JSON.stringify(seeded));}
 await Authority.releaseLease(setup,taken.lease);
 const hook={fn:null};
 const env={DB:d1Standin(file,{onBatch:statements=>hook.fn?.(statements,file)}),BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const fetched=[];
 const movie={id:101,title:'Film R',original_title:'Film R',release_date:'2001-05-01',runtime:movieRuntime,genres:[{id:18,name:'Drama'}],credits:{crew:[],cast:[]},translations:{translations:movieTitles.translations},alternative_titles:{titles:movieTitles.alternatives}};
 const context=vm.createContext({console,Date:SteppedDate,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url);fetched.push(parsed.pathname);if(parsed.pathname.includes('/movie/'))clock.offset+=advance.ms;if(failFetch.value)return Promise.resolve(new Response('{}',{status:429,headers:{'Retry-After':'30'}}));return Promise.resolve(new Response(JSON.stringify(parsed.pathname.includes('/movie/')?movie:{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  nextCatchUpAt:()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString(),DiscoveryAuthority:authority,pinEpg:async value=>value,refreshPredictionQueue:async()=>{},
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:report.films};if(key==='epg/published-generation.json')return published.phase===null?null:{phase:published.phase??'published',programmeRunId:published.run};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const name of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const report={films:catalog?[]:[{id:'member-1',tmdbId:'101',title:'Film R',original:'Film R',year:2001,runtime:cachedRuntime,canonicalIdentity:'tmdb:101',shows:[]}]};
 const chunk=async()=>{
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  try{
   sql(file,"DELETE FROM discovery_status");
   return await context.resolveDiscoveryChunk(env,report,24,lease.lease);
  }finally{await Authority.releaseLease(env,lease.lease);}
 };
 await setPointer(env,'published');
 const advanceChunk=()=>context.advanceDiscovery(env,{caller:'internal',chunkBudgetMs:60000});
 return {file,env,chunk,advance:advanceChunk,hook,context,fetched,item};
}
async function setPointer(env,phase){if(phase===null)await env.BUCKET.delete('epg/published-generation.json');else await env.BUCKET.put('epg/published-generation.json',JSON.stringify({phase,programmeRunId:RUN}));}
const decisionOf=(file,key='film r|2001')=>JSON.parse(sql(file,`SELECT payload_json FROM discovery_decision WHERE observation_key='${key}'`)[0].payload_json);
const admissionOf=(file,id)=>JSON.parse(sql(file,`SELECT payload_json FROM discovery_admission WHERE film_id='${id}'`)[0].payload_json);
const rowsOf=file=>sql(file,"SELECT channel_id, start_ms, end_ms, basis FROM published_epg_show ORDER BY start_ms");
const movieCalls=fetched=>fetched.filter(pathname=>pathname.includes('/movie/')).length;


const fenceError=()=>Object.assign(new Error('discovery_fence'),{code:'discovery_fence'});
// A. One collision (generation bumped by a concurrent writer, same published run): the chunk retries and finishes; no programme_changed.
{
 const state={left:1,calls:0};let fileRef=null;
 const wrapped={...Authority,writeDecisionDelta:async(...args)=>{state.calls++;if(state.left>0){state.left--;sql(fileRef,"UPDATE discovery_authority SET generation=generation+1 WHERE id=1");throw fenceError();}return Authority.writeDecisionDelta(...args);}};
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});fileRef=w.file;state.left=1;state.calls=0;
 const result=await w.chunk();
 assert.notEqual(result.stage,'programme_changed',JSON.stringify(result));
 assert.equal(result.generationCollision,undefined);
 assert.equal(result.timings.fenceRetries>=1,true,'the collision was retried: '+JSON.stringify(result.timings));
}
// B. Collisions that never clear (bounded): a deferral with retryAt, never programme_changed, and a bounded number of attempts.
{
 const state={calls:0};let fileRef=null;
 const wrapped={...Authority,writeDecisionDelta:async()=>{state.calls++;sql(fileRef,"UPDATE discovery_authority SET generation=generation+1 WHERE id=1");throw fenceError();}};
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});fileRef=w.file;state.calls=0;
 const result=await w.chunk();
 assert.equal(result.stage,'partial',JSON.stringify(result));
 assert.equal(result.generationCollision,true);
 assert.equal(typeof result.retryAt,'string');assert.equal(result.error,null);
 assert.equal(state.calls<=3,true,'at most one try and two retries per write, got '+state.calls);
}
// C. A true generation switch (published run moved) still fails closed with programme_changed and is not retried.
{
 const state={calls:0};let fileRef=null;
 const wrapped={...Authority,writeDecisionDelta:async()=>{state.calls++;sql(fileRef,"UPDATE discovery_authority SET generation=generation+1, programme_run_id='run-other' WHERE id=1");throw fenceError();}};
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});fileRef=w.file;state.calls=0;published.run=RUN;
 // The lease is tied to the run: a real switch of the generation loses it, so the chunk aborts (fail closed) and is never retried.
 await assert.rejects(()=>w.chunk(),error=>error.name==='LeaseLostError');
 assert.equal(state.calls,1,'no retry on a real switch');
 void fileRef;published.run=RUN;
}
// D. AIR-534 review P1: a collision that never clears in the batched replay and in a freshly verified (revalidated) slot assignment defers the chunk the same way.
for(const [label,name] of [['bulk replay','replayUnassignedSlots'],['slot assignment','assignObservationSlots']]){
 const state={calls:0};let fileRef=null;
 const wrapped={...Authority,[name]:async()=>{state.calls++;sql(fileRef,"UPDATE discovery_authority SET generation=generation+1 WHERE id=1");throw fenceError();}};
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});fileRef=w.file;state.calls=0;
 const result=await w.chunk();
 assert.equal(result.stage,'partial',label+': '+JSON.stringify(result).slice(0,300));
 assert.equal(result.generationCollision,true,label);assert.equal(typeof result.retryAt,'string',label);
 assert.equal(state.calls>=1&&state.calls<=3,true,label+': bounded attempts, got '+state.calls);
}
// E. The same two paths with a real run switch are not turned into a deferral.
for(const name of ['replayUnassignedSlots','assignObservationSlots']){
 let fileRef=null;
 const wrapped={...Authority,[name]:async()=>{sql(fileRef,"UPDATE discovery_authority SET generation=generation+1, programme_run_id='run-other' WHERE id=1");throw fenceError();}};
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});fileRef=w.file;
 await assert.rejects(()=>w.chunk(),error=>error.name==='LeaseLostError',name);
}


// F. AIR-687, the incident mechanism on the real sqlite D1 fixture: a competing writer bumps discovery_authority.generation right before the final status batch (an unguarded write).
// The real D1 batch fence fails with a CHECK failure, `discovery_fence` is thrown outside `guarded`, and advanceDiscovery checkpoints it. Before the change that was `stage: error` waiting for the next hour boundary.
const statusBatch=statements=>statements.some(item=>/UPDATE discovery_status/i.test(item.text));
const bumpOnStatus=(w,times,extra=null)=>{w.hook.left=times;w.hook.fn=(statements,file)=>{if(w.hook.left>0&&statusBatch(statements)){w.hook.left--;sql(file,"UPDATE discovery_authority SET generation=generation+1 WHERE id=1");return extra?.(file);}};};
const recordOf=async w=>(await Authority.readContinuation(w.env)).record;
const hourBoundary=()=>Math.floor(Date.now()/3600000+1)*3600000;
{
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]})});
 bumpOnStatus(w,1);
 const first=await w.advance();
 assert.equal(first.stage,'partial',JSON.stringify(first).slice(0,400));
 assert.equal(first.generationCollision,true);
 const record=await recordOf(w);
 assert.equal(record.stage,'paused');assert.equal(record.reason,'backoff');assert.equal(record.fenceCollisions,1);
 const wait=Date.parse(record.retryAt)-Date.now();
 assert.ok(wait>0&&wait<=31000,'a 30 s retry, not the hour boundary: '+wait);
 assert.ok(hourBoundary()-Date.now()<=3600000);
 // The typed collision stays observable, bounded: no raw SQL, no error text.
 const summary=w.context.chunkSummary(first);
 assert.equal(summary.generationCollision,true);assert.equal(summary.fenceCollisions,1);assert.equal(summary.failureKind,'fence');assert.equal(summary.failedAt,null,'the refused write was outside a named phase, so no phase is claimed');
 assert.equal(JSON.stringify(summary).includes('CHECK constraint'),false);
 // After the deferral the same real chunk runs with no competing write and finishes; the counter is cleared and the stored status is a normal one.
 clock.offset+=31000;
 const second=await w.advance();
 assert.notEqual(second.stage,'error',JSON.stringify(second).slice(0,300));
 assert.equal(second.generationCollision,undefined);
 const after=await recordOf(w);
 assert.equal(after.fenceCollisions,undefined);assert.notEqual(after.stage,'error');
 assert.equal(decisionOf(w.file).status,'verified','the decision of the interrupted chunk is intact and not duplicated');
 assert.equal(sql(w.file,"SELECT COUNT(*) AS n FROM discovery_decision")[0].n,1);
 clock.offset=0;
}
// G. Consecutive retries are bounded by the series cap: the seventh refusal returns to the fail-closed error record.
{
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]})});
 bumpOnStatus(w,1000);
 for(let attempt=1;attempt<=6;attempt++){const out=await w.advance();assert.equal(out.generationCollision,true,'attempt '+attempt+': '+JSON.stringify(out).slice(0,200));assert.equal((await recordOf(w)).fenceCollisions,attempt);clock.offset+=31000;}
 const last=await w.advance();
 assert.equal(last.stage,'error',JSON.stringify(last).slice(0,300));
 const record=await recordOf(w);
 assert.equal(record.stage,'error');assert.equal(record.reason,'discovery_fence');assert.equal(record.failureKind,'fence');
 clock.offset=0;
}
// H. Genuine refusals are not retried: a replaced/expired lease, a non-published pointer, a held authority and a refusal that is not the batch CHECK (no cause: unknown outcome / evidence).
for(const [label,arrange] of [
 ['lease replaced',w=>bumpOnStatus(w,1,file=>sql(file,"UPDATE discovery_lease SET lease_id='other-hop' WHERE id=1"))],
 ['lease expired',w=>bumpOnStatus(w,1,file=>sql(file,"UPDATE discovery_lease SET expires_at=1 WHERE id=1"))],
 ['authority held',w=>bumpOnStatus(w,1,file=>sql(file,"UPDATE discovery_authority SET cutover='held' WHERE id=1"))],
 ['pointer not published',w=>bumpOnStatus(w,1,()=>setPointer(w.env,'candidate'))],
 ['pointer missing',w=>bumpOnStatus(w,1,()=>setPointer(w.env,null))],
]){
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]})});
 arrange(w);
 let out=null,thrown=null;try{out=await w.advance();}catch(e){thrown=e;}
 assert.notEqual(out?.generationCollision,true,label+': '+JSON.stringify(out)?.slice(0,300));
 assert.notEqual((await recordOf(w).catch(()=>null))?.reason,'backoff',label+': no retry checkpoint');
 void thrown;
}
{
 // A fence refusal with no batch CHECK cause (the direct evidence/invariant throw) is never a collision.
 published.run=RUN;
 const wrapped={...Authority,writeContinuation:async(env,record,etag,...rest)=>{if(record?.stage==='running')return Authority.writeContinuation(env,record,etag,...rest);throw fenceError();}};
 const w=await world({durations:[90,96],decision:verified({anchor:[90]}),authority:wrapped});
 await assert.rejects(()=>w.advance(),error=>error.code==='discovery_fence');
 assert.notEqual((await recordOf(w)).reason,'backoff','no retry checkpoint was written for a refusal that is not the batch CHECK');
}
// I. usefulProgress and the Workflow plan, read from the real summaries: a checkpoint of an error or collision chunk with nothing done is not progress; real checked, cheap-pass, replay and assignment work is.
{
 published.run=RUN;
 const w=await world({durations:[90,96],decision:verified({anchor:[90]})});
 const wf=w.context;
 vm.runInContext(fs.readFileSync('src/discovery-workflow.js','utf8').replace(/export \{[^}]+\};/g,'').replace(/^export /gm,''),wf);
 bumpOnStatus(w,1);
 const collided=await w.advance();
 assert.equal(wf.chunkUsefulProgress(collided),false,'a collision retry with nothing checked');
 const plan=wf.workflowPlan({published:RUN,pinned:RUN,record:await recordOf(w),lease:null,now:Date.now(),chunks:0,last:null,uncertainWrites:0,used:0});
 assert.equal(plan.action,'wait');assert.ok(plan.until-Date.now()<=31000,'the plan wakes at the retry, not at the hour: '+(plan.until-Date.now()));
 assert.equal(wf.chunkUsefulProgress({stage:'error',error:'discovery_fence',checked:0}),false);
 assert.equal(wf.chunkUsefulProgress({stage:'partial',checked:0,touched:0,assignment:{assigned:0,replayed:0}}),false);
 assert.equal(wf.chunkUsefulProgress({stage:'partial',checked:3}),true,'checked (the cheap pass is included)');
 assert.equal(wf.chunkUsefulProgress({stage:'partial',checked:0,touched:2}),true);
 assert.equal(wf.chunkUsefulProgress({stage:'partial',checked:0,assignment:{assigned:4,replayed:0}}),true,'replay-only chunk');
 assert.equal(wf.chunkUsefulProgress({stage:'partial',checked:0,assignment:{assigned:0,replayed:2}}),true);
 assert.equal(wf.chunkUsefulProgress({stage:'partial',generationCollision:true,checked:2,touched:1}),true,'real work inside an AIR-534 collision result is kept');
 clock.offset+=31000;
 const done=await w.advance();
 assert.equal(wf.chunkUsefulProgress(done),done.checked>0||done.assignment?.assigned>0||done.assignment?.replayed>0||done.touched>0,'the real recovery chunk is judged on its real summary: '+JSON.stringify({checked:done.checked,assignment:done.assignment?.assigned}));
 clock.offset=0;
}
console.log('discovery fence collision ok');
