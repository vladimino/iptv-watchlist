// AIR-519: GET /api/enrichment/footer/status exceeded the Worker memory limit after the Film/Person `open` (16 November 2026). The D1 metadata read scanned every
// external-id row once per requested id (quadratic: tens of seconds of CPU on the real catalogue) while the footer held the view index, the catalog, the
// programme and the watchlist whole, read together. These checks prove that the bounded version answers exactly what the old one did:
//  1. catalogMetadataFromD1 equals the pre-AIR-519 algorithm (rebuilt from the current source by undoing the two replacements) on a D1 with conflicts,
//     Letterboxd bridges, spelled tmdb ids and missing films;
//  2. canonicalCoverageSummary equals the clone-based version it replaced, with and without the completed-only rule;
//  3. the footer's projected blocks equal the same functions run on the whole documents, and the footer writes nothing;
//  4. (non-functional) the production-sized reproduction answers within a bounded heap and CPU, several requests at once (scripts/footer-memory-profile.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing,scopedEpgPriority,scopedDiscoveryAuthority,loadDiscoveryAuthority} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {nodeSqliteOrSkip,nonFunctional} from './suite-gate.mjs';

const IMPORT='const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-footer-memory-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const T='2026-11-16T10:00:00.000Z',now=Date.now(),H=3600000,G1='22222222-2222-4222-8222-222222222222';
const q=value=>value==null?'NULL':"'"+String(value).replace(/'/g,"''")+"'";

// ---- a small Film/Person D1 with every identity case the metadata read distinguishes ----
const N=240,tmdbOf=i=>String(500+i),lidOf=i=>'lid-'+i;
const file=path.join(root,'d1.sqlite');
let seed=names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+'\nBEGIN;\n';
const ext=(film,scheme,value,trusted=1,conflicting=0)=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES (${q(film)},${q(scheme)},${q(value)},${trusted},${conflicting},NULL);\n`;
for(let i=0;i<N;i++){
 // Most Films are spelled film:tmdb:<n>; every fifth is a Letterboxd Film film:<lid> that also claims its TMDB id.
 const lid=i%5===0?lidOf(i):null,id=lid?'film:'+lid:'film:tmdb:'+tmdbOf(i);
 seed+=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,${q('tmdb:'+tmdbOf(i))},${q('Original '+i)},${q(T)});\n`;
 seed+=ext(id,'tmdb',tmdbOf(i));
 if(lid)seed+=ext(id,'letterboxd',lid);
 if(i%3===0)seed+=`INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES (${q(id)},1,${1950+i%70},NULL,NULL,${q('https://a.example/'+i+'.jpg')},${q('https://letterboxd.com/film/'+(lid||i)+'/')},'[]',NULL,'{}',NULL,NULL,${q(T)});\n`;
 if(i%4!==1)seed+=`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES (${q(id)},'localization',${q(i%8===0?'reviewed':'provisional')},'wikidata','p','{"sources":[]}',${q('Название '+i)},'automatic',${q(T)});\n`;
}
// Conflicts (D1 allows one trusted, non-conflicting row per scheme and value): an untrusted second claim of a TMDB id, a conflicting claim of another Film's
// TMDB id, a conflicting second claim of a Letterboxd id, an untrusted second TMDB id of one Film.
seed+=ext('film:tmdb:'+tmdbOf(1),'tmdb',tmdbOf(2),0,0);
seed+=ext('film:tmdb:'+tmdbOf(8),'tmdb',tmdbOf(7),1,1);
seed+=ext('film:tmdb:'+tmdbOf(11),'letterboxd',lidOf(10),1,1);
seed+=ext('film:tmdb:'+tmdbOf(13),'tmdb',tmdbOf(14),0,0);
seed+='COMMIT;\n'+OPEN;
sqlite(file,seed);seed=null;

const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ReadableStream,crypto:webcrypto,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>{throw new Error('the footer makes no request');}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);
vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),ctx);
// The pre-AIR-519 metadata read: the same source with the two replacements undone (every claim scans all external rows; `missing` scans the key list).
const reader=fs.readFileSync('src/canonical-catalog-reader.js','utf8');
const legacySource=reader.replace(/^\s*import\s+\{[^}]+\}\s+from\s+['"][^'"]+['"];?\r?\n/gm,IMPORT)
 .replace('const asked=new Set(unique),missing=[...new Set(extra.map(row=>row.film_id).filter(id=>!asked.has(id)))];','const missing=[...new Set(extra.map(row=>row.film_id).filter(id=>!unique.includes(id)))];')
 .replace(/claimOf\(/g,'identityClaim(externals,');
assert.notEqual(legacySource,reader,'the legacy oracle differs from the current reader');
assert.ok(!/claimOf\(|asked\.has/.test(legacySource.slice(legacySource.indexOf('export async function catalogMetadataFromD1'),legacySource.indexOf('export const CANONICAL_READER_REGISTRY'))),'the legacy oracle scans every row, as before AIR-519');
vm.runInContext('const LegacyCatalogReader=(()=>{\n'+legacySource.replace(/^export\s+/gm,'')+'\nreturn {catalogMetadataFromD1};\n})();',ctx);
vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const source of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(source,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx); // AIR-558: the footer view index is derived from D1 in production; here the fixture object in the fake bucket stands in for it

// ---- 1. the D1 metadata read: same records as the quadratic version ----
const reads=[];
const db=d1Standin(file,{onQuery:async text=>{reads.push(text);}});
const gate=await vm.runInContext('CanonicalCatalogReader.catalogReaderGate',ctx)({DB:db});
assert.equal(gate.mode,'d1','the Film/Person domain is open');
const asked=[];
for(let i=0;i<N+20;i++){asked.push('tmdb_'+tmdbOf(i));if(i%5===0)asked.push(lidOf(i));if(i%17===0)asked.push('unknown-'+i);}
asked.push(lidOf(10),'tmdb_'+tmdbOf(2),'tmdb_'+tmdbOf(14),'','tmdb_0');
const current=await vm.runInContext('CanonicalCatalogReader.catalogMetadataFromD1',ctx)({DB:db},asked,gate);
const legacy=await vm.runInContext('LegacyCatalogReader.catalogMetadataFromD1',ctx)({DB:db},asked,gate);
assert.deepEqual(JSON.parse(JSON.stringify(current)),JSON.parse(JSON.stringify(legacy)),'the indexed claims give the records of the full scan');
const blocked=Object.values(current).filter(record=>record.identityBlocked===true).length,bridged=Object.entries(current).filter(([id,record])=>id.startsWith('lid-')&&record.tmdbId).length;
assert.ok(blocked>=3,'conflicting, untrusted and doubled claims stay blocked: '+blocked);
assert.ok(bridged>=40,'Letterboxd ids keep their TMDB bridge: '+bridged);
assert.ok(reads.every(text=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text)),'the metadata read only selects');
// The identity-only read (the footer's) gives the same id, tmdbId and identityBlocked as the full read, without titles, posters or urls.
const identity=await vm.runInContext('CanonicalCatalogReader.catalogMetadataFromD1',ctx)({DB:db},asked,gate,{identityOnly:true});
const identityOf=records=>Object.fromEntries(Object.entries(JSON.parse(JSON.stringify(records))).map(([id,record])=>[id,Object.fromEntries(['id','tmdbId','identityBlocked'].filter(key=>Object.hasOwn(record,key)).map(key=>[key,record[key]]))]));
assert.deepEqual(JSON.parse(JSON.stringify(identity)),identityOf(current),'identity-only records equal the identity of the full records');
assert.ok(Object.values(identity).every(record=>!Object.hasOwn(record,'title')&&!Object.hasOwn(record,'poster')),'no title or poster is read');

// ---- 2. coverage without per-film copies equals the overlay version ----
function legacyCoverage(report,catalog,index,profile,at,freshness,completedOnly){
 const groups=new Map(),completed=completedOnly?ctx.completedShowsByTmdb(report):null;
 const overlay=film=>completedOnly&&completed!=null?ctx.withCompletedShows(film,completed,report?.runId,true):film;
 for(const film of [...(report?.films||[]),...Object.values(catalog||{})].map(overlay)){
  const tmdbId=String(film?.tmdbId||'').trim();if(!tmdbId)continue;
  const identity='tmdb:'+tmdbId,group=groups.get(identity)||{ids:new Set(),films:[]};
  group.ids.add(String(film.id));group.films.push(film);group.byId=group.byId||new Map();if(!group.byId.has(String(film.id)))group.byId.set(String(film.id),film);groups.set(identity,group);
 }
 let currentPredictionsTotal=0,windowFilmsTotal=0,windowCurrentPredictions=0,cacheOffWindowTotal=0,pendingOffWindowTotal=0;
 for(const group of groups.values()){
  const isCurrent=[...group.ids].some(id=>freshness.indexed(index?.[id],group.byId.get(id))),inWindow=group.films.some(film=>ctx.filmIsHot(film,at));
  if(isCurrent)currentPredictionsTotal++;
  if(inWindow){windowFilmsTotal++;if(isCurrent)windowCurrentPredictions++;}else{cacheOffWindowTotal++;if(!isCurrent)pendingOffWindowTotal++;}
 }
 return {confirmedFilmsTotal:groups.size,currentPredictionsTotal,windowFilmsTotal,windowCurrentPredictions,cacheOffWindowTotal,pendingOffWindowTotal};
}
// Showings sit at least two hours away from either end of the 72 h / 24 h window, so a test that runs slowly cannot move a film across it.
const showAt=k=>{const start=now+[-100,-60,-2,3,20,40,-80][k%7]*H;return {channelId:'c'+k%9,channel:'C',start,end:start+H};};
const profile={version:7,profileHash:'p7',updatedAt:T,profile:{}};
const prediction=(rating,chance,version=7)=>({predictedRating:rating,probability4Plus:chance,confidence:'high',matchSignals:['x'],mainRisk:'y',tasteProfileVersion:version,tasteProfileHash:'p'+version,fingerprintHash:'f',fingerprintSchemaVersion:vm.runInContext('FINGERPRINT_SCHEMA_VERSION',ctx),predictionPromptVersion:vm.runInContext('PREDICTION_PROMPT_VERSION',ctx)});
const catalog={},index={},programmeFilms=[],catalogFilms=[],watchlistFilms=[];
for(let i=0;i<N;i++){
 const id='tmdb_'+tmdbOf(i);
 catalog[id]={id,tmdbId:tmdbOf(i),canonicalIdentity:i%29===0?null:'tmdb:'+tmdbOf(i),title:'T'+i,original:'O'+i,overview:'long text '.repeat(20),genres:[['Drama'],['Comedy'],[]][i%3],actors:['a','b'],directors:['d'],shows:i%4===0?[]:[showAt(i),showAt(i+3)],showsProgrammeRunId:G1};
 if(i%6===0)catalogFilms.push({id,tmdbId:tmdbOf(i),title:'T'+i,shows:[showAt(i+1)]});
 if(i%9===0)programmeFilms.push({...catalog[id],catalogOnly:true,shows:[showAt(i+2)]});
 const item={fingerprintHash:'f',fingerprint:{plotMechanics:['p'],moodLabels:['m'],execution:{},fingerprintHash:'f'},impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:vm.runInContext('FINGERPRINT_SCHEMA_VERSION',ctx),fingerprintPromptVersion:1},moodFacet:{rawLabels:['m'],moodIds:['calm'],mapping:[],unmapped:[]}};
 if(i%10!==3)item.prediction=prediction(3.6+(i%15)/10,(i%10)/10,i%13===0?6:7);
 if(i%11===0){item.watched=true;item.actualRating=i%22===0?null:4;}
 if(i%17===0)item.watchlist=false;
 index[id]=item;
}
for(let i=0;i<60;i++){
 const lid=i<40?lidOf(i*5):'only-'+i,film={id:lid,tmdbId:i%7===0?null:tmdbOf(i*5),title:'W'+i,original:'W'+i,poster:'p',url:'u',overview:'text '.repeat(30),genres:['Drama']};
 watchlistFilms.push(film);if(i%2===0)programmeFilms.push({...film,shows:[showAt(i)]});
 index[lid]={watched:i%3===0,actualRating:i%4===0?3.5:undefined,watchlist:true};
 if(index[lid].actualRating===undefined)delete index[lid].actualRating;
}
const programme={runId:G1,updatedAt:T,watchlistCount:watchlistFilms.length,watchlistUpdatedAt:T,films:programmeFilms,catalogFilms,stats:{epgStart:T,epgEnd:T,channels:9,scanned:900,titleMissing:1,titleProvisional:2,metadataMissing:3}};
const watchlist={updatedAt:T,films:watchlistFilms};
const freshness=await ctx.predictionFreshness({},profile);
for(const completedOnly of [false,true]){
 const at=Date.now();
 const expected=legacyCoverage(programme,catalog,index,profile,at,freshness,completedOnly);
 assert.deepEqual({...ctx.canonicalCoverageSummary(programme,catalog,index,profile,at,freshness,completedOnly)},expected,'coverage, completedOnly='+completedOnly);
 assert.ok(expected.windowFilmsTotal>0&&expected.cacheOffWindowTotal>0&&expected.currentPredictionsTotal>0,'the fixture reaches every coverage branch');
}

// ---- 3. the footer: projected blocks equal the blocks of the whole documents ----
const records=new Map([
 ['epg/published-generation.json',{phase:'published',programmeRunId:G1}],
 ['epg/discovered-films.json',catalog],['epg/generations/'+G1+'/discovered-films.json',catalog],
 ['programme.json',programme],['epg/generations/'+G1+'/programme.json',programme],
 ['watchlist.json',watchlist],['epg/generations/'+G1+'/watchlist.json',watchlist],
 ['enrichment/profile/current.json',profile],['enrichment/view-index.json',index],
 ['enrichment/prediction-queue.json',{schemaVersion:3,programmeRunId:G1,pending:['tmdb_500'],hotPending:['tmdb_500'],coldPending:[],priorityCount:1,coldRemaining:0,retries:{}}],
 ['sync.json',{stage:'complete',runId:G1,completedAt:T,updatedAt:T}],
 ['enrichment/latest-run.json',{runId:'r1',status:'complete',createdAt:T,completedAt:T,results:{},selectedIds:[],batchCount:1}],
]);
const writes=[];
const bucket={
 async get(key){const value=records.get(key);if(value===undefined)return null;const text=JSON.stringify(value);return {etag:'e',size:text.length,json:async()=>JSON.parse(text),text:async()=>text};},
 async head(key){return records.has(key)?{etag:'e'}:null;},
 async put(key){writes.push('put:'+key);throw new Error('no R2 write from a GET');},async delete(key){writes.push('delete:'+key);throw new Error('no R2 delete from a GET');},
 async list(){return {objects:[],truncated:false};},
};
const footer=async env=>{const response=await ctx.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/footer/status'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
reads.length=0;
const answer=await footer({BUCKET:bucket,DB:db});
assert.equal(answer.status,200,JSON.stringify(answer.body));
assert.equal(Object.hasOwn(answer.body,'degraded'),false,'nothing degraded: '+JSON.stringify(answer.body.degraded));
assert.deepEqual(writes,[],'no R2 write');
assert.ok(reads.length>0&&reads.every(text=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text)),'only SELECTs reached D1');
const metadata=await vm.runInContext('CanonicalCatalogReader.catalogMetadataFromD1',ctx)({DB:db},ctx.canonicalIdentityIds([programme,catalog,watchlist,index]),gate);
const whole={report:programme,catalog,watchlist,index,metadata};
assert.deepEqual(answer.body.collection,{...ctx.footerCollection(whole)},'collection');
assert.deepEqual(answer.body.recommendations.newUnseen,{...ctx.footerNewUnseen({...whole,profile,freshness})},'new and interesting');
const coverage=ctx.canonicalCoverageSummary(programme,catalog,index,profile,Date.now(),freshness,false);
for(const [key,value] of Object.entries(coverage))assert.equal(answer.body.coverage[key],value,'coverage.'+key);
assert.equal(answer.body.collection.state,'ok');assert.ok(answer.body.collection.total>N,'a real union: '+answer.body.collection.total);
assert.ok(answer.body.recommendations.newUnseen.rating40to44+answer.body.recommendations.newUnseen.rating45plus>0,'some films pass the recommendation floor');
assert.equal(answer.body.watchlist.films,watchlistFilms.length);assert.equal(answer.body.epgTmdb.checkedTransmissions,900);

// The projections keep what the blocks read and drop the rest.
const projectedIndex=ctx.footerIndexProjection(index),projectedCatalog=ctx.footerCatalogProjection(catalog,true),projectedReport=ctx.footerProgrammeProjection(programme);
assert.equal(projectedIndex['tmdb_500'].fingerprint,undefined);assert.equal(projectedIndex['tmdb_500'].moodFacet,undefined);assert.deepEqual(projectedIndex['tmdb_500'].prediction,index['tmdb_500'].prediction);
assert.equal(Object.hasOwn(projectedIndex[lidOf(5)],'actualRating'),false,'an absent rating stays absent (the ratings seed is read only then)');
assert.equal(Object.hasOwn(projectedIndex['tmdb_'+tmdbOf(22)],'actualRating'),true,'a recorded null rating stays recorded');
assert.equal(projectedCatalog['tmdb_501'].overview,undefined);assert.deepEqual(JSON.parse(JSON.stringify(projectedCatalog['tmdb_501'].shows)),catalog['tmdb_501'].shows.map(show=>({start:show.start})),'a showing keeps only the start filmIsHot reads');
assert.equal(ctx.footerCatalogProjection(catalog,false)['tmdb_501'].shows,undefined,'under the completed-only rule a catalog record keeps no showings');
assert.deepEqual(projectedReport.stats,programme.stats);assert.equal(projectedReport.films[0].title,undefined);
assert.ok(JSON.stringify(projectedIndex).length<JSON.stringify(index).length*0.8,'the projection is smaller');

// A malformed stored record leaves its block unknown instead of failing the route.
records.set('enrichment/prediction-queue.json',{schemaVersion:3,priorityCount:1});
records.set('enrichment/latest-run.json',{runId:'r1',status:'complete',createdAt:T});
const malformed=await footer({BUCKET:bucket,DB:db});
assert.equal(malformed.status,200,'a queue without pending and a run without selectedIds no longer answer 502');
assert.ok(malformed.body.degraded.includes('queue_view')&&malformed.body.degraded.includes('run'),JSON.stringify(malformed.body.degraded));
assert.equal(malformed.body.collection.state,'ok','the other blocks stay readable');
assert.equal(malformed.body.lastRun.status,'completed','the run itself is still known');
assert.equal(malformed.body.lastRun.added,null,'a run without reliable counts is unknown, not 0 added');
assert.equal(malformed.body.lastRun.failed,null,'and not 0 failed');
// Recovery: a valid run again, and a valid empty run keeps its real 0.
records.set('enrichment/prediction-queue.json',{schemaVersion:3,programmeRunId:G1,pending:['tmdb_500'],hotPending:['tmdb_500'],coldPending:[],priorityCount:1,coldRemaining:0,retries:{}});
records.set('enrichment/latest-run.json',{runId:'r1',status:'complete',createdAt:T,completedAt:T,results:{},selectedIds:[],batchCount:1});
const recovered=await footer({BUCKET:bucket,DB:db});
assert.equal(recovered.status,200);assert.equal(Object.hasOwn(recovered.body,'degraded'),false,'recovered: nothing degraded');
assert.equal(recovered.body.lastRun.added,0,'a valid empty run reports a measured 0');assert.equal(recovered.body.lastRun.failed,0);
records.set('enrichment/latest-run.json',{runId:'r2',status:'complete',createdAt:T,completedAt:T,results:{a:'created',b:'created',c:'failed'},failures:{c:'x'},selectedIds:['a','b','c'],batchCount:1});
const counted=await footer({BUCKET:bucket,DB:db});
assert.equal(counted.body.lastRun.added,2);assert.equal(counted.body.lastRun.failed,1);

// ---- 3b. production authorities: published EPG, Discovery, predictions and ratings in D1 ----
// The footer streams the R2 view index and drops what the d1 overlays replace, takes the catalog projected row by row from Discovery and the metadata
// identity-only. The oracle is the same blocks computed from the whole documents as loadJSON returns them (overlays, mood facets, full payloads).
{
 const file2=path.join(root,'prod.sqlite');
 const sha=text=>webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(text)).then(buffer=>[...new Uint8Array(buffer)].map(byte=>byte.toString(16).padStart(2,'0')).join(''));
 const canonicalJson=value=>Array.isArray(value)?value.map(canonicalJson):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalJson(value[key])])):value;
 const fp=vm.runInContext('FINGERPRINT_SCHEMA_VERSION',ctx),pp=vm.runInContext('PREDICTION_PROMPT_VERSION',ctx);
 const profileBody={version:7,profileHash:'p7',updatedAt:T,profile:{}},profileKey='enrichment/profile/versions/7.json';
 let sql=names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')+'\nBEGIN;\n';
 for(let i=0;i<N;i++){const id='film:tmdb:'+tmdbOf(i);sql+=`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (${q(id)},1,${q('tmdb:'+tmdbOf(i))},'O',${q(T)});\n`+ext(id,'tmdb',tmdbOf(i));if(i<40)sql+=ext(id,'letterboxd',lidOf(i*5));}
 for(const [id,film] of Object.entries(catalog))if(film.canonicalIdentity)sql+=`INSERT INTO discovery_admission (film_id,tmdb_id,media_kind,canonical_identity,generation,state,payload_json) VALUES (${q(id)},${q(film.tmdbId)},'movie',${q(film.canonicalIdentity)},1,'current',${q(JSON.stringify(film))});\n`;
 sql+=`INSERT INTO prediction_profile (version,profile_hash,active,created_at,r2_key,content_sha256,lineage_json) VALUES (7,'p7',1,${q(T)},${q(profileKey)},${q(await sha(JSON.stringify(canonicalJson(profileBody))))},NULL);\n`;
 sql+=`INSERT INTO prediction_queue (seq,chunk_text,generation) VALUES (0,${q(JSON.stringify({schemaVersion:3,programmeRunId:G1,pending:[],hotPending:[],coldPending:[],priorityCount:0,coldRemaining:0,retries:{}}))},0);\n`;
 sql+=`INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('r1',1,${q(T)},${q(JSON.stringify({runId:'r1',status:'complete',createdAt:T,completedAt:T,results:{},selectedIds:[],batchCount:1}))});\n`;
 for(let i=0;i<N;i+=2){
  const id='tmdb_'+tmdbOf(i),display={predictedRating:3.6+(i%15)/10,probability4Plus:(i%10)/10,confidence:'high',matchSignals:['x'],mainRisk:'y',moodLabels:['m'],tasteProfileVersion:i%13===0?6:7,tasteProfileHash:i%13===0?'p6':'p7',fingerprintHash:'f',fingerprintSchemaVersion:fp,fingerprintPromptVersion:1,predictionPromptVersion:pp,generatedAt:T};
  sql+=`INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES (${q(id)},7,'p7','f',${fp},${pp},${display.predictedRating},${q('pv/'+id)},${q('a'.repeat(64))},${q(T)},${q(JSON.stringify(display))});\n`;
  sql+=`INSERT INTO prediction_fingerprint (film_id,fingerprint_hash,schema_version,prompt_version,generated_at,invalidated_at,r2_key,content_sha256,features_json) VALUES (${q(id)},'f',${fp},1,${q(T)},NULL,${q('fp/'+id)},${q('b'.repeat(64))},${q(JSON.stringify({fingerprintHash:'f',fingerprintSchemaVersion:fp,fingerprintPromptVersion:1,invalidatedAt:null,plotMechanics:['p'],moodLabels:['m'],execution:{}}))});\n`;
 }
 for(let i=0;i<N;i+=3)sql+=`INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q('tmdb_'+tmdbOf(i))},${q('f'+i)},${i%2},${i%4?(1+i%9)/2:'NULL'},${i%5===0?1:'NULL'},${i%4?1:0},${q(T)});\n`;
 for(let i=0;i<40;i+=2)sql+=`INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES (${q(lidOf(i*5))},${q('l'+i)},1,4,NULL,1,${q(T)});\n`;
 sql+='COMMIT;\n'+OPEN+"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;UPDATE published_epg_authority SET mode='d1' WHERE id=1;";
 sqlite(file2,sql);sql=null;
 const store=new Map([[profileKey,profileBody],['enrichment/view-index.json',index],['sync.json',{stage:'complete',runId:G1,completedAt:T,updatedAt:T}]]);
 const bucket2={
  async get(key){const value=store.get(key);if(value===undefined)return null;const text=JSON.stringify(value);return {etag:'e',size:text.length,json:async()=>JSON.parse(text),text:async()=>text};},
  async head(key){return store.has(key)?{etag:'e'}:null;},async put(key,value){if(String(key).startsWith('epg/'))return store.set(key,JSON.parse(String(value))),{etag:'e'};writes.push('put:'+key);throw new Error('no R2 write from a GET');},
  async delete(key){writes.push('delete:'+key);throw new Error('no R2 delete');},async list(){return {objects:[],truncated:false};},
 };
 const PublishedEpgModule=await import('../src/published-epg.js');
 assert.equal((await PublishedEpgModule.publishGeneration({DB:d1Standin(file2),BUCKET:bucket2},{programmeRunId:G1,phase:'published',expectedProgrammeRunId:null,programme,watchlist},{now})).pointed,true);
 const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,ReadableStream,crypto:webcrypto,console:{log(){},warn(){},error(){}},setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>{throw new Error('the footer makes no request');}});
 vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),world);
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),world);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),world);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),world);
 vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);vm.runInContext(scopedEpgPriority(),world);loadDiscoveryAuthority(script=>vm.runInContext(script,world));
 vm.runInContext(scoped('src/prediction-d1.js','PredictionD1'),world);vm.runInContext(scoped('src/ratings-d1.js','RatingsD1'),world);
 for(const source of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(source,'utf8').replace('export default','globalThis.worker='),world);
 const reads2=[];
 const db2=d1Standin(file2,{onQuery:async text=>{reads2.push(text);}});
 const env2={BUCKET:bucket2,DB:db2,PREDICTION_DB_REQUIRED:'on',RATINGS_DB_REQUIRED:'on',FOOTER_SOURCE_TIMEOUT_MS:'120000'};
 const ask=async()=>{const response=await world.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/footer/status'),env2,{waitUntil(){}});return {status:response.status,body:await response.json()};};
 writes.length=0;
 const got=await ask();
 assert.equal(got.status,200,JSON.stringify(got.body));
 assert.equal(Object.hasOwn(got.body,'degraded'),false,'production authorities: nothing degraded: '+JSON.stringify(got.body.degraded));
 assert.deepEqual(writes,[]);assert.ok(reads2.every(text=>/^\s*(SELECT|WITH|PRAGMA)\b/i.test(text)),'only SELECTs reached D1');
 assert.ok(reads2.some(text=>/FROM discovery_admission/.test(text))&&reads2.some(text=>/FROM prediction_pointer/.test(text))&&reads2.some(text=>/FROM ratings_view/.test(text))&&reads2.some(text=>/FROM published_epg_document/.test(text)),'every production authority was read');
 // The oracle: the whole documents as every other reader gets them.
 const pinned=await vm.runInContext('pinEpg',world)(env2);
 const fullIndex=await vm.runInContext('loadJSON',world)(env2,'enrichment/view-index.json'),fullCatalog=await vm.runInContext('loadJSON',world)(pinned,'epg/discovered-films.json');
 const fullReport=await vm.runInContext('PublishedEpg',world).readDocumentAt(pinned,pinned.epgPin.programmeRunId,'programme',pinned.epgPin.generation),fullWatchlist=await vm.runInContext('PublishedEpg',world).readDocumentAt(pinned,pinned.epgPin.programmeRunId,'watchlist',pinned.epgPin.generation);
 assert.equal(pinned.epgPin.authority,'d1');assert.ok(Object.values(fullIndex).some(item=>item?.moodFacet),'the oracle index carries what the footer drops');
 const gate2=await vm.runInContext('CanonicalCatalogReader',world).catalogReaderGate(env2),profile2=await vm.runInContext('loadJSON',world)(env2,'enrichment/profile/current.json'),freshness2=await vm.runInContext('predictionFreshness',world)(env2,profile2);
 const fullMetadata=await vm.runInContext('CanonicalCatalogReader',world).catalogMetadataFromD1(env2,vm.runInContext('canonicalIdentityIds',world)([fullReport,fullCatalog,fullWatchlist,fullIndex]),gate2);
 const whole2={report:fullReport,catalog:fullCatalog,watchlist:fullWatchlist,index:fullIndex,metadata:fullMetadata};
 assert.deepEqual(got.body.collection,{...vm.runInContext('footerCollection',world)(whole2)},'collection, production authorities');
 assert.deepEqual(got.body.recommendations.newUnseen,{...vm.runInContext('footerNewUnseen',world)({...whole2,profile:profile2,freshness:freshness2})},'new and interesting, production authorities');
 const coverage2=vm.runInContext('canonicalCoverageSummary',world)(fullReport,fullCatalog,fullIndex,profile2,Date.now(),freshness2,true);
 for(const [key,value] of Object.entries(coverage2))assert.equal(got.body.coverage[key],value,'coverage.'+key+', completed-only rule');
 assert.ok(got.body.collection.rated>0&&got.body.coverage.currentPredictionsTotal>0&&got.body.coverage.windowFilmsTotal>0,'the fixture reaches the ratings, the forecasts and the window');
 // An authority that moves between the footer's read and its overlay: the index is unknown, never counted from a copy with the facts dropped.
 let flipped=false;
 const db3=d1Standin(file2,{onQuery:async text=>{if(!flipped&&/FROM ratings_view/.test(text)){flipped=true;sqlite(file2,"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1;");}}});
 const moved=await world.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/footer/status'),{...env2,DB:db3},{waitUntil(){}});
 const movedBody=await moved.json();
 assert.ok(flipped,'the ratings authority moved during the read');
 assert.ok(moved.status===200&&movedBody.degraded?.includes('index'),'a moved authority leaves the index unknown: '+moved.status+' '+JSON.stringify(movedBody.degraded));
 assert.equal(movedBody.collection.state,'unknown');assert.equal(movedBody.coverage.currentPredictionsTotal,null);
}

// ---- 4. production-sized reproduction (environment-dependent: nightly only) ----
nonFunctional('footer-memory-production-size',()=>{
 if(!nodeSqliteOrSkip('footer-memory-production-size'))return;
 // The deployed bundle answers (the code workerd runs), on production-shaped fixtures with every authority in D1.
 const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const script=path.resolve('scripts/footer-memory-profile.mjs'),fixtures=path.join(root,'fixtures');
 const build=spawnSync(process.execPath,['--no-warnings',script,'--build','--fixtures',fixtures],{encoding:'utf8',maxBuffer:1<<24});
 assert.equal(build.status,0,build.stderr);
 // Four requests at once needed 230 MB of old space before AIR-519 and 91 MB after, over a 20 MB baseline (docs/evidence/footer-status-oom-rca-2026-11-17.md):
 // 128 MB fails the old read and leaves the bounded one about 35 MB of room on a slower runner. The CPU bound is generous.
 const run=spawnSync(process.execPath,['--no-warnings','--max-semi-space-size=1','--max-old-space-size=128',script,'--fixtures',fixtures,'--concurrent','4','--requests','2','--freeze'],{encoding:'utf8',maxBuffer:1<<24,timeout:240000});
 assert.equal(run.status,0,run.stderr);
 const result=JSON.parse(run.stdout.trim().split('\n').at(-1));
 assert.deepEqual(result.statuses,Array(8).fill(200));
 assert.deepEqual(result.degraded,[],'nothing degraded under the cap');
 assert.equal(result.writes,0);
 assert.ok(result.cpuMs<8*10000,'eight requests within 10 s of CPU each: '+result.cpuMs+' ms');
});

// ---- 5. the owner page: /api/admin/limbo and /api/admin/identity-work (nightly only) ----
// Both routes start from the same load (programme, dictionaries, queue, view index, Discovery index). With the Discovery observation index at its cap (3,000 of
// 9,944 candidates) each read took one statement per observation for the shows (3,079 statements, 37-49 s of wall on the live page), and the page asked both routes
// at once: two independent loads need 82 MB of old space on the fixtures against 58 MB one after the other, and the live isolate ran out of memory
// (docs/evidence/owner-limbo-memory-air-528-2026-11-18.md). The shows are now read in chunks (117 statements) and the page serialises the two reads, so the isolate
// never holds two loads for the page's sake. 66 MB leaves the sequential pair about 8 MB of room and fails the concurrent pair.
nonFunctional('owner-limbo-memory-production-size',()=>{
 if(!nodeSqliteOrSkip('owner-limbo-memory-production-size'))return;
 const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8'});
 assert.equal(built.status,0,built.stderr);
 const script=path.resolve('scripts/footer-memory-profile.mjs'),fixtures=path.join(root,'limbo-fixtures');
 const build=spawnSync(process.execPath,['--no-warnings',script,'--build','--fixtures',fixtures],{encoding:'utf8',maxBuffer:1<<24});
 assert.equal(build.status,0,build.stderr);
 const paths='/api/admin/limbo?limit=25&attention=now,/api/admin/identity-work?limit=25';
 const run=spawnSync(process.execPath,['--no-warnings','--max-semi-space-size=1','--max-old-space-size=66',script,'--fixtures',fixtures,'--paths',paths,'--sequential','--freeze'],{encoding:'utf8',maxBuffer:1<<24,timeout:240000});
 assert.equal(run.status,0,run.stderr);
 const result=JSON.parse(run.stdout.trim().split('\n').at(-1));
 assert.deepEqual(result.statuses,[200,200]);
 assert.equal(result.writes,0);
 assert.ok(result.d1Queries<=400,'one statement per observation is gone: '+result.d1Queries+' statements');
});

fs.rmSync(root,{recursive:true,force:true});
console.log('Footer memory: indexed D1 identity claims equal the full scan, copy-free coverage equals the overlay, projected footer blocks equal the whole documents, a malformed record degrades one block, no writes passed');
