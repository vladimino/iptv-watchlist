// AIR-605 (card C1; ADR 0219 decisions 2, 5 and 6). The RESOURCE-BOUNDED, WORK-CONSERVING QUEUE DRAINER of the Catalog Enrichment Producer. DORMANT: nothing in the Worker imports it; with no active control it answers
// `not_active` before any request. One call is ONE RUN (the body of a Workflow instance): it owns the `projection_run` lease, consumes the runnable signals of the inbox (guarded, exactly once), picks due Films live-first
// with a background share measured in COMMITTED units (about one in eight), processes each Film through the producer step, and stops only for a REASON:
//   idle       no runnable work and nothing deferred;     parked    every remaining item is deferred: `wakeAt` is the earliest due time;
//   handover   the statement budget: the caller creates the successor;   paused / generation_moved   the control;   lease_lost / lease_held   the lease;   yield   the EPG publication window (injected predicate).
// There are NO throughput quotas here (no 2-Film bound, no tick deadline): the only budgets are safety budgets: statements (failing and replayed calls included), steps and the lease. A local stop never counts toward the
// 72 h fallback and sets no cooldown: the producer step handles outcomes, this module only schedules.
import {database,many,one} from './film-person-authority.js';
import {acquireLease,consumeSignal,readControl,releaseLease,renewLease,runnableSignals} from './catalog-enrichment-store.js';
import {nextClass,priorityClass} from './catalog-enrichment-plan.js';
import {processFilm} from './catalog-enrichment-producer.js';

// Engineering-owned defaults (ADR 0219 decision 6), one module, reported in each run's outbox entry. The statement budget is the ADR 0094 guard, not a provider limit; a handover happens at HANDOVER_AT, half the documented
// 10,000; a step starts only when the remaining budget covers its own work plus the finalize-and-successor reserve.
export const BUDGET=Object.freeze({statements:6000,handoverAt:5000,reserve:1000,window:50,stepEstimate:150,unitEstimate:60});

// A D1 binding that counts every statement it issues, failing calls included.
export function countingEnv(env){
 const base=database(env);
 const counter={statements:0,failed:0};
 const wrapStatement=statement=>new Proxy(statement,{get(target,prop){
  if(prop==='run'||prop==='first'||prop==='all')return async(...args)=>{counter.statements++;try{return await target[prop](...args);}catch(error){counter.failed++;throw error;}};
  return target[prop];
 }});
 const wrapped=new Proxy(base,{get(target,prop){
  if(prop==='prepare')return sql=>{const prepared=target.prepare(sql);return new Proxy(prepared,{get(inner,name){
   if(name==='bind')return(...params)=>wrapStatement(inner.bind(...params));
   if(name==='run'||name==='first'||name==='all')return async(...args)=>{counter.statements++;try{return await inner[name](...args);}catch(error){counter.failed++;throw error;}};
   return inner[name];
  }});};
  if(prop==='batch')return async list=>{counter.statements+=list.length;try{return await target.batch(list);}catch(error){counter.failed+=list.length;throw error;}};
  const value=target[prop];
  return typeof value==='function'?value.bind(target):value;
 }});
 return {env:{...(env&&env.DB?env:{}),DB:wrapped},counter};
}

// Due Films, oldest first by due_since within a class. A pick examines at most `window` rows at the head of the index per class; an item that failed or was backed off has its retry_at in the future, so it leaves the head
// and cannot block independent work. Facts: personal (an authoritative Watchlist member) is known; availability in the pinned EPG generation is not read here and is UNKNOWN (null), which is never read as false.
export async function dueFilms(env,{now,window=BUDGET.window,skip=new Set()}){
 const handle=database(env);
 const heads=await many(handle,`SELECT s.film_id AS film_id,MIN(s.due_since) AS due_since,MIN(CASE WHEN s.part='film' THEN 0 ELSE 1 END) AS check_first FROM catalog_enrichment_state s WHERE s.film_id IN (SELECT m.film_id FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_state f WHERE f.film_id=s.film_id AND f.part='film' AND f.status='identity_disagreement') AND ((s.part<>'film' AND s.status IN ('due','deferred_repair') AND (s.retry_at IS NULL OR s.retry_at<=?) AND NOT (s.part='core' AND EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id=s.film_id AND d.dimension='metadata' AND (d.status='reviewed' OR COALESCE(d.authority,'')='owner')))) OR (s.part='film' AND s.reason='check_anchors')) GROUP BY s.film_id ORDER BY MIN(s.due_since),s.film_id LIMIT ?`,[now,window*2]);
 const out={live:[],background:[]};
 for(const row of heads){
  if(skip.has(row.film_id))continue;
  const personal=!!await one(handle,'SELECT 1 AS x FROM watchlist_film WHERE film_id=?',[row.film_id]);
  const cohorts=new Set(['live']);
  const klass=priorityClass({cohorts,personal:personal?true:null,available:null});
  out[klass].push({filmId:row.film_id,dueSince:row.due_since});
 }
 return out;
}
// The earliest time a deferred item becomes runnable again, or null: the due time of a parked run.
export async function earliestWake(env,{now}){
 const row=await one(database(env),`SELECT MIN(s.retry_at) AS at FROM catalog_enrichment_state s WHERE s.film_id IN (SELECT m.film_id FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1) AND s.part<>'film' AND s.status IN ('due','deferred_repair') AND s.retry_at>?`,[now]);
 return row?.at??null;
}

// One run. opts: {runId, clock:()=>iso, tools, fetchImpl, coordinator, budget, shouldYield?:async()=>boolean, maxFilms?}. -> {stop, wakeAt?, counts}
export async function drain(rawEnv,{runId,clock=()=>new Date().toISOString(),tools,fetchImpl,coordinator=null,budget=BUDGET,shouldYield=null,maxFilms=Infinity}){
 const {env,counter}=countingEnv(rawEnv);
 const counts={films:0,signals:0,units:0,committedLive:0,committedBackground:0,statements:0,failedStatements:0,requests:0,transport:0,failed:0,disagreements:0,steps:0,errors:0};
 const finish=(stop,extra={})=>({stop,...extra,counts:{...counts,statements:counter.statements,failedStatements:counter.failed}});
 const control=await readControl(env);
 if(control.state!=='active')return finish(control.state==='paused'?'paused':'not_active');
 const generation=control.generation;
 const leaseId='lease-'+runId;
 const lease=await acquireLease(env,{leaseId,now:clock()});
 if(!lease.acquired)return finish('lease_held');
 const tickId=runId;
 const handle=database(env);
 try{await handle.prepare("INSERT INTO catalog_enrichment_tick (tick_id,started_at,state,counts_json) VALUES (?,?,'started','{}') ON CONFLICT(tick_id) DO NOTHING").bind(tickId,clock()).run();}catch{/* the outbox never blocks the work */}
 let result;
 // Films this run processed without any progress (blocked, waiting, nothing due): not picked again in this run, so a deferred or blocked Film can never keep a run spinning.
 const skip=new Set();
 try{
  result=await loop();
 }finally{
  try{await handle.prepare("UPDATE catalog_enrichment_tick SET state=?,finished_at=?,counts_json=? WHERE tick_id=?").bind(result?.stop==='handover'||result?.stop==='idle'||result?.stop==='parked'?'finished':'stopped',clock(),JSON.stringify({...(result?.counts||counts),stop:result?.stop||'error',budget:{statements:budget.statements,handoverAt:budget.handoverAt}}),tickId).run();}catch{/* best effort */}
  try{await releaseLease(env,{leaseId,now:clock()});}catch{/* the lease expires */}
 }
 return result;

 async function loop(){
  for(;;){
   // a step starts only when the remaining budget covers its own work plus the reserve (no whole-Film-fit rule: a Film spans as many steps and runs as it needs)
   if(counter.statements+budget.stepEstimate+budget.reserve>budget.statements||counter.statements>=budget.handoverAt)return finish('handover');
   const fresh=await readControl(env);
   if(fresh.state==='paused')return finish('paused');
   if(fresh.state!=='active')return finish('not_active');
   if(fresh.generation!==generation)return finish('generation_moved');
   if(!await renewLease(env,{leaseId,now:clock()}))return finish('lease_lost');
   if(shouldYield&&await shouldYield())return finish('yield');
   // the inbox first: runnable signals are consumed exactly once, each by one guarded batch; one failing signal never blocks the others
   let consumed=0;
   for(const signal of await runnableSignals(env,{now:clock(),limit:50})){
    const outcome=await consumeSignal(env,{signal,generation,leaseId,now:clock()});
    if(outcome.consumed){consumed++;counts.signals++;}
   }
   const due=await dueFilms(env,{now:clock(),skip});
   const klass=nextClass({hasLive:due.live.length>0,hasBackground:due.background.length>0,committedLive:counts.committedLive,committedBackground:counts.committedBackground});
   if(!klass){
    if(consumed)continue; // new work may have become due by the signals just consumed
    const wakeAt=await earliestWake(env,{now:clock()});
    return wakeAt?finish('parked',{wakeAt}):finish('idle');
   }
   if(counts.films>=maxFilms)return finish('handover');
   const pick=due[klass][0];
   let step;
   // the unit-group gate: before EVERY group of units of a Film the producer asks whether the remaining budget covers it plus the finalize-and-successor reserve (no whole-Film-fit rule: a Film resumes from its persisted state)
   const gate={canStart:()=>counter.statements+(budget.unitEstimate||60)+budget.reserve<=budget.statements&&counter.statements<budget.handoverAt};
   try{step=await processFilm(env,{filmId:pick.filmId,leaseId,generation,now:clock(),tools,fetchImpl,coordinator,budget:gate});}
   catch(error){
    // Reactive yield (ADR 0219 decision 6): a storage or authority failure defers THIS Film for the rest of the run and the independent work continues; repeated failures back the whole run off. Never a crash.
    counts.errors++;skip.add(pick.filmId);counts.lastError=String(error?.code||'error').slice(0,80);
    if(counts.errors>=3)return finish('error_backoff');
    continue;
   }
   counts.steps++;
   if(step.state==='not_active')return finish('generation_moved');
   if(step.report){
    counts.films++;
    const committed=step.report.units.filter(unit=>['applied'].includes(unit.state)).length;
    counts.units+=committed;
    if(klass==='live')counts.committedLive+=committed;else counts.committedBackground+=committed;
    counts.transport+=step.report.transport.length;counts.failed+=step.report.failed.length;if(step.report.disagreement)counts.disagreements++;
    counts.requests+=step.report.transport.length+step.report.failed.length;
   }
   if(['idle','blocked','not_admitted','absent','redirected'].includes(step.state)||(step.state==='done'&&!step.report.units.length))skip.add(pick.filmId);
   if(step.state==='partial')return finish('handover'); // progress is durable per unit: the successor resumes this Film from D1, without a new upstream request
   // a Film that made no progress (blocked, a parked source, a replan that only settled a marker) leaves the head by its own retry_at or state; a replan is cheap and continues at once
   if(step.state==='absent'||step.state==='redirected'||step.state==='not_admitted')await handle.prepare("UPDATE catalog_enrichment_state SET reason=NULL WHERE film_id=? AND part='film' AND reason='check_anchors'").bind(pick.filmId).run().catch(()=>{});
  }
 }
}
