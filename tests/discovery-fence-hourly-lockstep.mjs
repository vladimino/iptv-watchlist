// AIR-687: a discovery_fence thrown outside `guarded` (status/checkpoint/assignment write) is a CAS collision on discovery_authority.generation as often as a real switch.
// It used to become stage=error with nextCatchUpAt = the next hour boundary, where the hourly cron collides again (seven nights-long failures on 26-27 Nov 2026).
// Offline only: in-memory R2 stand-in, stubbed authority, stubbed chunk. Nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};},
 async delete(key){records.delete(key);etags.delete(key);}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const RUN='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',OTHER='b2699929-1111-4222-8333-444444444444';
const logs=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,Math,Number,Object,Array,String,Promise,Error,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,console:{log(m){logs.push(m);},error(){},warn(){}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/discovery-workflow.js','src/worker.js'])
 vm.runInContext(fs.readFileSync(file,'utf8').replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const owner={published:RUN};
context.DiscoveryAuthority={
 ownsKey:()=>false,
 readAuthority:async()=>({ready:true,held:false,tables:true,mode:'d1',cutover:'open',version:11,generation:1,programmeRunId:owner.run??RUN,publishedProgrammeRunId:owner.published,transfer:'idle'}),
 readWorkflow:async()=>({handled:false}),writeWorkflow:async()=>({handled:false,saved:false}),
 routeRead:async()=>({handled:false}),routeWrite:async()=>({handled:false}),
 readContinuation:async()=>({handled:false}),writeContinuation:async()=>({handled:false}),
 readLease:async()=>({handled:false}),acquireLease:async()=>({lease:{id:'11111111-2222-4333-8444-555555555555',expiresAt:Date.now()+90000}}),
 renewLease:async()=>({ok:true}),releaseLease:async()=>({handled:false})
};
const publish=run=>set('epg/published-generation.json',{phase:'published',programmeRunId:run});
const reset=()=>{records.clear();etags.clear();publish(RUN);set('programme.json',{runId:RUN,films:[{id:'f',title:'F',shows:[]}]});};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
const fence=()=>Object.assign(new Error('discovery_fence'),{code:'discovery_fence',failureKind:'fence',failedAt:'final_checkpoint'});
let mode='fence';
context.resolveDiscoveryChunk=async()=>{
 if(mode==='fence')throw fence();
 return {stage:'partial',checked:3,remaining:10,schemaVersion:2,programmeRunId:RUN};
};
const advance=()=>context.advanceDiscovery(env,{caller:'internal',chunkBudgetMs:1000});
const record=()=>records.get('epg/resolver-continuation.json');
const nextHour=()=>Math.floor(Date.now()/3600000+1)*3600000;

// A. Transient collision on the published run: a short retry, not an hour-long wait; the Workflow plan wakes in about 30 s.
reset();
const first=await advance();
assert.equal(first.stage,'partial',JSON.stringify(first).slice(0,300));
assert.equal(first.generationCollision,true);
assert.equal(record().reason,'backoff');assert.equal(record().stage,'paused');
const retryMs=Date.parse(record().retryAt)-Date.now();
assert.ok(retryMs>0&&retryMs<=31000,'short retry, not the hour boundary: '+retryMs);
assert.ok(Date.parse(record().retryAt)<nextHour()-60000||nextHour()-Date.now()<61000,'not the hour boundary');
const plan=context.workflowPlan({published:RUN,pinned:RUN,record:record(),lease:null,now:Date.now(),chunks:0,last:null,uncertainWrites:0,used:0});
assert.equal(plan.action,'wait');assert.ok(plan.until-Date.now()<=31000,'plan wakes in ~30 s: '+(plan.until-Date.now()));
assert.equal(record().fenceCollisions,1);

// B. The retry after the deferral really moves the queue and clears the collision counter.
mode='ok';
const due=Date.parse(record().retryAt);
const clockNow=Date.now;Date.now=()=>due+1000;
try{
 const second=await advance();
 assert.equal(second.checked,3,JSON.stringify(second).slice(0,300));
 assert.equal(record().fenceCollisions,undefined);
}finally{Date.now=clockNow;}

// C. Bounded: after the series limit the old fail-closed error returns (waits for the hour, owner-visible).
mode='fence';reset();set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:new Date().toISOString(),hopId:'h',remainingChunks:3,nextCatchUpAt:null,retryAt:new Date(Date.now()-1000).toISOString(),programmeRunId:RUN,fenceCollisions:6});
const exhausted=await advance();
assert.equal(exhausted.stage,'error',JSON.stringify(exhausted).slice(0,300));
assert.equal(record().stage,'error');assert.equal(record().reason,'discovery_fence');assert.equal(record().failureKind,'fence');

// D. A genuine switch (published run moved) or held authority fails closed as before.
for(const [label,arrange] of [['published run moved',()=>publish(OTHER)],['authority names another run',()=>{owner.run=OTHER;}]]){
 reset();owner.run=undefined;arrange();
 set('programme.json',{runId:RUN,films:[{id:'f',title:'F',shows:[]}]});
 set('epg/resolver-continuation.json',{stage:'paused',reason:'backoff',at:new Date().toISOString(),hopId:'h',remainingChunks:3,nextCatchUpAt:null,retryAt:new Date(Date.now()-1000).toISOString(),programmeRunId:RUN});
 let out=null,threw=null;try{out=await advance();}catch(e){threw=e;}
 assert.ok(!out?.generationCollision,label+': never a collision retry: '+JSON.stringify(out).slice(0,200));
}
owner.run=undefined;reset();

// E. Progress semantics: a saved checkpoint of an error/collision chunk with nothing checked is not useful progress; real work is.
const chunkOutcome=async(result,saved=true)=>{
 context.advanceDiscovery=async()=>({...result,diagnostic:{saved:{owned:saved}},discovery:{}});
 return context.runWorkflowChunk(env,{statements:0,batches:0});
};
assert.equal((await chunkOutcome({stage:'error',error:'discovery_fence',checked:0})).progress,true,'checkpoint still saved');
assert.equal((await chunkOutcome({stage:'error',error:'discovery_fence',checked:0})).usefulProgress,false);
assert.equal((await chunkOutcome({stage:'partial',generationCollision:true,checked:0})).usefulProgress,false);
assert.equal((await chunkOutcome({stage:'partial',checked:3,remaining:5})).usefulProgress,true);
assert.equal((await chunkOutcome({stage:'partial',checked:0,touched:4,remaining:5})).usefulProgress,true,'cheap pass counts');
assert.equal((await chunkOutcome({stage:'partial',checked:3,remaining:5},false)).usefulProgress,false,'unsaved is not progress');
console.log('discovery fence hourly lockstep ok');
