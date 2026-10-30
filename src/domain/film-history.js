// Read-only history of one film: every prediction the bundle holds (current and replaced), every recorded rating event and
// every Letterboxd Diary entry linked to the film by its lid, as one chronological list. Pure functions over records a caller has already read; nothing here reads or writes storage.
// Contract: docs/reference/api/film-history.md. Missing historical fields stay null and are listed, never filled from today.
const FILM_HISTORY_SCHEMA_VERSION=1;
const FILM_HISTORY_DEFAULT_LIMIT=50,FILM_HISTORY_MAX_LIMIT=100;
const HISTORY_PREDICTION_FIELDS=['predictedRating','probability4Plus','confidence','matchSignals','mainRisk','moodLabels','generatedAt','tasteProfileVersion','tasteProfileHash','fingerprintHash','fingerprintSchemaVersion','fingerprintPromptVersion','predictionPromptVersion','runId','trigger'];
const HISTORY_TYPE_RANK={prediction:0,rating:1,legacy_rating:2,diary_viewing:3};
function historyValue(record,field){return record&&Object.hasOwn(record,field)&&record[field]!==undefined?record[field]:null;}
function historyTime(value){return typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(Date.parse(value)).toISOString():null;}
// One prediction record as an event. `version` is the caller's check of its immutable object: linked, missing, mismatch or none.
function predictionHistoryEvent(record,position,index,version){
 const fields=Object.fromEntries(HISTORY_PREDICTION_FIELDS.map(field=>[field,historyValue(record,field)]));
 const missing=HISTORY_PREDICTION_FIELDS.filter(field=>fields[field]===null);
 return {type:'prediction',at:historyTime(record?.generatedAt),position,replacedAt:position==='history'?historyTime(record?.replacedAt):null,...fields,
  version:version||{status:'none',r2Key:null,contentSha256:null},missingFields:missing,identity:'prediction|'+position+'|'+index};
}
// One entry of a fact record's ratingHistory. watchedAt is never known from a rating observation.
function ratingHistoryEvent(entry,occurrence){
 const kind=['first_observed','changed','rolled_back'].includes(entry?.kind)?entry.kind:'unknown';
 const at=historyTime(entry?.recordedAt)||historyTime(entry?.at)||historyTime(entry?.observedAt);
 const base={type:'rating',kind,at,recordedAt:historyTime(entry?.recordedAt),observationId:typeof entry?.observationId==='string'?entry.observationId:null,watchedAt:null};
 if(kind==='rolled_back')return {...base,value:null,observedAt:null,source:null,sourceRef:null,previous:null,restored:entry.restored?{value:historyValue(entry.restored,'value'),observedAt:historyTime(entry.restored.observedAt),source:historyValue(entry.restored,'source'),observationId:historyValue(entry.restored,'observationId')}:null,identity:'rating|r|'+base.observationId+'|'+occurrence};
 return {...base,value:Object.hasOwn(entry||{},'value')?entry.value:null,observedAt:historyTime(entry?.observedAt),source:historyValue(entry,'source'),sourceRef:historyValue(entry,'sourceRef'),
  previous:entry?.previous?{value:historyValue(entry.previous,'value'),observedAt:historyTime(entry.previous.observedAt),source:historyValue(entry.previous,'source'),observationId:historyValue(entry.previous,'observationId')}:null,restored:null,identity:'rating|a|'+base.observationId+'|'+occurrence};
}
// One entry of the legacy diagnostic log (written before the facts gate): a before/after pair seen by a scan or a page lookup.
function legacyRatingEvent(entry,index){
 return {type:'legacy_rating',at:historyTime(entry?.observedAt),observedAt:historyTime(entry?.observedAt),before:historyValue(entry,'before'),after:historyValue(entry,'after'),source:historyValue(entry,'source'),
  generationId:historyValue(entry,'generationId'),programmeRunId:historyValue(entry,'programmeRunId'),watchedAt:null,identity:'legacy|'+index};
}
// One Diary entry as an event. `at` is the diary's calendar date (`atPrecision: 'day'`), never a time and never `observedAt`.
// A day entry stays one event with its viewing count; it is never split into invented separate viewings.
function diaryViewingEvent(entry,link){
 const date=typeof entry?.watchedDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(entry.watchedDate)?entry.watchedDate:null;
 const day=entry?.keyBasis==='identity_date';
 return {type:'diary_viewing',at:date,atPrecision:'day',watchedDate:date,sourceKey:historyValue(entry,'key'),keyBasis:historyValue(entry,'keyBasis'),viewingId:historyValue(entry,'viewingId'),
  viewings:Number.isInteger(entry?.viewings)&&entry.viewings>0?entry.viewings:null,viewingsCertain:typeof entry?.viewingsCertain==='boolean'?entry.viewingsCertain:null,
  ratingAtEntry:historyValue(entry,'ratingAtEntry'),ratingsAtEntry:Array.isArray(entry?.ratingsAtEntry)?entry.ratingsAtEntry:null,
  rewatch:[true,false].includes(entry?.rewatch)?entry.rewatch:'unknown',rewatchRows:day?historyValue(entry,'rewatchRows'):null,rewatchUnknownRows:day?historyValue(entry,'rewatchUnknownRows'):null,
  lid:link.lid,linkedVia:link.via,slugs:(Array.isArray(entry?.aliases)?entry.aliases:[]).filter(alias=>alias?.type==='letterboxd_slug').map(alias=>({value:historyValue(alias,'value'),firstObservedAt:historyTime(alias?.firstObservedAt)})),
  firstObservedAt:historyTime(entry?.firstObservedAt),observedAt:historyTime(entry?.observedAt),page:historyValue(entry,'page'),
  changes:(Array.isArray(entry?.changes)?entry.changes:[]).map(change=>({field:historyValue(change,'field'),from:historyValue(change,'from'),to:historyValue(change,'to'),observedAt:historyTime(change?.observedAt)})),
  identity:'diary|'+String(entry?.key)};
}
// Which lid the Diary is read for. Candidates are the requested id when it is a lid and the lid of the film's fact record(s);
// a slug or a title is never one. One distinct lid links; none leaves the Diary unlinked; two that disagree link nothing,
// because nothing proves which of them is this film.
function diaryLink(candidates){
 const valid=candidates.filter(c=>typeof c?.lid==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(c.lid)),lids=[...new Set(valid.map(c=>c.lid))].sort();
 if(lids.length===1)return {status:'linked',lid:lids[0],via:[...new Set(valid.map(c=>c.via))].sort().join('+'),candidates:lids};
 return {status:lids.length?'ambiguous':'unlinked',lid:null,via:null,candidates:lids};
}
// Sort key: an instant as is; a day-only date after every instant of the same UTC date ('~' sorts after the time digits).
const historySortKey=event=>event.at===null?null:event.atPrecision==='day'?event.at+'T~':event.at;
function compareHistoryEvents(a,b){
 const ka=historySortKey(a),kb=historySortKey(b);
 if(ka!==kb){if(ka===null)return 1;if(kb===null)return -1;return ka<kb?-1:1;}
 const rank=HISTORY_TYPE_RANK[a.type]-HISTORY_TYPE_RANK[b.type];if(rank)return rank;
 return a.identity<b.identity?-1:a.identity>b.identity?1:0;
}
// Builds the full ordered list. `filmIds` are the stored ids of this film the legacy log may use (its lid and tmdb_<n>).
// `diary` is {history, link} from the route: the stored Diary history and the result of diaryLink; omitted, no Diary is read.
function buildFilmHistory({filmId,filmIds=[filmId],bundle=null,factRecord=null,legacyLog=null,profile=null,versionChecks={},diary=null}){
 const events=[],notes=[];
 const predictions=[];
 if(bundle&&typeof bundle==='object'){
  (Array.isArray(bundle.history)?bundle.history:[]).forEach((record,i)=>predictions.push({record,position:'history',index:i}));
  if(bundle.current)predictions.push({record:bundle.current,position:'current',index:0});
 }
 for(const {record,position,index} of predictions){
  const key=position+'|'+index;
  events.push(predictionHistoryEvent(record,position,index,versionChecks[key]));
 }
 const seen=new Map();
 for(const entry of Array.isArray(factRecord?.ratingHistory)?factRecord.ratingHistory:[]){
  const id=(entry?.kind==='rolled_back'?'r':'a')+'|'+entry?.observationId,n=seen.get(id)||0;seen.set(id,n+1);
  events.push(ratingHistoryEvent(entry,n));
 }
 const ids=new Set(filmIds.map(String));
 (Array.isArray(legacyLog)?legacyLog:[]).forEach((entry,i)=>{if(ids.has(String(entry?.filmId)))events.push(legacyRatingEvent(entry,i));});
 const diaryEntries=diary?.link?.status==='linked'?Object.values(diary.history?.entries||{}).filter(entry=>entry?.identity?.type==='letterboxd_lid'&&entry.identity.value===diary.link.lid):[];
 for(const entry of diaryEntries)events.push(diaryViewingEvent(entry,diary.link));
 events.sort(compareHistoryEvents);
 if(predictions.some(p=>!historyTime(p.record?.generatedAt)))notes.push('prediction_without_time');
 if(events.some(e=>e.type==='prediction'&&(e.fingerprintPromptVersion===null||e.runId===null)))notes.push('prediction_lineage_unknown');
 if(factRecord?.rating&&!(factRecord.ratingHistory||[]).length)notes.push('rating_history_starts_after_current_value');
 if(events.some(e=>e.type==='rating'&&e.kind==='first_observed'))notes.push('first_observed_is_not_a_rating_date');
 if(diary){
  const viewings=events.filter(e=>e.type==='diary_viewing');
  if(diary.link?.status==='ambiguous')notes.push('diary_identity_disagreement');
  else if(diary.link?.status==='unlinked')notes.push('diary_unlinked');
  if(viewings.some(e=>e.viewingsCertain!==true))notes.push('diary_viewings_lower_bound');
  if(viewings.some(e=>e.rewatch==='unknown'||e.rewatchUnknownRows>0))notes.push('diary_rewatch_unknown');
  if(viewings.some(e=>e.at===null))notes.push('diary_entry_without_date');
  const dated=new Set(events.filter(e=>e.at!==null&&e.atPrecision!=='day').map(e=>e.at.slice(0,10)));
  if(viewings.some(e=>e.at!==null&&dated.has(e.at)))notes.push('diary_same_day_order_unknown');
  const days=new Set(viewings.filter(e=>e.keyBasis==='identity_date').map(e=>e.watchedDate));
  if(viewings.some(e=>e.keyBasis==='viewing_id'&&days.has(e.watchedDate)))notes.push('diary_entries_may_overlap');
  notes.push('diary_absence_is_not_unwatched');
 }
 const current=bundle?.current||null;
 return {
  events,notes,
  current:{
   prediction:current?{generatedAt:historyTime(current.generatedAt),contentSha256:historyValue(current,'contentSha256'),
    matchesCurrentProfile:profile&&current.tasteProfileVersion!=null?current.tasteProfileVersion===profile.version&&current.tasteProfileHash===profile.profileHash:null}:null,
   rating:factRecord?.rating?{value:historyValue(factRecord.rating,'value'),observedAt:historyTime(factRecord.rating.observedAt),source:historyValue(factRecord.rating,'source'),observationId:historyValue(factRecord.rating,'observationId'),watchedAt:null}:null
  }
 };
}
// Limit and cursor. The cursor is the offset plus a digest of the source versions it was issued for.
function filmHistoryPageRequest(params){
 const raw=params.get('limit');let limit=FILM_HISTORY_DEFAULT_LIMIT;
 if(raw!==null){if(!/^\d{1,3}$/.test(raw)||Number(raw)<1||Number(raw)>FILM_HISTORY_MAX_LIMIT)return {error:'limit must be 1..'+FILM_HISTORY_MAX_LIMIT};limit=Number(raw);}
 const cursor=params.get('cursor');let offset=0,digest=null;
 if(cursor!==null){const match=/^(\d{1,6})\.([0-9a-f]{16})$/.exec(cursor);if(!match)return {error:'Invalid cursor'};offset=Number(match[1]);digest=match[2];}
 return {limit,offset,digest};
}
