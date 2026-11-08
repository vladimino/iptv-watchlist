// AIR-359: the EPG event describes the generation that was actually published, once, whatever the retry history.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const WATCHLIST_HTML='<span class="js-watchlist-count">1</span><div data-component-class="LazyPoster" data-item-name="Heat (1995)" data-item-link="/film/heat-1995/" data-postered-identifier="{&quot;lid&quot;:&quot;film1&quot;}"></div>';
const FILM_HTML='<meta name="description" content="A crew plans a robbery."><span data-tmdb-id="1656"></span><script type="application/ld+json">{"name":"Heat","genre":"Crime","duration":"PT2H50M","director":{"name":"Michael Mann","sameAs":"https://letterboxd.com/director/michael-mann/"},"actor":[{"name":"Al Pacino","sameAs":"https://letterboxd.com/actor/al-pacino/"}]}</script>';
const FILMS_HTML='<span title="1&nbsp;films"></span><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;film1&quot;}\'></div></li>';
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
let showCount=1;
const epgXml=()=>{const start=Date.now()+10*3600000;const shows=Array.from({length:showCount},(_,i)=>`<programme channel="c1" start="${xmltv(start+i*6*3600000)}" stop="${xmltv(start+i*6*3600000+170*60000)}"><title>Heat (1995)</title></programme>`).join('');return `<tv><channel id="c1"><display-name>Кино</display-name></channel>${shows}</tv>`;};
const fetches=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:()=>{}},
 fetch:async url=>{
  const href=String(url);fetches.push(href);
  if(href==='https://letterboxd.com/fixture/watchlist/')return new Response(WATCHLIST_HTML);
  if(href==='https://letterboxd.com/film/heat-1995/')return new Response(FILM_HTML);
  if(href==='https://letterboxd.com/fixture/films/')return new Response(FILMS_HTML);
  if(href==='https://epg.test/guide.xml')return new Response(epgXml());
  if(href.startsWith('https://query.wikidata.org/sparql'))return Response.json({results:{bindings:[]}});
  throw new Error('Unexpected network access '+href);
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(scoped('src/metadata-cache.js','MetadataCache'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const worker=context.worker,call=code=>vm.runInContext(code,context);

let records,etags,revision=0,hang=null;
const never=()=>new Promise(()=>{});
const bucket={
 async get(key){if(hang?.('get',key))return never();return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){if(hang?.('put',key,JSON.parse(value)))return never();const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
const set=(key,value)=>{records.set(key,structuredClone(value));etags.set(key,String(++revision));};
const env={BUCKET:bucket,LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.test/guide.xml'};
const execution={waitUntil(){}};
const post=async(path,body={})=>{const response=await worker.fetch(new Request('https://iptv.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const read=async path=>(await worker.fetch(new Request('https://iptv.example'+path),env,execution)).json();
const settle=async()=>{for(let i=0;i<200;i++)await new Promise(resolve=>setTimeout(resolve,0));};
const continuation=()=>records.get('epg/resolver-continuation.json');
const epgFetches=()=>fetches.filter(href=>href==='https://epg.test/guide.xml').length;
const OLD='23570366-0000-4000-8000-000000000000',NEWER='c0ffee00-0000-4000-8000-000000000000';
const STALE={stage:'paused',reason:'chunk_budget',at:new Date(Date.now()-86400000).toISOString(),hopId:'33333333-4444-4555-8666-777777777777',remainingChunks:0,nextCatchUpAt:new Date(Date.now()+3600000).toISOString(),retryAt:null,programmeRunId:OLD};

// A store with the previous generation's spent series (the 27 Oct shape) and a sync run in the `epg` stage.
async function readyToCommit(stale=STALE){
 records=new Map();etags=new Map();hang=null;
 set('epg/published-generation.json',{phase:'published',programmeRunId:OLD});
 set('epg/resolver-continuation.json',stale);
 const start=await post('/api/sync/start');assert.equal(start.status,200,JSON.stringify(start.data));
 const runId=start.data.runId,metadata=await post('/api/sync/metadata',{runId});
 assert.equal(metadata.data.stage,'epg',JSON.stringify(metadata.data));
 return runId;
}

const events=()=>[...records.keys()].filter(key=>key.startsWith('events/items/')).sort().map(key=>({key,...records.get(key)}));
const epgEvents=()=>events().filter(event=>event.type==='epg');
const watchlistEvents=()=>events().filter(event=>event.type==='watchlist');
let failPublish=null;
const realPut=bucket.put;
bucket.put=async(key,value,options)=>{if(failPublish?.(key,JSON.parse(value)))throw new Error('injected storage failure on '+key);return realPut(key,value,options);};
const pause=()=>new Promise(resolve=>setTimeout(resolve,15));

// 1. First scan builds the events, the publication fails: no event exists for an unpublished attempt.
let runId=await readyToCommit();
showCount=1;failPublish=key=>/^epg\/generations\/[^/]+\/programme\.json$/.test(key);
let first=await post('/api/sync/epg',{runId});
assert.ok(first.status>=500,'the injected failure surfaces: '+JSON.stringify(first));
failPublish=null;
assert.equal(events().length,0,'a failed first commit writes no event');
assert.equal(records.get('epg/published-generation.json').programmeRunId,'23570366-0000-4000-8000-000000000000','the pointer did not move');
const staleAt=records.get('sync.json').events?.find(event=>event.type==='epg')?.at;
assert.ok(staleAt,'the first scan left its events on the run');

// 2. A rescan in the same run with another updatedAt and another show count, then seal/publish and finishSync.
await pause();showCount=3;
const second=await post('/api/sync/epg',{runId});
assert.equal(second.status,200,JSON.stringify(second.data));
const published=records.get('programme.json');
assert.equal(published.runId,runId);assert.notEqual(published.updatedAt,staleAt,'the published scan is the second one');
assert.equal(epgEvents().length,1,'exactly one EPG event for the published generation');
const epg=epgEvents()[0];
assert.equal(epg.id,runId+'-epg');
// AIR-390: the event time is the successful end of the run, the very value sync.json (and so the footer) carries, not the scan time.
const doneRun=records.get('sync.json');assert.equal(doneRun.stage,'complete');
assert.equal(epg.at,doneRun.updatedAt,'the event time is the completion time of the run');assert.equal(epg.at,doneRun.completedAt);
assert.ok(Date.parse(epg.at)>=Date.parse(published.updatedAt),'completion is not before the scan');
assert.equal(epg.broadcasts,published.films.reduce((n,f)=>n+f.shows.length,0),'the counts are those of the published report');
assert.equal(epg.broadcasts,3);
assert.equal(watchlistEvents().length,1);assert.equal(watchlistEvents()[0].id,runId+'-watchlist');assert.equal(watchlistEvents()[0].at,published.updatedAt,'a watchlist event with no removal to hand over is rebuilt for the published scan');
assert.ok(epg.key.includes(String(9999999999999-Date.parse(epg.at)).padStart(13,'0')),'the key orders by the completion time');
assert.equal(events().filter(event=>event.at===staleAt).length,0,'nothing carries the superseded scan time');

// 3. A repeated step, an events refresh and the completed-run continuation never duplicate.
await post('/api/sync/epg',{runId});await settle();
const page=await read('/api/events');assert.equal(page.events.filter(event=>event.type==='epg').length,1);
assert.equal(epgEvents().length,1);assert.equal(watchlistEvents().length,1);

// 4. Retry after the publication but before the events are written: the run resumes and writes the event once, matching the published report.
runId=await readyToCommit();
showCount=2;failPublish=null;
let eventWrites=0;failPublish=key=>{if(key.startsWith('events/items/')){eventWrites++;return eventWrites===1;}return false;};
const killed=await post('/api/sync/epg',{runId});assert.ok(killed.status>=500);
failPublish=null;
assert.equal(records.get('programme.json').runId,runId,'the generation is published');
assert.equal(epgEvents().filter(event=>event.id===runId+'-epg').length,0,'no event yet');
// A run saved by earlier code can carry an EPG event of a superseded scan: finishSync rebuilds it from the published report.
const savedRun=records.get('sync.json');savedRun.events=savedRun.events.map(event=>event.type==='epg'?{...event,at:'2026-01-01T00:00:00.000Z',broadcasts:99}:event);set('sync.json',savedRun);
const resumed=await post('/api/sync/epg',{runId});assert.equal(resumed.status,200,JSON.stringify(resumed.data));
const mine=epgEvents().filter(event=>event.id===runId+'-epg');
assert.equal(mine.length,1);assert.equal(mine[0].at,records.get('sync.json').updatedAt,'AIR-390: the completion time');assert.notEqual(mine[0].at,'2026-01-01T00:00:00.000Z');assert.equal(mine[0].broadcasts,2);
await post('/api/sync/epg',{runId});await settle();
assert.equal(epgEvents().filter(event=>event.id===runId+'-epg').length,1,'a further step is idempotent');

// 4a. AIR-390: the event is written only after the run is durably complete; every failure order keeps one time, one key and no false event.
{
 const mineOf=id=>epgEvents().filter(event=>event.id===id+'-epg');
 // (i) The save of the complete run record fails: the event is not written, the persisted run is not complete.
 let runC=await readyToCommit();showCount=1;let failed=0;
 failPublish=(key,body)=>{if(key==='sync.json'&&body.stage==='complete'&&body.epgEventPending&&!failed){failed++;return true;}return false;};
 const noSave=await post('/api/sync/epg',{runId:runC});assert.ok(noSave.status>=500,'the failed complete-save surfaces');failPublish=null;
 assert.equal(failed,1);assert.equal(mineOf(runC).length,0,'no EPG event while the complete record is not saved');
 {const persisted=records.get('sync.json');assert.ok(persisted.stage!=='complete'||persisted.epgEventPending,'a persisted complete record always carries the parked event (the error handler may save it)');}
 await pause();
 const recovered=await post('/api/sync/epg',{runId:runC});assert.equal(recovered.status,200,JSON.stringify(recovered.data));
 const done=records.get('sync.json');assert.equal(done.stage,'complete');assert.equal(done.epgEventPending,undefined);
 // The error handler of the failed attempt may have saved the record with a later updatedAt (milliseconds); the event keeps the completion time.
 assert.equal(mineOf(runC).length,1);assert.equal(mineOf(runC)[0].at,done.completedAt);assert.ok(Math.abs(Date.parse(done.updatedAt)-Date.parse(done.completedAt))<5000);
 // (ii) The event put fails after the complete record is saved: the run is complete, the event is parked and the next step writes it.
 runC=await readyToCommit();showCount=1;let putFails=0;
 failPublish=key=>{if(key.includes('-epg.json')&&putFails<1){putFails++;return true;}return false;};
 const parked=await post('/api/sync/epg',{runId:runC});assert.equal(parked.status,200,JSON.stringify(parked.data));failPublish=null;
 assert.equal(putFails,1);const parkedRun=records.get('sync.json');
 assert.equal(parkedRun.stage,'complete');assert.ok(parkedRun.epgEventPending,'the finished event is parked on the complete run');assert.equal(parkedRun.epgEventPending.at,parkedRun.updatedAt);
 assert.equal(mineOf(runC).length,0,'missing, never false: the run record is complete and the event is not there yet');
 const fixedAt=parkedRun.completedAt;await pause();
 await post('/api/sync/epg',{runId:runC});await settle();
 assert.equal(mineOf(runC).length,1);assert.equal(mineOf(runC)[0].at,fixedAt,'the continuation writes the parked time');
 assert.equal(records.get('sync.json').epgEventPending,undefined);assert.equal(records.get('sync.json').updatedAt,fixedAt);
 // (iii) The event is written but clearing the mark fails: the repeat writes the same key and clears it; never a second event.
 runC=await readyToCommit();showCount=1;let clearFails=0;
 failPublish=(key,body)=>{if(key==='sync.json'&&body.stage==='complete'&&!body.epgEventPending&&mineOf(runC).length===1&&!clearFails){clearFails++;return true;}return false;};
 const unmarked=await post('/api/sync/epg',{runId:runC});assert.equal(unmarked.status,200,JSON.stringify(unmarked.data));failPublish=null;
 assert.equal(clearFails,1);assert.equal(mineOf(runC).length,1,'the event is there once');assert.ok(records.get('sync.json').epgEventPending,'the persisted mark is still set');
 const keysBefore=events().map(event=>event.key).join(),atBefore=mineOf(runC)[0].at;
 await post('/api/sync/epg',{runId:runC});await settle();
 assert.equal(records.get('sync.json').epgEventPending,undefined);assert.equal(events().map(event=>event.key).join(),keysBefore,'no new key');assert.equal(mineOf(runC)[0].at,atBefore);
 const order=(await read('/api/events')).events.filter(event=>event.type==='epg').map(event=>event.at);
 assert.deepEqual(order,[...order].sort().reverse(),'events are ordered newest first');
}

// 4b. Watchlist delta across a rescan: the removed film is reported once, from the published generation; its removal reference follows the event key.
{
 const key=event=>'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';
 const runB=await readyToCommit();
 set('watchlist.json',{updatedAt:'2026-01-01T00:00:00.000Z',films:[{id:'film1',title:'Heat',original:'Heat',year:1995},{id:'gone',title:'Gone',original:'Gone',year:1999,tmdbId:'4242',letterboxdUrl:'https://letterboxd.com/film/gone/'}]});
 showCount=1;failPublish=k=>/^epg\/generations\/[^/]+\/programme\.json$/.test(k);
 const firstTry=await post('/api/sync/epg',{runId:runB});assert.ok(firstTry.status>=500);failPublish=null;
 const early=records.get('sync.json').events.find(event=>event.type==='watchlist');
 assert.deepEqual(early.removed.map(film=>film.id),['gone'],'the first scan already sees the removal');
 await pause();showCount=2;
 const retry=await post('/api/sync/epg',{runId:runB});assert.equal(retry.status,200,JSON.stringify(retry.data));
 const watch=watchlistEvents().filter(event=>event.id===runB+'-watchlist');
 assert.equal(watch.length,1,'one watchlist event for the run');
 // The removal hand-over references this event by key, whether it is still pending on the run or already in the queue: the event keeps
 // its key (and so its first-scan time) rather than leaving the reference dangling. A rescan yields the same delta.
 assert.equal(watch[0].at,early.at,'a watchlist event that reports a removal keeps the key its hand-over references');
 assert.deepEqual(watch[0].removed.map(film=>film.id),['gone']);assert.equal(watch[0].added.length,0);
 const refs=records.get('sync.json').removalRefs;
 if(refs){const list=Array.isArray(refs)?refs:[refs];assert.ok(list.every(item=>item.ref.eventKey===key(watch[0])),'every removal reference names the written event');}
 await post('/api/sync/epg',{runId:runB});await settle();
 assert.equal(watchlistEvents().filter(event=>event.id===runB+'-watchlist').length,1,'a repeat step writes no second watchlist event');
}

// 5. Older events stay readable and ordered: the previous run's events are untouched.
assert.ok(events().every(event=>typeof event.at==='string'&&Number.isFinite(Date.parse(event.at))));
console.log('AIR-359 EPG event: unpublished attempt, rescan in the same run, retry after publish, idempotence and ordering passed');
