// AIR-212: the EPG commit opens the discovery series for the generation it has just published before the
// memory-heavy tail (finishSync, prediction queue, ratings). An invocation killed anywhere after the publication
// therefore leaves a checkpoint of the published generation, and a retry of the same commit keeps it (no second
// initial budget, no lost progress). The queue write stays fenced: it never names an unpublished or superseded
// generation and never replaces a live writer. No TMDB request is made by any commit.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const WATCHLIST_HTML='<span class="js-watchlist-count">1</span><div data-component-class="LazyPoster" data-item-name="Heat (1995)" data-item-link="/film/heat-1995/" data-postered-identifier="{&quot;lid&quot;:&quot;film1&quot;}"></div>';
const FILM_HTML='<meta name="description" content="A crew plans a robbery."><span data-tmdb-id="1656"></span><script type="application/ld+json">{"name":"Heat","genre":"Crime","duration":"PT2H50M","director":{"name":"Michael Mann","sameAs":"https://letterboxd.com/director/michael-mann/"},"actor":[{"name":"Al Pacino","sameAs":"https://letterboxd.com/actor/al-pacino/"}]}</script>';
const FILMS_HTML='<span title="1&nbsp;films"></span><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;film1&quot;}\'></div></li>';
const xmltv=t=>new Date(t).toISOString().replace(/[-:T]/g,'').slice(0,14)+' +0000';
const epgXml=()=>{const start=Date.now()+10*3600000;return `<tv><channel id="c1"><display-name>Кино</display-name></channel><programme channel="c1" start="${xmltv(start)}" stop="${xmltv(start+170*60000)}"><title>Heat (1995)</title></programme></tv>`;};
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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(scoped('src/metadata-cache.js','MetadataCache'),context);for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
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
const step=runId=>post('/api/sync/epg',{runId});
// Kills the invocation at the first storage write that matches: from then on no storage call returns, as for an
// isolate killed for memory. With `land` the matching write itself is persisted first.
function killFrom(match,{land=false}={}){let armed=false;hang=(op,key,value)=>{if(armed)return true;if(op==='put'&&match(key,value)){armed=true;return !land;}return false;};}

// 1. Publish succeeded, invocation killed before the run is saved as `complete`: the series of the published
//    generation is already open (full budget), so the hourly view shows outstanding chunks for the right generation.
let runId=await readyToCommit();
killFrom((key,value)=>key==='sync.json'&&value?.stage==='complete');
step(runId);await settle();hang=null;
assert.equal(records.get('epg/published-generation.json').programmeRunId,runId);
assert.equal(records.get('sync.json').stage,'epg');
assert.equal(continuation().programmeRunId,runId);assert.equal(continuation().reason,'epg_committed');assert.equal(continuation().remainingChunks,12);assert.equal(continuation().hopId,null);
let pipeline=await read('/api/enrichment/pipeline/status');
assert.equal(pipeline.continuation.programmeRunId,runId);assert.equal(pipeline.continuation.remainingChunks,12);
// Repeating the same run takes the commit's resume path: no second EPG download, the series is kept as it is.
let epgBefore=epgFetches(),queued=structuredClone(continuation());
let r=await step(runId);
assert.equal(r.status,200);assert.equal(r.data.stage,'complete');assert.equal(epgFetches(),epgBefore,'the retry does not download the EPG again');
assert.equal(r.data.discovery.programmeRunId,runId);assert.equal(r.data.discovery.remainingChunks,12);assert.equal(r.data.discovery.nextAction,'continue');
assert.deepEqual(continuation(),queued,'the retry neither reopens nor duplicates the series');

// 2. Killed inside the publish → queue window (the checkpoint write itself never lands): the run is still `epg`
//    and the old series stays in place; the retry resumes the commit and opens the series before the tail.
runId=await readyToCommit();
killFrom((key,value)=>key==='epg/resolver-continuation.json'&&value?.programmeRunId===runId);
step(runId);await settle();hang=null;
assert.equal(records.get('epg/published-generation.json').programmeRunId,runId);assert.equal(records.get('sync.json').stage,'epg');
assert.deepEqual(continuation(),STALE);
// The retry is then killed right after its own queue write: the series is already persisted for the published generation.
killFrom((key,value)=>key==='epg/resolver-continuation.json'&&value?.programmeRunId===runId,{land:true});
epgBefore=epgFetches();step(runId);await settle();hang=null;
assert.equal(epgFetches(),epgBefore);assert.equal(continuation().programmeRunId,runId);assert.equal(continuation().remainingChunks,12);
r=await step(runId);
assert.equal(r.data.stage,'complete');assert.equal(r.data.discovery.remainingChunks,12);assert.equal(continuation().programmeRunId,runId);

// 3. Progress already made on the series of this generation survives a repeat of the commit (it is never reset to
//    the initial budget).
runId=await readyToCommit();
killFrom((key,value)=>key==='sync.json'&&value?.stage==='complete');
step(runId);await settle();hang=null;
const progressed={...continuation(),remainingChunks:7,hopId:'44444444-5555-4666-8777-888888888888',at:new Date().toISOString()};
set('epg/resolver-continuation.json',progressed);
r=await step(runId);
assert.equal(r.data.stage,'complete');assert.equal(r.data.discovery.remainingChunks,7);assert.deepEqual(continuation(),progressed);

// 4. A live writer of the old generation is not overwritten by the retry's queue write; the AIR-159 handoff moves the
//    series once its lease is gone.
runId=await readyToCommit();
killFrom((key,value)=>key==='epg/resolver-continuation.json'&&value?.programmeRunId===runId);
step(runId);await settle();hang=null;
const RUNNING={stage:'running',reason:null,at:new Date().toISOString(),hopId:'55555555-6666-4777-8888-999999999999',remainingChunks:4,nextCatchUpAt:null,retryAt:null,programmeRunId:OLD};
set('epg/resolver-continuation.json',RUNNING);set('epg/resolver-lease.json',{id:'live-writer',hopId:RUNNING.hopId,expiresAt:Date.now()+600000});
r=await step(runId);
assert.equal(r.data.stage,'complete');assert.deepEqual(continuation(),RUNNING,'a live writer keeps its record');
assert.equal(r.data.discovery.nextAction==='continue',false);
set('epg/resolver-lease.json',{id:'live-writer',hopId:RUNNING.hopId,expiresAt:Date.now()-1});
r=await step(runId);
assert.equal(r.data.diagnostic.recovery.action,'generation_recovered');assert.equal(continuation().programmeRunId,runId);

// 5. Simultaneous retries of the same commit open the series once.
runId=await readyToCommit();
killFrom((key,value)=>key==='epg/resolver-continuation.json'&&value?.programmeRunId===runId);
step(runId);await settle();hang=null;
const [first,second]=await Promise.all([step(runId),step(runId)]);
for(const each of [first,second])if(each.status===200&&each.data.discovery)assert.equal(each.data.discovery.programmeRunId,runId);
assert.equal(continuation().programmeRunId,runId);assert.equal(continuation().remainingChunks,12);assert.equal(continuation().reason,'epg_committed');

// 6. Generation fence: the commit of a run whose generation is no longer the published one does not queue it.
runId=await readyToCommit();
killFrom((key,value)=>key==='epg/resolver-continuation.json'&&value?.programmeRunId===runId);
step(runId);await settle();hang=null;
set('epg/published-generation.json',{phase:'published',programmeRunId:NEWER});
const newer={stage:'paused',reason:'epg_committed',at:new Date().toISOString(),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:NEWER};
set('epg/resolver-continuation.json',newer);
await call('queueCommittedDiscovery')(env,{runId});
assert.deepEqual(continuation(),newer,'a superseded generation is never queued over the published one');

// 7. Hourly stage A gate (docs/reference/scheduled-tasks.md, ADR 0030): the hourly task steps only when
//    `epg_status.stage` is `complete`, on top of the generation, lease and wait guards. The model below is that
//    contract applied to the Worker's own read-only views. An early-queued series while the commit tail has not
//    finished (`stage: epg`) is refused, because a step there would be a commit retry; a complete run's
//    current-generation series and the AIR-159 handoff of a stranded earlier-generation record stay allowed.
function hourlyStageA(status,pipeline,now=Date.now()){
 if(status.stage!=='complete')return {step:false,reason:'sync_not_complete'};
 const published=pipeline.programmeRunId,c=pipeline.continuation,health=pipeline.continuationHealth;
 if(!published||published!==status.runId||!c)return {step:false,reason:'ambiguous'};
 if(health?.status==='live')return {step:false,reason:'live'};
 if(c.programmeRunId!==published)return c.stage==='running'?{step:false,reason:'running_other_generation'}:{step:true,reason:'generation_handoff'};
 if(c.retryAt&&Date.parse(c.retryAt)>now||c.nextCatchUpAt&&Date.parse(c.nextCatchUpAt)>now)return {step:false,reason:'wait'};
 return c.stage==='paused'&&c.remainingChunks>0?{step:true,reason:'continue'}:{step:false,reason:'nothing_outstanding'};
}
const views=async()=>[await read('/api/status'),await read('/api/enrichment/pipeline/status')];
runId=await readyToCommit();
killFrom((key,value)=>key==='sync.json'&&value?.stage==='complete');
step(runId);await settle();hang=null;
let [status,view]=await views();
assert.equal(status.stage,'epg');assert.equal(view.continuation.programmeRunId,runId);assert.equal(view.continuation.remainingChunks,12);
assert.deepEqual(hourlyStageA(status,view),{step:false,reason:'sync_not_complete'},'an EPG-stage series is not hourly work');
// What the gate prevents: a step in this state takes the commit branch, not a discovery chunk.
r=await step(runId);
const retried=records.get('epg/resolver-continuation-diagnostics.json').recent[0];
assert.equal(retried.phase,'completed');
assert.equal(retried.branch,'epg_commit');assert.equal(retried.runStage,'epg');
[status,view]=await views();
assert.equal(status.stage,'complete');assert.deepEqual(hourlyStageA(status,view),{step:true,reason:'continue'},'a complete run continues its own series');
set('epg/resolver-continuation.json',STALE);
[status,view]=await views();
assert.deepEqual(hourlyStageA(status,view),{step:true,reason:'generation_handoff'},'a stranded earlier-generation record is handed over');
r=await step(runId);
assert.equal(r.data.diagnostic.recovery.action,'generation_recovered');assert.equal(continuation().programmeRunId,runId);

assert.deepEqual(fetches.filter(href=>href.includes('themoviedb')),[],'no TMDB request was made');
console.log('AIR-212 durable discovery enqueue: kill before complete, publish/queue window, repeat of the same run, kept progress, live writer, simultaneous retries, generation fence and the hourly stage A gate passed');
