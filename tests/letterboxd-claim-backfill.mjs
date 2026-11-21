// AIR-559 (ADR 0184): the owner-only Letterboxd claim backfill operator (src/letterboxd-claim-backfill.js, the body of the MCP tool `letterboxd_claim_backfill`) on the sqlite3-CLI D1 stand-in. SYNTHETIC ids only; no Worker, R2, D1 or
// Cloudflare access and no production write. Covered: a cohort derived by the server, a dry_run with no side effect and no lid-to-movie mapping in its answer, the apply refusal matrix with zero writes, an exact apply with receipts and the authoritative
// readback, a replay that never writes twice, unsafe states, the cap, authority and publication gates, a partial apply that stops without a blind retry, and the static boundary. BACKFILL_SRC points the file at a mutant copy of src/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.BACKFILL_SRC?path.resolve(process.env.BACKFILL_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const B=await load('letterboxd-claim-backfill.js');
const {mutateFilm}=await load('canonical-mutations.js');
const {handleLetterboxdClaimBackfillTool:tool,deriveBackfillCohort,cohortDigest,BACKFILL_MAX}=B;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-lb-claim-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
let n=0;
function database(stage='open'){
 const file=path.join(root,'c-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='open')assert.equal(sqlite(file,BASELINE).status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-20T10:00:00.000Z';
const U='2026-11-01T00:00:00.000Z';
const FID=k=>'film:tmdb:'+k;
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";
// A Film with its trusted tmdb claim (default) and any extra stored ids [scheme,value,trusted,conflicting].
const seedFilm=(file,k,{ids=null,identity=true}={})=>{
 const claims=ids||[['tmdb',String(k),1,0]];
 assert.equal(sqlite(file,"INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+FID(k)+"',2,"+q(identity?'tmdb:'+k:null)+",'Kept Title','"+U+"');"+claims.map(([s,v,t,c])=>"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(k)+"','"+s+"','"+v+"',"+t+","+c+",NULL);").join('')).status,0);
};
// The Ratings side of one record. The AUTHORITATIVE evidence is the pair of D1 documents (link index + fact record); `ratings_view` is only the projection. Options: `docs:false` writes the projection only (a stale
// projection after an unlink), `movie:false` omits the movie alias from the index, `lidKey`/`key` point the lid at another fact key, `record` overrides the record body.
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const putDoc=(file,key,value)=>{const text=JSON.stringify(value),tag=sha(text);assert.equal(sqlite(file,"DELETE FROM ratings_document WHERE key="+q(key)+";INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ("+q(key)+",0,"+q(text)+",'"+tag+"','"+U+"')").status,0);};
const getDoc=(file,key)=>{const r=rows(file,"SELECT body FROM ratings_document WHERE key="+q(key));return r.length?JSON.parse(r[0].body):null;};
const seedRatings=(file,lid,k,{key='tmdb-'+k,movie=true,lidKey=key,docs=true,record=null}={})=>{
 assert.equal(sqlite(file,"INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ("+q(lid)+","+q(lidKey)+",NULL,NULL,1,0,'"+U+"');"+(movie?"INSERT OR IGNORE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('tmdb_"+k+"',"+q(key)+",NULL,NULL,1,0,'"+U+"');":'')).status,0);
 if(!docs)return;
 const index=getDoc(file,'letterboxd/facts/links.json')||{};
 index['letterboxd:'+lid]=lidKey;if(movie)index['tmdb:'+k]=key;
 putDoc(file,'letterboxd/facts/links.json',index);
 putDoc(file,'letterboxd/facts/films/'+lidKey+'.json',record||{schemaVersion:1,factKey:lidKey,links:{letterboxd:lid,tmdb:String(k)},redirectTo:null,migrating:null});
};
const ext=(file,k=1)=>rows(file,"SELECT scheme,value,trusted,conflicting,provenance_json FROM film_external_id WHERE film_id='"+FID(k)+"' ORDER BY scheme,value");
const pairs=(file,k=1)=>ext(file,k).map(item=>item.scheme+':'+item.value);
const receipts=file=>rows(file,'SELECT request_id,operation,origin,target_id,state,attempts,applied_revision,error_class FROM canonical_write_receipt ORDER BY target_id,created_at');
const revision=(file,id=FID(1))=>Number(one(file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='"+id+"'")??0);
const TABLES=['film','film_external_id','film_alias','film_person_credit','film_redirect','film_rated_admission','film_retention','film_dimension','film_metadata','canonical_revision','canonical_write_receipt','ratings_view','tmdb_retirement_decision'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3')]));

const REQ_UNUSED=null;

const lidsOf=(file)=>rows(file,"SELECT value FROM film_external_id WHERE scheme='letterboxd' ORDER BY value").map(item=>item.value);
const count=(file,table)=>Number(one(file,'SELECT COUNT(*) FROM '+table));
// One published run `run-1` with the given member lids (kind programme, and the same lids in the watchlist), the publication marker d1/open.
const publish=(file,lids,{mode='d1',cutover='open',run='run-1'}={})=>{
 assert.equal(sqlite(file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('"+run+"','published','"+U+"','"+'0'.repeat(64)+"','"+U+"');"+lids.map((lid,i)=>"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('"+run+"','programme',"+i+","+q(lid)+");INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('"+run+"','watchlist',"+i+","+q(lid)+");").join('')+"UPDATE published_epg_authority SET mode='"+mode+"',cutover='"+cutover+"',programme_run_id='"+run+"' WHERE id=1").status,0);
};
// A cohort of `n` members that lack a claim (Film k, lid L<k>, movie k) plus one member that already holds its trusted claim and one tmdb-spelled member.
const world=(n=3,{extra=null}={})=>{
 const file=database();const members=[];
 for(let k=1;k<=n;k++){seedFilm(file,k);seedRatings(file,'L'+k,k);members.push('L'+k);}
 seedFilm(file,500,{ids:[['tmdb','500',1,0],['letterboxd','HELD500',1,0]]});seedRatings(file,'HELD500',500);members.push('HELD500');
 members.push('tmdb_77');
 publish(file,members);
 if(extra)extra(file);
 return file;
};
const call=(file,args,options)=>tool(envOf(file,options),args,{now:()=>T});
const applyArgs=(dry,extra={})=>({mode:'apply',confirmGo:true,requestId:'req-backfill-0001',expectedFilmPersonGeneration:dry.expect.filmPersonGeneration,expectedRatingsGeneration:dry.expect.ratingsGeneration,expectedProgrammeRunId:dry.expect.programmeRunId,expectedCount:dry.expect.count,expectedDigest:dry.expect.digest,...extra});

// 1. dry_run: the cohort is the server's, the answer holds counts, reasons, generations and the digest, never a lid or a movie mapping, and nothing is written.
{
 const file=world(3),before=dump(file),startedBefore=count(file,'started_mark');
 const out=await call(file,{mode:'dry_run'});
 assert.equal(out.status,200);assert.equal(out.body.ok,true);assert.equal(out.body.sideEffects,'none');
 assert.equal(out.body.decision,'eligible');assert.equal(out.body.counts.cohort,3);assert.equal(out.body.counts.pass,3);assert.equal(out.body.expect.count,3);
 assert.deepEqual(out.body.authorities.filmPerson,{state:'open',generation:2});assert.equal(out.body.authorities.ratings.mode,'d1');assert.equal(out.body.publication.programmeRunId,'run-1');
 assert.equal(out.body.expect.digest,await cohortDigest([{lid:'L1',tmdb:'1'},{lid:'L2',tmdb:'2'},{lid:'L3',tmdb:'3'}]),'the digest is the sha256 of the sorted lid:tmdb lines');
 assert.match(out.body.expect.digest,/^[0-9a-f]{64}$/);
 const text=JSON.stringify(out.body);
 for(const secret of ['L1','L2','L3','HELD500','tmdb_77','film:tmdb'])assert.ok(!text.includes(secret),'the answer never carries '+secret);
 assert.equal(dump(file),before,'a dry run writes nothing');assert.equal(count(file,'started_mark'),startedBefore);
 assert.equal((await call(file,{mode:'dry_run'})).body.expect.digest,out.body.expect.digest,'the dry run is repeatable');
}
// the cohort is only the missing lids of the published run: a held lid, a tmdb-spelled member and a lid of an older run are not in it
{
 const file=world(2);seedFilm(file,900);seedRatings(file,'OLD900',900);publish(file,['OLD900'],{run:'run-0',mode:'d1'});
 assert.equal(sqlite(file,"UPDATE published_epg_authority SET programme_run_id='run-1' WHERE id=1").status,0);
 const out=await call(file,{mode:'dry_run'});assert.equal(out.body.counts.cohort,2);assert.equal(out.body.expect.programmeRunId,'run-1');
}
// nothing missing: already_current, and apply is not eligible
{
 const file=database();seedFilm(file,1,{ids:[['tmdb','1',1,0],['letterboxd','H1',1,0]]});seedRatings(file,'H1',1);publish(file,['H1']);
 const out=await call(file,{mode:'dry_run'});assert.equal(out.body.decision,'already_current');assert.equal(out.body.counts.cohort,0);
}

// 2. apply refusals: every one is zero writes (the dump is byte-identical).
{
 const file=world(3),dry=(await call(file,{mode:'dry_run'})).body,before=dump(file);
 const refuse=async(name,args,status,reason)=>{const out=await call(file,args);assert.equal(out.status,status,name);assert.equal(out.body.ok,false,name);if(reason)assert.equal(out.body.reason,reason,name);assert.equal(dump(file),before,name+': zero writes');};
 await refuse('no confirmGo',{...applyArgs(dry),confirmGo:undefined},400,'confirm_required');
 await refuse('confirmGo false',{...applyArgs(dry),confirmGo:false},400,'confirm_required');
 await refuse('confirmGo not a boolean',{...applyArgs(dry),confirmGo:'true'},400,'invalid_confirm');
 await refuse('no requestId',{...applyArgs(dry),requestId:undefined},400,'invalid_request_id');
 await refuse('bad requestId',{...applyArgs(dry),requestId:'x'},400,'invalid_request_id');
 await refuse('no pins',{mode:'apply',confirmGo:true,requestId:'req-backfill-0001'},400);
 await refuse('bad digest',{...applyArgs(dry),expectedDigest:'zz'},400,'invalid_expected_digest');
 await refuse('count over the cap',{...applyArgs(dry),expectedCount:BACKFILL_MAX+1},400,'invalid_expected_count');
 await refuse('count zero',{...applyArgs(dry),expectedCount:0},400,'invalid_expected_count');
 await refuse('bad mode',{mode:'run'},400,'invalid_mode');
 await refuse('not an object',null,400,'invalid');
 await refuse('digest mismatch',applyArgs(dry,{expectedDigest:'0'.repeat(64)}),409,'pins_mismatch');
 await refuse('Film/Person generation mismatch',applyArgs(dry,{expectedFilmPersonGeneration:dry.expect.filmPersonGeneration+1}),409,'pins_mismatch');
 await refuse('Ratings generation mismatch',applyArgs(dry,{expectedRatingsGeneration:dry.expect.ratingsGeneration+1}),409,'pins_mismatch');
 await refuse('programme run mismatch',applyArgs(dry,{expectedProgrammeRunId:'run-2'}),409,'pins_mismatch');
 await refuse('count mismatch',applyArgs(dry,{expectedCount:2}),409,'pins_mismatch');
 const mism=await call(file,applyArgs(dry,{expectedCount:2,expectedDigest:'1'.repeat(64)}));assert.deepEqual(mism.body.mismatched.sort(),['count','digest']);
 // a caller cannot name a cohort: extra fields are never read
 const extra=await call(file,applyArgs(dry,{lid:'L1',tmdb:'1',pairs:[{lid:'HACK',tmdb:'9'}],sql:'delete from film'}));
 assert.equal(extra.status,200);assert.deepEqual(lidsOf(file),['HELD500','L1','L2','L3'].sort(),'only the server-derived cohort is written');
}

// 3. apply: exactly the cohort, through the fenced unit with receipts, then an authoritative readback; nothing else moves; a replay never writes twice.
{
 const file=world(3),dry=(await call(file,{mode:'dry_run'})).body;
 seedStarted(file);const startedBefore=count(file,'started_mark'),aliasBefore=count(file,'film_alias'),viewBefore=count(file,'ratings_view'),extBefore=count(file,'film_external_id');
 const out=await call(file,applyArgs(dry));
 assert.equal(out.status,200);assert.equal(out.body.ok,true);assert.equal(out.body.outcome,'complete');
 assert.deepEqual(out.body.counts,{written:3,already:0,refused:0,unknown:0,deferred:0,failed:0,notAttempted:0});
 assert.deepEqual(out.body.readback,{found:3,remaining:0,delta:{film_external_id:3,film_alias:0,ratings_view:0,started_mark:0},unexpectedChange:false});
 assert.deepEqual(lidsOf(file),['HELD500','L1','L2','L3']);
 for(const k of [1,2,3]){assert.equal(revision(file,FID(k)),1);const claim=ext(file,k).find(item=>item.scheme==='letterboxd');assert.equal(claim.trusted,1);assert.deepEqual(JSON.parse(claim.provenance_json),{source:'ratings_alias_bridge',tmdb:String(k),adr:'0184'});}
 const r=receipts(file);assert.equal(r.length,3);assert.ok(r.every(item=>item.operation==='film_external_ids'&&item.origin==='letterboxd_claim'&&item.state==='applied'));
 assert.equal(count(file,'started_mark'),startedBefore,'no Started mark');assert.equal(count(file,'film_alias'),aliasBefore);assert.equal(count(file,'ratings_view'),viewBefore);assert.equal(count(file,'film_external_id'),extBefore+3);
 const text=JSON.stringify(out.body);for(const secret of ['L1','L2','L3','HELD500'])assert.ok(!text.includes(secret),'the apply answer never carries '+secret);
 const after=dump(file);
 // the same request again, and a fresh dry run: nothing is missing any more, nothing is written
 const replay=await call(file,applyArgs(dry));assert.equal(replay.status,409);assert.equal(dump(file),after,'a replay never writes twice');
 assert.equal((await call(file,{mode:'dry_run'})).body.decision,'already_current');
}
function seedStarted(file){assert.equal(sqlite(file,"INSERT INTO started_mark (id,started,started_at,last_event_json,rev) VALUES ('KEEP1',1,'"+U+"',NULL,1)").status,0);}

// 4. unsafe states: the dry run says so and apply writes nothing, whatever the pins.
const unsafe=async(name,build,reason,decision='unsafe')=>{
 const file=build();const before=dump(file);
 const dry=await call(file,{mode:'dry_run'});
 assert.equal(dry.body.decision,decision,name);assert.ok(dry.body.blockers.some(item=>item.reason===reason),name+': '+JSON.stringify(dry.body.blockers));
 const pins=dry.body.expect||{filmPersonGeneration:2,ratingsGeneration:1,programmeRunId:'run-1',count:1,digest:'a'.repeat(64)};
 const out=await call(file,applyArgs({expect:pins}));
 assert.equal(out.status,409,name);assert.equal(out.body.writes,0,name);assert.equal(dump(file),before,name+': zero writes');
};
await unsafe('a movie alias pointing at another key',()=>world(3,{extra:file=>{const index=getDoc(file,'letterboxd/facts/links.json');index['tmdb:2']='tmdb-9';putDoc(file,'letterboxd/facts/links.json',index);}}),'ratings_movie_link_missing_or_ambiguous');
await unsafe('a Film holding another lid',()=>world(3,{extra:file=>assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(2)+"','letterboxd','OTHER2',1,0,NULL)").status,0)}),'film_has_other_lid');
await unsafe('a competing claim of the lid',()=>world(3,{extra:file=>{seedFilm(file,600);assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(600)+"','letterboxd','L2',0,0,NULL)").status,0);}}),'lid_claimed_elsewhere');
await unsafe('a lid without a Ratings link',()=>world(3,{extra:file=>{const index=getDoc(file,'letterboxd/facts/links.json');delete index['letterboxd:L1'];putDoc(file,'letterboxd/facts/links.json',index);}}),'ratings_link_absent');
await unsafe('a lid whose key has no movie alias',()=>world(3,{extra:file=>{const index=getDoc(file,'letterboxd/facts/links.json');delete index['tmdb:3'];putDoc(file,'letterboxd/facts/links.json',index);}}),'ratings_movie_link_missing_or_ambiguous');
await unsafe('a retired movie id',()=>world(3,{extra:file=>assert.equal(sqlite(file,"INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r1','"+FID(1)+"','retire','L1','1','7','{}','{\"by\":\"owner\",\"at\":\""+U+"\",\"source\":\"t\"}','owner_request','{}','"+U+"')").status,0)}),'tmdb_retired');
await unsafe('a cohort over the cap',()=>world(BACKFILL_MAX+1),'cohort_over_limit');
await unsafe('the Ratings domain held',()=>world(3,{extra:file=>assert.equal(sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1").status,0)}),'ratings_not_authoritative');
await unsafe('the publication not authoritative',()=>world(3,{extra:file=>assert.equal(sqlite(file,"UPDATE published_epg_authority SET mode='r2' WHERE id=1").status,0)}),'publication_not_authoritative');
await unsafe('the publication held',()=>world(3,{extra:file=>assert.equal(sqlite(file,"UPDATE published_epg_authority SET cutover='held' WHERE id=1").status,0)}),'publication_not_authoritative');
{ // Film/Person held and below open: unsafe with a typed reason, never an exception
 for(const stage of ['held','r2']){
  const file=database(stage);const before=dump(file);
  const dry=await call(file,{mode:'dry_run'});assert.ok(['unsafe','unknown'].includes(dry.body.decision),stage);assert.equal(dry.status,200);
  assert.equal((await call(file,applyArgs({expect:{filmPersonGeneration:2,ratingsGeneration:1,programmeRunId:'run-1',count:1,digest:'a'.repeat(64)}}))).status,409);
  assert.equal(dump(file),before);
 }
}
// the exact cap is allowed
{
 const file=world(BACKFILL_MAX),dry=(await call(file,{mode:'dry_run'})).body;assert.equal(dry.decision,'eligible');assert.equal(dry.expect.count,BACKFILL_MAX);
 const out=await call(file,applyArgs(dry));assert.equal(out.body.counts.written,BACKFILL_MAX);assert.equal(out.body.ok,true);
}

// 5. a partial apply stops at the first pair that is not proved, says so honestly, and never retries or touches the rest.
{
 const file=world(3);const dry=(await call(file,{mode:'dry_run'})).body;let step=0;
 // after the first pair is written, a competing Film claims the lid of the second one: that pair is refused, the third is not attempted
 const out=await call(file,applyArgs(dry),{onBatch:async()=>{step++;if(step===2){seedFilm(file,700);assert.equal(sqlite(file,"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+FID(700)+"','letterboxd','L2',0,0,NULL)").status,0);}}});
 assert.equal(out.status,200);assert.equal(out.body.ok,false);assert.equal(out.body.outcome,'partial');
 assert.equal(out.body.counts.written,1);assert.equal(out.body.counts.notAttempted,1);assert.ok(out.body.counts.refused+out.body.counts.failed+out.body.counts.deferred+out.body.counts.unknown===1,'exactly one pair stopped the run');
 assert.deepEqual(out.body.items.map(item=>item.state).slice(0,1),['written']);assert.equal(out.body.items.at(-1).state,'not_attempted');
 assert.deepEqual(rows(file,"SELECT value FROM film_external_id WHERE scheme='letterboxd' AND film_id IN ('"+FID(1)+"','"+FID(2)+"','"+FID(3)+"') ORDER BY value").map(item=>item.value),['L1'],'only the proved pair is written; no blind retry');
 assert.equal(out.body.readback.found,1);assert.equal(out.body.readback.remaining,2);
 assert.ok(!JSON.stringify(out.body).includes('L2'));
 // the state moved: the same request cannot be replayed blindly, a new dry run decides
 assert.equal((await call(file,applyArgs(dry))).status,409);
}

// 6. static boundary: the operator reads no R2, fetches nothing, schedules nothing, takes no id from the caller and writes only through the claim writer.
{
 const text=fs.readFileSync(path.join(SRC,'letterboxd-claim-backfill.js'),'utf8').split('\n').filter(line=>!line.trim().startsWith('//')).join('\n');
 for(const word of ['fetch(','setTimeout','setInterval','env.BUCKET','BUCKET','cron','waitUntil','Math.random','Date.now','new Date'])assert.ok(!text.includes(word),word);
 assert.ok(!/\b(INSERT|UPDATE|DELETE)\b\s/i.test(text.replace(/SELECT[^'`"]*/g,'')),'no write SQL of its own');
 assert.ok(/applyLetterboxdClaim\(env/.test(text),'it writes only through the claim writer');
 assert.ok(!/args\.(lid|tmdb|filmId|pairs|sql|url|key)\b/.test(text),'no cohort field is read from the caller');
}
console.log('letterboxd-claim-backfill: ok');
