// AIR-675 / ADR 0217 (Accepted) decision 8a, DORMANT. The owner re-check of ONE lid-only Film:
//  POST /api/admin/letterboxd/lid-recheck   {lid, requestId}
// Behind the same owner authorization as the other admin writes (the Worker verifies the Access JWT, the audience `ADMIN_ACCESS_AUD`, the expiry and the owner subject `ADMIN_OWNER_EMAIL`, plus its own Origin, the action header
// `X-IPTV-Admin-Action: letterboxd_lid_recheck` and a JSON content type; unconfigured is closed, 503). One lid per request; a repeat with the SAME requestId makes progress (a settled intent is answered by readback, no fetch). Natural sync
// never attaches, and nothing calls this route automatically: no cron, Workflow, Task or self-fetch.
// It refuses BEFORE its first effect (no source request, no write, no intent row) while the admission marker is not `d1`, while migrations 0048, 0050 or 0051 are not applied, and while the identity evidence writer `lid_tmdb_attach`
// is not actually `on` (never enabled by this route). The coordinator, the intent, the attach and the Ratings link handoff are `LetterboxdLidAttach` (src/letterboxd-lid-attach.js).
const LID_RECHECK_ACTION='letterboxd_lid_recheck';
const LID_RECHECK_BODY_LIMIT=1024;
const LID_RECHECK_LID=/^[A-Za-z0-9_-]{1,80}$/;
const LID_RECHECK_REQUEST=/^[\x21-\x7e]{1,200}$/;
// The bounded source check of ONE lid, by the ACCEPTED verified movie check and nothing stricter (ADR 0217 decision 8b: "no new proof semantics"): `LetterboxdRatedCandidates.follow` (the boxd.it redirect, the ADR 0166 hop limits and hosts), the typed
// TMDB state of the page (`tmdbCheckState`), then `LetterboxdDiaryIdentity.verifyPage` and `verify` (the very functions of the Diary and Watchlist check: the page's slug is the redirect's landing slug, a PRESENT shortlink that names another lid or a
// canonical path that contradicts the landing is refused, exactly one movie id of type `movie`, a title and exactly one year; the TMDB movie document must agree). A real page may carry no `<link rel="shortlink">` and no canonical tag (AIR-678
// captures): their absence is handled by the existing rules (it refuses nothing here), as it is by the Diary check; only a PRESENT contradiction refuses. The redirect binding is kept: the lid resolves through boxd.it to ONE film page and every
// identity input is read from that landing. A typed state of ADR 0217 decision 3 other than `tmdb_movie` is returned as the state itself (the coordinator makes it a terminal outcome); a transport stop is `tmdb_unavailable` (non-terminal, no
// attempt). No raw HTML is kept and H1 (`tmdb_none`) is NOT produced or relaxed here.
async function lidRecheckSource(env,lid,{fetchImpl=fetch}={}){
 const net=typeof UpstreamCooldown==='undefined'?fetchImpl:UpstreamCooldown.createCoordinator(env,{caller:'lid-recheck'}).guard(fetchImpl);
 const state=checked=>checked.retryClass==='transport'||checked.state==='tmdb_unavailable'?{ok:true,state:'tmdb_unavailable',reason:checked.outcome||'tmdb_unavailable'}:{ok:true,state:checked.state};
 const page=await LetterboxdRatedCandidates.follow(net,lid);
 let evidence=null;
 if(page&&typeof page.html==='string'){try{evidence=LetterboxdIdentity.pageEvidence(page.html,page.landing,letterboxdPageTools());}catch{evidence=null;}}
 let checked=LetterboxdRatedAdmission.tmdbCheckState({fetched:page,evidence});
 if(checked.state!=='page_movie')return state(checked);
 const landing=/^\/film\/([a-z0-9-]{1,200})\/$/.exec(new URL(String(page.landing?.href??page.landing)).pathname);
 if(!landing)return {ok:true,state:'page_refused',reason:'landing_not_film'};
 const slug=landing[1];
 const seen=LetterboxdDiaryIdentity.verifyPage({lid,slug,page},letterboxdPageTools());
 if(seen.state!=='page_ok')return {ok:true,state:'page_refused',reason:seen.reason};
 const found=await LetterboxdRatedCandidates.movieDetail(env,seen.tmdb,net);
 checked=LetterboxdRatedAdmission.tmdbCheckState({fetched:page,evidence,detail:found});
 if(checked.state!=='tmdb_movie')return state(checked);
 const verdict=LetterboxdDiaryIdentity.verify({lid,slug,page,detail:found.detail},letterboxdPageTools());
 if(verdict.state!=='verified')return {ok:true,state:'tmdb_disagrees',reason:verdict.reason};
 return {ok:true,state:'tmdb_movie',proof:{slug,path:verdict.filmPath,finalUrl:String(page.landing?.href??page.landing),tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,detail:found.detail}};
}
async function lidRecheckBody(request){
 const length=request.headers.get('Content-Length');
 if(length!==null&&(!/^\d{1,9}$/.test(length)||Number(length)>LID_RECHECK_BODY_LIMIT))return {error:'body_too_large'};
 let text;try{text=await request.text();}catch{return {error:'invalid_json'};}
 if(text.length>LID_RECHECK_BODY_LIMIT)return {error:'body_too_large'};
 let value;try{value=JSON.parse(text);}catch{return {error:'invalid_json'};}
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='lid,requestId')return {error:'invalid_body'};
 if(typeof value.lid!=='string'||!LID_RECHECK_LID.test(value.lid))return {error:'invalid_lid'};
 if(typeof value.requestId!=='string'||!LID_RECHECK_REQUEST.test(value.requestId))return {error:'invalid_request_id'};
 return {value};
}
// The typed refusals of the coordinator (all before the first effect), as an owner-readable answer.
const LID_RECHECK_REFUSALS={evidence_writer_inactive:409,letterboxd_admission_closed:409,admission_unavailable:503,film_person_unavailable:503,film_person_fence:503,film_person_held:503,receipt_schema_missing:503,receipt_baseline_missing:503};
async function adminLidRecheckRoute(request,env,url){
 if(request.method!=='POST')return adminError('method_not_allowed',405);
 if(request.headers.get('Origin')!==url.origin)return adminError('origin_not_allowed',403);
 if(request.headers.get('X-IPTV-Admin-Action')!==LID_RECHECK_ACTION)return adminError('action_not_allowed',403);
 if(mcpMediaType(request.headers.get('Content-Type'))!=='application/json')return adminError('content_type_not_json',415);
 const access=await identityOwnerAccess(request,env);
 if(!access.ok)return adminError(access.code,access.status);
 const parsed=await lidRecheckBody(request);
 if(parsed.error)return adminError(parsed.error,400);
 if(typeof LetterboxdLidAttach==='undefined'||typeof LetterboxdFacts==='undefined'||typeof LetterboxdRatedCandidates==='undefined'||typeof LetterboxdDiaryIdentity==='undefined')return adminError('reader_unavailable',503);
 const {lid,requestId}=parsed.value;
 try{
  const out=await LetterboxdLidAttach.lidRecheck(env,{lid,requestId,reacquire:()=>lidRecheckSource(env,lid),ports:{link:args=>LetterboxdFacts.linkAttachedPair(env,args),complete:args=>LetterboxdFacts.completeAttachedLink(env,args)}});
  if(out.outcome==='request_conflict')return json({error:'request_conflict',lid,requestId},409);
  return json({lid,requestId,by:access.by,...out});
 }catch(error){
  const code=typeof error?.code==='string'?error.code:'unavailable';
  const status=LID_RECHECK_REFUSALS[code];
  if(status)return json({error:code,reason:error.reason??null,writerState:error.writerState??null,committed:false},status);
  return adminError(code==='film_person_invalid'?'invalid_request':code,code==='film_person_invalid'?400:503);
 }
}
