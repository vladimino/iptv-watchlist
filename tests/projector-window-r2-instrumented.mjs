// ADR 0103 / AIR-383: an instrumented run of the real Discovery chunk. The R2 bucket records every put, with no D1 authority armed, so a
// key that D1 would own is written to R2 here and shows up: the recorded keys are a superset of what any mode writes. Harness shared with
// tests/discovery-workflow.mjs. Nothing calls Cloudflare, TMDB or production.
// (original header) AIR-323 / ADR 0083: the Discovery Workflow is inert unless DISCOVERY_EXECUTOR=workflow.
// Absent mode keeps one explicit chunk. Workflow mode does not run that chunk in the request, renews a spent
// series without the hourly gate, and fences a second writer. No production binding is read or written.
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
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const creates=[];
const binding={
 async create(request){creates.push(request);const prior=creates.filter(item=>item.id===request.id).length;if(prior>1){const error=new Error('Instance already exists');throw error;}return {id:request.id};},
 async get(){return {status:'running'};}
};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,LETTERBOXD_USERNAME:'tester',DISCOVERY_WORKFLOW:binding};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,console:{log(){},error(){},warn(){}},ASSETS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/discovery-workflow.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
}
const worker=context.worker,call=code=>vm.runInContext(code,context),realAdvance=context.advanceDiscovery;
const execution={waitUntil(){}};
const origin='https://iptv.example',headers={'Content-Type':'application/json'};
const post=async(path,body,environment=env)=>{const response=await worker.fetch(new Request(origin+path,{method:'POST',headers,body:JSON.stringify(body)}),environment,execution);return {status:response.status,data:await response.json()};};
const status=async(environment=env)=>(await worker.fetch(new Request(origin+'/api/enrichment/pipeline/status'),environment,execution)).json();
const now=Date.now(),iso=new Date(now).toISOString();
const GENERATION='a30f67e9-3a11-4f65-b9ec-ccdadfcedbfe',OTHER='b2699929-1111-4222-8333-444444444444';
const INSTANCE=`discovery_${GENERATION.replace(/-/g,'')}_0`;
const decided=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
const continuation=()=>records.get('epg/resolver-continuation.json');
const items=count=>Array.from({length:count},(_,i)=>({key:'hot film|2020|'+i,title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:200,durations:[200],firstAiring:now,lastAiring:now,airings:1,shows:[{channelId:'t',channel:'T',start:now,end:now+3600000}]}));
function readyDiscoveryGate(runId){
 return {ready:true,held:false,tables:true,mode:'d1',cutover:'open',version:11,generation:1,programmeRunId:runId||null,publishedProgrammeRunId:runId||null,transfer:'idle'};
}
function armDiscoveryAuthority(runId){
 context.DiscoveryAuthority={
  ownsKey:()=>false,
  readAuthority:async()=>readyDiscoveryGate(runId),
  readWorkflow:async()=>({handled:false}),
  writeWorkflow:async()=>({handled:false,saved:false}),
  routeRead:async()=>({handled:false}),
  routeWrite:async()=>({handled:false}),
  readContinuation:async()=>({handled:false}),
  writeContinuation:async()=>({handled:false}),
  readLease:async()=>({handled:false}),
  acquireLease:async()=>({lease:{id:'11111111-2222-4333-8444-555555555555',expiresAt:Date.now()+90000}}),
  renewLease:async()=>({ok:true}),
  releaseLease:async()=>({handled:false}),
 };
}
function armWorkflowAdmission(runId=GENERATION){
 armDiscoveryAuthority(runId);
 armPublishedEpg(runId);
}
function clearWorkflowAdmission(){
 delete context.DiscoveryAuthority;
 delete context.PublishedEpg;
}
function armPublishedEpg(runId){
 context.PublishedEpg={
  currentGeneration:async()=>runId?{authority:'d1',programmeRunId:runId,phase:'published',generation:1,fence:'d1:1:'+runId}:null,
  readAuthority:async()=>({ready:true,mode:'d1',cutover:'open',programmeRunId:runId||null}),
  repairMirrors:async()=>{},
  readDocumentAt:async(_env,_run,kind)=>records.get(kind==='watchlist'?'watchlist.json':'programme.json')||null,
  saveWatchlist:async()=>null,
  publishGeneration:async(_env,input)=>{
   if(input?.programmeRunId)set('epg/published-generation.json',{phase:input.phase||'published',programmeRunId:input.programmeRunId});
   return {ok:true,programmeRunId:input?.programmeRunId||null,phase:input?.phase||'published'};
  },
  writeMirrors:async()=>true,
 };
}
function elect(series=0,programmeRunId=GENERATION){
 const instanceId=`discovery_${String(programmeRunId).replace(/[^0-9A-Za-z]/g,'').slice(0,32)||'none'}_${series}`;
 set('epg/discovery-workflow.json',{schemaVersion:1,programmeRunId,series,instanceId,phase:'running',updatedAt:new Date().toISOString(),waitingUntil:null,reason:null,chunksThisInstance:0,lastProgress:null,recovery:null});
 return instanceId;
}
function seed({stage='complete',remaining=12,reason='epg_committed',count=60,programmeRunId=GENERATION,published=GENERATION,syncId='sync-1'}={}){
 records.clear();etags.clear();puts.length=0;creates.length=0;
 set('programme.json',{runId:programmeRunId,updatedAt:iso,films:[{id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]}]});
 set('sync.json',{runId:syncId,stage,updatedAt:iso,events:[{id:'evt-1',type:'epg',at:iso}]});
 set('epg/discovery-latest.json',{programmeRunId,items:items(count)});
 set('epg/discovery-resolution.json',{});
 if(published)set('epg/published-generation.json',{phase:'published',programmeRunId:published});
 if(remaining!==null)set('epg/resolver-continuation.json',{stage:'paused',reason,at:iso,hopId:null,remainingChunks:remaining,nextCatchUpAt:null,retryAt:null,programmeRunId});
 if(context.DiscoveryAuthority)armDiscoveryAuthority(published||null);
 if(context.PublishedEpg)armPublishedEpg(published||null);
}
const sleeps=[];
const step={
 async do(name,fn){try{return await fn();}catch(error){step.retried++;return fn();}},
 async sleepUntil(name,date){sleeps.push(date.toISOString());if(date.getTime()-Date.now()>5000)throw new Error('long-sleep');}
};
step.retried=0;

// Instrumented runs: the direct chunk path and the Workflow loop are recorded SEPARATELY (the recorder is cleared between them), each run
// must write and make progress on its own, and each receipt is classified on its own. One receipt must never carry the other.
function workflowEnv(mode){return {...env,DISCOVERY_EXECUTOR:mode};}
let receipt=new Set();
const realPut=bucket.put.bind(bucket);
bucket.put=async(key,value,options)=>{receipt.add(key);return realPut(key,value,options);};
if(typeof bucket.delete!=='function')bucket.delete=async key=>{receipt.add('delete:'+key);records.delete(key);};
async function drainChunks(environment){let guard=0;while(guard++<8){const outcome=await call('advanceDiscovery')(environment,{});if(outcome.discovery.nextAction==='stop')break;}}
const decidedCount=()=>Object.keys(records.get('epg/discovery-resolution.json')||{}).length;
context.advanceDiscovery=realAdvance;

// Receipt 1: the real resolver chunk (direct advanceDiscovery calls).
receipt=new Set();
seed({count:60});
await drainChunks(workflowEnv('workflow'));
const chunkReceipt=new Set(receipt);
assert.ok(chunkReceipt.has('epg/discovery-resolution.json'),'the direct chunk wrote the decisions to R2 (the recorder works)');
assert.ok(chunkReceipt.has('epg/discovery-status.json'),'the direct chunk wrote its status');
assert.equal(decidedCount(),60,'the direct chunk made full progress');

// Receipt 2: the real Workflow loop, from a cleared recorder and a freshly seeded ledger.
receipt=new Set();
seed({count:60});
assert.equal(receipt.size,0,'the second recorder starts empty');
Object.assign(env,workflowEnv('workflow'));
elect();
const drained=await call('runDiscoveryWorkflow')(env,{programmeRunId:GENERATION,series:0},step);
assert.equal(drained.reason,'complete');
const workflowReceipt=new Set(receipt);
assert.ok(workflowReceipt.has('epg/discovery-resolution.json'),'the Workflow loop wrote the decisions on its own');
assert.ok(workflowReceipt.has('epg/discovery-workflow.json'),'the Workflow loop wrote its own state');
assert.equal(decidedCount(),60,'the Workflow loop made full progress');

// Each receipt is classified on its own: every key is one the classification knows, none is a non-Discovery projector input.
const KNOWN=[/^epg\/discovery-resolution\.json$/,/^epg\/discovery-status\.json$/,/^epg\/discovery-score-preview\.json$/,/^epg\/discovered-films\.json$/,/^epg\/resolver-lease\.json$/,/^epg\/resolver-continuation\.json$/,/^epg\/resolver-continuation-diagnostics\.json$/,/^epg\/discovery-workflow\.json$/,/^epg\/discovery-observations\//,/^epg\/discovery-index\//,/^epg\/generations\/[^/]+\/discovered-films\.json$/,/^epg\/generations\/[^/]+\/programme\.json$/,/^programme\.json$/];
const projectorInputs=['metadata.json','titles.json','people.json','watchlist.json','letterboxd/diary/history.json','enrichment/view-index.json','letterboxd/admissions/verified-films.json','admin/owner-reviews.json'];
for(const [label,keys] of [['direct chunk',chunkReceipt],['Workflow loop',workflowReceipt]]){
 const unknown=[...keys].filter(key=>!KNOWN.some(re=>re.test(key)));
 assert.deepEqual(unknown,[],label+': R2 keys written that the classification does not know: '+unknown.join(', '));
 for(const key of keys)assert.equal(projectorInputs.includes(key.replace(/^delete:/,'')),false,label+' wrote the projector input '+key);
}
console.log('Projector window R2 instrumented runs: direct chunk '+[...chunkReceipt].sort().join(', ')+'; Workflow loop '+[...workflowReceipt].sort().join(', ')+'; each receipt separate, known, and none a non-Discovery projector input');
