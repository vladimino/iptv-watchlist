// AIR-477 (ADR 0165, Proposed): the owner-only scoped prediction recovery intent. Pure rules first, then the real Worker code with the
// prediction domain in D1 mode over the sqlite D1 stand-in and an in-memory R2: preview writes nothing; confirm writes one fenced batch of
// intent rows and nothing else; the ordinary queue rebuild and the ordinary batch v2 runner re-score exactly the confirmed films; the
// first new version satisfies the intent; replay, scope mismatch, stale pointers, an r2 marker, a missing schema, a crash before the
// batch, cancel, identity refusals and the retry budget all refuse or settle honestly. Nothing here calls a model, TMDB, Cloudflare or
// production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import * as Intent from '../src/prediction-recovery-intent.js';
import * as FilmPersonAuthority from '../src/film-person-authority.js';
import * as CanonicalCatalogReader from '../src/canonical-catalog-reader.js';

// 1. Pure rules.
{
 const p={generatedAt:'2026-11-17T10:00:00.000Z',fingerprintHash:'fh1',tasteProfileHash:'ph'};
 assert.equal(Intent.predictionToken(p),'2026-11-17T10:00:00.000Z|fh1|ph');
 assert.equal(Intent.predictionToken({...p,generatedAt:null}),null,'a version without its generation time cannot be named');
 assert.equal(Intent.predictionToken({...p,fingerprintHash:''}),null);
 assert.equal(Intent.fingerprintToken({fingerprintHash:'fh1',generatedAt:'g'}),'fh1|g');
 assert.equal(Intent.fingerprintToken({fingerprintHash:'fh1'}),'fh1|');
 assert.deepEqual(Intent.parseRecoveryRequest({films:'b,a',mode:'prediction_only'}),{films:['a','b'],mode:'prediction_only',ttlHours:72});
 assert.equal(Intent.parseRecoveryRequest({films:'a,a'}).error,'duplicate_film');
 assert.equal(Intent.parseRecoveryRequest({films:''}).error,'films_required');
 assert.equal(Intent.parseRecoveryRequest({films:'a/b'}).error,'invalid_film');
 assert.equal(Intent.parseRecoveryRequest({films:Array.from({length:51},(_,i)=>'f'+i)}).error,'too_many_films');
 assert.equal(Intent.parseRecoveryRequest({films:'a',mode:'rescore_all'}).error,'invalid_mode');
 assert.equal(Intent.parseRecoveryRequest({films:'a',ttlHours:'169'}).error,'invalid_ttl');
 assert.equal(Intent.parseRecoveryRequest({films:'a',ttlHours:0}).error,'invalid_ttl');
 const base={filmId:'tmdb_7',profile:true,admitted:true,identity:{state:'ok',filmId:'film:tmdb:7',tmdb:'7',lid:null},state:{status:'recorded',prediction:p,fingerprint:{fingerprintHash:'fh1',generatedAt:'g'}},current:true,d1:{prediction:Intent.predictionToken(p),fingerprint:'fh1|g'},retryExhausted:false,activeIntent:null};
 const now=Date.parse('2026-11-17T12:00:00.000Z');
 const c=(over,mode='prediction_only')=>Intent.classifyRecoveryFilm({...base,...over},mode,now);
 assert.equal(c({}).outcome,'eligible');assert.equal(c({}).plan,'prediction_only');assert.equal(c({}).fingerprintToken,null);
 assert.equal(c({},'fingerprint_and_prediction').fingerprintToken,'fh1|g');
 assert.deepEqual([c({profile:false}).reason,c({state:{status:'unavailable'}}).reason,c({admitted:false}).reason],['profile_missing','film_unreadable','not_admitted']);
 assert.deepEqual([c({identity:{error:'film_person_held'}}).reason,c({identity:{state:'absent'}}).reason,c({identity:{state:'retired'}}).reason],['identity_unavailable','identity_absent','identity_retired']);
 assert.deepEqual([c({identity:{state:'conflict'}}).outcome,c({identity:{state:'ok',filmId:'film:tmdb:8',tmdb:'8'}}).reason],['conflict','identity_mismatch'],'a typed id that is not the Film’s trusted claim is a conflict, never a title/year match');
 assert.equal(c({retryExhausted:true}).reason,'retry_exhausted','the retry budget is never reset by an intent');
 assert.deepEqual([c({state:{...base.state,prediction:null}}).outcome,c({current:false}).outcome],['unchanged','unchanged'],'what the ordinary rule already queues needs no intent');
 assert.equal(c({state:{...base.state,prediction:{...p,generatedAt:null}}}).reason,'token_unbindable');
 assert.deepEqual([c({d1:{prediction:null}}).reason,c({d1:{prediction:'other'}}).reason],['pointer_absent','pointer_mismatch']);
 assert.equal(c({d1:{prediction:base.d1.prediction,fingerprint:'fh0|g'}},'fingerprint_and_prediction').reason,'pointer_mismatch');
 assert.equal(c({activeIntent:{predictionToken:base.d1.prediction,expiresAt:'2026-11-18T00:00:00.000Z'}}).reason,'active_intent');
 assert.equal(c({activeIntent:{predictionToken:base.d1.prediction,expiresAt:'2026-11-17T11:00:00.000Z'}}).outcome,'eligible','an expired intent is settled by the next confirmation');
 assert.equal(c({activeIntent:{predictionToken:'older',expiresAt:'2026-11-18T00:00:00.000Z'}}).outcome,'eligible','a satisfied intent is settled by the next confirmation');
 const scope={mode:'prediction_only',ttlHours:72,revision:0,authority:{mode:'d1'},films:[c({})]};
 const h=await Intent.recoveryScopeHash(scope);
 assert.equal(h,await Intent.recoveryScopeHash(structuredClone(scope)),'stable');
 assert.notEqual(h,await Intent.recoveryScopeHash({...scope,revision:1}),'another revision is another scope');
 assert.notEqual(h,await Intent.recoveryScopeHash({...scope,ttlHours:24}));
 assert.ok(Intent.validCohortId(await Intent.cohortIdFor('k'.repeat(16))));
}

// 2. The real Worker code over D1.
const T='2026-11-17T10:00:00.000Z';
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1";
async function world(films=6){
 const w=await flowWorld({films});
 Object.assign(w.ctx,{PredictionRecoveryIntent:Intent,FilmPersonAuthority,CanonicalCatalogReader,Headers,Uint32Array,DataView,atob,btoa,structuredClone,TextDecoder,
  ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[]});
 for(const [file,name] of [['src/domain/admin-query.js','AdminQuery'],['src/domain/data-health.js','DataHealth'],['src/domain/limbo-inventory.js','LimboInventory'],['src/domain/prediction-recovery.js','PredictionRecovery']])vm.runInContext(scoped(file,name),w.ctx);
 for(const file of ['src/admin/owner-reviews.js','src/admin/read.js','src/admin/limbo.js','src/prediction-diagnostics.js','src/admin/prediction-recovery.js','src/admin/prediction-recovery-intent.js'])vm.runInContext(fs.readFileSync(file,'utf8'),w.ctx);
 // Canonical identities: tmdb_1..n trusted; the last one is retired by a redirect, the one before it carries a conflicting claim.
 sql(w.file,VERIFY);
 // Production-faithful prediction marker (AIR-478 preflight, 18 Nov 2026): mode d1 with writes held. `writes` is the r2-mode gate; the
 // activation leaves it held, and every D1 writer checks mode d1 and its own CAS only.
 sql(w.file,"UPDATE prediction_domain_authority SET writes='held' WHERE id=1");
 assert.deepEqual(sql(w.file,'SELECT mode,writes FROM prediction_domain_authority'),[{mode:'d1',writes:'held'}]);
 const ids=Array.from({length:films},(_,i)=>i+1);
 sql(w.file,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+ids.map(n=>`('film:tmdb:${n}',1,'tmdb:${n}','Orig','${T}')`).join(','));
 sql(w.file,'INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES '+ids.map(n=>`('film:tmdb:${n}','tmdb','${n}',1,0,NULL)`).join(',')+`,('film:tmdb:${films-1}','tmdb','9${films-1}',0,1,NULL)`);
 sql(w.file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:${films}','film:tmdb:1','${T}')`);
 w.admin=async(path,{method='GET',body=null,owner=true}={})=>{
  const headers={'Content-Type':'application/json'};
  if(method==='POST'&&owner)Object.assign(headers,{Origin:'https://site.example','Cf-Access-Jwt-Assertion':'jwt','X-IPTV-Admin-Action':'prediction_recovery_intent'});
  const r=await w.ctx.worker.fetch(new Request('https://site.example/api/admin/prediction-recovery-intent/'+path,{method,headers,...(body?{body:JSON.stringify(body)}:{})}),w.env);
  return {status:r.status,data:await r.json()};
 };
 return w;
}
const start=async w=>{const r=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r.data;};
const submitAll=async(w,m,prediction=w.prediction)=>{const r=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:m.films.map(f=>({filmId:f.filmId,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction}))});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));return r.data;};
const complete=async(w,m,reason)=>{const r=await w.api('complete',{runId:m.runId,...(reason?{reason}:{})});assert.equal(r.status,200,JSON.stringify(r.data).slice(0,300));};
const queueDoc=w=>JSON.parse(sql(w.file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const outstanding=w=>{const q=queueDoc(w);return [...q.hotPending,...q.coldPending].sort();};
const pointers=w=>sql(w.file,'SELECT film_id,display_json FROM prediction_pointer ORDER BY film_id');
const history=w=>sql(w.file,'SELECT film_id,replaced_at,r2_key FROM prediction_lineage ORDER BY film_id,replaced_at');
const intents=w=>sql(w.file,'SELECT cohort_id,film_id,state,mode,fingerprint_token FROM prediction_recovery_intent ORDER BY film_id,created_at');
const revision=w=>sql(w.file,'SELECT revision FROM prediction_recovery_revision')[0].revision;
const domainImage=w=>JSON.stringify(['prediction_pointer','prediction_fingerprint','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_authority'].map(t=>sql(w.file,'SELECT * FROM '+t)));
const r2Image=w=>JSON.stringify([...w.records.entries()].sort(([a],[b])=>a.localeCompare(b)));
// Every film scored once by the ordinary runner.
async function scoredWorld(films=6){
 const w=await world(films);
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const m=await start(w);assert.equal(m.films.length,films);
 const s=await submitAll(w,m);assert.ok(s.results.every(x=>x.status==='created'));
 await complete(w,m);
 assert.deepEqual(outstanding(w),[],'every film is current');
 return w;
}
const key=n=>'owner-key-'+String(n).padStart(8,'0');

// 2a. Preview: per-film outcomes, the authority and runner facts, and zero writes to D1 or R2.
{
 const w=await scoredWorld(6);
 const d1Before=domainImage(w),r2Before=r2Image(w),writes=w.stats.writeBatches;
 const r=await w.admin('preview?films=tmdb_1,tmdb_2,tmdb_5,tmdb_6,tmdb_99&mode=prediction_only');
 assert.equal(r.status,200,JSON.stringify(r.data));
 const by=Object.fromEntries(r.data.films.map(f=>[f.filmId,f]));
 assert.deepEqual([by.tmdb_1.outcome,by.tmdb_2.outcome],['eligible','eligible']);
 assert.equal(by.tmdb_1.canonicalFilmId,'film:tmdb:1');assert.equal(by.tmdb_1.tmdb,'1');assert.equal(by.tmdb_1.plan,'prediction_only');
 assert.deepEqual([by.tmdb_5.outcome,by.tmdb_5.reason],['conflict','identity_conflict']);
 assert.deepEqual([by.tmdb_6.outcome,by.tmdb_6.reason],['blocked','identity_retired']);
 assert.deepEqual([by.tmdb_99.outcome,by.tmdb_99.reason],['blocked','not_admitted'],'a film outside the queue’s admission is refused (owner decision: v1 fails closed)');
 assert.deepEqual(r.data.counts,{eligible:2,unchanged:0,blocked:2,conflict:1});
 assert.equal(r.data.schema.ready,true);assert.equal(r.data.schema.revision,0);
 assert.deepEqual(r.data.authority.prediction.mode,'d1');assert.equal(r.data.authority.filmPerson.state,'open');
 assert.equal(r.data.budget.modelCallsEstimate,2);assert.equal(r.data.budget.externalCalls,0);
 assert.equal(r.data.confirmable,true);assert.match(r.data.scopeHash,/^[0-9a-f]{64}$/);
 const again=await w.admin('preview?films=tmdb_99,tmdb_6,tmdb_5,tmdb_2,tmdb_1&mode=prediction_only');
 assert.equal(again.data.scopeHash,r.data.scopeHash,'the allowlist is a set: the order does not change the scope');
 assert.equal(w.stats.writeBatches,writes,'preview: zero D1 write batches');
 assert.equal(domainImage(w),d1Before,'preview: D1 unchanged');assert.equal(r2Image(w),r2Before,'preview: R2 unchanged');
 assert.equal((await w.admin('preview?films=tmdb_1,tmdb_1')).data.refusal,'duplicate_film');
 assert.equal((await w.admin('preview',{method:'POST',body:{}})).status,405);
}

// 2b. Confirm, replay, conflict; the ordinary runner re-scores exactly the cohort; the intent is satisfied; nothing loops.
{
 const w=await scoredWorld(6);
 const scope='preview?films=tmdb_1,tmdb_2,tmdb_6&mode=prediction_only';
 const p=await w.admin(scope);
 const body={films:['tmdb_1','tmdb_2','tmdb_6'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(1)};
 assert.equal((await w.admin('confirm',{method:'POST',body,owner:false})).status,403,'owner headers are required');
 assert.deepEqual(intents(w),[]);
 const wrong=await w.admin('confirm',{method:'POST',body:{...body,scopeHash:'0'.repeat(64)}});
 assert.equal(wrong.status,409);assert.equal(wrong.data.refusal,'stale_scope');assert.deepEqual(intents(w),[]);
 const before={pointers:pointers(w),history:history(w),queue:queueDoc(w),r2:r2Image(w)};
 const ok=await w.admin('confirm',{method:'POST',body});
 assert.equal(ok.status,201,JSON.stringify(ok.data));
 assert.equal(ok.data.status,'confirmed');assert.deepEqual(ok.data.receipt.films.map(f=>f.filmId),['tmdb_1','tmdb_2']);
 assert.deepEqual(ok.data.receipt.skipped,[{filmId:'tmdb_6',outcome:'blocked',reason:'identity_retired'}],'bounded partial outcome: the blocked film is skipped and named');
 assert.deepEqual(intents(w).map(r=>[r.film_id,r.state]),[['tmdb_1','active'],['tmdb_2','active']]);
 assert.equal(revision(w),1);
 assert.deepEqual(pointers(w),before.pointers,'confirm writes no pointer');assert.deepEqual(history(w),before.history,'and no history');
 assert.deepEqual(queueDoc(w),before.queue,'and never touches the queue directly');assert.equal(r2Image(w),before.r2,'and no R2 object');
 // Replay: same key, same scope: the stored receipt, nothing new. Same key, another scope: conflict.
 const replay=await w.admin('confirm',{method:'POST',body});
 assert.equal(replay.status,200);assert.equal(replay.data.status,'replayed');assert.equal(replay.data.receipt.cohortId,ok.data.receipt.cohortId);
 assert.equal(intents(w).length,2);assert.equal(revision(w),1);
 const p2=await w.admin('preview?films=tmdb_3&mode=prediction_only');
 const clash=await w.admin('confirm',{method:'POST',body:{films:['tmdb_3'],mode:'prediction_only',ttlHours:72,scopeHash:p2.data.scopeHash,idempotencyKey:key(1)}});
 assert.equal(clash.status,409);assert.equal(clash.data.refusal,'idempotency_conflict');assert.equal(intents(w).length,2);
 // A second intent on a film with a pending one is a conflict in the preview.
 const dup=await w.admin('preview?films=tmdb_1');assert.deepEqual([dup.data.films[0].outcome,dup.data.films[0].reason],['conflict','active_intent']);
 // Status: pending until the runner commits.
 const status=await w.admin('cohort?id='+ok.data.receipt.cohortId);
 assert.deepEqual(status.data.cohort.films.map(f=>[f.filmId,f.status]),[['tmdb_1','pending'],['tmdb_2','pending']]);
 // The ordinary batch v2 start: the queue fails the advance gate on the new revision, is rebuilt the ordinary way, and holds exactly the cohort.
 const m=await start(w);
 assert.deepEqual(m.films.map(f=>f.filmId).sort(),['tmdb_1','tmdb_2'],'off-cohort films are not re-scored');
 assert.ok(m.films.every(f=>f.plan==='prediction_only'&&f.fingerprint),'prediction_only reuses the stored fingerprint');
 const q=queueDoc(w);assert.equal(q.recoveryRevision,1);assert.equal(q.recovery.denied,2);
 assert.deepEqual(q.work.tmdb_1,{class:'prediction_only',requiredWork:'prediction_only',migration:null,reason:'recovery_intent'});
 const s=await submitAll(w,m,{...w.prediction,predictedRating:4});
 assert.deepEqual(s.results.map(x=>[x.filmId,x.status]).sort(),[['tmdb_1','recalculated'],['tmdb_2','recalculated']],'the submit is not refused as already_current');
 await complete(w,m);
 const after=await w.admin('cohort?id='+ok.data.receipt.cohortId);
 assert.deepEqual(after.data.cohort.films.map(f=>f.status),['satisfied','satisfied']);
 assert.equal(history(w).length,before.history.length+2,'the replaced versions are kept in the lineage');
 for(const row of before.history)assert.ok(history(w).some(h=>h.r2_key===row.r2_key));
 for(const row of history(w))assert.ok(w.records.has(row.r2_key),'every immutable version body stays in R2');
 // No loop: a rebuild finds the cohort current again, and a new start has nothing.
 assert.equal((await w.api('queue/reconcile',{})).status,200);assert.deepEqual(outstanding(w),[]);
 const idle=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.notEqual(idle.data.status,'running');
 // A satisfied film can be recovered again later: the satisfied intent is settled by that confirmation.
 const p3=await w.admin('preview?films=tmdb_1&ttlHours=24');assert.equal(p3.data.films[0].outcome,'eligible');
 const again=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:24,scopeHash:p3.data.scopeHash,idempotencyKey:key(2)}});
 assert.equal(again.status,201,JSON.stringify(again.data));
 assert.deepEqual(intents(w).filter(r=>r.film_id==='tmdb_1').map(r=>r.state),['settled','active']);
}

// 2c. fingerprint_and_prediction: both versions are denied, the manifest asks for a new fingerprint; hot-first order is the ordinary one.
{
 const w=await scoredWorld(4);
 const p=await w.admin('preview?films=tmdb_2&mode=fingerprint_and_prediction');
 assert.equal(p.data.films[0].plan,'fingerprint_and_prediction');
 const ok=await w.admin('confirm',{method:'POST',body:{films:['tmdb_2'],mode:'fingerprint_and_prediction',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(3)}});
 assert.equal(ok.status,201,JSON.stringify(ok.data));assert.ok(intents(w)[0].fingerprint_token);
 // A never-predicted film admitted meanwhile: the intent changes no stored priority (same lane and rank below), but the batch gives the recovered film a recovery slot ahead of it (ADR 0197).
 const now=Date.now(),film={id:'tmdb_9',title:'tmdb_9',original:'tmdb_9',year:2020,tmdbId:'9',canonicalIdentity:'tmdb:9',genres:[],actors:[],directors:[],shows:[{start:now}]};
 sql(w.file,"INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, observation_key, programme_run_id, generation, state, payload_json) VALUES ('tmdb_9','9','movie','tmdb:9','tmdb_9','p1',1,'current','"+JSON.stringify(film)+"')");
 const m=await start(w);
 assert.deepEqual(m.films.map(f=>f.filmId),['tmdb_2','tmdb_9'],'the recovery slot is filled first, the ordinary queue fills the rest');
 assert.equal(m.films.find(f=>f.filmId==='tmdb_2').plan,'fingerprint_and_prediction','the stored fingerprint is not offered for reuse');
 const q=queueDoc(w);assert.deepEqual(q.priority.tmdb_2.rank,q.priority.tmdb_9.rank,'the same ordinary lane and rank');
 const s=await submitAll(w,m,{...w.prediction,predictedRating:2.5});
 assert.ok(s.results.every(x=>['created','recalculated'].includes(x.status)),JSON.stringify(s.results));
 await complete(w,m);
 const status=await w.admin('cohort?id='+ok.data.receipt.cohortId);assert.equal(status.data.cohort.films[0].status,'satisfied');
}

// 2d. Stale pointer and the global CAS: refusals write nothing.
{
 const w=await scoredWorld(4);
 const p=await w.admin('preview?films=tmdb_1,tmdb_2');
 // The pointer moves after the preview (an ordinary run committed a new version): the confirm's own preview differs.
 const row=pointers(w).find(r=>r.film_id==='tmdb_1'),display=JSON.parse(row.display_json);display.generatedAt='2026-11-17T11:11:11.111Z';
 sql(w.file,"UPDATE prediction_pointer SET display_json='"+JSON.stringify(display).replace(/'/g,"''")+"' WHERE film_id='tmdb_1'");
 const stale=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1','tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(4)}});
 assert.equal(stale.status,409);assert.equal(stale.data.refusal,'stale_scope');assert.deepEqual(intents(w),[]);assert.equal(revision(w),0);
 // The SQL fence itself: a token that no longer matches D1 fails the whole batch (the second film is not written either).
 const fresh=await w.admin('preview?films=tmdb_1,tmdb_2');assert.deepEqual(fresh.data.films.map(f=>f.outcome),['eligible','eligible']);
 const films=fresh.data.films.map(f=>f.filmId==='tmdb_2'?{...f,predictionToken:'moved|x|y'}:f);
 await assert.rejects(Intent.confirmCohort(w.env,{cohortId:await Intent.cohortIdFor(key(5)),idempotencyKey:key(5),scopeHash:fresh.data.scopeHash,mode:'prediction_only',ttlHours:72,revision:0,filmPersonGeneration:2,requestDigest:'a'.repeat(64),films}),e=>e.code==='recovery_cas');
 assert.deepEqual(intents(w),[]);assert.equal(revision(w),0);assert.deepEqual(sql(w.file,'SELECT * FROM prediction_recovery_cohort'),[]);
 // A concurrent confirmation moved the revision: the stale one fails whole.
 await assert.rejects(Intent.confirmCohort(w.env,{cohortId:await Intent.cohortIdFor(key(6)),idempotencyKey:key(6),scopeHash:fresh.data.scopeHash,mode:'prediction_only',ttlHours:72,revision:7,filmPersonGeneration:2,requestDigest:'a'.repeat(64),films:fresh.data.films}),e=>e.code==='recovery_cas');
 assert.deepEqual(intents(w),[]);
 assert.deepEqual(intents(w),[]);
}

// 2k. P1 of 18 Nov 2026: `writes` is the r2-mode gate and is NOT a D1 write gate. The whole suite runs at the production marker d1/held
// (world()); here the refusals: an r2 marker (open or held) in the preview, a d1 -> r2 move or an unreadable marker inside the confirm
// batch, and the triggers against a direct write. Every refusal leaves no cohort, no intent and the revision at 0.
const noRecoveryRows=(w,label)=>{assert.deepEqual(sql(w.file,'SELECT * FROM prediction_recovery_cohort'),[],label+': no cohort');assert.deepEqual(intents(w),[],label+': no intent');assert.equal(revision(w),0,label+': no revision');};
for(const writes of ['open','held']){
 const w=await scoredWorld(3);
 const p=await w.admin('preview?films=tmdb_1');assert.equal(p.data.confirmable,true);
 sql(w.file,`UPDATE prediction_domain_authority SET mode='r2', writes='${writes}' WHERE id=1`);
 // The preview itself, read after the move, is not confirmable: a d1-only refusal, or a fail-closed 503 when r2 storage is not readable.
 const pr=await w.admin('preview?films=tmdb_1');
 assert.ok(pr.status===503||(pr.status===200&&pr.data.confirmable===false&&pr.data.refusal==='prediction_domain_not_d1'),'r2/'+writes+': preview refuses: '+pr.status+' '+JSON.stringify(pr.data).slice(0,200));
 noRecoveryRows(w,'r2/'+writes+' preview');
 const r=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(20)}});
 assert.ok([409,503].includes(r.status),'r2/'+writes+' is refused: '+JSON.stringify(r.data));
 noRecoveryRows(w,'r2/'+writes);
 await assert.rejects(Intent.confirmCohort(w.env,{cohortId:await Intent.cohortIdFor(key(21)),idempotencyKey:key(21),scopeHash:p.data.scopeHash,mode:'prediction_only',ttlHours:72,revision:0,filmPersonGeneration:2,requestDigest:'a'.repeat(64),films:p.data.films}),e=>['recovery_cas','recovery_not_open'].includes(e.code),'r2/'+writes+': the module refuses');
 noRecoveryRows(w,'r2/'+writes+' module');
 // The triggers alone refuse a cohort row in r2 whatever writes says.
 assert.throws(()=>sql(w.file,"INSERT INTO prediction_recovery_cohort (cohort_id,idempotency_key,scope_hash,request_digest,mode,film_count,state,created_at,expires_at) VALUES ('pr_"+'0'.repeat(24)+"','"+key(22)+"','"+'b'.repeat(64)+"','"+'c'.repeat(64)+"','prediction_only',1,'active','2026-11-18T10:00:00.000Z','2026-11-19T10:00:00.000Z')"),/prediction_recovery_not_open/,'r2/'+writes+': trigger');
}
// Cancel shares OPEN_SQL: a cohort confirmed at d1/held cannot be cancelled once the marker is r2; the intents stay active, nothing moves.
for(const writes of ['open','held']){
 const w=await scoredWorld(3);
 const p=await w.admin('preview?films=tmdb_1');
 const ok=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(24)}});
 assert.equal(ok.status,201,JSON.stringify(ok.data));assert.equal(revision(w),1);
 sql(w.file,`UPDATE prediction_domain_authority SET mode='r2', writes='${writes}' WHERE id=1`);
 const c=await w.admin('cancel',{method:'POST',body:{cohortId:ok.data.receipt.cohortId}});
 assert.equal(c.status,409,'r2/'+writes+' cancel: '+JSON.stringify(c.data));
 assert.deepEqual(intents(w).map(r=>r.state),['active'],'r2/'+writes+': the intent is unchanged');
 assert.deepEqual(sql(w.file,'SELECT state FROM prediction_recovery_cohort'),[{state:'active'}]);assert.equal(revision(w),1,'r2/'+writes+': no revision move');
}
for(const [label,change] of [
 ['d1 -> r2 inside the batch',w=>sql(w.file,"UPDATE prediction_domain_authority SET mode='r2' WHERE id=1")],
 ['marker row unreadable inside the batch',w=>sql(w.file,'DELETE FROM prediction_domain_authority')],
]){
 const w=await scoredWorld(4);
 const p=await w.admin('preview?films=tmdb_1,tmdb_2');assert.equal(p.data.counts.eligible,2,label);
 w.hooks.write=statements=>{if(statements.some(s=>/INSERT INTO prediction_recovery_cohort/.test(s.text))){w.hooks.write=null;change(w);}};
 const r=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1','tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(23)}});
 assert.equal(r.status,409,label+': '+JSON.stringify(r.data));
 noRecoveryRows(w,label);
}
{
 // An unreadable marker before the preview: the preview fails closed, it does not answer confirmable.
 const w=await scoredWorld(2);
 sql(w.file,"PRAGMA ignore_check_constraints=ON;UPDATE prediction_domain_authority SET writes='bogus' WHERE id=1");
 const p=await w.admin('preview?films=tmdb_1');assert.equal(p.status,503,JSON.stringify(p.data));
 noRecoveryRows(w,'unreadable marker');
}

// 2e. A crash before the batch lands, then the replay; a live run is not disturbed; cancel stops only what is pending.
{
 const w=await scoredWorld(5);
 const p=await w.admin('preview?films=tmdb_1,tmdb_2');
 const body={films:['tmdb_1','tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(8)};
 w.hooks.write=statements=>{if(statements.some(s=>/prediction_recovery_cohort/.test(s.text)))throw new Error('D1 network lost');};
 const lost=await w.admin('confirm',{method:'POST',body});
 assert.equal(lost.status,503);assert.deepEqual(intents(w),[]);assert.deepEqual(sql(w.file,'SELECT * FROM prediction_recovery_cohort'),[]);assert.equal(revision(w),0);
 w.hooks.write=null;
 // A live v2 run holds the lease while the owner confirms: the run's manifest is its own; the intent waits for the next start.
 const ghost=JSON.parse(pointers(w).find(r=>r.film_id==='tmdb_3').display_json);ghost.tasteProfileHash='old';
 sql(w.file,"UPDATE prediction_pointer SET display_json='"+JSON.stringify(ghost).replace(/'/g,"''")+"' WHERE film_id='tmdb_3'");
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const live=await start(w);const liveIds=live.films.map(f=>f.filmId);
 const pLive=await w.admin('preview?films=tmdb_1,tmdb_2');assert.equal(pLive.data.runner.live,true);assert.equal(pLive.data.runner.runId,live.runId);
 const ok=await w.admin('confirm',{method:'POST',body:{...body,scopeHash:pLive.data.scopeHash}});
 assert.equal(ok.status,201,JSON.stringify(ok.data));
 const stored=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+live.runId+"'")[0].d);
 assert.deepEqual(stored.selectedIds,liveIds,'the live run’s manifest is unchanged');
 await submitAll(w,live);
 // The run's own settlement rebuilt the queue the ordinary way under the new revision: the cohort is now queued for the NEXT manifest.
 assert.deepEqual(outstanding(w),['tmdb_1','tmdb_2']);
 await complete(w,live,'manifest_spent');
 // Cancel before the next start: nothing is re-scored; cancel again is a replay.
 const cancel=await w.admin('cancel',{method:'POST',body:{cohortId:ok.data.receipt.cohortId}});
 assert.equal(cancel.status,200);assert.equal(cancel.data.status,'cancelled');
 assert.equal((await w.admin('cancel',{method:'POST',body:{cohortId:ok.data.receipt.cohortId}})).data.status,'already_cancelled');
 assert.deepEqual(intents(w).map(r=>r.state),['cancelled','cancelled']);
 const pointersBefore=pointers(w);
 const next=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});
 assert.ok(!next.data.films?.some(f=>['tmdb_1','tmdb_2'].includes(f.filmId)),'a cancelled intent re-scores nothing');
 assert.deepEqual(pointers(w).filter(r=>['tmdb_1','tmdb_2'].includes(r.film_id)),pointersBefore.filter(r=>['tmdb_1','tmdb_2'].includes(r.film_id)));
 assert.equal((await w.admin('cancel',{method:'POST',body:{cohortId:'pr_'+'0'.repeat(24)}})).status,404);
}

// 2f. An expired intent no longer applies; the retry budget is respected; the overlay ignores ids it was not given.
{
 const w=await scoredWorld(3);
 const p=await w.admin('preview?films=tmdb_1&ttlHours=1');
 assert.equal((await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:1,scopeHash:p.data.scopeHash,idempotencyKey:key(9)}})).status,201);
 const now=await Intent.readOverlay(w.env,Date.now());assert.equal(now.size,1);
 const later=await Intent.readOverlay(w.env,Date.now()+2*3600000);assert.equal(later.size,0,'an expired intent denies nothing');
 const display=JSON.parse(pointers(w).find(r=>r.film_id==='tmdb_1').display_json);
 assert.equal(now.deniesPrediction('tmdb_1',display),true);assert.equal(now.deniesPrediction('tmdb_2',display),false,'never another film');assert.equal(now.deniesPrediction(undefined,display),false,'never an unnamed film');
 // Retry budget: a film whose budget is exhausted stays out of the queue whatever the intent says.
 const q=queueDoc(w);q.retries={tmdb_1:{kind:'parse_error',scope:'item',attempts:10,retryAt:0,failedAt:new Date().toISOString(),lastRunId:'r'}};
 const text=JSON.stringify(q);sql(w.file,'DELETE FROM prediction_queue');sql(w.file,"INSERT INTO prediction_queue (seq,chunk_text,generation) VALUES (0,'"+text.replace(/'/g,"''")+"',"+sql(w.file,'SELECT queue_generation AS g FROM prediction_domain_authority')[0].g+")");
 const m=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});
 assert.ok(!m.data.films?.some(f=>f.filmId==='tmdb_1'),'retry_exhausted is respected');
}

// 2g. Without migration 0024 the capability is dormant: the runner is unaffected, preview says not ready, confirm refuses.
{
 const w=await scoredWorld(2);
 sql(w.file,'DROP TABLE prediction_recovery_intent;DROP TABLE prediction_recovery_cohort;DROP TABLE prediction_recovery_revision');
 const p=await w.admin('preview?films=tmdb_1');assert.equal(p.status,200);assert.equal(p.data.schema.ready,false);assert.equal(p.data.confirmable,false);assert.equal(p.data.refusal,'recovery_schema_not_ready');
 const c=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(10)}});
 assert.equal(c.status,409);assert.equal(c.data.refusal,'recovery_schema_not_ready');
 assert.equal((await Intent.readOverlay(w.env)).ready,false);
 assert.equal((await w.api('queue/reconcile',{})).status,200);assert.deepEqual(outstanding(w),[]);
 const q=queueDoc(w);assert.equal(q.recoveryRevision,undefined,'no stamp while the store is absent');
 assert.equal((await w.admin('cohort?id=pr_'+'0'.repeat(24))).data.schema.ready,false);
}

// 2h. Review of PR #734: an INSTALLED store that cannot be read fails closed. No rebuild, no queue write, the retry record survives.
// A world with one active intent (tmdb_1) whose film carries a saved retry record (attempts 1, future retryAt) and is outstanding.
async function retryWorld(){
 const w=await scoredWorld(4);
 const p=await w.admin('preview?films=tmdb_1');
 assert.equal((await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(11)}})).status,201);
 const m=await start(w);assert.deepEqual(m.films.map(f=>f.filmId),['tmdb_1']);
 const failed=await w.api('batch/submit',{runId:m.runId,epoch:m.lease.epoch,items:[{filmId:'tmdb_1',failure:{kind:'parse_error',reason:'json_unparseable'}}]});
 assert.equal(failed.status,200,JSON.stringify(failed.data).slice(0,300));
 await complete(w,m,'manifest_spent');
 const saved=queueDoc(w);assert.equal(saved.retries.tmdb_1.attempts,1);assert.ok(saved.retries.tmdb_1.retryAt>Date.now(),'the backoff is recorded');
 assert.ok([...saved.hotPending,...saved.coldPending].includes('tmdb_1'),'the recovery film is outstanding with its retry record');
 return {w,saved};
}
const queueRows=w=>JSON.stringify(sql(w.file,'SELECT * FROM prediction_queue'));
// Both ordinary rebuild paths refuse and leave the stored queue byte-identical.
async function refusesWithoutWrite(w,label){
 const before=queueRows(w);
 assert.notEqual((await w.api('queue/reconcile',{})).status,200,label+': the forced rebuild refuses');
 const forced=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled'});assert.notEqual(forced.data.status,'running',label+': no run starts');
 assert.equal(queueRows(w),before,label+': no queue write');
}
{
 const {w,saved}=await retryWorld();
 // A D1 fault on the intent store only: every read of it throws.
 const prepare=w.db.prepare.bind(w.db);let fault=true;
 w.db.prepare=text=>{if(fault&&/prediction_recovery_/.test(text))throw new Error('D1_ERROR: network connection lost');return prepare(text);};
 assert.equal(await Intent.readOverlay(w.env).then(()=>'read',e=>e.code),'recovery_unavailable','an installed store that cannot be read is not "no intents"');
 await refusesWithoutWrite(w,'read fault');
 fault=false;
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const after=queueDoc(w);
 assert.deepEqual([after.retries.tmdb_1.attempts,after.retries.tmdb_1.retryAt],[saved.retries.tmdb_1.attempts,saved.retries.tmdb_1.retryAt],'attempts and retryAt are preserved after recovery');
 assert.ok([...after.hotPending,...after.coldPending].includes('tmdb_1'));
 // Malformed contents are unreadable, not empty.
 sql(w.file,"DROP TRIGGER prediction_recovery_intent_transition;PRAGMA ignore_check_constraints=ON;UPDATE prediction_recovery_intent SET mode='nonsense' WHERE film_id='tmdb_1'");
 assert.equal(await Intent.readOverlay(w.env).then(()=>'read',e=>e.code),'recovery_unavailable','a malformed row fails closed');
 await refusesWithoutWrite(w,'malformed row');
}
// A partial table set is not the absent schema, whichever table is missing (the cohort table is not otherwise named by the intent read).
for(const table of ['prediction_recovery_cohort','prediction_recovery_intent','prediction_recovery_revision']){
 const {w,saved}=await retryWorld();
 sql(w.file,'DROP TABLE '+table);
 assert.equal(await Intent.readOverlay(w.env).then(()=>'read',e=>e.code),'recovery_schema_partial',table+' missing');
 await refusesWithoutWrite(w,table+' missing');
 const kept=queueDoc(w);assert.deepEqual([kept.retries.tmdb_1.attempts,kept.retries.tmdb_1.retryAt],[saved.retries.tmdb_1.attempts,saved.retries.tmdb_1.retryAt],table+': the retry record survives');
 assert.equal((await w.admin('preview?films=tmdb_2')).status,503,table+': preview refuses');
}

// 2j. Review of PR #734: a replay must repeat the original request, not only its scope hash; the scope hash covers the per-film retry
// record and lane, and deliberately not the runner lease (a heartbeat between preview and confirm keeps the scope).
{
 const {w}=await retryWorld();
 const first=sql(w.file,"SELECT scope_hash AS h FROM prediction_recovery_cohort")[0].h;
 for(const [label,body] of [['other films',{films:['tmdb_2']}],['other mode',{films:['tmdb_1'],mode:'fingerprint_and_prediction'}],['other TTL',{films:['tmdb_1'],ttlHours:24}]]){
  const r=await w.admin('confirm',{method:'POST',body:{mode:'prediction_only',ttlHours:72,...body,scopeHash:first,idempotencyKey:key(11)}});
  assert.equal(r.status,409,label);assert.equal(r.data.refusal,'idempotency_conflict',label);
 }
 const same=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1'],mode:'prediction_only',ttlHours:72,scopeHash:first,idempotencyKey:key(11)}});
 assert.equal(same.data.status,'replayed','the original request still replays');
 assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_recovery_cohort')[0].n,1);
 // tmdb_1 (outstanding, with its retry record) shows in the preview beside an eligible film; a retry change between preview and confirm is another scope.
 const p=await w.admin('preview?films=tmdb_1,tmdb_2');
 assert.deepEqual(p.data.films.find(f=>f.filmId==='tmdb_1').retry.attempts,1);assert.equal(p.data.films.find(f=>f.filmId==='tmdb_2').outcome,'eligible');
 const q=queueDoc(w);q.retries.tmdb_1.attempts=2;q.retries.tmdb_1.retryAt+=3600000;
 sql(w.file,'DELETE FROM prediction_queue');sql(w.file,"INSERT INTO prediction_queue (seq,chunk_text,generation) VALUES (0,'"+JSON.stringify(q).replace(/'/g,"''")+"',"+sql(w.file,'SELECT queue_generation AS g FROM prediction_domain_authority')[0].g+")");
 const stale=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1','tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(13)}});
 assert.equal(stale.status,409);assert.equal(stale.data.refusal,'stale_scope','a changed retry record is another scope');
 // A live run's heartbeat between preview and confirm does not change the scope. tmdb_3 is made ordinarily stale so a run has work.
 const ghost=JSON.parse(pointers(w).find(r=>r.film_id==='tmdb_3').display_json);ghost.tasteProfileHash='old';
 sql(w.file,"UPDATE prediction_pointer SET display_json='"+JSON.stringify(ghost).replace(/'/g,"''")+"' WHERE film_id='tmdb_3'");
 assert.equal((await w.api('queue/reconcile',{})).status,200);
 const live=await start(w);
 const p2=await w.admin('preview?films=tmdb_2');assert.equal(p2.data.runner.live,true);
 assert.equal((await w.api('heartbeat',{runId:live.runId,epoch:live.lease.epoch})).status,200);
 const ok=await w.admin('confirm',{method:'POST',body:{films:['tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p2.data.scopeHash,idempotencyKey:key(14)}});
 assert.equal(ok.status,201,JSON.stringify(ok.data));
}

// 2i. Review of PR #734: the confirmation batch asserts the previewed identity and Film/Person marker again. A change after the server's
// last preview and before the batch rolls back everything: no cohort, no intent, no revision.
for(const [label,change] of [
 ['redirect (retired Film)',w=>sql(w.file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:1','film:tmdb:2','${T}')`)],
 ['conflicting trusted claim',w=>sql(w.file,"UPDATE film_external_id SET conflicting=1 WHERE film_id='film:tmdb:1' AND scheme='tmdb'")],
 ['claim moved to another Film',w=>sql(w.file,"UPDATE film_external_id SET film_id='film:tmdb:2' WHERE film_id='film:tmdb:1' AND scheme='tmdb'")],
 ['a second claim of the frozen id',w=>sql(w.file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:2','tmdb','1',0,0,NULL)")],
 ['Film/Person marker held',w=>sql(w.file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1")],
]){
 const w=await scoredWorld(4);
 const p=await w.admin('preview?films=tmdb_1,tmdb_2');assert.equal(p.data.counts.eligible,2,label);
 w.hooks.write=statements=>{if(statements.some(s=>/INSERT INTO prediction_recovery_cohort/.test(s.text))){w.hooks.write=null;change(w);}};
 const r=await w.admin('confirm',{method:'POST',body:{films:['tmdb_1','tmdb_2'],mode:'prediction_only',ttlHours:72,scopeHash:p.data.scopeHash,idempotencyKey:key(12)}});
 assert.equal(r.status,409,label+': '+JSON.stringify(r.data));assert.equal(r.data.refusal,'recovery_cas',label);
 assert.deepEqual(sql(w.file,'SELECT * FROM prediction_recovery_cohort'),[],label+': no cohort');assert.deepEqual(intents(w),[],label+': no intent');assert.equal(revision(w),0,label+': no revision');
}

// 3. Source boundaries: the GET routes read through a get-only bucket; the confirm writes only through the intent module.
{
 const route=fs.readFileSync('src/admin/prediction-recovery-intent.js','utf8');
 assert.doesNotMatch(route,/saveJSON|mergeStoredJSON|refreshPredictionQueue|mutatePredictionQueue|BUCKET\.(?:put|list|delete)|\.put\(|\bfetch\(|runnerLease\(|\.prepare\(|hotPending\s*=|coldPending\s*=/,'the route itself never writes storage, the queue or a lease');
 const module=fs.readFileSync('src/prediction-recovery-intent.js','utf8');
 assert.doesNotMatch(module,/prediction_queue|prediction_lease|prediction_lineage|INSERT INTO prediction_pointer|UPDATE prediction_pointer|DELETE FROM|BUCKET/,'the store never names the queue, a lease, the history, a pointer write, a delete or R2');
 const recovery=fs.readFileSync('src/domain/prediction-recovery.js','utf8');
 assert.match(recovery,/PREDICTION_RECOVERY_WRITER = Object\.freeze\(\{exists: false, decision: 'no_go'\}\)|PREDICTION_RECOVERY_WRITER=Object\.freeze\(\{exists:false,decision:'no_go'\}\)/,'the read-only assessment keeps saying no targeted writer exists');
 assert.match(fs.readFileSync('src/worker.js','utf8'),/url\.pathname\.startsWith\('\/api\/admin\/prediction-recovery-intent\/'\)\)return await adminPredictionRecoveryIntentRoute\(request,env,url\)/);
 const build=fs.readFileSync('build.mjs','utf8');
 assert.ok(build.indexOf("scoped('src/prediction-recovery-intent.js','PredictionRecoveryIntent')")<build.indexOf("fs.readFileSync('src/enrichment.js','utf8')"),'the store precedes the freshness rule in the bundle');
}
console.log('prediction recovery intent: ok');
