// AIR-650 / ADR 0216 (Accepted), delivery graph step 6, decision 6a: the multi-alias Film history reader and its cursor contract.
// DORMANT, OFFLINE: nothing in the Worker imports this module (it is not bundled and registers no route), so the legacy
// GET /api/enrichment/history keeps its contract, the aggregate's `history` section stays `limited`/`unavailable`, and no consumer is switched.
// The consumer migration and any activation are the next card (AIR-651), with its own owner GO. This module reads and writes nothing of its own:
// the D1 reads are the AIR-646 resolver and the AIR-647 candidate coverage (single plain SELECTs behind the counted binding); every other source
// is an injected reader that the activation card wires to the owning domain (prediction authority, ratings documents, R2 for the legacy log).
//
// What it adds over the legacy route (docs/reference/api/film-history.md), exactly the list of decision 6a:
//  * every typed id of decision 2 is accepted (the resolver), all authorized aliases are read (decision 6b), never a ratings-only key;
//  * stable event identities `<storageId>|<sourceEventId>` and the deduplication of decision 6 (one fact reachable through two aliases is one event);
//  * a cursor bound to the canonical survivor, the alias set, the identity read-set digest, the candidate-coverage token and the source tokens;
//  * typed invalidation `409 history_changed` with `identity_moved`, `alias_set_changed`, `coverage_changed` or `source_changed`;
//  * `present` only with complete candidate coverage and every source readable; incomplete coverage is `partial`, never `present`.
// The event shapes are the legacy builders' own (src/domain/film-history.js, loaded below), so the two readers cannot drift apart on a field.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {database} from './film-person-authority.js';
import {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET} from './film-aggregate-resolver.js';
import {aliases as authorizedAliases,readRatings,countedDatabase} from './film-aggregate.js';

export const FILM_HISTORY_AGGREGATE_CONTRACT='film-history-aggregate/v1';
export const HISTORY_DEFAULT_LIMIT=50;
export const HISTORY_MAX_LIMIT=100;
// Work bound of one request: more events than this is `unavailable`, never a silently truncated history.
export const HISTORY_MAX_EVENTS=10000;
export const HISTORY_CHANGED_REASONS=['identity_moved','alias_set_changed','coverage_changed','source_changed'];

const legacy=vm.runInNewContext(fs.readFileSync(new URL('./domain/film-history.js',import.meta.url),'utf8')
 +'\n;({historyTime,historyValue,predictionHistoryEvent,ratingHistoryEvent,legacyRatingEvent,diaryViewingEvent,compareHistoryEvents})',{});
const plain=value=>JSON.parse(JSON.stringify(value));
const digestOf=value=>'sha256:'+createHash('sha256').update(JSON.stringify(value)).digest('hex');
const eventIdOf=(storageId,sourceEventId)=>storageId+'|'+sourceEventId;
export {eventIdOf as historyEventId};

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

// ---- pure assembly over records the caller has already read ----
// `facts` are the fact records reached from the authorized seeds: [{factKey, aliases:[<link-index alias>], record}]; one fact key reached twice is merged.
// `bundles` maps an authorized storage id to its prediction bundle. `diary.history` is the stored Diary history; only entries of an authorized lid join.
export function buildAliasHistory({lids=[],movies=[],bundles={},facts=[],legacyLog=null,diary=null,profile=null,coverageComplete=false,candidateLids=[]}){
 const storageIds=[...lids,...movies.map(n=>'tmdb_'+n)].sort(),known=new Set(storageIds);
 const byId=new Map(),notes=new Set(),records=new Map();
 const add=(event,storageId,sourceEventId,holders)=>{
  const identity=eventIdOf(storageId,sourceEventId),next={...plain(event),identity,storageId,storageIds:[...holders].sort()},seen=byId.get(identity);
  if(!seen){byId.set(identity,next);return next;}
  // The same fact reached through another alias: one event, every alias that reached it. (A fact key is one record and a source keeps its own event ids unique,
  // so two different payloads can never share an identity.)
  seen.storageIds=[...new Set([...seen.storageIds,...next.storageIds])].sort();
  return seen;
 };
 // Predictions: one bundle per authorized storage id; two events under two aliases stay two events (decision 6).
 for(const storageId of storageIds){
  const bundle=bundles[storageId];
  if(!bundle||typeof bundle!=='object')continue;
  const rows=[...(Array.isArray(bundle.history)?bundle.history:[]).map((record,i)=>({record,position:'history',index:i})),...(bundle.current?[{record:bundle.current,position:'current',index:0}]:[])];
  for(const {record,position,index} of rows){
   const sourceEventId='prediction|'+position+'|'+index,event=add(legacy.predictionHistoryEvent(record,position,index),storageId,sourceEventId,[storageId]);
   records.set(event.identity,{record,storageId});
  }
 }
 // Ratings: one fact key is one source of events whatever alias reached it.
 const factsByKey=new Map();
 for(const fact of facts){
  const held=factsByKey.get(fact.factKey);
  if(held)held.aliases=[...new Set([...held.aliases,...fact.aliases])].sort();
  else factsByKey.set(fact.factKey,{factKey:fact.factKey,aliases:[...fact.aliases].sort(),record:fact.record});
 }
 for(const {factKey,aliases,record} of [...factsByKey.values()].sort((a,b)=>a.factKey<b.factKey?-1:1)){
  const seen=new Map();
  for(const entry of Array.isArray(record?.ratingHistory)?record.ratingHistory:[]){
   const id=(entry?.kind==='rolled_back'?'r':'a')+'|'+entry?.observationId,occurrence=seen.get(id)||0;seen.set(id,occurrence+1);
   const event=legacy.ratingHistoryEvent(entry,occurrence);
   add(event,'fact:'+factKey,event.identity,aliases);
  }
  if(record?.rating&&!(record.ratingHistory||[]).length)notes.add('rating_history_starts_after_current_value');
 }
 // The legacy diagnostic log: entries of an authorized storage id only; an entry counts once whatever alias it names.
 (Array.isArray(legacyLog)?legacyLog:[]).forEach((entry,i)=>{
  const id=String(entry?.filmId);
  if(known.has(id)){const event=legacy.legacyRatingEvent(entry,i);add(event,'legacy-log',event.identity,[id]);}
 });
 // Diary: every entry of every authorized lid; a candidate lid outside the authorized set is excluded and named.
 const diaryEvents=[];
 for(const entry of Object.values(diary?.history?.entries||{})){
  const lid=entry?.identity?.type==='letterboxd_lid'?entry.identity.value:null;
  if(lid===null||!lids.includes(lid))continue;
  const event=legacy.diaryViewingEvent(entry,{lid,via:'authorized_alias'});
  diaryEvents.push(add(event,lid,event.identity,[lid]));
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
 // Current values (decision 6): one distinct value is stated only with complete coverage, two are a conflict with each value and its storage id, no winner.
 const field=(values,key)=>{
  const distinct=new Set(values.map(key));
  if(distinct.size>1)return {status:'conflict',values};
  if(distinct.size===1)return {status:coverageComplete?'present':'partial',values};
  return {status:coverageComplete?'absent':'unknown',values:[]};
 };
 const predictions=[];
 for(const [id,{record,storageId}] of records){
  if(!id.includes('|prediction|current|'))continue;
  predictions.push({storageId,generatedAt:legacy.historyTime(record.generatedAt),contentSha256:legacy.historyValue(record,'contentSha256'),
   matchesCurrentProfile:profile&&record.tasteProfileVersion!=null?record.tasteProfileVersion===profile.version&&record.tasteProfileHash===profile.profileHash:null});
 }
 predictions.sort((a,b)=>a.storageId<b.storageId?-1:1);
 if(new Set(predictions.map(p=>p.generatedAt+'|'+p.contentSha256)).size>1)notes.add('prediction_current_in_several_storage_ids');
 const ratings=[...factsByKey.values()].filter(fact=>fact.record?.rating).map(fact=>({factKey:fact.factKey,storageIds:fact.aliases,value:legacy.historyValue(fact.record.rating,'value'),
  observedAt:legacy.historyTime(fact.record.rating.observedAt),source:legacy.historyValue(fact.record.rating,'source'),observationId:legacy.historyValue(fact.record.rating,'observationId'),watchedAt:null}));
 return {events,notes:[...notes].sort(),records,current:{prediction:field(predictions,p=>p.generatedAt+'|'+p.contentSha256),rating:field(ratings,r=>r.value+'|'+r.observationId)}};
}

// ---- the reader ----
const SOURCE_STATUS=new Set(['recorded','missing','unreadable']);
class SourceUnavailable extends Error{constructor(source,code){super(source+':'+code);this.source=source;this.code=code;}}
function reasonOf(error){
 const code=String(error?.code||'');
 if(code.startsWith('prediction_'))return 'prediction_unavailable';
 if(code.startsWith('ratings_'))return 'ratings_unavailable';
 return 'history_source_unavailable';
}
const normalized=(source,result)=>{
 if(!result||!SOURCE_STATUS.has(result.status)||(result.etag!=null&&typeof result.etag!=='string'))throw new SourceUnavailable(source,'malformed');
 return {status:result.status,etag:result.etag??null,value:result.status==='recorded'?result.value:null};
};
const unavailableHistory=(reason,extra={})=>({history:{status:'unavailable',reason,token:null,tokenStatus:'unavailable',...extra}});

// `sources` is the set of injected readers (each returns {status:'recorded'|'missing'|'unreadable', etag, value}; a throw is `unavailable`):
//   predictionBundle(storageId), factRecords(seeds) -> [{alias, factKey, status, etag, value}] (redirect/migration already followed, as the legacy route does),
//   legacyLog(), profile(), diaryHistory(), diaryState(), predictionVersion(storageId, record) -> {status, r2Key, contentSha256} (page events only, optional),
//   recheck(list) -> boolean, the E1 re-read of every source token after the reads (optional).
async function readHistorySection(env,resolution,budget,sources,page){
 const set=authorizedAliases(resolution);
 // A cursor of another canonical survivor never applies, whatever else this request can or cannot read; a Film without an authorized alias never issued one.
 if(page.cursor&&page.cursor.bound.survivor!==short(digestOf(resolution.filmId)))return {history:{status:'changed',reason:'identity_moved'}};
 if(!set.storageIds.length){
  if(page.cursor)return {history:{status:'changed',reason:'alias_set_changed'}};
  return {history:{status:'unknown',reason:'no_authorized_alias',token:null,tokenStatus:'unavailable'}};
 }
 const ratings=await readRatings(countedDatabase(database(env),budget),budget,resolution,set);
 if(ratings.state!=='open')return unavailableHistory(ratings.state==='budget'?'budget_exceeded':ratings.reason);
 const coverage=ratings.coverage,complete=coverage.status==='complete';
 const list=[];
 const take=async(source,key,run)=>{const result=normalized(source,await run());list.push({source,key,status:result.status,etag:result.etag});return result;};
 let bundles={},facts,legacyLog,profile,diaryHistory,diaryState;
 try{
  for(const storageId of set.storageIds)bundles[storageId]=(await take('predictions',storageId,()=>sources.predictionBundle(storageId))).value;
  const reached=await sources.factRecords(set.seeds);
  if(!Array.isArray(reached))throw new SourceUnavailable('facts','malformed');
  facts=reached.map(item=>({alias:item.alias,factKey:item.factKey,...normalized('facts',item)}));
  for(const item of facts)list.push({source:'facts',key:item.factKey,status:item.status,etag:item.etag});
  legacyLog=await take('legacyLog','rating-observations',()=>sources.legacyLog());
  profile=await take('profile','profile',()=>sources.profile());
  diaryHistory=await take('diaryHistory','history',()=>sources.diaryHistory());
  diaryState=await take('diaryState','state',()=>sources.diaryState());
 }catch(error){
  return unavailableHistory(error instanceof SourceUnavailable&&error.code==='malformed'?'history_source_unavailable':reasonOf(error),{source:error?.source??null});
 }
 // E1: the coverage reads and every source token are re-read after the reads; a difference is `generation_moved`, never a mixed answer.
 let held=false;
 try{held=(await ratings.after())&&(typeof sources.recheck!=='function'||await sources.recheck(plain(list))===true);}catch{held=false;}
 if(!held)return unavailableHistory('generation_moved');

 const factRecords=facts.filter(item=>item.status==='recorded'&&item.value&&typeof item.value==='object').map(item=>({factKey:item.factKey,aliases:[item.alias],record:item.value}));
 const candidateLids=factRecords.map(item=>item.record.links?.letterboxd).filter(lid=>typeof lid==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(lid));
 const built=buildAliasHistory({lids:set.lids,movies:set.movies,bundles,facts:factRecords,legacyLog:legacyLog.value,diary:{history:diaryHistory.value},profile:profile.value,coverageComplete:complete,candidateLids});
 if(built.events.length>HISTORY_MAX_EVENTS)return unavailableHistory('history_too_large');
 if(diaryHistory.status!=='recorded')built.notes.push('diary_history_'+diaryHistory.status);
 const state=diaryState.value,diaryComplete=state?.lastOutcome==='complete'&&state?.coverage?.reachedEnd===true&&!state?.resumePage;
 if(diaryHistory.status==='recorded'&&!diaryComplete)built.notes.push('diary_coverage_partial');
 built.notes.sort();

 const tokens={
  survivor:digestOf(resolution.filmId),
  aliases:digestOf({lids:[...set.lids].sort(),movies:[...set.movies].sort()}),
  identity:resolution.fence.digest,
  coverage:digestOf({status:coverage.status,reason:coverage.reason??null,token:coverage.token}),
  sources:digestOf(list.map(item=>[item.source,item.key,item.status,item.etag]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1)),
 };
 if(page.cursor){
  const moved=historyCursorMismatch(page.cursor,tokens);
  if(moved)return {history:{status:'changed',reason:moved}};
  if(page.offset>built.events.length)return {history:{status:'invalid_cursor'}};
 }
 const slice=built.events.slice(page.offset,page.offset+page.limit);
 let versionProblem=false;
 for(const event of slice){
  if(event.type!=='prediction')continue;
  const held=built.records.get(event.identity),record=held?.record;
  if(!record?.r2Key&&!record?.contentSha256)continue;
  const checked=typeof sources.predictionVersion==='function'?await sources.predictionVersion(held.storageId,record):null;
  event.version=checked&&typeof checked.status==='string'?{status:checked.status,r2Key:checked.r2Key??null,contentSha256:checked.contentSha256??null}
   :{status:'unchecked',r2Key:legacy.historyValue(record,'r2Key'),contentSha256:legacy.historyValue(record,'contentSha256')};
  if(['missing','mismatch','invalid','unchecked'].includes(event.version.status))versionProblem=true;
 }
 const unreadable=[...list].some(item=>item.status==='unreadable');
 const next=page.offset+page.limit<built.events.length?encodeHistoryCursor(page.offset+page.limit,tokens):null;
 const status=complete&&!unreadable&&!versionProblem?'present':'partial';
 const reason=status==='present'?undefined:!complete?'coverage_incomplete':unreadable?'source_unreadable':'version_unverified';
 return {history:{
  status,...(reason?{reason}:{}),
  aliases:{lids:[...set.lids].sort(),movies:[...set.movies].sort(),storageIds:set.storageIds},
  coverage:{status:coverage.status,...(coverage.reason?{reason:coverage.reason}:{}),token:tokens.coverage},
  tokens,
  sources:Object.fromEntries(['predictions','facts','legacyLog','profile','diaryHistory','diaryState'].map(name=>[name,list.filter(item=>item.source===name).map(item=>item.status).sort()])),
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
