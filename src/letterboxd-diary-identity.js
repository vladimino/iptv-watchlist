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
 const HOUR=3600000,MINUTE=60000;
 // AIR-599 (review of PR #1009): the exclusive ownership of ONE source check. Before it reaches the source a step reserves the id on the shared entry (a `reservation` with its check id and an expiry). Another step skips a reserved id
 // (`in_flight`), so one reservation means at most one real check; a crash leaves a reservation that simply expires; every write of the holder is bound to the reserved entry, so an owner action in between voids it.
 const RESERVATION_MS=5*MINUTE;
 const LID=/^[A-Za-z0-9_-]{1,80}$/,SLUG=/^[a-z0-9-]{1,200}$/,TMDB=/^[1-9]\d{0,11}$/;
 const iso=ms=>new Date(ms).toISOString();
 // AIR-599 / ADR 0207 decision 4b: ONE classifier for both callers of the check (the Ratings Diary phase and the Watchlist admission step).
 //  transport  no attempt; the place in the queue is kept; `streak + 1`; due again after 15 min · 2^min(streak − 1, 5) (at most 8 h)
 //  not_now    no attempt; the place is kept; due again at the next run
 //  gone       a 404 or 410 of boxd.it, the film page or the TMDB movie: +1 attempt, review backoff
 //  definite   any other answer that disagrees or cannot be used: +1 attempt, review backoff; owner review at the cap
 //  settled    verified and admitted / present, or dismissed by the owner
 const TRANSPORT_REASONS=new Set(['forbidden','challenge','rate_limited','timeout','network_error','upstream_5xx','tmdb_unavailable','upstream_cooldown']);
 const NOT_NOW_REASONS=new Set(['deferred','unavailable','admission_closed','admission_unavailable','in_flight','admission_skipped','admission_held','diary_cap','epoch_fenced','persist_failed','owner_requeued','entry_changed','checking']);
 const GONE_REASONS=new Set(['not_found']);
 const SETTLED_REASONS=new Set(['verified','linked','owner_dismissed']);
 function classify(reason){
  const r=String(reason||'');
  if(TRANSPORT_REASONS.has(r))return 'transport';
  if(NOT_NOW_REASONS.has(r))return 'not_now';
  if(GONE_REASONS.has(r))return 'gone';
  if(SETTLED_REASONS.has(r))return 'settled';
  return 'definite';
 }
 // The class an owner sees: an entry at the attempt cap is terminal and visible (`needs_owner_review`), never dropped.
 const visibleClass=entry=>!entry?null:(Number(entry.attempts)||0)>=MAX_ATTEMPTS&&classify(entry.reason)!=='settled'?'needs_owner_review':classify(entry.reason);
 // Review backoff after the n-th charged attempt: 12 h · 2^(n − 1), capped at 48 h. Transport backoff after the n-th consecutive transport stop: 15 min · 2^min(n − 1, 5).
 const reviewDelayMs=attempts=>Math.min(48*HOUR,12*HOUR*2**Math.min(Math.max(attempts-1,0),4));
 const transportDelayMs=streak=>15*MINUTE*2**Math.min(Math.max(streak-1,0),5);
 // Kept for callers that still pass a reason (the claim backoff): a transport reason waits like a transport stop, anything else like a review.
 const delayMs=(reason,attempts)=>classify(reason)==='transport'?transportDelayMs(attempts):reviewDelayMs(attempts);
 // Errors of the admission write that mean "not now" (the writer, its fence or its marker), not "the source said no".
 const ADMISSION_NOT_NOW={film_person_unavailable:'admission_unavailable',film_person_fence:'admission_unavailable',film_person_held:'admission_held',admission_unavailable:'admission_unavailable',canonical_read_unavailable:'admission_unavailable',letterboxd_epoch_fence:'epoch_fenced',operation_key_in_flight:'in_flight',budget:'deferred',intent_unwritten:'deferred'};
 // The source answers of one fetch, split (AIR-599): a 404/410 is `not_found` (gone), a 5xx is `upstream_5xx` (transport), a network failure is `network_error`.
 function pageReason(result){
  if(result.stop)return result.stop==='fetch_failed'&&result.network?'network_error':result.stop;
  if((result.review==='fetch_failed'||result.review==='tmdb_fetch_failed')&&Number.isInteger(result.status)){
   if(result.status===404||result.status===410)return 'not_found';
   if(result.status>=500)return 'upstream_5xx';
  }
  return result.review;
 }

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
  const wrapped=async(url,init={})=>{
   const left=remaining()-WRITE_RESERVE_MS;
   if(!(left>1000))throw Object.assign(new Error('step budget exhausted'),{name:'TimeoutError'});
   const signals=[AbortSignal.timeout(left)];if(init&&init.signal)signals.push(init.signal);
   return fetchImpl(url,{...init,signal:typeof AbortSignal.any==='function'?AbortSignal.any(signals):signals[0]});
  };
  wrapped.coordinator=fetchImpl.coordinator;// AIR-604: the shared upstream cooldown rides along to the bounded fetches
  return wrapped;
 }
 // Positive evidence of one fenced admission unit. A skipped route, a no-unit answer or any failed/unknown/refused/deferred count is not an admission.
 function admissionConfirmed(out){
  if(!out||out.state!=='complete')return false;
  if(Number(out.failed||0)||Number(out.unknown||0)||Number(out.preflightFailed||0)||Number(out.refused||0)||Number(out.deferred||0))return false;
  return (Array.isArray(out.units)?out.units:[]).some(unit=>unit&&unit.kind==='film_admission'&&['applied','already','noop'].includes(unit.state));
 }

 // One id whose source is to be checked now. Returns {state:'verified'|'pending',reason,...}; a transport stop also returns `stop` so the step stops requesting.
 async function checkOne(env,{lid,slug},{clock,fetchImpl,remaining}){
  if(typeof LetterboxdRatedCandidates==='undefined'||typeof LetterboxdIdentity==='undefined'||typeof LetterboxdRatedAdmission==='undefined')return {state:'pending',reason:'unavailable'};
  const net=budgeted(fetchImpl,remaining);
  const answer=result=>{const reason=pageReason(result);return {state:'pending',reason,...(classify(reason)==='transport'?{stop:true}:{}),...(Number.isFinite(result.until)?{until:result.until}:{})};};
  const page=await LetterboxdRatedCandidates.follow(net,lid);
  if(page.stop||page.review)return answer(page);
  // The film page must be the page of the Diary row's slug, with one movie id, before TMDB is asked at all.
  const seen=verifyPage({lid,slug,page},letterboxdPageTools());
  if(seen.state!=='page_ok')return {state:'pending',reason:seen.reason};
  const tmdb=seen.tmdb,found=await LetterboxdRatedCandidates.movieDetail(env,tmdb,net);
  if(found.stop||found.review)return answer(found);
  const verdict=verify({lid,slug,page,detail:found.detail},letterboxdPageTools());
  if(verdict.state!=='verified')return {state:'pending',reason:verdict.reason};
  return {state:'verified',verdict,pageDigest:await pageCheckDigest({lid,slug},verdict)};
 }
 // The page-check digest (ADR 0213 decision 2): the identity of the checked page content, the same for the Diary and the Watchlist caller checking the same page. It is the admission receipt's `evidenceSha256` and, handed over with
 // the link (AIR-618, ADR 0215 choice 0215-8b = C), the causal root of the claim's bridge evidence row. Only a check this very step performed has one: the bridge, repair and claim-retry paths below hand over none.
 const pageCheckDigest=({lid,slug},verdict)=>sha256({lid,slug,path:verdict.filmPath,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,source:'letterboxd_diary_page'});
 // The receipt entry, written only after the link intent is durable.
 async function writeReceipt(env,{lid,slug},verdict,clock,pageDigest){
  const verifiedAt=iso(clock()),evidenceSha256=pageDigest||await pageCheckDigest({lid,slug},verdict);
  return LetterboxdFacts.admitDiaryFilm(env,{lid,tmdb:verdict.tmdb,title:verdict.title,year:verdict.year,filmPath:verdict.filmPath,verifiedAt,evidenceSha256});
 }

 // items: [{lid,slug,queuedAt?,attempts?}] of one caller, in its order (the Ratings Diary phase: one Diary page, facts already durable; the Watchlist admission step: its due
 // ledger rows, with the queue time and the attempt count of each row). Pending entries that left the page, ids waiting in the backlog and ids deferred by an earlier
 // step are serviced here too, inside the same three-check budget. AIR-599 / ADR 0207 decision 4b:
 //  - every requested id gets an explicit outcome {checked, class, reason, retryAt, attempts, streak, terminal}; callers charge from it, never from timestamps;
 //  - the attempt count lives only in the shared entry and is charged once per real check (`gone` or `definite`), in the write that records the check;
 //  - due ids run in one stable order: link repairs and pending claims first, then by queue position (`queuedAt`, oldest first);
 //  - an id without an entry is not checked while the document is full of entries it may not evict: it goes to the bounded backlog (`cap_refused`).
 // route: 'ratings_diary' | 'watchlist_admission' (the caller whose step performs the check). Returns {labels,counts,outcomes}.
 async function resolve(env,items,{clock=()=>Date.now(),remaining:callerRemaining=()=>Infinity,fetchImpl:baseFetch=fetch,route='ratings_diary'}={}){
  // AIR-604 (ADR 0211 decision 5): the shared Letterboxd and TMDB cooldown. `off` and an unavailable state change nothing; an enforced cooldown stops the check as a transport stop `upstream_cooldown`, which costs no attempt.
  const fetchImpl=typeof UpstreamCooldown==='undefined'||baseFetch.coordinator?baseFetch:UpstreamCooldown.createCoordinator(env,{caller:'letterboxd-identity:'+route}).guard(baseFetch);
  const counts={considered:0,bridged:0,verified:0,repaired:0,pending:0,deferred:0,skipped:0,checked:0,transport:0,notNow:0,gone:0,definite:0,atCap:0,capRefused:0,backlogFull:0},labels=new Map(),outcomes=new Map();
  const now=clock();
  // AIR-599 (fourth review of PR #1009): the reservation expires at now+RESERVATION_MS. No effect of this step may begin or run on after that: the time left is also bounded by the reservation (less the write reserve and a
  // 15 s margin), whatever deadline the caller passed (`Infinity` by default), so an expired holder has already stopped when another caller can take the id over. At commit the holder's writes are bound to its reservation anyway.
  const remaining=()=>Math.min(callerRemaining(),now+RESERVATION_MS-15000-clock());
  const ISO_TIME=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
  const page=[...new Map((items||[]).filter(item=>item&&LID.test(String(item.lid||''))).map(item=>[item.lid,{lid:item.lid,slug:typeof item.slug==='string'&&SLUG.test(item.slug)?item.slug:null,onPage:true,queuedAt:ISO_TIME.test(String(item.queuedAt||''))?item.queuedAt:iso(now),seed:Number.isInteger(item.attempts)&&item.attempts>0?Math.min(item.attempts,MAX_ATTEMPTS):0,reason:typeof item.reason==='string'&&item.reason?item.reason.slice(0,60):null,guard:Array.isArray(item.guard)&&typeof item.guard[0]==='string'&&Array.isArray(item.guard[1])?item.guard:null}])).values()];
  const notNowAll=reason=>{for(const item of page)outcomes.set(item.lid,{checked:false,class:'not_now',reason,retryAt:null,attempts:null,streak:null,terminal:false});};
  let stored;
  try{stored=await LetterboxdFacts.readDiaryIdentity(env);}catch{notNowAll('unavailable');return {labels,outcomes,counts:{...counts,skipped:page.length}};}
  const backlogIds=stored.backlog&&typeof stored.backlog==='object'?stored.backlog:{};
  const onPage=new Set(page.map(item=>item.lid));
  // An id waiting in the backlog keeps the queue time it had there.
  for(const item of page)if(backlogIds[item.lid]){if(ISO_TIME.test(String(backlogIds[item.lid].queuedAt||''))&&String(backlogIds[item.lid].queuedAt)<item.queuedAt)item.queuedAt=backlogIds[item.lid].queuedAt;item.fromBacklog=true;item.seed=Math.max(item.seed||0,Number(backlogIds[item.lid].attempts)||0);}
  // A link intent (`linking`, or a `link_failed` bridge) is a local repair: it is served at once, before source retries, whatever its source-attempt count or slug.
  const repair=entry=>entry&&LINK_REASONS.has(entry.reason);
  const claimDue=entry=>entry&&entry.reason===CLAIM_REASON&&TMDB.test(String(entry.tmdb||''))&&(Number(entry.attempts)||0)<MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now;
  const first=entry=>!!(repair(entry)||claimDue(entry));
  const queuePos=entry=>String(entry?.queuedAt||entry?.lastAttemptAt||entry?.nextAttemptAt||'');
  const reservedActive=entry=>!!entry&&!!entry.reservation&&Date.parse(entry.reservation.until)>now;
  const due=Object.entries(stored.films).filter(([lid,entry])=>!onPage.has(lid)&&entry&&entry.reason!=='owner_dismissed'&&!reservedActive(entry)&&(claimDue(entry)||(repair(entry)||typeof entry.slug==='string'&&SLUG.test(entry.slug)&&(Number(entry.attempts)||0)<MAX_ATTEMPTS&&Date.parse(entry.nextAttemptAt)<=now)))
   .sort(([,x],[,y])=>first(x)!==first(y)?(first(x)?-1:1):queuePos(x)<queuePos(y)?-1:queuePos(x)>queuePos(y)?1:0).slice(0,STEP_LIMIT*2).map(([lid,entry])=>({lid,slug:entry.slug,onPage:false,queuedAt:queuePos(entry)}));
  // The capacity of the document: every entry it may not evict (all but `owner_dismissed`) holds a place.
  const cap=Number.isInteger(LetterboxdFacts.DIARY_IDENTITY_CAP)?LetterboxdFacts.DIARY_IDENTITY_CAP:200;
  let slots=cap-Object.values(stored.films).filter(entry=>entry&&entry.reason!=='owner_dismissed').length;
  // Backlog ids enter before new page ids when capacity returns, oldest first. An id the backlog holds that already has an entry is removed from the backlog.
  const backlogRemove=[],backlogAdd={};
  for(const lid of Object.keys(backlogIds))if(stored.films[lid])backlogRemove.push(lid);
  const intake=Object.entries(backlogIds).filter(([lid])=>!stored.films[lid]&&!onPage.has(lid)&&LID.test(lid)).sort(([,x],[,y])=>String(x.queuedAt)<String(y.queuedAt)?-1:1)
   .slice(0,Math.max(0,Math.min(slots,STEP_LIMIT*2))).map(([lid,item])=>({lid,slug:typeof item.slug==='string'&&SLUG.test(item.slug)?item.slug:null,onPage:false,fromBacklog:true,queuedAt:String(item.queuedAt||iso(now)),seed:Math.min(MAX_ATTEMPTS,Math.max(0,Number(item.attempts)||0))}));
  const order=item=>{const prior=stored.films[item.lid];return {first:first(prior)?0:1,pos:prior?queuePos(prior):item.queuedAt};};
  const wanted=[...page,...due,...intake].map((item,index)=>({item,index,...order(item)})).sort((x,y)=>x.first-y.first||(x.pos<y.pos?-1:x.pos>y.pos?1:0)||x.index-y.index).map(entry=>entry.item);
  if(!wanted.length){if(backlogRemove.length)await LetterboxdFacts.updateDiaryIdentity(env,{backlogRemove,expectBacklog:Object.fromEntries(backlogRemove.map(lid=>[lid,JSON.stringify(backlogIds[lid])])),expect:Object.fromEntries(backlogRemove.map(lid=>[lid,JSON.stringify(stored.films[lid])]))}).catch(()=>null);return {labels,outcomes,counts};}
  let links;
  try{links=await LetterboxdFacts.diaryLinks(env,wanted.map(item=>item.lid));}catch{notNowAll('unavailable');return {labels,outcomes,counts:{...counts,skipped:wanted.length}};}
  const set={},clear=[],claimPairs=[],checked=new Set(),settled=new Map();let fetched=0,stopped=false,gate=null;
  // AIR-599 (review of PR #1009): every write of this step is bound to the entry as this step READ it. `base` is that state per id (a JSON text, or null when there was no entry) and moves only with this step's own
  // successful intent write; the document's compare-and-swap installs a replacement for an id only while the stored entry still equals its base. An owner `requeue` or `dismiss`, or another caller's check, that landed
  // while this step waited on the source is therefore never overwritten by a stale absolute replacement (that outcome is `entry_changed`: not now, no attempt).
  const base=new Map(Object.entries(stored.films).map(([id,entry])=>[id,JSON.stringify(entry)]));
  const expectOf=lids=>Object.fromEntries([...lids].map(lid=>[lid,base.get(lid)??null]));
  // The backlog records as this step read them, and the check reservations this step holds.
  const baseB=Object.fromEntries(Object.entries(backlogIds).map(([id,record])=>[id,JSON.stringify(record)]));
  const mine=new Map();
  // AIR-599 (fifth review of PR #1009): the env an EFFECT commits through carries its reservation (`effectGuard`): every Ratings or canonical batch of the effect asserts that the shared check document still holds this check
  // id, so an effect whose reservation was released, taken over or voided by an owner action (also after the reservation expired) is refused at commit. No reservation, no effect.
  const guarded=lid=>{const guard=mine.has(lid)?LetterboxdFacts.reservationGuard(mine.get(lid)):null;return guard?{...env,effectGuard:guard}:null;};
  // A local effect (a trusted-bridge link, a link repair) needs no lease budget, but never starts once the reservation window is spent.
  const late=()=>clock()>=now+RESERVATION_MS-15000;
  // The ledger-row token guards of the items whose budget a write applies (each once): a seed read before an owner action is never installed after it.
  const guardsOf=lids=>{const seen={},out=[];for(const lid of lids){const guard=wanted.find(item=>item.lid===lid)?.guard;if(guard&&!seen[lid]){seen[lid]=true;out.push(guard);}}return out;};
  try{gate=await CanonicalCatalogReader.catalogReaderGate(env);}catch{gate=null;}
  const open=!!gate&&gate.mode==='d1'&&gate.state==='open';
  const newCheckId=()=>typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function'?crypto.randomUUID():String(now)+'-'+Math.random().toString(36).slice(2,12);
  // The one place an entry is written from an outcome. Only `gone` and `definite` charge an attempt (with a fresh check id); `transport` raises the streak and backs off;
  // `not_now` and a link intent keep the count and are due again at the next run. The queue position is never changed.
  const record=(item,reason,{tmdb=null,until=null}={})=>{
   const cur=set[item.lid]||stored.films[item.lid]||null,cls=classify(reason),intent=LINK_REASONS.has(reason)||reason===CLAIM_REASON;
   const before=Math.max(cur?Number(cur.attempts)||0:0,item.seed||0),streakBefore=Number(cur?.streak)||0;
   let attempts=before,streak=streakBefore,next=now,checkId=cur?.checkId||null;
   if(intent||cls==='not_now'){/* no attempt, place kept, due at the next run */}
   else if(cls==='transport'){streak=streakBefore+1;next=Math.max(now+transportDelayMs(streak),Number.isFinite(until)?until:0);}// AIR-604: the later of the local backoff and the shared cooldown end
   else{attempts=before+1;streak=0;next=now+reviewDelayMs(attempts);checkId=cur?.reservation?.checkId||newCheckId();}
   set[item.lid]={reason:String(reason).slice(0,64),class:intent?'intent':cls,slug:item.slug||cur?.slug||null,attempts,streak,queuedAt:(cur&&queuePos(cur))||item.queuedAt||iso(now),lastAttemptAt:iso(now),nextAttemptAt:iso(next),route,...(checkId?{checkId}:{}),...(tmdb?{tmdb:String(tmdb)}:{}),...(cur?.requeued?{requeued:cur.requeued}:{})};
   counts.pending++;
  };
  // An id this step could not reach is kept for the next ordinary step (due now, attempts unchanged), never dropped. A new id gets its entry (and its place in the queue).
  // An entry this step reserved and then did not use is released at once (the same entry without its reservation), so a deferral never blocks the id for the reservation's lifetime.
  const release=item=>{const cur=stored.films[item.lid];if(mine.has(item.lid)&&cur&&!set[item.lid]){const {reservation:_released,...rest}=cur;set[item.lid]=rest;}};
  const defer=(item,prior)=>{release(item);counts.deferred++;if(!prior&&(item.slug||item.fromBacklog))set[item.lid]={reason:'deferred',class:'not_now',slug:item.slug||null,attempts:item.seed||0,streak:0,queuedAt:item.queuedAt||iso(now),lastAttemptAt:null,nextAttemptAt:iso(now)};};
  // An id without an entry takes a place in the document before anything is checked for it; when there is none left it waits in the backlog, recoverable and counted.
  const place=item=>{
   if(stored.films[item.lid]||set[item.lid])return true;
   if(slots>0){slots--;return true;}
   backlogAdd[item.lid]={slug:item.slug||null,queuedAt:item.queuedAt||iso(now),attempts:item.seed||0};counts.capRefused++;
   outcomes.set(item.lid,{checked:false,class:'not_now',reason:'diary_cap',retryAt:null,attempts:item.seed||0,streak:0,terminal:false});
   return false;
  };
  // Before the first non-atomic effect (receipt, admission, alias, record link, projection) a bounded link intent is made durable, so a kill or a lost final write
  // after a partial commit leaves an entry that a later ordinary step repairs (review of PR #720). If it cannot be written, nothing is written (fail closed). No attempt is charged here.
  const intend=async(item,tmdb)=>{
   const cur=stored.films[item.lid]||null;
   const value={reason:'linking',class:'intent',slug:item.slug||null,tmdb:String(tmdb),attempts:Math.max(cur?Number(cur.attempts)||0:0,item.seed||0),streak:Number(cur?.streak)||0,queuedAt:(cur&&queuePos(cur))||item.queuedAt||iso(now),lastAttemptAt:iso(now),nextAttemptAt:iso(now),route,...(cur?.reservation?{reservation:cur.reservation}:{})};
   try{
    const out=await LetterboxdFacts.updateDiaryIdentity(env,{set:{[item.lid]:value},expect:expectOf([item.lid])});
    if(out?.refused?.includes(item.lid)||out?.conflicts?.includes(item.lid))return false;
    stored.films[item.lid]=value;base.set(item.lid,JSON.stringify(value));return true;
   }catch{counts.persistFailed=1;return false;}
  };
  // AIR-559 (review of PR #966): the bridge-to-claim HANDOFF. While the claim module is active, a pair this step just verified and linked does not lose its durable
  // intent: in the same compare-and-swap that removes the link intent, it becomes a `claim_pending` entry for that exact pair (attempts 0, due now), and that
  // entry is removed only after the claim step proved the claim (written or already). A kill or a lost write anywhere between the bridge and the claim
  // therefore leaves either the link intent (repaired below into the same handoff) or the pending claim, never nothing. Inactive: the entry is cleared as before
  // and nothing about claims is stored.
  const claimLive=typeof CanonicalLetterboxdClaim!=='undefined'&&CanonicalLetterboxdClaim.LETTERBOXD_CLAIM_ACTIVATED===true;
  // `root` (AIR-618): the page-check digest of a check THIS step performed and verified for this pair, handed over with the link; the other callers of `handoff` made no check here and pass none (rootless).
  const handoff=(lid,tmdb,root=null)=>{
   claimPairs.push({lid,tmdb:String(tmdb),...(root?{root}:{})});
   const cur=stored.films[lid];
   if(claimLive)set[lid]={reason:CLAIM_REASON,class:'intent',slug:null,tmdb:String(tmdb),attempts:0,streak:0,queuedAt:(cur&&queuePos(cur))||iso(now),lastAttemptAt:iso(now),nextAttemptAt:iso(now)};
   else clear.push(lid);
  };
  // The reservation (see RESERVATION_MS): one compare-and-swap that, for an id taken from the backlog or new to the document, also creates its entry and removes its backlog record, bound to what this step read of BOTH.
  // -> 'ok' | 'conflict' (the entry or backlog record moved: an owner action, another caller's check or intake) | 'refused' (no place: the id stays in the backlog) | 'error'.
  const reserve=async(item,prior)=>{
   const lid=item.lid,eff=Math.max(Number(prior?.attempts)||0,item.seed||0),fromBacklog=Object.hasOwn(baseB,lid);
   const reservation={checkId:newCheckId(),until:iso(now+RESERVATION_MS),route};
   const entry=prior?{...prior,attempts:eff,slug:item.slug||prior.slug||null,reservation}:{reason:'checking',class:'not_now',slug:item.slug||null,attempts:eff,streak:0,queuedAt:item.queuedAt||iso(now),lastAttemptAt:null,nextAttemptAt:iso(now),route,reservation};
   try{
    const out=await LetterboxdFacts.updateDiaryIdentity(env,{set:{[lid]:entry},expect:expectOf([lid]),expectBacklog:{[lid]:baseB[lid]??null},backlogRemove:fromBacklog?[lid]:[],backlogOnRefuse:{[lid]:{slug:item.slug||null,queuedAt:item.queuedAt||iso(now),attempts:eff}},extra:item.guard?[item.guard]:[]});
    if(out?.conflicts?.includes(lid))return 'conflict';
    if(out?.refused?.includes(lid))return 'refused';
    stored.films[lid]=entry;base.set(lid,JSON.stringify(entry));delete baseB[lid];mine.set(lid,reservation.checkId);
    return 'ok';
   }catch(error){
    // Contention is a moved document or a moved ledger row token (the guard): somebody changed what this step read. Nothing was written.
    if(error&&error.code==='write_contention')return 'conflict';
    counts.persistFailed=1;return 'error';
   }
  };
  // The reservation for an id about to have an EFFECT (a source check, or a link made from a trusted bridge or a confirmed admission): false, with the outcome recorded, when it cannot be taken.
  const take=async(item,prior)=>{
   const taken=await reserve(item,prior);
   if(taken==='ok')return true;
   if(taken==='conflict'){counts.entryChanged=(counts.entryChanged||0)+1;outcomes.set(item.lid,{checked:false,class:'not_now',reason:'entry_changed',retryAt:null,attempts:null,streak:null,terminal:false});}
   else if(taken==='refused'){counts.capRefused++;outcomes.set(item.lid,{checked:false,class:'not_now',reason:'diary_cap',retryAt:null,attempts:item.seed||0,streak:0,terminal:false});}
   else counts.deferred++;
   return false;
  };
  for(const item of wanted){
   const lid=item.lid,own=links.get(lid)||{};
   const prior=stored.films[lid]||null,attempts=Number(prior?.attempts)||0;
   // The film slug of the same Diary row is kept on the shared entry: a caller that has none (a pruned first-seen snapshot) never turns it into `slug_missing`.
   if(!item.slug&&typeof prior?.slug==='string'&&SLUG.test(prior.slug))item.slug=prior.slug;
   // Another step holds this id's check reservation: it is neither checked nor written by this one (an expired reservation, left by a crashed step, is free).
   if(reservedActive(prior)&&!mine.has(lid)){counts.deferred++;outcomes.set(lid,{checked:false,class:'not_now',reason:'in_flight',retryAt:prior.reservation.until,attempts:attempts,streak:Number(prior.streak)||0,terminal:false});continue;}
   // Already linked: nothing to check. A pending entry on a linked id is a bridge that failed after the alias and the record link were committed (review of PR #720):
   // the committed projection is repaired (no outbound request, no admission, no new fact) and the entry is cleared only when that succeeded.
   if(own.tmdb){
    settled.set(lid,'linked');
    // ADR 0184, AIR-559: a link that this step did NOT verify itself is never offered: the link index alone does not say how the pair was made (an inferred title/year import before AIR-559 left some
    // pairs unmarked). Only a `claim_pending` entry is served here, and only one this step created from its own verified bridge, an existing trusted bridge or a confirmed `link_failed` repair, for the
    // same movie the link still names; it obeys its backoff and its attempt bound whether the id is on Diary page 1 or not.
    if(TMDB.test(String(own.tmdb))&&prior&&prior.reason===CLAIM_REASON&&claimDue(prior)&&String(prior.tmdb)===String(own.tmdb))claimPairs.push({lid,tmdb:String(own.tmdb)});
    if(!prior){clear.push(lid);continue;}
    if(prior.reason===CLAIM_REASON)continue; // served by the claim step below, not a link repair
    // A link intent of THIS step for the same movie (`linking` after a verified page or trusted bridge, `link_failed` after a confirmed admission) whose alias and
    // record committed before the step was cut off: the repaired pair is handed off to the claim like a fresh bridge. Any other prior reason, or another movie,
    // is cleared as before and never offered (the link was not proved by this step).
    const ownIntent=LINK_REASONS.has(prior.reason)&&TMDB.test(String(prior.tmdb||''))&&String(prior.tmdb)===String(own.tmdb);
    try{const repaired=await LetterboxdFacts.reprojectDiaryFilm(env,lid);if(repaired.state==='projected'){counts.repaired++;if(ownIntent)handoff(lid,own.tmdb);else clear.push(lid);}else{counts.skipped++;}}catch{counts.skipped++;}
    continue;
   }
   if(prior&&prior.reason===CLAIM_REASON){clear.push(lid);continue;} // the Ratings link is gone: nothing to claim
   if(prior&&prior.reason==='owner_dismissed'){settled.set(lid,'owner_dismissed');continue;} // settled by the owner: never checked again
   if(!own.factKey){counts.skipped++;outcomes.set(lid,{checked:false,class:'not_now',reason:'unavailable',retryAt:null,attempts:prior?attempts:null,streak:Number(prior?.streak)||0,terminal:false});continue;}
   // A bridge whose admission was confirmed but whose alias/record link did not commit (`link_failed` with its verified movie id) is completed locally:
   // no source request and no admission, whatever the source-attempt count. Only a confirmed admission ever writes this entry.
   if(prior&&prior.reason==='link_failed'&&TMDB.test(String(prior.tmdb||''))){
    if(late()){defer(item,prior);continue;}
    if(!(await take(item,prior)))continue;
    try{
     if(late()||!guarded(lid))throw Object.assign(new Error('late'),{code:'late'});
     const linked=await LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:String(prior.tmdb)});
     if(linked.state==='linked'){counts.repaired++;settled.set(lid,'linked');handoff(lid,prior.tmdb);}
     else record(item,'link_conflict');
    }catch{counts.skipped++;}
    continue;
   }
   // Not due (backoff, or at the attempt cap): left as it is; the outcome is the stored entry (copied by the Watchlist ledger, never charged again).
   // The cap applies to the EFFECTIVE count: the entry's, the caller's row budget and the backlog record's, whichever is larger. At the cap nothing is requested; the count is held on the entry so that every store agrees.
   const eff=Math.max(attempts,item.seed||0);
   if(!prior&&eff>=MAX_ATTEMPTS){
    if(place(item)){set[lid]={reason:String(item.reason||'at_cap').slice(0,64),class:'definite',slug:item.slug||null,attempts:eff,streak:0,queuedAt:item.queuedAt||iso(now),lastAttemptAt:iso(now),nextAttemptAt:iso(now),route};counts.deferred++;}
    continue;
   }
   if(prior&&(eff>=MAX_ATTEMPTS||Date.parse(prior.nextAttemptAt)>now)){
    if(eff>attempts&&!set[lid])set[lid]={...prior,attempts:eff};
    // An intent whose alias never committed is an ordinary source retry: at the cap it stops being served as a repair.
    if(eff>=MAX_ATTEMPTS&&LINK_REASONS.has(prior.reason))set[lid]={...prior,...(set[lid]||{}),reason:'link_interrupted',class:'definite'};
    if(item.onPage&&item.slug&&prior.slug!==item.slug)set[lid]={...prior,...(set[lid]||{}),slug:item.slug};
    counts.deferred++;continue;
   }
   if(!place(item))continue;
   counts.considered++;
   // Better same-row evidence keeps the retry alive: a newly seen usable slug is saved on the existing pending entry first (attempts and backoff unchanged), whatever follows.
   if(prior&&item.onPage&&item.slug&&prior.slug!==item.slug)set[lid]={...prior,slug:item.slug};
   if(!open){defer(item,prior);continue;}
   // 1. An existing trusted D1 bridge is consumed, never re-proved or re-registered.
   let bridge=null;
   try{bridge=await CanonicalCatalogReader.catalogFilmIdentityBridge(env,lid);}catch(error){if(['film_person_held','film_person_unavailable','film_person_generation_moved','canonical_read_unavailable','canonical_read_not_authoritative'].includes(error?.code)){defer(item,prior);continue;}bridge=null;}
   if(bridge?.state==='ok'&&bridge.tmdb){
    if(late()){defer(item,prior);continue;}
    if(!(await take(item,stored.films[lid]||null)))continue;
    if(!(await intend(item,bridge.tmdb))){release(item);counts.deferred++;continue;}
    try{
     if(late()||!guarded(lid))throw Object.assign(new Error('late'),{code:'late'});
     const linked=await LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:bridge.tmdb});
     if(linked.state==='linked'){counts.bridged++;settled.set(lid,'linked');handoff(lid,bridge.tmdb);const known=await CanonicalCatalogReader.catalogTitlesFromD1(env,[{id:'tmdb_'+bridge.tmdb,tmdbId:bridge.tmdb}],gate).catch(()=>({}));const title=known['tmdb_'+bridge.tmdb]?.title||null;labels.set(lid,{title,year:null,tmdb:bridge.tmdb});continue;}
     record(item,'link_conflict');continue;
    }catch{defer(item,prior);continue;}
   }
   if(bridge&&(bridge.state==='conflict'||bridge.state==='retired')){record(item,'bridge_'+bridge.state);continue;}
   // 2. A bounded source check, only for an id that is due and only while the lease leaves room.
   if(!item.slug){record(item,'slug_missing');continue;}
   if(stopped||fetched>=STEP_LIMIT||remaining()<STEP_BUDGET_MS){defer(item,prior);continue;}
   // Exclusive ownership of this check before any request (see RESERVATION_MS): at most one real check per reservation, whatever else runs.
   if(!(await take(item,stored.films[lid]||null)))continue;
   fetched++;counts.checked++;checked.add(lid);
   let outcome;
   try{outcome=await checkOne(env,item,{clock,fetchImpl,remaining});}catch(error){outcome={state:'pending',reason:'check_failed'};}
   if(outcome.stop)stopped=true;
   if(outcome.state==='verified'){
    let confirmed=false;
    try{
     if(remaining()<WRITE_RESERVE_MS)throw Object.assign(new Error('budget'),{code:'budget'});
     if(!(await intend(item,outcome.verdict.tmdb)))throw Object.assign(new Error('intent_unwritten'),{code:'intent_unwritten'});
     const admitted=await writeReceipt(guarded(lid)||(()=>{throw Object.assign(new Error('late'),{code:'late'});})(),item,outcome.verdict,clock,outcome.pageDigest);
     if(admitted==='conflict'||admitted==='other_code')throw Object.assign(new Error('admission_conflict'),{code:'admission_conflict'});
     const receiptKey='tmdb_'+outcome.verdict.tmdb,{value:receipts}=await LetterboxdFacts.readAdmissionReceipts(env);
     const receipt=receipts?.films?.[receiptKey];
     if(!receipt)throw new Error('receipt_missing');
     const admission=await CanonicalRatedAdmission.applyRatedAdmissionRetention(guarded(lid),{event:'diary:'+lid,admissions:[{receiptKey,receipt}]});
     confirmed=admissionConfirmed(admission);
     if(!confirmed)outcome={state:'pending',reason:admission?.state==='skipped'?'admission_skipped':'admission_not_confirmed'};
    }catch(error){outcome={state:'pending',reason:error?.code==='admission_identity_held'||error?.reason?'admission_held':ADMISSION_NOT_NOW[error?.code]||error?.code||(error?.message==='receipt_missing'?'receipt_missing':'admission_failed')};}
    if(confirmed){
     const linked=await LetterboxdFacts.bridgeDiaryFilm(guarded(lid),{lid,tmdb:outcome.verdict.tmdb}).catch(()=>({state:'error'}));
     if(linked.state==='linked'){counts.verified++;settled.set(lid,'verified');handoff(lid,outcome.verdict.tmdb,outcome.pageDigest);labels.set(lid,label(outcome.verdict));continue;}
     outcome={state:'pending',reason:linked.state==='conflict'?'link_conflict':'link_failed',...(linked.state==='conflict'?{}:{tmdb:outcome.verdict.tmdb})};
    }
   }
   record(item,outcome.reason,{tmdb:outcome.tmdb||null,until:Number.isFinite(outcome.until)?outcome.until:null});
  }
  let persisted=true,refused=[],conflicted=[];
  // A real check that reached the source and got an answer (gone, definite or settled; not a transport stop) is the Monitor's proof of progress.
  const answered=[...checked].some(lid=>settled.has(lid)||(set[lid]&&['gone','definite'].includes(classify(set[lid].reason))));
  // The backlog ids that now have an entry (this step's, or one that already existed) leave it in the same write, bound to the record this step read.
  for(const item of wanted)if(Object.hasOwn(baseB,item.lid)&&!backlogAdd[item.lid]&&(set[item.lid]||settled.has(item.lid)||stored.films[item.lid]))backlogRemove.push(item.lid);
  {
   const removeNow=[...new Set(backlogRemove)].filter(lid=>Object.hasOwn(baseB,lid));
   const hints=Object.fromEntries(wanted.map(item=>[item.lid,{slug:item.slug||null,queuedAt:item.queuedAt||iso(now),attempts:item.seed||0}]));
   const clearNow=clear.filter(lid=>stored.films[lid]);
   // AIR-599 (fourth review of PR #1009): EVERY materialization of a ledger row's seed carries that row's token guard in its batch: the entry (`set`), the backlog record of a refused id (`backlogAdd`, `hints`), and the
   // expected absence of an entry for an id that only the backlog receives. One batch for all ids; if it is refused (a moved document or a moved token), each id is written alone with its own guard, so one stale id never
   // rolls back another id's answered check (its charge) and only the stale id is `entry_changed`.
   const idsOf=[...new Set([...Object.keys(set),...clearNow,...removeNow,...Object.keys(backlogAdd)])];
   const pick=(map,lids)=>Object.fromEntries(lids.filter(lid=>Object.hasOwn(map,lid)).map(lid=>[lid,map[lid]]));
   const writeFor=lids=>{
    const inSet=pick(set,lids),inAdd=pick(backlogAdd,lids),inRemove=removeNow.filter(lid=>lids.includes(lid)),inClear=clearNow.filter(lid=>lids.includes(lid));
    return LetterboxdFacts.updateDiaryIdentity(env,{set:inSet,clear:inClear,backlogAdd:inAdd,backlogRemove:inRemove,backlogOnRefuse:pick(hints,lids),expect:expectOf([...Object.keys(inSet),...inClear,...inRemove,...Object.keys(inAdd)]),expectBacklog:Object.fromEntries([...Object.keys(inAdd),...inRemove].map(lid=>[lid,baseB[lid]??null])),extra:guardsOf(lids),...(answered?{checkedAt:iso(now)}:{})});
   };
   const absorb=out=>{
    for(const lid of Array.isArray(out?.refused)?out.refused:[])refused.push(lid);
    for(const lid of Array.isArray(out?.conflicts)?out.conflicts:[])conflicted.push(lid);
    counts.backlogFull+=Array.isArray(out?.full)?out.full.length:0;
   };
   try{
    absorb(await writeFor(idsOf));
   }catch(error){
    if(error&&error.code==='write_contention'&&idsOf.length>1){
     // Isolate: each id on its own (the first batch wrote nothing).
     for(const lid of idsOf){
      try{absorb(await writeFor([lid]));}
      catch(inner){if(inner&&inner.code==='write_contention')conflicted.push(lid);else{persisted=false;counts.persistFailed=1;break;}}
     }
    }else{
     // Contention: a moved document or a moved ledger row token. Nothing was written; the ids stay as they were (not now, no attempt).
     persisted=false;
     if(error&&error.code==='write_contention'){counts.entryChanged=(counts.entryChanged||0)+Math.max(1,Object.keys(set).length);}else counts.persistFailed=1;
    }
   }
   if(conflicted.length)counts.entryChanged=(counts.entryChanged||0)+conflicted.length;
  }
  for(const lid of refused)counts.capRefused++;
  // The explicit outcome of every id this step was asked about (and of the ids it serviced on its own).
  for(const item of wanted){
   const lid=item.lid;
   if(settled.has(lid)){outcomes.set(lid,{checked:checked.has(lid),class:'settled',reason:settled.get(lid),retryAt:null,attempts:Number(stored.films[lid]?.attempts)||0,streak:0,terminal:false});continue;}
   if(refused.includes(lid)){outcomes.set(lid,{checked:false,class:'not_now',reason:'diary_cap',retryAt:null,attempts:item.seed||0,streak:0,terminal:false});continue;}
   if(conflicted.includes(lid)){outcomes.set(lid,{checked:checked.has(lid),class:'not_now',reason:'entry_changed',retryAt:null,attempts:null,streak:null,terminal:false});continue;}
   if(outcomes.has(lid))continue;
   const prior=stored.films[lid]||null,entry=persisted&&set[lid]?set[lid]:prior;
   if(!persisted&&set[lid]){outcomes.set(lid,{checked:checked.has(lid),class:'not_now',reason:'persist_failed',retryAt:prior?.nextAttemptAt??null,attempts:prior?Number(prior.attempts)||0:null,streak:Number(prior?.streak)||0,terminal:false});continue;}
   if(!entry){outcomes.set(lid,{checked:false,class:'not_now',reason:'deferred',retryAt:null,attempts:null,streak:0,terminal:false});continue;}
   const n=Number(entry.attempts)||0,cls=LINK_REASONS.has(entry.reason)||entry.reason===CLAIM_REASON?'intent':classify(entry.reason);
   if(n>=MAX_ATTEMPTS&&cls!=='settled'&&checked.has(lid))counts.atCap++;
   if(checked.has(lid)){const key=cls==='not_now'||cls==='intent'?'notNow':cls;counts[key]=(counts[key]||0)+1;}
   outcomes.set(lid,{checked:checked.has(lid),class:cls,reason:entry.reason,retryAt:entry.nextAttemptAt??null,attempts:n,streak:Number(entry.streak)||0,terminal:n>=MAX_ATTEMPTS&&cls!=='settled',...(entry.checkId&&checked.has(lid)?{checkId:entry.checkId}:{})});
  }
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
     // a proved claim removes the pending entry, also the one the handoff created in this same step (not in the snapshot read at its start); a missing entry is a no-op
     if(proved.has(pair.lid)){claimClear.push(pair.lid);continue;}
     // an id the call did not try keeps its attempts and is due again at once; a tried and unproved one backs off like a review
     const attemptsNow=(Number(prior?.attempts)||0)+(tried.has(pair.lid)?1:0);
     claimSet[pair.lid]={reason:CLAIM_REASON,class:'intent',slug:null,tmdb:pair.tmdb,attempts:attemptsNow,streak:0,queuedAt:prior?.queuedAt||set[pair.lid]?.queuedAt||iso(now),lastAttemptAt:iso(now),nextAttemptAt:iso(tried.has(pair.lid)?now+reviewDelayMs(Math.max(attemptsNow,1)):now)};
    }
    counts.claim=claimed&&claimed.state==='complete'?'complete':claimed?'incomplete':'skipped';
    // The entries as this step left them (its own final write), so a claim write never replaces a change another writer made since.
    const afterStep=lid=>clear.includes(lid)?null:set[lid]?JSON.stringify(set[lid]):base.get(lid)??null;
    if(Object.keys(claimSet).length||claimClear.length){try{await LetterboxdFacts.updateDiaryIdentity(env,{set:claimSet,clear:claimClear,expect:Object.fromEntries([...Object.keys(claimSet),...claimClear].map(lid=>[lid,afterStep(lid)]))});}catch{counts.persistFailed=1;}}
   }
  }
  return {labels,counts,outcomes};
 }

 return {STEP_LIMIT,MAX_ATTEMPTS,STEP_BUDGET_MS,WRITE_RESERVE_MS,admissionConfirmed,verifyPage,verify,resolve,delayMs,classify,visibleClass,reviewDelayMs,transportDelayMs,pageReason,TRANSPORT_REASONS,NOT_NOW_REASONS};
})();
