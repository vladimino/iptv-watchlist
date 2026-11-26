// AIR-605: the resource-bounded queue drainer (src/catalog-enrichment-drain.js; ADR 0219 decisions 2, 5 and 6) on the real migrated schema with injected fetches. Covered: more than two Films per run (no quota), the inbox consumed
// inside the run, handover at the statement budget and the next run continuing at once, pause and generation fences, a parked run with its due time, no busy loop on a blocked or waiting Film, the lease, an injected yield, and the
// outbox entry of each run. Synthetic ids only; nothing is applied anywhere.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as D from '../src/catalog-enrichment-drain.js';
import * as S from '../src/catalog-enrichment-store.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-drain-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const T='2026-11-26T10:00:00.000Z';
let tick=0;
const clock=()=>new Date(Date.parse(T)+(tick++)*1000).toISOString();
let n=0;
function world(films=6,{active=true}={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,text).status,0);
 const ids=Array.from({length:films},(_,i)=>100+i);
 assert.equal(sqlite(file,ids.map(id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K${id}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);`).join('')+'DELETE FROM enrichment_signal;').status,0);
 if(active)assert.equal(sqlite(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');`+ids.map(id=>`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${id}','rated','',1,'pending','${T}');`).join('')).status,0);
 return {file,env:{DB:d1Standin(file)},ids};
}
const res=(status,body='',headers={})=>({status,ok:status>=200&&status<300,headers:{get:name=>headers[String(name).toLowerCase()]??null},text:async()=>body,body:null});
const movie=(id,cast=1)=>({id,release_date:'1999-03-30',runtime:100,overview:'s'+id,poster_path:'/p.jpg',genres:[{name:'G'}],credits:{cast:Array.from({length:cast},(_,i)=>({id:id*1000+i,name:'A'+i,order:i})),crew:[{id:id*10+1,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Т'+id}}]}});
function upstream({tmdb='ok',onCall=null,cast=1}={}){
 const calls=[];
 const impl=async url=>{
  url=String(url);calls.push(url);
  if(onCall)await onCall(url,calls.length);
  if(url.startsWith('https://api.themoviedb.org/')){const id=Number(/movie\/(\d+)/.exec(url)[1]);return tmdb==='transport'?res(503):res(200,JSON.stringify(movie(id,cast)));}
  if(url.startsWith('https://query.wikidata.org/'))return res(200,JSON.stringify({results:{bindings:[]}}));
  throw new Error('unexpected '+url);
 };
 impl.calls=calls;return impl;
}
const run=(w,fetchImpl,over={})=>D.drain(w.env,{runId:'run-'+(tick++)+'-'+Math.random().toString(16).slice(2,8),clock,tools:{},fetchImpl,...over});
const metaCount=file=>rows(file,'SELECT COUNT(*) AS n FROM film_metadata')[0].n;
const ticks=file=>rows(file,'SELECT tick_id,state,counts_json FROM catalog_enrichment_tick ORDER BY started_at');

// ---- more than two Films drain in one run; the inbox is consumed inside it; the run ends because there is nothing left ----
{
 const w=world(6);
 const up=upstream();
 const result=await run(w,up);
 assert.equal(result.stop,'idle');
 assert.equal(result.counts.films>=6,true,'six Films in one run: there is no two-Film quota');
 assert.equal(result.counts.signals,6,'every admitted signal was consumed inside the run, each by one guarded batch');
 assert.equal(metaCount(w.file),6);
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_person_credit").n??rows(w.file,"SELECT COUNT(*) AS n FROM film_person_credit")[0].n,12,'credits too');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_localization_source WHERE source='tmdb'")[0].n,6);
 assert.ok(result.counts.statements>0&&result.counts.statements<D.BUDGET.statements,'the run counted its statements: '+result.counts.statements);
 const requests=up.calls.length;
 const again=await run(w,up);
 assert.equal(again.stop,'idle');assert.equal(up.calls.length,requests,'a drained queue makes no request: no polling, no busy loop');
 const [first]=ticks(w.file);
 assert.equal(first.state,'finished');assert.equal(JSON.parse(first.counts_json).stop,'idle','the outbox entry carries the stop reason and the budget');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'the run left no pending signal and its own writes woke nothing');
 assert.equal(rows(w.file,'SELECT lease_id FROM projection_run')[0].lease_id,null,'the lease is released');
}

// ---- the statement budget: handover, and the next run continues at once ----
{
 const w=world(6);
 const small={...D.BUDGET,statements:420,handoverAt:300,reserve:60,stepEstimate:40};
 const up=upstream();
 const first=await run(w,up,{budget:small});
 assert.equal(first.stop,'handover','the run ends at its budget and the caller creates the successor');
 assert.ok(first.counts.statements<=420,'the budget holds: '+first.counts.statements);
 const done=metaCount(w.file);
 assert.ok(done>=1&&done<6,'some Films finished, the rest wait: '+done);
 let guard=0,last=first;
 while(last.stop==='handover'&&guard++<20)last=await run(w,up,{budget:small});
 assert.equal(last.stop,'idle');assert.equal(metaCount(w.file),6,'successive runs finish every Film with no wait between them');
 assert.deepEqual(rows(w.file,"SELECT operation_key,COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied' GROUP BY operation_key HAVING COUNT(*)>1"),[],'no unit was applied twice across the handovers (no duplicate receipt, no duplicate write)');
 assert.ok(guard>=1);
}

// ---- pause and generation fences ----
{
 const w=world(6);
 const pausedAfter=upstream({onCall:async(url,count)=>{if(count===3)await S.pauseControl(w.env,{expectedRevision:rows(w.file,'SELECT revision FROM catalog_enrichment_control')[0].revision,by:'owner',at:clock()});}});
 const result=await run(w,pausedAfter);
 assert.equal(result.stop,'paused');
 const before=pausedAfter.calls.length;
 assert.ok(metaCount(w.file)<6,'the pause stopped the run');
 assert.equal((await run(w,pausedAfter)).stop,'paused');assert.equal(pausedAfter.calls.length,before,'no new request after a pause');
 // resume keeps the pending work: the next run finishes it
 await S.resumeControl(w.env,{expectedRevision:rows(w.file,'SELECT revision FROM catalog_enrichment_control')[0].revision,by:'owner',at:clock()});
 assert.equal((await run(w,upstream())).stop,'idle');assert.equal(metaCount(w.file),6,'resume keeps all pending work');
 const inactive=world(2,{active:false});
 assert.equal((await run(inactive,upstream())).stop,'not_active');
 // a scope change moves the generation under a running plan
 const moved=world(4);
 const hook=upstream({onCall:async(url,count)=>{if(count===2)sqlite(moved.file,"UPDATE catalog_enrichment_scope SET revision=revision+1");}});
 assert.equal((await run(moved,hook)).stop,'generation_moved','a scope change fences the run: it stops and the next run re-reads the control');
}

// ---- a parked run: every remaining item deferred, with the due time; no busy loop ----
{
 const w=world(3);
 const down=upstream({tmdb:'transport'});
 const result=await run(w,down);
 assert.equal(result.stop,'parked');
 assert.ok(result.wakeAt>T,'the run parks until the earliest retry_at: '+result.wakeAt);
 const calls=down.calls.length;
 assert.ok(calls<=6,'each Film was asked once per source, never in a loop: '+calls);
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE failures>0 AND failure_class='transport'")[0].n,0,'transport consumes no failure');
 const again=await run(w,down);
 assert.equal(again.stop,'parked');assert.equal(down.calls.length,calls,'before its retry_at nothing is asked again');
 assert.equal(JSON.parse(ticks(w.file).at(-1).counts_json).stop,'parked');
 // at the due time the work runs
 sqlite(w.file,"UPDATE catalog_enrichment_state SET retry_at=NULL WHERE retry_at IS NOT NULL");
 assert.equal((await run(w,upstream())).stop,'idle');assert.equal(metaCount(w.file),3);
}

// ---- a blocked Film and an owner-locked one never keep a run spinning ----
{
 const w=world(3);
 sqlite(w.file,`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('film:tmdb:100','metadata','reviewed','owner',NULL,NULL,NULL,'owner',NULL,NULL,NULL,0,'none','${T}');`);
 const up=upstream();
 const result=await run(w,up);
 assert.equal(result.stop,'idle');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_metadata WHERE film_id='film:tmdb:100'")[0].n,0,'the owner-locked Film is not written');
 assert.equal(metaCount(w.file),2);
 assert.ok(up.calls.length<=10,'bounded requests: '+up.calls.length);
 sqlite(w.file,"UPDATE catalog_enrichment_state SET status='identity_disagreement' WHERE part='film' AND film_id='film:tmdb:101'");
 const calls=up.calls.length;
 assert.equal((await run(w,up)).stop,'idle');assert.equal(up.calls.length,calls,'a blocked Film is skipped, no request');
}

// ---- the lease and an injected yield ----
{
 const w=world(3);
 await S.acquireLease(w.env,{leaseId:'lease-other-owner',now:clock()});
 const held=await run(w,upstream());
 assert.equal(held.stop,'lease_held');assert.equal(metaCount(w.file),0,'a live lease of another owner is never stolen');
 sqlite(w.file,"UPDATE projection_run SET lease_until='2020-01-01T00:00:00.000Z'");
 const up=upstream();
 const yielded=await run(w,up,{shouldYield:async()=>true});
 assert.equal(yielded.stop,'yield');assert.equal(up.calls.length,0,'a yield starts no new step');
 assert.equal((await run(w,up)).stop,'idle');assert.equal(metaCount(w.file),3,'an expired lease is reacquired');
}
// ---- a storage failure defers the Film, the independent work continues, repeated failures back the run off ----
{
 const w=world(4);
 const flaky={DB:d1Standin(w.file,{rewrite:sql=>/FROM film_dimension WHERE film_id=\? AND dimension='metadata'/.test(sql)&&!/film_id IN/.test(sql)?'SELECT broken FROM nowhere':sql})};
 const result=await D.drain(flaky,{runId:'run-flaky-'+(tick++),clock,tools:{},fetchImpl:upstream()});
 assert.equal(result.stop,'error_backoff','three failing Films back the run off: no crash, no loop');
 assert.equal(result.counts.errors,3);
 assert.equal(rows(w.file,'SELECT lease_id FROM projection_run')[0].lease_id,null,'the lease is released after an error stop');
 assert.equal(JSON.parse(ticks(w.file).at(-1).counts_json).stop,'error_backoff');
 // the healthy path recovers the same Films afterwards
 assert.equal((await run(w,upstream())).stop,'idle');assert.equal(metaCount(w.file),4);
}
// ---- a large cast across handovers: the Film resumes from its persisted chunk rows, nothing is applied twice, and completing persisted units makes no upstream request ----
{
 const w=world(1);
 const small={...D.BUDGET,statements:520,handoverAt:380,reserve:80,stepEstimate:40,unitEstimate:40};
 const up=upstream({cast:140});
 const first=await run(w,up,{budget:small});
 assert.equal(first.stop,'handover','the Film does not fit one run: it is NEVER deferred for not fitting, it resumes');
 const persisted=()=>rows(w.file,"SELECT slot,status,expected_json IS NOT NULL AS has FROM catalog_enrichment_state WHERE part='credits' ORDER BY slot");
 let guard=0,last=first,fetchedWithRows=null;
 while(last.stop==='handover'&&guard++<80){
  if(fetchedWithRows===null&&persisted().some(row=>row.has)&&rows(w.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n<141)fetchedWithRows=up.calls.filter(url=>url.includes('themoviedb')).length;
  last=await run(w,up,{budget:small});
 }
 assert.equal(last.stop,'idle');
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM film_person_credit')[0].n,141,'every credit of a 141-credit Film (140 actors, one director), across several runs');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM person WHERE id LIKE 'person:tmdb_%'")[0].n,141);
 assert.deepEqual(persisted().map(row=>row.slot),[0,1,2],'three persisted chunk rows of at most 50');
 assert.ok(persisted().every(row=>row.status==='complete'));
 assert.ok(guard>=2,'it really crossed several runs: '+guard);
 assert.notEqual(fetchedWithRows,null,'a run ended between persisted chunks');
 assert.equal(up.calls.filter(url=>url.includes('themoviedb')).length,fetchedWithRows,'once the chunk rows exist, completing the persisted units makes no upstream request');
 assert.deepEqual(rows(w.file,"SELECT operation_key,COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied' GROUP BY operation_key HAVING COUNT(*)>1"),[],'no duplicate receipt: no unit was applied twice');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state IN ('pending','unknown')")[0].n,0,'no receipt left unresolved');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_person_credit WHERE role='actor'")[0].n,140);
}
// ---- a new code version is a repair event: the first run wakes every deferred repairable item whatever its retry_at ----
{
 const w=world(1);
 sqlite(w.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',2,NULL,'O','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','tmdb',0,'deferred_repair','repairable',7,'older','2099-01-01T00:00:00.000Z','${T}','${T}'),('film:tmdb:900','credits','tmdb',0,'deferred_repair','repairable',7,'older','2099-01-01T00:00:00.000Z','${T}','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','letterboxd',0,'deferred_repair','repairable',7,'${'c1-1'}','2099-01-01T00:00:00.000Z','${T}','${T}');`);
 await run(w,upstream());
 const woken=rows(w.file,"SELECT part,source,retry_at FROM catalog_enrichment_state WHERE film_id='film:tmdb:900' ORDER BY part,source");
 assert.deepEqual(woken.map(row=>[row.part,row.source,row.retry_at]),[['core','letterboxd','2099-01-01T00:00:00.000Z'],['core','tmdb',null],['credits','tmdb',null]],'rows of an older code version are runnable at once; a row of the current version keeps its backoff');
}
console.log('catalog enrichment drain: ok');
