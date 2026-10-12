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
