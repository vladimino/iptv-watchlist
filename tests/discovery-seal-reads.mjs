// ADR 0091: reads that stay open while a ledger seal is loading, and everything that must stay closed.
// Production-like partial seal at small scale: most of the previous ledger is `retiring`, a few new rows are `active`.
// Local sqlite stand-ins only. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-reads-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let n=0;
const sql=(file,text)=>{const r=spawnSync('sqlite3',['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'r-'+(n++)+'.sqlite');const r=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const item=(key,start)=>({key,title:'T '+key,normalizedTitle:'t '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start,end:start+1000}],seenInLatestSnapshot:true,lastAiring:start});
const keys=count=>Array.from({length:count},(_,i)=>'k'+String(i).padStart(4,'0'));
const stream=(list)=>(async function*(){for(const key of list)yield item(key,Date.now()+3600000);})();
const film=id=>({id:'tmdb_'+id,tmdbId:String(id),canonicalIdentity:'tmdb:'+id,title:'Film '+id});

// A committed ledger of 120 observations, a catalog of 40 Films, decisions, a status and a continuation record.
async function committed(){
 const file=migrate();
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:'run-old',handoff:true,lease:taken.lease,items:stream(keys(120))});
 const films={};for(let id=1;id<=40;id++)films['tmdb_'+id]=film(id);
 await Authority.upsertAdmissions(env,films);
 await Authority.writeDecisionDelta(env,{k0001:{previous:null,next:{status:'no_confident_match',attempts:1,retryAt:'2026-12-01T00:00:00.000Z'}}});
 await Authority.routeWrite(env,'epg/discovery-status.json',{schemaVersion:2,stage:'partial',programmeRunId:'run-old',hopId:taken.lease.id});
 await Authority.routeWrite(env,'epg/resolver-continuation.json',{stage:'paused',reason:null,hopId:taken.lease.id,remainingChunks:10,programmeRunId:'run-old'});
 await Authority.releaseLease(env,taken.lease);
 return {file,env};
}
// A handoff the client cancelled after `batches` batches.
async function interruptedSeal(file,batches){
 let seen=0;
 const env={DB:d1Standin(file,{onBatch(){seen++;if(seen>batches)throw new Error('cancelled');}}),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await assert.rejects(()=>Authority.ingestLedger(env,{programmeRunId:'run-new',handoff:true,lease:taken.lease,items:stream(keys(120))}));
 sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 return env;
}
const read=file=>({env:{DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null}});

// 1. A loading ledger seal: the previous ledger is mostly `retiring`, a few new rows are `active`.
const {file,env:baseEnv}=await committed();
const before=(await Authority.routeRead(baseEnv,'epg/discovered-films.json'));
assert.equal(before.transfer,undefined,'a committed transfer carries no marker');
await interruptedSeal(file,3);
assert.equal(sql(file,'SELECT state FROM discovery_transfer')[0].state,'loading');
const retiring=Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE residence='retiring'")[0].n);
const active=Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_observation WHERE residence='active' AND programme_run_id='run-new'")[0].n);
assert.ok(retiring>active&&active>0,`production-like partial seal: ${retiring} retiring, ${active} active`);
const {env}=read(file);

// 2. The catalog, the status and the continuation are readable, identical to before the seal, and marked.
const catalog=await Authority.routeRead(env,'epg/discovered-films.json');
assert.equal(catalog.handled,true);
assert.equal(catalog.transfer,'loading');
assert.deepEqual(catalog.value,before.value,'the catalog is exactly what it was before the seal');
assert.equal(Object.keys(catalog.value).length,40);
const status=await Authority.routeRead(env,'epg/discovery-status.json');
assert.equal(status.transfer,'loading');assert.equal(status.value.programmeRunId,'run-old');
const continuation=await Authority.routeRead(env,'epg/resolver-continuation.json');
assert.equal(continuation.transfer,'loading');assert.equal(continuation.value.remainingChunks,10);
// The generation copy of the catalog is readable for the generation that is still authoritative, and empty for the new run.
const copy=await Authority.routeRead(env,'epg/generations/run-old/discovered-films.json');
assert.equal(copy.transfer,'loading');assert.equal(Object.keys(copy.value).length,40);
const other=await Authority.routeRead(env,'epg/generations/run-new/discovered-films.json');
assert.equal(other.value,null);

// 3. Everything that depends on the ledger or on its pairing stays closed.
for(const key of ['epg/discovery-resolution.json','epg/discovery-score-preview.json','epg/discovery-latest.json','epg/discovery-workflow.json','epg/generations/run-old/discovery-latest.json']){
 await assert.rejects(()=>Authority.routeRead(env,key),error=>error.code==='discovery_incomplete',key);
}
await assert.rejects(()=>Authority.readObservationPage(env,{}),error=>error.code==='discovery_incomplete');
await assert.rejects(()=>Authority.walkObservationPages(env,{onPage(){}}),error=>error.code==='discovery_incomplete');
await assert.rejects(()=>Authority.streamActiveLedger(env,()=>{}),error=>error.code==='discovery_incomplete');
await assert.rejects(()=>Authority.readObservationIndex(env),error=>error.code==='discovery_incomplete');

// 4. Every write stays closed, with a live lease and with none.
const writer=await Authority.acquireLease(env,{programmeRunId:null}).catch(error=>({error}));
assert.ok(writer.lease,'a replay may take the expired lease; its writes must still be refused');
{
 env.discoveryLease=writer.lease;
 await assert.rejects(()=>Authority.routeWrite(env,'epg/discovery-status.json',{schemaVersion:2}),error=>error.code==='discovery_incomplete');
 await assert.rejects(()=>Authority.writeDecisionDelta(env,{k0002:{previous:null,next:{status:'no_confident_match'}}}),error=>error.code==='discovery_incomplete'||error.code==='discovery_fence');
 await assert.rejects(()=>Authority.upsertAdmissions(env,{tmdb_99:film(99)}),error=>error.code==='discovery_incomplete'||error.code==='discovery_fence');
}
const stored=Number(sql(file,'SELECT COUNT(*) AS n FROM discovery_decision')[0].n);
assert.equal(stored,1,'no write landed');
assert.equal(Number(sql(file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE state='current'")[0].n),40);

// 5. A `loading` that is NOT a ledger seal stays fully closed: a catalog replace killed half way leaves admissions
// `pending`, and the same independent keys must then fail, because the catalog is torn.
const catalogCrash=await committed();
{
 let seen=0;
 const crashEnv={DB:d1Standin(catalogCrash.file,{onBatch(){seen++;if(seen>=3)throw new Error('cancelled');}}),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(crashEnv,{programmeRunId:null});
 crashEnv.discoveryLease=taken.lease;
 const bigger={};for(let id=1;id<=60;id++)bigger['tmdb_'+id]=film(id);
 await assert.rejects(()=>Authority.routeWrite(crashEnv,'epg/discovered-films.json',bigger));
 sql(catalogCrash.file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
}
assert.equal(sql(catalogCrash.file,'SELECT state FROM discovery_transfer')[0].state,'loading');
assert.ok(Number(sql(catalogCrash.file,"SELECT COUNT(*) AS n FROM discovery_admission WHERE state='pending'")[0].n)>0,'a half-replaced catalog');
const torn=read(catalogCrash.file).env;
for(const key of ['epg/discovered-films.json','epg/discovery-status.json','epg/resolver-continuation.json']){
 await assert.rejects(()=>Authority.routeRead(torn,key),error=>error.code==='discovery_incomplete',key);
}

// 6. When the seal finishes the marker disappears and reads are the ordinary ones.
const done=await committed();
const full=await interruptedSeal(done.file,3);
const finisher={DB:d1Standin(done.file),BUCKET:new MemoryBucket(),discoveryLease:null};
const lease=await Authority.acquireLease(finisher,{programmeRunId:null});
finisher.discoveryLease=lease.lease;
await Authority.ingestLedger(finisher,{programmeRunId:'run-new',handoff:true,lease:lease.lease,items:stream(keys(120))});
const after=await Authority.routeRead(finisher,'epg/discovered-films.json');
assert.equal(after.transfer,undefined);
assert.equal(Object.keys(after.value).length,40);
console.log('discovery seal reads ok');
