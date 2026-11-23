#!/usr/bin/env node
// AIR-571 (offline QA): a SURROGATE measurement of a ~700-row Watchlist promotion. Real repository code (src/watchlist-d1.js) on the sqlite D1 stand-in (tests/d1-standin.mjs) over the whole migration chain, in a private
// scratch directory. It touches no production binding, credential, network or data, and it provisions nothing. What it measures and what it does not:
//   MEASURED (representative of the Worker's plan): the number of D1 round trips (batches), statements per batch, the largest statement text, the largest bound-parameter count of a statement, the rows inserted per table,
//   and the Worker-side CPU of normalizing and digesting the list (Node `crypto.subtle`, order of magnitude only).
//   MEASURED BUT NOT REPRESENTATIVE: wall time and process CPU of the whole promotion (the stand-in spawns a sqlite process per statement or batch; Cloudflare D1 does not).
//   NOT MEASURED: Cloudflare runtime CPU, wall time and memory (workerd), D1 latency. Those need a scratch Cloudflare environment and are NOT claimed here.
// Usage: node scripts/measure-watchlist-promotion.mjs [rows=700] [replace=100]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {sqliteSync} from '../tests/sqlite-session.mjs';
import {d1Standin} from '../tests/d1-standin.mjs';
import * as WatchlistD1 from '../src/watchlist-d1.js';

const rows=Number(process.argv[2]||700),replace=Number(process.argv[3]||100);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-measure-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const file=path.join(root,'scratch.sqlite');
{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain+"\nUPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;"});if(r.status!==0)throw new Error(r.stderr);}
const stats={batches:0,statements:0,maxStatementsPerBatch:0,maxBound:0,maxText:0,reads:0};
const inner=d1Standin(file,{maxBinds:100,onBatch:async statements=>{stats.batches++;stats.statements+=statements.length;stats.maxStatementsPerBatch=Math.max(stats.maxStatementsPerBatch,statements.length);for(const item of statements){stats.maxText=Math.max(stats.maxText,item.text.length);}},onQuery:async()=>{stats.reads++;}});
const db={...inner,prepare(sql){const p=inner.prepare(sql);return {bind:(...params)=>{if(params.length>stats.maxBound){stats.maxBound=params.length;stats.maxBoundSql=sql.slice(0,160);}return p.bind(...params);},first:()=>p.first(),all:()=>p.all(),run:()=>p.run()};}};
const film=i=>({id:'f'+i,title:'Film number '+i+' with a realistic title length',year:1950+(i%75),url:'https://letterboxd.com/film/f'+i+'/'});
const list=n=>Array.from({length:n},(_,i)=>film(i));
const TABLES=['watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
const counts=()=>Object.fromEntries(TABLES.map(t=>[t,db.sql('SELECT COUNT(*) AS n FROM '+t)[0].n]));
const reset=()=>Object.assign(stats,{batches:0,statements:0,maxStatementsPerBatch:0,maxBound:0,maxText:0,reads:0});
const run=async(films,scanId,at)=>{
 const before=counts(),t0=performance.now(),c0=process.cpuUsage(),m0=process.memoryUsage().heapUsed;
 reset();
 const result=await WatchlistD1.publishSnapshot(db,films,{scanId,observedAt:at,completedAt:at},{now:Date.parse(at)});
 const wall=performance.now()-t0,cpu=process.cpuUsage(c0),after=counts();
 if(!result.ok)throw new Error(JSON.stringify(result));
 return {outcome:result.outcome,version:result.version,batches:stats.batches,statements:stats.statements,maxStatementsPerBatch:stats.maxStatementsPerBatch,maxBoundParams:stats.maxBound,maxStatementChars:stats.maxText,singleReads:stats.reads,
  rowsInserted:Object.fromEntries(TABLES.map(t=>[t,after[t]-before[t]])),wallMsSurrogate:Math.round(wall),processCpuMsSurrogate:Math.round((cpu.user+cpu.system)/1000),heapDeltaMiB:Number(((process.memoryUsage().heapUsed-m0)/1048576).toFixed(2)),films:films.length,snapshotId:result.snapshotId};
};
// the Worker-side CPU of the list work only: normalization and the SHA-256 digest, repeated for a stable figure
const films=list(rows);
const t0=performance.now();let normalized=null;for(let i=0;i<50;i++){normalized=WatchlistD1.normalizeFilms(films);await WatchlistD1.listDigest(normalized);}
const listCpuMs=(performance.now()-t0)/50;
// FINDING: a first promotion that adds more than `pendingCap` (500) unresolved ids is refused (`admission_ledger_full`), so a 700-row list cannot enter through a scan: it enters through the bootstrap import (no ledger rows).
// The measurement starts from a list built in two steps with the ledger resolved after each (as the identity step would), and measures the promotion that matters: the full 700-row list with `replace` films replaced.
const refused=await WatchlistD1.publishSnapshot(db,list(rows),{scanId:'measure-cap',observedAt:'2026-11-22T09:00:00.000Z',completedAt:'2026-11-22T09:00:00.000Z'},{now:Date.parse('2026-11-22T09:00:00Z')});
const settle=async(snapshotId,at)=>{for(const effect of WatchlistD1.EFFECTS){const done=await WatchlistD1.completeEffect(db,{snapshotId,effect,receipt:'r'},{now:Date.parse(at)});if(!done.ok)throw new Error('effect '+effect+': '+JSON.stringify(done));}db.sql("SELECT 1");const r=sqliteSync(['-bail',file],{input:"UPDATE watchlist_admission_pending SET state='resolved', resolved_by='measure', updated_at='"+at+"' WHERE state='pending';"});if(r.status!==0)throw new Error(r.stderr);};
const first=await run(list(Math.min(400,rows)),'measure-1a','2026-11-22T10:00:00.000Z');await settle(first.snapshotId,'2026-11-22T10:00:01.000Z');
const baseline=await run(list(rows),'measure-1b','2026-11-22T10:30:00.000Z');await settle(baseline.snapshotId,'2026-11-22T10:30:01.000Z');
// a promotion of the same size with `replace` films out and `replace` in (1-for-N replacement, the same count)
const next=list(rows).map((f,i)=>i<replace?{...film(100000+i)}:f);
const promotion=await run(next,'measure-2','2026-11-22T16:00:00.000Z');
await settle(promotion.snapshotId,'2026-11-22T16:00:01.000Z');
const noChange=await run(next,'measure-3','2026-11-22T22:00:00.000Z');
console.log(JSON.stringify({kind:'surrogate',firstScanOverCapRefused:refused.ok===false?refused.reason:'accepted',scope:'real repository code on the sqlite D1 stand-in; NOT Cloudflare runtime',rows,replace,workerSideListWorkMs:Number(listCpuMs.toFixed(3)),node:process.version,baseline,promotion,noChange},null,1));
