// Stop observability of batch runner v2 runs (ADR 0162; D1 prediction authority, as production runs it): a zero-success quota-blocked start, a quota stop
// before and after saved results with measured counts, silent item failures and overlapping triggers, immediate storage and lease-loss stops, idempotent
// completion and durable Event delivery after a journal outage. Events carry no secret or caller text. Local stand-ins only.
import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:5});const records=w.records,ctx=w.ctx,env=w.env;
let writes=[],eventsUnavailable=false,failKey=null;
{const bucket=env.BUCKET,put=bucket.put;bucket.put=async(key,value,options)=>{if(eventsUnavailable&&key.startsWith('events/items/'))throw new Error('Temporary events outage');if(failKey&&failKey.test(key)){failKey=null;throw new Error('Storage write interrupted');}const saved=await put.call(bucket,key,value,options);if(saved)writes.push(key);return saved;};
 bucket.list=async({prefix='',limit=1000}={})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).sort().slice(0,limit).map(key=>({key})),truncated:false});}
async function api(path,body,method='POST'){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};}
assert.equal((await api('queue/reconcile',{})).status,200);
const events=()=>[...records].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
const lease=()=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);
const setLease=edit=>{const doc=lease();edit(doc);sql(w.file,"UPDATE prediction_lease SET expires_at="+Number(doc.expiresAt)+", document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");};
const runRow=id=>JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+id+"'")[0].d);
const start=body=>api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:3,...body}).then(r=>r.data);
const item=id=>({filmId:id,fingerprint:w.fingerprint,prediction:w.prediction});

// A quota-blocked batch start is an idle outcome: it takes no lease, creates no run and writes no Event (a v2 run has one terminal Event, ADR 0146); the queue
// records the blocked attempt. Repeating the blocked trigger changes nothing.
let blocked=await start({capacity:{remainingPercent:0}});assert.equal(blocked.status,'blocked');assert.equal(blocked.reason,'quota');assert.equal(events().length,0);assert.equal(sql(w.file,'SELECT COUNT(*) AS n FROM prediction_run')[0].n,0);
await start({capacity:{remainingPercent:0}});assert.equal(events().length,0);
let run=await start();const before=events().length;assert.equal((await start()).status,'already_running');assert.equal(events().length,before);
// A quota stop before any saved result finalizes the run once, releases the lease and is idempotent.
let stop=(await api('complete',{runId:run.runId,reason:'quota'})).data;assert.equal(events().length,before+1);assert.equal(events().at(-1).added,0);assert.equal(runRow(run.runId).status,'partial');assert.equal(lease().expiresAt,0);
for(let i=0;i<3;i++)await api('complete',{runId:run.runId,reason:'quota'});assert.equal(events().length,before+1);
// A quota stop after saved results keeps the measured added and failed counts; an item failure is silent; caller text never reaches the Event.
run=await start();const ids=run.films.map(f=>f.filmId);const beforeItem=events().length;
const group=(await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[item(ids[0]),item(ids[1]),{filmId:ids[2],failure:{kind:'parse_error',reason:'json_unparseable'}}]})).data;
assert.deepEqual(group.results.map(r=>r.status),['created','created','validation_failure']);assert.equal(events().length,beforeItem,'saved results and an item failure write no Event');
stop=(await api('complete',{runId:run.runId,reason:'quota Bearer DO-NOT-STORE'})).data;assert.equal(stop.added,2);assert.equal(stop.failed,1);
const event=events().at(-1);assert.equal(event.hotRemaining,3);assert.equal(event.title,'Пакет прогнозов прерван');assert.equal(event.reason,'quota');
await api('complete',{runId:run.runId,reason:'quota'});assert.equal(events().length,beforeItem+1);
// A storage failure inside a batch submit blocks that film, commits nothing and writes no Event; the caller's storage_error completion writes the one final Event.
run=await start();failKey=/\/predictions\/versions\//;const beforeStorage=events().length;
stop=(await api('batch/submit',{runId:run.runId,epoch:run.lease.epoch,items:[item(run.films[0].filmId)]})).data;failKey=null;
assert.deepEqual(stop.results.map(r=>[r.status,r.reason]),[['blocked','storage_error']]);assert.equal(stop.committed,false);assert.equal(events().length,beforeStorage);assert.equal(runRow(run.runId).status,'running');
stop=(await api('complete',{runId:run.runId,reason:'storage_error'})).data;assert.equal(events().length,beforeStorage+1);assert.equal(events().at(-1).added,0);assert.equal(events().at(-1).reason,'storage_error');
// A lost lease is a visible stop and cannot release another owner's lease.
run=await start();setLease(doc=>{doc.runId='another-owner';});const beforeLease=events().length;
assert.equal((await api('heartbeat',{runId:run.runId})).status,409);assert.equal(events().length,beforeLease+1);assert.equal(events().at(-1).reason,'lease_lost');assert.equal(lease().runId,'another-owner');setLease(doc=>{doc.expiresAt=0;});
// An Event storage outage leaves a durable outbox. AIR-416: no read delivers it (status and the journal read are query-only and write nothing); the next authorized
// start does, under the writer lease, with the same id and time, so it cannot duplicate. The status read shows the pending entry until then.
run=await start();eventsUnavailable=true;stop=(await api('complete',{runId:run.runId,reason:'api_error'})).data;assert.equal(stop.eventPending,true);const pending=events().length;eventsUnavailable=false;
{const before=writes.length,d1=w.stats.writeBatches;let status=(await api('status',undefined,'GET')).data;assert.equal(events().length,pending,'status is query-only; it does not flush the stop outbox');assert.deepEqual({pending:status.eventOutbox.pending,quarantined:status.eventOutbox.quarantined},{pending:1,quarantined:0});
 for(let read=0;read<3;read++){const page=await ctx.worker.fetch(new Request('https://site.example/api/events'),env);assert.equal(page.status,200);}
 assert.equal(events().length,pending,'the journal read does not deliver the stop event, however often it is read');assert.equal(writes.length,before,'no read wrote anything');assert.equal(w.stats.writeBatches,d1);
 const next=await start();assert.equal(next.status,'running');assert.equal(events().length,pending+1,'the next start delivered the stop event without anyone opening the page');assert.equal(events().filter(event=>event.reason==='api_error').length,1);
 status=(await api('status',undefined,'GET')).data;assert.deepEqual({pending:status.eventOutbox.pending,quarantined:status.eventOutbox.quarantined},{pending:0,quarantined:0});
 await api('complete',{runId:run.runId,reason:'api_error'});assert.equal(events().filter(event=>event.reason==='api_error').length,1,'a late retry of the stopped run does not duplicate its event');
 await api('complete',{runId:next.runId,reason:'quota'});}
for(const event of events()){assert.equal(event.queueSchemaVersion,6);assert(event.delta);assert(event.snapshot?.coverage);assert(event.snapshot?.queue);assert(!/hash|token|Bearer|DO-NOT-STORE|prompt|stack/i.test(JSON.stringify(event)));}
console.log('Stop observability (batch v2): idle quota-blocked start, zero-success quota stop, measured counts, silent item failures/already_running, a blocked storage item and its explicit stop, an immediate lease-loss stop, idempotent complete/retry and durable Event delivery recovery passed');
