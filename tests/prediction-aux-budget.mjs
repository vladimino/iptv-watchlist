// AIR-553 / ADR 0194: the deterministic operation and statement budgets of the auxiliary state (core). The three arms run the same cycle (deferred start, preparation, bounded readback, submits in groups of
// five, heartbeat, complete) over the same seeded queue, profile and catalog; this test compares EXACT counts only: it never asserts a latency, and local timings are not Cloudflare latency (the paired
// wall-clock measurement is the non-functional benchmark, docs/evidence/prediction/air-553-*). A budget here is a regression guard on counts, not an acceptance threshold on speed.
import assert from 'node:assert/strict';
import {arm,cycle,total,rowCounts,seedHistory,ARMS} from './prediction-aux-bench-lib.mjs';
import {sql} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const results={};
for(const size of [5,7,10]){
 for(const name of ARMS){
  const w=await arm(name);const run=await cycle(w,{manifestSize:size});
  results[size+':'+name]={w,run,t:total(w)};
 }
}
for(const size of [5,7,10]){
 const [legacy,marker,d1]=ARMS.map(name=>results[size+':'+name]);
 // no extra model work: the same films are committed by every arm
 assert.equal(legacy.run.committed,size);assert.equal(marker.run.committed,size);assert.equal(d1.run.committed,size);
 // the dormant arms are the R2 code: identical R2 operations, identical D1 writes; the marker read is the only extra, and it is read-only
 const opsOf=t=>({get:t.r2.get,head:t.r2.head,put:t.r2.put,list:t.r2.list,delete:t.r2.delete,auxOps:t.r2.auxOps});
 assert.deepEqual(opsOf(marker.t),opsOf(legacy.t),'S'+size+': marker r2 does exactly the legacy R2 operations');
 assert.equal(marker.t.d1.writeStatements,legacy.t.d1.writeStatements,'S'+size+': marker r2 writes the same D1 rows');
 assert.ok(marker.t.d1.calls<=Math.ceil(legacy.t.d1.calls*1.10),'S'+size+': the dormant marker read stays within 10 % of the legacy D1 calls ('+marker.t.d1.calls+' vs '+legacy.t.d1.calls+')');
 // the D1 arm: no R2 object of the four families, fewer R2 operations in total
 assert.ok(legacy.t.r2.auxOps>0,'the legacy arm does use R2 for the families');
 assert.equal(d1.t.r2.auxOps,0,'S'+size+': the D1 arm touches no R2 object of the families');
 const r2ops=t=>t.r2.get+t.r2.head+t.r2.put+t.r2.list+t.r2.delete;
 assert.ok(r2ops(d1.t)<r2ops(legacy.t),'S'+size+': fewer R2 operations ('+r2ops(d1.t)+' vs '+r2ops(legacy.t)+')');
 assert.ok(legacy.t.r2.auxOps-d1.t.r2.auxOps===legacy.t.r2.auxOps);
 // D1 cost of the move: a bounded increase, written down so a regression is visible (measured about +16 % calls, +14 % write statements, +15 % written bytes)
 assert.ok(d1.t.d1.calls<=Math.ceil(legacy.t.d1.calls*1.25),'S'+size+': D1 calls within +25 % of the legacy cycle ('+d1.t.d1.calls+' vs '+legacy.t.d1.calls+')');
 assert.ok(d1.t.d1.writeStatements<=Math.ceil(legacy.t.d1.writeStatements*1.25),'S'+size+': D1 write statements ('+d1.t.d1.writeStatements+' vs '+legacy.t.d1.writeStatements+')');
 assert.ok(d1.t.d1.writeBytes<=Math.ceil(legacy.t.d1.writeBytes*1.30),'S'+size+': D1 written bytes ('+d1.t.d1.writeBytes+' vs '+legacy.t.d1.writeBytes+')');
 // every statement fits the D1 statement budget (100 KiB); no statement is anywhere near the bind limit by construction (assertStatements refuses)
 assert.ok(d1.t.d1.maxStatementBytes<=100*1024,'S'+size+': largest statement '+d1.t.d1.maxStatementBytes);
}
// the receipt of a deferred start stays a claim, not a preparation, in every arm
for(const name of ARMS)assert.ok(results['5:'+name].w.metrics.receipt.d1.calls<=6,name+': the receipt costs '+results['5:'+name].w.metrics.receipt.d1.calls+' D1 calls');
// the readback of a part is bounded: calls per part do not grow with the manifest (the covering pieces of one run only)
{
 const per=size=>results[size+':d1'].w.metrics.readback.d1.calls/(3+size);
 assert.ok(per(10)<=per(5)+0.5,'readback D1 calls per part: S10 '+per(10).toFixed(2)+' vs S5 '+per(5).toFixed(2));
}
// the history does not change the work of a cycle: an aged database (hundreds of settled runs, their manifests, sources and outbox rows) costs the same counts as an empty one
{
 const fresh=results['5:d1'];
 const aged=await arm('d1',{seed:w=>seedHistory(w,{runs:300})});
 assert.equal(rowCounts(aged).prediction_run_manifest,300);
 const runAged=await cycle(aged,{manifestSize:5});assert.equal(runAged.committed,5);
 const t=total(aged);
 assert.equal(t.d1.calls,fresh.t.d1.calls,'an aged database: the same D1 calls');assert.equal(t.d1.statements,fresh.t.d1.statements,'and the same statements');assert.equal(t.d1.writeStatements,fresh.t.d1.writeStatements);
 // the hot queries are primary-key or index searches, never a scan of a history table
 const plan=text=>{const r=sqliteSync([aged.file],{input:'EXPLAIN QUERY PLAN '+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.replace(/\s+/g,' ').trim();};
 const hot={
  'manifest row':"SELECT manifest_hash FROM prediction_run_manifest WHERE run_id='hist-000001'",
  'manifest pieces':"SELECT piece_no,text FROM prediction_run_manifest_piece WHERE run_id='hist-000001' AND piece_no BETWEEN 0 AND 3 ORDER BY piece_no",
  'source head':"SELECT current_revision FROM prediction_run_source_head WHERE run_id='hist-000001'",
  'source pieces':"SELECT piece_no,text FROM prediction_run_source_piece WHERE run_id='hist-000001' AND revision=1 ORDER BY piece_no",
  'outbox row':"SELECT state FROM prediction_event_outbox WHERE event_key='stop:hist-000001'",
  'outbox pending':"SELECT event_key FROM prediction_event_outbox WHERE state='pending' ORDER BY since, event_key LIMIT 20",
  'outbox compaction':"SELECT event_key FROM prediction_event_outbox WHERE payload_compacted=0 AND settled_at IS NOT NULL AND settled_at<'2026-01-01T00:00:00.000Z' ORDER BY settled_at, event_key LIMIT 20",
  'outbox of a run':"SELECT event_key FROM prediction_event_outbox WHERE run_id='hist-000001' AND state='pending' ORDER BY event_key LIMIT 20",
 };
 for(const [name,text] of Object.entries(hot)){const p=plan(text);assert.ok(!/\bSCAN prediction_(run_manifest|run_manifest_piece|run_source_piece|run_source_head|event_outbox)\b/.test(p),name+' must not scan a history table: '+p);assert.match(p,/SEARCH|USING/,name+': '+p);}
 // growth is by rows, never by a rewrite: a second cycle adds rows and rewrites none of the history
 assert.equal(sql(aged.file,"SELECT count(*) AS n FROM prediction_run_manifest WHERE run_id LIKE 'hist-%'")[0].n,300);
}
// the whole outbox read for the status is one grouped read plus two single-row reads: bounded, no listing of history
{
 const w=await arm('d1');await cycle(w,{manifestSize:5});
 const before=w.stats.queries+w.stats.batches;
 const Aux=await import('../src/prediction-aux-d1.js');await Aux.outboxStatus(w.db);
 assert.ok(w.stats.queries+w.stats.batches-before<=4);
}
console.log('prediction aux budget: ok');
