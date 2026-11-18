// AIR-535: how fast does the batched replay restore a new generation's assigned rows once a chunk is admitted?
// Local sqlite stand-ins and a MODELLED clock (round trips x a stated latency). Nothing here is production wall time, and nothing here
// calls Cloudflare, TMDB or production D1. Only counts and ratios are asserted, never milliseconds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-replay-timeline-'));
const chain=fs.readdirSync('migrations').filter(name=>/^00(0[1-9]|1[01])_.*\.sql$/.test(name)).sort();
const NEW='run-new',MIN=60000,DAY=86400000,START=Date.parse('2026-11-18T12:00:00Z');
// 18 Nov 2026 read-only measurements: about 2.9 s per page of 40 observations (5 752 ms for 2 pages), about 10 round trips a page.
const MODEL_RT_MS=300,REPLAY_SLICE_MS=10000,CHUNK_CADENCE_MS=30000;
const OBSERVATIONS=1200;

const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const obs=(n)=>{
 const key='k'+String(n).padStart(5,'0'),slots=n%3===0?3:2;
 const shows=Array.from({length:slots},(_,index)=>({channelId:'c'+n+'_'+index,channel:'Channel '+n,start:START+DAY+((n+index*7)%40)*3600000,end:START+DAY+((n+index*7)%40)*3600000+90*MIN}));
 return {key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[90],shows,seenInLatestSnapshot:true,lastAiring:shows[0].start};
};

async function fixture(){
 const file=path.join(root,'a-'+Math.random().toString(36).slice(2)+'.sqlite');
 const made=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(made.status!==0)throw new Error(made.stderr);
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const standin=d1Standin(file,{});
 const env={DB:standin,BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});env.discoveryLease=taken.lease;
 const items=Array.from({length:OBSERVATIONS},(_,n)=>obs(n));
 await Authority.ingestLedger(env,{programmeRunId:NEW,handoff:true,lease:taken.lease,items:(async function*(){for(const item of items)yield item;})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${NEW}','published','2026-11-18T17:35:09Z','x','2026-11-18T17:35:09Z')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${NEW}', generation=7`);
 // Catalog admissions in groups, decisions in groups: setup only.
 for(let at=0;at<items.length;at+=30){
  const group=items.slice(at,at+30),films={};
  group.forEach((item,index)=>{const tmdb=String(10000+at+index);films['tmdb_'+tmdb]={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Catalog '+tmdb,shows:[]};});
  await Authority.upsertAdmissions(env,films,{lease:taken.lease});
  const delta={};
  group.forEach((item,index)=>{const tmdb=String(10000+at+index);delta[item.key]={previous:null,next:{status:'verified',filmId:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,identitySource:'tmdb_detail',anchor:[90],evidenceKey:Authority.evidenceKey(item)}};});
  const wrote=await Authority.writeDecisionDelta(env,delta,{lease:taken.lease});
  assert.equal(wrote.written.length,group.length);
 }
 return {file,env,standin,items};
}
const shownRows=file=>Number(sql(file,`SELECT COUNT(*) AS n FROM published_epg_show WHERE programme_run_id='${NEW}' AND basis='discovery'`)[0].n);
const eligibleRows=items=>items.reduce((sum,item)=>sum+item.shows.length,0);

// One modelled chunk = one replay slice. The stop rule is the production one (`replayStop`): no page or write group starts when one more round trip would
// pass the slice. Returns what the chunk did in round trips and modelled milliseconds.
async function lap(page){
 const {file,env,standin,items}=await fixture();
 const total=eligibleRows(items);
 const chunks=[];
 let cursor='',rtTotal=0,done=false;
 while(!done){
  const q0=standin.calls.queries,b0=standin.calls.batches,rows0=shownRows(file);
  const used=()=>(standin.calls.queries-q0+standin.calls.batches-b0)*MODEL_RT_MS;
  const result=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:cursor,limit:page,shouldStop:()=>used()+MODEL_RT_MS>=REPLAY_SLICE_MS});
  cursor=result.after;done=result.complete;
  const rt=standin.calls.queries-q0+standin.calls.batches-b0;rtTotal+=rt;
  chunks.push({rt,observations:result.observations,rows:shownRows(file)-rows0,covered:shownRows(file)});
  assert.ok(chunks.length<200,'the lap terminates');
 }
 const covered=shownRows(file);
 // The chunk index at which coverage first reaches a share of the eligible rows. Chunks follow each other every CHUNK_CADENCE_MS (the 18 Nov 21:00-21:30 series ran 63 chunks in about 30 minutes).
 const reach=share=>{const index=chunks.findIndex(chunk=>chunk.covered>=Math.ceil(total*share));return index<0?null:index+1;};
 return {page,total,covered,chunks:chunks.length,rtPerRow:rtTotal/covered,rowsPerChunk:covered/chunks.length,minutesTo:Object.fromEntries([['T50',0.5],['T90',0.9],['T95',0.95],['T99',0.99]].map(([name,share])=>[name,Math.round(reach(share)*CHUNK_CADENCE_MS/60000*10)/10]))};
}

const current=await lap(40);
const wider=await lap(Authority.REPLAY_PAGE);
console.log(JSON.stringify({model:{rtMs:MODEL_RT_MS,sliceMs:REPLAY_SLICE_MS,cadenceMs:CHUNK_CADENCE_MS,observations:OBSERVATIONS},page40:current,pageDefault:wider}));

assert.equal(current.covered,current.total,'every eligible slot is restored with a page of 40');
assert.equal(wider.covered,wider.total,'every eligible slot is restored with the default page');
// The claim being tested: fixed per-page reads (select, slots, members, admissions and two counts) are amortised over more rows, so the same slice restores more.
if(Authority.REPLAY_PAGE>40){
 assert.ok(wider.rtPerRow<current.rtPerRow*0.75,`round trips per restored row ${wider.rtPerRow.toFixed(3)} vs ${current.rtPerRow.toFixed(3)}`);
 assert.ok(wider.chunks<current.chunks,'fewer chunks for the same lap');
}
console.log('discovery-replay-timeline ok');
