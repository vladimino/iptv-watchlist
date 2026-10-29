// AIR-199: the production shape of 27 Oct 2026. The EPG commit published a new generation (pointer and generation
// files) and the invocation then ended (Workers `exceededMemory`) before `queueDiscovery`. A retry of the same commit
// took the resume path, saved the sync run as `complete` and ended the same way, still before `queueDiscovery`. The
// continuation was left on the previous generation's terminal `chunk_budget` record with no chunks left.
// Since AIR-212 the commit opens the series of the published generation before its memory-heavy tail, so the same
// interruptions now leave a checkpoint of the new generation (cases 2, 3 and 7). The stranded state can still exist in
// storage written by an earlier Worker; cases 1, 4 and 5 pin down how it reads and that a continuation step reaches the
// AIR-159 handoff from it. See tests/epg-commit-durable-enqueue.mjs for the full commit flow.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester'};
const fetches=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:()=>{}},
 fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context);
const execution={waitUntil(){}};
const origin='https://iptv.vladimino.workers.dev',headers={'Content-Type':'application/json'};
const OLD='23570366-0000-4000-8000-000000000000',NEW='b2699929-0000-4000-8000-000000000000',OLD_HOP='33333333-4444-4555-8666-777777777777';
const post=async(path,body)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const read=async path=>(await worker.fetch(new Request(origin+path),env,execution)).json();
const step=()=>post('/api/sync/epg',{runId:NEW});
const now=Date.now(),iso=ms=>new Date(ms).toISOString();
const continuation=()=>records.get('epg/resolver-continuation.json');
const ring=()=>records.get('epg/resolver-continuation-diagnostics.json')?.recent||[];
const settle=async()=>{for(let i=0;i<50;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]}));
const programme=runId=>({runId,updatedAt:iso(now),watchlistCount:1,films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}],stats:{}});
const STALE={stage:'paused',reason:'chunk_budget',at:iso(now-86400000),hopId:OLD_HOP,remainingChunks:0,nextCatchUpAt:iso(now+3600000),retryAt:null,programmeRunId:OLD};

// The state the first interrupted commit leaves: the pointer and the generation files name NEW, the sync run is still
// in the `epg` stage with its events recorded (so a retry takes the commit's resume path), the shared copies may still
// carry OLD, and the continuation is the previous generation's spent series. `stage` lets a case model a commit that
// got as far as saving the run as `complete` before it ended.
function seedInterruptedCommit({stage='epg'}={}){
 records.clear();etags.clear();fetches.length=0;
 set('epg/published-generation.json',{phase:'published',programmeRunId:NEW});
 set('epg/generations/'+NEW+'/programme.json',programme(NEW));
 set('epg/generations/'+NEW+'/discovery-latest.json',{programmeRunId:NEW,items:items(60)});
 set('programme.json',programme(OLD));set('epg/discovery-latest.json',{programmeRunId:OLD,items:items(60)});
 set('sync.json',stage==='epg'?{runId:NEW,stage:'epg',updatedAt:iso(now-60000),events:[],watchlist:[{id:'w1',tmdbId:'42'}],pending:[],remaining:0}:{runId:NEW,stage:'complete',updatedAt:iso(now-60000)});
 set('epg/resolver-continuation.json',STALE);
}

// 1. Read-only views of the interrupted state. Nothing in them flags the generation mismatch: the raw continuation
//    names OLD with no chunks left, its health is `settled` (generationConflict is only computed for a `running`
//    record), and the sync status is still `epg`. The hourly task contract (stage A) continues discovery only when
//    outstanding chunks exist and no generation mismatch applies, so it makes no step from this state.
seedInterruptedCommit();
let pipeline=await read('/api/enrichment/pipeline/status');
assert.equal(pipeline.continuation.programmeRunId,OLD);assert.equal(pipeline.continuation.reason,'chunk_budget');assert.equal(pipeline.continuation.remainingChunks,0);
assert.equal(pipeline.continuationHealth.status,'settled');assert.equal(pipeline.continuationHealth.generationConflict,null);
assert.equal((await read('/api/status')).stage,'epg');
assert.deepEqual(continuation(),STALE,'reads write nothing to the continuation');

// 2. Two retries of the commit that end inside the commit's trailing work (here: the first read of finishSync never
//    returns, as an invocation killed for memory never returns) leave two `entered` ring entries for /api/sync/epg with
//    no terminal outcome and the published pointer on NEW. Since AIR-212 the series of NEW is already open: the resume
//    path queues it before finishSync.
const originalGet=bucket.get.bind(bucket);
bucket.get=async key=>{if(key==='watchlist.json')return new Promise(()=>{});return originalGet(key);};
step();await settle();step();await settle();
bucket.get=originalGet;
const entries=ring().filter(entry=>entry.route==='/api/sync/epg');
assert.equal(entries.length,2);for(const entry of entries){assert.equal(entry.phase,'entered');assert.equal(entry.httpStatus,null);}
assert.equal(records.get('epg/published-generation.json').programmeRunId,NEW);
assert.equal(continuation().programmeRunId,NEW,'the checkpoint of NEW is queued before the tail');assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);
assert.equal(records.get('sync.json').stage,'epg');

// 3. While the run is in the `epg` stage, a step is a commit retry, not a continuation step: the AIR-159 handoff in
//    advanceDiscovery is never consulted. When the retry completes, the series of NEW queued by the earlier attempt is
//    kept as it is (full budget, `epg_committed`), and nothing else is republished.
let r=await step();
assert.equal(r.status,200);assert.equal(r.data.stage,'complete');
assert.equal(r.data.discovery.state,'paused');assert.equal(r.data.discovery.reason,'epg_committed');assert.equal(r.data.discovery.remainingChunks,12);assert.equal(r.data.discovery.nextAction,'continue');assert.equal(r.data.discovery.programmeRunId,NEW);
assert.equal(continuation().programmeRunId,NEW);assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().hopId,null);
const commitEntry=ring().find(entry=>entry.route==='/api/sync/epg'&&entry.phase==='completed');
assert.equal(commitEntry.branch,'epg_commit');assert.equal(commitEntry.runStage,'epg');assert.deepEqual(commitEntry.diagnostic,{},'the commit branch never enters advanceDiscovery');
assert.equal(records.get('programme.json').runId,NEW,'the resume path copies the published generation into the shared programme');
assert.equal(records.get('sync.json').stage,'complete');
// The next ordinary step is a continuation chunk of NEW.
r=await step();
assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,11);assert.equal(continuation().programmeRunId,NEW);

// 4. If the interrupted commit had already saved the run as `complete`, a step is a continuation step and the AIR-159
//    handoff supersedes the stale OLD record (see also tests/orphaned-continuation.mjs case 14). The read-only views
//    look the same as in case 1 apart from the sync stage.
seedInterruptedCommit({stage:'complete'});
pipeline=await read('/api/enrichment/pipeline/status');
assert.equal(pipeline.continuationHealth.status,'settled');assert.equal(pipeline.continuationHealth.generationConflict,null);
r=await step();
assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.recovery.action,'generation_recovered');assert.equal(r.data.diagnostic.recovery.superseded,OLD);
assert.equal(r.data.discovery.remainingChunks,11);assert.equal(continuation().programmeRunId,NEW);

// 5. Competing callers on the `complete` shape: two concurrent steps. Exactly one hands the series over and runs a
//    chunk; the other is told to wait. The budget moves by one chunk only and the record names NEW.
seedInterruptedCommit({stage:'complete'});
let release,gated=false;const gate=new Promise(resolve=>{release=resolve;});
bucket.get=async key=>{if(key==='epg/generations/'+NEW+'/discovery-latest.json'&&!gated){gated=true;await gate;}return originalGet(key);};
const first=step();
for(let i=0;i<50&&continuation()?.stage!=='running';i++)await new Promise(resolve=>setTimeout(resolve,0));
assert.equal(continuation().stage,'running');assert.equal(continuation().programmeRunId,NEW);
const second=await step();
release();const winner=await first;bucket.get=originalGet;
assert.equal(winner.data.diagnostic.recovery.action,'generation_recovered');assert.equal(winner.data.discovery.remainingChunks,11);
assert.equal(second.data.discovery.nextAction,'wait');assert.ok(['lease_live','record_changed','lease_lost'].includes(second.data.diagnostic.branch),second.data.diagnostic.branch);
assert.equal(continuation().programmeRunId,NEW);assert.equal(continuation().remainingChunks,11);

// 6. Generation fence: a late commit of OLD that resumes after NEW was handed over cannot roll the NEW series back.
const before=structuredClone(continuation());
const late=JSON.parse(JSON.stringify(await call('queueDiscovery')(env,'epg_committed',OLD)));
assert.equal(late.programmeRunId,NEW);assert.deepEqual(continuation(),before);

// 7. The 27 Oct end state is no longer reachable: the retry saves the run as `complete` in finishSync and then ends
//    (here: every read after that save never returns) before refreshPredictionQueue, the ratings refresh and the final
//    queueDiscovery finish. Since AIR-212 the series of NEW was opened before finishSync, so the read-only views show
//    outstanding chunks for the published generation and the next step runs a chunk of NEW without a handoff.
seedInterruptedCommit();
let savedComplete=false;const originalPut=bucket.put.bind(bucket);
bucket.put=async(key,value,options)=>{const saved=await originalPut(key,value,options);if(key==='sync.json'&&JSON.parse(value).stage==='complete')savedComplete=true;return saved;};
bucket.get=async key=>{if(savedComplete)return new Promise(()=>{});return originalGet(key);};
step();await settle();
bucket.get=originalGet;bucket.put=originalPut;
assert.equal(records.get('sync.json').stage,'complete');assert.equal(records.get('sync.json').runId,NEW);
assert.equal(continuation().programmeRunId,NEW,'the series was opened before the tail');assert.equal(continuation().remainingChunks,12);
assert.equal(ring().filter(entry=>entry.route==='/api/sync/epg'&&entry.phase==='completed').length,0);
pipeline=await read('/api/enrichment/pipeline/status');
assert.equal(pipeline.continuation.programmeRunId,NEW);assert.equal(pipeline.continuation.remainingChunks,12);
assert.equal((await read('/api/status')).stage,'complete');
r=await step();
assert.equal(r.data.diagnostic.branch,'chunk');assert.equal(r.data.diagnostic.recovery,null);assert.equal(r.data.discovery.remainingChunks,11);assert.equal(continuation().programmeRunId,NEW);

assert.deepEqual(fetches.filter(url=>!url.includes('letterboxd.com')),[],'no TMDB or EPG request was made');
console.log('AIR-199 interrupted EPG commit: read-only views, two entered without outcome, commit retry versus AIR-159 handoff, competing callers, generation fence and the AIR-212 early enqueue passed');
