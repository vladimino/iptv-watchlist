// AIR-652 (ADR 0216 delivery step 7; ADR 0184 Accepted, unchanged): the OFFLINE, executable design of the preflight for the historical "bridge-only" prediction keys of the AIR-627 census, on the sqlite3-CLI D1 stand-in over the full
// migration chain. SYNTHETIC ids only (no owner-private profile, no production id list, no R2, no network). Nothing here writes to any store except its own throwaway fixture databases, and no apply path, producer or MCP tool is imported.
// The preflight below is test-local on purpose: it is the design AIR-653 would have to re-prove under its own GO, not a maintained module and not a frozen write cohort.
// What it pins:
//  1. Bounded discovery: keyset pages over the pointer primary key that skip the `tmdb_` range, a total inspected-row cap, a candidate cap and a statement cap, all BEFORE any per-key proof. A cap hit is `incomplete`, never a partial answer.
//  2. The classification over the REAL read-only `planLetterboxdClaim` plus an explicit, validated witness scope for the planner's documented limit (inferred pairs without a durable mark). A missing, empty or malformed scope is `unknown`;
//     a positive witness blocks; a negative witness is `eligible_in_scope` (a planner pass plus a negative screen inside a documented scope), NEVER proven production eligibility.
//  3. A read-set token that binds the markers, the exact document etags, the candidate pointers, the competing/absence claim predicates, the ratings projection, the redirect/retirement state and the admission witness. It is recomputed after
//     the classification (and the discovery repeated); a moved or unreadable read-set is `unknown` with no usable digest.
//  4. Multiplicity by resolved canonical ownership (the owner Film's trusted movie claim), never by fixture order; duplicate Film/movie targets are refused as in `deriveBackfillCohort`.
//  5. Why the AIR-559 backfill cohort cannot contain a key outside the current published run (a proven MECHANISM; it does not prove the historical per-key cause).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {deriveBackfillCohort,findDuplicateTargets,cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {readOwned} from '../src/ratings-d1.js';
import {LINK_DOCUMENT_MAX_PARTS,LINK_INDEX_MAX_ENTRIES,FACT_RECORD_MAX_PARTS} from '../src/film-aggregate.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air652-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
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
 sqlite(file,VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;"+BASELINE);
 if(stage==='held')sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");
 sqlite(file,"UPDATE ratings_domain_authority SET mode='"+(stage==='ratings_not_d1'?'r2':'d1')+"',cutover='open' WHERE id=1");
 return file;
}
const FID=k=>'film:tmdb:'+k;
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const putDoc=(file,key,value)=>{const text=JSON.stringify(value);sqlite(file,'DELETE FROM ratings_document WHERE key='+q(key)+';INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('+q(key)+',0,'+q(text)+','+q(sha(text))+','+q(U)+')');};
const getDoc=(file,key)=>{const r=rows(file,'SELECT body FROM ratings_document WHERE key='+q(key));return r.length?JSON.parse(r[0].body):null;};
const seedFilm=(file,k,{identity='tmdb:'+k,extra=[]}={})=>sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ("+q(FID(k))+",2,"+q(identity)+",'Kept Title',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ("+q(FID(k))+",'tmdb',"+q(String(k))+",1,0,NULL);"+extra.map(([s,v,t,c])=>'INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('+q(FID(k))+','+q(s)+','+q(v)+','+t+','+c+',NULL);').join(''));
// The Ratings side of one candidate: link index + fact record (authoritative) and the projection (corroboration only).
const seedRatings=(file,lid,k,{key='tmdb-'+k,lidKey=key,record=undefined,index=true,third=null}={})=>{
 sqlite(file,'INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('+q(lid)+','+q(lidKey)+',NULL,NULL,0,0,'+q(U)+');INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('+q('tmdb_'+k)+','+q(key)+',NULL,NULL,0,0,'+q(U)+');');
 if(!index)return;
 const links=getDoc(file,'letterboxd/facts/links.json')||{};
 links['letterboxd:'+lid]=lidKey;links['tmdb:'+k]=key;if(third)links[third]=lidKey;
 putDoc(file,'letterboxd/facts/links.json',links);
 putDoc(file,'letterboxd/facts/films/'+lidKey+'.json',record??{schemaVersion:1,factKey:lidKey,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
};
const pointer=(file,storageId,rating,sha256='c'.repeat(64))=>sqlite(file,'INSERT OR REPLACE INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES ('+q(storageId)+",3,'h',"+q('f-'+storageId)+",1,1,"+rating+','+q('enrichment/films/'+storageId+'/prediction.json')+','+q(sha256)+','+q(U)+",'{}')");
const publish=(file,lids)=>sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+RUN+"','published',"+q(U)+","+q('0'.repeat(64))+","+q(U)+");"+lids.map((lid,i)=>"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('"+RUN+"','programme',"+i+","+q(lid)+");").join('')+"UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+RUN+"',generation=1,watchlist_generation=1 WHERE id=1;");
const TABLES=['film','film_external_id','film_alias','film_redirect','film_rated_admission','film_retention','film_dimension','film_metadata','canonical_revision','canonical_write_receipt','ratings_view','ratings_document','prediction_pointer','prediction_lineage','tmdb_retirement_decision','started_mark','published_epg_member'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));
const all=async(db,sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results;
const chunks=(list,size)=>{const out=[];for(let at=0;at<list.length;at+=size)out.push(list.slice(at,at+size));return out;};
const marks=list=>list.map(()=>'?').join(',');
const digestOf=value=>sha(JSON.stringify(value));
const orDash=list=>list.length?list:['-'];

// ======================= the preflight design (test-local; read-only; the REAL planner) =======================
const HEX64=/^[0-9a-f]{64}$/;
const WITNESS_INVARIANT='diary_first_lb_record_with_inferred_import_admission';
// The planner's documented limit: a pair linked by the inferred import before AIR-559 on a record that already held facts (in practice a Diary-first `lb-<lid>` record) carries neither durable mark. The one pair DETECTED by the AIR-559
// audit was marked on 24 Nov 2026 and the planner now refuses it; whether another exists is unknown. The witness is the admission row of the inferred-import archive for the same lid and movie. A scope is VALID only when it names the
// invariant and a non-empty set of well-formed archive digests; anything else is missing evidence, not absence of the pair.
const scopeValid=scope=>!!scope&&scope.invariant===WITNESS_INVARIANT&&Array.isArray(scope.archives)&&scope.archives.length>0&&scope.archives.every(item=>typeof item==='string'&&HEX64.test(item));
const NEGATIVE_NOT_PROVED=new Set(['ratings_link_inferred','ratings_link_unverified']);
const DEFAULT_CAPS={pointerPage:50,pointerInspect:2000,candidates:64,statements:400,chunk:20};
// tmdb-spelled storage keys form ONE contiguous range of the pointer primary key ('tmdb_' ... 'tmdb`'), so the two ranges around it are the only rows a lid scan has to read.
// Both bounds are exclusive: the second range starts after every possible 'tmdb_...' key, i.e. at 'tmdb`' and above (U+FFFF sorts after any ASCII byte).
const RANGES=[{lo:'',hi:'tmdb_'},{lo:'tmdb_￿',hi:'￿'}];
class Incomplete extends Error{constructor(reason){super(reason);this.reason=reason;}}

async function discover(db,caps,work){
 const direct=[],candidates=[];
 for(const range of RANGES){
  let cursor=range.lo;
  for(;;){
   const page=await all(db,'SELECT film_id AS id FROM prediction_pointer WHERE film_id>? AND film_id<? ORDER BY film_id LIMIT ?',[cursor,range.hi,caps.pointerPage]);
   work.pointerRows+=page.length;
   if(work.pointerRows>caps.pointerInspect)throw new Incomplete('pointer_inspection_cap');
   if(db.calls.queries-work.start>caps.statements)throw new Incomplete('statement_cap');
   if(!page.length)break;
   const ids=page.map(row=>row.id);
   const claimed=new Set((await all(db,"SELECT value FROM film_external_id WHERE scheme='letterboxd' AND trusted=1 AND conflicting=0 AND value IN ("+marks(ids)+')',ids)).map(row=>row.value));
   for(const id of ids)(claimed.has(id)?direct:candidates).push(id);
   if(candidates.length>caps.candidates)throw new Incomplete('candidate_cap');
   if(page.length<caps.pointerPage)break;
   cursor=ids[ids.length-1];
  }
 }
 return {direct:direct.length,candidates};
}
// The link index under the AIR-647 limits BEFORE the legacy planner (which reads it unbounded and once per key) is called at all.
async function readIndex(env,db){
 const parts=await all(db,'SELECT COUNT(*) AS n FROM ratings_document WHERE key=?',['letterboxd/facts/links.json']);
 if(Number(parts[0].n)>LINK_DOCUMENT_MAX_PARTS)throw new Incomplete('link_document_over_cap');
 const links=await readOwned(env,'letterboxd/facts/links.json');
 if(!links.owned)throw new Incomplete('ratings_not_authoritative');
 const index=links.value;
 if(!index||typeof index!=='object'||Array.isArray(index))throw new Incomplete('ratings_links_unreadable');
 if(Object.keys(index).length>LINK_INDEX_MAX_ENTRIES)throw new Incomplete('link_index_over_cap');
 return index;
}
const resolveMovie=(index,lid)=>{
 const key=index['letterboxd:'+lid];
 if(typeof key!=='string')return {key:null,movie:null,source:'bridge_unresolved',reason:'ratings_link_absent'};
 const movies=Object.keys(index).filter(alias=>alias.startsWith('tmdb:')&&index[alias]===key).map(alias=>alias.slice(5));
 return movies.length===1?{key,movie:movies[0],source:'bridge_resolved'}:{key,movie:null,source:'bridge_unresolved',reason:'ratings_movie_link_missing_or_ambiguous'};
};
// The read-set: exactly the data the verdicts consume, as one token with per-section digests. One bounded statement per section and chunk of candidates.
async function readSet(db,subjects,caps){
 const keys=[...new Set(subjects.map(item=>item.key).filter(Boolean))];
 const sections={markers:null,documents:[],pointers:[],claims:[],views:[],owner:[],witness:[]};
 sections.markers=[
  (await all(db,'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1'))[0],
  (await all(db,'SELECT mode,cutover,generation FROM ratings_domain_authority WHERE id=1'))[0],
  (await all(db,'SELECT mode,generation,writes FROM prediction_domain_authority WHERE id=1'))[0],
 ];
 sections.documents=await all(db,'SELECT key,part,etag FROM ratings_document WHERE key=? ORDER BY part',['letterboxd/facts/links.json']);
 for(const group of chunks(keys,caps.chunk)){
  const names=group.map(key=>'letterboxd/facts/films/'+key+'.json');
  const found=await all(db,'SELECT key,part,etag FROM ratings_document WHERE key IN ('+marks(names)+') ORDER BY key,part',names);
  const perKey={};for(const row of found)perKey[row.key]=(perKey[row.key]||0)+1;
  if(Object.values(perKey).some(count=>count>FACT_RECORD_MAX_PARTS))throw new Incomplete('fact_record_over_cap');
  sections.documents.push(...found);
 }
 for(const group of chunks(subjects,caps.chunk)){
  const l=group.map(item=>item.lid),m=orDash(group.map(item=>item.movie).filter(Boolean)),k=orDash([...new Set(group.map(item=>item.key).filter(Boolean))]);
  const storage=[...l,...m.map(value=>'tmdb_'+value)];
  sections.pointers.push(...await all(db,'SELECT film_id,content_sha256,fingerprint_hash,predicted_rating FROM prediction_pointer WHERE film_id IN ('+marks(storage)+') ORDER BY film_id',storage));
  sections.claims.push(...await all(db,"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE (scheme='letterboxd' AND value IN ("+marks(l)+")) OR (scheme='tmdb' AND value IN ("+marks(m)+')) ORDER BY film_id,scheme,value',[...l,...m]));
  const aliases=[...l,...m.map(value=>'tmdb_'+value)];
  sections.views.push(...await all(db,'SELECT alias_id,fact_key FROM ratings_view WHERE alias_id IN ('+marks(aliases)+') OR fact_key IN ('+marks(k)+') ORDER BY alias_id',[...aliases,...k]));
  sections.owner.push(...await all(db,"SELECT 'redirect' AS kind,from_id AS a,to_film_id AS b FROM film_redirect WHERE from_id IN (SELECT film_id FROM film_external_id WHERE scheme='tmdb' AND value IN ("+marks(m)+")) UNION ALL SELECT 'retire',movie_id,CAST(seq AS TEXT) FROM tmdb_retirement_decision WHERE movie_id IN ("+marks(m)+') ORDER BY 1,2,3',[...m,...m]));
  sections.witness.push(...await all(db,'SELECT film_id,tmdb,source_code,archive_sha256 FROM film_rated_admission WHERE source_code IN ('+marks(l)+') OR tmdb IN ('+marks(m)+') ORDER BY film_id',[...l,...m]));
 }
 const digests=Object.fromEntries(Object.entries(sections).map(([name,value])=>[name,digestOf(value)]));
 return {sections,digests,token:digestOf(digests)};
}
function classifyPlan(plan,{lid,movie},snapshot,scope){
 if(plan.verdict==='conflict')return {state:'ineligible',reason:plan.reason};
 if(plan.verdict==='not_proved')return {state:NEGATIVE_NOT_PROVED.has(plan.reason)?'ineligible':'unknown',reason:plan.reason};
 if(plan.already)return {state:'already',reason:'already_current',filmId:plan.filmId};
 if(!scopeValid(scope))return {state:'unknown',reason:'witness_scope_missing',filmId:plan.filmId};
 // The witness is looked up by lid AND movie across every film (a canonical merge can move the row), inside the snapshot the token binds.
 const positive=snapshot.sections.witness.some(row=>row.source_code===lid&&String(row.tmdb)===movie&&scope.archives.includes(row.archive_sha256));
 return positive?{state:'ineligible',reason:'inferred_admission_witness',filmId:plan.filmId}:{state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_in_scope',filmId:plan.filmId};
}
// Pure: the duplicate-target guard of `deriveBackfillCohort`: two candidates on one Film or one movie cannot both be written, so they are refused here, not silently kept.
function guardDuplicates(results){
 const resolved=results.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie,filmId:item.filmId}));
 const dup=new Set(findDuplicateTargets(resolved).map(item=>item.lid));
 return results.map(item=>dup.has(item.lid)?{...item,state:'unknown',reason:'cohort_duplicate_target'}:item);
}
// Multiplicity by RESOLVED CANONICAL OWNERSHIP: the owner Film is the one that holds the movie as its unique trusted claim; that Film's movie key is the second storage key. The fixture order plays no part.
function multiplicity(results,snapshot){
 const out={bridge_only:0,dual:0,differing:0,unresolved:0};
 const pointerOf=new Map(snapshot.sections.pointers.map(row=>[row.film_id,row]));
 for(const item of results){
  const owners=snapshot.sections.claims.filter(row=>row.scheme==='tmdb'&&row.value===item.movie&&row.trusted===1&&row.conflicting===0);
  if(owners.length!==1){out.unresolved++;continue;}
  const second=pointerOf.get('tmdb_'+item.movie),own=pointerOf.get(item.lid);
  if(!second){out.bridge_only++;continue;}
  out.dual++;if(second.predicted_rating!==own?.predicted_rating)out.differing++;
 }
 return out;
}
const unknown=(reason,extra={})=>({decision:'unknown',reason,candidateDigest:null,readSetDigest:null,results:[],...extra});
async function preflight(env,{scope=null,caps={},between=null}={}){
 const db=env.DB,c={...DEFAULT_CAPS,...caps},work={pointerRows:0,start:db.calls.queries};
 const report=body=>({...body,work:{statements:db.calls.queries-work.start,pointerRows:work.pointerRows}});
 try{
  const found=await discover(db,c,work);
  if(!found.candidates.length)return report({decision:'complete',reason:null,counts:{},sources:{direct_excluded:found.direct,bridge_resolved:0,bridge_unresolved:0},results:[],candidateDigest:await cohortDigest([]),readSetDigest:null});
  const index=await readIndex(env,db);
  const subjects=found.candidates.map(lid=>({lid,...resolveMovie(index,lid)}));
  const before=await readSet(db,subjects,c);
  const results=[];
  for(const item of subjects){
   if(item.source==='bridge_unresolved'){results.push({lid:item.lid,movie:null,source:item.source,state:'unknown',reason:item.reason});continue;}
   let plan;
   try{plan=await planLetterboxdClaim(env,{lid:item.lid,tmdb:item.movie});}
   catch(error){results.push({lid:item.lid,movie:item.movie,source:item.source,state:'unknown',reason:error?.code||'unclassified'});continue;}
   results.push({lid:item.lid,movie:item.movie,source:item.source,...classifyPlan(plan,item,before,scope)});
  }
  if(db.calls.queries-work.start>c.statements)throw new Incomplete('statement_cap');
  if(between)await between();
  // Revalidation: the same read-set again, and the discovery repeated; ANY difference makes the whole answer unknown with no digest.
  const after=await readSet(db,subjects,c);
  const again=await discover(db,c,{pointerRows:0,start:db.calls.queries});
  const moved=Object.keys(before.digests).filter(name=>before.digests[name]!==after.digests[name]);
  if(again.candidates.join('\n')!==found.candidates.join('\n'))moved.push('candidate_set');
  if(moved.length)return report(unknown('read_set_moved',{moved}));
  const guarded=guardDuplicates(results);
  const counts={};for(const item of guarded)counts[item.state]=(counts[item.state]||0)+1;
  const sources={direct_excluded:found.direct,bridge_resolved:guarded.filter(item=>item.source==='bridge_resolved').length,bridge_unresolved:guarded.filter(item=>item.source==='bridge_unresolved').length};
  const eligible=guarded.filter(item=>item.state==='eligible_in_scope').map(item=>({lid:item.lid,tmdb:item.movie}));
  return report({decision:'complete',reason:null,counts,sources,results:guarded,multiplicity:multiplicity(guarded.filter(item=>item.source==='bridge_resolved'),before),readSetDigest:before.token,candidateDigest:await cohortDigest(eligible)});
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
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:redirect-target',2,'tmdb:5000','Target','"+U+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(FID(10))+",'film:redirect-target',"+q(U)+")");
 sqlite(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r1',"+q(FID(11))+",'retire','BR11','11','1',"+q('{}')+","+q(JSON.stringify({by:'owner',at:U,source:'synthetic'}))+",'owner_request','{}',"+q(U)+")");
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',2,NULL,'Other','"+U+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','letterboxd','BR13',0,0,NULL)");
 // The admission row of the inferred-import archive for BR04 (and, as the trace of a repaired pair, BR05).
 for(const lid of ['BR04','BR05']){const k=Object.keys(CASES).indexOf(lid)+1;sqlite(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(k))+","+q(String(k))+","+q(lid)+","+q(INFERRED_ARCHIVE)+",'T',2000,'rk','tmdb_"+k+"','2026-11-01T00:00:00.000Z','rq"+k+"',"+q(U)+")");}
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const stateOf=(out,lid)=>{const item=out.results.find(entry=>entry.lid===lid);return {state:item.state,reason:item.reason};};

// ---- 1. the main cohort: exact states and reasons, accounting, multiplicity by ownership, no write, a usable digest ----
const file=world();
const before=dump(file);
{
 const out=await preflight(envOf(file),{scope:SCOPE});
 assert.deepEqual([out.decision,out.reason],['complete',null]);
 assert.deepEqual(Object.fromEntries(out.results.map(item=>[item.lid,{state:item.state,reason:item.reason}])),CASES);
 assert.deepEqual(out.counts,{eligible_in_scope:3,ineligible:9,unknown:3},'the classes add up to the whole cohort');
 assert.equal(Object.values(out.counts).reduce((a,b)=>a+b,0),15);
 assert.deepEqual(out.sources,{direct_excluded:0,bridge_resolved:13,bridge_unresolved:2},'direct, bridge-resolved and bridge-unresolved are distinguished');
 assert.match(out.candidateDigest,/^[0-9a-f]{64}$/);assert.match(out.readSetDigest,/^[0-9a-f]{64}$/);
 assert.equal(out.candidateDigest,await cohortDigest([{lid:'BR01',tmdb:'1'},{lid:'BR02',tmdb:'2'},{lid:'BR03',tmdb:'3'}]),'a candidate digest, NOT a frozen write cohort: AIR-653 re-proves at write time');
 // By resolved ownership over the 13 bridge-resolved keys: BR15 has no owner Film (unresolved), the others are counted per owner Film.
 assert.deepEqual(out.multiplicity,{bridge_only:4,dual:8,differing:4,unresolved:1});
 assert.equal(dump(file),before,'the preflight writes nothing: 17 tables unchanged');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0);
 // The work is MEASURED on this fixture, not a general guarantee: the legacy planner reads the link index and the claim/view sets unbounded and repeats the index for every key.
 assert.ok(out.work.statements>0&&out.work.statements<400,'statements on this fixture: '+out.work.statements);
 if(process.env.AIR652_REPORT)console.log('15-key fixture work',JSON.stringify(out.work));
 assert.equal((await preflight(envOf(file),{scope:SCOPE})).candidateDigest,out.candidateDigest,'repeatable on an unchanged read-set');
}

// ---- 2. the witness scope: missing / empty / malformed is `unknown`, never eligible; a positive witness blocks ----
{
 for(const scope of [null,{},{invariant:WITNESS_INVARIANT,archives:[]},{invariant:WITNESS_INVARIANT,archives:['not-a-digest']},{invariant:'other',archives:[INFERRED_ARCHIVE]}]){
  const out=await preflight(envOf(file),{scope});
  assert.equal(out.decision,'complete');
  assert.equal(out.counts.eligible_in_scope??0,0,'no key is eligible without a valid witness scope: '+JSON.stringify(scope));
  for(const lid of ['BR01','BR02','BR03','BR04'])assert.deepEqual(stateOf(out,lid),{state:'unknown',reason:'witness_scope_missing'},lid);
 }
 // The planner alone passes the historical-invariant pair; only the witness keeps it out.
 assert.equal((await planLetterboxdClaim(envOf(file),{lid:'BR04',tmdb:'4'})).verdict,'pass');
 // A scope that names a DIFFERENT archive does not see the witness: eligible_in_scope says nothing outside the stated scope.
 const other=await preflight(envOf(file),{scope:{invariant:WITNESS_INVARIANT,archives:['b'.repeat(64)]}});
 assert.equal(stateOf(other,'BR04').state,'eligible_in_scope','the verdict is relative to the stated scope only');
 // The post-repair control: the same shape with `inferredPairs` is refused by the planner itself.
 assert.equal((await planLetterboxdClaim(envOf(file),{lid:'BR05',tmdb:'5'})).reason,'ratings_link_inferred');
}

// ---- 3. a witness that cannot be read, or that moves, is typed unknown with no digest ----
{
 const failing=envOf(file,{onQuery:text=>{if(text.includes('film_rated_admission'))throw Object.assign(new Error('boom'),{code:'witness_unavailable'});}});
 const out=await preflight(failing,{scope:SCOPE});
 assert.deepEqual([out.decision,out.reason,out.coverage,out.candidateDigest,out.readSetDigest],['unknown','witness_unavailable','unreadable',null,null]);
 for(const [name,change] of [
  ['insert',f=>sqlite(f,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(1))+",'1','BR01',"+q(INFERRED_ARCHIVE)+",'T',2000,'rk','tmdb_1','2026-11-01T00:00:00.000Z','rqx',"+q(U)+")")],
  ['delete',f=>sqlite(f,"DELETE FROM film_rated_admission WHERE source_code='BR04'")],
  ['move',f=>sqlite(f,"UPDATE film_rated_admission SET film_id='film:other' WHERE source_code='BR04'")],
 ]){
  const f=world();
  const moved=await preflight(envOf(f),{scope:SCOPE,between:()=>change(f)});
  assert.deepEqual([moved.decision,moved.reason,moved.candidateDigest,moved.readSetDigest],['unknown','read_set_moved',null,null],name);
  assert.ok(moved.moved.includes('witness'),name+' moved the witness section: '+moved.moved);
 }
}

// ---- 4. every other part of the read-set is bound: a movement of any of them is `unknown`, with the section named ----
{
 const movers=[
  ['claims',f=>sqlite(f,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:rival',2,NULL,'Rival',"+q(U)+");INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:rival','letterboxd','BR01',0,0,NULL)")],
  ['views',f=>sqlite(f,"UPDATE ratings_view SET fact_key='tmdb-other' WHERE alias_id='BR02'")],
  ['pointers',f=>sqlite(f,"UPDATE prediction_pointer SET content_sha256="+q('d'.repeat(64))+" WHERE film_id='BR03'")],
  ['documents',f=>putDoc(f,'letterboxd/facts/films/tmdb-1.json',{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'BR01',tmdb:'1'},redirectTo:null,migrating:null,note:'moved'})],
  ['owner',f=>sqlite(f,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(FID(2))+",'film:redirect-target',"+q(U)+")")],
  ['markers',f=>sqlite(f,"UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1")],
  ['markers',f=>sqlite(f,"UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1")],
  ['markers',f=>sqlite(f,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1")],
  ['candidate_set',f=>pointer(f,'NEWLID',2)],
 ];
 for(const [section,change] of movers){
  const f=world();
  const out=await preflight(envOf(f),{scope:SCOPE,between:()=>change(f)});
  assert.deepEqual([out.decision,out.reason,out.candidateDigest,out.readSetDigest],['unknown','read_set_moved',null,null],section+' '+(out.detail||''));
  assert.ok(out.moved.includes(section),'the '+section+' section is named: '+out.moved);
 }
}

// ---- 5. discovery is bounded BEFORE the per-key proof, measured by the work done, and distinguishes direct / bridge-resolved / unresolved / excluded ----
const bulk=({candidates=true}={})=>{
 const f=database();
 const DIRECT=300,TMDB=3000;
 const pointers=(prefix,count,offset,tag)=>"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+count+") INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) SELECT '"+prefix+"'||("+offset+"+n),3,'h','"+tag+"'||n,1,1,3.5,'k',"+q('c'.repeat(64))+","+q(U)+",'{}' FROM s;";
 sqlite(f,"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+DIRECT+") INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) SELECT 'film:lid:'||n,2,NULL,'T',"+q(U)+" FROM s;"
  +"WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM s WHERE n<"+DIRECT+") INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) SELECT 'film:lid:'||n,'letterboxd','D'||n,1,0,NULL FROM s;"
  +pointers('D',DIRECT,0,'f')+pointers('tmdb_',TMDB,100000,'g'));
 if(candidates){
  for(const [lid,k] of [['CA1',201],['CA2',202]]){seedFilm(f,k);seedRatings(f,lid,k);pointer(f,lid,3.5);}
  pointer(f,'CB1',3.5);                                   // no link index entry
  seedRatings(f,'CC1',203);pointer(f,'CC1',3.5);          // link proof, no canonical Film
 }
 return f;
};
{
 const f=bulk();
 const out=await preflight(envOf(f),{scope:SCOPE});
 assert.equal(out.decision,'complete',out.reason+' '+(out.detail||'')+' '+JSON.stringify(out.work));
 assert.deepEqual(out.sources,{direct_excluded:300,bridge_resolved:3,bridge_unresolved:1},'direct keys are excluded; bridge-resolved and unresolved candidates are distinguished');
 assert.deepEqual(out.counts,{eligible_in_scope:2,unknown:2});
 // The work is measured: only the non-tmdb pointers are inspected (304 of 3304), never the whole table.
 assert.equal(out.work.pointerRows,304,'304 pointer rows inspected, the 3000 tmdb-spelled ones are skipped by the key range');
 assert.ok(out.work.statements<250,'statements on this fixture: '+out.work.statements);
 if(process.env.AIR652_REPORT)console.log('bulk fixture work',JSON.stringify(out.work));
 // cap + 1: a cap below the work is `incomplete` with no digest, never a partial answer; exactly at the cap is complete.
 const capped=await preflight(envOf(f),{scope:SCOPE,caps:{pointerInspect:303}});
 assert.deepEqual([capped.decision,capped.reason,capped.coverage,capped.candidateDigest],['unknown','pointer_inspection_cap','incomplete',null]);
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{pointerInspect:304}})).decision,'complete');
 const manyCandidates=await preflight(envOf(f),{scope:SCOPE,caps:{candidates:3}});
 assert.deepEqual([manyCandidates.decision,manyCandidates.reason],['unknown','candidate_cap'],'4 candidates against a cap of 3');
 assert.equal((await preflight(envOf(f),{scope:SCOPE,caps:{candidates:4}})).decision,'complete');
 const statements=await preflight(envOf(f),{scope:SCOPE,caps:{statements:5}});
 assert.deepEqual([statements.decision,statements.reason],['unknown','statement_cap']);
 // no matches: only direct keys, a complete and empty cohort (never an unknown); no tmdb-spelled key is ever inspected.
 const none=await preflight(envOf(bulk({candidates:false})),{scope:SCOPE});
 assert.deepEqual([none.decision,none.counts,none.sources.direct_excluded,none.work.pointerRows],['complete',{},300,300]);
 // The link index over the AIR-647 limit is refused BEFORE the legacy planner is called at all.
 const big=bulk();
 sqlite(big,'DELETE FROM ratings_document WHERE key='+q('letterboxd/facts/links.json')+';'+"WITH RECURSIVE s(p) AS (SELECT 0 UNION ALL SELECT p+1 FROM s WHERE p<"+LINK_DOCUMENT_MAX_PARTS+") INSERT INTO ratings_document (key,part,body,etag,updated_at) SELECT 'letterboxd/facts/links.json',p,'{}','e',"+q(U)+" FROM s");
 const over=await preflight(envOf(big),{scope:SCOPE});
 assert.deepEqual([over.decision,over.reason,over.coverage],['unknown','link_document_over_cap','incomplete']);
}

// ---- 6. the duplicate-target guard, as in deriveBackfillCohort (pure) ----
{
 const kept=guardDuplicates([
  {lid:'X1',movie:'1',filmId:'film:a',state:'eligible_in_scope'},{lid:'X2',movie:'2',filmId:'film:a',state:'eligible_in_scope'},
  {lid:'X3',movie:'3',filmId:'film:b',state:'eligible_in_scope'},{lid:'X4',movie:'3',filmId:'film:c',state:'eligible_in_scope'},
  {lid:'X5',movie:'5',filmId:'film:d',state:'eligible_in_scope'},
 ]);
 assert.deepEqual(kept.map(item=>item.state),['unknown','unknown','unknown','unknown','eligible_in_scope']);
 assert.equal(kept[0].reason,'cohort_duplicate_target');
}

// ---- 7. WHY the AIR-559 backfill cohort cannot contain a key outside the current published run (a proven mechanism; the historical per-key cause stays unknown) ----
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

// ---- 8. infrastructure states are `unknown`, never a verdict ----
{
 const held=database('held');
 seedFilm(held,1);seedRatings(held,'BR01',1);pointer(held,'BR01',3.5);
 const a=await preflight(envOf(held),{scope:SCOPE});
 assert.deepEqual(stateOf(a,'BR01'),{state:'unknown',reason:'film_person_not_open'});
 const notD1=database('ratings_not_d1');
 seedFilm(notD1,1);seedRatings(notD1,'BR01',1);pointer(notD1,'BR01',3.5);
 const b=await preflight(envOf(notD1),{scope:SCOPE});
 assert.equal(b.decision,'unknown');assert.match(b.reason,/ratings_(domain_not_authoritative|not_authoritative|domain_unavailable)/);assert.equal(b.candidateDigest,null);
}

// ---- 9. static boundary: no apply path, producer or MCP tool is imported or called ----
{
 const text=fs.readFileSync(new URL(import.meta.url),'utf8');
 const own=text.split('\n').filter(line=>!line.trim().startsWith('//')&&!line.includes('const forbidden')).join('\n');
 const forbidden=['applyLetterboxdClaim','ensureLetterboxdClaims','handleLetterboxdClaimBackfillTool','mutateFilm'];
 for(const name of forbidden)assert.ok(!own.includes(name),'no '+name);
}
console.log('prediction alias bridge cohort (AIR-652): ok');
