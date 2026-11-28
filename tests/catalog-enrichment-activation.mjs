// AIR-607 / ADR 0219 decision 3: the operator contract that activates the RATED Catalog Enrichment scope (src/catalog-enrichment-activation.js) on the real migrated schema: refusal before any write, fail-closed preflight,
// the order scope -> bootstrap -> control, resume, idempotence, the live trigger after activation, and that nothing else is enabled. The module is dormant (nothing imports it); the production operation needs its own owner GO.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as A from '../src/catalog-enrichment-activation.js';
import * as S from '../src/catalog-enrichment-store.js';

const T='2026-11-28T10:00:00.000Z';
const OLD='2026-10-01T00:00:00.000Z',CUTOFF='2026-11-01T00:00:00.000Z',NEW='2026-11-10T00:00:00.000Z',LATER='2026-11-29T00:00:00.000Z';
const GO='https://trello.com/c/Daq02gYy#comment-owner-go';
const OPEN="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;";
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const pad=n=>String(n).padStart(4,'0');
const admission=(i,verified,at=T)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:r${pad(i)}',2,NULL,'R','${at}');INSERT INTO film_external_id VALUES ('film:r${pad(i)}','tmdb','${1000+i}',1,0,NULL);INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:r${pad(i)}','${1000+i}','code${i}','${'a'.repeat(64)}','T',2000,'k','tmdb_${1000+i}','${verified}','q','${at}');`;
// 130 rated admissions: 30 before the cutoff and 100 at or after it; the inbox is emptied (no scope was active when they were inserted)
function world({open=true,upTo=Infinity}={}){
 const file=migrated(upTo);
 if(upTo===Infinity){
  if(open)sql(file,OPEN);
  sql(file,Array.from({length:30},(_,i)=>admission(i,OLD)).join('')+Array.from({length:100},(_,i)=>admission(30+i,NEW)).join(''));
  sql(file,'DELETE FROM enrichment_signal;');
 }
 return {file,env:{DB:d1Standin(file)}};
}
const op=(over={})=>({cutoffAt:CUTOFF,by:'operator:AIR-607',at:T,goReference:GO,...over});
const snapshot=file=>JSON.stringify([rows(file,'SELECT * FROM catalog_enrichment_scope'),rows(file,'SELECT * FROM catalog_enrichment_control'),rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')]);

// ---- invalid input refuses before any read or write ----
{
 const {file,env}=world();
 const before=snapshot(file);
 for(const [over,code] of [
  [{cutoffAt:'2026-11-01'},'invalid_cutoff'],[{cutoffAt:null},'invalid_cutoff'],[{cutoffAt:LATER},'cutoff_in_future'],
  [{goReference:undefined},'go_reference_missing'],[{goReference:'owner said yes'},'go_reference_missing'],
  [{by:''},'invalid_operator'],[{by:'x'.repeat(121)},'invalid_operator'],[{at:'now'},'invalid_time']
 ]){
  const out=await A.activateRated(env,op(over));
  assert.equal(out.outcome,'refused');assert.ok(out.problems.includes(code),code+': '+JSON.stringify(out.problems));
 }
 assert.equal(snapshot(file),before,'a refused input writes nothing');
}

// ---- the preflight is fail closed: marker not open, a control that is not inactive, another scope, a staged signal, the schema ----
{
 const {file,env}=world({open:false});
 const out=await A.activateRated(env,op());
 assert.deepEqual([out.outcome,out.problems],['refused',['film_person_marker_not_open']]);
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_scope')[0].n,0,'nothing written');
}
{
 const {file,env}=world();
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('c3a',1,1,NULL,1,'${T}')`);
 const out=await A.activateRated(env,op());
 assert.deepEqual([out.outcome,out.problems],['refused',['other_scope_present']],'no other scope may exist');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM catalog_enrichment_scope WHERE scope='rated'")[0].n,0);
}
{
 const {file,env}=world();
 sql(file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_ref,armed_at,attempts) VALUES ('admitted','tmdb:1','discovery','',1,0,'staged','x','${T}',0)`);
 const out=await A.activateRated(env,op());
 assert.deepEqual([out.outcome,out.problems],['refused',['stale_staged_signals']]);
}
{
 const {env}=world({upTo:46});
 const out=await A.activateRated(env,op());
 assert.equal(out.outcome,'refused');assert.deepEqual(out.problems,['schema_not_applied'],'a schema below the producer\'s refuses');
}

// ---- the whole activation: scope (trigger live) -> bootstrap -> control active; only the rated scope; readback ----
{
 const {file,env}=world();
 assert.equal((await S.readControl(env)).state,'inactive');
 const out=await A.activateRated(env,op({pageSize:40}));
 assert.equal(out.outcome,'activated');
 assert.deepEqual([out.bootstrap.outcome,out.bootstrap.rows,out.bootstrap.pages],['done',100,3]);
 assert.deepEqual(out.scopes,[{scope:'rated',activated:1,enabled:1,cutoffAt:CUTOFF,bootstrapState:'done',revision:1}],'exactly the rated scope with the approved cutoff');
 assert.equal(out.onlyRatedScope,true);
 assert.equal(out.control.state,'active');assert.ok(out.control.generation>=1&&out.control.revision>=2);
 assert.ok(out.control.updatedBy.includes(GO)&&out.control.updatedBy.startsWith('operator:AIR-607'),'the control records who and under which GO');
 assert.deepEqual([out.qualifyingAdmissions,out.ratedSignals],[100,100],'every qualifying admission has its signal; rows before the cutoff have none');
 assert.deepEqual(out.signals,[{source:'rated',state:'pending',count:100}]);
 assert.deepEqual(rows(file,'SELECT scope FROM catalog_enrichment_scope'),[{scope:'rated'}],'no discovery, c3a or c3b scope');
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE subject IN ('tmdb:1000','tmdb:1029')")[0].n,0,'a pre-cutoff admission is not eligible');
 // the same call again changes nothing
 const before=snapshot(file);
 const again=await A.activateRated(env,op());
 assert.deepEqual([again.outcome,again.reason],['noop','already_active']);
 assert.equal(snapshot(file),before);
 // a different cutoff after activation never changes anything either
 const other=await A.activateRated(env,op({cutoffAt:OLD}));
 assert.equal(other.outcome,'refused');assert.ok(other.problems.includes('control_not_inactive'));
 assert.equal(snapshot(file),before);
 // the live trigger: an admission verified after the activation emits its own signal, deduplicated by the unique key
 sql(file,admission(500,'2026-11-28T11:00:00.000Z','2026-11-28T11:00:00.000Z'));
 assert.equal(rows(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE subject='tmdb:1500' AND state='pending'")[0].n,1,'a new rated admission is eligible from day one');
 const rb=await A.readActivation(env);
 assert.deepEqual([rb.qualifyingAdmissions,rb.ratedSignals],[101,101]);
}

// ---- resumable: a stopped bootstrap leaves the control inactive; the same call resumes from the stored cursor ----
{
 const {file,env}=world();
 const first=await A.activateRated(env,op({pageSize:40,maxPages:1}));
 assert.deepEqual([first.outcome,first.reason],['stopped','bootstrap_incomplete']);
 assert.equal((await S.readControl(env)).state,'inactive','the producer stays off until the bootstrap is done');
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40);
 assert.equal(rows(file,"SELECT bootstrap_state FROM catalog_enrichment_scope WHERE scope='rated'")[0].bootstrap_state,'running');
 // a different cutoff never continues someone else's activation
 const wrong=await A.activateRated(env,op({cutoffAt:OLD,pageSize:40}));
 assert.equal(wrong.outcome,'refused');assert.ok(wrong.problems.includes('scope_cutoff_mismatch'));
 assert.equal(rows(file,'SELECT COUNT(*) AS n FROM enrichment_signal')[0].n,40);
 // an interrupted activation is resumed, not restarted
 const second=await A.activateRated(env,op({pageSize:40}));
 assert.equal(second.outcome,'activated');
 assert.deepEqual([second.qualifyingAdmissions,second.ratedSignals],[100,100]);
 assert.ok(rows(file,'SELECT version FROM enrichment_signal').every(row=>row.version===1),'the resume never re-arms a signal');
 assert.equal(rows(file,"SELECT revision FROM catalog_enrichment_scope WHERE scope='rated'")[0].revision,1,'the scope revision is unchanged by the bootstrap');
}

// ---- dormant: nothing in the Worker or any other module imports the activation, and the bundle does not carry it ----
{
 const importers=[];
 for(const name of fs.readdirSync('src'))if(name.endsWith('.js')&&name!=='catalog-enrichment-activation.js'&&fs.readFileSync('src/'+name,'utf8').includes('catalog-enrichment-activation'))importers.push(name);
 assert.deepEqual(importers,[],'the activation is reachable only from the owner\'s production operation');
 assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/catalog-enrichment-activation/);
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/11-59\/15/,'the reconcile cron is a separate versioned configuration change');
}
console.log('catalog enrichment activation: ok');
