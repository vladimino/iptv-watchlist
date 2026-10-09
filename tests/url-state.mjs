import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const context=vm.createContext({Date,Intl,Set,Map,URL});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
vm.runInContext(`MAX_YEAR=2027;genres=['Драма','Фантастика','Ужасы'];report={people:{directors:[{id:'director/1',name:'Кристофер Нолан'}],actors:[{id:'actor/2',name:'Крис Пратт'}]}}`,context);
const read=url=>vm.runInContext(`readUrlState(new URL(${JSON.stringify(url)}))`,context);
const serialize=url=>vm.runInContext(`urlForState(new URL(${JSON.stringify(url)})).href`,context);

const deepLink='https://iptv.example/?campaign=save&genre=%D0%A3%D0%B6%D0%B0%D1%81%D1%8B&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0&genre=%D0%A3%D0%B6%D0%B0%D1%81%D1%8B&mechanic=survival&mechanic=heist&mechanic=heist&mood=%20%D0%9C%D0%A0%D0%90%D0%A7%D0%9D%D0%AB%D0%99%20&mood=%D0%BC%D1%80%D0%B0%D1%87%D0%BD%D1%8B%D0%B9&mood=%D0%BB%D1%91%D0%B3%D0%BA%D0%B8%D0%B9&view=watchlist&period=archive&q=%D0%94%D1%8E%D0%BD%D0%B0&sort=personal&from=1990&to=2020&runtime=120&viewing=rewatch&started=1&lastChance=1&director=director%2F1&actor=actor%2F2&prediction=4.5&chance=0.85#films';
const restored=read(deepLink);
assert.equal(restored.includeUnscheduled,true);
assert.equal(restored.period,'archive');
assert.equal(restored.query,'Дюна');
assert.equal(restored.sort,'personal');
assert.deepEqual([...restored.genres].sort(),['Драма','Ужасы']);
assert.deepEqual([...restored.mechanics].sort(),['heist','survival']);
assert.deepEqual([...restored.moods].sort(),['лёгкий','мрачный']);
assert.deepEqual([restored.from,restored.to,restored.maxRuntime],[1990,2020,120]);
assert.deepEqual([restored.viewing,restored.startedOnly,restored.lastChanceOnly],['rewatch',true,true]);
assert.deepEqual([restored.directors,restored.actors],['director/1','actor/2']);
assert.deepEqual([restored.minPrediction,restored.minProbability],[4.5,.85]);
context.restored=restored;
vm.runInContext('Object.assign(state,restored)',context);
const canonical=serialize(deepLink);
const params=new URL(canonical).searchParams;
assert.equal(params.get('campaign'),'save');
assert.deepEqual(params.getAll('genre'),['Драма','Ужасы']);
assert.deepEqual(params.getAll('mechanic'),['heist','survival']);
assert.deepEqual(params.getAll('mood'),['лёгкий','мрачный']);
assert.equal(new URL(canonical).hash,'#films');
assert.equal(serialize(canonical),canonical,'serialization is deterministic');
assert.equal(read(canonical).sort,'personal','canonical link restores the sorting');

vm.runInContext(`Object.assign(state,{period:'all',sort:'title',viewing:'any',minPrediction:null,minProbability:null,startedOnly:false,lastChanceOnly:false,includeUnscheduled:false,directors:'',actors:'',query:'',genres:new Set(),mechanics:new Set(),moods:new Set(),from:1900,to:MAX_YEAR,maxRuntime:null})`,context);
assert.equal(serialize(canonical),'https://iptv.example/?campaign=save#films','defaults and reset remove only app-owned params');

const malformed=read('https://iptv.example/?view=garbage&period=old&sort=oops&genre=Invalid&genre=%D0%94%D1%80%D0%B0%D0%BC%D0%B0&mechanic=unknown&mood=%20%20&from=2028&to=abc&runtime=-2&viewing=nope&started=yes&lastChance=2&director=other&actor=other&prediction=5&chance=0.99');
assert.deepEqual([malformed.includeUnscheduled,malformed.period,malformed.sort,malformed.from,malformed.to,malformed.maxRuntime], [false,'all','title',1900,2027,null]);
assert.deepEqual([...malformed.genres],['Драма']);
assert.deepEqual([...malformed.mechanics],[]);assert.deepEqual([...malformed.moods],[]);
assert.deepEqual([malformed.viewing,malformed.startedOnly,malformed.lastChanceOnly,malformed.directors,malformed.actors,malformed.minPrediction,malformed.minProbability],['any',false,false,'','',null,null]);
assert.deepEqual([read('https://iptv.example/?from=2020&to=1990').from,read('https://iptv.example/?from=2020&to=1990').to],[1900,2027]);
console.log('URL state: complete deep-link round trip, multi-value genres, defaults, foreign params, deterministic order and invalid values passed');
