// EPG title resolution is independent of the usage-limited prediction runner.
const DISCOVERY_LEASE_KEY='epg/resolver-lease.json';
const DISCOVERY_CONTINUATION_URL='https://iptv.internal/discovery/continue';
function filmIsHot(film,now=Date.now()){
 const from=now-72*3600000,to=now+24*3600000;
 if(Array.isArray(film.shows))return film.shows.some(show=>Number(show.start)>=from&&Number(show.start)<to);
 // A cache written before shows were stored can still use its last observed airing.
 return Number.isFinite(film.epgLastAiring)&&film.epgLastAiring>=from&&film.epgLastAiring<to;
}
function candidateIsHot(candidate,now=Date.now()){return Array.isArray(candidate.shows)?filmIsHot({shows:candidate.shows},now):filmIsHot({epgLastAiring:candidate.lastAiring},now);}
const DISCOVERY_ATTEMPT_LIMIT=5;
// The paged (D1) chunk. The wall budget sits inside the shortest known MCP client timeout (about 60 s) and covers the
// final status write and continuation checkpoint, which keep PAGED_COMMIT_RESERVE_MS of it; candidates, TMDB requests
// and the ledger walk all stop before that reserve. The renew margin is half of the 90 s lease TTL, so a lease is
// renewed while it still has at least that long to live. A single D1 query or TMDB request cannot be pre-empted:
// the budget is checked between awaited steps, and a request's own timeout is cut to the time left.
const PAGED_CHUNK_BUDGET_MS=40000;
const PAGED_COMMIT_RESERVE_MS=8000;
const PAGED_MIN_REQUEST_MS=2000;
const PAGED_BUDGET_BACKOFF_MS=300000;
const PAGED_TMDB_CALLS=16;
const PAGED_WALK_CONCURRENCY=4;
// The cheap pass writes at most this many decisions and Film touches per chunk; the rest waits for the next one.
const PAGED_CHEAP_GROUP=4;
// The last stretch before the budget ends belongs to the final lease renewal, the status write and the checkpoint.
const PAGED_CHECKPOINT_RESERVE_MS=5000;
// Write batches after the last stored candidate: the preview (renewal and write), the final renewal, the status and the checkpoint.
const PAGED_FINAL_WRITES=6;
// What a D1 write batch is assumed to cost until the chunk has measured one.
const PAGED_DEFAULT_WRITE_MS=500;
const PAGED_CHEAP_DECISIONS=40;
const PAGED_CHEAP_FILMS=38;
const DISCOVERY_LEASE_RENEW_MARGIN_MS=45000;
const budgetExhaustedError=()=>Object.assign(new Error('chunk wall budget exhausted'),{name:'BudgetExhaustedError'});
function candidateEvidence(candidate){const shows=[...(candidate.shows||[])].map(show=>`${show.channelId||''}:${show.start}`).sort(),durations=[...(candidate.durations||[])].filter(Number.isFinite).sort((a,b)=>a-b);return [candidate.normalizedTitle||'',candidate.year||'',durations.join(','),shows.join(',')].join('|');}
function candidateActivity(candidate,now=Date.now()){
 const from=now-72*3600000,to=now+24*3600000,shows=Array.isArray(candidate.shows)?candidate.shows:null,inWindow=!!shows?.some(show=>Number(show.start)>=from&&Number(show.start)<to);
 if(candidate.seenInLatestSnapshot===true)return inWindow?'current':'historical';
 if(candidate.seenInLatestSnapshot==null&&inWindow)return 'current';
 const last=Number(candidate.lastSeenAt??candidate.lastAiring);
 return Number.isFinite(last)&&last<from?'expired':'historical';
}
function resolutionActionability(candidate,decision,now=Date.now()){
 if(candidateActivity(candidate,now)!=='current'||screenedNonfilmReason(candidate,decision))return false;
 // A stored exclusion that the current screening rules no longer reproduce is re-checked in the normal cycle.
 if(decision?.status==='excluded_nonfilm')return true;
 if(!decision||decision.status!=='verified'){
  if(!decision)return true;
  const same=!decision.evidenceKey||decision.evidenceKey===candidateEvidence(candidate);
  if(decision.terminalReason&&same)return false;
  if(decision.retryAt&&Date.parse(decision.retryAt)>now&&same)return false;
  return true;
 }
 return false;
}
function discoveryReady(candidate,decision,now){return resolutionActionability(candidate,decision,now);}
// An owner rejection or assignment stays on the decision when a later chunk rewrites the uncertain fields. Scoring is
// not carried: the next attempt scores again. A rejected accepted id is searched again so a different id can be
// evaluated, and that rejected id is not fetched as movie detail. The rejection does not apply to any other observation.
function ownerMarkerCarry(previous){
 if(!previous||typeof previous!=='object')return {};
 const carried={};
 if(previous.ownerIdentity&&typeof previous.ownerIdentity==='object')carried.ownerIdentity=previous.ownerIdentity;
 if(Array.isArray(previous.rejectedTmdbIds)&&previous.rejectedTmdbIds.length)carried.rejectedTmdbIds=previous.rejectedTmdbIds.slice(0,8);
 return carried;
}
function ownerRejected(decision,tmdbId){
 if(tmdbId==null||tmdbId==='')return false;
 const id=String(tmdbId);
 return Array.isArray(decision?.rejectedTmdbIds)&&decision.rejectedTmdbIds.map(String).includes(id);
}
function recordUncertain(decisions,candidate,status,now=Date.now()){
 const evidenceKey=candidateEvidence(candidate),previous=decisions[candidate.key],same=previous?.evidenceKey===evidenceKey,attempts=same?(previous.attempts||0)+1:1,terminal=attempts>=DISCOVERY_ATTEMPT_LIMIT;
 const carried=ownerMarkerCarry(previous);
 decisions[candidate.key]={status,attempts,evidenceKey,lastAttemptAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),retryAt:terminal?null:new Date(now+Math.min(7,2**(attempts-1))*86400000).toISOString(),terminalReason:terminal?'repeated_uncertain_match':null,...carried,...(Object.keys(carried).length&&previous.scoring&&typeof previous.scoring==='object'?{scoring:previous.scoring}:{})};
}
function emptyDiscoveryCounts(){return {ledgerTotal:0,currentUnresolved:0,readyNow:0,retryBackoff:0,historicalUnresolved:0,ambiguous:0,terminalNoMatch:0,rejectedNonfilm:0,expiredInactive:0};}
function countDiscoveryItem(counts,candidate,decision,now){
 counts.ledgerTotal++;
 const activity=candidateActivity(candidate,now);
 if(screenedNonfilmReason(candidate,decision)){counts.rejectedNonfilm++;return;}
 if(decision?.status==='verified')return;
 if(activity==='expired'){counts.expiredInactive++;return;}
 if(activity!=='current'){counts.historicalUnresolved++;return;}
 if(decision?.terminalReason&&(!decision.evidenceKey||decision.evidenceKey===candidateEvidence(candidate))){counts.terminalNoMatch++;return;}
 counts.currentUnresolved++;
 if(decision?.status==='ambiguous')counts.ambiguous++;
 else if(decision?.retryAt&&Date.parse(decision.retryAt)>now)counts.retryBackoff++;
 else counts.readyNow++;
}
function discoveryCounts(items,decisions,now=Date.now()){
 const counts=emptyDiscoveryCounts();
 for(const candidate of items)countDiscoveryItem(counts,candidate,decisions?.[candidate.key],now);
 return counts;
}
// AIR-220 / ADR 0034: counts of a bounded ledger. Per-activity counters cover the active ledger; `ledgerTotal` adds the archived
// keys that are not in it (`uniqueArchivedItems`, computed by the writer), so a leftover archive copy is never counted twice.
// The `archive` block comes from the active ledger's own field: status never reads archive segments.
function ledgerCounts(source,decisions,now=Date.now()){return ledgerCountsFrom(source,discoveryCounts(source?.items||[],decisions,now));}
function ledgerCountsFrom(source,counts){
 const archive=source?.archive;
 if(!source?.ledgerMode)return counts;
 if(archive?.source==='d1')return d1LedgerCounts(source,counts);
 const unique=Number.isInteger(archive?.uniqueArchivedItems)?archive.uniqueArchivedItems:0;
 return {...counts,ledgerTotal:counts.ledgerTotal+unique,archive:{ledgerMode:source.ledgerMode,activeItems:counts.ledgerTotal,uniqueArchivedItems:unique,manifestId:archive?.manifestId??null,segments:archive?.segments??0,items:archive?.items??0,bytes:archive?.bytes??0}};
}
// AIR-427. Under D1 authority the active ledger is D1 rows, and neither the mode of the published generation nor the size of the R2
// archive is in D1. They are reported only as far as they are proven from that generation's own document (`ledger`, see
// provenGenerationLedger): `ledgerMode` is its recorded mode or `unknown`; the archive figures are its recorded figures or null. A null
// is "not known", never zero. `d1` is what D1 itself holds and is named as such. `ledgerTotal` stays the active count plus the archive
// keys that are proven; `ledgerTotalScope` says which of the two it is.
function d1LedgerCounts(source,counts){
 const proven=source.ledger||{ledgerMode:'unknown',reason:'not_read'},known=proven.ledgerMode!=='unknown',recorded=known?proven.archive:null;
 const unique=recorded&&Number.isInteger(recorded.uniqueArchivedItems)?recorded.uniqueArchivedItems:known&&!recorded?0:null;
 const block={ledgerMode:proven.ledgerMode,...(known&&proven.drain?{drain:proven.drain}:{}),ledgerModeSource:known?'generation_document':'unavailable',...(known?{}:{ledgerModeReason:proven.reason||'unknown'}),activeItems:counts.ledgerTotal,activeSource:'d1',uniqueArchivedItems:unique,manifestId:recorded?.manifestId??null,segments:recorded?recorded.segments:known?0:null,items:recorded?recorded.items:known?0:null,bytes:recorded?recorded.bytes:known?0:null,archiveSource:!known?'unavailable':recorded?'r2_generation_document':'none',d1:source.archive.d1};
 return {...counts,ledgerTotal:counts.ledgerTotal+(unique??0),ledgerTotalScope:unique===null?'active_only':'active_and_archive',archive:block};
}
// The ledger mode and archive header of one published generation, proven from its own R2 document. The document is
// `{meta,"items":[...],"ledgerMode":"…","archive":{…}}` (a `full` ledger ends at `]}`), and the completed seal of that generation
// recorded the byte offset just past the last item, so the header is one short range read there; `uniqueArchivedItems` closes the
// document and is one short read of its end. Reads only, bounded, never a scan. Anything that does not line up exactly (no seal
// record, another generation, an unfinished seal, a changed or missing document, unexpected bytes, a read error) is `unknown` with a
// reason: the feature flag is never used as evidence, because it says what the next commit will do, not what this generation is.
const LEDGER_HEADER_BYTES=512,LEDGER_TAIL_BYTES=96;
const LEDGER_HEADER_PATTERN=/^\],"ledgerMode":"(bounded|frozen)"(?:,"drain":\{"backlog":(\d{1,9}),"cap":(\d{1,9})\})?,"archive":(null\}$|\{"version":"v1","manifestId":"([A-Za-z0-9_-]{1,100})","segments":(\d{1,9}),"items":(\d{1,12}),"bytes":(\d{1,15}),"alsoArchived":\[)/;
async function provenGenerationLedger(env,programmeRunId){
 const unknown=reason=>({ledgerMode:'unknown',reason});
 try{
  if(typeof programmeRunId!=='string'||!programmeRunId)return unknown('no_published_generation');
  if(typeof DiscoveryAuthority==='undefined'||typeof DiscoveryAuthority.sealSource!=='function')return unknown('seal_record_unavailable');
  const seal=await DiscoveryAuthority.sealSource(env);
  if(!seal||!seal.sourceKey)return unknown('seal_record_unavailable');
  if(seal.programmeRunId!==programmeRunId||seal.sourceKey!=='epg/generations/'+programmeRunId+'/discovery-latest.json')return unknown('seal_of_another_generation');
  if(seal.phase!=='done'||seal.cursorItems!==seal.itemTotal||!Number.isSafeInteger(seal.cursorBytes)||seal.cursorBytes<1)return unknown('seal_not_complete');
  const head=await env.BUCKET.get(seal.sourceKey,{range:{offset:seal.cursorBytes-1,length:LEDGER_HEADER_BYTES}});
  if(!head)return unknown('generation_document_missing');
  if(!seal.sourceEtag||head.etag!==seal.sourceEtag)return unknown('generation_document_changed');
  const text=(await head.text()).slice(0,LEDGER_HEADER_BYTES);
  if(text===']}')return {ledgerMode:'full',archive:null};
  const match=LEDGER_HEADER_PATTERN.exec(text);
  if(!match)return unknown('generation_document_unreadable');
  // AIR-429: a bounded generation that still holds backlog says so (`drain`); it is bounded, and its active ledger is the scan plus that backlog.
  const drain=match[2]===undefined?null:{backlog:Number(match[2]),cap:Number(match[3])};
  if(drain&&(match[1]!=='bounded'||drain.backlog<1))return unknown('generation_document_unreadable');
  if(match[4].startsWith('null'))return {ledgerMode:match[1],...(drain?{drain}:{}),archive:null};
  const size=Number(head.size);
  if(!Number.isSafeInteger(size)||size<=seal.cursorBytes)return unknown('generation_document_unreadable');
  const tailAt=Math.max(seal.cursorBytes,size-LEDGER_TAIL_BYTES);
  const tail=await env.BUCKET.get(seal.sourceKey,{range:{offset:tailAt,length:size-tailAt}});
  if(!tail||tail.etag!==seal.sourceEtag)return unknown('generation_document_changed');
  const closing=/"uniqueArchivedItems":(\d{1,12})\}\}$/.exec((await tail.text()).slice(-LEDGER_TAIL_BYTES));
  if(!closing)return unknown('generation_document_unreadable');
  const items=Number(match[7]),unique=Number(closing[1]);
  if(unique>items)return unknown('generation_document_unreadable');
  return {ledgerMode:match[1],...(drain?{drain}:{}),archive:{manifestId:match[5],segments:Number(match[6]),items,bytes:Number(match[8]),uniqueArchivedItems:unique}};
 }catch{return unknown('read_failed');}
}
// AIR-344: the status readers' view of the pinned ledger, read once. An R2 ledger is streamed item by item and no item is
// kept: each one is counted as it is read (the same rules as ledgerCounts) and the per-status tallies are taken from the
// decisions, so the document is never held whole. A D1 ledger above READ_CAP is walked in LEDGER_PAGE rows with that
// page's decisions only; it is not counted as an empty `items` array and READ_CAP is not raised. A held, loading or
// unavailable marker fails closed and does not fall back to a stale R2 ledger once D1 is the authority.
// `confirmed` is every verified tmdbId (String of it, as the pipeline status counts), `recognized` only the truthy ones
// (as the footer counts). The returned `source` is the ledger's wrapper (programmeRunId, archive, ...) without items.
async function ledgerStatusAggregates(pinned,decisions,now=Date.now()){
 const counts=emptyDiscoveryCounts(),statuses={},confirmed=new Set(),recognized=new Set(),map=decisions||{};
 const add=(candidate,decision)=>{
  countDiscoveryItem(counts,candidate,decision,now);
  if(decision){statuses[decision.status]=(statuses[decision.status]||0)+1;if(decision.status==='verified'){confirmed.add(String(decision.tmdbId));if(decision.tmdbId)recognized.add(String(decision.tmdbId));}}
 };
 if(typeof DiscoveryAuthority!=='undefined'&&typeof DiscoveryAuthority.streamActiveLedger==='function'){
  const walked=await DiscoveryAuthority.streamActiveLedger(pinned,(item,decision)=>add(item,decision));
  if(walked.handled){
   const source={programmeRunId:walked.programmeRunId,itemCount:walked.itemCount,ledgerMode:walked.ledgerMode,archive:walked.archive};
   if(source.ledgerMode&&source.archive?.source==='d1')source.ledger=await provenGenerationLedger(pinned,source.programmeRunId);
   return {source,counts:ledgerCountsFrom(source,counts),statuses,confirmed,recognized};
  }
 }
 let streamed=false,loaded;
 try{loaded=await loadJSON(pinned,'epg/discovery-latest.json',{item:item=>{streamed=true;add(item,map[item?.key]);return null;}});}
 catch(e){
  // A stored document without an `items` array is refused by the streamed reader; a whole parse reads it as before.
  if(e?.message!=='Discovery ledger JSON is incomplete')throw e;
  streamed=false;loaded=await loadJSON(pinned,'epg/discovery-latest.json');
 }
 if(!streamed){
  if(loaded?.paged){const error=new Error('discovery_bounded');error.code='discovery_bounded';throw error;}
  for(const item of loaded?.items||[])add(item,map[item.key]);
 }
 const source=loaded?{...loaded,items:undefined}:null;
 if(source?.ledgerMode&&source.archive?.source==='d1')source.ledger=await provenGenerationLedger(pinned,source.programmeRunId);
 return {source,counts:ledgerCountsFrom(source,counts),statuses,confirmed,recognized};
}
// The public status still reports the retired variant-search counters. They stay zero: the Worker does not plan those searches.
const VARIANT_DIAGNOSTIC={variantCalls:0,variantErrors:0,variantThrottled:0,variantSkipped:0};
const DISCOVERY_SCORE_PREVIEW_KEY='epg/discovery-score-preview.json';
function filmScorerCandidate(film){return {tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null,runtime:film.runtime??null,trusted:film.canonicalIdentity==='tmdb:'+film.tmdbId};}
function knownScorerCandidates(aliasIndex,candidate){return [...(aliasIndex.get(candidate.normalizedTitle)?.values()||[])].filter(film=>film?.tmdbId).map(filmScorerCandidate);}
function verifiedConfirmation(decision,tmdbId){const id=String(tmdbId);return decision?.status==='verified'&&String(decision.tmdbId)===id?{authority:'verified_decision',tmdbId:id,evidence:{decision:{status:'verified',tmdbId:id,observationKey:decision.observationKey??null}}}:null;}
function discoveryGateFacts(candidate,decision,now){const evidenceKey=candidateEvidence(candidate),same=!decision?.evidenceKey||decision.evidenceKey===evidenceKey;return {eligible:resolutionActionability(candidate,decision,now),activity:candidateActivity(candidate,now),evidenceChanged:!!decision&&!same,terminal:!!(decision?.terminalReason&&same)};}
function detailCompetitors(aliasIndex,candidate,tmdbId,forms=[]){
 const keys=[],seen=new Set();
 const add=value=>{const key=norm(value||'');if(!key||seen.has(key))return;seen.add(key);keys.push(key);};
 add(candidate?.normalizedTitle);for(const form of forms)add(form);
 const films=new Map();
 for(const key of keys)for(const film of aliasIndex.get(key)?.values()||[]){
  if(!film?.tmdbId||String(film.tmdbId)===String(tmdbId)||films.has(String(film.tmdbId)))continue;
  films.set(String(film.tmdbId),{tmdbId:String(film.tmdbId),title:film.title||'',original:film.original||'',aliases:film.aliases||[],year:film.year??null});
 }
 return [...films.values()];
}
function structuralCompetitorForms(score){const form=score?.titleBasis?.structural?.form;return form?[form]:[];}
function tmdbDetailFromMovie(movie){
 const aliases=[...(movie?.alternative_titles?.titles||[]).map(item=>item?.title),...(movie?.translations?.translations||[]).map(item=>item?.data?.title)].filter(Boolean);
 return {authority:'tmdb_detail',tmdbId:movie?.id==null?null:String(movie.id),evidence:{movie:{id:movie?.id??null,title:movie?.title||'',original:movie?.original_title||'',aliases,year:Number(String(movie?.release_date||'').slice(0,4))||null,runtime:movie?.runtime??null}}};
}
function gateScoredCandidate(env,source,candidate,score,decisions,films,now,extra={}){
 const tmdbId=score.acceptedTmdbId==null?null:String(score.acceptedTmdbId),film=tmdbId?films['tmdb_'+tmdbId]||null:null,decision=decisions[candidate.key];
 const durations=[...(candidate.durations||[]),candidate.duration].filter(value=>Number.isFinite(value));
 return acceptScoredIdentity({score,observationKey:candidate.key,pinnedProgrammeRunId:env.epgPin?.programmeRunId||source.programmeRunId||null,observationProgrammeRunId:source.programmeRunId||null,discovery:discoveryGateFacts(candidate,decision,now),film,observation:{normalizedTitle:candidate.normalizedTitle||'',year:candidate.year??null,durations},competitors:extra.competitors||[],tmdbDetail:extra.tmdbDetail||null,confirmation:tmdbId?verifiedConfirmation(decision,tmdbId):null,appliedObservationKeys:decision?.status==='verified'&&String(decision.tmdbId)===tmdbId?[candidate.key]:[]});
}
function recordNeedsVerification(decisions,candidate,score,now=Date.now()){
 const evidenceKey=candidateEvidence(candidate),previous=decisions[candidate.key],same=previous?.status==='needs_verification'&&previous.evidenceKey===evidenceKey,attempts=same?(previous.attempts||0)+1:1,terminal=attempts>=DISCOVERY_ATTEMPT_LIMIT;
 decisions[candidate.key]={status:'needs_verification',attempts,evidenceKey,lastAttemptAt:new Date(now).toISOString(),checkedAt:new Date(now).toISOString(),retryAt:terminal?null:new Date(now+Math.min(7,2**(attempts-1))*86400000).toISOString(),terminalReason:terminal?'awaiting_confirmation':null,scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null},...ownerMarkerCarry(previous)};
}
function scorePreview(candidate,score,gate,proposed){const row={observationKey:candidate.key,outcome:gate.outcome,reason:gate.reason,scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,confidence:score.confidence,score:score.score,acceptedTmdbId:score.acceptedTmdbId}};if(proposed?.length)row.proposedCandidates=proposed;if(gate.competingEditions?.length)row.competingEditions=gate.competingEditions;return row;}
function searchHitCandidate(movie){return {tmdbId:String(movie.id),title:movie.title,original:movie.original_title,year:Number(movie.release_date?.slice(0,4))||null,runtime:movie.runtime??null,trusted:false};}
async function scoredSearchCandidates(query,candidate){
 const found=[];
 for(const language of /[іїєґ]/i.test(candidate.title)?['uk-UA','ru-RU']:['ru-RU','uk-UA']){
  const search=await query('search/movie?'+new URLSearchParams({query:candidate.title,language,include_adult:'false',...(candidate.year?{year:String(candidate.year)}:{})}));
  const exact=(search.results||[]).filter(movie=>[movie.title,movie.original_title].some(title=>norm(title)===candidate.normalizedTitle)&&(!candidate.year||Math.abs(Number(movie.release_date?.slice(0,4))-candidate.year)<=1));
  for(const movie of exact)found.push(searchHitCandidate(movie));
  if(exact.length)break;
 }
 return found;
}
// The preview is the last chunk's scored outcomes for the pinned generation; a preview of another generation is stale.
// `mode` and `cutover` are fixed to `on`: the scored gate is the only resolver, kept in the shape readers already parse.
function scorePreviewSummary(preview,currentProgrammeRunId){
 const previewRun=preview?.programmeRunId??null,current=currentProgrammeRunId??null,stale=!!preview&&previewRun!==current;
 const items=!stale&&preview?.items&&typeof preview.items==='object'?Object.values(preview.items):[];
 const outcomes={needs_verification:0,candidate_decision:0,trusted_acceptance:0,already_applied:0,detail_verified:0,refused:0,other:0},reasons={};
 for(const item of items){const outcome=item?.outcome;if(Object.prototype.hasOwnProperty.call(outcomes,outcome))outcomes[outcome]++;else outcomes.other++;if(item?.reason)reasons[item.reason]=(reasons[item.reason]||0)+1;}
 return {mode:'on',programmeRunId:previewRun,currentProgrammeRunId:current,stale,rows:items.length,outcomes,reasons,needsConfirmation:outcomes.needs_verification,cutover:'on'};
}
async function saveScorePreview(env,source,preview,fence=null){if(fence)await fence();await saveJSON(env,DISCOVERY_SCORE_PREVIEW_KEY,{schemaVersion:1,mode:'on',programmeRunId:source.programmeRunId||null,items:preview});}
// ADR 0103. `takeDiscoveryLease` answers the lease and, when none was taken, why: a requested or held projector window is the typed
// busy `{kind:'projector_window',expiresAt}`, which the EPG publication paths turn into a structured wait. `acquireDiscoveryLease`
// keeps its old shape (the lease or null) for every caller that treats a missing lease as busy.
async function takeDiscoveryLease(env){
 if(typeof DiscoveryAuthority!=='undefined'){
  const gate=await DiscoveryAuthority.readAuthority(env);
  if(gate.held)throw Object.assign(new Error('discovery_fence'),{code:'discovery_fence',name:'DiscoveryFenceError'});
  if(gate.ready){
   const published=await publishedPointer(env);
   const taken=await DiscoveryAuthority.acquireLease(env,{programmeRunId:published?.programmeRunId??null});
   if(taken.lease)env.discoveryLease=taken.lease;
   return {lease:taken.lease,busy:taken.busy||null};
  }
 }
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY),old=object?await object.json():null;
 if(old?.expiresAt>Date.now())return {lease:null,busy:null};
 const lease={id:crypto.randomUUID(),expiresAt:Date.now()+90000},saved=await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify(lease),{onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
 return {lease:saved===null?null:lease,busy:null};
}
async function acquireDiscoveryLease(env){return (await takeDiscoveryLease(env)).lease;}
// AIR-154: a chunk renews its lease immediately before every durable write. Renewal fails as soon as
// another hop holds the lease, so a hop that stalled past the lease TTL cannot write over its successor;
// expiry therefore means the hop has been silent for a whole TTL, which is the quiescence a resume needs.
// The fence is passed into every helper that writes, so each independent write (both catalog copies, the programme
// showing, the prediction-queue checkpoint, the score preview) renews first; the residual window is one storage write
// of the old hop that is already in flight and itself lasts longer than the TTL.
async function renewDiscoveryLease(env,lease){
 if(typeof DiscoveryAuthority!=='undefined'){
  const gate=await DiscoveryAuthority.readAuthority(env);
  if(gate.held)throw Object.assign(new Error('discovery_fence'),{code:'discovery_fence',name:'DiscoveryFenceError'});
  if(gate.ready){
   const published=await publishedPointer(env);
   const renewed=await DiscoveryAuthority.renewLease(env,lease,{programmeRunId:published?.programmeRunId??null});
   return renewed.ok===true;
  }
 }
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY);if(!object)return false;
 const current=await object.json();if(current?.id!==lease.id)return false;
 const next={...current,expiresAt:Date.now()+90000},saved=await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify(next),{onlyIf:{etagMatches:object.etag}});
 if(saved===null)return false;lease.expiresAt=next.expiresAt;return true;
}
const leaseLostError=()=>Object.assign(new Error('resolver lease lost'),{name:'LeaseLostError'});
async function releaseDiscoveryLease(env,lease){
 if(typeof DiscoveryAuthority!=='undefined'){
  const released=await DiscoveryAuthority.releaseLease(env,lease);
  if(released.handled)return;
 }
 const object=await env.BUCKET.get(DISCOVERY_LEASE_KEY);if(!object)return;const current=await object.json();if(current.id===lease.id)await env.BUCKET.put(DISCOVERY_LEASE_KEY,JSON.stringify({...lease,expiresAt:0}),{onlyIf:{etagMatches:object.etag}});}
async function tmdbRequest(env,path,options={}){
 if(env.TMDB_REQUEST_INTERVAL_MS!==0)await new Promise(resolve=>setTimeout(resolve,200));
 const response=await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+env.TMDB_API_READ_ACCESS_TOKEN,Accept:'application/json'},signal:AbortSignal.timeout(options.timeoutMs>0?Math.min(12000,options.timeoutMs):12000)});
 if(!response.ok){const error=new Error('TMDB HTTP '+response.status);if(response.status===429){error.retryAt=new Date(Date.now()+Math.max(30,Math.min(3600,Number(response.headers.get('Retry-After'))||60))*1000).toISOString();}throw error;}return response.json();
}
function catalogFilmFromDetail(movie,candidate,old,programmeRunId,id){
 const people=(entries,prefix)=>(entries||[]).slice(0,10).map(person=>({id:prefix+'/'+person.id,name:person.name,original:person.name}));
 const localized=(movie.translations?.translations||[]).filter(item=>['ru','uk','en'].includes(item.iso_639_1)).map(item=>item.data?.title);
 const alternates=(movie.alternative_titles?.titles||[]).filter(item=>['RU','UA','US','GB'].includes(item.iso_3166_1)).map(item=>item.title);
 return touchCanonicalFilm({...(old||{}),discoveredAt:old?.discoveredAt||new Date().toISOString(),id,tmdbId:String(movie.id),url:'https://www.themoviedb.org/movie/'+movie.id,title:movie.title||candidate.title,original:movie.original_title||candidate.title,aliases:[...new Set([...(old?.aliases||[]),movie.title,movie.original_title,...localized,...alternates].filter(Boolean))],year:Number(movie.release_date?.slice(0,4))||candidate.year,genres:(movie.genres||[]).map(genre=>genre.name),synopsis:movie.overview||candidate.description||null,runtime:movie.runtime,poster:movie.poster_path?'https://image.tmdb.org/t/p/w342'+movie.poster_path:null,directors:people((movie.credits?.crew||[]).filter(person=>person.job==='Director'),'tmdb_director'),actors:people(movie.credits?.cast,'tmdb_actor')},candidate,programmeRunId);
}
function touchCanonicalFilm(film,candidate,programmeRunId){
 const explicit=Array.isArray(candidate.shows),incoming=explicit?dedupeShows(candidate.shows):null,same=!!programmeRunId&&film.showsProgrammeRunId===programmeRunId;
 const shows=incoming===null?film.shows||[]:same?dedupeShows([...(film.shows||[]),...incoming]):incoming;
 const hotEnteredAt=candidateIsHot(candidate)&&!filmIsHot(film)?new Date().toISOString():film.hotEnteredAt;
 return {...film,hotEnteredAt,canonicalIdentity:'tmdb:'+film.tmdbId,aliases:[...new Set([...(film.aliases||[]),candidate.title,...(candidate.rawTitles||[])].filter(Boolean))],shows,showsProgrammeRunId:explicit&&programmeRunId?programmeRunId:film.showsProgrammeRunId||null,epgLastAiring:Math.max(film.epgLastAiring||0,candidate.lastAiring||0)};
}
async function publishedPointer(env){
 if(typeof PublishedEpg!=='undefined'){
  const gate=await PublishedEpg.readAuthority(env);
  if(gate.cutover==='held')throw new Error('published_epg_fence');
  const live=await PublishedEpg.currentGeneration(env);
  if(live)return {authority:'d1',programmeRunId:live.programmeRunId,phase:live.phase,etag:live.fence};
 }
 const pointer=await env.BUCKET.get(EPG_GENERATION_KEY),generation=pointer?await pointer.json():null;
 return {authority:'r2',programmeRunId:generation?.programmeRunId??null,phase:generation?.phase??null,etag:pointer?.etag??null};
}
async function publishedGenerationMatches(env,seenRunId){
 const generation=await publishedPointer(env);
 return !(generation?.phase==='published'&&seenRunId&&generation.programmeRunId!==seenRunId);
}
async function saveDiscoveredFilms(env,films,seenRunId,fence=null){
 if(typeof env.beforeCatalogWrite==='function'){const hook=env.beforeCatalogWrite;env.beforeCatalogWrite=null;await hook();}
 if(!await publishedGenerationMatches(env,seenRunId))return false;
 const generation=await publishedPointer(env);
 if(generation?.phase==='published'&&generation.programmeRunId===seenRunId){if(fence)await fence();await saveJSON(env,epgGenerationKey(seenRunId,'discovered-films.json'),films);}
 if(fence)await fence();await saveJSON(env,'epg/discovered-films.json',films);return true;
}
// Owner-triggered poster hydration for catalog records that were stored without a poster: a permanent owner-only maintenance
// route behind the Worker's Cloudflare Access, with no switch of its own (the former CATALOG_POSTER_HYDRATION is retired, ADR
// 0048; `enabled` stays in the answers and is always true). It touches only the `poster`
// field of records with a verified TMDB identity, takes the asset from TMDB movie detail by that id (the same w342 form the
// discovery writer stores), and writes under the resolver lease with a separate compare-and-swap on each catalog copy. A dry run
// reads and counts only. Identity, aliases, shows, decisions, the generation pointer and every other key stay untouched.
const CATALOG_POSTER_LIMIT=20,CATALOG_POSTER_DEFAULT_LIMIT=10,CATALOG_POSTER_ID_SAMPLE=50;
// One compact index of terminal TMDB answers, keyed by the verified numeric TMDB id, not by a catalog id or a generation.
// A missing object is an empty index. Remembered answers are no_poster_on_tmdb (skipped until nextCheckAt, 90 days after
// checkedAt) and tmdb_id_mismatch (never returned to the ordinary queue). A mismatch is only a different valid positive
// numeric movie id. A 200 body with no such id is tmdb_failed. Transient failures are not stored.
const CATALOG_POSTER_NEGATIVES_KEY='epg/catalog-poster-negatives.json',CATALOG_POSTER_NEGATIVES_MAX=2000,CATALOG_POSTER_NEGATIVE_TTL_MS=90*24*60*60*1000,CATALOG_POSTER_TMDB_ID=/^[1-9]\d{0,11}$/;
function catalogPosterPresent(value){return typeof value==='string'&&value.startsWith('https://');}
function catalogPosterVerified(film){return !!film&&typeof film==='object'&&film.tmdbId!=null&&film.tmdbId!==''&&/^\d+$/.test(String(film.tmdbId))&&film.canonicalIdentity==='tmdb:'+String(film.tmdbId);}
function catalogPosterFromDetail(movie){const path=movie?.poster_path;return typeof path==='string'&&/^\/[A-Za-z0-9._-]+$/.test(path)?'https://image.tmdb.org/t/p/w342'+path:null;}
function catalogPosterMovieId(movie){
 const id=movie?.id;
 const text=typeof id==='number'&&Number.isSafeInteger(id)?String(id):typeof id==='string'?id:'';
 return CATALOG_POSTER_TMDB_ID.test(text)?text:null;
}
async function catalogPosterObject(env,key){const object=await env.BUCKET.get(key);return object?{key,etag:object.etag,films:await object.json()}:{key,etag:null,films:null};}
function catalogPosterMissing(sources){
 const records=new Map();
 for(const source of sources)for(const [id,film] of Object.entries(source.films||{})){if(!film||typeof film!=='object')continue;const seen=records.get(id);if(!seen)records.set(id,{id,film,missing:!catalogPosterPresent(film.poster)});else if(!catalogPosterPresent(film.poster))seen.missing=true;}
 const all=[...records.values()].sort((a,b)=>a.id.localeCompare(b.id,'en')),missing=all.filter(row=>row.missing);
 return {all,missing,verified:missing.filter(row=>catalogPosterVerified(row.film)),unverified:missing.filter(row=>!catalogPosterVerified(row.film))};
}
async function catalogPosterDetail(env,tmdbId){
 let lastError=null;
 for(let attempt=0;attempt<2;attempt++){
  try{return {movie:await tmdbRequest(env,'movie/'+tmdbId+'?language=ru-RU')};}
  catch(error){lastError=error;if(error?.retryAt)return {error:String(error.message||error),retryAt:error.retryAt};}
 }
 return {error:String(lastError?.message||lastError||'TMDB request failed')};
}
// Outcomes that end a record's turn in a sweep. Every other outcome is retryable, and the cursor never moves past it.
const CATALOG_POSTER_TERMINAL=new Set(['hydrated','already_present','no_poster_on_tmdb','tmdb_id_mismatch','not_eligible']);
// The two catalog copies are separate R2 objects: each write is its own compare-and-swap, and nothing makes them atomic together.
// The guard runs immediately before every write attempt, including after a lost compare-and-swap: the published generation must
// still be the one the call started from, and the resolver lease must still be ours (renewed). A failed guard stops all writes.
async function catalogPosterGuard(env,programmeRunId,lease){
 const generation=await publishedPointer(env);
 const current=generation?.phase==='published'&&generation.programmeRunId?generation.programmeRunId:null;
 if(current!==programmeRunId)return 'generation_changed';
 if(!await renewDiscoveryLease(env,lease))return 'lease_lost';
 return null;
}
// Applies the fetched posters to one copy. Per record: `written` (set now), `present` (the copy already has a poster),
// `changed` (absent, or no longer the same verified id: never written), or the stop reason. Only `poster` is set; a lost
// compare-and-swap re-reads and retries once, and a second loss leaves the copy unwritten (`catalog_changed`).
async function catalogPosterApply(env,key,found,guard){
 let status={};
 for(let attempt=0;attempt<2;attempt++){
  status={};
  const current=await catalogPosterObject(env,key);
  if(!current.films){for(const row of found)status[row.id]='changed';return {key,written:false,reason:'absent',status};}
  const next={...current.films},applied=[];
  for(const row of found){
   const film=next[row.id];
   if(!catalogPosterVerified(film)||String(film.tmdbId)!==row.tmdbId)status[row.id]='changed';
   else if(catalogPosterPresent(film.poster))status[row.id]='present';
   else{next[row.id]={...film,poster:row.poster};applied.push(row.id);}
  }
  if(!applied.length)return {key,written:false,reason:'nothing_to_apply',status};
  const stop=await guard();
  if(stop){for(const id of applied)status[id]=stop;return {key,written:false,reason:stop,status};}
  if(typeof env.beforeCatalogPosterWrite==='function'){const hook=env.beforeCatalogPosterWrite;env.beforeCatalogPosterWrite=null;await hook(key);}
  const saved=await env.BUCKET.put(key,JSON.stringify(next),{onlyIf:{etagMatches:current.etag},httpMetadata:{contentType:'application/json'}});
  if(saved!==null){for(const id of applied)status[id]='written';return {key,written:true,reason:null,status};}
  for(const id of applied)status[id]='catalog_changed';
 }
 return {key,written:false,reason:'catalog_changed',status};
}
// Display fields of an outcome, from the catalog record this call already read: bounded text and an integer year, never markup.
function catalogPosterDisplay(film){return {title:typeof film?.title==='string'&&film.title?film.title.slice(0,200):null,year:Number.isInteger(film?.year)?film.year:null};}
function catalogPosterOutcome(id,writes){
 const states=writes.map(write=>write.status[id]),writtenTo=writes.filter(write=>write.status[id]==='written').map(write=>write.key);
 if(states.includes('changed'))return {outcome:'skipped_changed',writtenTo};
 if(states.every(state=>state==='written'||state==='present'))return {outcome:writtenTo.length?'hydrated':'already_present',writtenTo};
 return {outcome:states.find(state=>state&&state!=='written'&&state!=='present')||'not_written',writtenTo};
}
// A present object that is not this schema is unreadable: the queue must not proceed as if no answer were remembered.
function catalogPosterNegativesParse(body){
 if(!body||typeof body!=='object'||Array.isArray(body)||body.schemaVersion!==1||!body.entries||typeof body.entries!=='object'||Array.isArray(body.entries))return null;
 const ids=Object.keys(body.entries);
 if(ids.length>CATALOG_POSTER_NEGATIVES_MAX)return null;
 const entries={};
 for(const id of ids){
  if(!CATALOG_POSTER_TMDB_ID.test(id))return null;
  const entry=body.entries[id];
  if(!entry||typeof entry!=='object'||Array.isArray(entry)||typeof entry.checkedAt!=='string'||!Number.isFinite(Date.parse(entry.checkedAt)))return null;
  if(entry.status==='tmdb_id_mismatch'){entries[id]={status:'tmdb_id_mismatch',checkedAt:entry.checkedAt};continue;}
  if(entry.status!=='no_poster_on_tmdb'||typeof entry.nextCheckAt!=='string'||!Number.isFinite(Date.parse(entry.nextCheckAt)))return null;
  entries[id]={status:'no_poster_on_tmdb',checkedAt:entry.checkedAt,nextCheckAt:entry.nextCheckAt};
 }
 return entries;
}
async function catalogPosterNegativesRead(env){
 const object=await env.BUCKET.get(CATALOG_POSTER_NEGATIVES_KEY);
 if(!object)return {ok:true,etag:null,entries:{}};
 let body=null;
 try{body=await object.json();}catch{return {ok:false,etag:object.etag||null};}
 const entries=catalogPosterNegativesParse(body);
 return entries?{ok:true,etag:object.etag||null,entries}:{ok:false,etag:object.etag||null};
}
// `actionable` is requested. `no_poster_held` waits for nextCheckAt. `identity_review` is never requested again by an ordinary call.
function catalogPosterVerdict(film,entries,nowMs){
 const entry=entries[String(film?.tmdbId)];
 if(!entry)return 'actionable';
 if(entry.status==='tmdb_id_mismatch')return 'identity_review';
 return Date.parse(entry.nextCheckAt)<=nowMs?'actionable':'no_poster_held';
}
function catalogPosterPartition(verified,entries,nowMs){
 const actionable=[],held=[],review=[];
 for(const row of verified){
  const verdict=catalogPosterVerdict(row.film,entries,nowMs);
  if(verdict==='actionable')actionable.push(row);
  else if(verdict==='identity_review')review.push(row);
  else held.push(row);
 }
 return {actionable,held,review};
}
function catalogPosterNegativesStale(entries,stillMissing){return Object.keys(entries).some(id=>!stillMissing.has(id));}
// Merges this call's terminal answers into the index and drops ids that are no longer a verified record without a poster.
// A lost compare-and-swap retries once from a fresh read. Anything not actually stored comes back in `unsaved`.
async function catalogPosterNegativesSave(env,current,additions,stillMissing,guard){
 let etag=current.etag,base=current.entries;
 for(let attempt=0;attempt<2;attempt++){
  if(attempt>0){
   const again=await catalogPosterNegativesRead(env);
   if(!again.ok)return {durable:false,unsaved:[...additions.keys()],reason:'unreadable',written:false};
   etag=again.etag;base=again.entries;
  }
  const entries={},unsaved=[];
  for(const [id,entry] of Object.entries(base))if(stillMissing.has(id))entries[id]=entry;
  const nowMs=Date.now(),checkedAt=new Date(nowMs).toISOString(),nextCheckAt=new Date(nowMs+CATALOG_POSTER_NEGATIVE_TTL_MS).toISOString();
  let count=Object.keys(entries).length;
  for(const [id,status] of additions){
   if(!entries[id]&&count>=CATALOG_POSTER_NEGATIVES_MAX){unsaved.push(id);continue;}
   if(!entries[id])count++;
   entries[id]=status==='no_poster_on_tmdb'?{status,checkedAt,nextCheckAt}:{status,checkedAt};
  }
  const ordered={};for(const id of Object.keys(entries).sort())ordered[id]=entries[id];
  const same=Object.keys(ordered).length===Object.keys(base).length&&Object.keys(ordered).every(id=>base[id]&&base[id].status===ordered[id].status&&base[id].checkedAt===ordered[id].checkedAt&&base[id].nextCheckAt===ordered[id].nextCheckAt);
  if(same)return {durable:true,unsaved,reason:unsaved.length?'index_full':null,written:false};
  const stop=await guard();
  if(stop)return {durable:false,unsaved:[...additions.keys()],reason:stop,written:false};
  if(typeof env.beforePosterNegativeWrite==='function'){const hook=env.beforePosterNegativeWrite;env.beforePosterNegativeWrite=null;await hook(env);}
  const options={httpMetadata:{contentType:'application/json'},onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}};
  const saved=await env.BUCKET.put(CATALOG_POSTER_NEGATIVES_KEY,JSON.stringify({schemaVersion:1,entries:ordered}),options);
  if(saved!==null)return {durable:true,unsaved,reason:unsaved.length?'index_full':null,written:true};
 }
 return {durable:false,unsaved:[...additions.keys()],reason:'cas_conflict',written:false};
}
async function catalogPosterHydration(env,body={}){
 if(body.dryRun!==undefined&&typeof body.dryRun!=='boolean')return json({error:'Invalid dryRun'},400);
 if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>CATALOG_POSTER_LIMIT))return json({error:'Invalid limit'},400);
 if(body.cursor!==undefined&&body.cursor!==null&&(typeof body.cursor!=='string'||body.cursor.length>200))return json({error:'Invalid cursor'},400);
 if(body.expectedProgrammeRunId!==undefined&&(typeof body.expectedProgrammeRunId!=='string'||!body.expectedProgrammeRunId||body.expectedProgrammeRunId.length>200))return json({error:'Invalid expectedProgrammeRunId'},400);
 const dryRun=body.dryRun!==false,limit=body.limit??CATALOG_POSTER_DEFAULT_LIMIT,cursor=body.cursor||null,expected=body.expectedProgrammeRunId??null;
 // An explicit recheck names verified TMDB ids and is the only way past a remembered answer. It is one call, not a sweep.
 let recheckIds=null;
 if(body.recheck!==undefined){
  if(dryRun||body.cursor!==undefined||!Array.isArray(body.recheck)||body.recheck.length<1||body.recheck.length>limit)return json({error:'Invalid recheck'},400);
  recheckIds=[];
  for(const id of body.recheck){if(typeof id!=='string'||!CATALOG_POSTER_TMDB_ID.test(id)||recheckIds.includes(id))return json({error:'Invalid recheck'},400);recheckIds.push(id);}
 }
 const generation=await publishedPointer(env);
 const programmeRunId=generation?.phase==='published'&&generation.programmeRunId?generation.programmeRunId:null;
 // The caller's scope fence: a call bound to one published generation is refused, before any catalog read, lease, TMDB
 // request or write, once another generation (or none) is published.
 const fenced=current=>json({dryRun,enabled:true,error:'Programme generation changed',generationChanged:true,leaseLost:false,expectedProgrammeRunId:expected,programmeRunId:current},409);
 if(expected&&programmeRunId!==expected)return fenced(programmeRunId);
 const sources=[await catalogPosterObject(env,'epg/discovered-films.json')];
 if(programmeRunId)sources.push(await catalogPosterObject(env,epgGenerationKey(programmeRunId,'discovered-films.json')));
 const counts=catalogPosterMissing(sources);
 const negatives=await catalogPosterNegativesRead(env);
 if(!negatives.ok)return json({dryRun,enabled:true,error:'Poster negatives unreadable',negativesReadable:false},503);
 const part=catalogPosterPartition(counts.verified,negatives.entries,Date.now());
 const summary={programmeRunId,catalogRecords:counts.all.length,missingPoster:counts.missing.length,verifiedMissing:counts.verified.length,unverifiedMissing:counts.unverified.length,actionable:part.actionable.length,noPosterHeld:part.held.length,identityReview:part.review.length};
 if(dryRun)return json({dryRun:true,enabled:true,...summary,ids:part.actionable.slice(0,CATALOG_POSTER_ID_SAMPLE).map(row=>row.id)});
 if(!env.TMDB_API_READ_ACCESS_TOKEN)return json({error:'TMDB is not configured'},503);
 const lease=await acquireDiscoveryLease(env);
 if(!lease)return json({dryRun:false,enabled:true,error:'Resolver is writing the catalog',...summary},409);
 try{
  if(expected){
   const latest=await publishedPointer(env);
   const current=latest?.phase==='published'&&latest.programmeRunId?latest.programmeRunId:null;
   if(current!==expected)return fenced(current);
  }
  // The ordinary queue is the actionable part only. A recheck names ids and ignores both the cursor and remembered answers.
  // Slots keep the owner's order: a named id that is not a verified record without a poster is not_eligible and is not sent to TMDB.
  let queue,batch,recheckSlots=null;const outcomes=[];
  if(recheckIds){
   const verifiedByTmdb=new Map(counts.verified.map(row=>[String(row.film.tmdbId),row]));
   batch=[];recheckSlots=[];
   for(const id of recheckIds){
    const row=verifiedByTmdb.get(id);
    if(row){batch.push(row);recheckSlots.push(row.id);continue;}
    const known=counts.all.find(item=>String(item.film?.tmdbId)===id);
    recheckSlots.push({id:known?known.id:'tmdb:'+id,tmdbId:id,...(known?catalogPosterDisplay(known.film):{title:null,year:null}),outcome:'not_eligible'});
   }
   queue=batch;
  }else{queue=part.actionable.filter(row=>!cursor||row.id.localeCompare(cursor,'en')>0);batch=queue.slice(0,limit);}
  const found=[];
  let retryAt=null;
  for(const row of batch){
   const tmdbId=String(row.film.tmdbId),shown=catalogPosterDisplay(row.film);
   if(retryAt){outcomes.push({id:row.id,tmdbId,...shown,outcome:'not_attempted'});continue;}
   const detail=await catalogPosterDetail(env,tmdbId);
   if(detail.retryAt){retryAt=detail.retryAt;outcomes.push({id:row.id,tmdbId,...shown,outcome:'rate_limited'});continue;}
   if(detail.error){outcomes.push({id:row.id,tmdbId,...shown,outcome:'tmdb_failed',error:detail.error});continue;}
   const movieId=catalogPosterMovieId(detail.movie);
   if(!movieId){outcomes.push({id:row.id,tmdbId,...shown,outcome:'tmdb_failed',error:'TMDB detail has no movie id'});continue;}
   if(movieId!==tmdbId){outcomes.push({id:row.id,tmdbId,...shown,outcome:'tmdb_id_mismatch'});continue;}
   const poster=catalogPosterFromDetail(detail.movie);
   if(!poster){outcomes.push({id:row.id,tmdbId,...shown,outcome:'no_poster_on_tmdb'});continue;}
   found.push({id:row.id,tmdbId,poster});outcomes.push({id:row.id,tmdbId,...shown,outcome:'pending',poster});
  }
  if(recheckSlots){
   const byId=new Map(outcomes.map(item=>[item.id,item]));
   outcomes.length=0;
   for(const slot of recheckSlots)outcomes.push(typeof slot==='string'?byId.get(slot):slot);
  }
  // Generation copy first, then the live catalog. A stop before either write leaves both unwritten; a stop between them leaves
  // the generation copy written and the live catalog not, which the response reports per copy and per record.
  const writes=[];
  if(found.length){
   const guard=()=>catalogPosterGuard(env,programmeRunId,lease);
   let stopped=null;
   for(const key of programmeRunId?[epgGenerationKey(programmeRunId,'discovered-films.json'),'epg/discovered-films.json']:['epg/discovered-films.json']){
    if(stopped){writes.push({key,written:false,reason:stopped,status:Object.fromEntries(found.map(row=>[row.id,stopped]))});continue;}
    const result=await catalogPosterApply(env,key,found,guard);writes.push(result);
    if(result.reason==='generation_changed'||result.reason==='lease_lost')stopped=result.reason;
   }
  }
  for(const item of outcomes)if(item.outcome==='pending'){const result=catalogPosterOutcome(item.id,writes);item.outcome=result.outcome;if(result.writtenTo.length)item.writtenTo=result.writtenTo;if(result.outcome!=='hydrated'&&!result.writtenTo.length)delete item.poster;}
  // Remember only answers this call actually got from TMDB. A failed write is reported on the outcome and is not treated as stored.
  const additions=new Map();
  for(const item of outcomes){
   if(item.outcome!=='no_poster_on_tmdb'&&item.outcome!=='tmdb_id_mismatch')continue;
   const id=String(item.tmdbId);
   if(CATALOG_POSTER_TMDB_ID.test(id))additions.set(id,item.outcome);
  }
  const stillMissing=new Set(counts.verified.map(row=>String(row.film.tmdbId)));
  for(const item of outcomes)if(item.outcome==='hydrated'||item.outcome==='already_present')stillMissing.delete(String(item.tmdbId));
  const negativeResult=additions.size||catalogPosterNegativesStale(negatives.entries,stillMissing)
   ?await catalogPosterNegativesSave(env,negatives,additions,stillMissing,()=>catalogPosterGuard(env,programmeRunId,lease))
   :{durable:true,unsaved:[],reason:null,written:false};
  for(const item of outcomes)if(item.outcome==='no_poster_on_tmdb'||item.outcome==='tmdb_id_mismatch')item.negativeSaved=CATALOG_POSTER_TMDB_ID.test(String(item.tmdbId))&&negativeResult.durable&&!negativeResult.unsaved.includes(String(item.tmdbId));
  // Completion invariant: the cursor walks the actionable queue, which already excludes remembered answers. Following
  // `nextCursor` from no cursor until `done` settles that queue, not every verified record without a poster. `done` is true
  // only when this batch reached the end of that queue and every outcome in it is terminal. A recheck is not a sweep: its
  // cursor stays null. An empty actionable queue is `done` and still reports the remembered counts above.
  const recheckMode=!!recheckIds;
  const firstOpen=outcomes.findIndex(item=>!CATALOG_POSTER_TERMINAL.has(item.outcome));
  const settled=firstOpen<0?batch.length:firstOpen;
  const done=recheckMode?firstOpen<0:batch.length===queue.length&&firstOpen<0;
  // `null` is reserved for completion; a sweep that has to restart from the first record gets the empty cursor instead.
  const nextCursor=recheckMode?null:done?null:settled>0?batch[settled-1].id:(cursor||'');
  const generationChanged=writes.some(write=>write.reason==='generation_changed')||negativeResult.reason==='generation_changed',leaseLost=writes.some(write=>write.reason==='lease_lost')||negativeResult.reason==='lease_lost';
  const negativeOutcomes=outcomes.filter(item=>item.outcome==='no_poster_on_tmdb'||item.outcome==='tmdb_id_mismatch');
  const payload={dryRun:false,enabled:true,...summary,recheck:recheckMode,requested:limit,processed:outcomes.filter(item=>item.outcome!=='not_attempted'&&item.outcome!=='not_eligible').length,hydrated:outcomes.filter(item=>item.outcome==='hydrated').length,outcomes,
   negatives:{persisted:negativeResult.durable&&negativeOutcomes.every(item=>item.negativeSaved===true),reason:negativeResult.reason,written:negativeResult.written},
   writes:writes.map(write=>({key:write.key,written:write.written,reason:write.reason,records:Object.values(write.status).filter(state=>state==='written').length})),
   retryable:outcomes.filter(item=>!CATALOG_POSTER_TERMINAL.has(item.outcome)).map(item=>item.id),generationChanged,leaseLost,retryAt,done,nextCursor,remainingAfterCursor:recheckMode?0:Math.max(0,queue.length-settled)};
  if(leaseLost)return json({...payload,error:'Resolver lease lost; see writes for the copies already written'},409);
  return json(payload);
 }finally{await releaseDiscoveryLease(env,lease);}
}
async function attachWatchlistShowing(env,seenRunId,filmId,candidate,fence=null){
 if(!await publishedGenerationMatches(env,seenRunId))return false;
 const pinned=await pinEpg(env);
 if(pinned.epgPin?.programmeRunId&&seenRunId&&pinned.epgPin.programmeRunId!==seenRunId)return false;
 const report=await loadJSON(pinned,'programme.json');
 if(!report?.films||(report.runId&&seenRunId&&report.runId!==seenRunId))return false;
 const index=report.films.findIndex(film=>String(film.id)===String(filmId));
 if(index<0)return false;
 const current=report.films[index],next=touchCanonicalFilm(current,candidate,seenRunId);
 next.title=current.title;
 if(!Object.hasOwn(current,'canonicalIdentity'))delete next.canonicalIdentity;
 report.films[index]=next;
 const pointer=await publishedPointer(env);
 if(pointer?.phase==='published'&&seenRunId&&pointer.programmeRunId!==seenRunId)return false;
 if(pointer?.phase==='published'&&pointer.programmeRunId===seenRunId){
  if(fence)await fence();
  if(pointer.authority==='d1'){
   const expectedGeneration=Number(String(pointer.etag||'').split(':')[1]);
   const patched=await PublishedEpg.patchProgramme(env,seenRunId,report,{expectedGeneration});
   if(!patched)return false;
   const again=await publishedPointer(env);
   if(again?.programmeRunId!==seenRunId||!PublishedEpg.advancedFence(pointer.etag,again?.etag))return false;
   await saveJSON(env,epgGenerationKey(seenRunId,'programme.json'),report);
   return true;
  }
  await saveJSON(env,epgGenerationKey(seenRunId,'programme.json'),report);
  const again=await publishedPointer(env);
  if(again?.programmeRunId!==seenRunId||pointer.etag&&again.etag!==pointer.etag)return false;
  return true;
 }
 if(fence)await fence();await saveJSON(env,'programme.json',report);return true;
}
async function resolveDiscoveryBatch(env,report,limit=24){
 if(!env.TMDB_API_READ_ACCESS_TOKEN)return {stage:'missing_secret',checked:0,remaining:null};
 const lease=await acquireDiscoveryLease(env);if(!lease)return {stage:'busy',checked:0,remaining:null};
 try{return await resolveDiscoveryChunk(env,report,limit,lease);}finally{await releaseDiscoveryLease(env,lease);}
}
// `checkpoint`, when given, is called with the chunk's summary immediately after the hop-marked final status is
// saved and before any trailing write (score preview), so that the continuation checkpoint is the
// very next durable write after the status; see advanceDiscovery.
// A ledger above the in-memory cap is a cursor, not an array. One page is resident at a time, and only the
// next `limit` actionable observations are kept for the TMDB calls.
async function resolvePagedDiscoveryChunk(env,report,limit,lease,checkpoint,source,startedAt,hopId,fence,pinned,entryAt=null){
 const last=await loadJSON(env,'epg/discovery-status.json');
 if(last?.retryAt&&Date.parse(last.retryAt)>Date.now())return {...last,stage:'backoff',checked:0};
 // The D1 lease lives 90 s and cannot be renewed once it has expired, so the chunk renews it on every long phase
 // boundary instead of only before its final write. `timings` is the chunk's own wall clock: it is the evidence a
 // later reader needs to tell a slow read from a lost lease or a client that went away.
 const t0=Date.parse(startedAt)||Date.now(),timings={preChunkMs:Number.isFinite(entryAt)?Math.max(0,t0-entryAt):null,walkMs:null,pages:0,concurrency:PAGED_WALK_CONCURRENCY,renewals:0,firstRenewMs:null,cheapMs:null,tmdbMs:null,writeMaxMs:null,preCommitMs:null,statusMs:null,checkpointMs:null,totalMs:null};
 // Three deadlines inside the budget. No unit of work (a cheap-pass write, a TMDB request, a candidate) starts after
 // `candidateDeadline`; no durable write other than the final status and checkpoint starts after `persistLimit`; the
 // last PAGED_CHECKPOINT_RESERVE_MS are the final renewal, status and checkpoint. A D1 write batch cannot be pre-empted, so
 // each unit is also started only if the slowest write batch seen so far still fits before its deadline.
 const candidateDeadline=t0+PAGED_CHUNK_BUDGET_MS-PAGED_COMMIT_RESERVE_MS,walkDeadline=candidateDeadline-PAGED_MIN_REQUEST_MS;
 let writeCostMs=0;
 const timedWrite=async write=>{const began=Date.now();try{return await write();}finally{writeCostMs=Math.max(writeCostMs,Date.now()-began);}};
 const writeEstimate=count=>(writeCostMs||PAGED_DEFAULT_WRITE_MS)*count;
 // The final writes (preview, renewal, status, checkpoint) cost as much as D1 makes a write cost, so the reserve for them
 // grows with the slowest write seen: on a slow D1 the chunk stops storing earlier and still checkpoints inside the budget.
 const persistLimit=()=>t0+PAGED_CHUNK_BUDGET_MS-Math.max(PAGED_CHECKPOINT_RESERVE_MS,PAGED_FINAL_WRITES*(writeCostMs||PAGED_DEFAULT_WRITE_MS));
 const lost=(e,failedAt)=>{if(e?.name==='LeaseLostError')e.timings??={...timings,sinceStartMs:Date.now()-t0,failedAt};return e;};
 const heartbeat=async()=>{
  if(!lease||lease.expiresAt-Date.now()>DISCOVERY_LEASE_RENEW_MARGIN_MS)return;
  try{await fence();}catch(e){throw lost(e,'heartbeat');}
  timings.renewals++;if(timings.firstRenewMs==null)timings.firstRenewMs=Date.now()-t0;
 };
 // A D1 write that fails its fence is either a lost lease (the renewal throws) or a generation that moved under it.
 const guarded=async write=>{
  try{return await write();}
  catch(e){if(e?.code!=='discovery_fence')throw e;try{await fence();}catch(le){throw lost(le,'write');}return null;}
 };
 const selectAfter=typeof last?.selectAfter==='string'?last.selectAfter:'';
 const touchAfter=typeof last?.touchAfter==='string'?last.touchAfter:'';
 const watchlist=report.films||[],knownTmdb=new Map(watchlist.filter(f=>f.tmdbId).map(f=>[String(f.tmdbId),String(f.id)])),aliasIndex=new Map();
 const indexFilm=film=>{if(!film?.tmdbId)return;for(const alias of new Set([film.title,film.original,...(film.aliases||[])])){const key=epgTitleParts(alias).normalizedTitle;if(!key)continue;const entries=aliasIndex.get(key)||new Map();entries.set(String(film.tmdbId),film);aliasIndex.set(key,entries);}};
 const cheap={decisions:new Map(),decisionTotal:0,films:new Set(),before:new Map()};
 const pending=[],decisions={};
 let error=null,retryAt=null;
 const walkStarted=Date.now();
 const selected=await DiscoveryAuthority.selectActionableObservations(env,{after:selectAfter,touchAfter,now:Date.now(),pageSize:Math.max(limit,DiscoveryAuthority.SELECT_PAGE),touchLimit:PAGED_CHEAP_FILMS,shouldStop:()=>Date.now()>=walkDeadline,beforeQuery:heartbeat});
 timings.walkMs=Date.now()-walkStarted;timings.pages=selected.queries;timings.concurrency=1;
 const maxPage=selected.items.length;
 const walkComplete=selected.complete===true||selected.items.length>0;
 if(!selected.items.length&&selected.remaining>0&&!walkComplete){error='wall_budget';retryAt=new Date(Date.now()+PAGED_BUDGET_BACKOFF_MS).toISOString();}
 const films=(await loadJSON(pinned,'epg/discovered-films.json'))||{};
 for(const film of [...Object.values(films),...watchlist])indexFilm(film);
 const nowSelect=Date.now();
 for(const row of [...selected.items,...selected.touches]){
  const candidate=row.candidate,stored=row.decision||null;
  decisions[candidate.key]=stored;
  let decision=stored;
  const reason=screenedNonfilmReason(candidate,stored);
  if(reason){
   if(stored?.status!=='excluded_nonfilm'){decision={status:'excluded_nonfilm',reason,checkedAt:startedAt};cheap.decisionTotal++;if(cheap.decisions.size<PAGED_CHEAP_DECISIONS)cheap.decisions.set(candidate.key,{previous:stored??null,next:decision,kind:'screened'});}
  }else{
   if(candidate.confirmedTmdbId&&(!stored||stored.status==='excluded_nonfilm')&&!ownerRejected(stored,candidate.confirmedTmdbId)){
    decision={status:'verified',filmId:knownTmdb.get(candidate.confirmedTmdbId)||'tmdb_'+candidate.confirmedTmdbId,tmdbId:candidate.confirmedTmdbId,identitySource:'known_epg_alias',checkedAt:startedAt};
    cheap.decisionTotal++;if(cheap.decisions.size<PAGED_CHEAP_DECISIONS)cheap.decisions.set(candidate.key,{previous:stored??null,next:decision,kind:'alias'});
   }
   if(decision?.status==='verified'){
    const filmKey='tmdb_'+decision.tmdbId,film=films[filmKey];
    if(film&&candidateIsHot(candidate,nowSelect)){
     if(!cheap.before.has(filmKey))cheap.before.set(filmKey,JSON.stringify(film));
     films[filmKey]=touchCanonicalFilm(film,candidate,source.programmeRunId);
     cheap.films.add(filmKey);
    }
   }
  }
  if(!resolutionActionability(candidate,decision,nowSelect))continue;
  pending.push(candidate);
 }
 pending.sort((a,b)=>(candidateIsHot(b,nowSelect)?1:0)-(candidateIsHot(a,nowSelect)?1:0)||Number(!!b.year)-Number(!!a.year)||(Number(b.lastAiring)||0)-(Number(a.lastAiring)||0)||String(a.key).localeCompare(String(b.key)));
 const queued=new Set(pending.map(candidate=>candidate.key));
 if(pending.length>limit)pending.length=limit;
 let checked=0,added=0,tmdbCalls=0,screenedOut=0,knownAliases=0,touchedWritten=0,cheapRemaining=0;
 const programmeChanged=()=>({schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:knownAliases,touched:touchedWritten,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,currentProgrammeRunId:null,timings});
 const cheapStarted=Date.now();
 if(selected.items.length||selected.touches.length){
  // Decisions first, then the touched Films, in small atomic groups. The clock is checked between groups, so a slow D1
  // stops the cheap pass with what is already written kept and the rest counted in `cheapRemaining`.
  const planned=[...cheap.decisions];
  const changedFilms=[...cheap.films].filter(key=>JSON.stringify(films[key])!==cheap.before.get(key));
  const filmBatch=changedFilms.slice(0,PAGED_CHEAP_FILMS);
  let decisionsAttempted=0,filmsAttempted=0;
  for(let index=0;index<planned.length;index+=PAGED_CHEAP_GROUP){
   if(Date.now()+writeEstimate(1)>Math.min(candidateDeadline,persistLimit()))break;
   const group=planned.slice(index,index+PAGED_CHEAP_GROUP);
   await heartbeat();
   const wrote=await guarded(()=>timedWrite(()=>DiscoveryAuthority.writeDecisionDelta(env,Object.fromEntries(group.map(([key,item])=>[key,{previous:item.previous,next:item.next}])),{lease})));
   if(!wrote)return programmeChanged();
   const done=new Set(wrote.written);
   // A key the chunk skipped belongs to another writer now (the owner, or a ledger that changed): it is not cheap work left.
   for(const [key,item] of group)if(done.has(key)){decisions[key]=item.next;if(item.kind==='screened')screenedOut++;else knownAliases++;}
   decisionsAttempted+=group.length;
  }
  const perBatch=Math.max(1,Math.floor((DiscoveryAuthority.STATEMENT_CAP-2)/2));
  for(let index=0;index<filmBatch.length;index+=perBatch){
   if(Date.now()+writeEstimate(1)>Math.min(candidateDeadline,persistLimit()))break;
   const group=filmBatch.slice(index,index+perBatch);
   await heartbeat();
   const wrote=await guarded(()=>timedWrite(()=>DiscoveryAuthority.upsertAdmissions(env,Object.fromEntries(group.map(key=>[key,films[key]])),{lease})));
   if(!wrote)return programmeChanged();
   touchedWritten+=wrote.written.length;
   filmsAttempted+=group.length;
  }
  cheapRemaining=(cheap.decisionTotal-decisionsAttempted)+(changedFilms.length-filmsAttempted);
  // The status the interrupted-recovery gate reads as this hop's proof that its cheap pass ran.
  if(Date.now()+writeEstimate(1)<=persistLimit()){
   await heartbeat();
   try{await fence();}catch(e){throw lost(e,'cheap_pass');}
   await timedWrite(()=>saveJSON(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId||null,hopId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched:touchedWritten,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,checkpoint:'cheap_pass'}));
  }
 }
 timings.cheapMs=Date.now()-cheapStarted;
 // The call cap and the time left are enforced at the request boundary: a candidate that would need a request beyond
 // either stops the loop. That is the budget running out, not a TMDB failure, so it sets no error and no retry time.
 const query=async path=>{
  const left=candidateDeadline-Date.now();
  if(tmdbCalls>=PAGED_TMDB_CALLS||left<PAGED_MIN_REQUEST_MS)throw budgetExhaustedError();
  tmdbCalls++;
  try{return await tmdbRequest(env,path,{timeoutMs:left});}
  catch(e){if(left<12000&&(e?.name==='TimeoutError'||e?.name==='AbortError'))throw budgetExhaustedError();throw e;}
 };
 // One Film and one decision per candidate, each its own fenced write: the Film first, so a crash between the two is
 // repaired by alias reuse, as on the document path. A decision another writer changed meanwhile stands.
 const saveCandidate=async(candidate,previous,filmEntry)=>{
  // Too late for a durable write that must still leave the final checkpoint its time: the candidate is not stored and not counted.
  if(Date.now()>persistLimit())return 'late';
  await heartbeat();
  if(filmEntry){
   if(!await publishedGenerationMatches(env,source.programmeRunId))return 'changed';
   const wrote=await guarded(()=>timedWrite(()=>DiscoveryAuthority.upsertAdmissions(env,{[filmEntry[0]]:filmEntry[1]},{lease})));
   if(!wrote)return 'changed';
   // An identity that already belongs to another film id is never merged: the chunk stops and backs off.
   if(wrote.refused.length)return 'refused';
   if(!wrote.written.includes(filmEntry[0]))return 'changed';
  }
  const wrote=await guarded(()=>timedWrite(()=>DiscoveryAuthority.writeDecisionDelta(env,{[candidate.key]:{previous:previous??null,next:decisions[candidate.key]}},{lease})));
  if(!wrote)return 'changed';
  if(wrote.skipped.some(item=>item.reason==='conflict'||item.reason==='observation_gone'||item.reason==='evidence_changed'))decisions[candidate.key]=previous;
  return 'saved';
 };
 const preview={},now=Date.now(),tmdbStarted=Date.now();
 if(!error)for(const candidate of pending){
  // Start a candidate only if a request and its two writes still fit before the durable-write deadline.
  if(Date.now()+PAGED_MIN_REQUEST_MS+writeEstimate(2)>persistLimit())break;
  try{
   const previous=decisions[candidate.key];
   let candidates=knownScorerCandidates(aliasIndex,candidate);
   const observation={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:candidate.durations};
   let score=scoreFilmResolution({observation,candidates});
   const rejectedTop=ownerRejected(previous,score.acceptedTmdbId);
   const searched=rejectedTop||!score.considered.some(row=>row.title.quality===1);
   if(searched)candidates=[...candidates,...await scoredSearchCandidates(query,candidate)],score=scoreFilmResolution({observation,candidates});
   const proposed=[];
   let filmEntry=null,newFilm=false;
   if(ownerRejected(previous,score.acceptedTmdbId)){
    recordUncertain(decisions,candidate,'no_confident_match',now);
    preview[candidate.key]=scorePreview(candidate,score,{outcome:'candidate_decision',reason:'owner_rejected',candidateDecision:{status:'no_confident_match'}},proposed);
   }else{
    let gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now);
    let movie=null;
    if(gate.outcome==='needs_verification'&&score.status==='accepted'&&score.acceptedTmdbId&&!ownerRejected(previous,score.acceptedTmdbId)){
     movie=await query('movie/'+score.acceptedTmdbId+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');
     gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:detailCompetitors(aliasIndex,candidate,score.acceptedTmdbId,structuralCompetitorForms(score))});
    }
    preview[candidate.key]=scorePreview(candidate,score,gate,proposed);
    if(gate.outcome==='candidate_decision')recordUncertain(decisions,candidate,gate.candidateDecision.status,now);
    else if(gate.outcome==='needs_verification')recordNeedsVerification(decisions,candidate,score,now);
    else if(gate.outcome==='detail_verified'){
     const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
     if(knownTmdb.has(String(movie.id))){
      // A Film already on the watchlist takes the airing on the programme, not in the catalog.
      if(!await attachWatchlistShowing(env,source.programmeRunId,id,candidate,fence)||!await publishedGenerationMatches(env,source.programmeRunId))return programmeChanged();
     }else{
      const old=films[id];
      films[id]=catalogFilmFromDetail(movie,candidate,old,source.programmeRunId,id);indexFilm(films[id]);
      filmEntry=[id,films[id]];
      newFilm=!old;
      if(newFilm)added++;
     }
     decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(movie.id),canonicalIdentity:'tmdb:'+movie.id,identitySource:'tmdb_detail',checkedAt:new Date().toISOString(),evidenceKey:candidateEvidence(candidate),provenance:{authority:'tmdb_detail',searchHit:searched,priorAlias:false,ownerReviewed:false,movieId:String(movie.id),runtime:movie.runtime??null,releaseYear:Number(String(movie.release_date||'').slice(0,4))||null,matchedTitle:candidate.normalizedTitle,programmeRunId:source.programmeRunId||null},scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null},...ownerMarkerCarry(previous)};
    }
   }
   const saved=await saveCandidate(candidate,previous,filmEntry);
   if(saved==='changed')return programmeChanged();
   if(saved==='late'){decisions[candidate.key]=previous;if(newFilm){added--;delete films[filmEntry[0]];}break;}
   if(saved==='refused'){error='admission_identity_conflict';retryAt=new Date(Date.now()+3600000).toISOString();decisions[candidate.key]=previous;if(newFilm){added--;delete films[filmEntry[0]];}break;}
   checked++;
  }catch(e){
   if(e?.name==='BudgetExhaustedError')break;
   if(e?.name==='LeaseLostError'){e.timings??={...timings,sinceStartMs:Date.now()-t0,failedAt:'tmdb'};throw e;}
   error=String(e.message).slice(0,120);retryAt=e.retryAt||new Date(Date.now()+60000).toISOString();break;
  }
 }
 // Candidates were waiting and none could be taken before the budget ended: say so, and back off.
 if(!error&&pending.length&&checked===0){error='wall_budget';retryAt=new Date(Date.now()+PAGED_BUDGET_BACKOFF_MS).toISOString();}
 timings.tmdbMs=Date.now()-tmdbStarted;
 // The prediction queue is not refreshed here: that call has no bound of its own, and the prediction runner refreshes the queue
 // from the catalog on every step, so a Film admitted by this chunk joins it on the runner's next step.
 // The preview is this chunk's scored outcomes. remaining is the SQL actionable set minus what this chunk settled, not the page.
 if((walkComplete||checked>0)&&Date.now()+writeEstimate(1)<=persistLimit()){try{await fence();await timedWrite(()=>saveScorePreview(env,source,preview));}catch(e){throw lost(e,'preview');}}
 timings.writeMaxMs=writeCostMs;
 const settled=checked+screenedOut+knownAliases;
 const remaining=Number.isInteger(selected.remaining)?Math.max(0,selected.remaining-settled):null;
 // Cursor losslessness: advance only through a key-ordered prefix that this chunk handled (cheap skip or TMDB
 // checked). Unprocessed pending keys stay at or after the cursor; a wrap revisits them. Hot-sort never skips.
 const handled=new Set();
 for(const row of selected.items)if(!queued.has(row.candidate.key))handled.add(row.candidate.key);
 for(const candidate of pending.slice(0,checked))handled.add(candidate.key);
 let nextAfter=selectAfter;
 for(const row of selected.items){
  if(!handled.has(row.candidate.key))break;
  nextAfter=row.candidate.key;
 }
 if(!selected.items.length&&remaining===0)nextAfter=selected.after||'';
 const nextTouchAfter=selected.touches.length?selected.touchAfter||touchAfter:touchAfter;
 const summary={schemaVersion:2,stage:error||cheapRemaining>0||remaining==null||remaining>0?'partial':'complete',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:knownAliases,touched:touchedWritten,added,remaining,cheapRemaining,error,retryAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,paged:true,maxPage,itemCount:source.itemCount,tmdbCalls,selectAfter:nextAfter,touchAfter:nextTouchAfter,timings};
 try{await fence();}catch(e){throw lost(e,'final');}
 // `preCommitMs` is what the stored status carries: the time up to its own write. The status write, the continuation
 // checkpoint and the total through that checkpoint are measured after the writes and reach only the returned
 // summary and the step diagnostic, so a quick pre-write figure is never read as a finished checkpoint.
 timings.preCommitMs=Date.now()-t0;
 const statusStarted=Date.now();
 await saveJSON(env,'epg/discovery-status.json',summary);
 timings.statusMs=Date.now()-statusStarted;
 const checkpointStarted=Date.now();
 if(checkpoint)await checkpoint(summary);
 timings.checkpointMs=Date.now()-checkpointStarted;
 timings.totalMs=Date.now()-t0;
 return summary;
}
// AIR-342. The chunk's ledger is its own parse and is never written back. Its fields serve three readers:
// - the cheap pass, the counts, the filters and the observation index read the key, titles, year, durations, shows,
//   lastAiring, lastSeenAt, seenInLatestSnapshot and the confirmed id;
// - the cheap pass also adds the raw titles of a touched observation to its Film's aliases;
// - a detail-verified Film takes the raw titles and, when TMDB has no overview, the EPG description of its candidate.
// So an R2 ledger is streamed without the description and the airing counters (`compactLedgerItem`), which are about
// half of its bytes, and once the chunk has chosen its candidates every other observation also releases its raw
// titles (`releaseLedgerDetail`). A chosen candidate whose description was not kept reads it back on demand.
const LEDGER_DETAIL_FIELDS=['description','rawTitles','firstAiring','airings','lastSeenProgrammeRunId'];
const LEDGER_STREAM_DROPPED=['description','firstAiring','airings','lastSeenProgrammeRunId'];
function compactLedgerItem(item){
 if(item&&typeof item==='object')for(const field of LEDGER_STREAM_DROPPED)if(item[field]!==undefined)item[field]=undefined;
 return item;
}
function releaseLedgerDetail(items,keep){
 for(const item of items){
  if(keep.has(item))continue;
  for(const field of LEDGER_DETAIL_FIELDS)if(item[field]!==undefined)item[field]=undefined;
 }
}
// The EPG description of one observation, streamed from the same ledger the chunk pinned. Null when the ledger or the
// observation is gone or carries none.
async function ledgerDescription(pinned,key){
 let found=null;
 await loadJSON(pinned,'epg/discovery-latest.json',{item:item=>{if(item?.key===key&&typeof item.description==='string')found=item.description;return null;}});
 return found;
}
// AIR-353: `entryAt` is when advanceDiscovery began. The gap to the chunk's own clock is `preChunkMs`: the preflight reads
// (continuation, lease, generation, programme) that `totalMs` does not cover.
async function resolveDiscoveryChunk(env,report,limit,lease=null,checkpoint=null,entryAt=null){
 const startedAt=new Date().toISOString(),deadline=Date.now()+22000,pinned=await pinEpg(env),hopId=lease?.id??null;
 // Every durable write below, including those inside helpers, is preceded by a lease renewal; a lost lease aborts the chunk before the write.
 const fence=async()=>{if(lease&&!await renewDiscoveryLease(env,lease))throw leaseLostError();};
 // AIR-342: the inputs are read one after another. Each R2 JSON is held as its text and its parsed tree while it is
 // parsed, so reading the ledger (tens of MB) beside the catalog and the decisions put all of them in memory at once.
 let streamed=false,source;
 try{source=await loadJSON(pinned,'epg/discovery-latest.json',{item:item=>{streamed=true;return compactLedgerItem(item);}});}
 catch(e){
  // The streamed reader refuses a document without an `items` array, which a whole parse returns as is; that ledger
  // keeps its old outcome below (awaiting_epg_discovery). Any other failure is the chunk's error, as before.
  if(e?.message!=='Discovery ledger JSON is incomplete')throw e;
  streamed=false;source=await loadJSON(pinned,'epg/discovery-latest.json');
 }
 if(source?.paged)return resolvePagedDiscoveryChunk(env,report,limit,lease,checkpoint,source,startedAt,hopId,fence,pinned,entryAt);
 // AIR-426. Under D1 authority a ledger of READ_CAP rows or fewer is read whole, which sends the chunk down the whole-ledger path below. That path
 // saves the whole decision map, and a whole-map save fails closed (`discovery_bounded` above READ_CAP decisions, `discovery_fence` for any decision
 // whose observation is not in the active ledger). A frozen production ledger never gets there (47,059 rows), but a bounded one has the size of
 // one scan (20,568 rows on 10 November, 19,821 and 20,506 earlier), against 32,530 stored decisions of which 4,995 have no active observation. The D1 chunk is
 // the paged one whatever the size; this is the same descriptor the reader gives above READ_CAP.
 if(Array.isArray(source?.items)&&source.archive?.source==='d1')return resolvePagedDiscoveryChunk(env,report,limit,lease,checkpoint,{...source,paged:true,itemCount:source.items.length,items:null},startedAt,hopId,fence,pinned,entryAt);
 if(!source?.items)return {stage:'awaiting_epg_discovery',checked:0,remaining:null};
 const last=await loadJSON(pinned,'epg/discovery-status.json');
 if(last?.retryAt&&Date.parse(last.retryAt)>Date.now())return {...last,stage:'backoff',checked:0};
 const resolution=await loadJSON(pinned,'epg/discovery-resolution.json');
 let films=await loadJSON(pinned,'epg/discovered-films.json')||{};
 const decisions=resolution||{},watchlist=(report.films||[]),knownTmdb=new Map(watchlist.filter(f=>f.tmdbId).map(f=>[String(f.tmdbId),String(f.id)])),aliasIndex=new Map();
 const indexFilm=film=>{if(!film?.tmdbId)return;for(const alias of new Set([film.title,film.original,...(film.aliases||[])])){const key=epgTitleParts(alias).normalizedTitle;if(!key)continue;const entries=aliasIndex.get(key)||new Map();entries.set(String(film.tmdbId),film);aliasIndex.set(key,entries);}};
 for(const film of [...Object.values(films),...watchlist])indexFilm(film);
 let screenedOut=0,knownAliases=0,touched=0,migrated=0;for(const film of Object.values(films))if(film.tmdbId&&film.canonicalIdentity!=='tmdb:'+film.tmdbId){film.canonicalIdentity='tmdb:'+film.tmdbId;migrated++;}
 // Cheap pass updates availability for known identities even though no new lookup is needed.
 for(const candidate of source.items){const decision=decisions[candidate.key],reason=screenedNonfilmReason(candidate,decision);if(reason){if(decision?.status!=='excluded_nonfilm'){decisions[candidate.key]={status:'excluded_nonfilm',reason,checkedAt:startedAt};screenedOut++;}continue;}
  if(candidate.confirmedTmdbId&&(!decision||decision.status==='excluded_nonfilm')&&!ownerRejected(decision,candidate.confirmedTmdbId)){decisions[candidate.key]={status:'verified',filmId:knownTmdb.get(candidate.confirmedTmdbId)||'tmdb_'+candidate.confirmedTmdbId,tmdbId:candidate.confirmedTmdbId,identitySource:'known_epg_alias',checkedAt:startedAt};knownAliases++;}
  const verified=decisions[candidate.key];if(verified?.status==='verified'){const key='tmdb_'+verified.tmdbId,film=films[key];if(film&&candidateIsHot(candidate)){films[key]=touchCanonicalFilm(film,candidate,source.programmeRunId);indexFilm(films[key]);touched++;}}
 }
 if(touched||migrated){if(!await saveDiscoveredFilms(env,films,source.programmeRunId,fence))return {schemaVersion:2,stage:'programme_changed',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,currentProgrammeRunId:null};}if(screenedOut||knownAliases){await fence();await saveJSON(env,'epg/discovery-resolution.json',decisions);}
 await fence();await saveJSON(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',startedAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId||null,hopId,checked:screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls:0,added:0,remaining:null,hotRemaining:null,error:null,retryAt:null,checkpoint:'cheap_pass'});
 const preview={},now=Date.now(),pending=source.items.filter(c=>resolutionActionability(c,decisions[c.key],now)),hotRank=new Map(pending.map(c=>[c,candidateIsHot(c,now)?1:0]));
 pending.sort((a,b)=>hotRank.get(b)-hotRank.get(a)||Number(!!b.year)-Number(!!a.year)||b.lastAiring-a.lastAiring||a.key.localeCompare(b.key));
 const selected=pending.slice(0,limit);
 pending.length=0;hotRank.clear();
 releaseLedgerDetail(source.items,new Set(selected));
 let checked=0,added=0,tmdbCalls=0,error=null,retryAt=null;
 const query=async path=>{tmdbCalls++;return tmdbRequest(env,path);};
 for(const candidate of selected){
  if(Date.now()>deadline||tmdbCalls>=16)break;
  try{
   let candidates=knownScorerCandidates(aliasIndex,candidate);
   const observation={key:candidate.key,title:candidate.title,normalizedTitle:candidate.normalizedTitle,year:candidate.year??null,duration:candidate.duration??null,durations:candidate.durations};
   let score=scoreFilmResolution({observation,candidates});
   const rejectedTop=ownerRejected(decisions[candidate.key],score.acceptedTmdbId);
   let searched=rejectedTop||!score.considered.some(row=>row.title.quality===1);
   if(searched)candidates=[...candidates,...await scoredSearchCandidates(query,candidate)],score=scoreFilmResolution({observation,candidates});
   const proposed=[];
   if(ownerRejected(decisions[candidate.key],score.acceptedTmdbId)){recordUncertain(decisions,candidate,'no_confident_match',now);preview[candidate.key]=scorePreview(candidate,score,{outcome:'candidate_decision',reason:'owner_rejected',candidateDecision:{status:'no_confident_match'}},proposed);await fence();await saveJSON(env,'epg/discovery-resolution.json',decisions);checked++;continue;}
   let gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now);
   let movie=null;
   if(gate.outcome==='needs_verification'&&score.status==='accepted'&&score.acceptedTmdbId&&!ownerRejected(decisions[candidate.key],score.acceptedTmdbId)){
    movie=await query('movie/'+score.acceptedTmdbId+'?language=ru-RU&append_to_response=credits,translations,alternative_titles');
    gate=gateScoredCandidate(pinned,source,candidate,score,decisions,films,now,{tmdbDetail:tmdbDetailFromMovie(movie),competitors:detailCompetitors(aliasIndex,candidate,score.acceptedTmdbId,structuralCompetitorForms(score))});
   }
   preview[candidate.key]=scorePreview(candidate,score,gate,proposed);
   if(gate.outcome==='candidate_decision')recordUncertain(decisions,candidate,gate.candidateDecision.status,now);
   else if(gate.outcome==='needs_verification')recordNeedsVerification(decisions,candidate,score,now);
   else if(gate.outcome==='detail_verified'){
    const id=knownTmdb.get(String(movie.id))||'tmdb_'+movie.id;
    let saved=true;
    if(knownTmdb.has(String(movie.id)))saved=await attachWatchlistShowing(env,source.programmeRunId,id,candidate,fence);
    else{
     const old=films[id];if(!old)added++;
     if(streamed&&!movie.overview&&candidate.description===undefined)candidate.description=await ledgerDescription(pinned,candidate.key)??undefined;
     films[id]=catalogFilmFromDetail(movie,candidate,old,source.programmeRunId,id);indexFilm(films[id]);saved=await saveDiscoveredFilms(env,films,source.programmeRunId,fence);}
    if(!saved||!await publishedGenerationMatches(env,source.programmeRunId))return {schemaVersion:2,stage:'programme_changed',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls,added,remaining:null,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId};
    decisions[candidate.key]={status:'verified',filmId:id,tmdbId:String(movie.id),canonicalIdentity:'tmdb:'+movie.id,identitySource:'tmdb_detail',checkedAt:new Date().toISOString(),evidenceKey:candidateEvidence(candidate),provenance:{authority:'tmdb_detail',searchHit:searched,priorAlias:false,ownerReviewed:false,movieId:String(movie.id),runtime:movie.runtime??null,releaseYear:Number(String(movie.release_date||'').slice(0,4))||null,matchedTitle:candidate.normalizedTitle,programmeRunId:source.programmeRunId||null},scoring:{scorerVersion:score.scorerVersion,status:score.status,reason:score.reason,acceptedTmdbId:score.acceptedTmdbId??null},...ownerMarkerCarry(decisions[candidate.key])};
   }
   // A film is committed before its decision. A crash between writes is repaired by alias reuse.
   await fence();await saveJSON(env,'epg/discovery-resolution.json',decisions);checked++;
  }catch(e){if(e?.name==='LeaseLostError')throw e;error=String(e.message).slice(0,120);retryAt=e.retryAt||new Date(Date.now()+60000).toISOString();break;}
 }
 // The catalog and its alias index serve only the lookups above. Released here, before the programme, the prediction
 // queue (which reads its own copy of the catalog) and the observation index allocate their own copies.
 films=null;aliasIndex.clear();knownTmdb.clear();
 const currentReport=await loadJSON(env,'programme.json');
 if(source.programmeRunId&&currentReport?.runId&&currentReport.runId!==source.programmeRunId){
  const changed={schemaVersion:2,stage:'partial',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls,added,remaining:source.items.filter(c=>discoveryReady(c,decisions[c.key],Date.now())).length,hotRemaining:null,error:null,retryAt:null,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,programmeChanged:true,...VARIANT_DIAGNOSTIC};
  const changedOutcome={...changed,stage:'programme_changed',currentProgrammeRunId:currentReport.runId};
  await fence();await saveJSON(env,'epg/discovery-status.json',changed);if(checkpoint)await checkpoint(changedOutcome);await saveScorePreview(env,source,preview,fence);return changedOutcome;
 }
 try{await refreshPredictionQueue(env,currentReport||report,'resolver_checkpoint',{beforeWrite:fence});}catch(e){if(e?.name==='LeaseLostError')throw e;error=error||'prediction_queue_checkpoint: '+String(e.message).slice(0,100);}
 const persistedDecisions=error?await loadJSON(env,'epg/discovery-resolution.json')||{}:decisions,ready=source.items.filter(c=>resolutionActionability(c,persistedDecisions[c.key],Date.now())),summary={schemaVersion:2,stage:error?'partial':ready.length?'partial':'complete',startedAt,finishedAt:new Date().toISOString(),checked:checked+screenedOut+knownAliases,screenedOut,reused:knownAliases,touched,tmdbCalls,added,remaining:ready.length,hotRemaining:ready.filter(c=>candidateIsHot(c)).length,error,retryAt,at:new Date().toISOString(),programmeRunId:source.programmeRunId,hopId,...VARIANT_DIAGNOSTIC};
 await fence();await saveJSON(env,'epg/discovery-status.json',summary);if(checkpoint)await checkpoint(summary);await saveScorePreview(env,source,preview,fence);await saveObservationIndex(env,source,persistedDecisions,fence,{kind:'resolver_chunk',hopId});return summary;
}
async function discoveryDigest(text){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)));return Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');}
// Index records with the digest of each full decision (the record version the guarded action compares) and the revision
// of each shard (what the manifest names, so a reader can tell a torn index).
async function observationIndexShards(built,decisions){
 const shards=[];
 for(const records of built.shards){
  const items=[];
  for(const record of records)items.push({...record,decisionHash:await discoveryDigest(DiscoveryIndex.canonicalJson(decisions[record.key]))});
  shards.push({items,revision:await discoveryDigest(DiscoveryIndex.canonicalJson(items))});
 }
 return shards;
}
// Writes changed shards, then the manifest, each behind the fence. A shard object carries its revision in custom
// metadata; one whose stored revision already equals the new one is not rewritten (a manifest alone cannot tell, since a
// writer may have stopped between a shard and its manifest). The manifest names the etags of the resolution map and the
// generation ledger as they are now, so any later write to either makes the index stale for every reader.
async function observationShardPut(env,run,index,items,revision,options={}){
 const key=options.shardKey||DiscoveryIndex.observationIndexShardKey(run,index);
 const put={httpMetadata:{contentType:'application/json'},customMetadata:{revision}};
 if(options.onlyIf)put.onlyIf=options.onlyIf;
 return await env.BUCKET.put(key,JSON.stringify(DiscoveryIndex.observationShardDocument(run,index,items,revision)),put);
}
async function writeObservationIndex(env,run,shards,fence,fields,layout){
 const shardKey=layout?.shardKey||(index=>DiscoveryIndex.observationIndexShardKey(run,index));
 const manifestKey=layout?.manifestKey||DiscoveryIndex.observationIndexManifestKey(run);
 for(let index=0;index<shards.length;index++){
  const stored=await env.BUCKET.head(shardKey(index));
  if(stored?.customMetadata?.revision===shards[index].revision)continue;
  await fence();await observationShardPut(env,run,index,shards[index].items,shards[index].revision,{shardKey:shardKey(index)});
 }
 const [resolution,ledger]=await Promise.all([env.BUCKET.head('epg/discovery-resolution.json'),env.BUCKET.head(epgGenerationKey(run,'discovery-latest.json'))]);
 if(!resolution?.etag||!ledger?.etag)return {written:false,reason:'source_unread'};
 await fence();await saveJSON(env,manifestKey,DiscoveryIndex.observationIndexManifest({programmeRunId:run,writtenAt:new Date().toISOString(),...fields,sources:{resolutionEtag:resolution.etag,ledgerEtag:ledger.etag},shards:shards.map(shard=>({items:shard.items.length,revision:shard.revision}))}));
 return {written:true,reason:null};
}
// Two observation indexes of the chunk's generation, from the ledger and the decisions the chunk already holds in
// memory. The unresolved index is the current, unscreened observations that have a decision other than verified or
// excluded. The verified index is the current verified decisions, same generation fence and the same cap. Both are
// written after the checkpoint and the score preview, so a failure here never costs the chunk its progress: every
// error but a lost lease is swallowed, and a previous index whose etags no longer match is then read as stale. Owner
// reads use an index instead of the ledger and the resolution map.
async function saveObservationIndex(env,source,decisions,fence,writer){
 if(typeof DiscoveryAuthority!=='undefined'){
  const gate=await DiscoveryAuthority.readAuthority(env);
  if(gate.held)throw Object.assign(new Error('discovery_fence'),{code:'discovery_fence',name:'DiscoveryFenceError'});
  if(gate.ready)return {written:true,reason:null};
 }
 const run=source.programmeRunId||null;
 try{
  const generation=run?await publishedPointer(env):null;
  if(!run||generation?.phase!=='published'||generation.programmeRunId!==run)return {written:false,reason:'generation_not_published'};
  const now=Date.now(),unresolved=[],verified=[];let awaitingFirstLookup=0;
  for(const candidate of source.items){
   const decision=decisions[candidate.key];
   if(candidateActivity(candidate,now)!=='current'||screenedNonfilmReason(candidate,decision))continue;
   if(!decision){awaitingFirstLookup++;continue;}
   if(decision.status==='excluded_nonfilm')continue;
   if(decision.status==='verified')verified.push({candidate,decision});
   else unresolved.push({candidate,decision});
  }
  const built=DiscoveryIndex.buildObservationIndex({programmeRunId:run,entries:unresolved});
  if(built.error)return {written:false,reason:built.error};
  const verifiedBuilt=DiscoveryIndex.buildObservationIndex({programmeRunId:run,entries:verified,scope:DiscoveryIndex.OBSERVATION_VERIFIED_SCOPE});
  if(verifiedBuilt.error)return {written:false,reason:verifiedBuilt.error};
  const shards=await observationIndexShards(built,decisions);
  const verifiedShards=await observationIndexShards(verifiedBuilt,decisions);
  const unresolvedWritten=await writeObservationIndex(env,run,shards,fence,{writer,coverage:built.coverage,counts:{...discoveryCounts(source.items,decisions,now),awaitingFirstLookup}});
  if(!unresolvedWritten.written)return unresolvedWritten;
  return await writeObservationIndex(env,run,verifiedShards,fence,{writer,coverage:verifiedBuilt.coverage,counts:null},{shardKey:index=>DiscoveryIndex.observationVerifiedShardKey(run,index),manifestKey:DiscoveryIndex.observationVerifiedManifestKey(run)});
 }catch(e){
  if(e?.name==='LeaseLostError')throw e;
  try{console.log(JSON.stringify({event:'discovery_observation_index',programmeRunId:diagnosticId(run),written:false,error:diagnosticErrorCode(e)}));}catch{}
  return {written:false,reason:'error'};
 }
}
// One request runs one chunk. A later HTTP request is not a new isolate; confirm the memory hypothesis in production after deploy. Do not schedule the next chunk with waitUntil.
const DISCOVERY_CHUNK_BUDGET=12;
// Absent, null and '' stay on the external hourly executor. Only the exact token `workflow` leaves that path.
// Any other string fails closed. The binding is not set by a deploy (ADR 0083).
function discoveryExecutorMode(env){
 const value=env?.DISCOVERY_EXECUTOR;
 if(value==null||value==='')return 'external';
 return value==='external'||value==='workflow'?value:'invalid';
}
function discoveryChunkBudget(){return DISCOVERY_CHUNK_BUDGET;}
const CONTINUATION_KEY='epg/resolver-continuation.json';
// AIR-151: read-only diagnostics of the continuation boundary. Every POST /api/sync/epg step and
// every discovery resolve request leaves one bounded entry (codes, counts, timestamps; no tokens,
// titles or payloads) so that "the call never arrived" and "the call arrived but saved no chunk"
// can be told apart from pipeline status. The same entry goes to the Worker log. Nothing here
// retries, dispatches or changes the resolver.
const CONTINUATION_DIAGNOSTICS_KEY='epg/resolver-continuation-diagnostics.json';
const CONTINUATION_DIAGNOSTICS_LIMIT=20;
// Closed vocabularies. A value outside its list is recorded as `other`; free text never enters an entry
// or a log line. Ids must be server-generated UUIDs, times must parse, counts must be finite numbers.
const DIAGNOSTIC_VOCABULARY={
 caller:['http','mcp','internal'],
 route:['/api/sync/metadata','/api/sync/epg','/api/enrichment/discovery/resolve'],
 runStage:['metadata','epg','seal','complete'],
 stage:['idle','paused','running','complete','error','busy','partial','programme_changed','awaiting_epg_discovery','backoff','missing_secret'],
 nextAction:['continue','wait','stop'],
 reason:['ledger_seal','epg_committed','scan_committed','busy','chunk_budget','backoff','programme_changed','idle','missing_secret','error','discovery_failed','orphaned','interrupted','delegated'],
 errorName:['Error','TypeError','RangeError','SyntaxError','ReferenceError','AbortError','TimeoutError'],
};
function diagnosticCode(list,value,fallback='other'){return value==null?null:list.includes(value)?value:fallback;}
function diagnosticId(value){return typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)?value:null;}
function diagnosticTime(value){return typeof value==='string'&&value.length<=40&&Number.isFinite(Date.parse(value))?value:null;}
function diagnosticCount(value){return typeof value==='number'&&Number.isFinite(value)?value:null;}
// Classifies a thrown error into one of seven codes. The message is matched, never copied.
function diagnosticErrorCode(error){
 const name=String(error?.name||''),message=String(error?.message||'');
 if(name==='AbortError'||name==='TimeoutError'||/timed? ?out/i.test(message))return 'timeout';
 if(/generation changed/i.test(message))return 'publish_conflict';
 if(/resolver is writing|lease lost/i.test(message))return 'resolver_busy';
 if(/\br2\b|bucket|storage|etag/i.test(message))return 'storage';
 if(/tmdb|fetch|http\s?\d{3}|upstream|network|socket|dns/i.test(message))return 'upstream';
 if(name==='SyntaxError'||/invalid|not found|required|unexpected/i.test(message))return 'invalid_input';
 return 'unknown';
}
function diagnosticError(error){return {code:diagnosticErrorCode(error),name:diagnosticCode(DIAGNOSTIC_VOCABULARY.errorName,String(error?.name||'Error'),'Error')};}
// A continuation `reason` outside the vocabulary is the thrown message an error record kept; it is
// classified like an error, not copied.
function diagnosticReason(value){return value==null?null:DIAGNOSTIC_VOCABULARY.reason.includes(value)?value:diagnosticErrorCode({message:String(value)});}
function continuationSummary(record){return record&&typeof record==='object'?{stage:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,record.stage),reason:diagnosticReason(record.reason),remainingChunks:diagnosticCount(record.remainingChunks),programmeRunId:diagnosticId(record.programmeRunId),at:diagnosticTime(record.at),nextCatchUpAt:diagnosticTime(record.nextCatchUpAt),retryAt:diagnosticTime(record.retryAt),hopId:diagnosticId(record.hopId)}:null;}
function discoverySummary(contract){return contract&&typeof contract==='object'?{state:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,contract.state),nextAction:diagnosticCode(DIAGNOSTIC_VOCABULARY.nextAction,contract.nextAction),reason:diagnosticReason(contract.reason),remainingChunks:diagnosticCount(contract.remainingChunks),programmeRunId:diagnosticId(contract.programmeRunId),nextCatchUpAt:diagnosticTime(contract.nextCatchUpAt),retryAt:diagnosticTime(contract.retryAt)}:null;}
// The chunk's own wall clock, as bounded integers. `failedAt` names the phase that found the lease gone.
function diagnosticTimings(timings){
 if(!timings||typeof timings!=='object')return null;
 const out={};
 for(const field of ['preChunkMs','walkMs','pages','concurrency','renewals','firstRenewMs','cheapMs','tmdbMs','writeMaxMs','preCommitMs','statusMs','checkpointMs','totalMs','sinceStartMs'])if(Number.isFinite(timings[field]))out[field]=Math.max(0,Math.round(timings[field]));
 if(['heartbeat','tmdb','final','write','cheap_pass','preview'].includes(timings.failedAt))out.failedAt=timings.failedAt;
 return Object.keys(out).length?out:null;
}
function chunkSummary(result){return {...(diagnosticTimings(result.timings)?{timings:diagnosticTimings(result.timings)}:{}),stage:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,result.stage),checked:diagnosticCount(result.checked),remaining:diagnosticCount(result.remaining),cheapRemaining:diagnosticCount(result.cheapRemaining),added:diagnosticCount(result.added),reused:diagnosticCount(result.reused),screenedOut:diagnosticCount(result.screenedOut),touched:diagnosticCount(result.touched),tmdbCalls:diagnosticCount(result.tmdbCalls),variantPending:typeof result.variantPending==='boolean'?result.variantPending:diagnosticCount(result.variantPending),retryAt:diagnosticTime(result.retryAt),programmeRunId:diagnosticId(result.programmeRunId),error:result.error?diagnosticErrorCode({message:String(result.error)}):null};}
// One structured line per phase for Workers Logs; never throws.
function observeContinuation(step){try{console.log(JSON.stringify({event:'epg_continuation',...step}));}catch{}}
// A step entry. `runId` is kept only when it has the server-generated UUID shape; `runIdShape` says
// what the caller sent. `recorded` holds the result of each best-effort ring write: the stored entry
// carries only the writes before its own, the final log line carries all of them. Phases: `entered`,
// `checkpointed` (the discovery hop stored its checkpoint), then `completed` or `failed`.
function continuationStep(caller,route,runId){
 const id=diagnosticId(runId);
 return {id:crypto.randomUUID(),at:new Date().toISOString(),phase:'entered',caller:diagnosticCode(DIAGNOSTIC_VOCABULARY.caller,caller||'http','http'),route:diagnosticCode(DIAGNOSTIC_VOCABULARY.route,route),runId:id,runIdShape:runId==null?null:id?'uuid':'invalid',runStage:null,branch:null,httpStatus:null,discovery:null,checkpoint:null,diagnostic:{},error:null,durationMs:null,recorded:{entered:null,outcome:null}};
}
// Upserts the entry by id into a bounded ring (newest first). Best effort: a failed write never fails the step.
// The same write closes earlier entries that never received a terminal phase (see `interruptedStep`).
async function recordContinuationDiagnostic(env,entry){
 for(let attempt=0;attempt<2;attempt++){
  try{
   const object=await env.BUCKET.get(CONTINUATION_DIAGNOSTICS_KEY),current=object?await object.json():null,closed=[];
   const earlier=(Array.isArray(current?.recent)?current.recent:[]).filter(item=>item?.id!==entry.id).map(item=>{const next=interruptedStep(item,entry.at);if(next!==item)closed.push(next);return next;});
   const recent=[entry,...earlier].slice(0,CONTINUATION_DIAGNOSTICS_LIMIT);
   const saved=await env.BUCKET.put(CONTINUATION_DIAGNOSTICS_KEY,JSON.stringify({schemaVersion:1,updatedAt:entry.at,recent}),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
   if(saved!==null){for(const item of closed)observeContinuation({id:item.id,at:item.at,phase:item.phase,caller:item.caller,route:item.route,runId:item.runId,checkpoint:item.checkpoint??null,interruption:item.interruption});return true;}
  }catch{return false;}
 }
 return false;
}
// A step that is still `entered` or `checkpointed` long after it began has ended without its terminal phase: the
// invocation was killed (for example by the Workers memory limit) or its outcome write was lost. The Worker cannot
// tell which, so the entry is closed as `interrupted` with `cause: unknown`; it is not a proven error. `committed`
// says whether the step's discovery hop had stored its checkpoint before the end: true or false from a
// `checkpointed` entry, null (unknown) from an `entered` one. The platform outcome of the same invocation is found
// in Workers Logs through the step id of its `epg_continuation` lines.
const CONTINUATION_STEP_TERMINAL_MS=15*60000;
function interruptedStep(item,now){
 if(!item||!['entered','checkpointed'].includes(item.phase))return item;
 const began=Date.parse(item.at),at=Date.parse(now);
 if(!Number.isFinite(began)||!Number.isFinite(at)||at-began<CONTINUATION_STEP_TERMINAL_MS)return item;
 return {...item,phase:'interrupted',interruption:{lastPhase:item.phase,committed:item.phase==='checkpointed'?item.checkpoint?.owned===true:null,cause:'unknown',closedAt:diagnosticTime(now)}};
}
// The `entered` log line is the arrival evidence and goes out before any storage access; the ring write
// that follows is best effort and its result is kept in `recorded.entered`.
async function openContinuationStep(env,step,persist){observeContinuation(step);if(persist)step.recorded.entered=await recordContinuationDiagnostic(env,step);return step;}
// The step's discovery hop has stored its checkpoint. The entry records that before the hop's trailing writes (score
// preview, lease release, response), so an invocation that ends after this point is known to have
// committed its chunk although no response reached the caller. Best effort, never throws.
async function markContinuationCheckpoint(env,step,persist,committed){
 try{
  const {record,outcome}=committed,kept=outcome.saved?record:outcome.record;
  step.phase='checkpointed';
  step.checkpoint={hopId:diagnosticId(record?.hopId),owned:outcome.saved===true,write:outcome.saved?'saved':diagnosticCode(['other_hop','write_conflict'],outcome.reason),stage:diagnosticCode(DIAGNOSTIC_VOCABULARY.stage,kept?.stage),remainingChunks:diagnosticCount(kept?.remainingChunks)};
  if(persist)step.recorded.checkpoint=await recordContinuationDiagnostic(env,step);
  observeContinuation(step);
 }catch{}
}
// Outcome fields, then the outcome write, then the final log line carrying both write results.
async function closeContinuationStep(env,step,started,response,error,persist){
 step.durationMs=Date.now()-started;
 if(error){step.phase='failed';step.error=diagnosticError(error);step.httpStatus=step.httpStatus??502;}
 else{step.phase='completed';step.httpStatus=response?.status??step.httpStatus??null;}
 if(persist)step.recorded.outcome=await recordContinuationDiagnostic(env,step);
 observeContinuation(step);
}
function discoveryContract(record,override={}){
 const state=override.state||record?.stage||'idle';
 const reason=override.reason!==undefined?override.reason:record?.reason??null;
 const remainingChunks=override.remainingChunks!==undefined?override.remainingChunks:record?.remainingChunks??0;
 const retryAt=override.retryAt!==undefined?override.retryAt:record?.retryAt??null;
 const catchUpAt=override.nextCatchUpAt!==undefined?override.nextCatchUpAt:record?.nextCatchUpAt??null;
 let nextAction=override.nextAction;
 if(!nextAction){
  if(state==='busy'||reason==='chunk_budget'||reason==='backoff'||state==='error')nextAction='wait';
  else if(state==='complete'||['programme_changed','missing_secret','idle','interrupted'].includes(reason)||remainingChunks<=0)nextAction='stop';
  else nextAction='continue';
 }
 // nextCatchUpAt is the gate a `wait` must honor; nextScheduledRunAt is the first nominal hourly Scheduled Task trigger
 // at or after it, i.e. when the catch-up is expected to happen. Only a `wait` carries it, and it is null when the
 // schedule is unknown: it never shortens or replaces the gate.
 const gate=nextAction==='wait'?(catchUpAt||nextCatchUpAt()):catchUpAt,gateMs=Date.parse(gate||'');
 return {state,remainingChunks,nextAction,reason:reason||null,at:override.at||record?.at||null,nextCatchUpAt:gate,nextScheduledRunAt:nextAction==='wait'?hourlyTaskRunAt(Math.max(Date.now(),Number.isFinite(gateMs)?gateMs:0)):null,retryAt:retryAt||null,programmeRunId:override.programmeRunId!==undefined?override.programmeRunId:record?.programmeRunId??null};
}
function continuationDecision(current,now){
 if(!current)return {run:true,budget:DISCOVERY_CHUNK_BUDGET};
 const due=Date.parse(current.retryAt||current.nextCatchUpAt||0),chunks=Number.isInteger(current.remainingChunks)?current.remainingChunks:0;
 if(current.stage==='complete'||['programme_changed','missing_secret','idle','interrupted'].includes(current.reason))return {run:false,contract:discoveryContract(current,{nextAction:'stop'})};
 if(current.reason==='chunk_budget'||current.reason==='backoff'||current.stage==='error'||current.retryAt){
  if(due>now)return {run:false,contract:discoveryContract(current,{nextAction:'wait',reason:current.reason||(current.stage==='error'?'error':'backoff')})};
  return {run:true,budget:current.reason==='chunk_budget'?DISCOVERY_CHUNK_BUDGET:Math.max(chunks,1)};
 }
 // AIR-154: a running record is resumed with the budget its hop still had. continuationHealth has already
 // settled the record when that hop's chunk finished, so a completed chunk is never counted twice.
 if(current.stage==='running')return {run:true,budget:Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,chunks))};
 if(current.stage==='scheduled')return {run:true,budget:Math.min(DISCOVERY_CHUNK_BUDGET,(Number.isInteger(current.remainingChunks)?current.remainingChunks:DISCOVERY_CHUNK_BUDGET-1)+1)};
 if(current.stage==='paused'&&chunks>0)return {run:true,budget:chunks};
 return {run:false,contract:discoveryContract(current,{nextAction:'stop'})};
}
// AIR-154: continuation reads carry the object etag so that every write below is a compare-and-swap.
// A hop that lost the record (another hop replaced it, or the record moved while this call waited for
// the lease) never overwrites the newer checkpoint.
// `etag` is the precondition for the next write: the object's etag, `null` for a missing object (the write
// then requires absence), or `undefined` when the store returned an object without an etag (no
// precondition is possible, so the write is plain; R2 always supplies one).
async function readContinuation(env){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.readContinuation(env);if(routed.handled)return {record:routed.record,etag:routed.etag};}
 const object=await env.BUCKET.get(CONTINUATION_KEY);return {record:object?await object.json():null,etag:object?(object.etag||undefined):null};
}
async function replaceContinuation(env,record,etag){
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.writeContinuation(env,record,etag);if(routed.handled)return routed.saved===true;}
 const saved=await env.BUCKET.put(CONTINUATION_KEY,JSON.stringify(record),{httpMetadata:{contentType:'application/json'},...(etag===undefined?{}:{onlyIf:etag?{etagMatches:etag}:{etagDoesNotMatch:'*'}})});return saved!==null;
}
// Writes the hop's checkpoint only while the record still names that hop. The result says whether the
// write happened: `saved: false` with `reason: other_hop` when another hop owns the record, or
// `reason: write_conflict` when both conditional writes were rejected; the caller must not report
// an unsaved checkpoint as stored.
async function saveOwnedContinuation(env,hopId,record){
 let current=await readContinuation(env);
 for(let attempt=0;attempt<2;attempt++){
  if(current.record&&current.record.hopId!==hopId)return {saved:false,reason:'other_hop',record:current.record};
  if(await replaceContinuation(env,record,current.etag))return {saved:true,reason:null,record};
  current=await readContinuation(env);
 }
 if(current.record&&current.record.hopId!==hopId)return {saved:false,reason:'other_hop',record:current.record};
 return {saved:false,reason:'write_conflict',record:current.record};
}
// A `running` record is a live writer only while the resolver lease it named is unexpired. Afterwards it
// is an orphan: its hop did not reach its checkpoint. The most likely cause is an interrupted invocation
// (a thrown handler normally leaves an `error` record) between the status write and the checkpoint write,
// which is the very next write; a failure of the checkpoint write itself leaves the same picture, so the
// cause of any one orphan is an inference, not a proven fact. The lease release, the score preview, the
// diagnostics ring and the response all come after the checkpoint, so an end during them
// leaves a settled record, not an orphan. Whether the hop's chunk finished is read from
// the persisted discovery status, and only when that status names the same hop (`hopId`), the same
// programme generation and a start after the record was opened: the status object is shared, so a
// newer status from another hop or an unmarked status must not be attributed to this hop. In that case
// the chunk is simply run again with the budget the hop had; its decisions are idempotent.
// `interruptions` counts the hops of the series that ended before their checkpoint, one after another. A hop resumed
// from such an orphan carries the count in its `running` record; a stored checkpoint drops it. When resuming
// would make it reach DISCOVERY_INTERRUPTION_LIMIT the series fails closed instead (`interrupted`, stop): a chunk
// that kills its invocation every time is not run again by the schedule. Only a new EPG generation or an explicit
// owner-forced resolve starts it again.
const CONTINUATION_HEALTH=['idle','settled','live','orphaned'];
const DISCOVERY_INTERRUPTION_LIMIT=2;
const continuationInterruptions=record=>Number.isInteger(record?.interruptions)&&record.interruptions>0?record.interruptions:0;
function continuationHealth(record,lease,last,now,published){
 const hopId=diagnosticId(record?.hopId);
 if(!record||record.stage!=='running')return {status:record?'settled':'idle',hopId,lease:null,leaseHop:null,leaseExpiresAt:null,chunkCompleted:null,resumeBudget:null,generationConflict:null,interruptions:null};
 const live=!!lease&&lease.expiresAt>now,leaseHop=lease?(lease.id===record.hopId?'same':'other'):null;
 const leaseExpiresAt=Number.isFinite(lease?.expiresAt)&&lease.expiresAt>0?new Date(lease.expiresAt).toISOString():null;
 const generationConflict=!!(published&&record.programmeRunId&&published!==record.programmeRunId);
 const interruptions=continuationInterruptions(record);
 if(live)return {status:'live',hopId,lease:'live',leaseHop,leaseExpiresAt,chunkCompleted:null,resumeBudget:null,generationConflict,interruptions};
 const openedAt=Date.parse(record.at||''),startedAt=Date.parse(last?.startedAt||'');
 const chunkCompleted=typeof last?.finishedAt==='string'&&!!record.hopId&&last.hopId===record.hopId&&!!record.programmeRunId&&last.programmeRunId===record.programmeRunId&&(!published||published===record.programmeRunId)&&Number.isFinite(openedAt)&&Number.isFinite(startedAt)&&startedAt>=openedAt;
 const budget=Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,Number.isInteger(record.remainingChunks)?record.remainingChunks:1));
 return {status:'orphaned',hopId,lease:lease?'expired':'none',leaseHop,leaseExpiresAt,chunkCompleted,resumeBudget:chunkCompleted?budget-1:budget,generationConflict,interruptions,failClosed:!chunkCompleted&&interruptions+1>=DISCOVERY_INTERRUPTION_LIMIT};
}
function healthSummary(health){return {status:diagnosticCode(CONTINUATION_HEALTH,health.status),hopId:health.hopId,lease:diagnosticCode(['live','expired','none'],health.lease),leaseHop:diagnosticCode(['same','other'],health.leaseHop),leaseExpiresAt:diagnosticTime(health.leaseExpiresAt),chunkCompleted:typeof health.chunkCompleted==='boolean'?health.chunkCompleted:null,resumeBudget:diagnosticCount(health.resumeBudget),generationConflict:typeof health.generationConflict==='boolean'?health.generationConflict:null,interruptions:diagnosticCount(health.interruptions)};}
// What the discovery contract says about a running record: wait for a live writer until its lease expires,
// continue (one explicit call settles or resumes it) when the writer is gone, stop when resuming would fail closed.
function runningOverride(health){
 if(health.status==='orphaned'&&health.failClosed)return {state:'running',reason:'interrupted',nextAction:'stop',remainingChunks:health.resumeBudget,nextCatchUpAt:null};
 if(health.status==='live')return {state:'running',reason:'busy',nextAction:'wait',nextCatchUpAt:health.leaseExpiresAt||nextCatchUpAt()};
 if(health.status==='orphaned')return {state:'running',reason:'orphaned',nextAction:'continue',remainingChunks:health.resumeBudget,nextCatchUpAt:null};
 return {};
}
// The checkpoint a hop writes after its chunk, from the chunk result and the budget the hop had.
function continuationAfterChunk(result,budget,hopId,at,programmeRunId){
 if(result.stage==='programme_changed')return {stage:'paused',reason:'programme_changed',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId||null};
 if(result.stage==='awaiting_epg_discovery')return {stage:'paused',reason:'idle',at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:programmeRunId??null};
 if(result.stage==='error')return {stage:'error',reason:result.error||'discovery_failed',at,hopId,remainingChunks:budget,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:programmeRunId??null};
 if(result.stage==='backoff'||result.retryAt&&!result.checked)return {stage:'paused',reason:'backoff',at,hopId,remainingChunks:budget,nextCatchUpAt:result.retryAt||nextCatchUpAt(),retryAt:result.retryAt||null,programmeRunId:result.programmeRunId??programmeRunId??null};
 if(result.retryAt)return {stage:'paused',reason:'backoff',at,hopId,remainingChunks:Math.max(0,budget-1),nextCatchUpAt:result.retryAt,retryAt:result.retryAt,programmeRunId:result.programmeRunId??null};
 if(result.remaining===0&&!(result.cheapRemaining>0)&&!result.error)return {stage:'complete',reason:null,at,hopId,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
 if(budget<=1)return {stage:'paused',reason:'chunk_budget',at,hopId,remainingChunks:0,nextCatchUpAt:nextCatchUpAt(),retryAt:null,programmeRunId:result.programmeRunId??null};
 return {stage:'paused',reason:null,at,hopId,remainingChunks:budget-1,nextCatchUpAt:null,retryAt:null,programmeRunId:result.programmeRunId??null};
}
const busyOutcome=(record,trace,nextCatchUp)=>({stage:'busy',checked:0,remaining:null,discovery:discoveryContract(record,{state:'busy',nextAction:'wait',reason:'busy',nextCatchUpAt:nextCatchUp||nextCatchUpAt()}),diagnostic:trace});
// Opens the discovery series for a committed generation. The record names that generation so that a later
// call can tell a checkpoint of the published generation from one left behind by an earlier generation.
// The write is fenced three ways: a request for a generation that is no longer the published one is
// refused (a commit that paused after its programme write and resumed after a newer publication must
// not roll the newer series back); a stored series of the same generation is kept with its progress (a
// re-entered commit is idempotent, only its `programme_changed` artefact is replaced); a live writer keeps
// its `running` record (its own checkpoint pins the generation it read). The write itself is a
// compare-and-swap against the record read here; a concurrent writer wins. The returned contract is
// always that of the record left in place.
async function queueDiscovery(env,reason,programmeRunId=null){
 const now=Date.now(),record={stage:'paused',reason,at:new Date(now).toISOString(),hopId:null,remainingChunks:DISCOVERY_CHUNK_BUDGET,nextCatchUpAt:null,retryAt:null,programmeRunId:programmeRunId||null};
 const [stored,lease,generation]=await Promise.all([readContinuation(env),loadJSON(env,DISCOVERY_LEASE_KEY),loadJSON(env,EPG_GENERATION_KEY)]);
 const published=generation?.phase==='published'?generation.programmeRunId||null:null,current=stored.record;
 const kept=()=>current?discoveryContract(current,current.stage==='running'?runningOverride(continuationHealth(current,lease,null,now,published)):{}):discoveryContract(record,{nextAction:'continue'});
 if(programmeRunId&&published&&programmeRunId!==published)return kept();
 if(current?.stage==='running'&&lease?.expiresAt>now)return kept();
 if(programmeRunId&&current?.programmeRunId===programmeRunId&&current.reason!=='programme_changed')return kept();
 if(await replaceContinuation(env,record,stored.etag))return discoveryContract(record,{nextAction:'continue'});
 const after=(await readContinuation(env)).record;return after?discoveryContract(after):discoveryContract(record,{nextAction:'continue'});
}
// Whether the stored checkpoint belongs to the published generation. A record pinned to another generation
// (an orphan, a finished or paused series, a programme-changed stop) or a `programme_changed` record of the
// published generation itself (written while the publication was still copying) is superseded by a new
// series for the published generation once that generation is in place: the pointer names it and the shared
// programme already carries it (`recover`). Until the copy has landed nothing is replaced (`pending`). A live
// writer is never superseded, and a record without a generation pin cannot be judged and is left alone.
function generationHandoff(record,health,published,report){
 if(!published||!record||health.status==='live')return null;
 const other=!!record.programmeRunId&&record.programmeRunId!==published,contradictory=record.reason==='programme_changed'&&record.programmeRunId===published;
 if(!other&&!contradictory)return null;
 return report?.runId===published?'recover':'pending';
}
// A paused/interrupted series is a stop for every ordinary step, including the hourly task. This gate is the
// separate owner confirm (`recovery: 'interrupted'`). It reads the stored facts and returns a verdict. It does
// not write, take a lease, or treat `force` as permission. A missing or contradictory checkpoint is
// `owner_investigation`: the caller must not guess.
function interruptedCheckpointProof(record,status,diagnostics){
 if(!status||typeof status!=='object'||Array.isArray(status))return {ok:false,cause:'status_missing'};
 if(typeof status.hopId!=='string'||!status.hopId)return {ok:false,cause:'status_unattributed'};
 if(typeof status.programmeRunId==='string'&&status.programmeRunId&&status.programmeRunId!==record.programmeRunId)return {ok:false,cause:'status_generation'};
 if(status.hopId!==record.hopId)return {ok:false,cause:'status_other_hop'};
 if(typeof status.finishedAt==='string'&&status.finishedAt)return {ok:false,cause:'status_finished'};
 const recent=diagnostics&&typeof diagnostics==='object'&&!Array.isArray(diagnostics)&&Array.isArray(diagnostics.recent)?diagnostics.recent:null;
 if(diagnostics!=null&&recent==null)return {ok:false,cause:'diagnostics_malformed'};
 const claimed=(recent||[]).some(item=>item?.checkpoint?.hopId===record.hopId&&(item?.interruption?.committed===true||item?.phase==='checkpointed'&&item?.checkpoint?.owned===true));
 if(claimed)return {ok:false,cause:'checkpoint_claimed'};
 return {ok:true,proof:status.checkpoint==='cheap_pass'?'cheap_pass':'partial'};
}
function assessInterruptedRecovery({now,epgStage,publishedRunId,programmeRunId,sourceRunId,record,lease,status,diagnostics,authority}){
 const refused=(reason,cause=null)=>({permit:'refused',reason,cause:cause||reason,budget:null,proof:null});
 if(!record||typeof record!=='object'||Array.isArray(record))return refused('owner_investigation','record_malformed');
 if(record.stage!=='paused'||record.reason!=='interrupted')return refused('not_interrupted');
 if(!authority||typeof authority!=='object'||authority.unavailable)return refused('authority_unavailable');
 if(authority.held||authority.cutover==='held')return refused('authority_held');
 if(authority.transfer==='loading')return refused('authority_loading');
 if(authority.mode!=='r2'&&authority.mode!=='d1')return refused('authority_unavailable');
 if(authority.mode==='d1'&&(authority.ready!==true||authority.transfer!=='idle'&&authority.transfer!=='committed'))return refused('authority_unavailable');
 if(epgStage!=='complete')return refused('epg_not_complete');
 const runs=[publishedRunId,programmeRunId,sourceRunId,record.programmeRunId];
 if(runs.some(id=>typeof id!=='string'||!id)||new Set(runs).size!==1)return refused('generation_mismatch');
 if(authority.ready&&authority.programmeRunId!==publishedRunId)return refused('generation_mismatch');
 if(!Number.isInteger(record.remainingChunks))return refused('owner_investigation','budget_malformed');
 if(record.remainingChunks<1)return refused('no_budget');
 if(lease!=null){
  if(typeof lease!=='object'||Array.isArray(lease)||typeof lease.expiresAt!=='number'||!Number.isFinite(lease.expiresAt))return refused('owner_investigation','lease_malformed');
  if(lease.expiresAt>now)return refused('lease_live');
 }
 const future=value=>{const at=Date.parse(value||'');return Number.isFinite(at)&&at>now;};
 if(future(record.retryAt)||future(record.nextCatchUpAt))return refused('backoff');
 const proof=interruptedCheckpointProof(record,status,diagnostics);
 if(!proof.ok)return refused('owner_investigation',proof.cause);
 if(future(status?.retryAt))return refused('backoff');
 return {permit:'eligible',reason:'eligible',cause:null,budget:record.remainingChunks,proof:proof.proof};
}
// The recovery verdict reads the live generation's ledger itself, with the unpinned `env`, and never reuses the pinned
// read a status caller made: the two can differ (a generation published between them, or a D1-published generation
// beside an R2 ledger), and that difference is the `generation_mismatch` refusal. AIR-344 only changed how: the ledger is
// streamed and its items are dropped as they are read, so just its wrapper (the run id) is kept.
async function interruptedRecoveryFacts(env,{now,current,lease,published,programmeRunId}){
 let authority;
 if(typeof DiscoveryAuthority==='undefined')authority={mode:'r2',ready:false,held:false,cutover:null,transfer:'idle'};
 else{try{authority=await DiscoveryAuthority.readAuthority(env);}catch{authority={unavailable:true};}}
 const blocked=!!authority?.unavailable||authority?.transfer==='loading';
 let status=null,sync=null,source=null,diagnostics=null;
 if(!blocked){
  try{
   [status,sync,diagnostics]=await Promise.all([loadJSON(env,'epg/discovery-status.json'),loadJSON(env,'sync.json'),loadJSON(env,CONTINUATION_DIAGNOSTICS_KEY)]);
   source=await loadJSON(env,'epg/discovery-latest.json',{item:()=>null});
  }
  catch{authority={unavailable:true};}
 }
 else{try{sync=await loadJSON(env,'sync.json');}catch{sync=null;}}
 return assessInterruptedRecovery({now,epgStage:sync?.stage??null,publishedRunId:published,programmeRunId,sourceRunId:source?.programmeRunId??null,record:current,lease,status,diagnostics,authority});
}
// `body.trace`, when a caller passes an object, is filled with the branch taken and every intermediate
// outcome (AIR-151). The same object is returned as `diagnostic`. It changes no decision.
async function advanceDiscovery(env,body={}){
 const now=Date.now(),trace=body.trace&&typeof body.trace==='object'?body.trace:{};
 trace.branch=null;trace.entry=null;trace.lease=null;trace.health=null;trace.recovery=null;trace.decision=null;trace.hopId=null;trace.budget=null;trace.chunk=null;trace.saved=null;
 let stored=await readContinuation(env),current=stored.record;
 trace.entry=continuationSummary(current);
 let lease=null,leaseHandled=false;
 if(typeof DiscoveryAuthority!=='undefined'){const routed=await DiscoveryAuthority.readLease(env);leaseHandled=routed.handled;if(routed.handled)lease=routed.lease;}
 if(!leaseHandled){const leaseObject=await env.BUCKET.get(DISCOVERY_LEASE_KEY);lease=leaseObject?await leaseObject.json():null;}
 trace.lease=lease?.expiresAt>now?'live':lease?'expired':'none';
 const running=current?.stage==='running';
 const [last,generation,report]=await Promise.all([running?loadJSON(env,'epg/discovery-status.json'):null,loadJSON(env,EPG_GENERATION_KEY),loadJSON(env,'programme.json')]);
 const published=generation?.phase==='published'?generation.programmeRunId||null:null;
 let health=continuationHealth(current,lease,last,now,published);
 trace.health=healthSummary(health);
 let recoveryBudget=null;
 if(body.recoverInterrupted){
  const verdict=await interruptedRecoveryFacts(env,{now,current,lease,published,programmeRunId:report?.runId??null});
  trace.interruptedRecovery=verdict;
  const stopped=discoveryContract(current,{nextAction:'stop',reason:current?.reason??'interrupted'});
  if(body.chunks===0){trace.branch='recovery_report';return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:stopped,recovery:verdict,diagnostic:trace};}
  if(verdict.permit!=='eligible'){trace.branch='recovery_refused';return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:stopped,recovery:verdict,diagnostic:trace};}
  recoveryBudget=verdict.budget;
 }
 if(body.chunks===0){trace.branch='report_only';return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:discoveryContract(current,runningOverride(health)),diagnostic:trace};}
 if(lease?.expiresAt>now){trace.branch='lease_live';return busyOutcome(current,trace,health.leaseExpiresAt);}
 // Generation handoff: a checkpoint that does not belong to the published generation is superseded by a new
 // series for that generation (the checkpoint the commit would have queued), atomically against the record
 // read above. The superseded record's hop is never resumed and its decisions and statuses stay as written.
 const handoff=generationHandoff(current,health,published,report);
 if(handoff==='pending'){
  trace.branch='generation_pending';
  trace.recovery={orphanHopId:health.hopId,action:'generation_pending',chunkCompleted:health.chunkCompleted,budget:0,settled:false,superseded:diagnosticId(current.programmeRunId)};
  return {stage:current.stage,checked:0,remaining:null,discovery:discoveryContract(current,{state:current.stage==='running'?'running':current.stage,nextAction:'wait',nextCatchUpAt:nextCatchUpAt()}),diagnostic:trace};
 }
 if(handoff==='recover'){
  trace.branch='generation_handoff';
  const record={stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:DISCOVERY_CHUNK_BUDGET,nextCatchUpAt:null,retryAt:null,programmeRunId:published};
  const replaced=await replaceContinuation(env,record,stored.etag);
  trace.recovery={orphanHopId:health.hopId,action:'generation_recovered',chunkCompleted:health.chunkCompleted,budget:DISCOVERY_CHUNK_BUDGET,settled:replaced,superseded:diagnosticId(current.programmeRunId)};
  if(!replaced){trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
  trace.saved={...continuationSummary(record),owned:true,write:'saved'};
  stored=await readContinuation(env);current=stored.record;health=continuationHealth(current,lease,null,now,published);
 }
 if(health.status==='orphaned'){
  // AIR-154: settle the orphan atomically against the record we read; a concurrent writer wins and we wait.
  const at=new Date().toISOString(),budget=Math.min(DISCOVERY_CHUNK_BUDGET,Math.max(1,Number.isInteger(current.remainingChunks)?current.remainingChunks:1));
  if(health.chunkCompleted){
   const record=continuationAfterChunk(last.programmeChanged?{...last,stage:'programme_changed'}:last,budget,current.hopId,at,current.programmeRunId);
   const settled=await replaceContinuation(env,record,stored.etag);
   trace.recovery={orphanHopId:health.hopId,action:'settled',chunkCompleted:true,budget:health.resumeBudget,settled};
   if(!settled){trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
   trace.saved={...continuationSummary(record),owned:true,write:'saved'};
   stored=await readContinuation(env);current=stored.record;
  }
  else if(health.failClosed){
   // The orphan's hop ended before its checkpoint, and so did the hop it was itself resumed from: fail closed.
   // The record keeps the budget, the generation and the count. `interrupted` is a stop for every ordinary step
   // until the next EPG commit opens a new series, the owner forces a resolve, or the separate interrupted-recovery
   // confirm passes. Nothing is run and no lease is taken.
   const interruptions=health.interruptions+1,record={stage:'paused',reason:'interrupted',at,hopId:current.hopId,remainingChunks:budget,nextCatchUpAt:null,retryAt:null,programmeRunId:current.programmeRunId??null,interruptions};
   const settled=await replaceContinuation(env,record,stored.etag);
   trace.recovery={orphanHopId:health.hopId,action:'interrupted',chunkCompleted:false,budget:0,settled,interruptions};
   if(!settled){trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
   trace.branch='interrupted';trace.saved={...continuationSummary(record),owned:true,write:'saved'};
   return {stage:'paused',checked:0,remaining:null,discovery:discoveryContract(record),diagnostic:trace};
  }
  else trace.recovery={orphanHopId:health.hopId,action:'resumed',chunkCompleted:false,budget:health.resumeBudget,settled:false,interruptions:health.interruptions+1};
 }
 const decision=recoveryBudget!=null?{run:true,budget:recoveryBudget}:continuationDecision(current,now);
 const hardWait=current&&(['chunk_budget','backoff'].includes(current.reason)||current.stage==='error'||current.retryAt)&&Date.parse(current.retryAt||current.nextCatchUpAt||0)>now;
 trace.decision={run:decision.run,budget:decision.run?decision.budget:null,force:!!body.force,hardWait:!!hardWait,nextAction:decision.run?null:decision.contract?.nextAction??null,...(recoveryBudget!=null?{recovery:true}:{})};
 if(!decision.run&&(!body.force||hardWait)){trace.branch=trace.recovery?.settled&&trace.recovery.action==='settled'?'orphan_settled':'contract';return {stage:decision.contract.state,checked:0,remaining:null,discovery:decision.contract,diagnostic:trace};}
 if(recoveryBudget!=null&&!env.TMDB_API_READ_ACCESS_TOKEN){
  trace.branch='recovery_refused';
  const verdict={permit:'refused',reason:'missing_secret',cause:'missing_secret',budget:null,proof:null};
  trace.interruptedRecovery=verdict;
  return {stage:current?.stage||'idle',checked:0,remaining:null,discovery:discoveryContract(current,{nextAction:'stop'}),recovery:verdict,diagnostic:trace};
 }
 if(recoveryBudget!=null&&body.onPersist)await body.onPersist();
 if(!env.TMDB_API_READ_ACCESS_TOKEN){
  trace.branch='missing_secret';
  const record={stage:'error',reason:'missing_secret',at:new Date().toISOString(),hopId:null,remainingChunks:0,nextCatchUpAt:null,retryAt:null,programmeRunId:current?.programmeRunId??null};
  await saveJSON(env,CONTINUATION_KEY,record);trace.saved={...continuationSummary(record),owned:true};return {stage:'missing_secret',checked:0,remaining:null,discovery:discoveryContract(record,{nextAction:'stop'}),diagnostic:trace};
 }
 const takenLease=await takeDiscoveryLease(env),acquired=takenLease.lease;
 if(!acquired){
  // ADR 0103: a projector window is a busy with its own absolute deadline, so the series waits for it instead of the hourly gate.
  if(takenLease.busy?.kind==='projector_window'&&Number.isFinite(takenLease.busy.expiresAt)){trace.branch='projector_window';return busyOutcome(current,trace,new Date(takenLease.busy.expiresAt).toISOString());}
  trace.branch='lease_lost';return busyOutcome(current,trace);
 }
 // AIR-154 fence: the decision was made on the record read before the lease; another hop may have moved
 // it meanwhile. A changed record is not ours to continue from, so the lease is released and we wait.
 const fresh=await readContinuation(env);
 if(fresh.etag!==stored.etag){await releaseDiscoveryLease(env,acquired);trace.branch='record_changed';trace.saved={...continuationSummary(fresh.record),owned:false,write:'other_hop'};return busyOutcome(fresh.record,trace);}
 const hopId=acquired.id,budget=decision.run?decision.budget:DISCOVERY_CHUNK_BUDGET;
 trace.branch='chunk';trace.hopId=hopId;trace.budget=budget;
 // The running record names the generation the chunk will pin to, so a later orphan check can match it.
 const programmeRunId=current?.programmeRunId??published??null;
 // A hop resumed from an orphan that never reached its checkpoint carries the interruption count forward.
 // An interrupted-recovery hop starts one below the fail-closed limit, so a death before its checkpoint
 // stops the series again instead of becoming an automatic resume.
 const interruptions=recoveryBudget!=null?DISCOVERY_INTERRUPTION_LIMIT-1:trace.recovery?.action==='resumed'?trace.recovery.interruptions:0;
 const recoveryPermit=recoveryBudget!=null?{kind:'interrupted',at:new Date().toISOString(),fromHopId:diagnosticId(current?.hopId)}:null;
 const opened=await replaceContinuation(env,{stage:'running',reason:null,at:new Date().toISOString(),hopId,remainingChunks:budget,nextCatchUpAt:null,retryAt:null,programmeRunId,...(interruptions?{interruptions}:{}),...(recoveryPermit?{recoveryPermit}:{})},fresh.etag);
 if(!opened){await releaseDiscoveryLease(env,acquired);trace.branch='record_changed';const after=(await readContinuation(env)).record;trace.saved={...continuationSummary(after),owned:false,write:'other_hop'};return busyOutcome(after,trace);}
 // The hop's checkpoint is the first durable write after its hop-marked status: the chunk calls `checkpoint`
 // right after saving that status, before the score preview, the lease release and the
 // diagnostics ring. An invocation that ends during those trailing writes, or whose response is lost on the way
 // to the client, therefore leaves a settled record rather than an orphan; the orphan settle remains the repair
 // for an end between the status write and the checkpoint write. A failure after the checkpoint is a trailing
 // failure: the step stays committed and the error is classified in `trailingError`. The lease is released after
 // the checkpoint; a failed release cannot undo it and only makes the next hop wait until the lease expires.
 let result,committed=null;trace.leaseReleased=null;trace.trailingError=null;
 const checkpoint=async summary=>{const record=continuationAfterChunk(summary,budget,hopId,new Date().toISOString(),programmeRunId);committed={summary,record,outcome:await saveOwnedContinuation(env,hopId,record)};if(body.onCheckpoint)await body.onCheckpoint(committed);};
 const release=async()=>{try{await releaseDiscoveryLease(env,acquired);trace.leaseReleased=true;}catch{trace.leaseReleased=false;}};
 try{
  result=report?.films?await resolveDiscoveryChunk(env,report,body.limit||24,acquired,checkpoint,now):{stage:'awaiting_epg_discovery',checked:0,remaining:null};
 }catch(e){
  if(committed){result=committed.summary;trace.trailingError=diagnosticErrorCode(e);}
  else result={stage:'error',error:String(e.message).slice(0,120),checked:0,remaining:null,...(e?.name==='LeaseLostError'?{timings:e.timings||null}:{})};
 }
 trace.chunk=chunkSummary(result);
 if(!committed){try{await checkpoint(result);}catch(e){await release();throw e;}}
 await release();
 const {record,outcome}=committed,kept=outcome.saved?record:outcome.record;
 trace.saved={...continuationSummary(kept),owned:outcome.saved,write:outcome.saved?'saved':outcome.reason};
 // An unsaved checkpoint of a record that still names this hop is an orphan the next call settles from the
 // hop-marked status; the contract says so instead of claiming the checkpoint was stored.
 const contract=outcome.saved?discoveryContract(record):kept?.stage==='running'&&kept.hopId===hopId?discoveryContract(kept,{state:'running',reason:'orphaned',nextAction:'continue',remainingChunks:Math.max(0,budget-1),nextCatchUpAt:null}):discoveryContract(kept);
 return {...result,discovery:contract,...(trace.interruptedRecovery?{recovery:trace.interruptedRecovery}:{}),diagnostic:trace};
}
// Workflow mode never rewrites the continuation record into `delegated`. The stored contract stays what the
// Workflow reads; only the HTTP body tells an external client to stop driving chunks.
function delegatedContract(contract,workflow){
 const overlaid=discoveryContract(null,{state:contract?.state,remainingChunks:contract?.remainingChunks,nextAction:'wait',reason:'delegated',at:contract?.at,nextCatchUpAt:contract?.nextCatchUpAt,retryAt:contract?.retryAt,programmeRunId:contract?.programmeRunId});
 return {...overlaid,delegated:true,executor:'workflow',workflow:workflow||null};
}
async function noteDiscoveryWorkflow(env){
 if(discoveryExecutorMode(env)!=='workflow')return {started:false,reason:discoveryExecutorMode(env)==='invalid'?'invalid':'external'};
 if(typeof ensureDiscoveryWorkflow!=='function')return {started:false,reason:'workflow_unavailable'};
 try{return await ensureDiscoveryWorkflow(env);}catch{return {started:false,reason:'start_uncertain',uncertain:true};}
}
async function presentQueuedDiscovery(env,discovery){
 const mode=discoveryExecutorMode(env);
 if(mode==='external')return {discovery};
 if(mode!=='workflow')return {discovery,executor:'invalid',delegated:false};
 if(discovery?.nextAction==='stop')return {discovery,executor:'workflow',delegated:false};
 const workflow=await noteDiscoveryWorkflow(env);
 return {discovery:delegatedContract(discovery,workflow),executor:'workflow',delegated:true,workflow};
}
async function presentContinuationDiscovery(env){
 const now=Date.now(),stored=await readContinuation(env),current=stored.record;
 const lease=await loadJSON(env,'epg/resolver-lease.json');
 const generation=await loadJSON(env,EPG_GENERATION_KEY);
 const published=generation?.phase==='published'?generation.programmeRunId||null:null;
 const last=current?.stage==='running'?await loadJSON(env,'epg/discovery-status.json'):null;
 const health=continuationHealth(current,lease,last,now,published);
 const contract=discoveryContract(current,current?.stage==='running'?runningOverride(health):{});
 if(contract.nextAction==='stop')return {discovery:{...contract,delegated:false,executor:'workflow'},executor:'workflow',delegated:false,workflow:null};
 const workflow=await noteDiscoveryWorkflow(env);
 return {discovery:delegatedContract(contract,workflow),executor:'workflow',delegated:true,workflow};
}
// `options.workflow` (the record, or null for none) is the Workflow state the caller already holds as part of a consistent snapshot; without it the state is
// read here. Only the platform liveness of that record's instance is observed anew.
async function discoveryExecutorReadout(env,continuation,options={}){
 const configured=discoveryExecutorMode(env);
 const now=Date.now();
 let stored=null;
 if(Object.hasOwn(options,'workflow'))stored=options.workflow;
 else if(typeof readWorkflowState==='function'){try{stored=(await readWorkflowState(env)).record;}catch{stored={phase:'unknown'};}}
 let liveness=null;
 if(stored?.instanceId&&typeof workflowInstanceStatus==='function'&&typeof env?.DISCOVERY_WORKFLOW?.get==='function')liveness=await workflowInstanceStatus(env.DISCOVERY_WORKFLOW,stored.instanceId);
 const facts=typeof workflowReadoutFacts==='function'?workflowReadoutFacts(stored,liveness,now):{active:!!stored&&['starting','running','waiting','uncertain'].includes(stored?.phase),stalled:false,alive:false,dead:false,recoveryDue:stored?.recovery?.dueAt||null,recoveryWaiting:false,quarantined:false,updatedAt:stored?.updatedAt||null};
 const decision=continuation?continuationDecision(continuation,now):null;
 const pending=!!(continuation&&(continuation.remainingChunks>0||continuation.reason==='chunk_budget'||continuation.stage==='running'));
 const terminal=stored?.phase==='stopped'&&['complete','backlog_empty','stale_generation','executor_not_workflow'].includes(stored.reason);
 const stoppedWithBacklog=stored?.phase==='stopped'&&pending&&!terminal;
 let owner='none';
 if(configured==='invalid')owner='invalid';
 else if(facts.dead)owner='none';
 else if(liveness==='unknown')owner='unknown';
 else if(facts.alive&&facts.active)owner='workflow';
 else if(facts.active&&!facts.stalled&&liveness==null)owner='workflow';
 const degraded=configured==='invalid'||stored?.phase==='uncertain'||stored?.phase==='unknown'||liveness==='unknown'||!!facts.stalled||stoppedWithBacklog||!!facts.recoveryWaiting||!!facts.quarantined||!!(facts.dead&&pending);
 return {configured,owner,programmeRunId:stored?.programmeRunId||continuation?.programmeRunId||null,instanceId:stored?.instanceId||null,series:Number.isInteger(stored?.series)?stored.series:null,phase:stored?.phase||null,waitingUntil:stored?.waitingUntil||null,waitingReason:stored?.reason||null,lastProgress:stored?.lastProgress||null,chunks:Number.isInteger(stored?.chunksThisInstance)?stored.chunksThisInstance:null,recovery:stored?.recovery||null,pending,eligible:!!decision?.run||continuation?.reason==='chunk_budget',degraded,stalled:!!facts.stalled,recoveryDue:facts.recoveryDue||null,liveness,updatedAt:facts.updatedAt||null,budget:typeof discoveryWorkflowChunkLimit==='function'?{externalSeries:discoveryChunkBudget(),instanceChunkLimit:discoveryWorkflowChunkLimit()}:null};
}
async function resolveDiscoveryRequest(env,execution,body,caller='http'){
 const started=Date.now(),step=continuationStep(caller,'/api/enrichment/discovery/resolve',null);
 // A recovery report or refusal must not write the diagnostics ring. The ring is stored only once a confirm
 // has passed the gate and is about to take the lease.
 const recoveryRequested=body?.recovery==='interrupted';
 let persistStep=!recoveryRequested;
 await openContinuationStep(env,step,persistStep);
 let response;
 try{
  if(body.limit!==undefined&&(!Number.isInteger(body.limit)||body.limit<1||body.limit>24)){step.branch='invalid_limit';response=json({error:'Invalid limit'},400);}
  else if(body.recovery!==undefined&&body.recovery!=='interrupted'){step.branch='invalid_recovery';response=json({error:'Invalid recovery'},400);}
  else if(body.recovery==='interrupted'&&body.chunks!==undefined&&body.chunks!==0){step.branch='invalid_recovery';response=json({error:'Invalid recovery'},400);}
  else{
   const report=await loadJSON(env,'programme.json');
   const executor=discoveryExecutorMode(env);
   const recovery=body.recovery==='interrupted';
   let authority=null;
   if(recovery&&typeof DiscoveryAuthority!=='undefined'){try{authority=await DiscoveryAuthority.readAuthority(env);}catch{authority={unavailable:true};}}
   const authorityCause=authority?.unavailable?'authority_unavailable':authority?.transfer==='loading'?'authority_loading':authority?.held||authority?.cutover==='held'?'authority_held':null;
   if(!report?.films){step.branch='no_programme';response=json({error:'No programme'},409);}
   else if(executor==='invalid'){step.branch='executor_invalid';response=json({error:'discovery_executor_invalid',executor:'invalid'},503);}
   else if(recovery&&executor==='workflow'){step.branch='recovery_refused';response=json({recovery:{permit:'refused',reason:'owner_investigation',cause:'executor_workflow',budget:null,proof:null},discovery:{state:'paused',nextAction:'stop',reason:'interrupted',remainingChunks:null},diagnostic:step.diagnostic});}
   else if(recovery&&authorityCause){step.branch='recovery_refused';response=json({recovery:{permit:'refused',reason:authorityCause,cause:authorityCause,budget:null,proof:null},discovery:{state:'paused',nextAction:'stop',reason:'interrupted',remainingChunks:null},diagnostic:step.diagnostic});}
   else if(executor==='workflow'){step.branch='delegated';const presented=await presentContinuationDiscovery(env);step.discovery=discoverySummary(presented.discovery);response=json({...presented,diagnostic:step.diagnostic});}
   else{step.branch='resolve';const outcome=await advanceDiscovery(env,{...body,force:recovery?false:body.chunks!==0,recoverInterrupted:recovery,trace:step.diagnostic,onPersist:async()=>{if(persistStep)return;persistStep=true;step.recorded.entered=await recordContinuationDiagnostic(env,step);},onCheckpoint:committed=>markContinuationCheckpoint(env,step,persistStep,committed)});step.discovery=discoverySummary(outcome.discovery);response=json(outcome);}
  }
 }catch(e){await closeContinuationStep(env,step,started,null,e,persistStep);throw e;}
 await closeContinuationStep(env,step,started,response,null,persistStep);
 return response;
}
// The first catalog entry, in insertion order, whose id is `id`: Object.values(catalog).find without copying the catalog.
function catalogFilmById(catalog,id){
 for(const key in catalog||{}){const film=catalog[key];if(String(film?.id)===id)return film;}
 return undefined;
}
// AIR-430. The operational status of Discovery: what an operator or a monitor needs while writers commit continuously. It reads only the small
// authoritative records (one consistent D1 snapshot of the authority row, status, continuation, workflow, lease and projector window; the same
// small R2 objects outside D1 authority), never the ledger, the decisions or the catalog, never TMDB, and it writes nothing. The backlog is only
// what the last checkpoints stored, each fact with its own time, source and programme generation (`known`, `stale` once older than OPERATIONAL_STALE_MS,
// `foreign` when it belongs to another programme, `unknown` without a time); no exact figure is computed. A record that cannot be read is named in `unavailable`; it is never filled from another source. The detailed view
// (`discoveryPipelineStatus`) keeps its snapshot fence and may be refused with `discovery_fence` while Discovery commits.
const OPERATIONAL_STALE_MS=3*3600000;
const operationalNumber=value=>Number.isFinite(value)&&value>=0?value:null;
async function discoveryOperationalStatus(env){
 const now=Date.now(),unavailable=[];
 let snapshot=null,records,authority;
 if(typeof DiscoveryAuthority!=='undefined'){
  try{snapshot=await DiscoveryAuthority.readOperationalSnapshot(env);}
  catch(error){unavailable.push('authority');authority={state:'unavailable',cause:diagnosticErrorCode(error)};}
 }
 let source;
 if(snapshot?.handled){
  source='d1_snapshot';authority=snapshot.authority;records=snapshot.records||{status:null,continuation:null,workflow:null,lease:null,window:null};
  for(const name of snapshot.unreadable||[])unavailable.push(name);
  if(authority.state==='held')unavailable.push('records');
 }else if(authority?.state==='unavailable'){
  source='none';records={status:null,continuation:null,workflow:null,lease:null,window:null};
 }else{
  // Outside D1 authority the same records are small R2 objects, each read on its own; one that fails is named, not guessed.
  source='r2_objects';authority={state:'r2',mode:'r2',cutover:null,transfer:null,generation:null,programmeRunId:null,publishedProgrammeRunId:null};
  const read=async(name,key)=>{try{return await loadJSON(env,key);}catch{unavailable.push(name);return null;}};
  const [status,continuation,workflow,lease,generation]=await Promise.all([read('status','epg/discovery-status.json'),read('continuation','epg/resolver-continuation.json'),read('workflow','epg/discovery-workflow.json'),read('lease',DISCOVERY_LEASE_KEY),read('generation',EPG_GENERATION_KEY)]);
  records={status,continuation,workflow,lease,window:null};
  authority.publishedProgrammeRunId=generation?.phase==='published'?generation.programmeRunId||null:null;
 }
 const continuation=records.continuation,last=records.status,published=authority.publishedProgrammeRunId||null;
 const health=healthSummary(continuationHealth(continuation,records.lease,last,now,published));
 const running=continuation?.stage==='running';
 const contract=discoveryContract(continuation,running?runningOverride(continuationHealth(continuation,records.lease,last,now,published)):{});
 // The backlog is two stored facts, each with its own time and programme generation, never one figure with the newest of the two times: the
 // chunk budget the continuation holds, and the ledger counts the last chunk stored. A fact of another programme than the published (or current) one is
 // `foreign` and its values are withheld; one without a time is `unknown`; one older than OPERATIONAL_STALE_MS is `stale` and keeps its own time.
 const current=published||authority.programmeRunId||continuation?.programmeRunId||null;
 const fact=(record,at,values)=>{
  const observed=Date.parse(at||''),run=record?.programmeRunId||null;
  if(!record)return {state:'unknown',source:null,observedAt:null,ageMs:null,programmeRunId:null,...Object.fromEntries(Object.keys(values).map(key=>[key,null]))};
  const base={source:null,observedAt:Number.isFinite(observed)?new Date(observed).toISOString():null,ageMs:Number.isFinite(observed)?Math.max(0,now-observed):null,programmeRunId:run};
  const blank=Object.fromEntries(Object.keys(values).map(key=>[key,null]));
  if(current&&run&&run!==current)return {state:'foreign',...base,...blank};
  if(!Number.isFinite(observed)||!Object.values(values).some(value=>value!==null))return {state:'unknown',...base,...blank};
  return {state:now-observed>OPERATIONAL_STALE_MS?'stale':'known',...base,...values};
 };
 const backlog={
  chunks:{...fact(continuation,continuation?.at,{remainingChunks:operationalNumber(continuation?.remainingChunks)}),source:'continuation'},
  ledger:{...fact(last,last?.finishedAt||null,{remaining:operationalNumber(last?.remaining),cheapRemaining:operationalNumber(last?.cheapRemaining)}),source:'status'},
 };
 let executor={configured:discoveryExecutorMode(env)};
 // The executor facts come from the Workflow record of the same snapshot; only the platform liveness of that instance is observed now, and says so.
 if(executor.configured!=='external'){try{executor=await discoveryExecutorReadout(env,continuation,{workflow:records.workflow});executor={...executor,workflowSource:'snapshot'};if(executor.liveness!=null)executor.livenessObserved={at:new Date(now).toISOString(),source:'workflow_binding',atomicWithSnapshot:false};}catch{executor={configured:executor.configured,owner:'unknown',degraded:true};unavailable.push('executor');}}
 const window=records.window&&records.window.expiresAt>now&&records.window.state!=='idle'?{state:records.window.state,expiresAt:new Date(records.window.expiresAt).toISOString()}:{state:'idle',expiresAt:null};
 return {view:'operational',schemaVersion:1,observedAt:new Date(now).toISOString(),source,authority:{state:authority.state,mode:authority.mode??null,cutover:authority.cutover??null,transfer:authority.transfer??null,generation:authority.generation??null,cause:authority.cause||null},
  programmeRunId:published||continuation?.programmeRunId||null,publishedProgrammeRunId:published,projectorWindow:window,
  discovery:{state:contract.state,reason:contract.reason,nextAction:contract.nextAction,remainingChunks:contract.remainingChunks,nextCatchUpAt:contract.nextCatchUpAt,retryAt:contract.retryAt},
  continuationHealth:health,lease:records.lease?{liveUntil:Number.isFinite(records.lease.expiresAt)&&records.lease.expiresAt>0?new Date(records.lease.expiresAt).toISOString():null,live:records.lease.expiresAt>now}:null,
  lastCheckpoint:continuation?{stage:continuation.stage||null,reason:continuation.reason??null,at:continuation.at||null,programmeRunId:continuation.programmeRunId||null}:null,
  lastChunk:last?{stage:typeof last.stage==='string'?last.stage.slice(0,40):null,checked:operationalNumber(last.checked),remaining:operationalNumber(last.remaining),finishedAt:typeof last.finishedAt==='string'?last.finishedAt:null}:null,
  backlog,executor,unavailable:[...new Set(unavailable)],
  detailed:{view:'detailed',note:'The detailed view reads the whole ledger under a snapshot fence and can be refused with discovery_fence while Discovery commits; that is not a failure of Discovery.'}};
}
async function discoveryPipelineStatus(env){
 const pinned=await pinEpg(env);
 // AIR-344: the small records are read together; the decisions, the ledger and the catalog one after another, and the
 // ledger is streamed and counted without keeping its items, so no two large documents are held at once.
 const [last,queue,continuation,persistedQueue,scorePreview,continuationDiagnostics,lease]=await Promise.all([loadJSON(pinned,'epg/discovery-status.json'),queueStatus(env),loadJSON(pinned,'epg/resolver-continuation.json'),loadJSON(pinned,predictionQueueKey),loadJSON(env,DISCOVERY_SCORE_PREVIEW_KEY),loadJSON(env,CONTINUATION_DIAGNOSTICS_KEY),loadJSON(env,DISCOVERY_LEASE_KEY)]);
 const authority=typeof DiscoveryAuthority!=='undefined'?await DiscoveryAuthority.readAuthority(env):null;
 const decisionsMap=authority?.ready?{}:await loadJSON(pinned,'epg/discovery-resolution.json')||{};
 const {source,counts,statuses,confirmed}=await ledgerStatusAggregates(pinned,decisionsMap,Date.now());
 const catalog=await loadJSON(pinned,'epg/discovered-films.json');
 // AIR-154: the raw record cannot tell a live writer from an orphan; the derived health can.
 const continuationHealthReport=healthSummary(continuationHealth(continuation,lease,last,Date.now(),pinned.epgPin?.programmeRunId||null));
 let interruptedRecovery=null;
 if(continuation?.reason==='interrupted'){
  try{interruptedRecovery=await interruptedRecoveryFacts(env,{now:Date.now(),current:continuation,lease,published:pinned.epgPin?.programmeRunId||null,programmeRunId:(await loadJSON(env,'programme.json'))?.runId??null});}
  catch{interruptedRecovery={permit:'refused',reason:'owner_investigation',cause:'unreadable',budget:null,proof:null};}
 }
 const pipeline={schemaVersion:2,programmeRunId:source?.programmeRunId||null,updatedAt:source?.updatedAt||null,candidates:counts.ledgerTotal,rawCandidates:counts.ledgerTotal,latestRawCandidates:source?.rawCandidates??null,latestFilteredNonMovies:source?.filteredNonMovies??null,filteredNonMovies:counts.rejectedNonfilm,checked:Object.values(statuses).reduce((a,b)=>a+b,0),pending:counts.currentUnresolved,unresolved:counts.currentUnresolved,ready:counts.readyNow,...counts,confirmedFilms:confirmed.size,verifiedFilms:Object.keys(catalog||{}).length,hot:queue?.hotCount??0,cold:queue?.coldCount??0,queuedForPrediction:queue?.pendingCount??0,hotQueuedForPrediction:queue?.priorityCount??0,predicted:queue?.hotPredicted??0,coldWithoutPrediction:queue?.coldWithoutPrediction??0,nextHotPredictions:(persistedQueue?.pending||[]).slice(0,persistedQueue?.priorityCount||0).slice(0,5).map(id=>{const f=catalogFilmById(catalog,id);return {filmId:id,title:f?.title||null,tmdbId:f?.tmdbId||null,hot:f?filmIsHot(f):null,discoveredAt:f?.discoveredAt||null};}),statuses,scoringPreview:scorePreviewSummary(scorePreview,pinned.epgPin?.programmeRunId||source?.programmeRunId||null),lastBatch:last||null,continuation:continuation||null,continuationHealth:continuationHealthReport,continuationDiagnostics:continuationDiagnostics||null};
 if(interruptedRecovery)pipeline.interruptedRecovery=interruptedRecovery;
 if(discoveryExecutorMode(env)!=='external')pipeline.discoveryExecutor=await discoveryExecutorReadout(env,continuation);
 return pipeline;
}
