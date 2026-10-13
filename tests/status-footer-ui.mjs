import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8'),css=fs.readFileSync('public/styles.css','utf8'),app=fs.readFileSync('public/app.js','utf8');
const footer=html.match(/<footer class="status-footer"[\s\S]*?<\/footer>/)?.[0]||'';
assert.equal((footer.match(/class="status-row"/g)||[]).length,4,'collapsed status has exactly four rows');
assert.match(footer,/Модель вкуса[\s\S]*Локальная база[\s\S]*Окно просмотра[\s\S]*Последний run/);
assert.match(footer,/<details class="footer-details" id="status-details">/,'details are collapsed by default');
for(const heading of ['Прогнозы','EPG / TMDB','Watchlist','Последний запуск','Модель вкуса'])assert.match(footer,new RegExp('>'+heading+'<'));
assert.match(footer,/Вне окна в кеше/);
assert.match(footer,/Ждут фонового прогноза вне окна/);
assert.match(footer,/id="status-events-link" href="#activity-title">Смотреть события/);
assert.doesNotMatch(footer,/Фоновый прогноз заполняется|Серии и передачи исключаются|уникальных нормализованных названий|hash|prompt|token/i,'collapsed footer contains no old prose or debug data');
assert.match(app,/statusDetails\.addEventListener\('toggle'/,'expand/collapse label follows native details state');
assert.match(app,/status-events-link[\s\S]*filters\.dataset\.open='true'[\s\S]*activity-title.*scrollIntoView/,'events action reveals and navigates to the Events log');
assert.match(css,/\.status-row>strong\{[^}]*overflow-wrap:anywhere/);
assert.match(css,/@media\(max-width:760px\)[\s\S]*\.footer-details-body\{grid-template-columns:1fr/);
assert.match(css,/@media\(max-width:420px\)[\s\S]*\.status-row\{display:block\}/);

const context=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(app.replace(/init\(\);\s*$/,''),context);
context.input={profile:{version:7,updatedAt:'2026-10-12T18:00:00Z'},coverage:{confirmedFilmsTotal:100,currentPredictionsTotal:75,windowFilmsTotal:20,windowCurrentPredictions:18,cacheOffWindowTotal:80},predictions:{pendingHot:2,pendingCold:25,pendingOffWindow:23,nextBatchSize:12,nextScheduledRun:'2026-10-13T10:00:00Z'},epgTmdb:{},watchlist:{},lastRun:{status:'completed',reason:'queue_empty',startedAt:'2026-10-13T09:00:00Z',added:12,failed:0}};
const text=vm.runInContext('footerStatusText(input)',context);
assert.match(text.local,/75\/100 с актуальным прогнозом · 75%/);
assert.match(text.windowCoverage,/18\/20 с актуальным прогнозом · 90%/);
assert.match(text.runLine,/завершён \/ очередь обработана · следующий запуск/);
for(const line of [text.profile,text.local,text.windowCoverage,text.runLine])assert(line.length<100,'collapsed lines stay compact');
console.log('Status footer UI: four-line default, structured details, expand/collapse, Events navigation and responsive layout passed');
