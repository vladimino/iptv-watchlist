// AIR-541 (ADR 0177): the degraded, read-only view of the EPG compatibility mirrors in R2. D1 stays the only authority; this module is reached only after a TYPED TEMPORARY
// authoritative failure (`isTemporaryReadFault`), never for a healthy D1, a structural refusal (ADR 0162) or a confirmed absence/retirement/conflict. It only ever GETs R2
// (and lists one prefix); it has no PUT, no delete and no D1 access, and write paths do not import it (tests/mirror-read-write-fence.mjs asserts that).
//
// Each object is validated ALONE (parse, size, shape, its own `runId`); an invalid object is dropped and never disqualifies another one. The programme/watchlist join is a
// best-effort heuristic (owner decision B3): same run key or a root pair behind the pointer. There is no hard TTL (decision A): every object keeps its own `asOf`.
// No identity, title, availability or show status is ever invented here.

export const MIRROR_POINTER_KEY='epg/published-generation.json';
export const MIRROR_PROGRAMME_KEY='programme.json';
export const MIRROR_WATCHLIST_KEY='watchlist.json';
export const MIRROR_MAX_BYTES=8*1024*1024;
// The older-run search is bounded: at most MIRROR_LIST_PAGES pages of MIRROR_LIST_PAGE objects are listed and at most MIRROR_OLDER_READS programme copies are read (newest upload first).
const MIRROR_LIST_PAGE=1000,MIRROR_LIST_PAGES=5,MIRROR_OLDER_READS=6;
const RUN_ID=/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const TMDB_ID=/^[1-9]\d{0,11}$/;
const generationKey=(run,name)=>'epg/generations/'+run+'/'+name;

// The errors a degraded read is allowed for. A top-level code is never enough: the error must be marked at its throw site (`temporary`, set by the typed `failed()` of
// each authority module from the CAUSE of a caught storage error), or be one of the two states that are transient by definition (a fence that moved, a catalog load in progress).
export function isTemporaryReadFault(error){
 if(!error||typeof error!=='object')return false;
 if(error.temporary===true)return true;
 return ['discovery_fence','discovery_incomplete','film_person_generation_moved'].includes(error.code);
}

const isObject=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const isIso=value=>typeof value==='string'&&Number.isFinite(Date.parse(value));
// The minimum a record must carry to be shown and joined: an id and a title (and, when present, `shows` as a list of objects). A document is valid only when its required
// fields and EVERY record meet this minimum, so a corrupt but syntactically valid object cannot win over a healthy one; independently valid objects are never affected.
const nonEmptyId=value=>(typeof value==='string'&&value.length>0&&value.length<=160)||(Number.isSafeInteger(value)&&value>=0);
const usableFilm=film=>isObject(film)&&nonEmptyId(film.id)&&typeof film.title==='string'&&film.title.trim().length>0&&(film.shows===undefined||(Array.isArray(film.shows)&&film.shows.every(isObject)));
const usableCatalogFilm=film=>isObject(film)&&nonEmptyId(film.id)&&(film.shows===undefined||(Array.isArray(film.shows)&&film.shows.every(isObject)));
export function validProgramme(doc){
 return isObject(doc)&&typeof doc.runId==='string'&&RUN_ID.test(doc.runId)&&isIso(doc.updatedAt)&&Array.isArray(doc.films)&&doc.films.every(usableFilm)
  &&(doc.catalogFilms===undefined||(Array.isArray(doc.catalogFilms)&&doc.catalogFilms.every(usableCatalogFilm)));
}
export function validWatchlist(doc){
 return isObject(doc)&&isIso(doc.updatedAt)&&Array.isArray(doc.films)&&doc.films.every(usableFilm);
}
// The snapshot time of one object: its own timestamp, else the R2 upload time. Never the request time.
const uploadedIso=uploaded=>{try{return uploaded?new Date(uploaded).toISOString():null;}catch{return null;}};
function programmeAsOf(doc,uploaded){
 for(const key of ['updatedAt','generatedAt','publishedAt','createdAt'])if(isIso(doc?.[key]))return new Date(doc[key]).toISOString();
 return uploadedIso(uploaded);
}
function watchlistAsOf(doc,uploaded){
 return isIso(doc?.updatedAt)?new Date(doc.updatedAt).toISOString():uploadedIso(uploaded);
}

async function readOne(bucket,key,validate){
 let object;
 try{object=await bucket.get(key);}catch{return {ok:false,key,reason:'read_failed'};}
 if(!object)return {ok:false,key,reason:'absent'};
 if(Number.isFinite(object.size)&&object.size>MIRROR_MAX_BYTES)return {ok:false,key,reason:'too_large'};
 let text;
 try{text=typeof object.text==='function'?await object.text():JSON.stringify(await object.json());}catch{return {ok:false,key,reason:'read_failed'};}
 if(typeof text!=='string'||text.length>MIRROR_MAX_BYTES)return {ok:false,key,reason:'too_large'};
 let doc;
 try{doc=JSON.parse(text);}catch{return {ok:false,key,reason:'invalid_json'};}
 if(!validate(doc))return {ok:false,key,reason:'invalid_shape'};
 return {ok:true,key,doc,etag:object.etag??null,uploaded:object.uploaded??null};
}

async function readPointer(bucket){
 const read=await readOne(bucket,MIRROR_POINTER_KEY,doc=>isObject(doc));
 if(!read.ok)return {run:null,reason:read.reason};
 const run=read.doc.phase==='published'&&typeof read.doc.programmeRunId==='string'&&RUN_ID.test(read.doc.programmeRunId)?read.doc.programmeRunId:null;
 return {run,reason:run?null:'invalid_pointer'};
}

// Generation copies of OTHER runs. A run id is a UUID, not a timestamp, so the lexical order of keys says nothing about recency: the programme copies are listed (bounded
// pagination) and ranked by their R2 `uploaded` time, then each of the newest few is read, validated alone and ranked by its own snapshot time.
async function listProgrammeCopies(bucket,skip){
 if(typeof bucket.list!=='function')return {copies:[],truncated:false};
 const copies=new Map();let cursor,truncated=false;
 for(let page=0;page<MIRROR_LIST_PAGES;page++){
  let listed;
  try{listed=await bucket.list({prefix:'epg/generations/',limit:MIRROR_LIST_PAGE,...(cursor?{cursor}:{})});}catch{return {copies:[...copies.values()],truncated:true};}
  for(const object of listed?.objects||[]){
   const run=/^epg\/generations\/([^/]+)\/programme\.json$/.exec(String(object?.key))?.[1];
   if(run&&RUN_ID.test(run)&&!skip.has(run))copies.set(run,{run,key:String(object.key),uploaded:object.uploaded?Date.parse(object.uploaded):NaN});
  }
  if(!listed?.truncated||!listed.cursor){truncated=false;cursor=undefined;break;}
  cursor=listed.cursor;truncated=true;
 }
 return {copies:[...copies.values()],truncated:truncated&&!!cursor};
}
async function olderProgrammes(bucket,skip,limit=MIRROR_OLDER_READS){
 const {copies,truncated}=await listProgrammeCopies(bucket,skip);
 const ranked=copies.sort((a,b)=>(Number.isFinite(b.uploaded)?b.uploaded:-Infinity)-(Number.isFinite(a.uploaded)?a.uploaded:-Infinity)||a.run.localeCompare(b.run));
 const found=[];
 for(const copy of ranked.slice(0,limit)){
  const read=await readOne(bucket,copy.key,validProgramme);
  if(read.ok&&read.doc.runId===copy.run)found.push(read);
 }
 return {found:found.sort((a,b)=>String(programmeAsOf(b.doc,b.uploaded)).localeCompare(String(programmeAsOf(a.doc,a.uploaded)))),truncated};
}

// The best valid programme and the best valid watchlist, each read and validated alone. Candidate order for a programme: the generation copy of the pointer's run, the root
// object (valid by its own schema and runId even when the pointer is behind it), then older generation copies. A watchlist has no runId: its generation copy under the chosen
// programme's run, the root object, the generation copy of the pointer's run. `joined` says what the programme/watchlist pair is, and never more than a heuristic.
export async function readMirrorSnapshot(env){
 const bucket=env?.BUCKET;
 const empty={programme:null,watchlist:null,pointerRun:null,joined:'none',joinBasis:null,rejected:[]};
 if(!bucket||typeof bucket.get!=='function')return {...empty,rejected:[{key:'bucket',reason:'unavailable'}]};
 const rejected=[],note=read=>{if(!read.ok&&read.reason!=='absent')rejected.push({key:read.key,reason:read.reason});else if(!read.ok)rejected.push({key:read.key,reason:'absent'});return read;};
 const pointer=await readPointer(bucket);
 const pointerRun=pointer.run;
 let programme=null;
 if(pointerRun){
  const copy=note(await readOne(bucket,generationKey(pointerRun,'programme.json'),validProgramme));
  if(copy.ok&&copy.doc.runId===pointerRun)programme={...copy,run:pointerRun,source:'generation_copy'};
  else if(copy.ok)rejected.push({key:copy.key,reason:'run_mismatch'});
 }
 if(!programme){
  const root=note(await readOne(bucket,MIRROR_PROGRAMME_KEY,validProgramme));
  if(root.ok)programme={...root,run:root.doc.runId,source:'root'};
 }
 if(!programme){
  const older=await olderProgrammes(bucket,new Set(pointerRun?[pointerRun]:[]));
  if(older.truncated)rejected.push({key:'epg/generations/',reason:'list_truncated'});
  if(older.found.length)programme={...older.found[0],run:older.found[0].doc.runId,source:'older_generation_copy'};
 }
 let watchlist=null;
 const watchCandidates=[];
 if(programme?.run)watchCandidates.push({key:generationKey(programme.run,'watchlist.json'),source:'generation_copy',run:programme.run});
 watchCandidates.push({key:MIRROR_WATCHLIST_KEY,source:'root',run:null});
 if(pointerRun&&pointerRun!==programme?.run)watchCandidates.push({key:generationKey(pointerRun,'watchlist.json'),source:'generation_copy',run:pointerRun});
 for(const candidate of watchCandidates){
  const read=note(await readOne(bucket,candidate.key,validWatchlist));
  if(read.ok){watchlist={...read,run:candidate.run,source:candidate.source};break;}
 }
 let joined='none',joinBasis=null;
 if(programme&&watchlist){
  if(watchlist.source==='generation_copy'&&watchlist.run===programme.run){joined='best_effort';joinBasis='same_run_key';}
  else if(watchlist.source==='root'&&pointerRun&&programme.run===pointerRun){joined='best_effort';joinBasis='pointer_root';}
  else joinBasis=watchlist.source==='generation_copy'?'run_mismatch':'unproven_root';
 }
 return {
  programme:programme?{doc:programme.doc,runId:programme.run,key:programme.key,source:programme.source,asOf:programmeAsOf(programme.doc,programme.uploaded),etag:programme.etag}:null,
  watchlist:watchlist?{doc:watchlist.doc,runId:watchlist.run,key:watchlist.key,source:watchlist.source,asOf:watchlistAsOf(watchlist.doc,watchlist.uploaded),etag:watchlist.etag}:null,
  pointerRun,joined,joinBasis,rejected,
 };
}

// The additive metadata every degraded body carries (the normal response shape is unchanged). `asOf` is the OLDEST snapshot time of the objects used, so a reader never
// sees a fresher date than any one of its parts. `parts` lists each object's own run and time.
export function mirrorMeta(snapshot,reason){
 const parts=[];
 if(snapshot.programme)parts.push({object:'programme',key:snapshot.programme.key,runId:snapshot.programme.runId,asOf:snapshot.programme.asOf});
 if(snapshot.watchlist)parts.push({object:'watchlist',key:snapshot.watchlist.key,runId:snapshot.watchlist.runId,asOf:snapshot.watchlist.asOf});
 const times=parts.map(part=>part.asOf).filter(Boolean).sort();
 return {source:'mirror',readOnly:true,reason:String(reason||'temporary_read_fault'),runId:snapshot.programme?.runId??null,asOf:times[0]??null,joined:snapshot.joined,joinBasis:snapshot.joinBasis,parts};
}

// ---- film identity from the mirrors (C1) ----
// An entry proves a TMDB movie only by its own resolved link, exactly as the SPA's `trustedMovieTmdb` does: `tmdbId` equal to the id AND `tmdbLink` a resolved movie link with the same id.
export function trustedMovieTmdb(film){
 const id=film?.tmdbId==null?'':String(film.tmdbId),link=film?.tmdbLink;
 if(!TMDB_ID.test(id)||link?.status!=='resolved'||link.link?.type!=='movie'||String(link.link.id)!==id)return null;
 return id;
}
const entriesOf=(snapshot)=>{
 const list=[];
 if(snapshot.programme){for(const [field,kind] of [['films','programme'],['catalogFilms','programme_catalog']])for(const film of snapshot.programme.doc[field]||[])if(isObject(film))list.push({film,object:snapshot.programme,kind});}
 if(snapshot.watchlist)for(const film of snapshot.watchlist.doc.films)list.push({film,object:snapshot.watchlist,kind:'watchlist'});
 return list;
};
// 'found' (one verified identity, deterministic preferred candidate), 'unproven' (absent from every usable mirror, or an invalid/contradictory identity key). Never a 404, 410 or 409.
export function mirrorFilmIdentity(snapshot,tmdbId){
 const wanted=String(tmdbId??'');
 if(!TMDB_ID.test(wanted))return {state:'unproven',reason:'invalid_id'};
 const candidates=[];
 for(const entry of entriesOf(snapshot)){
  const claims=(entry.film.tmdbId!=null&&String(entry.film.tmdbId)===wanted)||String(entry.film.id)==='tmdb_'+wanted||entry.film.canonicalIdentity==='tmdb:'+wanted;
  if(!claims)continue;
  if(trustedMovieTmdb(entry.film)!==wanted)return {state:'unproven',reason:'identity_key_contradiction'};
  candidates.push(entry);
 }
 if(!candidates.length)return {state:'unproven',reason:'not_in_mirror'};
 // One TMDB id must mean one film entry id; two different ids that both claim it are a contradictory identity key, not a naming variation.
 if(new Set(candidates.map(entry=>String(entry.film.id))).size>1)return {state:'unproven',reason:'identity_key_contradiction'};
 const rank=entry=>[entry.object.runId===snapshot.pointerRun?0:1,entry.kind==='programme'?0:entry.kind==='watchlist'?1:2];
 const newest=entry=>String(entry.object.asOf||'');
 candidates.sort((a,b)=>{
  const x=rank(a),y=rank(b);
  for(let i=0;i<x.length;i++)if(x[i]!==y[i])return x[i]-y[i];
  return newest(b).localeCompare(newest(a))||String(a.object.key).localeCompare(String(b.object.key));
 });
 const chosen=candidates[0];
 const disputed=candidates.some(other=>other!==chosen&&(String(other.film.title)!==String(chosen.film.title)||String(other.film.year)!==String(chosen.film.year)));
 const film={...chosen.film,tmdbId:wanted,canonicalIdentity:'tmdb:'+wanted};
 return {state:'found',film,disputed,provenance:{object:chosen.kind,key:chosen.object.key,runId:chosen.object.runId,asOf:chosen.object.asOf},sources:candidates.map(entry=>({object:entry.kind,key:entry.object.key,runId:entry.object.runId,asOf:entry.object.asOf}))};
}

// The film page lookup: the selected programme/watchlist pair first; when the film is in none of them, other RECENT generation copies (each read and validated alone, newest
// snapshot first, bounded) are searched, so a film that only an older run still lists is shown with the provenance of that run. Never a 404, 410 or 409.
export async function findMirrorFilm(env,snapshot,tmdbId){
 const first=mirrorFilmIdentity(snapshot,tmdbId);
 if(first.state==='found'||first.reason!=='not_in_mirror')return first;
 const bucket=env?.BUCKET;
 if(!bucket)return first;
 const skip=new Set([snapshot.programme?.runId,snapshot.pointerRun].filter(Boolean));
 const {found}=await olderProgrammes(bucket,skip);
 for(const programme of found){
  const watch=await readOne(bucket,generationKey(programme.doc.runId,'watchlist.json'),validWatchlist);
  const pair={
   programme:{doc:programme.doc,runId:programme.doc.runId,key:programme.key,source:'older_generation_copy',asOf:programmeAsOf(programme.doc,programme.uploaded)},
   watchlist:watch.ok?{doc:watch.doc,runId:programme.doc.runId,key:watch.key,source:'generation_copy',asOf:watchlistAsOf(watch.doc,watch.uploaded)}:null,
   pointerRun:snapshot.pointerRun,
  };
  const identity=mirrorFilmIdentity(pair,tmdbId);
  if(identity.state==='found')return {...identity,olderRun:true,pair};
  if(identity.reason==='identity_key_contradiction')return identity;
 }
 return first;
}
