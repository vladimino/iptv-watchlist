// AIR-374 S4-3 (ADR 0128): the DORMANT store layer of the durable EPG producer pass (src/canonical-producer-store.js) on the sqlite3-CLI D1 stand-in with the real migration chain (the tables, CHECKs and triggers of 0020). No Worker, R2, D1
// or Cloudflare access. Covered: dormancy below `open` (one marker read, nothing written), create / resume / replay by compare-and-set, parallel planners converging on one row, the slice commit as ONE batch (cursor, results, counts), a lost
// compare-and-set and a refused row leaving nothing partial, strikes touching only their columns, the pass-complete commit as the only writer of `applied_generation`, a systemic stop touching no strike, the dictionary version line (reuse, A-B-A
// gives three versions, a lost race), the due results and the terminal settle, the marker fence, and the static dormancy. PRODUCER_STORE_SRC points the file at a mutant copy of src/; PRODUCER_STORE_TEMPLATE at a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.PRODUCER_STORE_SRC?path.resolve(process.env.PRODUCER_STORE_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const S=await load('canonical-producer-store.js');
const R=await load('canonical-producer-run.js');
const {writerRoute}=await load('canonical-writer-route.js');
const {openEpgRun,mintDictionaryRun,commitStrike,commitSlice,commitPassComplete,commitStop,settleResult,dueResults,readRun,liveResult,latestDictionaryRun,SLICE_STATEMENT_CAP}=S;
const {planFingerprint,strikeStep,failureWrite,NO_STRIKE}=R;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-store-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const template=path.join(root,'template.sqlite');
if(process.env.PRODUCER_STORE_TEMPLATE)fs.copyFileSync(process.env.PRODUCER_STORE_TEMPLATE,template);
else{
 const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(sqlite(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
}
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
let n=0;
function database(stage='open'){
 const file=path.join(root,'s-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 if(['r2','prepared','open','held'].includes(stage))assert.equal(sqlite(file,VERIFY).status,0);
 if(['prepared','open','held'].includes(stage))assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1").status,0);
 if(stage==='open'||stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1").status,0);
 if(stage==='held')assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);
 return file;
}
const envOf=(file,options)=>({DB:d1Standin(file,options)});
const code=expected=>error=>error.code===expected;
const T='2026-11-13T10:00:00.000Z';
const T2='2026-11-13T10:01:00.000Z';
const hex=c=>c.repeat(64);
const GEN='gen-285';
const unitsOf=count=>Array.from({length:count},(_,i)=>({kind:'film_facts',id:'film:tmdb:'+(100+i),unitDigest:hex(String.fromCharCode(97+i))}));
const fingerprintOf=async(units,event='run-1')=>planFingerprint({origin:'epg',event,units});
const TABLES=['canonical_producer_run','canonical_producer_unit_result'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3,4,5')]));
const open=async(file,over={})=>{
 const units=over.units||unitsOf(3);
 return openEpgRun(envOf(file),{runKey:'run-1',sourceGeneration:GEN,fingerprint:await fingerprintOf(units),units,at:T,...over});
};

// 1. Dormant below open: ONE marker read and nothing else; held throws and never falls back.
for(const stage of ['legacy','r2','prepared']){
 const file=database(stage),before=dump(file),env=envOf(file);
 const probe=envOf(file);await writerRoute(probe);
 assert.deepEqual(await openEpgRun(env,{runKey:'run-1',sourceGeneration:GEN,fingerprint:await fingerprintOf(unitsOf(2)),units:unitsOf(2),at:T}),{state:'skipped',reason:'projector_is_writer'},stage);
 assert.equal(env.DB.calls.queries,probe.DB.calls.queries,'exactly the marker read ('+stage+')');
 assert.equal(env.DB.calls.batches,0);
 for(const call of [()=>mintDictionaryRun(env,{snapshotDigest:hex('a'),fingerprint:hex('b'),unitCount:0,at:T}),()=>commitStrike(env,{run:{origin:'epg',run_key:'x',revision:1},next:{strike_count:1},at:T}),()=>commitSlice(env,{run:{origin:'epg',run_key:'x',revision:1},next:{cursor_kind:'film_facts',cursor_id:'film:a'},at:T}),()=>commitPassComplete(env,{run:{origin:'epg',run_key:'x',revision:1,source_generation:GEN},openAtCompletion:0,at:T}),()=>commitStop(env,{run:{origin:'epg',run_key:'x',revision:1},stoppedBy:'film_person_unavailable',at:T}),()=>settleResult(env,{row:{state:'open',attempts:1,origin:'epg',run_key:'x',pass_no:1,kind:'film_facts',unit_id:'film:a'},state:'settled',settledBy:'applied',at:T})])
  assert.deepEqual(await call(),{state:'skipped',reason:'projector_is_writer'},stage);
 assert.equal(dump(file),before,'nothing written at '+stage);
}
{
 const file=database('held'),before=dump(file);
 await assert.rejects(open(file),code('film_person_held'));
 assert.equal(dump(file),before);
}

// 2. Create, resume and replay by compare-and-set.
{
 const file=database();
 const units=unitsOf(3);
 const first=await open(file,{units});
 assert.equal(first.state,'created');assert.equal(first.startIndex,0);
 assert.deepEqual([first.run.origin,first.run.run_key,first.run.source_generation,first.run.pass_no,first.run.unit_count,first.run.pass_state,first.run.revision,first.run.marker_generation,first.run.strike_count],['epg','run-1',GEN,1,3,'passing',1,2,0]);
 // the same plan again, and from a parallel planner: ONE row, resumed
 const again=await open(file,{units,at:T2});
 assert.equal(again.state,'resume');assert.equal(again.run.revision,1);
 assert.equal(Number(one(file,'SELECT COUNT(*) FROM canonical_producer_run')),1,'parallel planners converge on one row');
 // a changed plan: one compare-and-set, pass_no + 1, cursor and strike cleared
 const changed=unitsOf(4);
 const replay=await open(file,{units:changed,fingerprint:await fingerprintOf(changed),at:T2});
 assert.equal(replay.state,'replay');assert.equal(replay.startIndex,0);
 assert.deepEqual([replay.run.pass_no,replay.run.fingerprint===await fingerprintOf(changed),replay.run.unit_count,replay.run.cursor_id,replay.run.strike_count,replay.run.pass_state,replay.run.revision],[2,true,4,null,0,'passing',2]);
 // the first plan again is another change (pass 3), never a silent resume of the old cursor
 const back=await open(file,{units,at:T2});
 assert.equal(back.state,'replay');assert.equal(back.run.pass_no,3);
}
{
 // resume after a cursor: the start index is the first unit strictly after it
 const file=database(),units=unitsOf(4);
 const created=await open(file,{units});
 await commitSlice(envOf(file),{run:created.run,next:{cursor_kind:'film_facts',cursor_id:units[1].id},counts:{applied:2},at:T2});
 const resumed=await open(file,{units,at:T2});
 assert.equal(resumed.state,'resume');assert.equal(resumed.startIndex,2);
 assert.equal(resumed.run.n_applied,2);
}
{
 // a plan with a different source generation under the same run key cannot move the generation; a passed run with an applied claim is never replayed
 const file=database(),units=unitsOf(2);
 const created=await open(file,{units});
 await commitPassComplete(envOf(file),{run:created.run,openAtCompletion:0,at:T2});
 await assert.rejects(open(file,{units:unitsOf(3),fingerprint:await fingerprintOf(unitsOf(3)),at:T2}),code('producer_cas_lost'));
 assert.equal((await readRun(envOf(file),{origin:'epg',runKey:'run-1'})).pass_no,1);
}

{
 // a replay clears an ACTIVE strike and the cursor with it
 const file=database(),units=unitsOf(3),env=envOf(file);
 const {run}=await open(file,{units});
 const unit={kind:'film_facts',id:units[0].id,digest:units[0].unitDigest};
 const struck=await commitStrike(env,{run,next:strikeStep(run,{type:'unit_failed',unit,error:{code:'identity_collision'}}).run,at:T2});
 assert.equal(struck.run.strike_count,1);
 const changed=unitsOf(4);
 const replay=await open(file,{units:changed,fingerprint:await fingerprintOf(changed),at:T2});
 assert.deepEqual([replay.state,replay.run.strike_count,replay.run.strike_id,replay.run.strike_kind,replay.run.strike_digest,replay.run.strike_class],['replay',0,null,null,null,null]);
}

// 3. The slice commit is ONE batch: cursor, results and counts together; a lost compare-and-set and a refused row leave nothing partial.
{
 const file=database(),units=unitsOf(3),env=envOf(file);
 const {run}=await open(file,{units});
 const unit={kind:'film_facts',id:units[0].id,digest:units[0].unitDigest};
 const write=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit,state:'refused_permanent',code:'film_person_invalid',at:T2});
 const sizes=[];
 const counted=envOf(file,{onBatch:async statements=>{sizes.push(statements.length);}});
 const out=await commitSlice(counted,{run,next:{cursor_kind:unit.kind,cursor_id:unit.id},writes:[write],counts:{applied:1,noop:2,kept:3,failed:1},at:T2});
 assert.equal(counted.DB.calls.batches,1,'ONE batch');
 assert.equal(out.run.revision,2);assert.deepEqual([out.run.cursor_kind,out.run.cursor_id,out.run.n_applied,out.run.n_noop,out.run.n_kept,out.run.n_failed],[unit.kind,unit.id,1,2,3,1]);
 const live=await liveResult(env,{origin:'epg',runKey:'run-1',kind:unit.kind,unitId:unit.id});
 assert.deepEqual([live.state,live.code,live.attempts,live.retry_owner,live.next_attempt_at,live.fingerprint],['refused_permanent','film_person_invalid',1,'unit',null,run.fingerprint]);
 // a stale run revision: lost compare-and-set, NOTHING written (not the result, not the cursor)
 const before=dump(file);
 const next=units[1];
 const w2=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit:{kind:next.kind,id:next.id,digest:next.unitDigest},state:'refused_permanent',code:'film_person_invalid',at:T2});
 await assert.rejects(commitSlice(envOf(file),{run,next:{cursor_kind:next.kind,cursor_id:next.id},writes:[w2],at:T2}),code('producer_cas_lost'));
 assert.equal(dump(file),before,'a lost compare-and-set writes nothing');
 // a refused row (a second live result for the same unit): the WHOLE batch rolls back, the cursor does not move
 const dup=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit,state:'refused_permanent',code:'film_person_invalid',at:T2});
 await assert.rejects(commitSlice(envOf(file),{run:out.run,next:{cursor_kind:next.kind,cursor_id:next.id},writes:[dup],at:T2}),code('producer_slice_commit_failed'));
 assert.equal(dump(file),before,'a refused row leaves cursor, counts and results unchanged');
 // the cursor never goes backwards (the SQL strike and cursor guards plus the pure module); an empty or malformed slice is invalid
 await assert.rejects(commitSlice(envOf(file),{run:out.run,next:{cursor_kind:null,cursor_id:null},at:T2}),code('film_person_invalid'));
 await assert.rejects(commitSlice(envOf(file),{run:out.run,next:{cursor_kind:'film_facts',cursor_id:'film:z'},counts:{applied:-1},at:T2}),code('film_person_invalid'));
 // the statement cap
 const many=Array.from({length:SLICE_STATEMENT_CAP},(_,i)=>({insert:failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit:{kind:'film_facts',id:'film:cap:'+i,digest:hex('c')},state:'refused_permanent',code:'film_person_invalid',at:T2}).insert}));
 await assert.rejects(commitSlice(envOf(file),{run:out.run,next:{cursor_kind:'film_facts',cursor_id:'film:z'},writes:many,at:T2}),code('film_person_bounded'));
 assert.equal(dump(file),before);
}
{
 // a replaced live result of another digest is superseded in the same batch (source changed) and the new row inserted under the NEW pass (a digest change is a plan change: pass_no + 1)
 const file=database(),units=unitsOf(2),env=envOf(file);
 const {run}=await open(file,{units});
 const base={origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,state:'open',code:'identity_collision',at:T};
 const unitA={kind:'film_facts',id:units[0].id,digest:hex('a')};
 await commitSlice(env,{run,next:{cursor_kind:unitA.kind,cursor_id:unitA.id},writes:[failureWrite(null,{...base,unit:unitA})],at:T});
 const live=await liveResult(env,{origin:'epg',runKey:'run-1',kind:unitA.kind,unitId:unitA.id});
 const changed=[{...units[0],unitDigest:hex('d')},units[1]];
 const replay=await open(file,{units:changed,fingerprint:await fingerprintOf(changed),at:T2});
 assert.equal(replay.run.pass_no,2);
 const unitB={...unitA,digest:hex('d')};
 const write=failureWrite(live,{...base,passNo:2,fingerprint:replay.run.fingerprint,unit:unitB,at:T2});
 assert.ok(write.supersede&&write.insert);
 const second=await commitSlice(env,{run:replay.run,next:{cursor_kind:unitA.kind,cursor_id:unitA.id},writes:[write],at:T2});
 assert.equal(second.run.revision,4);
 const all=rows(file,"SELECT pass_no,unit_digest,state,settled_by FROM canonical_producer_unit_result ORDER BY pass_no");
 assert.deepEqual(all.map(row=>[row.pass_no,row.unit_digest,row.state,row.settled_by]),[[1,hex('a'),'superseded','source_changed'],[2,hex('d'),'open',null]]);
 assert.equal((await liveResult(env,{origin:'epg',runKey:'run-1',kind:unitA.kind,unitId:unitA.id})).unit_digest,hex('d'),'one live row per unit');
}

// 4. Strikes touch only the strike columns, count up while the identity is unchanged, and a systemic stop touches none.
{
 const file=database(),units=unitsOf(2),env=envOf(file);
 const {run}=await open(file,{units});
 const unit={kind:'film_facts',id:units[0].id,digest:units[0].unitDigest};
 const s1=strikeStep(run,{type:'unit_failed',unit,error:{code:'identity_collision'}});
 assert.equal(s1.action,'strike');
 const c1=await commitStrike(env,{run,next:s1.run,at:T2});
 assert.deepEqual([c1.run.strike_count,c1.run.strike_kind,c1.run.strike_id,c1.run.cursor_id,c1.run.revision],[1,unit.kind,unit.id,null,2],'only the strike columns moved');
 const s2=strikeStep(c1.run,{type:'unit_failed',unit,error:{code:'identity_collision'}});
 const c2=await commitStrike(env,{run:c1.run,next:s2.run,at:T2});
 assert.equal(c2.run.strike_count,2);
 // a stale revision loses the compare-and-set
 await assert.rejects(commitStrike(env,{run:c1.run,next:s2.run,at:T2}),code('producer_cas_lost'));
 // a decrement is refused by the SQL guard, as a strike failure; a count outside 1..2 is invalid before any write
 const before=dump(file);
 await assert.rejects(commitStrike(env,{run:c2.run,next:{...c2.run,strike_count:1},at:T2}),code('producer_strike_commit_failed'));
 await assert.rejects(commitStrike(env,{run:c2.run,next:{...c2.run,strike_count:3},at:T2}),code('film_person_invalid'));
 await assert.rejects(commitStrike(env,{run:c2.run,next:{...c2.run,strike_count:0},at:T2}),code('film_person_invalid'));
 assert.equal(dump(file),before);
 // the third strike: ONE batch writes the result row, passes the cursor and clears the strike
 const s3=strikeStep(c2.run,{type:'unit_failed',unit,error:{code:'identity_collision'}});
 assert.equal(s3.action,'third_strike');
 const write=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit,state:s3.result.state,code:s3.result.code,attempts:s3.result.attempts,at:T2});
 const out=await commitSlice(env,{run:c2.run,next:s3.run,writes:[write],counts:{failed:1},at:T2});
 assert.deepEqual([out.run.strike_count,out.run.strike_id,out.run.cursor_id,out.run.n_failed],[0,null,unit.id,1]);
 const live=await liveResult(env,{origin:'epg',runKey:'run-1',kind:unit.kind,unitId:unit.id});
 assert.deepEqual([live.state,live.attempts,live.code],['open',3,'identity_collision']);
 assert.ok(live.next_attempt_at,'an execution failure carries its schedule');
}
{
 // a systemic stop touches NO strike and NO cursor, and the SQL refuses a stop that does
 const file=database(),units=unitsOf(2),env=envOf(file);
 const {run}=await open(file,{units});
 const unit={kind:'film_facts',id:units[0].id,digest:units[0].unitDigest};
 const c1=await commitStrike(env,{run,next:strikeStep(run,{type:'unit_failed',unit,error:{code:'identity_collision'}}).run,at:T2});
 const stopped=await commitStop(env,{run:c1.run,stoppedBy:'film_person_unavailable',at:T2});
 assert.deepEqual([stopped.run.pass_state,stopped.run.stopped_by,stopped.run.strike_count,stopped.run.strike_id,stopped.run.cursor_id],['stopped','film_person_unavailable',1,unit.id,null]);
 await assert.rejects(commitStop(env,{run:stopped.run,stoppedBy:'Bad Code',at:T2}),code('film_person_invalid'));
 // a stop that touches a strike is refused by the SQL guard
 const rowBefore=dump(file);
 assert.equal(sqlite(file,"UPDATE canonical_producer_run SET strike_count=0,strike_kind=NULL,strike_id=NULL,strike_digest=NULL,strike_class=NULL,revision=revision+1 WHERE origin='epg'").status!==0,true);
 assert.equal(dump(file),rowBefore);
}

// 5. The pass-complete commit is the only writer of applied_generation, and a second claim is refused.
{
 const file=database(),units=unitsOf(2),env=envOf(file);
 const {run}=await open(file,{units});
 const done=await commitPassComplete(env,{run,openAtCompletion:2,at:T2});
 assert.deepEqual([done.run.pass_state,done.run.applied_generation,done.run.source_generation,done.run.open_at_completion,done.run.completed_at],['passed',GEN,GEN,2,T2]);
 await assert.rejects(commitPassComplete(env,{run,openAtCompletion:0,at:T2}),code('producer_cas_lost'));
 await assert.rejects(commitPassComplete(env,{run:{...done.run,origin:'dictionary'},openAtCompletion:0,at:T2}),code('film_person_invalid'));
 await assert.rejects(commitPassComplete(env,{run:done.run,openAtCompletion:-1,at:T2}),code('film_person_invalid'));
 // no other path sets the claim: a slice commit leaves it untouched
 const fresh=await open(database(),{units});
 assert.equal(fresh.run.applied_generation,null);
}

// 6. The dictionary version line: reuse on an equal digest, A, B, A gives three versions, a lost race re-reads.
{
 const file=database(),env=envOf(file);
 const mint=digest=>mintDictionaryRun(envOf(file),{snapshotDigest:digest,fingerprint:hex('f'),unitCount:5,at:T});
 const a=await mint(hex('a'));
 assert.deepEqual([a.state,a.run.run_key,a.run.seq,a.run.prev_seq],['minted','d1',1,0]);
 const again=await mint(hex('a'));
 assert.deepEqual([again.state,again.run.run_key],['reuse','d1'],'an equal digest never mints');
 const b=await mint(hex('b'));
 assert.deepEqual([b.state,b.run.run_key,b.run.prev_seq],['minted','d2',1]);
 assert.equal((await readRun(env,{origin:'dictionary',runKey:'d1'})).pass_state,'superseded','the previous version is superseded');
 const back=await mint(hex('a'));
 assert.deepEqual([back.state,back.run.run_key],['minted','d3'],'a revert is a genuine new version');
 assert.equal((await latestDictionaryRun(env)).seq,3);
 assert.deepEqual(rows(file,"SELECT run_key FROM canonical_producer_run WHERE origin='dictionary' ORDER BY seq").map(row=>row.run_key),['d1','d2','d3']);
 // the SQL guard refuses a gap and an equal-digest mint even if the code were wrong
 assert.notEqual(sqlite(file,"INSERT INTO canonical_producer_run (origin,run_key,seq,prev_seq,snapshot_digest,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('dictionary','d9',9,8,'"+hex('c')+"',1,1,'"+hex('f')+"',1,'passing',2,1,'"+T+"','"+T+"')").status,0,'a gap is refused');
 assert.notEqual(sqlite(file,"INSERT INTO canonical_producer_run (origin,run_key,seq,prev_seq,snapshot_digest,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('dictionary','d4',4,3,'"+hex('a')+"',1,1,'"+hex('f')+"',1,'passing',2,1,'"+T+"','"+T+"')").status,0,'an equal-digest mint is refused');
}
{
 // a lost race: another planner mints d1 between the read and the INSERT; the loser re-reads and reuses (same digest) or mints the next version (different digest)
 for(const [digest,expected] of [[hex('a'),['reuse','d1']],[hex('b'),['minted','d2']]]){
  const file=database();
  let raced=false;
  const env=envOf(file,{onBatch:async statements=>{
   if(!raced&&statements.some(item=>/INSERT INTO canonical_producer_run/.test(item.text))){
    raced=true;
    assert.equal(sqlite(file,"INSERT INTO canonical_producer_run (origin,run_key,seq,prev_seq,snapshot_digest,pass_no,plan_version,fingerprint,unit_count,pass_state,marker_generation,revision,created_at,updated_at) VALUES ('dictionary','d1',1,0,'"+hex('a')+"',1,1,'"+hex('f')+"',1,'passing',2,1,'"+T+"','"+T+"')").status,0);
   }
  }});
  const out=await mintDictionaryRun(env,{snapshotDigest:digest,fingerprint:hex('f'),unitCount:5,at:T});
  assert.deepEqual([out.state,out.run.run_key],expected,'lost race, '+digest.slice(0,1));
  assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_producer_run WHERE origin='dictionary' AND run_key='d1'")),1);
 }
}

// 7. Due results and the terminal settle.
{
 const file=database(),units=unitsOf(4),env=envOf(file);
 const {run}=await open(file,{units});
 let current=run;
 const results=[];
 for(let i=0;i<3;i++){
  const unit={kind:'film_facts',id:units[i].id,digest:units[i].unitDigest};
  const at='2026-11-13T10:0'+i+':00.000Z';
  const w=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit,state:i===2?'refused_recoverable':'open',code:i===2?'no_identity_row':'identity_collision',prereqStamp:i===2?hex('9'):null,at});
  current=(await commitSlice(env,{run:current,next:{cursor_kind:unit.kind,cursor_id:unit.id},writes:[w],counts:{applied:1,failed:1},at})).run;
  results.push(w.insert);
 }
 assert.deepEqual([current.n_applied,current.n_failed],[3,3],'every slice adds its counts');
 // a refused_permanent row is never due
 const perm=failureWrite(null,{origin:'epg',runKey:'run-1',passNo:1,fingerprint:run.fingerprint,unit:{kind:'film_facts',id:units[3].id,digest:units[3].unitDigest},state:'refused_permanent',code:'film_person_invalid',at:T});
 await commitSlice(env,{run:current,next:{cursor_kind:'film_facts',cursor_id:units[3].id},writes:[perm],at:T2});
 const due=await dueResults(env,{now:'2026-11-13T12:00:00.000Z'});
 assert.equal(due.length,3,'the permanent refusal is never due');
 assert.ok(due.every((row,i)=>i===0||due[i-1].next_attempt_at<=row.next_attempt_at),'ordered by next_attempt_at');
 assert.equal((await dueResults(env,{now:'2026-11-13T12:00:00.000Z',limit:1})).length,1,'limited');
 assert.equal((await dueResults(env,{now:'2026-11-13T10:00:30.000Z'})).length,0,'nothing is due before its time');
 await assert.rejects(dueResults(env,{now:'tomorrow'}),code('film_person_invalid'));
 // settle: compare-and-set on state and attempts
 const target=due[0];
 await assert.rejects(settleResult(env,{row:{...target,attempts:target.attempts+1},state:'settled',settledBy:'applied',at:T2}),code('producer_cas_lost'));
 await assert.rejects(settleResult(env,{row:{...target,state:'settled'},state:'settled',settledBy:'applied',at:T2}),code('film_person_invalid'),'a terminal row never reopens or settles again');
 await assert.rejects(settleResult(env,{row:target,state:'open',settledBy:'applied',at:T2}),code('film_person_invalid'));
 const settled=await settleResult(env,{row:target,state:'settled',settledBy:'applied',at:T2});
 assert.equal(settled.state,'committed');
 const after=rows(file,"SELECT state,settled_by,settled_at,next_attempt_at FROM canonical_producer_unit_result WHERE unit_id='"+target.unit_id+"'")[0];
 assert.deepEqual([after.state,after.settled_by,after.settled_at,after.next_attempt_at],['settled','applied',T2,null]);
 assert.equal((await dueResults(env,{now:'2026-11-13T12:00:00.000Z'})).length,2);
 // the same row cannot be settled twice (the live state is gone)
 await assert.rejects(settleResult(env,{row:target,state:'abandoned',settledBy:'age',at:T2}),code('producer_cas_lost'));
}

// 8. The marker fence: a batch built under one generation fails whole when the marker moved, and a missing table is named.
{
 const file=database();
 const env=envOf(file,{onBatch:async()=>{assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);}});
 await assert.rejects(open(file,{}).then(()=>openEpgRun(env,{runKey:'run-2',sourceGeneration:GEN,fingerprint:hex('1'),units:[],at:T})),code('film_person_fence'));
 assert.equal(Number(one(file,"SELECT COUNT(*) FROM canonical_producer_run WHERE run_key='run-2'")),0);
 const bare=database();
 sqlite(bare,'PRAGMA foreign_keys=OFF;DROP TABLE canonical_producer_unit_result;DROP TABLE canonical_producer_run');
 await assert.rejects(open(bare),code('producer_store_missing'));
 await assert.rejects(readRun(envOf(bare),{origin:'epg',runKey:'run-1'}),code('producer_store_missing'));
}

// 9. Static: dormant. Nothing in src, build.mjs or the Worker imports the store; no network, timer, cron, R2 or flag; it writes only its two tables.
{
 const text=fs.readFileSync(path.join(SRC,'canonical-producer-store.js'),'utf8');
 const code_=text.replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(fetch|setTimeout|setInterval|BUCKET|R2|crypto\.subtle|Cron|process\.env|env\.[A-Z_]{4,})\b/.test(code_),'no network, timer, cron, R2 or flag');
 const writes=[...code_.matchAll(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/g)].map(match=>match[2]);
 assert.ok(writes.length>0&&writes.every(table=>['canonical_producer_run','canonical_producer_unit_result'].includes(table)),'it writes only its two tables: '+[...new Set(writes)]);
 assert.ok(!/DELETE FROM/.test(code_),'rows are never deleted');
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&entry.name!=='canonical-producer-store.js'&&fs.readFileSync(full,'utf8').includes('canonical-producer-store'))importers.push(full.replace(/\\/g,'/'));}};
 walk('src');
 assert.deepEqual(importers,[],'nothing in src imports the store');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producer-store'),file+' does not bundle it');
 assert.deepEqual([...text.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort(),['./canonical-mutations.js','./canonical-producer-run.js','./canonical-writer-route.js','./film-person-authority.js']);
}
console.log('canonical-producer-store: ok');
