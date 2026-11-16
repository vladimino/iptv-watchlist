// AIR-499. Protected Film/Person `prepared` → `open` operator. UNBUNDLED: the Worker does not import this module, no route, cron
// or MCP tool calls it, and a merge authorizes no production flip. `transitionAuthority` only CAS-es the marker and fence; this
// module adds the exclusive projector lease, the ADR 0103 window, the verified baseline reference and Discovery d1/open into THAT
// SAME flip batch, then records and verifies the receipt baseline before it releases what it owns.
//
// `handoffReadiness` (src/canonical-producers.js) stays the honest P6 registry: producers still unwired and freeze readers still
// unmoved. Activation uses `activationReadiness` instead, which treats GET programme/watchlist (already D1 at `open`) as the
// canonical readers and the remaining freeze writers as frozen R2 mirrors, not dual D1 writers.
import {database,failed,many,one,projectorExpectation,readAuthority} from './film-person-authority.js';
import {grantProjectorWindow,releaseProjectorWindow,requestProjectorWindow,WINDOW_DEADLINE_MS} from './discovery-authority.js';
import {writerRoute} from './canonical-writer-route.js';
import {CANONICAL_READER_REGISTRY} from './canonical-catalog-reader.js';
import {EMPTY_CLASSES} from './canonical-producers.js';
import {BASELINE_CAP,listAttention,recordBaseline,readUnreceipted,verifyBaseline} from './canonical-receipts.js';

export const OPEN_HANDOFF_MIN_VERSION=23;
export const OPEN_HANDOFF_PROJECTION='enrichment';
export const OPEN_HANDOFF_LEASE_MS=10*60000;
export const OPEN_HANDOFF_OWNER_PREFIX='air-499-open-handoff';

const MOVED_READERS=Object.freeze(['GET /api/programme titles.json','GET /api/watchlist titles.json']);
const FROZEN_MIRROR_WRITERS=Object.freeze([
 'metadataSync titles.json, people.json and metadata.json working set (writer)',
 'epgSync title and people localization (writer of titles.json, people.json)',
]);

// Honest consumer audit. Freeze entries that still write R2 titles/people at `open` are frozen-mirror drift, not a second D1 writer.
export const ACTIVATION_CONSUMERS=Object.freeze([
 Object.freeze({name:'GET /api/programme titles.json',kind:'canonical_reader',atOpen:'d1'}),
 Object.freeze({name:'GET /api/watchlist titles.json',kind:'canonical_reader',atOpen:'d1'}),
 Object.freeze({name:'epgSync titles.json people.json',kind:'frozen_r2_mirror',atOpen:'freeze'}),
 Object.freeze({name:'metadataSync titles.json people.json',kind:'frozen_r2_mirror',atOpen:'freeze'}),
]);

const CAS_SQL='INSERT INTO film_person_cas (id,ok) VALUES (1,(SELECT CASE WHEN EXISTS (SELECT 1 FROM film_person_cas WHERE id=1) AND changes()>=1 THEN 1 ELSE 0 END)) ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const FLIP_SQL="UPDATE film_person_authority SET mode='d1', cutover='open', generation=generation+1 WHERE id=1 AND mode='prepared' AND cutover='open' AND generation=?"
 +" AND EXISTS (SELECT 1 FROM film_person_cas WHERE id=1 AND ok>=1)"
 +" AND EXISTS (SELECT 1 FROM film_person_baseline WHERE id=1 AND state='verified' AND reference=?)"
 +" AND EXISTS (SELECT 1 FROM schema_contract WHERE id=1 AND version>=?)"
 +" AND EXISTS (SELECT 1 FROM discovery_authority WHERE id=1 AND mode='d1' AND cutover='open')"
 +" AND EXISTS (SELECT 1 FROM projector_window WHERE id=1 AND state='held' AND owner=? AND expires_at>?)"
 +" AND EXISTS (SELECT 1 FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?)"
 +" AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?)";

function iso(now){return typeof now==='string'?now:new Date(now).toISOString();}
function ms(now){const n=typeof now==='number'?now:Date.parse(iso(now));return Number.isFinite(n)?n:NaN;}
function stop(reason,extra={}){return {outcome:'stop',reason,...extra};}

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

export async function activationReadiness(env,{now=new Date().toISOString(),expectedGeneration=null,expectedReference=null,classes=EMPTY_CLASSES}={}){
 const blockers=[];
 const nowMs=ms(now),nowIso=iso(now);
 if(!Number.isFinite(nowMs))blockers.push('now_invalid');
 let gate=null;
 try{gate=await readAuthority(env);}catch(error){blockers.push('marker_unreadable:'+(error?.code||'error'));}
 if(gate){
  if(gate.state!=='prepared')blockers.push('marker_not_prepared:'+gate.state);
  if(gate.baseline!=='verified')blockers.push('baseline_not_verified:'+String(gate.baseline));
  if(Number.isInteger(expectedGeneration)&&gate.generation!==expectedGeneration)blockers.push('generation_mismatch:'+gate.generation+'/'+expectedGeneration);
 }
 const db=database(env);
 if(!db){blockers.push('no_database');return {ready:false,blockers,consumers:ACTIVATION_CONSUMERS};}
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
 const byName=Object.fromEntries(CANONICAL_READER_REGISTRY.map(item=>[item.name,item]));
 for(const name of MOVED_READERS){
  const item=byName[name];
  if(!(item&&item.class==='freeze'&&item.moved===true))blockers.push('canonical_reader_not_moved:'+name);
 }
 for(const name of FROZEN_MIRROR_WRITERS){
  const item=byName[name];
  if(!(item&&item.class==='freeze'&&item.moved===false))blockers.push('frozen_mirror_misclassified:'+name);
 }
 return {ready:blockers.length===0,blockers,consumers:ACTIVATION_CONSUMERS,generation:gate?.generation??null,version};
}

export async function flipOpen(env,{expectedGeneration,expectedReference,owner,now}={}){
 const db=database(env);
 if(!db||typeof db.batch!=='function')throw failed('film_person_unavailable');
 if(!Number.isInteger(expectedGeneration)||expectedGeneration<0||!expectedReference||!owner)throw failed('film_person_invalid');
 const nowMs=ms(now),nowIso=iso(now);
 const statements=[
  [FLIP_SQL,[expectedGeneration,expectedReference,OPEN_HANDOFF_MIN_VERSION,owner,nowMs,OPEN_HANDOFF_PROJECTION,owner,nowIso,owner,nowMs]],
  [CAS_SQL,[]],
 ];
 try{await db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params)));}
 catch(error){
  let after=null;
  try{after=await readAuthority(env);}catch{after=null;}
  if(after?.state==='open'&&after.generation===expectedGeneration+1)return {outcome:'unknown_committed',retry:false,generation:after.generation,error};
  if(after?.state==='prepared'&&after.generation===expectedGeneration)return {outcome:'stop',reason:'flip_not_applied',retry:false,error};
  return {outcome:'unknown',retry:false,after,error};
 }
 const after=await readAuthority(env);
 if(after.state==='open'&&after.generation===expectedGeneration+1)return {outcome:'flipped',generation:after.generation,state:after.state};
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

// apply:false is a dry preflight (no lease, window or marker write). apply:true performs the fenced sequence. confirmGo must be true
// with apply; the CLI maps --confirm-go. An unknown flip never retries.
export async function activateOpen(env,{apply=false,confirmGo=false,expectedGeneration,expectedReference,now=new Date().toISOString(),owner=null,classes=EMPTY_CLASSES}={}){
 if(apply&&confirmGo!==true)return stop('confirm_go_required');
 const clock=now;
 const readiness=await activationReadiness(env,{now:clock,expectedGeneration,expectedReference,classes});
 if(!apply)return {outcome:'dry_run',apply:false,readiness};
 if(!readiness.ready)return stop('preflight',{readiness});
 const id=owner||OPEN_HANDOFF_OWNER_PREFIX+':'+iso(clock);
 const nowMs=ms(clock);
 let keep=false;
 try{
  const lease=await takeProjectorLease(env,{owner:id,now:clock});
  if(!lease.taken)return stop(lease.reason||'projector_lease_lost',{readiness});
  const requested=await requestProjectorWindow(env,{owner:id,deadlineMs:WINDOW_DEADLINE_MS,now:nowMs});
  if(requested.outcome!=='requested'){
   await releaseOwn(env,{owner:id,now:clock});
   return stop('window_'+requested.outcome,{requested,readiness});
  }
  const granted=await grantProjectorWindow(env,{owner:id,now:nowMs});
  if(granted.outcome!=='granted'){
   await releaseOwn(env,{owner:id,now:clock});
   return stop('window_'+granted.outcome,{granted,readiness});
  }
  const flipped=await flipOpen(env,{expectedGeneration,expectedReference,owner:id,now:clock});
  if(flipped.outcome!=='flipped'){
   keep=flipped.outcome==='unknown_committed'||flipped.outcome==='unknown';
   if(!keep)await releaseOwn(env,{owner:id,now:clock});
   return stop(flipped.reason||flipped.outcome,{flipped,retry:false,keepLease:keep,readiness});
  }
  keep=true;
  let sealed;
  try{sealed=await recordBaseline(env,{now:()=>iso(clock)});}
  catch(error){
   return stop('seal_failed',{error,keepLease:true,flipped,readiness});
  }
  const proof=await proveOpen(env,{expectedGeneration});
  if(!proof.ok)return stop('readback_failed',{proof,sealed,keepLease:true,readiness});
  await releaseOwn(env,{owner:id,now:clock});
  keep=false;
  return {outcome:'activated',generation:flipped.generation,owner:id,sealed,proof,readiness};
 }catch(error){
  if(!keep)await releaseOwn(env,{owner:id,now:clock}).catch(()=>{});
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
