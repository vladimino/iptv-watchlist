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
 sqlite(w.file,"UPDATE published_epg_authority SET cutover='held' WHERE id=1");assert.equal((await D.epgPublicationWindow(w.env,base)).evidence,'epg_cutover_held');
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
 assert.ok(up.calls.length<=probes+3*2,'a repeated yield is bounded: '+up.calls.length);
 assert.equal(rows(w.file,'SELECT COUNT(*) AS n FROM canonical_write_receipt')[0].n,0);
 // the moment the publication ends the work runs
 setLease('epg',base-1);
 assert.equal((await run(w,up)).stop,'idle');assert.equal(metaCount(w.file),3,'the held work completes right after the publication ends');
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
console.log('catalog enrichment drain: ok');
