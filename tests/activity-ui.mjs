import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
context.older={id:'old',type:'enrichment',at:'2026-10-09T18:04:20Z',added:4,updated:0,remaining:144,stage:'complete'};
context.latest={id:'new',type:'enrichment',at:'2026-10-09T19:12:41Z',added:4,updated:0,remaining:282,stage:'complete'};
const html=vm.runInContext('eventHTML(latest,older)',context);
assert.match(html,/Прогнозы рассчитаны/,'remaining backlog does not make a completed batch partial');
assert.match(html,/144 \+ 142 поступило − 4 готово = 282/,'event explains growth between runs');
assert.doesNotMatch(html,/Прогнозы обновлены частично/);
context.partial={...context.latest,stage:'partial',failed:1,reason:'quota'};
assert.match(vm.runInContext('eventHTML(partial,older)',context),/Пакет прогнозов прерван/);
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
context.richFinal={...context.richProgress,stage:'partial',stopReason:'quota'};richHTML=vm.runInContext('eventHTML(richFinal)',context);assert.match(richHTML,/Причина: quota/);assert.match(richHTML,/Достигнут доступный лимит/);assert.doesNotMatch(richHTML,/hash|token|prompt|stack/i);
context.removalEvent={id:'removal',type:'watchlist',at:'2026-10-23T10:00:00Z',total:1,added:[{id:'stay',title:'Stay',year:2021}],removed:[{id:'gone',title:'Gone',year:2019,rating:4.5,ratingObservedAt:'2026-10-23T12:00:00Z'},{id:'missing',title:'Missing',year:2018},{id:'bad',title:'Bad',year:2017,rating:4.2}]};
const removalHTML=vm.runInContext('eventHTML(removalEvent)',context);
assert.match(removalHTML,/<h3>Вероятно просмотрены · 1<\/h3>[\s\S]*Gone \(2019\) · 4\.5 ★/);
assert.match(removalHTML,/<h3>Остальные удаления · 2<\/h3>[\s\S]*Missing \(2018\)[\s\S]*Bad \(2017\)/);
assert.match(removalHTML,/<h3>Добавлены фильмы · 1<\/h3>[\s\S]*Stay \(2021\)/);
assert.ok(removalHTML.indexOf('Вероятно просмотрены')<removalHTML.indexOf('Остальные удаления')&&removalHTML.indexOf('Остальные удаления')<removalHTML.indexOf('Добавлены фильмы'));
assert.equal(removalHTML.includes('event-group'),true);
assert.doesNotMatch(removalHTML,/Missing \(2018\) ·|Bad \(2017\) ·|Stay \(2021\) ·|4\.2|ratingObservedAt|letterboxd|watchedAt|чистка|diary/i);
context.ratedOnly={id:'rated-only',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'one',title:'One',year:2001,rating:5},{id:'two',title:'Two',year:2002,rating:0.5}]};
const ratedHTML=vm.runInContext('eventHTML(ratedOnly)',context);assert.match(ratedHTML,/<h3>Вероятно просмотрены · 2<\/h3>/);assert.match(ratedHTML,/One \(2001\) · 5\.0 ★/);assert.match(ratedHTML,/Two \(2002\) · 0\.5 ★/);assert.doesNotMatch(ratedHTML,/Остальные удаления|Добавлены фильмы/);
context.unknownOnly={id:'unknown-only',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'legacy',title:'Legacy',year:2001},{id:'plain',title:'Plain',year:2002}]};
const unknownHTML=vm.runInContext('eventHTML(unknownOnly)',context);assert.match(unknownHTML,/<h3>Остальные удаления · 2<\/h3>/);assert.match(unknownHTML,/Legacy \(2001\)/);assert.match(unknownHTML,/Plain \(2002\)/);assert.doesNotMatch(unknownHTML,/Вероятно просмотрены|Добавлены фильмы|★/);
context.lateEvent={id:'same-event',type:'watchlist',at:'2026-10-23T10:00:00Z',total:0,added:[],removed:[{id:'soon',title:'Soon',year:2014}]};
let lateHTML=vm.runInContext('eventHTML(lateEvent)',context);assert.match(lateHTML,/<h3>Остальные удаления · 1<\/h3>/);assert.match(lateHTML,/Soon \(2014\)/);assert.doesNotMatch(lateHTML,/Вероятно просмотрены|★/);
context.lateEvent.removed[0].rating=4;context.lateEvent.removed[0].ratingObservedAt='2026-10-23T12:00:00.000Z';
lateHTML=vm.runInContext('eventHTML(lateEvent)',context);assert.equal(context.lateEvent.id,'same-event');assert.match(lateHTML,/<h3>Вероятно просмотрены · 1<\/h3>[\s\S]*Soon \(2014\) · 4\.0 ★/);assert.doesNotMatch(lateHTML,/Остальные удаления|ratingObservedAt/);
