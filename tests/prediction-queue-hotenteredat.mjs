// AIR-480 stage 4b: the prediction queue ranks from completed-read showings and never reads hotEnteredAt (ADR 0142 decision 13, example 26).
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';

const records=new Map(),etags=new Map();
let revision=0;
const env={BUCKET:{
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
 list:async()=>({objects:[],truncated:false})
}};
const now=Date.now();
const H=3600000;
const show=(start)=>({channelId:'c',channel:'C',start,end:start+H});
const film=(id,tmdb,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:id,original:id,year:2020,genres:[],directors:[],actors:[],...extra});
const liveD1={value:null,unreadable:false,advanceAfterFirst:false,next:null};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,PublishedEpg:{
 currentGeneration:async()=>{
  if(liveD1.advanceAfterFirst){
   const first=liveD1.value;
   liveD1.advanceAfterFirst=false;
   liveD1.value=liveD1.next;
   return first;
  }
  return liveD1.value;
 },
 readDocumentAt:async(_env,run,kind)=>{
  if(!liveD1.value)throw new Error('D1 programme is not the authority');
  if(liveD1.unreadable)return null;
  if(kind==='watchlist')return {films:[]};
  return {runId:run,films:[],catalogFilms:[{id:'tmdb_9',tmdbId:'9',canonicalIdentity:'tmdb:9',shows:[show(now-H)]}]};
 }
}});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
for(const file of ['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});
records.set('enrichment/view-index.json',{});
records.set('sync.json',{runId:'run-q',stage:'complete'});

async function reconcile(){
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/queue/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env);
 assert.equal(response.status,200,await response.text());
 return records.get('enrichment/prediction-queue.json');
}

// PublishedEpg is defined (as in the Worker bundle) but currentGeneration is null: the R2 path. Record shows rank the queue; hotEnteredAt is not a tie-break.
{
 liveD1.value=null;
 liveD1.advanceAfterFirst=false;
 records.set('epg/published-generation.json',{programmeRunId:'run-q',phase:'published'});
 records.set('programme.json',{runId:'run-q',films:[]});
 records.set('epg/discovered-films.json',{
  late:film('late','1',{shows:[show(now-1*H)],hotEnteredAt:new Date(now-10*86400000).toISOString(),discoveredAt:new Date(now-2*86400000).toISOString()}),
  early:film('early','2',{shows:[show(now-2*H)],hotEnteredAt:new Date(now).toISOString(),discoveredAt:new Date(now-2*86400000).toISOString()})
 });
 const queue=await reconcile();
 assert.deepEqual(queue.hotPending,['early','late'],'R2 authority keeps record shows; the earlier start ranks first; a later hotEnteredAt does not');
}

// D1/open pin: completed programme showings only. A same-run stale catalog showing is not hot; an assigned catalog Film is.
{
 liveD1.value={programmeRunId:'run-q',generation:7,phase:'published',fence:'f'};
 liveD1.advanceAfterFirst=false;
 liveD1.unreadable=false;
 records.set('programme.json',{runId:'run-q',films:[]});
 const catalog={
  stale:film('stale','8',{shows:[show(now-H)],showsProgrammeRunId:'run-q',hotEnteredAt:new Date(now).toISOString()}),
  assigned:film('assigned','9',{shows:[],hotEnteredAt:null,discoveredAt:new Date(now-86400000).toISOString()})
 };
 records.set('epg/discovered-films.json',catalog);
 records.set('epg/generations/run-q/discovered-films.json',catalog);
 const queue=await reconcile();
 assert.deepEqual(queue.hotPending,['assigned'],'the completed-read showing ranks the Film; the stale same-run catalog showing does not');
 assert.equal(queue.priority.assigned.hot,true);
 assert.equal(queue.hotPending.includes('stale'),false);
 assert.equal(queue.priority.stale?.hot,false,'a same-run catalog showing that the completed read dropped is not hot');
}

// D1 is authoritative but the completed programme is unreadable: fail closed, do not rank from catalog shows.
{
 liveD1.unreadable=true;
 records.set('programme.json',{runId:'run-q',films:[]});
 records.set('epg/discovered-films.json',{hot:film('hot','8',{shows:[show(now-H)]})});
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/queue/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env);
 assert.equal(response.status,502,'an unreadable D1 programme does not rebuild from catalog shows');
 liveD1.unreadable=false;
}

// D1 publishes run-B after the caller read run-A: do not rank A's catalog shows; rebuild from B or fail closed.
{
 liveD1.value={programmeRunId:'run-A',generation:7,phase:'published',fence:'fa'};
 liveD1.next={programmeRunId:'run-B',generation:8,phase:'published',fence:'fb'};
 liveD1.advanceAfterFirst=true;
 liveD1.unreadable=false;
 records.delete('enrichment/prediction-queue.json');
 records.set('programme.json',{runId:'run-A',films:[]});
 const catalog={hot:film('hot','8',{shows:[show(now-H)],showsProgrammeRunId:'run-A'})};
 records.set('epg/discovered-films.json',catalog);
 records.set('epg/generations/run-A/discovered-films.json',catalog);
 records.set('epg/generations/run-B/discovered-films.json',catalog);
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/queue/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env);
 const queue=records.get('enrichment/prediction-queue.json');
 assert.notEqual(queue?.programmeRunId,'run-A','a D1 pin for B never stores a run-A queue');
 if(response.status===200){
  assert.equal(queue.programmeRunId,'run-B');
  assert.equal(queue.hotPending.includes('hot'),false,'legacy catalog shows of A do not rank under B');
 }else{
  assert.equal(response.status,502);
  assert.equal(queue,undefined);
 }
}

console.log('prediction queue hotEnteredAt tie-break and completed-read showings ok');
