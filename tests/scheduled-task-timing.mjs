import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The hourly Scheduled Task fires nominally at :20 Europe/Madrid. The Worker reports that nominal trigger
// (hourlyTaskRunAt) separately from its own discovery wait gate (nextCatchUpAt, the next whole UTC hour);
// the footer, the prediction API and the discovery `wait` contract read the nominal time, the gate keeps fencing.
function load(intl=Intl){
 const records=new Map(),state={now:Date.parse('2026-10-28T05:33:00Z')};
 const env={BUCKET:{
  async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value){records.set(key,JSON.parse(value));return {etag:'test'};},
  async list(){return {objects:[],truncated:false};}
 }};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
 const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl:intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
 for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
 return {context,env,records,state,run:source=>vm.runInContext(source,context)};
}
const at=iso=>Date.parse(iso);
const {context,env,records,state,run}=load();
const nominal=(from,schedule)=>{context.from=from;context.schedule=schedule;return run(schedule===undefined?'hourlyTaskRunAt(from)':'hourlyTaskRunAt(from,schedule)');};

// Hour boundary: :20 is the trigger; the whole hour is not.
assert.equal(nominal(at('2026-10-28T05:19:59.999Z')),'2026-10-28T05:20:00.000Z');
assert.equal(nominal(at('2026-10-28T05:20:00.000Z')),'2026-10-28T05:20:00.000Z','the trigger instant itself is the next nominal run');
assert.equal(nominal(at('2026-10-28T05:20:00.001Z')),'2026-10-28T06:20:00.000Z');
assert.equal(nominal(at('2026-10-28T05:33:00Z')),'2026-10-28T06:20:00.000Z','05:33 UTC → 06:20 UTC, not 06:00');
assert.equal(nominal(at('2026-10-28T05:59:59.999Z')),'2026-10-28T06:20:00.000Z');
assert.equal(nominal(at('2026-10-28T06:00:00Z')),'2026-10-28T06:20:00.000Z');
assert.equal(nominal(at('2026-12-31T23:40:00Z')),'2027-01-01T00:20:00.000Z','the year boundary is an ordinary hour');

// DST in Europe/Madrid: spring forward 2026-03-29 01:00 UTC (02:00 → 03:00), fall back 2026-10-25 01:00 UTC (03:00 → 02:00).
const madrid=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Madrid',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
for(const [from,to] of [['2026-03-28T22:00:00Z','2026-03-29T04:00:00Z'],['2026-10-24T22:00:00Z','2026-10-25T04:00:00Z']]){
 let previous=null;
 for(let cursor=at(from);cursor<at(to);cursor+=7*60000){
  const next=nominal(cursor),ms=Date.parse(next);
  assert(ms>=cursor&&ms-cursor<3600000,`${next} is the first trigger after ${new Date(cursor).toISOString()}`);
  assert.equal(madrid.formatToParts(ms).find(part=>part.type==='minute').value,'20','every trigger is :20 Madrid wall time');
  if(previous&&next!==previous)assert.equal(ms-Date.parse(previous),3600000,'triggers stay one UTC hour apart across the change');
  previous=next;
 }
}
assert.equal(nominal(at('2026-03-29T00:30:00Z')),'2026-03-29T01:20:00.000Z','spring forward: 03:20 CEST follows 01:20 CET');
assert.equal(madrid.format(at('2026-03-29T01:20:00Z')),'03:20');
assert.equal(nominal(at('2026-10-25T00:10:00Z')),'2026-10-25T00:20:00.000Z');
assert.equal(madrid.format(at('2026-10-25T00:20:00Z')),'02:20','first 02:20 (CEST)');
assert.equal(nominal(at('2026-10-25T00:30:00Z')),'2026-10-25T01:20:00.000Z');
assert.equal(madrid.format(at('2026-10-25T01:20:00Z')),'02:20','repeated 02:20 (CET)');
// The algorithm follows the zone, not a fixed UTC minute.
assert.equal(nominal(at('2026-10-28T05:33:00Z'),{timeZone:'Asia/Kolkata',minute:20}),'2026-10-28T05:50:00.000Z');

// Fail closed: no usable schedule, no claimed time.
for(const schedule of [null,{},{timeZone:'Europe/Madrid'},{timeZone:'Europe/Madrid',minute:60},{timeZone:'Europe/Madrid',minute:-1},{timeZone:'Europe/Madrid',minute:20.5},{timeZone:'Nowhere/Invalid',minute:20},{timeZone:20,minute:20}])
 assert.equal(nominal(at('2026-10-28T05:33:00Z'),schedule),null,JSON.stringify(schedule));
assert.equal(nominal(Number.NaN),null);
assert.deepEqual({...run('HOURLY_TASK_SCHEDULE')},{timeZone:'Europe/Madrid',minute:20});
assert(Object.isFrozen(run('HOURLY_TASK_SCHEDULE')));

// The expected recurrence is stated once and agrees with the maintained Scheduled Task contract.
const contract=fs.readFileSync('docs/reference/scheduled-tasks.md','utf8');
assert.match(contract,/\*\*hourly, nominally :20 Europe\/Madrid\*\*/);
const sources=['src/enrichment.js','src/letterboxd-diary.js','src/discovery.js','src/worker.js','src/mcp.js','public/app.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
assert.equal((sources.match(/minute:20\b/g)||[]).length,1,'the :20 minute appears only in HOURLY_TASK_SCHEDULE');

// The discovery gate is unchanged: next whole UTC hour, independent of the schedule.
assert.equal(run('nextCatchUpAt()'),'2026-10-28T06:00:00.000Z');

// Discovery `wait`: the gate stays nextCatchUpAt; nextScheduledRunAt is the first nominal trigger at or after it.
const contractOf=source=>JSON.parse(JSON.stringify(run('discoveryContract('+source+')')));
let wait=contractOf("{stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z'}");
assert.equal(wait.nextAction,'wait');assert.equal(wait.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(wait.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');
wait=contractOf("{stage:'error',reason:'discovery_failed',remainingChunks:4}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T06:00:00.000Z','an error without a stored time waits for the gate');assert.equal(wait.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');
wait=contractOf("{stage:'paused',reason:'backoff',remainingChunks:3,retryAt:'2026-10-28T07:25:00.000Z',nextCatchUpAt:'2026-10-28T07:25:00.000Z'}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T07:25:00.000Z');assert.equal(wait.nextScheduledRunAt,'2026-10-28T08:20:00.000Z','a backoff past :20 is caught up by the following trigger');
wait=contractOf("{stage:'paused',reason:'backoff',remainingChunks:3,retryAt:'2026-10-28T08:20:00.000Z',nextCatchUpAt:'2026-10-28T08:20:00.000Z'}");
assert.equal(wait.nextScheduledRunAt,'2026-10-28T08:20:00.000Z','a backoff ending exactly at a trigger is caught up by that trigger');
wait=contractOf("{stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T05:00:00.000Z'},{nextAction:'wait'}");
assert.equal(wait.nextScheduledRunAt,'2026-10-28T06:20:00.000Z','a gate already in the past never yields a trigger in the past');
wait=contractOf("{stage:'running',remainingChunks:2},{state:'running',reason:'busy',nextAction:'wait',nextCatchUpAt:'2026-10-28T05:36:00.000Z'}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T05:36:00.000Z','a live lease waits for its expiry');assert.equal(wait.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');
assert.equal(contractOf("{stage:'paused',reason:'epg_committed',remainingChunks:12}").nextScheduledRunAt,null,'continue claims no schedule');
assert.equal(contractOf("{stage:'complete',remainingChunks:0}").nextScheduledRunAt,null,'stop claims no schedule');

// Backoff fencing: the stored gate, not the nominal trigger, decides whether a step may run.
const decide=(record,nowIso)=>{context.record=record;context.nowMs=at(nowIso);return JSON.parse(JSON.stringify(run('continuationDecision(record,nowMs)')));};
const budget={stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z',retryAt:null};
let decision=decide(budget,'2026-10-28T05:59:59.999Z');
assert.equal(decision.run,false);assert.equal(decision.contract.nextAction,'wait');assert.equal(decision.contract.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');
assert.equal(decide(budget,'2026-10-28T06:00:00.001Z').run,true,'the gate opens at the whole hour; it is not moved to :20');
assert.equal(decide(budget,'2026-10-28T06:22:00Z').run,true,'a late trigger after the gate continues');
const backoff={stage:'paused',reason:'backoff',remainingChunks:3,nextCatchUpAt:'2026-10-28T07:25:00.000Z',retryAt:'2026-10-28T07:25:00.000Z'};
assert.equal(decide(backoff,'2026-10-28T07:20:00Z').run,false,'the 07:20 trigger still waits for a 07:25 backoff');
assert.equal(decide(backoff,'2026-10-28T08:20:00Z').run,true);

// Downstream: the footer, the queue status and a wait over HTTP all carry the nominal :20 trigger.
records.set('enrichment/profile/current.json',{version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'profile-7',profile:{}});
records.set('programme.json',{runId:'programme-1',updatedAt:'2026-10-28T04:00:00Z',watchlistCount:0,films:[],stats:{}});
records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:0,coldCount:0,coldWithoutPrediction:0,hotPredicted:0,profileVersion:7,programmeRunId:'programme-1',refreshedAt:'2026-10-28T05:00:00Z',pending:[],hotPending:[],coldPending:[],priorityCount:0,coldRemaining:0,urgentCount:0,priority:{},retries:{},lastBatch:null,lastCheckAt:null,metrics:{},discovery:null});
const get=async path=>(await context.worker.fetch(new Request('https://site.example'+path),env)).json();
let footer=await get('/api/enrichment/footer/status');
assert.equal(footer.predictions.nextScheduledRun,'2026-10-28T06:20:00.000Z');
const queue=await get('/api/enrichment/queue/status');
assert.equal(queue.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');assert.equal(queue.nextCatchUpAt,queue.nextScheduledRunAt,'the prediction nextCatchUpAt is the nominal trigger, not the whole hour');
records.set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',at:'2026-10-28T05:25:00.000Z',hopId:null,remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z',retryAt:null,programmeRunId:'programme-1'});
const step=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/discovery/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chunks:0})}),env)).json();
assert.equal(step.discovery.nextAction,'wait');assert.equal(step.discovery.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(step.discovery.nextScheduledRunAt,'2026-10-28T06:20:00.000Z');
assert.equal(records.get('epg/resolver-continuation.json').nextCatchUpAt,'2026-10-28T06:00:00.000Z','a report-only read leaves the stored gate as it was');

// The footer text shows the Madrid wall time of the trigger, winter and summer.
const app=fs.readFileSync('public/app.js','utf8'),ui=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
ui.input={...footer,lastRun:null};
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextLine,'Следующий запуск: около 07:20');
state.now=at('2026-07-01T05:33:00Z');footer=await get('/api/enrichment/footer/status');
assert.equal(footer.predictions.nextScheduledRun,'2026-07-01T06:20:00.000Z');
ui.input={...footer,lastRun:null};
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextLine,'Следующий запуск: около 08:20');

// Without a usable time zone database the schedule is unknown: the footer shows no time, the
// discovery wait keeps its gate and claims no trigger.
const brokenIntl=new Proxy(Intl,{get(target,key){return key==='DateTimeFormat'?function(locale,options){if(options?.timeZone==='Europe/Madrid'&&options.minute)throw new RangeError('no tz data');return new target.DateTimeFormat(locale,options);}:target[key];}});
const blind=load(brokenIntl);
assert.equal(blind.run('hourlyTaskRunAt()'),null);
blind.records.set('enrichment/prediction-queue.json',records.get('enrichment/prediction-queue.json'));blind.records.set('programme.json',records.get('programme.json'));
const blindFooter=await (await blind.context.worker.fetch(new Request('https://site.example/api/enrichment/footer/status'),blind.env)).json();
assert.equal(blindFooter.predictions.nextScheduledRun,null);
ui.input={...blindFooter,lastRun:null};
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextLine,'Следующий запуск: —');
const blindWait=JSON.parse(JSON.stringify(blind.run("discoveryContract({stage:'paused',reason:'chunk_budget',remainingChunks:0})")));
assert.equal(blindWait.nextAction,'wait');assert.equal(blindWait.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(blindWait.nextScheduledRunAt,null);

console.log('scheduled task timing: ok');
