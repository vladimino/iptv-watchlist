// AIR-605: the OFFLINE HARNESS of the Catalog Enrichment Producer (ADR 0219 decision 6 and its acceptance paragraph). It runs the real drainer on the real migrated schema (sqlite3 CLI as the D1 stand-in) over synthetic
// catalogs with injected upstreams and prints one JSON report per scenario. It measures a FIXTURE: no production capacity, billed D1 rows, CPU or wall time of a Worker is claimed from it. It makes no network request and
// writes only a scratch database in the OS temp directory.
//   node scripts/catalog-enrichment-harness.mjs base [films=60] [castSize=12]   drain cost per Film and per unit, handovers, requests
//   node scripts/catalog-enrichment-harness.mjs mixed [live=24] [history=24]    mixed classes: per-class completion order, oldest age and progress under a per-run Film cap
//   node scripts/catalog-enrichment-harness.mjs epg [films=12]                  the same queue with and without a progressing EPG publication: writes held, probes, resume
//   node scripts/catalog-enrichment-harness.mjs populated [films=20000]         a populated catalog: examined rows, statements and wall time of the pick, the Monitor reader and the trigger fanout
// A bare number as the first argument keeps the older form: `harness.mjs 60 12` is `base 60 12`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {d1Standin} from '../tests/d1-standin.mjs';
import {sqliteSync} from '../tests/sqlite-session.mjs';
import * as D from '../src/catalog-enrichment-drain.js';
import * as S from '../src/catalog-enrichment-store.js';

const args=process.argv.slice(2);
const scenario=/^\d+$/.test(args[0]||'')?'base':(args[0]||'base');
const rest=/^\d+$/.test(args[0]||'')?args:args.slice(1);
const num=(index,fallback)=>Number(rest[index]||fallback);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-harness-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<29});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<29});if(r.status!==0)throw new Error(r.stderr);const o=String(r.stdout).trim();return o?JSON.parse(o):[];};
const count=(file,text)=>rows(file,text)[0].n;
const T='2026-11-26T10:00:00.000Z';
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,chain).status,0);
for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(template,text).status,0);
let worlds=0;
function world(){const file=path.join(root,'w-'+(worlds++)+'.sqlite');fs.copyFileSync(template,file);return {file,env:{DB:d1Standin(file)}};}
const filmSql=id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K${id}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);`;
const activate=(scopes)=>`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','harness');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;`+scopes.map(scope=>`INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('${scope}',1,1,1,'${T}');`).join('');
const signal=id=>`INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${id}','rated','',1,'pending','${T}');`;

const res=(status,body='')=>({status,ok:status>=200&&status<300,headers:{get:()=>null},text:async()=>body,body:null});
function upstream(cast){
 const requests={tmdb:0,wikidata:0};
 const impl=async url=>{
  url=String(url);
  if(url.startsWith('https://api.themoviedb.org/')){requests.tmdb++;const id=Number(/movie\/(\d+)/.exec(url)[1]);return res(200,JSON.stringify({id,release_date:'1999-01-01',runtime:100,overview:'s',poster_path:'/p.jpg',genres:[{name:'G'}],credits:{cast:Array.from({length:cast},(_,i)=>({id:id*100+i,name:'N',order:i})),crew:[{id:id*100+90,name:'D',job:'Director'}]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'T'+id}}]}}));}
  if(url.startsWith('https://query.wikidata.org/')){requests.wikidata++;return res(200,JSON.stringify({results:{bindings:[]}}));}
  throw new Error('unexpected '+url);
 };
 impl.requests=requests;
 return impl;
}
let tick=0;
const clock=()=>new Date(Date.parse(T)+(tick++)*1000).toISOString();
const runUntilIdle=async(w,fetchImpl,{limit=400,drainOptions={},between=null}={})=>{
 const runs=[];
 for(let i=0;i<limit;i++){
  const result=await D.drain(w.env,{runId:'harness-'+(tick)+'-'+i,clock,tools:{},fetchImpl,...drainOptions});
  runs.push({stop:result.stop,films:result.counts.films,units:result.counts.units,signals:result.counts.signals,statements:result.counts.statements,requests:result.counts.requests,yields:result.counts.yields,steps:result.counts.steps});
  if(between)await between(i,result);
  if(!['handover','yield'].includes(result.stop))break;
 }
 return runs;
};
const totals=runs=>runs.reduce((sum,run)=>({films:sum.films+run.films,units:sum.units+run.units,statements:sum.statements+run.statements,signals:sum.signals+run.signals,steps:sum.steps+run.steps,requests:sum.requests+run.requests,yields:sum.yields+run.yields}),{films:0,units:0,statements:0,signals:0,steps:0,requests:0,yields:0});
const stops=runs=>Object.fromEntries([...new Set(runs.map(run=>run.stop))].map(stop=>[stop,runs.filter(run=>run.stop===stop).length]));
const finishedAt=(file,doneAt,run)=>{for(const r of rows(file,'SELECT film_id FROM film_metadata'))if(!doneAt.has(r.film_id))doneAt.set(r.film_id,run);};

const reports={
 // ---- base: cost per Film and per unit ----
 async base(){
  const films=num(0,60),cast=num(1,12);
  const w=world();
  const ids=Array.from({length:films},(_,i)=>1000+i);
  assert.equal(sqlite(w.file,ids.map(filmSql).join('')+'DELETE FROM enrichment_signal;'+activate(['rated'])+ids.map(signal).join('')).status,0);
  const up=upstream(cast);
  const runs=await runUntilIdle(w,up);
  const total=totals(runs);
  assert.equal(count(w.file,'SELECT COUNT(*) AS n FROM film_metadata'),films,'every Film was drained');
  return {fixture:{films,castPerFilm:cast+1,anchors:'tmdb only (rated scope)'},budget:D.BUDGET,runs:runs.length,stops:stops(runs),filmsPerRun:{min:Math.min(...runs.map(r=>r.films)),max:Math.max(...runs.map(r=>r.films))},
   drained:{films:count(w.file,'SELECT COUNT(*) AS n FROM film_metadata'),credits:count(w.file,'SELECT COUNT(*) AS n FROM film_person_credit'),persons:count(w.file,'SELECT COUNT(*) AS n FROM person'),localization:count(w.file,'SELECT COUNT(*) AS n FROM film_localization_source')},
   statementsPerFilm:Math.round(total.statements/films*10)/10,unitsPerFilm:Math.round(total.units/films*10)/10,statementsPerUnit:Math.round(total.statements/Math.max(total.units,1)*10)/10,
   upstreamRequestsPerFilm:Math.round(total.requests/films*100)/100,requestsByHost:up.requests,totals:total,receiptsApplied:count(w.file,"SELECT COUNT(*) AS n FROM canonical_write_receipt WHERE state='applied'"),pendingSignals:count(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")};
 },
 // ---- mixed: live Films (rated scope, so cohort live) and history Films (held only by the historical widening, so background), served under a per-run Film cap ----
 async mixed(){
  const live=num(0,24),history=num(1,24);
  const w=world();
  const liveIds=Array.from({length:live},(_,i)=>1000+i),historyIds=Array.from({length:history},(_,i)=>5000+i);
  // history Films are seeded as the historical widening would hold them: a c3a membership and the anchor-check marker; live Films arrive as rated admissions
  assert.equal(sqlite(w.file,[...liveIds,...historyIds].map(filmSql).join('')+'DELETE FROM enrichment_signal;'+activate(['rated','c3a'])+liveIds.map(signal).join('')
   +historyIds.map(id=>`INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${id}','c3a','${T}','h${id}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,reason,due_since,updated_at,plan_epoch) VALUES ('film:tmdb:${id}','film','*',0,'active','check_anchors','${T}','${T}',0);`).join('')).status,0);
  const up=upstream(12);
  const doneAt=new Map();
  const cap=5;
  const runs=await runUntilIdle(w,up,{drainOptions:{maxFilms:cap},between:i=>finishedAt(w.file,doneAt,i)});
  const classOf=id=>id.startsWith('film:tmdb:5')?'history':'live';
  const stat=cls=>{const at=[...doneAt].filter(([id])=>classOf(id)===cls).map(([,run])=>run);return {films:at.length,finishedByRun:{first:Math.min(...at),median:at.sort((a,b)=>a-b)[Math.floor(at.length/2)],last:Math.max(...at)}};};
  assert.equal(doneAt.size,live+history,'every Film finished');
  const total=totals(runs);
  return {fixture:{liveFilms:live,historyFilms:history,perRunFilmCap:cap,note:'live: rated membership; history: c3a membership only (background class)'},runs:runs.length,stops:stops(runs),live:stat('live'),history:stat('history'),
   readingTheClasses:'a lower run index is earlier; live Films are served first while background Films keep progressing across the same runs',totals:total,
   pendingSignals:count(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE state='pending'")};
 },
 // ---- epg: the ACTUAL publication path (src/published-epg.js `publishGeneration`) with and without the producer running ----
 async epg(){
  const films=num(0,12);
  const {publishGeneration}=await import('../src/published-epg.js');
  const programme=run=>({runId:run,updatedAt:'2026-11-01T12:00:00.000Z',watchlistCount:1,films:[{id:'film:tmdb:1000',title:'t',shows:[]}]});
  const listing={updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:tmdb:1000',title:'t',shows:[]}]};
  const build=()=>{
   const w=world();
   const ids=Array.from({length:films},(_,i)=>1000+i);
   assert.equal(sqlite(w.file,ids.map(filmSql).join('')+'DELETE FROM enrichment_signal;'+activate(['rated'])+ids.map(signal).join('')+"UPDATE published_epg_authority SET mode='d1' WHERE id=1;").status,0);
   return w;
  };
  const timed=async fn=>{const t0=performance.now();const value=await fn();return {value,ms:Math.round((performance.now()-t0)*10)/10};};
  // 1. the publication alone
  const alone=build();
  const aloneRun=await timed(()=>publishGeneration({DB:alone.env.DB},{programmeRunId:'run-alone',phase:'published',expectedProgrammeRunId:null,programme:programme('run-alone'),watchlist:listing},{now:Date.parse(clock()),owner:'writer-alone'}));
  // 2. the enrichment alone
  const enrichmentAlone=build();
  const upAlone=upstream(12);
  const enrichmentRuns=await runUntilIdle(enrichmentAlone,upAlone);
  // 3. both: drain runs happen while the stage is validated (a live claim); the publication then completes and the queue drains
  const both=build();
  const upBoth=upstream(12);
  const heldRuns=[];
  let producerMs=0;
  const publication=await timed(()=>publishGeneration({DB:both.env.DB},{programmeRunId:'run-both',phase:'published',expectedProgrammeRunId:null,programme:programme('run-both'),watchlist:listing},{now:Date.parse(clock()),owner:'writer-both',afterValidate:async()=>{
   const d0=performance.now();
   for(let i=0;i<6;i++){const r=await D.drain(both.env,{runId:'harness-held-'+i,clock,tools:{},fetchImpl:upBoth});heldRuns.push({stop:r.stop,reason:r.reason,units:r.counts.units,requests:r.counts.requests,statements:r.counts.statements});}
   producerMs=performance.now()-d0;
  }}));
  const afterRuns=await runUntilIdle(both,upBoth);
  assert.equal(heldRuns.reduce((sum,run)=>sum+run.units,0),0,'no canonical unit committed while the publication progressed');
  assert.equal(count(both.file,"SELECT COUNT(*) AS n FROM published_epg_stage WHERE state='published'"),1,'the publication completed');
  assert.equal(count(both.file,'SELECT COUNT(*) AS n FROM film_metadata'),films,'and the queue drained afterwards');
  // 4. a publisher that FAILS after validating: the claim is not renewed; once it expires nothing holds
  const stalled=build();
  const start=Date.parse(clock());
  await publishGeneration({DB:stalled.env.DB},{programmeRunId:'run-stalled',phase:'published',expectedProgrammeRunId:null,programme:programme('run-stalled'),watchlist:listing},{now:start,claimTtlMs:1000,owner:'writer-stalled',afterValidate:async()=>{throw new Error('publisher crashed');}}).catch(()=>{});
  const stalledRuns=await runUntilIdle(stalled,upstream(12),{drainOptions:{clock:()=>new Date(start+60000).toISOString()}});
  return {fixture:{films,publication:'published-epg publishGeneration, one programme and one watchlist film',evidence:'the publisher\'s own stage claim'},
   publicationAlone:{ms:aloneRun.ms},
   enrichmentAlone:{runs:enrichmentRuns.length,statements:totals(enrichmentRuns).statements,upstreamRequests:upAlone.requests},
   publicationWithTheProducerRunning:{publicationTotalMs:publication.ms,producerRunsInsideItMs:Math.round(producerMs*10)/10,publicationOwnMs:Math.round((publication.ms-producerMs)*10)/10,heldRuns:heldRuns.map(run=>({stop:run.stop,reason:run.reason,requests:run.requests,statements:run.statements})),canonicalUnitsCommittedWhileHeld:0,
    upstreamRequestsWhileHeld:heldRuns.reduce((sum,run)=>sum+run.requests,0),drainAfterThePublication:{runs:afterRuns.length,stops:stops(afterRuns),statements:totals(afterRuns).statements}},
   stalledPublisher:{runs:stalledRuns.length,stops:stops(stalledRuns),filmsDrained:count(stalled.file,'SELECT COUNT(*) AS n FROM film_metadata'),note:'a stage left validated by a crashed publisher holds nothing once its claim has expired'},
   limits:'wall times are of the sqlite3 CLI stand-in; the publisher and the drainer are interleaved in one process at the publisher\'s own afterValidate point, which is the only point of the publication where another writer can run between its steps'};
 },
 // ---- populated: examined rows, statements and wall time on a populated catalog ----
 async populated(){
  const films=num(0,20000);
  const w=world();
  // Films with a tmdb anchor, a member row and the runnable part rows; 10% are due now, 20% are backed off in the future, the rest are complete
  const chunk=2000;
  for(let start=0;start<films;start+=chunk){
   const part=Array.from({length:Math.min(chunk,films-start)},(_,i)=>start+i);
   const dml=part.map(i=>{const id=100000+i;const status=i%10===0?'due':i%5===1?'due':'complete';const retry=i%5===1?"'2099-01-01T00:00:00.000Z'":'NULL';return `INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);INSERT INTO catalog_enrichment_member VALUES ('film:tmdb:${id}','${i%7===0?'c3a':'rated'}','${T}','k${id}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,cohort,retry_at,due_since,updated_at) VALUES ('film:tmdb:${id}','core','tmdb',0,'${status}','${i%7===0?'history':'live'}',${status==='due'?retry:'NULL'},'2026-11-0${1+(i%9)}T00:00:00.000Z','${T}');`;}).join('');
   assert.equal(sqlite(w.file,(start===0?'BEGIN;':'BEGIN;')+dml+'COMMIT;').status,0);
  }
  assert.equal(sqlite(w.file,activate(['rated','c3a'])).status,0);
  const timed=async fn=>{const t0=performance.now();const value=await fn();return {value,ms:Math.round((performance.now()-t0)*10)/10};};
  const {env:counted,counter}=(await import('../src/catalog-enrichment-drain.js')).countingEnv(w.env);
  const pick=await timed(()=>D.dueFilms(counted,{now:'2026-11-26T10:00:00.000Z'}));
  const pickStatements=counter.statements;
  const monitorBefore=counter.statements;
  const facts=await timed(()=>S.readMonitorFacts(counted,{now:Date.parse('2026-11-26T10:00:00.000Z')}));
  const monitorStatements=counter.statements-monitorBefore;
  const runnable=await timed(()=>S.runnableSignals(counted,{now:'2026-11-26T10:00:00.000Z'}));
  // trigger fanout: ONE value held by many Films; one change signals each exactly once
  const fan=2000;
  assert.equal(sqlite(w.file,'BEGIN;'+Array.from({length:fan},(_,i)=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:fan${i}',2,NULL,'F','${T}');INSERT INTO film_external_id VALUES ('film:fan${i}','tmdb','777',0,0,NULL);`).join('')+'DELETE FROM enrichment_signal;COMMIT;').status,0);
  const f0=performance.now();
  assert.equal(sqlite(w.file,"UPDATE film_external_id SET trusted=1 WHERE film_id='film:fan0'").status,0);
  const fanMs=Math.round((performance.now()-f0)*10)/10;
  const fanSignals=count(w.file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='anchor_changed'");
  return {fixture:{films,stateRows:films,dueNow:Math.round(films*0.1),backedOff:Math.round(films*0.2)},
   dueSelection:{ms:pick.ms,statements:pickStatements,examinedRows:pick.value.examined,pages:pick.value.pages,foundLive:pick.value.live.length,foundBackground:pick.value.background.length,blocked:pick.value.blocked.length},
   monitorReader:{ms:facts.ms,statements:monitorStatements,configured:facts.value.configured},
   runnableSignals:{ms:runnable.ms,found:runnable.value.length},
   triggerFanout:{filmsHoldingTheSameValue:fan,signalsWrittenByOneChange:fanSignals,ms:fanMs,note:'one anchor change signals every Film that holds the value, once each'},
   limits:'wall times are of the sqlite3 CLI stand-in, not of D1; rows read are index rows, not billed rows'};
 },
};
const runner=reports[scenario];
if(!runner){console.error('unknown scenario '+scenario+'; use base, mixed, epg or populated');process.exit(2);}
console.log(JSON.stringify({scenario,...(await runner())},null,1));
