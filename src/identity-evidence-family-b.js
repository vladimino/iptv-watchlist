// AIR-622 / ADR 0215 (Accepted), card E3b: family (b), the Discovery history, mapped to identity evidence rows for the manifest-bound import path (src/identity-evidence-import.js, ER).
// DORMANT: nothing in the Worker imports this module, it is not bundled, and no route, Workflow, cron or producer calls it. It READS nothing but what a caller hands it or what
// `readFamilyBSources` selects through a database handle; it writes nothing and moves no Film revision. A dry run on production needs its own owner read approval, the import its own
// owner decision naming the manifest digest and an L3 GO (ADR 0215 decision 7). Nothing here authorizes either.
//
// The rules are those of ADR 0213 decision 6 and ADR 0215 Table 4: a reconstructed row uses the SAME mapping as its live writer (`decisionEvidenceInput` of E2a and
// `planOwnerEvidence` of E2c are called, never copied), so a live and a reconstructed row of one fact share an evidence key whenever the root is known; nothing is invented; an unknown
// stays unknown (a null time, a null `source_order`); a row without a recorded method is no row. The families below:
//   b1  `verified` + `identitySource: 'tmdb_detail'`                 -> E2a row, time from the payload `checkedAt` (never `written_at`)
//   b2  `verified` + `known_epg_alias` / `known_alias_year_runtime`  -> E2a row, method `known_alias`, variant in `source_scope`
//   b3  `verified` with no `identitySource`                          -> no row, reported by count (distinct pairs)
//   b4  owner actions (`identity_assign`, `identity_reject`, `identity_revoke`)  -> E2c rows, root = the intent key (see the dependency rule below)
//   b5  pre-D1 R2 `admin/actions/discovery_identity_correct/v1/`     -> E2c row only from a terminal record that states effect, movie, observation and key; else no row, counted
//   b6  policy exclusions, reconsiders, deferrals, non-verified      -> no row, counted
//   b7  observations, `confirmed_tmdb_id`, admissions                -> no row, counted
//
// THE COHORT, per source (ADR 0215 decision 7, step 1: each source freezes the exact list it read; no cross-store snapshot). Append-only history is in or out by its own `written_at`
// (a later or backdated row is a reported late arrival); mutable D1 rows (a current decision, an intent receipt) are frozen as read and are in the cohort only through the coherent D1
// acquisition (`issued.confirmedAt` is the issue time and can only exclude); an R2 object is in by its own `finishedAt`, or, untimed, only through the frozen R2 listing the operator captured.
// No fallback reinterprets a late record: a current decision is used only for an observation with NO history row at all, and an owner action whose history row is late, unprovable or
// ambiguous is reported, never read as "no history". A record whose membership cannot be proven is `cohort_unprovable`: excluded and reported, never guessed. `readFamilyBSources` fences its D1
// acquisition with the Discovery authority generation read before and after the paged reads (every Discovery write moves it); an incoherent one makes `dryRunFamilyB` refuse a manifest.
//
// THE DEPENDENCY RULE. A staged row's source pins what the row consumes, in the same atomic chunk (ER, ADR 0215 decision 7 and its `requires` amendment: a D1 source may name up to
// three more rows it depends on, each asserted by its own statement in the same batch):
//   - an owner action linked to its history row: the intent is the source (`command`, `issued.confirmedAt`, the receipt association, a revoke's nested `revokes.*`, a replacement's
//     `supersedes`) and the history row is REQUIRED (its revision is the `source_order`, an assign's `ownerIdentity` its time);
//   - a replacement also requires the superseded intent (its effect, key and movie), for the scoped withdrawal it yields; when that intent is not in the source the WHOLE action is unresolved;
//   - an owner action whose receipt hash no owner history row carries (genuinely history-less): its intent alone, order unknown;
//   - an owner assign recorded in a history row that no intent names: that row alone (`ownerIdentity.*`, its revision);
//   - b1 / b2 / a history-less decision: the row and every payload field the mapping reads; an R2 action: the whole object, pinned by its ETag.
// The receipt-to-payload hash association itself cannot be asserted (ER has no SQL hash): the pinned fields stand for it.
import {decisionEvidenceInput,decisionHash} from './discovery-authority.js';
import {planOwnerEvidence} from './discovery-owner-evidence.js';
import {normalizeEvidence} from './identity-evidence.js';

export const FAMILY='b';
// The writers of `discovery_decision_history` that are not an automated decision path: the owner writers (their rows are b4, never b1/b2) and the writers that state no identity (b6).
export const OWNER_WRITERS=Object.freeze(['owner','discovery_identity_correct','discovery_identity_revoke']);
export const NON_IDENTITY_WRITERS=Object.freeze(['catalog_policy_exclude','discovery_reconsider']);
export const R2_ACTION_PREFIX='admin/actions/discovery_identity_correct/v1/';
const KIND_EFFECT=Object.freeze({identity_assign:'assign',identity_reject:'reject',identity_revoke:'revoke'});
// Used ONLY inside the live planners, which refuse a missing time or order; it never reaches a staged row (every row's time and order are overwritten by the known value or null).
const PLACEHOLDER_TIME='1970-01-01T00:00:00.000Z';
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parse=text=>{try{return JSON.parse(text);}catch{return undefined;}};
const scalarOf=value=>value===null||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value));
const instantOf=value=>typeof value==='string'&&ISO.test(value)&&Number.isFinite(Date.parse(value))?value:null;
const bump=(map,key,by=1)=>map.set(key,(map.get(key)||0)+by);
const obj=map=>Object.fromEntries([...map].sort(([a],[b])=>a<b?-1:a>b?1:0));
const compare=(a,b)=>a<b?-1:a>b?1:0;
const sum=map=>[...map.values()].reduce((total,value)=>total+value,0);

// The raw input form of a normalized row, as `planManifest` takes it (origin, run and source are set by the import path).
const rawOf=row=>({subject:{kind:row.subjectKind,value:row.subjectValue},relation:row.relation,object:row.objectKind===null?null:{kind:row.objectKind,value:row.objectValue},polarity:row.polarity,
 route:row.route,method:row.method,sourceRoot:row.sourceRoot,sourceRef:row.sourceRef,sourceScope:row.sourceScope,scopeEvidenceKey:row.scopeEvidenceKey,supersedesKey:row.supersedesKey,
 observedAt:row.observedAt,sourceOrder:row.sourceOrder});
// Whether a raw input is a valid RECONSTRUCTED row (an unknown time or order is allowed there, never on a live row). Returns the reason on refusal, null when valid.
function acceptable(input){
 try{normalizeEvidence({...input,origin:'reconstruction',reconstructionRun:'probe',reconstructedFrom:'probe'});return null;}
 catch(error){if(error?.code==='identity_evidence_invalid')return error.reason||'invalid';throw error;}
}

// ---- b1 / b2 (and the b3 / b6 reports): one decision payload ----
// Returns {input,source,timeUnknown} (a raw evidence input), or {none:<reason>}. A payload time that is missing or not a valid instant gives a null time, never a guess.
export function mapDecision(key,payload){
 if(!plain(payload))return {none:'payload_unreadable'};
 if(payload.status!=='verified')return {none:'not_verified'};
 const source=payload.identitySource;
 if(source===undefined||source===null||source==='')return {none:'no_identity_source'};
 if(source==='owner')return {none:'owner_source'};
 const input=decisionEvidenceInput(key,payload);
 if(!input)return {none:payload.tmdbId==null?'no_tmdb_id':'other_source'};
 const absent=input.observedAt===undefined||input.observedAt===null;
 const reason=acceptable(input);
 if(reason){const unknownTime={...input,observedAt:null};if(!acceptable(unknownTime))return {input:unknownTime,timeUnknown:true,source};return {none:'unrecordable',reason};}
 return {input:absent?{...input,observedAt:null}:input,timeUnknown:absent,source};
}
const GUARD_PATHS=Object.freeze(['status','identitySource','tmdbId','checkedAt','id','canonicalIdentity','mediaType','kind']);
// The guard fields a decision payload source pins: every field the mapping reads. A non-scalar value cannot be pinned (the record is then refused, not imported unguarded).
function payloadGuard(column,payload,names=GUARD_PATHS){
 const guard={};
 for(const name of names){
  const value=name.split('.').reduce((current,part)=>plain(current)?current[part]:undefined,payload);
  const normal=value===undefined?null:value;
  if(!scalarOf(normal))return null;
  guard[column+'#$.'+name]=normal;
 }
 return guard;
}
const historyKey=row=>({observation_key:row.observation_key,revision:Number(row.revision)});
const historyBase=row=>({writer:row.writer,written_at:row.written_at});
const decisionHistorySource=(row,payload)=>{const guard=payloadGuard('payload_json',payload);return guard&&{table:'discovery_decision_history',key:historyKey(row),guard:{...historyBase(row),...guard}};};
const OWNER_GUARD_PATHS=Object.freeze(['ownerIdentity.effect','ownerIdentity.tmdbId','ownerIdentity.requestId','ownerIdentity.at']);
const ownerHistorySource=(row,payload)=>{const guard=payloadGuard('payload_json',payload,OWNER_GUARD_PATHS);return guard&&{table:'discovery_decision_history',key:historyKey(row),guard:{...historyBase(row),...guard}};};
// A current decision is guarded by its stored hash AND by the payload fields the mapping reads: ER has no SQL hash, so a payload-only change under an unchanged stored hash is detected only by these.
const decisionSource=(row,payload)=>{const guard=payloadGuard('payload_json',payload);return guard&&{table:'discovery_decision',key:{observation_key:row.observation_key},guard:{decision_hash:row.decision_hash,...guard}};};

// ---- b4: owner intents ----
const intentOf=row=>({kind:row.kind,idempotencyKey:row.idempotency_key,observationKey:row.observation_key,state:row.state,command:parse(row.command_json),
 issued:row.issued_json==null?null:parse(row.issued_json),receipt:row.receipt_json==null?null:parse(row.receipt_json)});
// The link between an intent and its history row. The candidates are EVERY owner-writer history row of the observation, whatever its membership. `none`: none carries the receipt's
// hash (a genuinely history-less action); `linked`: exactly one, in the cohort; `late` / `unprovable`: exactly one, outside the cohort or with an unprovable time; `ambiguous`: several.
// Only `none` may be read as "no history"; the others are reported and never fall through to an unlinked, unknown-order action.
async function linkOf(intent,candidates){
 const wanted=intent.receipt?.decisionHash;
 if(typeof wanted!=='string')return {status:'none'};
 const found=[];
 for(const item of candidates)if(await decisionHash(item.payload)===wanted)found.push(item);
 if(found.length===0)return {status:'none'};
 if(found.length>1)return {status:'ambiguous',items:found};
 const [item]=found;
 return {status:item.member==='in'?'linked':item.member==='late'?'late':'unprovable',item};
}
// The guard of an unlinked intent: exactly the fields the mapping consumes, nested references included (a revoke's `revokes.*`), and the receipt association that made it unlinked.
function intentSource(row,intent,requires=[]){
 const value=(object,path)=>{const v=path.split('.').reduce((current,part)=>plain(current)?current[part]:undefined,object);const n=v===undefined?null:v;return scalarOf(n)?n:undefined;};
 const guard={state:row.state,kind:row.kind,observation_key:row.observation_key,'receipt_json#$.decisionHash':value(intent.receipt,'decisionHash'),'command_json#$.effect':value(intent.command,'effect'),
  'command_json#$.tmdbId':value(intent.command,'tmdbId'),'issued_json#$.confirmedAt':value(intent.issued,'confirmedAt'),
  'receipt_json#$.state':value(intent.receipt,'state'),expected_hash:row.expected_hash==null?null:row.expected_hash};
 if(KIND_EFFECT[row.kind]!=='revoke'){
  // The replacement edge: which intent this one supersedes (null when it supersedes none) and the hash it was bound to. A change of the edge moves the source.
  guard['command_json#$.supersedes.requestId']=value(intent.command,'supersedes.requestId');
  guard['command_json#$.supersedes.decisionHash']=value(intent.command,'supersedes.decisionHash');
 }
 if(KIND_EFFECT[row.kind]==='revoke'){
  guard['command_json#$.revokes.requestId']=value(intent.command,'revokes.requestId');
  guard['command_json#$.revokes.effect']=value(intent.command,'revokes.effect');
  guard['command_json#$.revokes.tmdbId']=value(intent.command,'revokes.tmdbId');
 }
 if(Object.values(guard).includes(undefined))return null;
 // `requires` (the ER amendment, ADR 0215 decision 7): the other rows this action consumes, each pinned in the same chunk batch. Absent when the intent is the only row consumed.
 return {table:'discovery_intent',key:{idempotency_key:row.idempotency_key},guard,...(requires.length?{requires}:{})};
}
// The linked history row an action consumes (its revision is the `source_order`; for an assign its `ownerIdentity` is the time): pinned by key, writer, written_at and every identity field
// of the payload that is a scalar. ER has no SQL hash, so the receipt-to-payload hash association itself cannot be asserted: a change to a payload field the mapping does not read is
// not detected, and is harmless to the staged row.
const LINK_GUARD_PATHS=Object.freeze(['status','tmdbId','ownerIdentity.effect','ownerIdentity.tmdbId','ownerIdentity.requestId','ownerIdentity.at','revokedOwnerAssign.tmdbId','revokedOwnerAssign.requestId','revokedOwnerAssign.revokedBy','revokedOwnerAssign.at']);
const linkedHistoryRequire=item=>{const guard=payloadGuard('payload_json',item.payload,LINK_GUARD_PATHS);return guard&&{table:'discovery_decision_history',key:historyKey(item.row),guard:{...historyBase(item.row),...guard}};};
// The superseded intent a replacement's scoped withdrawal consumes (its effect, key and movie).
const supersededRequire=(row,intent)=>{
 const value=(object,path)=>{const v=path.split('.').reduce((current,part)=>plain(current)?current[part]:undefined,object);const n=v===undefined?null:v;return scalarOf(n)?n:undefined;};
 const guard={state:row.state,kind:row.kind,observation_key:row.observation_key,'command_json#$.effect':value(intent.command,'effect'),'command_json#$.tmdbId':value(intent.command,'tmdbId')};
 return Object.values(guard).includes(undefined)?null:{table:'discovery_intent',key:{idempotency_key:row.idempotency_key},guard};
};
// The raw rows of one owner action, from the live planner (E2c). `at` is the recorded time (a valid instant) or null (unknown): the planner runs with a placeholder where the time is
// unknown and the rows are then given the known value or null, so a placeholder is never stored. A replacement yields its own row AND the scoped withdrawal of the superseded intent
// (E2c: same root, time and order). Returns {rows} or {none}.
async function ownerRows({intent,key,next,at,order,superseded=null}){
 const time=at||PLACEHOLDER_TIME;
 const planning={...intent,issued:{...(plain(intent.issued)?intent.issued:{}),confirmedAt:time}};
 const planNext=next&&plain(next.ownerIdentity)?{...next,ownerIdentity:{...next.ownerIdentity,at:time}}:next;
 const plan=await planOwnerEvidence({intent:planning,superseded,key,next:planNext,revision:order??1});
 if(!plan.eligible)return {none:'not_an_owner_statement'};
 if(plan.plans===null)return {none:'unplannable'};
 const rows=plan.plans.map(item=>({...rawOf(item.row),sourceOrder:order??null,observedAt:at||null}));
 for(const input of rows)if(acceptable(input))return {none:'unrecordable'};
 return {rows};
}

// ---- b5: pre-D1 R2 owner action objects ----
// A terminal record states the effect, the movie, the observation and its key, and carries a succeeded receipt that wrote (or found applied) that observation. Anything else yields no
// row. The time of an assign is `afterImage.decision.ownerIdentity.at` when that decision names the same action, movie and key; of a reject `issued.confirmedAt`; otherwise unknown.
// Returns {intent,key,at,finishedAt} or {none:<reason>}.
export function r2Action(object){
 const record=object?.record;
 if(typeof object?.key!=='string'||!object.key.startsWith(R2_ACTION_PREFIX)||!object.key.endsWith('.json'))return {none:'not_an_action_object'};
 const idempotencyKey=object.key.slice(R2_ACTION_PREFIX.length,-'.json'.length);
 if(!plain(record)||record.schemaVersion!==1||record.kind!=='discovery_identity_action')return {none:'unknown_shape'};
 if(record.idempotencyKey!==idempotencyKey)return {none:'key_mismatch'};
 const command=record.command;
 if(!plain(command)||(command.effect!=='assign'&&command.effect!=='reject'))return {none:'effect_not_stated'};
 if(command.tmdbId===undefined||command.tmdbId===null||!/^\d{1,10}$/.test(String(command.tmdbId)))return {none:'movie_not_stated'};
 const observationKey=record.provenance?.observationKey??record.observationKey;
 if(typeof observationKey!=='string'||!observationKey)return {none:'observation_not_stated'};
 const outcomes=Array.isArray(record.receipt?.outcomes)?record.receipt.outcomes:[];
 const wrote=outcomes.some(item=>item?.id===observationKey&&(item.outcome==='written'||item.outcome==='already_applied'));
 if(record.state!=='succeeded'||record.receipt?.state!=='succeeded'||!wrote)return {none:'not_terminal'};
 const issued=plain(record.issued)?record.issued:null;
 let at=null;
 if(command.effect==='reject')at=instantOf(issued?.confirmedAt);
 else{
  const owner=record.afterImage?.decision?.ownerIdentity;
  if(plain(owner)&&owner.effect==='assign'&&owner.requestId===idempotencyKey&&String(owner.tmdbId)===String(command.tmdbId))at=instantOf(owner.at);
 }
 const intent={kind:command.effect==='assign'?'identity_assign':'identity_reject',idempotencyKey,observationKey,command:{effect:command.effect,tmdbId:command.tmdbId},issued};
 return {intent,key:observationKey,at,finishedAt:instantOf(record.finishedAt)};
}

// ---- the reconstruction ----
// Pure (async for SHA-256). `sources`: {history, decisions, intents, r2Objects, counts, acquisition, r2Acquisition} as selected by `readFamilyBSources` (rows as the database returns them) and
// listed by the operator (`r2Objects` as [{key, etag, record}], `r2Acquisition` as {complete, listedAt, objects:[{key, etag}]}, the exact frozen listing of that source). Returns
// {records, coverage}. `records` is in a fixed manifest order (history, owner actions, current decisions, R2) and goes to `planManifest` as is. Every source row lands in exactly one
// disposition, and the dispositions reconcile to the sizes read (`coverage.reconciled`), which is NOT a proof of complete reconstruction: `coverage.complete` is true only when
// no eligible proposition is unresolved and both acquisitions are established.
//
// Membership is proven PER SOURCE, never inferred across stores (ADR 0215 decision 7, step 1: each source freezes the exact list it read; no cross-store snapshot):
//   - append-only history: its own `written_at` against `cohortAt` (a later or backdated row is late); an untimed row only through the coherent D1 acquisition;
//   - mutable D1 rows (a current decision, an unlinked intent): they are frozen exactly as read, so they are in the cohort only through the coherent D1 acquisition covering `cohortAt`;
//     `issued.confirmedAt` is the issue time, never the receipt commit: it can only EXCLUDE (an intent issued after the cohort cannot belong to it), never prove membership;
//   - R2 objects: a terminal record's own `finishedAt`; an untimed one only through the frozen R2 listing (`r2Acquisition.complete`, listed no later than `cohortAt`, naming the object and its ETag).
export async function reconstructFamilyB({cohortAt,sources={},acceptR2Residual=false}={}){
 const cohortMs=cohortAt===undefined?null:Date.parse(cohortAt);
 const acquisition=sources.acquisition===undefined?{established:false,reason:'not_provided'}:{...sources.acquisition,established:sources.acquisition.coherent===true};
 const frozen=sources.r2Acquisition;
 // The frozen R2 listing is the exact set the operator listed: it must be an array of {key, etag} with unique string keys, complete, and carry a valid `listedAt`. An absent or invalid
 // listing is NOT an empty one; an empty valid listing is.
 const listingProblem=!plain(frozen)?'not_provided':frozen.complete!==true?'listing_incomplete':!Number.isFinite(Date.parse(frozen.listedAt))?'listed_at_invalid':!Array.isArray(frozen.objects)?'objects_invalid'
  :frozen.objects.some(item=>!plain(item)||typeof item.key!=='string'||!item.key||typeof item.etag!=='string'||!item.etag)?'objects_malformed'
  :new Set(frozen.objects.map(item=>item.key)).size!==frozen.objects.length?'objects_duplicate':null;
 const r2Acquisition=listingProblem?{established:false,reason:listingProblem}:{established:true,reason:null,listedAt:frozen.listedAt,objects:frozen.objects.length};
 const d1Covers=acquisition.established===true&&cohortMs!==null&&Number.isFinite(Date.parse(acquisition.acquiredAt))&&Date.parse(acquisition.acquiredAt)<=cohortMs;
 const r2Covers=r2Acquisition.established===true&&cohortMs!==null&&Date.parse(frozen.listedAt)<=cohortMs;
 const listed=new Map(listingProblem?[]:frozen.objects.map(item=>[item.key,item.etag]));
 const later=value=>cohortMs!==null&&Date.parse(value)>cohortMs;
 // The timed membership of an append-only D1 row or an R2 record: a valid time decides; no valid time is proven only by the source's own acquisition.
 const timed=(value,covers)=>{const time=instantOf(value);if(time!==null)return later(time)?'late':'in';return covers?'in':'unprovable';};
 const history=[...(sources.history||[])].sort((a,b)=>compare(a.observation_key,b.observation_key)||Number(a.revision)-Number(b.revision));
 const decisions=[...(sources.decisions||[])].sort((a,b)=>compare(a.observation_key,b.observation_key));
 const intents=[...(sources.intents||[])].sort((a,b)=>compare(a.observation_key,b.observation_key)||compare(a.idempotency_key,b.idempotency_key));
 const r2Objects=[...(sources.r2Objects||[])].sort((a,b)=>compare(a.key,b.key));
 const records=[];
 const pairs={b1:new Set(),b2:new Map(),b3:new Set(),other:new Set()};
 const disp={history:new Map(),decisions:new Map(),intents:new Map(),r2:new Map()};
 const noRow=new Map(),unrecordable=new Map(),unknownWriters=new Map(),writerStatus=new Map();
 const late={history:[],intents:[],r2:[]};
 const c={timeUnknown:0,rowsMapped:0,b4:{actions:0,rows:0,linked:0,linkedAssigns:0,historyOnlyAssigns:0,unlinked:0,orderUnknown:0,timeUnknown:0,ownerHistoryRows:0},b5:{eligible:0,rows:0,timeUnknown:0}};
 const unresolved={replacementSupersededMissing:0,cohortUnprovable:0,linkAmbiguous:0,linkUnprovable:0,unlinkedOwnerHistory:0,r2NotInFrozenListing:0,r2ListedNotRead:0};
 const addPair=mapped=>{
  const pair=mapped.input.subject.value+'|'+mapped.input.object.value;
  if(mapped.source==='tmdb_detail')pairs.b1.add(pair);else{const set=pairs.b2.get(mapped.source)||new Set();set.add(pair);pairs.b2.set(mapped.source,set);}
  if(mapped.timeUnknown)c.timeUnknown++;
 };
 const historyKeys=new Set(history.map(row=>row.observation_key));
 const owner=new Map();   // observation_key -> every owner-writer history row, with its membership (in / late / unprovable)

 // b1 / b2 / b3 / b6 from the history; EVERY owner-writer row is recorded for linking first (its membership is kept, never discarded).
 for(const row of history){
  const member=timed(row.written_at,d1Covers);
  const payload=parse(row.payload_json);
  if(OWNER_WRITERS.includes(row.writer)){
   c.b4.ownerHistoryRows++;
   if(member==='late')late.history.push({observationKey:row.observation_key,revision:Number(row.revision),writtenAt:row.written_at,writer:row.writer});
   bump(disp.history,member==='in'?'owner_history':member==='late'?'late':'cohort_unprovable');
   if(member==='unprovable')unresolved.cohortUnprovable++;
   if(plain(payload)){const list=owner.get(row.observation_key)||[];list.push({row,payload,member,used:false});owner.set(row.observation_key,list);}
   else if(member==='in'){bump(unrecordable,'owner_history_unreadable');}
   continue;
  }
  if(member==='unprovable'){bump(disp.history,'cohort_unprovable');unresolved.cohortUnprovable++;continue;}
  if(member==='late'){bump(disp.history,'late');late.history.push({observationKey:row.observation_key,revision:Number(row.revision),writtenAt:row.written_at,writer:row.writer});continue;}
  const status=plain(payload)?payload.status??'none':'unreadable';
  if(!NON_IDENTITY_WRITERS.includes(row.writer)&&row.writer!=='resolver_chunk')bump(unknownWriters,String(row.writer));
  const mapped=NON_IDENTITY_WRITERS.includes(row.writer)?{none:'non_identity_writer'}:mapDecision(row.observation_key,payload);
  bump(writerStatus,row.writer+'|'+status);
  if(!mapped.input){
   bump(noRow,mapped.none);
   if(mapped.none==='unrecordable'){bump(unrecordable,mapped.reason);bump(disp.history,'unrecordable');}else bump(disp.history,'no_row:'+mapped.none);
   if(mapped.none==='no_identity_source')pairs.b3.add(row.observation_key+'|'+(payload.tmdbId??''));
   if(mapped.none==='other_source')pairs.other.add(row.observation_key+'|'+(payload.tmdbId??''));
   continue;
  }
  const source=decisionHistorySource(row,payload);
  if(!source){bump(unrecordable,'guard_unsupported');bump(disp.history,'guard_unsupported');continue;}
  addPair(mapped);
  records.push({source,rows:[{evidence:mapped.input}]});c.rowsMapped++;bump(disp.history,'mapped');
 }

 // b4: the owner actions. The link between an intent and its history row is one of: none (no owner-writer row of the observation carries the receipt's hash: a genuinely history-less
 // action), linked (exactly one, in the cohort), late, unprovable, or ambiguous. Only `none` may be staged from the intent alone; every other status is reported, never read as "absent".
 const intentById=new Map(intents.map(row=>[row.idempotency_key,intentOf(row)])),rowById=new Map(intents.map(row=>[row.idempotency_key,row]));
 for(const row of intents){
  const intent=intentById.get(row.idempotency_key);
  if(!KIND_EFFECT[row.kind]||row.state!=='receipt'){bump(disp.intents,'not_selected');continue;}
  if(!plain(intent.command)){bump(disp.intents,'unrecordable');bump(unrecordable,'intent_unreadable');continue;}
  const effect=KIND_EFFECT[row.kind];
  c.b4.actions++;
  // A receipt that is absent or has no hash cannot be linked or pinned: reported, never read as a history-less action.
  if(!plain(intent.receipt)||typeof intent.receipt.decisionHash!=='string'||!intent.receipt.decisionHash){bump(disp.intents,'unrecordable');bump(unrecordable,'receipt_unreadable');continue;}
  const link=await linkOf(intent,owner.get(row.observation_key)||[]);
  // Every history row the receipt could name is accounted for by this action: an ambiguous link settles none of them as an independent statement.
  for(const matched of link.items||(link.item?[link.item]:[]))matched.used=true;
  if(link.status==='ambiguous'){bump(disp.intents,'link_ambiguous');unresolved.linkAmbiguous++;continue;}
  if(link.status==='unprovable'){bump(disp.intents,'link_unprovable');unresolved.linkUnprovable++;continue;}
  if(link.status==='late'){bump(disp.intents,'late');late.intents.push({idempotencyKey:row.idempotency_key,observationKey:row.observation_key,via:'history_row_after_cohort'});continue;}
  if(link.status==='none'){
   // A mutable receipt is frozen exactly as read: it is in the cohort only through the coherent D1 acquisition. `confirmedAt` can only exclude (issued after the cohort), never prove.
   if(!d1Covers){bump(disp.intents,'cohort_unprovable');unresolved.cohortUnprovable++;continue;}
   const issuedAt=instantOf(intent.issued?.confirmedAt);
   if(issuedAt!==null&&later(issuedAt)){bump(disp.intents,'late');late.intents.push({idempotencyKey:row.idempotency_key,observationKey:row.observation_key,via:'issued_after_cohort'});continue;}
  }
  // A replacement also yields the scoped withdrawal of the superseded intent: the superseded intent must be in the source and be an assign or a reject of this observation, otherwise the
  // withdrawal cannot be named and the WHOLE action stays unresolved (a replacement lacking its withdrawal is never imported and read as settled).
  const supersedes=intent.command.supersedes!==undefined&&intent.command.supersedes!==null;
  let superseded=null,supersededRow=null;
  if(supersedes){
   superseded=intentById.get(intent.command.supersedes.requestId)||null;
   supersededRow=superseded?rowById.get(superseded.idempotencyKey):null;
   if(!superseded||!plain(superseded.command)||(superseded.kind!=='identity_assign'&&superseded.kind!=='identity_reject')||superseded.observationKey!==row.observation_key){
    bump(disp.intents,'replacement_superseded_missing');unresolved.replacementSupersededMissing++;continue;
   }
  }
  const requires=[];
  if(link.status==='linked'){const required=linkedHistoryRequire(link.item);if(!required){bump(disp.intents,'guard_unsupported');bump(unrecordable,'guard_unsupported');continue;}requires.push(required);}
  if(supersedes){const required=supersededRequire(supersededRow,superseded);if(!required){bump(disp.intents,'guard_unsupported');bump(unrecordable,'guard_unsupported');continue;}requires.push(required);}
  let result;
  if(link.status==='linked'){
   // Linked to its history row: the history row is REQUIRED (its revision is the `source_order`; for an assign its `ownerIdentity` is the time), the intent is the source. The planner reads
   // the real intent, so an intent whose movie or key disagrees with the history row's `ownerIdentity` is unplannable, not staged.
   const identity=link.item.payload.ownerIdentity;
   const at=effect==='assign'?instantOf(identity?.at):instantOf(intent.issued?.confirmedAt);
   result=await ownerRows({intent,key:row.observation_key,next:effect==='assign'?link.item.payload:null,at,order:Number(link.item.row.revision),superseded});
   if(result.rows){c.b4.linked++;if(effect==='assign')c.b4.linkedAssigns++;if(result.rows.some(input=>input.observedAt===null))c.b4.timeUnknown++;}
  }else{
   // Genuinely history-less: the intent is the only source, the order is unknown. An assign has no recorded time then (its time is `ownerIdentity.at`), never inferred.
   const at=effect==='assign'?null:instantOf(intent.issued?.confirmedAt);
   result=await ownerRows({intent,key:row.observation_key,next:effect==='assign'?{ownerIdentity:{effect:'assign',requestId:row.idempotency_key,tmdbId:intent.command.tmdbId,at:PLACEHOLDER_TIME}}:null,at,order:null,superseded});
   if(result.rows){c.b4.unlinked++;c.b4.orderUnknown++;if(!at)c.b4.timeUnknown++;}
  }
  if(!result.rows){bump(disp.intents,result.none==='unrecordable'?'unrecordable':'unplannable');bump(unrecordable,'owner_'+result.none);continue;}
  const source=intentSource(row,intent,requires);
  if(!source){bump(disp.intents,'guard_unsupported');bump(unrecordable,'guard_unsupported');continue;}
  records.push({source,rows:result.rows.map(evidence=>({evidence}))});c.b4.rows+=result.rows.length;c.rowsMapped+=result.rows.length;bump(disp.intents,'mapped');
 }
 // Owner-writer history rows in the cohort that no intent receipt named. An assign is fully recorded in its own history row (`ownerIdentity`) and is staged from it; any other owner statement
 // needs its intent for the movie and the time and is unresolved; a row that states no identity is a deliberate no-row.
 for(const [key,list] of owner)for(const item of list){
  if(item.used||item.member!=='in')continue;
  const identity=item.payload.ownerIdentity;
  if(plain(identity)&&identity.effect==='assign'&&typeof identity.requestId==='string'&&identity.tmdbId!=null){
   const synthetic={kind:'identity_assign',idempotencyKey:identity.requestId,observationKey:key,command:{effect:'assign',tmdbId:identity.tmdbId},issued:null};
   const result=await ownerRows({intent:synthetic,key,next:item.payload,at:instantOf(identity.at),order:Number(item.row.revision)});
   const source=ownerHistorySource(item.row,item.payload);
   if(result.rows&&source){records.push({source,rows:result.rows.map(evidence=>({evidence}))});c.b4.rows+=result.rows.length;c.b4.historyOnlyAssigns++;c.rowsMapped+=result.rows.length;if(result.rows.some(input=>input.observedAt===null))c.b4.timeUnknown++;continue;}
   bump(unrecordable,'owner_history_unrecordable');continue;
  }
  if(plain(identity)||plain(item.payload.revokedOwnerAssign)){unresolved.unlinkedOwnerHistory++;continue;}
  bump(noRow,'owner_history_no_identity');
 }

 // The current decision rows. A decision is used ONLY for an observation with no history row at all (R2-era decisions loaded without one): for any other observation the history is the
 // source, and a late history row must not come back through its decision. It is a mutable row frozen exactly as read, so it needs the coherent D1 acquisition; it is guarded by its
 // hash AND by the payload fields the mapping reads (a payload-only change under an unchanged stored hash is detected). The same mapping (b1 / b2 / b3 / b6) applies.
 const withHistory=new Map();
 for(const row of decisions){
  const payload=parse(row.payload_json);
  if(historyKeys.has(row.observation_key)){bump(disp.decisions,'history_present');bump(withHistory,plain(payload)?payload.status??'none':'unreadable');continue;}
  if(!d1Covers){bump(disp.decisions,'cohort_unprovable');unresolved.cohortUnprovable++;continue;}
  const mapped=mapDecision(row.observation_key,payload);
  if(!mapped.input){
   bump(noRow,'current:'+mapped.none);
   if(mapped.none==='unrecordable'){bump(unrecordable,mapped.reason);bump(disp.decisions,'unrecordable');}else bump(disp.decisions,'no_row:'+mapped.none);
   if(mapped.none==='no_identity_source')pairs.b3.add(row.observation_key+'|'+payload.tmdbId);
   continue;
  }
  const source=decisionSource(row,payload);
  if(!source){bump(unrecordable,'guard_unsupported');bump(disp.decisions,'guard_unsupported');continue;}
  addPair(mapped);
  records.push({source,rows:[{evidence:mapped.input}]});c.rowsMapped++;bump(disp.decisions,'mapped');
 }

 // b5: the R2 action objects (the whole object is pinned by its ETag, and must be named by the frozen listing with that ETag).
 for(const object of r2Objects){
  const parsed=r2Action(object);
  if(!parsed.intent){bump(disp.r2,'ineligible:'+parsed.none);continue;}
  if(!r2Acquisition.established||listed.get(object.key)!==object.etag){bump(disp.r2,'not_in_frozen_listing');unresolved.r2NotInFrozenListing++;continue;}
  const member=timed(parsed.finishedAt,r2Covers);
  if(member==='unprovable'){bump(disp.r2,'cohort_unprovable');unresolved.cohortUnprovable++;continue;}
  if(member==='late'){bump(disp.r2,'late');late.r2.push({key:object.key,finishedAt:parsed.finishedAt});continue;}
  const {intent,key,at}=parsed;
  const next=intent.kind==='identity_assign'?{ownerIdentity:{effect:'assign',requestId:intent.idempotencyKey,tmdbId:intent.command.tmdbId,at:PLACEHOLDER_TIME}}:null;
  const result=await ownerRows({intent,key,next,at,order:null});
  if(!result.rows){bump(disp.r2,'unrecordable');bump(unrecordable,'r2_owner_'+result.none);continue;}
  c.b5.eligible++;c.b5.rows+=result.rows.length;c.rowsMapped+=result.rows.length;if(!at)c.b5.timeUnknown++;
  records.push({source:{kind:'r2_object',key:object.key,record:intent.idempotencyKey,etag:object.etag,r2:'admin_action_applied',residualAccepted:acceptR2Residual===true},rows:result.rows.map(evidence=>({evidence}))});
  bump(disp.r2,'mapped');
 }

 // The other direction: an object the frozen listing names that was not read (an injected empty read, a missing object) leaves the source unproven.
 const readKeys=new Set(r2Objects.map(object=>object.key));
 for(const key of listed.keys())if(!readKeys.has(key)){unresolved.r2ListedNotRead++;}
 const counts=sources.counts||{};
 const reconciled={history:sum(disp.history)===history.length,decisions:sum(disp.decisions)===decisions.length,intents:sum(disp.intents)===intents.length,r2:sum(disp.r2)===r2Objects.length};
 const unresolvedOut={replacementSupersededMissing:unresolved.replacementSupersededMissing,cohortUnprovable:unresolved.cohortUnprovable,
  linkAmbiguous:unresolved.linkAmbiguous,linkUnprovable:unresolved.linkUnprovable,unlinkedOwnerHistory:unresolved.unlinkedOwnerHistory,r2NotInFrozenListing:unresolved.r2NotInFrozenListing,r2ListedNotRead:unresolved.r2ListedNotRead,unrecordable:obj(unrecordable)};
 const unresolvedCount=unresolved.replacementSupersededMissing+unresolved.cohortUnprovable+unresolved.linkAmbiguous+unresolved.linkUnprovable+unresolved.unlinkedOwnerHistory+unresolved.r2NotInFrozenListing+unresolved.r2ListedNotRead+sum(unrecordable);
 const complete=acquisition.established&&r2Acquisition.established&&unresolvedCount===0&&Object.values(reconciled).every(Boolean);
 const coverage={family:FAMILY,cohortAt:cohortAt??null,
  // Three different things, never one: `complete` (every eligible proposition staged, both acquisitions established), `unresolved` (eligible but not staged), `excluded` (a deliberate no-row by
  // design, plus the late arrivals), and, from the dry run, the manifest's own conflicts. `reconciled` only says that each source row was accounted for.
  complete,unresolvedCount,acquisition:{d1:acquisition,r2:r2Acquisition},reconciled,
  sizes:{historyRows:history.length,decisionRows:decisions.length,intentRows:intents.length,r2Objects:r2Objects.length},
  dispositions:{history:obj(disp.history),decisions:obj(disp.decisions),intents:obj(disp.intents),r2:obj(disp.r2)},
  counts:{rowsMapped:c.rowsMapped,timeUnknown:c.timeUnknown,b1:{pairs:pairs.b1.size},b2:Object.fromEntries([...pairs.b2].sort(([a],[b])=>compare(a,b)).map(([name,set])=>[name,{pairs:set.size}])),b3:{pairs:pairs.b3.size},
   otherSource:{pairs:pairs.other.size},b4:c.b4,b5:{...c.b5,listed:r2Objects.length},b6:{historyByWriterAndStatus:obj(writerStatus)},
   b7:{observations:counts.observations??null,confirmedTmdbIds:counts.confirmedTmdbIds??null,admissions:counts.admissions??null},
   currentDecisionsWithHistory:{count:sum(withHistory),byStatus:obj(withHistory)}},
  excluded:{noRow:obj(noRow)},unknownWriters:obj(unknownWriters),unresolved:unresolvedOut,
  lateArrivals:{history:late.history.length,intents:late.intents.length,r2:late.r2.length,sample:{history:late.history.slice(0,20),intents:late.intents.slice(0,20),r2:late.r2.slice(0,20)}}};
 return {records,coverage};
}

// ---- reading the sources (SELECT only) ----
// `db` is a D1-like handle (`prepare().bind().all()`). Keyset pages, bounded; every statement is a SELECT. `counts` carries the b7 sizes (counted, never copied). The acquisition is fenced
// by the Discovery authority (`discovery_authority`): its mode, cutover and generation are read before the first page and after the last, and every Discovery write moves the
// generation, so an unchanged generation under `d1`/`open` means no Discovery write happened while the tables were read. Anything else is an incoherent acquisition (`coherent: false`).
export async function readFamilyBSources(db,{pageSize=500,maxPages=10000}={}){
 const all=async(sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results||[];
 const first=async(sql,params=[])=>(await all(sql,params))[0]||null;
 const marker=async()=>{const row=await first('SELECT mode,cutover,generation FROM discovery_authority WHERE id=1');return row&&{mode:row.mode,cutover:row.cutover,generation:Number(row.generation)};};
 const page=async(table,columns,keyColumns,where='')=>{
  const rows=[];let cursor=null;
  for(let i=0;i<maxPages;i++){
   const order=keyColumns.join(','),mark=keyColumns.map(()=>'?').join(',');
   const sql='SELECT '+columns+' FROM '+table+' WHERE '+(where?where+' AND ':'')+(cursor?'('+order+') > ('+mark+')':'1=1')+' ORDER BY '+order+' LIMIT ?';
   const batch=await all(sql,[...(cursor||[]),pageSize]);
   rows.push(...batch);
   if(batch.length<pageSize)return rows;
   const last=batch[batch.length-1];cursor=keyColumns.map(column=>last[column]);
  }
  throw new Error('identity_evidence_family_b_page_limit');
 };

 const acquiredAt=new Date().toISOString();
 const before=await marker();
 const history=await page('discovery_decision_history','observation_key,revision,generation,written_at,writer,payload_json',['observation_key','revision']);
 const decisions=await page('discovery_decision','observation_key,decision_hash,status,tmdb_id,media_kind,payload_json',['observation_key']);
 const intents=await page('discovery_intent','idempotency_key,kind,state,observation_key,receipt_json,issued_json,command_json,expected_hash',['idempotency_key'],"kind IN ('identity_assign','identity_reject','identity_revoke') AND state='receipt'");
 const n=async sql=>Number((await first(sql))?.n??0);
 const counts={observations:await n('SELECT COUNT(*) AS n FROM discovery_observation'),confirmedTmdbIds:await n('SELECT COUNT(*) AS n FROM discovery_observation WHERE confirmed_tmdb_id IS NOT NULL'),admissions:await n('SELECT COUNT(*) AS n FROM discovery_admission')};
 const end=await marker();
 let reason=null;
 if(!before||!end)reason='authority_unreadable';
 else if(before.mode!=='d1'||before.cutover!=='open'||end.mode!=='d1'||end.cutover!=='open')reason='authority_not_open';
 else if(before.generation!==end.generation)reason='generation_moved';
 else if(history.some(row=>Number(row.generation)>before.generation))reason='row_after_generation';
 const acquisition={coherent:reason===null,reason,acquiredAt,generationBefore:before?.generation??null,generationAfter:end?.generation??null,mode:end?.mode??null,cutover:end?.cutover??null};
 return {history,decisions,intents,counts,acquisition};
}

// The dry run (ADR 0215 decision 7, step 1) over already-read sources: the reconstruction, then the PURE `planManifest` of the import path. Writes nothing. `runId` and `cohortAt`
// freeze the cohort; records after `cohortAt` are late arrivals, excluded and reported. It REFUSES to certify a manifest when the D1 acquisition is not proven coherent
// (`sources.acquisition.coherent`), unless the caller states `unfenced: true` (offline mapping tests only; the coverage then says `acquisition.d1.established: false`). The manifest's own
// conflicts and exclusions (a key two sources disagree on, an R2 record the owner has not accepted the residual window of, a record too large) are eligible propositions that did not
// reach the manifest: they are added to the coverage and keep `complete` false.
export async function dryRunFamilyB({runId,cohortAt,sources,acceptR2Residual=false,planManifest,unfenced=false}={}){
 if(typeof planManifest!=='function')throw new Error('identity_evidence_family_b_plan_manifest_required');
 const {records,coverage}=await reconstructFamilyB({cohortAt,sources,acceptR2Residual});
 if(unfenced!==true&&coverage.acquisition.d1.established!==true){
  return {manifest:null,digest:null,report:{disposition:'acquisition_not_coherent',reason:coverage.acquisition.d1.reason||'not_established'},coverage};
 }
 const plan=await planManifest({runId,family:FAMILY,cohortAt,records});
 const manifest={conflicts:plan.report.conflicts.length,excluded:plan.report.excluded.length,duplicates:plan.report.duplicates.length};
 const out={...coverage,manifest,complete:coverage.complete&&manifest.conflicts===0&&manifest.excluded===0};
 return {...plan,coverage:out};
}
