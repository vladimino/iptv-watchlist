// AIR-499 metadata_sync. Receipted units for the four kinds PRODUCER_WIRING requires of metadataSync:
// film_metadata, film_sync_state, localization_source, localization_conflict. Reuses writeFilmFacts,
// recordLocalizationSources and recordLocalizationConflicts. DORMANT below `open`: one writerRoute read,
// nothing else. held / unreadable throw and never name R2. No Film is created (requireExisting). Provenance
// is the parse/localization the call site already ran; clocks and titles are never invented.
import {database,failed,many,one} from './film-person-authority.js';
import {writerRoute} from './canonical-writer-route.js';
import {RETRY_POLICY,defineOperation,digestOf,operationRegistry,receiptedWrite} from './canonical-receipts.js';
import {planFilmFacts,readFilmSnapshot,writeFilmFacts} from './canonical-film-writers.js';
import {INLINE_RECONCILE_LIMIT,SOURCE_CHANGED,filmFactsContent,producerRequestId,producerRouteOpen,reconcileOwnOrigin} from './canonical-producer-adapters.js';
import {compareLocalization,loadLocalizationInputs,recordLocalizationSources,resolveLocalization} from './localization-sources.js';
import {planConflicts,recordLocalizationConflicts} from './canonical-person-state.js';

export const METADATA_SYNC_ORIGIN='metadata_sync';
export const FILM_METADATA_OPERATION='film_metadata';
export const FILM_SYNC_OPERATION='film_sync_state';
export const LOCALIZATION_SOURCE_OPERATION='localization_source';
export const LOCALIZATION_CONFLICT_OPERATION='localization_conflict';
export const METADATA_SYNC_KINDS=Object.freeze([FILM_METADATA_OPERATION,FILM_SYNC_OPERATION,LOCALIZATION_SOURCE_OPERATION,LOCALIZATION_CONFLICT_OPERATION]);
const CLOSED=new Set(['film_person_held','film_person_unavailable','film_person_not_open','film_person_generation_moved']);
const READ_FAILURES=new Set(['film_person_unavailable','film_person_held','film_person_not_open']);
const TABLE={film:{table:'film_localization_source',column:'film_id',entity:'film'},person:{table:'person_localization_source',column:'person_id',entity:'person'}};
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TMDB=/^[1-9]\d{0,11}$/;
const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const instant=value=>typeof value==='string'&&ISO.test(value)?value:null;
const present=value=>typeof value==='string'&&value.trim().length>0;
const clockOf=now=>typeof now==='function'?now:()=>now||new Date().toISOString();
const revisionOf=async(db,kind,id)=>Number((await one(db,'SELECT revision FROM canonical_revision WHERE kind=? AND id=?',[kind,id]))?.revision??0);
const mark=(ctx,clock)=>({requestId:ctx.requestId,attempt:ctx.attempt,now:clock(),target:ctx.target});

export function canonicalMetadataFilmId(film){
 if(plain(film)&&typeof film.id==='string'&&film.id.startsWith('film:'))return film.id;
 const tmdb=String(film?.tmdbId??'');
 if(TMDB.test(tmdb))return 'film:tmdb:'+tmdb;
 const raw=String(film?.id??'');
 return raw?('film:'+raw):null;
}
export function canonicalPersonId(raw){
 const s=String(raw||'');
 return s?(s.startsWith('person:')?s:'person:'+s):null;
}

// Same typed-claim rule as catalogMetadataFromD1: every stored row of the scheme/value is assessed; any claim that is not
// the one owner's trusted, non-conflicting row is a collision. Untrusted and conflicting rows are not ignored.
function typedClaim(rows,scheme,value){
 const pool=(rows||[]).filter(row=>row.scheme===scheme&&String(row.value)===String(value));
 const isOwn=row=>Number(row.trusted)===1&&Number(row.conflicting)===0;
 const owner=pool.find(isOwn)?.film_id??null;
 if(pool.some(row=>!(isOwn(row)&&row.film_id===owner)))return {conflict:true,filmId:null};
 return {conflict:false,filmId:owner};
}

export async function resolveExistingFilmId(env,film){
 const db=database(env);
 if(!db)throw failed('film_person_unavailable');
 const raw=String(film?.id??'');
 const tmdb=String(film?.tmdbId??'');
 const spelled=raw.startsWith('film:')?raw:null;
 const lid=spelled?null:(raw||null);
 const parts=[];
 if(TMDB.test(tmdb))parts.push(...await many(db,"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme='tmdb' AND value=?",[tmdb]));
 if(lid)parts.push(...await many(db,"SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE scheme='letterboxd' AND value=?",[lid]));
 if(spelled)parts.push(...await many(db,'SELECT film_id,scheme,value,trusted,conflicting FROM film_external_id WHERE film_id=?',[spelled]));
 const tmdbClaim=TMDB.test(tmdb)?typedClaim(parts,'tmdb',tmdb):{conflict:false,filmId:null};
 const lidClaim=lid?typedClaim(parts,'letterboxd',lid):{conflict:false,filmId:null};
 if(tmdbClaim.conflict||lidClaim.conflict)throw failed('identity_collision');
 if(tmdbClaim.filmId&&lidClaim.filmId&&tmdbClaim.filmId!==lidClaim.filmId)throw failed('identity_collision');
 let id=tmdbClaim.filmId||lidClaim.filmId||null;
 if(spelled){
  if(id&&id!==spelled)throw failed('identity_collision');
  if(!id&&await one(db,'SELECT id FROM film WHERE id=?',[spelled]))id=spelled;
 }
 if(!id)return null;
 if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');
 return id;
}

function metadataFields(film){
 const out={schemaVersion:1,updatedAt:instant(film?.metadataAt)};
 if(!out.updatedAt)return null;
 for(const [name,from] of [['year','year'],['runtime','runtime'],['synopsis','synopsis'],['poster','poster'],['url','url'],['peopleVersion','peopleVersion']]){
  if(film?.[from]!==undefined&&film[from]!==null&&film[from]!=='')out[name]=film[from];
 }
 if(Array.isArray(film?.genres)&&film.genres.length)out.genres=film.genres;
 return out;
}
function syncFields(film){
 const sync={
  metadataAt:instant(film?.metadataAt),
  synopsisFetchedAt:instant(film?.synopsisFetchedAt),
  peopleNamesVersion:Number.isInteger(film?.peopleNamesVersion)?film.peopleNamesVersion:null,
  peopleLocalizedAt:instant(film?.peopleLocalizedAt),
 };
 if(!sync.metadataAt&&!sync.synopsisFetchedAt&&sync.peopleNamesVersion==null&&!sync.peopleLocalizedAt)return null;
 return sync;
}

export function metadataFactsInput(snapshot,film,at){
 if(!snapshot?.film||!Number.isInteger(snapshot.film.contract_version))return null;
 const metadata=metadataFields(film);
 if(!metadata)return null;
 return {id:snapshot.film.id,at,requireExisting:true,film:{contractVersion:snapshot.film.contract_version},metadata};
}
export function syncFactsInput(snapshot,film,at){
 if(!snapshot?.film||!Number.isInteger(snapshot.film.contract_version))return null;
 const sync=syncFields(film);
 if(!sync)return null;
 return {id:snapshot.film.id,at,requireExisting:true,film:{contractVersion:snapshot.film.contract_version},sync};
}

export function titleSourceOf(film,titles){
 const row=plain(titles)?titles[film?.id]:null;
 if(!plain(row)||!present(row.title)||row.status==='reviewed')return null;
 const observedAt=instant(film?.peopleLocalizedAt)||instant(film?.metadataAt)||instant(row.updatedAt);
 if(!observedAt)return null;
 const sourceVersion=present(row.sources?.[0])?String(row.sources[0]).slice(0,120):'wikidata';
 return {kind:'film',id:null,source:{source:'wikidata',value:row.title.trim(),sourceVersion,provenance:{sources:Array.isArray(row.sources)?row.sources:[]},observedAt}};
}
export function personSourcesOf(film,people){
 const out=[];
 const observedAt=instant(film?.peopleLocalizedAt)||instant(film?.metadataAt);
 if(!observedAt||!plain(people))return out;
 for(const person of [...(film?.directors||[]),...(film?.actors||[])]){
  const row=people[person?.id];
  if(!plain(row)||!present(row.name))continue;
  const id=canonicalPersonId(person.id);
  if(!id)continue;
  out.push({kind:'person',id,source:{source:'wikidata',value:row.name.trim(),sourceVersion:present(row.original)?row.original:'wikidata',provenance:{original:row.original??null},observedAt}});
 }
 return out;
}

export async function factsKindDigest(operation,input){
 return digestOf({operation,id:input?.id,content:filmFactsContent(input)});
}

export function factsKindOperation(operation,{replan,now=()=>new Date().toISOString()}={}){
 if((operation!==FILM_METADATA_OPERATION&&operation!==FILM_SYNC_OPERATION)||typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch(error){if(READ_FAILURES.has(error?.code))throw error;input=null;}
  if(!input)return null;
  return {input,ok:(await factsKindDigest(operation,input))===receipt.contentDigest};
 };
 return defineOperation({
  operation,atomic:true,
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   const snapshot=await readFilmSnapshot(env,target.id);
   if(!found)return {digest:null,revision:snapshot.revision};
   const present=!snapshot.redirect&&planFilmFacts(snapshot,{...found.input,requestId:receipt.requestId}).noop;
   return {digest:present?receipt.contentDigest:null,revision:snapshot.revision};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return writeFilmFacts(env,{...found.input,requestId:receipt.requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,now)});
  },
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const snapshot=await readFilmSnapshot(env,receipt.target.id);
   if(snapshot.redirect)return 'superseded';
   return planFilmFacts(snapshot,{...found.input,requestId:receipt.requestId}).noop?'superseded':'proceed';
  },
 });
}

async function planSources(env,input){
 const spec=TABLE[input?.kind];
 if(!spec||!Array.isArray(input.sources)||!input.sources.length)throw failed('localization_invalid');
 const id=input.id;
 const db=database(env);
 const revision=await revisionOf(db,spec.entity,id);
 const exists=await one(db,spec.entity==='film'?'SELECT 1 AS x FROM film WHERE id=?':'SELECT 1 AS x FROM person WHERE id=?',[id]);
 if(!exists)return {absent:true,noop:false,revision};
 if(spec.entity==='film'&&await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');
 const stored=await many(db,`SELECT source,value,source_version,request_id,observed_at FROM ${spec.table} WHERE ${spec.column}=?`,[id]).catch(error=>{throw failed('localization_source_unavailable',error);});
 const known=new Map(stored.map(row=>[row.source,row]));
 let write=0;
 for(const item of input.sources){
  const row=known.get(item.source);
  if(row&&!(item.observedAt>row.observed_at)&&row.request_id!==input.requestId)continue;
  if(row&&row.request_id===input.requestId)continue;
  if(!row||item.observedAt>row.observed_at)write++;
 }
 return {absent:false,noop:write===0,revision};
}

async function planConflictRows(env,input){
 const rows=planConflicts(input.kind,input.id,input.conflicts);
 const db=database(env);
 const revision=await revisionOf(db,input.kind,input.id);
 const exists=await one(db,input.kind==='film'?'SELECT 1 AS x FROM film WHERE id=?':'SELECT 1 AS x FROM person WHERE id=?',[input.id]);
 if(!exists)return {absent:true,noop:false,revision};
 if(input.kind==='film'&&await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[input.id]))throw failed('film_person_redirect');
 const have=new Set((await many(db,`SELECT id FROM localization_conflict WHERE id IN (${rows.map(()=>'?').join(',')})`,rows.map(row=>row[0]))).map(row=>row.id));
 return {absent:false,noop:rows.every(row=>have.has(row[0])),revision};
}

export function localizationSourceContent(input){
 if(!plain(input)||!TABLE[input.kind]||typeof input.id!=='string'||!input.id.startsWith(input.kind+':')||!Array.isArray(input.sources)||!input.sources.length)throw failed('film_person_invalid');
 return {kind:input.kind,sources:input.sources.map(item=>({source:item.source,value:item.value,sourceVersion:item.sourceVersion,provenance:item.provenance??null,observedAt:item.observedAt}))};
}
export function localizationConflictContent(input){
 if(!plain(input)||(input.kind!=='film'&&input.kind!=='person')||typeof input.id!=='string'||!Array.isArray(input.conflicts)||!input.conflicts.length)throw failed('film_person_invalid');
 return {kind:input.kind,conflicts:input.conflicts.map(item=>({value:item.value??null,source:item.source??null,reason:item.reason,at:item.at,provenance:item.provenance??null}))};
}

export async function localizationDigest(operation,input){
 const content=operation===LOCALIZATION_SOURCE_OPERATION?localizationSourceContent(input):localizationConflictContent(input);
 return digestOf({operation,id:input?.id,content});
}

export function localizationSourceOperation({replan,now=()=>new Date().toISOString()}={}){
 return locOperation(LOCALIZATION_SOURCE_OPERATION,{replan,now,plan:planSources,write:(env,input,requestId,ctx,clock)=>recordLocalizationSources(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)})});
}
export function localizationConflictOperation({replan,now=()=>new Date().toISOString()}={}){
 return locOperation(LOCALIZATION_CONFLICT_OPERATION,{replan,now,plan:planConflictRows,write:(env,input,requestId,ctx,clock)=>recordLocalizationConflicts(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)})});
}

function locOperation(operation,{replan,now,plan,write}){
 if(typeof replan!=='function')throw failed('film_person_invalid');
 const planned=async receipt=>{
  let input=null;
  try{input=await replan(receipt);}catch(error){if(READ_FAILURES.has(error?.code))throw error;input=null;}
  if(!input)return null;
  let ok=false;
  try{ok=(await localizationDigest(operation,input))===receipt.contentDigest;}catch{ok=false;}
  return {input,ok};
 };
 return defineOperation({
  operation,atomic:true,
  readback:async(env,target,receipt)=>{
   const found=await planned(receipt);
   if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};
   if(!found)return {digest:null,revision:await revisionOf(database(env),target.kind,target.id)};
   const snap=await plan(env,found.input);
   return {digest:snap?.noop?receipt.contentDigest:null,revision:snap?snap.revision:await revisionOf(database(env),target.kind,target.id)};
  },
  replay:async(env,receipt,ctx)=>{
   const found=await planned(receipt);
   if(!found)throw failed('producer_replan_unavailable');
   if(!found.ok)throw failed('film_person_invalid');
   return write(env,found.input,receipt.requestId,ctx,now);
  },
  revalidate:async(env,receipt)=>{
   const found=await planned(receipt);
   if(!found||!found.ok)return 'stale';
   const snap=await plan(env,found.input);
   if(!snap)return 'stale';
   return snap.absent||snap.noop?'superseded':'proceed';
  },
 });
}

export function metadataSyncOperations({replan=async()=>null,now}={}){
 return [
  factsKindOperation(FILM_METADATA_OPERATION,{replan,now}),
  factsKindOperation(FILM_SYNC_OPERATION,{replan,now}),
  localizationSourceOperation({replan,now}),
  localizationConflictOperation({replan,now}),
 ];
}

async function applyFacts(operation,env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 const digest=await factsKindDigest(operation,input);
 const target={kind:'film',id:input.id};
 const requestId=await producerRequestId({origin,operation,event,target,digest});
 const clock=clockOf(now);
 const snapshot=await readFilmSnapshot(env,input.id);
 if(input.requireExisting===true&&!snapshot.film)throw failed('film_person_precondition');
 const plan=planFilmFacts(snapshot,{...input,requestId});
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const spec=factsKindOperation(operation,{replan:replan||(async()=>input),now:clock});
 const outcome=await receiptedWrite(env,{requestId,operation,origin,target,expectedRevision:snapshot.revision,digest,now:clock,policy},{
  atomic:true,readback:spec.readback,revalidate:spec.revalidate,
  run:ctx=>writeFilmFacts(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)}),
 });
 return {...outcome,requestId};
}

async function applyLoc(operation,env,{origin,event,input,replan,now,policy=RETRY_POLICY}={}){
 const route=await writerRoute(env);
 if(route.writer!=='canonical')return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 const digest=await localizationDigest(operation,input);
 const target={kind:input.kind,id:input.id};
 const requestId=await producerRequestId({origin,operation,event,target,digest});
 const clock=clockOf(now);
 const plan=operation===LOCALIZATION_SOURCE_OPERATION?await planSources(env,{...input,requestId}):await planConflictRows(env,input);
 if(plan.absent)return {state:'absent',receipt:false,requestId};
 if(plan.noop)return {state:'noop',receipt:false,requestId};
 const spec=operation===LOCALIZATION_SOURCE_OPERATION?localizationSourceOperation({replan:replan||(async()=>input),now:clock}):localizationConflictOperation({replan:replan||(async()=>input),now:clock});
 const write=operation===LOCALIZATION_SOURCE_OPERATION
  ?(ctx=>recordLocalizationSources(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)}))
  :(ctx=>recordLocalizationConflicts(env,{...input,requestId,expectedRevision:ctx.currentRevision,receiptMark:mark(ctx,clock)}));
 const outcome=await receiptedWrite(env,{requestId,operation,origin,target,expectedRevision:plan.revision,digest,now:clock,policy},{
  atomic:true,readback:spec.readback,revalidate:spec.revalidate,run:write,
 });
 return {...outcome,requestId};
}

export const applyFilmMetadata=(env,options)=>applyFacts(FILM_METADATA_OPERATION,env,options);
export const applyFilmSyncState=(env,options)=>applyFacts(FILM_SYNC_OPERATION,env,options);
export const applyLocalizationSource=(env,options)=>applyLoc(LOCALIZATION_SOURCE_OPERATION,env,options);
export const applyLocalizationConflict=(env,options)=>applyLoc(LOCALIZATION_CONFLICT_OPERATION,env,options);

async function conflictsFor(env,kind,id,incoming,at){
 if(!incoming)return [];
 const map=await loadLocalizationInputs(env,kind,[id],{});
 const resolved=resolveLocalization(map.get(id)||{owner:null,reviewed:null,automatic:[]});
 const compared=compareLocalization(resolved,{status:'provisional',value:incoming.value,source:incoming.source,sourceVersion:incoming.sourceVersion,provenance:incoming.provenance,updatedAt:incoming.observedAt});
 if(compared.outcome!=='held_by_owner'&&compared.outcome!=='held_by_reviewed')return [];
 return [{value:incoming.value,source:incoming.source,reason:compared.outcome,at,provenance:incoming.provenance||{}}];
}

export function mergeMetadataSyncIntent(previous=[],next=[]){
 const map=new Map();
 for(const unit of previous||[])if(unit?.requestId)map.set(unit.requestId,unit);
 for(const unit of next||[])if(unit?.requestId)map.set(unit.requestId,unit);
 return [...map.values()];
}

export function metadataSyncSettled(out){
 if(!out||out.state==='skipped')return true;
 if(out.state==='incomplete')return false;
 return !(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.refused||0));
}

// Diagnostics stored on sync.json: counters and unit states only. Never the planned inputs (those stay on
// metadataSyncIntent, and only while the current batch is unsettled).
export function metadataSyncRecord(out){
 if(!out)return null;
 const units=(out.units||[]).map(unit=>({kind:unit.kind,id:unit.id,state:unit.state,requestId:unit.requestId,receipted:!!unit.receipted,...(unit.errorClass?{errorClass:unit.errorClass}:{})}));
 return {state:out.state,applied:out.applied,noop:out.noop,skipped:out.skipped,failed:out.failed,absent:out.absent,unknown:out.unknown,preflightFailed:out.preflightFailed,refused:out.refused,units,reconciled:out.reconciled,refusedDetail:out.refusedDetail};
}

export function carryMetadataSyncIntent(out){
 if(!out||metadataSyncSettled(out))return [];
 return Array.isArray(out.intent)?out.intent:[];
}

export function metadataSyncRegistry(env,{intent=[],now}={}){
 const nowFn=clockOf(now);
 const byRequest=new Map((intent||[]).filter(unit=>unit?.requestId).map(unit=>[unit.requestId,unit]));
 const replan=async receipt=>byRequest.get(receipt.requestId)?.input??null;
 return operationRegistry(metadataSyncOperations({replan,now:nowFn}));
}

export async function planMetadataSyncIntent(env,{event,films=[],titles={},people={},failedIds=[],now}={}){
 const nowFn=clockOf(now);
 const origin=METADATA_SYNC_ORIGIN;
 const failed=new Set(failedIds);
 const units=[],refused=[],absent=[];
 for(const film of films){
  if(!film||failed.has(film.id))continue;
  let id=null;
  try{id=await resolveExistingFilmId(env,film);}
  catch(error){
   if(CLOSED.has(error?.code))throw error;
   refused.push({filmId:film.id,errorClass:error?.code||'unclassified',preflight:true});
   continue;
  }
  if(!id){absent.push(film.id);continue;}
  const at=instant(film.metadataAt)||instant(film.synopsisFetchedAt)||instant(film.peopleLocalizedAt)||nowFn();
  let snapshot;
  try{snapshot=await readFilmSnapshot(env,id);}
  catch(error){
   if(CLOSED.has(error?.code))throw error;
   refused.push({filmId:film.id,errorClass:error?.code||'unclassified',preflight:true});
   continue;
  }
  const ev=String(event||'')+':'+id;
  const push=async(operation,suffix,target,input)=>{
   if(!input)return;
   const digest=operation===FILM_METADATA_OPERATION||operation===FILM_SYNC_OPERATION?await factsKindDigest(operation,input):await localizationDigest(operation,input);
   const requestId=await producerRequestId({origin,operation,event:ev+suffix,target,digest});
   units.push({requestId,operation,origin,event:ev+suffix,target,input});
  };
  await push(FILM_METADATA_OPERATION,':metadata',{kind:'film',id},metadataFactsInput(snapshot,film,at));
  await push(FILM_SYNC_OPERATION,':sync',{kind:'film',id},syncFactsInput(snapshot,film,at));
  const title=titleSourceOf(film,titles);
  const sources=[];
  if(title)sources.push({kind:'film',id,source:title.source});
  sources.push(...personSourcesOf(film,people));
  for(const item of sources){
   const locInput={kind:item.kind,id:item.id,at,sources:[item.source]};
   await push(LOCALIZATION_SOURCE_OPERATION,':loc:'+item.kind+':'+item.id,{kind:item.kind,id:item.id},locInput);
   let held=[];
   try{held=await conflictsFor(env,item.kind,item.id,item.source,at);}catch(error){if(CLOSED.has(error?.code))throw error;}
   if(held.length)await push(LOCALIZATION_CONFLICT_OPERATION,':conflict:'+item.kind+':'+item.id,{kind:item.kind,id:item.id},{kind:item.kind,id:item.id,at,conflicts:held});
  }
 }
 return {units,refused,absent};
}

export async function applyMetadataSync(env,{event,films=[],titles={},people={},failedIds=[],intent:previousIntent=[],now,policy=RETRY_POLICY}={}){
 if(!(await producerRouteOpen(env)))return {state:'skipped',reason:'film_person_route_not_open',receipt:false};
 const nowFn=clockOf(now);
 const origin=METADATA_SYNC_ORIGIN;
 const planned=await planMetadataSyncIntent(env,{event,films,titles,people,failedIds,now:nowFn});
 const intent=mergeMetadataSyncIntent(previousIntent,planned.units);
 const counts={applied:0,noop:0,skipped:0,failed:0,absent:planned.absent.length,unknown:0,preflightFailed:planned.refused.filter(item=>item.preflight).length,refused:planned.refused.length};
 const outcomes=[];
 const applyOf={
  [FILM_METADATA_OPERATION]:(input,event)=>applyFilmMetadata(env,{origin,event,input,replan:async()=>input,now:nowFn,policy}),
  [FILM_SYNC_OPERATION]:(input,event)=>applyFilmSyncState(env,{origin,event,input,replan:async()=>input,now:nowFn,policy}),
  [LOCALIZATION_SOURCE_OPERATION]:(input,event)=>applyLocalizationSource(env,{origin,event,input,replan:async()=>input,now:nowFn,policy}),
  [LOCALIZATION_CONFLICT_OPERATION]:(input,event)=>applyLocalizationConflict(env,{origin,event,input,replan:async()=>input,now:nowFn,policy}),
 };
 for(const unit of intent){
  try{
   const out=await applyOf[unit.operation](unit.input,unit.event);
   const receipted=out.receipt!==false&&out.requestId;
   outcomes.push({kind:unit.operation,id:unit.target.id,state:out.state,requestId:out.requestId||unit.requestId,receipted:!!receipted});
   if(out.state==='applied'||out.state==='already')counts.applied++;
   else if(out.state==='noop')counts.noop++;
   else if(out.state==='absent')counts.absent++;
   else if(out.state==='skipped')counts.skipped++;
   else if(out.state==='unknown')counts.unknown++;
   else counts.failed++;
  }catch(error){
   if(CLOSED.has(error?.code))throw error;
   counts.failed++;
   outcomes.push({kind:unit.operation,id:unit.target.id,state:'failed',errorClass:error?.code||'unclassified',requestId:unit.requestId,receipted:false,preflight:true});
   counts.preflightFailed++;
  }
 }
 const operations=metadataSyncRegistry(env,{intent,now:nowFn});
 let reconciled={considered:0};
 try{reconciled=await reconcileOwnOrigin(env,{origin,operations,now:nowFn,policy});}catch(error){if(CLOSED.has(error?.code))throw error;counts.failed++;}
 const incomplete=counts.failed>0||counts.unknown>0||counts.preflightFailed>0||counts.refused>0;
 return {state:incomplete?'incomplete':'complete',...counts,units:outcomes,intent:incomplete?intent:[],reconciled,refusedDetail:planned.refused};
}
