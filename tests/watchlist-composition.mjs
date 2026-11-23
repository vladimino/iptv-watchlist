// ADR 0186 decision 6 and owner decision O3 (AIR-569): the pure read-time composition of the Watchlist document. Contract cases: T5 (immediate join only with a trusted identity and a stored
// confirmed show row), T6 (1-for-1 membership), T28 (a removal is membership-only), trusted TMDB collisions, and that no stored slot is never turned into an empty-availability fact.
import assert from 'node:assert/strict';
import {composeWatchlist} from '../src/domain/watchlist-composition.js';
import {validWatchlist} from '../src/mirror-read.js';

const member=(i,extra={})=>({lid:'lb'+i,title:'Film '+i,year:2000+i,url:'https://letterboxd.com/film/f'+i+'/',...extra});
const snapshot=(films,extra={})=>({version:7,snapshotId:'snap-7',lastSuccessAt:'2026-11-21T10:00:00.000Z',stale:false,films,...extra});
const show=(start,extra={})=>({channel:'Ch',start,end:start+7200000,...extra});
const stored=(i,extra={})=>({id:'lb'+i,title:'Film '+i,tmdbId:1000+i,shows:[show(1000*i)],...extra});
const generation=(ids,extra={})=>({watchlist:{updatedAt:'2026-11-21T05:00:00.000Z',films:ids.map(i=>stored(i))},programme:{films:ids.map(i=>stored(i)),catalogFilms:[],...extra}});

// 1. the same members in the snapshot order: stored records (with their shows) are kept, the order is the snapshot's
{
 const out=composeWatchlist({snapshot:snapshot([member(2),member(1),member(3)]),generation:generation([1,2,3])});
 assert.deepEqual(out.doc.films.map(film=>film.id),['lb2','lb1','lb3']);
 assert.deepEqual(out.doc.films.map(film=>film.shows.length),[1,1,1]);
 assert.deepEqual(out.doc.snapshot,{version:7,snapshotId:'snap-7',lastSuccessAt:'2026-11-21T10:00:00.000Z',stale:false});
 assert.deepEqual(out.doc.removed,[]);assert.deepEqual([out.joined,out.unknown],[[],[]]);
 assert.equal(out.doc.updatedAt,'2026-11-21T05:00:00.000Z','the generation clock is the generation\'s: composition invents no time');
 assert.equal(validWatchlist(out.doc),true,'the composed document is a valid Watchlist document for the readers');
}

// 2. T6: 1-for-1 replacement. The length is equal, the membership is not.
{
 const out=composeWatchlist({snapshot:snapshot([member(1),member(9),member(3)]),generation:generation([1,2,3])});
 assert.equal(out.doc.films.length,3);
 assert.deepEqual(out.doc.films.map(film=>film.id),['lb1','lb9','lb3']);
 assert.deepEqual(out.doc.removed.map(film=>film.id),['lb2']);
}

// 3. T5: a new film joins with its shows IMMEDIATELY only when trusted AND a stored confirmed show row exists
{
 const gen=generation([1],{catalogFilms:[{id:'tmdb_555',tmdbId:555,shows:[show(5000)]},{id:'tmdb_556',tmdbId:556,shows:[]}]});
 const members=[member(1),member(5),member(6),member(7),member(8)];
 const out=composeWatchlist({snapshot:snapshot(members),generation:gen,identityByLid:{lb5:555,lb6:556,lb7:null}});
 const byId=Object.fromEntries(out.doc.films.map(film=>[film.id,film]));
 assert.equal(byId.lb5.shows.length,1,'trusted identity with a stored confirmed show row: visible with its shows now');
 assert.equal(byId.lb5.tmdbId,555);assert.equal(byId.lb5.scheduleKnown,undefined);
 assert.deepEqual(byId.lb6.shows,[],'trusted identity but no stored slot: visible without shows');
 assert.equal(byId.lb6.scheduleKnown,false,'an unknown schedule, not an empty-availability fact');
 assert.equal('availableUntil' in byId.lb6,false,'no availability is invented for a film that was never scanned');
 assert.deepEqual(byId.lb7.shows,[],'an untrusted identity never joins');
 assert.deepEqual(byId.lb8.shows,[]);
 assert.deepEqual(out.joined,['lb5']);assert.deepEqual(out.unknown.sort(),['lb6','lb7','lb8']);
 assert.equal(byId.lb1.shows.length,1,'a stored film is untouched');
 // the stored show rows are copies: a later mutation by a reader cannot reach the generation
 byId.lb5.shows[0].channel='X';assert.equal(gen.programme.catalogFilms[0].shows[0].channel,'Ch');
 // an unconfirmed show (no usable start or end) is not a stored confirmed slot
 const bad=composeWatchlist({snapshot:snapshot([member(5)]),generation:generation([],{catalogFilms:[{id:'c',tmdbId:555,shows:[{channel:'Ch'}]}]}),identityByLid:{lb5:555}});
 assert.deepEqual(bad.doc.films[0].shows,[]);
}

// 4. trusted TMDB collisions: one TMDB id claimed by two Letterboxd ids trusts neither
{
 const gen=generation([],{catalogFilms:[{id:'c',tmdbId:555,shows:[show(5000)]}]});
 const out=composeWatchlist({snapshot:snapshot([member(5),member(6)]),generation:gen,identityByLid:new Map([['lb5',555],['lb6',555]])});
 assert.deepEqual(out.doc.films.map(film=>film.shows.length),[0,0]);assert.deepEqual(out.joined,[]);
 // a stored film that already owns the id collides with a new claimant too
 const owned=composeWatchlist({snapshot:snapshot([member(1),member(5)]),generation:{watchlist:{updatedAt:null,films:[stored(1,{tmdbId:555})]},programme:{films:[],catalogFilms:[{id:'c',tmdbId:555,shows:[show(5000)]}]}},identityByLid:{lb5:555}});
 assert.deepEqual(owned.doc.films[1].shows,[]);
 // a single claimant is trusted
 const single=composeWatchlist({snapshot:snapshot([member(5)]),generation:gen,identityByLid:{lb5:555}});
 assert.equal(single.doc.films[0].shows.length,1);
}

// 5. T28: a removal is membership-only. The film, its show rows and its facts stay; nothing is inferred.
{
 const gen=generation([1,2,3]);gen.watchlist.films[1].rating=4.5;
 const out=composeWatchlist({snapshot:snapshot([member(1),member(3)]),generation:gen});
 assert.deepEqual(out.doc.films.map(film=>film.id),['lb1','lb3']);
 const [gone]=out.doc.removed;
 assert.equal(gone.id,'lb2');assert.equal(gone.catalogOnly,true,'it takes the catalog-only presentation');
 assert.equal(gone.shows.length,1,'its known show rows stay');assert.equal(gone.rating,4.5,'its rating stays');
 for(const inferred of ['watched','removedBecause','reason','explainedBy'])assert.equal(inferred in gone,false,'no '+inferred+' is inferred from a removal');
 assert.equal(gen.watchlist.films[1].catalogOnly,undefined,'the generation itself is not changed (composition is a read, never a write)');
 // T29: a complete scan that removes most of the list is composed like any other (no threshold)
 const most=composeWatchlist({snapshot:snapshot([member(1)]),generation:generation(Array.from({length:50},(_,i)=>i+1))});
 assert.equal(most.doc.films.length,1);assert.equal(most.doc.removed.length,49);
}

// 6. no generation yet: a snapshot still reads, as unknown schedules
{
 const out=composeWatchlist({snapshot:snapshot([member(1),member(2)]),generation:{}});
 assert.deepEqual(out.doc.films.map(film=>film.id),['lb1','lb2']);assert.deepEqual(out.unknown,['lb1','lb2']);assert.equal(out.doc.updatedAt,null);
 assert.equal(composeWatchlist({snapshot:snapshot([]),generation:generation([1])}).doc.films.length,0,'an empty snapshot is an empty membership, not a fallback');
}

// 7. the stale flag is carried as given
{
 const out=composeWatchlist({snapshot:snapshot([member(1)],{stale:true}),generation:generation([1])});
 assert.equal(out.doc.snapshot.stale,true);
}
console.log('watchlist-composition: ok');
