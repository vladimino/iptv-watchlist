// AIR-605: the Workflow shell of the Catalog Enrichment drainer (src/catalog-enrichment-workflow.js; ADR 0219 decisions 2 and 6) on the real migrated schema with a mock Workflow binding and a mock step. Covered: dormancy,
// the kick (running, parked, retired, a send that throws), the liveness of a `running` record, the reconcile, the instance body (idle, handover with a successor, a parked wait with its due time, a park cancelled by work that
// arrives after the intent is durable, pause) and the single-owner record.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import * as W from '../src/catalog-enrichment-workflow.js';
import * as S from '../src/catalog-enrichment-store.js';
import {BUDGET} from '../src/catalog-enrichment-drain.js';
import {CODE_VERSION} from '../src/catalog-enrichment-producer.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-enrich-wf-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const template=path.join(root,'template.sqlite');
assert.equal(sqlite(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n')).status,0);
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const EMPTY='4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945';
const BASELINE="INSERT INTO canonical_receipt_watermark (id,marker_generation,entries,film_count,film_max_revision,person_count,person_max_revision,taken_at) VALUES (1,2,0,0,0,0,0,'2026-11-11T09:00:00.000Z');INSERT INTO canonical_receipt_baseline_seal (id,film_digest,person_digest,sealed_at) VALUES (1,'"+EMPTY+"','"+EMPTY+"','2026-11-11T09:00:01.000Z');";
const T='2026-11-26T10:00:00.000Z';
let tick=0;const clock=()=>new Date(Date.parse(T)+(tick++)*1000).toISOString();
let n=0;
function world({films=0,active=true}={}){
 const file=path.join(root,'w-'+(n++)+'.sqlite');
 fs.copyFileSync(template,file);
 for(const text of [VERIFY,"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1","UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1",BASELINE])assert.equal(sqlite(file,text).status,0);
 if(active)assert.equal(sqlite(file,`INSERT INTO catalog_enrichment_control VALUES (1,'inactive',0,1,'${T}','owner');UPDATE catalog_enrichment_control SET state='active',generation=1,revision=2;INSERT INTO catalog_enrichment_scope (scope,activated,enabled,revision,updated_at) VALUES ('rated',1,1,1,'${T}');`).status,0);
 const w={file,created:[],events:[],sendFails:false};
 w.addFilms=(ids)=>assert.equal(sqlite(file,ids.map(id=>`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:${id}',2,NULL,'K${id}','${T}');INSERT INTO film_external_id VALUES ('film:tmdb:${id}','tmdb','${id}',1,0,NULL);INSERT INTO enrichment_signal (kind,subject,source,part,version,state,armed_at) VALUES ('admitted','tmdb:${id}','rated','',1,'pending','${T}');`).join('')).status,0);
 w.addFilms(Array.from({length:films},(_,i)=>100+i));
 w.env={DB:d1Standin(file),CATALOG_ENRICHMENT_WORKFLOW:{
  create:async ({id,params})=>{if(w.created.includes(id))throw new Error('instance already exists');w.created.push(id);},
  get:async id=>({sendEvent:async event=>{if(w.sendFails)throw new Error('instance not running');w.events.push({id,event});}}),
 }};
 return w;
}
const res=(status,body='')=>({status,ok:status>=200&&status<300,headers:{get:()=>null},text:async()=>body,body:null});
const movie=id=>({id,release_date:'1999-03-30',runtime:100,overview:'s'+id,poster_path:'/p.jpg',genres:[{name:'G'}],credits:{cast:[{id:id*10,name:'A',order:0}],crew:[]},translations:{translations:[{iso_639_1:'ru',iso_3166_1:'RU',data:{title:'Т'}}]}});
const upstream=({tmdb='ok'}={})=>{const calls=[];const impl=async url=>{url=String(url);calls.push(url);if(url.startsWith('https://api.themoviedb.org/'))return tmdb==='transport'?res(503):res(200,JSON.stringify(movie(Number(/movie\/(\d+)/.exec(url)[1]))));if(url.startsWith('https://query.wikidata.org/'))return res(200,JSON.stringify({results:{bindings:[]}}));throw new Error('unexpected '+url);};impl.calls=calls;return impl;};
const record=file=>JSON.parse(rows(file,"SELECT summary_json AS j FROM projection_run WHERE projection='catalog_enrichment_run'")[0]?.j||'null');
const metaCount=file=>rows(file,'SELECT COUNT(*) AS n FROM film_metadata')[0].n;
const mockStep=(over={})=>{const log=[];return {log,do:async(name,fn)=>{log.push(['do',name]);const out=await fn();if(over.after)await over.after(name,out);return out;},waitForEvent:async(name,options)=>{log.push(['wait',name,options]);if(over.wait)return over.wait(name,options);throw new Error('timeout');},sleep:async(name,ms)=>{log.push(['sleep',name,ms]);}};};
const deps=(fetchImpl,extra={})=>({tools:{},fetchImpl,clock,...extra});

// ---- dormant: nothing is created, sent or asked while the control is not active ----
{
 const w=world({active:false});
 assert.deepEqual(await W.kick(w.env,{clock}),{kicked:false,reason:'not_active'});
 assert.deepEqual(await W.reconcile(w.env,{clock}),{reconciled:false,reason:'not_active'});
 assert.equal(w.created.length,0);assert.equal(record(w.file),null,'no run record is written');
 const up=upstream();
 assert.deepEqual(await W.run(w.env,{instance:'ce-00000001'},mockStep(),deps(up)),{stop:'not_active',rounds:0});
 assert.equal(up.calls.length,0);
 assert.equal((await W.run(w.env,{instance:'../x'},null,deps(up))).stop,'invalid_instance','an instance id has a strict shape');
}

// ---- kick: running, parked, retired, a send that throws, a crashed owner ----
{
 const w=world();
 const first=await W.kick(w.env,{clock});
 assert.deepEqual([first.kicked,first.mode,first.instance],[true,'created','ce-00000001']);
 assert.deepEqual(w.created,['ce-00000001']);
 assert.equal(record(w.file).phase,'running');
 // a live owner (the record just moved) needs no event and no second instance
 const again=await W.kick(w.env,{clock});
 assert.deepEqual([again.kicked,again.mode],[true,'running']);assert.equal(w.created.length,1);
 // a crashed owner: the record is stale and no lease is live, so the next kick creates the next instance
 sqlite(w.file,`UPDATE projection_run SET summary_json=json_set(summary_json,'$.at','2026-11-26T08:00:00.000Z') WHERE projection='catalog_enrichment_run'`);
 const revived=await W.kick(w.env,{clock:()=> '2026-11-26T12:00:00.000Z'});
 assert.deepEqual([revived.mode,revived.instance],['created','ce-00000002'],'a crashed instance never strands the work');
 // parked: the instance gets a kick event
 sqlite(w.file,`UPDATE projection_run SET summary_json=json_set(summary_json,'$.phase','parked') WHERE projection='catalog_enrichment_run'`);
 const parked=await W.kick(w.env,{clock});
 assert.deepEqual([parked.mode,parked.instance],['event','ce-00000002']);assert.equal(w.events.length,1);assert.equal(w.events[0].event.type,'kick');
 // a send that throws means no live owner: a new instance is created
 w.sendFails=true;
 const dead=await W.kick(w.env,{clock});
 assert.deepEqual([dead.mode,dead.instance],['created','ce-00000003']);
 // a handover in progress targets the successor
 sqlite(w.file,`UPDATE projection_run SET summary_json=json_set(summary_json,'$.phase','running','$.successor','ce-00000004') WHERE projection='catalog_enrichment_run'`);
 w.sendFails=false;
 const handed=await W.kick(w.env,{clock});
 assert.deepEqual([handed.mode,handed.instance],['event','ce-00000004'],'a kick during a handover reaches the successor');
 // no workflow binding: a typed refusal, the record is released
 const bare=world();delete bare.env.CATALOG_ENRICHMENT_WORKFLOW;
 const none=await W.kick(bare.env,{clock});
 assert.deepEqual([none.kicked,none.reason],[false,'workflow_unavailable']);assert.equal(record(bare.file).phase,'retired');
}

// ---- reconcile: the safety net, idle when nothing is runnable ----
{
 const w=world();
 assert.deepEqual(await W.reconcile(w.env,{clock}),{reconciled:true,created:false,reason:'nothing_runnable'});assert.equal(w.created.length,0,'an idle catalog creates nothing');
 w.addFilms([100]);
 const out=await W.reconcile(w.env,{clock});
 assert.deepEqual([out.reconciled,out.mode],[true,'created']);assert.equal(w.created.length,1,'a lost kick is recovered');
 assert.equal(W.CRON,'11-59/15 * * * *');
 const wrangler=fs.readFileSync('wrangler.jsonc','utf8');
 assert.ok(!wrangler.includes(W.CRON),'the reconcile cron is delivered by the activation change, not by a deploy');
}

// ---- a yield and an error backoff are deliberate holds: the instance parks (one wait) and the held work is NOT mistaken for runnable work ----
{
 const h=world({films:2});
 let holds=0;
 const stepH=mockStep();
 const until=Date.parse(T)+600000;
 const out=await W.run(h.env,{instance:'ce-00000001'},stepH,deps(upstream(),{shouldYield:async()=>holds++<2?{until}:null}));
 const waits=stepH.log.filter(entry=>entry[0]==='wait');
 assert.ok(waits.length>=2,'each yield parked the instance once instead of looping: '+waits.length);
 assert.equal(waits[0][2].type,'kick');assert.ok(waits[0][2].timeout>=1000,'the wait runs to the holder\'s lease expiry');
 assert.equal(out.stop,'idle');assert.equal(metaCount(h.file),2,'after the hold the work completes');
 assert.equal(holds>=3,true);
}

// ---- a new code version is reachable by the reconcile even when every retry is in the future ----
{
 const w=world();
 sqlite(w.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',2,NULL,'O','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','tmdb',0,'deferred_repair','repairable',7,'older','2099-01-01T00:00:00.000Z','${T}','${T}');`);
 const out=await W.reconcile(w.env,{clock});
 assert.deepEqual([out.reconciled,out.mode],[true,'created'],'only future retries of an older code version: the deploy itself starts the drainer that wakes them');
 const current=world();
 sqlite(current.file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:900',2,NULL,'O','${T}');INSERT INTO catalog_enrichment_state (film_id,part,source,slot,status,failure_class,failures,code_version,retry_at,due_since,updated_at) VALUES ('film:tmdb:900','core','tmdb',0,'deferred_repair','repairable',7,'${CODE_VERSION}','2099-01-01T00:00:00.000Z','${T}','${T}');`);
 assert.deepEqual(await W.reconcile(current.env,{clock}),{reconciled:true,created:false,reason:'nothing_runnable'},'the running version has nothing to wake: an attempted repair records the version and is no longer pending');
}

// ---- the instance body: idle after work, handover, parked, a park cancelled by late work, pause ----
{
 const w=world({films:3});
 const up=upstream();
 const out=await W.run(w.env,{instance:'ce-00000001'},mockStep(),deps(up));
 assert.equal(out.stop,'idle');assert.equal(metaCount(w.file),3);
 assert.equal(record(w.file).phase,'retired','the terminal exit makes its intent durable');
 assert.equal(record(w.file).instance,'ce-00000001');
 // handover at the statement budget: a successor is recorded and created, then it finishes the work with no wait
 const h=world({films:6});
 const small={...BUDGET,statements:420,handoverAt:300,reserve:60,stepEstimate:40};
 const hup=upstream();
 const first=await W.run(h.env,{instance:'ce-00000001'},mockStep(),deps(hup,{budget:small}));
 assert.deepEqual([first.stop,first.successor],['handover','ce-00000001'.replace('1','2')]);
 assert.deepEqual(h.created,['ce-00000002'],'created, idempotent by id');
 assert.equal(record(h.file).instance,'ce-00000002');assert.equal(record(h.file).phase,'running');
 let id=first.successor,guard=0,last=first;
 while(last.stop==='handover'&&guard++<20){last=await W.run(h.env,{instance:id},mockStep(),deps(hup,{budget:small}));if(last.successor)id=last.successor;}
 assert.equal(last.stop,'idle');assert.equal(metaCount(h.file),6,'successive instances finish everything');
 // parked: the wait is the due time and the event type is `kick`; a timeout is the due-time wake, never a failure
 const p=world({films:2});
 const realFetch=upstream();
 let recovered=false;
 const flip=async url=>!recovered&&String(url).startsWith('https://api.themoviedb.org/')?res(503):realFetch(url);
 const stepP=mockStep({wait:async()=>{recovered=true;sqlite(p.file,"UPDATE catalog_enrichment_state SET retry_at=NULL");throw new Error('timeout');}});
 const parkedOut=await W.run(p.env,{instance:'ce-00000001'},stepP,deps(flip));
 const waits=stepP.log.filter(entry=>entry[0]==='wait');
 assert.ok(waits.length>=1,'the run parked and waited');
 assert.equal(waits[0][2].type,'kick');assert.ok(waits[0][2].timeout>=1000,'the wait carries the time to the earliest due retry');
 assert.equal(parkedOut.stop,'idle','after the due-time wake the work ran and the queue drained');assert.equal(metaCount(p.file),2);
 // work that arrives AFTER the park intent is durable cancels the park (no lost wakeup)
 const l=world({films:1});
 let injected=false;
 const lateUp=upstream();
 const stepL=mockStep({after:async(name)=>{if(!injected&&name==='drain-0'){injected=true;l.addFilms([777]);}}});
 const late=await W.run(l.env,{instance:'ce-00000001'},stepL,deps(lateUp));
 assert.equal(late.stop,'idle');assert.equal(metaCount(l.file),2,'a Film admitted after the first drain was seen by the re-check after the intent');
 assert.ok(!stepL.log.some(entry=>entry[0]==='wait'),'the idle exit re-checked instead of waiting');
 // pause: the run ends, the record is retired, nothing more is asked
 const q=world({films:4});
 let qcalls=0;
 const realQ=upstream();
 const qup=async url=>{if(String(url).startsWith('https://api.themoviedb.org/')&&++qcalls===2)sqlite(q.file,"UPDATE catalog_enrichment_control SET state='paused',generation=generation+1,revision=revision+1");return realQ(url);};
 const paused=await W.run(q.env,{instance:'ce-00000001'},mockStep(),deps(qup));
 assert.equal(paused.stop,'paused');assert.equal(record(q.file).phase,'retired');
 // a record that already names another instance is never overwritten by a stale one
 const o=world();
 await W.kick(o.env,{clock});
 const out2=await W.run(o.env,{instance:'ce-00000009'},mockStep(),deps(upstream()));
 assert.ok(['idle','not_active'].includes(out2.stop));
 assert.equal(record(o.file).instance,'ce-00000001','another instance\'s record is not overwritten');
}
console.log('catalog enrichment workflow: ok');
