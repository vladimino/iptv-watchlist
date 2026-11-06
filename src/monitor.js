// AIR-349. The Cloudflare-native monitor of the four production streams (EPG, Discovery, Ratings, prediction queue), independent of any
// ChatGPT Task. It reads bounded status facts that the domains already keep (never the Discovery ledger, never programme.json), judges
// them with the pure MonitorPolicy, keeps one small state document and sends actionable alerts to an owner-approved webhook.
// It only diagnoses and reports: no recovery, no force, no reset, no write to any domain record.
// MONITOR: off (default) does nothing; dry evaluates and logs without writing or sending; on also keeps the state document
// (`monitor/state.json`) and sends alerts when MONITOR_WEBHOOK_URL is set. Concatenated into the Worker: one global, no exports.
const Monitor=(()=>{
 const STATE_KEY='monitor/state.json',SCHEMA_VERSION=1,SEND_TIMEOUT_MS=10000,TEST_COOLDOWN_MS=10*60000;
 const policy=()=>MonitorPolicy;
 const iso=ms=>new Date(ms).toISOString();
 const mode=env=>env?.MONITOR==='on'?'on':env?.MONITOR==='dry'?'dry':'off';
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
 const discoveryFacts=(env,now,pubRunId)=>guarded(async()=>{
  const executor=typeof discoveryExecutorMode==='function'?discoveryExecutorMode(env):'external';
  const [continuation,lease,last]=await Promise.all([loadJSON(env,'epg/resolver-continuation.json'),loadJSON(env,'epg/resolver-lease.json'),loadJSON(env,'epg/discovery-status.json')]);
  const health=typeof continuationHealth==='function'?continuationHealth(continuation,lease,last,now,pubRunId)?.status||null:null;
  let readout=null;
  if(executor==='workflow'&&typeof discoveryExecutorReadout==='function')readout=await discoveryExecutorReadout(env,continuation).catch(()=>null);
  const reason=String(readout?.recovery?.reason||readout?.reason||'');
  return {executor,continuation:continuation||null,health,lastChunkFinishedAt:last?.finishedAt||null,publishedRunId:pubRunId,
   readout:readout?{stalled:!!readout.stalled,quarantined:!!(readout.recovery?.quarantined||readout.quarantined)}:null,resourceLimit:/1102|memory/i.test(reason)};
 });
 const ratingsFacts=(env,now)=>guarded(async()=>{
  if(typeof RatingsOrchestration==='undefined')throw new Error('unavailable');
  return await RatingsOrchestration.readModel(env,now);
 });
 // Prediction activity is real model progress only: a productive completed run (created or recalculated films) or a moved processed
 // counter. A scheduled wake-up that found nothing to do rewrites `lastBatch` and `lastCheckAt` and is deliberately not progress.
 const predictionFacts=(env,now,previous)=>guarded(async()=>{
  const queue=await loadJSON(env,predictionQueueKey);
  if(!queue)return {present:false};
  const latest=await loadJSON(env,ENRICHMENT_KEY+'latest-run.json').catch(()=>null);
  const productiveAt=Date.parse(latest?.completedAt||''),productive=Number.isFinite(productiveAt)&&((latest?.counts?.created||0)+(latest?.counts?.recalculated||0))>0?productiveAt:null;
  const processedTotal=Number.isInteger(queue.metrics?.hotProcessedTotal)?queue.metrics.hotProcessedTotal:null;
  const moved=Number.isInteger(processedTotal)&&Number.isInteger(previous?.processedTotal)&&processedTotal>previous.processedTotal;
  const known=Date.parse(previous?.progressAt||'');
  const candidates=[productive,moved?now:null,Number.isFinite(known)?known:null].filter(value=>value!==null);
  const lastProgressAt=candidates.length?Math.max(...candidates):now;
  const outstanding=[...new Set([...(queue.hotPending||[]),...(queue.coldPending||[])])];
  const deferred=outstanding.map(id=>queue.retries?.[id]?.retryAt).filter(value=>typeof value==='number'&&value>now);
  return {present:true,pendingCount:Array.isArray(queue.pending)?queue.pending.length:0,processedTotal,lastProgressAt:iso(lastProgressAt),
   eligibleNow:outstanding.length-deferred.length,nextRetryAt:deferred.length?iso(Math.min(...deferred)):null,blockedReason:queue.lastBatch?.stage==='blocked'?String(queue.lastBatch.reason||'').slice(0,40):null};
 });
 async function collect(env,now,state){
  const epg=await epgFacts(env,now,state?.epgSeen||null);
  const [discovery,ratings,predictions]=await Promise.all([discoveryFacts(env,now,epg?.publishedRunId||null),ratingsFacts(env,now),predictionFacts(env,now,state?.predictions||null)]);
  return {epg,discovery,ratings,predictions};
 }

 // ---- delivery: a single owner-approved HTTPS webhook; the payload carries no titles, ratings, credentials or private data.
 async function sendMessage(env,message,overall,now){
  const url=httpsUrl(env?.MONITOR_WEBHOOK_URL);
  if(!url)return false;
  try{
   const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json'},signal:AbortSignal.timeout(SEND_TIMEOUT_MS),
    body:JSON.stringify({source:'iptv-monitor',id:message.id||null,at:iso(now),kind:message.kind,severity:message.severity,stream:message.stream,key:message.key,message:message.message,overall})});
   return response.ok;
  }catch{return false;}
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
   const {object,doc}=current==='on'?await readState(env):{object:null,doc:null};
   const facts=await collect(env,now,doc);
   const evaluation=policy().evaluateAll(facts,{predictions:doc?.predictions||null},now,{dailyDue:OrchestrationPolicy.dailyDue});
   const plan=policy().planAlerts(evaluation.issues,doc?.alerts||{issues:{}},now);
   if(current==='dry'){log({mode:'dry',overall:evaluation.overall,issues:evaluation.issues.map(item=>item.key),wouldSend:plan.sends.length});return {ran:true,mode:'dry',overall:evaluation.overall,wouldSend:plan.sends.length};}
   // Claim before delivery. The planned messages are committed to `monitor/state.json` (as the plan's alert state and an outbox with stable
   // ids) with a compare-and-swap first; only the tick that wins that commit sends them, so ticks reading the same snapshot never both
   // send. A message that is not delivered stays in the outbox and is retried with the same id. Delivery is at-least-once: a crash after
   // the claim, or a failed commit of the delivered mark, can repeat a message, and the stable `id` lets the receiver drop the repeat.
   // The outbox keeps an undelivered notification until it is delivered; nothing is aged out or evicted. It is bounded by construction: at most
   // one pending alert-type message per issue key (a newer message for the same key replaces the pending one in place) plus recoveries.
   // Alert accounting (lastSentAt, sendCount, sendsToday) moves only when delivery succeeds, so a failed send never spends the cooldown or the
   // daily quota, and an alert that was never delivered raises no recovery: if its issue clears first it is cancelled and counted.
   const alerts=plan.state,prior=doc?.alerts?.issues||{},day=iso(now).slice(0,10);
   const outbox=(doc?.outbox||[]).map(item=>({...item}));
   let cancelled=doc?.cancelledUndelivered||0;
   for(let index=outbox.length-1;index>=0;index--){if(outbox[index].kind!=='recovery'&&!alerts.issues[outbox[index].key]){outbox.splice(index,1);cancelled++;}}
   for(const message of plan.sends){
    if(message.kind==='recovery'){outbox.push({...message,id:message.key+'|recovery|'+iso(now),queuedAt:iso(now)});continue;}
    const entry=alerts.issues[message.key],before=prior[message.key]||null;
    const after={lastSentAt:entry.lastSentAt,sendCount:entry.sendCount,sendDay:entry.sendDay,sendsToday:entry.sendsToday};
    entry.lastSentAt=before?.lastSentAt||null;entry.sendCount=before?.sendCount||0;entry.sendsToday=before?.sendDay===day?before.sendsToday||0:0;
    const pending=outbox.find(item=>item.key===message.key&&item.kind!=='recovery');
    if(pending){pending.severity=message.severity;pending.message=message.message;pending.after=after;if(pending.kind!=='alert')pending.kind=message.kind;}
    else outbox.push({...message,id:message.key+'|'+message.kind+'|'+iso(now),queuedAt:iso(now),after});
   }
   const queued=outbox;
   const publishedRunId=facts.epg?.publishedRunId||null,predictions=facts.predictions?.present?{pendingCount:facts.predictions.pendingCount,processedTotal:facts.predictions.processedTotal,progressAt:facts.predictions.lastProgressAt}:doc?.predictions||null;
   const next={schemaVersion:SCHEMA_VERSION,updatedAt:iso(now),heartbeatAt:iso(now),mode:current,overall:evaluation.overall,
    streams:evaluation.streams.map(stream=>({stream:stream.stream,state:stream.state,facts:stream.facts,issues:stream.issues.map(item=>({key:item.key,severity:item.severity}))})),
    alerts,outbox:queued,cancelledUndelivered:cancelled,predictions,
    epgSeen:publishedRunId&&doc?.epgSeen?.runId!==publishedRunId?{runId:publishedRunId,at:iso(now)}:doc?.epgSeen||null,lastTestAt:doc?.lastTestAt||null};
   const claimed=await writeState(env,object,next);
   if(!claimed){log({mode:'on',overall:evaluation.overall,claimed:false});return {ran:true,mode:'on',overall:evaluation.overall,sent:0,failed:0,saved:false};}
   const delivered=new Set();
   for(const message of queued){if(await sendMessage(env,message,evaluation.overall,now))delivered.add(message.id);}
   let saved=true;
   if(delivered.size){
    const settled=JSON.parse(JSON.stringify(next.alerts));
    for(const item of queued){if(!delivered.has(item.id)||!item.after)continue;const entry=settled.issues[item.key];if(!entry)continue;entry.lastSentAt=item.after.lastSentAt;entry.sendCount=Math.max(entry.sendCount,item.after.sendCount);entry.sendDay=item.after.sendDay;entry.sendsToday=item.after.sendsToday;}
    saved=!!await writeState(env,claimed,{...next,alerts:settled,outbox:queued.filter(item=>!delivered.has(item.id))});
   }
   await heartbeat(env);
   log({mode:'on',overall:evaluation.overall,issues:evaluation.issues.map(item=>item.key),sent:delivered.size,failed:queued.length-delivered.size,saved});
   return {ran:true,mode:'on',overall:evaluation.overall,sent:delivered.size,failed:queued.length-delivered.size,saved};
  }catch(error){log({mode:current,error:String(error?.message||'error').slice(0,120)});return {ran:false,reason:'error'};}
 }

 // The stored result as a pure read: nothing is evaluated, written or sent.
 async function status(env,now=Date.now()){
  const current=mode(env);
  let doc=null;
  try{doc=(await readState(env)).doc;}catch{doc=null;}
  const heartbeatAt=Date.parse(doc?.heartbeatAt||'');
  return {mode:current,readAt:iso(now),stored:!!doc,heartbeatAt:Number.isFinite(heartbeatAt)?iso(heartbeatAt):null,heartbeatAgeMs:Number.isFinite(heartbeatAt)?Math.max(0,now-heartbeatAt):null,
   outbox:Array.isArray(doc?.outbox)?doc.outbox.length:0,outboxOldestAt:(doc?.outbox||[]).map(item=>item.queuedAt).sort()[0]||null,cancelledUndelivered:doc?.cancelledUndelivered||0,overall:doc?.overall??null,streams:doc?.streams??[],openIssues:Object.entries(doc?.alerts?.issues||{}).map(([key,entry])=>({key,severity:entry.severity,firstSeenAt:entry.firstSeenAt,sendCount:entry.sendCount})),
   alerting:!!httpsUrl(env?.MONITOR_WEBHOOK_URL),deadman:!!httpsUrl(env?.MONITOR_HEARTBEAT_URL),sideEffects:'none'};
 }

 // A synthetic test message through the real channel. It writes only `lastTestAt` on the monitor's own document and changes no domain state.
 async function test(env,now=Date.now()){
  if(mode(env)==='off')return {sent:false,reason:'off'};
  if(!httpsUrl(env?.MONITOR_WEBHOOK_URL))return {sent:false,reason:'no_channel'};
  const {object,doc}=await readState(env);
  const last=Date.parse(doc?.lastTestAt||'');
  if(Number.isFinite(last)&&now-last<TEST_COOLDOWN_MS)return {sent:false,reason:'recent',lastTestAt:doc.lastTestAt};
  // Claim first: the cooldown stamp is committed before the message is sent, so concurrent requests cannot both send.
  const base=doc||{schemaVersion:SCHEMA_VERSION,updatedAt:iso(now),heartbeatAt:null,mode:mode(env),overall:null,streams:[],alerts:{issues:{}},outbox:[],predictions:null,epgSeen:null};
  const claimed=await writeState(env,object,{...base,lastTestAt:iso(now)});
  if(!claimed)return {sent:false,reason:'concurrent'};
  const delivered=await sendMessage(env,{id:'monitor_test|'+iso(now),kind:'test',severity:'test',stream:'monitor',key:'monitor_test',message:'Test alert from the IPTV monitor. No incident.'},doc?.overall||'unknown',now);
  if(!delivered){await writeState(env,claimed,{...base,lastTestAt:doc?.lastTestAt||null}).catch(()=>null);return {sent:false,reason:'delivery_failed'};}
  return {sent:true,at:iso(now)};
 }
 return {STATE_KEY,mode,run,status,test,collect};
})();
