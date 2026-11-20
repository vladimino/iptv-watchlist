// AIR-489 / ADR 0166 (option A). The bounded same-run Film bridge of a rated-only Diary id.
// A Diary row carries a Letterboxd id (poster) and the film slug of the same row. When the id has no TMDB link yet, one ordinary Ratings step may
// check the SOURCE for at most STEP_LIMIT ids, after the watched/rating facts are durable: an existing trusted D1 bridge is consumed first
// (catalogFilmIdentityBridge, read only); otherwise `boxd.it/<lid>` must land on `/film/<slug>/` of the same Diary row, the page must carry one movie
// `data-tmdb-id`, the page's canonical path and shortlink must agree and the TMDB movie document must agree with the page title and year. A title,
// a year or a slug alone is never proof (ADR 0087, ADR 0104 stays export-only). Only a unanimous result admits a Film through the existing fenced
// `applyRatedAdmissionRetention` (receipt pattern of ADR 0105) and links the movie id with the existing `LetterboxdFacts.linkFilm` alias protocol.
// Anything else stays `pending` in one bounded document with a reason and a retry time; only ordinary Ratings runs retry it. It never throws into the
// run: the rating fact and the Event do not wait for it. Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdDiaryIdentity=(()=>{
 const LINK_REASONS=new Set(['linking','link_failed']);
 // ADR 0184: an id whose Ratings link is durable but whose canonical claim is not proved yet keeps this bounded local state, so an id that has left Diary page 1 is still offered again by a later ordinary step (no source request, no Task).
 const CLAIM_REASON='claim_pending';
 const STEP_LIMIT=3,MAX_ATTEMPTS=6,STEP_BUDGET_MS=40000,WRITE_RESERVE_MS=15000;
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

 // The end-to-end budget of a step (review of PR #720): every network request is cut at the time left in the lease minus the reserve the canonical
 // writes need, and no write starts without that reserve. A cut request is a `timeout` pending, never a partial write.
 function budgeted(fetchImpl,remaining){
  return async(url,init={})=>{
   const left=remaining()-WRITE_RESERVE_MS;
   if(!(left>1000))throw Object.assign(new Error('step budget exhausted'),{name:'TimeoutError'});
   const signals=[AbortSignal.timeout(left)];if(init&&init.signal)signals.push(init.signal);
   return fetchImpl(url,{...init,signal:typeof AbortSignal.any==='function'?AbortSignal.any(signals):signals[0]});
  };
 }
 // Positive evidence of one fenced admission unit. A skipped route, a no-unit answer or any failed/unknown/refused/deferred count is not an admission.
 function admissionConfirmed(out){
  if(!out||out.state!=='complete')return false;
  if(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.refused||0)||Number(out.deferred||0))return false;
  return (Array.isArray(out.units)?out.units:[]).some(unit=>unit&&unit.kind==='film_admission'&&['applied','already','noop'].includes(unit.state));
 }

 // One id whose source is to be checked now. Returns {state:'verified'|'pending',...}; a transport stop also returns `stop` so the step stops requesting.
 async function checkOne(env,{lid,slug},{clock,fetchImpl,remaining}){
  if(typeof LetterboxdRatedCandidates==='undefined'||typeof LetterboxdIdentity==='undefined'||typeof LetterboxdRatedAdmission==='undefined')return {state:'pending',reason:'unavailable'};
  const net=budgeted(fetchImpl,remaining);
  const page=await LetterboxdRatedCandidates.follow(net,lid);
  if(page.stop)return {state:'pending',reason:page.stop,stop:true};
  if(page.review)return {state:'pending',reason:page.review};
  // The film page must be the page of the Diary row's slug, with one movie id, before TMDB is asked at all.
  const seen=verifyPage({lid,slug,page},letterboxdPageTools());
  if(seen.state!=='page_ok')return {state:'pending',reason:seen.reason};
  const tmdb=seen.tmdb,found=await LetterboxdRatedCandidates.movieDetail(env,tmdb,net);
  if(found.stop)return {state:'pending',reason:found.stop,stop:true};
  if(found.review)return {state:'pending',reason:found.review};
  const verdict=verify({lid,slug,page,detail:found.detail},letterboxdPageTools());
  if(verdict.state!=='verified')return {state:'pending',reason:verdict.reason};
  return {state:'verified',verdict};
 }
 // The receipt entry, written only after the link intent is durable.
 async function writeReceipt(env,{lid,slug},verdict,clock){
  const verifiedAt=iso(clock()),evidenceSha256=await sha256({lid,slug,path:verdict.filmPath,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,source:'letterboxd_diary_page'});
  return LetterboxdFacts.admitDiaryFilm(env,{lid,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,filmPath:verdict.filmPath,verifiedAt,evidenceSha256});
 }

 // items: [{lid,slug}] of one Diary page in page order (facts already durable). Pending entries that left the page (they keep the same-row slug) and ids
 // deferred by an earlier step are serviced here too, after the page's own ids, inside the same three-check budget. Returns {labels,counts}.
 async function resolve(env,items,{clock=()=>Date.now(),remaining=()=>Infinity,fetchImpl=fetch}={}){
  const counts={considered:0,bridged:0,verified:0,repaired:0,pending:0,deferred:0,skipped:0},labels=new Map();
  const page=[...new Map((items||[]).filter(item=>item&&LID.test(String(item.lid||''))).map(item=>[item.lid,{lid:item.lid,slug:typeof item.slug==='string'&&SLUG.test(item.slug)?item.slug:null,onPage:true}])).values()];
  let stored;
  try{stored=await LetterboxdFacts.readDiaryIdentity(env);}catch{return {labels,counts:{...counts,skipped:page.length}};}
  const now=clock(),onPage=new Set(page.map(item=>item.lid));
  // A link intent (`linking`, or a `link_failed` bridge) is a local repair: it is served at once, before source retries, whatever its source-attempt count or slug.
  const repair=entry=>entry&&LINK_REASONS.has(entry.reason);
  const claimDue=entry=>entry&&entry.reason===CLAIM_REASON&&TMDB.test(String(entry.tmdb||''))&&(Number(entry.attempts)||0)<MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now;
  const due=Object.entries(stored.films).filter(([lid,entry])=>!onPage.has(lid)&&entry&&(claimDue(entry)||(repair(entry)||typeof entry.slug==='string'&&SLUG.test(entry.slug)&&(Number(entry.attempts)||0)<MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now)))
   .sort(([,x],[,y])=>(repair(x)||claimDue(x))!==(repair(y)||claimDue(y))?((repair(x)||claimDue(x))?-1:1):String(x.nextAttemptAt)<String(y.nextAttemptAt)?-1:1).slice(0,STEP_LIMIT*2).map(([lid,entry])=>({lid,slug:entry.slug,onPage:false}));
  const wanted=[...page,...due];
  if(!wanted.length)return {labels,counts};
  let links;
  try{links=await LetterboxdFacts.diaryLinks(env,wanted.map(item=>item.lid));}catch{return {labels,counts:{...counts,skipped:wanted.length}};}
  const set={},clear=[],claimPairs=[];let fetched=0,stopped=false,gate=null;
  try{gate=await CanonicalCatalogReader.catalogReaderGate(env);}catch{gate=null;}
  const open=!!gate&&gate.mode==='d1'&&gate.state==='open';
  const entry=(item,reason,attempts,at)=>({reason:String(reason).slice(0,64),slug:item.slug||null,attempts,lastAttemptAt:iso(now),nextAttemptAt:iso(at)});
  // An id this step could not reach is kept for the next ordinary step (due now, attempts unchanged), never dropped.
  const defer=(item,prior)=>{counts.deferred++;if(item.onPage&&!prior&&item.slug)set[item.lid]={reason:'deferred',slug:item.slug||null,attempts:0,lastAttemptAt:null,nextAttemptAt:iso(now)};};
  // Before the first non-atomic effect (receipt, admission, alias, record link, projection) a bounded link intent is made durable, so a kill or a lost final write
  // after a partial commit leaves an entry that a later ordinary step repairs (review of PR #720). If it cannot be written, nothing is written (fail closed).
  const intend=async(item,tmdb,attempts)=>{
   const value={reason:'linking',slug:item.slug||null,tmdb:String(tmdb),attempts,lastAttemptAt:iso(now),nextAttemptAt:iso(now)};
   try{await LetterboxdFacts.updateDiaryIdentity(env,{set:{[item.lid]:value}});stored.films[item.lid]=value;return true;}catch{counts.persistFailed=1;return false;}
  };
  for(const item of wanted){
   const lid=item.lid,own=links.get(lid)||{};
   const prior=stored.films[lid]||null,attempts=Number(prior?.attempts)||0;
   // Already linked: nothing to check. A pending entry on a linked id is a bridge that failed after the alias and the record link were committed (review of PR #720):
   // the committed projection is repaired (no outbound request, no admission, no new fact) and the entry is cleared only when that succeeded.
   if(own.tmdb){
    // ADR 0184: a lid the Ratings link index already ties to a movie is offered for its canonical claim (the claim step re-proves it from the authoritative link; `already` is free).
    if(TMDB.test(String(own.tmdb)))claimPairs.push({lid,tmdb:String(own.tmdb)});
    if(!prior){clear.push(lid);continue;}
    if(prior.reason===CLAIM_REASON)continue; // served by the claim step below, not a link repair
    try{const repaired=await LetterboxdFacts.reprojectDiaryFilm(env,lid);if(repaired.state==='projected'){counts.repaired++;clear.push(lid);}else{counts.skipped++;}}catch{counts.skipped++;}
    continue;
   }
   if(prior&&prior.reason===CLAIM_REASON){clear.push(lid);continue;} // the Ratings link is gone: nothing to claim
   if(!own.factKey){counts.skipped++;continue;}
   // A bridge whose admission was confirmed but whose alias/record link did not commit (`link_failed` with its verified movie id) is completed locally:
   // no source request and no admission, whatever the source-attempt count. Only a confirmed admission ever writes this entry.
   if(prior&&prior.reason==='link_failed'&&TMDB.test(String(prior.tmdb||''))){
    try{
     const linked=await LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:String(prior.tmdb)});
     if(linked.state==='linked'){counts.repaired++;clear.push(lid);claimPairs.push({lid,tmdb:String(prior.tmdb)});}
     else{set[lid]={...prior,reason:'link_conflict',nextAttemptAt:iso(now+delayMs('link_conflict',attempts))};counts.pending++;}
    }catch{counts.skipped++;}
    continue;
   }
   counts.considered++;
   // Better same-row evidence keeps the retry alive: a newly seen usable slug is saved on the existing pending entry first (attempts and backoff unchanged), whatever follows.
   if(prior&&item.onPage&&item.slug&&prior.slug!==item.slug)set[lid]={...prior,slug:item.slug};
   if(!open){defer(item,prior);continue;}
   // 1. An existing trusted D1 bridge is consumed, never re-proved or re-registered.
   let bridge=null;
   try{bridge=await CanonicalCatalogReader.catalogFilmIdentityBridge(env,lid);}catch(error){if(['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'].includes(error?.code)){defer(item,prior);continue;}bridge=null;}
   if(bridge?.state==='ok'&&bridge.tmdb){
    if(!(await intend(item,bridge.tmdb,attempts))){counts.deferred++;continue;}
    try{
     const linked=await LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:bridge.tmdb});
     if(linked.state==='linked'){counts.bridged++;clear.push(lid);claimPairs.push({lid,tmdb:String(bridge.tmdb)});const known=await CanonicalCatalogReader.catalogTitlesFromD1(env,[{id:'tmdb_'+bridge.tmdb,tmdbId:bridge.tmdb}],gate).catch(()=>({}));const title=known['tmdb_'+bridge.tmdb]?.title||null;labels.set(lid,{title,year:null,tmdb:bridge.tmdb});continue;}
     set[lid]=entry(item,'link_conflict',attempts+1,now+delayMs('link_conflict',attempts+1));counts.pending++;continue;
    }catch{defer(item,prior);continue;}
   }
   if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){set[lid]=entry(item,'bridge_'+bridge.state,attempts+1,now+delayMs('review',attempts+1));counts.pending++;continue;}
   // 2. A bounded source check, only for an id that is due and only while the lease leaves room.
   if(prior&&(attempts>=MAX_ATTEMPTS||Date.parse(prior.nextAttemptAt)>now)){
    // An intent whose alias never committed is an ordinary source retry: at the cap it stops being served as a repair.
    if(attempts>=MAX_ATTEMPTS&&LINK_REASONS.has(prior.reason))set[lid]={...prior,...(set[lid]||{}),reason:'link_interrupted'};
    counts.deferred++;continue;
   }
   if(!item.slug){set[lid]=entry(item,'slug_missing',attempts+1,now+delayMs('review',attempts+1));counts.pending++;continue;}
   if(stopped||fetched>=STEP_LIMIT||remaining()<STEP_BUDGET_MS){defer(item,prior);continue;}
   fetched++;
   let outcome;
   try{outcome=await checkOne(env,item,{clock,fetchImpl,remaining});}catch(error){outcome={state:'pending',reason:'check_failed'};}
   if(outcome.stop)stopped=true;
   if(outcome.state==='verified'){
    let confirmed=false;
    try{
     if(remaining()<WRITE_RESERVE_MS)throw Object.assign(new Error('budget'),{code:'budget'});
     if(!(await intend(item,outcome.verdict.tmdb,attempts+1)))throw Object.assign(new Error('intent_unwritten'),{code:'intent_unwritten'});
     const admitted=await writeReceipt(env,item,outcome.verdict,clock);
     if(admitted==='conflict'||admitted==='other_code')throw Object.assign(new Error('admission_conflict'),{code:'admission_conflict'});
     const receiptKey='tmdb_'+outcome.verdict.tmdb,{value:receipts}=await LetterboxdFacts.readAdmissionReceipts(env);
     const receipt=receipts?.films?.[receiptKey];
     if(!receipt)throw new Error('receipt_missing');
     const admission=await CanonicalRatedAdmission.applyRatedAdmissionRetention(env,{event:'diary:'+lid,admissions:[{receiptKey,receipt}]});
     confirmed=admissionConfirmed(admission);
     if(!confirmed)outcome={state:'pending',reason:admission?.state==='skipped'?'admission_skipped':'admission_not_confirmed'};
    }catch(error){outcome={state:'pending',reason:error?.code==='admission_identity_held'||error?.reason?'admission_held':error?.code||'admission_failed'};}
    if(confirmed){
     const linked=await LetterboxdFacts.bridgeDiaryFilm(env,{lid,tmdb:outcome.verdict.tmdb}).catch(()=>({state:'error'}));
     if(linked.state==='linked'){counts.verified++;clear.push(lid);claimPairs.push({lid,tmdb:String(outcome.verdict.tmdb)});labels.set(lid,label(outcome.verdict));continue;}
     outcome={state:'pending',reason:linked.state==='conflict'?'link_conflict':'link_failed',...(linked.state==='conflict'?{}:{tmdb:outcome.verdict.tmdb})};
    }
   }
   counts.pending++;
   set[lid]={...entry(item,outcome.reason,attempts+1,now+delayMs(outcome.reason,attempts+1)),...(outcome.tmdb?{tmdb:String(outcome.tmdb)}:{})};
  }
  try{await LetterboxdFacts.updateDiaryIdentity(env,{set,clear:clear.filter(lid=>stored.films[lid])});}catch{counts.persistFailed=1;}
  // ADR 0184: the canonical Letterboxd claim of the ids whose Ratings link is now durable (after the facts and the settled pending document). Never throws, never delays the rating or the Event.
  // INACTIVE (the module's activation constant is off): nothing is requested and nothing is stored. ACTIVE: an id whose claim is not proved (refused, unknown, deferred, failed, not attempted for budget or cap) keeps a bounded
  // `claim_pending` entry that later ordinary steps serve, also when the id has left Diary page 1; a proved claim clears it. Attempts are bounded like every source retry and the entry stays visible after the last one.
  if(claimPairs.length&&typeof CanonicalLetterboxdClaim!=='undefined'){
   let claimed=null;
   if(remaining()>=WRITE_RESERVE_MS){
    try{claimed=await CanonicalLetterboxdClaim.ensureLetterboxdClaims(env,{pairs:claimPairs});}catch{claimed={state:'failed',results:[],unattempted:claimPairs.map(pair=>pair.lid)};}
   }
   const live=claimed?claimed.state!=='inactive':CanonicalLetterboxdClaim.LETTERBOXD_CLAIM_ACTIVATED===true;
   if(live){
    const proved=new Set((claimed?.results||[]).filter(result=>result.state==='written'||result.state==='already').map(result=>result.lid));
    const tried=new Set((claimed?.results||[]).map(result=>result.lid));
    const claimSet={},claimClear=[];
    for(const pair of claimPairs){
     const prior=stored.films[pair.lid]&&stored.films[pair.lid].reason===CLAIM_REASON?stored.films[pair.lid]:null;
     if(proved.has(pair.lid)){if(prior)claimClear.push(pair.lid);continue;}
     // an id the call did not try keeps its attempts and is due again at once; a tried and unproved one backs off like a review
     const attemptsNow=(Number(prior?.attempts)||0)+(tried.has(pair.lid)?1:0);
     claimSet[pair.lid]={reason:CLAIM_REASON,slug:null,tmdb:pair.tmdb,attempts:attemptsNow,lastAttemptAt:iso(now),nextAttemptAt:iso(tried.has(pair.lid)?now+delayMs('review',Math.max(attemptsNow,1)):now)};
    }
    counts.claim=claimed&&claimed.state==='complete'?'complete':claimed?'incomplete':'skipped';
    if(Object.keys(claimSet).length||claimClear.length){try{await LetterboxdFacts.updateDiaryIdentity(env,{set:claimSet,clear:claimClear});}catch{counts.persistFailed=1;}}
   }
  }
  return {labels,counts};
 }

 return {STEP_LIMIT,MAX_ATTEMPTS,STEP_BUDGET_MS,WRITE_RESERVE_MS,admissionConfirmed,verifyPage,verify,resolve,delayMs};
})();
