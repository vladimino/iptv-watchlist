import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const domain=fs.readFileSync('src/domain/film-person.js','utf8'),reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
assert.doesNotMatch(reader,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(reader,/chris-pratt|Крис Прэтт/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js','src/continuation.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-person-reader|readLifecycle|shadowParity/,file);

const ctx=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\nglobalThis.api={readLifecycle,shadowParity,storedFilmId,sidecarKey,FORBIDDEN_LIFECYCLE_KEYS};',ctx);
const {readLifecycle,shadowParity,FORBIDDEN_LIFECYCLE_KEYS}=ctx.api;

const NOW=Date.parse('2026-10-20T12:00:00.000Z');
const DAY=86400000;
const FRESH=new Date(NOW-2*DAY).toISOString();
const titles=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
const names=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const zorro=titles.find(film=>film.id==='28nq');
const provisional=names.find(person=>person.status==='provisional');
assert.equal(zorro.title,'Легенда Зорро');

const history=[{score:1,replacedAt:'2026-10-01T00:00:00.000Z'}];
const store={
 watchlist:{films:[{id:'28nq',title:'The Legend of Zorro',original:'The Legend of Zorro',year:2005},{id:'abc',title:'Untitled',original:'Untitled'}]},
 programme:{films:[{id:'28nq',title:'Зорро по программе',original:'The Legend of Zorro',tmdbId:'1656',shows:[{start:NOW-3600000}]},{id:'abc',title:'Untitled',original:'Untitled'}],people:{actors:[{id:provisional.id,name:provisional.name,original:'Original'}],directors:[]}},
 metadata:{'28nq':{id:'28nq',tmdbId:'1656',original:'The Legend of Zorro',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Текст',synopsisFetchedAt:FRESH,directors:[],actors:[{id:provisional.id,name:'Original',original:'Original'}]},abc:{id:'abc',original:'Untitled',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Текст',synopsisFetchedAt:FRESH}},
 titles:{},
 people:{[provisional.id]:{name:'Автоимя',original:'Original'}},
 filmTitles:[zorro],
 personNames:names,
 personOverrides:{'actor/chris-pratt':{name:'Крис Прэтт',aliases:['Крис Пратт'],status:'verified',source:'https://ru.wikipedia.org/wiki/Прэтт,_Крис'}},
 discoveryLatest:{items:[{key:'news|2024',title:'News'},{key:'heat|1995',title:'Heat'},{key:'duel|2005',title:'Duel'}]},
 discoveryResolution:{'news|2024':{status:'excluded_nonfilm',reason:'show_label'},'heat|1995':{status:'ambiguous',tmdbId:'1656',retryAt:new Date(NOW+DAY).toISOString(),attempts:2},'duel|2005':{status:'verified',conflictingTmdbIds:['20','10']},__canonicalizedAt:'2026-10-20T00:00:00.000Z'},
 discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',title:'The Legend of Zorro',original:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[]},tmdb_999:{id:'tmdb_999',tmdbId:'999',title:'Heat',original:'Heat',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[{id:'actor/chris-pratt',name:'Chris Pratt',original:'Chris Pratt'}]}},
 fingerprints:{'28nq':{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:FRESH,fingerprintHash:'print-a',filmId:'28nq',plotMechanics:['heist']}},
 predictions:{'28nq':{current:{tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history}},
 sync:{failures:[{id:'abc',error:'Letterboxd HTTP 503'}]},
 profile:{version:3,profileHash:'profile-a'},
 now:NOW
};
const before=JSON.stringify(store);
const view=readLifecycle(store,NOW);
assert.equal(JSON.stringify(store),before);
assert.equal(store.predictions['28nq'].history,history);
assert.equal(view.contractVersion,1);
assert.equal(JSON.stringify(view.parity.legacy),JSON.stringify(['28nq','abc','tmdb_999']));
assert.equal(JSON.stringify(view.parity.lifecycle),JSON.stringify(['28nq','abc','tmdb_999']));
assert.equal(view.parity.ok,true);
assert.equal(view.parity.excludedCandidates,1);
assert.equal(view.films.length,3);
const film=view.films.find(item=>item.id==='film:28nq');
assert.equal(film.canonicalIdentity,'tmdb:1656');
assert.equal(film.localization.status,'reviewed');
assert.equal(film.localization.value,'Легенда Зорро');
assert.equal(film.aliases.some(alias=>alias.value==='Зорро по программе'),true);
assert.equal(film.metadata.status,'fresh');
assert.equal(film.metadata.source,'letterboxd');
assert.equal(film.fingerprint.status,'current');
assert.equal(film.prediction.status,'current');
assert.equal(film.prediction.nextAction,'leave');
assert.equal(film.availability.hot,true);
assert.equal(film.availability.status,undefined);
assert.equal(film.redirects.some(redirect=>redirect.from==='film:tmdb:1656'&&redirect.to==='film:28nq'),true);
assert.equal(view.films.some(item=>item.id==='film:tmdb:1656'),false);
const failed=view.films.find(item=>item.id==='film:abc');
assert.equal(failed.identity.status,'unresolved');
assert.equal(failed.identity.nextAction,'keep_letterboxd_id');
assert.equal(failed.metadata.status,'failed');
assert.equal(failed.metadata.failureReason,'Letterboxd HTTP 503');
assert.equal(failed.metadata.nextAction,'retry_metadata');
const heat=view.films.find(item=>item.id==='film:tmdb:999');
assert.equal(heat.canonicalIdentity,'tmdb:999');
assert.equal(heat.metadata.source,'tmdb');
assert.equal(heat.metadata.nextAction,'localize_names');
assert.equal(view.candidates.find(candidate=>candidate.key==='news|2024').excluded,true);
assert.equal(view.films.some(item=>JSON.stringify(item).includes('news|2024')),false);
const pending=view.candidates.find(candidate=>candidate.key==='heat|1995');
assert.equal(pending.film,null);
assert.equal(pending.identity.status,'ambiguous');
assert.equal(pending.identity.nextAction,'wait_retry');
const conflict=view.conflicts[0];
assert.equal(conflict.identity.nextAction,'surface_conflict');
assert.equal(conflict.canonicalIdentity,null);
assert.equal(view.films.includes(conflict),false);
assert.equal(view.people.length,2);
const person=view.people.find(item=>item.roleId===provisional.id);
assert.equal(person.localization.status,'provisional');
assert.equal(person.localization.sourceVersion,'provisional_transcription');
const pratt=view.people.find(item=>item.roleId==='actor/chris-pratt');
assert.equal(pratt.localization.status,'reviewed');
assert.equal(pratt.localization.value,'Крис Прэтт');
assert.notEqual(person.id,pratt.id);
assert.equal(view.sidecars['watchlist.lifecycle.json']['28nq'].localization.value,'Легенда Зорро');
assert.equal(view.sidecars['metadata.lifecycle.json'].abc.metadata.status,'failed');
assert.equal(view.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.storedId,'28nq');
assert.equal(view.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.redirects[0].from,'film:tmdb:1656');
assert.equal(view.sidecars['enrichment/films/28nq/fingerprint.lifecycle.json'].fingerprint.status,'current');
const serialized=JSON.stringify(view.sidecars);
assert.equal(serialized.includes('plotMechanics'),false);
assert.equal(serialized.includes('predictedRating'),false);
assert.equal(serialized.includes(JSON.stringify(history)),false);
for(const key of Object.keys(view.sidecars)){
 assert.equal(key.endsWith('.lifecycle.json'),true,key);
 assert.equal(FORBIDDEN_LIFECYCLE_KEYS.includes(key),false,key);
 assert.equal(key.includes('programme.json'),false,key);
 assert.equal(key.includes('discovery-latest'),false,key);
 assert.equal(key.includes('predictions'),false,key);
}
assert.equal(view.sidecars['programme.lifecycle.json'],undefined);
assert.equal(view.sidecars['epg/discovery-latest.lifecycle.json'],undefined);

const ambiguousStore={programme:{films:[{id:'28nq',tmdbId:'1656',original:'The Legend of Zorro'}]},metadata:{'28nq':{tmdbId:'1656',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Текст',synopsisFetchedAt:FRESH}},discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',original:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview'}},discoveryResolution:{'heat|1995':{status:'ambiguous',tmdbId:'1656',filmId:'tmdb_1656',retryAt:new Date(NOW+DAY).toISOString()}},filmTitles:[],personNames:[],now:NOW};
const split=readLifecycle(ambiguousStore,NOW);
assert.equal(split.parity.ok,false);
assert.equal(JSON.stringify(split.parity.extra),JSON.stringify(['tmdb_1656']));
assert.equal(split.films.find(item=>item.id==='film:tmdb:1656').canonicalIdentity,null);
assert.equal(split.films.find(item=>item.id==='film:28nq').canonicalIdentity,'tmdb:1656');
const mismatch=shadowParity(['28nq','tmdb_999'],['28nq']);
assert.equal(mismatch.ok,false);
assert.equal(JSON.stringify(mismatch.missing),JSON.stringify(['tmdb_999']));
assert.equal(JSON.stringify(mismatch.extra),JSON.stringify([]));

console.log('Film and Person lifecycle reader passed.');
