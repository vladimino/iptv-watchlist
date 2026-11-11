import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
context.older={id:'old',type:'enrichment',at:'2026-10-09T18:04:20Z',added:4,updated:0,remaining:144,stage:'complete'};
context.latest={id:'new',type:'enrichment',at:'2026-10-09T19:12:41Z',added:4,updated:0,remaining:282,stage:'complete'};
const html=vm.runInContext('eventHTML(latest,older)',context);
assert.match(html,/Прогнозы рассчитаны/,'remaining backlog does not make a completed batch partial');
assert.match(html,/144 \+ 142 поступило − 4 готово = 282/,'event explains growth between runs');
assert.doesNotMatch(html,/Прогнозы обновлены частично/);
context.partial={...context.latest,stage:'partial',failed:1,reason:'quota'};
assert.match(vm.runInContext('eventHTML(partial,older)',context),/Пакет прогнозов прерван/);
// AIR-410 v2: the hourly report card. Unknown parts are «неизвестно», never 0; every sentence is fixed text chosen by status.
{
 const hour={id:'discovery-hour-a30f67e93a11-20261111T10',type:'discovery',kind:'hour',at:'2026-11-11T10:00:00.000Z',from:'2026-11-11T09:00:00.000Z',generation:'a30f67e9',status:'running',reason:null,chunks:2,checked:20,added:3,reused:2,screenedOut:4,touched:0,tmdbCalls:10,queueEmpty:false,remaining:7,incomplete:false,error:null};
 const card=event=>{context.discoveryEvent=event;return vm.runInContext('eventHTML(discoveryEvent)',context);};
 let html=card(hour);
 assert.match(html,/Найдено новых фильмов: 3/);assert.match(html,/<dt>Разобрано наблюдений<\/dt><dd>20<\/dd>/);assert.match(html,/<dt>Осталось в очереди<\/dt><dd>7<\/dd>/);
 assert.match(html,/Повторно использовано: 2 · отсеяно: 4 · запросов к TMDB: 10/);assert.match(html,/Период: с /);assert.match(html,/data-event-id="discovery-hour-a30f67e93a11-20261111T10"/);
 html=card({...hour,added:0});assert.match(html,/Новых фильмов не найдено/);assert.match(html,/<dt>Новых фильмов<\/dt><dd>0<\/dd>/,'a proven zero is shown');
 html=card({...hour,added:0,checked:0,chunks:0});assert.match(html,/Discovery работает, новых результатов за час нет/);
 html=card({...hour,added:0,checked:0,chunks:0,status:'empty',queueEmpty:true,remaining:0});assert.match(html,/Очередь Discovery пуста/);assert.match(html,/<dd>пуста<\/dd>/);
 html=card({...hour,added:0,checked:0,status:'idle',remaining:4});assert.match(html,/запуска не требовалось/);assert.doesNotMatch(html,/Очередь Discovery пуста/);
 html=card({...hour,status:'waiting',reason:'recovery_waiting'});assert.match(html,/Discovery ждёт повтора/);
 html=card({...hour,status:'blocked',reason:'projector_window'});assert.match(html,/временный отказ/);assert.doesNotMatch(html,/projector_window/,'a reason code is not printed');
 html=card({...hour,status:'failed',reason:'recovery_exhausted'});assert.match(html,/остановлен после повторных ошибок/);
 html=card({...hour,added:0,checked:0,remaining:null,queueEmpty:false});assert.match(html,/<dt>Осталось в очереди<\/dt><dd>неизвестно<\/dd>/,'an unknown remainder is not a zero');
 const unknown=card({...hour,incomplete:true,from:null,chunks:null,checked:null,added:null,reused:null,screenedOut:null,touched:null,tmdbCalls:null,remaining:null,reason:'outbox_full'});
 assert.match(unknown,/Отчёт за час неполный/);assert.match(unknown,/<dt>Новых фильмов<\/dt><dd>неизвестно<\/dd>/);assert.match(unknown,/<dt>Разобрано наблюдений<\/dt><dd>неизвестно<\/dd>/);assert.doesNotMatch(unknown,/<dd>0<\/dd>/,'an unread period never shows 0');assert.doesNotMatch(unknown,/Новых фильмов не найдено|пуста/);
 html=card({...hour,added:null,checked:5});assert.match(html,/Отчёт за час неполный/,'a null counter makes the report incomplete');
 // ADR 0116: real deltas with an unread queue keep their numbers and say only that the remainder was not read; an event of unknowns is no longer written, but one stored earlier keeps its card.
 const unread=card({...hour,added:3,checked:11,remaining:null,queueEmpty:false,queueUnreadable:true,incomplete:false});
 assert.doesNotMatch(unread,/Отчёт за час неполный/);assert.match(unread,/<dt>Новых фильмов<\/dt><dd>3<\/dd>/);assert.match(unread,/<dt>Разобрано наблюдений<\/dt><dd>11<\/dd>/);
 assert.match(unread,/<dt>Осталось в очереди<\/dt><dd>не удалось прочитать<\/dd>/);assert.match(unread,/Остаток очереди сейчас прочитать не удалось/);assert.doesNotMatch(unread,/Очередь Discovery пуста/,'an unread queue is never an empty one');
 assert.doesNotMatch(card({...hour,added:3,checked:11,remaining:4,queueUnreadable:true}),/не удалось прочитать<\/dd>/,'a known remainder is shown as a number');
 assert.doesNotMatch(card({...hour,added:3,checked:11,remaining:null,queueUnreadable:'<b>x</b>'}),/<b>|не удалось прочитать/,'only a real true counts, nothing else reaches the page');
 assert.match(card({...hour,added:0,checked:0,remaining:null,queueEmpty:false}),/<dd>неизвестно<\/dd>/,'a missing remainder without the flag keeps its old word');
 const hostile=card({...hour,id:'discovery-hour-<b>',added:'<img src=x onerror=alert(1)>',checked:'<script>alert(1)</script>',reused:{toString(){return '<i>';}},screenedOut:-5,tmdbCalls:1.5,remaining:'<u>',status:'<svg onload=1>',from:'<s>',error:'<script>'});
 assert.doesNotMatch(hostile,/<img|<script|<svg|<i>|<u>|<s>|onerror|onload/,'hostile fields never become markup');assert.match(hostile,/data-event-id="discovery-hour-&lt;b&gt;"/);
 html=card({...hour,from:'not a date'});assert.doesNotMatch(html,/Invalid|NaN/);
 html=card({...hour,kind:'run',startedAt:'2026-11-10T12:00:00.000Z'});assert.match(html,/Найдено новых фильмов: 3/,'legacy per-chain events keep their card');
}
console.log('Activity UI: completed batch, growing queue and partial failure labels passed');
context.hotEvent={id:'adaptive',type:'enrichment',at:'2026-10-11T17:00:00Z',queueSchemaVersion:3,batchSize:20,added:20,hotRemaining:200,coldRemaining:4000,stage:'complete'};
const adaptiveHTML=vm.runInContext('eventHTML(hotEvent)',context);assert.match(adaptiveHTML,/Добавлено: 20/);assert.match(adaptiveHTML,/В окне просмотра ждут прогноза: 200/);assert.doesNotMatch(adaptiveHTML,/4000|hash|prompt/i);
context.hotEvent.reason='quota';context.hotEvent.stage='partial';assert.match(vm.runInContext('eventHTML(hotEvent)',context),/лимит использования/);

context.itemProgress={id:'progress',type:'enrichment',at:'2026-10-12T05:00:00Z',queueSchemaVersion:4,stage:'running',added:48,failed:2,hotRemaining:100,coldRemaining:50};
let itemHTML=vm.runInContext('eventHTML(itemProgress)',context);assert.match(itemHTML,/Добавлено: 48/);assert.match(itemHTML,/не удалось: 2/);assert.doesNotMatch(itemHTML,/прерван/);
context.itemFinal={...context.itemProgress,stage:'complete',stopReason:'eligible_queue_empty',reason:null};itemHTML=vm.runInContext('eventHTML(itemFinal)',context);assert.doesNotMatch(itemHTML,/прерван/);
context.itemFinal.stage='partial';context.itemFinal.reason='format_error_storm';assert.match(vm.runInContext('eventHTML(itemFinal)',context),/проход прерван/);

context.systemStop={...context.itemFinal,queueSchemaVersion:5,stage:'partial',reason:'quota',added:0,hotRemaining:100,coldRemaining:50};const stopHTML=vm.runInContext('eventHTML(systemStop)',context);assert.match(stopHTML,/Прогнозы приостановлены/);assert.match(stopHTML,/Причина: quota/);assert.match(stopHTML,/Добавлено: 0/);assert.doesNotMatch(stopHTML,/hash|token|prompt/);

context.startEvent={type:'enrichment',stage:'started',queueSchemaVersion:5,at:'2026-10-12T10:00:00Z',hotRemaining:100,coldRemaining:10,currentBatchSize:12};assert.match(vm.runInContext('eventHTML(startEvent)',context),/Прогнозы запущены/);context.startEvent.stage='resumed';assert.match(vm.runInContext('eventHTML(startEvent)',context),/Прогнозы продолжены/);
context.richStart={type:'enrichment',stage:'resumed',runState:'recovered',queueSchemaVersion:6,at:'2026-10-12T11:00:00Z',delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot:{coverage:{currentPredictionsTotal:300,confirmedFilmsTotal:400,windowCurrentPredictions:80,windowFilmsTotal:100,localPercent:75,windowPercent:80},queue:{hotPending:20,coldPending:100},currentBatchSize:12}};let richHTML=vm.runInContext('eventHTML(richStart)',context);assert.match(richHTML,/Прогнозы восстановлены/);assert.match(richHTML,/Локальная база: 300 из 400 · 75%/);assert.match(richHTML,/Окно просмотра: 80 из 100 · 80%/);assert.match(richHTML,/20 в окне · 100 вне окна/);assert.match(richHTML,/Текущий пакет: 12/);
context.richProgress={type:'enrichment',stage:'running',queueSchemaVersion:6,at:'2026-10-12T12:00:00Z',delta:{added:50,updated:2,failed:1,predictionGain:48},snapshot:{coverage:{currentPredictionsTotal:348,confirmedFilmsTotal:400,windowCurrentPredictions:90,windowFilmsTotal:100,localPercent:87,windowPercent:90},queue:{hotPending:10,coldPending:52}},batchesProcessed:4};richHTML=vm.runInContext('eventHTML(richProgress)',context);assert.match(richHTML,/С начала запуска: добавлено 50 · пересчитано 2 · не удалось 1 · \+48 актуальных прогнозов/);assert.match(richHTML,/Локальная база: 348 из 400 · 87%/);assert.match(richHTML,/пакетов обработано: 4/);
context.storedTenths={type:'enrichment',stage:'complete',queueSchemaVersion:6,at:'2026-10-24T09:06:33.620Z',stopReason:'queue_empty',delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot:{coverage:{currentPredictionsTotal:2257,confirmedFilmsTotal:2260,windowCurrentPredictions:1829,windowFilmsTotal:1832,localPercent:99.9,windowPercent:99.8},queue:{hotPending:3,coldPending:0}}};richHTML=vm.runInContext('eventHTML(storedTenths)',context);assert.match(richHTML,/Локальная база: 2257 из 2260 · 99,9%/);assert.match(richHTML,/Окно просмотра: 1829 из 1832 · 99,8%/);assert.doesNotMatch(richHTML,/100%/);
// A stored queue_empty with films still outstanding (older events without slices) renders the stored counters and a neutral remainder; history is not rewritten.
assert.match(richHTML,/Осталось: 3 в окне · 0 вне окна/);assert.match(richHTML,/Остались фильмы без прогноза\./);assert.match(richHTML,/Причина: queue_empty/);assert.doesNotMatch(richHTML,/Очередь обработана полностью|ожида(ет|ют) повторной попытки|готов/);
context.drained={...context.storedTenths,snapshot:{...context.storedTenths.snapshot,coverage:{currentPredictionsTotal:2260,confirmedFilmsTotal:2260,windowCurrentPredictions:1812,windowFilmsTotal:1812,localPercent:100,windowPercent:100},queue:{hotPending:0,coldPending:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null}}};richHTML=vm.runInContext('eventHTML(drained)',context);assert.match(richHTML,/Все фильмы с актуальными прогнозами\./);assert.doesNotMatch(richHTML,/без (актуального )?прогноза/);
// Legacy zero counters are not evidence of a drained queue: with the same snapshot saying 2257 of 2260, the text stays neutral.
context.legacyZero={...context.storedTenths,snapshot:{...context.storedTenths.snapshot,queue:{hotPending:0,coldPending:0}}};richHTML=vm.runInContext('eventHTML(legacyZero)',context);assert.doesNotMatch(richHTML,/Все фильмы с актуальными прогнозами/);assert.match(richHTML,/Остаток очереди в этой записи не сохранён\./);assert.match(richHTML,/Осталось: 0 в окне · 0 вне окна/);
context.legacyZeroFull={...context.legacyZero,snapshot:{...context.storedTenths.snapshot,coverage:{currentPredictionsTotal:2260,confirmedFilmsTotal:2260,windowCurrentPredictions:1812,windowFilmsTotal:1812,localPercent:100,windowPercent:100},queue:{hotPending:0,coldPending:0}}};richHTML=vm.runInContext('eventHTML(legacyZeroFull)',context);assert.doesNotMatch(richHTML,/Все фильмы с актуальными прогнозами/,'missing slices stay unknown even when coverage happens to be complete');assert.match(richHTML,/Остаток очереди в этой записи не сохранён\./);
// Explicit slices that contradict the stored coverage do not claim full coverage either.
context.contradictory={...context.storedTenths,snapshot:{...context.storedTenths.snapshot,queue:{hotPending:0,coldPending:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null}}};richHTML=vm.runInContext('eventHTML(contradictory)',context);assert.doesNotMatch(richHTML,/Все фильмы с актуальными прогнозами/);assert.match(richHTML,/Остались фильмы без прогноза\./);
context.deferredOne={...context.storedTenths,at:'2026-10-24T19:06:33.620Z',stopReason:'eligible_queue_empty',delta:{added:0,updated:0,failed:1,predictionGain:0},snapshot:{...context.storedTenths.snapshot,coverage:{currentPredictionsTotal:2286,confirmedFilmsTotal:2287,windowCurrentPredictions:1877,windowFilmsTotal:1878,localPercent:99.9,windowPercent:99.9},queue:{hotPending:1,coldPending:0,outstanding:1,eligibleNow:0,deferredByRetry:1,nextRetryAt:'2026-10-24T21:00:00Z'}}};richHTML=vm.runInContext('eventHTML(deferredOne)',context);
assert.match(richHTML,/Локальная база: 2286 из 2287 · 99,9%/);assert.match(richHTML,/Окно просмотра: 1877 из 1878 · 99,9%/);assert.match(richHTML,/Остался 1 фильм без актуального прогноза\. Ожидает повторной попытки не раньше 23:00\./);assert.match(richHTML,/Прогнозы обновлены/);assert.doesNotMatch(richHTML,/обработана|приостановлен|прерван/);
context.deferredMany={...context.deferredOne,snapshot:{...context.deferredOne.snapshot,queue:{hotPending:2,coldPending:3,outstanding:5,eligibleNow:0,deferredByRetry:2,nextRetryAt:'2026-10-25T01:30:00Z'}}};richHTML=vm.runInContext('eventHTML(deferredMany)',context);
assert.match(richHTML,/Осталось 5 фильмов без актуального прогноза\. 2 фильма ожидают повторной попытки не раньше 25 окт\., 02:30\. Ещё 3 фильма ждут своей очереди вне окна\./);
context.readyNow={...context.deferredOne,snapshot:{...context.deferredOne.snapshot,queue:{hotPending:4,coldPending:0,outstanding:4,eligibleNow:4,deferredByRetry:0,nextRetryAt:null}}};richHTML=vm.runInContext('eventHTML(readyNow)',context);assert.match(richHTML,/Остались 4 фильма без актуального прогноза\. 4 фильма готовы к следующему запуску\./);assert.doesNotMatch(richHTML,/повторной попытки/);
context.noRetryData={...context.deferredOne,snapshot:{...context.deferredOne.snapshot,queue:{hotPending:1,coldPending:0}}};richHTML=vm.runInContext('eventHTML(noRetryData)',context);assert.match(richHTML,/Остались фильмы без прогноза\./);assert.doesNotMatch(richHTML,/не раньше|повторной попытки/,'no backoff is claimed without stored slices');
context.quotaStop={...context.deferredMany,stage:'partial',stopReason:'quota'};richHTML=vm.runInContext('eventHTML(quotaStop)',context);assert.match(richHTML,/Прогнозы приостановлены/);assert.match(richHTML,/Достигнут доступный лимит/);assert.doesNotMatch(richHTML,/без (актуального )?прогноза|повторной попытки/);
context.startDeferred={...context.richStart,snapshot:{...context.richStart.snapshot,queue:{hotPending:20,coldPending:100,outstanding:120,eligibleNow:19,deferredByRetry:1,nextRetryAt:'2026-10-12T12:00:00Z'}}};assert.match(vm.runInContext('eventHTML(startDeferred)',context),/20 в окне · 100 вне окна · отложены до повтора: 1/);
context.storedExact={...context.storedTenths,snapshot:{coverage:{currentPredictionsTotal:2260,confirmedFilmsTotal:2260,windowCurrentPredictions:1812,windowFilmsTotal:1812,localPercent:100,windowPercent:100},queue:{hotPending:0,coldPending:0}}};richHTML=vm.runInContext('eventHTML(storedExact)',context);assert.match(richHTML,/Локальная база: 2260 из 2260 · 100%/);assert.match(richHTML,/Окно просмотра: 1812 из 1812 · 100%/);assert.doesNotMatch(richHTML,/100,0%/);
context.storedInteger={...context.richStart,snapshot:{...context.richStart.snapshot,coverage:{...context.richStart.snapshot.coverage,localPercent:75,windowPercent:80}}};richHTML=vm.runInContext('eventHTML(storedInteger)',context);assert.match(richHTML,/Локальная база: 300 из 400 · 75%/);assert.match(richHTML,/Окно просмотра: 80 из 100 · 80%/);
context.richFinal={...context.richProgress,stage:'partial',stopReason:'quota'};richHTML=vm.runInContext('eventHTML(richFinal)',context);assert.match(richHTML,/Причина: quota/);assert.match(richHTML,/Достигнут доступный лимит/);assert.doesNotMatch(richHTML,/hash|token|prompt|stack/i);
context.removalEvent={id:'removal',type:'watchlist',at:'2026-10-23T10:00:00Z',total:1,added:[{id:'stay',title:'Stay',year:2021}],removed:[{id:'gone',title:'Gone',year:2019,rating:4.5,ratingObservedAt:'2026-10-23T12:00:00Z'},{id:'missing',title:'Missing',year:2018},{id:'bad',title:'Bad',year:2017,rating:4.2}]};
const removalHTML=vm.runInContext('eventHTML(removalEvent)',context);
assert.match(removalHTML,/<h3>Просмотрены · 1<\/h3>[\s\S]*Gone \(2019\) · 4\.5 ★/);
assert.match(removalHTML,/<h3>Остальные удаления · 2<\/h3>[\s\S]*Missing \(2018\)[\s\S]*Bad \(2017\)/);
assert.match(removalHTML,/<h3>Добавлены фильмы · 1<\/h3>[\s\S]*Stay \(2021\)/);
assert.ok(removalHTML.indexOf('Просмотрены')<removalHTML.indexOf('Остальные удаления')&&removalHTML.indexOf('Остальные удаления')<removalHTML.indexOf('Добавлены фильмы'));
assert.equal(removalHTML.includes('event-group'),true);
assert.doesNotMatch(removalHTML,/Missing \(2018\) ·|Bad \(2017\) ·|Stay \(2021\) ·|4\.2|ratingObservedAt|letterboxd|watchedAt|чистка|diary/i);
context.ratedOnly={id:'rated-only',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'one',title:'One',year:2001,rating:5},{id:'two',title:'Two',year:2002,rating:0.5}]};
const ratedHTML=vm.runInContext('eventHTML(ratedOnly)',context);assert.match(ratedHTML,/<h3>Просмотрены · 2<\/h3>/);assert.match(ratedHTML,/One \(2001\) · 5\.0 ★/);assert.match(ratedHTML,/Two \(2002\) · 0\.5 ★/);assert.doesNotMatch(ratedHTML,/Остальные удаления|Добавлены фильмы/);
context.unknownOnly={id:'unknown-only',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'legacy',title:'Legacy',year:2001},{id:'plain',title:'Plain',year:2002}]};
const unknownHTML=vm.runInContext('eventHTML(unknownOnly)',context);assert.match(unknownHTML,/<h3>Остальные удаления · 2<\/h3>/);assert.match(unknownHTML,/Legacy \(2001\)/);assert.match(unknownHTML,/Plain \(2002\)/);assert.doesNotMatch(unknownHTML,/Просмотрены|Добавлены фильмы|★/);
context.lateEvent={id:'same-event',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'soon',title:'Soon',year:2014}]};
let lateHTML=vm.runInContext('eventHTML(lateEvent)',context);assert.match(lateHTML,/<h3>Остальные удаления · 1<\/h3>/);assert.match(lateHTML,/Soon \(2014\)/);assert.doesNotMatch(lateHTML,/Просмотрены|★/);
context.lateEvent.removed[0].rating=4;context.lateEvent.removed[0].ratingObservedAt='2026-10-23T12:00:00.000Z';
lateHTML=vm.runInContext('eventHTML(lateEvent)',context);assert.equal(context.lateEvent.id,'same-event');assert.match(lateHTML,/<h3>Просмотрены · 1<\/h3>[\s\S]*Soon \(2014\) · 4\.0 ★/);assert.doesNotMatch(lateHTML,/Остальные удаления|ratingObservedAt/);
context.tasteEvent={id:'taste-profile-3',type:'taste_profile',at:'2026-11-02T20:15:00.000Z',fromVersion:2,toVersion:3,changedFields:['horrorPreferences'],scope:'selective'};
let tasteHTML=vm.runInContext('eventHTML(tasteEvent)',context);
assert.match(tasteHTML,/Модель вкуса обновлена/);assert.match(tasteHTML,/Версия 2 → 3/);assert.match(tasteHTML,/Изменены предпочтения для хорроров/);assert.match(tasteHTML,/Влияние: выборочное/);
assert.match(tasteHTML,/21:15/,'the publication time is shown in Europe/Madrid');
assert.doesNotMatch(tasteHTML,/horrorPreferences|profileHash|approval|declarationSha256/);
context.tasteMany={...context.tasteEvent,changedFields:['horrorPreferences','comedyPreferences'],scope:'global'};
tasteHTML=vm.runInContext('eventHTML(tasteMany)',context);assert.match(tasteHTML,/Изменены несколько разделов модели вкуса/);assert.match(tasteHTML,/Влияние: глобальное/);assert.doesNotMatch(tasteHTML,/хоррор|комеди/);
context.tasteIdentity={...context.tasteEvent,fromVersion:null,toVersion:1,changedFields:[],scope:'identity'};
tasteHTML=vm.runInContext('eventHTML(tasteIdentity)',context);assert.match(tasteHTML,/Версия 1/);assert.match(tasteHTML,/Содержание модели не изменилось/);assert.doesNotMatch(tasteHTML,/Влияние:|→/);
context.tasteUnknown={id:'<script>',type:'taste_profile',at:'2026-11-02T20:15:00.000Z',fromVersion:2,toVersion:3,changedFields:['<img src=x onerror=alert(1)>','horrorPreferences'],scope:'not-a-scope',profile:'secret profile',approval:{declarationSha256:'abc'}};
tasteHTML=vm.runInContext('eventHTML(tasteUnknown)',context);assert.match(tasteHTML,/Изменены предпочтения для хорроров/);assert.doesNotMatch(tasteHTML,/Влияние:|<img|onerror|script>|secret profile|declarationSha256/);
context.unknownType={id:'mystery',type:'no_such_event',at:'2026-11-02T20:16:00.000Z',changedFields:['<script>alert(1)</script>']};
const unknownTypeHTML=vm.runInContext('eventHTML(unknownType)',context);assert.match(unknownTypeHTML,/activity-event/);assert.doesNotMatch(unknownTypeHTML,/Модель вкуса|<script>|alert/);
// AIR-410: the Discovery tick card. Fixed sentences chosen by kind and status; every number is a non-negative integer or 0; nothing stored reaches the page as markup.
{
 const base={id:'discovery-a',type:'discovery',kind:'run',at:'2026-11-10T13:05:00.000Z',startedAt:'2026-11-10T12:00:00.000Z',status:'finished',reason:'backlog_empty',chunks:3,checked:30,added:6,reused:3,screenedOut:6,touched:0,tmdbCalls:15,remaining:0,queueEmpty:true,error:null};
 const card=event=>{context.discoveryEvent=event;return vm.runInContext('eventHTML(discoveryEvent)',context);};
 let html=card(base);
 assert.match(html,/Найдено новых фильмов: 6/);assert.match(html,/<dt>Разобрано наблюдений<\/dt><dd>30<\/dd>/);assert.match(html,/<dt>Осталось в очереди<\/dt><dd>пуста<\/dd>/);
 assert.match(html,/Повторно использовано: 3 · отсеяно: 6 · запросов к TMDB: 15/);assert.match(html,/data-event-id="discovery-a"/);
 html=card({...base,added:0});assert.match(html,/Новых фильмов не найдено/);assert.match(html,/<dt>Новых фильмов<\/dt><dd>0<\/dd>/,'a zero is shown, not hidden');
 html=card({...base,added:0,checked:0,chunks:1});assert.match(html,/Очередь Discovery пуста/);
 html=card({...base,added:0,checked:0,chunks:1,remaining:4,queueEmpty:false});assert.match(html,/Новых изменений нет/);assert.doesNotMatch(html,/Очередь Discovery пуста/,'0 checked with 4 left is not an empty queue');assert.match(html,/<dd>4<\/dd>/);
 html=card({...base,added:0,checked:0,remaining:null,queueEmpty:false});assert.match(html,/<dt>Осталось в очереди<\/dt><dd>неизвестен<\/dd>/,'an unknown remainder is not a zero');
 html=card({...base,kind:'empty',chunks:0,checked:0,added:0,reused:0,screenedOut:0,tmdbCalls:0});assert.match(html,/Очередь Discovery пуста/);assert.match(html,/Новых изменений нет\./);assert.match(html,/<dt>Новых фильмов<\/dt><dd>0<\/dd>/);
 html=card({...base,status:'superseded',reason:'stale_generation',remaining:12,queueEmpty:false});assert.match(html,/Прогон Discovery прерван: вышла новая программа/);assert.doesNotMatch(html,/успешно/);
 html=card({...base,status:'failed',reason:'recovery_exhausted',remaining:12,queueEmpty:false,error:'d1_unavailable'});assert.match(html,/Прогон Discovery остановлен после повторных ошибок/);assert.doesNotMatch(html,/d1_unavailable/,'an error code is not printed');
 html=card({...base,status:'stopped',reason:'executor_not_workflow',queueEmpty:false});assert.match(html,/Прогон Discovery остановлен/);
 html=card({id:'x',type:'discovery',at:'2026-11-10T13:05:00.000Z'});assert.match(html,/activity-event/);assert.match(html,/Новых изменений нет/,'a bare event still renders without a crash');
 const hostile=card({...base,id:'discovery-<b>',added:'<img src=x onerror=alert(1)>',checked:'<script>alert(1)</script>',reused:{toString(){return '<i>';}},screenedOut:-5,tmdbCalls:1.5,remaining:'<u>',status:'<svg onload=1>',kind:'<s>',error:'<script>'});
 assert.doesNotMatch(hostile,/<img|<script|<svg|<i>|<u>|<s>|onerror|onload/,'hostile fields never become markup');
 assert.match(hostile,/data-event-id="discovery-&lt;b&gt;"/,'the id attribute is escaped');
 for(const legacy of [{id:'e',type:'epg',at:'2026-11-10T13:05:00.000Z',films:1,archive:0,future:1,broadcasts:2}])assert.doesNotMatch(card(legacy),/Discovery/,'other types do not render the Discovery card');
}
console.log('Activity UI: taste-profile publication event, unknown scope, unknown type and the Discovery tick card passed');
