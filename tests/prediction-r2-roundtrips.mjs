// AIR-442. R2 round trips of a prediction `next` and `submit`. One request reads the objects it needs once and writes each only when it changes: the run record, its
// diagnostics row and `latest-run.json` come from the request's own scope, a write of identical bytes is not repeated, the view index of one film is read and written once,
// and the queue mutation starts from the head the step already read. Nothing is shared across requests; every fence is unchanged. The Worker runs in a vm on an in-memory R2
// that counts every call by the class of the key. Local stand-ins only: no model, no production read or write.
//
// Counts on the same fixture before this change (main at 09d6113), steady state, one film per step: next 55 R2 calls, submit 41; in a run's first next 55, submit 41.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,trace=null,beforePut=null,failPut=null;
const rec=(op,key)=>{if(trace)trace.push({op,key});};
const env={BUCKET:{
 async get(key){rec('GET',key);return records.has(key)?{etag:etags.get(key),size:JSON.stringify(records.get(key)).length,json:async()=>structuredClone(records.get(key))}:null;},
 async head(key){rec('HEAD',key);return records.has(key)?{etag:etags.get(key)}:null;},
 async put(key,value,options={}){
  rec('PUT',key);
  if(beforePut&&beforePut.match(key,value)){const hook=beforePut;beforePut=null;await hook.run();}
  if(failPut&&failPut.match(key)){const hook=failPut;failPut=null;throw new Error(hook.message||'R2 put failed');}
  const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async delete(key){rec('DEL',key);records.delete(key);},
 async list(options){rec('LIST',options?.prefix||'');return {objects:[...records.keys()].filter(key=>!options?.prefix||key.startsWith(options.prefix)).map(key=>({key})),truncated:false};},
}};
const logs=[];const capture={log:()=>{},info:()=>{},error:(...a)=>logs.push(a.join(' ')),warn:(...a)=>logs.push(a.join(' '))};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:capture,setTimeout});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const f of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(f,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;
const api=async(path,body)=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()};};
const measured=async work=>{trace=[];try{const value=await work();return {value,calls:trace};}finally{trace=null;}};
const now=Date.now(),film=(id,start)=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start}]});
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});
const catalog={};for(let i=1;i<=30;i++)catalog['tmdb_'+i]=film('tmdb_'+i,now);records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',catalog);
const EXECUTION=JSON.parse(JSON.stringify(vm.runInContext('EXECUTION',ctx)));const execution=Object.fromEntries(Object.entries(EXECUTION).map(([k,v])=>[k,v.includes('unknown')?'unknown':v[0]]));
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['heist','investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};

const klass=key=>key==='enrichment/view-index.json'?'view_index':/\/mood-facet\.json$/.test(key)?'mood_facet':key.startsWith('enrichment/runs/')?'run':key==='enrichment/latest-run.json'?'run_latest':key.startsWith('enrichment/run-diagnostics/')?'run_diag':key==='enrichment/prediction-queue.json'?'queue':key==='enrichment/runner-lease.json'?'lease_runner':key==='enrichment/writer-lease.json'?'lease_writer':/\/(fingerprint|predictions)\.json$/.test(key)?'film_state':key.startsWith('enrichment/films/')?'film_immutable':key.startsWith('enrichment/sources/')?'source':key==='enrichment/profile/current.json'?'profile':key==='programme.json'||key==='epg/published-generation.json'?'programme':'other';
const count=(calls,op,cls)=>calls.filter(call=>call.op===op&&klass(call.key)===cls).length;
const total=calls=>calls.length;

const start=await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(start.status,200,JSON.stringify(start.data).slice(0,200));
const runId=start.data.runId,runKey='enrichment/runs/'+runId+'.json';
const runRecord=()=>records.get(runKey);
const queue=()=>records.get('enrichment/prediction-queue.json');

// 1. Budgets. The first next of a run and a steady-state next, then the submit of one film (a new fingerprint and a new prediction).
const budgets=[];
for(let i=0;i<4;i++){
 const next=await measured(()=>api('next',{runId,batchSize:1}));
 assert.equal(next.value.status,200,JSON.stringify(next.value.data).slice(0,200));const id=next.value.data.items[0].filmId;
 const selected=runRecord().selectedIds.length;
 const submit=await measured(()=>api('submit',{runId,items:[{filmId:id,fingerprint,prediction}]}));
 assert.equal(submit.value.status,200);assert.equal(submit.value.data.results[0].status,'created');
 const n=next.calls,s=submit.calls;
 budgets.push({next:total(n),submit:total(s)});
 // next: every selected film's state read once (fingerprint + predictions); the run, its diagnostics row, the queue, the runner lease and the view index once each.
 assert.equal(count(n,'GET','film_state'),2*selected,'film state reads');
 assert.equal(count(n,'GET','run'),1,'run record read once');assert.equal(count(n,'GET','run_diag'),1,'diagnostics row read once');
 assert.equal(count(n,'GET','queue'),1,'queue read once');assert.equal(count(n,'GET','lease_runner'),1,'runner lease read once');assert.equal(count(n,'PUT','lease_runner'),1);
 assert.equal(count(n,'GET','view_index'),1,'view index read once');assert.equal(count(n,'PUT','view_index'),0,'next writes no view index');
 assert.equal(count(n,'GET','lease_writer'),2);assert.equal(count(n,'PUT','lease_writer'),2,'the writer lease is taken and released');
 assert.ok(count(n,'PUT','run')<=2&&count(n,'PUT','run_latest')<=2&&count(n,'PUT','run_diag')<=4);
 if(i>0)assert.ok(count(n,'PUT','run')<=1,'a steady-state next writes the run record once: the first save is identical to the stored record');
 // submit: one film.
 assert.equal(count(s,'GET','run'),1);assert.equal(count(s,'GET','run_diag'),1);assert.equal(count(s,'GET','queue'),1,'the queue is read once; the settlement starts from that head');assert.equal(count(s,'PUT','queue'),1);
 assert.equal(count(s,'GET','view_index'),1,'one film, one index read');assert.equal(count(s,'PUT','view_index'),1,'one film, one index write');assert.equal(count(s,'PUT','mood_facet'),1);
 assert.equal(count(s,'GET','film_state'),2);assert.equal(count(s,'PUT','run'),1);assert.equal(count(s,'PUT','run_latest'),1);
 assert.equal(count(s,'PUT','lease_runner'),2,'the lease is renewed at the start and after the film');assert.equal(count(s,'PUT','lease_writer'),2);
}
const steady=budgets.at(-1);
console.log('R2 calls per step, steady state: next',steady.next,'(before: 55) submit',steady.submit,'(before: 41)');
assert.ok(steady.next<=43,'next '+steady.next);assert.ok(steady.submit<=31,'submit '+steady.submit);

// 2. Immutable history and lineage: each submitted film has one fingerprint body, one generation record, one prediction version; none is written twice.
{
 for(const id of ['tmdb_1']){}
 const ids=runRecord().selectedIds.filter(id=>runRecord().results?.[id]==='created');
 assert.ok(ids.length>=4);
 for(const id of ids){
  const prefix='enrichment/films/'+id+'/';
  const bodies=[...records.keys()].filter(key=>key.startsWith(prefix+'fingerprints/')),generations=[...records.keys()].filter(key=>key.startsWith(prefix+'fingerprint-generations/')),versions=[...records.keys()].filter(key=>key.startsWith(prefix+'predictions/versions/'));
  assert.equal(bodies.length,1,id);assert.equal(generations.length,1,id);assert.equal(versions.length,1,id);
  const entry=records.get('enrichment/view-index.json')[id],bundle=records.get(prefix+'predictions.json'),fp=records.get(prefix+'fingerprint.json');
  assert.equal(bundle.history.length,0);assert.equal(bundle.current.fingerprintHash,fp.fingerprintHash);
  assert.equal(entry.fingerprintHash,fp.fingerprintHash);assert.equal(entry.prediction.generatedAt,bundle.current.generatedAt);
  assert.deepEqual(records.get(prefix+'mood-facet.json'),entry.moodFacet,'the mood facet file is the index entry\'s');
  assert.ok(entry.fingerprint&&entry.impactFeatures&&entry.moodFacet,'the entry carries what both writes used to put there');
  assert.ok(!queue().pending.includes(id)&&!queue().hotPending.includes(id),'the written film left the queue');
 }
}

// 3. Replay and unknown outcome: the same submit again is already_current, adds no version, and leaves the index as it is.
{
 const id=runRecord().selectedIds.find(i=>runRecord().results?.[i]==='created');
 const before=JSON.stringify(records.get('enrichment/view-index.json')[id]),versions=[...records.keys()].filter(key=>key.includes('/'+id+'/predictions/versions/')).length;
 const replay=await api('submit',{runId,items:[{filmId:id,fingerprint,prediction}]});
 assert.equal(replay.status,200);assert.equal(replay.data.results[0].status,'already_current');
 assert.equal([...records.keys()].filter(key=>key.includes('/'+id+'/predictions/versions/')).length,versions);
 assert.equal(JSON.stringify(records.get('enrichment/view-index.json')[id]),before);assert.equal(runRecord().results[id],'created','the first outcome is kept');
}

// 4. A partial failure: the fingerprint is written, the prediction is rejected. The index still carries the fingerprint facet exactly as it did when the fingerprint was indexed
//    on its own, the failure is recorded for retry, and the film is not marked predicted.
{
 const next=await api('next',{runId,batchSize:1});const id=next.data.items[0].filmId;
 const failed=await api('submit',{runId,items:[{filmId:id,fingerprint,prediction:{...prediction,predictedRating:'bad'}}]});
 assert.equal(failed.status,200);assert.equal(failed.data.results[0].status,'retryable_failure');assert.equal(failed.data.results[0].error,'parse_error');
 const entry=records.get('enrichment/view-index.json')[id];
 assert.ok(entry?.fingerprintHash&&entry.fingerprint&&entry.impactFeatures,'the fingerprint is indexed although the prediction was rejected');
 assert.equal(entry.prediction,undefined);assert.ok(entry.moodFacet&&records.get('enrichment/films/'+id+'/mood-facet.json'));
 assert.ok(records.get('enrichment/films/'+id+'/fingerprint.json').fingerprintHash===entry.fingerprintHash);
 assert.equal(records.has('enrichment/films/'+id+'/predictions.json'),false,'no prediction was stored');
 assert.ok(queue().retries[id]?.attempts>=1,'the retry is recorded in the queue');
}

// 6. A queue conflict between the step's read and its write: another writer commits first, the settlement is applied again on what that writer left and both survive.
{
 const next=await api('next',{runId,batchSize:1});const item=next.data.items?.[0];assert.ok(item,JSON.stringify(next.data).slice(0,200));
 const other='tmdb_other_retry';
 beforePut={match:(key,value)=>key==='enrichment/prediction-queue.json'&&JSON.parse(value).trigger==='batch_progress',run:async()=>{
  const q=structuredClone(records.get('enrichment/prediction-queue.json'));q.retries={...(q.retries||{}),[other]:{kind:'parse_error',retryable:true,attempts:1,retryAt:Date.now()+3600000,failedAt:new Date().toISOString(),lastRunId:'another-run'}};
  records.set('enrichment/prediction-queue.json',q);etags.set('enrichment/prediction-queue.json',String(++revision));}};
 const conflicted=await measured(()=>api('submit',{runId,items:[{filmId:item.filmId,fingerprint,prediction}]}));
 assert.equal(beforePut,null,'the conflict was forced');assert.equal(conflicted.value.status,200,JSON.stringify(conflicted.value.data).slice(0,200));assert.equal(conflicted.value.data.results[0].status,'created');
 assert.equal(count(conflicted.calls,'PUT','queue'),2,'one refused put and one that landed');assert.equal(count(conflicted.calls,'GET','queue'),2,'the retry read the queue afresh, not the head it started from');
 assert.ok(queue().retries[other],'the other writer\'s record survived');assert.ok(!queue().pending.includes(item.filmId)&&!queue().hotPending.includes(item.filmId),'and the film is settled in what it left');
}

// 7. Nothing outlives the request: an external change to the run record between two requests is read by the next one, and the shared environment carries no scope.
{
 assert.equal(Object.getOwnPropertySymbols(env).length,0,'the request scope is on the step\'s own copy of the environment');
 const stored=structuredClone(runRecord());stored.batchSize=3;records.set(runKey,stored);etags.set(runKey,String(++revision));
 const read=await measured(()=>api('next',{runId,batchSize:1}));
 assert.equal(read.value.status,200);assert.equal(count(read.calls,'GET','run'),1,'the run record is read from storage in every request');
 assert.equal(read.value.data.batchSize,runRecord().batchSize,'what the request answered is what it stored');
}

// 8. A writer that is busy: no fence is bypassed and nothing mutable is written; a changed profile ends the run's step before any queue or film write.
{
 records.set('enrichment/writer-lease.json',{id:'other-writer',expiresAt:Date.now()+60000});etags.set('enrichment/writer-lease.json',String(++revision));
 const busy=await measured(()=>api('next',{runId,batchSize:1}));
 assert.equal(busy.value.status,409);assert.equal(busy.value.data.reason,'prediction_writer_busy');
 for(const cls of ['queue','view_index','film_state','film_immutable','mood_facet','run','run_latest','lease_runner','lease_writer'])assert.equal(count(busy.calls,'PUT',cls),0,'busy writer: no put to '+cls);
 records.set('enrichment/writer-lease.json',{id:'other-writer',expiresAt:0});etags.set('enrichment/writer-lease.json',String(++revision));
 const profile=structuredClone(records.get('enrichment/profile/current.json'));records.set('enrichment/profile/current.json',{...profile,profileHash:'changed'});
 const stale=await measured(()=>api('next',{runId,batchSize:1}));
 assert.equal(stale.value.status,409);assert.match(stale.value.data.error,/Profile changed/);
 for(const cls of ['queue','view_index','film_state','film_immutable'])assert.equal(count(stale.calls,'PUT',cls),0,'stale profile: no put to '+cls);
 records.set('enrichment/profile/current.json',profile);
}

// 9. A write that fails after the prediction was stored (the index put): nothing is lost or written twice. The run stops on the storage error as before; the next run finds the
//    film current, repairs its index entry from the stored prediction, and the immutable version exists once.
{
 const resetLeases=()=>{for(const key of ['enrichment/runner-lease.json','enrichment/writer-lease.json']){const lease=records.get(key);if(lease){records.set(key,{...lease,expiresAt:0});etags.set(key,String(++revision));}}};
 resetLeases();
 const first=await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(first.status,200,JSON.stringify(first.data).slice(0,200));
 const run9=first.data.runId,item=(await api('next',{runId:run9,batchSize:1})).data.items[0];
 failPut={match:key=>key==='enrichment/view-index.json',message:'R2 put failed after the prediction was stored'};
 const lost=await api('submit',{runId:run9,items:[{filmId:item.filmId,fingerprint,prediction}]});
 assert.equal(failPut,null,'the failure was injected');assert.equal(lost.status,200);assert.equal(lost.data.results[0].status,'failed');assert.equal(lost.data.mustComplete,true);
 const versions=()=>[...records.keys()].filter(key=>key.includes('/'+item.filmId+'/predictions/versions/')).length;
 assert.equal(versions(),1,'the prediction version was stored once');assert.ok(records.has('enrichment/films/'+item.filmId+'/predictions.json'));
 assert.equal(records.get('enrichment/view-index.json')[item.filmId]?.prediction,undefined,'the index lacks the prediction the failed write was to add');
 resetLeases();
 const second=await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(second.status,200,JSON.stringify(second.data).slice(0,200));
 const deferred=await api('next',{runId:second.data.runId,batchSize:12});assert.equal(deferred.status,200);
 assert.ok(queue().retries[item.filmId]?.retryAt>Date.now(),'the storage failure put the film into retry backoff');
 assert.ok(!deferred.data.items.some(entry=>entry.filmId===item.filmId),'a film in backoff is not offered');
 // The backoff is over: the next run selects the film, finds its stored prediction current and repairs the index entry from it; no second version.
 const q=structuredClone(queue());q.retries[item.filmId].retryAt=0;records.set('enrichment/prediction-queue.json',q);etags.set('enrichment/prediction-queue.json',String(++revision));
 resetLeases();
 const third=await api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(third.status,200,JSON.stringify(third.data).slice(0,200));
 assert.ok(records.get('enrichment/runs/'+third.data.runId+'.json').selectedIds.includes(item.filmId),'the film is selected again');
 const repaired=await api('next',{runId:third.data.runId,batchSize:12});assert.equal(repaired.status,200);
 assert.ok(!repaired.data.items.some(entry=>entry.filmId===item.filmId),'the stored prediction is current: the film is not offered again');
 assert.ok(records.get('enrichment/view-index.json')[item.filmId]?.prediction,'the index entry was repaired from the stored prediction');
 assert.equal(versions(),1,'and no second version was written');
}

console.log('prediction R2 roundtrip tests passed');
