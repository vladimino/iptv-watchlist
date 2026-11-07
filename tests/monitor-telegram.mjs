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

function setup(extraEnv={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const logs=[];ctx.console={log:line=>logs.push(String(line)),warn:line=>logs.push(String(line)),error:line=>logs.push(String(line))};
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
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

// 1. The fixed Bot API endpoint, a plain-text body and the AIR-349 accounting: a needs-owner issue alerts at once, delivered once.
{
 const t=setup();healthy(t.bucket);owner(t);
 const result=plain(await t.M.run(t.env,{now:T0}));assert.deepEqual([result.sent,result.failed],[1,0]);
 const sent=tg(t.calls);assert.equal(sent.length,1);
 assert.equal(sent[0].url,SEND_URL,'the destination is the fixed Bot API endpoint');assert.equal(sent[0].method,'POST');
 assert.deepEqual(Object.keys(sent[0].body).sort(),['chat_id','disable_web_page_preview','text'],'no parse_mode: plain text');
 assert.equal(sent[0].body.chat_id,CHAT);assert.equal(sent[0].body.disable_web_page_preview,true);
 const lines=sent[0].body.text.split('\n');
 assert.equal(lines[0],'IPTV monitor: ALERT (needs_owner)');assert.ok(lines.includes('Stream: ratings'));assert.ok(lines.includes('Issue: ratings_quarantined'));
 assert.ok(lines.some(line=>line.startsWith('Overall: ')));assert.ok(lines.includes('At: '+at(T0)));assert.ok(lines.some(line=>line.startsWith('Ref: ratings_quarantined|alert|')));
 const doc=t.bucket.value(KEY);assert.deepEqual(doc.outbox,[]);assert.equal(doc.alerts.issues.ratings_quarantined.sendCount,1);assert.equal(doc.lastDeliveryFailure,null);
 assert.equal(t.calls.filter(item=>item.method==='GET').length,1,'the heartbeat ping is unchanged');
}

// 2. Alert, reminder, escalation, recovery and test are told apart.
{
 const t=setup();
 const text=kind=>(t.M.internals.telegramText({kind,severity:'degraded',stream:'epg',key:'epg_stale',message:'No generation published',id:'x'},'degraded',T0)).split('\n')[0];
 assert.deepEqual(['alert','reminder','escalation','recovery','test'].map(text),['IPTV monitor: ALERT (degraded)','IPTV monitor: REMINDER (degraded)','IPTV monitor: ESCALATION (degraded)','IPTV monitor: RECOVERED (degraded)','IPTV monitor: TEST (degraded)']);
}

// 3. Plain-text encoding: markup, control characters and non-ASCII are neutralized and every field is bounded.
{
 const t=setup();
 const body=t.M.internals.telegramText({kind:'alert',severity:'degraded',stream:'epg\n<b>',key:'k_<i>*[x](y)',message:'<b>bold</b> *a* _b_ `c` [l](http://x) é\u0007\n\nline'+'z'.repeat(2000),id:'id'+'q'.repeat(500)},'degraded',T0);
 assert.doesNotMatch(body,/[^\x20-\x7E\n]/,'only printable ASCII and the field separators remain');
 assert.ok(body.length<1000,'far below the 4096-character Telegram limit');assert.equal(body.split('\n').length,7,'a newline in a field cannot add lines');
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
 const posted=t.calls.filter(item=>item.url.startsWith('https://hooks.example/'));assert.equal(posted.length,1);assert.deepEqual(Object.keys(posted[0].body).sort(),['at','id','key','kind','message','overall','severity','source','stream']);
 const status=plain(await t.M.status(t.env,T0));assert.deepEqual([status.transport,status.alerting],['webhook',true]);
 const chosen=setup({MONITOR_WEBHOOK_URL:'https://hooks.example/alert'});healthy(chosen.bucket);owner(chosen);await chosen.M.run(chosen.env,{now:T0});
 assert.equal(chosen.calls.filter(item=>item.url.startsWith('https://hooks.example/')).length,0,'a chosen Telegram transport never falls back to the webhook');assert.equal(tg(chosen.calls).length,1);
 assert.equal(plain(await chosen.M.status(chosen.env,T0)).transport,'telegram');
}

// 8. MONITOR off and dry: no request, no write, whatever the configuration.
{
 const t=setup();healthy(t.bucket);owner(t);
 assert.equal(plain(await t.M.run({...t.env,MONITOR:undefined},{now:T0})).ran,false);const dry=plain(await t.M.run({...t.env,MONITOR:'dry'},{now:T0}));assert.equal(dry.mode,'dry');
 assert.equal(t.calls.length,0);assert.equal(t.bucket.writes().length,0);
 // The synthetic test is an outward send and a write: neither off nor dry may do it, for Telegram and for the generic webhook.
 for(const extra of [{},{MONITOR_TRANSPORT:'webhook',MONITOR_WEBHOOK_URL:'https://hooks.example/alert'}]){
  const x=setup(extra);healthy(x.bucket);
  for(const [value,reason] of [[undefined,'off'],['off','off'],['dry','dry'],['garbage','off']]){
   const answer=plain(await x.M.test({...x.env,...extra,MONITOR:value},T0));assert.deepEqual([answer.sent,answer.reason],[false,reason],String(value));
  }
  assert.equal(x.calls.length,0,'no outbound request from test() in off or dry');assert.equal(x.bucket.writes().length,0,'no bucket write from test() in off or dry');
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
 assert.equal(hour,8,'drained at five per tick');assert.equal(new Set(tg(t.calls).filter(item=>item.body.text.startsWith('IPTV monitor: RECOVERED')).map(item=>item.body.text.split('\n').find(line=>line.startsWith('Ref: ')))).size,30,'all thirty Refs were delivered');
}

// 10. Concurrent ticks send once over Telegram; a recovery superseded by a reoccurrence is never sent.
{
 const t=setup();healthy(t.bucket);owner(t);await t.M.run(t.env,{now:T0});t.ctx.model={mode:'cloudflare',health:'healthy',failure:null};
 t.answer(()=>({status:500,raw:''}));await t.M.run(t.env,{now:T0+H});
 assert.deepEqual(t.bucket.value(KEY).outbox.map(item=>item.kind),['recovery']);owner(t);
 t.answer(()=>({status:200,body:{ok:true,result:{}}}));const before=tg(t.calls).length;await t.M.run(t.env,{now:T0+2*H});
 const fresh=tg(t.calls).slice(before);assert.deepEqual(fresh.map(item=>item.body.text.split('\n')[0]),['IPTV monitor: ALERT (needs_owner)'],'only the new alert is sent: the pending recovery was superseded');
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
 const message=tg(t.calls).at(-1);assert.equal(message.body.text.split('\n')[0],'IPTV monitor: TEST (test)');assert.match(message.body.text,/No incident/);
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

console.log('Monitor Telegram: fixed endpoint and plain text, ok:false/401/403/429/timeout/malformed/network never count as delivered, retry_after hold without sleeping, fail-closed configuration, no leak, transport choice, off/dry no-op, AIR-349 outbox budget and CAS over Telegram passed');
