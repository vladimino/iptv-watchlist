// AIR-529. New Discovery show assignments inside the SAME published EPG generation must reach the Prediction hot/cold queue before the next batch selects.
// Part 1: the real `PublishedEpg.assignedShowsSignature` on a migrated sqlite D1 stand-in. Part 2: the batch preflight/start on the flow world with a D1 pin stub:
// a queue ranked on an old signature of the unchanged `programmeRunId` is rebuilt by the NEXT natural batch start (cold films that now air become hot, no new generation),
// an unchanged signature rebuilds nothing, and an unreadable signature never forces a rebuild. Local stand-ins only; nothing here calls Cloudflare, TMDB or production.
import assert from 'node:assert/strict';
import * as PublishedEpg from '../src/published-epg.js';
import {flowWorld,sql,migrated} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';

// 1. The signature.
{
 const made=migrated();const file=made.file||made;
 const db=d1Standin(file);
 const ins=(run,film,start,basis)=>sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('"+run+"','"+film+"','c',"+start+",NULL,'C',NULL,'"+basis+"','k')");
 assert.equal(await PublishedEpg.assignedShowsSignature({DB:db},'r1'),'0:0:0','no assigned row');
 assert.equal(await PublishedEpg.assignedShowsSignature({DB:db},null),null);
 ins('r1','f1',1,'epg');assert.equal(await PublishedEpg.assignedShowsSignature({DB:db},'r1'),'0:0:0','sealed rows are not assignments');
 ins('r1','f1',2,'discovery');const a=await PublishedEpg.assignedShowsSignature({DB:db},'r1');assert.match(a,/^1:\d+:\d+$/);
 ins('r2','f9',3,'discovery');assert.equal(await PublishedEpg.assignedShowsSignature({DB:db},'r1'),a,'another generation does not move it');
 ins('r1','f2',4,'discovery');const b=await PublishedEpg.assignedShowsSignature({DB:db},'r1');assert.notEqual(b,a,'a new assignment moves it');
 sql(file,"DELETE FROM published_epg_show WHERE programme_run_id='r1' AND film_id='f2'");ins('r1','f3',5,'discovery');
 const c=await PublishedEpg.assignedShowsSignature({DB:db},'r1');assert.notEqual(c,b,'a delete plus re-insert (same count) moves it');
}

// 2. The batch start.
const now=Date.now(),HOT=20,COLD=40;
const w=await flowWorld({films:HOT+COLD,extra:n=>n<=HOT?{}:{shows:[{start:now-10*86400000}]}});
const {file,api,records,ctx}=w;
let signature='1:1',readable=true;
ctx.PublishedEpg={
 currentGeneration:async()=>({authority:'d1',programmeRunId:'p1',phase:'published',fence:'d1:1:p1',generation:1}),

 readDocumentAt:async(env,run,kind)=>records.get(kind==='watchlist'?'watchlist.json':'programme.json')??null,
 assignedShowsSignature:async()=>{if(!readable)throw new Error('d1 down');return signature;},
};
records.set('programme.json',{runId:'p1',films:[],catalogFilms:[]});records.set('sync.json',{runId:'p1',stage:'complete'});
const queue=()=>JSON.parse(sql(file,'SELECT chunk_text FROM prediction_queue ORDER BY seq').map(r=>r.chunk_text).join(''));
const dry=()=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100},dryRun:true});
const built=await api('queue/reconcile',{});assert.equal(built.status,200);
const q0=queue();
assert.equal(q0.programmeRunId,'p1');assert.equal(q0.showsSignature,'1:1','the queue stores the signature it was ranked on');
const hot0=q0.hotPending.length;
// Unchanged signature: a start rebuilds nothing.
{const before=queue().refreshedAt;const r=await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}});assert.equal(r.status,200);assert.equal(queue().refreshedAt,before,'unchanged signature: no rebuild');
 await api('complete',{runId:r.data.runId,reason:'manifest_spent'});sql(file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");}
// Unreadable signature: no forced rebuild.
readable=false;{const before=queue().refreshedAt;const r=await dry();assert.equal(r.status,200);assert.equal(queue().refreshedAt,before);}readable=true;
// Discovery assigns shows to cold films inside the same generation: signature moves, programmeRunId does not.
// The completed programme now carries assigned shows for the catalog films (what the completed read returns after Discovery inserted `published_epg_show` rows).
records.set('programme.json',{runId:'p1',films:[],catalogFilms:Array.from({length:HOT+COLD},(_,i)=>({tmdbId:String(i+1),shows:[{channelId:'c',channel:'C',start:now-600000,end:now+7200000,basis:'discovery'}]}))});
signature='45:99:7';
sql(file,"UPDATE prediction_queue SET chunk_text=chunk_text");
const stale=await dry();assert.equal(stale.status,200);
// dry run writes nothing; the real start rebuilds before it selects.
assert.equal(queue().showsSignature,'1:1','a dry run never rebuilds');assert.equal(queue().hotPending.length,0,'the old queue is all cold');
sql(file,"UPDATE prediction_lease SET expires_at=1, document_json=json_set(document_json,'$.expiresAt',1)");
const started=await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'manual',capacity:{remainingPercent:100}});
assert.equal(started.status,200,JSON.stringify(started.data).slice(0,300));
assert.equal(queue().showsSignature,'45:99:7','the start rebuilt the queue on the new signature, with no new generation');
assert.equal(queue().programmeRunId,'p1');
assert.equal(started.data.queueRefreshed,true);
assert.equal(hot0,0);assert.ok(queue().hotPending.length>0,'cold films that now air became hot at the next natural start, no new generation');
console.log('hot',hot0,'->',queue().hotPending.length);
console.log('prediction hot reconcile same generation ok');
