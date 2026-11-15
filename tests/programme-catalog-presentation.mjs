import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';
const ctx=vm.createContext({console,Intl,Date,Set,Map});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/sources.js','utf8'),ctx);
const H=3600000;
const show=(start,channelId='c')=>({channelId,channel:channelId.toUpperCase(),start,end:start+H,epgTitle:null,basis:'discovery',matchReason:'obs'});
const entry=(tmdb,start)=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,shows:[show(start)]});
const record=tmdb=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Film '+tmdb,year:2001,poster:'/p'+tmdb,aliases:['Alias '+tmdb],shows:[show(1)],availableUntil:'old',hotEnteredAt:'x',epgLastAiring:1,showsProgrammeRunId:'old'});
const report={runId:'r',films:[{id:'member',shows:[]}],watchlistCount:1,catalogFilms:[entry(777,2*H),entry(888,5*H),entry(999,4*H)]};
const catalog={tmdb_777:record(777),tmdb_888:{...record(888),canonicalIdentity:'tmdb:1'}};

const plainOf=value=>JSON.parse(JSON.stringify(value));
const ok=plainOf(ctx.presentCatalogFilms(report,catalog));
assert.deepEqual(ok.films,report.films,'the member part is untouched');
assert.deepEqual(ok.catalogFilms.map(film=>film.id),['tmdb_777'],'only a Film with a current catalog record is presented');
const film=ok.catalogFilms[0];
assert.equal(film.title,'Film 777');assert.equal(film.poster,'/p777');assert.deepEqual(film.aliases,['Alias 777']);
assert.deepEqual(film.shows,[show(2*H)],'showings come from the completed read, not from the catalog record');
assert.equal(film.availableUntil,new Date(2*H+72*H).toISOString());
for(const field of ['hotEnteredAt','epgLastAiring','showsProgrammeRunId'])assert.equal(film[field],undefined,field+' is not carried');
assert.equal(film.onWatchlist,false);
assert.deepEqual(ok.catalogPart,{state:'ok',entries:3,presented:1,unpresented:2},'entries without a current record are counted, not shown');

const down=plainOf(ctx.presentCatalogFilms(report,null));
assert.deepEqual(down.films,report.films,'an unreadable catalog never changes the member part');
assert.deepEqual(down.catalogFilms,[]);assert.deepEqual(down.catalogPart,{state:'unavailable',entries:3});

const plain={runId:'r',films:[{id:'m',shows:[]}],catalogFilms:[]};
const none=plainOf(ctx.presentCatalogFilms(plain,null));
assert.equal(none.catalogFilms,undefined);assert.equal(none.catalogPart,undefined,'no catalog entries means no catalog part and no reader call');
console.log('programme catalog presentation ok');
