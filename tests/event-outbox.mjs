// AIR-416 (ADR 0107): delivery of a prediction run's stop events to the Events Log is owned by the Predictions writer. No read delivers anything;
// the next authorized start does, under the writer lease. Since ADR 0162 the start is batch runner v2 (D1 prediction authority, as production runs it); a v2
// run has one terminal Event and no start Event (ADR 0146), so start records exist only as stored legacy v5 records, which the delivery still handles.
// Covered here: an empty outbox costs no write, a failed stop event delivered by the next start without a page visit, a crash between the durable record and
// the journal, duplicate and concurrent deliveries, a partial success, bounded retries ending in a visible quarantine that keeps the record, a failing index
// write that does not block a run, a superseded stop, index entries that are not event records, and a full page of quarantined entries that must not starve
// newer events. Local stand-ins only; nothing here calls Cloudflare or production.
import vm from 'node:vm';import assert from 'node:assert/strict';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
const w=await flowWorld({films:6});assert.equal((await w.api('queue/reconcile',{})).status,200);
const records=w.records,env=w.env,ctx=w.ctx,logs=w.logs;ctx.env=env;
const writes=[],gets=[];
// `blocked(key)` makes a put of that key fail: the way a journal or index outage is simulated.
let blocked=()=>false;
{const bucket=env.BUCKET,get=bucket.get,put=bucket.put;
 bucket.get=async key=>{gets.push(key);return get.call(bucket,key);};
 bucket.put=async(key,value,options)=>{if(blocked(key))throw new Error('storage outage');const saved=await put.call(bucket,key,value,options);if(saved)writes.push(key);return saved;};
 bucket.delete=async key=>{records.delete(key);writes.push('delete:'+key);};
 bucket.list=async({prefix=''})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false});}
const call=code=>vm.runInContext(code,ctx);
const api=async(path,body,method='POST')=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const readEvents=()=>ctx.worker.fetch(new Request('https://site.example/api/events'),env);
const OUTBOX=call('EVENT_OUTBOX_KEY'),MAX=call('EVENT_OUTBOX_ATTEMPTS'),LIMIT=call('EVENT_OUTBOX_LIMIT'),START=call('START_EVENT_PREFIX'),STOP=call('STOP_EVENT_PREFIX');
const now=Date.now();
const journal=()=>[...records].filter(([key])=>key.startsWith('events/items/')).map(([,value])=>value);
const journalOf=id=>journal().filter(event=>event.id===id);
const outbox=()=>records.get(OUTBOX)?.pending||{};
// The report comes from the vm context: copied so it compares as a plain object.
const sweep=async()=>JSON.parse(JSON.stringify(await call('deliverPendingEvents(env)')));
const status=async()=>(await api('status',undefined,'GET')).data.eventOutbox;
const startRun=async()=>{const data=(await api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize:1})).data;assert.equal(data.status,'running',JSON.stringify(data).slice(0,200));return data.runId;};
const stopRun=(runId,reason='quota')=>api('complete',{runId,reason});
const expireLease=()=>{const doc=JSON.parse(sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0].d);doc.expiresAt=1;sql(w.file,"UPDATE prediction_lease SET expires_at=1, document_json='"+JSON.stringify(doc).replace(/'/g,"''")+"' WHERE name='runner'");};

// 1. Nothing pending: a start reads the index and the latest run's records and writes nothing for the outbox. A v2 run has no start Event; its stop Event is
// in the journal at once.
let run=await startRun();
assert.equal(records.has(OUTBOX),false,'an empty outbox is never written');
assert.equal(journalOf('prediction-start-'+run).length,0,'a batch v2 run has no start Event (ADR 0146)');
assert.deepEqual(await status(),{pending:0,quarantined:0,oldestSince:null,maxAttempts:MAX});
await stopRun(run);
assert.equal(journalOf('enrichment-'+run).length,1,'the stop Event is in the journal at once');
assert.equal(records.has(OUTBOX),false);
assert.deepEqual(await sweep(),{checked:0,delivered:0,failed:0,quarantined:0});

// 2. The journal is down while a run stops: the stop is recorded and noted, and no read delivers it. The next start delivers it without a page visit.
run=await startRun();
blocked=key=>key.startsWith('events/items/');
await stopRun(run);
blocked=()=>false;
assert.equal(journalOf('enrichment-'+run).length,0);
assert.equal(records.get(STOP+run+'.json').delivered,undefined,'the durable record of the event exists, undelivered');
assert.deepEqual(Object.keys(outbox()),[STOP+run+'.json']);
{const before=writes.length;for(let read=0;read<3;read++)assert.equal((await readEvents()).status,200);const seen=await status();assert.equal(seen.pending,1);assert.equal(typeof seen.oldestSince,'string');assert.equal(writes.length,before,'reads write nothing');assert.equal(journalOf('enrichment-'+run).length,0);}
const second=await startRun();
assert.equal(journalOf('enrichment-'+run).length,1,'the next start delivered the earlier stop event, with nobody opening the page');
assert.equal(records.get(STOP+run+'.json').delivered,true);
assert.deepEqual(outbox(),{},'a delivered entry leaves the index');
assert.match(logs.join('\n'),/"event":"prediction_event_outbox","checked":1,"delivered":1,"failed":0/);
await stopRun(second);

// 3. Crash between the durable record and the journal: the process ends after the stop record is stored and before anything else. Nothing noted it; the
// next start finds it through the latest run. The run record is completed by the same idempotent stop path.
run=await startRun();
{const stopKey=STOP+run+'.json',event={id:'enrichment-'+run,type:'enrichment',runId:run,at:new Date(now+1000).toISOString(),queueSchemaVersion:6,stage:'partial',title:'Прогнозы приостановлены',reason:'api_error',stopReason:'api_error',added:0,updated:0,failed:0,hotRemaining:3,coldRemaining:0,delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot:{}};
 records.set(stopKey,{event});
 expireLease();
 assert.equal(journalOf(event.id).length,0);
 const next=await startRun();
 assert.equal(journalOf(event.id).length,1,'the interrupted stop was delivered by the next start');
 assert.equal(records.get(stopKey).delivered,true);
 assert.deepEqual(outbox(),{});
 // 4. Duplicates: the same record delivered again, and twice at once, stays one journal item with the same key.
 records.get(stopKey).delivered=false;
 await Promise.all([sweep(),sweep(),call('flushStopEvent(env,'+JSON.stringify({event})+','+JSON.stringify(stopKey)+')')]);
 assert.equal(journalOf(event.id).length,1,'concurrent deliveries of one event are one journal item');
 assert.equal([...records.keys()].filter(key=>key.startsWith('events/items/')&&key.endsWith('-'+event.id+'.json')).length,1);
 await stopRun(next);
}

// 5. Partial success: two failed stop events, the journal accepts one of them. The delivered one leaves the index, the other stays with one more attempt.
blocked=key=>key.startsWith('events/items/');
const first=await startRun();await stopRun(first,'api_error');
const other=await startRun();await stopRun(other,'api_error');
blocked=()=>false;
{const keys=Object.keys(outbox()).sort();assert.deepEqual(keys,[STOP+first+'.json',STOP+other+'.json'].sort(),'both stop events are pending');}
const attemptsBefore=outbox()[STOP+first+'.json'].attempts;
blocked=key=>key.startsWith('events/items/')&&key.includes('enrichment-'+first);
{const report=await sweep();assert.deepEqual(report,{checked:2,delivered:1,failed:1,quarantined:0});}
assert.deepEqual(Object.keys(outbox()),[STOP+first+'.json']);
assert.equal(outbox()[STOP+first+'.json'].attempts,attemptsBefore+1);
assert.equal(journalOf('enrichment-'+other).length,1);

// 6. Bounded retries: the journal keeps refusing this event. Each sweep is one attempt; after the limit the entry is quarantined, is not retried, stays
// visible, and its record is still stored.
for(let attempt=attemptsBefore+2;attempt<MAX;attempt++){await sweep();assert.equal(outbox()[STOP+first+'.json'].attempts,attempt);assert.equal(outbox()[STOP+first+'.json'].quarantined,false);}
{const report=await sweep();assert.equal(report.quarantined,1);assert.equal(outbox()[STOP+first+'.json'].attempts,MAX);assert.equal(outbox()[STOP+first+'.json'].quarantined,true);}
{const before=gets.length,report=await sweep();assert.deepEqual(report,{checked:0,delivered:0,failed:0,quarantined:1});assert.equal(gets.slice(before).includes(STOP+first+'.json'),false,'a quarantined entry is not read or retried');}
assert.deepEqual({...(await status()),oldestSince:null},{pending:0,quarantined:1,oldestSince:null,maxAttempts:MAX});
assert.equal(records.get(STOP+first+'.json').event.id,'enrichment-'+first,'the event itself is not lost');
// a run still starts and stops normally beside a quarantined entry
blocked=()=>false;
run=await startRun();await stopRun(run);
assert.equal(outbox()[STOP+first+'.json'].quarantined,true);
assert.equal(journalOf('enrichment-'+first).length,0);

// 7. The index itself cannot be written: the run is not blocked, and the latest-run check still delivers on the next start.
records.delete(OUTBOX);
run=await startRun();
blocked=key=>key===OUTBOX||key.startsWith('events/items/');
await stopRun(run);
assert.equal(records.has(OUTBOX),false,'the note failed');
blocked=()=>false;
{const next=await startRun();assert.equal(journalOf('enrichment-'+run).length,1,'found through the latest run, without the index');await stopRun(next);}

// 8. A stop that a later run superseded is settled without a journal item.
{const id='superseded-run',key=STOP+id+'.json';
 const stored={runId:id,protocol:'batch_v2',status:'interrupted',recoveredByRunId:'later-run',createdAt:new Date(now).toISOString(),selectedIds:[],results:{},failures:{}};
 sql(w.file,"INSERT INTO prediction_run (run_id, latest, updated_at, document_json) VALUES ('"+id+"', 0, '"+stored.createdAt+"', '"+JSON.stringify(stored).replace(/'/g,"''")+"')");
 records.set(key,{event:{id:'enrichment-'+id,type:'enrichment',runId:id,at:new Date(now).toISOString(),reason:'lease_expired'}});
 records.set(OUTBOX,{pending:{[key]:{since:new Date(now).toISOString(),attempts:0,lastAttemptAt:null,quarantined:false}}});
 const report=await sweep();assert.equal(report.failed,0);
 assert.equal(journalOf('enrichment-'+id).length,0);assert.equal(records.get(key).superseded,true);assert.deepEqual(outbox(),{});
}

// 9. The index is data: an entry that is not an event record is never read or written, a record that no longer exists leaves the index, and one sweep is bounded.
{const ghost=START+'ghost.json',many=Object.fromEntries(Array.from({length:LIMIT+5},(_,index)=>[START+'bulk-'+String(index).padStart(2,'0')+'.json',{since:new Date(now+index).toISOString(),attempts:0,lastAttemptAt:null,quarantined:false}]));
 records.set(OUTBOX,{pending:{'programme.json':{since:'x',attempts:0},'enrichment/profile/current.json':{since:'x',attempts:0},[ghost]:{since:new Date(now-1).toISOString(),attempts:0,lastAttemptAt:null,quarantined:false},...many}});
 const programme=JSON.stringify(records.get('programme.json')),before=gets.length;
 await sweep();
 const read=gets.slice(before);
 assert.equal(read.includes('programme.json'),false);assert.equal(JSON.stringify(records.get('programme.json')),programme);
 assert.equal(outbox()[ghost],undefined,'an entry whose record is gone leaves the index');
 assert.ok(read.filter(key=>key.startsWith(START+'bulk-')).length<=LIMIT,'one sweep looks at a bounded number of entries');
 assert.ok(Object.keys(outbox()).some(key=>key.startsWith(START+'bulk-')),'the rest waits for the next start');
 const seen=await status();assert.equal(seen.pending,Object.keys(outbox()).filter(key=>key.startsWith(START)||key.startsWith(STOP)).length,'the status counts event entries only');
}

// 10. Review of PR #492: quarantined entries never take a delivery slot. A full page (and more) of OLDER quarantined entries, one newer pending event in the
// index and an interrupted event of the latest run that nothing noted: ONE authorized start delivers both, the old entries stay quarantined and stored, nothing
// is duplicated, and a start still looks at no more than its limit of actionable entries.
{const iso=offset=>new Date(now+offset).toISOString(),entry=(offset,extra={})=>({since:iso(offset),attempts:0,lastAttemptAt:null,quarantined:false,...extra});
 const eventOf=(id,offset)=>({id:'prediction-start-'+id,type:'enrichment',at:iso(offset),startedAt:iso(offset),stage:'started',runState:'started',title:'Прогнозы запущены',queueSchemaVersion:6,delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot:{}});
 const quarantined=Array.from({length:LIMIT+7},(_,index)=>'old-'+String(index).padStart(2,'0'));
 for(const [index,id] of quarantined.entries())records.set(START+id+'.json',{event:eventOf(id,-100000+index)});
 const pendingId='newer-pending';records.set(START+pendingId+'.json',{event:eventOf(pendingId,5000)});
 records.set(OUTBOX,{pending:{...Object.fromEntries(quarantined.map((id,index)=>[START+id+'.json',entry(-100000+index,{attempts:MAX,quarantined:true,lastAttemptAt:iso(-50000)})])),[START+pendingId+'.json']:entry(5000)}});
 // the latest run: its stop event was recorded and never delivered or noted (the process ended in between)
 const live=await startRun();await stopRun(live);
 records.get(STOP+live+'.json').delivered=false;for(const key of [...records.keys()])if(key.startsWith('events/items/')&&key.endsWith('-enrichment-'+live+'.json'))records.delete(key);
 assert.equal(outbox()[STOP+live+'.json'],undefined,'the latest run\'s event is in no index');
 assert.equal((await status()).quarantined,quarantined.length);
 const before=gets.length,next=await startRun();
 const read=gets.slice(before);
 assert.equal(journalOf('prediction-start-'+pendingId).length,1,'the newer pending event was delivered by one start, behind more than a page of quarantined entries');
 assert.equal(journalOf('enrichment-'+live).length,1,'the latest run\'s unnoted stop event was delivered by the same start');
 assert.equal(records.get(START+pendingId+'.json').delivered,true);
 assert.equal(outbox()[START+pendingId+'.json'],undefined);
 for(const id of quarantined){assert.equal(outbox()[START+id+'.json'].quarantined,true,id+' stays quarantined');assert.equal(outbox()[START+id+'.json'].attempts,MAX);assert.equal(records.get(START+id+'.json').event.id,'prediction-start-'+id,'its record is kept');assert.equal(journalOf('prediction-start-'+id).length,0);assert.equal(read.includes(START+id+'.json'),false,'a quarantined record is not even read');}
 const seen=await status();assert.equal(seen.quarantined,quarantined.length);assert.equal(seen.pending,0);
 // repeated starts neither duplicate what was delivered nor touch the quarantined entries
 await stopRun(next);const again=await startRun();await stopRun(again);
 assert.equal(journalOf('prediction-start-'+pendingId).length,1);assert.equal(journalOf('enrichment-'+live).length,1);
 assert.equal(Object.values(outbox()).filter(item=>item.quarantined).length,quarantined.length);
 // the budget of one start: more actionable entries than the limit, still behind the quarantined page; the oldest go first and the rest waits
 const bulk=Array.from({length:LIMIT+4},(_,index)=>'wait-'+String(index).padStart(2,'0'));
 for(const [index,id] of bulk.entries())records.set(START+id+'.json',{event:eventOf(id,20000+index)});
 records.set(OUTBOX,{pending:{...outbox(),...Object.fromEntries(bulk.map((id,index)=>[START+id+'.json',entry(20000+index)]))}});
 const mark=gets.length,report=await sweep();
 const looked=gets.slice(mark).filter(key=>key.startsWith(START+'wait-'));
 assert.ok(looked.length<=LIMIT,'one start reads at most its limit of actionable entries, saw '+looked.length);
 assert.equal(report.delivered,looked.length);assert.equal(report.quarantined,quarantined.length);
 assert.equal(journalOf('prediction-start-'+bulk[0]).length,1,'oldest first');
 assert.equal(journalOf('prediction-start-'+bulk.at(-1)).length,0,'the newest waits for the next start');
 await sweep();
 for(const id of bulk)assert.equal(journalOf('prediction-start-'+id).length,1,id+' delivered exactly once after the second start');
 assert.equal(Object.keys(outbox()).filter(key=>key.startsWith(START+'wait-')).length,0);
}

// The journal read is pure whatever is pending.
{const before=writes.length;for(let read=0;read<3;read++)await readEvents();await api('status',undefined,'GET');assert.equal(writes.length,before);}
console.log('Event outbox (batch v2): no write when nothing is pending, no start Event, a failed stop event delivered by the next start, crash between record and journal, duplicates and concurrent deliveries, partial success, bounded retries with a visible quarantine, a failing index, a superseded stop, non-event index entries and a page of quarantined entries that starves nothing passed');
