// ADR 0085. Discovery stays on R2 until its own marker is d1 and cutover open.
// These are local sqlite stand-ins. Nothing here calls Cloudflare, TMDB, or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as PublishedEpg from '../src/published-epg.js';
import {canonicalJson} from '../src/domain/discovery-observation-index.js';
import {scoped} from '../scripts/bundle-scope.mjs';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {installViewIndexFixture} from './view-index-fixture.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-discovery-authority-'));
let databases=0;
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
const migrated=(list=chain)=>{
 const file=path.join(root,'discovery-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+list.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file)};
};
const one=(db,sql)=>db.sql(sql)[0]||null;
const count=(db,sql)=>Number(Object.values(one(db,sql)||{n:0})[0]||0);
const open=db=>{db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");};
const hold=db=>{db.sql("UPDATE discovery_authority SET mode='d1', cutover='held' WHERE id=1");};
const envFor=(db,bucket=new MemoryBucket())=>({DB:db,BUCKET:bucket,discoveryLease:null});

assert.equal(Authority.DISCOVERY_TABLES.length,16);
assert.doesNotMatch(fs.readFileSync('src/discovery-authority.js','utf8'),/INSERT INTO film\b|INSERT INTO person\b/);
assert.doesNotMatch(fs.readFileSync('src/discovery.js','utf8'),/env\.DB\b/);
assert.match(fs.readFileSync('build.mjs','utf8'),/scopedDiscoveryAuthority\(\)/);
assert.match(fs.readFileSync('scripts/bundle-scope.mjs','utf8'),/scopedImports\('src\/discovery-authority\.js','DiscoveryAuthority'/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/DiscoveryAuthority\.routeRead\(env,key(,options)?\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/DiscoveryAuthority\.routeWrite\(env,key,value,context\)/);
assert.doesNotMatch(fs.readFileSync('src/discovery-authority.js','utf8'),/ensureDiscoveryWorkflow|reconcileDiscoveryWorkflow|\.create\(/);
assert.doesNotMatch(fs.readFileSync('src/discovery-workflow.js','utf8'),/DISCOVERY_EXECUTOR|discoveryExecutorMode/);
const discoverySql=fs.readFileSync('migrations/0011_discovery_authority.sql','utf8');
const ratingsSql=fs.readFileSync('migrations/0010_ratings_authority.sql','utf8');
assert.match(discoverySql,/version >= 10 AND version < 11/);
assert.match(ratingsSql,/version >= 8 AND version < 10/);
const apply=(file,sql)=>sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
const discoveryTables=db=>count(db,"SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='discovery_authority'");

const refused=apply(path.join(root,'refused.sqlite'),'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/0001_schema_v1.sql','utf8')+'\n'+discoverySql);
assert.notEqual(refused.status,0);
const version8=migrated(chain.slice(0,8));
const blocked8=apply(version8.file,discoverySql);
assert.notEqual(blocked8.status,0);
assert.equal(count(version8.db,'SELECT version FROM schema_contract'),8);
assert.equal(discoveryTables(version8.db),0);
const version9=migrated(chain.slice(0,9));
const blocked9=apply(version9.file,discoverySql);
assert.notEqual(blocked9.status,0);
assert.equal(count(version9.db,'SELECT version FROM schema_contract'),9);
assert.equal(discoveryTables(version9.db),0);
const ratingsOnly=migrated(chain.slice(0,8));
const ratingsApplied=apply(ratingsOnly.file,ratingsSql);
assert.equal(ratingsApplied.status,0,ratingsApplied.stderr);
assert.equal(count(ratingsOnly.db,'SELECT version FROM schema_contract'),10);
assert.equal(one(ratingsOnly.db,'SELECT mode FROM ratings_domain_authority WHERE id=1').mode,'r2');
const blockedRatings=apply(ratingsOnly.file,discoverySql);
assert.notEqual(blockedRatings.status,0);
assert.equal(count(ratingsOnly.db,'SELECT version FROM schema_contract'),10);
assert.equal(discoveryTables(ratingsOnly.db),0);

const ratingsReady=migrated(chain.slice(0,-1));
assert.equal(count(ratingsReady.db,'SELECT version FROM schema_contract'),10);
assert.equal(discoveryTables(ratingsReady.db),0);
// ADR 0162: a domain that is not installed is refused unless the caller opts in with DISCOVERY_DB_OPTIONAL (never set by wrangler.jsonc); only then is it the R2 stand-in.
const unavailable=error=>error.code==='discovery_unavailable';
const standin={DISCOVERY_DB_OPTIONAL:'standin'};
await assert.rejects(()=>Authority.readAuthority({DB:ratingsReady.db}),unavailable,'schema v10 without the tables, strict');
const ratingsGate=await Authority.readAuthority({DB:ratingsReady.db,...standin});
assert.equal(ratingsGate.ready,false);
assert.equal(ratingsGate.version,10);
assert.deepEqual(await Authority.routeRead({DB:ratingsReady.db,...standin},'epg/discovery-resolution.json'),{handled:false});
await assert.rejects(()=>Authority.routeRead({DB:ratingsReady.db},'epg/discovery-resolution.json'),unavailable);

const installed=migrated();
assert.equal(count(installed.db,'SELECT version FROM schema_contract'),11);
assert.equal(one(installed.db,'SELECT mode, generation FROM discovery_authority WHERE id=1').mode,'r2');
assert.equal(one(installed.db,'SELECT generation FROM discovery_authority WHERE id=1').generation,0);
assert.equal(count(installed.db,'SELECT COUNT(*) AS n FROM film'),0);
assert.throws(()=>installed.db.sql('UPDATE schema_contract SET version=10'),/schema_contract_downgrade/);
// ADR 0162: the marker the migration inserts (mode r2) is refused, never read as the R2 objects.
await assert.rejects(()=>Authority.readAuthority({DB:installed.db}),error=>error.code==='discovery_unavailable');
await assert.rejects(()=>Authority.routeRead({DB:installed.db},'epg/discovery-resolution.json'),error=>error.code==='discovery_unavailable');

await assert.rejects(()=>Authority.routeRead({},'epg/discovery-latest.json'),unavailable,'no binding, strict');
await assert.rejects(()=>Authority.readAuthority({DB:null}),unavailable);
const bare=await Authority.routeRead({...standin},'epg/discovery-latest.json');
assert.equal(bare.handled,false);
const ratingsContract=d1Standin(path.join(root,'ratings-contract.sqlite'));
ratingsContract.sql("CREATE TABLE schema_contract (id INTEGER, version INTEGER, note TEXT); INSERT INTO schema_contract (id, version, note) VALUES (1, 10, 'ratings');");
await assert.rejects(()=>Authority.readAuthority({DB:ratingsContract}),unavailable);
assert.equal((await Authority.readAuthority({DB:ratingsContract,...standin})).ready,false);
const missing=d1Standin(path.join(root,'missing.sqlite'));
missing.sql("CREATE TABLE schema_contract (id INTEGER, version INTEGER, note TEXT); INSERT INTO schema_contract (id, version, note) VALUES (1, 11, 'incomplete');");
await assert.rejects(()=>Authority.readAuthority({DB:missing}),error=>error.code==='discovery_unavailable');

// The opt-in covers only a domain that is not installed at all (review decision on #755). Every refusal happens before any R2 read or put and before any D1 write.
{
 const spy=()=>{const log={r2:0,writes:0};const bucket={async get(){log.r2++;throw new Error('R2 touched');},async put(){log.r2++;throw new Error('R2 touched');},async list(){log.r2++;throw new Error('R2 touched');},async head(){log.r2++;throw new Error('R2 touched');},async delete(){log.r2++;throw new Error('R2 touched');}};return {log,bucket};};
 const fresh=(label,setup,{onBatch}={})=>{const db=d1Standin(path.join(root,'standin-'+label+'.sqlite'),{onBatch});setup(db);return db;};
 const contract=version=>db=>db.sql('CREATE TABLE schema_contract (id INTEGER PRIMARY KEY, version INTEGER); INSERT INTO schema_contract VALUES (1,'+version+')');
 const cases=[
  ['one table, no contract',db=>db.sql('CREATE TABLE discovery_authority (id INTEGER PRIMARY KEY)')],
  ['one table, contract without its row',db=>{db.sql('CREATE TABLE discovery_authority (id INTEGER PRIMARY KEY)');db.sql('CREATE TABLE schema_contract (id INTEGER PRIMARY KEY, version INTEGER)');}],
  ['one table, non-numeric version',db=>{db.sql('CREATE TABLE discovery_authority (id INTEGER PRIMARY KEY)');db.sql("CREATE TABLE schema_contract (id INTEGER PRIMARY KEY, version TEXT); INSERT INTO schema_contract VALUES (1,'x')");}],
  ['one table, contract at 10',db=>{db.sql('CREATE TABLE discovery_authority (id INTEGER PRIMARY KEY)');contract(10)(db);}],
  ['contract at 11, zero tables',contract(11)],
  ['contract at 24, zero tables',contract(24)],
 ];
 for(const [label,setup] of cases){
  const {log,bucket}=spy();let writes=0;
  const db=fresh(label.replace(/\W+/g,'-'),setup,{onBatch(){writes++;}});
  const env={DB:db,BUCKET:bucket,...standin};
  await assert.rejects(()=>Authority.readAuthority(env),unavailable,label+': readAuthority');
  await assert.rejects(()=>Authority.routeRead(env,'epg/discovered-films.json'),unavailable,label+': routeRead');
  await assert.rejects(()=>Authority.readAdmissionsById(env,['tmdb_1']),unavailable,label+': readAdmissionsById');
  await assert.rejects(()=>Authority.readFilmAdmission(env,'1'),unavailable,label+': readFilmAdmission');
  await assert.rejects(()=>Authority.routeWrite(env,'epg/discovery-status.json',{stage:'partial'}),unavailable,label+': routeWrite');
  assert.deepEqual([log.r2,writes],[0,0],label+': no R2 access and no D1 write');
 }
 // Not installed, contract below 11 or none: the opt-in is allowed, strict refuses.
 for(const [label,setup] of [['no schema_contract',()=>{}],['contract at 7',contract(7)],['contract at 10',contract(10)]]){
  const db=fresh('absent-'+label.replace(/\W+/g,'-'),setup);
  assert.equal((await Authority.readAuthority({DB:db,...standin})).ready,false,label+': opted in');
  await assert.rejects(()=>Authority.readAuthority({DB:db}),unavailable,label+': strict');
 }
 // An installed marker that is not d1 / open is refused even with the opt-in; a D1 error is not a stand-in either (the schema's CHECK constraints keep a corrupted marker from existing).
 for(const [label,sqlText] of [['marker r2',"UPDATE discovery_authority SET mode='r2'"],['marker held',"UPDATE discovery_authority SET mode='d1', cutover='held'"]]){
  const inst=migrated();
  inst.db.sql(sqlText);
  await assert.rejects(()=>Authority.readAuthority({DB:inst.db,...standin}),unavailable,label+': opted in');
 }
 const broken={prepare(){throw new Error('D1 binding reset');},async batch(){throw new Error('D1 binding reset');}};
 await assert.rejects(()=>Authority.readAuthority({DB:broken,...standin}),unavailable,'a D1 error is not a stand-in');
 assert.match(fs.readFileSync('wrangler.jsonc','utf8').replace(/\/\/.*$/gm,''),/^(?![\s\S]*DISCOVERY_DB_OPTIONAL)/,'wrangler.jsonc never opts in');
 assert.doesNotMatch(fs.readFileSync('scripts/local-dev.mjs','utf8'),/DISCOVERY_DB_OPTIONAL/,'AIR-576: the local stack runs a real D1 and opts into no stand-in');
}

const held=migrated();
hold(held.db);
const heldEnv=envFor(held.db);
// A held cutover is refused by every reader and writer (ADR 0162).
await assert.rejects(()=>Authority.routeWrite(heldEnv,'epg/discovery-status.json',{stage:'partial'}),(error)=>error.code==='discovery_unavailable');
await assert.rejects(()=>Authority.routeRead(heldEnv,'epg/discovery-status.json'),error=>error.code==='discovery_unavailable');
await assert.rejects(()=>Authority.acquireLease(heldEnv,{}),error=>error.code==='discovery_unavailable');

const live=migrated();
open(live.db);
const bucket=new MemoryBucket();
await bucket.put('epg/discovery-resolution.json',JSON.stringify({stale:{status:'verified',tmdbId:'99'}}));
await bucket.put('epg/discovered-films.json',JSON.stringify({tmdb_99:{id:'tmdb_99',tmdbId:'99',canonicalIdentity:'tmdb:99',title:'Stale'}}));
const env=envFor(live.db,bucket);
const acquired=await Authority.acquireLease(env,{programmeRunId:null});
assert.ok(acquired.lease);
env.discoveryLease=acquired.lease;
const second=await Authority.acquireLease(env,{programmeRunId:null});
assert.equal(second.lease,null);
const item={key:'obs-1',title:'Фильм',normalizedTitle:'фильм',year:1999,durations:[100],shows:[{channelId:'news',channel:'News',start:5,end:9}],seenInLatestSnapshot:true,lastAiring:5};
await Authority.replaceLedger(env,{programmeRunId:'run-a',items:[item]});
const departed={key:'obs-old',title:'Old',normalizedTitle:'old',year:1980,durations:[90],shows:[{channelId:'a',start:1}]};
await Authority.replaceLedger(env,{programmeRunId:'run-b',items:[item,departed]});
await Authority.replaceLedger(env,{programmeRunId:'run-b',items:[item]});
const ledger=await Authority.routeRead(env,'epg/discovery-latest.json');
assert.equal(ledger.handled,true);
assert.deepEqual(ledger.value.items.map(row=>row.key),['obs-1']);
// The departed observation is a D1 archive row, named as such; D1 does not know the mode of the generation.
assert.equal(ledger.value.archive.source,'d1');
assert.equal(ledger.value.archive.d1.archiveOnlyRows>=1,true);
assert.equal(ledger.value.archive.uniqueArchivedItems,undefined);
assert.equal(ledger.value.ledgerMode,'unknown');
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='obs-old' AND residence='archive'"),1);
assert.equal(count(live.db,'SELECT COUNT(*) AS n FROM film'),0);
const stale=await bucket.get('epg/discovery-resolution.json');
assert.equal(JSON.parse(await stale.text()).stale.tmdbId,'99');

const evidence=Authority.evidenceKey(item);
const decision={status:'needs_verification',attempts:1,evidenceKey:evidence,terminalReason:'awaiting_confirmation',retryAt:null,scoring:{acceptedTmdbId:'41'}};
await Authority.routeWrite(env,'epg/discovery-resolution.json',{'obs-1':decision});
const stored=await Authority.routeRead(env,'epg/discovery-resolution.json');
assert.equal(stored.value['obs-1'].terminalReason,'awaiting_confirmation');
assert.equal(await Authority.decisionHash(stored.value['obs-1']),await Authority.decisionHash(JSON.parse(canonicalJson(stored.value['obs-1']))));
const hashBytes=new Uint8Array(await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalJson(decision))));
const hashed=[...hashBytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
assert.equal(await Authority.decisionHash(decision),hashed);
await assert.rejects(()=>Authority.routeWrite(env,'epg/discovery-resolution.json',{'obs-1':{...decision,evidenceKey:'other'}}),error=>error.code==='discovery_fence');
assert.equal((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].evidenceKey,evidence);
assert.equal(count(live.db,'SELECT COUNT(*) AS n FROM discovery_decision_history'),1);

const renewed=await Authority.renewLease(env,acquired.lease,{programmeRunId:'run-b'});
assert.equal(renewed.ok,true);
const late=await Authority.renewLease(env,acquired.lease,{programmeRunId:'run-old'});
assert.equal(late.ok,false);

const retryAt=new Date(Date.now()+3600000).toISOString();
await Authority.routeWrite(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',programmeRunId:'run-b',retryAt,remaining:3});
assert.equal((await Authority.routeRead(env,'epg/discovery-status.json')).value.retryAt,retryAt);
const context=vm.createContext({console,Date,Promise,URL,TextEncoder,crypto:webcrypto,setTimeout,clearTimeout,fetch(){throw new Error('tmdb called');},DiscoveryAuthority:Authority,pinEpg:async value=>value,loadJSON:async(target,key)=>{const routed=await Authority.routeRead(target,key);if(routed.handled)return routed.value;return null;},saveJSON:async()=>{throw new Error('r2 write');}});
vm.runInContext(fs.readFileSync('src/discovery.js','utf8'),context);
const backoff=await context.resolveDiscoveryChunk(env,{films:[]},1,null);
assert.equal(backoff.stage,'backoff');
assert.equal(backoff.retryAt,retryAt);

const movie={id:'tmdb_41',tmdbId:'41',canonicalIdentity:'tmdb:41',title:'Movie'};
const television={id:'tmdb_tv_41',tmdbId:'41',canonicalIdentity:'tmdb_tv:41',title:'Show',mediaType:'tv'};
await Authority.replaceCatalog(env,{tmdb_41:movie,tmdb_tv_41:television});
const catalog=await Authority.routeRead(env,'epg/discovered-films.json');
assert.equal(catalog.value.tmdb_41.canonicalIdentity,'tmdb:41');
assert.equal(catalog.value.tmdb_tv_41.canonicalIdentity,'tmdb_tv:41');
assert.equal(catalog.value.tmdb_41.canonicalIdentity==='tmdb:'+catalog.value.tmdb_41.tmdbId,true);
assert.equal(catalog.value.tmdb_tv_41.canonicalIdentity==='tmdb:'+catalog.value.tmdb_tv_41.tmdbId,false);
await assert.rejects(()=>Authority.replaceCatalog(env,{tmdb_41:movie,tmdb_other:{id:'tmdb_other',tmdbId:'41',canonicalIdentity:'tmdb:41'}}),error=>error.code==='discovery_conflict');
await assert.rejects(()=>Authority.replaceCatalog(env,{tmdb_41:{...movie,canonicalIdentity:'tmdb:99'}}),error=>error.code==='discovery_conflict');
assert.equal((await Authority.routeRead(env,'epg/discovered-films.json')).value.tmdb_41.title,'Movie');
assert.equal(count(live.db,'SELECT COUNT(*) AS n FROM film'),0);
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_admission WHERE media_kind='tv' AND tmdb_id='41'"),1);
const manyFilms={};
for(let index=1;index<=50;index++)manyFilms['tmdb_'+index]={id:'tmdb_'+index,tmdbId:String(index),canonicalIdentity:'tmdb:'+index,title:'F'+index};
await Authority.replaceCatalog(env,manyFilms);
assert.equal(Object.keys((await Authority.routeRead(env,'epg/discovered-films.json')).value).length,50);
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_admission WHERE state='current'"),50);
assert.equal(count(live.db,'SELECT COUNT(*) AS n FROM film'),0);
const wideShows=Array.from({length:40},(_,index)=>({channelId:'c'+index,start:index}));
await Authority.replaceLedger(env,{programmeRunId:'run-b',items:[{...item,shows:wideShows}]});
assert.equal((await Authority.routeRead(env,'epg/discovery-latest.json')).value.items[0].shows.length,40);
await Authority.replaceLedger(env,{programmeRunId:'run-b',items:[item]});
for(const size of [97,101,178]){
 const shows=Array.from({length:size},(_,index)=>({channelId:'c',channel:'C',start:index,end:index+1}));
 const lengths=[];
 const watched=d1Standin(live.file,{onBatch:statements=>lengths.push(statements.length)});
 await Authority.replaceLedger({DB:watched,BUCKET:bucket,discoveryLease:acquired.lease},{programmeRunId:'run-b',items:[{...item,shows}]});
 assert.equal(lengths.length>0&&lengths.every(length=>length<=Authority.STATEMENT_CAP),true,String(size));
 assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_observation_show WHERE source_key='active' AND observation_key='obs-1'"),size);
}
await Authority.replaceLedger(env,{programmeRunId:'run-b',items:[item]});
assert.equal((await Authority.routeRead(env,'epg/discovery-latest.json')).value.items[0].shows.length,1);

await Authority.releaseLease(env,acquired.lease);
const segmentItems=Array.from({length:30},(_,index)=>({key:'arch-'+index,title:'A'+index,normalizedTitle:'a'+index,year:2000,durations:[80],shows:[{channelId:'c',start:index}]}));
const sha=await Authority.segmentContentSha(segmentItems);
await assert.rejects(()=>Authority.importSegment(env,{sourceKey:'archive:seg-1',programmeRunId:'run-b',contentSha256:'0'.repeat(64),items:segmentItems,r2Key:'epg/archive/seg-1.json'}),error=>error.code==='discovery_conflict');
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE residence='archive' AND observation_key LIKE 'arch-%'"),0);
await Authority.importSegment(env,{sourceKey:'archive:seg-1',programmeRunId:'run-b',contentSha256:sha,items:segmentItems,r2Key:'epg/archive/seg-1.json'});
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='archive:seg-1'"),30);
const duplicateSha=await Authority.segmentContentSha([{key:'dup'},{key:'dup'}]);
await assert.rejects(()=>Authority.importSegment(env,{sourceKey:'archive:seg-2',programmeRunId:'run-b',contentSha256:duplicateSha,items:[{key:'dup'},{key:'dup'}]}),error=>error.code==='discovery_conflict');
const lengths=[];
const watched=d1Standin(live.file,{onBatch:statements=>lengths.push(statements.length)});
await Authority.importSegment({DB:watched,BUCKET:bucket},{sourceKey:'archive:seg-3',programmeRunId:'run-b',contentSha256:sha,items:segmentItems,r2Key:'epg/archive/seg-3.json'});
assert.ok(lengths.every(length=>length<=Authority.STATEMENT_CAP));
assert.ok(lengths.length>1);

const again=await Authority.acquireLease(env,{programmeRunId:'run-b'});
env.discoveryLease=again.lease;
const terminal={...decision,terminalReason:'repeated_uncertain_match',retryAt:new Date().toISOString()};
await Authority.routeWrite(env,'epg/discovery-resolution.json',{'obs-1':terminal});
const expected=await Authority.decisionHash((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1']);
await Authority.putIntent(env,{idempotencyKey:'reconsider-key-0001',kind:'reconsider',observationKey:'obs-1'});
await Authority.markIntentRunning(env,{idempotencyKey:'reconsider-key-0001',before:terminal,lease:again.lease});
const unknown=await Authority.ownerDecision(env,{idempotencyKey:'reconsider-key-0001',key:'obs-1',expectedHash:expected,next:{...terminal,terminalReason:null,retryAt:null},lease:again.lease,writer:'discovery_reconsider'});
assert.equal(unknown.outcome,'unknown');
assert.equal((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].terminalReason,'repeated_uncertain_match');
await live.db.sql("UPDATE discovery_intent SET state='approved', receipt_json=NULL WHERE idempotency_key='reconsider-key-0001'");
const lifted={...terminal,terminalReason:null,retryAt:null,reconsidered:{at:'2026-11-03T22:00:00.000Z',idempotencyKey:'reconsider-key-0001'}};
const written=await Authority.ownerDecision(env,{idempotencyKey:'reconsider-key-0001',key:'obs-1',expectedHash:expected,next:lifted,lease:again.lease,writer:'discovery_reconsider',receipt:{state:'applied',capability:'discovery_reconsider'}});
assert.equal(written.outcome,'written');
assert.equal((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].terminalReason,null);
const replay=await Authority.ownerDecision(env,{idempotencyKey:'reconsider-key-0001',key:'obs-1',expectedHash:'nope',next:terminal,lease:again.lease,writer:'discovery_reconsider'});
assert.equal(replay.outcome,'replay');
assert.equal(replay.receipt.capability,'discovery_reconsider');

await Authority.putIntent(env,{idempotencyKey:'assign-key-0000001',kind:'identity_assign',observationKey:'obs-1'});
const assigned={...lifted,status:'verified',tmdbId:'41',filmId:'tmdb_41',canonicalIdentity:'tmdb:41',identitySource:'owner',terminalReason:null,retryAt:null};
const assign=await Authority.ownerDecision(env,{idempotencyKey:'assign-key-0000001',key:'obs-1',expectedHash:await Authority.decisionHash(lifted),next:assigned,lease:again.lease,writer:'discovery_identity_correct',receipt:{state:'applied',effect:'assign',tmdbId:'41'}});
assert.equal(assign.outcome,'written');
assert.equal((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].status,'verified');
assert.equal(count(live.db,'SELECT COUNT(*) AS n FROM film'),0);
live.db.sql("UPDATE published_epg_authority SET programme_run_id='run-b' WHERE id=1");
live.db.sql("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-b','tmdb_41','c',1,2,'C',NULL,'discovery','obs-1'),('run-b','tmdb_41','d',3,4,'D',NULL,'discovery','other-key')");
await Authority.putIntent(env,{idempotencyKey:'reject-key-0000001',kind:'identity_reject',observationKey:'obs-1'});
const rejected={...assigned,status:'needs_verification',tmdbId:null,filmId:null,canonicalIdentity:null,rejectedTmdbIds:['41'],terminalReason:null,retryAt:null};
const reject=await Authority.ownerDecision(env,{idempotencyKey:'reject-key-0000001',key:'obs-1',expectedHash:await Authority.decisionHash(assigned),next:rejected,lease:again.lease,writer:'discovery_identity_correct',receipt:{state:'applied',effect:'reject',tmdbId:'41'}});
assert.equal(reject.outcome,'written');
assert.deepEqual((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].rejectedTmdbIds,['41']);
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs-1'"),0,'D1 reject drops this observation\'s assigned discovery shows');
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='other-key'"),1,'other observation shows stay');
const docFilm={id:'tmdb_70',tmdbId:'70',canonicalIdentity:'tmdb:70',title:'A Life in Music',year:2020,runtime:90,genres:['документальный']};
const concertFilm={id:'tmdb_71',tmdbId:'71',canonicalIdentity:'tmdb:71',title:'Hall Live at Arena',year:1998,runtime:120,genres:['музыка'],overview:'A concert recording filmed live on stage.'};
await Authority.replaceCatalog(env,{tmdb_70:docFilm,tmdb_71:concertFilm});
const docDecision={status:'verified',tmdbId:'70',filmId:'tmdb_70',canonicalIdentity:'tmdb:70',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence};
const concertDecision={status:'verified',tmdbId:'71',filmId:'tmdb_71',canonicalIdentity:'tmdb:71',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence};
live.db.sql("INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES ('doc-obs', 'run-b', 1, 'verified', 1, NULL, NULL, NULL, '70', 'movie', 'tmdb_70', '"+await Authority.decisionHash(docDecision)+"', '"+JSON.stringify(docDecision).replace(/'/g,"''")+"')");
live.db.sql("INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES ('concert-obs', 'run-b', 1, 'verified', 1, NULL, NULL, NULL, '71', 'movie', 'tmdb_71', '"+await Authority.decisionHash(concertDecision)+"', '"+JSON.stringify(concertDecision).replace(/'/g,"''")+"')");
live.db.sql("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-b','tmdb_70','c',10,11,'C',NULL,'discovery','doc-obs'),('run-b','tmdb_71','c',12,13,'C',NULL,'discovery','concert-obs'),('run-b','tmdb_70','c',14,15,'C',NULL,'title_year','doc-obs')");
const drama={id:'tmdb_72',tmdbId:'72',canonicalIdentity:'tmdb:72',title:'Drama',year:2001,genres:['драма']};
await Authority.replaceCatalog(env,{tmdb_70:docFilm,tmdb_71:concertFilm,tmdb_72:drama});
const refusedDrama=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_72',lease:again.lease});
assert.equal(refusedDrama.outcome,'not_eligible');
const ambiguousLive={id:'tmdb_84',tmdbId:'84',canonicalIdentity:'tmdb:84',title:'Band Live',year:2013,runtime:90,genres:['музыка']};
await Authority.replaceCatalog(env,{tmdb_70:docFilm,tmdb_71:concertFilm,tmdb_72:drama,tmdb_84:ambiguousLive});
const previewAmbiguous=await Authority.readPolicyExcludePreview(env,'tmdb_84');
assert.equal(previewAmbiguous.policy,'ambiguous');
assert.equal(previewAmbiguous.available,true);
assert.equal(previewAmbiguous.reason,'eligible');
const excludedAmbiguous=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_84',lease:again.lease});
assert.equal(excludedAmbiguous.outcome,'written');
assert.equal(excludedAmbiguous.policy,'ambiguous');
assert.equal(one(live.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_84'").state,'superseded');
const previewDoc=await Authority.readPolicyExcludePreview(env,'tmdb_70');
assert.equal(previewDoc.available,true);
assert.equal(previewDoc.policy,'documentary');
const excludedDoc=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_70',lease:again.lease});
assert.equal(excludedDoc.outcome,'written');
assert.equal(one(live.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_70'").state,'superseded');
assert.equal((await Authority.routeRead(env,'epg/discovered-films.json')).value.tmdb_70,undefined);
assert.equal(JSON.parse(one(live.db,"SELECT payload_json FROM discovery_decision WHERE observation_key='doc-obs'").payload_json).status,'needs_verification');
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='doc-obs' AND basis='discovery'"),0);
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='doc-obs' AND basis='title_year'"),1);
// AIR-501 / ADR 0169: a card with no genre and a concert in its synopsis is reached by the owner writer; one with no such words is not.
const picnicLike={id:'tmdb_85',tmdbId:'85',canonicalIdentity:'tmdb:85',title:'Весенний концерт группы',year:2014,runtime:108,genres:[],synopsis:'В марте прошёл традиционный весенний концерт группы.'};
const fictionNoGenre={id:'tmdb_86',tmdbId:'86',canonicalIdentity:'tmdb:86',title:'Улица младшего сына',year:1962,runtime:98,genres:[],synopsis:'В приморском городе Керчь живет мальчишка Володя.'};
await Authority.replaceCatalog(env,{...(await Authority.routeRead(env,'epg/discovered-films.json')).value,tmdb_85:picnicLike,tmdb_86:fictionNoGenre});
// The Worker bundle carries the domain gate as globals; load it the same way for this block.
vm.runInThisContext(fs.readFileSync('src/domain/resolution-acceptance.js','utf8')+';globalThis.admissionPolicy=admissionPolicy;globalThis.filmAdmissionInput=filmAdmissionInput;globalThis.catalogCleanupPolicy=catalogCleanupPolicy;');
const previewPicnic=await Authority.readPolicyExcludePreview(env,'tmdb_85');
assert.equal(previewPicnic.policy,'concert');
assert.equal(previewPicnic.available,true);
const reviewedArctic={id:'tmdb_1623086',tmdbId:'1623086',canonicalIdentity:'tmdb:1623086',title:'Арктика. Очищение',year:2020,runtime:55,genres:[],synopsis:'Экспедиция.'};
const reviewedDrift={id:'tmdb_569928',tmdbId:'569928',canonicalIdentity:'tmdb:569928',title:'Большой белый танец',year:null,runtime:70,genres:[],synopsis:'Лента о хищнике.'};
await Authority.replaceCatalog(env,{...(await Authority.routeRead(env,'epg/discovered-films.json')).value,tmdb_1623086:reviewedArctic,tmdb_569928:reviewedDrift});
const previewReviewed=await Authority.readPolicyExcludePreview(env,'tmdb_1623086');
assert.equal(previewReviewed.policy,'documentary');
assert.equal(previewReviewed.available,true);
const previewDrift=await Authority.readPolicyExcludePreview(env,'tmdb_569928');
assert.equal(previewDrift.available,false);
assert.equal(previewDrift.reason,'not_policy_excluded');
const previewFiction=await Authority.readPolicyExcludePreview(env,'tmdb_86');
assert.equal(previewFiction.available,false);
assert.equal(previewFiction.reason,'not_policy_excluded');
const excludedPicnic=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_85',lease:again.lease});
assert.equal(excludedPicnic.outcome,'written');
assert.equal((await Authority.ownerPolicyExclude(env,{filmId:'tmdb_86',lease:again.lease})).outcome,'not_eligible');
globalThis.admissionPolicy=undefined;globalThis.filmAdmissionInput=undefined;globalThis.catalogCleanupPolicy=undefined;
const sealedProgramme={films:[]};
assert.equal(PublishedEpg.completeProgramme(sealedProgramme,[]),sealedProgramme,'completed programme overlay is a no-op without discovery rows; title_year table rows are not that overlay');
const replayDoc=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_70',lease:again.lease});
assert.equal(replayDoc.outcome,'already_applied');
const excludedConcert=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_71',lease:again.lease});
assert.equal(excludedConcert.outcome,'written');
assert.equal(excludedConcert.policy,'concert');
assert.equal(one(live.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_71'").state,'superseded');
assert.equal(Authority.POLICY_EXCLUDE_CAP,12);
assert.equal(Authority.POLICY_EXCLUDE_CAP,Math.floor((Authority.STATEMENT_CAP-4)/3));
const rejectFilm={id:'tmdb_73',tmdbId:'73',canonicalIdentity:'tmdb:73',title:'Rejected List',year:2020,runtime:90,genres:['документальный']};
const linkedDoc={id:'tmdb_74',tmdbId:'74',canonicalIdentity:'tmdb:74',title:'Linked Doc',year:2020,runtime:90,genres:['документальный']};
const linkedOther={id:'tmdb_75',tmdbId:'75',canonicalIdentity:'tmdb:75',title:'Other Film',year:2001,genres:['драма']};
const capOver={id:'tmdb_80',tmdbId:'80',canonicalIdentity:'tmdb:80',title:'Over Cap',year:2020,runtime:90,genres:['документальный']};
const capOk={id:'tmdb_81',tmdbId:'81',canonicalIdentity:'tmdb:81',title:'At Cap',year:2020,runtime:90,genres:['документальный']};
const synopsisConcert={id:'tmdb_76',tmdbId:'76',canonicalIdentity:'tmdb:76',title:'Nazareth - No Means of Escape',year:2015,runtime:56,genres:['музыка'],synopsis:'A live concert film of the band on tour.'};
await Authority.replaceCatalog(env,{tmdb_70:docFilm,tmdb_71:concertFilm,tmdb_72:drama,tmdb_73:rejectFilm,tmdb_74:linkedDoc,tmdb_75:linkedOther,tmdb_76:synopsisConcert,tmdb_80:capOver,tmdb_81:capOk});
const synopsisPreview=await Authority.readPolicyExcludePreview(env,'tmdb_76');
assert.equal(synopsisPreview.policy,'concert','stored synopsis maps to overview for ADR 0150 concert phrases');
assert.equal(synopsisPreview.available,true);
assert.equal(synopsisPreview.reason,'eligible');
async function putDecision(key,decision,filmId){
 const hash=await Authority.decisionHash(decision);
 const filmSql=filmId==null?'NULL':"'"+filmId+"'";
 live.db.sql("INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) VALUES ('"+key+"', 'run-b', 1, '"+(decision.status||'verified')+"', 1, NULL, NULL, NULL, '"+decision.tmdbId+"', 'movie', "+filmSql+", '"+hash+"', '"+JSON.stringify(decision).replace(/'/g,"''")+"')");
}
await putDecision('reject-obs',{status:'verified',tmdbId:'73',filmId:'tmdb_73',canonicalIdentity:'tmdb:73',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence,rejectedTmdbIds:['1','2','3','4','5','6','7','8']},'tmdb_73');
const rejectedList=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_73',lease:again.lease});
assert.equal(rejectedList.outcome,'written');
const rejectedPayload=JSON.parse(one(live.db,"SELECT payload_json FROM discovery_decision WHERE observation_key='reject-obs'").payload_json);
assert.equal(rejectedPayload.rejectedTmdbIds[0],'73');
assert.equal(rejectedPayload.rejectedTmdbIds.length,8);
assert.equal(rejectedPayload.rejectedTmdbIds.includes('8'),false);
await putDecision('linked-obs',{status:'verified',tmdbId:'74',filmId:'tmdb_75',canonicalIdentity:'tmdb:75',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence},'tmdb_75');
const linkedPreview=await Authority.readPolicyExcludePreview(env,'tmdb_74');
assert.equal(linkedPreview.available,false);
assert.equal(linkedPreview.reason,'linked_admission');
const linkedWrite=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_74',lease:again.lease});
assert.equal(linkedWrite.outcome,'not_eligible');
assert.equal(linkedWrite.reason,'linked_admission');
assert.equal(one(live.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_74'").state,'current');
for(let i=0;i<13;i++)await putDecision('over-obs-'+i,{status:'verified',tmdbId:'80',filmId:'tmdb_80',canonicalIdentity:'tmdb:80',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence},'tmdb_80');
const overPreview=await Authority.readPolicyExcludePreview(env,'tmdb_80');
assert.equal(overPreview.available,false);
assert.equal(overPreview.reason,'bounded');
assert.equal(overPreview.cap,12);
const overWrite=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_80',lease:again.lease});
assert.equal(overWrite.outcome,'bounded');
assert.equal(one(live.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_80'").state,'current');
for(let i=0;i<12;i++)await putDecision('ok-obs-'+i,{status:'verified',tmdbId:'81',filmId:'tmdb_81',canonicalIdentity:'tmdb:81',identitySource:'tmdb_detail',attempts:1,evidenceKey:evidence},'tmdb_81');
const okWrite=await Authority.ownerPolicyExclude(env,{filmId:'tmdb_81',lease:again.lease});
assert.equal(okWrite.outcome,'written');
const collided=await Authority.ownerDecision(env,{idempotencyKey:'missing-key-000001',key:'obs-1',expectedHash:expected,next:assigned,lease:again.lease});
assert.equal(collided.outcome,'missing');

const continuation=await Authority.writeContinuation(env,{stage:'paused',programmeRunId:'run-b',remainingChunks:12},null);
assert.equal(continuation.saved,true);
const readBack=await Authority.readContinuation(env);
assert.equal(readBack.record.programmeRunId,'run-b');
const lost=await Authority.writeContinuation(env,{stage:'running',programmeRunId:'run-b'},'d1:0');
assert.equal(lost.saved,false);
const replaced=await Authority.writeContinuation(env,{stage:'paused',programmeRunId:'run-b',remainingChunks:11},readBack.etag);
assert.equal(replaced.saved,true);
const workflow=await Authority.writeWorkflow(env,{instanceId:'discovery_runb_0',programmeRunId:'run-b',series:0,phase:'stopped'},null);
assert.equal(workflow.saved,true);
assert.equal((await Authority.readWorkflow(env)).record.instanceId,'discovery_runb_0');
assert.match(fs.readFileSync('src/discovery-workflow.js','utf8'),/await binding\.create\(\{id:instanceId/);

const index=await Authority.readObservationIndex(env,{});
assert.equal(index.index.state,'fresh');
assert.equal(index.index.records.some(row=>row.key==='obs-1'),true);
const staleIndex=await Authority.readObservationIndex(env,{expectedGeneration:0});
assert.equal(staleIndex.index.state,'stale');
const bounded=await Authority.readObservationIndex(env,{limit:0});
assert.equal(bounded.index.records.length,0);
assert.equal(bounded.index.manifest.coverage.complete,false);
const quiet=migrated();
open(quiet.db);
assert.equal((await Authority.readObservationIndex({DB:quiet.db},{})).index.state,'unavailable');

const outage={prepare(){throw new Error('d1 down');}};
await assert.rejects(()=>Authority.routeRead({DB:outage},'epg/discovery-resolution.json'),error=>error.code==='discovery_unavailable');
const marker={prepare(sql){return {bind(){return this;},async first(){if(sql.includes('schema_contract'))return {version:11};if(sql.includes('discovery_authority'))return {mode:'other',cutover:'open',generation:1,programmeRunId:null,publishedProgrammeRunId:null};return {state:'committed'};},async all(){return {results:Authority.DISCOVERY_TABLES.map(name=>({name}))};}};}};
await assert.rejects(()=>Authority.readAuthority({DB:marker}),error=>error.code==='discovery_unavailable');

const script=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database',live.file],{encoding:'utf8'});
assert.equal(script.status,0);
assert.equal(JSON.parse(script.stdout).mode,'d1');
assert.equal(JSON.parse(script.stdout).writes,false);
const production=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database','/tmp/iptv/discovery.sqlite'],{encoding:'utf8'});
assert.equal(production.status,2);
assert.match(production.stderr,/refuse/);
const activate=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database',live.file,'--activate'],{encoding:'utf8'});
assert.equal(activate.status,2);
const resetLoad=spawnSync(process.execPath,['scripts/discovery-authority.mjs','--database',live.file,'--reset-load'],{encoding:'utf8'});
assert.equal(resetLoad.status,2);

await Authority.releaseLease(env,again.lease);
const foreignLease=await Authority.acquireLease(env,{programmeRunId:'run-new'});
assert.equal(foreignLease.lease,null,'a new EPG run cannot take the lease while the marker names another run');
const kept=await Authority.acquireLease(env,{programmeRunId:'run-b'});
assert.ok(kept.lease);
env.discoveryLease=kept.lease;
await bucket.put('epg/generations/run-old/discovery-latest.json',JSON.stringify({programmeRunId:'run-old',items:[{key:'foreign'}]}));
const oldRead=await Authority.routeRead(env,'epg/generations/run-old/discovery-latest.json');
assert.equal(oldRead.handled,true);
assert.equal(oldRead.value,null);
assert.equal((await Authority.routeRead(env,'epg/generations/run-b/discovery-latest.json')).value.items[0].key,'obs-1');
await assert.rejects(()=>Authority.routeWrite(env,'epg/generations/run-old/discovery-latest.json',{programmeRunId:'run-old',items:[item]}),error=>error.code==='discovery_fence');
await assert.rejects(()=>Authority.routeWrite(env,'epg/generations/run-c/discovery-latest.json',{programmeRunId:'run-c',items:[item]}),error=>error.code==='discovery_fence');
assert.equal((await Authority.routeRead(env,'epg/discovery-latest.json')).value.items[0].key,'obs-1');
await Authority.routeWrite(env,'epg/generations/run-c/discovery-latest.json',{programmeRunId:'run-c',items:[item]},{handoff:true,lease:kept.lease});
assert.equal((await Authority.routeRead(env,'epg/generations/run-b/discovery-latest.json')).value,null);
assert.equal((await Authority.routeRead(env,'epg/generations/run-c/discovery-latest.json')).value.items[0].key,'obs-1');
assert.equal((await Authority.routeRead(env,'epg/discovery-latest.json')).value.programmeRunId,'run-c');

const issuedHash=await Authority.decisionHash((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1']);
await Authority.putIntent(env,{idempotencyKey:'issued-reconsider-01',kind:'reconsider',observationKey:'obs-1',expectedHash:issuedHash,expiresAt:Date.now()-1,issued:{capability:'discovery_reconsider'}});
const expired=await Authority.ownerDecision(env,{idempotencyKey:'issued-reconsider-01',key:'obs-1',expectedHash:issuedHash,next:{status:'needs_verification'},lease:kept.lease,expiresAt:Date.now()+60000});
assert.equal(expired.outcome,'expired');
await Authority.putIntent(env,{idempotencyKey:'issued-reconsider-02',kind:'reconsider',observationKey:'obs-1',expectedHash:issuedHash,expiresAt:Date.now()+60000,issued:{capability:'discovery_reconsider'}});
const tampered=await Authority.ownerDecision(env,{idempotencyKey:'issued-reconsider-02',key:'obs-1',expectedHash:'f'.repeat(64),next:{status:'needs_verification'},lease:kept.lease});
assert.equal(tampered.outcome,'conflict');
await Authority.putIntent(env,{idempotencyKey:'issued-assign-00001',kind:'identity_assign',observationKey:'obs-1',expectedHash:issuedHash,expiresAt:Date.now()+60000,command:{effect:'assign',tmdbId:'41'}});
const otherTarget=await Authority.ownerDecision(env,{idempotencyKey:'issued-assign-00001',key:'obs-1',expectedHash:issuedHash,next:{status:'verified',tmdbId:'99'},lease:kept.lease});
assert.equal(otherTarget.outcome,'conflict');
assert.equal((await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].status!=='verified'||(await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-1'].tmdbId!=='99',true);

const indexed=migrated();
open(indexed.db);
indexed.db.sql("UPDATE discovery_authority SET programme_run_id='run-index', published_programme_run_id='run-index' WHERE id=1");
const indexedDecision={status:'needs_verification',attempts:1};
const indexedHash=await Authority.decisionHash(indexedDecision);
const indexedPayload=JSON.stringify(indexedDecision).replace(/'/g,"''");
const indexedRows=[];
for(let index=0;index<=3000;index++){
 const key='k'+String(index).padStart(5,'0');
 indexedRows.push(`('active','${key}','active','run-index','t','T',1990,'',1,NULL,NULL,NULL,'{}')`);
}
for(let index=0;index<indexedRows.length;index+=400)indexed.db.sql('INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES '+indexedRows.slice(index,index+400).join(','));
indexed.db.sql(`INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, evidence_key, terminal_reason, retry_at, tmdb_id, media_kind, film_id, decision_hash, payload_json) SELECT observation_key, 'run-index', 1, 'needs_verification', 1, '', NULL, NULL, NULL, NULL, NULL, '${indexedHash}', '${indexedPayload}' FROM discovery_observation`);
const far=await Authority.readObservationIndex({DB:indexed.db},{key:'k03000'});
assert.equal(far.index.records.length,1);
assert.equal(far.index.records[0].key,'k03000');
assert.equal(far.index.state,'fresh');
const absent=await Authority.readObservationIndex({DB:indexed.db},{key:'missing-observation'});
assert.equal(absent.index.records.length,0);
assert.equal(absent.index.state,'fresh');
const listed=await Authority.readObservationIndex({DB:indexed.db},{limit:2});
assert.equal(listed.index.records.length,2);
assert.equal(listed.index.records.some(row=>row.key==='k03000'),false);
assert.equal(listed.index.manifest.coverage.complete,false);
// AIR-528: the D1 generation moves AFTER the observation SELECT and before the closing generation check. The real authority then answers
// stale with no manifest (never an index shell that a reader could mistake for a described index), and nothing is written by the read.
{
 let moved=false;
 const drifting={calls:indexed.db.calls,prepare(sql){
  const inner=indexed.db.prepare(sql);
  if(!/FROM discovery_observation o JOIN discovery_decision d/.test(sql))return inner;
  return {bind(...params){const bound=inner.bind(...params);return {...bound,all:async(...args)=>{const rows=await bound.all(...args);if(!moved){moved=true;indexed.db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}return rows;}};}};
 }};
 const writesBefore=count(indexed.db,'SELECT SUM(generation) AS n FROM discovery_authority');
 const flipped=await Authority.readObservationIndex({DB:drifting},{limit:2});
 assert.equal(moved,true,'the generation moved between the SELECT and the closing check');
 assert.equal(flipped.index.state,'stale');
 assert.equal(flipped.index.manifest,null);
 assert.deepEqual(flipped.index.records,[]);
 assert.deepEqual(flipped.index.reasons,['generation_moved']);
 assert.equal(count(indexed.db,'SELECT SUM(generation) AS n FROM discovery_authority'),writesBefore+1,'only the simulated move changed state');
 const settled=await Authority.readObservationIndex({DB:indexed.db},{limit:2});
 assert.equal(settled.index.state,'fresh');
}
// The shows of the listed observations are read in chunked statements, grouped by observation and ordered by ordinal; never one statement per observation.
{
 const showRows=[];
 for(let n=0;n<200;n++){const key='k'+String(n).padStart(5,'0');showRows.push(`('active','${key}',1,'c${n}b','Channel ${n}b',${2000+n},${3000+n})`,`('active','${key}',0,'c${n}a','Channel ${n}a',${1000+n},${1500+n})`);}
 showRows.push("('active','k00007',2,'c7c','Channel 7c',7777,8888)");
 indexed.db.sql('INSERT INTO discovery_observation_show (source_key, observation_key, ordinal, channel_id, channel, start_ms, end_ms) VALUES '+showRows.join(','));
 // D1 binds at most 100 parameters: no statement of the read may bind more.
 let widest=0,statements=0;
 const guarded={calls:indexed.db.calls,prepare(sql){const inner=indexed.db.prepare(sql);return {bind(...params){widest=Math.max(widest,params.length);assert.ok(params.length<=100,'a statement bound '+params.length+' parameters');statements++;return inner.bind(...params);},first(){return inner.first();},all(){return inner.all();},run(){return inner.run();}};}};
 const queriesBefore=indexed.db.calls.queries;
 const chunked=await Authority.readObservationIndex({DB:guarded},{limit:200});
 const used=indexed.db.calls.queries-queriesBefore;
 assert.equal(chunked.index.records.length,200);
 assert.equal(chunked.index.state,'fresh');
 // the authority gate is read twice (a handful of statements each), one statement selects the observations, ceil(200/80)=3 select their shows. One statement per observation would be 200 more.
 assert.ok(used<=20,'the index read used '+used+' statements');
 assert.ok(widest>=80&&widest<=100,'the show reads are chunked at '+widest);
 const byKey=Object.fromEntries(chunked.index.records.map(record=>[record.key,record]));
 assert.deepEqual(byKey.k00003.shows,[{channelId:'c3a',channel:'Channel 3a',start:1003,end:1503},{channelId:'c3b',channel:'Channel 3b',start:2003,end:3003}],'shows keep their ordinal order although inserted in reverse');
 assert.deepEqual(byKey.k00007.shows.map(show=>show.channelId),['c7a','c7b','c7c']);
 assert.deepEqual(byKey.k00199.shows.map(show=>show.channelId),['c199a','c199b']);
 const withoutShows=chunked.index.records.find(record=>!['k'+String(0).padStart(5,'0')].includes(record.key)&&record.shows.length===0);
 assert.equal(withoutShows,undefined,'every one of the 200 listed observations has its shows');
 const bare=await Authority.readObservationIndex({DB:guarded},{limit:250});
 const unlisted=bare.index.records.filter(record=>record.shows.length===0);
 assert.ok(unlisted.length>0&&unlisted.length<=250,'observations without show rows keep an empty list');
 assert.ok(unlisted.every(record=>record.shows.length===0));
 // a keyed read is unchanged: one record with its shows
 const keyed=await Authority.readObservationIndex({DB:guarded},{key:'k00007'});
 assert.equal(keyed.index.records[0].shows.length,3);
}

const crashed=migrated();
open(crashed.db);
const crashEnv=envFor(crashed.db);
const crashLease=await Authority.acquireLease(crashEnv,{programmeRunId:'run-a'});
crashEnv.discoveryLease=crashLease.lease;
await Authority.replaceLedger(crashEnv,{programmeRunId:'run-a',items:[item]});
let killed=0;
const flakyLedger=d1Standin(crashed.file,{onBatch(){killed++;if(killed===2)throw new Error('killed');}});
const flakyEnv=envFor(flakyLedger);
flakyEnv.discoveryLease=crashLease.lease;
await assert.rejects(()=>Authority.replaceLedger(flakyEnv,{programmeRunId:'run-a',items:[item,{...item,key:'obs-2'}]}),error=>error.code==='discovery_unavailable');
assert.equal(one(crashed.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'loading');
await assert.rejects(()=>Authority.routeRead(envFor(crashed.db),'epg/discovery-latest.json'),error=>error.code==='discovery_incomplete');
const healedLedger=envFor(d1Standin(crashed.file));
healedLedger.discoveryLease=crashLease.lease;
await Authority.replaceLedger(healedLedger,{programmeRunId:'run-a',items:[item,{...item,key:'obs-2'}]});
assert.deepEqual((await Authority.routeRead(healedLedger,'epg/discovery-latest.json')).value.items.map(row=>row.key).sort(),['obs-1','obs-2']);

await Authority.releaseLease(env,kept.lease);
const segmentCrash=Array.from({length:30},(_,index)=>({key:'crash-'+index,title:'C'+index,normalizedTitle:'c'+index,year:2001,durations:[80],shows:[{channelId:'c',start:index}]}));
const segmentSha=await Authority.segmentContentSha(segmentCrash);
let segmentBatches=0;
const flakySegment=d1Standin(live.file,{onBatch(){segmentBatches++;if(segmentBatches===2)throw new Error('killed');}});
await assert.rejects(()=>Authority.importSegment({DB:flakySegment},{sourceKey:'archive:seg-crash',programmeRunId:'run-c',contentSha256:segmentSha,items:segmentCrash}),error=>error.code==='discovery_unavailable');
assert.equal(one(live.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'loading');
await assert.rejects(()=>Authority.routeRead(env,'epg/discovery-latest.json'),error=>error.code==='discovery_incomplete');
await Authority.importSegment(env,{sourceKey:'archive:seg-crash',programmeRunId:'run-c',contentSha256:segmentSha,items:segmentCrash});
assert.equal(count(live.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='archive:seg-crash'"),30);
assert.equal(one(live.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'committed');
assert.equal((await Authority.routeRead(env,'epg/discovery-latest.json')).value.items[0].key,'obs-1');

const streamed=migrated();
open(streamed.db);
const streamEnv=envFor(streamed.db);
const streamLease=await Authority.acquireLease(streamEnv,{programmeRunId:null});
streamEnv.discoveryLease=streamLease.lease;
let yielded=0;
const generated=async function*(){for(const row of [item,{...item,key:'obs-stream'}]){yielded++;yield row;}};
await assert.rejects(()=>Authority.ingestLedger(streamEnv,{programmeRunId:'run-stream',lease:streamLease.lease,items:generated()}),error=>error.code==='discovery_fence');
assert.equal(yielded,0);
await Authority.ingestLedger(streamEnv,{programmeRunId:'run-stream',handoff:true,lease:streamLease.lease,items:generated()});
assert.equal(yielded,2);
assert.deepEqual((await Authority.routeRead(streamEnv,'epg/discovery-latest.json')).value.items.map(row=>row.key).sort(),['obs-1','obs-stream']);

const wide=migrated();
open(wide.db);
const wideEnv=envFor(wide.db);
const wideLease=await Authority.acquireLease(wideEnv,{programmeRunId:null});
wideEnv.discoveryLease=wideLease.lease;
const hotStart=Date.now()+3600000;
const hot={key:'000-hot',title:'Hot Film',normalizedTitle:'hot film',year:1999,durations:[100],shows:[{channelId:'c',channel:'C',start:hotStart,end:hotStart+1000}],seenInLatestSnapshot:true,lastAiring:hotStart};
await Authority.ingestLedger(wideEnv,{programmeRunId:'run-wide',handoff:true,lease:wideLease.lease,items:(async function*(){yield hot;})()});
const extra=[];
for(let index=0;index<20000;index++)extra.push(`('active','w${String(index).padStart(5,'0')}','active','run-wide','t','T',1990,'',0,1,NULL,NULL,'{"seenInLatestSnapshot":false,"lastSeenAt":1,"title":"T","normalizedTitle":"t","year":1990,"durations":[90]}')`);
for(let index=0;index<extra.length;index+=400)wide.db.sql('INSERT INTO discovery_observation (source_key, observation_key, residence, programme_run_id, normalized_title, title, year, evidence_key, seen_in_latest, last_seen_at, last_airing, confirmed_tmdb_id, payload_json) VALUES '+extra.slice(index,index+400).join(','));
const paged=await Authority.routeRead(wideEnv,'epg/discovery-latest.json');
assert.equal(paged.value.paged,true);
assert.equal(paged.value.itemCount,20001);
assert.equal(paged.value.items,null);
assert.deepEqual(paged.value.archive,{source:'d1',d1:{archiveOnlyRows:0,unreferencedRows:0,segmentRows:0}});
let walked=0;
const statusWalk=await Authority.streamActiveLedger(wideEnv,()=>{walked++;});
assert.equal(statusWalk.handled,true);
assert.equal(statusWalk.itemCount,20001);
assert.equal(walked,20001);
assert.equal(statusWalk.archive.d1.archiveOnlyRows,0);assert.equal(statusWalk.ledgerMode,'unknown');
hold(wide.db);
await assert.rejects(()=>Authority.streamActiveLedger(wideEnv,()=>{throw new Error('held walks nothing');}),error=>error.code==='discovery_unavailable','a held cutover is refused (ADR 0162)');
open(wide.db);
wide.db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
await assert.rejects(()=>Authority.streamActiveLedger(wideEnv,()=>{}),error=>error.code==='discovery_incomplete');
wide.db.sql("UPDATE discovery_transfer SET state='committed' WHERE id=1");
const wideContext=vm.createContext({console,Date,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,fetch(){wideFetches.push(wideStatus);return new Response('{}',{status:wideStatus,headers:{'Retry-After':'30'}});},DiscoveryAuthority:Authority,pinEpg:async value=>value,loadJSON:async(target,key)=>{const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),wideContext);
wideEnv.TMDB_API_READ_ACCESS_TOKEN='test';
wideEnv.TMDB_REQUEST_INTERVAL_MS=0;
let wideFetches=[],wideStatus=429;
const limited=await wideContext.resolveDiscoveryChunk(wideEnv,{films:[]},1,wideLease.lease);
assert.equal(limited.error,'TMDB HTTP 429');
assert.equal(limited.paged,true);
assert.equal(limited.itemCount,20001);
assert.ok(limited.maxPage<=Authority.LEDGER_PAGE);
assert.equal(limited.maxPage>0,true);
assert.deepEqual(wideFetches,[429]);
assert.ok(limited.retryAt);
wideStatus=403;
wideFetches=[];
await Authority.routeWrite(wideEnv,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',programmeRunId:'run-wide',retryAt:null});
wide.db.sql("UPDATE discovery_decision SET retry_at='2020-01-01T00:00:00.000Z'");
const forbidden=await wideContext.resolveDiscoveryChunk(wideEnv,{films:[]},1,wideLease.lease);
assert.equal(forbidden.error,'TMDB HTTP 403');
assert.deepEqual(wideFetches,[403]);
assert.ok(forbidden.retryAt);

const httpDb=migrated();
open(httpDb.db);
const httpBucket=new MemoryBucket();
const httpEnv=envFor(httpDb.db,httpBucket);
const httpLease=await Authority.acquireLease(httpEnv,{programmeRunId:null});
httpEnv.discoveryLease=httpLease.lease;
const httpNow=Date.now();
const httpShow=start=>({channelId:'c1',channel:'Первый',start,end:start+7200000});
const reconItem={key:'тихий берег|2001',title:'Тихий берег',normalizedTitle:'тихий берег',year:2001,durations:[95],shows:[httpShow(httpNow+3*3600000)],seenInLatestSnapshot:true,lastSeenAt:httpNow-3600000,lastAiring:httpNow+3*3600000};
const identityItem={key:'яркий берег|1999',title:'Яркий берег',normalizedTitle:'яркий берег',year:1999,durations:[100],shows:[httpShow(httpNow+3*3600000)],seenInLatestSnapshot:true,lastSeenAt:httpNow-3600000,lastAiring:httpNow+3*3600000};
const expiredItem={key:'громкий берег|2002',title:'Громкий берег',normalizedTitle:'громкий берег',year:2002,durations:[90],shows:[httpShow(httpNow+3*3600000)],seenInLatestSnapshot:true,lastSeenAt:httpNow-3600000,lastAiring:httpNow+3*3600000};
const RUN='11111111-1111-4111-8111-111111111111';
await Authority.replaceLedger(httpEnv,{programmeRunId:RUN,items:[reconItem,identityItem,expiredItem]});
const reconDecision={status:'no_confident_match',attempts:5,evidenceKey:Authority.evidenceKey(reconItem),terminalReason:'repeated_uncertain_match',retryAt:null};
const identityDecision={status:'needs_verification',attempts:1,evidenceKey:Authority.evidenceKey(identityItem),terminalReason:null,retryAt:null,scoring:{acceptedTmdbId:'41'}};
const expiredDecision={status:'no_confident_match',attempts:5,evidenceKey:Authority.evidenceKey(expiredItem),terminalReason:'repeated_uncertain_match',retryAt:null};
await Authority.routeWrite(httpEnv,'epg/discovery-resolution.json',{[reconItem.key]:reconDecision,[identityItem.key]:identityDecision,[expiredItem.key]:expiredDecision});
await Authority.replaceCatalog(httpEnv,{tmdb_41:{id:'tmdb_41',tmdbId:'41',canonicalIdentity:'tmdb:41',title:'Яркий берег',year:1999}});
await Authority.writeContinuation(httpEnv,{stage:'paused',reason:null,remainingChunks:6,programmeRunId:RUN,at:new Date().toISOString()},null);
await Authority.routeWrite(httpEnv,'epg/discovery-status.json',{schemaVersion:2,stage:'complete',programmeRunId:RUN,retryAt:null,at:new Date().toISOString()});
await Authority.releaseLease(httpEnv,httpLease.lease);
httpEnv.discoveryLease=null;
await httpBucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:RUN}));
const httpReads=[];
let denyQueueGet=false,denyQueueAfterPut=false;
const guardedBucket={
 async get(key){httpReads.push(key);if(denyQueueGet&&key==='enrichment/prediction-queue.json')throw new Error('queue unread');return httpBucket.get(key);},
 async head(key){return httpBucket.head(key);},
 async put(key,body,options){const written=await httpBucket.put(key,body,options);if(denyQueueAfterPut&&key==='enrichment/prediction-queue.json')denyQueueGet=true;return written;},
 async delete(){throw new Error('delete');},
 async list(){throw new Error('list');},
};
const httpContext=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,ReadableStream,WritableStream,atob,btoa,crypto:webcrypto,console,setTimeout,structuredClone,encodeURIComponent,decodeURIComponent,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],fetch:async()=>new Response('{}'),DiscoveryAuthority:Authority});
vm.runInContext(scoped('src/domain/discovery-observation-index.js','DiscoveryIndex'),httpContext);
for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),httpContext);
vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),httpContext);
vm.runInContext(fs.readFileSync('src/admin/owner-reviews.js','utf8'),httpContext);
vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),httpContext);
vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),httpContext);
vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),httpContext);
vm.runInContext(fs.readFileSync('src/admin/limbo.js','utf8'),httpContext);
vm.runInContext(scoped('src/domain/admin-actions.js','AdminActions'),httpContext);
vm.runInContext(scoped('src/domain/discovery-identity-review.js','DiscoveryIdentity'),httpContext);
vm.runInContext(scoped('src/domain/discovery-recovery.js','DiscoveryRecovery'),httpContext);
vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js','utf8'),httpContext);
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),httpContext);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),httpContext);
installViewIndexFixture(httpContext);
const routeEnv={...httpEnv,BUCKET:guardedBucket};
const origin='https://iptv.example';
const call=async(path,init)=>{const response=await httpContext.worker.fetch(new Request(origin+path,init),routeEnv,{waitUntil(){}});return {status:response.status,body:await response.json()};};
const ownerHeaders=action=>({'Cf-Access-Jwt-Assertion':'header.payload.signature',Origin:origin,'X-IPTV-Admin-Action':action,'Content-Type':'application/json'});
const viewed=await call('/api/admin/discovery-recovery?key='+encodeURIComponent(reconItem.key));
assert.equal(viewed.status,200,JSON.stringify(viewed.body));
assert.equal(viewed.body.action?.status,'eligible',JSON.stringify(viewed.body));
assert.match(viewed.body.pin,/^D1\.[0-9a-f]{32}$/);
const confirmed=await call('/api/admin/discovery-recovery/confirm',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({key:reconItem.key,pin:viewed.body.pin,idempotencyKey:'reconsider-http-0001',accepted:true})});
assert.equal(confirmed.status,200,JSON.stringify(confirmed.body));
assert.ok(confirmed.body.confirmation?.expiresAt);
const beforeTamper=count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_decision_history WHERE observation_key='тихий берег|2001'");
const structural=await call('/api/admin/discovery-recovery/reconsider',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({confirmation:{...confirmed.body.confirmation,pin:'D1.'+'ab'.repeat(16)}})});
assert.equal(structural.status,400,JSON.stringify(structural.body));
assert.equal(structural.body.refusal,'invalid_request');
const tamper=await call('/api/admin/discovery-recovery/reconsider',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({confirmation:{...confirmed.body.confirmation,expiresAt:'2099-01-01T00:00:00.000Z'}})});
assert.equal(tamper.status,409,JSON.stringify(tamper.body));
assert.equal(tamper.body.refusal,'confirmation_mismatch');
assert.equal(count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_decision_history WHERE observation_key='тихий берег|2001'"),beforeTamper);
const executed=await call('/api/admin/discovery-recovery/reconsider',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({confirmation:confirmed.body.confirmation})});
assert.equal(executed.status,200,JSON.stringify(executed.body));
assert.equal(executed.body.replayed,false);
assert.equal(executed.body.receipt?.state,'applied');
assert.equal((await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[reconItem.key].terminalReason,null);
const replayed=await call('/api/admin/discovery-recovery/reconsider',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({confirmation:confirmed.body.confirmation})});
assert.equal(replayed.status,200,JSON.stringify(replayed.body));
assert.equal(replayed.body.replayed,true);
assert.equal(replayed.body.receipt.decisionHash,executed.body.receipt.decisionHash);
httpReads.length=0;
const receipt=await call('/api/admin/discovery-recovery/receipt?idempotencyKey=reconsider-http-0001');
assert.equal(receipt.status,200,JSON.stringify(receipt.body));
assert.equal(receipt.body.record.receipt.state,'applied');
assert.equal(httpReads.some(key=>key.startsWith('admin/actions/')),false);
const expiredView=await call('/api/admin/discovery-recovery?key='+encodeURIComponent(expiredItem.key));
assert.equal(expiredView.body.action?.status,'eligible',JSON.stringify(expiredView.body));
const expiredConfirm=await call('/api/admin/discovery-recovery/confirm',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({key:expiredItem.key,pin:expiredView.body.pin,idempotencyKey:'reconsider-http-0002',accepted:true})});
assert.equal(expiredConfirm.status,200,JSON.stringify(expiredConfirm.body));
await httpDb.db.sql('UPDATE discovery_intent SET expires_at='+(Date.now()-1000)+" WHERE idempotency_key='reconsider-http-0002'");
const expiredExecute=await call('/api/admin/discovery-recovery/reconsider',{method:'POST',headers:ownerHeaders('discovery_reconsider'),body:JSON.stringify({confirmation:expiredConfirm.body.confirmation})});
assert.equal(expiredExecute.status,409,JSON.stringify(expiredExecute.body));
assert.equal(expiredExecute.body.refusal,'confirmation_expired');
assert.equal((await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[expiredItem.key].terminalReason,'repeated_uncertain_match');
const identityView=await call('/api/admin/discovery-recovery?key='+encodeURIComponent(identityItem.key));
const identityConfirmed=await call('/api/admin/discovery-recovery/identity-confirm',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({key:identityItem.key,pin:identityView.body.pin,idempotencyKey:'identity-http-00001',accepted:true,effect:'assign',tmdbId:'41',basis:'это тот фильм'})});
assert.equal(identityConfirmed.status,200,JSON.stringify(identityConfirmed.body));
const identityTamper=await call('/api/admin/discovery-recovery/identity-correct',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:{...identityConfirmed.body.confirmation,scopeFingerprint:'00000000'}})});
assert.equal(identityTamper.status,400,JSON.stringify(identityTamper.body));
const identityExecuted=await call('/api/admin/discovery-recovery/identity-correct',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:identityConfirmed.body.confirmation})});
assert.equal(identityExecuted.status,200,JSON.stringify(identityExecuted.body));
assert.equal((await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key].tmdbId,'41');
assert.match((await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key].ownerIdentity.identityBasis,/^[0-9a-f]{64}$/,'ADR 0178 section 1a: the live assign records the identity basis as provenance');
assert.equal(count(httpDb.db,'SELECT COUNT(*) AS n FROM film'),0);
const identityReceipt=await call('/api/admin/discovery-recovery/identity-receipt?idempotencyKey=identity-http-00001');
assert.equal(identityReceipt.status,200,JSON.stringify(identityReceipt.body));
assert.equal(identityReceipt.body.record.receipt.state,'applied');
const identityReplay=await call('/api/admin/discovery-recovery/identity-correct',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:identityConfirmed.body.confirmation})});
assert.equal(identityReplay.body.replayed,true,JSON.stringify(identityReplay.body));
// ADR 0178 / AIR-132: revoke the saved correction above through the real routes. The harness database is at schema 11, so the
// rebuild DDL of migration 0027 is applied as written, without its version guard.
const dbRows=()=>JSON.stringify([httpDb.db.sql('SELECT * FROM discovery_decision ORDER BY observation_key'),httpDb.db.sql('SELECT * FROM discovery_decision_history ORDER BY observation_key, revision'),httpDb.db.sql('SELECT * FROM discovery_intent ORDER BY idempotency_key'),httpDb.db.sql('SELECT * FROM discovery_admission ORDER BY film_id')]);
const revokePath='/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(identityItem.key)+'&requestId=identity-http-00001';
const rowsBeforePreview=dbRows();
const revokePreview=await call(revokePath);
assert.equal(revokePreview.status,200,JSON.stringify(revokePreview.body));
assert.equal(revokePreview.body.available,true,JSON.stringify(revokePreview.body));
assert.equal(revokePreview.body.original.effect,'assign');
assert.equal(revokePreview.body.original.tmdbId,'41');
assert.equal(revokePreview.body.application.waitsForOrdinaryChunk,true);
assert.equal(revokePreview.body.application.fence.releasedBy,'owner_assign_of_same_id');
assert.equal(dbRows(),rowsBeforePreview,'the preview writes nothing');
assert.equal((await call('/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(identityItem.key)+'&requestId=missing-request-00001')).body.reason,'intent_missing');
assert.equal((await call('/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(reconItem.key)+'&requestId=identity-http-00001')).body.reason,'wrong_observation');
assert.equal((await call('/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(identityItem.key))).status,400);
assert.equal((await call('/api/admin/discovery-recovery/revoke-preview',{method:'POST'})).status,405);
const revokeBody={key:identityItem.key,pin:revokePreview.body.pin,requestId:'identity-http-00001',idempotencyKey:'revoke-http-000000001',accepted:true,basis:'wrong film for this airing'};
const revokeConfirm=(body,extra)=>call('/api/admin/discovery-recovery/revoke-confirm',{method:'POST',headers:ownerHeaders(extra||'discovery_identity_correct'),body:JSON.stringify(body)});
assert.equal((await call('/api/admin/discovery-recovery/revoke-confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(revokeBody)})).status,403,'no Access assertion, no revoke');
assert.equal((await revokeConfirm({...revokeBody,accepted:false})).body.refusal,'confirmation_missing');
assert.equal((await revokeConfirm({...revokeBody,basis:''})).body.reason,'basis_required');
assert.equal((await revokeConfirm({...revokeBody,pin:'D1.'+'0'.repeat(32)})).body.refusal,'stale_pin');
assert.equal((await revokeConfirm({...revokeBody,idempotencyKey:'identity-http-00001'})).status,400,'the revoke key must be fresh');
assert.equal((await revokeConfirm(revokeBody)).body.refusal,'revoke_schema_not_ready','before 0027 the new kind cannot be stored');
assert.equal(dbRows(),rowsBeforePreview,'a refused confirm writes nothing');
{
 const ddl=fs.readFileSync('migrations/0027_discovery_intent_identity_revoke.sql','utf8').split('\n');
 const from=ddl.findIndex(line=>line.startsWith('CREATE TABLE discovery_intent_v27')),to=ddl.findIndex(line=>line.startsWith('ALTER TABLE discovery_intent_v27'));
 assert.ok(from>0&&to>from);
 const applied=sqliteSync(['-bail',httpDb.file],{input:ddl.slice(from,to+1).join('\n'),encoding:'utf8'});
 assert.equal(applied.status,0,applied.stderr);
}
// An unrelated D1 fault after the migration is a truthful storage_unavailable, never "the migration is missing", and nothing is retried.
{
 const flaky=d1Standin(httpDb.file,{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO discovery_intent/.test(item.text)))throw new Error('D1_ERROR: network connection lost');}});
 const response=await httpContext.worker.fetch(new Request(origin+'/api/admin/discovery-recovery/revoke-confirm',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify(revokeBody)}),{...routeEnv,DB:flaky},{waitUntil(){}});
 const outage=await response.json();
 assert.equal(response.status,503,JSON.stringify(outage));
 assert.equal(outage.refusal,'storage_unavailable');
 assert.equal(count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_intent WHERE idempotency_key='revoke-http-000000001'"),0,'the failed insert left no intent');
}
const revokeConfirmed=await revokeConfirm(revokeBody);
assert.equal(revokeConfirmed.status,200,JSON.stringify(revokeConfirmed.body));
assert.equal(revokeConfirmed.body.command.effect,'revoke');
assert.equal(revokeConfirmed.body.command.revokes.requestId,'identity-http-00001');
assert.equal(one(httpDb.db,"SELECT kind, state FROM discovery_intent WHERE idempotency_key='revoke-http-000000001'").kind,'identity_revoke');
assert.equal((await revokeConfirm(revokeBody)).body.refusal,'idempotency_conflict');
const revokeTamper=await call('/api/admin/discovery-recovery/revoke-execute',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:{...revokeConfirmed.body.confirmation,scopeFingerprint:'00000000'}})});
assert.equal(revokeTamper.status,400,JSON.stringify(revokeTamper.body));
const historyBeforeRevoke=httpDb.db.sql("SELECT * FROM discovery_decision_history WHERE observation_key='"+identityItem.key+"' ORDER BY revision");
const unrelatedBefore=JSON.stringify(httpDb.db.sql("SELECT * FROM discovery_decision WHERE observation_key<>'"+identityItem.key+"' ORDER BY observation_key"));
const revokeExecuted=await call('/api/admin/discovery-recovery/revoke-execute',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:revokeConfirmed.body.confirmation})});
assert.equal(revokeExecuted.status,200,JSON.stringify(revokeExecuted.body));
assert.equal(revokeExecuted.body.replayed,false);
assert.equal(revokeExecuted.body.receipt.capability,'discovery_identity_revoke');
const revoked=(await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key];
assert.equal(revoked.status,'needs_verification');
assert.equal(revoked.tmdbId,null);
assert.equal(revoked.ownerIdentity,undefined);
assert.equal(revoked.revokedOwnerAssign.tmdbId,'41');
assert.equal(revoked.revokedOwnerAssign.requestId,'identity-http-00001');
assert.match(revoked.revokedOwnerAssign.identityBasis,/^[0-9a-f]{64}$/,'the identity basis is recorded as provenance');
assert.equal(httpDb.db.sql("SELECT * FROM discovery_decision_history WHERE observation_key='"+identityItem.key+"' ORDER BY revision").length,historyBeforeRevoke.length+1);
assert.equal(JSON.stringify(httpDb.db.sql("SELECT * FROM discovery_decision WHERE observation_key<>'"+identityItem.key+"' ORDER BY observation_key")),unrelatedBefore,'unrelated decisions are untouched');
assert.equal(one(httpDb.db,"SELECT state FROM discovery_intent WHERE idempotency_key='identity-http-00001'").state,'receipt','the original intent is kept');
assert.equal(count(httpDb.db,'SELECT COUNT(*) AS n FROM film'),0);
const revokeReplay=await call('/api/admin/discovery-recovery/revoke-execute',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:revokeConfirmed.body.confirmation})});
assert.equal(revokeReplay.body.replayed,true,JSON.stringify(revokeReplay.body));
// A confirmation of one capability cannot be executed through the other's route, in either direction.
const crossRevoke=await call('/api/admin/discovery-recovery/identity-correct',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:revokeConfirmed.body.confirmation})});
assert.equal(crossRevoke.status,400,JSON.stringify(crossRevoke.body));
assert.equal(crossRevoke.body.refusal,'unsupported_capability');
const crossIdentity=await call('/api/admin/discovery-recovery/revoke-execute',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation:identityConfirmed.body.confirmation})});
assert.equal(crossIdentity.status,400,JSON.stringify(crossIdentity.body));
assert.equal(crossIdentity.body.refusal,'unsupported_capability');
const revokeReceipt=await call('/api/admin/discovery-recovery/identity-receipt?idempotencyKey=revoke-http-000000001');
assert.equal(revokeReceipt.status,200,JSON.stringify(revokeReceipt.body));
assert.equal(revokeReceipt.body.record.receipt.state,'applied');
const afterRevoke=await call(revokePath);
assert.equal(afterRevoke.body.available,false,'the old action is no longer effective after the revoke');
assert.equal(afterRevoke.body.reason,'already_revoked');
const rowsAfterRevoke=dbRows();
await call(revokePath);
assert.equal(dbRows(),rowsAfterRevoke,'reading again writes nothing');
// ADR 0178, section 3, review of PR 796: a supersede is owner-confirmed through the real routes and bound to the LIVE effective action.
const idView=()=>call('/api/admin/discovery-recovery?key='+encodeURIComponent(identityItem.key));
const idConfirm=async(body,extra)=>call('/api/admin/discovery-recovery/identity-confirm',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({key:identityItem.key,accepted:true,...body,pin:(extra&&extra.pin)||(await idView()).body.pin})});
const idExecute=confirmation=>call('/api/admin/discovery-recovery/identity-correct',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({confirmation})});
const fenced=(await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key];
assert.equal(fenced.revokedOwnerAssign.tmdbId,'41');
// The deliberate override: a fresh owner assign of the same id clears the fence.
const a2=await idConfirm({idempotencyKey:'identity-http-00002',effect:'assign',tmdbId:'41',basis:'снова этот фильм'});
assert.equal(a2.status,200,JSON.stringify(a2.body));
assert.equal((await idExecute(a2.body.confirmation)).status,200);
const assignedAgain=(await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key];
assert.equal(assignedAgain.revokedOwnerAssign,undefined,'only an owner assign of the same id clears the fence');
assert.equal(assignedAgain.ownerIdentity.requestId,'identity-http-00002');
// The Limbo detail offers the revoke entry for a proven saved action, and only then (read-only).
const entryView=await idView();
assert.deepEqual([entryView.body.revoke.requestId,entryView.body.revoke.available,entryView.body.revoke.reason],['identity-http-00002',true,'eligible']);
const entryOld=await call('/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(identityItem.key)+'&requestId=identity-http-00001');
assert.equal(entryOld.body.available,false,'the first, revoked action is not offered again');
// Supersede confirm: invalid, unknown, own key, not effective.
assert.equal((await idConfirm({idempotencyKey:'identity-http-00003',effect:'reject',tmdbId:'41',basis:'b',supersedes:'identity-http-00002'})).status,400);
assert.equal((await idConfirm({idempotencyKey:'identity-http-00003',effect:'reject',tmdbId:'41',basis:'b',supersedes:{requestId:'identity-http-00003'}})).status,400,'a supersede cannot name itself');
const supUnknown=await idConfirm({idempotencyKey:'identity-http-00003',effect:'reject',tmdbId:'41',basis:'b',supersedes:{requestId:'missing-request-00001'}});
assert.deepEqual([supUnknown.status,supUnknown.body.reason],[409,'intent_missing']);
const supOld=await idConfirm({idempotencyKey:'identity-http-00003',effect:'reject',tmdbId:'41',basis:'b',supersedes:{requestId:'identity-http-00001'}});
assert.deepEqual([supOld.status,supOld.body.reason],[409,'old_action_not_effective'],'an original that is not the live action cannot be superseded');
assert.equal(count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_intent WHERE idempotency_key='identity-http-00003'"),0,'a refused confirm stores nothing');
// A valid supersede stores the binding and writes through the ordinary identity writer.
const supConfirmed=await idConfirm({idempotencyKey:'identity-http-00003',effect:'reject',tmdbId:'41',basis:'это не тот фильм',supersedes:{requestId:'identity-http-00002'}});
assert.equal(supConfirmed.status,200,JSON.stringify(supConfirmed.body));
assert.equal(supConfirmed.body.command.supersedes.requestId,'identity-http-00002');
assert.equal(supConfirmed.body.command.supersedes.decisionHash,await Authority.decisionHash(assignedAgain));
assert.match(one(httpDb.db,"SELECT command_json FROM discovery_intent WHERE idempotency_key='identity-http-00003'").command_json,/"supersedes":\{"requestId":"identity-http-00002"/);
const supExecuted=await idExecute(supConfirmed.body.confirmation);
assert.equal(supExecuted.status,200,JSON.stringify(supExecuted.body));
const superseded=(await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key];
assert.deepEqual([superseded.status,superseded.rejectedTmdbIds,superseded.ownerIdentity.requestId],['needs_verification',['41'],'identity-http-00003']);
assert.equal(one(httpDb.db,"SELECT state FROM discovery_intent WHERE idempotency_key='identity-http-00002'").state,'receipt','the superseded intent is kept');
assert.equal((await idExecute(supConfirmed.body.confirmation)).body.replayed,true);
assert.equal((await call('/api/admin/discovery-recovery/revoke-preview?key='+encodeURIComponent(identityItem.key)+'&requestId=identity-http-00002')).body.reason,'old_action_not_effective','the superseded action is no longer effective');
// The original is proven again at execute: if it stopped being the live action after the confirmation, nothing is written.
const supStale=await idConfirm({idempotencyKey:'identity-http-00004',effect:'assign',tmdbId:'41',basis:'вернуть фильм',supersedes:{requestId:'identity-http-00003'}});
assert.equal(supStale.status,200,JSON.stringify(supStale.body));
{
 const live=(await Authority.routeRead(httpEnv,'epg/discovery-resolution.json')).value[identityItem.key];
 const {ownerIdentity,...stripped}=live;
 const hash=await Authority.decisionHash(stripped);
 httpDb.db.sql("UPDATE discovery_decision SET payload_json='"+JSON.stringify(stripped).replace(/'/g,"''")+"', decision_hash='"+hash+"' WHERE observation_key='"+identityItem.key.replace(/'/g,"''")+"'");
}
const historyBeforeStale=count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_decision_history");
const supStaleRun=await idExecute(supStale.body.confirmation);
assert.equal(supStaleRun.status,409,JSON.stringify(supStaleRun.body));
assert.ok(['record_changed','old_action_not_effective','not_eligible'].includes(supStaleRun.body.refusal),supStaleRun.body.refusal);
assert.equal(count(httpDb.db,"SELECT COUNT(*) AS n FROM discovery_decision_history"),historyBeforeStale,'a stale supersede writes nothing');
const policyFilm={id:'tmdb_70',tmdbId:'70',canonicalIdentity:'tmdb:70',title:'A Life',year:2020,genres:['документальный']};
const otherPolicyFilm={id:'tmdb_82',tmdbId:'82',canonicalIdentity:'tmdb:82',title:'Another Life',year:2019,genres:['документальный']};
const unreadPolicyFilm={id:'tmdb_83',tmdbId:'83',canonicalIdentity:'tmdb:83',title:'Unread Queue',year:2018,genres:['документальный']};
const policyLease=await Authority.acquireLease(httpEnv,{programmeRunId:httpEnv.discoveryLease?.programmeRunId||null});
await Authority.replaceCatalog(httpEnv,{tmdb_41:{id:'tmdb_41',tmdbId:'41',canonicalIdentity:'tmdb:41',title:'Яркий берег',year:1999},tmdb_70:policyFilm,tmdb_82:otherPolicyFilm,tmdb_83:unreadPolicyFilm},{lease:policyLease.lease});
await Authority.releaseLease(httpEnv,policyLease.lease);
httpEnv.discoveryLease=null;
const policyPreview=await call('/api/admin/discovery-recovery/policy-exclude?filmId=tmdb_70');
assert.equal(policyPreview.status,200,JSON.stringify(policyPreview.body));
assert.equal(policyPreview.body.available,true);
assert.equal(policyPreview.body.policy,'documentary');
const policyDenied=await call('/api/admin/discovery-recovery/policy-exclude',{method:'POST',headers:ownerHeaders('discovery_identity_correct'),body:JSON.stringify({filmId:'tmdb_70',idempotencyKey:'policy-exclude-00001'})});
assert.equal(policyDenied.status,403);
const coldFill=Array.from({length:20},(_,i)=>'tmdb_fill_'+i);
await httpBucket.put('enrichment/prediction-queue.json',JSON.stringify({
 schemaVersion:3,profileVersion:1,profileHash:'p1',programmeRunId:RUN,refreshedAt:new Date().toISOString(),lastCheckAt:new Date().toISOString(),
 lastBatch:{finishedAt:new Date().toISOString(),stage:'complete',reason:null},hotPending:[],coldPending:[...coldFill,'tmdb_70'],pending:['tmdb_70'],
 priority:{tmdb_70:{rank:2,hot:false}},priorityCount:0,coldRemaining:21,urgentCount:0,retries:{},work:{},
}));
await httpBucket.put('programme.json',JSON.stringify({runId:RUN,updatedAt:new Date().toISOString(),watchlistCount:0,films:[],stats:{}}));
const policyExecuted=await call('/api/admin/discovery-recovery/policy-exclude',{method:'POST',headers:ownerHeaders('catalog_policy_exclude'),body:JSON.stringify({filmId:'tmdb_70',idempotencyKey:'policy-exclude-00001'})});
assert.equal(policyExecuted.status,200,JSON.stringify(policyExecuted.body));
assert.equal(policyExecuted.body.outcome,'written');
assert.equal(policyExecuted.body.queue,'removed');
assert.equal(one(httpDb.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_70'").state,'superseded');
const queued=await (await httpBucket.get('enrichment/prediction-queue.json')).json();
assert.equal((queued.coldPending||[]).includes('tmdb_70'),false);
assert.equal((queued.pending||[]).includes('tmdb_70'),false);
assert.equal(queued.priority.tmdb_70,undefined);
const policyReplay=await call('/api/admin/discovery-recovery/policy-exclude',{method:'POST',headers:ownerHeaders('catalog_policy_exclude'),body:JSON.stringify({filmId:'tmdb_70',idempotencyKey:'policy-exclude-00001'})});
assert.equal(policyReplay.body.replayed,true,JSON.stringify(policyReplay.body));
assert.equal(policyReplay.body.queue,'removed');
const policyCross=await call('/api/admin/discovery-recovery/policy-exclude',{method:'POST',headers:ownerHeaders('catalog_policy_exclude'),body:JSON.stringify({filmId:'tmdb_82',idempotencyKey:'policy-exclude-00001'})});
assert.equal(policyCross.status,409,JSON.stringify(policyCross.body));
assert.equal(policyCross.body.refusal,'idempotency_conflict');
assert.equal(one(httpDb.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_82'").state,'current');
await httpBucket.put('enrichment/prediction-queue.json',JSON.stringify({
 schemaVersion:3,profileVersion:1,profileHash:'p1',programmeRunId:RUN,refreshedAt:new Date().toISOString(),lastCheckAt:new Date().toISOString(),
 lastBatch:{finishedAt:new Date().toISOString(),stage:'complete',reason:null},hotPending:[],coldPending:['tmdb_83'],pending:['tmdb_83'],
 priority:{tmdb_83:{rank:2,hot:false}},priorityCount:0,coldRemaining:1,urgentCount:0,retries:{},work:{},
}));
denyQueueAfterPut=true;
const policyUnread=await call('/api/admin/discovery-recovery/policy-exclude',{method:'POST',headers:ownerHeaders('catalog_policy_exclude'),body:JSON.stringify({filmId:'tmdb_83',idempotencyKey:'policy-exclude-00002'})});
denyQueueAfterPut=false;denyQueueGet=false;
assert.equal(policyUnread.status,409,JSON.stringify(policyUnread.body));
assert.equal(policyUnread.body.refusal,'queue_unreconciled');
assert.equal(policyUnread.body.queue,'unknown');
assert.equal(one(httpDb.db,"SELECT state FROM discovery_admission WHERE film_id='tmdb_83'").state,'superseded');

const hour=3600000,catalogNow=Date.now();
const catalogShow=start=>({channelId:'c1',channel:'One',start,end:start+2*hour});
const catalogFilm=(id,tmdbId,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,original:'Original '+id,year:1999,runtime:100,genres:['Драма'],poster:'https://image.tmdb.org/t/p/w342/'+id+'.jpg',url:'https://www.themoviedb.org/movie/'+tmdbId,directors:[{id:'tmdb_director/1',name:'Director',original:'Director'}],actors:[{id:'tmdb_actor/2',name:'Actor',original:'Actor'}],shows:[catalogShow(catalogNow-hour)],showsProgrammeRunId:RUN,discoveredAt:new Date(catalogNow).toISOString(),...extra});
const d1Film=catalogFilm('tmdb_77',77,{title:'Только в D1'});
const tvFilm={id:'tmdb_tv_88',tmdbId:'88',canonicalIdentity:'tmdb_tv:88',title:'Сериал',year:1999,runtime:40,shows:[catalogShow(catalogNow-hour)],showsProgrammeRunId:RUN};
const decoy=catalogFilm('tmdb_99',99,{title:'Только в R2'});
const catalogLease=await Authority.acquireLease(httpEnv,{programmeRunId:RUN});
await Authority.replaceCatalog(httpEnv,{[d1Film.id]:d1Film,[tvFilm.id]:tvFilm}, {lease:catalogLease.lease});
await Authority.releaseLease(httpEnv,catalogLease.lease);
const prediction={predictedRating:4.5,probability4Plus:.74,confidence:'high',matchSignals:['Investigation'],mainRisk:'Slow start',moodLabels:['мрачный','напряжённый'],tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1};
const catalogIndexed={prediction,fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1},fingerprint:{fingerprintHash:'f',plotMechanics:['investigation'],moodLabels:['мрачный'],execution:{payoff:'strong',pacing:'unknown'}}};
await httpBucket.put('epg/generations/'+RUN+'/programme.json',JSON.stringify({runId:RUN,updatedAt:new Date(catalogNow).toISOString(),watchlistCount:0,films:[],stats:{}}));
await httpBucket.put('epg/generations/'+RUN+'/discovered-films.json',JSON.stringify({[decoy.id]:decoy}));
await httpBucket.put('epg/discovered-films.json',JSON.stringify({[decoy.id]:decoy}));
await httpBucket.put('enrichment/profile/current.json',JSON.stringify({version:1,profileHash:'p1'}));
await httpBucket.put('enrichment/view-index.json',JSON.stringify({tmdb_77:catalogIndexed,tmdb_99:catalogIndexed,tmdb_tv_88:catalogIndexed}));
const storedCatalog=await Authority.routeRead(httpEnv,'epg/discovered-films.json');
assert.deepEqual(Object.keys(storedCatalog.value||{}).sort(),['tmdb_77','tmdb_tv_88'],JSON.stringify(storedCatalog.value?.tmdb_77));
httpReads.length=0;
const offered=await call('/api/catalog/available');
assert.equal(offered.status,200,JSON.stringify(offered.body));
assert.deepEqual(offered.body.films.map(film=>film.id),['tmdb_77'],JSON.stringify({profile:offered.body.profile,exclusion:offered.body.displayExclusion,total:offered.body.total}));
assert.equal(offered.body.films[0].canonicalIdentity,'tmdb:77');
assert.equal(httpReads.some(key=>key.endsWith('discovered-films.json')),false);
const otherRun='22222222-2222-4222-8222-222222222222';
await httpBucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:otherRun}));
await httpBucket.put('epg/generations/'+otherRun+'/programme.json',JSON.stringify({runId:otherRun,updatedAt:new Date(catalogNow).toISOString(),watchlistCount:0,films:[],stats:{}}));
await httpBucket.put('epg/generations/'+otherRun+'/discovered-films.json',JSON.stringify({[decoy.id]:{...decoy,showsProgrammeRunId:otherRun}}));
const mismatched=await call('/api/catalog/available');
assert.equal(mismatched.status,409,JSON.stringify(mismatched.body));
assert.equal(mismatched.body.error,'Catalog generation copy is not in place');

const recovered=migrated();
open(recovered.db);
const recoveredEnv=envFor(recovered.db);
const originalLease=await Authority.acquireLease(recoveredEnv,{programmeRunId:null});
recoveredEnv.discoveryLease=originalLease.lease;
await Authority.replaceLedger(recoveredEnv,{programmeRunId:'run-old',items:[item]});
const partialRows=Array.from({length:20},(_,index)=>({...item,key:'part-'+String(index).padStart(2,'0'),title:'P'+index}));
await assert.rejects(()=>Authority.ingestLedger(recoveredEnv,{programmeRunId:'run-new',handoff:true,lease:originalLease.lease,items:(async function*(){for(const row of partialRows)yield row;throw new Error('killed');})()}),error=>error.code==='discovery_unavailable');
assert.equal(one(recovered.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'loading');
assert.equal(one(recovered.db,"SELECT programme_run_id FROM discovery_authority WHERE id=1").programme_run_id,'run-old');
await assert.rejects(()=>Authority.routeRead(recoveredEnv,'epg/discovery-latest.json'),error=>error.code==='discovery_incomplete');
const flushed=count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='active' AND residence='active'");
assert.equal(flushed>0&&flushed<partialRows.length,true,'flushed '+flushed);
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='part-00' AND residence='active'"),1);
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='part-19'"),0);
await assert.rejects(()=>Authority.acquireLease(recoveredEnv,{programmeRunId:'run-old'}),error=>error.code==='discovery_incomplete');
assert.equal(one(recovered.db,'SELECT lease_id FROM discovery_lease WHERE id=1').lease_id,originalLease.lease.id);
recovered.db.sql('UPDATE discovery_lease SET expires_at='+(Date.now()-1000)+' WHERE id=1');
await assert.rejects(()=>Authority.ingestLedger(recoveredEnv,{programmeRunId:'run-new',handoff:true,lease:originalLease.lease,items:(async function*(){yield partialRows[0];})()}),error=>error.code==='discovery_incomplete');
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='active' AND residence='active'"),flushed);
assert.equal(one(recovered.db,"SELECT programme_run_id FROM discovery_authority WHERE id=1").programme_run_id,'run-old');
const successorLease=await Authority.acquireLease(recoveredEnv,{programmeRunId:'run-old'});
assert.ok(successorLease.lease);
assert.notEqual(successorLease.lease.id,originalLease.lease.id);
await assert.rejects(()=>Authority.ingestLedger(recoveredEnv,{programmeRunId:'run-new',handoff:true,lease:originalLease.lease,items:(async function*(){yield {...item,key:'stale-during'};})()}),error=>error.code==='discovery_incomplete');
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='stale-during'"),0);
const sealReplay=[{...item,key:'kept-a'},{...item,key:'kept-b'}];
await Authority.ingestLedger(recoveredEnv,{programmeRunId:'run-next',handoff:true,lease:successorLease.lease,items:(async function*(){for(const row of sealReplay)yield row;})()});
const sealLedger=await Authority.routeRead(recoveredEnv,'epg/discovery-latest.json');
assert.deepEqual(sealLedger.value.items.map(row=>row.key).sort(),['kept-a','kept-b']);
assert.equal(sealLedger.value.programmeRunId,'run-next');
assert.equal(one(recovered.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'committed');
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='part-00' AND residence='active'"),0);
await assert.rejects(()=>Authority.replaceLedger(recoveredEnv,{programmeRunId:'run-stale',items:[{...item,key:'stale-only'}]},{lease:originalLease.lease}),error=>error.code==='discovery_fence');
assert.deepEqual((await Authority.routeRead(recoveredEnv,'epg/discovery-latest.json')).value.items.map(row=>row.key).sort(),['kept-a','kept-b']);
assert.equal(count(recovered.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='stale-only'"),0);

const blockedLoad=migrated();
open(blockedLoad.db);
blockedLoad.db.sql("UPDATE discovery_authority SET programme_run_id='run-old', published_programme_run_id='run-old' WHERE id=1");
blockedLoad.db.sql("UPDATE discovery_transfer SET state='loading', programme_run_id='run-old' WHERE id=1");
blockedLoad.db.sql("UPDATE discovery_lease SET lease_id='gone', expires_at=0 WHERE id=1");
await assert.rejects(()=>Authority.acquireLease(envFor(blockedLoad.db),{programmeRunId:'run-old'}),error=>error.code==='discovery_incomplete');
await assert.rejects(()=>Authority.routeRead(envFor(blockedLoad.db),'epg/discovery-latest.json'),error=>error.code==='discovery_incomplete');

const published=migrated();
open(published.db);
const publishedInner=new MemoryBucket();
let failDiscoveryPut=true;
const publishedBucket={
 async get(key){return publishedInner.get(key);},
 async head(key){return publishedInner.head(key);},
 async delete(key){return publishedInner.delete(key);},
 async list(options){return publishedInner.list(options);},
 async put(key,body,options){
  if(body&&typeof body.getReader==='function'){
   const reader=body.getReader();
   const chunks=[];
   let seen=0;
   while(true){
    const step=await reader.read();
    if(step.done)break;
    seen++;
    if(failDiscoveryPut&&key.endsWith('/discovery-latest.json')&&seen>=30){failDiscoveryPut=false;throw new Error('put failed');}
    chunks.push(Buffer.from(step.value));
   }
   return publishedInner.put(key,Buffer.concat(chunks).toString('utf8'),options);
  }
  return publishedInner.put(key,body,options);
 },
};
const publishedEnv=envFor(published.db,publishedBucket);
const seedLease=await Authority.acquireLease(publishedEnv,{programmeRunId:null});
publishedEnv.discoveryLease=seedLease.lease;
await Authority.replaceLedger(publishedEnv,{programmeRunId:'run-old',items:[{...item,key:'obs-old',title:'Old Recovered Film',year:1981}]});
await Authority.releaseLease(publishedEnv,seedLease.lease);
publishedEnv.discoveryLease=null;
const previousLedger={programmeRunId:'run-old',items:[{key:'old-recovered-film|1981',title:'Old Recovered Film',normalizedTitle:'old recovered film',year:1981,durations:[90],shows:[{channelId:'c',start:5,end:9}]}]};
await publishedInner.put('epg/published-generation.json',JSON.stringify({programmeRunId:'run-old',phase:'published'}));
await publishedInner.put('epg/generations/run-old/discovery-latest.json',JSON.stringify(previousLedger));
const partialLatest=Array.from({length:20},(_,index)=>({title:'Partial Recovered '+String(index).padStart(2,'0'),year:2000+index,durations:[80],shows:[{channelId:'c',start:10+index,end:20+index}]}));
await assert.rejects(()=>httpContext.publishEpgGeneration(publishedEnv,'run-pub',{},{latest:partialLatest,meta:{programmeRunId:'run-pub'},mode:'full',holder:{discovery:partialLatest}}),error=>error.message==='put failed');
assert.equal(JSON.parse(await (await publishedInner.get('epg/published-generation.json')).text()).programmeRunId,'run-old');
assert.equal(one(published.db,"SELECT programme_run_id FROM discovery_authority WHERE id=1").programme_run_id,'run-old');
assert.equal(one(published.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'loading');
await assert.rejects(()=>Authority.routeRead(publishedEnv,'epg/discovery-latest.json'),error=>error.code==='discovery_incomplete');
const publishedFlush=count(published.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE source_key='active' AND residence='active'");
assert.equal(publishedFlush>0&&publishedFlush<21,true,'published flush '+publishedFlush);
const interrupted=one(published.db,'SELECT lease_id, expires_at FROM discovery_lease WHERE id=1');
assert.equal(Number(interrupted.expires_at)<=Date.now(),true);
const keptLatest=[{title:'Kept Recovered Alpha',year:2011,durations:[90],shows:[{channelId:'c',start:30,end:40}]},{title:'Kept Recovered Beta',year:2012,durations:[90],shows:[{channelId:'c',start:50,end:60}]}];
await httpContext.publishEpgGeneration(publishedEnv,'run-next',{},{latest:keptLatest,meta:{programmeRunId:'run-next'},mode:'full',holder:{discovery:keptLatest}});
const publishedLedger=await Authority.routeRead(publishedEnv,'epg/discovery-latest.json');
assert.equal(publishedLedger.value.programmeRunId,'run-next');
assert.equal(publishedLedger.value.items.length,3,JSON.stringify(publishedLedger.value.items.map(row=>row.key)));
assert.equal(publishedLedger.value.items.some(row=>String(row.title||'').startsWith('Partial Recovered')),false);
assert.equal(publishedLedger.value.items.filter(row=>String(row.title||'').startsWith('Kept Recovered')).length,2);
assert.equal(one(published.db,"SELECT state FROM discovery_transfer WHERE id=1").state,'committed');
assert.equal(JSON.parse(await (await publishedInner.get('epg/published-generation.json')).text()).programmeRunId,'run-next');
const servedKeys=publishedLedger.value.items.map(row=>row.key).sort();
await assert.rejects(()=>Authority.ingestLedger(publishedEnv,{programmeRunId:'run-stale',handoff:true,lease:{id:interrupted.lease_id,expiresAt:0},items:(async function*(){yield {...item,key:'stale-only'};})()}),error=>error.code==='discovery_fence');
assert.deepEqual((await Authority.routeRead(publishedEnv,'epg/discovery-latest.json')).value.items.map(row=>row.key).sort(),servedKeys);
assert.equal(count(published.db,"SELECT COUNT(*) AS n FROM discovery_observation WHERE observation_key='stale-only'"),0);
