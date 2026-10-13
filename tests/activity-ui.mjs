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
