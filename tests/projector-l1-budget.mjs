// ADR 0106 L1 (AIR-403), inert delivery: the wall budget of the grouped write path. With D1_ENRICHMENT_BULK on AND a window actually held AND the Film/Person marker read, the write phase may last 180 s from the
// grant instead of 60 s; the deadline is always the earlier of that and the window's own absolute expiry (300 s from the request, ADR 0103), a group starts only with the reserve and its expected latency left,
// and every other run keeps 60 s. Nothing here enables anything: the flag stays off in production and this file only proves the policy. Time is a MODEL: Date.now is replaced by a fake clock that the D1 stand-in
// advances by a stated latency per batch, so the table below is arithmetic on stated assumptions, not a measurement and not a Films-an-hour figure.
// Covered: the policy as a pure function (off 60 s, grouped without a window or marker 60 s, grouped with both 180 s, an explicit wallMs wins, the value is clamped to the 300 s cap); the write phase under both
// budgets after a fast diff (19 s) and a slow one (49 s) against the admission arithmetic; a late grant and an early expiry; a slow first group; the invariant that no group starts without the reserve; a lost window, a lost
// lease, a moved marker and an unknown outcome inside a 180 s run; every write batch inside a held window; and whole runs through the real window protocol.
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

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-l1-budget-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=(opts={})=>{
 const file=path.join(root,'b-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,opts)};
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+record.id,synopsisFetchedAt:T,runtime:120});
function filmRecord(index){
 return {id:'w'+index,title:'Film '+index,original:'Film '+index,year:1995,tmdbId:String(100+index),url:'https://letterboxd.com/film/w'+index+'/',directors:[person('director/d'+index,'Director '+index)],actors:[0,1,2].map(k=>person('actor/n'+index+'_'+k,'New '+index+'_'+k))};
}
function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}
const projector=projectorContext({log:()=>{}});
const clone=value=>JSON.parse(JSON.stringify(value));
const count=(db,table)=>Number(one(db,'SELECT COUNT(*) AS n FROM '+table));
const isRead=statements=>statements.every(item=>/^\s*SELECT/i.test(item.text));
const dropTriggers='DROP TRIGGER film_person_authority_transition;DROP TRIGGER film_person_authority_needs_baseline;';

// ---- the fake clock ----------------------------------------------------------------------------------------------------------------------------
const realNow=Date.now;
const clock={t:realNow(),install(){Date.now=()=>this.t;},restore(){Date.now=realNow;},advance(ms){this.t+=ms;}};

// 0. The policy as a pure function.
{
 const bulk=projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{});
 bulk.expectedMarker={mode:'r2',cutover:'open',generation:0};
 const W={windowGranted:true,windowExpiresAt:Date.now()+300000};
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk:null,...W})},{wallMs:60000,policy:'default'},'off: 60 s, whatever the window');
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({})},{wallMs:60000,policy:'default'});
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk,...W})},{wallMs:180000,policy:'l1'},'grouped, window, marker: 180 s');
 for(const missing of [{windowGranted:false},{windowExpiresAt:null},{windowExpiresAt:NaN}])assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk,...W,...missing})},{wallMs:60000,policy:'l1_unavailable'},'no window: 60 s '+JSON.stringify(missing));
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk:{...bulk,expectedMarker:null},...W})},{wallMs:60000,policy:'l1_unavailable'},'no marker: 60 s');
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk,...W,wallOption:45000})},{wallMs:45000,policy:'explicit'},'an explicit wallMs wins');
 assert.deepEqual({...projector.d1EnrichmentWallPolicy({bulk:null,wallOption:1e9})},{wallMs:1e9,policy:'explicit'});
 // the value is clamped to the 300 s cap of the window and invalid ones are ignored
 assert.equal(projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{l1WallMs:1e9}).l1WallMs,300000);
 assert.equal(projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{l1WallMs:-1}).l1WallMs,180000);
 assert.equal(projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{l1WallMs:'x'}).l1WallMs,180000);
 assert.equal(projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'off'},{l1WallMs:180000}),null,'the flag off selects nothing');
 assert.equal(projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{}).l1WallMs,180000);
 // the cap of ADR 0103 is not raised
 assert.equal(Authority.WINDOW_DEADLINE_MS,300000);assert.equal(Authority.WINDOW_MIN_RUN_MS,120000);
}

// ---- the write phase under a fake clock --------------------------------------------------------------------------------------------------------
async function planned(films){
 const {db}=migrated();
 const plan=await projector.d1EnrichmentDiff({DB:db,BUCKET:sources(films),D1_ENRICHMENT_WRITE:'on'},projector.d1EnrichmentAdapter(db),Date.now(),{});
 return plan;
}
const FILMS=Array.from({length:7},(_,index)=>filmRecord(index+1));
const plan=await planned(FILMS);
const WORK_GROUPS=8;           // groups of one Film: seven with their Persons, and one more for the Persons no Film of its group needed (measured, see section 1)
const READ_MS=1000,WRITE_MS=5000;   // a group: one read batch and one write batch, 6 s
// One write run. `diffMs` is the time the diff already took after the grant (the budget clock starts at the grant); `expiresInMs` is the window's expiry counted from the grant.
async function writePhase({diffMs,expiresInMs=null,wallMs,bulkOptions={groupSize:1},windowed=false,hook=null,readMs=READ_MS,writeMs=WRITE_MS,latencyOf=null}){
 const m=migrated();
 const leaseId='lease-l1';
 const adapter0=projector.d1EnrichmentAdapter(m.db);
 assert.ok(await projector.d1EnrichmentLease(adapter0,leaseId));
 const started=clock.t-diffMs,windowExpiresAt=expiresInMs==null?null:started+expiresInMs;
 if(windowed)m.db.sql("UPDATE projector_window SET state='held',owner='"+leaseId+"',requested_at="+(started-13000)+",expires_at="+(windowExpiresAt??started+287000));
 const log=[];
 const stand=d1Standin(m.file,{onBatch:async statements=>{
  const read=isRead(statements);
  const at=clock.t;
  if(hook)await hook({m,statements,read,at,log});
  log.push({read,at,statements:statements.length,windowHeld:windowed?Number(one(m.db,"SELECT COUNT(*) AS n FROM projector_window WHERE state='held' AND owner='"+leaseId+"' AND expires_at>"+clock.t))===1:null});
  clock.advance(latencyOf?latencyOf({read,statements}):(read?readMs:writeMs));
 }});
 const bulk=projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},bulkOptions);
 const marker=m.db.sql('SELECT mode,cutover,generation FROM film_person_authority WHERE id=1')[0];
 bulk.expectedMarker={mode:marker.mode,cutover:marker.cutover,generation:Number(marker.generation)};
 const adapter=projector.d1EnrichmentAdapter(stand);
 const result=await projector.d1EnrichmentWrite(adapter,clone(plan),{leaseId,started,queryBudget:800,wallMs,bulk,windowOwner:windowed?leaseId:null,windowExpiresAt});
 return {result,log,m,started,windowExpiresAt,end:clock.t};
}
// The admission rule the code states: a group starts while (deadline - now - reserve) covers the longest group seen so far (the first estimate before any).
function modelGroups({budgetMs,diffMs,expiresInMs,reserve=15000,first=5000,group=READ_MS+WRITE_MS,maxGroups=Infinity}){
 const deadline=Math.min(budgetMs,expiresInMs??Infinity);
 let used=diffMs,longest=0,groups=0;
 while(groups<maxGroups&&deadline-used-reserve>=(longest||first)){used+=group;longest=group;groups++;}
 return {groups,endedAt:used};
}
clock.install();
const table=[];
try{
 // 1. Fast and slow diff, 60 s against 180 s: the arithmetic of the admission rule against the real write loop.
 for(const diffMs of [19000,49000])for(const [label,wallMs] of [['60 s',60000],['180 s',180000]]){
  const {result,log}=await writePhase({diffMs,expiresInMs:300000-13000,wallMs});
  const groups=result.bulk.groups;
  const model=modelGroups({budgetMs:wallMs,diffMs,expiresInMs:287000,maxGroups:WORK_GROUPS});
  assert.equal(groups,model.groups,label+' after a diff of '+diffMs/1000+' s: groups '+groups+' against the admission arithmetic '+model.groups);
  assert.equal(result.errorCount,0);assert.equal(result.bulk.fallbacks,0);
  const writeSeconds=(log.length?log[log.length-1].at+WRITE_MS-log[0].at:0)/1000;
  table.push({diffS:diffMs/1000,budget:label,groups,films:result.writtenFilms,people:result.writtenPeople,remaining:result.remaining,stop:result.bulk.stop,writeSeconds});
 }
 const by=(diffS,budget)=>table.find(row=>row.diffS===diffS&&row.budget===budget);
 assert.ok(by(19,'60 s').groups>0&&by(19,'60 s').remaining>0,'a fast diff leaves the grouped path some of 60 s but not all of the work');
 assert.equal(by(49,'60 s').groups,0,'a slow diff leaves 60 s nothing: 60-49-15 is under the first group estimate');
 assert.equal(by(49,'60 s').bulk,undefined);assert.equal(by(49,'60 s').stop,'budget');
 assert.ok(by(49,'180 s').groups>0,'180 s gives a slow diff a write budget');
 assert.ok(by(19,'180 s').groups>by(19,'60 s').groups&&by(49,'180 s').groups>by(49,'60 s').groups);
 assert.equal(by(19,'180 s').remaining,0,'this small plan finishes inside 180 s');
 if(process.env.L1_TABLE==='1')console.log(JSON.stringify(table));

 // 2. A late grant and an early expiry: the deadline is the window's expiry, never the 180 s.
 for(const expiresInMs of [120000,100000,60000]){
  const {result,log,end,started}=await writePhase({diffMs:19000,expiresInMs,wallMs:180000});
  const model=modelGroups({budgetMs:180000,diffMs:19000,expiresInMs,maxGroups:WORK_GROUPS});
  assert.equal(result.bulk.groups,model.groups,'expiry '+expiresInMs/1000+' s from the grant');
  assert.ok(end<=started+expiresInMs,'the run ends inside the window: '+(end-started)+' of '+expiresInMs+' ms');
  assert.ok(log.every(item=>item.at<started+expiresInMs-15000+1),'no batch starts inside the reserve before the expiry');
  assert.equal(result.windowLost,false);
 }
 // the minimum run time of the window protocol (120 s) is the shortest budget a grant can leave, and 180 s never exceeds it
 {
  const {result,end,started}=await writePhase({diffMs:49000,expiresInMs:Authority.WINDOW_MIN_RUN_MS,wallMs:180000});
  assert.ok(end<=started+Authority.WINDOW_MIN_RUN_MS);assert.ok(result.bulk.groups>0,'a grant with the minimum run time left still writes after a slow diff');
 }

 // 3. The reserve and a slow first group: no group starts without the reserve and the longest group seen so far.
 for(const [label,latencyOf] of [['slow first group',({read,statements})=>clock.t<=0?0:(read?1000:5000)],['a read that takes 30 s',({read})=>read?30000:5000]]){
  const starts=[];let longest=0,lastStart=null;
  const {result,log,started,windowExpiresAt}=await writePhase({diffMs:19000,expiresInMs:287000,wallMs:180000,latencyOf,hook:async({read,at})=>{if(read){lastStart=at;starts.push({at,longest});}else if(lastStart!=null){longest=Math.max(longest,at-lastStart+5000);}}});
  const deadline=Math.min(started+180000,windowExpiresAt);
  for(const item of starts)assert.ok(deadline-item.at-15000>=(item.longest||5000),label+': a group started at '+(item.at-started)+' ms with '+item.longest+' ms of longest group');
  assert.equal(result.errorCount,0);void log;
 }

 // 4. Every write batch of a run inside a held window finds the window held and unexpired.
 {
  const {log}=await writePhase({diffMs:19000,expiresInMs:287000,wallMs:180000,windowed:true});
  assert.ok(log.length>0&&log.filter(item=>!item.read).every(item=>item.windowHeld===true),'writes only inside the held window');
 }

 // 5. Losses inside a 180 s run: the window expires under the run, the lease is stolen, the marker moves, a batch fails with an unknown outcome. Nothing is written after the loss.
 for(const [name,mutate,check] of [
  ['the window expires',({m})=>m.db.sql('UPDATE projector_window SET expires_at=1'),r=>{assert.equal(r.windowLost,true);assert.equal(r.bulk.stop,'window_lost');}],
  ['the lease is stolen',({m})=>m.db.sql("UPDATE projection_run SET lease_id='someone-else'"),r=>{assert.equal(r.leaseLost,true);assert.equal(r.bulk.stop,'lease_lost');}],
  ['the marker moves',({m})=>m.db.sql(dropTriggers+'UPDATE film_person_authority SET generation=generation+1'),r=>{assert.equal(r.authorityMoved,true);assert.equal(r.bulk.stop,'authority_moved');}],
 ]){
  let writes=0,afterLoss=null,rowsAtLoss=null,fired=false;
  const {result,m}=await writePhase({diffMs:19000,expiresInMs:287000,wallMs:180000,windowed:true,hook:async({m,read})=>{
   if(!read){writes++;if(writes===3&&!fired){fired=true;await mutate({m});rowsAtLoss=count(m.db,'film')+count(m.db,'person');}}
  }});
  check(result);
  assert.ok(result.writtenFilms+result.writtenPeople>0,name+': it had written before the loss');
  const rowsNow=count(m.db,'film')+count(m.db,'person');
  assert.equal(rowsNow,rowsAtLoss,name+': nothing is written after the loss ('+rowsAtLoss+' then '+rowsNow+')');
  assert.ok(result.remaining>0,name);
  void afterLoss;
 }
 {
  let writes=0;
  const {result,m}=await writePhase({diffMs:19000,expiresInMs:287000,wallMs:180000,hook:async({read})=>{if(!read&&++writes===3)throw new Error('D1_ERROR: Network connection lost');}});
  assert.equal(result.bulk.stop,'batch_error');assert.ok(result.bulk.fallbackReasons.batch_error===1);
  assert.equal(count(m.db,'film'),7,'the per-entity replay finishes the work inside the budget');
 }
}finally{clock.restore();}

// ---- whole runs through the real window protocol ------------------------------------------------------------------------------------------------
const open=db=>{db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-1', published_programme_run_id='run-1' WHERE id=1");};
const films2=[filmRecord(1),filmRecord(2),filmRecord(3)];
const logs=[];
const projectorFor=()=>projectorContext({log:line=>logs.push(JSON.parse(line)),globals:{DiscoveryAuthority:Authority}});
async function wholeRun({bulkFlag,windowFlag='on',diffMs=49000,options={},readMs=1000,writeMs=5000}){
 const clk={t:realNow()};
 Date.now=()=>clk.t;
 try{
  let advanced=false;
  const m=migrated({onQuery:async text=>{if(!advanced&&/metadata_cache_authority/.test(text)){advanced=true;clk.t+=diffMs;}},onBatch:async statements=>{clk.t+=isRead(statements)?readMs:writeMs;}});
  open(m.db);
  const env={DB:m.db,BUCKET:sources(films2),discoveryLease:null,D1_ENRICHMENT_WRITE:'on',...(windowFlag?{D1_ENRICHMENT_WINDOW:windowFlag}:{}),...(bulkFlag?{D1_ENRICHMENT_BULK:bulkFlag}:{})};
  const summary=await projectorFor().runD1EnrichmentProjection(env,{window:{clock:{now:()=>clk.t,sleep:async()=>{}},pollMs:1},...options});
  return {summary,m,clk};
 }finally{Date.now=realNow;}
}
// 6. Off: no budget record and the old 60 s; on: the L1 policy with a window and a marker; on without a window: 60 s.
{
 const off=await wholeRun({bulkFlag:null});
 assert.equal(off.summary.bulkBudget,undefined,'the flag off adds nothing to the summary');assert.equal(off.summary.bulk,undefined);
 // off keeps its 60 s: after a 49 s diff only 11 s are left and each per-entity batch of this model takes 5 s, so the run ends on its budget with work left (the legacy behaviour the grouped L1 budget is compared with)
 assert.equal(off.summary.outcome,'budget');assert.ok(off.summary.writtenFilms<3&&off.summary.remaining>0,JSON.stringify([off.summary.writtenFilms,off.summary.remaining]));
 const on=await wholeRun({bulkFlag:'on'});
 assert.equal(on.summary.outcome,'complete',JSON.stringify([on.summary.outcome,on.summary.reason,on.summary.bulk]));
 assert.deepEqual({...on.summary.bulkBudget,effectiveMs:undefined},{wallMs:180000,policy:'l1',effectiveMs:undefined});
 assert.equal(on.summary.bulkBudget.effectiveMs,180000,'the expiry of a fresh window is 300 s from its request, the budget 180 s from the grant');
 assert.equal(on.summary.writtenFilms,3);assert.ok(on.summary.bulk.applied>0);assert.equal(on.summary.window.outcome,'granted');
 // the same slow diff (49 s) under an explicit 60 s wall writes nothing with the grouped path: the observed failure the policy exists for
 const old=await wholeRun({bulkFlag:'on',options:{wallMs:60000}});
 assert.equal(old.summary.bulkBudget.policy,'explicit');assert.equal(old.summary.bulk.groups,0);assert.equal(old.summary.bulk.stop,'budget');assert.equal(old.summary.writtenFilms,0);assert.equal(old.summary.outcome,'budget');
 // the grouped path without a window keeps 60 s
 const bare=await wholeRun({bulkFlag:'on',windowFlag:null,diffMs:10000});
 assert.equal(bare.summary.bulkBudget.policy,'l1_unavailable');assert.equal(bare.summary.bulkBudget.wallMs,60000);assert.equal(bare.summary.window,undefined);
 assert.equal(bare.summary.writtenFilms,3,'a fast diff without a window still writes under 60 s');
 // the window is released and nothing is left behind after the run
 for(const run of [off,on,old]){assert.equal(one(run.m.db,'SELECT state FROM projector_window WHERE id=1'),'idle');assert.equal(count(run.m.db,'projection_fence'),0);}
}

// 7. The source: one policy value, the 300 s cap is not raised, and no other module reads the new option.
{
 const source=fs.readFileSync('src/d1-enrichment.js','utf8');
 assert.match(source,/const D1_ENRICHMENT_L1_WALL_MS=180000,D1_ENRICHMENT_L1_WALL_MAX_MS=300000;/);
 assert.match(source,/const D1_ENRICHMENT_WALL_MS=60000;/);
 assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/l1WallMs|D1_ENRICHMENT_L1/);
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/D1_ENRICHMENT_BULK/);
 assert.match(fs.readFileSync('src/discovery-authority.js','utf8'),/WINDOW_DEADLINE_MS=300000|WINDOW_DEADLINE_MS\s*=\s*300000/);
}
console.log('projector L1 wall budget (ADR 0106, AIR-403): off keeps 60 s; the grouped path gets 180 s from the grant only with a held window and the marker, never past the window\'s absolute expiry (300 s from the request, not raised) and never without the reserve; after a slow diff (49 s) 60 s writes nothing and 180 s writes; losses of the window, lease or marker and an unknown outcome stop or recover inside the budget; every write is inside the held window; whole runs through the real window protocol');
