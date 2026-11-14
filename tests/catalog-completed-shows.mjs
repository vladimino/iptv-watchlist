import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const catalogCtx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),catalogCtx);
for(const file of ['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),catalogCtx);
const now=Date.now(),H=3600000;
const show=(start,channelId='c')=>({channelId,channel:channelId.toUpperCase(),start,end:start+H,epgTitle:null,basis:'discovery',matchReason:'obs'});
const record=(id,tmdbId,extra={})=>({id,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,title:id,original:id,year:2020,runtime:100,genres:[],directors:[],actors:[],...extra});
const facet={prediction:{predictedRating:4,probability4Plus:.5,fingerprintHash:'h'},fingerprint:{fingerprintHash:'h',plotMechanics:[],execution:{}},fingerprintHash:'h'};
vm.runInContext('globalThis.now='+now,catalogCtx);
const run=(expression,input)=>JSON.parse(vm.runInContext('globalThis.input='+JSON.stringify(input)+';input.freshness={indexed:()=>true};JSON.stringify('+expression+')',catalogCtx));

// Finds: a catalog Film whose record carries no showing is offered because the completed programme holds an assigned row of its TMDB id; the run must match.
const input=(programmeRun)=>({
 catalog:{bare:record('bare','21'),stale:record('stale','22',{shows:[show(now,'z')],showsProgrammeRunId:'older'}),none:record('none','23')},
 programme:{runId:programmeRun,films:[],catalogFilms:[{id:'tmdb_21',tmdbId:'21',canonicalIdentity:'tmdb:21',shows:[show(now+H)]},{id:'tmdb_22',tmdbId:'22',canonicalIdentity:'tmdb:22',shows:[show(now+2*H)]}]},
 watchlist:{films:[]},index:{bare:facet,stale:facet,none:facet},profile:{version:1},metadata:{},programmeRunId:'run',pinned:true,now,titleExclusion:{state:'unavailable'}
});
const offered=run('catalogAvailable(input).films.map(film=>[film.id,film.shows.map(item=>item.start)])',input('run'));
assert.deepEqual(offered.map(item=>item[0]).sort(),['bare','stale'],'a Film with an assigned row is offered, a Film without any showing is not');
assert.deepEqual(offered.find(item=>item[0]==='stale')[1],[now+2*H],'a record written by an older run contributes nothing; the completed rows stand');
assert.deepEqual(run('catalogAvailable(input).films.map(film=>film.id)',input('another')),[],'a programme of another run is not mixed in');

// The film page and the programme agree: the same completed rows, merged with the record own shows of the pinned run without duplicates.
const page=run("catalogFilmPage({film:input.catalog.bare,programmeRunId:'run',index:input.index,profile:{version:1},metadata:{},watchlist:input.watchlist,programme:input.programme,freshness:input.freshness,now})",input('run'));
assert.deepEqual(page.shows.map(item=>item.start),[now+H]);
const both=input('run');both.catalog.bare.shows=[show(now+H),show(now+3*H)];both.catalog.bare.showsProgrammeRunId='run';
const merged=run("catalogFilmPage({film:input.catalog.bare,programmeRunId:'run',index:input.index,profile:{version:1},metadata:{},watchlist:input.watchlist,programme:input.programme,freshness:input.freshness,now})",both);
assert.deepEqual(merged.shows.map(item=>item.start),[now+H,now+3*H],'the same showing is not counted twice');
const member=input('run');member.programme.films=[{id:'m',tmdbId:'31',shows:[show(now+5*H)]}];member.catalog.m=record('m','31');
const memberPage=run("catalogFilmPage({film:input.catalog.m,programmeRunId:'run',index:input.index,profile:{version:1},metadata:{},watchlist:input.watchlist,programme:input.programme,freshness:input.freshness,now})",member);
assert.deepEqual(memberPage.shows.map(item=>item.start),[now+5*H],'a member Film page takes the programme showings');
console.log('catalog completed shows ok');
