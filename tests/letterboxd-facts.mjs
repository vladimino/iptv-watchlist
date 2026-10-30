import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';

// A CAS bucket that can be told to lose the next conditional write to a concurrent writer.
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,puts=0,contend=null,fail=null;
 return {records,get puts(){return puts;},contendOnce(key,mutate){contend={key,mutate};},failOnce(predicate){fail=predicate;},
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){
   if(fail&&fail(key)){fail=null;throw new Error('injected failure: '+key);}
   if(contend&&contend.key===key){const c=contend;contend=null;records.set(key,c.mutate(structuredClone(records.get(key))));etags.set(key,String(++revision));}
   const condition=options.onlyIf||{};
   if(condition.etagDoesNotMatch==='*'&&records.has(key)||condition.etagMatches&&condition.etagMatches!==etags.get(key))return null;
   records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts++;return {etag:etags.get(key)};},
  async delete(key){records.delete(key);},async list(){return {objects:[],truncated:false};}};
}
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);
const at=hours=>new Date(Date.UTC(2026,9,26,12)+hours*3600000).toISOString();
const obs=(fact,value,hours,source='letterboxd_export',ref='x')=>F.observation({factKey:'tmdb-1',fact,value,observedAt:at(hours),source,sourceRef:ref});

// Keys and validation.
assert.equal(F.factKeyFor({letterboxd:'abc',tmdb:'603'}),'tmdb-603');
assert.equal(F.factKeyFor({letterboxd:'abc'}),'lb-abc');
assert.throws(()=>F.factKeyFor({}),/no trusted id/);
await assert.rejects(F.linkFilm({BUCKET:bucket()},{tmdb:'5'}),error=>error.code==='invalid_identity','no record without a Letterboxd id');
assert.throws(()=>F.factKeyFor({tmdb:'0x1'}),/Invalid TMDB/);
await assert.rejects(F.observation({factKey:'k',fact:'rating',value:4.3,observedAt:at(0),source:'owner'}),/Invalid rating/);
await assert.rejects(F.observation({factKey:'k',fact:'rating',value:4,observedAt:'2026-10-26',source:'owner'}),/ISO UTC/);
await assert.rejects(F.observation({factKey:'k',fact:'watched',value:true,observedAt:at(0),source:'scraper'}),/Unknown source/);

// Order: time, then source rank, then observation id; a repeat is unchanged; the replaced value is kept as before-image.
{
 const record=F.emptyRecord('tmdb-1',{tmdb:'1'});
 assert.equal(F.applyObservation(record,'rating',await obs('rating',4,0)).outcome,'new');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',4,0)).outcome,'unchanged');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',3,-1)).outcome,'older');
 const later=await obs('rating',4.5,1,'letterboxd_films_list','scan');
 assert.equal(F.applyObservation(record,'rating',later).outcome,'replaces');
 assert.equal(record.rating.value,4.5);assert.equal(record.rating.replaced.value,4);assert.equal(record.rating.replaced.replaced,undefined);
 // Same time, different value: the higher-ranked source wins and the tie is reported.
 const owner=await obs('rating',2,1,'owner','edit');const tie=F.applyObservation(record,'rating',owner);
 assert.equal(tie.outcome,'replaces');assert.equal(tie.tie,true);assert.equal(record.rating.value,2);
 const exportSameTime=await obs('rating',5,1,'letterboxd_export','zip');const lost=F.applyObservation(record,'rating',exportSameTime);
 assert.equal(lost.outcome,'older');assert.equal(lost.tie,true);
 // rating: null is a timestamped state, not absence; it never clears watched.
 F.applyObservation(record,'watched',await obs('watched',true,0));
 assert.equal(F.applyObservation(record,'rating',await obs('rating',null,2,'letterboxd_films_list','scan2')).outcome,'replaces');
 assert.equal(record.rating.value,null);assert.equal(record.watched.value,true);
 // The summary floor: an observation older than the latest scan's never wins, even against an older record value.
 const floor=await obs('rating',null,5,'letterboxd_films_list','scan3');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',3,4,'letterboxd_film_page','page'),{floor}).outcome,'older');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',3,6,'letterboxd_film_page','page'),{floor}).outcome,'replaces');
}
// Rollback restores the before-image only while the export's observation is current; overlay merges by the order.
{
 const record=F.emptyRecord('tmdb-1',{tmdb:'1'}),first=await obs('rating',3,0,'letterboxd_films_list','s'),exported=await obs('rating',4,1,'letterboxd_export','zip');
 F.applyObservation(record,'rating',first);F.applyObservation(record,'rating',exported);
 const copy=structuredClone(record);
 assert.equal(F.rollbackFact(copy,'rating',exported.observationId),'restored');assert.equal(copy.rating.value,3);
 F.applyObservation(record,'rating',await obs('rating',5,2,'owner','edit'));
 assert.equal(F.rollbackFact(record,'rating',exported.observationId),'superseded');assert.equal(record.rating.value,5);
 const only=F.emptyRecord('tmdb-1',{tmdb:'1'});F.applyObservation(only,'watched',await obs('watched',true,0,'letterboxd_export','zip'));
 assert.equal(F.rollbackFact(only,'watched',only.watched.observationId),'restored');assert.equal(only.watched,undefined);
 const source=F.emptyRecord('lb-a',{letterboxd:'a'}),target=F.emptyRecord('tmdb-1',{tmdb:'1'});
 F.applyObservation(source,'watched',await obs('watched',true,0));F.applyObservation(target,'rating',await obs('rating',4,1));
 const merged=F.overlay(source,target);assert.equal(merged.watched.value,true);assert.equal(merged.rating.value,4);
}

// Storage: alias index, CAS retry under contention, redirects and fences, projection under every id of the film.
{
 const b=bucket(),env={BUCKET:b};
 assert.equal(await F.linkFilm(env,{letterboxd:'heat',tmdb:'949'}),'tmdb-949');
 assert.equal(await F.linkFilm(env,{letterboxd:'heat'}),'tmdb-949','an existing alias keeps its record');
 assert.equal(await F.resolveAlias(env,'tmdb:949'),'tmdb-949');
 await F.linkFilm(env,{letterboxd:'ronin',tmdb:'8195'});
 await assert.rejects(F.linkFilm(env,{letterboxd:'heat',tmdb:'8195'}),error=>error.code==='alias_conflict');
 const watched=await F.observation({factKey:'tmdb-949',fact:'watched',value:true,observedAt:at(0),source:'letterboxd_export',sourceRef:'zip'});
 b.contendOnce(F.recordKey('tmdb-949'),()=>({...F.emptyRecord('tmdb-949',{letterboxd:'heat',tmdb:'949'}),rating:{value:5,observedAt:at(3),source:'owner',sourceRef:null,observationId:'z',replaced:null}}));
 await b.put(F.recordKey('tmdb-949'),JSON.stringify(F.emptyRecord('tmdb-949',{letterboxd:'heat',tmdb:'949'})),{onlyIf:{etagDoesNotMatch:'*'}}).catch(()=>{});
 const written=await F.recordObservations(env,'tmdb-949',{letterboxd:'heat',tmdb:'949'},[{fact:'watched',observation:watched}]);
 assert.equal(written.record.watched.value,true);assert.equal(written.record.rating.value,5,'the concurrent owner write survives the retry');
 await F.projectRecords(env,[written.record]);
 const index=b.records.get('enrichment/view-index.json');
 assert.deepEqual([index.heat.watched,index.heat.actualRating,index.tmdb_949.watched,index.tmdb_949.actualRating],[true,5,true,5]);
 b.records.set(F.recordKey('lb-old'),{...F.emptyRecord('lb-old',{letterboxd:'old'}),redirectTo:'tmdb-949'});
 const via=await F.recordObservations(env,'lb-old',{letterboxd:'old'},[{fact:'watched',observation:watched}]);assert.equal(via.factKey,'tmdb-949');
 b.records.set(F.recordKey('lb-fenced'),{...F.emptyRecord('lb-fenced',{letterboxd:'fenced'}),migrating:{to:'tmdb-949',token:'t'}});
 assert.equal((await F.recordObservations(env,'lb-fenced',{letterboxd:'fenced'},[{fact:'watched',observation:watched}])).factKey,'tmdb-949','a fenced source sends writes to its target');
 b.records.set(F.recordKey('lb-loop'),{...F.emptyRecord('lb-loop',{}),redirectTo:'lb-old'});
 await assert.rejects(F.recordObservations(env,'lb-loop',{},[]),error=>error.code==='redirect_chain');
}

// Films-list scan (ADR-0024): one summary, absence keeps the value, only changed records are written.
{
 const b=bucket(),env={BUCKET:b};
 const exportRating=await F.observation({factKey:'tmdb-949',fact:'rating',value:4,observedAt:at(0),source:'letterboxd_export',sourceRef:'zip'});
 await F.linkFilm(env,{letterboxd:'heat',tmdb:'949'});
 await F.projectRecords(env,[(await F.recordObservations(env,'tmdb-949',{letterboxd:'heat',tmdb:'949'},[{fact:'rating',observation:exportRating}])).record]);
 const watchlistFilms=[{id:'heat',tmdbId:'949'},{id:'alien',tmdbId:'348'}];
 let result=await F.applyFilmsListScan(env,{scanId:'s1',observedAt:at(1),films:{alien:null,stranger:4.5},total:2},{watchlistFilms});
 assert.equal(result.stored,true);
 assert.equal(b.records.get(F.recordKey('tmdb-949')).rating.value,4,'a film absent from the list keeps its rating');
 const alien=b.records.get(F.recordKey('tmdb-348'));assert.equal(alien.watched.value,true);assert.equal(alien.rating.value,null,'listed without a rating is watched, not rated');
 assert.equal(b.records.has(F.recordKey('lb-stranger')),false,'an unknown id outside the watchlist stays in the summary only');
 assert.equal(b.records.get('letterboxd/facts/scans/films-list.json').films.stranger,4.5);
 assert.deepEqual([b.records.get('enrichment/view-index.json').tmdb_348.watched,b.records.get('enrichment/view-index.json').alien.actualRating],[true,null]);
 // An older or equal scan is not stored and writes nothing.
 assert.equal((await F.applyFilmsListScan(env,{scanId:'s0',observedAt:at(1),films:{heat:1},total:1},{watchlistFilms})).stored,false);
 // A newer scan with the same values rewrites no record.
 const before=b.puts;result=await F.applyFilmsListScan(env,{scanId:'s2',observedAt:at(2),films:{alien:null,stranger:4.5},total:2},{watchlistFilms});
 assert.equal(result.written,0);assert.equal(b.puts-before,3,'stage, summary and stage closure only; no record');
 // The summary is the floor: a per-film lookup older than the latest scan does not override it.
 const stale=await F.recordFilmFacts(env,'alien',{watched:true,rating:3},{observedAt:at(1.5),source:'letterboxd_film_page',sourceRef:'page'});
 assert.equal(stale.outcomes.find(o=>o.fact==='rating').outcome,'older');assert.equal(b.records.get(F.recordKey('tmdb-348')).rating.value,null);
 // An owner edit made while a scan runs (later than its start) is not overwritten by that scan.
 await F.recordFilmFacts(env,'alien',{rating:5},{observedAt:at(3.5),source:'owner'});
 await F.applyFilmsListScan(env,{scanId:'s3',observedAt:at(3),films:{alien:null,heat:4},total:2},{watchlistFilms});
 assert.equal(b.records.get(F.recordKey('tmdb-348')).rating.value,5);
 // heat appeared with the same value as the export: the record keeps its rating, the summary carries the newer observation.
 assert.equal(b.records.get(F.recordKey('tmdb-949')).rating.value,4);
 // A film the old summary listed and the new one does not keeps the old observation in its record.
 await F.applyFilmsListScan(env,{scanId:'s4',observedAt:at(4),films:{alien:null},total:1},{watchlistFilms});
 const heat=b.records.get(F.recordKey('tmdb-949'));assert.equal(heat.rating.value,4);assert.equal(heat.rating.observedAt,at(3),'carried from the replaced summary');
 // Alias conflicts are counted, not fatal.
 await F.linkFilm(env,{letterboxd:'other',tmdb:'111'});
 result=await F.applyFilmsListScan(env,{scanId:'s5',observedAt:at(5),films:{newfilm:3},total:1},{watchlistFilms:[{id:'newfilm',tmdbId:'111'}]});
 assert.equal(result.conflicts,1);
}

// Watchlist scan: listed films become true, a previously listed film becomes false; unchanged films are not rewritten.
{
 const b=bucket(),env={BUCKET:b};
 await F.applyWatchlistScan(env,{scanId:'w1',observedAt:at(0),films:[{id:'heat',tmdbId:'949'},{id:'alien',tmdbId:'348'}]});
 assert.equal(b.records.get(F.recordKey('tmdb-949')).watchlist.value,true);
 const before=b.puts;await F.applyWatchlistScan(env,{scanId:'w2',observedAt:at(1),films:[{id:'heat',tmdbId:'949'}]});
 assert.equal(b.records.get(F.recordKey('tmdb-348')).watchlist.value,false);assert.equal(b.records.get(F.recordKey('tmdb-949')).watchlist.observedAt,at(0));
 assert.equal(b.records.get('enrichment/view-index.json').tmdb_348.watchlist,false);
 assert.ok(b.puts-before<=5,'stage, summary, stage closure, one record and the projection');
 // A watchlist stage resumed by a newer scan keeps its own membership and trusted links.
 b.failOnce(key=>key===F.recordKey('tmdb-555'));
 await assert.rejects(F.applyWatchlistScan(env,{scanId:'w3',observedAt:at(2),films:[{id:'heat',tmdbId:'949'},{id:'drive',tmdbId:'555'}]}),/injected/);
 await F.applyWatchlistScan(env,{scanId:'w4',observedAt:at(3),films:[{id:'heat',tmdbId:'949'}]});
 const drive=b.records.get(F.recordKey('tmdb-555'));
 assert.equal(drive.watchlist.value,false,'added by the resumed w3, then removed by w4');assert.equal(drive.watchlist.replaced.observedAt,at(2));
}

// The EPG films scan always writes through the facts (LETTERBOXD_FACTS retired, ADR 0055): absence never clears a rating,
// and no value of the stale binding (absent, off, on, a near miss, an object) brings back the legacy path.
for(const stale of [undefined,'on','off','On',{token:'x'}]){
 const b=bucket(),records=b.records,film=id=>({id,url:'https://letterboxd.com/film/'+id+'/',title:id,original:id,year:2020,genres:[],shows:[]});
 const listing='<h1 title="1&nbsp;films">Watched</h1><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;seen&quot;}\'></div></li>';
 const ctx2=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async()=>({ok:true,status:200,text:async()=>listing}),ASSETS:{},INITIAL_PERSONAL_RATINGS:{}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx2);
 for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx2);
 await b.put('enrichment/view-index.json',JSON.stringify({kept:{actualRating:4}}));
 ctx2.env={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://example.test/epg.xml',BUCKET:b,...(stale===undefined?{}:{LETTERBOXD_FACTS:stale})};
 ctx2.report={runId:'r1',films:[film('kept'),film('seen')]};
 const label='binding '+JSON.stringify(stale);
 const scan=await vm.runInContext('refreshRatingsFromFilms(env,report)',ctx2);
 assert.equal(records.get('enrichment/view-index.json').kept.actualRating,4,'absence does not clear a rating, '+label);
 assert.equal(records.get('enrichment/view-index.json').seen.watched,true,label);assert.equal(scan.facts.written,1,label);
 assert.equal(records.get('letterboxd/facts/scans/films-list.json').total,1,label);
 assert.equal(records.has('enrichment/diagnostics/rating-observations.json'),false,'the legacy observation log is not written, '+label);
 // A complete watchlist is one observation of every listed film, whatever the stale binding holds.
 ctx2.run={runId:'r1',stage:'epg',watchlistObservedAt:new Date().toISOString(),events:[]};
 ctx2.full={runId:'r1',updatedAt:new Date().toISOString(),watchlistCount:2,films:[{...film('kept'),tmdbId:'901'},{...film('seen'),tmdbId:'902'}],stats:{}};
 await vm.runInContext('finishSync(env,run,full)',ctx2);
 assert.equal(records.get('letterboxd/facts/scans/watchlist.json').scanId,'r1',label);
 assert.equal(records.get(F.recordKey('tmdb-901')).watchlist.value,true,label);
}
// Staged publication: a crash between the stage and the facts keeps the old summary published and resumes on retry.
{
 const b=bucket(),env={BUCKET:b},watchlistFilms=[{id:'heat',tmdbId:'949'},{id:'alien',tmdbId:'348'}];
 await F.applyFilmsListScan(env,{scanId:'s1',observedAt:at(1),films:{heat:4,alien:3},total:2},{watchlistFilms});
 b.failOnce(key=>key===F.recordKey('tmdb-348'));
 await assert.rejects(F.applyFilmsListScan(env,{scanId:'s2',observedAt:at(2),films:{alien:2.5},total:1},{watchlistFilms}),/injected/);
 assert.equal(b.records.get('letterboxd/facts/scans/films-list.json').scanId,'s1','the summary is not published before its facts');
 const stage=b.records.get('letterboxd/facts/scans/films-list.pending.json');assert.equal(stage.done,false);assert.equal(stage.previous.scanId,'s1');
 const resumed=await F.applyFilmsListScan(env,{scanId:'s2',observedAt:at(2),films:{alien:2.5},total:1},{watchlistFilms});
 assert.equal(resumed.stored,true);assert.equal(b.records.get('letterboxd/facts/scans/films-list.json').scanId,'s2');
 assert.equal(b.records.get('letterboxd/facts/scans/films-list.pending.json').done,true);
 assert.equal(b.records.get(F.recordKey('tmdb-348')).rating.value,2.5);
 assert.equal(b.records.get(F.recordKey('tmdb-949')).rating.observedAt,at(1),'the film that dropped out keeps the s1 observation after the crash');
 // A crash before the projection is repaired by the retry even though the record already holds the value.
 b.failOnce(key=>key==='enrichment/view-index.json');
 await assert.rejects(F.applyFilmsListScan(env,{scanId:'s3',observedAt:at(3),films:{alien:2},total:1},{watchlistFilms}),/injected/);
 assert.equal(b.records.get('enrichment/view-index.json').alien.actualRating,2.5);
 await F.applyFilmsListScan(env,{scanId:'s3',observedAt:at(3),films:{alien:2},total:1},{watchlistFilms});
 assert.equal(b.records.get('enrichment/view-index.json').alien.actualRating,2);assert.equal(b.records.get('enrichment/view-index.json').tmdb_348.actualRating,2);
 // A newer scan finishes an unfinished older stage first.
 b.failOnce(key=>key===F.recordKey('tmdb-348'));
 await assert.rejects(F.applyFilmsListScan(env,{scanId:'s4',observedAt:at(4),films:{alien:1.5},total:1},{watchlistFilms}),/injected/);
 await F.applyFilmsListScan(env,{scanId:'s5',observedAt:at(5),films:{alien:1},total:1},{watchlistFilms});
 assert.equal(b.records.get(F.recordKey('tmdb-348')).rating.value,1);assert.equal(b.records.get(F.recordKey('tmdb-348')).rating.replaced.observedAt,at(4),'s4 was applied before s5');
 assert.equal(b.records.get('letterboxd/facts/scans/films-list.json').scanId,'s5');
 // An unfinished stage resumed by a newer scan uses its own watchlist context, not the newer scan's.
 b.failOnce(key=>key===F.recordKey('tmdb-777'));
 await assert.rejects(F.applyFilmsListScan(env,{scanId:'s5b',observedAt:at(5.5),films:{alien:1,gone:3.5},total:2},{watchlistFilms:[...watchlistFilms,{id:'gone',tmdbId:'777'}]}),/injected/);
 await F.applyFilmsListScan(env,{scanId:'s5c',observedAt:at(5.7),films:{alien:1},total:1},{watchlistFilms});
 const gone=b.records.get(F.recordKey('tmdb-777'));
 assert.ok(gone,'the resumed stage creates the record of a film only its own watchlist held');
 assert.equal(gone.rating.value,3.5);assert.equal(gone.links.tmdb,'777');assert.equal(gone.rating.observedAt,at(5.5));
 // Alias conflicts are recorded for review, not written.
 await F.linkFilm(env,{letterboxd:'other',tmdb:'111'});
 const conflicted=await F.applyFilmsListScan(env,{scanId:'s6',observedAt:at(6),films:{newfilm:3},total:1},{watchlistFilms:[{id:'newfilm',tmdbId:'111'}]});
 assert.equal(conflicted.conflicts,1);assert.equal(b.records.get('letterboxd/facts/conflicts.json')['letterboxd:newfilm tmdb:111'].reason,'alias_conflict');
 assert.equal(b.records.has(F.recordKey('lb-newfilm')),false);
}

// Owner rating edit, always through the facts (ADR 0055): facts first; a rejected observation leaves actual.json alone and says so.
{
 const b=bucket(),records=b.records;
 const ctx3=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async()=>{throw new Error('no network');},ASSETS:{},INITIAL_PERSONAL_RATINGS:{}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx3);
 for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx3);
 const env={BUCKET:b,LETTERBOXD_FACTS:'off',LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://example.test/epg.xml'};
 const put=async items=>{const r=await ctx3.worker.fetch(new Request('https://site.example/api/enrichment/actual-ratings',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})}),env);return (await r.json()).results;};
 let results=await put([{filmId:'heat',rating:4}]);assert.equal(results[0].status,'saved');
 assert.equal(records.get('enrichment/films/heat/actual.json').rating,4);assert.equal(records.get('enrichment/view-index.json').heat.actualRating,4);
 const future=new Date(Date.now()+86400000).toISOString();
 await b.put('letterboxd/facts/scans/films-list.json',JSON.stringify({schemaVersion:1,scanId:'later',observedAt:future,total:1,films:{heat:2}}));
 results=await put([{filmId:'heat',rating:5}]);
 assert.equal(results[0].status,'older');assert.equal(records.get('enrichment/films/heat/actual.json').rating,4,'a rejected edit does not touch actual.json');
 assert.ok(records.has(F.recordKey('lb-heat')),'the stale off binding did not bring back the legacy writer');
}
console.log('Letterboxd facts: order and ties, null and before-image, rollback and overlay, alias index and CAS retry, redirects and fences, films-list and watchlist summaries, floor, staged publication and crash resume with the stage context, conflict registry, facts-first owner edit, writers inert to the retired switch passed');
