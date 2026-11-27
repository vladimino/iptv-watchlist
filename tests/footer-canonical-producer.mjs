// AIR-593. «Обогащение каталога» in the status footer: the `canonical_producer` source of GET /api/enrichment/footer/status, over the real Worker, the real
// Monitor and the real MonitorPolicy with a stub of the one bounded Producer reader (no Cloudflare, no network). It proves: the footer and the Monitor give
// the same `status` on the same facts at the same time (current, active, waiting, lagging, stalled, failed, blocked, held, unreadable, a rollover of the
// published P:g, unknown counts and a failure after partial work); the footer reads the stored Monitor clock and never writes it; one footer read makes one
// Producer read (three indexed D1 statements, counted on the real reader in tests/canonical-producer-chain.mjs) and no extra R2 read, so no catalogue scan
// is added; the compact aggregate shows a Producer error; and the rendered Russian line names units (not films), the reason by class only, and no identifier.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';

const H=3600000,MIN=60000,at=ms=>new Date(ms).toISOString();
const T0=Date.parse('2026-11-23T16:30:00Z');
function setup({hold=false,monitor='on'}={}){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 // As in the Worker bundle, the poster source (which already reads monitor/state.json for its markers) is part of the footer.
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+scoped('src/catalog-poster-weekly.js','CatalogPosterWeekly')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 ctx.fetch=async()=>new Response('',{status:200});
 ctx.RatingsOrchestration={async readModel(){return {mode:'cloudflare',health:'healthy',failure:null};}};
 const world={P:'7f3c2a10-0000-4000-8000-00000000abcd',generation:10,publishedAt:at(T0),chain:null,run:null,reads:0,unreadable:false,ready:true,runs:{}};
 ctx.CanonicalProducerWorkflow={PRODUCER_DELIVERY_HOLD:hold,async readProducerMonitorFacts(_env,{prior=null}={}){
  world.reads++;if(world.unreadable)throw new Error('d1 down');
  if(world.ready===false)return {ready:false};
  const current=world.P+':'+world.generation;
  // AIR-692: the conditional lookup of an earlier generation (a durably passed run is immutable), answered from `world.runs`.
  const prove=prior&&prior!==current?{label:prior,run:world.runs?.[prior]||null}:null;
  return {ready:true,programmeRunId:world.P,generation:world.generation,label:current,publishedAt:world.publishedAt,chain:world.chain,run:world.run,prior:prove};}};
 const env=baseEnv(bucket,{MONITOR:monitor,MONITOR_WEBHOOK_URL:'https://hooks.example/alert',DB:{}});
 bucket.set('sync.json',{runId:world.P,stage:'complete',updatedAt:at(T0-3*H),failures:[]});
 bucket.set('enrichment/prediction-queue.json',{pending:[],refreshedAt:at(T0-3*H),lastBatch:null});
 const footer=async()=>{const before=bucket.log.length;const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),env);assert.equal(response.status,200);const body=await response.json();return {body,source:body.integrations.sources.find(item=>item.id==='canonical_producer'),log:bucket.log.slice(before)};};
 const monitorStatus=async now=>plain((await g(ctx,'Monitor').status(env,now)).streams).find(stream=>stream.stream==='canonical_producer');
 return {clock,bucket,ctx,env,world,footer,monitorStatus,M:g(ctx,'Monitor')};
}
const label=world=>world.P+':'+world.generation;
const run=(world,over={})=>({run_key:'epg:'+world.P+':'+world.generation,pass_state:'passing',source_generation:label(world),applied_generation:null,stopped_by:null,cursor_id:'film:tmdb:1',unit_count:400,n_applied:0,n_noop:0,n_kept:0,n_failed:0,pass_no:1,updated_at:at(T0),completed_at:null,...over});
const chain=(over={})=>({owner_state:'active',stopped_by:null,recovery_class:null,next_attempt_at:null,...over});

// The app's own footer renderer, for the Russian line and the compact aggregate.
const app=fs.readFileSync('public/app.js','utf8');
const ui=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
const render=body=>{ui.payload=body;return vm.runInContext('footerStatusText(payload)',ui);};
const RAW=/7f3c2a10|epg:|film:tmdb|producer_[a-z_]+|run_key|cursor|tmdb_/;
// The source without its own vocabulary (`id`, `code`), which is not an identifier of the run.
const shown=source=>JSON.stringify({...source,id:undefined,code:undefined});

// Tick the Monitor, then read the footer at the same instant: the two must agree on `status`.
async function agree(t,now,expected){
 t.clock.now=now;
 await t.M.run(t.env,{now});
 const monitor=await t.monitorStatus(now);
 const {body,source,log}=await t.footer();
 assert.equal(monitor.facts.status??'unreadable',expected,'monitor status');
 assert.equal(source.status,expected,'footer status agrees with the Monitor');
 assert.equal(log.filter(item=>item.op==='put').length,0,'the footer GET writes nothing');
 return {body,source,line:render(body).integrations.canonical_producer,aggregate:render(body).integrationAggregate,monitor};
}

// 1. Current: the run of the exact published generation passed and applied it. Green, with the success time, the publication, and no counts.
{
 const t=setup(),w=t.world;
 w.chain=chain({owner_state:'complete'});w.run=run(w,{pass_state:'passed',applied_generation:label(w),n_applied:380,n_noop:20,completed_at:at(T0+40*MIN),updated_at:at(T0+40*MIN)});
 const r=await agree(t,T0+H,'current');
 assert.deepEqual([r.source.state,r.source.code,r.source.lastSuccessAt,r.source.generation],['healthy','producer_current',at(T0+40*MIN),10]);
 assert.match(r.line,/^работает · актуально для опубликованной программы · EPG от 23 нояб\..* · успех 23 нояб\./);
 assert.doesNotMatch(r.line,/обработано|фильм/);assert.doesNotMatch(r.line+shown(r.source),RAW,'no identifier leaves the footer');
}

// 2. Active: a moving first pass inside the window. Running, X of Y units (units, not films), never green, never a failure.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:100,n_noop:20,updated_at:at(T0+20*MIN)});
 await agree(t,T0+30*MIN,'waiting');
 w.run=run(w,{n_applied:200,n_noop:21,updated_at:at(T0+80*MIN)});
 const r=await agree(t,T0+90*MIN,'waiting');
 assert.deepEqual([r.source.state,r.source.code,r.source.processed,r.source.unitCount],['running','producer_running',221,400]);
 assert.match(r.line,/^выполняется · EPG от .* · обработано 221 из 400 единиц$/);
 assert.equal(r.aggregate.includes('сбой'),false);
 // A hand-off between instances (chain pending, the same run still passing) is ordinary work, not a failure.
 w.chain=chain({owner_state:'pending'});
 const h=await agree(t,T0+100*MIN,'waiting');
 assert.equal(h.source.state,'running');assert.equal(h.source.reason,null);
}

// 3. Waiting: published, no run yet, inside the window. «ждёт запуска», no invented zero.
{
 const t=setup(),w=t.world;
 w.chain=chain({owner_state:'pending'});w.run=null;
 const r=await agree(t,T0+30*MIN,'waiting');
 assert.deepEqual([r.source.state,r.source.code,r.source.processed,r.source.unitCount],['waiting','producer_waiting',null,null]);
 assert.match(r.line,/^ожидает · ждёт запуска · EPG от /);assert.doesNotMatch(r.line,/\b0\b/);
}

// 4. Lagging: published more than 2 h ago, still moving. Not stalled, not green.
{
 const t=setup(),w=t.world;
 w.chain=chain();
 for(let step=0;step<=4;step++){w.run=run(w,{n_applied:50*(step+1),updated_at:at(T0+step*H)});await agree(t,T0+step*H+5*MIN,step<2?'waiting':'lagging');}
 const r=await agree(t,T0+4*H+10*MIN,'lagging');
 assert.deepEqual([r.source.state,r.source.code],['running','producer_lagging']);
 assert.match(r.line,/^выполняется · отстаёт от публикации · EPG от .* · обработано 250 из 400 единиц$/);
}

// 5. Stalled: no durable progress for more than 2 h. Attention in the row and in the compact aggregate, with the last proven progress.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:120,updated_at:at(T0+10*MIN)});
 await agree(t,T0+15*MIN,'waiting');
 const r=await agree(t,T0+3*H,'stalled');
 assert.deepEqual([r.source.state,r.source.code,r.source.progressAt],['degraded','producer_stalled',at(T0+10*MIN)]);
 assert.match(r.line,/^требует внимания · нет подтверждённого прогресса больше 2 ч · EPG от .* · обработано 120 из 400 единиц · последний прогресс 23 нояб\./);
 assert.match(r.aggregate,/требу/,'the collapsed footer shows attention');
}

// 6. Failed after partial work: a recoverable stop. An error in the row and «есть сбой» in the collapsed footer, the reason in Russian by class,
//    the progress kept, the failed units and the next automatic attempt.
{
 const t=setup(),w=t.world;
 w.run=run(w,{pass_state:'stopped',stopped_by:'producer_transport',n_applied:150,n_noop:10,n_failed:3,updated_at:at(T0+40*MIN)});
 w.chain=chain({owner_state:'stopped',stopped_by:'producer_transport',recovery_class:'transient',next_attempt_at:at(T0+2*H)});
 const r=await agree(t,T0+H,'failed');
 assert.deepEqual([r.source.state,r.source.code,r.source.reason,r.source.processed,r.source.failedUnits,r.source.nextAttemptAt],['failed','producer_failed','transient',160,3,at(T0+2*H)]);
 assert.match(r.line,/^сбой · остановлено, будет автоматический повтор · EPG от .* · причина: временный сбой хранилища или сети · обработано 160 из 400 единиц · с ошибкой: 3 · повтор не раньше /);
 assert.equal(r.aggregate,'есть сбой','the collapsed footer shows the error');
 assert.equal(r.body.integrations.aggregate,'failed');
 assert.doesNotMatch(r.line+shown(r.source),RAW,'the raw stop code is not shown');
}

// 7. Blocked: an identity stop needs the owner.
{
 const t=setup(),w=t.world;
 w.run=run(w,{pass_state:'stopped',stopped_by:'producer_identity_ambiguous',n_applied:10});
 w.chain=chain({owner_state:'stopped',stopped_by:'producer_identity_ambiguous',recovery_class:'fail_closed'});
 const r=await agree(t,T0+H,'blocked');
 assert.deepEqual([r.source.state,r.source.code,r.source.reason,r.source.nextAttemptAt],['failed','producer_blocked','identity',null]);
 assert.match(r.line,/^сбой · остановлено, нужно решение владельца · EPG от .* · причина: конфликт идентификации фильма · обработано 10 из 400 единиц$/);
 assert.equal(r.aggregate,'есть сбой');
 // A terminal class without an identity code is blocked too, with its own class.
 w.chain=chain({owner_state:'stopped',stopped_by:'producer_chain_epoch_cap',recovery_class:'fail_closed'});w.run=run(w,{n_applied:10});
 const b=await agree(t,T0+H+5*MIN,'blocked');
 assert.equal(b.source.reason,'fail_closed');assert.match(b.line,/причина: неклассифицированная ошибка/);
}

// 8. Held by delivery: nothing is read, visible, never green and never a success.
{
 const t=setup({hold:true});
 const r=await agree(t,T0+H,'held_by_delivery');
 assert.equal(t.world.reads,0,'a held Producer is not read by the Monitor or the footer');
 assert.deepEqual([r.source.state,r.source.code,r.source.lastSuccessAt,r.source.processed,r.source.publishedAt],['degraded','producer_held',null,null,null]);
 assert.equal(r.line,'требует внимания · приостановлено при поставке');
 assert.notEqual(r.body.integrations.aggregate,'healthy');
}

// 9. Unreadable: a failed D1 read is unknown, not green, not zero, and attention in the aggregate; the rest of the footer still answers.
{
 const t=setup(),w=t.world;
 w.unreadable=true;
 const r=await agree(t,T0+H,'unreadable');
 assert.deepEqual([r.source.state,r.source.code,r.source.processed,r.source.unitCount,r.source.publishedAt],['unknown','producer_unreadable',null,null,null]);
 assert.equal(r.line,'нет данных · статус не прочитан');
 assert.notEqual(r.body.integrations.aggregate,'healthy');
 assert.ok(r.body.integrations.sources.some(item=>item.id==='epg'),'the other sources are still reported');
}

// 10. Rollover of the published P:g: a new generation with zero finished units cannot reset the streak; it stays stalled.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:5,updated_at:at(T0+5*MIN)});
 await agree(t,T0+10*MIN,'waiting');
 w.generation=11;w.publishedAt=at(T0+2*H);w.run=run(w,{n_applied:0,cursor_id:null,updated_at:at(T0+2*H)});w.chain=chain({owner_state:'pending'});
 const r=await agree(t,T0+2*H+30*MIN,'stalled');
 assert.equal(r.source.generation,11,'the exact published generation is reported');
 assert.match(r.line,/EPG от 23 нояб\., 19:30/,'the publication time of the new generation (18:30 UTC, Madrid)');
}

// 11. Unknown counts: a replayed pass (cumulative counters over passes) or a missing total is «нет данных», never 0 and never above the total.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{pass_no:2,n_applied:420,unit_count:400,updated_at:at(T0+10*MIN)});
 const r=await agree(t,T0+20*MIN,'waiting');
 assert.deepEqual([r.source.processed,r.source.unitCount],[null,400]);
 assert.match(r.line,/обработано: нет данных$/);assert.doesNotMatch(r.line,/420|\b0 из/);
}

// 12. Bounded and read-only: one footer read = one Producer read and exactly one read of monitor/state.json (shared with the poster markers), and the R2
//     keys read are the same with and without the Producer source (no extra catalogue or journal read). The stored Monitor clock is not changed.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:7});
 await agree(t,T0+10*MIN,'waiting');
 const stored=JSON.stringify(t.bucket.records.get('monitor/state.json'));
 const reads=w.reads;
 const {log}=await t.footer();
 assert.equal(w.reads-reads,1,'one Producer read per footer GET');
 assert.equal(log.filter(item=>item.op==='get'&&item.key==='monitor/state.json').length,1,'monitor/state.json is read once');
 assert.equal(JSON.stringify(t.bucket.records.get('monitor/state.json')),stored,'the footer never writes the Monitor clock');
 const withKeys=log.filter(item=>item.op==='get').map(item=>item.key).sort();
 const saved=t.ctx.CanonicalProducerWorkflow;t.ctx.CanonicalProducerWorkflow=undefined;
 const without=await t.footer();
 t.ctx.CanonicalProducerWorkflow=saved;
 assert.equal(without.source,undefined,'without the Producer module the source is absent, as for posters');
 assert.deepEqual(without.log.filter(item=>item.op==='get').map(item=>item.key).sort(),withKeys,'the Producer source adds no R2 read');
 assert.equal(render(without.body).integrations.canonical_producer,'','the row is hidden only when the source is absent');
}

// 13. Without a running Monitor and with no stored clock the streak starts at the publication, so the footer cannot show a permanent first-tick grace.
{
 const t=setup({monitor:'off'}),w=t.world;
 w.chain=chain({owner_state:'pending'});w.run=null;
 t.clock.now=T0+3*H;
 const {source}=await t.footer();
 assert.deepEqual([source.status,source.state],['stalled','degraded']);
 t.clock.now=T0+30*MIN;
 assert.equal((await t.footer()).source.status,'waiting','inside the window it is waiting');
}

// 14. The admin footer renders the same row: the markup and the reader slice are the programme's (checked in status-footer-ui.mjs); here the row exists in order.
{
 const html=fs.readFileSync('public/index.html','utf8');
 const list=html.match(/<section aria-labelledby="status-integrations-title">[\s\S]*?<\/section>/)[0];
 const order=[...list.matchAll(/data-integration="([^"]+)"/g)].map(match=>match[1]);
 assert.deepEqual(order.slice(0,6),['letterboxd_watchlist','letterboxd_ratings','epg','resolver','canonical_producer','predictions'],'«Обогащение каталога» sits after «Распознавание» and before «Прогнозы»');
 assert.match(list,/<dt[^>]*>Обогащение каталога<\/dt><dd id="integration-producer">/);
}
// 15. Review P1: a read-only footer never renews the no-progress window. The Monitor ticks once (done=10); D1 moves once more at +5 min (done=11) and then
//     stays identical; no Monitor tick follows. Footer reads 3 h and 4 h later see the same row: progress stays dated by the row (+5 min), both reads are stalled.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:10,updated_at:at(T0)});
 await agree(t,T0,'waiting');
 w.run=run(w,{n_applied:11,updated_at:at(T0+5*MIN)});
 for(const offset of [3*H,4*H,4*H+1]){
  t.clock.now=T0+offset;
  const {source,body,log}=await t.footer();
  assert.equal(source.status,'stalled','unchanged durable evidence must reach stalled at +'+offset/MIN+' min');
  assert.equal(source.progressAt,at(T0+5*MIN),'progress is dated by the row, not by the read');
  assert.notEqual(body.integrations.aggregate,'healthy');
  assert.equal(log.filter(item=>item.op==='put').length,0);
 }
 // Inside the freshness window the same moved row is dated by the row too, so two reads 30 min apart give the same time.
 const u=setup(),v=u.world;
 v.chain=chain();v.run=run(v,{n_applied:10,updated_at:at(T0)});
 await agree(u,T0,'waiting');
 v.run=run(v,{n_applied:11,updated_at:at(T0+5*MIN)});
 u.clock.now=T0+40*MIN;const a=(await u.footer()).source;
 u.clock.now=T0+70*MIN;const b=(await u.footer()).source;
 assert.deepEqual([a.status,b.status,a.progressAt,b.progressAt],['waiting','waiting',at(T0+5*MIN),at(T0+5*MIN)]);
}

// 16. No stored clock while MONITOR=on (the Monitor never ticked): no first-tick grace on any read. Unchanged evidence older than 2 h is stalled on every
//     read; a recently updated row cannot prove finished units without a fresh Monitor baseline, so «lagging» becomes `unconfirmed` (unknown, never green).
{
 const t=setup(),w=t.world;
 w.chain=chain({owner_state:'pending'});w.run=null;
 for(const offset of [3*H,3*H+30*MIN]){t.clock.now=T0+offset;const {source}=await t.footer();assert.deepEqual([source.status,source.clockState],['stalled','missing'],'no grace without a clock');}
 w.chain=chain();w.run=run(w,{n_applied:40,updated_at:at(T0+10*MIN)});
 t.clock.now=T0+3*H;assert.equal((await t.footer()).source.status,'stalled','a row last updated 2 h 50 min ago is stalled');
 w.run=run(w,{n_applied:90,updated_at:at(T0+2*H+50*MIN)});
 for(const offset of [3*H,3*H+20*MIN]){
  t.clock.now=T0+offset;
  const {source,body}=await t.footer();
  assert.deepEqual([source.status,source.state,source.code,source.clockState],['unconfirmed','unknown','producer_unconfirmed','missing']);
  assert.notEqual(body.integrations.aggregate,'healthy','an unconfirmed Producer is never counted as healthy');
  assert.match(render(body).integrations.canonical_producer,/^нет данных · движение не подтверждено: монитор давно не обновлял отметку прогресса · EPG от .* · обработано 90 из 400 единиц$/);
 }
 // Inside the window after the publication, «waiting» needs no clock.
 t.clock.now=T0+40*MIN;w.run=run(w,{n_applied:5,updated_at:at(T0+30*MIN)});
 assert.equal((await t.footer()).source.status,'waiting');
}

// 17. A stale clock (the Monitor stopped ticking) and an unreadable state document behave like a missing clock; the stale baseline is never renewed.
{
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:10,updated_at:at(T0)});
 await agree(t,T0,'waiting');
 w.run=run(w,{n_applied:200,updated_at:at(T0+2*H+55*MIN)});
 t.clock.now=T0+3*H;
 let {source}=await t.footer();
 assert.deepEqual([source.status,source.clockState],['unconfirmed','stale'],'a clock older than 90 min cannot confirm movement');
 t.bucket.hooks.beforeGet=async key=>{if(key==='monitor/state.json')throw new Error('r2 down');};
 ({source}=await t.footer());
 assert.deepEqual([source.status,source.clockState],['unconfirmed','unreadable']);
 w.run=run(w,{n_applied:200,updated_at:at(T0+20*MIN)});
 ({source}=await t.footer());
 assert.deepEqual([source.status,source.clockState],['stalled','unreadable'],'an unreadable clock does not restore a grace');
 t.bucket.hooks.beforeGet=null;
 // 18. Recovery: the Monitor ticks again; at the same instant the footer has a fresh clock and agrees with the Monitor once more.
 w.run=run(w,{n_applied:260,updated_at:at(T0+3*H+5*MIN)});
 const r=await agree(t,T0+3*H+10*MIN,'lagging');
 assert.equal(r.source.clockState,'fresh');
 w.run=run(w,{n_applied:300,updated_at:at(T0+3*H+40*MIN)});
 const next=await agree(t,T0+4*H,'lagging');
 assert.equal(next.source.clockState,'fresh');
}

// 19. Authoritative D1 facts are never masked by a missing, stale or unreadable clock: current and a stop are shown as they are.
{
 const t=setup(),w=t.world;
 t.bucket.hooks.beforeGet=async key=>{if(key==='monitor/state.json')throw new Error('r2 down');};
 t.clock.now=T0+5*H;
 w.chain=chain({owner_state:'complete'});w.run=run(w,{pass_state:'passed',applied_generation:label(w),n_applied:400,completed_at:at(T0+H),updated_at:at(T0+H)});
 let {source}=await t.footer();
 assert.deepEqual([source.status,source.state,source.clockState],['current','healthy','unreadable']);
 w.run=run(w,{pass_state:'stopped',stopped_by:'producer_timeout',n_applied:30});w.chain=chain({owner_state:'stopped',stopped_by:'producer_timeout',recovery_class:'transient',next_attempt_at:at(T0+6*H)});
 ({source}=await t.footer());
 assert.deepEqual([source.status,source.state,source.reason],['failed','failed','transient']);
}

// 20. Review P2: null, empty or missing counters are unknown, never 0; a genuine zero stays a measured zero.
{
 const t=setup(),w=t.world;
 w.chain=chain();
 const check=async(over,processed,unitCount,failedUnits,pattern)=>{
  w.run={...run(w,{updated_at:at(T0+5*MIN)}),...over};
  t.clock.now=T0+10*MIN;
  const {source,body}=await t.footer();
  assert.deepEqual([source.processed,source.unitCount,source.failedUnits],[processed,unitCount,failedUnits],JSON.stringify(over));
  assert.match(render(body).integrations.canonical_producer,pattern);
 };
 await check({n_applied:null},null,400,0,/обработано: нет данных$/);
 await check({n_noop:''},null,400,0,/обработано: нет данных$/);
 const missing=run(w,{updated_at:at(T0+5*MIN)});delete missing.n_kept;
 await check({...missing,n_kept:undefined},null,400,0,/обработано: нет данных$/);
 await check({unit_count:null},null,null,0,/обработано: нет данных$/);
 await check({unit_count:''},null,null,0,/обработано: нет данных$/);
 await check({n_failed:null},0,400,null,/обработано 0 из 400 единиц$/);
 await check({n_applied:0,n_noop:0,n_kept:0,n_failed:0},0,400,0,/обработано 0 из 400 единиц$/);
 await check({n_applied:'12',n_noop:'3',n_kept:'0'},15,400,0,/обработано 15 из 400 единиц$/);
 await check({n_applied:-1},null,400,0,/обработано: нет данных$/);
}
// 13. AIR-692: a normal idle after a proven pass is not "no progress" in the footer either, across the corrected rollover scenarios, and the page read writes nothing.
{
 // (a) previous generation observed pending, durably passed between ticks, superseded: the exact lookup closes the boundary.
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:50,updated_at:at(T0+20*MIN)});
 await agree(t,T0+30*MIN,'waiting');
 w.runs[label(w)]=run(w,{pass_state:'passed',applied_generation:label(w),n_applied:400,completed_at:at(T0+50*MIN)});
 w.generation=11;w.publishedAt=at(T0+24*H);w.chain=null;w.run=null;
 const r=await agree(t,T0+24*H+58*MIN,'waiting');
 assert.notEqual(r.source.state,'failed');assert.notEqual(r.source.code,'producer_stalled');
}
{
 // (b) a proven zero-unit pass, a long idle, an unready observation, then a new publication without a run: the closed boundary survives.
 const t=setup(),w=t.world;
 w.chain=chain({owner_state:'complete'});w.run=run(w,{pass_state:'passed',applied_generation:label(w),unit_count:0,completed_at:at(T0+10*MIN),updated_at:at(T0+10*MIN)});
 await agree(t,T0+H,'current');
 w.ready=false;t.clock.now=T0+22*H;await t.M.run(t.env,{now:T0+22*H});
 w.ready=true;w.generation=11;w.publishedAt=at(T0+23*H);w.chain=null;w.run=null;
 await agree(t,T0+24*H+MIN,'waiting');
}
{
 // (c) an unfinished pass keeps its streak through an unready observation and a rollover: still a stall for the footer.
 const t=setup(),w=t.world;
 w.chain=chain();w.run=run(w,{n_applied:0,cursor_id:null,updated_at:at(T0)});
 await agree(t,T0+MIN,'waiting');
 w.ready=false;t.clock.now=T0+H;await t.M.run(t.env,{now:T0+H});
 w.ready=true;w.generation=11;w.publishedAt=at(T0+3*H);w.run=null;
 await agree(t,T0+4*H,'stalled');
}
console.log('footer canonical_producer source: ok');
