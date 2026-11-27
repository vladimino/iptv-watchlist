// AIR-605 (card C1; ADR 0211 decisions 3 and 6 as amended by ADR 0219 decisions 2, 3 and 9). The STORAGE side of the Catalog Enrichment Producer: the durable control and its compare-and-swap operations, the
// `projection_run` lease, the code emitter of the inbox, the runnable-signal read and the GUARDED consumption of one signal. DORMANT: nothing in the Worker imports it yet; every function refuses or answers "not active"
// while the control row is absent or `inactive`, and the migration that creates the tables is not applied by a deploy.
//   - control: one row (`catalog_enrichment_control`); an absent row reads as `inactive`. Operations are compare-and-swap on `revision`; every change raises `generation` too, so every in-flight batch of an older plan fails.
//     Activation is an owner production operation (card C2) and is NOT reachable from pause or resume.
//   - consume: ONE batch in which EVERY effect statement carries the same guard (the signal is pending at exactly version v, the control is active at the plan's generation, the lease is live, at least one enabled scope justifies
//     the effect), and the acknowledgement is the last statement with the same full guard. A guard that fails applies nothing and the newest version stays pending; a replay finds acked_version >= v and writes nothing.
import {database,failed,many,one} from './film-person-authority.js';
import {controlGuard,leaseGuard} from './catalog-enrichment-plan.js';

export const LEASE_PROJECTION='catalog_enrichment';
export const LEASE_TTL_MS=5*60000;
export const SCOPES=Object.freeze(['rated','c3a','c3b','discovery']);
// The scopes whose membership an `admitted` signal of a source may create.
export const SOURCE_SCOPES=Object.freeze({rated:['rated'],watchlist:['c3b'],discovery:['discovery'],letterboxd:[]});
// A scope that is bootstrapped from existing members (not from a live emitter of its own) is addressed by the signal's PART: `admitted | tmdb:<n> | rated | c3a` is the c3a membership of that Film, a different key from its rated
// membership, so the two scopes keep distinct authorized memberships and each deduplicates only its own overlap. The cutoff of the rated scope can never be bypassed by the c3a signal, and vice versa.
export const PART_SCOPES=Object.freeze(['c3a']);
export const signalScopes=signal=>PART_SCOPES.includes(signal?.part)?[signal.part]:(SOURCE_SCOPES[signal?.source]||[]);
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant=value=>{if(typeof value!=='string'||!ISO.test(value))throw failed('film_person_invalid');return value;};
const marks=list=>list.map(()=>'?').join(',');
const absentTable=error=>/no such table/i.test(String(error?.cause?.message||error?.message||error));
const db=env=>{const handle=database(env);if(!handle)throw failed('film_person_unavailable');return handle;};
const batch=async(env,statements)=>{
 const handle=db(env);
 try{return await handle.batch(statements.map(([sql,params])=>handle.prepare(sql).bind(...params)));}
 catch(error){throw failed('film_person_unavailable',error);}
};

// ---- control ----
// -> {state, generation, revision, updatedAt, updatedBy, present}. An absent row or an absent table is `inactive`: the producer does nothing.
export async function readControl(env){
 try{
  const row=await one(db(env),'SELECT state,generation,revision,updated_at,updated_by FROM catalog_enrichment_control WHERE id=1');
  if(!row)return {present:false,state:'inactive',generation:0,revision:0,updatedAt:null,updatedBy:null};
  return {present:true,state:row.state,generation:Number(row.generation),revision:Number(row.revision),updatedAt:row.updated_at,updatedBy:row.updated_by};
 }catch(error){
  if(absentTable(error))return {present:false,state:'inactive',generation:0,revision:0,updatedAt:null,updatedBy:null,tables:false};
  throw failed('film_person_unavailable',error);
 }
}
// One function for the three operations (decision 6). `expectedRevision` is the compare-and-swap: a stale request changes nothing and says so. Every applied change raises generation and revision. The answer is read back:
// {outcome:'applied'|'rejected'|'uncertain', control}. `uncertain` means the write was sent and the readback failed (the route answers 503 with outcome unknown).
const TRANSITION={activate:['inactive','active'],pause:['active','paused'],resume:['paused','active']};
export async function changeControl(env,{action,expectedRevision,by,at,allowActivate=false}){
 const rule=TRANSITION[action];
 if(!rule||!Number.isInteger(expectedRevision)||expectedRevision<0||typeof by!=='string'||!by||by.length>200)throw failed('film_person_invalid');
 instant(at);
 // Activation is an owner production operation (C2): the pause and resume entry points never reach it.
 if(action==='activate'&&allowActivate!==true)throw failed('catalog_enrichment_activation_not_allowed');
 const current=await readControl(env);
 if(current.tables===false)throw failed('catalog_enrichment_schema_missing');
 if(current.revision!==expectedRevision||current.state!==rule[0]&&!(action==='activate'&&!current.present))return {outcome:'rejected',control:current};
 const statements=[];
 if(!current.present)statements.push(["INSERT INTO catalog_enrichment_control (id,state,generation,revision,updated_at,updated_by) VALUES (1,'inactive',0,1,?,?) ON CONFLICT(id) DO NOTHING",[at,by]]);
 const base=current.present?current.revision:1,generation=current.present?current.generation:0;
 statements.push(["UPDATE catalog_enrichment_control SET state=?,generation=generation+1,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND state=? AND revision=?",[rule[1],at,by,rule[0],base]]);
 try{await batch(env,statements);}catch(error){
  if(/catalog_enrichment_control_transition/.test(String(error?.cause?.message||error?.message)))return {outcome:'rejected',control:await readControl(env)};
  throw error;
 }
 let after;
 try{after=await readControl(env);}catch{return {outcome:'uncertain',control:null};}
 return {outcome:after.revision>base&&after.state===rule[1]&&after.generation>generation?'applied':'rejected',control:after};
}
export const pauseControl=(env,input)=>changeControl(env,{...input,action:'pause'});
export const resumeControl=(env,input)=>changeControl(env,{...input,action:'resume'});
export const activateControl=(env,input)=>changeControl(env,{...input,action:'activate',allowActivate:true});

// ---- lease (one `projection_run` row, a fresh random lease id per acquisition) ----
// -> {acquired:true, leaseId, until} or {acquired:false}. The row is taken only when free or expired, by one conditional upsert, and read back to prove it is ours.
export async function acquireLease(env,{leaseId,now,ttlMs=LEASE_TTL_MS}){
 if(typeof leaseId!=='string'||leaseId.length<8||leaseId.length>100)throw failed('film_person_invalid');
 instant(now);
 const until=new Date(Date.parse(now)+ttlMs).toISOString();
 await batch(env,[["INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES (?,?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at WHERE projection_run.lease_id IS NULL OR projection_run.lease_until<=?",[LEASE_PROJECTION,leaseId,until,now,now]]]);
 const row=await one(db(env),'SELECT lease_id,lease_until FROM projection_run WHERE projection=?',[LEASE_PROJECTION]);
 return row?.lease_id===leaseId?{acquired:true,leaseId,until:row.lease_until}:{acquired:false};
}
// Extends our own live lease only (a step renews before it starts). -> boolean
export async function renewLease(env,{leaseId,now,ttlMs=LEASE_TTL_MS}){
 instant(now);
 const until=new Date(Date.parse(now)+ttlMs).toISOString();
 await batch(env,[["UPDATE projection_run SET lease_until=? WHERE projection=? AND lease_id=? AND lease_until>?",[until,LEASE_PROJECTION,leaseId,now]]]);
 return (await one(db(env),'SELECT lease_until FROM projection_run WHERE projection=? AND lease_id=?',[LEASE_PROJECTION,leaseId]))?.lease_until===until;
}
// Releases by compare-and-swap on our lease id (a handover). The row stays; the lease is simply free.
export async function releaseLease(env,{leaseId,now}){
 instant(now);
 const before=await one(db(env),'SELECT lease_id FROM projection_run WHERE projection=?',[LEASE_PROJECTION]);
 if(before?.lease_id!==leaseId)return false;
 await batch(env,[["UPDATE projection_run SET lease_id=NULL,lease_until=NULL,finished_at=? WHERE projection=? AND lease_id=?",[now,LEASE_PROJECTION,leaseId]]]);
 return (await one(db(env),'SELECT lease_id FROM projection_run WHERE projection=?',[LEASE_PROJECTION]))?.lease_id==null;
}

// ---- the inbox: emit (code emitter) ----
// A code emitter appends its signal in the same batch as the change it reports: this returns the ONE statement. A digest-carrying signal re-arms only when `cause_digest` differs from the stored one, so an identical
// observation writes nothing and wakes nothing.
export function emitStatement({kind,subject,source='',part='',digest=null,cause=null,at}){
 instant(at);
 if(!['admitted','anchor_changed','source_changed','protection_released'].includes(kind)||typeof subject!=='string'||!subject)throw failed('film_person_invalid');
 return [`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_digest,cause_ref,armed_at,attempts) VALUES (?,?,?,?,1,0,'pending',?,?,?,0) ON CONFLICT (kind,subject,source,part) DO UPDATE SET version=version+1,state='pending',cause_digest=excluded.cause_digest,cause_ref=excluded.cause_ref,armed_at=excluded.armed_at,attempts=0,last_error=NULL,retry_at=NULL WHERE enrichment_signal.cause_digest IS NOT excluded.cause_digest OR excluded.cause_digest IS NULL`,[kind,subject,source,part,digest,cause,at]];
}

export async function provenanceEnforcing(handle){
 try{const row=await one(handle,'SELECT mode FROM film_metadata_provenance_control WHERE id=1');return row?.mode==='enforce';}
 catch(error){if(/no such table/i.test(String(error?.cause?.message||error?.message||error)))return false;throw error;}
}
// ---- runnable signals ----
// A signal is runnable when it is pending, its scope is enabled (an `admitted` signal) or some enabled membership of its Film exists (the others), it is RESOLVED (its Film exists) and its retry is due. Held (disabled
// scope), unresolved and backed-off signals are not runnable, so they cannot keep a run spinning or cancel a park. -> [{kind, subject, source, part, version, filmId}]
export async function runnableSignals(env,{now,limit=50}){
 instant(now);
 const handle=db(env);
 // ADR 0224 (AIR-633): a `language_upgrade` signal stays pending, and held, until the provenance mode is `enforce` (schema absent reads as not enforcing)
 const enforcing=await provenanceEnforcing(handle);
 // Eligibility is decided in SQL BEFORE the window: a signal whose source has no enabled scope is not a candidate, so held heads can never fill the LIMIT and hide runnable signals behind them.
 const sources=Object.keys(SOURCE_SCOPES).filter(source=>(SOURCE_SCOPES[source]||[]).length);
 const eligible=[...sources.map(source=>`(s.source=? AND s.part='' AND EXISTS (SELECT 1 FROM catalog_enrichment_scope c WHERE c.enabled=1 AND c.scope IN (${marks(SOURCE_SCOPES[source])})))`),...PART_SCOPES.map(()=>"(s.part=? AND EXISTS (SELECT 1 FROM catalog_enrichment_scope c WHERE c.enabled=1 AND c.scope=?))")].join(' OR ')||'0';
 const eligibleParams=[...sources.flatMap(source=>[source,...SOURCE_SCOPES[source]]),...PART_SCOPES.flatMap(scope=>[scope,scope])];
 const admitted=await many(handle,`SELECT s.kind,s.subject,s.source,s.part,s.version,s.cause_digest AS digest,e.film_id AS film_id FROM enrichment_signal s JOIN film_external_id e ON e.scheme='tmdb' AND e.value=substr(s.subject,6) AND e.trusted=1 AND e.conflicting=0 WHERE s.kind='admitted' AND s.state='pending' AND s.acked_version<s.version AND s.subject LIKE 'tmdb:%' AND (s.retry_at IS NULL OR s.retry_at<=?) AND (${eligible}) AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=e.film_id) ORDER BY s.armed_at LIMIT ?`,[now,...eligibleParams,limit]);
 const others=await many(handle,`SELECT s.kind,s.subject,s.source,s.part,s.version,s.cause_digest AS digest,s.subject AS film_id FROM enrichment_signal s WHERE s.kind<>'admitted' AND s.state='pending' AND s.acked_version<s.version AND (s.retry_at IS NULL OR s.retry_at<=?) AND (s.cause_ref IS NOT 'language_upgrade' OR ?=1) AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=s.subject) AND EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1 WHERE m.film_id=s.subject) ORDER BY s.armed_at LIMIT ?`,[now,enforcing?1:0,limit]);

 return [...admitted,...others].map(row=>({kind:row.kind,subject:row.subject,source:row.source,part:row.part,version:Number(row.version),digest:row.digest??null,filmId:row.film_id}));
}

// ---- guarded consumption ----
// ONE condition, repeated verbatim in every effect and in the acknowledgement. `scopes`: the scopes whose enabled flag justifies the effect (admitted: the source's scopes); for the other kinds `filmId` selects "at least
// one enabled membership of the Film" instead.
// The RESOLVED IDENTITY is part of the guard: an `admitted` effect still names the Film that holds the trusted, non-conflicting tmdb claim at commit time and that Film is not redirected; any other effect names a Film that still
// exists and is not redirected. A claim that moved, a merge or a retirement after the signal was read therefore applies nothing and leaves the newest version pending.
function identityGuard(signal){
 const filmId=signal.filmId||signal.subject;
 if(signal.kind==='admitted'){
  const value=String(signal.subject).startsWith('tmdb:')?String(signal.subject).slice(5):'';
  return {sql:"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)",params:[filmId,value,filmId]};
 }
 return {sql:'EXISTS (SELECT 1 FROM film WHERE id=?) AND NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)',params:[filmId,filmId]};
}
export function consumeGuard({signal,generation,leaseId,now,scopes=null}){
 const lease=leaseGuard(leaseId,now),control=controlGuard(generation),identity=identityGuard(signal);
 const justification=scopes?{sql:`EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE enabled=1 AND scope IN (${marks(scopes)}))`,params:[...scopes]}:{sql:'EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1 WHERE m.film_id=?)',params:[signal.filmId||signal.subject]};
 const sql=`(EXISTS (SELECT 1 FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=? AND state='pending' AND version=? AND acked_version<?) AND ${control.sql} AND ${lease.sql} AND ${justification.sql} AND ${identity.sql})`;
 return {sql,params:[signal.kind,signal.subject,signal.source??'',signal.part??'',signal.version,signal.version,...control.params,...lease.params,...justification.params,...identity.params]};
}
// The effect statements of one signal kind, each `WHERE <guard>`; the acknowledgement is appended last by `consumeSignal`.
// admitted: the retained membership and the Film's state row. The other kinds reopen work: the Film's `plan_epoch` and, once, the `refresh_epoch` of the affected rows (every row for an anchor change, the part for a protection
// release, the part and source for a verified source change whose digest is not the one the part applied); an `identity_disagreement` is lifted by an anchor change.
export function effectStatements({signal,guard,at}){
 const G=guard.sql,params=()=>[...guard.params];
 const filmId=signal.filmId||signal.subject;
 if(signal.kind==='admitted'){
  const scopes=signalScopes(signal);
  return [
   [`INSERT OR IGNORE INTO catalog_enrichment_member (film_id,scope,admitted_at,signal_key) SELECT ?,scope,?,? FROM catalog_enrichment_scope WHERE enabled=1 AND scope IN (${marks(scopes)}) AND ${G} ORDER BY CASE scope ${scopes.map((_,i)=>`WHEN ? THEN ${i}`).join(' ')} END LIMIT 1`,[filmId,at,[signal.kind,signal.subject,signal.source,signal.part].join('|'),...scopes,...params(),...scopes]],
   [`INSERT OR IGNORE INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at,plan_epoch) SELECT ?,'film','*',0,'active','check_anchors',?,?,0 WHERE ${G}`,[filmId,at,at,...params()]],
  ];
 }
 const out=[[`UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1,updated_at=?${signal.kind==='anchor_changed'?",status='active',reason='check_anchors'":''} WHERE film_id=? AND part='film' AND source='*' AND ${G}`,[at,filmId,...params()]]];
 const reopen=(where,extra=[])=>[`UPDATE catalog_enrichment_state SET refresh_epoch=refresh_epoch+1,status='due',failures=0,retry_at=NULL,reason=CASE WHEN reason='owner_blocked' THEN NULL ELSE reason END,expected_json=CASE WHEN part='credits' THEN NULL ELSE expected_json END,updated_at=? WHERE film_id=? AND part<>'film' AND status IN ('complete','complete_with_gaps','needs_attention','deferred_repair','identity_disagreement','not_applicable','due') AND ${where} AND ${G}`,[at,filmId,...extra,...params()]];
 if(signal.kind==='anchor_changed')out.push(reopen("status<>'complete'"));
 else if(signal.kind==='protection_released')out.push(reopen('part=?',[signal.part==='metadata'?'core':signal.part]));
 else if(signal.kind==='source_changed'){
  // dropped without a fetch only when the applied source_version equals the digest AND the part is complete for that version
  out.push(reopen("part=? AND (source=? OR ?='') AND NOT (source_version IS ? AND status IN ('complete','complete_with_gaps'))",[signal.part||'core',signal.source,signal.source,signal.digest??null]));
 }
 return out;
}
// The acknowledgement, last, with the SAME full guard.
export function ackStatement({signal,guard}){
 return [`UPDATE enrichment_signal SET acked_version=?,state='consumed',attempts=0,last_error=NULL,retry_at=NULL WHERE kind=? AND subject=? AND source=? AND part=? AND version=? AND acked_version<? AND ${guard.sql}`,[signal.version,signal.kind,signal.subject,signal.source??'',signal.part??'',signal.version,signal.version,...guard.params]];
}
// Consumes one signal. `plan` carries what the planner read: {generation, leaseId, now}. -> {consumed:true} or {consumed:false, reason}. The batch is one transaction; a failed batch changes nothing, records the failure
// with the next retry and never blocks another signal.
export async function consumeSignal(env,{signal,generation,leaseId,now}){
 instant(now);
 const scopes=signal.kind==='admitted'?signalScopes(signal):null;
 if(signal.kind==='admitted'&&!scopes.length)return {consumed:false,reason:'no_scope'};
 const seen=await one(db(env),'SELECT acked_version FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=?',[signal.kind,signal.subject,signal.source??'',signal.part??'']);
 if(seen&&Number(seen.acked_version)>=signal.version)return {consumed:false,reason:'already_consumed'};
 const guard=consumeGuard({signal,generation,leaseId,now,scopes});
 const statements=[...effectStatements({signal,guard,at:now}),ackStatement({signal,guard})];
 try{await batch(env,statements);}
 catch(error){
  await recordFailure(env,{signal,now,error}).catch(()=>{});
  return {consumed:false,reason:'batch_failed'};
 }
 const row=await one(db(env),'SELECT acked_version,version FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=?',[signal.kind,signal.subject,signal.source??'',signal.part??'']);
 return Number(row?.acked_version)>=signal.version?{consumed:true}:{consumed:false,reason:'guarded_out'};
}
// A failed consumption stays pending with attempts, the error class and the next retry (the ADR 0098 tiers: 1, 5, 15 and 60 minutes, then hourly).
const RETRY_MIN=[1,5,15,60];
// The failure is recorded ONLY against the exact version that was observed: a stale failure must not back off a fresher event (the re-arm resets attempts and retry).
export async function recordFailure(env,{signal,now,error}){
 const handle=db(env);
 const row=await one(handle,'SELECT attempts FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=? AND version=?',[signal.kind,signal.subject,signal.source??'',signal.part??'',signal.version]);
 if(!row)return;
 const attempts=Number(row?.attempts??0)+1;
 const retryAt=new Date(Date.parse(now)+RETRY_MIN[Math.min(attempts-1,RETRY_MIN.length-1)]*60000).toISOString();
 const code=String(error?.code||error?.cause?.code||'consume_failed').replace(/[^a-z0-9_]/gi,'_').slice(0,80);
 await handle.prepare('UPDATE enrichment_signal SET attempts=?,last_error=?,retry_at=? WHERE kind=? AND subject=? AND source=? AND part=? AND version=? AND state=\'pending\'').bind(attempts,code,retryAt,signal.kind,signal.subject,signal.source??'',signal.part??'',signal.version).run();
}

// ---- the Monitor fact reader (ADR 0211 decision 5 as amended by ADR 0219) ----
// BOUNDED, READ-ONLY D1 reads that the Monitor judges with `MonitorPolicy.evaluateCatalogEnrichment`: the control, the enabled scopes, the newest run and the run record, the drainer lease, the newest run that committed units,
// the due and runnable Films, the oldest upstream transport streak per source, and the rows that need attention. D1 stays the authority of every fact here: the Monitor keeps no enrichment clock of its own.
// A missing schema or a missing control row is NEUTRAL (`configured: false`), never an error. Nothing is written.
export async function readMonitorFacts(env,{now}){
 const handle=db(env);
 const iso=new Date(now).toISOString();
 const first=(sql,params=[])=>one(handle,sql,params);
 let control;
 try{control=await first('SELECT state,generation FROM catalog_enrichment_control WHERE id=1');}
 catch(error){if(absentTable(error))return {configured:false,reason:'schema_missing'};throw failed('film_person_unavailable',error);}
 if(!control)return {configured:false,reason:'no_control'};
 const [scopes,tick,progress,record,lease,due,transport,attention,repair,delivery]=await Promise.all([
  first('SELECT COUNT(*) AS n FROM catalog_enrichment_scope WHERE enabled=1'),
  first('SELECT tick_id,state,started_at,finished_at FROM catalog_enrichment_tick ORDER BY started_at DESC LIMIT 1'),
  first("SELECT MAX(started_at) AS at FROM catalog_enrichment_tick WHERE COALESCE(json_extract(counts_json,'$.units'),0)>0"),
  first("SELECT summary_json FROM projection_run WHERE projection='catalog_enrichment_run'"),
  first("SELECT lease_until FROM projection_run WHERE projection='catalog_enrichment' AND lease_id IS NOT NULL"),
  first("SELECT COUNT(DISTINCT s.film_id) AS films,MIN(s.due_since) AS oldest FROM catalog_enrichment_state s WHERE s.part<>'film' AND s.status IN ('due','deferred_repair') AND (s.retry_at IS NULL OR s.retry_at<=?) AND s.film_id IN (SELECT m.film_id FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1) AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_state f WHERE f.film_id=s.film_id AND f.part='film' AND f.status='identity_disagreement')",[iso]),
  many(handle,"SELECT source,MIN(pending_since) AS since,COUNT(DISTINCT film_id) AS films FROM catalog_enrichment_state WHERE part<>'film' AND status IN ('due','deferred_repair') AND pending_since IS NOT NULL GROUP BY source"),
  many(handle,"SELECT status,source,COUNT(*) AS n FROM catalog_enrichment_state WHERE status IN ('identity_disagreement','needs_attention') GROUP BY status,source"),
  many(handle,"SELECT source,COUNT(*) AS n,MIN(updated_at) AS oldest FROM catalog_enrichment_state WHERE status='deferred_repair' GROUP BY source"),
  first("SELECT COUNT(*) AS n,MIN(finished_at) AS oldest FROM catalog_enrichment_tick WHERE state IN ('finished','stopped') AND delivered_at IS NULL"),
 ]);
 let run=null;
 try{const parsed=record?.summary_json?JSON.parse(record.summary_json):null;run=parsed&&typeof parsed==='object'?{phase:parsed.phase||null,at:parsed.at||null,wakeAt:parsed.wakeAt||null,instance:parsed.instance||null}:null;}catch{run=null;}
 return {configured:true,control:{state:control.state,generation:Number(control.generation)},enabledScopes:Number(scopes?.n??0),
  lastTick:tick?{state:tick.state,startedAt:tick.started_at,finishedAt:tick.finished_at}:null,progressAt:progress?.at??null,run,leaseUntil:lease?.lease_until??null,
  due:{films:Number(due?.films??0),oldestDueSince:due?.oldest??null},
  transport:Object.fromEntries(transport.map(row=>[row.source,{since:row.since,films:Number(row.films)}])),
  attention:attention.map(row=>({status:row.status,source:row.source,count:Number(row.n)})),
  repair:repair.map(row=>({source:row.source,count:Number(row.n),oldestAt:row.oldest})),
  // shown, never judged (the same rule as the canonical Producer's outcome delivery): undelivered terminal runs
  delivery:{pending:Number(delivery?.n??0),oldestAt:delivery?.oldest??null}};
}

// ---- the run outbox and its delivery to the Events Log (ADR 0211 decision 5 as amended by ADR 0219) ----
// One row of `catalog_enrichment_tick` per run: `started`, then `finished` or `stopped` with its counts. A terminal row is delivered to the user Events Log as ONE event of type `catalog_enrichment`, create-only under a key that
// is a pure function of the run id and its end time (the same key layout as the canonical Producer's outcomes): a put that finds the key counts as delivered, so a retry never duplicates. A failed put moves the row one hour
// back (the attempt counter is the compare-and-swap and the schedule); a row that keeps failing cannot starve the others, nothing is ever deleted and delivery never blocks a run.
export const EVENT_TYPE='catalog_enrichment';
export const DELIVERY_MAX=8;
export const DELIVERY_RETRY_MS=3600000;
const isTime=value=>typeof value==='string'&&value.length>=20&&value.length<=40&&Number.isFinite(Date.parse(value));
const whole=value=>{const n=Number(value);return Number.isInteger(n)&&n>=0?n:null;};
const SOURCES=['letterboxd','tmdb','wikidata'];
export const tickEventKey=event=>'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';
// ADR 0214 decision 13 (AIR-633): the per-field outcome counts of a run, whole numbers only. Counts, never a value, a Film id or a field text.
const PROVENANCE_KEYS=['offered','fills','adoptions','replacements','agreed','source_absent','superseded_kept','same_rank_conflict','agreement_stale','provenance_mismatch','history','owner_actions','upgrades_waiting'];
export function provenanceCounts(value){
 if(!value||typeof value!=='object')return null;
 const out={};
 for(const key of PROVENANCE_KEYS)out[key]=whole(value[key])??0;
 out.refusals={};
 for(const key of ['owner_kept','stored_differs','disagreement','anchor_changed','attributed_kept','hold','language_kept'])out.refusals[key]=whole(value.refusals?.[key])??0;
 return out;
}
// PURE. The event of one terminal outbox row, or null when the row is not deliverable. Counts only: no Film id, title, name or payload.
export function tickEvent(row){
 if(!row||typeof row.tick_id!=='string'||!['finished','stopped'].includes(row.state)||!isTime(row.finished_at))return null;
 let counts=null;
 try{counts=JSON.parse(row.counts_json);}catch{counts=null;}
 if(!counts||typeof counts!=='object')return null;
 const bySource={};
 for(const source of SOURCES){
  const entry=counts.bySource?.[source];
  if(entry&&typeof entry==='object')bySource[source]={requests:whole(entry.requests)??0,transport:whole(entry.transport)??0,failed:whole(entry.failed)??0,cooldownSkips:whole(entry.cooldownSkips)??0};
 }
 const stop=/^[a-z][a-z_0-9]{0,39}$/.test(String(counts.stop||''))?counts.stop:null;
 const startedMs=Date.parse(row.started_at),endedMs=Date.parse(row.finished_at);
 return {id:row.tick_id,type:EVENT_TYPE,at:new Date(endedMs).toISOString(),outcome:row.state,stop,
  startedAt:isTime(row.started_at)?new Date(startedMs).toISOString():null,durationMs:isTime(row.started_at)&&endedMs>=startedMs?endedMs-startedMs:null,
  counts:{films:whole(counts.films),signals:whole(counts.signals),units:whole(counts.units),steps:whole(counts.steps),statements:whole(counts.statements),failedStatements:whole(counts.failedStatements),
   committedLive:whole(counts.committedLive),committedBackground:whole(counts.committedBackground),yields:whole(counts.yields),deferred:whole(counts.deferred),errors:whole(counts.errors),disagreements:whole(counts.disagreements)},
  ...(provenanceCounts(counts.provenance)?{provenance:provenanceCounts(counts.provenance)}:{}),
  bySource};
}
async function putTickEvent(env,event){
 for(let attempt=0;attempt<2;attempt++){
  try{await env.BUCKET.put(tickEventKey(event),JSON.stringify(event),{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});return true;}
  catch(error){
   // R2 reports an existing key on a create-only put as a failed precondition: the event is already there, which is delivery
   if(/precondition|412|already exists/i.test(String(error?.message||error)))return true;
  }
 }
 return false;
}
// -> {taken, delivered, failed, conflicts}. Only the delivery of terminal rows; a `started` row is never delivered.
export async function deliverTicks(env,{nowMs=Date.now(),limit=DELIVERY_MAX}={}){
 const stats={taken:0,delivered:0,failed:0,conflicts:0};
 if(typeof env?.BUCKET?.put!=='function')return {...stats,skipped:'bucket_unavailable'};
 const handle=db(env);
 const now=new Date(nowMs).toISOString(),cap=Math.max(1,Math.min(DELIVERY_MAX,Number(limit)||DELIVERY_MAX));
 let rows;
 try{rows=await many(handle,"SELECT tick_id,started_at,finished_at,state,counts_json,delivery_attempts FROM catalog_enrichment_tick WHERE state IN ('finished','stopped') AND delivered_at IS NULL ORDER BY finished_at LIMIT ?",[cap*4]);}
 catch(error){if(absentTable(error))return {...stats,skipped:'schema_missing'};throw failed('film_person_unavailable',error);}
 // the retry schedule is the attempt counter: a row is due one hour after its end for each failed attempt
 const due=rows.filter(row=>isTime(row.finished_at)&&Date.parse(row.finished_at)+Number(row.delivery_attempts||0)*DELIVERY_RETRY_MS<=nowMs).slice(0,cap);
 for(const row of due){
  stats.taken++;
  const event=tickEvent(row);
  const ok=event?await putTickEvent(env,event):false;
  const statement=ok
   ?["UPDATE catalog_enrichment_tick SET delivered_at=?,delivery_attempts=delivery_attempts+1 WHERE tick_id=? AND delivered_at IS NULL AND delivery_attempts=? RETURNING tick_id",[now,row.tick_id,row.delivery_attempts]]
   :["UPDATE catalog_enrichment_tick SET delivery_attempts=delivery_attempts+1 WHERE tick_id=? AND delivered_at IS NULL AND delivery_attempts=? RETURNING tick_id",[row.tick_id,row.delivery_attempts]];
  let moved=false;
  try{moved=!!await handle.prepare(statement[0]).bind(...statement[1]).first();}catch{moved=false;}
  if(ok)stats.delivered++;else stats.failed++;
  if(!moved)stats.conflicts++;
 }
 return stats;
}
