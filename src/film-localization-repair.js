// AIR-664 (ADR 0225, Proposed). The ONE-OFF, owner-only operation that repairs the 16 Film localization rows the AIR-683 census found stale. It is the body of the MCP tool `film_localization_repair`,
// reached only through the existing owner-only MCP gate (Cloudflare Access plus the signed JWT). It adds no route, binding, migration, table, bucket, Cron, Task, Workflow, queue or batch API.
// - FIXED COHORT: the 16 Film ids are a constant of this module. The caller supplies no Film id (restore takes one id and refuses any that is not in the constant), no key, no SQL, no intent body.
// - NO NEW RESOLVER OR WRITER: every Film goes through the delivered AIR-663 exact-intent path: `readReconcileIntent` (read only, fixed run id and write time, so the digest is reproducible),
//   `resumeLocalizationReconcile` (record BEFORE the write, one receipted atomic fenced batch, settle after), `recoverLocalizationReconcile` (read only) and `restoreLocalizationReconcile`
//   (exact recorded post-revision and pre-image). The replanning `applyLocalizationReconcile` pass is not used.
// - CHECKPOINT = the existing private R2 bucket, one isolated prefix: immutable intent objects and immutable, sequence-numbered outcome events, each created with a conditional put that cannot overwrite.
//   After a precondition failure, a timeout or an error the object is read back and compared IN FULL: equal is an idempotent success, different is `checkpoint_conflict`, unreadable or absent counts as
//   NOT recorded and nothing is written. R2 holds recovery artifacts only; canonical D1 stays the authority. R2 and D1 are not atomic: the receipt and the recorded intent close that gap (recover).
// - PINS: the approved Film/Person generation and owner-review generation are checked before the first write, before every Film, and INSIDE every fenced batch (extra guards). A mismatch writes nothing.
// - RESPONSES carry counts, states, Film ids, request ids, digests and pins. Never an intent body, a localization value or an R2 key.
// A merge of this module or the tool listing is NOT a production GO: `confirmGo` is a technical safeguard, the owner's separate explicit GO on the preflight pins is the authority.
import {database,failed,one,readAuthority} from './film-person-authority.js';
import {canonicalJson,digestOf} from './canonical-receipts.js';
import {checkIntent,readReconcileIntent,recoverLocalizationReconcile,restoreLocalizationReconcile,resumeLocalizationReconcile} from './film-localization-reconciler.js';

// The 16 Film ids observed stale by the AIR-683 live census (27 November 2026). Sorted in code-unit order; the operation never adds to it.
export const REPAIR_COHORT=Object.freeze(['film:1XYA','film:27iE','film:28R6','film:DCVQ','film:MYia','film:QGFo','film:R9dS','film:RTwc','film:RfZI','film:iXBq','film:jGuE','film:tmdb:101669','film:tmdb:516486','film:tmdb:649409','film:vCu0','film:xG0M']);
// Fixed run id and write time: the intent digest is reproducible for an unchanged state, so a preflight digest can be compared with the one derived again at the write boundary.
export const REPAIR_RUN_ID='air664-localization-repair-1';
export const REPAIR_RESTORE_RUN_ID='air664-localization-restore-1';
export const REPAIR_AT='2026-11-27T23:00:00.000Z';
export const REPAIR_PREFIX='film-localization-repair/air-664/';
export const REPAIR_MODES=Object.freeze(['preflight','recover','apply','restore']);
const HEX64=/^[0-9a-f]{64}$/;
const KEY_PART=/^[A-Za-z0-9_.:-]{1,200}$/;
const TRANSITIONS={recorded:['applied','not_applied','unknown'],not_applied:['applied','not_applied','unknown'],unknown:['applied','not_applied','unknown'],applied:['restored'],restored:[]};
const ACTIONABLE=new Set(['eligible','recorded']);
const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by;};
const inCohort=id=>typeof id==='string'&&REPAIR_COHORT.includes(id);

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
async function readEvents(bucket,requestId){
 const keys=await listKeys(bucket,eventPrefix(requestId));
 const events=[];
 for(let at=0;at<keys.length;at++){
  if(keys[at]!==eventKey(requestId,at+1))throw failed('checkpoint_corrupt');
  const event=await readJson(bucket,keys[at]);
  if(!event||event.requestId!==requestId||event.seq!==at+1||!TRANSITIONS[event.state]||event.state==='recorded')throw failed('checkpoint_corrupt');
  events.push(event);
 }
 return events;
}
const stateOfEvents=events=>events.length?events.at(-1).state:'recorded';
const withoutSeq=event=>canonicalJson({...event,seq:undefined});
// Appends ONE outcome event. The same event again is an idempotent success; a transition the table forbids is refused; a lost sequence race is compared in full and retried once.
async function appendEvent(bucket,intent,body){
 const event={version:1,requestId:intent.requestId,digest:intent.digest,state:body.state,errorClass:body.errorClass??null,receiptState:body.receiptState??null,revision:Number.isInteger(body.revision)?body.revision:null,via:body.via||'apply'};
 const recorded=await readJson(bucket,intentKey(intent.requestId));
 if(recorded===null||canonicalJson(recorded)!==canonicalJson(intent))throw failed('checkpoint_not_recorded');
 for(let attempt=0;attempt<2;attempt++){
  const events=await readEvents(bucket,intent.requestId);
  const last=events.at(-1);
  if(last&&withoutSeq(last)===canonicalJson(event))return last.seq;
  if(!TRANSITIONS[stateOfEvents(events)]?.includes(event.state))throw failed('checkpoint_transition_refused');
  const seq=events.length+1;
  try{await createOnce(bucket,eventKey(intent.requestId,seq),{...event,seq});return seq;}
  catch(error){if(error?.code==='checkpoint_conflict'&&attempt===0)continue;throw error;}
 }
 throw failed('checkpoint_conflict');
}
const scoped=intent=>inCohort(intent.id)&&intent.runId===REPAIR_RUN_ID&&intent.at===REPAIR_AT;
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
// Every recorded intent of the operation with its outcome events: Map(filmId -> [{intent,events,state}]). Fails closed on anything outside the cohort or the fixed run.
async function readRecorded(env){
 const bucket=bucketOf(env);
 const out=new Map();
 for(const key of await listKeys(bucket,intentPrefix)){
  const intent=await checkIntent(await readJson(bucket,key));
  if(!scoped(intent)||key!==intentKey(intent.requestId))throw failed('checkpoint_corrupt');
  const events=await readEvents(bucket,intent.requestId);
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
 pins.ready=pins.filmPersonState==='open'&&pins.ownerReviewMode==='d1'&&['open','held'].includes(pins.ownerReviewWrites);
 return pins;
}
const pinKey=pins=>canonicalJson({a:pins.filmPersonGeneration,b:pins.schemaVersion,c:pins.ownerReviewGeneration,d:pins.ready});
const guardsOf=pins=>[
 {sql:"EXISTS (SELECT 1 FROM film_person_authority WHERE id=1 AND mode='d1' AND cutover='open' AND generation=?)",params:[pins.filmPersonGeneration]},
 {sql:"EXISTS (SELECT 1 FROM owner_review_authority WHERE id=1 AND mode='d1' AND generation=?)",params:[pins.ownerReviewGeneration]},
];
const publicPins=pins=>({filmPersonState:pins.filmPersonState,filmPersonGeneration:pins.filmPersonGeneration,schemaVersion:pins.schemaVersion,ownerReviewMode:pins.ownerReviewMode,ownerReviewWrites:pins.ownerReviewWrites,ownerReviewGeneration:pins.ownerReviewGeneration});

// ---- the cohort, derived now (read only) ----
// Per Film: applied (an intent of this operation is applied and not restored), restored, recorded (an intent is recorded with no applied outcome: it must be recovered, never re-derived), or a fresh derive:
// eligible (an exact intent), noop (already current), held, absent, unavailable.
async function inspectFilm(env,id,recorded){
 const entries=recorded.get(id)||[];
 const applied=entries.find(entry=>entry.state==='applied');
 if(applied)return {id,state:'applied',intent:applied.intent,entry:applied};
 if(entries.some(entry=>entry.state==='restored'))return {id,state:'restored',intent:entries.find(entry=>entry.state==='restored').intent};
 const open=entries.filter(entry=>entry.state==='recorded'||entry.state==='unknown');
 if(open.length>1)return {id,state:'unavailable',code:'multiple_open_intents'};
 if(open.length===1)return {id,state:'recorded',intent:open[0].intent,entry:open[0]};
 try{
  const {intent,plan}=await readReconcileIntent(env,id,{runId:REPAIR_RUN_ID,at:REPAIR_AT});
  if(intent)return {id,state:'eligible',intent};
  return {id,state:plan.state==='held'?'held':plan.state==='absent'?'absent':'noop',reason:plan.reason||null};
 }catch(error){return {id,state:'unavailable',code:error?.code||'unclassified'};}
}
async function deriveCohort(env){
 const out={decision:'unsafe',pins:null,counts:{cohort:REPAIR_COHORT.length,eligible:0,recorded:0,applied:0,restored:0,noop:0,held:0,absent:0,unavailable:0},heldByReason:{},unavailableByCode:{},items:[],expect:null,found:[]};
 let pins,recorded;
 try{pins=await readPins(env);}catch(error){out.decision=['film_person_held','film_person_not_open'].includes(error?.code)?'unsafe':'unknown';out.failure=error?.code||'film_person_unavailable';return out;}
 out.pins=pins;
 if(!pins.ready){out.failure=pins.filmPersonState!=='open'?'localization_authority_not_open':'localization_owner_unavailable';return out;}
 try{recorded=await readRecorded(env);}catch(error){out.decision='unknown';out.failure=error?.code||'checkpoint_unavailable';return out;}
 for(const id of REPAIR_COHORT){
  const found=await inspectFilm(env,id,recorded);
  out.found.push(found);
  bump(out.counts,found.state);
  if(found.state==='held')bump(out.heldByReason,found.reason||'unclassified');
  if(found.state==='unavailable')bump(out.unavailableByCode,found.code);
  out.items.push({id,state:found.state,...(found.intent?{requestId:found.intent.requestId,digest:found.intent.digest,plannedRevision:found.intent.plannedRevision}:{}),...(found.entry?{recordedState:found.entry.state}:{})});
 }
 const lines=out.found.map(found=>found.id+':'+found.state+':'+(found.intent?.digest||'')+':'+(found.entry?.state||''));
 const actionable=out.found.filter(found=>ACTIONABLE.has(found.state)).length;
 out.expect={filmPersonGeneration:pins.filmPersonGeneration,ownerReviewGeneration:pins.ownerReviewGeneration,count:actionable,digest:await digestOf(lines)};
 const blocked=out.counts.held+out.counts.absent+out.counts.unavailable>0;
 out.decision=blocked?'blocked':actionable?'eligible':'nothing_to_do';
 // The authority snapshot must still be the one read at the start; a moved pin makes the pins unusable.
 let again;
 try{again=await readPins(env);}catch(error){out.decision='unknown';out.failure=error?.code||'film_person_unavailable';out.expect=null;return out;}
 if(pinKey(again)!==pinKey(pins)){out.decision='unknown';out.failure='state_moved_during_read';out.expect=null;}
 return out;
}
const publicView=cohort=>({decision:cohort.decision,failure:cohort.failure||null,cohort:cohort.counts.cohort,counts:cohort.counts,heldByReason:cohort.heldByReason,unavailableByCode:cohort.unavailableByCode,items:cohort.items,pins:cohort.pins?publicPins(cohort.pins):null,expect:cohort.expect});

// ---- recover (read only) ----
async function recoverView(env){
 const recorded=await readRecorded(env);
 const items=[];
 for(const id of REPAIR_COHORT){
  for(const entry of recorded.get(id)||[]){
   let classification;
   try{const result=await recoverLocalizationReconcile(env,{intent:entry.intent});classification={state:result.state,reason:result.reason||null,revision:result.revision,rowIsPostImage:result.rowIsPostImage??null};}
   catch(error){classification={state:'unknown',reason:error?.code||'unclassified',revision:null,rowIsPostImage:null};}
   items.push({id,requestId:entry.intent.requestId,digest:entry.intent.digest,recordedState:entry.state,events:entry.events.length,classification});
  }
 }
 return items;
}

// args: {mode?:'preflight'|'recover'|'apply'|'restore' (omitted means preflight: only an explicit 'apply' or 'restore' can write), confirmGo?, expectedFilmPersonGeneration?, expectedOwnerReviewGeneration?,
// expectedCount?, expectedDigest?, filmId? (restore only)}. Returns {status, body}.
export async function handleFilmLocalizationRepairTool(env,args={},{now}={}){
 if(!args||typeof args!=='object'||Array.isArray(args))return {status:400,body:{ok:false,reason:'invalid'}};
 const mode=args.mode===undefined?'preflight':args.mode;
 if(!REPAIR_MODES.includes(mode))return {status:400,body:{ok:false,reason:'invalid_mode'}};
 if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return {status:400,body:{ok:false,reason:'invalid_confirm'}};
 if(mode==='preflight'||mode==='recover'){
  // A read-only mode accepts no write argument at all.
  if(args.confirmGo!==undefined||args.filmId!==undefined||Object.keys(args).some(name=>name.startsWith('expected')))return {status:400,body:{ok:false,reason:'invalid_arguments_for_read_only_mode'}};
  try{
   if(mode==='preflight')return {status:200,body:{ok:true,mode,sideEffects:'none',...publicView(await deriveCohort(env))}};
   return {status:200,body:{ok:true,mode,sideEffects:'none',items:await recoverView(env)}};
  }catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable'}};}
 }
 if(args.confirmGo!==true)return {status:400,body:{ok:false,reason:'confirm_required'}};
 if(mode==='restore')return restoreOne(env,args,now);
 const generation=value=>Number.isInteger(value)&&value>=0;
 if(args.filmId!==undefined)return {status:400,body:{ok:false,reason:'invalid_film_id_for_apply'}};
 if(!generation(args.expectedFilmPersonGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_film_person_generation'}};
 if(!generation(args.expectedOwnerReviewGeneration))return {status:400,body:{ok:false,reason:'invalid_expected_owner_review_generation'}};
 if(!Number.isInteger(args.expectedCount)||args.expectedCount<1||args.expectedCount>REPAIR_COHORT.length)return {status:400,body:{ok:false,reason:'invalid_expected_count'}};
 if(typeof args.expectedDigest!=='string'||!HEX64.test(args.expectedDigest))return {status:400,body:{ok:false,reason:'invalid_expected_digest'}};
 const wanted={filmPersonGeneration:args.expectedFilmPersonGeneration,ownerReviewGeneration:args.expectedOwnerReviewGeneration,count:args.expectedCount,digest:args.expectedDigest};
 // The cohort and every intent are derived AGAIN, right now; nothing is written unless the result equals the approved pins.
 const cohort=await deriveCohort(env);
 if(cohort.decision!=='eligible')return {status:409,body:{ok:false,reason:'not_eligible',writes:0,...publicView(cohort)}};
 const mismatched=Object.keys(wanted).filter(name=>cohort.expect[name]!==wanted[name]);
 if(mismatched.length)return {status:409,body:{ok:false,reason:'pins_mismatch',writes:0,mismatched,...publicView(cohort)}};
 return applyCohort(env,cohort,now);
}

async function applyCohort(env,cohort,now){
 const frozen=cohort.pins;
 const holds=async()=>{try{return pinKey(await readPins(env))===pinKey(frozen);}catch{return false;}};
 // Checked once more immediately before the first write; then before every Film and, through the extra guards, INSIDE every fenced batch.
 if(!(await holds()))return {status:409,body:{ok:false,reason:'state_moved',writes:0,...publicView(cohort)}};
 let port;
 try{port=repairCheckpoint(env);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable',writes:0}};}
 const extraGuards=guardsOf(frozen);
 const counts={applied:0,recovered:0,skipped:0,notAttempted:0,notApplied:0,unknown:0,failed:0};
 const items=[];let stopped=null;
 const note=(found,state,extra={})=>items.push({id:found.id,state,...(found.intent?{requestId:found.intent.requestId,digest:found.intent.digest}:{}),...extra});
 for(const found of cohort.found){
  if(!ACTIONABLE.has(found.state)){counts.skipped++;note(found,found.state);continue;}
  if(stopped){counts.notAttempted++;note(found,'not_attempted',{reason:stopped});continue;}
  if(!(await holds())){stopped='state_moved';counts.notAttempted++;note(found,'not_attempted',{reason:stopped});continue;}
  try{
   let result=null;
   if(found.state==='recorded'){
    // A recorded intent is never re-derived: the recovery classification decides. Durable settlement of a recovered outcome happens only here, inside the approved write envelope.
    const recovery=await recoverLocalizationReconcile(env,{intent:found.intent});
    if(recovery.state==='applied'){
     await port.settle(found.intent,{state:'applied',revision:found.intent.postRevision,via:'recover'});
     counts.recovered++;note(found,'recovered_applied');continue;
    }
    if(recovery.state!=='not_applied'){stopped='unknown_outcome';counts.unknown++;note(found,'unknown',{reason:recovery.reason||null});continue;}
   }
   result=await resumeLocalizationReconcile(env,{intent:found.intent,checkpoint:port,now,extraGuards});
   if(result.settleError){stopped='settle_failed';counts.failed++;note(found,'failed',{reason:result.settleError});continue;}
   if(result.state==='applied'){counts.applied++;note(found,'applied',{revision:found.intent.postRevision});continue;}
   if(result.state==='not_applied'){stopped='moved';counts.notApplied++;note(found,'not_applied',{reason:result.errorClass||null});continue;}
   stopped='unknown_outcome';counts.unknown++;note(found,'unknown',{reason:result.errorClass||null});
  }catch(error){stopped='previous_film_failed';counts.failed++;note(found,'failed',{reason:error?.code||'unclassified'});}
 }
 // Scoped readback: the same read-only derive. A Film applied by this operation reads `applied`; one the resolver would still rewrite would read `eligible` (not stale-free).
 const after=await readback(env,items);
 const done=counts.applied+counts.recovered;
 const complete=!stopped&&counts.failed===0&&counts.unknown===0&&counts.notApplied===0&&after.staleAfter===0&&after.unverified===0;
 return {status:200,body:{ok:complete,mode:'apply',outcome:complete?'complete':'partial',writes:counts.applied,applied:done,counts,items,stopped,readback:after,pins:publicPins(frozen),expectedDigest:cohort.expect.digest}};
}
// Per applied Film: the receipt is applied at exactly the post-revision, the stored row is the post-image, and the resolver reports it current (noop).
async function readback(env,items){
 const out={verified:0,unverified:0,staleAfter:0,rowIsPostImage:0,unreadable:false};
 let recorded;
 try{recorded=await readRecorded(env);}catch{out.unreadable=true;out.unverified=items.filter(item=>item.state==='applied'||item.state==='recovered_applied').length;return out;}
 for(const item of items){
  if(item.state!=='applied'&&item.state!=='recovered_applied')continue;
  const entry=(recorded.get(item.id)||[]).find(candidate=>candidate.state==='applied');
  if(!entry){out.unverified++;continue;}
  try{
   const recovery=await recoverLocalizationReconcile(env,{intent:entry.intent});
   const again=await readReconcileIntent(env,item.id,{runId:REPAIR_RUN_ID,at:REPAIR_AT});
   if(recovery.state==='applied'&&recovery.rowIsPostImage){out.rowIsPostImage++;}
   if(recovery.state==='applied'&&again.intent===null&&again.plan.state==='noop')out.verified++;
   else{out.unverified++;if(again.intent)out.staleAfter++;}
  }catch{out.unverified++;}
 }
 return out;
}

// RESTORE of ONE Film from its recorded, applied intent. Separately gated (confirmGo). The delivered restore binds the intent to its own applied receipt and applies only while the Film is at exactly
// the recorded post-revision with the row still equal to the post-image; otherwise it writes nothing (`localization_restore_moved`) and the alternative is a separately approved forward correction.
async function restoreOne(env,args,now){
 if(!inCohort(args.filmId))return {status:400,body:{ok:false,reason:'invalid_film_id'}};
 for(const name of Object.keys(args))if(name.startsWith('expected'))return {status:400,body:{ok:false,reason:'invalid_arguments_for_restore'}};
 let recorded,pins;
 try{pins=await readPins(env);recorded=await readRecorded(env);}catch(error){return {status:503,body:{ok:false,reason:error?.code||'checkpoint_unavailable',writes:0}};}
 if(!pins.ready)return {status:409,body:{ok:false,reason:'authority_not_ready',writes:0,pins:publicPins(pins)}};
 const entry=(recorded.get(args.filmId)||[]).find(candidate=>candidate.state==='applied');
 if(!entry)return {status:409,body:{ok:false,reason:'no_applied_intent',writes:0}};
 let outcome;
 try{outcome=await restoreLocalizationReconcile(env,{runId:REPAIR_RESTORE_RUN_ID,token:entry.intent,now});}
 catch(error){return {status:409,body:{ok:false,reason:error?.code||'unclassified',writes:0,id:args.filmId}};}
 if(outcome?.state!=='applied')return {status:409,body:{ok:false,reason:outcome?.errorClass||outcome?.reason||outcome?.state||'unclassified',state:outcome?.state||null,id:args.filmId}};
 let settleError=null;
 try{await repairCheckpoint(env).settle(entry.intent,{state:'restored',revision:entry.intent.postRevision+1,via:'restore'});}catch(error){settleError=error?.code||'checkpoint_settle_failed';}
 return {status:200,body:{ok:settleError===null,mode:'restore',id:args.filmId,state:'restored',writes:1,requestId:outcome.requestId,settleError}};
}
