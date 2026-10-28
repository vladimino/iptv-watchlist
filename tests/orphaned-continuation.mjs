// AIR-154: a `running` continuation whose resolver lease has expired is an orphan (its hop ended between
// the chunk and the checkpoint). The next explicit step settles it from the persisted chunk result and
// resumes the same generation without repeating or dropping progress; a live writer stays busy; a
// generation mismatch stops; every continuation write is fenced by etag and hop id.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester'};
const fetches=[],logs=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:line=>{logs.push(String(line));}},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/enrichment.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
const execution={waitUntil(){}};
const origin='https://iptv.vladimino.workers.dev',headers={'Content-Type':'application/json'};
const post=async(path,body)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const status=async()=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,execution)).json();
const step=()=>post('/api/sync/epg',{runId:'sync-1'});
const now=Date.now(),iso=ms=>new Date(ms).toISOString();
const ORPHAN='4b9bc7c5-c429-460b-87a5-e4adf2d4fbe8',GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe';
const continuation=()=>records.get('epg/resolver-continuation.json');
const decided=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]}));
// The production shape on 25 Oct: a hop opened `running` with budget 5, its chunk finished (status saved with
// finishedAt, added 2, no error), its lease expired, and no checkpoint followed.
function seedOrphan({remainingChunks=5,lease='expired',completed=true,programmeRunId=GENERATION,published=GENERATION,lastRemaining=3,verifiedBefore=2,statusHop=ORPHAN}={}){
 records.clear();etags.clear();puts=[];fetches.length=0;logs.length=0;
 const opened=now-60000;
 set('programme.json',{runId:GENERATION,updatedAt:iso(now),films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 set('sync.json',{runId:'sync-1',stage:'complete',updatedAt:iso(now)});
 set(call('profileKey'),{version:1,profileHash:'p'});
 set('epg/discovery-latest.json',{programmeRunId:GENERATION,items:items(60)});
 if(published)set('epg/published-generation.json',{phase:'published',programmeRunId:published});
 const decisions={};for(let i=0;i<verifiedBefore;i++)decisions['hot film|2020|'+i]={status:'verified',filmId:'w1',tmdbId:'42',checkedAt:iso(opened+100)};set('epg/discovery-resolution.json',decisions);
 set('epg/resolver-continuation.json',{stage:'running',reason:null,at:iso(opened),hopId:ORPHAN,remainingChunks,nextCatchUpAt:null,retryAt:null,programmeRunId});
 if(lease==='expired')set('epg/resolver-lease.json',{id:ORPHAN,expiresAt:now-1000});
 else if(lease==='live')set('epg/resolver-lease.json',{id:ORPHAN,expiresAt:now+60000});
 else if(lease==='other')set('epg/resolver-lease.json',{id:'11111111-2222-4333-8444-555555555555',expiresAt:now+60000});
 const started=completed?opened+10:opened-30000;
 set('epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt:iso(started),finishedAt:iso(started+500),at:iso(started+500),programmeRunId:GENERATION,...(statusHop?{hopId:statusHop}:{}),checked:3,screenedOut:0,reused:0,touched:0,tmdbCalls:0,added:2,remaining:lastRemaining,variantPending:0,hotRemaining:lastRemaining,error:null,retryAt:null});
}
const SECRET=/Hot Film|legacy|Bearer|token=/;
// A sync step runs a chunk of 24 candidates; every candidate scores a runtime contradiction against the watchlist film
// («Hot Film», 100 minutes, aired as 200), so the scored gate records a `duration_mismatch` decision for each without TMDB.
const CHUNK=24;

// 1. Interrupted after a completed chunk: the explicit step settles the orphan (5 -> 4), runs one chunk (4 -> 3)
//    on the same generation, and the dead hop's id is gone from the record.
seedOrphan();
let r=await step();
assert.equal(r.status,200);assert.equal(r.data.stage,'complete');
let d=r.data.diagnostic;
assert.deepEqual(d.health,{status:'orphaned',hopId:ORPHAN,lease:'expired',leaseHop:'same',leaseExpiresAt:iso(now-1000),chunkCompleted:true,resumeBudget:4,generationConflict:false,interruptions:0});
assert.deepEqual(d.recovery,{orphanHopId:ORPHAN,action:'settled',chunkCompleted:true,budget:4,settled:true});
assert.equal(d.branch,'chunk');assert.equal(d.decision.budget,4);assert.notEqual(d.hopId,ORPHAN);assert.equal(d.saved.owned,true);assert.equal(d.saved.write,'saved');
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,null);assert.equal(r.data.discovery.remainingChunks,3);assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.programmeRunId,GENERATION);
assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,3);assert.equal(continuation().hopId,d.hopId);assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(decided(),2+CHUNK,'the completed chunk\'s decisions stay and exactly one more chunk ran');
assert.equal(records.get('epg/discovery-status.json').added,0);assert.equal(records.has('epg/discovered-films.json'),false,'no catalog write was repeated');
assert.deepEqual(fetches,[]);assert.equal(records.get('epg/resolver-lease.json').expiresAt,0);
assert.ok(Date.parse(records.get('epg/discovery-status.json').startedAt)>now-60000,'lastBatch now belongs to the new chunk');assert.equal(records.get('epg/discovery-status.json').hopId,d.hopId,'the chunk status is marked with the hop that wrote it');
// The dead hop cannot overwrite the newer checkpoint, whatever it tries.
const newer=structuredClone(continuation());
const stale=plain(await call('saveOwnedContinuation')(env,ORPHAN,{stage:'paused',reason:null,at:iso(now),hopId:ORPHAN,remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));
assert.deepEqual(stale,{saved:false,reason:'other_hop',record:newer});assert.deepEqual(continuation(),newer);
assert.equal(await call('replaceContinuation')(env,{stage:'running',hopId:ORPHAN,remainingChunks:5},'stale-etag'),false);assert.deepEqual(continuation(),newer);
const ring=records.get('epg/resolver-continuation-diagnostics.json').recent[0];
assert.equal(ring.branch,'continuation');assert.equal(ring.diagnostic.recovery.action,'settled');assert.equal(ring.diagnostic.health.status,'orphaned');
assert.doesNotMatch(JSON.stringify(ring),SECRET);assert.doesNotMatch(logs.join('\n'),SECRET);

// 2. A second step continues normally (3 -> 2): the orphan handling is one-off.
r=await step();
assert.equal(r.data.diagnostic.health.status,'settled');assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,2);assert.equal(decided(),2+2*CHUNK);

// 3. A live lease of the same hop is a live writer: busy / wait until the lease expires, nothing written.
seedOrphan({lease:'live'});
const before=plain(continuation()),leaseExpiry=iso(now+60000);
r=await step();
assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.discovery.reason,'busy');assert.equal(r.data.discovery.nextAction,'wait');assert.equal(r.data.discovery.nextCatchUpAt,leaseExpiry);
assert.equal(r.data.diagnostic.branch,'lease_live');assert.deepEqual(r.data.diagnostic.health,{status:'live',hopId:ORPHAN,lease:'live',leaseHop:'same',leaseExpiresAt:leaseExpiry,chunkCompleted:null,resumeBudget:null,generationConflict:false,interruptions:0});
assert.deepEqual(plain(continuation()),before);assert.equal(decided(),2);assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[]);
const report=(await post('/api/enrichment/discovery/resolve',{chunks:0})).data;
assert.equal(report.discovery.state,'running');assert.equal(report.discovery.reason,'busy');assert.equal(report.discovery.nextAction,'wait');assert.equal(report.discovery.nextCatchUpAt,leaseExpiry);
let pipeline=await status();
assert.equal(pipeline.continuation.stage,'running');assert.equal(pipeline.continuationHealth.status,'live');assert.equal(pipeline.continuationHealth.leaseHop,'same');assert.equal(pipeline.continuationHealth.leaseExpiresAt,leaseExpiry);
assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[],'status and chunks:0 read only');
// Another hop's live lease is equally a live writer.
seedOrphan({lease:'other'});
r=await step();assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.diagnostic.health.status,'live');assert.equal(r.data.diagnostic.health.leaseHop,'other');

// 4. Orphan whose chunk did not finish (the last status predates the hop): resumed with the full budget (5 -> 4).
seedOrphan({completed:false});
pipeline=await status();
assert.deepEqual(pipeline.continuationHealth,{status:'orphaned',hopId:ORPHAN,lease:'expired',leaseHop:'same',leaseExpiresAt:iso(now-1000),chunkCompleted:false,resumeBudget:5,generationConflict:false,interruptions:0});
assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[]);
r=await step();
assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.diagnostic.recovery.chunkCompleted,false);assert.equal(r.data.diagnostic.decision.budget,5);
assert.equal(r.data.discovery.remainingChunks,4);assert.equal(continuation().stage,'paused');assert.equal(decided(),2+CHUNK);
// A newer finished status written by another hop of the same generation is not this orphan's chunk.
seedOrphan({statusHop:'99999999-8888-4777-8666-555555555555'});
r=await step();assert.equal(r.data.diagnostic.health.chunkCompleted,false);assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.discovery.remainingChunks,4);
// A status without a hop marker (written before statuses carried one, as on the stalled generation) is not attributed either:
// the orphan resumes with the budget its hop had, which is one more chunk than strictly needed, never a reset.
seedOrphan({statusHop:null});
pipeline=await status();assert.equal(pipeline.continuationHealth.chunkCompleted,false);assert.equal(pipeline.continuationHealth.resumeBudget,5);
r=await step();assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.discovery.remainingChunks,4);assert.equal(r.data.discovery.programmeRunId,GENERATION);
// A cheap-pass checkpoint without finishedAt is not a completed chunk either.
seedOrphan();records.get('epg/discovery-status.json').finishedAt=undefined;records.get('epg/discovery-status.json').checkpoint='cheap_pass';
r=await step();assert.equal(r.data.diagnostic.health.chunkCompleted,false);assert.equal(r.data.discovery.remainingChunks,4);

// 5. The completed chunk used the last budget: settle to chunk_budget / wait, run nothing.
seedOrphan({remainingChunks:1});
r=await step();
assert.equal(r.data.diagnostic.branch,'orphan_settled');assert.equal(r.data.diagnostic.recovery.action,'settled');assert.equal(r.data.diagnostic.recovery.budget,0);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,'chunk_budget');assert.equal(r.data.discovery.remainingChunks,0);assert.equal(r.data.discovery.nextAction,'wait');assert.ok(r.data.discovery.nextCatchUpAt);
assert.equal(continuation().reason,'chunk_budget');assert.equal(continuation().hopId,ORPHAN,'the settled checkpoint is the one the dead hop would have written');assert.equal(decided(),2);assert.equal(puts.includes('epg/resolver-lease.json'),false,'no lease was taken');

// 6. The completed chunk finished the backlog: settle to complete / stop.
seedOrphan({lastRemaining:0});
r=await step();
assert.equal(r.data.diagnostic.branch,'orphan_settled');assert.equal(r.data.discovery.state,'complete');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(continuation().stage,'complete');assert.equal(decided(),2);
// A completed chunk that saw the programme change settles to programme_changed / stop.
seedOrphan();records.get('epg/discovery-status.json').programmeChanged=true;
r=await step();assert.equal(r.data.discovery.reason,'programme_changed');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(decided(),2);

// 7. Generation handoff (regression A): the orphan belongs to an earlier generation while a newer one is published
//    and in place. The step supersedes it with a fresh series for the published generation, runs one chunk under a
//    new hop, and leaves the old hop's ledger alone.
const OLD='00000000-0000-4000-8000-000000000000';
seedOrphan({programmeRunId:OLD});
const oldStatus=plain(records.get('epg/discovery-status.json')),oldDecisions=plain(records.get('epg/discovery-resolution.json'));
pipeline=await status();assert.equal(pipeline.continuationHealth.generationConflict,true);
r=await step();
assert.equal(r.data.stage,'complete','the sync run stage is unchanged');assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.health.generationConflict,true);
assert.deepEqual(r.data.diagnostic.recovery,{orphanHopId:ORPHAN,action:'generation_recovered',chunkCompleted:false,budget:12,settled:true,superseded:OLD});
assert.equal(r.data.diagnostic.decision.budget,12,'the new series starts with the full budget');assert.notEqual(r.data.diagnostic.hopId,ORPHAN);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,null);assert.equal(r.data.discovery.remainingChunks,11);assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.programmeRunId,GENERATION);
assert.equal(continuation().programmeRunId,GENERATION);assert.equal(continuation().hopId,r.data.diagnostic.hopId);assert.equal(continuation().remainingChunks,11);
assert.equal(decided(),2+CHUNK);assert.deepEqual(fetches,[]);assert.equal(records.get('epg/discovery-status.json').hopId,r.data.diagnostic.hopId);assert.equal(records.get('epg/discovery-status.json').programmeRunId,GENERATION);
for(const key of Object.keys(oldDecisions))assert.deepEqual(plain(records.get('epg/discovery-resolution.json')[key]),oldDecisions[key],'the old generation\'s decisions are untouched');
assert.notEqual(records.get('epg/discovery-status.json').startedAt,oldStatus.startedAt);
pipeline=await status();assert.equal(pipeline.continuationHealth.status,'settled');assert.equal(pipeline.continuationHealth.generationConflict,null);
// The handoff is one-off: the next step is an ordinary continuation of the published generation.
r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,10);assert.equal(decided(),2+2*CHUNK);
// The published generation is not yet in place (the shared programme still carries the old one): nothing is replaced, wait.
seedOrphan({programmeRunId:OLD});records.get('programme.json').runId=OLD;etags.set('programme.json',String(++revision));
const pendingBefore=plain(continuation());
r=await step();
assert.equal(r.data.diagnostic.branch,'generation_pending');assert.equal(r.data.diagnostic.recovery.action,'generation_pending');assert.equal(r.data.diagnostic.recovery.superseded,OLD);
assert.equal(r.data.discovery.nextAction,'wait');assert.ok(r.data.discovery.nextCatchUpAt);assert.deepEqual(plain(continuation()),pendingBefore);assert.equal(decided(),2);
assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[],'a pending publication writes nothing');
// Without a published generation pointer there is nothing to hand off to.
seedOrphan({published:null,programmeRunId:OLD});
r=await step();assert.equal(r.data.diagnostic.health.generationConflict,false);assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.recovery.action,'resumed');
// A live old-generation writer is not superseded: busy / wait until its lease expires.
seedOrphan({programmeRunId:OLD,lease:'live'});
r=await step();assert.equal(r.data.diagnostic.branch,'lease_live');assert.equal(r.data.discovery.state,'busy');assert.equal(continuation().programmeRunId,OLD);

// 8. Two concurrent explicit steps on one orphan: exactly one owns the continuation, the other waits, and the
//    budget moves by one chunk only.
seedOrphan();
const originalGet=bucket.get.bind(bucket);let releaseGate,gated=false;const gate=new Promise(resolve=>{releaseGate=resolve;});
bucket.get=async key=>{if(key==='epg/discovery-latest.json'&&!gated){gated=true;await gate;}return originalGet(key);};
const first=step();
for(let i=0;i<50&&!(continuation()?.stage==='running'&&continuation().hopId!==ORPHAN);i++)await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(continuation().stage,'running');assert.notEqual(continuation().hopId,ORPHAN);
const second=await step();
assert.equal(second.data.discovery.state,'busy');assert.equal(second.data.discovery.nextAction,'wait');assert.equal(second.data.diagnostic.branch,'lease_live');assert.equal(second.data.diagnostic.health.status,'live');
releaseGate();const winner=await first;bucket.get=originalGet;
assert.equal(winner.data.diagnostic.branch,'chunk');assert.equal(winner.data.discovery.remainingChunks,3);assert.equal(continuation().stage,'paused');assert.equal(decided(),2+CHUNK);

// 9. Stale-read fence: a call that decided on a record that moved before it took the lease does not write.
seedOrphan();
await step();const settledRecord=plain(continuation()),settledEtag=etags.get('epg/resolver-continuation.json');
let staleOnce=true;
bucket.get=async key=>{if(key==='epg/resolver-continuation.json'&&staleOnce){staleOnce=false;return {etag:'stale',json:async()=>({stage:'paused',reason:'epg_committed',at:iso(now),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:null})};}return originalGet(key);};
r=await step();bucket.get=originalGet;
assert.equal(r.data.diagnostic.branch,'record_changed');assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.diagnostic.decision.budget,12,'the stale record was what the decision saw');
assert.deepEqual(plain(continuation()),settledRecord);assert.equal(etags.get('epg/resolver-continuation.json'),settledEtag);assert.equal(decided(),2+CHUNK);assert.equal(records.get('epg/resolver-lease.json').expiresAt,0,'the lease was released');
assert.equal(r.data.diagnostic.saved.owned,false);

// 10. A conflicting settle (someone replaced the orphan between read and write) is reported, not forced.
seedOrphan();
const originalPut=bucket.put.bind(bucket);let stolen=false;
bucket.put=async(key,value,options)=>{if(key==='epg/resolver-continuation.json'&&!stolen){stolen=true;await originalPut(key,JSON.stringify({stage:'paused',reason:null,at:iso(now),hopId:'22222222-3333-4444-8555-666666666666',remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));}return originalPut(key,value,options);};
r=await step();bucket.put=originalPut;
assert.equal(r.data.diagnostic.branch,'record_changed');assert.equal(r.data.diagnostic.recovery.settled,false);assert.equal(continuation().hopId,'22222222-3333-4444-8555-666666666666');assert.equal(decided(),2);

// 11. Both conditional writes of the final checkpoint rejected while the record still names this hop: the step
//     reports the checkpoint as not stored (not as owned), the record stays `running`, and the next step settles
//     it from the hop-marked status instead of repeating the chunk.
seedOrphan({remainingChunks:5,completed:false});
const realPut=bucket.put.bind(bucket);let rejectCheckpoint=0;
bucket.put=async(key,value,options)=>{const body=JSON.parse(value);if(key==='epg/resolver-continuation.json'&&body.stage!=='running'&&rejectCheckpoint<2){rejectCheckpoint++;return null;}return realPut(key,value,options);};
r=await step();bucket.put=realPut;
assert.equal(rejectCheckpoint,2);assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.saved.owned,false);assert.equal(r.data.diagnostic.saved.write,'write_conflict');
assert.equal(continuation().stage,'running');assert.equal(continuation().hopId,r.data.diagnostic.hopId);
assert.equal(r.data.discovery.state,'running');assert.equal(r.data.discovery.reason,'orphaned');assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.remainingChunks,4);
assert.equal(decided(),2+CHUNK);assert.equal(records.get('epg/discovery-status.json').hopId,r.data.diagnostic.hopId);
const afterConflict=await step();
assert.equal(afterConflict.data.diagnostic.health.status,'orphaned');assert.equal(afterConflict.data.diagnostic.health.chunkCompleted,true,'the hop-marked status attributes the finished chunk');assert.equal(afterConflict.data.diagnostic.recovery.action,'settled');
assert.equal(afterConflict.data.diagnostic.recovery.budget,4);assert.equal(afterConflict.data.discovery.remainingChunks,3);assert.equal(decided(),2+2*CHUNK,'the finished chunk is not repeated');

// 12. An old hop that stalls past the lease TTL cannot write over its replacement: its first write renews the
//     lease, the renewal fails because the replacement holds it, and the chunk aborts before touching storage.
seedOrphan();
let holdOld,oldHeld=false;const oldGate=new Promise(resolve=>{holdOld=resolve;});
bucket.get=async key=>{if(key==='epg/discovery-latest.json'&&!oldHeld){oldHeld=true;await oldGate;}return originalGet(key);};
const oldHop=step();
for(let i=0;i<50&&!(continuation()?.stage==='running'&&continuation().hopId!==ORPHAN);i++)await new Promise(resolve=>setTimeout(resolve,0));
const oldHopId=continuation().hopId;bucket.get=originalGet;
records.get('epg/resolver-lease.json').expiresAt=now-1;
const replacement=await step();
assert.equal(replacement.data.diagnostic.branch,'chunk');assert.equal(replacement.data.diagnostic.health.status,'orphaned');assert.equal(replacement.data.diagnostic.recovery.action,'resumed','the stalled hop wrote no status, so its chunk is not attributed');
const replacementHop=replacement.data.diagnostic.hopId,replacementRecord=plain(continuation()),replacementDecisions=decided(),replacementStatus=plain(records.get('epg/discovery-status.json'));
assert.equal(replacementRecord.stage,'paused');assert.equal(replacementRecord.hopId,replacementHop);assert.equal(replacementStatus.hopId,replacementHop);
holdOld();const late=await oldHop;
assert.equal(late.data.diagnostic.hopId,oldHopId);assert.equal(late.data.diagnostic.chunk.stage,'error');assert.equal(late.data.diagnostic.chunk.error,'resolver_busy');
assert.equal(late.data.diagnostic.saved.owned,false);assert.equal(late.data.diagnostic.saved.write,'other_hop');
assert.deepEqual(plain(continuation()),replacementRecord,'the replacement checkpoint stands');assert.deepEqual(plain(records.get('epg/discovery-status.json')),replacementStatus,'the stalled hop wrote no status');
assert.equal(decided(),replacementDecisions,'the stalled hop wrote no decisions');assert.equal(records.get('epg/resolver-lease.json').id,replacementHop,'the stalled hop did not release a lease it no longer held');
assert.doesNotMatch(JSON.stringify(late.data),/lease lost/,'the thrown message is classified, not copied');

// 12b. The fence is inside the helpers: an old hop that stalls between the two catalog writes of
//      `saveDiscoveredFilms` (generation copy landed, shared copy not yet written) past the lease TTL
//      does not perform the second write after a replacement has run the same generation.
const GENERATION_CATALOG='epg/generations/'+GENERATION+'/discovered-films.json';
function seedCatalogTouch(){seedOrphan();
 set('epg/discovered-films.json',{tmdb_7:{id:'tmdb_7',tmdbId:'7',title:'Cold Film',original:'Cold Film',year:2019,runtime:100,canonicalIdentity:'tmdb:7',aliases:[],shows:[]}});
 const latest=records.get('epg/discovery-latest.json');latest.items.push({key:'cold film|2019|0',title:'Cold Film',normalizedTitle:'cold film',year:2019,duration:100,durations:[100],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]});
 const decisions=records.get('epg/discovery-resolution.json');decisions['cold film|2019|0']={status:'verified',filmId:'tmdb_7',tmdbId:'7',checkedAt:iso(now-70000)};etags.set('epg/discovery-resolution.json',String(++revision));}
async function stallOldHop({gateKey,operation}){
 let release,reached;const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{reached=resolve;});let once=false;
 if(operation==='put')bucket.put=async(key,value,options)=>{const result=await originalPut(key,value,options);if(key===gateKey&&!once){once=true;reached();await gate;}return result;};
 else bucket.get=async key=>{if(key===gateKey&&!once){once=true;reached();await gate;}return originalGet(key);};
 const old=step();await arrived;bucket.put=originalPut;bucket.get=originalGet;
 const oldHopId=continuation().hopId;assert.equal(continuation().stage,'running');assert.notEqual(oldHopId,ORPHAN);
 records.get('epg/resolver-lease.json').expiresAt=now-1;
 const replacement=await step();
 assert.equal(replacement.data.diagnostic.branch,'chunk');assert.equal(replacement.data.diagnostic.health.status,'orphaned');assert.equal(replacement.data.diagnostic.recovery.action,'resumed');
 const snapshot=Object.fromEntries(['epg/resolver-continuation.json','epg/discovery-status.json','epg/discovery-resolution.json','epg/discovered-films.json',GENERATION_CATALOG,'enrichment/prediction-queue.json','epg/resolver-lease.json'].map(key=>[key,etags.get(key)]));
 release();const late=await old;
 assert.equal(late.data.diagnostic.hopId,oldHopId);assert.equal(late.data.diagnostic.chunk.stage,'error');assert.equal(late.data.diagnostic.chunk.error,'resolver_busy');assert.equal(late.data.diagnostic.saved.owned,false);assert.equal(late.data.diagnostic.saved.write,'other_hop');
 for(const [key,etag] of Object.entries(snapshot))assert.equal(etags.get(key),etag,'the stalled hop did not write '+key+' after its replacement');
 return {replacement,late,replacementHop:replacement.data.diagnostic.hopId};
}
seedCatalogTouch();
let fenced=await stallOldHop({gateKey:GENERATION_CATALOG,operation:'put'});
assert.equal(records.get(GENERATION_CATALOG).tmdb_7.shows.length,1,'the replacement touched the catalog film');
assert.equal(records.get('epg/discovered-films.json').tmdb_7.shows.length,1,'the shared catalog is the replacement\'s copy');
assert.equal(records.get('epg/discovery-status.json').hopId,fenced.replacementHop);assert.equal(continuation().hopId,fenced.replacementHop);assert.equal(continuation().stage,'paused');
assert.equal(decided(),3+CHUNK,'one chunk of decisions, from the replacement only');
// 12c. The queue refresh renews after its reads and right before its write: an old hop stalled inside
//      `refreshPredictionQueue` past the TTL does not overwrite the replacement's queue snapshot.
seedOrphan();
fenced=await stallOldHop({gateKey:'enrichment/view-index.json',operation:'get'});
assert.ok(records.has('enrichment/prediction-queue.json'),'the replacement wrote the queue checkpoint');
assert.equal(records.get('epg/discovery-status.json').hopId,fenced.replacementHop);assert.equal(records.get('epg/discovery-status.json').stage,'partial');assert.ok(records.get('epg/discovery-status.json').finishedAt);
assert.equal(continuation().hopId,fenced.replacementHop);assert.equal(decided(),2+2*CHUNK,'the stalled hop\'s decisions landed before it stalled; the replacement added one more chunk');
assert.equal(records.get('epg/resolver-lease.json').id,fenced.replacementHop);

// 14. Regression B: the publication finished (pointer and shared programme name the new generation, the sync run is
//     `complete`) but the invocation ended before the discovery checkpoint was queued. The checkpoint still holds the
//     previous generation's terminal record, or a `programme_changed` record the mid-publication chunk wrote for the
//     new generation. The next ordinary step restores the series for the published generation without publishing
//     anything again, and a second step continues it.
function seedCommitted(record){seedOrphan();set('epg/resolver-continuation.json',record);records.delete('epg/resolver-lease.json');}
const publishedKeys=()=>[...records.keys()].filter(key=>key.startsWith('epg/generations/')||key==='epg/published-generation.json'||key==='programme.json'||key==='sync.json');
for(const stale of [
 {stage:'complete',reason:null,at:iso(now-7200000),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OLD},
 {stage:'paused',reason:'chunk_budget',at:iso(now-7200000),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:iso(now+3600000),retryAt:null,programmeRunId:OLD},
 {stage:'paused',reason:'programme_changed',at:iso(now-60000),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OLD},
 {stage:'paused',reason:'programme_changed',at:iso(now-60000),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION},
]){
 seedCommitted(stale);const before=publishedKeys().map(key=>[key,etags.get(key)]),syncBefore=plain(records.get('sync.json'));
 r=await step();
 assert.equal(r.data.diagnostic.health.status,'settled',JSON.stringify(stale));assert.equal(r.data.diagnostic.recovery.action,'generation_recovered');assert.equal(r.data.diagnostic.recovery.superseded,stale.programmeRunId);assert.equal(r.data.diagnostic.recovery.orphanHopId,stale.hopId,'the superseded record\'s hop is named');
 assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.discovery.remainingChunks,11);assert.equal(r.data.discovery.nextAction,'continue');assert.equal(continuation().programmeRunId,GENERATION);assert.equal(decided(),2+CHUNK);
 assert.deepEqual(publishedKeys().map(key=>[key,etags.get(key)]),before,'nothing was published again');assert.deepEqual(plain(records.get('sync.json')),syncBefore);
 r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,10);assert.equal(decided(),2+2*CHUNK);
}
// A finished series of the published generation stays finished, and a paused one of the published generation is simply
// continued: neither is a handoff.
seedCommitted({stage:'complete',reason:null,at:iso(now-60000),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.state,'complete');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(decided(),2);
seedCommitted({stage:'paused',reason:'epg_committed',at:iso(now-60000),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,11);
// A legacy record without a generation pin cannot be judged and is continued as before.
seedCommitted({stage:'paused',reason:'epg_committed',at:iso(now-60000),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:null});
r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,11);assert.equal(continuation().programmeRunId,GENERATION,'the chunk pins the generation it read');

// 15. The commit itself pins the generation it queues, keeps a live writer's record, and loses a concurrent write.
seedCommitted({stage:'complete',reason:null,at:iso(now-60000),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OLD});
let queued=plain(await call('queueDiscovery')(env,'epg_committed',GENERATION));
assert.deepEqual({state:queued.state,reason:queued.reason,remainingChunks:queued.remainingChunks,nextAction:queued.nextAction,programmeRunId:queued.programmeRunId},{state:'paused',reason:'epg_committed',remainingChunks:12,nextAction:'continue',programmeRunId:GENERATION});
assert.equal(continuation().programmeRunId,GENERATION);
seedOrphan({lease:'live'});const liveRecord=plain(continuation());
queued=plain(await call('queueDiscovery')(env,'epg_committed',GENERATION));
assert.equal(queued.state,'running');assert.equal(queued.reason,'busy');assert.equal(queued.nextAction,'wait');assert.deepEqual(plain(continuation()),liveRecord,'a live writer keeps its record');
seedCommitted({stage:'complete',reason:null,at:iso(now-60000),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:OLD});
let stoleOnce=false;bucket.put=async(key,value,options)=>{if(key==='epg/resolver-continuation.json'&&!stoleOnce){stoleOnce=true;await originalPut(key,JSON.stringify({stage:'running',reason:null,at:iso(now),hopId:'22222222-3333-4444-8555-666666666666',remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));}return originalPut(key,value,options);};
queued=plain(await call('queueDiscovery')(env,'epg_committed',GENERATION));bucket.put=originalPut;
assert.equal(continuation().hopId,'22222222-3333-4444-8555-666666666666','the concurrent writer\'s record stands');assert.equal(queued.state,'running');

// 15b. Out-of-order commits: a G1 commit that paused after its programme write and resumes after G2 was published,
//      queued and advanced must not roll the G2 series back; a re-entered G2 commit keeps G2's progress; only the
//      mid-publication `programme_changed` artefact of G2 is replaced.
seedCommitted({stage:'paused',reason:null,at:iso(now-60000),hopId:'44444444-5555-4666-8777-888888888888',remainingChunks:9,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
const g2Record=plain(continuation()),g2Etag=etags.get('epg/resolver-continuation.json');
for(const lateReason of ['epg_committed','scan_committed']){
 queued=plain(await call('queueDiscovery')(env,lateReason,OLD));
 assert.deepEqual(plain(continuation()),g2Record,'a late '+lateReason+' of the earlier generation writes nothing');assert.equal(etags.get('epg/resolver-continuation.json'),g2Etag);
 assert.equal(queued.programmeRunId,GENERATION);assert.equal(queued.remainingChunks,9);assert.equal(queued.nextAction,'continue','the contract is that of the record left in place');
}
queued=plain(await call('queueDiscovery')(env,'epg_committed',GENERATION));
assert.deepEqual(plain(continuation()),g2Record,'a re-entered commit of the same generation keeps its progress');assert.equal(queued.remainingChunks,9);
r=await step();assert.equal(r.data.diagnostic.recovery,null,'no handoff follows');assert.equal(r.data.discovery.remainingChunks,8);assert.equal(decided(),2+CHUNK);
seedCommitted({stage:'paused',reason:'programme_changed',at:iso(now-60000),hopId:'44444444-5555-4666-8777-888888888888',remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});
queued=plain(await call('queueDiscovery')(env,'epg_committed',GENERATION));
assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);assert.equal(queued.nextAction,'continue');
// Without a published pointer there is no generation to check against, so a record of another generation is replaced as requested.
seedCommitted({stage:'complete',reason:null,at:iso(now-60000),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:'11111111-2222-4333-8444-555555555555'});records.delete('epg/published-generation.json');
queued=plain(await call('queueDiscovery')(env,'epg_committed',OLD));assert.equal(continuation().programmeRunId,OLD);assert.equal(queued.remainingChunks,12);

// 16. Regression C: concurrency around the handoff. Two steps on one stale record: one supersedes and runs the chunk,
//     the other waits; a conflicting write between read and supersede is reported, not forced; and an old-generation
//     hop that stalls past its lease while the new generation is published and recovered cannot write late.
seedOrphan({programmeRunId:OLD});
let holdHandoff,handoffHeld=false;const handoffGate=new Promise(resolve=>{holdHandoff=resolve;});
bucket.get=async key=>{if(key==='epg/discovery-latest.json'&&!handoffHeld){handoffHeld=true;await handoffGate;}return originalGet(key);};
const firstHandoff=step();
for(let i=0;i<50&&!(continuation()?.stage==='running'&&continuation().programmeRunId===GENERATION);i++)await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(continuation().stage,'running');assert.equal(continuation().programmeRunId,GENERATION);
const secondHandoff=await step();assert.equal(secondHandoff.data.discovery.state,'busy');assert.equal(secondHandoff.data.diagnostic.branch,'lease_live');
holdHandoff();const firstDone=await firstHandoff;bucket.get=originalGet;
assert.equal(firstDone.data.diagnostic.recovery.action,'generation_recovered');assert.equal(firstDone.data.discovery.remainingChunks,11);assert.equal(decided(),2+CHUNK);
seedOrphan({programmeRunId:OLD});
let stolenHandoff=false;bucket.put=async(key,value,options)=>{if(key==='epg/resolver-continuation.json'&&!stolenHandoff){stolenHandoff=true;await originalPut(key,JSON.stringify({stage:'paused',reason:'epg_committed',at:iso(now),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));}return originalPut(key,value,options);};
r=await step();bucket.put=originalPut;
assert.equal(r.data.diagnostic.branch,'record_changed');assert.equal(r.data.diagnostic.recovery.action,'generation_recovered');assert.equal(r.data.diagnostic.recovery.settled,false);assert.equal(r.data.discovery.state,'busy');assert.equal(decided(),2);assert.equal(continuation().remainingChunks,12);
// The stalled old-generation hop: it opened `running` on OLD, stalled before its first write; meanwhile the new
// generation is published and the next step recovers it. The old hop's late writes are refused.
seedOrphan({programmeRunId:OLD,published:null});records.get('programme.json').runId=OLD;etags.set('programme.json',String(++revision));
let holdStale,staleHeld=false;const staleGate=new Promise(resolve=>{holdStale=resolve;});
bucket.get=async key=>{if(key==='epg/discovery-latest.json'&&!staleHeld){staleHeld=true;await staleGate;}return originalGet(key);};
const staleHop=step();
for(let i=0;i<50&&!(continuation()?.stage==='running'&&continuation().hopId!==ORPHAN);i++)await new Promise(resolve=>setTimeout(resolve,0));
const staleHopId=continuation().hopId;bucket.get=originalGet;assert.equal(continuation().programmeRunId,OLD);
records.get('epg/resolver-lease.json').expiresAt=now-1;
set('epg/published-generation.json',{phase:'published',programmeRunId:GENERATION});records.get('programme.json').runId=GENERATION;etags.set('programme.json',String(++revision));records.get('epg/discovery-latest.json').programmeRunId=GENERATION;etags.set('epg/discovery-latest.json',String(++revision));
const recovered=await step();
assert.equal(recovered.data.diagnostic.recovery.action,'generation_recovered');assert.equal(recovered.data.diagnostic.recovery.superseded,OLD);assert.equal(recovered.data.diagnostic.branch,'chunk');
const recoveredRecord=plain(continuation()),recoveredStatus=plain(records.get('epg/discovery-status.json')),recoveredDecisions=decided();
holdStale();const lateStale=await staleHop;
assert.equal(lateStale.data.diagnostic.hopId,staleHopId);assert.equal(lateStale.data.diagnostic.chunk.stage,'error');assert.equal(lateStale.data.diagnostic.chunk.error,'resolver_busy');assert.equal(lateStale.data.diagnostic.saved.write,'other_hop');
assert.deepEqual(plain(continuation()),recoveredRecord,'the recovered checkpoint stands');assert.deepEqual(plain(records.get('epg/discovery-status.json')),recoveredStatus);assert.equal(decided(),recoveredDecisions);assert.equal(records.get('epg/resolver-lease.json').id,recovered.data.diagnostic.hopId);

// 17. The checkpoint is the first write after the hop-marked status. Regression: a hop finished its chunk (status
//     saved, lease renewed by the trailing writes), then the invocation ended before the checkpoint, the lease
//     release and the response; the record stayed `running` and the client saw a transport error. Now an
//     invocation that ends during the trailing writes, or whose response is lost on the way to the client, leaves
//     a settled `paused` record: pipeline status says settled, the diagnostics entry stays at `checkpointed` (with the
//     stored checkpoint) while the checkpoint is later than it (the response was lost, the step was not), and the next ordinary step continues
//     the series without repeating the chunk or losing budget.
const DIAGNOSTICS='epg/resolver-continuation-diagnostics.json';
const seedPaused=(remainingChunks=10)=>{seedOrphan();set('epg/resolver-continuation.json',{stage:'paused',reason:null,at:iso(now-60000),hopId:ORPHAN,remainingChunks,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION});};
const isRelease=(key,value)=>key==='epg/resolver-lease.json'&&JSON.parse(value).expiresAt===0;
seedPaused();
bucket.put=async(key,value,options)=>isRelease(key,value)?new Promise(()=>{}):realPut(key,value,options);
const ended=await Promise.race([step().then(()=>'answered'),new Promise(resolve=>setTimeout(()=>resolve('ended'),300))]);
bucket.put=realPut;
assert.equal(ended,'ended','the invocation ended at the lease release, before any response');
const statusIndex=puts.lastIndexOf('epg/discovery-status.json'),checkpointIndex=puts.lastIndexOf('epg/resolver-continuation.json');
assert.ok(statusIndex>-1&&checkpointIndex===statusIndex+1,'the checkpoint is the very next write after the final status: '+puts.slice(statusIndex-1).join(','));
assert.equal(continuation().stage,'paused');assert.equal(continuation().reason,null);assert.equal(continuation().remainingChunks,9);assert.notEqual(continuation().hopId,ORPHAN);assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(records.get('epg/discovery-status.json').hopId,continuation().hopId,'lastBatch names the hop whose checkpoint is stored');
assert.equal(decided(),2+CHUNK);
assert.ok(records.get('epg/resolver-lease.json').expiresAt>now,'the lease release was lost with the invocation');
let interruptedStatus=await status();
assert.equal(interruptedStatus.continuationHealth.status,'settled','a committed step is not an orphan, whatever happened to its response');
assert.equal(interruptedStatus.continuationDiagnostics.recent[0].phase,'checkpointed');assert.equal(interruptedStatus.continuationDiagnostics.recent[0].checkpoint.owned,true);assert.equal(interruptedStatus.continuationDiagnostics.recent[0].checkpoint.hopId,continuation().hopId);
assert.ok(Date.parse(continuation().at)>=Date.parse(interruptedStatus.continuationDiagnostics.recent[0].at),'the checkpoint is later than the entry that never got its outcome');
// While the unreleased lease lasts, the next step waits and writes nothing.
r=await step();
assert.equal(r.data.diagnostic.branch,'lease_live');assert.equal(r.data.discovery.nextAction,'wait');assert.equal(continuation().remainingChunks,9);assert.equal(decided(),2+CHUNK);
// After it expires, the next step is an ordinary continuation: no recovery, 9 -> 8, the interrupted chunk is not repeated.
set('epg/resolver-lease.json',{...records.get('epg/resolver-lease.json'),expiresAt:now-1000});
r=await step();d=r.data.diagnostic;
assert.equal(d.health.status,'settled');assert.equal(d.recovery,null);assert.equal(d.branch,'chunk');assert.equal(d.decision.budget,9);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.remainingChunks,8);assert.equal(r.data.discovery.nextAction,'continue');
assert.equal(decided(),2+2*CHUNK,'the interrupted step\'s chunk is not repeated');
assert.equal(d.leaseReleased,true);assert.equal(d.trailingError,null);assert.equal(records.get('epg/resolver-lease.json').expiresAt,0);
assert.deepEqual(fetches,[]);

// 18. A failed lease release after the checkpoint is a trailing failure, not an orphan and not a failed step: the
//     checkpoint stands, the response reports leaseReleased false, the entry completes, and the next step after the
//     lease expires continues the series.
seedPaused();
bucket.put=async(key,value,options)=>{if(isRelease(key,value))throw new Error('r2 put failed');return realPut(key,value,options);};
r=await step();bucket.put=realPut;
assert.equal(r.status,200);d=r.data.diagnostic;
assert.equal(d.branch,'chunk');assert.equal(d.saved.write,'saved');assert.equal(d.saved.owned,true);assert.equal(d.leaseReleased,false);assert.equal(d.trailingError,null);assert.equal(d.chunk.error,null);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.remainingChunks,9);
assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,9);assert.equal(decided(),2+CHUNK);
assert.equal(records.get(DIAGNOSTICS).recent[0].phase,'completed');assert.equal(records.get(DIAGNOSTICS).recent[0].diagnostic.leaseReleased,false);
assert.equal((await status()).continuationHealth.status,'settled');
set('epg/resolver-lease.json',{...records.get('epg/resolver-lease.json'),expiresAt:now-1000});
r=await step();assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,8);assert.equal(decided(),2+2*CHUNK);

// 19. A trailing write inside the chunk that fails after the checkpoint (the score preview) is classified, not
//     turned into an error record: the step stays committed with its real chunk result.
seedPaused();
bucket.put=async(key,value,options)=>{if(key==='epg/discovery-score-preview.json')throw new Error('r2 put failed');return realPut(key,value,options);};
r=await step();bucket.put=realPut;
assert.equal(r.status,200);d=r.data.diagnostic;
assert.equal(d.branch,'chunk');assert.equal(d.saved.write,'saved');assert.equal(d.trailingError,'storage');assert.equal(d.leaseReleased,true);assert.equal(d.chunk.error,null);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.remainingChunks,9);assert.equal(r.data.discovery.nextAction,'continue');
assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,9);assert.equal(records.get('epg/discovery-status.json').hopId,continuation().hopId);
assert.equal(records.get(DIAGNOSTICS).recent[0].phase,'completed');
fetches.length=0;

// 13. Every reported value is from the closed vocabulary; nothing from the payload leaks into the ring or the log.
seedOrphan();await step();
const entries=records.get('epg/resolver-continuation-diagnostics.json').recent;
for(const entry of entries){assert.ok(['idle','settled','live','orphaned'].includes(entry.diagnostic.health.status));if(entry.diagnostic.recovery)assert.ok(['settled','resumed','generation_recovered','generation_pending'].includes(entry.diagnostic.recovery.action));if(entry.diagnostic.saved)assert.ok(['saved','other_hop','write_conflict'].includes(entry.diagnostic.saved.write));}
assert.doesNotMatch(JSON.stringify(entries),SECRET);assert.doesNotMatch(logs.join('\n'),SECRET);
assert.ok(call('DIAGNOSTIC_VOCABULARY').reason.includes('orphaned'));
console.log('Orphaned continuation: settle after a completed chunk, one-off recovery, live lease (same/other hop), unfinished chunk resumed, exhausted budget, finished backlog, programme change, generation handoff (orphaned, terminal and mid-publication records, pending copy, live writer, concurrent and stalled hops, out-of-order commits), concurrent steps, stale-read fence, conflicting settle, hop-marked attribution, rejected checkpoint writes, checkpoint before the trailing writes (interrupted invocation, lost lease release, failed score preview), a stalled old hop fenced out (before its first write, between two helper writes and inside the queue refresh) and sanitized diagnostics passed');
