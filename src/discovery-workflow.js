// AIR-323 / ADR 0083, AIR-324 / ADR 0093. Durable Discovery continuation. One bounded chunk per step.
// The Workflow is the permanent Discovery executor. The existing Worker cron may call reconcileDiscoveryWorkflow;
// that path is a no-op without admission. No workflows[].schedules. The executor record follows the
// discovery marker: D1 when it is d1, otherwise R2 (AIR-320).
const DISCOVERY_WORKFLOW_STATE_KEY='epg/discovery-workflow.json';
const DISCOVERY_WORKFLOW_CHUNK_LIMIT=20;
const DISCOVERY_WORKFLOW_STALL_LIMIT=3;
const DISCOVERY_WORKFLOW_WRITE_LIMIT=3;
const DISCOVERY_WORKFLOW_STEP_CAP=160;
// AIR-360. A Workflow instance runs its steps inside one Worker invocation, and every D1 statement it issues is
// counted against that invocation. On 6 November 2026 both instances failed after 19 chunks with D1 statement
// totals of 12,287 and 12,192 (D1 analytics), whatever their duration or rows read: each next step then failed
// in about 10 ms with `discovery_unavailable` and no query reached D1. The instance hands over to a successor
// (a new invocation) well before that total. The exact platform limit is not established; see ADR 0094.
const DISCOVERY_WORKFLOW_INVOCATION_BUDGET=6000;
const DISCOVERY_WORKFLOW_RECOVERY_LIMIT=4;
const DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS=[60000,300000,900000,3600000];
const DISCOVERY_WORKFLOW_FRESH_MS=15*60*1000;
const DISCOVERY_WORKFLOW_TERMINAL=new Set(['complete','backlog_empty','stale_generation','executor_not_workflow','recovery_exhausted']);
const DISCOVERY_WORKFLOW_RECOVERABLE=new Set(['no_progress','write_uncertain','step_cap','rollover_uncertain','no_continuation','step_failure']);
function discoveryWorkflowChunkLimit(){return DISCOVERY_WORKFLOW_CHUNK_LIMIT;}
// AIR-410 (ADR 0111). Every scheduled hourly firing of the cron writes ONE `discovery` Events Log entry for the period since the previous report,
// whatever the Workflow is doing: a chain that runs for hours across rollovers, a wait for a successor, a block, an exhausted recovery, an idle
// pipeline or a confirmed empty queue. The chain and its terminal stop are a separate matter and write no event of their own.
// The counters are DELTAS of the period, never lifetime totals. The executor record carries one open accumulator, `report`. Each saved chunk
// checkpoint adds that chunk's summary to it inside the owner's compare-and-swap (the model is attribution by COMMIT TIME: a chunk belongs to the
// period in which its checkpoint was saved, whatever series or generation it ran in) and records the chunk key in `seen`, so a retried or replayed
// checkpoint adds nothing a second time. The cron closes the period in ONE compare-and-swap of the same record: it moves the report event into the
// `outbox` and starts a new accumulator, so a chunk is counted in exactly one report. The event is immutable, keyed by generation and UTC hour,
// written create-only after that, and delivered from the outbox by whoever looks next, so a lost put is never a lost report and never repeats a
// Discovery step or a TMDB request. An absent reading is never a zero: an unknown part is `null` and the report says it is incomplete.
const DISCOVERY_REPORT_COUNTERS=['checked','added','reused','screenedOut','touched','tmdbCalls'];
const DISCOVERY_REPORT_SEEN_LIMIT=16;
const DISCOVERY_REPORT_OUTBOX_LIMIT=64;
const DISCOVERY_REPORT_CLOSE_ATTEMPTS=3;
const DISCOVERY_REPORT_BLOCKED=new Set(['authority_held','authority_loading','authority_not_ready','generation_unpublished','generation_handoff','d1_unavailable','projector_window','epg_priority','write_conflict','intent_uncertain','intent_unconfirmed','stale_generation','workflow_unavailable','invalid','events_outbox_full']);
// The legacy status map of the per-chain events written before the hourly model; read only to deliver a legacy entry that was still pending.
const DISCOVERY_TICK_STATUS={complete:'finished',backlog_empty:'finished',stale_generation:'superseded',recovery_exhausted:'failed',executor_not_workflow:'stopped'};
function discoveryHourStamp(ms){return new Date(ms).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z').slice(0,11);}
function discoveryCount(value){return Number.isInteger(value)&&value>=0?value:null;}
// The queue is empty only when every part of it is a proven numeric zero: the remaining count AND the cheap-pass remainder. A missing, null,
// negative, fractional or non-numeric part is unknown and never a zero (a chunk that does not report the cheap-pass remainder confirms nothing).
function discoveryQueueEmpty(remaining,cheapRemaining,error){return remaining===0&&cheapRemaining===0&&!error;}
function newDiscoveryReport(since,seen=[]){
 const report={since:since||null,chunks:0,remaining:null,cheapRemaining:null,error:null,queueGeneration:null,seen,lastClosedHour:null};
 for(const name of DISCOVERY_REPORT_COUNTERS)report[name]=0;
 return report;
}
function normalizeDiscoveryReport(value){
 const base=newDiscoveryReport(typeof value?.since==='string'&&Number.isFinite(Date.parse(value.since))?value.since:null,Array.isArray(value?.seen)?value.seen.filter(key=>typeof key==='string').slice(-DISCOVERY_REPORT_SEEN_LIMIT):[]);
 if(!value||typeof value!=='object')return base;
 base.chunks=Number.isInteger(value.chunks)&&value.chunks>0?value.chunks:0;
 for(const name of DISCOVERY_REPORT_COUNTERS)base[name]=Number.isFinite(value[name])&&value[name]>0?value[name]:0;
 base.remaining=discoveryCount(value.remaining);base.cheapRemaining=discoveryCount(value.cheapRemaining);
 base.error=typeof value.error==='string'&&value.error?value.error:null;
 base.queueGeneration=typeof value.queueGeneration==='string'&&value.queueGeneration?value.queueGeneration:null;
 base.lastClosedHour=typeof value.lastClosedHour==='string'?value.lastClosedHour:null;
 return base;
}
// Pure. `summary` is one saved chunk's summary and `chunkKey` names that chunk (the instance id and the chunk's ordinal in it, both stable
// across a replay). A key already in `seen` is a repeat of the same checkpoint and adds nothing. A counter that is missing or not a finite
// non-negative number adds nothing.
function addChunkToDiscoveryReport(report,summary,chunkKey,generation){
 const base=normalizeDiscoveryReport(report);
 if(chunkKey&&base.seen.includes(chunkKey))return base;
 const next={...base,chunks:base.chunks+1,seen:chunkKey?[...base.seen,chunkKey].slice(-DISCOVERY_REPORT_SEEN_LIMIT):base.seen};
 for(const name of DISCOVERY_REPORT_COUNTERS){const value=summary?.[name];next[name]=base[name]+(Number.isFinite(value)&&value>0?value:0);}
 if(summary&&typeof summary==='object'){
  next.remaining=discoveryCount(summary.remaining);next.cheapRemaining=discoveryCount(summary.cheapRemaining);
  next.error=typeof summary.error==='string'&&summary.error?summary.error:null;
  next.queueGeneration=typeof generation==='string'&&generation?generation:null;
 }
 return next;
}
// The state at the firing, from what this firing's reconcile answered. `empty` is a confirmed empty queue.
function discoveryReportState(outcome,record,empty){
 const reason=typeof outcome?.reason==='string'?outcome.reason:null;
 if(outcome?.started===true||reason==='in_progress')return {status:'running',reason:reason==='in_progress'||reason==='started'?null:reason};
 if(reason==='recovery_exhausted')return {status:'failed',reason};
 if(reason==='recovery_waiting')return {status:'waiting',reason};
 if(reason==='stopped')return empty?{status:'empty',reason:'queue_empty'}:{status:'idle',reason:DISCOVERY_WORKFLOW_TERMINAL.has(record?.reason)?record.reason:null};
 if(reason&&DISCOVERY_REPORT_BLOCKED.has(reason))return {status:'blocked',reason};
 return {status:'blocked',reason:reason?'other':'unknown'};
}
// A report is written only from facts that were read and persisted: the deltas of the period and the queue reading. An hour whose close cannot be persisted writes
// no report of unknowns: it gets one compact `report_failed` notice instead (see `closeHourlyDiscoveryReport`); an unreadable queue is said as `queueUnreadable` beside the real deltas, never as a report of unknowns.
// `incomplete` stays `false` on every event written now; only events written before ADR 0118 can carry `true` with every number `null`, and they keep their card.
function discoveryHourEvent({at,hourKey,generation,status,reason,report,queue}){
 const compact=String(generation||'').replace(/[^0-9A-Za-z]/g,'').slice(0,12)||'none';
 const event={id:'discovery-hour-'+compact+'-'+hourKey,type:'discovery',kind:'hour',at,from:report?.since||null,generation:compact.slice(0,8),status,reason:reason||null,chunks:report.chunks,queueEmpty:queue.empty===true,remaining:queue.remaining,queueUnreadable:queue.incomplete===true,incomplete:false,error:queue.error||null};
 for(const name of DISCOVERY_REPORT_COUNTERS)event[name]=report[name];
 if(queue?.reason&&!event.reason)event.reason=queue.reason;
 return event;
}
// The legacy per-chain event of the model before the hourly reports. Used only to deliver an entry that was still pending at the change.
function discoveryTickEvent(tick){
 const reason=tick.settled?.reason||null;
 const event={id:'discovery-'+tick.id,type:'discovery',kind:'run',at:tick.settled.at,startedAt:tick.startedAt,status:DISCOVERY_TICK_STATUS[reason]||'stopped',reason,chunks:tick.chunks||0,queueEmpty:discoveryQueueEmpty(discoveryCount(tick.remaining),discoveryCount(tick.cheapRemaining),tick.error),remaining:Number.isInteger(tick.remaining)?tick.remaining:null,error:tick.error||null};
 for(const name of DISCOVERY_REPORT_COUNTERS)event[name]=tick[name]||0;
 return event;
}
async function putDiscoveryEvent(env,event){
 if(typeof writeDiscoveryEvent!=='function')return 'unavailable';
 try{return await writeDiscoveryEvent(env,event);}catch{return 'failed';}
}
// What the period can say about the queue. The chunks of the period are the freshest committed reading; without one, the last saved status of
// the published generation. An empty queue needs the continuation to say complete for that generation too. An unreadable source is `incomplete`.
async function discoveryReportQueue(env,report,programmeRunId){
 const unreadable={remaining:null,cheapRemaining:null,error:null,empty:false,incomplete:true,reason:'queue_unreadable'};
 let remaining=null,cheapRemaining=null,error=null;
 try{
  // The queue values of the accumulator belong to the generation of the chunk that wrote them. Deltas carry across a generation change, the queue
  // reading does not: another generation's backlog or empty state is unknown for this one, never reused.
  if(report.chunks>0&&report.queueGeneration&&report.queueGeneration===programmeRunId){remaining=report.remaining;cheapRemaining=report.cheapRemaining;error=report.error;}
  else if(programmeRunId){
   const last=await loadJSON(env,'epg/discovery-status.json');
   if(last&&last.programmeRunId===programmeRunId){remaining=discoveryCount(last.remaining);cheapRemaining=discoveryCount(last.cheapRemaining);error=last.error?(typeof diagnosticErrorCode==='function'?diagnosticErrorCode({message:String(last.error)}):'other'):null;}
  }
 }catch{return unreadable;}
 let complete=false;
 try{const stored=programmeRunId?await readContinuation(env):null;complete=!!stored?.record&&stored.record.programmeRunId===programmeRunId&&stored.record.stage==='complete';}catch{return unreadable;}
 return {remaining,cheapRemaining,error,empty:complete&&discoveryQueueEmpty(remaining,cheapRemaining,error),incomplete:false,reason:null};
}
// Delivers every pending report: the events of the outbox and a legacy per-chain tick that was settled and not yet delivered. An entry leaves
// the record only after its create-only put is confirmed. The record is written back with its `updatedAt` untouched, so delivery never hides a
// stalled instance. A legacy open tick (never settled) is dropped: its lifetime totals are not a report and must not double the hourly ones.
async function deliverDiscoveryOutbox(env){
 try{
  const state=await readWorkflowState(env),record=state.record;
  if(!record)return {delivered:0,reason:'no_record'};
  const legacy=record.tick&&typeof record.tick==='object'?record.tick:null,outbox=Array.isArray(record.outbox)?record.outbox:[];
  const items=[];
  if(legacy?.settled&&legacy.delivered!==true)items.push({event:discoveryTickEvent(legacy),legacy:true});
  for(const entry of outbox){const event=entry?.type==='discovery'?entry:entry?.settled?discoveryTickEvent(entry):null;if(event)items.push({event,legacy:false});}
  if(!items.length&&!legacy&&!Array.isArray(record.outbox))return {delivered:0,reason:'nothing_to_deliver'};
  const left=[];let delivered=0,legacyFailed=false;
  for(const item of items){const written=await putDiscoveryEvent(env,item.event);if(written==='written'||written==='exists')delivered++;else if(item.legacy)legacyFailed=true;else left.push(item.event);}
  if(!delivered&&!legacy&&left.length===outbox.length)return {delivered:0,reason:'event_failed'};
  const {tick,...rest}=record;
  const next={...rest,outbox:left,...(legacyFailed?{tick:legacy}:{})};
  const marked=await writeWorkflowStateSoft(env,next,state.etag);
  return {delivered,pending:left.length+(legacyFailed?1:0),marked:marked.saved===true};
 }catch{return {delivered:0,reason:'error'};}
}
// Closes the period of this scheduled firing and delivers. Called only for a real scheduled firing (`options.scheduled`, `options.now` its
// scheduled time); an unscheduled caller writes no report, and no report is invented for a firing that did not happen (a gap is for the Monitor).
// Never throws and never starts a Discovery step. The report of the firing is keyed by the generation and the UTC hour, so a repeated or
// concurrent firing of the same hour finds it closed. A close that cannot be persisted (a held projector window, lost compare-and-swaps, an
// outbox at its limit) leaves the accumulator as it is: the deltas then appear in the next report, whose `from` says how far back it reaches.
async function closeHourlyDiscoveryReport(env,outcome,options){
 if(options?.scheduled!==true||!Number.isFinite(options.now))return {closed:false,reason:'not_scheduled'};
 await deliverDiscoveryReportFaults(env);
 const hourMs=Math.floor(options.now/3600000)*3600000,hourKey=discoveryHourStamp(hourMs),at=new Date(hourMs).toISOString();
 const generationOf=record=>outcome?.programmeRunId||record?.programmeRunId||null;

 let incompleteReason='state_unreadable',record=null,held=null;
 // A refused write inside the exclusive projector window is waited out, bounded, like the reconcile does (AIR-428): the window has a deadline and the close is
 // closed again from a fresh read once it has passed. The projector runs at the top of every hour, so its window covers the seconds in which this close runs.
 for(let windowTry=0;windowTry<DISCOVERY_REPORT_WINDOW_TRIES;windowTry++){
  incompleteReason='state_unreadable';held=null;
  try{
   for(let attempt=0;attempt<DISCOVERY_REPORT_CLOSE_ATTEMPTS;attempt++){
    const state=await readWorkflowState(env);record=state.record;
    if(!record){incompleteReason='no_record';break;}
    const report=normalizeDiscoveryReport(record.report);
    // The compact UTC keys sort chronologically: this hour or an older one is already closed (or superseded by a later close). A delayed or replayed
    // firing of it must not close the open accumulator, which holds chunks of a later period, under an id that already exists.
    if(typeof report.lastClosedHour==='string'&&hourKey<=report.lastClosedHour){await deliverDiscoveryOutbox(env);return {closed:false,reason:hourKey===report.lastClosedHour?'already_closed':'stale_hour',hourKey};}
    const pending=(Array.isArray(record.outbox)?record.outbox.length:0);
    if(pending>=DISCOVERY_REPORT_OUTBOX_LIMIT){await deliverDiscoveryOutbox(env);incompleteReason='outbox_full';break;}
    const queue=await discoveryReportQueue(env,report,generationOf(record));
    const {status,reason}=discoveryReportState(outcome,record,queue.empty);
    const event=discoveryHourEvent({at,hourKey,generation:generationOf(record),status,reason,report,queue});
    const {tick,...rest}=record;
    const next={...rest,report:{...newDiscoveryReport(at,report.seen),lastClosedHour:hourKey},outbox:[...(Array.isArray(record.outbox)?record.outbox:[]),event]};
    const written=await writeWorkflowStateSoft(env,next,state.etag);
    if(written.saved){const delivery=await deliverDiscoveryOutbox(env);return {closed:true,hourKey,status,delivered:delivery.delivered};}
    if(written.windowBusy){incompleteReason='projector_window';held={window:written.window,record,report,queue,state:{status,reason}};break;}
    incompleteReason='write_conflict';
   }
  }catch{incompleteReason='state_unreadable';}
  if(incompleteReason!=='projector_window'||windowTry>=DISCOVERY_REPORT_WINDOW_TRIES-1)break;
  try{await waitReconcileWindow({window:held?.window},options,Date.now());}catch{}
 }
 // The window did not pass inside this firing, but the close is still provable: the queue is empty (numeric zeros and a `complete` continuation of this generation),
 // and the accumulator that was just read holds no chunk and no counter, so there is nothing to attribute, lose or count twice, and no writer can add anything while
 // the window is held. The report of that hour is then published straight to the journal, as the normal empty report, without the record write the window refuses.
 // Two guards keep it a proof: the reconcile of this firing confirmed the executor stopped on an empty queue (status `empty`, never running, blocked or failed), and the record that
 // holds the zero accumulator belongs to the very generation the outcome, the status file and the continuation were proven for (no inference across a rollover).
 // It is `provisional`: the accumulator and `lastClosedHour` are untouched, and a report of the same hour that closes later replaces it (see `writeDiscoveryEvent`).
 if(incompleteReason==='projector_window'&&held&&held.state.status==='empty'&&held.queue.empty===true&&held.queue.incomplete===false&&typeof held.record?.programmeRunId==='string'&&held.record.programmeRunId===generationOf(held.record)&&discoveryReportIsZero(held.report)){
  const provisional={...discoveryHourEvent({at,hourKey,generation:generationOf(held.record),status:held.state.status,reason:held.state.reason,report:held.report,queue:held.queue}),provisional:true};
  const written=await putDiscoveryEvent(env,provisional);
  if(written==='written'||written==='exists'){
   try{console.warn(JSON.stringify({event:'discovery_hour_close_provisional',hourKey:String(hourKey).slice(0,12),reason:'projector_window'}));}catch{}
   return {closed:false,reason:'projector_window',hourKey,provisional:true,status:provisional.status};
  }
 }
 // Not persisted: the hour still gets one truthful line, a compact notice that its REPORT could not be completed (ADR 0118). It carries no counters and no
 // queue facts, so it can neither show unknowns nor imply that Discovery failed (only a Discovery state confirmed by the reconcile is named). The accumulator is
 // untouched, so the next successful report carries the deltas once. The notice does not travel through the record whose write failed: it is put create-only
 // straight into the journal under a stable id per generation and hour, and when the journal refuses it, it waits in a small separate ledger (its own
 // compare-and-swap) that every later scheduled firing drains.
 const generation=generationOf(record);
 const notice=discoveryReportFailedEvent({at,hourKey,generation,reason:incompleteReason,status:discoveryReportState(outcome,record,false).status});
 const delivery=await deliverDiscoveryReportFailure(env,notice);
 logDiscoveryReportClose({hourKey,reason:incompleteReason,generation,delivery});
 return {closed:false,reason:incompleteReason,hourKey,notice:delivery};
}
const DISCOVERY_REPORT_WINDOW_TRIES=3;
function discoveryReportIsZero(report){return report.chunks===0&&DISCOVERY_REPORT_COUNTERS.every(name=>report[name]===0);}
const DISCOVERY_REPORT_CLOSE_REASONS=new Set(['no_record','state_unreadable','outbox_full','projector_window','write_conflict']);
const DISCOVERY_REPORT_FAULT_KEY='events/discovery-report-faults.json';
// The ledger never evicts: it holds one compact tuple per undelivered hour, up to a year of hours (about 40 bytes each, well under 1 MB). Past that bound the NEWEST
// notice is refused and logged as `lost`; an older one is never dropped to make room. A drain delivers at most `DISCOVERY_REPORT_FAULT_DRAIN` entries per firing,
// oldest first, so one invocation's R2 work stays bounded however long the outage was.
const DISCOVERY_REPORT_FAULT_LIMIT=8760;
const DISCOVERY_REPORT_FAULT_DRAIN=64;
const DISCOVERY_REPORT_FAULT_ATTEMPTS=3;
const DISCOVERY_REPORT_FAULT_STATUSES=[null,'failed','waiting','blocked'];
const DISCOVERY_REPORT_REASON_LIST=['no_record','state_unreadable','outbox_full','projector_window','write_conflict'];
function logDiscoveryReportClose({hourKey,reason,generation,delivery}){
 try{console.warn(JSON.stringify({event:'discovery_hour_close_failed',hourKey:String(hourKey||'').slice(0,12),reason:DISCOVERY_REPORT_CLOSE_REASONS.has(reason)?reason:'other',generation:String(generation||'').replace(/[^0-9A-Za-z]/g,'').slice(0,12)||null,notice:['delivered','queued','lost'].includes(delivery)?delivery:'lost'}));}catch{}
}
// The notice of an hour whose report could not be completed. It has the SAME identity as the report of that hour (`discovery-hour-<generation>-<UTC hour>`), so the
// Events Log can never hold two events for one hourly firing: the notice is put create-only and never replaces anything, and a report that comes later replaces the notice
// of its hour (see `writeDiscoveryEvent`). `status` is a Discovery state only when the reconcile of that firing confirmed one that needs the owner's eyes
// (`failed`, `waiting`, `blocked`); `running` and `idle` say nothing about Discovery and are not stored.
function discoveryReportFailedEvent({at,hourKey,generation,reason,status}){
 const compact=String(generation||'').replace(/[^0-9A-Za-z]/g,'').slice(0,12)||'none';
 return {id:'discovery-hour-'+compact+'-'+hourKey,type:'discovery',kind:'report_failed',at,generation:compact.slice(0,8),reason:DISCOVERY_REPORT_CLOSE_REASONS.has(reason)?reason:'other',status:['failed','waiting','blocked'].includes(status)?status:null};
}
// A ledger entry is the compact tuple [generation (12), UTC hour key, reason index, status index]: the notice is rebuilt from it exactly, so nothing is lost by the encoding.
function encodeDiscoveryReportFault(event){
 const parts=String(event.id).match(/^discovery-hour-([0-9A-Za-z]{1,12})-(\d{8}T\d{2})$/);
 if(!parts)return null;
 const reason=DISCOVERY_REPORT_REASON_LIST.indexOf(event.reason),status=DISCOVERY_REPORT_FAULT_STATUSES.indexOf(event.status??null);
 return reason<0||status<0?null:[parts[1],parts[2],reason,status];
}
function decodeDiscoveryReportFault(tuple){
 if(!Array.isArray(tuple)||tuple.length!==4)return null;
 const [generation,hourKey,reason,status]=tuple;
 if(typeof generation!=='string'||!/^[0-9A-Za-z]{1,12}$/.test(generation)||typeof hourKey!=='string'||!/^\d{8}T\d{2}$/.test(hourKey))return null;
 if(!Number.isInteger(reason)||reason<0||reason>=DISCOVERY_REPORT_REASON_LIST.length||!Number.isInteger(status)||status<0||status>=DISCOVERY_REPORT_FAULT_STATUSES.length)return null;
 const at=hourKey.slice(0,4)+'-'+hourKey.slice(4,6)+'-'+hourKey.slice(6,8)+'T'+hourKey.slice(9,11)+':00:00.000Z';
 if(!Number.isFinite(Date.parse(at)))return null;
 return discoveryReportFailedEvent({at,hourKey,generation,reason:DISCOVERY_REPORT_REASON_LIST[reason],status:DISCOVERY_REPORT_FAULT_STATUSES[status]});
}
// The ledger of notices the journal refused: one small R2 object under its own key and its own etag, never part of the executor record.
async function readDiscoveryReportFaults(env){
 const object=await env.BUCKET.get(DISCOVERY_REPORT_FAULT_KEY);
 if(!object)return {etag:null,faults:[]};
 let doc=null;try{doc=await object.json();}catch{doc=null;}
 return {etag:object.etag,faults:Array.isArray(doc?.faults)?doc.faults.filter(tuple=>decodeDiscoveryReportFault(tuple)!==null):[]};
}
async function writeDiscoveryReportFaults(env,state,faults){
 const saved=await env.BUCKET.put(DISCOVERY_REPORT_FAULT_KEY,JSON.stringify({schemaVersion:2,faults}),{httpMetadata:{contentType:'application/json'},onlyIf:state.etag?{etagMatches:state.etag}:{etagDoesNotMatch:'*'}});
 return saved!==null;
}
const sameFault=(a,b)=>a[0]===b[0]&&a[1]===b[1];
// Delivers one notice: a create-only put under its canonical id (a repeat, or a report already stored for that hour, is kept as it is), and only when the journal
// refuses it, a durable entry in the ledger for a later firing. `lost` means the ledger is at its bound (the newest entry is refused, no older one is evicted) or both
// stores refused (a storage outage): nothing was persisted, and the log line is the trace.
async function deliverDiscoveryReportFailure(env,event){
 const written=await putDiscoveryEvent(env,event);
 if(written==='written'||written==='exists')return 'delivered';
 const tuple=encodeDiscoveryReportFault(event);
 if(!tuple)return 'lost';
 try{
  for(let attempt=0;attempt<DISCOVERY_REPORT_FAULT_ATTEMPTS;attempt++){
   const state=await readDiscoveryReportFaults(env);
   if(state.faults.some(entry=>sameFault(entry,tuple)))return 'queued';
   if(state.faults.length>=DISCOVERY_REPORT_FAULT_LIMIT)return 'lost';
   if(await writeDiscoveryReportFaults(env,state,[...state.faults,tuple]))return 'queued';
  }
 }catch{}
 return 'lost';
}
// Drains the ledger: the oldest entries first, at most DISCOVERY_REPORT_FAULT_DRAIN a firing, each put create-only; an entry leaves the ledger only after a confirmed
// put (written, or the key already holds the notice or the report of that hour). Never throws.
async function deliverDiscoveryReportFaults(env){
 try{
  const first=await readDiscoveryReportFaults(env);
  if(!first.faults.length)return {delivered:0,pending:0};
  const done=[];
  for(const tuple of first.faults.slice(0,DISCOVERY_REPORT_FAULT_DRAIN)){
   const event=decodeDiscoveryReportFault(tuple);
   const written=event?await putDiscoveryEvent(env,event):'written';
   if(written==='written'||written==='exists')done.push(tuple);
  }
  if(!done.length)return {delivered:0,pending:first.faults.length};
  for(let attempt=0;attempt<DISCOVERY_REPORT_FAULT_ATTEMPTS;attempt++){
   const state=attempt===0?first:await readDiscoveryReportFaults(env);
   const left=state.faults.filter(entry=>!done.some(item=>sameFault(item,entry)));
   if(await writeDiscoveryReportFaults(env,state,left))return {delivered:done.length,pending:left.length};
  }
 }catch{}
 return {delivered:0,pending:null};
}
// Counts the statements prepared through env.DB. Statements and batches are passed through untouched, because a
// native D1 batch only accepts native prepared statements.
function meterD1(db,meter){
 if(!db||typeof db.prepare!=='function')return db;
 return new Proxy(db,{get(target,prop){
  if(prop==='prepare')return sql=>{meter.statements++;return target.prepare(sql);};
  if(prop==='batch')return statements=>{meter.batches++;return target.batch(statements);};
  if(prop==='exec')return (...args)=>{meter.statements++;return target.exec(...args);};
  if(prop==='withSession')return (...args)=>meterD1(target.withSession(...args),meter);
  const value=Reflect.get(target,prop,target);
  return typeof value==='function'?value.bind(target):value;
 }});
}
function meteredEnv(env,meter){
 if(!env||!env.DB||typeof env.DB.prepare!=='function')return env;
 const db=meterD1(env.DB,meter);
 return new Proxy(env,{get(target,prop){return prop==='DB'?db:Reflect.get(target,prop,target);}});
}
// A step failure is logged as classes from fixed lists, never as the text of the exception: the text of a D1,
// R2 or fetch error can carry SQL, identifiers, query strings or credentials of any length and shape.
const WORKFLOW_FAILURE_CODES=new Set(['discovery_unavailable','discovery_fence','discovery_lease','discovery_conflict','discovery_bounded','discovery_not_authoritative','discovery_incomplete']);
const WORKFLOW_FAILURE_NAMES=new Set(['Error','TypeError','RangeError','SyntaxError','ReferenceError','TimeoutError','AbortError','BudgetExhaustedError','D1Error','DOMException']);
const WORKFLOW_FAILURE_CLASSES=[['network_connection_lost',/network connection lost/i],['timeout',/time(d)? ?out/i],['limit_exceeded',/too many|subrequest|exceed|limit/i],['overloaded',/overload|too busy|temporar/i],['d1_reset',/reset|restart|code was updated/i],['sql_error',/no such (table|column)|syntax error|constraint/i],['memory',/memory/i],['d1_error',/d1_|d1 |database/i]];
function workflowFailureClass(error){
 let text='';try{text=String(typeof error==='string'?error:error?.message??'');}catch{}
 if(WORKFLOW_FAILURE_CODES.has(text))return 'code';
 for(const [name,pattern] of WORKFLOW_FAILURE_CLASSES)if(pattern.test(text))return name;
 return text?'unclassified':'none';
}
function workflowFailureName(error){let name='';try{name=typeof error==='object'&&error?String(error.name??''):'';}catch{}return WORKFLOW_FAILURE_NAMES.has(name)?name:(name?'other':'none');}
function workflowFailureCode(error){let code='';try{code=error&&typeof error==='object'?String(error.code??''):'';}catch{}return WORKFLOW_FAILURE_CODES.has(code)?code:(code?'other':null);}
// AIR-364 (ADR 0098). A step that fails after the platform's own retries may be handled by the instance itself, but only
// when the failure is positively recognised as transient infrastructure: the `discovery_unavailable` code, or a transient
// class of the error or of its cause. Hard authority and fence codes, an unclassified or empty error and a non-error are
// never recovered here; they end the instance as before and the hourly reconcile decides.
const WORKFLOW_TRANSIENT_CLASSES=new Set(['network_connection_lost','timeout','limit_exceeded','overloaded','d1_reset']);
const WORKFLOW_HARD_CODES=new Set(['discovery_fence','discovery_incomplete','discovery_not_authoritative','discovery_conflict','discovery_lease','discovery_bounded']);
function workflowStepRecoverable(error,hint){
 const probe=value=>{
  if(!value||typeof value!=='object')return null;
  const code=workflowFailureCode(value);
  if(code&&WORKFLOW_HARD_CODES.has(code))return false;
  if(code==='discovery_unavailable')return true;
  return WORKFLOW_TRANSIENT_CLASSES.has(workflowFailureClass(value))?true:null;
 };
 try{
  const own=probe(error),cause=probe(error?.cause);
  if(own===false||cause===false)return false;
  if(own===true||cause===true)return true;
  return hint===true;
 }catch{return false;}
}
// One secret-free record of why a step failed. The platform keeps only the wrapper message of the last attempt.
function logWorkflowFailure(step,error,meter,total){
 try{console.error(JSON.stringify({event:'discovery_workflow_step_failed',step:String(step).replace(/[^a-z-]/g,'').slice(0,24),code:workflowFailureCode(error),name:workflowFailureName(error),class:workflowFailureClass(error),causeName:workflowFailureName(error?.cause),causeClass:workflowFailureClass(error?.cause),statements:meter?.statements??null,batches:meter?.batches??null,instanceStatements:Number.isFinite(total)?total:null}));}catch{}
}
function discoveryInstanceId(programmeRunId,series){
 const compact=String(programmeRunId||'').replace(/[^0-9A-Za-z]/g,'').slice(0,32)||'none';
 const n=Number.isInteger(series)&&series>=0?series:0;
 return `discovery_${compact}_${n}`;
}
function workflowCreateError(error){
 const text=String(error?.name||'')+' '+String(error?.message||'');
 return /already exists|already_exists|duplicate/i.test(text)?'exists':'uncertain';
}
async function readWorkflowState(env){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.readWorkflow(env);if(routed.handled)return {record:routed.record,etag:routed.etag};}
 const object=await env.BUCKET.get(DISCOVERY_WORKFLOW_STATE_KEY);
 return {record:object?await object.json():null,etag:object?(object.etag||undefined):null};
}
async function writeWorkflowState(env,record,etag){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.writeWorkflow(env,record,etag);if(routed.handled)return routed.saved===true;}
 const saved=await env.BUCKET.put(DISCOVERY_WORKFLOW_STATE_KEY,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},...(etag===undefined?{}:{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});
 return saved!==null;
}
// ADR 0103: a held projector window refuses every Discovery state write inside its own statement. These writers turn that typed
// refusal into a value, never into a step failure: nothing is written, no stall or recovery budget is charged, and the caller
// sleeps until the window's absolute expiry (the one deadline the window was granted with; a missing expiry waits a short fixed time).
const WINDOW_WAKE_FALLBACK_MS=10000,WINDOW_WAKE_CAP_MS=330000,WINDOW_RETRY_LIMIT=24,WRITE_CONFLICT_RETRY_LIMIT=3,RECONCILE_WINDOW_ATTEMPTS=3;
// ADR 0135 (AIR-459): the EPG-priority pause refuses the same state writes. It is the same kind of answer as a held window: a soft, typed refusal with a wake time (the
// 60 s poll, which never lifts the pause), no stall or recovery budget, no instance. Its reason is `epg_priority`, never `projector_window`.
const isWindowBusy=reason=>reason==='projector_window'||reason==='epg_priority';
const priorityWindow=error=>{const at=Date.parse(error?.priority?.nextCatchUpAt);return {expiresAt:Number.isFinite(at)?at:Date.now()+60000,state:'epg_priority',ownerKind:error?.priority?.ownerKind??'none',owedDayKey:error?.priority?.owedDayKey??null};};
async function writeWorkflowStateSoft(env,record,etag){
 try{return {saved:await writeWorkflowState(env,record,etag),windowBusy:false,priorityBusy:false,window:null};}
 catch(error){
  if(error?.code==='discovery_window')return {saved:false,windowBusy:true,priorityBusy:false,window:error.window||{expiresAt:null,state:null}};
  if(error?.code==='discovery_epg_priority')return {saved:false,windowBusy:false,priorityBusy:true,window:priorityWindow(error)};
  throw error;
 }
}
function windowWakeAt(source,now=Date.now()){
 const at=Number(source?.window?.expiresAt??source?.windowUntil);
 return Number.isFinite(at)&&at>0?Math.min(at,now+WINDOW_WAKE_CAP_MS):now+WINDOW_WAKE_FALLBACK_MS;
}
function logDiscoveryReconcile(outcome,meta){
 try{
  console.log(JSON.stringify({event:'discovery_workflow_reconcile',scheduled:meta?.scheduled===true,attempt:Number.isInteger(meta?.attempt)?meta.attempt:null,started:outcome?.started===true,reason:typeof outcome?.reason==='string'?outcome.reason.slice(0,48):null,programmeRunId:typeof outcome?.programmeRunId==='string'?outcome.programmeRunId.slice(0,64):null,instanceId:typeof outcome?.instanceId==='string'?outcome.instanceId.slice(0,80):null,series:Number.isInteger(outcome?.series)?outcome.series:null,windowUntil:Number.isFinite(outcome?.windowUntil)?outcome.windowUntil:null,dueAt:typeof outcome?.dueAt==='string'?outcome.dueAt.slice(0,40):null,attached:outcome?.attached===true||undefined,uncertain:outcome?.uncertain===true||undefined}));
 }catch{}
}
async function waitReconcileWindow(outcome,options,now){
 if(typeof options?.wait==='function')return options.wait(outcome,now);
 const ms=Math.min(WINDOW_WAKE_CAP_MS,Math.max(0,windowWakeAt(outcome,now)-now));
 if(!ms)return;
 if(typeof scheduler!=='undefined'&&typeof scheduler.wait==='function')await scheduler.wait(ms);
}
function publishedProgrammeRunId(generation){return generation?.phase==='published'?generation.programmeRunId||null:null;}
function workflowFailure(previous,reason,now){
 const attempts=(previous?.attempts||0)+1;
 const at=new Date(now).toISOString();
 if(attempts>DISCOVERY_WORKFLOW_RECOVERY_LIMIT)return {attempts,reason:'recovery_exhausted',at,dueAt:null,quarantined:true};
 const delay=DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS[Math.min(attempts,DISCOVERY_WORKFLOW_RECOVERY_BACKOFF_MS.length)-1];
 return {attempts,reason,at,dueAt:new Date(now+delay).toISOString(),quarantined:false};
}
function runningRecovery(recovery){
 if(!recovery||recovery.quarantined)return null;
 return {attempts:recovery.attempts||0,reason:recovery.reason||null,at:recovery.at||null,dueAt:null,quarantined:false};
}
function workflowRecoveryGate(record,now){
 if(record?.recovery?.quarantined||record?.reason==='recovery_exhausted')return {action:'exhausted'};
 if(record?.phase==='stopped'&&DISCOVERY_WORKFLOW_TERMINAL.has(record.reason))return {action:'stopped'};
 if(record?.phase!=='stopped')return {action:'active'};
 const due=Date.parse(record.recovery?.dueAt||'');
 if(!Number.isFinite(due))return {action:'arm'};
 if(due>now)return {action:'waiting',dueAt:record.recovery.dueAt};
 return {action:'successor'};
}
async function workflowOwnerGate(env,ownId,series){
 const record=(await readWorkflowState(env)).record;
 if(record?.instanceId===ownId&&record.series===series)return {owned:true};
 return {owned:false,reason:'not_owner'};
}
function workflowReadoutFacts(stored,liveness,now){
 const updated=Date.parse(stored?.updatedAt||'');
 const waiting=Date.parse(stored?.waitingUntil||'');
 const active=!!stored&&['starting','running','waiting','uncertain'].includes(stored.phase);
 const sleeping=stored?.phase==='waiting'&&Number.isFinite(waiting)&&waiting>now;
 const stalled=active&&!sleeping&&(!Number.isFinite(updated)||now-updated>DISCOVERY_WORKFLOW_FRESH_MS);
 const alive=liveness==='running'||liveness==='waiting'||liveness==='queued'||liveness==='paused';
 const dead=liveness==='complete'||liveness==='errored'||liveness==='terminated'||liveness==='absent';
 const recoveryDue=stored?.recovery?.dueAt||null;
 const recoveryDueMs=Date.parse(recoveryDue||'');
 return {active,stalled,alive,dead,recoveryDue,recoveryWaiting:Number.isFinite(recoveryDueMs)&&recoveryDueMs>now,quarantined:stored?.recovery?.quarantined===true||stored?.reason==='recovery_exhausted',updatedAt:stored?.updatedAt||null};
}
// Pure. The external hourly contract stays in continuationDecision; a future chunk_budget is renewed here only
// when the saved status proves this generation still has work.
function workflowPlan(input){
 const {published,pinned,record,lease,now,chunks,chunkLimit,last,uncertainWrites,used}=input||{};
 const spent=(used||0)>=DISCOVERY_WORKFLOW_INVOCATION_BUDGET;
 if((uncertainWrites||0)>=DISCOVERY_WORKFLOW_WRITE_LIMIT)return {action:'stop',reason:'write_uncertain'};
 if(!pinned||!published||pinned!==published||(record&&record.programmeRunId!==pinned))return {action:'stop',reason:'stale_generation'};
 if(!record)return {action:'stop',reason:'no_continuation'};
 if(lease?.expiresAt>now)return {action:'wait',until:lease.expiresAt,reason:'busy'};
 const due=Date.parse(record.retryAt||record.nextCatchUpAt||0);
 const known=last&&last.programmeRunId===pinned&&Number.isInteger(last.remaining)?last.remaining:null;
 if(record.reason==='chunk_budget'&&due>now){
  if(known>0)return spent?{action:'rollover',reason:'invocation_budget'}:(chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT)?{action:'rollover',reason:'instance_limit'}:{action:'renew',reason:'chunk_budget'};
  if(known===0)return {action:'stop',reason:'backlog_empty'};
  return {action:'wait',until:due,reason:'unknown_remaining'};
 }
 const decision=continuationDecision(record,now);
 if(!decision.run){
  const waiting=decision.contract.nextAction==='wait';
  const until=Date.parse(decision.contract.retryAt||decision.contract.nextCatchUpAt||0);
  return {action:waiting?'wait':'stop',until:Number.isFinite(until)?until:now,reason:decision.contract.reason||decision.contract.state||'stop'};
 }
 if(spent)return {action:'rollover',reason:'invocation_budget'};
 if((chunks||0)>=(chunkLimit||DISCOVERY_WORKFLOW_CHUNK_LIMIT))return {action:'rollover',reason:'instance_limit'};
 return {action:'continue',reason:null};
}
async function workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites,used){
 const generation=await loadJSON(env,EPG_GENERATION_KEY);
 const published=publishedProgrammeRunId(generation);
 const stored=await readContinuation(env);
 const lease=await loadJSON(env,'epg/resolver-lease.json');
 const last=await loadJSON(env,'epg/discovery-status.json');
 return {published,pinned,record:stored.record,lease,now:Date.now(),chunks,chunkLimit,last,uncertainWrites,used};
}
async function settleWorkflowIfOwner(env,ownId,patch){
 let state=await readWorkflowState(env);
 if(state.record?.instanceId&&state.record.instanceId!==ownId)return {saved:false,reason:'other_instance',record:state.record};
 const next={schemaVersion:1,...(state.record||{}),...(typeof patch==='function'?patch(state.record||{}):patch),instanceId:ownId,updatedAt:new Date().toISOString()};
 // ADR 0103: a held projector window refuses this state write inside its own statement. That is a soft, typed refusal with an
 // expiry, not a step failure: nothing is written, no stall or recovery budget is charged, and the caller carries on to its sleep.
 try{if(await writeWorkflowState(env,next,state.etag))return {saved:true,reason:null,record:next};}
 catch(error){if(error?.code==='discovery_window')return {saved:false,reason:'projector_window',window:error.window||null,record:state.record};if(error?.code==='discovery_epg_priority')return {saved:false,reason:'epg_priority',window:priorityWindow(error),record:state.record};throw error;}
 state=await readWorkflowState(env);
 if(state.record?.instanceId&&state.record.instanceId!==ownId)return {saved:false,reason:'other_instance',record:state.record};
 return {saved:false,reason:'write_conflict',record:state.record};
}
async function renewDiscoverySeries(env,pinned){
 const stored=await readContinuation(env),current=stored.record;
 if(!current||current.programmeRunId!==pinned)return {renewed:false,reason:'stale_generation'};
 if(current.reason!=='chunk_budget')return current.stage==='paused'&&current.remainingChunks>0?{renewed:true,reason:'already'}:{renewed:false,reason:'not_budget'};
 const last=await loadJSON(env,'epg/discovery-status.json');
 const known=last&&last.programmeRunId===pinned&&Number.isInteger(last.remaining)?last.remaining:null;
 if(!(known>0))return {renewed:false,reason:known===0?'backlog_empty':'unknown_remaining'};
 const record={...current,stage:'paused',reason:null,remainingChunks:discoveryChunkBudget(),nextCatchUpAt:null,retryAt:null,at:new Date().toISOString()};
 if(await replaceContinuation(env,record,stored.etag))return {renewed:true,reason:'renewed'};
 const after=await readContinuation(env);
 if(after.record?.programmeRunId===pinned&&after.record.reason!=='chunk_budget'&&after.record.remainingChunks>0)return {renewed:true,reason:'already'};
 return {renewed:false,reason:'write_uncertain',uncertain:true};
}
// A thrown step is retried by the platform, so this must not throw after a chunk may have committed.
async function runWorkflowChunk(env,meter){
 const before=await readContinuation(env);
 try{
  const outcome=await advanceDiscovery(env,{caller:'internal'});
  const saved=outcome?.diagnostic?.saved?.owned===true;
  const busy=outcome?.stage==='busy'||outcome?.discovery?.reason==='busy';
  return {threw:false,progress:saved,busy,until:outcome?.discovery?.nextCatchUpAt||null,summary:chunkSummary(outcome),saved};
 }catch(e){
  logWorkflowFailure('chunk',e,meter);
  let after=null;
  try{after=await readContinuation(env);}catch{}
  // An unsaved checkpoint stays `running` or keeps the etag we read. Another writer's commit is not this step's progress.
  const saved=!!(after&&after.etag!==before.etag&&after.record?.hopId&&after.record.hopId!==before.record?.hopId&&after.record.stage!=='running');
  return {threw:true,progress:saved,busy:false,error:diagnosticErrorCode(e),saved};
 }
}
async function workflowInstanceStatus(binding,id){
 if(!binding||typeof binding.get!=='function')return 'unknown';
 try{
  const instance=await binding.get(id);
  const status=typeof instance?.status==='function'?await instance.status():instance?.status;
  const name=typeof status==='string'?status:status?.status;
  return typeof name==='string'?name:'unknown';
 }catch(e){
  return /not found|does not exist|unknown instance/i.test(String(e?.message||''))?'absent':'unknown';
 }
}
async function createWorkflowInstance(env,programmeRunId,series,instanceId,etag,recovery,previous){
 const binding=env.DISCOVERY_WORKFLOW;
 const same=previous?.instanceId===instanceId;
 // AIR-410: the period accumulator and the outbox of undelivered reports belong to the executor, not to a generation or an instance: they are
 // carried over whatever replaces the record, so no delta and no pending report is lost on a generation change or a successor.
 const carry={...(previous?.report?{report:previous.report}:{}),...(Array.isArray(previous?.outbox)?{outbox:previous.outbox}:{})};
 const next={schemaVersion:1,...(same?previous:{}),...carry,programmeRunId,series,instanceId,phase:'starting',updatedAt:new Date().toISOString(),waitingUntil:null,reason:null,chunksThisInstance:same?previous.chunksThisInstance||0:0,lastProgress:same?previous.lastProgress||null:null,recovery:recovery||null};
 const first=await writeWorkflowStateSoft(env,next,etag);
 if(first.windowBusy)return {started:false,reason:'projector_window',windowUntil:first.window.expiresAt??null,programmeRunId,instanceId,series};
 if(first.priorityBusy)return {started:false,reason:'epg_priority',windowUntil:first.window.expiresAt,programmeRunId,instanceId,series};
 let wrote=first.saved;
 if(!wrote){
  const state=await readWorkflowState(env);
  if(!(state.record?.programmeRunId===programmeRunId&&state.record.instanceId===instanceId))return {started:false,reason:'write_conflict',programmeRunId,instanceId:state.record?.instanceId||instanceId,series:state.record?.series??series};
 }
 try{
  await binding.create({id:instanceId,params:{programmeRunId,series}});
  await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'started',programmeRunId,series,recovery:runningRecovery(recovery),waitingUntil:null});
  return {started:true,attached:false,reason:'started',programmeRunId,instanceId,series};
 }catch(error){
  if(workflowCreateError(error)==='exists'){
   await settleWorkflowIfOwner(env,instanceId,{phase:'running',reason:'attached',programmeRunId,series,recovery:runningRecovery(recovery),waitingUntil:null});
   return {started:true,attached:true,reason:'attached',programmeRunId,instanceId,series};
  }
  const failure=workflowFailure(recovery,'start_uncertain',Date.now());
  await settleWorkflowIfOwner(env,instanceId,{phase:failure.quarantined?'stopped':'uncertain',reason:failure.quarantined?'recovery_exhausted':'start_uncertain',programmeRunId,series,recovery:failure,waitingUntil:failure.dueAt});
  return {started:false,uncertain:!failure.quarantined,reason:failure.quarantined?'recovery_exhausted':'start_uncertain',programmeRunId,instanceId,series,dueAt:failure.dueAt};
 }
}
async function discoveryWorkflowAdmission(env){
 if(typeof env?.DISCOVERY_WORKFLOW?.create!=='function')return {ok:false,reason:'workflow_unavailable'};
 if(typeof DiscoveryAuthority==='undefined')return {ok:false,reason:'authority_not_ready'};
 let gate;
 try{gate=await DiscoveryAuthority.readAuthority(env);}
 catch{return {ok:false,reason:'d1_unavailable'};}
 if(gate?.held||gate?.cutover==='held')return {ok:false,reason:'authority_held'};
 if(gate?.transfer==='loading')return {ok:false,reason:'authority_loading'};
 if(gate?.ready!==true||gate.mode!=='d1'||gate.cutover!=='open')return {ok:false,reason:'authority_not_ready'};
 if(gate.transfer!=='idle'&&gate.transfer!=='committed')return {ok:false,reason:'authority_not_ready'};
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.currentGeneration!=='function')return {ok:false,reason:'generation_unpublished'};
 let live;
 try{live=await PublishedEpg.currentGeneration(env);}
 catch{return {ok:false,reason:'d1_unavailable'};}
 const published=live?.programmeRunId||null;
 if(!published)return {ok:false,reason:'generation_unpublished'};
 const discoveryPin=gate.publishedProgrammeRunId||null;
 if(!discoveryPin||discoveryPin!==published)return {ok:false,reason:'generation_handoff',programmeRunId:published};
 return {ok:true,programmeRunId:published};
}
async function ensurePublishedDiscoveryIntent(env,programmeRunId){
 const before=(await readContinuation(env)).record;
 const same=before?.programmeRunId===programmeRunId;
 // Same-generation programme_changed is the publication-copy artefact queueDiscovery replaces.
 if(same&&before.reason!=='programme_changed'){
  if(discoveryContract(before).nextAction==='stop')return {ok:false,reason:'stopped'};
  return {ok:true,reconstructed:false};
 }
 try{await queueDiscovery(env,'epg_committed',programmeRunId);}
 catch{return {ok:false,reason:'intent_uncertain'};}
 const after=(await readContinuation(env)).record;
 if(!after||after.programmeRunId!==programmeRunId)return {ok:false,reason:after?.programmeRunId?'stale_generation':'intent_unconfirmed'};
 if(after.reason==='programme_changed'||discoveryContract(after).nextAction==='stop')return {ok:false,reason:'stopped'};
 return {ok:true,reconstructed:!same||before.reason==='programme_changed'};
}
function workflowAdmissionError(error){
 const code=error?.code||error?.reason||'';
 if(code==='discovery_fence'||code==='authority_held')return 'authority_held';
 if(code==='discovery_incomplete'||code==='authority_loading')return 'authority_loading';
 // ADR 0103: a held projector window refuses the state write; the hourly reconcile simply tries again after its deadline.
 if(code==='discovery_window')return 'projector_window';
 // ADR 0135: the pause is a wait, not an authority or D1 fault.
 if(code==='discovery_epg_priority')return 'epg_priority';
 return 'd1_unavailable';
}
async function ensureDiscoveryWorkflow(env){
 try{
  const admitted=await discoveryWorkflowAdmission(env);
  if(!admitted.ok)return {started:false,reason:admitted.reason};
  const programmeRunId=admitted.programmeRunId;
  const intent=await ensurePublishedDiscoveryIntent(env,programmeRunId);
  if(!intent.ok)return {started:false,reason:intent.reason,programmeRunId};
  const state=await readWorkflowState(env),current=state.record;
  const same=current?.programmeRunId===programmeRunId;
  if(same&&current.instanceId&&['starting','running','waiting'].includes(current.phase))return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
  if(same&&current.instanceId&&current.phase==='uncertain'){
   const due=Date.parse(current.recovery?.dueAt||'');
   if(current.recovery?.quarantined)return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   if(Number.isFinite(due)&&due>Date.now())return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:current.recovery.dueAt};
   return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
  }
  if(same&&current?.phase==='stopped'){
   const gate=workflowRecoveryGate(current,Date.now());
   if(gate.action==='exhausted')return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   if(gate.action==='stopped')return {started:false,reason:'stopped',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   if(gate.action==='waiting')return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:gate.dueAt};
   if(gate.action==='arm'){
    const failure=workflowFailure(current.recovery,current.reason||'stopped',Date.now());
    const next={...current,reason:failure.quarantined?'recovery_exhausted':current.reason,recovery:failure,updatedAt:new Date().toISOString(),waitingUntil:failure.dueAt};
    {const w=await writeWorkflowStateSoft(env,next,state.etag);if(w.windowBusy)return {started:false,reason:'projector_window',windowUntil:w.window.expiresAt??null,programmeRunId,instanceId:current.instanceId,series:current.series??0};if(w.priorityBusy)return {started:false,reason:'epg_priority',windowUntil:w.window.expiresAt,programmeRunId,instanceId:current.instanceId,series:current.series??0};if(!w.saved)return {started:false,reason:'write_conflict',programmeRunId,instanceId:current.instanceId,series:current.series??0};}
    return {started:false,reason:failure.quarantined?'recovery_exhausted':'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:failure.dueAt};
   }
   const series=(current.series||0)+1;
   return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,current.recovery||null,current);
  }
  const series=0;
  return createWorkflowInstance(env,programmeRunId,series,discoveryInstanceId(programmeRunId,series),state.etag,null);
 }catch(error){return {started:false,reason:workflowAdmissionError(error),...(error?.code==='discovery_window'?{windowUntil:error.window?.expiresAt??null}:error?.code==='discovery_epg_priority'?{windowUntil:priorityWindow(error).expiresAt}:{})};}
}
async function reconcileDiscoveryWorkflowAttempt(env,options={}){
 try{
 const admitted=await discoveryWorkflowAdmission(env);
 if(!admitted.ok)return {started:false,reason:admitted.reason};
 const programmeRunId=admitted.programmeRunId;
 const intent=await ensurePublishedDiscoveryIntent(env,programmeRunId);
 if(!intent.ok)return {started:false,reason:intent.reason,programmeRunId};
 const binding=env.DISCOVERY_WORKFLOW;
 const state=await readWorkflowState(env),current=state.record;
 const same=current?.programmeRunId===programmeRunId&&current.instanceId;
 const active=same&&['starting','running','waiting','uncertain'].includes(current.phase);
 if(active){
  const status=await workflowInstanceStatus(binding,current.instanceId);
  if(status==='complete'||status==='errored'||status==='terminated'){
   const failure=workflowFailure(current.recovery,'instance_'+status,Date.now());
   const next={...current,phase:'stopped',reason:failure.quarantined?'recovery_exhausted':failure.reason,recovery:failure,updatedAt:new Date().toISOString(),waitingUntil:failure.dueAt};
   {const w=await writeWorkflowStateSoft(env,next,state.etag);if(w.windowBusy)return {started:false,reason:'projector_window',windowUntil:w.window.expiresAt??null,programmeRunId,instanceId:current.instanceId,series:current.series??0};if(w.priorityBusy)return {started:false,reason:'epg_priority',windowUntil:w.window.expiresAt,programmeRunId,instanceId:current.instanceId,series:current.series??0};if(!w.saved)return {started:false,reason:'write_conflict',programmeRunId,instanceId:current.instanceId,series:current.series??0};}
   return {started:false,reason:failure.quarantined?'recovery_exhausted':'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:failure.dueAt};
  }
  if(current.phase==='uncertain'||status==='absent'){
   const due=Date.parse(current.recovery?.dueAt||'');
   if(current.recovery?.quarantined)return {started:false,reason:'recovery_exhausted',programmeRunId,instanceId:current.instanceId,series:current.series??0};
   if(Number.isFinite(due)&&due>Date.now())return {started:false,reason:'recovery_waiting',programmeRunId,instanceId:current.instanceId,series:current.series??0,dueAt:current.recovery.dueAt};
   return createWorkflowInstance(env,programmeRunId,current.series||0,current.instanceId,state.etag,current.recovery||null,current);
  }
  return {started:false,reason:'in_progress',programmeRunId,instanceId:current.instanceId,series:current.series??0};
 }
 return ensureDiscoveryWorkflow(env);
 }catch(error){return {started:false,reason:workflowAdmissionError(error),...(error?.code==='discovery_window'?{windowUntil:error.window?.expiresAt??null}:error?.code==='discovery_epg_priority'?{windowUntil:priorityWindow(error).expiresAt}:{})};}
}
// AIR-428: a scheduled firing retries a projector-window refusal in the same tick, after the window's one expiry.
// An unscheduled caller still returns the typed refusal immediately. Each attempt, including a refusal, is logged;
// a green cron is not a Discovery recovery.
async function reconcileDiscoveryWorkflow(env,options={}){
 const scheduled=options?.scheduled===true;
 let attempt=0,outcome;
 do{
  attempt++;
  outcome=await reconcileDiscoveryWorkflowAttempt(env,options);
  logDiscoveryReconcile(outcome,{scheduled,attempt});
  if(!scheduled||outcome?.reason!=='projector_window'||attempt>=RECONCILE_WINDOW_ATTEMPTS)break;
  await waitReconcileWindow(outcome,options,Date.now());
 }while(attempt<RECONCILE_WINDOW_ATTEMPTS);
 // AIR-410: a real scheduled firing reports its period whatever the outcome was, a refusal and an idle pipeline included. Best effort: the report
 // never changes what this reconcile answers and never throws.
 if(scheduled)await closeHourlyDiscoveryReport(env,outcome,options);
 return outcome;
}
async function rolloverDiscoveryWorkflow(env,pinned,ownSeries){
 const state=await readWorkflowState(env);
 if(state.record?.programmeRunId&&state.record.programmeRunId!==pinned)return {started:false,reason:'stale_generation'};
 if(state.record?.instanceId&&state.record.instanceId!==discoveryInstanceId(pinned,ownSeries))return {started:true,attached:true,reason:'attached',programmeRunId:pinned,instanceId:state.record.instanceId,series:state.record.series};
 const series=(ownSeries||0)+1,instanceId=discoveryInstanceId(pinned,series);
 return createWorkflowInstance(env,pinned,series,instanceId,state.etag,null,state.record);
}
async function stopOwnedWorkflow(env,ownId,reason,pinned,series,chunks){
 const state=await readWorkflowState(env);
 const owned=state.record?.instanceId===ownId&&state.record.series===series;
 let recovery=null,finalReason=reason;
 if(owned&&DISCOVERY_WORKFLOW_RECOVERABLE.has(reason)){
  recovery=workflowFailure(state.record.recovery,reason,Date.now());
  if(recovery.quarantined)finalReason='recovery_exhausted';
 }
 const settled=await settleWorkflowIfOwner(env,ownId,{phase:'stopped',reason:finalReason,programmeRunId:pinned,series,chunksThisInstance:chunks,waitingUntil:recovery?.dueAt||null,recovery});
 return {stopped:true,reason:finalReason,chunks,instanceId:ownId,settled:settled?.saved===true,settleReason:settled?.reason||null,...(isWindowBusy(settled?.reason)?{windowUntil:settled.window?.expiresAt??null}:{})};
}
// AIR-364 (ADR 0098). Arms the recovery of a recognised step failure and proves what was persisted. The write is one expected-etag CAS
// of the whole record; a lost CAS re-reads and recomputes from the fresh record (at most three times), so the attempt counter moves
// once and the due time is the one just computed, never a retained older one. `armedFor` marks the record this instance armed: a
// retry of the step after the write landed finds it and reuses it instead of counting the failure again. Without a proven write the
// result is `armed: false` and the caller creates nothing.
async function armStepFailureRecovery(env,ownId,series,pinned,chunks){
 for(let attempt=0;attempt<3;attempt++){
  const state=await readWorkflowState(env),record=state.record;
  if(record?.instanceId!==ownId||record.series!==series)return {armed:false,reason:'not_owner'};
  if(record.phase==='stopped'&&record.recovery?.armedFor===ownId)return {armed:true,quarantined:record.recovery.quarantined===true,dueAt:record.recovery.dueAt||null,attempts:record.recovery.attempts||0};
  const failure={...workflowFailure(record.recovery,'step_failure',Date.now()),armedFor:ownId};
  const next={schemaVersion:1,...record,programmeRunId:pinned,series,instanceId:ownId,phase:'stopped',reason:failure.quarantined?'recovery_exhausted':'step_failure',chunksThisInstance:chunks,waitingUntil:failure.dueAt,recovery:failure,updatedAt:new Date().toISOString()};
  const w=await writeWorkflowStateSoft(env,next,state.etag);
  if(w.windowBusy)return {armed:false,reason:'projector_window',windowUntil:w.window.expiresAt??null};
  if(w.priorityBusy)return {armed:false,reason:'epg_priority',windowUntil:w.window.expiresAt};
  if(w.saved)return {armed:true,quarantined:failure.quarantined===true,dueAt:failure.dueAt,attempts:failure.attempts};
 }
 return {armed:false,reason:'write_conflict'};
}
async function runDiscoveryWorkflow(rawEnv,payload,step){
 // `meter` counts this invocation. A replay after a sleep starts a new invocation and a new meter, so each step also
 // returns what it spent and `tally.total` re-adds those cached outputs: it is the count of the whole instance.
 // Outputs written before this change carry no count and add nothing.
 const meter={statements:0,batches:0};
 const tally={total:0};
 const failure={recoverable:false};
 const env=meteredEnv(rawEnv,meter);
 const accounted=(name,fn)=>async()=>{
  const before=meter.statements;
  try{const value=await fn();return {__counted:1,value,spent:meter.statements-before};}
  catch(error){logWorkflowFailure(name,error,meter,tally.total);failure.recoverable=workflowStepRecoverable(error,false);throw error;}
 };
 const pinned=payload?.programmeRunId||null;
 const series=Number.isInteger(payload?.series)&&payload.series>=0?payload.series:0;
 const ownId=discoveryInstanceId(pinned,series);
 const requested=payload?.chunkLimit;
 const chunkLimit=Number.isInteger(requested)&&requested>=1&&requested<=DISCOVERY_WORKFLOW_CHUNK_LIMIT?requested:DISCOVERY_WORKFLOW_CHUNK_LIMIT;
 let chunks=0,stalls=0,uncertainWrites=0,steps=0;
 const stepName=prefix=>prefix+'-'+(steps++);
 const doStep=async(prefix,fn)=>{
  const result=await step.do(stepName(prefix),accounted(prefix,fn));
  if(result&&result.__counted===1){tally.total+=Number(result.spent)||0;return result.value;}
  return result;
 };
 // AIR-364 (ADR 0098). A recoverable step failure, after the platform's retries, is armed once through the same owner CAS and
 // `workflowFailure` backoff as every other recovery, then the instance sleeps durably until `dueAt` and asks the existing
 // `ensureDiscoveryWorkflow` for the successor, which re-reads authority, generation, executor record and the recovery gate. The
 // hourly reconcile stays the fallback. A failure of the arming step itself is not caught here: the instance ends as before.
 // ADR 0103. A checkpoint (progress, final stop, recovery arming) is only done when it is confirmed persisted by the owner. `persist`
 // runs the step again until it is: a window refusal sleeps to the window's expiry and tries again (at most `windowRetryLimit` times,
 // each a bounded sleep), a lost compare-and-swap tries again without a sleep (at most WRITE_CONFLICT_RETRY_LIMIT times), and the step
 // cap bounds both. It never treats exhausted retries as a saved write and never as lost ownership: it answers `deferred`, and the
 // caller ends the instance in an explicit deferred state that the hourly reconcile recovers (the record still names this instance).
 // No window refusal is charged to the stall or the recovery budget.
 const windowRetryLimit=Number.isInteger(payload?.windowRetryLimit)&&payload.windowRetryLimit>=1&&payload.windowRetryLimit<=WINDOW_RETRY_LIMIT?payload.windowRetryLimit:WINDOW_RETRY_LIMIT;
 const persist=async(prefix,fn,classify)=>{
  let windows=0,conflicts=0,tries=0,last=null;
  for(;;){
   last=await doStep(tries++?prefix+'-retry':prefix,fn);
   const kind=classify(last);
   if(kind==='saved'||kind==='lost')return {kind,result:last};
   if(kind==='conflict_final')return {kind:'deferred',cause:'conflict',result:last};
   if(kind==='window'){
    if(++windows>=windowRetryLimit||steps>=DISCOVERY_WORKFLOW_STEP_CAP)return {kind:'deferred',cause:'window',result:last};
    await step.sleepUntil(stepName('window-sleep'),new Date(windowWakeAt(last)));
    continue;
   }
   if(++conflicts>=WRITE_CONFLICT_RETRY_LIMIT||steps>=DISCOVERY_WORKFLOW_STEP_CAP)return {kind:'deferred',cause:'conflict',result:last};
  }
 };
 const settleKind=result=>result?.saved===true?'saved':isWindowBusy(result?.reason)?'window':result?.reason==='other_instance'?'lost':'conflict';
 const deferredExit=(reason,cause,extra={})=>({stopped:true,deferred:true,reason:cause==='window'?'window_'+reason:reason+'_write_conflict',chunks,instanceId:ownId,...extra});
 const finish=async(prefix,reason)=>{
  const done=await persist(prefix,()=>stopOwnedWorkflow(env,ownId,reason,pinned,series,chunks),result=>result?.settled===true?'saved':isWindowBusy(result?.settleReason)?'window':result?.settleReason==='other_instance'?'lost':'conflict');
  if(done.kind==='deferred')return deferredExit('stop_unsaved',done.cause,{intended:reason});
  const {stopped,reason:final,chunks:count,instanceId}=done.result;
  return {stopped,reason:final,chunks:count,instanceId};
 };
 const recoverAfterStepFailure=async()=>{
  const arming=await persist('recover-arm',()=>armStepFailureRecovery(env,ownId,series,pinned,chunks),result=>result?.armed===true?'saved':isWindowBusy(result?.reason)?'window':result?.reason==='not_owner'?'lost':'conflict_final');
  // The arming step already retries its own lost compare-and-swap three times (ADR 0098): a further conflict is the existing, explicit stop.
  if(arming.kind==='deferred'&&arming.cause==='conflict')return {stopped:true,reason:'recovery_write_conflict',chunks,instanceId:ownId};
  if(arming.kind==='deferred')return deferredExit('recovery_unarmed',arming.cause);
  const armed=arming.result;
  if(arming.kind==='lost')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
  if(armed.quarantined||!Number.isFinite(Date.parse(armed.dueAt||'')))return {stopped:true,reason:'recovery_exhausted',chunks,instanceId:ownId};
  for(let attempt=0;attempt<3;attempt++){
   await step.sleepUntil(stepName('recover-sleep'),new Date(armed.dueAt));
   const woke=await doStep('recover-successor',async()=>{
    const owned=await workflowOwnerGate(env,ownId,series);
    if(!owned.owned)return {done:true,started:false,reason:'not_owner'};
    // A successor is only ever opened for the generation this instance was pinned to. A newer generation is started by its own
    // commit and the reconcile, never by a stale instance.
    const admitted=await discoveryWorkflowAdmission(env);
    if(!admitted.ok)return {done:true,started:false,reason:admitted.reason};
    if(admitted.programmeRunId!==pinned)return {done:true,started:false,reason:'stale_generation'};
    const outcome=await ensureDiscoveryWorkflow(env);
    return {done:outcome.reason!=='recovery_waiting'&&!isWindowBusy(outcome.reason),started:outcome.started===true,reason:outcome.reason||null,until:isWindowBusy(outcome.reason)?windowWakeAt(outcome):null};
   });
   if(woke.done)return {stopped:true,reason:woke.started?'recovered':(woke.reason||'recovery_stopped'),chunks,instanceId:ownId};
   if(woke.until)await step.sleepUntil(stepName('window-sleep'),new Date(woke.until));
  }
  return {stopped:true,reason:'recovery_waiting',chunks,instanceId:ownId};
 };
 try{
   for(;;){
    const gate=await doStep('owner',()=>workflowOwnerGate(env,ownId,series));
    if(!gate.owned)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
    if(steps>=DISCOVERY_WORKFLOW_STEP_CAP){
     return finish('cap','step_cap');
    }
    const plan=await doStep('plan',async()=>workflowPlan(await workflowPlanInput(env,pinned,chunks,chunkLimit,uncertainWrites,tally.total)));
    if(plan.action==='stop')return finish('stop',plan.reason);
    if(plan.action==='wait'){
     const until=Number.isFinite(plan.until)?plan.until:Date.now()+1000;
     const settledWait=await doStep('wait',()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:plan.reason,waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
     await step.sleepUntil(stepName('sleep'),new Date(isWindowBusy(settledWait?.reason)?Math.max(until,windowWakeAt(settledWait)):until));
     continue;
    }
    if(plan.action==='renew'){
     const renewed=await doStep('renew',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {renewed:false,reason:'not_owner'};return renewDiscoverySeries(env,pinned);});
     if(renewed.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
     if(renewed.renewed){uncertainWrites=0;continue;}
     if(renewed.reason==='unknown_remaining'||renewed.reason==='backlog_empty'||renewed.reason==='stale_generation')continue;
     uncertainWrites++;
     await step.sleepUntil(stepName('renew-sleep'),new Date(Date.now()+1000));
     continue;
    }
    if(plan.action==='rollover'){
     const rolled=await doStep('rollover',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {started:false,reason:'not_owner'};return rolloverDiscoveryWorkflow(env,pinned,series);});
     if(rolled.reason==='not_owner')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
     if(isWindowBusy(rolled.reason)){await step.sleepUntil(stepName('window-sleep'),new Date(windowWakeAt(rolled)));continue;}
     if(!rolled.started)await finish('rollover-stop','rollover_uncertain');
     return {stopped:true,reason:rolled.started?'rollover':'rollover_uncertain',chunks,instanceId:ownId,successor:rolled};
    }
    const outcome=await doStep('chunk',async()=>{const owned=await workflowOwnerGate(env,ownId,series);if(!owned.owned)return {notOwner:true,progress:false,busy:false};return runWorkflowChunk(env,meter);});
    if(outcome.notOwner)return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
    if(outcome.busy){
     const until=Date.parse(outcome.until||'')||Date.now()+1000;
     const settledBusy=await doStep('busy',()=>settleWorkflowIfOwner(env,ownId,{phase:'waiting',reason:'busy',waitingUntil:new Date(until).toISOString(),programmeRunId:pinned,series,chunksThisInstance:chunks}));
     // ADR 0103: a busy checkpoint refused by a held projector window waits for that window's one expiry (capped like every window wait), not for the
     // hourly gate the busy chunk carries in `until`. A refusal that names no readable deadline keeps the later of `until` and the fallback, as before.
     const windowKnown=isWindowBusy(settledBusy?.reason)&&Number.isFinite(Number(settledBusy?.window?.expiresAt??settledBusy?.windowUntil))&&Number(settledBusy?.window?.expiresAt??settledBusy?.windowUntil)>0;
     await step.sleepUntil(stepName('busy-sleep'),new Date(windowKnown?windowWakeAt(settledBusy):isWindowBusy(settledBusy?.reason)?Math.max(until,windowWakeAt(settledBusy)):until));
     continue;
    }
    if(!outcome.progress){
     stalls++;
     if(stalls>=DISCOVERY_WORKFLOW_STALL_LIMIT)return finish('stall','no_progress');
     await step.sleepUntil(stepName('stall-sleep'),new Date(Date.now()+1000));
     continue;
    }
    stalls=0;uncertainWrites=0;chunks++;
    // A window that opened between the chunk and this checkpoint refuses it: the chunk did happen (the count above stays), the record
    // is re-saved after the window's expiry, and a refusal is never a stall.
    // AIR-410: the chunk's key is its instance and its ordinal in that instance, stable across a replay. The patch is a function of the record read
    // inside the compare-and-swap, so a cron closing the period in between cannot be overwritten, and a retried checkpoint adds nothing twice.
    const chunkKey=ownId+':'+chunks;
    const progressPatch=record=>({phase:'running',reason:null,programmeRunId:pinned,series,chunksThisInstance:chunks,lastProgress:outcome.summary||null,invocation:{statements:meter.statements,batches:meter.batches},instance:{statements:tally.total},waitingUntil:null,recovery:null,report:addChunkToDiscoveryReport(record.report,outcome.summary,chunkKey,pinned)});
    const checkpoint=await persist('progress',()=>settleWorkflowIfOwner(env,ownId,progressPatch),settleKind);
    if(checkpoint.kind==='lost')return {stopped:true,reason:'not_owner',chunks,instanceId:ownId};
    if(checkpoint.kind==='deferred')return deferredExit('checkpoint_unsaved',checkpoint.cause);
   }
 }catch(error){
  if(!workflowStepRecoverable(error,failure.recoverable))throw error;
  return recoverAfterStepFailure();
 }
}
