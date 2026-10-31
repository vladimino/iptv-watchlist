// Owner-only poster coverage read behind the existing Cloudflare Access application: GET /api/admin/posters. One request
// reads the generation pointer and the two catalog copies the poster maintenance route works on (the generation copy and
// the live epg/discovered-films.json), counts them with the same rule as that route's dry run, and returns the next
// bounded batch of the hydration queue after a cursor, a sample of the records that cannot be restored because their TMDB
// identity is not verified, and the data health verdict of the catalog poster summary. It never lists the bucket, never
// reads or takes the resolver lease, never calls TMDB, never writes and never starts work: the only way to change a poster
// stays the explicit POST /api/enrichment/catalog/posters (ADR 0048). The contract is docs/reference/api/admin.md.
const ADMIN_POSTERS_LIMIT_MAX=10,ADMIN_POSTERS_LIMIT_DEFAULT=10,ADMIN_POSTERS_UNVERIFIED_SAMPLE=10,ADMIN_POSTERS_CURSOR_MAX=200,ADMIN_POSTERS_LIVE_KEY='epg/discovered-films.json';

function adminPostersText(value){return typeof value==='string'&&value?value.slice(0,200):null;}
function adminPostersYear(value){return Number.isInteger(value)?value:null;}
function adminPostersRecord(row){
 const film=row.film;
 return {id:row.id,tmdbId:String(film.tmdbId),title:adminPostersText(film.title),original:adminPostersText(film.original),year:adminPostersYear(film.year)};
}
// Why a record without a poster is outside the queue: the route only trusts a numeric tmdbId that is also the canonical identity.
function adminPostersUnverifiedReason(film){
 const tmdbId=film?.tmdbId;
 if(tmdbId==null||tmdbId===''||!/^\d+$/.test(String(tmdbId)))return 'tmdb_id_missing';
 return 'identity_not_tmdb';
}
function adminPostersCopy(source,role){
 const counts=catalogPosterMissing([source]);
 return {key:source.key,role,present:source.present,readable:source.films!==null,version:source.version,records:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length};
}
async function adminPostersRoute(request,env,url){
 if(request.method!=='GET')return adminError('method_not_allowed',405);
 const params=url.searchParams;
 let limit=ADMIN_POSTERS_LIMIT_DEFAULT;
 if(params.has('limit')){const raw=params.get('limit');if(!/^(?:[1-9]|10)$/.test(raw))return adminError('invalid_limit',400);limit=Number(raw);}
 let cursor=null;
 if(params.has('cursor')){const raw=params.get('cursor');if(raw.length>ADMIN_POSTERS_CURSOR_MAX)return adminError('invalid_cursor',400);cursor=raw||null;}
 const bucket=env.BUCKET,reads=[];
 const read=async key=>{reads.push(key);const object=await adminReadObject(bucket,key,null);return {key,version:object.version,films:object.present&&object.body&&typeof object.body==='object'&&!Array.isArray(object.body)?object.body:null,present:object.present};};
 let pointer,live,copy=null,programmeRunId=null;
 try{
  reads.push(EPG_GENERATION_KEY);
  const object=await adminReadObject(bucket,EPG_GENERATION_KEY,null);
  pointer=object.present&&object.body&&typeof object.body==='object'?object.body:null;
  programmeRunId=pointer?.phase==='published'&&typeof pointer.programmeRunId==='string'&&pointer.programmeRunId?pointer.programmeRunId:null;
  live=await read(ADMIN_POSTERS_LIVE_KEY);
  if(programmeRunId)copy=await read(epgGenerationKey(programmeRunId,'discovered-films.json'));
 }catch{return adminError('storage_unavailable',503);}
 const sources=[live,...(copy?[copy]:[])];
 const counts=catalogPosterMissing(sources);
 const queue=counts.verified.filter(row=>!cursor||row.id.localeCompare(cursor,'en')>0),batch=queue.slice(0,limit);
 const nowMs=Date.now(),now=new Date(nowMs).toISOString();
 const summary={programmeRunId,catalogRecords:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length,unverifiedMissing:counts.unverified.length};
 const health=DataHealth.evaluateDataHealth({
  now,
  published:programmeRunId?{programmeRunId,phase:'published',publishedAt:typeof pointer.publishedAt==='string'?pointer.publishedAt:null,observedAt:now}:null,
  posters:live.present||copy?.present?{...summary,sample:counts.verified.slice(0,ADMIN_POSTERS_LIMIT_MAX).map(row=>row.id),observedAt:now}:null,
 });
 if(health.error)return adminError('health_unavailable',503);
 const issue=health.issues.find(item=>item.subsystem==='poster'&&item.subject.kind==='catalog')||null;
 return json({
  schemaVersion:1,observedAt:now,
  ...summary,withPoster:counts.all.length-counts.missing.length,
  publishedAt:typeof pointer?.publishedAt==='string'?pointer.publishedAt:null,
  copies:[...(copy?[adminPostersCopy(copy,'generation')]:[]),adminPostersCopy(live,'live')],
  queue:{cursor,limit,items:batch.map(adminPostersRecord),remainingAfterCursor:queue.length,total:counts.verified.length},
  unverified:{count:counts.unverified.length,sample:counts.unverified.slice(0,ADMIN_POSTERS_UNVERIFIED_SAMPLE).map(row=>({id:row.id,title:adminPostersText(row.film.title),year:adminPostersYear(row.film.year),reason:adminPostersUnverifiedReason(row.film)}))},
  health:{issue:issue?{id:issue.id,severity:issue.severity,reason:issue.reason,category:issue.category,action:issue.action,evidence:issue.evidence,threshold:issue.threshold??null}:null,posterBacklogCount:health.thresholds.posterBacklogCount},
  limits:{batch:ADMIN_POSTERS_LIMIT_MAX,route:CATALOG_POSTER_LIMIT},
  reads,
 });
}
