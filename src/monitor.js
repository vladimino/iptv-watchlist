// AIR-349. The Cloudflare-native monitor of the four production streams (EPG, Discovery, Ratings, prediction queue), independent of any
// ChatGPT Task. It reads bounded status facts that the domains already keep (never the Discovery ledger, never programme.json), judges
// them with the pure MonitorPolicy, keeps one small state document and sends actionable alerts to an owner-approved webhook.
// It only diagnoses and reports: no recovery, no force, no reset, no write to any domain record.
// MONITOR: off (default) does nothing; dry evaluates and logs without writing or sending; on also keeps the state document
// (`monitor/state.json`) and sends alerts when MONITOR_WEBHOOK_URL is set. Concatenated into the Worker: one global, no exports.
const Monitor=(()=>{
 const STATE_KEY='monitor/state.json',SCHEMA_VERSION=1,SEND_TIMEOUT_MS=10000,TEST_COOLDOWN_MS=10*60000,SEND_BUDGET=5,SEND_FAIL_STOP=2;
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

 // ---- delivery: one transport chosen by deliberate configuration. `MONITOR_TRANSPORT` absent or `webhook` is the generic JSON webhook
 // (MONITOR_WEBHOOK_URL); `telegram` is the Telegram Bot API `sendMessage` (AIR-365); any other value is invalid and fails closed.
 // Neither payload carries titles, ratings, credentials or private data. A transport answers {ok, reason, retryAfterMs?}: reasons are fixed
 // codes, never response bodies, URLs or configuration values.
 const transportName=env=>{const value=env?.MONITOR_TRANSPORT;return value===undefined||value===null||value===''||value==='webhook'?'webhook':value==='telegram'?'telegram':'invalid';};
 // The token and chat id come only from Cloudflare secrets/bindings and are shape-checked; the destination is the fixed Bot API endpoint.
 const TELEGRAM_TOKEN=/^\d{5,15}:[A-Za-z0-9_-]{30,60}$/,TELEGRAM_CHAT=/^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
 const telegramConfig=env=>{const token=typeof env?.MONITOR_TELEGRAM_BOT_TOKEN==='string'?env.MONITOR_TELEGRAM_BOT_TOKEN.trim():'',chat=typeof env?.MONITOR_TELEGRAM_CHAT_ID==='string'?env.MONITOR_TELEGRAM_CHAT_ID.trim():'';return TELEGRAM_TOKEN.test(token)&&TELEGRAM_CHAT.test(chat)?{token,chat}:null;};
 const channelReady=env=>{const name=transportName(env);return name==='telegram'?!!telegramConfig(env):name==='webhook'?!!httpsUrl(env?.MONITOR_WEBHOOK_URL):false;};
 const TELEGRAM_KIND={alert:'ALERT',reminder:'REMINDER',escalation:'ESCALATION',recovery:'RECOVERED',test:'TEST'};
 const plain=(value,max)=>String(value??'').replace(/[^\x20-\x7E]+/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
 // Plain text only (no markup mode is requested), so nothing is interpreted; fields are ASCII-limited and bounded well under Telegram's 4096 characters.
 const telegramText=(message,overall,now)=>[
  'IPTV monitor: '+(TELEGRAM_KIND[message.kind]||'MESSAGE')+' ('+plain(message.severity,16)+')',
  'Stream: '+plain(message.stream,32),'Issue: '+plain(message.key,64),plain(message.message,300),
  'Overall: '+plain(overall||'unknown',16),'At: '+iso(now),'Ref: '+plain(message.id,120)].join('\n');
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
    body:JSON.stringify({source:'iptv-monitor',id:message.id||null,at:iso(now),kind:message.kind,severity:message.severity,stream:message.stream,key:message.key,message:message.message,overall})});
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
   // Reconcile the queue with the current issues: a pending alert of a cleared issue is cancelled (counted), and a pending recovery of an issue
   // that is active again is superseded (the new alert replaces it), so an obsolete "Recovered" is never sent.
   for(let index=outbox.length-1;index>=0;index--){
    const item=outbox[index];
    if(item.kind==='recovery'){if(alerts.issues[item.key])outbox.splice(index,1);}
    else if(!alerts.issues[item.key]){outbox.splice(index,1);cancelled++;}
   }
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
    alerts,outbox:queued,cancelledUndelivered:cancelled,holdUntil:doc?.holdUntil||null,lastDeliveryFailure:doc?.lastDeliveryFailure||null,predictions,
    epgSeen:publishedRunId&&doc?.epgSeen?.runId!==publishedRunId?{runId:publishedRunId,at:iso(now)}:doc?.epgSeen||null,lastTestAt:doc?.lastTestAt||null};
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
    for(const item of queued){if(!delivered.has(item.id)||!item.after)continue;const entry=settled.issues[item.key];if(!entry)continue;entry.lastSentAt=item.after.lastSentAt;entry.sendCount=Math.max(entry.sendCount,item.after.sendCount);entry.sendDay=item.after.sendDay;entry.sendsToday=item.after.sendsToday;}
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
  const heartbeatAt=Date.parse(doc?.heartbeatAt||'');
  return {mode:current,readAt:iso(now),stored:!!doc,heartbeatAt:Number.isFinite(heartbeatAt)?iso(heartbeatAt):null,heartbeatAgeMs:Number.isFinite(heartbeatAt)?Math.max(0,now-heartbeatAt):null,
   outbox:Array.isArray(doc?.outbox)?doc.outbox.length:0,outboxOldestAt:(doc?.outbox||[]).map(item=>item.queuedAt).sort()[0]||null,cancelledUndelivered:doc?.cancelledUndelivered||0,overall:doc?.overall??null,streams:doc?.streams??[],openIssues:Object.entries(doc?.alerts?.issues||{}).map(([key,entry])=>({key,severity:entry.severity,firstSeenAt:entry.firstSeenAt,sendCount:entry.sendCount})),
   transport:transportName(env),alerting:channelReady(env),holdUntil:doc?.holdUntil||null,lastDeliveryFailure:doc?.lastDeliveryFailure||null,deadman:!!httpsUrl(env?.MONITOR_HEARTBEAT_URL),sideEffects:'none'};
 }

 // A synthetic test message through the real channel. It writes only `lastTestAt` on the monitor's own document and changes no domain state.
 async function test(env,now=Date.now()){
  // A synthetic message is an outward send and a write: only MONITOR=on may do it (dry sends and writes nothing, whatever the route).
  if(mode(env)==='off')return {sent:false,reason:'off'};
  if(mode(env)!=='on')return {sent:false,reason:'dry'};
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
 return {STATE_KEY,mode,run,status,test,collect,internals:{telegramText}};
})();
