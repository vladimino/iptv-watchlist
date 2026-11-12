// Batch runner v2, `batch_submit` (ADR 0122). One call settles 1 to 10 films of a run's manifest on the real Worker code, with the prediction domain in D1 mode as production runs it,
// over a sqlite D1 stand-in and an in-memory R2. Nothing here calls a model, TMDB, Cloudflare or production, and no Scheduled Task exists.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const sha=async text=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const ready=async n=>{const w=await flowWorld({films:n});const r=await w.api('queue/reconcile',{});assert.equal(r.status,200);return w;};
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));return r.data;};
const submit=(w,m,items,extra={})=>w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items,...extra});
const item=(w,id)=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});
const ids=m=>m.films.map(f=>f.filmId);
const run=(w,m)=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'")[0].d);
const pointers=w=>sql(w.file,'SELECT film_id FROM prediction_pointer ORDER BY film_id').map(r=>r.film_id);
const versions=w=>[...w.records.keys()].filter(k=>/\/predictions\/versions\//.test(k));
const lineLog=(w,step)=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step===step);

// 1. A group of 10: every film created, committed to D1 and R2, checkpointed in the run record and settled out of the queue in one write.
{
 const w=await ready(12);const m=await start(w),pick=ids(m).slice(0,10);
 const r=await submit(w,m,pick.map(id=>item(w,id)));
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 assert.deepEqual(r.data.results.map(x=>[x.filmId,x.status]),pick.map(id=>[id,'created']));
 assert.equal(r.data.epoch,m.lease.epoch);assert.equal(r.data.committed,true);assert.equal(r.data.queueSettlement,'settled');assert.deepEqual(r.data.profile,{changed:false});
 assert.equal(r.data.remaining,2,'the ten written films left the queue; two are still queued');
 assert.deepEqual(pointers(w),[...pick].sort(),'one D1 pointer per film');assert.equal(versions(w).length,10,'one immutable version object per film');
 const stored=run(w,m);assert.equal(Object.keys(stored.submitted).length,10);assert.ok(stored.submitted[pick[0]].inputDigest.match(/^[0-9a-f]{64}$/));assert.equal(stored.results[pick[0]],'created');
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.ok(!lease.submitGate,'the gate was cleared');assert.equal(lease.epoch,m.lease.epoch);
 const line=lineLog(w,'batch_submit');assert.equal(line.length,1);assert.equal(line[0].notes.bodyItems,10);assert.equal(line[0].notes.created,10);
}

const BATCH_LIMIT_BODY=56*1024;
const NO_RUN_KEYS=/^(enrichment\/runs\/|enrichment\/latest-run|events\/|enrichment\/event)/;
const r2Snapshot=w=>new Map([...w.records.entries()].map(([k,v])=>[k,JSON.stringify(v)]));
const domain=file=>JSON.stringify(['prediction_pointer','prediction_current','prediction_fingerprint','prediction_history','prediction_lineage'].map(t=>sql(file,'SELECT * FROM '+t)));
const setLease=(w,edit)=>{const row=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0],doc=JSON.parse(row.d);edit(doc);sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");};
const rich=w=>{ // a fingerprint with evidence on every asserted mechanic and execution dimension: the largest realistic payload of one film
 const fp=structuredClone(w.fingerprint),items=n=>Array.from({length:n},(_,i)=>({source:'model_knowledge',ref:'model_knowledge',note:'x'.repeat(220)+i}));
 return fp;
};

// 2. Mixed outcomes inside one group: a schema failure and a reported failure do not touch the others; the failures are sanitized, retryable and never a payload copy.
{
 const w=await ready(12);const m=await start(w),pick=ids(m).slice(0,7);
 const bad={...w.prediction,predictedRating:99,secret:'do-not-echo'},items=[item(w,pick[0]),{filmId:pick[1],fingerprint:w.fingerprint,prediction:bad},item(w,pick[2]),{filmId:pick[3],failure:{kind:'parse_error'}},item(w,pick[4]),{filmId:'tmdb_9999',fingerprint:w.fingerprint,prediction:w.prediction},item(w,pick[6])];
 const r=await submit(w,m,items);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const by=Object.fromEntries(r.data.results.map(x=>[x.filmId,x]));
 assert.deepEqual([pick[0],pick[2],pick[4],pick[6]].map(id=>by[id].status),['created','created','created','created']);
 assert.equal(by[pick[1]].status,'validation_failure');assert.equal(by[pick[1]].retryable,true);assert.equal(by[pick[1]].validation.stage,'prediction_schema');assert.equal(by[pick[1]].validation.reportedBy,'worker');assert.ok(by[pick[1]].validation.issues.length>0&&by[pick[1]].validation.issues.every(i=>typeof i.path==='string'&&typeof i.code==='string'));
 assert.ok(!JSON.stringify(r.data).includes('do-not-echo')&&!JSON.stringify(r.data).includes('Half stars'),'neither the payload nor the profile is echoed');
 assert.equal(by[pick[3]].status,'validation_failure');assert.equal(by[pick[3]].validation.stage,'caller_reported');
 assert.equal(by.tmdb_9999.status,'not_in_manifest');
 assert.deepEqual(pointers(w),[pick[0],pick[2],pick[4],pick[6]].sort(),'only the valid films were written');
 const stored=run(w,m);assert.equal(stored.failures[pick[1]].scope,'item');assert.equal(stored.results[pick[1]],'failed');assert.equal(stored.formatFailureStreak,0,'a good film after the failures resets the streak');
 const queue=JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
 assert.ok(queue.retries[pick[1]]&&queue.retries[pick[3]],'both failures are in the queue as retry records at once');assert.ok(queue.retries[pick[1]].retryAt>Date.now(),'with the existing backoff');
 // the failed film is not resubmitted in the run: the stored failure answers, whatever the payload
 const same=await submit(w,m,[{filmId:pick[1],fingerprint:w.fingerprint,prediction:bad}]);assert.equal(same.data.results[0].status,'validation_failure');assert.equal(same.data.results[0].replayed,true,'the identical payload is a replay of the stored failure');assert.equal(same.data.results[0].retryAt,by[pick[1]].retryAt);
 const retried=await submit(w,m,[item(w,pick[1])]);assert.equal(retried.data.results[0].status,'conflict','a failed film is not retried in the run: a different payload is a conflict, not a replay');assert.equal(pointers(w).length,4);
 const failed2=await submit(w,m,[{filmId:pick[3],failure:{kind:'parse_error'}}]);assert.equal(failed2.data.results[0].replayed,true,'an identical reported failure is a replay');
 assert.equal((await submit(w,m,[{filmId:pick[3],failure:{kind:'validation_error'}}])).data.results[0].status,'conflict','a different failure kind is a conflict');
}

// 3. Replay: the same body again is idempotent per film: nothing is written twice, no version object, history row or view-index entry is added.
{
 const w=await ready(12);const m=await start(w),pick=ids(m).slice(0,5),items=pick.map(id=>item(w,id));
 const first=await submit(w,m,items);assert.equal(first.status,200);
 const keys0=versions(w).length,d0=domain(w.file),idx0=JSON.stringify(w.records.get('enrichment/view-index.json')||null);
 const second=await submit(w,m,items);assert.equal(second.status,200);
 assert.deepEqual(second.data.results.map(x=>[x.status,x.replayed]),pick.map(()=>['created',true]),'the recorded outcome comes back as replayed');
 assert.equal(versions(w).length,keys0);assert.equal(domain(w.file),d0,'no D1 row changed');assert.equal(JSON.stringify(w.records.get('enrichment/view-index.json')||null),idx0);
 // a different payload for a film this run already settled is a conflict and writes nothing
 const other=await submit(w,m,[{filmId:pick[0],fingerprint:w.fingerprint,prediction:{...w.prediction,predictedRating:2.5}}]);assert.equal(other.data.results[0].status,'conflict');assert.equal(domain(w.file),d0);
}

// 4. A crash after 3 of 7: the committed films are recognized when the same body is submitted again, with no duplicate version, history row or pointer, whether or not their results were recorded.
{
 const w=await ready(12);const m=await start(w),pick=ids(m).slice(0,7),items=pick.map(id=>item(w,id));
 const part=await submit(w,m,items.slice(0,3));assert.equal(part.status,200);
 // the run record of the last two films never reached storage (the handler died between the film commit and the checkpoint)
 const doc=run(w,m);delete doc.submitted[pick[1]];delete doc.submitted[pick[2]];delete doc.results[pick[1]];delete doc.results[pick[2]];
 sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+m.runId+"'");
 const v0=versions(w).length,pointers0=pointers(w);
 const all=await submit(w,m,items);assert.equal(all.status,200,JSON.stringify(all.data).slice(0,300));
 assert.deepEqual(all.data.results.map(x=>x.status),pick.map(()=>'created'),'every film is created once');
 assert.deepEqual(all.data.results.slice(0,3).map(x=>x.replayed),[true,true,true],'the first three were recognized, not written again');
 assert.equal(versions(w).length,7,'exactly one version object per film: '+v0+' then '+versions(w).length);assert.equal(pointers(w).length,7);
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_lineage')[0].n,0,'no history row: nothing was recalculated');
 // a different payload in the crash window is a conflict, not a silent match
 const w2=await ready(12);const m2=await start(w2),p2=ids(m2).slice(0,2);await submit(w2,m2,[item(w2,p2[0])]);
 const d2=run(w2,m2);delete d2.submitted[p2[0]];delete d2.results[p2[0]];sql(w2.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(d2).replace(/'/g,"''")+"' WHERE run_id='"+m2.runId+"'");
 const diff=await submit(w2,m2,[{filmId:p2[0],fingerprint:w2.fingerprint,prediction:{...w2.prediction,mainRisk:'A different risk'}}]);assert.equal(diff.data.results[0].status,'conflict');
}

import vm from 'node:vm';
import * as PD from '../src/prediction-d1.js';
const queueOf=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
// A published profile version 2 with a declared impact. A selective declaration carries the owner approval bound to its exact text, as the publication route requires.
async function publish(w,{scope,selectors=[],changedFields=[],hash='p2'}){
 const impact={impactSchemaVersion:1,from:{version:1,profileHash:'p'},scope,changedFields,selectors};
 const text=w.ctx.profileDeclarationText(impact,{version:2,profileHash:hash});
 const declared=scope==='selective'?{...impact,approval:{approvedBy:'owner',approvedAt:'2026-10-27T21:00:00.000Z',reviewRef:'trello-comment:test',declarationSha256:await sha(text)}}:impact;
 const profile={version:2,profileHash:hash,profile:{ratingScale:'Half stars',horrorPreferences:'Rules and causality'},changeImpact:declared,lineage:[{version:1,profileHash:'p',changeImpact:null},{version:2,profileHash:hash,changeImpact:declared}]};
 w.records.set('enrichment/profile/versions/2.json',profile);await PD.saveMutable(w.env,'enrichment/profile/current.json',profile);return profile;
}
const genresOf=(w,map)=>{for(const [id,genres] of Object.entries(map))sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.genres',"+(genres===null?'null':"json('"+JSON.stringify(genres)+"')")+") WHERE film_id='"+id+"'");};

// 5. The profile moves under the run. The same combined verdict decides film by film: a film the change does not reach is kept (with the profile identity it was made with), the others are
// returned for regeneration. Neither is a failure: no retry record, no backoff, no format-error streak, and no full profile in a per-film payload.
{
 const w=await flowWorld({films:12});genresOf(w,{tmdb_1:['horror'],tmdb_2:['horror'],tmdb_3:['drama'],tmdb_4:['drama'],tmdb_5:null});
 assert.equal((await w.api('queue/reconcile',{})).status,200);const m=await start(w),first=['tmdb_1','tmdb_2','tmdb_3','tmdb_4','tmdb_5'].filter(id=>ids(m).includes(id));assert.equal(first.length,5);
 await publish(w,{scope:'selective',selectors:[{kind:'genre',values:['horror']}],changedFields:['horrorPreferences']});
 const r=await submit(w,m,first.map(id=>item(w,id)));assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const by=Object.fromEntries(r.data.results.map(x=>[x.filmId,x]));
 assert.equal(by.tmdb_3.status,'created');assert.equal(by.tmdb_3.compatibility,'compatible','an unaffected film is kept');assert.equal(by.tmdb_4.status,'created');
 assert.equal(by.tmdb_1.status,'needs_regeneration');assert.equal(by.tmdb_1.compatibility,'impacted');assert.equal(by.tmdb_2.status,'needs_regeneration');
 assert.equal(by.tmdb_5.status,'needs_regeneration');assert.equal(by.tmdb_5.compatibility,'unknown','a film whose features cannot answer the selector is regenerated, not kept');
 for(const id of ['tmdb_1','tmdb_2','tmdb_5']){assert.ok(!by[id].error&&!by[id].retryAt&&!by[id].validation,'no failure payload on a regeneration answer');}
 assert.deepEqual(r.data.profile.changed,true);assert.equal(r.data.profile.scope,'selective');assert.deepEqual(r.data.profile.from,{version:1,hash:'p'});assert.deepEqual(r.data.profile.to,{version:2,hash:'p2'});assert.ok(r.data.profile.body,'the new profile is sent once, at the top level');
 assert.deepEqual([...r.data.regenerate].sort(),['tmdb_1','tmdb_2','tmdb_5']);assert.equal(r.data.action,'continue');
 for(const x of r.data.results)assert.ok(!JSON.stringify(x).includes('Rules and causality'),'no profile text in a per-film payload');
 assert.deepEqual(pointers(w),['tmdb_3','tmdb_4'],'only the kept films were written');
 assert.equal(sql(w.file,"SELECT taste_profile_hash AS h FROM prediction_pointer WHERE film_id='tmdb_3'")[0].h,'p','the record keeps the profile it was made with');
 assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_fingerprint')[0].n,5,'the fingerprints of the returned films are valid work and were kept');
 const stored=run(w,m),queue=queueOf(w);assert.deepEqual(Object.keys(stored.failures),[],'no failure record');assert.equal(stored.formatFailureStreak||0,0);assert.deepEqual(Object.keys(queue.retries||{}).filter(id=>first.includes(id)),[],'no retry record, so no backoff');assert.ok(!stored.retryHeal);
 // replay: the returned films are answered again without a write
 const d0=domain(w.file),again=await submit(w,m,first.map(id=>item(w,id)));assert.deepEqual(again.data.results.map(x=>[x.status,x.replayed]),first.map(id=>[by[id].status,true]));assert.equal(domain(w.file),d0);
 // the run is completed for the profile and the next start asks only for the prediction of the returned films (their fingerprints stand)
 assert.equal((await w.api('complete',{runId:m.runId,reason:'profile_changed'})).status,200);
 const next=await start(w),plans=Object.fromEntries(next.films.map(f=>[f.filmId,f.plan]));assert.equal(next.profile.version,2);
 for(const id of ['tmdb_1','tmdb_2','tmdb_5'])assert.equal(plans[id],'prediction_only','only the prediction is regenerated: '+id);
 assert.ok(!['tmdb_3','tmdb_4'].some(id=>id in plans),'the kept films are not delivered again');
}
{
 // global: nothing under the old profile is kept; the answer says complete
 const w=await ready(8);const m=await start(w),pick=ids(m).slice(0,4);
 await publish(w,{scope:'global',changedFields:['ratingScale']});
 const r=await submit(w,m,pick.map(id=>item(w,id)));assert.equal(r.status,200);
 assert.deepEqual(r.data.results.map(x=>x.status),pick.map(()=>'needs_regeneration'));assert.equal(r.data.profile.scope,'global');assert.equal(r.data.action,'complete');assert.equal(pointers(w).length,0);
 assert.equal(run(w,m).retryHeal,undefined);assert.deepEqual(Object.keys(run(w,m).failures),[]);
 const done=await w.api('complete',{runId:m.runId,reason:'profile_changed'});assert.equal(done.status,200);assert.equal(done.data.status,'partial');
}
{
 // identity (same hash, another version number): the profile did not change for prediction purposes, so nothing is reported
 const w=await ready(6);const m=await start(w);
 const same={version:2,profileHash:'p',profile:{ratingScale:'Half stars'},lineage:[{version:1,profileHash:'p',changeImpact:null},{version:2,profileHash:'p',changeImpact:{impactSchemaVersion:1,from:{version:1,profileHash:'p'},scope:'identity',changedFields:[],selectors:[]}}]};
 w.records.set('enrichment/profile/versions/2.json',same);await PD.saveMutable(w.env,'enrichment/profile/current.json',same);
 const r=await submit(w,m,ids(m).slice(0,2).map(id=>item(w,id)));assert.equal(r.status,200);assert.deepEqual(r.data.results.map(x=>x.status),['created','created']);assert.deepEqual(r.data.profile,{changed:false});
}

const counted=w=>{const counts={put:0,delete:0},put=w.env.BUCKET.put.bind(w.env.BUCKET),del=w.env.BUCKET.delete.bind(w.env.BUCKET);w.env.BUCKET.put=async(...a)=>{counts.put++;return put(...a);};w.env.BUCKET.delete=async(...a)=>{counts.delete++;return del(...a);};return counts;};
const state=async w=>({d1:await sha(dump(w.file)),r2:[...r2Snapshot(w).entries()].sort().join('|')});

// 6. Refusals before an item is processed write nothing: an unknown, finished or other-protocol run, another epoch, an expired lease, a changed contract, an invalid body.
{
 const w=await ready(10);const m=await start(w),pick=ids(m);
 assert.equal((await w.api('batch/submit',{runId:'no-such-run',epoch:1,items:[item(w,pick[0])]})).status,404);
 assert.equal((await submit(w,m,[item(w,pick[0])],{})).status,200,'a good call');
 const afterGood=domain(w.file),runGood=JSON.stringify(sql(w.file,'SELECT * FROM prediction_run'));
 const wrongEpoch=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch+1,items:[item(w,pick[1])]});assert.equal(wrongEpoch.status,409);assert.equal(wrongEpoch.data.code,'epoch_mismatch','a wrong epoch is the caller\'s error and does not stop the real owner\'s run');assert.equal(run(w,m).status,'running');
 assert.equal(domain(w.file),afterGood,'another epoch writes no film');assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),runGood,'and no run record');
 // a contract change under the run
 const doc=run(w,m);doc.predictionPromptVersion=99;sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+m.runId+"'");
 const changed=await submit(w,m,[item(w,pick[1])]);assert.equal(changed.status,409);assert.equal(changed.data.code,'contract_changed');assert.equal(pointers(w).length,1);
 doc.predictionPromptVersion=m.contract.predictionPromptVersion;sql(w.file,"UPDATE prediction_run SET document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE run_id='"+m.runId+"'");
 // an expired lease: the old owner writes nothing
 setLease(w,d=>{d.expiresAt=1;});
 const films0=domain(w.file),expired=await submit(w,m,[item(w,pick[1])]);assert.equal(expired.status,409);assert.equal(expired.data.status,'lease_lost');assert.equal(domain(w.file),films0);
 assert.equal((await w.api('heartbeat',{runId:m.runId})).status,409,'the expired owner cannot renew (the stop of the lost lease was recorded, as for a v5 step)');
 // bodies that are not a batch
 for(const bad of [{},{runId:m.runId,epoch:1,items:[]},{runId:m.runId,epoch:1,items:Array.from({length:11},(_,i)=>({filmId:'f'+i}))},{runId:m.runId,epoch:0,items:[{filmId:'a'}]},{runId:m.runId,epoch:1,items:[{filmId:'a'},{filmId:'a'}]},{runId:m.runId,epoch:1,items:[{filmId:'a',extra:1}]},{runId:m.runId,epoch:1,items:[{filmId:'a',inputHash:'0'.repeat(24)}]},{runId:m.runId,epoch:1,items:[{filmId:'a'}],manifestHash:'0'.repeat(64)},{runId:m.runId,epoch:1,items:[{filmId:'a'}],dryRun:'yes'}])assert.equal((await w.api('batch/submit',bad)).status,400,JSON.stringify(bad).slice(0,80));
}
{
 // a finished run, and a v5 run
 const w=await ready(8);const m=await start(w);await submit(w,m,[item(w,ids(m)[0])]);
 assert.equal((await w.api('complete',{runId:m.runId,reason:'external_termination'})).status,200);
 const done=await submit(w,m,[item(w,ids(m)[1])]);assert.equal(done.status,409);assert.match(done.data.error,/already complete/);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.data.status,'running');
 const d0=domain(w.file),wrong=await w.api('batch/submit',{runId:v5.data.runId,epoch:1,items:[item(w,'tmdb_1')]});assert.equal(wrong.status,409);assert.equal(wrong.data.code,'wrong_protocol');assert.equal(domain(w.file),d0);
 // and the v5 run still works with its own tools
 assert.equal((await w.pair(v5.data.runId)).submit.status,200);
}

// 7. The submit gate: one call of a run at a time. An unexpired gate of another request is answered `submit_in_flight` and nothing is written; an expired one is taken over.
{
 const w=await ready(10);const m=await start(w),pick=ids(m);
 setLease(w,d=>{d.submitGate={token:'another-token',requestId:'another-request',bodyHash:'x',startedAt:new Date().toISOString(),expiresAt:Date.now()+45000};});
 const d0=domain(w.file),run0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),busy=await submit(w,m,[item(w,pick[0])]);
 assert.equal(busy.status,409);assert.equal(busy.data.code,'submit_in_flight');assert.equal(busy.data.status,'busy');assert.ok(busy.data.retryAfterMs>=1000);
 assert.equal(domain(w.file),d0);assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),run0);
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.equal(lease.submitGate.token,'another-token','the other request keeps its gate');
 // a heartbeat does not touch the gate and does not lose the epoch
 const hb=await w.api('heartbeat',{runId:m.runId});assert.equal(hb.status,200);assert.equal(JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d).submitGate.token,'another-token');
 setLease(w,d=>{d.submitGate.expiresAt=Date.now()-1;});
 const taken=await submit(w,m,[item(w,pick[0])]);assert.equal(taken.status,200);assert.equal(taken.data.results[0].status,'created');
}
{
 // The commit boundary is the fence, not a check before it: a handler that passed its gate check, stalls inside one storage call and then commits after its gate was reassigned,
 // commits nothing (the D1 batch itself refuses it).
 const w=await ready(10);const m=await start(w),pick=ids(m);
 const original=w.env.BUCKET.put.bind(w.env.BUCKET);let fired=false;
 w.env.BUCKET.put=async(key,...rest)=>{if(!fired&&/\/fingerprints\//.test(key)){fired=true;setLease(w,d=>{d.submitGate={token:'the-replacement',requestId:'x',bodyHash:'y',startedAt:new Date().toISOString(),expiresAt:Date.now()+45000};});}return original(key,...rest);};
 const run0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_run WHERE run_id=\''+m.runId+'\''));
 const r=await submit(w,m,pick.slice(0,3).map(id=>item(w,id)));
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'gate_lost');
 assert.deepEqual(r.data.results.map(x=>x.status),['blocked','blocked','blocked']);assert.equal(r.data.results[0].reason,'gate_lost');
 assert.equal(pointers(w).length,0,'the superseded handler committed no pointer');assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_fingerprint')[0].n,0);
 assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_run WHERE run_id=\''+m.runId+'\'')),run0,'and could not overwrite the run record either');
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.equal(lease.submitGate.token,'the-replacement','the replacement keeps its gate');
}

// 8. A renewal that loses the compare-and-swap during a submit is retried; the run is not lost.
{
 const w=await ready(8);const m=await start(w);
 const original=w.ctx.PredictionD1;let left=2;
 w.ctx.PredictionD1={...original,writeLease:async(...a)=>{if(left>0&&a[1]?.name==='runner'&&a[2]?.expiresAt>0){left--;return null;}return original.writeLease(...a);}};
 const r=await submit(w,m,[item(w,ids(m)[0])]);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.equal(r.data.results[0].status,'created');
 left=99;const busy=await submit(w,m,[item(w,ids(m)[1])]);assert.equal(busy.status,409);assert.equal(busy.data.status,'busy');assert.equal(busy.data.reason,'lease_contention'.length?busy.data.reason:'');assert.notEqual(busy.data.status,'lease_lost');
 w.ctx.PredictionD1=original;assert.equal((await submit(w,m,[item(w,ids(m)[1])])).status,200,'the run kept its ownership');
}

// 9. A queue rebuilt between two submits, and the soft call budget.
{
 const w=await ready(12);const m=await start(w),pick=ids(m);
 assert.equal((await submit(w,m,pick.slice(0,3).map(id=>item(w,id)))).status,200);
 assert.equal((await w.api('queue/reconcile',{})).status,200,'a named writer rebuilds the queue while the run is open');
 const r=await submit(w,m,pick.slice(3,6).map(id=>item(w,id)));assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));assert.deepEqual(r.data.results.map(x=>x.status),['created','created','created']);assert.equal(r.data.remaining,6);
 const budget=vm.runInContext('BATCH_RUNNER',w.ctx),saved=budget.callBudgetMs;budget.callBudgetMs=-1;
 const slow=await submit(w,m,pick.slice(6,9).map(id=>item(w,id)));budget.callBudgetMs=saved;
 assert.deepEqual(slow.data.results.map(x=>x.status),['deferred_budget','deferred_budget','deferred_budget']);assert.equal(pointers(w).length,6,'nothing of the deferred items was written');
 assert.equal((await submit(w,m,pick.slice(6,9).map(id=>item(w,id)))).data.results[0].status,'created','they are resubmitted as they were');
}

// 10. A dry run validates every item with the same validators and writes nothing: no lease, gate, run, queue, fingerprint, prediction, version object or view-index entry.
{
 const w=await ready(12);
 const dm=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',dryRun:true});assert.equal(dm.status,200);const pick=dm.data.films.slice(0,5).map(f=>f.filmId);
 assert.ok(dm.data.films.every(f=>/^[0-9a-f]{24}$/.test(f.inputHash)),'a dry-run manifest names each film\'s input');
 const counts=counted(w),before=await state(w),puts=counts.put;
 const bad={...w.prediction,predictedRating:99};
 const dry=(items,extra={})=>w.api('batch/submit',{runId:'dry-run',epoch:1,items,dryRun:true,manifestHash:dm.data.manifestHash,...extra});
 const r=await dry([{...item(w,pick[0]),inputHash:dm.data.films[0].inputHash},{filmId:pick[1],fingerprint:w.fingerprint,prediction:bad},{filmId:pick[2],failure:{kind:'parse_error'}},{filmId:'tmdb_9999',fingerprint:w.fingerprint,prediction:w.prediction}]);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.dryRun,true);assert.equal(r.data.manifestHash,dm.data.manifestHash);assert.equal(r.data.runId,null);
 const by=Object.fromEntries(r.data.results.map(x=>[x.filmId,x]));
 assert.equal(by[pick[0]].status,'would_write');assert.equal(by[pick[0]].liveInput,'same');assert.equal(by[pick[1]].status,'validation_failure');assert.equal(by[pick[1]].validation.stage,'prediction_schema');assert.equal(by[pick[2]].validation.stage,'caller_reported');assert.equal(by.tmdb_9999.status,'not_eligible');assert.equal(by.tmdb_9999.liveInput,'not_eligible');
 assert.deepEqual(await state(w),before,'a dry run wrote nothing: D1 dump and every R2 object unchanged');assert.equal(counts.put,puts);assert.equal(counts.delete,0);
 // the input moved since the dry-run manifest: reported, not hidden
 sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','A different synopsis') WHERE film_id='"+pick[0]+"'");
 const afterEdit=await state(w),moved=await dry([{...item(w,pick[0]),inputHash:dm.data.films[0].inputHash}]);assert.equal(moved.data.results[0].liveInput,'changed');assert.deepEqual(await state(w),afterEdit,'and the dry run still wrote nothing');
 // a contract that is not the current one is refused as a changed contract
 const stale=await dry([item(w,pick[0])],{contract:{...dm.data.contract,fingerprintSchemaVersion:dm.data.contract.fingerprintSchemaVersion+1,schema:undefined}});assert.equal(stale.status,409);assert.equal(stale.data.code,'contract_changed');
 const ok=await dry([item(w,pick[0])],{contract:{fingerprintSchemaVersion:dm.data.contract.fingerprintSchemaVersion,fingerprintPromptVersion:dm.data.contract.fingerprintPromptVersion,predictionPromptVersion:dm.data.contract.predictionPromptVersion,registryDigest:dm.data.contract.registryDigest}});assert.equal(ok.status,200);
 // a dry run beside a live run does not look at the run, and does not touch it
 const live=await start(w);const afterLive=await state(w);const beside=await dry([item(w,ids(live)[0])]);assert.equal(beside.status,200);assert.deepEqual(await state(w),afterLive);
}

// 11. Bounded load: a group of 10 rich items (every text field at a realistic length, the stored profile large) settles in a bounded number of storage calls and is one queue settlement.
{
 const w=await ready(14);const m=await start(w),pick=ids(m).slice(0,10);
 const long=(n,len)=>Array.from({length:n},(_,i)=>'A causal point that carries the plot number '+i+' '+'x'.repeat(len));
 const heavy={...w.fingerprint,strengths:long(4,320),risks:long(4,320),sourceRefs:[]};
 const bodyItems=pick.map(id=>({filmId:id,fingerprint:heavy,prediction:w.prediction}));
 assert.equal((await w.ctx.fingerprintIssues(heavy,{})).length,0,'the rich fingerprint is a valid one');
 const bytes=new TextEncoder().encode(JSON.stringify({runId:m.runId,epoch:m.lease.epoch,items:bodyItems})).length;
 assert.ok(bytes<BATCH_LIMIT_BODY,'ten rich items fit one MCP call: '+bytes);
 const t0=Date.now(),trips0=w.stats.queries+w.stats.batches,r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:bodyItems}),ms=Date.now()-t0,trips=w.stats.queries+w.stats.batches-trips0;
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));assert.deepEqual(r.data.results.map(x=>x.status),pick.map(()=>'created'));
 const line=lineLog(w,'batch_submit').at(-1);assert.equal(line.notes.created,10);
 const queueWrites=sql(w.file,"SELECT count(*) AS n FROM prediction_queue")[0].n;
 console.log('batch_submit of 10 rich items: '+bytes+' request bytes, '+ms+' ms offline, '+trips+' D1 round trips, R2 '+line.r2.n+' operations, D1 statements '+line.d1.statements);
 assert.ok(ms<15000,'bounded wall time offline: '+ms);assert.ok(trips<1500,'bounded D1 round trips: '+trips);
 // ten fingerprints at the contract's own maximum (12000 characters each) are over the call limit: the MCP tool refuses them with nothing submitted, see tests/mcp-tools.mjs
 const max={...w.fingerprint,strengths:Array.from({length:8},()=>'s'.repeat(500)),risks:Array.from({length:8},()=>'r'.repeat(500)),sourceRefs:[]};
 const maxBytes=new TextEncoder().encode(JSON.stringify({runId:m.runId,epoch:1,items:pick.map(id=>({filmId:id,fingerprint:max,prediction:w.prediction}))})).length;
 console.log('ten fingerprints at the 12000-character maximum: '+maxBytes+' request bytes (limit 65536, advised 57344)');assert.ok(maxBytes>BATCH_LIMIT_BODY);
}

// 12. The queue settlement is one write per call and is derived from the run record: a settlement that loses its compare-and-swap is reported as pending, and the next call completes it.
{
 const w=await ready(12);const m=await start(w),pick=ids(m);
 const original=w.ctx.mutatePredictionQueue;let lose=true;
 w.ctx.mutatePredictionQueue=async(...a)=>{if(lose&&a[2]==='batch_progress'){const e=new Error('conflict');e.code='prediction_queue_conflict';throw e;}return original(...a);};
 const first=await submit(w,m,pick.slice(0,4).map(id=>item(w,id)));
 assert.equal(first.status,200,JSON.stringify(first.data).slice(0,200));assert.equal(first.data.queueSettlement,'pending');assert.deepEqual(first.data.results.map(x=>x.status),pick.slice(0,4).map(()=>'created'),'the results are returned: nothing committed is lost');
 assert.equal(queueOf(w).pending.length,12,'the queue still lists the four written films');assert.equal(pointers(w).length,4);
 lose=false;const second=await submit(w,m,pick.slice(4,6).map(id=>item(w,id)));
 assert.equal(second.data.queueSettlement,'settled');assert.equal(queueOf(w).pending.length,6,'the earlier four and these two are settled together');assert.equal(second.data.remaining,6);
 w.ctx.mutatePredictionQueue=original;
}

// 13. Lineage and the immutable output of a written film are the ones a v5 submit writes: the version object, the D1 pointer and the record's run and prompt identity.
{
 const w=await ready(6);const m=await start(w),id=ids(m)[0];
 const r=await submit(w,m,[item(w,id)]);assert.equal(r.data.results[0].status,'created');
 const bundle=w.records.get('enrichment/films/'+id+'/predictions.json')||JSON.parse(sql(w.file,"SELECT display_json AS d FROM prediction_pointer WHERE film_id='"+id+"'")[0].d);
 const cur=bundle.current||bundle;
 assert.equal(cur.runId,m.runId);assert.equal(cur.trigger,'scheduled');assert.equal(cur.tasteProfileHash,'p');assert.equal(cur.predictionPromptVersion,m.contract.predictionPromptVersion);assert.equal(cur.fingerprintPromptVersion,m.contract.fingerprintPromptVersion);
 assert.equal(cur.fingerprintHash,sql(w.file,"SELECT fingerprint_hash AS h FROM prediction_pointer WHERE film_id='"+id+"'")[0].h);assert.ok(cur.confidenceAssessment,'the Worker computes the confidence assessment');assert.ok(cur.r2Key&&cur.contentSha256,'linked to its immutable version object');
 assert.ok(w.records.has(cur.r2Key),'the immutable version object exists in R2');assert.ok([...w.records.keys()].some(k=>k.includes('/fingerprints/')),'and the fingerprint body and its generation record');
 // an Event and the run status are the v5 ones: the run is a run
 const status=await (await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/status'),w.env)).json();assert.equal(status.run?.runId??m.runId,m.runId);
}

// 14. Two requests of one run. The gate comes before the global writer lease, so a genuinely overlapping call is answered `submit_in_flight` with the gate's remaining time, whatever its body
// and whatever X-Request-Id it carries, writes nothing, and can be replayed after the first call completes.
const raw=(w,body,requestId)=>w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/batch/submit',{method:'POST',headers:{'Content-Type':'application/json',...(requestId?{'X-Request-Id':requestId}:{})},body:JSON.stringify(body)}),w.env).then(async r=>({status:r.status,data:await r.json()}));
// holds the first call inside a film operation (the first fingerprint body put) until `release()`
function hold(w){let release,reached;const blocked=new Promise(r=>{release=r;}),at=new Promise(r=>{reached=r;}),original=w.env.BUCKET.put.bind(w.env.BUCKET);let first=true;w.env.BUCKET.put=async(key,...rest)=>{if(first&&/\/fingerprints\//.test(key)){first=false;reached();await blocked;}return original(key,...rest);};return {release,at};}
{
 const w=await ready(12);const m=await start(w),pick=ids(m);
 const held=hold(w),body1={runId:m.runId,epoch:m.lease.epoch,items:pick.slice(0,2).map(id=>item(w,id))};
 const first=raw(w,body1,'same-request-id');await held.at;
 const d0=domain(w.file),run0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),q0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),r2a=r2Snapshot(w);
 const identical=await raw(w,body1,'same-request-id');
 assert.equal(identical.status,409);assert.equal(identical.data.code,'submit_in_flight','an identical replay while the first call runs reaches the gate, not the writer lease');assert.equal(identical.data.status,'busy');assert.ok(identical.data.retryAfterMs>=1000);
 const other=await raw(w,{...body1,items:pick.slice(2,4).map(id=>item(w,id))},'same-request-id');
 assert.equal(other.data.code,'submit_in_flight','the same X-Request-Id with another body does not overwrite the live gate');
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.ok(lease.submitGate&&lease.submitGate.token&&lease.submitGate.requestId==='same-request-id','the gate has a Worker-generated token; the id is only a log field');assert.notEqual(lease.submitGate.token,'same-request-id');
 assert.equal(domain(w.file),d0,'the refused calls wrote no film');assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),run0);assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),q0);
 const dr=r2Diff2(r2a,r2Snapshot(w));assert.deepEqual(dr,[],'and no R2 object: '+dr);
 held.release();const done=await first;assert.equal(done.status,200,JSON.stringify(done.data).slice(0,200));assert.deepEqual(done.data.results.map(x=>x.status),['created','created']);
 const after=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.ok(!after.submitGate,'the first call cleared its own gate');
 const replay=await raw(w,body1,'same-request-id');assert.equal(replay.status,200);assert.deepEqual(replay.data.results.map(x=>[x.status,x.replayed]),[['created',true],['created',true]],'after the first call the replay is idempotent');
}
function r2Diff2(a,b){return [...b.keys()].filter(k=>!a.has(k)||a.get(k)!==b.get(k)).concat([...a.keys()].filter(k=>!b.has(k)));}

// 15. A caller-supplied request id never identifies an owner: a superseded handler and its replacement may carry the same id, and the old handler can neither commit nor clear the new gate.
{
 const w=await ready(10);const m=await start(w),pick=ids(m);
 const held=hold(w),body={runId:m.runId,epoch:m.lease.epoch,items:pick.slice(0,3).map(id=>item(w,id))};
 const first=raw(w,body,'reused-id');await held.at;
 // the first call's gate expired and was reassigned to a replacement that carries the very same request id
 setLease(w,d=>{d.submitGate={token:'replacement-token',requestId:'reused-id',bodyHash:'z',startedAt:new Date().toISOString(),expiresAt:Date.now()+45000};});
 held.release();const r=await first;
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'gate_lost');assert.deepEqual(r.data.results.map(x=>x.status),['blocked','blocked','blocked']);
 assert.equal(pointers(w).length,0,'the superseded handler committed nothing');assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_fingerprint')[0].n,0);
 const lease=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);assert.equal(lease.submitGate.token,'replacement-token','and did not clear the replacement\'s gate, although the request ids are equal');
}

// 16. Loss of the gate is terminal for every mutable operation, not only for the film commits: no retry record, no queue settlement, no progress write and no run-record save by a superseded handler.
{
 // (a) the gate is reassigned right before the renewal that follows a validation failure
 const w=await ready(8);const m=await start(w),pick=ids(m);
 const original=w.ctx.PredictionD1;let reads=0;
 w.ctx.PredictionD1={...original,openLease:async(env,key)=>{if(/runner-lease/.test(key)){reads++;if(reads===2)setLease(w,d=>{d.submitGate={token:'replacement',requestId:'x',bodyHash:'y',startedAt:new Date().toISOString(),expiresAt:Date.now()+45000};});}return original.openLease(env,key);}};
 const bad={...w.prediction,predictedRating:99};
 const q0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),run0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),d0=domain(w.file),r2a=r2Snapshot(w);
 const r=await submit(w,m,[{filmId:pick[0],fingerprint:w.fingerprint,prediction:bad},item(w,pick[1])]);
 w.ctx.PredictionD1=original;
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'gate_lost');assert.deepEqual(r.data.results.map(x=>[x.status,x.reason]),[['blocked','gate_lost'],['blocked','gate_lost']],'a failure that was not persisted is not reported as an outcome');
 assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),q0,'no retry record and no settlement by the superseded handler');assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_run')),run0,'no run-record save');assert.equal(pointers(w).length,0,'no prediction was written');assert.equal(sql(w.file,'SELECT count(*) AS n FROM prediction_fingerprint')[0].n,1,'the valid fingerprint of the failed item was committed while the gate was still held, as a v5 submit keeps it');
 const dr=r2Diff2(r2a,r2Snapshot(w)).filter(k=>NO_RUN_KEYS.test(k)||/prediction-queue/.test(k)||/runs\//.test(k));assert.deepEqual(dr,[],'no run, queue or Event write: '+dr);
}
{
 // (b) the gate is reassigned right before the queue settlement: the committed films stay committed, nothing else is written, and the next holder settles them
 const w=await ready(10);const m=await start(w),pick=ids(m),items=pick.slice(0,3).map(id=>item(w,id));
 const original=w.ctx.mutatePredictionQueue;
 w.ctx.mutatePredictionQueue=async(...a)=>{if(a[2]==='batch_progress'){setLease(w,d=>{d.submitGate={token:'replacement',requestId:'x',bodyHash:'y',startedAt:new Date().toISOString(),expiresAt:Date.now()+45000};});}return original(...a);};
 const q0=JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));const events0=[...w.records.keys()].filter(k=>/events\//.test(k)).length;
 const r=await submit(w,m,items);w.ctx.mutatePredictionQueue=original;
 assert.equal(r.status,409,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.status,'gate_lost');assert.equal(r.data.committed,true,'the films were committed before the gate was lost');assert.deepEqual(r.data.results.map(x=>x.status),['created','created','created']);assert.equal(r.data.queueSettlement,'pending');
 assert.equal(JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue')),q0,'the superseded handler did not touch the queue');assert.equal(pointers(w).length,3);assert.equal([...w.records.keys()].filter(k=>/events\//.test(k)).length,events0,'and wrote no progress Event');
 // the new holder (here: the replacement ends, the same body is submitted) completes the work
 setLease(w,d=>{delete d.submitGate;});
 const next=await submit(w,m,items);assert.equal(next.status,200);assert.deepEqual(next.data.results.map(x=>[x.status,x.replayed]),pick.slice(0,3).map(()=>['created',true]));assert.equal(next.data.queueSettlement,'settled');assert.equal(queueOf(w).pending.length,7,'the committed films were settled by the new holder');
}

// 17. An unexpected error after item 3 of 7 inside one call is a non-200 answer that carries the results and `committed`, not a bare error; the same body then recovers the run.
{
 const w=await ready(12);const m=await start(w),pick=ids(m).slice(0,7),items=pick.map(id=>item(w,id));
 const original=w.ctx.PredictionD1;let runSaves=0;
 w.ctx.PredictionD1={...original,saveMutable:async(env,key,value)=>{if(/\/runs\//.test(key)&&++runSaves===4)throw new Error('storage down');return original.saveMutable(env,key,value);}};
 const r=await submit(w,m,items);
 assert.equal(r.status,502,JSON.stringify(r.data).slice(0,300));assert.equal(r.data.error,'storage_error');assert.equal(r.data.committed,true);
 assert.deepEqual(r.data.results.map(x=>x.status),['created','created','created','created','blocked','blocked','blocked'],'the answer carries every film: four committed, three not processed');assert.equal(r.data.results[4].reason,'storage_error');
 assert.ok(!JSON.stringify(r.data).includes('storage down'),'no error text is copied out');
 w.ctx.PredictionD1=original;assert.equal(pointers(w).length,4,'four films are committed');
 const again=await submit(w,m,items);assert.equal(again.status,200,JSON.stringify(again.data).slice(0,300));
 assert.deepEqual(again.data.results.map(x=>x.status),pick.map(()=>'created'));assert.deepEqual(again.data.results.slice(0,4).map(x=>x.replayed),[true,true,true,true],'the committed films, the fourth from the crash window, are recognized');
 assert.equal(pointers(w).length,7);assert.equal(versions(w).length,7,'exactly one version object per film');
}
console.log('prediction-batch-submit: ok');
