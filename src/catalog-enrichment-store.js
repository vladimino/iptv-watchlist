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
export const SOURCE_SCOPES=Object.freeze({rated:['rated','c3a'],watchlist:['c3b'],discovery:['discovery'],letterboxd:[]});
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

// ---- runnable signals ----
// A signal is runnable when it is pending, its scope is enabled (an `admitted` signal) or some enabled membership of its Film exists (the others), it is RESOLVED (its Film exists) and its retry is due. Held (disabled
// scope), unresolved and backed-off signals are not runnable, so they cannot keep a run spinning or cancel a park. -> [{kind, subject, source, part, version, filmId}]
export async function runnableSignals(env,{now,limit=50}){
 instant(now);
 const handle=db(env);
 const admitted=(await many(handle,`SELECT s.kind,s.subject,s.source,s.part,s.version,s.cause_digest AS digest,e.film_id AS film_id FROM enrichment_signal s JOIN film_external_id e ON e.scheme='tmdb' AND e.value=substr(s.subject,6) AND e.trusted=1 AND e.conflicting=0 WHERE s.kind='admitted' AND s.state='pending' AND s.acked_version<s.version AND s.subject LIKE 'tmdb:%' AND (s.retry_at IS NULL OR s.retry_at<=?) AND EXISTS (SELECT 1 FROM catalog_enrichment_scope c WHERE c.enabled=1 AND c.scope IN (SELECT value FROM json_each(?))) ORDER BY s.armed_at LIMIT ?`,[now,JSON.stringify(SCOPES),limit])).filter(row=>(SOURCE_SCOPES[row.source]||[]).length);
 const others=await many(handle,`SELECT s.kind,s.subject,s.source,s.part,s.version,s.cause_digest AS digest,s.subject AS film_id FROM enrichment_signal s WHERE s.kind<>'admitted' AND s.state='pending' AND s.acked_version<s.version AND (s.retry_at IS NULL OR s.retry_at<=?) AND EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1 WHERE m.film_id=s.subject) ORDER BY s.armed_at LIMIT ?`,[now,limit]);
 const own=[];
 for(const row of admitted){
  const scopes=SOURCE_SCOPES[row.source];
  const enabled=await one(handle,`SELECT 1 AS x FROM catalog_enrichment_scope WHERE enabled=1 AND scope IN (${marks(scopes)})`,scopes);
  if(enabled)own.push(row);
 }
 return [...own,...others].map(row=>({kind:row.kind,subject:row.subject,source:row.source,part:row.part,version:Number(row.version),digest:row.digest??null,filmId:row.film_id}));
}

// ---- guarded consumption ----
// ONE condition, repeated verbatim in every effect and in the acknowledgement. `scopes`: the scopes whose enabled flag justifies the effect (admitted: the source's scopes); for the other kinds `filmId` selects "at least
// one enabled membership of the Film" instead.
export function consumeGuard({signal,generation,leaseId,now,scopes=null}){
 const lease=leaseGuard(leaseId,now),control=controlGuard(generation);
 const justification=scopes?{sql:`EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE enabled=1 AND scope IN (${marks(scopes)}))`,params:[...scopes]}:{sql:'EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1 WHERE m.film_id=?)',params:[signal.filmId||signal.subject]};
 const sql=`(EXISTS (SELECT 1 FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=? AND state='pending' AND version=? AND acked_version<?) AND ${control.sql} AND ${lease.sql} AND ${justification.sql})`;
 return {sql,params:[signal.kind,signal.subject,signal.source??'',signal.part??'',signal.version,signal.version,...control.params,...lease.params,...justification.params]};
}
// The effect statements of one signal kind, each `WHERE <guard>`; the acknowledgement is appended last by `consumeSignal`.
// admitted: the retained membership and the Film's state row. The other kinds reopen work: the Film's `plan_epoch` and, once, the `refresh_epoch` of the affected rows (every row for an anchor change, the part for a protection
// release, the part and source for a verified source change whose digest is not the one the part applied); an `identity_disagreement` is lifted by an anchor change.
export function effectStatements({signal,guard,at}){
 const G=guard.sql,params=()=>[...guard.params];
 const filmId=signal.filmId||signal.subject;
 if(signal.kind==='admitted'){
  const scopes=SOURCE_SCOPES[signal.source]||[];
  return [
   [`INSERT OR IGNORE INTO catalog_enrichment_member (film_id,scope,admitted_at,signal_key) SELECT ?,scope,?,? FROM catalog_enrichment_scope WHERE enabled=1 AND scope IN (${marks(scopes)}) AND ${G} ORDER BY CASE scope ${scopes.map((_,i)=>`WHEN ? THEN ${i}`).join(' ')} END LIMIT 1`,[filmId,at,[signal.kind,signal.subject,signal.source,signal.part].join('|'),...scopes,...params(),...scopes]],
   [`INSERT OR IGNORE INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at,plan_epoch) SELECT ?,'film','*',0,'active','check_anchors',?,?,0 WHERE ${G}`,[filmId,at,at,...params()]],
  ];
 }
 const out=[[`UPDATE catalog_enrichment_state SET plan_epoch=plan_epoch+1,updated_at=?${signal.kind==='anchor_changed'?",status='active',reason='check_anchors'":''} WHERE film_id=? AND part='film' AND source='*' AND ${G}`,[at,filmId,...params()]]];
 const reopen=(where,extra=[])=>[`UPDATE catalog_enrichment_state SET refresh_epoch=refresh_epoch+1,status='due',failures=0,retry_at=NULL,expected_json=CASE WHEN part='credits' THEN NULL ELSE expected_json END,updated_at=? WHERE film_id=? AND part<>'film' AND status IN ('complete','complete_with_gaps','needs_attention','deferred_repair','identity_disagreement','not_applicable','due') AND ${where} AND ${G}`,[at,filmId,...extra,...params()]];
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
 const scopes=signal.kind==='admitted'?(SOURCE_SCOPES[signal.source]||[]):null;
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
export async function recordFailure(env,{signal,now,error}){
 const handle=db(env);
 const row=await one(handle,'SELECT attempts FROM enrichment_signal WHERE kind=? AND subject=? AND source=? AND part=?',[signal.kind,signal.subject,signal.source??'',signal.part??'']);
 const attempts=Number(row?.attempts??0)+1;
 const retryAt=new Date(Date.parse(now)+RETRY_MIN[Math.min(attempts-1,RETRY_MIN.length-1)]*60000).toISOString();
 const code=String(error?.code||error?.cause?.code||'consume_failed').replace(/[^a-z0-9_]/gi,'_').slice(0,80);
 await handle.prepare('UPDATE enrichment_signal SET attempts=?,last_error=?,retry_at=? WHERE kind=? AND subject=? AND source=? AND part=? AND state=\'pending\'').bind(attempts,code,retryAt,signal.kind,signal.subject,signal.source??'',signal.part??'').run();
}
