// AIR-374 H1 rehearsal (offline, synthetic): the snapshot route the H1 operator package (docs/runbooks/film-person-h1-load-package.md) section 3.2 describes, run end to end
// on a synthetic schema-21 database and a local sqlite stand-in. A sqlite file plays production D1; a FAKE connector (`cloudflare.request` over that file, SELECT only: any
// other statement throws) runs the function texts of scripts/film-person-connector-run.mjs. ONLY `ddl` and `copy` are run, never `leaseAcquire`, `leaseRenew`,
// `leaseRelease`, `check` or `resync`. The copy is loaded with `load` (CLI and API), the loader's `plan` and `sql` run on it, the H1 verifier's `verify-plan`,
// `verify-private-plan` and `verify-emitted` run on the REAL output of those commands (no fixture), the emitted batches are applied to the synthetic production under
// one-transaction-per-request semantics, a fresh copy is taken, the loader `verify` passes and a re-plan reports noop. Multi-statement atomicity is exercised on the
// stand-in only. NO production read or write, no R2, no network, no credentials: every row is synthetic. What this cannot prove is listed in
// docs/evidence/d1-migration/air-374-h1-rehearsal-2026-11-12.md.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {COPY_TABLES} from '../src/film-person-cutover-accepted.js';
import {renderSql} from '../scripts/d1-backfill.mjs';
import * as K from '../scripts/film-person-connector-run.mjs';
import * as L from '../scripts/film-person-prepared-loader.mjs';
import * as V from '../scripts/film-person-h1-verify.mjs';

const started=Date.now();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-h1-rehearsal-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const sha=text=>createHash('sha256').update(text).digest('hex');
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
const q=value=>value===null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
const AT='2026-11-12T09:00:00.000Z',LEASE='h1-load:20261112T090000Z',REF='cutover_accepted/v2:'+'a'.repeat(64);
const CONNECTOR_LEASE='connector:h1-rehearsal-1';
const stops=async(work,reason,label=reason)=>assert.rejects(async()=>work(),error=>error?.reason===reason,label);

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

const tableDigests=file=>{
 const out={};
 for(const {name} of rows(file,"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'connector_copy_%' ORDER BY name"))out[name]=sha(JSON.stringify(rows(file,'SELECT rowid AS "__rowid", * FROM '+name+' ORDER BY rowid')));
 return out;
};
const counts=file=>Object.fromEntries(Object.entries(L.TABLES).map(([name,table])=>[name,rows(file,'SELECT COUNT(*) AS n FROM '+table)[0].n]));
const none={ratedAdmission:0,retention:0,retirement:0};

// ================= 1. synthetic production: schema 21 from the repository migrations, a `prepared` marker over a verified baseline, synthetic rows only =================
const production=path.join(root,'production.sqlite');
sql(production,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=21).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
assert.deepEqual(rows(production,'SELECT version FROM schema_contract WHERE id = 1'),[{version:21}],'schema 21');
sql(production,`UPDATE film_person_baseline SET state='loading' WHERE id=1;UPDATE film_person_baseline SET state='verified',reference=${q(REF)} WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;`);
const world=makeWorld({admissions:708,retention:398,retirements:4,noise:true});
sql(production,world.script);
// rows in other copied tables: more than one page of canonical_revision at the page size the copy uses below, so the copy resumes inside a table
sql(production,"WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<250) INSERT INTO canonical_revision (kind,id,revision,updated_at) SELECT 'film','film:rev'||i,i,'2026-11-01T00:00:00.000Z' FROM n;");
assert.deepEqual(counts(production),none);
assert.equal(rows(production,'SELECT COUNT(*) AS n FROM projection_run')[0].n,0,'no projector lease row exists at snapshot time');
const sourceDir=path.join(root,'sources');fs.mkdirSync(sourceDir);
for(const [id,name] of Object.entries(L.SOURCE_FILES))fs.writeFileSync(path.join(sourceDir,name),world.bytes[id]);
const productionBefore=tableDigests(production),productionBytes=sha(fs.readFileSync(production));

// ================= 2. the fake connector: SELECT only, and the functions it runs =================
const ACCOUNT='0123456789abcdef0123456789abcdef';
const seen=[],ran=[];
const cloudflare={request:async({method,path:url,body})=>{
 assert.equal(method,'POST');assert.match(url,new RegExp('^/accounts/'+ACCOUNT+'/d1/database/[0-9a-f-]{36}/query$'));
 const statements=body.params?[renderSql(body.sql,body.params)]:body.sql.split(';\n');
 return {success:true,result:statements.map(text=>{
  seen.push(text);
  assert.match(text,/^\s*SELECT\s/i,'the connector stand-in refuses anything but a SELECT');
  assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH)\b/i.test(text.replace(/'(?:[^']|'')*'/g,"''")),'no write or DDL keyword: '+text.slice(0,60));
  return {success:true,results:rows(production,text),meta:{rows_written:0}};
 })};
}};
let fileNumber=0;
const execute=async(name,edit=value=>value)=>{
 assert.ok(['ddl','copy'].includes(name),'the rehearsal runs only ddl and copy: '+name);
 ran.push(name);
 const result=await new Function('cloudflare','accountId','return ('+edit(plan.functions[name])+')')(cloudflare,ACCOUNT)();
 const file=path.join(root,'result-'+(fileNumber++)+'.json');
 fs.writeFileSync(file,JSON.stringify(result));
 return {file,result};
};
const small=(text,budget=60000)=>{const edited=text.replace('BUDGET='+K.RESULT_BUDGET,'BUDGET='+budget).replace('PAGE_ROWS='+K.PAGE_ROWS,'PAGE_ROWS=100');assert.notEqual(edited,text);return edited;};
const cliConnector=args=>spawnSync(process.execPath,['scripts/film-person-connector-run.mjs',...args],{encoding:'utf8'});
const planDir=path.join(root,'connector-plan');
const planned=cliConnector(['plan','--out',planDir,'--lease-id',CONNECTOR_LEASE]);
assert.equal(planned.status,0,planned.stderr);
const planFile=path.join(planDir,'plan.json');
const plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
assert.equal(plan.copyTables.length,39);
{
 // the eight tables of the loader's STATE_STATEMENTS are all in the copy plan, and the two functions run here hold no write statement
 const tables=Object.values(L.STATE_STATEMENTS).map(text=>text.match(/\bFROM (\w+)/)[1]);
 assert.deepEqual(tables,['schema_contract','film_person_authority','film_person_baseline','film_external_id','film_redirect','film_rated_admission','film_retention','tmdb_retirement_decision']);
 for(const table of tables)assert.ok(plan.copyTables.includes(table),table+' is copied');
 for(const name of ['ddl','copy'])assert.ok(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(plan.functions[name].replace(/'(?:[^']|'')*'/g,"''").replace(/"[^"]*"/g,'""')),name+' carries no write statement');
 assert.deepEqual(Object.keys(plan.functions),['ddl','check','copy','resync','leaseAcquire','leaseRenew','leaseRelease'],'the plan holds the lease and resync functions; this run executes none of them');
}

// ================= 3. plan, ddl, copy, load WITHOUT lease and resync: a local copy of production =================
const runner=(args,input)=>sqliteSync(args,{input});
async function takeCopy(name,{viaCli=false,stopWhenDone=null,budget=60000}={}){
 const file=path.join(root,name+'.sqlite');
 const driver=K.sqliteDriver(file,{runner});
 const load=(input,useCli)=>{
  if(!useCli)return K.loadResult(driver,input,plan);
  const result=cliConnector(['load','--plan',planFile,'--copy',file,'--input',input]);
  assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
 };
 load((await execute('ddl')).file,viaCli);
 let cursor=null,calls=0,done=false;
 for(;;){
  const data=await execute('copy',text=>small(text,budget).replace('const CURSOR=null','const CURSOR='+JSON.stringify(cursor)));
  const out=load(data.file,viaCli&&calls===0);
  calls++;cursor=out.cursor;done=out.done;
  if(!cursor||(stopWhenDone&&K.copyState(driver).tables[stopWhenDone]?.done===true))break;
  assert.ok(calls<80,'the copy terminates');
 }
 return {file,driver,calls,done};
}
const first=await takeCopy('copy1',{viaCli:true});
assert.equal(first.done,true);assert.ok(first.calls>2,'the copy needed several connector calls: '+first.calls);
{
 const state=K.copyState(first.driver);
 assert.deepEqual(state.log.map(item=>item.kind),['ddl',...Array(first.calls).fill('data')],'the copy log holds a ddl file and data files only: no verify, no resync');
 assert.deepEqual(Object.keys(state.tables).sort(),[...COPY_TABLES].sort());
 assert.ok(COPY_TABLES.every(table=>state.tables[table].done===true));
 // every table of the copy plan equals production, row by row, rowids included
 const copied=tableDigests(first.file);
 for(const table of COPY_TABLES)assert.equal(copied[table],productionBefore[table],table+' equals production');
 assert.equal(rows(first.file,'SELECT COUNT(*) AS n FROM film_rated_admission')[0].n,0);
 assert.equal(rows(first.file,'SELECT COUNT(*) AS n FROM canonical_revision')[0].n,250);
 // the loader reads the same eight result sets from the copy and from production
 assert.deepEqual(await L.readLoadState(L.copyReadBinding(first.file)),await L.readLoadState(L.copyReadBinding(production)));
 // a second load of the same file is refused, through the CLI too
 const again=cliConnector(['load','--plan',planFile,'--copy',first.file,'--input',path.join(root,'result-1.json')]);
 assert.equal(again.status,1);assert.match(again.stderr,/STOP already_loaded/);
}
assert.ok(ran.every(name=>['ddl','copy'].includes(name))&&ran.includes('ddl')&&ran.includes('copy'));
assert.ok(seen.length>40&&seen.every(text=>/^\s*SELECT\s/i.test(text)),'every request the connector stand-in received was a SELECT: '+seen.length);
assert.deepEqual(tableDigests(production),productionBefore,'production unchanged by ddl and copy');
assert.equal(sha(fs.readFileSync(production)),productionBytes,'the production file is byte-identical after the copy');
assert.equal(rows(production,'SELECT COUNT(*) AS n FROM projection_run')[0].n,0,'no lease row was created');

// ================= 4. the loader `plan` accepts the copy, and the H1 verifier works on its REAL output =================
const noR2={R2_SNAPSHOT_ENDPOINT:'',R2_SNAPSHOT_ACCESS_KEY_ID:'',R2_SNAPSHOT_SECRET_ACCESS_KEY:''};
const loader=args=>spawnSync(process.execPath,['scripts/film-person-prepared-loader.mjs',...args],{encoding:'utf8',env:{...process.env,...noR2}});
const verifier=args=>spawnSync(process.execPath,['scripts/film-person-h1-verify.mjs',...args],{encoding:'utf8'});
const common=file=>['--copy',file,'--source-dir',sourceDir,'--at',AT,'--lease-id',LEASE];
const outDir=path.join(root,'plan-out');
const dry=loader(['plan',...common(first.file),'--out',outDir]);
assert.equal(dry.status,0,dry.stderr);
const shown=JSON.parse(dry.stdout);
assert.equal(shown.ok,true);assert.equal(shown.mode,'dry-run');assert.equal(shown.noop,false);assert.equal(shown.complete,true);
assert.deepEqual(L.CLASSES.map(name=>shown.classes[name].toLoad),[708,398,4]);
assert.deepEqual(L.CLASSES.map(name=>shown.classes[name].stored),[0,0,0]);
assert.equal(shown.batches,Math.ceil(708/40)+Math.ceil(398/40)+1);
// the plan from the copy is the plan from production, and a second copy gives the same digest
assert.equal(JSON.parse(loader(['plan',...common(production)]).stdout).digest,shown.digest,'plan from the copy = plan from production');
assert.equal(JSON.parse(loader(['plan',...common(first.file)]).stdout).digest,shown.digest,'deterministic');
const second=await takeCopy('copy1b');
assert.equal(JSON.parse(loader(['plan',...common(second.file)]).stdout).digest,shown.digest,'a second copy taken by the API path gives the same plan digest');
assert.equal(sha(fs.readFileSync(production)),productionBytes);
// verify-plan on the printed summary, verify-private-plan on the private file: the real round trip buildLoadPlan -> plan --out -> verify-private-plan
const summaryFile=path.join(root,'plan-summary.json'),privateFile=path.join(outDir,'plan.private.json');
fs.writeFileSync(summaryFile,dry.stdout);
const sources={verifiedFilms:sha(world.bytes.verifiedFilms),viewIndex:sha(world.bytes.viewIndex),retirements:sha(world.bytes.retirements)};
const pins=['--counts','708,398,4','--reference',REF,'--at',AT,'--verified-films-sha',sources.verifiedFilms,'--view-index-sha',sources.viewIndex,'--retirements-sha',sources.retirements];
const verdict=(result)=>({status:result.status,out:JSON.parse(result.stdout)});
{
 const diagnostic=verdict(verifier(['verify-plan',summaryFile,'--diagnostic',...pins]));
 assert.notEqual(diagnostic.out.ok,true,'a diagnostic output never passes');
 const pass=verdict(verifier(['verify-plan',summaryFile,'--plan-digest',shown.digest,...pins]));
 assert.equal(pass.status,0,JSON.stringify(pass.out));assert.equal(pass.out.ok,true);assert.deepEqual(pass.out.refusals,[]);
 const priv=verdict(verifier(['verify-private-plan',privateFile,'--plan-digest',shown.digest,'--lease-id',LEASE,...pins]));
 assert.equal(priv.status,0,JSON.stringify(priv.out));assert.equal(priv.out.ok,true);assert.deepEqual(priv.out.refusals,[]);
 const text=JSON.stringify(priv.out);
 for(const needle of ['film:','Title 1','"lb0"',LEASE,'INSERT'])assert.ok(!text.includes(needle),'the private verdict holds no '+needle);
 // it is sensitive to each pin, on the real file
 const refused=(args,reason,label)=>{const result=verdict(verifier(args));assert.equal(result.status,1,label);assert.ok(result.out.refusals.some(item=>item===reason||item.startsWith(reason+':')),label+': '+JSON.stringify(result.out.refusals));};
 refused(['verify-private-plan',privateFile,'--plan-digest',shown.digest,'--lease-id','h1-load:OTHER0000',...pins],'lease_id_mismatch','another lease id');
 refused(['verify-private-plan',privateFile,'--plan-digest',shown.digest,...pins],'lease_id_missing','no lease id');
 refused(['verify-private-plan',privateFile,'--plan-digest',shown.digest,'--lease-id',LEASE,'--window-owner','window-other-01',...pins],'window_owner_mismatch','a window owner the plan does not carry');
 refused(['verify-private-plan',privateFile,'--plan-digest','0'.repeat(64),'--lease-id',LEASE,...pins],'plan_digest_mismatch','another digest');
 refused(['verify-private-plan',privateFile,'--plan-digest',shown.digest,'--lease-id',LEASE,...pins.map(item=>item==='708,398,4'?'708,398,5':item)],'class_planned_not_pinned','another count');
 refused(['verify-private-plan',privateFile,'--plan-digest',shown.digest,'--lease-id',LEASE,...pins.map(item=>item===sources.viewIndex?'f'.repeat(64):item)],'source_sha_mismatch','another source digest');
 refused(['verify-plan',privateFile,'--plan-digest',shown.digest,...pins],'private_plan_pasted','the private plan is not a summary');
 const edited=JSON.parse(fs.readFileSync(privateFile,'utf8'));edited.batchStatements[0].statements[0].params[0]='film:tmdb:1';
 const editedFile=path.join(root,'plan-edited.json');fs.writeFileSync(editedFile,JSON.stringify(edited));
 refused(['verify-private-plan',editedFile,'--plan-digest',shown.digest,'--lease-id',LEASE,...pins],'batch_digest_mismatch','a statement edited inside the private plan');
}
// the emitted batches of `sql --apply` (real output) and the batch-set digest the GO names
const sqlOut=path.join(root,'sql-out');
const emitted=loader(['sql',...common(first.file),'--apply','--plan-digest',shown.digest,'--out',sqlOut]);
assert.equal(emitted.status,0,emitted.stderr);
const emittedJson=JSON.parse(emitted.stdout);
const emittedVerdict=V.verifyEmitted(emittedJson,{planDigest:shown.digest,counts:[708,398,4]});
assert.equal(emittedVerdict.ok,true,JSON.stringify(emittedVerdict));
const batches=fs.readdirSync(sqlOut).sort().map(name=>JSON.parse(fs.readFileSync(path.join(sqlOut,name),'utf8')));
assert.equal(batches.length,shown.batches);assert.equal(batches.reduce((sum,batch)=>sum+batch.rows,0),1110);
assert.deepEqual(counts(production),none,'plan and sql write nothing');

// ================= 5. multi-statement atomicity on the stand-in (the connector request is modelled as one transaction) =================
// ONE REQUEST = ONE TRANSACTION: the stand-in of the connector's multi-statement `sql` body. A failing statement ends the request and rolls the transaction back. The per-statement
// `changes` come from sqlite's changes() after each statement, in the response shape `verify-batch` reads. This is the semantics the runbook ASSUMES of D1; it is a model, not D1.
const statementsOf=batch=>batch.sql.split(';\n').map(text=>text.replace(/;\s*$/,'')).filter(Boolean);
const transaction=(file,statements)=>{
 const result=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+statements.map(text=>text+';\nSELECT changes() AS c;').join('\n')+'\nCOMMIT;'});
 if(result.status!==0)throw new Error('D1_ERROR: '+result.stderr.trim());
 const changes=[...result.stdout.matchAll(/"c":\s*(\d+)/g)].map(match=>Number(match[1]));
 assert.equal(changes.length,statements.length);
 return changes.map(value=>({success:true,meta:{changes:value}}));
};
// A connector that is NOT transactional, for contrast: each statement commits alone and the request stops at the first error.
const autocommit=(file,statements)=>statements.map(text=>{
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';'});
 if(result.status!==0)throw new Error('D1_ERROR: '+result.stderr.trim());
 return {success:true};
});
// production gets its lease row now: the load window of the second GO (this is what the guard of every row asserts)
sql(production,`INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES ('enrichment',${q(LEASE)},'2099-01-01T00:00:00.000Z','2026-11-12T08:59:00.000Z');`);
const preload=path.join(root,'preload.sqlite');fs.copyFileSync(production,preload);
const preloadDigests=tableDigests(preload);
const sandbox=(label,mutate=()=>{})=>{const file=path.join(root,'sandbox-'+label+'.sqlite');fs.copyFileSync(preload,file);mutate(file);return file;};
const swapLease=text=>{const edited=text.split(q(LEASE)).join("'h1-load:OTHER0000'");assert.notEqual(edited,text);return edited;};
const statements0=statementsOf(batches[0]);
assert.equal(statements0.length,batches[0].rows);assert.equal(batches[0].class,'ratedAdmission');
const untouched=(file,label)=>{assert.deepEqual(counts(file),none,label+': no row of the batch is stored');assert.deepEqual(tableDigests(file),preloadDigests,label+': every table equals the snapshot');};
const fails=(work,label)=>assert.throws(work,/D1_ERROR/,label);
{
 // a statement whose guard is false in the MIDDLE and at the END of the batch: the earlier rows roll back too
 for(const [label,index] of [['middle',17],['last',statements0.length-1],['first',0]]){
  const file=sandbox('guard-'+label);
  const edited=statements0.map((text,at)=>at===index?swapLease(text):text);
  fails(()=>transaction(file,edited),'guard false at '+label);
  untouched(file,'guard false at '+label);
 }
 // the contrast: a connector that commits per statement leaves rows 0..16 behind, and the count is then not a multiple of the acknowledged batches
 const partial=sandbox('autocommit');
 fails(()=>autocommit(partial,statements0.map((text,at)=>at===17?swapLease(text):text)),'non-transactional');
 assert.deepEqual(counts(partial),{ratedAdmission:17,retention:0,retirement:0},'a non-transactional connector would leave 17 rows');
 assert.notEqual(17%L.BATCH_ROWS,0,'which is visible against the acknowledged batches (0 acknowledged, 17 stored)');
 // a REAL constraint violation in the middle: the row stands in the table with other content (a plan older than the state), so the INSERT meets a primary-key conflict
 const stale=sandbox('conflict',file=>{
  transaction(file,[statements0[20]]);
  sql(file,"UPDATE film_rated_admission SET title='Other content';");
  assert.deepEqual(counts(file),{ratedAdmission:1,retention:0,retirement:0});
 });
 const staleDigests=tableDigests(stale);
 fails(()=>transaction(stale,statements0),'primary key conflict at statement 20');
 assert.deepEqual(counts(stale),{ratedAdmission:1,retention:0,retirement:0},'the 20 rows before the conflict are rolled back');
 assert.deepEqual(tableDigests(stale),staleDigests,'nothing else moved');
 // a moved marker, an expired lease and a moved baseline: every row of the batch fails its guard, nothing is written
 for(const [label,change] of [['marker',"UPDATE film_person_authority SET generation=2 WHERE id=1;"],['lease',"UPDATE projection_run SET lease_until='2020-01-01T00:00:00.000Z';"],['baseline',"UPDATE film_person_baseline SET state='loading' WHERE id=1;"]]){
  // the marker and baseline triggers guard the legitimate writers; a stand-in for another writer's committed move drops them in the sandbox only
  const file=sandbox('moved-'+label,target=>{for(const trigger of rows(target,"SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'film_person_%'"))sql(target,'DROP TRIGGER '+trigger.name+';');sql(target,change);});
  const digests=tableDigests(file);
  fails(()=>transaction(file,statements0),'moved '+label);
  assert.deepEqual(counts(file),none);assert.deepEqual(tableDigests(file),digests,label+': nothing written');
 }
 // a failing batch after an acknowledged one: only whole batches stand (the partial apply the runbook allows is between batches)
 const between=sandbox('between');
 const ok=transaction(between,statements0);
 assert.deepEqual(V.verifyBatch(ok,{rows:batches[0].rows}).refusals,[],'verify-batch accepts the stand-in response of an acknowledged batch');
 const second=statementsOf(batches[1]);
 fails(()=>transaction(between,second.map((text,at)=>at===5?swapLease(text):text)),'failure in batch 2');
 assert.deepEqual(counts(between),{ratedAdmission:batches[0].rows,retention:0,retirement:0},'the count is exactly the rows of the acknowledged batches');
 // the response shapes verify-batch refuses
 assert.ok(V.verifyBatch(ok.map((item,at)=>at===3?{success:false}:item),{rows:batches[0].rows}).refusals.includes('statement_failed:3'));
 assert.ok(V.verifyBatch(ok.slice(1),{rows:batches[0].rows}).refusals.some(item=>item.startsWith('result_count')));
}

// ================= 6. the simulated load of all 29 batches, then a FRESH copy, the loader `verify` and a no-op `plan` =================
{
 const responses=batches.map(batch=>{const response=transaction(production,statementsOf(batch));assert.deepEqual(V.verifyBatch(response,{rows:batch.rows}).refusals,[],'batch '+batch.index);return response;});
 assert.equal(responses.length,29);
 assert.deepEqual(counts(production),{ratedAdmission:708,retention:398,retirement:4});
 // replaying every batch changes nothing (changes 0 per statement: verify-batch calls that a STOP, as the runbook says)
 const settled=tableDigests(production);
 const replay=transaction(production,statementsOf(batches[0]));
 assert.ok(replay.every(item=>item.meta.changes===0),'a replayed statement inserts nothing');
 assert.ok(V.verifyBatch(replay,{rows:batches[0].rows}).refusals.includes('statement_no_change:0'));
 assert.deepEqual(tableDigests(production),settled);
 for(const table of Object.keys(settled))if(!Object.values(L.TABLES).includes(table))assert.equal(settled[table],preloadDigests[table],table+' untouched by the load');
}
const fresh=await takeCopy('copy2',{viaCli:true});
assert.equal(fresh.done,true);
{
 const out=path.join(root,'verify-out');
 const result=loader(['verify',...common(fresh.file),'--expect-generation','1','--expect-reference',REF,'--out',out]);
 assert.equal(result.status,0,result.stderr);
 const readback=JSON.parse(result.stdout);
 assert.equal(readback.ledger.ok,true);assert.deepEqual(readback.ledger.reasons,[]);
 for(const [name,count] of [['ratedAdmission',708],['retention',398],['retirement',4]]){const item=readback.ledger.classes[name];assert.deepEqual([item.stored,item.missing,item.different,item.unexpected],[count,0,0,0],name);}
 assert.ok(fs.existsSync(path.join(out,'receipt.json'))&&fs.existsSync(path.join(out,'readback.json')));
 assert.equal(loader(['verify',...common(fresh.file),'--expect-generation','2','--expect-reference',REF]).status,2,'a pinned generation that is not the copy\'s is refused');
 const replan=JSON.parse(loader(['plan',...common(fresh.file)]).stdout);
 assert.equal(replan.ok,true);assert.equal(replan.noop,true,'a re-plan on the fresh copy reports noop');assert.equal(replan.batches,0);
 // the verifier refuses to treat that no-op plan as a load plan
 const noopFile=path.join(root,'noop.json');fs.writeFileSync(noopFile,JSON.stringify(replan));
 assert.ok(verdict(verifier(['verify-plan',noopFile,'--plan-digest',replan.digest,...pins])).out.refusals.includes('plan_noop'));
 // the old plan's digest is no longer accepted by `sql` on the fresh copy
 const stale=loader(['sql',...common(fresh.file),'--apply','--plan-digest',shown.digest,'--out',path.join(root,'sql-stale')]);
 assert.equal(stale.status,1);assert.match(stale.stderr,/plan_digest_mismatch/);
}

// ================= 7. an UNFINISHED copy (the copy log marks a table done; the loader's reader refuses a copy whose eight state tables are not all done) =================
// The loader's `copyReadBinding` consults `connector_copy_table` and refuses `copy_incomplete` unless the eight tables behind its state statements are done (see
// docs/evidence/d1-migration/air-374-h1-copy-incomplete-2026-11-12.md). Whatever the reader does, these must hold: a copy cut inside the identity tables and a post-load copy cut before
// film_rated_admission are both refused by `plan` and `verify`, never reported as a no-op, never passing the readback, and the refusal names no row.
{
 const refuse=(file,detail)=>{
  const planned=loader(['plan',...common(file)]);
  assert.equal(planned.status,1);assert.equal(planned.stderr.trim(),'STOP copy_incomplete: '+detail);assert.equal(planned.stdout,'');
  const verified=loader(['verify',...common(file),'--expect-generation','1','--expect-reference',REF]);
  assert.equal(verified.status,1,'a cut copy never passes the readback');assert.equal(verified.stderr.trim(),'STOP copy_incomplete: '+detail);
 };
 const early=await takeCopy('partial-early',{stopWhenDone:'owner_review_entry',budget:15000});
 assert.equal(early.done,false);
 refuse(early.file,'identity');
 const late=await takeCopy('partial-late',{stopWhenDone:'tmdb_retirement_decision',budget:15000});
 assert.equal(late.done,false);
 const state=K.copyState(late.driver);
 assert.equal(state.tables.film_rated_admission?.done??false,false,'precondition: the cut falls before film_rated_admission');
 assert.equal(state.tables.film_external_id.done,true);
 refuse(late.file,'ratedAdmission');
 // the finished copy is still accepted
 assert.equal(loader(['plan',...common(first.file)]).status,0);
}

console.log('film-person-h1-rehearsal: ok ('+(Date.now()-started)+' ms)');
