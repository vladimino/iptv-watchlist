// AIR-499. Protected Film/Person `prepared` → `open` operator. UNBUNDLED: the Worker does not import this module, no route, cron
// or MCP tool calls it, and a merge authorizes no production flip. The flip is ONE guarded UPDATE plus readback (no REST
// `changes()` CAS pair). Exclusive window/lease predicates use the database clock, not the preflight timestamp.
import {database,failed,many,one,projectorExpectation,readAuthority} from './film-person-authority.js';
import {grantProjectorWindow,releaseProjectorWindow,requestProjectorWindow,WINDOW_DEADLINE_MS} from './discovery-authority.js';
import {writerRoute} from './canonical-writer-route.js';
import {CANONICAL_READER_REGISTRY} from './canonical-catalog-reader.js';
import {EMPTY_CLASSES,PRODUCER_OPERATIONS,PRODUCER_WIRING} from './canonical-producers.js';
import {BASELINE_CAP,listAttention,recordBaseline,readUnreceipted,verifyBaseline} from './canonical-receipts.js';

export const OPEN_HANDOFF_MIN_VERSION=23;
export const OPEN_HANDOFF_PROJECTION='enrichment';
export const OPEN_HANDOFF_LEASE_MS=10*60000;
export const OPEN_HANDOFF_OWNER_PREFIX='air-499-open-handoff';
export const OPERATOR_D1_TARGET=Object.freeze({
 databaseName:'iptv',
 databaseId:'3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb',
 endpoint:'https://api.cloudflare.com/client/v4',
});
// What the Producer Workflow actually plans per Film (src/canonical-producer-workflow.js filmFactsOf). Not metadata, dimensions or sync clocks.
export const WORKFLOW_FILM_FACTS=Object.freeze(['watchlist','canonicalIdentity','originalTitle']);
export const WORKFLOW_FILM_FACTS_ABSENT=Object.freeze(['film_metadata','film_dimension','film_sync_state']);

const DB_NOW_MS="(CAST(strftime('%s','now') AS INTEGER)*1000)";
const DB_NOW_ISO="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const FLIP_SQL="UPDATE film_person_authority SET mode='d1', cutover='open', generation=generation+1 WHERE id=1 AND mode='prepared' AND cutover='open' AND generation=?"
 +" AND EXISTS (SELECT 1 FROM film_person_cas WHERE id=1 AND ok>=1)"
 +" AND EXISTS (SELECT 1 FROM film_person_baseline WHERE id=1 AND state='verified' AND reference=?)"
 +" AND EXISTS (SELECT 1 FROM schema_contract WHERE id=1 AND version>=?)"
 +" AND EXISTS (SELECT 1 FROM discovery_authority WHERE id=1 AND mode='d1' AND cutover='open')"
 +" AND EXISTS (SELECT 1 FROM projector_window WHERE id=1 AND state='held' AND owner=? AND expires_at>"+DB_NOW_MS+")"
 +" AND EXISTS (SELECT 1 FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>"+DB_NOW_ISO+")"
 +" AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>"+DB_NOW_MS+")";

function iso(now){return typeof now==='string'?now:new Date(now).toISOString();}
function ms(now){const n=typeof now==='number'?now:Date.parse(iso(now));return Number.isFinite(n)?n:NaN;}
function stop(reason,extra={}){return {outcome:'stop',reason,...extra};}

export function classifyConsumer(item){
 if(item.class==='exception')return {name:item.name,file:item.file,class:item.class,moved:item.moved,kind:'adr0117_exception',d1Authoritative:false,d1Writer:false};
 if(item.class==='freeze'&&item.moved===true)return {name:item.name,file:item.file,class:item.class,moved:item.moved,kind:'d1_reader',d1Authoritative:true,d1Writer:false};
 if(item.class==='freeze'&&/writer/i.test(item.name))return {name:item.name,file:item.file,class:item.class,moved:item.moved,kind:'frozen_r2_writer',d1Authoritative:false,d1Writer:false,dualD1:false};
 return {name:item.name,file:item.file,class:item.class,moved:item.moved,kind:'frozen_r2_reader',d1Authoritative:false,d1Writer:false};
}

export function activationAudit(){
 const consumers=CANONICAL_READER_REGISTRY.map(classifyConsumer);
 const atomic=kind=>{for(const spec of PRODUCER_OPERATIONS.values())if(spec.operation===kind&&spec.atomic===true)return true;return false;};
 const producers=PRODUCER_WIRING.map(item=>({name:item.name,site:item.site,requires:item.requires,wired:item.requires.every(kind=>atomic(kind))}));
 const residuals=[
  ...consumers.filter(item=>item.class==='freeze'&&item.moved!==true).map(item=>'freeze_unmoved:'+item.name),
  ...producers.filter(item=>!item.wired).map(item=>'producer_not_wired:'+item.name),
  ...WORKFLOW_FILM_FACTS_ABSENT.map(kind=>'workflow_facts_absent:'+kind),
 ];
 return {consumers,producers,workflowFacts:WORKFLOW_FILM_FACTS,workflowFactsAbsent:WORKFLOW_FILM_FACTS_ABSENT,residuals};
}

export const ACTIVATION_CONSUMERS=Object.freeze(activationAudit().consumers);

async function liveLease(env,nowIso){
 const db=database(env);
 try{
  return await one(db,"SELECT lease_id AS leaseId, lease_until AS leaseUntil FROM projection_run WHERE projection=? AND lease_id IS NOT NULL AND lease_until>?",[OPEN_HANDOFF_PROJECTION,nowIso]);
 }catch(error){throw failed('projector_lease_unreadable',error);}
}

export async function takeProjectorLease(env,{owner,now}={}){
 if(!owner)throw failed('film_person_invalid');
 const db=database(env);
 const at=iso(now),until=new Date(ms(now)+OPEN_HANDOFF_LEASE_MS).toISOString();
 const held=await liveLease(env,at);
 if(held&&held.leaseId!==owner)return {taken:false,reason:'projector_lease_live',owner:held.leaseId};
 try{
  await db.prepare('INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES (?,?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at WHERE projection_run.lease_until IS NULL OR projection_run.lease_until<?')
   .bind(OPEN_HANDOFF_PROJECTION,owner,until,at,at).run();
 }catch(error){throw failed('projector_lease_unreadable',error);}
 const row=await one(db,'SELECT lease_id AS leaseId FROM projection_run WHERE projection=?',[OPEN_HANDOFF_PROJECTION]);
 return row?.leaseId===owner?{taken:true,owner,until}:{taken:false,reason:'projector_lease_lost'};
}

export async function releaseOwnProjectorLease(env,{owner,now}={}){
 if(!owner)return {released:false};
 const db=database(env);
 await db.prepare('UPDATE projection_run SET lease_id=NULL, lease_until=NULL, finished_at=?, outcome=? WHERE projection=? AND lease_id=?')
  .bind(iso(now),'open_handoff',OPEN_HANDOFF_PROJECTION,owner).run();
 return {released:true};
}

async function releaseOwn(env,{owner,now,keep=false}={}){
 if(keep||!owner)return {released:false,kept:!!keep};
 await releaseOwnProjectorLease(env,{owner,now});
 await releaseProjectorWindow(env,{owner});
 return {released:true,kept:false};
}

export async function exclusiveOwned(env,{owner}={}){
 const db=database(env);
 const window=await one(db,'SELECT state, owner, expires_at AS expiresAt FROM projector_window WHERE id=1 AND owner=? AND state=\'held\' AND expires_at>'+DB_NOW_MS,[owner]);
 const lease=await one(db,'SELECT lease_id AS leaseId FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>'+DB_NOW_ISO,[OPEN_HANDOFF_PROJECTION,owner]);
 const discovery=await one(db,'SELECT lease_id AS leaseId FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>'+DB_NOW_MS,[owner]);
 return !!(window&&lease&&discovery);
}

export async function activationReadiness(env,{now=new Date().toISOString(),expectedGeneration=null,expectedReference=null,classes=EMPTY_CLASSES}={}){
 const blockers=[];
 const audit=activationAudit();
 const nowMs=ms(now),nowIso=iso(now);
 if(!Number.isFinite(nowMs))blockers.push('now_invalid');
 if(audit.consumers.length!==CANONICAL_READER_REGISTRY.length)blockers.push('audit_incomplete');
 let gate=null;
 try{gate=await readAuthority(env);}catch(error){blockers.push('marker_unreadable:'+(error?.code||'error'));}
 if(gate){
  if(gate.state!=='prepared')blockers.push('marker_not_prepared:'+gate.state);
  if(gate.baseline!=='verified')blockers.push('baseline_not_verified:'+String(gate.baseline));
  if(Number.isInteger(expectedGeneration)&&gate.generation!==expectedGeneration)blockers.push('generation_mismatch:'+gate.generation+'/'+expectedGeneration);
 }
 const db=database(env);
 if(!db){blockers.push('no_database');return {ready:false,blockers,audit,generation:null,version:null};}
 let version=0,tables=new Set();
 try{
  version=Number((await one(db,'SELECT version AS contract_version FROM schema_contract WHERE id=1'))?.contract_version);
  tables=new Set((await many(db,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name));
  if(!Number.isFinite(version))throw new Error('contract');
  if(version<OPEN_HANDOFF_MIN_VERSION)blockers.push('schema_below_'+OPEN_HANDOFF_MIN_VERSION+':'+version);
 }catch{blockers.push('schema_unreadable');}
 try{
  const baseline=await one(db,'SELECT state, reference FROM film_person_baseline WHERE id=1');
  if(!baseline||baseline.state!=='verified')blockers.push('baseline_not_verified:'+String(baseline?.state));
  else if(expectedReference!=null&&baseline.reference!==expectedReference)blockers.push('baseline_reference_mismatch');
 }catch{blockers.push('baseline_unreadable');}
 try{
  const n=Number((await one(db,'SELECT COUNT(*) AS n FROM canonical_revision'))?.n);
  if(!Number.isFinite(n))throw new Error('revisions');
  if(n>BASELINE_CAP)blockers.push('baseline_over_capacity:'+n);
 }catch{blockers.push('revisions_unreadable');}
 try{
  const discovery=await one(db,"SELECT mode, cutover FROM discovery_authority WHERE id=1");
  if(!(discovery&&discovery.mode==='d1'&&discovery.cutover==='open'))blockers.push('discovery_not_open');
 }catch{blockers.push('discovery_unreadable');}
 try{
  if(!tables.has('projection_run'))throw new Error('projection_run');
  const lease=await liveLease(env,nowIso);
  if(lease)blockers.push('projector_lease_live');
 }catch{blockers.push('projector_lease_unreadable');}
 try{
  const window=await one(db,'SELECT state, expires_at AS expiresAt FROM projector_window WHERE id=1');
  if(!window||!['idle','requested','held'].includes(window.state))throw new Error('window');
  if(window.state!=='idle'&&!(Number(window.expiresAt)<=nowMs))blockers.push('projector_window_not_idle:'+window.state);
 }catch{blockers.push('projector_window_unreadable');}
 try{
  const lease=await one(db,'SELECT lease_id AS leaseId, expires_at AS expiresAt FROM discovery_lease WHERE id=1');
  if(lease?.leaseId&&Number(lease.expiresAt)>nowMs)blockers.push('discovery_lease_live');
 }catch{blockers.push('discovery_lease_unreadable');}
 try{
  const route=await writerRoute(env);
  if(route.writer!=='projector')blockers.push('writer_not_projector:'+route.writer);
 }catch(error){blockers.push('writer_route_unreadable:'+(error?.code||'error'));}
 for(const item of classes){
  if(!tables.has(item.table)){blockers.push('empty_class_unreadable:'+item.name);continue;}
  try{
   const found=Number((await one(db,'SELECT COUNT(*) AS n FROM '+item.table))?.n);
   if(found!==item.expected)blockers.push('empty_class_not_loaded:'+item.name+':'+found+'/'+item.expected);
  }catch{blockers.push('empty_class_unreadable:'+item.name);}
 }
 for(const item of audit.consumers){
  if(item.kind==='d1_reader'&&item.moved!==true)blockers.push('canonical_reader_not_moved:'+item.name);
  if(item.kind==='frozen_r2_writer'&&item.dualD1!==false)blockers.push('frozen_mirror_misclassified:'+item.name);
  if(item.kind==='adr0117_exception'&&item.moved===true)blockers.push('exception_marked_moved:'+item.name);
 }
 return {ready:blockers.length===0,blockers,audit,generation:gate?.generation??null,version};
}

export async function flipOpen(env,{expectedGeneration,expectedReference,owner}={}){
 const db=database(env);
 if(!db||typeof db.prepare!=='function')throw failed('film_person_unavailable');
 if(!Number.isInteger(expectedGeneration)||expectedGeneration<0||!expectedReference||!owner)throw failed('film_person_invalid');
 let before=null;
 try{before=await readAuthority(env);}catch(error){return {outcome:'unknown',retry:false,error};}
 if(before.state==='open'&&before.generation===expectedGeneration+1)return {outcome:'unknown_committed',retry:false,generation:before.generation};
 if(before.state!=='prepared'||before.generation!==expectedGeneration)return {outcome:'stop',reason:'flip_precondition',retry:false,generation:before.generation,state:before.state};
 const params=[expectedGeneration,expectedReference,OPEN_HANDOFF_MIN_VERSION,owner,OPEN_HANDOFF_PROJECTION,owner,owner];
 try{
  const statement=db.prepare(FLIP_SQL).bind(...params);
  if(typeof statement.run!=='function')throw failed('film_person_unavailable');
  await statement.run();
 }catch(error){
  let after=null;
  try{after=await readAuthority(env);}catch{after=null;}
  if(after?.state==='open'&&after.generation===expectedGeneration+1)return {outcome:'unknown_committed',retry:false,generation:after.generation,error};
  if(after?.state==='prepared'&&after.generation===expectedGeneration)return {outcome:'stop',reason:'flip_not_applied',retry:false,error};
  return {outcome:'unknown',retry:false,after,error};
 }
 const after=await readAuthority(env);
 if(after.state==='open'&&after.generation===expectedGeneration+1&&before.state==='prepared')return {outcome:'flipped',generation:after.generation,state:after.state};
 if(after.state==='prepared'&&after.generation===expectedGeneration)return {outcome:'stop',reason:'flip_precondition',retry:false,generation:after.generation};
 return {outcome:'unknown',retry:false,generation:after.generation,state:after.state};
}

async function proveOpen(env,{expectedGeneration}){
 const gate=await readAuthority(env);
 const route=await writerRoute(env);
 const row=await one(database(env),'SELECT mode,cutover,generation FROM film_person_authority WHERE id=1');
 const baseline=await verifyBaseline(env);
 const unreceipted=await readUnreceipted(env);
 const attention=await listAttention(env);
 const reasons=[];
 if(!(gate.state==='open'&&gate.generation===expectedGeneration+1))reasons.push('marker_not_open');
 if(route.writer!=='canonical')reasons.push('writer_not_canonical');
 if(projectorExpectation(row)!==null)reasons.push('projector_still_writable');
 if(!baseline.ok)reasons.push('baseline_unverified:'+baseline.reasons.join(','));
 if(!unreceipted.safe||unreceipted.unreceipted.length)reasons.push('unreceipted');
 if(attention.length)reasons.push('attention_open');
 return {ok:reasons.length===0,reasons,gate,route,baseline,unreceipted,attention};
}

export function proveOperatorTarget({target,described}={}){
 const reasons=[];
 if(!target||target.endpointOverride)reasons.push('endpoint_override');
 if(target?.endpoint!==OPERATOR_D1_TARGET.endpoint)reasons.push('endpoint_mismatch');
 if(target?.databaseName!==OPERATOR_D1_TARGET.databaseName)reasons.push('name_mismatch');
 if(target?.databaseId!==OPERATOR_D1_TARGET.databaseId)reasons.push('uuid_mismatch');
 if(described?.name!==OPERATOR_D1_TARGET.databaseName)reasons.push('describe_name_mismatch');
 if(described?.uuid!==OPERATOR_D1_TARGET.databaseId)reasons.push('describe_uuid_mismatch');
 return {ok:reasons.length===0,reasons};
}

export async function activateOpen(env,{apply=false,confirmGo=false,expectedGeneration,expectedReference,now=new Date().toISOString(),owner=null,classes=EMPTY_CLASSES}={}){
 if(apply&&confirmGo!==true)return stop('confirm_go_required');
 const clock=now;
 const readiness=await activationReadiness(env,{now:clock,expectedGeneration,expectedReference,classes});
 if(!apply)return {outcome:'dry_run',apply:false,readiness};
 if(!readiness.ready)return stop('preflight',{readiness});
 const id=owner||OPEN_HANDOFF_OWNER_PREFIX+':'+iso(clock);
 const wall=Date.now();
 let keep=false;
 try{
  const lease=await takeProjectorLease(env,{owner:id,now:wall});
  if(!lease.taken)return stop(lease.reason||'projector_lease_lost',{readiness});
  const requested=await requestProjectorWindow(env,{owner:id,deadlineMs:WINDOW_DEADLINE_MS,now:wall});
  if(requested.outcome!=='requested'){
   await releaseOwn(env,{owner:id,now:wall});
   return stop('window_'+requested.outcome,{requested,readiness});
  }
  const granted=await grantProjectorWindow(env,{owner:id,now:wall});
  if(granted.outcome!=='granted'){
   await releaseOwn(env,{owner:id,now:wall});
   return stop('window_'+granted.outcome,{granted,readiness});
  }
  const flipped=await flipOpen(env,{expectedGeneration,expectedReference,owner:id});
  if(flipped.outcome!=='flipped'){
   keep=flipped.outcome==='unknown_committed'||flipped.outcome==='unknown';
   if(!keep)await releaseOwn(env,{owner:id,now:wall});
   return stop(flipped.reason||flipped.outcome,{flipped,retry:false,keepLease:keep,readiness});
  }
  keep=true;
  if(!(await exclusiveOwned(env,{owner:id})))return stop('exclusive_expired',{flipped,keepLease:true,readiness});
  let sealed;
  try{sealed=await recordBaseline(env,{now:()=>new Date().toISOString()});}
  catch(error){
   return stop('seal_failed',{error,keepLease:true,flipped,readiness});
  }
  if(!(await exclusiveOwned(env,{owner:id})))return stop('exclusive_expired_after_seal',{flipped,sealed,keepLease:true,readiness});
  const proof=await proveOpen(env,{expectedGeneration});
  if(!proof.ok)return stop('readback_failed',{proof,sealed,keepLease:true,readiness});
  await releaseOwn(env,{owner:id,now:Date.now()});
  keep=false;
  return {outcome:'activated',generation:flipped.generation,owner:id,sealed,proof,readiness};
 }catch(error){
  if(!keep)await releaseOwn(env,{owner:id,now:Date.now()}).catch(()=>{});
  return stop('activate_failed',{error,keepLease:keep,readiness});
 }
}

export function parseOpenHandoffArgs(argv){
 const out={apply:false,confirmGo:false,expectedGeneration:null,expectedReference:null};
 for(const arg of argv){
  if(arg==='--apply')out.apply=true;
  else if(arg==='--confirm-go')out.confirmGo=true;
  else if(arg.startsWith('--expected-generation='))out.expectedGeneration=Number(arg.slice('--expected-generation='.length));
  else if(arg.startsWith('--expected-reference='))out.expectedReference=arg.slice('--expected-reference='.length);
  else if(arg==='--help')out.help=true;
  else throw failed('film_person_invalid');
 }
 if(out.expectedGeneration!=null&&!Number.isInteger(out.expectedGeneration))throw failed('film_person_invalid');
 return out;
}
