// AIR-349. The Cloudflare-native monitor of the four production streams (EPG, Discovery, Ratings, prediction queue), independent of any
// ChatGPT Task. It reads bounded status facts that the domains already keep (never the Discovery ledger, never programme.json), judges
// them with the pure MonitorPolicy, keeps one small state document and sends actionable alerts to an owner-approved webhook.
// It only diagnoses and reports: no recovery, no force, no reset, no write to any domain record.
// MONITOR is a permanent emergency gate: off (default; any other value is off too) does nothing, no tick, no alert, no dead-man ping; on keeps the
// state document (`monitor/state.json`) and sends alerts through the channel MONITOR_TRANSPORT selects. Concatenated into the Worker: one global, no exports.
const Monitor=(()=>{
 const STATE_KEY='monitor/state.json',SCHEMA_VERSION=1,SEND_TIMEOUT_MS=10000,TEST_COOLDOWN_MS=10*60000,SEND_BUDGET=5,SEND_FAIL_STOP=2;
 const policy=()=>MonitorPolicy;
 const iso=ms=>new Date(ms).toISOString();
 const mode=env=>env?.MONITOR==='on'?'on':'off';
 const httpsUrl=value=>{try{const url=new URL(String(value||''));return url.protocol==='https:'?url.toString():null;}catch{return null;}};
 const guarded=async work=>{try{return await work();}catch{return {error:true};}};
 const log=fields=>{try{console.log(JSON.stringify({event:'monitor',...fields}));}catch{}};

 async function readState(env){
  const object=await env.BUCKET.get(STATE_KEY);
  if(!object)return {object:null,doc:null};
  try{const doc=await object.json();return {object,doc:doc&&doc.schemaVersion===SCHEMA_VERSION?doc:null};}catch{return {object,doc:null};}
 }
 async function writeState(env,object,doc){
  const saved=await env.BUCKET.put(STATE_KEY,JSON.stringify(doc),{httpMetadata:{contentType:'application/json'},onlyIf:object?{etagMatches:object.etag}:{etagDoesNotMatch:'*'}});
  return saved||null;
 }

 // ---- facts: cheap reads only, each stream isolated so one unreadable source never hides the others.
 const epgFacts=(env,now,seen)=>guarded(async()=>{
  const run=await loadJSON(env,'sync.json');
  let pub=null,authority='r2';
  if(typeof PublishedEpg!=='undefined'){try{pub=await PublishedEpg.currentGeneration(env);authority=pub?'d1':'r2';}catch{authority='unreadable';}}
  if(!pub&&authority!=='unreadable'){const mirror=await loadJSON(env,EPG_GENERATION_KEY).catch(()=>null);if(mirror?.programmeRunId)pub={programmeRunId:mirror.programmeRunId};}
  const publishedRunId=pub?.programmeRunId||null;
  // The publication time is the completed run's own record when it is the published one; otherwise the first time this monitor saw
  // that generation (a conservative fallback: a generation already stale when the monitor starts is not flagged until it is seen).
  const publishedAt=publishedRunId&&run?.stage==='complete'&&run.runId===publishedRunId?run.updatedAt:seen?.runId===publishedRunId?seen.at:publishedRunId?iso(now):null;
  const text=String(run?.error||'');
  return {authority,publishedRunId,publishedAt,runError:!!run?.error&&run.stage!=='complete',resourceLimit:/1102|exceeded.*(memory|cpu)|memory limit/i.test(text),stage:run?.stage||null};
 });
 // AIR-598: one consistent read through the shared Discovery reader (src/discovery.js `readDiscoveryEvidence`) and its one classification (`queue`); the policy
 // judges owed work, emptiness and eligibility only from that classification, never from the raw continuation reason. A record that cannot be read is unreadable.
 const discoveryFacts=(env,now,pubRunId)=>guarded(async()=>{
  const executor='workflow';
  const evidence=await readDiscoveryEvidence(env,{now});
  if(evidence.authority?.state==='unavailable'||evidence.unavailable.some(name=>['authority','status','continuation','workflow'].includes(name)))throw new Error('discovery_unreadable');
  const queue=discoveryQueueState(evidence,now);
  const {continuation,lease,status:last,workflow}=evidence.records;
  const health=typeof continuationHealth==='function'?continuationHealth(continuation,lease,last,now,pubRunId)?.status||null:null;
  let readout=null;
  if(executor==='workflow'&&typeof discoveryExecutorReadout==='function')readout=await discoveryExecutorReadout(env,continuation,{workflow,queue}).catch(()=>null);
  const reason=String(readout?.recovery?.reason||readout?.reason||'');
  // Times of the published generation only: the policy reads them from `queue` (lastChunkAt, checkpointAt, allowedAt), never from another generation's record.
  return {executor,continuation:continuation||null,queue,health,lastChunkFinishedAt:queue.lastChunkAt,publishedRunId:pubRunId,
   readout:readout?{stalled:!!readout.stalled,quarantined:!!(readout.recovery?.quarantined||readout.quarantined)}:null,resourceLimit:/1102|memory/i.test(reason)};
 });
 const ratingsFacts=(env,now)=>guarded(async()=>{
  if(typeof RatingsOrchestration==='undefined')throw new Error('unavailable');
  return await RatingsOrchestration.readModel(env,now);
 });
 // ADR 0186: the Letterboxd Sync slot read model, supplied only while the executor is switching or cloudflare, so a dormant executor adds no stream.
 const letterboxdFacts=(env,now)=>guarded(async()=>{
  if(typeof LetterboxdSync==='undefined'||!env?.DB)return null;
  const model=await LetterboxdSync.readModel(env,{now});
  return model.mode==='external'?null:{...model,identityCheck:await identityCheckFacts(env,now)};
 });
 // AIR-599 / ADR 0207 decision 4b: ONE fact reader of the shared Letterboxd check (both callers), read only: the newest real check that got an answer, the due Diary entries, the backlog (a cap refusal only when the document has no free place for it: `capFull`; at its bound: `backlog_full`), the due ledger rows and the ledger rows pending longer than 14 days. A missing `lastCheckAt` falls back to the newest charged
 // check of the entries; with neither, the age is unknown and not reported as stale.
 const identityCheckFacts=async(env,now)=>{
  if(typeof LetterboxdFacts==='undefined'||typeof LetterboxdDiaryIdentity==='undefined'||typeof LetterboxdFacts.readDiaryBacklog!=='function')return null;
  try{
   const [doc,backlog]=await Promise.all([LetterboxdFacts.readDiaryIdentity(env),LetterboxdFacts.readDiaryBacklog(env).then(read=>read.doc)]);
   const D=LetterboxdDiaryIdentity,cap=D.MAX_ATTEMPTS;
   const entries=Object.values(doc.films||{}).filter(Boolean).filter(entry=>entry.reason!=='owner_dismissed');
   // Work still owed an answer: an entry below the cap that is due now, or retained after a transport or not-now outcome (its retry time may be in the future: it is waiting, not done).
   const owed=entries.filter(entry=>(Number(entry.attempts)||0)<cap&&(!(Date.parse(entry.nextAttemptAt)>now)||['transport','not_now','intent'].includes(D.classify(entry.reason))));
   const stamp=entry=>String(entry.queuedAt||entry.lastAttemptAt||'');
   const charged=entries.filter(entry=>['gone','definite'].includes(D.classify(entry.reason))).map(entry=>String(entry.lastAttemptAt||'')).filter(Boolean).sort();
   const ledger=typeof WatchlistD1!=='undefined'&&typeof WatchlistD1.admissionReport==='function'?await WatchlistD1.admissionReport(env,{now,overdueBefore:new Date(now-14*86400000).toISOString(),retainedReasons:[...D.TRANSPORT_REASONS]}):{ok:false};
   const backlogEntries=Object.values(backlog.ids||{}).filter(Boolean);
   const backlogCount=backlogEntries.length;
   // AIR-691: a non-empty backlog is the ordinary queue (an owner requeue or createMissing puts an id there whatever the free room); only a document with no free place for a waiting id is a cap refusal. Every entry but an
   // evictable `owner_dismissed` one holds a place (the same count the Diary phase uses for its free slots).
   const capacity=Number.isInteger(LetterboxdFacts.DIARY_IDENTITY_CAP)?LetterboxdFacts.DIARY_IDENTITY_CAP:200,held=entries.length,capFull=backlogCount>0&&held>=capacity;
   // The oldest place of any owed work: the baseline of "never answered" (every owed item has a durable queue time: its entry, its backlog record or its first-seen snapshot header).
   const times=[...owed.map(stamp),...backlogEntries.map(item=>String(item.queuedAt||'')),ledger.ok&&ledger.oldestWorkAt?String(ledger.oldestWorkAt):''].filter(Boolean).sort();
   return {lastCheckAt:typeof doc.lastCheckAt==='string'?doc.lastCheckAt:charged.at(-1)||null,work:owed.length+backlogCount+(ledger.ok?ledger.pendingDue:0),oldestWorkAt:times[0]||null,atCap:entries.filter(entry=>(Number(entry.attempts)||0)>=cap).length,backlog:backlogCount,capHeld:held,capacity,capFull,backlogFull:backlogCount>=LetterboxdFacts.DIARY_BACKLOG_CAP,ledgerUnreadable:!ledger.ok,overdue:ledger.ok?ledger.overdue:null,overdueUnknown:ledger.ok?ledger.overdueUnknown:null};
  }catch{return {error:'unreadable'};}
 };
 // AIR-556. Prediction progress is confirmed work only, read through the same helpers as the Footer (enrichment.js: queue slices, retry budget, run
 // history, one 60-minute no-progress threshold). Progress is a productive batch or a drained run that proved an empty queue, taken from the run history,
 // the queue's own last batch and this document's stored clock (AIR-596, ADR 0210). A heartbeat, `already_running`, a noop wake-up, a queue recount, a moved
 // processed counter (it says a run completed since the last tick, not when) and a lost monitor document are never progress, and an unknown time is never "now":
 // without any evidence the clock starts at the first tick that saw eligible work (`unknownSince`, persisted), so the silence is bounded, not hidden.
 const predictionFacts=(env,now,previous)=>guarded(async()=>{
  const queue=await loadJSON(env,predictionQueueKey);
  if(!queue)return {present:false};
  const [latest,runs,lease]=await Promise.all([
   loadJSON(env,ENRICHMENT_KEY+'latest-run.json').catch(()=>null),
   diagnosticHistory(env,20).then(history=>history.runs).catch(()=>null),
   loadJSON(env,RUNNER_LEASE_KEY).catch(()=>null)]);
  const shared=predictionProgressFacts({queue,runs,latestRun:latest,lease,now});
  const slices=shared.slices;
  const evidenceAt=shared.lastProgressAt?Date.parse(shared.lastProgressAt):null;
  const processedTotal=Number.isInteger(queue.metrics?.hotProcessedTotal)?queue.metrics.hotProcessedTotal:null;
  // Only a stored progress time that came from evidence is carried over: an earlier build stamped `now` when it had none.
  const known=Date.parse(predictionStoredClockAt(previous,now)||'');
  const candidates=[evidenceAt,Number.isFinite(known)?known:null].filter(value=>Number.isFinite(value)&&value<=now+300000);
  const lastProgressMs=candidates.length?Math.max(...candidates):null;
  // The unknown-age clock runs only across ticks that observed eligible work with no progress evidence: idle, deferred and unreadable ticks reset it, so work
  // that becomes eligible is measured from the first tick that saw it, never from an earlier quiet tick.
  const observingEligible=lastProgressMs===null&&Number.isInteger(shared.eligibleNow)&&shared.eligibleNow>0;
  const unknownSince=observingEligible?(Number.isFinite(Date.parse(previous?.unknownSince||''))?previous.unknownSince:iso(now)):null;
  // The orphan chain is counted after the progress time actually used, so a carried clock does not re-count starts that an evicted success preceded.
  const orphanStarts=predictionOrphansAfter(predictionRunEvidence({run:latest,recentRuns:runs,now}),lastProgressMs??-Infinity,now);
  const stall=predictionStallAssessment({now,sinceMs:lastProgressMs,eligibleNow:shared.eligibleNow,nextRetryAtMs:slices.nextRetryAt?Date.parse(slices.nextRetryAt):null,activeRun:shared.activeRun,activeStartedAtMs:shared.activeStartedAtMs,observedSinceMs:unknownSince?Date.parse(unknownSince):null,orphanStarts});
  return {present:true,pendingCount:Array.isArray(queue.pending)?queue.pending.length:null,processedTotal,lastProgressAt:lastProgressMs===null?null:iso(lastProgressMs),unknownSince,
   eligibleNow:shared.eligibleNow,outstanding:slices.outstanding,retryExhausted:slices.retryExhausted,nextRetryAt:slices.nextRetryAt,stall,activeRun:shared.activeRun,
   blockedReason:queue.lastBatch?.stage==='blocked'?String(queue.lastBatch.reason||'').slice(0,40):null};
 });
 // AIR-543 / ADR 0179: one bounded read of the poster checkpoint plus the Monitor's two write-once markers. The markers are written only by this
 // tick (never by a GET), are never cleared, and the first valid checkpoint fixes `seenAt` so a later loss is `lost`, not a new first-run grace.
 const posterMarkers=state=>({baselineAt:typeof state?.catalogPostersBaselineAt==='string'?state.catalogPostersBaselineAt:null,seenAt:typeof state?.catalogPostersSeenAt==='string'?state.catalogPostersSeenAt:null});
 const catalogPosterFacts=(env,now,state)=>guarded(async()=>{
  if(typeof CatalogPosterWeekly==='undefined')return null;
  const markers=posterMarkers(state);
  const result=await CatalogPosterWeekly.readStatus(env,{markers,monitorOn:true,nowMs:now});
  const next={...markers};
  if(result.checkpointStatus==='ok'&&!next.seenAt)next.seenAt=iso(now);
  if(result.checkpointStatus==='absent'&&!next.seenAt&&!next.baselineAt)next.baselineAt=iso(now);
  return {...result,markers:next};
 });
 // AIR-572 / AIR-593. The canonical Producer, from bounded READ-ONLY D1: ONE reader (`CanonicalProducerWorkflow.readProducerMonitorFacts`, exactly three SQL
 // statements: the published (P,g) with its publication time, the chain by primary key, the run of that generation by index). No join over a catalog, no scan, no
 // write. The streak start (`noProgressSince`) survives a rollover of the published generation and is cleared only by proven progress. While the delivery hold is
 // on nothing is read and the clock is cleared, so lifting the hold gives the live Producer a full no-progress window (never an instant alert).
 // The clock and the facts are the pure `MonitorPolicy.canonicalProducerFacts`; the Footer calls this same reader with the stored clock and never writes it.
 // Failures (n_failed) and strikes are not progress. Answers null when the module is not bundled, {error:true} when a read fails.
 // `readOnly` (the Footer): the reader clock, which never dates progress by the read itself, and `clockState` of the stored clock it was given.
 const canonicalProducerFacts=(env,now,previous,{readOnly=false,previousReadable=true}={})=>guarded(async()=>{
  if(typeof CanonicalProducerWorkflow==='undefined'||!env?.DB)return null;
  if(CanonicalProducerWorkflow.PRODUCER_DELIVERY_HOLD===true)return policy().canonicalProducerFacts({held:true,now});
  const read=await CanonicalProducerWorkflow.readProducerMonitorFacts(env);
  const facts=policy().canonicalProducerFacts({read,previous,now,readOnly,previousReadable});
  // ADR 0208 decision 7 (AIR-594): the outcome delivery to the Events Log, a read-only VISIBILITY fact for the hourly Monitor only (pending count, oldest pending
  // outcome, readability). It is never an input of the Producer's verdict: a healthy Producer with undelivered reports stays healthy, and no alert comes from it.
  if(!readOnly&&facts&&typeof CanonicalProducerEvents!=='undefined'){
   try{facts.outcomeDelivery=await CanonicalProducerEvents.readOutcomeDelivery(env);}catch{facts.outcomeDelivery={readable:false};}
  }
  return facts;
 });
 // AIR-605: the Catalog Enrichment Producer from bounded READ-ONLY D1 reads (`CatalogEnrichmentStore.readMonitorFacts`). D1 is the authority of every fact: the Monitor keeps no enrichment clock or R2 record. A missing schema or control
 // row is a neutral fact, a read failure is {error:true}, and an unbundled module answers null.
 const catalogEnrichmentFacts=(env,now)=>guarded(async()=>{
  if(typeof CatalogEnrichmentStore==='undefined'||!env?.DB)return null;
  return CatalogEnrichmentStore.readMonitorFacts(env,{now});
 });
 async function collect(env,now,state){
  const epg=await epgFacts(env,now,state?.epgSeen||null);
  const [discovery,ratings,predictions,catalogPosters,letterboxd,canonicalProducer,catalogEnrichment]=await Promise.all([discoveryFacts(env,now,epg?.publishedRunId||null),ratingsFacts(env,now),predictionFacts(env,now,state?.predictions||null),catalogPosterFacts(env,now,state),letterboxdFacts(env,now),canonicalProducerFacts(env,now,state?.canonicalProducer||null),catalogEnrichmentFacts(env,now)]);
  return {epg,discovery,ratings,predictions,...(catalogPosters===null?{}:{catalogPosters}),...(letterboxd===null?{}:{letterboxd}),...(canonicalProducer===null?{}:{canonicalProducer}),...(catalogEnrichment===null?{}:{catalogEnrichment})};
 }

 // ---- delivery: one transport chosen by deliberate configuration. `MONITOR_TRANSPORT` absent or `webhook` is the generic JSON webhook
 // (MONITOR_WEBHOOK_URL); `telegram` is the Telegram Bot API `sendMessage` (AIR-365); any other value is invalid and fails closed.
 // Neither payload carries titles, ratings, credentials or private data. A transport answers {ok, reason, retryAfterMs?}: reasons are fixed
 // codes, never response bodies, URLs or configuration values.
 const transportName=env=>{const value=env?.MONITOR_TRANSPORT;return value===undefined||value===null||value===''||value==='webhook'?'webhook':value==='telegram'?'telegram':'invalid';};
 // The token and chat id come only from Cloudflare secrets/bindings and are shape-checked; the destination is the fixed Bot API endpoint.
 const TELEGRAM_TOKEN=/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/,TELEGRAM_CHAT=/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
 const telegramConfig=env=>{const token=typeof env?.MONITOR_TELEGRAM_BOT_TOKEN==='string'?env.MONITOR_TELEGRAM_BOT_TOKEN.trim():'',chat=typeof env?.MONITOR_TELEGRAM_CHAT_ID==='string'?env.MONITOR_TELEGRAM_CHAT_ID.trim():'';return TELEGRAM_TOKEN.test(token)&&TELEGRAM_CHAT.test(chat)?{token,chat}:null;};
 const channelReady=env=>{const name=transportName(env);return name==='telegram'?!!telegramConfig(env):name==='webhook'?!!httpsUrl(env?.MONITOR_WEBHOOK_URL):false;};
 // Plain text only (no markup mode is requested), so nothing is interpreted. The human-facing text (ADR 0206 decision 9) is rendered by the pure
 // MonitorMessage from the message's own fields: fixed Russian labels and emoji, typed metrics, Madrid times, the stable id as the last line.
 const telegramText=(message,overall,now)=>MonitorMessage.telegramText(message,{overall,now});
 const HOLD_MAX_MS=3600000,HOLD_DEFAULT_MS=60000;
 async function sendTelegram(env,message,overall,now){
  const config=telegramConfig(env);
  if(!config)return {ok:false,reason:'config_invalid'};
  let response;
  try{
   response=await fetch('https://api.telegram.org/bot'+config.token+'/sendMessage',{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(SEND_TIMEOUT_MS),
    body:JSON.stringify({chat_id:config.chat,text:telegramText(message,overall,now),disable_web_page_preview:true})});
  }catch(error){return {ok:false,reason:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network'};}
  let body=null;
  try{body=await response.json();}catch{body=null;}
  if(response.ok&&body&&body.ok===true)return {ok:true,reason:null};
  if(response.status===429){
   const seconds=Number(body?.parameters?.retry_after)||Number(response.headers?.get?.('retry-after'))||0;
   return {ok:false,reason:'rate_limited',retryAfterMs:Math.min(HOLD_MAX_MS,seconds>0?seconds*1000:HOLD_DEFAULT_MS)};
  }
  if(!body)return {ok:false,reason:response.ok?'malformed_response':'http_'+response.status};
  return {ok:false,reason:response.ok?'telegram_not_ok':'http_'+response.status};
 }
 async function sendWebhook(env,message,overall,now){
  const url=httpsUrl(env?.MONITOR_WEBHOOK_URL);
  if(!url)return {ok:false,reason:'config_invalid'};
  try{
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(SEND_TIMEOUT_MS),
    body:JSON.stringify({source:'iptv-monitor',id:message.id||null,at:iso(now),kind:message.kind,severity:message.severity,critical:message.critical===true,stream:message.stream,key:message.key,message:message.message,overall})});
   return response.ok?{ok:true,reason:null}:{ok:false,reason:'http_'+response.status};
  }catch(error){return {ok:false,reason:error?.name==='TimeoutError'||error?.name==='AbortError'?'timeout':'network'};}
 }
 async function sendMessage(env,message,overall,now){
  const name=transportName(env);
  if(name==='telegram')return sendTelegram(env,message,overall,now);
  if(name==='webhook')return sendWebhook(env,message,overall,now);
  return {ok:false,reason:'transport_invalid'};
 }
 // The external dead-man ping: an HTTPS GET to a service that alerts when it stops arriving. A Worker cannot observe its own total outage.
 async function heartbeat(env){
  const url=httpsUrl(env?.MONITOR_HEARTBEAT_URL);
  if(!url)return null;
  try{const response=await fetch(url,{method:'GET',signal:AbortSignal.timeout(SEND_TIMEOUT_MS)});return response.ok;}catch{return false;}
 }

 // One scheduled evaluation. Never throws into the cron handler.
 async function run(env,{now=Date.now()}={}){
  const current=mode(env);
  if(current==='off')return {ran:false,reason:'off'};
  try{
   const {object,doc}=await readState(env);
   const facts=await collect(env,now,doc);
   // AIR-596: an open predictions_no_progress incident (its alert entry) is passed to the policy, which keeps it open while the verdict cannot be read
   // and recovers it only on confirmed progress or proven absence of eligible work.
   const openPrediction=doc?.alerts?.issues?.predictions_no_progress||null;
   // AIR-598: the open Discovery incident (either key) and the clock of an unconfirmed queue state are passed the same way: an unreadable or unconfirmed tick
   // keeps the incident open instead of recovering it, and an unconfirmed state is measured from the first tick that observed it.
   const discoveryKey=['discovery_stalled','discovery_unconfirmed'].find(key=>doc?.alerts?.issues?.[key])||null;
   const openDiscovery=discoveryKey?{key:discoveryKey,...doc.alerts.issues[discoveryKey]}:null;
   const evaluation=policy().evaluateAll(facts,{predictions:{...(doc?.predictions||{}),noProgressOpenSince:openPrediction?.firstSeenAt||null,openMetrics:openPrediction?.metrics||null,openMetricsAt:openPrediction?.metricsAt||null},
    discovery:{open:openDiscovery,unknownSince:doc?.discovery?.unknownSince||null}},now,{dailyDue:OrchestrationPolicy.dailyDue});
   const plan=policy().planAlerts(evaluation.issues,doc?.alerts||{issues:{}},now);
   // Claim before delivery. The planned messages are committed to `monitor/state.json` (as the plan's alert state and an outbox with stable
   // ids) with a compare-and-swap first; only the tick that wins that commit sends them, so ticks reading the same snapshot never both
   // send. A message that is not delivered stays in the outbox and is retried with the same id. Delivery is at-least-once: a crash after
   // the claim, or a failed commit of the delivered mark, can repeat a message, and the stable `id` lets the receiver drop the repeat.
   // The outbox keeps an undelivered notification until it is delivered; nothing is aged out or evicted. It is bounded by construction: at most
   // one pending alert-type message per issue key (a newer message for the same key replaces the pending one in place) plus recoveries.
   // Alert accounting (lastSentAt, sendCount, sendsToday) moves only when delivery succeeds, so a failed send never spends the cooldown or the
   // daily quota, and an alert that was never delivered raises no recovery: if its issue clears first it is cancelled and counted.
   const alerts=plan.state,prior=doc?.alerts?.issues||{},day=iso(now).slice(0,10);
   // ADR 0206: a message queued before the retirement of `needs_owner` keeps its id (the receiver still drops a repeat) and is delivered as `degraded`, critical.
   const outbox=(doc?.outbox||[]).map(item=>({...policy().normalizeMessage(item)}));
   let cancelled=doc?.cancelledUndelivered||0;
   // Reconcile the queue with the current issues: a pending alert of a cleared issue is cancelled (counted), and a pending recovery of an issue
   // that is active again is superseded (the new alert replaces it), so an obsolete "Recovered" is never sent.
   for(let index=outbox.length-1;index>=0;index--){
    const item=outbox[index];
    if(item.kind==='recovery'){if(alerts.issues[item.key])outbox.splice(index,1);}
    else if(!alerts.issues[item.key]){outbox.splice(index,1);cancelled++;}
   }
   for(const message of plan.sends){
    if(message.kind==='recovery'){
     // AIR-596: the prediction recovery names why it recovered (confirmed progress, or no eligible work), from the facts this tick evaluated.
     if(message.key==='predictions_no_progress'){const facts=evaluation.streams.find(stream=>stream.stream==='predictions')?.facts;message.message=policy().predictionRecoveryMessage(facts);
      if(['progress','no_eligible_work','retry_wait'].includes(facts?.recovery)){message.recoveryReason=facts.recovery;if(facts.recovery==='progress'&&facts.lastProgressAt)message.recoveryProgressAt=facts.lastProgressAt;}}
     // AIR-598: a Discovery stall recovered by the shared classification names its reason (a proven empty queue, the EPG-priority pause), never progress.
     if(message.key==='discovery_stalled'||message.key==='discovery_unconfirmed'){const facts=evaluation.streams.find(stream=>stream.stream==='discovery')?.facts,recovery=policy().discoveryRecovery(facts);message.message=recovery.message;if(recovery.reason)message.recoveryReason=recovery.reason;}
     outbox.push({...message,id:message.key+'|recovery|'+iso(now),queuedAt:iso(now)});continue;
    }
    const entry=alerts.issues[message.key],before=prior[message.key]||null;
    const after={lastSentAt:entry.lastSentAt,sendCount:entry.sendCount,sendDay:entry.sendDay,sendsToday:entry.sendsToday};
    entry.lastSentAt=before?.lastSentAt||null;entry.sendCount=before?.sendCount||0;entry.sendsToday=before?.sendDay===day?before.sendsToday||0:0;
    const pending=outbox.find(item=>item.key===message.key&&item.kind!=='recovery');
    // `observedAt` is the tick this content describes (ADR 0206 decision 9); the id and queue time of a pending message stay as they were.
    if(pending){pending.severity=message.severity;pending.critical=message.critical===true;pending.message=message.message;pending.after=after;pending.observedAt=iso(now);if(message.metrics)pending.metrics=message.metrics;else delete pending.metrics;if(message.metricsAt)pending.metricsAt=message.metricsAt;else delete pending.metricsAt;if(pending.kind!=='alert')pending.kind=message.kind;}
    else outbox.push({...message,id:message.key+'|'+message.kind+'|'+iso(now),queuedAt:iso(now),observedAt:iso(now),after});
   }
   const queued=outbox;
   const publishedRunId=facts.epg?.publishedRunId||null,predictions=facts.predictions?.present?{pendingCount:facts.predictions.pendingCount,processedTotal:facts.predictions.processedTotal,progressAt:facts.predictions.lastProgressAt,progressBasis:'evidence',unknownSince:facts.predictions.unknownSince}:doc?.predictions||null;
   const next={schemaVersion:SCHEMA_VERSION,updatedAt:iso(now),heartbeatAt:iso(now),mode:current,overall:evaluation.overall,
    streams:evaluation.streams.map(stream=>({stream:stream.stream,state:stream.state,facts:stream.facts,issues:stream.issues.map(item=>({key:item.key,severity:item.severity,critical:item.critical===true}))})),
    alerts,outbox:queued,cancelledUndelivered:cancelled,holdUntil:doc?.holdUntil||null,lastDeliveryFailure:doc?.lastDeliveryFailure||null,predictions,
    discovery:{unknownSince:evaluation.streams.find(stream=>stream.stream==='discovery')?.facts?.unknownSince??null},
    canonicalProducer:facts.canonicalProducer&&!facts.canonicalProducer.error?(facts.canonicalProducer.clock||null):doc?.canonicalProducer||null,
    epgSeen:publishedRunId&&doc?.epgSeen?.runId!==publishedRunId?{runId:publishedRunId,at:iso(now)}:doc?.epgSeen||null,lastTestAt:doc?.lastTestAt||null,
    catalogPostersBaselineAt:facts.catalogPosters?.markers?.baselineAt??doc?.catalogPostersBaselineAt??null,catalogPostersSeenAt:facts.catalogPosters?.markers?.seenAt??doc?.catalogPostersSeenAt??null};
   const claimed=await writeState(env,object,next);
   if(!claimed){log({mode:'on',overall:evaluation.overall,claimed:false});return {ran:true,mode:'on',overall:evaluation.overall,sent:0,failed:0,saved:false};}
   // Delivery is budgeted per tick: at most SEND_BUDGET attempts, and the tick stops after SEND_FAIL_STOP consecutive failures (the channel is
   // evidently down), so a long outage costs a bounded number of HTTP timeouts and never holds the cron or the other monitor work hostage.
   // The outbox is the durable queue: it is FIFO, an attempted-but-failed message moves to the tail so one bad message cannot starve the rest,
   // and whatever is not attempted waits for the next tick.
   // A rate limit (Telegram 429) is not slept on: its retry_after becomes a persisted hold, and ticks before it make no attempt.
   const delivered=new Set(),failedIds=new Set();
   let attempts=0,streak=0,holdUntil=Date.parse(doc?.holdUntil||''),lastFailure=doc?.lastDeliveryFailure||null,succeeded=false;
   const held=Number.isFinite(holdUntil)&&holdUntil>now;
   for(const message of held?[]:queued){
    if(attempts>=SEND_BUDGET||streak>=SEND_FAIL_STOP)break;
    attempts++;
    const result=await sendMessage(env,message,evaluation.overall,now);
    if(result.ok){delivered.add(message.id);streak=0;succeeded=true;}
    else{failedIds.add(message.id);streak++;lastFailure={at:iso(now),reason:result.reason};if(result.retryAfterMs){holdUntil=now+result.retryAfterMs;break;}}
   }
   let saved=true;
   if(attempts){
    const settled=JSON.parse(JSON.stringify(next.alerts));
    // ADR 0206: a delivered alert-type message settles at its successful delivery, not at the time it was queued: the reminder interval counts from
    // `now`, and the send is charged to the UTC day of delivery. `after` stays on the message only for a reader of the previous code (rollback).
    for(const item of queued){
     if(!delivered.has(item.id)||item.kind==='recovery')continue;const entry=settled.issues[item.key];if(!entry)continue;
     const sentToday=entry.sendDay===day?entry.sendsToday||0:0;
     entry.lastSentAt=iso(now);entry.sendCount=(entry.sendCount||0)+1;entry.sendDay=day;entry.sendsToday=sentToday+1;
    }
    const remaining=queued.filter(item=>!delivered.has(item.id)),reordered=[...remaining.filter(item=>!failedIds.has(item.id)),...remaining.filter(item=>failedIds.has(item.id))];
    saved=!!await writeState(env,claimed,{...next,alerts:settled,outbox:reordered,holdUntil:Number.isFinite(holdUntil)&&holdUntil>now?iso(holdUntil):null,lastDeliveryFailure:succeeded&&!failedIds.size?null:lastFailure});
   }
   await heartbeat(env);
   log({mode:'on',overall:evaluation.overall,issues:evaluation.issues.map(item=>item.key),sent:delivered.size,failed:failedIds.size,pending:queued.length-delivered.size,attempts,saved});
   return {ran:true,mode:'on',overall:evaluation.overall,sent:delivered.size,failed:failedIds.size,pending:queued.length-delivered.size,saved};
  }catch(error){log({mode:current,error:String(error?.message||'error').slice(0,120)});return {ran:false,reason:'error'};}
 }

 // The stored result as a pure read: nothing is evaluated, written or sent.
 async function status(env,now=Date.now()){
  const current=mode(env);
  let doc=null;
  try{doc=(await readState(env)).doc;}catch{doc=null;}
  // A document written before ADR 0206 may still say `needs_owner` until the next tick rewrites it; the read shows it as `degraded` (critical) and writes nothing.
  const sev=value=>policy().normalizeSeverity(value);
  const heartbeatAt=Date.parse(doc?.heartbeatAt||'');
  return {mode:current,readAt:iso(now),stored:!!doc,heartbeatAt:Number.isFinite(heartbeatAt)?iso(heartbeatAt):null,heartbeatAgeMs:Number.isFinite(heartbeatAt)?Math.max(0,now-heartbeatAt):null,
   outbox:Array.isArray(doc?.outbox)?doc.outbox.length:0,outboxOldestAt:(doc?.outbox||[]).map(item=>item.queuedAt).sort()[0]||null,cancelledUndelivered:doc?.cancelledUndelivered||0,overall:doc?.overall==null?null:sev(doc.overall),
   streams:Array.isArray(doc?.streams)?doc.streams.map(stream=>({...stream,state:sev(stream?.state),issues:Array.isArray(stream?.issues)?stream.issues.map(item=>({...item,severity:sev(item?.severity),critical:policy().isCritical(item)})):stream?.issues})):[],
   openIssues:Object.entries(doc?.alerts?.issues||{}).map(([key,entry])=>({key,severity:sev(entry.severity),critical:policy().isCritical(entry),firstSeenAt:entry.firstSeenAt,sendCount:entry.sendCount})),
   transport:transportName(env),alerting:channelReady(env),holdUntil:doc?.holdUntil||null,lastDeliveryFailure:doc?.lastDeliveryFailure||null,deadman:!!httpsUrl(env?.MONITOR_HEARTBEAT_URL),sideEffects:'none'};
 }

 // A synthetic test message through the real channel. It writes only `lastTestAt` on the monitor's own document and changes no domain state.
 async function test(env,now=Date.now()){
  // A synthetic message is an outward send and a write: only MONITOR=on may do it.
  if(mode(env)!=='on')return {sent:false,reason:'off'};
  if(!channelReady(env))return {sent:false,reason:'no_channel'};
  const {object,doc}=await readState(env);
  const hold=Date.parse(doc?.holdUntil||'');
  if(Number.isFinite(hold)&&hold>now)return {sent:false,reason:'rate_limited',holdUntil:doc.holdUntil};
  const last=Date.parse(doc?.lastTestAt||'');
  if(Number.isFinite(last)&&now-last<TEST_COOLDOWN_MS)return {sent:false,reason:'recent',lastTestAt:doc.lastTestAt};
  // Claim first: the cooldown stamp is committed before the message is sent, so concurrent requests cannot both send.
  const base=doc||{schemaVersion:SCHEMA_VERSION,updatedAt:iso(now),heartbeatAt:null,mode:mode(env),overall:null,streams:[],alerts:{issues:{}},outbox:[],predictions:null,epgSeen:null};
  const claimed=await writeState(env,object,{...base,lastTestAt:iso(now)});
  if(!claimed)return {sent:false,reason:'concurrent'};
  const result=await sendMessage(env,{id:'monitor_test|'+iso(now),kind:'test',severity:'test',stream:'monitor',key:'monitor_test',message:'Test alert from the IPTV monitor. No incident.'},doc?.overall||'unknown',now);
  if(!result.ok){await writeState(env,claimed,{...base,lastTestAt:doc?.lastTestAt||null,holdUntil:result.retryAfterMs?iso(now+result.retryAfterMs):base.holdUntil||null}).catch(()=>null);return {sent:false,reason:'delivery_failed'};}
  return {sent:true,at:iso(now)};
 }
 return {STATE_KEY,mode,run,status,test,collect,canonicalProducerFacts,internals:{telegramText}};
})();
