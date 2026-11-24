// AIR-594. Canonical Producer outcome reports in the user Events Log (`type: canonical_producer`, «Обогащение каталога»).
// Pure decisions plus the R2 delivery of the hourly reconcile. No import: the Worker bundle scopes this file as `CanonicalProducerEvents` and the
// Producer reconcile (`reconcileProducerChain`, src/canonical-producer-workflow.js) is its only caller. Nothing here runs inside a Producer Workflow
// instance, so the instance D1 budget (ADR 0141 D5) is not touched; nothing here writes D1, a lease, a receipt or a chain.
//
// Source of truth: the durable chain row of P and the Producer run row of the same (P, g), both read by the reconcile. An outcome is
// reported only from a durable terminal state of the chain, observed by the reconcile BEFORE the reconcile moves the chain on:
//   passed      owner_state `complete` (written in the same batch as the run's `passed` claim)    id ...-g<g>-passed       one per (P, g)
//   stopped     owner_state `stopped` (a stop written by the owner)                              id ...-e<epoch>-stopped  one per (P, owner epoch)
//   superseded  a chain the reconcile itself superseded while it was pending, active or released  id ...-e<epoch>-superseded
// A stopped chain that is recovered runs in a new epoch, so a later stop or the pass is a NEW event; a duplicate observation (every hourly tick while the
// state lasts, overlapping ticks) has the same id and the same frozen `at` and payload. Handoffs, takeovers, relaunches, lease renewals, slices and budget
// yields are not outcomes: they are counted on the chain row and copied as counts.
//
// Delivery: one create-only put to `events/items/<reverse-timestamp>-<id>.json` (a repeat finds the key and writes nothing). A failed put is queued in the
// bounded ledger `events/canonical-producer-outbox.json` (compare-and-swap on its etag) BEFORE the reconcile moves the chain, and every later tick retries it.
// The ledger also keeps the recently settled ids (so a lasting state is not re-read every hour) and `baselineAt`: outcomes older than the ledger's first
// write are never reported (no retroactive events). A failed journal put never changes what the reconcile does next.
export const PRODUCER_EVENT_TYPE='canonical_producer';
export const PRODUCER_EVENT_LEDGER_KEY='events/canonical-producer-outbox.json';
export const PRODUCER_EVENT_LEDGER_SCHEMA=1;
export const PRODUCER_EVENT_SETTLED_MAX=64;
export const PRODUCER_EVENT_PENDING_MAX=32;
export const PRODUCER_EVENT_DRAIN_MAX=8;
export const PRODUCER_EVENT_PUT_TRIES=2;
export const PRODUCER_EVENT_CAS_TRIES=3;
export const PRODUCER_EVENT_OUTCOMES=Object.freeze(['passed','stopped','superseded']);
// The recovery classes the hourly reconcile restarts by itself (the same set as PRODUCER_OPEN_CHAIN_PREDICATE and `recoverChain`).
export const PRODUCER_AUTOMATIC_RECOVERY=Object.freeze(['transient','receipt','authority']);
const IN_FLIGHT=['pending','active','released'];
const CODE=/^[a-z][a-z_0-9]{0,79}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const isTime=value=>typeof value==='string'&&value.length>=20&&value.length<=40&&Number.isFinite(Date.parse(value));
const count=value=>{const n=Number(value);return value!==null&&value!==undefined&&value!==''&&Number.isInteger(n)&&n>=0?n:null;};
function fnv(text){
 let h=2166136261>>>0;
 for(let i=0;i<text.length;i++)h=Math.imul(h^text.charCodeAt(i),16777619)>>>0;
 return h.toString(16).padStart(8,'0');
}
// The programme run part of an id: a canonical UUID without its dashes (lossless), anything else as a bounded slug plus a hash of the exact value.
export function programmeToken(programmeRunId){
 const raw=String(programmeRunId||'');
 const lower=raw.toLowerCase();
 if(UUID.test(lower))return lower.replace(/-/g,'');
 return (lower.replace(/[^a-z0-9]/g,'').slice(0,24)||'p')+'-'+fnv(raw);
}
export function producerEventKey(event){return 'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';}

// The outcome a chain row proves by itself, or null (not terminal, or not an outcome of this module).
export function chainOutcome(chain){
 if(!chain||typeof chain!=='object')return null;
 if(chain.owner_state==='complete')return 'passed';
 if(chain.owner_state==='stopped')return 'stopped';
 return null;
}
export function producerEventId(chain,outcome){
 if(!chain||!PRODUCER_EVENT_OUTCOMES.includes(outcome))return null;
 const p=programmeToken(chain.programme_run_id);
 if(outcome==='passed'){
  const g=count(chain.input_generation);
  return g===null?null:'canonical_producer-'+p+'-g'+g+'-passed';
 }
 const epoch=count(chain.owner_epoch);
 return epoch===null||epoch<1?null:'canonical_producer-'+p+'-e'+epoch+'-'+outcome;
}
// The frozen time of an outcome: the run's own completion for a pass (the chain row records the same commit), else the chain write that made it terminal.
export function outcomeAt(chain,run,outcome){
 if(outcome==='passed'&&run&&isTime(run.completed_at))return new Date(Date.parse(run.completed_at)).toISOString();
 return isTime(chain?.updated_at)?new Date(Date.parse(chain.updated_at)).toISOString():null;
}
// Who resumes a stopped chain: `automatic` exactly when the hourly `recoverChain` would restart it at the outcome time (its class, its attempt cap and its
// 24 h streak window), `owner` otherwise. `caps` are CHAIN_RECOVERY_ATTEMPT_CAP and CHAIN_RECOVERY_WINDOW_MS of the fence module.
export function recoveryOf(chain,at,caps={}){
 const klass=chain?.recovery_class;
 if(typeof klass!=='string'||!klass)return null;
 if(!PRODUCER_AUTOMATIC_RECOVERY.includes(klass))return 'owner';
 if(klass==='authority')return 'automatic';
 const attempts=count(chain.recovery_attempts)??0;
 if(Number.isInteger(caps.attempts)&&attempts>=caps.attempts)return 'owner';
 if(Number.isFinite(caps.windowMs)&&isTime(chain.streak_started_at)&&isTime(at)&&Date.parse(at)-Date.parse(chain.streak_started_at)>=caps.windowMs)return 'owner';
 return 'automatic';
}

// The event of one outcome. `run` is the run row of the same (P, g) or null (none yet, or unreadable: every run number is then unknown, never 0).
// Counts are the RUN's (all passes of that P:g; a replayed pass keeps counting), chain counts are the CHAIN's (every generation of that programme run).
export function producerEvent({chain,run=null,outcome,caps={},priorState=null}={}){
 const id=producerEventId(chain,outcome);
 if(!id)return null;
 const g=count(chain.input_generation);
 const label=String(chain.programme_run_id)+':'+String(g);
 const own=run&&typeof run==='object'&&run.origin!=='dictionary'&&run.source_generation===label?run:null;
 const at=outcomeAt(chain,own,outcome);
 if(!at)return null;
 const applied=own?count(own.n_applied):null,noop=own?count(own.n_noop):null,kept=own?count(own.n_kept):null,failed=own?count(own.n_failed):null;
 const parts=[applied,noop,kept,failed];
 const processed=parts.every(value=>value!==null)?parts.reduce((a,b)=>a+b,0):null;
 const unitCount=own?count(own.unit_count):null;
 const passNo=own?count(own.pass_no):null;
 let remaining=null;
 // All units have a durable outcome only when the pass claimed the generation. Otherwise the remainder is known only for the first pass of the run, whose
 // counters advance with the cursor exactly; a replayed pass restarts the cursor and keeps the counters, so its remainder is unknown.
 if(outcome==='passed'&&own&&own.pass_state==='passed')remaining=0;
 else if(own&&passNo===1&&unitCount!==null&&processed!==null&&processed<=unitCount)remaining=unitCount-processed;
 const openResults=outcome==='passed'&&own?count(own.open_at_completion):null;
 const startedAt=own&&isTime(own.created_at)?new Date(Date.parse(own.created_at)).toISOString():null;
 const durationMs=startedAt&&Date.parse(at)>=Date.parse(startedAt)?Date.parse(at)-Date.parse(startedAt):null;
 const reason=outcome==='stopped'?(CODE.test(String(chain.stopped_by||''))?chain.stopped_by:null):outcome==='superseded'?'newer_publication':null;
 const recoveryClass=outcome==='stopped'&&CODE.test(String(chain.recovery_class||''))?chain.recovery_class:null;
 return {
  id,type:PRODUCER_EVENT_TYPE,at,outcome,
  programme:programmeToken(chain.programme_run_id).slice(0,8),inputGeneration:g,
  runRecorded:!!own,passNo,unitCount,processed,applied,noop,kept,failed,remaining,openResults,startedAt,durationMs,
  reason,recoveryClass,recovery:outcome==='stopped'?recoveryOf(chain,at,caps):outcome==='superseded'?'none':null,
  ...(outcome==='superseded'&&IN_FLIGHT.includes(priorState)?{priorState}:{}),
  chain:{epoch:count(chain.owner_epoch),handoffs:count(chain.handoff_count),takeovers:count(chain.takeover_count),relaunches:count(chain.relaunch_count),
   reopens:count(chain.reopen_count),rebases:count(chain.rebase_count),recoveryAttempts:count(chain.recovery_attempts)},
 };
}

// ---- the ledger --------------------------------------------------------------------------------------------------------------
function parseEntry(entry){
 if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
 const event=entry.event;
 if(!event||typeof event!=='object'||event.type!==PRODUCER_EVENT_TYPE||typeof event.id!=='string'||!event.id||event.id.length>160||!isTime(event.at))return null;
 const attempts=count(entry.attempts)??0;
 return {event,since:isTime(entry.since)?entry.since:event.at,attempts,lastAttemptAt:isTime(entry.lastAttemptAt)?entry.lastAttemptAt:null};
}
export function parseLedger(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.schemaVersion!==PRODUCER_EVENT_LEDGER_SCHEMA||!isTime(raw.baselineAt))return null;
 if(!Array.isArray(raw.settled)||raw.settled.length>PRODUCER_EVENT_SETTLED_MAX||raw.settled.some(id=>typeof id!=='string'||!id||id.length>160))return null;
 if(!Array.isArray(raw.pending)||raw.pending.length>PRODUCER_EVENT_PENDING_MAX)return null;
 const pending=[];
 for(const entry of raw.pending){const parsed=parseEntry(entry);if(!parsed)return null;pending.push(parsed);}
 return {schemaVersion:PRODUCER_EVENT_LEDGER_SCHEMA,baselineAt:raw.baselineAt,settled:[...raw.settled],pending,lost:count(raw.lost)??0};
}
const freshLedger=nowIso=>({schemaVersion:PRODUCER_EVENT_LEDGER_SCHEMA,baselineAt:nowIso,settled:[],pending:[],lost:0});
function settle(ledger,id){
 ledger.settled=[...ledger.settled.filter(item=>item!==id),id].slice(-PRODUCER_EVENT_SETTLED_MAX);
 ledger.pending=ledger.pending.filter(entry=>entry.event.id!==id);
}
// Two concurrent ticks: union of what each settled, pending kept unless the other side settled it, the higher attempt count wins.
function merge(stored,mine){
 const out={...stored,settled:[...stored.settled],pending:[...stored.pending],lost:Math.max(stored.lost,mine.lost)};
 for(const id of mine.settled)if(!out.settled.includes(id))settle(out,id);
 for(const entry of mine.pending){
  if(out.settled.includes(entry.event.id))continue;
  const at=out.pending.findIndex(item=>item.event.id===entry.event.id);
  if(at>=0)out.pending[at]={...out.pending[at],attempts:Math.max(out.pending[at].attempts,entry.attempts),lastAttemptAt:entry.lastAttemptAt||out.pending[at].lastAttemptAt};
  else if(out.pending.length<PRODUCER_EVENT_PENDING_MAX)out.pending.push(entry);
  else out.lost+=1;
 }
 return out;
}

async function readLedger(env){
 let object;
 try{object=await env.BUCKET.get(PRODUCER_EVENT_LEDGER_KEY);}catch{return {status:'unreadable'};}
 if(!object)return {status:'absent',etag:null,ledger:null};
 let body;
 try{body=await object.json();}catch{return {status:'invalid',etag:object.etag||null,ledger:null};}
 const ledger=parseLedger(body);
 return ledger?{status:'ok',etag:object.etag||null,ledger}:{status:'invalid',etag:object.etag||null,ledger:null};
}
async function writeLedger(env,ledger,etag){
 const saved=await env.BUCKET.put(PRODUCER_EVENT_LEDGER_KEY,JSON.stringify(ledger),{httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}});
 return saved?{ok:true,etag:saved.etag||null}:{ok:false};
}
// One create-only journal put. `true` when the item exists afterwards (written now, or already there), `false` when it could not be written.
async function putEvent(env,event){
 for(let attempt=0;attempt<PRODUCER_EVENT_PUT_TRIES;attempt++){
  try{
   await env.BUCKET.put(producerEventKey(event),JSON.stringify(event),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});
   return true;
  }catch{/* one more try, then the outbox */}
 }
 return false;
}

// One reconcile tick's view of the ledger. `wanted(chain, outcome)` says whether an outcome still needs its run read and its event; `record(event)` makes it
// durable now (journal, else the outbox, written at once so the reconcile may then move the chain); `finish()` drains the outbox and saves the ledger.
// Every method swallows its own failures: nothing here can fail the reconcile or change its decisions. `log` receives one summary line.
export function producerEventSession(env,{nowMs=Date.now(),log=()=>{}}={}){
 const nowIso=new Date(nowMs).toISOString();
 const stats={recorded:0,queued:0,lost:0,drained:0,skippedBaseline:0,unreadable:false};
 let loaded=null;
 const attempted=new Set();
 let dirty=false;
 const available=()=>!!env?.BUCKET&&typeof env.BUCKET.get==='function'&&typeof env.BUCKET.put==='function';
 async function load(){
  if(loaded)return loaded;
  if(!available()){loaded={status:'unavailable'};return loaded;}
  const read=await readLedger(env);
  if(read.status==='unreadable'){stats.unreadable=true;loaded={status:'unreadable'};return loaded;}
  if(read.status==='ok'){loaded={status:'ok',etag:read.etag,ledger:read.ledger};return loaded;}
  // Absent (the first tick after the deploy) or invalid: a fresh baseline from now, so nothing that ended earlier is reported.
  loaded={status:'ok',etag:read.etag,ledger:freshLedger(nowIso),replace:true};
  dirty=true;
  return loaded;
 }
 async function save(){
  let state=loaded;
  for(let attempt=0;attempt<PRODUCER_EVENT_CAS_TRIES;attempt++){
   let saved;
   try{saved=await writeLedger(env,state.ledger,state.etag);}catch{return false;}
   if(saved.ok){loaded={...state,etag:saved.etag,replace:false};dirty=false;return true;}
   const again=await readLedger(env).catch(()=>({status:'unreadable'}));
   if(again.status==='unreadable')return false;
   const base=again.status==='ok'?again.ledger:freshLedger(state.ledger.baselineAt);
   state={...state,etag:again.etag??null,ledger:merge(base,state.ledger)};
   loaded=state;
  }
  return false;
 }
 return {
  async wanted(chain,outcome){
   try{
    const id=producerEventId(chain,outcome);
    if(!id)return false;
    const state=await load();
    if(state.status!=='ok')return false;
    const {ledger}=state;
    if(ledger.settled.includes(id)||ledger.pending.some(entry=>entry.event.id===id))return false;
    // The chain write that ended the outcome predates the ledger: an outcome of before this reporter existed is never reported.
    if(isTime(chain.updated_at)&&Date.parse(chain.updated_at)<Date.parse(ledger.baselineAt)){settle(ledger,id);dirty=true;stats.skippedBaseline++;return false;}
    return true;
   }catch{return false;}
  },
  async record(event){
   try{
    if(!event)return 'none';
    const state=await load();
    if(state.status!=='ok')return 'unavailable';
    const {ledger}=state;
    if(ledger.settled.includes(event.id)||ledger.pending.some(entry=>entry.event.id===event.id))return 'known';
    if(Date.parse(event.at)<Date.parse(ledger.baselineAt)){settle(ledger,event.id);dirty=true;stats.skippedBaseline++;return 'baseline';}
    attempted.add(event.id);
    if(await putEvent(env,event)){settle(ledger,event.id);dirty=true;stats.recorded++;return 'recorded';}
    if(ledger.pending.length>=PRODUCER_EVENT_PENDING_MAX){ledger.lost+=1;dirty=true;stats.lost++;log({event:'canonical_producer_event_lost',id:event.id.slice(0,160),reason:'outbox_full'});return 'lost';}
    ledger.pending.push({event,since:nowIso,attempts:1,lastAttemptAt:nowIso});
    dirty=true;
    // Durable BEFORE the reconcile moves the chain: the outbox write happens now, not at the end of the tick.
    if(await save()){stats.queued++;return 'queued';}
    stats.lost++;
    log({event:'canonical_producer_event_lost',id:event.id.slice(0,160),reason:'outbox_unwritable'});
    return 'lost';
   }catch{return 'error';}
  },
  async finish(){
   try{
    const state=await load();
    if(state.status==='ok'){
     const {ledger}=state;
     const due=ledger.pending.filter(entry=>!attempted.has(entry.event.id)).sort((a,b)=>Date.parse(a.since)-Date.parse(b.since)).slice(0,PRODUCER_EVENT_DRAIN_MAX);
     for(const entry of due){
      if(await putEvent(env,entry.event)){settle(ledger,entry.event.id);stats.drained++;}
      else{entry.attempts+=1;entry.lastAttemptAt=nowIso;}
      dirty=true;
     }
     if(dirty)await save();
     stats.pending=loaded?.ledger?.pending?.length??0;
    }
   }catch{/* reported below as it stands */}
   if(stats.recorded||stats.queued||stats.lost||stats.drained||stats.unreadable||stats.pending)log({event:'canonical_producer_events',...stats});
   return stats;
  },
 };
}
