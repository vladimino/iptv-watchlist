import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
const footer=html.match(/<footer class="status-footer"[\s\S]*?<\/footer>/)?.[0]||'';
// AIR-389: five meaning-first indicators, in this order, and four thematic groups of details.
assert.equal((footer.match(/class="status-row(?: [^"]*)?"/g)||[]).length,5,'the collapsed status has exactly five indicators');
assert.match(footer,/Коллекция[\s\S]*Прогнозы[\s\S]*Новые 4\.0\+[\s\S]*>EPG<[\s\S]*Автоматизация/);
for(const id of ['summary-collection','summary-forecast','summary-new','summary-epg','summary-automation','status-stale-note'])assert.match(footer,new RegExp('id="'+id+'"'),id);
assert.doesNotMatch(footer,/status-run-label|status-last-run|status-next-run|Модель вкуса<\/span>|Окно просмотра<\/span>|Локальная база<\/span>/,'the old run and coverage summary rows are gone');
assert.match(footer,/<details class="footer-details" id="status-details">/,'details are collapsed by default');
assert.match(footer,/id="status-details-label">Показать детали</);
const detailsBlock=footer.match(/<details class="footer-details"[\s\S]*?<\/details>/)?.[0]||'';
assert.doesNotMatch(detailsBlock,/footer-admin-link|href="\/admin"/,'the admin link stays outside the disclosure');
assert.match(footer,/<\/details>\s*<a class="footer-admin-link" href="\/admin" data-return-carry>Админка<\/a>/,'Админка follows the details control and points at /admin');
assert.ok(footer.indexOf('id="status-details-label"')<footer.indexOf('class="footer-admin-link"'),'source order is the summary, then the admin link');
const headings=[...detailsBlock.matchAll(/<h3[^>]*>([^<]+)<\/h3>/g)].map(match=>match[1]);
assert.deepEqual(headings,['Моя коллекция','Рекомендации','Кинопрограмма','Автоматизация'],'exactly four visible groups, in this order');
const detailRows=(detailsBlock.replace(/<div data-integration="metadata" hidden>[\s\S]*?<\/div>/,'').match(/<dt\b/g)||[]).length;
assert.ok(detailRows>=15&&detailRows<=18,'about fifteen to eighteen readable rows instead of the old thirty-three: '+detailRows);
assert.match(footer,/data-integration="metadata" hidden/);
assert.match(footer,/id="status-integrations-events" href="\/events" data-return-carry>События/,'AIR-376: a real /events link, not an in-page anchor');
assert.match(footer,/id="status-health-link" href="\/admin\/health" data-return-carry>Диагностика/,'AIR-389: a link to the exact diagnostics in Admin Health');
assert.doesNotMatch(footer,/wikidata|token|stack/i);
for(const gone of ['Холодная очередь','Вне окна в кеше','Ждут фонового прогноза вне окна','Отложены до повтора','Текущий пакет','Следующий пакет','Исторический журнал','Каналы<','Проверено передач','Без метаданных','Названия требуют проверки','Последний запуск','Начат<','Добавлено','Ошибки<','По расписанию<'])assert.doesNotMatch(footer,new RegExp(gone),'removed from the user footer, kept in the API and the diagnostics: '+gone);
for(const kept of ['Всего фильмов','Просмотрено','Оценено','В watchlist','Прогнозы · вся база','Прогнозы · окно просмотра','Новые · 4.5 и выше','Новые · от 4.0 до 4.4','Модель вкуса','Обновление EPG','Известные передачи','Распознано фильмов','Ждут распознавания'])assert.match(footer,new RegExp(kept),kept);
assert.match(footer,/Счётчики пересекаются, а не складываются/,'the overlap of the collection counters is stated');
assert.match(footer,/кандидат — передача из EPG, которая ещё не опознана как фильм/,'candidates are explained as not films');
assert.doesNotMatch(html,/href="#activity-title"/,'no footer link scrolls to an anchor any more');
assert.doesNotMatch(footer,/Фоновый прогноз заполняется|Серии и передачи исключаются|уникальных нормализованных названий|hash|prompt|token/i,'collapsed footer contains no old prose or debug data');
assert.match(app,/statusDetails\.addEventListener\('toggle'/,'expand/collapse label follows native details state');
assert.match(app,/\$\('#status-integrations-events'\)[\s\S]*?plainFilmActivation\(event\)[\s\S]*?openEventsScreen\(link\)/,'the footer events link opens the wide events view on a plain click and keeps native navigation for modified clicks');
assert.match(css,/\.status-footer \.footer-status\{[^}]*width:min\(100%,680px\)/,'footer grid has a bounded readable width');
assert.match(css,/\.status-summary\{[^}]*grid-template-columns:max-content max-content[^}]*column-gap:18px[^}]*width:max-content[^}]*margin-inline:auto/,'desktop compact summary uses a centered content-sized grid');
assert.match(css,/\.status-row\{display:contents\}/,'compact rows share one label/value grid');
assert.match(css,/\.status-row>span\{[^}]*text-align:right/,'desktop labels align toward their values');
assert.match(css,/\.status-row>strong\{[^}]*text-align:left[^}]*overflow-wrap:anywhere/,'desktop values start beside the shared label column');
assert.doesNotMatch(css,/status-run-value/,'the run block styles are gone with the run block');
assert.match(css,/\.status-stale-note\{[^}]*overflow-wrap:anywhere/,'a long stale note wraps');
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
context.blankCoverage={...context.input,coverage:{}};
const blankCoverage=vm.runInContext('footerStatusText(blankCoverage)',context);
assert.equal(blankCoverage.local,'нет данных');
assert.equal(blankCoverage.windowCoverage,'нет данных');
assert.doesNotMatch(blankCoverage.local,/0|%/);
assert.doesNotMatch(blankCoverage.windowCoverage,/0|%/);
context.partialCoverage={...context.input,coverage:{confirmedFilmsTotal:10,windowFilmsTotal:4,windowCurrentPredictions:1}};
const partialCoverage=vm.runInContext('footerStatusText(partialCoverage)',context);
assert.equal(partialCoverage.local,'нет данных','a missing numerator is not a measured zero');
assert.equal(partialCoverage.windowCoverage,'1/4 с актуальным прогнозом');
context.badCount={...context.input,coverage:{confirmedFilmsTotal:10,currentPredictionsTotal:Number.NaN,windowFilmsTotal:4,windowCurrentPredictions:1,localPercent:50,windowPercent:25}};
assert.equal(vm.runInContext('footerStatusText(badCount)',context).local,'нет данных');
context.zeroCoverage={...context.input,coverage:{confirmedFilmsTotal:0,currentPredictionsTotal:0,windowFilmsTotal:0,windowCurrentPredictions:0,localPercent:0,windowPercent:0}};
const zeroCoverage=vm.runInContext('footerStatusText(zeroCoverage)',context);
assert.equal(zeroCoverage.local,'0/0 с актуальным прогнозом · 0%','an explicit zero stays a measured zero');
assert.equal(zeroCoverage.windowCoverage,'0/0 с актуальным прогнозом · 0%');
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

const adminFooterJs=fs.readFileSync('public/status-footer.js','utf8');
const sliceStart='const FOOTER_RUN_STATUS=';
const sliceEnd='finally{footerLoading=false;}}';
function footerSlice(source){
  const from=source.indexOf(sliceStart);
  const to=source.indexOf(sliceEnd, from);
  assert.ok(from>=0&&to>from, 'footer reader slice');
  assert.equal(source.indexOf(sliceStart, from+sliceStart.length), -1, 'footer reader slice stays in one place');
  return source.slice(from, to+sliceEnd.length);
}
assert.equal(footerSlice(adminFooterJs), footerSlice(app), 'the admin footer reader matches the programme reader');
for(const name of ['filmWord','madridStamp','madridDay']){
  const marker=`function ${name}(`;
  const line=source=>source.slice(source.indexOf(marker), source.indexOf('\n', source.indexOf(marker)));
  assert.equal(line(adminFooterJs), line(app), name);
}
assert.deepEqual([...adminFooterJs.matchAll(/fetch\((['"])(.*?)\1\)/g)].map(match=>match[2]), ['/api/enrichment/footer/status']);
assert.doesNotMatch(adminFooterJs, /\/api\/events|\/api\/enrichment\/view|src="\/app\.js"/);
assert.match(adminFooterJs, /querySelector\('main\.admin-shell'\)/);
assert.match(adminFooterJs, /insertAdjacentHTML\('beforeend'/);
assert.match(adminFooterJs, /setInterval\(refreshStatusFooter,60000\)/);
assert.match(adminFooterJs, /visibilitychange/);
assert.match(adminFooterJs, /loadPredictionQueue\(\{quiet:true\}\)/);
const adminMarkup=adminFooterJs.slice(adminFooterJs.indexOf('<footer class="status-footer"'), adminFooterJs.indexOf('</footer>')+'</footer>'.length);
assert.equal(adminMarkup, footer, 'the programme and the admin pages mount the same footer markup, both links /events');
assert.match(adminMarkup, /id="status-details-label">Показать детали/);
assert.match(adminMarkup, /<\/details>\s*<a class="footer-admin-link" href="\/admin" data-return-carry>Админка<\/a>/);
assert.doesNotMatch(html, /status-footer\.js/, 'the programme page keeps its own footer script');
assert.doesNotMatch(css, /html\.film-screen \.status-footer\{display:\s*none/);
assert.doesNotMatch(css, /html\.events-screen \.status-footer\{display:\s*none/);
assert.match(css, /html\.film-screen \.page-heading,html\.film-screen \.demo-note,html\.film-screen \.search-panel,html\.film-screen \.results\{display:none!important\}/, 'AIR-381: the film page replaces only the programme column');
assert.doesNotMatch(css, /html\.film-screen \.workspace\{display:none/);
assert.match(css, /html\.film-screen \.status-footer,html\.events-screen \.status-footer\{margin-top:28px\}/);
assert.match(css, /\.admin-shell>\.status-footer\{margin-top:36px\}/);
assert.doesNotMatch(css, /\.status-footer\{[^}]*position:\s*(?:fixed|sticky)/);

const nodes=new Map();
const listeners=[];
const timers=[];
const calls=[];
let mounted=false, mode='fail', visibility='visible';
function footerNode(){
  const handlers=new Map();
  return {textContent:'', hidden:false, open:false, dataset:{}, handlers, classList:{remove(){}, add(){}}, addEventListener(type,fn){handlers.set(type,fn);}, dispatch(type){handlers.get(type)?.();}};
}
const shell={insertAdjacentHTML(position, markup){assert.equal(position,'beforeend');mounted=true;for(const match of markup.matchAll(/id="([^"]+)"/g))nodes.set(match[1], footerNode());nodes.set('[data-integration="metadata"]', footerNode());}};
const document={
  get visibilityState(){return visibility;},
  body:{classList:{contains(name){return name==='admin-page';}}},
  addEventListener(type,fn){listeners.push({type,fn});},
  querySelector(selector){
    if(selector==='main.admin-shell')return shell;
    if(selector==='.status-footer')return mounted?{className:'status-footer'}:null;
    if(selector==='[data-integration="metadata"]')return nodes.get(selector)||null;
    if(selector.startsWith('#'))return nodes.get(selector.slice(1))||null;
    return null;
  }
};
const healthyFooter={generatedAt:'2026-10-13T09:30:00Z',coverage:{confirmedFilmsTotal:10,currentPredictionsTotal:10,windowFilmsTotal:4,windowCurrentPredictions:4,localPercent:100,windowPercent:100},predictions:{},epgTmdb:{},watchlist:{},integrations:{aggregate:'healthy',attentionCount:0,sources:[{id:'epg',state:'healthy',code:'ok'}]}};
const adminContext=vm.createContext({Date, Intl, document, setInterval(fn,ms){timers.push({fn,ms});}, fetch:async url=>{calls.push(String(url));if(mode==='fail')return {ok:false,status:503};return {ok:true,json:async()=>healthyFooter};}});
vm.runInContext(adminFooterJs, adminContext);
const textOf=id=>nodes.get(id).textContent;
for(let i=0;i<5&&textOf('summary-forecast')!=='статус недоступен';i++)await new Promise(resolve=>setImmediate(resolve));
assert.deepEqual(calls, ['/api/enrichment/footer/status']);
for(const id of ['summary-collection','summary-forecast','summary-new','summary-epg','summary-automation'])assert.equal(textOf(id), 'статус недоступен', id);
assert.equal(nodes.has('detail-taste')?textOf('detail-taste'):'', '', 'a failed read does not invent a taste profile');
assert.equal(timers.length, 1);assert.equal(timers[0].ms, 60000);
visibility='hidden';
timers[0].fn();
assert.equal(calls.length, 1, 'a hidden admin tab does not read the footer');
visibility='visible';
mode='ok';
timers[0].fn();
for(let i=0;i<5&&textOf('summary-automation')!=='всё работает';i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(textOf('summary-automation'), 'всё работает');
assert.match(textOf('summary-forecast'), /10\/10 с актуальным прогнозом · 100%/);
assert.match(textOf('integration-epg'), /^работает/);
assert.equal(nodes.get('status-stale-note').hidden, true, 'a fresh read shows no stale note');
mode='fail';
timers[0].fn();
for(let i=0;i<5&&textOf('summary-automation')!=='статус недоступен';i++)await new Promise(resolve=>setImmediate(resolve));
// Health is unavailable; the counts stay as a labelled stale snapshot, never as a current reading.
for(const id of ['summary-epg','summary-automation','integration-epg'])assert.equal(textOf(id), 'статус недоступен', id);
assert.equal(nodes.get('status-stale-note').hidden, false);
assert.match(textOf('status-stale-note'), /^Не удалось обновить\. Показаны данные от /);
assert.doesNotMatch(textOf('summary-automation'), /всё работает/);
assert.match(textOf('summary-forecast'), /10\/10/, 'the last confirmed count is kept, with the stale note beside it');
const warned=textOf('status-stale-note');
timers[0].fn();
await new Promise(resolve=>setImmediate(resolve));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(textOf('summary-automation'), 'статус недоступен', 'another 503 keeps the warning');
assert.equal(textOf('status-stale-note'), warned, 'the last successful read time stays put');
const onVisible=listeners.find(item=>item.type==='visibilitychange');
onVisible.fn();
await new Promise(resolve=>setImmediate(resolve));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(textOf('summary-automation'), 'статус недоступен', 'a visible refresh of a failed status does not restore the old health');
mode='ok';
onVisible.fn();
for(let i=0;i<5&&textOf('summary-automation')!=='всё работает';i++)await new Promise(resolve=>setImmediate(resolve));
assert.equal(textOf('summary-automation'), 'всё работает');
assert.match(textOf('summary-forecast'), /10\/10 с актуальным прогнозом · 100%/);
assert.match(textOf('integration-epg'), /^работает/);
assert.equal(nodes.get('status-stale-note').hidden, true, 'a recovered read clears the stale note');
assert.equal(calls.length, 6);
const details=nodes.get('status-details');
assert.equal(details.dataset.footerBound, '1');
details.open=true;details.dispatch('toggle');
assert.equal(textOf('status-details-label'), 'Скрыть детали');
details.open=false;details.dispatch('toggle');
assert.equal(textOf('status-details-label'), 'Показать детали');
assert.equal(listeners.filter(item=>item.type==='visibilitychange').length, 1);
// ---- AIR-389: the compact summary and the four groups read a known count or say "нет данных"; unknown is never 0 or healthy ----
{
 const text=payload=>{context.footerPayload=payload;return vm.runInContext('footerStatusText(footerPayload)',context);};
 const source=(id,extra={})=>({id,state:'healthy',code:'ok',lastSuccessAt:'2026-11-08T11:00:00Z',lastFailureAt:null,...extra});
 const base={generatedAt:'2026-11-08T13:00:00Z',coverage:{confirmedFilmsTotal:10,currentPredictionsTotal:7,windowFilmsTotal:4,windowCurrentPredictions:3,localPercent:70,windowPercent:75},predictions:{},watchlist:{},profile:{version:7,updatedAt:'2026-10-12T18:00:00Z'},
  epgTmdb:{recognizedFilms:12,pendingRecognition:3,epgStart:Date.parse('2026-11-08T09:00:00Z'),epgEnd:Date.parse('2026-11-12T16:38:00Z')},
  integrations:{aggregate:'healthy',attentionCount:0,sources:[source('epg',{lastSuccessAt:'2026-11-08T12:05:00Z'}),source('letterboxd_watchlist'),source('letterboxd_ratings'),source('resolver'),source('predictions')]}};
 const ru=value=>value.toLocaleString('ru');
 // A known collection and two non-overlapping new-film ranges.
 let t=text({...base,collection:{state:'ok',total:1234,watched:800,rated:700,watchlist:50},recommendations:{newUnseen:{state:'ok',rating40to44:7,rating45plus:3}}});
 assert.equal(t.collectionSummary,ru(1234)+' фильма');
 assert.deepEqual([t.collectionTotal,t.collectionWatched,t.collectionRated,t.collectionWatchlist],[ru(1234),ru(800),ru(700),ru(50)],'readable numbers');
 assert.equal(t.newSummary,'10 · 4.5+: 3');assert.equal(t.new45,'3');assert.equal(t.new40,'7');
 assert.match(t.epgSummary,/^8 нояб\./,'the confirmed EPG update, not the time the page was opened');assert.equal(t.epgUpdated,t.epgSummary);
 assert.match(t.epgHorizon,/^до 12 нояб\./);assert.equal(t.epgRecognizedText,'12');assert.equal(t.epgPendingText,'3');
 assert.equal(t.integrationAggregate,'всё работает');
 // An old EPG success is labelled as old, not as fresh.
 t=text({...base,integrations:{aggregate:'attention',attentionCount:1,sources:[source('epg',{state:'stale',code:'stale',lastSuccessAt:'2026-11-01T12:05:00Z'})]}});
 assert.match(t.epgSummary,/^1 нояб\..* · давно$/);
 // An empty collection is a known zero, and "no new films" is a known "нет".
 t=text({...base,collection:{state:'ok',total:0,watched:0,rated:0,watchlist:0},recommendations:{newUnseen:{state:'ok',rating40to44:0,rating45plus:0}}});
 assert.deepEqual([t.collectionTotal,t.collectionWatched,t.collectionRated,t.collectionWatchlist],['0','0','0','0']);assert.equal(t.newSummary,'нет');assert.equal(t.new45,'0');
 // Unknown stays unknown: no 0, no 100%, no "healthy".
 t=text({...base,collection:{state:'unknown',total:null,watched:null,rated:null,watchlist:null},recommendations:{newUnseen:{state:'unknown',rating40to44:null,rating45plus:null}}});
 for(const key of ['collectionSummary','collectionTotal','collectionWatched','collectionRated','collectionWatchlist','newSummary','new45','new40'])assert.equal(t[key],'нет данных',key);
 // An older server (no blocks), a state that is not "ok" and non-integer counts are unknown too.
 t=text(base);for(const key of ['collectionSummary','collectionTotal','newSummary','new45'])assert.equal(t[key],'нет данных','old DTO: '+key);
 t=text({...base,collection:{state:'ok',total:'12',watched:1.5,rated:null,watchlist:undefined},recommendations:{newUnseen:{state:'ok',rating40to44:'3',rating45plus:2}}});
 assert.deepEqual([t.collectionTotal,t.collectionWatched,t.collectionRated,t.collectionWatchlist],['нет данных','нет данных','нет данных','нет данных'],'a count that is not an integer is not shown as a number');
 assert.equal(t.newSummary,'нет данных','one unreadable range makes the new-film total unknown instead of half of it');
 // No EPG block: unknown, not zero; no EPG success: no invented freshness.
 t=text({...base,epgTmdb:undefined,integrations:{aggregate:'unknown',attentionCount:0,sources:[]}});
 assert.deepEqual([t.epgRecognizedText,t.epgPendingText,t.epgHorizon,t.epgSummary],['нет данных','нет данных','нет данных','нет данных']);
 // A degraded answer (the server could not read a source, for example the Discovery ledger while its transfer is loading): null values are unknown, never 0 or 100%.
 t=text({...base,degraded:['ledger','catalog'],coverage:{confirmedFilmsTotal:null,currentPredictionsTotal:null,windowFilmsTotal:null,windowCurrentPredictions:null,cacheOffWindowTotal:null,pendingOffWindowTotal:null,localPercent:null,windowPercent:null,windowPendingTotal:null},epgTmdb:{recognizedFilms:null,pendingRecognition:null,historicalUnresolved:null,ledgerTotal:null,epgStart:null,epgEnd:null},collection:{state:'unknown',total:null,watched:null,rated:null,watchlist:null},recommendations:{newUnseen:{state:'unknown',rating40to44:null,rating45plus:null}},watchlist:{films:null}});
 for(const key of ['local','windowCoverage'])assert.equal(t[key],'нет данных',key+' is unknown, not 0/0 or 100%');
 assert.deepEqual([t.epgRecognizedText,t.epgPendingText,t.epgHorizon,t.collectionSummary,t.newSummary],['нет данных','нет данных','нет данных','нет данных','нет данных'],'ledger, collection and new-film values are unknown');
 assert.doesNotMatch(JSON.stringify([t.local,t.windowCoverage,t.epgRecognizedText,t.epgPendingText]),/100|0\/0|\b0\b/,'no invented zero or full coverage');
 // The five-source automation rows stay readable text, and a failure is not the same words as "no data".
 t=text({...base,integrations:{aggregate:'failed',attentionCount:1,sources:[source('epg',{state:'failed',code:'ok',lastFailureAt:'2026-11-08T12:00:00Z'}),source('resolver',{state:'unknown',code:'no_data',lastSuccessAt:null})]}});
 assert.equal(t.integrationAggregate,'есть сбой');assert.match(t.integrations.epg,/сбой/);assert.match(t.integrations.resolver,/нет данных/);assert.doesNotMatch(t.integrations.resolver,/сбой/,'unknown is not an error');
}
console.log('Status footer UI: five-indicator summary, four groups of about eighteen rows, known counts and "нет данных" for unknown, stale snapshot, structured details, expand/collapse, Events navigation, film and admin visibility passed');
