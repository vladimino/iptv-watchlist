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
