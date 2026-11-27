// AIR-605: the storage side of the Catalog Enrichment Producer (src/catalog-enrichment-store.js): control, lease, emit, runnable signals and the GUARDED consumption of ADR 0219 decision 2, on the real migrated schema
// through the sqlite3-CLI D1 stand-in. Synthetic ids only; nothing is applied anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as S from '../src/catalog-enrichment-store.js';

const T='2026-11-26T10:00:00.000Z';
const at=seconds=>new Date(Date.parse(T)+seconds*1000).toISOString();
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const q=v=>v==null?'NULL':"'"+String(v).replace(/'/g,"''")+"'";
function world(){
 const file=migrated();
 sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}'),('film:b',2,NULL,'B','${T}'),('film:c',2,NULL,'C','${T}');
  INSERT INTO film_external_id VALUES ('film:a','tmdb','10',1,0,NULL),('film:b','tmdb','20',1,0,NULL);`);
 sql(file,`DELETE FROM enrichment_signal;`);
 return {file,env:{DB:d1Standin(file)}};
}
const signalOf=(file,kind,subject,source='',part='')=>rows(file,`SELECT * FROM enrichment_signal WHERE kind=${q(kind)} AND subject=${q(subject)} AND source=${q(source)} AND part=${q(part)}`)[0];
const active=(file,{rated=true}={})=>{
 sql(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`);
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,${rated?1:0},1,'${T}');`);
 sql(file,`UPDATE catalog_enrichment_control SET generation=generation+1,revision=revision+1;`.replace('UPDATE','UPDATE')); // keep the generation moving past the scope insert
 return rows(file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
};
const lease=async(env,id='lease-aaaaaaaa',now=T)=>{const r=await S.acquireLease(env,{leaseId:id,now});assert.equal(r.acquired,true);return id;};

// ---- control: absent reads inactive, activation is not reachable from pause/resume, CAS and readback ----
{
 const {env,file}=world();
 assert.deepEqual(await S.readControl(env),{present:false,state:'inactive',generation:0,revision:0,updatedAt:null,updatedBy:null});
 assert.equal((await S.pauseControl(env,{expectedRevision:0,by:'owner',at:T})).outcome,'rejected','nothing to pause when inactive');
 assert.equal((await S.resumeControl(env,{expectedRevision:0,by:'owner',at:T})).outcome,'rejected','resume never activates from inactive');
 await assert.rejects(()=>S.changeControl(env,{action:'activate',expectedRevision:0,by:'owner',at:T}),error=>error.code==='catalog_enrichment_activation_not_allowed');
 assert.equal((await S.readControl(env)).present,false,'still no row');
 const activated=await S.activateControl(env,{expectedRevision:0,by:'owner',at:T});
 assert.equal(activated.outcome,'applied');assert.deepEqual([activated.control.state,activated.control.generation,activated.control.revision],['active',1,2]);
 const stale=await S.pauseControl(env,{expectedRevision:1,by:'owner',at:at(1)});
 assert.equal(stale.outcome,'rejected','a stale expectedRevision changes nothing');assert.equal(stale.control.state,'active');
 const paused=await S.pauseControl(env,{expectedRevision:2,by:'owner',at:at(2)});
 assert.deepEqual([paused.outcome,paused.control.state,paused.control.generation,paused.control.revision],['applied','paused',2,3]);
 assert.equal((await S.pauseControl(env,{expectedRevision:3,by:'owner',at:at(3)})).outcome,'rejected','already paused');
 const resumed=await S.resumeControl(env,{expectedRevision:3,by:'owner',at:at(4)});
 assert.deepEqual([resumed.outcome,resumed.control.state,resumed.control.generation],['applied','active',3],'resume raises the generation too');
 await assert.rejects(()=>S.pauseControl(env,{expectedRevision:'x',by:'o',at:T}),error=>error.code==='film_person_invalid');
 await assert.rejects(()=>S.pauseControl(env,{expectedRevision:4,by:'o',at:'yesterday'}),error=>error.code==='film_person_invalid');
 // the unreadable readback is `uncertain`, never a claim
 let reads=0;
 const flaky={DB:{prepare:sqlText=>{const real=env.DB.prepare(sqlText);return {bind:(...p)=>{const stmt=real.bind(...p);return {...stmt,first:async()=>{if(/FROM catalog_enrichment_control/.test(sqlText)&&++reads>1)throw new Error('readback down');return stmt.first();}};}};},batch:(...a)=>env.DB.batch(...a)}};
 assert.equal((await S.pauseControl(flaky,{expectedRevision:4,by:'owner',at:at(5)})).outcome,'uncertain');
 assert.equal((await S.readControl(env)).state,'paused','the write itself did land');
 // an absent schema is a typed refusal for a change and "inactive" for a read
 const bare={DB:d1Standin(migrated(45))};
 assert.equal((await S.readControl(bare)).state,'inactive');
 await assert.rejects(()=>S.pauseControl(bare,{expectedRevision:0,by:'o',at:T}),error=>error.code==='catalog_enrichment_schema_missing');
}

// ---- lease ----
{
 const {env,file}=world();
 assert.equal((await S.acquireLease(env,{leaseId:'lease-aaaaaaaa',now:T})).acquired,true);
 assert.equal((await S.acquireLease(env,{leaseId:'lease-bbbbbbbb',now:at(60)})).acquired,false,'a live lease is never stolen');
 assert.equal(await S.renewLease(env,{leaseId:'lease-aaaaaaaa',now:at(60)}),true);
 assert.equal(await S.renewLease(env,{leaseId:'lease-bbbbbbbb',now:at(60)}),false,'only the owner renews');
 assert.equal((await S.acquireLease(env,{leaseId:'lease-bbbbbbbb',now:at(60+301)})).acquired,true,'an expired lease is reacquired');
 assert.equal(await S.renewLease(env,{leaseId:'lease-aaaaaaaa',now:at(400)}),false,'the old owner can no longer renew');
 assert.equal(await S.releaseLease(env,{leaseId:'lease-aaaaaaaa',now:at(401)}),false,'a stale owner releases nothing');
 assert.equal(await S.releaseLease(env,{leaseId:'lease-bbbbbbbb',now:at(402)}),true);
 assert.equal((await S.acquireLease(env,{leaseId:'lease-cccccccc',now:at(403)})).acquired,true,'a released lease is free');
 await assert.rejects(()=>S.acquireLease(env,{leaseId:'x',now:T}),error=>error.code==='film_person_invalid');
}

// ---- emit: digest-carrying signals re-arm only on a different digest ----
{
 const {env,file}=world();
 const emit=args=>S.emitStatement({kind:'source_changed',subject:'film:a',source:'tmdb',part:'core',at:T,...args});
 const run=([text,params])=>env.DB.prepare(text).bind(...params).run();
 await run(emit({digest:'a'.repeat(64)}));
 assert.equal(signalOf(file,'source_changed','film:a','tmdb','core').version,1);
 await run(emit({digest:'a'.repeat(64)}));
 assert.equal(signalOf(file,'source_changed','film:a','tmdb','core').version,1,'an identical observation writes nothing');
 await run(emit({digest:'b'.repeat(64)}));
 assert.equal(signalOf(file,'source_changed','film:a','tmdb','core').version,2,'a different digest re-arms');
 await run(S.emitStatement({kind:'anchor_changed',subject:'film:a',at:T}));await run(S.emitStatement({kind:'anchor_changed',subject:'film:a',at:T}));
 assert.equal(signalOf(file,'anchor_changed','film:a').version,2,'a repeated event without a digest coalesces into one row and re-arms');
 assert.throws(()=>S.emitStatement({kind:'nope',subject:'x',at:T}),error=>error.code==='film_person_invalid');
}

// ---- consumption of `admitted`: guarded, membership and state row, replay ----
{
 const {env,file}=world();
 const generation=active(file);
 const id=await lease(env);
 sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','rated','',1,'pending','${T}'),('admitted','tmdb:999','rated','',1,'pending','${T}'),('admitted','tmdb:20','watchlist','',1,'pending','${T}'),('admitted','tmdb:10','discovery','',1,'pending','${T}');`);
 const runnable=await S.runnableSignals(env,{now:at(1)});
 assert.deepEqual(runnable.map(item=>item.subject+':'+item.source),['tmdb:10:rated'],'unresolved (no Film for tmdb:999), held (watchlist and discovery scopes are not enabled) signals are not runnable');
 assert.equal(runnable[0].filmId,'film:a');
 const result=await S.consumeSignal(env,{signal:runnable[0],generation,leaseId:id,now:at(1)});
 assert.deepEqual(result,{consumed:true});
 assert.deepEqual(rows(file,'SELECT film_id,scope,signal_key FROM catalog_enrichment_member'),[{film_id:'film:a',scope:'rated',signal_key:'admitted|tmdb:10|rated|'}],'the retained membership');
 assert.deepEqual(rows(file,"SELECT part,source,status FROM catalog_enrichment_state"),[{part:'film',source:'*',status:'active'}]);
 const row=signalOf(file,'admitted','tmdb:10','rated');
 assert.deepEqual([row.state,row.acked_version],['consumed',1]);
 // a replay applies nothing and an unresolved retry is idempotent
 const replay=await S.consumeSignal(env,{signal:runnable[0],generation,leaseId:id,now:at(2)});
 assert.equal(replay.consumed,false);assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_member')[0].n,1,'no second membership');
 assert.deepEqual(await S.runnableSignals(env,{now:at(3)}),[],'a consumed signal is no longer runnable');
 // the same Film re-admitted coalesces to the same membership
 sql(file,"UPDATE enrichment_signal SET version=2,state='pending' WHERE subject='tmdb:10' AND source='rated'");
 await S.consumeSignal(env,{signal:{...runnable[0],version:2},generation,leaseId:id,now:at(4)});
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_member')[0].n,1);
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE part='film'")[0].n,1,'one state row per Film whatever the scope');
 assert.deepEqual(await S.consumeSignal(env,{signal:{kind:'admitted',subject:'tmdb:10',source:'letterboxd',part:'',version:1,filmId:'film:a'},generation,leaseId:id,now:at(5)}),{consumed:false,reason:'no_scope'});
}

// ---- guarded consumption: every stale case applies NOTHING and keeps the newest version pending ----
{
 const cases={
  'a re-arm during consumption':{mutate:(file)=>sql(file,"UPDATE enrichment_signal SET version=2,state='pending' WHERE subject='tmdb:10'")},
  'a control paused':{mutate:(file)=>sql(file,"UPDATE catalog_enrichment_control SET state='paused',generation=generation+1,revision=revision+1")},
  'a control generation moved (a scope change)':{mutate:(file)=>sql(file,"UPDATE catalog_enrichment_scope SET revision=revision+1")},
  'the lease lost':{mutate:(file)=>sql(file,"UPDATE projection_run SET lease_id='lease-other000'")},
  'the lease expired':{mutate:(file,)=>sql(file,"UPDATE projection_run SET lease_until='2020-01-01T00:00:00.000Z'")},
  // the RESOLVED identity: the trusted claim moved to another Film, or the Film was merged, after the signal was read
  'the trusted claim moved to another Film':{mutate:(file)=>sql(file,"UPDATE film_external_id SET film_id='film:c' WHERE scheme='tmdb' AND value='10'")},
  'the claim became conflicting':{mutate:(file)=>sql(file,"UPDATE film_external_id SET conflicting=1 WHERE scheme='tmdb' AND value='10'")},
  'the Film was merged (a redirect exists)':{mutate:(file)=>sql(file,`INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:a','film:c','${T}')`)},
 };
 for(const [name,{mutate}] of Object.entries(cases)){
  const {env,file}=world();
  const generation=active(file);
  const id=await lease(env);
  sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','rated','',1,'pending','${T}');`);
  const [signal]=await S.runnableSignals(env,{now:at(1)});
  mutate(file);
  const result=await S.consumeSignal(env,{signal,generation,leaseId:id,now:at(1)});
  assert.equal(result.consumed,false,name);
  assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_member')[0].n,0,name+': no membership');
  assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_state')[0].n,0,name+': no state row');
  const row=signalOf(file,'admitted','tmdb:10','rated');
  assert.deepEqual([row.state,row.acked_version],['pending',0],name+': no acknowledgement for a guarded-out effect, the signal stays pending');
 }
 // the scope disabled during consume: nothing applied
 const {env,file}=world();
 const generation=active(file);const id=await lease(env);
 sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','rated','',1,'pending','${T}');`);
 const [signal]=await S.runnableSignals(env,{now:at(1)});
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1");
 assert.equal((await S.consumeSignal(env,{signal,generation,leaseId:id,now:at(1)})).consumed,false);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_member')[0].n,0);
 assert.deepEqual(await S.runnableSignals(env,{now:at(2)}),[],'a held (disabled) signal is not runnable');
 // enabling again catches the held signal up: nothing was lost
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=1,revision=revision+1");
 const generation2=rows(file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 const [again]=await S.runnableSignals(env,{now:at(3)});
 assert.equal((await S.consumeSignal(env,{signal:again,generation:generation2,leaseId:id,now:at(3)})).consumed,true,'catch-up on re-enable');
 // a failed consumption stays pending, records the failure and backs off; another signal is not blocked
 const w=world();
 const g=active(w.file);const lid=await lease(w.env);
 sql(w.file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','rated','',1,'pending','${T}'),('admitted','tmdb:20','rated','',1,'pending','${at(1)}');`);
 const both=await S.runnableSignals(w.env,{now:at(2)});
 assert.equal(both.length,2);
 let fail=true;
 const flaky={DB:{prepare:s=>w.env.DB.prepare(s),batch:async statements=>{if(fail&&/enrichment_signal/.test(statements[statements.length-1]?.text||'')&&/tmdb:10/.test(statements[statements.length-1]?.text||''))throw new Error('D1_ERROR: boom');return w.env.DB.batch(statements);}}};
 const first=await S.consumeSignal(flaky,{signal:both[0],generation:g,leaseId:lid,now:at(2)});
 assert.deepEqual(first,{consumed:false,reason:'batch_failed'});
 const failedRow=signalOf(w.file,'admitted','tmdb:10','rated');
 assert.deepEqual([failedRow.state,failedRow.attempts,failedRow.retry_at],['pending',1,at(2+60)],'attempts and the next retry (one minute) are recorded');
 assert.equal((await S.consumeSignal(flaky,{signal:both[1],generation:g,leaseId:lid,now:at(2)})).consumed,true,'one failing signal never blocks the others');
 assert.deepEqual((await S.runnableSignals(w.env,{now:at(3)})).map(item=>item.subject),[],'a backed-off signal is not runnable before its retry');
 assert.deepEqual((await S.runnableSignals(w.env,{now:at(70)})).map(item=>item.subject),['tmdb:10'],'and is runnable when due');
 fail=false;
}

// ---- a stale failure never backs off a fresher event ----
{
 const {env,file}=world();
 const generation=active(file);const id=await lease(env);
 sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','rated','',1,'pending','${T}');`);
 const [signal]=await S.runnableSignals(env,{now:at(1)});
 sql(file,"UPDATE enrichment_signal SET version=2,attempts=0,retry_at=NULL,state='pending' WHERE subject='tmdb:10'"); // a re-arm after the signal was read
 await S.recordFailure(env,{signal,now:at(1),error:{code:'boom'}});
 const row=signalOf(file,'admitted','tmdb:10','rated');
 assert.deepEqual([row.attempts,row.retry_at,row.last_error],[0,null,null],'the failure of version 1 does not touch version 2');
 void generation;void id;
 await S.recordFailure(env,{signal:{...signal,version:2},now:at(1),error:{code:'boom'}});
 assert.equal(signalOf(file,'admitted','tmdb:10','rated').attempts,1,'the failure of the observed version is recorded');
}

// ---- eligibility is decided BEFORE the window: held heads cannot hide runnable signals ----
{
 const {env,file}=world();
 // the rated scope is held (disabled); the discovery scope is enabled
 sql(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,0,1,'${T}'),('discovery',1,1,1,'${T}');`);
 const films=Array.from({length:12},(_,i)=>`('film:h${i}',2,NULL,'H${i}','${T}')`).join(',');
 sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ${films};`+Array.from({length:12},(_,i)=>`INSERT INTO film_external_id VALUES ('film:h${i}','tmdb','${100+i}',1,0,NULL);INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${100+i}','rated','',1,'pending','2026-11-25T00:00:0${i%10}.000Z');`).join('')
  +`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:10','discovery','',1,'pending','${T}');`);
 const runnable=await S.runnableSignals(env,{now:at(1),limit:5});
 assert.deepEqual(runnable.map(item=>item.subject),['tmdb:10'],'12 older held heads do not fill the window; the one runnable signal is returned');
}

// ---- consumption of the reopening kinds ----
{
 const {env,file}=world();
 const generation=active(file);const id=await lease(env);
 sql(file,`INSERT INTO catalog_enrichment_member VALUES ('film:a','rated','${T}','k');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,plan_epoch,due_since,updated_at) VALUES ('film:a','film','*',0,'active',4,'${T}','${T}');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,refresh_epoch,source_version,due_since,updated_at) VALUES
   ('film:a','core','tmdb',0,'complete',1,'v1','${T}','${T}'),('film:a','core','letterboxd',0,'complete_with_gaps',0,'v2','${T}','${T}'),
   ('film:a','credits','tmdb',0,'needs_attention',0,NULL,'${T}','${T}'),('film:a','localization','tmdb',0,'complete',0,'v3','${T}','${T}');
  INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('anchor_changed','film:a','','',1,'pending','${T}'),('protection_released','film:a','','metadata',1,'pending','${T}');
  INSERT INTO enrichment_signal (kind,subject,source,part,version,state,cause_digest,armed_at) VALUES ('source_changed','film:a','tmdb','core',1,'pending','${'1'.repeat(64)}','${T}');`);
 const state=()=>Object.fromEntries(rows(file,"SELECT part||':'||source AS k,status,refresh_epoch,plan_epoch FROM catalog_enrichment_state").map(r=>[r.k,[r.status,r.refresh_epoch,r.plan_epoch]]));
 const bySig=Object.fromEntries((await S.runnableSignals(env,{now:at(1)})).map(item=>[item.kind,item]));
 assert.deepEqual(Object.keys(bySig).sort(),['anchor_changed','protection_released','source_changed'],'a Film with an enabled membership has runnable signals');
 await S.consumeSignal(env,{signal:bySig.protection_released,generation,leaseId:id,now:at(1)});
 assert.deepEqual([state()['core:tmdb'],state()['core:letterboxd'],state()['credits:tmdb'],state()['localization:tmdb'],state()['film:*']],[['due',2,0],['due',1,0],['needs_attention',0,0],['complete',0,0],['active',0,5]],'a protection release wakes only the part it held (core), once, and raises the plan epoch');
 // source_changed with the same digest the part applied, complete: dropped without a fetch
 sql(file,"UPDATE catalog_enrichment_state SET status='complete',source_version='"+'1'.repeat(64)+"',refresh_epoch=7 WHERE part='core' AND source='tmdb'");
 await S.consumeSignal(env,{signal:bySig.source_changed,generation,leaseId:id,now:at(2)});
 assert.deepEqual(state()['core:tmdb'].slice(0,2),['complete',7],'a digest equal to the applied one on a complete part is dropped (no epoch raise)');
 // a different digest keeps the part due
 sql(file,"UPDATE enrichment_signal SET version=2,state='pending',cause_digest='"+'2'.repeat(64)+"' WHERE kind='source_changed'");
 await S.consumeSignal(env,{signal:{...bySig.source_changed,version:2,digest:'2'.repeat(64)},generation,leaseId:id,now:at(3)});
 assert.deepEqual(state()['core:tmdb'].slice(0,2),['due',8],'a changed digest reopens it once');
 // an anchor change lifts an identity disagreement and reopens the non-complete rows, never a complete one
 sql(file,"UPDATE catalog_enrichment_state SET status='identity_disagreement' WHERE part='film';UPDATE catalog_enrichment_state SET status='complete',refresh_epoch=3 WHERE part='localization'");
 await S.consumeSignal(env,{signal:bySig.anchor_changed,generation,leaseId:id,now:at(4)});
 assert.equal(state()['film:*'][0],'active','the disagreement is lifted');
 assert.equal(state()['localization:tmdb'][0],'complete','a complete part is not fetched again on a schedule');
 assert.equal(state()['credits:tmdb'][0],'due','a held part is reopened');
 // no membership at all: the signal is not runnable
 sql(file,"DELETE FROM catalog_enrichment_member;INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('anchor_changed','film:b','','',1,'pending','"+T+"')");
 assert.deepEqual((await S.runnableSignals(env,{now:at(5)})).filter(item=>item.subject==='film:b'),[],'a Film in no enabled scope is ignored');
}
assert.ok(fs.existsSync('src/catalog-enrichment-store.js'));
console.log('catalog enrichment store: ok');
