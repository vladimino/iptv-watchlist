// AIR-605: the Catalog Enrichment stream of the Monitor (ADR 0211 decision 5 as amended by ADR 0219): the bounded read-only D1 fact reader (src/catalog-enrichment-store.js `readMonitorFacts`) and the pure judgement
// (src/domain/monitor-policy.js `evaluateCatalogEnrichment`, included by `evaluateAll`). Covered: a dormant or absent producer is neutral and a pause is `delayed`; parked and handover runs are healthy while a run whose record
// AND lease are stale is abandoned; due work that is not progressing; a transport streak per source; owner-required and stuck repair diagnostics with source-specific counts; the reader writes nothing.
import assert from 'node:assert/strict';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as P from '../src/domain/monitor-policy.js';
import {dailyDue} from '../src/domain/orchestration-policy.js';
import {readMonitorFacts} from '../src/catalog-enrichment-store.js';

const MIN=60000,HOUR=3600000;
const NOW=Date.parse('2026-11-26T12:00:00.000Z');
const ago=ms=>new Date(NOW-ms).toISOString();
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const keys=result=>result.issues.map(item=>item.key).sort();

// ---- the pure judgement ----
const base=(over={})=>({configured:true,control:{state:'active',generation:3},enabledScopes:1,lastTick:{state:'finished',startedAt:ago(5*MIN),finishedAt:ago(4*MIN)},progressAt:ago(5*MIN),run:{phase:'retired',at:ago(4*MIN),wakeAt:null,instance:'ce-00000004'},leaseUntil:null,due:{films:0,oldestDueSince:null},transport:{},attention:[],repair:[],...over});
{
 assert.deepEqual([P.evaluateCatalogEnrichment({configured:false,reason:'schema_missing'},NOW).state,keys(P.evaluateCatalogEnrichment({configured:false},NOW))],['waiting',[]],'no schema: neutral');
 assert.deepEqual([P.evaluateCatalogEnrichment({configured:false,reason:'no_control'},NOW).facts.status],['not_configured']);
 assert.deepEqual([P.evaluateCatalogEnrichment(base({control:{state:'inactive'}}),NOW).state,P.evaluateCatalogEnrichment(base({control:{state:'inactive'}}),NOW).facts.status],['waiting','not_active'],'a dormant producer never alerts');
 const paused=P.evaluateCatalogEnrichment(base({control:{state:'paused'},due:{films:9,oldestDueSince:ago(9*HOUR)},run:{phase:'running',at:ago(9*HOUR)}}),NOW);
 assert.deepEqual([paused.state,keys(paused)],['delayed',[]],'a pause is the owner\'s choice: delayed, never an alert, whatever is due');
 assert.equal(P.evaluateCatalogEnrichment(null,NOW).issues[0].key,'catalog_enrichment_unreadable');
 assert.equal(P.evaluateCatalogEnrichment({error:true},NOW).state,'degraded');
 assert.equal(P.evaluateCatalogEnrichment({readable:false},NOW).state,'degraded');
 // healthy idle, parked and handover
 assert.deepEqual([P.evaluateCatalogEnrichment(base(),NOW).state,keys(P.evaluateCatalogEnrichment(base(),NOW))],['healthy',[]]);
 const parked=P.evaluateCatalogEnrichment(base({run:{phase:'parked',at:ago(HOUR),wakeAt:new Date(NOW+HOUR).toISOString(),instance:'ce-00000005'},due:{films:2,oldestDueSince:ago(30*MIN)}}),NOW);
 assert.deepEqual([parked.state,keys(parked),parked.facts.status],['waiting',[],'parked'],'a parked run waiting for its due time is healthy (no issue, work is not yet overdue)');
 const handover=P.evaluateCatalogEnrichment(base({run:{phase:'running',at:ago(MIN),wakeAt:null,instance:'ce-00000006'},leaseUntil:new Date(NOW+4*MIN).toISOString(),lastTick:{state:'started',startedAt:ago(2*MIN),finishedAt:null}}),NOW);
 assert.deepEqual(keys(handover),[],'a fresh run, and one backed by a live lease, is healthy');
 const longStep=P.evaluateCatalogEnrichment(base({run:{phase:'running',at:ago(40*MIN),wakeAt:null,instance:'ce-00000007'},leaseUntil:new Date(NOW+MIN).toISOString(),lastTick:{state:'started',startedAt:ago(40*MIN),finishedAt:null}}),NOW);
 assert.deepEqual(keys(longStep),[],'a stale record with a LIVE drainer lease is a healthy long step, not an abandoned run');
 // an abandoned run: stale record and no live lease
 const stale=P.evaluateCatalogEnrichment(base({run:{phase:'running',at:ago(25*MIN),wakeAt:null,instance:'ce-00000008'}}),NOW);
 assert.deepEqual(keys(stale),['catalog_enrichment_run_abandoned']);assert.equal(stale.state,'degraded');
 assert.match(stale.issues[0].message,/ce-00000008/);
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({lastTick:{state:'started',startedAt:ago(30*MIN),finishedAt:null}}),NOW)),['catalog_enrichment_run_abandoned'],'an interrupted tick: started, no lease, past the margin');
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({run:{phase:'parked',at:ago(3*HOUR),wakeAt:ago(HOUR),instance:'ce-00000009'}}),NOW)),['catalog_enrichment_run_abandoned'],'a parked run that missed its wake by more than the margin');
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({run:{phase:'parked',at:ago(3*HOUR),wakeAt:ago(2*MIN),instance:'ce-0000000a'}}),NOW)),[],'a wake that is only just due is not abandonment');
 // due work not progressing
 const stuck=P.evaluateCatalogEnrichment(base({due:{films:4,oldestDueSince:ago(5*HOUR)},progressAt:ago(5*HOUR)}),NOW);
 assert.deepEqual(keys(stuck),['catalog_enrichment_no_progress']);assert.equal(stuck.issues[0].metrics.due,4);
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({due:{films:4,oldestDueSince:ago(5*HOUR)},progressAt:ago(10*MIN)}),NOW)),[],'recent progress: draining is working');
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({due:{films:4,oldestDueSince:ago(30*MIN)},progressAt:null}),NOW)),[],'young work is not overdue');
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({due:{films:0,oldestDueSince:null},progressAt:ago(9*HOUR)}),NOW)),[],'nothing due: an idle producer is healthy');
 // a transport streak per source
 const streak=P.evaluateCatalogEnrichment(base({due:{films:3,oldestDueSince:ago(40*MIN)},progressAt:ago(5*MIN),transport:{tmdb:{since:ago(26*HOUR),films:3},letterboxd:{since:ago(2*HOUR),films:1}}}),NOW);
 assert.deepEqual(keys(streak),['catalog_enrichment_transport_tmdb'],'one issue for the source over 24 h, none for the other');
 assert.match(streak.issues[0].message,/tmdb/);assert.equal(streak.issues[0].metrics.films,3);
 assert.deepEqual(keys(P.evaluateCatalogEnrichment(base({due:{films:0},transport:{tmdb:{since:ago(30*HOUR),films:3}}}),NOW)),[],'no work due: no alert');
 // owner-required and stuck repair, with source-specific counts
 const attention=P.evaluateCatalogEnrichment(base({attention:[{status:'identity_disagreement',source:'*',count:2},{status:'needs_attention',source:'tmdb',count:1}],repair:[{source:'tmdb',count:5,oldestAt:ago(30*HOUR)},{source:'letterboxd',count:1,oldestAt:ago(HOUR)}]}),NOW);
 assert.deepEqual(keys(attention),['catalog_enrichment_attention','catalog_enrichment_repair_deferred']);
 assert.match(attention.issues.find(item=>item.key==='catalog_enrichment_attention').message,/identity_disagreement\/\*: 2, needs_attention\/tmdb: 1/);
 assert.match(attention.issues.find(item=>item.key==='catalog_enrichment_repair_deferred').message,/tmdb: 5/);
 assert.ok(!/letterboxd: 1/.test(attention.issues.find(item=>item.key==='catalog_enrichment_repair_deferred').message),'only repair older than its cap interval is reported');
 // the stream joins evaluateAll only when its facts are supplied, and an alert is planned and confirmed like any other issue
 const all=facts=>P.evaluateAll({epg:null,discovery:null,ratings:null,predictions:null,...facts},null,NOW,{dailyDue});
 void all;
 const streams=P.evaluateAll({epg:{authority:'d1',publishedRunId:'r',publishedAt:ago(HOUR),runError:false,resourceLimit:false,stage:'complete'},discovery:{error:true},ratings:{error:true},predictions:{error:true},catalogEnrichment:stuck.facts&&base({due:{films:4,oldestDueSince:ago(5*HOUR)},progressAt:ago(5*HOUR)})},null,NOW,{dailyDue});
 assert.ok(streams.streams.some(stream=>stream.stream==='catalog_enrichment'&&stream.state==='degraded'));
 const without=P.evaluateAll({epg:{authority:'d1',publishedRunId:'r',publishedAt:ago(HOUR),runError:false,resourceLimit:false,stage:'complete'},discovery:{error:true},ratings:{error:true},predictions:{error:true}},null,NOW,{dailyDue});
 assert.ok(!without.streams.some(stream=>stream.stream==='catalog_enrichment'),'absent facts add no stream');
 const issues=[P.evaluateCatalogEnrichment(base({due:{films:4,oldestDueSince:ago(5*HOUR)},progressAt:ago(5*HOUR)}),NOW).issues[0]];
 const first=P.planAlerts(issues,null,NOW);
 assert.equal(first.sends.length,0,'an ordinary issue is confirmed on the second snapshot');
 const second=P.planAlerts(issues,first.state,NOW+HOUR);
 assert.deepEqual(second.sends.map(item=>[item.kind,item.key,item.stream]),[['alert','catalog_enrichment_no_progress','catalog_enrichment']]);
 const again=P.planAlerts(issues,second.state,NOW+2*HOUR);
 assert.equal(again.sends.length,0,'stable dedup: no second message inside the reminder interval');
 const recovered=P.planAlerts([],again.state,NOW+3*HOUR);
 assert.deepEqual(recovered.sends.map(item=>item.kind),['recovery'],'recovery is sent once');
}

// ---- the reader: bounded, read-only, neutral when absent ----
{
 const bare={DB:d1Standin(migrated(46))};
 assert.deepEqual(await readMonitorFacts(bare,{now:NOW}),{configured:false,reason:'schema_missing'},'an absent schema is neutral, not an error');
 const file=migrated();
 const env={DB:d1Standin(file)};
 assert.deepEqual(await readMonitorFacts(env,{now:NOW}),{configured:false,reason:'no_control'});
 const T0=ago(HOUR),T=ago(HOUR);
 sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:a',2,NULL,'A','${T}'),('film:b',2,NULL,'B','${T}'),('film:c',2,NULL,'C','${T}');
  INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;
  INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');
  INSERT INTO catalog_enrichment_member VALUES ('film:a','rated','${T}','k1'),('film:b','rated','${T}','k2'),('film:c','rated','${T}','k3');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,pending_since,retry_at,updated_at) VALUES
   ('film:a','core','tmdb',0,'due','${ago(3*HOUR)}','${ago(26*HOUR)}',NULL,'${T}'),
   ('film:b','core','tmdb',0,'deferred_repair','${ago(2*HOUR)}',NULL,'${new Date(NOW+HOUR).toISOString()}','${ago(30*HOUR)}'),
   ('film:c','core','letterboxd',0,'needs_attention','${ago(2*HOUR)}',NULL,NULL,'${T}');
  INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,due_since,updated_at) VALUES ('film:c','film','*',0,'identity_disagreement','${T}','${T}');
  INSERT INTO catalog_enrichment_tick (tick_id,started_at,finished_at,state,counts_json) VALUES ('t1','${ago(3*HOUR)}','${ago(3*HOUR-1000)}','finished','{"units":4}'),('t2','${ago(20*MIN)}',NULL,'started','{}');
  INSERT INTO projection_run (projection,summary_json) VALUES ('catalog_enrichment_run','{"phase":"running","instance":"ce-00000003","at":"${ago(25*MIN)}","wakeAt":null,"successor":null}');`);
 const before=rows(file,"SELECT (SELECT COUNT(*) FROM catalog_enrichment_state)||'/'||(SELECT COUNT(*) FROM catalog_enrichment_tick)||'/'||(SELECT COUNT(*) FROM projection_run) AS n")[0].n;
 const facts=await readMonitorFacts(env,{now:NOW});
 assert.equal(facts.configured,true);assert.deepEqual(facts.control,{state:'active',generation:facts.control.generation});
 assert.equal(facts.enabledScopes,1);
 assert.deepEqual(facts.due,{films:1,oldestDueSince:ago(3*HOUR)},'only RUNNABLE Films are due: film:b waits for its retry, film:c is blocked by its disagreement');
 assert.deepEqual(facts.transport,{tmdb:{since:ago(26*HOUR),films:1}});
 assert.deepEqual(facts.attention.sort((a,b)=>a.status<b.status?-1:1),[{status:'identity_disagreement',source:'*',count:1},{status:'needs_attention',source:'letterboxd',count:1}]);
 assert.deepEqual(facts.repair,[{source:'tmdb',count:1,oldestAt:ago(30*HOUR)}]);
 assert.equal(facts.progressAt,ago(3*HOUR),'progress is the newest run that committed units');
 assert.deepEqual([facts.lastTick.state,facts.run.phase,facts.leaseUntil],['started','running',null]);
 assert.equal(rows(file,"SELECT (SELECT COUNT(*) FROM catalog_enrichment_state)||'/'||(SELECT COUNT(*) FROM catalog_enrichment_tick)||'/'||(SELECT COUNT(*) FROM projection_run) AS n")[0].n,before,'the reader writes nothing');
 // the whole path: real D1 facts judged by the policy
 const judged=P.evaluateCatalogEnrichment(facts,NOW);
 assert.deepEqual(keys(judged),['catalog_enrichment_attention','catalog_enrichment_no_progress','catalog_enrichment_repair_deferred','catalog_enrichment_run_abandoned','catalog_enrichment_transport_tmdb'],'abandoned run, no progress with work due, tmdb transport streak, owner items and stuck repair, from D1 alone');
 assert.equal(judged.state,'degraded');
 // a live lease turns the same run into a healthy long step
 sql(file,`INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('catalog_enrichment','L','${new Date(NOW+4*MIN).toISOString()}')`);
 assert.ok(!keys(P.evaluateCatalogEnrichment(await readMonitorFacts(env,{now:NOW}),NOW)).includes('catalog_enrichment_run_abandoned'));
}
console.log('catalog enrichment monitor: ok');
