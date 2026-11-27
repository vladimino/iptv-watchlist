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
import {publishGeneration} from '../src/published-epg.js';
import {CODE_VERSION} from '../src/catalog-enrichment-producer.js';

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
const movie=(id,cast=1)=>({id,release_date:'1999-03-30',runtime:100,overview:'s'+id,poster_path:'/p.jpg',genres:[{id:18,name:'G'}],credits:{cast:Array.from({length:cast},(_,i)=>({id:id*1000+i,name:'A'+i,order:i})),crew:[{id:id*10+1,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Т'+id,overview:''}}]},images:{posters:[]}});
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
 assert.equal(yielded.stop,'yield');assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0,'a yield writes nothing canonical');assert.ok(up.calls.length<=2,'the held write boundary stops the run after at most one Film probe (TMDB and Wikidata): '+up.calls.length);
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
 // the Films were deferred DURABLY: before their retry they are not asked again; when it is due the healthy path recovers them
 assert.ok(rows(w.file,'SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE retry_at IS NOT NULL')[0].n>=1);
 sqlite(w.file,'UPDATE catalog_enrichment_state SET retry_at=NULL');
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
 sqlite(w.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',2,NULL,'O','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','tmdb',0,'deferred_repair','repairable',7,'older','2099-01-01T00:00:00.000Z','${T}','${T}'),('film:tmdb:900','credits','tmdb',0,'deferred_repair','repairable',7,'older','2099-01-01T00:00:00.000Z','${T}','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','letterboxd',0,'deferred_repair','repairable',7,'${CODE_VERSION}','2099-01-01T00:00:00.000Z','${T}','${T}');`);
 await run(w,upstream());
 const woken=rows(w.file,"SELECT part,source,retry_at FROM catalog_enrichment_state WHERE film_id='film:tmdb:900' ORDER BY part,source");
 assert.deepEqual(woken.map(row=>[row.part,row.source,row.retry_at]),[['core','letterboxd','2099-01-01T00:00:00.000Z'],['core','tmdb',null],['credits','tmdb',null]],'rows of an older code version are runnable at once; a row of the current version keeps its backoff');
}
// ---- priority end to end: authoritative facts, per-cohort bounded examination, mixed scopes, fairness across runs ----
{
 const w=world(0);
 const addFilm=(n,scope,{rated=false}={})=>sqlite(w.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${n}',2,NULL,'K${n}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${n}','tmdb','${n}',1,0,NULL);INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${n}','${scope}','${T}','k${n}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,cohort,due_since,updated_at) VALUES ('film:tmdb:${n}','film','*',0,'active','check_anchors','${scope==='c3a'?'history':'live'}','${T}','${T}');`+(rated?`INSERT INTO film_rated_admission (film_id,tmdb,source_code,archive_sha256,title,year,receipt_key,receipt_film_key,verified_at,request_id,updated_at) VALUES ('film:tmdb:${n}','${n}','code${n}','${'a'.repeat(64)}','T',2000,'k','tmdb_${n}','${T}','q','${T}');`:''));
 sqlite(w.file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3a',1,1,1,'${T}'),('discovery',1,1,1,'${T}');`);
 const gen=rows(w.file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 addFilm(301,'rated',{rated:true});   // personal (a verified rated admission)
 addFilm(302,'discovery');            // discovery only: available in the pinned generation
 addFilm(303,'discovery');            // discovery only: NOT in the pinned generation, no personal fact
 addFilm(304,'c3a');                  // held only by the historical widening, no positive fact
 addFilm(305,'rated');                // rated scope, no admission row: personal unknown
 const classes=async()=>{const d=await D.dueFilms(w.env,{now:at0(1)});return {live:d.live.map(item=>item.filmId.slice(-3)).sort(),background:d.background.map(item=>item.filmId.slice(-3)).sort(),examined:d.examined};};
 const at0=sec=>new Date(Date.parse(T)+sec*1000).toISOString();
 // no readable pinned generation: availability is UNKNOWN, never false
 let c=await classes();
 assert.deepEqual(c.live,['301','302','303','305'],'unknown is not false: every Film of a live scope with an unknown fact is live');
 assert.deepEqual(c.background,['304'],'a history-only Film with no positive fact is background');
 // a readable pinned generation: 303 is now a KNOWN absence of both facts -> background; 302 is available -> live
 sqlite(w.file,"INSERT INTO published_epg_generation (programme_run_id,phase,published_at,payload_sha256,created_at) VALUES ('run1','published','"+T+"','"+'b'.repeat(64)+"','"+T+"');INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run1','programme',0,'film:tmdb:302');UPDATE published_epg_authority SET mode='d1',cutover='open',programme_run_id='run1',generation=1;");
 c=await classes();
 assert.deepEqual(c.live,['301','302','305'],'available in the pinned generation, or personal, or unknown: live');
 assert.deepEqual(c.background,['303','304'],'a retained Discovery Film that stopped airing (known absence of both) and a history-only Film are background');
 // a positive live fact promotes a history Film whatever its cohort
 sqlite(w.file,"INSERT INTO published_epg_member (programme_run_id,kind,ordinal,film_id) VALUES ('run1','watchlist',0,'film:tmdb:304')");
 c=await classes();
 assert.ok(c.live.includes('304')&&!c.background.includes('304'),'a positive fact makes the Film live whatever its cohort');
 // bounded examination: at most `window` rows per cohort, and a head that is backed off leaves the window by its retry_at
 const heavy=world(0);
 sqlite(heavy.file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,1,1,'${T}');`+Array.from({length:150},(_,i)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${1000+i}',2,NULL,'K','${T}');INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${1000+i}','discovery','${T}','k${i}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,cohort,retry_at,due_since,updated_at) VALUES ('film:tmdb:${1000+i}','core','tmdb',0,'due','live',${i<100?"'2099-01-01T00:00:00.000Z'":'NULL'},'${T}','${T}');`).join(''));
 const d=await D.dueFilms(heavy.env,{now:at0(1),window:20});
 assert.equal(d.examined.live,20,'a pick examines at most the window per cohort ('+d.examined.live+')');
 assert.equal(d.live.length+d.background.length,20);
 assert.ok([...d.live,...d.background].every(item=>Number(item.filmId.slice(-4))>=1100),'100 backed-off items ahead of the runnable ones never block them: they are not in the window');
 // fairness: background work progresses under sustained live arrivals, measured in committed units ACROSS runs
 const f=world(0);
 sqlite(f.file,`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('c3a',1,1,1,'${T}');`);
 const mk=(n,scope)=>sqlite(f.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${n}',2,NULL,'K${n}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${n}','tmdb','${n}',1,0,NULL);INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${n}','${scope}','${T}','k${n}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,cohort,due_since,updated_at) VALUES ('film:tmdb:${n}','film','*',0,'active','check_anchors','${scope==='c3a'?'history':'live'}','${T}','${T}');`);
 for(let i=0;i<8;i++)mk(400+i,'rated');
 for(let i=0;i<3;i++)mk(500+i,'c3a');
 const small={...D.BUDGET,statements:420,handoverAt:300,reserve:60,stepEstimate:40,unitEstimate:40};
 const fup=upstream();
 const order=[];let seen=new Set();
 let last={stop:'handover'},guard=0;
 while(last.stop==='handover'&&guard++<80){
  last=await run(f,fup,{budget:small});
  for(const r of rows(f.file,"SELECT film_id FROM film_metadata"))if(!seen.has(r.film_id)){seen.add(r.film_id);order.push(r.film_id.slice(-3));}
 }
 assert.equal(last.stop,'idle');assert.equal(order.length,11,'every Film finished');
 const firstHistory=order.findIndex(id=>id.startsWith('5')),lastLive=order.map(id=>id.startsWith('4')).lastIndexOf(true);
 assert.ok(firstHistory>=0&&firstHistory<lastLive,'background Films were served while live Films were still arriving, across handovers: '+order.join(','));
}
// ---- the narrow EPG yield, decided at the WRITE boundary from the publication's own state; inbox, anchor checks and planning continue; a repeated yield is a short parked wait, not a loop ----
{
 const w=world(3);
 const base=Date.parse(T);
 const setLease=(holder,expiresAt)=>sqlite(w.file,`INSERT INTO discovery_lease (id,lease_id,expires_at,holder_kind) VALUES (1,'epg-lease',${expiresAt},${holder?`'${holder}'`:'NULL'}) ON CONFLICT(id) DO UPDATE SET lease_id='epg-lease',expires_at=${expiresAt},holder_kind=${holder?`'${holder}'`:'NULL'}`);
 const setStage=(state,claim)=>sqlite(w.file,`DELETE FROM published_epg_stage;INSERT INTO published_epg_stage (programme_run_id,target_programme_run_id,phase,payload_sha256,state,owner_token,claim_nonce,claim_generation,claim_expires_at,chunk_count,member_count,show_count,document_count,created_at,updated_at) VALUES ('run-1','run-1','published','${'a'.repeat(64)}','${state}','tok',NULL,1,${claim},1,0,0,0,'${T}','${T}')`);
 const far=base+3600000;
 const up=upstream();
 // evidence that is NOT a hold: a Discovery-held lease, an expired EPG lease, no stage, a stalled stage (its publisher claim expired) and a published stage
 setLease('discovery',far);assert.equal(await D.epgPublicationWindow(w.env,base),null,'a Discovery lease is not an EPG publication');
 setLease('epg',base-1);assert.equal(await D.epgPublicationWindow(w.env,base),null,'an expired EPG lease is not a hold');
 setStage('loading',base-1);assert.equal(await D.epgPublicationWindow(w.env,base),null,'a stalled stage (expired claim) never holds enrichment');
 setStage('published',far);assert.equal(await D.epgPublicationWindow(w.env,base),null,'a published stage is finished');
 // evidence that IS a hold, each with a SHORT re-check (not the lease expiry)
 setStage('loading',far);assert.deepEqual(await D.epgPublicationWindow(w.env,base),{until:base+D.EPG_RECHECK_MS,evidence:'epg_stage'});
 setStage('validated',far);assert.equal((await D.epgPublicationWindow(w.env,base)).evidence,'epg_stage');
 sqlite(w.file,'DELETE FROM published_epg_stage');
 sqlite(w.file,"UPDATE published_epg_authority SET cutover='held' WHERE id=1");assert.equal(await D.epgPublicationWindow(w.env,base),null,'the held cutover marker has no publisher and no heartbeat: it is not a hold, it could hold enrichment forever');
 sqlite(w.file,"UPDATE published_epg_authority SET cutover='open' WHERE id=1");
 setLease('epg',far);assert.deepEqual(await D.epgPublicationWindow(w.env,base),{until:base+D.EPG_RECHECK_MS,evidence:'epg_lease'});
 // a held publication: the inbox, the anchor check and the fetch continue, the canonical WRITES do not
 const held=await D.drain(w.env,{runId:'run-epg-1',clock,tools:{},fetchImpl:up});
 assert.equal(held.stop,'yield');assert.equal(held.reason,'epg_lease');
 assert.ok(Date.parse(held.wakeAt)<=Date.parse(clock())+D.EPG_RECHECK_MS,'the run parks for a SHORT re-check, not until the lease expiry: '+held.wakeAt);
 assert.equal(held.counts.signals,3,'the inbox is consumed while the writes yield');
 assert.ok(up.calls.length>=1&&up.calls.length<=2,'safe work continued: the Film was planned and fetched once (TMDB and Wikidata): '+up.calls.length);
 assert.equal(metaCount(w.file),0);assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0,'no canonical write during the publication');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_member")[0].n,3,'the memberships were recorded');
 const probes=up.calls.length;
 // repeated yields do not loop: each is one parked answer with a wake time, and each costs at most one Film probe
 for(let i=0;i<3;i++){const again=await D.drain(w.env,{runId:'run-epg-r'+i,clock,tools:{},fetchImpl:up});assert.equal(again.stop,'yield');assert.ok(again.wakeAt);}
 assert.equal(up.calls.length,probes,'waiting for the publication repeats NO upstream probe: the Film is flagged and the hold is rechecked before the fetch');
 assert.ok(JSON.parse(rows(w.file,"SELECT film_json AS j FROM catalog_enrichment_state WHERE part='film' AND film_json LIKE '%writeWaitSince%' LIMIT 1")[0].j).writeWaitSince,'the wait is recorded on the Film row');
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0);
 // the moment the publication ends the work runs
 setLease('epg',base-1);
 assert.equal((await run(w,up)).stop,'idle');assert.equal(metaCount(w.file),3,'the held work completes right after the publication ends');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE film_json LIKE '%writeWaitSince%'")[0].n,0,'the wait flag is cleared once writes progress');
}

// ---- a contention failure defers the Film DURABLY with a short backoff and never touches the 72 h clock ----
{
 const w=world(2);
 const flaky={DB:d1Standin(w.file,{rewrite:sql=>/FROM film_dimension WHERE film_id=\? AND dimension='metadata'/.test(sql)&&!/film_id IN/.test(sql)?'SELECT broken FROM nowhere':sql})};
 const result=await D.drain(flaky,{runId:'run-defer-'+(tick++),clock,tools:{},fetchImpl:upstream()});
 assert.ok(result.counts.deferred>=1,'a failed Film is deferred durably');
 const deferred=rows(w.file,"SELECT film_id,retry_at,transport_streak,pending_since,failures FROM catalog_enrichment_state WHERE retry_at IS NOT NULL");
 assert.ok(deferred.length>=1);
 for(const row of deferred){assert.equal(row.transport_streak,1);assert.equal(row.pending_since,null,'a local failure never starts the 72 h fallback clock');assert.equal(row.failures,0,'and consumes no failure');assert.ok(row.retry_at>T);}
 // automatic safe resume: when the retry is due the healthy path finishes the Film
 sqlite(w.file,"UPDATE catalog_enrichment_state SET retry_at=NULL");
 assert.equal((await run(w,upstream())).stop,'idle');assert.equal(metaCount(w.file),2);
}

// ---- a backed-off signal is a due time: the run parks for it instead of going idle until the cron ----
{
 const w=world(1);
 sqlite(w.file,"UPDATE enrichment_signal SET retry_at='2099-01-01T00:00:00.000Z',last_error='boom',attempts=1");
 const held=await run(w,upstream());
 assert.equal(held.stop,'parked','a pending signal in back-off is not idle');
 assert.equal(held.wakeAt,'2099-01-01T00:00:00.000Z','the park wakes at the signal retry time');
 sqlite(w.file,"UPDATE enrichment_signal SET retry_at=NULL");
 assert.equal((await run(w,upstream())).counts.signals,1,'at its due time the signal is consumed');
}

// ---- bounded examination by indexed paging: a head wider than the window, disabled scopes, repeated slots, locked rows ----
{
 const T0=T;
 const state=(film,part,source,slot,status,due,retry='NULL',cohort='live')=>`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,cohort,retry_at,due_since,updated_at) VALUES ('${film}','${part}','${source}',${slot},'${status}','${cohort}',${retry},'${due}','${T0}');`;
 const film=id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K','${T0}');`;
 const member=(id,scope)=>`INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${id}','${scope}','${T0}','k${id}');`;
 const early=i=>`2026-11-01T00:${String(Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`;
 const late=i=>`2026-11-20T00:00:${String(i).padStart(2,'0')}.000Z`;

 // 1. 120 Films of a DISABLED scope sit ahead of 10 runnable rated Films: paging reaches them, and the rows read are reported exactly
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,0,1,'"+T0+"');");
  sqlite(w.file,Array.from({length:120},(_,i)=>film(2000+i)+member(2000+i,'discovery')+state('film:tmdb:'+(2000+i),'core','tmdb',0,'due',early(i))).join('')+Array.from({length:10},(_,i)=>film(3000+i)+member(3000+i,'rated')+state('film:tmdb:'+(3000+i),'core','tmdb',0,'due',late(i))).join(''));
  const d=await D.dueFilms(w.env,{now:'2026-11-26T10:00:00.000Z'});
  const found=new Set([...d.live,...d.background].map(item=>item.filmId));
  assert.equal(found.size,10,'the disabled head did not hide the runnable Films behind it');
  assert.ok([...found].every(id=>id.startsWith('film:tmdb:3')));
  assert.ok(d.examined.live>=130&&d.examined.live<=D.MAX_PAGES*50*2,'the examined rows are the index rows actually read, bounded by the page budget: '+d.examined.live);
  assert.ok(d.pages>=3,'it paged: '+d.pages);
 }
 // 2. one Film with 100 repeated slots ahead of 10 other Films never occupies the whole first page
 {
  const w=world(0);
  sqlite(w.file,film(4000)+member(4000,'rated')+Array.from({length:100},(_,i)=>state('film:tmdb:4000','credits','tmdb',i,'due',early(0))).join('')+Array.from({length:10},(_,i)=>film(4100+i)+member(4100+i,'rated')+state('film:tmdb:4'+String(100+i),'core','tmdb',0,'due',late(i))).join(''));
  const d=await D.dueFilms(w.env,{now:'2026-11-26T10:00:00.000Z'});
  assert.equal(new Set([...d.live,...d.background].map(item=>item.filmId)).size,11,'the 100 slots of one Film and the 10 other Films are all found');
 }
 // 3. owner-locked rows at the head are reported as blocked and deferred durably: they leave the head
 {
  const w=world(0);
  sqlite(w.file,Array.from({length:120},(_,i)=>film(5000+i)+member(5000+i,'rated')+state('film:tmdb:'+(5000+i),'core','tmdb',0,'due',early(i))+`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('film:tmdb:${5000+i}','metadata','reviewed','owner',NULL,NULL,NULL,'owner',NULL,NULL,NULL,0,'none','${T0}');`).join('')+Array.from({length:5},(_,i)=>film(5200+i)+member(5200+i,'rated')+state('film:tmdb:'+(5200+i),'core','tmdb',0,'due',late(i))).join(''));
  const now='2026-11-26T10:00:00.000Z';
  const first=await D.dueFilms(w.env,{now});
  assert.equal(new Set([...first.live,...first.background].map(item=>item.filmId)).size,5,'the five ordinary Films are found behind 120 locked ones');
  assert.ok(first.blocked.length>=50&&first.blocked.every(item=>item.why==='owner_locked'));
  const generation=(await S.readControl(w.env)).generation;
  assert.equal((await S.acquireLease(w.env,{leaseId:'lease-defer-aaaa',now})).acquired,true);
  const deferred=await D.deferBlocked(w.env,{blocked:first.blocked,leaseId:'lease-defer-aaaa',generation,now});
  assert.ok(deferred>0&&deferred<=D.DEFER_BLOCKED_LIMIT,'a bounded number of Films is deferred per pick: '+deferred);
  const after=rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE retry_at IS NOT NULL")[0].n;
  assert.equal(after,deferred,'the deferral is durable and writes only the retry time of the blocked rows');
  const second=await D.dueFilms(w.env,{now});
  assert.ok(second.examined.live<=first.examined.live,'the deferred rows left the head');
 }
 // 4. an unreadable fact source is UNKNOWN, never a negative: a Discovery-only Film stays live when the Watchlist read fails
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,1,1,'"+T0+"');"+film(6000)+member(6000,'discovery')+state('film:tmdb:6000','core','tmdb',0,'due',late(0)));
  const readable=await D.relevanceFacts(w.env,['film:tmdb:6000']);
  assert.equal(readable.get('film:tmdb:6000').personal,false,'a readable absence on a Discovery-only Film is a negative');
  const broken={DB:d1Standin(w.file,{rewrite:sql=>/FROM watchlist_film WHERE film_id IN/.test(sql)?'SELECT broken FROM nowhere':sql})};
  const unknown=await D.relevanceFacts(broken,['film:tmdb:6000']);
  assert.equal(unknown.get('film:tmdb:6000').personal,null,'an unreadable Watchlist is unknown, not "not personal"');
  const picked=await D.dueFilms(broken,{now:'2026-11-26T10:00:00.000Z'});
  assert.equal(picked.live.length,1,'the Film stays live when its facts are unknown');
 }
}

// ---- the upstream request budget: every request sent is counted at the fetch boundary and the drain hands over at its request budget ----
{
 const w=world(6);
 const up=upstream();
 const tight={...D.BUDGET,requests:6,requestsHandoverAt:4};
 const first=await run(w,up,{budget:tight});
 assert.equal(first.stop,'handover','the request budget hands the run over');
 assert.equal(first.counts.requests,up.calls.length,'the count is the number of requests actually sent, not a derived figure');
 assert.ok(first.counts.requests>=4&&first.counts.requests<=8,'it stopped near its budget: '+first.counts.requests);
 let guard=0,last=first;
 while(last.stop==='handover'&&guard++<30)last=await run(w,up,{budget:tight});
 assert.equal(last.stop,'idle');assert.equal(metaCount(w.file),6,'successive runs finish everything under the request budget');
}

// ---- the inbox is budgeted: signals the budget cannot cover stay pending for the successor ----
{
 const w=world(8);
 const tiny={...D.BUDGET,statements:260,handoverAt:24,reserve:60,stepEstimate:40,unitEstimate:30};
 const first=await run(w,upstream(),{budget:tiny});
 const pending=rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n;
 assert.ok(first.counts.signals<8&&pending===8-first.counts.signals,'the run consumed only the signals its budget covered: consumed '+first.counts.signals+', pending '+pending);
 let guard=0;
 while(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n>0&&guard++<20)await run(w,upstream(),{budget:tiny});
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0,'the successors consumed the rest of the inbox, each within its own budget');
 assert.equal((await run(w,upstream())).stop,'idle');assert.equal(metaCount(w.file),8,'and a normal budget then drains the Films');
}

// ---- forward progress past a head larger than the whole per-pick page budget ----
{
 const T0=T;
 const film=id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K','${T0}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);`;
 const member=(id,scope)=>`INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${id}','${scope}','${T0}','k${id}');`;
 const state=(film,part,source,slot,due)=>`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,cohort,retry_at,due_since,updated_at) VALUES ('film:tmdb:${film}','${part}','${source}',${slot},'due','live',NULL,'${due}','${T0}');`;
 const early=i=>`2026-11-01T0${Math.floor(i/3600)}:${String(Math.floor(i/60)%60).padStart(2,'0')}:${String(i%60).padStart(2,'0')}.000Z`;
 const late='2026-11-20T00:00:00.000Z';
 const BUDGET_ROWS=D.MAX_PAGES*50;
 const heldOf=file=>rows(file,'SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE held=1')[0].n;

 // 1. DISABLED scope: 3x the page budget of disabled members ahead of 10 enabled ones. The scope is disabled AFTER its rows exist (the owner action), which moves them out of the due indexes; the enabled Films complete through the real drain
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,1,1,'"+T0+"');");
  sqlite(w.file,'BEGIN;'+Array.from({length:BUDGET_ROWS*3},(_,i)=>film(20000+i)+member(20000+i,'discovery')+state(20000+i,'core','tmdb',0,early(i))).join('')+'COMMIT;');
  sqlite(w.file,'BEGIN;'+Array.from({length:10},(_,i)=>film(30000+i)+member(30000+i,'rated')+`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,cohort,due_since,updated_at) VALUES ('film:tmdb:${30000+i}','film','*',0,'active','live','${late}','${T0}');`.replace("'active','live'","'active','live'")).join('')+'COMMIT;');
  sqlite(w.file,"UPDATE catalog_enrichment_state SET reason='check_anchors' WHERE part='film';UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope='discovery';");
  assert.equal(heldOf(w.file),BUDGET_ROWS*3,'the disabled scope\'s rows left the due indexes');
  const d=await D.dueFilms(w.env,{now:'2026-11-26T10:00:00.000Z'});
  assert.ok(d.examined.live<=20,'the disabled head costs the selection nothing: '+d.examined.live);
  const result=await run(w,upstream());
  assert.equal(result.stop,'idle');assert.equal(metaCount(w.file),10,'the enabled Films completed without an unrelated event');
  // re-enabling releases the rows
  sqlite(w.file,"UPDATE catalog_enrichment_scope SET enabled=1,revision=revision+1 WHERE scope='discovery'");
  assert.equal(heldOf(w.file),0,'enabling the scope puts its Films back in the indexes');
 }
 // 2. an ALL-DISABLED queue is quiescent: no run spins, no maybe-runnable answer, no scan cost
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,1,1,'"+T0+"');");
  sqlite(w.file,'BEGIN;'+Array.from({length:BUDGET_ROWS*2},(_,i)=>film(40000+i)+member(40000+i,'discovery')+state(40000+i,'core','tmdb',0,early(i))).join('')+'COMMIT;UPDATE catalog_enrichment_scope SET enabled=0,revision=revision+1 WHERE scope=\'discovery\';');
  const up=upstream();
  const result=await run(w,up);
  assert.equal(result.stop,'idle','nothing is eligible: the run is idle, not parked and not spinning');
  assert.equal(up.calls.length,0);assert.ok(result.counts.statements<60,'and it cost a handful of statements: '+result.counts.statements);
  const due=await D.dueFilms(w.env,{now:'2026-11-26T10:00:00.000Z'});
  assert.deepEqual([due.live.length,due.background.length,due.incomplete],[0,0,false],'quiescent: no runnable work and no unread range');
 }
 // 3. OWNER-LOCKED rows, more than the whole page budget, ahead of one ordinary Film: the drain defers them progressively (a bounded number per pass) and keeps going until the Film completes
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'"+T0+"');");
  sqlite(w.file,'BEGIN;'+Array.from({length:BUDGET_ROWS+60},(_,i)=>film(50000+i)+member(50000+i,'rated')+state(50000+i,'core','tmdb',0,early(i))+`INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('film:tmdb:${50000+i}','metadata','reviewed','owner',NULL,NULL,NULL,'owner',NULL,NULL,NULL,0,'none','${T0}');`).join('')+film(59999)+member(59999,'rated')+`INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,cohort,due_since,updated_at) VALUES ('film:tmdb:59999','film','*',0,'active','check_anchors','live','${late}','${T0}');COMMIT;`);
  const result=await run(w,upstream());
  assert.ok(['idle','parked'].includes(result.stop),'the run ends by itself: '+result.stop);
  assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_metadata WHERE film_id='film:tmdb:59999'")[0].n,1,'the ordinary Film behind the locked head completed without an unrelated event');
  assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE reason='owner_blocked'")[0].n,BUDGET_ROWS+60,'every locked row was deferred out of the head (bounded per pass, repeated by the loop)');
 }
 // 4. a head of Films SKIPPED in this run, larger than the page budget: the stream is `incomplete` and continues from its cursor over successive picks
 {
  const w=world(0);
  sqlite(w.file,"INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'"+T0+"');");
  sqlite(w.file,'BEGIN;'+Array.from({length:BUDGET_ROWS*2+30},(_,i)=>film(60000+i)+member(60000+i,'rated')+state(60000+i,'core','tmdb',0,early(i))).join('')+film(69999)+member(69999,'rated')+state(69999,'core','tmdb',0,late)+'COMMIT;');
  const skip=new Set(Array.from({length:BUDGET_ROWS*2+30},(_,i)=>'film:tmdb:'+(60000+i)));
  const cursors=new Map();
  const now='2026-11-26T10:00:00.000Z';
  let found=null,picks=0;
  for(;picks<6&&!found;picks++){
   const d=await D.dueFilms(w.env,{now,skip,cursors});
   if(d.live.length+d.background.length)found=[...d.live,...d.background][0].filmId;
   else assert.equal(d.incomplete,true,'nothing found while rows remain unread is reported as incomplete, never as "nothing there"');
  }
  assert.equal(found,'film:tmdb:69999','the eligible Film behind a head of 2x the page budget is reached by continuing from the cursor');
  assert.ok(picks>=2&&picks<=4,'in a bounded number of picks: '+picks);
  assert.equal((await D.dueFilms(w.env,{now,skip,cursors})).examined.live<=D.MAX_PAGES*50,true,'each pick stays within its page budget');
 }
}

// ---- the ACTUAL publication path (src/published-epg.js `publishGeneration`) with the producer running: the hold, no repeated probe, the publication completes, the work resumes; and a failing publisher never holds ----
{
 const programme=(run)=>({runId:run,updatedAt:'2026-11-01T12:00:00.000Z',watchlistCount:1,films:[{id:'film:tmdb:100',title:'t',shows:[]}]});
 const listing={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:tmdb:100',title:'t',shows:[]}]};
 const arm=w=>sqlite(w.file,"UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 // A. a publisher whose stage is validated (a live claim) while the producer runs
 {
  const w=world(4);arm(w);
  const up=upstream();
  const seen=[];
  const out=await publishGeneration({DB:w.env.DB},{programmeRunId:'run-A',phase:'published',expectedProgrammeRunId:null,programme:programme('run-A'),watchlist:listing},{now:Date.parse(clock()),owner:'writer-a',afterValidate:async()=>{
   for(let i=0;i<3;i++)seen.push(await run(w,up));
  }});
  assert.ok(out,'the publication itself completed with the producer running');
  assert.deepEqual(seen.map(r=>r.stop),['yield','yield','yield'],'the producer held its writes at the write boundary while the stage was validated');
  assert.ok(seen.every(r=>r.reason==='epg_stage'),'the evidence is the publication\'s own stage');
  assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied'")[0].n,0,'no canonical write during the publication');
  assert.equal(seen.slice(1).reduce((n,r)=>n+r.counts.requests,0),0,'and the waiting runs sent no upstream request: one probe per hold, then cheap local checks');
  assert.equal(rows(w.file,"SELECT state FROM published_epg_stage")[0].state,'published','the stage reached published');
  const after=await run(w,up);
  assert.equal(after.stop,'idle');assert.equal(metaCount(w.file),4,'the held work completed as soon as the publication ended');
 }
 // B. a FAILING publisher: its stage stays validated with a claim that is no longer renewed; the hold ends by itself when the claim expires, and the producer is not parked by it
 {
  const w=world(3);arm(w);
  const up=upstream();
  const start=Date.parse(clock());
  await assert.rejects(publishGeneration({DB:w.env.DB},{programmeRunId:'run-B',phase:'published',expectedProgrammeRunId:null,programme:programme('run-B'),watchlist:listing},{now:start,claimTtlMs:1000,owner:'writer-b',afterValidate:async()=>{
   // inside the claim: held
   const held=await run(w,up,{clock:()=>new Date(start+500).toISOString()});
   assert.equal(held.stop,'yield');
   throw new Error('publisher crashed');
  }}),/publisher crashed/);
  assert.equal(rows(w.file,"SELECT state FROM published_epg_stage")[0].state,'validated','the failed publisher left a validated stage');
  // after the claim expired nothing holds: the work completes
  const after=await run(w,up,{clock:()=>new Date(start+60000).toISOString()});
  assert.equal(after.stop,'idle');assert.equal(metaCount(w.file),3,'a stalled publication never holds enrichment past its own claim');
  // the held cutover marker is not a hold either
  const w2=world(2);arm(w2);sqlite(w2.file,"UPDATE published_epg_authority SET cutover='held' WHERE id=1");
  assert.equal((await run(w2,upstream())).stop,'idle');assert.equal(metaCount(w2.file),2,'the owner-gated held cutover has no publisher: it holds nothing');
 }
}
// ---- AIR-684: the Discovery scope end to end with the REAL writers (upsertAdmissions, replaceCatalog) on the migrated schema and the actual drainer: admission, a delayed anchor, an existing Film, the retained membership,
// complete credits and the typed Russian title, overlap with rated, a disabled and re-enabled scope, a superseded admission, a guarded consume, no self-wake, mixed progress and the measured cost. Synthetic ids only.
{
 const Authority=await import('../src/discovery-authority.js');
 const w=world(0);
 const RUN='run-684-drain';
 const LEASE={id:'lease-684',expiresAt:Date.now()+3600000};
 sqlite(w.file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1;DROP TABLE IF EXISTS discovery_epg_priority;");
 sqlite(w.file,`UPDATE discovery_lease SET lease_id='${LEASE.id}', expires_at=${LEASE.expiresAt}, programme_run_id=NULL WHERE id=1`);
 const denv={DB:d1Standin(w.file),BUCKET:{async get(){return null;},async put(){},async head(){return null;},list:async()=>({objects:[]}),delete:async()=>{}},discoveryLease:LEASE};
 await Authority.ingestLedger(denv,{programmeRunId:RUN,handoff:true,lease:LEASE,items:(async function*(){yield {key:'o|2001',title:'O',normalizedTitle:'o',year:2001,durations:[100],shows:[{channelId:'c',channel:'C',start:Date.now()+3600000,end:Date.now()+3700000}],seenInLatestSnapshot:true,lastAiring:Date.now()+3600000};})()});
 sqlite(w.file,`INSERT OR IGNORE INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('discovery',1,1,1,'${T}')`);
 const film=n=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${n}',2,NULL,'K${n}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${n}','tmdb','${n}',1,0,NULL);`;
 const adm=n=>({id:'tmdb_'+n,tmdbId:String(n),canonicalIdentity:'tmdb:'+n,title:'Film '+n});
 const sig=()=>rows(w.file,"SELECT subject,state FROM enrichment_signal WHERE kind='admitted' AND source='discovery' ORDER BY subject").map(r=>r.subject+'='+r.state);
 const tmdbCalls=up=>up.calls.filter(url=>url.startsWith('https://api.themoviedb.org/')).length;
 const metrics={};

 // the producer's drain: an EXISTING Film (701) and a DELAYED anchor (702: the Film does not exist yet)
 sqlite(w.file,film(701));
 await Authority.upsertAdmissions(denv,{tmdb_701:adm(701),tmdb_702:adm(702),tmdb_tv_703:{id:'tmdb_tv_703',tmdbId:'703',canonicalIdentity:'tmdb_tv:703',title:'Show',mediaType:'tv'}},{lease:LEASE});
 assert.deepEqual(sig(),['tmdb:701=pending','tmdb:702=pending'],'a genuinely new movie is stream; a TV row is not');
 const up=upstream({cast:75});
 const t0=Date.now();
 const first=await run(w,up);
 metrics.firstRun={stop:first.stop,films:first.counts.films,signals:first.counts.signals,statements:first.counts.statements,units:first.counts.units,tmdbRequests:tmdbCalls(up),ms:Date.now()-t0};
 assert.equal(first.stop,'idle','an unresolved admission neither keeps the run spinning nor blocks the resolved one');
 assert.deepEqual(rows(w.file,"SELECT scope FROM catalog_enrichment_member WHERE film_id='film:tmdb:701'"),[{scope:'discovery'}],'the existing Film joined the retained discovery scope');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_person_credit WHERE film_id='film:tmdb:701'")[0].n,76,'complete credits: 75 actors and a director, in two chunks of the common producer, with no storage cap');
 assert.equal(rows(w.file,"SELECT COUNT(DISTINCT slot) AS n FROM catalog_enrichment_state WHERE film_id='film:tmdb:701' AND part='credits'")[0].n,2);
 assert.deepEqual(rows(w.file,"SELECT source,value FROM film_localization_source WHERE film_id='film:tmdb:701' AND source='tmdb'"),[{source:'tmdb',value:'Т701'}],'the typed Russian title of the producer\'s own TMDB response');
 assert.deepEqual(sig().filter(item=>item.startsWith('tmdb:702')),['tmdb:702=pending'],'the delayed admission stays pending (unresolved), it is not lost');
 const before=tmdbCalls(up);
 const idle=await run(w,up);
 assert.equal(idle.stop,'idle');assert.equal(tmdbCalls(up),before,'nothing resolved: no request, no spin');
 // the claim event resolves it at once
 sqlite(w.file,film(702));
 const second=await run(w,up);
 metrics.delayedAnchor={stop:second.stop,films:second.counts.films,tmdbRequests:tmdbCalls(up)-before};
 assert.deepEqual(rows(w.file,"SELECT scope FROM catalog_enrichment_member WHERE film_id='film:tmdb:702'"),[{scope:'discovery'}],'a delayed canonical admission resolves on the claim event');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM film_metadata WHERE film_id IN ('film:tmdb:701','film:tmdb:702')")[0].n,2);
 // no self-wake: the producer's own writes created no pending inbox row of any kind
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending' AND NOT (kind='admitted' AND source='discovery')")[0].n,0,'zero inbox changes from the producer\'s own complete write cycle');
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")[0].n,0);

 // overlap with rated: a Film that is also a rated member has ONE state set and is enriched once
 sqlite(w.file,film(710)+`INSERT OR IGNORE INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');`);
 await Authority.upsertAdmissions(denv,{tmdb_710:adm(710)},{lease:LEASE});
 sqlite(w.file,"INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:710','rated','',1,'pending','"+T+"')");
 const overlapCalls=tmdbCalls(up);
 await run(w,up);
 assert.deepEqual(rows(w.file,"SELECT scope FROM catalog_enrichment_member WHERE film_id='film:tmdb:710' ORDER BY scope").map(r=>r.scope),['discovery','rated']);
 assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE film_id='film:tmdb:710' AND part='core' AND source='tmdb'")[0].n,1,'one state set for overlapping scopes');
 assert.equal(tmdbCalls(up)-overlapCalls,1,'one TMDB response carries core, credits and translations: one request for the overlapping Film');

 // a disabled scope keeps recording and holds; re-enabling catches up with nothing redefined as history
 sqlite(w.file,"UPDATE catalog_enrichment_scope SET enabled=0, revision=revision+1 WHERE scope='discovery'");
 sqlite(w.file,film(720));
 await Authority.upsertAdmissions(denv,{tmdb_720:adm(720)},{lease:LEASE});
 assert.ok(sig().includes('tmdb:720=pending'),'the emitter keeps recording while the scope is disabled (its gate is `activated`)');
 const heldCalls=tmdbCalls(up);
 await run(w,up);
 assert.equal(tmdbCalls(up),heldCalls,'a disabled scope is held: no request');
 assert.deepEqual(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_member WHERE film_id='film:tmdb:720'")[0].n,0);
 sqlite(w.file,"UPDATE catalog_enrichment_scope SET enabled=1, revision=revision+1 WHERE scope='discovery'");
 await run(w,up);
 assert.deepEqual(rows(w.file,"SELECT scope FROM catalog_enrichment_member WHERE film_id='film:tmdb:720'"),[{scope:'discovery'}],'re-enabled: the held signal is consumed and the work caught up');

 // a superseded admission keeps its retained eligibility: a later verified change still reopens the Film's part
 sqlite(w.file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_701'");
 sqlite(w.file,`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,cause_digest,armed_at) VALUES ('source_changed','film:tmdb:701','tmdb','credits',1,'pending','${'c'.repeat(64)}','${T}')`);
 const superseded=await run(w,upstream({cast:75}));
 assert.ok(superseded.counts.signals>=1,'a retained member of a superseded admission is still processed');

 // a guarded consume: the control generation moved before the effect applies nothing and keeps the newest version pending
 sqlite(w.file,film(730));
 await Authority.upsertAdmissions(denv,{tmdb_730:adm(730)},{lease:LEASE});
 const lease=await S.acquireLease(w.env,{leaseId:'lease-guard-aaaaaaaa',now:T});
 const [signal]=(await S.runnableSignals(w.env,{now:new Date(Date.parse(T)+60000).toISOString()})).filter(item=>item.subject==='tmdb:730');
 const generation=rows(w.file,'SELECT generation FROM catalog_enrichment_control')[0].generation;
 const refused=await S.consumeSignal(w.env,{signal,generation:generation-1,leaseId:lease.leaseId,now:new Date(Date.parse(T)+60000).toISOString()});
 assert.equal(refused.consumed,false);assert.equal(rows(w.file,"SELECT COUNT(*) AS n FROM catalog_enrichment_member WHERE film_id='film:tmdb:730'")[0].n,0,'a guarded-out effect records nothing');
 assert.equal(rows(w.file,"SELECT acked_version FROM enrichment_signal WHERE subject='tmdb:730' AND source='discovery'")[0].acked_version,0,'and never an acknowledgement');
 await S.releaseLease(w.env,{leaseId:lease.leaseId,now:new Date(Date.parse(T)+61000).toISOString()});

 // the transfer path with the actual writer: a resolver publication admits a genuinely new Film once, an import admits none, and the producer drains exactly the former
 sqlite(w.file,film(740)+film(741));
 await Authority.replaceCatalog(denv,{tmdb_740:adm(740)},{lease:LEASE,admission:{origin:'resolver',programmeRunId:RUN}});
 await Authority.replaceCatalog(denv,{tmdb_740:adm(740),tmdb_741:adm(741)},{lease:LEASE});
 assert.ok(sig().includes('tmdb:740=pending')&&!sig().some(item=>item.startsWith('tmdb:741')),'resolver publication: stream; import: nothing');
 await run(w,up);
 assert.deepEqual(rows(w.file,"SELECT film_id FROM catalog_enrichment_member WHERE film_id IN ('film:tmdb:740','film:tmdb:741')"),[{film_id:'film:tmdb:740'}]);

 // per-scope counts and the measured cost of the Discovery path (reported, no quota)
 metrics.members=Object.fromEntries(rows(w.file,'SELECT scope,COUNT(*) AS n FROM catalog_enrichment_member GROUP BY scope').map(r=>[r.scope,r.n]));
 metrics.perFilm={tmdbRequestsPerFilm:1,statementsPerFirstRun:first.counts.statements,unitsPerFirstRun:first.counts.units};
 console.log('AIR-684 discovery path measurements '+JSON.stringify(metrics));
}

console.log('catalog enrichment drain: ok');
