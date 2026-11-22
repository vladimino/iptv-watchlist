// ADR 0197: recovery slots in the ordinary batch v2 manifest. Pure rules first (the slot formula, candidate order and the diagnostic
// counts), then the real Worker code over the D1 stand-in with owner-confirmed intents (ADR 0165): hot flood plus cold recovery, hot
// recovery, several cohorts, no intent, fewer candidates than slots, more than the quota, backoff/exhausted/expired/cancelled/satisfied,
// pinned and dry-run calls, a failing recovery store, and an unchanged stored queue and immutable history. Nothing here calls a model, TMDB,
// Cloudflare or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import * as Intent from '../src/prediction-recovery-intent.js';
import * as FilmPersonAuthority from '../src/film-person-authority.js';
import * as CanonicalCatalogReader from '../src/canonical-catalog-reader.js';

const T='2026-11-17T10:00:00.000Z';
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1";
const COLD=8,FILMS=24,FLOOD=12,FAR=Date.now()+30*864e5;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// tmdb_1..8 are cold (their showings are 30 days away), tmdb_9..22 hot; tmdb_23 has a conflicting claim and tmdb_24 is retired (never used here).
async function world(){
 const w=await flowWorld({films:FILMS,extra:n=>n<=COLD?{shows:[{start:FAR}]}:{}});
 Object.assign(w.ctx,{PredictionRecoveryIntent:Intent,FilmPersonAuthority,CanonicalCatalogReader,Headers,Uint32Array,DataView,atob,btoa,structuredClone,TextDecoder,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[]});
 for(const [file,name] of [['src/domain/admin-query.js','AdminQuery'],['src/domain/data-health.js','DataHealth'],['src/domain/limbo-inventory.js','LimboInventory'],['src/domain/prediction-recovery.js','PredictionRecovery']])vm.runInContext(scoped(file,name),w.ctx);
 for(const file of ['src/admin/owner-reviews.js','src/admin/read.js','src/admin/limbo.js','src/prediction-diagnostics.js','src/admin/prediction-recovery.js','src/admin/prediction-recovery-intent.js'])vm.runInContext(fs.readFileSync(file,'utf8'),w.ctx);
 sql(w.file,VERIFY);
 sql(w.file,"UPDATE prediction_domain_authority SET writes='held' WHERE id=1");
 const ids=Array.from({length:FILMS},(_,i)=>i+1);
 sql(w.file,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+ids.map(n=>`('film:tmdb:${n}',1,'tmdb:${n}','Orig','${T}')`).join(','));
 sql(w.file,'INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES '+ids.map(n=>`('film:tmdb:${n}','tmdb','${n}',1,0,NULL)`).join(','));
 w.admin=async(path,{method='GET',body=null}={})=>{
  const headers={'Content-Type':'application/json'};
  if(method==='POST')Object.assign(headers,{Origin:'https://site.example','Cf-Access-Jwt-Assertion':'jwt','X-IPTV-Admin-Action':'prediction_recovery_intent'});
  const r=await w.ctx.worker.fetch(new Request('https://site.example/api/admin/prediction-recovery-intent/'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})}),w.env);
  return {status:r.status,data:await r.json()};
 };
 return w;
}
const startBody=extra=>({scope:'watchlist_all',mode:'queued',trigger:'scheduled',...extra});
const start=async(w,size,extra={})=>{const r=await w.api('batch/start',startBody({manifestSize:size,...extra}));assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r.data;};
const submitAll=async(w,m)=>{ // a submit carries at most 10 items
 const results=[];
 for(let at=0;at<m.films.length;at+=10){
  const r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:m.films.slice(at,at+10).map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}))});
  assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));results.push(...r.data.results);
 }
 return {results};
};
const complete=async(w,m,reason)=>{const r=await w.api('complete',{runId:m.runId,...(reason?{reason}:{})});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));};
const queueDoc=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const writeQueue=(w,q)=>{const text=JSON.stringify(q);sql(w.file,'DELETE FROM prediction_queue');sql(w.file,"INSERT INTO prediction_queue (seq,chunk_text,generation) VALUES (0,'"+text.replace(/'/g,"''")+"',"+sql(w.file,'SELECT queue_generation AS g FROM prediction_domain_authority')[0].g+")");};
const key=n=>'slots-key-'+String(n).padStart(8,'0');
const ids=m=>m.films.map(f=>f.filmId);
const n=list=>list.map(i=>'tmdb_'+i);
// The ordinary runner scores every admitted film (hot first: the cold films follow once no hot film is left).
async function scoreAll(w){
 for(let round=0;round<6;round++){
  const r=await w.api('batch/start',startBody({manifestSize:100}));
  if(r.data.status!=='running')break;
  await submitAll(w,r.data);await complete(w,r.data,'manifest_spent');
 }
 assert.deepEqual([...queueDoc(w).hotPending,...queueDoc(w).coldPending],[],'every admitted film is current');
}
// Every film scored once by the ordinary runner, then FLOOD hot films that were never predicted (they would fill every ordinary slot).
async function floodedWorld(){
 const w=await world();
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 await scoreAll(w);
 const now=Date.now(),film=k=>({id:'tmdb_'+k,title:'tmdb_'+k,original:'tmdb_'+k,year:2020,tmdbId:String(k),canonicalIdentity:'tmdb:'+k,genres:[],actors:[],directors:[],shows:[{start:now}]});
 for(let k=101;k<=100+FLOOD;k++)sql(w.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_"+k+"','"+k+"','movie','tmdb:"+k+"','tmdb_"+k+"','p1',1,'current','"+JSON.stringify(film(k))+"')");
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 return w;
}
let keys=0;
// A confirmation moves the recovery revision, so the stored queue is stale until it is rebuilt; `reconcile` rebuilds it (a dry run never does).
async function confirm(w,films,{mode='prediction_only',ttlHours=72,reconcile=true}={}){
 const p=await w.admin('preview?films='+films.join(',')+'&mode='+mode+'&ttlHours='+ttlHours);
 assert.equal(p.status,200,JSON.stringify(p.data));
 const r=await w.admin('confirm',{method:'POST',body:{films,mode,ttlHours,scopeHash:p.data.scopeHash,idempotencyKey:key(++keys)}});
 assert.equal(r.status,201,JSON.stringify(r.data));
 if(reconcile)assert.equal((await w.api('queue/reconcile',{})).status,200);
 return r.data.receipt;
}

// 1. Pure rules. The slot formula: N>=2 gives max(1,floor(N*0.4)), N=1 keeps the ordinary policy, never more than N.
{
 const w=await flowWorld({films:2});
 const slots=vm.runInContext('recoveryBatchSlots',w.ctx);
 assert.equal(vm.runInContext('RECOVERY_BATCH_SHARE',w.ctx),0.4);
 const table={1:0,2:1,3:1,4:1,5:2,6:2,7:2,8:3,9:3,10:4,15:6,20:8,25:10,35:14,100:40};
 for(const [size,expected] of Object.entries(table))assert.equal(slots(Number(size)),expected,'N='+size);
 assert.deepEqual([5,7,10,15,20].map(size=>[slots(size),size-slots(size)]),[[2,3],[2,5],[4,6],[6,9],[8,12]],'S5 2+3, S7 2+5, S10 4+6, S15 6+9, S20 8+12');
 for(let size=0;size<=100;size++)assert.ok(slots(size)<=size&&slots(size)>=0&&(size<2?slots(size)===0:slots(size)>=1&&slots(size)<=Math.max(1,Math.floor(size*0.4))));
 for(const bad of [0,-1,1.5,NaN,undefined,null,'5'])assert.equal(slots(bad),0,'an unusable size has no recovery slots: '+String(bad));

 // Candidate order, eligibility and counts, from a hand-built queue and overlay.
 const plain=value=>JSON.parse(JSON.stringify(value)),candidatesIn=vm.runInContext('queueRecoveryCandidates',w.ctx),candidates=(...args)=>plain(candidatesIn(...args));
 const overlay=(active,confirmed={})=>({activeIds:()=>active,confirmedAtOf:id=>confirmed[id]??null});
 const intent={reason:'recovery_intent'};
 const queue={hotPending:['h1','h2','h3'],coldPending:['c1','c2','c3','c4'],priority:{h1:{hot:true},h2:{hot:true},h3:{hot:true},c1:{hot:false},c2:{hot:false},c3:{hot:false},c4:{hot:false}},
  work:{h1:intent,h2:intent,h3:intent,c1:intent,c2:intent,c3:intent,c4:intent,x:intent},
  retries:{c2:{attempts:10,retryAt:0},c3:{attempts:1,retryAt:Date.now()+3600e3}}};
 const c=candidates(queue,overlay(['c4','c1','h2','c2','c3','h1','gone','x'],{c4:'2026-11-18T10:00:00.000Z',c1:'2026-11-19T10:00:00.000Z',h2:'2026-11-19T10:00:00.000Z',h1:'2026-11-19T10:00:00.000Z'}),Date.now(),new Set());
 // Oldest cohort first (c4); the same cohort time orders by the stored queue position (hot lane, then cold lane): h1, h2, c1.
 assert.deepEqual(c.ids,['c4','h1','h2','c1']);
 assert.deepEqual(c.counts,{active:8,eligible:{hot:2,cold:2},deferredByRetry:1,retryExhausted:1,notQueued:2},'gone and x are not in either queue lane');
 assert.deepEqual(candidates(queue,overlay(['c1','h1']),Date.now(),new Set(['h1'])).ids,['c1'],'an excluded (staged) film is not a candidate and is not counted');
 assert.deepEqual(candidates(queue,overlay(['h2','h1'])).ids,['h1','h2'],'no confirmation time: queue position, then film id');
 assert.deepEqual(candidates({...queue,hotPending:['h2','h1']},overlay(['h1','h2'],{h1:'x',h2:'x'})).ids,['h2','h1']);
 assert.deepEqual(candidates(queue,{activeIds:()=>[],confirmedAtOf:()=>null}).ids,[]);
 assert.deepEqual(candidates(queue,undefined).counts.active,0,'an absent overlay is no candidate');
 // The migration share (ADR 0035) is computed on the slots the ordinary queue is left with; a recovery film carries no migration work.
 const batchIdsIn=vm.runInContext('queueBatchIds',w.ctx),batchIds=(...args)=>plain(batchIdsIn(...args));
 const mq={work:{a:{migration:'x'},b:{migration:'x'},c:{migration:'x'},d:{},e:{}}};
 assert.deepEqual(batchIds(mq,['a','b','c','d','e'],5),['a','b','c','d','e'],'5 ordinary slots: ceil(5*.5)=3 migration films fit');
 assert.deepEqual(batchIds(mq,['a','b','c','d','e'],3),['a','b','d'],'3 ordinary slots (N=5 minus 2 recovery): ceil(3*.5)=2 migration films, the third is held back');
}

// 2. Hot flood plus cold recovery: the cold recovery films take their slots; the ordinary queue keeps the rest, hot-first.
{
 const w=await floodedWorld();
 const receipt=await confirm(w,n([1,2,3,4,5,6,7,8]),{reconcile:false});
 assert.equal(receipt.films.length,8);
 // The queue was built under the old recovery revision: a dry run refuses to preview a stale manifest, and never rebuilds.
 const stale=await w.api('batch/start',startBody({manifestSize:5,dryRun:true}));
 assert.deepEqual([stale.status,stale.data.reason,stale.data.cause],[409,'queue_stale','recovery_changed']);
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const baseline=await start(w,5,{dryRun:true});
 const before=queueDoc(w);
 assert.equal(queueDoc(w).recoveryRevision,1);
 assert.deepEqual(baseline.recovery,{target:2,selected:2,ordinary:3,active:8,eligible:{hot:0,cold:8},deferredByRetry:0,retryExhausted:0,notQueued:0,noCandidates:false});
 const m=await start(w,5);
 assert.deepEqual(ids(m).slice(0,2).sort(),n([1,2]).sort(),'the two recovery slots go to the cold cohort films');
 assert.deepEqual(m.films.slice(0,2).map(f=>f.lane),['cold','cold'],'the true lane is kept');
 assert.ok(m.films.slice(2).every(f=>f.lane==='hot'&&Number(f.filmId.slice(5))>100),'the other three slots are the ordinary hot-first never-predicted films');
 assert.deepEqual(ids(baseline),ids(m),'a dry run shows exactly the manifest the real start takes');
 assert.equal(m.manifestSize,5);assert.equal(m.filmsSelected,5);
 assert.equal(m.recovery.selected,2);assert.equal(m.recovery.ordinary,3);
 assert.ok(!JSON.stringify(m.recovery).includes('tmdb_'),'diagnostics are counts only, never a film id');
 // Selection changes no stored queue field: lane membership, priority and work are the rebuilt queue's own.
 const after=queueDoc(w);
 for(const field of ['hotPending','coldPending','priority','work','retries'])assert.deepEqual(after[field],before[field],field+' unchanged by the selection');
 // The ordinary runner commits them; nothing outside the manifest is touched; the replaced versions stay in the lineage.
 const lineage=()=>sql(w.file,'SELECT film_id,r2_key FROM prediction_lineage ORDER BY film_id,replaced_at');
 const history=lineage(),pointers=sql(w.file,'SELECT film_id,display_json FROM prediction_pointer ORDER BY film_id');
 const submitted=await submitAll(w,m);
 assert.deepEqual(submitted.results.filter(r=>r.filmId.startsWith('tmdb_')&&Number(r.filmId.slice(5))<=8).map(r=>r.status),['recalculated','recalculated']);
 await complete(w,m,'manifest_spent');
 const touched=new Set(ids(m)),pointersAfter=sql(w.file,'SELECT film_id,display_json FROM prediction_pointer ORDER BY film_id');
 for(const row of pointers)if(!touched.has(row.film_id))assert.equal(pointersAfter.find(r=>r.film_id===row.film_id).display_json,row.display_json,row.film_id+': no off-manifest pointer moved');
 for(const row of history)assert.ok(lineage().some(h=>h.r2_key===row.r2_key),'immutable history is kept');
 assert.equal(lineage().length,history.length+2,'exactly the two recovered films were replaced');
 // The next manifest moves on to the next two cohort films (the satisfied ones left the queue), with the same quota.
 const next=await start(w,5);
 assert.deepEqual(ids(next).slice(0,2).sort(),n([3,4]).sort());
 assert.deepEqual([next.recovery.active,next.recovery.notQueued,next.recovery.eligible.cold],[8,2,6],'the two satisfied intents stay active rows (they end themselves without a write) but left the queue: counted notQueued, never eligible');
}

// 3. The quota table over a flood: S5, S7, S10, S15 and S20 (dry runs; nothing is written), N=1 and N=2.
{
 const w=await floodedWorld();
 await confirm(w,n([1,2,3,4,5,6,7,8]));
 for(const [size,slots] of [[5,2],[7,2],[10,4],[15,6],[20,8]]){
  const m=await start(w,size,{dryRun:true});
  const recovery=m.films.filter(f=>f.lane==='cold');
  assert.equal(m.films.length,size,'S'+size);assert.equal(recovery.length,slots,'S'+size+' recovery slots');assert.equal(m.films.length-recovery.length,size-slots,'S'+size+' ordinary slots');
  assert.deepEqual([m.recovery.target,m.recovery.selected,m.recovery.ordinary],[slots,slots,size-slots]);
  assert.equal(new Set(ids(m)).size,size,'no film twice');
  assert.deepEqual(ids(m).slice(0,slots),n([1,2,3,4,5,6,7,8].slice(0,slots)).sort((a,b)=>ids(m).indexOf(a)-ids(m).indexOf(b)),'recovery films come first');
 }
 const one=await start(w,1,{dryRun:true});
 assert.equal(one.films.length,1);assert.equal(one.recovery.target,0);assert.equal(one.recovery.selected,0);assert.equal(one.films[0].lane,'hot','N=1 keeps the ordinary policy');
 const two=await start(w,2,{dryRun:true});
 assert.deepEqual([two.recovery.target,two.recovery.selected,two.recovery.ordinary],[1,1,1]);assert.deepEqual(two.films.map(f=>f.lane),['cold','hot']);
}

// 4. Hot recovery films: they take recovery slots ahead of never-predicted hot films that the ordinary rank would put first.
{
 const w=await floodedWorld();
 await confirm(w,n([9,10,11]));
 const queued=queueDoc(w).hotPending.filter(id=>n([9,10,11]).includes(id));
 const m=await start(w,5,{dryRun:true});
 assert.deepEqual(ids(m).slice(0,2),queued.slice(0,2),'the cohort order inside one lane is the stored queue order');
 assert.deepEqual(m.films.slice(0,2).map(f=>f.lane),['hot','hot']);
 assert.deepEqual(m.recovery.eligible,{hot:3,cold:0});
 assert.equal(m.films.slice(2).filter(f=>Number(f.filmId.slice(5))>100).length,3,'the ordinary slots are the never-predicted hot films');
 assert.ok(!ids(m).includes(queued[2]),'a third recovery film does not exceed the quota (the ordinary rank puts a never-predicted film first)');
}

// 5. Several cohorts: the oldest confirmed cohort is served first, whatever the queue position.
{
 const w=await floodedWorld();
 await confirm(w,n([3,4]));await sleep(20);await confirm(w,n([1,2]));
 const five=await start(w,5,{dryRun:true});
 assert.deepEqual(ids(five).slice(0,2).sort(),n([3,4]),'the older cohort takes the two slots');
 const ten=await start(w,10,{dryRun:true});
 assert.deepEqual(ids(ten).slice(0,2).sort(),n([3,4]));assert.deepEqual(ids(ten).slice(2,4).sort(),n([1,2]),'the younger cohort follows');
 assert.equal(ten.recovery.selected,4);
}

// 6. No active intent: the ordinary manifest alone, no recovery block; fewer candidates than slots: the rest is ordinary.
{
 const w=await floodedWorld();
 const none=await start(w,10,{dryRun:true});
 assert.equal('recovery' in none,false,'the answer is unchanged without an active intent');
 assert.ok(none.films.every(f=>Number(f.filmId.slice(5))>100&&f.lane==='hot'));
 await confirm(w,n([5]));
 const few=await start(w,10,{dryRun:true});
 assert.deepEqual([few.recovery.target,few.recovery.selected,few.recovery.ordinary],[4,1,9],'one candidate for four slots: three slots go back to the ordinary queue');
 assert.equal(few.films.length,10);assert.equal(few.films[0].filmId,'tmdb_5');
}

// 7. Fewer ordinary films than ordinary slots. With no hot film left the cold lane is the ordinary queue, so the recovery films are also ordinary there; with the hot lane held back by retry backoff the
// ordinary queue offers nothing, and the manifest holds only the recovery quota: it is never widened.
{
 const w=await world();
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 await scoreAll(w);
 await confirm(w,n([1,2,3,4,5,6,7,8]));
 const plain=await start(w,10,{dryRun:true});
 assert.deepEqual([plain.recovery.target,plain.recovery.selected,plain.recovery.ordinary,plain.films.length],[4,4,4,8],'the ordinary cold lane adds the other four cohort films by the ordinary order');
}
{
 const w=await floodedWorld();
 await confirm(w,n([1,2,3,4,5,6,7,8]));
 const q=queueDoc(w);
 q.retries=Object.fromEntries(q.hotPending.map(id=>[id,{kind:'parse_error',scope:'item',attempts:1,retryAt:Date.now()+3600e3,failedAt:new Date().toISOString(),lastRunId:'r'}]));
 writeQueue(w,q);
 const m=await start(w,10,{dryRun:true});
 assert.equal(m.films.length,4,'the ordinary queue has no ready film: only the four recovery slots are filled');
 assert.deepEqual([m.recovery.target,m.recovery.selected,m.recovery.ordinary,m.recovery.eligible.cold],[4,4,0,8]);
 assert.equal(m.films.every(f=>f.lane==='cold'),true);
}

// 8. Retry backoff and an exhausted budget are never bypassed; the diagnostics name them.
{
 const w=await floodedWorld();
 await confirm(w,n([1,2,3,4,5,6,7,8]));
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const q=queueDoc(w);
 q.retries={tmdb_1:{kind:'parse_error',scope:'item',attempts:10,retryAt:0,failedAt:new Date().toISOString(),lastRunId:'r'},tmdb_2:{kind:'parse_error',scope:'item',attempts:1,retryAt:Date.now()+3600e3,failedAt:new Date().toISOString(),lastRunId:'r'}};
 writeQueue(w,q);
 const m=await start(w,5,{dryRun:true});
 assert.ok(!ids(m).includes('tmdb_1')&&!ids(m).includes('tmdb_2'),'exhausted and backed-off recovery films keep their ordinary gates');
 assert.deepEqual(ids(m).slice(0,2).sort(),n([3,4]));
 assert.deepEqual([m.recovery.retryExhausted,m.recovery.deferredByRetry,m.recovery.eligible.cold],[1,1,6]);
 assert.equal(queueDoc(w).retries.tmdb_1.attempts,10,'the budget is never reset');
}

// 9. Expired, cancelled and satisfied intents get no privilege; a failing recovery store fails closed.
{
 const w=await floodedWorld();
 const receipt=await confirm(w,n([1,2,3,4]));
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 sql(w.file,"DROP TRIGGER prediction_recovery_intent_transition;UPDATE prediction_recovery_intent SET expires_at='2020-01-01T00:00:00.000Z' WHERE film_id IN ('tmdb_1','tmdb_2')");
 const m=await start(w,5,{dryRun:true});
 assert.ok(!ids(m).includes('tmdb_1')&&!ids(m).includes('tmdb_2'),'an expired intent gets no recovery slot, even on a queue built before it expired');
 assert.deepEqual(ids(m).slice(0,2).sort(),n([3,4]));assert.equal(m.recovery.active,2);
 const cancel=await w.admin('cancel',{method:'POST',body:{cohortId:receipt.cohortId}});assert.equal(cancel.status,200);
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const after=await start(w,5,{dryRun:true});
 assert.equal('recovery' in after,false,'a cancelled cohort has no active intent');
 assert.ok(after.films.every(f=>f.lane==='hot'&&Number(f.filmId.slice(5))>100));
}
{
 // Satisfied: the first new version ends the intent; the film is not selected again and takes no slot.
 const w=await floodedWorld();
 await confirm(w,n([1,2]));
 const m=await start(w,5);await submitAll(w,m);await complete(w,m,'manifest_spent');
 const next=await start(w,5,{dryRun:true});
 assert.ok(!ids(next).includes('tmdb_1')&&!ids(next).includes('tmdb_2'));
 assert.deepEqual([next.recovery.selected,next.recovery.noCandidates,next.recovery.notQueued],[0,true,2],'a satisfied intent is still an active row but is no candidate');
}
{
 const w=await floodedWorld();
 await confirm(w,n([1,2]));
 sql(w.file,'DROP TABLE prediction_recovery_cohort');
 const r=await w.api('batch/start',startBody({manifestSize:5}));
 assert.ok(!(r.status===200&&r.data.status==='running'&&Array.isArray(r.data.films)),'a partial recovery store is never read as "no recovery": no manifest is formed');
}

// 10. Pinned and dry-run calls. A pin is never reordered and carries no recovery block; a dry run is the faithful preview of the real start.
{
 const w=await floodedWorld();
 await confirm(w,n([1,2,3,4]));
 const pinIds=n([101,102,103]);
 const pinned=await start(w,5,{dryRun:true,pin:{filmIds:pinIds}});
 assert.deepEqual(ids(pinned),pinIds,'the pin order is kept and nothing is added');
 assert.equal('recovery' in pinned,false);
 // A pin is not a recovery call: cold recovery films stay outside it while the hot lane is not empty (the unchanged pin rule), and hot recovery films keep the pin order.
 const pinnedCold=await start(w,5,{dryRun:true,pin:{filmIds:n([4,101,3])}});
 assert.deepEqual(ids(pinnedCold),n([101]),'a pin gives a cold recovery film no extra way in');
 await confirm(w,n([9,10]));
 const pinnedHot=await start(w,5,{dryRun:true,pin:{filmIds:n([10,101,9])}});
 assert.deepEqual(ids(pinnedHot),n([10,101,9]),'the pin order is kept: no recovery reordering and no extra film');
 assert.equal('recovery' in pinnedHot,false);
 const dry=await start(w,5,{dryRun:true}),real=await start(w,5);
 assert.deepEqual(ids(dry),ids(real));assert.equal(dry.manifestHash,real.manifestHash,'the dry run and the real start are the same manifest');
}

// 11. The documented size bound: a manifest never exceeds its requested size and each film appears once.
{
 const w=await floodedWorld();
 await confirm(w,n([1,2,3,4,5,6,7,8]));
 for(const size of [1,2,3,4,5,6,7,9,11]){
  const m=await start(w,size,{dryRun:true});
  assert.ok(m.films.length<=size&&new Set(ids(m)).size===m.films.length);
  assert.equal(m.films.filter(f=>f.lane==='cold').length,Math.max(0,size>=2?Math.max(1,Math.floor(size*0.4)):0),'N='+size);
 }
}
console.log('prediction recovery slots: ok');
