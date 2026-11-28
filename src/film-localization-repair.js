// AIR-664 (ADR 0225, Proposed). The ONE-OFF, owner-only operation that repairs the 16 Film localization rows the AIR-683 census found stale. It is the body of the MCP tool `film_localization_repair`,
// reached only through the existing owner-only MCP gate (Cloudflare Access plus the signed JWT). It adds no route, binding, migration, table, bucket, Cron, Task, Workflow, queue or batch API.
// - FIXED COHORT: the 16 Film ids are a constant of this module. The caller supplies no Film id (restore takes one id and refuses any that is not in the constant), no key, no SQL, no intent body.
// - NO NEW RESOLVER OR WRITER: every Film goes through the delivered AIR-663 exact-intent path: `readReconcileIntent` (read only), `resumeLocalizationReconcile` (record BEFORE the write, one receipted atomic
//   fenced batch, settle after), `recoverLocalizationReconcile` and `recoverRestoreLocalization` (read only), `restoreLocalizationReconcile` (exact recorded post-revision and pre-image). The replanning
//   `applyLocalizationReconcile` pass is not used.
// - PLAN TIME: a preflight reads the server clock ONCE (`planAt`), derives every intent at that time and returns it among the pins; `apply` must present it and re-derives at exactly that time. Nothing is backdated:
//   a plan time earlier than any cohort revision timestamp is refused, and a Film revised after the preflight changes its planned revision and so the digest.
// - PINS (preflight, apply and restore): Film/Person generation, schema contract version, owner-review generation AND writes, plus the plan time and the digest. They are compared at the approval, before every
//   Film, and ASSERTED IN THE SAME BATCH as the receipt reservation and as the domain write (`approvedPins` of the fenced path). A moved pin writes nothing.
// - CHECKPOINT = the existing private R2 bucket, one isolated prefix: immutable intent objects and immutable, sequence-numbered outcome events, each created with a conditional put that cannot overwrite. After a
//   precondition failure, a timeout or an error the object is read back and compared IN FULL (equal is an idempotent success, different is `checkpoint_conflict`, unreadable or absent is NOT recorded and nothing is
//   written). The stored history is validated against its intent (request id, digest, version, shape and the transition table). R2 holds recovery artifacts only; an R2 event is NEVER proof of a D1 effect: every
//   claim is re-proved from the receipt, the revision and the row.
// - ACCEPTANCE is current and scoped to the 16 Films: a Film counts as applied only while its apply receipt is applied at the recorded post-revision, the row equals the post-image AND the resolver reports it
//   current. A later legitimate change is reported (`applied_moved`), never overwritten and never complete.
// - RESPONSES carry counts, states, Film ids, request ids, digests and pins. Never an intent body, a localization value or an R2 key. `writes` is a number only when proved; it is null while an effect is unproved.
// A merge of this module or the tool listing is NOT a production GO: `confirmGo` is a technical safeguard, the owner's separate explicit GO on the preflight pins is the authority.
import {database,failed,one,readAuthority} from './film-person-authority.js';
import {canonicalJson,digestOf} from './canonical-receipts.js';
import {checkIntent,readReconcileIntent,recoverLocalizationReconcile,recoverRestoreLocalization,restoreLocalizationReconcile,resumeLocalizationReconcile} from './film-localization-reconciler.js';

// The 16 Film ids observed stale by the AIR-683 live census (27 November 2026). Sorted in code-unit order; the operation never adds to it.
export const REPAIR_COHORT=Object.freeze(['film:1XYA','film:27iE','film:28R6','film:DCVQ','film:MYia','film:QGFo','film:R9dS','film:RTwc','film:RfZI','film:iXBq','film:jGuE','film:tmdb:101669','film:tmdb:516486','film:tmdb:649409','film:vCu0','film:xG0M']);
export const REPAIR_RUN_ID='air664-localization-repair-1';
export const REPAIR_RESTORE_RUN_ID='air664-localization-restore-1';
export const REPAIR_PREFIX='film-localization-repair/air-664/';
export const REPAIR_MODES=Object.freeze(['preflight','recover','apply','restore']);
const HEX64=/^[0-9a-f]{64}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEY_PART=/^[A-Za-z0-9_.:-]{1,200}$/;
const WRITES=['open','held'];
const VIAS=['apply','recover','restore'];
const TRANSITIONS={recorded:['applied','not_applied','unknown'],not_applied:['applied','not_applied','unknown'],unknown:['applied','not_applied','unknown'],applied:['restored'],restored:[]};
const EVENT_KEYS=['digest','errorClass','receiptState','requestId','revision','seq','state','version','via'];
const ACTIONABLE=new Set(['eligible','recorded']);
const BLOCKING=new Set(['held','absent','unavailable','applied_moved','applied_unproved','restored_unproved']);
const ACCEPTED=new Set(['applied','noop','restored']);
const STATES=['eligible','recorded','applied','applied_moved','applied_unproved','restored','restored_unproved','noop','held','absent','unavailable'];
const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by;};
const inCohort=id=>typeof id==='string'&&REPAIR_COHORT.includes(id);
const clockOf=now=>typeof now==='function'?now:()=>new Date().toISOString();

// ---- the R2 checkpoint (existing private bucket, isolated prefix, immutable objects) ----
const bucketOf=env=>{
 const bucket=env?.BUCKET;
 if(!bucket||typeof bucket.put!=='function'||typeof bucket.get!=='function'||typeof bucket.list!=='function')throw failed('checkpoint_unavailable');
 return bucket;
};
const safeId=requestId=>{if(typeof requestId!=='string'||!KEY_PART.test(requestId))throw failed('film_person_invalid');return requestId;};
const intentPrefix=REPAIR_PREFIX+'intents/';
const intentKey=requestId=>intentPrefix+safeId(requestId)+'.json';
const eventPrefix=requestId=>REPAIR_PREFIX+'events/'+safeId(requestId)+'/';
const eventKey=(requestId,seq)=>eventPrefix(requestId)+String(seq).padStart(4,'0')+'.json';
async function listKeys(bucket,prefix){
 let out;
 try{out=await bucket.list({prefix});}catch(error){throw failed('checkpoint_unavailable',error);}
 // A truncated listing cannot prove what is recorded: fail closed.
 if(!out||out.truncated||!Array.isArray(out.objects))throw failed('checkpoint_listing_truncated');
 return out.objects.map(item=>item.key).sort();
}
async function readJson(bucket,key){
 let got;
 try{got=await bucket.get(key);}catch(error){throw failed('checkpoint_unavailable',error);}
 if(!got)return null;
 try{return JSON.parse(await got.text());}catch(error){throw failed('checkpoint_corrupt',error);}
}
// Create-once. A conditional put never overwrites. Anything but a clean create (a precondition failure, a timeout, an error) is settled by reading the object back and comparing its FULL content.
async function createOnce(bucket,key,value){
 const text=canonicalJson(value);
 let saved=null;
 try{saved=await bucket.put(key,text,{httpMetadata:{contentType:'application/json'},onlyIf:{etagDoesNotMatch:'*'}});}catch{saved=null;}
 if(saved)return 'created';
 const existing=await readJson(bucket,key);
 if(existing===null)throw failed('checkpoint_not_recorded');
 if(canonicalJson(existing)!==text)throw failed('checkpoint_conflict');
 return 'existing';
}
// One stored outcome event, validated against ITS intent and the transition table: nothing else in the object is trusted.
function checkEvent(event,intent,seq,previous){
 const shape=event&&typeof event==='object'&&!Array.isArray(event);
 if(!shape||canonicalJson(Object.keys(event).sort())!==canonicalJson(EVENT_KEYS))throw failed('checkpoint_corrupt');
 const typed=event.version===1&&event.requestId===intent.requestId&&event.digest===intent.digest&&event.seq===seq&&VIAS.includes(event.via)&&(event.errorClass===null||typeof event.errorClass==='string')&&(event.receiptState===null||typeof event.receiptState==='string')&&(event.revision===null||Number.isInteger(event.revision));
 if(!typed||event.state==='recorded'||!TRANSITIONS[event.state]||!TRANSITIONS[previous].includes(event.state))throw failed('checkpoint_corrupt');
 if(event.state==='applied'&&event.revision!==intent.postRevision)throw failed('checkpoint_corrupt');
 if(event.state==='restored'&&event.revision!==intent.postRevision+1)throw failed('checkpoint_corrupt');
 return event;
}
async function readEvents(bucket,intent){
 const keys=await listKeys(bucket,eventPrefix(intent.requestId));
 const events=[];let previous='recorded';
 for(let at=0;at<keys.length;at++){
  if(keys[at]!==eventKey(intent.requestId,at+1))throw failed('checkpoint_corrupt');
  const event=checkEvent(await readJson(bucket,keys[at]),intent,at+1,previous);
  events.push(event);previous=event.state;
 }
 return events;
}
const stateOfEvents=events=>events.length?events.at(-1).state:'recorded';
const withoutSeq=event=>canonicalJson({...event,seq:undefined});
// Appends ONE outcome event. The same event again is an idempotent success; a transition the table forbids is refused; a lost sequence race is compared in full and retried once.
async function appendEvent(bucket,intent,body){
 if(!VIAS.includes(body.via||'apply')||!TRANSITIONS[body.state]||body.state==='recorded')throw failed('checkpoint_scope');
 const event={version:1,requestId:intent.requestId,digest:intent.digest,state:body.state,errorClass:body.errorClass??null,receiptState:body.receiptState??null,revision:body.state==='applied'?intent.postRevision:body.state==='restored'?intent.postRevision+1:null,via:body.via||'apply'};
 const recorded=await readJson(bucket,intentKey(intent.requestId));
 if(recorded===null||canonicalJson(recorded)!==canonicalJson(intent))throw failed('checkpoint_not_recorded');
 for(let attempt=0;attempt<2;attempt++){
  const events=await readEvents(bucket,intent);
  const last=events.at(-1);
  if(last&&withoutSeq(last)===canonicalJson(event))return last.seq;
  if(!TRANSITIONS[stateOfEvents(events)]?.includes(event.state))throw failed('checkpoint_transition_refused');
  const seq=events.length+1;
  try{await createOnce(bucket,eventKey(intent.requestId,seq),{...event,seq});return seq;}
  catch(error){if(error?.code==='checkpoint_conflict'&&attempt===0)continue;throw error;}
 }
 throw failed('checkpoint_conflict');
}
const scoped=intent=>inCohort(intent.id)&&intent.runId===REPAIR_RUN_ID&&ISO.test(intent.at);
// The `checkpoint` port the delivered reconciler requires: record BEFORE the write is permitted, settle the outcome after.
export function repairCheckpoint(env){
 const bucket=bucketOf(env);
 return {
  record:async given=>{
   const intent=await checkIntent(given);
   if(!scoped(intent))throw failed('checkpoint_scope');
   await createOnce(bucket,intentKey(intent.requestId),intent);
  },
  settle:async(given,result)=>{
   const intent=await checkIntent(given);
   if(!scoped(intent)||!result||typeof result.state!=='string')throw failed('checkpoint_scope');
   await appendEvent(bucket,intent,result);
  },
 };
}
// Every recorded intent of the operation with its validated outcome events: Map(filmId -> [{intent,events,state}]). Fails closed on anything outside the cohort or the fixed run.
async function readRecorded(env){
 const bucket=bucketOf(env);
 const out=new Map();
 for(const key of await listKeys(bucket,intentPrefix)){
  const intent=await checkIntent(await readJson(bucket,key));
  if(!scoped(intent)||key!==intentKey(intent.requestId))throw failed('checkpoint_corrupt');
  const events=await readEvents(bucket,intent);
  const list=out.get(intent.id)||[];
  list.push({intent,events,state:stateOfEvents(events)});
  out.set(intent.id,list);
 }
 return out;
}

// ---- authority pins ----
async function readPins(env){
 const gate=await readAuthority(env);
 let owner;
 try{owner=await one(database(env),'SELECT mode,generation,writes FROM owner_review_authority WHERE id=1');}
 catch(error){throw failed('localization_owner_unavailable',error);}
 if(!owner)throw failed('localization_owner_unavailable');
 const pins={filmPersonState:gate.state,filmPersonGeneration:Number(gate.generation),schemaVersion:Number(gate.version),ownerReviewMode:owner.mode,ownerReviewWrites:owner.writes,ownerReviewGeneration:Number(owner.generation)};
 pins.ready=pins.filmPersonState==='open'&&pins.ownerReviewMode==='d1'&&WRITES.includes(pins.ownerReviewWrites);
 return pins;
}
// EVERY pin, including the owner-review writes state and the readiness, takes part in the comparison.
const pinKey=pins=>canonicalJson({state:pins.filmPersonState,generation:pins.filmPersonGeneration,schema:pins.schemaVersion,mode:pins.ownerReviewMode,writes:pins.ownerReviewWrites,owner:pins.ownerReviewGeneration,ready:pins.ready});
const approvedOf=pins=>({filmPersonGeneration:pins.filmPersonGeneration,schemaVersion:pins.schemaVersion,ownerReviewGeneration:pins.ownerReviewGeneration,ownerReviewWrites:pins.ownerReviewWrites});
const publicPins=pins=>({filmPersonState:pins.filmPersonState,filmPersonGeneration:pins.filmPersonGeneration,schemaVersion:pins.schemaVersion,ownerReviewMode:pins.ownerReviewMode,ownerReviewWrites:pins.ownerReviewWrites,ownerReviewGeneration:pins.ownerReviewGeneration});

// ---- the cohort, derived now ----
// Per Film (every one of the 16, whatever the recorded history says): applied (proved NOW: apply receipt applied at the recorded post-revision, row equal to the post-image, resolver reports current),
// applied_moved (the receipt is applied but the Film or its row has since changed legitimately: reported, never overwritten), applied_unproved (the history says applied, D1 does not prove it), restored /
// restored_unproved (the same for a restore, by its OWN receipt), recorded (an intent is recorded with no applied outcome: recovered, never re-derived), or a fresh derive at the plan time: eligible, noop, held,
// absent, unavailable.
async function resolverOf(env,id,at){
 const {intent,plan}=await readReconcileIntent(env,id,{runId:REPAIR_RUN_ID,at});
 return {intent,state:intent?'stale':plan.state==='held'?'held':plan.state==='absent'?'absent':'noop',reason:plan.reason||null};
}
async function inspectApplied(env,id,entry,planAt){
 const {intent}=entry;
 try{
  const proof=await recoverLocalizationReconcile(env,{intent});
  const resolver=await resolverOf(env,id,planAt);
  const detail={receipt:proof.state,revision:proof.revision??null,rowIsPostImage:proof.rowIsPostImage??null,resolver:resolver.state,resolverReason:resolver.reason};
  if(proof.state!=='applied')return {id,state:'applied_unproved',intent,entry,detail};
  if(proof.rowIsPostImage===true&&proof.revision===intent.postRevision&&resolver.state==='noop')return {id,state:'applied',intent,entry,detail};
  return {id,state:'applied_moved',intent,entry,detail};
 }catch(error){return {id,state:'unavailable',code:error?.code||'unclassified',intent,entry};}
}
async function inspectRestored(env,id,entry){
 const {intent}=entry;
 try{
  const proof=await recoverRestoreLocalization(env,{intent,runId:REPAIR_RESTORE_RUN_ID});
  return {id,state:proof.state==='applied'?'restored':'restored_unproved',intent,entry,detail:{receipt:proof.state,revision:proof.revision}};
 }catch(error){return {id,state:'unavailable',code:error?.code||'unclassified',intent,entry};}
}
async function inspectFilm(env,id,recorded,planAt){
 const entries=recorded.get(id)||[];
 const applied=entries.find(entry=>entry.state==='applied');
 if(applied)return inspectApplied(env,id,applied,planAt);
 const restored=entries.find(entry=>entry.state==='restored');
 if(restored)return inspectRestored(env,id,restored);
 const open=entries.filter(entry=>entry.state==='recorded'||entry.state==='unknown');
 if(open.length>1)return {id,state:'unavailable',code:'multiple_open_intents'};
 if(open.length===1)return {id,state:'recorded',intent:open[0].intent,entry:open[0]};
 try{
  const resolver=await resolverOf(env,id,planAt);
  if(resolver.intent)return {id,state:'eligible',intent:resolver.intent};
  return {id,state:resolver.state,reason:resolver.reason};
 }catch(error){return {id,state:'unavailable',code:error?.code||'unclassified'};}
}
async function deriveCohort(env,{planAt}){
 const counts={cohort:REPAIR_COHORT.length};
 for(const state of STATES)counts[state]=0;
 const out={decision:'unsafe',pins:null,counts,heldByReason:{},unavailableByCode:{},items:[],expect:null,found:[],planAt};
 let pins,recorded;
 try{pins=await readPins(env);}catch(error){out.decision=['film_person_held','film_person_not_open'].includes(error?.code)?'unsafe':'unknown';out.failure=error?.code||'film_person_unavailable';return out;}
 out.pins=pins;
 if(!pins.ready){out.failure=pins.filmPersonState!=='open'?'localization_authority_not_open':'localization_owner_unavailable';return out;}
 try{
  recorded=await readRecorded(env);
  // The plan time may not be earlier than any cohort revision timestamp: a canonical revision is never stamped before its predecessor.
  const latest=await one(database(env),'SELECT MAX(updated_at) AS at FROM canonical_revision WHERE kind=? AND id IN ('+REPAIR_COHORT.map(()=>'?').join(',')+')',['film',...REPAIR_COHORT]);
  if(latest?.at&&String(latest.at)>planAt){out.decision='unknown';out.failure='plan_time_behind_revision';return out;}
 }catch(error){out.decision='unknown';out.failure=error?.code||'checkpoint_unavailable';return out;}
 for(const id of REPAIR_COHORT){
  const found=await inspectFilm(env,id,recorded,planAt);
  out.found.push(found);
  bump(counts,found.state);
  if(found.state==='held')bump(out.heldByReason,found.reason||'unclassified');
  if(found.state==='unavailable')bump(out.unavailableByCode,found.code);
  out.items.push({id,state:found.state,...(found.intent?{requestId:found.intent.requestId,digest:found.intent.digest,plannedRevision:found.intent.plannedRevision}:{}),...(found.entry?{recordedState:found.entry.state}:{}),...(found.detail?{current:found.detail}:{})});
 }
 const lines=out.found.map(found=>[found.id,found.state,found.intent?.digest||'',found.entry?.state||'',found.detail?.revision??''].join(':'));
 const actionable=out.found.filter(found=>ACTIONABLE.has(found.state)).length;
 out.expect={filmPersonGeneration:pins.filmPersonGeneration,schemaVersion:pins.schemaVersion,ownerReviewGeneration:pins.ownerReviewGeneration,ownerReviewWrites:pins.ownerReviewWrites,planAt,count:actionable,digest:await digestOf({planAt,lines})};
 const blocked=out.found.some(found=>BLOCKING.has(found.state));
 out.decision=blocked?'blocked':actionable?'eligible':'nothing_to_do';
 // The authority snapshot must still be the one read at the start; a moved pin makes the pins unusable.
 let again;
 try{again=await readPins(env);}catch(error){out.decision='unknown';out.failure=error?.code||'film_person_unavailable';out.expect=null;return out;}
 if(pinKey(again)!==pinKey(pins)){out.decision='unknown';out.failure='state_moved_during_read';out.expect=null;}
 return out;
}
const publicView=cohort=>({decision:cohort.decision,failure:cohort.failure||null,cohort:cohort.counts.cohort,counts:cohort.counts,heldByReason:cohort.heldByReason,unavailableByCode:cohort.unavailableByCode,items:cohort.items,pins:cohort.pins?publicPins(cohort.pins):null,expect:cohort.expect});

// ---- recover (read only) ----
// The restore proof of ONE recorded intent: the apply receipt and the Film now, the restore receipt by its OWN identity, and a digest of exactly that with the pins. A restore is approved against THIS proof,
// never against the apply-time pins.
async function restoreProof(env,intent,pins){
 const apply=await recoverLocalizationReconcile(env,{intent});
 const restore=await recoverRestoreLocalization(env,{intent,runId:REPAIR_RESTORE_RUN_ID});
 const eligible=apply.state==='applied'&&apply.revision===intent.postRevision&&apply.rowIsPostImage===true&&restore.state==='not_applied';
 const digest=await digestOf({requestId:intent.requestId,digest:intent.digest,postRevision:intent.postRevision,revision:apply.revision??null,rowIsPostImage:apply.rowIsPostImage??null,apply:apply.state,restore:restore.state,eligible,pins:approvedOf(pins)});
 return {eligible,digest,apply,restore};
}
async function recoverView(env){
 const pins=await readPins(env);
 const recorded=await readRecorded(env);
 const items=[];
 for(const id of REPAIR_COHORT){
  for(const entry of recorded.get(id)||[]){
   let classification,restore=null;
   try{const result=await recoverLocalizationReconcile(env,{intent:entry.intent});classification={state:result.state,reason:result.reason||null,revision:result.revision,rowIsPostImage:result.rowIsPostImage??null};}
   catch(error){classification={state:'unknown',reason:error?.code||'unclassified',revision:null,rowIsPostImage:null};}
   if(entry.state==='applied'||entry.state==='restored'){
    try{const proof=await restoreProof(env,entry.intent,pins);restore={state:proof.restore.state,eligible:proof.eligible,digest:proof.digest};}
    catch(error){restore={state:'unknown',eligible:false,digest:null,reason:error?.code||'unclassified'};}
   }
   items.push({id,requestId:entry.intent.requestId,digest:entry.intent.digest,recordedState:entry.state,events:entry.events.length,classification,...(restore?{restore}:{})});
  }
 }
 return {pins:publicPins(pins),items};
}

// args: {mode?:'preflight'|'recover'|'apply'|'restore' (omitted means preflight: only an explicit 'apply' or 'restore' can write), confirmGo?, expectedFilmPersonGeneration?, expectedSchemaVersion?,
// expectedOwnerReviewGeneration?, expectedOwnerReviewWrites?, expectedPlanAt?, expectedCount?, expectedDigest? (apply), filmId?, expectedRestoreDigest? (restore)}. Returns {status, body}.
export async function handleFilmLocalizationRepairTool(env,args={},{now}={}){
 if(!args||typeof args!=='object'||Array.isArray(args))return {status:400,body:{ok:false,reason:'invalid'}};
 const mode=args.mode===undefined?'preflight':args.mode;
 if(!REPAIR_MODES.includes(mode))return {status:400,body:{ok:false,reason:'invalid_mode'}};
 if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return {status:400,body:{ok:false,reason:'invalid_confirm'}};
 const clock=clockOf(now);
 if(mode==='preflight'||mode==='recover'){
  // A read-only mode accepts no write argument at all.
  if(args.confirmGo!==undefined||args.filmId!==undefined||Object.keys(args).some(name=>name.startsWith('expected')))return {status:400,body:{ok:false,reason:'invalid_arguments_for_read_only_mode'}};
  try{
   if(mode==='preflight')return {status:200,body:{ok:true,mode,sideEffects:'none',...publicView(await deriveCohort(env,{planAt:clock()}))}};
   return {status:200,body:{ok:true,mode,sideEffects:'none',...await recoverView(env)}};
  }catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable'}};}
 }
 if(args.confirmGo!==true)return {status:400,body:{ok:false,reason:'confirm_required'}};
 const pinArgsError=()=>{
  const generation=value=>Number.isInteger(value)&&value>=0;
  if(!generation(args.expectedFilmPersonGeneration))return 'invalid_expected_film_person_generation';
  if(!Number.isInteger(args.expectedSchemaVersion)||args.expectedSchemaVersion<1)return 'invalid_expected_schema_version';
  if(!generation(args.expectedOwnerReviewGeneration))return 'invalid_expected_owner_review_generation';
  if(!WRITES.includes(args.expectedOwnerReviewWrites))return 'invalid_expected_owner_review_writes';
  return null;
 };
 const wantedPins=()=>({filmPersonGeneration:args.expectedFilmPersonGeneration,schemaVersion:args.expectedSchemaVersion,ownerReviewGeneration:args.expectedOwnerReviewGeneration,ownerReviewWrites:args.expectedOwnerReviewWrites});
 if(mode==='restore'){
  if(!inCohort(args.filmId))return {status:400,body:{ok:false,reason:'invalid_film_id'}};
  const invalid=pinArgsError();
  if(invalid)return {status:400,body:{ok:false,reason:invalid}};
  if(typeof args.expectedRestoreDigest!=='string'||!HEX64.test(args.expectedRestoreDigest))return {status:400,body:{ok:false,reason:'invalid_expected_restore_digest'}};
  if(args.expectedPlanAt!==undefined||args.expectedCount!==undefined||args.expectedDigest!==undefined)return {status:400,body:{ok:false,reason:'invalid_arguments_for_restore'}};
  return restoreOne(env,args,wantedPins(),now);
 }
 if(args.filmId!==undefined||args.expectedRestoreDigest!==undefined)return {status:400,body:{ok:false,reason:'invalid_film_id_for_apply'}};
 const invalid=pinArgsError();
 if(invalid)return {status:400,body:{ok:false,reason:invalid}};
 if(typeof args.expectedPlanAt!=='string'||!ISO.test(args.expectedPlanAt)||!Number.isFinite(Date.parse(args.expectedPlanAt))||Date.parse(args.expectedPlanAt)>Date.parse(clock()))return {status:400,body:{ok:false,reason:'invalid_expected_plan_at'}};
 if(!Number.isInteger(args.expectedCount)||args.expectedCount<1||args.expectedCount>REPAIR_COHORT.length)return {status:400,body:{ok:false,reason:'invalid_expected_count'}};
 if(typeof args.expectedDigest!=='string'||!HEX64.test(args.expectedDigest))return {status:400,body:{ok:false,reason:'invalid_expected_digest'}};
 const wanted={...wantedPins(),planAt:args.expectedPlanAt,count:args.expectedCount,digest:args.expectedDigest};
 // The cohort and every intent are derived AGAIN, right now and at exactly the approved plan time; nothing is written unless the result equals the approved pins.
 const cohort=await deriveCohort(env,{planAt:args.expectedPlanAt});
 if(cohort.decision!=='eligible')return {status:409,body:{ok:false,reason:'not_eligible',writes:0,...publicView(cohort)}};
 const mismatched=Object.keys(wanted).filter(name=>cohort.expect[name]!==wanted[name]);
 if(mismatched.length)return {status:409,body:{ok:false,reason:'pins_mismatch',writes:0,mismatched,...publicView(cohort)}};
 return applyCohort(env,cohort,now);
}

async function applyCohort(env,cohort,now){
 const frozen=cohort.pins,approvedPins=approvedOf(frozen);
 const holds=async()=>{try{return pinKey(await readPins(env))===pinKey(frozen);}catch{return false;}};
 // Checked once more immediately before the first write; then before every Film and, through the approved pins, in the SAME batch as every receipt reservation and domain write.
 if(!(await holds()))return {status:409,body:{ok:false,reason:'state_moved',writes:0,...publicView(cohort)}};
 let port;
 try{port=repairCheckpoint(env);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable',writes:0}};}
 // applied: committed by this call and settled; recoveredThisCall: this call's own lost reply, proved applied from the receipt; alreadyApplied: an earlier run's recorded intent proved applied now (no new write);
 // notApplied: a definite no effect; unknown: an effect that cannot be proved either way; failed: stopped before any write; settleFailed: committed but not durably settled.
 const counts={applied:0,recoveredThisCall:0,alreadyApplied:0,skipped:0,notAttempted:0,notApplied:0,unknown:0,failed:0,settleFailed:0};
 const items=[];let stopped=null;
 const note=(found,state,extra={})=>items.push({id:found.id,state,...(found.intent?{requestId:found.intent.requestId,digest:found.intent.digest}:{}),...extra});
 const settle=async(found,body)=>{try{await port.settle(found.intent,body);return null;}catch(error){return error?.code||'checkpoint_settle_failed';}};
 for(const found of cohort.found){
  if(!ACTIONABLE.has(found.state)){counts.skipped++;note(found,found.state);continue;}
  if(stopped){counts.notAttempted++;note(found,'not_attempted',{reason:stopped});continue;}
  if(!(await holds())){stopped='state_moved';counts.notAttempted++;note(found,'not_attempted',{reason:stopped});continue;}
  try{
   if(found.state==='recorded'){
    // A recorded intent is never re-derived: the recovery classification decides. Durable settlement of a recovered outcome happens only here, inside the approved write envelope.
    const recovery=await recoverLocalizationReconcile(env,{intent:found.intent});
    if(recovery.state==='applied'){
     const error=await settle(found,{state:'applied',via:'recover'});
     counts.alreadyApplied++;
     if(error){counts.settleFailed++;stopped='settle_failed';note(found,'recovered_applied',{settleError:error});}else note(found,'recovered_applied');
     continue;
    }
    if(recovery.state!=='not_applied'){stopped='unknown_outcome';counts.unknown++;note(found,'unknown',{reason:recovery.reason||null});continue;}
   }
   const result=await resumeLocalizationReconcile(env,{intent:found.intent,checkpoint:port,now,approvedPins});
   if(result.state==='applied'){
    counts.applied++;
    if(result.settleError){counts.settleFailed++;stopped='settle_failed';note(found,'applied_unsettled',{settleError:result.settleError,revision:found.intent.postRevision});}
    else note(found,'applied',{revision:found.intent.postRevision});
    continue;
   }
   if(result.state==='not_applied'){counts.notApplied++;stopped='moved';note(found,'not_applied',{reason:result.errorClass||null});continue;}
   // An outcome the write path could not name: classified from DURABLE evidence (receipt, revision, row), never from the error text and never by a retry.
   let evidence;
   try{evidence=await recoverLocalizationReconcile(env,{intent:found.intent});}catch{evidence={state:'unknown'};}
   if(evidence.state==='applied'){
    const error=await settle(found,{state:'applied',via:'recover'});
    counts.recoveredThisCall++;stopped='recovered_after_lost_reply';
    if(error)counts.settleFailed++;
    note(found,'recovered_applied',{reason:result.errorClass||null,...(error?{settleError:error}:{})});
   }else if(evidence.state==='not_applied'){
    const error=await settle(found,{state:'not_applied',errorClass:result.errorClass||null,via:'recover'});
    counts.notApplied++;stopped='no_effect';if(error)counts.settleFailed++;
    note(found,'not_applied',{reason:result.errorClass||null,...(error?{settleError:error}:{})});
   }else{counts.unknown++;stopped='unknown_outcome';note(found,'unknown',{reason:result.errorClass||evidence.reason||null});}
  }catch(error){stopped='previous_film_failed';counts.failed++;note(found,'failed',{reason:error?.code||'unclassified'});}
 }
 // Current scoped acceptance of ALL 16 Films (earlier applied, skipped, noop and restored included), from D1 and never from the history alone.
 const after=await deriveCohort(env,{planAt:cohort.expect.planAt});
 const readable=!after.failure;
 const readback={readable,failure:after.failure||null,accepted:readable&&after.found.every(found=>ACCEPTED.has(found.state)),counts:after.counts,items:after.items.map(item=>({id:item.id,state:item.state,...(item.current?{current:item.current}:{})}))};
 const provedWrites=counts.applied+counts.recoveredThisCall;
 const complete=!stopped&&counts.failed===0&&counts.unknown===0&&counts.notApplied===0&&counts.settleFailed===0&&readback.accepted;
 return {status:200,body:{ok:complete,mode:'apply',outcome:complete?'complete':'partial',writes:counts.unknown>0?null:provedWrites,provedWrites,uncertainEffects:counts.unknown,counts,items,stopped,readback,pins:publicPins(frozen),expectedDigest:cohort.expect.digest}};
}

// RESTORE of ONE Film from its recorded intent. Separately gated (confirmGo) and approved against a FRESH, intent-specific proof: the pins and the `restore.digest` the read-only `recover` mode returns for that
// intent. The pins are asserted at the restore receipt's reservation and in its batch. The delivered restore applies only while the Film is still at exactly the recorded post-revision with the row equal to the
// post-image. A restore is recovered by ITS OWN receipt: a lost reply or lost settlement is classified, never retried blind, and `writes` is a number only when proved.
async function restoreOne(env,args,wanted,now){
 let pins,recorded;
 try{pins=await readPins(env);recorded=await readRecorded(env);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable',writes:0}};}
 if(!pins.ready)return {status:409,body:{ok:false,reason:'authority_not_ready',writes:0,pins:publicPins(pins)}};
 const mismatched=Object.keys(wanted).filter(name=>approvedOf(pins)[name]!==wanted[name]);
 if(mismatched.length)return {status:409,body:{ok:false,reason:'pins_mismatch',writes:0,mismatched,pins:publicPins(pins)}};
 const entries=recorded.get(args.filmId)||[];
 const entry=entries.find(candidate=>candidate.state==='applied')||entries.find(candidate=>candidate.state==='restored');
 if(!entry)return {status:409,body:{ok:false,reason:'no_applied_intent',writes:0}};
 let proof;
 try{proof=await restoreProof(env,entry.intent,pins);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'unclassified',writes:0}};}
 if(proof.digest!==args.expectedRestoreDigest)return {status:409,body:{ok:false,reason:'restore_proof_mismatch',writes:0,restore:{state:proof.restore.state,eligible:proof.eligible,digest:proof.digest}}};
 const port=repairCheckpoint(env);
 const settled=async()=>{try{await port.settle(entry.intent,{state:'restored',via:'restore'});return null;}catch(error){return error?.code||'checkpoint_settle_failed';}};
 const requestId=proof.restore.requestId;
 // The restore receipt is already applied: nothing is written again, only the durable settlement is completed.
 if(proof.restore.state==='applied'){
  const settleError=entry.state==='restored'?null:await settled();
  return {status:200,body:{ok:settleError===null,mode:'restore',id:args.filmId,state:'restored',alreadyApplied:true,writes:0,requestId,settleError}};
 }
 if(!proof.eligible)return {status:409,body:{ok:false,reason:proof.restore.state==='unknown'?'restore_unknown':'localization_restore_moved',writes:0,id:args.filmId,restore:{state:proof.restore.state}}};
 let committed=false,errorCode=null;
 try{
  const outcome=await restoreLocalizationReconcile(env,{runId:REPAIR_RESTORE_RUN_ID,token:entry.intent,now,approvedPins:approvedOf(pins)});
  committed=outcome?.state==='applied';
  if(!committed)errorCode=outcome?.errorClass||outcome?.reason||outcome?.state||'unclassified';
 }catch(error){errorCode=error?.code||'unclassified';}
 // Whatever the write path answered, the effect is re-proved from the restore receipt and the revision.
 let after;
 try{after=await recoverRestoreLocalization(env,{intent:entry.intent,runId:REPAIR_RESTORE_RUN_ID});}catch{after={state:'unknown'};}
 if(after.state==='applied'){
  const settleError=await settled();
  return {status:200,body:{ok:settleError===null,mode:'restore',id:args.filmId,state:'restored',writes:1,recoveredAfterError:!committed,requestId,settleError}};
 }
 if(after.state==='not_applied'||after.state==='moved')return {status:409,body:{ok:false,reason:errorCode||'restore_not_applied',writes:0,id:args.filmId,restore:{state:after.state}}};
 return {status:409,body:{ok:false,reason:'restore_unknown',writes:null,id:args.filmId,error:errorCode,restore:{state:after.state}}};
}
