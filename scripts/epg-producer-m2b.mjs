// AIR-374 M2b, STEP 0 (ADR 0128 staged plan): the OFFLINE tooling of the dry run on a local copy of the canonical rows. It touches no network, no D1, no R2, no Cloudflare and no connector. It never reads or writes anything except the files named on
// its command line. It (1) EMITS the exact read-only SELECT pages an authorized reader would run (one keyset-paged statement per table, each with a row cap), (2) LOADS the pasted result pages into a new local sqlite file built from the repository
// migrations, (3) VERIFIES that copy (schema version, tables, caps, no table outside the plan) and (4) RUNS the M2 harness (scripts/epg-producer-dry-run.mjs) on it and prints counts and timings only.
// This file is NOT a GO. A production read needs its own exactly scoped owner GO per step (the count probe is the E6 read; the bounded copy is a second one). Nothing here reads production.
//
//   node scripts/epg-producer-m2b.mjs emit-sql
//   node scripts/epg-producer-m2b.mjs load-copy <results.json> <out.sqlite>     the pasted pages become a new file; refuses an existing one
//   node scripts/epg-producer-m2b.mjs verify-copy <file.sqlite> [--allow-inconsistent]
//   node scripts/epg-producer-m2b.mjs run <file.sqlite> [--departed N] [--max-films N] [--all-films] [--allow-inconsistent]
// A results file is the page manifest printed by `emit-sql` under resultsShape: per table the recorded count statement and the ordered pages with their cursors and connector metrics. A flattened row array is not accepted.
//
// HONEST LIMITS (repeated in the evidence of the run):
// - The observed run inputs are DERIVED FROM THE STORED ROWS of the copy (what the projector's write-through stored), not from the R2 sources of a real EPG commit, which S5-1 has not wired. The observed Film units therefore come out NO-OP by construction;
//   the run measures VOLUME and COST (units by kind, reads per unit, planning and fingerprint time, the size of a first pass). The share of Films that really change per run comes from the E6 `film_updates_by_day` counts, not from this run.
// - `person_state` units (localized Person names) are NOT built here: they need the person localization source rows and are reported unmeasured.
// - A copy is page-consistent only: pages are read at different instants, so a row can move between two pages. The copy is a measurement input, never a baseline or proof.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {assertReadOnly} from './schema-preflight.mjs';
import {dryRun} from './epg-producer-dry-run.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';

// Hard caps of one copy. PROPOSALS for the owner GO (the owner may lower them, never raise them in the field). Same numbers as the E6 measurement (scripts/film-person-e6-measure.mjs); the platform price of D1 rows read is not verified.
export const CAPS=Object.freeze({rowsReadPerStatement:300000,rowsReadTotal:1500000,pageRows:2000,msPerStatement:5000,msTotal:120000,schemaVersion:21});
// The tables the M2 harness reads (asserted against the statements it really issues by tests/epg-producer-m2b.mjs) and their columns, in the migration order. A table that the harness starts reading must be added here, or that test fails.
export const COPY_PLAN=Object.freeze([
 {table:'film',columns:['id','contract_version','canonical_identity','original_title','updated_at']},
 {table:'film_metadata',columns:['film_id','schema_version','year','runtime','synopsis','poster','url','genres_json','people_version','payload_json','r2_key','content_sha256','updated_at']},
 {table:'film_sync_state',columns:['film_id','metadata_at','synopsis_fetched_at','people_names_version','people_localized_at']},
 {table:'film_external_id',columns:['film_id','scheme','value','trusted','conflicting','provenance_json']},
 {table:'film_redirect',columns:['from_id','to_film_id','at']},
 {table:'film_dimension',columns:['film_id','dimension','status','source','source_version','provenance_json','value','authority','last_error','failure_reason','retry_at','attempts','next_action','updated_at']},
 {table:'film_localization_source',columns:['film_id','source','value','source_version','provenance_json','request_id','observed_at','updated_at']},
 {table:'watchlist_film',columns:['film_id','updated_at']},
 {table:'person',columns:['id','role_id','contract_version','updated_at']},
 {table:'person_external_id',columns:['person_id','scheme','value','trusted','conflicting','provenance_json']},
 {table:'person_alias',columns:['person_id','kind','value','provenance_json']},
 {table:'film_person_credit',columns:['film_id','person_id','role','ordinal']},
 {table:'canonical_revision',columns:['kind','id','revision','updated_at']},
].map(item=>Object.freeze({...item,columns:Object.freeze(item.columns)})));

const IDENT=/^[a-z_][a-z0-9_]*$/;
// One keyset page per statement: rows after the last `rowid` seen, in rowid order. Parameters: [lastRowid, pageRows]. `rowid` is selected as `_rid` so the page chain can be proven; it is not copied into the file.
export function statementOf(item){
 for(const name of [item.table,...item.columns])if(!IDENT.test(name))throw new Error('unsafe identifier');
 const sql='SELECT rowid AS _rid, '+item.columns.join(', ')+' FROM '+item.table+' WHERE rowid > ? ORDER BY rowid LIMIT ?';
 assertReadOnly(sql);
 return sql;
}
// The source-count statement of one table: the row count and the highest rowid at the time of the read. The pages must add up to it and end at it (the terminal proof of the page chain).
export function countStatementOf(item){
 if(!IDENT.test(item.table))throw new Error('unsafe identifier');
 const sql='SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM '+item.table;
 assertReadOnly(sql);
 return sql;
}
export function emitSql(){
 const statements=[];
 for(const item of COPY_PLAN){
  statements.push({id:item.table+'#count',table:item.table,kind:'count',sql:countStatementOf(item),params:'[]'});
  statements.push({id:item.table+'#page',table:item.table,kind:'page',sql:statementOf(item),params:'[lastRowid (start 0), pageRows]',pageRows:CAPS.pageRows,maxRows:CAPS.rowsReadPerStatement,columns:[...item.columns]});
 }
 const digest=createHash('sha256').update(JSON.stringify({caps:CAPS,statements:statements.map(({id,sql,pageRows,maxRows,columns})=>({id,sql,pageRows,maxRows,columns}))})).digest('hex');
 return {statementsDigest:digest,caps:CAPS,statements,protocol:PROTOCOL,resultsShape:'{"_statementsDigest","_capturedAt","_pageRows","tables":{"<table>":{"count":{"n","maxRowid","meta":{"rows_read","duration"}},"pages":[{"after","last","rows":[{"_rid",...columns}],"meta":{"rows_read","duration"}}]}}}'};
}
// What the operator enforces and what this tool can only check afterwards.
export const PROTOCOL=Object.freeze([
 'The operator sends ONE statement per request, in the printed order, and reads the connector metrics (rows_read, duration) of EACH response before sending the next. A page above the per-statement caps, or a running total above the total caps, is a STOP: no further statement is sent.',
 'The operator records the response metrics of every statement under meta in the results file. A page or count without both metrics is refused.',
 'This tool cannot prevent a read: it re-checks the recorded metrics afterwards and refuses to treat a capture that went over a cap as a valid copy. It proves the page chain (first page after 0, every page starting where the previous one ended, every page but the last full, the last short, the row total equal to the recorded count, the last rowid equal to the recorded maximum) and refuses anything else.',
]);

const literal=value=>{
 if(value===null||value===undefined)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('bad number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 if(typeof value==='string')return "'"+value.replace(/'/g,"''")+"'";
 throw new Error('a copied value is a scalar');
};
const sqlite=(file,text,json=false)=>{
 const result=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});
 if(result.status!==0)throw new Error((result.stderr||'sqlite failed').trim().slice(0,200));
 return result.stdout||'';
};
const rowsOf=(file,sql)=>{const out=sqlite(file,sql+';',true).trim();return out?JSON.parse(out):[];};

const isInt=value=>Number.isInteger(value)&&value>=0;
const metaOf=meta=>meta&&typeof meta==='object'&&isInt(meta.rows_read)&&Number.isFinite(meta.duration)&&meta.duration>=0?meta:null;
// Refusals are counted codes, never values. Returns {ok, refusals, counts}. The pages of a table must form a proven chain; a flattened array of rows is not accepted.
export function verifyResults(results,caps=CAPS){
 const refusals=[],counts={};
 const plan=emitSql();
 if(!results||typeof results!=='object'||results._statementsDigest!==plan.statementsDigest)refusals.push('statements_digest_mismatch');
 if(typeof results?._capturedAt!=='string'||!Number.isFinite(Date.parse(results._capturedAt)))refusals.push('captured_at_invalid');
 const pageRows=results?._pageRows;
 if(!Number.isInteger(pageRows)||pageRows<1||pageRows>caps.pageRows)refusals.push('page_rows_invalid');
 const tables=results?.tables;
 if(!tables||typeof tables!=='object'||Array.isArray(tables))return {ok:false,refusals:[...refusals,'tables_missing'],counts};
 let totalRead=0,totalMs=0,total=0;
 for(const name of Object.keys(tables))if(!COPY_PLAN.some(item=>item.table===name))refusals.push('table_not_in_plan:'+name);
 const metered=(meta,label)=>{
  const ok=metaOf(meta);
  if(!ok){refusals.push('meta_missing:'+label);return;}
  totalRead+=ok.rows_read;totalMs+=ok.duration;
  if(ok.rows_read>caps.rowsReadPerStatement||ok.duration>caps.msPerStatement)refusals.push('meta_over_cap:'+label);
 };
 for(const item of COPY_PLAN){
  const entry=tables[item.table];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)){refusals.push('table_missing:'+item.table);continue;}
  const count=entry.count,pages=entry.pages;
  if(!count||!isInt(count.n)||!(count.maxRowid===null||isInt(count.maxRowid))||(count.n===0)!==(count.maxRowid===null)){refusals.push('count_invalid:'+item.table);continue;}
  metered(count.meta,item.table+'#count');
  if(!Array.isArray(pages)||pages.length===0){refusals.push('pages_missing:'+item.table);continue;}
  if(count.n>caps.rowsReadPerStatement)refusals.push('rows_over_cap:'+item.table);
  const allowed=new Set(['_rid',...item.columns]);
  let after=0,rowTotal=0,last=0,chain=true;
  pages.forEach((page,index)=>{
   if(!chain)return;
   if(!page||typeof page!=='object'||!Array.isArray(page.rows)||!isInt(page.after)||!isInt(page.last)){refusals.push('page_invalid:'+item.table);chain=false;return;}
   if(page.after!==after){refusals.push('page_chain_broken:'+item.table);chain=false;return;}
   if(page.rows.length>pageRows){refusals.push('page_over_size:'+item.table);chain=false;return;}
   const final=index===pages.length-1;
   if(!final&&page.rows.length!==pageRows){refusals.push('page_not_full:'+item.table);chain=false;return;}
   let previous=page.after;
   for(const row of page.rows){
    if(!row||typeof row!=='object'||Array.isArray(row)){refusals.push('row_not_object:'+item.table);chain=false;return;}
    const keys=Object.keys(row);
    if(keys.length!==allowed.size||keys.some(key=>!allowed.has(key))){refusals.push('columns_mismatch:'+item.table);chain=false;return;}
    if(keys.some(key=>row[key]!==null&&!['string','number'].includes(typeof row[key]))){refusals.push('value_not_scalar:'+item.table);chain=false;return;}
    if(!isInt(row._rid)||row._rid<=previous){refusals.push('rowid_order:'+item.table);chain=false;return;}
    previous=row._rid;
   }
   if(page.last!==previous){refusals.push('page_last_mismatch:'+item.table);chain=false;return;}
   metered(page.meta,item.table+'#page'+index);
   rowTotal+=page.rows.length;after=page.last;last=page.last;
  });
  if(!chain)continue;
  // a full final page is only terminal when the recorded count says nothing follows
  if(pages[pages.length-1].rows.length>=pageRows&&rowTotal!==count.n){refusals.push('page_unterminated:'+item.table);continue;}
  if(rowTotal!==count.n)refusals.push('count_mismatch:'+item.table);
  else if(count.n>0&&last!==count.maxRowid)refusals.push('max_rowid_mismatch:'+item.table);
  counts[item.table]=rowTotal;total+=rowTotal;
 }
 if(total>caps.rowsReadTotal)refusals.push('rows_total_over_cap');
 if(totalRead>caps.rowsReadTotal)refusals.push('meta_total_rows_read_over_cap');
 if(totalMs>caps.msTotal)refusals.push('meta_total_duration_over_cap');
 return {ok:refusals.length===0,refusals:[...new Set(refusals)],counts};
}

// The manifest table of a loaded copy: what the verified pages said each table holds. It is the only table outside the migrations; verify-copy compares the file against it.
const MANIFEST='m2b_copy_manifest';
// Builds a NEW local sqlite file from the repository migrations and the verified pages. Never overwrites a file. Foreign keys are off while loading (a page boundary can split a pair); verify-copy counts what is left.
export function loadCopy(results,outFile,{root=process.cwd()}={}){
 const verdict=verifyResults(results);
 if(!verdict.ok)return {ok:false,refusals:verdict.refusals};
 if(fs.existsSync(outFile))return {ok:false,refusals:['output_exists']};
 const migrations=path.join(root,'migrations');
 const chain=fs.readdirSync(migrations).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 sqlite(outFile,chain.map(name=>fs.readFileSync(path.join(migrations,name),'utf8')).join('\n'));
 const lines=['PRAGMA foreign_keys=OFF;','BEGIN;','CREATE TABLE '+MANIFEST+' (table_name TEXT PRIMARY KEY, row_count INTEGER NOT NULL, max_rowid INTEGER) STRICT;'];
 for(const item of COPY_PLAN){
  const entry=results.tables[item.table];
  for(const page of entry.pages)for(const row of page.rows)lines.push('INSERT INTO '+item.table+' ('+item.columns.join(',')+') VALUES ('+item.columns.map(column=>literal(row[column])).join(',')+');');
  lines.push('INSERT INTO '+MANIFEST+' (table_name,row_count,max_rowid) VALUES ('+literal(item.table)+','+literal(entry.count.n)+','+literal(entry.count.maxRowid)+');');
 }
 lines.push('COMMIT;');
 sqlite(outFile,lines.join('\n'));
 return {ok:true,refusals:[],counts:verdict.counts};
}

// Counts only. A copy is USABLE (`ok`) only when it carries the schema version of the plan, every planned table with exactly the rows its manifest recorded, within the caps, and no foreign-key violation. A copy with violations is NOT
// representative: it is refused, or with `allowInconsistent` returned as `ok` with `representative:false` and the reason, which a D-C input must never be.
export function verifyCopy(file,{allowInconsistent=false}={}){
 const refusals=[],counts={},nonrepresentative=[];
 try{
  const version=rowsOf(file,'SELECT version FROM schema_contract WHERE id = 1')[0]?.version;
  if(version!==CAPS.schemaVersion)refusals.push('schema_version:'+version);
  let manifest=null;
  try{manifest=new Map(rowsOf(file,'SELECT table_name, row_count, max_rowid FROM '+MANIFEST).map(row=>[row.table_name,row]));}catch{refusals.push('manifest_missing');}
  let total=0;
  for(const item of COPY_PLAN){
   const row=rowsOf(file,'SELECT COUNT(*) AS n FROM '+item.table)[0];
   const count=Number(row?.n);
   counts[item.table]=count;total+=count;
   if(count>CAPS.rowsReadPerStatement)refusals.push('rows_over_cap:'+item.table);
   if(manifest&&Number(manifest.get(item.table)?.row_count)!==count)refusals.push('manifest_mismatch:'+item.table);
  }
  if(total>CAPS.rowsReadTotal)refusals.push('rows_total_over_cap');
  const violations=rowsOf(file,'PRAGMA foreign_key_check').length;
  counts.foreign_key_violations=violations;
  if(violations>0){
   if(allowInconsistent)nonrepresentative.push('foreign_key_violations:'+violations);
   else refusals.push('foreign_key_violations:'+violations);
  }
 }catch(error){refusals.push('copy_unreadable');}
 return {ok:refusals.length===0,representative:refusals.length===0&&nonrepresentative.length===0,refusals,nonrepresentative,counts};
}

const hashOrder=id=>createHash('sha256').update(id).digest('hex');
// The observed inputs of the harness, derived from the STORED rows of the copy (see HONEST LIMITS). The observed Films of a run are the watchlist members (E6 of 12 Nov 2026: about 395 per generation, not the 10,044 stored Films); `maxFilms` bounds them to the
// first N by id and `allFilms` observes every stored Film instead. `departed` is a deterministic sample of N stored Films that are NOT on the watchlist (release-only units of Films that left it): a release of a Film already off the watchlist is a no-op.
// The Person rows are the Persons credited from the observed Films, and the credit units are the observed Films that have credits (E6: 6,452 Persons and 8,600 credit rows for the 391 watchlist Films).
export function inputsFromCopy(file,{maxFilms=null,departed=0,allFilms=false}={}){
 const stored=rowsOf(file,'SELECT id, contract_version, original_title FROM film ORDER BY id');
 const watch=new Set(rowsOf(file,'SELECT film_id FROM watchlist_film').map(row=>row.film_id));
 const scope=allFilms?stored:stored.filter(row=>watch.has(row.id));
 const films=maxFilms?scope.slice(0,Number(maxFilms)):scope;
 const ids=new Set(films.map(row=>row.id));
 const meta=new Map(rowsOf(file,'SELECT * FROM film_metadata').map(row=>[row.film_id,row]));
 const sync=new Map(rowsOf(file,'SELECT * FROM film_sync_state').map(row=>[row.film_id,row]));
 const titleSource=new Map();
 for(const row of rowsOf(file,"SELECT film_id, provenance_json FROM film_dimension WHERE dimension = 'identity'")){try{const value=JSON.parse(row.provenance_json||'null')?.titleSource?.source;if(typeof value==='string')titleSource.set(row.film_id,value);}catch{/* no provenance */}}
 const parse=text=>{try{return JSON.parse(text);}catch{return null;}};
 const factsOf=row=>{
  const m=meta.get(row.id),s=sync.get(row.id);
  return {
   film:{contractVersion:row.contract_version,originalTitle:row.original_title,source:titleSource.get(row.id)||'tmdb'},
   ...(m?{metadata:{schemaVersion:m.schema_version,year:m.year,runtime:m.runtime,synopsis:m.synopsis,poster:m.poster,url:m.url,genres:parse(m.genres_json)||[],peopleVersion:m.people_version,payload:parse(m.payload_json)||{},r2Key:m.r2_key,contentSha256:m.content_sha256,updatedAt:m.updated_at}}:{}),
   ...(s?{sync:{metadataAt:s.metadata_at,synopsisFetchedAt:s.synopsis_fetched_at,peopleNamesVersion:s.people_names_version,peopleLocalizedAt:s.people_localized_at}}:{}),
   watchlist:watch.has(row.id),
  };
 };
 const filmInputs=films.map(row=>({id:row.id,facts:factsOf(row)}));
 const leavers=stored.filter(row=>!watch.has(row.id)&&!ids.has(row.id)).map(row=>row.id).sort((a,b)=>hashOrder(a).localeCompare(hashOrder(b))).slice(0,Math.max(0,Number(departed)||0)).sort();
 const byFilm=new Map(),creditedPersons=new Set();
 for(const row of rowsOf(file,'SELECT film_id, person_id, role FROM film_person_credit ORDER BY film_id, ordinal, person_id')){
  if(!ids.has(row.film_id))continue;
  if(!byFilm.has(row.film_id))byFilm.set(row.film_id,[]);
  byFilm.get(row.film_id).push({personId:row.person_id,role:row.role});
  creditedPersons.add(row.person_id);
 }
 const credits=[...byFilm].map(([filmId,list])=>({filmId,credits:list}));
 const personRows=rowsOf(file,'SELECT id, role_id, contract_version FROM person ORDER BY id').filter(row=>creditedPersons.has(row.id)).map(row=>({id:row.id,roleId:row.role_id,contractVersion:row.contract_version}));
 return {films:filmInputs,departed:leavers,persons:[],credits,personRows};
}

// Runs the M2 harness on a verified copy. The copy is opened through the read-only guard of the harness; its bytes are compared before and after. Output: counts and timings only.
export async function runOnCopy(file,{departed=0,maxFilms=null,allFilms=false,allowInconsistent=false,at=new Date().toISOString(),clock}={}){
 const verdict=verifyCopy(file,{allowInconsistent});
 if(!verdict.ok)return {ok:false,refusals:verdict.refusals};
 const before=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const inputs=inputsFromCopy(file,{departed,maxFilms,allFilms});
 const report=await dryRun({env:{DB:d1Standin(file)},runId:'m2b',at,...inputs,...(clock?{clock}:{})});
 const after=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(before!==after)return {ok:false,refusals:['copy_changed_during_run']};
 return {ok:true,refusals:[],representative:verdict.representative,...(verdict.representative?{}:{nonrepresentative:verdict.nonrepresentative,notADCInput:true}),copyUnchanged:true,copy:verdict.counts,volume:{films:inputs.films.length,departed:inputs.departed.length,creditFilms:inputs.credits.length,personRows:inputs.personRows.length,personStateUnits:'unmeasured'},report,limits:'inputs derived from the stored rows of the copy: observed units are no-op by construction; the real changedShare comes from E6 film_updates_by_day'};
}

const isMain=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain){
 const [command,...rest]=process.argv.slice(2);
 const flag=name=>{const index=rest.indexOf(name);return index>=0?rest[index+1]:undefined;};
 let out;
 try{
  if(command==='emit-sql')out=emitSql();
  else if(command==='load-copy'&&rest.length>=2)out=loadCopy(JSON.parse(fs.readFileSync(rest[0],'utf8')),rest[1]);
  else if(command==='verify-copy'&&rest.length>=1)out=verifyCopy(rest[0],{allowInconsistent:rest.includes('--allow-inconsistent')});
  else if(command==='run'&&rest.length>=1)out=await runOnCopy(rest[0],{departed:Number(flag('--departed')||0),maxFilms:flag('--max-films')?Number(flag('--max-films')):null,allFilms:rest.includes('--all-films'),allowInconsistent:rest.includes('--allow-inconsistent')});
  else{console.error('usage: emit-sql | load-copy <results.json> <out.sqlite> | verify-copy <file.sqlite> [--allow-inconsistent] | run <file.sqlite> [--departed N] [--max-films N] [--all-films] [--allow-inconsistent]');process.exit(2);}
 }catch(error){console.error('refused: '+String(error?.message||error).slice(0,160));process.exit(1);}
 console.log(JSON.stringify(out,null,1));
 if(out&&out.ok===false)process.exit(1);
}
