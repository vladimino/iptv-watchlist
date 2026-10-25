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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
const execution={waitUntil(){}};
const origin='https://iptv.vladimino.workers.dev',headers={'Content-Type':'application/json'};
const post=async(path,body)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const status=async()=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,execution)).json();
const step=()=>post('/api/sync/epg',{runId:'sync-1'});
const now=Date.now(),iso=ms=>new Date(ms).toISOString();
const ORPHAN='4b9bc7c5-c429-460b-87a5-e4adf2d4fbe8',GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe';
const continuation=()=>records.get('epg/resolver-continuation.json');
const verified=()=>Object.values(records.get('epg/discovery-resolution.json')||{}).filter(d=>d.status==='verified').length;
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:100,durations:[100],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]}));
// The production shape on 25 Oct: a hop opened `running` with budget 5, its chunk finished (status saved with
// finishedAt, added 2, no error), its lease expired, and no checkpoint followed.
function seedOrphan({remainingChunks=5,lease='expired',completed=true,programmeRunId=GENERATION,published=GENERATION,lastRemaining=3,verifiedBefore=2}={}){
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
 set('epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt:iso(started),finishedAt:iso(started+500),at:iso(started+500),programmeRunId:GENERATION,checked:3,screenedOut:0,reused:0,touched:0,tmdbCalls:0,added:2,remaining:lastRemaining,variantPending:0,hotRemaining:lastRemaining,error:null,retryAt:null});
}
const SECRET=/Hot Film|legacy|Bearer|token=/;
// A sync step runs a chunk of 24 candidates; every candidate resolves through the watchlist alias, without TMDB.
const CHUNK=24;

// 1. Interrupted after a completed chunk: the explicit step settles the orphan (5 -> 4), runs one chunk (4 -> 3)
//    on the same generation, and the dead hop's id is gone from the record.
seedOrphan();
let r=await step();
assert.equal(r.status,200);assert.equal(r.data.stage,'complete');
let d=r.data.diagnostic;
assert.deepEqual(d.health,{status:'orphaned',hopId:ORPHAN,lease:'expired',leaseHop:'same',leaseExpiresAt:iso(now-1000),chunkCompleted:true,resumeBudget:4,generationConflict:false});
assert.deepEqual(d.recovery,{orphanHopId:ORPHAN,action:'settled',chunkCompleted:true,budget:4,settled:true});
assert.equal(d.branch,'chunk');assert.equal(d.decision.budget,4);assert.notEqual(d.hopId,ORPHAN);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,null);assert.equal(r.data.discovery.remainingChunks,3);assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.programmeRunId,GENERATION);
assert.equal(continuation().stage,'paused');assert.equal(continuation().remainingChunks,3);assert.equal(continuation().hopId,d.hopId);assert.equal(continuation().programmeRunId,GENERATION);
assert.equal(verified(),2+CHUNK,'the completed chunk\'s decisions stay and exactly one more chunk ran');
assert.equal(records.get('epg/discovery-status.json').added,0);assert.equal(records.has('epg/discovered-films.json'),false,'no catalog write was repeated');
assert.deepEqual(fetches,[]);assert.equal(records.get('epg/resolver-lease.json').expiresAt,0);
assert.ok(Date.parse(records.get('epg/discovery-status.json').startedAt)>now-60000,'lastBatch now belongs to the new chunk');
// The dead hop cannot overwrite the newer checkpoint, whatever it tries.
const newer=structuredClone(continuation());
const stale=plain(await call('saveOwnedContinuation')(env,ORPHAN,{stage:'paused',reason:null,at:iso(now),hopId:ORPHAN,remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));
assert.deepEqual(stale,newer);assert.deepEqual(continuation(),newer);
assert.equal(await call('replaceContinuation')(env,{stage:'running',hopId:ORPHAN,remainingChunks:5},'stale-etag'),false);assert.deepEqual(continuation(),newer);
const ring=records.get('epg/resolver-continuation-diagnostics.json').recent[0];
assert.equal(ring.branch,'continuation');assert.equal(ring.diagnostic.recovery.action,'settled');assert.equal(ring.diagnostic.health.status,'orphaned');
assert.doesNotMatch(JSON.stringify(ring),SECRET);assert.doesNotMatch(logs.join('\n'),SECRET);

// 2. A second step continues normally (3 -> 2): the orphan handling is one-off.
r=await step();
assert.equal(r.data.diagnostic.health.status,'settled');assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,2);assert.equal(verified(),2+2*CHUNK);

// 3. A live lease of the same hop is a live writer: busy / wait until the lease expires, nothing written.
seedOrphan({lease:'live'});
const before=plain(continuation()),leaseExpiry=iso(now+60000);
r=await step();
assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.discovery.reason,'busy');assert.equal(r.data.discovery.nextAction,'wait');assert.equal(r.data.discovery.nextCatchUpAt,leaseExpiry);
assert.equal(r.data.diagnostic.branch,'lease_live');assert.deepEqual(r.data.diagnostic.health,{status:'live',hopId:ORPHAN,lease:'live',leaseHop:'same',leaseExpiresAt:leaseExpiry,chunkCompleted:null,resumeBudget:null,generationConflict:false});
assert.deepEqual(plain(continuation()),before);assert.equal(verified(),2);assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[]);
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
assert.deepEqual(pipeline.continuationHealth,{status:'orphaned',hopId:ORPHAN,lease:'expired',leaseHop:'same',leaseExpiresAt:iso(now-1000),chunkCompleted:false,resumeBudget:5,generationConflict:false});
assert.deepEqual(puts.filter(key=>!key.includes('continuation-diagnostics')),[]);
r=await step();
assert.equal(r.data.diagnostic.recovery.action,'resumed');assert.equal(r.data.diagnostic.recovery.chunkCompleted,false);assert.equal(r.data.diagnostic.decision.budget,5);
assert.equal(r.data.discovery.remainingChunks,4);assert.equal(continuation().stage,'paused');assert.equal(verified(),2+CHUNK);
// A cheap-pass checkpoint without finishedAt is not a completed chunk either.
seedOrphan();records.get('epg/discovery-status.json').finishedAt=undefined;records.get('epg/discovery-status.json').checkpoint='cheap_pass';
r=await step();assert.equal(r.data.diagnostic.health.chunkCompleted,false);assert.equal(r.data.discovery.remainingChunks,4);

// 5. The completed chunk used the last budget: settle to chunk_budget / wait, run nothing.
seedOrphan({remainingChunks:1});
r=await step();
assert.equal(r.data.diagnostic.branch,'orphan_settled');assert.equal(r.data.diagnostic.recovery.action,'settled');assert.equal(r.data.diagnostic.recovery.budget,0);
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,'chunk_budget');assert.equal(r.data.discovery.remainingChunks,0);assert.equal(r.data.discovery.nextAction,'wait');assert.ok(r.data.discovery.nextCatchUpAt);
assert.equal(continuation().reason,'chunk_budget');assert.equal(continuation().hopId,ORPHAN,'the settled checkpoint is the one the dead hop would have written');assert.equal(verified(),2);assert.equal(puts.includes('epg/resolver-lease.json'),false,'no lease was taken');

// 6. The completed chunk finished the backlog: settle to complete / stop.
seedOrphan({lastRemaining:0});
r=await step();
assert.equal(r.data.diagnostic.branch,'orphan_settled');assert.equal(r.data.discovery.state,'complete');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(continuation().stage,'complete');assert.equal(verified(),2);
// A completed chunk that saw the programme change settles to programme_changed / stop.
seedOrphan();records.get('epg/discovery-status.json').programmeChanged=true;
r=await step();assert.equal(r.data.discovery.reason,'programme_changed');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(verified(),2);

// 7. Generation fence: the orphan belongs to another published generation, so it is closed, not resumed.
seedOrphan({programmeRunId:'00000000-0000-4000-8000-000000000000'});
r=await step();
assert.equal(r.data.stage,'complete','the sync run stage is unchanged');assert.equal(r.data.diagnostic.branch,'generation_conflict');assert.equal(r.data.diagnostic.health.generationConflict,true);
assert.deepEqual(r.data.diagnostic.recovery,{orphanHopId:ORPHAN,action:'generation_conflict',chunkCompleted:false,budget:0,settled:true},'a status from another generation is not this hop\'s chunk');
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,'programme_changed');assert.equal(r.data.discovery.nextAction,'stop');assert.equal(r.data.discovery.remainingChunks,0);
assert.equal(continuation().reason,'programme_changed');assert.equal(continuation().programmeRunId,'00000000-0000-4000-8000-000000000000');assert.equal(verified(),2);assert.deepEqual(fetches,[]);
pipeline=await status();assert.equal(pipeline.continuationHealth.status,'settled');
// Without a published generation pointer there is nothing to fence against.
seedOrphan({published:null,programmeRunId:'00000000-0000-4000-8000-000000000000'});
r=await step();assert.equal(r.data.diagnostic.health.generationConflict,false);assert.equal(r.data.diagnostic.branch,'chunk');

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
assert.equal(winner.data.diagnostic.branch,'chunk');assert.equal(winner.data.discovery.remainingChunks,3);assert.equal(continuation().stage,'paused');assert.equal(verified(),2+CHUNK);

// 9. Stale-read fence: a call that decided on a record that moved before it took the lease does not write.
seedOrphan();
await step();const settledRecord=plain(continuation()),settledEtag=etags.get('epg/resolver-continuation.json');
let staleOnce=true;
bucket.get=async key=>{if(key==='epg/resolver-continuation.json'&&staleOnce){staleOnce=false;return {etag:'stale',json:async()=>({stage:'paused',reason:'epg_committed',at:iso(now),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:null})};}return originalGet(key);};
r=await step();bucket.get=originalGet;
assert.equal(r.data.diagnostic.branch,'record_changed');assert.equal(r.data.discovery.state,'busy');assert.equal(r.data.diagnostic.decision.budget,12,'the stale record was what the decision saw');
assert.deepEqual(plain(continuation()),settledRecord);assert.equal(etags.get('epg/resolver-continuation.json'),settledEtag);assert.equal(verified(),2+CHUNK);assert.equal(records.get('epg/resolver-lease.json').expiresAt,0,'the lease was released');
assert.equal(r.data.diagnostic.saved.owned,false);

// 10. A conflicting settle (someone replaced the orphan between read and write) is reported, not forced.
seedOrphan();
const originalPut=bucket.put.bind(bucket);let stolen=false;
bucket.put=async(key,value,options)=>{if(key==='epg/resolver-continuation.json'&&!stolen){stolen=true;await originalPut(key,JSON.stringify({stage:'paused',reason:null,at:iso(now),hopId:'22222222-3333-4444-8555-666666666666',remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION}));}return originalPut(key,value,options);};
r=await step();bucket.put=originalPut;
assert.equal(r.data.diagnostic.branch,'record_changed');assert.equal(r.data.diagnostic.recovery.settled,false);assert.equal(continuation().hopId,'22222222-3333-4444-8555-666666666666');assert.equal(verified(),2);

// 11. Every reported value is from the closed vocabulary; nothing from the payload leaks into the ring or the log.
seedOrphan();await step();
const entries=records.get('epg/resolver-continuation-diagnostics.json').recent;
for(const entry of entries){assert.ok(['idle','settled','live','orphaned'].includes(entry.diagnostic.health.status));if(entry.diagnostic.recovery)assert.ok(['settled','resumed','generation_conflict'].includes(entry.diagnostic.recovery.action));}
assert.doesNotMatch(JSON.stringify(entries),SECRET);assert.doesNotMatch(logs.join('\n'),SECRET);
assert.ok(call('DIAGNOSTIC_VOCABULARY').reason.includes('orphaned'));
console.log('Orphaned continuation: settle after a completed chunk, one-off recovery, live lease (same/other hop), unfinished chunk resumed, exhausted budget, finished backlog, programme change, generation fence, concurrent steps, stale-read fence, conflicting settle and sanitized diagnostics passed');
