// ADR 0072. The metadata cache becomes the beginSync/metadataSync working set only when the
// schema v6 marker is d1. Until that activation, including on schema v5, R2 stays the working set.
// Counts below come from the fixture. A production sample is not the contract.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCHEMA_VERSION} from '../scripts/d1-backfill.mjs';
import {activateMetadataCache,commitMetadataCache,importMetadataCache,loadMetadataWorkingSet,mergeWatchlistFilm,metadataCacheColumns,metadataPending,readAuthority,revertMetadataCache,saveMetadataWorkingSet,METADATA_FRESH_MS} from '../src/metadata-cache.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const worker=fs.readFileSync('src/worker.js','utf8');
assert.doesNotMatch(worker,/env\.DB\b/);
assert.doesNotMatch(worker,/film_sync_state/);
assert.equal(SCHEMA_VERSION,4,'a reload still stops on every schema after v4');
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/metadata-cache\.js','MetadataCache'\)/);
assert.doesNotMatch(fs.readFileSync('src/d1-enrichment.js','utf8'),/INSERT INTO metadata_cache|UPDATE metadata_cache /);

const NOW=Date.parse('2026-10-31T12:00:00.000Z');
const DAY=86400000;
const edge=new Date(NOW-METADATA_FRESH_MS).toISOString();
const past=new Date(NOW-METADATA_FRESH_MS-1).toISOString();
const fresh=at=>({metadataAt:at,peopleVersion:1,peopleNamesVersion:2,synopsisFetchedAt:at,peopleLocalizedAt:at});
assert.equal(metadataPending(fresh(edge),NOW),false,'the 30-day boundary is still inside the window');
assert.equal(metadataPending(fresh(past),NOW),true,'one millisecond past 30 days is pending');
assert.equal(metadataPending({...fresh(edge),synopsisFetchedAt:null},NOW),true);
assert.equal(metadataPending({...fresh(edge),peopleNamesVersion:1},NOW),true);
assert.equal(metadataPending({...fresh(edge),peopleNamesVersion:'2'},NOW),true,'only the integer 2 finishes names');
assert.equal(metadataPending({},NOW),true);
assert.equal(metadataPending({metadataAt:null,peopleVersion:1,peopleNamesVersion:2,synopsisFetchedAt:edge},NOW),true,'null is not a stamp');
assert.deepEqual(mergeWatchlistFilm({id:'heat',aliases:['from-watchlist'],title:'Heat'},{id:'heat',aliases:['from-cache'],metadataAt:edge,roles:['kept']}),{id:'heat',aliases:['from-cache'],title:'Heat',metadataAt:edge,roles:['kept']});
assert.deepEqual(mergeWatchlistFilm({id:'new',title:'New'}),{id:'new',title:'New'});
assert.equal(metadataPending(mergeWatchlistFilm({id:'new',title:'New'}),NOW),true,'a film with no cache record is pending');
assert.deepEqual(metadataCacheColumns({peopleNamesVersion:'2',metadataAt:'',peopleVersion:1}),{metadataAt:null,synopsisFetchedAt:null,peopleNamesVersion:null,peopleLocalizedAt:null,peopleVersion:1});

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-metadata-cache-'));
let databases=0;
const migrated=(names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'])=>{
 const file=path.join(root,'cache-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const T='2026-10-31T00:00:00.000Z';
const record=(id,extra={})=>({id,title:'Heat',original:'Heat',year:1995,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,peopleLocalizedAt:T,aliases:['heat'],directors:[{id:'director/michael-mann',name:'Michael Mann'}],actors:[{id:'actor/al-pacino',name:'Al Pacino'}],tmdb:'949',tmdb_tv:null,...extra});
const mirrorOf=(body)=>{const bucket=new MemoryBucket();bucket.put('metadata.json',JSON.stringify(body));return bucket;};
const authority=(db)=>db.sql('SELECT mode, cache_generation g, mirror_generation m, mirror_etag e FROM metadata_cache_authority')[0];
const payload=(db,key)=>JSON.parse(db.sql(`SELECT payload_json p FROM metadata_cache WHERE cache_key='${key}'`)[0].p);

// 1. Schema v5, and schema v6 before activation, keep the R2 object. A dead binding fails closed.
{
 const v5=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state']);
 const body={heat:record('heat'),orphan:record('orphan',{synopsis:null})};
 const bucket=mirrorOf(body);
 const loaded=await loadMetadataWorkingSet({DB:v5,BUCKET:bucket});
 assert.equal(loaded.mode,'r2');
 assert.deepEqual(loaded.records,body);
 await saveMetadataWorkingSet({DB:v5,BUCKET:bucket},loaded.records,loaded);
 assert.equal(one(v5,"SELECT COUNT(*) FROM sqlite_master WHERE name='metadata_cache'"),0);
 const v6=migrated();
 assert.equal((await readAuthority(v6)).mode,'r2');
 assert.equal(one(v6,'SELECT version FROM schema_contract'),6);
 const kept=await loadMetadataWorkingSet({DB:v6,BUCKET:bucket});
 assert.equal(kept.mode,'r2');
 assert.deepEqual(kept.records.orphan.synopsis,null);
 assert.equal('synopsis' in payloadSafe(kept.records.heat),true);
 const saved=await saveMetadataWorkingSet({DB:v6,BUCKET:bucket},{...kept.records,heat:{...kept.records.heat,synopsis:'Edited'}},kept);
 assert.equal(saved.mode,'r2');
 assert.equal(one(v6,'SELECT COUNT(*) FROM metadata_cache'),0);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'Edited');
 let reads=0;
 const dead={prepare(){return {bind(){return {async first(){throw new Error('D1 down');},async all(){throw new Error('D1 down');}};}};}};
 const quiet=new MemoryBucket();
 quiet.get=async()=>{reads++;return null;};
 await assert.rejects(loadMetadataWorkingSet({DB:dead,BUCKET:quiet}),/metadata_cache_unavailable/);
 assert.equal(reads,0,'a failed marker read does not decide from metadata.json');
}

function payloadSafe(value){return value;}

// 2. Import copies every key, including an orphan and a null, and does not mint a Film. Activation refuses a mismatch.
{
 const db=migrated();
 const orphan={id:'orphan',tmdb:'1',tmdb_tv:'1',synopsis:null,peopleNamesVersion:'2',aliases:['old-name'],actors:[{id:'actor/al-pacino',name:'Al Pacino',role:'lead'}]};
 const body={heat:record('heat'),orphan,departed:record('departed')};
 const bucket=mirrorOf(body);
 await assert.rejects(importMetadataCache(db,bucket,{}),/metadata_cache_confirm/);
 await assert.rejects(importMetadataCache(db,bucket,{confirm:'activate'}),/metadata_cache_confirm/);
 const imported=await importMetadataCache(db,bucket,{confirm:'load'});
 assert.equal(imported.mode,'r2');
 assert.equal(imported.keys,3);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0,'an orphan key does not create a Film');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),3);
 assert.deepEqual(payload(db,'orphan'),orphan);
 assert.equal(payload(db,'orphan').synopsis,null);
 assert.equal(payload(db,'heat').tmdb,'949');
 assert.equal(payload(db,'heat').tmdb_tv,null);
 assert.equal(one(db,"SELECT people_names_version FROM metadata_cache WHERE cache_key='orphan'"),null,'a string version is not the integer 2');
 assert.equal(one(db,"SELECT people_names_version FROM metadata_cache WHERE cache_key='heat'"),2);
 const row=authority(db);
 assert.equal(row.mode,'r2');
 assert.equal(row.g,row.m);
 bucket.put('metadata.json',JSON.stringify({heat:record('heat',{metadataAt:past})}));
 await assert.rejects(activateMetadataCache(db,bucket,{confirm:'activate'}),/metadata_cache_fence/);
 assert.equal(authority(db).mode,'r2');
 bucket.put('metadata.json',JSON.stringify(body));
 const active=await activateMetadataCache(db,bucket,{confirm:'activate'});
 assert.equal(active.mode,'d1');
 assert.equal(active.cacheGeneration,active.mirrorGeneration);
}

// 3. In d1 mode the working set is the table. A commit is fenced, idempotent, and keeps a key the watchlist no longer lists.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan'),departed:record('departed')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 bucket.put('metadata.json',JSON.stringify({heat:record('heat',{metadataAt:past,synopsis:'stale'})}));
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 assert.equal(working.mode,'d1');
 assert.equal(working.records.heat.metadataAt,T,'a stale mirror is not the decision');
 assert.equal(working.records.orphan.id,'orphan');
 const next={...working.records,heat:{...working.records.heat,synopsisFetchedAt:edge,synopsis:'Only the synopsis'}};
 delete next.brand;
 const first=await commitMetadataCache(db,bucket,next,{...working.authority,complete:true,mode:'d1'});
 assert.equal(first.mirrored,true);
 assert.equal(payload(db,'heat').synopsis,'Only the synopsis');
 assert.equal(payload(db,'departed').id,'departed','leaving the watchlist does not drop the cache key');
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'Only the synopsis');
 const again=await commitMetadataCache(db,bucket,next,{...first.authority,complete:true,mode:'d1'});
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),3);
 assert.deepEqual(payload(db,'heat'),next.heat);
 assert.equal(authority(db).g,first.cacheGeneration+1);
 const stale={...first.authority,mode:'d1',complete:true};
 const text=bucket.objects.get('metadata.json').text;
 await assert.rejects(commitMetadataCache(db,bucket,{heat:record('heat',{metadataAt:past})},stale),/metadata_cache_cas/);
 assert.equal(bucket.objects.get('metadata.json').text,text,'a lost fence does not write the mirror');
 assert.equal(payload(db,'heat').metadataAt,T);
}

// 4. A crash after the D1 commit leaves the mirror behind, and the next read repairs it from D1.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 const updated={...working.records,heat:{...working.records.heat,metadataAt:edge}};
 let crash=false;
 const put=bucket.put.bind(bucket);
 bucket.put=async(key,value,options)=>{if(crash&&key==='metadata.json')throw new Error('mirror down');return put(key,value,options);};
 crash=true;
 const committed=await commitMetadataCache(db,bucket,updated,{...working.authority,complete:true,mode:'d1'});
 assert.equal(committed.mirrored,false);
 assert.equal(payload(db,'heat').metadataAt,edge);
 assert.notEqual(authority(db).g,authority(db).m);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.metadataAt,T);
 crash=false;
 const repaired=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 assert.equal(repaired.records.heat.metadataAt,edge);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.metadataAt,edge);
 assert.equal(authority(db).g,authority(db).m);
}

// 5. An etag race keeps the D1 body. A corrupt row fails closed. Reviewed rows and a D1-only credit survive a commit.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const mark=authority(db);
 bucket.put('metadata.json',JSON.stringify({heat:record('heat',{synopsis:'raced'})}));
 const raced=await commitMetadataCache(db,bucket,{...body,heat:record('heat',{synopsis:'from d1'})},{mode:'d1',cacheGeneration:mark.g,mirrorGeneration:mark.m,mirrorEtag:mark.e,complete:true});
 assert.equal(raced.mirrored,true);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'from d1');
 db.sql("UPDATE metadata_cache SET payload_json='{' WHERE cache_key='orphan'");
 await assert.rejects(loadMetadataWorkingSet({DB:db,BUCKET:bucket}),/metadata_cache_unavailable/);
 db.sql(`UPDATE metadata_cache SET payload_json='${JSON.stringify(body.orphan).replace(/'/g,"''")}' WHERE cache_key='orphan'`);
 const person="INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/555','tmdb_actor/555',1,'"+T+"')";
 db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:heat',1,'tmdb:949','Heat','"+T+"')");
 db.sql(person);
 db.sql("INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:heat','person:tmdb_actor/555','actor',4)");
 db.sql("INSERT INTO film_dimension (film_id,dimension,status,value,updated_at) VALUES ('film:heat','localization','reviewed','Жара','"+T+"')");
 db.sql("INSERT INTO person_dimension (person_id,dimension,status,value,updated_at) VALUES ('person:tmdb_actor/555','localization','reviewed','Аль Пачино','"+T+"')");
 const current=await readAuthority(db);
 await commitMetadataCache(db,bucket,body,{...current,complete:true});
 assert.equal(one(db,"SELECT value FROM film_dimension WHERE film_id='film:heat' AND dimension='localization'"),'Жара');
 assert.equal(one(db,"SELECT value FROM person_dimension WHERE person_id='person:tmdb_actor/555'"),'Аль Пачино');
 assert.equal(one(db,"SELECT COUNT(*) FROM film_person_credit WHERE person_id='person:tmdb_actor/555'"),1);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),1);
}

// 6. The projector reads R2 while the marker is r2, and reads the cache once the marker is d1.
// A stale mirror does not roll a clock back. An orphan still does not become a Film.
{
 const projector=projectorContext();
 const db=migrated();
 const films=[{id:'heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',url:'https://letterboxd.com/film/heat/'}];
 const metadata={heat:record('heat'),orphan:record('orphan')};
 const bucket=new MemoryBucket();
 const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});
 put('metadata.json',metadata);
 put('titles.json',{});
 put('people.json',{});
 put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 const env={DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'};
 const before=await projector.runD1EnrichmentProjection(env);
 assert.equal(before.outcome,'complete',JSON.stringify(before));
 assert.equal(before.schemaVersion,6);
 assert.deepEqual(db.sql("SELECT metadata_at a FROM film_sync_state WHERE film_id='film:heat'"),[{a:T}]);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:orphan'"),0);
 const status=await projector.d1EnrichmentStatus(db,{D1_ENRICHMENT_WRITE:'on'});
 assert.equal(status.schema,true);
 assert.equal(status.schemaVersion,6);
 assert.equal(status.cacheMode,'r2');
 assert.equal(status.cacheGeneration,0);
 const v5=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state']);
 const v5Status=await projector.d1EnrichmentStatus(v5,{});
 assert.equal(v5Status.schema,true);
 assert.equal(v5Status.schemaVersion,5);
 assert.equal(v5Status.cacheMode,undefined);
 v5.sql('UPDATE schema_contract SET version=6');
 const partial=await projector.d1EnrichmentStatus(v5,{});
 assert.deepEqual([partial.schema,partial.schemaVersion],[false,6]);
 const mirror=mirrorOf(metadata);
 await importMetadataCache(db,mirror,{confirm:'load'});
 await activateMetadataCache(db,mirror,{confirm:'activate'});
 const newer=edge;
 db.sql(`UPDATE metadata_cache SET payload_json='${JSON.stringify(record('heat',{metadataAt:newer})).replace(/'/g,"''")}', metadata_at='${newer}', generation=${authority(db).g} WHERE cache_key='heat'`);
 put('metadata.json',{heat:record('heat',{metadataAt:past}),orphan:record('orphan')});
 put('watchlist.json',{updatedAt:T,films:[...films,{id:'brand',title:'Brand',original:'Brand',year:2001,tmdbId:'7',url:'https://letterboxd.com/film/brand/'}]});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:[...films,{id:'brand',title:'Brand',original:'Brand',year:2001}].map(item=>({...item,shows:[]}))});
 db.sql(`INSERT INTO metadata_cache (cache_key,payload_json,metadata_at,synopsis_fetched_at,people_names_version,people_localized_at,people_version,generation) VALUES ('brand','${JSON.stringify(record('brand',{metadataAt:newer,tmdb:'7'})).replace(/'/g,"''")}','${newer}','${newer}',2,'${newer}',1,${authority(db).g})`);
 const after=await projector.runD1EnrichmentProjection(env);
 assert.equal(after.outcome,'complete',JSON.stringify(after));
 assert.equal(db.sql("SELECT metadata_at a FROM film_sync_state WHERE film_id='film:heat'")[0].a,newer,'the projector does not copy the stale mirror');
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:orphan'"),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:brand'"),1,'a new cache record is projected when the watchlist lists it');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache WHERE cache_key=\'orphan\''),1);
 const batches=db.calls.batches;
 const replay=await projector.runD1EnrichmentProjection(env);
 assert.equal(replay.writtenFilms,0);
 assert.equal(db.calls.batches,batches,'a d1-mode replay does not write');
}

// 7. The operator script refuses a write without the matching confirm, and does not accept production.
{
 const script=path.resolve('scripts/metadata-cache-authority.mjs');
 const run=(...argv)=>spawnSync(process.execPath,[script,...argv],{encoding:'utf8'});
 const bare=run('--load');
 assert.notEqual(bare.status,0);
 assert.match(bare.stderr,/confirm/);
 const production=run('--load','--confirm','load','--database','iptv','--metadata','metadata.json');
 assert.notEqual(production.status,0);
 assert.match(production.stderr,/production/);
 const status=run();
 assert.equal(status.status,0,status.stderr);
 assert.equal(JSON.parse(status.stdout).writes,false);
 const file=path.join(root,'script.sqlite');
 const db=d1Standin(file);
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 const metadata=path.join(root,'metadata.json');
 fs.writeFileSync(metadata,JSON.stringify({heat:record('heat'),orphan:record('orphan')}));
 const loaded=run('--load','--confirm','load','--database',file,'--metadata',metadata);
 assert.equal(loaded.status,0,loaded.stderr);
 assert.equal(JSON.parse(loaded.stdout).mode,'r2');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),2);
 assert.equal(one(db,"SELECT COUNT(*) FROM film"),0);
 const flipped=run('--activate','--confirm','activate','--database',file,'--metadata',metadata);
 assert.equal(flipped.status,0,flipped.stderr);
 assert.equal(JSON.parse(flipped.stdout).mode,'d1');
 const back=run('--revert','--confirm','r2','--database',file);
 assert.equal(back.status,0,back.stderr);
 assert.equal(JSON.parse(back.stdout).mode,'r2');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),2,'reverting the marker keeps the rows');
 const direct=migrated();
 await assert.rejects(revertMetadataCache(direct,{}),/metadata_cache_confirm/);
}

console.log('metadata cache: r2 until the marker is d1, full records including orphans, fenced commit, mirror repair, no phantom Film');
