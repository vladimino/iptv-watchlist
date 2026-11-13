// AIR-374 M2b, STEP 0 (ADR 0128 staged plan): the OFFLINE tooling of the dry run on a local copy of the canonical rows. It touches no network, no D1, no R2, no Cloudflare and no connector. It never reads or writes anything except the files named on
// its command line. It (1) EMITS the exact read-only SELECT pages an authorized reader would run (one keyset-paged statement per table, each with a row cap), (2) LOADS the pasted result pages into a new local sqlite file built from the repository
// migrations, (3) VERIFIES that copy (schema version, tables, caps, no table outside the plan) and (4) RUNS the M2 harness (scripts/epg-producer-dry-run.mjs) on it and prints counts and timings only.
// This file is NOT a GO. A production read needs its own exactly scoped owner GO per step (the count probe is the E6 read; the bounded copy is a second one). Nothing here reads production.
//
//   node scripts/epg-producer-m2b.mjs emit-sql
//   node scripts/epg-producer-m2b.mjs load-copy <results.json> <out.sqlite>     the pasted pages become a new file; refuses an existing one
//   node scripts/epg-producer-m2b.mjs verify-copy <file.sqlite>
//   node scripts/epg-producer-m2b.mjs run <file.sqlite> [--departed N] [--max-films N] [--all-films]
// A results file is {"_statementsDigest":"<digest of emit-sql>","_capturedAt":"<ISO UTC>","tables":{"<table>":[<row>, ...]}} with every row an object of exactly the planned columns.
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
// One keyset page per statement: rows after the last `rowid` seen, in rowid order. Parameters: [lastRowid, pageRows]. `rowid` is selected as `_rid` so a reader can advance the key; it is not copied.
export function statementOf(item){
 for(const name of [item.table,...item.columns])if(!IDENT.test(name))throw new Error('unsafe identifier');
 const sql='SELECT rowid AS _rid, '+item.columns.join(', ')+' FROM '+item.table+' WHERE rowid > ? ORDER BY rowid LIMIT ?';
 assertReadOnly(sql);
 return sql;
}
export function emitSql(){
 const statements=COPY_PLAN.map(item=>({id:item.table,table:item.table,sql:statementOf(item),params:'[lastRowid (start 0), pageRows]',pageRows:CAPS.pageRows,maxRows:CAPS.rowsReadPerStatement,columns:[...item.columns]}));
 const digest=createHash('sha256').update(JSON.stringify({caps:CAPS,statements:statements.map(({id,sql,pageRows,maxRows,columns})=>({id,sql,pageRows,maxRows,columns}))})).digest('hex');
 return {statementsDigest:digest,caps:CAPS,statements,note:'Read-only. One keyset page per call until a page is shorter than pageRows or maxRows is reached; paste the concatenated rows (without _rid) under tables.<id>. Not a GO.'};
}

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

// Refusals are counted codes, never values. Returns {ok, refusals, counts}.
export function verifyResults(results,caps=CAPS){
 const refusals=[],counts={};
 const plan=emitSql();
 if(!results||typeof results!=='object'||results._statementsDigest!==plan.statementsDigest)refusals.push('statements_digest_mismatch');
 if(typeof results?._capturedAt!=='string'||!Number.isFinite(Date.parse(results._capturedAt)))refusals.push('captured_at_invalid');
 const tables=results?.tables;
 if(!tables||typeof tables!=='object'||Array.isArray(tables))return {ok:false,refusals:[...refusals,'tables_missing'],counts};
 let total=0;
 for(const name of Object.keys(tables))if(!COPY_PLAN.some(item=>item.table===name))refusals.push('table_not_in_plan:'+name);
 for(const item of COPY_PLAN){
  const rows=tables[item.table];
  if(!Array.isArray(rows)){refusals.push('table_missing:'+item.table);continue;}
  counts[item.table]=rows.length;total+=rows.length;
  if(rows.length>caps.rowsReadPerStatement)refusals.push('rows_over_cap:'+item.table);
  const allowed=new Set(item.columns);
  for(const row of rows){
   if(!row||typeof row!=='object'||Array.isArray(row)){refusals.push('row_not_object:'+item.table);break;}
   const keys=Object.keys(row);
   if(keys.length!==item.columns.length||keys.some(key=>!allowed.has(key))){refusals.push('columns_mismatch:'+item.table);break;}
   if(keys.some(key=>row[key]!==null&&!['string','number'].includes(typeof row[key]))){refusals.push('value_not_scalar:'+item.table);break;}
  }
 }
 if(total>caps.rowsReadTotal)refusals.push('rows_total_over_cap');
 return {ok:refusals.length===0,refusals:[...new Set(refusals)],counts};
}

// Builds a NEW local sqlite file from the repository migrations and the pasted pages. Never overwrites a file. Foreign keys are off while loading (a page boundary can split a pair), then counted.
export function loadCopy(results,outFile,{root=process.cwd()}={}){
 const verdict=verifyResults(results);
 if(!verdict.ok)return {ok:false,refusals:verdict.refusals};
 if(fs.existsSync(outFile))return {ok:false,refusals:['output_exists']};
 const migrations=path.join(root,'migrations');
 const chain=fs.readdirSync(migrations).filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 sqlite(outFile,chain.map(name=>fs.readFileSync(path.join(migrations,name),'utf8')).join('\n'));
 const lines=['PRAGMA foreign_keys=OFF;','BEGIN;'];
 for(const item of COPY_PLAN)for(const row of results.tables[item.table])lines.push('INSERT INTO '+item.table+' ('+item.columns.join(',')+') VALUES ('+item.columns.map(column=>literal(row[column])).join(',')+');');
 lines.push('COMMIT;');
 sqlite(outFile,lines.join('\n'));
 return {ok:true,refusals:[],counts:verdict.counts};
}

// Counts only. The copy must carry the schema version of the plan and every planned table, and must not hold more rows than the caps.
export function verifyCopy(file){
 const refusals=[],counts={};
 try{
  const version=rowsOf(file,'SELECT version FROM schema_contract WHERE id = 1')[0]?.version;
  if(version!==CAPS.schemaVersion)refusals.push('schema_version:'+version);
  let total=0;
  for(const item of COPY_PLAN){
   const count=Number(rowsOf(file,'SELECT COUNT(*) AS n FROM '+item.table)[0]?.n);
   counts[item.table]=count;total+=count;
   if(count>CAPS.rowsReadPerStatement)refusals.push('rows_over_cap:'+item.table);
  }
  if(total>CAPS.rowsReadTotal)refusals.push('rows_total_over_cap');
  counts.foreign_key_violations=rowsOf(file,'PRAGMA foreign_key_check').length;
 }catch(error){refusals.push('copy_unreadable');}
 return {ok:refusals.length===0,refusals,counts};
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
export async function runOnCopy(file,{departed=0,maxFilms=null,allFilms=false,at=new Date().toISOString(),clock}={}){
 const verdict=verifyCopy(file);
 if(!verdict.ok)return {ok:false,refusals:verdict.refusals};
 const before=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 const inputs=inputsFromCopy(file,{departed,maxFilms,allFilms});
 const report=await dryRun({env:{DB:d1Standin(file)},runId:'m2b',at,...inputs,...(clock?{clock}:{})});
 const after=createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(before!==after)return {ok:false,refusals:['copy_changed_during_run']};
 return {ok:true,refusals:[],copyUnchanged:true,copy:verdict.counts,volume:{films:inputs.films.length,departed:inputs.departed.length,creditFilms:inputs.credits.length,personRows:inputs.personRows.length,personStateUnits:'unmeasured'},report,limits:'inputs derived from the stored rows of the copy: observed units are no-op by construction; the real changedShare comes from E6 film_updates_by_day'};
}

const isMain=process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url;
if(isMain){
 const [command,...rest]=process.argv.slice(2);
 const flag=name=>{const index=rest.indexOf(name);return index>=0?rest[index+1]:undefined;};
 let out;
 try{
  if(command==='emit-sql')out=emitSql();
  else if(command==='load-copy'&&rest.length>=2)out=loadCopy(JSON.parse(fs.readFileSync(rest[0],'utf8')),rest[1]);
  else if(command==='verify-copy'&&rest.length>=1)out=verifyCopy(rest[0]);
  else if(command==='run'&&rest.length>=1)out=await runOnCopy(rest[0],{departed:Number(flag('--departed')||0),maxFilms:flag('--max-films')?Number(flag('--max-films')):null,allFilms:rest.includes('--all-films')});
  else{console.error('usage: emit-sql | load-copy <results.json> <out.sqlite> | verify-copy <file.sqlite> | run <file.sqlite> [--departed N] [--max-films N] [--all-films]');process.exit(2);}
 }catch(error){console.error('refused: '+String(error?.message||error).slice(0,160));process.exit(1);}
 console.log(JSON.stringify(out,null,1));
 if(out&&out.ok===false)process.exit(1);
}
