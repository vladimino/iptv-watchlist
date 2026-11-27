// AIR-674 / ADR 0217 (Accepted) delivery step 5, decision 5c, test 12: `mergeFilms` moves the immutable `film_lid_admission` row to the survivor. Real migrations on a sqlite D1 stand-in, real admissions
// (the lid-only coordinator), the real canonical writer. Synthetic proofs only; no Worker, network, R2 or production. DORMANT: no live caller of mergeFilms exists.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {admitVerifiedFilm,admitVerifiedLidOnly,planLidOnlyD1} from '../src/letterboxd-admission-d1.js';
import {lidOnlyProofDigest} from '../src/domain/letterboxd-lid-only-digest.js';

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
const LINKS_KEY='letterboxd/facts/links.json';
const NO_LINKS={fence:{key:LINKS_KEY,parts:0,etag:null},tmdbAlias:null};
const checker=async(lid='Ab1',extra={},over={})=>{const calls={n:0};const proof=await proofOf(lid,over);return {calls,reacquire:async()=>{calls.n++;return {ok:true,proof,links:NO_LINKS,...extra};}};};
const run=async(file,lid='Ab1',{route='watchlist_admission',now=clock(),extra={},over={},options,...rest}={})=>{const c=await checker(lid,extra,over);const out=await admitVerifiedLidOnly(envOf(file,options),{lid,route,reacquire:c.reacquire,now,...rest});return {out,calls:c.calls};};

const {mutateFilm,mergeFilms}=await import('../src/canonical-mutations.js');
const AT='2026-11-26T09:00:00.000Z';
const survivorOf=async(file,id='film:survivor')=>mutateFilm(envOf(file),{id,expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Survivor',externalIds:[]}});
const merge=(file,over={})=>mergeFilms(envOf(file,over.options),{from:'film:lb:Ab1',to:'film:survivor',expected:{from:1,to:1},at:AT,...over.input});
const lidRows=file=>rows(file,'SELECT * FROM film_lid_admission ORDER BY lid');
const world=file=>JSON.stringify([rows(file,'SELECT id FROM film ORDER BY id'),lidRows(file),rows(file,'SELECT * FROM film_redirect'),rows(file,'SELECT * FROM film_external_id ORDER BY film_id,scheme,value'),
 rows(file,'SELECT * FROM canonical_write_receipt ORDER BY request_id'),rows(file,'SELECT kind,id,revision FROM canonical_revision ORDER BY kind,id')]);

// ===== valid merge: the row moves to the survivor and nothing else about it changes; history and the receipt stay =====
{
 const file=fresh();
 await run(file);await survivorOf(file);
 const before=lidRows(file)[0],receiptsBefore=receipts(file);
 const out=await merge(file);
 assert.deepEqual([out.merged,out.from,out.to],[true,'film:lb:Ab1','film:survivor']);
 const after=lidRows(file);
 assert.equal(after.length,1,'no row lost or duplicated');
 assert.deepEqual({...after[0],film_id:null},{...before,film_id:null},'every column except film_id is untouched (proof, receipt key, digest, times)');
 assert.equal(after[0].film_id,'film:survivor');
 assert.deepEqual(rows(file,'SELECT from_id,to_film_id FROM film_redirect'),[{from_id:'film:lb:Ab1',to_film_id:'film:survivor'}]);
 assert.deepEqual(receipts(file),receiptsBefore,'the admitting receipt is not rewritten');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb:Ab1'")[0].n,0,'the retired Film is gone, the proof row is not');
 assert.throws(()=>sqlite(file,"DELETE FROM film_lid_admission WHERE lid='Ab1'"),/film_lid_admission_keep/,'the keep trigger still holds');
 assert.throws(()=>sqlite(file,"UPDATE film_lid_admission SET title='x' WHERE lid='Ab1'"),/film_lid_admission_immutable/,'the immutable trigger still holds');
 // replay of the same merge: a no-op, the row stays on the survivor
 const again=await merge(file);
 assert.deepEqual([again.merged,again.already],[false,true]);
 assert.deepEqual(lidRows(file),after,'replay leaves the row unchanged');
 // the same retired Film into another survivor: refused, the row stays
 await survivorOf(file,'film:other');
 await assert.rejects(()=>merge(file,{input:{to:'film:other',expected:{from:1,to:1}}}),code('film_person_redirect_conflict'));
 assert.equal(lidRows(file)[0].film_id,'film:survivor');
}

// ===== competing admission: the survivor holds a different lid-only admission; the whole merge refuses and nothing changes =====
{
 const file=fresh();
 await run(file,'Ab1');await run(file,'Cd2');
 const before=world(file);
 const input={from:'film:lb:Ab1',to:'film:lb:Cd2',expected:{from:1,to:1},at:AT};
 await assert.rejects(()=>mergeFilms(envOf(file),input),code('film_person_identity_conflict'),'two lids are two trusted letterboxd claims: refused first');
 await assert.rejects(()=>mergeFilms(envOf(file),{...input,evidence:{verified:true}}),code('film_person_data_conflict'),'even verified evidence never merges two admissions');
 assert.equal(world(file),before,'transactional: no row, redirect, revision or receipt changed');
}

// ===== the survivor already holds the admission, the retired Film holds none: the survivor keeps it =====
{
 const file=fresh();
 await run(file,'Ab1');await survivorOf(file,'film:plain');
 const before=lidRows(file);
 await mergeFilms(envOf(file),{from:'film:plain',to:'film:lb:Ab1',expected:{from:1,to:1},at:AT});
 assert.deepEqual(lidRows(file),before);
}

// ===== wrong or stale survivor: a stale revision, a redirected survivor and a missing survivor refuse and change nothing =====
{
 const file=fresh();
 await run(file);await survivorOf(file);
 const before=world(file);
 await assert.rejects(()=>merge(file,{input:{expected:{from:1,to:5}}}));
 await assert.rejects(()=>merge(file,{input:{expected:{from:0,to:1}}}));
 await assert.rejects(()=>merge(file,{input:{to:'film:missing',expected:{from:1,to:0}}}),code('film_person_reference'));
 assert.equal(world(file),before);
 sqlite(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:gone',1,'t');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:survivor','film:gone','t')");
 const redirected=world(file);
 await assert.rejects(()=>merge(file),code('film_person_redirect'));
 assert.equal(world(file),redirected,'a redirected survivor is never a target');
 assert.equal(lidRows(file)[0].film_id,'film:lb:Ab1');
}

// ===== a competing admission that appears between the read and the batch rolls the whole merge back (asserted inside the batch) =====
{
 const file=fresh();
 await run(file);await survivorOf(file);
 const before=world(file);
 let injected=false;
 const options={onBatch:async()=>{if(!injected){injected=true;
  const row=lidRows(file)[0];
  sqlite(file,"INSERT INTO film_lid_admission (lid,film_id,route,admitted_at,receipt_key,proof_version,final_url,slug,canonical_path,shortlink,type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status) "
   +"SELECT 'Zz9','film:survivor',route,admitted_at,'admission:lid:Zz9',proof_version,final_url,slug,canonical_path,'Zz9',type_marker,id_block_outcome,completeness_outcome,title,year,proof_digest,checked_at,redirect_status,page_status FROM film_lid_admission WHERE lid='"+row.lid+"'");}}};
 await assert.rejects(()=>merge(file,{options}));
 assert.ok(injected);
 assert.equal(rows(file,"SELECT film_id FROM film_lid_admission WHERE lid='Ab1'")[0].film_id,'film:lb:Ab1','the admission did not move');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film_redirect")[0].n,0,'no redirect');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb:Ab1'")[0].n,1,'the retired Film is intact');
 void before;
}

// ===== the proof must not outlive its LID claim (independent review P1): the survivor must end with exactly one trusted, non-conflicting claim of the lid, and no other Film may hold one =====
{
 const claim=(trusted,conflicting)=>[{scheme:'letterboxd',value:'Ab1',trusted,conflicting}];
 // a legal conflicting, untrusted claim of the same lid on the survivor: the moved trust cannot be restored, so the merge refuses and nothing changes
 const file=fresh();
 await run(file);
 await mutateFilm(envOf(file),{id:'film:survivor',expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Survivor',externalIds:claim(false,true)}});
 const before=world(file),planBefore=JSON.stringify(await planLidOnlyD1(envOf(file),{lid:'Ab1'}));
 const failure=await merge(file).then(()=>null,error=>error);
 assert.ok(failure,'the merge is refused');
 assert.equal(world(file),before,'atomic: claims, proof, redirect, receipt and revisions are unchanged');
 assert.equal(JSON.stringify(await planLidOnlyD1(envOf(file),{lid:'Ab1'})),planBefore,'the refused merge changes no ownership verdict');
 await assert.rejects(()=>merge(file,{input:{evidence:{verified:true}}}),undefined,'verified evidence does not bless an unresolved claim');
 assert.equal(world(file),before);
 // survivor-held admission: a third Film holding a foreign claim of the lid makes ownership incomplete; the merge of an unrelated Film into the owner refuses
 const g=fresh();
 await run(g);await survivorOf(g,'film:plain');
 await mutateFilm(envOf(g),{id:'film:third',expectedRevision:0,at:AT,film:{contractVersion:1,originalTitle:'Third',externalIds:claim(false,true)}});
 const beforeG=world(g);
 await assert.rejects(()=>mergeFilms(envOf(g),{from:'film:plain',to:'film:lb:Ab1',expected:{from:1,to:1},at:AT}),undefined,'a foreign claim of the lid blocks the merge');
 assert.equal(world(g),beforeG);
 // happy paths stay usable: the survivor owns the lid completely after a transfer and after a survivor-held merge
 const h=fresh();
 await run(h);await survivorOf(h);
 await merge(h);
 assert.deepEqual(rows(h,"SELECT film_id,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value='Ab1'"),[{film_id:'film:survivor',trusted:1,conflicting:0}]);
 const plan=await planLidOnlyD1(envOf(h),{lid:'Ab1'});
 assert.deepEqual([plan.outcome,plan.id],['present_lid_only','film:survivor'],JSON.stringify(plan));
 const k=fresh();
 await run(k);await survivorOf(k,'film:plain');
 await mergeFilms(envOf(k),{from:'film:plain',to:'film:lb:Ab1',expected:{from:1,to:1},at:AT});
 assert.equal((await planLidOnlyD1(envOf(k),{lid:'Ab1'})).outcome,'present_lid_only');
}

// ===== a schema below 48 (no table): a merge of ordinary Films is unaffected =====
{
 const file=fresh();
 await run(file);await survivorOf(file);await survivorOf(file,'film:plain');
 sqlite(file,'DROP TRIGGER film_lid_admission_immutable;DROP TRIGGER film_lid_admission_keep;DROP TABLE film_lid_admission');
 const out=await mergeFilms(envOf(file),{from:'film:plain',to:'film:survivor',expected:{from:1,to:1},at:AT});
 assert.equal(out.merged,true);
}
console.log('lid-only admission merge (AIR-674) passed.');
