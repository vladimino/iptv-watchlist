// AIR-653: the dormant owner-run operator of the historical bridge-only claims (scripts/letterboxd-claim-historical-production.mjs). Offline only: a scratch sqlite database built from the real
// migration chain behind the D1 stand-in, SYNTHETIC ids, the REAL writer (`applyLetterboxdClaim`, the fenced `film_external_ids` unit) and the REAL planner; no network, no credential.
//  - the allowlist: the private shape of the bounded capture or a bare list, strict, one pair per lid and per movie, 1 to 12 pairs, a file outside the repository;
//  - dry_run: read-only (the database is byte-for-byte unchanged), the pins and the digest, and every refusal: an admission row of the movie under any lid or archive, a planner conflict, a missing
//    index, a held or non-authoritative marker;
//  - apply: refused without the confirmation, a request id or any of the four pins, on a pin that differs, on a pair that is not eligible; a complete run writes exactly one trusted claim per pair
//    (provenance of ADR 0184), reads each back with the reader that answered 404, moves no other row, and a repeat writes nothing; a witness inserted between the proof and the write is refused INSIDE
//    the writer's batch; the run stops at the first pair that is not proved; the output never names a lid, movie or Film id.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {catalogStartedFilm} from '../src/canonical-catalog-reader.js';
import {HISTORICAL_MAX,HistoricalStop,parseAllowlist,readAllowlistFile,inspect,dryRun,applyHistorical,main,EXIT} from '../scripts/letterboxd-claim-historical-production.mjs';

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
 sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE+"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;");
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
const NO_NAMES=text=>!/H00\d|tmdb:\d|film:tmdb/.test(text);

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

// ---- 2. dry_run --------------------------------------------------------------------------------------------------------------------------------------
{
 const file=world(),before=dump(file);
 const out=await dryRun(envOf(file),PAIRS);
 assert.deepEqual([out.mode,out.sideEffects,out.decision],['dry_run','none','eligible']);
 assert.deepEqual(out.counts,{pairs:4,would_write:4,already:0,refused:0,unknown:0,duplicate:0});
 assert.deepEqual(out.expect,{filmPersonGeneration:2,ratingsGeneration:out.markers.ratings.generation,count:4,digest:await cohortDigest(PAIRS)});
 assert.equal(dump(file),before,'dry_run writes nothing');
 assert.ok(NO_NAMES(JSON.stringify(out)),'no lid, movie or Film id in the output');
 assert.ok(!('results' in out),'the per-pair results stay inside the process');
}
const refused=async(name,mutate,expectReason,decision='unsafe')=>{
 const file=world();mutate(file);
 const out=await dryRun(envOf(file),PAIRS);
 assert.equal(out.decision,decision,name);
 assert.ok(out.blockers.some(item=>item.reason===expectReason),name+': '+JSON.stringify(out.blockers));
 assert.equal(out.expect===null||decision==='unsafe',true);
};
await refused('an admission row of the movie under the same lid',file=>sqlite(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(1))+",'1','H001',"+q('a'.repeat(64))+",'T',2000,'rk','tmdb_1','2026-11-01T00:00:00.000Z','rq1',"+q(U)+")"),'inferred_admission_witness');
await refused('an admission row of the movie under ANOTHER lid and archive',file=>sqlite(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(2))+",'2','OTHER',"+q('b'.repeat(64))+",'T',2000,'rk','tmdb_2','2026-11-01T00:00:00.000Z','rq2',"+q(U)+")"),'inferred_admission_witness');
await refused('a rival (third) alias on a fact key',file=>sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('RIVAL','tmdb-3',NULL,NULL,0,0,"+q(U)+")"),'ratings_alias_ambiguous');
await refused('a lid already claimed elsewhere by a trusted claim',file=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:thief',2,NULL,'T',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:thief','letterboxd','H004',1,0,NULL)"),'lid_claimed_elsewhere');
await refused('a missing ratings_view_fact_key index',file=>sqlite(file,'DROP INDEX ratings_view_fact_key'),'required_index_missing');
await refused('a missing retirement ledger index',file=>sqlite(file,'DROP INDEX tmdb_retirement_decision_movie'),'required_index_missing');
await refused('a held Film/Person marker',file=>sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1"),'film_person_not_open');
await refused('a ratings domain that is not d1',file=>sqlite(file,"UPDATE ratings_domain_authority SET mode='r2' WHERE id=1"),'ratings_not_authoritative');
{
 const file=world();
 const out=await dryRun(envOf(file),[...PAIRS,{lid:'H009',tmdb:'9'}]);
 assert.notEqual(out.decision,'eligible','a pair with no link or Film is not eligible');
 assert.ok(out.counts.refused+out.counts.unknown>=1);
}

// ---- 3. apply: refusals before any write --------------------------------------------------------------------------------------------------------------
{
 const file=world(),before=dump(file),env=envOf(file);
 const pins=(await dryRun(env,PAIRS)).expect;
 const good={expected:pins,confirmGo:true,requestId:'hist-request-1'};
 const refusedWith=async(over,expectReason)=>{const out=await applyHistorical(env,PAIRS,{...good,...over});assert.deepEqual([out.outcome,out.writes,out.reason],['refused',0,expectReason]);assert.equal(dump(file),before,expectReason+': nothing written');return out;};
 await refusedWith({confirmGo:false},'confirm_required');
 await refusedWith({confirmGo:undefined},'confirm_required');
 await refusedWith({requestId:'short'},'invalid_request_id');
 await refusedWith({requestId:undefined},'invalid_request_id');
 await refusedWith({expected:{...pins,filmPersonGeneration:-1}},'invalid_expected_generation');
 await refusedWith({expected:{...pins,count:0}},'invalid_expected_count');
 await refusedWith({expected:{...pins,count:HISTORICAL_MAX+1}},'invalid_expected_count');
 await refusedWith({expected:{...pins,digest:'xyz'}},'invalid_expected_digest');
 for(const [name,value] of [['filmPersonGeneration',pins.filmPersonGeneration+1],['ratingsGeneration',pins.ratingsGeneration+1],['count',3],['digest','f'.repeat(64)]]){
  const out=await refusedWith({expected:{...pins,[name]:value}},'pins_mismatch');
  assert.deepEqual(out.mismatched,[name],'exactly the differing pin is named');
 }
 // A subset is a different frozen cohort: its own count and digest are required.
 const subset=await applyHistorical(env,PAIRS.slice(0,2),{...good});
 assert.deepEqual([subset.outcome,subset.reason],['refused','pins_mismatch']);assert.equal(dump(file),before);
}

// ---- 4. apply: a complete run, its readback, idempotence ----------------------------------------------------------------------------------------------
{
 const file=world(),env=envOf(file);
 for(const lid of LIDS)assert.equal((await catalogStartedFilm(env,lid)).state==='found',false,'before: the reader answers not found');
 const pins=(await dryRun(env,PAIRS)).expect;
 const before={ratings:rows(file,'SELECT COUNT(*) AS n FROM ratings_view')[0].n,aliases:rows(file,'SELECT COUNT(*) AS n FROM film_alias')[0].n};
 const out=await applyHistorical(env,PAIRS,{expected:pins,confirmGo:true,requestId:'hist-request-2'});
 assert.deepEqual([out.outcome,out.writes],['complete',4],JSON.stringify(out));
 assert.deepEqual(out.counts,{written:4,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0});
 assert.deepEqual([out.readback.found,out.readback.remaining,out.readback.markersHold,out.readback.unexpectedChange],[4,0,true,false]);
 assert.deepEqual(out.readback.delta,{film_external_id:4,film_alias:0,ratings_view:0,started_mark:out.readback.delta.started_mark});
 assert.ok(out.readback.delta.started_mark===0||out.readback.delta.started_mark===null);
 assert.ok(NO_NAMES(JSON.stringify(out)),'the apply output names no lid, movie or Film id');
 const claims=trusted(file);
 assert.equal(claims.length,4);
 for(const [i,claim] of claims.entries()){
  assert.deepEqual([claim.film_id,claim.value,claim.trusted,claim.conflicting],[FID(i+1),LIDS[i],1,0]);
  assert.deepEqual(JSON.parse(claim.provenance_json),{source:'ratings_alias_bridge',tmdb:String(i+1),adr:'0184'});
 }
 for(const lid of LIDS)assert.equal((await catalogStartedFilm(env,lid)).state,'found','after: the reader that answered 404 finds the pair');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM ratings_view')[0].n,before.ratings);assert.equal(rows(file,'SELECT COUNT(*) AS n FROM film_alias')[0].n,before.aliases);
 const receipts=rows(file,"SELECT origin,state FROM canonical_write_receipt WHERE origin='letterboxd_claim'");
 assert.deepEqual([receipts.length,[...new Set(receipts.map(item=>item.state))]],[4,['applied']],'one applied receipt per pair, origin letterboxd_claim');
 // A repeat finds nothing missing: no longer eligible, zero writes, the claims unchanged.
 const again=dump(file);
 const repeat=await applyHistorical(env,PAIRS,{expected:pins,confirmGo:true,requestId:'hist-request-2'});
 assert.deepEqual([repeat.outcome,repeat.writes,repeat.reason],['refused',0,'not_eligible']);
 assert.equal(dump(file),again,'a repeat writes nothing');
 assert.equal((await dryRun(env,PAIRS)).decision,'already_current');
}

// ---- 5. a witness inserted AFTER the proof is refused inside the writer's batch; the run stops at the first pair that is not proved -------------------------
{
 for(const [name,hitBatch,expectWritten] of [['the first pair',1,0],['the second pair',2,1]]){
  const file=world();let claimBatches=0;
  const hostile=envOf(file,{onBatch:async statements=>{
   if(!statements.some(item=>/INSERT INTO film_external_id/i.test(item.text)))return;
   claimBatches++;
   if(claimBatches===hitBatch)sqlite(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(hitBatch))+",'"+hitBatch+"','NEWLID',"+q('c'.repeat(64))+",'T',2000,'rk','tmdb_"+hitBatch+"','2026-11-01T00:00:00.000Z','rqx',"+q(U)+")");
  }});
  const pins=(await dryRun(hostile,PAIRS)).expect;
  const out=await applyHistorical(hostile,PAIRS,{expected:pins,confirmGo:true,requestId:'hist-request-3'});
  assert.equal(out.outcome,'partial',name);
  assert.equal(out.writes,expectWritten,name+': only the pairs before the refused one were written');
  assert.equal(out.counts.written,expectWritten);
  assert.ok(out.counts.refused+out.counts.deferred+out.counts.unknown+out.counts.failed>=1,name+': the pair under the witness is not proved');
  assert.equal(out.counts.notAttempted,LIDS.length-expectWritten-1,name+': the rest is not attempted');
  assert.equal(trusted(file).length,expectWritten,name+': no claim of the refused pair or of the rest');
  assert.equal(out.readback.unexpectedChange,false);
 }
}

// ---- 6. the CLI: exit codes, never a pair, input errors before any connection -------------------------------------------------------------------------
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
 assert.equal(await run('--allowlist',allow,'--apply','--confirm-go','--request-id','hist-cli-001','--expected-film-person-generation',String(pins.filmPersonGeneration),'--expected-ratings-generation',String(pins.ratingsGeneration),'--expected-count','4','--expected-digest',pins.digest),EXIT.ok);
 const applied=JSON.parse(printed.at(-1));assert.deepEqual([applied.outcome,applied.writes,applied.writeState],['complete',4,'none']);assert.ok(NO_NAMES(printed.at(-1)));
 assert.equal(trusted(file).length,4);
}

console.log('letterboxd claim historical production operator: ok');
