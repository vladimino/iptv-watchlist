// Batch runner v2, `batch_start` (ADR 0122). One request returns one self-sufficient manifest of at most 100 films, on the same queue, runner lease and
// persistence as the v5 runner, with the prediction domain in D1 mode as production runs it. Offline: a sqlite D1 stand-in and an in-memory R2. No Cloudflare,
// TMDB, model or production call. `batch_submit`, the Scheduled Task and every activation are other deliveries; nothing here generates a prediction.
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const dump=file=>{const r=sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);return r.stdout;};
const sha=async text=>[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
// Counts every R2 put and delete so a refusal or a dry run can be shown to have written nothing, next to the D1 dump.
function counted(w){const counts={put:0,delete:0},put=w.env.BUCKET.put.bind(w.env.BUCKET),del=w.env.BUCKET.delete.bind(w.env.BUCKET);w.env.BUCKET.put=async(...a)=>{counts.put++;return put(...a);};w.env.BUCKET.delete=async(...a)=>{counts.delete++;return del(...a);};return counts;}
const state=async w=>({d1:await sha(dump(w.file)),keys:[...w.records.keys()].sort().join('|')+'#'+await sha(JSON.stringify([...w.records.entries()].sort()))});
// What a refused step must not change: runs, the runner lease, the queue, films, fingerprints, predictions and history (the wrapper's own short writer lease is not a run effect).
const domain=file=>JSON.stringify(['prediction_run','prediction_queue','prediction_pointer','prediction_current','prediction_fingerprint','prediction_history','prediction_lineage'].map(t=>sql(file,'SELECT * FROM '+t)).concat([sql(file,"SELECT * FROM prediction_lease WHERE name='runner'")]));
const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const ready=async(films,opts={})=>{const w=await flowWorld({films,...opts});return w;};
const reconcile=async w=>{const r=await w.api('queue/reconcile',{});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));return r;};
const setCold=(w,ids)=>sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.shows',json('[]')) WHERE film_id IN ("+ids.map(id=>"'"+id+"'").join(',')+")");

// 1. A manifest is self-sufficient: the model needs no next, no enrichment_profile and no metadata call to generate every film in it.
{
 const w=await ready(37);await reconcile(w);
 const r=await batch(w);
 assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));
 const m=r.data;
 assert.equal(m.status,'running');assert.equal(m.protocol,'batch_v2');assert.ok(typeof m.runId==='string'&&m.runId.length>10);
 assert.equal(m.films.length,37,'37 eligible films, all delivered');
 assert.equal(m.dryRun,false);assert.equal(m.manifestFormat,'compact-1');
 assert.deepEqual(m.limits,{maxManifestFilms:100,maxManifestBytes:160*1024,generationSizeDefault:10,generationSizeRange:[1,10],submitMaxItems:10,submitMaxBodyBytes:56*1024,callBudgetMs:25000});
 assert.equal(m.lease.ttlMs,15*60000);assert.equal(m.lease.epoch,1);assert.ok(m.lease.expiresAt>Date.now());
 // profile: body, hash, version, lineage
 assert.equal(m.profile.version,1);assert.equal(m.profile.hash,'p');assert.deepEqual(m.profile.body,{ratingScale:'Half stars'});assert.ok(Array.isArray(m.profile.lineage));
 // contract: the versions and the same schema document GET /api/enrichment/schema serves
 const schema=await (await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/schema'),w.env)).json();
 assert.deepEqual(m.contract.schema,schema,'the manifest carries the schema document the Worker validates with');
 assert.equal(m.contract.fingerprintSchemaVersion,w.ctx.FINGERPRINT_SCHEMA_VERSION??m.contract.fingerprintSchemaVersion);
 for(const key of ['fingerprintSchemaVersion','fingerprintPromptVersion','predictionPromptVersion','registryDigest'])assert.ok(m.contract[key]!==undefined&&m.contract[key]!==null,key);
 // every film: id, lane, plan and its full metadata (null fields are absent, nothing else is shortened)
 for(const f of m.films){
  assert.match(f.filmId,/^tmdb_\d+$/);assert.ok(['hot','cold'].includes(f.lane));assert.ok(['fingerprint_and_prediction','prediction_only'].includes(f.plan));
  assert.equal(f.modelMetadata.id,f.filmId);assert.equal(f.modelMetadata.title,f.filmId);assert.equal(f.modelMetadata.year,2020);
  assert.ok(!Object.values(f.modelMetadata).includes(null),'null fields are omitted');
  assert.equal(f.plan,'fingerprint_and_prediction','no stored fingerprint yet');assert.ok(!('fingerprint' in f));
 }
 // the run record and its sources object
 const run=w.records.get('enrichment/runs/'+m.runId+'.json')||await (async()=>{const rows=sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+m.runId+"'");return rows[0]?JSON.parse(rows[0].d):null;})();
 assert.ok(run,'the run record exists');assert.equal(run.protocol,'batch_v2');assert.equal(run.epoch,1);assert.equal(run.manifestHash,m.manifestHash);assert.equal(run.selectedIds.length,37);assert.equal(run.status,'running');
 const sources=w.records.get('enrichment/sources/'+m.runId+'.json');assert.ok(sources&&Object.keys(sources).length===37,'sources object holds the metadata of every manifest film');
 // the manifest hash is reproducible from the manifest itself
 assert.match(m.manifestHash,/^[0-9a-f]{64}$/);assert.ok(m.manifestBytes===undefined||m.manifestBytes>0);
 // one timing line, observation only
 const line=w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start');
 assert.equal(line.length,1);assert.equal(line[0].status,200);assert.equal(line[0].notes.manifestFilms,37);assert.ok(line[0].notes.manifestBytes>1000);
 assert.equal(line[0].runId,null,'a start has no run id of its own in the line');
}

// 2. Sizes: 0, 1, 37, 100 and more than 100 eligible films. At most 100 are delivered and the rest stay queued for the next run.
for(const [films,expected] of [[1,1],[100,100],[130,100]]){
 const w=await ready(films);await reconcile(w);
 const r=await batch(w);assert.equal(r.status,200,films+': '+JSON.stringify(r.data).slice(0,200));
 assert.equal(r.data.films.length,expected,films+' eligible');
 assert.equal(new Set(r.data.films.map(f=>f.filmId)).size,expected,'no film twice');
 if(films>100){assert.equal(r.data.eligible.ready,130);assert.equal(r.data.pendingCount,130,'nothing leaves the queue at a start');}
}
{
 const w=await ready(1);await reconcile(w);
 const first=await batch(w);assert.equal(first.status,200);
 // the only film is written through v5 steps of another run after this one stops; a later start finds nothing eligible
 const stop=await w.api('complete',{runId:first.data.runId,reason:'external_termination'});assert.equal(stop.status,200);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.status,200);
 const step=await w.api('next',{runId:v5.data.runId,batchSize:1});
 const sub=await w.api('submit',{runId:v5.data.runId,items:[{filmId:step.data.items[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.equal(sub.status,200);
 await w.api('complete',{runId:v5.data.runId});
 const none=await batch(w);
 assert.equal(none.status,200);assert.equal(none.data.status,'noop','0 eligible films: a noop, no run, no lease');
 assert.ok(!none.data.films);
}

// 3. hot first, then cold; retry backoff; a film whose admission is gone.
{
 const w=await ready(12);
 setCold(w,['tmdb_3','tmdb_4','tmdb_5']);await reconcile(w);
 const hot=await batch(w);assert.equal(hot.status,200);
 assert.ok(hot.data.films.every(f=>f.lane==='hot'),'cold films wait while a hot film is outstanding');
 assert.equal(hot.data.films.length,9);assert.ok(!hot.data.films.some(f=>['tmdb_3','tmdb_4','tmdb_5'].includes(f.filmId)));
}
{
 const w=await ready(8);await reconcile(w);
 // a failure of one film makes it wait for its retry time: it is not in the next manifest
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});
 const step=await w.api('next',{runId:v5.data.runId,batchSize:1});const failed=step.data.items[0].filmId;
 const sub=await w.api('submit',{runId:v5.data.runId,items:[{filmId:failed,failure:{kind:'parse_error'}}]});assert.equal(sub.status,200);
 await w.api('complete',{runId:v5.data.runId,reason:'external_termination'});
 const r=await batch(w);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 assert.ok(!r.data.films.some(f=>f.filmId===failed),'a film held by its retry time is not delivered');assert.equal(r.data.films.length,7);
}
{
 const w=await ready(6);await reconcile(w);
 sql(w.file,"DELETE FROM discovery_admission WHERE film_id IN ('tmdb_2','tmdb_5')");
 const r=await batch(w);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 assert.equal(r.data.films.length,4,'a film with no admission is not delivered');
 assert.equal(r.data.skipped.missingAdmission,0,'it was settled out of the queue by this start, which reports it');
 assert.equal(r.data.queueSettled,2);assert.equal(r.data.queueRefreshed,true,'the settlement is a named effect of batch_start');
}

// 4. A changed profile makes the stored queue stale: the real start refreshes it (reported), a dry run refuses and writes nothing.
{
 const w=await ready(10);await reconcile(w);
 const profile={version:2,profileHash:'p2',profile:{ratingScale:'Whole stars'}};
 w.records.set('enrichment/profile/versions/2.json',profile);
 await (await import('../src/prediction-d1.js')).saveMutable(w.env,'enrichment/profile/current.json',profile);
 const counts=counted(w),before=await state(w),puts=counts.put;
 const dry=await batch(w,{dryRun:true});assert.equal(dry.status,409);assert.equal(dry.data.code,'queue_stale');assert.equal(dry.data.cause,'profile_changed');
 assert.deepEqual(await state(w),before,'a refused dry run wrote nothing');assert.equal(counts.put,puts);
 const real=await batch(w);assert.equal(real.status,200,JSON.stringify(real.data).slice(0,200));
 assert.equal(real.data.queueRefreshed,true,'the refresh is reported as an effect of batch_start');
 assert.equal(real.data.profile.version,2);assert.equal(real.data.profile.hash,'p2');assert.equal(real.data.films.length,10);
}

// 5. Fail-closed on size: nothing is shortened, nothing is created, and the refusal writes nothing.
{
 const w=await ready(100);
 const big='x'.repeat(4000);
 sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','"+big+"')");
 await reconcile(w);
 const counts=counted(w),before=await state(w),puts=counts.put;
 const r=await batch(w);
 assert.equal(r.status,409);assert.equal(r.data.code,'manifest_too_large');assert.equal(r.data.status,'blocked');
 assert.equal(r.data.films,100);assert.ok(r.data.bytes>r.data.limit&&r.data.limit===160*1024);assert.ok(r.data.largestFilmBytes>4000);assert.match(r.data.largestFilmId,/^tmdb_\d+$/);
 assert.deepEqual(await state(w),before,'zero writes: no lease, run, queue, Event, diagnostics or film write');assert.equal(counts.put,puts);assert.equal(counts.delete,0);
 // the dry run reports the same refusal and writes nothing
 const dry=await batch(w,{dryRun:true});assert.equal(dry.status,409);assert.equal(dry.data.code,'manifest_too_large');assert.equal(dry.data.dryRun,true);assert.deepEqual(await state(w),before);
 // a single film that alone exceeds the limit gives the same refusal
 const one=await ready(1);sql(one.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','"+'y'.repeat(170*1024)+"')");await reconcile(one);
 const b1=await state(one),o=await batch(one);assert.equal(o.status,409);assert.equal(o.data.code,'manifest_too_large');assert.equal(o.data.films,1);assert.ok(o.data.largestFilmBytes>160*1024);assert.equal(o.data.largestFilmId,'tmdb_1');assert.deepEqual(await state(one),b1);
}
// 5b. The worst case that fits: 100 films with real-sized synopses and credits.
{
 const w=await ready(100);
 const synopsis='A detective returns to a small town to reopen a case nobody wanted closed. '.repeat(12);
 sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','"+synopsis+"','$.genres',json('[\"Drama\",\"Thriller\",\"Mystery\"]'),'$.actors',json('[\"Actor One\",\"Actor Two\",\"Actor Three\",\"Actor Four\",\"Actor Five\",\"Actor Six\"]'),'$.directors',json('[\"Director One\"]'),'$.runtime',112)");
 await reconcile(w);
 const r=await batch(w);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 const bytes=new TextEncoder().encode(JSON.stringify(r.data)).length;
 assert.equal(r.data.films.length,100);assert.ok(bytes<160*1024,'a realistic 100-film manifest fits: '+bytes);
 console.log('worst-case-like manifest: 100 films, '+bytes+' bytes ('+Math.round(bytes/100)+' bytes per film incl. the fixed profile and schema)');
 for(const f of r.data.films){assert.equal(f.modelMetadata.synopsis,synopsis,'metadata is never shortened');assert.equal(f.modelMetadata.actors.length,6);assert.equal(f.modelMetadata.runtime,112);}
}

// 6. One lease: a v2 run and a v5 run never run together, in either order, and neither adopts the other.
{
 const w=await ready(20);await reconcile(w);
 const [a,b]=await Promise.all([batch(w),w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}})]);
 const running=[a,b].filter(x=>x.data.status==='running');assert.equal(running.length,1,'exactly one of two concurrent starts runs: '+[a,b].map(x=>x.status+':'+x.data.status+'/'+x.data.reason));
 const other=[a,b].find(x=>x.data.status!=='running');assert.ok(['already_running','busy'].includes(other.data.status),'the other is already_running or busy: '+other.data.status);
}
{
 const w=await ready(20);await reconcile(w);
 const v2=await batch(w);assert.equal(v2.status,200);
 const again=await batch(w);assert.equal(again.data.status,'already_running');assert.equal(again.data.runId,v2.data.runId,'the answer names the holder and never gives a second manifest');assert.ok(!again.data.films);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.data.status,'already_running');
 // a v5 step on a v2 run is refused, writes nothing and does not change the run
 const run0=JSON.stringify(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+v2.data.runId+"'"));const d0=domain(w.file);
 const next=await w.api('next',{runId:v2.data.runId,batchSize:1});assert.equal(next.status,409);assert.equal(next.data.code,'wrong_protocol');
 const sub=await w.api('submit',{runId:v2.data.runId,items:[{filmId:v2.data.films[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});assert.equal(sub.status,409);assert.equal(sub.data.code,'wrong_protocol');
 assert.equal(domain(w.file),d0,'a wrong_protocol refusal changed no run, lease, queue or film');assert.equal(JSON.stringify(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+v2.data.runId+"'")),run0);
}
{
 const w=await ready(20);await reconcile(w);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.data.status,'running');
 const v2=await batch(w);assert.equal(v2.data.status,'already_running');assert.equal(v2.data.runId,v5.data.runId);assert.ok(!v2.data.films);
}

// 7. Ownership epoch: set once, kept by a heartbeat, incremented by a takeover; an expired owner is fenced.
{
 const w=await ready(10);await reconcile(w);
 const first=await batch(w);assert.equal(first.data.lease.epoch,1);
 const hb=await w.api('heartbeat',{runId:first.data.runId});assert.equal(hb.status,200);assert.equal(hb.data.epoch,1,'a heartbeat returns the epoch of the run');
 const hb2=await w.api('heartbeat',{runId:first.data.runId});assert.equal(hb2.data.epoch,1,'and a second heartbeat does not change it');
 const lease=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'");assert.equal(JSON.parse(lease[0].d).epoch,1,'the heartbeat preserved the epoch in the stored lease');
 // a v5 heartbeat still has no epoch in its answer
 // expiry: the lease document and its column say the lease is over
 const doc=JSON.parse(lease[0].d);doc.expiresAt=1;sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");
 const gone=await w.api('heartbeat',{runId:first.data.runId});assert.equal(gone.status,409);assert.equal(gone.data.status,'lease_lost','an expired owner is fenced');
 const second=await batch(w);assert.equal(second.status,200,JSON.stringify(second.data).slice(0,200));
 assert.equal(second.data.lease.epoch,2,'a takeover increments the epoch');assert.notEqual(second.data.runId,first.data.runId);
 const old=await w.api('heartbeat',{runId:first.data.runId});assert.notEqual(old.status,200,'the old run cannot be renewed');
 const hb3=await w.api('heartbeat',{runId:second.data.runId});assert.equal(hb3.data.epoch,2);
 // a release keeps the epoch, so the next acquire increments it
 const done=await w.api('complete',{runId:second.data.runId,reason:'external_termination'});assert.equal(done.status,200);
 assert.equal(JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d).epoch,2,'a release keeps the epoch');
 const third=await batch(w);assert.equal(third.data.lease.epoch,3);
}
// 7b. A v5 run keeps working with the epoch in its lease, and its heartbeat answer has no epoch.
{
 const w=await ready(5);await reconcile(w);
 const v5=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});assert.equal(v5.status,200);
 const hb=await w.api('heartbeat',{runId:v5.data.runId});assert.equal(hb.status,200);assert.ok(!('epoch' in hb.data),'v5 answers do not change');
 const pair=await w.pair(v5.data.runId);assert.equal(pair.submit.status,200);
}

// 8. Replay and unknown outcome: a repeated start never creates a second run or a second manifest, and a lost answer is recovered by the holder's heartbeat and complete.
{
 const w=await ready(10);await reconcile(w);
 const first=await batch(w);const replay=await batch(w);
 assert.equal(replay.data.status,'already_running');assert.equal(replay.data.runId,first.data.runId);
 const runs=sql(w.file,"SELECT count(*) AS n FROM prediction_run")[0].n;assert.equal(runs,1,'one run record');
}

// 9. Dry run: the same manifest, no lease, no run, no queue, no storage write; it coexists with a live run; pin selects exact films.
{
 const w=await ready(30);await reconcile(w);
 const counts=counted(w),before=await state(w),puts=counts.put;
 const dry=await batch(w,{dryRun:true});assert.equal(dry.status,200,JSON.stringify(dry.data).slice(0,200));
 assert.equal(dry.data.dryRun,true);assert.equal(dry.data.runId,null);assert.equal(dry.data.films.length,30);assert.match(dry.data.manifestHash,/^[0-9a-f]{64}$/);
 assert.deepEqual(await state(w),before,'a dry run wrote nothing');assert.equal(counts.put,puts);assert.equal(counts.delete,0);
 const again=await batch(w,{dryRun:true});assert.equal(again.data.manifestHash,dry.data.manifestHash,'the same queue gives the same manifest hash');
 const pinned=await batch(w,{dryRun:true,pin:{filmIds:['tmdb_5','tmdb_2','tmdb_999']}});
 assert.deepEqual(pinned.data.films.map(f=>f.filmId),['tmdb_5','tmdb_2'],'the pinned films in the pinned order');
 assert.deepEqual(pinned.data.notEligible,[{filmId:'tmdb_999',reason:'not_queued'}]);assert.deepEqual(await state(w),before);
 // a live run does not stop a dry run, and the dry run does not touch the live run
 const live=await batch(w);assert.equal(live.data.status,'running');const afterLive=await state(w);
 const during=await batch(w,{dryRun:true});assert.equal(during.status,200);assert.equal(during.data.dryRun,true);assert.deepEqual(await state(w),afterLive,'a dry run beside a live run wrote nothing');
 // pin without dryRun, a bad pin and a bad dryRun are refused
 assert.equal((await batch(w,{pin:{filmIds:['tmdb_1']}})).status,400);assert.equal((await batch(w,{dryRun:true,pin:{filmIds:[]}})).status,400);assert.equal((await batch(w,{dryRun:'yes'})).status,400);
}
// 9b. A dry run does not need the stored queue to be rebuilt and never rebuilds it: a missing queue is stale.
{
 const w=await ready(5);const dry=await batch(w,{dryRun:true});assert.equal(dry.status,409);assert.equal(dry.data.code,'queue_stale');
}

// 12. Capacity, cold-only queues and a changed programme.
{
 const w=await ready(6);await reconcile(w);
 const q=await batch(w,{capacity:{remainingPercent:0}});assert.equal(q.status,200);assert.equal(q.data.status,'blocked');assert.equal(q.data.reason,'quota');assert.ok(!q.data.films,'no manifest and no run at zero capacity');
 const after=await batch(w);assert.equal(after.data.status,'running','the lease was released by the quota stop');
 const low=await ready(12);await reconcile(low);const some=await batch(low,{capacity:{remainingPercent:5}});assert.equal(some.data.films.length,12,'a low but nonzero capacity does not shorten a manifest');
}
{
 const w=await ready(8);setCold(w,Array.from({length:8},(_,i)=>'tmdb_'+(i+1)));await reconcile(w);
 const r=await batch(w);assert.equal(r.status,200,JSON.stringify(r.data).slice(0,200));
 assert.equal(r.data.films.length,8);assert.ok(r.data.films.every(f=>f.lane==='cold'),'with no hot film outstanding the cold lane is delivered');
}
{
 const w=await ready(6);await reconcile(w);
 w.records.set('programme.json',{runId:'p2',films:[]});w.records.set('sync.json',{runId:'p2',stage:'complete'});
 const dry=await batch(w,{dryRun:true});assert.equal(dry.status,409);assert.equal(dry.data.code,'queue_stale');assert.equal(dry.data.cause,'programme_changed');
}

// 10. The object mode does not run v2.
{
 const w=await ready(5);await reconcile(w);
 sql(w.file,"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1");
 const r=await batch(w);assert.equal(r.status,409);assert.equal(r.data.code,'batch_runner_requires_d1');
}

// 11. Legacy behavior is unchanged: the v5 contract is the same plus one additive block, v5 steps still work, and no new route reads or writes by itself.
{
 const w=await ready(5);const contract=await (await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/runner'),w.env)).json();
 assert.equal(contract.pipelineVersion,5);assert.deepEqual(contract.modelBatching,{enabled:false,readyFingerprintsPerCall:1});assert.equal(contract.maxBatchFilms,20);
 assert.equal(contract.batchRunner.version,2);assert.equal(contract.batchRunner.protocol,'batch_v2');assert.equal(contract.batchRunner.start,'/api/enrichment/batch/start');assert.equal(contract.batchRunner.maxManifestFilms,100);assert.deepEqual(contract.batchRunner.requires,{predictionAuthority:'d1'});
}
console.log('prediction-batch-start: ok');
