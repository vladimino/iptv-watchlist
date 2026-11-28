// AIR-652 (ADR 0216 delivery step 7; ADR 0184 Accepted, unchanged): the OFFLINE, executable design of the preflight for the historical "bridge-only" prediction keys of the AIR-627 census, on the sqlite3-CLI D1 stand-in over the full
// migration chain. SYNTHETIC ids only (no owner-private profile, no production id list, no R2, no network). Nothing here writes to any store except its own throwaway fixture databases, and no apply path, producer or MCP tool is imported.
// The preflight is test-local on purpose: it is the design AIR-653 would have to re-prove under its own GO, not a maintained module, not a production adapter and not a frozen write cohort. No live run is requested or enabled.
// DESIGN. The existing planner `planLetterboxdClaim` is UNCHANGED and unbounded (it re-reads the link index and the record parts for every key). It is therefore used only as an OFFLINE ORACLE over a PRIVATE SNAPSHOT:
//  1. A bounded CAPTURE reads exactly the planner's inputs: every statement is charged to ONE shared budget (statements and rows, both charged BEFORE the statement runs) across both passes and the repeated discovery; every list
//     is LIMIT cap+1 over an indexed predicate; documents use the AIR-647 atomic parts/bytes statement. Overflow, an exhausted budget or an unreadable table is `unknown` with no digest, never a partial answer.
//  2. The captured rows are materialized into a private sqlite snapshot (triggers dropped: the evaluator never writes) and the real planner is evaluated there. Because the planner can only see what was captured, the read-set token IS the
//     exact consumed data, and a DIFFERENTIAL test proves the snapshot verdicts equal the live-fixture verdicts, including the review's counterexamples.
//  3. The capture is repeated and the discovery repeated; any difference in any section is `unknown` (`read_set_moved`, section named, no digest). An empty cohort is certified only on the same terms.
//  4. Explicit NO-LIVE-RUN BLOCKERS are reported where a bounded capture cannot be specified yet (see `LIVE_BLOCKERS`).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {deriveBackfillCohort,findDuplicateTargets,cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {countedDatabase,LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES,LINK_INDEX_MAX_ENTRIES,FACT_RECORD_MAX_PARTS,FACT_RECORD_MAX_BYTES} from '../src/film-aggregate.js';
import {createStatementBudget} from '../src/film-aggregate-resolver.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air652-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
sqlite(template,'PRAGMA foreign_keys=ON;\n'+fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
const TRIGGERS=rows(template,"SELECT name FROM sqlite_master WHERE type='trigger'").map(row=>row.name);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const U='2026-11-01T00:00:00.000Z';
const RUN='run-1';
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
let n=0;
function database(stage='open'){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 sqlite(file,'PRAGMA foreign_keys=ON;\n'+VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 if(stage==='held')sqlite(file,"PRAGMA foreign_keys=ON;UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 sqlite(file,"PRAGMA foreign_keys=ON;UPDATE ratings_domain_authority SET mode='"+(stage==='ratings_not_d1'?'r2':'d1')+"',cutover='open' WHERE id=1");
 return file;
}
const run=(file,text)=>sqlite(file,'PRAGMA foreign_keys=ON;\n'+text);
const FID=k=>'film:tmdb:'+k;
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const putDoc=(file,key,value)=>{const text=JSON.stringify(value);run(file,'DELETE FROM ratings_document WHERE key='+q(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+q(key)+',0,'+q(text)+','+q(sha(text))+','+q(U)+')');};
const getDoc=(file,key)=>{const r=rows(file,'SELECT body FROM ratings_document WHERE key='+q(key));return r.length?JSON.parse(r[0].body):null;};
const seedFilm=(file,k,{identity='tmdb:'+k,extra=[]}={})=>run(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(FID(k))+",2,"+q(identity)+",'Kept Title',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(k))+",'tmdb',"+q(String(k))+",1,0,NULL);"+extra.map(([s,v,t,c])=>'INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('+q(FID(k))+','+q(s)+','+q(v)+','+t+','+c+',NULL);').join(''));
// The Ratings side of one candidate: link index + fact record (authoritative) and the projection (corroboration only).
const seedRatings=(file,lid,k,{key='tmdb-'+k,lidKey=key,record=undefined,index=true,third=null}={})=>{
 run(file,'INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('+q(lid)+','+q(lidKey)+',NULL,NULL,0,0,'+q(U)+');INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('+q('tmdb_'+k)+','+q(key)+',NULL,NULL,0,0,'+q(U)+');');
 if(!index)return;
 const links=getDoc(file,'letterboxd/facts/links.json')||{};
 links['letterboxd:'+lid]=lidKey;links['tmdb:'+k]=key;if(third)links[third]=lidKey;
 putDoc(file,'letterboxd/facts/links.json',links);
 putDoc(file,'letterboxd/facts/films/'+lidKey+'.json',record??{schemaVersion:1,factKey:lidKey,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
};
const pointer=(file,storageId,rating,sha256='c'.repeat(64))=>run(file,'INSERT OR REPLACE INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES ('+q(storageId)+",3,'h',"+q('f-'+storageId)+",1,1,"+rating+','+q('enrichment/films/'+storageId+'/prediction.json')+','+q(sha256)+','+q(U)+",'{}')");
const publish=(file,lids)=>run(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+RUN+"','published',"+q(U)+","+q('0'.repeat(64))+","+q(U)+");"+lids.map((lid,i)=>"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('"+RUN+"','programme',"+i+","+q(lid)+");").join('')+"UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+RUN+"',generation=1,watchlist_generation=1 WHERE id=1;");
const TABLES=['film','film_external_id','film_alias','film_redirect','film_rated_admission','film_retention','film_dimension','film_metadata','canonical_revision','canonical_write_receipt','ratings_view','ratings_document','prediction_pointer','prediction_lineage','tmdb_retirement_decision','started_mark','published_epg_member'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const chunks=(list,size)=>{const out=[];for(let at=0;at<list.length;at+=size)out.push(list.slice(at,at+size));return out;};
const digestOf=value=>sha(JSON.stringify(value));
const envOf=(file,options)=>({DB:d1Standin(file,options)});

// ======================= the preflight design =======================
const HEX64=/^[0-9a-f]{64}$/;
const WITNESS_INVARIANT='diary_first_lb_record_with_inferred_import_admission';
// The planner's documented limit: a pair linked by the inferred import before AIR-559 on a record that already held facts (in practice a Diary-first `lb-<lid>` record) carries neither durable mark. The one pair DETECTED by the AIR-559
// audit was marked on 24 Nov 2026 and the planner now refuses it; whether another exists is unknown. The witness is the admission row of the inferred-import archive for the same lid and movie. A scope is VALID only when it names the
// invariant and a non-empty set of well-formed archive digests; anything else is missing evidence, not absence of the pair.
const scopeValid=scope=>!!scope&&scope.invariant===WITNESS_INVARIANT&&Array.isArray(scope.archives)&&scope.archives.length>0&&scope.archives.every(item=>typeof item==='string'&&HEX64.test(item));
const NEGATIVE_NOT_PROVED=new Set(['ratings_link_inferred','ratings_link_unverified']);
const DEFAULT_CAPS={pointerPage:50,pointerInspect:2000,candidates:64,statements:300,rows:6000,chunk:10,list:64};
// Predicates that CANNOT yet be captured within a bound. They are reported with every answer and make a live run a blocker, not a risk to accept.
const LIVE_BLOCKERS=Object.freeze([
 'ratings_view_fact_key_index_0055: the planner corroborates the projection by fact_key; the index is migration 0055 (AIR-653) and its production apply and readback are a prerequisite (without it the predicate is a scan whose size is not capped; AIR-627 saw such a predicate time out).',
 'tmdb_retirement_decision_movie_index: the ledger is read by movie_id; the index is migration 0040 and its production apply and readback are a prerequisite (AIR-667 / AIR-648). A superseding decision is assumed to name the same movie id, as the resolver does (supersedes_seq has no index).',
 'planner_unbounded_on_live: the unchanged planner re-reads the link index and records for every key and has no caps; it may be evaluated only on a private snapshot, never against production.',
]);
// tmdb-spelled storage keys form ONE contiguous range of the pointer primary key ('tmdb_' ... 'tmdb`'), so the two exclusive ranges around it are the only rows a lid scan has to read.
const RANGES=[{lo:'',hi:'tmdb_'},{lo:'tmdb_￿',hi:'￿'}];
class Incomplete extends Error{constructor(reason){super(reason);this.reason=reason;}}
// ONE budget for the whole run: statements (through the AIR-647 read-only counted database) and a row ledger. Both are charged BEFORE the statement runs.
function newBudget(caps){
 const statements=createStatementBudget(caps.statements);
 let rowsUsed=0;
 return {statements,get rows(){return rowsUsed;},charge(limit){if(rowsUsed+limit>caps.rows)throw new Incomplete('budget_exhausted');rowsUsed+=limit;}};
}
// One statement, LIMIT `limit`: the statement and the rows it may return are charged BEFORE it runs.
async function execRows(cdb,budget,sql,params,limit){
 budget.charge(limit);
 try{return (await cdb.prepare(sql).bind(...params,limit).all()).results;}
 catch(error){if(error?.code==='budget_exceeded')throw new Incomplete('budget_exhausted');throw error;}
}
// A list with a cap: cap+1 rows are requested, so one extra row proves an overflow.
async function readRows(cdb,budget,name,sql,params,cap){
 const result=await execRows(cdb,budget,sql,params,cap+1);
 if(result.length>cap)throw new Incomplete('row_cap:'+name);
 return result;
}
// The AIR-647 atomic document statement (src/film-aggregate.js BOUNDED_DOCUMENTS_SQL): the measure is computed server-side and the body is joined only when parts, bytes and etag are within the caps, in ONE statement, so a document
// replaced after a separate count cannot be materialized. A guard below fails if the source statement drifts.
const BOUNDED_DOCUMENTS_SQL='WITH g AS (SELECT key,COUNT(*) AS parts,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,COUNT(DISTINCT etag) AS etags,MIN(etag) AS etag FROM ratings_document WHERE key IN (SELECT value FROM json_each(?)) GROUP BY key) '
 +'SELECT g.key AS key,g.parts AS parts,g.bytes AS bytes,g.etags AS etags,g.etag AS etag,d.part AS part,d.body AS body FROM g LEFT JOIN ratings_document d ON d.key=g.key AND g.parts<=? AND g.bytes<=? AND g.etags=1 ORDER BY g.key,d.part';
async function readDocuments(cdb,budget,keys,maxParts,maxBytes){
 budget.charge(keys.length*maxParts);
 let result;
 try{result=(await cdb.prepare(BOUNDED_DOCUMENTS_SQL).bind(JSON.stringify(keys),maxParts,maxBytes).all()).results;}
 catch(error){if(error?.code==='budget_exceeded')throw new Incomplete('budget_exhausted');throw error;}
 const byKey=new Map();
 for(const item of result){if(!byKey.has(item.key))byKey.set(item.key,{parts:Number(item.parts),bytes:Number(item.bytes),etags:Number(item.etags),parts_rows:[]});if(item.part!=null)byKey.get(item.key).parts_rows.push(item);}
 const out=new Map();
 for(const key of keys){
  const entry=byKey.get(key);
  if(!entry){out.set(key,null);continue;}
  if(entry.parts>maxParts||entry.bytes>maxBytes)throw new Incomplete('document_over_cap');
  if(entry.etags!==1||entry.parts_rows.length!==entry.parts||entry.parts_rows.some((item,index)=>Number(item.part)!==index))throw new Incomplete('document_malformed');
  out.set(key,entry.parts_rows.map(item=>({key,part:Number(item.part),body:item.body,etag:item.etag})));
 }
 return out;
}
const assemble=parts=>parts?JSON.parse(parts.map(item=>item.body).join('')):null;
async function discover(cdb,budget,caps,work){
 const direct=[],candidates=[];
 let inspected=0;   // the cap applies to EACH discovery pass; `work` adds every pass for the report
 for(const range of RANGES){
  let cursor=range.lo;
  for(;;){
   // The page is LIMITed to what the inspection cap still allows plus one (to prove an overflow), so no read ever exceeds cap+1 rows, and the limit is charged first.
   const limit=Math.min(caps.pointerPage,caps.pointerInspect-inspected+1);
   if(limit<1)throw new Incomplete('pointer_inspection_cap');
   const page=await execRows(cdb,budget,'SELECT film_id AS id FROM prediction_pointer WHERE film_id>? AND film_id<? ORDER BY film_id LIMIT ?',[cursor,range.hi],limit);
   inspected+=page.length;work.pointerRows+=page.length;
   if(inspected>caps.pointerInspect)throw new Incomplete('pointer_inspection_cap');
   if(!page.length)break;
   const ids=page.map(row=>row.id);
   const claimed=new Set((await readRows(cdb,budget,'direct_claims',"SELECT value FROM film_external_id WHERE scheme='letterboxd' AND trusted=1 AND conflicting=0 AND value IN (SELECT value FROM json_each(?)) LIMIT ?",[JSON.stringify(ids)],caps.pointerPage)).map(row=>row.value));
   for(const id of ids)(claimed.has(id)?direct:candidates).push(id);
   if(candidates.length>caps.candidates)throw new Incomplete('candidate_cap');
   if(page.length<limit)break;
   cursor=ids[ids.length-1];
  }
 }
 return {direct:direct.length,candidates};
}
const resolveMovie=(index,lid)=>{
 const key=index['letterboxd:'+lid];
 if(typeof key!=='string')return {key:null,movie:null,source:'bridge_unresolved',reason:'ratings_link_absent'};
 const movies=Object.keys(index).filter(alias=>alias.startsWith('tmdb:')&&index[alias]===key).map(alias=>alias.slice(5));
 return movies.length===1?{key,movie:movies[0],source:'bridge_resolved'}:{key,movie:null,source:'bridge_unresolved',reason:'ratings_movie_link_missing_or_ambiguous'};
};
const AUTHORITY_TABLES=['film_person_authority','film_person_cas','film_person_baseline','schema_contract','ratings_domain_authority','prediction_domain_authority'];
// Part A: the markers and the link index (one atomic document statement).
async function captureA(cdb,budget,caps,{withIndex}){
 const markers={};
 for(const table of AUTHORITY_TABLES)markers[table]=await readRows(cdb,budget,'marker_'+table,'SELECT * FROM '+table+' LIMIT ?',[],3);
 let links=null,index=null;
 if(withIndex){
  links=(await readDocuments(cdb,budget,['letterboxd/facts/links.json'],LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES)).get('letterboxd/facts/links.json');
  index=links?assemble(links):null;
  if(index&&(typeof index!=='object'||Array.isArray(index)))throw new Incomplete('ratings_links_unreadable');
  if(index&&Object.keys(index).length>LINK_INDEX_MAX_ENTRIES)throw new Incomplete('link_index_over_cap');
 }
 return {markers,links,index};
}
// Part B: everything the planner and the multiplicity read for a chunk of subjects, each list LIMIT cap+1 over an indexed predicate.
async function captureB(cdb,budget,caps,subjects){
 const out={records:[],claims:[],films:[],revisions:[],redirects:[],retirements:[],views:[],factKeyViews:[],witness:[],pointers:[]};
 for(const group of chunks(subjects,caps.chunk)){
  const lids=group.map(item=>item.lid),movies=[...new Set(group.map(item=>item.movie).filter(Boolean))],keys=[...new Set(group.map(item=>item.key).filter(Boolean))];
  const L=JSON.stringify(lids),M=JSON.stringify(movies);
  if(keys.length){
   const docs=await readDocuments(cdb,budget,keys.map(key=>'letterboxd/facts/films/'+key+'.json'),FACT_RECORD_MAX_PARTS,FACT_RECORD_MAX_BYTES);
   for(const [key,parts] of docs)if(parts)out.records.push(...parts.map(item=>({...item,key})));
  }
  const claims1=await readRows(cdb,budget,'claims',"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE (scheme='letterboxd' AND value IN (SELECT value FROM json_each(?))) OR (scheme='tmdb' AND value IN (SELECT value FROM json_each(?))) ORDER BY film_id,scheme,value LIMIT ?",[L,M],caps.list);
  const owners=[...new Set(claims1.map(row=>row.film_id))];
  const O=JSON.stringify(owners);
  const claims2=owners.length?await readRows(cdb,budget,'owner_claims',"SELECT film_id,scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id IN (SELECT value FROM json_each(?)) AND scheme IN ('tmdb','letterboxd') ORDER BY film_id,scheme,value LIMIT ?",[O],caps.list):[];
  out.claims.push(...claims1,...claims2);
  if(owners.length){
   out.films.push(...await readRows(cdb,budget,'films','SELECT * FROM film WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?',[O],caps.list));
   out.revisions.push(...await readRows(cdb,budget,'revisions',"SELECT * FROM canonical_revision WHERE kind='film' AND id IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?",[O],caps.list));
   out.redirects.push(...await readRows(cdb,budget,'redirects','SELECT * FROM film_redirect WHERE from_id IN (SELECT value FROM json_each(?)) ORDER BY from_id LIMIT ?',[O],caps.list));
  }
  if(movies.length){
   out.retirements.push(...await readRows(cdb,budget,'retirements','SELECT * FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM json_each(?)) ORDER BY seq LIMIT ?',[M],caps.list));
   out.witness.push(...await readRows(cdb,budget,'witness','SELECT * FROM film_rated_admission WHERE tmdb IN (SELECT value FROM json_each(?)) ORDER BY tmdb LIMIT ?',[M],caps.list));
  }
  const aliases=JSON.stringify([...lids,...movies.map(value=>'tmdb_'+value)]);
  out.views.push(...await readRows(cdb,budget,'views','SELECT * FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each(?)) ORDER BY alias_id LIMIT ?',[aliases],caps.list));
  if(keys.length)out.factKeyViews.push(...await readRows(cdb,budget,'fact_key_views','SELECT * FROM ratings_view WHERE fact_key IN (SELECT value FROM json_each(?)) ORDER BY alias_id LIMIT ?',[JSON.stringify(keys)],caps.list));
  out.pointers.push(...await readRows(cdb,budget,'pointers','SELECT film_id,content_sha256,fingerprint_hash,predicted_rating FROM prediction_pointer WHERE film_id IN (SELECT value FROM json_each(?)) ORDER BY film_id LIMIT ?',[JSON.stringify([...lids,...movies.map(value=>'tmdb_'+value)])],caps.list));
 }
 return out;
}
const dedupe=list=>{const seen=new Set(),out=[];for(const item of list){const key=JSON.stringify(item);if(!seen.has(key)){seen.add(key);out.push(item);}}return out;};
const sections=(a,b)=>{
 const s={
  markers:a.markers,
  documents:[...(a.links||[]).map(item=>[item.key,item.part,item.etag,sha(item.body)]),...b.records.map(item=>[item.key,item.part,item.etag,sha(item.body)])],
  claims:dedupe(b.claims),
  owner:{films:dedupe(b.films),revisions:dedupe(b.revisions),redirects:dedupe(b.redirects),retirements:dedupe(b.retirements)},
  views:dedupe([...b.views,...b.factKeyViews]),
  witness:dedupe(b.witness),
  pointers:dedupe(b.pointers),
 };
 return s;
};
const tokenOf=(s,extra)=>{const digests=Object.fromEntries(Object.entries(s).map(([name,value])=>[name,digestOf(value)]));return {digests,token:digestOf({digests,extra})};};
// The private snapshot: the migration chain's schema with triggers dropped (the evaluator never writes), the captured rows only.
function materialize(a,b){
 const file=path.join(root,'snap-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 const insert=(table,list)=>list.map(row=>{const cols=Object.keys(row);return 'INSERT OR REPLACE INTO '+table+' ('+cols.join(',')+') VALUES ('+cols.map(col=>q(row[col])).join(',')+');';}).join('\n');
 const wipe=['film_person_authority','film_person_cas','film_person_baseline','schema_contract','ratings_domain_authority','prediction_domain_authority','ratings_document','ratings_view','film_external_id','film','canonical_revision','film_redirect','tmdb_retirement_decision','film_rated_admission'];
 const documents=[...(a.links||[]),...b.records].map(item=>({key:item.key,part:item.part,body:item.body,etag:item.etag,updated_at:U}));
 sqlite(file,'PRAGMA foreign_keys=OFF;\n'+TRIGGERS.map(name=>'DROP TRIGGER IF EXISTS '+name+';').join('')+wipe.map(table=>'DELETE FROM '+table+';').join('')
  +AUTHORITY_TABLES.map(table=>insert(table,a.markers[table])).join('\n')+insert('ratings_document',documents)
  +insert('ratings_view',dedupe([...b.views,...b.factKeyViews]))+insert('film',dedupe(b.films))+insert('film_external_id',dedupe(b.claims))+insert('canonical_revision',dedupe(b.revisions))
  +insert('film_redirect',dedupe(b.redirects))+insert('tmdb_retirement_decision',dedupe(b.retirements))+insert('film_rated_admission',dedupe(b.witness)));
 return file;
}
function classifyPlan(plan,{lid,movie},witness,scope){
 if(plan.verdict==='conflict')return {state:'ineligible',reason:plan.reason};
 if(plan.verdict==='not_proved')return {state:NEGATIVE_NOT_PROVED.has(plan.reason)?'ineligible':'unknown',reason:plan.reason};
 if(plan.already)return {state:'already',reason:'already_current'};
 if(!scopeValid(scope))return {state:'unknown',reason:'witness_scope_missing'};
 // The witness is looked up by movie (the unique admission index) and compared by lid and archive, across every Film, so a canonical merge that moved the row is still seen.
 const positive=witness.some(row=>String(row.tmdb)===movie&&row.source_code===lid&&scope.archives.includes(row.archive_sha256));
 return positive?{state:'ineligible',reason:'inferred_admission_witness'}:{state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_in_scope'};
}
// Pure: the duplicate-target guard of `deriveBackfillCohort`: two candidates on one Film or one movie cannot both be written, so they are refused here, not silently kept.
function guardDuplicates(results){
 const resolved=results.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie,filmId:item.filmId}));
 const dup=new Set(findDuplicateTargets(resolved).map(item=>item.lid));
 return results.map(item=>dup.has(item.lid)?{...item,state:'unknown',reason:'cohort_duplicate_target'}:item);
}
// Multiplicity by RESOLVED CANONICAL OWNERSHIP, over the captured rows only: the owner is the one Film that holds the movie as its unique trusted claim AND exists, is no redirect source, is not retired and holds no untrusted or conflicting
// tmdb/letterboxd claim. Anything else is an UNRESOLVED OWNER (a weaker metric, named as such). Keys and distinct Films are counted separately.
function multiplicity(subjects,raw){
 const b={...raw,claims:dedupe(raw.claims)};
 const out={keys:0,distinct_films:0,bridge_only:0,dual:0,differing:0,unresolved_owner:0};
 const pointerOf=new Map(b.pointers.map(row=>[row.film_id,row]));
 const films=new Set();
 const retired=new Set(b.retirements.filter(r=>r.kind==='retire'&&!b.retirements.some(s=>s.supersedes_seq===r.seq)).map(r=>String(r.movie_id)));
 for(const item of subjects){
  out.keys++;
  const trusted=b.claims.filter(row=>row.scheme==='tmdb'&&row.value===item.movie);
  const owner=trusted.length===1&&trusted[0].trusted===1&&trusted[0].conflicting===0?trusted[0].film_id:null;
  const ok=owner&&b.films.some(row=>row.id===owner)&&!b.redirects.some(row=>row.from_id===owner)&&!retired.has(item.movie)&&!b.claims.some(row=>row.film_id===owner&&(row.trusted!==1||row.conflicting!==0));
  if(!ok){out.unresolved_owner++;continue;}
  films.add(owner);
  const second=pointerOf.get('tmdb_'+item.movie),own=pointerOf.get(item.lid);
  if(!second){out.bridge_only++;continue;}
  out.dual++;if(second.predicted_rating!==own?.predicted_rating)out.differing++;
 }
 out.distinct_films=films.size;
 return out;
}
const unknown=(reason,extra={})=>({decision:'unknown',reason,candidateDigest:null,readSetDigest:null,results:[],liveBlockers:LIVE_BLOCKERS,...extra});
// hooks (tests only): a concurrent writer injected at a precise point. `afterDiscovery`, `afterFirstCapture` (empty cohort), `afterIndex` (between the index and the rest of the capture), `afterClassify` (between the two passes).
async function preflight(env,{scope=null,caps={},hooks={}}={}){
 const c={...DEFAULT_CAPS,...caps},budget=newBudget(c),cdb=countedDatabase(env.DB,budget.statements),work={pointerRows:0};
 const report=body=>({...body,work:{statements:budget.statements.used,rowsReserved:budget.rows,pointerRows:work.pointerRows}});
 const hook=async name=>{if(hooks[name])await hooks[name]();};
 try{
  const found=await discover(cdb,budget,c,work);
  await hook('afterDiscovery');
  if(!found.candidates.length){
   // An empty cohort is certified only on the same terms: the markers read, evaluated by the real authority reader on a snapshot, read again after a repeated discovery, and equal.
   const a1=await captureA(cdb,budget,c,{withIndex:false});
   await hook('afterFirstCapture');
   const again=await discover(cdb,budget,c,work);
   const a2=await captureA(cdb,budget,c,{withIndex:false});
   if(again.candidates.length||digestOf(a1.markers)!==digestOf(a2.markers))return report(unknown('read_set_moved',{moved:['markers']}));
   const gate=await planLetterboxdClaim(envOf(materialize(a1,{records:[],claims:[],films:[],revisions:[],redirects:[],retirements:[],views:[],factKeyViews:[],witness:[]})),{lid:'AUTHORITY',tmdb:'1'}).then(()=>null,error=>error);
   if(gate)return report(unknown(gate.code||'authority_unreadable'));
   const ratings=a1.markers.ratings_domain_authority[0];
   if(!ratings||ratings.mode!=='d1'||ratings.cutover!=='open')return report(unknown('ratings_not_authoritative'));
   return report({decision:'complete',reason:null,counts:{},sources:{direct_excluded:found.direct,bridge_resolved:0,bridge_unresolved:0},results:[],candidateDigest:await cohortDigest([]),readSetDigest:tokenOf({markers:a1.markers},[]).token,liveBlockers:LIVE_BLOCKERS});
  }
  const pass=async subjectsIn=>{
   const a=await captureA(cdb,budget,c,{withIndex:true});
   if(!a.index)throw new Incomplete('ratings_links_absent');
   if(!subjectsIn)await hook('afterIndex');
   const subjects=subjectsIn||found.candidates.map(lid=>({lid,...resolveMovie(a.index,lid)}));
   const b=await captureB(cdb,budget,c,subjects.filter(item=>item.source==='bridge_resolved'||item.key));
   return {a,b,subjects};
  };
  const first=await pass(null);
  const sectionsOne=sections(first.a,first.b);
  const snapshot=envOf(materialize(first.a,first.b));
  const results=[];
  for(const item of first.subjects){
   if(item.source==='bridge_unresolved'){results.push({lid:item.lid,movie:null,source:item.source,state:'unknown',reason:item.reason});continue;}
   let plan;
   try{plan=await planLetterboxdClaim(snapshot,{lid:item.lid,tmdb:item.movie});}
   catch(error){results.push({lid:item.lid,movie:item.movie,source:item.source,state:'unknown',reason:error?.code||'unclassified'});continue;}
   results.push({lid:item.lid,movie:item.movie,source:item.source,filmId:plan.filmId??null,...classifyPlan(plan,item,first.b.witness,scope)});
  }
  await hook('afterClassify');
  // Revalidation: a second capture of the same subjects and a repeated discovery, charged to the SAME budget. Any difference in any section is `unknown`.
  const second=await pass(first.subjects);
  const again=await discover(cdb,budget,c,work);
  const one=tokenOf(sectionsOne,first.subjects.map(item=>item.lid)),two=tokenOf(sections(second.a,second.b),second.subjects.map(item=>item.lid));
  const moved=Object.keys(one.digests).filter(name=>one.digests[name]!==two.digests[name]);
  if(again.candidates.join('\n')!==found.candidates.join('\n'))moved.push('candidate_set');
  if(moved.length)return report(unknown('read_set_moved',{moved}));
  const guarded=guardDuplicates(results);
  const counts={};for(const item of guarded)counts[item.state]=(counts[item.state]||0)+1;
  const sources={direct_excluded:found.direct,bridge_resolved:guarded.filter(item=>item.source==='bridge_resolved').length,bridge_unresolved:guarded.filter(item=>item.source==='bridge_unresolved').length};
  const eligible=guarded.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie}));
  return report({decision:'complete',reason:null,counts,sources,results:guarded,multiplicity:multiplicity(first.subjects.filter(item=>item.source==='bridge_resolved'),first.b),readSetDigest:one.token,sectionDigests:one.digests,candidateDigest:await cohortDigest(eligible),liveBlockers:LIVE_BLOCKERS,snapshot:first});
 }catch(error){
  if(error instanceof Incomplete)return report(unknown(error.reason,{coverage:'incomplete'}));
  return report(unknown(error?.code||'read_set_unreadable',{coverage:'unreadable',detail:String(error?.message||error).slice(0,200)}));
 }
}

// ======================= the synthetic cohort (15 keys) =======================
const INFERRED_ARCHIVE='a'.repeat(64);
const SCOPE={invariant:WITNESS_INVARIANT,archives:[INFERRED_ARCHIVE]};
const ELIGIBLE={state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_in_scope'};
const CASES={
 BR01:ELIGIBLE,
 BR02:ELIGIBLE,                                                          // canonical_identity NULL is allowed (ADR 0184 2c)
 BR03:ELIGIBLE,
 BR04:{state:'ineligible',reason:'inferred_admission_witness'},          // HISTORICAL INVARIANT: a Diary-first `lb-<lid>` record, no durable mark, the planner passes; the admission witness blocks
 BR05:{state:'ineligible',reason:'ratings_link_inferred'},               // POST-REPAIR CONTROL: the same shape after the AIR-559 repair: `inferredPairs` names the pair, the planner refuses
 BR06:{state:'ineligible',reason:'ratings_link_inferred'},               // the record-level `identity` mark
 BR07:{state:'unknown',reason:'ratings_movie_link_missing_or_ambiguous'},// the lid's fact key is shared with no movie alias
 BR08:{state:'ineligible',reason:'ratings_link_ambiguous'},              // a third alias on the key
 BR09:{state:'ineligible',reason:'ratings_record_not_settled'},          // mid-migration
 BR10:{state:'ineligible',reason:'film_redirected'},
 BR11:{state:'ineligible',reason:'tmdb_retired'},
 BR12:{state:'ineligible',reason:'canonical_identity_mismatch'},
 BR13:{state:'ineligible',reason:'lid_claimed_elsewhere'},               // an UNTRUSTED claim of the lid elsewhere (a trusted one makes the key a direct-claim key)
 BR14:{state:'unknown',reason:'ratings_link_absent'},                    // pointer exists, the authoritative index does not name the lid: missing proof
 BR15:{state:'unknown',reason:'film_absent'},                            // link proof exists, no canonical Film owns the movie
};
const DUAL=new Set(['BR05','BR06','BR08','BR09','BR10','BR11','BR12','BR13','BR14','BR15']);
const DIFFERING=new Set(['BR05','BR06','BR08','BR09']);
function world(){
 const file=database();
 Object.keys(CASES).forEach((lid,i)=>{
  const k=i+1,tmdb=String(k);
  if(lid!=='BR15')seedFilm(file,k,lid==='BR02'?{identity:null}:lid==='BR12'?{identity:'tmdb:9999'}:{});
  const ratings={};
  const base=(key,extra={})=>({schemaVersion:1,factKey:key,links:{letterboxd:lid,tmdb:tmdb},redirectTo:null,migrating:null,...extra});
  if(lid==='BR04'||lid==='BR05'){ratings.key='lb-'+lid;ratings.lidKey='lb-'+lid;ratings.record=base('lb-'+lid,lid==='BR05'?{inferredPairs:[{letterboxd:lid,tmdb:tmdb,kind:'inferred',sourceRef:INFERRED_ARCHIVE}]}:{});}
  if(lid==='BR06')ratings.record=base('tmdb-'+k,{identity:{kind:'inferred'}});
  if(lid==='BR07')ratings.lidKey='lb-'+lid;
  if(lid==='BR08')ratings.third='letterboxd:EXTRA'+k;
  if(lid==='BR09')ratings.record=base('tmdb-'+k,{migrating:{to:'x'}});
  seedRatings(file,lid,k,{...ratings,index:lid!=='BR14'});
  if(lid==='BR07')putDoc(file,'letterboxd/facts/films/lb-'+lid+'.json',base('lb-'+lid));
  pointer(file,lid,3.5);
  if(DUAL.has(lid))pointer(file,'tmdb_'+tmdb,DIFFERING.has(lid)?4:3.5);
 });
 run(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:redirect-target',2,'tmdb:5000','Target','"+U+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(FID(10))+",'film:redirect-target',"+q(U)+")");
 run(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r1',"+q(FID(11))+",'retire','BR11','11','1',"+q('{}')+","+q(JSON.stringify({by:'owner',at:U,source:'synthetic'}))+",'owner_request','{}',"+q(U)+")");
 run(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',2,NULL,'Other','"+U+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','letterboxd','BR13',0,0,NULL)");
 for(const lid of ['BR04','BR05']){const k=Object.keys(CASES).indexOf(lid)+1;run(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(k))+","+q(String(k))+","+q(lid)+","+q(INFERRED_ARCHIVE)+",'T',2000,'rk','tmdb_"+k+"','2026-11-01T00:00:00.000Z','rq"+k+"',"+q(U)+")");}
 return file;
}
const stateOf=(out,lid)=>{const item=out.results.find(entry=>entry.lid===lid);return {state:item.state,reason:item.reason};};
const LIVE_VERDICTS=async(file,lids)=>{const out={};for(const lid of lids){const k=Object.keys(CASES).indexOf(lid)+1;try{const plan=await planLetterboxdClaim(envOf(file),{lid,tmdb:String(k)});out[lid]=plan.verdict+':'+plan.reason;}catch(error){out[lid]='throw:'+error.code;}}return out;};

// ---- 0. drift guard: the document statement is the AIR-647 one ----
{
 // The source builds the statement from two literals; both halves must still be there verbatim.
 const source=fs.readFileSync('src/film-aggregate.js','utf8');
 const halves=BOUNDED_DOCUMENTS_SQL.split(') SELECT g.key').map((part,index)=>index?'SELECT g.key'+part:part+') ');
 assert.equal(halves.length,2);
 for(const half of halves)assert.ok(source.includes(half),'the atomic document statement matches src/film-aggregate.js: '+half.slice(0,40));
}

// ---- 1. the main cohort: exact states and reasons, accounting, multiplicity by ownership, no write, a usable digest ----
const file=world();
const before=dump(file);
{
 const out=await preflight(envOf(file),{scope:SCOPE});
 assert.deepEqual([out.decision,out.reason],['complete',null],out.reason+' '+(out.detail||''));
 assert.deepEqual(Object.fromEntries(out.results.map(item=>[item.lid,{state:item.state,reason:item.reason}])),CASES);
 assert.deepEqual(out.counts,{eligible_in_scope:3,ineligible:9,unknown:3},'the classes add up to the whole cohort');
 assert.equal(Object.values(out.counts).reduce((a,b)=>a+b,0),15);
 assert.deepEqual(out.sources,{direct_excluded:0,bridge_resolved:13,bridge_unresolved:2},'direct, bridge-resolved and bridge-unresolved are distinguished');
 assert.match(out.candidateDigest,/^[0-9a-f]{64}$/);assert.match(out.readSetDigest,/^[0-9a-f]{64}$/);
 assert.equal(out.candidateDigest,await cohortDigest([{lid:'BR01',tmdb:'1'},{lid:'BR02',tmdb:'2'},{lid:'BR03',tmdb:'3'}]),'a candidate digest, NOT a frozen write cohort: AIR-653 re-proves at write time');
 // Over the 13 bridge-resolved keys, by resolved ownership: a redirected owner (BR10), a retired one (BR11) and a movie with no Film (BR15) are UNRESOLVED OWNERS, a weaker metric reported as such.
 assert.deepEqual(out.multiplicity,{keys:13,distinct_films:10,bridge_only:4,dual:6,differing:4,unresolved_owner:3});
 assert.equal(dump(file),before,'the preflight writes nothing: 17 tables unchanged');
 assert.deepEqual(out.liveBlockers,LIVE_BLOCKERS);
 assert.equal((await preflight(envOf(file),{scope:SCOPE})).candidateDigest,out.candidateDigest,'repeatable on an unchanged read-set');
 // The report counts BOTH passes and the repeated discovery against ONE budget.
 assert.ok(out.work.statements>0&&out.work.statements<=DEFAULT_CAPS.statements&&out.work.rowsReserved<=DEFAULT_CAPS.rows);
 if(process.env.AIR652_REPORT)console.log('15-key fixture work',JSON.stringify(out.work));
}

// ---- 2. DIFFERENTIAL: the planner over the private snapshot answers exactly what it answers over the live fixture, so the token binds the exact consumed data ----
{
 const allLids=Object.keys(CASES).filter(lid=>!['BR07','BR14'].includes(lid));
 const worlds=[
  ['main',world()],
  ['rival alias on a fact key',(()=>{const f=world();run(f,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('RIVAL','tmdb-1',NULL,NULL,0,0,"+q(U)+")");return f;})()],
  ['a different trusted lid on an owner',(()=>{const f=world();run(f,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(1))+",'letterboxd','ZZZ',1,0,NULL)");return f;})()],
  ['a second trusted movie claim',(()=>{const f=world();run(f,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(2))+",'tmdb','8888',1,0,NULL)");return f;})()],
  ['owner identity changed',(()=>{const f=world();run(f,"UPDATE film SET canonical_identity='tmdb:9999' WHERE id="+q(FID(1)));return f;})()],
  ['a different Film claims the lid, trusted (BR03 becomes a direct-claim key, so it is no candidate)',(()=>{const f=world();run(f,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:thief',2,NULL,'T',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:thief','letterboxd','BR03',1,0,NULL)");return f;})()],
 ];
 for(const [name,f] of worlds){
  const out=await preflight(envOf(f),{scope:SCOPE});
  assert.equal(out.decision,'complete',name+': '+out.reason+' '+(out.detail||''));
  const lids=allLids.filter(lid=>!(name.includes('BR03')&&lid==='BR03'));
  const live=await LIVE_VERDICTS(f,lids);
  // The planner over the snapshot, for the same keys.
  const snap=envOf(materializeFrom(out));
  for(const lid of lids){
   const k=Object.keys(CASES).indexOf(lid)+1;
   let verdict;try{const plan=await planLetterboxdClaim(snap,{lid,tmdb:String(k)});verdict=plan.verdict+':'+plan.reason;}catch(error){verdict='throw:'+error.code;}
   assert.equal(verdict,live[lid],name+' '+lid);
  }
 }
}
function materializeFrom(out){return materialize(out.snapshot.a,out.snapshot.b);}

// ---- 3. the witness scope: missing / empty / malformed is `unknown`, never eligible; a positive witness blocks; a negative one is relative to the stated scope ----
{
 for(const scope of [null,{},{invariant:WITNESS_INVARIANT,archives:[]},{invariant:WITNESS_INVARIANT,archives:['not-a-digest']},{invariant:'other',archives:[INFERRED_ARCHIVE]}]){
  const out=await preflight(envOf(file),{scope});
  assert.equal(out.decision,'complete');
  assert.equal(out.counts.eligible_in_scope??0,0,'no key is eligible without a valid witness scope: '+JSON.stringify(scope));
  for(const lid of ['BR01','BR02','BR03','BR04'])assert.deepEqual(stateOf(out,lid),{state:'unknown',reason:'witness_scope_missing'},lid);
 }
 assert.equal((await planLetterboxdClaim(envOf(file),{lid:'BR04',tmdb:'4'})).verdict,'pass','the planner alone passes the historical-invariant pair');
 const other=await preflight(envOf(file),{scope:{invariant:WITNESS_INVARIANT,archives:['b'.repeat(64)]}});
 assert.equal(stateOf(other,'BR04').state,'eligible_in_scope','the verdict is relative to the stated scope only');
 assert.equal((await planLetterboxdClaim(envOf(file),{lid:'BR05',tmdb:'5'})).reason,'ratings_link_inferred','the post-repair control is refused by the planner');
}

// ---- 4. a witness that cannot be read, or that moves, is typed unknown with no digest ----
const MOVED=['unknown','read_set_moved',null,null];
{
 const failing=envOf(file,{onQuery:text=>{if(text.includes('film_rated_admission'))throw Object.assign(new Error('boom'),{code:'witness_unavailable'});}});
 const out=await preflight(failing,{scope:SCOPE});
 assert.deepEqual([out.decision,out.reason,out.coverage,out.candidateDigest,out.readSetDigest],['unknown','witness_unavailable','unreadable',null,null]);
 for(const [name,change] of [
  ['insert',f=>run(f,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(1))+",'1','BR01',"+q(INFERRED_ARCHIVE)+",'T',2000,'rk','tmdb_1','2026-11-01T00:00:00.000Z','rqx',"+q(U)+")")],
  ['delete',f=>run(f,"DELETE FROM film_rated_admission WHERE source_code='BR04'")],
  ['move',f=>run(f,"UPDATE film_rated_admission SET film_id='film:other' WHERE source_code='BR04'")],
 ]){
  const f=world();
  const moved=await preflight(envOf(f),{scope:SCOPE,hooks:{afterClassify:()=>change(f)}});
  assert.deepEqual([moved.decision,moved.reason,moved.candidateDigest,moved.readSetDigest],MOVED,name);
  assert.ok(moved.moved.includes('witness'),name+' moved the witness section: '+moved.moved);
 }
}

// ---- 5. every part of the read-set is bound, including the planner predicates the first design omitted ----
{
 const movers=[
  ['owner',  'owner identity changed after BR01 passed (the review counterexample)',f=>run(f,"UPDATE film SET canonical_identity='tmdb:9999' WHERE id="+q(FID(1)))],
  ['claims', 'a different trusted lid on the owner, no pointer for it (the review counterexample)',f=>run(f,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(1))+",'letterboxd','ZZZ',1,0,NULL)")],
  ['claims', 'a second tmdb claim on the owner',f=>run(f,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(2))+",'tmdb','8888',1,0,NULL)")],
  ['claims', 'a new competing untrusted claim of the lid',f=>run(f,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',2,NULL,'Rival',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:rival','letterboxd','BR01',0,0,NULL)")],
  ['owner',  'the owner revision moved',f=>run(f,"INSERT OR REPLACE INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',"+q(FID(3))+",2,"+q(U)+")")],
  ['owner',  'a new redirect on the owner',f=>run(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(FID(2))+",'film:redirect-target',"+q(U)+")")],
  ['views',  'a projection disagreement',f=>run(f,"UPDATE ratings_view SET fact_key='tmdb-other' WHERE alias_id='BR02'")],
  ['views',  'a rival alias on the fact key',f=>run(f,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('RIVAL','tmdb-1',NULL,NULL,0,0,"+q(U)+")")],
  ['pointers','a pointer change',f=>run(f,"UPDATE prediction_pointer SET content_sha256="+q('d'.repeat(64))+" WHERE film_id='BR03'")],
  ['documents','a fact record replaced',f=>putDoc(f,'letterboxd/facts/films/tmdb-1.json',{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'BR01',tmdb:'1'},redirectTo:null,migrating:null,note:'moved'})],
  ['markers','ratings generation',f=>run(f,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1")],
  ['markers','prediction generation',f=>run(f,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1")],
  ['markers','Film/Person marker',f=>run(f,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1")],
  ['candidate_set','a new pointer key',f=>pointer(f,'NEWLID',2)],
 ];
 for(const [section,name,change] of movers){
  const f=world();
  const out=await preflight(envOf(f),{scope:SCOPE,hooks:{afterClassify:()=>change(f)}});
  assert.deepEqual([out.decision,out.reason,out.candidateDigest,out.readSetDigest],MOVED,name+' '+(out.detail||''));
  assert.ok(out.moved.includes(section),name+': the '+section+' section is named: '+out.moved);
 }
 // The index replaced in the gap BETWEEN the index read and the rest of the capture (the gap the first design left unfenced).
 const gap=world();
 const replaced=await preflight(envOf(gap),{scope:SCOPE,hooks:{afterIndex:()=>{const links=getDoc(gap,'letterboxd/facts/links.json');links['letterboxd:BR01']='tmdb-1';links['letterboxd:EXTRA']='tmdb-1';putDoc(gap,'letterboxd/facts/links.json',links);}}});
 assert.deepEqual([replaced.decision,replaced.reason,replaced.candidateDigest],['unknown','read_set_moved',null]);
 assert.ok(replaced.moved.includes('documents'));
}

// ---- 6. discovery is bounded BEFORE the per-key proof, by the work actually done, over BOTH passes ----
const bulk=({candidates=true,noise=0}={})=>{
 const f=database();
 const DIRECT=300,TMDB=3000;
 const pointers=(prefix,count,offset,tag)=>"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+count+") INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) SELECT '"+prefix+"'||("+offset+"+n),3,'h','"+tag+"'||n,1,1,3.5,'k',"+q('c'.repeat(64))+","+q(U)+",'{}' FROM s;";
 run(f,"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+DIRECT+") INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) SELECT 'film:lid:'||n,2,NULL,'T',"+q(U)+" FROM s;"
  +"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+DIRECT+") INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) SELECT 'film:lid:'||n,'letterboxd','D'||n,1,0,NULL FROM s;"
  +pointers('D',DIRECT,0,'f')+pointers('tmdb_',TMDB,100000,'g'));
 if(candidates){
  for(const [lid,k] of [['CA1',201],['CA2',202]]){seedFilm(f,k);seedRatings(f,lid,k);pointer(f,lid,3.5);}
  pointer(f,'CB1',3.5);                                   // no link index entry
  seedRatings(f,'CC1',203);pointer(f,'CC1',3.5);          // link proof, no canonical Film
 }
 if(noise)run(f,"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+noise+") INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) SELECT 'film:noise:'||n,2,NULL,'N',"+q(U)+" FROM s;"
  +"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+noise+") INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) SELECT 'film:noise:'||n,'tmdb','9'||(100000+n),1,0,NULL FROM s;"
  +"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+noise+") INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) SELECT 'NZ'||n,'nz-'||n,NULL,NULL,0,0,"+q(U)+" FROM s;");
 return f;
};
{
 const f=bulk();
 const stats={read:0,written:0};
 const out=await preflight(envOf(f,{rowStats:stats}),{scope:SCOPE});
 assert.equal(out.decision,'complete',out.reason+' '+(out.detail||''));
 assert.deepEqual(out.sources,{direct_excluded:300,bridge_resolved:3,bridge_unresolved:1},'direct keys are excluded; bridge-resolved and unresolved candidates are distinguished');
 assert.deepEqual(out.counts,{eligible_in_scope:2,unknown:2});
 // Pointer work covers BOTH discoveries: 304 each, never the 3,304 of the table.
 assert.equal(out.work.pointerRows,608,'two discoveries of 304 non-tmdb pointer rows; the 3,000 tmdb-spelled ones are skipped by the key range');
 assert.ok(out.work.statements<=DEFAULT_CAPS.statements);
 if(process.env.AIR652_REPORT)console.log('bulk fixture work',JSON.stringify(out.work),JSON.stringify(stats));
 // Unrelated rows do not change the work: the same cohort with 5,000 more unrelated Films, claims and projection rows reads the SAME number of rows.
 const noisy=bulk({noise:5000}),noisyStats={read:0,written:0};
 const noisyOut=await preflight(envOf(noisy,{rowStats:noisyStats}),{scope:SCOPE});
 assert.equal(noisyOut.decision,'complete');
 assert.equal(noisyStats.read,stats.read,'rows read are independent of unrelated rows');
 assert.equal(noisyOut.work.statements,out.work.statements);
 assert.equal(noisyStats.written,0);
 // Caps: cap and cap+1 (the cap itself reads, the next row does not).
 const capped=await preflight(envOf(f),{scope:SCOPE,caps:{pointerInspect:303}});
 assert.deepEqual([capped.decision,capped.reason,capped.coverage,capped.candidateDigest],['unknown','pointer_inspection_cap','incomplete',null]);
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{pointerInspect:304}})).decision,'complete','exactly at the cap is complete');
 assert.deepEqual((a=>[a.decision,a.reason])(await preflight(envOf(f),{scope:SCOPE,caps:{candidates:3}})),['unknown','candidate_cap'],'4 candidates against a cap of 3');
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{candidates:4}})).decision,'complete');
 // A list over its row cap is `incomplete`, charged before it runs.
 assert.deepEqual((a=>[a.decision,a.reason])(await preflight(envOf(f),{scope:SCOPE,caps:{list:1}})),['unknown','row_cap:claims']);
 // TOTAL BUDGET: the run needs N statements; N passes, N-1 fails somewhere, and the failure of the RECHECK is the same typed answer with no digest.
 const need=out.work.statements;
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{statements:need}})).decision,'complete','exactly the budget is complete');
 const starved=await preflight(envOf(f),{scope:SCOPE,caps:{statements:need-1}});
 assert.deepEqual([starved.decision,starved.reason,starved.candidateDigest,starved.readSetDigest],['unknown','budget_exhausted',null,null]);
 const rowsNeeded=out.work.rowsReserved;
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{rows:rowsNeeded}})).decision,'complete');
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{rows:rowsNeeded-1}})).reason,'budget_exhausted','the row ledger is charged before every statement');
 // no matches: only direct keys, a complete and empty cohort, certified on the same terms; no tmdb-spelled key is ever inspected.
 const none=await preflight(envOf(bulk({candidates:false})),{scope:SCOPE});
 assert.deepEqual([none.decision,none.counts,none.sources.direct_excluded,none.work.pointerRows],['complete',{},300,600]);
 // EXPLAIN: the captured predicates are indexed SEARCHes, the fact_key projection predicate included once migration 0055 is applied (its production apply is a live-run prerequisite).
 const plan=sql=>String(sqliteSync([f],{input:'EXPLAIN QUERY PLAN '+sql+';',encoding:'utf8'}).stdout).replace(/\s+/g,' ');
 assert.match(plan("SELECT film_id FROM film_external_id WHERE scheme='letterboxd' AND value IN (SELECT value FROM json_each('[\"a\"]')) LIMIT 5"),/SEARCH/);
 assert.match(plan("SELECT * FROM film_rated_admission WHERE tmdb IN (SELECT value FROM json_each('[\"1\"]')) LIMIT 5"),/SEARCH/);
 assert.match(plan("SELECT * FROM tmdb_retirement_decision WHERE movie_id IN (SELECT value FROM json_each('[\"1\"]')) LIMIT 5"),/SEARCH/);
 assert.match(plan("SELECT * FROM ratings_view WHERE alias_id IN (SELECT value FROM json_each('[\"a\"]')) LIMIT 5"),/SEARCH/);
 assert.match(plan("SELECT * FROM ratings_view WHERE fact_key IN (SELECT value FROM json_each('[\"a\"]')) LIMIT 5"),/SEARCH ratings_view USING INDEX ratings_view_fact_key/,'with 0055 the fact_key predicate is an index SEARCH');
 assert.ok(out.liveBlockers.some(item=>item.startsWith('ratings_view_fact_key_index_0055')),'the production apply of 0055 stays a live-run prerequisite');
}

// ---- 7. documents: the atomic parts/bytes statement refuses an oversized link or record part and a replacement after the measure ----
{
 // replace(hex(zeroblob(N)),'00','a') is a string of N characters.
 const big='replace(hex(zeroblob('+(LINK_DOCUMENT_MAX_BYTES+10)+")),'00','a')";
 // one oversized LINK part (bytes over the cap, parts within it)
 const f1=world();
 run(f1,"DELETE FROM ratings_document WHERE key='letterboxd/facts/links.json';INSERT INTO ratings_document (key,part,body,etag,updated_at) SELECT 'letterboxd/facts/links.json',0,"+big+",'e',"+q(U));
 const a=await preflight(envOf(f1),{scope:SCOPE});
 assert.deepEqual([a.decision,a.reason,a.coverage,a.candidateDigest],['unknown','document_over_cap','incomplete',null],'an oversized link part is not materialized '+(a.detail||''));
 // too many link parts
 const f2=world();
 run(f2,"DELETE FROM ratings_document WHERE key='letterboxd/facts/links.json';WITH RECURSIVE s(p) AS (SELECT 0 UNION ALL SELECT p+1 FROM s WHERE p<"+LINK_DOCUMENT_MAX_PARTS+") INSERT INTO ratings_document (key,part,body,etag,updated_at) SELECT 'letterboxd/facts/links.json',p,'{}','e',"+q(U)+" FROM s");
 assert.equal((await preflight(envOf(f2),{scope:SCOPE})).reason,'document_over_cap');
 // an oversized fact RECORD part and too many record parts
 const f3=world();
 run(f3,"DELETE FROM ratings_document WHERE key='letterboxd/facts/films/tmdb-1.json';INSERT INTO ratings_document (key,part,body,etag,updated_at) SELECT 'letterboxd/facts/films/tmdb-1.json',0,replace(hex(zeroblob("+(FACT_RECORD_MAX_BYTES+10)+")),'00','a'),'e',"+q(U));
 assert.equal((await preflight(envOf(f3),{scope:SCOPE})).reason,'document_over_cap');
 // a link document that is replaced by an oversized one AFTER the first capture is caught by the second capture, which never materializes it.
 const f4=world();
 const late=await preflight(envOf(f4),{scope:SCOPE,hooks:{afterClassify:()=>run(f4,"DELETE FROM ratings_document WHERE key='letterboxd/facts/links.json';INSERT INTO ratings_document (key,part,body,etag,updated_at) SELECT 'letterboxd/facts/links.json',0,"+big+",'e',"+q(U))}});
 assert.deepEqual([late.decision,late.reason,late.candidateDigest],['unknown','document_over_cap',null]);
 // a malformed document (mixed etags) is not assembled
 const f5=world();
 run(f5,"INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('letterboxd/facts/links.json',1,'{}','other',"+q(U)+")");
 assert.equal((await preflight(envOf(f5),{scope:SCOPE})).reason,'document_malformed');
}

// ---- 8. the duplicate-target guard, as in deriveBackfillCohort (pure) ----
{
 const kept=guardDuplicates([
  {lid:'X1',movie:'1',filmId:'film:a',state:'eligible_in_scope'},{lid:'X2',movie:'2',filmId:'film:a',state:'eligible_in_scope'},
  {lid:'X3',movie:'3',filmId:'film:b',state:'eligible_in_scope'},{lid:'X4',movie:'3',filmId:'film:c',state:'eligible_in_scope'},
  {lid:'X5',movie:'5',filmId:'film:d',state:'eligible_in_scope'},
 ]);
 assert.deepEqual(kept.map(item=>item.state),['unknown','unknown','unknown','unknown','eligible_in_scope']);
 assert.equal(kept[0].reason,'cohort_duplicate_target');
}

// ---- 9. an empty cohort is certified only when the authority and the read-set hold ----
{
 const empty=bulk({candidates:false});
 const ok=await preflight(envOf(empty),{scope:SCOPE});
 assert.deepEqual([ok.decision,ok.counts],['complete',{}]);
 assert.match(ok.readSetDigest,/^[0-9a-f]{64}$/);
 // the marker moves between the discoveries: not certified
 const moved=await preflight(envOf(empty),{scope:SCOPE,hooks:{afterFirstCapture:()=>run(empty,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1")}});
 assert.deepEqual([moved.decision,moved.reason,moved.candidateDigest],['unknown','read_set_moved',null]);
 // a candidate appears between the discoveries: not certified
 const appears=bulk({candidates:false});
 const late=await preflight(envOf(appears),{scope:SCOPE,hooks:{afterDiscovery:()=>pointer(appears,'NEWLID',2)}});
 assert.deepEqual([late.decision,late.reason],['unknown','read_set_moved']);
 // authority below open (a held marker, a ratings domain that is not d1): never a certified empty cohort
 for(const stage of ['held','ratings_not_d1']){
  const f=database(stage);
  const out=await preflight(envOf(f),{scope:SCOPE});
  assert.deepEqual([out.decision,out.candidateDigest],['unknown',null],stage+' is never a certified empty cohort: '+out.reason);
 }
}

// ---- 10. WHY the AIR-559 backfill cohort cannot contain a key outside the current published run (a proven mechanism; the historical per-key cause stays unknown) ----
{
 const scoped=world();
 seedFilm(scoped,900,{extra:[['letterboxd','HELD900',1,0]]});seedRatings(scoped,'HELD900',900);
 publish(scoped,['HELD900']);
 const absent=await deriveBackfillCohort(envOf(scoped));
 assert.deepEqual([absent.decision,absent.counts.cohort,absent.blockers],['already_current',0,[]],'keys outside the published run are invisible to the backfill cohort, whatever their verdict');
 const control=world();
 publish(control,['BR01']);
 const seen=await deriveBackfillCohort(envOf(control));
 assert.deepEqual([seen.decision,seen.counts.cohort,seen.counts.pass],['eligible',1,1],'the same lid inside the published run is a candidate');
 assert.equal(rows(control,"SELECT COUNT(*) AS n FROM film_external_id WHERE scheme='letterboxd' AND trusted=1")[0].n,0,'the dry run wrote no claim');
}

// ---- 11. infrastructure states are `unknown`, never a verdict ----
{
 const held=database('held');
 seedFilm(held,1);seedRatings(held,'BR01',1);pointer(held,'BR01',3.5);
 const a=await preflight(envOf(held),{scope:SCOPE});
 assert.deepEqual(stateOf(a,'BR01'),{state:'unknown',reason:'film_person_not_open'});
 const notD1=database('ratings_not_d1');
 seedFilm(notD1,1);seedRatings(notD1,'BR01',1);pointer(notD1,'BR01',3.5);
 const b=await preflight(envOf(notD1),{scope:SCOPE});
 assert.equal(b.counts?.eligible_in_scope??0,0);
 assert.deepEqual(stateOf(b,'BR01'),{state:'unknown',reason:'ratings_not_authoritative'});
}

// ---- 12. static boundary: no apply path, producer or MCP tool is imported or called ----
{
 const text=fs.readFileSync(new URL(import.meta.url),'utf8');
 const own=text.split('\n').filter(line=>!line.trim().startsWith('//')&&!line.includes('const forbidden')).join('\n');
 const forbidden=['applyLetterboxdClaim','ensureLetterboxdClaims','handleLetterboxdClaimBackfillTool','mutateFilm'];
 for(const name of forbidden)assert.ok(!own.includes(name),'no '+name);
}
console.log('prediction alias bridge cohort (AIR-652): ok');
