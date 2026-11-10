// ADR 0092: the resumable ledger seal job. Local sqlite stand-ins only; no Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-resume-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
let n=0;
const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'q-'+(n++)+'.sqlite');const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const item=(key,start,title='T')=>({key,title:title+' '+key,normalizedTitle:'t '+key,year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start,end:start+1000},{channelId:'d',channel:'D',start:start+5000,end:start+6000}],seenInLatestSnapshot:true,lastAiring:start});
const keyList=(from,to)=>Array.from({length:to-from},(_,i)=>'k'+String(from+i).padStart(5,'0'));
const entries=(list,title)=>list.map(key=>({item:item(key,Date.now()+3600000,title),bytes:JSON.stringify(item(key,0)).length+1}));
const one=(file,text)=>sql(file,text)[0];
const count=(file,where)=>Number(one(file,'SELECT COUNT(*) AS n FROM discovery_observation WHERE '+where).n);
const shows=(file,where)=>Number(one(file,'SELECT COUNT(*) AS n FROM discovery_observation_show WHERE '+where).n);
const seal=file=>one(file,'SELECT * FROM discovery_seal');
const transfer=file=>one(file,'SELECT state, programme_run_id FROM discovery_transfer');

// A committed ledger of 120 observations for the previous run, written by the old inline handoff.
async function committed(){
 const file=migrate();
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:'run-old',handoff:true,lease:taken.lease,items:(async function*(){for(const e of entries(keyList(0,120),'old'))yield e.item;})()});
 await Authority.releaseLease(env,taken.lease);
 return file;
}
const worker=(file,hooks={})=>({DB:d1Standin(file,hooks),BUCKET:new MemoryBucket(),discoveryLease:null});
async function lease(env,expireFirst=null){
 if(expireFirst)sql(expireFirst,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 assert.ok(taken.lease,'a lease must be taken');
 env.discoveryLease=taken.lease;
 return taken.lease;
}
// The new ledger: keys 20..219 (100 of them overlap the previous ledger; 20 old keys are not seen again).
const NEW=keyList(20,220),TOTAL=NEW.length;
async function begin(file,jobId='job-1',total=TOTAL){
 const env=worker(file);const l=await lease(env,file);
 const started=await Authority.sealBegin(env,{programmeRunId:'run-new',jobId,sourceKey:'epg/generations/run-new/discovery-latest.json',sourceEtag:'etag-1',itemTotal:total,startBytes:100,lease:l});
 return {env,lease:l,started};
}
// Writes everything from `from` on, one atomic batch at a time, through `env`.
async function writeFrom(env,list,from,{stopAfter=Infinity}={}){
 let cursor=from,batches=0;
 while(cursor<list.length&&batches<stopAfter){
  const result=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:cursor,items:entries(list.slice(cursor,cursor+40),'new')});
  cursor=result.cursorItems;batches++;
 }
 return cursor;
}
const invariant=(file)=>{
 // The cursor and the rows agree after every batch, whatever happened to a request.
 const s=seal(file);
 assert.equal(count(file,`source_key='active' AND residence='active' AND programme_run_id='run-new'`),Number(s.cursor_items),'rows equal cursor');
 assert.equal(shows(file,`source_key='active' AND observation_key IN (SELECT observation_key FROM discovery_observation WHERE residence='active' AND programme_run_id='run-new')`),2*Number(s.cursor_items),'two shows per written observation');
};

// 1. begin flips the previous ledger once and records the job; the same job begins again without flipping.
{
 const file=await committed();
 const {started}=await begin(file);
 assert.equal(started.resumed,false);
 assert.equal(count(file,"residence='retiring'"),120);
 assert.equal(transfer(file).state,'loading');
 assert.equal(seal(file).phase,'items');assert.equal(Number(seal(file).cursor_bytes),100);
 const env=worker(file);sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');const l=await lease(env);
 // Progress a little, then begin again with the same job: nothing is flipped back.
 const first=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,10),'new'),lease:l});
 assert.ok(first.written>0&&first.written<=10,'a batch holds as many items as the statement cap allows: '+first.written);
 const again=await Authority.sealBegin(env,{programmeRunId:'run-new',jobId:'job-1',sourceKey:'k',itemTotal:TOTAL,lease:l});
 assert.equal(again.resumed,true);
 assert.equal(again.cursorItems,first.written);
 invariant(file);
 assert.equal(count(file,"residence='retiring'"),120-first.written,'the written rows were retiring rows taken over; the rest are untouched');
}

// 2. A batch that dies writes nothing and moves no cursor; a resume continues from the cursor; the rows never drift.
{
 const file=await committed();
 await begin(file);
 let batches=0;
 const dying=worker(file,{onBatch(){batches++;if(batches===3)throw new Error('cancelled');}});
 const l=await lease(dying,file);
 let cursor=0;
 await assert.rejects(async()=>{while(cursor<TOTAL){const r=await Authority.sealWrite(dying,{jobId:'job-1',expectedCursor:cursor,items:entries(NEW.slice(cursor,cursor+40),'new'),lease:l});cursor=r.cursorItems;}});
 invariant(file);
 const atDeath=Number(seal(file).cursor_items);
 assert.ok(atDeath>0&&atDeath<TOTAL,'some batches landed before the kill: '+atDeath);
 // Resume in a new request after the lease expired: the cursor from D1, no replay from the start.
 const next=worker(file);const l2=await lease(next,file);
 const state=await Authority.sealState(next);
 assert.equal(state.cursorItems,atDeath);
 const end=await writeFrom(Object.assign(next,{discoveryLease:l2}),NEW,state.cursorItems);
 assert.equal(end,TOTAL);
 invariant(file);
}

// 3. An unknown outcome: the batch landed but the caller lost the answer. Repeating it is refused by the cursor, and the
// caller continues from the cursor it reads; nothing is written twice.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 const first=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'new'),lease:l});
 await assert.rejects(()=>Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'new'),lease:l}),error=>error.code==='discovery_fence');
 assert.equal((await Authority.sealState(env)).cursorItems,first.cursorItems);
 invariant(file);
}

// 4. Two writers race on the same cursor: one lands, the other is refused whole.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 const a=Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'new'),lease:l});
 const b=Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'other'),lease:l});
 const results=await Promise.allSettled([a,b]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1,'exactly one writer lands');
 invariant(file);
}

// 5. A generation that moves between the read and the commit refuses that batch; the retry with a fresh read lands.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 let bumped=false;
 const racing=worker(file,{onBatch(){if(!bumped){bumped=true;sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}}});
 racing.discoveryLease=l;
 await assert.rejects(()=>Authority.sealWrite(racing,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'new'),lease:l}),error=>error.code==='discovery_fence');
 assert.equal(Number(seal(file).cursor_items),0);
 const ok=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,30),'new'),lease:l});
 assert.ok(ok.written>0);
 invariant(file);
}

// 6. A stale lease or another job's id writes nothing.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 await assert.rejects(()=>Authority.sealWrite(env,{jobId:'job-other',expectedCursor:0,items:entries(NEW.slice(0,10),'new'),lease:l}),error=>error.code==='discovery_fence');
 sql(file,'UPDATE discovery_lease SET expires_at=1 WHERE id=1');
 await assert.rejects(()=>Authority.sealWrite(env,{jobId:'job-1',expectedCursor:0,items:entries(NEW.slice(0,10),'new'),lease:l}),error=>error.code==='discovery_fence');
 assert.equal(Number(seal(file).cursor_items),0);
}

// 7. Archive and commit: refused until every observation is written, bounded per call, and the commit is the last batch.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 await assert.rejects(()=>Authority.sealArchive(env,{jobId:'job-1',lease:l}),error=>error.code==='discovery_incomplete');
 await writeFrom(env,NEW,0);
 // The published ledger does not move before the commit.
 assert.equal(one(file,'SELECT programme_run_id AS p FROM discovery_authority').p,'run-old');
 let rounds=0,result;
 do{result=await Authority.sealArchive(env,{jobId:'job-1',lease:l,limit:7});rounds++;
  if(!result.committed){assert.equal(transfer(file).state,'loading');assert.equal(one(file,'SELECT programme_run_id AS p FROM discovery_authority').p,'run-old','not published before the commit');}
 }while(!result.committed&&rounds<50);
 assert.ok(result.committed);
 assert.equal(rounds,Math.ceil(20/7)+1,'20 retiring rows in batches of 7, then the commit');
 assert.equal(transfer(file).state,'committed');
 assert.equal(one(file,'SELECT programme_run_id AS p, published_programme_run_id AS q FROM discovery_authority').p,'run-new');
 assert.equal(count(file,"residence='retiring'"),0);
 assert.equal(count(file,"residence='archive'"),20);
 assert.equal(count(file,"source_key='active' AND residence='active'"),TOTAL);
 assert.equal(seal(file).phase,'done');
 // Shows follow their observations: archived ones keep their archive key, none is lost or duplicated.
 assert.equal(shows(file,"source_key='active'"),2*TOTAL);
 assert.equal(shows(file,"source_key LIKE 'archive:%'"),2*20);
 // The same job begun again after it is done changes nothing.
 const done=await Authority.sealBegin(env,{programmeRunId:'run-new',jobId:'job-1',sourceKey:'k',itemTotal:TOTAL,lease:l}).catch(error=>({error}));
 assert.ok(done.resumed||done.error);
}

// 8. The archive can die between its batches: a resume archives the rest and never flips the ledger again.
{
 const file=await committed();
 const {env,lease:l}=await begin(file);
 await writeFrom(env,NEW,0);
 await Authority.sealArchive(env,{jobId:'job-1',lease:l,limit:7});
 assert.equal(seal(file).phase,'archive');
 let armed=false;
 const dying=worker(file,{onBatch(){if(armed)throw new Error('cancelled');}});
 const l2=await lease(dying,file);
 armed=true;
 await assert.rejects(()=>Authority.sealArchive(dying,{jobId:'job-1',lease:l2,limit:7}));
 const next=worker(file);const l3=await lease(next,file);
 const again=await Authority.sealBegin(next,{programmeRunId:'run-new',jobId:'job-1',sourceKey:'k',itemTotal:TOTAL,lease:l3});
 assert.equal(again.resumed,true);assert.equal(again.phase,'archive');
 let result;do{result=await Authority.sealArchive(next,{jobId:'job-1',lease:l3,limit:7});}while(!result.committed);
 assert.equal(count(file,"residence='archive'"),20);assert.equal(count(file,"source_key='active' AND residence='active'"),TOTAL);
}

// 9. The incident shape: the old inline handoff was killed, `loading` with no job, most of the old ledger `retiring` and a
// few new rows `active`. A new job takes the expired lease, flips once more, writes the whole ledger and commits; the
// stranded rows are rewritten or retired, and decisions, admissions and history are not touched.
{
 const file=await committed();
 const killed=worker(file,{});const l0=await lease(killed);
 await Authority.upsertAdmissions(killed,{tmdb_1:{id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1',title:'F'}},{lease:l0}).catch(()=>{});
 await Authority.releaseLease(killed,l0);
 let seen=0;
 const dying=worker(file,{onBatch(){seen++;if(seen>3)throw new Error('cancelled');}});
 const l1=await lease(dying);
 await assert.rejects(()=>Authority.ingestLedger(dying,{programmeRunId:'run-new',handoff:true,lease:l1,items:(async function*(){for(const e of entries(NEW,'new'))yield e.item;})()}));
 assert.equal(transfer(file).state,'loading');
 assert.equal(seal(file).phase,'idle','the old handoff leaves no job');
 const before=one(file,'SELECT (SELECT COUNT(*) FROM discovery_decision) d, (SELECT COUNT(*) FROM discovery_admission) a, (SELECT COUNT(*) FROM discovery_decision_history) h');
 const {env,lease:l,started}=await begin(file,'job-1');
 assert.equal(started.resumed,false);
 await writeFrom(env,NEW,0);
 let result;do{result=await Authority.sealArchive(env,{jobId:'job-1',lease:l,limit:50});}while(!result.committed);
 assert.equal(count(file,"source_key='active' AND residence='active' AND programme_run_id='run-new'"),TOTAL);
 assert.equal(count(file,"residence='retiring'"),0);
 assert.deepEqual(one(file,'SELECT (SELECT COUNT(*) FROM discovery_decision) d, (SELECT COUNT(*) FROM discovery_admission) a, (SELECT COUNT(*) FROM discovery_decision_history) h'),before);
 // Reads are the ordinary ones again.
 const read=await Authority.routeRead(env,'epg/discovered-films.json');
 assert.equal(read.transfer,undefined);
}

// 10. Without the table the code reports the seal as unsupported and the old behaviour stands.
{
 const file=path.join(root,'v11.sqlite');
 const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.slice(0,11).map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 assert.equal(await Authority.sealSupported(env),false);
 assert.deepEqual(await Authority.sealState(env),{supported:false});
 // 0012 refuses anything below version 11.
 const low=path.join(root,'v10.sqlite');
 const p=sqliteSync(['-bail',low],{input:'PRAGMA foreign_keys=ON;\n'+chain.slice(0,10).map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n')+'\n'+fs.readFileSync('migrations/0012_discovery_seal.sql','utf8'),encoding:'utf8'});
 assert.notEqual(p.status,0,'0012 must refuse a version 10');
}

// 11. Volume: the incident's 20,064 observations take bounded batches, and a kill at any of them resumes. Set SEAL_FULL=1 to run it.
if(process.env.SEAL_FULL){
 const total=Number(process.env.SEAL_FULL)>1?Number(process.env.SEAL_FULL):20064;
 const file=await committed();
 const list=keyList(0,total);
 const env=worker(file);const l=await lease(env);
 await Authority.sealBegin(env,{programmeRunId:'run-new',jobId:'job-1',sourceKey:'k',itemTotal:total,lease:l});
 let cursor=0,batches=0;const started=Date.now();
 while(cursor<total){const r=await Authority.sealWrite(env,{jobId:'job-1',expectedCursor:cursor,items:entries(list.slice(cursor,cursor+60),'new'),lease:l});cursor=r.cursorItems;batches++;}
 console.log(JSON.stringify({total,batches,itemsPerBatch:Math.round(total/batches),ms:Date.now()-started}));
 let result;do{result=await Authority.sealArchive(env,{jobId:'job-1',lease:l,limit:2000});}while(!result.committed);
 assert.equal(count(file,"source_key='active' AND residence='active'"),total);
}
console.log('discovery seal resume ok');
