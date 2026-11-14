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
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
for(const file of ['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const now=Date.now();
const H=3600000;
const show=(start)=>({channelId:'c',channel:'C',start,end:start+H});
const film=(id,tmdb,extra={})=>({id,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:id,original:id,year:2020,genres:[],directors:[],actors:[],...extra});
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});
records.set('enrichment/view-index.json',{});
records.set('sync.json',{runId:'run-q',stage:'complete'});

async function reconcile(){
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/queue/reconcile',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),env);
 assert.equal(response.status,200,await response.text());
 return records.get('enrichment/prediction-queue.json');
}

// Outside D1 the record shows still rank the queue, but hotEnteredAt is never a tie-break: two equally hot Films order by earliest start, then discoveredAt, then id.
{
 records.set('programme.json',{runId:'run-q',films:[]});
 records.set('epg/discovered-films.json',{
  late:film('late','1',{shows:[show(now-1*H)],hotEnteredAt:new Date(now-10*86400000).toISOString(),discoveredAt:new Date(now-2*86400000).toISOString()}),
  early:film('early','2',{shows:[show(now-2*H)],hotEnteredAt:new Date(now).toISOString(),discoveredAt:new Date(now-2*86400000).toISOString()})
 });
 const queue=await reconcile();
 assert.deepEqual(queue.hotPending,['early','late'],'the earlier start ranks first; a later hotEnteredAt does not');
}

// Under a D1 pin the queue uses the completed programme showings only: a same-run stale catalog showing does not make a Film hot, and an assigned catalog Film does.
{
 const live={programmeRunId:'run-q',generation:7,phase:'published',fence:'f'};
 ctx.PublishedEpg={
  currentGeneration:async()=>live,
  readDocumentAt:async(_env,run,kind)=>{
   if(kind==='watchlist')return {films:[]};
   return {runId:run,films:[],catalogFilms:[{id:'tmdb_9',tmdbId:'9',canonicalIdentity:'tmdb:9',shows:[show(now-H)]}]};
  }
 };
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
 delete ctx.PublishedEpg;
}

console.log('prediction queue hotEnteredAt tie-break and completed-read showings ok');
