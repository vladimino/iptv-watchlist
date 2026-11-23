// AIR-570 / ADR 0186. The three causal effect writers (`scan_facts`, `retention`, `removal_enqueue`) against the REAL Watchlist repository on the full migration chain, with fake facts, retention
// and removal-queue collaborators. Offline: no network, no R2, no Cloudflare. Proves the data each writer hands over (from the durable snapshot and change rows, not a membership diff),
// idempotent receipts, the drain order, the holds (writer closed, queue unsettled, Event not yet stored, predecessor missing) and O3: removal is membership-only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {effectWriters,RETENTION_SLICES_PER_CALL} from '../src/letterboxd-sync-effects.js';
import {watchlistRepository} from '../src/letterboxd-sync-repository.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbeff-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+chain});if(r.status!==0)throw new Error(r.stderr);}
let n=0;
function open(){const file=path.join(root,'db-'+(n++)+'.sqlite');fs.copyFileSync(base,file);const r=sqliteSync(['-bail',file],{input:"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;"});if(r.status!==0)throw new Error(r.stderr);return {file,db:d1Standin(file)};}
const film=i=>({id:'f'+i,title:'F'+i,year:2000+i,url:'https://letterboxd.com/film/f'+i+'/'});
const scan=(id,at)=>({scanId:id,observedAt:at,runId:'r-'+id,slotKey:'2026-11-21T1030'});
async function publish(env,list,id,at){const r=await WatchlistD1.publishSnapshot(env,list,scan(id,at),{now:Date.parse(at)});assert.equal(r.ok,true,JSON.stringify(r));return r;}

function deps(over={}){
 const log=[];
 const d={
  repository:WatchlistD1,
  facts:{applyWatchlistScan:async(env,arg)=>{log.push(['facts',arg.scanId,arg.films.map(f=>f.id+':'+f.tmdbId).join(',')]);return {};}},
  retention:{UNIT_CAP:2,writerOpen:async()=>true,work:({listed,departed,observedAt,scanId})=>[...listed.map(l=>({lid:l.lid,tmdbId:l.tmdbId,watchlist:true})),...departed.map(l=>({lid:l,watchlist:false}))],
   apply:async(env,arg)=>{log.push(['retain',arg.event,arg.retentions.map(r=>r.lid+(r.watchlist?'+':'-')).join(',')]);return {state:'ok',units:arg.retentions};},carry:()=>[],settled:()=>true},
  removal:{enqueue:async(env,films,ref)=>{log.push(['enqueue',films.map(f=>f.id+'@'+f.url).join(','),ref.eventKey]);}},
  tmdbOf:async(env,lids)=>new Map(lids.filter(l=>l==='f0').map(l=>[l,'603'])),
  removalRef:async(env,snapshot)=>({eventKey:'events/items/0000000000001-lbsync-x-watchlist.json',sourceRunId:snapshot.runId,at:snapshot.observedAt}),
  ...over};
 return {log,writers:effectWriters(d)};
}
const ctx=env=>({env,epoch:1,slotKey:'k',runId:'r',now:()=>Date.parse('2026-11-21T12:00:00Z')});
const pendingOf=async env=>(await WatchlistD1.pendingEffects(env)).effects;

// 1. Version 1 (a 3-film list), version 2 (1-for-1 replacement: f2 out, f9 in). The effects of version 1 first, strictly in order, from the durable rows.
{
 const {file,db}=open(),env={DB:db};
 const v1=await publish(env,[film(0),film(1),film(2)],'s1','2026-11-21T09:40:00.000Z');
 const v2=await publish(env,[film(0),film(1),film(9)],'s2','2026-11-21T15:40:00.000Z');
 // version 2 was promoted while version 1's effects are still pending: the order is version, then scan_facts, retention, removal_enqueue
 assert.deepEqual((await pendingOf(env)).map(e=>e.version+':'+e.effect).slice(0,3),['1:scan_facts','1:retention','1:removal_enqueue']);
 const {log,writers}=deps();
 const repo=watchlistRepository(WatchlistD1,{epochGuard:e=>[ 'INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]],effectWriters:writers});
 const drained=await repo.drainEffects(ctx(env),{now:Date.parse('2026-11-21T12:00:00Z')});
 assert.deepEqual(drained,{drained:true});
 const kinds=log.map(x=>x[0]);
 assert.equal(kinds.filter(k=>k==='facts').length,2,'one scan of facts per promoted version');
 // version 1: facts for the three listed ids with the TMDB id where the cache has one
 assert.deepEqual(log[0],['facts','s1','f0:603,f1:null,f2:null']);
 // retention of version 1: 3 listed, no departed; UNIT_CAP 2 -> two slices, cursor-keyed event ids
 assert.deepEqual(log.filter(x=>x[0]==='retain'&&x[1].startsWith('watchlist:s1')).map(x=>x[1]+'|'+x[2]),['watchlist:s1:0|f0+,f1+','watchlist:s1:2|f2+']);
 // version 1 removed nothing, so nothing is enqueued for it; version 2 enqueues the removed film with the url of its PREDECESSOR member
 assert.deepEqual(log.filter(x=>x[0]==='enqueue'),[['enqueue','f2@https://letterboxd.com/film/f2/','events/items/0000000000001-lbsync-x-watchlist.json']]);
 // version 2 retention carries the departed id as `watchlist:false`
 assert.ok(log.some(x=>x[0]==='retain'&&x[1].startsWith('watchlist:s2')&&x[2].includes('f2-')));
 assert.equal((await pendingOf(env)).length,0);
 assert.equal(db.sql('SELECT effects_drained_version AS v FROM watchlist_current')[0].v,2);
 // O3: nothing here touched a Film, a show or a rating: the only collaborators called were facts, retention (transitions) and the lookup queue.
 assert.deepEqual([...new Set(kinds)].sort(),['enqueue','facts','retain']);
}
// 2. Holds: each hold leaves the effect pending and is retried; nothing is marked done without a receipt.
{
 const mk=async()=>{const {db}=open(),env={DB:db};await publish(env,[film(0),film(1)],'s1','2026-11-21T09:40:00.000Z');await publish(env,[film(0)],'s2','2026-11-21T15:40:00.000Z');return env;};
 const run=async(env,over,upTo)=>{const {writers,log}=deps(over);const repo=watchlistRepository(WatchlistD1,{epochGuard:()=>['INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]],effectWriters:writers});return {log,out:await repo.drainEffects(ctx(env),{now:1})};};
 // the canonical writer closed: the retention effect records that (as the EPG scan did) and the drain moves on
 let env=await mk();let r=await run(env,{retention:{...deps().retention,writerOpen:async()=>false}});
 assert.equal(r.out.drained,true);assert.ok(!r.log.some(x=>x[0]==='retain'));
 assert.deepEqual((await WatchlistD1.pendingEffects(env)).effects,[]);
 // an unsettled retention slice holds the drain (and counts an attempt)
 env=await mk();r=await run(env,{retention:{...deps().retention,settled:()=>false}});
 assert.deepEqual(r.out,{drained:false,code:'effect_failed'});assert.equal((await pendingOf(env))[0].effect,'retention');assert.ok((await pendingOf(env))[0].attempts>=1);
 // the removal Event not yet stored: version 2's removal_enqueue holds, the rest stays done
 env=await mk();r=await run(env,{removalRef:async()=>null});
 assert.deepEqual(r.out,{drained:false,code:'effect_failed'});assert.deepEqual((await pendingOf(env)).map(e=>e.version+':'+e.effect),['2:removal_enqueue']);
 // the facts module throws: held at scan_facts
 env=await mk();r=await run(env,{facts:{applyWatchlistScan:async()=>{throw new Error('r2');}}});
 assert.deepEqual(r.out,{drained:false,code:'effect_failed'});assert.equal((await pendingOf(env))[0].effect,'scan_facts');
 // the retention work is bounded: more slices than the per-call bound hold the effect for the next tick instead of looping
 env=await mk();r=await run(env,{retention:{...deps().retention,UNIT_CAP:1,work:()=>Array.from({length:RETENTION_SLICES_PER_CALL+5},(_,i)=>({lid:'x'+i,watchlist:true}))}});
 assert.equal(r.out.drained,false);
}
// 3. The repository reads: one snapshot by id (not only the current) and its predecessor by version.
{
 const {file,db}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'s1','2026-11-21T09:40:00.000Z');const v2=await publish(env,[film(0)],'s2','2026-11-21T15:40:00.000Z');
 const cur=await WatchlistD1.readSnapshot(env,v2.snapshotId);assert.equal(cur.ok,true);assert.equal(cur.snapshot.version,2);assert.equal(cur.snapshot.prevVersion,1);assert.deepEqual(cur.snapshot.films.map(f=>f.lid),['f0']);
 const prev=await WatchlistD1.snapshotIdOfVersion(env,1);assert.equal(prev.ok,true);
 const old=await WatchlistD1.readSnapshot(env,prev.snapshotId);assert.deepEqual(old.snapshot.films.map(f=>f.lid),['f0','f1']);
 assert.deepEqual(await WatchlistD1.readSnapshot(env,'nope'),{ok:false,reason:'absent'});
 assert.deepEqual(await WatchlistD1.snapshotIdOfVersion(env,7),{ok:false,reason:'absent'});
}
const NOW0=Date.parse('2026-11-21T12:00:00Z');
// 3b. Review: every AUTHORITATIVE write of an effect goes through the epoch-fenced env (facts, the retention writer-open check and apply, the removal enqueue); reads keep the plain env.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'s1','2026-11-21T09:40:00.000Z');await publish(env,[film(0)],'s2','2026-11-21T15:40:00.000Z');
 const seen=[];
 const fenceEnv=(e,epoch)=>({...e,fenced:true,epoch});
 const epochGuard=()=>['INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]];
 const d={epochGuard,
  facts:{applyWatchlistScan:async(e)=>{seen.push(['facts',e.fenced===true,e.epoch]);return {};}},
  retention:{UNIT_CAP:2,writerOpen:async(e)=>{seen.push(['open',e.fenced===true]);return true;},work:()=>[{lid:'f0',watchlist:true}],apply:async(e)=>{seen.push(['apply',e.fenced===true]);return {state:'ok'};},carry:()=>[],settled:()=>true},
  removal:{enqueue:async(e)=>{seen.push(['enqueue',e.fenced===true]);}},
  tmdbOf:async(e)=>{seen.push(['tmdb',e.fenced===true]);return new Map();}};
 const writers=effectWriters({repository:WatchlistD1,facts:d.facts,retention:d.retention,removal:d.removal,tmdbOf:d.tmdbOf,removalRef:async(e,s)=>({eventKey:'events/items/0000000000001-x.json',sourceRunId:s.runId,at:s.observedAt}),epochGuard:d.epochGuard,fenceEnv});
 for(let i=0;i<20;i++){const next=(await WatchlistD1.pendingEffects(env)).effects[0];if(!next)break;const receipt=await writers[next.effect]({env,epoch:7,now:()=>NOW0},next);assert.ok(receipt);await WatchlistD1.completeEffect(env,{snapshotId:next.snapshotId,effect:next.effect,receipt},{now:NOW0,guards:[d.epochGuard()]});}
 for(const [kind,fenced] of seen)if(kind!=='tmdb')assert.equal(fenced,true,kind+' ran with the fenced env');
 assert.ok(seen.some(x=>x[0]==='facts')&&seen.some(x=>x[0]==='apply')&&seen.some(x=>x[0]==='enqueue'),'every writer ran');
 assert.ok(seen.filter(x=>x[0]==='tmdb').every(x=>x[1]===false),'a read keeps the plain env');
 assert.ok(seen.filter(x=>x[0]==='facts').every(x=>x[2]===7),'the epoch of the step is the one fenced');
}
// 4. The module holds no SQL and does not name EPG, Discovery, Film or show tables.
{
 const text=fs.readFileSync('src/letterboxd-sync-effects.js','utf8');
 assert.doesNotMatch(text,/\b(SELECT|INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)|prepare\(|BUCKET|env\.DB|published_epg|discovery_|film_(fact|admission)/i);
}
// 5. AIR-571 (22 Nov 2026): a LIST LARGER THAN ONE CALL. The retention effect used to restart from its first film on every call, so a list of more than UNIT_CAP x RETENTION_SLICES_PER_CALL films (288 in production, the
// first real scan had 394) never completed: every call ended `null`, the drain failed before every later scan. The resume point is now kept on the pending effect and the drain continues from it.
{
 const GUARD=['INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]];
 const big=count=>Array.from({length:count},(_,i)=>film(i));
 const setup=async(count,over={})=>{
  const {db}=open(),env={DB:db};
  await publish(env,big(count),'sB','2026-11-22T21:31:28.601Z');
  const {writers,log}=deps({slicesPerCall:3,...over});   // UNIT_CAP 2 x 3 slices = 6 films per call
  const repo=watchlistRepository(WatchlistD1,{epochGuard:()=>GUARD,effectWriters:writers});
  return {env,writers,log,repo};
 };
 // a. 14 films, 6 per call: three passes of ONE drain finish it (6, 12, 14), the retention is done, every slice applied exactly once and in order, nothing skipped
 {
  const {env,log,repo}=await setup(14);
  const out=await repo.drainEffects(ctx(env),{now:Date.parse('2026-11-22T21:32:00Z')});
  assert.deepEqual([out.drained],[true],JSON.stringify(out));
  const applied=log.filter(x=>x[0]==='retain').map(x=>x[2]).join(',').split(',');
  assert.deepEqual(applied,big(14).map(f=>f.id+'+'),'every film exactly once, in order');
  assert.deepEqual((await pendingOf(env)).map(e=>e.effect),[],'all effects done');
 }
 // b. the point is kept on the pending row between drains: a drain that stops after one call (passes limited by a failing slice) resumes at the saved index, not at 0
 {
  let fail=true;
  const retention={UNIT_CAP:2,writerOpen:async()=>true,work:({listed,departed})=>[...listed.map(l=>({lid:l.lid,watchlist:true})),...departed.map(l=>({lid:l,watchlist:false}))],carry:()=>[],
   apply:async(e,arg)=>{if(fail&&arg.retentions.some(r=>r.lid==='f8')){fail=false;return {state:'failed',units:[]};}return {state:'ok',units:arg.retentions};},settled:out=>out.state==='ok'};
  const {env,repo}=await setup(14,{retention});
  const first=await repo.drainEffects(ctx(env),{now:Date.parse('2026-11-22T21:32:00Z')});
  assert.deepEqual([first.drained,first.code],[false,'effect_failed'],'an unsettled slice holds the drain');
  const kept=(await pendingOf(env)).find(e=>e.effect==='retention');
  assert.match(kept.progress,/^retention-cursor:\d+$/,'the resume point is kept on the pending effect');assert.ok(kept.attempts>=1);
  const point=Number(kept.progress.split(':')[1]);assert.ok(point>0&&point<14,'it advanced past the settled slices only');
  const second=await repo.drainEffects(ctx(env),{now:Date.parse('2026-11-22T21:33:00Z')});
  assert.equal(second.drained,true,JSON.stringify(second));
  assert.deepEqual((await pendingOf(env)).map(e=>e.effect),[]);
 }
 // c. a list within one call still finishes in one call with the plain receipt (no progress written); an unreadable resume point starts over and never skips ahead
 {
  const {env,writers}=await setup(5);
  const next=(await pendingOf(env)).find(e=>e.effect==='retention');
  const first=(await pendingOf(env)).find(e=>e.effect==='scan_facts');
  assert.ok(first);await WatchlistD1.completeEffect(env,{snapshotId:first.snapshotId,effect:'scan_facts',receipt:'f'},{now:Date.parse('2026-11-22T21:32:00Z'),guards:[GUARD]});
  const bad=await writers.retention(ctx(env),{...next,progress:'garbage'});assert.equal(typeof bad,'string','an unreadable point restarts from 0 and completes');
  const far=await writers.retention(ctx(env),{...next,progress:'retention-cursor:999999'});assert.equal(typeof far,'string','an out-of-range point restarts from 0');
 }
 // d. the real production numbers: UNIT_CAP 12 and RETENTION_SLICES_PER_CALL 24 do not finish 394 films in one call but do in two resumed calls
 {
  const {watchlistRetentionWork,UNIT_CAP}=await import('../src/canonical-rated-admission-producer.js');
  const {effectWriters:real}=await import('../src/letterboxd-sync-effects.js');
  const films=big(394);let calls=0;
  const w=real({repository:{readSnapshot:async()=>({ok:true,snapshot:{films:films.map(f=>({lid:f.id})),scanId:'s',observedAt:'2026-11-22T21:31:28.601Z'}}),readChanges:async()=>({ok:true,removed:[],added:[]})},facts:{},removal:{},removalRef:()=>null,epochGuard:()=>[],tmdbOf:async()=>new Map(),
   retention:{UNIT_CAP,writerOpen:async()=>true,work:watchlistRetentionWork,apply:async()=>{calls++;return {settled:true};},carry:()=>[],settled:()=>true}});
  const one=await w.retention({env:{},epoch:1},{snapshotId:'x'});assert.deepEqual(one,{progress:'retention-cursor:288',more:true});
  const two=await w.retention({env:{},epoch:1},{snapshotId:'x',progress:one.progress});assert.equal(two,'retention:s:394');assert.equal(calls,24+9,'288 + 106 films, 33 slices in all');
 }
}
console.log('letterboxd-sync-effects ok');
