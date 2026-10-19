import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const parses={count:0};
const countingJSON={parse(...args){parses.count++;return JSON.parse(...args);},stringify(...args){parses.count++;return JSON.stringify(...args);}};
const ctx=vm.createContext({Date,Intl,Set,Map,URL,JSON:countingJSON});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const now=Date.now();
const film=(id,title,genres,year,runtime,shows=true)=>({id,title,original:title,aliases:[],year,runtime,genres,directors:[],actors:[],shows:shows?[{start:now,offset:0}]:[]});
ctx.sample=[
 film('a','Побег Альфа',['Драма'],2010,90),
 film('b','Побег Бета',['Драма'],2010,110),
 film('c','Комедия',['Комедия'],2015,80),
 film('d','Без отпечатка',['Драма'],2010,90),
 film('e','Неизвестно',['Драма'],2010,90),
 film('f','Вне эфира',['Драма'],2012,95,false),
];
ctx.saved={films:{
 a:{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast',decision_logic:'strong',payoff:'strong',plot_engine:'unknown'}}},
 b:{fingerprint:{plotMechanics:['heist'],moodIds:['dark'],execution:{pace:'medium',decision_logic:'strong',payoff:'weak'}}},
 c:{fingerprint:{plotMechanics:['rescue'],moodIds:['light'],execution:{pace:'fast',decision_logic:'weak',payoff:'strong',horror_rule_consistency:'strong'}}},
 d:{},
 e:{fingerprint:{execution:{pace:'unknown',decision_logic:'strong',payoff:'strong',opposition_competence:'not_applicable'}}},
 f:{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast',decision_logic:'strong',payoff:'strong'}}},
}};
vm.runInContext('films=sample;enrichment=saved;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;genres=["Драма","Комедия"]',ctx);
const ids=()=>Array.from(vm.runInContext('visibleFilms().map(f=>f.id)',ctx));
assert.equal(vm.runInContext('storedExecution(sample[0])',ctx),ctx.saved.films.a.fingerprint.execution,'filtering reads the stored execution object');
const before=parses.count;
vm.runInContext('state.execution.pace.add("fast");state.execution.pace.add("medium")',ctx);
assert.deepEqual(ids().sort(),['a','b','c'],'OR within one execution dimension');
vm.runInContext('state.execution.decision_logic.add("strong");state.execution.payoff.add("strong")',ctx);
assert.deepEqual(ids(),['a'],'AND across execution dimensions');
assert.equal(parses.count,before,'filtering does not parse or serialize fingerprints');
vm.runInContext('state.includeUnscheduled=true',ctx);
assert.deepEqual(ids().sort(),['a','f'],'the same execution filters apply to the full watchlist');
vm.runInContext('state.mechanics=new Set(["heist"]);state.moods=new Set(["tense"]);state.genres=new Set(["Драма"]);state.query="Побег";state.from=2000;state.to=2012;state.maxRuntime=100',ctx);
assert.deepEqual(ids(),['a'],'execution combines with mechanics, mood, genre, year, runtime and search');
vm.runInContext('state.includeUnscheduled=false;state.mechanics=new Set();state.moods=new Set();state.genres=new Set();state.query="";state.from=1900;state.to=MAX_YEAR;state.maxRuntime=null;for(const set of Object.values(state.execution))set.clear();state.execution.pace.add("fast")',ctx);
assert.deepEqual(ids().sort(),['a','c'],'missing and unknown execution values do not match');
const box={innerHTML:'',querySelectorAll:()=>[]},empty={hidden:true};
ctx.document={querySelector:key=>key==='#execution'?box:key==='#execution-empty'?empty:null,querySelectorAll:()=>[]};
vm.runInContext('state.execution.pace.add("slow");updateExecutionOptions()',ctx);
assert.match(box.innerHTML,/Темп/);
assert.match(box.innerHTML,/value="fast"/);
assert.match(box.innerHTML,/value="medium"/);
assert.match(box.innerHTML,/value="slow"[\s\S]*genre-count">0</);
assert.doesNotMatch(box.innerHTML,/unknown|not_applicable|horror_rule/);
assert.equal(empty.hidden,true);
vm.runInContext('for(const set of Object.values(state.execution))set.clear();state.execution.pace.add("medium");state.execution.pace.add("fast");state.execution.payoff.add("strong")',ctx);
const href=vm.runInContext('urlForState(new URL("https://iptv.example/?campaign=keep")).href',ctx);
assert.equal(new URL(href).searchParams.get('campaign'),'keep');
assert.deepEqual(new URL(href).searchParams.getAll('execution'),['pace:medium','pace:fast','payoff:strong']);
ctx.restored=vm.runInContext(`readUrlState(new URL(${JSON.stringify(href+'&execution=pace:unknown&execution=horror_rule_consistency:strong&execution=nope')}))`,ctx);
assert.deepEqual([...ctx.restored.execution.pace].sort(),['fast','medium']);
assert.deepEqual([...ctx.restored.execution.payoff],['strong']);
assert.equal(ctx.restored.execution.decision_logic.size,0);
const again=vm.runInContext('Object.assign(state,restored);urlForState(new URL("https://iptv.example/?campaign=keep")).href',ctx);
assert.equal(again,href,'execution deep links round-trip in a stable order');
assert.match(vm.runInContext('executionSummary()',ctx),/Исполнение: Темп: средний, быстрый; Отдача: сильная/);
console.log('Execution filters: OR within a dimension, AND across dimensions, other filters, URL round trip, missing values and no per-render parsing passed');
