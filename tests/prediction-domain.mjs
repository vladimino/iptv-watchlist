// ADR 0078, ADR 0162. Mutable prediction state is served only while the marker says mode d1; a marker in mode r2, missing tables or a binding that does not answer
// are refused. Only without PREDICTION_DB_REQUIRED (local development) does a database without the domain stand in with the R2 objects. Mode d1 does not read the mutable objects back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openLease,openQueue,overlayIndex,readPredictionAuthority,routeRead,saveMutable,writeLease,writeQueue,PREDICTION_HISTORY_LIMIT} from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/prediction-d1\.js','PredictionD1'\)/);
assert.doesNotMatch(fs.readFileSync('src/prediction-d1.js','utf8'),/INSERT INTO film\b/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/prediction-repository/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-domain-'));
let databases=0;
const namesUntil=last=>['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority'].filter(name=>name<=last||last==='0007_prediction_authority');
const migrated=last=>{
 const file=path.join(root,'prediction-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of namesUntil(last))db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 // ADR 0162: a metadata-cache marker that is not d1 is refused, so the fixture serves the (empty) cache from D1.
 if(namesUntil(last).includes('0006_metadata_cache'))db.sql("UPDATE metadata_cache_authority SET mode='d1'");
 return db;
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const queueText=db=>db.sql('SELECT chunk_text FROM prediction_queue ORDER BY seq').map(row=>row.chunk_text).join('');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const sha=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(canonical(value)))))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
const put=(bucket,key,value)=>bucket.put(key,JSON.stringify(value));

const serve=db=>db.sql("UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
const unavailable=error=>error.code==='prediction_domain_unavailable';

// 1. ADR 0162: a marker in mode r2 is refused, never read as the R2 objects. A database without the domain stands in only without PREDICTION_DB_REQUIRED.
{
 const bucket=new MemoryBucket();
 await put(bucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['heat']});
 // Schema v6 has no domain tables: the local stand-in keeps the objects and writes none of the tables; production (REQUIRED on) refuses it.
 const v6=migrated('0006_metadata_cache');
 const authority=await readPredictionAuthority(v6);
 assert.equal(authority.mode,'r2');assert.equal(authority.version,6);assert.equal(authority.tables,false);
 assert.deepEqual(await routeRead({DB:v6,BUCKET:bucket},'enrichment/prediction-queue.json'),{handled:false});
 assert.equal((await saveMutable({DB:v6,BUCKET:bucket},'enrichment/prediction-queue.json',{schemaVersion:3,pending:[]})).handled,false);
 assert.equal(one(v6,"SELECT COUNT(*) FROM sqlite_master WHERE name='prediction_queue'"),0);
 await assert.rejects(readPredictionAuthority(v6,{PREDICTION_DB_REQUIRED:'on'}),unavailable);
 // Schema v7 as the migration leaves it: the marker is r2, which is refused by every reader and writer.
 const v7=migrated('0007_prediction_authority');
 assert.equal(one(v7,"SELECT mode FROM prediction_domain_authority"),'r2');
 const env={DB:v7,BUCKET:bucket};
 await assert.rejects(readPredictionAuthority(v7),unavailable);
 await assert.rejects(routeRead(env,'enrichment/prediction-queue.json'),unavailable);
 await assert.rejects(openQueue(env),unavailable);
 await assert.rejects(openLease(env,'enrichment/runner-lease.json'),unavailable);
 await assert.rejects(saveMutable(env,'enrichment/films/off-watchlist/fingerprint.json',{fingerprintHash:'h'}),unavailable);
 await assert.rejects(overlayIndex(env,{heat:{}}),unavailable);
 assert.equal(one(v7,'SELECT COUNT(*) FROM prediction_domain_intent'),0,'the retired r2 claim writes no intent');
 serve(v7);
 assert.equal((await readPredictionAuthority(v7)).mode,'d1');
 assert.equal(one(v7,'SELECT version FROM schema_contract'),7);
 assert.equal(one(v7,'SELECT COUNT(*) FROM film'),0);
 // `writes` held is the normal state of an activated domain and is served; any other value of the marker is refused.
 v7.sql("UPDATE prediction_domain_authority SET writes='held'");
 assert.equal((await readPredictionAuthority(v7)).writes,'held');
 // A restored marker in mode r2 is refused again, and so is a missing table.
 v7.sql("UPDATE prediction_domain_authority SET mode='r2', writes='open'");
 await assert.rejects(readPredictionAuthority(v7),unavailable);
 v7.sql("UPDATE prediction_domain_authority SET mode='d1'");
 v7.sql('DROP TABLE prediction_domain_cas');
 await assert.rejects(readPredictionAuthority(v7),unavailable);
 await assert.rejects(routeRead(env,'enrichment/prediction-queue.json'),unavailable);
}

// 2. The writers keep film ids that are not Film rows, and a d1 marker reads D1 and ignores a stale mirror.
{
 const db=migrated('0007_prediction_authority');
 db.sql("INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:heat',1,'Heat','2026-11-01T00:00:00.000Z')");
 const bucket=new MemoryBucket();
 const profile={version:1,profileHash:'profile-hash',updatedAt:'2026-11-01T00:00:00.000Z',profile:{ratingScale:'half'},lineage:null};
 const profileBody={version:1,profileHash:'profile-hash',updatedAt:profile.updatedAt,profile:profile.profile};
 await put(bucket,'enrichment/profile/versions/1.json',profileBody);
 const fingerprintBody={filmId:'off-watchlist',fingerprintHash:'print-1',plotMechanics:['heist'],moodLabels:['tense'],execution:{pace:'fast'}};
 await put(bucket,'enrichment/films/off-watchlist/fingerprints/print-1.json',fingerprintBody);
 const fingerprint={...fingerprintBody,generatedAt:'2026-11-01T01:00:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'generated',previous:null};
 const predictionBody={filmId:'redirect-old',predictedRating:4,tasteProfileVersion:1,tasteProfileHash:'profile-hash',fingerprintHash:'print-1',fingerprintSchemaVersion:1,predictionPromptVersion:1,generatedAt:'2026-11-01T02:00:00.000Z'};
 const digest=await sha(predictionBody);
 const versionKey='enrichment/films/redirect-old/predictions/versions/'+digest+'.json';
 await put(bucket,versionKey,predictionBody);
 const current={...predictionBody,r2Key:versionKey,contentSha256:digest};
 const replacedBody={...predictionBody,predictedRating:3,generatedAt:'2026-11-01T01:30:00.000Z'};
 const replacedDigest=await sha(replacedBody);
 const replacedKey='enrichment/films/redirect-old/predictions/versions/'+replacedDigest+'.json';
 await put(bucket,replacedKey,replacedBody);
 const history=[{...replacedBody,r2Key:replacedKey,contentSha256:replacedDigest,replacedAt:'2026-11-01T02:00:00.000Z'}];
 const queue={schemaVersion:3,pending:['off-watchlist'],retries:{'redirect-old':{attempts:2,retryAt:1}}};
 const run={runId:'run-1',status:'complete',updatedAt:'2026-11-01T03:00:00.000Z',selectedIds:['off-watchlist']};
 const films=one(db,'SELECT COUNT(*) FROM film');
 // The import and activate chain is retired: the fixture sets the marker and stores the state through the normal writers.
 serve(db);
 const seeding={DB:db,BUCKET:bucket};
 await saveMutable(seeding,'enrichment/profile/current.json',profile);
 await saveMutable(seeding,'enrichment/films/off-watchlist/fingerprint.json',fingerprint);
 await saveMutable(seeding,'enrichment/films/redirect-old/predictions.json',{current,history});
 await saveMutable(seeding,'enrichment/prediction-queue.json',queue);
 await saveMutable(seeding,'enrichment/runs/run-1.json',run);
 await saveMutable(seeding,'enrichment/latest-run.json',run);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),films);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:off-watchlist'"),0);
 assert.equal(one(db,'SELECT COUNT(*) FROM prediction_fingerprint'),1);
 assert.equal(one(db,'SELECT COUNT(*) FROM prediction_pointer'),1);
 assert.equal(one(db,'SELECT COUNT(*) FROM prediction_lineage'),1);
 await put(bucket,'enrichment/films/off-watchlist/fingerprint.json',{fingerprintHash:'stale-mirror'});
 await put(bucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['stale']});
 const env={DB:db,BUCKET:bucket};
 const readFingerprint=await routeRead(env,'enrichment/films/off-watchlist/fingerprint.json');
 assert.equal(readFingerprint.handled,true);
 assert.equal(readFingerprint.value.fingerprintHash,'print-1');
 assert.equal(readFingerprint.value.produced,'generated');
 const readQueue=await routeRead(env,'enrichment/prediction-queue.json');
 assert.deepEqual(readQueue.value.pending,['off-watchlist']);
 assert.equal(readQueue.value.retries['redirect-old'].attempts,2);
 const readPredictions=await routeRead(env,'enrichment/films/redirect-old/predictions.json');
 assert.equal(readPredictions.value.current.predictedRating,4);
 assert.equal(readPredictions.value.history.length,1);
 assert.equal(readPredictions.value.history[0].predictedRating,3);
 const index=await overlayIndex(db,{heat:{actualRating:5,prediction:{predictedRating:1},fingerprintHash:'mirror',moodFacet:{moodIds:['stale']}},'off-watchlist':{moodFacet:{moodIds:['stale']}},'redirect-old':{}});
 assert.equal(index.heat.actualRating,5);
 assert.equal(index.heat.prediction,undefined);
 assert.equal(index.heat.moodFacet,undefined);
 assert.equal(index.outside,undefined);
 assert.equal(index['off-watchlist'].fingerprintHash,'print-1');
 assert.equal(index['redirect-old'].prediction.predictedRating,4);
 globalThis.canonicalMoodFacet=()=>({moodIds:['stale-global']});
 const faceted=await overlayIndex(db,{'off-watchlist':{}},fingerprint=>({moodIds:[...(fingerprint?.moodLabels||[])]}));
 assert.deepEqual(faceted['off-watchlist'].moodFacet.moodIds,['tense']);
 delete globalThis.canonicalMoodFacet;
 assert.doesNotMatch(fs.readFileSync('src/enrichment.js','utf8'),/globalThis\.canonicalMoodFacet/);
 bucket.objects.delete(versionKey);
 await assert.rejects(routeRead(env,'enrichment/films/redirect-old/predictions.json'),error=>error.code==='prediction_domain_body_missing');
 await put(bucket,versionKey,{...predictionBody,predictedRating:9});
 await assert.rejects(routeRead(env,'enrichment/films/redirect-old/predictions.json'),error=>error.code==='prediction_domain_body_mismatch');
 await put(bucket,versionKey,predictionBody);
 const again=await routeRead(env,'enrichment/films/redirect-old/predictions.json');
 assert.equal(again.value.current.predictedRating,4);
 const queries=db.calls.queries;
 await routeRead(env,'enrichment/films/off-watchlist/fingerprint.json');
 assert.ok(db.calls.queries-queries<8,'one fingerprint read stays a handful of queries');
}

// 3. D1 writes are fenced. A stale generation does not land, and the immutable body is required first.
{
 const db=migrated('0007_prediction_authority');
 const bucket=new MemoryBucket();
 serve(db);
 const env={DB:db,BUCKET:bucket};
 await saveMutable(env,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['a']});
 const first=await openQueue(env);
 const second=await openQueue(env);
 const written=await writeQueue(env,first,{schemaVersion:3,pending:['b']});
 assert.equal(written.etag,'d1');
 assert.equal(await writeQueue(env,second,{schemaVersion:3,pending:['c']}),null);
 assert.deepEqual((await routeRead(env,'enrichment/prediction-queue.json')).value.pending,['b']);
 assert.equal(JSON.parse(bucket.objects.get('enrichment/prediction-queue.json').text).pending[0],'b');
 const huge={schemaVersion:3,pending:['x'.repeat(900001)]};
 await assert.rejects(writeQueue(env,await openQueue(env),huge),error=>error.code==='prediction_domain_budget');
 const acquired=await writeLease(env,await openLease(env,'enrichment/runner-lease.json'),{runId:'run-a',expiresAt:Date.now()+1000});
 assert.ok(acquired);
 const held=await openLease(env,'enrichment/runner-lease.json');
 assert.equal(held.value.runId,'run-a');
 const other=await openLease(env,'enrichment/runner-lease.json');
 await writeLease(env,held,{runId:'run-a',expiresAt:Date.now()+2000});
 assert.equal(await writeLease(env,other,{runId:'run-b',expiresAt:Date.now()+2000}),null);
 assert.equal((await openLease(env,'enrichment/runner-lease.json')).value.runId,'run-a');
 const body={filmId:'solo',fingerprintHash:'print-2',plotMechanics:[],moodLabels:[],execution:{}};
 await put(bucket,'enrichment/films/solo/fingerprints/print-2.json',body);
 const record={...body,generatedAt:'2026-11-01T04:00:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'generated',previous:null};
 await saveMutable(env,'enrichment/films/solo/fingerprint.json',record);
 assert.equal((await routeRead(env,'enrichment/films/solo/fingerprint.json')).value.fingerprintHash,'print-2');
 const partialBody={filmId:'solo',fingerprintHash:'print-partial',plotMechanics:['heist'],moodLabels:['tense'],execution:{pace:'fast'}};
 await put(bucket,'enrichment/films/solo/fingerprints/print-partial.json',partialBody);
 await saveMutable(env,'enrichment/films/solo/fingerprint.json',{...partialBody,generatedAt:'2026-11-01T04:10:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'partial',fields:['moodLabels','plotMechanics'],previous:null});
 const partialRead=await routeRead(env,'enrichment/films/solo/fingerprint.json');
 assert.equal(partialRead.value.produced,'partial');
 assert.deepEqual(partialRead.value.fields,['moodLabels','plotMechanics']);
 assert.equal(partialRead.value.moodLabels[0],'tense');
 assert.equal(Object.hasOwn(JSON.parse(bucket.objects.get('enrichment/films/solo/fingerprints/print-partial.json').text),'fields'),false);
 const restoredBody={...partialBody,fingerprintHash:'print-restored'};
 await put(bucket,'enrichment/films/solo/fingerprints/print-restored.json',restoredBody);
 await saveMutable(env,'enrichment/films/solo/fingerprint.json',{...restoredBody,generatedAt:'2026-11-01T04:20:00.000Z',invalidatedAt:null,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,produced:'restored',previous:null});
 const restoredRead=await routeRead(env,'enrichment/films/solo/fingerprint.json');
 assert.equal(restoredRead.value.produced,'restored');
 assert.equal(restoredRead.value.fields,undefined);
 const prediction={filmId:'solo',predictedRating:3.5,generatedAt:'2026-11-01T05:00:00.000Z',tasteProfileVersion:1,tasteProfileHash:'profile-hash',fingerprintHash:'print-2',fingerprintSchemaVersion:1,predictionPromptVersion:1};
 const digest=await sha(prediction);
 const key='enrichment/films/solo/predictions/versions/'+digest+'.json';
 await assert.rejects(saveMutable(env,'enrichment/films/solo/predictions.json',{current:{...prediction,r2Key:key,contentSha256:digest},history:[]}),error=>error.code==='prediction_domain_body_missing');
 assert.equal(one(db,"SELECT COUNT(*) FROM prediction_pointer WHERE film_id='solo'"),0);
 await put(bucket,key,prediction);
 await saveMutable(env,'enrichment/films/solo/predictions.json',{current:{...prediction,r2Key:key,contentSha256:digest},history:[]});
 assert.equal((await routeRead(env,'enrichment/films/solo/predictions.json')).value.current.predictedRating,3.5);
 const history=Array.from({length:PREDICTION_HISTORY_LIMIT+1},(_,index)=>({...prediction,predictedRating:index,r2Key:key,contentSha256:digest,replacedAt:'2026-11-01T05:00:0'+String(index).padStart(2,'0')+'Z'}));
 await assert.rejects(saveMutable(env,'enrichment/films/solo/predictions.json',{current:null,history}),error=>error.code==='prediction_domain_budget');
 const profile={version:2,profileHash:'profile-2',updatedAt:'2026-11-01T06:00:00.000Z',profile:{ratingScale:'half'},lineage:[]};
 await put(bucket,'enrichment/profile/versions/2.json',profile);
 await saveMutable(env,'enrichment/profile/current.json',profile);
 assert.equal((await routeRead(env,'enrichment/profile/current.json')).value.version,2);
 const latest={runId:'run-9',status:'running',updatedAt:'2026-11-01T07:00:00.000Z'};
 await saveMutable(env,'enrichment/runs/run-9.json',latest);
 assert.equal((await routeRead(env,'enrichment/latest-run.json')).value,null);
 await saveMutable(env,'enrichment/latest-run.json',latest);
 assert.equal((await routeRead(env,'enrichment/latest-run.json')).value.runId,'run-9');
 const older={runId:'run-8',status:'partial',updatedAt:'2026-11-01T07:05:00.000Z'};
 await saveMutable(env,'enrichment/runs/run-8.json',older);
 assert.equal((await routeRead(env,'enrichment/latest-run.json')).value.runId,'run-9');
 assert.equal((await routeRead(env,'enrichment/runs/run-8.json')).value.status,'partial');
}

// 4. The projector runs on a d1 prediction marker and refuses a partial schema or a marker that is not d1. The offline import script is retired.
{
 const projector=projectorContext();
 const db=migrated('0007_prediction_authority');
 serve(db);
 const bucket=new MemoryBucket();
 const films=[{id:'heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',url:'https://letterboxd.com/film/heat/'}];
 const putJson=(key,value)=>bucket.put(key,JSON.stringify(value));
 putJson('watchlist.json',{updatedAt:'2026-11-01T00:00:00.000Z',films});
 putJson('metadata.json',{});
 putJson('titles.json',{});
 putJson('people.json',{});
 putJson('epg/discovery-resolution.json',{});
 putJson('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 putJson('epg/generations/run-1/programme.json',{updatedAt:'2026-11-01T00:00:00.000Z',films:films.map(item=>({...item,shows:[]}))});
 putJson('epg/generations/run-1/discovered-films.json',{});
 const env={DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'};
 const run=await projector.runD1EnrichmentProjection(env);
 assert.equal(run.outcome,'complete',JSON.stringify(run));
 assert.equal(run.schemaVersion,7);
 assert.equal(run.predictionMode,'d1');
 assert.equal(one(db,'SELECT COUNT(*) FROM prediction_fingerprint'),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:heat'"),1);
 const status=await projector.d1EnrichmentStatus(db,{D1_ENRICHMENT_WRITE:'on'});
 assert.equal(status.schema,true);
 assert.equal(status.schemaVersion,7);
 assert.equal(status.predictionMode,'d1');
 assert.equal(status.cacheMode,'d1','the fixture puts the metadata-cache marker at d1 (ADR 0162)');
 const partial=migrated('0007_prediction_authority');
 partial.sql('DROP TABLE prediction_queue');
 const blind=await projector.d1EnrichmentStatus(partial,{});
 assert.equal(blind.schema,false);
 const failed=await projector.runD1EnrichmentProjection({DB:partial,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(failed.outcome,'failed');
 assert.equal(failed.reason,'prediction_domain_unavailable');
 const ahead=migrated('0006_metadata_cache');
 ahead.sql('UPDATE schema_contract SET version=8');
 const aheadStatus=await projector.d1EnrichmentStatus(ahead,{});
 assert.equal(aheadStatus.schema,true);
 assert.equal(aheadStatus.schemaVersion,8);
 assert.equal(aheadStatus.predictionMode,undefined);
 const aheadRun=await projector.runD1EnrichmentProjection({DB:ahead,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on',PREDICTION_DB_REQUIRED:'on'});
 assert.equal(aheadRun.outcome,'failed',JSON.stringify(aheadRun));
 assert.match(aheadRun.error,/published_epg_unavailable/);
 const chain=migrated('0007_prediction_authority');
 serve(chain);
 chain.sql(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'));
 const chainRun=await projector.runD1EnrichmentProjection({DB:chain,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on',PREDICTION_DB_REQUIRED:'on'});
 assert.equal(chainRun.outcome,'complete',JSON.stringify(chainRun));
 assert.equal(chainRun.schemaVersion,8);
 assert.equal(chainRun.predictionMode,'d1');
 const v6=migrated('0006_metadata_cache');
 const v6Status=await projector.d1EnrichmentStatus(v6,{});
 assert.equal(v6Status.schema,true);
 assert.equal(v6Status.schemaVersion,6);
 assert.equal(v6Status.predictionMode,undefined);
 assert.equal(fs.existsSync('scripts/prediction-domain-authority.mjs'),false,'the offline import, activate and revert script is retired (ADR 0162)');
 // A marker that is not d1 stops the projector too: it never projects against the R2 objects.
 const refused=migrated('0007_prediction_authority');
 const stopped=await projector.runD1EnrichmentProjection({DB:refused,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(stopped.outcome,'failed');assert.equal(stopped.reason,'prediction_domain_unavailable');
}

// 5. A later additive schema keeps the marker. A missing binding, schema or table is refused in production and is the stand-in only locally.
{
 const unbound=await readPredictionAuthority(undefined);
 assert.equal(unbound.binding,false);
 assert.equal(unbound.mode,'r2');
 await assert.rejects(readPredictionAuthority(null,{PREDICTION_DB_REQUIRED:'on'}),unavailable);
 await assert.rejects(routeRead({PREDICTION_DB_REQUIRED:'on',BUCKET:new MemoryBucket()},'enrichment/prediction-queue.json'),unavailable);
 const empty=d1Standin(path.join(root,'empty.sqlite'));
 await assert.rejects(readPredictionAuthority(empty,{PREDICTION_DB_REQUIRED:'on'}),unavailable);
 const emptyBucket=new MemoryBucket();
 await put(emptyBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['local']});
 await assert.rejects(routeRead({DB:empty,BUCKET:emptyBucket,PREDICTION_DB_REQUIRED:'on'},'enrichment/prediction-queue.json'),unavailable);
 assert.equal((await readPredictionAuthority(empty)).mode,'r2');
 assert.deepEqual(await routeRead({DB:empty,BUCKET:emptyBucket},'enrichment/prediction-queue.json'),{handled:false});
 // A later additive schema without the domain tables: production refuses it (before ADR 0162 it silently stayed on the objects); the local stand-in keeps them.
 const bare=migrated('0006_metadata_cache');
 bare.sql('UPDATE schema_contract SET version=8');
 const bareBucket=new MemoryBucket();
 await put(bareBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['epg-first']});
 await assert.rejects(openQueue({DB:bare,BUCKET:bareBucket,PREDICTION_DB_REQUIRED:'on'}),unavailable);
 const bareEnv={DB:bare,BUCKET:bareBucket};
 const bareHead=await openQueue(bareEnv);
 assert.equal(bareHead.mode,'r2');
 assert.equal(bareHead.tables,false);
 assert.deepEqual(bareHead.queue.pending,['epg-first']);
 const bareWritten=await writeQueue(bareEnv,bareHead,{schemaVersion:3,pending:['still-object']});
 assert.notEqual(bareWritten,null);
 assert.notEqual(bareWritten.etag,'d1');
 assert.deepEqual(JSON.parse(bareBucket.objects.get('enrichment/prediction-queue.json').text).pending,['still-object']);
 assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"PREDICTION_DB_REQUIRED": "on"/);
 assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"binding": "DB"/);
 const broken={prepare(){return {bind(){return {async first(){throw new Error('D1 binding reset');},async all(){throw new Error('D1 binding reset');}};}};},async batch(){throw new Error('D1 binding reset');}};
 await assert.rejects(readPredictionAuthority(broken),unavailable);
 // A head captured before the tables existed does not write once the domain is installed (the reverse too): the write is refused, nothing reaches D1 or the object.
 const installed=migrated('0007_prediction_authority');serve(installed);
 const lateBucket=new MemoryBucket();await put(lateBucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['object']});
 const stale=await openQueue({DB:bare,BUCKET:lateBucket});
 assert.equal(await writeQueue({DB:installed,BUCKET:lateBucket},stale,{schemaVersion:3,pending:['late']}),null);
 assert.deepEqual(JSON.parse(lateBucket.objects.get('enrichment/prediction-queue.json').text).pending,['object']);
 assert.equal(one(installed,'SELECT COUNT(*) FROM prediction_queue'),0);
 const v8=migrated('0007_prediction_authority');
 v8.sql('UPDATE schema_contract SET version=8');
 serve(v8);
 const bucket=new MemoryBucket();
 await put(bucket,'enrichment/prediction-queue.json',{schemaVersion:3,pending:['r2']});
 const authority=await readPredictionAuthority(v8);
 assert.equal(authority.version,8);
 assert.equal(authority.mode,'d1');
 const read=await routeRead({DB:v8,BUCKET:bucket},'enrichment/prediction-queue.json');
 assert.equal(read.handled,true);
 assert.equal(read.value,null);
 v8.sql('DROP TABLE prediction_queue');
 await assert.rejects(routeRead({DB:v8,BUCKET:bucket},'enrichment/prediction-queue.json'),unavailable);
 assert.deepEqual(JSON.parse(bucket.objects.get('enrichment/prediction-queue.json').text).pending,['r2']);
 const projector=projectorContext();
 const whole=migrated('0007_prediction_authority');
 whole.sql('UPDATE schema_contract SET version=8');
 serve(whole);
 const status=await projector.d1EnrichmentStatus(whole,{});
 assert.equal(status.schema,true);
 assert.equal(status.schemaVersion,8);
 assert.equal(status.predictionMode,'d1');
 whole.sql('DROP TABLE prediction_fingerprint');
 assert.equal((await projector.d1EnrichmentStatus(whole,{})).schema,false);
}

console.log('prediction domain marker: a marker that is not d1, missing tables and a missing binding are refused (the local stand-in keeps the objects), d1 owns mutable state, immutable bodies are verified first, the writers add no Film, the projector passed');
