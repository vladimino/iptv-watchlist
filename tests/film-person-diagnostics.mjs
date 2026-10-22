import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const domain=fs.readFileSync('src/domain/film-person.js','utf8');
const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const diagnostics=fs.readFileSync('src/domain/film-person-diagnostics.js','utf8');
assert.doesNotMatch(diagnostics,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(diagnostics,/scored-resolution|resolution-acceptance|discovery\.js/);
assert.doesNotMatch(diagnostics,/chris-pratt|Крис Прэтт/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js','src/continuation.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-person-diagnostics|diagnoseFilm|diagnosePerson|lifecycleCounts/,file);

const ctx=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\n'+diagnostics+'\nglobalThis.api={diagnoseFilm,diagnosePerson,lifecycleCounts,readLifecycle};',ctx);
const {diagnoseFilm,diagnosePerson,lifecycleCounts,readLifecycle}=ctx.api;

const NOW=Date.parse('2026-10-20T12:00:00.000Z');
const DAY=86400000;
const FRESH=new Date(NOW-2*DAY).toISOString();
const titles=JSON.parse(fs.readFileSync('data/film-titles.json','utf8'));
const names=JSON.parse(fs.readFileSync('data/person-names.json','utf8'));
const zorro=titles.find(film=>film.id==='28nq');
const provisional=names.find(person=>person.status==='provisional');
const history=[{score:1,replacedAt:'2026-10-01T00:00:00.000Z'}];
const store={
 watchlist:{films:[{id:'28nq',title:'The Legend of Zorro',original:'The Legend of Zorro',year:2005},{id:'abc',title:'Untitled',original:'Untitled'}]},
 programme:{films:[{id:'28nq',title:'Programme title',original:'The Legend of Zorro',tmdbId:'1656',shows:[{start:NOW-3600000}]},{id:'abc',title:'Untitled',original:'Untitled'}],people:{actors:[{id:provisional.id,name:provisional.name,original:'Original'}],directors:[]}},
 metadata:{'28nq':{id:'28nq',tmdbId:'1656',original:'The Legend of Zorro',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:FRESH,directors:[],actors:[{id:provisional.id,name:'Original',original:'Original'}]},abc:{id:'abc',original:'Untitled',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:FRESH}},
 people:{[provisional.id]:{name:'Cached',original:'Original'}},
 filmTitles:[zorro],
 personNames:names,
 personOverrides:{'actor/chris-pratt':{name:'Reviewed override',aliases:['Alias'],status:'verified',source:'https://example.invalid/person'}},
 discoveryLatest:{items:[{key:'news|2024',title:'News'},{key:'duel|2005',title:'Duel'}]},
 discoveryResolution:{'news|2024':{status:'excluded_nonfilm',reason:'show_label'},'duel|2005':{status:'verified',conflictingTmdbIds:['20','10']}},
 discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',title:'The Legend of Zorro',original:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[]},tmdb_999:{id:'tmdb_999',tmdbId:'999',title:'Heat',original:'Heat',discoveredAt:FRESH,synopsis:'Overview',directors:[],actors:[{id:'actor/chris-pratt',name:'Chris Pratt',original:'Chris Pratt'}]}},
 fingerprints:{'28nq':{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:FRESH,fingerprintHash:'print-a',filmId:'28nq'}},
 predictions:{'28nq':{current:{tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history}},
 sync:{failures:[{id:'abc',error:'Letterboxd HTTP 503'}]},
 profile:{version:3,profileHash:'profile-a'}
};
const before=JSON.stringify(store);
const view=readLifecycle(store,NOW);
const film=diagnoseFilm(store,'28nq',NOW);
const byLifecycleId=diagnoseFilm(store,'film:28nq',NOW);
const missingFilm=diagnoseFilm(store,'missing',NOW);
const person=diagnosePerson(store,provisional.id,NOW);
const byPersonId=diagnosePerson(store,'person:'+provisional.id,NOW);
const missingPerson=diagnosePerson(store,'actor/missing',NOW);
const counts=lifecycleCounts(store,NOW);
const empty=lifecycleCounts({},NOW);
assert.equal(JSON.stringify(store),before);
assert.equal(store.predictions['28nq'].history,history);
assert.equal(film.found,true);
assert.equal(film.kind,'film');
assert.equal(film.entity.id,'film:28nq');
assert.equal(film.entity.localization.status,'reviewed');
assert.equal(film.entity.identity.status,'resolved');
assert.equal(film.entity.metadata.status,'fresh');
assert.equal(film.entity.fingerprint.status,'current');
assert.equal(film.entity.prediction.status,'current');
assert.equal(film.entity.availability.hot,true);
assert.equal(Object.hasOwn(film.entity,'predictionHistory'),false);
assert.equal(JSON.stringify(film.entity).includes('predictedRating'),false);
assert.equal(JSON.stringify(film),JSON.stringify(byLifecycleId));
assert.equal(missingFilm.found,false);
assert.equal(missingFilm.id,'missing');
assert.equal(person.found,true);
assert.equal(person.entity.roleId,provisional.id);
assert.equal(person.entity.localization.status,'provisional');
assert.equal(JSON.stringify(person),JSON.stringify(byPersonId));
assert.equal(missingPerson.found,false);
assert.equal(counts.films.total,view.films.length);
assert.equal(counts.films.displayReady,view.films.filter(item=>item.identity.status!=='rejected'&&(item.identity.status==='resolved'||item.externalIds.some(id=>id.scheme==='letterboxd'))&&(item.localization.value||item.originalTitle||item.epgTitle)).length);
assert.equal(counts.films.localization.reviewed,view.films.filter(item=>item.localization.status==='reviewed').length);
assert.equal(counts.films.metadata.failed,1);
assert.equal(counts.films.fingerprint.current,1);
assert.equal(counts.films.prediction.current,1);
assert.equal(counts.films.hot,view.films.filter(item=>item.availability&&item.availability.hot).length);
assert.equal(counts.people.total,view.people.length);
assert.equal(counts.people.localization.provisional,1);
assert.equal(counts.people.localization.reviewed,1);
assert.equal(counts.candidates.total,view.candidates.length);
assert.equal(counts.candidates.excluded,1);
assert.equal(counts.conflicts,view.conflicts.length);
assert.equal(counts.parity.ok,view.parity.ok);
assert.equal(counts.parity.mismatches,view.parity.mismatches.length);
assert.equal(counts.parity.missing,view.parity.missing.length);
assert.equal(counts.parity.extra,view.parity.extra.length);
const linkedStored=diagnoseFilm(store,'tmdb_1656',NOW);
const linkedLifecycle=diagnoseFilm(store,'film:tmdb:1656',NOW);
assert.equal(linkedStored.found,true);
assert.equal(linkedStored.entity.id,'film:28nq');
assert.equal(JSON.stringify(linkedStored),JSON.stringify(linkedLifecycle));
assert.equal(JSON.stringify(linkedStored),JSON.stringify(film));
const ambiguousStore={programme:{films:[{id:'28nq',tmdbId:'1656',original:'The Legend of Zorro',title:'The Legend of Zorro'}]},metadata:{'28nq':{tmdbId:'1656',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:FRESH}},discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',original:'The Legend of Zorro',title:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview'}},discoveryResolution:{'heat|1995':{status:'ambiguous',tmdbId:'1656',filmId:'tmdb_1656',retryAt:new Date(NOW+DAY).toISOString()}},filmTitles:[],personNames:[]};
const ambiguousView=readLifecycle(ambiguousStore,NOW);
const ambiguousStored=diagnoseFilm(ambiguousStore,'tmdb_1656',NOW);
const ambiguousLifecycle=diagnoseFilm(ambiguousStore,'film:tmdb:1656',NOW);
const ambiguousLetterboxd=diagnoseFilm(ambiguousStore,'28nq',NOW);
assert.equal(ambiguousStored.entity.id,'film:tmdb:1656');
assert.equal(ambiguousStored.entity.identity.status,'ambiguous');
assert.equal(JSON.stringify(ambiguousStored),JSON.stringify(ambiguousLifecycle));
assert.equal(ambiguousLetterboxd.entity.id,'film:28nq');
assert.notEqual(ambiguousLetterboxd.entity.id,ambiguousStored.entity.id);
const ambiguousCounts=lifecycleCounts(ambiguousStore,NOW);
assert.equal(ambiguousCounts.parity.ok,false);
assert.equal(ambiguousCounts.parity.mismatches,0);
assert.equal(ambiguousCounts.parity.missing,ambiguousView.parity.missing.length);
assert.equal(ambiguousCounts.parity.extra,1);
assert.equal(JSON.stringify(ambiguousCounts).includes('tmdb_1656'),false);
assert.equal(JSON.stringify(ambiguousCounts).includes('28nq'),false);
assert.equal(JSON.stringify(counts).includes('predictedRating'),false);
assert.equal(JSON.stringify(counts).includes(provisional.name),false);
assert.equal(JSON.stringify(empty),JSON.stringify({films:{total:0,displayReady:0,catalogReady:0,predictionReady:0,hot:0,identity:{},metadata:{},localization:{},fingerprint:{},prediction:{}},people:{total:0,localization:{}},candidates:{total:0,excluded:0},conflicts:0,parity:{ok:true,mismatches:0,missing:0,extra:0}}));
console.log('Film and Person lifecycle diagnostics passed.');
