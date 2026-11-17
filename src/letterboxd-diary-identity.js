// AIR-489 / ADR 0160 (option A). The bounded same-run Film bridge of a rated-only Diary id.
// A Diary row carries a Letterboxd id (poster) and the film slug of the same row. When the id has no TMDB link yet, one ordinary Ratings step may
// check the SOURCE for at most STEP_LIMIT ids, after the watched/rating facts are durable: an existing trusted D1 bridge is consumed first
// (catalogFilmIdentityBridge, read only); otherwise `boxd.it/<lid>` must land on `/film/<slug>/` of the same Diary row, the page must carry one movie
// `data-tmdb-id`, the page's canonical path and shortlink must agree and the TMDB movie document must agree with the page title and year. A title,
// a year or a slug alone is never proof (ADR 0087, ADR 0104 stays export-only). Only a unanimous result admits a Film through the existing fenced
// `applyRatedAdmissionRetention` (receipt pattern of ADR 0105) and links the movie id with the existing `LetterboxdFacts.linkFilm` alias protocol.
// Anything else stays `pending` in one bounded document with a reason and a retry time; only ordinary Ratings runs retry it. It never throws into the
// run: the rating fact and the Event do not wait for it. Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdDiaryIdentity=(()=>{
 const STEP_LIMIT=3,MAX_ATTEMPTS=6,STEP_BUDGET_MS=75000;
 const HOUR=3600000;
 const LID=/^[A-Za-z0-9_-]{1,80}$/,SLUG=/^[a-z0-9-]{1,200}$/,TMDB=/^[1-9]\d{0,11}$/;
 const TRANSPORT=new Set(['forbidden','rate_limited','challenge','timeout','fetch_failed','oversized','tmdb_unavailable']);
 const iso=ms=>new Date(ms).toISOString();
 // Retry spacing after attempt n: transport stops back off longer than a review (the source said no, not "not now").
 const delayMs=(reason,attempts)=>Math.min(48*HOUR,(TRANSPORT.has(reason)?2*HOUR:12*HOUR)*2**Math.min(Math.max(attempts-1,0),4));

 // Pure. The decision for one Diary id from what the source showed. page: {html,landing} from the redirect follow, detail: the TMDB movie document.
 function verifyPage({lid,slug,page},tools){
  if(!LID.test(String(lid||'')))return {state:'unresolved',reason:'invalid_lid'};
  if(typeof slug!=='string'||!SLUG.test(slug))return {state:'unresolved',reason:'slug_missing'};
  if(!page||typeof page.html!=='string'||!page.landing)return {state:'unresolved',reason:'page_missing'};
  const evidence=LetterboxdIdentity.pageEvidence(page.html,page.landing,tools);
  if(!evidence||evidence.kind!=='page')return {state:'unresolved',reason:evidence?.kind||'unparsable_page'};
  if(evidence.path!=='/film/'+slug+'/')return {state:'unresolved',reason:'slug_mismatch'};
  if(evidence.shortlinkPresent&&evidence.shortCode!==lid)return {state:'unresolved',reason:'shortlink_mismatch'};
  if(evidence.canonicalPath&&evidence.canonicalPath!==evidence.path)return {state:'unresolved',reason:'canonical_mismatch'};
  if(!evidence.tmdbIds.length)return {state:'unresolved',reason:'tmdb_missing'};
  if(evidence.tmdbIds.length>1)return {state:'unresolved',reason:'tmdb_multiple'};
  if(!(evidence.tmdbTypes.length===1&&evidence.tmdbTypes[0]==='movie'))return {state:'unresolved',reason:evidence.tmdbTypes.length?'tmdb_not_movie':'tmdb_type_missing'};
  if(!evidence.title)return {state:'unresolved',reason:'title_missing'};
  if(evidence.years.length!==1)return {state:'unresolved',reason:evidence.years.length?'page_year_inconsistent':'page_year_missing'};
  const tmdb=evidence.tmdbIds[0];
  if(!TMDB.test(tmdb))return {state:'unresolved',reason:'tmdb_invalid'};
  return {state:'page_ok',tmdb,title:evidence.title,year:evidence.years[0],filmPath:evidence.path};
 }
 function verify({lid,slug,page,detail},tools){
  const seen=verifyPage({lid,slug,page},tools);
  if(seen.state!=='page_ok')return seen;
  const agree=LetterboxdRatedAdmission.movieDetailAgrees(detail,seen.tmdb,seen.title,seen.year);
  if(!agree.ok)return {state:'unresolved',reason:agree.reason};
  return {state:'verified',tmdb:seen.tmdb,title:seen.title,year:seen.year,filmPath:seen.filmPath};
 }

 async function sha256(value){
  const bytes=new TextEncoder().encode(JSON.stringify(value)),digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
  return [...digest].map(byte=>byte.toString(16).padStart(2,'0')).join('');
 }

 const label=verdict=>({title:verdict.title,year:verdict.year,tmdb:verdict.tmdb});

 // One id whose source is to be checked now. Returns {state:'linked'|'pending',...}; a transport stop also returns `stop` so the step stops requesting.
 async function checkOne(env,{lid,slug},{clock,fetchImpl}){
  if(typeof LetterboxdRatedCandidates==='undefined'||typeof LetterboxdIdentity==='undefined'||typeof LetterboxdRatedAdmission==='undefined')return {state:'pending',reason:'unavailable'};
  const page=await LetterboxdRatedCandidates.follow(fetchImpl,lid);
  if(page.stop)return {state:'pending',reason:page.stop,stop:true};
  if(page.review)return {state:'pending',reason:page.review};
  // The film page must be the page of the Diary row's slug, with one movie id, before TMDB is asked at all.
  const seen=verifyPage({lid,slug,page},letterboxdPageTools());
  if(seen.state!=='page_ok')return {state:'pending',reason:seen.reason};
  const tmdb=seen.tmdb,found=await LetterboxdRatedCandidates.movieDetail(env,tmdb,fetchImpl);
  if(found.stop)return {state:'pending',reason:found.stop,stop:true};
  if(found.review)return {state:'pending',reason:found.review};
  const verdict=verify({lid,slug,page,detail:found.detail},letterboxdPageTools());
  if(verdict.state!=='verified')return {state:'pending',reason:verdict.reason};
  const verifiedAt=iso(clock()),evidenceSha256=await sha256({lid,slug,path:verdict.filmPath,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,source:'letterboxd_diary_page'});
  const admitted=await LetterboxdFacts.admitDiaryFilm(env,{lid,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,filmPath:verdict.filmPath,verifiedAt,evidenceSha256});
  if(admitted==='conflict'||admitted==='other_code')return {state:'pending',reason:'admission_conflict'};
  return {state:'verified',verdict,evidenceSha256,admitted};
 }

 // items: [{lid,slug}] of one Diary page, in page order, only ids whose facts are already durable. Returns {labels:Map lid->{title,year,tmdb},counts,pending}.
 async function resolve(env,items,{clock=()=>Date.now(),remaining=()=>Infinity,fetchImpl=fetch}={}){
  const counts={considered:0,bridged:0,verified:0,pending:0,deferred:0,skipped:0},labels=new Map();
  const wanted=[...new Map((items||[]).filter(item=>item&&LID.test(String(item.lid||''))).map(item=>[item.lid,item])).values()];
  if(!wanted.length)return {labels,counts};
  let links,stored;
  try{links=await LetterboxdFacts.diaryLinks(env,wanted.map(item=>item.lid));stored=await LetterboxdFacts.readDiaryIdentity(env);}catch{return {labels,counts:{...counts,skipped:wanted.length}};}
  const now=clock(),set={},clear=[];let fetched=0,stopped=false,gate=null;
  try{gate=await CanonicalCatalogReader.catalogReaderGate(env);}catch{gate=null;}
  const open=!!gate&&gate.mode==='d1'&&gate.state==='open';
  for(const item of wanted){
   const lid=item.lid,own=links.get(lid)||{};
   if(own.tmdb){clear.push(lid);continue;}
   if(!own.factKey){counts.skipped++;continue;}
   counts.considered++;
   const prior=stored.films[lid]||null,attempts=Number(prior?.attempts)||0;
   if(!open){counts.skipped++;continue;}
   // 1. An existing trusted D1 bridge is consumed, never re-proved or re-registered.
   let bridge=null;
   try{bridge=await CanonicalCatalogReader.catalogFilmIdentityBridge(env,lid);}catch(error){if(['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'].includes(error?.code)){counts.skipped++;continue;}bridge=null;}
   if(bridge?.state==='ok'&&bridge.tmdb){
    try{
     const linked=await LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:bridge.tmdb});
     if(linked.state==='linked'){counts.bridged++;clear.push(lid);const known=await CanonicalCatalogReader.catalogTitlesFromD1(env,[{id:'tmdb_'+bridge.tmdb,tmdbId:bridge.tmdb}],gate).catch(()=>({}));const title=known['tmdb_'+bridge.tmdb]?.title||null;labels.set(lid,{title,year:null,tmdb:bridge.tmdb});continue;}
     set[lid]={reason:'link_conflict',attempts:attempts+1,lastAttemptAt:iso(now),nextAttemptAt:iso(now+delayMs('link_conflict',attempts+1))};counts.pending++;continue;
    }catch{counts.skipped++;continue;}
   }
   if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){set[lid]={reason:'bridge_'+bridge.state,attempts:attempts+1,lastAttemptAt:iso(now),nextAttemptAt:iso(now+delayMs('review',attempts+1))};counts.pending++;continue;}
   // 2. A bounded source check, only for an id that is due and only while the lease leaves room.
   if(prior&&(attempts>=MAX_ATTEMPTS||Date.parse(prior.nextAttemptAt)>now)){counts.deferred++;continue;}
   if(stopped||fetched>=STEP_LIMIT||remaining()<STEP_BUDGET_MS){counts.deferred++;continue;}
   fetched++;
   let outcome;
   try{outcome=await checkOne(env,item,{clock,fetchImpl});}catch(error){outcome={state:'pending',reason:'check_failed'};}
   if(outcome.stop)stopped=true;
   if(outcome.state==='verified'){
    let admission=null;
    try{
     const receiptKey='tmdb_'+outcome.verdict.tmdb,{value:receipts}=await LetterboxdFacts.readAdmissionReceipts(env);
     const receipt=receipts?.films?.[receiptKey];
     if(!receipt)throw new Error('receipt_missing');
     admission=await CanonicalRatedAdmission.applyRatedAdmissionRetention(env,{event:'diary:'+lid,admissions:[{receiptKey,receipt}]});
     CanonicalRatedAdmission.assertRatedAdmissionAccepted(admission);
    }catch(error){admission=null;outcome={state:'pending',reason:error?.code==='admission_identity_held'||error?.reason?'admission_held':error?.code||'admission_failed'};}
    if(admission){
     const linked=await LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:outcome.verdict.tmdb}).catch(()=>({state:'error'}));
     if(linked.state==='linked'){counts.verified++;clear.push(lid);labels.set(lid,label(outcome.verdict));continue;}
     outcome={state:'pending',reason:linked.state==='conflict'?'link_conflict':'link_failed'};
    }
   }
   counts.pending++;
   set[lid]={reason:String(outcome.reason).slice(0,64),attempts:attempts+1,lastAttemptAt:iso(now),nextAttemptAt:iso(now+delayMs(outcome.reason,attempts+1))};
  }
  try{await LetterboxdFacts.updateDiaryIdentity(env,{set,clear:clear.filter(lid=>stored.films[lid])});}catch{}
  return {labels,counts};
 }

 return {STEP_LIMIT,MAX_ATTEMPTS,verifyPage,verify,resolve,delayMs};
})();
