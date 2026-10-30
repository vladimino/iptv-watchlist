import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto,createHash} from 'node:crypto';

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
for(const file of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/migration-export.js','src/prediction-diagnostics.js','src/mcp.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={BUCKET:bucket,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};
const sha=text=>createHash('sha256').update(text).digest('hex');
async function history(query){puts=[];fetches=[];const response=await ctx.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/history?'+query),env,{waitUntil(){throw new Error('no background work');}});const data=await response.json();assert.deepEqual(puts,[],'no write on '+query);assert.deepEqual(fetches,[],'no outbound request on '+query);return {status:response.status,data:JSON.parse(JSON.stringify(data))};}

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
 assert.deepEqual(data.snapshot.sources,{predictions:{status:'missing'},facts:{status:'missing',factKey:null},legacyRatingLog:{status:'missing'}});
 assert.equal(data.current.prediction,null);assert.equal(data.current.rating,null);assert.equal(data.partial,false);
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
 assert.deepEqual(data.notes,['prediction_lineage_unknown','first_observed_is_not_a_rating_date']);
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
console.log('Film history: validation, empty film, chronology, lineage gaps, version links, rationale per version, legacy log by both ids, no account URL, watchedAt unknown, rollback and re-apply, idempotent reads, paging and change refusal, ties, redirect, unreadable bundle and convergence overlay passed');
