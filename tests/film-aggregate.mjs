// AIR-647 / ADR 0216 (Accepted), delivery graph step 3: the dormant FilmAggregateV1 sections over the AIR-646 resolver, with the mandatory candidate
// discovery and coverage of decision 6b (G1). Synthetic fixtures only, on the sqlite3-CLI D1 stand-in over the full migration chain. ADR 0216 synthetic
// tests 1-4, 9-25 (15b included), 17 (GET read audit of the dormant route) and the EXPLAIN QUERY PLAN of every new statement. Nothing here touches the
// Worker bundle, R2, the network or production.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {
 readFilmAggregate,readSections,handleFilmAggregateRequest,countedDatabase,FILM_AGGREGATE_ROUTE,DISPLAY_SQL,
 LINK_DOCUMENT_MAX_PARTS,LINK_INDEX_MAX_ENTRIES,FACT_RECORDS_MAX,FACT_RECORD_MAX_PARTS,SETTLEMENT_ROWS_MAX,CANDIDATES_MAX,CURRENT_SHOWS_MAX,CREDITS_MAX,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX,OWNER_ENTRIES_MAX,
} from '../src/film-aggregate.js';
import {createStatementBudget,REQUEST_STATEMENT_BUDGET,AUTHORIZED_ALIASES_PER_SCHEME} from '../src/film-aggregate-resolver.js';
import {readFilmReadiness} from '../src/film-readiness-composition.js';
import {predictionEvidence,authorizedStorageIds} from '../src/film-readiness.js';
import {predictionFacts} from '../src/domain/film-dimension-parity.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-aggregate-v1-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const AT='2026-11-25T10:00:00.000Z';
const q=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const RUN='run-1';
const OPEN=[
 "UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",
 "UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1",
 "UPDATE prediction_domain_authority SET mode='d1' WHERE id=1",
 `INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('${RUN}','published','${AT}','${'a'.repeat(64)}','${AT}')`,
 `UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='${RUN}',generation=1 WHERE id=1`,
 "UPDATE watchlist_authority SET mode='d1' WHERE id=1",
].join(';\n');
const schema=path.join(root,'schema.sqlite');
sqlite(schema,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
sqlite(schema,OPEN);
// AIR-667: migration 0040 of the real chain installs tmdb_retirement_decision_movie; the EQP below asserts the plan over it.
assert.equal(sqliteSync([schema],{input:"SELECT name FROM sqlite_master WHERE type='index' AND name='tmdb_retirement_decision_movie';",encoding:'utf8'}).stdout.trim(),'tmdb_retirement_decision_movie');
let n=0;
const blank=()=>{const file=path.join(root,'f-'+(n++)+'.sqlite');fs.copyFileSync(schema,file);return file;};

// ---- fixture writers (test-only SQL) ----
function film(file,id,claims=[]){
 sqlite(file,`INSERT INTO film (id,contract_version,updated_at) VALUES (${q(id)},1,${q(AT)});INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film',${q(id)},1,${q(AT)});`
  +claims.map(([scheme,value,trusted=1,conflicting=0])=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},${trusted},${conflicting});`).join(''));
}
const claim=(file,id,scheme,value,trusted=1,conflicting=0)=>sqlite(file,`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES (${q(id)},${q(scheme)},${q(value)},${trusted},${conflicting})`);
const CONFIRM=q(JSON.stringify({by:'owner',at:AT,source:'synthetic'}));
let request=0;
const retire=(file,filmId,movie,tv,lid)=>sqlite(file,`INSERT INTO tmdb_retirement_decision (request_id,film_id,kind,lid,movie_id,tv_id,evidence_json,confirmation_json,origin,payload_json,recorded_at) VALUES ('r${request++}',${q(filmId)},'retire',${q(lid)},${q(movie)},${q(tv)},'{}',${CONFIRM},'owner_request','{}',${q(AT)})`);
const sha256=text=>crypto.createHash('sha256').update(text).digest('hex');
// An owned ratings document, split as src/ratings-d1.js splits it (the etag is the SHA-256 of the joined text).
function putDocument(file,key,value,{partBytes=60000}={}){
 const text=JSON.stringify(value),etag=sha256(text),parts=[];
 for(let at=0;at<text.length;at+=partBytes)parts.push(text.slice(at,at+partBytes));
 if(!parts.length)parts.push('');
 sqlite(file,`DELETE FROM ratings_document WHERE key=${q(key)};`+parts.map((body,part)=>`INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (${q(key)},${part},${q(body)},${q(etag)},${q(AT)});`).join(''));
}
const record=(factKey,links,extra={})=>({schemaVersion:1,factKey,links:{letterboxd:links.letterboxd??null,tmdb:links.tmdb??null},redirectTo:null,migrating:null,...extra});
const putRecord=(file,factKey,links,extra)=>putDocument(file,'letterboxd/facts/films/'+factKey+'.json',record(factKey,links,extra));
const putLinks=(file,index)=>putDocument(file,'letterboxd/facts/links.json',index);
const view=(file,alias,factKey,{watched=null,rating=null,known=0}={})=>sqlite(file,`INSERT OR REPLACE INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q(alias)},${q(factKey)},${q(watched)},${q(rating)},NULL,${known},${q(AT)})`);
const pointer=(file,storageId,rating,{sha='c'.repeat(64)}={})=>sqlite(file,`INSERT OR REPLACE INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (${q(storageId)},3,'h','f',1,1,${q(rating)},${q('enrichment/films/'+storageId+'/predictions/x.json')},${q(sha)},${q(AT)},'{"band":"x"}')`);
const show=(file,storageId,start,channel='ch1')=>sqlite(file,`INSERT INTO published_epg_show (programme_run_id,film_id,channel_id,start_ms,end_ms,channel,epg_title,basis,match_reason) VALUES ('${RUN}',${q(storageId)},${q(channel)},${start},${start+5400000},'Channel','T','programme',NULL)`);
let snapshotVersion=0;
// A complete current Watchlist snapshot holding `lids`, published through the guarded pointer (revision + 1, version + 1).
function watchlist(file,lids,{drained=true}={}){
 const version=Number(JSON.parse(sqliteSync(['-json',file],{input:'SELECT version FROM watchlist_current WHERE id=1;',encoding:'utf8'}).stdout)[0].version)+1;
 const id='snap-'+version+'-'+(snapshotVersion++),sum='b'.repeat(64);
 sqlite(file,`INSERT INTO watchlist_staging (snapshot_id,attempt_id,expected_count,expected_sha256,started_at) VALUES (${q(id)},${q(id)},${lids.length},${q(sum)},${q(AT)});`
  +lids.map((lid,i)=>`INSERT INTO watchlist_member (snapshot_id,ordinal,lid,title,year,url) VALUES (${q(id)},${i},${q(lid)},'T',2000,'https://letterboxd.com/film/x/');`).join('')
  +`INSERT INTO watchlist_snapshot (snapshot_id,version,scan_id,observed_at,committed_at,film_count,list_sha256,prev_version) VALUES (${q(id)},${version},'scan',${q(AT)},${q(AT)},${lids.length},${q(sum)},${version-1});`
  +`UPDATE watchlist_current SET version=${version},snapshot_id=${q(id)},list_sha256=${q(sum)},film_count=${lids.length},last_success_at=${q(AT)},effects_drained_version=${drained?version:'effects_drained_version'},revision=revision+1,updated_at=${q(AT)} WHERE id=1;`);
}
const metadata=(file,filmId,fields)=>sqlite(file,`INSERT OR REPLACE INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,payload_json,content_sha256,updated_at) VALUES (${q(filmId)},1,${q(fields.year??null)},${q(fields.runtime??null)},${q(fields.synopsis??null)},NULL,NULL,${q(JSON.stringify(fields.genres??[]))},'{}',${q(fields.sha??'d'.repeat(64))},${q(AT)})`);
const ownerTitle=(file,sourceKey,link,value)=>sqlite(file,`INSERT OR REPLACE INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film',${q(sourceKey)},${q(JSON.stringify({localization:{status:'reviewed',value,provenance:{authority:'owner'},updatedAt:AT}}))},${q(link)},'verified',1)`);

const noR2=new Proxy({},{get(){throw new Error('R2 must not be touched');}});
const env=(file,options)=>{const DB=d1Standin(file,options);return {DB,BUCKET:noR2,R2:noR2,calls:DB.calls};};
globalThis.fetch=()=>{throw new Error('network must not be touched');};
const read=async(file,id,options={})=>{const e=env(file,options);const out=await readFilmAggregate(e,id,options);return {...out,calls:e.calls};};
const fileSha=file=>sha256(fs.readFileSync(file));

// The base world: Film film:tmdb:5 with trusted tmdb 5 and lid l5, complete ratings coverage (both seeds on fact key tmdb-5, nothing else), a prediction,
// a Watchlist snapshot listing l5, owner-reviewed title and partial metadata.
function world({lids=['l5'],links=null,records=true}={}){
 const file=blank();
 film(file,'film:tmdb:5',[['tmdb','5'],...lids.map(l=>['letterboxd',l])]);
 const index=links??Object.fromEntries([['tmdb:5','tmdb-5'],...lids.map(l=>['letterboxd:'+l,'tmdb-5'])]);
 putLinks(file,index);
 if(records)putRecord(file,'tmdb-5',{letterboxd:lids[0],tmdb:'5'});
 view(file,'tmdb_5','tmdb-5',{watched:1,rating:4,known:1});
 for(const l of lids)view(file,l,'tmdb-5',{watched:1,rating:4,known:1});
 return file;
}

// Test 1: a prediction stored under an authorized lid, requested by /film/tmdb_<n>: present, storageId = lid; coverage complete (test 18).
{
 const file=world();
 pointer(file,'l5',3.5);
 const {http,body,calls}=await read(file,'tmdb_5');
 assert.equal(http,200);
 assert.equal(body.contract,'film-aggregate/v1');
 assert.equal(body.identity.verdict,'found');
 assert.equal(body.predictions.status,'present');
 assert.deepEqual(body.predictions.current.map(p=>[p.storageId,p.predictedRating]),[['l5',3.5]]);
 assert.equal(body.predictions.coverage.status,'complete');
 assert.ok(body.predictions.token.generation!=null&&body.predictions.token.pointers.startsWith('sha256:'));
 assert.equal(body.personal.status,'present');
 assert.deepEqual([body.personal.fields.rating.status,body.personal.fields.rating.value],['present',4]);
 assert.deepEqual(body.personal.fields.rating.storageIds,['l5','tmdb_5'],'one fact reachable through two aliases is one value');
 // History: one authorized lid, complete coverage, tmdb_<n> requested: limited with the legacy href; never present.
 assert.deepEqual([body.history.status,body.history.reason,body.history.href],['limited','history_migration_pending','/api/enrichment/history?filmId=tmdb_5']);
 assert.ok(calls.queries+calls.statements<=REQUEST_STATEMENT_BUDGET,'statements '+calls.queries);
 // Requested by the lid: same Film, same prediction.
 const byLid=await read(file,'l5');
 assert.deepEqual([byLid.body.identity.verdict,byLid.body.predictions.status,byLid.body.history.href],['found','present','/api/enrichment/history?filmId=l5']);
 // film: and redirected requests never advertise the legacy history route.
 const byFilm=await read(file,'film:tmdb:5');
 assert.deepEqual([byFilm.body.history.status,byFilm.body.history.href],['unavailable',undefined]);
 // Test 18 / predictions none: no pointer under any authorized key and complete coverage.
 const none=world();
 const noneOut=await read(none,'tmdb_5');
 assert.deepEqual([noneOut.body.predictions.status,noneOut.body.predictions.reason,noneOut.body.predictions.current],['absent','none',[]]);
}

// Test 2 / 24: one Film with two authorized lids. One ratings fact reachable through both is counted once; differing current predictions and ratings are
// conflict; history unavailable. A fact redirect reached from two seeds is counted once.
{
 const file=world({lids:['a1','a2']});
 pointer(file,'a1',3);pointer(file,'a2',4);
 const out=await read(file,'tmdb_5');
 assert.equal(out.body.predictions.status,'conflict');
 assert.deepEqual(out.body.predictions.current.map(p=>p.storageId),['a1','a2']);
 assert.equal(out.body.personal.fields.rating.status,'present','one fact (tmdb-5) through three aliases is one value, not a conflict');
 assert.deepEqual(out.body.personal.fields.rating.storageIds,['a1','a2','tmdb_5']);
 assert.deepEqual([out.body.history.status,out.body.history.reason,out.body.history.href],['unavailable','history_migration_pending',undefined]);
 // Two distinct facts under two aliases with different ratings: conflict, both values with their storage ids, no winner.
 const split=world({lids:['b1','b2'],links:{'tmdb:5':'tmdb-5','letterboxd:b1':'tmdb-5','letterboxd:b2':'lb-b2'}});
 putRecord(split,'lb-b2',{letterboxd:'b2'});
 view(split,'b2','lb-b2',{watched:1,rating:2,known:1});
 const conflict=await read(split,'tmdb_5');
 assert.equal(conflict.body.personal.status,'conflict');
 assert.equal(conflict.body.personal.fields.rating.status,'conflict');
 assert.deepEqual(conflict.body.personal.fields.rating.values.map(v=>v.value).sort(),[2,4]);
 // Equal predictions under two aliases with complete coverage follow C2: present, both storage ids listed.
 const equal=world({lids:['e1','e2']});pointer(equal,'e1',3);pointer(equal,'e2',3);
 const eq=await read(equal,'tmdb_5');
 assert.deepEqual([eq.body.predictions.status,eq.body.predictions.current.length],['present',2]);
 // Test 24: a fact redirect reached from two seeds is followed once and counted once.
 const redirected=world({lids:['r1'],links:{'tmdb:5':'old-1','letterboxd:r1':'old-1','letterboxd:zz':'new-1'},records:false});
 putRecord(redirected,'old-1',{letterboxd:'r1',tmdb:'5'},{redirectTo:'new-1'});
 putRecord(redirected,'new-1',{letterboxd:'zz'});
 const r=await read(redirected,'tmdb_5');
 assert.equal(r.body.predictions.coverage.candidates,1,'the alias of the redirect target is one candidate');
 assert.equal(r.body.predictions.coverage.reason,'unresolved_candidate');
 assert.equal(Object.keys(r.body.predictions.coverage.token.records).length,2,'each record once');
}

// Test 3: a rated-only Film with no shows: availability present with an empty current list; the Film is found.
{
 const file=world();
 const out=await read(file,'tmdb_5');
 assert.deepEqual([out.body.identity.verdict,out.body.availability.status,out.body.availability.current],['found','present',[]]);
 assert.deepEqual(Object.keys(out.body.availability.token).sort(),['generation','programmeRunId','shows']);
 show(file,'l5',1000);show(file,'tmdb_5',2000,'ch2');
 const shows=await read(file,'tmdb_5');
 assert.deepEqual(shows.body.availability.current.map(s=>[s.storageId,s.startMs]),[['l5',1000],['tmdb_5',2000]]);
 // A show of a retired movie key is never read: the TV Film's retired movie claim is in no alias set (test 5 of the resolver, here for the section).
 const tv=blank();
 film(tv,'film:tmdb:123',[['tmdb','123'],['tmdb_tv','123'],['letterboxd','tvA']]);retire(tv,'film:tmdb:123','123','123','tvA');
 show(tv,'tmdb_123',500);pointer(tv,'tmdb_123',5);
 const tvOut=await read(tv,'tmdb_tv:123');
 assert.deepEqual(tvOut.body.availability.current,[],'the retired movie key is never read');
 assert.ok(!tvOut.body.predictions.current?.length,'nor its prediction');
}

// Test 4: left the Watchlist and re-added: the source follows the version; the Film is retained in between.
{
 const file=world();
 watchlist(file,['l5']);
 const in1=await read(file,'tmdb_5');
 assert.deepEqual([in1.body.watchlist.status,in1.body.watchlist.source.member,in1.body.watchlist.source.lids],['present',true,['l5']]);
 const v1=in1.body.watchlist.source.version;
 watchlist(file,['other']);
 const out=await read(file,'tmdb_5');
 assert.deepEqual([out.body.identity.verdict,out.body.watchlist.source.member],['found',false],'retained Film, proved not a member');
 watchlist(file,['l5','other']);
 const back=await read(file,'tmdb_5');
 assert.equal(back.body.watchlist.source.member,true);
 assert.equal(back.body.watchlist.source.version,v1+2);
}

// Test 9: ratings domain held: personal unavailable; predictions keep authorized values with coverage incomplete (partial, or conflict when they disagree);
// sections that do not depend on ratings are unaffected.
{
 const file=world({lids:['h1','h2']});
 pointer(file,'h1',3);
 watchlist(file,['h1']);
 sqlite(file,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 const out=await read(file,'tmdb_5');
 assert.deepEqual([out.body.personal.status,out.body.personal.reason],['unavailable','ratings_held']);
 assert.deepEqual([out.body.predictions.status,out.body.predictions.coverage.status,out.body.predictions.coverage.reason],['partial','incomplete','ratings_evidence_unavailable']);
 assert.deepEqual(out.body.predictions.current.map(p=>p.storageId),['h1'],'authorized values are returned as read');
 assert.equal(out.body.watchlist.source.member,true);
 assert.equal(out.body.availability.status,'present');
 pointer(file,'h2',4);
 assert.equal((await read(file,'tmdb_5')).body.predictions.status,'conflict','test 23: a known conflict is never erased by incomplete coverage');
}

// Test 10 / 25 / 15b: a token moves during the read: that section is unavailable generation_moved; others stay; a canonical claim change is identity_moved.
{
 const moving=(file,predicate,mutate)=>{let done=false;return env(file,{onQuery:text=>{if(!done&&predicate(text)){done=true;mutate();}}});};
 // EPG generation moves after the availability read.
 const epg=world();show(epg,'l5',1000);
 const e1=moving(epg,t=>t.includes('FROM owner_review_entry'),()=>sqlite(epg,"UPDATE published_epg_authority SET generation=generation+1 WHERE id=1"));
 const o1=await readFilmAggregate(e1,'tmdb_5');
 assert.deepEqual([o1.http,o1.body.availability.status,o1.body.availability.reason],[200,'unavailable','generation_moved']);
 assert.notEqual(o1.body.predictions.status,'unavailable');
 // Test 15b: a show row changes (Discovery assigns a show) without a generation move: availability unavailable.
 const rows=world();show(rows,'l5',1000);
 const e2=moving(rows,t=>t.includes('FROM owner_review_entry'),()=>show(rows,'tmdb_5',3000));
 const o2=await readFilmAggregate(e2,'tmdb_5');
 assert.deepEqual([o2.body.availability.status,o2.body.availability.reason],['unavailable','generation_moved']);
 // Test 25: the link index changes during the read: personal and predictions unavailable generation_moved; other sections stay.
 const link=world();pointer(link,'l5',3);
 const e3=moving(link,t=>t.includes('FROM prediction_pointer'),()=>putLinks(link,{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:x9':'tmdb-5'}));
 const o3=await readFilmAggregate(e3,'tmdb_5');
 assert.deepEqual([o3.body.personal.status,o3.body.personal.reason,o3.body.predictions.status,o3.body.predictions.reason],['unavailable','generation_moved','unavailable','generation_moved']);
 assert.equal(o3.body.availability.status,'present');
 // Test 15b: a fact record's content changes without a marker move (a direct etag change): the ratings sections fail.
 const rec=world();
 const e4=moving(rec,t=>t.includes('FROM prediction_pointer'),()=>putRecord(rec,'tmdb-5',{letterboxd:'l5',tmdb:'5'},{note:'x'}));
 assert.equal((await readFilmAggregate(e4,'tmdb_5')).body.personal.reason,'generation_moved');
 // Test 15b: a prediction pointer content changes without a generation move.
 const pc=world();pointer(pc,'l5',3);
 const e5=moving(pc,t=>t.includes('FROM watchlist_authority'),()=>pointer(pc,'l5',3,{sha:'e'.repeat(64)}));
 assert.deepEqual([(await readFilmAggregate(e5,'tmdb_5')).body.predictions.reason],['generation_moved']);
 // Test 25 (G1): a canonical claim changes during the read: 503 identity_moved, no section.
 const id=world();
 const e6=moving(id,t=>t.includes('FROM published_epg_show'),()=>claim(id,'film:tmdb:5','letterboxd','late1'));
 const o6=await readFilmAggregate(e6,'tmdb_5');
 assert.deepEqual([o6.http,o6.body.identity.reason,Object.keys(o6.body).sort()],[503,'identity_moved',['contract','identity']]);
 // Test 8 for the full aggregate: a merge during the sections.
 const merge=world();film(merge,'film:other:1');
 const e7=moving(merge,t=>t.includes('FROM watchlist_authority'),()=>sqlite(merge,`INSERT INTO film_redirect VALUES ('film:tmdb:5','film:other:1','${AT}')`));
 assert.deepEqual([(await readFilmAggregate(e7,'tmdb_5')).http],[503]);
}

// Test 11: owner review changes during the read: display unavailable generation_moved. Test 12: partial metadata: missing fields unknown.
{
 const file=world();
 metadata(file,'film:tmdb:5',{year:1999,genres:['Drama']});
 ownerTitle(file,'k1','film:tmdb:5','Owner Title');
 const out=await read(file,'tmdb_5');
 // The owner ancestry of the redirect tree is complete here (no Film was merged into this one): the title is proven.
 assert.deepEqual([out.body.display.fields.title.status,out.body.display.fields.title.value,out.body.display.fields.title.provenance,out.body.display.fields.title.reason],['present','Owner Title','owner',undefined]);
 assert.deepEqual(out.body.display.ancestry,{status:'complete',films:0,depth:0});
 assert.ok(out.body.display.token.ancestry.startsWith('sha256:'));
 // Test 12: no per-field provenance is delivered (ADR 0214 PF): a missing or null field is unknown, never absent.
 for(const name of ['runtime','synopsis','poster','url'])assert.equal(out.body.display.fields[name].status,'unknown',name);
 assert.equal(out.body.display.status,'partial');
 assert.ok(out.body.display.token.ownerReview.startsWith('sha256:')&&out.body.display.token.metadata);
 // The owner ancestry (a Film merged into the survivor) is read from the survivor through film_redirect_by_target, whatever alias the request used.
 const merged=world();film(merged,'film:old:5');sqlite(merged,`INSERT INTO film_redirect VALUES ('film:old:5','film:tmdb:5','${AT}')`);
 ownerTitle(merged,'k2','film:old:5','Ancestor Owner');
 for(const alias of ['tmdb_5','l5','film:tmdb:5','film:old:5']){
  const title=(await read(merged,alias)).body.display.fields.title;
  assert.deepEqual([alias,title.status,title.value,title.provenance],[alias,'present','Ancestor Owner','owner']);
 }
 ownerTitle(merged,'k3','film:tmdb:5','Other Owner');
 assert.equal((await read(merged,'film:old:5')).body.display.fields.title.status,'conflict','two owner values: no winner');
 assert.equal((await read(merged,'tmdb_5')).body.display.fields.title.status,'conflict','also from the survivor alias');
 // Test 11.
 const e=env(file,{onQuery:text=>{if(text.includes('FROM ratings_document WHERE part=0'))ownerTitle(file,'k1','film:tmdb:5','Changed');}});
 const moved=await readFilmAggregate(e,'tmdb_5');
 assert.deepEqual([moved.http,moved.body.display.status,moved.body.display.reason],[200,'unavailable','generation_moved']);
 assert.equal(moved.body.predictions.status,'absent');
 // Credits cap: more than 60 credits is partial, never a truncated "complete" list.
 const credits=world();
 const people=Array.from({length:CREDITS_MAX+2},(_,i)=>`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:actor/p${i}','p${i}',1,'${AT}');INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:tmdb:5','person:actor/p${i}','actor',${i});`).join('');
 sqlite(credits,people);
 const c=await read(credits,'tmdb_5');
 assert.deepEqual([c.body.display.credits.status,c.body.display.credits.items.length],['partial',CREDITS_MAX]);
}

// Test 13: a stale membership projection (drained effects with an owed per-Film write): lag true, source.member from the source authority.
{
 const file=world();
 watchlist(file,['l5']);
 const out=await read(file,'tmdb_5');
 assert.deepEqual([out.body.watchlist.source.member,out.body.watchlist.projection.member,out.body.watchlist.lag],[true,false,true]);
 assert.equal(out.body.watchlist.projection.authority,'producer');
 sqlite(file,`INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:tmdb:5','${AT}')`);
 const synced=await read(file,'tmdb_5');
 assert.deepEqual([synced.body.watchlist.projection.member,synced.body.watchlist.lag],[true,false]);
 // Effects not drained for the current version: lag, even when the per-Film rows agree.
 watchlist(file,['l5','x'],{drained:false});
 assert.equal((await read(file,'tmdb_5')).body.watchlist.lag,true);
 // The projection never strengthens the source: producer mode with a projected row and a source that cannot prove membership stays unknown.
 sqlite(file,"UPDATE watchlist_authority SET mode='epg' WHERE id=1");
 const epg=await read(file,'tmdb_5');
 assert.deepEqual([epg.body.watchlist.source.member,epg.body.watchlist.source.reason,epg.body.watchlist.projection.member],['unknown','source_epg_mode',true]);
}

// Test 14: the Watchlist negative proof: each unsettled state gives member unknown with its reason, never false.
{
 const base=()=>{const f=world();watchlist(f,['other','other2']);return f;};
 const member=async(f,id='tmdb_5')=>{const b=(await read(f,id)).body.watchlist.source;return [b.member,b.reason??null];};
 assert.deepEqual(await member(base()),[false,null],'complete snapshot, every lid checked, nothing unsettled: false');
 // Empty alias set: a Film with only a TV identity.
 const tv=blank();film(tv,'film:tv:9',[['tmdb_tv','9']]);watchlist(tv,['other']);
 assert.deepEqual(await member(tv,'tmdb_tv:9'),['unknown','no_verified_alias']);
 const epg=base();sqlite(epg,"UPDATE watchlist_authority SET mode='epg' WHERE id=1");
 assert.deepEqual(await member(epg),['unknown','source_epg_mode']);
 // A pending admission in backoff (not yet due) for an unrelated listed lid.
 const backoff=base();sqlite(backoff,`INSERT INTO watchlist_admission_pending (lid,first_seen_snapshot_id,first_seen_version,state,attempts,next_retry_at,updated_at) VALUES ('other','s',1,'pending',3,'2099-01-01T00:00:00.000Z','${AT}')`);
 assert.deepEqual(await member(backoff),['unknown','unresolved_listed_ids']);
 const terminal=base();sqlite(terminal,`INSERT INTO watchlist_admission_pending (lid,first_seen_snapshot_id,first_seen_version,state,attempts,updated_at) VALUES ('other2','s',1,'terminal',9,'${AT}')`);
 assert.deepEqual(await member(terminal),['unknown','unresolved_listed_ids']);
 // Resolved and superseded admissions settle.
 const resolved=base();sqlite(resolved,`INSERT INTO watchlist_admission_pending (lid,first_seen_snapshot_id,first_seen_version,state,attempts,updated_at) VALUES ('other','s',1,'resolved',1,'${AT}'),('other2','s',1,'superseded',1,'${AT}')`);
 assert.deepEqual(await member(resolved),[false,null]);
 // A handoff row of any due time and attempt count.
 for(const [state,due] of [['pending','2099-01-01T00:00:00.000Z'],['pending',null],['terminal',null]]){
  const handoff=base();sqlite(handoff,`INSERT INTO watchlist_membership_handoff (lid,first_version,state,attempts,next_retry_at,updated_at) VALUES ('other',1,'${state}',0,${q(due)},'${AT}')`);
  assert.deepEqual(await member(handoff),['unknown','unresolved_listed_ids'],state);
 }
 // Incomplete snapshot: a member row missing for the recorded count.
 const incomplete=base();sqlite(incomplete,"DELETE FROM watchlist_member WHERE lid='other2'");
 assert.deepEqual(await member(incomplete),['unknown','snapshot_incomplete']);
 // No snapshot at all.
 const empty=world();
 assert.deepEqual(await member(empty),['unknown','snapshot_incomplete']);
 // Held writes are not served.
 const held=base();sqlite(held,"UPDATE watchlist_authority SET writes='held' WHERE id=1");
 assert.deepEqual(await member(held),['unknown','source_held']);
}

// Test 15: budgets. Identity fan-out: 409 with no section. The statement limit: unread sections unavailable budget_exceeded, the identity capture still
// runs, and the real D1 statements never exceed the budget. Shows over the cap: availability partial. Alias overflow: partial. None gives a negative.
{
 const file=world();pointer(file,'l5',3);watchlist(file,['l5']);
 let fullStatements=null;
 for(let limit=4;limit<=REQUEST_STATEMENT_BUDGET;limit++){
  const e=env(file);
  const out=await readFilmAggregate(e,'tmdb_5',{budgetLimit:limit});
  assert.ok(e.calls.queries+e.calls.statements<=limit,limit+': '+(e.calls.queries+e.calls.statements));
  if(out.http!==200){assert.deepEqual([out.http,out.body.identity.reason,Object.keys(out.body).sort()],[503,'budget_exceeded',['contract','identity']]);continue;}
  for(const name of ['display','watchlist','availability','personal','predictions']){
   const section=out.body[name];
   assert.ok(section&&section.status,name+' always reported');
   if(section.status==='unavailable')assert.ok(['budget_exceeded'].includes(section.reason),limit+' '+name+' '+section.reason);
   assert.notEqual(section.status,'absent',limit+' '+name+': never a negative under a budget');
  }
  if(out.body.predictions.status==='present'&&fullStatements===null)fullStatements=limit;
 }
 const full=env(file);await readFilmAggregate(full,'tmdb_5');
 assert.ok(full.calls.queries<=REQUEST_STATEMENT_BUDGET-10,'a typical aggregate leaves headroom: '+full.calls.queries+' statements');
 if(process.env.FILM_AGGREGATE_REPORT)console.log('statements',full.calls.queries);
 // Shows over the cap.
 const many=world();
 for(let i=0;i<=CURRENT_SHOWS_MAX;i++)show(many,'l5',1000+i);
 const shows=await read(many,'tmdb_5');
 assert.deepEqual([shows.body.availability.status,shows.body.availability.current.length,shows.body.availability.reason],['partial',CURRENT_SHOWS_MAX,'shows_limit']);
 // More than 8 authorized lids: partial, budget_exceeded, never none.
 const lids=Array.from({length:9},(_,i)=>'m'+i);
 const wide=world({lids});
 const w=await read(wide,'tmdb_5');
 assert.deepEqual([w.body.predictions.status,w.body.predictions.reason],['partial','budget_exceeded']);
 assert.deepEqual([w.body.availability.status,w.body.availability.reason],['partial','budget_exceeded']);
 // Identity fan-out: 409 with no section.
 const fan=blank();
 film(fan,'film:f:1',[['tmdb','1']]);
 for(let i=0;i<65;i++)claim(fan,'film:f:1','letterboxd_slug','s'+i,0);
 const f=await read(fan,'tmdb_1');
 assert.deepEqual([f.http,f.body.identity.reason,Object.keys(f.body).sort()],[409,'identity_fanout',['contract','identity']]);
}

// Test 15a for the full aggregate: the final identity capture cannot run (a failure of the fence read): 503 with no section.
{
 const file=world();
 let sections=false;
 const e=env(file,{onQuery:text=>{if(text.includes('FROM published_epg_show'))sections=true;else if(sections&&text.includes('film_person_authority WHERE id=1')&&text.includes("'rows'"))throw new Error('D1_ERROR: storage operation exceeded');}});
 const out=await readFilmAggregate(e,'tmdb_5');
 assert.deepEqual([out.http,Object.keys(out.body).sort()],[503,['contract','identity']]);
}

// Test 16: a missing domain row for one alias only: the section is partial and the other alias's facts stay.
{
 const file=world({lids:['p1','p2']});
 sqlite(file,"DELETE FROM ratings_view WHERE alias_id='p2'");
 const out=await read(file,'tmdb_5');
 assert.equal(out.body.personal.status,'partial');
 assert.deepEqual(out.body.personal.missingAliases,['p2']);
 assert.deepEqual(out.body.personal.fields.rating.values.map(v=>v.value),[4]);
 // watched:false only from watched=0 rows over every alias with complete coverage; a missing row never gives false.
 const not=world();view(not,'tmdb_5','tmdb-5',{watched:0,known:1});view(not,'l5','tmdb-5',{watched:0,known:1});
 const n1=await read(not,'tmdb_5');
 assert.deepEqual([n1.body.personal.fields.watched.status,n1.body.personal.fields.watched.value],['present',false]);
 assert.equal(n1.body.personal.fields.rating.status,'absent','a known null rating over every alias is no rating');
 sqlite(not,"DELETE FROM ratings_view WHERE alias_id='l5'");
 assert.equal((await read(not,'tmdb_5')).body.personal.fields.watched.status,'partial');
}

// Tests 19-23: candidate coverage. A candidate key is never attributed; unproved coverage never yields none or "no conflict"; a known conflict is kept.
{
 // 19: a bridge-only pointer, no authorized key carries a pointer: partial, unresolved_candidate, the candidate's value is not returned.
 const bridge=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:hist1':'tmdb-5'}});
 pointer(bridge,'hist1',4.5);
 const b=await read(bridge,'tmdb_5');
 assert.deepEqual([b.body.predictions.status,b.body.predictions.coverage.reason,b.body.predictions.current],['partial','unresolved_candidate',[]]);
 assert.ok(!JSON.stringify(b.body.predictions).includes('4.5'),'the candidate value is never returned');
 assert.deepEqual(b.body.predictions.coverage.notes,[{candidate:'letterboxd:hist1',state:'unresolved'}]);
 assert.equal(b.body.personal.status,'partial','personal is never complete with an unresolved candidate');
 assert.deepEqual([b.body.personal.fields.rating.status,b.body.personal.fields.rating.values.map(v=>v.value)],['partial',[4]],'no single current value while a candidate is unresolved');
 // 20: an authorized pointer plus an unresolved candidate, equal or different value: partial, never a silent single value.
 for(const value of [3,4]){
  const f=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:hist2':'tmdb-5'}});
  pointer(f,'l5',3);pointer(f,'hist2',value);
  const o=await read(f,'tmdb_5');
  assert.deepEqual([o.body.predictions.status,o.body.predictions.current.map(p=>p.storageId)],['partial',['l5']],String(value));
 }
 // A candidate settled elsewhere by another Film's single trusted claim: coverage complete.
 const settled=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:own2':'tmdb-5'}});
 film(settled,'film:other:2',[['letterboxd','own2']]);
 const s=await read(settled,'tmdb_5');
 assert.deepEqual([s.body.predictions.coverage.status,s.body.predictions.status],['complete','absent']);
 // ... but not when that claim is untrusted, conflicting, competing, on a redirect source, or a retired movie id.
 const unsettle=[
  f=>{film(f,'film:other:2',[['letterboxd','own2',0]]);},
  f=>{film(f,'film:other:2',[['letterboxd','own2',1,1]]);},
  f=>{film(f,'film:other:2',[['letterboxd','own2']]);film(f,'film:other:3',[['letterboxd','own2',0]]);},
  f=>{film(f,'film:other:2',[['letterboxd','own2']]);film(f,'film:other:4');sqlite(f,`INSERT INTO film_redirect VALUES ('film:other:2','film:other:4','${AT}')`);},
 ];
 for(const [i,setup] of unsettle.entries()){
  const f=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:own2':'tmdb-5'}});setup(f);
  assert.equal((await read(f,'tmdb_5')).body.predictions.coverage.reason,'unresolved_candidate','unsettled '+i);
 }
 const retiredMovie=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','tmdb:77':'tmdb-5'}});
 film(retiredMovie,'film:other:77',[['tmdb','77'],['letterboxd','lx']]);retire(retiredMovie,'film:other:77','77','7700','lx');
 assert.equal((await read(retiredMovie,'tmdb_5')).body.predictions.coverage.reason,'unresolved_candidate','a retired movie claim proves no ownership');
 // The settlement is revalidated after the reads: a competing claim appearing mid-read fails the ratings sections.
 const mid=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:own2':'tmdb-5'}});
 film(mid,'film:other:2',[['letterboxd','own2']]);film(mid,'film:other:5');
 const e=env(mid,{onQuery:t=>{if(t.includes('FROM prediction_pointer'))claim(mid,'film:other:5','letterboxd','own2',0);}});
 const o=await readFilmAggregate(e,'tmdb_5');
 assert.deepEqual([o.body.predictions.status,o.body.predictions.reason],['unavailable','generation_moved']);
 // 21: after a fully proved ADR 0184 promotion in the fixture (the key is a trusted claim of the survivor): authorized; different values give conflict.
 const promoted=world({lids:['l5','hist3'],links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:hist3':'tmdb-5'}});
 pointer(promoted,'l5',3);pointer(promoted,'hist3',4);
 const p=await read(promoted,'tmdb_5');
 assert.deepEqual([p.body.predictions.status,p.body.predictions.coverage.status],['conflict','complete']);
 // ... a promotion that did not happen (untrusted claim of the survivor) is no authorization: the resolver refuses the unsettled claim.
 const failed=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:hist4':'tmdb-5'}});
 claim(failed,'film:tmdb:5','letterboxd','hist4',0);
 assert.deepEqual([(await read(failed,'tmdb_5')).http],[409]);
 // 23: a known conflict between two authorized pointers while coverage is incomplete: conflict, not partial.
 const known=world({lids:['k1','k2'],links:{'tmdb:5':'tmdb-5','letterboxd:k1':'tmdb-5','letterboxd:k2':'tmdb-5','letterboxd:hist5':'tmdb-5'}});
 pointer(known,'k1',2);pointer(known,'k2',5);
 const k=await read(known,'tmdb_5');
 assert.deepEqual([k.body.predictions.status,k.body.predictions.coverage.status],['conflict','incomplete']);
}

// Test 22: every incomplete-coverage cause gives its reason and never none.
{
 const reason=async(f,id='tmdb_5')=>{const o=(await read(f,id)).body.predictions;assert.notEqual(o.status,'absent');return o.coverage.reason;};
 // Empty seed set: a TV-only Film (no lid, no movie claim).
 const tv=blank();film(tv,'film:tv:3',[['tmdb_tv','3']]);putLinks(tv,{});
 assert.equal((await read(tv,'tmdb_tv:3')).body.predictions.status,'unknown','no authorized storage id: unknown, never none');
 // A seed missing from the index.
 assert.equal(await reason(world({links:{'tmdb:5':'tmdb-5'}})),'seed_absent_unproved');
 // Missing link document.
 const missing=world();sqlite(missing,"DELETE FROM ratings_document WHERE key='letterboxd/facts/links.json'");
 assert.equal(await reason(missing),'ratings_evidence_unavailable');
 // Unreadable link document (etag does not match its text).
 const bad=world();sqlite(bad,"UPDATE ratings_document SET body=body||' ' WHERE key='letterboxd/facts/links.json'");
 assert.equal(await reason(bad),'ratings_evidence_unavailable');
 // Missing fact record.
 assert.equal(await reason(world({records:false})),'ratings_evidence_unavailable');
 // More than 40 parts: refused BEFORE the document is materialized (no read of its parts).
 const big=world();
 const index={'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5'};
 for(let i=0;i<300;i++)index['letterboxd:pad'+i]='lb-pad'+i;
 putDocument(big,'letterboxd/facts/links.json',index,{partBytes:Math.ceil(JSON.stringify(index).length/(LINK_DOCUMENT_MAX_PARTS+1))});
 let partsRead=0;
 const e=env(big,{onQuery:t=>{if(t.includes('SELECT key,part,body,etag')&&t.includes('links.json'))partsRead++;}});
 const o=await readFilmAggregate(e,'tmdb_5');
 assert.deepEqual([o.body.predictions.coverage.reason,partsRead],['discovery_cap',0]);
 // More than 50 000 entries walked.
 const wide=world();
 const huge={'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5'};
 for(let i=0;i<LINK_INDEX_MAX_ENTRIES;i++)huge['x:'+i]='y';
 putDocument(wide,'letterboxd/facts/links.json',huge,{partBytes:60000});
 assert.equal(await reason(wide),'discovery_cap');
 // More than 4 fact records: five distinct seed keys.
 const records=world({lids:['f1','f2','f3','f4'],links:{'tmdb:5':'k0','letterboxd:f1':'k1','letterboxd:f2':'k2','letterboxd:f3':'k3','letterboxd:f4':'k4'},records:false});
 for(const key of ['k0','k1','k2','k3','k4'])putRecord(records,key,{letterboxd:'f1'});
 assert.equal(FACT_RECORDS_MAX,4);
 assert.equal(await reason(records),'discovery_cap');
 // More than 8 candidates.
 const crowd={'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5'};
 for(let i=0;i<=CANDIDATES_MAX;i++)crowd['letterboxd:c'+i]='tmdb-5';
 assert.equal(await reason(world({links:crowd})),'discovery_cap');
 // A held ratings domain.
 const held=world();sqlite(held,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 assert.equal(await reason(held),'ratings_evidence_unavailable');
 // A redirect chain longer than one hop.
 const chained=world({links:{'tmdb:5':'a','letterboxd:l5':'a'},records:false});
 putRecord(chained,'a',{letterboxd:'l5',tmdb:'5'},{redirectTo:'b'});putRecord(chained,'b',{letterboxd:'l5'},{redirectTo:'c'});putRecord(chained,'c',{letterboxd:'l5'});
 assert.equal(await reason(chained),'discovery_cap');
 // A mid-migration record counts both sides.
 const migrating=world({links:{'tmdb:5':'m1','letterboxd:l5':'m1','letterboxd:side':'m2'},records:false});
 putRecord(migrating,'m1',{letterboxd:'l5',tmdb:'5'},{migrating:{to:'m2'}});putRecord(migrating,'m2',{letterboxd:'side'});
 const m=await read(migrating,'tmdb_5');
 assert.deepEqual([m.body.predictions.coverage.reason,m.body.predictions.coverage.notes],['unresolved_candidate',[{candidate:'letterboxd:side',state:'unresolved'}]]);
}

// Identity verdicts other than found/redirected return no section (invariant 5), through the full aggregate.
{
 const file=world();
 film(file,'film:u:1',[['letterboxd','unv',0]]);
 for(const [id,http] of [['tmdb_999',404],['unv',409],['not a lid!',400]]){
  const o=await read(file,id);
  assert.deepEqual([o.http,Object.keys(o.body).sort()],[http,['contract','identity']],id);
 }
}

// Test 17: the dormant route is a pure read (ADR 0107): GET and HEAD of every verdict write nothing (database byte-identical, every executed statement is
// a SELECT), touch neither R2 nor the network; other methods are 405 and write nothing. The sections' binding refuses any non-SELECT before it runs.
{
 const file=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:hist1':'tmdb-5'}});
 pointer(file,'l5',3);watchlist(file,['l5']);show(file,'l5',1000);metadata(file,'film:tmdb:5',{year:2001});
 const before=fileSha(file),executed=[],stats={read:0,written:0};
 const e=env(file,{onQuery:t=>executed.push(t),rowStats:stats});
 for(const id of ['tmdb_5','l5','film:tmdb:5','tmdb_6','bad id','tmdb_tv:1'])for(const method of ['GET','HEAD']){
  const response=await handleFilmAggregateRequest(new Request('https://iptv.test'+FILM_AGGREGATE_ROUTE+'?id='+encodeURIComponent(id),{method}),e);
  assert.ok(response instanceof Response);
  assert.equal(response.headers.get('cache-control'),'no-store');
  if(method==='HEAD')assert.equal(await response.text(),'');
 }
 const ok=await handleFilmAggregateRequest(new Request('https://iptv.test'+FILM_AGGREGATE_ROUTE+'?id=tmdb_5'),e);
 assert.equal(ok.status,200);assert.equal((await ok.json()).identity.verdict,'found');
 assert.equal((await handleFilmAggregateRequest(new Request('https://iptv.test'+FILM_AGGREGATE_ROUTE),e)).status,400);
 assert.equal((await handleFilmAggregateRequest(new Request('https://iptv.test'+FILM_AGGREGATE_ROUTE+'?id=a&id=b'),e)).status,400);
 for(const method of ['POST','PUT','DELETE','PATCH'])assert.equal((await handleFilmAggregateRequest(new Request('https://iptv.test'+FILM_AGGREGATE_ROUTE+'?id=tmdb_5',{method}),e)).status,405);
 assert.equal(await handleFilmAggregateRequest(new Request('https://iptv.test/api/other'),e),null);
 assert.equal(stats.written,0);
 assert.equal(fileSha(file),before,'the database is byte-identical');
 assert.equal(e.calls.batches,0);
 const writes=executed.filter(t=>!/^\s*(WITH\b[\s\S]*?\)\s*)?SELECT\b/i.test(t)||/\b(INSERT|UPDATE|DELETE|REPLACE)\s/i.test(t.replace(/'[^']*'/g,'')));
 assert.deepEqual(writes,[],'only SELECT statements ran');
 // The counted binding refuses a write before it reaches the database.
 const budget=createStatementBudget(5);
 const counted=countedDatabase(e.DB,budget);
 assert.throws(()=>counted.prepare("UPDATE film SET updated_at='x'"),error=>error.code==='aggregate_write_refused');
 await assert.rejects(counted.prepare('SELECT 1').bind().run(),error=>error.code==='aggregate_write_refused');
 assert.equal(budget.used,0,'a refused statement costs nothing');
 assert.ok(!/\b(INSERT\s+INTO|UPDATE\s+[a-z_]+\s+SET|DELETE\s+FROM|REPLACE\s+INTO)\b/i.test(fs.readFileSync('src/film-aggregate.js','utf8').replace(/\/\/.*$/gm,'')),'the module holds no write SQL');
}

// Dormant: the Worker bundle does not contain the aggregate, its route or the resolver, and nothing in src imports them (activation is AIR-648).
{
 const build=fs.readFileSync('build.mjs','utf8');
 for(const name of ['film-aggregate','film-aggregate-resolver','film-readiness','film-readiness-composition'])assert.ok(!build.includes("src/"+name+".js"),name+' stays out of the bundle');
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')&&f!=='film-aggregate.js'&&f!=='film-aggregate-resolver.js'&&f!=='film-history-aggregate.js'&&f!=='film-readiness-composition.js'))
  assert.ok(!/film-aggregate/.test(fs.readFileSync('src/'+name,'utf8')),name+' must not import the dormant aggregate');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes(FILM_AGGREGATE_ROUTE),'the Worker routes no internal film aggregate');
 if(fs.existsSync('dist/server/index.js'))assert.ok(!fs.readFileSync('dist/server/index.js','utf8').includes(FILM_AGGREGATE_ROUTE),'the built bundle does not serve the route');
}

// ---- Review of PR #1004 (owner review at 85783f2f): counterexamples, each as a regression ----
const putRaw=(file,key,text,partBytes=60000)=>{
 const etag=sha256(text),parts=[];
 for(let at=0;at<text.length;at+=partBytes)parts.push(text.slice(at,at+partBytes));
 sqlite(file,`DELETE FROM ratings_document WHERE key=${q(key)};`+parts.map((body,part)=>`INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES (${q(key)},${part},${q(body)},${q(etag)},${q(AT)});`).join(''));
};
const BASE_INDEX={'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5'};
const padded=(value,size)=>{const text=JSON.stringify(value);assert.ok(text.length<=size);return text+' '.repeat(size-text.length);};
// A binding that logs how many PART ROWS (rows that carry a body) each bounded-document statement returned: what the Worker materializes.
function loggedEnv(file,options){
 const e=env(file,options),log=[];
 const DB={calls:e.DB.calls,prepare(sql){const base=e.DB.prepare(sql);return {bind(...params){const st=base.bind(...params);return {text:st.text,first:()=>st.first(),run:()=>st.run(),async all(){const r=await st.all();if(sql.startsWith('WITH g AS'))log.push({text:st.text,bodies:(r.results||[]).filter(x=>x.part!=null).length});return r;}};}};},batch:x=>e.DB.batch(x)};
 return {env:{...e,DB},log};
}
const coverageOf=out=>out.body.predictions.coverage;

// P1 (review 1): the link-document bound is enforced in the statement that materializes it, at the exact boundary, also against a replacement.
{
 // Exactly 40 parts and exactly 2 400 000 bytes: inside the bound, coverage complete.
 const exact=world();putRaw(exact,'letterboxd/facts/links.json',padded(BASE_INDEX,LINK_DOCUMENT_MAX_PARTS*60000));
 assert.equal(rows_(exact,"SELECT COUNT(*) n FROM ratings_document WHERE key='letterboxd/facts/links.json'"),LINK_DOCUMENT_MAX_PARTS);
 const inside=loggedEnv(exact);
 const ok=await readFilmAggregate(inside.env,'tmdb_5');
 assert.equal(coverageOf(ok).status,'complete');
 assert.equal(inside.log.find(l=>l.text.includes('links.json')).bodies,LINK_DOCUMENT_MAX_PARTS,'the 40 parts are read');
 // One byte more: a 41st part. Over the part cap: nothing is materialized.
 const parts=world();putRaw(parts,'letterboxd/facts/links.json',padded(BASE_INDEX,LINK_DOCUMENT_MAX_PARTS*60000+1));
 // 40 parts but one byte over the byte cap (parts of 60 001 bytes).
 const bytes=world();putRaw(bytes,'letterboxd/facts/links.json',padded(BASE_INDEX,LINK_DOCUMENT_MAX_PARTS*60001),60001);
 assert.equal(rows_(bytes,"SELECT COUNT(*) n FROM ratings_document WHERE key='letterboxd/facts/links.json'"),LINK_DOCUMENT_MAX_PARTS);
 for(const [name,file] of [['parts',parts],['bytes',bytes]]){
  const logged=loggedEnv(file);
  const out=await readFilmAggregate(logged.env,'tmdb_5');
  assert.deepEqual([name,coverageOf(out).status,coverageOf(out).reason,out.body.predictions.status],[name,'incomplete','discovery_cap','partial']);
  assert.equal(logged.log.find(l=>l.text.includes('links.json')).bodies,0,name+': no part of an over-cap document is returned to the Worker');
 }
 // A valid LARGER document replaces the small one between the marker read and the document read: it is never materialized and never certified.
 const race=world();
 let replaced=false;
 const logged=loggedEnv(race,{onQuery:text=>{if(!replaced&&text.startsWith('WITH g AS')&&text.includes('links.json')){replaced=true;putRaw(race,'letterboxd/facts/links.json',padded(BASE_INDEX,(LINK_DOCUMENT_MAX_PARTS+1)*60000));}}});
 const raced=await readFilmAggregate(logged.env,'tmdb_5');
 assert.ok(replaced);
 assert.deepEqual([coverageOf(raced).status,coverageOf(raced).reason],['incomplete','discovery_cap']);
 assert.equal(logged.log.find(l=>l.text.includes('links.json')).bodies,0);
 assert.equal(raced.body.predictions.status,'partial');
 // A replacement that stays inside the bound but arrives after the read is caught by the after-statement (etag): generation_moved, never complete.
 const late=world();pointer(late,'l5',3);
 const e=env(late,{onQuery:text=>{if(text.includes('FROM prediction_pointer')&&!text.includes('MARK'))putRaw(late,'letterboxd/facts/links.json',padded(BASE_INDEX,70000),60000);}});
 const lateOut=await readFilmAggregate(e,'tmdb_5');
 assert.equal(lateOut.body.predictions.reason,'generation_moved');
}
function rows_(file,text){const r=sqliteSync(['-json',file],{input:text+';',encoding:'utf8'});return JSON.parse(r.stdout.trim())[0].n;}

// P1 (review 1): the fact-record walk validates shape, key and edges, tracks every root's own chain, and fails closed on anything unproved.
{
 const record=(links,records,{lids=['l5']}={})=>{
  const file=world({lids,links,records:false});
  for(const [key,text] of Object.entries(records))putRaw(file,'letterboxd/facts/films/'+key+'.json',typeof text==='string'?text:JSON.stringify(text));
  return file;
 };
 const good={schemaVersion:1,factKey:'tmdb-5',links:{letterboxd:'l5',tmdb:'5'},redirectTo:null,migrating:null};
 const cases=[
  ['null record','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':'null'})],
  ['primitive record','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':'5'})],
  ['array record','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':'[]'})],
  ['wrong factKey','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,factKey:'tmdb-6'}})],
  ['links not an object','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:'x'}})],
  // Review 2 (8581980): an arbitrary JSON object with a correct etag is not a fact record. `{}` and unrelated objects never certify a traversal.
  ['empty object','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':'{}'})],
  ['unrelated object','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{foo:'bar',n:1}})],
  ['unrelated object with an edge-like field','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{redirectTo:null,migrating:null}})],
  ['links empty','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{}}})],
  // Review 3: a record must name at least one valid identity, and every non-null member is validated by its own type.
  ['links with no identity (both null)','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:null,tmdb:null}}})],
  ['links with no identity (members absent)','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{foo:'l5'}}})],
  ['links with a bad movie id','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:'l5',tmdb:'x5'}}})],
  ['TMDB-only links with a bad movie id','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:null,tmdb:'05'}}})],
  ['movie id as an array coerced to a string','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:'l5',tmdb:['5']}}})],
  ['movie id as an object','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:null,tmdb:{n:5}}}})],
  ['movie id zero','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:null,tmdb:0}}})],
  ['movie id fractional','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:null,tmdb:5.5}}})],
  ['lid as a number','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:5,tmdb:'5'}}})],
  ['lid as an array','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:['l5'],tmdb:'5'}}})],
  ['lid spelled tmdb_<n>','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:'tmdb_5',tmdb:'5'}}})],
  ['lid with a space','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,links:{letterboxd:'a b',tmdb:'5'}}})],
  ['unknown schemaVersion','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,schemaVersion:2}})],
  ['no links but a factKey','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{factKey:'tmdb-5'}})],
  ['self redirect A->A','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,redirectTo:'tmdb-5'}})],
  ['cycle A->B->A','incomplete','ratings_evidence_unavailable',record({'tmdb:5':'a','letterboxd:l5':'a'},{a:{...good,factKey:'a',redirectTo:'b'},b:{...good,factKey:'b',redirectTo:'a'}})],
  ['redirect and migration','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,redirectTo:'x',migrating:{to:'y'}}})],
  ['migration without target','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,migrating:{}}})],
  ['malformed hop key','incomplete','ratings_evidence_unavailable',record(BASE_INDEX,{'tmdb-5':{...good,redirectTo:'a b'}})],
  // Two seeds on different ends of a chain: seed one reaches a->b, seed two starts at b->c. The chain of the first root is two hops, whatever the other reads.
  ['second hop hidden by another seed','incomplete','discovery_cap',record({'tmdb:5':'a','letterboxd:s1':'a','letterboxd:s2':'b'},{a:{...good,factKey:'a',redirectTo:'b'},b:{...good,factKey:'b',redirectTo:'c'},c:{...good,factKey:'c'}},{lids:['s1','s2']})],
  ['two hops from one seed','incomplete','discovery_cap',record({'tmdb:5':'a','letterboxd:l5':'a'},{a:{...good,factKey:'a',redirectTo:'b'},b:{...good,factKey:'b',redirectTo:'c'},c:{...good,factKey:'c'}})],
  ['hop target read counts against the record cap','incomplete','discovery_cap',record({'tmdb:5':'a','letterboxd:s1':'b','letterboxd:s2':'c','letterboxd:s3':'d'},{a:{...good,factKey:'a',redirectTo:'e'},b:{...good,factKey:'b'},c:{...good,factKey:'c'},d:{...good,factKey:'d'},e:{...good,factKey:'e'}},{lids:['s1','s2','s3']})],
 ];
 for(const [name,status,reason,file] of cases){
  const out=await read(file,'tmdb_5');
  assert.deepEqual([name,out.http,coverageOf(out).status,coverageOf(out).reason],[name,200,status,reason]);
  assert.ok(['partial','conflict'].includes(out.body.predictions.status),name+': never a negative');
  assert.notEqual(out.body.personal.status,'present',name);
  assert.equal(out.body.predictions.current?.length??0,0,name);
  assert.deepEqual([out.body.history.status,out.body.history.href],['unavailable',undefined],name+': no history href from uncertified evidence');
 }
 // Review 3: the TMDB-only record the owner's watched mark writes (ADR 0032, `letterboxd: null`) is a legitimate record. A movie-only Film (its one authorized
 // alias is the movie claim) with a complete link index and that record has complete coverage and shows the owner's known watched state. LID-only and both
 // identities stay valid.
 const movieOnly=blank();
 film(movieOnly,'film:tmdb:7',[['tmdb','7']]);
 putLinks(movieOnly,{'tmdb:7':'tmdb-7'});
 putRaw(movieOnly,'letterboxd/facts/films/tmdb-7.json',JSON.stringify({schemaVersion:1,factKey:'tmdb-7',links:{letterboxd:null,tmdb:'7'},redirectTo:null,migrating:null,watched:{value:true,effectiveOn:null,observedAt:AT,source:'owner',sourceRef:null,observationId:'o1',replaced:null}}));
 view(movieOnly,'tmdb_7','tmdb-7',{watched:1,known:0});
 const movie=await read(movieOnly,'tmdb_7');
 assert.equal(movie.body.identity.verdict,'found');
 assert.deepEqual([coverageOf(movie).status,coverageOf(movie).reason],['complete',undefined],'a TMDB-only record does not degrade coverage');
 assert.deepEqual([movie.body.personal.fields.watched.status,movie.body.personal.fields.watched.value,movie.body.personal.fields.watched.storageIds],['present',true,['tmdb_7']],'the known owner watched state is not hidden behind partial');
 assert.equal(movie.body.personal.fields.rating.status,'unknown','no rating fact is observed: unknown, never absent');
 assert.deepEqual([movie.body.predictions.status,movie.body.predictions.reason],['absent','none']);
 for(const links of [{letterboxd:'l5',tmdb:null},{letterboxd:'l5'},{letterboxd:'l5',tmdb:5},{letterboxd:'l5',tmdb:'5'}]){
  const f=record(BASE_INDEX,{'tmdb-5':{...good,links}});
  assert.equal(coverageOf(await read(f,'tmdb_5')).status,'complete',JSON.stringify(links));
 }
 // The documented legacy tolerances: a record with no factKey and no schemaVersion but a links object is a record (as the ADR 0184 planner reads it).
 const legacy=record(BASE_INDEX,{'tmdb-5':{links:{letterboxd:'l5',tmdb:5}}});
 assert.equal(coverageOf(await read(legacy,'tmdb_5')).status,'complete');
 // One redirect hop is still followed, both sides counted; a record that carries no factKey is read as the ADR 0184 planner reads it.
 const one=record({'tmdb:5':'a','letterboxd:l5':'a','letterboxd:zz':'b'},{a:{links:{letterboxd:'l5',tmdb:'5'},redirectTo:'b'},b:{...good,factKey:'b'}});
 const hop=await read(one,'tmdb_5');
 assert.deepEqual([coverageOf(hop).reason,coverageOf(hop).notes],['unresolved_candidate',[{candidate:'letterboxd:zz',state:'unresolved'}]]);
 // The same hop from two roots is read once and followed once per root.
 const shared=record({'tmdb:5':'a','letterboxd:s1':'a','letterboxd:s2':'a2'},{a:{...good,factKey:'a',redirectTo:'t'},a2:{...good,factKey:'a2',redirectTo:'t'},t:{...good,factKey:'t'}},{lids:['s1','s2']});
 const sharedOut=await read(shared,'tmdb_5');
 assert.equal(Object.keys(coverageOf(sharedOut).token.records).length,3);
 assert.equal(coverageOf(sharedOut).status,'complete');
 // Fact-record size: exactly 8 parts is read, 9 is not materialized.
 const exact=record(BASE_INDEX,{'tmdb-5':padded(good,FACT_RECORD_MAX_PARTS*60000)});
 assert.equal(coverageOf(await read(exact,'tmdb_5')).status,'complete');
 const big=record(BASE_INDEX,{'tmdb-5':padded(good,FACT_RECORD_MAX_PARTS*60000+1)});
 const logged=loggedEnv(big);
 const bigOut=await readFilmAggregate(logged.env,'tmdb_5');
 assert.deepEqual([coverageOf(bigOut).status,coverageOf(bigOut).reason],['incomplete','discovery_cap']);
 assert.equal(logged.log.find(l=>l.text.includes('films/tmdb-5.json')).bodies,0,'an over-cap record is not materialized');
}

// P1 (review 2): alias overflow and unknown per-alias facts never produce a negative.
{
 const lids=Array.from({length:AUTHORIZED_ALIASES_PER_SCHEME+1},(_,i)=>'m'+i);
 const omitted=lids[AUTHORIZED_ALIASES_PER_SCHEME];
 // Only the omitted ninth lid is listed: the eight read lids are not listed, and that is not proof that none is.
 const file=world({lids});
 watchlist(file,[omitted]);
 const out=await read(file,'tmdb_5');
 assert.deepEqual([out.body.watchlist.status,out.body.watchlist.source.member,out.body.watchlist.source.reason],['unknown','unknown','alias_overflow']);
 assert.deepEqual([coverageOf(out).status,coverageOf(out).reason,coverageOf(out).skippedAliases],['incomplete','discovery_cap',true]);
 assert.equal(out.body.predictions.status,'partial');
 assert.notEqual(out.body.personal.fields.watched.status,'absent');
 assert.equal(out.body.personal.status,'partial');
 // A checked lid that IS listed proves membership even with an overflow (the section is still partial, never complete).
 const listed=world({lids});watchlist(listed,['m0']);
 const yes=await read(listed,'tmdb_5');
 assert.deepEqual([yes.body.watchlist.source.member,yes.body.watchlist.status],[true,'partial']);
 // Eight lids exactly: no overflow, the negative stays provable.
 const eight=world({lids:lids.slice(0,AUTHORIZED_ALIASES_PER_SCHEME)});watchlist(eight,['other']);
 assert.equal((await read(eight,'tmdb_5')).body.watchlist.source.member,false);
 // Overflow of the movie scheme alone affects the storage-id sections, not the Watchlist (which reads lids).
 // Mixed negative and unknown rows on two distinct fact keys.
 const mixed=()=>{const f=world({lids:['x1','x2'],links:{'tmdb:5':'tmdb-5','letterboxd:x1':'tmdb-5','letterboxd:x2':'lb-x2'}});putRecord(f,'lb-x2',{letterboxd:'x2'});view(f,'tmdb_5','tmdb-5',{watched:0,rating:null,known:1});view(f,'x1','tmdb-5',{watched:0,rating:null,known:1});return f;};
 const unknown=mixed();view(unknown,'x2','lb-x2',{watched:null,known:0});
 const u=await read(unknown,'tmdb_5');
 assert.equal(coverageOf(u).status,'complete','coverage itself is complete: the alias is simply unknown');
 for(const name of ['watched','rating']){
  assert.equal(u.body.personal.fields[name].status,'partial',name+': an unknown alias is not negative evidence');
  assert.deepEqual(u.body.personal.fields[name].unknownAliases,['x2']);
 }
 assert.equal(u.body.personal.status,'partial');
 // A genuine known conflict is kept whatever else is unknown.
 const conflict=mixed();view(conflict,'x2','lb-x2',{watched:1,rating:3,known:1});
 const c=await read(conflict,'tmdb_5');
 assert.deepEqual([c.body.personal.fields.watched.status,c.body.personal.fields.rating.status,c.body.personal.status],['conflict','conflict','conflict']);
 // All aliases proved negative, complete coverage: the negative IS stated.
 const proved=mixed();view(proved,'x2','lb-x2',{watched:0,rating:null,known:1});
 const p=await read(proved,'tmdb_5');
 assert.deepEqual([p.body.personal.fields.watched.status,p.body.personal.fields.watched.value,p.body.personal.fields.rating.status],['present',false,'absent']);
 // Unknown within one fact key: a row with NULL next to a known row of the same fact is unknown, not a conflict and not a negative.
 const within=mixed();view(within,'x1','tmdb-5',{watched:null,known:0});view(within,'x2','lb-x2',{watched:0,rating:null,known:1});
 const w=await read(within,'tmdb_5');
 assert.deepEqual([w.body.personal.fields.watched.status,w.body.personal.fields.watched.unknownAliases],['partial',['x1']]);
}

// P1 (review 3): the history link is computed after every fence and from the legacy bridge's own contract.
{
 // A stable Film with two trusted movie claims and one lid: the legacy bridge rejects it (tmdbIds.length>1), so no href, whatever the coverage.
 const multi=world({lids:['l5'],links:{'tmdb:5':'tmdb-5','tmdb:6':'tmdb-5','letterboxd:l5':'tmdb-5'}});
 claim(multi,'film:tmdb:5','tmdb','6');
 const m=await read(multi,'l5');
 assert.equal(m.body.identity.verdict,'found');
 assert.deepEqual([coverageOf(m).status,m.body.history.status,m.body.history.href],['complete','unavailable',undefined]);
 // The control: one movie claim and one lid is limited with its href (test 1), through the lid and through tmdb_<n>.
 const single=world();
 assert.equal((await read(single,'l5')).body.history.href,'/api/enrichment/history?filmId=l5');
 // A retired movie claim (the corrected TV Film) is not proved against the bridge, which still counts it: no href.
 const tv=blank();film(tv,'film:tmdb:123',[['tmdb','123'],['tmdb_tv','123'],['letterboxd','tvA']]);retire(tv,'film:tmdb:123','123','123','tvA');
 putLinks(tv,{'letterboxd:tvA':'lb-tvA'});putRecord(tv,'lb-tvA',{letterboxd:'tvA'});view(tv,'tvA','lb-tvA',{watched:1,known:0});
 const t=await read(tv,'tvA');
 assert.deepEqual([coverageOf(t).status,t.body.history.status,t.body.history.href],['complete','unavailable',undefined]);
 // History initially limited, then the coverage moves during the read (the ratings link index): the ratings sections are generation_moved AND history
 // carries no href, though it was computed from a coverage that was complete when first read.
 const moving=world();pointer(moving,'l5',3);
 let moved=false;
 const e=env(moving,{onQuery:text=>{if(!moved&&text.includes('FROM prediction_pointer')){moved=true;putLinks(moving,{...BASE_INDEX,'letterboxd:late':'tmdb-5'});}}});
 const out=await readFilmAggregate(e,'tmdb_5');
 assert.ok(moved);
 assert.deepEqual([out.body.personal.reason,out.body.predictions.reason,out.body.history.status,out.body.history.href],['generation_moved','generation_moved','unavailable',undefined]);
 // A held ratings domain: history unavailable, no href.
 const held=world();sqlite(held,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 assert.deepEqual([(await read(held,'l5')).body.history.status,(await read(held,'l5')).body.history.href],['unavailable',undefined]);
}

// P1 (review 4): the display title is built from the rows the token covers, one statement, and parity with the loader's own mapping.
{
 const locSource=(file,filmId,source,value,{version='v1',observed='2026-11-20T10:00:00.000Z'}={})=>sqlite(file,`INSERT OR REPLACE INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES (${q(filmId)},${q(source)},${q(value)},${q(version)},'{}','req-${source}',${q(observed)},${q(AT)})`);
 const locDimension=(file,filmId,{status,source=null,value=null,authority=null,version=null})=>sqlite(file,`INSERT OR REPLACE INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,attempts,updated_at) VALUES (${q(filmId)},'localization',${q(status)},${q(source)},${q(version)},NULL,${q(value)},${q(authority)},0,${q(AT)})`);
 // A→B→A between the section's first read and its after-read: the first read sees B, the after-read sees A. One statement each, so the title and its token
 // are of the same snapshot and the difference is caught (never B with the token of A).
 const file=world();locSource(file,'film:tmdb:5','tmdb','Title A');
 let phase=0;
 const e=env(file,{onQuery:text=>{
  if(text.includes('FROM owner_review_entry')){phase++;if(phase===1)locSource(file,'film:tmdb:5','tmdb','Title B');else if(phase===2)locSource(file,'film:tmdb:5','tmdb','Title A');}
 }});
 const out=await readFilmAggregate(e,'tmdb_5');
 assert.equal(phase,2);
 assert.deepEqual([out.body.display.status,out.body.display.reason],['unavailable','generation_moved']);
 assert.ok(!JSON.stringify(out.body.display).includes('Title B'));
 // The display consumes exactly one statement for its reads (and one for its fence): the localization rows are not read again.
 const counted=env(world());await readFilmAggregate(counted,'tmdb_5');
 // The token changes with any consumed column, including the dimension's source_version, which the mapping reads.
 const tokenOf=async f=>(await read(f,'tmdb_5')).body.display.token.localization;
 const base=world();locDimension(base,'film:tmdb:5',{status:'provisional',source:'letterboxd',value:'Prov',version:'1'});
 const t1=await tokenOf(base);
 locDimension(base,'film:tmdb:5',{status:'provisional',source:'letterboxd',value:'Prov',version:'2'});
 assert.notEqual(await tokenOf(base),t1,'dimension source_version is covered by the token');
 const srcBase=world();locSource(srcBase,'film:tmdb:5','tmdb','Same value',{version:'1'});
 const s1=await tokenOf(srcBase);
 locSource(srcBase,'film:tmdb:5','tmdb','Same value',{version:'2'});
 assert.notEqual(await tokenOf(srcBase),s1,'a source row\'s source_version is covered by the token');
 locSource(srcBase,'film:tmdb:5','tmdb','Same value',{version:'2',observed:'2026-11-21T10:00:00.000Z'});
 assert.notEqual(await tokenOf(srcBase),s1,'observed_at is covered by the token');
 // Parity with the loader: the title is exactly what loadLocalizationInputs + resolveLocalization produce for the same rows (no owner_review_entry rows).
 const {loadLocalizationInputs,resolveLocalization}=await import('../src/localization-sources.js');
 const scenarios={
  automatic_order:f=>{locSource(f,'film:tmdb:5','tmdb','From TMDB');locSource(f,'film:tmdb:5','letterboxd','From Letterboxd');},
  newer_same_source:f=>{locSource(f,'film:tmdb:5','tmdb','Old');locSource(f,'film:tmdb:5','tmdb','New',{observed:'2026-11-24T10:00:00.000Z'});},
  reviewed_dictionary:f=>{locSource(f,'film:tmdb:5','tmdb','Auto');locDimension(f,'film:tmdb:5',{status:'reviewed',source:'dictionary',value:'Reviewed',authority:'dictionary'});},
  owner_dimension:f=>{locSource(f,'film:tmdb:5','tmdb','Auto');locDimension(f,'film:tmdb:5',{status:'reviewed',value:'Owner',authority:'owner'});},
  provisional_only:f=>{locDimension(f,'film:tmdb:5',{status:'provisional',source:'wikidata',value:'Prov Wiki',version:'7'});},
  provisional_shadowed:f=>{locSource(f,'film:tmdb:5','wikidata','Source Wiki');locDimension(f,'film:tmdb:5',{status:'provisional',source:'wikidata',value:'Prov Wiki',version:'7'});},
  nothing:()=>{},
 };
 for(const [name,setup] of Object.entries(scenarios)){
  const f=world();setup(f);
  const inputs=await loadLocalizationInputs(env(f),'film',['film:tmdb:5']);
  const expected=resolveLocalization(inputs.get('film:tmdb:5'));
  const title=(await read(f,'tmdb_5')).body.display.fields.title;
  assert.deepEqual([name,title.value??null,title.provenance??null],[name,expected.value??null,expected.value?expected.tier:null]);
 }
}

// P1 (review 5): a failing section loses only itself; its reservation is given back; the identity fence is unaffected.
{
 // A readable but malformed ratings result: personal unavailable, the ratings coverage degrades predictions, every independent section survives.
 const file=world();pointer(file,'l5',3);watchlist(file,['l5']);show(file,'l5',1000);metadata(file,'film:tmdb:5',{year:1999});
 const rewrite=sql=>sql.replace(/\(SELECT json_group_array\(json_array\(alias_id[\s\S]*?\) AS view/,"(SELECT '{bad' FROM json_each(?)) AS view");
 const e=env(file,{rewrite});
 const out=await readFilmAggregate(e,'tmdb_5');
 assert.equal(out.http,200);
 assert.deepEqual([out.body.personal.status,out.body.personal.reason],['unavailable','ratings_unavailable']);
 assert.deepEqual([out.body.predictions.status,out.body.predictions.coverage.reason],['partial','ratings_evidence_unavailable']);
 assert.deepEqual(out.body.predictions.current.map(p=>p.storageId),['l5']);
 assert.deepEqual([out.body.watchlist.status,out.body.availability.status,out.body.display.fields.year.value],['present','present',1999]);
 assert.equal(out.body.sectionsUnavailable,undefined,'no section_read_failed: the resolver\'s generic fallback is not reached');
 assert.ok(e.calls.queries<=REQUEST_STATEMENT_BUDGET);
 // A display processing failure (a malformed result column): display unavailable, the rest intact.
 const display=env(file,{rewrite:sql=>sql.replace(/\(SELECT json_group_array\(json_array\(person_id,role,ordinal\)\)[\s\S]*?\) AS credits/,"(SELECT '{bad' FROM film WHERE id=? AND ?>0) AS credits")});
 const d=await readFilmAggregate(display,'tmdb_5');
 assert.deepEqual([d.http,d.body.display.status,d.body.display.reason],[200,'unavailable','display_unavailable']);
 assert.deepEqual([d.body.personal.status,d.body.predictions.status,d.body.watchlist.status,d.body.availability.status],['present','present','present','present']);
 // Both at once, plus an identity movement during the failure: the whole answer is 503 with no section.
 let moved=false;
 const both=env(file,{rewrite:sql=>rewrite(sql).replace(/\(SELECT json_group_array\(json_array\(person_id,role,ordinal\)\)[\s\S]*?\) AS credits/,"(SELECT '{bad' FROM film WHERE id=? AND ?>0) AS credits"),onQuery:text=>{if(!moved&&text.includes('FROM published_epg_show')){moved=true;claim(file,'film:tmdb:5','letterboxd','late9');}}});
 const b=await readFilmAggregate(both,'tmdb_5');
 assert.deepEqual([b.http,b.body.identity.reason,Object.keys(b.body).sort()],[503,'identity_moved',['contract','identity']]);
 // With both failing and nothing moved the identity fence still runs and the budget holds.
 const calm=world();
 const bothCalm=env(calm,{rewrite:sql=>rewrite(sql).replace(/\(SELECT json_group_array\(json_array\(person_id,role,ordinal\)\)[\s\S]*?\) AS credits/,"(SELECT '{bad' FROM film WHERE id=? AND ?>0) AS credits")});
 const c=await readFilmAggregate(bothCalm,'tmdb_5');
 assert.deepEqual([c.http,c.body.personal.reason,c.body.display.reason,c.body.availability.status],[200,'ratings_unavailable','display_unavailable','present']);
 assert.ok(bothCalm.calls.queries<=REQUEST_STATEMENT_BUDGET);
 // A section that fails after reserving gives its reservation back: with a budget that has no room to spare the later sections still run.
 for(let limit=10;limit<=REQUEST_STATEMENT_BUDGET;limit++){
  const small=env(file,{rewrite});
  const o=await readFilmAggregate(small,'tmdb_5',{budgetLimit:limit});
  assert.ok(small.calls.queries<=limit,limit+': '+small.calls.queries);
 }
}

// P2 (review): the settlement of the candidates is bounded in SQL before it is materialized; overflow is typed and fail-closed.
{
 const links={...BASE_INDEX,'letterboxd:own2':'tmdb-5'};
 const crowd=world({links});
 for(let i=0;i<SETTLEMENT_ROWS_MAX+6;i++)film(crowd,'film:crowd:'+i,[['letterboxd','own2',0,0]]);
 const logged=loggedEnv(crowd);
 const out=await readFilmAggregate(logged.env,'tmdb_5');
 assert.deepEqual([coverageOf(out).status,coverageOf(out).reason,out.body.predictions.status],['incomplete','discovery_cap','partial']);
 assert.equal(coverageOf(out).notes,undefined,'an overflowing settlement names no candidate as settled or open');
 // Retirement decisions of a candidate movie id over the cap: the same typed overflow.
 const decisions=world({links:{...BASE_INDEX,'tmdb:77':'tmdb-5'}});
 film(decisions,'film:other:77',[['tmdb','77']]);
 // The ledger allows one active retirement per Film, so each decision names its own Film (the ledger retires a movie id whatever Film it names).
 for(let i=0;i<SETTLEMENT_ROWS_MAX+3;i++){film(decisions,'film:r:'+i);retire(decisions,'film:r:'+i,'77',String(7700+i),'lx'+i);}
 const d=await read(decisions,'tmdb_5');
 assert.deepEqual([coverageOf(d).status,coverageOf(d).reason],['incomplete','discovery_cap']);
 // Within the cap the settlement still decides: one settled candidate is complete.
 const settled=world({links});film(settled,'film:other:2',[['letterboxd','own2']]);
 assert.equal(coverageOf(await read(settled,'tmdb_5')).status,'complete');
}

// ---- Owner decision of 25 Nov 2026 (AIR-647): the owner ancestry is a bounded reverse traversal through film_redirect_by_target ----
{
 const redirectTo=(file,from,to)=>sqlite(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES (${q(from)},${q(to)},${q(AT)})`);
 const title=async(file,id='tmdb_5')=>(await read(file,id)).body.display;
 // A multi-branch tree: S <- A, S <- B, A <- C, C <- D (depth 3), B <- E; owner entries sit on D and on nothing else. Independent of the request alias.
 const tree=world();
 for(const id of ['A','B','C','D','E'])film(tree,'film:anc:'+id);
 for(const [from,to] of [['film:anc:A','film:tmdb:5'],['film:anc:B','film:tmdb:5'],['film:anc:C','film:anc:A'],['film:anc:D','film:anc:C'],['film:anc:E','film:anc:B']])redirectTo(tree,from,to);
 ownerTitle(tree,'kD','film:anc:D','Deep Owner');
 for(const alias of ['tmdb_5','l5','film:tmdb:5','film:anc:A','film:anc:D','film:anc:E','film:anc:C']){
  const d=await title(tree,alias);
  assert.deepEqual([alias,d.fields.title.status,d.fields.title.value,d.fields.title.provenance],[alias,'present','Deep Owner','owner']);
  assert.deepEqual(d.ancestry,{status:'complete',films:5,depth:3},alias+': the whole tree, whatever alias was requested');
 }
 // Owner precedence over the tree: an owner value beats a reviewed dictionary and an automatic source; two owner values anywhere in the tree conflict, equal values do not.
 const locSourceRow=(file,filmId,source,value)=>sqlite(file,`INSERT OR REPLACE INTO film_localization_source (film_id,source,value,source_version,provenance_json,request_id,observed_at,updated_at) VALUES (${q(filmId)},${q(source)},${q(value)},'v1','{}','r-${source}','2026-11-20T10:00:00.000Z',${q(AT)})`);
 locSourceRow(tree,'film:tmdb:5','tmdb','Automatic');
 sqlite(tree,`INSERT OR REPLACE INTO film_dimension (film_id,dimension,status,source,authority,attempts,updated_at,value) VALUES ('film:tmdb:5','localization','reviewed','dictionary','dictionary',0,'${AT}','Reviewed')`);
 assert.equal((await title(tree)).fields.title.value,'Deep Owner','owner (through an ancestor of depth 3) > reviewed > automatic');
 ownerTitle(tree,'kD','film:anc:D','Deep Owner');ownerTitle(tree,'kE','film:anc:E','Deep Owner');
 assert.deepEqual([(await title(tree)).fields.title.status,(await title(tree)).fields.title.value],['present','Deep Owner'],'equal owner values on two branches agree');
 ownerTitle(tree,'kB','film:anc:B','Other Owner');
 for(const alias of ['tmdb_5','film:anc:D','film:anc:B']){
  const t=(await title(tree,alias)).fields.title;
  assert.equal(t.status,'conflict',alias+': two owner values on different branches, no winner');
  assert.deepEqual(t.values.map(v=>v.value).sort(),['Deep Owner','Deep Owner','Other Owner']);
 }
 sqlite(tree,"DELETE FROM owner_review_entry");
 assert.deepEqual([(await title(tree)).fields.title.value,(await title(tree)).fields.title.provenance],['Reviewed','reviewed'],'without an owner value the reviewed dictionary wins, then automatic');
 // An owner entry that is not verified, or of another kind, or linked to an unrelated Film, is not read.
 film(tree,'film:other:9');
 ownerTitle(tree,'kX','film:other:9','Stranger');
 sqlite(tree,"INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','kH','{\"localization\":{\"status\":\"reviewed\",\"value\":\"Held\",\"provenance\":{\"authority\":\"owner\"}}}','film:anc:C','held',1)");
 assert.equal((await title(tree)).fields.title.value,'Reviewed');

 // Depth bound: a chain of exactly OWNER_ANCESTOR_DEPTH ancestors is read; one more is `bounded` (typed, never "no more ancestors").
 const chain=(length)=>{
  const f=world();film(f,'film:c:0');
  for(let i=1;i<=length;i++){film(f,'film:c:'+i);}
  sqlite(f,"DELETE FROM film_redirect");
  redirectTo(f,'film:c:0','film:tmdb:5');
  for(let i=1;i<=length-1;i++)redirectTo(f,'film:c:'+i,'film:c:'+(i-1));
  ownerTitle(f,'kLeaf','film:c:'+(length-1),'Chain Owner');
  return f;
 };
 const atDepth=await title(chain(OWNER_ANCESTOR_DEPTH));
 assert.deepEqual([atDepth.fields.title.status,atDepth.fields.title.value,atDepth.ancestry],['present','Chain Owner',{status:'complete',films:OWNER_ANCESTOR_DEPTH,depth:OWNER_ANCESTOR_DEPTH}]);
 const pastDepth=await title(chain(OWNER_ANCESTOR_DEPTH+1));
 assert.deepEqual([pastDepth.fields.title.status,pastDepth.fields.title.reason,pastDepth.ancestry.status,pastDepth.status],['unknown','owner_ancestry_bounded','bounded','partial']);
 // Breadth bound: exactly OWNER_ANCESTORS_MAX direct ancestors are read, one more is bounded; the owner entry of the LAST one is found at the boundary.
 const wide=(count)=>{
  const f=world();
  const inserts=[];
  for(let i=0;i<count;i++)inserts.push(`INSERT INTO film (id,contract_version,updated_at) VALUES ('film:w:${i}',1,'${AT}');INSERT INTO canonical_revision (kind,id,revision,updated_at) VALUES ('film','film:w:${i}',1,'${AT}');INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:w:${i}','film:tmdb:5','${AT}');`);
  sqlite(f,inserts.join(''));
  ownerTitle(f,'kLast','film:w:'+(count-1),'Wide Owner');
  return f;
 };
 const atWidth=await title(wide(OWNER_ANCESTORS_MAX));
 assert.deepEqual([atWidth.fields.title.status,atWidth.fields.title.value,atWidth.ancestry],['present','Wide Owner',{status:'complete',films:OWNER_ANCESTORS_MAX,depth:1}]);
 const pastWidth=await title(wide(OWNER_ANCESTORS_MAX+1));
 assert.deepEqual([pastWidth.fields.title.status,pastWidth.fields.title.reason,pastWidth.ancestry.status],['unknown','owner_ancestry_bounded','bounded']);
 // The work is bounded INSIDE the statement, not only in the answer: the recursive CTE materializes at most OWNER_ANCESTORS_MAX + 2 rows however large the tree is,
 // and stops at depth OWNER_ANCESTOR_DEPTH + 1 however long the chain is.
 {
  const hugeWide=wide(OWNER_ANCESTORS_MAX*3);
  const hugeChain=chain(OWNER_ANCESTOR_DEPTH*4);
  const ancestryRows=(file)=>{
   const params=['film:tmdb:5',OWNER_ANCESTORS_MAX+1,OWNER_ANCESTOR_DEPTH,OWNER_ANCESTORS_MAX+2,'film:tmdb:5','film:tmdb:5',OWNER_ENTRIES_MAX+1,'film:tmdb:5',11,'film:tmdb:5','film:tmdb:5',61];
   let i=0;const text=DISPLAY_SQL.replace(/\?/g,()=>{const v=params[i++];return typeof v==='number'?String(v):q(v);});
   return JSON.parse(JSON.parse(sqliteSync(['-json',file],{input:text+';',encoding:'utf8'}).stdout)[0].ancestors);
  };
  assert.equal(ancestryRows(hugeWide).length,OWNER_ANCESTORS_MAX+2,'breadth: the CTE stops at the row cap of a 192-wide tree');
  const deep=ancestryRows(hugeChain);
  assert.equal(Math.max(...deep.map(r=>r[2])),OWNER_ANCESTOR_DEPTH+1,'depth: the CTE stops one level past the bound of a 32-long chain');
  assert.equal(deep.length,OWNER_ANCESTOR_DEPTH+2);
 }
 // WORK, not output (review of 8826e92): a recursive step enqueues every row its query returns for a dequeued parent, so a LIMIT on the CTE alone caps the rows
 // returned while the queue still takes every child of a high-fan-out Film. The step probes the index per parent with its own LIMIT, so the VM work of the statement
 // does not grow with the fan-out or the depth of the data. Measured as the VM steps the sqlite3 shell reports (`.stats vmstep`), not as rows or plan lines.
 {
  const vmSteps=(file,text)=>{const r=sqliteSync([file],{input:'.stats vmstep\n'+text+';\n',encoding:'utf8',maxBuffer:1<<28});const m=/VM-steps: (\d+)/.exec(String(r.stdout));assert.ok(m,'the sqlite3 shell reports VM steps');return Number(m[1]);};
  // The statement text is the one the MODULE sent to D1 during a real aggregate read (its own parameters), never a rebuilt one.
  const sentDisplay=async file=>{
   let captured=null;
   await readFilmAggregate(env(file,{onQuery:t=>{if(captured===null&&t.includes('WITH RECURSIVE anc'))captured=t;}}),'tmdb_5');
   assert.ok(captured,'the display statement ran');
   return captured;
  };
  const stepsOf=async file=>vmSteps(file,await sentDisplay(file));
  const survivor='film:tmdb:5';
  const star=count=>{const f=world();sqlite(f,`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count}) INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:fan:'||i,'${survivor}','${AT}' FROM n;`);return f;};
  // 64 children (Films) each with `grandchildren` merged-in Films: the survivor's own fan-out is small, every child's is large.
  const wideDeep=grandchildren=>{
   const f=world();
   sqlite(f,`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${OWNER_ANCESTORS_MAX}) INSERT INTO film (id,contract_version,updated_at) SELECT 'film:ch:'||i,1,'${AT}' FROM c;
    WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${OWNER_ANCESTORS_MAX}) INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:ch:'||i,'${survivor}','${AT}' FROM c;
    WITH RECURSIVE n(k) AS (SELECT 1 UNION ALL SELECT k+1 FROM n WHERE k<${grandchildren*OWNER_ANCESTORS_MAX}) INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:g:'||k,'film:ch:'||(1+(k%${OWNER_ANCESTORS_MAX})),'${AT}' FROM n;`);
   return f;
  };
  const longChain=length=>{
   const f=world();
   sqlite(f,`WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM c WHERE i<${length}) INSERT INTO film (id,contract_version,updated_at) SELECT 'film:lc:'||i,1,'${AT}' FROM c;
    INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lc:1','${survivor}','${AT}');
    WITH RECURSIVE c(i) AS (SELECT 2 UNION ALL SELECT i+1 FROM c WHERE i<${length}) INSERT INTO film_redirect (from_id,to_film_id,at) SELECT 'film:lc:'||i,'film:lc:'||(i-1),'${AT}' FROM c;`);
   return f;
  };
  // A star: the work is the same for 64, 1 000 and 20 000 children (the old step took every child: 3 000, 12 000, 200 000 steps).
  const base64=await stepsOf(star(OWNER_ANCESTORS_MAX));
  for(const count of [1000,20000]){
   const steps=await stepsOf(star(count));
   assert.ok(steps<=base64*1.1+500,count+' children: '+steps+' VM steps against '+base64+' for '+OWNER_ANCESTORS_MAX+': the work grows with the fan-out');
   assert.ok(steps<20000,count+' children: '+steps+' VM steps');
  }
  // Fan-out under EVERY dequeued parent: bounded by parents dequeued x children probed, whatever the number of grandchildren.
  const small=await stepsOf(wideDeep(OWNER_ANCESTORS_MAX+1)),large=await stepsOf(wideDeep(1500));
  assert.ok(large<=small*1.1+500,'1 500 grandchildren per child: '+large+' VM steps against '+small+' for '+(OWNER_ANCESTORS_MAX+1)+': the work grows with the fan-out');
  assert.ok(large<150000,'the worst case is a constant: '+large);
  // A long chain: the walk stops at the depth bound, so 20 and 3 000 ancestors cost the same.
  const short=await stepsOf(longChain(20)),long=await stepsOf(longChain(3000));
  assert.ok(long<=short*1.1+200,'a 3 000-long chain: '+long+' VM steps against '+short+' for 20: the work grows with the depth');
  // The answer is still the bounded, typed overflow, never a partial "complete".
  assert.deepEqual([(await title(star(20000))).ancestry.status,(await title(wideDeep(1500))).ancestry.status,(await title(longChain(3000))).ancestry.status],['bounded','bounded','bounded']);
 }
 // The owner-entry cap is separate from the ancestry cap: more entries than OWNER_ENTRIES_MAX over a small tree is typed too.
 const entries=world();
 sqlite(entries,Array.from({length:OWNER_ENTRIES_MAX+1},(_,i)=>`INSERT INTO owner_review_entry (kind,source_key,payload_json,identity_link,identity_state,generation) VALUES ('film','k${i}','{"localization":{"status":"reviewed","value":"V","provenance":{"authority":"owner"}}}','film:tmdb:5','verified',1);`).join(''));
 const manyEntries=await title(entries);
 assert.deepEqual([manyEntries.fields.title.status,manyEntries.fields.title.reason],['unknown','owner_entries_bounded']);
 // A redirect cycle (data corruption) is bounded by the depth, never an endless walk.
 const cyc=world();film(cyc,'film:x:1');redirectTo(cyc,'film:x:1','film:tmdb:5');sqlite(cyc,"PRAGMA foreign_keys=OFF;INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:5','film:x:1','"+AT+"')");
 const cycle=await read(cyc,'film:x:1');
 assert.equal(cycle.http,409,'the resolver refuses a cycle first: no section');

 // Fence: an edge, an owner entry or an absence moves the section (`generation_moved`); an unrelated edge does not.
 // The mutation runs just before the section's FIRST read and is undone before its after-read: A->B->A. The first read sees B; the after-read sees A: moved, never B.
 const flip=(mutate,undo)=>async()=>{
  const f=world();film(f,'film:anc:A');redirectTo(f,'film:anc:A','film:tmdb:5');ownerTitle(f,'kA','film:anc:A','Stable Owner');
  let n=0;
  const e=env(f,{onQuery:text=>{if(text.includes('WITH RECURSIVE anc')){n++;if(n===1)mutate(f);else if(n===2)undo(f);}}});
  const out=await readFilmAggregate(e,'tmdb_5');
  assert.equal(n,2,'the section reads twice');
  return out.body.display;
 };
 for(const [name,mutate,undo] of [
  ['a new child edge under a leaf',f=>{film(f,'film:anc:N');redirectTo(f,'film:anc:N','film:anc:A');},f=>sqlite(f,"DELETE FROM film_redirect WHERE from_id='film:anc:N'")],
  ['a new direct edge',f=>{film(f,'film:anc:M');redirectTo(f,'film:anc:M','film:tmdb:5');},f=>sqlite(f,"DELETE FROM film_redirect WHERE from_id='film:anc:M'")],
  ['a removed edge',f=>sqlite(f,"DELETE FROM film_redirect WHERE from_id='film:anc:A'"),f=>redirectTo(f,'film:anc:A','film:tmdb:5')],
  ['a re-pointed edge',f=>{film(f,'film:anc:Q');sqlite(f,"UPDATE film_redirect SET to_film_id='film:anc:Q' WHERE from_id='film:anc:A'");},f=>sqlite(f,"UPDATE film_redirect SET to_film_id='film:tmdb:5' WHERE from_id='film:anc:A'")],
  ['a new owner entry on the survivor (an absence predicate)',f=>ownerTitle(f,'kS','film:tmdb:5','Late Owner'),f=>sqlite(f,"DELETE FROM owner_review_entry WHERE source_key='kS'")],
  ['an owner value changed on an ancestor',f=>ownerTitle(f,'kA','film:anc:A','Changed'),f=>ownerTitle(f,'kA','film:anc:A','Stable Owner')],
 ]){
  const d=await flip(mutate,undo)();
  assert.deepEqual([name,d.status,d.reason],[name,'unavailable','generation_moved']);
  assert.ok(!JSON.stringify(d).includes('Late Owner')&&!JSON.stringify(d).includes('Changed'),name+': the moved value is never returned');
 }
 // An edge under an UNRELATED Film changes nothing the section consumed: it is not moved.
 const unrelated=await (async()=>{
  const f=world();film(f,'film:anc:A');redirectTo(f,'film:anc:A','film:tmdb:5');ownerTitle(f,'kA','film:anc:A','Stable Owner');film(f,'film:stranger:1');film(f,'film:stranger:2');
  let n=0;
  const e=env(f,{onQuery:text=>{if(text.includes('WITH RECURSIVE anc')){n++;if(n===1)redirectTo(f,'film:stranger:2','film:stranger:1');}}});
  return (await readFilmAggregate(e,'tmdb_5')).body.display;
 })();
 assert.deepEqual([unrelated.fields.title.status,unrelated.fields.title.value],['present','Stable Owner']);
 // A change that stays inside the section (a new ancestor with an owner entry) BEFORE the first read is simply read.
 const early=world();film(early,'film:anc:A');redirectTo(early,'film:anc:A','film:tmdb:5');
 let first=true;
 const lateAncestor=env(early,{onQuery:text=>{if(first&&text.includes('WITH RECURSIVE anc')){first=false;ownerTitle(early,'kA','film:anc:A','Read Now');}}});
 assert.equal((await readFilmAggregate(lateAncestor,'tmdb_5')).body.display.fields.title.value,'Read Now');
 // A identity-level move during the ancestry read is still 503 with no section (the identity fence is independent of the section fences).
 const idMove=world();film(idMove,'film:anc:A');redirectTo(idMove,'film:anc:A','film:tmdb:5');
 let moved=false;
 const idEnv=env(idMove,{onQuery:text=>{if(!moved&&text.includes('WITH RECURSIVE anc')){moved=true;claim(idMove,'film:tmdb:5','letterboxd','late7');}}});
 const idOut=await readFilmAggregate(idEnv,'tmdb_5');
 assert.deepEqual([idOut.http,idOut.body.identity.reason,Object.keys(idOut.body).sort()],[503,'identity_moved',['contract','identity']]);
 // The shared budget: the ancestry costs no statement of its own (one display statement and its after-read), a huge tree included.
 const budgeted=wide(OWNER_ANCESTORS_MAX);
 const counted=env(budgeted);
 const done=await readFilmAggregate(counted,'tmdb_5');
 assert.equal(done.http,200);
 assert.ok(counted.calls.queries<=REQUEST_STATEMENT_BUDGET-10,'the ancestry adds no statements: '+counted.calls.queries);
 for(let limit=4;limit<=REQUEST_STATEMENT_BUDGET;limit++){
  const small=env(budgeted);
  const o=await readFilmAggregate(small,'tmdb_5',{budgetLimit:limit});
  assert.ok(small.calls.queries<=limit,limit+': '+small.calls.queries);
  if(o.http===200&&o.body.display.status==='unavailable')assert.equal(o.body.display.reason,'budget_exceeded');
 }
 // A display failure (a malformed ancestry column) is typed and does not touch the other sections or the identity fence.
 const broken=env(tree,{rewrite:sql=>sql.replace("(SELECT json_group_array(json_array(id,parent,depth)) FROM anc) AS ancestors","'{bad' AS ancestors")});
 const b=await readFilmAggregate(broken,'tmdb_5');
 assert.deepEqual([b.http,b.body.display.status,b.body.display.reason,b.body.personal.status,b.body.watchlist.status,b.body.availability.status],[200,'unavailable','display_unavailable','present','unknown','present']);
}

// EXPLAIN QUERY PLAN of every statement of the aggregate (ADR 0216 decision 7): each lookup is a primary-key or index SEARCH, no base table and no index is
// scanned (the bound json_each key lists, a constant row, derived tables and the measuring CTE of the bounded document read are the only SCANs). A scan of
// film_redirect is never scanned: its ancestry step is a SEARCH through film_redirect_by_target (migration 0043, part of the real chain this fixture is built from).
{
 const file=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:own2':'tmdb-5','tmdb:66':'tmdb-5'}});
 film(file,'film:other:2',[['letterboxd','own2']]);film(file,'film:old:5');sqlite(file,`INSERT INTO film_redirect VALUES ('film:old:5','film:tmdb:5','${AT}')`);
 watchlist(file,['l5','x']);show(file,'l5',1000);pointer(file,'l5',3);metadata(file,'film:tmdb:5',{year:1});
 const plans=[];
 const e=env(file,{onQuery:t=>{if(/^\s*(WITH|SELECT)/i.test(t)&&!/sqlite_master|schema_contract/.test(t))plans.push(t);}});
 const planned=await readFilmAggregate(e,'film:old:5');
 assert.equal(planned.http,200);
 assert.ok(plans.some(t=>t.includes('film_external_id e ON e.scheme')&&t.includes('tmdb_retirement_decision')),'the settlement statement ran');
 assert.ok(plans.some(t=>t.includes('FROM owner_review_entry')&&t.includes('film_localization_source')),'the display statement ran');
 const seen=new Set();
 for(const text of plans){
  const shape=text.replace(/'[^']*'/g,"'?'");
  if(seen.has(shape))continue;seen.add(shape);
  const out=sqliteSync([file],{input:'EXPLAIN QUERY PLAN '+text+';',encoding:'utf8'});
  assert.equal(out.status,0,out.stderr);
  const plan=out.stdout.split('\n').map(line=>line.replace(/^[\s|`-]+/,'').trim()).filter(Boolean);
  const scans=plan.filter(d=>/^SCAN /.test(d)&&!/json_each|^SCAN j\b|SCAN CONSTANT ROW|^SCAN \(subquery-\d+\)$|^SCAN (g|a|anc)$/.test(d));
  assert.deepEqual(scans,[],text.slice(0,160)+'\n'+plan.join('\n'));
  assert.ok(!plan.some(d=>/film_redirect/.test(d)&&/^SCAN /.test(d)),'film_redirect is never scanned');
  if(text.startsWith('WITH RECURSIVE anc')){
   assert.ok(plan.some(d=>/^SEARCH film_redirect USING INDEX film_redirect_by_target \(to_film_id=\?\)/.test(d)),'the ancestry step is served by film_redirect_by_target (migration 0043)\n'+plan.join('\n'));
   assert.ok(plan.some(d=>/^SEARCH owner_review_entry USING INDEX owner_review_entry_identity \(identity_link=\?\)/.test(d)),'the owner entries are found by identity_link, not by a range of every film entry\n'+plan.join('\n'));
  }
  if(text.startsWith('WITH g AS'))assert.ok(plan.some(d=>/^SEARCH ratings_document USING INDEX sqlite_autoindex_ratings_document_1 \(key=\?\)/.test(d)),'the measure is a primary-key search\n'+plan.join('\n'));
 }
 assert.ok(seen.size>=9,'every statement shape was planned: '+seen.size);
}

// ---- AIR-665 / ADR 0218 stage 5: derived readiness over the REAL readFilmAggregate response (zero extra statements, no write) ----
{
 const rd=async(file,id,options={})=>{const e=env(file,options);const out=await readFilmReadiness(e,id,options.prediction?{prediction:options.prediction}:{});return {...out,calls:e.calls};};
 const sig=r=>[r.readiness.displayReady.rule,r.readiness.catalogReady.rule,r.readiness.predictionReady.rule];
 // The expected context is what a trusted, fenced composition (AIR-648) owns; the observation captures it while reading. Here: fixed domain state.
 const DOMAIN={profile:{version:4,hash:'p4'},registryToken:'r1',fingerprintToken:'f1'};
 const observed=(body,fingerprints=[],over={})=>{
  const storageIds=authorizedStorageIds(body.identity);
  const pointers=(body.predictions.current||[]).map(c=>({film_id:c.storageId,r2_key:c.body.r2Key,content_sha256:c.contentSha256,fingerprint_hash:c.fingerprintHash}));
  const facts=predictionFacts({storageIds,fingerprints,pointers,coverage:body.predictions.coverage});
  return predictionEvidence(facts,{filmId:body.identity.filmId,identityToken:body.identity.token,predictionToken:body.predictions.token,coverageToken:body.predictions.coverage?.token,examinedStorageIds:storageIds,...DOMAIN,...over});
 };
 const prediction=(fingerprints=[],{over={},context={}}={})=>body=>({evidence:observed(body,fingerprints,over),context:{identityToken:body.identity.token,examinedStorageIds:authorizedStorageIds(body.identity),...DOMAIN,...context}});
 // found: usable title and metadata, complete coverage, a pointer. Without prediction-domain evidence predictionReady is unknown, never true.
 const file=world();pointer(file,'l5',3.5);metadata(file,'film:tmdb:5',{year:1995,runtime:120,synopsis:'s',poster:'p',url:'u',genres:['Drama']});ownerTitle(file,'k1','film:tmdb:5','Heat');
 const before=fileSha(file);
 const plain=await read(file,'tmdb_5');
 const found=await rd(file,'tmdb_5');
 assert.equal(found.http,200);
 assert.deepEqual(found.body,plain.body,'the composition returns the aggregate body unchanged');
 assert.deepEqual([found.readiness.displayReady.value,found.readiness.catalogReady.value],[true,true]);
 assert.deepEqual([found.readiness.predictionReady.rule,found.readiness.predictionReady.value,found.readiness.predictionReady.reason],['P7','unknown','fingerprint_unknown']);
 // Measured cost: the derivation adds no D1 statement, no write, no R2 or network (the proxies throw).
 assert.equal(found.calls.queries,plain.calls.queries,'zero additional D1 statements');
 assert.equal(fileSha(file),before,'no write');
 // Bound evidence from the real body and the expected context: coherent evidence is accepted (a positive still needs a fingerprint and compatibility verdict).
 const fp=[{film_id:'l5',fingerprint_hash:'h',invalidated_at:null}];
 const good=await rd(file,'tmdb_5',{prediction:prediction(fp)});
 assert.ok(!String(good.readiness.predictionReady.reason).startsWith('prediction_evidence_'),'coherent evidence binds: '+good.readiness.predictionReady.reason);
 const why=async p=>(await rd(file,'tmdb_5',{prediction:p})).readiness.predictionReady;
 // Same Film, same pointer, same aggregate tokens, but the expected context moved: the observation is not certified.
 assert.equal((await why(prediction(fp,{context:{profile:{version:5,hash:'p5'}}}))).reason,'prediction_evidence_profile_changed');
 assert.equal((await why(prediction(fp,{context:{registryToken:'r2'}}))).reason,'prediction_evidence_profile_changed');
 assert.equal((await why(prediction(fp,{context:{fingerprintToken:'f2'}}))).reason,'prediction_evidence_fingerprint_changed');
 assert.equal((await why(prediction(fp,{context:{identityToken:{generation:99,readSet:'x'}}}))).reason,'prediction_evidence_identity_moved');
 assert.equal((await why(prediction(fp,{over:{filmId:'film:other'}}))).reason,'prediction_evidence_foreign_film');
 assert.equal((await why(prediction(fp,{over:{examinedStorageIds:['l5']}}))).reason,'prediction_evidence_incomplete_fingerprint_coverage');
 for(const key of ['fingerprintToken','registryToken','profile'])assert.equal((await why(prediction(fp,{over:{[key]:null}}))).value,'unknown','missing '+key);
 // The relabelled stale observation (tokens of an earlier body) never certifies: it is checked against the body actually judged.
 assert.equal((await why(body=>({evidence:observed(plain.body,fp,{identityToken:{generation:0,readSet:'old'}}),context:prediction(fp)(body).context}))).reason,'prediction_evidence_identity_moved');
 // redirected: display and catalog are judged on the survivor.
 const redir=world();film(redir,'film:old:5');sqlite(redir,`INSERT INTO film_redirect VALUES ('film:old:5','film:tmdb:5','${AT}')`);metadata(redir,'film:tmdb:5',{year:1995});
 const viaRedirect=await rd(redir,'film:old:5');
 assert.equal(viaRedirect.body.identity.verdict,'redirected');
 assert.equal(viaRedirect.readiness.catalogReady.rule,'C2');
 // TV-only Film: no stable alias (C1).
 const tv=blank();film(tv,'film:tv:3',[['tmdb_tv','3']]);putLinks(tv,{});metadata(tv,'film:tv:3',{year:2001});
 const tvOut=await rd(tv,'tmdb_tv:3');
 assert.deepEqual([tvOut.readiness.catalogReady.rule,tvOut.readiness.catalogReady.reason],['C1','no_stable_alias']);
 // Complete coverage with no pointer: P4 from the aggregate alone. Incomplete candidate coverage with a pointer stays unknown.
 assert.equal((await rd(world(),'tmdb_5')).readiness.predictionReady.rule,'P4');
 const incomplete=world({links:{'tmdb:5':'tmdb-5'}});pointer(incomplete,'l5',3);
 const inc=await rd(incomplete,'tmdb_5');
 assert.notEqual(inc.body.predictions.coverage.status,'complete');
 assert.equal(inc.readiness.predictionReady.value,'unknown');
 // Known conflict between authorized storage ids with incomplete coverage: P2.
 const conflict=world({lids:['a1','a2']});pointer(conflict,'a1',3);pointer(conflict,'a2',4);sqlite(conflict,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 const c=await rd(conflict,'tmdb_5');
 assert.deepEqual([c.body.predictions.status,c.readiness.predictionReady.rule,c.readiness.predictionReady.reason],['conflict','P2','conflict']);
 // Held ratings domain: coverage incomplete, never a negative.
 const heldRatings=world();sqlite(heldRatings,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 assert.equal((await rd(heldRatings,'tmdb_5')).readiness.predictionReady.value,'unknown');
 // Film/Person authority not open (held or unprepared): G1 for every predicate; an absent request is G2 not_applicable.
 const unopened=path.join(root,'unopened.sqlite');sqlite(unopened,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 const heldIdentity=await rd(unopened,'tmdb_5');
 assert.deepEqual([heldIdentity.http,heldIdentity.body.identity.verdict,...sig(heldIdentity)],[503,'unavailable','G1','G1','G1']);
 const missing=await rd(world(),'tmdb_999');
 assert.deepEqual([missing.http,...sig(missing)],[404,'G2','G2','G2']);
 // Moved section: the prediction pointer changes during the read: the section is unavailable (P1).
 const mv=world();pointer(mv,'l5',3);
 let moved=false;
 const em=env(mv,{onQuery:t=>{if(!moved&&t.includes('FROM watchlist_authority')){moved=true;pointer(mv,'l5',3,{sha:'e'.repeat(64)});}}});
 const movedOut=await readFilmReadiness(em,'tmdb_5',{prediction:prediction()});
 assert.deepEqual([movedOut.readiness.predictionReady.rule,movedOut.readiness.predictionReady.reason],['P1','prediction_unavailable']);
 // Identity moved during the read: 503, identity only: G1.
 const idm=world();let m2=false;
 const eim=env(idm,{onQuery:t=>{if(!m2&&t.includes('FROM published_epg_show')){m2=true;claim(idm,'film:tmdb:5','letterboxd','late1');}}});
 const idOut=await readFilmReadiness(eim,'tmdb_5');
 assert.deepEqual([idOut.http,...sig(idOut)],[503,'G1','G1','G1']);
}

console.log('film-aggregate: FilmAggregateV1 sections (display, watchlist, availability, personal, predictions, history) over the AIR-646 resolver; G1 candidate discovery and coverage with its bounds; per-section before/after tokens (generation_moved), identity_moved with no section, the 40-statement budget with the reserved fence, C2 dedup and conflicts, the Watchlist negative proof, history limited/unavailable; dormant and read-only');
