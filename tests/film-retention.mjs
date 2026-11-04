import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {archiveAdmissionsFromDocument,enrichmentInputs,filmChangeKey,listedOnWatchlist,watchlistAdmissionsFromIndex} from '../src/enrichment-projection.js';

const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const ctx=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+reader+'\nglobalThis.api={readLifecycle,reconcileDepartedFilms,storedFilmId};',ctx);
const {readLifecycle,reconcileDepartedFilms,storedFilmId}=ctx.api;
const planCtx=vm.createContext({Date,Map,Set,JSON,Object,console});
vm.runInContext(scoped('src/enrichment-projection.js','EnrichmentProjection')+'\n'+fs.readFileSync('src/d1-enrichment.js','utf8')+'\nglobalThis.plan=d1EnrichmentPlan;',planCtx);

const NOW=Date.parse('2026-11-04T00:00:00.000Z');
const FRESH=new Date(NOW-2*86400000).toISOString();
const body=(id,extra={})=>({id,original:id,tmdbId:'55',metadataAt:FRESH,peopleVersion:1,peopleNamesVersion:2,synopsis:'A plot',synopsisFetchedAt:FRESH,directors:[{id:'director/ada',original:'Ada'}],url:'https://letterboxd.com/film/'+id+'/',...extra});
const base=()=>({
 programme:{films:[],runId:'run-1'},
 watchlist:{films:[]},
 metadata:{gone:body('gone'),kept:body('kept',{tmdbId:'56'})},
 filmTitles:[{id:'gone',status:'verified',title:'Ушедший',tmdbId:'55'}],
 fingerprints:{gone:{fingerprintSchemaVersion:1,fingerprintHash:'fh',generatedAt:FRESH}},
 predictions:{gone:{current:{tasteProfileVersion:1,tasteProfileHash:'p',fingerprintHash:'fh',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history:[{predictedRating:3}]}},
 discoveredFilms:{},
 watchlistAdmissions:{gone:false,kept:true}
});
const ids=store=>[...readLifecycle(store,NOW).films].map(film=>String(storedFilmId(film))).sort();
const filmOf=(store,id)=>readLifecycle(store,NOW).films.find(item=>storedFilmId(item)===id);

const departed=base();
assert.deepEqual(ids(departed),['gone','kept']);
const gone=filmOf(departed,'gone');
assert.equal(gone.localization.status,'reviewed');
assert.equal(gone.localization.value,'Ушедший');
assert.equal(gone.predictionHistory.length,1);
assert.equal(listedOnWatchlist(departed,gone),false,'leaving the list is membership only');
assert.equal(readLifecycle(departed,NOW).people.some(person=>person.roleId==='director/ada'),true);
assert.equal(readLifecycle(departed,NOW).parity.ok,true);
assert.deepEqual(ids(departed),ids(departed),'a second read keeps the same films');

const watched=base();
watched.watchlistAdmissions={gone:false};
watched.metadata={gone:body('gone')};
assert.equal(storedFilmId(filmOf(watched,'gone')),'gone','a watched departure still keeps the film');
const plain=base();
plain.watchlistAdmissions={gone:false};
delete plain.predictions;delete plain.fingerprints;
assert.ok(filmOf(plain,'gone'),'a removal without a rating still keeps the film');

const back={...base(),watchlist:{films:[body('gone')]},watchlistAdmissions:{gone:true}};
const returned=readLifecycle(back,NOW).films.filter(item=>storedFilmId(item)==='gone');
assert.equal(returned.length,1);
assert.equal(listedOnWatchlist(back,returned[0]),true,'re-add uses the same film');

const both={...base(),programme:{films:[body('gone')],runId:'run-1'}};
assert.equal(readLifecycle(both,NOW).films.filter(item=>storedFilmId(item)==='gone').length,1);

const orphan=base();
orphan.watchlistAdmissions={};
orphan.metadata={cache:body('cache')};
orphan.fingerprints={cache:{fingerprintSchemaVersion:1,fingerprintHash:'x'}};
assert.deepEqual(ids(orphan),[],'metadata, a fingerprint or a title does not admit a film');

const foreign=base();
foreign.watchlistAdmissions={gone:false};
foreign.metadata={gone:{...body('other'),tmdbId:'99'}};
const foreignFilm=filmOf(foreign,'gone');
assert.equal(storedFilmId(foreignFilm),'gone','a cache row with another id does not drop the admitted lid');
assert.equal((foreignFilm.externalIds||[]).some(item=>item.value==='99'),false,'that cache is not this film');

const unverified={programme:{films:[],runId:'run-1'},watchlist:{films:[]},metadata:{one:body('one',{tmdbId:'7'}),two:body('two',{tmdbId:'7'})},watchlistAdmissions:{one:false,two:false},discoveredFilms:{}};
const split=readLifecycle(unverified,NOW).films;
assert.equal(split.length,2,'an unverified TMDB id does not join two lids');

const slugs={programme:{films:[],runId:'run-1'},watchlist:{films:[]},metadata:{alpha:body('alpha',{url:'https://letterboxd.com/film/same/'}),beta:body('beta',{tmdbId:'57',url:'https://letterboxd.com/film/same/'})},watchlistAdmissions:{alpha:false,beta:false},discoveredFilms:{}};
assert.equal(readLifecycle(slugs,NOW).aliasConflicts.length,1);

const index={gone:{watchlist:false,watched:true,actualRating:4},kept:{watchlist:true},mood:{fingerprintHash:'h'},'tmdb_55':{watchlist:false},'семь дней':{watchlist:false},diary:{watched:true}};
assert.deepEqual(watchlistAdmissionsFromIndex(index),{gone:false,kept:true});
const slim=base();
slim.watchlistAdmissions=watchlistAdmissionsFromIndex(index);
assert.deepEqual(ids(slim),['gone','kept']);

const view=readLifecycle(departed,NOW,{entitiesOnly:true});
const inputs=enrichmentInputs({view,store:departed});
const keptInput=inputs.films.find(item=>item.id==='film:gone');
assert.equal(keptInput.watchlist,false);
const nowIso=new Date(NOW).toISOString();
const stored=new Map([['film\nfilm:gone','stale']]);
assert.equal(planCtx.plan({films:inputs.films,people:inputs.people},stored,nowIso).absent.some(item=>item.id==='film:gone'),false);
assert.equal(planCtx.plan({films:[],people:[]},stored,nowIso).absent.some(item=>item.id==='film:gone'),true,'without the fact the same row is absent');
const current=filmChangeKey(keptInput,nowIso);
const replay=planCtx.plan({films:inputs.films,people:inputs.people},new Map([['film\nfilm:gone',current]]),nowIso);
assert.equal(replay.films.some(item=>item.id==='film:gone'),false);
assert.equal(replay.absent.some(item=>item.id==='film:gone'),false,'a second pass writes nothing and does not drop the film');
assert.match(fs.readFileSync('src/d1-enrichment.js','utf8'),/enrichment\/view-index\.json/);
assert.match(fs.readFileSync('src/d1-enrichment.js','utf8'),/watchlistAdmissionsFromIndex/);

const report=reconcileDepartedFilms({
 admissions:{remembered:false},
 existing:[{id:'film:kept',lid:'kept',tmdbId:'56',trusted:true},{id:'film:other',lid:'other',tmdbId:'56',trusted:true},{id:'film:solo',lid:'solo',tmdbId:'8',trusted:true}],
 orphans:[
  {key:'join-lid',lid:'kept',trusted:true,tmdbId:'56'},
  {key:'join-tmdb',trusted:true,tmdbId:'8'},
  {key:'fact',lid:'remembered'},
  {key:'no-film',lid:'missing',sources:['fingerprint','rating']},
  {key:'title',title:'Название',year:1999},
  {key:'slug',slug:'only-a-slug'},
  {key:'diary',title:'Дневник',sources:['diary-title']},
  {key:'cache',sources:['metadata']},
  {key:'tv',tmdbScheme:'tmdb_tv',tmdbId:'9',movieId:'9',trusted:true},
  {key:'lid-a',lid:'aaa',tmdbId:'7',slug:'shared'},
  {key:'lid-b',lid:'bbb',tmdbId:'7',slug:'shared'},
  {key:'clash',lid:'kept',trusted:true,tmdbId:'99'}
 ]
});
const byKey=Object.fromEntries(report.map(row=>[row.key,row]));
assert.equal(byKey['join-lid'].outcome,'resolved');assert.equal(byKey['join-lid'].filmId,'film:kept');
assert.equal(byKey['join-tmdb'].outcome,'resolved');assert.equal(byKey['join-tmdb'].filmId,'film:solo');
assert.equal(byKey.fact.outcome,'resolved');assert.equal(byKey.fact.reason,'watchlist_fact');
for(const key of ['no-film','title','slug','diary','cache'])assert.equal(byKey[key].outcome,'unresolved',key);
assert.equal(byKey.tv.outcome,'conflict');
assert.equal(byKey['lid-a'].outcome,'conflict');assert.equal(byKey['lid-b'].outcome,'conflict');
assert.equal(byKey.clash.outcome,'conflict');assert.equal(byKey.clash.filmId,'film:kept');
const ambiguous=reconcileDepartedFilms({orphans:[{key:'u1',lid:'u1',tmdbId:'4'},{key:'u2',lid:'u2',tmdbId:'4'}]});
assert.deepEqual(ambiguous.map(row=>row.outcome),['ambiguous','ambiguous']);
const doubled=reconcileDepartedFilms({existing:[{id:'film:a',tmdbId:'3',trusted:true},{id:'film:b',tmdbId:'3',trusted:true}],orphans:[{key:'two',trusted:true,tmdbId:'3'}]});
assert.equal(doubled[0].outcome,'conflict');

const catalogCtx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
for(const file of ['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),catalogCtx);
const now=Date.now();
const offer=(id,tmdbId,extra)=>({id,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:id,original:id,year:2020,runtime:100,genres:[],directors:[],actors:[],shows:[{start:now,channelId:'c',channel:'C'}],showsProgrammeRunId:'run',...extra});
const catalog={departed:offer('departed','11'),fresh:offer('fresh','12'),seen:offer('seen','13'),listed:offer('listed','14')};
const facet={prediction:{predictedRating:4,probability4Plus:.5,fingerprintHash:'h'},fingerprint:{fingerprintHash:'h',plotMechanics:[],execution:{}},fingerprintHash:'h'};
const available=JSON.parse(vm.runInContext('const input='+JSON.stringify({
 catalog,programme:{films:[],runId:'run'},watchlist:{films:[{id:'listed',tmdbId:'14'}]},
 index:{departed:{...facet,watchlist:false},fresh:facet,seen:{...facet,watched:true},listed:facet},
 profile:{version:1},metadata:{},programmeRunId:'run',pinned:false,now,titleExclusion:{state:'unavailable'}
})+';input.freshness={indexed:()=>true};JSON.stringify(catalogAvailable(input).films.map(film=>film.id))',catalogCtx));
assert.deepEqual(available,['fresh']);
let offerCase=0;
const offerRun=(catalog,index,metadata,watchlist={films:[]})=>{
 const name='offerCase'+(offerCase++);
 return JSON.parse(vm.runInContext('const '+name+'='+JSON.stringify({
  catalog,programme:{films:[],runId:'run'},watchlist,index,profile:{version:1},metadata,programmeRunId:'run',pinned:false,now,titleExclusion:{state:'unavailable'}
 })+';'+name+'.freshness={indexed:()=>true};JSON.stringify(catalogAvailable('+name+').films.map(film=>film.id))',catalogCtx));
};
assert.deepEqual(offerRun({alias:offer('tmdb_11','11')},{gone:{...facet,watchlist:false},tmdb_11:facet},{gone:{id:'gone',tmdbId:'11'}}),[],'a lid-only watchlist fact reaches the catalog id through one stored TMDB id');
assert.deepEqual(offerRun({alias:offer('tmdb_11','11')},{gone:{...facet,watchlist:false},tmdb_11:facet},{gone:{id:'gone',tmdbId:'11'}},{films:[{id:'gone',tmdbId:'99'}]}),['tmdb_11'],'two stored TMDB ids do not bridge the fact');
assert.deepEqual(offerRun({alias:offer('tmdb_11','11')},{gone:facet,tmdb_11:facet},{gone:{id:'gone',tmdbId:'11'}}),['tmdb_11'],'a missing watchlist field does not exclude');

const ratedOnly=base();
ratedOnly.archiveAdmissions={tmdb_77:{tmdb:'77',sourceCode:'Zz9',archiveSha256:'ab'.repeat(32),title:'Rated Only',year:1994}};
assert.ok(ids(ratedOnly).includes('tmdb_77'),'a verified rated archive film is in the lifecycle');
const ratedFilm=filmOf(ratedOnly,'tmdb_77');
assert.equal(listedOnWatchlist(ratedOnly,ratedFilm),false,'a rating does not put the film on the watchlist');
assert.equal(ratedFilm.canonicalIdentity,'tmdb:77');
assert.equal(readLifecycle(ratedOnly,NOW).parity.ok,true);
const aired=base();
aired.programme={films:[body('shown',{tmdbId:'77',original:'Rated Only',title:'Rated Only'})],runId:'run-2'};
aired.metadata={...aired.metadata,shown:body('shown',{tmdbId:'77',original:'Rated Only',title:'Rated Only'})};
aired.archiveAdmissions=ratedOnly.archiveAdmissions;
const sameMovie=readLifecycle(aired,NOW).films.filter(item=>(item.externalIds||[]).some(id=>id.scheme==='tmdb'&&id.value==='77'&&id.trusted&&!id.conflicting));
assert.equal(sameMovie.length,1,'an EPG airing of the same movie stays one Film');
assert.equal(readLifecycle(aired,NOW).parity.ok,true);
const flagged=base();
flagged.archiveAdmissions={tmdb_78:{tmdb:'78',watchlist:false,title:'Nope',year:1990}};
assert.equal(ids(flagged).includes('tmdb_78'),false,'a watchlist field on an archive row admits nobody');
assert.equal(ids(base()).includes('tmdb_77'),false,'a missing admissions object admits nobody');
assert.deepEqual(archiveAdmissionsFromDocument(null),{});
assert.deepEqual(archiveAdmissionsFromDocument({schemaVersion:1,films:{tmdb_77:{tmdb:'77',sourceCode:'Zz9',title:'Rated Only',year:1994},tmdb_78:{tmdb:'78',watchlist:true},bad:{tmdb:'1'},tmdb_79:{tmdb:'80'}}}),{tmdb_77:{tmdb:'77',sourceCode:'Zz9',archiveSha256:null,title:'Rated Only',year:1994}});

console.log('Film retention: departed watchlist films stay, re-add keeps one film, Finds skips a watchlist fact, orphan classes do not write, a rated archive film stays without watchlist membership');
