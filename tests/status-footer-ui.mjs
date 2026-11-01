import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
const footer=html.match(/<footer class="status-footer"[\s\S]*?<\/footer>/)?.[0]||'';
assert.equal((footer.match(/class="status-row(?: [^"]*)?"/g)||[]).length,5,'collapsed status has the four coverage rows plus integrations');
assert.match(footer,/Модель вкуса[\s\S]*Локальная база[\s\S]*Окно просмотра[\s\S]*Последний run[\s\S]*Интеграции/);
assert.match(footer,/id="status-run-label"/);assert.match(footer,/id="status-next-run">Следующий запуск по расписанию:/);assert.match(footer,/>По расписанию</);
assert.match(footer,/<details class="footer-details" id="status-details">/,'details are collapsed by default');
assert.match(footer,/id="status-details-label">Показать детали</);
const detailsBlock=footer.match(/<details class="footer-details"[\s\S]*?<\/details>/)?.[0]||'';
assert.doesNotMatch(detailsBlock,/footer-admin-link|href="\/admin"/,'the admin link stays outside the disclosure');
assert.match(footer,/<\/details>\s*<a class="footer-admin-link" href="\/admin">Админка<\/a>/,'Админка follows the details control and points at /admin');
assert.ok(footer.indexOf('id="status-details-label"')<footer.indexOf('class="footer-admin-link"'),'source order is the summary, then the admin link');
for(const heading of ['Прогнозы','EPG / TMDB','Watchlist','Интеграции','Последний запуск','Модель вкуса'])assert.match(footer,new RegExp('>'+heading+'<'));
assert.match(footer,/id="status-integrations"/);
assert.match(footer,/data-integration="metadata" hidden/);
assert.match(footer,/id="status-integrations-events" href="#activity-title">История в событиях/);
assert.doesNotMatch(footer,/wikidata|token|stack/i);
assert.match(footer,/Вне окна в кеше/);
assert.match(footer,/Ждут фонового прогноза вне окна/);
assert.match(footer,/Распознано в текущем EPG/);assert.match(footer,/Фильмы в локальной базе/);assert.match(footer,/Эти totals независимы/);
assert.match(footer,/id="status-events-link" href="#activity-title">Смотреть события/);
assert.doesNotMatch(footer,/Фоновый прогноз заполняется|Серии и передачи исключаются|уникальных нормализованных названий|hash|prompt|token/i,'collapsed footer contains no old prose or debug data');
assert.match(app,/statusDetails\.addEventListener\('toggle'/,'expand/collapse label follows native details state');
assert.match(app,/status-events-link[\s\S]*openEventsScreen\(\$\('#status-events-link'\)\)/,'events action opens the wide events view');
assert.match(app,/status-integrations-events[\s\S]*openEventsScreen\(integrationEvents\)/,'integration history opens the same events view');
assert.match(css,/\.status-footer \.footer-status\{[^}]*width:min\(100%,680px\)/,'footer grid has a bounded readable width');
assert.match(css,/\.status-summary\{[^}]*grid-template-columns:max-content max-content[^}]*column-gap:18px[^}]*width:max-content[^}]*margin-inline:auto/,'desktop compact summary uses a centered content-sized grid');
assert.match(css,/\.status-row\{display:contents\}/,'compact rows share one label/value grid');
assert.match(css,/\.status-row>span\{[^}]*text-align:right/,'desktop labels align toward their values');
assert.match(css,/\.status-row>strong\{[^}]*text-align:left[^}]*overflow-wrap:anywhere/,'desktop values start beside the shared label column');
assert.match(css,/\.status-run-value\{[^}]*justify-items:start[^}]*text-align:left/,'run value and next-run line align with other values');
const desktopSummaryRule=css.match(/\.status-summary\{([^}]*)\}/)?.[1]||'';
assert.doesNotMatch(desktopSummaryRule,/1fr/,'desktop value column does not stretch to the footer edge');
assert.match(css,/\.footer-details-body\{[^}]*grid-template-columns:repeat\(2,minmax\(0,326px\)\)[^}]*max-width:680px/,'expanded sections use the same bounded two-column grid');
assert.match(css,/\.footer-bar\{[^}]*grid-template-columns:minmax\(0,1fr\) max-content/,'the footer controls share one bottom row');
assert.match(css,/\.footer-details\{[^}]*grid-column:1 \/ -1[^}]*grid-row:1/,'open details keep the full footer width on the first row');
const summaryRule=css.match(/\.footer-details>summary\{([^}]*)\}/)?.[1]||'';
assert.match(summaryRule,/margin-left:0/,'the details summary sits on the left');
assert.doesNotMatch(summaryRule,/margin-left:auto/,'the summary no longer takes the right side of the row');
assert.match(summaryRule,/min-height:44px/,'the summary keeps a comfortable hit area');
assert.match(css,/\.footer-admin-link\{[^}]*grid-column:2[^}]*grid-row:1[^}]*justify-self:end[^}]*min-height:44px/,'Админка stays top-right, including while details are open');
assert.match(css,/\.footer-admin-link:focus-visible\{[^}]*outline:2px solid var\(--lime\)/,'the admin link has a visible focus ring');
assert.match(css,/@media\(max-width:620px\)[\s\S]*\.footer-details-body\{grid-template-columns:minmax\(0,1fr\)/);
assert.match(css,/@media\(max-width:520px\)[\s\S]*\.status-row\{display:block\}/,'narrow screens stack labels and values');
assert.match(css,/#status-integration-list>div\{grid-template-columns:minmax\(0,1fr\)/,'integration explanations sit under their labels');
assert.match(css,/\.footer-details-body dl>div\{[^}]*grid-template-columns:minmax\(6\.5rem,1fr\) minmax\(0,1\.15fr\)/,'a long detail value wraps instead of crushing its label');
assert.match(css,/#status-integration-list \[hidden\]\{display:none\}/,'a hidden integration row stays hidden inside the footer grid');
assert.match(css,/@media\(max-width:520px\)[\s\S]*\.status-row>span[^}]*text-align:left/,'stacked labels return to left alignment');

const context=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(app.replace(/init\(\);\s*$/,''),context);
context.input={generatedAt:'2026-10-13T09:30:00Z',profile:{version:7,updatedAt:'2026-10-12T18:00:00Z'},coverage:{confirmedFilmsTotal:100,currentPredictionsTotal:75,windowFilmsTotal:20,windowCurrentPredictions:18,cacheOffWindowTotal:80,localPercent:75,windowPercent:90},predictions:{pendingHot:2,pendingCold:25,pendingOffWindow:23,nextBatchSize:12,nextScheduledRun:'2026-10-13T10:00:00Z'},epgTmdb:{},watchlist:{},lastRun:{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:12,failed:0}};
const text=vm.runInContext('footerStatusText(input)',context);
assert.match(text.local,/75\/100 с актуальным прогнозом · 75%/);
assert.match(text.windowCoverage,/18\/20 с актуальным прогнозом · 90%/);
context.tenths={...context.input,coverage:{...context.input.coverage,confirmedFilmsTotal:2260,currentPredictionsTotal:2257,windowFilmsTotal:1832,windowCurrentPredictions:1829,localPercent:99.9,windowPercent:99.8}};
const tenths=vm.runInContext('footerStatusText(tenths)',context);
assert.match(tenths.local,/2[\s\u00a0\u202f]?260/);
assert.match(tenths.local,/99,9%/);
assert.doesNotMatch(tenths.local,/100%/);
assert.match(tenths.windowCoverage,/99,8%/);
assert.doesNotMatch(tenths.windowCoverage,/100%/);
context.exact={...context.input,coverage:{...context.input.coverage,confirmedFilmsTotal:2260,currentPredictionsTotal:2260,windowFilmsTotal:1812,windowCurrentPredictions:1812,localPercent:100,windowPercent:100}};
const exact=vm.runInContext('footerStatusText(exact)',context);
assert.match(exact.local,/ · 100%/);
assert.doesNotMatch(exact.local,/100,0%/);
assert.match(exact.windowCoverage,/ · 100%/);
assert.equal(text.runLabel,'Последний run');assert.equal(text.runLine,'завершён · 27 фильмов без актуального прогноза','a stored queue_empty never claims a drained queue while films are outstanding');assert.match(text.nextLine,/Следующий запуск по расписанию: около /);assert.match(text.nextRun,/^около /);
// Queue outcome comes from the stored slices, never from the stop reason alone (Europe/Madrid times).
const fullCoverage={confirmedFilmsTotal:100,currentPredictionsTotal:100,windowFilmsTotal:20,windowCurrentPredictions:20,cacheOffWindowTotal:80,localPercent:100,windowPercent:100};
const outcome=(predictions,lastRun={status:'completed',reason:'eligible_queue_empty',startedAt:'2026-10-13T09:00:00Z',added:0,failed:1},coverage=context.input.coverage)=>{context.outcome={...context.input,coverage,predictions:{...context.input.predictions,...predictions},lastRun};return vm.runInContext('footerStatusText(outcome)',context);};
let line=outcome({pendingHot:0,pendingCold:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null,nextBatchSize:0},{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:12,failed:0},fullCoverage);
assert.equal(line.runLine,'завершён · все фильмы с актуальными прогнозами');assert.equal(line.nextBatch,'очередь пуста');assert.equal(line.deferred,'нет');
line=outcome({pendingHot:1,pendingCold:0,outstanding:1,eligibleNow:0,deferredByRetry:1,nextRetryAt:'2026-10-13T21:00:00Z',nextBatchSize:0});
assert.equal(line.runLine,'завершён · 1 фильм ожидает повторной попытки не раньше 23:00');assert.equal(line.nextBatch,'ждёт повторной попытки');assert.match(line.deferred,/^1 фильм · не раньше 13 окт\., 23:00$/);assert.match(line.nextLine,/^Следующий запуск по расписанию: около 12:00$/,'the schedule estimate stays separate from the film retry time');
line=outcome({pendingHot:2,pendingCold:0,outstanding:2,eligibleNow:0,deferredByRetry:2,nextRetryAt:'2026-10-14T01:00:00Z',nextBatchSize:0});
assert.equal(line.runLine,'завершён · 2 фильма ожидают повторной попытки не раньше 14 окт., 03:00');
line=outcome({pendingHot:0,pendingCold:5,outstanding:5,eligibleNow:0,deferredByRetry:5,nextRetryAt:'2026-10-13T21:00:00Z',nextBatchSize:0});
assert.equal(line.runLine,'завершён · 5 фильмов ожидают повторной попытки не раньше 23:00','cold-only deferred work reads the same way');
line=outcome({pendingHot:3,pendingCold:0,outstanding:3,eligibleNow:3,deferredByRetry:0,nextRetryAt:null,nextBatchSize:3});
assert.equal(line.runLine,'завершён · 3 фильма готовы к следующему запуску');assert.equal(line.nextBatch,'до 3 фильмов');
line=outcome({pendingHot:3,pendingCold:0,outstanding:3,eligibleNow:0,deferredByRetry:3,nextRetryAt:'2026-10-13T21:00:00Z'},{status:'blocked',reason:'quota',startedAt:'2026-10-13T09:00:00Z',finishedAt:'2026-10-13T09:08:00Z',added:4,failed:0});
assert.equal(line.runLine,'приостановлен · лимит использования · подтверждено 13 окт., 11:08','a stored quota stop names the limit and the time the Worker recorded it');assert.match(line.deferred,/^3 фильма · не раньше /);
line=outcome({pendingHot:3,pendingCold:0,outstanding:3,eligibleNow:0,deferredByRetry:3,nextRetryAt:'2026-10-13T21:00:00Z'},{status:'blocked',reason:'quota',startedAt:'2026-10-13T09:00:00Z',added:4,failed:0});
assert.equal(line.runLine,'приостановлен · лимит использования','no confirmation time is invented when the run has no finish');
line=outcome({pendingHot:2,pendingCold:1,outstanding:undefined,eligibleNow:undefined,deferredByRetry:undefined,nextRetryAt:undefined});
assert.equal(line.runLine,'завершён · 3 фильма без актуального прогноза','missing retry data stays neutral');assert.equal(line.deferred,'нет данных');
line=outcome({pendingHot:1,pendingCold:0,outstanding:1,eligibleNow:0,deferredByRetry:1,nextRetryAt:null});
assert.equal(line.runLine,'завершён · 1 фильм ожидает повторной попытки','no time is claimed without a stored retryAt');
// Zero counters without slices (a legacy stored queue) are unknown, not drained, and coverage 75/100 is not overridden.
line=outcome({pendingHot:0,pendingCold:0,outstanding:undefined,eligibleNow:undefined,deferredByRetry:undefined,nextRetryAt:undefined,nextBatchSize:0},{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:0,failed:0});
assert.equal(line.runLine,'завершён · данные об очереди неполные');assert.equal(line.deferred,'нет данных');assert.equal(line.nextBatch,'нет данных');assert.doesNotMatch(line.runLine,/все фильмы/);
line=outcome({pendingHot:0,pendingCold:0,outstanding:undefined,eligibleNow:undefined,deferredByRetry:undefined,nextRetryAt:undefined,nextBatchSize:0},{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:0,failed:0},fullCoverage);
assert.equal(line.runLine,'завершён · данные об очереди неполные','missing slices stay unknown even with complete coverage');
// Explicit slices saying drained while coverage says 75/100: no claim of full coverage.
line=outcome({pendingHot:0,pendingCold:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null,nextBatchSize:0},{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:0,failed:0});
assert.equal(line.runLine,'завершён · остались фильмы без прогноза');assert.equal(line.nextBatch,'нет готовых фильмов');
for(const sample of [text,line])for(const value of Object.values(sample))if(typeof value==='string')assert.doesNotMatch(value,/очередь обработана|обработана полностью|пакет завершён/);
context.active={...context.input,lastRun:{status:'running',reason:null,startedAt:'2026-10-13T09:00:00Z',added:4,failed:0}};const active=vm.runInContext('footerStatusText(active)',context);assert.equal(active.runLabel,'Текущий run');assert.equal(active.runHeading,'Текущий запуск');assert.equal(active.runLine,'выполняется');assert.match(active.nextLine,/Следующий запуск по расписанию: около /);assert.doesNotMatch(active.runLine,/Последний run|следующий запуск/i);
for(const line of [text.profile,text.local,text.windowCoverage,text.runLine,text.nextLine,text.integrationAggregate])assert(line.length<100,'collapsed lines stay compact');
assert.equal(text.integrationAggregate,'нет данных');
context.ratingsBlocked={integrations:{aggregate:'attention',attentionCount:1,sources:[{id:'letterboxd_ratings',state:'degraded',code:'ratings_blocked',lastSuccessAt:'2026-10-01T09:00:00Z',lastFailureAt:'2026-10-13T08:00:00Z'},{id:'predictions',state:'healthy',code:'ok',lastSuccessAt:'2026-10-13T09:08:00Z'},{id:'epg',state:'healthy',code:'ok',lastSuccessAt:'2026-10-13T08:00:00Z'}]}};
const blockedText=vm.runInContext('footerStatusText(ratingsBlocked)',context);
assert.equal(blockedText.integrationAggregate,'1 требует внимания');
assert.equal(blockedText.integrations.letterboxd_ratings,"требует внимания · список оценок временно недоступен · ошибка 13 окт., 10:00 · успех 1 окт., 11:00");
assert.match(blockedText.integrations.predictions,/^работает/);
assert.doesNotMatch(blockedText.integrations.predictions,/сбой|недоступен/);
assert.doesNotMatch(blockedText.integrations.epg,/недоступен/);
assert.doesNotMatch(JSON.stringify(blockedText.integrations),/ratings_blocked|wikidata|token/);
context.failedIntegrations={integrations:{aggregate:'failed',failedCount:1,attentionCount:1,sources:[{id:'epg',state:'failed',code:'epg_http',lastSuccessAt:'2026-10-13T08:00:00Z',lastFailureAt:'2026-10-13T09:20:00Z'},{id:'letterboxd_ratings',state:'healthy',code:'ok',lastSuccessAt:'2026-10-13T09:10:00Z'}]}};
assert.equal(vm.runInContext('footerStatusText(failedIntegrations)',context).integrationAggregate,'есть сбой');
context.offRatings={integrations:{aggregate:'healthy',attentionCount:0,sources:[{id:'letterboxd_ratings',state:'healthy',code:'ok',manualRefreshEnabled:false,lastSuccessAt:'2026-10-13T09:10:00Z',lastFailureAt:null}]}};
const offLine=vm.runInContext('footerStatusText(offRatings)',context).integrations.letterboxd_ratings;
assert.match(offLine,/^работает · успех /);
assert.doesNotMatch(offLine,/выключено|ручн/,'no promise of a manual refresh');
context.unknownRatings={integrations:{aggregate:'attention',attentionCount:1,sources:[{id:'letterboxd_ratings',state:'unknown',code:'no_data',manualRefreshEnabled:false}]}};
assert.equal(vm.runInContext('footerStatusText(unknownRatings)',context).integrations.letterboxd_ratings,'нет данных');
context.pendingRatings={integrations:{aggregate:'attention',attentionCount:1,sources:[{id:'letterboxd_ratings',state:'degraded',code:'ratings_pending',pendingSince:'2026-10-29T04:50:00Z',lastSuccessAt:null,lastFailureAt:null,manualRefreshEnabled:false,retiredRefresh:{state:'retired',lastOutcome:'failed',code:'ratings_blocked',lastSuccessAt:null,lastFailureAt:'2026-10-29T04:57:00Z'}}]}};
const pendingLine=vm.runInContext('footerStatusText(pendingRatings)',context).integrations.letterboxd_ratings;
assert.equal(pendingLine,'требует внимания · чтение оценок не завершилось, причина неизвестна · синхронизация 29 окт., 05:50 · отдельное обновление снято, последний сбой 29 окт., 05:57');
assert.doesNotMatch(pendingLine,/временно недоступен|успех/,'pending is not shown as blocked or as a success');
context.failedRatings={integrations:{aggregate:'failed',failedCount:1,attentionCount:1,sources:[{id:'letterboxd_ratings',state:'failed',code:'ratings_failed',lastSuccessAt:'2026-10-28T04:00:00Z',lastFailureAt:'2026-10-29T04:50:00Z',retiredRefresh:null}]}};
assert.equal(vm.runInContext('footerStatusText(failedRatings)',context).integrations.letterboxd_ratings,'сбой · оценки прочитать не удалось · ошибка 29 окт., 05:50 · успех 28 окт., 05:00');
context.retiredOk={integrations:{aggregate:'attention',attentionCount:1,sources:[{id:'letterboxd_ratings',state:'unknown',code:'no_data',retiredRefresh:{state:'retired',lastOutcome:'unknown',code:null,lastSuccessAt:null,lastFailureAt:null}}]}};
assert.equal(vm.runInContext('footerStatusText(retiredOk)',context).integrations.letterboxd_ratings,'нет данных · отдельное обновление снято');
context.many={integrations:{aggregate:'attention',attentionCount:21,sources:[]}};
assert.equal(vm.runInContext('footerStatusText(many)',context).integrationAggregate,'21 требует внимания');
context.few={integrations:{aggregate:'attention',attentionCount:2,sources:[]}};
assert.equal(vm.runInContext('footerStatusText(few)',context).integrationAggregate,'2 требуют внимания');
const fullDrain={confirmedFilmsTotal:100,currentPredictionsTotal:100,windowFilmsTotal:20,windowCurrentPredictions:20,cacheOffWindowTotal:80,localPercent:100,windowPercent:100};
context.unconfirmed={...context.input,coverage:fullDrain,predictions:{pendingHot:0,pendingCold:0,outstanding:0,eligibleNow:0,deferredByRetry:0,nextRetryAt:null,nextBatchSize:0,nextScheduledRun:'2026-10-31T13:20:00Z'},lastRun:{status:'completed',reason:'queue_empty',startedAt:'2026-10-31T09:20:00Z',finishedAt:'2026-10-31T09:40:00Z',added:12,failed:0},integrations:{aggregate:'attention',attentionCount:1,failedCount:0,sources:[
 {id:'resolver',state:'degraded',code:'resolver_no_recent_progress',lastSuccessAt:'2026-10-31T10:26:39Z',lastFailureAt:null,lastBatchAt:'2026-10-31T10:26:39Z',gateAt:'2026-10-31T11:00:00Z'},
 {id:'predictions',state:'healthy',code:'ok',lastSuccessAt:'2026-10-31T09:40:00Z',lastFailureAt:null},
 {id:'epg',state:'healthy',code:'ok',lastSuccessAt:'2026-10-31T08:00:00Z'},
 {id:'letterboxd_ratings',state:'healthy',code:'ok',lastSuccessAt:'2026-10-31T08:00:00Z'}
]}};
const unconfirmed=vm.runInContext('footerStatusText(unconfirmed)',context);
assert.equal(unconfirmed.runLine,'завершён · все фильмы с актуальными прогнозами','a drained prediction queue stays a success when recognition has no newer batch');
assert.equal(unconfirmed.integrationAggregate,'распознавание: нет подтверждённого выполнения');
assert.equal(unconfirmed.integrations.resolver,'требует внимания · нет подтверждённого выполнения · вероятна внешняя блокировка; проверь Usage · последний пакет 31 окт., 11:26');
assert.match(unconfirmed.integrations.predictions,/^работает/);
assert.doesNotMatch(unconfirmed.integrations.resolver,/квот|лимит|quota|выполняется/i);
assert.doesNotMatch(unconfirmed.runLine,/лимит|квот|ошибка/);
assert.match(unconfirmed.nextLine,/^Следующий запуск по расписанию: около 14:20$/);
context.waitingGate={integrations:{aggregate:'healthy',attentionCount:0,sources:[{id:'resolver',state:'waiting',code:'resolver_waiting',lastSuccessAt:'2026-10-31T10:26:39Z',lastBatchAt:'2026-10-31T10:26:39Z',gateAt:'2026-10-31T11:00:00Z'}]}};
const waitingGate=vm.runInContext('footerStatusText(waitingGate)',context);
assert.equal(waitingGate.integrationAggregate,'всё работает');
assert.equal(waitingGate.integrations.resolver,'ожидает · не раньше 31 окт., 12:00 · последний пакет 31 окт., 11:26');
assert.doesNotMatch(waitingGate.integrations.resolver,/выполняется|квот/);
context.mixed={integrations:{aggregate:'attention',attentionCount:2,sources:[
 {id:'resolver',state:'degraded',code:'resolver_no_recent_progress',lastSuccessAt:'2026-10-30T10:00:00Z',lastBatchAt:'2026-10-31T10:26:39Z',lastFailureAt:null},
 {id:'letterboxd_ratings',state:'degraded',code:'ratings_pending',pendingSince:'2026-10-31T08:00:00Z',lastSuccessAt:null,lastFailureAt:null}
]}};
assert.equal(vm.runInContext('footerStatusText(mixed)',context).integrationAggregate,'2 требуют внимания · распознавание без подтверждённого выполнения');
context.unknownBatch={integrations:{aggregate:'attention',attentionCount:1,failedCount:0,sources:[
 {id:'resolver',state:'unknown',code:'no_data',lastSuccessAt:'2026-10-31T10:26:39Z',lastFailureAt:null,lastBatchAt:null,gateAt:'2026-10-31T11:00:00Z'},
 {id:'predictions',state:'healthy',code:'ok',lastSuccessAt:'2026-10-31T09:40:00Z'}
]}};
const unknownBatch=vm.runInContext('footerStatusText(unknownBatch)',context);
assert.equal(unknownBatch.integrations.resolver,'нет данных');
assert.equal(unknownBatch.integrationAggregate,'1 требует внимания');
assert.doesNotMatch(unknownBatch.integrations.resolver,/нет подтверждённого выполнения|Usage|выполняется/);
assert.doesNotMatch(unknownBatch.integrationAggregate,/нет подтверждённого выполнения/);
for(const sample of [unconfirmed.integrationAggregate,waitingGate.integrations.resolver])assert(sample.length<120);
console.log('Status footer UI: four-line default, structured details, expand/collapse, Events navigation and responsive layout passed');
