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
 readFilmAggregate,readSections,handleFilmAggregateRequest,countedDatabase,FILM_AGGREGATE_ROUTE,
 LINK_DOCUMENT_MAX_PARTS,LINK_INDEX_MAX_ENTRIES,FACT_RECORDS_MAX,CANDIDATES_MAX,CURRENT_SHOWS_MAX,CREDITS_MAX,
} from '../src/film-aggregate.js';
import {createStatementBudget,REQUEST_STATEMENT_BUDGET} from '../src/film-aggregate-resolver.js';

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
 const e1=moving(epg,t=>t.includes('FROM film_redirect r INNER JOIN anc'),()=>sqlite(epg,"UPDATE published_epg_authority SET generation=generation+1 WHERE id=1"));
 const o1=await readFilmAggregate(e1,'tmdb_5');
 assert.deepEqual([o1.http,o1.body.availability.status,o1.body.availability.reason],[200,'unavailable','generation_moved']);
 assert.notEqual(o1.body.predictions.status,'unavailable');
 // Test 15b: a show row changes (Discovery assigns a show) without a generation move: availability unavailable.
 const rows=world();show(rows,'l5',1000);
 const e2=moving(rows,t=>t.includes('FROM film_redirect r INNER JOIN anc'),()=>show(rows,'tmdb_5',3000));
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
 assert.deepEqual([out.body.display.fields.title.status,out.body.display.fields.title.value,out.body.display.fields.title.provenance],['present','Owner Title','owner']);
 assert.deepEqual([out.body.display.fields.year.status,out.body.display.fields.year.value],['present',1999]);
 assert.deepEqual(out.body.display.fields.genres.value,['Drama']);
 // Test 12: no per-field provenance is delivered (ADR 0214 PF): a missing or null field is unknown, never absent.
 for(const name of ['runtime','synopsis','poster','url'])assert.equal(out.body.display.fields[name].status,'unknown',name);
 assert.equal(out.body.display.status,'partial');
 assert.ok(out.body.display.token.ownerReview.startsWith('sha256:')&&out.body.display.token.metadata);
 // An owner entry of a redirect ancestor (a merged Film) still holds: owner > reviewed > automatic over the chain.
 const merged=world();film(merged,'film:old:5');sqlite(merged,`INSERT INTO film_redirect VALUES ('film:old:5','film:tmdb:5','${AT}')`);
 ownerTitle(merged,'k2','film:old:5','Ancestor Owner');
 assert.equal((await read(merged,'tmdb_5')).body.display.fields.title.value,'Ancestor Owner');
 ownerTitle(merged,'k3','film:tmdb:5','Other Owner');
 assert.equal((await read(merged,'tmdb_5')).body.display.fields.title.status,'conflict','two owner values: no winner');
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
 const writes=executed.filter(t=>!/^\s*(WITH\s+RECURSIVE\b[\s\S]*?\)\s*)?SELECT\b/i.test(t)||/\b(INSERT|UPDATE|DELETE|REPLACE)\s/i.test(t.replace(/'[^']*'/g,'')));
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
 for(const name of ['film-aggregate','film-aggregate-resolver'])assert.ok(!build.includes("src/"+name+".js"),name+' stays out of the bundle');
 for(const name of fs.readdirSync('src').filter(f=>f.endsWith('.js')&&f!=='film-aggregate.js'&&f!=='film-aggregate-resolver.js'))
  assert.ok(!/film-aggregate/.test(fs.readFileSync('src/'+name,'utf8')),name+' must not import the dormant aggregate');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes(FILM_AGGREGATE_ROUTE),'the Worker routes no internal film aggregate');
 if(fs.existsSync('dist/server/index.js'))assert.ok(!fs.readFileSync('dist/server/index.js','utf8').includes(FILM_AGGREGATE_ROUTE),'the built bundle does not serve the route');
}

// EXPLAIN QUERY PLAN of every new statement (ADR 0216 decision 7): each lookup is served by an existing index or primary key; the only base-table scan is the
// owner-ancestor step of the display statement over film_redirect (no index on to_film_id; the same read as the accepted AIR-372 read model).
{
 const file=world({links:{'tmdb:5':'tmdb-5','letterboxd:l5':'tmdb-5','letterboxd:own2':'tmdb-5','tmdb:66':'tmdb-5'}});
 film(file,'film:other:2',[['letterboxd','own2']]);watchlist(file,['l5','x']);show(file,'l5',1000);pointer(file,'l5',3);metadata(file,'film:tmdb:5',{year:1});
 const plans=[];
 const e=env(file,{onQuery:t=>{if(/^\s*(WITH|SELECT)/i.test(t)&&!/sqlite_master|schema_contract/.test(t))plans.push(t);}});
 const planned=await readFilmAggregate(e,'tmdb_5');
 assert.equal(planned.http,200);
 assert.ok(plans.some(t=>t.includes('film_external_id e ON e.scheme')&&t.includes('tmdb_retirement_decision')),'the settlement statement ran');
 const seen=new Set();
 for(const text of plans){
  const shape=text.replace(/'[^']*'/g,"'?'");
  if(seen.has(shape))continue;seen.add(shape);
  const out=sqliteSync([file],{input:'EXPLAIN QUERY PLAN '+text+';',encoding:'utf8'});
  assert.equal(out.status,0,out.stderr);
  const plan=out.stdout.split('\n').map(line=>line.replace(/^[\s|`-]+/,'').trim()).filter(Boolean);
  const scans=plan.filter(d=>/^SCAN /.test(d)&&!/json_each|^SCAN j\b|SCAN CONSTANT ROW|^SCAN \(subquery-\d+\)$|^SCAN anc\b|^SCAN a\b|^SCAN [a-z_]+ USING (COVERING )?INDEX/.test(d));
  const allowed=scans.filter(d=>/^SCAN r\b/.test(d)&&text.includes('FROM film_redirect r INNER JOIN anc'));
  assert.deepEqual(scans.filter(d=>!allowed.includes(d)),[],text.slice(0,160)+'\n'+plan.join('\n'));
 }
 assert.ok(seen.size>=9,'every statement shape was planned: '+seen.size);
}

console.log('film-aggregate: FilmAggregateV1 sections (display, watchlist, availability, personal, predictions, history) over the AIR-646 resolver; G1 candidate discovery and coverage with its bounds; per-section before/after tokens (generation_moved), identity_moved with no section, the 40-statement budget with the reserved fence, C2 dedup and conflicts, the Watchlist negative proof, history limited/unavailable; dormant and read-only');
