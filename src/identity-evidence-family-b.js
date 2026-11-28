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
//   b4  owner intent receipts (`identity_assign`, `identity_reject`, `identity_revoke`, replacements) joined to their history row -> E2c rows, root = the intent key
//   b5  pre-D1 R2 `admin/actions/discovery_identity_correct/v1/`     -> E2c row only from a terminal record that states effect, movie, observation and key; else no row, counted
//   b6  policy exclusions, reconsiders, deferrals, non-verified      -> no row, counted
//   b7  observations, `confirmed_tmdb_id`, admissions                -> no row, counted
// A source record yields at most two rows (an owner replacement: its own row and the scoped withdrawal). The caller (the dry run) passes `records` to `planManifest` with family `b`.
// This module does NOT import the import path (ER's invariant: nothing under src/ imports src/identity-evidence-import.js, see tests/identity-evidence-import.mjs): the operator that runs the
// dry run hands `planManifest` in.
import {decisionEvidenceInput,decisionHash} from './discovery-authority.js';
import {planOwnerEvidence} from './discovery-owner-evidence.js';
import {normalizeEvidence} from './identity-evidence.js';

export const FAMILY='b';
// The writers of `discovery_decision_history` that are not an automated decision path: the owner writers (their rows are b4, never b1/b2) and the writers that state no identity (b6).
export const OWNER_WRITERS=Object.freeze(['owner','discovery_identity_correct','discovery_identity_revoke']);
export const NON_IDENTITY_WRITERS=Object.freeze(['catalog_policy_exclude','discovery_reconsider']);
export const R2_ACTION_PREFIX='admin/actions/discovery_identity_correct/v1/';
const KIND_EFFECT=Object.freeze({identity_assign:'assign',identity_reject:'reject',identity_revoke:'revoke'});
const PLACEHOLDER_TIME='1970-01-01T00:00:00.000Z';
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const parse=text=>{try{const value=JSON.parse(text);return value;}catch{return undefined;}};
const scalarOf=value=>value===null||typeof value==='string'||(typeof value==='number'&&Number.isFinite(value));
const bump=(map,key,by=1)=>map.set(key,(map.get(key)||0)+by);
const obj=map=>Object.fromEntries([...map].sort(([a],[b])=>a<b?-1:a>b?1:0));
const compare=(a,b)=>a<b?-1:a>b?1:0;

// The raw input form of a normalized row, as `planManifest` takes it (origin, run and source are set by the import path).
const rawOf=row=>({subject:{kind:row.subjectKind,value:row.subjectValue},relation:row.relation,object:row.objectKind===null?null:{kind:row.objectKind,value:row.objectValue},polarity:row.polarity,
 route:row.route,method:row.method,sourceRoot:row.sourceRoot,sourceRef:row.sourceRef,sourceScope:row.sourceScope,scopeEvidenceKey:row.scopeEvidenceKey,supersedesKey:row.supersedesKey,
 observedAt:row.observedAt,sourceOrder:row.sourceOrder});
// Whether a raw input is a valid RECONSTRUCTED row (an unknown time or order is allowed there, never on a live row). Returns the reason on refusal.
function acceptable(input){
 try{normalizeEvidence({...input,origin:'reconstruction',reconstructionRun:'probe',reconstructedFrom:'probe'});return null;}
 catch(error){if(error?.code==='identity_evidence_invalid')return error.reason||'invalid';throw error;}
}

// ---- b1 / b2 (and the b3 / b6 reports): one decision payload ----
// Returns {input} (a raw evidence input), or {none:<reason>} with the b-class of the absence. `timeUnknown` marks a row whose payload time was not a valid instant: the row is kept with an unknown
// time, which the model allows only on a reconstructed row (the payload is never guessed at).
export function mapDecision(key,payload){
 if(!plain(payload))return {none:'payload_unreadable'};
 if(payload.status!=='verified')return {none:'not_verified'};
 const source=payload.identitySource;
 if(source===undefined||source===null||source==='')return {none:'no_identity_source'};
 if(source==='owner')return {none:'owner_source'};
 const input=decisionEvidenceInput(key,payload);
 if(!input)return {none:payload.tmdbId==null?'no_tmdb_id':'other_source'};
 const reason=acceptable(input);
 const absent=input.observedAt===undefined||input.observedAt===null;
 if(reason){const unknownTime={...input,observedAt:null};if(!acceptable(unknownTime))return {input:unknownTime,timeUnknown:true,source};return {none:'unrecordable',reason};}
 return {input:absent?{...input,observedAt:null}:input,timeUnknown:absent,source};
}
const GUARD_PATHS=Object.freeze(['status','identitySource','tmdbId','checkedAt','id','canonicalIdentity','mediaType','kind']);
// The guard fields a decision payload source pins: the fields the mapping reads. A non-scalar value cannot be pinned (the record is then not importable).
function payloadGuard(column,payload){
 const guard={};
 for(const name of GUARD_PATHS){
  const value=payload[name]===undefined?null:payload[name];
  if(!scalarOf(value))return null;
  guard[column+'#$.'+name]=value;
 }
 return guard;
}
const historySource=(row,payload)=>{const guard=payloadGuard('payload_json',payload);return guard&&{table:'discovery_decision_history',key:{observation_key:row.observation_key,revision:Number(row.revision)},guard:{writer:row.writer,written_at:row.written_at,...guard}};};
const decisionSource=row=>({table:'discovery_decision',key:{observation_key:row.observation_key},guard:{decision_hash:row.decision_hash}});

// ---- b4: owner intents ----
const intentOf=row=>{
 const command=parse(row.command_json),issued=row.issued_json==null?null:parse(row.issued_json),receipt=row.receipt_json==null?null:parse(row.receipt_json);
 return {kind:row.kind,idempotencyKey:row.idempotency_key,observationKey:row.observation_key,state:row.state,command,issued,receipt};
};
// The history row an intent's receipt names: the owner-writer row of the same observation whose payload hashes to `receipt.decisionHash`. Exactly one, or the link is unknown.
async function linkedHistory(intent,candidates){
 const wanted=intent.receipt?.decisionHash;
 if(typeof wanted!=='string')return null;
 const found=[];
 for(const item of candidates){if(await decisionHash(item.payload)===wanted)found.push(item);}
 return found.length===1?found[0]:null;
}
const intentSource=row=>{
 const command=parse(row.command_json),issued=row.issued_json==null?null:parse(row.issued_json),receipt=row.receipt_json==null?null:parse(row.receipt_json);
 const value=(object,name)=>{const v=plain(object)&&object[name]!==undefined?object[name]:null;return scalarOf(v)?v:undefined;};
 const guard={state:row.state,kind:row.kind,observation_key:row.observation_key,'receipt_json#$.decisionHash':value(receipt,'decisionHash'),'command_json#$.effect':value(command,'effect'),
  'command_json#$.tmdbId':value(command,'tmdbId'),'issued_json#$.confirmedAt':value(issued,'confirmedAt')};
 if(Object.values(guard).includes(undefined))return null;
 return {table:'discovery_intent',key:{idempotency_key:row.idempotency_key},guard};
};
// The raw rows of one owner intent, from the live planner (E2c). `order` and `at` may be unknown (null): the planner runs with placeholders and the rows are then given the
// unknown values, which a reconstruction allows and a live row never has. Returns {rows} or {none}.
async function ownerRows({intent,superseded,key,next,revision,atKnown}){
 const withReplacement=intent.command?.supersedes!==undefined&&intent.command?.supersedes!==null;
 let plan=await planOwnerEvidence({intent,superseded,key,next,revision:revision??1});
 let withdrawalUnavailable=false;
 if(plan.eligible&&plan.plans===null&&withReplacement){
  // The superseded intent is not in the source: the intent's own row is still a recorded fact, the scoped withdrawal cannot be named. Reported, never invented.
  const stripped={...intent,command:{...intent.command,supersedes:null}};
  plan=await planOwnerEvidence({intent:stripped,superseded:null,key,next,revision:revision??1});
  withdrawalUnavailable=true;
 }
 if(!plan.eligible)return {none:'not_an_owner_statement'};
 if(plan.plans===null)return {none:'unplannable'};
 const rows=plan.plans.map(item=>({...rawOf(item.row),sourceOrder:revision==null?null:item.row.sourceOrder,observedAt:atKnown===false?null:item.row.observedAt}));
 for(const input of rows)if(acceptable(input))return {none:'unrecordable'};
 return {rows,withdrawalUnavailable};
}

// ---- b5: pre-D1 R2 owner action objects ----
// A terminal record states the effect, the movie, the observation and its key; anything else yields no row. Returns {intent,key} or {none:<reason>}.
export function r2Action(object){
 const record=object?.record;
 if(typeof object?.key!=='string'||!object.key.startsWith(R2_ACTION_PREFIX)||!object.key.endsWith('.json'))return {none:'not_an_action_object'};
 const idempotencyKey=object.key.slice(R2_ACTION_PREFIX.length,-'.json'.length);
 if(!plain(record)||record.schemaVersion!==1||record.kind!=='discovery_identity_action')return {none:'unknown_shape'};
 if(record.state!=='applied')return {none:'not_terminal'};
 if(record.idempotencyKey!==idempotencyKey)return {none:'key_mismatch'};
 const command=record.command;
 if(!plain(command)||(command.effect!=='assign'&&command.effect!=='reject'))return {none:'effect_not_stated'};
 if(command.tmdbId===undefined||command.tmdbId===null||!/^\d{1,10}$/.test(String(command.tmdbId)))return {none:'movie_not_stated'};
 const observationKey=record.provenance?.observationKey??record.observationKey;
 if(typeof observationKey!=='string'||!observationKey)return {none:'observation_not_stated'};
 const issued=plain(record.issued)?record.issued:null;
 const intent={kind:command.effect==='assign'?'identity_assign':'identity_reject',idempotencyKey,observationKey,command:{effect:command.effect,tmdbId:command.tmdbId},issued};
 return {intent,key:observationKey};
}

// ---- the reconstruction ----
// Pure (async for SHA-256). `sources`: {history, decisions, intents, r2Objects, counts} as selected by `readFamilyBSources` (rows as the database returns them, `r2Objects` as
// [{key, etag, record}]). Returns {records, coverage}. `records` is in a fixed manifest order (history, owner intents, current decisions, R2) and goes to `planManifest` as is.
export async function reconstructFamilyB({cohortAt,sources={},acceptR2Residual=false}={}){
 const history=[...(sources.history||[])].sort((a,b)=>compare(a.observation_key,b.observation_key)||Number(a.revision)-Number(b.revision));
 const decisions=[...(sources.decisions||[])].sort((a,b)=>compare(a.observation_key,b.observation_key));
 const intents=[...(sources.intents||[])].sort((a,b)=>compare(a.observation_key,b.observation_key)||compare(a.idempotency_key,b.idempotency_key));
 const r2Objects=[...(sources.r2Objects||[])].sort((a,b)=>compare(a.key,b.key));
 const records=[];
 const pairs={b1:new Set(),b2:new Map(),b3:new Set(),other:new Set()};
 const none=new Map(),unrecordable=new Map(),lateArrivals=[],covered=new Set(),writerStatus=new Map(),unknownWriters=new Map();
 const c={historyRows:history.length,decisionRows:decisions.length,intentRows:intents.length,r2Objects:r2Objects.length,rowsMapped:0,timeUnknown:0,decisionsCoveredByHistory:0,
  b4:{actions:0,rows:0,linkedToHistory:0,orderUnknown:0,timeUnknown:0,scopedWithdrawalUnavailable:0,unlinkedOwnerHistory:0},b5:{eligible:0,rows:0,timeUnknown:0}};
 const cohortMs=cohortAt===undefined?null:Date.parse(cohortAt);
 const owner=new Map();   // observation_key -> owner-writer history rows
 const bySignature=item=>item.input.subject.value+'|'+item.input.object.kind+':'+item.input.object.value+'|'+item.input.method+'|'+(item.input.sourceScope||'');

 // b1 / b2 / b3 / b6 from the history; the owner-writer rows are set aside for b4.
 for(const row of history){
  if(cohortMs!==null&&Date.parse(row.written_at)>cohortMs){lateArrivals.push({observationKey:row.observation_key,revision:Number(row.revision),writtenAt:row.written_at});continue;}
  const payload=parse(row.payload_json);
  if(OWNER_WRITERS.includes(row.writer)){if(plain(payload)){const list=owner.get(row.observation_key)||[];list.push({row,payload});owner.set(row.observation_key,list);}else bump(unrecordable,'owner_payload_unreadable');continue;}
  const status=plain(payload)?payload.status??'none':'unreadable';
  if(!NON_IDENTITY_WRITERS.includes(row.writer)&&row.writer!=='resolver_chunk')bump(unknownWriters,String(row.writer));
  const mapped=NON_IDENTITY_WRITERS.includes(row.writer)?{none:'non_identity_writer'}:mapDecision(row.observation_key,payload);
  if(!mapped.input){
   bump(none,mapped.none);
   if(mapped.none==='unrecordable')bump(unrecordable,mapped.reason);
   if(mapped.none==='no_identity_source')pairs.b3.add(row.observation_key+'|'+(payload.tmdbId??''));
   if(mapped.none==='other_source')pairs.other.add(row.observation_key+'|'+(payload.tmdbId??''));
   bump(writerStatus,row.writer+'|'+status);
   continue;
  }
  const source=historySource(row,payload);
  if(!source){bump(unrecordable,'guard_unsupported');continue;}
  const pair=mapped.input.subject.value+'|'+mapped.input.object.value;
  if(mapped.source==='tmdb_detail')pairs.b1.add(pair);else{const set=pairs.b2.get(mapped.source)||new Set();set.add(pair);pairs.b2.set(mapped.source,set);}
  if(mapped.timeUnknown)c.timeUnknown++;
  covered.add(bySignature(mapped));
  records.push({source,rows:[{evidence:mapped.input}]});c.rowsMapped++;
  bump(writerStatus,row.writer+'|verified');
 }

 // b4: the owner intent receipts, each joined to its history row. The source of a linked action is the (immutable) history row, otherwise the intent itself.
 const intentById=new Map(intents.map(row=>[row.idempotency_key,intentOf(row)]));
 const usedHistory=new Set();
 for(const row of intents){
  const intent=intentById.get(row.idempotency_key);
  if(!KIND_EFFECT[row.kind]||row.state!=='receipt')continue;
  if(!plain(intent.command)){bump(unrecordable,'intent_unreadable');continue;}
  c.b4.actions++;
  const candidates=owner.get(row.observation_key)||[];
  const link=await linkedHistory(intent,candidates);
  if(link){usedHistory.add(row.observation_key+'#'+link.row.revision);c.b4.linkedToHistory++;}
  const effect=KIND_EFFECT[row.kind];
  const next=link?link.payload:(effect==='assign'?{ownerIdentity:{effect:'assign',requestId:row.idempotency_key,tmdbId:intent.command.tmdbId,at:PLACEHOLDER_TIME}}:null);
  const supersededId=intent.command?.supersedes?.requestId;
  const result=await ownerRows({intent,superseded:supersededId?intentById.get(supersededId)||null:null,key:row.observation_key,next,revision:link?Number(link.row.revision):null,atKnown:effect==='assign'?!!link:true});
  if(!result.rows){bump(none,'owner_'+result.none);if(result.none!=='not_an_owner_statement')bump(unrecordable,'owner_'+result.none);continue;}
  if(!link)c.b4.orderUnknown++;
  if(effect==='assign'&&!link)c.b4.timeUnknown++;
  if(result.withdrawalUnavailable)c.b4.scopedWithdrawalUnavailable++;
  const source=link?historySource(link.row,link.payload):intentSource(row);
  if(!source){bump(unrecordable,'guard_unsupported');continue;}
  records.push({source,rows:result.rows.map(evidence=>({evidence}))});c.b4.rows+=result.rows.length;c.rowsMapped+=result.rows.length;
 }
 for(const [key,list] of owner)for(const item of list)if(!usedHistory.has(key+'#'+item.row.revision))c.b4.unlinkedOwnerHistory++;

 // The current decision rows that the history does not cover: R2-era decisions loaded without a history row (b1 / b2 / b3 / b6 again, by the same mapping).
 for(const row of decisions){
  const payload=parse(row.payload_json);
  const mapped=mapDecision(row.observation_key,payload);
  if(!mapped.input){
   if(mapped.none==='no_identity_source')pairs.b3.add(row.observation_key+'|'+(plain(payload)?payload.tmdbId??'':''));
   if(mapped.none==='unrecordable')bump(unrecordable,mapped.reason);
   continue;
  }
  if(covered.has(bySignature(mapped))){c.decisionsCoveredByHistory++;continue;}
  const pair=mapped.input.subject.value+'|'+mapped.input.object.value;
  if(mapped.source==='tmdb_detail')pairs.b1.add(pair);else{const set=pairs.b2.get(mapped.source)||new Set();set.add(pair);pairs.b2.set(mapped.source,set);}
  if(mapped.timeUnknown)c.timeUnknown++;
  records.push({source:decisionSource(row),rows:[{evidence:mapped.input}]});c.rowsMapped++;
 }

 // b5: the R2 action objects.
 const r2None=new Map();
 for(const object of r2Objects){
  const parsed=r2Action(object);
  if(!parsed.intent){bump(r2None,parsed.none);continue;}
  const {intent,key}=parsed;
  const atKnown=intent.kind==='identity_assign'?false:plain(intent.issued)&&typeof intent.issued.confirmedAt==='string';
  const next=intent.kind==='identity_assign'?{ownerIdentity:{effect:'assign',requestId:intent.idempotencyKey,tmdbId:intent.command.tmdbId,at:PLACEHOLDER_TIME}}:null;
  const planned={...intent,issued:intent.kind==='identity_reject'&&!atKnown?{confirmedAt:PLACEHOLDER_TIME}:intent.issued};
  const result=await ownerRows({intent:planned,superseded:null,key,next,revision:null,atKnown});
  if(!result.rows){bump(r2None,'owner_'+result.none);continue;}
  c.b5.eligible++;c.b5.rows+=result.rows.length;c.rowsMapped+=result.rows.length;if(!atKnown)c.b5.timeUnknown++;
  records.push({source:{kind:'r2_object',key:object.key,record:intent.idempotencyKey,etag:object.etag,r2:'admin_action_applied',residualAccepted:acceptR2Residual===true},rows:result.rows.map(evidence=>({evidence}))});
 }

 const counts=sources.counts||{};
 const coverage={family:FAMILY,cohortAt:cohortAt??null,
  counts:{...c,b1:{pairs:pairs.b1.size},b2:Object.fromEntries([...pairs.b2].sort(([a],[b])=>compare(a,b)).map(([name,set])=>[name,{pairs:set.size}])),b3:{pairs:pairs.b3.size},otherSource:{pairs:pairs.other.size},
   b5:{...c.b5,listed:r2Objects.length,ineligible:obj(r2None)},b6:{byWriterAndStatus:obj(writerStatus)},b7:{observations:counts.observations??null,confirmedTmdbIds:counts.confirmedTmdbIds??null,admissions:counts.admissions??null}},
  noRow:obj(none),unrecordable:obj(unrecordable),unknownWriters:obj(unknownWriters),lateArrivals:{count:lateArrivals.length,sample:lateArrivals.slice(0,20)}};
 return {records,coverage};
}

// ---- reading the sources (SELECT only) ----
// `db` is a D1-like handle (`prepare().bind().all()`). Keyset pages, bounded; every statement is a SELECT. `counts` carries the b7 sizes (counted, never copied).
export async function readFamilyBSources(db,{pageSize=500,maxPages=10000}={}){
 const all=async(sql,params=[])=>(await db.prepare(sql).bind(...params).all()).results||[];
 const first=async(sql,params=[])=>(await all(sql,params))[0]||null;
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
 const history=await page('discovery_decision_history','observation_key,revision,generation,written_at,writer,payload_json',['observation_key','revision']);
 const decisions=await page('discovery_decision','observation_key,decision_hash,status,tmdb_id,media_kind,payload_json',['observation_key']);
 const intents=await page('discovery_intent','idempotency_key,kind,state,observation_key,receipt_json,issued_json,command_json,expected_hash',['idempotency_key'],"kind IN ('identity_assign','identity_reject','identity_revoke') AND state='receipt'");
 const n=async(sql)=>Number((await first(sql))?.n??0);
 const counts={observations:await n('SELECT COUNT(*) AS n FROM discovery_observation'),confirmedTmdbIds:await n('SELECT COUNT(*) AS n FROM discovery_observation WHERE confirmed_tmdb_id IS NOT NULL'),admissions:await n('SELECT COUNT(*) AS n FROM discovery_admission')};
 return {history,decisions,intents,counts};
}

// The dry run (ADR 0215 decision 7, step 1) over already-read sources: the reconstruction, then the PURE `planManifest` of the import path. Writes nothing. `runId` and `cohortAt` freeze
// the cohort; rows written to the history after `cohortAt` are late arrivals, excluded and reported.
export async function dryRunFamilyB({runId,cohortAt,sources,acceptR2Residual=false,planManifest}={}){
 if(typeof planManifest!=='function')throw new Error('identity_evidence_family_b_plan_manifest_required');
 const {records,coverage}=await reconstructFamilyB({cohortAt,sources,acceptR2Residual});
 const plan=await planManifest({runId,family:FAMILY,cohortAt,records});
 return {...plan,coverage};
}
