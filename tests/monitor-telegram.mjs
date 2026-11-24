// AIR-365: the Telegram Bot API transport of the monitor. A fake api.telegram.org scripts every answer (ok, 200 with ok:false, 401/403, 429 with
// retry_after, timeout, network error, malformed JSON); the monitor keeps the AIR-349 outbox semantics on top of it. Nothing here calls Telegram,
// Cloudflare or the network. The token and the chat id below are fixtures, not real credentials.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,MIN=60000,at=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-06T22:00:00Z');
const KEY='monitor/state.json';
const TOKEN='123456789:AAFixtureTokenFixtureTokenFixtureToken_1',CHAT='-1001234567890';
const SEND_URL='https://api.telegram.org/bot'+TOKEN+'/sendMessage';

// `code` replays another policy/runtime pair over the same bucket (AIR-592 rollback: the pre-ADR-0206 sources kept as fixtures).
function setup(extraEnv={},{bucket=makeBucket(),policyFile='src/domain/monitor-policy.js',monitorFile='src/monitor.js'}={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const logs=[];ctx.console={log:line=>logs.push(String(line)),warn:line=>logs.push(String(line)),error:line=>logs.push(String(line))};
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped(policyFile,'MonitorPolicy')+'\n'+scoped('src/domain/monitor-message.js','MonitorMessage')+'\n'+fs.readFileSync(monitorFile,'utf8'),ctx);
 const calls=[];let script=()=>({status:200,body:{ok:true,result:{message_id:1}}});
 ctx.fetch=async(url,options={})=>{
  const entry={url:String(url),method:options.method||'GET',body:options.body?JSON.parse(options.body):null};calls.push(entry);
  if(String(url).startsWith('https://api.telegram.org/')){
   const answer=script(entry);
   if(answer.throw)throw answer.throw;
   return new Response(answer.raw!==undefined?answer.raw:JSON.stringify(answer.body),{status:answer.status,headers:answer.headers||{}});
  }
  if(String(url).startsWith('https://hooks.example/'))return new Response('',{status:200});
  if(String(url).startsWith('https://beat.example/'))return new Response('ok');
  throw new Error('unexpected network '+url);
 };
 ctx.RatingsOrchestration={async readModel(){return ctx.model;}};ctx.model={mode:'cloudflare',health:'healthy',failure:null};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_TRANSPORT:'telegram',MONITOR_TELEGRAM_BOT_TOKEN:TOKEN,MONITOR_TELEGRAM_CHAT_ID:CHAT,MONITOR_HEARTBEAT_URL:'https://beat.example/ping',...extraEnv});
 return {clock,bucket,ctx,env,calls,logs,M:g(ctx,'Monitor'),answer:fn=>{script=fn;}};
}
function healthy(bucket,{publishedAt=at(T0-3*H),runId='run-a'}={}){
 bucket.set('sync.json',{runId,stage:'complete',updatedAt:publishedAt,failures:[]});
 bucket.set('epg/published-generation.json',{programmeRunId:runId,phase:'published'});
 bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:publishedAt,lastBatch:null});
}
const tg=calls=>calls.filter(item=>item.url.startsWith('https://api.telegram.org/'));
const owner=t=>{t.ctx.model={mode:'cloudflare',health:'quarantined',quarantine:{reason:'budget_exhausted'}};};
const seedRecoveries=(t,count)=>{const doc=t.bucket.value(KEY);doc.outbox=Array.from({length:count},(_,index)=>({id:'seed_'+index+'|recovery|x',kind:'recovery',severity:'healthy',stream:'epg',key:'seed_'+index,message:'Recovered',queuedAt:at(T0)}));t.bucket.set(KEY,doc);};

// 1. The fixed Bot API endpoint, a plain-text body and the AIR-349 accounting: a critical issue (ADR 0206) alerts at once, delivered once.
{
 const t=setup();healthy(t.bucket);owner(t);
 const result=plain(await t.M.run(t.env,{now:T0}));assert.deepEqual([result.sent,result.failed],[1,0]);
 const sent=tg(t.calls);assert.equal(sent.length,1);
 assert.equal(sent[0].url,SEND_URL,'the destination is the fixed Bot API endpoint');assert.equal(sent[0].method,'POST');
 assert.deepEqual(Object.keys(sent[0].body).sort(),['chat_id','disable_web_page_preview','text'],'no parse_mode: plain text');
 assert.equal(sent[0].body.chat_id,CHAT);assert.equal(sent[0].body.disable_web_page_preview,true);
 const lines=sent[0].body.text.split('\n');
 assert.equal(lines[0],'🚨 Сбой · Оценки');assert.equal(lines[1],'Оценки в карантине');assert.ok(lines.includes('Причина: budget_exhausted'),'typed metric, not the English sentence');
 assert.equal(lines[2],'🔴 Критичный сбой');assert.ok(lines.includes('🌐 В целом: есть проблемы'));assert.equal(lines[3],'','blocks are separated by real empty lines');
 assert.ok(lines.includes('06.11 23:00:00 · Мадрид'),'Madrid time, labelled');assert.ok(lines.at(-1).startsWith('Ref: ratings_quarantined|alert|'),'the stable id is the last line');
 const doc=t.bucket.value(KEY);assert.deepEqual(doc.outbox,[]);assert.equal(doc.alerts.issues.ratings_quarantined.sendCount,1);assert.equal(doc.lastDeliveryFailure,null);
 assert.equal(t.calls.filter(item=>item.method==='GET').length,1,'the heartbeat ping is unchanged');
}

// 2. Alert, reminder, escalation, recovery and test are told apart.
{
 const t=setup();
 const text=kind=>(t.M.internals.telegramText({kind,severity:'degraded',stream:'epg',key:'epg_stale',message:'No generation published',id:'x'},'degraded',T0)).split('\n')[0];
 assert.deepEqual(['alert','reminder','escalation','recovery','test'].map(text),['⚠️ Проблема · Программа','🔁 Напоминание · Программа','⛔ Ухудшение · Программа','✅ Проблема снята · Программа','🧪 Тест · Программа']);
 assert.equal(t.M.internals.telegramText({kind:'alert',severity:'degraded',critical:true,stream:'epg',key:'epg_authority',id:'x'},'degraded',T0).split('\n')[0],'🚨 Сбой · Программа','a critical alert has its own marker');
}

// 3. Plain-text encoding: every dynamic value is reduced to printable ASCII (codes, the legacy English detail, the id) and bounded; only the fixed
// Russian labels and emoji of the renderer are non-ASCII. Markup, control and direction characters cannot get in and a newline cannot add lines.
{
 const t=setup();
 const body=t.M.internals.telegramText({kind:'alert',severity:'degraded',stream:'epg\n<b>',key:'k_<i>*[x](y)',message:'<b>bold</b> *a* _b_ `c` [l](http://x) é\u0007\u202e\n\nline'+'z'.repeat(2000),metrics:{reason:'r\n\u202ex'},id:'id\n'+'q'.repeat(500)},'degraded',T0);
 const fixed=new Set([...fs.readFileSync('src/domain/monitor-message.js','utf8')].filter(ch=>ch.codePointAt(0)>0x7e));fixed.add('\u00a0'); // the non-breaking thousands separator
 assert.ok([...body].every(ch=>ch==='\n'||(ch.codePointAt(0)>=0x20&&ch.codePointAt(0)<=0x7e)||fixed.has(ch)),'non-ASCII only from the fixed labels');
 assert.doesNotMatch(body,/[\u0000-\u0009\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]|é/,'no control, direction or foreign character');
 assert.ok(body.length<=1800,'far below the 4096-character Telegram limit');
 const lines=body.split('\n');assert.equal(lines[0],'⚠️ Проблема · epgb','an unknown stream is shown as its sanitized code');assert.ok(lines.find(line=>line.startsWith('Детали: ')).length<=210,'the legacy detail is bounded');
 assert.equal(lines.filter(line=>line.startsWith('Ref: ')).length,1);assert.ok(lines.at(-1).length<=205,'the id is kept whole up to 200 characters, never more');
}

// 4. A failed Telegram answer is never a delivery: the message stays queued, nothing is counted and the reason is a fixed code.
{
 const cases=[
  ['http 200 with ok:false',()=>({status:200,body:{ok:false,error_code:400,description:'chat not found'}}),'telegram_not_ok'],
  ['401',()=>({status:401,body:{ok:false,error_code:401,description:'Unauthorized'}}),'http_401'],
  ['403',()=>({status:403,body:{ok:false,error_code:403,description:'Forbidden: bot was blocked'}}),'http_403'],
  ['500 with no body',()=>({status:500,raw:''}),'http_500'],
  ['malformed JSON',()=>({status:200,raw:'<html>not json</html>'}),'malformed_response'],
  ['network error',()=>({throw:new TypeError('fetch failed for '+SEND_URL)}),'network'],
  ['timeout',()=>({throw:Object.assign(new Error('The operation was aborted'),{name:'TimeoutError'})}),'timeout']];
 for(const [label,answer,reason] of cases){
  const t=setup();healthy(t.bucket);owner(t);t.answer(answer);
  const result=plain(await t.M.run(t.env,{now:T0}));assert.deepEqual([result.sent,result.failed],[0,1],label);
  const doc=t.bucket.value(KEY);assert.equal(doc.outbox.length,1,label+': the claimed message stays queued');
  assert.deepEqual([doc.alerts.issues.ratings_quarantined.sendCount,doc.alerts.issues.ratings_quarantined.lastSentAt],[0,null],label+': a failed send is not counted');
  assert.deepEqual(doc.lastDeliveryFailure,{at:at(T0),reason},label);assert.equal(doc.holdUntil,null,label+': only a 429 sets a hold');
  const blob=JSON.stringify([doc,plain(await t.M.status(t.env,T0)),t.logs]);
  assert.ok(!blob.includes(TOKEN)&&!blob.includes('123456789')&&!blob.includes(CHAT)&&!/chat not found|bot was blocked/.test(blob),label+': the state, the status and the log carry no token, chat id or Telegram text');
  t.answer(()=>({status:200,body:{ok:true,result:{}}}));
  const retry=plain(await t.M.run(t.env,{now:T0+H}));assert.deepEqual([retry.sent,retry.failed],[1,0],label+': the next tick retries');
  const done=t.bucket.value(KEY);assert.deepEqual(done.outbox,[]);assert.equal(done.alerts.issues.ratings_quarantined.sendCount,1);assert.equal(done.lastDeliveryFailure,null,'a delivery clears the failure note');
  assert.equal(new Set(tg(t.calls).map(item=>item.body.text.split('\n').find(line=>line.startsWith('Ref: ')))).size,1,'the retry carries the same Ref (no recipient-side dedupe exists, so a crash before the commit can repeat it)');
 }
}

// 5. 429 respects retry_after without sleeping: a persisted hold, no attempt before it, and the message is not lost or counted.
{
 const t=setup();healthy(t.bucket);owner(t);
 t.answer(()=>({status:429,body:{ok:false,error_code:429,description:'Too Many Requests: retry after 3000',parameters:{retry_after:3000}},headers:{'retry-after':'3000'}}));
 let result=plain(await t.M.run(t.env,{now:T0}));assert.deepEqual([result.sent,result.failed],[0,1]);
 let doc=t.bucket.value(KEY);assert.equal(doc.holdUntil,at(T0+3000*1000));assert.equal(doc.lastDeliveryFailure.reason,'rate_limited');assert.equal(doc.outbox.length,1);assert.equal(doc.alerts.issues.ratings_quarantined.sendCount,0);
 const before=tg(t.calls).length;
 result=plain(await t.M.run(t.env,{now:T0+10*MIN}));assert.equal(tg(t.calls).length,before,'inside the hold no request is made');assert.equal(t.bucket.value(KEY).outbox.length,1);assert.equal(t.bucket.value(KEY).holdUntil,at(T0+3000*1000),'the hold is kept');
 assert.equal(plain(await t.M.status(t.env,T0+10*MIN)).holdUntil,at(T0+3000*1000));
 assert.equal(plain(await t.M.test(t.env,T0+10*MIN)).reason,'rate_limited','a synthetic test is not sent inside the hold');assert.equal(tg(t.calls).length,before);
 t.answer(()=>({status:200,body:{ok:true,result:{}}}));
 result=plain(await t.M.run(t.env,{now:T0+51*MIN}));assert.deepEqual([result.sent,result.failed],[1,0],'the first tick after the hold delivers');
 doc=t.bucket.value(KEY);assert.deepEqual([doc.outbox,doc.holdUntil,doc.alerts.issues.ratings_quarantined.sendCount],[[],null,1]);
 // The hold is capped at one hour, defaults to a minute without retry_after and also reads the Retry-After header.
 const cap=setup();healthy(cap.bucket);owner(cap);cap.answer(()=>({status:429,body:{ok:false,parameters:{retry_after:999999}}}));await cap.M.run(cap.env,{now:T0});assert.equal(cap.bucket.value(KEY).holdUntil,at(T0+H));
 const none=setup();healthy(none.bucket);owner(none);none.answer(()=>({status:429,body:{ok:false}}));await none.M.run(none.env,{now:T0});assert.equal(none.bucket.value(KEY).holdUntil,at(T0+MIN));
 const header=setup();healthy(header.bucket);owner(header);header.answer(()=>({status:429,raw:'',headers:{'retry-after':'120'}}));await header.M.run(header.env,{now:T0});assert.equal(header.bucket.value(KEY).holdUntil,at(T0+120000));
}

// 6. Missing, malformed or ambiguous configuration fails closed: no request at all, the queue is kept, the status says so without a secret.
{
 const bad=[
  ['no token',{MONITOR_TELEGRAM_BOT_TOKEN:undefined}],['no chat id',{MONITOR_TELEGRAM_CHAT_ID:undefined}],
  ['malformed token',{MONITOR_TELEGRAM_BOT_TOKEN:'not-a-token'}],['token with a path',{MONITOR_TELEGRAM_BOT_TOKEN:TOKEN+'/../evil'}],
  ['malformed chat id',{MONITOR_TELEGRAM_CHAT_ID:'chat 1'}],['empty chat id',{MONITOR_TELEGRAM_CHAT_ID:''}],['invalid transport',{MONITOR_TRANSPORT:'Telegram'}],['unknown transport',{MONITOR_TRANSPORT:'slack'}]];
 for(const [label,extra] of bad){
  const t=setup(extra);healthy(t.bucket);owner(t);
  const result=plain(await t.M.run(t.env,{now:T0}));assert.equal(result.sent,0,label);
  assert.equal(tg(t.calls).length,0,label+': no request to Telegram');assert.equal(t.calls.filter(item=>item.method==='POST').length,0,label+': no request to any channel');
  const doc=t.bucket.value(KEY);assert.equal(doc.outbox.length,1,label+': the alert stays queued for the first valid configuration');assert.equal(doc.alerts.issues.ratings_quarantined.sendCount,0);
  const status=plain(await t.M.status(t.env,T0));assert.equal(status.alerting,false,label);assert.equal(plain(await t.M.test(t.env,T0)).reason,'no_channel',label);
  assert.ok(!JSON.stringify([status,doc,t.logs]).includes(TOKEN),label+': no token anywhere');
 }
 // A valid configuration afterwards delivers the queued alert.
 const t=setup({MONITOR_TELEGRAM_CHAT_ID:undefined});healthy(t.bucket);owner(t);await t.M.run(t.env,{now:T0});
 const result=plain(await t.M.run({...t.env,MONITOR_TELEGRAM_CHAT_ID:CHAT},{now:T0+H}));assert.deepEqual([result.sent,t.bucket.value(KEY).outbox.length],[1,0]);
}

// 7. The transport is chosen only by MONITOR_TRANSPORT: with the Telegram secrets set but no choice, the generic webhook still works unchanged.
{
 const t=setup({MONITOR_TRANSPORT:undefined,MONITOR_WEBHOOK_URL:'https://hooks.example/alert'});healthy(t.bucket);owner(t);
 const result=plain(await t.M.run(t.env,{now:T0}));assert.equal(result.sent,1);
 assert.equal(tg(t.calls).length,0,'Telegram is not used unless it is chosen');
 const posted=t.calls.filter(item=>item.url.startsWith('https://hooks.example/'));assert.equal(posted.length,1);assert.deepEqual(Object.keys(posted[0].body).sort(),['at','critical','id','key','kind','message','overall','severity','source','stream']);
 const status=plain(await t.M.status(t.env,T0));assert.deepEqual([status.transport,status.alerting],['webhook',true]);
 const chosen=setup({MONITOR_WEBHOOK_URL:'https://hooks.example/alert'});healthy(chosen.bucket);owner(chosen);await chosen.M.run(chosen.env,{now:T0});
 assert.equal(chosen.calls.filter(item=>item.url.startsWith('https://hooks.example/')).length,0,'a chosen Telegram transport never falls back to the webhook');assert.equal(tg(chosen.calls).length,1);
 assert.equal(plain(await chosen.M.status(chosen.env,T0)).transport,'telegram');
}

// 8. MONITOR off (and the retired dry token, which is off): no request, no write, whatever the configuration.
{
 const t=setup();healthy(t.bucket);owner(t);
 assert.equal(plain(await t.M.run({...t.env,MONITOR:undefined},{now:T0})).ran,false);assert.equal(plain(await t.M.run({...t.env,MONITOR:'dry'},{now:T0})).ran,false,'the retired dry token is off');
 assert.equal(t.calls.length,0);assert.equal(t.bucket.writes().length,0);
 // The synthetic test is an outward send and a write: only MONITOR=on may do it; off, the retired dry and unknown values refuse, for Telegram and for the generic webhook.
 for(const extra of [{},{MONITOR_TRANSPORT:'webhook',MONITOR_WEBHOOK_URL:'https://hooks.example/alert'}]){
  const x=setup(extra);healthy(x.bucket);
  for(const [value,reason] of [[undefined,'off'],['off','off'],['dry','off'],['garbage','off']]){
   const answer=plain(await x.M.test({...x.env,...extra,MONITOR:value},T0));assert.deepEqual([answer.sent,answer.reason],[false,reason],String(value));
  }
  assert.equal(x.calls.length,0,'no outbound request from test() in a non-on mode');assert.equal(x.bucket.writes().length,0,'no bucket write from test() in a non-on mode');
 }
}

// 9. The AIR-349 budget holds over Telegram: two attempts per tick on a failing channel, five per tick on a working one, FIFO with rotation, no loss.
{
 const t=setup();healthy(t.bucket);await t.M.run(t.env,{now:T0});seedRecoveries(t,30);
 t.answer(()=>({status:500,raw:''}));const before=tg(t.calls).length;await t.M.run(t.env,{now:T0+H});
 assert.equal(tg(t.calls).length-before,2,'an outage costs two attempts per tick');assert.equal(t.bucket.value(KEY).outbox.length,30,'nothing is lost');
 assert.deepEqual(t.bucket.value(KEY).outbox.slice(0,3).map(item=>item.id.slice(0,2)),['se','se','se']);assert.deepEqual(t.bucket.value(KEY).outbox.slice(-2).map(item=>item.id),['seed_0|recovery|x','seed_1|recovery|x'],'failed heads moved to the tail');
 t.answer(()=>({status:200,body:{ok:true,result:{}}}));let hour=2;
 for(;t.bucket.value(KEY).outbox.length&&hour<20;hour++)await t.M.run(t.env,{now:T0+hour*H});
 assert.equal(hour,8,'drained at five per tick');assert.equal(new Set(tg(t.calls).filter(item=>item.body.text.startsWith('✅ Проблема снята')).map(item=>item.body.text.split('\n').find(line=>line.startsWith('Ref: ')))).size,30,'all thirty Refs were delivered');
}

// 10. Concurrent ticks send once over Telegram; a recovery superseded by a reoccurrence is never sent.
{
 const t=setup();healthy(t.bucket);owner(t);await t.M.run(t.env,{now:T0});t.ctx.model={mode:'cloudflare',health:'healthy',failure:null};
 t.answer(()=>({status:500,raw:''}));await t.M.run(t.env,{now:T0+H});
 assert.deepEqual(t.bucket.value(KEY).outbox.map(item=>item.kind),['recovery']);owner(t);
 t.answer(()=>({status:200,body:{ok:true,result:{}}}));const before=tg(t.calls).length;await t.M.run(t.env,{now:T0+2*H});
 const fresh=tg(t.calls).slice(before);assert.deepEqual(fresh.map(item=>item.body.text.split('\n')[0]),['🚨 Сбой · Оценки'],'only the new alert is sent: the pending recovery was superseded');
 assert.deepEqual(t.bucket.value(KEY).outbox,[]);
}
{
 const t=setup();healthy(t.bucket);await t.M.run(t.env,{now:T0});owner(t);
 const results=plain(await Promise.all([t.M.run(t.env,{now:T0+H}),t.M.run(t.env,{now:T0+H})]));
 assert.equal(tg(t.calls).length,1,'two ticks that read the same snapshot send once');assert.equal(results.filter(item=>item.saved===false).length,1);
}

// 11. The synthetic test goes through Telegram, claims its cooldown first, and a failed delivery restores the stamp.
{
 const t=setup();healthy(t.bucket);await t.M.run(t.env,{now:T0});
 const sent=plain(await t.M.test(t.env,T0+MIN));assert.equal(sent.sent,true);
 const message=tg(t.calls).at(-1);assert.equal(message.body.text.split('\n')[0],'🧪 Тест · Монитор');assert.match(message.body.text,/инцидента нет/);
 assert.equal(t.bucket.value(KEY).lastTestAt,at(T0+MIN));assert.equal(plain(await t.M.test(t.env,T0+2*MIN)).reason,'recent');
 const f=setup();healthy(f.bucket);await f.M.run(f.env,{now:T0});f.answer(()=>({status:401,body:{ok:false}}));
 assert.deepEqual([plain(await f.M.test(f.env,T0+MIN)).sent,f.bucket.value(KEY).lastTestAt],[false,null],'a failed test does not spend the cooldown');
 const c=setup();healthy(c.bucket);await c.M.run(c.env,{now:T0});
 const both=plain(await Promise.all([c.M.test(c.env,T0+MIN),c.M.test(c.env,T0+MIN)]));assert.equal(both.filter(item=>item.sent).length,1);assert.equal(tg(c.calls).length,1);
}

// 12. The wiring: the Worker bundle carries the transport, the configuration lives only in secrets and nothing is added to wrangler.jsonc.
{
 const wrangler=fs.readFileSync('wrangler.jsonc','utf8');assert.doesNotMatch(wrangler,/TELEGRAM|MONITOR/);
 const source=fs.readFileSync('src/monitor.js','utf8');
 assert.doesNotMatch(source,/\b\d{6,15}:[A-Za-z0-9_-]{30,}\b/,'no token literal in the source');assert.doesNotMatch(source,/chat_id\s*:\s*['"`]-?\d/,'no chat id literal in the source');
 assert.equal((source.match(/api\.telegram\.org/g)||[]).length,1,'one fixed Bot API host');assert.doesNotMatch(source,/getUpdates|setWebhook|parse_mode/,'outbound sendMessage only, plain text');
}

// 13. ADR 0206 rollout over a state document written before it: the stored `needs_owner` is read as degraded and critical, the undelivered message keeps its id
// and is delivered once, the history is kept, the delivery time becomes the last send, the next reminder comes 6 h after it and one recovery follows.
{
 const t=setup();healthy(t.bucket);owner(t);
 const day=at(T0).slice(0,10),issue='ratings_quarantined',pendingId=issue+'|reminder|'+at(T0-H);
 t.bucket.set(KEY,{schemaVersion:1,updatedAt:at(T0-H),heartbeatAt:at(T0-H),mode:'on',overall:'needs_owner',
  streams:[{stream:'ratings',state:'needs_owner',facts:{mode:'cloudflare',health:'quarantined'},issues:[{key:issue,severity:'needs_owner'}]}],
  alerts:{issues:{[issue]:{severity:'needs_owner',firstSeenAt:at(T0-3*H),seen:3,lastSentAt:at(T0-3*H),sendCount:1,sendDay:day,sendsToday:1}}},
  outbox:[{kind:'reminder',key:issue,severity:'needs_owner',stream:'ratings',message:'The Ratings run is quarantined (budget_exhausted)',firstSeenAt:at(T0-3*H),id:pendingId,queuedAt:at(T0-H),after:{lastSentAt:at(T0-H),sendCount:2,sendDay:day,sendsToday:2}}],
  cancelledUndelivered:0,holdUntil:null,lastDeliveryFailure:{at:at(T0-H),reason:'http_500'},predictions:null,epgSeen:null,lastTestAt:null});
 const read=plain(await t.M.status(t.env,T0));
 assert.equal(read.overall,'degraded');assert.deepEqual(read.openIssues.map(item=>[item.key,item.severity,item.critical,item.sendCount]),[[issue,'degraded',true,1]]);
 assert.deepEqual(read.streams.map(item=>[item.stream,item.state,item.issues.map(entry=>[entry.severity,entry.critical])]),[['ratings','degraded',[['degraded',true]]]]);
 assert.equal(t.bucket.value(KEY).overall,'needs_owner','the status read writes nothing');
 await t.M.run(t.env,{now:T0});
 const sent=tg(t.calls);assert.equal(sent.length,1,'only the undelivered message: no new alert, escalation or recovery because the enum changed');
 const lines=sent[0].body.text.split('\n');assert.equal(lines[0],'🔁 Напоминание · Оценки');assert.equal(lines.at(-1),'Ref: '+pendingId,'the receiver can still drop a repeat by its id');
 const doc=t.bucket.value(KEY);assert.doesNotMatch(JSON.stringify(doc),/needs_owner/,'the next write carries no needs_owner');
 assert.deepEqual(doc.outbox,[]);assert.equal(doc.overall,'degraded');
 assert.deepEqual(doc.alerts.issues[issue],{severity:'degraded',critical:true,firstSeenAt:at(T0-3*H),seen:4,lastSentAt:at(T0),sendCount:2,sendDay:day,sendsToday:2,stream:'ratings',metrics:{reason:'budget_exhausted'},metricsAt:at(T0)},'history kept; the delivery at T0 (not the queue time T0-1h) is the last send');
 for(const hour of [1,2,3,4,5])await t.M.run(t.env,{now:T0+hour*H});
 assert.equal(tg(t.calls).length,1,'no reminder before 6 h after the successful delivery');
 await t.M.run(t.env,{now:T0+6*H});assert.deepEqual(tg(t.calls).slice(1).map(item=>item.body.text.split('\n')[0]),['🔁 Напоминание · Оценки'],'the reminder 6 h after the last delivery');
 t.ctx.model={mode:'cloudflare',health:'healthy',failure:null};
 await t.M.run(t.env,{now:T0+7*H});await t.M.run(t.env,{now:T0+8*H});
 assert.deepEqual(tg(t.calls).slice(2).map(item=>item.body.text.split('\n')[0]),['✅ Проблема снята · Оценки'],'one recovery');
}

// 14. ADR 0206 settlement: a delayed delivery counts from its successful send, on the UTC day it was sent, never from the time it was queued.
{
 const first=lines=>lines.map(item=>item.body.text.split('\n')[0]);
 const issueSends=t=>tg(t.calls).filter(item=>item.body.text.includes('\nRef: ratings_quarantined|'));
 // (a) A pending escalation that the planner does not re-plan (inside the interval) is delivered after UTC midnight: the send belongs to the new day.
 const a=setup();healthy(a.bucket);owner(a);
 a.bucket.set(KEY,{schemaVersion:1,updatedAt:at(T0-30*MIN),heartbeatAt:at(T0-30*MIN),mode:'on',overall:'degraded',streams:[],
  alerts:{issues:{ratings_quarantined:{severity:'degraded',critical:true,firstSeenAt:at(T0-2*H),seen:2,lastSentAt:at(T0-H),sendCount:1,sendDay:'2026-11-06',sendsToday:5}}},
  outbox:[{kind:'escalation',key:'ratings_quarantined',severity:'degraded',critical:true,stream:'ratings',message:'q',firstSeenAt:at(T0-2*H),id:'ratings_quarantined|escalation|'+at(T0-30*MIN),queuedAt:at(T0-30*MIN),after:{lastSentAt:at(T0-30*MIN),sendCount:2,sendDay:'2026-11-06',sendsToday:6}}],
  cancelledUndelivered:0,holdUntil:null,lastDeliveryFailure:null,predictions:null,epgSeen:null,lastTestAt:null});
 a.answer(()=>({status:500,raw:''}));await a.M.run(a.env,{now:T0+H});await a.M.run(a.env,{now:T0+2*H});
 assert.equal(a.bucket.value(KEY).outbox.length,1,'kept over the outage, across midnight');
 a.answer(()=>({status:200,body:{ok:true,result:{}}}));await a.M.run(a.env,{now:T0+3*H});
 assert.deepEqual(first(issueSends(a).slice(-1)),['⛔ Ухудшение · Оценки']);
 const settledA=a.bucket.value(KEY).alerts.issues.ratings_quarantined;
 assert.deepEqual([settledA.lastSentAt,settledA.sendDay,settledA.sendsToday,settledA.sendCount],[at(T0+3*H),'2026-11-07',1,2],'settled at the delivery (01:00Z) on 7 Nov, not at the queue time (21:30Z) on 6 Nov');
 const delivered=issueSends(a).length;
 for(const hour of [4,5,6,7,8])await a.M.run(a.env,{now:T0+hour*H});
 assert.equal(issueSends(a).length,delivered,'no reminder before 6 h after the successful delivery (it would have come at 03:30Z from the queue time)');
 await a.M.run(a.env,{now:T0+9*H});assert.deepEqual(first(issueSends(a).slice(delivered)),['🔁 Напоминание · Оценки'],'the reminder at 07:00Z, 6 h after the delivery');
 // (b) An outage longer than six hours, starting with a Telegram 429 hold and crossing midnight: the late reminder resets the interval at its delivery.
 const b=setup();healthy(b.bucket);owner(b);await b.M.run(b.env,{now:T0});assert.equal(issueSends(b).length,1,'the critical alert at 22:00Z');
 b.answer(()=>({status:429,body:{ok:false,parameters:{retry_after:3600}}}));await b.M.run(b.env,{now:T0+6*H});
 assert.equal(b.bucket.value(KEY).holdUntil,at(T0+7*H),'a one-hour hold');
 b.answer(()=>({status:500,raw:''}));for(let hour=7;hour<=13;hour++)await b.M.run(b.env,{now:T0+hour*H});
 let entry=b.bucket.value(KEY).alerts.issues.ratings_quarantined;
 assert.deepEqual([entry.lastSentAt,entry.sendCount,b.bucket.value(KEY).outbox.length],[at(T0),1,1],'nothing counted during the outage, one pending reminder');
 b.answer(()=>({status:200,body:{ok:true,result:{}}}));const before=issueSends(b).length;await b.M.run(b.env,{now:T0+14*H});
 assert.deepEqual(first(issueSends(b).slice(before).filter((item,index,all)=>index===all.length-1)),['🔁 Напоминание · Оценки']);
 entry=b.bucket.value(KEY).alerts.issues.ratings_quarantined;
 assert.deepEqual([entry.lastSentAt,entry.sendDay,entry.sendsToday,entry.sendCount],[at(T0+14*H),'2026-11-07',1,2],'the reminder delivered 8 h late is settled at 12:00Z on 7 Nov');
 const afterLate=issueSends(b).length;
 for(let hour=15;hour<=19;hour++)await b.M.run(b.env,{now:T0+hour*H});
 assert.equal(issueSends(b).length,afterLate,'no reminder before 6 h after the late delivery');
 await b.M.run(b.env,{now:T0+20*H});assert.equal(issueSends(b).length,afterLate+1,'the next reminder 6 h after the late delivery');
}

// 15. Rollback replay (ADR 0206, recovery boundary): the previous policy and runtime, kept verbatim as fixtures, run over a document written by the new code
// with an open critical issue and a pending message. History and keys are kept, nothing recovers, the pending message is sent once under its own id, and the one
// bounded difference is visible: the old code sends one ESCALATION (needs_owner) for the open critical issue, then reminds every 2 h.
{
 const fresh=setup();healthy(fresh.bucket);owner(fresh);await fresh.M.run(fresh.env,{now:T0});
 fresh.answer(()=>({status:500,raw:''}));await fresh.M.run(fresh.env,{now:T0+6*H});
 const written=fresh.bucket.value(KEY);const pending=written.outbox[0];
 assert.deepEqual([written.outbox.length,pending.kind,pending.severity,pending.critical],[1,'reminder','degraded',true],'the new code left one pending critical reminder');
 assert.deepEqual([written.alerts.issues.ratings_quarantined.severity,written.alerts.issues.ratings_quarantined.critical,written.alerts.issues.ratings_quarantined.sendCount],['degraded',true,1]);
 const old=setup({},{bucket:fresh.bucket,policyFile:'tests/fixtures/monitor-policy-pre-air-592.js',monitorFile:'tests/fixtures/monitor-pre-air-592.js'});old.ctx.model=fresh.ctx.model;
 const read=plain(await old.M.status(old.env,T0+6*H+MIN));assert.deepEqual(read.openIssues.map(item=>[item.key,item.severity,item.sendCount]),[['ratings_quarantined','degraded',1]],'the old status reads the new document');
 await old.M.run(old.env,{now:T0+7*H});
 const sent=tg(old.calls);assert.equal(sent.length,1,'one message, no duplicate of the pending one and no recovery');
 const lines=sent[0].body.text.split('\n');
 assert.equal(lines[0],'IPTV monitor: ESCALATION (needs_owner)','the stated bounded rollback difference: one escalation for the open critical issue');
 assert.equal(lines.at(-1),'Ref: '+pending.id,'sent under the id of the pending message, so a receiver keeps one');
 const doc=old.bucket.value(KEY),kept=doc.alerts.issues.ratings_quarantined;
 assert.deepEqual([kept.firstSeenAt,kept.sendCount,kept.severity,doc.outbox.length],[written.alerts.issues.ratings_quarantined.firstSeenAt,2,'needs_owner',0],'history kept, the key is the same issue');
 await old.M.run(old.env,{now:T0+8*H});assert.equal(tg(old.calls).length,1,'no further escalation');
 await old.M.run(old.env,{now:T0+9*H});assert.deepEqual(tg(old.calls).slice(1).map(item=>item.body.text.split('\n')[0]),['IPTV monitor: REMINDER (needs_owner)'],'then the old 2 h reminder');
 // Roll forward again: the new code reads the old document as critical, without a new alert, escalation or recovery.
 const again=setup({},{bucket:old.bucket});again.ctx.model=old.ctx.model;await again.M.run(again.env,{now:T0+10*H});
 assert.equal(tg(again.calls).length,0,'roll-forward sends nothing because of the format');
 assert.deepEqual([again.bucket.value(KEY).alerts.issues.ratings_quarantined.critical,again.bucket.value(KEY).alerts.issues.ratings_quarantined.sendCount],[true,3]);
 // The issue clears under the old code: one recovery, as for any delivered issue.
 old.ctx.model={mode:'cloudflare',health:'healthy',failure:null};await old.M.run(old.env,{now:T0+11*H});
 assert.deepEqual(tg(old.calls).slice(2).map(item=>item.body.text.split('\n')[0]),['IPTV monitor: RECOVERED (healthy)']);
}

console.log('Monitor Telegram: fixed endpoint and plain text, ok:false/401/403/429/timeout/malformed/network never count as delivered, retry_after hold without sleeping, fail-closed configuration, no leak, transport choice, off no-op (the retired dry token included), AIR-349 outbox budget and CAS over Telegram, ADR 0206 rollout over a needs_owner state, delivery-time settlement across midnight and long outages, rollback replay on the previous code passed');
