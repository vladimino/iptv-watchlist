// AIR-348: offline simulation of the Worker's single hourly cron against the Madrid-local logical due time of the daily
// executors (EPG and Ratings, both 17:00 Europe/Madrid). It compares the former expression (`37 * * * *`) with the current one
// (`0 * * * *`, pinned below) on a winter day, a summer day and both DST change days, and drives the real EpgOrchestration.ensure through every
// hourly tick of each Madrid date with duplicate firings and a missed due tick. It proves schedule arithmetic and idempotency only:
// no Cloudflare, no production and no Workflow instance.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as Policy from '../src/domain/orchestration-policy.js';
import {d1Standin} from './d1-standin.mjs';

const H=3600000,MIN=60000;
const at=ms=>new Date(ms).toISOString();

// 1. The configured cron is the single trigger and it is exactly the hourly minute-0 expression (owner-approved AIR-348 change).
const wrangler=fs.readFileSync('wrangler.jsonc','utf8');
const configured=[...wrangler.matchAll(/"crons":\s*\[([^\]]*)\]/g)].map(m=>[...m[1].matchAll(/"([^"]+)"/g)].map(x=>x[1]));
assert.equal(configured.length,1,'one cron block');
assert.equal(configured[0].length,1,'one cron trigger');
const current=configured[0][0];
assert.equal(current,'0 * * * *','the one trigger is the hourly minute-0 expression; a second trigger or another minute fails here');
const minuteOf=expression=>Number(expression.split(' ')[0]);

// The ticks of an hourly cron `M * * * *` (UTC) between two instants.
function ticks(minute,from,to){
 const out=[];
 let t=Math.ceil((from-minute*MIN)/H)*H+minute*MIN;
 for(;t<to;t+=H)out.push(t);
 return out;
}
const SCHEDULES={EPG:Policy.EPG_SCHEDULE,Ratings:Policy.RATINGS_SCHEDULE};
assert.equal(SCHEDULES.EPG.hour,17);assert.equal(SCHEDULES.Ratings.hour,17);
assert.equal(SCHEDULES.EPG.minute,0);assert.equal(SCHEDULES.Ratings.minute,0);

// 2. Schedule arithmetic: Madrid 17:00 in CET (16:00Z) and CEST (15:00Z), both change days. With `0 * * * *` the first tick at or after the
// due time is the due time itself in local terms (an hourly UTC cron reaches every local hour: Madrid is a whole-hour offset), with the
// former `37 * * * *` it was 37 minutes later. The cron stays in UTC; the Worker decides due from the Madrid date.
const DAYS=[['winter','2026-11-09'],['summer','2026-07-01'],['fall-back day','2026-10-25'],['spring-forward day','2026-03-29']];
for(const [label,day] of DAYS){
 for(const [name,schedule] of Object.entries(SCHEDULES)){
  const dueAt=Policy.madridInstant(day,schedule.hour,schedule.minute);
  for(const minute of [0,37]){
   const list=ticks(minute,dueAt-6*H,dueAt+6*H);
   const first=list.find(t=>Policy.dailyDue(t,schedule).due&&Policy.dailyDue(t,schedule).dayKey===day);
   assert.equal(first-dueAt,minute*MIN,label+' '+name+' cron minute '+minute+': the first tick after due is '+minute+' minutes after it');
   const before=list.filter(t=>t<dueAt).pop();
   assert.equal(Policy.dailyDue(before,schedule).due,false,label+' '+name+': the tick before the due time is not due');
  }
 }
 // The Madrid wall clock at the first minute-0 tick at or after due reads 17:00, on every date.
 const dueAt=Policy.madridInstant(day,17,0);
 const wall=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(dueAt));
 assert.equal(wall,'17:00',label);
 assert.equal(ticks(0,dueAt,dueAt+1).length,1,label+': an hourly minute-0 UTC cron has a tick exactly at Madrid 17:00 in both offsets');
}

// 3. The real EPG ensure through every hourly tick of a Madrid date, with duplicate firings and a missed due tick.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cron-sim-'));
const chain=fs.readdirSync('migrations').filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort();
const file=path.join(root,'sim.sqlite');
const db=d1Standin(file);
for(const name of chain)db.sql(fs.readFileSync('migrations/'+name,'utf8'));
const context=vm.createContext({console,Date,Math,JSON,Promise,Intl,URL,crypto:webcrypto});
vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy'),context);
const state={};
context.loadJSON=async()=>null;
context.PublishedEpg={readAuthority:async()=>({ready:true}),repairMirrors:async()=>({mirrored:true,aligned:true,wrote:false})};
context.postSync=async()=>({status:200,json:async()=>({})});
vm.runInContext(fs.readFileSync('src/epg-orchestration.js','utf8'),context);
const epg=vm.runInContext('EpgOrchestration',context);
function binding(){
 const instances=new Map(),creates=[];
 return {instances,creates,
  async create({id,params}){if(instances.has(id)){const e=new Error('already exists');throw e;}creates.push({id,params,at:state.now});instances.set(id,'running');},
  async get(id){if(!instances.has(id))throw new Error('instance not found');return {status:async()=>({status:instances.get(id)})};}};
}
const mode={schemaVersion:1,mode:'cloudflare',from:'external',target:null,epoch:1,drain:'verified'};
async function simulate({day,minute,skipFirstDue=false,duplicates=true}){
 db.sql('DELETE FROM epg_orchestration_document');
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify(mode)+"',1,'x')");
 const wf=binding();
 const env={DB:db,EPG_WORKFLOW:wf};
 const start=Policy.madridInstant(day,0,0),end=start+24*H;
 const dueAt=Policy.madridInstant(day,17,0);
 let skipped=false;
 for(const t of ticks(minute,start,end)){
  if(skipFirstDue&&!skipped&&t>=dueAt){skipped=true;continue;}
  state.now=t;
  const calls=duplicates?[epg.ensure(env,{now:t,random:()=>0.5}),epg.ensure(env,{now:t,random:()=>0.5})]:[epg.ensure(env,{now:t,random:()=>0.5})];
  await Promise.all(calls);
 }
 return {wf,dueAt};
}
for(const [label,day] of DAYS){
 for(const minute of [0,37]){
  const normal=await simulate({day,minute});
  assert.equal(normal.wf.creates.length,1,label+' cron '+minute+': exactly one instance per Madrid date with duplicate firings at every tick');
  assert.equal(normal.wf.creates[0].params.runKey,day);
  assert.equal(normal.wf.creates[0].at-normal.dueAt,minute*MIN,label+' cron '+minute+': created at the first tick after the logical due time');
  const missed=await simulate({day,minute,skipFirstDue:true});
  assert.equal(missed.wf.creates.length,1,label+' cron '+minute+': a missed due tick still gives one instance');
  assert.equal(missed.wf.creates[0].at-missed.dueAt,minute*MIN+H,label+' cron '+minute+': the next hourly tick catches up');
  const single=await simulate({day,minute,duplicates:false});
  assert.equal(single.wf.creates.length,1,label+' cron '+minute+': a single firing per tick also gives one');
 }
}
// The date rolls: the next Madrid date is a new run key and a new instance, not a continuation.
{
 const wf=binding(),env={DB:db,EPG_WORKFLOW:wf};
 db.sql('DELETE FROM epg_orchestration_document');
 db.sql("INSERT INTO epg_orchestration_document (key,body,revision,updated_at) VALUES ('mode','"+JSON.stringify(mode)+"',1,'x')");
 const d1=Policy.madridInstant('2026-11-09',17,0),d2=Policy.madridInstant('2026-11-10',17,0);
 state.now=d1;await epg.ensure(env,{now:d1});
 // The first instance ends and is recorded complete; the next date then starts its own.
 const control=(await epg.readControl(env));
 db.sql("UPDATE epg_orchestration_document SET body='"+JSON.stringify({...control.record,doneAt:at(d1+30*MIN),phase:'done'})+"', revision=revision+1 WHERE key='control'");
 state.now=d2;await epg.ensure(env,{now:d2});
 assert.deepEqual(wf.creates.map(c=>c.params.runKey),['2026-11-09','2026-11-10']);
}

// 4. Independence of the tick's members (static, on the real handler): five calls in one Promise.allSettled, each already an async call that
// reports by value; no shared lease or await between them; the cron handler does no long step of its own.
const worker=fs.readFileSync('src/worker.js','utf8');
const handler=worker.slice(worker.indexOf('async scheduled('),worker.indexOf('async fetch('));
assert.match(handler,/execution\.waitUntil\(Promise\.allSettled\(\[/);
for(const member of ['runD1EnrichmentProjection(','RatingsOrchestration.ensure(','EpgOrchestration.ensure(','reconcileDiscoveryWorkflow(','Monitor.run(']){
 assert.ok(handler.includes(member),member+' is a member of the tick');
}
assert.equal((handler.match(/await /g)||[]).length,0,'the handler awaits nothing itself: no member waits for another');
assert.doesNotMatch(handler,/lease|acquire/i,'no shared lease between the members');

// 5. Nothing in the source or the scripts assumes the :37 minute.
for(const dir of ['src','scripts']){
 for(const name of fs.readdirSync(dir)){
  if(!/\.(js|mjs)$/.test(name))continue;
  const text=fs.readFileSync(path.join(dir,name),'utf8');
  assert.doesNotMatch(text,/minute\s*[:=]\s*37\b|getUTCMinutes\(\)\s*===?\s*37\b|:37\b/,dir+'/'+name+' does not assume the :37 minute');
 }
}
console.log('cron-schedule-simulation: ok (configured cron '+current+', compared with the former 37 * * * *)');
