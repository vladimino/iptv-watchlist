// ADR 0185 decision 4 (with ADR 0175): the single completion batch of the D1 EPG checkpoint. Completion, the run certificate and the pause clear are ONE transaction; a
// certificate that does not match still lets the run complete and stays owed; and no route can certify before its queue attempt, because the certificate update itself
// requires the checkpoint to be complete with queue_attempted. Offline only: sqlite D1 stand-ins with the real migration chain, a memory bucket. Nothing calls Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import * as PublishedEpg from '../src/published-epg.js';
import * as Checkpoint from '../src/epg-checkpoint-d1.js';
import {madridInstant} from '../src/domain/orchestration-policy.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-checkpoint-certificate-'));
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=()=>{
 const file=path.join(root,'c-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file)};
};
const first=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const pause=db=>({...db.sql('SELECT state, owed_day_key AS owed, override_day_key AS override FROM discovery_epg_priority WHERE id=1')[0]});
const cert=db=>({...db.sql('SELECT programme_run_id AS run, madrid_run_key AS day, finalized_run_id AS finalized FROM published_epg_authority WHERE id=1')[0]});
const checkpoint=db=>({...db.sql('SELECT run_id AS run, stage, queue_attempted AS queued, watchlist_present AS present FROM epg_checkpoint_run WHERE id=1')[0]});
const envFor=db=>({DB:db,BUCKET:new MemoryBucket(),discoveryLease:null});
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
const D1='2026-11-12',D2='2026-11-13';
const at=(day,h,m=0)=>{clock=madridInstant(day,h,m);return clock;};
const iso=ms=>new Date(ms).toISOString();
const programme=run=>({runId:run,updatedAt:'2026-11-13T15:30:00.000Z',watchlistCount:0,films:[]});
const publish=(db,run,key,expected)=>PublishedEpg.publishGeneration({DB:db,BUCKET:new MemoryBucket()},{programmeRunId:run,phase:'published',expectedProgrammeRunId:expected,madridRunKey:key,programme:programme(run),watchlist:{updatedAt:programme(run).updatedAt,films:[]}},{now:0});
const setMode=db=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','{\"schemaVersion\":1,\"mode\":\"cloudflare\",\"epoch\":1}',3,'x')");
const setLease=db=>db.sql("INSERT OR REPLACE INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('lease','"+JSON.stringify({schemaVersion:1,holder:'h1',kind:'executor',modeRevision:3,acquiredAt:iso(clock),expiresAt:iso(clock+60000),released:false})+"',1,'x')");
const ctx=()=>({step:{holder:'h1',modeRevision:3},fence:{revision:3},leaseBound:iso(clock+5000),now:clock});
const T='2026-11-13T15:00:00.000Z';
const film=i=>({id:'f'+i,title:'Film '+i});

// The state of the 13 Nov run: the previous run's pointer, the pause closed at 16:55, then the run-2 pointer published (the certificate not yet written).
const pointerPublished=async(marker)=>{
 const made=migrated();
 made.db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='run-1', madrid_run_key='"+D1+"' WHERE id=1");
 made.db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-1', published_programme_run_id='run-1' WHERE id=1");
 const env=envFor(made.db);
 at(D2,16,56);
 assert.equal((await Authority.acquireLease(env,{programmeRunId:'run-1'})).busy.kind,'epg_priority');
 made.db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
 await publish(made.db,'run-2',D2,'run-1');
 setMode(made.db);setLease(made.db);
 made.db.sql("UPDATE epg_checkpoint_authority SET mode='"+marker+"',generation=1 WHERE id=1");
 return {...made,env};
};
// The run reaches the queue phase of the seal through the real repository: created, then saved forward.
const atQueue=async(db,runId='run-2')=>{
 setLease(db); // the step lease the run's steps hold at the current instant
 const run={runId,startedAt:T,runKey:D2,updatedAt:T,stage:'metadata',watchlist:[film(0),film(1)],pending:[],failures:[]};
 assert.equal((await Checkpoint.createRun(db,run,{...ctx(),attempt:{id:'a-'+runId,startedAt:T}})).ok,true);
 const loaded=(await Checkpoint.loadRun(db)).run;
 loaded.stage='seal';loaded.seal={phase:'queue',jobId:'j'};
 assert.equal((await Checkpoint.saveRun(db,loaded,ctx())).ok,true);
 return loaded;
};
const finish=run=>{run.stage='complete';run.completedAt=T;run.updatedAt=T;delete run.watchlist;delete run.pending;delete run.seal;return run;};
const certifyStatements=(run='run-2',day=D2)=>PublishedEpg.certifyUpdateStatements({programmeRunId:run,madridRunKey:day,now:clock});

// 1. One transaction: the checkpoint completes, the film rows go, the run is certified and the pause is cleared. Discovery is admitted afterwards, not before.
{
 const {db,env}=await pointerPublished('d1');
 assert.deepEqual(pause(db),{state:'paused',owed:D2,override:null},'the pointer batch left the pause closed');
 at(D2,17,5);
 assert.equal((await Authority.acquireLease(env,{programmeRunId:'run-2'})).busy.kind,'epg_priority','awaiting complete: the pointer alone does not admit Discovery');
 const run=await atQueue(db);
 assert.deepEqual(cert(db),{run:'run-2',day:D2,finalized:null},'queue phase: nothing certified yet');
 finish(run);
 const out=await Checkpoint.completeRun(db,run,{...ctx(),queueAttempted:true,certify:certifyStatements()});
 assert.equal(out.ok,true);
 assert.deepEqual(checkpoint(db),{run:'run-2',stage:'complete',queued:1,present:0});
 assert.equal(first(db,'SELECT COUNT(*) FROM epg_checkpoint_film'),0);
 assert.deepEqual(cert(db),{run:'run-2',day:D2,finalized:'run-2'},'the certificate is written in the completion batch');
 assert.deepEqual(pause(db),{state:'clear',owed:null,override:null},'and the pause is cleared in the same batch');
 assert.ok((await Authority.acquireLease(env,{programmeRunId:'run-2'})).lease,'Discovery is admitted for the certified run');
 assert.equal((await PublishedEpg.readCertificate({DB:db})).finalizedRunId,'run-2');
}

// 2. A certificate that does not match: the run still completes, the certificate and the pause stay as they were, and the repair certifies it later.
{
 const {db,env}=await pointerPublished('d1');
 at(D2,17,5);
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-9' WHERE id=1");
 const run=finish(await atQueue(db));
 const out=await Checkpoint.completeRun(db,run,{...ctx(),queueAttempted:true,certify:certifyStatements()});
 assert.equal(out.ok,true,'a non-matching certificate does not stop the completion');
 assert.equal(checkpoint(db).stage,'complete');
 assert.equal(cert(db).finalized,null,'nothing was certified: the pointer names another run');
 assert.deepEqual(pause(db),{state:'paused',owed:D2,override:null});
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-2' WHERE id=1");
 const repaired=await PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+5000),now:clock});
 assert.equal(repaired.certified,true,'the repair of a complete checkpoint certifies it');
 assert.deepEqual(pause(db),{state:'clear',owed:null,override:null});
 assert.ok((await Authority.acquireLease(env,{programmeRunId:'run-2'})).lease);
}

// 3. No route certifies before its queue attempt: the certificate update requires `queue_attempted`, so the repair of an incomplete checkpoint writes nothing.
{
 const {db}=await pointerPublished('d1');
 at(D2,17,5);
 await atQueue(db);
 await assert.rejects(PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+5000),now:clock}),error=>error.code==='published_epg_fence','the checkpoint is still in the seal queue phase');
 assert.equal(cert(db).finalized,null);assert.equal(pause(db).state,'paused');
 // a checkpoint that completed without a certify statement (as a failed or skipped certificate leaves it) is repaired
 const run=(await Checkpoint.loadRun(db)).run;finish(run);
 assert.equal((await Checkpoint.completeRun(db,run,{...ctx(),queueAttempted:true,certify:[]})).ok,true);
 assert.equal(cert(db).finalized,null);
 assert.equal((await PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+5000),now:clock})).certified,true);
}
{
 // the checkpoint names ANOTHER run: a certificate for run-2 is refused even though the pointer names run-2
 const {db}=await pointerPublished('d1');
 at(D2,17,5);
 const run=finish(await atQueue(db,'run-3'));
 assert.equal((await Checkpoint.completeRun(db,run,{...ctx(),queueAttempted:true,certify:certifyStatements('run-2')})).ok,true);
 assert.equal(cert(db).finalized,null,'the update asks for the checkpoint of run-2 and finds run-3');
 await assert.rejects(PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+5000),now:clock}),error=>error.code==='published_epg_fence');
}

// 4. The checkpoint marker `r2` (today's behaviour): the repair needs no checkpoint row, exactly as in ADR 0175.
{
 const {db}=await pointerPublished('r2');
 at(D2,17,5);setLease(db);
 assert.equal(first(db,'SELECT COUNT(*) FROM epg_checkpoint_run'),0);
 assert.equal((await PublishedEpg.certifyRun({DB:db},{programmeRunId:'run-2',madridRunKey:D2,epgFence:{revision:3},step:{holder:'h1',modeRevision:3},leaseBound:iso(clock+5000),now:clock})).certified,true,'r2 mode: unchanged');
}

// 5. A lost lease between the preflight and the completion batch writes nothing: no completion, no certificate, no pause clear.
{
 const {db}=await pointerPublished('d1');
 at(D2,17,5);
 const run=finish(await atQueue(db));
 db.sql("UPDATE epg_orchestration_document SET body=json_set(body,'$.holder','someone-else') WHERE key='lease'");
 const out=await Checkpoint.completeRun(db,run,{...ctx(),queueAttempted:true,certify:certifyStatements()});
 assert.equal(out.ok,false);assert.equal(out.reason,'conflict');
 assert.equal(checkpoint(db).stage,'seal');assert.equal(cert(db).finalized,null);assert.equal(pause(db).state,'paused');
 assert.equal(first(db,'SELECT COUNT(*) FROM epg_checkpoint_film'),2,'the working set was not removed');
}

// 6. certifyUpdateStatements: a bad day or run id is refused, the pause clear is optional.
{
 assert.throws(()=>PublishedEpg.certifyUpdateStatements({programmeRunId:'',madridRunKey:D2}),error=>error.code==='published_epg_programme');
 assert.throws(()=>PublishedEpg.certifyUpdateStatements({programmeRunId:'r',madridRunKey:'yesterday'}),error=>error.code==='published_epg_certify_day');
 assert.equal(PublishedEpg.certifyUpdateStatements({programmeRunId:'r',madridRunKey:D2,pause:false}).length,1);
 assert.equal(PublishedEpg.certifyUpdateStatements({programmeRunId:'r',madridRunKey:D2}).length,2);
 assert.match(PublishedEpg.certifyUpdateStatements({programmeRunId:'r',madridRunKey:D2})[0][0],/epg_checkpoint_run[^)]*stage='complete' AND queue_attempted=1/);
}
Date.now=realNow;
console.log('EPG checkpoint certificate (ADR 0185): one completion batch, non-matching certificate still completes, no certificate before the queue attempt, r2 unchanged, lost lease writes nothing');
