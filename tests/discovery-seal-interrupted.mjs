// Incident 5 Nov 2026: a ledger seal that does not finish inside one request. Local sqlite stand-ins only.
// It records what the code does when the handoff is interrupted: ledger readers fail closed, a retry replays
// from the start, and no attempt accumulates progress. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let n=0;
const sql=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'s-'+(n++)+'.sqlite');const r=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const item=(key,start)=>({key,title:'T '+key,normalizedTitle:'t '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start,end:start+1000}],seenInLatestSnapshot:true,lastAiring:start});
const keys=count=>Array.from({length:count},(_,i)=>'k'+String(i).padStart(4,'0'));
const stream=(list,start)=>(async function*(){for(const key of list)yield item(key,start);})();
const count=(file,where)=>Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_observation WHERE '+where)[0].n);
const transfer=file=>sql(file,'SELECT state, programme_run_id FROM discovery_transfer')[0];

// An interrupted request is a batch that never lands: the client disconnected and the Worker was cancelled.
async function attempt(file,{run,total,killAfterBatches,lease:given}){
 let batches=0,killed=false;
 const env={DB:d1Standin(file,{onBatch(){batches++;if(killAfterBatches&&batches>killAfterBatches){killed=true;throw new Error('cancelled');}}}),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=given||await Authority.acquireLease(env,{programmeRunId:null});
 assert.ok(taken.lease,'the attempt must hold a lease');
 env.discoveryLease=taken.lease;
 let error=null;
 try{await Authority.ingestLedger(env,{programmeRunId:run,handoff:true,lease:taken.lease,items:stream(keys(total),Date.now()+3600000)});}catch(e){error=e;}
 return {env,error,killed,lease:taken.lease,batches};
}

const file=migrate();
// Baseline: a sealed ledger of 120 observations for the previous run.
const base=await attempt(file,{run:'run-old',total:120});
assert.equal(base.error,null);
assert.equal(transfer(file).state,'committed');
await Authority.releaseLease(base.env,base.lease);

// 1. Interrupted after a partial batch: the transfer stays `loading`, the old ledger is `retiring`, new rows are partial.
const first=await attempt(file,{run:'run-new',total:120,killAfterBatches:3});
assert.ok(first.killed&&first.error?.code==='discovery_unavailable');
assert.equal(transfer(file).state,'loading');
assert.equal(transfer(file).programme_run_id,'run-new');
const partial1=count(file,"source_key='active' AND residence='active'");
assert.ok(partial1>0&&partial1<120,'partial progress: '+partial1);
assert.equal(count(file,"residence='retiring'"),120-partial1,'the rest of the previous ledger is retiring');

// 2. While `loading` the keys the seal never writes (catalog, status, continuation) stay readable and say the transfer is
// loading; every other owned key and every ledger read fails closed, with or without a lease (ADR 0091).
sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
for(const key of ['epg/discovered-films.json','epg/discovery-status.json','epg/resolver-continuation.json']){
 const read=await Authority.routeRead(first.env,key);
 assert.equal(read.handled,true,key);
 assert.equal(read.transfer,'loading',key);
}
for(const key of ['epg/discovery-resolution.json','epg/discovery-score-preview.json','epg/discovery-latest.json','epg/discovery-workflow.json']){
 await assert.rejects(()=>Authority.routeRead(first.env,key),error=>error.code==='discovery_incomplete',key);
}
await assert.rejects(()=>Authority.walkObservationPages(first.env,{onPage(){}}),error=>error.code==='discovery_incomplete');

// 3. The next handoff takes the expired lease and replays from the first observation: it flips what the interrupted attempt
// had written back to `retiring` and writes it again, so a second interrupted attempt ends with LESS than the first.
const second=await attempt(file,{run:'run-new',total:120,killAfterBatches:2});
assert.ok(second.killed);
const partial2=count(file,"source_key='active' AND residence='active'");
assert.ok(partial2<partial1,`progress went backwards: ${partial1} then ${partial2}`);
assert.equal(transfer(file).state,'loading');

// The killed attempt still holds its lease: a retry inside the 90 s TTL cannot start at all.
await assert.rejects(()=>attempt(file,{run:'run-new',total:120}),error=>error.code==='discovery_incomplete');
sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
// 4. An attempt that is not interrupted finishes. Only a seal that fits one request can ever finish.
const third=await attempt(file,{run:'run-new',total:120});
assert.equal(third.error,null);
assert.equal(transfer(file).state,'committed');
assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),120);
const readable=await Authority.routeRead(third.env,'epg/discovered-films.json');
assert.equal(readable.handled,true);

// 5. Interrupted after the last batch, before `finish`: all new rows are written, the transfer is still `loading`.
const sealed=migrate();
const b2=await attempt(sealed,{run:'run-old',total:120});await Authority.releaseLease(b2.env,b2.lease);
const full=await attempt(sealed,{run:'run-new',total:120,killAfterBatches:b2.batches-1});
assert.ok(full.killed,'the kill lands in the last batch, which is finish');
assert.equal(transfer(sealed).state,'loading');
assert.equal(count(sealed,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),120);
console.log('seal interruption: ledger reads fail closed, independent reads stay open, replay restarts without accumulated progress');
