import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';

// The rating history of a Letterboxd fact record: append-only, written in the record's own compare-and-swap, one entry per
// change of the effective rating, none for a confirmation, a repeat, an older observation, an absence or another fact.
function bucket(){
 const records=new Map(),etags=new Map();let revision=0,contend=null,fail=null;
 return {records,contendOnce(key,mutate){contend={key,mutate};},failOnce(predicate){fail=predicate;},
  async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){
   if(fail&&fail(key)){fail=null;throw new Error('injected failure: '+key);}
   if(contend&&contend.key===key){const c=contend;contend=null;records.set(key,c.mutate(structuredClone(records.get(key))));etags.set(key,String(++revision));}
   const condition=options.onlyIf||{};
   if(condition.etagDoesNotMatch==='*'&&records.has(key)||condition.etagMatches&&condition.etagMatches!==etags.get(key))return null;
   records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async delete(key){records.delete(key);},async list(){return {objects:[],truncated:false};}};
}
const ctx=vm.createContext({crypto:webcrypto,TextEncoder,console,Date,JSON,Map,Set});
const F=vm.runInContext(fs.readFileSync('src/letterboxd-facts.js','utf8')+';LetterboxdFacts',ctx);
const at=hours=>new Date(Date.UTC(2026,9,26,12)+hours*3600000).toISOString();
const obs=(fact,value,hours,source='letterboxd_film_page',ref='r')=>F.observation({factKey:'tmdb-1',fact,value,observedAt:at(hours),source,sourceRef:ref});
const kinds=record=>JSON.parse(JSON.stringify((record.ratingHistory||[]).map(entry=>entry.kind+":"+JSON.stringify(entry.kind==="rolled_back"?entry.restored?.value??null:entry.value))));

// Pure merge: first observation, change, confirmation, repeat, older, null ("seen, not rated"), other facts.
{
 const record=F.emptyRecord('tmdb-1',{tmdb:'1'});
 assert.equal(F.applyObservation(record,'watched',await obs('watched',true,0)).outcome,'new');
 assert.equal(record.ratingHistory,undefined,'a watched fact writes no rating history');
 const first=await obs('rating',4,0);F.applyObservation(record,'rating',first);
 assert.deepEqual(kinds(record),['first_observed:4']);
 assert.equal(record.ratingHistory[0].previous,null);assert.equal(record.ratingHistory[0].observationId,first.observationId);
 assert.equal(record.ratingHistory[0].observedAt,at(0),'observedAt is the observation time, not a watch date');
 F.applyObservation(record,'rating',first);
 assert.equal(record.ratingHistory.length,1,'the same observation again is a no-op');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',4,1,'letterboxd_films_list','scan')).outcome,'replaces');
 assert.equal(record.ratingHistory.length,1,'a newer observation of the same value is a confirmation, not a re-rating');
 assert.equal(F.applyObservation(record,'rating',await obs('rating',2,-5)).outcome,'older');
 assert.equal(record.ratingHistory.length,1,'an older observation changes nothing');
 F.applyObservation(record,'rating',await obs('rating',3.5,2));
 F.applyObservation(record,'rating',await obs('rating',null,3,'owner'));
 F.applyObservation(record,'rating',await obs('rating',5,4,'owner'));
 assert.deepEqual(kinds(record),['first_observed:4','changed:3.5','changed:null','changed:5']);
 assert.equal(record.rating.replaced.value,null,'the one-level before-image is unchanged');
 assert.equal(record.ratingHistory[1].previous.value,4,'previous is the effective value at the change, the confirmation included');
 assert.equal(record.ratingHistory[1].previous.source,'letterboxd_films_list');
 assert.equal(record.ratingHistory[2].value,null);assert.equal(record.ratingHistory[3].previous.value,null);
 // The history is longer than the before-image: every value since the first observation is still there.
 assert.equal(record.ratingHistory.length,4);
}

// A scan summary floor: the incoming value equals the floor, so nothing changed; a different one is a change from the floor.
{
 const record=F.emptyRecord('tmdb-1',{tmdb:'1'});
 const floor=await obs('rating',3,0,'letterboxd_films_list','scan-1');
 F.applyObservation(record,'rating',await obs('rating',3,1),{floor});
 assert.equal(record.ratingHistory,undefined,'same value as the scan summary: no change');
 F.applyObservation(record,'rating',await obs('rating',4,2),{floor});
 assert.deepEqual(kinds(record),['changed:4']);assert.equal(record.ratingHistory[0].previous.value,3);
 const fresh=F.emptyRecord('tmdb-1',{tmdb:'1'});
 F.applyObservation(fresh,'rating',await obs('rating',2,2),{floor});
 assert.deepEqual(kinds(fresh),['changed:2'],'a record without a stored value still changes from the scan summary');
 assert.equal(fresh.ratingHistory[0].previous.source,'letterboxd_films_list');
}

// Writers: the films-list scan and the per-film lookup through compare-and-swap; absence is not an observation.
{
 const b=bucket(),env={BUCKET:b},watchlistFilms=[{id:'alien',tmdbId:'348'},{id:'heat',tmdbId:'949'}];
 await F.applyFilmsListScan(env,{scanId:'s1',observedAt:at(1),films:{alien:4,heat:null},total:2},{watchlistFilms});
 const alien=()=>b.records.get(F.recordKey('tmdb-348')),heat=()=>b.records.get(F.recordKey('tmdb-949'));
 assert.deepEqual(kinds(alien()),['first_observed:4']);assert.deepEqual(kinds(heat()),['first_observed:null']);
 await F.applyFilmsListScan(env,{scanId:'s2',observedAt:at(2),films:{alien:4},total:1},{watchlistFilms});
 assert.equal(alien().ratingHistory.length,1,'a rescan with the same rating adds nothing');
 assert.equal(heat().ratingHistory.length,1,'a film absent from the list keeps its history and gets no entry');
 await F.applyFilmsListScan(env,{scanId:'s3',observedAt:at(3),films:{alien:2.5,heat:null},total:2},{watchlistFilms});
 assert.deepEqual(kinds(alien()),['first_observed:4','changed:2.5']);
 // Concurrent writer: the record changes between read and write; the retry re-applies onto the fresh record, one entry only.
 b.contendOnce(F.recordKey('tmdb-348'),current=>({...current,links:{...current.links}}));
 await F.recordFilmFacts(env,'alien',{rating:3},{observedAt:at(4),source:'letterboxd_film_page',sourceRef:'page'});
 assert.deepEqual(kinds(alien()),['first_observed:4','changed:2.5','changed:3']);
 // Crash after the record write (projection fails), then a replay of the same observation: no duplicate entry.
 b.failOnce(key=>key==='enrichment/view-index.json');
 await assert.rejects(F.recordFilmFacts(env,'alien',{rating:3.5},{observedAt:at(5),source:'owner'}),/injected/);
 assert.deepEqual(kinds(alien()),['first_observed:4','changed:2.5','changed:3','changed:3.5'],'the history is in the record write, never behind it');
 await F.recordFilmFacts(env,'alien',{rating:3.5},{observedAt:at(5),source:'owner'});
 assert.equal(alien().ratingHistory.length,4,'the replay is idempotent');
 assert.equal(alien().rating.value,3.5);
 // A watchlist scan is not a rating observation.
 await F.applyWatchlistScan(env,{scanId:'w1',observedAt:at(6),films:[{id:'alien',tmdbId:'348'}]});
 assert.equal(alien().ratingHistory.length,4);
}

// Baseline import: a pre-existing export rating is first_observed with the export as source; a rollback is recorded after it,
// and the same observation committed again after the rollback is recorded again.
{
 const b=bucket(),env={BUCKET:b};
 const origin={archiveSha256:'a'.repeat(64),generatedAt:at(0),generatedAtSource:'archive_name'};
 const body={origin,chunk:0,items:[{lid:'alien',tmdb:'348',facts:{watched:true,rating:4.5}},{lid:'heat',tmdb:'949',facts:{watched:true,rating:3}}]};
 await F.recordFilmFacts(env,'heat',{rating:2},{observedAt:at(-1),source:'letterboxd_film_page',sourceRef:'old'});
 const heatKey=b.records.get(F.FACTS_KEYS.links)['letterboxd:heat'];
 await F.commitBaselineChunk(env,body);
 const alien=()=>b.records.get(F.recordKey('tmdb-348')),heat=()=>b.records.get(F.recordKey(heatKey));
 assert.deepEqual(kinds(alien()),['first_observed:4.5']);assert.equal(alien().ratingHistory[0].source,'letterboxd_export');
 assert.deepEqual(kinds(heat()),['first_observed:2','changed:3']);
 await F.commitBaselineChunk(env,body);
 assert.equal(alien().ratingHistory.length,1,'a replayed commit adds nothing');
 await F.rollbackBaselineChunk(env,{origin,chunk:0});
 assert.equal(alien().rating,undefined);assert.deepEqual(kinds(alien()),['first_observed:4.5','rolled_back:null']);
 assert.equal(heat().rating.value,2);assert.deepEqual(kinds(heat()),['first_observed:2','changed:3','rolled_back:2']);
 assert.equal(heat().ratingHistory[2].observationId,heat().ratingHistory[1].observationId,'the rollback names the observation it reversed');
 assert.match(heat().ratingHistory[2].at,/^\d{4}-\d{2}-\d{2}T/);
 await F.rollbackBaselineChunk(env,{origin,chunk:0});
 assert.equal(heat().ratingHistory.length,3,'a repeated rollback adds nothing');
 const record=structuredClone(heat()),again=record.ratingHistory[1].observationId;
 const replay=await F.observation({factKey:heatKey,fact:'rating',value:3,observedAt:at(0),source:'letterboxd_export',sourceRef:'a'.repeat(64)});
 assert.equal(replay.observationId,again);
 F.applyObservation(record,'rating',replay);
 assert.deepEqual(kinds(record),['first_observed:2','changed:3','rolled_back:2','changed:3'],'an observation applied again after its rollback is a change again');
}

// The validate preview applies observations to a copy only: no history reaches storage.
{
 const b=bucket(),env={BUCKET:b};
 const origin={archiveSha256:'b'.repeat(64),generatedAt:at(0),generatedAtSource:'archive_name'};
 await F.previewBaselineChunk(env,{origin,chunk:0,items:[{lid:'alien',tmdb:'348',facts:{watched:true,rating:4}}]});
 assert.equal(b.records.has(F.recordKey('tmdb-348')),false);
}
// Convergence: the overlay read (and the merge it specifies) keeps every distinct event of both records exactly once.
{
 const t=(minutes)=>new Date(Date.UTC(2026,9,28,10,minutes)).toISOString();
 const e=(kind,id,minutes,extra={})=>({kind,observationId:id,recordedAt:t(minutes),...(kind==='rolled_back'?{at:t(minutes),restored:null}:{value:extra.value??4,observedAt:t(minutes),source:'owner'}),...extra});
 const source={...F.emptyRecord('lb-alien',{letterboxd:'alien'}),rating:{value:3,observedAt:t(5),source:'owner',observationId:'s2'},
  ratingHistory:[e('first_observed','s1',1,{value:2}),e('changed','x',3,{value:4}),e('rolled_back','x',4),e('changed','x',6,{value:4}),e('changed','s2',7,{value:3})]};
 const target={...F.emptyRecord('tmdb-348',{tmdb:'348'}),rating:{value:5,observedAt:t(2),source:'owner',observationId:'t1'},
  ratingHistory:[e('first_observed','t1',2,{value:5}),e('changed','x',3,{value:4})]};
 const merged=F.overlay(source,target);
 const ids=list=>JSON.parse(JSON.stringify(list.map(entry=>entry.kind+':'+entry.observationId)));
 assert.deepEqual(ids(merged.ratingHistory),['first_observed:s1','first_observed:t1','changed:x','rolled_back:x','changed:x','changed:s2'],'both histories, the shared event once, the re-application kept');
 assert.equal(merged.rating.observationId,'s2','the current value still follows the observation order');
 assert.equal(source.ratingHistory.length,5);assert.equal(target.ratingHistory.length,2,'inputs are not modified');
 // Repeated convergence and either argument order give the same list; merging the result again changes nothing.
 assert.deepEqual(ids(F.overlay(target,source).ratingHistory),ids(merged.ratingHistory));
 assert.deepEqual(ids(F.mergeRatingHistories(merged.ratingHistory,target.ratingHistory)),ids(merged.ratingHistory));
 assert.deepEqual(ids(F.mergeRatingHistories(merged.ratingHistory,merged.ratingHistory)),ids(merged.ratingHistory));
 // A record without history keeps the other's; two without history produce none.
 assert.equal(F.overlay({...source,ratingHistory:undefined},target).ratingHistory.length,2);
 assert.equal(F.overlay({...source,ratingHistory:undefined},{...target,ratingHistory:undefined}).ratingHistory,undefined);
}

// A diary rating can return to a value already in the list. The observation id is unchanged (ingestedAt is not part of
// it). 4.0 → 4.5 → 4.0 → 4.5 on one watched date is four history events. An identical reread and a late earlier read
// add none. A contended retry of the return appends once. The convergence union keeps both applications of one id.
{
 const b=bucket(),env={BUCKET:b},watched='2026-10-20',ref='diary:viewing:401';
 const item=(rating,readAt)=>({lid:'cycle',watchedDate:watched,rating,sourceRef:ref,readAt});
 const key='letterboxd/facts/films/lb-cycle.json',stored=()=>b.records.get(key);
 const reads=['2026-10-20T18:00:00.000Z','2026-10-25T18:00:00.000Z','2026-10-27T18:00:00.000Z','2026-10-28T18:00:00.000Z'];
 for(const [rating,readAt] of [[4,reads[0]],[4.5,reads[1]],[4,reads[2]],[4.5,reads[3]]])await F.applyDiaryEvidence(env,[item(rating,readAt)]);
 assert.equal(stored().rating.value,4.5);assert.equal(stored().rating.ingestedAt,reads[3]);
 assert.deepEqual(stored().ratingHistory.map(entry=>[entry.kind,entry.value]),[['first_observed',4],['changed',4.5],['changed',4],['changed',4.5]]);
 const id4=stored().ratingHistory[0].observationId,id45=stored().ratingHistory[1].observationId;
 assert.equal(stored().ratingHistory[2].observationId,id4);assert.equal(stored().ratingHistory[3].observationId,id45);
 assert.equal(stored().ratingHistory[2].previous.observationId,id45);assert.equal(stored().ratingHistory[3].previous.observationId,id4);
 b.records.set(F.FACTS_KEYS.viewIndex,{cycle:{watched:true,actualRating:1}});
 assert.equal((await F.applyDiaryEvidence(env,[item(4.5,'2026-10-29T18:00:00.000Z')])).unchanged,1);
 assert.equal(stored().ratingHistory.length,4,'an identical reread adds no event');assert.equal(stored().rating.ingestedAt,reads[3]);
 assert.equal((await F.applyDiaryEvidence(env,[item(4,reads[0])])).older,1);
 assert.equal(stored().rating.value,4.5);assert.equal(stored().ratingHistory.length,4,'a late earlier read adds no event');
 const full=structuredClone(stored());
 const partial={...F.emptyRecord(full.factKey,full.links),rating:{value:4.5,observedAt:watched+'T00:00:00.000Z',source:'letterboxd_diary',observationId:id45},ratingHistory:full.ratingHistory.slice(0,2)};
 const merged=F.overlay(full,partial);
 assert.equal(merged.ratingHistory.filter(entry=>entry.observationId===id4&&entry.kind!=='rolled_back').length,2,'both applications of 4.0 survive the union');
 assert.equal(merged.ratingHistory.filter(entry=>entry.observationId===id45&&entry.kind!=='rolled_back').length,2,'both applications of 4.5 survive the union');
 assert.deepEqual(F.mergeRatingHistories(merged.ratingHistory,merged.ratingHistory).map(entry=>entry.kind+':'+entry.observationId),merged.ratingHistory.map(entry=>entry.kind+':'+entry.observationId));
 b.contendOnce(key,current=>({...current,links:{...current.links}}));
 await F.applyDiaryEvidence(env,[item(4,'2026-10-30T18:00:00.000Z')]);
 assert.equal(stored().rating.value,4);
 assert.equal(stored().ratingHistory.filter(entry=>entry.kind==='changed'&&entry.value===4).length,2,'the contended return appends once');
 assert.equal(stored().ratingHistory.length,5);
}

console.log('Rating history: first observation, change, confirmation, repeat, older, null, scan floor, absence, concurrent CAS, crash replay, export pre-existing, rollback and re-apply, convergence union with overlaps, re-application and repeated merges, a diary return to a previous value passed');
