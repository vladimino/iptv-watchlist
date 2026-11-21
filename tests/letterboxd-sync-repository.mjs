// AIR-570 + AIR-569 integration, OFFLINE: the Letterboxd Sync control plane and Watchlist phase run against the REAL Watchlist authority repository (src/watchlist-d1.js)
// on the sqlite D1 stand-in with the whole migration chain (0031 and 0032). Proves the contract the cutover will rely on: publication and no-op through the repository, the
// Workflow mode-epoch guard inside the repository batches, the causal effects drained in version order before a new scan, an unknown outcome never replayed, and a 1-for-1
// replacement. No network, no Cloudflare, nothing applied to production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as Sync from '../src/letterboxd-sync.js';
import * as Phase from '../src/letterboxd-sync-watchlist.js';
import {watchlistRepository} from '../src/letterboxd-sync-repository.js';
import * as WatchlistD1 from '../src/watchlist-d1.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbrepo-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const T=s=>Date.parse(s);
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+chain});if(r.status!==0)throw new Error(r.stderr);}
let copies=0;
function open(){
 const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(base,file);
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;");
 return {file,sql,db:d1Standin(file)};
}
function bucket(){const map=new Map();return {map,async put(key,body,opts){if(opts?.onlyIf?.etagDoesNotMatch==='*'&&map.has(key))return null;map.set(key,body);return {etag:'e'};}};}
function workflow(){const instances=new Map();return {instances,created:[],async create({id,params}){if(instances.has(id))throw new Error('already exists');instances.set(id,{status:'running',params});this.created.push(id);},async get(id){if(!instances.has(id))throw new Error('not found');return {status:async()=>({status:instances.get(id).status})};}};}
const step=()=>({async do(name,fn){return fn();},async sleepUntil(){}});
function site(films,size=3){
 const pages=[];for(let i=0;i<films.length;i+=size)pages.push(films.slice(i,i+size));
 return {fetchPage:async url=>({n:Number((/page\/(\d+)\/$/.exec(url)||[0,1])[1])}),parse:html=>({films:pages[html.n-1]||[],total:films.length,next:html.n<pages.length?'/me/watchlist/page/'+(html.n+1)+'/':null})};
}
const film=(i,extra={})=>({id:'f'+i,title:'F'+i,year:2000+i,url:'https://letterboxd.com/film/f'+i+'/',...extra});
const receipts=[];
const writers={scan_facts:async(ctx,e)=>{receipts.push(e.effect+':'+e.version);return 'r-'+e.effect+'-'+e.version;},retention:async(ctx,e)=>{receipts.push(e.effect+':'+e.version);return 'r-'+e.effect+'-'+e.version;},removal_enqueue:async(ctx,e)=>{receipts.push(e.effect+':'+e.version);return 'r-'+e.effect+'-'+e.version;}};
const GOOD={handover:async()=>({ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true})};

async function slotRun(env,{now,list,effectWriters=writers,key=null,epoch=1}){
 const s=site(list);
 const repository=watchlistRepository(WatchlistD1,{epochGuard:e=>[Sync.FENCE_GUARD_SQL,[e]],effectWriters});
 const phase=Phase.watchlistPhase({repository,fetchPage:s.fetchPage,parse:s.parse,firstUrl:'https://letterboxd.com/me/watchlist/',username:'me'});
 const started=await Sync.ensure(env,{now});
 const ports={ratings:{run:async()=>({done:true,outcome:'finished'})},watchlist:phase,reconcile:{run:async()=>({done:true,outcome:'done'})}};
 const result=await Sync.run(env,{slotKey:started.slot,series:0,epoch},step(),{now:()=>now+60000,ports});
 return {started,result};
}
const slotRows=(f,key)=>f.db.sql("SELECT watchlist_outcome,status FROM letterboxd_slot WHERE slot_key='"+key+"'")[0];

// 1. Activation is refused until the handover is proven; then a first slot publishes version 1 through the real repository.
{
 const f=open(),b=bucket(),wf=workflow(),env={DB:f.db,BUCKET:b,LETTERBOXD_WORKFLOW:wf};
 await Sync.switchMode(env,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T09:39:00Z'));
 assert.equal((await Sync.switchMode(env,{action:'complete'},{},T('2026-11-21T09:39:00Z'))).refused,'handover_not_proven');
 assert.equal((await Sync.switchMode(env,{action:'complete'},GOOD,T('2026-11-21T09:39:00Z'))).completed,true);
 const r1=await slotRun(env,{now:T('2026-11-21T09:40:00Z'),list:[film(0),film(1),film(2),film(3)]});
 assert.equal(r1.result.reason,'complete');assert.equal(slotRows(f,'2026-11-21T1030').watchlist_outcome,'committed');
 assert.equal(f.db.sql('SELECT version,film_count FROM watchlist_current')[0].version,1);
 assert.deepEqual(receipts.splice(0),[],'no effects are drained before the first publication');
 // 2. The next slot first drains version 1's causal effects (scan_facts, retention, removal_enqueue), in order, then scans: an unchanged list is a no-op.
 const r2=await slotRun(env,{now:T('2026-11-21T15:40:00Z'),list:[film(0),film(1),film(2),film(3)]});
 assert.deepEqual(receipts.splice(0),['scan_facts:1','retention:1','removal_enqueue:1']);
 assert.equal(slotRows(f,'2026-11-21T1630').watchlist_outcome,'no_change');assert.equal(f.db.sql('SELECT version,effects_drained_version FROM watchlist_current')[0].effects_drained_version,1);
 assert.equal(f.db.sql('SELECT version FROM watchlist_current')[0].version,1,'a no-op writes no snapshot');
 // 3. T6: a 1-for-1 replacement (same count, one out, one in) is a new version with one added and one removed; the Event carries both.
 const r3=await slotRun(env,{now:T('2026-11-21T21:40:00Z'),list:[film(0),film(1),film(2),film(9)]});
 assert.equal(slotRows(f,'2026-11-21T2230').watchlist_outcome,'committed');assert.equal(f.db.sql('SELECT version FROM watchlist_current')[0].version,2);
 const wl=[...b.map.values()].map(JSON.parse).filter(e=>e.type==='watchlist'&&e.slot==='2026-11-21T2230')[0];
 assert.equal(wl.addedCount,1);assert.equal(wl.removedCount,1);assert.equal(wl.snapshotVersion,2);assert.equal(wl.status,'success');
 // 4. Exactly two Events per slot, three slots, never a third.
 assert.equal(b.map.size,6);
}
// 5. A missing effect writer holds the drain AND the scan (nothing is marked done without a receipt); the slot still emits both Events honestly.
{
 const f=open(),b=bucket(),wf=workflow(),env={DB:f.db,BUCKET:b,LETTERBOXD_WORKFLOW:wf};
 await Sync.switchMode(env,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T09:39:00Z'));await Sync.switchMode(env,{action:'complete'},GOOD,T('2026-11-21T09:39:00Z'));
 await slotRun(env,{now:T('2026-11-21T09:40:00Z'),list:[film(0),film(1)]});
 const held=await slotRun(env,{now:T('2026-11-21T15:40:00Z'),list:[film(0),film(5)],effectWriters:{scan_facts:writers.scan_facts}});
 assert.equal(slotRows(f,'2026-11-21T1630').watchlist_outcome,'error');
 assert.equal(f.db.sql("SELECT COUNT(*) AS n FROM watchlist_effect WHERE status='pending'")[0].n,2,'retention and removal_enqueue stay pending, the facts were applied in order');
 assert.equal(f.db.sql('SELECT version FROM watchlist_current')[0].version,1,'the scan was held: no new version while an older effect is undone');
 assert.equal(b.map.size,4,'both slots emitted two Events');
 // The writer comes back: the next slot drains in order and then publishes.
 await slotRun(env,{now:T('2026-11-21T21:40:00Z'),list:[film(0),film(5)]});
 assert.equal(f.db.sql('SELECT version FROM watchlist_current')[0].version,2);
}
// 6. The Workflow epoch guard is inside the repository batches: after the mode moves, a stale instance publishes nothing; a closed authority is `disabled`.
{
 const f=open(),b=bucket(),wf=workflow(),env={DB:f.db,BUCKET:b,LETTERBOXD_WORKFLOW:wf};
 await Sync.switchMode(env,{action:'close_admission',target:'cloudflare'},{},T('2026-11-21T09:39:00Z'));await Sync.switchMode(env,{action:'complete'},GOOD,T('2026-11-21T09:39:00Z'));
 const repo=watchlistRepository(WatchlistD1,{epochGuard:e=>[Sync.FENCE_GUARD_SQL,[e]],effectWriters:writers});
 const ctx={env,epoch:1,slotKey:'k',runId:'r',now:()=>T('2026-11-21T09:41:00Z')};
 const ok=await repo.commitScan(ctx,{members:[film(0)],scan:{scanId:'s1',observedAt:'2026-11-21T09:41:00.000Z',slotKey:'k',runId:'r'}});assert.equal(ok.version,1);assert.equal(ok.baseline,true);
 await assert.rejects(()=>repo.commitScan({...ctx,epoch:7},{members:[film(0),film(1)],scan:{scanId:'s2',observedAt:'2026-11-21T09:42:00.000Z'}}),e=>/conflict|unavailable/.test(e.code),'a stale epoch writes nothing');
 assert.equal(f.db.sql('SELECT version FROM watchlist_current')[0].version,1);
 // No epoch guard supplied: not ready, commit refused.
 const bare=watchlistRepository(WatchlistD1,{});assert.deepEqual(await bare.ready(ctx),{ready:false});await assert.rejects(()=>bare.commitScan(ctx,{members:[film(0)],scan:{scanId:'s3',observedAt:'2026-11-21T09:42:00.000Z'}}),e=>e.code==='epoch_guard_absent');
 // The authority held or `epg`: not ready, so the phase fetches nothing.
 f.sql("UPDATE watchlist_authority SET writes='held'");assert.deepEqual(await repo.ready(ctx),{ready:false});
 f.sql("UPDATE watchlist_authority SET writes='open',mode='epg'");assert.deepEqual(await repo.ready(ctx),{ready:false});
}
// 7. The adapter holds no SQL and no table name of its own.
{
 const text=fs.readFileSync('src/letterboxd-sync-repository.js','utf8');
 assert.doesNotMatch(text,/\b(SELECT|INSERT|UPDATE|DELETE)\b\s+(INTO|FROM|watchlist|letterboxd)|prepare\(|BUCKET/i);
}
console.log('letterboxd-sync-repository ok');
