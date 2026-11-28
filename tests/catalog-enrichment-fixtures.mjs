// Injected Letterboxd, TMDB and Wikidata responses for the Catalog Enrichment producer tests (AIR-605), shared by tests/catalog-enrichment-producer.mjs and the checkpoint A
// compatibility proof of the D1 migration window (AIR-603). Synthetic ids and pages only; no network.
// ---- injected pages and responses ----
export const res=(status,body='',headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},text:async()=>body,body:null});
export const attr=(tag,name)=>new RegExp(name+'="([^"]*)"').exec(tag)?.[1]??'';
export const extractYear=text=>/\((\d{4})\)/.exec(String(text))?.[1]?Number(/\((\d{4})\)/.exec(String(text))[1]):null;
export const parseFilm=html=>{const ld=/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);if(!ld)throw new Error('Film metadata missing');const meta=JSON.parse(ld[1]);const person=(list,role)=>(list||[]).map(item=>{const slug=/\/(?:actor|director)\/([a-z0-9-]+)\//.exec(item.url||'')?.[1];return {id:role+'/'+(slug||item.name),original:item.name,name:item.name};});return {creditsComplete:true,original:meta.name,aliases:[meta.name],tmdbId:/data-tmdb-id="(\d+)"/.exec(html)?.[1]||null,year:meta.year??null,runtime:meta.runtime??null,synopsis:meta.description??null,poster:meta.image??null,genres:meta.genre||[],directors:person(meta.director,'director'),actors:person(meta.actor,'actor')};};
export const tools={parseFilm,attr,extractYear};
export const lbPage=({tmdb=['603'],actors=[{name:'Neo',url:'/actor/neo/'},{name:'Trinity',url:'/actor/trinity/'}],year=1999,runtime=136,synopsis='lb synopsis'}={})=>`<html><head><link rel="shortlink" href="https://boxd.it/abc"><link rel="canonical" href="https://letterboxd.com/film/the-matrix/"><meta property="og:title" content="The Matrix (1999)"><script type="application/ld+json">${JSON.stringify({name:'The Matrix',year,runtime,description:synopsis,image:'https://img/lb.jpg',genre:['Sci-Fi'],director:[{name:'Lana',url:'/director/lana/'}],actor:actors})}</script></head><body>${tmdb.map(id=>`<div data-tmdb-id="${id}" data-tmdb-type="movie"></div>`).join('')}</body></html>`;
export const movie=(over={})=>({id:603,release_date:'1999-03-30',runtime:136,overview:'top-level overview (never proof of a language)',poster_path:'/p.jpg',genres:[{id:28,name:'боевик'}],credits:{cast:[{id:11,name:'T Neo',order:0}],crew:[{id:12,name:'T Lana',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Матрица',overview:'tm synopsis'}},{iso_639_1:'en',iso_3166_1:'US',data:{title:'The Matrix',overview:'english synopsis'}}]},images:{posters:[{iso_639_1:'en',file_path:'/en.jpg',width:900},{iso_639_1:'ru',file_path:'/ru.jpg',width:600}]},...over});
// wd: a list of Russian labels, or 'forbidden' (HTTP 403, AIR-696)
export function upstream({lb='page',tm=movie(),wd=[]}={}){
 const calls=[];
 const impl=async url=>{
  url=String(url);calls.push(url);
  if(url.startsWith('https://boxd.it/')){if(lb==='transport')return res(503);if(lb==='404')return res(404);return res(301,'',{location:'https://letterboxd.com/film/the-matrix/'});}
  if(url.startsWith('https://letterboxd.com/film/'))return res(200,typeof lb==='string'&&lb!=='page'?lb:lbPage());
  if(url.startsWith('https://api.themoviedb.org/'))return tm instanceof Error?(()=>{throw tm;})():tm==='transport'?res(503):res(200,JSON.stringify(tm));
  if(url.startsWith('https://query.wikidata.org/')){if(wd==='forbidden')return res(403,'Forbidden');}
  if(url.startsWith('https://query.wikidata.org/'))return res(200,JSON.stringify({results:{bindings:wd.map(value=>({label:{value}}))}}));
  throw new Error('unexpected '+url);
 };
 impl.calls=calls;
 return impl;
}
