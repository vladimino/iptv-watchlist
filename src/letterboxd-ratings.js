// The Letterboxd ratings run (ADR 0060): Diary history and its rating facts, then the removal queue, in a run of its own
// with a leased, checkpointed run record, driven by ratings_sync_start / ratings_sync_step. Only the run record is owned
// (compare-and-swap while `lease.step` is the step's own id); the Diary cursor, history, facts, queue and events change
// by their monotone merges, so a step that outlived its lease can add real progress and never move anything back.
// The pipeline is permanently separate (ADR 0074). It acts once ratings_storage_migrate has migrated the queue and the
// Diary cursor; until then start and step answer not_migrated and write nothing. The RATINGS_PIPELINE binding is ignored.
// LETTERBOXD_DIARY_HISTORY is retired and unread (ADR 0075). A migrated run always starts in the Diary phase.
// REMOVAL_RATING_LOOKUP is retired and unread (ADR 0077). A film the Diary did not rate stays eligible for the
// bounded member-page lookup unless a stored fact already holds a confirmed rating and the current Diary page did
// not list that film. A film the page lists without a rating is still looked up. The binding does not skip the
// lookup. A null or absent rating is not watched. A new reference that reopens an entry does not by itself request.
// ratings_sync_status is a read and never writes. Contract: docs/reference/integrations/letterboxd-ratings.md.
// Concatenated into the Worker like the other server modules: one global, no exports.
const LetterboxdRatings=(()=>{
 const KEYS={run:'letterboxd/ratings/run.json',migration:'letterboxd/ratings/migration.json'};
 const CONTRACT_VERSION=1,RUN_SCHEMA_VERSION=1;
 const LEASE_MS=3*60000,LEASE_MARGIN_MS=45000,ABANDONED_MS=30*60000;
 const STEP_LOOKUPS=5,SETTLE_PER_STEP=100,RECENT=10;
 const MIGRATION_WRITER={runId:'ratings-storage-migrate',step:'migrate'};
 const DIARY_ERRORS=['failed','blocked','rate_limited'];
 const iso=ms=>new Date(ms).toISOString();
 const clone=value=>JSON.parse(JSON.stringify(value));
 class LeaseLost extends Error{constructor(){super('Ratings step lease lost');}}
 async function read(env,key){const object=await env.BUCKET.get(key);return {object,value:object?await object.json():null};}
 const put=(env,key,object,value)=>env.BUCKET.put(key,JSON.stringify(value),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});

 // Migration state from the two objects and the durable witness `letterboxd/ratings/migration.json`, which
 // ratings_storage_migrate writes after each object it has converted. A witnessed object found back at version 1 is
 // `regressed`, even after a restart, without the status writing anything.
 async function migrationState(env){
  const [queue,cursor,witness]=await Promise.all([read(env,REMOVAL_LOOKUP_KEY),read(env,LetterboxdDiary.KEYS.state),read(env,KEYS.migration)]);
  const queueV2=removalQueueV2(queue.value),cursorV2=LetterboxdDiary.cursorMigrated(cursor.value),w=witness.value;
  const regressed=[...(w?.queue?.migratedAt&&!queueV2?['queue']:[]),...(w?.cursor?.migratedAt&&!cursorV2?['cursor']:[])];
  const migration=regressed.length?'regressed':queueV2&&cursorV2?'complete':queueV2||cursorV2?'partial':'none';
  return {migration,regressed,queueV2,cursorV2,queue:queue.value,cursor:cursor.value,witness:w};
 }
 const pipelineOf=(migration,run)=>migration!=='complete'?'blocked':run?.isolation?'isolated':run?.state==='running'?'running':'idle';
 async function separateActive(env){return (await migrationState(env)).migration==='complete';}

 const leaseLive=(run,now)=>!!run?.lease?.step&&Date.parse(run.lease.expiresAt)>now;
 // A running record is stale when an active step's lease has expired (`interrupted`) or no step has begun or ended for
 // 30 minutes (`abandoned`). Only a start or a step closes it; the status only reports it.
 function staleness(run,now){
  if(run?.state!=='running')return null;
  if(run.lease?.step)return Date.parse(run.lease.expiresAt)>now?null:'interrupted';
  return now-Date.parse(run.updatedAt||run.startedAt)>ABANDONED_MS?'abandoned':null;
 }
 // An absent legacyPagesLinked is zero: a run recorded before this field still matches a new run that linked no page.
 // Zero does not match one. Every other checkpoint field still treats absence as null, not as zero.
 const checkpointValue=(checkpoint,key)=>key==='legacyPagesLinked'?(checkpoint?.[key]??0):(checkpoint?.[key]??null);
 const sameCheckpoint=(a,b)=>!!a&&!!b&&['diaryPagesRead','diaryNextPage','diaryMode','removalChecked','legacyPagesLinked'].every(key=>checkpointValue(a,key)===checkpointValue(b,key));
 const summaryOf=run=>({runId:run.runId,trigger:run.trigger,state:run.state,outcome:run.outcome??null,cause:run.cause??null,interruptedPhase:run.interruptedPhase??null,startedAt:run.startedAt,endedAt:run.finishedAt||run.closedAt||null,checkpoint:clone(run.checkpoint||{})});
 const withRecent=run=>({...run,recent:[summaryOf(run),...(run.recent||[])].slice(0,RECENT)});
 // Closed as `unknown`, never resumed. Two consecutive interrupted runs that died in the same phase at the same
 // checkpoint isolate the pipeline: starts answer `isolated` until an owner-approved manual start clears it.
 function closeStale(run,cause,now){
  const at=iso(now),previous=(run.recent||[])[0];
  const isolation=cause==='interrupted'&&previous?.cause==='interrupted'&&previous.interruptedPhase===run.phase&&sameCheckpoint(previous.checkpoint,run.checkpoint)
   ?{since:at,phase:run.phase,checkpoint:clone(run.checkpoint),runIds:[previous.runId,run.runId]}:run.isolation||null;
  return withRecent({...run,state:'unknown',cause,interruptedPhase:run.phase,closedAt:at,updatedAt:at,lease:{step:null,expiresAt:null},isolation});
 }
 function finish(run,now){
  const at=iso(now),diaryOutcome=run.diary?.outcome??null,failed=DIARY_ERRORS.includes(diaryOutcome);
  // A recorded diary outcome is the cause when it failed, and null when the page was read. `diary_off` is only a
  // missing summary. The retired binding does not take that path (ADR 0075).
  return withRecent({...run,state:failed?'error':'finished',phase:'done',outcome:diaryOutcome,cause:failed?diaryOutcome:diaryOutcome?null:'diary_off',finishedAt:at,updatedAt:at,lease:{step:null,expiresAt:null}});
 }

 // ratings_sync_start. `busy` never hands out the running id; a stale record is closed first.
 async function start(env,{trigger,clearIsolation=false}={},now=Date.now()){
  const reply=(runId,created,nextAction,reason,extra={})=>({runId,created,nextAction,reason,...extra});
  const state=await migrationState(env);
  if(state.migration!=='complete')return reply(null,false,'stop','not_migrated',{migration:state.migration});
  const pointer=(await read(env,EPG_GENERATION_KEY)).value;
  const pinned={programmeRunId:pointer?.phase==='published'&&pointer.programmeRunId?pointer.programmeRunId:null,removalPending:Object.values(state.queue?.films||{}).filter(entry=>entry.state==='pending').length};
  for(let attempt=0;attempt<5;attempt++){
   const {object,value:stored}=await read(env,KEYS.run);
   let base=stored,reason='started';
   if(base?.state==='running'){const stale=staleness(base,now);if(!stale)return reply(null,false,'stop','busy');base=closeStale(base,stale,now);}
   if(base?.isolation){if(clearIsolation&&trigger==='manual')base={...base,isolation:null,isolationClearedAt:iso(now)};else reason='isolated';}
   const at=iso(now);
   const next=reason==='started'?{schemaVersion:RUN_SCHEMA_VERSION,runId:crypto.randomUUID(),trigger,state:'running',phase:'diary',lease:{step:null,expiresAt:null},
    startedAt:at,updatedAt:at,lastStepAt:null,finishedAt:null,closedAt:null,checkpoint:{diaryPagesRead:0,diaryNextPage:1,diaryMode:'incremental',removalChecked:0,legacyPagesLinked:0},pinned,
    outcome:null,cause:null,interruptedPhase:null,diary:null,removal:null,isolation:base?.isolation||null,...(base?.isolationClearedAt?{isolationClearedAt:base.isolationClearedAt}:{}),lastStartAt:at,recent:base?.recent||[]}:base!==stored?base:null;
   if(next&&await put(env,KEYS.run,object,next)===null)continue;
   if(reason==='started')return reply(next.runId,true,'continue','started');
   return reply(null,false,'stop',reason,reason==='isolated'?{isolation:base.isolation}:{});
  }
  throw new Error('Ratings run changed during start');
 }

 // ratings_sync_step: one bounded step of the run named by runId. `clock` reads the time at each lease check (tests
 // drive it); `now` is the time the step begins.
 async function step(env,{runId}={},{now=Date.now(),clock=()=>Date.now()}={}){
  const reply=(run,nextAction,reason,extra={})=>({runId:run?.runId??null,state:run?.state??null,phase:run?.phase??null,nextAction,reason,nextCatchUpAt:null,step:null,summary:null,...extra});
  const migration=(await migrationState(env)).migration;
  if(migration!=='complete')return reply(null,'stop','not_migrated',{migration});
  const stepId=crypto.randomUUID();
  let owned=null;
  for(let attempt=0;attempt<5&&!owned;attempt++){
   const {object,value:run}=await read(env,KEYS.run);
   if(!run)return reply(null,'stop','not_running');
   if(run.runId!==runId)return reply(null,'stop','run_mismatch');
   if(run.state!=='running')return reply(run,'stop',run.state,{summary:{diary:run.diary,removal:run.removal}});
   if(leaseLive(run,now))return reply(run,'wait','busy',{nextCatchUpAt:run.lease.expiresAt});
   const stale=staleness(run,now);
   if(stale){const closed=closeStale(run,stale,now);if(await put(env,KEYS.run,object,closed)===null)continue;return reply(closed,'stop','unknown',{cause:stale});}
   const at=iso(now),next={...run,lease:{step:stepId,expiresAt:iso(now+LEASE_MS)},updatedAt:at,lastStepAt:at};
   const saved=await put(env,KEYS.run,object,next);if(saved===null)continue;
   owned={run:next,etag:saved.etag};
  }
  if(!owned)throw new Error('Ratings run changed during step');
  const remaining=()=>Date.parse(owned.run.lease.expiresAt)-clock();
  // The only write to the run record during a step: refused once the lease has run out or another writer holds the record.
  const own=async mutate=>{
   for(let attempt=0;attempt<5;attempt++){
    if(!(remaining()>0))throw new LeaseLost();
    const next=mutate(clone(owned.run));
    const saved=await env.BUCKET.put(KEYS.run,JSON.stringify(next),{httpMetadata:{contentType:'application/json'},onlyIf:{etagMatches:owned.etag}});
    if(saved!==null){owned={run:next,etag:saved.etag};return next;}
    const {object,value}=await read(env,KEYS.run);
    if(!object||value?.state!=='running'||value.lease?.step!==stepId)throw new LeaseLost();
    owned={run:value,etag:object.etag};
   }
   throw new LeaseLost();
  };
  const released=run=>({...run,lease:{step:null,expiresAt:null},updatedAt:iso(clock())});
  const stepInfo={id:stepId,phase:owned.run.phase,diaryPages:0,lookups:0};
  try{
   if(owned.run.phase==='diary'){
    const diary=await diaryPhase(env,owned.run,{stepId,own,remaining,clock});
    stepInfo.diaryPages=diary.pages;
    const next=await own(run=>released({...run,phase:diary.more?'diary':'removal',diary:diary.summary,checkpoint:{...run.checkpoint,diaryNextPage:diary.next?.page??null,diaryMode:diary.next?.mode??run.checkpoint.diaryMode}}));
    return reply(next,'continue','more_work',{step:stepInfo,summary:{diary:next.diary,removal:next.removal}});
   }
   const removal=await removalPhase(env,owned.run,{own,remaining,clock});
   stepInfo.lookups=removal.lookup.checked;
   const merged=run=>({...run,removal:{settled:addCounts(run.removal?.settled,removal.settled),lookup:addCounts(run.removal?.lookup,removal.lookup),pausedUntil:removal.lookup.pausedUntil||run.removal?.pausedUntil||null}});
   const next=await own(run=>removal.more?released(merged(run)):finish(merged(run),clock()));
   return reply(next,removal.more?'continue':'stop',removal.more?'more_work':next.state,{step:stepInfo,summary:{diary:next.diary,removal:next.removal}});
  }catch(e){
   if(e instanceof LeaseLost)return reply(owned.run,'stop','lease_lost',{step:stepInfo});
   try{await own(run=>released({...run,lastStepError:{at:iso(clock()),phase:run.phase,message:String(e.message).slice(0,160)}}));}catch{}
   throw e;
  }
 }
 function addCounts(left,right){
  const out={...(left||{})};
  for(const [key,value] of Object.entries(right||{}))out[key]=typeof value==='number'?(out[key]||0)+value:value;
  return out;
 }

 // The Diary phase: the first page once per run (ADR 0067, ADR 0075). A run that already read it does not fetch.
 // The retired binding is not consulted. After the page: its history merge, its facts and the diary resolution of
 // queued films, the cursor join, then the run checkpoint. `more` is only a retry of that same page when the lease
 // stopped the step before the request. A failed, blocked or rate-limited page is recorded and is not treated as read.
 async function diaryPhase(env,run,{stepId,own,remaining,clock}){
  const cp=run.checkpoint;
  const prior=run.diary||null;
  if((cp.diaryPagesRead||0)>=1)return {pages:0,more:false,next:null,summary:prior};
  const facts={films:0,written:0,unchanged:0,older:0,skipped:0,conflicts:0,rated:0,unrated:0,ambiguous:0,partial:0};
  let pagesRead=cp.diaryPagesRead||0,stepPages=0,leaseLost=false,resolved=0,unratedLids=[];
  const afterPage=async({page,rows,next,history,readAt})=>{
   const lids=new Set(rows.filter(row=>row.lid&&row.key).map(row=>row.lid));if(!lids.size)return;
   const evidence=LetterboxdDiary.ratingEvidence(history,lids,{page,rows,next}).map(item=>({...item,readAt}));
   for(const item of evidence)facts[item.ratingState]++;
   const result=await LetterboxdFacts.applyDiaryEvidence(env,evidence);
   for(const key of ['films','written','unchanged','older','skipped','conflicts'])facts[key]+=result[key];
   unratedLids=[...new Set(evidence.filter(item=>item.rating==null&&item.lid).map(item=>item.lid))];
   const proved=evidence.filter(item=>item.rating!=null).map(item=>({lid:item.lid,rating:result.ratings[item.lid]??item.rating}));
   if(proved.length){const at=iso(clock());await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{let changed=false;for(const item of proved)if(resolveRemovalByDiary(q,item.lid,item.rating,at)){changed=true;resolved++;}return changed?q:null;});}
  };
  const onPage=async({next})=>{
   pagesRead++;stepPages++;
   try{await own(current=>({...current,updatedAt:iso(clock()),checkpoint:{...current.checkpoint,diaryPagesRead:pagesRead,diaryNextPage:next?.page??null,diaryMode:next?.mode??current.checkpoint.diaryMode}}));return true;}
   catch(e){if(e instanceof LeaseLost){leaseLost=true;return false;}throw e;}
  };
  const diary=await LetterboxdDiary.syncHistory(env,{now:clock(),afterPage,beforePage:async()=>remaining()>LEASE_MARGIN_MS,onPage,writer:{runId:run.runId,step:stepId},progressWrites:true});
  if(leaseLost)throw new LeaseLost();
  const failed=DIARY_ERRORS.includes(diary.lastOutcome),more=!failed&&!!diary.next;
  const summary={outcome:diary.lastOutcome,stopReason:diary.stopReason,pagesRead,historicalCoverage:'incomplete',counts:addCounts(prior?.counts,{pages:diary.counts.pages,rows:diary.counts.rows,added:diary.counts.added,updated:diary.counts.updated,conflicts:diary.counts.conflicts,overflowSuspected:diary.counts.overflowSuspected?1:0}),
   facts:addCounts(prior?.facts,{...facts,enabled:true}),removalResolved:(prior?.removalResolved||0)+resolved,unratedLids,resumePage:diary.cursor.resumePage??null,coverage:diary.cursor.coverage||null,at:diary.lastAttemptAt};
  return {pages:stepPages,more,next:diary.next,summary};
 }

 // The removal phase: first, while a rated legacy entry still has no finished event scan, one page of `events/items/`
 // (ADR 0071). That page only adds references for an exact film id and does not reopen the entry. Then the event writes
 // of rated entries with unresolved references, at most 100 per step, least recently checked first; the run visits each
 // reference once (those checked since the run started are skipped) and goes on with further steps while unvisited ones
 // are left, so references that never resolve neither keep a run going nor hide later ones. A legacy scan that has not
 // finished also continues, and retention does not run until it has: an unmatched legacy entry is still `refs: []` and
 // the version 1 rules would otherwise delete it. Then the retention rules, then at most five lookups per step with the
 // claim-before-request, three-attempt, 403/429 pause and expiry rules of the queue; the run goes on while due entries
 // remain. Each claim moves the entry's next attempt at least an hour ahead, so a run ends. A paused queue ends the
 // lookups for this run. The retired binding does not (ADR 0077). A confirmed stored rating resolves a due entry
 // first, with no claim and no member-page GET, including one a new reference just reopened. No legacy candidate means no event list.
 async function removalPhase(env,run,{own,remaining,clock}){
  const legacyLink=await linkLegacyRemovalRefs(env,{limit:LEGACY_LINK_PAGE,now:clock()});
  // The counter moves only when this step's queue write committed. A lost compare-and-swap does not count another scan's page.
  if(legacyLink.advanced)await own(current=>({...current,updatedAt:iso(clock()),checkpoint:{...current.checkpoint,legacyPagesLinked:(current.checkpoint.legacyPagesLinked||0)+1}}));
  const settled=await settleRemovalRefs(env,{limit:SETTLE_PER_STEP,now:clock(),checkedBefore:run.startedAt});
  const lookup={checked:0,rated:0,notRated:0,failed:0,refused:0,stoppedBy:null,pausedUntil:null};
  let more=false;
  if(settled.left>0||legacyLink.more){lookup.stoppedBy=settled.left>0?'settling':'legacy_link';return {settled,lookup,more:true};}
  await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>removalQueueV2(q)&&pruneRemovalQueue(q,clock())?q:null);
  const budget=STEP_LOOKUPS;
  const started=clock();
  await resolveDueRemovalFacts(env,started,run.diary?.unratedLids||[]);
  let queue=(await read(env,REMOVAL_LOOKUP_KEY)).value;
  if(!removalQueueV2(queue)){lookup.stoppedBy='queue_not_migrated';return {settled,lookup,more};}
  if(queue.pausedUntil&&Date.parse(queue.pausedUntil)>started){lookup.stoppedBy=queue.pausedBy||'blocked';lookup.pausedUntil=queue.pausedUntil;return {settled,lookup,more};}
  for(const id of removalDue(queue,started,budget)){
   if(!(remaining()>LEASE_MARGIN_MS)){more=true;break;}
   const t=clock(),at=iso(t),token=crypto.randomUUID();
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>removalQueueV2(q)&&claimRemovalEntry(q,id,t,at,token)?q:null);
   if(!removalClaimHeld(queue,id,at,token))continue;
   let result=null,error=null;try{result=await refreshPersonalRating(env,{id,url:queue.films[id].url});}catch(e){error=String(e.message);}
   let accepted=false;
   queue=await mergeStoredJSON(env,REMOVAL_LOOKUP_KEY,REMOVAL_QUEUE_EMPTY,q=>{accepted=applyRemovalOutcome(q,id,result,error,at,t,token);return accepted?q:null;});
   const entry=queue.films[id];lookup.checked++;if(!accepted)lookup.refused++;
   if(accepted&&entry?.state==='rated'){lookup.rated++;await settleRemovalRefs(env,{ids:[id]});}else if(accepted&&entry?.lastResult==='not_rated')lookup.notRated++;else if(error)lookup.failed++;
   await own(current=>({...current,updatedAt:iso(clock()),checkpoint:{...current.checkpoint,removalChecked:(current.checkpoint.removalChecked||0)+1}}));
   if(accepted&&(entry?.lastResult==='blocked'||entry?.lastResult==='rate_limited')){lookup.stoppedBy=entry.lastResult;lookup.pausedUntil=queue.pausedUntil;break;}
  }
  if(!more&&!lookup.stoppedBy){
   const after=(await read(env,REMOVAL_LOOKUP_KEY)).value;
   if(removalQueueV2(after)&&!(after.pausedUntil&&Date.parse(after.pausedUntil)>clock())&&removalDue(after,clock(),1).length)more=true;
  }
  return {settled,lookup,more};
 }

 // ratings_storage_migrate. `dry_run` writes nothing. `apply` converts the queue by one compare-and-swap, records it in
 // the witness, then gives the cursor its merge form by a second one and records that. Idempotent: an object already
 // migrated is reported `already`. Refused while a ratings run is running and not stale. No Letterboxd request.
 async function migrate(env,{mode}={},now=Date.now()){
  const at=iso(now),run=(await read(env,KEYS.run)).value;
  if(run?.state==='running'&&!staleness(run,now))return {mode,refused:'run_running',migration:(await migrationState(env)).migration};
  const sync=await loadJSON(env,'sync.json'),handover=syncHandover(sync);
  const queueReport=queue=>({entries:Object.keys(queue?.films||{}).length,legacy:Object.values(queue?.films||{}).filter(entry=>entry.legacy===true).length,refs:Object.values(queue?.films||{}).reduce((n,entry)=>n+(entry.refs||[]).length,0),unresolved:Object.values(queue?.films||{}).reduce((n,entry)=>n+removalUnresolvedRefs(entry),0)});
  const cursorReport=cursor=>({coverage:cursor?.coverage||null,resumePage:cursor?.resumePage??null,lastAttemptAt:cursor?.lastAttemptAt??null});
  const handoverReport={films:handover.reduce((n,item)=>n+item.films.length,0),withEvent:handover.filter(item=>item.ref).reduce((n,item)=>n+item.films.length,0)};
  if(mode==='dry_run'){
   const state=await migrationState(env);
   return {mode,migration:state.migration,queue:{result:state.queueV2?'already':'would_migrate',...queueReport(state.queueV2?state.queue:migrateRemovalQueue(state.queue,handover,at)),before:{schemaVersion:state.queue?.schemaVersion??null,entries:Object.keys(state.queue?.films||{}).length},handover:handoverReport},cursor:{result:state.cursorV2?'already':'would_migrate',...cursorReport(state.cursor)},writes:0};
  }
  const witness=part=>mergeStoredJSON(env,KEYS.migration,{schemaVersion:1},current=>{if(current[part]?.migratedAt)return null;current[part]={migratedAt:at};return current;});
  const convert=async(key,isMigrated,next)=>{
   try{
    for(let attempt=0;attempt<5;attempt++){
     const {object,value}=await read(env,key);
     if(isMigrated(value))return {result:'already',value};
     const converted=next(value);
     if(await put(env,key,object,converted)!==null)return {result:'migrated',value:converted};
    }
    return {result:'failed',error:'changed during migration'};
   }catch(e){return {result:'failed',error:String(e.message).slice(0,160)};}
  };
  const queue=await convert(REMOVAL_LOOKUP_KEY,removalQueueV2,value=>migrateRemovalQueue(value,handover,at));
  if(queue.result!=='failed')await witness('queue');
  const cursor=queue.result==='failed'?{result:'failed',error:'queue not migrated'}:await convert(LetterboxdDiary.KEYS.state,LetterboxdDiary.cursorMigrated,value=>LetterboxdDiary.migrateCursor(value,MIGRATION_WRITER));
  if(cursor.result!=='failed')await witness('cursor');
  const state=await migrationState(env);
  return {mode,migration:state.migration,queue:{result:queue.result,...(queue.error?{error:queue.error}:queueReport(queue.value)),handover:handoverReport},cursor:{result:cursor.result,...(cursor.error?{error:cursor.error}:cursorReport(cursor.value))}};
 }
 // A version 1 hand-over still in sync.json (`removalLookups`): films the saved watchlist event removed get that event
 // as their reference; any other film becomes a legacy entry.
 function syncHandover(sync){
  const stored=(Array.isArray(sync?.removalRefs)?sync.removalRefs:sync?.removalRefs?.films?.length&&sync.removalRefs.ref?[sync.removalRefs]:[]).map(item=>({films:(item.films||[]).map(removalLookupFilm).filter(Boolean),ref:item.ref})).filter(item=>item.films.length&&item.ref);
  const films=(Array.isArray(sync?.removalLookups)?sync.removalLookups:[]).map(removalLookupFilm).filter(Boolean);if(!films.length)return stored;
  const event=(sync.events||[]).find(item=>item?.type==='watchlist'&&Array.isArray(item.removed));
  const removed=new Set((event?.removed||[]).map(film=>String(film.id)));
  const ref=event&&Number.isFinite(Date.parse(event.at))&&event.id?{eventKey:removalEventKey(event),sourceRunId:sync.runId,at:event.at}:null;
  return [...stored,{films:films.filter(film=>ref&&removed.has(film.id)),ref},{films:films.filter(film=>!(ref&&removed.has(film.id))),ref:null}].filter(item=>item.films.length);
 }

 // ratings_sync_status: reads only, never closes a stale run.
 function presentRun(run,now){
  if(!run)return null;
  const {lease,...rest}=run;
  return {...rest,lease:{live:leaseLive(run,now),expiresAt:lease?.expiresAt??null},stale:staleness(run,now)};
 }
 function freshnessOf(run){
  const runs=run?[...(run.state==='running'?[]:[summaryOf(run)]),...(run.recent||[])]:[];
  const latest=list=>list.map(item=>item.endedAt).filter(Boolean).sort().at(-1)||null;
  return {lastFinishedAt:latest(runs.filter(item=>['finished','error'].includes(item.state))),lastSuccessAt:latest(runs.filter(item=>item.state==='finished'))};
 }
 async function status(env,now=Date.now()){
  const [state,{value:run}]=await Promise.all([migrationState(env),read(env,KEYS.run)]);
  const queue=state.queue,entries=Object.values(queue?.films||{}),cursor=state.cursor;
  return {contractVersion:CONTRACT_VERSION,switch:'separate',pipeline:pipelineOf(state.migration,run),migration:state.migration,...(state.regressed.length?{regressedObjects:state.regressed}:{}),
   run:presentRun(run,now),
   diary:{enabled:LetterboxdDiary.enabled(env),migrated:state.cursorV2,lastOutcome:cursor?.lastOutcome??null,stopReason:cursor?.stopReason??null,coverage:cursor?.coverage||null,historicalCoverage:cursor?.coverage?.window==='recent'?'incomplete':'unknown',overflowSuspected:cursor?.counts?.overflowSuspected===true,resumePage:cursor?.resumePage??null,lastAttemptAt:cursor?.lastAttemptAt??null,lastSuccessAt:cursor?.lastSuccessAt??null},
   removal:{schemaVersion:queue?.schemaVersion??null,lookupEnabled:true,entries:entries.length,pending:entries.filter(entry=>entry.state==='pending').length,unresolved:entries.reduce((n,entry)=>n+removalUnresolvedRefs(entry),0),unresolvedEntries:entries.filter(entry=>removalUnresolvedRefs(entry)>0).length,
    refIssues:Object.fromEntries(REMOVAL_REF_ISSUES.map(issue=>[issue,entries.reduce((n,entry)=>n+(entry.refs||[]).filter(ref=>ref.resolved!==true&&ref.issue===issue).length,0)])),
    legacy:entries.filter(entry=>entry.legacy===true).length,expired:entries.filter(entry=>entry.state==='expired').length,droppedRefs:queue?.droppedRefs||0,pausedUntil:queue?.pausedUntil&&Date.parse(queue.pausedUntil)>now?queue.pausedUntil:null},
   freshness:freshnessOf(run),readAt:iso(now),sideEffects:'none'};
 }
 // The footer's letterboxd_ratings source under the separate pipeline, from the run record alone.
 function health(run,now){
  const fresh=freshnessOf(run),failures=run?[...(run.state==='running'?[]:[summaryOf(run)]),...(run.recent||[])].filter(item=>['error','unknown'].includes(item.state)).map(item=>item.endedAt).filter(Boolean).sort():[];
  const base={lastSuccessAt:fresh.lastSuccessAt,lastFailureAt:failures.at(-1)||null};
  if(!run)return {...base,state:'unknown',code:'no_data'};
  const stale=staleness(run,now);
  if(run.isolation||stale||run.state==='unknown')return {...base,state:'degraded',code:'ratings_pending'};
  if(run.state==='running')return {...base,state:'running',code:'running'};
  if(run.state==='error')return {...base,state:run.cause==='failed'?'failed':'degraded',code:run.cause==='blocked'?'ratings_blocked':run.cause==='rate_limited'?'ratings_rate_limit':'ratings_failed'};
  return {...base,state:'ok',code:'ok'};
 }
 // The request contract shared by the HTTP routes and the MCP tools: a JSON object with only the listed fields.
 const FIELDS={start:{trigger:value=>value==='scheduled'||value==='manual',clearIsolation:value=>typeof value==='boolean'},step:{runId:value=>typeof value==='string'&&/^[A-Za-z0-9-]{1,80}$/.test(value)},migrate:{mode:value=>value==='dry_run'||value==='apply'}};
 const REQUIRED={start:['trigger'],step:['runId'],migrate:['mode']};
 function validate(action,body){
  const fields=FIELDS[action];if(!fields)return 'Unknown action';
  if(!body||typeof body!=='object'||Array.isArray(body))return 'Invalid request';
  if(Object.keys(body).some(key=>!Object.hasOwn(fields,key)))return 'Unknown field';
  for(const key of REQUIRED[action])if(body[key]===undefined)return 'Missing '+key;
  for(const [key,value] of Object.entries(body))if(!fields[key](value))return 'Invalid '+key;
  if(action==='start'&&body.clearIsolation===true&&body.trigger!=='manual')return 'clearIsolation requires trigger manual';
  return null;
 }
 async function handle(env,action,body){
  const error=validate(action,body);if(error)return {status:400,body:{error}};
  return {status:200,body:await (action==='start'?start(env,body):action==='step'?step(env,body):migrate(env,body))};
 }
 return {KEYS,CONTRACT_VERSION,validate,handle,LEASE_MS,LEASE_MARGIN_MS,ABANDONED_MS,STEP_LOOKUPS,SETTLE_PER_STEP,migrationState,separateActive,staleness,start,step,migrate,status,health,syncHandover,readRun:async env=>(await read(env,KEYS.run)).value};
})();
