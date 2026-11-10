// AIR-417. A failed start answers 502 storage_error as before, and writes one sanitized log line that names the stage, the error code and the guard.
// The Worker runs in a vm on a memory R2; faults are injected per key to reach each stage of start up to the first next.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0;
const faults={get:new Map(),put:new Map()};
const logs=[];const reads=new Map();
// A fault fires once, after `skip` earlier matching calls: the failure being modelled is one failed call, and the stop that follows must be able to read and write.
const fail=(map,key)=>{for(const [match,fault] of map)if(key.startsWith(match)||key.includes(match)){const spec=typeof fault==='function'?{error:fault,skip:0}:fault;if(spec.skip>0){spec.skip--;continue;}map.delete(match);throw spec.error();}};
const env={BUCKET:{async get(key){reads.set(key,(reads.get(key)||0)+1);fail(faults.get,key);return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null},async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;fail(faults.put,key);records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)}},list:async()=>({objects:[],truncated:false})}};
const capture={log:()=>{},info:()=>{},error:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;
async function api(path,body){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()}}
const now=Date.now(),film=(id,start)=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start}]});
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});
records.set('sync.json',{runId:'test',stage:'complete'});
const catalog={};for(let i=1;i<=20;i++)catalog['tmdb_'+i]=film('tmdb_'+i,now);
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);
const START={scope:'watchlist_all',capacity:{remainingPercent:100}};
const leaseExpired=()=>{const lease=records.get('enrichment/runner-lease.json');return !lease||lease.expiresAt<=Date.now()||lease.expiresAt===0;};
const resetLease=()=>{const lease=records.get('enrichment/runner-lease.json');if(lease)lease.expiresAt=0;const writer=records.get('enrichment/writer-lease.json');if(writer)writer.expiresAt=0;};
const lines=()=>logs.filter(l=>l.includes('prediction_boundary_failed')).map(l=>JSON.parse(l));

// 1. Every stage that can fail before the first next reports its own name; the answer is the old 502 storage_error.
const stages=[
 // The first read of the lease belongs to the checkpoint that precedes the boundary; the second is settlePreviousRun's.
 {stage:'settle_previous',arm:()=>faults.get.set('enrichment/runner-lease.json',{skip:1,error:()=>new Error('D1_ERROR: lease read tmdb_7')})},
 {stage:'runner_lease',arm:()=>faults.put.set('enrichment/runner-lease.json',()=>new Error('lease write'))},
 {stage:'writer_lease',arm:()=>faults.put.set('enrichment/writer-lease.json',()=>new Error('writer write'))},
 {stage:'queue_refresh',arm:()=>faults.get.set('enrichment/view-index.json',()=>Object.assign(new Error('SECRET payload tmdb_3'),{code:'prediction_domain_budget',guard:'overlay_rows'})),code:'prediction_domain_budget',guard:'overlay_rows'},
 {stage:'film_state',arm:()=>faults.get.set('enrichment/films/',()=>new Error('film read tmdb_5'))},
 {stage:'run_save',arm:()=>faults.put.set('enrichment/runs/',()=>new Error('run write'))},
];
for(const {stage,arm,code,guard} of stages){
 resetLease();faults.get.clear();faults.put.clear();logs.length=0;arm();
 const before=new Set(records.keys());
 const result=await api('start',START);
 faults.get.clear();faults.put.clear();
 assert.equal(result.status,502,stage);
 assert.equal(result.data.error,'storage_error',stage);
 const found=lines();
 assert.equal(found.length,1,stage+': one line per failure, got '+JSON.stringify(logs));
 assert.equal(found[0].event,'prediction_boundary_failed');
 assert.equal(found[0].boundary,'start');
 assert.equal(found[0].stage,stage,stage);
 assert.equal(found[0].code,code||'unknown',stage);
 assert.equal(found[0].guard??null,guard??null,stage);
 assert.equal(typeof found[0].requestId,'string');
 const text=JSON.stringify(logs);
 for(const leak of ['SECRET','tmdb_','payload','lease read','D1_ERROR','stack'])assert.ok(!text.includes(leak),stage+' log leaks '+leak);
 // The lease semantics are those of before: a start that failed inside the writer released the runner lease.
 if(['queue_refresh','film_state','run_save'].includes(stage))assert.ok(leaseExpired(),stage+': runner lease released');
}

// 2. A start that works logs no failure, and runs through to its first next with no data loss.
resetLease();faults.get.clear();faults.put.clear();logs.length=0;
const queueBefore=records.get('enrichment/prediction-queue.json');
reads.clear();
const ok=await api('start',START);
const startReads=new Map(reads);
assert.equal(ok.status,200);assert.equal(ok.data.status,'running');
assert.equal(lines().length,0,'a good start writes no failure line');
const first=await api('next',{runId:ok.data.runId,batchSize:5});
assert.equal(first.status,200);assert.ok(first.data.items.length>0,'the first next returns films');
assert.equal(records.get('enrichment/prediction-queue.json').pending.length,20);
assert.ok(!queueBefore||queueBefore.pending.length>=0);

// 3. The log line is bounded: an error with an unsafe code or guard is reported as unknown, never echoed.
resetLease();faults.get.clear();faults.put.clear();logs.length=0;
await api('complete',{runId:ok.data.runId,reason:'quota'}).catch(()=>{});resetLease();
faults.get.set('enrichment/view-index.json',()=>Object.assign(new Error('x'),{code:'DROP TABLE; tmdb_1',guard:'a b'}));
const unsafe=await api('start',START);faults.get.clear();
assert.equal(unsafe.status,502);
const line=lines().at(-1);
assert.equal(line.code,'unknown');assert.equal(line.guard,null);
assert.ok(!JSON.stringify(logs).includes('DROP TABLE'));

// 4. One start reads each large input once: the catalog, the view index and the programme of the rebuild are reused for the batch
//    selection and for the start event, instead of being read three times (the production start died with exceededMemory after its run was saved).
assert.equal(startReads.get('epg/discovered-films.json'),1,'catalog reads '+startReads.get('epg/discovered-films.json'));
assert.equal(startReads.get('enrichment/view-index.json')||0,1,'view index reads '+startReads.get('enrichment/view-index.json'));
assert.ok((startReads.get('programme.json')||0)<=1,'programme reads '+startReads.get('programme.json'));
// The start event carries the same snapshot a fresh read computes.
const startRecord=[...records.values()].find(value=>(value?.event?.id||value?.id)==='prediction-start-'+ok.data.runId),startEvent=startRecord?.event||startRecord;
assert.ok(startEvent,'the start event was written');
ctx.snapshotQueue=records.get('enrichment/prediction-queue.json');
const fresh=JSON.parse(JSON.stringify(await vm.runInContext('predictionEventSnapshot(env,snapshotQueue,'+startEvent.currentBatchSize+')',ctx)));
assert.deepEqual(JSON.parse(JSON.stringify(startEvent.snapshot)),fresh,'reused inputs give the snapshot of a fresh read');
// The answer of a start is small and plain JSON: a run id, counters and the runner contract, never the queue, the index or film metadata.
const answer=JSON.stringify(ok.data);
assert.ok(answer.length<8000,'start answer is '+answer.length+' characters');
assert.match(ok.data.runId,/^[A-Za-z0-9_-]{1,100}$/);
for(const key of ['pending','priority','work','films','index','catalog'])assert.ok(!Object.hasOwn(ok.data,key),'start answer carries '+key);

// 5. A catalog that an EPG publication holds is a wait, not a storage failure (production: stage queue_refresh, code discovery_fence during a seal).
{
 await api('complete',{runId:ok.data.runId,reason:'quota'}).catch(()=>{});resetLease();faults.get.clear();faults.put.clear();
 const eventKeys=()=>[...records.keys()].filter(key=>key.startsWith('events/')||key.includes('stop-events/')).sort();
 for(const cause of ['discovery_fence','discovery_incomplete']){
  resetLease();logs.length=0;const before=eventKeys(),queueWas=JSON.stringify(records.get('enrichment/prediction-queue.json'));
  faults.get.set('epg/discovered-films.json',()=>Object.assign(new Error(cause),{code:cause}));
  const held=await api('start',START);faults.get.clear();
  assert.equal(held.status,503,cause);
  assert.equal(held.data.status,'blocked');assert.equal(held.data.reason,'catalog_held');assert.equal(held.data.code,'prediction_catalog_held');assert.equal(held.data.cause,cause);
  assert.ok(!held.data.error,'not a storage_error');
  assert.ok(leaseExpired(),cause+': the runner lease is released');
  assert.deepEqual(eventKeys(),before,cause+': no stop Event is written');
  assert.equal(JSON.stringify(records.get('enrichment/prediction-queue.json')),queueWas,cause+': the queue, its pending and retries are untouched');
  const found=lines();assert.equal(found.length,1);assert.equal(found[0].stage,'queue_refresh');assert.equal(found[0].code,cause);
 }
 // Any other failure of the rebuild is still 502 storage_error.
 resetLease();faults.get.set('epg/discovered-films.json',()=>Object.assign(new Error('x'),{code:'discovery_unavailable'}));
 const other=await api('start',START);faults.get.clear();
 assert.equal(other.status,502);assert.equal(other.data.error,'storage_error');
 // The gate is checked before the lease: a held or loading authority answers the wait without taking the runner lease or reading the catalog.
 for(const [gate,cause] of [[{held:true,ready:true,transfer:'idle'},'discovery_fence'],[{held:false,ready:true,transfer:'loading'},'discovery_incomplete']]){
  resetLease();logs.length=0;reads.clear();const leaseWas=JSON.stringify(records.get('enrichment/runner-lease.json'));
  ctx.heldGate=gate;vm.runInContext('globalThis.DiscoveryAuthority={readAuthority:async()=>heldGate,routeRead:async()=>({handled:false}),routeWrite:async()=>({handled:false}),ownsKey:()=>false}',ctx);
  let gated;try{gated=await api('start',START);}finally{vm.runInContext('delete globalThis.DiscoveryAuthority',ctx);}
  assert.equal(gated.status,503,cause);assert.equal(gated.data.code,'prediction_catalog_held');assert.equal(gated.data.cause,cause);
  assert.equal(JSON.stringify(records.get('enrichment/runner-lease.json')),leaseWas,cause+': no lease was taken');
  assert.ok(!reads.get('epg/discovered-films.json'),cause+': the catalog was not read');
  assert.equal(lines().length,0);
 }
 // After the publication: the next start rebuilds the queue on the new generation and runs through its first next, nothing lost.
 resetLease();logs.length=0;
 const retried='tmdb_3';const queue=records.get('enrichment/prediction-queue.json');queue.retries={[retried]:{kind:'parse_error',retryable:true,attempts:1,retryAt:1,failedAt:'2026-11-10T00:00:00.000Z',lastRunId:'r'}};
 records.set('programme.json',{runId:'next-generation',films:[]});records.set('sync.json',{runId:'next-generation',stage:'complete'});
 const after=await api('start',START);
 assert.equal(after.status,200);assert.equal(after.data.status,'running');
 const rebuilt=records.get('enrichment/prediction-queue.json');
 assert.equal(rebuilt.programmeRunId,'next-generation');assert.equal(rebuilt.pending.length,20);assert.equal(rebuilt.retries[retried].attempts,1,'the retry record survived the wait and the generation change');
 const nextAfter=await api('next',{runId:after.data.runId,batchSize:3});assert.equal(nextAfter.status,200);assert.ok(nextAfter.data.items.length>0);
}

console.log('prediction start diagnostics tests passed');
