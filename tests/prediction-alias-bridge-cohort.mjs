// AIR-652 (ADR 0216 delivery step 7; ADR 0184 Accepted, unchanged): the OFFLINE preflight of the historical "bridge-only" prediction keys found by the AIR-627 census, on the sqlite3-CLI D1 stand-in over the full
// migration chain. SYNTHETIC ids only (no owner-private profile, no production id list, no R2, no network). It writes nothing to any store except its own throwaway fixture databases, and it never calls an apply path.
// What it pins:
//  1. WHY the AIR-559 backfill saw a zero cohort: `deriveBackfillCohort` is scoped to the lids of the current published programme run (`published_epg_member`). A prediction key that sits only under a lid outside that run is never a
//     candidate, whatever the ADR 0184 verdict would be. The control inserts one such lid into the run and it becomes a candidate at once.
//  2. The bounded discovery of the bridge-only keys (from `prediction_pointer`, indexed claim anti-join) and its EXPLAIN plan: no full scan of `film_external_id`.
//  3. The per-key classification (eligible / ineligible / unknown / already) over the REAL read-only `planLetterboxdClaim`, with exact reasons, cohort accounting (total = sum of the classes) and a bounded read cost per key.
//  4. The planner's documented LIMIT (a legacy unmarked inferred pair passes the planner): the preflight adds the admission witness screen of the AIR-559 legacy-pair audit, so a planner `pass` is NOT yet `eligible`.
//  5. Infrastructure states (a held Film/Person marker, a non-authoritative ratings domain) are `unknown`, never a verdict; a missing proof is never promoted; nothing is written by classification.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {planLetterboxdClaim} from '../src/canonical-letterboxd-claim.js';
import {deriveBackfillCohort} from '../src/letterboxd-claim-backfill.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air652-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
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
const envOf=(file,options)=>({DB:d1Standin(file,options)});
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
// prediction_pointer rows: storage key `lid` (bridge) and optionally the movie key `tmdb_<k>` (dual), with a value that may differ.
const pointer=(file,storageId,rating)=>sqlite(file,'INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES ('+q(storageId)+",3,'h',"+q('f-'+storageId)+",1,1,"+rating+','+q('enrichment/films/'+storageId+'/prediction.json')+','+q('c'.repeat(64))+','+q(U)+",'{}')");
const publish=(file,lids)=>sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+RUN+"','published',"+q(U)+","+q('0'.repeat(64))+","+q(U)+");"+lids.map((lid,i)=>"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('"+RUN+"','programme',"+i+","+q(lid)+");").join('')+"UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='"+RUN+"',generation=1,watchlist_generation=1 WHERE id=1;");
const TABLES=['film','film_external_id','film_alias','film_redirect','film_rated_admission','film_retention','film_dimension','film_metadata','canonical_revision','canonical_write_receipt','ratings_view','ratings_document','prediction_pointer','prediction_lineage','tmdb_retirement_decision','started_mark','published_epg_member'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));

// ---- the preflight classifier under test (offline; read-only; the REAL planner) ----
// The planner's own limit (src/canonical-letterboxd-claim.js, "LIMIT"): a pair linked by the inferred import BEFORE AIR-559 on a record that already held facts carries neither durable mark and the planner answers `pass`.
// The AIR-559 legacy-pair audit detects it from the D1 admission row (an `inferred`-import archive) instead. `inferredArchives` is supplied by the operator of a private preflight, never hard-coded here.
const INFERRED_ARCHIVE='a'.repeat(64);
const SCREEN_SQL='SELECT 1 AS hit FROM film_rated_admission WHERE film_id=? AND source_code=? AND tmdb=? AND archive_sha256 IN (SELECT value FROM json_each(?)) LIMIT 1';
const NEGATIVE_NOT_PROVED=new Set(['ratings_link_inferred','ratings_link_unverified']);
async function classify(env,db,{lid,tmdb},{inferredArchives=[INFERRED_ARCHIVE]}={}){
 let plan;
 try{plan=await planLetterboxdClaim(env,{lid,tmdb});}
 catch(error){return {state:'unknown',reason:error?.code||'unclassified'};}
 if(plan.verdict==='conflict')return {state:'ineligible',reason:plan.reason};
 if(plan.verdict==='not_proved')return {state:NEGATIVE_NOT_PROVED.has(plan.reason)?'ineligible':'unknown',reason:plan.reason};
 if(plan.already)return {state:'already',reason:'already_current'};
 const witness=await db.prepare(SCREEN_SQL).bind(plan.filmId,lid,tmdb,JSON.stringify(inferredArchives)).first();
 return witness?{state:'unknown',reason:'legacy_inferred_pair_suspected'}:{state:'eligible',reason:'proved'};
}
// The bounded discovery of the bridge-only keys: a pointer key that is not tmdb-spelled and holds no trusted letterboxd claim. The movie id comes from the AUTHORITATIVE link index, as in the AIR-559 backfill.
const DISCOVERY_SQL="SELECT p.film_id AS lid FROM prediction_pointer p WHERE p.film_id NOT LIKE 'tmdb\\_%' ESCAPE '\\' AND NOT EXISTS (SELECT 1 FROM film_external_id e WHERE e.scheme='letterboxd' AND e.value=p.film_id AND e.trusted=1 AND e.conflicting=0) ORDER BY p.film_id LIMIT ?";
const CAP=64;
async function discover(file){
 const links=getDoc(file,'letterboxd/facts/links.json')||{};
 const lids=rows(file,DISCOVERY_SQL.replace('?',String(CAP+1))).map(row=>row.lid);
 assert.ok(lids.length<=CAP,'the discovery is bounded');
 return lids.map(lid=>{const key=links['letterboxd:'+lid];const movies=typeof key==='string'?Object.keys(links).filter(alias=>alias.startsWith('tmdb:')&&links[alias]===key).map(alias=>alias.slice(5)):[];return {lid,tmdb:movies.length===1?movies[0]:null,movies:movies.length};});
}

// ---- the synthetic cohort: 15 keys in the shape of the AIR-627 finding (4 bridge-only Films, 11 Films with a second pointer, 5 of those with a different value) ----
// BR01..BR04 have no `tmdb_<n>` pointer (bridge-only). BR05..BR15 also carry a `tmdb_<n>` pointer; for BR05..BR09 its value differs from the bridge key's.
const CASES={
 BR01:{state:'eligible',reason:'proved'},
 BR02:{state:'eligible',reason:'proved'},                                  // canonical_identity NULL is allowed (ADR 0184 2c)
 BR03:{state:'eligible',reason:'proved'},
 BR04:{state:'unknown',reason:'legacy_inferred_pair_suspected'},           // the planner says pass; the admission witness says inferred
 BR05:{state:'ineligible',reason:'ratings_link_inferred'},                 // record.identity marks it
 BR06:{state:'ineligible',reason:'ratings_link_inferred'},                 // inferredPairs names the pair
 BR07:{state:'unknown',reason:'ratings_movie_link_missing_or_ambiguous'},  // the lid's fact key is shared with no movie alias: the movie id cannot be derived from the authoritative index (the planner's points_elsewhere is unreachable from this discovery)
 BR08:{state:'ineligible',reason:'ratings_link_ambiguous'},                // a third alias on the key
 BR09:{state:'ineligible',reason:'ratings_record_not_settled'},            // mid-migration
 BR10:{state:'ineligible',reason:'film_redirected'},
 BR11:{state:'ineligible',reason:'tmdb_retired'},
 BR12:{state:'ineligible',reason:'canonical_identity_mismatch'},
 BR13:{state:'ineligible',reason:'lid_claimed_elsewhere'},                 // an UNTRUSTED claim of the lid elsewhere (a trusted one would exclude it from the discovery: a direct-claim key)
 BR14:{state:'unknown',reason:'ratings_movie_link_missing_or_ambiguous'},  // pointer exists, the authoritative link index does not name the lid: missing proof
 BR15:{state:'unknown',reason:'film_absent'},                              // link proof exists, no canonical Film owns the movie
};
const DUAL=new Set(['BR05','BR06','BR07','BR08','BR09','BR10','BR11','BR12','BR13','BR14','BR15']);
const DIFFERING=new Set(['BR05','BR06','BR07','BR08','BR09']);
function world(){
 const file=database();
 const ids=Object.keys(CASES);
 ids.forEach((lid,i)=>{
  const k=i+1,tmdb=String(k);
  const withFilm=lid!=='BR15';
  if(withFilm)seedFilm(file,k,lid==='BR02'?{identity:null}:lid==='BR12'?{identity:'tmdb:9999'}:{});
  const ratings={};
  if(lid==='BR05')ratings.record={schemaVersion:1,factKey:'tmdb-'+k,links:{letterboxd:lid,tmdb:tmdb},redirectTo:null,migrating:null,identity:{kind:'inferred'}};
  if(lid==='BR06')ratings.record={schemaVersion:1,factKey:'tmdb-'+k,links:{letterboxd:lid,tmdb:tmdb},redirectTo:null,migrating:null,inferredPairs:[{letterboxd:lid,tmdb:k,kind:'inferred'}]};
  if(lid==='BR07'){ratings.key='tmdb-'+k;ratings.lidKey='lb-'+lid;ratings.record=undefined;}
  if(lid==='BR08')ratings.third='letterboxd:EXTRA'+k;
  if(lid==='BR09')ratings.record={schemaVersion:1,factKey:'tmdb-'+k,links:{letterboxd:lid,tmdb:tmdb},redirectTo:null,migrating:{to:'x'}};
  seedRatings(file,lid,k,{...ratings,index:lid!=='BR14'});
  if(lid==='BR07')putDoc(file,'letterboxd/facts/films/lb-'+lid+'.json',{schemaVersion:1,factKey:'lb-'+lid,links:{letterboxd:lid,tmdb:tmdb},redirectTo:null,migrating:null});
  pointer(file,lid,3.5);
  if(DUAL.has(lid))pointer(file,'tmdb_'+tmdb,DIFFERING.has(lid)?4:3.5);
 });
 // Film-side states
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:redirect-target',2,'tmdb:5000','Target','"+U+"');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ("+q(FID(10))+",'film:redirect-target',"+q(U)+")");
 sqlite(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r1',"+q(FID(11))+",'retire','BR11','11','1',"+q('{}')+","+q(JSON.stringify({by:'owner',at:U,source:'synthetic'}))+",'owner_request','{}',"+q(U)+")");
 sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',2,NULL,'Other','"+U+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','letterboxd','BR13',0,0,NULL)");
 // BR04: the legacy unmarked inferred pair: the admission row of the inferred-import archive, with the lid as source code and no durable mark on the record.
 sqlite(file,"INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ("+q(FID(4))+",'4','BR04',"+q(INFERRED_ARCHIVE)+",'T',2000,'rk','tmdb_4','2026-11-01T00:00:00.000Z','rq',"+q(U)+")");
 return file;
}

// 1. The discovery finds exactly the 15 keys, is bounded, indexed (EXPLAIN) and read-only.
const file=world();
const before=dump(file);
const plan=String(sqliteSync([file],{input:'EXPLAIN QUERY PLAN '+DISCOVERY_SQL.replace('?','65')+';',encoding:'utf8'}).stdout).replace(/\s+/g,' ');
assert.ok(/film_external_id_(one_trusted|by_scheme_value)/.test(plan),'the claim anti-join uses an index of film_external_id: '+plan);
assert.ok(!/SCAN (film_external_id|e)\b/.test(plan),'no full scan of film_external_id: '+plan);
const cohort=await discover(file);
assert.deepEqual(cohort.map(item=>item.lid),Object.keys(CASES),'the discovery returns exactly the bridge keys');
assert.deepEqual(cohort.filter(item=>item.movies!==1).map(item=>item.lid),['BR07','BR14'],'two keys have no derivable movie id');
assert.equal(dump(file),before,'discovery writes nothing');

// 2. Multiplicity accounting, in the shape of the AIR-627 finding (values are never reported, only agreement).
{
 const info=cohort.map(item=>{
  const own=rows(file,'SELECT predicted_rating AS value FROM prediction_pointer WHERE film_id='+q(item.lid))[0];
  // The second pointer is found by the movie key of the Film that owns it, independent of whether the link index can derive it.
  const movie=rows(file,'SELECT predicted_rating AS value FROM prediction_pointer WHERE film_id='+q('tmdb_'+(Object.keys(CASES).indexOf(item.lid)+1)))[0]??null;
  return {lid:item.lid,dual:!!movie,differs:!!movie&&movie.value!==own.value};
 });
 assert.equal(info.filter(item=>!item.dual).length,4,'bridge-only Films');
 assert.equal(info.filter(item=>item.dual).length,11,'Films with a second pointer');
 assert.equal(info.filter(item=>item.differs).length,5,'second pointers with a different value');
 assert.equal(info.length,4+11);
}

// 3. Classification: every key gets exactly one explicit state and reason; the planner and the screen are the only inputs; the counters add up; the read cost per key is bounded.
{
 const env=envOf(file),db=env.DB;
 const result={},cost={};
 for(const item of cohort){
  const start=db.calls.queries;
  result[item.lid]=item.tmdb?await classify(env,db,item):{state:'unknown',reason:'ratings_movie_link_missing_or_ambiguous'};
  cost[item.lid]=db.calls.queries-start;
 }
 assert.deepEqual(result,CASES);
 const totals={};for(const item of Object.values(result))totals[item.state]=(totals[item.state]||0)+1;
 assert.deepEqual(totals,{eligible:3,unknown:4,ineligible:8},'the three classes add up to the whole cohort');
 assert.equal(Object.values(totals).reduce((a,b)=>a+b,0),cohort.length,'total = eligible + ineligible + unknown + already');
 const worst=Math.max(...Object.values(cost));
 // Measured on the stand-in: a full pass costs 24 statements (marker reads before and after, the link index and the fact record, the projection, the claims, the Film side and the screen); a refusal stops earlier.
 // The link index is a multi-part document in production, so the real row cost per key is higher than the statement count; it is re-read for EVERY key (src/canonical-letterboxd-claim.js linkEvidence).
 assert.ok(worst<=24,'at most 24 D1 statements per key (worst '+worst+')');
 assert.equal(worst,24,'the bound is the measured worst case, so a cost change is noticed');
 assert.equal(dump(file),before,'classification is read-only: no claim, receipt, revision, alias or pointer moved');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0);
}

// 4. The planner alone passes the legacy unmarked inferred pair (its documented limit); only the witness screen keeps it out of `eligible`. Without the screen it would count as eligible.
{
 const env=envOf(file);
 assert.deepEqual((await planLetterboxdClaim(env,{lid:'BR04',tmdb:'4'})).verdict,'pass');
 assert.deepEqual(await classify(env,env.DB,{lid:'BR04',tmdb:'4'},{inferredArchives:[]}),{state:'eligible',reason:'proved'},'with no known inferred archive the screen is blind: the operator must supply it');
 assert.deepEqual(await classify(env,env.DB,{lid:'BR04',tmdb:'4'}),{state:'unknown',reason:'legacy_inferred_pair_suspected'});
}

// 5. WHY AIR-559 saw a zero cohort: the backfill derives its cohort from the current published programme run only. These 15 lids are prediction keys outside that run, so the dry run is `already_current`
//    with cohort 0 whatever their ADR 0184 verdict. Control: the same lid inside the run is a candidate at once.
{
 const scoped=world();
 seedFilm(scoped,900,{extra:[['letterboxd','HELD900',1,0]]});seedRatings(scoped,'HELD900',900);
 publish(scoped,['HELD900']);
 const absent=await deriveBackfillCohort(envOf(scoped));
 assert.deepEqual([absent.decision,absent.counts.cohort,absent.blockers],['already_current',0,[]],'the 15 keys are invisible to the AIR-559 cohort');
 const control=world();
 publish(control,['BR01']);
 const seen=await deriveBackfillCohort(envOf(control));
 assert.deepEqual([seen.decision,seen.counts.cohort,seen.counts.pass],['eligible',1,1],'the same lid inside the published run is a candidate');
 assert.equal(rows(control,'SELECT COUNT(*) AS n FROM film_external_id WHERE scheme=\'letterboxd\' AND trusted=1').filter(Boolean)[0].n,0,'the dry run wrote no claim');
}

// 6. Infrastructure states are `unknown`, never a verdict and never eligible: a held Film/Person marker and a ratings domain that is not authoritative.
{
 for(const stage of ['held','ratings_not_d1']){
  const f=database(stage);
  seedFilm(f,1);seedRatings(f,'BR01',1);pointer(f,'BR01',3.5);
  const env=envOf(f);
  const out=await classify(env,env.DB,{lid:'BR01',tmdb:'1'});
  assert.deepEqual(out,{state:'unknown',reason:stage==='held'?'film_person_not_open':'ratings_not_authoritative'},stage);
 }
}

// 7. Static boundary: this file and the classifier never import or call an apply path, a producer or the MCP tool.
{
 const text=fs.readFileSync(new URL(import.meta.url),'utf8');
 const forbidden=['applyLetterboxdClaim','ensureLetterboxdClaims','handleLetterboxdClaimBackfillTool','mutateFilm'];
 const own=text.split('\n').filter(line=>!line.trim().startsWith('//')&&!line.includes('const forbidden')).join('\n');
 for(const name of forbidden)assert.ok(!own.includes(name),'no '+name);
}
console.log('prediction alias bridge cohort (AIR-652): ok');
