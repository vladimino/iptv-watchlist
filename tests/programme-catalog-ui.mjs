// AIR-480: programme grid stays watchlist members; catalogFilms stay on the payload.
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
 input:null,
 setInterval(){return 1;},
 clearInterval(){},
 fetch(){return Promise.resolve({ok:true,status:200,json:async()=>({})});},
});
vm.runInContext(AVAILABILITY_LIB+fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),context);
const run=(code,input)=>{if(input!==undefined)context.input=input;return vm.runInContext(code,context);};
run('viewClock=Date.parse("2026-11-15T12:00:00Z")');
const start=Date.parse('2026-11-15T18:00:00Z');
const windowSpec={from:Date.parse('2026-11-12T12:00:00Z'),to:Date.parse('2026-11-16T12:00:00Z')};
const member={id:'watch-a',tmdbId:'1',title:'Watch',original:'Watch',year:1995,genres:['Драма'],shows:[{channel:'C',channelId:'c',start,end:start+3600000}]};
const catalog={id:'tmdb_900',tmdbId:'900',canonicalIdentity:'tmdb:900',title:'Catalog',original:'Catalog',year:2001,genres:['Криминал'],onWatchlist:false,shows:[{channel:'C',channelId:'c',start,end:start+3600000}]};
run(`installProgramme(${JSON.stringify({
 updatedAt:'2026-11-15T10:00:00.000Z',
 window:windowSpec,
 films:[member],
 catalogFilms:[catalog],
 people:{directors:[],actors:[]},
})})`);
assert.equal(run('films.length'),1);
assert.equal(run('films[0].id'),'watch-a');
assert.equal(run('films[0].catalogOnly'),false);
assert.equal(run('report.catalogFilms.length'),1);
assert.equal(run('report.catalogFilms[0].id'),'tmdb_900');
assert.equal(JSON.stringify(run('[...watchlistIdentities().ids]')),JSON.stringify(['watch-a']));
assert.equal(run('watchlistIdentities().tmdb.has("900")'),false);
assert.equal(run('watchlistIdentities().tmdb.has("1")'),true);
assert.equal(run('card(films[0])').includes('is-catalog'),false);
assert.equal(run('card(films[0]).includes("data-started-id")'),true);
run('state.period="soon";render()');
assert.equal(el('#watchlist-title').textContent,'Из watchlist');
assert.equal(run('visibleFilms().some(film=>film.catalogOnly)'),false);
assert.equal((el('#movies').innerHTML.match(/class="movie-card/g)||[]).length,1);
assert.equal(el('#movies').innerHTML.includes('tmdb_900'),false);

run(`installProgramme(${JSON.stringify({
 updatedAt:'2026-11-15T11:00:00.000Z',
 window:windowSpec,
 films:[{...member,shows:[]}],
 catalogFilms:[],
 catalogPart:{state:'unavailable',entries:2},
 people:{directors:[],actors:[]},
})})`);
assert.equal(run('films.length'),1);
assert.equal(run('films[0].id'),'watch-a');
run('state.period="soon";render()');
assert.equal(el('#watchlist-title').textContent,'Из watchlist');
assert.equal(run('visibleFilms().length'),0,'members with no shows stay members-only, not replaced by catalog');

run(`installProgramme(${JSON.stringify({
 updatedAt:'2026-11-15T12:00:00.000Z',
 window:windowSpec,
 films:[member],
 catalogFilms:[catalog,{id:'tmdb_901',tmdbId:'901',title:'Later',original:'Later',year:2002,genres:['Драма'],onWatchlist:false,shows:[{channel:'C',channelId:'c',start,end:start+3600000}]}],
 catalogPart:{state:'ok',entries:2,presented:2,unpresented:0},
 people:{directors:[],actors:[]},
})})`);
assert.equal(run('films.length'),1,'restored catalogFilms do not inflate the grid');
assert.equal(run('report.catalogFilms.length'),2);
run('state.period="soon";render()');
assert.equal((el('#movies').innerHTML.match(/class="movie-card/g)||[]).length,1);
assert.equal(el('#movies').innerHTML.includes('tmdb_901'),false);

const rated={id:'tmdb_1275779',tmdbId:'1275779',catalogOnly:true,title:'Disclosure Day',original:'Disclosure Day',year:2026,genres:['Фантастика'],shows:[]};
run('enrichment={films:{}}');
assert.match(run('catalogBadge(input)',rated),/finds-badge/);
run('enrichment={films:{tmdb_1275779:{actualRating:4.5,prediction:{predictedRating:3.5,probability4Plus:0.5}}}}');
assert.equal(run('catalogBadge(input)',rated),'');
assert.equal(run('card(input)',rated).includes('finds-badge'),false);
assert.match(run('card(input)',rated),/МОЯ ОЦЕНКА/);
run('enrichment={films:{tmdb_1275779:{watched:true}}}');
assert.equal(run('catalogBadge(input)',rated),'');
const find={id:'tmdb_1275779',tmdbId:'1275779',title:'Disclosure Day',original:'Disclosure Day',year:2026,genres:['Фантастика'],prediction:{predictedRating:3.5,probability4Plus:0.5,confidence:'medium',matchSignals:[]},shows:[{channel:'C',channelId:'c',start,end:start+3600000}]};
run('enrichment={films:{}}');
assert.match(run('findsCard(input)',find),/finds-badge/);
run('enrichment={films:{tmdb_1275779:{actualRating:4.5,prediction:{predictedRating:3.5,probability4Plus:0.5}}}}');
assert.doesNotMatch(run('findsCard(input)',find),/finds-badge/);

const manyMembers=Array.from({length:250},(_,i)=>({
 id:'w'+i,tmdbId:String(i+1),title:'Watch '+i,original:'Watch '+i,year:1995,genres:['Драма'],
 shows:[{channel:'C',channelId:'c',start,end:start+3600000}],
}));
const manyCatalog=Array.from({length:3000},(_,i)=>({
 id:'tmdb_'+(10000+i),tmdbId:String(10000+i),title:'Catalog '+i,original:'Catalog '+i,year:2001,genres:['Криминал'],onWatchlist:false,
 shows:[{channel:'C',channelId:'c',start,end:start+3600000}],
}));
run(`installProgramme(${JSON.stringify({
 updatedAt:'2026-11-15T13:00:00.000Z',
 window:windowSpec,
 films:manyMembers,
 catalogFilms:manyCatalog,
 catalogPart:{state:'ok',entries:3000,presented:3000,unpresented:0},
 people:{directors:[],actors:[]},
})})`);
assert.equal(run('films.length'),250);
assert.equal(run('report.catalogFilms.length'),3000);
const t0=Date.now();
run('state.period="all";render()');
const elapsed=Date.now()-t0;
assert.equal((el('#movies').innerHTML.match(/class="movie-card/g)||[]).length,250);
assert.equal(el('#movies').innerHTML.includes('tmdb_10000'),false);
assert.ok(elapsed<2000,'member-only grid render stays bounded: '+elapsed+'ms');
console.log('programme catalog UI: members-only grid, catalogFilms on payload, NEW skipped for rated');
