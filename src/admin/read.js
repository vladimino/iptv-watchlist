// Owner-only read API behind the existing Cloudflare Access application: GET /api/admin/*. One request reads one published
// snapshot, the generation pointer, that generation's programme object, the two localization dictionaries (titles.json,
// people.json) and the owner-review overlay (admin/owner-reviews.json), projects Film and Person records from it in
// memory and pages them with the pure query library (AdminQuery).
// Nothing here lists the bucket, falls back to the root programme object, reads a lease, the resolution ledger, the
// discovery snapshot or an enrichment object, writes, starts work or calls another service. The contract is
// docs/reference/api/admin.md; the read model is docs/reference/domain/admin-read-contract.md.
const ADMIN_TITLES_KEY='titles.json',ADMIN_PEOPLE_KEY='people.json';
const ADMIN_LIMIT_DEFAULT=25,ADMIN_QUERY_MAX=200,ADMIN_CURSOR_MAX=4000,ADMIN_PIN_MAX=2000,ADMIN_ID_MAX=200;
const ADMIN_RUN_ID=/^[A-Za-z0-9_-]{1,80}$/;
const ADMIN_FILM_QUEUES=['localization-missing','localization-provisional','localization-conflict','identity-unresolved','identity-ambiguous','identity-rejected','metadata-missing','metadata-stale','metadata-failed','external-id-conflict'];
const ADMIN_PERSON_QUEUES=['localization-missing','localization-provisional','localization-conflict','external-id-conflict'];
// The programme snapshot carries no fingerprint or prediction state; those queues live in enrichment objects this read does not load.
const ADMIN_UNAVAILABLE_QUEUES=['fingerprint-not-current','prediction-not-current'];
let ADMIN_SNAPSHOT_CACHE=null;

async function adminDigest(text){
 const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));
 return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
}
function adminUploaded(object){
 const uploaded=object?.uploaded;
 if(uploaded instanceof Date)return Number.isFinite(uploaded.getTime())?uploaded.toISOString():null;
 return typeof uploaded==='string'&&uploaded?uploaded:null;
}
// A response body the handler will not read is cancelled rather than left open: R2 `get` returns a live stream, and a
// warm request that trusts the etag would otherwise keep that stream and its connection until garbage collection.
async function adminDiscardBody(object){
 const body=object?.body;
 if(!body||typeof body.cancel!=='function'||body.locked)return;
 try{await body.cancel();}catch{}
}
// One R2 object with its version: the etag, or a hash of the bytes when the etag is empty. The body is parsed only when the
// version differs from the cached one; a reused body keeps the earlier parse and the fresh stream is cancelled.
async function adminReadObject(bucket,key,cached){
 const object=await bucket.get(key);
 if(!object)return {present:false,version:null,uploaded:null,body:null,reused:false};
 const uploaded=adminUploaded(object);
 const etag=typeof object.etag==='string'&&object.etag?object.etag:null;
 if(etag&&cached&&cached.version===etag){await adminDiscardBody(object);return {present:true,version:etag,etag,uploaded,body:cached.body,reused:true};}
 if(etag)return {present:true,version:etag,etag,uploaded,body:await object.json(),reused:false};
 const text=typeof object.text==='function'?await object.text():JSON.stringify(await object.json());
 return {present:true,version:await adminDigest(text),etag:null,uploaded,body:JSON.parse(text),reused:false};
}
function adminClock(value){if(typeof value!=='string'||!value)return null;const parsed=Date.parse(value);return Number.isFinite(parsed)?parsed:null;}
function adminTuple(run,pointer,programme,titles,people,reviews){
 return {programmeRunId:run,generationEtag:pointer.version,programmeEtag:programme.version,titlesVersion:titles.present?titles.version:null,peopleVersion:people.present?people.version:null,reviewsVersion:reviews.present?reviews.version:null};
}
function adminSameTuple(left,right){
 return !!left&&!!right&&left.programmeRunId===right.programmeRunId&&left.generationEtag===right.generationEtag&&left.programmeEtag===right.programmeEtag&&left.titlesVersion===right.titlesVersion&&left.peopleVersion===right.peopleVersion&&left.reviewsVersion===right.reviewsVersion;
}
function adminEncodePin(tuple){
 return ['2',tuple.programmeRunId,tuple.generationEtag,tuple.programmeEtag,tuple.titlesVersion??'',tuple.peopleVersion??'',tuple.reviewsVersion??''].map(part=>encodeURIComponent(part)).join('|');
}
function adminDecodePin(raw){
 if(typeof raw!=='string'||!raw||raw.length>ADMIN_PIN_MAX)return null;
 const parts=raw.split('|');
 if(parts.length!==7||parts[0]!=='2')return null;
 let decoded;
 try{decoded=parts.map(part=>decodeURIComponent(part));}catch{return null;}
 if(!decoded[1]||!decoded[2]||!decoded[3])return null;
 return {programmeRunId:decoded[1],generationEtag:decoded[2],programmeEtag:decoded[3],titlesVersion:decoded[4]||null,peopleVersion:decoded[5]||null,reviewsVersion:decoded[6]||null};
}
// The page cursor carries the pin it was minted under in front of the library cursor, so a cursor from another snapshot is
// refused even when the projection happens to be identical.
function adminEncodeCursor(tuple,inner){return encodeURIComponent(adminEncodePin(tuple))+'~'+inner;}
function adminDecodeCursor(raw,tuple){
 const at=raw.indexOf('~');
 if(at<=0)return null;
 let pin;
 try{pin=adminDecodePin(decodeURIComponent(raw.slice(0,at)));}catch{return null;}
 if(!pin||!adminSameTuple(pin,tuple))return null;
 return raw.slice(at+1)||null;
}
function adminSkew(programmeAt,titles,titlesAt,people,peopleAt){
 const reasons=[];
 const programme=adminClock(programmeAt),titlesClock=adminClock(titlesAt),peopleClock=adminClock(peopleAt);
 if(programme!==null&&titlesClock!==null&&titlesClock>programme)reasons.push('titles_newer');
 if(programme!==null&&peopleClock!==null&&peopleClock>programme)reasons.push('people_newer');
 if(programme!==null&&((titlesClock!==null&&titlesClock<programme)||(peopleClock!==null&&peopleClock<programme)))reasons.push('dictionary_older');
 if(!titles.present||!people.present)reasons.push('dictionary_missing');
 if(programme===null||(titles.present&&titlesClock===null)||(people.present&&peopleClock===null))reasons.push('timestamp_missing');
 return reasons;
}
function adminConflicts(list){
 return (Array.isArray(list)?list:[]).filter(item=>item&&typeof item==='object').map(item=>({value:item.value??null,source:item.source??null,reason:item.reason??null,authority:item.authority??null}));
}
// A Film record of the query library from one programme film: identity from the stored ids, localization from the owner
// dictionary and the provisional title cache, metadata from the fields the film already carries. The dimensions this
// snapshot cannot see (fingerprint, prediction) are left off the record instead of being reported as missing.
// filmView only seeds the original and EPG titles. The published film's own alias list and the
// dictionary entry's aliases are known title variants too, and the picker is built from this record.
function adminExtraTitleAliases(film,dictionary,preferred){
 const incoming=[];
 const push=(value,provenance)=>{
  if(typeof value!=='string')return;
  const text=value.replace(/\s+/g,' ').trim();
  if(!text||text===preferred)return;
  incoming.push({kind:'title',value:text,provenance:provenance||{source:'programme'}});
 };
 for(const alias of Array.isArray(film?.aliases)?film.aliases:[]){
  if(typeof alias==='string')push(alias,{source:'programme'});
  else if(alias&&typeof alias.value==='string')push(alias.value,alias.provenance||{source:'programme'});
 }
 for(const alias of Array.isArray(dictionary?.aliases)?dictionary.aliases:[])push(alias,{source:'dictionary'});
 return incoming;
}
function adminFilmRecord(film,titles,clock,reviews){
 if(!film||typeof film!=='object')return null;
 const id=film.id==null?'':String(film.id);
 if(!id)return null;
 const letterboxdId=id.startsWith('tmdb_')?null:id;
 const tmdbId=film.tmdbId==null||film.tmdbId===''?null:String(film.tmdbId);
 const original=film.original||null,titleRu=film.titleRu||null;
 const dictionary=reviewedTitle(film)||null;
 const facts={
  letterboxdId,tmdbId,conflictingTmdbIds:null,localId:letterboxdId?'film:'+letterboxdId:null,now:clock,decision:null,
  metadata:{present:!!(film.metadataAt||film.discoveredAt||film.synopsis),metadataAt:film.metadataAt||film.discoveredAt||null,peopleVersion:film.peopleVersion??((film.directors||film.actors)?1:null),peopleNamesVersion:film.peopleNamesVersion,synopsisPresent:!!(film.synopsis||film.synopsisFetchedAt),failure:null,source:letterboxdId?'letterboxd':'tmdb'},
  title:{original,titleRu,titleStatus:film.titleStatus||null,dictionary,provisional:titles?.[id]||null,epgTitle:film.title&&film.title!==original&&film.title!==titleRu?film.title:null},
  fingerprint:{present:false},prediction:{present:false},
 };
 const view=filmView(facts);
 if(!view)return null;
 const {fingerprint,prediction,predictionHistory,...record}=view;
 const preferred=view.localization?.value??null;
 const aliases=typeof mergeAliases==='function'?mergeAliases(record.aliases,adminExtraTitleAliases(film,dictionary,preferred)):record.aliases;
 return adminApplyOwnerFilm({...record,aliases,storedId:id,preferred,year:Number.isFinite(film.year)?film.year:null,localizationConflicts:adminConflicts(film.titleConflicts)},reviews&&reviews[id]);
}
function adminMergeFilmAliases(viewAliases,storedAliases){
 const merged=typeof mergeAliases==='function'?mergeAliases(storedAliases||[],viewAliases||[]):[...(storedAliases||[]),...(viewAliases||[])];
 const stamped=new Map();
 for(const alias of storedAliases||[]){
  if(!alias?.value)continue;
  const provenance=alias.provenance;
  if(provenance?.previousPreferred||provenance?.authority==='owner'||provenance?.added==='alias')stamped.set((alias.kind||'title')+'\0'+alias.value,alias);
 }
 if(!stamped.size)return merged;
 return merged.map(alias=>stamped.get((alias.kind||'title')+'\0'+alias.value)||alias);
}
function adminApplyOwnerFilm(record,entry){
 if(!entry||typeof entry!=='object')return record;
 const localization=entry.localization;
 const owner=localization&&localization.status==='reviewed'&&localization.provenance?.authority==='owner';
 const storedAliases=Array.isArray(entry.aliases)?entry.aliases:[];
 const hasAliases=storedAliases.length>0;
 const hasReviews=Array.isArray(entry.titleReviews)&&entry.titleReviews.length>0;
 if(!owner&&!hasAliases&&!hasReviews)return record;
 const aliases=adminMergeFilmAliases(record.aliases,storedAliases);
 const titleReviews=hasReviews?entry.titleReviews:(Array.isArray(record.titleReviews)?record.titleReviews:[]);
 const localizationConflicts=Array.isArray(entry.localizationConflicts)?entry.localizationConflicts:record.localizationConflicts;
 if(!owner)return {...record,aliases,titleReviews,localizationConflicts};
 return {...record,localization,aliases,titleReviews,localizationConflicts,preferred:localization.value??null};
}
function adminTitleReview(film){return typeof titleReviewState==='function'?titleReviewState(film):null;}
function adminPersonSlicePresent(stored){
 if(!stored||typeof stored!=='object')return false;
 if(stored.localization)return true;
 if(Array.isArray(stored.aliases)&&stored.aliases.length)return true;
 if(Array.isArray(stored.nameReviews)&&stored.nameReviews.length)return true;
 if(Array.isArray(stored.roleLinks)&&stored.roleLinks.length)return true;
 if(Array.isArray(stored.localizationConflicts)&&stored.localizationConflicts.length)return true;
 return false;
}
function adminMergePersonAliases(viewAliases,storedAliases){
 const merged=typeof mergeAliases==='function'?mergeAliases(viewAliases||[],storedAliases||[]):(storedAliases||viewAliases||[]);
 const stamped=new Map();
 for(const alias of storedAliases||[]){
  if(!alias?.value)continue;
  const provenance=alias.provenance;
  if(provenance?.previousPreferred||provenance?.authority==='owner'||provenance?.added==='alias')stamped.set((alias.kind||'name')+'\0'+alias.value,alias);
 }
 if(!stamped.size)return merged;
 return merged.map(alias=>stamped.get((alias.kind||'name')+'\0'+alias.value)||alias);
}
function adminPersonSubject(view,stored,clock){
 if(!view)return null;
 if(!adminPersonSlicePresent(stored))return {...view,preferred:view.localization?.value??null,nameReviews:Array.isArray(view.nameReviews)?view.nameReviews:[],roleLinks:Array.isArray(view.roleLinks)?view.roleLinks:[]};
 const ownerLocalization=stored.localization?.status==='reviewed'&&stored.localization?.provenance?.authority==='owner'?stored.localization:null;
 let subject={...view,localization:ownerLocalization||view.localization,aliases:adminMergePersonAliases(view.aliases,stored.aliases),localizationConflicts:Array.isArray(stored.localizationConflicts)?stored.localizationConflicts.slice():[],nameReviews:Array.isArray(stored.nameReviews)?stored.nameReviews.slice():[],roleLinks:Array.isArray(stored.roleLinks)?stored.roleLinks.slice():[]};
 const live=view.localization;
 if(ownerLocalization&&live?.value&&subject.localization?.value!==live.value&&typeof reconcilePersonName==='function')subject=reconcilePersonName(subject,{status:live.status,value:live.value,source:live.source||null,authority:live.provenance?.authority||null,provenance:live.provenance||null},clock);
 return {...subject,preferred:subject.localization?.value??null};
}
function adminPersonRecord(person,people,clock,reviews){
 const roleId=typeof person?.id==='string'?person.id:'';
 if(!roleId)return null;
 const cache=people?.[roleId]&&typeof people[roleId]==='object'?people[roleId]:null;
 const view=personView({roleId,original:person.original||cache?.original||null,dictionary:REVIEWED_PEOPLE[roleId]||null,cacheName:cache?.name||null,now:clock});
 const stored=reviews?.[view?.id]||null;
 const subject=adminPersonSubject(view,stored,clock);
 if(!subject)return null;
 const {nameReviews,roleLinks,...record}=subject;
 const conflicts=adminMergeConflicts(adminConflicts(person.nameConflicts),adminConflicts(subject.localizationConflicts));
 return {record:{...record,localizationConflicts:conflicts},subject};
}
function adminMergeConflicts(left,right){
 const out=[];
 for(const item of [...left,...right])if(item&&!out.some(have=>have.value===item.value&&have.reason===item.reason&&have.source===item.source))out.push(item);
 return out;
}
function adminProjection(programme,titles,people,clock,reviews){
 const films=[],seenFilms=new Set();
 const filmReviews=reviews&&typeof reviews.films==='object'&&!Array.isArray(reviews.films)?reviews.films:{};
 for(const film of Array.isArray(programme?.films)?programme.films:[]){
  const record=adminFilmRecord(film,titles,clock,filmReviews);
  if(!record||seenFilms.has(record.storedId))continue;
  seenFilms.add(record.storedId);films.push(record);
 }
 films.sort((left,right)=>left.storedId.localeCompare(right.storedId,'en'));
 const persons=[],personSubjects={},seenPeople=new Set();
 const personReviews=reviews&&typeof reviews.people==='object'&&!Array.isArray(reviews.people)?reviews.people:{};
 const embedded=[...(programme?.people?.directors||[]),...(programme?.people?.actors||[]),...(Array.isArray(programme?.films)?programme.films:[]).flatMap(film=>[...(film?.directors||[]),...(film?.actors||[])])];
 for(const person of embedded){
  const roleId=typeof person?.id==='string'?person.id:'';
  if(!roleId||seenPeople.has(roleId))continue;
  const built=adminPersonRecord(person,people,clock,personReviews);
  if(!built)continue;
  seenPeople.add(roleId);persons.push(built.record);personSubjects[built.subject.id]=built.subject;
 }
 persons.sort((left,right)=>left.roleId.localeCompare(right.roleId,'en'));
 return {films,people:persons,personSubjects};
}
// While the published EPG marker is d1, the pointer and the programme body come from D1.
// A missing document or a failed read does not fall through to another R2 generation.
// Dictionaries and the review overlay stay R2. PublishedEpg is absent in tests that load this file alone.
async function adminD1Programme(env){
 if(typeof PublishedEpg==='undefined'||typeof PublishedEpg.currentGeneration!=='function')return null;
 const live=await PublishedEpg.currentGeneration(env);
 if(!live)return null;
 if(live.programmeRunId&&typeof PublishedEpg.repairMirrors==='function')await PublishedEpg.repairMirrors(env).catch(()=>{});
 const run=typeof live.programmeRunId==='string'&&ADMIN_RUN_ID.test(live.programmeRunId)?live.programmeRunId:null;
 if(!run)return {error:'programme_unavailable'};
 const body=await PublishedEpg.readDocument(env,run,'programme');
 if(!body||body.runId!==run)return {error:'programme_unavailable'};
 const again=await PublishedEpg.currentGeneration(env);
 if(!again||again.fence!==live.fence||again.programmeRunId!==run)return {moved:true};
 const programmeVersion=await adminDigest(JSON.stringify(body));
 const uploaded=typeof body.updatedAt==='string'&&body.updatedAt?body.updatedAt:null;
 return {
  run,
  pointer:{present:true,version:live.fence,etag:live.fence,uploaded,authority:'d1',body:{programmeRunId:run,phase:'published'}},
  programme:{present:true,version:programmeVersion,etag:programmeVersion,uploaded,body},
 };
}
// The snapshot read in the order the contract fixes: pointer, generation programme, pointer again, dictionaries. One retry
// when the pointer moved between the two reads; a second move is a failure, not a page of mixed generations.
async function adminLoadSnapshot(env,hasPin){
 const bucket=env.BUCKET,cache=ADMIN_SNAPSHOT_CACHE;
 for(let attempt=1;attempt<=2;attempt++){
  const d1=await adminD1Programme(env);
  let pointer,run,programme;
  if(d1){
   if(d1.error)return {error:d1.error};
   if(d1.moved){if(attempt===1)continue;return {error:hasPin?'stale_pin':'programme_unavailable'};}
   pointer=d1.pointer;run=d1.run;programme=d1.programme;
  }else{
   pointer=await adminReadObject(bucket,EPG_GENERATION_KEY,null);
   run=pointer.present&&pointer.body?.phase==='published'&&typeof pointer.body.programmeRunId==='string'&&ADMIN_RUN_ID.test(pointer.body.programmeRunId)?pointer.body.programmeRunId:null;
   if(!run)return {error:'programme_unavailable'};
   programme=await adminReadObject(bucket,epgGenerationKey(run,'programme.json'),cache&&cache.tuple.programmeRunId===run?cache.programme:null);
   if(!programme.present||programme.body?.runId!==run)return {error:'programme_unavailable'};
   const again=await adminReadObject(bucket,EPG_GENERATION_KEY,null);
   if(!again.present||again.version!==pointer.version||again.body?.programmeRunId!==run){
    if(attempt===1)continue;
    return {error:hasPin?'stale_pin':'programme_unavailable'};
   }
  }
  const titles=await adminReadObject(bucket,ADMIN_TITLES_KEY,cache?.titles||null);
  const people=await adminReadObject(bucket,ADMIN_PEOPLE_KEY,cache?.people||null);
  const reviews=await adminReadObject(bucket,'admin/owner-reviews.json',cache?.reviews||null);
  const tuple=adminTuple(run,pointer,programme,titles,people,reviews);
  if(cache&&adminSameTuple(cache.tuple,tuple))return cache;
  const programmeUpdatedAt=typeof programme.body.updatedAt==='string'&&programme.body.updatedAt?programme.body.updatedAt:programme.uploaded||(typeof pointer.body.publishedAt==='string'?pointer.body.publishedAt:null);
  const titlesUpdatedAt=titles.present?(typeof titles.body?.updatedAt==='string'&&titles.body.updatedAt?titles.body.updatedAt:titles.uploaded):null;
  const peopleUpdatedAt=people.present?(typeof people.body?.updatedAt==='string'&&people.body.updatedAt?people.body.updatedAt:people.uploaded):null;
  const skewReasons=adminSkew(programmeUpdatedAt,titles,titlesUpdatedAt,people,peopleUpdatedAt);
  const clockMs=adminClock(programmeUpdatedAt),clock=clockMs===null?null:new Date(clockMs).toISOString();
  const reviewBody=reviews.present&&reviews.body&&typeof reviews.body==='object'&&!Array.isArray(reviews.body)?reviews.body:{};
  const records=adminProjection(programme.body,titles.present&&titles.body&&typeof titles.body==='object'?titles.body:{},people.present&&people.body&&typeof people.body==='object'?people.body:{},clock,reviewBody);
  const snapshot={
   tuple,reviewEtag:reviews.etag||null,reviewCache:reviews.present?{version:reviews.version,body:reviews.body}:null,pointer:{version:pointer.version,body:pointer.body,...(pointer.authority?{authority:pointer.authority}:{})},programme:{version:programme.version,body:programme.body},titles:{version:titles.version,body:titles.body},people:{version:people.version,body:people.body},reviews:{version:reviews.version,body:reviews.present?reviews.body:null,present:reviews.present},records,
   info:{programmeRunId:run,programmeUpdatedAt,titlesUpdatedAt,peopleUpdatedAt,skew:skewReasons.length>0,skewReasons,films:records.films.length,people:records.people.length},
  };
  ADMIN_SNAPSHOT_CACHE=snapshot;
  return snapshot;
 }
 return {error:'programme_unavailable'};
}
function adminError(error,status){return json({error},status);}
async function adminReadRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const rest=url.pathname.slice('/api/admin/'.length);
 let kind=null,id=null,overview=false;
 if(rest==='overview')overview=true;
 else if(rest==='films')kind='film';
 else if(rest==='people')kind='person';
 else if(rest.startsWith('films/')){kind='film';id=rest.slice('films/'.length);}
 else if(rest.startsWith('people/')){kind='person';id=rest.slice('people/'.length);}
 else return adminError('not_found',404);
 if(id!==null){
  try{id=decodeURIComponent(id);}catch{return adminError('not_found',404);}
  if(!id||id.length>ADMIN_ID_MAX)return adminError('not_found',404);
 }
 const params=url.searchParams;
 let pin=null;
 if(params.has('pin')){pin=adminDecodePin(params.get('pin'));if(!pin)return adminError('invalid_pin',400);}
 let limit=ADMIN_LIMIT_DEFAULT,query=null,queue=null,cursor=null;
 if(kind&&id===null){
  if(params.has('limit')){const raw=params.get('limit');if(!/^(?:[1-9]|1\d|2[0-5])$/.test(raw))return adminError('invalid_limit',400);limit=Number(raw);}
  if(params.has('q')){query=params.get('q');if(query.trim()===''||query.length>ADMIN_QUERY_MAX)return adminError('invalid_query',400);}
  if(params.has('queue')){
   queue=params.get('queue');
   if(ADMIN_UNAVAILABLE_QUEUES.includes(queue))return adminError('queue_unavailable',400);
   if(!(kind==='film'?ADMIN_FILM_QUEUES:ADMIN_PERSON_QUEUES).includes(queue))return adminError('unknown_queue',400);
  }
  if(query===null&&queue===null)return adminError('invalid_query',400);
  if(params.has('cursor')){cursor=params.get('cursor');if(!cursor||cursor.length>ADMIN_CURSOR_MAX)return adminError('stale_cursor',400);}
 }
 let snapshot;
 try{snapshot=await adminLoadSnapshot(env,pin!==null);}
 catch{return adminError('storage_unavailable',503);}
 if(snapshot.error)return adminError(snapshot.error,snapshot.error==='stale_pin'?409:503);
 if(pin&&!adminSameTuple(pin,snapshot.tuple))return adminError('stale_pin',409);
 const base={pin:adminEncodePin(snapshot.tuple),snapshot:snapshot.info};
 const {films,people}=snapshot.records;
 if(overview){
  const filmCounts=AdminQuery.filmQueueCounts(films),personCounts=AdminQuery.personQueueCounts(people);
  const queues=[...ADMIN_FILM_QUEUES.map(code=>({code,kind:'film',count:filmCounts[code]})),...ADMIN_PERSON_QUEUES.map(code=>({code,kind:'person',count:personCounts[code]}))];
  return json({...base,counts:{films:films.length,people:people.length},queues,unavailableQueues:ADMIN_UNAVAILABLE_QUEUES});
 }
 if(id!==null){
  const item=kind==='film'?AdminQuery.getFilm(films,id):AdminQuery.getPerson(people,id);
  if(!item)return json({...base,error:'not_found'},404);
  if(kind==='film')return json({...base,kind,item:{...item,titleReview:adminTitleReview(item)}});
  if(kind==='person'&&typeof personNameState==='function'){
   const subjects=snapshot.records.personSubjects||{};
   const subject=subjects[item.id]||item;
   return json({...base,kind,item:{...item,nameReview:personNameState(subject,Object.values(subjects))}});
  }
  return json({...base,kind,item});
 }
 let records=kind==='film'?films:people,result;
 const options={limit};
 if(cursor!==null){const inner=adminDecodeCursor(cursor,snapshot.tuple);if(!inner)return adminError('stale_cursor',400);options.cursor=inner;}
 if(query!==null){
  if(queue!==null){
   records=kind==='film'?AdminQuery.filmQueueRecords(records,queue):AdminQuery.personQueueRecords(records,queue);
   if(records.error)return adminError(records.error,400);
  }
  result=kind==='film'?AdminQuery.searchFilms(records,{...options,query}):AdminQuery.searchPeople(records,{...options,query});
 }else result=kind==='film'?AdminQuery.filmQueue(records,{...options,queue}):AdminQuery.personQueue(records,{...options,queue});
 if(result.error)return adminError(result.error,400);
 return json({...base,kind,query,queue,limit,items:result.items,nextCursor:result.nextCursor?adminEncodeCursor(snapshot.tuple,result.nextCursor):null});
}
