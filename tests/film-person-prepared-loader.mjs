// AIR-374 P5 (owner decision 2): tests of scripts/film-person-prepared-loader.mjs. Synthetic and local only: a sqlite file plays the production D1 (migrations 0001-0018,
// marker `prepared` over a verified baseline, a held projector lease), the D1 stand-in applies the EMITTED statements as one atomic batch each, and a double with
// head/get only plays the read-only R2 client. No production read or write, no connector, no network. The mutation check (tests/film-person-prepared-loader-mutation.mjs)
// points this file at a mutant through LOADER_MODULE.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {ACCEPTED_DISCREPANCIES,COPY_TABLES} from '../src/film-person-cutover-accepted.js';
const L=await import(process.env.LOADER_MODULE?pathToFileURL(path.resolve(process.env.LOADER_MODULE)).href:'../scripts/film-person-prepared-loader.mjs');

// AIR-374: LOADER_SECTIONS=<n,...> runs sections 1-3 (cheap, and they build what the others use) plus only the listed ones of 4-11; without it every section runs. The mutation check
// (tests/film-person-prepared-loader-mutation.mjs) gives each mutant the section that kills it as a hint and runs the whole file before it calls a mutant a survivor.
const ONLY=new Set((process.env.LOADER_SECTIONS||'').split(',').filter(Boolean).map(Number));
const section=number=>ONLY.size===0||ONLY.has(number);
const started=Date.now();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prepared-loader-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const sha=text=>createHash('sha256').update(text).digest('hex');
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
const q=value=>value===null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const stops=(work,reason,label=reason)=>assert.throws(work,error=>error instanceof L.LoaderError&&error.reason===reason,label);
const AT='2026-11-12T09:00:00.000Z',LEASE='lease-p5-test-0001',WINDOW='window-p5-test-0001',REF='baseline-ref-'+'a'.repeat(40);

// ---------- the template: every migration, then a `prepared` marker over a verified baseline ----------
const template=path.join(root,'template.sqlite');
sql(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sql(template,`UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified',reference=${q(REF)} WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;`);
assert.deepEqual(rows(template,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'prepared',cutover:'open',generation:1}]);

// ---------- a world: Films, identity, and the three R2 objects ----------
const hex=n=>sha('archive-'+n);
function makeWorld({admissions=8,retention=6,retirements=2,noise=true}={}){
 const films=[],ids=[],lids=[],receipts={schemaVersion:1,films:{}},viewIndex={},retire=[];
 for(let i=0;i<admissions;i++){
  const id='film:tmdb:'+(1000+i);
  films.push(`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,${q('tmdb:'+(1000+i))},${q('Title '+i)},'2026-11-01T00:00:00.000Z');`);
  ids.push(`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'tmdb',${q(String(1000+i))},1,0,NULL);`);
  receipts.films['tmdb_'+(1000+i)]={tmdb:1000+i,sourceCode:'c'+i,archiveSha256:hex(i),verifiedAt:'2026-10-01T10:00:00.000Z',title:i%3?'Title '+i:undefined,year:i%2?1990+i:undefined};
 }
 for(let j=0;j<retention;j++){
  const id='film:lb'+j;
  films.push(`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,NULL,${q('LB '+j)},'2026-11-01T00:00:00.000Z');`);
  ids.push(`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(id)},'letterboxd',${q('lb'+j)},${j%2},0,NULL);`);
  viewIndex['lb'+j]={watchlist:j%3===0,prediction:{x:1}};
 }
 for(let k=0;k<retirements;k++){
  const lid='rt'+k,tv=String(9000+k),movie=String(8000+k);
  retire.push({lid,filmId:'film:'+lid,movieId:movie,tvId:tv,evidence:{movieStatus:404,movieCheckedAt:'2026-10-20T10:00:00.000Z',letterboxdUrl:'https://letterboxd.com/film/rt-'+k+'/',link:'tv/'+tv,linkCheckedAt:'2026-10-20T10:01:00.000Z',tvResponseId:tv,tvCheckedAt:'2026-10-20T10:02:00.000Z'},confirmation:{by:'owner',at:'2026-10-21T10:00:00.000Z',source:'trello'}});
 }
 if(noise){
  // not loaded, and counted: a receipt without verification, a verified receipt whose Film does not exist, a list lid without a Film, a non-boolean entry, a candidate key
  receipts.films.tmdb_5000={tmdb:5000,sourceCode:'pending'};
  receipts.films.tmdb_5001={tmdb:5001,sourceCode:'ghost',archiveSha256:hex('ghost'),verifiedAt:'2026-10-01T10:00:00.000Z'};
  viewIndex.ghostlid={watchlist:true};viewIndex.nobool={watchlist:'yes'};viewIndex.tmdb_77={watchlist:true};
 }
 const bytes={verifiedFilms:Buffer.from(JSON.stringify(receipts)),viewIndex:Buffer.from(JSON.stringify(viewIndex)),retirements:Buffer.from(JSON.stringify({schemaVersion:1,retirements:retire}))};
 return {script:films.join('\n')+'\n'+ids.join('\n'),bytes,expected:{ratedAdmission:admissions,retention:retention,retirement:retirements},receipts,viewIndex,retire};
}
const source=bytes=>Object.fromEntries(Object.entries(bytes).map(([id,value])=>[id,{bytes:value,sha256:sha(value)}]));
let counter=0;
function freshDb(world,{triggers=true}={}){
 const file=path.join(root,'db'+(counter++)+'.sqlite');
 fs.copyFileSync(template,file);
 sql(file,world.script);
 sql(file,`INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment',${q(LEASE)},'2099-01-01T00:00:00.000Z','2026-11-12T08:59:00.000Z') ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at;`);
 if(!triggers)for(const row of rows(file,"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'film_person_%'"))sql(file,'DROP TRIGGER '+row.name+';');
 return {file,db:d1Standin(file)};
}
// a digest per table, for "nothing else moved"
function tableDigests(file){
 const out={};
 for(const {name} of rows(file,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"))out[name]=sha(JSON.stringify(rows(file,'SELECT * FROM '+name+' ORDER BY rowid')));
 return out;
}
const THREE=Object.values(L.TABLES);
const planOf=async(world,file,extra={})=>{
 const db=d1Standin(file),state=await L.readLoadState(db);
 return L.buildLoadPlan({sources:source(world.bytes),state,at:AT,leaseId:LEASE,expected:world.expected,...extra});
};
const applyBound=async(file,batches)=>{const db=d1Standin(file);for(const batch of batches)await db.batch(batch.statements.map(item=>db.prepare(item.sql).bind(...item.params)));};
const emit=plan=>L.emitLoadSql({plan,apply:true,planDigest:plan.digest});
const counts=file=>Object.fromEntries(Object.entries(L.TABLES).map(([name,table])=>[name,rows(file,'SELECT COUNT(*) AS n FROM '+table)[0].n]));

// ================= 1. the plan is dry, bounded, deterministic and document-safe =================
const world=makeWorld();
const main=freshDb(world);
const before=tableDigests(main.file),bytesBefore=fs.readFileSync(main.file);
const built=await planOf(world,main.file,{limits:{batchRows:3}});
assert.equal(built.ok,true,JSON.stringify(built.reasons));
const plan=built.plan;
assert.deepEqual(tableDigests(main.file),before,'planning wrote nothing');
assert.ok(fs.readFileSync(main.file).equals(bytesBefore),'the database file is byte-identical after a plan');
assert.deepEqual(Object.fromEntries(L.CLASSES.map(name=>[name,[plan.classes[name].planned,plan.classes[name].toLoad,plan.classes[name].already]])),{ratedAdmission:[8,8,0],retention:[6,6,0],retirement:[2,2,0]});
assert.deepEqual(plan.classes.ratedAdmission.skipped,{unverified:1,noFilm:1,identityHeld:0,redirected:0},'unverified and Film-less receipts are counted, never loaded');
assert.equal(plan.classes.retention.skipped.noFilm,1,'a list lid without a Film is counted, a non-boolean entry and a candidate key are not entries at all');
assert.equal(plan.complete,true);assert.equal(plan.noop,false);
assert.ok(plan.batches.length===3+2+1,'8 rows in batches of 3, 6 in batches of 3 (2), 2 in one');
assert.ok(plan.batchStatements.every(batch=>batch.statements.length===batch.rows&&batch.rows<=3&&batch.statements.length<=L.BATCH_STATEMENT_CAP));
assert.deepEqual((await planOf(world,main.file,{limits:{batchRows:3}})).plan.digest,plan.digest,'the same inputs give the same digest');
assert.notEqual((await planOf(world,main.file,{limits:{batchRows:3},at:'2026-11-12T09:00:01.000Z'})).plan.digest,plan.digest,'the pinned instant is part of the plan');
assert.notEqual((await planOf(world,main.file,{limits:{batchRows:3},leaseId:'lease-p5-other-0002'})).plan.digest,plan.digest,'the lease is part of the plan');
assert.notEqual((await planOf(world,main.file,{limits:{batchRows:3},windowOwner:WINDOW})).plan.digest,plan.digest,'the window is part of the plan');
const summary=JSON.stringify(L.summarize(plan));
for(const needle of ['film:','Title 1','"lb0"','letterboxd.com'])assert.ok(!summary.includes(needle),'the summary holds no '+needle);
assert.match(summary,/"digest":"[0-9a-f]{64}"/);
// the statements are bounded and every one is an INSERT into one of the three tables, carrying its own fence
for(const batch of plan.batchStatements)for(const item of batch.statements){
 assert.match(item.sql,new RegExp('^INSERT INTO '+batch.table+' '));
 assert.ok(item.sql.includes("a.mode='prepared' AND a.cutover='open' AND a.generation=?")&&item.sql.includes("b.state='verified' AND b.reference=?")&&item.sql.includes("projection='enrichment' AND lease_id=?"),'the fence is inside the row statement');
 assert.ok(!/\b(UPDATE|DELETE|DROP|ALTER|REPLACE|ON CONFLICT)\b/i.test(item.sql));
 assert.ok(!/projection_fence|film_person_cas|canonical_revision|INTO film |INTO film_external_id|INTO person/.test(item.sql),'no fence table and no Film/Person row is written');
}
assert.ok((await planOf(world,main.file,{windowOwner:WINDOW})).plan.batchStatements[0].statements[0].sql.includes('projector_window'),'a pinned window is asserted in every row');

// ================= 2. emit needs --apply and the pinned digest; an edited plan is refused =================
stops(()=>L.emitLoadSql({plan,planDigest:plan.digest}),'apply_required');
stops(()=>L.emitLoadSql({plan,apply:'true',planDigest:plan.digest}),'apply_required','apply must be the boolean true');
stops(()=>L.emitLoadSql({plan,apply:true}),'plan_digest_required');
stops(()=>L.emitLoadSql({plan,apply:true,planDigest:'abc'}),'plan_digest_required');
stops(()=>L.emitLoadSql({plan,apply:true,planDigest:'0'.repeat(64)}),'plan_digest_mismatch');
stops(()=>L.emitLoadSql({plan:null,apply:true,planDigest:plan.digest}),'plan_invalid');
{
 const edited=structuredClone(plan);edited.batchStatements[0].statements[0].params[0]='film:tmdb:1';
 stops(()=>L.emitLoadSql({plan:edited,apply:true,planDigest:plan.digest}),'plan_tampered','a statement edited inside a plan file');
 const dropped=structuredClone(plan);dropped.batchStatements.pop();
 stops(()=>L.emitLoadSql({plan:dropped,apply:true,planDigest:plan.digest}),'plan_tampered','a batch removed');
 const moved=structuredClone(plan);moved.at='2026-11-12T09:00:01.000Z';
 stops(()=>L.emitLoadSql({plan:moved,apply:true,planDigest:plan.digest}),'plan_tampered','a plan field edited');
 const wide=structuredClone(plan);wide.batchStatements[0].statements[0].sql='DELETE FROM film';wide.batches[0].digest=sha(JSON.stringify(wide.batchStatements[0].statements));
 stops(()=>L.emitLoadSql({plan:wide,apply:true,planDigest:plan.digest}),'plan_tampered','digests are not enough: the plan digest covers them');
}
// a plan whose own digests were recomputed (so it is not "tampered") still cannot carry a statement outside the three tables, an unfenced one, or more than one run may hold
{
 const sorted=value=>value&&typeof value==='object'?(Array.isArray(value)?value.map(sorted):Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])]))):value;
 const stableText=value=>JSON.stringify(sorted(value));
 const forge=mutate=>{
  const copy=structuredClone(plan);mutate(copy);
  const {digest:_d,complete:_c,noop:_n,expectedRows:_e,batchStatements,...core}=copy;
  core.batches=batchStatements.map(batch=>({class:batch.class,rows:batch.rows,digest:sha(stableText(batch.statements))}));
  return {...copy,batches:core.batches,digest:sha(stableText(core))};
 };
 const refusedForge=(label,mutate,reason)=>{const forged=forge(mutate);stops(()=>L.emitLoadSql({plan:forged,apply:true,planDigest:forged.digest}),reason,label);};
 assert.doesNotThrow(()=>{const same=forge(()=>{});L.emitLoadSql({plan:same,apply:true,planDigest:same.digest});},'an unchanged plan re-digested is accepted: the forge helper itself is sound');
 refusedForge('a statement outside the three tables',copy=>{copy.batchStatements[0].statements[0]={sql:'DELETE FROM film',params:[]};},'statement_outside_scope');
 refusedForge('a statement into another canonical table',copy=>{copy.batchStatements[0].statements[0]={sql:'INSERT INTO film_rated_admission SELECT 1',params:[]};},'statement_unguarded');
 refusedForge('a statement of another table in a batch',copy=>{copy.batchStatements[0].table='film_retention';},'plan_tampered');
 refusedForge('a batch over the statement cap',copy=>{const first=copy.batchStatements[0];while(first.statements.length<=L.BATCH_STATEMENT_CAP)first.statements.push(first.statements[0]);first.rows=first.statements.length;},'plan_tampered');
 refusedForge('rows and statements disagree',copy=>{copy.batchStatements[0].rows=2;},'plan_tampered');
 refusedForge('more batches than a run may hold',copy=>{while(copy.batchStatements.length<=L.RUN_BATCHES)copy.batchStatements.push(structuredClone(copy.batchStatements[0]));},'run_cap_exceeded');
}
const emitted=emit(plan);
assert.equal(emitted.planDigest,plan.digest);assert.equal(emitted.batches.length,plan.batches.length);
assert.match(emitted.note,/not executed/);
for(const batch of emitted.batches){assert.equal(batch.expectResults,batch.statements.length);assert.equal(batch.sql.split(';\n').length,batch.statements.length);assert.ok(!/\?/.test(batch.sql.replace(/'[^']*'/g,'')),'no placeholder is left in the rendered SQL');}

// ================= 3. apply loads exactly the expected rows and nothing else; a re-run is a no-op =================
await applyBound(main.file,emitted.batches);
assert.deepEqual(counts(main.file),world.expected);
const after=tableDigests(main.file);
for(const [name,digest] of Object.entries(after))if(!THREE.includes(name))assert.equal(digest,before[name],'table '+name+' is untouched');
for(const table of THREE)assert.notEqual(after[table],before[table]);
assert.equal(rows(main.file,'SELECT COUNT(*) AS n FROM projection_fence')[0].n,0,'no fence row was written');
const loaded=await L.readLoadState(main.db);
const ledger=L.readbackLedger({plan,state:loaded});
assert.equal(ledger.ok,true,JSON.stringify(ledger.reasons));
for(const name of L.CLASSES)assert.deepEqual([ledger.classes[name].stored,ledger.classes[name].missing,ledger.classes[name].different,ledger.classes[name].unexpected],[world.expected[name],0,0,0]);
assert.deepEqual(rows(main.file,'SELECT mode,cutover,generation FROM film_person_authority'),[{mode:'prepared',cutover:'open',generation:1}],'the marker is where it was');
// the rows are what the fenced writers' contracts say: stable request ids, the verified facts, the owner's confirmation
assert.ok(rows(main.file,'SELECT request_id FROM film_rated_admission').every(row=>/^p5-load:[0-9a-f]{16}:tmdb_\d+$/.test(row.request_id)));
assert.ok(rows(main.file,'SELECT request_id FROM film_retention').every(row=>/^p5-load:[0-9a-f]{16}:film:lb\d+$/.test(row.request_id)));
assert.ok(rows(main.file,'SELECT request_id,origin,input_sha256 FROM tmdb_retirement_decision').every(row=>/^r2-import:[0-9a-f]{16}:film:rt\d+$/.test(row.request_id)&&row.origin==='r2_import'&&row.input_sha256===sha(world.bytes.retirements)));
assert.deepEqual(rows(main.file,"SELECT watchlist,COUNT(*) AS n FROM film_retention GROUP BY watchlist ORDER BY watchlist"),[{watchlist:0,n:4},{watchlist:1,n:2}]);
assert.equal(rows(main.file,"SELECT COUNT(*) AS n FROM film_retention WHERE observed_at=updated_at AND observed_at=?".replace('?',q(AT)))[0].n,6);
// re-run: the plan is rebuilt from the current state, has nothing to load and no batch
const again=await planOf(world,main.file,{limits:{batchRows:3}});
assert.equal(again.ok,true,JSON.stringify(again.reasons));
assert.equal(again.plan.noop,true);assert.equal(again.plan.batches.length,0);assert.deepEqual(L.CLASSES.map(name=>again.plan.classes[name].already),[8,6,2]);
assert.deepEqual(L.CLASSES.map(name=>again.plan.classes[name].digest),L.CLASSES.map(name=>plan.classes[name].digest),'the same rows, the same class digests, the same request ids');
assert.equal(emit(again.plan).batches.length,0);
// re-applying the very same emitted batches is a no-op too: each statement skips a row that already exists with the same content
const settled=tableDigests(main.file);
await applyBound(main.file,emitted.batches);
assert.deepEqual(tableDigests(main.file),settled,'a replay of the emitted batches changes nothing');
// the rendered SQL text does the same on a second database
{
 const second=freshDb(world);
 for(const batch of emitted.batches)sql(second.file,'PRAGMA foreign_keys=ON;\nBEGIN;\n'+batch.sql+'\nCOMMIT;');
 for(const name of L.CLASSES)assert.equal(L.readbackLedger({plan,state:await L.readLoadState(second.db)}).classes[name].digest,ledger.classes[name].digest,'bound statements and rendered SQL load the same rows');
 const receipt=L.buildReceipt({plan,ledger,at:AT});
 assert.equal(receipt.ok,true);assert.match(receipt.digest,/^[0-9a-f]{64}$/);
 const text=JSON.stringify(receipt)+JSON.stringify(ledger);
 for(const needle of ['film:','Title 1','tmdb_1000','"lb0"'])assert.ok(!text.includes(needle),'the receipt and the readback hold counts and digests only');
}

// ================= 4. the fence: whatever moves under a batch fails the WHOLE batch =================
if(section(4)){
// Each case: a fresh database, the batches emitted, ONE thing changed, the first batch refused and nothing of it written.
const holdWindow=(file,owner=WINDOW)=>sql(file,`UPDATE projector_window SET state='held',owner=${q(owner)},requested_at=${Date.now()},expires_at=${Date.now()+250000} WHERE id=1;`);
async function refused(label,change,{windowOwner=null,world:w=world,batch=0}={}){
 const target=freshDb(w,{triggers:false});
 if(windowOwner)holdWindow(target.file);
 const built2=await planOf(w,target.file,{limits:{batchRows:3},windowOwner});
 assert.equal(built2.ok,true,label+': '+JSON.stringify(built2.reasons));
 const out=emit(built2.plan);
 change(target.file);
 const snapshot=tableDigests(target.file);
 await assert.rejects(()=>applyBound(target.file,[out.batches[batch]]),label);
 assert.deepEqual(tableDigests(target.file),snapshot,label+': nothing of the batch was written');
 return {target,out};
}
await refused('marker moved to d1/open',file=>sql(file,"UPDATE film_person_authority SET mode='d1',cutover='open',generation=2 WHERE id=1;"));
await refused('marker held',file=>sql(file,"UPDATE film_person_authority SET mode='d1',cutover='held',generation=3 WHERE id=1;"));
await refused('marker back to r2',file=>sql(file,"UPDATE film_person_authority SET mode='r2',generation=2 WHERE id=1;"));
await refused('generation moved, mode unchanged',file=>sql(file,'UPDATE film_person_authority SET generation=2 WHERE id=1;'));
await refused('mode changed, generation unchanged',file=>sql(file,"UPDATE film_person_authority SET mode='d1' WHERE id=1;"));
await refused('baseline reopened',file=>sql(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1;"));
await refused('baseline reference changed',file=>sql(file,"UPDATE film_person_baseline SET reference='another-reference' WHERE id=1;"));
await refused('lease expired',file=>sql(file,"UPDATE projection_run SET lease_until='2020-01-01T00:00:00.000Z' WHERE projection='enrichment';"));
await refused('lease released',file=>sql(file,"UPDATE projection_run SET lease_id=NULL,lease_until=NULL WHERE projection='enrichment';"));
await refused('lease taken by another run',file=>sql(file,"UPDATE projection_run SET lease_id='someone-else-0001' WHERE projection='enrichment';"));
await refused('window not held',file=>sql(file,"UPDATE projector_window SET state='idle',owner=NULL,requested_at=NULL,expires_at=0 WHERE id=1;"),{windowOwner:WINDOW});
await refused('window held by another owner',file=>holdWindow(file,'someone-else-0001'),{windowOwner:WINDOW});
await refused('window expired',file=>sql(file,`UPDATE projector_window SET state='held',owner=${q(WINDOW)},requested_at=1000,expires_at=2000 WHERE id=1;`),{windowOwner:WINDOW});
// with the window held the same plan applies
{
 const target=freshDb(world,{triggers:false});
 holdWindow(target.file);
 const built2=await planOf(world,target.file,{windowOwner:WINDOW});
 await applyBound(target.file,emit(built2.plan).batches);
 assert.deepEqual(counts(target.file),world.expected);
}
// identity moved under the plan (admission is batch 0, retention batch 3, retirement batch 5): the Film no longer owns the id, a second claim, a redirect
await refused('trusted movie id untrusted',file=>sql(file,"UPDATE film_external_id SET trusted=0 WHERE scheme='tmdb' AND value='1000';"));
await refused('movie id claimed again',file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:claimant',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:claimant','tmdb','1001',0,1);"));
await refused('Film became a redirect',file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:target',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:1002','film:target','2026-11-12T00:00:00.000Z');"));
await refused('Film removed',file=>sql(file,"PRAGMA foreign_keys=OFF;DELETE FROM film_external_id WHERE film_id='film:tmdb:1000';DELETE FROM film WHERE id='film:tmdb:1000';"));
await refused('Letterboxd id moved to another Film',file=>sql(file,"UPDATE film_external_id SET film_id='film:tmdb:1000' WHERE scheme='letterboxd' AND value='lb0';"),{batch:3});
await refused('Letterboxd id claimed by a second Film',file=>sql(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:1000','letterboxd','lb1',0,0);"),{batch:3});
await refused('retention Film became a redirect',file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:target',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb2','film:target','2026-11-12T00:00:00.000Z');"),{batch:3});
// the marker moves AFTER the first batch of a run: the rest fails, the first stays (it was proven when it ran), and a later plan refuses
{
 const target=freshDb(world,{triggers:false});
 const built2=await planOf(world,target.file,{limits:{batchRows:3}}),out=emit(built2.plan);
 await applyBound(target.file,[out.batches[0]]);
 const first=tableDigests(target.file);
 sql(target.file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;");
 await assert.rejects(()=>applyBound(target.file,[out.batches[1]]));
 assert.deepEqual(tableDigests(target.file),{...first,film_person_authority:tableDigests(target.file).film_person_authority});
 assert.deepEqual((await planOf(world,target.file)).reasons,['marker_not_prepared:d1/open']);
}
// a class count already at its total (rows this plan does not know) fails every row: the bound is inside the statement
{
 const target=freshDb(world,{triggers:false});
 const built2=await planOf(world,target.file,{limits:{batchRows:3}}),out=emit(built2.plan);
 sql(target.file,Array.from({length:4},(_unused,i)=>`INSERT INTO film (id,contract_version,updated_at) VALUES ('film:spare${i}',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:spare${i}','watchlist_fact',0,'{}','other-${i}','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');`).join('\n'));
 const snapshot=tableDigests(target.file);
 await assert.rejects(()=>applyBound(target.file,[out.batches[3]]));
 assert.deepEqual(tableDigests(target.file),snapshot);
}
// a row of the plan that already exists with other content (same key) is a conflict, not an overwrite
{
 const target=freshDb(world,{triggers:false});
 const built2=await planOf(world,target.file,{limits:{batchRows:3}}),out=emit(built2.plan);
 sql(target.file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:1000','1000','other','"+'b'.repeat(64)+"',NULL,NULL,'k','tmdb_1000','2026-10-01T10:00:00.000Z','x','2026-11-01T00:00:00.000Z');");
 const snapshot=tableDigests(target.file);
 await assert.rejects(()=>applyBound(target.file,[out.batches[0]]));
 assert.deepEqual(tableDigests(target.file),snapshot,'the stored row is neither updated nor replaced');
}
}

// ================= 5. the plan refuses on any mismatch =================
const stateOf=async file=>L.readLoadState(d1Standin(file));
const stateAfter=async(mutate,w=world)=>{const target=freshDb(w,{triggers:false});mutate(target.file);return stateOf(target.file);};
const refusal=async(label,{state,sources=source(world.bytes),expected=world.expected,limits,at=AT,leaseId=LEASE,windowOwner=null},reason)=>{
 const out=L.buildLoadPlan({sources,state:state||await stateOf(main0.file),at,leaseId,windowOwner,expected,limits});
 assert.equal(out.ok,false,label);assert.ok(out.reasons.some(item=>item===reason||item.startsWith(reason)),label+': '+JSON.stringify(out.reasons));
 assert.equal(out.plan,undefined);
};
const main0=freshDb(world,{triggers:false});
if(section(5)){
await refusal('marker r2',{state:await stateAfter(file=>sql(file,"UPDATE film_person_authority SET mode='r2',generation=2 WHERE id=1;"))},'marker_not_prepared:r2/open');
await refusal('marker d1/open',{state:await stateAfter(file=>sql(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"))},'marker_not_prepared:d1/open');
await refusal('marker held',{state:await stateAfter(file=>sql(file,"UPDATE film_person_authority SET mode='d1',cutover='held',generation=2 WHERE id=1;"))},'marker_not_prepared:d1/held');
await refusal('baseline loading',{state:await stateAfter(file=>sql(file,"UPDATE film_person_baseline SET state='loading' WHERE id=1;"))},'baseline_not_verified');
await refusal('baseline without reference',{state:await stateAfter(file=>sql(file,"UPDATE film_person_baseline SET reference=NULL WHERE id=1;"))},'baseline_not_verified');
{const state=await stateOf(main0.file);await refusal('schema below 16',{state:{...state,schema:[{version:15}]}},'schema_below_16');}
{const state=await stateOf(main0.file);await refusal('marker unreadable',{state:{...state,marker:[]}},'marker_unreadable');}
await assert.rejects(()=>L.readLoadState({prepare:()=>({all:async()=>{throw new Error('no such table: film_rated_admission');}})}),error=>error.reason==='state_tables_missing','a missing table is a refusal, never an empty class');
await assert.rejects(()=>L.readLoadState({prepare:()=>({all:async()=>({results:null})})}),error=>error.reason==='state_malformed');
await assert.rejects(()=>L.readLoadState({prepare:()=>({all:async()=>{throw new Error('boom');}})}),error=>error.reason==='state_unreadable');
// the sources
await refusal('source digest mismatch',{sources:{...source(world.bytes),verifiedFilms:{bytes:world.bytes.verifiedFilms,sha256:'0'.repeat(64)}}},'source_digest_mismatch:verifiedFilms');
await refusal('source missing',{sources:{...source(world.bytes),viewIndex:undefined}},'source_missing:viewIndex');
await refusal('source malformed JSON',{sources:{...source(world.bytes),retirements:{bytes:Buffer.from('{nope')}}},'source_malformed:retirements');
await refusal('receipts of another schema',{sources:{...source(world.bytes),verifiedFilms:{bytes:Buffer.from(JSON.stringify({schemaVersion:2,films:{}}))}}},'source_malformed:verifiedFilms');
await refusal('view index not a record',{sources:{...source(world.bytes),viewIndex:{bytes:Buffer.from('[]')}}},'source_malformed:viewIndex');
{
 const bad=structuredClone(world.retire);bad[1].confirmation={by:'someone'};
 await refusal('one invalid retirement invalidates all',{sources:{...source(world.bytes),retirements:{bytes:Buffer.from(JSON.stringify({schemaVersion:1,retirements:bad}))}}},'retirements_invalid');
 const dup=[world.retire[0],{...world.retire[0]}];
 await refusal('a duplicated retirement invalidates all',{sources:{...source(world.bytes),retirements:{bytes:Buffer.from(JSON.stringify({schemaVersion:1,retirements:dup}))}}},'retirements_invalid');
}
// counts are pinned to the expectation, and the default expectation is the accepted 11 Nov measurement
await refusal('count below expectation',{expected:{...world.expected,ratedAdmission:9}},'count_mismatch:ratedAdmission');
await refusal('count above expectation',{expected:{...world.expected,retention:5}},'count_mismatch:retention');
await refusal('retirement count',{expected:{...world.expected,retirement:3}},'count_mismatch:retirement');
assert.deepEqual(L.EXPECTED,{ratedAdmission:708,retention:401,retirement:4});
assert.deepEqual(L.EXPECTED,Object.fromEntries(L.CLASSES.map(name=>[name,ACCEPTED_DISCREPANCIES.caps[name]])));
await refusal('inputs, bounds and pins are validated',{at:'2026-11-12T09:00:00Z'},'at_invalid');
await refusal('lease id',{leaseId:'x'},'lease_id_invalid');
await refusal('window owner',{windowOwner:'x'},'window_owner_invalid');
assert.deepEqual(L.buildLoadPlan({sources:source(world.bytes),state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:world.expected,limits:{batchRows:L.BATCH_STATEMENT_CAP+1}}).reasons,['limits_invalid']);
assert.deepEqual(L.buildLoadPlan({sources:source(world.bytes),state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:world.expected,limits:{runBatches:L.RUN_BATCHES+1}}).reasons,['limits_invalid']);
assert.deepEqual(L.buildLoadPlan({sources:source(world.bytes),state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:world.expected,limits:{runStatements:L.RUN_STATEMENTS+1}}).reasons,['limits_invalid']);
assert.deepEqual(L.buildLoadPlan({sources:source(world.bytes),state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:{ratedAdmission:-1}}).reasons,['expected_invalid']);
// rows the plan does not know, and rows that differ
{
 const spare="INSERT INTO film (id,contract_version,updated_at) VALUES ('film:spare',1,'2026-11-01T00:00:00.000Z');";
 await refusal('unknown admission row',{state:await stateAfter(file=>sql(file,spare+"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:spare','777','zz','"+'c'.repeat(64)+"',NULL,NULL,'k','tmdb_777','2026-10-01T10:00:00.000Z','x','2026-11-01T00:00:00.000Z');"))},'unknown_rows:ratedAdmission');
 await refusal('unknown retention row',{state:await stateAfter(file=>sql(file,spare+"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:spare','watchlist_fact',1,'{}','x','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');"))},'unknown_rows:retention');
 await refusal('unknown retirement row',{state:await stateAfter(file=>sql(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,input_sha256,supersedes_seq,payload_json,recorded_at) VALUES ('owner-1','film:zz','retire','zz','1','2','{}','{\"by\":\"owner\",\"at\":\"x\",\"source\":\"y\"}','owner_request',NULL,NULL,'{}','2026-11-01T00:00:00.000Z');"))},'unknown_rows:retirement');
 await refusal('admission row with other content',{state:await stateAfter(file=>sql(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:1000','1000','c0','"+'d'.repeat(64)+"',NULL,NULL,'letterboxd/admissions/verified-films.json','tmdb_1000','2026-10-01T10:00:00.000Z','x','2026-11-01T00:00:00.000Z');"))},'mismatch:ratedAdmission');
 await refusal('retention row with other content',{state:await stateAfter(file=>sql(file,"INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:lb0','watchlist_fact',0,'{}','x','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');"))},'mismatch:retention');
}
// identity: an untrusted or conflicting claim on a movie id leaves that receipt unloaded (counted), a Letterboxd id on two Films refuses, a redirect is skipped
{
 const held=L.buildLoadPlan({sources:source(world.bytes),state:await stateAfter(file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:claimant',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:claimant','tmdb','1001',0,1);")),at:AT,leaseId:LEASE,expected:{...world.expected,ratedAdmission:7}});
 assert.equal(held.ok,true,JSON.stringify(held.reasons));assert.equal(held.plan.classes.ratedAdmission.skipped.identityHeld,1);
 {
 const redirectedAdmission=L.buildLoadPlan({sources:source(world.bytes),state:await stateAfter(file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:target',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:1002','film:target','2026-11-12T00:00:00.000Z');")),at:AT,leaseId:LEASE,expected:{...world.expected,ratedAdmission:7}});
 assert.equal(redirectedAdmission.ok,true,JSON.stringify(redirectedAdmission.reasons));assert.equal(redirectedAdmission.plan.classes.ratedAdmission.skipped.redirected,1);
}
 await refusal('a Letterboxd id on two Films',{state:await stateAfter(file=>sql(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:1000','letterboxd','lb1',0,0);"))},'retention_ambiguous');
 const redirected=L.buildLoadPlan({sources:source(world.bytes),state:await stateAfter(file=>sql(file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:target',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb2','film:target','2026-11-12T00:00:00.000Z');")),at:AT,leaseId:LEASE,expected:{...world.expected,retention:5}});
 assert.equal(redirected.ok,true,JSON.stringify(redirected.reasons));assert.equal(redirected.plan.classes.retention.skipped.redirected,1);
}
{
 const dupWorld=makeWorld();dupWorld.receipts.films.tmdb_1001.sourceCode='c0';
 const dup=Buffer.from(JSON.stringify(dupWorld.receipts));
 await refusal('one short code on two Films',{sources:{...source(world.bytes),verifiedFilms:{bytes:dup}}},'duplicate_source_code');
}
}

// ================= 6. bounded per run, resumable: what does not fit is deferred and goes into the next run =================
if(section(6)){
{
 const target=freshDb(world,{triggers:false});
 const first=await planOf(world,target.file,{limits:{batchRows:3,runBatches:2}});
 assert.equal(first.ok,true);assert.equal(first.plan.batches.length,2);assert.equal(first.plan.complete,false);assert.equal(first.plan.deferred,16-6);
 await applyBound(target.file,emit(first.plan).batches);
 assert.deepEqual(counts(target.file),{ratedAdmission:6,retention:0,retirement:0});
 const second=await planOf(world,target.file,{limits:{batchRows:3,runStatements:4}});
 assert.equal(second.ok,true,JSON.stringify(second.reasons));
 assert.equal(second.plan.classes.ratedAdmission.already,6);assert.ok(second.plan.batches.length<=2&&!second.plan.complete);
 assert.notEqual(second.plan.digest,first.plan.digest);
 await applyBound(target.file,emit(second.plan).batches);
 for(let guard=0;guard<10;guard++){
  const next=await planOf(world,target.file,{limits:{batchRows:3,runStatements:4}});
  assert.equal(next.ok,true,JSON.stringify(next.reasons));
  if(next.plan.noop)break;
  await applyBound(target.file,emit(next.plan).batches);
 }
 assert.deepEqual(counts(target.file),world.expected);
 assert.equal(L.readbackLedger({plan:(await planOf(world,target.file)).plan,state:await stateOf(target.file)}).ok,true);
 assert.equal(L.RUN_STATEMENTS>=1113&&L.RUN_BATCHES>=30&&L.BATCH_ROWS<=L.BATCH_STATEMENT_CAP,true,'the default bounds hold the 1,113 accepted rows in one run');
}
}

// ================= 7. the accepted production counts, end to end (708 / 401 / 4) =================
if(section(7)){
{
 const big=makeWorld({admissions:708,retention:401,retirements:4,noise:true});
 const target=freshDb(big,{triggers:false});
 const built3=L.buildLoadPlan({sources:source(big.bytes),state:await stateOf(target.file),at:AT,leaseId:LEASE});
 assert.equal(built3.ok,true,JSON.stringify(built3.reasons));
 const p=built3.plan;
 assert.deepEqual(L.CLASSES.map(name=>p.classes[name].toLoad),[708,401,4]);
 assert.equal(p.batches.length,Math.ceil(708/40)+Math.ceil(401/40)+1);
 assert.ok(p.batches.length<=L.RUN_BATCHES&&p.batches.reduce((sum,batch)=>sum+batch.rows,0)===1113&&p.complete);
 assert.ok(p.batchStatements.every(batch=>batch.statements.length<=L.BATCH_STATEMENT_CAP));
 const out=emit(p);
 const guardCheck=tableDigests(target.file);
 await applyBound(target.file,out.batches);
 assert.deepEqual(counts(target.file),{ratedAdmission:708,retention:401,retirement:4});
 const ledger2=L.readbackLedger({plan:p,state:await stateOf(target.file)});
 assert.equal(ledger2.ok,true,JSON.stringify(ledger2.reasons));
 for(const [name,digest] of Object.entries(tableDigests(target.file)))if(!THREE.includes(name))assert.equal(digest,guardCheck[name],name+' untouched at scale');
 assert.equal(L.buildLoadPlan({sources:source(big.bytes),state:await stateOf(target.file),at:AT,leaseId:LEASE}).plan.noop,true,'the 1,113 rows are loaded once: the next plan is a no-op');
 // the readback notices every kind of difference
 sql(target.file,"INSERT INTO film (id,contract_version,updated_at) VALUES ('film:spareX',1,'2026-11-01T00:00:00.000Z');INSERT INTO film_retention (film_id,basis,watchlist,evidence_json,request_id,observed_at,updated_at) VALUES ('film:spareX','watchlist_fact',0,'{}','x','2026-11-01T00:00:00.000Z','2026-11-01T00:00:00.000Z');");
 const extra=L.readbackLedger({plan:p,state:await stateOf(target.file)});
 assert.equal(extra.ok,false);assert.equal(extra.classes.retention.unexpected,1);
 sql(target.file,"DELETE FROM film_retention WHERE film_id='film:spareX';");
 sql(target.file,"DELETE FROM film_retention WHERE film_id='film:lb0';");
 const broken=L.readbackLedger({plan:p,state:await stateOf(target.file)});
 assert.equal(broken.ok,false);assert.equal(broken.classes.retention.missing,1);assert.ok(broken.reasons.includes('readback:retention'));
 sql(target.file,"UPDATE film_rated_admission SET title='changed' WHERE film_id='film:tmdb:1001';");
 assert.equal(L.readbackLedger({plan:p,state:await stateOf(target.file)}).classes.ratedAdmission.different,1);
 sql(target.file,"UPDATE film_person_baseline SET reference='other' WHERE id=1;");
 assert.ok(L.readbackLedger({plan:p,state:await stateOf(target.file)}).reasons.includes('baseline_changed'));
 sql(target.file,`UPDATE film_person_baseline SET reference=${q(REF)} WHERE id=1;`);
 sql(target.file,"UPDATE film_person_authority SET mode='d1' WHERE id=1;");
 assert.ok(L.readbackLedger({plan:p,state:await stateOf(target.file)}).reasons.includes('marker_moved'));
 sql(target.file,"UPDATE film_person_authority SET mode='prepared' WHERE id=1;");
 sql(target.file,"UPDATE film_person_authority SET generation=7 WHERE id=1;");
 assert.ok(L.readbackLedger({plan:p,state:await stateOf(target.file)}).reasons.includes('generation_moved'));
 assert.ok(L.readbackLedger({plan:p,state:await stateOf(target.file),expectGeneration:2}).reasons.includes('gate_not_the_pinned_one'));
}
}

// ================= 8. the sources: read-only, allowlisted, never retried across a changed object =================
if(section(8)){
{
 const objects=Object.fromEntries(Object.entries(L.SOURCE_KEYS).map(([id,key])=>[key,world.bytes[id]]));
 const calls=[];
 const client=(over={})=>({
  head:async(key,options)=>{calls.push(['head',key,options?.ifMatch??null]);if(!objects[key])return null;return {key,size:objects[key].length,etag:over.etag?.(key)??'e-'+sha(objects[key]).slice(0,8)};},
  get:async(key,options)=>{calls.push(['get',key,options?.ifMatch??null]);if(!objects[key])return null;return {key,size:objects[key].length,etag:'e-'+sha(objects[key]).slice(0,8),body:objects[key]};},
 });
 const got=await L.readSourcesFromClient(client());
 assert.deepEqual(Object.keys(got).sort(),['retirements','verifiedFilms','viewIndex']);
 for(const id of Object.keys(got))assert.equal(got[id].sha256,sha(world.bytes[id]));
 assert.deepEqual([...new Set(calls.map(call=>call[0]))].sort(),['get','head'],'only HEAD and GET');
 assert.deepEqual([...new Set(calls.map(call=>call[1]))].sort(),Object.values(L.SOURCE_KEYS).sort(),'only the three allowlisted keys');
 assert.equal(calls.filter(call=>call[0]==='get').every(call=>call[2]),true,'every GET is conditional on the ETag');
 assert.equal(Object.keys(client()).sort().join(),'get,head','the client the loader is given can only read');
 await assert.rejects(()=>L.readSourcesFromClient(client({etag:key=>key===L.SOURCE_KEYS.viewIndex?'moved-'+Math.random():undefined})),error=>error.reason==='source_changed');
 {let heads=0;await assert.rejects(()=>L.readSourcesFromClient({head:async key=>({key,size:objects[key].length,etag:heads++===1?'moved':'e1'}),get:async key=>({key,size:objects[key].length,etag:'e1',body:objects[key]})}),error=>error.reason==='source_changed','an ETag that moves between the GET and the closing HEAD');}
 const missing={...objects};delete missing[L.SOURCE_KEYS.retirements];
 await assert.rejects(()=>L.readSourcesFromClient({head:async key=>missing[key]?{key,size:missing[key].length,etag:'x'}:null,get:async key=>missing[key]?{key,size:missing[key].length,etag:'x',body:missing[key]}:null}),error=>error.reason==='source_missing');
 await assert.rejects(()=>L.readSourcesFromClient(client(),{maxBytes:10}),error=>error.reason==='source_too_large');
 await assert.rejects(()=>L.readSourcesFromClient({head:async key=>({key,size:5,etag:'x'}),get:async key=>({key,size:5,etag:'x',body:Buffer.from('abc')})}),error=>error.reason==='source_size_mismatch');
 await assert.rejects(()=>L.readSourcesFromClient({head:async()=>{throw new Error('offline');},get:async()=>null}),error=>error.reason==='source_unreadable');
 const planFromClient=L.buildLoadPlan({sources:got,state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:world.expected});
 assert.equal(planFromClient.ok,true,JSON.stringify(planFromClient.reasons));
 // the operator-copy path reads three named files
 const dir=path.join(root,'sources');fs.mkdirSync(dir);
 for(const [id,name] of Object.entries(L.SOURCE_FILES))fs.writeFileSync(path.join(dir,name),world.bytes[id]);
 assert.equal(L.buildLoadPlan({sources:L.readSourcesFromDirectory(dir),state:await stateOf(main0.file),at:AT,leaseId:LEASE,expected:world.expected}).plan.digest,planFromClient.plan.digest,'a file copy and a live read of the same bytes make the same plan');
 fs.rmSync(path.join(dir,L.SOURCE_FILES.viewIndex));
 stops(()=>L.readSourcesFromDirectory(dir),'source_missing');
}
}

// ================= 9. the module cannot write anything but SQL text =================
if(section(9)){
{
 const text=fs.readFileSync('scripts/film-person-prepared-loader.mjs','utf8');
 assert.ok(!/\.batch\(|\.run\(|\.exec\(|createD1Adapter|fetch\(|\bput\b|PutObject|writeFileSync\([^)]*sqlite/i.test(text.replace(/^\s*\/\/.*$/gm,'')),'no database or bucket write call exists in the loader');
 assert.ok(!fs.readFileSync('build.mjs','utf8').includes('prepared-loader'),'not bundled');
 const grep=spawnSync('grep',['-rln','film-person-prepared-loader','src','worker.js','build.mjs','wrangler.toml'],{encoding:'utf8'});
 assert.equal(grep.stdout.trim(),'','no Worker or src/ file imports the loader');
}
}

// ================= 10. the CLI: dry by default, --apply and the pinned digest for SQL, private paths only =================
if(section(10)){
{
 const w=makeWorld({admissions:708,retention:401,retirements:4,noise:false});
 const target=freshDb(w,{triggers:true});
 const dir=path.join(root,'cli-sources');fs.mkdirSync(dir);
 for(const [id,name] of Object.entries(L.SOURCE_FILES))fs.writeFileSync(path.join(dir,name),w.bytes[id]);
 const cli=process.env.LOADER_MODULE?path.resolve(process.env.LOADER_MODULE):'scripts/film-person-prepared-loader.mjs';
 const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,R2_SNAPSHOT_ENDPOINT:'',R2_SNAPSHOT_ACCESS_KEY_ID:'',R2_SNAPSHOT_SECRET_ACCESS_KEY:''}});
 const common=['--copy',target.file,'--source-dir',dir,'--at',AT,'--lease-id',LEASE];
 const dry=run(['plan',...common]);
 assert.equal(dry.status,0,dry.stderr);
 const shown=JSON.parse(dry.stdout);
 assert.equal(shown.mode,'dry-run');assert.deepEqual(L.CLASSES.map(name=>shown.classes[name].toLoad),[708,401,4]);
 assert.deepEqual(counts(target.file),{ratedAdmission:0,retention:0,retirement:0},'a plan loads nothing');
 const out=path.join(root,'cli-out');
 const noApply=run(['sql',...common,'--plan-digest',shown.digest,'--out',out]);
 assert.equal(noApply.status,1);assert.match(noApply.stderr,/STOP apply_required/);assert.ok(!fs.existsSync(out),'without --apply no file is written');
 const noDigest=run(['sql',...common,'--apply','--out',out]);
 assert.equal(noDigest.status,1);assert.match(noDigest.stderr,/STOP plan_digest_required/);
 const wrong=run(['sql',...common,'--apply','--plan-digest','1'.repeat(64),'--out',out]);
 assert.equal(wrong.status,1);assert.match(wrong.stderr,/STOP plan_digest_mismatch/);assert.ok(!fs.existsSync(out));
 const insideOut=path.join(process.cwd(),'tmp-loader-out-'+process.pid);
 const inside=run(['sql',...common,'--apply','--plan-digest',shown.digest,'--out',insideOut]);
 const leftInside=fs.existsSync(insideOut);fs.rmSync(insideOut,{recursive:true,force:true});
 assert.equal(inside.status,1);assert.match(inside.stderr,/private_path_inside_repository/);assert.ok(!leftInside);
 const real=run(['sql',...common,'--apply','--plan-digest',shown.digest,'--out',out]);
 assert.equal(real.status,0,real.stderr);
 const files=fs.readdirSync(out).sort();assert.equal(files.length,shown.batches);
 assert.deepEqual(counts(target.file),{ratedAdmission:0,retention:0,retirement:0},'emitting SQL changes nothing');
 const dumped=files.map(name=>JSON.parse(fs.readFileSync(path.join(out,name),'utf8')));
 assert.ok(dumped.every(batch=>batch.planDigest===shown.digest));
 await applyBound(target.file,dumped);
 assert.deepEqual(counts(target.file),{ratedAdmission:708,retention:401,retirement:4});
 const ver=run(['verify',...common,'--expect-generation','1','--expect-reference',REF,'--out',path.join(root,'cli-verify')]);
 assert.equal(ver.status,0,ver.stderr);assert.equal(JSON.parse(ver.stdout).ledger.ok,true);
 assert.ok(fs.existsSync(path.join(root,'cli-verify','receipt.json')));
 const wrongGen=run(['verify',...common,'--expect-generation','2','--expect-reference',REF]);
 assert.equal(wrongGen.status,2);assert.ok(JSON.parse(wrongGen.stdout).ledger.reasons.includes('gate_not_the_pinned_one'));
 const replan=run(['plan',...common]);
 assert.equal(JSON.parse(replan.stdout).noop,true,'the CLI sees the loaded state and plans nothing');
 const moved=run(['sql',...common,'--apply','--plan-digest',shown.digest,'--out',path.join(root,'cli-out2')]);
 assert.equal(moved.status,1);assert.match(moved.stderr,/plan_digest_mismatch/,'a digest pinned before the state moved is no longer accepted');
 const noSource=run(['plan','--copy',target.file,'--at',AT,'--lease-id',LEASE]);
 assert.equal(noSource.status,1);assert.match(noSource.stderr,/usage/);
 const small=freshDb(world,{triggers:true});
 const mismatch=run(['plan','--copy',small.file,'--source-dir',dir,'--at',AT,'--lease-id',LEASE]);
 assert.equal(mismatch.status,2,'sources of another world are refused against the copy');
 const refusedSql=run(['sql','--copy',small.file,'--source-dir',dir,'--at',AT,'--lease-id',LEASE,'--apply','--plan-digest','1'.repeat(64),'--out',path.join(root,'cli-out3')]);
 assert.equal(refusedSql.status,2);assert.ok(JSON.parse(refusedSql.stdout).reasons.length>0&&!fs.existsSync(path.join(root,'cli-out3')),'a refused plan emits no SQL');
}
}

// ================= 11. an unfinished connector copy is refused (`copy_incomplete`) by every command that reads the copy =================
// The operator copy carries `connector_copy_table` (done=1 per table). The loader reads the eight tables behind its state statements only when all eight are done.
if(section(11)){
{
 const EIGHT=Object.keys(L.STATE_STATEMENTS);
 assert.deepEqual(EIGHT,['schema','marker','baseline','identity','redirects','ratedAdmission','retention','retirement']);
 assert.deepEqual(L.STATE_SOURCE_TABLES,{schema:'schema_contract',marker:'film_person_authority',baseline:'film_person_baseline',identity:'film_external_id',redirects:'film_redirect',ratedAdmission:'film_rated_admission',retention:'film_retention',retirement:'tmdb_retirement_decision'},'the tables are derived from the statements');
 assert.ok(Object.values(L.STATE_SOURCE_TABLES).every(table=>COPY_TABLES.includes(table)),'the connector copies every table the loader reads');
 const DDL='CREATE TABLE connector_copy_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, label TEXT, at TEXT NOT NULL, detail TEXT NOT NULL);CREATE TABLE connector_copy_table (name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL, row_count INTEGER NOT NULL, done INTEGER NOT NULL);';
 const copyOf=(not=[],{rowsFor=COPY_TABLES,ddl=DDL,extra=''}={})=>{
  const {file}=freshDb(world,{triggers:true});
  sql(file,ddl+rowsFor.map(name=>`INSERT INTO connector_copy_table (name,last_rowid,row_count,done) VALUES (${q(name)},1,1,${not.includes(name)?0:1});`).join('')+extra);
  return file;
 };
 const detailOf=file=>{try{L.copyReadBinding(file);}catch(error){return error.message;}return null;};
 // positive: a complete copy is accepted and read; so is a file that holds only the eight tables done (the other tables of the plan are the connector's own concern)
 const complete=copyOf();
 const state=await L.readLoadState(L.copyReadBinding(complete));
 assert.equal(L.buildLoadPlan({sources:source(world.bytes),state,at:AT,leaseId:LEASE,expected:world.expected}).ok,true);
 assert.doesNotThrow(()=>L.copyReadBinding(copyOf([],{rowsFor:Object.values(L.STATE_SOURCE_TABLES)})));
 // a file without any log table was not made by the connector tool: read as before (the stand-in of this file, the synthetic production of the H1 rehearsal)
 assert.doesNotThrow(()=>L.copyReadBinding(freshDb(world,{triggers:true}).file));
 // negative: each of the eight tables not done, one by one; and each recorded nowhere
 for(const [id,table] of Object.entries(L.STATE_SOURCE_TABLES)){
  assert.equal(detailOf(copyOf([table])),'copy_incomplete: '+id,table+' not done');
  assert.equal(detailOf(copyOf([],{rowsFor:COPY_TABLES.filter(name=>name!==table)})),'copy_incomplete: '+id,table+' not in the log');
 }
 assert.equal(detailOf(copyOf([],{rowsFor:[]})),'copy_incomplete: schema','an empty log');
 // fail closed on a log that cannot be read as {name, done in 0|1}
 const bad=(label,file)=>assert.equal(detailOf(file),'copy_incomplete: log',label);
 bad('only the log table',copyOf([],{ddl:'CREATE TABLE connector_copy_log (seq INTEGER PRIMARY KEY);',rowsFor:[]}));
 bad('only the table log',copyOf([],{ddl:'CREATE TABLE connector_copy_table (name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL, row_count INTEGER NOT NULL, done INTEGER NOT NULL);'}));
 bad('a log table without a done column',copyOf([],{ddl:'CREATE TABLE connector_copy_log (seq INTEGER PRIMARY KEY);CREATE TABLE connector_copy_table (name TEXT PRIMARY KEY);',rowsFor:[]}));
 const loose='CREATE TABLE connector_copy_log (seq INTEGER PRIMARY KEY);CREATE TABLE connector_copy_table (name, last_rowid, row_count, done);';
 bad('done is not 0 or 1',copyOf([],{ddl:loose,extra:"UPDATE connector_copy_table SET done=2 WHERE name='film_retention';"}));
 bad('done is text',copyOf([],{ddl:loose,extra:"UPDATE connector_copy_table SET done='SECRET-VALUE' WHERE name='film_retention';"}));
 bad('done is null',copyOf([],{ddl:loose,extra:"UPDATE connector_copy_table SET done=NULL WHERE name='film_retention';"}));
 bad('a table without a name',copyOf([],{ddl:loose,extra:'INSERT INTO connector_copy_table VALUES (NULL,1,1,1);'}));
 bad('a table logged twice',copyOf([],{ddl:loose,extra:"INSERT INTO connector_copy_table VALUES ('film',1,1,1);"}));
 // every command reads the copy through the same binding: plan, verify and sql refuse with the same code and name no row
 const cutCopy=(() => {
  // a post-load cut: everything up to film_external_id and film_redirect is done, film_rated_admission and what follows is not
  const first=COPY_TABLES.indexOf('film_rated_admission');
  return copyOf(COPY_TABLES.slice(first));
 })();
 const dir=path.join(root,'incomplete-sources');fs.mkdirSync(dir);
 for(const [id,name] of Object.entries(L.SOURCE_FILES))fs.writeFileSync(path.join(dir,name),world.bytes[id]);
 const cli=process.env.LOADER_MODULE?path.resolve(process.env.LOADER_MODULE):'scripts/film-person-prepared-loader.mjs';
 const run=args=>spawnSync(process.execPath,[cli,...args],{encoding:'utf8',env:{...process.env,R2_SNAPSHOT_ENDPOINT:'',R2_SNAPSHOT_ACCESS_KEY_ID:'',R2_SNAPSHOT_SECRET_ACCESS_KEY:''}});
 const common=['--source-dir',dir,'--at',AT,'--lease-id',LEASE];
 const out=path.join(root,'incomplete-out');
 const commands={plan:['plan'],verify:['verify','--expect-generation','1','--expect-reference',REF],sql:['sql','--apply','--plan-digest','1'.repeat(64),'--out',out]};
 for(const [name,args] of Object.entries(commands)){
  const result=run([...args,'--copy',cutCopy,...common]);
  assert.equal(result.status,1,name+': '+result.stdout);assert.equal(result.stderr.trim(),'STOP copy_incomplete: ratedAdmission',name+' names the statement only');assert.equal(result.stdout,'','nothing printed on stdout');
 }
 assert.ok(!fs.existsSync(out),'a refused sql command writes nothing');
 const leak=copyOf([],{ddl:loose,extra:"UPDATE connector_copy_table SET done='SECRET-VALUE' WHERE name='film_retention';"});
 const leaked=run(['plan','--copy',leak,...common]);
 assert.equal(leaked.status,1);assert.ok(!(leaked.stdout+leaked.stderr).includes('SECRET-VALUE'),'no row value in the refusal');
 // the same copy with its log complete is read: the small world fails the pinned counts of the CLI, not the copy
 const ok=run(['plan','--copy',complete,...common]);
 assert.equal(ok.status,2);assert.ok(!(ok.stdout+ok.stderr).includes('copy_incomplete'));
}
}

console.log('film-person-prepared-loader: ok ('+(Date.now()-started)+' ms)');
