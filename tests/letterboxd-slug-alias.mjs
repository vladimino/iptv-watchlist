// AIR-276: a Letterboxd film slug is kept as a typed `letterboxd_slug` alias of the Film that carries the lid it was
// observed with. Synthetic records only; no real watchlist, diary or production payload.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const domain=fs.readFileSync('src/domain/film-person.js','utf8');
const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const backfill=fs.readFileSync('src/domain/film-person-backfill.js','utf8');
const ctx=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={letterboxdSlugFromUrl,readLifecycle,backfillLifecycle,linkFilms,catalogReady,displayReady,LETTERBOXD_SLUG_SCHEME};',ctx);
const {letterboxdSlugFromUrl,readLifecycle,backfillLifecycle,linkFilms,LETTERBOXD_SLUG_SCHEME}=ctx.api;
const plain=value=>JSON.parse(JSON.stringify(value));
const NOW=Date.parse('2026-10-30T09:00:00.000Z'),LATER=NOW+86400000;
const slugsOf=film=>plain((film?.externalIds||[]).filter(item=>item.scheme===LETTERBOXD_SLUG_SCHEME));
const filmOf=(view,id)=>view.films.find(film=>film.id===id);
const withoutSlugs=film=>plain({...film,externalIds:film.externalIds.filter(item=>item.scheme!==LETTERBOXD_SLUG_SCHEME)});

// 1. The permalink parser: the two film permalink forms, same origin, lowercase; nothing else.
assert.equal(LETTERBOXD_SLUG_SCHEME,'letterboxd_slug');
for(const [url,slug] of [
 ['https://letterboxd.com/film/the-legend-of-zorro/','the-legend-of-zorro'],
 ['https://letterboxd.com/fixture/film/The-Legend-Of-Zorro/','the-legend-of-zorro'],
 ['https://letterboxd.com/film/2001-a-space-odyssey/','2001-a-space-odyssey']
])assert.equal(letterboxdSlugFromUrl(url),slug,url);
for(const url of ['http://letterboxd.com/film/x/','https://evil.example/film/x/','https://letterboxd.com.evil.example/film/x/','https://letterboxd.com/film/x/?a=1','https://letterboxd.com/film/x/#top',
 'https://letterboxd.com/film/x/reviews/','https://letterboxd.com/film/x','https://letterboxd.com/fixture/film/x/2/','https://letterboxd.com/a/b/film/x/','https://boxd.it/28nq','https://letterboxd.com/film//',
 'https://www.themoviedb.org/movie/1656','The Legend of Zorro','28nq',null,undefined,42,'https://user:pw@letterboxd.com/film/x/'])
 assert.equal(letterboxdSlugFromUrl(url),null,String(url));

// A catalog: one watchlist film with a canonical permalink also in the diary under its lid, one with a member
// permalink, one without a URL, one TMDB-only catalog film, and a diary entry without a lid.
const fresh=new Date(NOW-86400000).toISOString();
const store=()=>({
 watchlist:{films:[
  {id:'28nq',title:'The Legend of Zorro',original:'The Legend of Zorro',year:2005,url:'https://letterboxd.com/film/the-legend-of-zorro/'},
  {id:'2b0k',title:'Member Link',original:'Member Link',url:'https://letterboxd.com/fixture/film/member-link/'},
  {id:'nourl',title:'No URL',original:'No URL'},
  {id:'badurl',title:'Bad URL',original:'Bad URL',url:'https://www.themoviedb.org/movie/7'}
 ]},
 programme:null,
 metadata:{},titles:{},people:{},filmTitles:[],personNames:[],personOverrides:{},sync:{failures:[]},
 discoveryResolution:{},
 discoveredFilms:{tmdb_50:{id:'tmdb_50',tmdbId:'50',title:'Catalog Only',original:'Catalog Only',discoveredAt:fresh,synopsis:'Overview',url:'https://letterboxd.com/film/catalog-only/',directors:[],actors:[]}},
 fingerprints:{'28nq':{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:fresh,fingerprintHash:'print-a'}},
 predictions:{'28nq':{current:{tasteProfileVersion:3,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4}}},
 profile:{version:3,profileHash:'profile-a'},
 diaryHistory:{schemaVersion:1,entries:{
  'day:lid:28nq|2026-10-01':{key:'day:lid:28nq|2026-10-01',identity:{type:'letterboxd_lid',value:'28nq'},aliases:[{type:'letterboxd_slug',value:'the-legend-of-zorro'}],firstObservedAt:'2026-10-02T00:00:00.000Z'},
  'day:lid:nourl|2026-09-01':{key:'day:lid:nourl|2026-09-01',identity:{type:'letterboxd_lid',value:'nourl'},aliases:[{type:'letterboxd_slug',value:'no-url-film',firstObservedAt:'2026-09-02T00:00:00.000Z'}],firstObservedAt:'2026-09-02T00:00:00.000Z',observedAt:'2026-10-29T00:00:00.000Z'},
  'day:slug:mystery|2026-08-01':{key:'day:slug:mystery|2026-08-01',identity:null,aliases:[{type:'letterboxd_slug',value:'catalog-only'}],firstObservedAt:'2026-08-02T00:00:00.000Z'}
 }}
});

// 2. Reader: the same film in the watchlist and the diary is one slug, current; a member permalink is the canonical
// slug; a film without a URL takes the diary slug of its lid as observed; no URL and no diary row stays unknown.
const base=store(),view=readLifecycle(base,NOW);
assert.deepEqual(slugsOf(filmOf(view,'film:28nq')),[{scheme:'letterboxd_slug',value:'the-legend-of-zorro',conflicting:false,trusted:false,provenance:{source:'letterboxd_film_url',status:'current',records:['watchlist'],url:'https://letterboxd.com/film/the-legend-of-zorro/',observedAt:new Date(NOW).toISOString()}}]);
assert.deepEqual(slugsOf(filmOf(view,'film:2b0k')).map(item=>[item.value,item.provenance.status,item.provenance.url]),[['member-link','current','https://letterboxd.com/film/member-link/']]);
assert.deepEqual(slugsOf(filmOf(view,'film:nourl')).map(item=>[item.value,item.provenance.source,item.provenance.status,item.provenance.observedAt]),[['no-url-film','letterboxd_diary','observed','2026-09-02T00:00:00.000Z']]);
assert.deepEqual(slugsOf(filmOf(view,'film:badurl')),[],'a URL that is not a Letterboxd permalink yields nothing');
// A TMDB-only Film gets no slug, not even from its own record or a diary row without a lid.
assert.deepEqual(slugsOf(filmOf(view,'film:tmdb:50')),[]);
assert.deepEqual(plain(view.aliasConflicts),[]);

// 2b. A permalink kept only in metadata.json (the cached record of the same lid) is that Film's slug too.
const metaOnly=store();metaOnly.metadata={nourl:{id:'nourl',url:'https://letterboxd.com/film/metadata-only/',metadataAt:fresh}};metaOnly.diaryHistory=null;
const metaView=readLifecycle(metaOnly,NOW),metaFilm=filmOf(metaView,'film:nourl');
assert.deepEqual(slugsOf(metaFilm).map(item=>[item.value,item.provenance.status,plain(item.provenance.records)]),[['metadata-only','current',['metadata']]]);
assert.equal(metaFilm.canonicalIdentity,null,'no identity promotion');
assert.equal(plain(metaFilm.externalIds).filter(item=>item.trusted).map(item=>item.scheme).join(),'letterboxd');
// 2c. Two records of one lid with different permalinks (programme old, watchlist new): both slugs are kept, each with
// its records, as `ambiguous`; neither record is proved fresher.
const split=store();split.diaryHistory=null;
split.programme={films:[{...split.watchlist.films[0],url:'https://letterboxd.com/film/old-slug/'},...split.watchlist.films.slice(1)]};
split.watchlist.films[0].url='https://letterboxd.com/film/new-slug/';
const splitView=readLifecycle(split,NOW);
assert.deepEqual(slugsOf(filmOf(splitView,'film:28nq')).map(item=>[item.value,item.provenance.status,plain(item.provenance.records)]),[['old-slug','ambiguous',['programme']],['new-slug','ambiguous',['watchlist']]]);
assert.deepEqual(plain(splitView.aliasConflicts),[]);
// Replay keeps both; once the records agree on the new slug, it is current and the old one historical.
const splitFirst=backfillLifecycle(split,NOW),splitStored=plain(splitFirst.sidecars);
assert.deepEqual(plain(backfillLifecycle({...split,persistedSidecars:splitStored},LATER).reconciliation.update),[]);
const settled=store();settled.diaryHistory=null;settled.watchlist.films[0].url='https://letterboxd.com/film/new-slug/';
settled.programme={films:[{...settled.watchlist.films[0]},...settled.watchlist.films.slice(1)]};
const settledBody=backfillLifecycle({...settled,persistedSidecars:splitStored},LATER).sidecars['watchlist.lifecycle.json']['28nq'];
assert.deepEqual(plain(settledBody.externalIds.filter(item=>item.scheme==='letterboxd_slug').map(item=>[item.value,item.provenance.status,item.provenance.observedAt])),[['new-slug','current',new Date(NOW).toISOString()],['old-slug','historical',new Date(NOW).toISOString()]]);
// 2d. Diary aliases appended at different reads. An alias stamped by the writer keeps its own time; an older alias
// without one states only the window of its entry's reads, never the entry's first read as an exact time.
const late=store();late.watchlist.films=late.watchlist.films.filter(film=>film.id==='nourl');
late.diaryHistory={schemaVersion:1,entries:{'day:lid:nourl|2026-09-01':{key:'day:lid:nourl|2026-09-01',identity:{type:'letterboxd_lid',value:'nourl'},firstObservedAt:'2026-10-01T00:00:00.000Z',observedAt:'2026-10-30T00:00:00.000Z',
 aliases:[{type:'letterboxd_slug',value:'first-slug'},{type:'letterboxd_slug',value:'later-slug',firstObservedAt:'2026-10-30T00:00:00.000Z'}]}}};
const lateSlugs=slugsOf(filmOf(readLifecycle(late,NOW),'film:nourl'));
assert.deepEqual(lateSlugs.map(item=>[item.value,item.provenance.observedAt,item.provenance.observedBetween??null]),[['first-slug',null,{from:'2026-10-01T00:00:00.000Z',to:'2026-10-30T00:00:00.000Z'}],['later-slug','2026-10-30T00:00:00.000Z',null]]);
// The stored window stays when the entry is read again later; it does not drift with each diary read.
const lateStored=plain(backfillLifecycle(late,NOW).sidecars);
late.diaryHistory.entries['day:lid:nourl|2026-09-01'].observedAt='2026-11-05T00:00:00.000Z';
const lateAgain=backfillLifecycle({...late,persistedSidecars:lateStored},LATER);
assert.deepEqual(plain(lateAgain.reconciliation.update),[]);
assert.deepEqual(plain(lateAgain.sidecars['watchlist.lifecycle.json'].nourl.externalIds.find(item=>item.value==='first-slug').provenance.observedBetween),{from:'2026-10-01T00:00:00.000Z',to:'2026-10-30T00:00:00.000Z'});

// 2e. One slug in two diary entries of one lid. The first sighting lies between the earliest lower bound and the
// earliest upper bound; an exact time only when that window closes. Both insertion orders give the same answer.
const day=n=>'2026-10-'+String(n).padStart(2,'0')+'T00:00:00.000Z';
const twoEntries=(first,second)=>{const store2=store();store2.watchlist.films=store2.watchlist.films.filter(film=>film.id==='nourl');
 store2.diaryHistory={schemaVersion:1,entries:Object.fromEntries([first,second].map((entry,i)=>['e'+i,{key:'e'+i,identity:{type:'letterboxd_lid',value:'nourl'},...entry}]))};
 return slugsOf(filmOf(readLifecycle(store2,NOW),'film:nourl')).map(item=>[item.provenance.observedAt,item.provenance.observedBetween??null]);};
const legacy={firstObservedAt:day(1),observedAt:day(30),aliases:[{type:'letterboxd_slug',value:'same-slug'}]};
const stamped={firstObservedAt:day(20),observedAt:day(30),aliases:[{type:'letterboxd_slug',value:'same-slug',firstObservedAt:day(25)}]};
for(const [a,b] of [[legacy,stamped],[stamped,legacy]])assert.deepEqual(twoEntries(a,b),[[null,{from:day(1),to:day(25)}]],'an uncertain earlier sighting keeps the time uncertain');
const narrow={firstObservedAt:day(5),observedAt:day(20),aliases:[{type:'letterboxd_slug',value:'same-slug'}]};
for(const [a,b] of [[legacy,narrow],[narrow,legacy]])assert.deepEqual(twoEntries(a,b),[[null,{from:day(1),to:day(20)}]],'overlapping windows');
const exactEarly={firstObservedAt:day(10),observedAt:day(30),aliases:[{type:'letterboxd_slug',value:'same-slug',firstObservedAt:day(18)}]};
for(const [a,b] of [[stamped,exactEarly],[exactEarly,stamped]])assert.deepEqual(twoEntries(a,b),[[day(18),null]],'two exact sightings: the earlier');
const unknownStart={observedAt:day(30),aliases:[{type:'letterboxd_slug',value:'same-slug'}]};
assert.deepEqual(twoEntries(unknownStart,stamped),[[null,{from:null,to:day(25)}]],'an unknown lower bound stays unknown');

// 3. The alias changes no identity, readiness, fingerprint, prediction or Film count.
const without=readLifecycle({...store(),watchlist:{films:store().watchlist.films.map(({url,...film})=>film)},diaryHistory:null},NOW);
assert.equal(view.films.length,without.films.length);
assert.deepEqual(view.films.map(film=>film.id),without.films.map(film=>film.id));
for(const film of view.films){
 const other=without.films.find(item=>item.id===film.id);
 assert.deepEqual(withoutSlugs(film),plain(other),film.id);
 assert.equal(ctx.api.catalogReady(film),ctx.api.catalogReady(other));assert.equal(ctx.api.displayReady(film),ctx.api.displayReady(other));
}
assert.equal(filmOf(view,'film:28nq').canonicalIdentity,filmOf(without,'film:28nq').canonicalIdentity);
assert.deepEqual(plain(view.parity),plain(without.parity));

// 4. Collision: two lids observed with the same slug. Both aliases are conflicting, nothing merges, ids stay.
const twin=store();twin.watchlist.films.push({id:'zzzz',title:'Other',original:'Other',url:'https://letterboxd.com/film/the-legend-of-zorro/'});
const collided=readLifecycle(twin,NOW);
assert.deepEqual(plain(collided.aliasConflicts),[{scheme:'letterboxd_slug',value:'the-legend-of-zorro',films:['film:28nq','film:zzzz']}]);
assert.equal(collided.films.length,view.films.length+1);
for(const id of ['film:28nq','film:zzzz'])assert.deepEqual(slugsOf(filmOf(collided,id)).map(item=>[item.conflicting,item.trusted]),[[true,false]],id);
// A slug never links two records on its own.
assert.equal(linkFilms(filmOf(collided,'film:28nq'),filmOf(collided,'film:zzzz'),NOW).ok,false);
const slugOnly={...filmOf(view,'film:nourl'),id:'film:other',externalIds:slugsOf(filmOf(view,'film:28nq'))};
assert.deepEqual(linkFilms({...filmOf(view,'film:nourl'),externalIds:slugsOf(filmOf(view,'film:28nq'))},slugOnly,NOW).reason,'unrelated');

// 5. Backfill: first run creates the alias; a replay with the stored sidecars is unchanged even at a later clock.
const first=backfillLifecycle(store(),NOW);
assert.deepEqual(plain(first.report.aliasConflicts),[]);
const stored=plain(first.sidecars);
const replay=backfillLifecycle({...store(),persistedSidecars:stored},LATER);
assert.deepEqual(plain(replay.reconciliation.update),[],'idempotent replay');
assert.ok(replay.reconciliation.unchanged.includes('watchlist.lifecycle.json'));
assert.deepEqual(plain(replay.reconciliation.conflict),[]);
assert.equal(replay.sidecars['watchlist.lifecycle.json']['28nq'].externalIds.find(item=>item.scheme==='letterboxd_slug').provenance.observedAt,new Date(NOW).toISOString(),'first observation kept');

// 6. Rename: the watchlist now carries a new slug. The new one is current, the stored one stays historical; the
// canonical id, the lid and the Film count do not change.
const renamed=store();renamed.watchlist.films[0].url='https://letterboxd.com/film/the-legend-of-zorro-2005/';renamed.diaryHistory=null;
const after=backfillLifecycle({...renamed,persistedSidecars:stored},LATER);
const body=after.sidecars['watchlist.lifecycle.json']['28nq'];
assert.equal(body.id,'film:28nq');
assert.deepEqual(plain(body.externalIds.map(item=>[item.scheme,item.value,item.provenance?.status??null])),[['letterboxd','28nq',null],['letterboxd_slug','the-legend-of-zorro-2005','current'],['letterboxd_slug','the-legend-of-zorro','historical']]);
assert.equal(Object.keys(after.sidecars['watchlist.lifecycle.json']).length,Object.keys(stored['watchlist.lifecycle.json']).length);
assert.equal(after.sidecars['enrichment/films/28nq/fingerprint.lifecycle.json'].fingerprint.status,stored['enrichment/films/28nq/fingerprint.lifecycle.json'].fingerprint.status);
assert.deepEqual(plain(after.reconciliation.conflict),[]);
// The renamed state replays unchanged as well.
const again=backfillLifecycle({...renamed,persistedSidecars:plain(after.sidecars)},LATER+86400000);
assert.deepEqual(plain(again.reconciliation.update),[]);
// A historical slug taken by another lid is a collision, never a merge.
const reused=store();reused.watchlist.films[0].url='https://letterboxd.com/film/the-legend-of-zorro-2005/';reused.diaryHistory=null;
reused.watchlist.films.push({id:'zzzz',title:'Other',original:'Other',url:'https://letterboxd.com/film/the-legend-of-zorro/'});
const taken=backfillLifecycle({...reused,persistedSidecars:stored},LATER);
assert.deepEqual(plain(taken.report.aliasConflicts),[{scheme:'letterboxd_slug',value:'the-legend-of-zorro',films:['film:28nq','film:zzzz']}]);
assert.equal(taken.sidecars['watchlist.lifecycle.json']['zzzz'].id,'film:zzzz');
assert.equal(taken.sidecars['watchlist.lifecycle.json']['28nq'].id,'film:28nq');

// 7. The predictions and the source records are never touched.
const source=store(),snapshot=JSON.stringify(source);backfillLifecycle(source,NOW);readLifecycle(source,NOW);
assert.equal(JSON.stringify(source),snapshot);


// 8. The offline inventory counts from the records alone and writes nothing.
const {slugInventory}=await import('../scripts/letterboxd-slug-inventory.mjs');
const inventory=await slugInventory(store(),NOW);
assert.deepEqual(plain(inventory.films),{films:5,withLid:4,tmdbOnly:1,withSlug:3,withoutSlug:1,current:2,ambiguous:0,observedOnly:1,historical:0,conflicting:0});
assert.deepEqual(plain(inventory.letterboxdRecords),{records:4,permalink:2,other:1});
assert.deepEqual([inventory.writes,inventory.requests,inventory.collisions,inventory.diaryEntries],[0,0,0,3]);
console.log('Letterboxd slug alias (AIR-276): strict permalink parser, current watchlist slug and observed diary slug by lid, metadata-only permalink, disagreeing records kept as ambiguous then settled with the old slug historical, per-alias diary time or an honest window that does not drift, one slug in two entries merged to the earliest bounds in either order, no slug without a lid or URL, identity, readiness, count and parity unchanged, collision marked and never merged, idempotent replay, rename kept as historical, reused slug a collision, sources untouched, offline inventory from stored records only with no write or request passed');
