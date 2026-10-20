import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const ctx=vm.createContext({Date,Intl,Set,Map,URL});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
ctx.saved={films:{
 a:{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast',decision_logic:'strong',plot_engine:'unknown'}}},
 b:{fingerprint:{plotMechanics:['rescue'],moodIds:['light'],execution:{pace:'slow',decision_logic:'mixed'}}},
 c:{fingerprint:{plotMechanics:['heist'],moodIds:['tense'],execution:{pace:'fast',decision_logic:'weak'}}},
}};
vm.runInContext(`CUTOFF=1000000000000;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;const show=(channel,start)=>({channel,start,offset:(start-CUTOFF)/3600000});films=[
 {id:'a',title:'Альфа',original:'A',aliases:[],year:2020,runtime:90,genres:['Драма'],directors:[],actors:[],shows:[show('Первый',CUTOFF-3600000),show('Старый',CUTOFF-10*24*3600000)]},
 {id:'b',title:'Бета',original:'B',aliases:[],year:2020,runtime:100,genres:['Комедия'],directors:[],actors:[],shows:[show('Второй',CUTOFF-1800000)]},
 {id:'c',title:'Гамма',original:'C',aliases:[],year:2020,runtime:80,genres:['Драма'],directors:[],actors:[],shows:[show('Первый',CUTOFF+2*3600000)]},
];enrichment=saved;genres=["Драма","Комедия"]`,ctx);
assert.equal(vm.runInContext('facetSummary([])',ctx),'Любой');
assert.equal(vm.runInContext('facetSummary(["Драма","Комедия"])',ctx),'Драма +1');
const ids=()=>Array.from(vm.runInContext('visibleFilms().map(f=>f.id)',ctx));
vm.runInContext('state.channels=new Set(["Первый","Второй"])',ctx);
assert.deepEqual(ids().sort(),['a','b','c'],'channels combine with OR');
vm.runInContext('state.channels=new Set(["Старый"])',ctx);
assert.deepEqual(ids(),[],'historical shows outside the window are not a channel choice');
vm.runInContext('state.channels=new Set();state.genres=new Set();state.mechanics=new Set(["heist"]);facetCatalog=buildFacetCatalog()',ctx);
assert.equal(vm.runInContext('facetCatalog.genres.find(item=>item.value==="Комедия")',ctx),undefined,'a genre that would add no result is omitted');
assert.ok(vm.runInContext('facetCatalog.genres.find(item=>item.value==="Драма").count',ctx)>=1,'genres that remain are counted without the genre facet');
vm.runInContext('state.genres=new Set();state.mechanics=new Set(["heist"]);facetCatalog=buildFacetCatalog()',ctx);
assert.equal(vm.runInContext('facetCatalog.mechanics.find(item=>item.value==="rescue").count',ctx),1,'mechanic counts ignore the mechanic facet itself');
vm.runInContext('state.mechanics=new Set();for(const selected of Object.values(state.execution))selected.clear();state.execution.pace.add("fast");facetCatalog=buildFacetCatalog()',ctx);
const option=(group,value)=>vm.runInContext(`facetCatalog.execution.find(group=>group.id==="${group}").options.find(item=>item.value==="${value}")`,ctx);
assert.equal(vm.runInContext('facetCatalog.execution.find(group=>group.id==="decision_logic").options.some(item=>item.value==="unknown")',ctx),false);
assert.equal(option('decision_logic','mixed'),undefined,'decision_logic mixed is zero while pace fast stays applied');
assert.equal(option('decision_logic','strong').count,1);
assert.equal(option('decision_logic','weak').count,1);
assert.equal(option('pace','slow').count,1,'pace keeps its own OR choices while another pace value is selected');
assert.equal(option('pace','fast').count,2);
vm.runInContext('state.execution.pace.add("slow");facetCatalog=buildFacetCatalog()',ctx);
assert.equal(option('decision_logic','mixed').count,1,'pace values combine with OR when counting another dimension');
vm.runInContext('state.execution.pace.delete("slow");state.execution.decision_logic.add("strong");facetCatalog=buildFacetCatalog()',ctx);
assert.equal(option('pace','fast').count,1,'pace counts keep the other execution dimensions');
assert.equal(option('pace','slow'),undefined);
assert.equal(option('decision_logic','weak').count,1);
assert.equal(option('decision_logic','mixed'),undefined);
vm.runInContext('state.execution.decision_logic.clear()',ctx);
vm.runInContext('state.channels=new Set(["Первый"]);state.period="future"',ctx);
assert.deepEqual(ids(),['c'],'channel membership follows the selected availability scope');
const linked=vm.runInContext('urlForState("https://iptv.example/").search',ctx);
assert.match(linked,/channel=%D0%9F%D0%B5%D1%80%D0%B2%D1%8B%D0%B9/);
assert.match(linked,/execution=pace%3Afast/);
vm.runInContext('removeFacetValue("channels","Первый");removeFacetValue("execution","pace:fast")',ctx);
assert.equal(vm.runInContext('state.channels.size+state.execution.pace.size',ctx),0,'chips remove canonical values');
vm.runInContext('state.genres=new Set(["Драма"]);state.channels=new Set(["Первый"]);for(const set of Object.values(state.execution))set.clear()',ctx);
const restored=vm.runInContext('readUrlState(new URL("https://iptv.example/?channel=Первый&channel=Второй&execution=pace:fast&execution=decision_logic:strong"))',ctx);
assert.deepEqual([...restored.channels].sort(),['Второй','Первый']);
assert.equal(restored.execution.pace.has('fast')&&restored.execution.decision_logic.has('strong'),true,'grouped execution survives a URL round trip');
console.log('Facet pickers: summaries, scoped channels, cross-filter counts, chips and URL state passed');
