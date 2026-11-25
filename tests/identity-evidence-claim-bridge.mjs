// AIR-618 / ADR 0215 (Accepted), card E2b: the rooted canonical `claim_alias_bridge` evidence row of the ADR 0184 claim unit (dormant), on the sqlite3-CLI D1 stand-in. SYNTHETIC ids only. No Worker, R2, network or production access.
// Covered (real caller path: `applyLetterboxdClaim` / `ensureLetterboxdClaims` -> `applyFilmExternalIds` -> `mutateFilm`):
// a rooted first commit writes ONE row (film_has_id, asserts, ratings_alias_bridge, alias_bridge, root = the handed-over page-check digest, batch time, the receipt's request id) in the claim's own batch; the same
// request id and content digest as a rootless write (receipt parity); no row without a root, for `already`, `not_proved`, `conflict`, a malformed root, a matching same_work row, a replay or the owner backfill;
// absent / off / pending / on (insert only while pending or on, decided at COMMIT time, so a flip between preparing and committing is honest); a schema without the control tables (one commit-time guard, never nothing);
// atomicity (a failed guard or a colliding row rolls the claim back; nothing is half written); a valid duplicate (same event or a different event with the same root) adds nothing; a different root is a different key;
// retries (first committed attempt decides, a lost hand-over stays rootless); statement counts; rollback of the writer to `off` keeps history; and the dormant wiring (nothing flips a writer, no reader).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {mutateFilm} from '../src/canonical-mutations.js';
import {filmExternalIdsDigest} from '../src/canonical-film-external-ids-producer.js';
import {applyLetterboxdClaim,ensureLetterboxdClaims,replanLetterboxdClaim,planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {evidenceKeyOf} from '../src/identity-evidence.js';
import {bridgeEvidenceStatements,changeWriter,claimBridgeEvidence,planBridgeEvidence,readWriter} from '../src/identity-evidence-writer.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-claim-bridge-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const WRITER_FILE='0042_identity_evidence_writer_control.sql';
assert.ok(chain.includes(WRITER_FILE));
// The full chain (schema 42 or later: the control tables exist) and the chain up to 0041 (the ledger without the control tables: the writer reads as `off`, ABSENT guard).
const full=path.join(root,'full.sqlite'),before=path.join(root,'before.sqlite');
assert.equal(sqlite(full,chain.map(read).join('\n')).status,0);
assert.equal(sqlite(before,chain.slice(0,chain.indexOf(WRITER_FILE)).map(read).join('\n')).status,0);

const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const T='2026-11-20T10:00:00.000Z',U='2026-11-01T00:00:00.000Z';
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const FID=k=>'film:tmdb:'+k;
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const ROOT_A=sha('page-check-a'),ROOT_B=sha('page-check-b');
let n=0;
function database(template=full){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 assert.equal(sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE+"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const putDoc=(file,key,value)=>{const text=JSON.stringify(value);assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key="+q(key)+";INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ("+q(key)+",0,"+q(text)+",'"+sha(text)+"','"+U+"');").status,0);};
const getDoc=(file,key)=>{const r=rows(file,"SELECT body FROM ratings_document WHERE key="+q(key));return r.length?JSON.parse(r[0].body):null;};
const seedFilm=(file,k)=>assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',2,'tmdb:"+k+"','Kept Title','"+U+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(k)+"','tmdb','"+k+"',1,0,NULL);").status,0);
const seedRatings=(file,lid,k)=>{
 const key='tmdb-'+k;
 assert.equal(sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ("+q(lid)+","+q(key)+",NULL,NULL,1,0,'"+U+"');INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('tmdb_"+k+"',"+q(key)+",NULL,NULL,1,0,'"+U+"');").status,0);
 const index=getDoc(file,'letterboxd/facts/links.json')||{};
 index['letterboxd:'+lid]=key;index['tmdb:'+k]=key;
 putDoc(file,'letterboxd/facts/links.json',index);
 putDoc(file,'letterboxd/facts/films/'+key+'.json',{schemaVersion:1,factKey:key,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
};
const proved=(template=full,lid='AAA1',k=1)=>{const file=database(template);seedFilm(file,k);seedRatings(file,lid,k);return file;};
const ledger=file=>rows(file,'SELECT * FROM film_identity_evidence ORDER BY seq');
const claims=(file,k=1)=>rows(file,"SELECT value FROM film_external_id WHERE film_id='"+FID(k)+"' AND scheme='letterboxd' ORDER BY value").map(row=>row.value);
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state FROM canonical_write_receipt ORDER BY created_at,request_id');
const revision=(file,k=1)=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+FID(k)+"'")??0);
const REQ={event:'link:AAA1:1',now:()=>T};
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};
const ISO0=Date.parse('2026-11-25T09:00:00.000Z');
// The activation operator, as the owner-approved production operation would run it (here on the stand-in, never on production).
let tick=0;
const op=async(env,writer,kind,extra={})=>{
 const current=await readWriter(env,writer);
 return changeWriter(env,{writer,kind,expectedGeneration:current.generation,reason:'test '+kind,deployedVersion:'test-version',evidenceLink:'https://example.invalid/evidence',now:new Date(ISO0+(tick++)*1000).toISOString(),...extra});
};
// A batch the database refuses (a failed guard or assertion) surfaces as a typed error or a non-`written` state, never as a write.
const attempt=async run=>{try{return await run();}catch(error){return {state:'thrown',code:error?.code};}};
const WRITER='claim_alias_bridge';
const setState=async(env,state)=>{
 if(state==='off')return;
 await op(env,WRITER,'activate');
 if(state==='on')await op(env,WRITER,'drain_complete',{drainEvidence:'synthetic drain evidence'});
};
const expectedRow=(film,lid,rootDigest)=>({subject_kind:'film',subject_value:film,relation:'film_has_id',object_kind:'letterboxd_lid',object_value:lid,polarity:'asserts',route:'ratings_alias_bridge',method:'alias_bridge',source_root:rootDigest,origin:'live',film_id:film,source_scope:null,source_order:null,scope_evidence_key:null,supersedes_key:null,reconstruction_run:null,reconstructed_from:null});
const keyOfRow=async(film,lid,rootDigest)=>evidenceKeyOf({subject:{kind:'film',value:film},relation:'film_has_id',object:{kind:'letterboxd_lid',value:lid},polarity:'asserts',route:'ratings_alias_bridge',method:'alias_bridge',sourceRoot:rootDigest,observedAt:T});

// ===== 1. a rooted first commit writes ONE row in the claim's own batch, with the receipt's request id; receipt parity with a rootless write =====
for(const state of ['pending','on']){
 const file=proved(),env=envOf(file);
 await setState(env,state);
 const out=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
 assert.equal(out.state,'written',state);
 assert.deepEqual(claims(file),['AAA1']);
 const list=ledger(file);
 assert.equal(list.length,1,state+': exactly one bridge row');
 assert.deepEqual(Object.fromEntries(Object.keys(expectedRow('x','y','z')).map(column=>[column,list[0][column]])),expectedRow(FID(1),'AAA1',ROOT_A),state+': the proposition, route, method and the handed-over root');
 assert.equal(list[0].evidence_key,await keyOfRow(FID(1),'AAA1',ROOT_A),'the standard rooted key of ADR 0213 decision 4');
 assert.equal(list[0].observed_at,T,'observation time is the batch time');
 assert.equal(list[0].recorded_at,T);
 assert.equal(list[0].request_id,out.requestId,'the row names the claim receipt of its own batch');
 const [receipt]=receipts(file);
 assert.equal(receipt.state,'applied');assert.equal(receipt.request_id,out.requestId);
 assert.equal(revision(file),1,'one revision move: the evidence row is part of the claim batch, not a second write');
 // Receipt parity: a rootless write of the same event gives the same request id and content digest.
 const bare=proved(),bareEnv=envOf(bare);
 await setState(bareEnv,state);
 const rootless=await applyLetterboxdClaim(bareEnv,{...REQ,lid:'AAA1',tmdb:'1'});
 assert.equal(rootless.state,'written');
 assert.equal(rootless.requestId,out.requestId,'the request id is unchanged by the hand-over');
 assert.equal(ledger(bare).length,0,'a rootless write writes no row, whatever the writer state');
 const input={id:FID(1),at:T,schemes:['letterboxd'],addOnly:true,externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true,conflicting:false,provenance:{source:'ratings_alias_bridge',tmdb:'1',adr:'0184'}}]};
 assert.equal(await filmExternalIdsDigest(input),await filmExternalIdsDigest({...input,evidence:async()=>[]}),'the content digest ignores the evidence hook');
 assert.deepEqual(rows(bare,'SELECT content_digest FROM canonical_write_receipt'),rows(file,'SELECT content_digest FROM canonical_write_receipt'),'the stored content digest is identical');
}

// ===== 2. no root, no row: rootless, malformed roots, `already`, refusals, a matching same_work row, a replay =====
{
 // absent control row (every writer is off) and off after being on: nothing is written, the claim is unchanged.
 for(const mode of ['absent','off-after-on']){
  const file=proved(),env=envOf(file);
  if(mode==='off-after-on'){await setState(env,'on');await op(env,WRITER,'deactivate');}
  assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A})).state,'written',mode);
  assert.equal(ledger(file).length,0,mode+': off or absent writes no row');
  assert.deepEqual(claims(file),['AAA1']);
 }
 // A malformed hand-over is a missing hand-over (never coerced, never guessed).
 for(const bad of ['',null,undefined,'ABC',ROOT_A.toUpperCase(),ROOT_A+'0',ROOT_A.slice(1),7,{},['x']]){
  const file=proved(),env=envOf(file);
  await setState(env,'on');
  assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:bad})).state,'written');
  assert.equal(ledger(file).length,0,'a root of '+JSON.stringify(bad)+' gives no row');
 }
 // A matching `same_work` row of the page check is NEVER looked up to fill the root.
 {
  const file=proved(),env=envOf(file);
  await setState(env,'on');
  assert.equal(sqlite(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at) VALUES ('"+sha('same-work')+"','"+FID(1)+"','letterboxd_lid','AAA1','same_work','tmdb_movie','1','asserts','ratings_diary','page_check','"+ROOT_A+"','"+T+"','live','seed','"+T+"')").status,0);
  assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1'})).state,'written');
  assert.deepEqual(ledger(file).map(row=>row.relation),['same_work'],'the page check of the same pair gives no root to a rootless claim; no bridge row');
 }
 // Refusals write nothing: `not_proved`, `conflict` (rooted).
 {
  const file=database(),env=envOf(file);
  seedFilm(file,1);// no Ratings link: not_proved
  await setState(env,'on');
  const refused=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
  assert.equal(refused.state,'refused');assert.equal(refused.verdict,'not_proved');
  assert.equal(ledger(file).length,0);assert.deepEqual(claims(file),[]);assert.equal(receipts(file).length,0);
  const other=proved();seedFilm(other,2);
  assert.equal(sqlite(other,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','letterboxd','AAA1',1,0,NULL)").status,0);
  const otherEnv=envOf(other);await setState(otherEnv,'on');
  const conflict=await applyLetterboxdClaim(otherEnv,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
  assert.equal(conflict.state,'refused');assert.equal(conflict.verdict,'conflict');
  assert.equal(ledger(other).length,0);
 }
 // `already` (the claim exists): no batch, no row, even with a root, and a root offered later does not attach to an applied claim.
 {
  const file=proved(),env=envOf(file);
  await setState(env,'on');
  assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1'})).state,'written');// first committed attempt: rootless
  const again=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
  assert.equal(again.state,'already');
  const later=await applyLetterboxdClaim(env,{event:'link:other:event',lid:'AAA1',tmdb:'1',now:()=>T,root:ROOT_A});
  assert.equal(later.state,'already','a different event with a root finds the applied claim');
  assert.equal(ledger(file).length,0,'a lost hand-over on the first committed attempt stays rootless: no root is attributed later');
  assert.equal(receipts(file).length,1,'no second batch, no second receipt');
 }
}

// ===== 3. retries: the first committed attempt decides; a rooted retry after a rooted commit writes nothing new =====
{
 const file=proved(),env=envOf(file);
 await setState(env,'on');
 const first=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
 assert.equal(first.state,'written');
 const rowsBefore=JSON.stringify(ledger(file)),receiptsBefore=JSON.stringify(receipts(file)),revisionBefore=revision(file);
 for(const options of [{root:ROOT_A},{},{root:ROOT_B}]){
  const retry=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',...options});
  assert.equal(retry.state,'already');
 }
 assert.equal(JSON.stringify(ledger(file)),rowsBefore,'a retry (same receipt) short-circuits: no new row');
 assert.equal(JSON.stringify(receipts(file)),receiptsBefore);
 assert.equal(revision(file),revisionBefore);
}

// ===== 4. a re-add through a different event: the same root gives the same key (nothing new); another root is another row =====
{
 const file=proved(),env=envOf(file);
 await setState(env,'on');
 const first=await applyLetterboxdClaim(env,{event:'link:AAA1:1',now:()=>T,lid:'AAA1',tmdb:'1',root:ROOT_A});
 assert.equal(first.state,'written');
 // The claim is removed (an unlink by the owner's tooling), then offered again by another event.
 assert.equal(sqlite(file,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"' AND scheme='letterboxd'").status,0);
 const second=await applyLetterboxdClaim(env,{event:'link:AAA1:1:again',now:()=>'2026-11-21T10:00:00.000Z',lid:'AAA1',tmdb:'1',root:ROOT_A});
 assert.equal(second.state,'written');
 assert.notEqual(second.requestId,first.requestId,'a different event is a different receipt');
 assert.equal(ledger(file).length,1,'the same root dedupes: one row');
 assert.equal(ledger(file)[0].request_id,first.requestId,'the first row is kept untouched (append-only)');
 assert.equal(receipts(file).filter(row=>row.state==='applied').length,2);
 assert.equal(sqlite(file,"DELETE FROM film_external_id WHERE film_id='"+FID(1)+"' AND scheme='letterboxd'").status,0);
 const third=await applyLetterboxdClaim(env,{event:'link:AAA1:1:third',now:()=>'2026-11-22T10:00:00.000Z',lid:'AAA1',tmdb:'1',root:ROOT_B});
 assert.equal(third.state,'written');
 const list=ledger(file);
 assert.equal(list.length,2,'another page check is another root and another key');
 assert.deepEqual(list.map(row=>row.source_root),[ROOT_A,ROOT_B]);
 assert.notEqual(list[0].evidence_key,list[1].evidence_key);
}

// ===== 5. atomicity: a failed guard or a colliding row rolls the whole claim back =====
{
 // A guard that does not hold (the fence of a hold, a lease or a pinned generation fails the same way): nothing is written, not the claim, not the row, not the revision.
 const file=proved(),env=envOf(file);
 await setState(env,'on');
 const snapshot=JSON.stringify([rows(file,'SELECT * FROM film_external_id ORDER BY 1,2,3'),revision(file),ledger(file)]);
 const out=await attempt(()=>applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A,extraGuards:[{sql:'1=0',params:[]}]}));
 assert.notEqual(out.state,'written');
 assert.equal(JSON.stringify([rows(file,'SELECT * FROM film_external_id ORDER BY 1,2,3'),revision(file),ledger(file)]),snapshot,'a failed guard rolls back the claim and the row together');
 assert.deepEqual(claims(file),[]);
}
{
 // A row under the evidence key with ANOTHER semantic identity (a tampered or wrongly imported row): the insert is a no-op, the assertion fails, the claim is rolled back.
 const file=proved(),env=envOf(file);
 await setState(env,'on');
 const key=await keyOfRow(FID(1),'AAA1',ROOT_A);
 assert.equal(sqlite(file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,observed_at,origin,request_id,recorded_at) VALUES ('"+key+"','"+FID(9)+"','film','"+FID(9)+"','film_has_id','letterboxd_lid','ZZZ9','asserts','ratings_alias_bridge','alias_bridge','"+ROOT_A+"','"+T+"','live','tampered','"+T+"')").status,0);
 const snapshot=JSON.stringify([rows(file,'SELECT * FROM film_external_id ORDER BY 1,2,3'),revision(file),ledger(file)]);
 const out=await attempt(()=>applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A}));
 assert.notEqual(out.state,'written','a collision does not commit the claim');
 assert.deepEqual(claims(file),[]);
 assert.equal(JSON.stringify([rows(file,'SELECT * FROM film_external_id ORDER BY 1,2,3'),revision(file),ledger(file)]),snapshot,'the collision rolled the whole claim back and added no row');
 // With the writer off the same colliding row is not asserted (off or absent writes and asserts nothing).
 await op(env,WRITER,'deactivate');
 assert.equal((await applyLetterboxdClaim(env,{event:'link:AAA1:1:off',now:()=>T,lid:'AAA1',tmdb:'1',root:ROOT_A})).state,'written');
}

// ===== 6. the writer flip is decided at COMMIT time: statements prepared in one state commit under the state of the commit =====
{
 const plan=await planBridgeEvidence({filmId:FID(1),lid:'AAA1',root:ROOT_A,observedAt:T});
 for(const [prepared,commit,expectRow] of [['off','pending',true],['pending','off',false],['on','off',false],['off','off',false]]){
  const file=proved(),env=envOf(file);
  await setState(env,prepared);
  const statements=await bridgeEvidenceStatements(env,plan,{requestId:'req-'+prepared+commit,at:T});
  assert.equal(statements.length,2,'an insert and an assertion');
  if(commit!==prepared){
   if(commit==='off')await op(env,WRITER,'deactivate');else await op(env,WRITER,'activate');
  }
  await mutateFilm(env,{id:FID(1),expectedRevision:0,at:T,requireExisting:true,film:{contractVersion:2,externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true,conflicting:false,provenance:null}]},evidence:statements});
  assert.equal(ledger(file).length,expectRow?1:0,prepared+' -> '+commit+': the row exists exactly when the writer is pending or on at commit');
  assert.deepEqual(claims(file),['AAA1']);
 }
 // A matching duplicate passes the assertion (writer on); a mismatching one fails it (checked in 5).
 const file=proved(),env=envOf(file);
 await setState(env,'on');
 const statements=await bridgeEvidenceStatements(env,plan,{requestId:'req-dup',at:T});
 await mutateFilm(env,{id:FID(1),expectedRevision:0,at:T,requireExisting:true,film:{contractVersion:2,externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true,conflicting:false,provenance:null}]},evidence:statements});
 await mutateFilm(env,{id:FID(1),expectedRevision:1,at:T,requireExisting:true,film:{contractVersion:2,externalIds:[]},evidence:statements});
 assert.equal(ledger(file).length,1,'a valid duplicate adds nothing and does not fail the batch');
}

// ===== 7. a schema without the control tables (before 0042): ONE commit-time guard, never nothing; the claim is unchanged =====
{
 const file=proved(before),env=envOf(file);
 const hook=claimBridgeEvidence(env,{filmId:FID(1),lid:'AAA1',root:ROOT_A});
 const statements=await hook({requestId:'req-before',at:T});
 assert.equal(statements.length,1,'one guard statement, not an empty list');
 const out=await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A});
 assert.equal(out.state,'written','the claim is written exactly as before on a schema without the ledger extensions');
 assert.equal(one(file,"SELECT COUNT(*) FROM sqlite_master WHERE name='identity_evidence_writer'"),0);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0);
 // A batch prepared before 0042 cannot commit after it was applied (that would be a silent gap inside a coverage interval); it fails and the caller replans.
 const raced=proved(before),racedEnv=envOf(raced);
 const prepared=await claimBridgeEvidence(racedEnv,{filmId:FID(1),lid:'AAA1',root:ROOT_A})({requestId:'req-raced',at:T});
 assert.equal(sqlite(raced,read(WRITER_FILE)).status,0);
 await assert.rejects(()=>mutateFilm(racedEnv,{id:FID(1),expectedRevision:0,at:T,requireExisting:true,film:{contractVersion:2,externalIds:[{scheme:'letterboxd',value:'AAA1',trusted:true,conflicting:false,provenance:null}]},evidence:prepared}),code('film_person_precondition'));
 assert.deepEqual(claims(raced),[],'the claim did not commit without its evidence row after the apply');
 // A replan after the apply reads the schema again and now gets the insert and the assertion.
 const fresh=await claimBridgeEvidence(racedEnv,{filmId:FID(1),lid:'AAA1',root:ROOT_A})({requestId:'req-raced-2',at:T});
 assert.equal(fresh.length,2);
}

// ===== 8. statement budget =====
{
 const batches=[];
 const file=proved(),env=envOf(file,{onBatch:statements=>{batches.push(statements.length);}});
 await setState(env,'on');
 batches.length=0;
 assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A})).state,'written');
 const rooted=Math.max(...batches);
 const bare=proved(),bareBatches=[],bareEnv=envOf(bare,{onBatch:statements=>{bareBatches.push(statements.length);}});
 await setState(bareEnv,'on');
 bareBatches.length=0;
 assert.equal((await applyLetterboxdClaim(bareEnv,{...REQ,lid:'AAA1',tmdb:'1'})).state,'written');
 assert.equal(rooted,Math.max(...bareBatches)+2,'the bridge row costs exactly two statements (an insert and an assertion) in the claim batch');
 assert.ok(rooted<=60+2,'well inside the mutation statement cap');
 // The producer accepts at most 4 evidence statements and refuses a malformed list before the database is touched.
 const guard=envOf(proved());
 for(const bad of [[['x']],[[1,[]]],[['SELECT 1',[undefined]]],'x',[...Array(5)].map(()=>['SELECT 1',[]])]){
  await assert.rejects(()=>mutateFilm(guard,{id:FID(1),expectedRevision:0,at:T,requireExisting:true,film:{contractVersion:2},evidence:bad}),code('film_person_invalid'));
 }
}

// ===== 9. the hand-over helpers: only a 64-hex root plans a row; the hook is absent for a rootless write =====
{
 assert.equal(claimBridgeEvidence({}, {filmId:FID(1),lid:'AAA1'}),undefined,'no root, no hook');
 assert.equal(claimBridgeEvidence({}, {filmId:FID(1),lid:'AAA1',root:null}),undefined);
 for(const bad of ['',ROOT_A.slice(2),ROOT_A.toUpperCase(),'z'.repeat(64),5,{}])await assert.rejects(()=>planBridgeEvidence({filmId:FID(1),lid:'AAA1',root:bad,observedAt:T}),code('identity_evidence_out_of_slice'));
 const plan=await planBridgeEvidence({filmId:FID(1),lid:'AAA1',root:ROOT_A,observedAt:T});
 assert.equal(plan.writer,'claim_alias_bridge');
 assert.equal(plan.evidenceKey,await keyOfRow(FID(1),'AAA1',ROOT_A));
 assert.equal(plan.evidenceKey,await planBridgeEvidence({filmId:FID(1),lid:'AAA1',root:ROOT_A,observedAt:'2030-01-01T00:00:00.000Z'}).then(other=>other.evidenceKey),'the observation time is not part of the key');
 assert.notEqual(plan.evidenceKey,(await planBridgeEvidence({filmId:FID(1),lid:'AAA1',root:ROOT_B,observedAt:T})).evidenceKey,'the root is part of the key');
 assert.notEqual(plan.evidenceKey,(await planBridgeEvidence({filmId:FID(1),lid:'AAA2',root:ROOT_A,observedAt:T})).evidenceKey);
 const env=envOf(proved());
 await assert.rejects(()=>bridgeEvidenceStatements(env,{...plan,writer:'discovery_decision'},{requestId:'r',at:T}),code('identity_evidence_out_of_slice'));
 await assert.rejects(()=>bridgeEvidenceStatements(env,plan,{requestId:'bad id',at:T}),error=>error.code==='identity_evidence_writer_invalid'&&error.reason==='request_id');
 await assert.rejects(()=>bridgeEvidenceStatements(env,plan,{requestId:'r',at:'yesterday'}),error=>error.code==='identity_evidence_writer_invalid'&&error.reason==='at');
 // The re-plan of a receipt retry keeps the hand-over of the call that made it; the re-plan of a bare receipt has none.
 const file=proved(),renv=envOf(file);
 const withRoot=await replanLetterboxdClaim(renv,{lid:'AAA1',tmdb:'1',filmId:FID(1),now:()=>T,root:ROOT_A});
 assert.equal(typeof withRoot.evidence,'function');
 const bare=await replanLetterboxdClaim(renv,{lid:'AAA1',tmdb:'1',filmId:FID(1),now:()=>T});
 assert.equal(Object.hasOwn(bare,'evidence'),false,'a receipt reconciler that has no hand-over writes a rootless claim');
 assert.equal(await filmExternalIdsDigest(withRoot),await filmExternalIdsDigest(bare));
 assert.equal((await planLetterboxdClaim(renv,{lid:'AAA1',tmdb:'1'})).verdict,'pass');
}

// ===== 10. the producer path: ensureLetterboxdClaims hands each pair's own root; the owner backfill hands none =====
{
 const file=proved(),env=envOf(file);
 seedFilm(file,2);seedRatings(file,'BBB2',2);seedFilm(file,3);seedRatings(file,'CCC3',3);
 await setState(env,'on');
 const out=await ensureLetterboxdClaims(env,{enabled:true,now:()=>T,pairs:[
  {lid:'AAA1',tmdb:'1',root:ROOT_A},
  {lid:'BBB2',tmdb:'2'},
  {lid:'CCC3',tmdb:'3',root:'not-a-digest'},
  {lid:'AAA1',tmdb:'1',root:ROOT_B},// a duplicate offer of the same pair: one pair, the first root stays
 ]});
 assert.equal(out.written,3);assert.equal(out.state,'complete');
 const list=ledger(file);
 assert.deepEqual(list.map(row=>[row.subject_value,row.object_value,row.source_root]),[[FID(1),'AAA1',ROOT_A]],'only the pair with an explicit root has a row');
 // A root on a rootless duplicate is kept: an explicit hand-over is never dropped for a retry without one.
 const second=proved(full,'DDD4',4),secondEnv=envOf(second);
 await setState(secondEnv,'on');
 await ensureLetterboxdClaims(secondEnv,{enabled:true,now:()=>T,pairs:[{lid:'DDD4',tmdb:'4'},{lid:'DDD4',tmdb:'4',root:ROOT_B}]});
 assert.deepEqual(ledger(second).map(row=>row.source_root),[ROOT_B]);
}

// ===== 11. rollback of the activation (writer off) keeps history; a code path that never hands a root never writes =====
{
 const file=proved(),env=envOf(file);
 seedFilm(file,2);seedRatings(file,'BBB2',2);
 await setState(env,'on');
 assert.equal((await applyLetterboxdClaim(env,{...REQ,lid:'AAA1',tmdb:'1',root:ROOT_A})).state,'written');
 await op(env,WRITER,'break',{breakFrom:new Date(ISO0).toISOString()});
 assert.equal((await readWriter(env,WRITER)).state,'off');
 assert.equal((await applyLetterboxdClaim(env,{event:'link:BBB2:2',now:()=>T,lid:'BBB2',tmdb:'2',root:ROOT_B})).state,'written');
 assert.equal(ledger(file).length,1,'the earlier row stays (history), no new row while the writer is off');
}

// ===== 12. dormant wiring: no Worker code flips the writer, nothing reads the bridge rows, the backfill and the offline callers hand no root =====
{
 const sources=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js')).map(name=>path.join('src',String(name)));
 const writers=sources.filter(name=>/INSERT INTO identity_evidence_writer_change/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(writers,['src/identity-evidence-writer.js'],'only the operator helper writes the transitions, and nothing in the Worker calls it');
 const readers=sources.filter(name=>/FROM film_identity_evidence/.test(fs.readFileSync(name,'utf8')));
 assert.deepEqual(readers,['src/identity-evidence-import.js','src/identity-evidence-writer.js','src/identity-evidence.js'],'no reader of the ledger outside the three ledger modules (their own key lookups, the assertion and the dormant import path), ADR 0213 decision 8: the claim unit, the Diary and the facts modules never read it');
 const backfill=fs.readFileSync('src/letterboxd-claim-backfill.js','utf8');
 assert.ok(!/\broot\b/.test(backfill.replace(/\/\/.*$/gm,'')),'the owner backfill hands over no root: its writes are ineligible for bridge evidence');
 const facts=fs.readFileSync('src/letterboxd-facts.js','utf8');
 assert.ok(/ensureLetterboxdClaims\(env,\{pairs\}\)/.test(facts),'the import path offers its pairs without a root (an archive digest is not a page check)');
 const claim=fs.readFileSync('src/canonical-letterboxd-claim.js','utf8');
 assert.ok(/export const LETTERBOXD_CLAIM_ACTIVATED=true;/.test(claim),'the claim producer gate is unchanged');
}
console.log('identity evidence claim bridge writer: ok');
