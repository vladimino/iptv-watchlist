// Guarded recovery of one paused/interrupted discovery series. Ordinary steps, including the hourly
// continuation, stay a stop. The confirm is a separate resolve body and is not `force`.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,puts=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
let continuationGets=0,spoilOn=0;
const reading=bucket.get.bind(bucket);
bucket.get=async key=>{
 if(key==='epg/resolver-continuation.json'&&spoilOn){continuationGets++;if(continuationGets===spoilOn){const current=records.get(key);records.set(key,{...current,at:new Date(Date.parse(current.at)+1).toISOString()});etags.set(key,String(++revision));}}
 return reading(key);
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester'};
const fetches=[];
let clockTime=Date.parse('2026-11-04T15:00:00.000Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[clockTime]));}static now(){return clockTime;}}
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,ASSETS:{},console,fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context),plain=value=>JSON.parse(JSON.stringify(value));
const assess=input=>plain(call('assessInterruptedRecovery')(input));
const execution={waitUntil(){}};
const origin='https://iptv.vladimino.workers.dev';
const post=async(path,body)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const recover=body=>post('/api/enrichment/discovery/resolve',{recovery:'interrupted',...body});
const step=()=>post('/api/sync/epg',{runId:'sync-1'});
const status=async()=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),env,execution)).json();
const iso=ms=>new Date(ms).toISOString();
const GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',NEXT='5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f',HOP='4b9bc7c5-c429-460b-87a5-e4adf2d4fbe8',PRIOR='6d1f3f1e-5b7e-4d6a-9c2b-1a2b3c4d5e6f';
const continuation=()=>records.get('epg/resolver-continuation.json');
const decided=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:clockTime,lastAiring:clockTime,airings:1,shows:[{channelId:'t',channel:'T',start:clockTime,end:clockTime+3600000}]}));
function seed(patch={}){
 records.clear();etags.clear();puts=[];fetches.length=0;continuationGets=0;spoilOn=0;clockTime=Date.parse('2026-11-04T15:00:00.000Z');
 delete env.DISCOVERY_EXECUTOR;env.TMDB_API_READ_ACCESS_TOKEN='test';delete context.DiscoveryAuthority;
 set('programme.json',{runId:GENERATION,updatedAt:iso(clockTime),films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 set('sync.json',{runId:'sync-1',stage:'complete',updatedAt:iso(clockTime)});
 set(call('profileKey'),{version:1,profileHash:'p'});
 set('epg/discovery-latest.json',{programmeRunId:GENERATION,items:items(200)});
 set('epg/published-generation.json',{phase:'published',programmeRunId:GENERATION});
 set('epg/discovery-resolution.json',{});
 set('epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt:iso(clockTime-60000),at:iso(clockTime-60000),programmeRunId:GENERATION,hopId:HOP,checked:1,checkpoint:'cheap_pass'});
 set('epg/resolver-continuation.json',{stage:'paused',reason:'interrupted',at:iso(clockTime),hopId:HOP,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:GENERATION,interruptions:2,...patch.continuation});
 if(patch.status)set('epg/discovery-status.json',patch.status);
 if(patch.sync)set('sync.json',patch.sync);
 if(patch.published)set('epg/published-generation.json',patch.published);
 if(patch.programme)set('programme.json',patch.programme);
 if(patch.source)set('epg/discovery-latest.json',patch.source);
 if(patch.lease)set('epg/resolver-lease.json',patch.lease);
 if(patch.diagnostics)set('epg/resolver-continuation-diagnostics.json',patch.diagnostics);
 if(patch.resolution)set('epg/discovery-resolution.json',patch.resolution);
 if(patch.catalog)set('epg/discovered-films.json',patch.catalog);
 if(patch.dropStatus)records.delete('epg/discovery-status.json');
}
const r2={mode:'r2',ready:false,held:false,cutover:null,transfer:'idle'};
const facts=patch=>({now:clockTime,epgStage:'complete',publishedRunId:GENERATION,programmeRunId:GENERATION,sourceRunId:GENERATION,record:{stage:'paused',reason:'interrupted',remainingChunks:12,programmeRunId:GENERATION,hopId:HOP,retryAt:null,nextCatchUpAt:null},lease:null,status:{hopId:HOP,programmeRunId:GENERATION,checkpoint:'cheap_pass'},diagnostics:null,authority:r2,...patch});
const kept=()=>JSON.stringify(continuation());

// The pure gate refuses every ambiguous or fenced shape and admits the cheap-pass shape on R2 and on an open D1 marker.
assert.deepEqual(assess(facts()),{permit:'eligible',reason:'eligible',cause:null,budget:12,proof:'cheap_pass'});
assert.equal(assess(facts({authority:{mode:'d1',ready:true,held:false,cutover:'open',transfer:'idle',programmeRunId:GENERATION}})).permit,'eligible');
assert.equal(assess(facts({authority:{mode:'d1',ready:true,held:false,cutover:'open',transfer:'committed',programmeRunId:GENERATION}})).permit,'eligible');
assert.equal(assess(facts({record:{stage:'paused',reason:'chunk_budget',remainingChunks:0,programmeRunId:GENERATION}})).reason,'not_interrupted');
assert.equal(assess(facts({record:null})).cause,'record_malformed');
assert.equal(assess(facts({epgStage:'epg'})).reason,'epg_not_complete');
assert.equal(assess(facts({publishedRunId:NEXT})).reason,'generation_mismatch');
assert.equal(assess(facts({sourceRunId:null})).reason,'generation_mismatch');
assert.equal(assess(facts({authority:{...r2,ready:true,programmeRunId:NEXT,mode:'d1'}})).reason,'generation_mismatch');
assert.equal(assess(facts({record:{stage:'paused',reason:'interrupted',remainingChunks:0,programmeRunId:GENERATION,hopId:HOP}})).reason,'no_budget');
assert.equal(assess(facts({record:{stage:'paused',reason:'interrupted',remainingChunks:'12',programmeRunId:GENERATION,hopId:HOP}})).cause,'budget_malformed');
assert.equal(assess(facts({lease:{id:'other',expiresAt:clockTime+1000}})).reason,'lease_live');
assert.equal(assess(facts({lease:{expiresAt:'later'}})).cause,'lease_malformed');
assert.equal(assess(facts({lease:{expiresAt:clockTime-1000}})).permit,'eligible');
assert.equal(assess(facts({record:{stage:'paused',reason:'interrupted',remainingChunks:12,programmeRunId:GENERATION,hopId:HOP,nextCatchUpAt:iso(clockTime+1000)}})).reason,'backoff');
assert.equal(assess(facts({status:{hopId:HOP,programmeRunId:GENERATION,checkpoint:'cheap_pass',retryAt:iso(clockTime+1000)}})).reason,'backoff');
assert.equal(assess(facts({authority:{unavailable:true}})).reason,'authority_unavailable');
assert.equal(assess(facts({authority:{mode:'d1',ready:false,held:true,cutover:'held',transfer:'idle'}})).reason,'authority_held');
assert.equal(assess(facts({authority:{mode:'d1',ready:true,held:false,cutover:'open',transfer:'loading',programmeRunId:GENERATION}})).reason,'authority_loading');
assert.equal(assess(facts({authority:{mode:'d1',ready:false,held:false,cutover:'open',transfer:'idle'}})).reason,'authority_unavailable');
assert.equal(assess(facts({status:null})).cause,'status_missing');
assert.equal(assess(facts({status:{programmeRunId:GENERATION,checkpoint:'cheap_pass'}})).cause,'status_unattributed');
assert.equal(assess(facts({status:{hopId:HOP,programmeRunId:GENERATION,finishedAt:iso(clockTime),checkpoint:'cheap_pass'}})).cause,'status_finished');
assert.equal(assess(facts({status:{hopId:PRIOR,programmeRunId:GENERATION,finishedAt:iso(clockTime-60000)}})).cause,'status_other_hop');
assert.equal(assess(facts({diagnostics:{recent:[{checkpoint:{hopId:HOP,owned:true},interruption:{committed:true}}]}})).cause,'checkpoint_claimed');
assert.equal(assess(facts({diagnostics:{recent:'no'}})).cause,'diagnostics_malformed');

// AIR-325: Discovery executes only as the Cloudflare Workflow. No HTTP step, forced resolve or recovery confirm runs a chunk, takes the lease or writes a continuation.
seed();
let before=kept();puts=[];
let r=await step();
assert.equal(r.status,200);assert.equal(r.data.executor,'workflow');assert.equal(r.data.delegated,false);assert.equal(r.data.discovery.nextAction,'stop');
assert.equal(kept(),before);assert.equal(decided(),0);assert.deepEqual(fetches,[]);
for(const body of [{},{chunks:0}]){
 puts=[];
 r=await recover(body);
 assert.equal(r.status,200);
 assert.equal(r.data.recovery.permit,'refused');assert.equal(r.data.recovery.cause,'executor_workflow');
 assert.equal(kept(),before);assert.equal(decided(),0);assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);
}
seed();puts=[];
r=await post('/api/enrichment/discovery/resolve',{});
assert.equal(r.data.executor,'workflow');assert.equal(kept(),before);assert.equal(decided(),0);assert.deepEqual(fetches,[]);

// The read-only status still reports the recovery gate and writes nothing.
puts=[];
const pipeline=await status();
assert.equal(pipeline.interruptedRecovery.permit,'eligible');assert.equal(pipeline.interruptedRecovery.proof,'cheap_pass');
assert.equal(kept(),before,'a status read does not recover the series');assert.deepEqual(puts,[]);

r=await post('/api/enrichment/discovery/resolve',{recovery:'force'});
assert.equal(r.status,400);
puts=[];
r=await post('/api/enrichment/discovery/resolve',{recovery:'interrupted',chunks:2});
assert.equal(r.status,400);assert.deepEqual(puts,[]);

console.log('Interrupted recovery: pure gate, retired external HTTP paths delegate or refuse without writes, read-only status, request validation passed');
