import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const now=Date.now(),hour=3600000;
const source=vm.createContext({Date,Number,Math});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8'),source);
source.fixture={id:'one',shows:[{start:now-70*hour},{start:now-65*hour}]};
assert.equal(vm.runInContext('availabilityDeadline(fixture)',source),new Date(now+7*hour).toISOString());
source.fixture.shows.push({start:now-60*hour});
assert.equal(vm.runInContext('availabilityDeadline(fixture)',source),new Date(now+12*hour).toISOString(),'A later showing extends availability');
source.fixture.shows=[];
assert.equal(vm.runInContext('availabilityDeadline(fixture)',source),null);
source.report={watchlistCount:1,films:[{id:'one',shows:[{start:now-70*hour}]}]};
assert.equal(vm.runInContext('programmeWithWatchlist(report,null).films[0].availableUntil',source),new Date(now+2*hour).toISOString(),'Legacy snapshots get an immediate API backfill');
source.report.watchlistCount=2;
source.watchlist={films:[{id:'one',title:'Первый'},{id:'two',title:'Второй'}]};
assert.equal(vm.runInContext('programmeWithWatchlist(report,watchlist).films[1].availableUntil',source),null);

const ui=vm.createContext({Date,Intl,Set,Map,console});
vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ui);
ui.now=now;
ui.items=[
 {id:'two',title:'Б',availableUntil:new Date(now+2*hour).toISOString()},
 {id:'seven',title:'А',availableUntil:new Date(now+7*hour).toISOString()},
 {id:'eight',title:'В',availableUntil:new Date(now+8*hour+60000).toISOString()},
 {id:'expired',title:'Г',availableUntil:new Date(now-hour).toISOString()},
 {id:'unknown',title:'Д',availableUntil:null}
].map(f=>{const until=Date.parse(f.availableUntil||'');const start=Number.isFinite(until)?until-72*hour:null;return {...f,original:f.title,year:2020,genres:['Драма'],runtime:90,directors:[],actors:[],shows:start===null?[]:[{start,end:start+2*hour}]};});
vm.runInContext(`viewClock=${now}`,ui);
assert.equal(vm.runInContext('isLastChance(items[0],now)',ui),true);
assert.equal(vm.runInContext('isLastChance(items[1],now)',ui),true);
assert.equal(vm.runInContext('isLastChance({...items[2],availableUntil:new Date(now+8*3600000).toISOString()},now)',ui),false,'Exactly eight hours is not less than eight');
assert.equal(vm.runInContext('isLastChance(items[2],now)',ui),false);
assert.equal(vm.runInContext('isLastChance(items[3],now)',ui),false);
assert.equal(vm.runInContext('isLastChance(items[4],now)',ui),false);
vm.runInContext('films=items;state.to=MAX_YEAR;state.lastChanceOnly=true;',ui);
assert.equal(vm.runInContext('visibleFilms().length',ui),2);
assert.match(vm.runInContext('card(items[0])',ui),/last-chance-badge[^>]*.*Последний шанс/);
vm.runInContext('state.sort="expiring";',ui);
assert.deepEqual(Array.from(vm.runInContext('visibleFilms().map(f=>f.id)',ui)),['two','seven']);
vm.runInContext('state.lastChanceOnly=false;',ui);
assert.deepEqual(Array.from(vm.runInContext('visibleFilms().map(f=>f.id)',ui)).slice(0,2),['two','seven']);
const html=fs.readFileSync('public/index.html','utf8');
assert.match(html,/id="last-chance-only"/);
assert.match(html,/value="expiring">Сначала исчезающие/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/const films=run\.watchlist\.map\(f=>withAvailability\(/);
console.log('Last chance: saved-film deadline, legacy backfill, strict eight-hour threshold, badge, checkbox and expiry sort passed');
