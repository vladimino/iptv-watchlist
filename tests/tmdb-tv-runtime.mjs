// AIR-297 (ADR 0057): the runtime integration of the TMDB TV identity through the built Worker bundle. parseFilm keeps the typed
// Letterboxd TMDB link through the metadata refresh. AIR-537 slice 3: the ADR 0056 enrichment projector that carried the corrected
// identity to D1 is retired, so its end-to-end scenarios are gone; the identity itself is covered by the domain tests. Synthetic
// records and a memory bucket only: no network, no R2, no production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import {MemoryBucket} from './memory-bucket.mjs';
import {CONFIRMED_RETIREMENTS,RETIREMENTS_KEY} from '../scripts/tmdb-tv-identity-plan.mjs';

assert.equal(spawnSync(process.execPath,['build.mjs'],{stdio:'ignore'}).status,0);
const logs=[],pages=new Map();
let fetched=[];
const context=vm.createContext({
 console:{log:line=>{try{logs.push(JSON.parse(line));}catch{logs.push(line);}},warn(){},error(){}},
 Response,Request,Headers,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,structuredClone,setTimeout,clearTimeout,atob,btoa,
 fetch:async url=>{
  const href=String(url);fetched.push(href);
  if(pages.has(href))return new Response(pages.get(href),{status:200});
  if(href.startsWith('https://letterboxd.com/'))return new Response('',{status:404});
  return new Response(JSON.stringify({results:{bindings:[]}}),{status:200,headers:{'content-type':'application/json'}});
 }
});
vm.runInContext(fs.readFileSync('dist/server/index.js','utf8').replace(/export \{[^}]+\};/g,'').replace(/^export default \{/m,'globalThis.worker={').replace(/^export const /gm,'const ')+'\nglobalThis.api={parseFilm,metadataSync,TMDB_RETIREMENTS_KEY};',context);
const api=context.api;
assert.equal(api.TMDB_RETIREMENTS_KEY,RETIREMENTS_KEY);
const plain=value=>JSON.parse(JSON.stringify(value));
const NOW=Date.now(),OLD='2020-01-01T00:00:00.000Z',T='2026-10-30T00:00:00.000Z';

// Movie-only consumers read the records' tmdbId, which keeps the movie number Letterboxd shows; none of them learns tmdb_tv.
for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/worker.js','src/letterboxd-facts.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/tmdb_tv|TMDB_TV_SCHEME/,file);
// The person identity read selects the tmdb and tmdb_tv rows the projector already stored and passes them to the pure
// projection. It does not parse a page, apply the retirements object, or import the TV identity module.
const catalogD1=fs.readFileSync('src/catalog-d1.js','utf8');
assert.match(catalogD1,/scheme in \('tmdb','tmdb_tv'\)/);
assert.doesNotMatch(catalogD1,/TMDB_TV_SCHEME|tmdb-retirements|tmdb-tv-identity/);

// 1. parseFilm keeps the typed link beside the unchanged attribute number; a record written before carries no field.
const SERIES=CONFIRMED_RETIREMENTS.map(item=>({...item,slug:new URL(item.letterboxdUrl).pathname.split('/')[2]}));
const credit=(role,key)=>({id:role+'/'+key,name:key,original:key});
const page=({name,tmdbType='movie',tmdbId,links,director,actor,attributes=`data-tmdb-type="${tmdbType}" data-tmdb-id="${tmdbId}"`,extra=''})=>`<html><head><meta name="description" content="Synopsis of ${name}.">
<script type="application/ld+json">/* <![CDATA[ */${JSON.stringify({name,director:[{name:director,sameAs:'/director/'+director+'/'}],actor:[{name:actor,sameAs:'/actor/'+actor+'/'}],genre:['Drama'],duration:'PT5H0M'})}/* ]]> */</script></head>
<body class="film" ${attributes}>${links.map(link=>`<a href="https://www.themoviedb.org/${link}/" class="micro-button track-event">TMDB</a>`).join('')}${extra}</body></html>`;
const seriesPage=(item,patch={})=>page({name:'Series '+item.lid,tmdbId:item.movieId,links:['tv/'+item.tvId],director:'d-'+item.lid.toLowerCase(),actor:'a-'+item.lid.toLowerCase(),...patch});
{
 const parsed=api.parseFilm(seriesPage(SERIES[0]),{id:'1IUo',title:'Series 1IUo',url:SERIES[0].letterboxdUrl});
 assert.equal(parsed.tmdbId,'17266','the attribute number is still the record tmdbId');
 assert.deepEqual(plain(parsed.tmdbLink),{status:'review',reason:'link_disagrees_with_attributes',link:{type:'tv',id:'9687'},links:[{type:'tv',id:'9687'}],attributes:{types:['movie'],ids:['17266']}});
 assert.equal(api.parseFilm(page({name:'Heat',tmdbId:'949',links:['movie/949'],director:'michael-mann',actor:'al-pacino'}),{id:'heat'}).tmdbLink.status,'resolved');
}

// The R2 records as the Worker keeps them. The four miniseries and Heat are on the watchlist; movie 9687 is an unrelated
// catalog Film whose number equals the TV id of film:1IUo. The records start without tmdbLink, as written before AIR-297.
const seriesRecord=item=>({id:item.lid,title:'Series '+item.lid,original:'Series '+item.lid,year:1990,tmdbId:item.movieId,url:item.letterboxdUrl,directors:[credit('director','d-'+item.lid.toLowerCase())],actors:[credit('actor','a-'+item.lid.toLowerCase())],peopleVersion:1,peopleNamesVersion:2,metadataAt:OLD,synopsis:'Synopsis',synopsisFetchedAt:OLD,runtime:300});
const HEAT={id:'heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',url:'https://letterboxd.com/film/heat/',directors:[credit('director','michael-mann')],actors:[credit('actor','al-pacino')],peopleVersion:1,peopleNamesVersion:2,metadataAt:OLD,synopsis:'Synopsis',synopsisFetchedAt:OLD,runtime:170};
const MOVIE_9687={id:'tmdb_9687',tmdbId:'9687',title:'Movie 9687',original:'Movie 9687',year:2001,discoveredAt:T,synopsis:'Overview',directors:[credit('tmdb_director','77')],actors:[credit('tmdb_actor','78')]};
function store(bucket,films,{catalog={tmdb_9687:MOVIE_9687},resolution={c9687:{status:'verified',tmdbId:'9687',filmId:'tmdb_9687'}}}={}){
 const put=(key,value)=>bucket.objects.set(key,{text:JSON.stringify(value),customMetadata:{}});
 put('watchlist.json',{updatedAt:T,films});
 put('epg/generations/run-1/programme.json',{updatedAt:T,runId:'run-1',films:films.map(film=>({...film,shows:[]}))});
 put('metadata.json',Object.fromEntries(films.map(film=>[film.id,film])));
 put('titles.json',{});put('people.json',{});
 put('epg/discovery-resolution.json',resolution);
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/discovered-films.json',catalog);
 bucket.objects.delete('sync.json');
 return bucket;
}
const records=()=>[...SERIES.map(seriesRecord),HEAT];
const bucket=store(new MemoryBucket(),records());
// 3. The metadata refresh re-parses the stale pages: the typed link reaches metadata.json, the run's watchlist and so the
// watchlist and programme records; the Film change keys do not move for it, so an inert deploy writes nothing for the field.
async function refresh(pagesFor){
 pages.clear();for(const item of SERIES)pages.set(item.letterboxdUrl,pagesFor(item));
 pages.set(HEAT.url,page({name:'Heat',tmdbId:'949',links:['movie/949'],director:'michael-mann',actor:'al-pacino'}));
 const watchlist=JSON.parse(bucket.objects.get('watchlist.json').text).films.map(film=>({...film,metadataAt:OLD}));
 const syncRun={runId:'sync-1',watchlist,pending:watchlist.map(film=>film.id),cursor:0,remaining:watchlist.length,failures:[],events:[]};
 fetched=[];
 const step=await api.metadataSync({BUCKET:bucket,METADATA_CACHE_DB_OPTIONAL:'standin',FILM_PERSON_DB_OPTIONAL:'standin'},syncRun); // ADR 0162: no D1 binding here, so the explicit local metadata-cache stand-in
 assert.equal(step.failedMetadata,0);
 assert.ok(fetched.every(href=>href.startsWith('https://letterboxd.com/')||!href.includes('themoviedb')),'no TMDB request');
 // finishSync writes the run's films to watchlist.json without their shows; the EPG commit carries them into the programme.
 const films=syncRun.watchlist.map(({shows,...film})=>film);
 const put=(key,value)=>bucket.objects.set(key,{text:JSON.stringify(value),customMetadata:{}});
 put('watchlist.json',{updatedAt:new Date().toISOString(),films});
 put('epg/generations/run-1/programme.json',{updatedAt:new Date().toISOString(),runId:'run-1',films:films.map(film=>({...film,shows:[]}))});
 return {syncRun,films};
}
{
 const {syncRun}=await refresh(item=>seriesPage(item));
 const metadata=JSON.parse(bucket.objects.get('metadata.json').text);
 for(const item of SERIES){
  assert.deepEqual(plain(metadata[item.lid].tmdbLink.links),[{type:'tv',id:item.tvId}]);assert.equal(metadata[item.lid].tmdbId,item.movieId);
  assert.deepEqual(plain(syncRun.watchlist.find(film=>film.id===item.lid).tmdbLink.attributes.ids),[item.movieId]);
 }
 assert.ok(JSON.parse(bucket.objects.get('epg/generations/run-1/programme.json').text).films.every(film=>film.tmdbLink));
}


console.log('tmdb-tv-runtime: ok');
