// AIR-471: the R2 and D1 cost of one batch_start (manifestSize 5), its stage-level observability and the freshness it must keep.
// Offline: the real Worker code over a sqlite D1 stand-in and an in-memory R2, counted by the step-timing instrumentation. No Cloudflare, model, TMDB, Scheduled Task or production call.
// BEFORE is the baseline commit's measurement of the same scenarios (tests/fixtures/prediction-batch-start-parity-baseline.json, written by scripts/prediction-batch-start-diff.mjs); the asserted budgets are ceilings of this change, not a production claim.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import * as PredictionD1 from '../src/prediction-d1.js';

const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const reconcile=async w=>{const r=await w.api('queue/reconcile',{});assert.equal(r.status,200);return r;};
const timing=w=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start');
const last=w=>timing(w).at(-1);
const profileV=async(w,version)=>{const profile={version,profileHash:'p'+version,profile:{ratingScale:'Scale '+version}};w.records.set('enrichment/profile/versions/'+version+'.json',profile);await PredictionD1.saveMutable(w.env,'enrichment/profile/current.json',profile);};
import fs from 'node:fs';
const baseline=JSON.parse(fs.readFileSync(new URL('./fixtures/prediction-batch-start-parity-baseline.json',import.meta.url),'utf8'));
const alias={clean5:'clean5',already_running:'already_running',size100:'size100',stale:'stale_profile',missing:'missing_admission_in_window'};
const BEFORE=Object.fromEntries(Object.entries(alias).map(([k,v])=>[k,baseline.metrics[v]]));
const table=[];
const note=(name,line)=>{assert.ok(line.d1.n<BEFORE[name].d1,name+': fewer D1 calls than the baseline');assert.ok(line.r2.n<=BEFORE[name].r2,name+': no more R2 calls than the baseline');table.push([name,BEFORE[name].r2+' -> '+line.r2.n,BEFORE[name].d1+' -> '+line.d1.n].join(' | '));};

// 1. Clean current queue, manifestSize 5.
{
 const w=await flowWorld({films:40});await reconcile(w);
 const r=await batch(w,{manifestSize:5});assert.equal(r.status,200);assert.equal(r.data.films.length,5);
 const line=last(w);note('clean5',line);
 assert.ok(line.r2.n<=52,'R2 calls: '+line.r2.n);assert.ok(line.d1.n<=90,'D1 calls: '+line.d1.n);
 assert.equal(line.notes.preflights,2,'the initial and the post-lease preflight');assert.equal(line.notes.refreshRounds,0);assert.equal(line.notes.settledFilms,0);
 assert.equal(line.notes.scannedFilms,10,'five films read by each of the two preflights');
 assert.equal(line.notes.manifestFilms,5);
 // stages: closed names, sequential, counts that add up
 const names=line.stages.map(s=>s.stage);
 assert.deepEqual(names.filter(n=>n==='preflight'||n==='preflight_lease'||n==='runner_lease'||n==='persist'),['preflight','runner_lease','preflight_lease','persist']);
 for(const s of line.stages){assert.match(s.stage,/^[a-z_]+$/);assert.ok(s.ms>=0&&s.r2>=0&&s.d1>=0);}
 assert.ok(line.stages.reduce((n,s)=>n+s.d1,0)<=line.d1.n&&line.stages.reduce((n,s)=>n+s.r2,0)<=line.r2.n);
 // the line names no film, run, key or statement
 const text=JSON.stringify(line);assert.ok(!/tmdb_\d/.test(text),'no film id');assert.ok(!/enrichment\//.test(text),'no key');assert.ok(!/SELECT|INSERT|UPDATE/i.test(text),'no statement');
 for(const cls of Object.keys(line.classes))assert.match(cls,/^(r2|d1):[a-z_0-9]+$/);
 assert.ok(!('r2:other' in line.classes)||line.classes['r2:other'].n<=3,'the generic class holds the exception, not the bulk');
}

// 2. A second start while the lease is live: refused, recorded, cheap, with the correlation fields.
{
 const w=await flowWorld({films:40});await reconcile(w);
 const first=await batch(w,{manifestSize:5});assert.equal(first.status,200);
 const second=await batch(w,{manifestSize:5});
 assert.equal(second.data.status,'already_running');assert.equal(second.data.runId,first.data.runId,'the live holder is named, never adopted');assert.ok(!('films' in second.data),'no manifest');
 const line=last(w);note('already_running',line);
 assert.equal(line.notes.leaseRefused,1);assert.ok(Number.isSafeInteger(line.notes.liveLeaseAgeMs)&&line.notes.liveLeaseAgeMs>=0&&line.notes.liveLeaseAgeMs<15*60000);
 assert.ok(line.r2.n<=12&&line.d1.n<=25,'refusal cost '+line.r2.n+' R2, '+line.d1.n+' D1');
 assert.notEqual(timing(w)[0].requestId,line.requestId,'each start has its own request id');
 assert.equal(sql(w.file,"SELECT COUNT(*) AS n FROM prediction_run WHERE run_id='"+first.data.runId+"'")[0].n,1);
}

// 3. manifestSize 100 compatibility: the same 100 films and bytes, far fewer D1 calls than before.
{
 const w=await flowWorld({films:130});await reconcile(w);
 const r=await batch(w,{manifestSize:100});assert.equal(r.status,200);assert.equal(r.data.films.length,100);
 const line=last(w);note('size100',line);assert.ok(line.d1.n<=500,'D1 calls: '+line.d1.n);assert.ok(line.r2.n<=52);assert.equal(line.notes.scannedFilms,200);
}

// 4. Stale queue (the profile moved): the refresh looks at the requested five, not at a default hundred.
{
 const w=await flowWorld({films:100});await reconcile(w);await profileV(w,2);
 const r=await batch(w,{manifestSize:5});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.queueRefreshed,true);assert.equal(r.data.films.length,5);
 const line=last(w);note('stale',line);
 assert.ok(line.r2.n<=62&&line.d1.n<=125,line.r2.n+' R2, '+line.d1.n+' D1');
 assert.equal(line.notes.refreshRounds,1);assert.ok(line.notes.scannedFilms<=15,'scanned '+line.notes.scannedFilms);
}

// 5. Films without an admission at the head are settled out of the queue, and the manifest still has five films.
{
 const w=await flowWorld({films:100});await reconcile(w);
 const dry=await batch(w,{dryRun:true,manifestSize:5}),gone=dry.data.films.slice(0,3).map(f=>f.filmId);
 sql(w.file,"DELETE FROM discovery_admission WHERE film_id IN ("+gone.map(id=>"'"+id+"'").join(',')+")");
 const r=await batch(w,{manifestSize:5});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 assert.equal(r.data.queueSettled,3,'the three films leave the queue');assert.equal(r.data.films.length,5);
 assert.ok(r.data.films.every(f=>!gone.includes(f.filmId)),'none of the settled films is delivered');
 const queue=JSON.stringify(sql(w.file,'SELECT chunk_text AS c FROM prediction_queue ORDER BY seq'));for(const id of gone)assert.ok(!queue.includes('"'+id+'"')||!new RegExp('"(pending|hotPending|coldPending)":\\[[^\\]]*"'+id+'"').test(queue),id+' left the queue');
 const line=last(w);note('missing',line);
 assert.ok(line.r2.n<=60&&line.d1.n<=150,line.r2.n+' R2, '+line.d1.n+' D1');
 assert.ok(line.notes.settledFilms===3&&line.notes.refreshRounds>=1&&line.notes.refreshRounds<=3);
 assert.ok(line.notes.scannedFilms<=40,'scanned '+line.notes.scannedFilms+' films, not a default hundred or a scan cap of 300');
}

// 6. A film whose prediction was replaced before: the start reads its current prediction, not the replaced versions.
{
 const w=await flowWorld({films:20});await reconcile(w);
 const submitAll=async m=>{let epoch=m.lease.epoch;const items=m.films.map(f=>({filmId:f.filmId,...(f.plan==='fingerprint_and_prediction'?{fingerprint:w.fingerprint}:{}),prediction:w.prediction}));const r=await w.api('batch/submit',{runId:m.runId,epoch,items});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r;};
 const first=await batch(w,{manifestSize:5});await submitAll(first.data);
 assert.equal((await w.api('complete',{runId:first.data.runId,reason:'manifest_spent'})).status,200);
 await profileV(w,2);await reconcile(w);
 const again=await batch(w,{manifestSize:20});assert.equal(again.status,200,JSON.stringify(again.data).slice(0,200));
 const reached=again.data.films.filter(f=>f.plan==='prediction_only');assert.ok(reached.length>=1,'the five predicted films are due again and keep their stored fingerprint');
 assert.ok(reached.every(f=>f.fingerprint&&f.fingerprint.fingerprintHash),'the stored fingerprint is delivered');
 await submitAll({...again.data,films:reached});
 assert.equal((await w.api('complete',{runId:again.data.runId,reason:'time_budget'})).status,200);
 const history=sql(w.file,'SELECT COUNT(*) AS n FROM prediction_lineage')[0].n;assert.ok(history>=1,'replaced versions exist: '+history);
 await profileV(w,3);await reconcile(w);
 w.logs.length=0;
 const third=await batch(w,{manifestSize:20});assert.equal(third.status,200,JSON.stringify(third.data).slice(0,200));
 const line=last(w);
 assert.ok(!('d1:prediction_lineage' in line.classes),'no lineage query in a start');
 assert.ok(third.data.films.some(f=>f.plan==='prediction_only'));
}

// 7. Film input that changes while the queue revision does not: the post-lease revalidation still refuses (queue_changed), nothing but the lease acquire and release happens.
{
 const w=await flowWorld({films:30});await reconcile(w);
 const dry=await batch(w,{dryRun:true,manifestSize:5}),victim=dry.data.films[0].filmId;
 const original=w.ctx.PredictionD1;let fired=false;
 w.ctx.PredictionD1={...original,openLease:async(...a)=>{if(!fired){fired=true;sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','changed after the first preflight') WHERE film_id='"+victim+"'");}return original.openLease(...a);}};
 const runs=()=>sql(w.file,'SELECT COUNT(*) AS n FROM prediction_run')[0].n,before=runs();
 const r=await batch(w,{manifestSize:5});
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.code,'queue_changed','changed film input is refused although the queue revision is unchanged');
 assert.equal(runs(),before,'no run row');
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.equal(lease.expiresAt,0,'the lease was released');
 w.ctx.PredictionD1=original;
 const again=await batch(w,{manifestSize:5});assert.equal(again.status,200,'the next start works');
}

// 8. A competing start that wins the lease between the early check and the acquire is counted too, with the holder's age only when the answer carries its expiry.
for(const [name,hook,aged] of [
 ['live holder seen at acquire',(w,original)=>({openLease:async(...a)=>{if(!w.fired){w.fired=true;const doc=JSON.stringify({owner:'rival',runId:'11111111-1111-4111-8111-111111111111',heartbeatAt:new Date().toISOString(),expiresAt:Date.now()+14*60000,epoch:7}).replace(/'/g,"''");sql(w.file,"UPDATE prediction_lease SET document_json='"+doc+"' WHERE name='runner'");}return original.openLease(...a);}}),true],
 ['lost compare-and-swap at acquire',(w,original)=>({writeLease:async(...a)=>{if(!w.fired&&a[2]?.expiresAt>0){w.fired=true;sql(w.file,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1");}return original.writeLease(...a);}}),false],
]){
 const w=await flowWorld({films:30});await reconcile(w);
 sql(w.file,"INSERT INTO prediction_lease (name,token,expires_at,document_json) VALUES ('runner','t0',1,'{\"runId\":\"00000000-0000-4000-8000-000000000001\",\"expiresAt\":1,\"epoch\":3}')");
 const original=w.ctx.PredictionD1;w.fired=false;w.ctx.PredictionD1={...original,...hook(w,original)};
 const runs=()=>sql(w.file,'SELECT COUNT(*) AS n FROM prediction_run')[0].n,before=runs();
 const r=await batch(w,{manifestSize:5});
 assert.equal(r.data.status,'already_running',name+': '+JSON.stringify(r.data).slice(0,200));assert.ok(!('films' in r.data),'no manifest, no adoption');
 assert.equal(runs(),before,'no run row');
 const line=last(w);
 assert.equal(line.notes.leaseRefused,1,name);assert.equal(line.notes.leaseRefusedAtAcquire,1,name);
 if(aged){assert.equal(r.data.runId,'11111111-1111-4111-8111-111111111111','the holder is named');assert.ok(Number.isSafeInteger(line.notes.liveLeaseAgeMs)&&line.notes.liveLeaseAgeMs>=59000&&line.notes.liveLeaseAgeMs<=62000,String(line.notes.liveLeaseAgeMs));}
 else assert.ok(!('liveLeaseAgeMs' in line.notes),'no age is invented without an expiry');
 assert.equal(line.notes.preflights,1,name+': the early check passed and the refusal came at the acquire, before the post-lease preflight');
}

console.log('| scenario (manifestSize 5 unless noted) | R2 calls main -> now | D1 calls main -> now |\n| --- | --- | --- |\n'+table.map(row=>'| '+row+' |').join('\n'));
console.log('prediction-batch-start-budget: ok');
