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
// 4. The module holds no SQL and does not name EPG, Discovery, Film or show tables.
{
 const text=fs.readFileSync('src/letterboxd-sync-effects.js','utf8');
 assert.doesNotMatch(text,/\b(SELECT|INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)|prepare\(|BUCKET|env\.DB|published_epg|discovery_|film_(fact|admission)/i);
}
console.log('letterboxd-sync-effects ok');
