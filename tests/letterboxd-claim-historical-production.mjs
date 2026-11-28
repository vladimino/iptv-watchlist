// AIR-653: the dormant owner-run operator of the historical bridge-only claims (scripts/letterboxd-claim-historical-production.mjs). Offline only: a scratch sqlite database built from the real
// migration chain behind the D1 stand-in AND behind a stub REST transport (the real adapter and strict binding), SYNTHETIC ids, the REAL writer, receipt protocol and planner; no network, no credential.
//  - the allowlist, dry_run (bounded capture, strict reads, exact index definitions), every refusal, the seven pins;
//  - the approval fence through the receipt lifecycle: a pin or a witness that moves BEFORE the reservation refuses the pair before any receipt exists; one that moves at the claim batch leaves a reserved
//    receipt and no claim, reported as two kinds of write; a prior unresolved receipt makes the cohort unsafe and no further batch is sent;
//  - the readback is strict and fails closed: an unreadable first or last reproof after a successful write, a marker that moves during the final reads, a wrong target or a wrong receipt are never `complete`;
//  - a complete run: one trusted claim per pair, the exact applied receipt per pair, the reader that answered 404 agreeing on the Film and the movie, the per-target effects exact, a repeat writing nothing;
//  - the REAL REST binding: a malformed answer is unknown with no write sent, a lost reply on the claim batch stops the run and the next run is refused;
//  - the output never names a lid, movie or Film id.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';
import {PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from '../scripts/published-epg-production.mjs';
import {HISTORICAL_MAX,HistoricalStop,PIN_NAMES,parseAllowlist,readAllowlistFile,strictBinding,linkIndexWithinCaps,inspect,dryRun,applyHistorical,main,EXIT} from '../scripts/letterboxd-claim-historical-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-hist-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
const U='2026-11-01T00:00:00.000Z';
const FID=k=>'film:tmdb:'+k;
const template=path.join(root,'template.sqlite');
sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const putDoc=(file,key,value)=>{const text=JSON.stringify(value),tag=crypto.createHash('sha256').update(text).digest('hex');sqlite(file,'DELETE FROM ratings_document WHERE key='+q(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+q(key)+',0,'+q(text)+','+q(tag)+','+q(U)+')');};
const getDoc=(file,key)=>{const r=rows(file,'SELECT body FROM ratings_document WHERE key='+q(key));return r.length?JSON.parse(r[0].body):null;};
const LIDS=['H001','H002','H003','H004'];
let counter=0;
// A database whose pairs (H00k, movie k) are each provable: a canonical Film that owns the movie, the authoritative Ratings link and the projection.
function world(pairs=LIDS.length){
 const file=path.join(root,'w-'+(counter++)+'.sqlite');
 fs.copyFileSync(template,file);
 sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE+"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;UPDATE owner_review_authority SET mode='d1' WHERE id=1;");
 for(let k=1;k<=pairs;k++){
  const lid=LIDS[k-1],key='tmdb-'+k;
  sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',2,'tmdb:"+k+"','Kept Title','"+U+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(k)+"','tmdb','"+k+"',1,0,NULL);");
  sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ("+q(lid)+","+q(key)+",NULL,NULL,1,0,'"+U+"');INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('tmdb_"+k+"',"+q(key)+",NULL,NULL,1,0,'"+U+"');");
  const index=getDoc(file,'letterboxd/facts/links.json')||{};
  index['letterboxd:'+lid]=key;index['tmdb:'+k]=key;
  putDoc(file,'letterboxd/facts/links.json',index);
  putDoc(file,'letterboxd/facts/films/'+key+'.json',{schemaVersion:1,factKey:key,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
 }
 return file;
}
const PAIRS=LIDS.map((lid,i)=>({lid,tmdb:String(i+1)}));
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const dump=file=>String(sqliteSync([file,'.dump'],{encoding:'utf8',maxBuffer:1<<30}).stdout);
const trusted=file=>rows(file,"SELECT film_id,value,trusted,conflicting,provenance_json FROM film_external_id WHERE scheme='letterboxd' ORDER BY value");
const receipts=file=>rows(file,"SELECT request_id,state,target_id,applied_revision FROM canonical_write_receipt WHERE origin='letterboxd_claim' ORDER BY target_id");
const NO_NAMES=text=>!/H00\d|tmdb:\d|film:tmdb/.test(text);
const pinArgs=pins=>({filmPersonGeneration:pins.filmPersonGeneration,ratingsGeneration:pins.ratingsGeneration,schemaVersion:pins.schemaVersion,ownerReviewGeneration:pins.ownerReviewGeneration,ownerReviewWrites:pins.ownerReviewWrites,count:pins.count,digest:pins.digest});
const ADMISSION=(k,lid,archive)=>"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(k))+",'"+k+"',"+q(lid)+","+q(archive)+",'T',2000,'rk','tmdb_"+k+"','2026-11-01T00:00:00.000Z','rq"+k+"',"+q(U)+")";

// ---- 1. the allowlist --------------------------------------------------------------------------------------------------------------------------------
assert.deepEqual(parseAllowlist(JSON.stringify({eligible:[{lid:'H002',tmdb:'2'},{lid:'H001',tmdb:'1'}],results:[{ignored:true}]})),[{lid:'H001',tmdb:'1'},{lid:'H002',tmdb:'2'}],'the capture shape, sorted, extra fields ignored');
assert.deepEqual(parseAllowlist(JSON.stringify([{lid:'H001',tmdb:'1'}])),[{lid:'H001',tmdb:'1'}],'a bare list');
const reason=text=>{try{parseAllowlist(text);return null;}catch(error){assert.ok(error instanceof HistoricalStop);return error.reason;}};
assert.equal(reason('not json'),'allowlist_unreadable');
assert.equal(reason('{}'),'allowlist_shape');assert.equal(reason('"x"'),'allowlist_shape');
assert.equal(reason('[]'),'allowlist_empty');
assert.equal(reason(JSON.stringify(Array.from({length:HISTORICAL_MAX+1},(_,i)=>({lid:'L'+i,tmdb:String(i+1)})))),'allowlist_over_limit');
assert.equal(reason(JSON.stringify([{lid:'H001',tmdb:'1'},{lid:'H001',tmdb:'2'}])),'allowlist_duplicate','one pair per lid');
assert.equal(reason(JSON.stringify([{lid:'H001',tmdb:'1'},{lid:'H002',tmdb:'1'}])),'allowlist_duplicate','one pair per movie');
for(const bad of [{lid:'tmdb_5',tmdb:'5'},{lid:'H1',tmdb:'0'},{lid:'H1',tmdb:'05'},{lid:'H 1',tmdb:'5'},{lid:'',tmdb:'5'},{lid:'H1',tmdb:5},{lid:'H1'},null,'x'])assert.equal(reason(JSON.stringify([bad])),'allowlist_invalid_pair',JSON.stringify(bad));
{
 const file=path.join(root,'allow.json');fs.writeFileSync(file,'[]');
 assert.equal(readAllowlistFile(file),'[]');
 const link=path.join(root,'allow-link.json');fs.symlinkSync(file,link);
 assert.throws(()=>readAllowlistFile(link),error=>error.reason==='allowlist_not_a_regular_file','a link is refused');
 assert.throws(()=>readAllowlistFile(path.join(root,'missing.json')),error=>error.reason==='allowlist_unreadable');
 assert.throws(()=>readAllowlistFile('package.json'),error=>error.reason==='allowlist_inside_repository','a file inside the repository is refused');
}

// ---- 2. dry_run: bounded capture, strict reads, the seven pins --------------------------------------------------------------------------------------
{
 const file=world(),before=dump(file);
 const out=await dryRun(envOf(file),PAIRS);
 assert.deepEqual([out.mode,out.sideEffects,out.decision],['dry_run','none','eligible'],JSON.stringify(out.blockers));
 assert.deepEqual(out.counts,{pairs:4,would_write:4,already:0,refused:0,unknown:0,duplicate:0});
 assert.deepEqual(Object.keys(out.expect),PIN_NAMES);
 assert.deepEqual(out.expect,{filmPersonGeneration:2,ratingsGeneration:out.markers.ratings.generation,schemaVersion:out.markers.schema.version,ownerReviewGeneration:out.markers.ownerReview.generation,ownerReviewWrites:out.markers.ownerReview.writes,count:4,digest:await cohortDigest(PAIRS)});
 assert.ok(out.work.statements>0&&out.work.statements<=300&&out.work.rowsReserved<=6000,'the dry run is the bounded capture: '+JSON.stringify(out.work));
 assert.equal(dump(file),before,'dry_run writes nothing');
 assert.ok(NO_NAMES(JSON.stringify(out)),'no lid, movie or Film id in the output');
 assert.ok(!('results' in out),'the per-pair results stay inside the process');
}
const refused=async(name,mutate,expectReason,decision='unsafe')=>{
 const file=world();mutate(file);
 const out=await dryRun(envOf(file),PAIRS);
 assert.equal(out.decision,decision,name+': '+JSON.stringify(out.blockers));
 assert.ok(out.blockers.some(item=>item.reason===expectReason),name+': '+JSON.stringify(out.blockers));
};
await refused('an admission row of the movie under the same lid',file=>sqlite(file,ADMISSION(1,'H001','a'.repeat(64))),'inferred_admission_witness');
await refused('an admission row of the movie under ANOTHER lid and archive',file=>sqlite(file,ADMISSION(2,'OTHER','b'.repeat(64))),'witness_movie_admitted_other_lid','unknown');
await refused('a rival (third) alias on a fact key',file=>sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('RIVAL','tmdb-3',NULL,NULL,0,0,"+q(U)+")"),'ratings_alias_ambiguous');
await refused('a lid already claimed elsewhere by a trusted claim',file=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:thief',2,NULL,'T',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:thief','letterboxd','H004',1,0,NULL)"),'lid_claimed_elsewhere');
await refused('a missing ratings_view_fact_key index',file=>sqlite(file,'DROP INDEX ratings_view_fact_key'),'required_index_missing','unknown');
await refused('an index of the right name on another column',file=>sqlite(file,'DROP INDEX tmdb_retirement_decision_movie;CREATE INDEX tmdb_retirement_decision_movie ON tmdb_retirement_decision (film_id)'),'required_index_missing','unknown');
await refused('a held Film/Person marker',file=>sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1"),'film_person_not_open');
await refused('a ratings domain that is not d1',file=>sqlite(file,"UPDATE ratings_domain_authority SET mode='r2' WHERE id=1"),'ratings_not_authoritative');
await refused('an owner-review domain that is not d1',file=>sqlite(file,"UPDATE owner_review_authority SET mode='r2' WHERE id=1"),'authority_unreadable');
await refused('a pair with no fact record',file=>sqlite(file,"DELETE FROM ratings_document WHERE key LIKE 'letterboxd/facts/films/%'"),'ratings_record_absent','unknown');
{
 const file=world();
 const out=await dryRun(envOf(file),[...PAIRS,{lid:'H009',tmdb:'9'}]);
 assert.notEqual(out.decision,'eligible','a pair with no link or Film is not eligible');
 const mismatch=await dryRun(envOf(file),[{lid:'H001',tmdb:'2'}]);
 assert.deepEqual([mismatch.decision,mismatch.blockers.map(item=>item.reason)],['unknown',['allowlist_movie_mismatch']],'a pair whose authoritative link names another movie');
}

// ---- 3. apply: refusals before any write --------------------------------------------------------------------------------------------------------------
{
 const file=world(),before=dump(file),env=envOf(file);
 const pins=(await dryRun(env,PAIRS)).expect;
 const good={expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-1'};
 const refusedWith=async(over,expectReason)=>{const out=await applyHistorical(env,PAIRS,{...good,...over});assert.deepEqual([out.outcome,out.claimsWritten,out.reason],['refused',0,expectReason]);assert.equal(dump(file),before,expectReason+': nothing written');return out;};
 await refusedWith({confirmGo:false},'confirm_required');
 await refusedWith({confirmGo:undefined},'confirm_required');
 await refusedWith({requestId:'short'},'invalid_request_id');
 await refusedWith({requestId:undefined},'invalid_request_id');
 await refusedWith({expected:{...good.expected,filmPersonGeneration:-1}},'invalid_expected_generation');
 await refusedWith({expected:{...good.expected,ownerReviewGeneration:-1}},'invalid_expected_generation');
 await refusedWith({expected:{...good.expected,schemaVersion:0}},'invalid_expected_schema_version');
 await refusedWith({expected:{...good.expected,ownerReviewWrites:'x'}},'invalid_expected_owner_review_writes');
 await refusedWith({expected:{...good.expected,count:0}},'invalid_expected_count');
 await refusedWith({expected:{...good.expected,count:HISTORICAL_MAX+1}},'invalid_expected_count');
 await refusedWith({expected:{...good.expected,digest:'xyz'}},'invalid_expected_digest');
 for(const [name,value] of [['filmPersonGeneration',pins.filmPersonGeneration+1],['ratingsGeneration',pins.ratingsGeneration+1],['schemaVersion',pins.schemaVersion+1],['ownerReviewGeneration',pins.ownerReviewGeneration+1],['ownerReviewWrites',pins.ownerReviewWrites==='open'?'held':'open'],['count',3],['digest','f'.repeat(64)]]){
  const out=await refusedWith({expected:{...good.expected,[name]:value}},'pins_mismatch');
  assert.deepEqual(out.mismatched,[name],'exactly the differing pin is named');
 }
 const subset=await applyHistorical(env,PAIRS.slice(0,2),{...good});
 assert.deepEqual([subset.outcome,subset.reason],['refused','pins_mismatch']);assert.equal(dump(file),before);
}

// ---- 4. a complete run: exact claims, exact receipts, the reader agrees, exact per-target effects, idempotence -----------------------------------------
{
 const file=world(),env=envOf(file);
 for(const lid of LIDS)assert.equal((await catalogStartedFilm(env,lid)).state==='found',false,'before: the reader answers not found');
 const pins=(await dryRun(env,PAIRS)).expect;
 const revisionsBefore=rows(file,"SELECT id,revision FROM canonical_revision WHERE kind='film' ORDER BY id");
 const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-2'});
 assert.deepEqual([out.outcome,out.claimsWritten],['complete',4],JSON.stringify(out));
 assert.deepEqual(out.counts,{written:4,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0});
 assert.equal(out.receipts.created,4,'receipt rows are reported as their own kind of write');
 assert.deepEqual([out.readback.status,out.readback.verified,out.readback.expected,out.readback.markersHold],['complete',4,4,true]);
 assert.deepEqual(out.readback.checks,{claim:true,receipt:true,reader:true,reproof:true});
 assert.equal(out.readback.collateral.exact,true);assert.equal(out.readback.collateral.targetsExact,true);
 assert.deepEqual(out.readback.collateral.tableDelta,{film_external_id:4,film_alias:0,ratings_view:0,started_mark:out.readback.collateral.tableDelta.started_mark});
 assert.ok(NO_NAMES(JSON.stringify(out)),'the apply output names no lid, movie or Film id');
 const claims=trusted(file);
 assert.equal(claims.length,4);
 for(const [i,claim] of claims.entries()){
  assert.deepEqual([claim.film_id,claim.value,claim.trusted,claim.conflicting],[FID(i+1),LIDS[i],1,0]);
  assert.deepEqual(JSON.parse(claim.provenance_json),{source:'ratings_alias_bridge',tmdb:String(i+1),adr:'0184'});
 }
 for(const lid of LIDS){const found=await catalogStartedFilm(env,lid);assert.equal(found.state,'found');}
 const stored=receipts(file);
 assert.deepEqual([stored.length,[...new Set(stored.map(item=>item.state))]],[4,['applied']],'one applied receipt per pair, origin letterboxd_claim');
 const revisionsAfter=rows(file,"SELECT id,revision FROM canonical_revision WHERE kind='film' ORDER BY id");
 assert.deepEqual(revisionsAfter.map(item=>item.revision-(revisionsBefore.find(old=>old.id===item.id)?.revision??0)),[1,1,1,1],'each target Film moved by exactly one revision, no other Film');
 for(const receipt of stored)assert.equal(receipt.applied_revision,revisionsAfter.find(item=>item.id===receipt.target_id).revision,'the applied revision of each receipt is the Film revision');
 // A repeat finds nothing missing: no longer eligible, zero writes, the claims unchanged.
 const again=dump(file);
 const repeat=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-2'});
 assert.deepEqual([repeat.outcome,repeat.claimsWritten,repeat.reason],['refused',0,'not_eligible']);
 assert.equal(dump(file),again,'a repeat writes nothing');
 assert.equal((await dryRun(env,PAIRS)).decision,'already_current');
}

// ---- 5. the approval fence through the receipt lifecycle ---------------------------------------------------------------------------------------------
const reserving=statements=>statements.some(item=>/INSERT INTO canonical_write_receipt/i.test(item.text));
const claiming=statements=>statements.some(item=>/INSERT INTO film_external_id/i.test(item.text));
{
 // (a) A pin or a witness that moves BEFORE the receipt is reserved refuses the pair before any receipt exists: nothing durable at all.
 for(const [name,hostile] of [
  ['the Ratings generation moves',file=>sqlite(file,'UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1')],
  ['a witness row of the movie appears',file=>sqlite(file,ADMISSION(1,'NEWLID','c'.repeat(64)))],
  ['the owner-review generation moves',file=>sqlite(file,'UPDATE owner_review_authority SET generation=generation+1 WHERE id=1')],
 ]){
  const file=world();let hit=false;
  const env=envOf(file,{onBatch:async statements=>{if(!hit&&reserving(statements)){hit=true;hostile(file);}}});
  const pins=(await dryRun(env,PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-5a'});
  assert.equal(hit,true,name+': the hostile change ran just before the reservation');
  assert.equal(out.outcome,'partial',name);
  assert.deepEqual([out.claimsWritten,out.receipts.created,trusted(file).length,receipts(file).length],[0,0,0,0],name+': no claim and no receipt: the reservation itself asserted the approved pins');
  assert.equal(out.counts.notAttempted,LIDS.length-1,name+': the rest is not attempted');
 }
 // (b) A witness that appears AFTER the reservation is refused inside the claim batch: the reserved receipt stays, the claim does not. Reported as two kinds of write.
 let leftover;
 {
  const file=world();let hit=false;
  const env=envOf(file,{onBatch:async statements=>{if(!hit&&claiming(statements)){hit=true;sqlite(file,ADMISSION(1,'NEWLID','c'.repeat(64)));}}});
  const pins=(await dryRun(env,PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-5b'});
  assert.equal(out.outcome,'partial');
  assert.deepEqual([out.claimsWritten,trusted(file).length],[0,0],'no claim');
  assert.equal(out.receipts.created,1,'the reserved receipt of the refused pair is reported: the claim batch rolled back, the receipt did not');
  assert.equal(receipts(file).length,1);assert.notEqual(receipts(file)[0].state,'applied');
  assert.equal(out.counts.notAttempted,LIDS.length-1);
  leftover={file,pins};
 }
 // (c) The prior attempt is never replayed: the cohort is unsafe, an apply is refused and NO batch is sent.
 {
  const {file,pins}=leftover;
  sqlite(file,"DELETE FROM film_rated_admission");// the witness is gone again: only the receipt of the prior attempt stands in the way
  let batches=0;
  const env=envOf(file,{onBatch:async()=>{batches++;}});
  const dry=await dryRun(env,PAIRS);
  assert.deepEqual([dry.decision,dry.blockers.map(item=>item.reason)],['unsafe',['prior_receipt_unresolved']],'a prior unresolved receipt makes the cohort unsafe; recovery is a separate decision');
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-5c'});
  assert.deepEqual([out.outcome,out.reason,out.claimsWritten],['refused','not_eligible',0]);
  assert.equal(batches,0,'no batch was sent: neither a retry nor a new attempt');
  assert.equal(receipts(file).length,1,'the prior receipt is untouched');
 }
}

// ---- 6. the readback is strict and fails closed --------------------------------------------------------------------------------------------------------
{
 // The final phase starts at the first query of the per-pair verification (its claim read ends with LIMIT 3).
 const phase=(file,onFinal)=>{
  let finalSeen=false,afterFinal=0;
  return d1Standin(file,{onQuery:async text=>{
   if(!finalSeen&&/FROM film_external_id WHERE scheme='letterboxd' AND value='H00\d' LIMIT 3/.test(text))finalSeen=true;
   if(finalSeen){afterFinal++;await onFinal(text,afterFinal);}
  }});
 };
 for(const [name,nth] of [['the first reproof read of the final phase fails',1],['the last reproof read of the final phase fails',null]]){
  const file=world();
  let ratingsReads=0;
  const db=phase(file,async(text)=>{if(/FROM ratings_document/.test(text)){ratingsReads++;if(nth?ratingsReads===nth:ratingsReads===LIDS.length*2)throw new Error('injected read failure')}});
  const env={DB:db};
  const pins=(await dryRun({DB:d1Standin(file)},PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-6a'});
  assert.equal(out.claimsWritten,4,name+': the writes happened');
  assert.notEqual(out.outcome,'complete',name);
  assert.equal(out.outcome,'unverified',name);
  assert.equal(out.readback.status,'incomplete',name);
 }
 {
  // A marker that moves during the final reads: the fence runs AFTER them, so the run is not complete.
  const file=world();let moved=false;
  const env={DB:phase(file,async text=>{if(!moved&&/FROM ratings_document/.test(text)){moved=true;sqlite(file,'UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1');}})};
  const pins=(await dryRun({DB:d1Standin(file)},PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-6b'});
  assert.equal(out.claimsWritten,4);assert.equal(out.readback.markersHold,false);assert.equal(out.outcome,'unverified','a marker moved during the final reproof is not complete');
 }
 for(const [name,tamper] of [
  ['a claim that names another Film',file=>{sqlite(file,"PRAGMA foreign_keys=OFF;UPDATE film_external_id SET film_id='film:tmdb:2' WHERE scheme='letterboxd' AND value='H001'");}],
  ['a claim without the ADR 0184 provenance',file=>sqlite(file,"UPDATE film_external_id SET provenance_json='{\"source\":\"other\"}' WHERE scheme='letterboxd' AND value='H001'")],
  ['a receipt of another content',file=>{for(const trigger of rows(file,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='canonical_write_receipt'"))sqlite(file,'DROP TRIGGER '+trigger.name);sqlite(file,"UPDATE canonical_write_receipt SET content_digest='"+'0'.repeat(64)+"' WHERE target_id='film:tmdb:1'");}],
  ['a receipt with another applied revision',file=>{for(const trigger of rows(file,"SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='canonical_write_receipt'"))sqlite(file,'DROP TRIGGER '+trigger.name);sqlite(file,"UPDATE canonical_write_receipt SET applied_revision=applied_revision+3 WHERE target_id='film:tmdb:1'");}],
 ]){
  const file=world();let done=false;
  const env={DB:phase(file,async()=>{if(!done){done=true;tamper(file);}})};
  const pins=(await dryRun({DB:d1Standin(file)},PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-6c'});
  assert.equal(out.claimsWritten,4,name);
  assert.notEqual(out.outcome,'complete',name+': never complete on a wrong target or receipt');
  assert.equal(out.outcome,'unverified',name);
 }
}

// ---- 6b. the link-index document is measured against the AIR-647 caps before each pair's live planner reads ------------------------------------------------
{
 const {LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES}=await import('../src/film-aggregate.js');
 const db=d1Standin(world());
 assert.equal(await linkIndexWithinCaps(db),true,'a normal document is within the caps');
 const parts=world();
 for(let part=1;part<=LINK_DOCUMENT_MAX_PARTS;part++)sqlite(parts,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('letterboxd/facts/links.json',"+part+",'x','"+'e'.repeat(64)+"',"+q(U)+")");
 assert.equal(await linkIndexWithinCaps(d1Standin(parts)),false,'more parts than the cap');
 const big=world();
 sqlite(big,"UPDATE ratings_document SET body=body||replace(hex(zeroblob("+(LINK_DOCUMENT_MAX_BYTES+10)+")),'00','a') WHERE key='letterboxd/facts/links.json'");
 assert.equal(await linkIndexWithinCaps(d1Standin(big)),false,'more bytes than the cap');
 const absent=world();sqlite(absent,"DELETE FROM ratings_document WHERE key='letterboxd/facts/links.json'");
 assert.equal(await linkIndexWithinCaps(d1Standin(absent)),false,'an absent document is not within the caps (it proves nothing)');
 // A document that grew past the caps after the dry run is refused by the apply before any write (the bounded capture inside the derivation reads it with the same caps).
 const grown=world();const pins=(await dryRun(envOf(grown),PAIRS)).expect;
 sqlite(grown,"UPDATE ratings_document SET body=body||replace(hex(zeroblob("+(LINK_DOCUMENT_MAX_BYTES+10)+")),'00','a') WHERE key='letterboxd/facts/links.json'");
 const out=await applyHistorical(envOf(grown),PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-6d'});
 assert.deepEqual([out.outcome,out.claimsWritten],['refused',0]);assert.equal(trusted(grown).length,0);
}

// ---- 7. the REAL REST binding: strict reads, lost reply, malformed answers ------------------------------------------------------------------------------
{
 const {createD1Adapter}=await import('../scripts/d1-backfill.mjs');
 const {productionTarget,trackProductionWrites}=await import('../scripts/published-epg-production.mjs');
 const rest=(file,{onRequest=null}={})=>{
  const wire=[];
  const fetchImpl=async(url,init={})=>{
   const body=init.body?JSON.parse(init.body):null;
   wire.push({method:init.method||'GET',batch:!!body?.batch,sql:body?.sql??null,text:body?(body.batch?body.batch.map(item=>item.sql).join(' '):body.sql):''});
   if((init.method||'GET')==='GET')return new Response(JSON.stringify({success:true,result:{uuid:PRODUCTION_DATABASE_ID,name:PRODUCTION_DATABASE_NAME}}),{status:200});
   const hook=onRequest?await onRequest(body):null;
   if(hook==='malformed')return new Response(JSON.stringify({success:true,result:[{success:true}]}),{status:200});
   const statements=(body.batch||[{sql:body.sql}]).map(item=>item.sql.replace(/;?\s*$/,''));
   const reads=statements.every(text=>/^\s*(SELECT|WITH)/i.test(text));
   if(hook==='lose_reply'){sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+statements.map(text=>text+';').join('\n')+'\nCOMMIT;',encoding:'utf8'});throw new TypeError('connection reset');}
   if(reads){
    try{return new Response(JSON.stringify({success:true,result:statements.map(text=>({success:true,results:rows(file,text),meta:{}}))}),{status:200});}
    catch(error){return new Response(JSON.stringify({success:false,errors:[{message:String(error.message).slice(0,80)}]}),{status:400});}
   }
   const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+statements.map(text=>text+';').join('\n')+'\nCOMMIT;',encoding:'utf8'});
   if(r.status!==0)return new Response(JSON.stringify({success:false,errors:[{message:String(r.stderr).slice(0,80)}]}),{status:400});
   return new Response(JSON.stringify({success:true,result:statements.map(()=>({success:true,results:[],meta:{}}))}),{status:200});
  };
  const ctx={writeState:'none'};
  const adapter=trackProductionWrites(createD1Adapter({target:productionTarget({D1_BACKFILL_ACCOUNT_ID:PRODUCTION_ACCOUNT_ID,D1_BACKFILL_API_TOKEN:'dummy-not-a-credential'}),databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),ctx);
  return {wire,ctx,adapter};
 };
 const writes=wire=>wire.filter(item=>item.method==='POST'&&!/^\s*(SELECT|WITH)\b/i.test(item.text.trim()));
 // A complete run through the real adapter and the strict binding.
 {
  const file=world();
  const {wire,adapter}=rest(file);
  const env={DB:await strictBinding(adapter)};
  const pins=(await dryRun(env,PAIRS)).expect;
  assert.equal(pins.count,4);
  assert.equal(writes(wire).length,0,'the dry run sent no write');
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-7a'});
  assert.deepEqual([out.outcome,out.claimsWritten,out.receipts.created],['complete',4,4],JSON.stringify(out.readback)+JSON.stringify(out.counts));
  assert.equal(trusted(file).length,4);
 }
 // A malformed answer (no result array) to a read is an error, never an empty table: unknown, and no write request is sent.
 for(const [name,match] of [['the witness read',/film_rated_admission/],['the link-index document read',/ratings_document/],['the receipt read',/canonical_write_receipt/],['the retirement read',/tmdb_retirement_decision/],['a marker read',/film_person_authority|ratings_domain_authority|owner_review_authority/]]){
  const file=world(),before=dump(file);
  const {wire,adapter}=rest(file,{onRequest:async body=>{const text=body.sql||(body.batch||[]).map(item=>item.sql).join(' ');return match.test(text)?'malformed':null;}});
  const env={DB:await strictBinding(adapter)};
  const out=await dryRun(env,PAIRS);
  assert.notEqual(out.decision,'eligible',name+': a malformed answer is never a negative proof');
  assert.equal(out.decision,'unknown',name);
  assert.equal(out.expect,null,name);
  const applied=await applyHistorical(env,PAIRS,{expected:{filmPersonGeneration:2,ratingsGeneration:0,schemaVersion:55,ownerReviewGeneration:0,ownerReviewWrites:'open',count:4,digest:await cohortDigest(PAIRS)},confirmGo:true,requestId:'hist-request-7b'});
  assert.equal(applied.outcome,'refused',name);
  assert.equal(dump(file),before,name+': nothing written');
  assert.equal(writes(wire).length,0,name+': no write statement was sent');
 }
 // A lost reply on the claim batch: the run stops, the state is unknown, and the next run is refused with no further write.
 {
  const file=world();let lost=false;
  const {wire,ctx,adapter}=rest(file,{onRequest:async body=>{const text=(body.batch||[{sql:body.sql}]).map(item=>item.sql).join(' ');if(!lost&&/INSERT INTO film_external_id/.test(text)){lost=true;return 'lose_reply';}return null;}});
  const env={DB:await strictBinding(adapter)};
  const pins=(await dryRun(env,PAIRS)).expect;
  const out=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-7c'});
  assert.equal(lost,true);
  assert.notEqual(out.outcome,'complete');
  assert.ok(out.counts.unknown+out.counts.deferred+out.counts.failed+out.counts.refused>=1,'the pair of the lost reply is not proved: '+JSON.stringify(out.counts));
  assert.equal(out.counts.notAttempted,LIDS.length-1,'the rest is not attempted');
  assert.equal(ctx.writeState!=='none',true,'the tracked write state says a write was attempted');
  // The claim of that pair may have committed (the reply was lost): the next run is refused and sends no write; the state is read back, never repeated.
  const afterwards=wire.length;
  const next=await applyHistorical(env,PAIRS,{expected:pinArgs(pins),confirmGo:true,requestId:'hist-request-7c'});
  assert.equal(next.outcome,'refused','a run after a partial or unknown outcome is refused');
  assert.equal(writes(wire.slice(afterwards)).length,0,'no write was sent by the refused run');
 }
}

// ---- 8. the CLI: exit codes, never a pair, input errors before any connection -------------------------------------------------------------------------
{
 const file=world(),printed=[];
 const open=async()=>({binding:d1Standin(file),ctx:{writeState:'none'}});
 const allow=path.join(root,'cli-allow.json');fs.writeFileSync(allow,JSON.stringify({eligible:PAIRS}));
 const run=(...args)=>main({argv:['node','script',...args],env:{},fetchImpl:null,print:text=>printed.push(text),openBinding:open,readFile:readAllowlistFile});
 assert.equal(await run('--allowlist',allow),EXIT.ok);
 const dry=JSON.parse(printed.at(-1));assert.deepEqual([dry.mode,dry.decision],['dry_run','eligible']);assert.ok(NO_NAMES(printed.at(-1)));
 assert.equal(await run('--allowlist',allow,'--apply','--confirm-go'),EXIT.notWritten,'apply without a request id and pins is refused, nothing written');
 assert.equal(trusted(file).length,0);
 assert.equal(await run(),EXIT.input);assert.equal(JSON.parse(printed.at(-1)).error,'allowlist_required');
 assert.equal(await run('--allowlist',allow,'--nope'),EXIT.input);assert.equal(JSON.parse(printed.at(-1)).error,'unknown_option');
 assert.equal(await run('--allowlist',path.join(root,'missing.json')),EXIT.input);
 let opened=0;
 await main({argv:['node','script','--allowlist','package.json'],env:{},print:()=>{},openBinding:async()=>{opened++;return null;},readFile:readAllowlistFile});
 assert.equal(opened,0,'an input error is reported before any connection is opened');
 const pins=dry.expect;
 assert.equal(await run('--allowlist',allow,'--apply','--confirm-go','--request-id','hist-cli-001','--expected-film-person-generation',String(pins.filmPersonGeneration),'--expected-ratings-generation',String(pins.ratingsGeneration),'--expected-schema-version',String(pins.schemaVersion),'--expected-owner-review-generation',String(pins.ownerReviewGeneration),'--expected-owner-review-writes',pins.ownerReviewWrites,'--expected-count','4','--expected-digest',pins.digest),EXIT.ok);
 const applied=JSON.parse(printed.at(-1));assert.deepEqual([applied.outcome,applied.claimsWritten,applied.writeState],['complete',4,'none']);assert.ok(NO_NAMES(printed.at(-1)));
 assert.equal(trusted(file).length,4);
}

// ---- 9. the extra approved conditions of the pins (src/canonical-mutations.js approvedPinsOf) --------------------------------------------------------------
{
 const {fenced}=await import('../src/canonical-mutations.js');
 const base={filmPersonGeneration:2,schemaVersion:55,ownerReviewGeneration:1,ownerReviewWrites:'open'};
 assert.deepEqual({...fenced.approvedPinsOf(base)},base,'without guards the pins are exactly what AIR-664 froze');
 const guard={sql:'EXISTS (SELECT 1 FROM ratings_domain_authority WHERE id=1 AND generation=?)',params:[5]};
 const withGuards=fenced.approvedPinsOf({...base,guards:[guard]});
 assert.deepEqual(withGuards.guards.map(item=>[item.sql,[...item.params]]),[[guard.sql,[5]]]);
 assert.ok(Object.isFrozen(withGuards)&&Object.isFrozen(withGuards.guards)&&Object.isFrozen(withGuards.guards[0]),'frozen: a caller cannot change an approved condition after binding');
 for(const bad of [[guard,guard,guard,guard,guard],'x',[{sql:'',params:[]}],[{sql:guard.sql,params:'x'}],[{sql:guard.sql,params:[undefined]}],[null]])assert.throws(()=>fenced.approvedPinsOf({...base,guards:bad}),error=>error.code==='film_person_invalid',JSON.stringify(bad).slice(0,40));
 const gate=fenced.bindApprovedPins({generation:2},{...base,guards:[guard]});
 assert.ok(gate.approvedPins.guards.length===1);
}

console.log('letterboxd claim historical production operator: ok');
