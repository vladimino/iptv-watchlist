// A step invocation that the platform ends without a response (for example `exceededMemory`) runs no further
// code: no catch, no outcome write, no lease release. These cases model that by a storage write that never
// settles, so the step after it never runs, and check what the next explicit step and the read-only views do:
// the dead step's diagnostics entry is closed as `interrupted` with what is known about its commit, a chunk is
// never repeated or dropped, the dead hop cannot write over its successor, and a series whose hops keep dying
// before their checkpoint fails closed instead of being resumed by every scheduled call.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[],hang=null;
const never=new Promise(()=>{});
let released=null;const pending=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  // `hang(key, body)` selects the write at which the invocation is killed; with `released` set the write is held
  // instead and completes later, which lets a test replay the dead hop's late writes against its successor.
  if(hang&&hang(key,JSON.parse(value))){hang=null;if(!released)return never;await new Promise(resolve=>pending.push(resolve));}
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester'};
const fetches=[],logs=[];
let clockTime=Date.now();class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:line=>{logs.push(String(line));}},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
const execution={waitUntil(){}};
const origin='https://iptv.vladimino.workers.dev',headers={'Content-Type':'application/json'};
const post=async(path,body)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const status=async()=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,execution)).json();
const step=()=>post('/api/sync/epg',{runId:'sync-1'});
// Starts a step that is killed at the selected write: the returned promise never settles, as for a killed invocation.
async function killedStep(at){hang=at;const dead=step();dead.catch(()=>{});for(let i=0;i<200&&hang;i++)await new Promise(resolve=>setTimeout(resolve,0));assert.equal(hang,null,'the step reached the write it dies at');return {dead};}
const iso=ms=>new Date(ms).toISOString();
const GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',NEXT='5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
const continuation=()=>records.get('epg/resolver-continuation.json');
const ring=()=>records.get('epg/resolver-continuation-diagnostics.json')?.recent||[];
const decided=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
const logged=()=>logs.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry?.event==='epg_continuation');
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:clockTime,lastAiring:clockTime,airings:1,shows:[{channelId:'t',channel:'T',start:clockTime,end:clockTime+3600000}]}));
const CHUNK=24,LATER=16*60000;
function seed(){
 records.clear();etags.clear();puts=[];fetches.length=0;logs.length=0;hang=null;released=null;pending.length=0;clockTime=Date.now();
 set('programme.json',{runId:GENERATION,updatedAt:iso(clockTime),films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 set('sync.json',{runId:'sync-1',stage:'complete',updatedAt:iso(clockTime)});
 set(call('profileKey'),{version:1,profileHash:'p'});
 set('epg/discovery-latest.json',{programmeRunId:GENERATION,items:items(200)});
 set('epg/published-generation.json',{phase:'published',programmeRunId:GENERATION});
 set('epg/discovery-resolution.json',{});
 set('epg/resolver-continuation.json',{stage:'paused',reason:'epg_committed',at:iso(clockTime),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
}
const finalStatus=(key,body)=>key==='epg/discovery-status.json'&&typeof body.finishedAt==='string';
const leaseRelease=(key,body)=>key==='epg/resolver-lease.json'&&body.expiresAt===0;
const SECRET=/Hot Film|Bearer|token=/;

// 1. Killed after its checkpoint (the production shape of 28 Oct 05:22 UTC): the chunk and its checkpoint are stored,
//    the lease release and the response are not. The ring says `checkpointed` with the stored checkpoint.
seed();
await killedStep(leaseRelease);
const deadHop=continuation().hopId,deadEntry=ring()[0];
assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,11);assert.equal(decided(),CHUNK);
assert.equal(deadEntry.phase,'checkpointed');
assert.deepEqual(deadEntry.checkpoint,{hopId:deadHop,owned:true,write:'saved',stage:'paused',remainingChunks:11});
assert.equal(deadEntry.recorded.checkpoint,undefined,'the stored entry cannot know about its own write');
assert.equal(records.get('epg/resolver-lease.json').id,deadHop,'the dead hop still holds its lease');
assert.deepEqual(logged().map(line=>line.phase),['entered','checkpointed'],'Workers Logs carry the checkpoint of the killed invocation');
// The read-only views see a settled series: the committed chunk is not reported as lost.
let pipeline=await status();
assert.equal(pipeline.continuationHealth.status,'settled');assert.equal(pipeline.continuationHealth.interruptions,null);
assert.equal(pipeline.continuationDiagnostics.recent[0].phase,'checkpointed','a read does not close the entry');

// 2. Within the lease the next call waits; it neither repeats the chunk nor closes the entry yet.
let r=await step();
assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.discovery.nextAction,'wait');assert.equal(decided(),CHUNK);
assert.equal(ring().find(item=>item.id===deadEntry.id).phase,'checkpointed','a recent entry may still be a live step');

// 3. The next scheduled call: one new chunk (11 -> 10), the dead entry is closed as interrupted after a commit.
clockTime+=LATER;
r=await step();
assert.equal(r.status,200);assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.health.status,'settled');assert.equal(r.data.diagnostic.recovery,null);
assert.notEqual(r.data.diagnostic.hopId,deadHop);
assert.equal(r.data.discovery.remainingChunks,10);assert.equal(r.data.discovery.nextAction,'continue');
assert.equal(decided(),2*CHUNK,'exactly one more chunk; the committed one is neither repeated nor dropped');
const closed=ring().find(item=>item.id===deadEntry.id);
assert.equal(closed.phase,'interrupted');
assert.deepEqual(closed.interruption,{lastPhase:'checkpointed',committed:true,cause:'unknown',closedAt:closed.interruption.closedAt});
assert.ok(Date.parse(closed.interruption.closedAt)>=Date.parse(deadEntry.at)+LATER);
assert.deepEqual(closed.checkpoint,deadEntry.checkpoint,'the closed entry keeps what the dead step recorded');
assert.equal(ring()[0].phase,'completed');assert.deepEqual(ring()[0].recorded,{entered:true,outcome:null,checkpoint:true});
const closeLine=logged().find(line=>line.phase==='interrupted');
assert.equal(closeLine.id,deadEntry.id);assert.equal(closeLine.interruption.committed,true);
assert.equal(logged().filter(line=>line.phase==='interrupted').length,1,'an entry is closed once');
r=await step();assert.equal(logged().filter(line=>line.phase==='interrupted').length,1);assert.equal(r.data.discovery.remainingChunks,9);
assert.doesNotMatch(JSON.stringify(ring()),SECRET);assert.doesNotMatch(logs.join('\n'),SECRET);

// 4. Fencing: a killed hop whose writes land late (a held write, replayed after its successor) cannot move the
//    successor's checkpoint or release its lease.
seed();released=true;
const {dead:late}=await killedStep(leaseRelease);
const lateHop=continuation().hopId;
clockTime+=LATER;
r=await step();assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.discovery.remainingChunks,10);
const successor=plain(continuation()),successorLease=plain(records.get('epg/resolver-lease.json'));
pending.shift()();const lateResponse=await late;
assert.equal(lateResponse.status,200);assert.equal(lateResponse.data.diagnostic.hopId,lateHop);
assert.deepEqual(plain(continuation()),successor,'the late hop did not touch the newer checkpoint');
assert.deepEqual(plain(records.get('epg/resolver-lease.json')),successorLease,'nor the lease');
assert.deepEqual(plain(await call('saveOwnedContinuation')(env,lateHop,{stage:'paused',reason:null,at:iso(clockTime),hopId:lateHop,remainingChunks:11,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION})),{saved:false,reason:'other_hop',record:successor});
assert.equal(decided(),2*CHUNK);

// 5. Killed before its checkpoint (the production shape of 26 Oct 22:58 UTC): the chunk's final status is not stored,
//    the record stays `running`. The next call resumes the orphan once, with the budget its hop had, and the new
//    running record carries the interruption.
seed();
await killedStep(finalStatus);
const firstOrphan=continuation().hopId;
assert.equal(continuation().stage,'running');assert.equal(ring()[0].phase,'entered');assert.equal(ring()[0].checkpoint,null);
clockTime+=LATER;
pipeline=await status();
assert.equal(pipeline.continuationHealth.status,'orphaned');assert.equal(pipeline.continuationHealth.chunkCompleted,false);assert.equal(pipeline.continuationHealth.interruptions,0);
let report=(await post('/api/enrichment/discovery/resolve',{chunks:0})).data;
assert.equal(report.discovery.reason,'orphaned');assert.equal(report.discovery.nextAction,'continue');
const decisionsBefore=decided();
await killedStep(finalStatus);
assert.equal(continuation().stage,'running');assert.notEqual(continuation().hopId,firstOrphan);assert.equal(continuation().interruptions,1,'the resumed hop carries the interruption');assert.equal(continuation().remainingChunks,12);
const firstClosed=ring().find(item=>item.phase==='interrupted');
assert.deepEqual(firstClosed.interruption,{lastPhase:'entered',committed:null,cause:'unknown',closedAt:firstClosed.interruption.closedAt},'an entered-only step is closed with an unknown commit, not as a proven error');
assert.equal(firstClosed.error,null);

// 6. The resumed hop died before its checkpoint too: the series fails closed. Nothing is run, no lease is taken,
//    the record keeps budget and generation, and the contract says stop with reason `interrupted`.
clockTime+=LATER;
pipeline=await status();
assert.equal(pipeline.continuationHealth.status,'orphaned');assert.equal(pipeline.continuationHealth.interruptions,1);
report=(await post('/api/enrichment/discovery/resolve',{chunks:0})).data;
assert.equal(report.discovery.state,'running');assert.equal(report.discovery.reason,'interrupted');assert.equal(report.discovery.nextAction,'stop','the read-only report already says stop');
const leaseBefore=plain(records.get('epg/resolver-lease.json')),decidedBefore=decided();puts=[];
r=await step();
assert.equal(r.status,200);assert.equal(r.data.stage,'complete','the sync run stage is unchanged');
assert.equal(r.data.diagnostic.branch,'interrupted');
assert.deepEqual(r.data.diagnostic.recovery,{orphanHopId:continuation().hopId,action:'interrupted',chunkCompleted:false,budget:0,settled:true,interruptions:2});
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,'interrupted');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(r.data.discovery.remainingChunks,12);assert.equal(r.data.discovery.programmeRunId,GENERATION);
assert.equal(continuation().stage,'paused');assert.equal(continuation().reason,'interrupted');assert.equal(continuation().interruptions,2);assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(decided(),decidedBefore,'no chunk ran');assert.deepEqual(plain(records.get('epg/resolver-lease.json')),leaseBefore,'no lease was taken');
assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),['epg/resolver-continuation.json'],'the only write is the fail-closed record');
assert.equal(ring()[0].discovery.reason,'interrupted');
assert.ok(decisionsBefore<=decidedBefore);
// It stays closed for every scheduled call (MCP), and the read-only views agree.
r=await step();assert.equal(r.data.diagnostic.branch,'contract');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(r.data.discovery.reason,'interrupted');assert.equal(decided(),decidedBefore);
pipeline=await status();assert.equal(pipeline.continuation.reason,'interrupted');assert.equal(pipeline.continuationHealth.status,'settled');
assert.equal(call('discoveryContract')({stage:'paused',reason:'interrupted',remainingChunks:12}).nextAction,'stop');

// 7. An owner-forced resolve (HTTP, outside the schedule) runs the chunk; its checkpoint drops the count.
r=await post('/api/enrichment/discovery/resolve',{});
assert.equal(r.status,200);assert.equal(r.data.diagnostic.decision.force,true);assert.equal(r.data.diagnostic.branch,'chunk');
assert.equal(continuation().stage,'paused');assert.equal(continuation().reason,null);assert.equal(continuation().interruptions,undefined);assert.equal(decided(),decidedBefore+CHUNK);

// 8. One interruption followed by a stored checkpoint resets the count, so a later single interruption resumes again.
seed();
await killedStep(finalStatus);clockTime+=LATER;
r=await step();assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.diagnostic.recovery.interruptions,1);
assert.equal(continuation().stage,'paused');assert.equal(continuation().interruptions,undefined,'a stored checkpoint clears the count');
await killedStep(finalStatus);clockTime+=LATER;
r=await step();assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.discovery.nextAction,'continue');

// 9. An orphan whose chunk did finish (killed between the final status and the checkpoint) is settled, never
//    counted as an interruption, even when its record carries an earlier one.
seed();
await killedStep(finalStatus);clockTime+=LATER;
await killedStep((key,body)=>key==='epg/resolver-continuation.json'&&body.stage==='paused');
assert.equal(continuation().stage,'running');assert.equal(continuation().interruptions,1);
clockTime+=LATER;
r=await step();
assert.equal(r.data.diagnostic.health.chunkCompleted,true);assert.equal(r.data.diagnostic.recovery.action,'settled');assert.equal(r.data.diagnostic.branch,'chunk');
assert.equal(continuation().interruptions,undefined);assert.equal(r.data.discovery.nextAction,'continue');

// 10. A new EPG generation opens a new series over a failed-closed one.
seed();
set('epg/resolver-continuation.json',{stage:'paused',reason:'interrupted',at:iso(clockTime),hopId:'4b9bc7c5-c429-460b-87a5-e4adf2d4fbe8',remainingChunks:7,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION,interruptions:2});
set('epg/published-generation.json',{phase:'published',programmeRunId:NEXT});
const queued=plain(await call('queueDiscovery')(env,'epg_committed',NEXT));
assert.equal(queued.nextAction,'continue');assert.equal(queued.remainingChunks,12);
assert.deepEqual(plain(continuation()),{stage:'paused',reason:'epg_committed',at:continuation().at,hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:NEXT});
// The same generation committed again keeps the stop.
set('epg/resolver-continuation.json',{stage:'paused',reason:'interrupted',at:iso(clockTime),hopId:null,remainingChunks:7,nextCatchUpAt:null,retryAt:null,programmeRunId:NEXT,interruptions:2});
assert.equal(plain(await call('queueDiscovery')(env,'epg_committed',NEXT)).nextAction,'stop');assert.equal(continuation().reason,'interrupted');

assert.deepEqual(fetches,[]);
console.log('Interrupted continuation: killed after checkpoint (committed, closed as interrupted, no repeat), late-hop fencing, killed before checkpoint (resumed once, unknown commit), fail-closed stop on a repeated interruption, owner-forced resolve, count reset, settled orphan not counted and new-generation reopen passed');
