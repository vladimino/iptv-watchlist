// AIR-607 (card C2; ADR 0219 decisions 2, 3 and 6; ADR 0207 decision 7): the OPERATOR contract that activates the Catalog Enrichment Producer for the RATED scope only. DORMANT: nothing in the Worker imports it and a deploy
// never runs it. It is executed by the owner's production operation under an exact owner GO that names the cutoff; it is not reachable from any route, flag or Scheduled Task, and it starts no production instance of its own.
//   - FAIL CLOSED: `ratedActivationPreflight` is read-only. It refuses on an incomplete producer schema, a Film/Person authority that is not actually `open` (a held marker is refused), a live drainer lease, a control row that is
//     not `inactive`, any scope row other than `rated`, and a `staged` signal. A malformed input (impossible calendar instant, a cutoff in the future, a missing GO link, a combined actor longer than the column) refuses before the database is read.
//   - THE APPROVED ENVELOPE (cutoff, scope revision, authority generation, no other scope, no staged signal, no live lease, control revision) is read once and asserted INSIDE every write that makes the activation true: the scope insert,
//     every bootstrap page (`pin` for the scope, `extra` for the readiness) and the control compare-and-swap, which also carries the done bootstrap and the scope identity. A change at any boundary applies nothing and is reported,
//     never adopted: a scope that is not exactly what this call inserted is not attributed to it, and an inconsistent ACTIVE configuration is refused without any write (no recovery path).
//   - ORDER (no gap, ADR 0219 decision 3): (1) scope row (live trigger on); (2) bootstrap of the qualifying existing admissions; (3) control `inactive` -> `active`; (4) the wake of the already-runnable work (below); (5) readback.
//   - OUTCOMES are never rounded up: `refused` (nothing written by this call), `stopped` (scope and/or bootstrap effects exist, the control is still `inactive`; the same call resumes), `uncertain` (the control commit's outcome could
//     not be read back), `activated` (the control is active under this operator's own write), `noop` (already active, same rated-only configuration, bootstrap done).
//   - WAKE: signals written while the control was inactive are not woken by any later writer, and `kick` refuses an inactive control. Only after the final commit is confirmed the operator wakes the drainer through the EXISTING
//     protocol (`hasRunnable`, then `kick`; the producer's own reconcile is the safety net, delivered with the reconcile cron under the GO). It never starts an instance outside that protocol, never throws, and a failed or deferred
//     wake leaves the activation applied. A repeated call is a `noop` and wakes again, so a lost reply or a lost kick is recovered by repeating the same call or by the reconcile.
// It enables no other scope, sets no feature flag, creates no Scheduled Task and delivers no cron expression. Pause is the stop control (`POST /api/admin/settings/catalog-enrichment`), never a code rollback.
import {failed,many,one,database,readAuthority} from './film-person-authority.js';
import {readControl,LEASE_PROJECTION} from './catalog-enrichment-store.js';
import {runBootstrap,readScope,BOOTSTRAP_MAX_PAGES,BOOTSTRAP_PAGE} from './catalog-enrichment-bootstrap.js';
import {hasRunnable,kick} from './catalog-enrichment-workflow.js';

export const ACTIVATION_SCOPE='rated';
export const MIN_SCHEMA_VERSION=47;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GO_REFERENCE=/^https:\/\/[^\s]{8,300}$/;
// The whole relevant schema: the producer's own tables (0047), the operation-key contract (0039), the shared upstream coordination (0045), the lease row and the rated emitter.
const TABLES=['enrichment_signal','catalog_enrichment_scope','catalog_enrichment_member','catalog_enrichment_state','catalog_enrichment_control','catalog_enrichment_unit_generation','catalog_enrichment_tick','film_rated_admission','upstream_cooldown','upstream_coordination','projection_run','canonical_write_receipt'];
const TRIGGER='catalog_enrichment_rated_admitted';
const absent=error=>/no such (table|column)/i.test(String(error?.cause?.message||error?.message||error));
const instant=value=>typeof value==='string'&&ISO.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString()===value; // rejects impossible calendar instants (month 99, day 31 of April) that the pattern alone accepts

// What the control row records as `updated_by` (the column holds at most 200 characters): the operator and the exact GO. It is never truncated: a combination that does not fit is refused.
const ACTOR_LIMIT=200;
const actor=(by,goReference)=>`${by} go:${goReference}`;
// The validity of a cutoff at a time. Exported so the operator's read-only status judges an exact cutoff by the same rule as the activation (a future cutoff is never ready).
export function cutoffProblems(cutoffAt,at){
 const problems=[];
 if(!instant(at))problems.push('invalid_time');
 if(!instant(cutoffAt))problems.push('invalid_cutoff');
 else if(instant(at)&&Date.parse(cutoffAt)>Date.parse(at))problems.push('cutoff_in_future');
 return problems;
}
// The ONE predicate of an applied activation, used by `activateRated` for its noop and by the operator's status for `already_active`: exactly the rated scope, enabled, with the requested cutoff and a done bootstrap.
// `cutoffAt` null skips the cutoff comparison (an inspection without a requested cutoff). -> the reasons it does NOT match; an empty list is a match. Rows from the table or from a scope view are both read.
export function activeConfigurationReasons(scopes,cutoffAt=null){
 const reasons=[];
 const rated=scopes.filter(row=>row.scope===ACTIVATION_SCOPE);
 if(scopes.length!==rated.length)reasons.push('other_scope_present');
 const own=rated[0];
 if(!own){reasons.push('scope_missing');return reasons;}
 if(cutoffAt!==null&&(own.cutoff_at??own.cutoffAt??null)!==cutoffAt)reasons.push('scope_cutoff_mismatch');
 if(Number(own.activated)!==1||Number(own.enabled)!==1)reasons.push('scope_not_enabled');
 if((own.bootstrap_state??own.bootstrapState)!=='done')reasons.push('bootstrap_not_done');
 return reasons;
}
function validInput({cutoffAt,by,at,goReference}){
 const problems=cutoffProblems(cutoffAt,at);
 if(typeof goReference!=='string'||!GO_REFERENCE.test(goReference))problems.push('go_reference_missing');
 if(typeof by!=='string'||!by||by.length>120)problems.push('invalid_operator');
 else if(typeof goReference==='string'&&GO_REFERENCE.test(goReference)&&actor(by,goReference).length>ACTOR_LIMIT)problems.push('actor_too_long');
 return problems;
}

// ---- the guards asserted inside the writes ----
// authority open at the generation read; no staged signal; no live drainer lease; exactly `scopes` scope rows. Parameters, in order: generation, at.
const guard=scopes=>`EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?) AND NOT EXISTS (SELECT 1 FROM enrichment_signal WHERE state='staged') AND NOT EXISTS (SELECT 1 FROM projection_run WHERE projection='${LEASE_PROJECTION}' AND lease_id IS NOT NULL AND lease_until>?) AND (SELECT COUNT(*) FROM catalog_enrichment_scope)=${scopes}`;
// the approved scope identity at the final commit. Parameters: cutoff, revision.
const SCOPE_DONE="EXISTS (SELECT 1 FROM catalog_enrichment_scope WHERE scope='rated' AND activated=1 AND enabled=1 AND cutoff_at=? AND revision=? AND bootstrap_state='done')";
const INSERT_SCOPE=`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision,updated_at) SELECT 'rated',1,1,?,'none',NULL,1,? WHERE ${guard(0)} AND COALESCE((SELECT revision FROM catalog_enrichment_control WHERE id=1),0)=? AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_control WHERE state<>'inactive')`;
const INIT_CONTROL=`INSERT INTO catalog_enrichment_control (id,state,generation,revision,updated_at,updated_by) SELECT 1,'inactive',0,1,?,? WHERE NOT EXISTS (SELECT 1 FROM catalog_enrichment_control) AND ${guard(1)} AND ${SCOPE_DONE}`;
const ACTIVATE_CONTROL=`UPDATE catalog_enrichment_control SET state='active',generation=generation+1,revision=revision+1,updated_at=?,updated_by=? WHERE id=1 AND state='inactive' AND revision=? AND ${guard(1)} AND ${SCOPE_DONE}`;

const scopeView=row=>({scope:row.scope,activated:Number(row.activated),enabled:Number(row.enabled),cutoffAt:row.cutoff_at,bootstrapState:row.bootstrap_state,revision:Number(row.revision)});
const SCOPE_SQL='SELECT scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision,updated_at FROM catalog_enrichment_scope ORDER BY scope';

// READ-ONLY. -> {ok, problems:[code,...], facts}. `facts.resume` is true when the rated scope already exists with the SAME cutoff, enabled, and the control is still `inactive` (an interrupted activation): continued, not a problem.
// `now` (an instant) is the time the lease is judged at.
export async function ratedActivationPreflight(env,{cutoffAt=null,now=new Date().toISOString()}={}){
 const handle=database(env);
 if(!handle)throw failed('film_person_unavailable');
 const problems=[],facts={resume:false};
 try{
  const version=(await one(handle,'SELECT version FROM schema_contract WHERE id=1'))?.version;
  facts.schemaVersion=version==null?null:Number(version);
  const present=new Set((await many(handle,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(()=>'?').join(',')+")",TABLES)).map(row=>row.name));
  const trigger=await one(handle,"SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",[TRIGGER]);
  const keyed=present.has('canonical_write_receipt')?await one(handle,"SELECT name FROM pragma_table_info('canonical_write_receipt') WHERE name='operation_key'"):null;
  facts.missingTables=TABLES.filter(name=>!present.has(name));
  facts.ratedTrigger=!!trigger;
  facts.operationKey=!!keyed;
  if(!(facts.schemaVersion>=MIN_SCHEMA_VERSION)||facts.missingTables.length||!trigger||!keyed){problems.push('schema_not_applied');return {ok:false,problems,facts};}
  try{
   const gate=await readAuthority(env);
   facts.filmPersonMarker={state:gate.state,generation:gate.generation};
   if(gate.open!==true||gate.state!=='open')problems.push('film_person_marker_not_open');
  }catch{facts.filmPersonMarker={state:'unreadable',generation:null};problems.push('film_person_marker_not_open');}
  const lease=await one(handle,'SELECT lease_id,lease_until FROM projection_run WHERE projection=?',[LEASE_PROJECTION]);
  facts.lease=lease?.lease_id&&lease.lease_until&&lease.lease_until>now?{until:lease.lease_until}:null;
  if(facts.lease)problems.push('lease_held');
  const control=await readControl(env);
  facts.control={state:control.state,present:control.present,generation:control.generation,revision:control.revision};
  const scopes=await many(handle,SCOPE_SQL);
  facts.scopes=scopes.map(scopeView);
  const own=scopes.find(row=>row.scope===ACTIVATION_SCOPE);
  if(scopes.some(row=>row.scope!==ACTIVATION_SCOPE))problems.push('other_scope_present');
  if(control.state!=='inactive')problems.push('control_not_inactive');
  else if(own){
   if(cutoffAt&&own.cutoff_at===cutoffAt&&Number(own.activated)===1&&Number(own.enabled)===1)facts.resume=true;
   else problems.push(cutoffAt&&own.cutoff_at!==cutoffAt?'scope_cutoff_mismatch':'scope_already_present');
  }
  const staged=await one(handle,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='staged'");
  facts.stagedSignals=Number(staged?.n||0);
  if(facts.stagedSignals>0)problems.push('stale_staged_signals');
 }catch(error){
  if(absent(error)){problems.push('schema_not_applied');return {ok:false,problems,facts};}
  throw failed('film_person_unavailable',error);
 }
 return {ok:problems.length===0,problems,facts};
}

// The wake of already-runnable work, after the control is active. Never throws. -> {outcome:'kicked'|'nothing_runnable'|'not_kicked'|'failed'|'deferred', ...}
async function wake(env,{kick:inject=null}){
 const send=inject||(env?.CATALOG_ENRICHMENT_WORKFLOW?()=>kick(env):null);
 if(!send)return {outcome:'deferred',reason:'no_workflow_binding'}; // the safety net (the reconcile cron, delivered under the GO) wakes it
 try{
  if(!inject&&!await hasRunnable(env,{now:new Date().toISOString()}))return {outcome:'nothing_runnable'};
  const result=await send();
  return result?.kicked?{outcome:'kicked',mode:result.mode??null}:{outcome:'not_kicked',reason:result?.reason??'unknown'};
 }catch(error){return {outcome:'failed',reason:String(error?.message||error).slice(0,200)};}
}

async function finish(env,{outcome,effects,deps,extra={}}){
 return {outcome,effects,wake:await wake(env,deps),...extra,...(await readActivation(env))};
}

// -> {outcome, effects:{scopeInserted,bootstrapRows}, problems?, reason?, bootstrap?, wake?, ...readback}
//   refused    a precondition or the guard of the first write failed; nothing was written by this call.
//   stopped    the scope exists but the control is still inactive (bootstrap incomplete, configuration changed, or the control guard failed). Nothing is adopted; repeat the same call to resume.
//   uncertain  the control commit was sent and its outcome could not be read back: read the state before acting again.
//   activated  the control is active under this operator's own write; the wake of the runnable work was attempted and is reported.
//   noop       the control is already active under the same rated-only configuration with a done bootstrap; the wake is attempted again.
// `deps.kick` replaces the default wake (the Worker's `kick` when a workflow binding exists); a test injects it.
export async function activateRated(env,{cutoffAt,by,at,goReference,maxPages=BOOTSTRAP_MAX_PAGES,pageSize=BOOTSTRAP_PAGE}={},deps={}){
 const effects={scopeInserted:false,bootstrapRows:0};
 const input=validInput({cutoffAt,by,at,goReference});
 if(input.length)return {outcome:'refused',effects,problems:input};
 const handle=database(env);
 const before=await readControl(env);
 if(before.tables===false)return {outcome:'refused',effects,problems:['schema_not_applied']};

 // an applied activation: only the same enabled, rated-only configuration with a done bootstrap is a noop (and wakes again). Anything else that is active is an inconsistent configuration that needs investigation: this operator
 // writes nothing under it (no recovery, no bootstrap), whatever the authority or schema say.
 if(before.state==='active'){
  const scopes=await many(handle,SCOPE_SQL);
  const reasons=activeConfigurationReasons(scopes,cutoffAt);
  if(reasons.length)return {outcome:'refused',effects,problems:['active_configuration_mismatch'],reasons,scopes:scopes.map(scopeView)};
  return finish(env,{outcome:'noop',effects,deps,extra:{reason:'already_active'}});
 }

 const preflight=await ratedActivationPreflight(env,{cutoffAt,now:at});
 if(!preflight.ok)return {outcome:'refused',effects,problems:preflight.problems,facts:preflight.facts};
 // the APPROVED envelope, read once here and never replaced by a later read: the authority generation, the control revision/generation (`before`) and the scope revision
 const generation=preflight.facts.filmPersonMarker.generation;
 const approvedRevision=preflight.facts.resume?preflight.facts.scopes.find(row=>row.scope===ACTIVATION_SCOPE).revision:1;
 const notes={};
 if(!preflight.facts.resume){
  // the first write: guarded by authority open at the generation read, no staged signal, no live lease, no scope row and the control revision read. Its own result is judged from a readback, never assumed.
  let sendError=null;
  try{await handle.batch([handle.prepare(INSERT_SCOPE).bind(cutoffAt,at,generation,at,before.revision)]);}catch(error){sendError=error;}
  let scopes;
  try{scopes=await many(handle,SCOPE_SQL);}catch{return {outcome:'uncertain',effects:{...effects,scopeInserted:'unknown'},reason:'scope_outcome_unknown'};}
  const row=scopes.find(item=>item.scope===ACTIVATION_SCOPE);
  if(!row){
   if(sendError)throw failed('film_person_unavailable',sendError);
   return {outcome:'refused',effects,problems:['scope_not_written'],...(await readActivation(env))};
  }
  // exactly what this invocation inserted: revision 1, untouched bootstrap, its own timestamp, and nothing else in the table. Any other matching row is another writer's (or a changed one) and is neither adopted nor attributed to this call.
  const ours=scopes.length===1&&Number(row.revision)===1&&Number(row.activated)===1&&Number(row.enabled)===1&&row.cutoff_at===cutoffAt&&row.bootstrap_state==='none'&&row.bootstrap_cursor==null&&row.updated_at===at;
  if(!ours)return {outcome:'stopped',effects:{...effects,scopeInserted:'unknown'},reason:'scope_changed_after_insert',...(await readActivation(env))};
  effects.scopeInserted=true;
  if(sendError)notes.scopeNote='scope_insert_reply_lost';
 }else{
  const row=await readScope(env,ACTIVATION_SCOPE);
  if(!row||Number(row.revision)!==approvedRevision||row.cutoff_at!==cutoffAt||Number(row.activated)!==1||Number(row.enabled)!==1)return {outcome:'stopped',effects,reason:'configuration_changed',...(await readActivation(env))};
 }
 const pin={revision:approvedRevision,cutoffAt};

 // every page asserts the scope pin AND the readiness (authority open at the generation, no staged signal, no live lease, exactly one scope) inside its own writes: a held marker between pages stops the operator's writes
 const bootstrap=await runBootstrap(env,{scope:ACTIVATION_SCOPE,at,pageSize,maxPages,pin,extra:{sql:guard(1),params:[generation,at]}});
 effects.bootstrapRows=bootstrap.rows;
 if(bootstrap.outcome!=='done')return {outcome:'stopped',effects,reason:bootstrap.reason||'bootstrap_incomplete',bootstrap,...(await readActivation(env))};

 // the final commit: the control, under the SAME approved envelope (scope identity and revision, done bootstrap, no other scope, authority, staged, lease, and the control revision read at the start), initialized in the same batch when absent
 const base=before.present?before.revision:1;
 const by200=actor(by,goReference);
 const statements=[];
 if(!before.present)statements.push(handle.prepare(INIT_CONTROL).bind(at,by200,generation,at,cutoffAt,approvedRevision));
 statements.push(handle.prepare(ACTIVATE_CONTROL).bind(at,by200,base,generation,at,cutoffAt,approvedRevision));
 const applied=after=>after&&after.state==='active'&&after.updatedBy===by200&&after.generation>before.generation&&after.revision===base+1;
 let after=null,sendFailed=null;
 try{await handle.batch(statements);}catch(error){sendFailed=error;}
 try{after=await readControl(env);}catch{
  return {outcome:'uncertain',effects,reason:'control_outcome_unknown',bootstrap,...(sendFailed?{error:String(sendFailed?.message||sendFailed).slice(0,200)}:{})};
 }
 if(applied(after))return finish(env,{outcome:'activated',effects,deps,extra:{bootstrap,...notes,...(sendFailed?{note:'commit_reply_lost'}:{})}});
 return {outcome:'stopped',effects,reason:sendFailed?'control_batch_failed':'control_guard_failed',bootstrap,...(await readActivation(env))};
}

// READ-ONLY readback of the whole activation: the control, the scope rows and the inbox. A claim about the present state is made from this read, never from documentation.
export async function readActivation(env){
 const handle=database(env);
 const control=await readControl(env);
 const scopes=await many(handle,SCOPE_SQL);
 const signals=await many(handle,"SELECT source,state,COUNT(*) AS n FROM enrichment_signal GROUP BY source,state ORDER BY source,state");
 const expected=scopes.find(row=>row.scope===ACTIVATION_SCOPE);
 const qualifying=expected?.cutoff_at?Number((await one(handle,'SELECT COUNT(*) AS n FROM film_rated_admission WHERE verified_at>=?',[expected.cutoff_at]))?.n||0):null;
 const bootstrapped=expected?Number((await one(handle,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='admitted' AND source='rated' AND part=''"))?.n||0):null;
 return {
  control:{state:control.state,generation:control.generation,revision:control.revision,updatedBy:control.updatedBy},
  scopes:scopes.map(scopeView),
  signals:signals.map(row=>({source:row.source,state:row.state,count:Number(row.n)})),
  qualifyingAdmissions:qualifying,
  ratedSignals:bootstrapped,
  onlyRatedScope:scopes.length===1&&!!expected
 };
}
