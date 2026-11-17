// AIR-503 (second delivery): an EPG title is evidence of an airing, not a title of the Film.
// - touchCanonicalFilm learns a new title key only from an independently confirmed observation, and never writes `movieTitles`;
// - catalogFilmFromDetail records the movie-authority titles in `movieTitles`;
// - scanEPG confirms a catalog-only Film on a slot only by a title with movie provenance (title, original, `movieTitles`).
// Deterministic: fixture XMLTV and records only. No production read, no network, no flag.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';

const H=3600000,now=Date.parse('2026-11-17T12:00:00Z');
const context=vm.createContext({TextDecoder,Date,Map,Set,Number,String,JSON,Math,RegExp,Error,Promise,AbortSignal,fetch,console,URL,URLSearchParams});
vm.runInContext(fs.readFileSync('src/domain/scored-resolution.js','utf8')+'\nglobalThis.showMatchBasis=showMatchBasis;',context);
vm.runInContext(fs.readFileSync('src/sources.js','utf8')+';globalThis.scanEPG=scanEPG;globalThis.mergeCatalogIdentity=mergeCatalogIdentity;',context);
vm.runInContext(fs.readFileSync('src/discovery.js','utf8')+';globalThis.touchCanonicalFilm=touchCanonicalFilm;globalThis.catalogFilmFromDetail=catalogFilmFromDetail;globalThis.independentTitleEvidence=independentTitleEvidence;',context);
const plain=value=>JSON.parse(JSON.stringify(value));
const call=(name,...args)=>{context.args=args;return plain(vm.runInContext(`${name}(...args)`,context));};
const stamp=ms=>new Date(ms).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const programme=(title,offsetH,minutes,channel='one')=>`<programme channel="${channel}" start="${stamp(now+offsetH*H)}" stop="${stamp(now+offsetH*H+minutes*60000)}"><title>${title}</title></programme>`;
const scan=async(programmes,watchlist)=>{
 const xml='<tv><channel id="one"><display-name>Кино</display-name></channel><channel id="two"><display-name>Два</display-name></channel>'+programmes.join('')+'</tv>';
 context.stream=Readable.toWeb(Readable.from([Buffer.from(xml)]));context.now=now;context.watchlist=watchlist;
 return vm.runInContext('scanEPG(stream,watchlist,now)',context);
};
const observationOf=(result,key)=>result.discovery.find(item=>item.normalizedTitle===key);
const reasons=result=>Array.from(result.uncertain,item=>item.reason);
const attached=(result,id)=>result.films.find(item=>item.id===id)?.shows.length||0;

const SERIES='Губка Боб квадратные штаны';
const sponge=(extra={})=>({id:'tmdb_400160',tmdbId:'400160',catalogOnly:true,title:'Губка Боб в бегах',original:'The SpongeBob Movie: Sponge on the Run',year:2020,runtime:95,canonicalIdentity:'tmdb:400160',
 aliases:['Губка Боб в бегах','The SpongeBob Movie: Sponge on the Run','Губка Боб: Втеча Губки',SERIES],...extra});

// 1. Learning rule. A raw title with a new key is not learned from a non-independent observation. A cosmetic spelling of a known key is kept.
const base={tmdbId:'400160',title:'Губка Боб в бегах',original:'The SpongeBob Movie: Sponge on the Run',aliases:['Губка Боб в бегах','The SpongeBob Movie: Sponge on the Run'],movieTitles:['Губка Боб в бегах']};
const seriesObservation={title:SERIES,rawTitles:['Губка Боб — квадратные штаны',SERIES],lastAiring:now};
let touched=call('touchCanonicalFilm',base,seriesObservation,undefined,true,false);
assert.deepEqual(touched.aliases,base.aliases,'a series-title observation adds no alias without independent confirmation');
assert.deepEqual(touched.movieTitles,base.movieTitles,'touching never writes movie provenance');
touched=call('touchCanonicalFilm',base,{title:'Губка Боб в бегах (2020).',rawTitles:['х/ф Губка Боб в бегах'],lastAiring:now},undefined,true,false);
assert.deepEqual(touched.aliases,['Губка Боб в бегах','The SpongeBob Movie: Sponge on the Run','Губка Боб в бегах (2020).','х/ф Губка Боб в бегах'],'cosmetic spellings of a known key are kept');
touched=call('touchCanonicalFilm',base,seriesObservation,undefined,true,true);
assert.equal(touched.aliases.includes(SERIES),true,'an independently confirmed observation may add its title');
assert.deepEqual(touched.movieTitles,base.movieTitles,'an alias learned from the EPG is still not movie provenance');
assert.equal(call('independentTitleEvidence',{identitySource:'tmdb_detail'}),true);
assert.equal(call('independentTitleEvidence',{identitySource:'owner'}),true);
assert.equal(call('independentTitleEvidence',{identitySource:'known_epg_alias'}),false);
assert.equal(call('independentTitleEvidence',{identitySource:'known_alias_year_runtime'}),false);
assert.equal(call('independentTitleEvidence',null),false);

// 2. catalogFilmFromDetail records what the movie authority says, and only that, as provenance.
const movie={id:400160,title:'Губка Боб в бегах',original_title:'The SpongeBob Movie: Sponge on the Run',release_date:'2020-08-14',runtime:91,genres:[],credits:{},
 translations:{translations:[{iso_639_1:'uk',data:{title:'Губка Боб: Втеча Губки'}},{iso_639_1:'de',data:{title:'Schwammkopf'}}]},
 alternative_titles:{titles:[{iso_3166_1:'US',title:'Spongebob Movie 3'},{iso_3166_1:'FR',title:'Bob l’éponge'}]}};
const fromDetail=call('catalogFilmFromDetail',movie,seriesObservation,undefined,'run-1','tmdb_400160',true);
assert.deepEqual(fromDetail.movieTitles,['Губка Боб в бегах','The SpongeBob Movie: Sponge on the Run','Губка Боб: Втеча Губки','Spongebob Movie 3']);
assert.equal(fromDetail.aliases.includes(SERIES),true,'the TMDB-verified observation keeps its raw title as an alias');
assert.equal(fromDetail.movieTitles.includes(SERIES),false,'but the series title is not movie provenance');
const again=call('catalogFilmFromDetail',movie,{title:'Другое',rawTitles:['Другое']},fromDetail,'run-2','tmdb_400160',true);
assert.deepEqual(again.movieTitles,fromDetail.movieTitles,'a later read keeps the recorded provenance');

// 3. The slot. A series title that is only an alias does not confirm the film, whatever the runtime.
const provenance=['Губка Боб в бегах','The SpongeBob Movie: Sponge on the Run','Губка Боб: Втеча Губки'];
let result=await scan([programme(SERIES,2,87)],[sponge({movieTitles:provenance})]);
assert.equal(attached(result,'tmdb_400160'),0);
assert.equal(observationOf(result,'губка боб квадратные штаны').confirmedTmdbId,null,'the observation is not confirmed as the film');
assert.equal(observationOf(result,'губка боб квадратные штаны').confirmedSlots.length,0);
assert.deepEqual(reasons(result),['alias_without_movie_provenance']);
// A legacy record has no provenance list: only its title and original count, so the same alias does not confirm either.
result=await scan([programme(SERIES,2,87)],[sponge()]);
assert.equal(observationOf(result,'губка боб квадратные штаны').confirmedTmdbId,null);
assert.deepEqual(reasons(result),['alias_without_movie_provenance']);
// The film's own title confirms, with or without provenance (legacy records keep working).
result=await scan([programme('Губка Боб в бегах',2,95)],[sponge()]);
assert.equal(observationOf(result,'губка боб в бегах').confirmedTmdbId,'400160');
assert.equal(observationOf(result,'губка боб в бегах').confirmedSlots.length,1);
result=await scan([programme('The SpongeBob Movie: Sponge on the Run',2,92)],[sponge()]);
assert.equal(observationOf(result,'the spongebob movie sponge on the run').confirmedTmdbId,'400160','the original title is movie provenance');
// A real translation recorded by the movie authority confirms.
result=await scan([programme('Губка Боб: Втеча Губки',2,93)],[sponge({movieTitles:provenance})]);
assert.equal(observationOf(result,'губка боб втеча губки').confirmedTmdbId,'400160');
// The same translation without a recorded provenance does not; the resolver re-reads the movie and records it.
result=await scan([programme('Губка Боб: Втеча Губки',2,93)],[sponge()]);
assert.equal(observationOf(result,'губка боб втеча губки').confirmedTmdbId,null);
assert.deepEqual(reasons(result),['alias_without_movie_provenance']);

// 4. The feedback loop is closed. An observation that was verified by an alias cannot teach the alias that would verify the next slot.
const wonder=film=>({id:'tmdb_1114967',tmdbId:'1114967',catalogOnly:true,title:'Везунчики',original:'Lucky',year:2023,runtime:105,canonicalIdentity:'tmdb:1114967',aliases:['Везунчики','Lucky'],...film});
const learned=call('touchCanonicalFilm',wonder(),{title:'Удача',rawTitles:['Удача.'],lastAiring:now},undefined,true,call('independentTitleEvidence',{identitySource:'known_epg_alias'}));
assert.equal(learned.aliases.includes('Удача'),false);
result=await scan([programme('Удача',2,105)],[{...wonder(),aliases:learned.aliases}]);
assert.equal(observationOf(result,'удача').confirmedTmdbId,null);
const taught=call('touchCanonicalFilm',wonder(),{title:'Удача',rawTitles:['Удача.'],lastAiring:now},undefined,true,call('independentTitleEvidence',{identitySource:'tmdb_detail'}));
assert.equal(taught.aliases.includes('Удача'),true);
result=await scan([programme('Удача',2,105)],[{...wonder(),aliases:taught.aliases}]);
assert.equal(observationOf(result,'удача').confirmedTmdbId,null,'even an independently learned EPG title is not movie provenance for the shortcut');

// 5. What stays. A watchlist Film is the owner's: its aliases, including a Letterboxd one, still attach a fitting airing.
const watched={...wonder(),catalogOnly:undefined,id:'lb-1',aliases:['Везунчики','Lucky','Удача']};
result=await scan([programme('Удача',2,105)],[watched]);
assert.equal(attached(result,'lb-1'),1);
// A competing alias still blocks. Two identities for one title stay a collision, whichever of them lacks provenance.
const owner={...wonder(),catalogOnly:undefined,id:'lb-2',tmdbId:'2',canonicalIdentity:'tmdb:2',title:'Удача',original:'Luck',aliases:['Удача','Luck'],runtime:104};
result=await scan([programme('Удача',2,105)],[owner,wonder({aliases:['Везунчики','Lucky','Удача']})]);
assert.equal(attached(result,'lb-2'),0);
assert.equal(reasons(result).includes('identity_collision'),true);

// 6. The merge keeps provenance from either side.
const merged=call('mergeCatalogIdentity',{tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'A',aliases:['A'],movieTitles:['A']}},{tmdb_1:{id:'tmdb_1',tmdbId:'1',title:'A',aliases:['A','B'],movieTitles:['A','B']}},'run-1',{writeAvailability:true});
assert.deepEqual(merged.tmdb_1.movieTitles,['A','B']);
const legacyMerge=call('mergeCatalogIdentity',{tmdb_2:{id:'tmdb_2',tmdbId:'2',title:'C',aliases:['C']}},{tmdb_2:{id:'tmdb_2',tmdbId:'2',title:'C',aliases:['C']}},'run-1',{writeAvailability:true});
assert.equal('movieTitles' in legacyMerge.tmdb_2,false,'a legacy record gains no empty provenance list');
// 7. The lookup index includes the movie provenance. A translation that is recorded only in `movieTitles` (not duplicated in `aliases`, as a legacy or migrated record may have it) still reaches the check and confirms.
const onlyProvenance={id:'tmdb_101',tmdbId:'101',catalogOnly:true,title:'Film R',original:'Film R',year:2001,runtime:96,canonicalIdentity:'tmdb:101',aliases:['Film R'],movieTitles:['Film R','Фільм Р']};
result=await scan([programme('Фільм Р',2,96)],[onlyProvenance]);
assert.equal(observationOf(result,'фільм р').confirmedTmdbId,'101');
assert.equal(observationOf(result,'фільм р').confirmedSlots.length,1);
result=await scan([programme('Фільм Р',2,96)],[{...onlyProvenance,movieTitles:['Film R']}]);
assert.equal(result.discovery.length,1,'without the recorded title the slot is a plain observation, not a collision or a match');
assert.equal(observationOf(result,'фільм р').confirmedTmdbId,null);
console.log('alias provenance: no EPG title becomes an alias without independent confirmation, no alias confirms a catalog film without movie provenance, own titles and watchlist aliases keep matching');
