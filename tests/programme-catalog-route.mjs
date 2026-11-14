import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map();
const env={BUCKET:{
 async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value){records.set(key,JSON.parse(value));return {etag:'test'};},
 async list(){return {objects:[],truncated:false};}
}};
let now=Date.parse('2026-11-10T17:40:00Z');
class Clock extends Date{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js']){
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
}

const SCAN='2026-11-10T16:00:00.000Z';
const DONE='2026-11-10T17:36:16.213Z';
const START='2026-11-10T16:00:00.000Z';
const RUN='6d9e3c36-bba2-4e4a-a92d-b2984abdc810';
const film=(id,tmdbId)=>({id,tmdbId:String(tmdbId),title:id,original:id,year:2020,genres:[],actors:[],directors:[],shows:[{start:now}]});
function seed(){
 records.clear();
 records.set('programme.json',{runId:RUN,updatedAt:SCAN,watchlistUpdatedAt:START,watchlistCount:1,films:[film('watch-a',1)],stats:{epgStart:now-72*3600000,epgEnd:now+24*3600000,channels:1,scanned:1,uniqueFilms:1,titleMissing:0,titleProvisional:0,metadataMissing:0}});
 records.set('watchlist.json',{updatedAt:SCAN,films:[film('watch-a',1)]});
 records.set('titles.json',{});
 records.set('sync.json',{runId:RUN,stage:'complete',startedAt:START,updatedAt:DONE,completedAt:DONE});
}
async function programme(){
 const response=await context.worker.fetch(new Request('https://site.example/api/programme'),env);
 assert.equal(response.status,200);
 return response.json();
}
const entry=(tmdb,start)=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,shows:[{channelId:'c',channel:'C',start,end:start+3600000,epgTitle:null,basis:'discovery',matchReason:'obs'}]});
const catalogRecord=tmdb=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Catalog '+tmdb,original:'Catalog '+tmdb,year:2001,genres:[],actors:[],directors:[],aliases:[]});
seed();
records.get('programme.json').catalogFilms=[entry(777,now),entry(888,now)];
records.set('epg/generations/'+RUN+'/discovered-films.json',{tmdb_777:catalogRecord(777)});
const withCatalog=await programme();
assert.deepEqual(withCatalog.films.map(item=>item.id),['watch-a'],'the member part is unchanged');
assert.deepEqual(withCatalog.catalogFilms.map(item=>item.title),['Catalog 777']);
assert.equal(withCatalog.catalogFilms[0].shows.length,1);
assert.deepEqual(withCatalog.catalogPart,{state:'ok',entries:2,presented:1,unpresented:1});
records.delete('epg/generations/'+RUN+'/discovered-films.json');
const without=await programme();
assert.deepEqual(without.films.map(item=>item.id),['watch-a'],'an unreadable catalog never empties the member part');
assert.deepEqual(without.catalogFilms,[]);assert.deepEqual(without.catalogPart,{state:'unavailable',entries:2});
seed();
const plain=await programme();
assert.equal(plain.catalogPart,undefined);assert.equal(plain.catalogFilms,undefined);
console.log('programme catalog route presentation ok');
