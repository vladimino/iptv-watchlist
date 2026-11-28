// AIR-607 (card C2; ADR 0219 decisions 2, 3 and 6; ADR 0207 decision 7): the OPERATOR contract that activates the Catalog Enrichment Producer for the RATED scope only. DORMANT: nothing in the Worker imports it and a deploy
// never runs it. It is executed by the owner's production operation under an exact owner GO that names the cutoff; it is not reachable from any route, flag or Scheduled Task.
//   - FAIL CLOSED: `ratedActivationPreflight` is read-only and refuses on a missing schema, a Film/Person marker that is not open, a control row that is not `inactive`, any existing scope row (no other scope, and no second
//     activation), or a stale `staged` signal. An invalid cutoff, a cutoff in the future, a missing GO reference or an invalid operator identity refuse before any read of the database.
//   - ORDER (no gap, ADR 0219 decision 3): (1) ONE guarded statement inserts the rated scope row `activated=1, enabled=1` with the approved cutoff, so the live trigger is enabled first; (2) the bounded, revision-fenced bootstrap
//     writes `admitted` signals for the qualifying existing admissions (the unique inbox key deduplicates the overlap with the live tail); (3) only when the bootstrap is `done` the control goes `inactive` -> `active`.
//   - RESUMABLE and IDEMPOTENT: a stopped run (the page budget, a crash) is resumed by repeating the same call with the same cutoff; a different cutoff, or a control that is already active, never changes anything.
//   - It enables no other scope, sets no feature flag, creates no Scheduled Task and delivers no cron expression (that is a separate versioned configuration change).
// Pause is the stop control (`POST /api/admin/settings/catalog-enrichment`), never a code rollback.
import {failed,many,one,database,readAuthority} from './film-person-authority.js';
import {activateControl,readControl} from './catalog-enrichment-store.js';
import {runBootstrap,readScope,BOOTSTRAP_MAX_PAGES,BOOTSTRAP_PAGE} from './catalog-enrichment-bootstrap.js';

export const ACTIVATION_SCOPE='rated';
export const MIN_SCHEMA_VERSION=47;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const GO_REFERENCE=/^https:\/\/[^\s]{8,300}$/;
const TABLES=['enrichment_signal','catalog_enrichment_scope','catalog_enrichment_member','catalog_enrichment_state','catalog_enrichment_control','film_rated_admission'];
const TRIGGER='catalog_enrichment_rated_admitted';
const absent=error=>/no such (table|column)/i.test(String(error?.cause?.message||error?.message||error));

function validInput({cutoffAt,by,at,goReference}){
 const problems=[];
 if(typeof at!=='string'||!ISO.test(at))problems.push('invalid_time');
 if(typeof cutoffAt!=='string'||!ISO.test(cutoffAt))problems.push('invalid_cutoff');
 else if(typeof at==='string'&&ISO.test(at)&&Date.parse(cutoffAt)>Date.parse(at))problems.push('cutoff_in_future');
 if(typeof goReference!=='string'||!GO_REFERENCE.test(goReference))problems.push('go_reference_missing');
 if(typeof by!=='string'||!by||by.length>120)problems.push('invalid_operator');
 return problems;
}
// What the control row records as `updated_by` (at most 200 characters): who ran the operation and the exact GO it ran under.
const actor=(by,goReference)=>`${by} go:${goReference}`.slice(0,200);

// READ-ONLY. -> {ok, problems:[code,...], facts}. `resume` is true when the rated scope already exists with the SAME cutoff and the control is still `inactive` (an interrupted activation): that is not a problem, it is continued.
export async function ratedActivationPreflight(env,{cutoffAt=null}={}){
 const handle=database(env);
 if(!handle)throw failed('film_person_unavailable');
 const problems=[],facts={resume:false};
 try{
  const version=(await one(handle,'SELECT version FROM schema_contract WHERE id=1'))?.version;
  facts.schemaVersion=version==null?null:Number(version);
  const present=new Set((await many(handle,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ("+TABLES.map(()=>'?').join(',')+")",TABLES)).map(row=>row.name));
  const trigger=await one(handle,"SELECT name FROM sqlite_master WHERE type='trigger' AND name=?",[TRIGGER]);
  facts.tables=TABLES.filter(name=>present.has(name));
  facts.ratedTrigger=!!trigger;
  if(!(facts.schemaVersion>=MIN_SCHEMA_VERSION)||present.size!==TABLES.length||!trigger){problems.push('schema_not_applied');return {ok:false,problems,facts};}
  try{await readAuthority(env);facts.filmPersonMarker='open';}catch{facts.filmPersonMarker='not_open';problems.push('film_person_marker_not_open');}
  const control=await readControl(env);
  facts.control={state:control.state,present:control.present,generation:control.generation,revision:control.revision};
  const scopes=await many(handle,'SELECT scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision FROM catalog_enrichment_scope ORDER BY scope');
  facts.scopes=scopes.map(row=>({scope:row.scope,activated:Number(row.activated),enabled:Number(row.enabled),cutoffAt:row.cutoff_at,bootstrapState:row.bootstrap_state,revision:Number(row.revision)}));
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

// The step-1 statement: inserts the rated scope only while the control is not active and NO scope row exists (the unique scope key already refuses a second rated row; this refuses any other row too).
const INSERT_SCOPE="INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision,updated_at) SELECT 'rated',1,1,?,'none',NULL,1,? WHERE NOT EXISTS (SELECT 1 FROM catalog_enrichment_scope) AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_control WHERE state<>'inactive')";

// -> {outcome:'activated'|'stopped'|'refused'|'noop', problems?, reason?, bootstrap?, scope?, control?, signals?}
//   refused  a precondition failed; nothing was written by this call.
//   stopped  the scope exists (and its trigger is live) but the bootstrap did not finish; the control is still inactive. Repeat the same call to resume.
//   noop     the control is already active under this same scope and cutoff with a finished bootstrap: nothing to do.
export async function activateRated(env,{cutoffAt,by,at,goReference,maxPages=BOOTSTRAP_MAX_PAGES,pageSize=BOOTSTRAP_PAGE}={}){
 const input=validInput({cutoffAt,by,at,goReference});
 if(input.length)return {outcome:'refused',problems:input};
 const before=await readControl(env);
 if(before.tables===false)return {outcome:'refused',problems:['schema_not_applied']};
 if(before.state==='active'){
  const scope=await readScope(env,ACTIVATION_SCOPE);
  if(scope&&scope.cutoff_at===cutoffAt&&scope.bootstrap_state==='done')return {outcome:'noop',reason:'already_active',control:before,scope};
 }
 const preflight=await ratedActivationPreflight(env,{cutoffAt});
 if(!preflight.ok)return {outcome:'refused',problems:preflight.problems,facts:preflight.facts};
 const handle=database(env);
 if(!preflight.facts.resume){
  try{await handle.batch([handle.prepare(INSERT_SCOPE).bind(cutoffAt,at)]);}catch(error){throw failed('film_person_unavailable',error);}
 }
 const scope=await readScope(env,ACTIVATION_SCOPE);
 if(!scope||scope.cutoff_at!==cutoffAt||Number(scope.activated)!==1||Number(scope.enabled)!==1)return {outcome:'refused',problems:['scope_not_written'],scope};
 const bootstrap=await runBootstrap(env,{scope:ACTIVATION_SCOPE,at,pageSize,maxPages});
 if(bootstrap.outcome!=='done')return {outcome:'stopped',reason:bootstrap.reason||'bootstrap_incomplete',bootstrap,scope:await readScope(env,ACTIVATION_SCOPE)};
 const control=await readControl(env);
 const change=await activateControl(env,{expectedRevision:control.revision,by:actor(by,goReference),at});
 if(change.outcome!=='applied')return {outcome:'stopped',reason:change.outcome==='uncertain'?'control_outcome_unknown':'control_not_activated',bootstrap,control:change.control};
 return {outcome:'activated',bootstrap,...(await readActivation(env))};
}

// READ-ONLY readback of the whole activation: the control, the scope rows and the inbox. A claim about the present state is made from this read, never from documentation.
export async function readActivation(env){
 const handle=database(env);
 const control=await readControl(env);
 const scopes=await many(handle,'SELECT scope,activated,enabled,cutoff_at,bootstrap_state,bootstrap_cursor,revision FROM catalog_enrichment_scope ORDER BY scope');
 const signals=await many(handle,"SELECT source,state,COUNT(*) AS n FROM enrichment_signal GROUP BY source,state ORDER BY source,state");
 const expected=scopes.find(row=>row.scope===ACTIVATION_SCOPE);
 const qualifying=expected?.cutoff_at?Number((await one(handle,'SELECT COUNT(*) AS n FROM film_rated_admission WHERE verified_at>=?',[expected.cutoff_at]))?.n||0):null;
 const bootstrapped=expected?Number((await one(handle,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='admitted' AND source='rated' AND part=''"))?.n||0):null;
 return {
  control:{state:control.state,generation:control.generation,revision:control.revision,updatedBy:control.updatedBy},
  scopes:scopes.map(row=>({scope:row.scope,activated:Number(row.activated),enabled:Number(row.enabled),cutoffAt:row.cutoff_at,bootstrapState:row.bootstrap_state,revision:Number(row.revision)})),
  signals:signals.map(row=>({source:row.source,state:row.state,count:Number(row.n)})),
  qualifyingAdmissions:qualifying,
  ratedSignals:bootstrapped,
  onlyRatedScope:scopes.length===1&&!!expected
 };
}
