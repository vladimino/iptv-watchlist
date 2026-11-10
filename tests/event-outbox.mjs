// AIR-416 (ADR 0107): delivery of a prediction run's start and stop events to the Events Log is owned by the Predictions writer. No read delivers anything;
// the next authorized start does, under the writer lease. Covered here: an empty outbox costs no write, a failed start event and a failed stop event are
// delivered by the next start without a page visit, a crash between the durable record and the journal, duplicate and concurrent deliveries, a partial
// success, bounded retries ending in a visible quarantine that keeps the record, a failing index write that does not block a run, a superseded stop,
// index entries that are not event records, and a full page of quarantined entries that must not starve newer events. In-memory storage; nothing here calls Cloudflare or production.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
const records=new Map(),etags=new Map();let revision=0,writes=[],gets=[];
// `blocked(key)` makes a put of that key fail: the way a journal or index outage is simulated.
let blocked=()=>false;
const env={BUCKET:{
 async get(key){gets.push(key);return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;if(blocked(key))throw new Error('storage outage');records.set(key,JSON.parse(value));etags.set(key,String(++revision));writes.push(key);return {etag:etags.get(key)};},
 async head(key){return records.has(key)?{etag:etags.get(key)}:null;},
 async delete(key){records.delete(key);writes.push('delete:'+key);},
 list:async({prefix=''})=>({objects:[...records.keys()].filter(key=>key.startsWith(prefix)).map(key=>({key})),truncated:false}),
}};
const logs=[];
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:{log:line=>logs.push(String(line)),error(){},warn(){}}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
ctx.env=env;const call=code=>vm.runInContext(code,ctx);
async function api(path,body,method='POST'){const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};}
const readEvents=()=>ctx.worker.fetch(new Request('https://site.example/api/events'),env);
const OUTBOX=call('EVENT_OUTBOX_KEY'),MAX=call('EVENT_OUTBOX_ATTEMPTS'),LIMIT=call('EVENT_OUTBOX_LIMIT'),START=call('START_EVENT_PREFIX'),STOP=call('STOP_EVENT_PREFIX');
const now=Date.now(),film=id=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,''),genres:[],actors:[],directors:[],shows:[{start:now}]});
records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});records.set('sync.json',{runId:'test',stage:'complete'});
records.set('programme.json',{runId:'test',films:[]});records.set('epg/discovered-films.json',Object.fromEntries([1,2,3].map(n=>['tmdb_'+n,film('tmdb_'+n)])));
const journal=()=>[...records].filter(([key])=>key.startsWith('events/items/')).map(([,value])=>value);
const journalOf=id=>journal().filter(event=>event.id===id);
const outbox=()=>records.get(OUTBOX)?.pending||{};
// The report comes from the vm context: copied so it compares as a plain object.
const sweep=async()=>JSON.parse(JSON.stringify(await call('deliverPendingEvents(env)')));
const status=async()=>(await api('status',undefined,'GET')).data.eventOutbox;
const startRun=async()=>{const data=(await api('start',{scope:'watchlist_all'})).data;assert.equal(data.status,'running',JSON.stringify(data).slice(0,200));return data.runId;};
const stopRun=(runId,reason='quota')=>api('complete',{runId,reason});

// 1. Nothing pending: a start reads the index and the latest run's records and writes nothing for the outbox.
let run=await startRun();
assert.equal(records.has(OUTBOX),false,'an empty outbox is never written');
assert.equal(journalOf('prediction-start-'+run).length,1,'the start event is in the journal at once');
assert.deepEqual(await status(),{pending:0,quarantined:0,oldestSince:null,maxAttempts:MAX});
await stopRun(run);
assert.equal(records.has(OUTBOX),false);
assert.deepEqual(await sweep(),{checked:0,delivered:0,failed:0,quarantined:0});

// 2. The journal is down while a run starts: the run still starts, its start event is recorded and noted, and no read delivers it.
blocked=key=>key.startsWith('events/items/');
run=await startRun();
blocked=()=>false;
assert.equal(journalOf('prediction-start-'+run).length,0);
assert.equal(records.get(START+run+'.json').delivered,undefined,'the durable record of the event exists, undelivered');
assert.deepEqual(Object.keys(outbox()),[START+run+'.json']);
{const before=writes.length;for(let read=0;read<3;read++)assert.equal((await readEvents()).status,200);const seen=await status();assert.equal(seen.pending,1);assert.equal(typeof seen.oldestSince,'string');assert.equal(writes.length,before,'reads write nothing');assert.equal(journalOf('prediction-start-'+run).length,0);}
// the stop of the same run goes through; the start event waits for the next start
await stopRun(run);
const second=await startRun();
assert.equal(journalOf('prediction-start-'+run).length,1,'the next start delivered the earlier start event, with nobody opening the page');
assert.equal(records.get(START+run+'.json').delivered,true);
assert.deepEqual(outbox(),{},'a delivered entry leaves the index');
assert.match(logs.join('\n'),/"event":"prediction_event_outbox","checked":1,"delivered":1,"failed":0/);
await stopRun(second);

// 3. Crash between the durable record and the journal: the process ends after the stop record is stored and before anything else. Nothing noted it; the
// next start finds it through the latest run. The run record is completed by the same idempotent stop path.
run=await startRun();
{const stopKey=STOP+run+'.json',event={id:'enrichment-'+run,type:'enrichment',runId:run,at:new Date(now+1000).toISOString(),queueSchemaVersion:6,stage:'partial',title:'Прогнозы приостановлены',reason:'api_error',stopReason:'api_error',added:0,updated:0,failed:0,hotRemaining:3,coldRemaining:0,delta:{added:0,updated:0,failed:0,predictionGain:0},snapshot:{}};
 records.set(stopKey,{event});etags.set(stopKey,String(++revision));
 records.get('enrichment/runner-lease.json').expiresAt=0;
 assert.equal(journalOf(event.id).length,0);
 const next=await startRun();
 assert.equal(journalOf(event.id).length,1,'the interrupted stop was delivered by the next start');
 assert.equal(records.get(stopKey).delivered,true);
 assert.equal(records.get('enrichment/runs/'+run+'.json').status,'partial','the stop is completed as a whole');
 assert.deepEqual(outbox(),{});
 // 4. Duplicates: the same record delivered again, and twice at once, stays one journal item with the same key.
 records.get(stopKey).delivered=false;
 await Promise.all([sweep(),sweep(),call('flushStopEvent(env,'+JSON.stringify({event})+','+JSON.stringify(stopKey)+')')]);
 assert.equal(journalOf(event.id).length,1,'concurrent deliveries of one event are one journal item');
 assert.equal(Object.keys(Object.fromEntries(records)).filter(key=>key.startsWith('events/items/')&&key.endsWith('-'+event.id+'.json')).length,1);
 await stopRun(next);
}

// 5. Partial success: two failed events, the journal accepts one of them. The delivered one leaves the index, the other stays with one more attempt.
blocked=key=>key.startsWith('events/items/');
const first=await startRun();await stopRun(first,'api_error');
blocked=()=>false;
{const keys=Object.keys(outbox()).sort();assert.deepEqual(keys,[START+first+'.json',STOP+first+'.json'].sort(),'both events of the run are pending');}
blocked=key=>key.startsWith('events/items/')&&key.includes('prediction-start-'+first);
{const report=await sweep();assert.deepEqual(report,{checked:2,delivered:1,failed:1,quarantined:0});}
assert.deepEqual(Object.keys(outbox()),[START+first+'.json']);
assert.equal(outbox()[START+first+'.json'].attempts,1);
assert.equal(journalOf('enrichment-'+first).length,1);

// 6. Bounded retries: the journal keeps refusing this event. Each start is one attempt; after the limit the entry is quarantined, is not retried, stays
// visible, and its record is still stored.
for(let attempt=2;attempt<MAX;attempt++){await sweep();assert.equal(outbox()[START+first+'.json'].attempts,attempt);assert.equal(outbox()[START+first+'.json'].quarantined,false);}
{const report=await sweep();assert.equal(report.quarantined,1);assert.equal(outbox()[START+first+'.json'].attempts,MAX);assert.equal(outbox()[START+first+'.json'].quarantined,true);}
{const before=gets.length,report=await sweep();assert.deepEqual(report,{checked:0,delivered:0,failed:0,quarantined:1});assert.equal(gets.slice(before).includes(START+first+'.json'),false,'a quarantined entry is not read or retried');}
assert.deepEqual({...(await status()),oldestSince:null},{pending:0,quarantined:1,oldestSince:null,maxAttempts:MAX});
assert.equal(records.get(START+first+'.json').event.id,'prediction-start-'+first,'the event itself is not lost');
// a run still starts and stops normally beside a quarantined entry
blocked=()=>false;
run=await startRun();await stopRun(run);
assert.equal(outbox()[START+first+'.json'].quarantined,true);
assert.equal(journalOf('prediction-start-'+first).length,0);

// 7. The index itself cannot be written: the run is not blocked, and the latest-run check still delivers on the next start.
records.delete(OUTBOX);
blocked=key=>key===OUTBOX||key.startsWith('events/items/');
run=await startRun();
assert.equal(records.has(OUTBOX),false,'the note failed');
blocked=()=>false;
await stopRun(run);
{const next=await startRun();assert.equal(journalOf('prediction-start-'+run).length,1,'found through the latest run, without the index');await stopRun(next);}

// 8. A stop that a later run superseded is settled without a journal item.
{const id='superseded-run',key=STOP+id+'.json';
 records.set('enrichment/runs/'+id+'.json',{runId:id,status:'interrupted',recoveredByRunId:'later-run',createdAt:new Date(now).toISOString(),selectedIds:[],results:{},failures:{}});
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
 // the latest run: its start event was recorded and never delivered or noted (the process ended in between)
 const live=await startRun();await stopRun(live);
 records.get(START+live+'.json').delivered=false;for(const key of [...records.keys()])if(key.startsWith('events/items/')&&key.includes('prediction-start-'+live))records.delete(key);
 assert.equal(outbox()[START+live+'.json'],undefined,'the latest run\'s event is in no index');
 assert.equal((await status()).quarantined,quarantined.length);
 const before=gets.length,next=await startRun();
 const read=gets.slice(before);
 assert.equal(journalOf('prediction-start-'+pendingId).length,1,'the newer pending event was delivered by one start, behind more than a page of quarantined entries');
 assert.equal(journalOf('prediction-start-'+live).length,1,'the latest run\'s unnoted event was delivered by the same start');
 assert.equal(records.get(START+pendingId+'.json').delivered,true);
 assert.equal(outbox()[START+pendingId+'.json'],undefined);
 for(const id of quarantined){assert.equal(outbox()[START+id+'.json'].quarantined,true,id+' stays quarantined');assert.equal(outbox()[START+id+'.json'].attempts,MAX);assert.equal(records.get(START+id+'.json').event.id,'prediction-start-'+id,'its record is kept');assert.equal(journalOf('prediction-start-'+id).length,0);assert.equal(read.includes(START+id+'.json'),false,'a quarantined record is not even read');}
 const seen=await status();assert.equal(seen.quarantined,quarantined.length);assert.equal(seen.pending,0);
 // repeated starts neither duplicate what was delivered nor touch the quarantined entries
 await stopRun(next);const again=await startRun();await stopRun(again);
 assert.equal(journalOf('prediction-start-'+pendingId).length,1);assert.equal(journalOf('prediction-start-'+live).length,1);
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
console.log('Event outbox: no write when nothing is pending, failed start and stop events delivered by the next start, crash between record and journal, duplicates and concurrent deliveries, partial success, bounded retries with a visible quarantine, a failing index, a superseded stop, non-event index entries and a page of quarantined entries that starves nothing passed');
