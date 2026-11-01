// POST /api/admin/people/<id>/name-review. One owner confirmation writes the reviewed Russian name of one Person,
// and any roles named in the same command, into the people map of admin/owner-reviews.json. The films map is copied
// unchanged. The pure contract decides the next records; this route checks the stored tokens and persists the whole
// commit with one conditional put. A GET of this path does not run.
const ADMIN_PERSON_NAME_MAX=8000;
const ADMIN_REVIEW_STATUS={
 missing_person:404,person_mismatch:400,missing_request_id:400,identity_change_forbidden:400,invalid_mode:400,invalid_name:400,invalid_basis:400,invalid_roles:400,
 rejected_identity:409,version_conflict:412,unknown_alias:400,unknown_role:400,unrelated_role:400,rejected_role:409,role_version_conflict:412,request_id_reused:409,
 review_incomplete:409,review_store_unreadable:409,storage_conflict:409,review_unconditional:503,commit_unverified:503,
};
function adminPersonNameId(pathname){
 const prefix='/api/admin/people/',suffix='/name-review';
 if(!pathname.startsWith(prefix)||!pathname.endsWith(suffix)||pathname.length<=prefix.length+suffix.length)return null;
 let id=pathname.slice(prefix.length,-suffix.length);
 try{id=decodeURIComponent(id);}catch{return null;}
 if(!id||id.length>ADMIN_ID_MAX)return null;
 return id;
}
function adminReviewFailure(result){
 const body={error:result.reason||result.error};
 for(const key of ['field','role','expected','received','options','records'])if(result[key]!==undefined)body[key]=result[key];
 return json(body,ADMIN_REVIEW_STATUS[body.error]||400);
}
function adminPersonNameAnswer(snapshot,personId,result){
 const subjects=snapshot.records.personSubjects||{};
 const subject=subjects[personId]||result.person;
 const roster=Object.values(subjects);
 return {ok:true,idempotent:!!result.idempotent,changed:!!result.changed,version:result.version,personId,nameReview:personNameState(subject,roster),pin:adminEncodePin(snapshot.tuple),snapshot:snapshot.info};
}
async function adminPersonNamePut(env,snapshot,result){
 const current=snapshot.reviewCache?.body??null;
 if(current!=null&&!ownerReviewsReadable(current))return {ok:false,reason:'review_store_unreadable'};
 if(current!=null&&!snapshot.reviewEtag)return {ok:false,reason:'review_unconditional'};
 const next=ownerReviewsWithPeople(current,[result.person,...(result.people||[])]);
 const onlyIf=snapshot.reviewEtag?{etagMatches:snapshot.reviewEtag}:{etagDoesNotMatch:'*'};
 const saved=await env.BUCKET.put(ADMIN_OWNER_REVIEWS_KEY,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf});
 if(!saved)return {ok:false,reason:'storage_conflict'};
 ADMIN_SNAPSHOT_CACHE=null;
 return {ok:true};
}
// A non-null put is not confirmation. The next read has to show the primary audit entry for this
// requestId and every committed record at its after-token. Anything else is an unknown outcome:
// the object may already hold the write, so the answer is not success and not a definite refusal.
function adminPersonNameVerified(snapshot,result){
 if(!snapshot||snapshot.error||!result?.review?.requestId)return false;
 if(!ownerReviewsReadable(snapshot.reviewCache?.body))return false;
 const subjects=snapshot.records.personSubjects||{};
 const person=subjects[result.person.id];
 if(!person)return false;
 const review=(person.nameReviews||[]).find(item=>item&&item.requestId===result.review.requestId&&item.linkedFrom==null);
 if(!review)return false;
 const roster=Object.values(subjects).filter(item=>item.id!==person.id);
 if(!personNameReviewCompletion(review,person,roster).complete)return false;
 for(const item of result.commit||[]){
  const record=item.id===person.id?person:subjects[item.id];
  if(!record||personNameVersion(record)!==item.version?.after)return false;
 }
 return true;
}
async function adminPersonNameRoute(request,env,url){
 const personId=adminPersonNameId(url.pathname);
 if(!personId)return adminError('not_found',404);
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 if(request.headers.get('X-IPTV-Admin-Action')!==OWNER_PERSON_NAME_ACTION)return adminError('action_not_allowed',403);
 const type=(request.headers.get('Content-Type')||'').split(';')[0].trim().toLowerCase();
 if(type!=='application/json')return adminError('invalid_json',400);
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d{1,6}$/.test(length)||Number(length)>ADMIN_PERSON_NAME_MAX))return adminError('body_too_large',413);
 let text;
 try{text=await request.text();}catch{return adminError('invalid_json',400);}
 if(text.length>ADMIN_PERSON_NAME_MAX)return adminError('body_too_large',413);
 let command;
 try{command=JSON.parse(text);}catch{return adminError('invalid_json',400);}
 if(!command||typeof command!=='object'||Array.isArray(command))return adminError('invalid_json',400);
 if(command.personId!==personId)return adminReviewFailure({reason:'person_mismatch'});
 for(let attempt=1;attempt<=2;attempt++){
  let snapshot;
  try{snapshot=await adminLoadSnapshot(env,false);}catch{return adminError('storage_unavailable',503);}
  if(snapshot.error)return adminError(snapshot.error,503);
  const subjects=snapshot.records.personSubjects||{};
  const person=subjects[personId]||null;
  if(!person)return adminReviewFailure({reason:'missing_person'});
  const roster=Object.values(subjects).filter(item=>item.id!==person.id);
  const result=applyPersonNameReview(person,command,new Date().toISOString(),roster);
  if(!result.ok)return adminReviewFailure(result);
  if(result.idempotent){
   const completion=personNameReviewCompletion(result.review,result.person,roster);
   if(!completion.complete)return adminReviewFailure({reason:'review_incomplete',records:completion.records});
   return json(adminPersonNameAnswer(snapshot,person.id,{...result,changed:false}));
  }
  if(!result.changed)return json(adminPersonNameAnswer(snapshot,person.id,result));
  const saved=await adminPersonNamePut(env,snapshot,result);
  if(saved.ok){
   let fresh=null;
   try{fresh=await adminLoadSnapshot(env,false);}catch{fresh=null;}
   if(!adminPersonNameVerified(fresh,result)){
    ADMIN_SNAPSHOT_CACHE=null;
    return adminReviewFailure({reason:'commit_unverified'});
   }
   return json(adminPersonNameAnswer(fresh,result.person.id,result));
  }
  if(saved.reason!=='storage_conflict'||attempt===2)return adminReviewFailure(saved);
  ADMIN_SNAPSHOT_CACHE=null;
 }
 return adminReviewFailure({reason:'storage_conflict'});
}
