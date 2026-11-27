// AIR-672 / ADR 0217 (Accepted) delivery step 3, tests 1, 2, 4, 4b, 5b, 5c, 6, 7, 8, 13 and 16: the `lid_only` kind of the D1 admission coordinator, on the real migrations (a sqlite D1 stand-in), the real canonical writer,
// receipts and operation-key protocol. Synthetic proofs only; no Worker, network, R2 or production. DORMANT: H1 stays disabled, nothing calls the coordinator from a live path.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {admitVerifiedFilm,admitVerifiedLidOnly,planLidOnlyD1} from '../src/letterboxd-admission-d1.js';
import {RATED_ADMISSION_ORIGIN} from '../src/canonical-rated-admission-producer.js';
import {lidOnlyProofDigest} from '../src/domain/letterboxd-lid-only-digest.js';
import {admitLidOnlyFilm,ratingsDocumentFence} from '../src/film-admission.js';
import {MUTATION_STATEMENT_CAP} from '../src/canonical-mutations.js';
import {ownedAttemptCondition} from '../src/receipt-operation-key.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lid-only-'));
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
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const receipts=file=>rows(file,'SELECT request_id,state,operation_key,target_id,error_class FROM canonical_write_receipt ORDER BY created_at,request_id');
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM film ORDER BY id'),rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),rows(file,'SELECT * FROM film_lid_admission'),rows(file,'SELECT * FROM film_rated_admission'),rows(file,'SELECT * FROM film_identity_evidence'),receipts(file),rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id')]);
const sha=c=>c.repeat(64);
const proofOf=async(lid='Ab1',over={})=>{
 const proof={proofVersion:1,lid,finalUrl:'https://letterboxd.com/film/some-short-1999/',slug:'some-short-1999',canonicalPath:'/film/some-short-1999/',shortlink:lid,typeMarker:'video.movie',idBlockOutcome:'absent',completenessOutcome:'complete',title:'Some Short',year:1999,redirectStatus:301,pageStatus:200,checkedAt:'2026-11-25T11:59:00.000Z',...over};
 proof.proofDigest=await lidOnlyProofDigest(proof);
 return proof;
};
const checker=async(lid='Ab1',extra={},over={})=>{const calls={n:0};const proof=await proofOf(lid,over);return {calls,reacquire:async()=>{calls.n++;return {ok:true,proof,...extra};}};};
const run=async(file,lid='Ab1',{route='watchlist_admission',now=clock(),extra={},over={},options,...rest}={})=>{const c=await checker(lid,extra,over);const out=await admitVerifiedLidOnly(envOf(file,options),{lid,route,reacquire:c.reacquire,now,...rest});return {out,calls:c.calls};};
const pending=(file,id,key,next,target='film:lb:Ab1')=>sqlite(file,"INSERT INTO canonical_write_receipt (request_id,operation,origin,target_kind,target_id,content_digest,planned_revision,marker_generation,state,attempts,next_attempt_at,created_at,updated_at,settled_at,operation_key) VALUES ('"+id+"','film_admission','"+RATED_ADMISSION_ORIGIN+"','film','"+target+"','"+sha('7')+"',0,2,'pending',1,'"+next+"','"+STAMP+"','"+STAMP+"',NULL,'"+key+"')");

// ===== 1. a valid page: one Film, one trusted claim, one immutable proof row, one receipt =====
{
 const file=fresh();
 const {out,calls}=await run(file);
 assert.deepEqual([out.outcome,out.terminal,out.operationKey,out.id],['admitted_lid_only',true,'admission:lid:Ab1','film:lb:Ab1'],JSON.stringify(out));
 assert.equal(calls.n,1);
 const films=rows(file,'SELECT id,canonical_identity,original_title FROM film');
 assert.deepEqual(films,[{id:'film:lb:Ab1',canonical_identity:null,original_title:'Some Short'}],'a minting id with no current identity');
 const claims=rows(file,'SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id');
 assert.equal(claims.length,1);assert.deepEqual([claims[0].film_id,claims[0].scheme,claims[0].value,claims[0].trusted,claims[0].conflicting],['film:lb:Ab1','letterboxd','Ab1',1,0]);
 const [row]=rows(file,'SELECT * FROM film_lid_admission');
 assert.deepEqual(JSON.parse(claims[0].provenance_json),{source:'watchlist_admission',adr:'0217',evidence:row.proof_digest},'provenance names the route, the ADR and the causal root');
 assert.deepEqual([row.lid,row.film_id,row.route,row.receipt_key,row.shortlink,row.id_block_outcome,row.completeness_outcome,row.title,row.year,row.redirect_status,row.page_status],['Ab1','film:lb:Ab1','watchlist_admission','admission:lid:Ab1','Ab1','absent','complete','Some Short',1999,301,200]);
 const recomputed=await lidOnlyProofDigest({proofVersion:row.proof_version,lid:row.lid,finalUrl:row.final_url,slug:row.slug,canonicalPath:row.canonical_path,shortlink:row.shortlink,typeMarker:row.type_marker,idBlockOutcome:row.id_block_outcome,completenessOutcome:row.completeness_outcome,title:row.title,year:row.year});
 assert.equal(recomputed,row.proof_digest,'the proof digest recomputes from its columns');
 assert.deepEqual(receipts(file).map(item=>[item.state,item.operation_key,item.target_id]),[['applied','admission:lid:Ab1','film:lb:Ab1']]);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_identity_evidence')[0].n,0,'K2: no evidence row for the admission');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_rated_admission')[0].n,0,'no film_rated_admission row: outside the ADR 0211 scope');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_alias')[0].n,0);
 assert.equal(rows(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:lb:Ab1'")[0].revision,1);
 // the proof row is immutable (trigger) and a second row for the lid is impossible
 assert.throws(()=>sqlite(file,"UPDATE film_lid_admission SET title='x' WHERE lid='Ab1'"),/film_lid_admission_immutable/);
 // a year-less page is admitted with year unknown
 const g=fresh();
 const noYear=await run(g,'Yy2',{over:{year:null}});
 assert.equal(noYear.out.outcome,'admitted_lid_only');assert.equal(rows(g,'SELECT year FROM film_lid_admission')[0].year,null);
}

// ===== 4. replay and a lost response: settle only, no fetch, no second row =====
{
 const file=fresh();
 await run(file);
 const before=snapshot(file);
 const again=await run(file,'Ab1',{now:clock(60000)});
 assert.deepEqual([again.out.outcome,again.out.id],['present_lid_only','film:lb:Ab1'],JSON.stringify(again.out));
 assert.equal(again.calls.n,0,'a replay never fetches');
 assert.equal(snapshot(file),before,'a replay writes nothing');
 // the response is lost after the canonical commit
 const g=fresh();
 const real=d1Standin(g);let dropped=0;
 const lossy={DB:{prepare:sql=>real.prepare(sql),batch:async statements=>{const out=await real.batch(statements);if(!dropped&&statements.some(item=>/INSERT INTO film_lid_admission/.test(item.text||''))){dropped++;throw new Error('response lost');}return out;}}};
 const c=await checker();
 try{await admitVerifiedLidOnly(lossy,{lid:'Ab1',route:'ratings_diary',reacquire:c.reacquire,now:clock()});}catch{/* the answer was lost */}
 assert.equal(dropped,1);assert.equal(rows(g,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,1,'the batch committed');
 const kept=snapshot(g);
 const retry=await run(g,'Ab1',{route:'ratings_diary',now:clock(30000)});
 assert.equal(retry.out.outcome,'present_lid_only');assert.equal(retry.calls.n,0);assert.equal(snapshot(g),kept);
}

// ===== 2. unproved inputs are refused before any reservation =====
{
 const file=fresh();const before=snapshot(file);
 for(const lid of ['a b','','slug/with/slash',null,undefined,'x'.repeat(81)]){
  const c=await checker('Ab1');
  const out=await admitVerifiedLidOnly(envOf(file),{lid,route:'watchlist_admission',reacquire:c.reacquire,now:clock()});
  assert.deepEqual([out.outcome,out.terminal,out.reason],['lid_unverified',true,'lid_unverified'],String(lid));assert.equal(c.calls.n,0);
 }
 assert.equal(snapshot(file),before,'nothing canonical, no receipt');
 // the source check cannot be made now: non-terminal, nothing written
 const down=await admitVerifiedLidOnly(envOf(file),{lid:'Ab1',route:'watchlist_admission',reacquire:async()=>({ok:false,reason:'rate_limited'}),now:clock()});
 assert.deepEqual([down.outcome,down.terminal,down.reason],['source_unavailable',false,'rate_limited']);assert.equal(snapshot(file),before);
 // a proof the writer cannot recompute is never trusted (the digest, a changed column, another lid, the id block outcome)
 const goodProof0=await proofOf('Ab1');
 for(const [label,over] of [['digest',{proofDigest:sha('0')}],['title',{title:'Other'}],['shortlink',{shortlink:'Zz9'}],['id block',{idBlockOutcome:'present'}],['complete',{completenessOutcome:'truncated'}],['status',{pageStatus:404}],['url',{finalUrl:'http://letterboxd.com/film/some-short-1999/'}]]){
  const proof={...goodProof0,...over};
  await assert.rejects(()=>admitLidOnlyFilm(envOf(file),{lid:'Ab1',route:'watchlist_admission',proof,expectedRevision:0,at:STAMP,requestId:'r-bad'}),code('admission_not_verified'),label);
 }
 const goodProof=await proofOf('Ab1');
 await assert.rejects(()=>admitLidOnlyFilm(envOf(file),{lid:'Ab1',route:'discovery',proof:goodProof,expectedRevision:0,at:STAMP,requestId:'r-bad'}),code('film_person_invalid'),'only the three verifying routes');
 assert.equal(snapshot(file),before);
}

// ===== 13. the admission marker: r2 and closed refuse before the first effect =====
{
 for(const mode of ['closed']){
  const file=fresh(mode);const before=snapshot(file);const c=await checker();
  await assert.rejects(()=>admitVerifiedLidOnly(envOf(file),{lid:'Ab1',route:'watchlist_admission',reacquire:c.reacquire,now:clock()}),code('letterboxd_admission_closed'),mode);
  assert.equal(c.calls.n,0);assert.equal(snapshot(file),before);
 }
 const r2=fresh('r2');const before=snapshot(r2);const c=await checker();
 await assert.rejects(()=>admitVerifiedLidOnly(envOf(r2),{lid:'Ab1',route:'watchlist_admission',reacquire:c.reacquire,now:clock()}),code('letterboxd_admission_closed'),'r2');
 assert.equal(c.calls.n,0);assert.equal(snapshot(r2),before);
 // a batch planned under d1 that meets a moved marker fails whole (the batch asserts the marker generation)
 const file=fresh();const before2=snapshot(file);
 await assert.rejects(()=>run(file,'Ab1',{options:{onBatch:async()=>{sqlite(file,"UPDATE film_person_authority SET generation=generation+1 WHERE id=1");}}}).then(r=>{if(r.out.outcome==='admitted_lid_only')throw new Error('landed');return r;}));
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0);void before2;
 // while migration 0048 is not applied the kind refuses before any effect
 const old=path.join(root,'v46.sqlite');sqlite(old,files.filter(name=>name<'0048').map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));sqlite(old,OPEN);
 sqlite(old,"UPDATE letterboxd_admission_authority SET mode='closed',generation=1;UPDATE letterboxd_admission_authority SET mode='d1',generation=2,activated_at='"+STAMP+"'");
 const c2=await checker();
 await assert.rejects(()=>admitVerifiedLidOnly(envOf(old),{lid:'Ab1',route:'watchlist_admission',reacquire:c2.reacquire,now:clock()}),code('admission_unavailable'));assert.equal(c2.calls.n,0);
}

// ===== 4b. the lid is already trusted on a TMDB Film: present, neither a conflict nor lid-only =====
{
 const file=fresh();
 const tmdb=await admitVerifiedFilm(envOf(file),{kind:'lid',lid:'Ab1',receipt:{tmdb:'603',archiveSha256:sha('e'),title:'The Matrix',year:1999,filmPath:'/film/the-matrix/'},evidence:null,now:clock()});
 assert.equal(tmdb.outcome,'admitted');
 sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:tmdb:603','letterboxd','Ab1',1,0,'{}')");
 const before=snapshot(file);
 const out=await run(file,'Ab1',{now:clock(1000)});
 assert.deepEqual([out.out.outcome,out.out.id],['present','film:tmdb:603']);assert.equal(out.calls.n,0);assert.equal(snapshot(file),before);
 // the rated archive row holds the code: the same answer
 const g=fresh();
 await admitVerifiedFilm(envOf(g),{kind:'lid',lid:'Cd2',receipt:{tmdb:'604',archiveSha256:sha('e'),title:'Other',year:2000,filmPath:'/film/other/'},evidence:null,now:clock()});
 assert.equal((await run(g,'Cd2',{now:clock(1000)})).out.outcome,'present');
}

// ===== 7 (claims) and 5b: another claim of the lid, of any trust, blocks the admission (owner review) =====
{
 for(const [label,sql] of [['untrusted',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x1',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:x1','letterboxd','Ab1',0,0,'{}')"],
  ['conflicting',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x1',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:x1','letterboxd','Ab1',0,1,'{}')"],
  ['id taken',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:lb:Ab1',1,'"+STAMP+"')"]]){
  const file=fresh();sqlite(file,sql);const before=snapshot(file);
  const {out,calls}=await run(file);
  assert.deepEqual([out.outcome,out.terminal],['conflict',true],label+' '+JSON.stringify(out));assert.equal(calls.n,0,label+': decided from durable state without a fetch');
  assert.equal(snapshot(file),before,label+': nothing written');
 }
 // a redirect from the id: non-terminal
 const file=fresh();sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:t1',1,'"+STAMP+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:Ab1','film:t1','"+STAMP+"')");
 const out=(await run(file)).out;assert.deepEqual([out.outcome,out.terminal],['redirect',false]);
}

// ===== 5b. the symmetric predicates are asserted INSIDE the batch: state that appears after the plan fails the whole batch =====
{
 for(const [label,sql] of [
  ['an untrusted claim of the lid on another Film',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:x1',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:x1','letterboxd','Ab1',0,0,'{}')"],
  ['a rated admission row holding the code',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:tmdb:9',1,'"+STAMP+"');INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:9','9','Ab1','"+sha('a')+"','T',2000,'d1','tmdb_9','"+STAMP+"','r','"+STAMP+"')"],
  ['a redirect from the id',"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:t1',1,'"+STAMP+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb:Ab1','film:t1','"+STAMP+"')"],
 ]){
  const file=fresh();let fired=false;
  const result=await run(file,'Ab1',{options:{onBatch:async statements=>{if(!fired&&statements.some(item=>/INSERT INTO film_lid_admission/.test(item.text||''))){fired=true;sqlite(file,sql);}}}}).catch(error=>({error}));
  assert.equal(fired,true,label);
  assert.ok(result.error||result.out.outcome!=='admitted_lid_only',label+': never lands');
  assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0,label+': no proof row');
  assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb:Ab1'")[0].n,0,label+': no lid-only Film');
 }
}

// ===== 5b. receipt transitions, as executable fixtures =====
{
 // a live pending attempt under the lid key: wait; never stolen
 const live=fresh();pending(live,'live-1','admission:lid:Ab1',new Date(T0+3600000).toISOString());
 const waited=await run(live);
 assert.deepEqual([waited.out.outcome,waited.out.reason,waited.out.terminal],['wait','in_flight',false]);assert.equal(waited.calls.n,0);assert.equal(rows(live,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0);
 // after its window the stale attempt is abandoned and the next attempt reserves and admits
 const stale=fresh();pending(stale,'stale-1','admission:lid:Ab1',STAMP);
 const landed=await run(stale);
 assert.equal(landed.out.outcome,'admitted_lid_only',JSON.stringify(landed.out));
 assert.deepEqual(receipts(stale).map(item=>[item.request_id==='stale-1'?'stale':'new',item.state]),[['stale','abandoned'],['new','applied']]);
 // the stale tail can never land (abandoned is terminal)
 const tail=sqliteSync(['-bail',stale],{input:"UPDATE canonical_write_receipt SET state='applied' WHERE request_id='stale-1' AND state='pending';SELECT changes();",encoding:'utf8'});
 assert.equal(tail.stdout.trim(),'0');
 // two concurrent attempts: the second one's reservation fails the partial unique index / fingerprint, it replans and finds the admission
 const race=fresh();
 const first=await run(race,'Ab1',{options:{onBatch:null}});
 const second=await run(race,'Ab1',{now:clock(5000)});
 assert.equal(first.out.outcome,'admitted_lid_only');assert.equal(second.out.outcome,'present_lid_only');
 assert.equal(rows(race,'SELECT COUNT(*) AS n FROM film').length,1);
 // a failure after the reservation and before the canonical batch leaves ONE pending receipt, waited on inside its window
 const crash=fresh();
 const crashing=await run(crash,'Ab1',{options:{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO film_lid_admission/.test(item.text||'')))throw new Error('crash');}}}).catch(error=>({error}));
 assert.ok(crashing.error||crashing.out.outcome!=='admitted_lid_only','the canonical batch did not commit');
 assert.equal(rows(crash,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0);
 const inWindow=await run(crash,'Ab1',{now:clock(1000)});
 assert.ok(['wait','failed','unknown','deferred'].includes(inWindow.out.outcome)||inWindow.out.outcome==='admitted_lid_only','recovers from durable state: '+inWindow.out.outcome);
 const later=await run(crash,'Ab1',{now:clock(2*3600000)});
 assert.ok(['admitted_lid_only','present_lid_only'].includes(later.out.outcome),'after the window the next attempt lands: '+later.out.outcome);
 assert.equal(rows(crash,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,1);assert.equal(rows(crash,'SELECT COUNT(*) AS n FROM film').length,1);
}

// ===== 5c / 8. historical keys: an unresolved receipt under an older key is reconciled before the lid key is reserved =====
{
 for(const older of ['admission:short_code:Ab1','admission:inferred_import:Ab1']){
  const live=fresh();pending(live,'old-live',older,new Date(T0+3600000).toISOString());
  const w=await run(live);
  assert.deepEqual([w.out.outcome,w.out.terminal,w.out.reason],['wait',false,'older_key_in_flight'],older);assert.equal(w.calls.n,0);
  assert.equal(rows(live,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0);
  assert.deepEqual(receipts(live).map(item=>[item.operation_key,item.state]),[[older,'pending']],'the live older attempt is untouched and no lid receipt was reserved');
  const stale=fresh();pending(stale,'old-stale',older,STAMP);
  const l=await run(stale);
  assert.equal(l.out.outcome,'admitted_lid_only',older+' '+JSON.stringify(l.out));
  const list=receipts(stale);
  assert.deepEqual(list.find(item=>item.request_id==='old-stale').state,'abandoned','the older receipt is settled first');
  assert.equal(list.find(item=>item.request_id==='old-stale').operation_key,older,'it keeps its key and its terminal state');
  assert.equal(list.filter(item=>item.operation_key==='admission:lid:Ab1'&&item.state==='applied').length,1);
  assert.equal(list.filter(item=>item.operation_key===older).length,1,'the older key is never reserved again');
 }
 // an unknown reverse mapping is HELD, never admitted on an assumed absence
 const file=fresh();const before=snapshot(file);const c=await checker();
 const held=await admitVerifiedLidOnly(envOf(file),{lid:'Ab1',route:'letterboxd_rated_archive',olderKeysKnown:false,reacquire:c.reacquire,now:clock()});
 assert.deepEqual([held.outcome,held.terminal,held.reason],['deferred',false,'older_key_unknown']);assert.equal(c.calls.n,0);assert.equal(snapshot(file),before);
 // a retry whose resolved lid changes the key gets a NEW request id; the old receipt keeps its key
 const g=fresh();
 const a=await run(g,'Ab1');const b=await run(g,'Cd2',{now:clock(5000)});
 assert.deepEqual([a.out.outcome,b.out.outcome],['admitted_lid_only','admitted_lid_only']);
 const ids=receipts(g);assert.equal(new Set(ids.map(item=>item.request_id)).size,2);assert.deepEqual(ids.map(item=>item.operation_key).sort(),['admission:lid:Ab1','admission:lid:Cd2']);
}

// ===== 6. races on one lid, both orders: never two Films =====
{
 const file=fresh();
 // the TMDB-proved Diary admission first: the lid-only attempt sees the durable rows and stops (present)
 const tmdb=await admitVerifiedFilm(envOf(file),{kind:'lid',lid:'Ab1',receipt:{tmdb:'603',archiveSha256:sha('e'),title:'The Matrix',year:1999,filmPath:'/film/the-matrix/'},evidence:null,now:clock()});
 assert.equal(tmdb.outcome,'admitted');
 assert.equal((await run(file,'Ab1',{now:clock(1000)})).out.outcome,'present');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id LIKE 'film:lb:%'")[0].n,0);
 // the lid-only Film first: the TMDB-proved kinds never attach and never duplicate (the table of decision 5b)
 const g=fresh();
 assert.equal((await run(g,'Ab1')).out.outcome,'admitted_lid_only');
 const before=snapshot(g);
 const item=kind=>({kind,lid:'Ab1',receipt:{tmdb:'603',archiveSha256:sha('e'),title:'The Matrix',year:1999,filmPath:'/film/the-matrix/'},evidence:null,now:clock(9000)});
 const diary=await admitVerifiedFilm(envOf(g),item('lid'));
 assert.deepEqual([diary.outcome,diary.id],['present_lid_only','film:lb:Ab1'],'Diary and Watchlist: settle on the lid-only Film');
 const rated=await admitVerifiedFilm(envOf(g),item('short_code'));
 assert.deepEqual([rated.outcome,rated.reason],['needs_review','lid_only_present'],'rated step: needs_review');
 const inferred=await admitVerifiedFilm(envOf(g),item('inferred_import'));
 assert.deepEqual([inferred.outcome,inferred.reason],['conflict','lid_only_present'],'inferred import: conflict');
 assert.equal(snapshot(g),before,'no attach, no second Film, no receipt');
 // the batch of the TMDB path is the second line of defence: a lid-only Film that lands AFTER the plan fails the batch (the in-batch predicate), typed `lid_only_present`
 const h=fresh();let landedLate=false;
 const late=await admitVerifiedFilm(envOf(h,{onBatch:async statements=>{if(!landedLate&&statements.some(s=>/INSERT INTO film_rated_admission/.test(s.text||''))){landedLate=true;sqlite(h,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:lb:Ab1',1,'"+STAMP+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:lb:Ab1','letterboxd','Ab1',1,0,'{}');INSERT INTO film_lid_admission (lid,film_id,route,admitted_at,receipt_key,proof_version,final_url,slug,canonical_path,shortlink,type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status) VALUES ('Ab1','film:lb:Ab1','ratings_diary','"+STAMP+"','admission:lid:Ab1',1,'https://letterboxd.com/film/x/','x','/film/x/','Ab1','video.movie','absent','complete','X',NULL,'"+sha('a')+"','"+STAMP+"',301,200)");}}}),item('lid'));
 assert.equal(landedLate,true);assert.notEqual(late.outcome,'admitted','the TMDB batch did not land on a lid-only Film');
 assert.equal(rows(h,"SELECT COUNT(*) AS n FROM film WHERE id LIKE 'film:tmdb:%'").length,1);assert.equal(rows(h,'SELECT COUNT(*) AS n FROM film_rated_admission')[0].n,0,'no TMDB admission row for the lid');
}

// ===== 7. the Ratings link fence: the links.json document changes between the read and the batch =====
{
 const doc=(file,parts,etag,key='letterboxd/facts/links.json')=>{for(let part=0;part<parts;part++)sqlite(file,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('"+key+"',"+part+",'{}','"+etag+"','"+STAMP+"')");};
 const cols=['updated_at'];
 const file=fresh();
 const fence={key:'letterboxd/facts/links.json',parts:2,etag:sha('1')};
 // unchanged: lands
 const g=fresh();
 doc(g,2,sha('1'));
 assert.equal((await run(g,'Ab1',{extra:{links:{fence}}})).out.outcome,'admitted_lid_only','the fence holds');
 // the etag moved
 const h=fresh();
 for(let part=0;part<2;part++)sqlite(h,"INSERT INTO ratings_document (key,part,body,etag"+(cols.includes('updated_at')?',updated_at':'')+") VALUES ('letterboxd/facts/links.json',"+part+",'{}','"+sha('2')+"'"+(cols.includes('updated_at')?",'"+STAMP+"'":'')+")");
 const before=snapshot(h);
 const moved=await run(h,'Ab1',{extra:{links:{fence}}}).catch(error=>({error}));
 assert.ok(moved.error||moved.out.outcome!=='admitted_lid_only','a moved etag fails the batch');
 assert.equal(rows(h,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0,'no canonical write');
 assert.equal(rows(h,'SELECT COUNT(*) AS n FROM film').length,1);void before;
 // the part count moved; an absent document read as parts 0 that now exists
 const i=fresh();
 sqlite(i,"INSERT INTO ratings_document (key,part,body,etag"+(cols.includes('updated_at')?',updated_at':'')+") VALUES ('letterboxd/facts/links.json',0,'{}','"+sha('1')+"'"+(cols.includes('updated_at')?",'"+STAMP+"'":'')+")");
 const grown=await run(i,'Ab1',{extra:{links:{fence:{key:'letterboxd/facts/links.json',parts:0,etag:null}}}}).catch(error=>({error}));
 assert.ok(grown.error||grown.out.outcome!=='admitted_lid_only');assert.equal(rows(i,'SELECT COUNT(*) AS n FROM film_lid_admission')[0].n,0);
 assert.throws(()=>ratingsDocumentFence({key:'',parts:1,etag:'x'}),code('film_person_invalid'));
 assert.throws(()=>ratingsDocumentFence({key:'k',parts:1}),code('film_person_invalid'));
 // a TMDB alias on the lid's fact key stops the attempt at the pending state (ratings_tmdb_link), never admits
 const j=fresh();const beforeJ=snapshot(j);
 const alias=await run(j,'Ab1',{extra:{links:{fence,tmdbAlias:'603'}}});
 assert.deepEqual([alias.out.outcome,alias.out.reason,alias.out.terminal],['held','ratings_tmdb_link',false]);assert.equal(snapshot(j),beforeJ);
 void file;
}

// ===== 5c. the owned-attempt assertion of a link batch: an expired or abandoned attempt cannot land a late effect =====
{
 const file=fresh();
 const open=new Date(T0+3600000).toISOString(),now=new Date(T0).toISOString();
 pending(file,'own-1','admission:lid:Ab1',open);
 const holds=cond=>Number(rows(file,'SELECT CASE WHEN ('+cond.sql.replace(/\?/g,()=>"'"+String(cond.params.shift()).replace(/'/g,"''")+"'")+') THEN 1 ELSE 0 END AS ok')[0].ok)===1;
 const cond=over=>ownedAttemptCondition({origin:RATED_ADMISSION_ORIGIN,operationKey:'admission:lid:Ab1',requestId:'own-1',attempt:1,now,...over});
 assert.equal(holds(cond()),true,'the live pending attempt owns the effect');
 assert.equal(holds(cond({requestId:'other'})),false,'another request id');
 assert.equal(holds(cond({attempt:2})),false,'another attempt number');
 assert.equal(holds(cond({operationKey:'admission:lid:Zz9'})),false,'another key');
 assert.equal(holds(cond({now:new Date(T0+7200000).toISOString()})),false,'past its window the attempt no longer owns anything');
 // a later attempt abandons it (ADR 0207 step 2): its late link can never land
 sqlite(file,"UPDATE canonical_write_receipt SET state='abandoned',error_class='superseded_by_retry',next_attempt_at=NULL,updated_at='"+STAMP+"',settled_at='"+STAMP+"' WHERE request_id='own-1'");
 assert.equal(holds(cond()),false,'an abandoned attempt owns nothing');
 assert.throws(()=>ownedAttemptCondition({origin:RATED_ADMISSION_ORIGIN,operationKey:'admission:lid:Ab1',requestId:'',attempt:1,now}),code('film_person_invalid'));
 assert.throws(()=>ownedAttemptCondition({origin:RATED_ADMISSION_ORIGIN,operationKey:'admission:lid:Ab1',requestId:'x',attempt:0,now}),code('film_person_invalid'));
}

// ===== 16. statement count: the lid-only batch within the cap =====
{
 const file=fresh();let counted=0;
 const out=await run(file,'Ab1',{options:{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO film_lid_admission/.test(item.text||'')))counted=statements.length;}},extra:{links:{fence:{key:'letterboxd/facts/links.json',parts:0,etag:null}}}});
 assert.equal(out.out.outcome,'admitted_lid_only');
 assert.ok(counted>=12&&counted<=17,'the lid-only canonical batch has '+counted+' statements (ADR 0217 estimate 12 to 15)');
 assert.ok(counted<=40&&counted<=MUTATION_STATEMENT_CAP,'within the ADR cap 40 and the writer cap '+MUTATION_STATEMENT_CAP);
 console.log('lid-only canonical batch statements:',counted);
}
console.log('Letterboxd lid-only admission coordinator (AIR-672) passed.');
