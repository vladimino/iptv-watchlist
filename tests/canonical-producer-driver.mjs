// AIR-374 S4-4 (ADR 0128): the DORMANT durable driver of the producer pass (src/canonical-producer-driver.js) on the sqlite3-CLI D1 stand-in with the real migration chain (tables, CHECKs and triggers of 0020) and the real store. The unit appliers are
// scripted (they stand in for the `apply*Units` layers, whose own tests live with them), so each scenario of the ADR failure-mode table is exercised against REAL durable state. No Worker, R2, D1 or Cloudflare access.
// Covered: the required parameters and the lease bound, dormancy (one marker read, nothing written), the happy pass and its slices, a pass killed before or after a slice commit, an injected batch failure and a lost answer, a database outage over repeated steps,
// poison units (strike 1, 2, third), a systemic failure at count 1, the immediate re-plan, permanent and recoverable refusals, planner refusals (a malformed unit, more than 50 credits), a plan change, a concurrent step, a moved marker, an unresolved receipt,
// the slice statement cap, the partial pass, exception isolation, the retry pass (due, not due, left plan, source changed, abandoned, recoverable unchanged and changed, still failing, systemic), the dictionary pass (resolver, owner-review cases, resume),
// freshness at the consumer boundary, and the static dormancy. DRIVER_SRC points the file at a mutant copy of src/; DRIVER_TEMPLATE at a prebuilt template database.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const SRC=process.env.DRIVER_SRC?path.resolve(process.env.DRIVER_SRC):path.resolve('src');
const load=name=>import(pathToFileURL(path.join(SRC,name)).href);
const D=await load('canonical-producer-driver.js');
const S=await load('canonical-producer-store.js');
const {writerRoute}=await load('canonical-writer-route.js');
const {RETRY_POLICY}=await load('canonical-receipts.js');
const {runEpgProducerPass,retryEpgProducerResults,runDictionaryProducerPass,readCanonicalFreshness,readerDecision,MAX_DEADLINE_MS}=D;

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-producer-driver-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
if(process.env.DRIVER_TEMPLATE)fs.copyFileSync(process.env.DRIVER_TEMPLATE,template);
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
const T='2026-11-13T10:00:00.000Z';
const LATER='2026-11-13T13:00:00.000Z';
const GEN='gen-285';
const hex=c=>c.repeat(64);
const ID=i=>'film:tmdb:'+(100+i);
const films=count=>Array.from({length:count},(_,i)=>({id:ID(i),facts:{film:{contractVersion:1,originalTitle:'T'+i}}}));
const mkNow=(start=T)=>{let tick=0;return ()=>new Date(Date.parse(start)+(tick++)*1000).toISOString();};
const TABLES=['canonical_producer_run','canonical_producer_unit_result'];
const dump=file=>JSON.stringify(TABLES.map(table=>[table,rows(file,'SELECT * FROM '+table+' ORDER BY 1,2,3,4,5')]));
const runRow=file=>rows(file,"SELECT * FROM canonical_producer_run WHERE origin='epg'")[0]||null;
const results=file=>rows(file,'SELECT * FROM canonical_producer_unit_result ORDER BY pass_no,kind,unit_id,created_at');
const count=(file,table)=>Number(Object.values(rows(file,'SELECT COUNT(*) FROM '+table)[0])[0]);

// ---- scripted appliers: the return value of an `apply*Units` call over a ONE-unit plan ----
const ZERO={applied:0,noop:0,already:0,unknown:0,failed:0,absent:0,pending:0};
const OK=(kind='applied')=>({skipped:false,cursor:1,done:true,counts:{...ZERO,[kind]:1},failures:[],stoppedBy:null});
const FAIL=code=>({skipped:false,cursor:0,done:false,counts:{...ZERO,failed:1},failures:[{id:'x',code}],stoppedBy:null});
const HELD=code=>({skipped:false,cursor:0,done:false,counts:{...ZERO},failures:[],stoppedBy:code});
const SKIPPED={skipped:true,reason:'projector_is_writer',cursor:0,done:false,counts:{...ZERO},failures:[]};
function scripted(behaviour={}){
 const log=[],calls={};
 const apply=async(env,{plan})=>{
  const unit=plan.units[0];
  log.push(unit.id);calls[unit.id]=(calls[unit.id]||0)+1;
  const step=behaviour[unit.id];
  return step?step(calls[unit.id],{env,plan,unit}):OK();
 };
 return {apply,log,calls};
}
const STAMP_SNAPSHOT={no_identity_row:{film:{id:ID(1),revision:1},identity:null},film_person_reference:{film:{id:ID(1),revision:1},persons:[]}};
const prerequisites=async({code})=>{if(!STAMP_SNAPSHOT[code])throw Object.assign(new Error('x'),{code:'film_person_unavailable'});return STAMP_SNAPSHOT[code];};
const params=(over={})=>{
 const film=over.film||scripted();
 return {runId:'R1',sourceGeneration:GEN,at:T,films:films(5),sliceSize:2,maxSlicesPerRun:10,sliceDeadlineMs:60000,prerequisites,now:mkNow(),appliers:{film:film.apply},...over};
};

// 1. Required parameters, no default; the deadline sits inside the step lease with its margin. Nothing is read.
{
 const lease=fs.readFileSync('src/epg-orchestration.js','utf8');
 assert.ok(lease.includes('LEASE_MS=5*60000')&&lease.includes('BOUNDARY_MARGIN_MS=15000'),'the lease numbers the driver pins');
 assert.equal(MAX_DEADLINE_MS,5*60000-15000);
 const file=database('open'),env=envOf(file);
 for(const [field,value] of [['sliceSize',undefined],['sliceSize',0],['sliceSize',51],['sliceSize',1.5],['maxSlicesPerRun',undefined],['maxSlicesPerRun',0],['sliceDeadlineMs',undefined],['sliceDeadlineMs',MAX_DEADLINE_MS+1],['sliceDeadlineMs',0],['prerequisites',undefined]]){
  const result=await runEpgProducerPass(env,params({[field]:value}));
  assert.deepEqual(result,{state:'invalid_parameters',field},field+'='+value);
 }
 assert.equal((await runEpgProducerPass(env,params({sliceDeadlineMs:MAX_DEADLINE_MS}))).state,'complete','the largest legal deadline');
 assert.equal((await runEpgProducerPass(envOf(database('open')),undefined)).state,'invalid_parameters');
 const fresh=envOf(database('open'));
 assert.deepEqual(await retryEpgProducerResults(fresh,{...params(),limit:undefined}),{state:'invalid_parameters',field:'limit'});
 assert.deepEqual(await retryEpgProducerResults(fresh,{...params(),limit:51}),{state:'invalid_parameters',field:'limit'});
 assert.deepEqual(await retryEpgProducerResults(fresh,{...params(),limit:5,sliceDeadlineMs:MAX_DEADLINE_MS+1}),{state:'invalid_parameters',field:'sliceDeadlineMs'});
 assert.equal(fresh.DB.calls.queries,0,'a refused call reads nothing');
 assert.deepEqual(await runDictionaryProducerPass(fresh,{...params(),version:'v1',entries:[],at:T}),{state:'invalid_parameters',field:'dictionary'});
}

// 2. Dormant below open: ONE marker read, no applier call, nothing written; held is a named error, never a fallback.
for(const stage of ['legacy','r2','prepared']){
 const file=database(stage),before=dump(file),film=scripted();
 const probe=envOf(file);await writerRoute(probe);
 const spy={resolved:0,reviewed:0};
 for(const call of [env=>runEpgProducerPass(env,params({film,departed:[ID(7)]})),env=>retryEpgProducerResults(env,{...params({film,departed:[ID(7)]}),limit:5}),env=>runDictionaryProducerPass(env,{...params({film}),version:'v1',entries:[{id:'d1',original:'O',title:'T',status:'verified'}],at:T,resolveFilm:async()=>{spy.resolved++;return {filmId:ID(1)};},readOwnerReview:async()=>{spy.reviewed++;return {read:'ok',entry:'absent'};}})]){
  const env=envOf(file);
  assert.deepEqual(await call(env),{state:'skipped',reason:'projector_is_writer'},stage);
  assert.equal(env.DB.calls.queries,probe.DB.calls.queries,'exactly the marker read ('+stage+')');
  assert.equal(env.DB.calls.batches,0);
 }
 assert.equal(film.log.length,0);assert.equal(dump(file),before,'nothing written at '+stage);
 assert.deepEqual(spy,{resolved:0,reviewed:0},'the resolver and the owner-review read are not called below open ('+stage+')');
}
{
 const file=database('held'),film=scripted(),before=dump(file);
 const result=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([result.state,result.code],['error','film_person_held']);
 assert.equal(film.log.length,0);assert.equal(dump(file),before);
}

// 3. The happy pass: slices of 2, the claim only at completion, a second call is a no-op.
{
 const file=database('open'),film=scripted(),env=envOf(file);
 const result=await runEpgProducerPass(env,params({film}));
 assert.deepEqual([result.state,result.slices,result.counts,result.openAtCompletion,result.appliedGeneration],['complete',3,{applied:5,noop:0,kept:0,failed:0},0,GEN]);
 const row=runRow(file);
 assert.deepEqual([row.pass_state,row.applied_generation,row.cursor_id,row.n_applied,row.pass_no,row.run_key],['passed',GEN,ID(4),5,1,'epg:R1']);
 assert.equal(count(file,'canonical_producer_unit_result'),0,'a succeeded unit leaves no row');
 assert.deepEqual(film.log,[0,1,2,3,4].map(ID));
 const again=await runEpgProducerPass(env,params({film}));
 assert.equal(again.state,'already_complete');assert.equal(film.log.length,5,'no unit is applied again');
 assert.equal((await readCanonicalFreshness(env,{publishedGeneration:GEN})).freshness,'current');
 // mixed outcomes are counted by kind
 const mixed=database('open'),m=scripted({[ID(1)]:()=>OK('noop'),[ID(2)]:()=>OK('already'),[ID(3)]:()=>OK('absent')});
 const out=await runEpgProducerPass(envOf(mixed),params({film:m}));
 assert.deepEqual(out.counts,{applied:3,noop:1,kept:1,failed:0});
}

// 4. A pass killed after units were applied and before the slice commit, an injected batch failure and a lost answer.
{
 const file=database('open'),film=scripted();
 let armed=true;
 const env=envOf(file,{onBatch:async statements=>{if(armed&&statements.some(item=>/n_applied=n_applied\+/.test(item.text))){armed=false;throw new Error('D1_ERROR: network connection lost');}}});
 const first=await runEpgProducerPass(env,params({film}));
 assert.deepEqual([first.state,first.code],['stopped','producer_transport'],'the failed slice batch is a systemic stop');
 let row=runRow(file);
 assert.deepEqual([row.cursor_id,row.n_applied,row.strike_count,row.pass_state,row.stopped_by],[null,0,0,'stopped','producer_transport'],'the cursor, the counts and the strike are as before');
 const second=await runEpgProducerPass(envOf(file),params({film}));
 assert.equal(second.state,'complete');
 assert.deepEqual(film.log,[0,1,0,1,2,3,4].map(i=>ID(i)),'the unacknowledged slice is revisited, nothing is lost');
 row=runRow(file);assert.deepEqual([row.n_applied,row.pass_state,row.applied_generation],[5,'passed',GEN]);
}
{
 // the answer of the slice commit is lost AFTER it committed: the next step resumes after that cursor and revisits nothing
 const file=database('open'),film=scripted(),real=d1Standin(file);
 let batches=0;
 const lossy={DB:{...real,calls:real.calls,prepare:real.prepare.bind(real),batch:async statements=>{batches++;const answer=await real.batch(statements);if(statements.some(item=>/n_applied=n_applied\+/.test(item.text))&&batches<=2)throw new Error('D1_ERROR: network lost after commit');return answer;}}};
 const first=await runEpgProducerPass(lossy,params({film}));
 assert.deepEqual([first.state,first.code],['stopped','producer_transport']);
 assert.equal(runRow(file).cursor_id,ID(1),'the committed slice stays committed');
 const second=await runEpgProducerPass(envOf(file),params({film}));
 assert.equal(second.state,'complete');
 assert.deepEqual(film.log,[0,1,2,3,4].map(ID),'no committed unit is applied again');
}
{
 // killed after the slice commit: resume after the cursor (a fresh call over the same database is exactly that)
 const file=database('open'),film=scripted();
 const partial=await runEpgProducerPass(envOf(file),params({film,maxSlicesPerRun:1}));
 assert.deepEqual([partial.state,partial.reason,partial.slices],['partial','max_slices',1]);
 let row=runRow(file);assert.deepEqual([row.cursor_id,row.pass_state,row.applied_generation],[ID(1),'passing',null]);
 assert.equal((await readCanonicalFreshness(envOf(file),{publishedGeneration:GEN})).freshness,'lagging','a partial pass is never current');
 const rest=await runEpgProducerPass(envOf(file),params({film}));
 assert.equal(rest.state,'complete');assert.deepEqual(film.log,[0,1,2,3,4].map(ID));
}

// 5. A database outage over repeated steps never reclassifies a unit: cursor and strike count stay, no result row appears.
{
 const file=database('open'),film=scripted({[ID(2)]:()=>FAIL('film_person_unavailable')});
 for(let step=0;step<5;step++){
  const out=await runEpgProducerPass(envOf(file),params({film}));
  assert.deepEqual([out.state,out.code],['stopped','film_person_unavailable'],'step '+step);
  const row=runRow(file);
  assert.deepEqual([row.cursor_id,row.strike_count,row.strike_id,row.stopped_by],[ID(1),0,null,'film_person_unavailable']);
  assert.equal(count(file,'canonical_producer_unit_result'),0);
 }
 // the unit succeeds when the database returns
 film.calls[ID(2)]=0;
 const healthy=scripted();
 assert.equal((await runEpgProducerPass(envOf(file),params({film:healthy}))).state,'complete');
}
{
 // a real outage of the store itself (every statement fails after the run is open): a named stop, nothing changed, nothing thrown
 const file=database('open'),film=scripted();
 let down=false;
 const env=envOf(file,{onQuery:async()=>{if(down)throw new Error('D1_ERROR: network connection lost');},onBatch:async()=>{if(down)throw new Error('D1_ERROR: network connection lost');}});
 film.apply.bind(null);
 const probe=params({film:{apply:async(e,a)=>{down=true;return scripted().apply(e,a);}}});
 const out=await runEpgProducerPass(env,probe);
 assert.equal(out.state,'stopped');assert.equal(out.recorded,false,'the stop itself could not be written');
 down=false;
 const row=runRow(file);assert.deepEqual([row.cursor_id,row.strike_count,row.n_applied],[null,0,0]);
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).state,'complete');
}

{
 // a stop inside a slice keeps the durable prefix of that slice (the units before the stopping one are committed first)
 const file=database('open');
 const out=await runEpgProducerPass(envOf(file),params({film:scripted({[ID(3)]:()=>FAIL('film_person_unavailable')}),sliceSize:5}));
 assert.equal(out.state,'stopped');assert.deepEqual([runRow(file).cursor_id,runRow(file).n_applied],[ID(2),3]);
 for(const stopper of [()=>HELD('film_person_held'),()=>SKIPPED,()=>({skipped:false,cursor:1,done:true,counts:{...ZERO,unknown:1},failures:[],stoppedBy:null})]){
  const held=database('open');
  const h=await runEpgProducerPass(envOf(held),params({film:scripted({[ID(3)]:stopper}),sliceSize:5}));
  assert.equal(h.state,'stopped');assert.deepEqual([runRow(held).cursor_id,runRow(held).n_applied],[ID(2),3],'the prefix before the stopping unit is committed');
 }
 // a named kept outcome thrown by a layer is counted and leaves no row
 const kept=database('open');
 const k=await runEpgProducerPass(envOf(kept),params({film:scripted({[ID(2)]:()=>FAIL('owner_kept')})}));
 assert.deepEqual([k.state,k.counts,count(kept,'canonical_producer_unit_result')],['complete',{applied:4,noop:0,kept:1,failed:0},0]);
 // a release of a Film that is not stored has nothing to release: it is left out of the plan, no result, no applier call
 const absent=database('open'),film=scripted();
 const a=await runEpgProducerPass(envOf(absent),params({film,departed:[ID(7)]}));
 assert.deepEqual([a.state,film.log.includes(ID(7)),count(absent,'canonical_producer_unit_result'),rows(absent,"SELECT unit_count FROM canonical_producer_run")[0].unit_count],['complete',false,0,5]);
}

// 6. Poison unit: strike 1, strike 2, then the durable result and the cursor in ONE batch; the pass continues.
{
 const file=database('open'),film=scripted({[ID(1)]:()=>FAIL('identity_collision')});
 let out=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([out.state,out.code,out.strikes,out.unit],['struck','identity_collision',1,{kind:'film_facts',id:ID(1)}]);
 let row=runRow(file);
 assert.deepEqual([row.cursor_id,row.strike_count,row.strike_id,row.strike_class,row.n_applied],[ID(0),1,ID(1),'identity_collision',1],'the unit before it is committed, the strike is recorded, the cursor did not move for it');
 out=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([out.state,out.strikes],['struck',2]);
 assert.equal(runRow(file).strike_count,2);
 assert.equal(count(file,'canonical_producer_unit_result'),0,'no result before the third proven failure');
 out=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([out.state,out.counts.failed,out.openAtCompletion],['complete',1,1]);
 row=runRow(file);assert.deepEqual([row.strike_count,row.strike_id,row.n_failed,row.pass_state,row.open_at_completion],[0,null,1,'passed',1]);
 const [result]=results(file);
 assert.deepEqual([result.state,result.code,result.attempts,result.retry_owner,result.kind,result.unit_id,result.pass_no],['open','identity_collision',3,'unit','film_facts',ID(1),1]);
 assert.ok(result.next_attempt_at>T&&result.prereq_stamp===null);
 assert.equal((await readCanonicalFreshness(envOf(file),{publishedGeneration:GEN})).freshness,'partial','passed with a live membership result');
 assert.deepEqual(film.log.filter(id=>id===ID(1)).length,3,'attempted once per step');
}
{
 // the unit succeeds mid-count: the strike is cleared by that outcome
 const file=database('open'),film=scripted({[ID(1)]:calls=>calls===1?FAIL('identity_collision'):OK()});
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).state,'struck');
 assert.equal(runRow(file).strike_count,1);
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).state,'complete');
 assert.deepEqual([runRow(file).strike_count,runRow(file).strike_id,count(file,'canonical_producer_unit_result')],[0,null,0]);
}
{
 // a systemic failure while the count is 1 touches no strike column; another class restarts at 1; the same unit with another class is a new identity
 const file=database('open');
 let step=0;
 const film=scripted({[ID(1)]:()=>{step++;return step===1?FAIL('identity_collision'):step===2?FAIL('film_person_unavailable'):step===3?FAIL('identity_collision'):FAIL('person_role_collision');}});
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).state,'struck');
 const stopped=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([stopped.state,stopped.code],['stopped','film_person_unavailable']);
 let row=runRow(file);assert.deepEqual([row.strike_count,row.strike_class,row.pass_state],[1,'identity_collision','stopped']);
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).strikes,2,'the count survived the stop');
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).strikes,1,'another class is a new identity starting at 1');
 row=runRow(file);assert.deepEqual([row.strike_count,row.strike_class],[1,'person_role_collision']);
}

// 7. The immediate re-plan: the first two codes are applied once more before they count.
{
 const file=database('open'),film=scripted({[ID(1)]:calls=>calls===1?FAIL('film_person_revision_conflict'):OK()});
 assert.equal((await runEpgProducerPass(envOf(file),params({film}))).state,'complete');
 assert.equal(film.calls[ID(1)],2);assert.equal(runRow(file).strike_count,0);
 const other=database('open'),both=scripted({[ID(1)]:()=>FAIL('film_person_precondition')});
 const out=await runEpgProducerPass(envOf(other),params({film:both}));
 assert.deepEqual([out.state,out.strikes,both.calls[ID(1)]],['struck',1,2]);
}

// 8. Named refusals are durable at first observation, no strike; a recoverable one carries its stamp; a prerequisite read that fails or is malformed stops the pass.
{
 const file=database('open');
 const film=scripted({[ID(1)]:()=>FAIL('film_person_bounded'),[ID(3)]:()=>FAIL('no_identity_row')});
 const out=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([out.state,out.counts],['complete',{applied:3,noop:0,kept:0,failed:2}]);
 const list=results(file);
 assert.deepEqual(list.map(row=>[row.unit_id,row.state,row.code,row.attempts]),[[ID(1),'refused_permanent','film_person_bounded',1],[ID(3),'refused_recoverable','no_identity_row',1]]);
 assert.deepEqual([list[0].next_attempt_at,list[0].prereq_stamp],[null,null]);
 assert.ok(list[1].prereq_stamp&&list[1].next_attempt_at);
 assert.equal(runRow(file).strike_count,0);
 assert.equal(out.openAtCompletion,2,'both are membership-affecting live results');
 for(const bad of [async()=>{throw Object.assign(new Error('x'),{code:'film_person_unavailable'});},async()=>({film:{id:ID(3)}})]){
  const stopFile=database('open');
  const refused=await runEpgProducerPass(envOf(stopFile),params({film:scripted({[ID(3)]:()=>FAIL('no_identity_row')}),prerequisites:bad}));
  assert.equal(refused.state,'stopped');assert.equal(runRow(stopFile).cursor_id,ID(2),'the cursor stops before the unit that could not be recorded, the prefix is kept');assert.equal(count(stopFile,'canonical_producer_unit_result'),0);
 }
 // an unclassified code stops the pass (fail closed)
 const unknownFile=database('open');
 const unknown=await runEpgProducerPass(envOf(unknownFile),params({film:scripted({[ID(2)]:()=>FAIL('totally_new_code')})}));
 assert.deepEqual([unknown.state,unknown.code],['stopped','unclassified']);
}
// 8b. Planner refusals: a malformed Film unit and a credit list over 50 are per-unit results; the rest of the plan survives.
{
 const file=database('open'),film=scripted(),person=scripted();
 const credits=[{filmId:ID(2),credits:Array.from({length:51},(_,i)=>({personId:'person:tmdb:'+i,role:'actor'}))},{filmId:ID(3),credits:[{personId:'person:tmdb:1',role:'director'}]}];
 const input=films(4);input[1]={id:ID(1),facts:'not an object'};
 const out=await runEpgProducerPass(envOf(file),params({film,films:input,credits,appliers:{film:film.apply,person:person.apply}}));
 assert.equal(out.state,'complete');
 const list=results(file);
 assert.deepEqual(list.map(row=>[row.kind,row.unit_id,row.state,row.code]),[['film_credits',ID(2),'refused_permanent','film_person_bounded'],['film_facts',ID(1),'refused_permanent','film_person_invalid']].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:a[1]<b[1]?-1:1));
 assert.equal(film.log.includes(ID(1)),false,'a refused unit is never applied');
 assert.deepEqual(person.log,[ID(3)],'the credit unit that is fine survives');
 assert.equal(out.counts.failed,2);
 assert.equal(await S.liveMembershipCount(envOf(file)),1,'only the film_facts result affects membership');
}

// 9. A plan change under the same run: replay from the start (pass_no + 1), the full plan revisited.
{
 const file=database('open'),film=scripted();
 assert.equal((await runEpgProducerPass(envOf(file),params({film,maxSlicesPerRun:1}))).state,'partial');
 const changed=films(5);changed[3]={id:ID(3),facts:{film:{contractVersion:1,originalTitle:'changed'}}};
 const out=await runEpgProducerPass(envOf(file),params({film,films:changed}));
 assert.equal(out.state,'complete');assert.equal(out.passNo,2);
 assert.deepEqual(film.log,[0,1,0,1,2,3,4].map(ID),'the replay starts at the first unit');
}

{
 // Scenario A: the same unit is refused in pass 1 and again in pass 2. The same source digest keeps the live row (one live row per unit); a changed digest supersedes it first and inserts the new one.
 const file=database('open');
 const refuse=()=>scripted({[ID(1)]:()=>FAIL('film_person_bounded')});
 await runEpgProducerPass(envOf(file),params({film:refuse(),maxSlicesPerRun:1}));
 const changed=films(5);changed[3]={id:ID(3),facts:{film:{contractVersion:1,originalTitle:'changed'}}};
 const same=await runEpgProducerPass(envOf(file),params({film:refuse(),films:changed,maxSlicesPerRun:1}));
 assert.deepEqual([same.state,same.passNo],['partial',2]);
 let list=results(file);
 assert.deepEqual(list.map(row=>[row.pass_no,row.state]),[[1,'refused_permanent']],'the same digest keeps its one live row');
 const moved=films(5);moved[1]={id:ID(1),facts:{film:{contractVersion:1,originalTitle:'moved'}}};moved[3]=changed[3];
 const third=await runEpgProducerPass(envOf(file),params({film:refuse(),films:moved}));
 assert.deepEqual([third.state,third.passNo],['complete',3]);
 list=results(file);
 assert.deepEqual(list.map(row=>[row.pass_no,row.state,row.settled_by]),[[1,'superseded','source_changed'],[3,'refused_permanent',null]],'both durable, the terminal row never reopens, one live row');
}

// 10. Duplicate or concurrent delivery: the compare-and-set loser stops and writes nothing partial; a moved marker and an unresolved receipt stop the pass.
{
 const file=database('open');
 const film=scripted({[ID(1)]:()=>{assert.equal(sqlite(file,"UPDATE canonical_producer_run SET revision=revision+1 WHERE origin='epg'").status,0);return OK();}});
 const out=await runEpgProducerPass(envOf(file),params({film}));
 assert.deepEqual([out.state,out.code],['stopped','producer_cas_lost']);
 const row=runRow(file);assert.deepEqual([row.cursor_id,row.n_applied],[null,0]);
 assert.equal((await runEpgProducerPass(envOf(file),params({film:scripted()}))).state,'complete','the next step takes over');
}
{
 const file=database('open');
 const film=scripted({[ID(2)]:()=>{assert.equal(sqlite(file,"UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1").status,0);return OK();}});
 const out=await runEpgProducerPass(envOf(file),params({film}));
 assert.equal(out.state,'stopped');assert.equal(out.recorded,false);
 assert.equal(runRow(file).cursor_id,ID(1),'the first slice committed before the marker moved; the second was refused whole');
 assert.equal(runRow(file).applied_generation,null);
 const skipped=database('open'),moved=scripted({[ID(1)]:()=>SKIPPED});
 const s=await runEpgProducerPass(envOf(skipped),params({film:moved}));
 assert.deepEqual([s.state,s.code],['stopped','film_person_not_open']);
}
{
 for(const kind of ['unknown','pending','failed']){
  const file=database('open');
  const film=scripted({[ID(2)]:()=>({skipped:false,cursor:1,done:true,counts:{...ZERO,[kind]:1},failures:[],stoppedBy:null})});
  const out=await runEpgProducerPass(envOf(file),params({film}));
  assert.deepEqual([out.state,out.code],['stopped','receipt_state_conflict'],kind);
  assert.equal(runRow(file).cursor_id,ID(1),'the cursor does not pass an unresolved receipt');
 }
 const held=database('open');
 const out=await runEpgProducerPass(envOf(held),params({film:scripted({[ID(2)]:()=>HELD('film_person_held')})}));
 assert.deepEqual([out.state,out.code],['stopped','film_person_held']);
}

// 11. The slice statement cap: fifty refused units do not fit one batch and are split; the deadline ends the pass with the durable prefix.
{
 const file=database('open');
 const sizes=[];
 const env=envOf(file,{onBatch:async statements=>{sizes.push(statements.length);}});
 const behaviour=Object.fromEntries(Array.from({length:50},(_,i)=>[ID(i),()=>FAIL('film_person_bounded')]));
 const out=await runEpgProducerPass(env,params({film:scripted(behaviour),films:films(50),sliceSize:50}));
 assert.equal(out.state,'complete');assert.equal(count(file,'canonical_producer_unit_result'),50);
 assert.ok(sizes.every(size=>size<=S.SLICE_STATEMENT_CAP),'every batch fits the cap: '+sizes);
 assert.ok(sizes.length>=3,'the slice was split');
 const timed=database('open');
 let ms=0;
 const clock=()=>{ms+=1000;return ms;};
 const cut=await runEpgProducerPass(envOf(timed),params({clock,sliceDeadlineMs:3500}));
 assert.deepEqual([cut.state,cut.reason],['partial','deadline']);
 assert.equal(runRow(timed).cursor_id,ID(2),'the units visited before the deadline are committed');
}

// 12. Exception isolation: nothing thrown reaches the caller, whatever fails and wherever.
{
 const file=database('open');
 const boom=()=>{throw new Error('secret detail that must not leak');};
 for(const over of [{films:'nope'},{films:[{id:'x',facts:{}}]},{persons:[{id:'bad'}]},{prerequisites:boom,film:scripted({[ID(1)]:()=>FAIL('no_identity_row')})},{now:boom},{clock:boom},{appliers:{film:boom}},{appliers:{film:async()=>{throw undefined;}}},{appliers:{film:async()=>null}},{appliers:{film:async()=>({skipped:false,counts:null,failures:'x',stoppedBy:null})}}]){
  let result;
  await assert.doesNotReject(async()=>{result=await runEpgProducerPass(envOf(database('open')),params(over));});
  assert.ok(['error','stopped','struck','complete','partial'].includes(result.state),JSON.stringify(Object.keys(over))+' -> '+result.state);
  assert.ok(!JSON.stringify(result).includes('secret detail'),'no message leaks');
 }
 await assert.doesNotReject(()=>retryEpgProducerResults({DB:null},{...params(),limit:5}));
 for(const over of [{now:boom},{clock:boom}]){
  const out=await retryEpgProducerResults(envOf(database('open')),{...params(),limit:5,reconcile:false,...over});
  assert.equal(out.state,'error',JSON.stringify(Object.keys(over)));assert.ok(!JSON.stringify(out).includes('secret detail'));
 }
 await assert.doesNotReject(()=>runDictionaryProducerPass({},{...params(),version:'v1',entries:[],at:T,resolveFilm:async()=>({}),readOwnerReview:async()=>({})}));
 const missing=database('open');
 assert.equal(sqlite(missing,'PRAGMA foreign_keys=OFF;DROP TABLE canonical_producer_unit_result;DROP TABLE canonical_producer_run;').status,0);
 const out=await runEpgProducerPass(envOf(missing),params());
 assert.deepEqual([out.state,out.code],['error','producer_store_missing'],'a missing table is named before any unit');
 assert.equal(file.length>0,true);
}

// 13. The retry pass: one owner per result, revalidated against the current plan, settled only after write proof.
const poisoned=async(over={})=>{
 const file=database('open'),film=scripted({[ID(1)]:()=>FAIL('identity_collision')});
 for(let i=0;i<3;i++)await runEpgProducerPass(envOf(file),params({film,...over}));
 assert.equal(results(file).length,1);
 return file;
};
const retry=(file,over={})=>retryEpgProducerResults(envOf(file),{...params(over),at:T,limit:10,reconcile:false,now:mkNow(LATER),...over});
{
 // not due: nothing is applied
 const file=await poisoned(),film=scripted();
 const early=await retryEpgProducerResults(envOf(file),{...params({film}),limit:10,reconcile:false,now:mkNow(T)});
 assert.deepEqual([early.state,early.counts.taken],['done',0]);assert.equal(film.log.length,0);
 // due and now applies: settled `applied` after the unit's own proof
 const ok=await retry(file,{film});
 assert.deepEqual([ok.state,ok.counts.taken,ok.counts.settled],['done',1,1]);
 const [row]=results(file);assert.deepEqual([row.state,row.settled_by,row.next_attempt_at],['settled','applied',null]);
 assert.deepEqual(film.log,[ID(1)]);
 assert.equal((await retry(file,{film})).counts.taken,0,'a terminal row is never taken again');
}
{
 // a noop is also proof; an outcome that is not proven settles nothing
 const file=await poisoned();
 assert.equal((await retry(file,{film:scripted({[ID(1)]:()=>OK('noop')})})).counts.settled,1);
 const other=await poisoned();
 const out=await retry(other,{film:scripted({[ID(1)]:()=>OK('absent')})});
 assert.deepEqual([out.counts.settled,out.counts.not_proven,results(other)[0].state],[0,1,'open']);
}
{
 // still failing: attempts + 1 and the next step of the policy, same row
 const file=await poisoned();
 const before=results(file)[0];
 const out=await retry(file,{film:scripted({[ID(1)]:()=>FAIL('identity_collision')})});
 assert.equal(out.counts.updated,1);
 const after=results(file)[0];assert.deepEqual([after.attempts,after.state,after.code],[before.attempts+1,'open','identity_collision']);assert.ok(after.next_attempt_at>before.next_attempt_at);
 // a failure that is now a named refusal reclassifies the same row in one move
 const refused=await retry(file,{now:mkNow('2026-11-14T10:00:00.000Z'),film:scripted({[ID(1)]:()=>FAIL('film_person_bounded')})});
 assert.equal(refused.counts.updated,1);assert.equal(results(file)[0].state,'refused_permanent');
 assert.equal((await retry(file,{now:mkNow('2026-11-15T10:00:00.000Z'),film:scripted()})).counts.taken,0,'a permanent refusal is never retried');
}
{
 // the source of the unit changed, the unit left the plan, the attempts are used up: terminal rows with their reasons
 const changedFile=await poisoned();
 const changed=films(5);changed[1]={id:ID(1),facts:{film:{contractVersion:1,originalTitle:'moved'}}};
 assert.equal((await retry(changedFile,{films:changed,film:scripted()})).counts.superseded,1);
 assert.equal(results(changedFile)[0].settled_by,'source_changed');
 const goneFile=await poisoned();
 assert.equal((await retry(goneFile,{films:films(5).filter((_,i)=>i!==1),film:scripted()})).counts.superseded,1);
 assert.equal(results(goneFile)[0].settled_by,'left_plan');
 const exhausted=await poisoned();
 for(let attempts=4;attempts<=RETRY_POLICY.maxAttempts;attempts++)assert.equal(sqlite(exhausted,'UPDATE canonical_producer_unit_result SET attempts='+attempts).status,0,'the trigger allows one attempt per update');
 const film=scripted();
 assert.equal((await retry(exhausted,{film})).counts.abandoned,1);
 assert.deepEqual([results(exhausted)[0].state,results(exhausted)[0].settled_by,film.log.length],['abandoned','retry_exhausted',0]);
}
{
 // a recoverable refusal: an unchanged prerequisite costs one read and no attempt; a changed one is planned and applied through the same writers, with no source change
 const file=database('open');
 const first=scripted({[ID(3)]:()=>FAIL('no_identity_row')});
 await runEpgProducerPass(envOf(file),params({film:first}));
 const stored=results(file)[0];assert.equal(stored.state,'refused_recoverable');
 const film=scripted({[ID(3)]:()=>FAIL('no_identity_row')});
 const unchanged=await retry(file,{film});
 assert.deepEqual([unchanged.counts.deferred,film.log.length,results(file)[0].attempts],[1,0,1],'unchanged stamp: no apply, no attempt');
 assert.ok(results(file)[0].next_attempt_at>stored.next_attempt_at,'the schedule moved by the last step of the policy');
 STAMP_SNAPSHOT.no_identity_row={film:{id:ID(1),revision:1},identity:{id:'identity:1',revision:1}};
 try{
  const still=await retry(file,{now:mkNow('2026-11-14T10:00:00.000Z'),film});
  assert.deepEqual([still.counts.updated,film.log.length],[1,1],'changed stamp: the unit is applied, refused again, and takes the new stamp');
  assert.notEqual(results(file)[0].prereq_stamp,stored.prereq_stamp);assert.equal(results(file)[0].state,'refused_recoverable');
  STAMP_SNAPSHOT.no_identity_row={film:{id:ID(1),revision:1},identity:{id:'identity:1',revision:2}};
  const applied=await retry(file,{now:mkNow('2026-11-16T10:00:00.000Z'),film:scripted()});
  assert.equal(applied.counts.settled,1);
  const [row]=results(file);assert.deepEqual([row.state,row.settled_by],['settled','prerequisite_resolved']);
 }finally{STAMP_SNAPSHOT.no_identity_row={film:{id:ID(1),revision:1},identity:null};}
}
{
 // a systemic failure in the retry stops it and settles nothing; the receipt reconcile runs by default and is isolated
 const file=await poisoned();
 const out=await retry(file,{film:scripted({[ID(1)]:()=>HELD('film_person_held')})});
 assert.deepEqual([out.state,out.code,results(file)[0].state],['stopped','film_person_held','open']);
 const quiet=await retry(file,{reconcile:true,film:scripted({[ID(1)]:()=>FAIL('identity_collision')})});
 assert.ok(['done','failed'].includes(quiet.reconcile.state));
 const early=await retryEpgProducerResults(envOf(file),{...params(),limit:10,reconcile:false,now:mkNow(LATER),clock:(()=>{let t=0;return ()=>(t+=60000);})(),sliceDeadlineMs:1000});
 assert.equal(early.counts.taken,0,'the deadline ends the pass before a row is taken');
}

// 14. The dictionary pass: the resolver and the owner-review check run BEFORE the planner and the version mint.
{
 const entries=[1,2,3,4].map(i=>({id:'d'+i,original:'Orig '+i,title:'Title '+i,status:'verified'}));
 const resolve=async entry=>entry.id==='d1'?{filmId:ID(1)}:entry.id==='d2'?{refusal:'dictionary_source_ambiguous',source:{ids:[ID(2),ID(9)]}}:entry.id==='d3'?{refusal:'dictionary_identity_ambiguous',filmId:ID(3),source:entry}:{filmId:ID(4)};
 const owner={[ID(1)]:{read:'ok',entry:'absent'},[ID(4)]:{read:'ok',entry:'present',materialised:'yes'}};
 const dictionary=scripted();
 const base=over=>({...params(),version:'v1',entries,at:T,resolveFilm:resolve,readOwnerReview:async id=>owner[id]||{read:'ok',entry:'absent'},appliers:{dictionary:dictionary.apply},...over});
 STAMP_SNAPSHOT.dictionary_identity_ambiguous={film:{id:ID(3),revision:1},claims:[],identities:[]};
 try{
  const file=database('open');
  const out=await runDictionaryProducerPass(envOf(file),base());
  assert.equal(out.state,'complete');
  assert.deepEqual(dictionary.log,[ID(1),ID(4)],'only resolved, owner-safe entries reach the writer');
  const list=results(file);
  assert.deepEqual(list.map(row=>[row.origin,row.unit_id,row.state,row.code]),[['dictionary','d2','refused_permanent','dictionary_source_ambiguous'],[ 'dictionary',ID(3),'refused_recoverable','dictionary_identity_ambiguous']].sort((a,b)=>a[1]<b[1]?-1:1));
  assert.equal(rows(file,"SELECT run_key FROM canonical_producer_run WHERE origin='dictionary'").length,1);
  const again=await runDictionaryProducerPass(envOf(file),base());
  assert.equal(again.state,'complete');assert.equal(dictionary.log.length,2,'a resume revisits nothing: the cursor is past every unit');
  // an owner entry that is present but not materialised (or unreadable) is a recoverable refusal and the writer never sees that Film
  const inconsistent=database('open'),seen=scripted();
  STAMP_SNAPSHOT.owner_review_inconsistent={film:{id:ID(1),revision:1},entry:{id:'owner:1',revision:1},materialised:[]};
  const result=await runDictionaryProducerPass(envOf(inconsistent),base({appliers:{dictionary:seen.apply},resolveFilm:async entry=>({filmId:entry.id==='d1'?ID(1):ID(4)}),entries:entries.filter(entry=>['d1','d4'].includes(entry.id)),readOwnerReview:async id=>id===ID(1)?{read:'ok',entry:'present',materialised:'no'}:{read:'ok',entry:'unreadable'}}));
  assert.equal(result.state,'complete');assert.equal(seen.log.length,0,'an owner-reviewed Film is never handed to the writer when it cannot be verified');
  assert.deepEqual(results(inconsistent).map(row=>[row.state,row.code]),[['refused_recoverable','owner_review_inconsistent'],['refused_recoverable','owner_review_inconsistent']]);
  // the check cannot run: the pass stops BEFORE anything is minted
  const failing=database('open'),untouched=scripted(),before=dump(failing);
  for(const reader of [async()=>{throw new Error('x');},async()=>({read:'failed'}),async()=>({read:'ok',entry:'surprise'})]){
   const stopped=await runDictionaryProducerPass(envOf(failing),base({appliers:{dictionary:untouched.apply},readOwnerReview:reader}));
   assert.deepEqual([stopped.state,stopped.code,stopped.minted],['stopped','owner_review_check_failed',false]);
  }
  assert.equal(untouched.log.length,0);assert.equal(dump(failing),before,'no run, no result');
  // a reused version whose stored plan is not this plan is never resumed (it needs a new version)
  const tampered=database('open');
  assert.equal((await runDictionaryProducerPass(envOf(tampered),base({appliers:{dictionary:scripted().apply}}))).state,'complete');
  assert.equal(sqlite(tampered,"DROP TRIGGER canonical_producer_run_replay;UPDATE canonical_producer_run SET fingerprint='"+hex('e')+"',revision=revision+1 WHERE origin='dictionary'").status,0);
  const mismatch=await runDictionaryProducerPass(envOf(tampered),base({appliers:{dictionary:scripted().apply}}));
  assert.deepEqual([mismatch.state,mismatch.code],['stopped','producer_cas_lost']);
  // an unresolvable resolver answer fails the build, named
  const bad=await runDictionaryProducerPass(envOf(database('open')),base({resolveFilm:async()=>({filmId:'not-a-film'})}));
  assert.deepEqual([bad.state,bad.code],['error','film_person_invalid']);
  // kept outcomes and a redirected Film
  const kept=database('open');
  const mixed=scripted({[ID(1)]:()=>({skipped:false,cursor:1,done:true,counts:{...ZERO,kept:1},failures:[],stoppedBy:null}),[ID(4)]:()=>({skipped:false,cursor:1,done:true,counts:{...ZERO,redirected:1},failures:[],stoppedBy:null})});
  STAMP_SNAPSHOT.film_person_redirect={film:{id:ID(4),revision:1},redirect:null};
  const k=await runDictionaryProducerPass(envOf(kept),base({appliers:{dictionary:mixed.apply},entries:entries.filter(entry=>['d1','d4'].includes(entry.id)),resolveFilm:async entry=>({filmId:entry.id==='d1'?ID(1):ID(4)})}));
  assert.deepEqual([k.state,k.counts],['complete',{applied:0,noop:0,kept:1,failed:1}]);
  assert.deepEqual(results(kept).map(row=>[row.state,row.code]),[['refused_recoverable','film_person_redirect']]);
 }finally{delete STAMP_SNAPSHOT.dictionary_identity_ambiguous;delete STAMP_SNAPSHOT.owner_review_inconsistent;delete STAMP_SNAPSHOT.film_person_redirect;}
}

// 15. Freshness at the consumer boundary: only a completed pass at the published generation is current; a membership reader fails closed, a display reader returns the state.
{
 const file=database('open'),env=envOf(file);
 assert.equal((await readCanonicalFreshness(env,{publishedGeneration:GEN})).freshness,'lagging','no run');
 assert.equal((await readCanonicalFreshness(env,{})).freshness,'unknown','no published generation');
 await runEpgProducerPass(env,params({film:scripted(),maxSlicesPerRun:1}));
 assert.equal((await readCanonicalFreshness(env,{publishedGeneration:GEN})).freshness,'lagging','passing');
 await runEpgProducerPass(env,params({film:scripted()}));
 const state=await readCanonicalFreshness(env,{publishedGeneration:GEN});
 assert.deepEqual([state.freshness,state.appliedGeneration,state.passState],['current',GEN,'passed']);
 assert.equal((await readCanonicalFreshness(env,{publishedGeneration:'gen-286'})).freshness,'lagging','a newer publication');
 assert.equal((await readCanonicalFreshness(env,{publishedGeneration:'gen-284'})).freshness,'lagging','a backwards publication is never current');
 const failed=database('open');
 await runEpgProducerPass(envOf(failed),params({film:scripted({[ID(2)]:()=>FAIL('film_person_unavailable')})}));
 assert.equal((await readCanonicalFreshness(envOf(failed),{publishedGeneration:GEN})).freshness,'lagging','a failed pass is never current');
 const partial=database('open');
 for(let i=0;i<3;i++)await runEpgProducerPass(envOf(partial),params({film:scripted({[ID(1)]:()=>FAIL('identity_collision')})}));
 assert.equal((await readCanonicalFreshness(envOf(partial),{publishedGeneration:GEN})).freshness,'partial');
 const missing=database('open');
 assert.equal(sqlite(missing,'PRAGMA foreign_keys=OFF;DROP TABLE canonical_producer_unit_result;DROP TABLE canonical_producer_run;').status,0);
 const unknown=await readCanonicalFreshness(envOf(missing),{publishedGeneration:GEN});
 assert.deepEqual([unknown.freshness,unknown.code],['unknown','producer_store_missing']);
 for(const freshness of ['lagging','partial','unknown'])assert.deepEqual(readerDecision({freshness},'membership'),{ok:false,code:'canonical_not_current',freshness});
 assert.deepEqual(readerDecision(state,'membership'),{ok:true,freshness:'current'});
 assert.deepEqual(readerDecision({freshness:'lagging',publishedGeneration:GEN,appliedGeneration:null},'display'),{ok:true,freshness:'lagging',publishedGeneration:GEN,appliedGeneration:null});
 assert.equal(readerDecision(undefined,'membership').ok,false);
 assert.throws(()=>readerDecision(state,'other'),error=>error.code==='film_person_invalid');
}

// 16. The store additions of S4-4: the in-place result update, the latest epg run and the live membership count.
{
 const file=await poisoned(),env=envOf(file);
 const [row]=results(file);
 const patch={state:'open',code:'identity_collision',attempts:row.attempts+1,prereq_stamp:null,next_attempt_at:LATER,updated_at:LATER};
 assert.deepEqual(await S.updateResult(env,{row,patch,at:LATER}),{state:'committed'});
 assert.equal(results(file)[0].attempts,row.attempts+1);
 await assert.rejects(()=>S.updateResult(env,{row,patch,at:LATER}),error=>error.code==='producer_cas_lost');
 await assert.rejects(()=>S.updateResult(env,{row:{...row,attempts:row.attempts+1},patch:{state:'settled',updated_at:LATER},at:LATER}),error=>error.code==='film_person_invalid');
 await assert.rejects(()=>S.updateResult(env,{row:{...row,attempts:row.attempts+1},patch:{attempts:1,updated_at:LATER},at:LATER}),error=>error.code==='film_person_invalid');
 await assert.rejects(()=>S.updateResult(env,{row:{...row,attempts:row.attempts+1},patch:{unit_id:'x'},at:LATER}),error=>error.code==='film_person_invalid');
 assert.equal(await S.liveMembershipCount(env),1);
 // a run that is not stopped is never resumed; the newest run is the latest by creation time
 await assert.rejects(()=>S.commitResume(env,{run:runRow(file),at:LATER}),error=>error.code==='film_person_invalid');
 await runEpgProducerPass(env,params({runId:'R2',sourceGeneration:'gen-286',film:scripted(),now:mkNow('2026-11-14T10:00:00.000Z')}));
 assert.equal((await S.latestEpgRun(env)).run_key,'epg:R2');
 const prepared=database('prepared'),probe=envOf(prepared);
 assert.deepEqual(await S.updateResult(probe,{row,patch,at:LATER}),{state:'skipped',reason:'projector_is_writer'});
 assert.equal(await S.latestEpgRun(envOf(database('open'))),null);
}

// 17. Static: dormant. Nothing imports the driver; it is not bundled; it does not import the Worker; no network, timer, cron, R2 or flag; it writes no table itself.
{
 const text=fs.readFileSync(path.join(SRC,'canonical-producer-driver.js'),'utf8');
 const code_=text.replace(/\/\/.*$/gm,'');
 assert.ok(!/\b(fetch|setTimeout|setInterval|BUCKET|R2|crypto\.subtle|Cron|process\.env|env\.[A-Z_]{4,})\b/.test(code_),'no network, timer, cron, R2 or flag');
 assert.ok(!/\b(INSERT INTO|UPDATE|DELETE FROM)\b/.test(code_),'the driver writes through the store only');
 assert.ok(!/worker\.js/.test(code_),'no import from worker.js');
 const imports=[...text.matchAll(/from '(\.\/[^']+)'/g)].map(match=>match[1]).sort();
 assert.deepEqual(imports,['./canonical-dictionary-producer.js','./canonical-epg-person-producer.js','./canonical-epg-producer.js','./canonical-person-adapters.js','./canonical-person-mutation-producer.js','./canonical-producer-adapters.js','./canonical-producer-run.js','./canonical-producer-store.js']);
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&entry.name!=='canonical-producer-driver.js'&&fs.readFileSync(full,'utf8').includes('canonical-producer-driver'))importers.push(full.replace(/\\/g,'/'));}};
 walk('src');
 assert.deepEqual(importers,[],'nothing in src imports the driver');
 for(const file of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(file))assert.ok(!fs.readFileSync(file,'utf8').includes('canonical-producer-driver'),file+' does not bundle it');
 assert.ok(!fs.readFileSync('src/worker.js','utf8').includes('canonical-producer-driver'),'the Worker does not name it');
}
console.log('canonical-producer-driver: ok');
