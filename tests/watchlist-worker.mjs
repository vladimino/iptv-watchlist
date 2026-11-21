// ADR 0186 (AIR-569): the Worker's DORMANT integration of the Watchlist authority. The real src/worker.js and the real repository run in a vm over a sqlite D1 stand-in with the real migration
// chain and a recording R2 stand-in; the unrelated collaborators of beginSync are recorders. Nothing here calls a production database, bucket, Cloudflare or Letterboxd.
// The point of the file: with the tables absent, the marker `epg`, or no binding, the Worker does exactly what it did before (the EPG run fetches Letterboxd and keeps its scan); only a `d1`
// marker replaces the fetch by one read of the last complete snapshot, with no Letterboxd HTTP and no scan, retention, removal hand-over or watchlist Event in the EPG run.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Watchlist from '../src/watchlist-d1.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-watchlist-worker-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');sqlite(base,chain('9999'));
const legacyBase=path.join(root,'legacy.sqlite');sqlite(legacyBase,chain('0030_epg_checkpoint_authority.sql'));
const T='2026-11-21T10:00:00.000Z';
const DOCS="INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"external\",\"target\":null,\"epoch\":0,\"drain\":null}',1,'"+T+"');INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','{\"holder\":\"h1\",\"kind\":\"executor\",\"modeRevision\":1,\"released\":false,\"expiresAt\":\"2099-01-01T00:00:00.000Z\"}',1,'"+T+"');";
let copies=0;
const database=(marker,{from=base}={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(from,file);sqlite(file,DOCS+marker);return {file,db:d1Standin(file)};};
const D1="UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";

const records=new Map();let puts=[],fetches=[];
const bucket={
 get:async key=>records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key))}:null,
 put:async(key,value)=>{puts.push(key);records.set(key,JSON.parse(value));return {etag:'e'};},
 delete:async key=>{puts.push('delete:'+key);records.delete(key);},
 list:async()=>({objects:[],truncated:false}),
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,WeakMap,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console:{...console,log:()=>{}},setTimeout});
vm.runInContext("globalThis.MetadataCache={loadMetadataWorkingSet:async()=>({records:{}}),mergeWatchlistFilm:(film,cached)=>({...film,...(cached||{})}),metadataPending:()=>false};",context);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(fs.readFileSync('src/sources.js','utf8'),context);
vm.runInContext(scoped('src/epg-checkpoint-d1.js','EpgCheckpointD1'),context);
vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
vm.runInContext(scoped('src/domain/watchlist-composition.js','WatchlistComposition'),context);vm.runInContext(scoped('src/watchlist-d1.js','WatchlistD1'),context);
vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
vm.runInContext(fs.readFileSync('src/epg-orchestration.js','utf8'),context);
const run=code=>vm.runInContext(code,context);
const stubs=(fail=null)=>{
 context.getHTML=async url=>{fetches.push(url);if(fail)throw new Error(fail);return '<html></html>';};
 context.parseWatchlist=()=>({total:2,films:[{id:'film-a',title:'A'},{id:'film-b',title:'B'}],next:null});
 context.sourceConfig=()=>({watchlist:'https://letterboxd.example/u/watchlist/',letterboxdUsername:'u'});
 context.requirePausePresence=async()=>false;context.sealedPublishAvailable=async()=>false;context.ratingsGate=async()=>({active:false});
};
const reset=()=>{records.clear();puts=[];fetches=[];stubs();};
const step=(extra={})=>({epgStep:{holder:'h1',modeRevision:1},epgFence:{revision:1},...extra});
const plain=value=>JSON.parse(JSON.stringify(value));
const code=promise=>promise.then(()=>null,error=>error.code||String(error.message));
const film=(i,extra={})=>({id:'lb'+i,title:'Film '+i,year:2000+i,url:'https://letterboxd.com/film/f'+i+'/',...extra});
const seed=async(made,films,at=Date.parse(T))=>{const out=await Watchlist.publishSnapshot(made.db,films,{scanId:'seed',observedAt:new Date(at).toISOString(),completedAt:new Date(at).toISOString()},{now:at});assert.equal(out.ok,true,JSON.stringify(out));return out;};

// ===== 1. default: inert =====
{
 for(const [label,marker,from] of [['tables absent (schema 30)','',legacyBase],['marker epg','',base]]){
  const made=database(marker,{from});const env={DB:made.db,BUCKET:bucket};reset();
  const started=await run('beginSync')(step(env));
  assert.deepEqual(fetches.length>0,true,label+': the EPG run fetches Letterboxd exactly as before');
  assert.equal(started.watchlistCount,2);
  assert.equal(records.get('sync.json').watchlistSnapshot,undefined,label+': the run carries no snapshot pin');
  assert.ok(puts.includes('watchlist-ingest.json'),label+': the ingest success is still recorded');
  assert.equal(await run('composeWatchlistRead')(env,{updatedAt:T,films:[{id:'x'}]},null).then(doc=>doc.films[0].id),'x',label+': readers see the generation document, unchanged');
  assert.equal(await run('epgSnapshotPin')(env),null);
 }
 // no D1 binding at all (every older test harness): legacy, never a refusal
 reset();const env={BUCKET:bucket};assert.equal(await run('epgSnapshotPin')(env),null);
 assert.equal(await run('composeWatchlistRead')(env,{films:[]},null).then(doc=>doc.films.length),0);
}

// ===== 2. d1: one read of the last complete snapshot, no Letterboxd =====
{
 const made=database(D1);const env={DB:made.db,BUCKET:bucket};reset();
 await seed(made,[film(5),film(1),film(3)]);
 const started=await run('beginSync')(step(env));
 assert.deepEqual(fetches,[],'no Letterboxd HTTP in the active branch');
 assert.equal(started.watchlistCount,3);assert.equal(started.pages,0);
 const stored=records.get('sync.json');
 assert.deepEqual(plain(stored.watchlist.map(item=>item.id)),['lb5','lb1','lb3'],'the Letterboxd list order');
 assert.equal(stored.watchlistSnapshot.version,1);assert.equal(typeof stored.watchlistSnapshot.snapshotId,'string');assert.equal(stored.watchlistSnapshot.lastSuccessAt,T);
 assert.equal(stored.watchlistSnapshot.listSha256.length,64);assert.equal(stored.watchlistSnapshot.warning,undefined);
 assert.equal(stored.watchlistObservedAt,T);
 assert.ok(!puts.includes('watchlist-ingest.json'),'the ingest status is not a Letterboxd success when nothing was fetched');
 // the run is self-contained: a commit after the read changes the NEXT run only
 const pinned=stored.watchlist.length;
 // a snapshot of any age is read (no hard TTL), with the warning above 24 hours
 const old=database(D1);const oldEnv={DB:old.db,BUCKET:bucket};reset();
 await seed(old,[film(1),film(2)],Date.parse(T)-30*3600000);
 await run('beginSync')(step(oldEnv));
 assert.deepEqual(fetches,[]);assert.equal(records.get('sync.json').watchlistSnapshot.warning,'watchlist_stale');assert.equal(records.get('sync.json').watchlist.length,2);
 assert.equal(pinned,3);
}

// ===== 3. d1 refusals are D1 faults, never an ingest failure, never Letterboxd, never the EPG generation =====
{
 const none=database(D1);const env={DB:none.db,BUCKET:bucket};reset();
 assert.equal(await code(run('beginSync')(step(env))),'watchlist_snapshot_absent');
 assert.deepEqual(fetches,[]);assert.ok(!puts.includes('watchlist-ingest.json')&&!puts.includes('sync.json'),'no ingest failure and no run');
 const held=database("UPDATE watchlist_authority SET mode='d1',generation=2,writes='held' WHERE id=1;");reset();
 assert.equal(await code(run('beginSync')(step({DB:held.db,BUCKET:bucket}))),'watchlist_writes_held');assert.deepEqual(fetches,[]);
 const closed=database("UPDATE schema_contract SET version=31 WHERE id=1;DROP TRIGGER watchlist_cas_required;DELETE FROM watchlist_cas;");reset();
 assert.equal(await code(run('beginSync')(step({DB:closed.db,BUCKET:bucket}))),'watchlist_authority_closed');assert.deepEqual(fetches,[]);
 // a corrupt snapshot is unavailable, not served
 const bad=database(D1);const badEnv={DB:bad.db,BUCKET:bucket};reset();await seed(bad,[film(1),film(2)]);
 sqlite(bad.file,"DROP TRIGGER watchlist_member_immutable;UPDATE watchlist_member SET title='tampered' WHERE ordinal=0");
 assert.equal(await code(run('beginSync')(step(badEnv))),'watchlist_unavailable');assert.deepEqual(fetches,[]);
}

// ===== 4. the reader seam =====
{
 const made=database(D1);const env={DB:made.db,BUCKET:bucket};reset();
 await seed(made,[film(2),film(9),film(1)]);
 const generation={updatedAt:T,films:[{id:'lb1',title:'Film 1',shows:[{start:1,end:2}]},{id:'lb2',title:'Film 2',shows:[]},{id:'lb3',title:'Film 3',shows:[{start:3,end:4}]}]};
 const programme={films:generation.films,catalogFilms:[{id:'tmdb_90',tmdbId:90,shows:[{start:5,end:6}]}]};
 records.set('metadata.json',{lb9:{tmdbId:90}});
 const doc=await run('composeWatchlistRead')(env,generation,programme);
 assert.deepEqual(plain(doc.films.map(item=>item.id)),['lb2','lb9','lb1'],'membership and order from the snapshot');
 assert.equal(doc.films[1].shows.length,1,'a new film with a read identity and a stored confirmed show joins at once');
 assert.deepEqual(plain(doc.removed.map(item=>item.id)),['lb3'],'a removal is membership-only');
 assert.equal(doc.snapshot.version,1);assert.deepEqual(plain(puts),[],'a read composes and writes nothing');
 // the programme composition compares membership, not length (1-for-1)
 const report={runId:'r1',updatedAt:T,films:generation.films,watchlistCount:3};
 const merged=run('programmeWithWatchlist')(structuredClone(report),doc);
 assert.deepEqual(plain(merged.films.map(item=>item.id)),['lb2','lb9','lb1']);
 const legacyMerged=run('programmeWithWatchlist')(structuredClone(report),{updatedAt:T,films:[{id:'zzz',title:'z'}]});
 assert.deepEqual(plain(legacyMerged.films.map(item=>item.id)),['lb1','lb2','lb3'],'an uncomposed document keeps today\'s equal-length rule');
 // refusals: held, closed and absent never fall back to the EPG generation
 const held=database("UPDATE watchlist_authority SET mode='d1',generation=2,writes='held' WHERE id=1;");
 const e1=await run('composeWatchlistRead')({DB:held.db,BUCKET:bucket},generation,programme).then(()=>null,error=>error);
 assert.equal(e1.code,'watchlist_writes_held');assert.equal(e1.temporary,true,'a degraded read may answer, from the standalone mirror (ADR 0186 decision 8.6)');
 const none=database(D1);
 assert.equal(await code(run('composeWatchlistRead')({DB:none.db,BUCKET:bucket},generation,programme)),'watchlist_snapshot_absent');
}

// ===== 5. the EPG commit tail does not own the scan or the watchlist Event when pinned =====
{
 const calls=[];
 context.LetterboxdFacts={applyWatchlistScan:async()=>{calls.push('scan');}};
 const pinnedRun={runId:'r',watchlistObservedAt:T,watchlistSnapshot:{version:1}};
 const report={films:[{id:'a'}],watchlistCount:1};
 assert.equal(await run('persistScan')({},pinnedRun,report),'ok');
 assert.equal(pinnedRun.scanOutcome,'skipped_snapshot_pinned');assert.deepEqual(calls,[],'no scan facts, retention or removal hand-over from the EPG');
 const legacyRun={runId:'r2',watchlistObservedAt:T};
 context.CanonicalRatedAdmission={ratedAdmissionWriterOpen:async()=>false};
 await run('persistScan')({},legacyRun,report);
 assert.deepEqual(calls,['scan'],'an unpinned run (legacy or an EPG run in flight across a cutover) keeps today\'s tail');
 assert.equal(legacyRun.scanOutcome,'facts_only');
}
console.log('watchlist-worker: ok');
