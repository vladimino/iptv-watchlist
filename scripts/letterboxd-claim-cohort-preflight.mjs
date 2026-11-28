// AIR-653 (ADR 0184, AIR-652): the bounded cohort capture and its offline oracle for the historical bridge-only prediction keys. Extracted unchanged in behaviour from the AIR-652 fixture
// (tests/prediction-alias-bridge-cohort.mjs) so the SAME code can run against a read-only D1 binding. It only ever issues SELECT statements through the AIR-647 counted database, charged to
// ONE shared budget before each statement; the unchanged claim planner runs only on a private sqlite snapshot of the captured rows and never against the database it reads. It writes nothing
// to the database it reads, authorizes nothing and starts nothing. Output carries counts, reasons and digests; the private lid-to-movie result is the caller's to keep outside GitHub and Trello.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';
import {planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {findDuplicateTargets,cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {countedDatabase,LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES,LINK_INDEX_MAX_ENTRIES,FACT_RECORD_MAX_PARTS,FACT_RECORD_MAX_BYTES} from '../src/film-aggregate.js';
import {createStatementBudget} from '../src/film-aggregate-resolver.js';

const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);};
const sqliteRows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const digestOf=value=>sha(JSON.stringify(value));
const chunks=(list,size)=>{const out=[];for(let at=0;at<list.length;at+=size)out.push(list.slice(at,at+size));return out;};
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const U='2026-11-01T00:00:00.000Z';
// A private workspace, created on first use: the migration chain's schema is the template of every snapshot (the evaluator needs the real tables and none of the triggers).
let space=null,counter=0;
function workspace(){
 if(space)return space;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cohort-'));
 process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
 const template=path.join(root,'template.sqlite');
 sqlite(template,'PRAGMA foreign_keys=ON;\n'+fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 space={root,template,triggers:sqliteRows(template,"SELECT name FROM sqlite_master WHERE type='trigger'").map(row=>row.name)};
 return space;
}

// ======================= the preflight design =======================
const HEX64=/^[0-9a-f]{64}$/;
export const WITNESS_INVARIANT='diary_first_lb_record_with_inferred_import_admission';
// The planner's documented limit: a pair linked by the inferred import before AIR-559 on a record that already held facts (in practice a Diary-first `lb-<lid>` record) carries neither durable mark. The one pair DETECTED by the AIR-559
// audit was marked on 24 Nov 2026 and the planner now refuses it; whether another exists is unknown. The witness is the admission row of the inferred-import archive for the same lid and movie. A scope is VALID only when it names the
// invariant and a non-empty set of well-formed archive digests; anything else is missing evidence, not absence of the pair.
// Two valid shapes, never both: a NAMED scope (the invariant and a non-empty set of well-formed archive digests) or the explicit conservative ALL-ARCHIVES scope (the invariant and `allArchives: true`, no archive list).
const namedScope=scope=>!!scope&&scope.invariant===WITNESS_INVARIANT&&scope.allArchives===undefined&&Array.isArray(scope.archives)&&scope.archives.length>0&&scope.archives.every(item=>typeof item==='string'&&HEX64.test(item));
const allArchivesScope=scope=>!!scope&&scope.invariant===WITNESS_INVARIANT&&scope.allArchives===true&&scope.archives===undefined;
const scopeValid=scope=>namedScope(scope)||allArchivesScope(scope);
// The scope as it is bound into the proof: a changed scope is a different token.
export const scopeDescriptor=scope=>namedScope(scope)?{mode:'named',archives:[...scope.archives].sort()}:allArchivesScope(scope)?{mode:'all_archives'}:null;
const NEGATIVE_NOT_PROVED=new Set(['ratings_link_inferred','ratings_link_unverified']);
export const DEFAULT_CAPS={pointerPage:50,pointerInspect:2000,candidates:64,statements:300,rows:6000,chunk:10,list:64};
// Predicates that CANNOT yet be captured within a bound. They are reported with every answer and make a live run a blocker, not a risk to accept.
// The two indexes the bounded reads rely on are VERIFIED from sqlite_master before any other read (one counted statement); a missing one stops the run as `required_index_missing` and is listed
// as a live blocker of THAT run. They are no longer printed as blockers on a target where they exist.
export const REQUIRED_INDEXES=Object.freeze({
 ratings_view_fact_key:'ratings_view_fact_key (migration 0055): the planner and the capture read the projection by fact_key; without the index that predicate is a scan whose size is not capped (AIR-627 saw such a predicate time out).',
 tmdb_retirement_decision_movie:'tmdb_retirement_decision_movie (migration 0040): the ledger is read by movie_id; a superseding decision is assumed to name the same movie id, as the resolver does (supersedes_seq has no index).',
});
// Limits that remain on every run: they are not blockers of a bounded capture, and a complete capture is not an eligibility proof.
export const LIMITATIONS=Object.freeze([
 'planner_unbounded_on_live: the unchanged planner re-reads the link index and records for every key and has no caps; it is evaluated only on a private snapshot, never against production.',
 'witness_is_current_state: a negative witness is the absence of an admission row now; a deleted admission row or an inferred link that never had one is not seen.',
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
export const BOUNDED_DOCUMENTS_SQL='WITH g AS (SELECT key,COUNT(*) AS parts,COALESCE(SUM(length(CAST(body AS BLOB))),0) AS bytes,COUNT(DISTINCT etag) AS etags,MIN(etag) AS etag FROM ratings_document WHERE key IN (SELECT value FROM json_each(?)) GROUP BY key) '
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
export function materialize(a,b){
 const {root,template,triggers:TRIGGERS}=workspace();
 const file=path.join(root,'snap-'+(counter++)+'.sqlite');
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
 if(allArchivesScope(scope)){
  // Conservative: the witness set is every admission of the movie across all Films and archives. The same pair blocks; an admission of the movie under ANOTHER lid is never ignored, it stays unknown.
  if(witness.some(row=>String(row.tmdb)===movie&&row.source_code===lid))return {state:'ineligible',reason:'inferred_admission_witness'};
  if(witness.some(row=>String(row.tmdb)===movie))return {state:'unknown',reason:'witness_movie_admitted_other_lid'};
  return {state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_all_archives'};
 }
 const positive=witness.some(row=>String(row.tmdb)===movie&&row.source_code===lid&&scope.archives.includes(row.archive_sha256));
 return positive?{state:'ineligible',reason:'inferred_admission_witness'}:{state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_in_scope'};
}
// Pure: the duplicate-target guard of `deriveBackfillCohort`: two candidates on one Film or one movie cannot both be written, so they are refused here, not silently kept.
export function guardDuplicates(results){
 const resolved=results.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie,filmId:item.filmId}));
 const dup=new Set(findDuplicateTargets(resolved).map(item=>item.lid));
 return results.map(item=>dup.has(item.lid)?{...item,state:'unknown',reason:'cohort_duplicate_target'}:item);
}
// Multiplicity by RESOLVED CANONICAL OWNERSHIP, over the captured rows only: the owner is the one Film that holds the movie as its unique trusted claim AND exists, is no redirect source, is not retired and holds no untrusted or conflicting
// tmdb/letterboxd claim. Anything else is an UNRESOLVED OWNER (a weaker metric, named as such). Keys and distinct Films are counted separately.
export function multiplicity(subjects,raw){
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
const unknown=(reason,extra={})=>({decision:'unknown',reason,candidateDigest:null,readSetDigest:null,results:[],liveBlockers:[],limitations:LIMITATIONS,...extra});
// hooks (tests only): a concurrent writer injected at a precise point. `afterDiscovery`, `afterFirstCapture` (empty cohort), `afterIndex` (between the index and the rest of the capture), `afterClassify` (between the two passes).
export async function preflight(env,{scope=null,caps={},hooks={}}={}){
 const c={...DEFAULT_CAPS,...caps},budget=newBudget(c),cdb=countedDatabase(env.DB,budget.statements),work={pointerRows:0};
 const report=body=>({...body,work:{statements:budget.statements.used,rowsReserved:budget.rows,pointerRows:work.pointerRows}});
 const hook=async name=>{if(hooks[name])await hooks[name]();};
 try{
  const present=await readRows(cdb,budget,'index_predicates',"SELECT name FROM sqlite_master WHERE type='index' AND name IN ('ratings_view_fact_key','tmdb_retirement_decision_movie') LIMIT ?",[],Object.keys(REQUIRED_INDEXES).length);
  const missing=Object.keys(REQUIRED_INDEXES).filter(name=>!present.some(row=>row.name===name));
  if(missing.length)return report(unknown('required_index_missing',{missing,liveBlockers:missing.map(name=>REQUIRED_INDEXES[name])}));
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
   return report({decision:'complete',reason:null,counts:{},sources:{direct_excluded:found.direct,bridge_resolved:0,bridge_unresolved:0},results:[],candidateDigest:await cohortDigest([]),readSetDigest:tokenOf({markers:a1.markers},{lids:[],scope:scopeDescriptor(scope)}).token,liveBlockers:[],limitations:LIMITATIONS});
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
  const one=tokenOf(sectionsOne,{lids:first.subjects.map(item=>item.lid),scope:scopeDescriptor(scope)}),two=tokenOf(sections(second.a,second.b),{lids:second.subjects.map(item=>item.lid),scope:scopeDescriptor(scope)});
  const moved=Object.keys(one.digests).filter(name=>one.digests[name]!==two.digests[name]);
  if(again.candidates.join('\n')!==found.candidates.join('\n'))moved.push('candidate_set');
  if(moved.length)return report(unknown('read_set_moved',{moved}));
  const guarded=guardDuplicates(results);
  const counts={};for(const item of guarded)counts[item.state]=(counts[item.state]||0)+1;
  const sources={direct_excluded:found.direct,bridge_resolved:guarded.filter(item=>item.source==='bridge_resolved').length,bridge_unresolved:guarded.filter(item=>item.source==='bridge_unresolved').length};
  const eligible=guarded.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie}));
  return report({decision:'complete',reason:null,counts,sources,results:guarded,multiplicity:multiplicity(first.subjects.filter(item=>item.source==='bridge_resolved'),first.b),readSetDigest:one.token,sectionDigests:one.digests,scope:scopeDescriptor(scope),candidateDigest:await cohortDigest(eligible),liveBlockers:[],limitations:LIMITATIONS,snapshot:first});
 }catch(error){
  if(error instanceof Incomplete)return report(unknown(error.reason,{coverage:'incomplete'}));
  return report(unknown(error?.code||'read_set_unreadable',{coverage:'unreadable',detail:String(error?.message||error).slice(0,200)}));
 }
}

