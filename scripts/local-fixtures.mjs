import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const catalogPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures/local-site/catalog.json');
const localProfile={version:1,profileHash:'local-fixture'};
// The one provisional title and the one cached person name of the dummy catalog. They are the frozen `titles.json` / `people.json` mirrors in R2 and the
// localization rows of the canonical Film/Person tables in D1 (scripts/local-d1.mjs), so the owner page shows the same provisional queue from the authority.
export const LOCAL_TITLES={'movie-2':{title:'Фильм 2',status:'provisional',sources:['https://www.wikidata.org/wiki/Q2']}};
export const LOCAL_PEOPLE={'actor/actor-2':{name:'Актёр 2',original:'Actor2'}};
export async function loadLocalCatalog(){return JSON.parse(await readFile(catalogPath,'utf8'));}
// The ratings, predictions, fingerprints and started marks of the dummy catalog are D1 rows (scripts/local-d1.mjs); this file builds only the R2 documents.
export function buildLocalFixtures(catalog,now=Date.now()){
 const at=new Date(now).toISOString();
 const filmBody=film=>({id:film.id,...(film.tmdbId?{tmdbId:String(film.tmdbId)}:{}),...(film.tmdbLink?{tmdbLink:film.tmdbLink}:{}),title:film.title,original:film.original,year:film.year,runtime:film.runtime,genres:film.genres,synopsis:film.synopsis,directors:film.directors,actors:film.actors,shows:(film.shows||[]).map(show=>{const start=now+show.offsetHours*3600000;return {start,end:start+show.durationHours*3600000,channel:show.channel,channelId:show.channelId};})});
 const films=catalog.films.map(filmBody);
 const people={directors:[],actors:[]};
 for(const film of films)for(const key of ['directors','actors'])for(const person of film[key]||[])if(!people[key].some(item=>item.id===person.id))people[key].push(person);
 const programme={runId:'local-fixture',updatedAt:at,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:films.length,films,people,stats:{uniqueFilms:films.filter(film=>film.shows.length).length,channels:1}};
 const watchlist={updatedAt:at,films:films.map(({shows,...film})=>film)};
 // The published generation the Worker pins its readers to: the pointer, the generation copy of the programme and an
 // empty generation catalog, plus the two localization dictionaries the owner admin page reads beside the programme.
 const objects=[
  {key:'programme.json',json:programme},
  {key:'epg/published-generation.json',json:{phase:'published',programmeRunId:programme.runId,publishedAt:at}},
  {key:`epg/generations/${programme.runId}/programme.json`,json:programme},
  {key:`epg/generations/${programme.runId}/discovered-films.json`,json:{}},
  {key:'titles.json',json:LOCAL_TITLES},
  {key:'people.json',json:LOCAL_PEOPLE},
  {key:'watchlist.json',json:watchlist},
  {key:'sync.json',json:{runId:'local-fixture',stage:'complete',updatedAt:at}},
  {key:'enrichment/profile/current.json',json:{...localProfile,updatedAt:at}},
  {key:'events/items/local-fixture-epg.json',json:{id:'local-fixture-epg',type:'epg',at,films:programme.stats.uniqueFilms,archive:1,future:2,broadcasts:films.reduce((count,film)=>count+film.shows.length,0)}},
 ];
 const eventItem=(id,ms,json)=>{objects.push({key:'events/items/'+String(9999999999999-ms).padStart(13,'0')+'-'+id+'.json',json:{...json,id,at:new Date(ms).toISOString()}});};
 eventItem('local-fixture-watchlist',now-60000,{type:'watchlist',total:films.length,added:[{id:'movie-2',title:'Movie2',year:2018},{id:'long-title',title:'A Very Long Watchlist Title That Should Wrap Cleanly On A Narrow Phone Screen Without Horizontal Overflow',year:2021}],removed:[{id:'movie-1',title:'Movie1',year:2020,tmdb:'900001',rating:4.5},{id:'movie-3',title:'Movie3',year:2024}]});
 eventItem('local-fixture-started',now-30000,{type:'started',film:{id:'movie-1',title:'Movie1',year:2020,tmdb:'900001'}});
 eventItem('local-fixture-unstarted',now-15000,{type:'unstarted',film:{id:'movie-2',title:'Movie2',year:2018}});
 for(const film of catalog.films.filter(item=>item.started))objects.push({key:`started/${film.id}.json`,json:{id:film.id,started:true,startedAt:at},customMetadata:{started:'true'}});
 return objects;
}
