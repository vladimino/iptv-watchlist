// AIR-373 (ADR 0099, ADR 0110; owner decisions of 10 Nov 2026): the CONNECTOR PATH as a reviewed tool. On 10 Nov 2026 the measuring run could not read D1 over
// HTTP (the token was refused), so by the owner's instruction the operator copied D1 through the Cloudflare API connector into a local sqlite file and ran the
// merged capture and parity against that copy. The bridging code of that day was ad hoc; this file replaces it.
// OFFLINE and INACTIVE: not bundled (build.mjs lists no such file), no Worker or `src/` import, no route, cron or job, no side effect at import. It NEVER calls
// the connector: only the human-facing operator session can. It emits the exact material the operator runs there (`plan`), loads what the operator saved
// (`load`), compares the copy with production (`verify`), runs the merged `captureProjectorInputs` and `runParity` UNMODIFIED against the copy with R2 read live
// through the injected read-only client (`run`), derives the source verdict from the evidence files and builds the ledger (`seal`), and renders the SQL the
// reviewed recorder and marker transition would execute (`sql`). Emitting SQL is not executing it: the baseline record and `r2` to `prepared` are two separate
// owner GOs, run by the operator through the connector.
// The only network this module can reach is the R2 read-only client it is given. The D1 side is the local copy: SELECTs only, plus the three projector-lease
// statements of the stage A cut applied to the COPY. The production lease is taken, renewed and released by the operator with the same three statements.
// WHAT `verified:true` MEANS HERE: operator attestation checked for completeness and consistency (src/film-person-cutover-accepted.js, operatorCopyReasons),
// permitted only by the pinned OPERATOR_COPY_PERMISSION. It is not cryptographic proof: the evidence files are plain JSON saved by the operator.
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {RECORDING_PATHS,buildParityLedger,contextFromActual,expectedFromInputs,readStableCut,readWitness,readerOf,recordBaselineVerified} from '../src/film-person-baseline.js';
import {transitionAuthority} from '../src/film-person-authority.js';
import {OWNER_LINK_WAIVER} from '../src/film-person-cutover-minimum.js';
import {ACCEPTED_DISCREPANCIES,COPY_TABLES,CUTOVER_ACCEPTED_GATE,CUTOVER_ACCEPTED_VERSION,DISCOVERY_COPY_TABLES,OPERATOR_COPY_KIND,OPERATOR_COPY_PERMISSION,buildCutoverAcceptedLedger,cutoverAcceptedGate,movingStatement} from '../src/film-person-cutover-accepted.js';
import {GATE_STATEMENTS,buildExpected,captureProjectorInputs,extraClasses,limitedClient,readCaptureGate,readOnlyBinding,runParity,verifyDerived,verifyManifest} from './film-person-capture.mjs';
import {deriveEvidence,readOwnerFacts} from './film-person-cutover-run.mjs';
import {assertReadOnly} from './schema-preflight.mjs';
import {renderSql} from './d1-backfill.mjs';
import {PRODUCTION_DATABASE_ID} from './metadata-cache-production.mjs';
import {createReadOnlyClient,readCredentials} from './r2-snapshot-export.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const CONNECTOR_VERSION=1;
// One connector result must stay under about 9 MB of JSON; a copy call stops adding pages at this many characters.
export const RESULT_BUDGET=8_000_000;
export const PAGE_ROWS=2000;
export const LEASE_TTL_MS=45*60000;
const stable=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const sha=text=>createHash('sha256').update(text).digest('hex');
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
export class ConnectorError extends Error{constructor(reason,detail){super(reason+(detail?': '+detail:''));this.name='ConnectorError';this.reason=reason;}}
const stop=(reason,detail)=>new ConnectorError(reason,detail);

// ---------- the tables that are copied ----------
// COPY_TABLES is defined once, in src/film-person-cutover-accepted.js, where the gate also derives the statement set it requires from it (requiredStatementIds),
// so the plan and the gate cannot drift. HOW THE LIST IS DERIVED. It is every table a statement of the run names: the witness and gate statements, the D1 readers of the capture with all three routes
// in D1 (published EPG, Discovery, owner reviews), the stage A cut with its AIR-286 check, the owner-review facts and the diagnostics of `runParity` (their
// prediction fact tables are read only for a changed Film with a retained duplicate; the test adds that one reviewed statement, `factsSql`, by its text). A view
// counts as the tables it selects from (`tmdb_retirement_current` reads `tmdb_retirement_decision`). tests/film-person-connector.mjs runs exactly that code
// against the sqlite stand-in with a tracing binding and asserts that the traced set EQUALS this list, so a reader that starts to read another table fails the
// test. The list is also safe when it is wrong: `load` creates EVERY table of the production DDL (the readers check that the published EPG and Discovery tables
// exist), but the binding of the copy refuses a SELECT that names a table whose copy is not complete (`connector_table_not_copied`), so an uncopied table is
// never read as empty. The Discovery tables come last: the Discovery Workflow keeps writing them, and the resync re-reads them.
export {COPY_TABLES};
const LOG_TABLES=['connector_copy_log','connector_copy_table'];

// ---------- the statements, taken from the reviewed code ----------
// The witness SQL is what readWitness sends (a recording reader, no database); the gate SQL is GATE_STATEMENTS; the three lease statements are what
// readStableCut sends (a recording reader that plays a held lease). Nothing here is typed again.
export async function witnessStatements(){
 const log=[];
 const names=Object.keys(await readWitness({get:async sql=>{log.push(sql);return {};}}));
 if(names.length!==log.length)throw stop('witness_recording_failed');
 return names.map((name,index)=>({id:'witness:'+name,sql:assertReadOnly(log[index])}));
}
export async function leaseStatements(){
 const at='2026-01-01T00:00:00.000Z',id='recording';
 const log=[];
 const row={lease_id:id,started_at:at,lease_until:'9999-01-01T00:00:00.000Z',mode:'r2',cutover:'open',generation:0,state:'empty',reference:null,n:0};
 await readStableCut({get:async()=>row,all:async()=>[],run:async sql=>{log.push(sql);}},{leaseId:id,now:()=>at});
 const unique=[...new Set(log)];
 const acquire=unique.filter(sql=>/^INSERT INTO projection_run /.test(sql)),release=unique.filter(sql=>/^UPDATE projection_run SET lease_id=NULL/.test(sql)),renew=unique.filter(sql=>/^UPDATE projection_run SET lease_until=\?/.test(sql));
 if(unique.length!==3||acquire.length!==1||renew.length!==1||release.length!==1)throw stop('lease_recording_failed');
 return {acquire:acquire[0],renew:renew[0],release:release[0]};
}
const countSql=table=>'SELECT COUNT(*) AS n, MAX(rowid) AS r FROM '+table;
// Per Discovery table, what production and the copy are compared on in the resync request. The two large tables by aggregates (weaker than the witness: a change
// that keeps every sum is not seen), the three one-row tables by their whole row.
export const resyncSql=table=>['discovery_admission','discovery_decision'].includes(table)?'SELECT COUNT(*) AS n, SUM(generation) AS a, SUM(length(payload_json)) AS b, MAX(generation) AS g FROM '+table:'SELECT * FROM '+table+' ORDER BY rowid';
export const DDL_SQL="SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index','view') AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name";
export const pageSql=table=>'SELECT rowid AS "__rowid", * FROM '+table+' WHERE rowid > ? ORDER BY rowid LIMIT ?';
export async function checkStatements(){
 return [...await witnessStatements(),...Object.entries(GATE_STATEMENTS).map(([id,sql])=>({id:'gate:'+id,sql:assertReadOnly(sql)})),...COPY_TABLES.map(table=>({id:'count:'+table,sql:assertReadOnly(countSql(table))}))];
}

// ---------- plan: the material the operator runs through the connector ----------
// Each `functions` entry is the text of one function for the connector's `execute` tool. `cloudflare` and `accountId` are provided by the connector.
const QUERY="const q=async(sql,params)=>{const r=await cloudflare.request({method:'POST',path:`/accounts/${accountId}/d1/database/${DB}/query`,body:params?{sql,params}:{sql}});const list=Array.isArray(r?.result)?r.result:null;if(!list||list.some(x=>!x||x.success!==true||!Array.isArray(x.results)))throw new Error('STOP d1_query_failed');return list;};";
const head=(planDigest,databaseId)=>'async()=>{const PLAN='+JSON.stringify(planDigest)+',DB='+JSON.stringify(databaseId)+';'+QUERY;
function functionsOf({planDigest,databaseId,statements,lease,leaseId,ttlMs}){
 const h=head(planDigest,databaseId),leaseRead=JSON.stringify(GATE_STATEMENTS.lease);
 const leaseFn=(action,body)=>h+'const LEASE='+JSON.stringify(leaseId)+',at=new Date().toISOString(),until=new Date(Date.now()+'+ttlMs+').toISOString();'+body+'const [read]=await q('+leaseRead+');return {kind:\'lease\',version:1,planDigest:PLAN,action:'+JSON.stringify(action)+',leaseId:LEASE,at,row:read.results};}';
 return {
  ddl:h+'const [r]=await q('+JSON.stringify(DDL_SQL)+');return {kind:\'ddl\',version:1,planDigest:PLAN,at:new Date().toISOString(),rows:r.results};}',
  // LABEL is T0, T1 or T2. All statements go in ONE request, so they are as close to one instant as the API allows.
  check:h+'const LABEL="T0";const IDS='+JSON.stringify(statements.map(item=>item.id))+',SQL='+JSON.stringify(statements.map(item=>item.sql))+';const list=await q(SQL.join(";\\n"));if(list.length!==SQL.length)throw new Error("STOP statement_count");return {kind:\'check\',version:1,planDigest:PLAN,label:LABEL,at:new Date().toISOString(),ids:IDS,rows:list.map(x=>x.results),written:list.reduce((n,x)=>n+Number(x.meta?.rows_written||0),0)};}',
  // CURSOR is null for the first call, then the `cursor` the previous result (and `load`) printed. Pages by rowid; the page size halves when a page is large.
  copy:h+'const CURSOR=null;const TABLES='+JSON.stringify(COPY_TABLES)+',BUDGET='+RESULT_BUDGET+';let i=CURSOR?CURSOR.i:0,after=CURSOR?CURSOR.after:0,limit=CURSOR?CURSOR.limit:'+PAGE_ROWS+',used=0;const chunks=[];while(i<TABLES.length){const [res]=await q(\'SELECT rowid AS "__rowid", * FROM \'+TABLES[i]+\' WHERE rowid > ? ORDER BY rowid LIMIT ?\',[after,limit]);const rows=res.results;const cols=rows.length?Object.keys(rows[0]).filter(c=>c!=="__rowid"):[];const packed=rows.map(r=>[r.__rowid,...cols.map(c=>r[c])]);const size=JSON.stringify(packed).length;if(used+size>BUDGET){if(chunks.length)break;if(limit>1){limit=Math.max(1,Math.floor(limit/2));continue;}throw new Error("STOP row_too_large");}const done=rows.length<limit,last=rows.length?rows[rows.length-1].__rowid:after;chunks.push({t:TABLES[i],from:after,cols,n:packed.length,rows:packed,after:last,done});used+=size;if(done){i++;after=0;}else after=last;if(size>BUDGET/4&&limit>1)limit=Math.max(1,Math.floor(limit/2));}return {kind:\'data\',version:1,planDigest:PLAN,at:new Date().toISOString(),chunks,cursor:i<TABLES.length?{i,after,limit}:null,done:i>=TABLES.length};}',
  // SINCE is the Discovery generation of the T0 check. The generation is read FIRST and LAST in this one request.
  resync:h+'const SINCE=0;const BUDGET='+RESULT_BUDGET+',G='+JSON.stringify(GATE_STATEMENTS.discovery)+';const pack=(t,rows)=>{const cols=rows.length?Object.keys(rows[0]).filter(c=>c!=="__rowid"):[];return {t,cols,n:rows.length,rows:rows.map(r=>[r.__rowid,...cols.map(c=>r[c])])};};const [first]=await q(G);const aggregates={};for(const [t,sql] of '+JSON.stringify(DISCOVERY_COPY_TABLES.map(table=>[table,resyncSql(table)]))+'){const [a]=await q(sql);aggregates[t]=a.results;}const delta=[],full=[];for(const t of ["discovery_admission","discovery_decision"]){const [d]=await q(\'SELECT rowid AS "__rowid", * FROM \'+t+\' WHERE generation >= ? ORDER BY rowid\',[SINCE]);delta.push(pack(t,d.results));}for(const t of ["discovery_authority","discovery_lease","discovery_transfer"]){const [f]=await q(\'SELECT rowid AS "__rowid", * FROM \'+t+\' ORDER BY rowid\');full.push(pack(t,f.results));}const [last]=await q(G);const out={kind:\'resync\',version:1,planDigest:PLAN,at:new Date().toISOString(),since:SINCE,first:first.results,last:last.results,aggregates,delta,full};out.truncated=JSON.stringify(out).length>BUDGET;if(out.truncated){out.delta=[];out.full=[];}return out;}',
  leaseAcquire:leaseFn('acquire','await q('+JSON.stringify(lease.acquire)+',["enrichment",LEASE,until,at,at]);'),
  leaseRenew:leaseFn('renew','await q('+JSON.stringify(lease.renew)+',[until,"enrichment",LEASE]);'),
  leaseRelease:leaseFn('release','await q('+JSON.stringify(lease.release)+',["enrichment",LEASE]);'),
 };
}
export async function buildPlan({databaseId=PRODUCTION_DATABASE_ID,leaseId='connector:'+randomUUID(),ttlMs=LEASE_TTL_MS}={}){
 if(typeof databaseId!=='string'||!/^[0-9a-f-]{36}$/.test(databaseId)||typeof leaseId!=='string'||!/^[A-Za-z0-9:._-]{8,80}$/.test(leaseId)||!Number.isInteger(ttlMs)||ttlMs<60000||ttlMs>60*60000)throw stop('plan_invalid');
 const statements=await checkStatements(),lease=await leaseStatements();
 // The digest names the reviewed material only (not the lease id of one run): every result file carries it, and a file of another plan is refused.
 const planDigest=sha(stable({version:CONNECTOR_VERSION,databaseId,statements,copyTables:COPY_TABLES,discoveryTables:DISCOVERY_COPY_TABLES,resync:DISCOVERY_COPY_TABLES.map(resyncSql),ddl:DDL_SQL,page:pageSql('<table>'),lease}));
 return {version:CONNECTOR_VERSION,planDigest,databaseId,leaseId,ttlMs,statements,copyTables:[...COPY_TABLES],discoveryTables:[...DISCOVERY_COPY_TABLES],lease,functions:functionsOf({planDigest,databaseId,statements,lease,leaseId,ttlMs})};
}

// ---------- the local copy ----------
// A driver over the sqlite3 CLI. `runner(args, input)` has the shape of spawnSync (the tests pass the suite's persistent session).
export function sqliteDriver(file,{runner=null}={}){
 const call=(args,input)=>runner?runner(args,input):spawnSync('sqlite3',args,{input,encoding:'utf8',maxBuffer:1<<30});
 return {file,
  exec(script){const result=call(['-bail',file],script);if(result.status!==0)throw stop('sqlite_failed',String(result.stderr).trim().slice(0,300));},
  query(sql){const result=call(['-json','-bail',file],sql+';');if(result.status!==0)throw new Error(String(result.stderr).trim()||'sqlite failed');const text=String(result.stdout).trim();return text?JSON.parse(text):[];},
 };
}
const quote=value=>"'"+String(value).replace(/'/g,"''")+"'";
const NAME=/^[A-Za-z_][A-Za-z0-9_]*$/;
// A connector result as the operator saved it: the JSON the function returned, or the MCP text wrapper around it.
export function parseResult(text){
 let value;
 try{value=JSON.parse(text);}catch{throw stop('result_unreadable');}
 if(Array.isArray(value)&&value.length===1&&value[0]?.type==='text'&&typeof value[0].text==='string'){try{value=JSON.parse(value[0].text);}catch{throw stop('result_unreadable');}}
 if(record(value)&&!value.kind&&record(value.result))value=value.result;
 if(!record(value)||typeof value.kind!=='string'||value.version!==1||typeof value.planDigest!=='string'||!Number.isFinite(Date.parse(value.at)))throw stop('result_malformed');
 return value;
}
const readResult=file=>{const text=fs.readFileSync(file,'utf8');return {value:parseResult(text),sha256:sha(text)};};
const hasLog=driver=>driver.query("SELECT name FROM sqlite_master WHERE type='table' AND name='connector_copy_log'").length===1;
export function copyState(driver){
 if(!hasLog(driver))return {ddl:false,tables:{},log:[]};
 const tables=Object.fromEntries(driver.query('SELECT name, last_rowid, row_count, done FROM connector_copy_table').map(row=>[row.name,{lastRowid:row.last_rowid,rows:row.row_count,done:row.done===1}]));
 const log=driver.query('SELECT seq, sha256, kind, label, at, detail FROM connector_copy_log ORDER BY seq').map(row=>({...row,detail:JSON.parse(row.detail)}));
 return {ddl:true,tables,log};
}
const logSql=(sha256,kind,label,at,detail)=>'INSERT INTO connector_copy_log (sha256,kind,label,at,detail) VALUES ('+[sha256,kind,label??null,at,JSON.stringify(detail)].map(value=>value===null?'NULL':quote(value)).join(',')+');';
const cell=value=>{
 if(value===null)return 'NULL';
 if(typeof value==='number'&&Number.isFinite(value))return String(value);
 if(typeof value==='string'&&!value.includes('\u0000'))return quote(value);
 throw stop('cell_unsupported');
};
function insertSql(driver,chunk,{replace=false}={}){
 if(!record(chunk)||typeof chunk.t!=='string'||!NAME.test(chunk.t)||!Array.isArray(chunk.cols)||!Array.isArray(chunk.rows)||chunk.n!==chunk.rows.length||!chunk.cols.every(name=>typeof name==='string'&&NAME.test(name)))throw stop('chunk_malformed');
 if(!chunk.rows.length)return '';
 const local=driver.query('SELECT name FROM pragma_table_info('+quote(chunk.t)+')').map(row=>row.name);
 if(stable(local)!==stable(chunk.cols))throw stop('columns_mismatch',chunk.t);
 const headSql='INSERT '+(replace?'OR REPLACE ':'')+'INTO '+chunk.t+' (rowid,'+chunk.cols.map(name=>'"'+name+'"').join(',')+') VALUES ';
 const out=[];
 for(let at=0;at<chunk.rows.length;at+=200){
  out.push(headSql+chunk.rows.slice(at,at+200).map(row=>{
   if(!Array.isArray(row)||row.length!==chunk.cols.length+1||!Number.isInteger(row[0]))throw stop('chunk_malformed',chunk.t);
   return '('+row.map(cell).join(',')+')';
  }).join(',')+';');
 }
 return out.join('\n');
}
const integrity=driver=>{const rows=driver.query('PRAGMA integrity_check');if(!(rows.length===1&&Object.values(rows[0])[0]==='ok'))throw stop('integrity_check_failed');};
const digestRows=rows=>sha(stable(rows));

// load: one saved connector result into the copy. DDL first (tables, indexes and views; no triggers), then data chunks in order, then resync results.
// Every file is applied in ONE transaction together with its log row, and a file that was already loaded (by the sha256 of its bytes) is refused.
export function loadResult(driver,file,plan){
 const {value,sha256}=readResult(file);
 if(value.planDigest!==plan.planDigest)throw stop('plan_mismatch');
 const state=copyState(driver);
 if(state.log.some(row=>row.sha256===sha256))throw stop('already_loaded');
 if(value.kind==='ddl'){
  if(state.ddl||driver.query("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")[0].n!==0)throw stop('copy_not_empty');
  if(!Array.isArray(value.rows))throw stop('result_malformed');
  const rows=value.rows.filter(row=>record(row)&&['table','index','view'].includes(row.type)&&typeof row.sql==='string'&&typeof row.name==='string'&&!/^(sqlite_|_cf_|connector_copy_)/i.test(row.name));
  if(rows.length!==value.rows.length)throw stop('ddl_malformed');
  const names=new Set(rows.filter(row=>row.type==='table').map(row=>row.name));
  const missing=COPY_TABLES.filter(table=>!names.has(table));
  if(missing.length)throw stop('ddl_incomplete',missing.join(','));
  const order=type=>rows.filter(row=>row.type===type).map(row=>row.sql.trim().replace(/;+$/,'')+';');
  driver.exec('PRAGMA journal_mode=DELETE;\nBEGIN;\n'+[...order('table'),...order('index'),...order('view')].join('\n')+'\nCREATE TABLE connector_copy_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, sha256 TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, label TEXT, at TEXT NOT NULL, detail TEXT NOT NULL);\nCREATE TABLE connector_copy_table (name TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL, row_count INTEGER NOT NULL, done INTEGER NOT NULL);\n'+logSql(sha256,'ddl',null,value.at,{tables:names.size,indexes:rows.filter(row=>row.type==='index').length,views:rows.filter(row=>row.type==='view').length})+'\nCOMMIT;');
  integrity(driver);
  return {kind:'ddl',tables:names.size,cursor:null,done:false};
 }
 if(!state.ddl)throw stop('ddl_not_loaded');
 if(value.kind==='data'){
  if(!Array.isArray(value.chunks))throw stop('result_malformed');
  const tables=JSON.parse(JSON.stringify(state.tables)),script=[],loaded={};
  for(const chunk of value.chunks){
   if(!COPY_TABLES.includes(chunk?.t))throw stop('table_not_in_plan',String(chunk?.t));
   const current=tables[chunk.t]||{lastRowid:0,rows:0,done:false};
   if(current.done)throw stop('table_already_complete',chunk.t);
   // continuity: this chunk was read from exactly where the previous one ended, and its rows are in rowid order after that point
   if(chunk.from!==current.lastRowid)throw stop('chunk_out_of_order',chunk.t);
   script.push(insertSql(driver,chunk));
   let last=current.lastRowid;
   for(const row of chunk.rows){if(!(row[0]>last))throw stop('chunk_out_of_order',chunk.t);last=row[0];}
   if(chunk.after!==last||typeof chunk.done!=='boolean')throw stop('chunk_malformed',chunk.t);
   tables[chunk.t]={lastRowid:last,rows:current.rows+chunk.rows.length,done:chunk.done};
   loaded[chunk.t]=(loaded[chunk.t]||0)+chunk.rows.length;
  }
  for(const [name,item] of Object.entries(tables))script.push('INSERT INTO connector_copy_table (name,last_rowid,row_count,done) VALUES ('+quote(name)+','+item.lastRowid+','+item.rows+','+(item.done?1:0)+') ON CONFLICT(name) DO UPDATE SET last_rowid=excluded.last_rowid,row_count=excluded.row_count,done=excluded.done;');
  driver.exec('BEGIN;\n'+script.filter(Boolean).join('\n')+'\n'+logSql(sha256,'data',null,value.at,{loaded,cursor:value.cursor??null})+'\nCOMMIT;');
  integrity(driver);
  const done=COPY_TABLES.every(table=>tables[table]?.done===true);
  return {kind:'data',loaded,cursor:value.cursor??null,done};
 }
 if(value.kind==='resync'){
  if(!COPY_TABLES.every(table=>state.tables[table]?.done===true))throw stop('copy_incomplete');
  if(value.truncated!==false)throw stop('resync_truncated');
  const generation=rows=>Array.isArray(rows)&&rows.length===1&&Number.isInteger(rows[0]?.generation)?rows[0].generation:null;
  const first=generation(value.first),last=generation(value.last);
  if(first===null||last===null)throw stop('result_malformed');
  // The generation moved inside the request: the rows are not one state. Nothing is applied; the operator sends the request again.
  if(first!==last)throw stop('discovery_generation_moved');
  if(!Number.isInteger(value.since)||!record(value.aggregates)||!Array.isArray(value.delta)||!Array.isArray(value.full))throw stop('result_malformed');
  const script=[];
  const want=(list,names)=>{if(stable(list.map(chunk=>chunk?.t).sort())!==stable([...names].sort()))throw stop('result_malformed');};
  want(value.delta,['discovery_admission','discovery_decision']);want(value.full,['discovery_authority','discovery_lease','discovery_transfer']);
  for(const chunk of value.full){script.push('DELETE FROM '+chunk.t+';');script.push(insertSql(driver,chunk));}
  for(const chunk of value.delta)script.push(insertSql(driver,chunk,{replace:true}));
  driver.exec('BEGIN;\n'+script.filter(Boolean).join('\n')+'\nCOMMIT;');
  integrity(driver);
  const production={},copy={};
  for(const table of DISCOVERY_COPY_TABLES){
   if(!Array.isArray(value.aggregates[table]))throw stop('result_malformed');
   production[table]=digestRows(value.aggregates[table]);copy[table]=digestRows(driver.query(resyncSql(table)));
  }
  const equal=DISCOVERY_COPY_TABLES.every(table=>production[table]===copy[table]);
  driver.exec(logSql(sha256,'resync',null,value.at,{since:value.since,generationFirst:first,generationLast:last,production,copy,equal}));
  return {kind:'resync',generation:last,equal,tables:Object.fromEntries(DISCOVERY_COPY_TABLES.map(table=>[table,production[table]===copy[table]]))};
 }
 throw stop('result_kind_unknown');
}

// The D1 binding over the copy. A read is ONE read-only SELECT (the schema preflight's assertReadOnly) that names no table whose copy is not complete; a
// write is one of the three lease statements, applied to the copy. There is no batch. `counts` says what was let through and what was refused.
export function copyBinding(driver,lease){
 const state=copyState(driver);
 const objects=driver.query("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view')");
 const bare=sql=>String(sql).replace(/'(?:[^']|'')*'/g,"''");
 const named=sql=>{const text=bare(sql);return objects.filter(item=>new RegExp('\\b'+item.name+'\\b').test(text)).map(item=>item.name);};
 const complete=new Set(Object.entries(state.tables).filter(([,item])=>item.done).map(([name])=>name));
 const viewTables=new Map(objects.filter(item=>item.type==='view').map(item=>[item.name,named(item.sql.replace(new RegExp('\\b'+item.name+'\\b'),''))]));
 const readable=name=>name==='sqlite_master'||(viewTables.has(name)?viewTables.get(name).every(table=>complete.has(table)):complete.has(name));
 const writes=new Set(Object.values(lease));
 const counts={select:0,leaseWrites:0,refused:0};
 const refuse=reason=>{counts.refused++;return stop(reason);};
 const read=(sql,params)=>{
  let text;
  try{text=assertReadOnly(sql);}catch{throw refuse('connector_statement_refused');}
  if(named(text).some(name=>LOG_TABLES.includes(name)||!readable(name)))throw refuse('connector_table_not_copied');
  counts.select++;
  return driver.query(renderSql(text,params));
 };
 return {counts,prepare(sql){
  const statement=params=>({
   async first(){return read(sql,params)[0]??null;},
   async all(){return {results:read(sql,params)};},
   async run(){if(!writes.has(sql))throw refuse('connector_statement_refused');counts.leaseWrites++;driver.exec(renderSql(sql,params)+';');return {success:true};},
  });
  return {bind:(...params)=>statement(params),...statement([])};
 }};
}

// ---------- verify ----------
const leaseOf=rows=>Array.isArray(rows)&&rows.length===1&&record(rows[0])?{id:rows[0].lease_id??null,startedAt:rows[0].started_at??null,until:rows[0].lease_until??null}:null;
export function parseCheck(value,plan){
 if(value.kind!=='check'||value.planDigest!==plan.planDigest)throw stop(value.kind==='check'?'plan_mismatch':'result_kind_unknown');
 const ids=plan.statements.map(item=>item.id);
 if(!['T0','T1','T2'].includes(value.label)||stable(value.ids)!==stable(ids)||!Array.isArray(value.rows)||value.rows.length!==ids.length||!value.rows.every(Array.isArray)||value.written!==0)throw stop('check_malformed');
 const rows=Object.fromEntries(ids.map((id,index)=>[id,value.rows[index]]));
 return {label:value.label,at:value.at,rows,digests:Object.fromEntries(ids.map(id=>[id,digestRows(rows[id])])),lease:leaseOf(rows['gate:lease'])};
}
// Two production reads, statement by statement. `moving` marks the Discovery statements that are allowed to differ; the lease row is compared by holder.
export function compareChecks(a,b){
 const statements=Object.keys(a.digests).map(id=>({id,equal:id==='gate:lease'?!!a.lease&&!!b.lease&&a.lease.id===b.lease.id&&a.lease.startedAt===b.lease.startedAt:a.digests[id]===b.digests[id],moving:movingStatement(id)}));
 return {a:a.label,b:b.label,statements,equal:statements.every(item=>item.equal||item.moving)};
}
// The copy against one production read: every statement is run on the copy and compared. The result is stored in the copy's log (the T1 comparison is evidence).
export async function verifyCopy(driver,file,plan){
 const {value,sha256}=readResult(file);
 const check=parseCheck(value,plan);
 const binding=copyBinding(driver,plan.lease);
 const statements=[],digests={};let lease=null;
 for(const item of plan.statements){
  let rows=null,refused=null;
  try{rows=(await binding.prepare(item.sql).all()).results;}catch(error){refused=error instanceof ConnectorError?error.reason:'sqlite_failed';}
  if(rows){digests[item.id]=digestRows(rows);if(item.id==='gate:lease')lease=leaseOf(rows);}
  const equal=!!rows&&(item.id==='gate:lease'?!!lease&&!!check.lease&&lease.id===check.lease.id&&lease.startedAt===check.lease.startedAt:digests[item.id]===check.digests[item.id]);
  statements.push({id:item.id,equal,moving:movingStatement(item.id),...(refused?{refused}:{})});
 }
 const equal=statements.every(item=>item.equal||item.moving);
 const detail={digests,lease:lease?{id:lease.id,startedAt:lease.startedAt}:null,equal,unequal:statements.filter(item=>!item.equal).map(item=>item.id)};
 driver.exec("DELETE FROM connector_copy_log WHERE sha256="+quote(sha256)+" AND kind='verify';\n"+logSql(sha256,'verify',check.label,check.at,detail));
 return {label:check.label,at:check.at,statements,equal};
}

// ---------- run: the merged capture and parity against the copy ----------
const privatePath=file=>{const full=path.resolve(file);if(!path.relative(ROOT,full).startsWith('..'))throw stop('private_path_inside_repository');return full;};
const writePrivate=(file,value)=>{const full=privatePath(file);fs.mkdirSync(path.dirname(full),{recursive:true});fs.writeFileSync(full,JSON.stringify(value),{mode:0o600});return full;};
const lastOf=(state,kind,label=null)=>state.log.filter(row=>row.kind===kind&&(label===null||row.label===label)).pop()??null;
// client: the read-only R2 client (createReadOnlyClient). Result: {ok, reasons, measurement?, summary?}. The measurement holds keys and values: it is PRIVATE.
export async function runMeasurement({driver,plan,client,asOf,now=()=>new Date().toISOString(),leaseId='connector-local:'+randomUUID()}){
 if(typeof asOf!=='string'||!Number.isFinite(Date.parse(asOf)))return {ok:false,reasons:['run_invalid']};
 const state=copyState(driver);
 if(!state.ddl||!COPY_TABLES.every(table=>state.tables[table]?.done===true))return {ok:false,reasons:['copy_incomplete']};
 const verified=lastOf(state,'verify','T1'),resync=lastOf(state,'resync');
 if(!verified||verified.detail.equal!==true)return {ok:false,reasons:['copy_not_verified_at_t1']};
 if(!resync||resync.detail.equal!==true||resync.seq<verified.seq)return {ok:false,reasons:['discovery_not_resynced']};
 const binding=copyBinding(driver,plan.lease);
 const guarded=readOnlyBinding(binding);
 // The copy carries the PRODUCTION lease row of this run (the operator holds it). The reviewed code refuses to run under a live lease, so that row is released
 // IN THE COPY, by its own id, with the reviewed release statement. Production is not touched.
 const held=verified.detail.lease?.id;
 if(typeof held!=='string'||!held)return {ok:false,reasons:['production_lease_not_in_copy']};
 await binding.prepare(plan.lease.release).bind('enrichment',held).run();
 const run={version:1,leaseId:leaseId+':ledger',gates:{},witness:{},ownerFacts:{}};
 try{run.ownerFacts.before=await readOwnerFacts(guarded);}catch{return {ok:false,reasons:['owner_facts_unreadable']};}
 const cap=await captureProjectorInputs({client,db:binding,now});
 if(!cap.ok)return {ok:false,reasons:cap.reasons.map(item=>'capture:'+item)};
 const manifest=cap.manifest;
 // the measurement of record: the merged runParity, unmodified
 const parity=await runParity({manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,db:binding,client,leaseId,asOf,now});
 if(!parity.ok||!parity.ledger)return {ok:false,reasons:parity.reasons.map(item=>'parity:'+item)};
 // The cutover ledger needs the class entries, which runParity does not return. They are read again from the SAME copy with the same reviewed functions, and
 // the resulting parity ledger must have the digest of runParity's ledger (checked in `seal`), so this second read can never describe another state.
 run.manifest=manifest;run.manifestProblems=verifyManifest(manifest,cap.bodies);run.derivedProblems=verifyDerived(manifest,cap.derivedValues);
 run.gates.captureBefore=manifest.d1.before;run.gates.captureAfter=manifest.d1.after;
 run.witness.captureBefore=manifest.witness.before;run.witness.captureAfter=manifest.witness.after;
 let classes,cut;
 try{
  run.gates.parityBefore=await readCaptureGate(guarded,{now});run.witness.parityBefore=await readWitness(readerOf(guarded));
  const built=buildExpected({manifest,bodies:cap.bodies,derivedValues:cap.derivedValues,asOf});
  classes=expectedFromInputs(built.inputs,extraClasses({...built,asOf}));
  cut=await readStableCut(readerOf(binding),{leaseId:run.leaseId,now});
  run.cut={done:cut.done===true,consistent:cut.consistent===true,reasons:cut.reasons,unavailable:cut.unavailable??null,pages:cut.pages,leaseBefore:cut.gateBefore?.lease??null,leaseAfter:cut.gateAfter?.lease??null};
  run.gates.parityAfter=await readCaptureGate(guarded,{now});
  const limited=limitedClient(client,()=>manifest.runId);
  run.etagsAfterCut=[];
  for(const entry of manifest.objects){
   let current;
   try{current=await limited.head(entry.key);}catch{run.etagsAfterCut.push({key:entry.key,error:true});continue;}
   run.etagsAfterCut.push(current?{key:entry.key,state:'present',etag:current.etag}:{key:entry.key,state:'absent',etag:null});
  }
  run.witness.parityAfter=await readWitness(readerOf(guarded));run.ownerFacts.after=await readOwnerFacts(guarded);
 }catch(error){return {ok:false,reasons:[error instanceof ConnectorError?error.reason:'ledger_read_failed']};}
 const {reasons}=deriveEvidence(run);
 if(reasons.length)return {ok:false,reasons};
 const core={kind:'measurement',version:1,planDigest:plan.planDigest,asOf,finishedAt:now(),verifySha256:verified.sha256,resyncSha256:resync.sha256,run,
  expected:{classes,unavailable:['ownerLink'],complete:true},actual:{classes:cut.entries,unavailable:cut.unavailable,consistent:true,complete:true},air286:cut.air286.verified,
  parity:{ledgerDigest:parity.ledger.digest,totals:parity.ledger.totals,report:parity.report},counts:binding.counts};
 return {ok:true,reasons:[],measurement:{...core,digest:sha(stable(core))},summary:{manifestDigest:manifest.digest,parityLedgerDigest:parity.ledger.digest,totals:parity.ledger.totals,counts:binding.counts}};
}

// ---------- seal: the source verdict from the evidence files, then the ledger ----------
// files: {t0,t1,t2,resync,release} paths of saved connector results. Nothing here is a verdict argument: `verified` is derived by buildCutoverAcceptedLedger.
export async function sealLedger({driver,plan,measurement,files}){
 const {digest,...core}=measurement||{};
 if(core.kind!=='measurement'||core.version!==1||sha(stable(core))!==digest)return {ok:false,reasons:['measurement_invalid']};
 if(core.planDigest!==plan.planDigest)return {ok:false,reasons:['plan_mismatch']};
 const state=copyState(driver);
 const checks={},shas={};
 try{
  for(const stage of ['t0','t1','t2']){
   const {value,sha256}=readResult(files[stage]);
   const check=parseCheck(value,plan);
   if(check.label!==stage.toUpperCase())return {ok:false,reasons:['check_label:'+stage]};
   checks[stage]={at:check.at,digests:check.digests,lease:check.lease};shas[stage]=sha256;
  }
 }catch(error){return {ok:false,reasons:[error instanceof ConnectorError?error.reason:'evidence_unreadable']};}
 // the T1 comparison and the resync are the ones the run was made after, and no later resync changed the copy
 const verify=state.log.find(row=>row.kind==='verify'&&row.sha256===shas.t1&&row.sha256===core.verifySha256);
 let resyncSha=null,release=null;
 try{resyncSha=sha(fs.readFileSync(files.resync,'utf8'));release=readResult(files.release).value;}catch{}
 const resync=state.log.find(row=>row.kind==='resync'&&row.sha256===resyncSha&&row.sha256===core.resyncSha256&&row.seq===lastOf(state,'resync')?.seq);
 const released=release&&release.kind==='lease'&&release.action==='release'&&release.planDigest===plan.planDigest?{at:release.at,id:Array.isArray(release.row)&&release.row.length===1?release.row[0]?.lease_id??null:undefined}:null;
 const {evidence}=deriveEvidence(core.run);
 const operatorCopy={version:1,leaseId:checks.t0.lease?.id??null,checks,
  copy:verify?{t1:{digests:verify.detail.digests,lease:verify.detail.lease}}:null,
  released,
  discovery:resync?{at:resync.at,generationFirst:resync.detail.generationFirst,generationLast:resync.detail.generationLast,production:resync.detail.production,copy:resync.detail.copy}:null,
  r2:{manifestDigest:evidence?.manifestDigest??null,etagsBefore:evidence?.r2Etags?.before??null,etagsAfter:evidence?.r2Etags?.after??null},
  probeComplete:evidence?.probeComplete===true,readConsistent:core.actual?.consistent===true&&core.run?.cut?.consistent===true};
 const gateAfter=core.run.gates.parityAfter;
 const built=await buildCutoverAcceptedLedger({
  expected:core.expected,actual:core.actual,
  context:contextFromActual({classes:core.actual.classes},{air286:core.air286}),
  source:{aggregateSha256:core.run.manifest.digest,kind:OPERATOR_COPY_KIND},
  ownerLink:{authority:{mode:gateAfter.owner.mode,generation:gateAfter.owner.generation},factsBefore:core.run.ownerFacts.before,factsAfter:core.run.ownerFacts.after},
  evidence,waivers:[{...OWNER_LINK_WAIVER}],
  acceptance:ACCEPTED_DISCREPANCIES,permission:OPERATOR_COPY_PERMISSION,operatorCopy,
  // the private ledger keeps EVERY key of every difference (the measurement of 10 Nov 2026 lost them)
  listCap:Number.MAX_SAFE_INTEGER,
 });
 const ledger=built.ledger;
 // The ledger must describe the state runParity measured: same parity core, apart from the source verdict this step derives.
 const {ledger:unverified}=await buildParityLedger({expected:core.expected,actual:core.actual,context:contextFromActual({classes:core.actual.classes},{air286:core.air286}),source:{aggregateSha256:core.run.manifest.digest,verified:false,kind:'projector-input-capture'},listCap:0});
 if(unverified.digest!==core.parity.ledgerDigest)return {ok:false,reasons:['parity_ledger_mismatch']};
 const gate=await cutoverAcceptedGate(ledger);
 const coverage=Object.fromEntries(Object.entries(ledger.classes).map(([name,entry])=>[name,entry.unavailable?{unavailable:true}:{expected:entry.expected.count,actual:entry.actual.count,missing:entry.missing,extra:entry.extra,differs:entry.differs,explained:entry.explained.total,unexplained:entry.unexplained.total,cap:ACCEPTED_DISCREPANCIES.caps[name]??null}]));
 const report={reportVersion:1,gate:CUTOVER_ACCEPTED_GATE,gateVersion:CUTOVER_ACCEPTED_VERSION,measurement:true,authorizes:'nothing',sourceKind:OPERATOR_COPY_KIND,verified:built.verified,verificationReasons:built.verification,
  gatePass:gate.pass,gateReasons:gate.reasons,accepted:gate.accepted,notProved:gate.notProved,manifestDigest:core.run.manifest.digest,parityLedgerDigest:core.parity.ledgerDigest,ledgerDigest:ledger.digest,cutoverDigest:ledger.cutoverDigest,acceptedDigest:ledger.acceptedDigest,
  asOf:core.asOf,evidenceAt:{t0:checks.t0.at,t1:checks.t1.at,resync:resync?.at??null,t2:checks.t2.at,released:released?.at??null},markerGeneration:gateAfter.marker.generation,totals:ledger.totals,coverage};
 return {ok:true,reasons:[],verified:built.verified,ledger,gate,report:{...report,digest:sha(stable(report))}};
}

// ---------- sql: what the reviewed recorder and transition would execute ----------
// The statements are obtained by running `recordBaselineVerified` and `transitionAuthority` against a RECORDING binding: reads are answered by the copy
// (SELECT only), a batch is recorded and not executed. A ledger that fails the gate throws in the recorder and nothing is emitted.
export function recordingBinding(reader){
 const batches=[];
 return {batches,prepare(sql){
  const statement=params=>({sql,params,first:()=>reader.prepare(sql).bind(...params).first(),all:()=>reader.prepare(sql).bind(...params).all()});
  return {bind:(...params)=>statement(params),...statement([])};
 },async batch(list){batches.push(list.map(item=>({sql:item.sql,params:item.params})));return list.map(()=>({success:true}));}};
}
const artefact=(name,statements,extra)=>{
 const rendered=statements.map(item=>renderSql(item.sql,item.params)+';');
 // One request, body {sql}: the statements joined by newlines, as the D1 adapter of scripts/d1-backfill.mjs sends a write unit. Every result must be success.
 const core={artefact:name,statements,sql:rendered.join('\n'),fenceAssertions:statements.map((item,index)=>/^INSERT INTO film_person_cas /.test(item.sql)?index:-1).filter(index=>index>=0),expectResults:statements.length,
  readBack:[GATE_STATEMENTS.marker,GATE_STATEMENTS.fence,GATE_STATEMENTS.baseline],...extra};
 return {...core,digest:sha(stable(core))};
};
export async function emitSql({driver,plan,ledger,expectedGeneration,at}){
 const binding=recordingBinding(copyBinding(driver,plan.lease));
 const recorded=await recordBaselineVerified({DB:binding},{ledger,expectedGeneration,at,path:RECORDING_PATHS.cutover_accepted});
 if(recorded.already||binding.batches.length!==1)throw stop('baseline_already_recorded_in_copy');
 const record1=artefact('baseline_record',binding.batches[0],{gate:CUTOVER_ACCEPTED_GATE,gateVersion:CUTOVER_ACCEPTED_VERSION,reference:recorded.reference,expectedGeneration,at,
  expectAfter:{marker:{mode:'r2',cutover:'open',generation:expectedGeneration},fence:{ok:1},baseline:{state:'verified',reference:recorded.reference}}});
 const second=recordingBinding(copyBinding(driver,plan.lease));
 await transitionAuthority({DB:second},{from:'r2',to:'prepared',expectedGeneration});
 if(second.batches.length!==1)throw stop('transition_not_recorded');
 const record2=artefact('r2_to_prepared',second.batches[0],{from:'r2',to:'prepared',expectedGeneration,requires:{baseline:{state:'verified',reference:recorded.reference}},
  expectAfter:{marker:{mode:'prepared',cutover:'open',generation:expectedGeneration+1},fence:{ok:1},baseline:{state:'verified',reference:recorded.reference}}});
 return {baselineRecord:record1,r2ToPrepared:record2};
}

// ---------- CLI ----------
const USAGE=`Usage: node scripts/film-person-connector-run.mjs <command> [options]
  plan    --out DIR [--lease-id ID]                       plan.json and one .js file per connector function
  load    --plan PLAN --copy FILE --input RESULT          a saved connector result (ddl, data or resync) into the copy
  verify  --plan PLAN --copy FILE --input CHECK           the copy against one production check
  verify  --plan PLAN --compare CHECK_A CHECK_B           two production checks against each other
  run     --plan PLAN --copy FILE --out DIR               capture and parity against the copy (R2_SNAPSHOT_* in the environment)
  seal    --plan PLAN --copy FILE --measurement FILE --t0 F --t1 F --t2 F --resync F --release F --out DIR
  sql     --plan PLAN --copy FILE --ledger FILE --generation N --at ISO --out DIR
Every --out and every private file must be OUTSIDE the repository. Nothing here calls the connector or writes to production.`;
async function main(argv){
 const [command,...rest]=argv;
 const option=name=>{const index=rest.indexOf('--'+name);return index>=0?rest[index+1]:undefined;};
 const need=name=>{const value=option(name);if(!value)throw stop('usage','--'+name);return value;};
 const print=value=>console.log(JSON.stringify(value,null,1));
 if(command==='plan'){
  const out=privatePath(need('out')),plan=await buildPlan(option('lease-id')?{leaseId:option('lease-id')}:{});
  writePrivate(path.join(out,'plan.json'),plan);
  for(const [name,text] of Object.entries(plan.functions))fs.writeFileSync(path.join(out,'fn-'+name+'.js'),text+'\n',{mode:0o600});
  return print({planDigest:plan.planDigest,leaseId:plan.leaseId,statements:plan.statements.length,copyTables:plan.copyTables.length,out});
 }
 const plan=JSON.parse(fs.readFileSync(need('plan'),'utf8'));
 const fresh=await buildPlan({databaseId:plan.databaseId,leaseId:plan.leaseId,ttlMs:plan.ttlMs});
 if(fresh.planDigest!==plan.planDigest)throw stop('plan_stale');
 if(command==='verify'&&rest.includes('--compare')){const at=rest.indexOf('--compare');return print(compareChecks(parseCheck(readResult(rest[at+1]).value,fresh),parseCheck(readResult(rest[at+2]).value,fresh)));}
 const driver=sqliteDriver(privatePath(need('copy')));
 if(command==='load')return print(loadResult(driver,need('input'),fresh));
 if(command==='verify')return print(await verifyCopy(driver,need('input'),fresh));
 if(command==='run'){
  const out=privatePath(need('out'));
  const result=await runMeasurement({driver,plan:fresh,client:createReadOnlyClient({credentials:readCredentials(process.env),retries:2}),asOf:new Date().toISOString()});
  if(result.ok)writePrivate(path.join(out,'measurement.private.json'),result.measurement);
  process.exitCode=result.ok?0:2;
  return print({ok:result.ok,reasons:result.reasons,summary:result.summary??null});
 }
 if(command==='seal'){
  const out=privatePath(need('out'));
  const result=await sealLedger({driver,plan:fresh,measurement:JSON.parse(fs.readFileSync(need('measurement'),'utf8')),files:{t0:need('t0'),t1:need('t1'),t2:need('t2'),resync:need('resync'),release:need('release')}});
  if(result.ok){writePrivate(path.join(out,'ledger.private.json'),result.ledger);writePrivate(path.join(out,'report.json'),result.report);}
  process.exitCode=result.ok&&result.gate.pass?0:2;
  return print(result.ok?result.report:{ok:false,reasons:result.reasons});
 }
 if(command==='sql'){
  const out=privatePath(need('out')),generation=Number(need('generation'));
  const emitted=await emitSql({driver,plan:fresh,ledger:JSON.parse(fs.readFileSync(need('ledger'),'utf8')),expectedGeneration:generation,at:need('at')});
  writePrivate(path.join(out,'sql-baseline-record.json'),emitted.baselineRecord);writePrivate(path.join(out,'sql-r2-to-prepared.json'),emitted.r2ToPrepared);
  return print({baselineRecord:{reference:emitted.baselineRecord.reference,statements:emitted.baselineRecord.statements.length,digest:emitted.baselineRecord.digest},r2ToPrepared:{statements:emitted.r2ToPrepared.statements.length,digest:emitted.r2ToPrepared.digest},note:'emitted, not executed: each is a separate owner GO'});
 }
 throw stop('usage');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch(error=>{console.error(error instanceof ConnectorError?'STOP '+error.message:'STOP '+String(error?.reasons?error.code+': '+error.reasons.join(', '):error?.code||error?.message||error));if(error instanceof ConnectorError&&error.reason==='usage')console.error(USAGE);process.exitCode=1;});
}
