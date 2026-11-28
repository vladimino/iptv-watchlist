#!/usr/bin/env node
// AIR-648: the READ-ONLY, bounded pre-activation preflight of the internal FilmAggregateV1 route (the schema/index gate, the marker readbacks and the size-only G1 evidence of the card).
// It reads production D1 through the same read-only transport as the AIR-653 operator (only one SELECT / WITH ... SELECT goes over the wire, an answer that reports a write stops the
// run), captures twice and compares the two captures (a fence against movement), and prints counts, states, booleans, reasons and digests only: never a Film id, lid, movie id, fact
// key, rating or document body. It writes nothing to D1 or R2, calls no aggregate route, sets no flag, Task or lease, and authorizes NOTHING: `pass` is evidence for the owner's activation
// GO, not the GO. A later GO must restate the facts it relies on; the live state is read here, never remembered from a document.
//
//   node scripts/film-aggregate-activation-preflight-production.mjs --expect-version <n> [--rows <n>]
//
// Credentials: D1_BACKFILL_ACCOUNT_ID and D1_BACKFILL_API_TOKEN (behind a proxy NODE_USE_ENV_PROXY=1). The target is pinned to the production account and database and its identity
// (uuid and name) is read back before the first statement.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createD1Adapter} from './d1-backfill.mjs';
import {createPublishedBinding,productionTarget,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME} from './published-epg-production.mjs';
import {readOnlyTransport,controlled,describeError,UsageError,ControlledError} from './letterboxd-claim-cohort-preflight-production.mjs';
import {readMarker} from '../src/film-person-authority.js';

// The work of one run is bounded by the number of ratings_document part rows the G1 measure may read (a primary-key range count is taken first; over the cap the run stops before it measures).
export const CAP_CEILINGS=Object.freeze({rows:2000000});
export const DEFAULT_ROWS=400000;
// The accepted G1 bounds (ADR 0216 decision 6b, docs/reference/api/film-aggregate.md): a fact record is read only up to 8 parts of 60 000 bytes (480 000), the link index up to 40 parts (2.4 MB).
export const PART_BYTES=60000;
export const G1=Object.freeze({recordParts:8,recordBytes:8*PART_BYTES,linksParts:40,linksBytes:40*PART_BYTES});
export const LINKS_KEY='letterboxd/facts/links.json';
const RECORD_FROM='letterboxd/facts/films/',RECORD_TO='letterboxd/facts/films0'; // the key range of every fact record (the primary key of ratings_document, '/' + 1 = '0')
// The two indexes the aggregate statements need (decision 7): the exact, non-unique, non-partial definitions of migrations 0040 and 0043.
export const REQUIRED_INDEXES=Object.freeze([
 {name:'tmdb_retirement_decision_movie',table:'tmdb_retirement_decision',column:'movie_id',migration:'0040'},
 {name:'film_redirect_by_target',table:'film_redirect',column:'to_film_id',migration:'0043'},
]);
// The authority markers the sections read (value columns only; no etag, no run id).
export const MARKERS=Object.freeze([
 {table:'ratings_domain_authority',columns:['mode','cutover','generation'],servable:row=>row.mode==='d1'&&row.cutover==='open'},
 {table:'prediction_domain_authority',columns:['mode','writes','generation','profile_generation'],servable:row=>row.mode==='d1'&&row.writes==='open'},
 {table:'owner_review_authority',columns:['mode','writes','generation'],servable:row=>row.mode==='d1'&&(row.writes==='open'||row.writes==='held')},
 {table:'published_epg_authority',columns:['mode','cutover','generation'],servable:row=>row.mode==='d1'&&row.cutover==='open'},
 {table:'watchlist_authority',columns:['mode','writes','generation'],servable:row=>row.mode==='d1'},
]);
const COUNTS=['tmdb_retirement_decision','film_redirect','film','film_external_id','owner_review_entry'];

export function parseArgs(argv){
 const out={expectVersion:null,rows:DEFAULT_ROWS};
 for(let i=2;i<argv.length;i++){
  const flag=argv[i],value=argv[i+1];
  if(flag==='--expect-version'){const n=Number(value);if(!Number.isInteger(n)||n<43||n>10000)throw new UsageError('usage: --expect-version must be an integer from 43 to 10000');out.expectVersion=n;i++;}
  else if(flag==='--rows'){const n=Number(value);if(!Number.isInteger(n)||n<1||n>CAP_CEILINGS.rows)throw new UsageError('usage: --rows must be an integer from 1 to '+CAP_CEILINGS.rows);out.rows=n;i++;}
  else throw new UsageError('usage: unknown option '+flag);
 }
 if(out.expectVersion===null)throw new UsageError('usage: --expect-version <n> is required (the schema version the GO names; the live state is compared to it, never assumed)');
 return out;
}

// The exact definition of an index from sqlite_master: `CREATE INDEX [IF NOT EXISTS] <name> ON <table> (<column>)` and nothing else (no UNIQUE, no WHERE, no second column, no expression).
export function indexExact(spec,row){
 if(!row||row.tbl_name!==spec.table||typeof row.sql!=='string')return false;
 const text=row.sql.replace(/\s+/g,' ').trim().replace(/;$/,'');
 return new RegExp('^CREATE INDEX (IF NOT EXISTS )?"?'+spec.name+'"? ON "?'+spec.table+'"? ?\\("?'+spec.column+'"?\\)$','i').test(text);
}

const all=async(DB,sql,params=[])=>(await DB.prepare(sql).bind(...params).all()).results||[];
const number=value=>{const n=Number(value);return Number.isFinite(n)?n:null;};

// One capture: reads only, fixed statements (the only interpolated names are constants of this file). Returns plain facts.
export async function capture(DB,{rows=DEFAULT_ROWS}={}){
 const out={};
 const schema=await all(DB,'SELECT id,version FROM schema_contract');
 out.schema={rows:schema.length,version:schema.length===1&&Number(schema[0].id)===1?number(schema[0].version):null};
 const marks=await all(DB,'SELECT name,tbl_name,sql FROM sqlite_master WHERE type=\'index\' AND name IN (?,?)',REQUIRED_INDEXES.map(item=>item.name));
 out.indexes=REQUIRED_INDEXES.map(spec=>{const row=marks.find(item=>item.name===spec.name);return {name:spec.name,migration:spec.migration,present:!!row,exact:indexExact(spec,row)};});
 const tables=new Set((await all(DB,'SELECT name FROM sqlite_master WHERE type=\'table\'')).map(item=>item.name));
 out.markers=[];
 for(const spec of MARKERS){
  if(!tables.has(spec.table)){out.markers.push({table:spec.table,present:false,servable:false});continue;}
  const found=await all(DB,'SELECT '+spec.columns.join(',')+' FROM '+spec.table+' WHERE id=1');
  const row=found.length===1?found[0]:null;
  out.markers.push({table:spec.table,present:true,rows:found.length,values:row?Object.fromEntries(spec.columns.map(column=>[column,row[column]])):null,servable:!!row&&spec.servable(row)});
 }
 // The Film/Person marker through the aggregate's own reader: only `open` serves identity.
 try{const marker=await readMarker({DB});out.film={state:marker.state,generation:number(marker.generation)};}
 catch(error){out.film={state:'unavailable',generation:null,reason:controlled(error?.code)};}
 const profiles=tables.has('prediction_profile')?await all(DB,'SELECT version,json_valid(lineage_json) AS lineage_valid,lineage_json IS NULL AS lineage_null FROM prediction_profile WHERE active=1'):[];
 out.profile={active:profiles.length,version:profiles.length===1?number(profiles[0].version):null,lineageReadable:profiles.length===1?(Number(profiles[0].lineage_null)===1||Number(profiles[0].lineage_valid)===1):null};
 out.counts={};
 for(const table of COUNTS)out.counts[table]=tables.has(table)?number((await all(DB,'SELECT COUNT(*) AS n FROM '+table))[0]?.n):null;
 // Size-only G1 evidence over the owned ratings documents: parts, bytes and distinct etags per key, aggregated in SQL (the Worker-side reader caps the same figures). The part rows are
 // counted over the primary-key range first; over the cap the measure is not run.
 if(tables.has('ratings_document')){
  const parts=number((await all(DB,'SELECT COUNT(*) AS n FROM ratings_document WHERE key>=? AND key<?',[RECORD_FROM,RECORD_TO]))[0]?.n);
  out.g1={recordPartRows:parts,measured:false,links:null};
  const links=await all(DB,'SELECT COUNT(*) AS parts,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,COUNT(DISTINCT etag) AS etags FROM ratings_document WHERE key=?',[LINKS_KEY]);
  out.g1.links={present:number(links[0]?.parts)>0,parts:number(links[0]?.parts),bytes:number(links[0]?.bytes),etags:number(links[0]?.etags)};
  if(parts!==null&&parts<=rows){
   const m=(await all(DB,'SELECT COUNT(*) AS records,COALESCE(MAX(parts),0) AS max_parts,COALESCE(MAX(bytes),0) AS max_bytes,COALESCE(SUM(parts>?),0) AS over_parts,COALESCE(SUM(bytes>?),0) AS over_bytes,COALESCE(SUM(etags>1),0) AS mixed_etags,COALESCE(SUM(bytes),0) AS total_bytes FROM (SELECT key,COUNT(*) AS parts,SUM(length(CAST(body AS BLOB))) AS bytes,COUNT(DISTINCT etag) AS etags FROM ratings_document WHERE key>=? AND key<? GROUP BY key)',[G1.recordParts,G1.recordBytes,RECORD_FROM,RECORD_TO]))[0]||{};
   out.g1={...out.g1,measured:true,records:number(m.records),maxParts:number(m.max_parts),maxBytes:number(m.max_bytes),overParts:number(m.over_parts),overBytes:number(m.over_bytes),mixedEtags:number(m.mixed_etags),totalBytes:number(m.total_bytes)};
  }
 }else out.g1={recordPartRows:null,measured:false,links:null};
 return out;
}

// Pure. The facts against the gate. `blockers` stop the activation preparation; `observations` are evidence for the owner (an over-cap record is `discovery_cap` coverage, never a safety
// fault, so it is an observation that needs the owner's decision, not a blocker). Nothing here is a GO.
export function evaluate(first,second,{expectVersion}){
 const blockers=[],observations=[];
 if(JSON.stringify(first)!==JSON.stringify(second))blockers.push('state_moved_between_captures');
 if(first.schema.version===null)blockers.push('schema_contract_unreadable');
 else if(first.schema.version!==expectVersion)blockers.push('schema_version_not_expected');
 for(const index of first.indexes){if(!index.present)blockers.push('index_missing:'+index.name);else if(!index.exact)blockers.push('index_not_exact:'+index.name);}
 for(const marker of first.markers){if(!marker.present)blockers.push('marker_table_missing:'+marker.table);else if(!marker.servable)blockers.push('marker_not_servable:'+marker.table);}
 if(first.film.state!=='open')blockers.push('film_person_marker_not_open');
 if(first.profile.active!==1)blockers.push('active_profile_not_single');
 else if(first.profile.lineageReadable!==true)blockers.push('active_profile_lineage_unreadable');
 const g1=first.g1;
 if(!g1||g1.recordPartRows===null)blockers.push('g1_documents_unavailable');
 else{
  if(!g1.measured)blockers.push('g1_measure_over_row_cap');
  else{
   if(g1.mixedEtags>0)observations.push('fact_records_with_mixed_etags');
   if(g1.overParts>0||g1.overBytes>0)observations.push('fact_records_over_the_g1_cap');
  }
  if(g1.links?.present&&(g1.links.parts>G1.linksParts||g1.links.bytes>G1.linksBytes))observations.push('link_index_over_the_g1_cap');
  if(!g1.links?.present)observations.push('link_index_absent');
  else if(g1.links.etags!==1)observations.push('link_index_not_one_etag');
 }
 return {decision:blockers.length?'stop':'pass',blockers,observations,needsOwnerDecision:observations.some(item=>/over_the_g1_cap|mixed_etags/.test(item))};
}

export async function preflight(DB,{expectVersion,rows=DEFAULT_ROWS}){
 const first=await capture(DB,{rows}),second=await capture(DB,{rows});
 return {...evaluate(first,second,{expectVersion}),expectVersion,facts:first};
}

// The printed report: the sanitized facts and the verdict. Nothing here names a row.
export function sanitize(result,{transport=null}={}){
 const f=result.facts;
 return {
  decision:result.decision,blockers:result.blockers.map(controlled),observations:result.observations.map(controlled),needsOwnerDecision:result.needsOwnerDecision,expectVersion:result.expectVersion,
  schema:f.schema,indexes:f.indexes,film:f.film,markers:f.markers,profile:f.profile,counts:f.counts,g1:{caps:G1,...f.g1},transport,
  limitations:['no EXPLAIN QUERY PLAN over the read-only transport: the scoped plans are asserted offline on the real schema (tests/film-aggregate.mjs) and the live index definition is read back exactly above','authorizes nothing: not an apply, an activation, a route, a flag, a Task or a live call of the aggregate'],
 };
}

export async function run({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,log=console.log,preflightImpl=preflight}={}){
 const args=parseArgs(argv);
 const transport={requests:0,rowsRead:0,rowsWritten:0};
 const adapter=createD1Adapter({target:productionTarget(env),databaseId:PRODUCTION_DATABASE_ID,fetchImpl:readOnlyTransport(fetchImpl,transport),retries:0});
 const described=await adapter.describe();
 if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new ControlledError('target_identity_mismatch');
 const result=await preflightImpl(createPublishedBinding(adapter),{expectVersion:args.expectVersion,rows:args.rows});
 const report=sanitize(result,{transport});
 log(JSON.stringify(report,null,1));
 return report;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 run().then(report=>{if(report.decision!=='pass')process.exitCode=1;}).catch(error=>{console.error('preflight failed:',describeError(error));process.exitCode=2;});
}
