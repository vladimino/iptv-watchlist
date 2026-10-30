import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const domain=fs.readFileSync('src/domain/film-person.js','utf8');
const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const backfill=fs.readFileSync('src/domain/film-person-backfill.js','utf8');
assert.doesNotMatch(backfill,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(backfill,/chris-pratt|Крис Прэтт/);
for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/sources.js','src/mcp.js','src/continuation.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/film-person-backfill|backfillLifecycle|personParity/,file);

const ctx=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={backfillLifecycle,reconcileSidecars};',ctx);
const {backfillLifecycle,reconcileSidecars}=ctx.api;

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
assert.equal(JSON.stringify(first.sidecars),JSON.stringify(second.sidecars));
assert.equal(first.reconciliation.create.length,first.report.sidecarKeys.length);
assert.equal(first.reconciliation.update.length,0);
assert.equal(first.reconciliation.unchanged.length,0);
assert.equal(first.reconciliation.orphan.length,0);
assert.equal(first.reconciliation.conflict.length,0);
const restarted=backfillLifecycle({...frozen,persistedSidecars:JSON.parse(JSON.stringify(first.sidecars))},NOW);
assert.equal(JSON.stringify(restarted.sidecars),JSON.stringify(first.sidecars));
assert.equal(restarted.reconciliation.unchanged.length,first.report.sidecarKeys.length);
assert.equal(restarted.reconciliation.create.length,0);
assert.equal(restarted.reconciliation.conflict.length,0);
const oneMinuteLater=backfillLifecycle({...frozen,persistedSidecars:JSON.parse(JSON.stringify(first.sidecars))},NOW+60000);
assert.equal(oneMinuteLater.reconciliation.update.length,0);
assert.equal(oneMinuteLater.reconciliation.create.length,0);
assert.equal(oneMinuteLater.reconciliation.orphan.length,0);
assert.equal(oneMinuteLater.reconciliation.conflict.length,0);
const edgeAt=new Date(NOW-30*86400000).toISOString();
const aging={watchlist:{films:[{id:'edge',title:'Edge',original:'Edge'}]},metadata:{edge:{metadataAt:edgeAt,peopleVersion:1,synopsis:'Edge synopsis',synopsisFetchedAt:edgeAt,peopleNamesVersion:2}},filmTitles:[],personNames:[]};
const stillFresh=backfillLifecycle(aging,NOW);
assert.equal(stillFresh.sidecars['watchlist.lifecycle.json'].edge.metadata.status,'fresh');
const turnedStale=backfillLifecycle({...aging,persistedSidecars:stillFresh.sidecars},NOW+60000);
assert.equal(turnedStale.sidecars['watchlist.lifecycle.json'].edge.metadata.status,'stale');
assert.equal(turnedStale.reconciliation.update.includes('watchlist.lifecycle.json'),true);
const partial=backfillLifecycle({...frozen,persistedSidecars:{'people.lifecycle.json':first.sidecars['people.lifecycle.json']}},NOW);
assert.equal(partial.reconciliation.unchanged.includes('people.lifecycle.json'),true);
assert.equal(partial.reconciliation.create.includes('watchlist.lifecycle.json'),true);
assert.equal(first.sidecars['people.json'],undefined);
assert.equal(first.sidecars['programme.json'],undefined);
assert.equal(first.sidecars['people.lifecycle.json']['actor/delia-enea'].localization.status,'provisional');
assert.equal(first.sidecars['people.lifecycle.json']['actor/delia-enea'].roleId,'actor/delia-enea');
assert.equal(first.sidecars['people.lifecycle.json']['actor/same-slug'].id===first.sidecars['people.lifecycle.json']['director/same-slug'].id,false);
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

const downgraded=JSON.parse(JSON.stringify(first.sidecars));
downgraded['people.lifecycle.json']['actor/delia-enea']=JSON.parse(JSON.stringify(downgraded['people.lifecycle.json']['actor/delia-enea']));
downgraded['people.lifecycle.json']['actor/delia-enea'].localization={...downgraded['people.lifecycle.json']['actor/delia-enea'].localization,status:'reviewed',value:'Другое имя'};
const kept=reconcileSidecars(first.sidecars,downgraded);
assert.equal(kept.conflict.some(item=>item.key==='people.lifecycle.json'&&item.reason==='reviewed_downgrade'),true);
const withHistory=JSON.parse(JSON.stringify(first.sidecars));
withHistory['watchlist.lifecycle.json']['28nq']={...withHistory['watchlist.lifecycle.json']['28nq'],predictionHistory:history};
assert.equal(reconcileSidecars(first.sidecars,withHistory).conflict.some(item=>item.reason==='history'),true);
const orphan=reconcileSidecars(first.sidecars,{...first.sidecars,'enrichment/films/gone/fingerprint.lifecycle.json':{id:'film:gone',storedId:'gone',fingerprint:{status:'current'}}});
assert.equal(orphan.orphan.includes('enrichment/films/gone/fingerprint.lifecycle.json'),true);
assert.equal(orphan.update.length,0);

const catalogOnly={discoveredFilms:{tmdb_1656:{id:'tmdb_1656',tmdbId:'1656',title:'The Legend of Zorro',original:'The Legend of Zorro',discoveredAt:FRESH,synopsis:'Overview'}},filmTitles:[],personNames:[]};
const linked={...catalogOnly,watchlist:{films:[{id:'28nq',title:'The Legend of Zorro',original:'The Legend of Zorro'}]},programme:{films:[{id:'28nq',title:'Зорро по программе',original:'The Legend of Zorro',tmdbId:'1656'}]},filmTitles:[zorro]};
const beforeLink=backfillLifecycle(catalogOnly,NOW);
const persisted=JSON.parse(JSON.stringify(beforeLink.sidecars));
const fingerprintRef={status:'current',source:'kept-fingerprint'};
const predictionRef={status:'current',source:'kept-prediction'};
const callerHistory=[{score:1,replacedAt:'2026-10-01T00:00:00.000Z',marker:'prediction-history'}];
persisted['epg/discovered-films.lifecycle.json'].tmdb_1656.fingerprint=fingerprintRef;
persisted['epg/discovered-films.lifecycle.json'].tmdb_1656.prediction=predictionRef;
persisted['epg/discovered-films.lifecycle.json'].tmdb_1656.aliases=[{kind:'title',value:'Old alias',provenance:null}];
persisted['enrichment/films/tmdb_1656/fingerprint.lifecycle.json']={id:'film:tmdb:1656',storedId:'tmdb_1656',fingerprint:fingerprintRef};
const callerPredictions={'28nq':{history:callerHistory}};
const afterLink=backfillLifecycle({...linked,predictions:callerPredictions,persistedSidecars:persisted},NOW);
const adopted=afterLink.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656;
assert.equal(beforeLink.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.id,'film:tmdb:1656');
assert.equal(adopted.id,'film:tmdb:1656');
assert.equal(adopted.redirects.some(item=>item.from==='film:28nq'&&item.to==='film:tmdb:1656'),true);
assert.equal(adopted.redirects.some(item=>item.from==='film:tmdb:1656'&&item.to==='film:28nq'),false);
assert.equal(adopted.fingerprint.status,'missing');
assert.equal(adopted.prediction.status,'missing');
assert.equal(adopted.fingerprint===fingerprintRef,false);
assert.equal(adopted.prediction===predictionRef,false);
assert.equal(adopted.aliases.some(item=>item.value==='Old alias'),true);
assert.equal(JSON.stringify(afterLink.sidecars).includes('predictionHistory'),false);
assert.equal(callerPredictions['28nq'].history,callerHistory);
assert.equal(afterLink.sidecars['enrichment/films/tmdb_1656/fingerprint.lifecycle.json'].id,'film:tmdb:1656');
assert.equal(afterLink.sidecars['enrichment/films/tmdb_1656/fingerprint.lifecycle.json'].fingerprint.status,'missing');
assert.equal(afterLink.reconciliation.orphan.includes('enrichment/films/tmdb_1656/fingerprint.lifecycle.json'),false);
assert.equal(afterLink.reconciliation.update.includes('epg/discovered-films.lifecycle.json'),true);
assert.equal(afterLink.reconciliation.conflict.some(item=>item.key==='epg/discovered-films.lifecycle.json'),false);
const currentFingerprint={fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:FRESH,fingerprintHash:'print-a',filmId:'28nq'};
const schemaChanged=backfillLifecycle({...linked,fingerprints:{'28nq':{...currentFingerprint,fingerprintSchemaVersion:2}},persistedSidecars:persisted},NOW);
assert.equal(schemaChanged.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.fingerprint.status,'stale');
assert.equal(schemaChanged.sidecars['enrichment/films/tmdb_1656/fingerprint.lifecycle.json'].fingerprint.status,'stale');
const currentPrediction={tasteProfileVersion:3,tasteProfileHash:'profile-old',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4};
const profileChanged=backfillLifecycle({...linked,fingerprints:{'28nq':currentFingerprint},predictions:{'28nq':{current:currentPrediction,history:callerHistory}},profile:{version:4,profileHash:'profile-new'},persistedSidecars:persisted},NOW);
assert.equal(profileChanged.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.fingerprint.status,'current');
assert.equal(profileChanged.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.fingerprint===fingerprintRef,false);
assert.equal(profileChanged.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.prediction.status,'stale');
assert.equal(profileChanged.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656.prediction===predictionRef,false);
const reviewedPersisted=JSON.parse(JSON.stringify(beforeLink.sidecars));
reviewedPersisted['epg/discovered-films.lifecycle.json'].tmdb_1656.localization={...reviewedPersisted['epg/discovered-films.lifecycle.json'].tmdb_1656.localization,status:'reviewed',value:'Title A',source:'owner',nextAction:'keep_reviewed'};
const disagreed=backfillLifecycle({...linked,persistedSidecars:reviewedPersisted},NOW);
const keptTitle=disagreed.sidecars['epg/discovered-films.lifecycle.json'].tmdb_1656;
assert.equal(keptTitle.id,'film:tmdb:1656');
assert.equal(keptTitle.localization.status,'reviewed');
assert.equal(keptTitle.localization.value,'Title A');
assert.equal(keptTitle.localizationConflicts.some(item=>item.reason==='link_kept_survivor'&&item.value===zorro.title),true);
assert.equal(disagreed.reconciliation.conflict.some(item=>item.key==='epg/discovered-films.lifecycle.json'&&item.reason==='reviewed_conflict'),true);
const repeated=backfillLifecycle({...linked,persistedSidecars:JSON.parse(JSON.stringify(disagreed.sidecars))},NOW);
assert.equal(repeated.reconciliation.conflict.some(item=>item.key==='epg/discovered-films.lifecycle.json'&&item.reason==='reviewed_conflict'),true);
assert.equal(repeated.reconciliation.unchanged.includes('epg/discovered-films.lifecycle.json'),false);
const removed={...frozen,persistedSidecars:first.sidecars,watchlist:{films:frozen.watchlist.films.filter(film=>film.id!=='part')},programme:{...frozen.programme,films:frozen.programme.films.filter(film=>film.id!=='part')},fingerprints:{...frozen.fingerprints,part:{fingerprintSchemaVersion:1,fingerprintHash:'print-part',generatedAt:FRESH}}};
const withoutPartial=backfillLifecycle({...removed,fingerprints:frozen.fingerprints},NOW);
assert.equal(withoutPartial.reconciliation.update.includes('watchlist.lifecycle.json'),true);
assert.equal(withoutPartial.reconciliation.conflict.some(item=>item.key==='watchlist.lifecycle.json'),false);
assert.equal(withoutPartial.sidecars['watchlist.lifecycle.json'].part,undefined);
assert.equal(withoutPartial.sidecars['watchlist.lifecycle.json']['28nq'].localization.status,'reviewed');
const credit=backfillLifecycle({discoveredFilms:{tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'Credit',original:'Credit',discoveredAt:FRESH,synopsis:'Overview',actors:[{id:'tmdb_actor/10',name:'Credit Name',original:'Credit Name'}],directors:[]}},filmTitles:[],personNames:[]},NOW);
assert.equal(credit.sidecars['people.lifecycle.json']['tmdb_actor/10'].id,'person:tmdb_actor/10');
assert.equal(credit.report.people.legacy.includes('tmdb_actor/10'),true);
assert.equal(credit.report.people.missing.length,0);

console.log('Film and Person lifecycle backfill passed.');
