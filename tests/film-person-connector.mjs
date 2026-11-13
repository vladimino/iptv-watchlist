// AIR-373 (ADR 0110): the connector path as a reviewed tool (scripts/film-person-connector-run.mjs). Synthetic and local only: a sqlite file plays production
// D1, a FAKE connector (`cloudflare.request` over that file) runs the function texts the plan emits, and a fake read-only S3 server on loopback plays R2. No
// production read or write, no real connector call. The whole procedure runs once (lease, T0, copy, T1, resync, run, T2, release, seal, sql); every refusal is
// then provoked on that state or on altered copies of its evidence files. The mutation check (tests/film-person-connector-mutation.mjs) points this file at a
// mutant through CONNECTOR_MODULE.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {RECORDING_PATHS,readWitness,recordBaselineVerified} from '../src/film-person-baseline.js';
import {transitionAuthority} from '../src/film-person-authority.js';
import {ACCEPTED_DISCREPANCIES,COPY_TABLES,DISCOVERY_COPY_TABLES,cutoverAcceptedGate,requiredStatementIds} from '../src/film-person-cutover-accepted.js';
import {GATE_STATEMENTS,buildExpected,factsSql,verifyDerived} from '../scripts/film-person-capture.mjs';
import {runCutoverMinimum} from '../scripts/film-person-cutover-run.mjs';
import {renderSql} from '../scripts/d1-backfill.mjs';
import {createReadOnlyClient,readCredentials} from '../scripts/r2-snapshot-export.mjs';
const K=await import(process.env.CONNECTOR_MODULE?pathToFileURL(path.resolve(process.env.CONNECTOR_MODULE)).href:'../scripts/film-person-connector-run.mjs');

const started=Date.now();
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-connector-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
const stable=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:1)):item);
const sha=text=>createHash('sha256').update(text).digest('hex');
const runner=(args,input)=>sqliteSync(args,{input});
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const stops=async(work,reason,label=reason)=>assert.rejects(async()=>work(),error=>error instanceof K.ConnectorError&&error.reason===reason,label);

// ---------- "production": the migrated schema (built once) with all three D1 routes on, some canonical rows and a table that needs more than one page ----------
const template=path.join(root,'template.sqlite');
// The capture gate expects the schema production holds (SCHEMA_EXPECTED, 19, after the owner-approved apply of migration 0019 under ADR 0119), so this fixture is the whole chain.
sql(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=21).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const production=path.join(root,'production.sqlite');
fs.copyFileSync(template,production);
for(const trigger of rows(production,"SELECT name FROM sqlite_master WHERE type='trigger'"))sql(production,'DROP TRIGGER '+trigger.name+';');
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
const film=id=>({id,title:'Film '+id,original:'Film '+id,year:2001,tmdbId:String(500+id.length*7+id.charCodeAt(0)),url:'https://letterboxd.com/film/'+id+'/',directors:[{id:'director/'+id,name:'Dir '+id,original:'Dir '+id}],actors:[{id:'actor/'+id+'-a',name:'Act '+id,original:'Act '+id}]});
const programme={films:[{...film('alpha'),shows:[]}]},watchlist={films:[film('alpha')]};
const DAY='2026-11-10T00:00:00.000Z';
sql(production,`INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-1','published','${DAY}','${'0'.repeat(64)}','${DAY}');
INSERT INTO published_epg_document VALUES ('run-1','programme',0,${q(JSON.stringify(programme))}),('run-1','watchlist',0,${q(JSON.stringify(watchlist))});
UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run-1',generation=3;
UPDATE owner_review_authority SET mode='d1',generation=1;
UPDATE discovery_authority SET mode='d1',cutover='open',programme_run_id='run-1',generation=5;
INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','alpha',${q(JSON.stringify({localization:{status:'reviewed',provenance:{authority:'owner'},value:'Alpha (owner)'}}))},NULL,'unlinked',1);
INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:kept',1,'Kept','${DAY}');
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2100) INSERT INTO canonical_revision (kind,id,revision,updated_at) SELECT 'film','film:r'||i,i,'${DAY}' FROM n;`);

// ---------- the fake connector and the fake bucket ----------
const ACCOUNT='0123456789abcdef0123456789abcdef';
let requests=0;
const cloudflare={request:async({method,path:url,body})=>{
 requests++;
 assert.equal(method,'POST');assert.match(url,new RegExp('^/accounts/'+ACCOUNT+'/d1/database/[0-9a-f-]{36}/query$'));
 const statements=body.params?[renderSql(body.sql,body.params)]:body.sql.split(';\n');
 return {success:true,result:statements.map(text=>/^\s*SELECT/i.test(text)?{success:true,results:rows(production,text),meta:{rows_written:0}}:(sql(production,text+';'),{success:true,results:[],meta:{rows_written:1}}))};
}};
let fileNumber=0;
// Runs one function text of the plan through the fake connector and saves its result as the operator would.
const execute=async(text,edit=value=>value)=>{
 await sleep(3);
 const result=await new Function('cloudflare','accountId','return ('+edit(text)+')')(cloudflare,ACCOUNT)();
 const file=path.join(root,'result-'+(fileNumber++)+'.json');
 fs.writeFileSync(file,JSON.stringify(result));
 return {file,result};
};
const altered=(file,change)=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));change(value);const out=path.join(root,'altered-'+(fileNumber++)+'.json');fs.writeFileSync(out,JSON.stringify(value));return out;};
const items=new Map();
const put=(key,value)=>{const bytes=Buffer.from(JSON.stringify(value));items.set(key,{bytes,etag:sha(bytes).slice(0,24)+'-'+items.size+'-'+Date.now()});};
for(const key of ['metadata.json','titles.json','people.json'])put(key,{});
const methods=[];
const server=http.createServer((request,response)=>{
 const url=new URL(request.url,'http://x');methods.push(request.method);
 const item=items.get(decodeURIComponent(url.pathname).replace(/^\/iptv\//,''));
 if(!['GET','HEAD'].includes(request.method)){response.writeHead(405);response.end();return;}
 if(!item){response.writeHead(404);response.end();return;}
 const match=request.headers['if-match'];
 if(match&&match.replace(/"/g,'')!==item.etag){response.writeHead(412);response.end();return;}
 response.writeHead(200,{'content-length':item.bytes.length,etag:'"'+item.etag+'"','content-type':'application/json'});
 response.end(request.method==='HEAD'?undefined:item.bytes);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const client=()=>createReadOnlyClient({credentials:readCredentials({R2_SNAPSHOT_ACCOUNT_ID:ACCOUNT,R2_SNAPSHOT_ACCESS_KEY_ID:'a',R2_SNAPSHOT_SECRET_ACCESS_KEY:'b',R2_SNAPSHOT_ENDPOINT:'http://127.0.0.1:'+server.address().port}),retries:0,sleep:async()=>{}});

// ---------- 1. plan: generated from the reviewed code ----------
const LEASE='connector:test-lease-1';
const plan=await K.buildPlan({leaseId:LEASE});
{
 assert.deepEqual(await K.buildPlan({leaseId:LEASE}),plan,'deterministic');
 assert.equal((await K.buildPlan({leaseId:'connector:another-run'})).planDigest,plan.planDigest,'the digest names the reviewed material, not one run');
 const byId=Object.fromEntries(plan.statements.map(item=>[item.id,item.sql]));
 // the gate statements are GATE_STATEMENTS; the witness statements are what readWitness sends; one count per copied table
 for(const [id,text] of Object.entries(GATE_STATEMENTS))assert.equal(byId['gate:'+id],text);
 const sent=[];const witness=await readWitness({get:async text=>{sent.push(text);return {};}});
 assert.deepEqual(plan.statements.filter(item=>item.id.startsWith('witness:')),Object.keys(witness).map((name,index)=>({id:'witness:'+name,sql:sent[index]})));
 assert.equal(sent.length,20);
 assert.deepEqual(plan.statements.filter(item=>item.id.startsWith('count:')).map(item=>item.id),K.COPY_TABLES.map(table=>'count:'+table));
 assert.equal(plan.statements.length,20+10+K.COPY_TABLES.length);
 // ONE table list: the plan copies and counts exactly the tables from which the gate derives the statement set it requires
 assert.equal(K.COPY_TABLES,COPY_TABLES,'the tool re-exports the gate module\'s list, it has none of its own');
 assert.deepEqual(plan.copyTables,[...COPY_TABLES]);
 assert.deepEqual(plan.statements.map(item=>item.id),await requiredStatementIds(),'the plan asks exactly the statements the gate requires');
 // the three lease statements are the text of the stage A cut, character for character
 const source=fs.readFileSync('src/film-person-baseline.js','utf8');
 for(const text of Object.values(plan.lease))assert.ok(source.includes("'"+text+"'"),'in src/film-person-baseline.js: '+text.slice(0,40));
 assert.deepEqual(Object.keys(plan.lease),['acquire','renew','release']);
 // every function carries the plan digest, the database id and the request shape; the check carries every statement
 assert.deepEqual(Object.keys(plan.functions),['ddl','check','copy','resync','leaseAcquire','leaseRenew','leaseRelease']);
 for(const text of Object.values(plan.functions)){
  assert.ok(text.startsWith('async()=>{')&&text.includes(JSON.stringify(plan.planDigest))&&text.includes(JSON.stringify(plan.databaseId)));
  assert.ok(text.includes("cloudflare.request({method:'POST',path:`/accounts/${accountId}/d1/database/${DB}/query`"));
  new Function('return ('+text+')');
 }
 for(const item of plan.statements)assert.ok(plan.functions.check.includes(JSON.stringify(item.sql)),item.id);
 for(const text of Object.values(plan.lease))assert.ok(Object.values(plan.functions).some(fn=>fn.includes(JSON.stringify(text))));
 assert.ok(plan.functions.copy.includes(JSON.stringify(K.COPY_TABLES))&&plan.functions.copy.includes('BUDGET='+K.RESULT_BUDGET)&&K.RESULT_BUDGET<9_000_000);
 assert.deepEqual(K.COPY_TABLES.slice(-DISCOVERY_COPY_TABLES.length),[...DISCOVERY_COPY_TABLES],'the Discovery tables are copied last');
 assert.equal(new Set(K.COPY_TABLES).size,K.COPY_TABLES.length);
 for(const bad of [{databaseId:'x'},{leaseId:'short'},{leaseId:"a'; DROP TABLE film; --"},{ttlMs:1},{ttlMs:61*60000}])await stops(()=>K.buildPlan(bad),'plan_invalid');
}

// ---------- 2. the lease functions on "production" ----------
const leaseRow=()=>rows(production,"SELECT lease_id, lease_until, started_at FROM projection_run WHERE projection='enrichment'")[0]??null;
{
 const foreign=await execute(plan.functions.leaseAcquire,text=>text.replace(JSON.stringify(LEASE),'"connector:foreign-run"'));
 assert.equal(foreign.result.row[0].lease_id,'connector:foreign-run');
 const refused=await execute(plan.functions.leaseAcquire);
 assert.equal(refused.result.row[0].lease_id,'connector:foreign-run','a live foreign lease is not taken: the operator stops');
 await execute(plan.functions.leaseRelease);
 assert.equal(leaseRow().lease_id,'connector:foreign-run','a release by another id changes nothing');
 await execute(plan.functions.leaseRelease,text=>text.replace(JSON.stringify(LEASE),'"connector:foreign-run"'));
 assert.equal(leaseRow().lease_id,null);
}
const acquired=await execute(plan.functions.leaseAcquire);
assert.deepEqual([acquired.result.kind,acquired.result.action,acquired.result.leaseId,acquired.result.row[0].lease_id],['lease','acquire',LEASE,LEASE]);
assert.ok(Date.parse(acquired.result.row[0].lease_until)-Date.now()>40*60000);
{
 const before=leaseRow().lease_until;await sleep(5);
 const renewed=await execute(plan.functions.leaseRenew);
 assert.ok(renewed.result.row[0].lease_until>before&&renewed.result.row[0].started_at===acquired.result.row[0].started_at,'renewed, same holder');
}

// ---------- 3. T0, the DDL and the copy ----------
const check=label=>execute(plan.functions.check,text=>text.replace('const LABEL="T0"','const LABEL="'+label+'"'));
const t0=await check('T0');
assert.deepEqual([t0.result.kind,t0.result.label,t0.result.written,t0.result.rows.length],['check','T0',0,plan.statements.length]);
const copyFile=path.join(root,'copy.sqlite');
const driver=K.sqliteDriver(copyFile,{runner});
const ddl=await execute(plan.functions.ddl);
{
 await stops(()=>K.loadResult(driver,t0.file,plan),'ddl_not_loaded','nothing loads before the DDL');
 await stops(()=>K.loadResult(driver,altered(ddl.file,v=>{v.planDigest='0'.repeat(64);}),plan),'plan_mismatch');
 await stops(()=>K.loadResult(driver,altered(ddl.file,v=>{v.rows=v.rows.filter(row=>row.name!=='film_retention');}),plan),'ddl_incomplete');
 await stops(()=>K.loadResult(driver,altered(ddl.file,v=>{v.rows.push({type:'trigger',name:'t',tbl_name:'film',sql:'CREATE TRIGGER t AFTER INSERT ON film BEGIN SELECT 1; END'});}),plan),'ddl_malformed','a trigger is never created');
 const truncated=path.join(root,'truncated.json');fs.writeFileSync(truncated,fs.readFileSync(ddl.file,'utf8').slice(0,-40));
 await stops(()=>K.loadResult(driver,truncated,plan),'result_unreadable','a corrupted file');
 await stops(()=>K.loadResult(driver,altered(ddl.file,v=>{delete v.at;}),plan),'result_malformed');
 assert.deepEqual(K.copyState(driver),{ddl:false,tables:{},log:[]},'a refused file leaves nothing');
}
const loadedDdl=K.loadResult(driver,ddl.file,plan);
assert.equal(loadedDdl.tables,rows(production,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")[0].n,'every production table exists in the copy');
assert.deepEqual(rows(copyFile,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger'"),[{n:0}]);
assert.deepEqual(rows(copyFile,'PRAGMA journal_mode'),[{journal_mode:'delete'}]);
await stops(()=>K.loadResult(driver,ddl.file,plan),'already_loaded','the same file twice');
await stops(()=>K.loadResult(driver,altered(ddl.file,v=>{v.at='2026-11-10T00:00:01.000Z';}),plan),'copy_not_empty','a second DDL');

// a table whose copy is not complete is never read as empty
{
 const binding=K.copyBinding(driver,plan.lease);
 await stops(()=>binding.prepare('SELECT COUNT(*) AS n FROM film').first(),'connector_table_not_copied');
 await stops(()=>binding.prepare('SELECT film_id FROM tmdb_retirement_current').all(),'connector_table_not_copied','a view over an uncopied table');
 await stops(()=>binding.prepare('SELECT 1 FROM discovery_observation LIMIT 1').all(),'connector_table_not_copied','a table that exists but is outside the plan');
 await stops(()=>binding.prepare('SELECT * FROM connector_copy_log').all(),'connector_table_not_copied');
 assert.ok((await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'published_epg%'").all()).results.length>=8,'existence checks see the whole schema');
 assert.deepEqual((await binding.prepare("SELECT 'film' AS held").first()),{held:'film'},'a table name inside a string literal is not a read');
 for(const text of ["UPDATE film SET original_title='x'",'SELECT 1; SELECT 2','DELETE FROM film','PRAGMA journal_mode'])await stops(()=>binding.prepare(text).all(),'connector_statement_refused',text);
 for(const text of ["UPDATE film_person_baseline SET state='verified'",'DELETE FROM projection_run',plan.lease.release+' OR 1=1','SELECT 1'])await stops(()=>binding.prepare(text).bind('enrichment','x').run(),'connector_statement_refused',text);
 assert.equal(typeof binding.batch,'undefined','the copy binding has no batch');
 assert.deepEqual(binding.counts,{select:2,leaseWrites:0,refused:12});
}

assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:new Date().toISOString()})).reasons,['copy_incomplete'],'no run on an incomplete copy');
// the copy, in several calls (a small budget forces more than one) and more than one page for the large table
const small=text=>text.replace('BUDGET='+K.RESULT_BUDGET,'BUDGET=60000');
const dataFiles=[];
{
 let cursor=null,calls=0,done=false;
 const first=await execute(plan.functions.copy,small);
 // refusals on the first data file, before anything is loaded
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].t='candidate';}),plan),'table_not_in_plan');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].from=7;}),plan),'chunk_out_of_order');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].n++;}),plan),'chunk_malformed');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{const chunk=v.chunks.find(item=>item.rows.length>1);chunk.rows.reverse();chunk.after=chunk.rows[chunk.rows.length-1][0];}),plan),'chunk_out_of_order','rows out of rowid order');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].cols=v.chunks[0].cols.slice(1);v.chunks[0].rows=v.chunks[0].rows.map(row=>row.slice(0,-1));}),plan),'columns_mismatch');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].rows[0][1]={a:1};}),plan),'cell_unsupported');
 await stops(()=>K.loadResult(driver,altered(first.file,v=>{v.chunks[0].after=99;}),plan),'chunk_malformed');
 assert.deepEqual(K.copyState(driver).tables,{},'a refused file loads no row');
 for(let file=first;;){
  calls++;dataFiles.push(file.file);
  const out=K.loadResult(driver,file.file,plan);
  assert.deepEqual(out.cursor,file.result.cursor);
  cursor=out.cursor;done=out.done;
  if(!cursor)break;
  file=await execute(plan.functions.copy,text=>small(text).replace('const CURSOR=null','const CURSOR='+JSON.stringify(cursor)));
  assert.ok(calls<60);
 }
 assert.equal(done,true);assert.ok(calls>1,'several calls: '+calls);
 const state=K.copyState(driver);
 assert.deepEqual(Object.keys(state.tables).sort(),[...K.COPY_TABLES].sort());
 assert.ok(Object.values(state.tables).every(item=>item.done));
 assert.equal(state.tables.canonical_revision.rows,2100);
 assert.ok(state.log.filter(row=>row.kind==='data').some(row=>row.detail.loaded.canonical_revision<2100),'the large table arrived in more than one page');
 await stops(()=>K.loadResult(driver,dataFiles[0],plan),'already_loaded','a data file twice');
 await stops(()=>K.loadResult(driver,altered(dataFiles[0],v=>{v.at='2026-11-10T00:00:02.000Z';}),plan),'table_already_complete','the same rows in another file');
 assert.deepEqual(rows(copyFile,'SELECT COUNT(*) AS n, SUM(revision) AS a FROM canonical_revision'),rows(production,'SELECT COUNT(*) AS n, SUM(revision) AS a FROM canonical_revision'));
}

// ---------- 3b. AIR-373, 11 Nov 2026: a per-table page size, a wall-clock guard on the copy, and a tolerated `pad` field ----------
// A second, separate "production" (the schema plus one table of very large rows, published_epg_document, followed by tables of small rows) behind its own fake
// connector that counts its requests. Nothing here touches the main fixture or its copy.
const padded=file=>{const value=JSON.parse(fs.readFileSync(file,'utf8'));value.pad='x'.repeat(200000);const out=path.join(root,'padded-'+(fileNumber++)+'.json');fs.writeFileSync(out,JSON.stringify(value));return out;};
// AIR-374: CONNECTOR_SKIP_3B=1 skips this self-contained section (its own fixture, connector and copies: it reads and writes nothing the later sections use, only the file-name counter). The mutation
// check (tests/film-person-connector-mutation.mjs) runs a mutant without it first and runs the whole file before it calls a mutant a survivor; a plain run always executes the section.
if(process.env.CONNECTOR_SKIP_3B!=='1'){
 const fixture=path.join(root,'fixture.sqlite');
 fs.copyFileSync(template,fixture);
 for(const trigger of rows(fixture,"SELECT name FROM sqlite_master WHERE type='trigger'"))sql(fixture,'DROP TRIGGER '+trigger.name+';');
 sql(fixture,`INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run-1','published','${DAY}','${'0'.repeat(64)}','${DAY}');
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<11) INSERT INTO published_epg_document SELECT 'run-1','programme',i,'"'||hex(zeroblob(45000))||'"' FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2100) INSERT INTO canonical_revision (kind,id,revision,updated_at) SELECT 'film','film:r'||i,i,'${DAY}' FROM n;
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<2100) INSERT INTO film (id,contract_version,original_title,updated_at) SELECT 'film:f'||i,1,'F'||i,'${DAY}' FROM n;`);
 const count=table=>rows(fixture,'SELECT COUNT(*) AS n FROM '+table)[0].n;
 assert.deepEqual([count('published_epg_document'),count('canonical_revision'),count('film')],[12,2100,2100]);
 // the fake connector: it records every request and moves an injectable clock by `tick` ms per request
 const queries=[];let clock=1_800_000_000_000,tick=0;
 const over={request:async({method,path:url,body})=>{
  assert.equal(method,'POST');assert.match(url,/\/query$/);
  queries.push({sql:body.sql,params:body.params??null});clock+=tick;
  const statements=body.params?[renderSql(body.sql,body.params)]:body.sql.split(';\n');
  return {success:true,result:statements.map(text=>({success:true,results:rows(fixture,text),meta:{rows_written:0}}))};
 }};
 // `Date` is a parameter of the function text, so the text is the production text; only the clock it reads is the test's
 class TestDate extends Date{static now(){return clock;}}
 const call=async(text,edit=value=>value)=>{
  const result=await new Function('cloudflare','accountId','Date','return ('+edit(text)+')')(over,ACCOUNT,TestDate)();
  const file=path.join(root,'fx-'+(fileNumber++)+'.json');fs.writeFileSync(file,JSON.stringify(result));return {file,result};
 };
 const budget=value=>text=>text.replace('BUDGET='+K.RESULT_BUDGET,'BUDGET='+value);
 const withCursor=cursor=>text=>text.replace('const CURSOR=null','const CURSOR='+JSON.stringify(cursor));
 const newCopy=async name=>{const file=path.join(root,name);const copy=K.sqliteDriver(file,{runner});K.loadResult(copy,(await call(plan.functions.ddl)).file,plan);return {file,copy};};
 // the whole copy, call by call; returns each call's result file, its cursor and the range of requests it made
 const copyAll=async({text,target=null})=>{
  const calls=[];let cursor=null;
  for(;;){
   const from=queries.length;
   const out=await call(plan.functions.copy,value=>cursor?withCursor(cursor)(text(value)):text(value));
   calls.push({file:out.file,result:out.result,from,to:queries.length,cursor:out.result.cursor});
   if(target)K.loadResult(target,out.file,plan);
   cursor=out.result.cursor;
   if(!cursor)break;
   assert.ok(calls.length<40,'the copy ends');
  }
  return calls;
 };
 const tableOf=query=>/FROM (\w+) WHERE rowid > \? ORDER BY rowid LIMIT \?/.exec(query.sql)?.[1];
 const HUGE='published_epg_document';
 const sums=(file,table)=>rows(file,'SELECT COUNT(*) AS n, SUM(rowid) AS s FROM '+table);
 // ---- A. the page size is per table ----
 await call(plan.functions.leaseAcquire);// the copy carries the lease row, as in the real run
 const a=await newCopy('fixture-a.sqlite');
 queries.length=0;tick=0;
 const callsA=await copyAll({text:budget(1_000_000),target:a.copy});
 {
  assert.ok(callsA.length>=3&&callsA.length<10,'the large table needs several calls: '+callsA.length);
  const copyQueries=queries.filter(query=>tableOf(query));
  const perTable=new Map();
  for(const query of copyQueries)perTable.set(tableOf(query),(perTable.get(tableOf(query))||0)+1);
  assert.deepEqual([...perTable.keys()],K.COPY_TABLES,'every table is paged, in plan order');
  for(const table of K.COPY_TABLES.filter(name=>name!==HUGE)){
   // rows / PAGE_ROWS pages, plus at most two for pages a full call had to give back to the next call
   assert.ok(perTable.get(table)<=Math.ceil(count(table)/K.PAGE_ROWS)+2,table+': '+perTable.get(table)+' queries for '+count(table)+' rows');
  }
  assert.ok(perTable.get('canonical_revision')<=4&&perTable.get('film')<=4,'the tables after the large one are not paged in tiny pages');
  // the large table did shrink its own page, and the next table started again at the full size
  const huge=copyQueries.filter(query=>tableOf(query)===HUGE),limits=huge.map(query=>query.params[1]);
  assert.equal(limits[0],K.PAGE_ROWS);assert.ok(Math.min(...limits)<=4,'the large table halved its page: '+limits.join());
  const after=copyQueries.slice(copyQueries.indexOf(huge[huge.length-1])+1)[0];
  assert.deepEqual([tableOf(after),after.params[1]],[K.COPY_TABLES[K.COPY_TABLES.indexOf(HUGE)+1],K.PAGE_ROWS],'the next table starts with the full page size');
  // the cursor: a fresh table (after 0) always carries the full size; inside the large table it carries that table's own, reduced size
  for(const item of callsA)if(item.cursor&&item.cursor.after===0)assert.equal(item.cursor.limit,K.PAGE_ROWS,'fresh table, full page: '+JSON.stringify(item.cursor));
  const middle=callsA.find(item=>item.cursor&&item.cursor.i===K.COPY_TABLES.indexOf(HUGE)&&item.cursor.after>0);
  assert.ok(middle&&middle.cursor.limit<K.PAGE_ROWS,'a cursor inside the large table keeps its reduced size: '+JSON.stringify(middle?.cursor));
  // RESUME: the next call, started from that cursor, reads the large table with exactly that size and from exactly that rowid
  const next=callsA[callsA.indexOf(middle)+1];
  assert.deepEqual(queries[next.from].params,[middle.cursor.after,middle.cursor.limit],'the call resumes with the cursor\'s own page size');
  assert.deepEqual(Object.keys(middle.cursor),['i','after','limit'],'the cursor keeps its shape {i,after,limit}');
  // a cursor of the same shape is honoured; a missing or bad limit means the full size
  for(const [cursor,expected] of [[{i:0,after:0},K.PAGE_ROWS],[{i:0,after:0,limit:0},K.PAGE_ROWS],[{i:0,after:0,limit:7},7]]){
   const from=queries.length;await call(plan.functions.copy,value=>withCursor(cursor)(budget(60000)(value)));
   assert.equal(queries[from].params[1],expected,JSON.stringify(cursor));
  }
  // the copy is whole
  const state=K.copyState(a.copy);
  assert.ok(Object.values(state.tables).every(item=>item.done)&&Object.keys(state.tables).length===K.COPY_TABLES.length);
  for(const table of [HUGE,'canonical_revision','film'])assert.deepEqual(sums(a.file,table),sums(fixture,table),table);
  assert.deepEqual(rows(a.file,'SELECT SUM(length(payload_json)) AS s FROM '+HUGE),rows(fixture,'SELECT SUM(length(payload_json)) AS s FROM '+HUGE));
 }
 // ---- B. the wall-clock guard ----
 assert.equal(K.TOOL_TIMEOUT_MS,60_000);assert.ok(K.WALL_CLOCK_MS>=30_000&&K.WALL_CLOCK_MS<=45_000);
 assert.ok(plan.functions.copy.includes('WALL_MS='+K.WALL_CLOCK_MS)&&plan.functions.copy.includes('PAGE_ROWS='+K.PAGE_ROWS));
 {
  // a fast connector: the whole copy fits one call; a slow one (7 s a request) is cut after the page that crosses 40 s
  queries.length=0;tick=0;
  const fast=await copyAll({text:value=>value});
  assert.equal(fast.length,1,'at full speed one call copies everything');
  assert.deepEqual([fast[0].result.cursor,fast[0].result.done],[null,true]);
  tick=7000;
  const b=await newCopy('fixture-b.sqlite');
  queries.length=0;
  const slow=await copyAll({text:value=>value,target:b.copy});
  assert.ok(slow.length>=2,'a slow connector needs several calls: '+slow.length);
  for(const item of slow){
   const requests=item.to-item.from;
   assert.ok(requests*tick<=K.WALL_CLOCK_MS+2*tick,'a call stops after the page that crosses the limit: '+requests+' requests');
   assert.equal(item.result.kind,'data');
  }
  for(const item of slow.slice(0,-1))assert.ok(item.result.cursor&&item.result.done===false&&item.result.chunks.length>0,'a partial result is a valid data result with a cursor');
  assert.deepEqual([slow[slow.length-1].result.cursor,slow[slow.length-1].result.done],[null,true]);
  const state=K.copyState(b.copy);
  assert.ok(Object.values(state.tables).every(item=>item.done)&&Object.keys(state.tables).length===K.COPY_TABLES.length,'every partial result loaded');
  for(const table of [HUGE,'canonical_revision','film'])assert.deepEqual(sums(b.file,table),sums(fixture,table),table);
  tick=0;
 }
 // ---- C. an unknown top-level `pad` field is ignored ----
 {
  const plain=await call(plan.functions.leaseRenew),wrapped=padded(plain.file);
  const text=fs.readFileSync(wrapped,'utf8');
  assert.ok(text.length>200000);
  assert.deepEqual(K.parseResult(text),K.parseResult(fs.readFileSync(plain.file,'utf8')),'parse: the padded result is the plain result');
  assert.ok(!('pad' in K.parseResult(text)));
  assert.deepEqual(K.parseResult(JSON.stringify([{type:'text',text}])),K.parseResult(fs.readFileSync(plain.file,'utf8')),'also inside the MCP text wrapper');
  // load: the same data files, padded, give the same copy
  const c=await newCopy('fixture-c.sqlite');
  for(const item of callsA)K.loadResult(c.copy,padded(item.file),plan);
  assert.deepEqual(K.copyState(c.copy).tables,K.copyState(a.copy).tables,'load: padded data files give the same copy');
  for(const table of [HUGE,'canonical_revision','film'])assert.deepEqual(sums(c.file,table),sums(a.file,table),table);
  // verify: the same production read, padded or not, gives the same comparison
  const check1=await call(plan.functions.check,value=>value.replace('const LABEL="T0"','const LABEL="T1"'));
  const one=await K.verifyCopy(a.copy,check1.file,plan),two=await K.verifyCopy(a.copy,padded(check1.file),plan);
  assert.equal(one.equal,true,JSON.stringify(one.statements.filter(item=>!item.equal)));assert.deepEqual(two,one,'verify: a padded check compares identically');
  assert.deepEqual(K.parseCheck(K.parseResult(fs.readFileSync(padded(check1.file),'utf8')),plan),K.parseCheck(check1.result,plan));
 }
}

// ---------- 4. verify ----------
const t1=await check('T1');
{
 assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:new Date().toISOString()})).reasons,['copy_not_verified_at_t1']);
 // one changed aggregate in the production read is found and named
 const changed=await K.verifyCopy(driver,altered(t1.file,v=>{v.rows[v.ids.indexOf('witness:credit')][0].n=7;}),plan);
 assert.equal(changed.equal,false);assert.deepEqual(changed.statements.filter(item=>!item.equal).map(item=>item.id),['witness:credit']);
 assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:new Date().toISOString()})).reasons,['copy_not_verified_at_t1'],'a failed comparison does not open the run');
 const count=await K.verifyCopy(driver,altered(t1.file,v=>{v.rows[v.ids.indexOf('count:film')][0].n=99;}),plan);
 assert.deepEqual(count.statements.filter(item=>!item.equal).map(item=>item.id),['count:film']);
 // a Discovery statement may differ; another holder of the lease may not
 const moving=await K.verifyCopy(driver,altered(t1.file,v=>{v.rows[v.ids.indexOf('gate:discovery')][0].generation=6;}),plan);
 assert.equal(moving.equal,true);assert.deepEqual(moving.statements.filter(item=>!item.equal).map(item=>[item.id,item.moving]),[['gate:discovery',true]]);
 const holder=await K.verifyCopy(driver,altered(t1.file,v=>{v.rows[v.ids.indexOf('gate:lease')][0].lease_id='other';}),plan);
 assert.equal(holder.equal,false);
 for(const change of [v=>{v.written=1;},v=>{v.ids.pop();v.rows.pop();},v=>{[v.ids[0],v.ids[1]]=[v.ids[1],v.ids[0]];},v=>{v.label='T9';},v=>{v.rows[0]='x';}])await stops(()=>K.verifyCopy(driver,altered(t1.file,change),plan),'check_malformed');
 await stops(()=>K.verifyCopy(driver,altered(t1.file,v=>{v.planDigest='1'.repeat(64);}),plan),'plan_mismatch');
 // production against production
 const same=K.compareChecks(K.parseCheck(t0.result,plan),K.parseCheck(t1.result,plan));
 assert.equal(same.equal,true);assert.ok(same.statements.every(item=>item.equal));
 const differs=K.compareChecks(K.parseCheck(t0.result,plan),K.parseCheck(JSON.parse(fs.readFileSync(altered(t1.file,v=>{v.rows[v.ids.indexOf('witness:person')][0].n=1;}),'utf8')),plan));
 assert.equal(differs.equal,false);assert.deepEqual(differs.statements.filter(item=>!item.equal).map(item=>item.id),['witness:person']);
}
const verified=await K.verifyCopy(driver,t1.file,plan);
assert.equal(verified.equal,true);assert.ok(verified.statements.every(item=>item.equal),'the copy answers all '+verified.statements.length+' statements as production did at T1');

// ---------- 5. the Discovery resync ----------
assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:new Date().toISOString()})).reasons,['discovery_not_resynced']);
// the Discovery Workflow writes between the copy and the resync
sql(production,`UPDATE discovery_authority SET generation=7; UPDATE discovery_transfer SET batches=batches+1;
INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,observation_key,programme_run_id,generation,state,payload_json) VALUES ('film:d1','901','movie','tmdb:movie:901',NULL,'run-1',7,'pending','{}');`);
const since=t0.result.rows[t0.result.ids.indexOf('gate:discovery')][0].generation;
const resyncText=text=>text.replace('const SINCE=0','const SINCE='+since);
const resync=await execute(plan.functions.resync,resyncText);
{
 assert.equal(resync.result.first[0].generation,7);assert.equal(resync.result.truncated,false);
 // the generation moved inside the request: nothing is applied
 await stops(()=>K.loadResult(driver,altered(resync.file,v=>{v.last[0].generation=8;}),plan),'discovery_generation_moved');
 await stops(()=>K.loadResult(driver,altered(resync.file,v=>{v.truncated=true;}),plan),'resync_truncated');
 await stops(()=>K.loadResult(driver,altered(resync.file,v=>{v.delta.pop();}),plan),'result_malformed');
 assert.deepEqual(rows(copyFile,'SELECT generation FROM discovery_authority'),[{generation:5}],'a refused resync changes nothing');
 // a resync whose rows do not bring the copy to production's aggregates is recorded as unequal and does not open the run
 const short=K.loadResult(driver,altered(resync.file,v=>{const chunk=v.delta.find(item=>item.t==='discovery_admission');chunk.rows=[];chunk.n=0;}),plan);
 assert.equal(short.equal,false);assert.deepEqual(short.tables.discovery_admission,false);
 assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:new Date().toISOString()})).reasons,['discovery_not_resynced']);
}
const resynced=K.loadResult(driver,resync.file,plan);
assert.deepEqual(resynced,{kind:'resync',generation:7,equal:true,tables:Object.fromEntries(DISCOVERY_COPY_TABLES.map(table=>[table,true]))});
assert.deepEqual(rows(copyFile,'SELECT film_id, generation FROM discovery_admission'),[{film_id:'film:d1',generation:7}]);

// ---------- 6. run: the merged capture and parity against the copy ----------
const traced=[];
const tracing={file:driver.file,exec:script=>driver.exec(script),query:text=>{traced.push(text);return driver.query(text);}};
methods.length=0;
const before=requests;
const measured=await K.runMeasurement({driver:tracing,plan,client:client(),asOf:new Date().toISOString()});
assert.equal(measured.ok,true,measured.reasons.join());
{
 assert.equal(requests,before,'the run never calls the connector');
 assert.ok(methods.length>0&&methods.every(method=>method==='GET'||method==='HEAD'),'R2 is read live, GET and HEAD only');
 assert.equal(leaseRow().lease_id,LEASE,'the production lease is untouched by the run');
 assert.deepEqual(rows(copyFile,"SELECT lease_id, lease_until FROM projection_run WHERE projection='enrichment'"),[{lease_id:null,lease_until:null}],'the copy of the lease is released');
 const m=measured.measurement;
 assert.equal(m.run.manifest.routes.publishedEpg&&m.run.manifest.routes.discovery&&m.run.manifest.routes.ownerReview,true,'all three D1 routes were read from the copy');
 assert.equal(m.parity.report.measurement,true);assert.equal(m.parity.ledgerDigest,measured.summary.parityLedgerDigest);
 assert.ok(m.counts.select>100&&m.counts.leaseWrites>10&&m.counts.refused===0,JSON.stringify(m.counts));
 assert.deepEqual([m.expected.classes.film.map(item=>item[0]),m.actual.classes.film.map(item=>item[0])],[['film:alpha'],['film:kept']],'the private measurement keeps the keys');
 assert.doesNotMatch(JSON.stringify(measured.summary),/film:|Film alpha|letterboxd/,'the summary names no id');
 // REGRESSION (AIR-373, 11 Nov 2026): the reviewed view build stamps the owner localization onto the published EPG snapshot IN PLACE. First prove that this
 // fixture really has that effect with the merged buildExpected on its own (otherwise the regression below proves nothing), then that the tool is immune.
 {
  const owner={contractVersion:1,films:{alpha:{localization:{status:'reviewed',provenance:{authority:'owner'},value:'Alpha (owner)'}}},people:{}};
  const derived={publishedEpg:{generation:3,programmeRunId:'run-1',programme:structuredClone(programme),watchlist:structuredClone(watchlist)},ownerReviews:owner};
  const real=m.run.manifest,digest=value=>sha(stable(value));
  const manifest={...real,objects:[],routes:{publishedEpg:true,discovery:false,ownerReview:true},derived:{publishedEpg:{...real.derived.publishedEpg,sha256:digest({programme:derived.publishedEpg.programme,watchlist:derived.publishedEpg.watchlist})},ownerReviews:{generation:real.d1.after.owner.generation,sha256:digest(owner)}}};
  derived.publishedEpg.generation=real.derived.publishedEpg.generation;derived.publishedEpg.programmeRunId=real.derived.publishedEpg.programmeRunId;
  assert.deepEqual(verifyDerived(manifest,derived),[],'the stand-in manifest matches the untouched snapshot');
  buildExpected({manifest,bodies:{},derivedValues:derived,asOf:measured.measurement.asOf});
  assert.deepEqual(verifyDerived(manifest,derived),['derived_digest:publishedEpg'],'the merged view build changes the snapshot in place: the premise of this regression');
  assert.equal(derived.publishedEpg.programme.films[0].title,'Alpha (owner)');
  assert.deepEqual(m.run.derivedProblems,[],'the values handed to the measurement matched the manifest');
  assert.equal(m.run.derivedInputsMutatedByView,true,'the tool saw runParity change its input and only notes it');
  assert.equal(m.run.manifest.routes.publishedEpg,true);
  // the class entries the tool derived are the ones runParity compared: seal checks the ledger digest, and the entries here are those of a direct run
  assert.equal(measured.ok,true);
 }
 // THE TABLE LIST: the tables the reviewed code named in this run are exactly COPY_TABLES (a view counts as its tables)
 const objects=rows(copyFile,"SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'connector_copy_%'");
 const bare=text=>text.replace(/'(?:[^']|'')*'/g,"''");
 const used=new Set();
 // The diagnostics of runParity read the prediction fact tables only for a changed Film with a retained duplicate, which this fixture does not have: that one
 // reviewed statement (factsSql) is added to the trace by its text.
 for(const text of [...traced,factsSql()])for(const item of objects)if(new RegExp('\\b'+item.name+'\\b').test(bare(text))){
  if(item.type==='table')used.add(item.name);
  else for(const table of objects)if(table.type==='table'&&new RegExp('\\b'+table.name+'\\b').test(item.sql.replace(item.name,'')))used.add(table.name);
 }
 assert.deepEqual([...used].sort(),[...K.COPY_TABLES].sort(),'COPY_TABLES is what the reviewed readers select');
 // an incomplete or unverified copy, or a bad time, never runs
 assert.deepEqual((await K.runMeasurement({driver,plan,client:client(),asOf:'not a time'})).reasons,['run_invalid']);
}

// ---------- 7. T2, the release and the seal ----------
const t2=await check('T2');
const released=await execute(plan.functions.leaseRelease);
assert.equal(released.result.row[0].lease_id,null);
const files={t0:t0.file,t1:t1.file,t2:t2.file,resync:resync.file,release:released.file};
const sealed=await K.sealLedger({driver,plan,measurement:measured.measurement,files});
{
 assert.equal(sealed.ok,true,sealed.reasons.join());
 assert.equal(sealed.verified,true,sealed.report.verificationReasons.join());
 assert.deepEqual(sealed.report.verificationReasons,[]);
 assert.equal(sealed.ledger.source.verified,true);assert.equal(sealed.ledger.source.kind,'operator-copy');
 assert.deepEqual(sealed.gate.reasons,[]);assert.equal(sealed.gate.pass,true);
 assert.deepEqual(sealed.gate,await cutoverAcceptedGate(sealed.ledger));
 assert.deepEqual(sealed.gate.accepted.map(item=>item.id),['AIR-373-owner-link-values-2026-11-10','AIR-373-accepted-discrepancies-2026-11-11','AIR-373-operator-copy-2026-11-10']);
 assert.ok(sealed.ledger.totals.unexplained>0&&sealed.ledger.totals.differs===0);
 // the private ledger keeps every key; the report keeps none
 assert.equal(sealed.ledger.unexplainedList.length,sealed.ledger.totals.unexplained);assert.equal(sealed.ledger.unexplainedTruncated,false);
 assert.ok(sealed.ledger.unexplainedList.some(item=>item.class==='film'&&item.key==='film:kept'));
 const report=sealed.report;
 assert.deepEqual([report.gate,report.gateVersion,report.measurement,report.authorizes,report.sourceKind,report.verified,report.gatePass],['cutover_accepted',2,true,'nothing','operator-copy',true,true]);
 assert.equal(report.acceptedDigest,sealed.ledger.acceptedDigest);assert.equal(report.parityLedgerDigest,measured.measurement.parity.ledgerDigest);
 assert.deepEqual(report.coverage.film,{expected:1,actual:1,missing:1,extra:1,differs:0,explained:0,unexplained:2,cap:ACCEPTED_DISCREPANCIES.caps.film});
 assert.doesNotMatch(JSON.stringify(report),/film:|person:|Film alpha|Dir alpha|letterboxd|connector:test/,'no id, title, name or lease id in the report');
 assert.match(report.digest,/^[0-9a-f]{64}$/);
 // the ledger describes the same state a direct run of the reviewed measuring operation sees on "production"
 const direct=await runCutoverMinimum({client:client(),db:d1Standin(production),leaseId:'direct:test',asOf:measured.measurement.asOf});
 assert.equal(direct.ok,true,direct.reasons.join());
 for(const [name,entry] of Object.entries(direct.ledger.classes))if(!entry.unavailable)assert.deepEqual([sealed.ledger.classes[name].expected,sealed.ledger.classes[name].actual,sealed.ledger.classes[name].unexplained],[entry.expected,entry.actual,entry.unexplained],name);
 assert.equal(direct.verified,false,'and that direct synthetic run is still not verified');
}
// a padded T0, T2 and release (the operator's wrapper, AIR-373 of 11 Nov 2026) seal to the very same report; `pad` is ignored by seal as by load and verify
{
 const again=await K.sealLedger({driver,plan,measurement:measured.measurement,files:{...files,t0:padded(t0.file),t2:padded(t2.file),release:padded(released.file)}});
 assert.equal(again.ok,true,again.reasons?.join());
 assert.deepEqual(again.report,sealed.report,'seal: padded evidence gives the identical report');
 assert.deepEqual(again.ledger.digest,sealed.ledger.digest);
}

// ---------- 8. verified:false for each missing or inconsistent piece of evidence ----------
{
 const seal=over=>K.sealLedger({driver,plan,measurement:measured.measurement,files:{...files,...over}});
 const unverified=async(over,reason,label=reason)=>{
  const out=await seal(over);
  assert.equal(out.ok,true,label);assert.equal(out.verified,false,label);assert.equal(out.ledger.source.verified,false,label);
  assert.ok(out.report.verificationReasons.includes(reason),label+': '+out.report.verificationReasons.join());
  assert.equal(out.gate.pass,false,label);assert.ok(out.gate.reasons.includes('source_unverified')&&out.gate.reasons.includes('operator_copy:'+reason),label);
  return out;
 };
 const at=(file,id,change)=>altered(file,v=>{change(v.rows[v.ids.indexOf(id)]);});
 // production differs between T0, T1 and T2
 await unverified({t0:at(files.t0,'witness:film',r=>{r[0].n=5;})},'production_moved:witness:film');
 await unverified({t2:at(files.t2,'witness:projectionKey',r=>{r[0].n=5;})},'production_moved:witness:projectionKey');
 await unverified({t2:at(files.t2,'gate:marker',r=>{r[0].generation=1;})},'production_moved:gate:marker');
 await unverified({t2:at(files.t2,'count:film_metadata',r=>{r[0].n=1;})},'production_moved:count:film_metadata');
 // the copy was compared with another T1 than the one presented
 const otherT1=await unverified({t1:at(files.t1,'witness:credit',r=>{r[0].n=5;})},'copy_missing:witness:film');
 assert.ok(otherT1.report.verificationReasons.includes('production_moved:witness:credit'));
 // the Discovery resync: another file than the one applied, or none
 await unverified({resync:altered(files.resync,v=>{v.at=new Date(Date.parse(v.at)+1).toISOString();})},'discovery_resync_missing');
 await unverified({resync:path.join(root,'absent.json')},'discovery_resync_missing');
 // the production lease: not held, held by another id, expired, not released
 await unverified({t0:at(files.t0,'gate:lease',r=>{r[0].lease_id=null;})},'lease_not_held:t0');
 await unverified({t1:at(files.t1,'gate:lease',r=>{r[0].lease_id='connector:foreign-run';})},'lease_not_held:t1');
 await unverified({t2:at(files.t2,'gate:lease',r=>{r[0].lease_until=t0.result.at;})},'lease_not_held:t2');
 await unverified({t2:at(files.t2,'gate:lease',r=>{r.length=0;})},'lease_not_held:t2');
 await unverified({release:altered(files.release,v=>{v.row[0].lease_id=LEASE;})},'lease_not_released');
 await unverified({release:acquired.file},'lease_not_released');
 await unverified({release:path.join(root,'absent.json')},'lease_not_released');
 await unverified({release:altered(files.release,v=>{v.at=t0.result.at;})},'lease_not_released');
 // the order of the evidence
 await unverified({t2:altered(files.t2,v=>{v.at=t0.result.at;})},'evidence_order');
 // a check without one of the plan's counts is not a check of this plan
 assert.deepEqual((await seal({t2:altered(files.t2,v=>{const at=v.ids.indexOf('count:film_metadata');v.ids.splice(at,1);v.rows.splice(at,1);})})).reasons,['check_malformed']);
 // unusable evidence files refuse the seal outright
 assert.deepEqual((await seal({t2:files.t1})).reasons,['check_label:t2']);
 assert.deepEqual((await seal({t0:path.join(root,'absent.json')})).reasons,['evidence_unreadable']);
 assert.deepEqual((await seal({t0:altered(files.t0,v=>{v.written=3;})})).reasons,['check_malformed']);
 // a measurement that was edited, or that belongs to another plan
 const edited=JSON.parse(JSON.stringify(measured.measurement));edited.actual.classes.film.push(['film:alpha','[1,null,"Film alpha"]']);
 assert.deepEqual((await K.sealLedger({driver,plan,measurement:edited,files})).reasons,['measurement_invalid']);
 assert.deepEqual((await K.sealLedger({driver,plan,measurement:null,files})).reasons,['measurement_invalid']);
 // an incomplete probe or an inconsistent read recorded by the run
 const redo=change=>{const copy=JSON.parse(JSON.stringify(measured.measurement));const {digest,...core}=copy;change(core);return {...core,digest:sha(JSON.stringify(core,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v))};};
 const incomplete=await K.sealLedger({driver,plan,measurement:redo(core=>{core.run.cut.done=false;}),files});
 assert.equal(incomplete.verified,false);assert.ok(incomplete.report.verificationReasons.includes('probe_incomplete'));
 const etag=await K.sealLedger({driver,plan,measurement:redo(core=>{core.run.etagsAfterCut[0].etag='moved';}),files});
 assert.equal(etag.verified,false);assert.ok(etag.report.verificationReasons.includes('r2_etags_changed'),etag.report.verificationReasons.join());
 const inconsistent=await K.sealLedger({driver,plan,measurement:redo(core=>{core.run.cut.consistent=false;}),files});
 assert.equal(inconsistent.verified,false);assert.ok(inconsistent.report.verificationReasons.includes('inconsistent_read'));
 // the class entries were replaced after runParity measured them
 assert.deepEqual((await K.sealLedger({driver,plan,measurement:redo(core=>{core.actual.classes.film.push(['film:alpha','[1,null,"Film alpha"]']);}),files})).reasons,['parity_ledger_mismatch']);
 // there is no verdict argument
 const pushed=await K.sealLedger({driver,plan,measurement:measured.measurement,files:{...files,t2:at(files.t2,'witness:film',r=>{r[0].n=5;})},verified:true,source:{verified:true}});
 assert.equal(pushed.verified,false);
}

// ---------- 9. a run refuses when R2 changes after the cut ----------
{
 let armed=false,fired=false;
 const watching={file:driver.file,query:text=>driver.query(text),exec:script=>{driver.exec(script);if(armed&&!fired&&/SET lease_id=NULL/.test(script)&&script.includes(':ledger')){fired=true;put('titles.json',{moved:true});}}};
 armed=true;
 const out=await K.runMeasurement({driver:watching,plan,client:client(),asOf:new Date().toISOString()});
 assert.equal(fired,true);assert.equal(out.ok,false);assert.ok(out.reasons.includes('etag_changed_after_cut:titles'),out.reasons.join());
 assert.equal(out.measurement,undefined,'a refused run saves nothing');
 put('titles.json',{});
}

// ---------- 10. sql: exactly what the reviewed functions execute, and nothing for a failing ledger ----------
{
 const WHEN='2026-11-10T19:30:00.000Z';
 const emitted=await K.emitSql({driver,plan,ledger:sealed.ledger,expectedGeneration:0,at:WHEN});
 const reference='cutover_accepted/v2:'+sealed.ledger.acceptedDigest;
 assert.deepEqual([emitted.baselineRecord.artefact,emitted.baselineRecord.reference,emitted.baselineRecord.gate,emitted.baselineRecord.gateVersion,emitted.baselineRecord.expectedGeneration],['baseline_record',reference,'cutover_accepted',2,0]);
 assert.deepEqual(rows(copyFile,'SELECT state, reference FROM film_person_baseline'),[{state:'empty',reference:null}],'emitting executes nothing, not even in the copy');
 assert.deepEqual(rows(copyFile,'SELECT mode, generation FROM film_person_authority'),[{mode:'r2',generation:0}]);
 // the reviewed functions against a migrated stand-in WITH its triggers: the batches they send are the emitted statements
 const target=path.join(root,'target.sqlite');fs.copyFileSync(template,target);
 const sent=[];
 await recordBaselineVerified({DB:d1Standin(target,{onBatch:async list=>{sent.push(list.map(item=>item.text+';'));}})},{ledger:sealed.ledger,expectedGeneration:0,at:WHEN,path:RECORDING_PATHS.cutover_accepted});
 await transitionAuthority({DB:d1Standin(target,{onBatch:async list=>{sent.push(list.map(item=>item.text+';'));}})},{from:'r2',to:'prepared',expectedGeneration:0});
 assert.deepEqual(sent,[emitted.baselineRecord.sql.split('\n'),emitted.r2ToPrepared.sql.split('\n')]);
 assert.deepEqual(emitted.baselineRecord.fenceAssertions,[0,1],'both assertions of the record are named');
 assert.deepEqual(emitted.r2ToPrepared.fenceAssertions,[1]);
 assert.equal(emitted.baselineRecord.expectResults,4);assert.equal(emitted.r2ToPrepared.expectResults,2);
 for(const item of [emitted.baselineRecord,emitted.r2ToPrepared])assert.deepEqual(item.readBack,[GATE_STATEMENTS.marker,GATE_STATEMENTS.fence,GATE_STATEMENTS.baseline]);
 // the emitted text, sent as ONE request body to another migrated database, gives the read-back the artefact announces; the second needs the first
 const fresh=path.join(root,'fresh.sqlite');fs.copyFileSync(template,fresh);
 const one=text=>'BEGIN;\n'+text+'\nCOMMIT;';
 assert.throws(()=>sql(fresh,one(emitted.r2ToPrepared.sql)),/film_person_baseline_not_verified/,'r2 to prepared refuses without the verified baseline');
 sql(fresh,one(emitted.baselineRecord.sql));
 const readBack=()=>({marker:rows(fresh,GATE_STATEMENTS.marker).map(({mode,cutover,generation})=>({mode,cutover,generation}))[0],fence:{ok:rows(fresh,GATE_STATEMENTS.fence)[0].ok},baseline:rows(fresh,GATE_STATEMENTS.baseline).map(({state,reference})=>({state,reference}))[0]});
 assert.deepEqual(readBack(),emitted.baselineRecord.expectAfter);
 sql(fresh,one(emitted.r2ToPrepared.sql));
 assert.deepEqual(readBack(),emitted.r2ToPrepared.expectAfter);
 assert.deepEqual(emitted.r2ToPrepared.requires,{baseline:{state:'verified',reference}});
 // a ledger that fails the gate: the recorder throws and nothing is emitted
 const failing=(await K.sealLedger({driver,plan,measurement:measured.measurement,files:{...files,release:acquired.file}})).ledger;
 await assert.rejects(()=>K.emitSql({driver,plan,ledger:failing,expectedGeneration:0,at:WHEN}),error=>error.code==='baseline_gate_failed'&&error.reasons.includes('source_unverified'));
 const tampered=JSON.parse(JSON.stringify(sealed.ledger));tampered.cutoverAccepted.acceptance.caps.film=9999;
 await assert.rejects(()=>K.emitSql({driver,plan,ledger:tampered,expectedGeneration:0,at:WHEN}),error=>error.code==='baseline_gate_failed'&&error.reasons.includes('acceptance_not_permitted'));
 await assert.rejects(()=>K.emitSql({driver,plan,ledger:sealed.ledger,expectedGeneration:1,at:WHEN}),error=>error.code==='baseline_gate_failed'&&error.reasons.includes('ledger_generation_mismatch'));
 // the recording binding executes no batch and answers reads from the copy only
 const recording=K.recordingBinding(K.copyBinding(driver,plan.lease));
 await recording.batch([recording.prepare("UPDATE film_person_baseline SET state='verified'").bind()]);
 assert.equal(recording.batches.length,1);assert.deepEqual(rows(copyFile,'SELECT state FROM film_person_baseline'),[{state:'empty'}]);
}

// ---------- 11. the CLI writes nothing inside the repository; static: inactive ----------
{
 const cli=args=>spawnSync(process.execPath,['scripts/film-person-connector-run.mjs',...args],{encoding:'utf8'});
 const inside=cli(['plan','--out','connector-out']);
 assert.equal(inside.status,1);assert.match(inside.stderr,/STOP private_path_inside_repository/);assert.ok(!fs.existsSync('connector-out'));
 const out=path.join(root,'plan-out');
 const made=cli(['plan','--out',out,'--lease-id',LEASE]);
 assert.equal(made.status,0,made.stderr);assert.equal(JSON.parse(made.stdout).planDigest,plan.planDigest);
 assert.deepEqual(fs.readdirSync(out).sort(),['fn-check.js','fn-copy.js','fn-ddl.js','fn-leaseAcquire.js','fn-leaseRelease.js','fn-leaseRenew.js','fn-resync.js','plan.json']);
 assert.equal(fs.readFileSync(path.join(out,'fn-check.js'),'utf8').trim(),plan.functions.check);
 const loaded=cli(['load','--plan',path.join(out,'plan.json'),'--copy',copyFile,'--input',ddl.file]);
 assert.equal(loaded.status,1);assert.match(loaded.stderr,/STOP already_loaded/);
 assert.equal(cli(['nothing']).status,1);
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('film-person-connector'),file+' does not name the tool');
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&/film-person-connector/.test(fs.readFileSync(full,'utf8')))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers,[],'no source file names the tool');
 const text=fs.readFileSync('scripts/film-person-connector-run.mjs','utf8').replace(/\/\/.*$/gm,'');
 // the only network is the injected R2 client; the connector call exists only inside the emitted function texts; no D1 HTTP adapter, no bucket write
 assert.ok(!/\bfetch\(|createD1Adapter|openProductionSource|D1_BACKFILL|R2_INSTALL|\.put\(|\.delete\(/.test(text));
 assert.equal((text.match(/cloudflare\.request/g)||[]).length,1,'the connector is named once, in the text the operator runs');
 assert.equal((text.match(/process\.env/g)||[]).length,1,'the environment is read once, by the CLI, for the read-only R2 key');
 assert.doesNotMatch(text,/(sealLedger|runMeasurement)\(\{[^}]*\bverified\b/,'the verdict is not an argument');
}
server.close();
console.log('film-person-connector: ok ('+((Date.now()-started)/1000).toFixed(1)+' s)');
