// AIR-598: ONE Discovery queue classification for every reader. The same stored records give the same queue state to the shared classifier
// (src/discovery.js `discoveryQueueState`), the footer row «Распознавание» (GET /api/enrichment/footer/status), the hourly Monitor tick, the hourly Events
// report, the operational status (GET /api/enrichment/pipeline/status?view=operational, the MCP `epg_pipeline_status` body) and the admin data health model.
// Each consumer keeps its own presentation and confirmation policy, but none of them re-derives the facts. The exact production picture of 23-24 Nov 2026
// (a drained series stopped on `backlog_empty`, a `chunk_budget` gate left hours in the past) is the proven empty queue everywhere; the move to a new
// non-empty generation, a real stall, waits, a live writer, unconfirmed and legacy states stay distinct. Reads write nothing; a Monitor recovery is sent once.
// Offline only: an in-memory bucket, a fake webhook, an injected clock. Nothing here calls Cloudflare or production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,plain,g} from './ratings-harness.mjs';
import * as DataHealth from '../src/domain/data-health.js';

const MIN=60000,H=3600000;
const at=ms=>new Date(ms).toISOString();
// 24 Nov 2026 12:00 UTC = 13:00 Europe/Madrid, the hour the owner saw the false alarm. The drain was at 19:24:56 UTC on 23 Nov.
const T0=Date.parse('2026-11-24T12:00:00Z'),DRAIN=Date.parse('2026-11-23T19:24:56Z');
const G1='d8dc6ec8-1f3b-4c9e-9d2a-5b7c1e0a4f11',G2='0f5e7a2c-6b1d-4e8a-9c3f-2a1b0c9d8e77',HOP='c554872a-2b18-4b45-95c1-85b4630ffc6b';
const INSTANCE=`discovery_${G1.replace(/-/g,'')}_27`;

function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 vm.runInContext(fs.readFileSync('src/discovery-workflow.js','utf8').replace(/export \{[^}]+\};/g,''),ctx);
 vm.runInContext(scoped('src/domain/orchestration-policy.js','OrchestrationPolicy')+'\n'+scoped('src/domain/monitor-policy.js','MonitorPolicy')+'\n'+scoped('src/domain/monitor-message.js','MonitorMessage')+'\n'+fs.readFileSync('src/monitor.js','utf8'),ctx);
 const posts=[];
 const world={};
 ctx.fetch=async(url,options={})=>{if(String(url).startsWith('https://hooks.example/')){if(world.hookDown)return new Response('',{status:500});posts.push(JSON.parse(options.body||'null'));return new Response('',{status:200});}throw new Error('unexpected network '+url);};
 const liveness={status:'complete'};
 const env=baseEnv(bucket,{MONITOR:'on',MONITOR_WEBHOOK_URL:'https://hooks.example/alert',DISCOVERY_WORKFLOW:{create:async()=>{throw new Error('a read must not create an instance');},get:async()=>({status:async()=>({status:liveness.status})})}});
 ctx.RatingsOrchestration={async readModel(){return {mode:'cloudflare',health:'healthy',failure:null};}};
 return Object.assign(world,{clock,bucket,ctx,env,posts,liveness,M:g(ctx,'Monitor'),call:name=>vm.runInContext(name,ctx)});
}
const W=setup();
const {bucket,clock,env}=W;
const put=(key,value)=>{if(value===undefined)bucket.records.delete(key);else{bucket.records.set(key,structuredClone(value));bucket.etags.set(key,'s'+Math.random());}};
const writes=()=>bucket.log.filter(item=>item.op==='put'||item.op==='delete').map(item=>item.key);
const response=async path=>(await W.ctx.worker.fetch(new Request('https://iptv.example'+path),env,{waitUntil(){}})).json();

// The records of one scenario. `published` is the EPG pointer; the rest are the small Discovery records the shared reader reads.
const drainedRecords=()=>({
 published:G1,
 workflow:{schemaVersion:1,programmeRunId:G1,series:27,instanceId:INSTANCE,phase:'stopped',reason:'backlog_empty',updatedAt:at(DRAIN+5000),waitingUntil:null,recovery:null},
 continuation:{stage:'paused',reason:'chunk_budget',at:at(DRAIN),hopId:HOP,remainingChunks:0,nextCatchUpAt:at(DRAIN+H),retryAt:null,programmeRunId:G1},
 status:{schemaVersion:2,stage:'partial',programmeRunId:G1,hopId:HOP,startedAt:at(DRAIN-40000),finishedAt:at(DRAIN),checked:12,added:3,remaining:0,cheapRemaining:0,deferred:0,waitingRetry:0,error:null,legacyPending:true},
 lease:undefined,
});
function arrange(scenario){
 const fixture={...drainedRecords(),...scenario.records?.(drainedRecords())};
 put('epg/published-generation.json',fixture.published?{programmeRunId:fixture.published,phase:'published'}:undefined);
 put('sync.json',{runId:fixture.published||G1,stage:'complete',updatedAt:at(Date.parse('2026-11-23T16:04:00Z'))});
 put('programme.json',{runId:fixture.published||G1,updatedAt:at(Date.parse('2026-11-23T16:04:00Z')),films:[],stats:{}});
 put('epg/discovery-workflow.json',fixture.workflow);put('epg/resolver-continuation.json',fixture.continuation);
 put('epg/discovery-status.json',fixture.status);put('epg/resolver-lease.json',fixture.lease);
}
const classify=async()=>{const read=await W.call('readDiscoveryQueue')(env,{now:clock.now});return plain(read.queue);};

// Same input, same classification in every consumer; each one's own presentation of it.
const SCENARIOS=[
 {name:'drained series of 23-24 Nov (stopped backlog_empty, chunk_budget gate 16 h past, every part of the queue zero)',expect:{state:'empty',reason:'drained',owed:false,eligible:false},
  footer:{state:'healthy',code:'queue_empty'},monitor:'healthy',eventsEmpty:true,health:'clear',executor:{pending:false,eligible:false,degraded:false}},
 {name:'the next generation is published and queued (a new non-empty queue)',records:()=>({published:G2,continuation:{stage:'paused',reason:'epg_committed',at:at(T0-5*MIN),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:G2}}),
  expect:{state:'backlog',reason:'pending',owed:true,eligible:true},footer:{state:'running',code:'running'},monitor:'healthy',eventsEmpty:false,health:'attention',executor:{pending:true,eligible:true}},
 {name:'a real backlog whose gate passed hours ago with no newer batch',records:base=>({status:{...base.status,remaining:40,legacyPending:false},workflow:{...base.workflow,reason:'no_progress',recovery:null}}),
  expect:{state:'backlog',reason:'chunk_budget',owed:true,eligible:true},footer:{state:'degraded',code:'resolver_no_recent_progress'},monitor:'degraded',eventsEmpty:false,health:'attention',executor:{pending:true,eligible:true}},
 {name:'a backoff inside its retry time',records:base=>({continuation:{...base.continuation,reason:'backoff',retryAt:at(T0+30*MIN),nextCatchUpAt:at(T0+30*MIN),remainingChunks:5,at:at(T0-10*MIN)},status:{...base.status,remaining:9,finishedAt:at(T0-10*MIN)}}),
  expect:{state:'backlog',reason:'backoff',owed:true,eligible:false},footer:{state:'degraded',code:'resolver_backoff'},monitor:'waiting',eventsEmpty:false,health:'attention',executor:{pending:true,eligible:false}},
 {name:'a live writer (running checkpoint, live lease)',records:base=>({continuation:{...base.continuation,stage:'running',reason:null,at:at(T0-MIN),hopId:'hop-live',remainingChunks:4,nextCatchUpAt:null},lease:{id:'hop-live',expiresAt:T0+60000}}),
  expect:{state:'running',reason:'live_lease',owed:true,eligible:false},footer:{state:'running',code:'running'},monitor:'healthy',eventsEmpty:false,health:'clear',executor:{pending:true,eligible:false}},
 {name:'all zeros but the status names another hop (the proof is incomplete)',records:base=>({status:{...base.status,hopId:'another-hop'}}),
  expect:{state:'unknown',reason:'drain_unconfirmed',owed:null,eligible:null},footer:{state:'unknown',code:'resolver_unconfirmed'},monitor:'degraded',monitorIssue:'discovery_unconfirmed',eventsEmpty:false,health:'attention',executor:{pending:true,eligible:false}},
 {name:'a continuation of the previous generation after a publication',records:()=>({published:G2}),
  expect:{state:'unknown',reason:'generation_mismatch',owed:null,eligible:null},footer:{state:'waiting',code:'resolver_handoff'},monitor:'degraded',monitorIssue:'discovery_unconfirmed',eventsEmpty:false,executor:{pending:true,eligible:false}},
 {name:'legacy records without a generation pin or hop',records:base=>({continuation:{...base.continuation,programmeRunId:undefined,hopId:undefined},status:{...base.status,programmeRunId:undefined,hopId:undefined}}),
  expect:{state:'unknown',reason:'generation_mismatch',owed:null,eligible:null},footer:{state:'waiting',code:'resolver_handoff'},eventsEmpty:false,executor:{pending:true,eligible:false}},
 {name:'partial counts (the cheap-pass remainder is not a number)',records:base=>({status:{...base.status,cheapRemaining:null}}),
  expect:{state:'unknown',reason:'partial_counts',owed:null,eligible:null},footer:{state:'unknown',code:'resolver_unconfirmed'},eventsEmpty:false,health:'attention',executor:{pending:true,eligible:false}},
 {name:'a recorded chunk error',records:base=>({continuation:{...base.continuation,stage:'error',reason:'tmdb_unavailable',remainingChunks:12,at:at(T0-20*MIN),nextCatchUpAt:at(T0+40*MIN)},workflow:{...base.workflow,phase:'waiting',reason:null,waitingUntil:at(T0+40*MIN),updatedAt:at(T0-20*MIN)}}),
  expect:{state:'failed',reason:'tmdb_unavailable',owed:true,eligible:false},footer:{state:'failed',code:'resolver_failed'},monitor:'waiting',eventsEmpty:false,executor:{pending:true,eligible:false}},
 {name:'a quarantined executor',records:base=>({status:{...base.status,remaining:7},workflow:{...base.workflow,reason:'recovery_exhausted',recovery:{attempts:5,reason:'recovery_exhausted',quarantined:true}}}),
  expect:{state:'blocked',reason:'quarantined',owed:true,eligible:false},footer:{state:'failed',code:'resolver_failed'},monitor:'degraded',monitorIssue:'discovery_quarantined',eventsEmpty:false,executor:{pending:true,eligible:false}},
];

for(const scenario of SCENARIOS){
 const label=scenario.name;
 clock.now=T0;arrange(scenario);
 // 1. The shared classifier, read once through the shared reader.
 const queue=await classify();
 for(const [name,value] of Object.entries(scenario.expect))assert.equal(queue[name],value,label+': classifier '+name);
 const writesBefore=writes().length;
 // 2. Footer: the row carries the same classification and its own presentation of it.
 const footer=await response('/api/enrichment/footer/status');
 const resolver=footer.integrations.sources.find(item=>item.id==='resolver');
 assert.equal(resolver.queueState,queue.state,label+': footer state');assert.equal(resolver.queueReason,queue.reason,label+': footer reason');
 assert.equal(resolver.state,scenario.footer.state,label+': footer presentation');assert.equal(resolver.code,scenario.footer.code,label+': footer code');
 assert.doesNotMatch(JSON.stringify(resolver),/Usage|quota/i);
 // 3. Operational and detailed status (HTTP; the MCP tool returns the same bodies): the queue block and the executor flags come from the same classification.
 const operational=await response('/api/enrichment/pipeline/status?view=operational');
 assert.equal(operational.queue.state,queue.state,label+': operational state');assert.equal(operational.queue.reason,queue.reason,label+': operational reason');
 assert.equal(operational.executor.pending,queue.owed!==false,label+': pending is "not proven empty"');assert.equal(operational.executor.eligible,queue.eligible===true,label+': eligible');
 for(const [name,value] of Object.entries(scenario.executor||{}))assert.equal(operational.executor[name],value,label+': executor '+name);
 // The detailed view classifies the records it read under its own fence with the same rule.
 const detailed=await response('/api/enrichment/pipeline/status');
 assert.equal(detailed.discoveryQueue.state,queue.state,label+': detailed state');assert.equal(detailed.discoveryQueue.reason,queue.reason,label+': detailed reason');
 assert.equal(detailed.discoveryExecutor.pending,operational.executor.pending,label+': detailed pending');assert.equal(detailed.discoveryExecutor.eligible,operational.executor.eligible,label+': detailed eligible');
 // Repeated reads of the three routes write nothing.
 await response('/api/enrichment/footer/status');await response('/api/enrichment/pipeline/status?view=operational');await response('/api/enrichment/pipeline/status');
 assert.deepEqual(writes().slice(writesBefore),[],label+': footer and operational reads write nothing');
 // 4. Admin data health: the same classification attached to the authoritative continuation.
 if(scenario.health){
  const published={programmeRunId:queue.programmeRunId||G1,phase:'published',publishedAt:at(T0-20*H),observedAt:at(T0)};
  const continuation=bucket.records.get('epg/resolver-continuation.json');
  const input={now:at(T0),pin:{programmeRunId:published.programmeRunId},coverage:{films:'complete'},published,films:[],
   discovery:{stage:continuation.stage??null,reason:continuation.reason??null,at:continuation.at??null,retryAt:continuation.retryAt??null,nextCatchUpAt:continuation.nextCatchUpAt??null,remainingChunks:continuation.remainingChunks??null,programmeRunId:continuation.programmeRunId??null,hopId:continuation.hopId??null,observedAt:at(T0),queue:{state:queue.state,reason:queue.reason,owed:queue.owed,eligible:queue.eligible,proof:queue.proof,provenAt:queue.provenAt}}};
  assert.equal(DataHealth.evaluateDataHealth(input).subsystems.discovery.status,scenario.health,label+': admin data health');
 }
 // 5. Monitor: the stream facts carry the same classification; the policy's own time rule decides the state.
 if(scenario.monitor){
  put('monitor/state.json',undefined);
  await W.M.run(env,{now:clock.now});
  const stream=bucket.records.get('monitor/state.json').streams.find(item=>item.stream==='discovery');
  assert.equal(stream.facts.queueState,queue.state,label+': monitor state');assert.equal(stream.facts.queueReason,queue.reason,label+': monitor reason');
  assert.equal(stream.state,scenario.monitor,label+': monitor presentation');
  if(scenario.monitorIssue)assert.ok(stream.issues.some(item=>item.key===scenario.monitorIssue),label+': '+scenario.monitorIssue);
  if(scenario.expect.state==='empty')assert.equal(stream.issues.length,0,label+': a proven empty queue raises nothing');
  assert.ok(!stream.issues.some(item=>item.key==='discovery_stalled')||queue.owed===true,label+': discovery_stalled only for owed work');
 }
 // 6. Events: the hourly report proves the queue empty with the same proof, and only then.
 put('epg/discovery-workflow.json',{...(bucket.records.get('epg/discovery-workflow.json')||{schemaVersion:1,programmeRunId:queue.programmeRunId,series:1,instanceId:'discovery_x_1',phase:'stopped',reason:'backlog_empty'}),report:null,outbox:[]});
 const before=[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).length;
 await W.call('closeHourlyDiscoveryReport')(env,{started:false,reason:'stopped',programmeRunId:queue.programmeRunId},{scheduled:true,now:clock.now});
 const events=[...bucket.records.entries()].filter(([key])=>key.startsWith('events/items/')).map(([,value])=>value).filter(item=>item.type==='discovery'&&item.kind==='hour');
 assert.equal(events.length,before+1,label+': one report');
 const event=events.sort((a,b)=>String(a.id).localeCompare(String(b.id))).at(-1);
 assert.equal(event.queueEmpty,scenario.eventsEmpty,label+': events queueEmpty');
 assert.equal(event.queueEmpty,queue.state==='empty',label+': events parity');
 for(const key of [...bucket.records.keys()].filter(key=>key.startsWith('events/')))bucket.records.delete(key);
}

// 7. The EPG-priority pause (read only under D1 authority, through `readDiscoveryGates`) and the D1 snapshot path of the same reader: a queue with owed work is
// paused, not stalled and not empty; the same drained records stay proven empty while the pause is open. A loading authority is never empty.
{
 const records=drainedRecords();
 const snapshot=(override={})=>({handled:true,authority:{state:'ready',mode:'d1',cutover:'open',transfer:'idle',generation:9,programmeRunId:G1,publishedProgrammeRunId:G1},unreadable:[],records:{status:records.status,continuation:records.continuation,workflow:records.workflow,lease:null,window:null},...override});
 let current=snapshot(),gates={priority:{present:true,paused:true,reason:'epg_priority',detail:'awaiting_complete',nextCatchUpAt:at(T0+MIN)}};
 W.ctx.DiscoveryAuthority={readOperationalSnapshot:async()=>current,readDiscoveryGates:async()=>gates,ownsKey:()=>false,readAuthority:async()=>({ready:false})};
 let queue=await classify();
 assert.equal(queue.state,'empty','a proven drained queue stays empty while the pause holds new admission');assert.equal(queue.pause.paused,true);
 current=snapshot({records:{...snapshot().records,status:{...records.status,remaining:15,legacyPending:false}}});
 queue=await classify();
 assert.deepEqual([queue.state,queue.reason,queue.owed,queue.eligible],['paused','awaiting_certificate',true,false],'owed work under the pause waits for the certified publication');
 const operational=await response('/api/enrichment/pipeline/status?view=operational');
 assert.equal(operational.queue.state,'paused');assert.equal(operational.source,'d1_snapshot');
 gates={priority:{present:true,paused:false,reason:'published',nextCatchUpAt:null}};
 queue=await classify();
 assert.deepEqual([queue.state,queue.reason],['backlog','chunk_budget'],'the pause lifted after the certificate: the same backlog is eligible again');
 current=snapshot({authority:{...snapshot().authority,state:'loading',transfer:'loading'}});
 assert.deepEqual([(await classify()).state,(await classify()).reason],['unknown','authority_loading'],'a loading authority is never an empty queue');
 W.ctx.DiscoveryAuthority={readOperationalSnapshot:async()=>{throw Object.assign(new Error('d1 down'),{code:'discovery_unavailable'});},ownsKey:()=>false};
 assert.deepEqual([(await classify()).state,(await classify()).reason],['unknown','authority_unavailable'],'an unreadable authority is unknown, never empty');
 delete W.ctx.DiscoveryAuthority;
}

// 8. The Monitor across the owner's day: a real stall alerts once; the queue then drains and is proven empty: one recovery, worded as a proven empty queue (not
// progress); further ticks with the same old gate send nothing. Moving to the next generation's non-empty queue raises nothing while it is fresh.
{
 W.posts.length=0;put('monitor/state.json',undefined);
 const stalledRecords=base=>({status:{...base.status,remaining:40,legacyPending:false,finishedAt:at(T0-6*H)},continuation:{...base.continuation,at:at(T0-6*H),nextCatchUpAt:at(T0-5*H)},workflow:{...base.workflow,reason:'no_progress'}});
 clock.now=T0;arrange({records:stalledRecords});
 await W.M.run(env,{now:T0});await W.M.run(env,{now:T0+H});
 const alerts=W.posts.filter(item=>item.key==='discovery_stalled'&&item.kind!=='recovery');
 assert.equal(alerts.length,1,'the real stall alerts once');
 const drained=drainedRecords();
 arrange({records:()=>({status:{...drained.status,finishedAt:at(T0+90*MIN)},continuation:{...drained.continuation,at:at(T0+90*MIN),nextCatchUpAt:at(T0+150*MIN)},workflow:{...drained.workflow,updatedAt:at(T0+90*MIN)}})});
 // The channel refuses this one tick, so the queued recovery can be read as the Telegram text renders it; the next tick delivers it, once.
 W.hookDown=true;clock.now=T0+5*H;await W.M.run(env,{now:T0+5*H});W.hookDown=false;
 const queued=bucket.records.get('monitor/state.json').outbox.find(item=>item.key==='discovery_stalled'&&item.kind==='recovery');
 assert.equal(queued.recoveryReason,'queue_empty');
 const text=W.M.internals.telegramText(queued,'healthy',T0+5*H);
 assert.ok(text.includes('Причина: очередь пуста, это доказано записями той же программы')&&text.includes('Это не новый прогресс'),text);
 clock.now=T0+5*H+MIN;await W.M.run(env,{now:clock.now});
 const recoveries=W.posts.filter(item=>item.key==='discovery_stalled'&&item.kind==='recovery');
 assert.equal(recoveries.length,1,'one recovery');assert.match(recoveries[0].message,/proven empty \(drained\)/);
 for(let tick=6;tick<=9;tick++){clock.now=T0+tick*H;await W.M.run(env,{now:clock.now});}
 assert.equal(W.posts.filter(item=>String(item.key||'').startsWith('discovery_')).length,2,'nothing more: the old gate of the drained series never reopens the incident');
 arrange({records:()=>({published:G2,continuation:{stage:'paused',reason:'epg_committed',at:at(T0+9*H),hopId:null,remainingChunks:12,nextCatchUpAt:null,retryAt:null,programmeRunId:G2}})});
 clock.now=T0+9*H+5*MIN;await W.M.run(env,{now:clock.now});
 const doc=bucket.records.get('monitor/state.json');
 assert.deepEqual([doc.streams.find(item=>item.stream==='discovery').facts.queueState,doc.streams.find(item=>item.stream==='discovery').state],['backlog','healthy'],'a fresh new queue is work, not an incident');
 assert.equal(W.posts.filter(item=>String(item.key||'').startsWith('discovery_')).length,2);
}

// 9. Pure table: the classifier never turns a missing, foreign or partial fact into an empty queue, and a proof does not expire.
{
 const state=W.call('discoveryQueueState');
 const evidence=(records,extra={})=>({published:G1,authority:{state:'r2'},records,unavailable:[],pause:null,...extra});
 const base=drainedRecords();
 assert.equal(state(evidence(base),T0+30*24*H).state,'empty','a month later the same proof is still empty');
 assert.equal(state(evidence({...base,workflow:{...base.workflow,programmeRunId:G2}}),T0).reason,'drain_unconfirmed','an executor record of another generation proves nothing');
 assert.equal(state(evidence({...base,status:undefined}),T0).reason,'no_status');
 assert.equal(state(evidence({...base,status:{...base.status,programmeRunId:G2}}),T0).reason,'status_foreign');
 assert.equal(state(evidence({...base,status:{...base.status,error:'tmdb_unavailable'}}),T0).state,'unknown','an error reading is never zero');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,remainingChunks:1}}),T0).state,'backlog','a chunk still owed is work');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,reason:'programme_changed'}}),T0).reason,'generation_handoff');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,reason:'idle'}}),T0).reason,'awaiting_epg_discovery');
 assert.equal(state(evidence(base,{unavailable:['status']}),T0).reason,'records_unreadable');
 assert.equal(state(evidence(base,{published:null}),T0).reason,'no_publication');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,stage:'complete',reason:null}}),T0).proof,'complete','a complete continuation with a zero reading of its generation');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,stage:'complete',reason:null},status:{...base.status,remaining:null}}),T0).state,'unknown','a complete continuation without a zero reading is unconfirmed');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,stage:'running'}}),T0).reason,'lease_unread','a running record whose lease was not read');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,stage:'running'},lease:{id:'x',expiresAt:T0-1}}),T0).reason,'orphaned');
 assert.equal(state(evidence({...base,lease:{id:'x',expiresAt:T0+1000}}),T0).state,'empty','a live lease (the EPG publication may hold it) never outweighs the proof');
 assert.equal(state(evidence({...base,continuation:{...base.continuation,reason:'missing_secret'}}),T0).reason,'missing_secret');
 assert.ok(W.call('DISCOVERY_QUEUE_STATES').includes(state(evidence(base),T0).state));
}

console.log('Discovery queue state (AIR-598): one classification across the classifier, footer, operational status, admin data health, Monitor and Events; the 23-24 Nov drained series is empty everywhere, the new generation, a real stall, waits, a live writer, the EPG pause, unconfirmed, legacy and unreadable states stay distinct; reads write nothing; one recovery');
