// ADR 0185 stage 2: the Worker's dormant integration of the EPG checkpoint (the façade of loadJSON / saveJSON for `sync.json` and `watchlist-ingest.json`, the d1 branch of
// beginSync and of the two completion routes). The real src/worker.js and the real repository run in a vm over a sqlite D1 stand-in with the real migration chain and a recording
// R2 stand-in; the unrelated collaborators of beginSync and finishSync are replaced by recorders. Nothing here calls a production database, bucket, Cloudflare or Letterboxd.
// The point of the file: with the tables absent or the marker `r2` the Worker does exactly what it did before (R2 objects, the old order); only a `d1` marker moves the two keys.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-checkpoint-worker-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');sqlite(base,chain('9999'));
const legacyBase=path.join(root,'legacy.sqlite');sqlite(legacyBase,chain('0029_started_authority.sql'));
const T='2026-11-20T10:00:00.000Z';
const DOCS="INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"external\",\"target\":null,\"epoch\":0,\"drain\":null}',1,'"+T+"');INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"holder\":\"h1\",\"kind\":\"executor\",\"modeRevision\":1,\"released\":false,\"expiresAt\":\"2099-01-01T00:00:00.000Z\"}',1,'"+T+"');";
let copies=0;
const database=(marker,{from=base}={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(from,file);sqlite(file,(from===base?DOCS:'')+marker);return {file,db:d1Standin(file)};};
const D1='UPDATE epg_checkpoint_authority SET mode=\'d1\',generation=1 WHERE id=1;';

// ---- the Worker in a vm ----
const records=new Map();let puts=[],gets=[];
const bucket={
 get:async key=>{gets.push(key);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null;},
 put:async(key,value)=>{puts.push(key);records.set(key,JSON.parse(value));return {etag:'e'};},
 delete:async key=>{puts.push('delete:'+key);records.delete(key);},
 list:async()=>({objects:[],truncated:false}),
};
const calls=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,WeakMap,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console:{...console,log:()=>{}},setTimeout});
// the collaborators of beginSync: a watchlist of two films, no cache, no ratings gate. They are stubs of the unrelated modules, not of the checkpoint.
vm.runInContext("globalThis.MetadataCache={loadMetadataWorkingSet:async()=>({records:{}}),mergeWatchlistFilm:(film,cached)=>({...film,...(cached||{})}),metadataPending:()=>true};",context);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(fs.readFileSync('src/sources.js','utf8'),context);
vm.runInContext(scoped('src/epg-checkpoint-d1.js','EpgCheckpointD1'),context);
vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
vm.runInContext(fs.readFileSync('src/epg-orchestration.js','utf8'),context);
const run=code=>vm.runInContext(code,context);
const load=(env,key)=>run('loadJSON')(env,key),save=(env,key,value)=>run('saveJSON')(env,key,value);
const sourceStubs=(fail=null)=>{
 context.getHTML=async()=>{if(fail)throw new Error(fail);return '<html></html>';};
 context.parseWatchlist=()=>({total:2,films:[{id:'film-a',title:'A'},{id:'film-b',title:'B'}],next:null});
 context.sourceConfig=()=>({watchlist:'https://letterboxd.example/u/watchlist/',letterboxdUsername:'u'});
 context.requirePausePresence=async()=>false;context.sealedPublishAvailable=async()=>false;context.ratingsGate=async()=>({active:false});
};
const reset=()=>{records.clear();puts=[];gets=[];calls.length=0;};
const step=(extra={})=>({epgStep:{holder:'h1',modeRevision:1},epgFence:{revision:1},...extra});
const runRow=file=>rows(file,'SELECT run_id,stage,seal_phase,queue_attempted,watchlist_present,film_count,revision FROM epg_checkpoint_run')[0];
const counts=file=>rows(file,'SELECT (SELECT COUNT(*) FROM epg_checkpoint_run) AS run,(SELECT COUNT(*) FROM epg_checkpoint_film) AS film,(SELECT COUNT(*) FROM epg_ingest_status) AS ingest')[0];
const code=promise=>promise.then(()=>null,error=>error.code||String(error.message));
const repo=()=>run('EpgCheckpointD1');
const ctxOf=(extra={})=>({step:{holder:'h1',modeRevision:1},fence:{revision:1},leaseBound:new Date(Date.now()+5000).toISOString(),now:Date.now(),...extra});
const seedRun=async(env,id='run-1',stage='metadata')=>{
 const body={runId:id,startedAt:T,runKey:'2026-11-20',updatedAt:T,stage,watchlist:[{id:'film-a'},{id:'film-b'}],pending:['film-a'],cursor:0,remaining:1,failures:[]};
 const out=await repo().createRun(env,body,{...ctxOf(),attempt:{id:'seed-'+id,startedAt:T}});assert.equal(out.ok,true,JSON.stringify(out));
};

// ===== 1. the façade at each marker state =====
{
 // AIR-551 H6: the R2 arm is retired for production. Without the explicit local stand-in, tables absent below version 30 and the marker `r2` are closed.
 // legacy (local stand-in only): the tables do not exist and the schema is below 30 -> the R2 objects serve, byte for byte as before
 const {file,db}=database('',{from:legacyBase});const env={DB:db,BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'};reset();
 assert.equal(await load(env,'sync.json'),null);assert.deepEqual(gets,['sync.json']);
 await save(env,'sync.json',{runId:'r',stage:'epg'});await save(env,'watchlist-ingest.json',{schemaVersion:1,failedAt:null,lastSuccessAt:T});
 assert.deepEqual(puts,['sync.json','watchlist-ingest.json']);assert.deepEqual(await load(env,'sync.json'),{runId:'r',stage:'epg'});
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'epg_checkpoint%'")[0].n,0);
 // the same legacy database WITHOUT the stand-in is closed and never touches R2
 // (a fresh binding: the marker is cached for two seconds per binding)
 const prodLegacy=database('',{from:legacyBase});reset();
 assert.equal(await code(load({DB:prodLegacy.db,BUCKET:bucket},'sync.json')),'epg_checkpoint_unavailable','production does not serve the R2 objects below schema 30');
 assert.equal(await code(save({DB:prodLegacy.db,BUCKET:bucket},'sync.json',{runId:'x'})),'epg_checkpoint_unavailable');assert.deepEqual(gets.concat(puts),[]);
 // r2 marker, local stand-in: the same
 const r2=database('');const r2env={DB:r2.db,BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'};reset();
 await save(r2env,'sync.json',{runId:'r2',stage:'epg'});assert.deepEqual(puts,['sync.json']);assert.deepEqual(counts(r2.file),{run:0,film:0,ingest:0});
 // r2 marker, production: closed, reads and writes refused, R2 never touched
 const prodR2=database('');reset();
 assert.equal(await code(load({DB:prodR2.db,BUCKET:bucket},'sync.json')),'epg_checkpoint_unavailable','marker r2 is retired: closed');
 assert.equal(await code(load({DB:prodR2.db,BUCKET:bucket},'watchlist-ingest.json')),'epg_checkpoint_unavailable');
 assert.equal(await code(save({DB:prodR2.db,BUCKET:bucket},'sync.json',{runId:'x'})),'epg_checkpoint_unavailable');assert.deepEqual(gets.concat(puts),[]);
 // r2 marker with writes held (the import fence, local stand-in): reads serve, every write refuses and writes nothing
 const held=database("UPDATE epg_checkpoint_authority SET writes='held',generation=1 WHERE id=1;");const heldEnv={DB:held.db,BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'};reset();set:records.set('sync.json',{runId:'old',stage:'complete'});
 assert.deepEqual(await load(heldEnv,'sync.json'),{runId:'old',stage:'complete'});
 assert.equal(await code(save(heldEnv,'sync.json',{runId:'x'})),'epg_checkpoint_writes_held');assert.equal(await code(save(heldEnv,'watchlist-ingest.json',{})),'epg_checkpoint_writes_held');assert.deepEqual(puts,[]);
 // closed: version 30 without the tables, a deleted marker row, no binding at all: refused, never R2
 const noTables=database("UPDATE schema_contract SET version=30 WHERE id=1;",{from:legacyBase});reset();
 assert.equal(await code(load({DB:noTables.db,BUCKET:bucket},'sync.json')),'epg_checkpoint_unavailable');
 const gone=database('DELETE FROM epg_checkpoint_authority;');assert.equal(await code(load({DB:gone.db,BUCKET:bucket},'watchlist-ingest.json')),'epg_checkpoint_unavailable');
 assert.equal(await code(load({BUCKET:bucket},'sync.json')),'epg_checkpoint_unavailable','no binding and no stand-in is closed');
 assert.equal(await code(save({BUCKET:bucket},'sync.json',{})),'epg_checkpoint_unavailable');
 assert.deepEqual(gets.concat(puts),[],'a closed state never touches R2');
 reset();assert.equal(await load({BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'},'sync.json'),null);assert.deepEqual(gets,['sync.json'],'the explicit local stand-in serves R2');
 // other keys are untouched by the façade
 reset();assert.equal(await load({BUCKET:bucket},'ui/other.json'),null);assert.deepEqual(gets,['ui/other.json']);
}

// ===== 2. d1: the two keys are the rows, R2 is neither read nor written =====
{
 const {file,db}=database(D1);const env={DB:db,BUCKET:bucket};reset();
 assert.equal(await load(env,'sync.json'),null,'no run yet');assert.equal(await load(env,'watchlist-ingest.json'),null);
 await seedRun(env);
 const loaded=await load(env,'sync.json');
 assert.equal(loaded.runId,'run-1');assert.deepEqual(JSON.parse(JSON.stringify(loaded.watchlist)),[{id:'film-a'},{id:'film-b'}]);
 assert.deepEqual((await load(env,'watchlist-ingest.json')).lastSuccessAt,T);
 loaded.cursor=1;loaded.stage='epg';loaded.updatedAt='2026-11-20T10:01:00.000Z';
 await save(step({DB:db,BUCKET:bucket}),'sync.json',loaded);
 assert.equal((await load(env,'sync.json')).cursor,1);assert.equal(runRow(file).revision,2);
 assert.deepEqual(gets.concat(puts),[],'the whole exchange never touched R2');
 // refusals
 assert.equal(await code(save(env,'sync.json',loaded)),'epg_checkpoint_unfenced','no step, no write');
 assert.equal(await code(save(step({DB:db,BUCKET:bucket}),'watchlist-ingest.json',{})),'epg_checkpoint_route','the ingest status is written only by run creation and the failure recorder');
 const completing=await load(env,'sync.json');completing.stage='complete';
 assert.equal(await code(save(step({DB:db,BUCKET:bucket}),'sync.json',completing)),'epg_checkpoint_complete_route','a run reaches complete only through completeCheckpointRun');
 assert.equal(await code(save(step({DB:db,BUCKET:bucket}),'sync.json',{...completing,stage:'epg'})),'epg_checkpoint_unbased','an object that was never loaded is refused');
 assert.equal(runRow(file).stage,'epg');
 // a corrupted row fails closed with its own code, never an R2 read
 sqlite(file,'DELETE FROM epg_checkpoint_film WHERE ordinal=1');
 assert.equal(await code(load(env,'sync.json')),'epg_checkpoint_malformed');
 assert.deepEqual(gets.concat(puts),[]);
 // the failure classes of the orchestrator
 const classify=run('EpgOrchestration.classifyThrown');
 for(const [reason,expected] of [['conflict','epoch_mismatch'],['unavailable','d1_unavailable'],['malformed','checkpoint_malformed'],['indeterminate','evidence_unreadable'],['writes_held','authority_held']])assert.equal(classify({code:'epg_checkpoint_'+reason,message:'epg_checkpoint_'+reason}),expected,reason);
}

// ===== 3. beginSync =====
{
 // d1: run creation and the ingest success are one batch; no R2 object for either key
 const {file,db}=database(D1);const env={DB:db,BUCKET:bucket};reset();sourceStubs();
 const started=await run('beginSync')(step(env));
 assert.equal(started.watchlistCount,2);assert.equal(started.stage,'metadata');
 assert.deepEqual(counts(file),{run:1,film:2,ingest:1});
 assert.equal(runRow(file).run_id,started.runId);
 const ingest=rows(file,'SELECT last_success_at,failed_at,code,consecutive_failures FROM epg_ingest_status')[0];
 assert.equal(ingest.failed_at,null);assert.equal(ingest.consecutive_failures,0);assert.equal(typeof ingest.last_success_at,'string');
 assert.deepEqual(gets.concat(puts),[],'no R2 read or write for the checkpoint');
 // a second start inside the freshness window continues the same run
 assert.equal((await run('beginSync')(step(env))).runId,started.runId);assert.equal(runRow(file).revision,1,'nothing was written');
 // a failed fetch: the failure is recorded in D1, ordered by the attempt, and the original error is rethrown
 sourceStubs('Letterboxd HTTP 503');
 {const cur=await load(env,'sync.json');cur.stage='complete';cur.completedAt=T;cur.updatedAt=T;delete cur.watchlist;delete cur.pending;assert.equal((await repo().completeRun(env,cur,{...ctxOf(),queueAttempted:true})).ok,true);}
 await assert.rejects(run('beginSync')(step(env)),/Letterboxd HTTP 503/);
 const failed=rows(file,'SELECT failed_at,code,consecutive_failures,last_success_at FROM epg_ingest_status')[0];
 assert.equal(failed.code,'watchlist_failed');assert.equal(failed.consecutive_failures,1);assert.equal(failed.last_success_at,ingest.last_success_at,'the last success is never lowered: the later of the previous complete run and the stored success');
 assert.deepEqual(gets.concat(puts),[]);
 // a step-less start in d1 mode is refused after the fetch, never an unfenced write, and it is a recorded failure like any other
 sourceStubs();
 await assert.rejects(run('beginSync')(env),error=>error.code==='epg_checkpoint_unfenced');
 assert.equal(rows(file,'SELECT consecutive_failures FROM epg_ingest_status')[0].consecutive_failures,2);
 assert.equal(runRow(file).stage,'complete','the refused start created nothing');
 // r2 (the local stand-in only, AIR-551 H6): the old two writes, in the old order, with the old shapes
 const old=database('');const oldEnv={DB:old.db,BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'};reset();sourceStubs();
 const oldStart=await run('beginSync')(oldEnv);
 assert.deepEqual(puts,['sync.json','watchlist-ingest.json']);
 assert.deepEqual(records.get('watchlist-ingest.json'),{schemaVersion:1,failedAt:null,lastSuccessAt:records.get('sync.json').startedAt});
 assert.equal(records.get('sync.json').runId,oldStart.runId);assert.equal(counts(old.file).run,0);
 reset();sourceStubs('boom');
 await assert.rejects(run('beginSync')(oldEnv),/boom/);
 assert.equal(records.get('watchlist-ingest.json').code,'watchlist_failed');assert.deepEqual(puts,['watchlist-ingest.json']);
}

// ===== 4. the completion routes =====
const stubs=()=>{
 const order=[];
 context.finishSyncPersist=async()=>{order.push('persist');};
 context.prepareEpgCompletion=async()=>{order.push('prepare');};
 context.flushEpgEvent=async()=>{order.push('flush_epg');};context.flushWatchlistEvent=async()=>{order.push('flush_watchlist');};
 context.refreshPredictionQueue=async()=>{order.push('queue');};
 context.tracedPhase=async(runId,phase,work)=>work();
 return order;
};
{
 // d1: the queue is attempted BEFORE completion, completion is one batch, then the flushes
 const {file,db}=database(D1);const env=step({DB:db,BUCKET:bucket});reset();
 await seedRun(env);
 const order=stubs();
 const seen=[];
 context.flushEpgEvent=async()=>{order.push('flush_epg');seen.push(runRow(file).stage);};
 const loaded=await load(env,'sync.json');
 const out=await run('finishSync')(env,loaded,{updatedAt:T,watchlistCount:2,stats:{}});
 assert.deepEqual(order,['persist','prepare','queue','flush_epg','flush_watchlist'],'the queue refresh comes before completion in d1 mode');
 assert.deepEqual(seen,['complete'],'the checkpoint is complete before the first flush');
 assert.deepEqual([runRow(file).stage,runRow(file).queue_attempted,runRow(file).watchlist_present,counts(file).film],['complete',1,0,0]);
 assert.equal(out.stage,'complete');assert.equal(out.certificate,'skipped','no pause table or frozen day in this stub world: completed, not certified');
 assert.deepEqual(gets.concat(puts),[],'no R2 write of sync.json');
 // an error of the queue refresh stays best-effort: recorded, and the run still completes
 const second=database(D1);const env2=step({DB:second.db,BUCKET:bucket});await seedRun(env2);stubs();
 context.refreshPredictionQueue=async()=>{throw Object.assign(new Error('queue exploded'),{guard:'g'});};
 const loaded2=await load(env2,'sync.json');
 await run('finishSync')(env2,loaded2,{updatedAt:T,watchlistCount:2,stats:{}});
 assert.equal(runRow(second.file).stage,'complete');
 assert.match((await load(env2,'sync.json')).enrichmentQueueError,/queue exploded:g/);
 // a refused completion (the lease was taken) throws and writes nothing
 const third=database(D1);const env3=step({DB:third.db,BUCKET:bucket});await seedRun(env3);stubs();
 const loaded3=await load(env3,'sync.json');
 sqlite(third.file,"UPDATE epg_orchestration_document SET body=json_set(body,'$.holder','other') WHERE key='lease'");
 assert.equal(await code(run('finishSync')(env3,loaded3,{updatedAt:T,watchlistCount:2,stats:{}})),'epg_checkpoint_conflict');
 assert.equal(runRow(third.file).stage,'metadata');
 // r2 (the local stand-in only): complete is saved FIRST, the queue refresh follows, exactly the old order
 const old=database('');const oldEnv={DB:old.db,BUCKET:bucket,EPG_CHECKPOINT_DB_OPTIONAL:'standin'};reset();
 const oldOrder=stubs();
 context.refreshPredictionQueue=async()=>{oldOrder.push('queue@'+(records.get('sync.json')?.stage||'none'));};
 await run('finishSync')(oldEnv,{runId:'r',stage:'epg',startedAt:T,updatedAt:T,watchlist:[{id:'a'}],pending:[]},{updatedAt:T,watchlistCount:1,stats:{}});
 assert.deepEqual(oldOrder,['persist','prepare','flush_epg','flush_watchlist','queue@complete'],'r2 mode keeps the old order: complete first, queue after');
 assert.equal(records.get('sync.json').stage,'complete');assert.equal(counts(old.file).run,0);
}
{
 // the seal route: one completion call replaces the R2 save and the separate certify call, only in d1 mode
 const worker=fs.readFileSync('src/worker.js','utf8');
 const queue=worker.slice(worker.indexOf('async function sealQueueStep'),worker.indexOf('// ADR 0074, ADR 0161'));
 assert.match(queue,/state==='d1'\)certificate=await completeCheckpointRun\(env,run\);\s*else\{await saveJSON\(env,'sync\.json',run\);certificate=await certifyCompletedRun\(env,run\);\}/,'d1 completes once; r2 keeps the save then the certify call');
 assert.ok(queue.indexOf("'queue',work")>=0||queue.indexOf("phase:'queue'")>=0,'the queue refresh unit still runs before completion');
 assert.ok(queue.indexOf('completeCheckpointRun')>queue.indexOf('refreshPredictionQueue'),'completion follows the refresh');
 // only the two completion functions set stage complete
 const sets=[...worker.matchAll(/\.stage='complete'/g)].length;
 assert.equal(sets,3,'only two functions set stage complete: sealQueueStep once and finishSync twice (its d1 branch and its unchanged r2 line); each routes d1 through completeCheckpointRun');
 for(const route of [queue,worker.slice(worker.indexOf('async function finishSync'),worker.indexOf('async function finishSync')+2600)])assert.match(route,/completeCheckpointRun/);
 // dormancy: nothing in the Worker names the migration or the marker table outside the repository
 assert.ok(!/epg_checkpoint_authority|epg_ingest_status/.test(worker),'the Worker reaches the tables only through EpgCheckpointD1');
 assert.ok(!/env\.DB\b/.test(worker));
}
console.log('EPG checkpoint Worker integration (ADR 0185): façade at legacy, r2, held, closed and d1; beginSync success, failure and unfenced; finishSync order in d1 and r2; seal route wiring');
