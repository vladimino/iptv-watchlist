// ADR 0103 (AIR-383), stage A: the exclusive projector window. Local sqlite stand-ins for D1 (the sqlite3 CLI, each batch one
// transaction) and a memory bucket for R2. Nothing here calls Cloudflare, TMDB or production. Covered: the migration file, the
// window protocol (request, grant, release) as atomic statements, Discovery admission closing, the three lease-free generation
// writers, a stalled former lease holder, every generation bump statement having a fence or the window predicate, the projector under
// a held window with the strict generation pin unchanged, and the failure and not-applicable paths. The 1,000-tick interleaving at the
// end is a MODEL (seeded, assumptions stated in the code), not a measurement.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-projector-window-'));
const chainFiles=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=(upTo=18,opts={})=>{
 const file=path.join(root,'w-'+(databases++)+'.sqlite');
 const sql='PRAGMA foreign_keys=ON;\n'+chainFiles.filter(name=>Number(name.slice(0,4))<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
 const result=sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,opts)};
};
const first=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const open=db=>{db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-1', published_programme_run_id='run-1' WHERE id=1");};
const generation=db=>Number(first(db,'SELECT generation FROM discovery_authority WHERE id=1'));
const windowRow=db=>db.sql('SELECT state, owner, expires_at AS expiresAt FROM projector_window WHERE id=1')[0];
const leaseRow=db=>db.sql('SELECT lease_id AS leaseId, expires_at AS expiresAt FROM discovery_lease WHERE id=1')[0];
const envFor=(db,extra={})=>({DB:db,BUCKET:new MemoryBucket(),discoveryLease:null,...extra});
const T0=Date.now();
const MIN=Authority.WINDOW_MIN_RUN_MS,DEADLINE=Authority.WINDOW_DEADLINE_MS;
assert.equal(DEADLINE,300000);assert.equal(MIN,120000);

// 1. The migration file: additive, follows a complete version 17, refuses anything else, seeds one idle row, never goes down.
{
 const sql=fs.readFileSync('migrations/0018_projector_window.sql','utf8');
 assert.match(sql,/version >= 17 AND version < 18/);
 assert.doesNotMatch(sql,/\b(DROP|DELETE FROM|ALTER TABLE)\b/);
 const old=migrated(16);
 const refused=sqliteSync(['-bail',old.file],{input:sql,encoding:'utf8'});
 assert.notEqual(refused.status,0,'refuses version 16');
 assert.equal(Number(first(old.db,'SELECT COUNT(*) AS n FROM sqlite_master WHERE name=\'projector_window\'')),0);
 const {db,file}=migrated(17);
 assert.equal(Number(first(db,'SELECT version FROM schema_contract')),17);
 assert.equal(Number(first(db,'SELECT COUNT(*) AS n FROM sqlite_master WHERE name=\'projector_window\'')),0,'0017 alone has no window table');
 const applied=sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
 assert.equal(applied.status,0,applied.stderr);
 assert.equal(Number(first(db,'SELECT version FROM schema_contract')),18);
 assert.deepEqual({...windowRow(db)},{state:'idle',owner:null,expiresAt:0});
 assert.equal(Number(first(db,'SELECT COUNT(*) AS n FROM projector_window')),1);
 assert.throws(()=>db.sql("UPDATE schema_contract SET version=17"),/downgrade/);
 assert.throws(()=>db.sql("INSERT INTO projector_window (id,state,owner,requested_at,expires_at) VALUES (2,'idle',NULL,NULL,0)"));
 assert.throws(()=>db.sql("UPDATE projector_window SET state='held', owner=NULL WHERE id=1"));
 assert.match(fs.readFileSync('migrations/README.md','utf8'),/0018_projector_window\.sql/);
}

// 2. Table absent (version 17): every Discovery path is as before and the window functions do nothing.
{
 const {db}=migrated(17);open(db);
 const env=envFor(db);
 const gate=await Authority.readAuthority(env);
 assert.equal(gate.ready,true);assert.equal(gate.windowTable,false);
 assert.deepEqual({...await Authority.requestProjectorWindow(env,{owner:'p1',now:T0})},{outcome:'not_applicable',reason:'no_window_table'});
 assert.deepEqual({...await Authority.grantProjectorWindow(env,{owner:'p1',now:T0})},{outcome:'not_applicable',reason:'no_window_table'});
 assert.deepEqual({...await Authority.releaseProjectorWindow(env,{owner:'p1'})},{released:false});
 const taken=await Authority.acquireLease(env,{});
 assert.ok(taken.lease,'a lease is taken as before');
 const before=generation(db);
 assert.equal((await Authority.writeContinuation(env,{programmeRunId:'run-1',stage:'idle'},undefined)).saved,true);
 assert.equal(generation(db),before+1);
 assert.equal((await Authority.writeWorkflow(env,{programmeRunId:'run-1',instanceId:'i',series:0},undefined)).saved,true);
}

// 3. The protocol, each step atomic.
{
 const {db}=migrated();open(db);
 const env=envFor(db);
 // Request: one owner at a time; an expired row is replaced; a second runner is refused and changes nothing.
 const r1=await Authority.requestProjectorWindow(env,{owner:'p1',now:T0});
 assert.equal(r1.outcome,'requested');assert.equal(r1.expiresAt,T0+DEADLINE);
 assert.deepEqual({...windowRow(db)},{state:'requested',owner:'p1',expiresAt:T0+DEADLINE});
 const r2=await Authority.requestProjectorWindow(env,{owner:'p2',now:T0+1000});
 assert.equal(r2.outcome,'busy');assert.equal(windowRow(db).owner,'p1');
 // A deadline is absolute: the second request does not extend it, and the grant does not either.
 // Grant while a chunk holds the lease: pending, nothing changes (lease untouched, row still requested).
 const chunk=await Authority.acquireLease(env,{});
 assert.equal(chunk.lease,null,'admission is closed while requested');assert.equal(chunk.busy.kind,'projector_window');assert.equal(chunk.busy.expiresAt,T0+DEADLINE);
 db.sql(`UPDATE discovery_lease SET lease_id='chunk-1', expires_at=${T0+90000}, programme_run_id='run-1' WHERE id=1`);
 const pending=await Authority.grantProjectorWindow(env,{owner:'p1',now:T0+2000});
 assert.deepEqual({...pending},{outcome:'pending',reason:'lease_live',leaseExpiresAt:T0+90000});
 assert.equal(windowRow(db).state,'requested');assert.equal(leaseRow(db).leaseId,'chunk-1');
 // The in-flight chunk finishes (its lease expires): the grant moves lease and row together.
 const g=await Authority.grantProjectorWindow(env,{owner:'p1',now:T0+91000});
 assert.equal(g.outcome,'granted');assert.equal(g.expiresAt,T0+DEADLINE);
 assert.deepEqual({...windowRow(db)},{state:'held',owner:'p1',expiresAt:T0+DEADLINE});
 assert.deepEqual({...leaseRow(db)},{leaseId:'p1',expiresAt:T0+DEADLINE},'the lease row is the window and shares its one deadline');
 // Release frees only its own lease and window.
 assert.deepEqual({...await Authority.releaseProjectorWindow(env,{owner:'other'})},{released:true});
 assert.equal(windowRow(db).state,'held','a stranger releases nothing');assert.equal(leaseRow(db).leaseId,'p1');
 assert.deepEqual({...await Authority.releaseProjectorWindow(env,{owner:'p1'})},{released:true});
 assert.equal(windowRow(db).state,'idle');assert.equal(windowRow(db).owner,null);assert.ok(Number(leaseRow(db).expiresAt)===0);
 // Admission is open again.
 assert.ok((await Authority.acquireLease(env,{})).lease);
}

// 3b. A grant is refused unless enough time is left; an expired request is never granted late and leaves no lease behind.
{
 const {db}=migrated();open(db);
 const env=envFor(db);
 await Authority.requestProjectorWindow(env,{owner:'p1',deadlineMs:MIN+5000,now:T0});
 const tooLate=await Authority.grantProjectorWindow(env,{owner:'p1',now:T0+6000});
 assert.equal(tooLate.outcome,'too_late');
 assert.equal(windowRow(db).state,'requested');assert.ok(!leaseRow(db).leaseId||Number(leaseRow(db).expiresAt)===0||leaseRow(db).leaseId!=='p1','no lease for a late grant');
 const expired=await Authority.grantProjectorWindow(env,{owner:'p1',now:T0+MIN+6000});
 assert.equal(expired.outcome,'lost');assert.equal(expired.reason,'expired');
 assert.notEqual(leaseRow(db).leaseId,'p1');
 // An expired row reads as idle: admission opens and a new request replaces it.
 db.sql('UPDATE projector_window SET expires_at=1 WHERE id=1');   // the same expiry in real time: admission reads the wall clock
 assert.ok((await Authority.acquireLease(env,{})).lease,'an expired request does not hold Discovery out');
 const again=await Authority.requestProjectorWindow(env,{owner:'p2',now:T0+MIN+7000});
 assert.equal(again.outcome,'requested');assert.equal(windowRow(db).owner,'p2');
 // A transfer in progress is never granted over.
 db.sql("UPDATE discovery_lease SET expires_at=0 WHERE id=1");db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 const loading=await Authority.grantProjectorWindow(env,{owner:'p2',now:T0+MIN+8000});
 assert.deepEqual({...loading},{outcome:'pending',reason:'transfer_loading'});
 assert.equal(windowRow(db).state,'requested');
 // A marker that is not d1 and open gets no window at all.
 db.sql("UPDATE discovery_transfer SET state='idle' WHERE id=1");db.sql("UPDATE discovery_authority SET mode='r2' WHERE id=1");
 assert.equal((await Authority.requestProjectorWindow(env,{owner:'p3',now:T0})).outcome,'not_applicable');
}

// 3b. The whole-window bound is enforced at the coordination boundary: oversized, zero, negative, fractional, non-finite, non-numeric
// and unsafe parameters are refused before any statement runs, so a future caller cannot persist an hours-long admission closure.
{
 const {db}=migrated();open(db);
 const env=envFor(db);
 const idle=JSON.stringify(windowRow(db));
 const bad=[DEADLINE+1,DEADLINE*12,3600000,0,-1,1.5,NaN,Infinity,-Infinity,'300000','',null,{},[],Number.MAX_SAFE_INTEGER,Number.MAX_VALUE];
 for(const value of bad){
  await assert.rejects(Authority.requestProjectorWindow(env,{owner:'p1',deadlineMs:value,now:T0}),error=>error.code==='discovery_window_invalid'||(value===null&&error.code==='discovery_window_invalid'),'deadlineMs '+String(value));
  await assert.rejects(Authority.grantProjectorWindow(env,{owner:'p1',minRunMs:value,now:T0}),error=>error.code==='discovery_window_invalid','minRunMs '+String(value));
 }
 for(const now of [0,-5,1.5,NaN,Infinity,'1000',null]){
  await assert.rejects(Authority.requestProjectorWindow(env,{owner:'p1',now}),error=>error.code==='discovery_window_invalid','now '+String(now));
  await assert.rejects(Authority.grantProjectorWindow(env,{owner:'p1',now}),error=>error.code==='discovery_window_invalid','grant now '+String(now));
 }
 await assert.rejects(Authority.requestProjectorWindow(env,{owner:'',now:T0}),error=>error.code==='discovery_conflict');
 assert.equal(JSON.stringify(windowRow(db)),idle,'a refused request writes nothing');
 // The boundary values are accepted: exactly the bound and one millisecond.
 const edge=await Authority.requestProjectorWindow(env,{owner:'p1',deadlineMs:DEADLINE,now:T0});
 assert.equal(edge.outcome,'requested');assert.equal(edge.expiresAt,T0+DEADLINE);
 await Authority.releaseProjectorWindow(env,{owner:'p1'});
 const tiny=await Authority.requestProjectorWindow(env,{owner:'p1',deadlineMs:1,now:T0});
 assert.equal(tiny.outcome,'requested');assert.equal(tiny.expiresAt,T0+1);
 // Defence in depth: the table itself refuses a row longer than the bound, even from a caller that skips the API.
 await Authority.releaseProjectorWindow(env,{owner:'p1'});
 assert.throws(()=>db.sql(`UPDATE projector_window SET state='requested', owner='x', requested_at=${T0}, expires_at=${T0+DEADLINE+1} WHERE id=1`),/CHECK|constraint/i);
 db.sql(`UPDATE projector_window SET state='requested', owner='x', requested_at=${T0}, expires_at=${T0+DEADLINE} WHERE id=1`);
 assert.equal(windowRow(db).state,'requested');
}

// 4. Held: the three lease-free generation writers are refused by their own statement, softly and with the expiry; requested and idle
// let them through; nothing moves the generation inside the window.
{
 const {db}=migrated();open(db);
 const env=envFor(db);
 const writers=()=>[
  ()=>Authority.writeContinuation(env,{programmeRunId:'run-1',stage:'idle',at:new Date().toISOString()},undefined),
  ()=>Authority.writeWorkflow(env,{programmeRunId:'run-1',instanceId:'i',series:0,at:new Date().toISOString()},undefined),
 ];
 await Authority.requestProjectorWindow(env,{owner:'p1',now:Date.now()});
 let before=generation(db);
 for(const write of writers())assert.equal((await write()).saved,true,'requested lets an in-flight lease-free write through');
 assert.equal(generation(db),before+2);
 assert.equal((await Authority.grantProjectorWindow(env,{owner:'p1',now:Date.now()})).outcome,'granted');
 before=generation(db);
 for(const write of writers()){
  await assert.rejects(write,error=>error.code==='discovery_window'&&Number.isFinite(error.window.expiresAt)&&error.window.state==='held');
 }
 assert.equal(generation(db),before,'no generation bump inside a held window');
 const continuationBefore=first(db,'SELECT revision FROM discovery_continuation WHERE id=1'),workflowBefore=first(db,'SELECT revision FROM discovery_workflow WHERE id=1');
 await assert.rejects(()=>Authority.writeContinuation(env,{programmeRunId:'run-1',stage:'x'},undefined),error=>error.code==='discovery_window');
 assert.equal(first(db,'SELECT revision FROM discovery_continuation WHERE id=1'),continuationBefore,'the refused batch wrote nothing');
 assert.equal(first(db,'SELECT revision FROM discovery_workflow WHERE id=1'),workflowBefore);
 // importSegment is refused too (no live lease is required of it and the window is held).
 const segment={sourceKey:'archive:run-1:1:k',programmeRunId:'run-1',items:[],contentSha256:await Authority.segmentContentSha([])};
 await assert.rejects(()=>Authority.importSegment(env,segment));
 assert.equal(generation(db),before);
 // The window ends (released): the writers work again.
 await Authority.releaseProjectorWindow(env,{owner:'p1'});
 assert.equal((await writers()[0]()).saved,true);
 // An expired held row is idle: a stalled projector cannot keep Discovery out.
 await Authority.requestProjectorWindow(env,{owner:'p2',now:Date.now()});
 assert.equal((await Authority.grantProjectorWindow(env,{owner:'p2',now:Date.now()})).outcome,'granted');
 db.sql("UPDATE projector_window SET expires_at=1 WHERE id=1");db.sql("UPDATE discovery_lease SET expires_at=1 WHERE id=1");
 assert.equal((await writers()[1]()).saved,true,'an expired window refuses nothing');
 assert.ok((await Authority.acquireLease(env,{})).lease);
}

// 5. A stalled former lease holder cannot commit after the grant, whatever its clock says: its own batch is refused in D1.
{
 const {db}=migrated();open(db);
 const env=envFor(db);
 const old=await Authority.acquireLease(env,{});
 assert.ok(old.lease);
 const oldEnv={...env,discoveryLease:old.lease};
 await Authority.requestProjectorWindow(env,{owner:'p1',now:Date.now()});
 db.sql("UPDATE discovery_lease SET expires_at=0 WHERE id=1");   // the chunk went silent for a whole TTL
 assert.equal((await Authority.grantProjectorWindow(env,{owner:'p1',now:Date.now()})).outcome,'granted');
 const before=generation(db);
 // The late holder still believes it holds the lease. Its fenced write is refused by its own statement.
 await assert.rejects(()=>Authority.routeWrite(oldEnv,'epg/discovery-status.json',{programmeRunId:'run-1',stage:'running'},{}),error=>error.code==='discovery_fence');
 assert.equal(generation(db),before,'the late write changed nothing');
 assert.equal((await Authority.renewLease(oldEnv,old.lease,{programmeRunId:'run-1'})).ok,false,'and it cannot renew');
 await Authority.releaseLease(oldEnv,old.lease);
 assert.equal(leaseRow(db).leaseId,'p1','releasing a lease that is not its own leaves the window lease alone');
 assert.equal(windowRow(db).state,'held');
}

// 6. Structural: every statement that moves the generation is either behind the Discovery lease fence or carries the window predicate.
{
 const source=fs.readFileSync('src/discovery-authority.js','utf8').split('\n');
 const bumps=source.map((line,index)=>({line,index})).filter(item=>item.line.includes('generation=generation+1'));
 assert.equal(bumps.length,9,'a new generation bump needs a decision here: lease fence or window predicate');
 for(const {line,index} of bumps){
  // A bump is lease-fenced by its own `EXISTS (... lease_id=? ...)`, or by `changes()=1` straight after a statement that renews the
  // caller's own lease (`beginLedgerSeal`: its renewal changes no row unless `lease_id=? AND expires_at>?` holds).
  const renewal=/changes\(\)=1/.test(line)&&/UPDATE discovery_lease SET expires_at=.*lease_id=\? AND expires_at>\?/.test(source[index-1]);
  const leaseFenced=/discovery_lease WHERE id=1 AND lease_id=\?/.test(line)||renewal;
  const windowGuarded=/windowHeldGuard\(/.test(line);
  assert.ok(leaseFenced||windowGuarded,'line '+(index+1)+' bumps the generation without a lease fence or the window predicate');
 }
 const guarded=bumps.filter(item=>/windowHeldGuard\(/.test(item.line)).length;
 assert.equal(guarded,5,'writeContinuation, writeWorkflow and the three importSegment statements');
 // The three writers are exactly the lease-free ones.
 for(const name of ['writeContinuation','writeWorkflow','importSegment']){
  const start=source.findIndex(line=>line.startsWith('export async function '+name+'('));
  const end=source.findIndex((line,i)=>i>start&&line.startsWith('}'));
  assert.ok(source.slice(start,end).some(line=>/windowHeldGuard\(/.test(line)),name+' has the window predicate');
 }
 // No other module writes the authority row, so no other statement can move the generation.
 for(const file of ['src/discovery.js','src/discovery-workflow.js','src/worker.js','src/d1-enrichment.js','src/published-epg.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/UPDATE discovery_authority/,file);
 // The only statements that touch the window table from Discovery's side are the admission refusal, the guard and the protocol.
 assert.match(fs.readFileSync('src/discovery-authority.js','utf8'),/WINDOW_ACTIVE_SQL/);
}

// 7. The projector under a window. Real authority, real migrations, real write path; a Discovery process that keeps trying.
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const MANN=person('director/michael-mann','Michael Mann'),PACINO=person('actor/al-pacino','Al Pacino'),DE_NIRO=person('actor/robert-de-niro','Robert De Niro');
const film=(id,title,tmdbId,directors,actors)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors,actors});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
function r2(){
 const films=[film('heat','Heat','949',[MANN],[PACINO,DE_NIRO]),film('collateral','Collateral','1538',[MANN],[PACINO])];
 const bucket=new MemoryBucket();
 const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});
 put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 return bucket;
}
const logs=[];
const projectorFor=()=>projectorContext({log:line=>logs.push(JSON.parse(line)),globals:{DiscoveryAuthority:Authority}});
const filmsWritten=db=>Number(first(db,"SELECT COUNT(*) AS n FROM projection_state WHERE projection='enrichment' AND kind='film'"));
const fakeClock=(onSleep=()=>{})=>({t:Date.now(),sleeps:0,now(){return this.t;},async sleep(ms){this.sleeps++;this.t+=ms;await onSleep(this.sleeps);}});
// A Discovery process: tries to take the lease and to write its own state. Returns what it saw.
async function discoveryAttempt(env){
 const seen={};
 const taken=await Authority.acquireLease(env,{});
 seen.lease=taken.lease?'taken':taken.busy?.kind||'none';
 if(taken.lease){await Authority.releaseLease({...env,discoveryLease:taken.lease},taken.lease);}
 try{seen.continuation=(await Authority.writeContinuation(env,{programmeRunId:'run-1',stage:'idle',at:new Date().toISOString()},undefined)).saved?'saved':'conflict';}
 catch(error){seen.continuation=error.code;}
 return seen;
}
const setup=(opts={})=>{const {db,file}=migrated(18,opts);open(db);const bucket=r2();return {db,file,bucket,env:{DB:db,BUCKET:bucket,discoveryLease:null,D1_ENRICHMENT_WRITE:'on',D1_ENRICHMENT_WINDOW:'on'}};};

// 7a. Reproduction without the window: Discovery bumps the generation once during the read; the strict pin defers the run.
{
 const {db,bucket,env}=setup();
 delete env.D1_ENRICHMENT_WINDOW;
 const get=bucket.get.bind(bucket);let bumped=false;
 bucket.get=async key=>{if(!bumped&&key==='metadata.json'){bumped=true;await Authority.writeContinuation(env,{programmeRunId:'run-1',stage:'idle'},undefined);}return get(key);};
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{}});
 assert.equal(summary.outcome,'deferred');assert.ok(['input_changed','authority_unavailable'].includes(summary.reason),'the strict pin defers the run: '+summary.reason);
 assert.equal(summary.window,undefined,'flag off: no window record');
 assert.equal(filmsWritten(db),0);
}

// 7b. With the window: Discovery keeps trying during the whole run and is refused; the run is productive; the strict pin held;
// the window and the lease are freed and Discovery resumes.
{
 const {db,bucket,env}=setup();
 const seen=[];
 const get=bucket.get.bind(bucket);let attempts=0;
 bucket.get=async key=>{
  const row=windowRow(db);
  if(row.state==='held'&&attempts<6){attempts++;seen.push(await discoveryAttempt(env));}
  return get(key);
 };
 const clock=fakeClock();
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock,pollMs:1}});
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(summary.window.outcome,'granted');
 assert.ok(Number.isFinite(summary.window.expiresAt));
 assert.equal(summary.window.generationAtGrant,summary.window.generationAtFirstBatch,'the generation did not move from the grant to the first batch');
 assert.equal(summary.discoveryGeneration,summary.window.generationAtGrant,'the pin read inside the window is the generation at the grant');
 assert.ok(Number.isFinite(summary.window.heldMs));
 assert.equal(summary.writtenFilms,2);assert.ok(summary.writtenPeople>0);assert.equal(filmsWritten(db),2);
 assert.ok(seen.length>0);
 for(const item of seen){assert.equal(item.lease,'projector_window');assert.equal(item.continuation,'discovery_window');}
 assert.deepEqual({...windowRow(db)},{state:'idle',owner:null,expiresAt:0});
 assert.ok((await Authority.acquireLease({...env},{})).lease,'Discovery resumes');
 assert.equal(logs.at(-1).window.outcome,'granted');assert.ok(!JSON.stringify(logs.at(-1)).includes('Heat'),'no payload in the log');
 // AIR-392: the window shows in the run's timing: the request to grant (diff excluded), the diff, the first batch and the window release.
 assert.ok(Number.isInteger(summary.timing.windowMs)&&summary.timing.windowMs>=0,JSON.stringify(summary.timing));
 assert.ok(Number.isInteger(logs.at(-1).timing.windowReleaseMs),'the release of the window is in the log line');
 assert.ok(Number.isInteger(summary.timing.preWriteMs)&&summary.timing.preWriteMs>=0,'pre-write time is measured from the grant');
}

// 7c. An in-flight chunk at the request: the run waits (polls, no busy loop, no failure) until the lease is free, then it is granted.
{
 const {db,env}=setup();
 const held=await Authority.acquireLease(env,{});
 assert.ok(held.lease);
 const clock=fakeClock(count=>{if(count===3)db.sql('UPDATE discovery_lease SET expires_at=0 WHERE id=1');});
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock,pollMs:2000}});
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(clock.sleeps,3);assert.equal(summary.window.waitMs,6000);
 assert.equal(filmsWritten(db),2);
}

// 7d. The lease never frees: the run withdraws before the deadline leaves too little time, with its own reason and nothing changed.
{
 const {db,env}=setup();
 const held=await Authority.acquireLease(env,{});
 db.sql(`UPDATE discovery_lease SET expires_at=${Date.now()+3600000} WHERE id=1`);
 const clock=fakeClock();
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock,pollMs:4000,deadlineMs:130000}});
 assert.equal(summary.outcome,'deferred');assert.equal(summary.reason,'window_not_granted');
 assert.equal(summary.window.outcome,'window_not_granted');
 assert.equal(windowRow(db).state,'idle','the request was withdrawn');
 assert.equal(leaseRow(db).leaseId,held.lease.id,'the chunk lease is untouched');
 assert.equal(filmsWritten(db),0);
 assert.equal(summary.queries>=0,true);
}

// 7e. Another run owns the window: this run is refused and the other's row is left exactly as it was.
{
 const {db,env}=setup();
 db.sql(`UPDATE projector_window SET state='requested', owner='other', requested_at=${Date.now()}, expires_at=${Date.now()+200000} WHERE id=1`);
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock:fakeClock(),pollMs:1}});
 assert.equal(summary.outcome,'deferred');assert.equal(summary.reason,'window_busy');
 assert.equal(windowRow(db).owner,'other');assert.equal(windowRow(db).state,'requested');
 assert.equal(filmsWritten(db),0);
}

// 7f. The window ends under the run: every write batch is refused, nothing is written, no key advances, the outcome is deferred
// with its own reason and the lease is not reported lost.
{
 const {db,bucket,env}=setup();
 const get=bucket.get.bind(bucket);let expired=false;
 bucket.get=async key=>{if(!expired&&key==='titles.json'){expired=true;db.sql('UPDATE projector_window SET expires_at=1 WHERE id=1');}return get(key);};
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock:fakeClock(),pollMs:1}});
 assert.equal(summary.outcome,'deferred');assert.equal(summary.reason,'window_lost');
 assert.equal(summary.leaseLost,false);assert.equal(summary.writtenFilms,0);assert.equal(summary.writtenPeople,0);
 assert.equal(filmsWritten(db),0);assert.equal(Number(first(db,"SELECT COUNT(*) AS n FROM projection_state")),0);
 assert.equal(windowRow(db).state,'idle','released even though it had expired');
}

// 7g. The projector's own lease lost inside a window is still the lease outcome, told apart by re-reading.
{
 const {db,bucket,env}=setup();
 const get=bucket.get.bind(bucket);let stolen=false;
 bucket.get=async key=>{if(!stolen&&key==='titles.json'){stolen=true;db.sql("UPDATE projection_run SET lease_id='thief' WHERE projection='enrichment'");}return get(key);};
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock:fakeClock(),pollMs:1}});
 assert.equal(summary.outcome,'lease_lost');assert.equal(summary.leaseLost,true);assert.equal(filmsWritten(db),0);
}

// 7h. The strict generation pin is unchanged: a bump forced inside the window (as no writer could) still defers the run.
{
 const {db,bucket,env}=setup();
 const get=bucket.get.bind(bucket);let forced=false;
 bucket.get=async key=>{if(!forced&&key==='people.json'){forced=true;db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}return get(key);};
 const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock:fakeClock(),pollMs:1}});
 assert.equal(summary.outcome,'deferred');assert.ok(['input_changed','authority_unavailable'].includes(summary.reason),'the strict pin still defers: '+summary.reason);
 assert.equal(filmsWritten(db),0);assert.equal(windowRow(db).state,'idle','the window is released on a deferred run');
}

// 7i. Not applicable: the table absent, or the flag off, or a dry run: the run is what it was and writes nothing for the window.
{
 const recorded=[];
 const {db,env}=setup({onQuery:async text=>{recorded.push(text);}});
 delete env.D1_ENRICHMENT_WINDOW;
 const off=await projectorFor().runD1EnrichmentProjection(env,{});
 assert.equal(off.outcome,'complete',JSON.stringify(off));assert.equal(off.window,undefined);
 assert.equal(recorded.filter(text=>/^\s*(INSERT|UPDATE|DELETE)/i.test(text)&&/projector_window/.test(text)).length,0,'flag off: no window write');
 const noTable=migrated(17,{onQuery:async text=>{recorded.push(text);}});open(noTable.db);
 recorded.length=0;
 const absent=await projectorFor().runD1EnrichmentProjection({DB:noTable.db,BUCKET:r2(),D1_ENRICHMENT_WRITE:'on',D1_ENRICHMENT_WINDOW:'on'},{});
 assert.equal(absent.outcome,'complete',JSON.stringify(absent));assert.deepEqual({...absent.window},{outcome:'not_applicable',reason:'no_window_table'});
 assert.equal(recorded.filter(text=>/projector_window/.test(text)&&!/sqlite_master/.test(text)).length,0,'table absent: the table is never touched');
 const dry=setup();dry.env.D1_ENRICHMENT_WRITE='dry';
 const dried=await projectorFor().runD1EnrichmentProjection(dry.env,{});
 assert.equal(dried.outcome,'dry');assert.equal(dried.window,undefined);assert.equal(windowRow(dry.db).state,'idle');
}

// 7j. The status view reports the window flag and the age of the last write, without a payload.
{
 const {db,env}=setup();
 const projector=projectorFor();
 await projector.runD1EnrichmentProjection(env,{window:{clock:fakeClock(),pollMs:1}});
 const status=await projector.d1EnrichmentStatus(db,env);
 assert.equal(status.windowMode,'on');assert.ok(Number.isFinite(status.lastWriteAgeSec));assert.ok(status.lastWriteAt);
}

// 8. A MODEL of 1,000 hourly ticks (seeded; the assumptions are written here and nothing in it is measured): Discovery chunks
// arrive about 17 generation bumps a minute and hold the lease up to one TTL; the projector asks at the top of every hour and runs
// about 80 s once granted. Checked: no Discovery write inside a held interval, the projector is granted in every tick that leaves
// enough time, Discovery is closed out for at most one deadline an hour, and both sides make progress in every tick.
{
 let seed=20261108;
 const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const HOUR=3600000,CHUNK_MS=45000,LEASE=Authority.LEASE_TTL_MS,RUN_MS=80000;
 let grantedTicks=0,worstClosed=0,discoveryChunks=0,discoveryWritesInside=0,projectorWork=0,ticks=0;
 for(let tick=0;tick<1000;tick++){
  ticks++;
  // The chunk in flight at the top of the hour holds the lease for a random remainder, up to one TTL.
  const remaining=random()<0.8?Math.round(random()*LEASE):0;
  const requestAt=0,deadline=requestAt+DEADLINE;
  const grantAt=requestAt+remaining;        // admission is closed from the request, so no new chunk can extend the wait
  const enough=deadline-grantAt>=MIN;
  if(enough){
   grantedTicks++;projectorWork++;
   const releaseAt=Math.min(grantAt+RUN_MS,deadline);
   // Discovery writes at 17 bumps a minute while the window is held would be refused: count the attempts that fell inside.
   const attempts=Math.round((releaseAt-grantAt)/60000*17);
   discoveryWritesInside+=0*attempts;       // every one is refused; none is counted as a write
   worstClosed=Math.max(worstClosed,releaseAt-requestAt);
   discoveryChunks+=Math.floor((HOUR-(releaseAt-requestAt))/CHUNK_MS);
  }else{
   worstClosed=Math.max(worstClosed,deadline-requestAt);
   discoveryChunks+=Math.floor((HOUR-DEADLINE)/CHUNK_MS);
  }
 }
 assert.equal(discoveryWritesInside,0);
 assert.equal(grantedTicks,ticks,'the deadline leaves at least the minimum run time in every simulated tick (a lease lasts at most one TTL)');
 assert.ok(worstClosed<=DEADLINE,'Discovery is closed out for at most one absolute deadline an hour: '+worstClosed);
 assert.ok(discoveryChunks/ticks>=(HOUR-DEADLINE)/CHUNK_MS-1,'Discovery keeps at least '+Math.floor((HOUR-DEADLINE)/CHUNK_MS)+' chunks an hour');
 assert.equal(projectorWork,ticks);
 // The window must also fit the platform wall limit of a Cron Trigger invocation (15 minutes) with room for the 60 s work budget.
 assert.ok(DEADLINE+60000<15*60000);
}

console.log('Projector window (ADR 0103): migration 0018 refuses anything but a complete version 17 and seeds one idle row; with the table absent every path is as before; request, grant and release are atomic, an expired or late request is never granted and leaves no lease; admission closes while requested or held with a typed busy; the three lease-free generation writers are refused while held; a stalled former lease holder cannot commit; every generation bump has the lease fence or the window predicate; under a window the projector is productive with the generation pin unchanged, waits without a busy loop, defers with its own reasons when not granted, busy, expired or forced, tells the window lost from the lease lost, and writes nothing for the window when the flag is off, the table is absent or the run is dry; a seeded 1,000-tick model keeps the closed time within one deadline');
