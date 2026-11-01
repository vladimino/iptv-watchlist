// Schema v5 metadataSync clocks (ADR 0070). The enrichment projector writes them only when migration 0005 is present.
// Schema v4 keeps the previous writes. The sync decision does not read film_sync_state.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {filmChangeKey,filmSyncChangeKey,filmSyncState,metadataForFilmId} from '../src/enrichment-projection.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const worker=fs.readFileSync('src/worker.js','utf8');
const projectorSource=fs.readFileSync('src/d1-enrichment.js','utf8');
const begin=worker.slice(worker.indexOf('async function beginSync'),worker.indexOf('async function metadataSync'));
const sync=worker.slice(worker.indexOf('async function metadataSync'),worker.indexOf('async function finishSync'));
const cacheSource=fs.readFileSync('src/metadata-cache.js','utf8');
assert.match(cacheSource,/peopleNamesVersion!==2/);
assert.match(cacheSource,/METADATA_FRESH_MS=30\*86400000/);
assert.match(begin,/MetadataCache\.mergeWatchlistFilm/);
assert.match(begin,/MetadataCache\.metadataPending/);
assert.match(sync,/peopleNamesVersion!==2/);
assert.match(sync,/synopsisFetchedAt/);
assert.match(sync,/MetadataCache\.loadMetadataWorkingSet/);
assert.match(sync,/MetadataCache\.saveMetadataWorkingSet/);
assert.doesNotMatch(begin,/film_sync_state|env\.DB|runD1EnrichmentProjection/);
assert.doesNotMatch(sync,/film_sync_state|env\.DB|runD1EnrichmentProjection/);
assert.doesNotMatch(worker,/film_sync_state/);
assert.doesNotMatch(fs.readFileSync('src/catalog-d1.js','utf8'),/film_sync_state/);
assert.match(projectorSource,/D1_ENRICHMENT_QUERY_BUDGET=800/);
assert.match(projectorSource,/D1_ENRICHMENT_WALL_MS=60000/);
assert.equal(projectorSource.split('readLifecycle(').length-1,1,'the projector still builds one view');
assert.doesNotMatch(projectorSource,/\bBUCKET\.(put|delete)\b/,'the projector never writes R2');

const T='2026-10-28T10:00:00.000Z';
const NOW=Date.parse('2026-10-31T12:00:00.000Z');
const DAY=86400000;
const edge=new Date(NOW-30*DAY).toISOString();
const past=new Date(NOW-30*DAY-1).toISOString();
const entry={film:{id:'film:heat',metadata:{updatedAt:T}},watchlist:true,credits:[],metadata:{updatedAt:T,peopleVersion:1,synopsis:'Synopsis'}};
assert.equal(filmChangeKey(entry,T),filmChangeKey({...entry,sync:filmSyncState({metadataAt:T,peopleNamesVersion:2})},T),'the film change key ignores the sync clocks');
assert.equal(filmSyncState(null),null);
assert.equal(filmSyncState([]),null);
assert.deepEqual(filmSyncState({}),{metadataAt:null,synopsisFetchedAt:null,peopleNamesVersion:null,peopleLocalizedAt:null});
assert.deepEqual(filmSyncState({metadataAt:'',synopsisFetchedAt:edge,peopleNamesVersion:'2',peopleLocalizedAt:null}),{metadataAt:null,synopsisFetchedAt:edge,peopleNamesVersion:null,peopleLocalizedAt:null});
assert.deepEqual(filmSyncState({metadataAt:edge,peopleNamesVersion:0,peopleLocalizedAt:T}),{metadataAt:edge,synopsisFetchedAt:null,peopleNamesVersion:0,peopleLocalizedAt:T});
assert.notEqual(filmSyncChangeKey(filmSyncState({metadataAt:edge})),filmSyncChangeKey(filmSyncState({metadataAt:past})));
assert.equal(filmSyncChangeKey(null),'absent');
assert.notEqual(filmSyncChangeKey(filmSyncState({})),'absent','an unstamped entry is not a missing entry');
assert.equal(filmSyncChangeKey(filmSyncState({metadataAt:edge})),filmSyncChangeKey(filmSyncState({metadataAt:edge})));
assert.equal(metadataForFilmId({heat:{id:'heat',metadataAt:edge}},'film:heat').metadataAt,edge);
assert.equal(metadataForFilmId({tmdb_100:{id:'tmdb_100',metadataAt:edge}},'film:tmdb:100').metadataAt,edge);
assert.equal(metadataForFilmId({heat:{id:'heat',metadataAt:edge}},'film:tmdb:949',['heat']).id,'heat');
assert.equal(metadataForFilmId({heat:{id:'heat'}},'film:orphan'),null);
assert.equal(metadataForFilmId(null,'film:heat'),null);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-sync-'));
let databases=0;
const migrated=(names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state'])=>{
 const file=path.join(root,'sync-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return {file,db};
};
const person=(id,name)=>({id,name,original:name});
const film=(id,title,tmdbId)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors:[person('director/michael-mann','Michael Mann')],actors:[person('actor/al-pacino','Al Pacino')]});
function dataset(metadata,options={}){
 const films=[film('heat','Heat','949'),film('collateral','Collateral','1538'),...(options.extra||[])];
 const bucket=new MemoryBucket();
 const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});
 put('metadata.json',metadata);
 put('titles.json',options.titles||{});
 put('people.json',options.people||{});
 put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{tmdb_100:{id:'tmdb_100',tmdbId:'100',title:'Ronin',original:'Ronin',year:1998,discoveredAt:T,synopsis:'Overview',directors:[person('tmdb_director/1','John Frankenheimer')],actors:[person('tmdb_actor/2','Jean Reno')]}});
 return bucket;
}
const full=(id,at=T)=>({id,title:'Heat',original:'Heat',year:1995,tmdbId:id==='heat'?'949':'1538',metadataAt:at,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:at,peopleLocalizedAt:at,runtime:120,directors:[person('director/michael-mann','Michael Mann')],actors:[person('actor/al-pacino','Al Pacino')]});
const baseMetadata=()=>({heat:full('heat'),collateral:full('collateral')});
const projector=projectorContext();
const run=(env,options={})=>projector.runD1EnrichmentProjection(env,options);
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const syncRow=(db,id)=>db.sql(`SELECT metadata_at a,synopsis_fetched_at s,people_names_version n,people_localized_at p FROM film_sync_state WHERE film_id='${id}'`)[0]||null;
const body=(bucket,key)=>bucket.objects.get(key).text;

// 1. Schema v4 writes the enrichment rows and no sync clocks. Status stays the v4 shape.
{
 const {db}=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state']);
 const bucket=dataset(baseMetadata());
 const summary=await run({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(summary.schemaVersion,4);
 assert.equal(summary.changedSync,undefined);
 assert.equal(one(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='film_sync_state'"),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM projection_state WHERE projection='metadata_sync'"),0);
 const status=await projector.d1EnrichmentStatus(db,{D1_ENRICHMENT_WRITE:'on'});
 assert.equal(status.schema,true);
 assert.equal(status.schemaVersion,undefined);
 assert.equal(status.syncCheckpoints,undefined);
 assert.deepEqual(Object.keys(status).sort(),['absent','checkpoints','lastRun','mode','schema']);
}

// 2. Applying 0005 on that same kind of database makes the next run fill the clocks. A second run writes nothing.
const {db,file}=migrated();
const bucket=dataset(baseMetadata());
const env={DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'};
{
 const summary=await run(env);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(summary.schemaVersion,5);
 assert.equal(summary.changedSync,2);
 assert.equal(summary.syncWrites,2);
 assert.equal(summary.writtenFilms,3,'the catalog film is still projected');
 assert.deepEqual(syncRow(db,'film:heat'),{a:T,s:T,n:2,p:T});
 assert.equal(syncRow(db,'film:tmdb:100'),null,'a catalog film with no metadata.json entry has no row');
 assert.deepEqual(db.sql('PRAGMA table_info(film_sync_state)').map(row=>row.name),['film_id','metadata_at','synopsis_fetched_at','people_names_version','people_localized_at']);
 const batches=db.calls.batches;
 const again=await run(env);
 assert.equal(again.changedSync,0);
 assert.equal(again.syncWrites,0);
 assert.equal(db.calls.batches,batches,'a replay sends no batch');
 assert.equal(again.writtenFilms,0);
 const status=await projector.d1EnrichmentStatus(db,{D1_ENRICHMENT_WRITE:'on'});
 assert.deepEqual([status.schema,status.schemaVersion,status.syncCheckpoints,status.syncAbsent],[true,5,2,0]);
}

// 3. The 30-day boundary is the stored string, not a folded updated_at. An unstamped entry is a row of nulls, not an absent row.
{
 const metadata=baseMetadata();
 metadata.heat={...metadata.heat,metadataAt:edge,synopsisFetchedAt:past};
 metadata.collateral={id:'collateral',peopleVersion:1,synopsisFetchedAt:T,peopleNamesVersion:'2',metadataAt:'',peopleLocalizedAt:''};
 metadata.plain={id:'plain'};
 bucket.put('metadata.json',JSON.stringify(metadata));
 bucket.put('watchlist.json',JSON.stringify({updatedAt:T,films:[film('heat','Heat','949'),film('collateral','Collateral','1538'),film('plain','Plain','1')]}));
 bucket.put('epg/generations/run-1/programme.json',JSON.stringify({updatedAt:T,films:[film('heat','Heat','949'),film('collateral','Collateral','1538'),film('plain','Plain','1')].map(item=>({...item,shows:[]}))}));
 const summary=await run(env);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(syncRow(db,'film:heat').a,edge);
 assert.equal(syncRow(db,'film:heat').s,past);
 assert.notEqual(edge,past);
 assert.equal(one(db,"SELECT updated_at FROM film_metadata WHERE film_id='film:heat'"),edge,'film_metadata keeps metadataAt when it is present');
 const unstamped=syncRow(db,'film:collateral');
 assert.deepEqual(unstamped,{a:null,s:T,n:null,p:null});
 assert.equal(one(db,"SELECT updated_at FROM film_metadata WHERE film_id='film:collateral'"),T,'the folded metadata clock is the synopsis clock, and the sync row does not copy it into metadata_at');
 assert.deepEqual(syncRow(db,'film:plain'),{a:null,s:null,n:null,p:null});
 assert.equal(one(db,"SELECT people_version FROM film_metadata WHERE film_id='film:heat'"),1,'people_version stays on film_metadata');
}

// 4. A clock that the film change key does not carry is written alone. A reviewed name and a reviewed title stay.
{
 db.sql(`UPDATE person_dimension SET status='reviewed',value='Аль Пачино',authority='owner',source='owner',next_action='keep_reviewed' WHERE person_id='person:actor/al-pacino' AND dimension='localization'`);
 db.sql(`UPDATE film_dimension SET status='reviewed',value='Жара',authority='owner',source='owner',next_action='keep_reviewed' WHERE film_id='film:heat' AND dimension='localization'`);
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 metadata.heat.synopsisFetchedAt='2026-10-29T00:00:00.000Z';
 metadata.heat.peopleLocalizedAt='2026-10-29T00:00:00.000Z';
 const before=body(bucket,'metadata.json');
 bucket.put('metadata.json',JSON.stringify(metadata));
 const batches=db.calls.batches;
 const summary=await run(env);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(summary.writtenFilms,0);
 assert.equal(summary.syncWrites,1);
 assert.ok(db.calls.batches>batches);
 assert.equal(syncRow(db,'film:heat').s,'2026-10-29T00:00:00.000Z');
 assert.equal(syncRow(db,'film:heat').p,'2026-10-29T00:00:00.000Z');
 assert.equal(one(db,"SELECT value FROM person_dimension WHERE person_id='person:actor/al-pacino' AND dimension='localization'"),'Аль Пачино');
 assert.equal(one(db,"SELECT value FROM film_dimension WHERE film_id='film:heat' AND dimension='localization'"),'Жара');
 assert.equal(body(bucket,'metadata.json')===before,false);
 const r2After=body(bucket,'metadata.json');
 bucket.put('people.json',JSON.stringify({'actor/al-pacino':{name:'Другое имя',original:'Al Pacino'}}));
 bucket.put('titles.json',JSON.stringify({heat:{tmdbId:'949',title:'Другая жара',status:'provisional',sources:['wikidata']}}));
 const named=await run(env);
 assert.equal(named.outcome,'complete',JSON.stringify(named));
 assert.equal(one(db,"SELECT value FROM person_dimension WHERE person_id='person:actor/al-pacino' AND dimension='localization'"),'Аль Пачино');
 assert.equal(one(db,"SELECT value FROM film_dimension WHERE film_id='film:heat' AND dimension='localization'"),'Жара');
 assert.equal(body(bucket,'metadata.json'),r2After,'a localization rewrite does not touch metadata.json');
 assert.equal(syncRow(db,'film:heat').s,'2026-10-29T00:00:00.000Z');
}

// 5. Replay is a no-op. A failed sync batch leaves the old D1 row and the new R2 object. A later R2 clock wins the retry.
{
 const stable=await run(env);
 assert.equal(stable.syncWrites,0);
 assert.equal(stable.writtenFilms,0);
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 metadata.heat.synopsisFetchedAt='2026-10-30T00:00:00.000Z';
 bucket.put('metadata.json',JSON.stringify(metadata));
 const r2Text=body(bucket,'metadata.json');
 const failing=d1Standin(file,{onBatch(statements){if(statements.some(item=>item.text.includes('film_sync_state')))throw new Error('D1_ERROR: synthetic');}});
 const failed=await run({...env,DB:failing});
 assert.equal(failed.outcome,'partial',JSON.stringify(failed));
 assert.equal(syncRow(db,'film:heat').s,'2026-10-29T00:00:00.000Z');
 assert.equal(body(bucket,'metadata.json'),r2Text);
 metadata.heat.synopsisFetchedAt='2026-10-31T00:00:00.000Z';
 bucket.put('metadata.json',JSON.stringify(metadata));
 const retried=await run(env);
 assert.equal(retried.outcome,'complete',JSON.stringify(retried));
 assert.equal(syncRow(db,'film:heat').s,'2026-10-31T00:00:00.000Z');
 assert.equal(body(bucket,'metadata.json').includes('2026-10-31T00:00:00.000Z'),true);
}

// 6. A live metadata sync defers the run before any D1 write. A second run is kept out by the lease. A lost lease writes no clock.
{
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 metadata.heat.peopleLocalizedAt='2026-11-01T00:00:00.000Z';
 bucket.put('metadata.json',JSON.stringify(metadata));
 bucket.put('sync.json',JSON.stringify({stage:'metadata',updatedAt:new Date().toISOString(),runId:'live'}));
 const deferred=await run(env);
 assert.deepEqual([deferred.outcome,deferred.reason],['deferred','writer_active']);
 assert.equal(syncRow(db,'film:heat').p,'2026-10-29T00:00:00.000Z');
 bucket.objects.delete('sync.json');
 db.sql(`UPDATE projection_run SET lease_id='other',lease_until='${new Date(Date.now()+60000).toISOString()}'`);
 assert.equal((await run(env)).skipped,'lease_held');
 assert.equal(syncRow(db,'film:heat').p,'2026-10-29T00:00:00.000Z');
 db.sql(`UPDATE projection_run SET lease_id=NULL,lease_until=NULL`);
 let stolenBatches=0;
 const stolen=d1Standin(file,{onBatch(){if(++stolenBatches===1)stolen.sql("UPDATE projection_run SET lease_id='thief'");}});
 const lost=await run({...env,DB:stolen});
 assert.equal(lost.outcome,'lease_lost',JSON.stringify(lost));
 assert.equal(syncRow(db,'film:heat').p,'2026-10-29T00:00:00.000Z');
 assert.equal(one(db,"SELECT lease_id FROM projection_run"),'thief');
 db.sql('UPDATE projection_run SET lease_id=NULL,lease_until=NULL');
 const recovered=await run(env);
 assert.equal(recovered.outcome,'complete',JSON.stringify(recovered));
 assert.equal(syncRow(db,'film:heat').p,'2026-11-01T00:00:00.000Z');
}

// 7. Removing the metadata.json entry deletes the row and marks the sync key absent. The Film stays. Putting the entry back restores the row.
{
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 delete metadata.heat;
 bucket.put('metadata.json',JSON.stringify(metadata));
 const removed=await run(env);
 assert.equal(removed.outcome,'complete',JSON.stringify(removed));
 assert.equal(syncRow(db,'film:heat'),null);
 assert.equal(one(db,"SELECT change_key FROM projection_state WHERE projection='metadata_sync' AND id='film:heat'"),'absent');
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:heat'"),1);
 metadata.heat=full('heat');
 metadata.heat.synopsisFetchedAt='2026-11-02T00:00:00.000Z';
 bucket.put('metadata.json',JSON.stringify(metadata));
 const restored=await run(env);
 assert.equal(restored.outcome,'complete',JSON.stringify(restored));
 assert.equal(syncRow(db,'film:heat').s,'2026-11-02T00:00:00.000Z');
}

// 8. A watchlist Film removed from the watchlist and the programme keeps its sync row while metadata.json keeps the entry.
// A clock changed while it is off the view is still written. Re-adding the Film finds that row. The row goes only when
// the entry goes. A metadata.json key with no Film row creates neither a Film nor a sync row.
{
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 metadata.orphan={id:'orphan',metadataAt:T,synopsisFetchedAt:T,peopleNamesVersion:2,peopleLocalizedAt:T};
 bucket.put('metadata.json',JSON.stringify(metadata));
 const ignored=await run(env);
 assert.equal(ignored.outcome,'complete',JSON.stringify(ignored));
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:orphan'"),0);
 assert.equal(syncRow(db,'film:orphan'),null);
 const kept=syncRow(db,'film:collateral');
 const films=[film('heat','Heat','949'),film('plain','Plain','1')];
 const putLists=list=>{
  bucket.put('watchlist.json',JSON.stringify({updatedAt:T,films:list}));
  bucket.put('epg/generations/run-1/programme.json',JSON.stringify({updatedAt:T,films:list.map(item=>({...item,shows:[]}))}));
 };
 putLists(films);
 const released=await run(env);
 assert.equal(released.outcome,'complete',JSON.stringify(released));
 assert.equal(one(db,"SELECT COUNT(*) FROM watchlist_film WHERE film_id='film:collateral'"),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:collateral'"),1);
 assert.deepEqual(syncRow(db,'film:collateral'),kept);
 assert.notEqual(one(db,"SELECT change_key FROM projection_state WHERE projection='metadata_sync' AND id='film:collateral'"),'absent');
 metadata.collateral={...metadata.collateral,synopsisFetchedAt:'2026-11-04T00:00:00.000Z'};
 bucket.put('metadata.json',JSON.stringify(metadata));
 const offView=await run(env);
 assert.equal(offView.outcome,'complete',JSON.stringify(offView));
 assert.equal(offView.writtenFilms,0);
 assert.equal(syncRow(db,'film:collateral').s,'2026-11-04T00:00:00.000Z');
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:orphan'"),0);
 putLists([...films,film('collateral','Collateral','1538')]);
 const returned=await run(env);
 assert.equal(returned.outcome,'complete',JSON.stringify(returned));
 assert.equal(one(db,"SELECT COUNT(*) FROM watchlist_film WHERE film_id='film:collateral'"),1);
 assert.equal(syncRow(db,'film:collateral').s,'2026-11-04T00:00:00.000Z');
 delete metadata.collateral;
 bucket.put('metadata.json',JSON.stringify(metadata));
 putLists(films);
 const dropped=await run(env);
 assert.equal(dropped.outcome,'complete',JSON.stringify(dropped));
 assert.equal(syncRow(db,'film:collateral'),null);
 assert.equal(one(db,"SELECT change_key FROM projection_state WHERE projection='metadata_sync' AND id='film:collateral'"),'absent');
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:collateral'"),1);
 assert.equal(one(db,"SELECT COUNT(*) FROM watchlist_film WHERE film_id='film:collateral'"),0);
 assert.equal(syncRow(db,'film:orphan'),null);
}

// 9. The query budget stops a sync-only run before it writes, and the next run finishes it. R2 is already the new value throughout.
{
 const metadata=JSON.parse(body(bucket,'metadata.json'));
 metadata.heat.synopsisFetchedAt='2026-11-03T00:00:00.000Z';
 metadata.plain={id:'plain',synopsisFetchedAt:'2026-11-03T00:00:00.000Z'};
 bucket.put('metadata.json',JSON.stringify(metadata));
 const r2Text=body(bucket,'metadata.json');
 const stopped=await run(env,{queryBudget:1});
 assert.equal(stopped.outcome,'budget',JSON.stringify(stopped));
 assert.ok(stopped.remaining>0);
 assert.equal(syncRow(db,'film:heat').s,'2026-11-02T00:00:00.000Z');
 assert.equal(body(bucket,'metadata.json'),r2Text);
 const finished=await run(env);
 assert.equal(finished.outcome,'complete',JSON.stringify(finished));
 assert.equal(syncRow(db,'film:heat').s,'2026-11-03T00:00:00.000Z');
 assert.equal(syncRow(db,'film:plain').s,'2026-11-03T00:00:00.000Z');
}

// 10. A missing D1 binding reads no R2. A table without version 5 is ignored. Version 5 without the table keeps the v4 writes and reports schema false.
{
 const quiet=dataset(baseMetadata());
 let reads=0;
 const get=quiet.get.bind(quiet);
 quiet.get=async key=>{reads++;return get(key);};
 assert.equal((await run({BUCKET:quiet,D1_ENRICHMENT_WRITE:'on'})).skipped,'binding_missing');
 assert.equal(reads,0);
 const {db:v4}=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state']);
 v4.sql(fs.readFileSync('migrations/0005_film_sync_state.sql','utf8').replace(/UPDATE schema_contract[^;]*;/,''));
 assert.equal(one(v4,'SELECT version FROM schema_contract'),4);
 const half=dataset(baseMetadata());
 const ignored=await run({DB:v4,BUCKET:half,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(ignored.outcome,'complete',JSON.stringify(ignored));
 assert.equal(ignored.changedSync,undefined);
 assert.equal(one(v4,'SELECT COUNT(*) FROM film_sync_state'),0);
 assert.equal((await projector.d1EnrichmentStatus(v4,{})).schema,true);
 v4.sql('UPDATE schema_contract SET version=5;DROP TABLE film_sync_state');
 const blind=await projector.d1EnrichmentStatus(v4,{});
 assert.deepEqual([blind.schema,blind.schemaVersion],[false,5]);
 const moved=JSON.parse(body(half,'metadata.json'));
 moved.heat.synopsis='A different synopsis';
 half.put('metadata.json',JSON.stringify(moved));
 const wrote=await run({DB:v4,BUCKET:half,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(wrote.outcome,'complete',JSON.stringify(wrote));
 assert.equal(one(v4,"SELECT synopsis FROM film_metadata WHERE film_id='film:heat'"),'A different synopsis');
 assert.equal(one(v4,"SELECT COUNT(*) FROM sqlite_master WHERE name='film_sync_state'"),0);
}

// 11. peopleNamesVersion is part of the film and of the sync row, and both land in one batch. A dry run writes neither.
{
 const joined=dataset(baseMetadata());
 const {file:bothFile}=migrated();
 let sameBatch=0;
 const watching=d1Standin(bothFile,{onBatch(statements){const text=statements.map(item=>item.text).join('\n');if(text.includes('film_sync_state')&&text.includes('INSERT INTO film ('))sameBatch++;}});
 const summary=await run({DB:watching,BUCKET:joined,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(sameBatch,2,'each metadata.json film shares its first sync row with the film batch');
 const metadata=JSON.parse(body(joined,'metadata.json'));
 metadata.heat.peopleNamesVersion=1;
 joined.put('metadata.json',JSON.stringify(metadata));
 const moved=await run({DB:watching,BUCKET:joined,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(moved.outcome,'complete',JSON.stringify(moved));
 assert.equal(sameBatch,3);
 assert.equal(one(watching,"SELECT people_names_version FROM film_sync_state WHERE film_id='film:heat'"),1);
 const dryBucket=dataset(baseMetadata());
 const {db:dryDb}=migrated();
 const dry=await run({DB:dryDb,BUCKET:dryBucket,D1_ENRICHMENT_WRITE:'dry'});
 assert.equal(dry.outcome,'dry');
 assert.equal(dry.changedSync,2);
 assert.equal(dryDb.calls.batches,0);
 assert.equal(one(dryDb,'SELECT COUNT(*) FROM film_sync_state'),0);
}

console.log('metadataSync clocks: v4 projector unchanged, v5 rows follow R2, 30-day strings stay distinct from the folded clock, reviewed names and titles stay, failed and leased batches do not write, tombstones clear the row, and the sync decision does not read film_sync_state');
