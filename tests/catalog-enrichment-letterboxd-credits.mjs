// AIR-605: the Letterboxd credits of the Catalog Enrichment Producer through the REAL page parser of src/sources.js (not an injected stand-in): every correctly identified credit is kept (no ten-actor cap), a Film of more than
// 200 credits is read in full, a credit without a person profile link is a name-only gap, the legacy display record keeps its ten actors, and an absent or malformed credits section is unreadable, never a complete empty set.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {fetchLetterboxd} from '../src/catalog-enrichment-sources.js';
import {expectedCredits,chunkCredits} from '../src/catalog-enrichment-plan.js';

const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,URL,URLSearchParams,fetch});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\n'+fs.readFileSync('src/domain/film-person.js','utf8').replace(/^export default/m,'globalThis.x=')+'\n'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8').replace(/^export default/m,'globalThis.y=')+'\n'+fs.readFileSync('src/sources.js','utf8')+';globalThis.tools=letterboxdPageTools();',context);
const tools=context.tools;
assert.equal(typeof tools.parseFilm,'function');

const res=(status,body='',headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},text:async()=>body,body:null});
const person=(role,i,linked=true)=>linked?{'@type':'Person',name:role+' '+i,url:`https://letterboxd.com/${role}/${role}-${i}/`,sameAs:`https://letterboxd.com/${role}/${role}-${i}/`}:{'@type':'Person',name:'Unlinked '+i};
function page({actors=[],directors=[person('director',1)],omit=[],malformed=null}={}){
 const ld={'@context':'http://schema.org','@type':'Movie',name:'The Matrix',image:'https://img/p.jpg',duration:'PT2H16M',genre:['Science Fiction'],director:directors,actor:actors,description:'x'};
 for(const key of omit)delete ld[key];
 if(malformed)Object.assign(ld,malformed);
 return `<html><head><link rel="shortlink" href="https://boxd.it/abc"><link rel="canonical" href="https://letterboxd.com/film/the-matrix/"><meta property="og:title" content="The Matrix (1999)"><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body><div data-tmdb-id="603" data-tmdb-type="movie"></div></body></html>`;
}
const upstream=html=>async url=>String(url).startsWith('https://boxd.it/')?res(301,'',{location:'https://letterboxd.com/film/the-matrix/'}):res(200,html);
const fetchFilm=html=>fetchLetterboxd({},{lid:'abc',tmdbAnchor:'603',fetchImpl:upstream(html),tools});

// more than ten actors: all of them
{
 const answer=await fetchFilm(page({actors:Array.from({length:25},(_,i)=>person('actor',i))}));
 assert.equal(answer.status,'ok',JSON.stringify({reason:answer.reason,http:answer.httpStatus}));assert.equal(answer.credits.status,'ok');
 assert.equal(answer.credits.items.filter(item=>item.role==='actor').length,25,'no ten-actor cap in the enrichment path');
 assert.equal(answer.credits.items.filter(item=>item.role==='director').length,1);
 assert.deepEqual(answer.credits.items.filter(item=>item.role==='actor').slice(0,3).map(item=>item.key),['actor-0','actor-1','actor-2'],'person slugs in source order');
}
// more than 200 credits: read in full, paged by construction
{
 const answer=await fetchFilm(page({actors:Array.from({length:230},(_,i)=>person('actor',i)),directors:[person('director',1),person('director',2)]}));
 assert.equal(answer.credits.items.length,232);
 const expected=expectedCredits('letterboxd',answer.credits.items);
 assert.equal(expected.items.length,232);assert.equal(expected.gaps.length,0);
 assert.deepEqual(chunkCredits(expected.items).map(chunk=>chunk.items.length),[50,50,50,50,32],'five chunks of at most 50: the part is paged, not one unbounded document');
}
// a credit without a profile link is name-only: never keyed by its name, never written
{
 const answer=await fetchFilm(page({actors:[person('actor',1),person('actor',2,false),person('actor',3)]}));
 const names=answer.credits.items.filter(item=>item.nameOnly);
 assert.equal(names.length,1);assert.equal(names[0].key,null);
 const expected=expectedCredits('letterboxd',answer.credits.items);
 assert.deepEqual(expected.gaps.map(item=>item.gap),['name_only_credit']);
 assert.equal(expected.items.filter(item=>item.role==='actor').length,2);
}
// an empty but PRESENT section is a complete empty set; absent or malformed sections are unreadable
{
 const empty=await fetchFilm(page({actors:[]}));
 assert.deepEqual([empty.status,empty.credits.status,empty.credits.items.filter(item=>item.role==='actor').length],['ok','ok',0]);
 const none=await fetchFilm(page({omit:['actor','director']}));
 assert.deepEqual([none.status,none.credits.status,none.credits.items.length],['ok','unreadable',0],'both sections absent: not a complete empty set');
 const bad=await fetchFilm(page({malformed:{actor:'Keanu Reeves'}}));
 assert.equal(bad.credits.status,'unreadable','a malformed section is unreadable');
 const oneSide=await fetchFilm(page({omit:['actor']}));
 assert.deepEqual([oneSide.credits.status,oneSide.credits.items.length],['unreadable',0],'an omitted role is not proven to be an absence: incomplete, never a complete set');
 const noDirector=await fetchFilm(page({omit:['director'],actors:[person('actor',1)]}));
 assert.equal(noDirector.credits.status,'unreadable');
 for(const [name,actors] of [['a null entry',[person('actor',1),null]],['an entry without a name',[person('actor',1),{'@type':'Person',url:'https://letterboxd.com/actor/x/'}]],['a blank name',[person('actor',1),{name:'  '}]],['a number',[person('actor',1),7]]]){
  const answer=await fetchFilm(page({actors}));
  assert.equal(answer.credits.status,'unreadable',name+': a malformed entry is never silently filtered into a complete set');
 }
 const single=await fetchFilm(page({actors:person('actor',1)}));
 assert.equal(single.credits.status,'ok','a single object (not a list) is a valid section');
}
// the legacy display record is unchanged: ten actors by default
{
 const html=page({actors:Array.from({length:25},(_,i)=>person('actor',i))});
 assert.equal(tools.parseFilm(html,{}).actors.length,10,'the Watchlist display record keeps its ten actors');
 assert.equal(tools.parseFilm(html,{},{actors:Infinity}).actors.length,25);
 assert.equal(tools.parseFilm(html,{},{actors:3}).actors.length,3);
 assert.equal(tools.parseFilm(html,{}).creditsComplete,true);
 assert.equal(tools.parseFilm(page({omit:['actor']}),{}).creditsComplete,false,'the shared parser flags an omitted role as incomplete');
}
console.log('catalog enrichment letterboxd credits: ok');
