// AIR-650 / ADR 0216 (Accepted), delivery graph step 6, decision 6a: the multi-alias Film history reader and its cursor contract.
// DORMANT, OFFLINE: nothing in the Worker imports this module (it is not bundled and registers no route), so the legacy
// GET /api/enrichment/history keeps its contract, the aggregate's `history` section stays `limited`/`unavailable`, and no consumer is switched.
// The consumer migration and any activation are the next card (AIR-651), with its own owner GO. This module reads and writes nothing of its own:
// the D1 reads are the AIR-646 resolver and the AIR-647 candidate coverage (single plain SELECTs behind the counted binding); every other source
// is an injected reader that the activation card wires to the owning domain, under the contract below.
//
// What it adds over the legacy route (docs/reference/api/film-history.md), exactly the list of decision 6a:
//  * every typed id of decision 2 is accepted (the resolver), all authorized aliases are read (decision 6b), never a ratings-only key;
//  * stable event identities `<storageId>|<sourceEventId>` and the deduplication of decision 6 (one fact reachable through two aliases is one event);
//  * a cursor bound to the canonical survivor, the alias set, the identity read-set digest, the candidate-coverage token and the source tokens;
//  * typed invalidation `409 history_changed` with `identity_moved`, `alias_set_changed`, `coverage_changed` or `source_changed`;
//  * `present` only with complete candidate coverage, every source readable and valid, and a complete Diary read; otherwise `partial`.
// The event shapes are the legacy builders' own (src/domain/film-history.js, loaded below), and the one-hop migration overlay is the legacy reader's own
// (LetterboxdFacts.overlay) and its rating invariant (LetterboxdFacts.validValue), and the immutable-version pointer rule is the maintained one
// (predictionVersionLinked), so the readers cannot drift apart.
//
// Ratings facts are NOT read a second time: the fact records come from the bounded G1 evidence of `readRatings` (the same bytes the coverage read and
// the after-statement fences), reached only through the proven path of an authorized seed. An injected reader can neither add a record nor change one.
//
// Source contract (every injected reader): `reader(args, {budget, limits})` -> {status, token, bytes, scanned, value?}.
//   status  `recorded` | `missing` | `unreadable` | `over_cap`; a recorded value of the wrong shape is `invalid` (never read as empty).
//   token   REQUIRED non-empty string for every status: the object's etag, or for `missing` an explicit absence predicate naming the authority and
//           generation that proves it. A result without a usable token is refused (the history is `unavailable`).
//   bytes, scanned  what the reader read and examined; they must not exceed `limits` (the reader stops before materializing past them and answers
//           `over_cap`; the reader here re-checks what was reported). A reader filters at the source with `args` (the authorized ids), so unrelated
//           entries of a shared document are never materialized.
//   budget  the request's counted 40-statement budget object; a D1-backed reader charges it and throws {code:'budget_exceeded'} when it cannot pay.
// `recheck(list, {budget, limits})` is REQUIRED and is a source read like the others: it re-reads the token and status (or absence predicate) of every item
// of `list` after all reads (E1) and answers {tokens:[{source,key,status,token}], bytes, scanned}; the reader compares them with what it read. It charges the
// same counted budget and answers within `limits.recheck`; a budget error is the typed `budget_exceeded`, never a "move". The shared ratings fence runs after it.
// The per-source limits are CONTRACTUAL obligations of the adapters the activation card wires (AIR-651): this module checks what an adapter reports against
// them, it does not prove that an adapter really stopped before materializing.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {database} from './film-person-authority.js';
import {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET} from './film-aggregate-resolver.js';
import {aliases as authorizedAliases,readRatings,countedDatabase} from './film-aggregate.js';

export const FILM_HISTORY_AGGREGATE_CONTRACT='film-history-aggregate/v1';
export const HISTORY_DEFAULT_LIMIT=50;
export const HISTORY_MAX_LIMIT=100;
// Work bound of one request: more events than this is `unavailable`, never a silently truncated history. It is checked while events are collected.
export const HISTORY_MAX_EVENTS=10000;
// Per-source work bounds a reader must honour before it materializes anything (bytes read and entries examined).
export const HISTORY_SOURCE_LIMITS=Object.freeze({
 predictions:Object.freeze({maxBytes:1000000,maxScanned:5000}),
 legacyLog:Object.freeze({maxBytes:4000000,maxScanned:50000}),
 profile:Object.freeze({maxBytes:200000,maxScanned:1}),
 diaryHistory:Object.freeze({maxBytes:8000000,maxScanned:100000}),
 diaryState:Object.freeze({maxBytes:50000,maxScanned:1}),
 predictionVersion:Object.freeze({maxBytes:2000000,maxScanned:1}),
 // The token readback of the E1 recheck: one token per consumed object, never a body.
 recheck:Object.freeze({maxBytes:100000,maxScanned:256}),
});
export const HISTORY_CHANGED_REASONS=['identity_moved','alias_set_changed','coverage_changed','source_changed'];

const legacy=vm.runInNewContext(fs.readFileSync(new URL('./domain/film-history.js',import.meta.url),'utf8')
 +'\n;({historyTime,historyValue,predictionHistoryEvent,ratingHistoryEvent,legacyRatingEvent,diaryViewingEvent,compareHistoryEvents})',{});
const letterboxdFacts=vm.runInNewContext(fs.readFileSync(new URL('./letterboxd-facts.js',import.meta.url),'utf8')+'\n;LetterboxdFacts',{});
const versionRule=vm.runInNewContext(fs.readFileSync(new URL('./domain/prediction-versions.js',import.meta.url),'utf8')+'\n;({predictionVersionLinked})',{});
const plain=value=>JSON.parse(JSON.stringify(value));
const digestOf=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventIdOf=(storageId,sourceEventId)=>storageId+'|'+sourceEventId;
export {eventIdOf as historyEventId};
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

// ---- cursor ----
// h1.<offset>.<survivor>.<aliases>.<identity>.<coverage>.<sources>, 12 hex characters per binding.
const COMPONENTS=['survivor','aliases','identity','coverage','sources'];
const CURSOR=/^h1\.(\d{1,6})\.([0-9a-f]{12})\.([0-9a-f]{12})\.([0-9a-f]{12})\.([0-9a-f]{12})\.([0-9a-f]{12})$/;
const short=token=>token.slice(7,19);
export function encodeHistoryCursor(offset,tokens){return ['h1',offset,...COMPONENTS.map(name=>short(tokens[name]))].join('.');}
export function parseHistoryCursor(text){
 const match=CURSOR.exec(text);
 if(!match)return null;
 return {offset:Number(match[1]),bound:Object.fromEntries(COMPONENTS.map((name,i)=>[name,match[i+2]]))};
}
// Which binding a cursor no longer matches. The canonical survivor comes first; a changed alias set is reported as such even though it also moves the
// identity read-set (the alias set is derived from it), then the read-set itself, then the candidate coverage, then the sources.
export function historyCursorMismatch(parsed,tokens){
 const same=name=>parsed.bound[name]===short(tokens[name]);
 if(!same('survivor'))return 'identity_moved';
 if(!same('aliases'))return 'alias_set_changed';
 if(!same('identity'))return 'identity_moved';
 if(!same('coverage'))return 'coverage_changed';
 if(!same('sources'))return 'source_changed';
 return null;
}
export function parseHistoryPage({limit,cursor}={}){
 let size=HISTORY_DEFAULT_LIMIT;
 if(limit!==undefined&&limit!==null){
  if(!/^\d{1,3}$/.test(String(limit))||Number(limit)<1||Number(limit)>HISTORY_MAX_LIMIT)return {error:'limit must be 1..'+HISTORY_MAX_LIMIT};
  size=Number(limit);
 }
 if(cursor===undefined||cursor===null)return {limit:size,offset:0,cursor:null};
 const parsed=parseHistoryCursor(String(cursor));
 if(!parsed)return {error:'Invalid cursor'};
 return {limit:size,offset:parsed.offset,cursor:parsed};
}

// ---- the fact records of the authorized seeds, from the shared G1 evidence ----
// One proven path per seed: the seed's fact key, followed one hop by the same rule the coverage walk used. A redirect reads the target (as the legacy
// route does); a migration reads the overlay of source and target (the legacy overlay), stored under the target key. A seed with no proven path, a record
// the evidence does not hold, or a record whose history is malformed is UNPROVEN: it contributes nothing and the rating facts are never certified.
// -> {facts:[{factKey, aliases, record}], proven:boolean}
export function factsFromEvidence(seeds,evidence){
 const byKey=new Map();
 let proven=true;
 const put=(factKey,alias,record,overlaid,source=null)=>{
  const held=byKey.get(factKey);
  // An overlay is the union of its records, so it supersedes a plain read of the same target key; two plain reads of one key are the same shared bytes.
  // Two different migrating sources of one target are merged as the union of both and the target (the overlay is idempotent): no source's events are lost.
  if(!held||(overlaid&&!held.overlaid))byKey.set(factKey,{factKey,aliases:new Set([...(held?.aliases||[]),alias]),record,overlaid,sources:new Set(overlaid?[source.factKey]:[])});
  else{
   held.aliases.add(alias);
   if(overlaid&&!held.sources.has(source.factKey)){held.record=letterboxdFacts.overlay(source.value,held.record);held.sources.add(source.factKey);}
  }
 };
 // A fact record the history can use: its history is a list of objects, and a rating, when present, is an object with an explicit `value` member that holds the
 // maintained rating invariant (0.5..5 in half-star steps, or null for a known unrated state). A rating without a value member, or out of range, is not a known state.
 const sound=value=>isObject(value)&&(value.ratingHistory===undefined||Array.isArray(value.ratingHistory)&&value.ratingHistory.every(isObject))
  &&(value.rating===undefined||value.rating===null||isObject(value.rating)&&Object.hasOwn(value.rating,'value')&&(value.rating.value===null||letterboxdFacts.validValue('rating',value.rating.value)));
 for(const seed of seeds){
  const root=evidence?.seedRoots?.[seed],path=evidence?.paths?.[root],start=evidence?.records?.[root];
  if(root===undefined||!path||!start||!sound(start.value)){proven=false;continue;}
  if(!start.kind){put(root,seed,start.value,false);continue;}
  const hop=path[1],end=hop===undefined?null:evidence.records[hop];
  if(!end||end.kind||!sound(end.value)){proven=false;continue;}
  if(start.kind==='redirect')put(hop,seed,end.value,false);
  else put(hop,seed,letterboxdFacts.overlay(start.value,end.value),true,{factKey:root,value:start.value});
 }
 return {facts:[...byKey.values()].map(item=>({factKey:item.factKey,aliases:[...item.aliases].sort(),record:item.record})).sort((a,b)=>a.factKey<b.factKey?-1:1),proven};
}

// ---- pure assembly over records the caller has already read ----
// `facts` are [{factKey, aliases:[<link-index alias>], record}] (see factsFromEvidence). `bundles` maps an authorized storage id to its prediction bundle,
// or to null when that source was not readable and valid. `diary.history` is the stored Diary history; only entries of an authorized lid join.
// `proof` says which inputs were readable and valid: {predictions, ratings}; a current value is stated as present/absent only with that proof (and with
// complete coverage), a known conflict is kept without it.
const PREDICTION_VALUE_FIELDS=['predictedRating','probability4Plus','confidence'];
export function buildAliasHistory({lids=[],movies=[],bundles={},facts:factList=[],legacyLog=null,diary=null,profile=null,coverageComplete=false,candidateLids=[],proof={predictions:true,ratings:true}}){
 const storageIds=[...lids,...movies.map(n=>'tmdb_'+n)].sort(),known=new Set(storageIds);
 const byId=new Map(),notes=new Set(),records=new Map();
 const add=(event,storageId,sourceEventId,holders)=>{
  const identity=eventIdOf(storageId,sourceEventId),seen=byId.get(identity);
  if(seen){
   // The same fact reached through another alias: one event, every alias that reached it.
   seen.storageIds=[...new Set([...seen.storageIds,...holders])].sort();
   return seen;
  }
  if(byId.size>=HISTORY_MAX_EVENTS){const error=new Error('history_too_large');error.code='history_too_large';throw error;}
  const next={...plain(event),identity,storageId,storageIds:[...holders].sort()};
  byId.set(identity,next);
  return next;
 };
 // Predictions: one bundle per authorized storage id; two events under two aliases stay two events (decision 6).
 for(const storageId of storageIds){
  const bundle=bundles[storageId];
  if(!isObject(bundle))continue;
  const rows=[...(Array.isArray(bundle.history)?bundle.history:[]).map((record,i)=>({record,position:'history',index:i})),...(bundle.current?[{record:bundle.current,position:'current',index:0}]:[])];
  for(const {record,position,index} of rows){
   const event=add(legacy.predictionHistoryEvent(record,position,index),storageId,'prediction|'+position+'|'+index,[storageId]);
   records.set(event.identity,{record,storageId,position});
  }
 }
 // Ratings: one fact key is one source of events whatever alias reached it.
 for(const {factKey,aliases,record} of factList){
  const seen=new Map();
  for(const entry of Array.isArray(record?.ratingHistory)?record.ratingHistory:[]){
   const id=(entry?.kind==='rolled_back'?'r':'a')+'|'+entry?.observationId,occurrence=seen.get(id)||0;seen.set(id,occurrence+1);
   const event=legacy.ratingHistoryEvent(entry,occurrence);
   add(event,'fact:'+factKey,event.identity,aliases);
  }
  if(record?.rating&&!(record.ratingHistory||[]).length)notes.add('rating_history_starts_after_current_value');
 }
 // The legacy diagnostic log: entries of an authorized storage id only; an entry counts once whatever alias it names.
 for(const entry of Array.isArray(legacyLog)?legacyLog:[]){
  const id=String(entry?.filmId);
  // The identity uses the entry's ORIGINAL ordinal in the stored log, so filtering upstream never renumbers an event.
  if(known.has(id)){const event=legacy.legacyRatingEvent(entry,entry.ordinal);add(event,'legacy-log',event.identity,[id]);}
 }
 // Diary: every entry of every authorized lid; a candidate lid outside the authorized set is excluded and named.
 for(const entry of Object.values(diary?.history?.entries||{})){
  const lid=entry?.identity?.type==='letterboxd_lid'?entry.identity.value:null;
  if(lid===null||!lids.includes(lid))continue;
  const event=legacy.diaryViewingEvent(entry,{lid,via:'authorized_alias'});
  add(event,lid,event.identity,[lid]);
 }
 for(const lid of [...new Set(candidateLids)].sort())if(!lids.includes(lid))notes.add('diary_lid_not_authorized:'+lid);
 const events=[...byId.values()].sort(legacy.compareHistoryEvents);
 // Notes: known gaps of the history.
 const typed=type=>events.filter(e=>e.type===type);
 if(events.some(e=>e.type==='prediction'&&!e.at))notes.add('prediction_without_time');
 if(typed('prediction').some(e=>e.fingerprintPromptVersion===null||e.runId===null))notes.add('prediction_lineage_unknown');
 if(typed('rating').some(e=>e.kind==='first_observed'))notes.add('first_observed_is_not_a_rating_date');
 if(diary){
  notes.add('diary_absence_is_not_unwatched');
  const viewings=typed('diary_viewing');
  if(viewings.some(e=>e.viewingsCertain!==true))notes.add('diary_viewings_lower_bound');
  if(viewings.some(e=>e.rewatch==='unknown'||e.rewatchUnknownRows>0))notes.add('diary_rewatch_unknown');
  if(viewings.some(e=>e.at===null))notes.add('diary_entry_without_date');
  const dated=new Set(events.filter(e=>e.at!==null&&e.atPrecision!=='day'&&e.type!=='diary_viewing').map(e=>e.at.slice(0,10)));
  if(viewings.some(e=>e.at!==null&&dated.has(e.at)))notes.add('diary_same_day_order_unknown');
  const days=new Set(viewings.filter(e=>e.keyBasis==='identity_date').map(e=>e.watchedDate));
  if(viewings.some(e=>e.keyBasis==='viewing_id'&&days.has(e.watchedDate)))notes.add('diary_entries_may_overlap');
 }
 if(!coverageComplete)notes.add('coverage_incomplete');
 // Current values (decision 6, C2): the VALUES are compared, never the events that carry them. Two different values are a conflict with each value, its
 // storage identity and its provenance, no winner; equal values with different provenance agree. A single value is `present` and no value is `absent`
 // only with complete coverage and readable, valid inputs (`proof`); without them they are `partial` and `unknown`, and a known conflict is kept.
 const field=(values,valueKey,proved)=>{
  const distinct=new Set(values.map(v=>JSON.stringify(valueKey(v))));
  if(distinct.size>1)return {status:'conflict',values};
  const certain=coverageComplete&&proved;
  if(distinct.size===1)return {status:certain?'present':'partial',values};
  return {status:certain?'absent':'unknown',values:[]};
 };
 const predictions=[];
 for(const {record,storageId,position} of records.values()){
  if(position!=='current')continue;
  predictions.push({storageId,value:Object.fromEntries(PREDICTION_VALUE_FIELDS.map(name=>[name,legacy.historyValue(record,name)])),
   provenance:{generatedAt:legacy.historyTime(record.generatedAt),contentSha256:legacy.historyValue(record,'contentSha256'),runId:legacy.historyValue(record,'runId'),
    tasteProfileVersion:legacy.historyValue(record,'tasteProfileVersion'),tasteProfileHash:legacy.historyValue(record,'tasteProfileHash')},
   matchesCurrentProfile:profile&&record.tasteProfileVersion!=null?record.tasteProfileVersion===profile.version&&record.tasteProfileHash===profile.profileHash:null});
 }
 predictions.sort((a,b)=>a.storageId<b.storageId?-1:1);
 const ratings=factList.filter(fact=>isObject(fact.record?.rating)).map(fact=>({factKey:fact.factKey,storageIds:fact.aliases,value:legacy.historyValue(fact.record.rating,'value'),
  provenance:{observedAt:legacy.historyTime(fact.record.rating.observedAt),source:legacy.historyValue(fact.record.rating,'source'),observationId:legacy.historyValue(fact.record.rating,'observationId')},watchedAt:null}));
 const current={prediction:field(predictions,p=>p.value,proof.predictions),rating:field(ratings,r=>r.value,proof.ratings)};
 if(current.prediction.status==='conflict')notes.add('prediction_current_in_several_storage_ids');
 return {events,notes:[...notes].sort(),records,current};
}

// ---- the reader ----
class SourceFailure extends Error{constructor(reason,source){super(reason);this.code=reason;this.source=source;}}
function reasonOf(error){
 const code=String(error?.code||'');
 if(['budget_exceeded','history_too_large','history_source_over_cap'].includes(code))return code;
 if(code.startsWith('prediction_'))return 'prediction_unavailable';
 if(code.startsWith('ratings_'))return 'ratings_unavailable';
 return 'history_source_unavailable';
}
const unavailableHistory=(reason,extra={})=>({history:{status:'unavailable',reason,token:null,tokenStatus:'unavailable',...extra}});
const nonNegative=value=>Number.isInteger(value)&&value>=0;
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const optional=(value,test)=>value===undefined||value===null||test(value);
const text=value=>typeof value==='string';
// A stored prediction record: the value that the history reports must be a number; the lineage fields of later writers stay optional.
const predictionRecord=record=>isObject(record)&&finite(record.predictedRating)&&optional(record.probability4Plus,finite)&&optional(record.confidence,text)&&optional(record.generatedAt,text);
// The recognized stored shapes. An envelope that holds nothing the history can read (`{}`, a bundle with neither member) is not a source: it is invalid.
const SHAPES={
 predictions:value=>isObject(value)&&(Object.hasOwn(value,'current')||Object.hasOwn(value,'history'))&&optional(value.current,predictionRecord)&&(value.history===undefined||Array.isArray(value.history)&&value.history.every(predictionRecord)),
 // Entries carry their ORIGINAL ordinal in the stored log (a reader that filters keeps it), unique, so an event never changes identity with the filter.
 legacyLog:value=>Array.isArray(value)&&value.every(entry=>isObject(entry)&&Number.isInteger(entry.ordinal)&&entry.ordinal>=0)&&new Set(value.map(entry=>entry.ordinal)).size===value.length,
 profile:value=>isObject(value)&&optional(value.version,finite)&&optional(value.profileHash,text),
 diaryHistory:value=>isObject(value)&&isObject(value.entries)&&Object.values(value.entries).every(isObject),
 diaryState:value=>isObject(value)&&text(value.lastOutcome),
};
const VERSION_STATUSES=['linked','missing','mismatch','invalid','unreadable','none'];
const READERS={predictions:'predictionBundle',legacyLog:'legacyLog',profile:'profile',diaryHistory:'diaryHistory',diaryState:'diaryState'};
// One source answer, checked against the contract. A broken contract (no usable token, no counts, counts over the limits, an unknown status) is a typed
// failure of the whole history, never an empty source. A recorded value of the wrong shape is `invalid`.
function accepted(source,result,limits){
 if(!isObject(result))throw new SourceFailure('history_source_unavailable',source);
 const {status,token,bytes,scanned}=result;
 if(!['recorded','missing','unreadable','over_cap'].includes(status)||typeof token!=='string'||!token.length||!nonNegative(bytes)||!nonNegative(scanned))throw new SourceFailure('history_source_unavailable',source);
 if(status==='over_cap'||bytes>limits.maxBytes||scanned>limits.maxScanned)throw new SourceFailure('history_source_over_cap',source);
 if(status!=='recorded')return {status,token,value:null};
 return !SHAPES[source](result.value)?{status:'invalid',token,value:null}:{status,token,value:result.value};
}

// The token readback of the recheck must name exactly the objects that were read, with the same status and token, within its limits.
function readbackMatches(expected,readback,limits){
 if(!isObject(readback)||!Array.isArray(readback.tokens)||!nonNegative(readback.bytes)||!nonNegative(readback.scanned))throw new SourceFailure('history_source_unavailable','recheck');
 if(readback.bytes>limits.maxBytes||readback.scanned>limits.maxScanned)throw new SourceFailure('history_source_over_cap','recheck');
 const flat=list=>list.map(item=>JSON.stringify([item?.source,item?.key,item?.status,item?.token])).sort();
 return JSON.stringify(flat(expected))===JSON.stringify(flat(readback.tokens));
}

// The sections reader. `sources`: predictionBundle({storageId}), legacyLog({storageIds}), profile({}), diaryHistory({lids}), diaryState({}),
// predictionVersion({storageId, record}) (page events only, optional) and recheck(list, {budget, limits}) (required); see the source contract above.
async function readHistorySection(env,resolution,budget,sources,page){
 const set=authorizedAliases(resolution);
 // A cursor of another canonical survivor never applies, whatever else this request can or cannot read; a Film without an authorized alias never issued one.
 if(page.cursor&&page.cursor.bound.survivor!==short(digestOf(resolution.filmId)))return {history:{status:'changed',reason:'identity_moved'}};
 if(!set.storageIds.length){
  if(page.cursor)return {history:{status:'changed',reason:'alias_set_changed'}};
  return {history:{status:'unknown',reason:'no_authorized_alias',token:null,tokenStatus:'unavailable'}};
 }
 if(typeof sources?.recheck!=='function')return unavailableHistory('source_recheck_missing');
 const ratings=await readRatings(countedDatabase(database(env),budget),budget,resolution,set);
 if(ratings.state!=='open')return unavailableHistory(ratings.state==='budget'?'budget_exceeded':ratings.reason);
 // The ratings fence reservation is consumed on every path: the E1 after-read below, or, when the history fails first, a best-effort read in `finally`.
 let consumed=false;
 const fence=async()=>{consumed=true;return ratings.after();};
 try{
  return await readOpenHistory(resolution,budget,sources,page,set,ratings,fence);
 }catch(error){
  return unavailableHistory(reasonOf(error),{source:error?.source??null});
 }finally{
  if(!consumed){try{await ratings.after();}catch{/* the reservation is spent; nothing more to do */}}
 }
}

async function readOpenHistory(resolution,budget,sources,page,set,ratings,fence){
 const coverage=ratings.coverage,complete=coverage.status==='complete';
 const list=[];
 const take=async(source,key,args)=>{
  const limits=HISTORY_SOURCE_LIMITS[source];
  const result=accepted(source,await sources[READERS[source]](args,{budget,limits}),limits);
  list.push({source,key,status:result.status,token:result.token});
  return result;
 };
 const bundles={};let predictionsProved=true;
 for(const storageId of set.storageIds){
  const result=await take('predictions',storageId,{storageId});
  bundles[storageId]=result.status==='recorded'?result.value:null;
  if(result.status==='unreadable'||result.status==='invalid')predictionsProved=false;
 }
 // The fact records are the shared G1 evidence, never a second read.
 const reached=factsFromEvidence(set.seeds,ratings.evidence);
 const legacyLog=await take('legacyLog','rating-observations',{storageIds:set.storageIds});
 const profile=await take('profile','profile',{});
 const diaryHistory=await take('diaryHistory','history',{lids:set.lids});
 const diaryState=await take('diaryState','state',{});

 const candidateLids=reached.facts.map(item=>item.record.links?.letterboxd).filter(lid=>typeof lid==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(lid));
 const built=buildAliasHistory({lids:set.lids,movies:set.movies,bundles,facts:reached.facts,legacyLog:legacyLog.value,diary:{history:diaryHistory.value},profile:profile.value,coverageComplete:complete,candidateLids,
  proof:{predictions:predictionsProved,ratings:reached.proven}});
 if(diaryHistory.status!=='recorded')built.notes.push('diary_history_'+diaryHistory.status);
 const state=diaryState.value,diaryComplete=diaryHistory.status==='recorded'&&diaryState.status==='recorded'&&state.lastOutcome==='complete'&&state.coverage?.reachedEnd===true&&!state.resumePage;
 if(!diaryComplete)built.notes.push('diary_coverage_partial');
 built.notes.sort();

 // The tokens. Fact records are bound through the coverage token (their etags are in it), so a changed record is `coverage_changed`; the sources digest
 // holds the objects the caller read. Version evidence is page-local and is deliberately not part of the cursor binding (below).
 const tokens={
  survivor:digestOf(resolution.filmId),
  aliases:digestOf({lids:[...set.lids].sort(),movies:[...set.movies].sort()}),
  identity:resolution.fence.digest,
  coverage:digestOf({status:coverage.status,reason:coverage.reason??null,token:coverage.token}),
  sources:digestOf(list.map(item=>[item.source,item.key,item.status,item.token]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1)),
 };
 if(page.cursor){
  const moved=historyCursorMismatch(page.cursor,tokens);
  if(moved)return {history:{status:'changed',reason:moved}};
  if(page.offset>built.events.length)return {history:{status:'invalid_cursor'}};
 }
 const slice=built.events.slice(page.offset,page.offset+page.limit);
 // Immutable-version verification of the events on this page, BEFORE the fences so a version reader that moves a source is caught. It is page-local:
 // it proves that this page's pointers resolved to bodies of the recorded hash at this read, and is not a cursor-wide proof (the pointers themselves are
 // part of the bundle token the cursor binds, the bodies are immutable by hash and are not read to paginate).
 const checks=[];
 let versionProblem=false;
 for(const event of slice){
  if(event.type!=='prediction')continue;
  const held=built.records.get(event.identity),record=held?.record;
  if(record?.r2Key==null&&record?.contentSha256==null)continue;
  // The maintained pointer rule (predictionVersionLinked): a key that parses as a version object of THIS storage id and names the record's own SHA-256. A
  // partial, malformed or foreign pointer is invalid and its body is never requested; `none` is only a record with both pointer fields absent (skipped above).
  if(!versionRule.predictionVersionLinked(record,held.storageId)){
   event.version={status:'invalid',r2Key:legacy.historyValue(record,'r2Key'),contentSha256:legacy.historyValue(record,'contentSha256')};
   versionProblem=true;
   continue;
  }
  let checked=null;
  if(typeof sources.predictionVersion==='function'){
   const limits=HISTORY_SOURCE_LIMITS.predictionVersion;
   const result=await sources.predictionVersion({storageId:held.storageId,record},{budget,limits});
   if(!isObject(result)||typeof result.status!=='string'||typeof result.token!=='string'||!result.token.length||!nonNegative(result.bytes)||!nonNegative(result.scanned))
    throw new SourceFailure('history_source_unavailable','predictionVersion');
   if(result.status==='over_cap'||result.bytes>limits.maxBytes||result.scanned>limits.maxScanned)throw new SourceFailure('history_source_over_cap','predictionVersion');
   if(!VERSION_STATUSES.includes(result.status))throw new SourceFailure('history_source_unavailable','predictionVersion');
   // Only `linked` certifies a pointer, and only when the answer names BOTH of the record's own fields.
   const named=result.r2Key===record.r2Key&&result.contentSha256===record.contentSha256;
   checked={...result,status:result.status==='linked'&&!named?'invalid':result.status};
   checks.push({source:'predictionVersion',key:record.r2Key,status:result.status,token:result.token});
  }
  event.version=checked?{status:checked.status,r2Key:checked.r2Key??null,contentSha256:checked.contentSha256??null}
   :{status:'unchecked',r2Key:legacy.historyValue(record,'r2Key'),contentSha256:legacy.historyValue(record,'contentSha256')};
  if(event.version.status!=='linked')versionProblem=true;
 }
 // E1: every source token, version evidence included, is read back AFTER all reads through the same counted, bounded read interface, and the shared ratings
 // fence (which fences the fact records) runs AFTER that phase, so a document that moves during the readback is caught. A budget error of the readback is the
 // typed `budget_exceeded` (it propagates), never a "move"; a readback that differs from what was read is `generation_moved`.
 const expected=plain([...list,...checks]);
 const readback=await sources.recheck(expected,{budget,limits:HISTORY_SOURCE_LIMITS.recheck});
 const same=readbackMatches(expected,readback,HISTORY_SOURCE_LIMITS.recheck);
 const ratingsHeld=await fence();
 if(!same||!ratingsHeld)return unavailableHistory('generation_moved');

 const unreadable=list.some(item=>item.status==='unreadable'||item.status==='invalid');
 const next=page.offset+page.limit<built.events.length?encodeHistoryCursor(page.offset+page.limit,tokens):null;
 const status=complete&&!unreadable&&diaryComplete&&reached.proven&&!versionProblem?'present':'partial';
 const reason=status==='present'?undefined:!complete?'coverage_incomplete':unreadable?'source_unreadable':!reached.proven?'ratings_facts_unproven':!diaryComplete?'diary_coverage_partial':'version_unverified';
 return {history:{
  status,...(reason?{reason}:{}),
  aliases:{lids:[...set.lids].sort(),movies:[...set.movies].sort(),storageIds:set.storageIds},
  coverage:{status:coverage.status,...(coverage.reason?{reason:coverage.reason}:{}),token:tokens.coverage},
  tokens,
  sources:Object.fromEntries(['predictions','legacyLog','profile','diaryHistory','diaryState'].map(name=>[name,list.filter(item=>item.source===name).map(item=>item.status).sort()])),
  current:built.current,partial:status!=='present',notes:built.notes,events:slice,
  page:{limit:page.limit,offset:page.offset,total:built.events.length,nextCursor:next},
 }};
}

// One page of one Film's history for a typed id (decision 2). -> {http, body}.
//  200 `{contract, identity, history}`; the identity verdicts of the resolver for 400/404/409/410/503 carry no history; a moved identity fence is
//  503 `identity_moved`; a cursor that no longer matches is 409 `{error:'history_changed', reason}`; a malformed limit or cursor is 400 before any read.
export async function readFilmHistory(env,input,{limit,cursor,sources,budgetLimit=REQUEST_STATEMENT_BUDGET}={}){
 const page=parseHistoryPage({limit,cursor});
 if(page.error)return {http:400,body:{contract:FILM_HISTORY_AGGREGATE_CONTRACT,error:'invalid_request',detail:page.error}};
 const out=await readFilmAggregateIdentity(env,input,{budgetLimit,sections:(resolution,budget)=>readHistorySection(env,resolution,budget,sources,page)});
 const body={...out.body,contract:FILM_HISTORY_AGGREGATE_CONTRACT};
 const status=body.history?.status;
 if(out.http===200&&status==='changed')return {http:409,body:{contract:FILM_HISTORY_AGGREGATE_CONTRACT,error:'history_changed',reason:body.history.reason,identity:body.identity,
  detail:'The stored history changed since this cursor was issued; start again without a cursor.'}};
 if(out.http===200&&status==='invalid_cursor')return {http:400,body:{contract:FILM_HISTORY_AGGREGATE_CONTRACT,error:'invalid_request',detail:'Invalid cursor'}};
 return {http:out.http,body};
}
