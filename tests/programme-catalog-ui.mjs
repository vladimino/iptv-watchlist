// AIR-480: programme screen lists presented catalogFilms without treating them as watchlist members.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped as scopedAvailability} from '../scripts/bundle-scope.mjs';

const AVAILABILITY_LIB=scopedAvailability('src/domain/film-availability.js','FilmAvailability')+'\n';
const nodes=new Map();
function el(selector){
 if(!nodes.has(selector))nodes.set(selector,{selector,innerHTML:'',textContent:'',hidden:false,value:'',checked:false,disabled:false,scrollTop:0,dataset:{},style:{},classList:{toggle(){},add(){},remove(){}},setAttribute(){},getAttribute(){return null;},removeAttribute(){},addEventListener(){},removeEventListener(){},focus(){},scrollIntoView(){},closest(){return null;},contains(){return false;},querySelector(){return null;},querySelectorAll(){return [];}});
 return nodes.get(selector);
}
const document={
 hidden:false,
 addEventListener(){},
 removeEventListener(){},
 querySelector(selector){return el(selector);},
 querySelectorAll(){return [];},
};
const window={
 scrollY:0,
 scrollTo(){},
 addEventListener(){},
 removeEventListener(){},
 location:{href:'https://iptv.example/'},
 history:{state:null,replaceState(){}},
};
const context=vm.createContext({
 Date,Intl,URL,Set,Map,Promise,console,document,window,
 setInterval(){return 1;},
 clearInterval(){},
 fetch(){return Promise.resolve({ok:true,status:200,json:async()=>({})});},
});
vm.runInContext(AVAILABILITY_LIB+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
run('viewClock=Date.parse("2026-11-15T12:00:00Z")');
const start=Date.parse('2026-11-15T18:00:00Z');
run(`installProgramme({
 updatedAt:"2026-11-15T10:00:00.000Z",
 window:{from:Date.parse("2026-11-12T12:00:00Z"),to:Date.parse("2026-11-16T12:00:00Z")},
 films:[{id:"watch-a",tmdbId:"1",title:"Watch",original:"Watch",year:1995,genres:["Драма"],shows:[{channel:"C",channelId:"c",start:${start},end:${start}+3600000}]}],
 catalogFilms:[{id:"tmdb_900",tmdbId:"900",canonicalIdentity:"tmdb:900",title:"Catalog",original:"Catalog",year:2001,genres:["Криминал"],onWatchlist:false,shows:[{channel:"C",channelId:"c",start:${start},end:${start}+3600000}]}],
 people:{directors:[],actors:[]}
})`);
assert.equal(run('films.length'),2);
assert.equal(run('films[0].id'),'watch-a');
assert.equal(run('films[0].catalogOnly'),false);
assert.equal(run('films[1].id'),'tmdb_900');
assert.equal(run('films[1].catalogOnly'),true);
assert.equal(run('films[1].onWatchlist'),false);
assert.equal(JSON.stringify(run('[...watchlistIdentities().ids]')),JSON.stringify(['watch-a']));
assert.equal(run('watchlistIdentities().tmdb.has("900")'),false);
assert.equal(run('watchlistIdentities().tmdb.has("1")'),true);
const html=run('card(films[1])');
assert.match(html,/is-catalog/);
assert.match(html,/finds-badge/);
assert.match(html,/tmdb_900/);
assert.equal(html.includes('data-started-id'),false,'catalogOnly cards have no started action');
assert.equal(run('card(films[0])').includes('is-catalog'),false);
assert.equal(run('card(films[0]).includes("data-started-id")'),true);
run('fillFilmPage(films[1])');
assert.equal(el('#film-screen-actions').innerHTML.includes('data-started-id'),false,'catalogOnly film page has no started action');
run('state.period="soon";render()');
assert.equal(el('#watchlist-title').hidden,false);
assert.equal(el('#watchlist-title').textContent,'Из программы');
assert.equal(run('visibleFilms().some(film=>film.catalogOnly)'),true);
assert.equal(run('visibleFilms().some(film=>!film.catalogOnly)'),true);
run(`installProgramme({
 updatedAt:"2026-11-15T11:00:00.000Z",
 window:{from:Date.parse("2026-11-12T12:00:00Z"),to:Date.parse("2026-11-16T12:00:00Z")},
 films:[{id:"watch-a",tmdbId:"1",title:"Watch",original:"Watch",year:1995,genres:["Драма"],shows:[]}],
 catalogFilms:[],
 catalogPart:{state:"unavailable",entries:2},
 people:{directors:[],actors:[]}
})`);
assert.equal(run('films.length'),1);
assert.equal(run('films[0].id'),'watch-a');
run('state.period="soon";render()');
assert.equal(el('#watchlist-title').textContent,'Из watchlist');
console.log('programme catalog UI: catalogFilms in grid, not watchlist identities');
