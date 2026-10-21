import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const domain=fs.readFileSync('src/domain/film-person.js','utf8');
const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const backfill=fs.readFileSync('src/domain/film-person-backfill.js','utf8');
assert.doesNotMatch(backfill,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(backfill,/chris-pratt|Крис Прэтт/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js','src/continuation.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-person-backfill|backfillLifecycle|personParity/,file);

const ctx=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={backfillLifecycle};',ctx);
const {backfillLifecycle}=ctx.api;

const NOW=Date.parse('2026-10-20T12:00:00.000Z');
const FRESH=new Date(NOW-2*86400000).toISOString();
const titles=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
const names=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const zorro=titles.find(film=>film.id==='28nq');
const delia=names.find(person=>person.id==='actor/delia-enea');
assert.equal(zorro.status,'verified');
assert.equal(delia.status,'provisional');
const history=[{score:1,replacedAt:'2026-10-01T00:00:00.000Z',marker:'prediction-history'}];
const store={
 watchlist:{films:[{id:'28nq',title:'The Legend of Zorro',original:'The Legend of Zorro',year:2005},{id:'part',title:'Partial Film',original:'Partial Film'}]},
 programme:{films:[{id:'28nq',title:'Зорро по программе',original:'The Legend of Zorro',tmdbId:'1656',shows:[{start:NOW-3600000}],actors:[{id:'actor/delia-enea',name:'Delia Enea',original:'Delia Enea'}],directors:[]},{id:'part',title:'Partial Film',original:'Partial Film',actors:[{id:'actor/same-slug',name:'Same Person',original:'Same Person'}],directors:[{id:'director/same-slug',name:'Same Person',original:'Same Person'}]}],people:{actors:[{id:'actor/cache-only',name:'Cache Original',original:'Cache Original'}],directors:[]}},
 metadata:{'28nq':{id:'28nq',tmdbId:'1656',original:'The Legend of Zorro',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Текст',synopsisFetchedAt:FRESH,directors:[],actors:[{id:'actor/delia-enea',name:'Delia Enea',original:'Delia Enea'}]}},
 titles:{},
 people:{'actor/cache-only':{name:'Кэш Имя',original:'Cache Original'}},
 filmTitles:[zorro],
 personNames:names,
 personOverrides:{'actor/chris-pratt':{name:'Крис Прэтт',aliases:['Крис Пратт'],status:'verified',source:'https://ru.wikipedia.org/wiki/Прэтт,_Крис'}},
 discoveryResolution:{__canonicalizedAt:'2026-10-20T00:00:00.000Z'},
 discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',title:'The Legend of Zorro',original:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[]},tmdb_50:{id:'tmdb_50',tmdbId:'50',title:'Catalog Only',original:'Catalog Only',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[{id:'actor/chris-pratt',name:'Chris Pratt',original:'Chris Pratt'}]}},
 fingerprints:{'28nq':{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:FRESH,fingerprintHash:'print-a',filmId:'28nq',plotMechanics:['heist']}},
 predictions:{'28nq':{current:{tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history}},
 profile:{version:3,profileHash:'profile-a'},
 sync:{failures:[]}
};
function deepFreeze(value){if(!value||typeof value!=='object'||Object.isFrozen(value))return value;for(const item of Object.values(value))deepFreeze(item);return Object.freeze(value);}
const frozen=deepFreeze(store);
const before=JSON.stringify(frozen);
const first=backfillLifecycle(frozen,NOW);
const second=backfillLifecycle(frozen,NOW);
assert.equal(JSON.stringify(frozen),before);
assert.equal(frozen.predictions['28nq'].history,history);
assert.equal(JSON.stringify(first),JSON.stringify(second));
const restarted=backfillLifecycle({...frozen,previousLifecycle:first.sidecars},NOW);
assert.equal(JSON.stringify(restarted),JSON.stringify(first));
assert.equal(first.contractVersion,1);
assert.equal(first.report.films.ok,true);
assert.equal(JSON.stringify(first.report.films.legacy),JSON.stringify(['28nq','part','tmdb_50']));
assert.equal(JSON.stringify(first.report.films.lifecycle),JSON.stringify(['28nq','part','tmdb_50']));
assert.equal(first.report.films.mismatches.some(item=>item.field==='title'),false);
assert.equal(first.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.storedId,'28nq');
assert.equal(first.sidecars['epg/discovered-films.lifecycle.json'].tmdb_50.storedId,'tmdb_50');
assert.equal(first.sidecars['watchlist.lifecycle.json'].part.fingerprint.status,'missing');
assert.equal(first.report.people.ok,false);
assert.equal(JSON.stringify(first.report.people.missing),JSON.stringify([]));
assert.equal(JSON.stringify(first.report.people.extra),JSON.stringify([]));
const cacheGap=first.report.people.mismatches.find(item=>item.id==='actor/cache-only'&&item.field==='name');
assert.equal(cacheGap.legacy,'Cache Original');
assert.equal(cacheGap.lifecycle,'Кэш Имя');
assert.equal(first.report.people.mismatches.some(item=>item.id==='actor/delia-enea'),false);
assert.equal(first.report.people.mismatches.some(item=>item.id==='actor/chris-pratt'),false);
assert.equal(first.report.people.mismatches.some(item=>item.id==='actor/same-slug'||item.id==='director/same-slug'),false);
assert.equal(first.report.people.legacy.includes('actor/same-slug'),true);
assert.equal(first.report.people.legacy.includes('director/same-slug'),true);
assert.equal(names.some(person=>first.report.people.legacy.includes(person.id)&&person.id!=='actor/delia-enea'),false);
const serialized=JSON.stringify(first);
assert.equal(serialized.includes('plotMechanics'),false);
assert.equal(serialized.includes('prediction-history'),false);
assert.equal(serialized.includes('predictedRating'),false);
for(const key of first.report.sidecarKeys){
 assert.equal(key.endsWith('.lifecycle.json'),true,key);
 assert.equal(key.includes('predictions'),false,key);
 assert.equal(key.includes('discovery-latest'),false,key);
 assert.equal(key.includes('programme.json'),false,key);
}
assert.equal(first.sidecars['programme.lifecycle.json'],undefined);

console.log('Film and Person lifecycle backfill passed.');
