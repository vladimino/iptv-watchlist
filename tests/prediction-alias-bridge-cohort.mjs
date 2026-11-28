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
import {deriveBackfillCohort,cohortDigest} from '../src/letterboxd-claim-backfill.js';
import {LINK_DOCUMENT_MAX_PARTS,LINK_DOCUMENT_MAX_BYTES,FACT_RECORD_MAX_BYTES} from '../src/film-aggregate.js';

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

// The preflight (bounded capture, offline oracle, classification) lives in scripts/letterboxd-claim-cohort-preflight.mjs, so the same code can run against a read-only D1 binding (AIR-653).
import {preflight,materialize,guardDuplicates,multiplicity,WITNESS_INVARIANT,DEFAULT_CAPS,LIMITATIONS,REQUIRED_INDEXES,BOUNDED_DOCUMENTS_SQL} from '../scripts/letterboxd-claim-cohort-preflight.mjs';

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
 assert.deepEqual(out.liveBlockers,[],'both indexes are verified present, so no index is listed as a blocker');
 assert.deepEqual(out.limitations,LIMITATIONS,'the unbounded planner and the current-state witness stay listed as limitations');
 assert.equal((await preflight(envOf(file),{scope:SCOPE})).candidateDigest,out.candidateDigest,'repeatable on an unchanged read-set');
 // The report counts BOTH passes and the repeated discovery against ONE budget.
 assert.ok(out.work.statements>0&&out.work.statements<=DEFAULT_CAPS.statements&&out.work.rowsReserved<=DEFAULT_CAPS.rows);
 if(process.env.AIR652_REPORT)console.log('15-key fixture work',JSON.stringify(out.work));
}

// ---- 1b. AIR-653: the witness scope (named, explicit all-archives, missing or invalid) and the verified index predicates ----
{
 const ALL={invariant:WITNESS_INVARIANT,allArchives:true};
 const ELIGIBLE_ALL={state:'eligible_in_scope',reason:'planner_pass_and_negative_witness_all_archives'};
 const named=await preflight(envOf(file),{scope:SCOPE}),all=await preflight(envOf(file),{scope:ALL});
 assert.deepEqual([all.decision,all.reason],['complete',null]);
 // The same classes as the named scope on this fixture: the admission row of BR04 and BR05 (same archive) blocks BR04; the planner refuses BR05 itself; the three eligible keys stay eligible.
 assert.deepEqual(Object.fromEntries(all.results.map(item=>[item.lid,{state:item.state,reason:item.reason}])),Object.fromEntries(Object.entries(CASES).map(([lid,value])=>[lid,value===ELIGIBLE?ELIGIBLE_ALL:value])));
 assert.deepEqual([all.scope,named.scope],[{mode:'all_archives'},{mode:'named',archives:[INFERRED_ARCHIVE]}],'the scope is reported');
 assert.notEqual(all.readSetDigest,named.readSetDigest,'the scope is bound into the proof: a different scope is a different token');
 assert.equal(all.readSetDigest,(await preflight(envOf(file),{scope:ALL})).readSetDigest,'repeatable under the same scope');
 // A positive witness outside a NAMED scope is invisible to it (the verdict is relative to the stated scope) and blocks in the all-archives mode.
 const other=world();run(other,"UPDATE film_rated_admission SET archive_sha256="+q('b'.repeat(64))+" WHERE source_code='BR04'");
 assert.deepEqual(stateOf(await preflight(envOf(other),{scope:SCOPE}),'BR04'),ELIGIBLE,'a named scope does not see an admission of another archive');
 assert.deepEqual(stateOf(await preflight(envOf(other),{scope:ALL}),'BR04'),{state:'ineligible',reason:'inferred_admission_witness'},'the all-archives mode never ignores a positive witness');
 // An admission of the movie under ANOTHER lid is never ignored in the all-archives mode.
 const otherLid=world();run(otherLid,"UPDATE film_rated_admission SET source_code='OTHERLID' WHERE source_code='BR04'");
 assert.deepEqual(stateOf(await preflight(envOf(otherLid),{scope:ALL}),'BR04'),{state:'unknown',reason:'witness_movie_admitted_other_lid'});
 // A missing or invalid scope proves nothing: every planner pass is unknown, nothing is eligible, the candidate digest is the empty cohort.
 for(const [name,bad] of [['no scope',null],['empty object',{}],['allArchives false',{invariant:WITNESS_INVARIANT,allArchives:false}],['both shapes at once',{invariant:WITNESS_INVARIANT,allArchives:true,archives:[INFERRED_ARCHIVE]}],['empty archive list',{invariant:WITNESS_INVARIANT,archives:[]}],['a malformed digest',{invariant:WITNESS_INVARIANT,archives:['nothex']}],['another invariant',{invariant:'other',allArchives:true}]]){
  const out=await preflight(envOf(file),{scope:bad});
  assert.equal(out.decision,'complete',name);
  assert.deepEqual([out.counts.eligible_in_scope||0,out.results.filter(item=>item.reason==='witness_scope_missing').length],[0,4],name+': the four planner passes (BR01-BR04) are unknown, not eligible');
  assert.equal(out.candidateDigest,await cohortDigest([]),name);assert.equal(out.scope,null,name);
 }
 // Movement: an admission row inserted between the two passes is `read_set_moved` under the all-archives scope too.
 const moving=world();
 const moved=await preflight(envOf(moving),{scope:ALL,hooks:{afterClassify:async()=>run(moving,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(1))+",'1','BR01',"+q('c'.repeat(64))+",'T',2000,'rk','tmdb_1','2026-11-01T00:00:00.000Z','rq1',"+q(U)+")")}});
 assert.deepEqual([moved.decision,moved.reason,moved.candidateDigest],['unknown','read_set_moved',null]);assert.ok(moved.moved.includes('witness'));
 // The two indexes are verified before any other read: a missing one stops the run, names itself as the blocker and nothing but the predicate check ran.
 for(const name of ['ratings_view_fact_key','tmdb_retirement_decision_movie']){
  const f=world();run(f,'DROP INDEX '+name);
  const out=await preflight(envOf(f),{scope:SCOPE});
  assert.deepEqual([out.decision,out.reason,out.missing,out.work.statements,out.candidateDigest],['unknown','required_index_missing',[name],1,null],name);
  assert.deepEqual(out.liveBlockers,[REQUIRED_INDEXES[name]],name+': the missing index is the blocker of THIS run');
 }
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
 assert.deepEqual(out.liveBlockers,[],'with 0055 and 0040 present nothing is a live blocker; the limitations stay');
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
