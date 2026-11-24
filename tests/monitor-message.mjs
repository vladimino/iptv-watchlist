// AIR-592 (ADR 0206, decision 9) and its visual follow-up: the human-facing Telegram text of the monitor. Pure renderer over the message's own fields: kind markers,
// Russian stream and problem names, typed statistics, the domain no-progress period beside the observed incident lifetime, frozen recovery
// duration, partial recovery, delayed delivery, unknown times, legacy messages and unsafe input, laid out as short blocks separated by empty lines
// (the owner's review of the first production message). No I/O; times are fixed.
// IPTV_PRINT_SAMPLES=1 prints the rendered samples that the offline evidence quotes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as R from '../src/domain/monitor-message.js';
import * as P from '../src/domain/monitor-policy.js';
import {dailyDue} from '../src/domain/orchestration-policy.js';

assert.doesNotMatch(fs.readFileSync('src/domain/monitor-message.js','utf8'),/\b(fetch|BUCKET|import |require|Date\.now|new Date\(\)|Math\.random|crypto|parse_mode)\b/,'pure: no I/O, clock, randomness or markup mode');
const H=3600000,MIN=60000,T=s=>Date.parse(s);
const render=(message,overall,now)=>R.telegramText(message,{overall,now:T(now)});
const samples=[];
const sample=(label,text)=>{samples.push({label,text});return text;};

// 1. The owner's Predictions example (22 Nov 2026): 3533 eligible, 15 h without confirmed progress, 11 ownerless starts, last progress 21.11 17:00:23 UTC,
// alert 08:00:23 UTC, recovery noticed at 13:00:23 UTC. The issue comes from the real policy, so the statistics are its typed metrics, not a parsed sentence.
const predictionFacts=(idleMs,extra={})=>({present:true,pendingCount:3600,eligibleNow:3533,lastProgressAt:'2026-11-21T17:00:23.000Z',stall:{state:'no_progress',reason:'repeated_orphan_starts',orphanStarts:11,idleMs},...extra});
{
 const now=T('2026-11-22T08:00:23Z');
 const evaluated=P.evaluatePredictions(predictionFacts(15*H),null,now);
 const item=evaluated.issues[0];
 assert.deepEqual(item.metrics,{eligible:3533,pending:3600,idleMs:15*H,orphanStarts:11,lastProgressAt:'2026-11-21T17:00:23.000Z'},'typed metrics from the facts already read');
 const plan=P.planAlerts(evaluated.issues,{issues:{}},now);
 const alert={...plan.sends[0],id:'predictions_no_progress|alert|2026-11-22T08:00:23.000Z',queuedAt:'2026-11-22T08:00:23.000Z',observedAt:'2026-11-22T08:00:23.000Z'};
 assert.deepEqual(alert.metrics,item.metrics,'the planned message keeps the metrics: no fact is lost on the way');
 assert.equal(sample('Predictions alert (owner example)',render(alert,'degraded','2026-11-22T08:00:30Z')),[
  '⚠️ Проблема · Прогнозы',
  'Нет подтверждённого прогресса',
  '🟠 Подтверждённая деградация',
  '',
  'Доступно: 3\u00a0533',
  'В очереди: 3\u00a0600',
  'Запусков без фильма (за 2 ч): 11',
  '',
  '⏱ Прогресс не подтверждён: 15 ч',
  'Последний прогресс: 21.11 18:00',
  '',
  '🕒 Инцидент: меньше минуты',
  'Открыт: 22.11 09:00',
  '',
  '🌐 В целом: есть проблемы',
  '',
  '22.11 09:00:30 · Мадрид',
  'Ref: predictions_no_progress|alert|2026-11-22T08:00:23.000Z'].join('\n'));
 // The issue is still seen at the 12:00:23 tick (19 h without confirmed progress); a productive batch then lands at 12:10 and the 13:00:23 tick no
 // longer sees the issue. The recovery reports the last measured stall as a lower bound at its observation, never the 20 h up to the noticing tick.
 let state=plan.state;state.issues.predictions_no_progress={...state.issues.predictions_no_progress,lastSentAt:alert.observedAt,sendCount:1};
 for(const hour of [9,10,11,12])state=P.planAlerts(P.evaluatePredictions(predictionFacts((hour-8+15)*H),null,T('2026-11-22T'+String(hour).padStart(2,'0')+':00:23Z')).issues,state,T('2026-11-22T'+String(hour).padStart(2,'0')+':00:23Z')).state;
 assert.deepEqual([state.issues.predictions_no_progress.metrics.idleMs,state.issues.predictions_no_progress.metricsAt],[19*H,'2026-11-22T12:00:23.000Z'],'the entry keeps the last measured stall and when it was measured');
 const healthy=P.evaluatePredictions(predictionFacts(null,{lastProgressAt:'2026-11-22T12:10:00.000Z',stall:{state:'ok',idleMs:50*MIN}}),null,T('2026-11-22T13:00:23Z'));
 assert.deepEqual(healthy.issues,[]);
 const recovered=P.planAlerts(healthy.issues,state,T('2026-11-22T13:00:23Z')).sends[0];
 assert.deepEqual([recovered.kind,recovered.stream,recovered.endedAt,recovered.firstSeenAt,recovered.metricsAt],['recovery','predictions','2026-11-22T13:00:23.000Z','2026-11-22T08:00:23.000Z','2026-11-22T12:00:23.000Z']);
 const message={...recovered,id:'predictions_no_progress|recovery|2026-11-22T13:00:23.000Z',queuedAt:recovered.endedAt};
 const text=sample('Predictions recovery (owner example; progress landed at 12:10 UTC, between the last observation and the noticing tick)',render(message,'healthy','2026-11-22T13:00:30Z'));
 assert.equal(text,[
  '✅ Проблема снята · Прогнозы',
  'Нет подтверждённого прогресса',
  'Больше не наблюдается',
  '',
  '⏱ Прогресс не подтверждён',
  'Не меньше: 19 ч',
  'Последнее наблюдение: 22.11 13:00',
  '',
  '🕒 Инцидент: 5 ч',
  'Открыт: 22.11 09:00',
  'Снят: 22.11 14:00',
  '',
  '🌐 В целом: всё в порядке',
  '',
  '22.11 14:00:30 · Мадрид',
  'Ref: predictions_no_progress|recovery|2026-11-22T13:00:23.000Z'].join('\n'));
 assert.doesNotMatch(text,/20 ч/,'the gap up to the noticing tick is not presented as the domain outage');
 // Frozen: the same recovery delivered six hours later after an outage reports the same durations and says it was late.
 const late=render(message,'healthy','2026-11-22T19:30:00Z').split('\n');
 assert.ok(late.includes('🕒 Инцидент: 5 ч')&&late.includes('Снят: 22.11 14:00'),'a late delivery does not lengthen the incident');
 assert.ok(late.includes('📨 Отправлено с задержкой')&&late.includes('Обнаружено: 22.11 14:00')&&late.includes('22.11 20:30:00 · Мадрид'));
 // An issue that disappears without any evidence of progress (the queue split became unreadable: delayed, never an alert) still reads only as "no
 // longer seen": the stall line stays the last measured lower bound and nothing claims that predictions recovered.
 const unreadable=P.evaluatePredictions(predictionFacts(null,{stall:{state:'unknown',reason:'queue_unreadable',idleMs:null}}),null,T('2026-11-22T13:00:23Z'));
 assert.deepEqual([unreadable.state,unreadable.issues.length],['delayed',0]);
 const gone=P.planAlerts(unreadable.issues,state,T('2026-11-22T13:00:23Z')).sends[0];
 const goneText=sample('Recovery without evidence of progress (the issue only disappeared)',render({...gone,id:'predictions_no_progress|recovery|x',queuedAt:gone.endedAt},'delayed','2026-11-22T13:00:30Z')).split('\n');
 assert.deepEqual(goneText.slice(1,3),['Нет подтверждённого прогресса','Больше не наблюдается']);
 assert.ok(goneText.includes('⏱ Прогресс не подтверждён')&&goneText.includes('Не меньше: 19 ч')&&goneText.includes('Последнее наблюдение: 22.11 13:00'));
 assert.ok(goneText.includes('🌐 В целом: есть задержки'));
 assert.ok(!goneText.some(line=>/восстановлен|Восстановлено/.test(line)),'a missing issue is not presented as a physical recovery');
}

// 2. The owner's Discovery example (12 Nov 2026): the executor stalled alert at 04:00:42 UTC, its recovery at 05:00:42 UTC while the site stays degraded.
// Only a finished chunk (`lastChunkFinishedAt`) is progress; the continuation record's update time is not.
{
 const now=T('2026-11-12T04:00:42Z');
 const evaluated=P.evaluateDiscovery({executor:'workflow',health:'settled',publishedRunId:'r1',lastChunkFinishedAt:'2026-11-12T03:20:00.000Z',readout:{stalled:true,quarantined:false},continuation:{stage:'paused',reason:'chunk_budget',remainingChunks:12,at:'2026-11-12T03:50:00.000Z',programmeRunId:'r1',nextCatchUpAt:'2026-11-12T03:30:00.000Z'}},now);
 const item=evaluated.issues.find(entry=>entry.key==='discovery_executor_stalled');
 assert.deepEqual(item.metrics,{remainingChunks:12,lastChunkAt:'2026-11-12T03:20:00.000Z',executor:'workflow'},'the record time 03:50 is not taken as progress');
 const first=P.planAlerts([item],{issues:{}},T('2026-11-12T03:00:42Z'));
 const plan=P.planAlerts([item],first.state,now);
 const alert={...plan.sends[0],id:'discovery_executor_stalled|alert|2026-11-12T04:00:42.000Z',queuedAt:'2026-11-12T04:00:42.000Z',observedAt:'2026-11-12T04:00:42.000Z'};
 const alertText=sample('Discovery alert (owner example; first seen one tick before the confirmation)',render(alert,'degraded','2026-11-12T04:00:50Z')).split('\n');
 assert.equal(alertText[0],'⚠️ Проблема · Находки');assert.equal(alertText[1],'Исполнитель (Workflow) остановился');
 assert.ok(alertText.includes('Последний чанк: 12.11 04:20'));
 assert.ok(alertText.includes('⏱ Без нового чанка: 41 мин'),'measured from the finished chunk to the observation');
 assert.ok(alertText.includes('🕒 Инцидент: 1 ч')&&alertText.includes('Открыт: 12.11 04:00'),'firstSeenAt before the confirmation is the opening of the incident');
 const recovered=P.planAlerts([],{issues:{discovery_executor_stalled:{...plan.state.issues.discovery_executor_stalled,sendCount:1,lastSentAt:alert.observedAt}}},T('2026-11-12T05:00:42Z')).sends[0];
 const text=sample('Discovery recovery while another issue is still open (owner example)',render({...recovered,id:'discovery_executor_stalled|recovery|2026-11-12T05:00:42.000Z',queuedAt:recovered.endedAt},'degraded','2026-11-12T05:00:50Z')).split('\n');
 assert.equal(text[0],'✅ Проблема снята · Находки');
 assert.ok(text.includes('🕒 Инцидент: 2 ч')&&text.includes('Открыт: 12.11 04:00')&&text.includes('Снят: 12.11 06:00'));
 assert.ok(text.includes('🌐 Остаются другие проблемы'),'a recovery of one issue never claims the site is healthy');
 assert.ok(!text.some(line=>/всё в порядке/.test(line)));
 // discovery_stalled keeps the threshold's own diagnostic: no ALLOWED progress for max(overdue, idle) (the policy's idle still counts the record time), with
 // the allowed time and, separately, the last finished chunk.
 const stalled=P.evaluateDiscovery({executor:'workflow',health:'settled',publishedRunId:'r1',lastChunkFinishedAt:'2026-11-12T00:00:00.000Z',readout:null,queue:{state:'backlog',reason:'chunk_budget',owed:true,eligible:true},continuation:{stage:'paused',reason:'chunk_budget',remainingChunks:7,at:'2026-11-12T03:00:00.000Z',programmeRunId:'r1',nextCatchUpAt:'2026-11-12T00:30:00.000Z'}},now).issues.find(entry=>entry.key==='discovery_stalled');
 assert.deepEqual(stalled.metrics,{remainingChunks:7,stalledMs:T('2026-11-12T04:00:42Z')-T('2026-11-12T00:30:00Z'),allowedAt:'2026-11-12T00:30:00.000Z',lastChunkAt:'2026-11-12T00:00:00.000Z',executor:'workflow',queueState:'backlog',queueReason:'chunk_budget'});
 const stalledText=sample('Discovery stalled (no allowed progress)',render({...stalled,kind:'alert',firstSeenAt:'2026-11-12T03:00:42.000Z',observedAt:'2026-11-12T04:00:42.000Z',id:'discovery_stalled|alert|x'},'degraded','2026-11-12T04:00:50Z')).split('\n');
 assert.ok(stalledText.includes('⏱ Без разрешённого прогресса: 3 ч 31 мин')&&stalledText.includes('Шаг разрешён с: 12.11 01:30'));
 assert.ok(stalledText.includes('Последний чанк: 12.11 01:00'));
}

// 3. Every kind has its own marker; critical has its own alert marker; reminder, escalation and test are labelled.
{
 const base={key:'canonical_producer_failed',stream:'canonical_producer',severity:'degraded',critical:true,firstSeenAt:'2026-11-24T02:00:00.000Z',observedAt:'2026-11-24T03:00:00.000Z',metrics:{stoppedBy:'producer_budget_infeasible',hard:true,generation:'r1:5'}};
 const at='2026-11-24T03:00:10Z';
 const first=kind=>render({...base,kind,id:'canonical_producer_failed|'+kind+'|x'},'degraded',at).split('\n')[0];
 assert.deepEqual(['alert','reminder','escalation','recovery'].map(first),['🚨 Сбой · Обогащение каталога','🔁 Напоминание · Обогащение каталога','⛔ Ухудшение · Обогащение каталога','✅ Проблема снята · Обогащение каталога']);
 assert.equal(first.call(null,'alert'),'🚨 Сбой · Обогащение каталога');
 assert.equal(render({...base,critical:false,kind:'alert',id:'x'},'degraded',at).split('\n')[0],'⚠️ Проблема · Обогащение каталога');
 const hard=sample('Canonical Producer critical alert (hard stop)',render({...base,kind:'alert',id:'canonical_producer_failed|alert|2026-11-24T03:00:00.000Z'},'degraded',at)).split('\n');
 assert.deepEqual(hard.slice(0,3),['🚨 Сбой · Обогащение каталога','Остановлено','🔴 Критичный сбой']);
 assert.ok(hard.includes('Причина: producer_budget_infeasible')&&hard.includes('Автоматически не возобновится')&&hard.includes('Поколение: r1:5'));
 sample('Canonical Producer escalation',render({...base,kind:'escalation',id:'canonical_producer_failed|escalation|2026-11-24T03:00:00.000Z'},'degraded',at));
 sample('Reminder (critical Ratings quarantine)',render({kind:'reminder',key:'ratings_quarantined',stream:'ratings',severity:'degraded',critical:true,firstSeenAt:'2026-11-23T20:00:00.000Z',observedAt:'2026-11-24T08:00:00.000Z',metrics:{reason:'budget_exhausted'},id:'ratings_quarantined|reminder|2026-11-24T08:00:00.000Z'},'degraded','2026-11-24T08:00:05Z'));
 const test=sample('Test',render({kind:'test',severity:'test',stream:'monitor',key:'monitor_test',message:'Test alert from the IPTV monitor. No incident.',id:'monitor_test|2026-11-24T09:00:00.000Z'},'healthy','2026-11-24T09:00:00Z')).split('\n');
 assert.deepEqual(test,['🧪 Тест · Монитор','Проверочное сообщение, инцидента нет','','24.11 10:00:00 · Мадрид','Ref: monitor_test|2026-11-24T09:00:00.000Z']);
}

// 4. Representative streams from the real policy: EPG late publication, a failed poster week, a Letterboxd backlog.
{
 const now=T('2026-11-06T22:30:00Z');
 const epg=P.evaluateEpg({authority:'d1',publishedAt:'2026-11-04T16:10:00.000Z'},now,{dailyDue}).issues[0];
 assert.deepEqual(Object.keys(epg.metrics).sort(),['dueAt','lateMs','publishedAt']);
 const epgText=sample('EPG stale',render({...epg,kind:'alert',critical:false,firstSeenAt:'2026-11-06T21:30:00.000Z',observedAt:'2026-11-06T22:30:00.000Z',id:'epg_stale|alert|2026-11-06T22:30:00.000Z'},'degraded','2026-11-06T22:30:05Z')).split('\n');
 assert.ok(epgText.includes('⏱ Опоздание: 6 ч 30 мин')&&epgText.includes('Ожидалась: 06.11 17:00')&&epgText.includes('Последняя публикация: 04.11 17:10'),'lateness and due time as their own lines');
 const poster=P.evaluateCatalogPosters({state:'failed',monitor:'degraded',critical:true,detail:'retry_exhausted',freshnessAt:'2026-11-22T03:24:00.000Z',nextExpectedAt:null}).issues[0];
 const posterText=sample('Catalog posters failed (critical)',render({...poster,kind:'alert',firstSeenAt:'2026-11-22T04:00:00.000Z',observedAt:'2026-11-22T04:00:00.000Z',id:'catalog_posters_failed|alert|2026-11-22T04:00:00.000Z'},'degraded','2026-11-22T04:00:03Z')).split('\n');
 assert.equal(posterText[0],'🚨 Сбой · Постеры');assert.ok(posterText.includes('Причина: retry_exhausted'));
 const backlog=P.evaluateLetterboxd({health:'healthy',mode:'cloudflare',eventsPending:9,sources:{}},now).issues[0];
 assert.ok(sample('Letterboxd events backlog',render({...backlog,kind:'alert',firstSeenAt:'2026-11-06T21:30:00.000Z',observedAt:'2026-11-06T22:30:00.000Z',id:'letterboxd_events_backlog|alert|x'},'degraded','2026-11-06T22:30:05Z')).includes('Событий ждёт доставки: 9'));
}

// 5. Delayed delivery across UTC midnight: an escalation observed at 23:30 UTC on 6 Nov and delivered at 01:00 UTC on 7 Nov keeps its observed durations.
{
 const message={kind:'escalation',key:'canonical_producer_failed',stream:'canonical_producer',severity:'degraded',critical:true,firstSeenAt:'2026-11-06T21:30:00.000Z',observedAt:'2026-11-06T23:30:00.000Z',queuedAt:'2026-11-06T23:30:00.000Z',metrics:{stoppedBy:'producer_identity_unresolved',hard:true},id:'canonical_producer_failed|escalation|2026-11-06T23:30:00.000Z'};
 const text=sample('Delayed escalation across UTC midnight',render(message,'degraded','2026-11-07T01:00:00Z')).split('\n');
 assert.ok(text.includes('🕒 Инцидент: 2 ч')&&text.includes('Открыт: 06.11 22:30'),'measured at the observation, not at the late send');
 assert.ok(text.includes('📨 Отправлено с задержкой')&&text.includes('Обнаружено: 07.11 00:30')&&text.includes('07.11 02:00:00 · Мадрид'));
 assert.ok(!render(message,'degraded','2026-11-06T23:40:00Z').includes('📨'),'no delay note for a normal delivery');
}

// 6. Unknown or malformed times are unknown, never 0; malformed counts are left out.
{
 const text=sample('Unknown timing',render({kind:'alert',key:'predictions_no_progress',stream:'predictions',severity:'degraded',firstSeenAt:'not a time',metrics:{eligible:-3,idleMs:'x',orphanStarts:1.5},id:'predictions_no_progress|alert|x'},'degraded','2026-11-24T10:00:00Z')).split('\n');
 assert.ok(text.includes('🕒 Инцидент: неизвестно')&&text.includes('Открыт: неизвестно'));
 assert.ok(!text.some(line=>/: 0\b|-3|1\.5|NaN|undefined|null/.test(line)),'no fabricated zero, NaN or null');
 const recovery=render({kind:'recovery',key:'epg_stale',stream:'epg',severity:'healthy',message:'Recovered',id:'epg_stale|recovery|x'},'healthy','2026-11-24T10:00:00Z').split('\n');
 assert.ok(recovery.includes('🕒 Инцидент: неизвестно'));
 assert.equal(R.duration(-1),'неизвестно');assert.equal(R.duration(NaN),'неизвестно');assert.equal(R.duration(30000),'меньше минуты');
 assert.deepEqual([45*MIN,90*MIN,15*H,50*H].map(R.duration),['45 мин','1 ч 30 мин','15 ч','2 д 2 ч']);
}

// 7. Legacy messages written before ADR 0206: a pending `needs_owner` reminder without metrics or observedAt, and a recovery without endedAt.
{
 const legacy={kind:'reminder',key:'ratings_quarantined',severity:'needs_owner',stream:'ratings',message:'The Ratings run is quarantined (budget_exhausted)',firstSeenAt:'2026-11-24T05:00:00.000Z',id:'ratings_quarantined|reminder|2026-11-24T07:00:00.000Z',queuedAt:'2026-11-24T07:00:00.000Z',after:{lastSentAt:'2026-11-24T07:00:00.000Z',sendCount:2,sendDay:'2026-11-24',sendsToday:2}};
 const text=sample('Legacy pending needs_owner reminder',render(legacy,'needs_owner','2026-11-24T08:00:00Z')).split('\n');
 assert.equal(text[0],'🔁 Напоминание · Оценки');assert.equal(text[2],'🔴 Критичный сбой');
 assert.ok(text.includes('Детали: The Ratings run is quarantined (budget_exhausted)'),'without metrics the stored detail is shown, bounded');
 assert.ok(text.includes('🕒 Инцидент: 2 ч')&&text.includes('Открыт: 24.11 06:00'),'the queue time stands in for the observation');
 assert.ok(text.includes('🌐 В целом: есть проблемы'));assert.equal(text.at(-1),'Ref: '+legacy.id,'the stable id is kept');
 const recovery=render({kind:'recovery',key:'discovery_stalled',severity:'healthy',stream:'discovery',message:'Recovered',firstSeenAt:'2026-11-24T01:00:00.000Z',id:'discovery_stalled|recovery|2026-11-24T04:00:00.000Z',queuedAt:'2026-11-24T04:00:00.000Z'},'healthy','2026-11-24T06:00:00Z').split('\n');
 assert.ok(recovery.includes('🕒 Инцидент: 3 ч')&&recovery.includes('Снят: 24.11 05:00'),'a legacy recovery ends at its queue time, frozen');
 // A legacy recovery of `canonical_producer_*` / `catalog_posters_*` carried the key prefix as its stream (`canonical`, `catalog`): the issue key still
 // identifies the real subsystem for the text (the stored and webhook fields are not changed).
 assert.equal(render({kind:'recovery',key:'canonical_producer_failed',severity:'healthy',stream:'canonical',message:'Recovered',id:'x'},'healthy','2026-11-24T06:00:00Z').split('\n')[0],'✅ Проблема снята · Обогащение каталога');
 assert.equal(render({kind:'recovery',key:'catalog_posters_failed',severity:'healthy',stream:'catalog',message:'Recovered',id:'x'},'healthy','2026-11-24T06:00:00Z').split('\n')[0],'✅ Проблема снята · Постеры');
 assert.equal(render({kind:'recovery',key:'odd_key',severity:'healthy',stream:'canonical',message:'Recovered',id:'x'},'healthy','2026-11-24T06:00:00Z').split('\n')[0],'✅ Проблема снята · canonical','without a matching key the code stays as it is');
}

// 8. Long and unsafe input: markup, control and direction characters, a huge detail and a huge id stay bounded; the Ref line is never cut.
{
 const text=sample('Long and unsafe input (sanitized)',render({kind:'alert',key:'unknown_<b>key',stream:'x\u202e',severity:'degraded',message:'<b>x</b>\u0007\u202e'+'z'.repeat(5000),metrics:{reason:'a'.repeat(500)},firstSeenAt:'2026-11-24T05:00:00.000Z',id:'id|'+'q'.repeat(400)},'degraded','2026-11-24T06:00:00Z'));
 assert.ok(text.length<=1800);assert.doesNotMatch(text,/[\u0000-\u0009\u000b-\u001f\u202a-\u202e]/,'no control or direction character; markup stays inert text because no parse_mode is sent');
 assert.ok(text.split('\n').at(-1).startsWith('Ref: id|q'),'the id stays the last line');
 const huge=R.telegramText({kind:'alert',key:'k',stream:'epg',id:'ref-ok',message:'m',metrics:{}},{overall:'degraded',now:T('2026-11-24T06:00:00Z')});
 assert.equal(huge.split('\n').at(-1),'Ref: ref-ok');
}

// 9. The webhook keeps its machine contract: the planner's typed metrics never change the fixed webhook fields (checked in monitor-runtime.mjs);
// here: the planner adds metrics and stream to its entry only as additive fields that the previous code ignores.
{
 const t0=T('2026-11-24T10:00:00Z');
 const plan=P.planAlerts([{key:'ratings_quarantined',severity:'degraded',critical:true,stream:'ratings',message:'q',metrics:{reason:'r'}}],{issues:{}},t0);
 assert.deepEqual([plan.state.issues.ratings_quarantined.stream,plan.state.issues.ratings_quarantined.metrics],['ratings',{reason:'r'}]);
 const recovery=P.planAlerts([],{issues:{canonical_producer_failed:{severity:'degraded',critical:true,stream:'canonical_producer',firstSeenAt:'2026-11-24T08:00:00.000Z',seen:2,lastSentAt:'2026-11-24T08:00:00.000Z',sendCount:1,sendDay:'2026-11-24',sendsToday:1}}},t0).sends[0];
 assert.deepEqual([recovery.stream,recovery.wasCritical,recovery.endedAt],['canonical_producer',true,'2026-11-24T10:00:00.000Z'],'the recovery names its real stream (no longer the key prefix) and is frozen at detection');
 const legacyRecovery=P.planAlerts([],{issues:{canonical_producer_failed:{severity:'needs_owner',firstSeenAt:'2026-11-24T08:00:00.000Z',seen:2,lastSentAt:'2026-11-24T08:00:00.000Z',sendCount:1}}},t0).sends[0];
 assert.equal(legacyRecovery.stream,'canonical','an entry stored before ADR 0206 has no stream: the previous key-prefix fallback stays');
}

// 11. A lower bound is rounded down: 19 h 40 min measured is "не меньше 19 ч", never 20 h; plain durations still round to the nearest.
{
 const recovery=idleMs=>R.telegramText({kind:'recovery',key:'predictions_no_progress',stream:'predictions',severity:'healthy',firstSeenAt:'2026-11-22T08:00:00.000Z',endedAt:'2026-11-22T13:00:00.000Z',metrics:{idleMs},metricsAt:'2026-11-22T12:00:00.000Z',id:'x'},{overall:'healthy',now:T('2026-11-22T13:00:10Z')}).split('\n')[5];
 assert.equal(recovery(19*H+40*MIN),'Не меньше: 19 ч');
 assert.equal(recovery(9*H+59*MIN+50000),'Не меньше: 9 ч 59 мин');
 assert.equal(recovery(59*MIN+59000),'Не меньше: 59 мин');
 assert.equal(recovery(49*H+50*MIN),'Не меньше: 2 д 1 ч');
 assert.deepEqual([R.duration(19*H+40*MIN),R.duration(19*H+40*MIN,{floor:true}),R.duration(90*MIN+40000,{floor:true})],['20 ч','19 ч','1 ч 30 мин']);
}

// 10. Review fixtures: baseline versus confirmed progress, diagnostic details kept, out-of-range times, no manufactured counts.
{
 const now=T('2026-11-24T10:00:00Z');
 // A Producer window counted from the publication with no confirmed progress at all: the reference is shown as a reference, not as progress.
 const baseline=P.evaluateCanonicalProducer({readable:true,held:false,label:'r9:3',publishedAt:'2026-11-24T06:30:00.000Z',sinceAt:'2026-11-24T06:30:00.000Z',progressAt:null,run:{passState:'active'},chain:{ownerState:'active'}},now).issues[0];
 assert.equal(baseline.key,'canonical_producer_no_progress');
 assert.deepEqual(baseline.metrics,{idleMs:3.5*H,sinceAt:'2026-11-24T06:30:00.000Z',chain:'active',run:'active',generation:'r9:3'},'no progressAt: nothing confirmed');
 const baselineText=sample('Canonical Producer without confirmed progress (window counted from the publication)',render({...baseline,kind:'alert',firstSeenAt:'2026-11-24T10:00:00.000Z',observedAt:'2026-11-24T10:00:00.000Z',id:'canonical_producer_no_progress|alert|x'},'degraded','2026-11-24T10:00:05Z')).split('\n');
 assert.ok(baselineText.includes('⏱ Прогресс не подтверждён: 3 ч 30 мин')&&baselineText.includes('Отсчёт с: 24.11 07:30'));
 assert.ok(baselineText.includes('Последний прогресс: не было в этом окне'));
 assert.ok(!baselineText.some(line=>/Последний прогресс: 24\.11 07:30/.test(line)),'the reference is never called progress');
 const confirmed=P.evaluateCanonicalProducer({readable:true,held:false,label:'r9:3',publishedAt:'2026-11-24T05:00:00.000Z',sinceAt:'2026-11-24T07:00:00.000Z',progressAt:'2026-11-24T07:00:00.000Z',run:{passState:'active'},chain:{ownerState:'active'}},now).issues[0];
 assert.ok(render({...confirmed,kind:'alert',firstSeenAt:'2026-11-24T10:00:00.000Z',id:'x'},'degraded','2026-11-24T10:00:05Z').includes('Последний прогресс: 24.11 08:00'));
 // Letterboxd keeps "never succeeded" apart from "older than 24 h"; Ratings keeps "two hours after the due time".
 const lb=warning=>P.evaluateLetterboxd({health:'healthy',mode:'cloudflare',sources:{watchlist:{stale:true,warning}}},now).issues.find(entry=>entry.key==='letterboxd_watchlist_stale');
 assert.ok(render({...lb('watchlist_never_succeeded'),kind:'alert',id:'x'},'degraded','2026-11-24T10:00:05Z').includes('Подробно: ни одного полного скана с запуска'));
 assert.ok(sample('Letterboxd Watchlist stale for 24 h',render({...lb('watchlist_stale'),kind:'alert',firstSeenAt:'2026-11-24T09:00:00.000Z',observedAt:'2026-11-24T10:00:00.000Z',id:'letterboxd_watchlist_stale|alert|x'},'degraded','2026-11-24T10:00:05Z')).includes('Подробно: нет полного скана больше 24 ч'));
 const ratings=sample('Ratings stalled',render({...P.evaluateRatings({mode:'cloudflare',health:'stalled'},now).issues[0],kind:'alert',firstSeenAt:'2026-11-24T09:00:00.000Z',observedAt:'2026-11-24T10:00:00.000Z',id:'ratings_stalled|alert|x'},'degraded','2026-11-24T10:00:05Z')).split('\n');
 assert.equal(ratings[1],'Нет завершённого дня (срок + 2 ч)');
 assert.ok(ratings.includes('Подробно: ни дня, ни прогресса к 19:00 (срок 17:00)'));
 // Out-of-range and malformed times are unknown and never reach Intl (a RangeError there would lose the message).
 for(const bad of [9e15,-9e15,'+275760-09-13T00:00:00.001Z',Infinity,'2026-13-45T99:00:00Z',{},[]]){
  const text=R.telegramText({kind:'recovery',key:'epg_stale',stream:'epg',severity:'healthy',firstSeenAt:bad,endedAt:bad,metrics:{idleMs:5*H},metricsAt:bad,id:'epg_stale|recovery|x'},{overall:'healthy',now:typeof bad==='number'?bad:T('2026-11-24T10:00:00Z')});
  assert.ok(text.includes('🕒 Инцидент: неизвестно')&&text.includes('Снят: неизвестно'),String(bad));
  const alert=R.telegramText({kind:'alert',key:'predictions_no_progress',stream:'predictions',severity:'degraded',firstSeenAt:bad,observedAt:bad,metrics:{idleMs:H,lastProgressAt:bad},id:'x'},{overall:'degraded',now:T('2026-11-24T10:00:00Z')});
  assert.ok(alert.includes('Открыт: неизвестно')&&alert.includes('Последний прогресс: неизвестно'),String(bad));
 }
 // An unknown queue size is not reported as 0.
 const unknownPending=P.evaluatePredictions({present:true,eligibleNow:5,lastProgressAt:null,stall:{state:'no_progress',reason:'no_progress',idleMs:2*H}},null,now).issues[0];
 assert.equal('pending' in unknownPending.metrics,false,'a missing pendingCount is not coerced to 0 in the metrics');
 assert.ok(!render({...unknownPending,kind:'alert',id:'x'},'degraded','2026-11-24T10:00:05Z').includes('В очереди'));
}

// 14. AIR-596 (ADR 0210) lines in the block layout: a held reminder (reason in the statistics, the last measured stall with its own observation,
// no stale count), a live lease that is not progress, the 2-hour orphan bound, and each recovery reason as its own block right after the header.
{
 const base={key:'predictions_no_progress',stream:'predictions',severity:'degraded',critical:false,firstSeenAt:'2026-11-23T22:28:00.000Z',observedAt:'2026-11-24T04:28:00.000Z',id:'predictions_no_progress|reminder|2026-11-24T04:28:00.000Z'};
 const held=sample('Held prediction reminder (AIR-596)',render({...base,kind:'reminder',metrics:{held:'split_unknown',eligible:5,idleMs:2*H},metricsAt:'2026-11-23T22:28:00.000Z'},'degraded','2026-11-24T04:28:05Z')).split('\n');
 assert.deepEqual(held.slice(4,6),['Сейчас: число доступных не читается','Инцидент остаётся открытым']);
 assert.ok(held.includes('⏱ Прогресс не подтверждён')&&held.includes('Не меньше: 2 ч')&&held.includes('Последнее наблюдение: 23.11 23:28'));
 assert.ok(!held.some(line=>line.startsWith('Доступно')),'no stale count shown as current');
 const lease=sample('Prediction alert with a live lease and ownerless starts (AIR-596)',render({...base,kind:'alert',observedAt:'2026-11-23T22:28:00.000Z',metrics:{eligible:6969,pending:7000,orphanStarts:8,activeRun:true,idleMs:61*MIN,lastProgressAt:'2026-11-23T21:27:00.000Z'},id:'predictions_no_progress|alert|2026-11-23T22:28:00.000Z'},'degraded','2026-11-23T22:28:05Z')).split('\n');
 assert.ok(lease.includes('Запусков без фильма (за 2 ч): 8')&&lease.includes('Lease держит запуск, это не прогресс')&&lease.includes('Доступно: 6 969'));
 const recovery=reason=>render({...base,kind:'recovery',severity:'healthy',endedAt:'2026-11-24T05:28:00.000Z',metrics:{idleMs:2*H},metricsAt:'2026-11-23T22:28:00.000Z',recoveryReason:reason,recoveryProgressAt:'2026-11-24T05:13:00.000Z',id:'predictions_no_progress|recovery|2026-11-24T05:28:00.000Z'},'healthy','2026-11-24T05:28:05Z');
 assert.deepEqual(sample('Prediction recovery by confirmed progress (AIR-596)',recovery('progress')).split('\n').slice(3,7),['','Причина: прогресс снова подтверждён','Последний прогресс: 24.11 06:13','']);
 assert.deepEqual(sample('Prediction recovery without eligible work (AIR-596)',recovery('no_eligible_work')).split('\n').slice(3,8),['','Причина: нечего прогнозировать','Очередь пуста или повторы исчерпаны','Это не подтверждённый прогресс','']);
 assert.deepEqual(recovery('retry_wait').split('\n').slice(3,7),['','Причина: все фильмы ждут повторной попытки','Это не подтверждённый прогресс','']);
 assert.equal(recovery('unknown_reason').split('\n')[3],'','an unknown reason adds no block');
 assert.ok(!recovery('unknown_reason').includes('Причина'));
}

// 15. Known dates stay visible when the duration is unknown (partial or legacy typed metrics); the unknown duration reads «неизвестно», never 0.
{
 const at='2026-11-24T10:00:00Z',base={kind:'alert',severity:'degraded',firstSeenAt:'2026-11-24T09:00:00.000Z',observedAt:'2026-11-24T10:00:00.000Z',id:'x'};
 const p=render({...base,key:'predictions_no_progress',stream:'predictions',metrics:{lastProgressAt:'2026-11-24T06:00:00.000Z'}},'degraded',at).split('\n');
 assert.ok(p.includes('⏱ Прогресс не подтверждён: неизвестно')&&p.includes('Последний прогресс: 24.11 07:00'));
 const d=render({...base,key:'discovery_stalled',stream:'discovery',metrics:{allowedAt:'2026-11-24T08:00:00.000Z',lastChunkAt:'2026-11-24T07:30:00.000Z'}},'degraded',at).split('\n');
 assert.ok(d.includes('⏱ Без разрешённого прогресса: неизвестно')&&d.includes('Шаг разрешён с: 24.11 09:00')&&d.includes('Последний чанк: 24.11 08:30'));
 const c=render({...base,key:'canonical_producer_no_progress',stream:'canonical_producer',metrics:{sinceAt:'2026-11-24T07:00:00.000Z'}},'degraded',at).split('\n');
 assert.ok(c.includes('⏱ Прогресс не подтверждён: неизвестно')&&c.includes('Отсчёт с: 24.11 08:00')&&c.includes('Последний прогресс: не было в этом окне'));
 assert.ok(!render({...base,key:'predictions_no_progress',stream:'predictions',metrics:{}},'degraded',at).includes('⏱'),'nothing known: no stall block at all');
}

// 12. The owner's production message of 24 Nov 2026, 14:00:23 Madrid (Ref predictions_no_progress|reminder|2026-11-24T13:00:23.490Z: 3078 eligible,
// 3083 queued, 16 h without progress, last progress 23.11 22:00, opened 24.11 08:00, 6 h of incident, overall degraded), in the reviewed layout.
{
 const text=sample('Owner production reminder of 24 Nov 2026 in the new layout',render({kind:'reminder',key:'predictions_no_progress',stream:'predictions',severity:'degraded',critical:false,firstSeenAt:'2026-11-24T07:00:23.000Z',observedAt:'2026-11-24T13:00:23.490Z',queuedAt:'2026-11-24T13:00:23.490Z',metrics:{eligible:3078,pending:3083,idleMs:16*H,lastProgressAt:'2026-11-23T21:00:00.000Z'},id:'predictions_no_progress|reminder|2026-11-24T13:00:23.490Z'},'degraded','2026-11-24T13:00:23.490Z'));
 assert.equal(text,['🔁 Напоминание · Прогнозы','Нет подтверждённого прогресса','🟠 Подтверждённая деградация','',
  'Доступно: 3 078','В очереди: 3 083','',
  '⏱ Прогресс не подтверждён: 16 ч','Последний прогресс: 23.11 22:00','',
  '🕒 Инцидент: 6 ч','Открыт: 24.11 08:00','',
  '🌐 В целом: есть проблемы','',
  '24.11 14:00:23 · Мадрид','Ref: predictions_no_progress|reminder|2026-11-24T13:00:23.490Z'].join('\n'));
}

// 13. Layout invariants over every sample above: blocks separated by exactly one empty line, no pseudo-list bullet, short lines (only the bounded
// legacy detail and the full Ref may be longer), the header first and the Madrid time and the whole Ref last, and no long parenthesised repeats.
for(const {label,text} of samples){
 const lines=text.split('\n');
 assert.ok(!text.startsWith('\n')&&!text.includes('\n\n\n'),label+': one empty line between blocks');
 assert.ok(!lines.some(line=>line.startsWith('• ')),label+': no pseudo-list');
 assert.ok(lines.at(-1).startsWith('Ref: ')&&/ · Мадрид$/.test(lines.at(-2)),label+': the time and the Ref close the message');
 assert.equal(lines[lines.length-(lines.at(-4).startsWith('📨 ')?5:3)],'',label+': the technical footer (with a late-delivery note when there is one) is its own block');
 for(const line of lines.slice(0,-1))if(!line.startsWith('Детали: ')&&!line.startsWith('Подробно: ')&&!line.startsWith('Причина'))assert.ok([...line].length<=60,label+': short line: '+line);
 assert.ok(!lines.some(line=>/\(.{40,}\)/.test(line)&&!line.startsWith('Подробно: ')&&!line.startsWith('Детали: ')),label+': no long parenthesised repeat');
}

if(process.env.IPTV_PRINT_SAMPLES)for(const item of samples)console.log('### '+item.label+'\n\n```text\n'+item.text+'\n```\n');
console.log('Monitor message: owner production reminder in the reviewed block layout, layout invariants, owner Predictions and Discovery examples, every kind and representative streams, typed statistics, domain no-progress beside incident lifetime, frozen and partial recovery, delayed delivery across midnight, unknown times, legacy messages and unsafe input passed');
