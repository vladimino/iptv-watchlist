// ADR 0073. The metadata cache becomes the beginSync/metadataSync working set only when the
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
 assert.equal(saved.cacheGeneration,1,'an r2 save on schema v6 claims the generation before the put');
 assert.equal(authority(v6).mode,'r2');
 assert.equal(authority(v6).g,authority(v6).m);
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
 const missingFile=run('--revert','--confirm','r2','--database',file);
 assert.notEqual(missingFile.status,0);
 assert.match(missingFile.stderr,/metadata/);
 const back=run('--revert','--confirm','r2','--database',file,'--metadata',metadata);
 assert.equal(back.status,0,back.stderr);
 assert.equal(JSON.parse(back.stdout).mode,'r2');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),2,'reverting the marker keeps the rows');
 const direct=migrated();
 await assert.rejects(revertMetadataCache(direct,mirrorOf({}),{}),/metadata_cache_confirm/);
}

function holdMetadataPuts(bucket){
 const real=bucket.put.bind(bucket);
 const waiting=[];
 let holding=false;
 bucket.put=async(key,value,options)=>{
  if(holding&&key==='metadata.json')await new Promise(resolve=>waiting.push(resolve));
  return real(key,value,options);
 };
 return {hold(){holding=true;},pass(){holding=false;},release(){const resolve=waiting.shift();if(resolve)resolve();},get pending(){return waiting.length;}};
}
async function until(predicate){
 for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,0));}
 throw new Error('timed out');
}
function limitBinds(db,limit=100){
 const prepare=db.prepare.bind(db);
 const seen=[];
 db.prepare=sql=>{
  const statement=prepare(sql);
  return {
   bind(...params){
    seen.push({sql,count:params.length});
    if(params.length>limit)throw new Error('D1_ERROR: too many SQL variables');
    return statement.bind(...params);
   },
   first:()=>statement.first(),all:()=>statement.all(),run:()=>statement.run(),
  };
 };
 return {max:()=>seen.reduce((max,item)=>Math.max(max,item.count),0),deletes:()=>seen.filter(item=>item.sql.startsWith('DELETE FROM metadata_cache'))};
}

// 8. A complete save of more than 100 keys stays inside D1's bound-parameter limit and still drops a departed key.
{
 const db=migrated();
 const binds=limitBinds(db);
 const body={};
 for(let i=0;i<150;i++)body['k'+i]=record('k'+i,{synopsis:i===0?null:'kept'});
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),150);
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 delete working.records.k0;
 const committed=await commitMetadataCache(db,bucket,working.records,{...working.authority,complete:true,mode:'d1'});
 assert.equal(committed.mirrored,true);
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),149);
 assert.equal(db.sql("SELECT cache_key FROM metadata_cache WHERE cache_key='k0'").length,0,'a departed key is deleted without a NOT IN list');
 assert.equal(payload(db,'k1').synopsis,'kept');
 assert.ok(binds.max()<=100,'no statement bound more than 100 parameters');
 assert.deepEqual(binds.deletes().map(item=>item.count).filter(count=>count>0),[1]);
 assert.throws(()=>db.prepare('SELECT '+Array(101).fill('?').join(',')).bind(...Array(101).fill(1)),/too many SQL variables/);
}

// 9. An older mirror publication cannot replace a newer one, in either completion order, including a read repair.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 const olderBody={...working.records,heat:{...working.records.heat,synopsis:'older'}};
 const hold=holdMetadataPuts(bucket);
 hold.hold();
 const older=commitMetadataCache(db,bucket,olderBody,{...working.authority,complete:true,mode:'d1'});
 await until(()=>hold.pending===1);
 const mid=await readAuthority(db);
 hold.pass();
 const newerBody={...olderBody,heat:{...olderBody.heat,synopsis:'newer'}};
 const newer=await commitMetadataCache(db,bucket,newerBody,{...mid,complete:true,mode:'d1'});
 assert.equal(newer.mirrored,true);
 hold.release();
 const finished=await older;
 assert.equal(finished.mirrored,false);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'newer');
 assert.equal(payload(db,'heat').synopsis,'newer');
 assert.equal(authority(db).g,authority(db).m);

 const ordered=await commitMetadataCache(db,bucket,{...newerBody,heat:{...newerBody.heat,synopsis:'after'}},{...newer.authority,complete:true,mode:'d1'});
 assert.equal(ordered.mirrored,true);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'after');
 const real=bucket.put.bind(bucket);
 const down={on:true};
 bucket.put=async(key,value,options)=>{if(down.on&&key==='metadata.json')throw new Error('mirror down');return real(key,value,options);};
 const laggedBody={...newerBody,heat:{...newerBody.heat,synopsis:'lagged'}};
 const lagged=await commitMetadataCache(db,bucket,laggedBody,{...ordered.authority,complete:true,mode:'d1'});
 assert.equal(lagged.mirrored,false);
 assert.notEqual(authority(db).g,authority(db).m);
 down.on=false;
 bucket.put=real;
 const repairHold=holdMetadataPuts(bucket);
 repairHold.hold();
 const repair=loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 await until(()=>repairHold.pending===1);
 repairHold.pass();
 const during=await readAuthority(db);
 const overtook=await commitMetadataCache(db,bucket,{...laggedBody,heat:{...laggedBody.heat,synopsis:'overtook'}},{...during,complete:true,mode:'d1'});
 assert.equal(overtook.mirrored,true);
 repairHold.release();
 await repair;
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'overtook');
 assert.equal(authority(db).g,authority(db).m);
 const followed=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 assert.equal(followed.records.heat.synopsis,'overtook');
}

// 10. Revert refuses while the mirror lags, then flips only after a verified catch-up.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 const real=bucket.put.bind(bucket);
 const down={on:true};
 bucket.put=async(key,value,options)=>{if(down.on&&key==='metadata.json')throw new Error('mirror down');return real(key,value,options);};
 const updated={...working.records,heat:{...working.records.heat,synopsis:'committed'}};
 const committed=await commitMetadataCache(db,bucket,updated,{...working.authority,complete:true,mode:'d1'});
 assert.equal(committed.mirrored,false);
 await assert.rejects(revertMetadataCache(db,bucket,{confirm:'r2'}),/metadata_cache_fence/);
 assert.equal(authority(db).mode,'d1');
 assert.equal(payload(db,'heat').synopsis,'committed');
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'Synopsis');
 down.on=false;
 const reverted=await revertMetadataCache(db,bucket,{confirm:'r2'});
 assert.equal(reverted.mode,'r2');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),2);
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'committed');
 assert.equal(authority(db).g,authority(db).m);
}

// 11. Activation and an in-flight r2 save cannot both become the writer.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 const seen=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 assert.equal(seen.mode,'r2');
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const text=bucket.objects.get('metadata.json').text;
 const rows=one(db,'SELECT COUNT(*) FROM metadata_cache');
 await assert.rejects(saveMetadataWorkingSet({DB:db,BUCKET:bucket},{...seen.records,heat:{...seen.records.heat,synopsis:'late'}},seen),/metadata_cache_not_authoritative/);
 assert.equal(bucket.objects.get('metadata.json').text,text);
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),rows);
 assert.equal(payload(db,'heat').synopsis,'Synopsis');
 assert.equal(authority(db).mode,'d1');

 const claimedDb=migrated();
 const claimedBucket=mirrorOf(body);
 await importMetadataCache(claimedDb,claimedBucket,{confirm:'load'});
 const open=await loadMetadataWorkingSet({DB:claimedDb,BUCKET:claimedBucket});
 const hold=holdMetadataPuts(claimedBucket);
 hold.hold();
 const saving=saveMetadataWorkingSet({DB:claimedDb,BUCKET:claimedBucket},{...open.records,heat:{...open.records.heat,synopsis:'claimed'}},open);
 await until(()=>hold.pending===1);
 assert.notEqual(authority(claimedDb).g,authority(claimedDb).m);
 await assert.rejects(activateMetadataCache(claimedDb,claimedBucket,{confirm:'activate'}),/metadata_cache_fence/);
 assert.equal(authority(claimedDb).mode,'r2');
 hold.release();
 const saved=await saving;
 assert.equal(saved.mode,'r2');
 assert.equal(JSON.parse(claimedBucket.objects.get('metadata.json').text).heat.synopsis,'claimed');
 await assert.rejects(activateMetadataCache(claimedDb,claimedBucket,{confirm:'activate'}),/metadata_cache_loss/);
 assert.equal(authority(claimedDb).mode,'r2');
 assert.equal(one(claimedDb,'SELECT COUNT(*) FROM metadata_cache'),2);
}

// 12. Schema v6 without the cache tables or the marker fails closed. Schema v5 and a missing binding stay on R2.
{
 const db=migrated();
 db.sql('DROP TABLE metadata_cache');
 let reads=0;
 const bucket=mirrorOf({heat:record('heat')});
 const get=bucket.get.bind(bucket);
 bucket.get=async(...args)=>{reads++;return get(...args);};
 await assert.rejects(loadMetadataWorkingSet({DB:db,BUCKET:bucket}),/metadata_cache_unavailable/);
 await assert.rejects(saveMetadataWorkingSet({DB:db,BUCKET:bucket},{heat:record('heat')},{mode:'r2'}),/metadata_cache_unavailable/);
 assert.equal(reads,0,'partial schema v6 does not decide from metadata.json');
 const marked=migrated();
 marked.sql('DELETE FROM metadata_cache_authority');
 await assert.rejects(loadMetadataWorkingSet({DB:marked,BUCKET:bucket}),/metadata_cache_unavailable/);
 const unbound=await loadMetadataWorkingSet({BUCKET:mirrorOf({heat:record('heat')})});
 assert.equal(unbound.mode,'r2');
 assert.equal(unbound.records.heat.id,'heat');
 const v5=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state']);
 v5.sql('UPDATE schema_contract SET version=6');
 const films=[{id:'heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',url:'https://letterboxd.com/film/heat/'}];
 const programme=new MemoryBucket();
 const put=(key,value)=>programme.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});
 put('metadata.json',{heat:record('heat')});
 put('titles.json',{});
 put('people.json',{});
 put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 const failed=await projectorContext().runD1EnrichmentProjection({DB:v5,BUCKET:programme,D1_ENRICHMENT_WRITE:'on'});
 assert.equal(failed.outcome,'failed',JSON.stringify(failed));
 assert.equal(failed.reason,'metadata_cache_unavailable');
 assert.equal(one(v5,'SELECT COUNT(*) FROM film'),0,'a partial v6 run writes no Film');
}

function pauseAuthoritySelect(db,nth){
 const prepare=db.prepare.bind(db);
 let seen=0,open,go;
 const ready=new Promise(resolve=>{open=resolve;});
 const gate=new Promise(resolve=>{go=resolve;});
 db.prepare=sql=>{
  const statement=prepare(sql);
  return {bind(...params){
   const bound=statement.bind(...params);
   return {
    text:bound.text,
    async first(){
     if(/FROM metadata_cache_authority\b/.test(sql)){
      seen++;
      if(seen===nth){open();await gate;}
     }
     return bound.first();
    },
    all:()=>bound.all(),
    run:()=>bound.run(),
   };
  }};
 };
 return {ready,release(){go();},seen:()=>seen};
}

// 13. A read repair that loses the race does not return older records with the newer generation.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan')};
 const bucket=mirrorOf(body);
 await importMetadataCache(db,bucket,{confirm:'load'});
 await activateMetadataCache(db,bucket,{confirm:'activate'});
 const working=await loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 const real=bucket.put.bind(bucket);
 const down={on:true};
 bucket.put=async(key,value,options)=>{if(down.on&&key==='metadata.json')throw new Error('mirror down');return real(key,value,options);};
 const laggedBody={...working.records,heat:{...working.records.heat,synopsis:'g2'}};
 const lagged=await commitMetadataCache(db,bucket,laggedBody,{...working.authority,complete:true,mode:'d1'});
 assert.equal(lagged.mirrored,false);
 down.on=false;
 bucket.put=real;
 const pause=pauseAuthoritySelect(db,4);
 const loading=loadMetadataWorkingSet({DB:db,BUCKET:bucket});
 await Promise.race([pause.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('authority select '+pause.seen()+' did not reach the repair read')),1000))]);
 const g3Body={...laggedBody,heat:{...laggedBody.heat,synopsis:'g3-distinct',stamp:'g3'}};
 const g3=await commitMetadataCache(db,bucket,g3Body,{...lagged.authority,complete:true,mode:'d1'});
 assert.equal(g3.mirrored,true);
 assert.equal(payload(db,'heat').stamp,'g3');
 pause.release();
 const loaded=await loading;
 const live=await readAuthority(db);
 if(loaded.records.heat.synopsis!=='g3-distinct')assert.notEqual(loaded.authority.cacheGeneration,live.cacheGeneration);
 else assert.equal(loaded.authority.cacheGeneration,live.cacheGeneration);
 let rejected=false;
 try{await commitMetadataCache(db,bucket,loaded.records,{...loaded.authority,complete:true,mode:'d1'});}
 catch(error){rejected=true;assert.equal(error.code,'metadata_cache_cas');}
 assert.equal(rejected||loaded.records.heat.synopsis==='g3-distinct',true);
 assert.equal(payload(db,'heat').synopsis,'g3-distinct');
 assert.equal(payload(db,'heat').stamp,'g3');
}

console.log('metadata cache: r2 until the marker is d1, full records including orphans, fenced commit, mirror repair, no phantom Film');
