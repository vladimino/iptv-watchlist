// Owner-confirmed preferred Russian title for one Film. POST only. The transition is applyTitleReview;
// this route persists that result in admin/owner-reviews.json with the object's etag as the compare-and-set,
// then reads the object back. A GET never reaches this function. Deploying it writes nothing.
const FILM_TITLE_ACTION='film_title_review';
function filmTitlePrincipal(request,url){
 const assertion=request.headers.get('Cf-Access-Jwt-Assertion');
 const type=request.headers.get('Content-Type')||'';
 return typeof assertion==='string'&&assertion.length>0&&assertion.length<=8192&&request.headers.get('Origin')===url.origin&&request.headers.get('X-IPTV-Admin-Action')===FILM_TITLE_ACTION&&/^application\/json(\s*;|$)/i.test(type);
}
function filmTitleStatus(reason){
 if(reason==='version_conflict'||reason==='request_id_reused'||reason==='illegal_transition')return 409;
 if(reason==='missing_film'||reason==='film_mismatch')return 404;
 return 400;
}
function filmTitleError(result){
 const body={error:result.reason,reason:result.reason};
 for(const key of ['expected','received','field','options','maxLength','modes'])if(result[key]!==undefined)body[key]=result[key];
 return body;
}
function filmTitleStored(doc,storedId,requestId,version){
 const slice=doc&&doc.films&&doc.films[storedId];
 const review=(slice&&slice.titleReviews||[]).find(item=>item&&item.requestId===requestId);
 return !!(review&&review.version&&review.version.after===version);
}
async function filmTitleReviewRoute(request,env,url){
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(!filmTitlePrincipal(request,url))return json({error:'forbidden',reason:'forbidden'},403);
 const marker='/title-review';
 let storedId=url.pathname.slice('/api/admin/films/'.length);
 if(!storedId.endsWith(marker))return adminError('not_found',404);
 storedId=storedId.slice(0,-marker.length);
 try{storedId=decodeURIComponent(storedId);}catch{return adminError('not_found',404);}
 if(!storedId||storedId.length>ADMIN_ID_MAX||storedId.includes('/'))return adminError('not_found',404);
 const text=await request.text();
 if(text.length>8192)return json({error:'invalid_command',reason:'invalid_command'},400);
 let command;try{command=JSON.parse(text);}catch{return json({error:'invalid_command',reason:'invalid_command'},400);}
 if(!command||typeof command!=='object'||Array.isArray(command))return json({error:'invalid_command',reason:'invalid_command'},400);
 const bucket=env.BUCKET;
 for(let attempt=0;attempt<2;attempt++){
  ADMIN_SNAPSHOT_CACHE=null;
  let snapshot;try{snapshot=await adminLoadSnapshot(env,false);}catch{return adminError('storage_unavailable',503);}
  if(snapshot.error)return adminError(snapshot.error,snapshot.error==='stale_pin'?409:503);
  const film=(snapshot.records.films||[]).find(item=>item.storedId===storedId);
  if(!film)return json({error:'not_found',reason:'missing_film',pin:adminEncodePin(snapshot.tuple)},404);
  const applied=applyTitleReview(film,{...command,filmId:command.filmId},new Date().toISOString());
  if(!applied.ok)return json(filmTitleError(applied),filmTitleStatus(applied.reason));
  if(!applied.changed)return json({ok:true,changed:false,idempotent:!!applied.idempotent,version:applied.version,readback:true,titleReview:titleReviewState(applied.film)});
  const doc=ownerReviewsNormalize(snapshot.reviews&&snapshot.reviews.body);
  if(!doc)return json({error:'storage_unavailable',reason:'overlay_invalid'},503);
  const etag=snapshot.tuple.reviewsVersion||null;
  const next=ownerReviewsWithFilm(doc,storedId,ownerFilmSlice(applied.film));
  const saved=await bucket.put(OWNER_REVIEWS_KEY,JSON.stringify(next),{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(saved===null)continue;
  ADMIN_SNAPSHOT_CACHE=null;
  const back=await bucket.get(OWNER_REVIEWS_KEY);
  let stored=null;try{stored=back?await back.json():null;}catch{stored=null;}
  const normalized=ownerReviewsNormalize(stored);
  if(!filmTitleStored(normalized,storedId,command.requestId,applied.version))return json({error:'storage_unavailable',reason:'readback_failed'},503);
  return json({ok:true,changed:true,idempotent:false,version:applied.version,readback:true,titleReview:titleReviewState(applied.film)});
 }
 return json({error:'version_conflict',reason:'version_conflict'},409);
}
