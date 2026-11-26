// AIR-605 (card C1; ADR 0219 decisions 2 and 6). The WORKFLOW SHELL of the Catalog Enrichment drainer: the instance body, the kick that wakes it, the parked wait and the reconcile that is the safety net. DORMANT: with no control row in
// `active` every entry point answers "not active" before it creates an instance, sends an event or makes a request; the dedicated reconcile cron is NOT in `wrangler.jsonc` (its expression is delivered by the activation
// change, not by a deploy), and the binding does nothing while the control is inactive.
//   - ONE owner at a time: the run record (one `projection_run` row named `catalog_enrichment_run`, its `summary_json`) names the live instance and its phase, `running`, `parked` or `retired`, and moves by compare-and-swap.
//     The `projection_run` lease of the drainer stays the authority for writing; the run record only says whom to wake.
//   - NO LOST WAKEUP. Parking and retiring make their INTENT DURABLE on the run record first and only then re-check for RUNNABLE work; if any exists the intent is cancelled. `kick` commits after the causal change: `parked` sends the
//     instance a `kick` event (an event sent before the wait is buffered by the platform), `running` needs none (that instance re-checks after making its intent durable), `retired` or no live owner creates the instance,
//     and a send that throws (the instance is not running) is read as "no live owner" and creates one. A lost kick is recovered by the reconcile.
//   - A `waitForEvent` that times out THROWS and would fail the instance, so it is wrapped and the timeout is the due-time wake.
//   - HANDOVER: at the statement budget the predecessor records the successor by compare-and-swap, creates it (idempotent by id) and stops; the successor writes only after it acquires its own lease.
import {drain,dueFilms,BUDGET,repairPending,DEFER_MINUTES} from './catalog-enrichment-drain.js';
import {readControl,runnableSignals} from './catalog-enrichment-store.js';

export const RUN_PROJECTION='catalog_enrichment_run';
// The safety-net cron expression. It is NOT in wrangler.jsonc: the activation change delivers it as a reviewed, versioned configuration change.
export const CRON='11-59/15 * * * *';
const WAIT_EVENT='kick';
const MAX_ROUNDS=64;
const MAX_WAIT_MS=24*3600000;
const ID=/^ce-[a-z0-9-]{1,60}$/;

const nowIso=clock=>typeof clock==='function'?clock():new Date().toISOString();
const text=value=>JSON.stringify(value);

// ---- the run record ----
export async function readRunRecord(env){
 const row=await env.DB.prepare('SELECT summary_json FROM projection_run WHERE projection=?').bind(RUN_PROJECTION).first();
 if(!row)return {exists:false,text:null,record:{phase:'retired',instance:null,seq:0,wakeAt:null,successor:null,at:null}};
 let record=null;
 try{record=JSON.parse(row.summary_json||'null');}catch{record=null;}
 return {exists:true,text:row.summary_json??null,record:record&&typeof record==='object'?{phase:record.phase||'retired',instance:record.instance||null,seq:Number(record.seq)||0,wakeAt:record.wakeAt||null,successor:record.successor||null,at:record.at||null}:{phase:'retired',instance:null,seq:0,wakeAt:null,successor:null,at:null}};
}
// Compare-and-swap on the stored text; an absent row is inserted. -> boolean (this caller moved it).
export async function casRunRecord(env,before,next){
 const body=text(next);
 if(!before.exists){
  await env.DB.prepare('INSERT INTO projection_run (projection,summary_json) VALUES (?,?) ON CONFLICT(projection) DO NOTHING').bind(RUN_PROJECTION,body).run();
 }else{
  await env.DB.prepare('UPDATE projection_run SET summary_json=? WHERE projection=? AND summary_json IS ?').bind(body,RUN_PROJECTION,before.text).run();
 }
 const after=await env.DB.prepare('SELECT summary_json FROM projection_run WHERE projection=?').bind(RUN_PROJECTION).first();
 return after?.summary_json===body;
}
const instanceId=seq=>'ce-'+String(seq).padStart(8,'0');

// ---- instances ----
async function createInstance(env,id){
 const binding=env.CATALOG_ENRICHMENT_WORKFLOW;
 if(!binding||typeof binding.create!=='function')return {ok:false,reason:'workflow_unavailable'};
 if(!ID.test(id))return {ok:false,reason:'invalid_id'};
 try{await binding.create({id,params:{instance:id}});return {ok:true,reason:'started'};}
 catch(error){return /already.*(exist|running)|exists/i.test(String(error?.message||error))?{ok:true,reason:'attached'}:{ok:false,reason:'create_uncertain'};}
}
async function sendKick(env,id,now){
 const binding=env.CATALOG_ENRICHMENT_WORKFLOW;
 if(!binding||typeof binding.get!=='function')return false;
 try{const instance=await binding.get(id);await instance.sendEvent({type:WAIT_EVENT,payload:{at:now}});return true;}
 catch{return false;} // the instance is not running: no live owner
}

// Is there RUNNABLE work now? A runnable signal, or a Film that is due. Held, unresolved, backed-off and deferred items are not runnable, so they can neither keep a run spinning nor cancel a park.
export async function hasRunnable(env,{now}){
 if((await runnableSignals(env,{now,limit:1})).length)return true;
 if(await repairPending(env))return true; // a new code version has deferred items waiting for their wake
 const due=await dueFilms(env,{now,window:1});
 return due.live.length+due.background.length>0;
}

export const OWNER_GRACE_MS=120000;
async function ownerLive(env,record,now){
 const lease=await env.DB.prepare("SELECT lease_until FROM projection_run WHERE projection='catalog_enrichment' AND lease_id IS NOT NULL").first();
 if(lease?.lease_until&&lease.lease_until>now)return true;
 return !!record.at&&Date.parse(now)-Date.parse(record.at)<OWNER_GRACE_MS;
}

// ---- kick: called by a causal writer after its commit, best effort (ctx.waitUntil) ----
export async function kick(env,{clock}={}){
 const now=nowIso(clock);
 const control=await readControl(env);
 if(control.state!=='active')return {kicked:false,reason:'not_active'};
 for(let round=0;round<4;round++){
  const run=await readRunRecord(env);
  const {record}=run;
  // A `running` record is believed only while its owner is alive: a live drainer lease, or a record moved within the grace window. A crashed instance never strands the work.
  if(record.phase==='running'&&!record.successor&&await ownerLive(env,record,now))return {kicked:true,mode:'running'}; // that instance re-checks after it makes its intent durable
  const target=record.successor||record.instance;
  if(record.phase==='parked'||record.successor){
   if(target&&await sendKick(env,target,now))return {kicked:true,mode:'event',instance:target};
  }
  // retired, or no live owner: claim the next instance id by compare-and-swap, then create it (idempotent by id)
  const seq=record.seq+1;
  const next={phase:'running',instance:instanceId(seq),seq,wakeAt:null,successor:null,at:now};
  if(!await casRunRecord(env,run,next))continue;
  const created=await createInstance(env,next.instance);
  if(!created.ok){await casRunRecord(env,{exists:true,text:text(next)},{...next,phase:'retired',instance:null,at:now}).catch(()=>{});return {kicked:false,reason:created.reason};}
  return {kicked:true,mode:'created',instance:next.instance};
 }
 return {kicked:false,reason:'contended'};
}
// The safety net (the dedicated cron): a lost kick, an old Worker version or a crash after a commit never strands runnable work. Cheap and idle when nothing is runnable.
export async function reconcile(env,{clock}={}){
 const now=nowIso(clock);
 const control=await readControl(env);
 if(control.state!=='active')return {reconciled:false,reason:'not_active'};
 if(!await hasRunnable(env,{now}))return {reconciled:true,created:false,reason:'nothing_runnable'};
 return {reconciled:true,...await kick(env,{clock})};
}

// ---- the instance body ----
// payload: {instance}. deps: {tools, fetchImpl, coordinator?:()=>coordinator, clock?, budget?}. step: the Workflow step (without one, an offline run executes the callbacks inline).
export async function run(env,payload,step,deps={}){
 const id=typeof payload?.instance==='string'&&ID.test(payload.instance)?payload.instance:null;
 if(!id)return {stop:'invalid_instance'};
 const clock=deps.clock||(()=>new Date().toISOString());
 const doStep=(name,fn)=>step&&step.do?step.do(name,fn):fn();
 const sleepFor=async(name,ms,wakeAt)=>{
  // the platform buffers an event sent before the wait starts; a timeout THROWS, so it is wrapped and means "due"
  if(step&&typeof step.waitForEvent==='function'){try{await step.waitForEvent(name,{type:WAIT_EVENT,timeout:Math.max(1000,Math.min(ms,MAX_WAIT_MS))});}catch{/* the due-time wake */}}
  else if(step&&typeof step.sleep==='function')await step.sleep(name,Math.max(1000,Math.min(ms,MAX_WAIT_MS)));
  void wakeAt;
 };
 let last='none';
 // INSTANCE-level accounting: the statements every executed step issued (failed calls included) accumulate across the steps of this instance, so the instance hands over at its own budget instead of every step starting
 // from zero; a replayed (cached) step issues nothing and adds nothing.
 let spent=0,errorRounds=0;
 const base=deps.budget||BUDGET;
 for(let round=0;round<MAX_ROUNDS;round++){
  const control=await readControl(env);
  if(control.state!=='active'){await settle(env,id,'retired');return {stop:control.state==='paused'?'paused':'not_active',rounds:round};}
  // the remaining instance budget bounds this step; with less left than one step needs, the instance hands over without starting it
  const remaining={...base,statements:base.statements-spent,handoverAt:base.handoverAt-spent};
  const exhausted=remaining.handoverAt<=0||remaining.statements-remaining.reserve<(base.stepEstimate||150);
  const result=exhausted?{stop:'handover',wakeAt:null,counts:{statements:0}}:await doStep('drain-'+round,async()=>{
   const out=await drain(env,{runId:id+'-'+round,clock,tools:deps.tools,fetchImpl:deps.fetchImpl,coordinator:deps.coordinator?deps.coordinator():null,budget:remaining,...(deps.shouldYield?{shouldYield:deps.shouldYield}:{})});
   return {stop:out.stop,wakeAt:out.wakeAt||null,counts:out.counts};
  });
  spent+=Number(result.counts?.statements)||0;
  last=result.stop;
  if(result.stop==='handover'){
   // the predecessor records the successor by compare-and-swap, creates it (idempotent by id) and stops; the successor re-checks the runnable work in full
   const run0=await readRunRecord(env);
   // the successor is strictly newer than this instance and than the record: it can never be this instance's own id
   const seq=Math.max(run0.record.seq,Number(id.slice(3))||0)+1,successor=instanceId(seq);
   if(await casRunRecord(env,run0,{phase:'running',instance:successor,seq,wakeAt:null,successor:null,at:nowIso(clock)})){
    const created=await createInstance(env,successor);
    if(!created.ok){await settle(env,id,'retired');return {stop:'handover_failed',reason:created.reason};}
    return {stop:'handover',successor};
   }
   continue; // another writer moved the record: re-read and decide again
  }
  if(result.stop==='parked'){
   // intent first, then the re-check: runnable work cancels the park
   const parked=await settle(env,id,'parked',{wakeAt:result.wakeAt});
   if(await hasRunnable(env,{now:nowIso(clock)})){await settle(env,id,'running');continue;}
   const ms=result.wakeAt?Math.max(0,Date.parse(result.wakeAt)-Date.parse(nowIso(clock))):MAX_WAIT_MS;
   await sleepFor('park-'+round,ms,result.wakeAt);
   await settle(env,id,'running');
   void parked;
   continue;
  }
  if(result.stop==='idle'){
   await settle(env,id,'retired');
   // the terminal empty-queue exit uses the same protocol: intent durable, then the re-check
   if(await hasRunnable(env,{now:nowIso(clock)})){await settle(env,id,'running');continue;}
   return {stop:'idle',rounds:round+1};
  }
  // YIELD (the narrow EPG hold) and ERROR BACKOFF are deliberate holds, not an absence of work: the instance parks until the holder's lease expiry, or by the ADR 0098 tiers (1, 5, 15 minutes, then hourly) after repeated
  // storage or authority failures, and a kick wakes it earlier. The hold is NOT cancelled by the runnable-work re-check (that work is exactly what is held), so a repeated yield is one parked wait, never a loop.
  if(result.stop==='yield'||result.stop==='error_backoff'){
   errorRounds=result.stop==='error_backoff'?errorRounds+1:0;
   const now=Date.parse(nowIso(clock));
   const until=result.stop==='yield'&&result.wakeAt?Date.parse(result.wakeAt):now+DEFER_MINUTES[Math.min(errorRounds-1,DEFER_MINUTES.length-1)]*60000;
   await settle(env,id,'parked',{wakeAt:new Date(until).toISOString()});
   await sleepFor('hold-'+round,Math.max(1000,until-now),null);
   await settle(env,id,'running');
   continue;
  }
  errorRounds=0;
  if(result.stop==='generation_moved'){continue;}
  await settle(env,id,'retired');
  return {stop:result.stop,rounds:round+1};
 }
 await settle(env,id,'retired');
 return {stop:last==='none'?'rounds':last,rounds:MAX_ROUNDS};
}
// Moves the run record for THIS instance only: a record that already names another instance (a handover, a newer owner) is never overwritten. -> boolean
async function settle(env,id,phase,extra={}){
 for(let attempt=0;attempt<4;attempt++){
  const current=await readRunRecord(env);
  const {record}=current;
  if(record.instance&&record.instance!==id&&record.successor!==id)return false;
  if(record.phase===phase&&record.instance===id&&(extra.wakeAt??null)===(record.wakeAt??null))return true;
  if(await casRunRecord(env,current,{phase,instance:id,seq:record.seq,wakeAt:extra.wakeAt??null,successor:null,at:new Date().toISOString()}))return true;
 }
 return false;
}
