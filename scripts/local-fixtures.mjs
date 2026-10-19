import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const catalogPath=path.join(path.dirname(fileURLToPath(import.meta.url)),'../fixtures/local-site/catalog.json');
export async function loadLocalCatalog(){return JSON.parse(await readFile(catalogPath,'utf8'));}
export function buildLocalFixtures(catalog,now=Date.now()){
 const at=new Date(now).toISOString();
 const filmBody=film=>({id:film.id,title:film.title,original:film.original,year:film.year,runtime:film.runtime,genres:film.genres,synopsis:film.synopsis,directors:film.directors,actors:film.actors,shows:(film.shows||[]).map(show=>{const start=now+show.offsetHours*3600000;return {start,end:start+show.durationHours*3600000,channel:show.channel,channelId:show.channelId};})});
 const films=catalog.films.map(filmBody);
 const people={directors:[],actors:[]};
 for(const film of films)for(const key of ['directors','actors'])for(const person of film[key]||[])if(!people[key].some(item=>item.id===person.id))people[key].push(person);
 const programme={runId:'local-fixture',updatedAt:at,window:{from:now-72*3600000,to:now+24*3600000},watchlistCount:films.length,films,people,stats:{uniqueFilms:films.filter(film=>film.shows.length).length,channels:1}};
 const watchlist={updatedAt:at,films:films.map(({shows,...film})=>film)};
 const view={films:Object.fromEntries(catalog.films.filter(film=>film.actualRating!==undefined||film.prediction||film.mechanics||film.moods||film.execution).map(film=>[film.id,{actualRating:film.actualRating??null,fingerprint:{plotMechanics:film.mechanics||[],moodIds:film.moods||[],execution:film.execution||{}},prediction:film.prediction?{...film.prediction,stale:false}:null}]))};
 const objects=[{key:'programme.json',json:programme},{key:'watchlist.json',json:watchlist},{key:'sync.json',json:{runId:'local-fixture',stage:'complete',updatedAt:at}},{key:'enrichment/view-index.json',json:view},{key:'events/items/local-fixture-epg.json',json:{id:'local-fixture-epg',type:'epg',at,films:programme.stats.uniqueFilms,archive:1,future:2,broadcasts:films.reduce((count,film)=>count+film.shows.length,0)}}];
 for(const film of catalog.films.filter(item=>item.started))objects.push({key:`started/${film.id}.json`,json:{id:film.id,started:true,startedAt:at},customMetadata:{started:'true'}});
 return objects;
}
