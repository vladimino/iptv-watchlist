import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto,createHash} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';

// GET /api/enrichment/history: one film's predictions and rating events, read-only, ordered, paged, honest about gaps.
const records=new Map(),etags=new Map();let revision=0,puts=[],fetches=[];
const bucket={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key){puts.push(key);return null;},async delete(key){puts.push('delete:'+key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,typeof value==='string'?value:JSON.stringify(value));etags.set(key,'e'+(++revision));};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,
 ASSETS:{'/':{body:'<!doctype html>',type:'text/html'}},INITIAL_PERSONAL_RATINGS:{},fetch:async input=>{fetches.push(String(input));return new Response('no',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(scoped('src/prediction-d1.js','PredictionD1'),ctx);vm.runInContext(scoped('src/ratings-d1.js','RatingsD1'),ctx);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader','const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n'),ctx);
for(const file of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/mcp.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={FILM_PERSON_DB_OPTIONAL:'standin',BUCKET:bucket,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};
const sha=text=>createHash('sha256').update(text).digest('hex');
async function history(query,environment=env){puts=[];fetches=[];const response=await ctx.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/history?'+query),environment,{waitUntil(){throw new Error('no background work');}});const data=await response.json();assert.deepEqual(puts,[],'no write on '+query);assert.deepEqual(fetches,[],'no outbound request on '+query);return {status:response.status,data:JSON.parse(JSON.stringify(data))};}

// Validation.
assert.equal((await history('')).status,400);
assert.equal((await history('filmId=../x')).status,400);
assert.equal((await history('filmId=abc&limit=0')).status,400);
assert.equal((await history('filmId=abc&limit=101')).status,400);
assert.equal((await history('filmId=abc&cursor=zzz')).status,400);

// A film with nothing stored: an empty, explicit answer.
{
 const {status,data}=await history('filmId=nothing');
 assert.equal(status,200);assert.deepEqual(data.events,[]);assert.equal(data.page.total,0);assert.equal(data.page.nextCursor,null);
 assert.deepEqual(data.snapshot.sources,{predictions:{status:'missing'},facts:{status:'missing',factKey:null},legacyRatingLog:{status:'missing'},
  diary:{status:'missing',link:{status:'linked',lid:'nothing',via:'requested_id',candidates:['nothing']},unresolvedEntries:0,state:null}});
 assert.equal(data.current.prediction,null);assert.equal(data.current.rating,null);assert.equal(data.current.diary,null);assert.equal(data.partial,false);
 assert.deepEqual(data.notes,['diary_absence_is_not_unwatched','diary_history_missing'],'a missing Diary history is said, never read as "not watched"');
}

// Seed one film: three predictions (an old one without lineage, one linked, one current with a broken object), its fact record
// with rating changes including a rollback and a re-application, and legacy log entries under both of its ids.
const profile={version:2,profileHash:'p2'};set('enrichment/profile/current.json',profile);
const versionKey=(id,s)=>'enrichment/films/'+id+'/predictions/versions/'+s+'.json';
const body=record=>JSON.stringify(ctx.predictionVersionBody(record));
const old={filmId:'alien',predictedRating:3,probability4Plus:.4,confidence:'low',matchSignals:['a'],mainRisk:'r',moodLabels:['m','n'],generatedAt:'2026-10-01T10:00:00.000Z',tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f1',fingerprintSchemaVersion:1,predictionPromptVersion:1,replacedAt:'2026-10-10T10:00:00.000Z'};
const mid={filmId:'alien',predictedRating:3.5,probability4Plus:.5,confidence:'medium',matchSignals:['b'],mainRisk:'r2',moodLabels:['m','n'],generatedAt:'2026-10-10T10:00:00.000Z',tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f2',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,runId:'run-a',trigger:'scheduled'};
const midSha=sha(body(mid));Object.assign(mid,{r2Key:versionKey('alien',midSha),contentSha256:midSha});set(mid.r2Key,body(mid));mid.replacedAt='2026-10-20T10:00:00.000Z';
const cur={filmId:'alien',predictedRating:4,probability4Plus:.7,confidence:'high',matchSignals:['c'],mainRisk:'r3',moodLabels:['m','n'],generatedAt:'2026-10-20T10:00:00.000Z',tasteProfileVersion:2,tasteProfileHash:'p2',fingerprintHash:'f2',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,runId:'run-b',trigger:'manual'};
const curSha=sha(body(cur));Object.assign(cur,{r2Key:versionKey('alien',curSha),contentSha256:curSha});set(cur.r2Key,'{"tampered":true}');
set('enrichment/films/alien/predictions.json',{current:cur,history:[old,mid]});
set('letterboxd/facts/links.json',{'letterboxd:alien':'tmdb-348','tmdb:348':'tmdb-348'});
const t=m=>new Date(Date.UTC(2026,9,15,10,m)).toISOString();
set('letterboxd/facts/films/tmdb-348.json',{schemaVersion:1,factKey:'tmdb-348',links:{letterboxd:'alien',tmdb:'348'},redirectTo:null,migrating:null,
 rating:{value:4.5,observedAt:t(30),source:'owner',sourceRef:null,observationId:'o3',replaced:null},
 ratingHistory:[
  {kind:'first_observed',recordedAt:t(1),value:4,observedAt:'2026-10-01T00:00:00.000Z',source:'letterboxd_export',sourceRef:'x',observationId:'o1',previous:null},
  {kind:'changed',recordedAt:t(2),value:3,observedAt:t(2),source:'letterboxd_film_page',sourceRef:'p',observationId:'o2',previous:{value:4,observedAt:'2026-10-01T00:00:00.000Z',source:'letterboxd_export',observationId:'o1'}},
  {kind:'rolled_back',recordedAt:t(3),at:t(3),observationId:'o2',restored:{value:4,observedAt:'2026-10-01T00:00:00.000Z',source:'letterboxd_export',observationId:'o1'}},
  {kind:'changed',recordedAt:t(4),value:3,observedAt:t(2),source:'letterboxd_film_page',sourceRef:'p',observationId:'o2',previous:{value:4,observedAt:'2026-10-01T00:00:00.000Z',source:'letterboxd_export',observationId:'o1'}},
  {kind:'changed',recordedAt:t(30),value:4.5,observedAt:t(30),source:'owner',sourceRef:null,observationId:'o3',previous:{value:3,observedAt:t(2),source:'letterboxd_film_page',observationId:'o2'}}]});
set('enrichment/diagnostics/rating-observations.json',[
 {filmId:'alien',before:null,after:4,observedAt:'2026-10-08T15:41:00.000Z',source:'letterboxd_public_films',generationId:'g1'},
 {filmId:'tmdb_348',before:4,after:4.5,observedAt:'2026-10-09T15:41:00.000Z',source:'letterboxd_member_film',sourceUrl:'https://letterboxd.com/tester/film/alien/'},
 {filmId:'someone-else',before:null,after:1,observedAt:'2026-10-08T15:41:00.000Z',source:'letterboxd_public_films'}]);

const full=await history('filmId=alien');
{
 const {status,data}=full;assert.equal(status,200);
 const kinds=data.events.map(e=>e.type+(e.kind?':'+e.kind:'')+(e.position?':'+e.position:''));
 assert.deepEqual(kinds,['prediction:history','legacy_rating','legacy_rating','prediction:history','rating:first_observed','rating:changed','rating:rolled_back','rating:changed','rating:changed','prediction:current'],'one chronological list');
 const [first,,,second]=data.events,current=data.events[9];
 assert.equal(first.at,old.generatedAt);assert.equal(first.replacedAt,old.replacedAt);assert.equal(first.runId,null);assert.equal(first.fingerprintPromptVersion,null);
 assert.deepEqual(first.missingFields,['fingerprintPromptVersion','runId','trigger'],'unknown lineage stays unknown');
 assert.deepEqual(first.version,{status:'none',r2Key:null,contentSha256:null});
 assert.equal(second.version.status,'linked');assert.equal(second.runId,'run-a');assert.equal(second.trigger,'scheduled');assert.deepEqual(second.matchSignals,['b'],'each version keeps its own rationale');
 assert.equal(current.position,'current');assert.equal(current.version.status,'mismatch');assert.equal(data.partial,true,'a broken immutable object makes the answer partial');
 assert.equal(data.current.prediction.matchesCurrentProfile,true);assert.equal(data.current.prediction.contentSha256,curSha);
 const legacy=data.events.filter(e=>e.type==='legacy_rating');
 assert.equal(legacy.length,2,'both ids of the film, never another film');assert.equal(legacy[1].after,4.5);assert.equal(JSON.stringify(legacy).includes('tester'),false,'no account URL is returned');
 const ratings=data.events.filter(e=>e.type==='rating');
 assert.equal(ratings.every(e=>e.watchedAt===null),true,'a rating observation never claims a watch date');
 assert.equal(ratings[0].observedAt,'2026-10-01T00:00:00.000Z');assert.equal(ratings[0].at,t(1),'ordered by when it was recorded');
 assert.notEqual(ratings[1].identity,ratings[3].identity,'a re-application is a separate event');
 assert.equal(ratings[2].restored.value,4);assert.equal(ratings[2].value,null);
 assert.deepEqual(data.current.rating,{value:4.5,observedAt:t(30),source:'owner',observationId:'o3',watchedAt:null});
 assert.deepEqual(data.notes,['prediction_lineage_unknown','first_observed_is_not_a_rating_date','diary_absence_is_not_unwatched','diary_history_missing']);
 assert.deepEqual(data.snapshot.sources.diary.link,{status:'linked',lid:'alien',via:'fact_record+requested_id',candidates:['alien']});
 assert.equal(data.snapshot.sources.facts.factKey,'tmdb-348');assert.deepEqual(data.snapshot.profile,{version:2,profileHash:'p2'});
}
// The same film through its TMDB id: the same fact record and legacy entries (no predictions are stored under that id).
{
 const {data}=await history('filmId=tmdb_348');
 assert.equal(data.events.filter(e=>e.type==='prediction').length,0);assert.equal(data.events.filter(e=>e.type==='rating').length,5);assert.equal(data.events.filter(e=>e.type==='legacy_rating').length,2);
}
// Idempotent reads: everything but readAt is identical.
{
 const again=await history('filmId=alien');const strip=d=>({...d,readAt:null});
 assert.deepEqual(strip(again.data),strip(full.data));
}
// Paging: a cursor continues the same list; a change of a source in between is refused, never mixed.
{
 const one=await history('filmId=alien&limit=4');
 assert.equal(one.data.events.length,4);assert.equal(one.data.page.total,10);assert.match(one.data.page.nextCursor,/^4\.[0-9a-f]{16}$/);
 const two=await history('filmId=alien&limit=4&cursor='+one.data.page.nextCursor);
 assert.deepEqual(two.data.events.map(e=>e.identity),full.data.events.slice(4,8).map(e=>e.identity));
 const last=await history('filmId=alien&limit=4&cursor='+two.data.page.nextCursor);
 assert.equal(last.data.events.length,2);assert.equal(last.data.page.nextCursor,null);
 set('enrichment/films/alien/predictions.json',{current:cur,history:[old,mid]});
 const stale=await history('filmId=alien&limit=4&cursor='+one.data.page.nextCursor);
 assert.equal(stale.status,409);assert.equal(stale.data.error,'history_changed');
}
// Ties: a prediction and a rating at the same instant are ordered prediction first, then by identity; undated events go last.
{
 set('enrichment/films/tie/predictions.json',{current:{filmId:'tie',predictedRating:2,generatedAt:t(5)},history:[{filmId:'tie',predictedRating:1}]});
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'letterboxd:tie':'lb-tie'});
 set('letterboxd/facts/films/lb-tie.json',{schemaVersion:1,factKey:'lb-tie',links:{letterboxd:'tie',tmdb:null},rating:{value:2,observedAt:t(5),source:'owner',observationId:'q'},ratingHistory:[{kind:'first_observed',recordedAt:t(5),value:2,observedAt:t(5),source:'owner',observationId:'q',previous:null}]});
 const {data}=await history('filmId=tie');
 assert.deepEqual(data.events.map(e=>e.type+':'+(e.position||e.kind)),['prediction:current','rating:first_observed','prediction:history']);
 assert.equal(data.events[2].at,null);assert.ok(data.notes.includes('prediction_without_time'));
}
// A record without history but with a current rating says so; a redirected record is followed; an unreadable bundle is partial.
{
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'letterboxd:moved':'lb-moved'});
 set('letterboxd/facts/films/lb-moved.json',{schemaVersion:1,factKey:'lb-moved',links:{letterboxd:'moved',tmdb:null},redirectTo:'tmdb-9',migrating:null});
 set('letterboxd/facts/films/tmdb-9.json',{schemaVersion:1,factKey:'tmdb-9',links:{letterboxd:'moved',tmdb:'9'},rating:{value:3,observedAt:t(9),source:'letterboxd_export',observationId:'z'}});
 set('enrichment/films/moved/predictions.json','{not json');
 const {data}=await history('filmId=moved');
 assert.equal(data.snapshot.sources.facts.factKey,'tmdb-9');assert.equal(data.current.rating.value,3);assert.deepEqual(data.events,[]);
 assert.ok(data.notes.includes('rating_history_starts_after_current_value'));
 assert.equal(data.snapshot.sources.predictions.status,'unreadable');assert.equal(data.partial,true);
}
// During a convergence the overlay of source and target is read, both histories once.
{
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'letterboxd:conv':'lb-conv'});
 set('letterboxd/facts/films/lb-conv.json',{schemaVersion:1,factKey:'lb-conv',links:{letterboxd:'conv',tmdb:null},migrating:{to:'tmdb-77',token:'k'},rating:{value:2,observedAt:t(1),source:'owner',observationId:'s'},ratingHistory:[{kind:'first_observed',recordedAt:t(1),value:2,observedAt:t(1),source:'owner',observationId:'s',previous:null}]});
 set('letterboxd/facts/films/tmdb-77.json',{schemaVersion:1,factKey:'tmdb-77',links:{letterboxd:null,tmdb:'77'},rating:{value:4,observedAt:t(8),source:'owner',observationId:'u'},ratingHistory:[{kind:'first_observed',recordedAt:t(8),value:4,observedAt:t(8),source:'owner',observationId:'u',previous:null}]});
 const {data}=await history('filmId=conv');
 assert.deepEqual(data.events.map(e=>e.observationId),['s','u']);assert.equal(data.current.rating.value,4);
}
// A missing Diary history keeps the cursor of the three earlier sources: digest over bundle, fact record and legacy log only.
{
 const one=await history('filmId=alien&limit=4');
 const parts=['enrichment/films/alien/predictions.json','letterboxd/facts/films/tmdb-348.json','enrichment/diagnostics/rating-observations.json'].map(key=>etags.get(key)).join('|');
 assert.equal(one.data.page.nextCursor,'4.'+sha(parts).slice(0,16));
}

// Diary viewings. Film `dia` (lid) with TMDB 501: predictions, a rating observation and its Diary entries, plus entries of
// another lid with the same slug and an unresolved entry with that slug, which never join this film.
{
 const d=(day,h=10)=>'2026-09-'+String(day).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':00:00.000Z';
 set('enrichment/films/dia/predictions.json',{current:{filmId:'dia',predictedRating:4,matchSignals:['now'],generatedAt:d(20)},history:[{filmId:'dia',predictedRating:3,matchSignals:['then'],generatedAt:d(1),replacedAt:d(20)}]});
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'letterboxd:dia':'tmdb-501','tmdb:501':'tmdb-501'});
 set('letterboxd/facts/films/tmdb-501.json',{schemaVersion:1,factKey:'tmdb-501',links:{letterboxd:'dia',tmdb:'501'},rating:{value:4.5,observedAt:d(6),source:'letterboxd_export',observationId:'r1'},
  ratingHistory:[{kind:'first_observed',recordedAt:d(6),value:4.5,observedAt:d(6),source:'letterboxd_export',observationId:'r1',previous:null}]});
 const entry=(key,fields)=>({key,source:'letterboxd_diary',identity:{type:'letterboxd_lid',value:'dia'},aliases:[{type:'letterboxd_slug',value:'dia-film',firstObservedAt:d(28)}],firstObservedAt:d(28),observedAt:d(29),page:1,changes:[],...fields});
 const entries={
  'viewing:111':entry('viewing:111',{keyBasis:'viewing_id',viewingId:'111',watchedDate:'2026-09-05',viewings:1,viewingsCertain:true,ratingAtEntry:4,ratingsAtEntry:[4],rewatch:false,changes:[{field:'ratingAtEntry',from:3,to:4,observedAt:d(29)}]}),
  'day:lid:dia|2026-09-20':entry('day:lid:dia|2026-09-20',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-20',viewings:2,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[3.5,4],rewatch:true,rewatchRows:1,rewatchUnknownRows:0}),
  'viewing:222':entry('viewing:222',{keyBasis:'viewing_id',viewingId:'222',watchedDate:'2026-09-20',viewings:1,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[null],rewatch:'unknown',aliases:[{type:'letterboxd_slug',value:'dia-film'}]}),
  'day:lid:dia|2026-09-25':entry('day:lid:dia|2026-09-25',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-25',viewings:1,viewingsCertain:false,ratingAtEntry:5,ratingsAtEntry:[5],rewatch:'unknown',rewatchRows:0,rewatchUnknownRows:1}),
  'viewing:333':entry('viewing:333',{keyBasis:'viewing_id',viewingId:'333',watchedDate:null,viewings:1,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[null],rewatch:false}),
  'day:lid:other|2026-09-07':{...entry('day:lid:other|2026-09-07',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-07',viewings:1,viewingsCertain:true,ratingAtEntry:1,ratingsAtEntry:[1],rewatch:false,rewatchRows:0,rewatchUnknownRows:0}),identity:{type:'letterboxd_lid',value:'other'}},
  'day:slug:dia-film|2026-09-08':{...entry('day:slug:dia-film|2026-09-08',{keyBasis:'identity_date',viewingId:null,watchedDate:'2026-09-08',viewings:1,viewingsCertain:true,ratingAtEntry:1,ratingsAtEntry:[1],rewatch:false,rewatchRows:0,rewatchUnknownRows:0}),identity:null}};
 set('letterboxd/diary/history.json',{schemaVersion:1,entries});
 set('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'partial',lastSuccessAt:d(29),stopReason:'page_budget',coverage:{newestWatchedDate:'2026-09-25',oldestWatchedDate:'2026-01-01',reachedEnd:false},resumePage:4});

 const {status,data}=await history('filmId=dia');assert.equal(status,200);
 assert.deepEqual(data.events.map(e=>e.type+':'+(e.sourceKey||e.position||e.kind)),
  ['prediction:history','diary_viewing:viewing:111','rating:first_observed','prediction:current','diary_viewing:day:lid:dia|2026-09-20','diary_viewing:viewing:222','diary_viewing:day:lid:dia|2026-09-25','diary_viewing:viewing:333'],
  'prediction, then the viewing, then the rating observation; a day-only date after every instant of that date; an undated entry last');
 const viewings=data.events.filter(e=>e.type==='diary_viewing');
 assert.equal(viewings.some(e=>['day:lid:other|2026-09-07','day:slug:dia-film|2026-09-08'].includes(e.sourceKey)),false,'never linked by slug, never another lid');
 const [v111,day20,v222,day25,v333]=viewings;
 assert.deepEqual(v111,{type:'diary_viewing',at:'2026-09-05',atPrecision:'day',watchedDate:'2026-09-05',sourceKey:'viewing:111',keyBasis:'viewing_id',viewingId:'111',viewings:1,viewingsCertain:true,
  ratingAtEntry:4,ratingsAtEntry:[4],rewatch:false,rewatchRows:null,rewatchUnknownRows:null,lid:'dia',linkedVia:'fact_record+requested_id',slugs:[{value:'dia-film',firstObservedAt:d(28)}],
  firstObservedAt:d(28),observedAt:d(29),page:1,changes:[{field:'ratingAtEntry',from:3,to:4,observedAt:d(29)}],identity:'diary|viewing:111'},'a re-assessed entry keeps its change, and its watched date is not its observation time');
 assert.equal(day20.viewings,2,'two viewings of one day stay one event with their count');assert.deepEqual(day20.ratingsAtEntry,[3.5,4]);assert.equal(day20.rewatch,true);assert.equal(day20.rewatchRows,1);
 assert.equal(v222.rewatch,'unknown');assert.deepEqual(v222.slugs,[{value:'dia-film',firstObservedAt:null}],'an older alias without firstObservedAt says null');
 assert.equal(day25.viewingsCertain,false);assert.equal(v333.at,null);assert.equal(v333.watchedDate,null);
 assert.deepEqual(data.current.rating,{value:4.5,observedAt:d(6),source:'letterboxd_export',observationId:'r1',watchedAt:null},'a rating at a Diary entry never replaces the rating observation');
 assert.deepEqual(data.current.diary,{lid:'dia',viewingCount:6,viewingCountExact:false,lastWatchedAt:'2026-09-25',rewatches:1,rewatchesExact:false});
 assert.deepEqual(data.notes,['prediction_lineage_unknown','first_observed_is_not_a_rating_date','diary_viewings_lower_bound','diary_rewatch_unknown','diary_entry_without_date','diary_same_day_order_unknown','diary_entries_may_overlap','diary_absence_is_not_unwatched','diary_coverage_partial']);
 assert.deepEqual(data.snapshot.sources.diary,{status:'recorded',link:{status:'linked',lid:'dia',via:'fact_record+requested_id',candidates:['dia']},unresolvedEntries:1,
  state:{lastOutcome:'partial',lastSuccessAt:d(29),coverage:{newestWatchedDate:'2026-09-25',oldestWatchedDate:'2026-01-01',reachedEnd:false},resumePage:4}});
 assert.equal(data.partial,false);

 // Through the TMDB id the fact record supplies the lid; the same Diary events, linked by the fact record alone.
 const byTmdb=await history('filmId=tmdb_501');
 assert.deepEqual(byTmdb.data.events.filter(e=>e.type==='diary_viewing').map(e=>e.identity),viewings.map(e=>e.identity));
 assert.equal(byTmdb.data.snapshot.sources.diary.link.via,'fact_record');assert.equal(byTmdb.data.events.filter(e=>e.type==='prediction').length,0);

 // A TMDB id without a fact record has no lid: the Diary stays unlinked, nothing is guessed.
 const unlinked=await history('filmId=tmdb_999');
 assert.deepEqual(unlinked.data.events,[]);assert.equal(unlinked.data.snapshot.sources.diary.link.status,'unlinked');assert.ok(unlinked.data.notes.includes('diary_unlinked'));assert.equal(unlinked.data.current.diary,null);

 // The requested lid and the fact record's lid disagree: neither Diary is returned.
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'letterboxd:dia-old':'tmdb-501'});
 const disagree=await history('filmId=dia-old');
 assert.equal(disagree.data.events.some(e=>e.type==='diary_viewing'),false);assert.deepEqual(disagree.data.snapshot.sources.diary.link,{status:'ambiguous',lid:null,via:null,candidates:['dia','dia-old']});
 assert.ok(disagree.data.notes.includes('diary_identity_disagreement'));assert.equal(disagree.data.current.diary,null);
 assert.equal(disagree.data.events.filter(e=>e.type==='rating').length,1,'the rating history of the fact record is still returned');

 // During a convergence whose two records name different lids, the Diary is withheld as well.
 set('letterboxd/facts/links.json',{...JSON.parse(records.get('letterboxd/facts/links.json')),'tmdb:600':'lb-split'});
 set('letterboxd/facts/films/lb-split.json',{schemaVersion:1,factKey:'lb-split',links:{letterboxd:'dia',tmdb:'600'},migrating:{to:'tmdb-600',token:'k'}});
 set('letterboxd/facts/films/tmdb-600.json',{schemaVersion:1,factKey:'tmdb-600',links:{letterboxd:'other',tmdb:'600'}});
 assert.equal((await history('filmId=tmdb_600')).data.snapshot.sources.diary.link.status,'ambiguous');

 // Paging: a page boundary inside the Diary events; re-reading the same Diary (a new object version) refuses the old
 // cursor and a fresh read has the same events, no duplicates.
 const one=await history('filmId=dia&limit=5');
 const two=await history('filmId=dia&limit=5&cursor='+one.data.page.nextCursor);
 assert.deepEqual([...one.data.events,...two.data.events].map(e=>e.identity),data.events.map(e=>e.identity));
 set('letterboxd/diary/history.json',{schemaVersion:1,entries});
 const stale=await history('filmId=dia&limit=5&cursor='+one.data.page.nextCursor);assert.equal(stale.status,409);assert.equal(stale.data.error,'history_changed');
 const reread=await history('filmId=dia');assert.deepEqual(reread.data.events.map(e=>e.identity),data.events.map(e=>e.identity));

 // A complete Diary coverage drops the partial-coverage note; an unreadable Diary history makes the answer partial.
 set('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'complete',coverage:{newestWatchedDate:'2026-09-25',oldestWatchedDate:'2010-01-01',reachedEnd:true},resumePage:null});
 assert.equal((await history('filmId=dia')).data.notes.includes('diary_coverage_partial'),false);
 set('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'recent_window',stopReason:'recent_window_only',coverage:{newestWatchedDate:'2026-09-25',oldestWatchedDate:'2010-01-01',reachedEnd:false,window:'recent'},resumePage:4});
 assert.equal((await history('filmId=dia')).data.notes.includes('diary_coverage_partial'),true,'a recent window stays incomplete coverage even with a stored resume page');
 set('letterboxd/diary/history.json','{broken');
 const broken=await history('filmId=dia');
 assert.equal(broken.data.partial,true);assert.equal(broken.data.snapshot.sources.diary.status,'unreadable');assert.ok(broken.data.notes.includes('diary_history_unreadable'));
 assert.equal(broken.data.events.some(e=>e.type==='diary_viewing'),false);assert.equal(broken.data.current.diary,null);
}
// Prediction quality orders the same events and is unchanged by the Diary sort key: its own events carry instants only.
assert.equal(ctx.compareHistoryEvents({type:'rating',at:'2026-09-20T23:59:59.999Z',identity:'a'},{type:'diary_viewing',at:'2026-09-20',atPrecision:'day',identity:'b'}),-1);
assert.equal(ctx.compareHistoryEvents({type:'diary_viewing',at:'2026-09-20',atPrecision:'day',identity:'b'},{type:'prediction',at:'2026-09-21T00:00:00.000Z',identity:'a'}),-1);

// AIR-475: the history of a retained canonical Film asked with its permanent tmdb_<n> id while the versions lie under its trusted Letterboxd lid. The bridge is the D1 identity (open
// marker only): never a title, year or slug; a conflict, a redirect, a held marker and a missing claim each say what they are. Local stand-ins only; nothing here writes.
{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-film-history-'));
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
 const base=path.join(root,'base.sqlite');sqlite(base,names.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 // ADR 0162: a ratings marker that is not d1/open is refused. Sections that test the history itself use a database without the ratings
 // tables (the domain's local stand-in: not installed, RATINGS_DB_REQUIRED unset), so the Diary comes from the R2 objects; a fixture that
 // names the ratings tables gets the full schema.
 // ADR 0162: a ratings or prediction marker that is not d1 is refused, so a fixture that does not exercise a domain stands for it uninstalled (its tables dropped); one that does supplies its own d1 rows.
 const DROP_RATINGS='DROP TABLE ratings_view;DROP TABLE ratings_document;DROP TABLE ratings_domain_cas;DROP TABLE ratings_domain_authority;';
 const DROP_PREDICTION=['prediction_domain_intent','prediction_run','prediction_lease','prediction_queue','prediction_lineage','prediction_pointer','prediction_fingerprint','prediction_profile','prediction_domain_cas','prediction_domain_authority'].map(name=>'DROP TABLE '+name+';').join('');
 const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
 const MARKER={prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
 MARKER.open=MARKER.prepared+"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";MARKER.held=MARKER.open+"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
 let n=0;const T='2026-11-01T00:00:00.000Z';
 const film=(id,tmdb)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('${id}',1,${tmdb?`'tmdb:${tmdb}'`:'NULL'},'Orig ${id}','${T}');`;
 const claim=(filmId,scheme,value,trusted=1,conflicting=0)=>`INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('${filmId}','${scheme}','${value}',${trusted},${conflicting});`;
 // film:tmdb:348 owns tmdb 348 and the lid `alien`; film:tmdb:4600 owns tmdb 600 and lid `lone4600`; tmdb 4700 is claimed twice (a conflict); tmdb 800 is a redirect source; 900 has no lid.
 const SEED=film('film:tmdb:348',348)+claim('film:tmdb:348','tmdb','348')+claim('film:tmdb:348','letterboxd','alien')
  +film('film:tmdb:4600',4600)+claim('film:tmdb:4600','tmdb','4600')+claim('film:tmdb:4600','letterboxd','lone4600')
  +film('film:tmdb:4700',4700)+film('film:other',null)+claim('film:tmdb:4700','tmdb','4700')+claim('film:other','tmdb','4700',0,0)+claim('film:tmdb:4700','letterboxd','lid4700')
  +film('film:tmdb:4800',4800)+claim('film:tmdb:4800','tmdb','4800')+claim('film:tmdb:4800','letterboxd','lid4800')+film('film:tmdb:4801',4801)+`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:tmdb:4800','film:tmdb:4801','${T}');`
  +film('film:tmdb:4900',4900)+claim('film:tmdb:4900','tmdb','4900')
  +film('film:solo4990',null)+claim('film:solo4990','letterboxd','solo4990')
  +film('film:tmdb:4950',4950)+claim('film:tmdb:4950','tmdb','4950')+claim('film:tmdb:4950','letterboxd','lid4950')+claim('film:tmdb:4950','letterboxd','lid4951',0,0);
 const database=(state='open',extra='')=>{const file=path.join(root,'h-'+(n++)+'.sqlite');fs.copyFileSync(base,file);sqlite(file,(/ratings_/.test(extra)?'':DROP_RATINGS)+(/prediction_/.test(extra)?'':DROP_PREDICTION)+SEED+(MARKER[state]||'')+extra);return file;};
 const seen=[];
 const envFor=(state,extra,onQuery)=>({...env,DB:d1Standin(database(state,extra),{onQuery:async text=>{seen.push(text);if(onQuery)await onQuery(text);}})});
 const stored=(id,gen,rating)=>{const record={filmId:id,predictedRating:rating,probability4Plus:.6,confidence:'high',matchSignals:['s'],mainRisk:'r',moodLabels:['m','n'],generatedAt:gen,tasteProfileVersion:2,tasteProfileHash:'p2',fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,runId:'run-'+id+gen,trigger:'scheduled'};const digest=sha(body(record));return {...record,r2Key:versionKey(id,digest),contentSha256:digest};};
 // lid `lone4600`: a historical version (linked object) and a current one; tmdb_4600 holds a second historical version of its own; a bundle under `slug-4600` (not bridged) holds a decoy.
 const h1=stored('lone4600','2026-10-01T10:00:00.000Z',3),c1=stored('lone4600','2026-10-20T10:00:00.000Z',4.5),h2=stored('tmdb_4600','2026-10-10T10:00:00.000Z',3.5);
 set(h1.r2Key,body(h1));set(c1.r2Key,body(c1));set(h2.r2Key,body(h2));
 set('enrichment/films/lone4600/predictions.json',{current:c1,history:[{...h1,replacedAt:'2026-10-20T10:00:00.000Z'}]});
 set('enrichment/films/tmdb_4600/predictions.json',{current:null,history:[{...h2,replacedAt:'2026-10-12T10:00:00.000Z'}]});
 set('enrichment/films/slug-4600/predictions.json',{current:{filmId:'slug-4600',predictedRating:1,generatedAt:'2026-10-30T10:00:00.000Z'},history:[]});
 set('enrichment/films/lid4700/predictions.json',{current:{filmId:'lid4700',predictedRating:2,generatedAt:'2026-10-30T10:00:00.000Z'},history:[]});
 set('enrichment/films/lid4800/predictions.json',{current:{filmId:'lid4800',predictedRating:2,generatedAt:'2026-10-30T10:00:00.000Z'},history:[]});
 const kinds=data=>data.events.filter(e=>e.type==='prediction').map(e=>[e.identity,e.storageId??null,e.version.status]);
 const EXPECTED=[['lone4600|prediction|history|0','lone4600','linked'],['prediction|history|0',null,'linked'],['lone4600|prediction|current|0','lone4600','linked']];
 // 1. The permanent tmdb id reaches the versions stored under the trusted lid, every version is checked against the id it lies under, nothing is written.
 for(const key of ['letterboxd/diary/history.json','letterboxd/diary/state.json']){records.delete(key);etags.delete(key);}
 let e=envFor('open');seen.length=0;
 let {status,data}=await history('filmId=tmdb_4600',e);
 assert.equal(status,200);assert.deepEqual(kinds(data),EXPECTED,'one chronology over both storage ids, once each');
 assert.deepEqual(data.snapshot.identity,{state:'ok',storageIds:['lone4600']},'the bridge is said');assert.deepEqual(data.snapshot.sources.predictions,{status:'recorded',bridged:[{id:'lone4600',status:'recorded'}]});
 assert.equal(data.current.prediction.storageId,'lone4600');assert.equal(data.current.prediction.contentSha256,c1.contentSha256,'the current prediction is the stored one');assert.equal(data.partial,false);
 assert.equal(data.events.filter(e=>e.type==='prediction').some(e=>/slug|lid4700|lid4800/.test(e.identity)),false,'no title, slug or foreign lid is matched');
 assert.ok(seen.length>0&&seen.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1');assert.ok(seen.length>0,'D1 was read');/* the prediction authority reads its marker in one read-only batch: the SELECT-only assertion above covers every statement of it */
 // 2. The same Film through its lid reaches the tmdb_<n> bundle; it is the same chronology.
 ({status,data}=await history('filmId=lone4600',envFor('open')));assert.equal(status,200);
 assert.deepEqual(kinds(data).map(([id,,v])=>[id.replace(/^lone4600\|/,'').replace(/^tmdb_4600\|/,'t|'),v]),[['prediction|history|0','linked'],['t|prediction|history|0','linked'],['prediction|current|0','linked']],'the lid keeps its own identities, the tmdb bundle joins prefixed');
 assert.deepEqual(data.snapshot.identity,{state:'ok',storageIds:['tmdb_4600']});assert.equal(data.current.prediction.storageId,undefined,'the requested id holds the current prediction');
 // 3. A bridged version that does not verify says so and makes the answer partial.
 set(c1.r2Key,'{"tampered":true}');({data}=await history('filmId=tmdb_4600',envFor('open')));assert.equal(data.events.find(x=>x.storageId==='lone4600'&&x.position==='current').version.status,'mismatch');assert.equal(data.partial,true);set(c1.r2Key,body(c1));
 // 4. No claim, no bridge: absent says nothing more, a conflict or a redirect says so, the requested id is read alone.
 ({status,data}=await history('filmId=tmdb_4900',envFor('open')));assert.equal(status,200);assert.deepEqual([data.snapshot.identity.state,data.snapshot.identity.storageIds,data.events],['ok',[],[]],'a Film with only a tmdb claim has nothing to bridge');
 ({data}=await history('filmId=tmdb_4999',envFor('open')));assert.deepEqual([data.snapshot.identity.state,data.events],['absent',[]],'no claim at all');
 ({data}=await history('filmId=tmdb_4700',envFor('open')));assert.equal(data.snapshot.identity.state,'conflict');assert.ok(data.notes.includes('identity_bridge_conflict'));assert.deepEqual(data.events,[],'a contested identity bridges nothing');
 ({data}=await history('filmId=lid4700',envFor('open')));assert.equal(data.snapshot.identity.state,'conflict','the contested tmdb claim of the Film also holds its lid');
 ({data}=await history('filmId=tmdb_4800',envFor('open')));assert.equal(data.snapshot.identity.state,'retired');assert.ok(data.notes.includes('identity_bridge_retired'));assert.deepEqual(data.events,[]);
 ({data}=await history('filmId=tmdb_4950',envFor('open')));assert.equal(data.snapshot.identity.state,'conflict','an untrusted second lid holds the bridge');
 // 5. Below open nothing is served (ADR 0162): prepared, held and unreadable fail closed where the bridge is needed.
 ({status,data}=await history('filmId=tmdb_4600',envFor('prepared')));assert.deepEqual([status,data.error,data.reason],[503,'identity_unavailable','film_person_unavailable'],'prepared is not served (ADR 0162): refused, no frozen fallback');
 ({status,data}=await history('filmId=tmdb_4600',envFor('held')));assert.deepEqual([status,data.error,data.reason],[503,'identity_unavailable','film_person_held'],'held fails closed for a canonical permalink');
 ({status,data}=await history('filmId=lone4600',envFor('held')));assert.equal(status,200,'a lid request still reads its own bundle');assert.equal(data.partial,true);assert.ok(data.notes.includes('identity_bridge_unavailable'));assert.deepEqual(kinds(data).map(x=>x[1]),[null,null],'only its own versions');
 ({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(database('open'),{rewrite:sql=>/FROM film_external_id/.test(sql)?'SELECT nope FROM nowhere':sql})}));assert.deepEqual([status,data.reason],[503,'canonical_read_unavailable'],'a failed identity read is unavailable, never an empty history');
 // 6. A marker that moves during the bridge read refuses the answer.
 {let moved=false;const moving=database('open');({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(moving,{onQuery:async text=>{if(!moved&&/FROM film_external_id/.test(text)){moved=true;sqlite(moving,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}}})}));assert.deepEqual([status,data.reason],[503,'film_person_generation_moved']);}
 // 7. Paging over the merged list stays consistent and the cursor digest covers the bridged bundle.
 {const one=await history('filmId=tmdb_4600&limit=2',envFor('open'));assert.equal(one.data.page.total,3);assert.match(one.data.page.nextCursor,/^2\.[0-9a-f]{16}$/);const two=await history('filmId=tmdb_4600&limit=2&cursor='+one.data.page.nextCursor,envFor('open'));assert.deepEqual([...one.data.events,...two.data.events].map(x=>x.identity),EXPECTED.map(x=>x[0]));
  set('enrichment/films/lone4600/predictions.json',{current:c1,history:[]});assert.equal((await history('filmId=tmdb_4600&limit=2&cursor='+one.data.page.nextCursor,envFor('open'))).status,409,'a change of the bridged bundle refuses the old cursor');}

 // 8. (review P1-2) The identity fence reaches the end of the response: a marker that moves AFTER the bridge, while the bundles, facts, Diary and immutable objects are read, refuses a canonical
 // permalink and any answer that joined bridged ids; a lid answer that joined nothing keeps its partial policy.
 {
  const trapped=(when,query)=>{let moved=false;const file=database('open');const db=d1Standin(file);
   return {...env,DB:db,BUCKET:{...bucket,async get(key){if(!moved&&when(key)){moved=true;sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1");}return bucket.get(key);}}};};
  const diary=key=>key==='letterboxd/diary/state.json'||key==='enrichment/diagnostics/rating-observations.json';
  ({status,data}=await history('filmId=tmdb_4600',trapped(diary)));assert.deepEqual([status,data.error,data.reason],[503,'identity_unavailable','film_person_generation_moved'],'a permalink whose marker moved after the bridge fails closed');
  ({status,data}=await history('filmId=lone4600',trapped(diary)));assert.deepEqual([status,data.error],[503,'identity_unavailable'],'a lid answer that joined bridged ids is refused too');
  ({status,data}=await history('filmId=solo4990',trapped(diary)));assert.equal(status,200,'a lid answer that joined nothing keeps its partial policy');assert.deepEqual([data.partial,data.snapshot.identity.state,data.events],[true,'unavailable',[]]);assert.ok(data.notes.includes('identity_bridge_unavailable'));
  ({status,data}=await history('filmId=solo4990',envFor('open')));assert.deepEqual([status,data.snapshot.identity,data.partial],[200,{state:'ok',storageIds:[]},false],'unmoved: the lid-only Film has nothing to bridge and is complete');
 }
 // 9. (review P1-1) With prediction_domain_authority d1 the mutable bundles come from the D1 pointer and lineage, never from the best-effort R2 mirror: a newer D1 current that the mirror
 // lacks is returned, a mirror-only version is not invented, and an unreadable D1 domain is a 503, not a fall back.
 {
  const c2=stored('lone4600','2026-11-01T10:00:00.000Z',5);set(c2.r2Key,body(c2));
  const display=record=>JSON.stringify(record);
  const rows=`UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;
INSERT INTO prediction_pointer (film_id,taste_profile_version,taste_profile_hash,fingerprint_hash,fingerprint_schema_version,prediction_prompt_version,predicted_rating,r2_key,content_sha256,updated_at,display_json) VALUES ('lone4600',2,'p2','f',1,1,5,'${c2.r2Key}','${c2.contentSha256}','2026-11-01T10:00:00.000Z','${display(c2)}');
INSERT INTO prediction_lineage (film_id,replaced_at,predicted_rating,taste_profile_version,fingerprint_hash,r2_key,content_sha256,display_json) VALUES ('lone4600','2026-10-20T10:00:00.000Z',3,2,'f','${h1.r2Key}','${h1.contentSha256}','${display(h1)}'),('lone4600','2026-11-01T10:00:00.000Z',4.5,2,'f','${c1.r2Key}','${c1.contentSha256}','${display(c1)}'),('tmdb_4600','2026-10-12T10:00:00.000Z',3.5,2,'f','${h2.r2Key}','${h2.contentSha256}','${display(h2)}');`;
  // The R2 mirror of lone4600 is stale: it still says c1 is current.
  const mirror=records.get('enrichment/films/lone4600/predictions.json');
  const d1env=()=>{const file=database('open',rows);return {...env,DB:d1Standin(file)};};
  ({status,data}=await history('filmId=tmdb_4600',d1env()));assert.equal(status,200);
  const ids=data.events.filter(e=>e.type==='prediction').map(e=>[e.storageId??'own',e.position,e.predictedRating]);
  assert.deepEqual(ids,[['lone4600','history',3],['own','history',3.5],['lone4600','history',4.5],['lone4600','current',5]],'the D1 lineage and the newer D1 current, in order, not the stale mirror');
  assert.equal(data.current.prediction.storageId,'lone4600');assert.equal(data.current.prediction.contentSha256,c2.contentSha256);assert.equal(data.partial,false);
  assert.ok(data.snapshot.sources.predictions.bridged[0].status==='recorded');
  ({status,data}=await history('filmId=lone4600',d1env()));assert.equal(status,200);assert.equal(data.events.filter(e=>e.type==='prediction').length,4,'the lid asks the same D1 domain');
  // A Film whose D1 pointer and lineage are empty is missing, even if a stale mirror object exists.
  ({data}=await history('filmId=slug-4600',d1env()));assert.deepEqual([data.snapshot.sources.predictions.status,data.events.filter(e=>e.type==='prediction').length],['missing',0],'D1 is authoritative: a mirror-only bundle is not read');
  // An unreadable D1 prediction domain fails closed.
  {const file=database('open',rows);sqlite(file,'DROP TABLE prediction_lineage;');({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(file)}));assert.deepEqual([status,data.error,data.reason],[503,'prediction_unavailable','prediction_domain_unavailable']);}
  assert.ok(mirror,'the mirror object stayed untouched');
 }

 // 10. (production acceptance) The facts and the Diary are RatingsD1 documents: with ratings_domain_authority d1/open their D1 versions are the source, whatever stale R2 copies say. The film below has
 // its current rating, one rating change and three Diary viewings only in D1; R2 holds the frozen early versions (older Diary, no fact record). A held ratings domain is a refusal, never a stale R2 answer.
 {
  const d=(day,h=10)=>'2026-11-'+String(day).padStart(2,'0')+'T'+String(h).padStart(2,'0')+':00:00.000Z';
  const text=value=>JSON.stringify(value);
  const doc=(key,value)=>{const body=text(value),etag=sha(body);return `INSERT INTO ratings_document (key,part,body,etag,updated_at) VALUES ('${key}',0,'${body.replace(/'/g,"''")}','${etag}','${d(16)}');`;};
  const entry=(key,fields)=>({key,source:'letterboxd_diary',identity:{type:'letterboxd_lid',value:'lone4600'},aliases:[],firstObservedAt:d(10),observedAt:d(16),page:1,changes:[],...fields});
  const fact={schemaVersion:1,factKey:'tmdb-4600',links:{letterboxd:'lone4600',tmdb:'4600'},redirectTo:null,migrating:null,watched:true,rating:{value:4.5,observedAt:d(12),source:'owner',sourceRef:null,observationId:'d1-o2'},ratingHistory:[{kind:'first_observed',recordedAt:d(10),value:4,observedAt:d(10),source:'letterboxd_export',sourceRef:'x',observationId:'d1-o1',previous:null},{kind:'changed',recordedAt:d(12),value:4.5,observedAt:d(12),source:'owner',sourceRef:null,observationId:'d1-o2',previous:{value:4,observedAt:d(10),source:'letterboxd_export',observationId:'d1-o1'}}]};
  const entries={'viewing:9001':entry('viewing:9001',{keyBasis:'viewing_id',viewingId:'9001',watchedDate:'2026-11-10',viewings:1,viewingsCertain:true,ratingAtEntry:4,ratingsAtEntry:[4],rewatch:false}),'viewing:9002':entry('viewing:9002',{keyBasis:'viewing_id',viewingId:'9002',watchedDate:'2026-11-12',viewings:1,viewingsCertain:true,ratingAtEntry:4.5,ratingsAtEntry:[4.5],rewatch:true}),'viewing:9003':entry('viewing:9003',{keyBasis:'viewing_id',viewingId:'9003',watchedDate:'2026-11-15',viewings:1,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[null],rewatch:true})};
  const ratingsRows=`UPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;`+doc('letterboxd/facts/links.json',{'tmdb:4600':'tmdb-4600','letterboxd:lone4600':'tmdb-4600'})+doc('letterboxd/facts/films/tmdb-4600.json',fact)+doc('letterboxd/diary/history.json',{schemaVersion:1,entries})+doc('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'complete',lastSuccessAt:d(16),coverage:{newestWatchedDate:'2026-11-15',oldestWatchedDate:'2010-01-01',reachedEnd:true},resumePage:null});
  // The frozen R2 copies: an early Diary with one old viewing of this lid and a diary state of 3 Nov; no fact record, no links entry for 4600.
  set('letterboxd/diary/history.json',{schemaVersion:1,entries:{'viewing:1':entry('viewing:1',{keyBasis:'viewing_id',viewingId:'1',watchedDate:'2026-10-01',viewings:1,viewingsCertain:true,ratingAtEntry:null,ratingsAtEntry:[null],rewatch:false})}});
  set('letterboxd/diary/state.json',{schemaVersion:1,lastOutcome:'complete',lastSuccessAt:'2026-11-03T16:33:55.000Z',coverage:{newestWatchedDate:'2026-11-01',oldestWatchedDate:'2010-01-01',reachedEnd:true},resumePage:null});
  const ratingsEnv=()=>({...env,DB:d1Standin(database('open',ratingsRows))});
  ({status,data}=await history('filmId=tmdb_4600',ratingsEnv()));assert.equal(status,200);
  assert.deepEqual(data.events.filter(e=>e.type==='diary_viewing').map(e=>e.watchedDate),['2026-11-10','2026-11-12','2026-11-15'],'the three viewings of the D1 Diary, not the frozen R2 one');
  assert.deepEqual(data.events.filter(e=>e.type==='rating').map(e=>[e.kind,e.value]),[['first_observed',4],['changed',4.5]],'the rating observations of the D1 fact record');
  assert.deepEqual([data.current.rating.value,data.current.diary.viewingCount,data.snapshot.sources.diary.state.lastSuccessAt],[4.5,3,d(16)],'current rating, viewing count and the Diary run state come from D1');
  assert.equal(data.snapshot.sources.diary.link.lid,'lone4600');assert.equal(data.partial,false);assert.ok(!data.notes.includes('diary_coverage_partial'));
  // The digest of a D1 read is its document etag: a changed D1 document refuses the old cursor.
  {const one=await history('filmId=tmdb_4600&limit=2',ratingsEnv());assert.match(one.data.page.nextCursor,/^2\.[0-9a-f]{16}$/);
   const changed=database('open',ratingsRows+`UPDATE ratings_document SET etag='${'0'.repeat(64)}' WHERE key='letterboxd/diary/state.json';`);
   assert.notEqual((await history('filmId=tmdb_4600&limit=2',{...env,DB:d1Standin(changed)})).data?.page?.nextCursor??'x',one.data.page.nextCursor);}
  // The same film asked by its lid reads the same D1 documents.
  ({data}=await history('filmId=lone4600',ratingsEnv()));assert.equal(data.events.filter(e=>e.type==='diary_viewing').length,3);
  // A held ratings domain refuses; an unreadable one is a typed 503; neither falls back to the stale R2 Diary.
  {const file=database('open',ratingsRows+"UPDATE ratings_domain_authority SET cutover='held' WHERE id=1;");({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(file)}));assert.deepEqual([status,data.error,data.reason],[503,'ratings_unavailable','ratings_domain_not_authoritative']);}
  {const file=database('open',ratingsRows+"DROP TABLE ratings_view;");({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(file)}));assert.deepEqual([status,data.error],[503,'ratings_unavailable'],'a half-installed ratings domain fails closed');}
  // ADR 0162: a ratings marker left in mode r2 is refused too, never read from R2.
  {const file=database('open',"UPDATE ratings_domain_authority SET generation=0 WHERE id=1;");({status,data}=await history('filmId=tmdb_4600',{...env,DB:d1Standin(file)}));assert.deepEqual([status,data.error],[503,'ratings_unavailable'],'a ratings marker in mode r2 is refused');}
  // Where the domain is not installed (the local stand-in), the R2 objects are read exactly as before.
  ({data}=await history('filmId=lone4600',envFor('open')));assert.deepEqual(data.events.filter(e=>e.type==='diary_viewing').map(e=>e.watchedDate),['2026-10-01'],'ratings domain not installed: the R2 Diary is the source');
 }
}
console.log('Film history: validation, empty film, chronology, lineage gaps, version links, rationale per version, legacy log by both ids, no account URL, watchedAt unknown, rollback and re-apply, idempotent reads, paging and change refusal, ties, redirect, unreadable bundle, convergence overlay, Diary viewings by lid only (never slug), day-only ordering, day counts, lower bounds, unknown re-watch, undated entries, identity disagreement, Diary paging and change refusal, coverage and unreadable Diary passed');
