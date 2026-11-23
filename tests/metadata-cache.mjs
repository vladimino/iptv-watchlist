// ADR 0073, ADR 0162. The metadata cache is the beginSync/metadataSync working set only while the
// schema v6 marker is d1. Any other marker, a missing binding, schema v5 or missing tables fails closed;
// only the explicit local stand-in (METADATA_CACHE_DB_OPTIONAL=standin) keeps the R2 object.
// Counts below come from the fixture. A production sample is not the contract.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SCHEMA_VERSION} from '../scripts/d1-backfill.mjs';
import {commitMetadataCache,loadMetadataWorkingSet,mergeWatchlistFilm,metadataCacheColumns,metadataPending,readAuthority,saveMetadataWorkingSet,METADATA_FRESH_MS} from '../src/metadata-cache.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const worker=fs.readFileSync('src/worker.js','utf8');
assert.doesNotMatch(worker,/env\.DB\b/);
assert.doesNotMatch(worker,/film_sync_state/);
assert.equal(SCHEMA_VERSION,4,'a reload still stops on every schema after v4');
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/metadata-cache\.js','MetadataCache'\)/);
// ADR 0162: the explicit stand-in exists only for local development and the harness.
assert.doesNotMatch(worker,/METADATA_CACHE_DB_OPTIONAL/);
assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/METADATA_CACHE_DB_OPTIONAL/);
assert.doesNotMatch(fs.readFileSync('scripts/local-dev.mjs','utf8'),/METADATA_CACHE_DB_OPTIONAL/,'AIR-576: the local stack runs a real D1 and opts into no stand-in');
assert.equal(fs.existsSync('scripts/metadata-cache-authority.mjs'),false,'the offline load, activate and revert operator is retired');
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
// ADR 0162: the import and activate tooling is retired. A fixture sets the marker directly and stores the
// mirror's records through the normal writer, which also writes the mirror.
async function seed(db,bucket){
 const object=await bucket.get('metadata.json');
 const records=object?await object.json():{};
 db.sql("UPDATE metadata_cache_authority SET mode='d1' WHERE id=1");
 return commitMetadataCache(db,bucket,records,{...(await readAuthority(db)),complete:true});
}
const STANDIN={METADATA_CACHE_DB_OPTIONAL:'standin'};

// 1. Schema v5, a schema v6 marker in mode r2 and a missing binding fail closed; only the explicit stand-in keeps the R2
// object. A dead binding fails closed.
{
 const v5=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state']);
 const body={heat:record('heat'),orphan:record('orphan',{synopsis:null})};
 const bucket=mirrorOf(body);
 await assert.rejects(loadMetadataWorkingSet({DB:v5,BUCKET:bucket}),/metadata_cache_unavailable/,'schema v5 without the stand-in is refused');
 const loaded=await loadMetadataWorkingSet({DB:v5,BUCKET:bucket,...STANDIN});
 assert.equal(loaded.mode,'standin');
 assert.deepEqual(loaded.records,body);
 assert.equal(payloadSafe(loaded.records.orphan).synopsis,null);
 const local=await saveMetadataWorkingSet({DB:v5,BUCKET:bucket,...STANDIN},{...loaded.records,heat:{...loaded.records.heat,synopsis:'Edited'}},loaded);
 assert.equal(local.mode,'standin');
 assert.equal(JSON.parse(bucket.objects.get('metadata.json').text).heat.synopsis,'Edited');
 assert.equal(one(v5,"SELECT COUNT(*) FROM sqlite_master WHERE name='metadata_cache'"),0);
 await assert.rejects(loadMetadataWorkingSet({BUCKET:bucket}),/metadata_cache_unavailable/,'a missing binding is refused');
 assert.equal((await loadMetadataWorkingSet({BUCKET:bucket,...STANDIN})).mode,'standin');
 const v6=migrated();
 assert.equal(one(v6,'SELECT version FROM schema_contract'),6);
 assert.equal(authority(v6).mode,'r2','the migration seeds mode r2');
 await assert.rejects(readAuthority(v6),/metadata_cache_unavailable/,'a marker in mode r2 is refused (ADR 0162)');
 await assert.rejects(readAuthority({DB:v6,...STANDIN}),/metadata_cache_unavailable/,'the stand-in does not serve a marker in mode r2');
 const text=bucket.objects.get('metadata.json').text;
 await assert.rejects(loadMetadataWorkingSet({DB:v6,BUCKET:bucket}),/metadata_cache_unavailable/);
 await assert.rejects(saveMetadataWorkingSet({DB:v6,BUCKET:bucket},{heat:record('heat',{synopsis:'late'})},{mode:'standin'}),/metadata_cache_unavailable/);
 assert.equal(bucket.objects.get('metadata.json').text,text,'a refused save writes nothing to R2');
 assert.equal(one(v6,'SELECT COUNT(*) FROM metadata_cache'),0);
 let reads=0;
 const dead={prepare(){return {bind(){return {async first(){throw new Error('D1 down');},async all(){throw new Error('D1 down');}};}};}};
 const quiet=new MemoryBucket();
 quiet.get=async()=>{reads++;return null;};
 await assert.rejects(loadMetadataWorkingSet({DB:dead,BUCKET:quiet}),/metadata_cache_unavailable/);
 assert.equal(reads,0,'a failed marker read does not decide from metadata.json');
}

function payloadSafe(value){return value;}

// 2. A commit stores every key, including an orphan and a null, and does not mint a Film.
{
 const db=migrated();
 const orphan={id:'orphan',tmdb:'1',tmdb_tv:'1',synopsis:null,peopleNamesVersion:'2',aliases:['old-name'],actors:[{id:'actor/al-pacino',name:'Al Pacino',role:'lead'}]};
 const body={heat:record('heat'),orphan,departed:record('departed')};
 const bucket=mirrorOf(body);
 const seeded=await seed(db,bucket);
 assert.equal(seeded.mode,'d1');
 assert.equal(seeded.mirrored,true);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0,'an orphan key does not create a Film');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),3);
 assert.deepEqual(payload(db,'orphan'),orphan);
 assert.equal(payload(db,'orphan').synopsis,null);
 assert.equal(payload(db,'heat').tmdb,'949');
 assert.equal(payload(db,'heat').tmdb_tv,null);
 assert.equal(one(db,"SELECT people_names_version FROM metadata_cache WHERE cache_key='orphan'"),null,'a string version is not the integer 2');
 assert.equal(one(db,"SELECT people_names_version FROM metadata_cache WHERE cache_key='heat'"),2);
 const row=authority(db);
 assert.equal(row.mode,'d1');
 assert.equal(row.g,row.m);
}

// 3. In d1 mode the working set is the table. A commit is fenced, idempotent, and keeps a key the watchlist no longer lists.
{
 const db=migrated();
 const body={heat:record('heat'),orphan:record('orphan'),departed:record('departed')};
 const bucket=mirrorOf(body);
 await seed(db,bucket);
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
 await seed(db,bucket);
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
 await seed(db,bucket);
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
 const body={};
 for(let i=0;i<150;i++)body['k'+i]=record('k'+i,{synopsis:i===0?null:'kept'});
 const bucket=mirrorOf(body);
 const seedBinds=limitBinds(db);
 await seed(db,bucket);
 assert.ok(seedBinds.max()<=100,'the seeding commit of 150 keys stays inside the limit too');
 assert.equal(one(db,'SELECT COUNT(*) FROM metadata_cache'),150);
 const binds=limitBinds(db);
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
 await seed(db,bucket);
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

// 12. Schema v6 without the cache tables or the marker fails closed. A missing binding is refused unless the stand-in is set.
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
 await assert.rejects(loadMetadataWorkingSet({BUCKET:mirrorOf({heat:record('heat')})}),/metadata_cache_unavailable/,'a missing binding is refused');
 const unbound=await loadMetadataWorkingSet({BUCKET:mirrorOf({heat:record('heat')}),...STANDIN});
 assert.equal(unbound.mode,'standin');
 assert.equal(unbound.records.heat.id,'heat');
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
 await seed(db,bucket);
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
