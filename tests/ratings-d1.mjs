// ADR 0084. D1 owns Letterboxd ratings only after its own marker is d1 and cutover open.
// Counts below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import {activateDocuments, casOwned, importDocuments, listDocuments, overlayView, projectView, putOwned, readOwned, readRatingsAuthority, readRatingsRun, ratingsRunActivity, releaseHeld, revertMarker, routeRead, sealHeld} from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {applyDecision} from '../scripts/ratings-domain-production.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-ratings-d1-'));
let databases=0;
const earlyNames=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'];
const chainNames=[...earlyNames,'0007_prediction_authority','0008_published_epg_authority'];
function load(names){
 const file=path.join(root,'ratings-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 return db;
}
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set,RatingsD1,structuredClone});
const Facts=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+'\nLetterboxdFacts',ctx);

assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/ratings-d1\.js','RatingsD1'\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/RatingsD1\.routeRead\(env,key\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/RatingsD1\.overlayView\(env,value\)/);
assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"RATINGS_DB_REQUIRED": "on"/);
assert.match(fs.readFileSync('src/letterboxd-ratings.js','utf8'),/RatingsD1\.putOwned/);
assert.match(fs.readFileSync('src/letterboxd-diary.js','utf8'),/RatingsD1\.readOwned/);
assert.doesNotMatch(fs.readFileSync('src/ratings-d1.js','utf8'),/INTO film |INTO candidate |watchlist_film|prediction_domain/);

{
 const early=load(earlyNames);
 let refused=false;
 try{early.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));}catch{refused=true;}
 assert.equal(refused,true);
 assert.equal(one(early,'SELECT version FROM schema_contract'),6);
 assert.equal(one(early,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'ratings_%'"),0);
}

const v8=load(chainNames);
assert.equal(one(v8,'SELECT version FROM schema_contract'),8);
v8.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
assert.equal(one(v8,'SELECT version FROM schema_contract'),10);
assert.equal(one(v8,"SELECT mode FROM ratings_domain_authority"),'r2');
assert.equal(one(v8,"SELECT cutover FROM ratings_domain_authority"),'open');
assert.equal(one(v8,'SELECT generation FROM ratings_domain_authority'),0);
let downgraded=false;
try{v8.sql('UPDATE schema_contract SET version=9 WHERE id=1');}catch{downgraded=true;}
assert.equal(downgraded,true);
assert.equal(one(v8,'SELECT version FROM schema_contract'),10);

const v9=load([...chainNames,'0009_owner_review_authority']);
assert.equal(one(v9,'SELECT version FROM schema_contract'),9);
v9.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
assert.equal(one(v9,'SELECT version FROM schema_contract'),10);
assert.equal(one(v9,"SELECT COUNT(*) FROM sqlite_master WHERE name='owner_review_authority'"),1);

const after=load(chainNames);
after.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
after.sql(fs.readFileSync('migrations/0009_owner_review_authority.sql','utf8'));
assert.equal(one(after,'SELECT version FROM schema_contract'),10);
assert.equal(one(after,"SELECT mode FROM owner_review_authority"),'r2');
assert.equal(one(after,"SELECT mode FROM ratings_domain_authority"),'r2');

assert.equal((await readRatingsAuthority(v8,{})).ready,false);
assert.equal((await readRatingsAuthority(load(chainNames),{})).mode,'r2');
await assert.rejects(readRatingsAuthority(null,{RATINGS_DB_REQUIRED:'on'}),error=>error.code==='ratings_domain_unavailable');
assert.equal((await readRatingsAuthority(null,{})).ready,false);
const partial=load(chainNames);
partial.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
partial.sql('DROP TABLE ratings_view');
await assert.rejects(readRatingsAuthority(partial,{RATINGS_DB_REQUIRED:'on'}),error=>error.code==='ratings_domain_unavailable');

assert.equal(applyDecision({schemaVersion:8,ratings:{ratings_domain_authority:false,ratings_domain_cas:false,ratings_document:false,ratings_view:false},prerequisite:true}),'apply');
assert.equal(applyDecision({schemaVersion:9,ratings:{ratings_domain_authority:false,ratings_domain_cas:false,ratings_document:false,ratings_view:false},prerequisite:true}),'apply');
assert.equal(applyDecision({schemaVersion:10,ratings:{ratings_domain_authority:true,ratings_domain_cas:true,ratings_document:true,ratings_view:true},prerequisite:true}),'already_applied');
assert.equal(applyDecision({schemaVersion:8,ratings:{ratings_domain_authority:true,ratings_domain_cas:false,ratings_document:false,ratings_view:false},prerequisite:true}),'partial_schema');
assert.equal(applyDecision({schemaVersion:6,ratings:{ratings_domain_authority:false,ratings_domain_cas:false,ratings_document:false,ratings_view:false},prerequisite:false}),'schema_unexpected');
assert.equal(applyDecision({schemaVersion:8,ratings:{ratings_domain_authority:false,ratings_domain_cas:false,ratings_document:false,ratings_view:false},prerequisite:false}),'published_prerequisite');

function bucket(){
 const records=new Map();
 return {records,async get(key){return records.has(key)?{etag:'r2',json:async()=>structuredClone(records.get(key))}:null;},async put(key,value){records.set(key,JSON.parse(value));return {etag:'r2'};}};
}
const filmText=JSON.stringify({schemaVersion:1,factKey:'lb-abc',links:{letterboxd:'abc',tmdb:'5'},redirectTo:null,migrating:null,watched:{value:true,effectiveOn:null,observedAt:'2026-01-02T00:00:00.000Z',source:'letterboxd_diary',sourceRef:null,observationId:'a'},rating:{value:null,effectiveOn:null,observedAt:'2026-01-02T00:00:00.000Z',source:'letterboxd_diary',sourceRef:null,observationId:'b'},ratingHistory:[{kind:'first_observed',value:null},{kind:'changed',value:4}]});
const linksText=JSON.stringify({'letterboxd:abc':'lb-abc','tmdb:5':'lb-abc'});
const queueText=JSON.stringify({schemaVersion:2,films:{abc:{url:'https://letterboxd.com/film/abc/',state:'pending',attempts:0,refs:[{eventKey:'events/items/0000000000001-old.json',sourceRunId:'run',at:'2026-01-01T00:00:00.000Z',resolved:false}]}},droppedRefs:[]});
const docs=[{key:'letterboxd/facts/films/lb-abc.json',text:filmText},{key:'letterboxd/facts/links.json',text:linksText},{key:'enrichment/removal-rating-lookups.json',text:queueText}];

{
 const db=load(chainNames);
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 const imported=await importDocuments({DB:db},docs,{confirm:'load'});
 assert.equal(imported.mode,'r2');
 assert.equal(imported.documents,3);
 assert.equal(one(db,"SELECT watched FROM ratings_view WHERE alias_id='abc'"),1);
 assert.equal(one(db,"SELECT actual_rating FROM ratings_view WHERE alias_id='tmdb_5'"),null);
 assert.equal(one(db,"SELECT rating_known FROM ratings_view WHERE alias_id='tmdb_5'"),1);
 assert.equal((await routeRead({DB:db},'letterboxd/facts/films/lb-abc.json')).handled,false);
 const held=await activateDocuments({DB:db},docs,{confirm:'activate'});
 assert.equal(held.mode,'d1');
 assert.equal(held.cutover,'held');
 assert.equal((await routeRead({DB:db},'letterboxd/facts/films/lb-abc.json')).handled,false);
 await assert.rejects(casOwned({DB:db},'letterboxd/ratings/run.json',{},()=>({schemaVersion:1})),error=>error.code==='ratings_domain_not_authoritative');
 const released=await releaseHeld({DB:db},{confirm:'release-hold'});
 assert.equal(released.mode,'r2');
 const again=await activateDocuments({DB:db},docs,{confirm:'activate'});
 const sealed=await sealHeld({DB:db},{confirm:'seal-hold',generation:again.generation});
 assert.equal(sealed.ready,true);
 const routed=await routeRead({DB:db},'letterboxd/facts/films/lb-abc.json');
 assert.equal(routed.handled,true);
 assert.equal(routed.value.ratingHistory.length,2);
 const store=bucket();
 store.records.set('letterboxd/facts/films/lb-abc.json',{rating:{value:1}});
 const hidden=await routeRead({DB:db,BUCKET:store},'letterboxd/facts/films/lb-abc.json');
 assert.equal(hidden.value.rating.value,null);
 const overlaid=await overlayView({DB:db},{abc:{actualRating:9,watched:false,prediction:{predictedRating:3}},other:{fingerprint:{fingerprintHash:'h'}}});
 assert.equal(overlaid.abc.actualRating,null);
 assert.equal(overlaid.abc.watched,true);
 assert.equal(overlaid.abc.prediction.predictedRating,3);
 assert.equal(overlaid.other.actualRating,undefined);
 assert.equal(overlaid.tmdb_5.watched,true);
 const queue=await readOwned({DB:db},'enrichment/removal-rating-lookups.json');
 assert.equal(queue.value.films.abc.refs[0].resolved,false);
 assert.equal(queue.value.films.abc.watched,undefined);
}

{
 const db=load(chainNames);
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open'");
 const store=bucket();
 const env={DB:db,BUCKET:store,RATINGS_DB_REQUIRED:'on'};
 const at='2026-02-02T00:00:00.000Z';
 const saved=await Facts.recordFilmFacts(env,'abc',{watched:false,rating:4},{observedAt:at,source:'owner'});
 assert.equal(saved.accepted,true);
 assert.equal(store.records.has('letterboxd/facts/films/lb-abc.json'),false);
 assert.equal(store.records.has('enrichment/view-index.json'),false);
 const read=await Facts.confirmedFilmRating(env,'abc');
 assert.equal(read,4);
 const view=await overlayView(env,{});
 assert.equal(view.abc.watched,false);
 assert.equal(view.abc.actualRating,4);
 const marked=await Facts.recordOwnerWatchedMark(env,'9',false,{observedAt:at});
 assert.equal(marked.watched,false);
 const absent=await overlayView(env,{});
 assert.equal(absent.tmdb_9.watched,false);
 assert.equal(absent.tmdb_9.actualRating,undefined);
 const noted=await putOwned(env,'letterboxd/facts/conflicts.json',null,{'letterboxd:abc tmdb:8':{links:{letterboxd:'abc',tmdb:'8'},reason:'alias_conflict',count:1}});
 assert.ok(noted.saved);
 const conflict=await readOwned(env,'letterboxd/facts/conflicts.json');
 assert.equal(conflict.value['letterboxd:abc tmdb:8'].reason,'alias_conflict');
 const first=await putOwned(env,'letterboxd/ratings/run.json',null,{schemaVersion:1,checkpoint:{diaryPagesRead:0,diaryNextPage:1},diary:{outcome:'failed'}});
 assert.ok(first.saved);
 const second=await putOwned(env,'letterboxd/ratings/run.json',null,{schemaVersion:1,checkpoint:{diaryPagesRead:1}});
 assert.equal(second.saved,null);
 const run=await readOwned(env,'letterboxd/ratings/run.json');
 assert.equal(run.value.checkpoint.diaryPagesRead,0);
 assert.equal(run.value.diary.outcome,'failed');
 const raced=await putOwned(env,'letterboxd/ratings/run.json','not-the-etag',{schemaVersion:1,checkpoint:{diaryPagesRead:9}});
 assert.equal(raced.saved,null);
 assert.equal((await readOwned(env,'letterboxd/ratings/run.json')).value.checkpoint.diaryPagesRead,0);
 const projected=await projectView(env,[{factKey:'lb-out',links:{letterboxd:'out'},watched:{value:true},rating:{value:null}}]);
 assert.equal(projected.changed,1);
 const outside=await overlayView(env,{});
 assert.equal(outside.out.watched,true);
 assert.equal(outside.out.actualRating,null);
 const open=await readRatingsAuthority(db,env);
 const reverted=await revertMarker(env,{confirm:'r2',generation:open.generation});
 assert.equal(reverted.mode,'r2');
 assert.equal((await routeRead(env,'letterboxd/ratings/run.json')).handled,false);
}

{
 const db=load(chainNames);
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open', generation=3");
 const env={DB:db,BUCKET:bucket(),RATINGS_DB_REQUIRED:'on'};
 const expiresAt=new Date(Date.now()+60000).toISOString();
 const stale=await putOwned(env,'letterboxd/ratings/run.json',null,{schemaVersion:1,state:'idle'});
 assert.ok(stale.saved);
 env.BUCKET.records.set('letterboxd/ratings/run.json',{state:'idle'});
 const running=await putOwned(env,'letterboxd/ratings/run.json',stale.saved.etag,{schemaVersion:1,state:'running',lease:{step:'step-1',expiresAt}});
 assert.ok(running.saved);
 const live=await readRatingsRun(env);
 assert.equal(live.source,'d1');
 assert.equal(ratingsRunActivity(live.value,Date.now()),'active');
 assert.equal(ratingsRunActivity(env.BUCKET.records.get('letterboxd/ratings/run.json'),Date.now()),'idle');
 const copied=await listDocuments(env);
 assert.equal(copied.mode,'d1');
 const raced=await putOwned(env,'letterboxd/ratings/run.json',running.saved.etag,{schemaVersion:1,state:'running',lease:{step:'step-2',expiresAt},checkpoint:{diaryPagesRead:2}});
 assert.ok(raced.saved);
 await assert.rejects(revertMarker(env,{confirm:'r2',generation:copied.generation}),error=>error.code==='ratings_domain_fence');
 const still=await readRatingsAuthority(db,env);
 assert.equal(still.mode,'d1');
 assert.equal(still.cutover,'open');
 assert.equal((await routeRead(env,'letterboxd/ratings/run.json')).value.checkpoint.diaryPagesRead,2);
}

{
 const db=load(chainNames);
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open'");
 const env={DB:db,BUCKET:bucket(),RATINGS_DB_REQUIRED:'on'};
 const original=db.batch.bind(db);
 db.batch=async statements=>{
  const text=statements.map(item=>item.text).join('\n');
  if(text.includes('ratings_view')&&text.includes('ratings_document'))throw new Error('killed');
  return original(statements);
 };
 const at='2026-02-02T00:00:00.000Z';
 await assert.rejects(Facts.recordFilmFacts(env,'abc',{watched:false,rating:4},{observedAt:at,source:'owner'}));
 assert.equal(one(db,"SELECT COUNT(*) FROM ratings_document WHERE key='letterboxd/facts/films/lb-abc.json'"),0);
 assert.equal(one(db,'SELECT COUNT(*) FROM ratings_view'),0);
 db.batch=original;
 const batches=[];
 db.batch=async statements=>{batches.push(statements.map(item=>item.text).join('\n'));return original(statements);};
 const saved=await Facts.recordFilmFacts(env,'abc',{watched:false,rating:4},{observedAt:at,source:'owner'});
 assert.equal(saved.accepted,true);
 const joined=batches.filter(text=>text.includes('ratings_document')&&text.includes('ratings_view'));
 assert.equal(joined.length,1);
 const shown=await overlayView(env,{abc:{actualRating:9,watched:true,prediction:{predictedRating:1}}});
 assert.equal(shown.abc.watched,false);
 assert.equal(shown.abc.actualRating,4);
 assert.equal(shown.abc.prediction.predictedRating,1);
 const origPrepare=db.prepare.bind(db);
 let viewReads=0;
 db.prepare=sql=>{
  const prepared=origPrepare(sql);
  if(!String(sql).includes('FROM ratings_view WHERE alias_id'))return prepared;
  return {bind(...params){
   const statement=prepared.bind(...params);
   const all=statement.all.bind(statement);
   statement.all=async()=>{viewReads+=1;if(viewReads>1)throw new Error('projection_stopped');return all();};
   return statement;
  }};
 };
 await assert.rejects(Facts.recordFilmFacts(env,'zzz',{watched:true,rating:null},{observedAt:at,source:'owner'}));
 db.prepare=origPrepare;
 const kept=await overlayView(env,{});
 assert.equal(kept.zzz.watched,true);
 assert.equal(kept.zzz.actualRating,null);
 assert.equal(kept.abc.actualRating,4);
}

{
 const db=load(chainNames);
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 await assert.rejects(sealHeld({DB:db},{confirm:'seal-hold',generation:0}),error=>error.code==='ratings_domain_not_ready');
 await assert.rejects(importDocuments({DB:db},docs,{}),error=>error.code==='ratings_domain_not_confirmed');
}
