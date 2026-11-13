// AIR-374 M2b: the READER of the copy plan (scripts/epg-producer-m2b-reader.mjs) against a FAKE connector over the sqlite3-CLI D1 stand-in. No Worker, R2, D1, Cloudflare or network access: the fake answers with D1-shaped envelopes (`{success, result:[{success, results, meta}]}`).
// Covered: the assembled file passes verifyResults and loadCopy and gives the copy of the existing round trip; ONE statement per request in the printed order, every statement read-only; every stop rule fires on the offending response and sends NO further request
// (the calls are counted); the plan is refused before any request; the text of the reader runs as the body of an `execute` call and is self-contained. READER_MODULE points the file at a mutant copy; the mutation runner (tests/epg-producer-m2b-reader-mutation.mjs)
// calls check() on every mutant in one process.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {applyEpgUnits,planEpgUnits} from '../src/canonical-epg-producer.js';
import {assertReadOnly} from '../scripts/schema-preflight.mjs';
import {CAPS,COPY_PLAN,emitSql,verifyResults,loadCopy} from '../scripts/epg-producer-m2b.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-m2b-reader-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text,json=false)=>{const r=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);return r.stdout;};
const rows=(file,sql)=>{const out=sqlite(file,sql+';',true).trim();return out?JSON.parse(out):[];};
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=21).sort();
const template=path.join(root,'template.sqlite'); // read-only after it is built: shared by every check()
// Every check() works in a FRESH directory of its own (set at its start and removed at its end), so a second call in the same process, as the mutation runner makes, never meets a file the first one left behind.
let work=root;
sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const T='2026-11-13T10:00:00.000Z';
const ID=k=>'film:tmdb:'+k;
const META=()=>({schemaVersion:1,year:1999,runtime:136,synopsis:'S',poster:'/p.jpg',url:'https://example.test/m',genres:['g'],peopleVersion:2,payload:{k:'v'},r2Key:null,contentSha256:null,updatedAt:T});
const facts=title=>({film:{contractVersion:1,originalTitle:title,source:'tmdb'},metadata:META(),sync:{metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T},watchlist:true});
let n=0;
// The "production" stand-in: the real writer stored five Films, plus Person and credit rows. The seeded file does not depend on the tool under test, so it is built ONCE per process and copied per use.
let seededFile=null;
async function production(){
 if(seededFile){const copy=path.join(work,'prod-'+(n++)+'.sqlite');fs.copyFileSync(seededFile,copy);return copy;}
 const file=path.join(root,'seeded.sqlite');fs.copyFileSync(template,file);
 for(const s of ["UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;","UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1","INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'"+T+"');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','"+T+"');"])sqlite(file,s);
 const list=[1,2,3,4,5].map(k=>({id:ID(k),facts:{...facts('Title '+k),watchlist:k!==5}}));
 const applied=await applyEpgUnits({DB:d1Standin(file)},{plan:planEpgUnits({runId:'seed',at:T,films:list}),now:()=>T});
 assert.equal(applied.counts.applied,5);
 sqlite(file,"INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb:1','role:1',1,'"+T+"'),('person:tmdb:2','role:2',1,'"+T+"'),('person:tmdb:3','role:3',1,'"+T+"');INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('"+ID(1)+"','person:tmdb:1','director',0),('"+ID(2)+"','person:tmdb:2','actor',1),('"+ID(5)+"','person:tmdb:3','actor',0);");
 seededFile=file;
 return production();
}
// The INDEPENDENT reference reader of the step-0 test: the same statements run straight against the file, with the metrics the fake connector reports. A trailing EMPTY page after a full one is dropped: the reader under test ends a table as soon as the recorded count is complete.
function reference(file,pageRows){
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
  if(pages.length>1&&pages[pages.length-1].rows.length===0)pages.pop();
  tables[item.table]={count:{n:count.n,maxRowid:count.max_rowid,meta:{rows_read:count.n,duration:4}},pages};
 }
 return {_statementsDigest:emitSql().statementsDigest,_capturedAt:T,_pageRows:pageRows,tables};
}
const dump=file=>JSON.stringify(COPY_PLAN.map(item=>[item.table,rows(file,'SELECT '+item.columns.join(',')+' FROM '+item.table+' ORDER BY '+item.columns.join(','))]));

// The functions under test are bound by check(): the mutation runner calls it for every mutant in ONE process.
let readCopy,bundleText,executeBodyText,readerDigest;
const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
const ACCOUNT='acct',DATABASE='dbid';
const SCHEMA_SQL='SELECT version FROM schema_contract WHERE id = 1';
const MARKER_SQL='SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1';
// The fake connector: `request` has the shape of cloudflare.request; it answers a statement against the database file with a D1 envelope and the metrics the reference reader records.
// `tamper(envelope, context)` may change an answer or throw, and decides by the context; whatever it returns marks the request that was tampered with (`hitAt`). `state` counts the calls and proves that only one request is in flight.
function connector(file,tamper=null){
 const db=d1Standin(file);
 const state={calls:0,inFlight:0,maxInFlight:0,sqls:[],bodies:[],hitAt:null};
 const request=async options=>{
  state.calls++;state.inFlight++;state.maxInFlight=Math.max(state.maxInFlight,state.inFlight);
  try{
   assert.equal(options.method,'POST');
   assert.equal(options.path,'/accounts/'+ACCOUNT+'/d1/database/'+DATABASE+'/query');
   const {sql,params}=options.body;
   assert.deepEqual(Object.keys(options.body).sort(),params===undefined?['sql']:['params','sql']);
   state.sqls.push(sql);state.bodies.push(options.body);
   assertReadOnly(sql);
   await Promise.resolve();
   const statement=db.prepare(sql);
   const results=(await (params&&params.length?statement.bind(...params):statement).all()).results;
   const isCount=/COUNT\(\*\)/.test(sql),isCheck=sql===SCHEMA_SQL||sql===MARKER_SQL;
   const meta={rows_read:isCount?results[0].n:results.length,duration:isCount?4:isCheck?1:3};
   let envelope={success:true,errors:[],messages:[],result:[{success:true,results,meta}]};
   if(tamper){
    let changed;
    try{changed=tamper(envelope,{sql,params,index:state.calls,isCount,isCheck});}
    catch(error){if(state.hitAt===null)state.hitAt=state.calls;throw error;}
    if(changed!==undefined){envelope=changed.envelope;if(state.hitAt===null)state.hitAt=state.calls;}
   }
   return envelope;
  }finally{state.inFlight--;}
 };
 return {request,state};
}
const run=async(file,{tamper=null,plan=emitSql(),pageRows,now=()=>T}={})=>{
 const fake=connector(file,tamper);
 const out=await readCopy({request:fake.request,accountId:ACCOUNT,databaseId:DATABASE,plan,...(pageRows===undefined?{}:{pageRows}),now});
 return {out,fake};
};
// a tamper that acts once, on the first request for which `when(context)` is true; `change` edits the envelope (or throws, or returns another one)
const once=(when,change)=>{let done=false;return (envelope,context)=>{if(done||!when(context))return undefined;done=true;const replaced=change(envelope,context);return {envelope:replaced!==undefined?replaced:envelope};};};
const sqlHas=text=>context=>context.sql.includes(text);

export async function check(module,readerPath=path.resolve('scripts/epg-producer-m2b-reader.mjs'),{docs=false}={}){
// The reader must RETURN a result for any answer, never throw: a thrown error is an assertion failure here, so a mutant that makes it throw is killed by the assertion about the rule, not by the crash.
readCopy=async(...args)=>{try{return await module.readCopy(...args);}catch(error){assert.fail('readCopy threw instead of returning a result: '+String(error?.message).split('\n')[0].slice(0,100));}};
bundleText=module.bundleText;executeBodyText=module.executeBodyText;readerDigest=module.readerDigest;
work=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-m2b-reader-work-'));
try{
 const prod=await production();

 // 1. The healthy read: one statement per request in the printed order, every statement read-only, the file the verifier accepts, the copy of the existing round trip.
 for(const pageRows of [2,100]){
  const {out,fake}=await run(prod,{pageRows});
  assert.equal(out.ok,true,JSON.stringify(out.stop));
  assert.equal(fake.state.calls,out.requests);
  assert.equal(fake.state.maxInFlight,1,'one request in flight at a time');
  assert.equal(fake.state.sqls[0],SCHEMA_SQL);assert.equal(fake.state.sqls[1],MARKER_SQL);
  // the printed order: per table the count statement, then its pages
  const plan=emitSql();
  const seen=fake.state.sqls.slice(2);
  let at=0;
  for(const statement of plan.statements){assert.ok(at<seen.length&&seen[at]===statement.sql,'statement order: '+statement.id);at++;if(statement.kind==='page')while(at<seen.length&&seen[at]===statement.sql)at++;}
  assert.equal(at,seen.length,'no statement outside the plan');
  for(const body of fake.state.bodies)assert.ok(body.params===undefined||(Array.isArray(body.params)&&body.params.length===2),'parameters are [after, pageRows] or none');
  const verdict=verifyResults(out.results);
  assert.deepEqual([verdict.ok,verdict.refusals],[true,[]]);
  assert.equal(out.results._pageRows,pageRows);assert.equal(out.results._statementsDigest,plan.statementsDigest);assert.equal(out.results._capturedAt,T);
  assert.deepEqual(out.checks,{schemaVersion:21,marker:{mode:'d1',cutover:'open',generation:2}});
  // the same pages as the independent reference reader
  assert.deepEqual(out.results,reference(prod,pageRows),'the assembled file equals the reference reader');
  // the copy: row for row the original
  const copy=path.join(work,'copy-'+pageRows+'.sqlite');
  const loaded=loadCopy(out.results,copy);
  assert.equal(loaded.ok,true,JSON.stringify(loaded.refusals));
  assert.equal(dump(copy),dump(prod),'the planned tables are row for row identical');
 }
 {
  // a table of exactly the page size: no empty terminal page is requested, and the file is still accepted (the recorded count and maximum prove the end)
  const {out}=await run(prod,{pageRows:5});
  assert.equal(out.ok,true);
  assert.equal(out.results.tables.film.pages.length,1);
  assert.equal(verifyResults(out.results).ok,true);
  // an empty table is one short page of no rows
  const empty=path.join(work,'empty.sqlite');fs.copyFileSync(template,empty);
  for(const s of ["UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;","UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1"])sqlite(empty,s);
  const second=await run(empty);
  assert.equal(second.out.ok,true,JSON.stringify(second.out.stop));
  assert.deepEqual(second.out.results.tables.film,{count:{n:0,maxRowid:null,meta:{rows_read:0,duration:4}},pages:[{after:0,last:0,rows:[],meta:{rows_read:0,duration:3}}]});
  assert.equal(verifyResults(second.out.results).ok,true);
  assert.equal(second.fake.state.calls,2+2*COPY_PLAN.length,'an empty table costs a count and one page');
 }

 // 2. Every stop rule fires on the offending response and sends NO further request.
 const stops=[
  ['schema version other than 21',once(context=>context.sql===SCHEMA_SQL,envelope=>{envelope.result[0].results=[{version:20}];}),'schema_version'],
  ['schema version missing',once(context=>context.sql===SCHEMA_SQL,envelope=>{envelope.result[0].results=[];}),'schema_version'],
  ['marker without a row',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.result[0].results=[];}),'marker_unreadable'],
  ['marker malformed',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.result[0].results=[{mode:'d1',cutover:'open',generation:'two'}];}),'marker_unreadable'],
  ['marker request fails',once(context=>context.sql===MARKER_SQL,()=>{throw new Error('boom');}),'marker_unreadable'],
  ['marker answer not a success',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.success=false;}),'marker_unreadable'],
  ['request throws',once(sqlHas('FROM film_metadata'),()=>{throw new Error('network down');}),'request_failed'],
  ['envelope not a success',once(sqlHas('FROM film_sync_state'),envelope=>{envelope.success=false;}),'response_not_success'],
  ['no envelope',once(sqlHas('FROM film_sync_state'),()=>null),'response_not_success'],
  ['statement result not a success',once(sqlHas('FROM film_sync_state'),envelope=>{envelope.result[0].success=false;}),'response_shape'],
  ['two statement results',once(sqlHas('FROM film_sync_state'),envelope=>{envelope.result.push(envelope.result[0]);}),'response_shape'],
  ['results not a list',once(sqlHas('FROM film_sync_state'),envelope=>{envelope.result[0].results='x';}),'response_shape'],
  ['meta missing',once(sqlHas('FROM person WHERE'),envelope=>{delete envelope.result[0].meta;}),'meta_missing'],
  ['rows_read not an integer',once(sqlHas('FROM person WHERE'),envelope=>{envelope.result[0].meta.rows_read='many';}),'meta_missing'],
  ['duration negative',once(sqlHas('FROM person WHERE'),envelope=>{envelope.result[0].meta.duration=-1;}),'meta_missing'],
  ['rows read over the per-statement cap',once(sqlHas('FROM film WHERE'),envelope=>{envelope.result[0].meta.rows_read=CAPS.rowsReadPerStatement+1;}),'over_cap_rows_read'],
  ['duration over the per-statement cap',once(sqlHas('FROM film WHERE'),envelope=>{envelope.result[0].meta.duration=CAPS.msPerStatement+1;}),'over_cap_duration'],
  ['column added',once(sqlHas('FROM film_metadata WHERE'),envelope=>{envelope.result[0].results[0].extra='x';}),'columns_mismatch'],
  ['column missing',once(sqlHas('FROM film_metadata WHERE'),envelope=>{delete envelope.result[0].results[0].year;}),'columns_mismatch'],
  ['value not scalar',once(sqlHas('FROM film_metadata WHERE'),envelope=>{envelope.result[0].results[0].synopsis={a:1};}),'value_not_scalar'],
  ['row not an object',once(sqlHas('FROM film_metadata WHERE'),envelope=>{envelope.result[0].results[0]=5;}),'row_not_object'],
  ['rowid not increasing',once(sqlHas('FROM film_metadata WHERE'),envelope=>{envelope.result[0].results[0]._rid=0;}),'rowid_order'],
  ['rowid repeated',once(sqlHas('FROM film WHERE'),envelope=>{envelope.result[0].results[1]._rid=envelope.result[0].results[0]._rid;}),'rowid_order'],
  ['count negative',once(context=>context.isCount&&context.sql.includes('FROM film_redirect'),envelope=>{envelope.result[0].results=[{n:-1,max_rowid:3}];}),'count_invalid'],
  ['count not a number',once(context=>context.isCount&&context.sql.includes('FROM film_redirect'),envelope=>{envelope.result[0].results=[{n:'x',max_rowid:null}];}),'count_invalid'],
  ['maximum rowid not a number',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results=[{n:5,max_rowid:'x'}];}),'count_invalid'],
  ['marker statement result not a success',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.result[0].success=false;}),'marker_unreadable'],
  ['marker mode not text',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.result[0].results=[{mode:5,cutover:'open',generation:2}];}),'marker_unreadable'],
  ['marker cutover missing',once(context=>context.sql===MARKER_SQL,envelope=>{envelope.result[0].results=[{mode:'d1',cutover:null,generation:2}];}),'marker_unreadable'],
  ['column renamed',once(sqlHas('FROM film_metadata WHERE'),envelope=>{const line=envelope.result[0].results[0];line.yearx=line.year;delete line.year;}),'columns_mismatch'],
  ['rowid not a number',once(sqlHas('FROM film_metadata WHERE'),envelope=>{envelope.result[0].results[0]._rid='x';}),'rowid_order'],
  ['a defect of the reader is reported as one',once(sqlHas('FROM film_sync_state'),()=>({success:true,get result(){throw new TypeError('defect');}})),'reader_defect'],
  ['count positive without a maximum',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results=[{n:5,max_rowid:null}];}),'count_invalid'],
  ['count over the table cap',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results=[{n:CAPS.rowsReadPerStatement+1,max_rowid:9}];}),'rows_over_cap'],
  ['count smaller than the rows (the table grew)',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results=[{n:2,max_rowid:2}];}),'count_changed',undefined,1],
  ['count larger than the rows (a short page)',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results=[{n:9,max_rowid:9}];}),'count_mismatch',undefined,1],
  ['maximum rowid differs',once(context=>context.isCount&&context.sql.endsWith('FROM film'),envelope=>{envelope.result[0].results[0].max_rowid+=7;}),'max_rowid_mismatch',undefined,1],
  ['more rows than the page size',once(sqlHas('FROM film WHERE'),envelope=>{const list=envelope.result[0].results;list.push({...list[list.length-1],_rid:list[list.length-1]._rid+1});}),'page_over_size',2],
 ];
 for(const [name,tamper,code,pageRows,extra=0] of stops){
  const {out,fake}=await run(prod,{tamper,...(pageRows?{pageRows}:{})});
  assert.equal(out.ok,false,name+': must stop');
  assert.equal(out.stop.code,code,name+': '+JSON.stringify(out.stop));
  assert.ok(fake.state.hitAt!==null,name+': the tamper acted');
  assert.equal(fake.state.calls,fake.state.hitAt+extra,name+': NO request after the offending response (a count is judged with its pages: '+extra+' more)');
  assert.equal(out.requests,fake.state.calls,name+': the reader counts its requests');
  assert.equal('results' in out,false,name+': a stop never returns a file');
 }
 {
  // the running totals: lowered caps (a plan may lower them, never raise them)
  const lowRows={...emitSql(),caps:{...emitSql().caps,rowsReadTotal:7}};
  const first=await run(prod,{plan:lowRows});
  assert.deepEqual([first.out.ok,first.out.stop?.code,first.out.requests,first.fake.state.calls],[false,'over_cap_total_rows_read',4,4],'schema 1 + marker 1 + count 5 = 7, the first page (5) breaks 7');
  const lowMs={...emitSql(),caps:{...emitSql().caps,msTotal:8}};
  const second=await run(prod,{plan:lowMs});
  assert.deepEqual([second.out.ok,second.out.stop?.code,second.out.requests,second.fake.state.calls],[false,'over_cap_total_duration',4,4],'1 + 1 + 4 = 6, the first page (3) breaks 8');
  const lowOne={...emitSql(),caps:{...emitSql().caps,rowsReadPerStatement:4}};
  const third=await run(prod,{plan:lowOne});
  assert.equal(third.out.ok,false);assert.equal(third.out.stop.code,'over_cap_rows_read','a count that reads 5 rows is over a cap of 4');
  assert.equal(third.out.requests,3);assert.equal(third.fake.state.calls,3);
 }

 // 3. A plan the reader does not recognise is refused BEFORE any request.
 {
  const plan=emitSql();
  const mutate=change=>{const copy=JSON.parse(JSON.stringify(plan));change(copy);return copy;};
  // the count and page statements of a table, built exactly as the reader builds them: identifier-safe and self-consistent, so only the allowlist can refuse them
  const unapproved=(table,columns)=>[{id:table+'#count',table,kind:'count',sql:'SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM '+table},{id:table+'#page',table,kind:'page',columns,sql:'SELECT rowid AS _rid, '+columns.join(', ')+' FROM '+table+' WHERE rowid > ? ORDER BY rowid LIMIT ?'}];
  const refusals=[
   ['digest',mutate(copy=>{copy.statementsDigest='nope';}),'plan_invalid'],
   ['caps missing',mutate(copy=>{delete copy.caps;}),'plan_invalid'],
   ['a cap missing',mutate(copy=>{delete copy.caps.msTotal;}),'plan_invalid'],
   ['a cap raised: rows per statement',mutate(copy=>{copy.caps.rowsReadPerStatement=CAPS.rowsReadPerStatement+1;}),'caps_over_ceiling'],
   ['a cap raised: rows in total',mutate(copy=>{copy.caps.rowsReadTotal=CAPS.rowsReadTotal+1;}),'caps_over_ceiling'],
   ['a cap raised: page size',mutate(copy=>{copy.caps.pageRows=CAPS.pageRows+1;}),'caps_over_ceiling'],
   ['a cap raised: milliseconds per statement',mutate(copy=>{copy.caps.msPerStatement=CAPS.msPerStatement+1;}),'caps_over_ceiling'],
   ['a cap raised: milliseconds in total',mutate(copy=>{copy.caps.msTotal=CAPS.msTotal+1;}),'caps_over_ceiling'],
   ['another schema version',mutate(copy=>{copy.caps.schemaVersion=20;}),'caps_over_ceiling'],
   ['a statement that is null',mutate(copy=>{copy.statements[0]=null;}),'plan_invalid'],
   ['a statement that is not an object',mutate(copy=>{copy.statements[1]=5;}),'plan_invalid'],
   ['a cap of zero',mutate(copy=>{copy.caps.msTotal=0;}),'plan_invalid'],
   ['a column named like a keyword',mutate(copy=>{copy.statements[1].columns=['update'];copy.statements[1].sql='SELECT rowid AS _rid, update FROM film WHERE rowid > ? ORDER BY rowid LIMIT ?';}),'statement_not_read_only'],
   ['no statements',mutate(copy=>{copy.statements=[];}),'plan_invalid'],
   ['an odd number of statements',mutate(copy=>{copy.statements.pop();}),'plan_invalid'],
   ['a pair of two tables',mutate(copy=>{copy.statements[1].table='person';}),'plan_invalid'],
   ['kinds swapped',mutate(copy=>{[copy.statements[0],copy.statements[1]]=[copy.statements[1],copy.statements[0]];}),'plan_invalid'],
   ['an id changed',mutate(copy=>{copy.statements[0].id='film#other';}),'plan_invalid'],
   ['an unsafe table name',mutate(copy=>{copy.statements[0].table='film; DROP TABLE film';copy.statements[1].table='film; DROP TABLE film';}),'plan_invalid'],
   ['no columns',mutate(copy=>{copy.statements[1].columns=[];}),'plan_invalid'],
   ['an unsafe column name',mutate(copy=>{copy.statements[1].columns=['id, (SELECT 1)'];}),'plan_invalid'],
   ['a table twice',mutate(copy=>{copy.statements.push(copy.statements[0],copy.statements[1]);}),'plan_invalid'],
   ['a write statement',mutate(copy=>{copy.statements[1].sql='DELETE FROM film';}),'statement_not_read_only'],
   ['a second statement',mutate(copy=>{copy.statements[0].sql+='; DELETE FROM film';}),'statement_not_read_only'],
   // PLAN ALLOWLIST: a self-consistent, identifier-safe plan is still refused unless it is EXACTLY the reviewed plan, and no request is sent
   ['an unapproved table appended, with the real digest',mutate(copy=>{copy.statements.push(...unapproved('schema_contract',['version']));}),'plan_not_approved'],
   ['an unapproved table in place of the first, with a well-formed digest',mutate(copy=>{copy.statementsDigest='a'.repeat(64);copy.statements.splice(0,2,...unapproved('schema_contract',['version']));}),'plan_not_approved'],
   ['an unapproved table in place of the last, with the real digest',mutate(copy=>{copy.statements.splice(-2,2,...unapproved('schema_contract',['version']));}),'plan_not_approved'],
   ['only an unapproved table',mutate(copy=>{copy.statements=unapproved('schema_contract',['version']);}),'plan_not_approved'],
   ['an extra column of an approved table',mutate(copy=>{copy.statements.splice(0,2,...unapproved('film',[...COPY_PLAN[0].columns,'updated_by']));}),'plan_not_approved'],
   ['a column of an approved table left out',mutate(copy=>{copy.statements.splice(0,2,...unapproved('film',COPY_PLAN[0].columns.slice(1)));}),'plan_not_approved'],
   ['the columns of an approved table reordered',mutate(copy=>{copy.statements.splice(0,2,...unapproved('film',[...COPY_PLAN[0].columns].reverse()));}),'plan_not_approved'],
   ['an unapproved table with the columns of an approved one',mutate(copy=>{copy.statements.splice(0,2,...unapproved('film_copy',COPY_PLAN[0].columns));}),'plan_not_approved'],
   ['a column of another table in an approved one',mutate(copy=>{copy.statements.splice(0,2,...unapproved('film',['id','payload_json']));}),'plan_not_approved'],
   ['the approved tables in another order',mutate(copy=>{const first=copy.statements.splice(0,2);copy.statements.push(...first);}),'plan_not_approved'],
   ['an approved table left out',mutate(copy=>{copy.statements.splice(-2,2);}),'plan_not_approved'],
   ['the approved plan with a well-formed digest of another plan',mutate(copy=>{copy.statementsDigest='a'.repeat(64);}),'plan_not_approved'],
   ['the approved plan with the digest of the empty string',mutate(copy=>{copy.statementsDigest=createHash('sha256').update('').digest('hex');}),'plan_not_approved'],
   ['a different SELECT',mutate(copy=>{copy.statements[0].sql='SELECT original_title FROM film';}),'statement_not_read_only'],
   ['the page statement without its cursor',mutate(copy=>{copy.statements[1].sql=copy.statements[1].sql.replace('WHERE rowid > ? ','');}),'statement_not_read_only'],
  ];
  for(const [name,bad,code] of refusals){
   const {out,fake}=await run(prod,{plan:bad});
   assert.equal(out.ok,false,name);assert.equal(out.stop.code,code,name+': '+JSON.stringify(out.stop));
   assert.equal(fake.state.calls,0,name+': refused before ANY request');assert.equal(out.requests,0,name);
  }
  for(const [name,options,code] of [
   ['no request function',{request:undefined},'request_missing'],
   ['no account',{accountId:''},'target_missing'],
   ['no database',{databaseId:''},'target_missing'],
   ['a page size of zero',{pageRows:0},'plan_invalid'],
   ['a page size above the cap',{pageRows:CAPS.pageRows+1},'plan_invalid'],
   ['a page size that is not an integer',{pageRows:2.5},'plan_invalid'],
  ]){
   const {request}=connector(prod);
   const out=await readCopy({request,accountId:ACCOUNT,databaseId:DATABASE,plan:emitSql(),...options});
   assert.equal(out.ok,false,name);assert.equal(out.stop.code,code,name);
  }
 }

 // 4. The text of the reader is a body for an `execute` call: self-contained, no capability beyond the injected request, and it gives the same file.
 {
  const text=String(module.readCopy);
  assert.ok(!/\b(import|require|fetch|process|setTimeout|setInterval|eval|Function|XMLHttpRequest|WebSocket|globalThis|Deno|Buffer)\b/.test(text.replace(/\/\/[^\n]*/g,'')),'no module, network, timer or environment capability inside the function');
  assert.ok(!/\bcloudflare\b/.test(text),'the function does not name the connector: the request is injected');
  assert.ok(/^async function readCopy/.test(text));
  const options={plan:emitSql(),databaseId:DATABASE};
  const bundle=executeBodyText(options);
  assert.ok(bundle.startsWith('async () => {')&&bundle.includes(emitSql().statementsDigest)&&bundle.includes(JSON.stringify(DATABASE)));
  assert.equal(bundle,executeBodyText(options),'the text is deterministic');
  const fake=connector(prod);
  const ran=await new AsyncFunction('cloudflare','accountId','return ('+bundle+')()')({request:fake.request},ACCOUNT);
  assert.equal(ran.ok,true,JSON.stringify(ran.stop));
  const direct=await run(prod);
  assert.equal(JSON.stringify({...ran.results,_capturedAt:'x'}),JSON.stringify({...direct.out.results,_capturedAt:'x'}),'the bundle gives the file of the function');
  assert.equal(ran.requests,direct.out.requests);
  assert.match(readerDigest(),/^[0-9a-f]{64}$/);
  assert.equal(readerDigest(),createHash('sha256').update(text).digest('hex'));
  // `now` is injected; without it the stamp is a valid ISO time
  const stamped=await readCopy({request:connector(prod).request,accountId:ACCOUNT,databaseId:DATABASE,plan:emitSql()});
  assert.ok(stamped.ok&&Number.isFinite(Date.parse(stamped.results._capturedAt)));
 }

 // 4b. The allowlist inside the text is the reviewed COPY_PLAN and its digest (the text of the reader names exactly them), and the single-result delivery is BLOCKED.
 {
  const text=String(module.readCopy);
  assert.ok(text.includes(JSON.stringify(COPY_PLAN.map(item=>[item.table,item.columns]))),'the allowlist inside the reader equals COPY_PLAN, in order');
  assert.ok(text.includes("'"+emitSql().statementsDigest+"'"),'the digest inside the reader equals the statements digest');
  assert.throws(()=>bundleText({plan:emitSql(),databaseId:DATABASE}),/single_result_delivery_blocked/,'the operator bundle is refused');
  assert.throws(()=>bundleText(),/single_result_delivery_blocked/);
  if(docs){
   const cli=spawnSync(process.execPath,['scripts/epg-producer-m2b-reader-bundle.mjs','bundle','--database',DATABASE],{encoding:'utf8'});
   assert.equal(cli.status,3);assert.equal(cli.stdout,'','no text on stdout');assert.match(cli.stderr,/BLOCKED/);
   const digest=spawnSync(process.execPath,['scripts/epg-producer-m2b-reader-bundle.mjs','digest'],{encoding:'utf8'});
   assert.equal(digest.status,0);assert.equal(JSON.parse(digest.stdout).readerDigest,readerDigest());
  }
 }

 // 5. Static: the module imports only the digest primitive; the reader never names a write statement.
 {
  const source=fs.readFileSync(readerPath,'utf8').replace(/\/\/[^\n]*/g,'');
  assert.deepEqual([...source.matchAll(/from '([^']+)'/g)].map(match=>match[1]),['node:crypto']);
  assert.ok(!/\b(INSERT INTO|DELETE FROM|UPDATE [a-z_]+ SET|DROP TABLE|CREATE TABLE|ALTER TABLE)\b/.test(source),'no write statement in the reader');
  for(const file of ['build.mjs','package.json','wrangler.jsonc'])assert.ok(!fs.readFileSync(file,'utf8').includes('epg-producer-m2b-reader'),file+' does not carry the reader');
 }

 // 6. The runbook carries the digests of THIS reader and of the plan (only for the real file: a mutant has another digest).
 if(docs){
  const runbook=fs.readFileSync('docs/runbooks/film-person-m2b-dry-run-copy.md','utf8');
  assert.ok(runbook.includes(readerDigest()),'the runbook names the digest of the reader');
  assert.ok(runbook.includes(emitSql().statementsDigest),'the runbook names the statements digest');
 }
}finally{fs.rmSync(work,{recursive:true,force:true});}
}

if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){
 const readerPath=process.env.READER_MODULE?path.resolve(process.env.READER_MODULE):path.resolve('scripts/epg-producer-m2b-reader.mjs');
 await check(await import(pathToFileURL(readerPath).href),readerPath,{docs:!process.env.READER_MODULE});
 console.log('epg-producer-m2b-reader: ok');
}
