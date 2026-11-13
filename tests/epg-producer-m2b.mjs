// AIR-374 M2b step 0: the offline tooling of the dry run on a local copy (scripts/epg-producer-m2b.mjs), on the sqlite3-CLI D1 stand-in. Covered: the emitted statements are read-only keyset pages over exactly the planned columns, the plan covers every table
// the M2 harness really reads, the pasted pages load into an identical copy that the harness plans like the original, every refusal of the results file, the copy verification, the run leaves the copy byte-identical and its report holds counts and timings
// only, and the script imports no apply function or writer. No Worker, R2, D1 or Cloudflare access. M2B_SCRIPT points the file at a mutant copy; the mutation runner (tests/epg-producer-m2b-mutation.mjs) calls check() on every mutant in one process.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {applyEpgUnits,planEpgUnits} from '../src/canonical-epg-producer.js';
import {dryRun} from '../scripts/epg-producer-dry-run.mjs';
import {assertReadOnly} from '../scripts/schema-preflight.mjs';

// The functions under test are bound by check(): the mutation runner calls it in ONE process for every mutant, so the module graph is loaded once (a process per mutant cost about a second of CPU each).
let CAPS,COPY_PLAN,emitSql,verifyResults,loadCopy,verifyCopy,inputsFromCopy,runOnCopy;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-m2b-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text,json=false)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);return r.stdout;};
const rows=(file,sql)=>{const out=sqlite(file,sql+';',true).trim();return out?JSON.parse(out):[];};
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const template=path.join(root,'template.sqlite'); // read-only after it is built: shared by every check()
// Every check() works in a FRESH directory of its own (set at its start and removed at its end), so a second call in the same process, as the mutation runner makes, never meets a file the first one left behind.
let work=root;
sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const sha=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const T='2026-11-13T10:00:00.000Z';
const ID=k=>'film:tmdb:'+k;
const META=()=>({schemaVersion:1,year:1999,runtime:136,synopsis:'S',poster:'/p.jpg',url:'https://example.test/m',genres:['g'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T});
const facts=title=>({film:{contractVersion:1,originalTitle:title,source:'tmdb'},metadata:META(),sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true});
const steady=()=>{let t=0;return ()=>(t+=2);};
let n=0;
// The "production" stand-in: the real writer stored five Films, plus Person and credit rows.
// The seeded file does not depend on the tool under test (the writer of src/ stores the rows), so it is built ONCE per process and copied per use: the mutation runner calls check() for every mutant.
let seededFile=null;
async function production(){
 if(seededFile){const copy=path.join(work,'prod-'+(n++)+'.sqlite');fs.copyFileSync(seededFile,copy);return copy;}
 const file=path.join(root,'seeded.sqlite');fs.copyFileSync(template,file);
 for(const s of ["UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;","UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1","INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+T+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','"+T+"');"])sqlite(file,s);
 const list=[1,2,3,4,5].map(k=>({id:ID(k),facts:{...facts('Title '+k),watchlist:k!==5}}));
 const applied=await applyEpgUnits({DB:d1Standin(file)},{plan:planEpgUnits({runId:'seed',at:T,films:list}),now:()=>T});
 assert.equal(applied.counts.applied,5);
 sqlite(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb:1','role:1',1,'"+T+"'),('person:tmdb:2','role:2',1,'"+T+"'),('person:tmdb:3','role:3',1,'"+T+"');INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('"+ID(1)+"','person:tmdb:1','director',0),('"+ID(1)+"','person:tmdb:2','actor',1),('"+ID(5)+"','person:tmdb:3','actor',0);");
 seededFile=file;
 return production();
}
// A reader of the emitted statements: a count statement and keyset pages of `pageRows` (small here so a table needs several pages), recorded with their connector metrics, as an authorized operator would paste them.
function read(file,pageRows=2){
 const tables={};
 for(const item of COPY_PLAN){
  const count=rows(file,emitSql().statements.find(statement=>statement.id===item.table+'#count').sql)[0];
  const statement=emitSql().statements.find(statement=>statement.id===item.table+'#page');
  const pages=[];let last=0;
  for(;;){
   const page=rows(file,statement.sql.replace(/\? ORDER BY rowid LIMIT \?/,last+' ORDER BY rowid LIMIT '+pageRows));
   const after=last;
   if(page.length)last=page[page.length-1]._rid;
   pages.push({after,last,rows:page,meta:{rows_read:page.length,duration:3}});
   if(page.length<pageRows)break;
  }
  tables[item.table]={count:{n:count.n,maxRowid:count.max_rowid,meta:{rows_read:count.n,duration:4}},pages};
 }
 return {_statementsDigest:emitSql().statementsDigest,_capturedAt:T,_pageRows:pageRows,tables};
}
const dump=file=>JSON.stringify(COPY_PLAN.map(item=>[item.table,rows(file,'SELECT '+item.columns.join(',')+' FROM '+item.table+' ORDER BY '+item.columns.join(','))]));

export async function check(M2B,scriptPath='scripts/epg-producer-m2b.mjs'){
({CAPS,COPY_PLAN,emitSql,verifyResults,loadCopy,verifyCopy,inputsFromCopy,runOnCopy}=M2B);
// The verifiers must RETURN a verdict for any input, never throw: a thrown error is an assertion failure here, so a mutant that makes one throw is killed by the assertion about the rule, not by the crash.
const guard=fn=>(...args)=>{try{return fn(...args);}catch(error){assert.fail(fn.name+' threw instead of returning a verdict: '+String(error?.message).split('\n')[0].slice(0,100));}};
const guardAsync=fn=>async(...args)=>{try{return await fn(...args);}catch(error){assert.fail(fn.name+' threw instead of returning a verdict: '+String(error?.message).split('\n')[0].slice(0,100));}};
verifyResults=guard(verifyResults);loadCopy=guard(loadCopy);verifyCopy=guard(verifyCopy);runOnCopy=guardAsync(runOnCopy);
work=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-m2b-work-'));
try{
// 1. The emitted statements.
{
 const plan=emitSql();
 assert.equal(plan.statements.length,COPY_PLAN.length*2,'a count statement and a page statement per table');
 for(const statement of plan.statements){
  assertReadOnly(statement.sql);
  if(statement.kind==='page'){
   assert.match(statement.sql,/^SELECT rowid AS _rid, [a-z0-9_, ]+ FROM [a-z_]+ WHERE rowid > \? ORDER BY rowid LIMIT \?$/);
   assert.equal(statement.sql.split('?').length-1,2);
   assert.ok(statement.pageRows<=CAPS.pageRows&&statement.maxRows<=CAPS.rowsReadPerStatement);
  }else assert.match(statement.sql,/^SELECT COUNT\(\*\) AS n, MAX\(rowid\) AS max_rowid FROM [a-z_]+$/);
 }
 assert.equal(emitSql().statementsDigest,plan.statementsDigest,'the digest is stable');
 assert.ok(plan.protocol.length===3&&/ONE statement per request/.test(plan.protocol[0])&&/cannot prevent a read/.test(plan.protocol[2]),'the operator protocol is part of the output');
 // the planned columns are exactly the columns of the migrated table, in order
 for(const item of COPY_PLAN)assert.deepEqual(rows(template,'PRAGMA table_info('+item.table+')').map(column=>column.name),item.columns,item.table);
 assert.ok(CAPS.rowsReadTotal<=1500000&&CAPS.rowsReadPerStatement<=300000,'the caps are not above the E6 proposals');
}

// The "production" file and the pasted pages of it, built once for the checks below.
const prod=await production();
const results=read(prod);

// 5a. Every refusal of the results file (pure checks: they run first, so a mutant of a verifier rule fails early and cheaply).
{
 const clone=()=>JSON.parse(JSON.stringify(results));
 const refused=(mutate,expected,source=results)=>{const copy=JSON.parse(JSON.stringify(source));mutate(copy);const verdict=verifyResults(copy);assert.equal(verdict.ok,false,expected);assert.ok(verdict.refusals.some(code=>code.startsWith(expected)),expected+' in '+verdict.refusals);};
 refused(copy=>{copy._statementsDigest='0'.repeat(64);},'statements_digest_mismatch');
 refused(copy=>{copy._capturedAt='yesterday';},'captured_at_invalid');
 refused(copy=>{delete copy._pageRows;},'page_rows_invalid');
 refused(copy=>{copy._pageRows=CAPS.pageRows+1;},'page_rows_invalid');
 refused(copy=>{delete copy.tables;},'tables_missing');
 refused(copy=>{copy.tables.secret_table={};},'table_not_in_plan');
 refused(copy=>{delete copy.tables.person;},'table_missing');
 // the page chain: a dropped middle page, a dropped terminal page, a repeated page, reordered pages, an unterminated chain
 refused(copy=>{copy.tables.film.pages.splice(1,1);},'page_chain_broken');
 refused(copy=>{copy.tables.film.pages.pop();},'page_unterminated');
 refused(copy=>{copy.tables.film.pages.splice(1,0,copy.tables.film.pages[1]);},'page_chain_broken');
 refused(copy=>{const [first,second]=copy.tables.film.pages;copy.tables.film.pages[0]=second;copy.tables.film.pages[1]=first;},'page_chain_broken');
 refused(copy=>{copy.tables.film.pages[0].rows.pop();},'page_not_full');
 refused(copy=>{copy.tables.film.pages=[];},'pages_missing');
 // a populated table emptied: the recorded count and maximum no longer add up (a populated credit table must not pass as empty)
 refused(copy=>{copy.tables.film_person_credit.pages=[{after:0,last:0,rows:[],meta:{rows_read:0,duration:1}}];},'count_mismatch');
 refused(copy=>{copy.tables.film_person_credit.pages[copy.tables.film_person_credit.pages.length-1].rows.pop();copy.tables.film_person_credit.pages[copy.tables.film_person_credit.pages.length-1].last=copy.tables.film_person_credit.pages[copy.tables.film_person_credit.pages.length-1].rows.at(-1)?._rid??copy.tables.film_person_credit.pages[copy.tables.film_person_credit.pages.length-1].after;},'count_mismatch');
 // the recorded maximum rowid must be where the chain ends
 refused(copy=>{copy.tables.film.count.maxRowid+=1;},'max_rowid_mismatch');
 refused(copy=>{copy.tables.film.count={n:5,maxRowid:null,meta:{rows_read:5,duration:1}};},'count_invalid');
 refused(copy=>{copy.tables.person.count.n=-1;},'count_invalid');
 // rows
 refused(copy=>{copy.tables.film.pages[0].rows[0].extra='x';},'columns_mismatch');
 refused(copy=>{delete copy.tables.film.pages[0].rows[0].id;},'columns_mismatch');
 refused(copy=>{copy.tables.film.pages[0].rows[0].original_title={a:1};},'value_not_scalar');
 refused(copy=>{copy.tables.film.pages[0].rows[0]=5;},'row_not_object');
 refused(copy=>{copy.tables.film.pages[0].rows[1]._rid=copy.tables.film.pages[0].rows[0]._rid;},'rowid_order');
 refused(copy=>{copy.tables.film.pages[0].last+=1;},'page_last_mismatch');
 // the connector metrics: missing, over a per-statement cap, over a total cap (the caps are a parameter so the test needs no million rows)
 refused(copy=>{delete copy.tables.film.pages[0].meta;},'meta_missing');
 refused(copy=>{delete copy.tables.film.count.meta;},'meta_missing');
 refused(copy=>{copy.tables.film.pages[0].meta={rows_read:'many',duration:1};},'meta_missing');
 refused(copy=>{copy.tables.film.pages[0].meta.rows_read=CAPS.rowsReadPerStatement+1;},'meta_over_cap');
 refused(copy=>{copy.tables.film.pages[0].meta.duration=CAPS.msPerStatement+1;},'meta_over_cap');
 {
  const tight=verifyResults(clone(),{...CAPS,rowsReadPerStatement:4});
  assert.equal(tight.ok,false);
  assert.ok(tight.refusals.includes('rows_over_cap:film')&&!tight.refusals.includes('rows_over_cap:person'),'five Films are over a cap of four, three Persons are not');
  const total=verifyResults(clone(),{...CAPS,rowsReadTotal:10});
  assert.ok(!total.ok&&total.refusals.includes('rows_total_over_cap')&&total.refusals.includes('meta_total_rows_read_over_cap'));
  const slow=verifyResults(clone(),{...CAPS,msTotal:10});
  assert.ok(!slow.ok&&slow.refusals.includes('meta_total_duration_over_cap'));
  assert.equal(verifyResults(clone(),CAPS).ok,true);
 }
 // a table that is an exact multiple of the page size ends with an EMPTY short page; a full last page with rows after it is unterminated
 {
  const even=read(prod,5);
  assert.equal(even.tables.film.pages.length,2,'five Films at five a page: one full page and the empty terminal page');
  assert.equal(verifyResults(even).ok,true);
  // the recorded count and maximum rowid prove the end, so the empty terminal page is redundant; a full last page with rows MISSING behind it is not
  const noEmpty=JSON.parse(JSON.stringify(even));noEmpty.tables.film.pages.pop();
  assert.equal(verifyResults(noEmpty).ok,true);
  refused(copy=>{copy.tables.film.count.n=6;copy.tables.film.count.maxRowid+=1;},'page_unterminated',noEmpty);
  const one=read(prod,100);
  assert.deepEqual([one.tables.film.pages.length,verifyResults(one).ok],[1,true],'one short page');
  refused(copy=>{copy._pageRows=2;},'page_over_size',one);
 }
}

// 2. The plan covers every table the harness really reads (a new read breaks this test until the plan names it).
{
 const file=await production();
 const seen=new Set();
 const db=d1Standin(file,{onQuery:async text=>{for(const match of text.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/gi))seen.add(match[1]);}});
 await dryRun({env:{DB:db},at:T,runId:'probe',films:[{id:ID(1),facts:facts('Title 1')},{id:ID(6),facts:facts('New')}],departed:[ID(9),ID(1)],personRows:[{id:'person:tmdb:1',roleId:'role:1',contractVersion:1}],credits:[{filmId:ID(1),credits:[{personId:'person:tmdb:1',role:'director'}]}],clock:steady()});
 const planned=new Set(COPY_PLAN.map(item=>item.table));
 assert.deepEqual([...seen].filter(table=>!planned.has(table)),[],'the harness reads a table the copy plan does not carry');
}

// 3. Round trip: statements run against the "production" file, pages pasted, a copy loaded; the copy is identical on the planned tables and the harness plans it like the original.
{
 assert.ok(results.tables.film.pages.length===3&&results.tables.film.count.n===5&&results.tables.person.count.n===3&&results.tables.film_person_credit.count.n===3,'five Films in three pages of two');
 const verdict=verifyResults(results);
 assert.deepEqual([verdict.ok,verdict.refusals],[true,[]]);
 const out=path.join(work,'copy-1.sqlite');
 const loaded=loadCopy(results,out);
 assert.equal(loaded.ok,true);assert.equal(loaded.counts.film,5);
 assert.equal(dump(out),dump(prod),'the planned tables are row-for-row identical');
 assert.deepEqual([verifyCopy(out).ok,verifyCopy(out).representative,verifyCopy(out).counts.foreign_key_violations],[true,true,0]);
 // no output is overwritten
 assert.deepEqual(loadCopy(results,out),{ok:false,refusals:['output_exists']});
 const before=sha(out);
 const run=await runOnCopy(out,{departed:2,at:T,clock:steady()});
 assert.equal(run.copyUnchanged,true);
 assert.equal(sha(out),before,'the copy is byte-identical after the run');
 assert.equal(run.ok,true);assert.equal(run.representative,true);
 assert.equal(run.report.writes,0);
 assert.deepEqual(run.volume,{films:4,departed:1,creditFilms:1,personRows:2,personStateUnits:'unmeasured'},'the observed Films are the 4 watchlist members; Film 5 is the only Film that left it');
 assert.deepEqual(run.report.byKind.film_facts,{units:5,changed:0,noop:5,absent:0,refused:0,failed:0},'the stored rows replay as no-ops; a release of a Film already off the watchlist is a no-op');
 assert.equal(run.report.byKind.person_mutation.units,2);
 assert.equal(run.report.changed,0);
 // the report holds counts and timings only
 const text=JSON.stringify(run);
 for(const needle of ['film:','person:','tmdb','Title','https://','role:'])assert.ok(!text.includes(needle),'the report names '+needle);
 // the copy agrees with the original: the same harness on the original file gives the same counts
 const direct=await dryRun({env:{DB:d1Standin(prod)},at:T,runId:'m2b',...inputsFromCopy(prod,{departed:2}),clock:steady()});
 const viaCopy=await dryRun({env:{DB:d1Standin(out)},at:T,runId:'m2b',...inputsFromCopy(out,{departed:2}),clock:steady()});
 assert.deepEqual(viaCopy,direct,'a copy gives the report of the original');
}

// 4. The inputs: the watchlist members are the observed Films, a deterministic sample of the Films that left it, the credited Persons.
{
 const out=path.join(work,'copy-1.sqlite');
 const ids=list=>list.map(item=>item.id);
 assert.deepEqual(ids(inputsFromCopy(out).films),[ID(1),ID(2),ID(3),ID(4)],'the observed Films are the watchlist members, not every stored Film');
 assert.deepEqual(ids(inputsFromCopy(out,{allFilms:true}).films),[1,2,3,4,5].map(ID),'allFilms observes every stored Film');
 assert.deepEqual(inputsFromCopy(out,{departed:2}).departed,[ID(5)],'only a Film that is off the watchlist and not observed; never more than there are');
 assert.deepEqual(inputsFromCopy(out,{departed:2}).departed,inputsFromCopy(out,{departed:2}).departed,'deterministic');
 assert.equal(inputsFromCopy(out,{departed:0}).departed.length,0);
 assert.equal(inputsFromCopy(out,{allFilms:true,departed:2}).departed.length,0,'every Film is observed: no departed sample');
 assert.deepEqual(ids(inputsFromCopy(out,{maxFilms:2}).films),[ID(1),ID(2)],'the Film bound keeps the first members by id');
 const inputs=inputsFromCopy(out);
 assert.deepEqual([inputs.credits.length,inputs.personRows.map(row=>row.id)],[1,['person:tmdb:1','person:tmdb:2']],'the Persons credited from the observed Films only (Person 3 is credited from Film 5, which is not observed)');
 assert.deepEqual([inputsFromCopy(out,{allFilms:true}).credits.length,inputsFromCopy(out,{allFilms:true}).personRows.length],[2,3]);
 assert.equal(inputsFromCopy(out,{maxFilms:0}).personRows.length,2,'maxFilms 0 means no bound');
 assert.deepEqual(inputsFromCopy(out,{maxFilms:2,departed:9}).departed,[ID(5)],'unobserved watchlist members (3 and 4) are not departed Films');
 assert.equal(inputsFromCopy(out,{allFilms:true}).films.find(item=>item.id===ID(5)).facts.watchlist,false,'a Film off the watchlist is not a member');
 const first=inputs.films.find(item=>item.id===ID(1)).facts;
 assert.deepEqual([first.film.originalTitle,first.film.source,first.watchlist,first.metadata.genres,first.sync.peopleNamesVersion],['Title 1','tmdb',true,['g'],2]);
}

// 5b. Every refusal of the copy.
{
 const clone=()=>JSON.parse(JSON.stringify(results));
 // a refused file is never loaded
 const bad=clone();bad._statementsDigest='1'.repeat(64);
 const target=path.join(work,'never.sqlite');
 assert.deepEqual(loadCopy(bad,target),{ok:false,refusals:['statements_digest_mismatch']});
 assert.equal(fs.existsSync(target),false);
 // the copy verifier: wrong schema version, an unreadable file
 const old=path.join(work,'old.sqlite');sqlite(old,chain.slice(0,-1).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 assert.ok(verifyCopy(old).refusals.includes('schema_version:20'));
 assert.ok((await runOnCopy(old)).refusals.includes('schema_version:20'),'a run is refused on a wrong copy');
 const missing=path.join(work,'missing.sqlite');
 assert.deepEqual(verifyCopy(missing).refusals,['copy_unreadable']);
 // a copy without its manifest, or truncated after the load, is refused (the credit table is the one a silent loss would understate)
 const plain=path.join(work,'plain.sqlite');fs.copyFileSync(template,plain);
 assert.ok(verifyCopy(plain).refusals.includes('manifest_missing'));
 const cut=path.join(work,'cut.sqlite');loadCopy(results,cut);
 assert.equal(verifyCopy(cut).ok,true);
 sqlite(cut,'DELETE FROM film_person_credit');
 assert.deepEqual([verifyCopy(cut).ok,verifyCopy(cut).refusals],[false,['manifest_mismatch:film_person_credit']]);
 assert.deepEqual((await runOnCopy(cut)).refusals,['manifest_mismatch:film_person_credit'],'a truncated copy never yields a unit-volume report');
 // a copy with a foreign-key violation is refused; only on request it runs, and then it says it is not representative and not a D-C input
 const broken=path.join(work,'broken.sqlite');loadCopy(results,broken);
 sqlite(broken,'PRAGMA foreign_keys=OFF;DELETE FROM film WHERE id = \''+ID(1)+'\'');
 {
  sqlite(broken,'PRAGMA foreign_keys=OFF;UPDATE '+'m2b_copy_manifest SET row_count = row_count - 1 WHERE table_name = \'film\'');
  const refusedCopy=verifyCopy(broken);
  assert.equal(refusedCopy.ok,false);
  assert.ok(refusedCopy.refusals.some(code=>code.startsWith('foreign_key_violations:')),refusedCopy.refusals.join(','));
  const refusedRun=await runOnCopy(broken);
  assert.equal(refusedRun.ok,false);
  const allowed=await runOnCopy(broken,{allowInconsistent:true,at:T,clock:steady()});
  assert.deepEqual([allowed.ok,allowed.representative,allowed.notADCInput],[true,false,true]);
  assert.ok(allowed.nonrepresentative.some(code=>code.startsWith('foreign_key_violations:')));
  assert.equal(verifyCopy(broken,{allowInconsistent:true}).representative,false);
 }
}

// 6. Static: no apply function or writer, no network, no environment, only the planned imports.
{
 const text=fs.readFileSync(scriptPath,'utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(applyFilmFacts|applyEpgUnits|applyEpgPersonUnits|applyPersonMutation|applyPersonState|applyFilmCredits|receiptedWrite|writeFilmFacts|mutateFilm|mutatePerson|reconcile\w*)\b/.test(text),'no apply function or writer');
 assert.ok(!/\b(fetch|setTimeout|setInterval|BUCKET|process\.env|child_process|execSync|spawn|cloudflare)\b/i.test(text),'no network, timer, environment or process');
 assert.deepEqual([...text.matchAll(/from '([^']+)'/g)].map(match=>match[1]).sort(),['../tests/d1-standin.mjs','../tests/sqlite-session.mjs','./epg-producer-dry-run.mjs','./schema-preflight.mjs','node:crypto','node:fs','node:path','node:url']);
 // the writes of the script are the new local copy file only
 assert.ok(!/\bwriteFileSync|appendFile|createWriteStream\b/.test(text));
 for(const file of ['build.mjs','package.json','wrangler.jsonc'])assert.ok(!fs.readFileSync(file,'utf8').includes('epg-producer-m2b'),file+' does not carry the tool');
}
}finally{fs.rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const scriptPath=process.env.M2B_SCRIPT||'scripts/epg-producer-m2b.mjs';
 await check(await import(pathToFileURL(path.resolve(scriptPath)).href),scriptPath);
 console.log('epg-producer-m2b: ok');
}
