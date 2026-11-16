import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The Worker does not encode the ChatGPT Predictions Task recurrence. Discovery `wait` still uses its
// own gate (nextCatchUpAt). Prediction wire fields keep the old names as null. Resolver stall grace is
// a fixed duration after that gate, not two Task slots.
function load(){
 const records=new Map(),state={now:Date.parse('2026-10-28T05:33:00Z')};
 const env={BUCKET:{
  async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value){records.set(key,JSON.parse(value));return {etag:'test'};},
  async list(){return {objects:[],truncated:false};}
 }};
 class Clock extends Date{constructor(...args){super(...(args.length?args:[state.now]));}static now(){return state.now;}}
 const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date:Clock,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
 for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
 return {context,env,records,state,run:source=>vm.runInContext(source,context)};
}
const at=iso=>Date.parse(iso);
const {context,env,records,state,run}=load();

assert.equal(run('typeof hourlyTaskRunAt'),'undefined');
assert.equal(run('typeof HOURLY_TASK_SCHEDULE'),'undefined');
const none=JSON.parse(JSON.stringify(run('scheduledRunFields()')));
assert.equal(none.nextCatchUpAt,null);assert.equal(none.nextScheduledRunAt,null);

const sources=['src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/discovery.js','src/worker.js','src/mcp.js','public/app.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
assert.equal((sources.match(/minute:20\b/g)||[]).length,0,'runtime sources do not encode a ChatGPT Task minute');
assert.doesNotMatch(sources,/\bHOURLY_TASK_SCHEDULE\b/);
assert.doesNotMatch(sources,/\bhourlyTaskRunAt\b/);

const contract=fs.readFileSync('docs/reference/scheduled-tasks.md','utf8');
assert.match(contract,/does not store or derive the ChatGPT Predictions Task recurrence/i);
assert.match(contract,/Due exhausted `chunk_budget` \(AIR-299\)/);
assert.match(contract,/epg_status\.stage=complete/);

assert.equal(run('nextCatchUpAt()'),'2026-10-28T06:00:00.000Z');

const contractOf=source=>JSON.parse(JSON.stringify(run('discoveryContract('+source+')')));
let wait=contractOf("{stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z'}");
assert.equal(wait.nextAction,'wait');assert.equal(wait.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(wait.nextScheduledRunAt,null);
wait=contractOf("{stage:'error',reason:'discovery_failed',remainingChunks:4}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T06:00:00.000Z','an error without a stored time waits for the gate');assert.equal(wait.nextScheduledRunAt,null);
wait=contractOf("{stage:'paused',reason:'backoff',remainingChunks:3,retryAt:'2026-10-28T07:25:00.000Z',nextCatchUpAt:'2026-10-28T07:25:00.000Z'}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T07:25:00.000Z');assert.equal(wait.nextScheduledRunAt,null);
wait=contractOf("{stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T05:00:00.000Z'},{nextAction:'wait'}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T05:00:00.000Z');assert.equal(wait.nextScheduledRunAt,null);
wait=contractOf("{stage:'running',remainingChunks:2},{state:'running',reason:'busy',nextAction:'wait',nextCatchUpAt:'2026-10-28T05:36:00.000Z'}");
assert.equal(wait.nextCatchUpAt,'2026-10-28T05:36:00.000Z','a live lease waits for its expiry');assert.equal(wait.nextScheduledRunAt,null);
assert.equal(contractOf("{stage:'paused',reason:'epg_committed',remainingChunks:12}").nextScheduledRunAt,null);
assert.equal(contractOf("{stage:'complete',remainingChunks:0}").nextScheduledRunAt,null);

const decide=(record,nowIso)=>{context.record=record;context.nowMs=at(nowIso);return JSON.parse(JSON.stringify(run('continuationDecision(record,nowMs)')));};
const budget={stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z',retryAt:null};
let decision=decide(budget,'2026-10-28T05:59:59.999Z');
assert.equal(decision.run,false);assert.equal(decision.contract.nextAction,'wait');assert.equal(decision.contract.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(decision.contract.nextScheduledRunAt,null);
assert.equal(decide(budget,'2026-10-28T06:00:00.001Z').run,true,'the gate opens at the whole hour');
assert.equal(decide(budget,'2026-10-28T06:22:00Z').run,true,'a late caller after the gate continues');
const backoff={stage:'paused',reason:'backoff',remainingChunks:3,nextCatchUpAt:'2026-10-28T07:25:00.000Z',retryAt:'2026-10-28T07:25:00.000Z'};
assert.equal(decide(backoff,'2026-10-28T07:20:00Z').run,false,'a 07:20 call still waits for a 07:25 backoff');
assert.equal(decide(backoff,'2026-10-28T08:20:00Z').run,true);

const exhausted={...budget,programmeRunId:'programme-1'};
assert.equal(decide(exhausted,'2026-10-28T06:00:00.000Z').run,true,'the exact gate instant is eligible');
const exhaustedDue=decide(exhausted,'2026-10-28T06:22:00Z');
assert.equal(exhaustedDue.run,true,'past-due exhausted budget must not deadlock catch-up');
assert.equal(exhaustedDue.budget,12,'the Worker replenishes a bounded series, not an unlimited loop');
assert.equal(contractOf("{stage:'paused',reason:'chunk_budget',remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z'}").nextAction,'wait','the stored wait snapshot can remain wait after the gate');
assert.equal(decide({...exhausted,nextCatchUpAt:'2026-10-28T07:00:00.000Z'},'2026-10-28T06:22:00Z').run,false,'never renew ahead of the gate');
assert.equal(decide({...exhausted,retryAt:'2026-10-28T07:00:00.000Z'},'2026-10-28T06:22:00Z').run,false,'future retry still blocks renewal');
assert.equal(decide({...exhausted,stage:'complete'},'2026-10-28T06:22:00Z').run,false,'complete is terminal, unlike exhausted paused');
assert.equal(decide({...exhausted,reason:'interrupted'},'2026-10-28T06:22:00Z').run,false,'interrupted is fail-closed');
assert.equal(decide({...exhausted,reason:'backoff',retryAt:'2026-10-28T07:00:00.000Z'},'2026-10-28T06:22:00Z').run,false,'do not treat a future backoff as due chunk_budget');
assert.equal(run("generationHandoff({stage:'paused',reason:'chunk_budget',remainingChunks:0,programmeRunId:'programme-1'},{status:'settled'},'programme-1',{runId:'programme-1'})"),null,'same generation is due renewal, not handoff');
assert.equal(run("generationHandoff({stage:'paused',reason:'chunk_budget',remainingChunks:0,programmeRunId:'programme-0'},{status:'settled'},'programme-1',{runId:'programme-1'})"),'recover','old generation is a different recovery path');
const settledWithOtherLease=JSON.parse(JSON.stringify(run("continuationHealth({stage:'paused',reason:'chunk_budget',remainingChunks:0,programmeRunId:'programme-1'},{id:'another-writer',expiresAt:Date.now()+120000},null,Date.now(),'programme-1')")));
assert.equal(settledWithOtherLease.status,'settled');
assert.equal(settledWithOtherLease.lease,null,'settled health does not itself prove absence of another live lease');

assert.equal(run('resolverProgressGraceEnd('+at('2026-10-25T00:00:00.000Z')+')'),at('2026-10-25T02:45:00.000Z'));
assert.equal(run('resolverProgressGraceEnd('+at('2026-03-29T00:00:00.000Z')+')'),at('2026-03-29T02:45:00.000Z'),'grace is a millisecond duration, not a Madrid wall-clock minute');
assert.equal(run('resolverProgressGraceEnd(Number.NaN)'),null);

records.set('enrichment/profile/current.json',{version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'profile-7',profile:{}});
records.set('programme.json',{runId:'programme-1',updatedAt:'2026-10-28T04:00:00Z',watchlistCount:0,films:[],stats:{}});
records.set('enrichment/prediction-queue.json',{schemaVersion:3,hotCount:0,coldCount:0,coldWithoutPrediction:0,hotPredicted:0,profileVersion:7,programmeRunId:'programme-1',refreshedAt:'2026-10-28T05:00:00Z',pending:[],hotPending:[],coldPending:[],priorityCount:0,coldRemaining:0,urgentCount:0,priority:{},retries:{},lastBatch:null,lastCheckAt:null,metrics:{},discovery:null});
const get=async path=>(await context.worker.fetch(new Request('https://site.example'+path),env)).json();
let footer=await get('/api/enrichment/footer/status');
assert.equal(footer.predictions.nextScheduledRun,null);
const queue=await get('/api/enrichment/queue/status');
assert.equal(queue.nextScheduledRunAt,null);assert.equal(queue.nextCatchUpAt,null,'prediction nextCatchUpAt is not a discovery gate and not a Task time');
records.set('epg/resolver-continuation.json',{stage:'paused',reason:'chunk_budget',at:'2026-10-28T05:25:00.000Z',hopId:null,remainingChunks:0,nextCatchUpAt:'2026-10-28T06:00:00.000Z',retryAt:null,programmeRunId:'programme-1'});
const step=await (await context.worker.fetch(new Request('https://site.example/api/enrichment/discovery/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chunks:0})}),env)).json();
assert.equal(step.discovery.nextAction,'wait');assert.equal(step.discovery.nextCatchUpAt,'2026-10-28T06:00:00.000Z');assert.equal(step.discovery.nextScheduledRunAt,null);
assert.equal(records.get('epg/resolver-continuation.json').nextCatchUpAt,'2026-10-28T06:00:00.000Z','a report-only read leaves the stored gate as it was');

const app=fs.readFileSync('public/app.js','utf8'),ui=vm.createContext({Date,Intl,URL,Set,Map});
vm.runInContext(app.replace(/init\(\);\s*$/,''),ui);
ui.input={...footer,lastRun:null};
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextLine,'Следующий запуск по расписанию: —');
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextRun,'—');
ui.input={...footer,predictions:{...footer.predictions,nextScheduledRun:'2026-10-28T06:20:00.000Z'},lastRun:null};
assert.equal(vm.runInContext('footerStatusText(input)',ui).nextLine,'Следующий запуск по расписанию: —','a leftover wire time is not shown as a next Task run');
state.now=at('2026-07-01T05:33:00Z');footer=await get('/api/enrichment/footer/status');
assert.equal(footer.predictions.nextScheduledRun,null);
state.now=at('2026-07-01T05:00:00Z');
assert.equal((await get('/api/enrichment/queue/status')).nextScheduledRunAt,null,'a :00 clock does not invent a Task time');
state.now=at('2026-07-01T05:15:00Z');
assert.equal((await get('/api/enrichment/queue/status')).nextScheduledRunAt,null,'a :15 clock does not invent a Task time');
state.now=at('2026-07-01T05:47:00Z');
assert.equal((await get('/api/enrichment/queue/status')).nextScheduledRunAt,null,'an off-cadence clock does not invent a Task time');

console.log('scheduled task timing: ok');
