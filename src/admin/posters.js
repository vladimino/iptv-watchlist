// Owner-only poster coverage read behind the existing Cloudflare Access application: GET /api/admin/posters. One request
// reads the generation pointer, the two catalog copies the poster maintenance route works on (the generation copy and
// the live epg/discovered-films.json) and the negative-poster index, counts them with the same rule as that route's dry
// run, and returns the next bounded batch of the actionable queue after a cursor, a sample of remembered terminal answers,
// a sample of the records that cannot be restored because their TMDB identity is not verified, and the data health verdict
// of the catalog poster summary. It never lists the bucket, never reads or takes the resolver lease, never calls TMDB,
// never writes and never starts work: the only way to change a poster stays the explicit POST
// /api/enrichment/catalog/posters (ADR 0048). The contract is docs/reference/api/admin.md.
const ADMIN_POSTERS_LIMIT_MAX=10,ADMIN_POSTERS_LIMIT_DEFAULT=10,ADMIN_POSTERS_UNVERIFIED_SAMPLE=10,ADMIN_POSTERS_CURSOR_MAX=200,ADMIN_POSTERS_LIVE_KEY='epg/discovered-films.json';

function adminPostersText(value){return typeof value==='string'&&value?value.slice(0,200):null;}
function adminPostersYear(value){return Number.isInteger(value)?value:null;}
function adminPostersRecord(row){
 const film=row.film;
 return {id:row.id,tmdbId:String(film.tmdbId),title:adminPostersText(film.title),original:adminPostersText(film.original),year:adminPostersYear(film.year)};
}
function adminPostersHeldRecord(row,entry){
 return {...adminPostersRecord(row),checkedAt:entry.checkedAt,nextCheckAt:entry.nextCheckAt||null};
}
// Absent is an empty index. A present object that is not the schema is unreadable, and the queue is then unknown.
function adminPostersNegativeEntries(source){
 if(!source.present)return {readable:true,entries:{}};
 const entries=catalogPosterNegativesParse(source.films);
 return entries?{readable:true,entries}:{readable:false,entries:null};
}
// Why a record without a poster is outside the queue: the route only trusts a numeric tmdbId that is also the canonical identity.
function adminPostersUnverifiedReason(film){
 const tmdbId=film?.tmdbId;
 if(tmdbId==null||tmdbId===''||!/^\d+$/.test(String(tmdbId)))return 'tmdb_id_missing';
 return 'identity_not_tmdb';
}
// One object as {key, present, version, films}: `films` is the parsed JSON object, or null when the object is absent or its
// body is not a JSON object. A failing storage call throws; a body that does not parse is only this object's problem.
async function adminPostersRead(bucket,key){
 const object=await bucket.get(key);
 if(!object)return {key,present:false,version:null,films:null};
 const etag=typeof object.etag==='string'&&object.etag?object.etag:null;
 let body=null,text=null;
 if(typeof object.text==='function'){text=await object.text();try{body=JSON.parse(text);}catch{body=null;}}
 else{try{body=await object.json();}catch{body=null;}}
 const version=etag||(text!==null?await adminDigest(text):null);
 return {key,present:true,version,films:body&&typeof body==='object'&&!Array.isArray(body)?body:null};
}
function adminPostersCopy(source,role){
 if(!source.films)return {key:source.key,role,present:source.present,readable:false,version:source.version,records:null,missingPoster:null,verifiedMissing:null};
 const counts=catalogPosterMissing([source]);
 return {key:source.key,role,present:source.present,readable:true,version:source.version,records:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length};
}
async function adminPostersRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const params=url.searchParams;
 let limit=ADMIN_POSTERS_LIMIT_DEFAULT;
 if(params.has('limit')){const raw=params.get('limit');if(!/^(?:[1-9]|10)$/.test(raw))return adminError('invalid_limit',400);limit=Number(raw);}
 let cursor=null;
 if(params.has('cursor')){const raw=params.get('cursor');if(raw.length>ADMIN_POSTERS_CURSOR_MAX)return adminError('invalid_cursor',400);cursor=raw||null;}
 const bucket=env.BUCKET,reads=[];
 const read=async key=>{reads.push(key);return await adminPostersRead(bucket,key);};
 let pointerObject,pointer,live,copy=null,programmeRunId=null,authoritative=false;
 try{
  if(typeof PublishedEpg!=='undefined'&&typeof PublishedEpg.currentGeneration==='function'){
   const liveGeneration=await PublishedEpg.currentGeneration(env);
   if(liveGeneration){
    authoritative=true;
    programmeRunId=liveGeneration.phase==='published'&&typeof liveGeneration.programmeRunId==='string'&&liveGeneration.programmeRunId?liveGeneration.programmeRunId:null;
    pointer={programmeRunId,phase:liveGeneration.phase};
    pointerObject={present:true,films:pointer,key:'published_epg_authority'};
   }
  }
  if(!authoritative){
   pointerObject=await read(EPG_GENERATION_KEY);
   pointer=pointerObject.films;
   programmeRunId=pointer?.phase==='published'&&typeof pointer.programmeRunId==='string'&&pointer.programmeRunId?pointer.programmeRunId:null;
  }
  live=await read(ADMIN_POSTERS_LIVE_KEY);
  if(programmeRunId)copy=await read(epgGenerationKey(programmeRunId,'discovered-films.json'));
  var negativesSource=await read(CATALOG_POSTER_NEGATIVES_KEY);
 }catch{return adminError('storage_unavailable',503);}
 // The counts are only as good as their inputs: a missing or unreadable copy, or a pointer that names no published
 // generation, makes every count unknown. Nothing is counted as zero for it, and no batch is offered.
 const problems=[];
 if(!pointerObject.present)problems.push('pointer_missing');
 else if(!pointer)problems.push('pointer_unreadable');
 else if(!programmeRunId)problems.push('generation_not_published');
 if(copy&&!copy.present)problems.push('generation_copy_missing');
 else if(copy&&!copy.films)problems.push('generation_copy_unreadable');
 if(!live.present)problems.push('live_copy_missing');
 else if(!live.films)problems.push('live_copy_unreadable');
 const negatives=adminPostersNegativeEntries(negativesSource);
 if(!negatives.readable)problems.push('negatives_unreadable');
 const complete=problems.length===0;
 const counts=complete?catalogPosterMissing([live,copy]):null;
 const part=complete?catalogPosterPartition(counts.verified,negatives.entries,Date.now()):null;
 const queue=complete?part.actionable.filter(row=>!cursor||row.id.localeCompare(cursor,'en')>0):null,batch=complete?queue.slice(0,limit):[];
 const nowMs=Date.now(),now=new Date(nowMs).toISOString();
 const summary=complete
  ?{programmeRunId,catalogRecords:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length,unverifiedMissing:counts.unverified.length,actionable:part.actionable.length,noPosterHeld:part.held.length,identityReview:part.review.length}
  :{programmeRunId,catalogRecords:null,missingPoster:null,verifiedMissing:null,unverifiedMissing:null,actionable:null,noPosterHeld:null,identityReview:null};
 const held=complete
  ?{noPoster:{count:part.held.length,sample:part.held.slice(0,ADMIN_POSTERS_UNVERIFIED_SAMPLE).map(row=>adminPostersHeldRecord(row,negatives.entries[String(row.film.tmdbId)]))},identityReview:{count:part.review.length,sample:part.review.slice(0,ADMIN_POSTERS_UNVERIFIED_SAMPLE).map(row=>adminPostersHeldRecord(row,negatives.entries[String(row.film.tmdbId)]))}}
  :{noPoster:{count:null,sample:[]},identityReview:{count:null,sample:[]}};
 const health=DataHealth.evaluateDataHealth({
  now,
  published:programmeRunId?{programmeRunId,phase:'published',publishedAt:typeof pointer.publishedAt==='string'?pointer.publishedAt:null,observedAt:now}:null,
  posters:complete?{...summary,sample:counts.verified.slice(0,ADMIN_POSTERS_LIMIT_MAX).map(row=>row.id),observedAt:now}:{programmeRunId,observedAt:now},
 });
 if(health.error)return adminError('health_unavailable',503);
 const issue=health.issues.find(item=>item.subsystem==='poster'&&item.subject.kind==='catalog')||null;
 return json({
  schemaVersion:1,observedAt:now,
  ...summary,withPoster:complete?counts.all.length-counts.missing.length:null,
  publishedAt:typeof pointer?.publishedAt==='string'?pointer.publishedAt:null,
  evidence:{complete,problems},
  copies:[...(copy?[adminPostersCopy(copy,'generation')]:[]),adminPostersCopy(live,'live')],
  queue:{cursor,limit,items:batch.map(adminPostersRecord),remainingAfterCursor:complete?queue.length:null,total:complete?part.actionable.length:null},
  held,
  unverified:complete?{count:counts.unverified.length,sample:counts.unverified.slice(0,ADMIN_POSTERS_UNVERIFIED_SAMPLE).map(row=>({id:row.id,title:adminPostersText(row.film.title),year:adminPostersYear(row.film.year),reason:adminPostersUnverifiedReason(row.film)}))}:{count:null,sample:[]},
  health:{issue:issue?{id:issue.id,severity:issue.severity,reason:issue.reason,category:issue.category,action:issue.action,evidence:issue.evidence,threshold:issue.threshold??null}:null,posterBacklogCount:health.thresholds.posterBacklogCount},
  limits:{batch:ADMIN_POSTERS_LIMIT_MAX,route:CATALOG_POSTER_LIMIT},
  reads,
 });
}
