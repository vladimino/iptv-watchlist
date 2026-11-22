// AIR-553 / ADR 0194: the paired whole-cycle benchmark of the batch_v2 auxiliary state, R2 (baseline) against D1 (candidate), on ONE revision. Non-functional evidence: it never fails on a latency, and it
// is NOT run by the core suite. It runs the cycle of tests/prediction-aux-bench-lib.mjs (receipt, preparation, bounded readback, submits in groups of five, heartbeat, complete) for the S5, S7 and S10
// workloads (manifestSize 5, 7, 10; generationSize 1; submitBatchSize 5, as the Task prompts have them), in three arms over the same seeded queue, profile and catalog, repeated in alternating order.
//   node scripts/prediction-aux-benchmark.mjs [--pairs 12] [--aged 1000] [--json]
// Counts (R2 operations, D1 calls, batches, statements, written statements and bytes) are exact and repeatable. Wall time is the LOCAL stand-in: a sqlite process per D1 statement and an in-memory R2. It
// penalizes D1 calls and makes R2 free, so it is NOT Cloudflare latency and must not be read as a prediction of it; it is reported only because the card asks for the distribution, with its caveat.
import {arm,cycle,total,rowCounts,fileBytes,seedHistory,ARMS} from '../tests/prediction-aux-bench-lib.mjs';
import {sql} from '../tests/prediction-d1-flow-lib.mjs';

const flag=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i>=0?Number(process.argv[i+1]):fallback;};
const PAIRS=flag('pairs',12),AGED=flag('aged',1000),SIZES=[5,7,10];
const nearest=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted.length?sorted[Math.min(sorted.length-1,Math.max(0,Math.ceil(p*sorted.length)-1))]:null;};
const stat=values=>({n:values.length,p50:Math.round(nearest(values,.5)*10)/10,p95:Math.round(nearest(values,.95)*10)/10});
const r2ops=t=>t.r2.get+t.r2.head+t.r2.put+t.r2.list+t.r2.delete;
const out={revision:null,pairs:PAIRS,workloads:{},aged:{},scenarios:{},growth:{},caveat:'Local sqlite and in-memory R2 stand-ins: wall time is not Cloudflare latency; counts are exact.'};

// 1. Normal cycles: alternate the arm order each pair so drift does not favour an arm.
for(const size of SIZES){
 const samples=Object.fromEntries(ARMS.map(name=>[name,{ms:[],phases:{},counts:null}]));
 for(let pair=0;pair<PAIRS;pair++){
  const order=pair%2?[...ARMS].reverse():ARMS;
  for(const name of order){
   const w=await arm(name);const run=await cycle(w,{manifestSize:size});const t=total(w);
   samples[name].ms.push(t.ms);
   for(const [phase,m] of Object.entries(w.metrics))(samples[name].phases[phase]??=[]).push(m.ms);
   samples[name].counts={films:run.films,committed:run.committed,d1Calls:t.d1.calls,d1Batches:t.d1.batches,d1Statements:t.d1.statements,d1WriteStatements:t.d1.writeStatements,d1WriteBytes:t.d1.writeBytes,d1MaxStatementBytes:t.d1.maxStatementBytes,r2Ops:r2ops(t),r2Get:t.r2.get,r2Put:t.r2.put,r2AuxOps:t.r2.auxOps,r2PutBytes:t.r2.putBytes,phases:Object.fromEntries(Object.entries(w.metrics).map(([phase,m])=>[phase,{d1Calls:m.d1.calls,r2Ops:m.r2.get+m.r2.head+m.r2.put+m.r2.list+m.r2.delete,r2AuxOps:m.r2.auxOps}]))};
  }
 }
 out.workloads['S'+size]=Object.fromEntries(ARMS.map(name=>[name,{...samples[name].counts,wallMs:stat(samples[name].ms),phaseWallMs:Object.fromEntries(Object.entries(samples[name].phases).map(([phase,v])=>[phase,stat(v)]))}]));
}

// 2. Aged history (the D1 arm only: the legacy arm's R2 keys do not change the work of a cycle).
for(const runs of [0,300,AGED]){
 const samples=[];let counts=null;
 for(let i=0;i<Math.max(3,Math.floor(PAIRS/3));i++){
  const w=await arm('d1',{seed:runs?w=>seedHistory(w,{runs}):null});const run=await cycle(w,{manifestSize:5});const t=total(w);samples.push(t.ms);
  counts={historyRuns:runs,d1Calls:t.d1.calls,d1Statements:t.d1.statements,d1WriteStatements:t.d1.writeStatements,committed:run.committed,dbBytes:fileBytes(w)};
 }
 out.aged['history'+runs]={...counts,wallMs:stat(samples)};
}

// 3. Growth: what one cycle adds to the D1 arm (rows by table, database bytes), and what a day of four hourly Tasks would add (96 starts; a start that is turned away adds one small outbox row).
{
 const w=await arm('d1');const before=fileBytes(w),rows0=rowCounts(w);await cycle(w,{manifestSize:5});await cycle(w,{manifestSize:5});
 const rows=rowCounts(w);const added=Object.fromEntries(Object.keys(rows).map(t=>[t,rows[t]-rows0[t]]));
 out.growth={cyclesMeasured:2,rowsAddedPerTwoCycles:added,dbBytesPerCycle:Math.round((fileBytes(w)-before)/2),note:'sqlite page growth of the stand-in; D1 storage accounting differs. Under the accepted retention the manifest and source history is kept indefinitely, so growth is linear: bytes per cycle x runs per day.'};
 out.growth.projectedBytesPerDayAt96Runs=out.growth.dbBytesPerCycle*96;
}

// 4. Recovery / held / outbox scenarios, whole cycles, counts per arm.
const recoveryScenario=async name=>{
 const w=await arm(name);
 // run 1: start, hold two films, an external stop; run 2 (measured) drains the stage under its own lease
 const key=JSON.parse((await w.tool('prediction_batch_key',{})).content[0].text).invocationKey;
 const receipt=await w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:5,deferred:true,invocationKey:key,capacity:{remainingPercent:100}});
 await w.ctx.runPredictionStartWorkflow(w.env,w.instances[w.instances.length-1].params,w.step);
 const runId=receipt.data.runId,env=JSON.parse((await w.tool('prediction_batch_manifest',{runId,part:'envelope'})).content[0].text);
 const ids=env.parts.filter(p=>p.kind==='film').map(p=>p.filmId),film=async id=>JSON.parse((await w.tool('prediction_batch_manifest',{runId,part:'film',filmId:id})).content[0].text).film;
 const items=[];for(const id of ids.slice(0,2)){const f=await film(id);items.push({filmId:id,...(f.plan==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction});}
 const held=await w.api('batch/hold',{runId,epoch:env.lease.epoch,items});if(held.status!==200)throw new Error('hold '+held.status);
 await w.api('complete',{runId,reason:'external_termination'});
 w.metrics={};
 const run=await cycle(w,{manifestSize:5});const t=total(w);
 return {committed:run.committed,d1Calls:t.d1.calls,d1WriteStatements:t.d1.writeStatements,r2Ops:r2ops(t),r2AuxOps:t.r2.auxOps,prepareD1Calls:w.metrics.prepare.d1.calls,prepareR2Ops:w.metrics.prepare.r2.get+w.metrics.prepare.r2.put};
};
const outageScenario=async name=>{
 const w=await arm(name);
 const real=w.env.BUCKET.put;let down=true;w.env.BUCKET.put=async(key,...rest)=>{if(down&&key.startsWith('events/items/'))throw new Error('journal outage');return real(key,...rest);};
 await cycle(w,{manifestSize:5,skipRefusal:true});down=false;w.metrics={};
 const run=await cycle(w,{manifestSize:5});const t=total(w);
 return {committed:run.committed,d1Calls:t.d1.calls,r2Ops:r2ops(t),r2AuxOps:t.r2.auxOps,prepareD1Calls:w.metrics.prepare.d1.calls};
};
const refusalScenario=async name=>{const w=await arm(name);await cycle(w,{manifestSize:5,skipRefusal:true});const m=w.metrics.refusal;return {d1Calls:m.d1.calls,d1WriteStatements:m.d1.writeStatements,r2Ops:m.r2.get+m.r2.head+m.r2.put+m.r2.list+m.r2.delete,r2AuxOps:m.r2.auxOps};};
for(const [label,fn] of [['heldStageDrain',recoveryScenario],['outboxOutageRecovery',outageScenario],['refusedStart',refusalScenario]])out.scenarios[label]=Object.fromEntries(await Promise.all(ARMS.map(async name=>[name,await fn(name)])));
void sql;

if(process.argv.includes('--json'))process.stdout.write(JSON.stringify(out,null,1)+'\n');
else{
 const pct=(a,b)=>b?((a-b)/b*100>=0?'+':'')+((a-b)/b*100).toFixed(1)+' %':'n/a';
 for(const [size,arms] of Object.entries(out.workloads)){
  console.log('\n## '+size+' ('+PAIRS+' paired cycles per arm; counts exact, wall time local)');
  console.log('| arm | D1 calls | D1 batches | D1 statements | D1 write stmts | D1 written bytes | R2 ops | R2 aux ops | wall p50 ms | wall p95 ms |');console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for(const name of ARMS){const a=arms[name];console.log('| '+name+' | '+[a.d1Calls,a.d1Batches,a.d1Statements,a.d1WriteStatements,a.d1WriteBytes,a.r2Ops,a.r2AuxOps,a.wallMs.p50,a.wallMs.p95].join(' | ')+' |');}
  const l=arms.legacy,d=arms.d1;console.log('d1 vs legacy: D1 calls '+pct(d.d1Calls,l.d1Calls)+', write statements '+pct(d.d1WriteStatements,l.d1WriteStatements)+', written bytes '+pct(d.d1WriteBytes,l.d1WriteBytes)+', R2 ops '+pct(d.r2Ops,l.r2Ops)+'.');
 }
 console.log('\n'+JSON.stringify({aged:out.aged,growth:out.growth,scenarios:out.scenarios},null,1));
}
