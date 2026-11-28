// AIR-605 / ADR 0219 decision 3: the generic offline bootstrap (src/catalog-enrichment-bootstrap.js) on the real migrated schema: bounded revision-fenced paging, cutoff, resume, the overlap with the live trigger, re-enable,
// refusals. The module is dormant (nothing imports it); enabling a scope and executing the rated bootstrap are AIR-607's.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {migrated} from './prediction-d1-flow-lib.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as B from '../src/catalog-enrichment-bootstrap.js';
import * as S from '../src/catalog-enrichment-store.js';

const T='2026-11-26T10:00:00.000Z';
const OLD='2026-10-01T00:00:00.000Z',CUTOFF='2026-11-01T00:00:00.000Z',NEW='2026-11-10T00:00:00.000Z';
const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const pad=n=>String(n).padStart(4,'0');
const admission=(i,verified)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:r${pad(i)}',2,NULL,'R','${T}');INSERT INTO film_external_id VALUES ('film:r${pad(i)}','tmdb','${1000+i}',1,0,NULL);INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:r${pad(i)}','${1000+i}','code${i}','${'a'.repeat(64)}','T',2000,'k','tmdb_${1000+i}','${verified}','q','${T}');`;
// 130 rated admissions: 30 before the cutoff and 100 at or after it
function world({scope=true,enabled=1,cutoff=CUTOFF}={}){
 const file=migrated();
 sql(file,Array.from({length:30},(_,i)=>admission(i,OLD)).join('')+Array.from({length:100},(_,i)=>admission(30+i,NEW)).join(''));
 sql(file,"DELETE FROM enrichment_signal;");
 if(scope)sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,cutoff_at,revision,updated_at) VALUES ('rated',1,${enabled},${cutoff?`'${cutoff}'`:'NULL'},1,'${T}');`);
 return {file,env:{DB:d1Standin(file)}};
}
const signals=file=>rows(file,"SELECT subject,source,version,state,cause_ref FROM enrichment_signal ORDER BY subject");
const scopeRow=file=>rows(file,"SELECT bootstrap_state,bootstrap_cursor,revision FROM catalog_enrichment_scope WHERE scope='rated'")[0];

// ---- the whole bootstrap: only the qualifying rows, in key order, bounded pages, then done ----
{
 const {file,env}=world();
 const out=await B.runBootstrap(env,{scope:'rated',at:T,pageSize:40});
 assert.deepEqual([out.outcome,out.rows,out.pages],['done',100,3],'100 qualifying rows in pages of at most 40');
 const found=signals(file);
 assert.equal(found.length,100,'rows before the cutoff are not bootstrapped');
 assert.ok(found.every(row=>row.source==='rated'&&row.version===1&&row.state==='pending'&&row.cause_ref==='bootstrap:rated'));
 assert.equal(found[0].subject,'tmdb:1030');
 assert.deepEqual(scopeRow(file),{bootstrap_state:'done',bootstrap_cursor:'film:r0129',revision:1},'the cursor and state live in the scope row; the revision is unchanged');
 // done is terminal for the page function
 assert.equal((await B.bootstrapPage(env,{scope:'rated',at:T})).outcome,'done');
 assert.equal(signals(file).length,100);
}

// ---- bounded and resumable: maxPages stops it, the next call continues from the stored cursor ----
{
 const {file,env}=world();
 const first=await B.runBootstrap(env,{scope:'rated',at:T,pageSize:30,maxPages:2});
 assert.deepEqual([first.outcome,first.pages,first.rows,first.state],['advanced',2,60,'running']);
 assert.equal(signals(file).length,60);
 const second=await B.runBootstrap(env,{scope:'rated',at:T,pageSize:30,maxPages:5});
 assert.deepEqual([second.outcome,second.rows],['done',40],'the rest, resumed from the cursor, with no row twice');
 assert.equal(signals(file).length,100);
}

// ---- the overlap with the live tail is deduplicated: no re-arm, no second version ----
{
 const {file,env}=world();
 await B.bootstrapPage(env,{scope:'rated',at:T,pageSize:30});          // film:r0030..r0059
 // a row admitted during the bootstrap is caught by the live trigger (the scope is activated)
 sql(file,admission(500,NEW));
 assert.equal(signals(file).filter(row=>row.subject==='tmdb:1500').length,1,'the trigger wrote the live signal');
 // an already bootstrapped row is re-admitted by the live path: a re-arm (version 2) by the trigger itself, not by the bootstrap
 sql(file,"UPDATE enrichment_signal SET state='consumed',acked_version=version WHERE subject='tmdb:1030'");
 await B.runBootstrap(env,{scope:'rated',at:T,pageSize:30});
 const byKey=Object.fromEntries(signals(file).map(row=>[row.subject,row]));
 assert.equal(byKey['tmdb:1030'].state,'consumed','the bootstrap never re-arms a signal that already exists');
 assert.equal(byKey['tmdb:1030'].version,1);
 assert.equal(byKey['tmdb:1500'].version,1,'the live tail row is not doubled by the bootstrap');
}

// ---- fenced: a changed configuration stops a stale bootstrap and it writes nothing ----
{
 const {file,env}=world();
 await B.bootstrapPage(env,{scope:'rated',at:T,pageSize:30});
 const before=signals(file).length;
 // the configuration moves (a revision change) between the read and the write of the next page
 let moved=false;
 const racing={DB:new Proxy(env.DB,{get(target,prop){if(prop==='batch')return async list=>{if(!moved){moved=true;sql(file,"UPDATE catalog_enrichment_scope SET revision=revision+1 WHERE scope='rated'");}return target.batch(list);};return target[prop];}})};
 const out=await B.bootstrapPage(racing,{scope:'rated',at:T,pageSize:30});
 assert.equal(out.outcome,'stopped');assert.equal(out.reason,'revision_moved');
 assert.equal(signals(file).length,before,'a stale bootstrap wrote no signal');
 assert.equal(scopeRow(file).bootstrap_cursor,'film:r0059','and did not advance the cursor');
 // a concurrent pager that already advanced the cursor: the second page applies nothing twice
 const w2=world();
 await B.bootstrapPage(w2.env,{scope:'rated',at:T,pageSize:30});
 let advanced=false;
 const racing2={DB:new Proxy(w2.env.DB,{get(target,prop){if(prop==='batch')return async list=>{if(!advanced){advanced=true;sql(w2.file,"UPDATE catalog_enrichment_scope SET bootstrap_cursor='film:r0070' WHERE scope='rated'");}return target.batch(list);};return target[prop];}})};
 const out2=await B.bootstrapPage(racing2,{scope:'rated',at:T,pageSize:30});
 assert.equal(out2.outcome,'stopped');assert.equal(out2.reason,'cursor_moved');
 assert.equal(scopeRow(w2.file).bootstrap_cursor,'film:r0070','the other pager\'s cursor stands');
}

// ---- a cursor advance is not a configuration change: it does not move the control generation ----
{
 const {file,env}=world();
 sql(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`);
 const generation=()=>rows(file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 const g0=generation();
 await B.runBootstrap(env,{scope:'rated',at:T,pageSize:30});
 assert.equal(generation(),g0,'bootstrap pages do not stop a running drainer');
 // re-enable: the bootstrap is re-armed under the revision (a configuration change, so the generation moves) and re-runs idempotently
 const rearm=await B.rearmBootstrap(env,{scope:'rated',at:T,expectedRevision:1});
 assert.deepEqual([rearm.rearmed,rearm.revision],[true,2]);
 assert.ok(generation()>g0,'the re-arm is a configuration change');
 sql(file,"UPDATE enrichment_signal SET state='consumed',acked_version=version");
 const again=await B.runBootstrap(env,{scope:'rated',at:T,pageSize:50});
 assert.equal(again.outcome,'done');
 assert.ok(signals(file).every(row=>row.state==='consumed'&&row.version===1),'the second pass found every signal and changed none');
 assert.equal((await B.rearmBootstrap(env,{scope:'rated',at:T,expectedRevision:1})).rearmed,false,'a stale revision re-arms nothing');
}

// ---- refusals: an unknown scope, a scope that is not enabled, a missing cutoff; nothing is written ----
{
 const {file,env}=world({enabled:0});
 await assert.rejects(()=>B.bootstrapPage(env,{scope:'c3b',at:T}),error=>error.code==='catalog_enrichment_bootstrap_scope_unsupported');
 await assert.rejects(()=>B.bootstrapPage(env,{scope:'discovery',at:T}),error=>error.code==='catalog_enrichment_bootstrap_scope_unsupported','discovery has no bootstrap');
 const held=await B.bootstrapPage(env,{scope:'rated',at:T});
 assert.deepEqual([held.outcome,held.reason],['stopped','scope_not_enabled']);
 const noCutoff=world({cutoff:null});
 const stopped=await B.bootstrapPage(noCutoff.env,{scope:'rated',at:T});
 assert.deepEqual([stopped.outcome,stopped.reason],['stopped','cutoff_missing'],'the rated bootstrap needs the approved cutoff');
 assert.equal(signals(file).length+signals(noCutoff.file).length,0,'nothing was written');
 const absent=world({scope:false});
 assert.equal((await B.bootstrapPage(absent.env,{scope:'rated',at:T})).reason,'scope_not_enabled');
 await assert.rejects(()=>B.bootstrapPage(world().env,{scope:'rated',at:'yesterday'}),error=>error.code==='film_person_invalid');
 await assert.rejects(()=>B.bootstrapPage(world().env,{scope:'rated',at:T,pageSize:0}),error=>error.code==='film_person_invalid');
}

// ---- c3a: every admitted rated Film, no cutoff ----
{
 const {file,env}=world();
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3a',1,1,1,'${T}');`);
 const out=await B.runBootstrap(env,{scope:'c3a',at:T,pageSize:50,maxPages:10});
 assert.deepEqual([out.outcome,out.rows],['done',130]);
 assert.equal(signals(file).length,130,'c3a bootstraps the whole admitted rated cohort, before the cutoff too');
}


// ---- distinct authorized memberships: the c3a signal is its own key, the cutoff of rated cannot be bypassed, and disabling one scope strands nothing of the other ----
{
 const {file,env}=world();
 sql(file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3a',1,1,1,'${T}');INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`);
 await B.runBootstrap(env,{scope:'rated',at:T,pageSize:50,maxPages:10});
 await B.runBootstrap(env,{scope:'c3a',at:T,pageSize:50,maxPages:10});
 const sig=rows(file,"SELECT COUNT(*) AS n,part FROM enrichment_signal GROUP BY part ORDER BY part");
 assert.deepEqual(sig,[{n:100,part:''},{n:130,part:'c3a'}],'rated signals for the qualifying rows, c3a signals for every admitted Film: two distinct keys, no shared one');
 // consume every signal through the real guarded consumer
 const generation=(await S.readControl(env)).generation;
 assert.equal((await S.acquireLease(env,{leaseId:'lease-boot-aaaa',now:T})).acquired,true);
 for(let round=0;round<20;round++){
  const batch=await S.runnableSignals(env,{now:T,limit:50});
  if(!batch.length)break;
  for(const signal of batch)await S.consumeSignal(env,{signal,generation:(await S.readControl(env)).generation,leaseId:'lease-boot-aaaa',now:T});
 }
 const members=film=>rows(file,`SELECT scope FROM catalog_enrichment_member WHERE film_id='${film}' ORDER BY scope`).map(row=>row.scope);
 assert.deepEqual(members('film:r0005'),['c3a'],'a Film from before the cutoff is a c3a member only: the rated cutoff is not bypassed');
 assert.deepEqual(members('film:r0050'),['c3a','rated'],'a Film at or after the cutoff holds both authorized memberships');
 // disabling rated strands nothing that c3a holds: the Film keeps an enabled membership
 sql(file,"UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='rated'");
 const eligible=rows(file,"SELECT COUNT(DISTINCT film_id) AS n FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1")[0].n;
 assert.equal(eligible,130,'every Film still has an enabled membership after rated is disabled');
}

// dormant: nothing in the Worker or any other module imports the bootstrap
{
 const importers=[];
 for(const name of fs.readdirSync('src'))if(name.endsWith('.js')&&name!=='catalog-enrichment-bootstrap.js'&&name!=='catalog-enrichment-activation.js'&&fs.readFileSync('src/'+name,'utf8').includes('catalog-enrichment-bootstrap'))importers.push(name);
 assert.deepEqual(importers,[],'the bootstrap is reachable only from AIR-607\'s activation operation (which tests/catalog-enrichment-activation.mjs proves is itself not imported), not from the Worker');
 assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/catalog-enrichment-bootstrap/);
}
console.log('catalog enrichment bootstrap: ok');
