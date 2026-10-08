import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const html=fs.readFileSync('public/index.html','utf8');
for(const value of ['any','3.5','4','4.5'])assert.match(html,new RegExp(`data-min-prediction="${value}"`));
for(const value of ['any','0.5','0.7','0.85'])assert.match(html,new RegExp(`data-min-probability="${value}"`));

const ctx=vm.createContext({Date,Intl,Set,Map});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
const now=Date.now();
const film=(id,title,shows=true)=>({id,title,original:title,aliases:[],year:2020,runtime:100,genres:['Драма'],directors:[],actors:[],shows:shows?[{start:now,offset:0}]:[]});
ctx.sample=[
 film('missing','А без оценки'),
 film('prediction-high','Б прогноз 5'),
 film('predicted-tie','В прогноз 4.5'),
 film('actual-tie','Г моя 4.5'),
 film('predicted-low-prob','Д прогноз 4.5'),
 film('actual-lower','Е моя 4.0'),
 film('actual-no-prediction','Ж моя 3.5'),
 film('unscheduled','З без показов',false)
];
ctx.saved={films:{
 'prediction-high':{actualRating:null,prediction:{predictedRating:5,probability4Plus:.7}},
 'predicted-tie':{actualRating:null,prediction:{predictedRating:4.5,probability4Plus:.9}},
 'actual-tie':{actualRating:4.5,prediction:{predictedRating:3.5,probability4Plus:.1}},
 'predicted-low-prob':{actualRating:null,prediction:{predictedRating:4.5,probability4Plus:.7}},
 'actual-lower':{actualRating:4,prediction:{predictedRating:5,probability4Plus:.99}},
 'actual-no-prediction':{actualRating:3.5,prediction:null},
 'unscheduled':{actualRating:null,prediction:{predictedRating:4.5,probability4Plus:.85}}
}};
vm.runInContext('films=sample;enrichment=saved;ratingsLoaded=true;WINDOW_START=CUTOFF-72*3600000;WINDOW_END=CUTOFF+24*3600000;state.sort="personal"',ctx);
const ids=()=>Array.from(vm.runInContext('visibleFilms().map(f=>f.id)',ctx));
assert.deepEqual(ids(),['prediction-high','actual-tie','predicted-tie','predicted-low-prob','actual-lower','actual-no-prediction','missing']);
vm.runInContext('state.includeUnscheduled=true',ctx);
assert.deepEqual(ids(),['prediction-high','actual-tie','predicted-tie','unscheduled','predicted-low-prob','actual-lower','actual-no-prediction','missing']);

vm.runInContext('state.minPrediction=4.5;state.minProbability=.85',ctx);
assert.deepEqual(ids(),['predicted-tie','unscheduled','actual-lower'],'Both thresholds use predictions, even when a film has an actual rating');
vm.runInContext('state.minPrediction=4;state.minProbability=.7;state.query="прогноз"',ctx);
assert.deepEqual(ids(),['prediction-high','predicted-tie','predicted-low-prob'],'Search combines with both prediction thresholds');
vm.runInContext('state.query="";state.includeUnscheduled=false;state.minPrediction=null;state.minProbability=null',ctx);
assert(ids().includes('missing'),'Any thresholds retain films without a prediction');
assert(!ids().includes('unscheduled'),'Default scope remains films with showings');
vm.runInContext('state.minProbability=.5',ctx);
assert(!ids().includes('missing'),'A selected threshold excludes films without predictions');

console.log('Personal sorting and prediction filters: score source, tie-breaks, missing scores, AND logic and both scopes passed');
