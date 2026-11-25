// AIR-543 / ADR 0179. The automatic catalog-poster retry: one daily Worker cron (`24 3 * * *` UTC) whose firing runs the weekly sweep on the first
// firing of a new week (weeks start Sunday 00:00 UTC) and is otherwise pending-only. The sweep calls the same core as the owner route
// (`catalogPosterRun`), so every guard of that route (verified identity, D1 conditional poster update, resolver lease, generation fence, negative-index
// compare-and-swap) applies unchanged. D1 only: there is no R2 catalog writer here.
//
// One R2 object, `epg/catalog-poster-weekly.json`, is the only fact source for the Monitor stream, the footer source and the Events Log. It carries the
// run state and a bounded outbox of immutable events with a frozen `at` and payload, so a lost event put is replayed without asking TMDB again.
// An idle firing (nothing pending, nothing owed, the week already has its report) is one read and no write of any kind.
// Concatenated into the Worker as `CatalogPosterWeekly`; the pure parts have no dependency and are unit-tested directly.

export const CHECKPOINT_KEY='epg/catalog-poster-weekly.json';
export const CRON='24 3 * * *';
export const SCHEMA_VERSION=1;
export const OUTBOX_MAX=8;
export const RETRY_CAP=6;
export const BATCH_LIMIT=10;
export const MAX_BATCHES=5;
export const BUSY_RETRY_MS=30*60000;
export const RUN_BUDGET_MS=2*3600000;
export const GRACE_MS=26*3600000;
export const OUTBOX_STALE_MS=52*3600000;
export const OVERDUE_DEGRADED_MS=2*3600000;
const FIRING_OFFSET_MS=(3*60+24)*60000;
const DAY_MS=86400000;
const STATUSES=['running','pending','completed','failed'];

const isTime=value=>typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value));
const iso=ms=>new Date(ms).toISOString();

// The Sunday 00:00 UTC that starts the week of `ms`.
export function weekStart(ms){
 const date=new Date(ms);
 return iso(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()-date.getUTCDay()));
}
// The next 03:24 UTC firing strictly after `ms`.
export function nextFiring(ms){
 const day=Date.UTC(new Date(ms).getUTCFullYear(),new Date(ms).getUTCMonth(),new Date(ms).getUTCDate());
 const today=day+FIRING_OFFSET_MS;
 return today>ms?today:today+DAY_MS;
}
export function eventId(weekStartIso,kind){return 'catalog_posters-'+weekStartIso.slice(0,10)+'-'+kind;}
export function eventKey(event){return 'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';}

// ---- Checkpoint validity (ADR 0179, "Validity"): a record that fails its status's rule is `null`, never trusted ----
function parseOutboxEntry(entry){
 if(!entry||typeof entry!=='object'||Array.isArray(entry))return null;
 if(typeof entry.id!=='string'||!entry.id||entry.id.length>120||!isTime(entry.at))return null;
 if(!entry.payload||typeof entry.payload!=='object'||Array.isArray(entry.payload))return null;
 if(entry.deliveredAt!==null&&!isTime(entry.deliveredAt))return null;
 return {id:entry.id,at:entry.at,payload:entry.payload,deliveredAt:entry.deliveredAt};
}
export function parseCheckpoint(raw){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||raw.schemaVersion!==SCHEMA_VERSION)return null;
 if(!isTime(raw.weekStart)||typeof raw.runId!=='string'||!raw.runId||raw.runId.length>120||!STATUSES.includes(raw.status))return null;
 if(!Array.isArray(raw.outbox)||raw.outbox.length>OUTBOX_MAX)return null;
 const outbox=[];
 for(const entry of raw.outbox){const parsed=parseOutboxEntry(entry);if(!parsed)return null;outbox.push(parsed);}
 if(raw.status==='completed'&&!isTime(raw.lastCompletedAt))return null;
 if(raw.status==='pending'&&(!isTime(raw.nextRetryAt)||!isTime(raw.lastAttemptAt)))return null;
 if((raw.status==='running'||raw.status==='failed')&&!isTime(raw.lastAttemptAt))return null;
 for(const field of ['lastScheduledAt','lastAttemptAt','lastCompletedAt','nextRetryAt'])if(raw[field]!=null&&!isTime(raw[field]))return null;
 if(raw.cursor!=null&&(typeof raw.cursor!=='string'||raw.cursor.length>200))return null;
 if(!Number.isInteger(raw.retryAttempts)||raw.retryAttempts<0||raw.retryAttempts>1000)return null;
 const rateLimitStreak=raw.rateLimitStreak==null?0:raw.rateLimitStreak;
 if(!Number.isInteger(rateLimitStreak)||rateLimitStreak<0||rateLimitStreak>1000)return null;
 const summary=raw.summary==null?null:raw.summary;
 if(summary!==null&&(typeof summary!=='object'||Array.isArray(summary)))return null;
 return {schemaVersion:SCHEMA_VERSION,runId:raw.runId,weekStart:raw.weekStart,status:raw.status,lastScheduledAt:raw.lastScheduledAt??null,lastAttemptAt:raw.lastAttemptAt??null,lastCompletedAt:raw.lastCompletedAt??null,cursor:raw.cursor??null,nextRetryAt:raw.nextRetryAt??null,retryAttempts:raw.retryAttempts,rateLimitStreak,deferredReported:raw.deferredReported===true,summary,outbox};
}
export function undelivered(checkpoint){return (checkpoint?.outbox||[]).filter(entry=>entry.deliveredAt===null);}

// What a firing does. Delivery of owed events is handled before this and is itself work, so a firing with an undelivered entry is not idle.
export function plan(checkpoint,nowMs){
 if(!checkpoint)return 'sweep';
 if(Date.parse(checkpoint.weekStart)<Date.parse(weekStart(nowMs)))return 'sweep';
 if(checkpoint.status==='pending'&&Date.parse(checkpoint.nextRetryAt)<=nowMs)return 'resume';
 if(checkpoint.status==='running'&&nowMs-Date.parse(checkpoint.lastAttemptAt)>RUN_BUDGET_MS)return 'resume';
 return 'idle';
}

// ---- The one projection behind the Monitor stream, the owner health read and the footer source (ADR 0179, predicate table) ----
// ADR 0206 (AIR-592): a failed run is `degraded` with `critical: true` (it alerts at once); the Monitor vocabulary has no `needs_owner` any more.
// `read` is {status:'absent'|'ok'|'invalid'|'unreadable', checkpoint}. `markers` are the Monitor's write-once fields. First true predicate wins.
export function project({read,markers={},monitorOn=true,nowMs}){
 const baselineAt=markers.baselineAt??null,seenAt=markers.seenAt??null;
 const out=(state,monitor,extra={})=>({state,monitor,nextExpectedAt:null,freshnessAt:null,...extra});
 const checkpoint=read?.status==='ok'?read.checkpoint:null;
 if(read?.status==='invalid'||read?.status==='unreadable')return out('unknown','degraded',{detail:'checkpoint_'+read.status});
 if(!checkpoint){
  if(seenAt)return out('lost','degraded',{detail:'checkpoint_absent_after_seen'});
  if(!monitorOn)return out('unknown','degraded',{detail:'monitor_off'});
  const bootstrapDue=nextFiring(baselineAt?Date.parse(baselineAt):nowMs);
  if(nowMs<=bootstrapDue+GRACE_MS)return out('grace','healthy',{nextExpectedAt:iso(bootstrapDue),detail:'first_run_grace'});
  return out('overdue',nowMs>bootstrapDue+GRACE_MS+OVERDUE_DEGRADED_MS?'degraded':'delayed',{nextExpectedAt:iso(bootstrapDue),detail:'first_run_missed'});
 }
 const times=[checkpoint.lastScheduledAt,checkpoint.lastAttemptAt,checkpoint.lastCompletedAt].filter(Boolean).map(Date.parse);
 const freshnessAt=times.length?iso(Math.max(...times)):null;
 const unsent=undelivered(checkpoint);
 const common={freshnessAt};
 if(checkpoint.status==='failed'||checkpoint.retryAttempts>=RETRY_CAP||checkpoint.rateLimitStreak>=2)return out('failed','degraded',{...common,critical:true,detail:checkpoint.status==='failed'?'run_failed':checkpoint.retryAttempts>=RETRY_CAP?'retry_exhausted':'rate_limited_repeatedly'});
 const stuckOutbox=unsent.length>=OUTBOX_MAX||unsent.some(entry=>nowMs-Date.parse(entry.at)>OUTBOX_STALE_MS);
 const stuckRunning=checkpoint.status==='running'&&nowMs-Date.parse(checkpoint.lastAttemptAt)>RUN_BUDGET_MS;
 const stuckPending=checkpoint.status==='pending'&&nowMs>Date.parse(checkpoint.nextRetryAt)+GRACE_MS;
 if(stuckOutbox||stuckRunning||stuckPending)return out('stalled','degraded',{...common,nextExpectedAt:checkpoint.nextRetryAt,detail:stuckOutbox?'outbox_undelivered':stuckRunning?'run_stuck':'resume_missed'});
 const current=Date.parse(weekStart(nowMs)),sweepDue=current+FIRING_OFFSET_MS+GRACE_MS;
 if(Date.parse(checkpoint.weekStart)<current&&nowMs>sweepDue)return out('overdue',nowMs>sweepDue+OVERDUE_DEGRADED_MS?'degraded':'delayed',{...common,nextExpectedAt:iso(current+FIRING_OFFSET_MS),detail:'weekly_sweep_missed'});
 if(checkpoint.status==='pending')return out('waiting','waiting',{...common,nextExpectedAt:checkpoint.nextRetryAt,detail:'retry_scheduled'});
 if(checkpoint.status==='running')return out('waiting','waiting',{...common,nextExpectedAt:null,detail:'run_in_progress'});
 return out('healthy_idle','healthy',{...common,nextExpectedAt:iso(Date.parse(weekStart(nowMs))+7*DAY_MS+FIRING_OFFSET_MS),detail:checkpoint.summary&&checkpoint.summary.hydrated>0?'hydrated':'idle'});
}

// ---- The immutable events ----
export function eventPayload(kind,checkpoint,summary,nowMs){
 const outcome=kind==='deferred'?'deferred':checkpoint.status==='failed'?'failed':'completed';
 return {type:'catalog_posters',outcome,final:kind!=='deferred',weekStart:checkpoint.weekStart,runId:checkpoint.runId,scanned:summary.scanned,due:summary.due,checked:summary.checked,hydrated:summary.hydrated,noPoster:summary.noPoster,retryable:summary.retryable,deferredBusy:summary.deferredBusy,pending:summary.pending,rateLimit:summary.rateLimit,durationMs:summary.durationMs,...(kind==='deferred'&&checkpoint.nextRetryAt?{nextRetryAt:checkpoint.nextRetryAt}:{})};
}
const zeroSummary=()=>({scanned:0,due:0,checked:0,hydrated:0,noPoster:0,retryable:0,deferredBusy:0,pending:0,rateLimit:false,durationMs:0});

// ---- R2 access: one object, version-aware compare-and-swap like the negative index ----
async function readCheckpoint(env){
 let object;
 try{object=await env.BUCKET.get(CHECKPOINT_KEY);}catch{return {status:'unreadable',etag:null,checkpoint:null};}
 if(!object)return {status:'absent',etag:null,checkpoint:null};
 let body;
 try{body=await object.json();}catch{return {status:'invalid',etag:object.etag||null,checkpoint:null};}
 const checkpoint=parseCheckpoint(body);
 return checkpoint?{status:'ok',etag:object.etag||null,checkpoint}:{status:'invalid',etag:object.etag||null,checkpoint:null};
}
async function writeCheckpoint(env,checkpoint,etag){
 try{
  const options={httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}};
  const saved=await env.BUCKET.put(CHECKPOINT_KEY,JSON.stringify(checkpoint),options);
  return saved?{ok:true,etag:saved.etag||null}:{ok:false,reason:'cas_conflict'};
 }catch{return {ok:false,reason:'write_error'};}
}
// A read for the Monitor, the owner health read and the footer: one get, no write, no TMDB.
export async function readStatus(env,{markers={},monitorOn=true,nowMs=Date.now()}={}){
 const read=await readCheckpoint(env);
 return {...project({read,markers,monitorOn,nowMs}),checkpointStatus:read.status,summary:read.checkpoint?.summary??null,lastOutcome:read.checkpoint?{status:read.checkpoint.status,weekStart:read.checkpoint.weekStart}:null};
}

// Delivers owed events oldest first, then marks them delivered in one compare-and-swap. A failed put stops the loop (order is kept) and leaves the entry owed.
async function deliver(env,checkpoint,etag,nowMs){
 const owed=undelivered(checkpoint);
 if(!owed.length)return {checkpoint,etag,delivered:0,failed:false};
 const done=new Set();let failed=false;
 for(const entry of owed){
  try{
   const event={id:entry.id,at:entry.at,...entry.payload};
   await env.BUCKET.put(eventKey(event),JSON.stringify(event),{httpMetadata:{contentType:'application/json'}});
   done.add(entry.id);
  }catch{failed=true;break;}
 }
 if(!done.size)return {checkpoint,etag,delivered:0,failed};
 const next={...checkpoint,outbox:checkpoint.outbox.map(entry=>done.has(entry.id)?{...entry,deliveredAt:iso(nowMs)}:entry)};
 const saved=await writeCheckpoint(env,next,etag);
 if(!saved.ok)return {checkpoint,etag,delivered:done.size,failed:true,markLost:true};
 return {checkpoint:next,etag:saved.etag,delivered:done.size,failed};
}

function fold(summary,payload){
 const outcomes=Array.isArray(payload.outcomes)?payload.outcomes:[];
 return {
  ...summary,
  scanned:Math.max(summary.scanned,Number.isInteger(payload.verifiedMissing)?payload.verifiedMissing:0),
  due:Math.max(summary.due,Number.isInteger(payload.actionable)?payload.actionable:0),
  checked:summary.checked+(Number.isInteger(payload.processed)?payload.processed:0),
  hydrated:summary.hydrated+(Number.isInteger(payload.hydrated)?payload.hydrated:0),
  noPoster:summary.noPoster+outcomes.filter(item=>item&&item.outcome==='no_poster_on_tmdb').length,
  retryable:Array.isArray(payload.retryable)?payload.retryable.length:summary.retryable,
  pending:Number.isInteger(payload.remainingAfterCursor)?payload.remainingAfterCursor:summary.pending,
  rateLimit:summary.rateLimit||!!payload.retryAt
 };
}

// One firing. Never throws: every failure is a typed result and a log line.
export async function run(env,{now=Date.now()}={}){
 const log=result=>{try{console.log(JSON.stringify({event:'catalog_poster_weekly',...result}));}catch{}return result;};
 let read=await readCheckpoint(env);
 if(read.status==='invalid'||read.status==='unreadable')return log({state:'failed',reason:'checkpoint_'+read.status});
 let checkpoint=read.checkpoint,etag=read.etag;
 // 1. Owed events first, before any rotation of the week and without TMDB.
 let delivery={delivered:0,failed:false};
 if(checkpoint){delivery=await deliver(env,checkpoint,etag,now);checkpoint=delivery.checkpoint;etag=delivery.etag;}
 if(checkpoint&&undelivered(checkpoint).length>=OUTBOX_MAX)return log({state:'stalled',reason:'outbox_full',delivered:delivery.delivered});
 // 2. Idle: neither poster work nor delivery is pending.
 const action=plan(checkpoint,now);
 if(action==='idle')return log({state:'idle',delivered:delivery.delivered});
 if(typeof catalogPosterRun!=='function')return log({state:'failed',reason:'core_unavailable'});
 // 3. The sweep or the resumption: bounded batches of the shared core.
 const t0=Date.now(),week=weekStart(now);
 const resumed=action==='resume';
 const sweepWeek=resumed?checkpoint.weekStart:week;
 let summary=resumed&&checkpoint.summary?{...zeroSummary(),...checkpoint.summary}:zeroSummary();
 let cursor=resumed?checkpoint.cursor:null;
 let attempts=resumed?checkpoint.retryAttempts:0,streak=resumed?checkpoint.rateLimitStreak:0;
 let outcome='pending',nextRetryAt=null,busy=0,stop=null;
 for(let batch=0;batch<MAX_BATCHES;batch++){
  let result;
  try{result=await catalogPosterRun(env,{dryRun:false,limit:BATCH_LIMIT,...(cursor?{cursor}:{})},{skipWhenNothingDue:true});}
  catch{result={status:503,payload:{error:'core_error'}};}
  const payload=result?.payload||{},status=result?.status||0;
  if(status===200){
   summary=fold(summary,payload);
   // AIR-604 (ADR 0211 decision 5): a shared-cooldown skip sent no request. It waits for the cooldown end and charges neither a retry attempt nor the rate-limit streak.
   if(payload.retryAt){stop=payload.cooldown===true?'cooldown':'rate_limit';nextRetryAt=Date.parse(payload.retryAt)||now+BUSY_RETRY_MS;break;}
   if(payload.done===true){outcome='completed';cursor=null;break;}
   const moved=typeof payload.nextCursor==='string'&&payload.nextCursor!==(cursor||'');
   if(!moved){stop='stuck';nextRetryAt=now+BUSY_RETRY_MS;break;}
   cursor=payload.nextCursor;continue;
  }
  if(status===409&&(payload.reason==='epg_priority'||payload.error==='Resolver is writing the catalog')){busy++;stop='busy';nextRetryAt=Date.parse(payload.nextCatchUpAt||'')||now+BUSY_RETRY_MS;break;}
  stop='error';nextRetryAt=now+BUSY_RETRY_MS;break;
 }
 if(outcome!=='completed'&&nextRetryAt==null){stop='budget';nextRetryAt=now;}
 summary={...summary,deferredBusy:summary.deferredBusy+busy,durationMs:summary.durationMs+Math.max(0,Date.now()-t0)};
 if(outcome!=='completed'){attempts+=stop==='budget'||stop==='cooldown'?0:1;streak=stop==='rate_limit'?streak+1:0;}else streak=0;
 const exhausted=outcome!=='completed'&&attempts>=RETRY_CAP;
 const status=outcome==='completed'?'completed':exhausted?'failed':'pending';
 // 4. Commit the result and append the immutable event in ONE compare-and-swap; the rotation keeps only undelivered entries of the old week.
 const carried=checkpoint?(checkpoint.weekStart===sweepWeek?checkpoint.outbox:checkpoint.outbox.filter(entry=>entry.deliveredAt===null)):[];
 const next={schemaVersion:SCHEMA_VERSION,runId:resumed?checkpoint.runId:'catalog_posters-'+sweepWeek.slice(0,10),weekStart:sweepWeek,status,lastScheduledAt:iso(now),lastAttemptAt:iso(now),lastCompletedAt:status==='completed'?iso(now):(resumed?checkpoint.lastCompletedAt:null),cursor:status==='pending'?cursor:null,nextRetryAt:status==='pending'?iso(nextRetryAt):null,retryAttempts:attempts,rateLimitStreak:streak,deferredReported:resumed?checkpoint.deferredReported:false,summary,outbox:carried};
 let kind=null;
 if(status==='pending'&&!next.deferredReported){kind='deferred';next.deferredReported=true;}
 if(status!=='pending')kind='final';
 if(kind){
  const entry={id:eventId(sweepWeek,kind),at:iso(now),payload:eventPayload(kind,next,summary,now),deliveredAt:null};
  next.outbox=[...next.outbox.filter(item=>item.id!==entry.id),entry];
  while(next.outbox.length>OUTBOX_MAX){const index=next.outbox.findIndex(item=>item.deliveredAt!==null);if(index<0)break;next.outbox.splice(index,1);}
 }
 const saved=await writeCheckpoint(env,next,etag);
 if(!saved.ok)return log({state:'failed',reason:saved.reason,status,summary});
 // 5. Deliver what this firing owes, then mark it. A failure here leaves it owed; the next firing replays it without TMDB.
 const after=await deliver(env,next,saved.etag,now);
 return log({state:status,week:sweepWeek,summary,delivered:after.delivered,deliveryFailed:after.failed,resumed});
}
