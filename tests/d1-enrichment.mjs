// AIR-275 phase 2 / ADR 0056: the D1 enrichment projector. A D1 stand-in runs the real migrations in the sqlite3 CLI and applies
// each batch as one transaction; R2 is a memory bucket. Covered: off reads nothing, dry writes nothing, on writes and converges,
// change keys ignore the run's own clock, the D1-only TMDB credits of a watchlist Film survive and are renumbered while
// Letterboxd credits come and go, the R2 roster wins a duplicate, a catalog Film's credits follow R2, fingerprint and prediction
// dimensions stay, a Film no source lists is released once, the lease keeps a second run out, a run that lost its lease writes
// nothing, the query budget resumes on the next run, one bad Person does not hold back its group, the seed, the status view.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';
import {openSqlite} from '../scripts/offline-import.mjs';
import {seedProjection} from '../scripts/d1-projection-seed.mjs';

const source=fs.readFileSync('src/d1-enrichment.js','utf8');
assert.doesNotMatch(source,/\bBUCKET\.(put|delete)\b/,'the projector never writes R2');
assert.match(fs.readFileSync('src/worker.js','utf8'),/async scheduled\(controller,env,execution\)\{execution\.waitUntil\(runD1EnrichmentProjection\(/);
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/runD1EnrichmentProjection\([^)]*\)[^\n]*metadataSync|metadataSync[^\n]*runD1EnrichmentProjection/,'no sync step runs the projector');
assert.match(fs.readFileSync('wrangler.jsonc','utf8'),/"crons": \["37 \* \* \* \*"\]/);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-enrichment-'));
let databases=0;
const migrated=(names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])=>{
 const file=path.join(root,'d1-'+(databases++)+'.sqlite');
 const db=d1Standin(file);
 for(const name of names)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return {file,db};
};
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const MANN=person('director/michael-mann','Michael Mann'),PACINO=person('actor/al-pacino','Al Pacino'),DE_NIRO=person('actor/robert-de-niro','Robert De Niro'),KILMER=person('actor/val-kilmer','Val Kilmer'),FOXX=person('actor/jamie-foxx','Jamie Foxx');
const film=(id,title,tmdbId,directors,actors)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors,actors});
const meta=(record)=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
function r2({heat=[PACINO,DE_NIRO],collateral=true,catalogActors=[person('tmdb_actor/2','Jean Reno')],heatCatalog=null}={}){
 const films=[film('heat','Heat','949',[MANN],heat),...(collateral?[film('collateral','Collateral','1538',[MANN],[FOXX])]:[])];
 const bucket=new MemoryBucket();
 const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});
 put('programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});
 put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/discovered-films.json',{tmdb_100:{id:'tmdb_100',tmdbId:'100',title:'Ronin',original:'Ronin',year:1998,discoveredAt:T,synopsis:'Overview',directors:[person('tmdb_director/1','John Frankenheimer')],actors:catalogActors},...(heatCatalog?{tmdb_949:{id:'tmdb_949',tmdbId:'949',title:'Heat',original:'Heat',year:1995,discoveredAt:T,synopsis:'Overview',directors:[],actors:heatCatalog}}:{})});
 // The projector reads the published generation's copies, never the root ones.
 bucket.objects.set('epg/generations/run-1/programme.json',bucket.objects.get('programme.json'));
 bucket.objects.set('epg/generations/run-1/discovered-films.json',bucket.objects.get('epg/discovered-films.json'));
 bucket.objects.delete('programme.json');bucket.objects.delete('epg/discovered-films.json');
 return bucket;
}
const reads=bucket=>{const counted={count:0};const get=bucket.get.bind(bucket);bucket.get=async key=>{counted.count++;return get(key);};return counted;};
const logs=[];
const projector=projectorContext({log:line=>logs.push(JSON.parse(line))});
const run=(env,options={})=>projector.runD1EnrichmentProjection(env,options);
const credits=(db,id)=>db.sql(`SELECT person_id p,role r,ordinal o FROM film_person_credit WHERE film_id='${id}' ORDER BY role,ordinal`).map(row=>row.r[0]+row.o+':'+row.p);
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];

// 1. off: nothing is read, nothing is written; a missing binding is reported.
{
 const bucket=r2(),counted=reads(bucket),{db}=migrated();
 assert.deepEqual({...await run({DB:db,BUCKET:bucket})},{mode:'off',skipped:'off'});
 assert.equal(counted.count,0);assert.equal(db.calls.queries+db.calls.batches,0);
 assert.equal((await run({BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'})).skipped,'binding_missing');
 for(const value of ['On',' on','true','dry ',{}])assert.equal(projector.d1EnrichmentMode({D1_ENRICHMENT_WRITE:value}),'off');
}

// 2. dry: the whole diff is computed and logged, D1 gets reads only.
const {db,file}=migrated();
const bucket=r2();
{
 const summary=await run({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'dry'});
 assert.equal(summary.outcome,'dry');
 assert.deepEqual([summary.films,summary.changedFilms,summary.people,summary.changedPeople,summary.absent],[3,3,6,6,0]);
 assert.equal(db.calls.batches,0);assert.equal(one(db,'SELECT COUNT(*) FROM film'),0);assert.equal(one(db,'SELECT COUNT(*) FROM projection_run'),0);
 assert.equal(logs.at(-1).event,'d1_enrichment_projection');assert.equal(logs.at(-1).outcome,'dry');
}

// 3. on: every Person, then every Film, each with its change key; the run releases its lease and records its summary.
const env={DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'};
{
 const summary=await run(env);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.deepEqual([summary.writtenPeople,summary.writtenFilms,summary.errorCount],[6,3,0]);
 assert.equal(one(db,'SELECT COUNT(*) FROM projection_state'),9);
 assert.deepEqual(db.sql('SELECT film_id f FROM watchlist_film ORDER BY film_id').map(row=>row.f),['film:collateral','film:heat']);
 assert.deepEqual(credits(db,'film:heat'),['a0:person:actor/al-pacino','a1:person:actor/robert-de-niro','d0:person:director/michael-mann']);
 assert.deepEqual(credits(db,'film:tmdb:100'),['a0:person:tmdb_actor/2','d0:person:tmdb_director/1']);
 assert.equal(one(db,"SELECT year FROM film_metadata WHERE film_id='film:heat'"),1995);
 const stored=db.sql("SELECT lease_id l,outcome o FROM projection_run WHERE projection='enrichment'")[0];
 assert.deepEqual([stored.l,stored.o],[null,'complete']);
 assert.equal(one(db,'SELECT COUNT(*) FROM projection_fence'),0,'the fence row never outlives its batch');
}

// 4. Converged: a second run, and one a week later, write nothing. The view stamps undated dimensions with the run's clock;
// the change key ignores that stamp.
for(const now of [Date.now(),Date.now()+7*86400000]){
 const before=db.calls.batches,summary=await run(env,{now});
 assert.deepEqual([summary.changedFilms,summary.changedPeople,summary.absent,summary.outcome],[0,0,0,'complete']);
 assert.equal(db.calls.batches,before);
}

// 5. Fingerprint and prediction dimensions belong to other writers and stay as they are.
// A Film the projector creates gets no fingerprint or prediction row; the prediction writer adds them.
assert.equal(one(db,"SELECT COUNT(*) FROM film_dimension WHERE dimension IN ('fingerprint','prediction')"),0);
db.sql(`INSERT INTO film_dimension (film_id,dimension,status,source,updated_at) VALUES ('film:heat','fingerprint','current','fingerprint','${T}'),('film:heat','prediction','current','prediction','${T}')`);

// 6. D1-only TMDB credits of a watchlist Film (AIR-286) survive every rewrite, numbered after the R2 credits of their role.
db.sql(`INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_actor/1158','tmdb_actor/1158',1,'${T}'),('person:tmdb_actor/380','tmdb_actor/380',1,'${T}'),('person:tmdb_director/638','tmdb_director/638',1,'${T}');
INSERT INTO film_person_credit VALUES ('film:heat','person:tmdb_actor/1158','actor',2),('film:heat','person:tmdb_actor/380','actor',3),('film:heat','person:tmdb_director/638','director',1)`);
const heatAfter=async(options)=>{const next=r2(options);for(const [key,value] of next.objects)bucket.objects.set(key,value);const summary=await run(env);assert.equal(summary.outcome,'complete',JSON.stringify(summary));return credits(db,'film:heat');};
assert.deepEqual(await heatAfter({heat:[PACINO,KILMER,DE_NIRO]}),['a0:person:actor/al-pacino','a1:person:actor/val-kilmer','a2:person:actor/robert-de-niro','a3:person:tmdb_actor/1158','a4:person:tmdb_actor/380','d0:person:director/michael-mann','d1:person:tmdb_director/638'],'a Letterboxd credit added');
assert.deepEqual(await heatAfter({heat:[DE_NIRO]}),['a0:person:actor/robert-de-niro','a1:person:tmdb_actor/1158','a2:person:tmdb_actor/380','d0:person:director/michael-mann','d1:person:tmdb_director/638'],'Letterboxd credits removed');
assert.deepEqual(await heatAfter({heat:[DE_NIRO],heatCatalog:[person('tmdb_actor/380','Robert De Niro')]}),['a0:person:actor/robert-de-niro','a1:person:tmdb_actor/380','a2:person:tmdb_actor/1158','d0:person:director/michael-mann','d1:person:tmdb_director/638'],'the R2 roster wins a duplicate');
assert.equal(one(db,"SELECT status FROM film_dimension WHERE film_id='film:heat' AND dimension='fingerprint'"),'current');
assert.equal(one(db,"SELECT status FROM film_dimension WHERE film_id='film:heat' AND dimension='prediction'"),'current');

// 7. A catalog Film's credits all come from R2: a credit only D1 holds is dropped on the next rewrite.
db.sql(`INSERT INTO film_person_credit VALUES ('film:tmdb:100','person:tmdb_actor/1158','actor',1)`);
await heatAfter({heat:[DE_NIRO],catalogActors:[person('tmdb_actor/2','Jean Reno'),person('tmdb_actor/3','Robert De Niro')]});
assert.deepEqual(credits(db,'film:tmdb:100'),['a0:person:tmdb_actor/2','a1:person:tmdb_actor/3','d0:person:tmdb_director/1']);

// 8. A Film no R2 source lists any more loses only its watchlist membership, once; its row and credits stay.
{
 const next=r2({heat:[DE_NIRO],collateral:false,catalogActors:[person('tmdb_actor/2','Jean Reno'),person('tmdb_actor/3','Robert De Niro')]});
 for(const [key,value] of next.objects)bucket.objects.set(key,value);
 const summary=await run(env);
 assert.deepEqual([summary.absent,summary.released,summary.outcome],[2,2,'complete'],JSON.stringify(summary));
 assert.deepEqual(db.sql('SELECT film_id f FROM watchlist_film').map(row=>row.f),['film:heat']);
 assert.equal(one(db,"SELECT COUNT(*) FROM film WHERE id='film:collateral'"),1);
 assert.deepEqual(credits(db,'film:collateral'),['a0:person:actor/jamie-foxx','d0:person:director/michael-mann']);
 assert.deepEqual(db.sql("SELECT kind k,id i FROM projection_state WHERE change_key='absent' ORDER BY id").map(row=>row.k+':'+row.i),['film:film:collateral','person:person:actor/al-pacino','person:person:actor/jamie-foxx','person:person:actor/val-kilmer','person:person:tmdb_actor/380'],'people dropped from every roster in steps 6 and 7 were marked absent then');
 assert.equal((await run(env)).released,0,'an absent entity is not released again');
}

// 9. The lease keeps a second run out; an expired lease is taken over.
{
 db.sql(`UPDATE projection_run SET lease_id='other',lease_until='${new Date(Date.now()+60000).toISOString()}'`);
 assert.equal((await run(env)).skipped,'lease_held');
 db.sql(`UPDATE projection_run SET lease_until='${new Date(Date.now()-1000).toISOString()}'`);
 assert.equal((await run(env)).outcome,'complete');
}

// 10. A run that loses its lease mid-way writes nothing more: the fence fails the batch whole, keys included, and the run stops.
{
 const next=r2({heat:[PACINO],collateral:true,catalogActors:[person('tmdb_actor/2','Jean Reno')]});
 for(const [key,value] of next.objects)bucket.objects.set(key,value);
 const {file:fenceFile}=migrated();fs.copyFileSync(file,fenceFile);
 let batches=0;
 const stolen=d1Standin(fenceFile,{onBatch:()=>{if(++batches===2)stolen.sql("UPDATE projection_run SET lease_id='thief'");}});
 const keysBefore=stolen.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id');
 const summary=await run({...env,DB:stolen});
 assert.equal(summary.outcome,'lease_lost',JSON.stringify(summary));
 assert.equal(batches,2,'nothing is sent after the lost lease');
 const keysAfter=stolen.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id');
 assert.equal(keysAfter.filter((row,index)=>row.change_key!==keysBefore[index]?.change_key).length,summary.writtenPeople+summary.writtenFilms+summary.released,'only the batch before the theft moved a key');
 assert.equal(one(stolen,'SELECT COUNT(*) FROM projection_fence'),0);
 assert.equal(one(stolen,"SELECT lease_id FROM projection_run"),'thief','the thief keeps its lease');
}

// 11. The query budget stops a run with work left; the next run carries on and converges.
{
 const summary=await run(env,{queryBudget:3});
 assert.equal(summary.outcome,'budget',JSON.stringify(summary));
 assert.ok(summary.remaining>0);
 let guard=0,last;
 do{last=await run(env,{queryBudget:6});}while(last.outcome==='budget'&&++guard<20);
 assert.equal(last.outcome,'complete');
 assert.deepEqual([(await run(env)).changedFilms,(await run(env)).changedPeople],[0,0]);
}

// 12. One Person that cannot be written does not hold back the rest of its group.
{
 const {file:groupFile}=migrated();
 const failing=d1Standin(groupFile,{onBatch:statements=>{if(statements.some(item=>item.text.includes("INSERT INTO person (")&&item.text.includes("'person:actor/robert-de-niro'")))throw new Error('D1_ERROR: synthetic');}});
 const summary=await run({DB:failing,BUCKET:r2(),D1_ENRICHMENT_WRITE:'on'});
 assert.equal(summary.outcome,'partial');
 assert.equal(summary.writtenPeople,5);
 assert.ok(summary.errors.some(item=>item.kind==='person'&&item.id==='person:actor/robert-de-niro'));
 assert.ok(summary.errors.some(item=>item.kind==='film'&&item.id==='film:heat'),'a Film whose person is missing fails and is retried later');
 assert.equal(one(failing,"SELECT COUNT(*) FROM projection_state WHERE id='person:actor/robert-de-niro'"),0);
}

// 13. Inputs fail closed: a missing or malformed object, an unpublished pointer, a missing generation copy or a pointer that
// moves during the reads stops (or defers) the run before any D1 write. An empty but present dataset is data, guarded by the absent limit.
{
 const keys=()=>db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id');
 const before=keys(),batches=db.calls.batches;
 const broken=[
  ['watchlist.json',bucket=>bucket.objects.delete('watchlist.json'),'input_missing'],
  ['metadata.json',bucket=>bucket.put('metadata.json','not json'),'input_invalid'],
  ['people.json',bucket=>bucket.put('people.json','[]'),'input_invalid'],
  ['watchlist.json',bucket=>bucket.put('watchlist.json',JSON.stringify({films:null})),'input_invalid'],
  ['epg/generations/run-1/discovered-films.json',bucket=>bucket.objects.delete('epg/generations/run-1/discovered-films.json'),'input_missing'],
  ['epg/generations/run-1/programme.json',bucket=>bucket.objects.delete('epg/generations/run-1/programme.json'),'input_missing'],
  ['epg/published-generation.json',bucket=>bucket.put('epg/published-generation.json',JSON.stringify({phase:'staging',programmeRunId:'run-1'})),'generation_unpublished'],
  ['epg/published-generation.json',bucket=>bucket.objects.delete('epg/published-generation.json'),'input_missing'],
 ];
 for(const [key,breakIt,reason] of broken){
  const next=r2({heat:[PACINO]});breakIt(next);
  for(const mode of ['dry','on']){
   const summary=await run({DB:db,BUCKET:next,D1_ENRICHMENT_WRITE:mode});
   assert.deepEqual([summary.outcome,summary.reason,summary.inputKey],['failed',reason,key],key+' '+mode);
  }
 }
 // The pointer moves to another generation during the reads: its etag check defers the run.
 const moving=r2({heat:[PACINO]});const get=moving.get.bind(moving);let moved=false;
 moving.get=async key=>{const object=await get(key);if(key==='watchlist.json'&&!moved){moved=true;await moving.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:'run-2'}));}return object;};
 const movedRun=await run({DB:db,BUCKET:moving,D1_ENRICHMENT_WRITE:'on'});
 assert.deepEqual([movedRun.outcome,movedRun.reason,movedRun.inputKey],['deferred','input_changed','epg/published-generation.json']);
 // A diary history that is absent is fine: its switch can be off.
 assert.equal(bucket.objects.has('letterboxd/diary/history.json'),false);
 assert.equal(db.calls.batches,batches,'no failed input reached a batch');
 assert.deepEqual(keys(),before);
 // An empty but present watchlist is a real dataset; past the absent limit it is held as suspect and nothing is written.
 const values=Array.from({length:26},(_,index)=>`('enrichment','film','film:ghost-${index}','k','${T}')`).join(',');
 db.sql('INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES '+values);
 const guarded=await run(env);
 assert.deepEqual([guarded.outcome,guarded.absentFilms,guarded.absentLimit.films],['absent_guard',26,25]);
 assert.equal(db.calls.batches,batches);
 db.sql("DELETE FROM projection_state WHERE id LIKE 'film:ghost-%'");
 const people=Array.from({length:251},(_,index)=>`('enrichment','person','person:actor/ghost-${index}','k','${T}')`).join(',');
 db.sql('INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES '+people);
 assert.deepEqual([(await run(env)).outcome,db.calls.batches],['absent_guard',batches]);
 db.sql("DELETE FROM projection_state WHERE id LIKE 'person:actor/ghost-%'");
 assert.equal((await run(env)).outcome,'complete');
}

// 14. A consistent cut: no run while a writer works, and none when an object changes during the reads, even under the same
// published generation (the catalog and the resolution are updated in place). Each defers before any D1 write.
{
 const batches=db.calls.batches,keysBefore=db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id');
 const deferred=async(prepare,reason,key)=>{
  for(const mode of ['dry','on']){const next=r2({heat:[DE_NIRO],collateral:true,catalogActors:[person('tmdb_actor/2','Jean Reno')]});prepare(next);const summary=await run({DB:db,BUCKET:next,D1_ENRICHMENT_WRITE:mode});assert.deepEqual([summary.outcome,summary.reason,summary.inputKey],['deferred',reason,key],reason+' '+key+' '+mode);}
 };
 await deferred(bucket=>bucket.put('epg/resolver-lease.json',JSON.stringify({id:'chunk',expiresAt:Date.now()+60000})),'writer_active','epg/resolver-lease.json');
 await deferred(bucket=>bucket.put('sync.json',JSON.stringify({stage:'metadata',updatedAt:new Date().toISOString()})),'writer_active','sync.json');
 const during=(key,mutate)=>bucket=>{const get=bucket.get.bind(bucket);let done=false;bucket.get=async name=>{const object=await get(name);if(name===key&&!done){done=true;await mutate(bucket);}return object;};};
 await deferred(during('epg/generations/run-1/discovered-films.json',bucket=>bucket.put('epg/generations/run-1/discovered-films.json',JSON.stringify({}))),'input_changed','epg/generations/run-1/discovered-films.json');
 await deferred(during('epg/discovery-resolution.json',bucket=>bucket.put('epg/discovery-resolution.json',JSON.stringify({moved:{status:'verified',tmdbId:'7'}}))),'input_changed','epg/discovery-resolution.json');
 await deferred(during('watchlist.json',bucket=>bucket.put('epg/resolver-lease.json',JSON.stringify({id:'late',expiresAt:Date.now()+60000}))),'writer_active','epg/resolver-lease.json');
 // A finished or stale writer state does not hold the run.
 const idle=r2({heat:[DE_NIRO],collateral:true,catalogActors:[person('tmdb_actor/2','Jean Reno')]});
 await idle.put('epg/resolver-lease.json',JSON.stringify({id:'old',expiresAt:0}));
 await idle.put('sync.json',JSON.stringify({stage:'metadata',updatedAt:new Date(Date.now()-3600000).toISOString()}));
 assert.equal((await run({DB:db,BUCKET:idle,D1_ENRICHMENT_WRITE:'dry'})).outcome,'dry');
 assert.equal(db.calls.batches,batches);
 assert.deepEqual(db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id'),keysBefore);
}

// 15. Watchlist membership at production scale: 394 listed Films. An empty or truncated watchlist that leaves the Films in the
// programme and catalog loses no membership and writes nothing; a routine removal of a few Films goes through.
{
 const {db:big}=migrated();
 const films=Array.from({length:394},(_,index)=>film('w'+index,'Film '+index,String(10000+index),[MANN],[]));
 const scaled=(listed)=>{
  const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
  put('watchlist.json',{updatedAt:T,films:listed});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
  put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
  put('epg/published-generation.json',{phase:'published',programmeRunId:'run-9'});
  put('epg/generations/run-9/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
  put('epg/generations/run-9/discovered-films.json',{});
  return bucket;
 };
 const first=await run({DB:big,BUCKET:scaled(films),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e6,wallMs:6e5});
 assert.equal(first.outcome,'complete',JSON.stringify(first));
 assert.equal(one(big,'SELECT COUNT(*) FROM watchlist_film'),394);
 for(const listed of [[],films.slice(0,300)]){
  const before=big.calls.batches;
  for(const mode of ['dry','on']){
   const summary=await run({DB:big,BUCKET:scaled(listed),D1_ENRICHMENT_WRITE:mode});
   assert.deepEqual([summary.outcome,summary.members,summary.membershipRemoved,summary.membershipLimit,summary.absent],['membership_guard',394,394-listed.length,8,0]);
  }
  assert.equal(big.calls.batches,before,'zero D1 batches');
  assert.equal(one(big,'SELECT COUNT(*) FROM watchlist_film'),394);
 }
 const routine=await run({DB:big,BUCKET:scaled(films.slice(3)),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e6});
 assert.deepEqual([routine.outcome,routine.membershipRemoved],['complete',3]);
 assert.equal(one(big,'SELECT COUNT(*) FROM watchlist_film'),391);
}

// 16. Status: a database without schema v4 has no projector; with it, checkpoints and the last run.
{
 const {db:v3}=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity']);
 assert.deepEqual({...await projector.d1EnrichmentStatus(v3,{})},{mode:'off',schema:false});
 assert.equal((await run(env)).outcome,'complete');
 const status=await projector.d1EnrichmentStatus(db,{D1_ENRICHMENT_WRITE:'on'});
 assert.deepEqual([status.mode,status.schema,status.checkpoints,status.absent,status.lastRun.outcome,status.lastRun.leaseHeld],['on',true,one(db,'SELECT COUNT(*) FROM projection_state'),one(db,"SELECT COUNT(*) FROM projection_state WHERE change_key='absent'"),'complete',false]);
 assert.ok(status.checkpoints>9&&status.absent>0);
}

// 17. The seed writes keys only for entities the database holds and replaces the projection's earlier keys.
{
 const {file:seedFile}=migrated();fs.copyFileSync(file,seedFile);
 const sqlite=openSqlite(seedFile);
 const result=await seedProjection(sqlite,{at:T,keys:[{kind:'film',id:'film:heat',key:'k1'},{kind:'film',id:'film:nowhere',key:'k2'},{kind:'person',id:'person:actor/al-pacino',key:'k3'}]});
 assert.deepEqual({...result},{seeded:2,skipped:1,films:1,people:1});
 assert.deepEqual(d1Standin(seedFile).sql('SELECT id,change_key k FROM projection_state ORDER BY id').map(row=>row.id+'='+row.k),['film:heat=k1','person:actor/al-pacino=k3']);
 const {file:bare}=migrated(['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity']);
 await assert.rejects(seedProjection(openSqlite(bare),{at:T,keys:[]}),/apply migrations\/0004/);
}

console.log('D1 enrichment projector (ADR 0056): fail-closed inputs, consistent cut (writers idle, etags unchanged), absent and membership guards at 394 watchlist Films, off reads nothing, dry writes nothing, on writes and converges, keys ignore the run clock, D1-only watchlist TMDB credits survive and renumber as Letterboxd credits come and go, R2 roster wins duplicates, catalog credits follow R2, fingerprint/prediction dimensions kept, absent released once, lease and lost-lease fence, budget resume, group fallback, status and seed passed');
