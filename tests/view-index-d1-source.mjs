// ADR 0183 / AIR-558: the D1-derived view index (the only view index since the selector was retired), on a real sqlite D1 stand-in with every migration applied and the production authorities
// (prediction d1, ratings d1 and open). Nothing here calls Cloudflare, TMDB or production. The raw object is put in the bucket where useful, only to prove it is never read or written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing,scopedEpgPriority,scopedDiscoveryAuthority,loadDiscoveryAuthority} from '../scripts/bundle-scope.mjs';
import {PREDICTION_OVERLAY_PAGE,PREDICTION_OVERLAY_ROWS} from '../src/prediction-d1.js';
import {compareMembership} from '../scripts/view-index-membership-parity.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-view-index-d1-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const IMPORT='const {database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const KEY='enrichment/view-index.json';
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
let databases=0;

function newDb(){
 const seen=[];
 const file=path.join(root,'v'+(databases++)+'.sqlite');
 const db=d1Standin(file,{onQuery:async text=>{seen.push(text);}});
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name,'utf8'));
 db.sql("UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;");
 return {db,seen,file};
}
const features=hash=>({fingerprintHash:hash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,invalidatedAt:null,plotMechanics:['heist'],moodLabels:['tense'],execution:{pace:'fast'}});
const display=n=>({predictedRating:3.5+(n%3)/2,generatedAt:'2026-11-0'+(1+n%8)+'T10:00:00.000Z',confidence:'medium'});
const pointerRow=(id,n)=>'('+[q(id),q('pv/'+id),q('s'+id),q('2026-11-01T00:00:00.000Z'),q(JSON.stringify(display(n)))].join(',')+')';
const fingerprintRow=(id,n)=>'('+[q(id),q('fp-'+n),1,1,q('fpb/'+id),q('s'+id),q(JSON.stringify(features('fp-'+n)))].join(',')+')';
const insert=(db,table,columns,rows)=>{for(let s=0;s<rows.length;s+=400)db.sql('INSERT INTO '+table+' ('+columns+') VALUES '+rows.slice(s,s+400).join(',')+';');};
const addPointers=(db,ids)=>insert(db,'prediction_pointer','film_id,r2_key,content_sha256,updated_at,display_json',ids.map((id,n)=>pointerRow(id,n)));
const addFingerprints=(db,ids)=>insert(db,'prediction_fingerprint','film_id,fingerprint_hash,schema_version,prompt_version,r2_key,content_sha256,features_json',ids.map((id,n)=>fingerprintRow(id,n)));
const addRatings=(db,rows)=>insert(db,'ratings_view','alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at',rows.map(row=>'('+[q(row.id),q('f-'+row.id),row.watched??'NULL',row.rating??'NULL',row.watchlist??'NULL',row.known??1,q('2026-11-01T00:00:00.000Z')].join(',')+')'));

// ---- the Worker, loaded as the tests do: the D1 modules scoped, then the sources and the entry module.
function worldFor({seed={}}={}){
 const fetches=[];
 const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ReadableStream,crypto:webcrypto,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:seed,fetch:async input=>{fetches.push(String(input));return new Response('unexpected',{status:599});}});
 vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),world);
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),world);
 vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),world);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),world);
 vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);vm.runInContext(scopedEpgPriority(),world);loadDiscoveryAuthority(script=>vm.runInContext(script,world));
 vm.runInContext(scoped('src/prediction-d1.js','PredictionD1'),world);vm.runInContext(scoped('src/ratings-d1.js','RatingsD1'),world);
 for(const source of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(source,'utf8').replace('export default','globalThis.worker='),world);
 return {world,fetches,run:expression=>vm.runInContext(expression,world)};
}
// A bucket that records every read and refuses every write; the raw view index is whatever the test stores.
function bucketFor(store){
 const gets=[],writes=[];
 return {gets,writes,bucket:{
  async get(key){gets.push(key);const value=store.get(key);if(value===undefined)return null;const text=JSON.stringify(value);return {etag:'e-'+key,size:text.length,json:async()=>JSON.parse(text),text:async()=>text};},
  async head(key){return store.has(key)?{etag:'e'}:null;},
  async put(key,value){writes.push('put:'+key);store.set(key,JSON.parse(String(value)));return {etag:'e2'};},
  async delete(key){writes.push('delete:'+key);throw new Error('no delete');},async list(){return {objects:[],truncated:false};},
 }};
}
const readsOnly=seen=>seen.every(text=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text));
const sortKeys=object=>Object.keys(object).sort();

// ---- 1. The fixture: one world whose raw index holds exactly the D1 key set, with stale facts that must never be served.
//   pointer + fingerprint: 101, 102   pointer only: 103   fingerprint only: 104   ratings only: 105 (explicit null), 106 (unknown rating, watchlist), L_r1 (a lid alias)
const D1_IDS=['tmdb_101','tmdb_102','tmdb_103','tmdb_104','tmdb_105','tmdb_106','L_r1'];
function buildWorld({rawExtra={},raw=true}={}){
 const {db,seen,file}=newDb();
 addPointers(db,['tmdb_101','tmdb_102','tmdb_103']);addFingerprints(db,['tmdb_101','tmdb_102','tmdb_104']);
 addRatings(db,[{id:'tmdb_101',watched:1,rating:4,known:1},{id:'L_r1',watched:1,rating:3,known:1},{id:'tmdb_105',watched:1,rating:null,known:1},{id:'tmdb_106',watched:null,rating:null,watchlist:1,known:0}]);
 const store=new Map();
 if(raw){
  const stale={prediction:{stale:true},fingerprint:{stale:true},fingerprintHash:'stale',impactFeatures:{stale:true},moodFacet:{stale:true},actualRating:1,watched:false,watchlist:false};
  store.set(KEY,{...Object.fromEntries(D1_IDS.map(id=>[id,{...stale}])),...rawExtra});
 }
 return {db,seen,file,store};
}
const envFor=({db,bucket},extra={})=>({DB:db,BUCKET:bucket,PREDICTION_DB_REQUIRED:'on',RATINGS_DB_REQUIRED:'on',...extra});

{
 const w=buildWorld();const {gets,writes,bucket}=bucketFor(w.store);const {run}=worldFor();
 const loadJSON=run('loadJSON'),derivedViewIndex=run('derivedViewIndex');

 // AIR-558: no selector and no raw writers exist any more; whatever binding is present changes nothing.
 for(const name of ['viewIndexSource','viewIndexIsD1','updateViewIndex','ensureInitialRatings','moodBackfill','backfillFingerprintView'])assert.equal(run('typeof '+name),'undefined',name+' is gone');

 const viaD1=await loadJSON(envFor({db:w.db,bucket}),KEY);
 assert.equal(gets.includes(KEY),false,'the view index never reads the raw object, even when one is stored');
 assert.deepEqual(gets,[],'and reads nothing else of R2');
 assert.ok(w.seen.length>0&&readsOnly(w.seen),'only reads reached D1: '+w.seen.filter(text=>!/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text)).join(' | '));
 assert.deepEqual(writes,[],'no R2 write');
 for(const value of ['d1','r2','D1',' d1','on','',undefined]){
  const same=await loadJSON(envFor({db:w.db,bucket},value===undefined?{}:{VIEW_INDEX_SOURCE:value}),KEY);
  assert.deepEqual(same,viaD1,JSON.stringify(value)+': a leftover VIEW_INDEX_SOURCE binding is inert');
 }
 assert.equal(gets.includes(KEY),false);
 assert.deepEqual(sortKeys(viaD1),[...D1_IDS].sort(),'the key set is the union of the three tables');
 // Fields come from D1: pointer -> prediction, fingerprint -> fingerprint/hash/impact features, either -> mood facet; ratings -> watched, rating, watchlist.
 assert.ok(viaD1.tmdb_101.prediction&&viaD1.tmdb_101.fingerprint&&viaD1.tmdb_101.impactFeatures&&viaD1.tmdb_101.moodFacet,'both rows');
 assert.ok(viaD1.tmdb_103.prediction&&!viaD1.tmdb_103.fingerprint&&!viaD1.tmdb_103.fingerprintHash,'pointer only: a forecast, no features');
 assert.ok(!viaD1.tmdb_104.prediction&&viaD1.tmdb_104.fingerprint&&viaD1.tmdb_104.fingerprintHash&&viaD1.tmdb_104.impactFeatures,'fingerprint only: features, no forecast');
 assert.equal(viaD1.tmdb_101.actualRating,4);assert.equal(viaD1.tmdb_101.watched,true);assert.equal(viaD1.tmdb_101.watchlist,undefined);
 assert.ok(Object.hasOwn(viaD1.tmdb_105,'actualRating')&&viaD1.tmdb_105.actualRating===null,'an explicit null rating stays an own null');
 assert.equal(Object.hasOwn(viaD1.tmdb_106,'actualRating'),false,'an unknown rating stays absent');assert.equal(viaD1.tmdb_106.watchlist,true);
 assert.equal(viaD1.L_r1.actualRating,3,'a lid alias keeps its own spelling');assert.equal(Object.hasOwn(viaD1.L_r1,'prediction'),false);
 assert.equal(JSON.stringify(viaD1).includes('stale'),false,'no raw fact is ever served');

 // The token changes whenever either domain commits.
 const version=run('viewIndexD1Version');
 const token=await version(envFor({db:w.db,bucket}));
 assert.match(token,/^d1:p\d+\.q\d+\.r\d+$/);
 w.db.sql('UPDATE prediction_domain_authority SET generation=generation+1 WHERE id=1');
 const afterPrediction=await version({...envFor({db:w.db,bucket})});
 assert.notEqual(afterPrediction,token,'a prediction commit moves the token');
 w.db.sql('UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1');
 assert.notEqual(await version(envFor({db:w.db,bucket})),afterPrediction,'a ratings commit moves the token');

 // The Letterboxd facts reader has only ever applied the ratings overlay: ratings aliases only, prediction tables untouched.
 w.seen.length=0;
 const ratingsOnly=await derivedViewIndex(envFor({db:w.db,bucket}),{ratingsOnly:true});
 assert.deepEqual(sortKeys(ratingsOnly),['L_r1','tmdb_101','tmdb_105','tmdb_106']);
 for(const entry of Object.values(ratingsOnly))for(const field of ['prediction','fingerprint','fingerprintHash','impactFeatures','moodFacet'])assert.equal(Object.hasOwn(entry,field),false,field);
 assert.equal(w.seen.some(text=>/prediction_pointer|prediction_fingerprint/.test(text)),false,'the ratings-only reader reads no prediction table');
}

// ---- 2. The membership classifier (an offline operator tool, ADR 0183) still agrees with the derived key set; the raw object is only its input, never read by the Worker.
{
 const w=buildWorld();
 // 'tmdb_900' would be a raw key with no D1 row; 'tmdb_103' and 'tmdb_104' are D1 ids that raw object lacks.
 const raw={tmdb_101:{},tmdb_102:{},tmdb_105:{},tmdb_106:{},L_r1:{},tmdb_900:{actualRating:5}};
 const store=new Map([[KEY,raw]]);
 const {gets,bucket}=bucketFor(store);const {run}=worldFor();const loadJSON=run('loadJSON');
 const d1View=await loadJSON(envFor({db:w.db,bucket}),KEY);
 const report=compareMembership({raw,predictionPointerIds:['tmdb_101','tmdb_102','tmdb_103'],predictionFingerprintIds:['tmdb_101','tmdb_102','tmdb_104'],ratingsRows:[{alias_id:'tmdb_101',rating_known:1,actual_rating:4},{alias_id:'L_r1',rating_known:1,actual_rating:3},{alias_id:'tmdb_105',rating_known:1,actual_rating:null},{alias_id:'tmdb_106',rating_known:0,actual_rating:null}],seed:{}});
 assert.deepEqual(report.removedKeys,['tmdb_900']);assert.deepEqual(report.newKeys,['tmdb_103','tmdb_104']);
 assert.equal(Object.hasOwn(d1View,'tmdb_900'),false,'a raw-only key is not a key');
 assert.deepEqual(sortKeys(d1View).filter(key=>!Object.hasOwn(raw,key)),report.newKeys,'the classifier predicts the keys the derived index has and the raw object lacks');
 assert.equal(gets.includes(KEY),false,'the raw object is not read');
 assert.ok(d1View.tmdb_103.prediction&&!d1View.tmdb_103.fingerprint,'forecast gain: a forecast and no features');
 assert.ok(d1View.tmdb_104.fingerprint&&!d1View.tmdb_104.prediction,'feature gain: features and no forecast');
}

// ---- 3. The compiled seed is a separate layer applied after the facts.
{
 const seed={tmdb_105:5,tmdb_106:2,tmdb_101:1,seedOnly:4};
 const w=buildWorld();const {bucket}=bucketFor(w.store);const {run}=worldFor({seed});
 const readViewIndex=run('readViewIndex');
 const viaD1=await readViewIndex(envFor({db:w.db,bucket}));
 assert.equal(viaD1.tmdb_105.actualRating,null,'an own null wins over the seed');
 assert.equal(viaD1.tmdb_106.actualRating,2,'an unknown rating takes the seed');
 assert.equal(viaD1.tmdb_101.actualRating,4,'a ratings_view rating wins over the seed');
 assert.deepEqual(JSON.parse(JSON.stringify(viaD1.seedOnly)),{actualRating:4},'a seed-only id creates a key');
 // The classifier agrees with this view on the seed categories.
 const report=compareMembership({raw:Object.keys(w.store.get(KEY)),predictionPointerIds:['tmdb_101','tmdb_102','tmdb_103'],predictionFingerprintIds:['tmdb_101','tmdb_102','tmdb_104'],ratingsRows:[{alias_id:'tmdb_101',rating_known:1,actual_rating:4},{alias_id:'L_r1',rating_known:1,actual_rating:3},{alias_id:'tmdb_105',rating_known:1,actual_rating:null},{alias_id:'tmdb_106',rating_known:0,actual_rating:null}],seed});
 assert.deepEqual(report.seed.nullWins,['tmdb_105']);assert.deepEqual(report.seed.ratingsWin,['tmdb_101']);assert.deepEqual(report.seed.fills,['seedOnly','tmdb_106']);assert.deepEqual(report.seed.onlyKeys,['seedOnly']);
}

// ---- 4. The footer reader: the derived projection, with no raw read.
{
 const w=buildWorld();const {gets,writes,bucket}=bucketFor(w.store);const {run}=worldFor({seed:{seedOnly:4,tmdb_106:2}});
 const footerViewIndex=run('footerViewIndex');
 w.seen.length=0;
 const viaD1=await footerViewIndex(envFor({db:w.db,bucket}));
 assert.equal(gets.includes(KEY),false,'the footer does not read the raw object');assert.deepEqual(writes,[]);
 assert.ok(readsOnly(w.seen));
 assert.deepEqual(sortKeys(viaD1),[...D1_IDS].sort());
 assert.equal(JSON.stringify(viaD1).includes('moodFacet'),false,'the footer keeps only what its blocks read');
 assert.equal(JSON.stringify(viaD1).includes('stale'),false);
 // An authority that moved before the footer's read is a refusal, never a silent raw fallback.
 w.db.sql("UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 gets.length=0;
 await assert.rejects(footerViewIndex(envFor({db:w.db,bucket})),error=>error.code==='ratings_domain_not_authoritative');
 assert.equal(gets.includes(KEY),false,'a refusal does not read the raw object either');
}

// ---- 5. Fail closed: no silent fallback to the raw object.
{
 const w=buildWorld();const {gets,bucket}=bucketFor(w.store);const {run}=worldFor();const loadJSON=run('loadJSON');
 const d1=extra=>({...envFor({db:w.db,bucket}),...extra});
 // No D1 binding: the prediction domain is not authoritative.
 await assert.rejects(loadJSON({BUCKET:bucket},KEY),error=>/^(ratings|prediction)_domain_/.test(error.code));
 // A ratings cutover that is held, or a prediction marker that is not d1, refuses.
 w.db.sql("UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 await assert.rejects(loadJSON(d1(),KEY),error=>error.code==='ratings_domain_not_authoritative');
 w.db.sql("UPDATE ratings_domain_authority SET cutover='open' WHERE id=1;UPDATE prediction_domain_authority SET mode='r2' WHERE id=1");
 await assert.rejects(loadJSON(d1(),KEY),error=>error.code==='prediction_domain_unavailable');
 w.db.sql("UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 assert.equal(gets.includes(KEY),false,'no refusal fell back to the raw object');
 // A malformed row is a refusal.
 w.db.sql("UPDATE prediction_pointer SET display_json='{' WHERE film_id='tmdb_101'");
 await assert.rejects(loadJSON(d1(),KEY),error=>error.code==='prediction_domain_unavailable');
 assert.equal(gets.includes(KEY),false);
}

// ---- 6. Bounded: keyset pages, the table cap, and the page-boundary counts.
{
 const {run}=worldFor();
 const page=PREDICTION_OVERLAY_PAGE;
 for(const rows of [0,1,page-1,page,page+1,2*page,2*page+1]){
  const w=buildWorld({raw:false});
  const ids=Array.from({length:rows},(_,n)=>'tmdb_'+String(2000000+n*3));
  addPointers(w.db,ids);addFingerprints(w.db,ids.slice().reverse());
  const {bucket}=bucketFor(new Map());
  w.seen.length=0;
  const derived=await run('derivedViewIndex')(envFor({db:w.db,bucket}));
  const expected=new Set([...ids,...D1_IDS.filter(id=>id.startsWith('tmdb_105')||id==='tmdb_106'||id==='L_r1'||id==='tmdb_101')]);
  // buildWorld already holds 101..104 and the ratings fixture; the generated ids add to them.
  assert.equal(Object.keys(derived).filter(id=>ids.includes(id)).length,rows,rows+' generated films: every key exactly once');
  assert.equal(new Set(Object.keys(derived)).size,Object.keys(derived).length);
  // Statements: one per page per table, +1 for the final short page; the pointer and fingerprint tables hold rows+3 each.
  const perTable=Math.floor((rows+3)/page)+1,ratingsPages=Math.floor(4/page)+1;
  const selects=w.seen.filter(text=>/FROM (prediction_pointer|prediction_fingerprint|ratings_view)\b/.test(text)).length;
  assert.equal(selects,2*perTable+ratingsPages,rows+' rows: '+selects+' keyset statements');
  assert.ok(expected.size>0);
 }
 // A table above the cap is refused and nothing is returned.
 const big=buildWorld({raw:false});
 big.db.sql('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<'+(PREDICTION_OVERLAY_ROWS+1)+") INSERT INTO prediction_pointer (film_id,r2_key,content_sha256,updated_at,display_json) SELECT 'tmdb_'||(5000000+x),'pv/'||x,'s'||x,'2026-11-01T00:00:00.000Z','{}' FROM c;");
 const {gets:bigGets,bucket:bigBucket}=bucketFor(new Map());
 await assert.rejects(run('derivedViewIndex')(envFor({db:big.db,bucket:bigBucket})),error=>error.code==='prediction_domain_budget'&&error.guard==='overlay_rows');
 assert.deepEqual(bigGets,[],'the budget refusal reads no raw object');
}

// ---- 7. The raw writers are gone: a prediction/fingerprint write leaves the raw object alone (it is not written, not even created).
{
 const w=buildWorld();const {writes,bucket}=bucketFor(w.store);const {run}=worldFor();
 assert.equal(run('typeof updateViewIndex'),'undefined');assert.equal(run('typeof ensureInitialRatings'),'undefined');
 const before=JSON.stringify(w.store.get(KEY));
 // A Letterboxd projection that the ratings domain does not own refuses; it never writes the raw object.
 w.db.sql("UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");
 const facts=run('LetterboxdFacts');
 // A held cutover is refused by the ratings domain itself (as before AIR-558); neither outcome writes the raw object.
 await facts.projectRecords(envFor({db:w.db,bucket}),[{links:{letterboxd:'L_new',tmdb:null},rating:{value:4}}]).then(projected=>assert.equal(projected.changed,0),error=>assert.match(error.code,/^ratings_domain_/));
 assert.deepEqual(writes,[],'no R2 write');assert.equal(JSON.stringify(w.store.get(KEY)),before,'the raw object is unchanged');
}

// ---- 8. The Letterboxd facts reader: the ratings overlay only, never the raw object.
{
 const w=buildWorld();const {gets,bucket}=bucketFor(w.store);const {run}=worldFor();
 const facts=run('LetterboxdFacts');
 const groups={added:[{id:'L_r1'},{id:'tmdb_106'}],updated:[{id:'tmdb_101',rating:4},{id:'L_r1',rating:2}]};
 w.seen.length=0;
 const viaD1=await facts.confirmDiaryEffects(envFor({db:w.db,bucket}),groups);
 assert.equal(gets.includes(KEY),false,'the facts reader does not read the raw object');
 assert.equal(w.seen.some(text=>/prediction_pointer|prediction_fingerprint/.test(text)),false,'and never the prediction tables');
 assert.deepEqual(JSON.parse(JSON.stringify(viaD1)),{added:[{id:'L_r1'}],updated:[{id:'tmdb_101',rating:4}]});
 // Held ratings refuse rather than answering from the raw object.
 w.db.sql("UPDATE ratings_domain_authority SET cutover='held' WHERE id=1");gets.length=0;
 await assert.rejects(facts.confirmDiaryEffects(envFor({db:w.db,bucket}),groups),error=>error.code==='ratings_domain_not_authoritative');
 assert.equal(gets.includes(KEY),false);
}

console.log('View index D1 source: single D1 path, inert leftover binding, classifier agreement, seed layer, footer, fail-closed refusals, bounded keyset pages, retired raw writers and the facts reader passed');
