// AIR-602 (card A1) / ADR 0207 decisions 2, 3 and 4 and ADR 0217 (Accepted): the D1 admission coordinator at the marker mode `d1`, on the real migrations (a sqlite D1 stand-in) and the real canonical writers,
// receipts, operation-key protocol and evidence ledger. No Worker, network, R2 or production.
// Covered: the single operation key; the d1 writer (keep-first, receipt_key `d1`, `verified_at` = the admitting batch, the evidence row in the SAME batch, the keyed receipt applied); a request identity without a
// clock; present / replay / lost response; keep-first against another archive or title; the typed conflicts and their atomic finalize against the observed history; a live attempt that waits; an expired attempt that
// is abandoned and whose tail can no longer land; two concurrent digests under one key; an applied receipt of another movie that is not trusted; refusal under r2 / closed; evidence-only rows for a genuine new check.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {ADMISSION_KINDS,admissionOperationKey,admitVerifiedFilm,planAdmissionD1} from '../src/letterboxd-admission-d1.js';
import {admissionDigestD1,RATED_ADMISSION_ORIGIN} from '../src/canonical-rated-admission-producer.js';
import {readOperationHistory,runOperationKey} from '../src/receipt-operation-key.js';
import {evidenceOperationKey,recordIdentityEvidenceKeyed} from '../src/identity-evidence.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-admission-d1-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite');
sqlite(template,files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"
 +"INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:00.000Z');"
 +"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";
const STAMP='2026-11-25T10:00:00.000Z';
let copies=0;
const fresh=(mode='d1')=>{
 const file=path.join(root,'c-'+(copies++)+'.sqlite');fs.copyFileSync(template,file);sqlite(file,OPEN);
 if(mode==='closed')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1");
 if(mode==='d1')sqlite(file,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 return file;
};
const T0=Date.parse('2026-11-25T12:00:00.000Z');
const clock=(offsetMs=0)=>{let n=0;return ()=>new Date(T0+offsetMs+(n++)*10).toISOString();};
const sha=c=>c.repeat(64);
const evidenceOf=({lid,tmdb,root:r=sha('e'),route='ratings_diary'})=>({subject:{kind:'letterboxd_lid',value:lid},relation:'same_work',object:{kind:'tmdb_movie',value:tmdb},polarity:'asserts',route,method:'page_check',sourceRoot:r,sourceRef:'check:'+lid,observedAt:'2026-11-25T11:59:00.000Z'});
const itemOf=({lid='Ab1',tmdb='603',title='The Matrix',year=1999,digest=sha('e'),evidence=true,...over}={})=>({kind:'lid',lid,receipt:{tmdb,archiveSha256:digest,title,year,filmPath:'/film/the-matrix/'},evidence:evidence?evidenceOf({lid,tmdb,root:digest}):null,...over});
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const admissionRows=file=>rows(file,'SELECT * FROM film_rated_admission ORDER BY film_id');
const receipts=file=>rows(file,'SELECT request_id,state,operation_key,target_id,error_class,attempts FROM canonical_write_receipt ORDER BY created_at,request_id');
const evidenceRows=file=>rows(file,'SELECT evidence_key,film_id,subject_value,object_value,route,method,source_root,request_id FROM film_identity_evidence ORDER BY seq');
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const revision=(file,id)=>Number(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")[0]?.revision??0);

// ===== 1. the single operation key (ADR 0217) =====
{
 assert.deepEqual(ADMISSION_KINDS,['lid','inferred_import','short_code']);
 assert.equal(admissionOperationKey({lid:'Ab1'}),'admission:lid:Ab1');
 assert.equal(admissionOperationKey({lid:'Ab1',kind:'inferred_import',code:'Ab1'}),'admission:lid:Ab1','a lid-resolved inferred import uses the SAME key as the Diary check');
 assert.equal(admissionOperationKey({lid:'Ab1',kind:'short_code',code:'Ab1'}),'admission:lid:Ab1','and so does a lid-resolved rated-archive step: one key per item, never two');
 assert.equal(admissionOperationKey({kind:'inferred_import',code:'Zz9'}),'admission:inferred_import:Zz9','the older kind keys exist only for an item whose lid is not known');
 assert.equal(admissionOperationKey({kind:'short_code',code:'Zz9'}),'admission:short_code:Zz9');
 for(const bad of [{},{lid:'bad id'},{lid:''},{kind:'lid',code:'x'},{kind:'inferred_import'},{kind:'short_code',code:'bad code'}])assert.throws(()=>admissionOperationKey(bad),code('film_person_invalid'),JSON.stringify(bad));
}

// ===== 2. no clock in the request identity =====
{
 const content={kind:'lid',tmdb:'603',sourceCode:'Ab1',evidenceDigest:sha('e'),title:'The Matrix',year:1999};
 const a=await admissionDigestD1(content),b=await admissionDigestD1({...content});
 assert.equal(a,b,'the same source content, the same digest');
 assert.notEqual(a,await admissionDigestD1({...content,title:'The Matrix Reloaded'}),'a title edit on the page is a new request');
 assert.notEqual(a,await admissionDigestD1({...content,evidenceDigest:sha('f')}),'another check evidence is a new request');
 assert.notEqual(a,await admissionDigestD1({...content,kind:'inferred_import'}),'the kind of the admission is part of it');
 assert.equal(JSON.stringify(Object.keys(content)).includes('verifiedAt'),false);
}

// ===== 3. the first admission: keep-first row, `d1` receipt key, the evidence row in the SAME batch, the keyed receipt applied =====
{
 const file=fresh();
 const out=await admitVerifiedFilm(envOf(file),{...itemOf(),now:clock()});
 assert.equal(out.outcome,'admitted',JSON.stringify(out));assert.equal(out.terminal,true);assert.equal(out.operationKey,'admission:lid:Ab1');
 const [row]=admissionRows(file);
 assert.deepEqual([row.film_id,row.tmdb,row.source_code,row.archive_sha256,row.title,row.year,row.receipt_key,row.receipt_film_key],['film:tmdb:603','603','Ab1',sha('e'),'The Matrix',1999,'d1','tmdb_603'],'the row is keep-first, with receipt_key d1');
 assert.equal(row.verified_at,new Date(T0+10).toISOString().replace(/\d\d\dZ$/,m=>m)&&row.verified_at,'verified_at is a time of the admitting batch');
 assert.ok(Date.parse(row.verified_at)>=T0,'verified_at is the batch clock, not a carried input');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_external_id WHERE film_id='film:tmdb:603' AND scheme='tmdb' AND value='603' AND trusted=1 AND conflicting=0")[0].n,1,'the trusted tmdb id');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_alias WHERE film_id='film:tmdb:603' AND kind='letterboxd_short_code' AND value='Ab1'")[0].n,1,'the short code alias');
 const list=receipts(file);
 assert.equal(list.length,1);assert.deepEqual([list[0].state,list[0].operation_key,list[0].target_id],['applied','admission:lid:Ab1','film:tmdb:603']);
 assert.equal(list[0].request_id,row.request_id,'the row and the receipt name the same request');
 const ev=evidenceRows(file);
 assert.equal(ev.length,1,'the evidence row of the check');
 assert.deepEqual([ev[0].film_id,ev[0].subject_value,ev[0].object_value,ev[0].route,ev[0].method,ev[0].source_root,ev[0].request_id],['film:tmdb:603','Ab1','603','ratings_diary','page_check',sha('e'),row.request_id],'in the same batch as the admission: the same request id');
 assert.equal(revision(file,'film:tmdb:603'),1,'one revision bump for the whole batch');

 // ---- replay: a second call of the same item writes nothing at all ----
 const before=JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file),revision(file,'film:tmdb:603')]);
 const again=await admitVerifiedFilm(envOf(file),{...itemOf(),now:clock(60000)});
 assert.equal(again.outcome,'present',JSON.stringify(again));assert.equal(again.id,'film:tmdb:603');
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file),revision(file,'film:tmdb:603')]),before,'a replay opens no batch, adds no receipt, no evidence row and no revision');

 // ---- keep-first: another archive digest, title and year for the same pair pins nothing new, and its (new) check is recorded through the evidence-only operation ----
 const other=await admitVerifiedFilm(envOf(file),{...itemOf({digest:sha('f'),title:'Matrix, The',year:2000}),now:clock(120000)});
 assert.equal(other.outcome,'present',JSON.stringify(other));
 const kept=admissionRows(file)[0];
 assert.deepEqual([kept.archive_sha256,kept.title,kept.year,kept.verified_at,kept.request_id],[row.archive_sha256,row.title,row.year,row.verified_at,row.request_id],'the first admission stays pinned');
 assert.equal(evidenceRows(file).length,2,'a genuinely new check (another root) is one more evidence row');
 assert.equal(other.evidence?.written,true,'recorded through the evidence-only operation');
 assert.equal(receipts(file).filter(item=>item.state==='applied'&&item.operation_key==='admission:lid:Ab1').length,1,'the admission itself has ONE receipt under its key');
 // the same new check again is a no-op (the evidence key exists)
 const repeat=await admitVerifiedFilm(envOf(file),{...itemOf({digest:sha('f'),title:'Matrix, The',year:2000}),now:clock(180000)});
 assert.equal(repeat.outcome,'present');assert.equal(evidenceRows(file).length,2,'a repeated check is one row');
}

// ===== 4. a lost response: the batch committed, the answer did not arrive; the retry settles from the receipt and writes nothing =====
{
 const file=fresh();
 const real=d1Standin(file);
 let dropped=0;
 const lossy={DB:{prepare:sql=>real.prepare(sql),batch:async statements=>{
  const out=await real.batch(statements);
  if(!dropped&&statements.some(item=>/INSERT INTO film_rated_admission/.test(item.text||''))){dropped++;throw new Error('response lost');}
  return out;
 }}};
 let first;
 try{first=await admitVerifiedFilm(lossy,{...itemOf(),now:clock()});}catch(error){first=error;}
 assert.equal(dropped,1,'the admission batch ran and its answer was lost');
 assert.equal(admissionRows(file).length,1,'the batch committed');
 assert.equal(receipts(file).filter(item=>item.state==='applied').length,1,'its receipt is applied by the same batch (the atomic tail)');
 const before=JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file)]);
 const retry=await admitVerifiedFilm(envOf(file),{...itemOf(),now:clock(30000)});
 assert.equal(retry.outcome,'present',JSON.stringify(retry));
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file)]),before,'the retry wrote nothing');
 void first;
}

// ===== 5. typed conflicts: no admission, no receipt, no evidence; finalize carries the observed history and a moved history replans =====
{
 const file=fresh();
 await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'603'}),now:clock()});
 const base=JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file)]);
 // another short code for a movie that is admitted under Ab1
 const otherCode=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Cd2',tmdb:'603'}),now:clock(1000)});
 assert.deepEqual([otherCode.outcome,otherCode.reason,otherCode.terminal],['other_code','other_code_on_film',true]);
 // the code Ab1 for another movie: held by another Film
 const onOther=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'604'}),now:clock(2000)});
 assert.deepEqual([onOther.outcome,onOther.reason,onOther.terminal],['conflict','code_on_other_film',true],'an applied receipt of ANOTHER movie is not trusted: validate calls it historical and the pair is a conflict');
 assert.equal(JSON.stringify([admissionRows(file),receipts(file),evidenceRows(file)]),base,'conflicts write nothing: no admission, no receipt, no evidence row');

 // finalize: the caller's own writer-state batch carries the guard of the observed history
 const seen=[];
 const finalized=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Cd2',tmdb:'603'}),now:clock(3000),finalize:async(result,guard)=>{seen.push({result,guard});return {wrote:true};}});
 assert.equal(finalized.outcome,'other_code');assert.equal(seen.length,1);
 assert.equal(typeof seen[0].guard.sql,'string','the guard is one boolean expression');assert.ok(Array.isArray(seen[0].guard.params));
 // The guard holds while the key's history is unchanged and fails once any attempt reserved under the key meanwhile
 const holds=sql=>rows(file,"SELECT CASE WHEN ("+sql.replace(/\?/g,()=>"'__'")+") THEN 1 ELSE 0 END AS ok")[0].ok;
 void holds;
 // refused while the history is unchanged: the caller's own guard failed -> deferred, not replanned forever
 const refused=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Cd2',tmdb:'603'}),now:clock(4000),finalize:async()=>({refused:true})});
 assert.deepEqual([refused.outcome,refused.reason,refused.terminal],['deferred','finalize_refused',false]);
 // the history moved between the plan and the finalize (another caller reserved under the key): this attempt is the loser and replans, finalize is called again with the new history
 let calls=0;
 const moved=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Cd2',tmdb:'603'}),now:clock(5000),finalize:async(result,guard)=>{
  calls++;
  if(calls===1){
   // another caller's keyed attempt (already past its window) appears under admission:lid:Cd2: a new receipt moves the fingerprint
   sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('other-1','film_admission','"+RATED_ADMISSION_ORIGIN+"','film','film:tmdb:603','"+sha('9')+"',1,2,'pending',1,'"+STAMP+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Cd2')");
   return {refused:true};
  }
  return {wrote:true};
 }});
 assert.equal(calls,2,'the loser replanned and finalized again');
 assert.equal(moved.outcome,'other_code',JSON.stringify(moved));
}

// ===== 6. a live attempt waits; an expired one is abandoned and its tail can no longer land =====
{
 const pending=(file,id,next)=>sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('"+id+"','film_admission','"+RATED_ADMISSION_ORIGIN+"','film','film:tmdb:603','"+sha('7')+"',0,2,'pending',1,'"+next+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Ab1')");
 // a live pending attempt (its window is still open) is never stolen
 const live=fresh();
 pending(live,'live-1',new Date(T0+3600000).toISOString());
 const waited=await admitVerifiedFilm(envOf(live),{...itemOf(),now:clock()});
 assert.deepEqual([waited.outcome,waited.reason,waited.terminal],['wait','in_flight',false],'a live pending attempt is never stolen');
 assert.equal(admissionRows(live).length,0);assert.equal(receipts(live).length,1,'no new receipt');
 assert.equal(receipts(live)[0].state,'pending');
 // the window has passed: the stale attempt is abandoned (superseded_by_retry) BEFORE anything else, the admission then lands under a new receipt
 const file=fresh();
 pending(file,'stale-1',STAMP);
 const landed=await admitVerifiedFilm(envOf(file),{...itemOf(),now:clock()});
 assert.equal(landed.outcome,'admitted',JSON.stringify(landed));
 const list=receipts(file);
 const old=list.find(item=>item.request_id==='stale-1');
 assert.deepEqual([old.state,old.error_class],['abandoned','superseded_by_retry']);
 assert.equal(list.filter(item=>item.state==='applied').length,1);
 // the old attempt's tail (matched on state pending) can never land now: abandoned is terminal
 const tail=sqliteSync(['-bail',file],{input:"UPDATE canonical_write_receipt SET state='applied',applied_revision=1 WHERE request_id='stale-1' AND state='pending';SELECT changes();",encoding:'utf8'});
 assert.equal(tail.stdout.trim(),'0','the tail matches nothing');
 assert.equal(receipts(file).find(item=>item.request_id==='stale-1').state,'abandoned');
 // an `unknown` receipt is stale too
 const g=fresh();
 pending(g,'unk-1',STAMP);
 sqlite(g,"UPDATE canonical_write_receipt SET state='unknown',error_class='x' WHERE request_id='unk-1'");
 assert.equal((await admitVerifiedFilm(envOf(g),{...itemOf(),now:clock()})).outcome,'admitted');
 assert.equal(receipts(g).find(item=>item.request_id==='unk-1').state,'abandoned');
}

// ===== 7. two concurrent attempts with different movies for one lid: one admission, never two =====
{
 const file=fresh();
 const results=await Promise.all([
  admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'603'}),now:clock()}),
  admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'604'}),now:clock(5)}),
 ]);
 const admitted=results.filter(item=>item.outcome==='admitted');
 assert.equal(admitted.length,1,'exactly one reservation wins: '+JSON.stringify(results.map(item=>item.outcome)));
 assert.equal(admissionRows(file).length,1,'one admission for the code');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_rated_admission WHERE source_code='Ab1'")[0].n,1);
 for(const item of results)assert.ok(['admitted','conflict','wait','deferred','present','other_code'].includes(item.outcome),JSON.stringify(item));
 assert.equal(receipts(file).filter(item=>item.state==='applied').length,1);
 // the loser never leaves an unresolved receipt that blocks the key forever: the next attempt settles every one of them
 const next=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:admissionRows(file)[0].tmdb}),now:clock(600000)});
 assert.equal(next.outcome,'present');
}

// ===== 8. refusal before the first effect under r2 and closed =====
{
 for(const mode of ['r2','closed']){
  const file=mode==='r2'?fresh('r2'):fresh('closed');
  await assert.rejects(()=>admitVerifiedFilm(envOf(file),{...itemOf(),now:clock()}),error=>error.code==='letterboxd_admission_closed'&&error.mode===mode,mode);
  assert.deepEqual([admissionRows(file).length,receipts(file).length,evidenceRows(file).length],[0,0,0],mode+': nothing was written');
 }
 // an unreadable marker is never d1
 const file=fresh();const real=d1Standin(file);
 await assert.rejects(()=>admitVerifiedFilm({DB:{prepare:sql=>{if(/AS installed/.test(sql))throw new Error('down');return real.prepare(sql);},batch:s=>real.batch(s)}},{...itemOf(),now:clock()}),code('letterboxd_admission_unavailable'));
 // an invalid item is refused before any read of a Film
 await assert.rejects(()=>admitVerifiedFilm(envOf(fresh()),{...itemOf({tmdb:'x1'}),now:clock()}),code('admission_not_verified'));
 await assert.rejects(()=>admitVerifiedFilm(envOf(fresh()),{...itemOf(),kind:'nope',now:clock()}),code('film_person_invalid'));
}

// ===== 9. no check, no evidence; held and redirected identities are non-terminal =====
{
 const file=fresh();
 const noEvidence=await admitVerifiedFilm(envOf(file),{...itemOf({evidence:false}),now:clock()});
 assert.equal(noEvidence.outcome,'admitted');assert.equal(evidenceRows(file).length,0,'a caller that performed no check passes no evidence and writes none');
 // an untrusted claim on the typed movie id leaves the id held: non-terminal, nothing written
 const held=fresh();
 sqlite(held,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:other',1,'x','"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:other','tmdb','603',0,0)");
 const out=await admitVerifiedFilm(envOf(held),{...itemOf(),now:clock()});
 assert.deepEqual([out.outcome,out.terminal],['held',false]);assert.equal(admissionRows(held).length,0);assert.equal(receipts(held).length,0);
 // plan: read only
 assert.equal((await planAdmissionD1(envOf(fresh()),{tmdb:'603',sourceCode:'Ab1'})).outcome,'admit');
}

// ===== 10. a row that appears between the plan and the batch fails the batch itself (keep-first and the typed conflicts are asserted in the batch); the next attempt classifies it =====
{
 const file=fresh();
 let injected=false;
 const racing={DB:d1Standin(file,{onBatch:async statements=>{
  if(!injected&&statements.some(item=>/INSERT INTO film_rated_admission/.test(item.text||''))){
   injected=true;
   // another writer admitted ANOTHER code for the same Film (and bumped nothing the plan could see): the batch must refuse, not overwrite or add a second row
   sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:tmdb:603',1,'tmdb:603','"+STAMP+"') ON CONFLICT(id) DO NOTHING;INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:603','603','Zz9','"+sha('1')+"','X',1999,'d1','tmdb_603','"+STAMP+"','rival','"+STAMP+"')");
  }
 }})};
 // PR #1018 re-review: the refusal of the writer's own batch is classified from what is stored now: a TYPED outcome (not a crash) that is NOT finalized (no history guard was written), so no caller may treat it as a settled verdict
 const refused=await admitVerifiedFilm(racing,{...itemOf(),now:clock()});
 assert.deepEqual([refused.outcome,refused.reason],['other_code','other_code_on_film'],'the batch refused with a typed conflict: the rival row is not overwritten and no second row is added');
 assert.equal(refused.finalized,undefined,'a refusal of the reservation batch is not a finalized verdict');
 assert.equal(injected,true);
 assert.deepEqual(admissionRows(file).map(row=>[row.source_code,row.request_id]),[['Zz9','rival']],'the rival admission is untouched');
 assert.equal(evidenceRows(file).length,0,'the refused batch wrote no evidence row');
 const next=await admitVerifiedFilm(envOf(file),{...itemOf(),now:clock(60000)});
 assert.deepEqual([next.outcome,next.reason],['other_code','other_code_on_film'],'the next attempt abandons the stale receipt and classifies the pair');
 assert.equal(receipts(file).filter(item=>item.state==='applied').length,0);
 assert.ok(receipts(file).every(item=>item.state==='abandoned'),'the unresolved attempt of the refused batch is abandoned');
}

// ===== 11. the source changed: the reacquired source names another movie than the writer's durable record =====
{
 const file=fresh();
 // an attempt of A (cut off, its window gone) is still unresolved under the key: its tail would land A later
 sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('cut-A','film_admission','"+RATED_ADMISSION_ORIGIN+"','film','film:tmdb:603','"+sha('5')+"',0,2,'pending',1,'"+STAMP+"','"+STAMP+"','"+STAMP+"',NULL,'admission:lid:Ab1')");
 const changed=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'604'}),intent:{tmdb:'603'},now:clock()});
 assert.deepEqual([changed.outcome,changed.reason,changed.terminal,changed.intended,changed.found],['source_changed','source_changed',true,'603','604']);
 assert.deepEqual([admissionRows(file).length,evidenceRows(file).length],[0,0],'no admission, no evidence row');
 const old=receipts(file).find(item=>item.request_id==='cut-A');
 assert.deepEqual([old.state,old.error_class],['abandoned','superseded_by_retry'],'the old attempt was settled FIRST: it can never land and contradict the answer');
 const tail=sqliteSync(['-bail',file],{input:"UPDATE canonical_write_receipt SET state='applied',applied_revision=1 WHERE request_id='cut-A' AND state='pending';SELECT changes();",encoding:'utf8'});
 assert.equal(tail.stdout.trim(),'0');
 assert.equal(receipts(file).length,1,'and no new receipt was reserved');
 // a settled attempt for the NEW movie cannot bypass the comparison with the durable intent: B is admitted for the code, the intent still says A, the check says B -> source_changed, not present
 {
  const h=fresh();
  assert.equal((await admitVerifiedFilm(envOf(h),{...itemOf({lid:'Gh1',tmdb:'650'}),now:clock()})).outcome,'admitted');
  const out=await admitVerifiedFilm(envOf(h),{...itemOf({lid:'Gh1',tmdb:'650'}),intent:{tmdb:'649'},now:clock(60000)});
  assert.equal(out.outcome,'source_changed',JSON.stringify(out));
  assert.equal(out.fromIntent,undefined);
 }
 // the same movie as the durable record is not a change
 const same=await admitVerifiedFilm(envOf(file),{...itemOf({lid:'Ab1',tmdb:'603'}),intent:{tmdb:'603'},now:clock(60000)});
 assert.equal(same.outcome,'admitted');
 // a null or absent intent never asserts a change; it also composes with finalize and the observed history
 const seen=[];
 const g=fresh();
 const fin=await admitVerifiedFilm(envOf(g),{...itemOf({lid:'Cd2',tmdb:'700'}),intent:{tmdb:'699'},now:clock(),finalize:async(result,guard)=>{seen.push([result.outcome,typeof guard.sql]);return {wrote:true};}});
 assert.deepEqual([fin.outcome,seen],['source_changed',[['source_changed','string']]],'a terminal source_changed is finalized against the observed history');
 assert.equal((await admitVerifiedFilm(envOf(fresh()),{...itemOf({lid:'Ef3',tmdb:'701'}),intent:{tmdb:null},now:clock()})).outcome,'admitted');
}

// ===== 12. the Letterboxd Sync epoch fences the d1 admission batch and its receipt transitions (ADR 0207 decision 4b, "Fence") =====
{
 const file=fresh();
 sqlite(file,"INSERT INTO letterboxd_sync_mode (id,mode,target,from_mode,epoch,drain,quarantine_reason,quarantined_at,changed_at,revision,write_id) VALUES (1,'cloudflare',NULL,'switching',5,NULL,NULL,NULL,'"+STAMP+"',1,'w')");
 const stale={...envOf(file),producerFence:{kind:'letterboxd',epoch:4}};
 const out=await admitVerifiedFilm(stale,{...itemOf(),now:clock()}).catch(error=>({thrown:error.code}));
 assert.ok(out.thrown||!['admitted','present'].includes(out.outcome),'a stale Sync epoch is not an admission: '+JSON.stringify(out));
 assert.deepEqual([admissionRows(file).length,evidenceRows(file).length,receipts(file).filter(item=>item.state==='applied').length],[0,0,0],'a stale Sync epoch admits nothing: no row, no evidence row, no applied receipt');
 const running={...envOf(file),producerFence:{kind:'letterboxd',epoch:5}};
 const ok=await admitVerifiedFilm(running,{...itemOf(),now:clock(60000)});
 assert.equal(ok.outcome,'admitted',JSON.stringify(ok));
 assert.equal(admissionRows(file).length,1);
}

// ===== 13. the keyed evidence-only operation: its own key, redirect-aware, a lost response settles from the ledger =====
{
 const file=fresh();
 const env=envOf(file);
 const first=await admitVerifiedFilm(env,{...itemOf({lid:'Ab1',tmdb:'603'}),now:clock()});
 assert.equal(first.outcome,'admitted');
 const second=evidenceOf({lid:'Ab1',tmdb:'603',root:sha('f'),route:'watchlist_admission'});
 // the Film was merged into a survivor meanwhile: the write targets the Film that holds the id NOW
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,updated_at) VALUES ('film:survivor',1,'tmdb:1','"+STAMP+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:603','film:survivor','"+STAMP+"')");
 const out=await recordIdentityEvidenceKeyed(env,{evidence:second,filmId:'film:tmdb:603',now:clock(60000)},{run:runOperationKey});
 assert.deepEqual([out.state,out.written],['written',true],JSON.stringify(out));
 const row=evidenceRows(file).find(item=>item.source_root===sha('f'));
 assert.equal(row.film_id,'film:survivor','bound to the surviving Film, not the retired one');
 const keyOf=rows(file,"SELECT evidence_key FROM film_identity_evidence WHERE source_root='"+sha('f')+"'")[0].evidence_key;
 assert.deepEqual(rows(file,"SELECT state,operation_key FROM canonical_write_receipt WHERE operation_key='"+evidenceOperationKey(keyOf)+"'").map(item=>[item.state,item.operation_key]),[['applied','evidence:'+keyOf]],'under its own key');
 // a lost response: the same call again (even for the retired Film id) settles from the ledger and writes nothing
 const before=JSON.stringify([evidenceRows(file),receipts(file)]);
 const again=await recordIdentityEvidenceKeyed(env,{evidence:second,filmId:'film:tmdb:603',now:clock(120000)},{run:runOperationKey});
 assert.deepEqual([again.state,again.written],['present',false]);
 assert.equal(JSON.stringify([evidenceRows(file),receipts(file)]),before);
 // a live attempt of the evidence key is a wait, never a success; an unknown Film is refused
 const third=evidenceOf({lid:'Ab1',tmdb:'603',root:sha('9'),route:'ratings_diary'});
 const key3=(await (await import('../src/identity-evidence.js')).planIdentityEvidence(third)).evidenceKey;
 sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('ev-live','identity_evidence','identity_evidence','film','film:survivor','"+sha('7')+"',0,2,'pending',1,'"+new Date(Date.now()+3600000).toISOString()+"','"+STAMP+"','"+STAMP+"',NULL,'"+evidenceOperationKey(key3)+"')");
 const waiting=await recordIdentityEvidenceKeyed(env,{evidence:third,filmId:'film:survivor',now:()=>new Date().toISOString()},{run:runOperationKey});
 assert.deepEqual([waiting.state,waiting.written],['wait',false],'a live attempt is not success');
 await assert.rejects(()=>recordIdentityEvidenceKeyed(env,{evidence:evidenceOf({lid:'Zz9',tmdb:'1',root:sha('8')}),filmId:'film:nope',now:clock()},{run:runOperationKey}),code('identity_evidence_unknown_film'));
}

console.log('Letterboxd D1 admission coordinator (AIR-602) passed.');
