// AIR-438. `next` and `submit` log one sanitized `prediction_step_timing` line that splits their wall time by what they touched. The
// instrumentation is inert: the same scripted run with it, without it, and with a logger that throws leaves the same answers and the same
// stored records. Calls in parallel are not summed as sequential, the line holds no id, key, statement or body, and a failure of any timing
// code is swallowed.
import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import os from 'node:os';import path from 'node:path';

function world({timing=true,logger='capture'}={}){
 const records=new Map(),etags=new Map();let revision=0;const logs=[],calls={get:0,put:0,head:0,list:0};
 const env={BUCKET:{
  async get(key){calls.get++;return records.has(key)?{etag:etags.get(key),size:JSON.stringify(records.get(key)).length,json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value,options={}){calls.put++;const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
  async head(key){calls.head++;return records.has(key)?{etag:etags.get(key)}:null;},
  list:async()=>{calls.list++;return {objects:[],truncated:false};}
 }};
 const consoleStub={log:(...a)=>{if(logger==='throw')throw new Error('logger down');logs.push(a.join(' '));},info:()=>{},error:()=>{},warn:()=>{}};
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console:consoleStub});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
 if(!timing)vm.runInContext('createStepTimer=()=>{throw new Error("timing off");}',ctx);
 ctx.env=env;
 const call=code=>vm.runInContext(code,ctx);
 const api=async(route,body,method='POST')=>{const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:r.status,data:await r.json()};};
 return {records,etags,env,ctx,call,api,logs,calls};
}
const now=Date.now(),film=id=>({id,title:id,original:id,year:2020,tmdbId:id.replace(/\D/g,'')||id,genres:[],actors:[],directors:[],shows:[{start:now}]});
function seed(w,count=30){
 const execution=Object.fromEntries(Object.entries(w.call('EXECUTION')).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
 w.fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['мрачный','напряжённый'],strengths:['A causal puzzle'],risks:['Mixed payoff'],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
 w.prediction={predictedRating:3.5,probability4Plus:.45,confidence:'medium',matchSignals:['Investigation'],mainRisk:'Mixed payoff',moodLabels:['мрачный','напряжённый']};
 w.records.set('enrichment/profile/current.json',{version:1,profileHash:'p',profile:{ratingScale:'Half stars'}});w.records.set('sync.json',{runId:'test',stage:'complete'});
 const catalog={};for(let i=1;i<=count;i++)catalog['tmdb_'+(700+i)]=film('tmdb_'+(700+i));
 w.records.set('programme.json',{runId:'test',films:[]});w.records.set('epg/discovered-films.json',catalog);
}
// One start, then three next/submit pairs, one film per step as the MCP tools do. Returns the answers and the record state, both normalized.
async function script(w){
 seed(w);const answers=[];
 const start=await w.api('start',{scope:'watchlist_all',capacity:{remainingPercent:100}});answers.push(start);w.startCalls={...w.calls};
 for(let i=0;i<3;i++){
  const next=await w.api('next',{runId:start.data.runId,batchSize:1});answers.push(next);
  const submit=await w.api('submit',{runId:start.data.runId,items:[{filmId:next.data.items[0].filmId,fingerprint:w.fingerprint,prediction:w.prediction}]});answers.push(submit);
 }
 return {answers,start:start.data};
}
const normalize=value=>JSON.parse(JSON.stringify(value).replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'<time>').replace(/[0-9a-f]{64}/g,'<sha>').replace(/\b\d{13}-/g,'<ts>-').replace(/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<uuid>').replace(/"(expiresAt|heartbeatAt|attemptedAt|completedAt|startedAt|generatedAt|elapsedMs|at|firstNextAt|firstSubmitAt|refreshedAt|updatedAt|retryAt|lastCheckAt)":\d+/g,'"$1":0').replace(/"([A-Za-z]*(?:Ms|At))":\d+/g,'"$1":0'));
const lines=w=>w.logs.filter(l=>l.includes('prediction_step_timing')).map(l=>JSON.parse(l));

// 1. Every next and submit logs one line, and its numbers are consistent with what the storage received.
const on=world();const ran=await script(on);
const timing=lines(on);
assert.equal(timing.length,6,'one line per next and per submit, none for start: '+timing.map(l=>l.step));
assert.deepEqual(timing.map(l=>l.step),['next','submit','next','submit','next','submit']);
for(const line of timing){
 assert.equal(line.event,'prediction_step_timing');
 assert.equal(line.status,200);
 assert.equal(line.runId,ran.start.runId);
 assert.ok(typeof line.requestId==='string'&&line.requestId.length>0);
 for(const key of ['wallMs','busyMs','overlapMs','unattributedMs'])assert.ok(Number.isFinite(line[key])&&line[key]>=0,key);
 assert.ok(line.busyMs<=line.wallMs+1,'busy time cannot exceed the wall time');
 assert.ok(Math.abs(line.unattributedMs-(line.wallMs-line.busyMs))<=1,'unattributed is the wall time minus the busy union');
 assert.ok(line.r2.n>0);assert.equal(line.d1.n,0,'no D1 binding in this world');
 assert.ok(line.classes['r2:lease'],'the lease is a class');assert.ok(line.classes['r2:run'],'the run record is a class');
 assert.ok(line.classes['r2:view_index']||line.classes['r2:queue'],'the queue or the view index is read');
 assert.equal(Object.values(line.classes).reduce((n,c)=>n+c.n,0),line.r2.n+line.d1.n,'classes add up to the calls');
}
const nextLine=timing[0],submitLine=timing[1];
assert.equal(nextLine.notes.items,1);assert.ok(nextLine.notes.selected>=1);assert.ok(nextLine.notes.batchSize>=1);
assert.equal(nextLine.notes.fingerprintAndPrediction+nextLine.notes.predictionOnly,nextLine.notes.items);
assert.equal(submitLine.notes.bodyItems,1);assert.equal(submitLine.notes.created+submitLine.notes.recalculated+submitLine.notes.alreadyCurrent,1);
assert.ok(submitLine.classes['r2:film_state']&&submitLine.r2.bytesIn>0,'a submit writes film state');
// The storage's own counters agree with the lines: every R2 call the steps made is counted once (body reads are separate operations and are
// not storage calls), and the calls of the start, which is not a timed step, are not in them.
const callsOf=line=>Object.values(line.classes).reduce((n,c)=>n+Object.entries(c.ops).filter(([op])=>op!=='body').reduce((m,[,k])=>m+k,0),0);
const afterStart=on.startCalls,total=on.calls.get+on.calls.put+on.calls.head+on.calls.list,beforeSteps=afterStart.get+afterStart.put+afterStart.head+afterStart.list;
assert.equal(timing.reduce((n,l)=>n+callsOf(l),0),total-beforeSteps,'the lines count exactly the calls the steps made');
assert.ok(beforeSteps>0,'the start also reads and writes, untimed');
// body reads are their own timed operations, so a get with a body counts twice (answer, then body) and says so
assert.ok(Object.values(nextLine.classes).some(c=>c.ops.body>0),'the body reads are timed');

// 2. Nothing identifying leaves the line: no film id, no key, no SQL, no body, no model text.
const text=on.logs.filter(l=>l.includes('prediction_step_timing')).join('\n');
for(const leak of ['tmdb_7','enrichment/','films/','programme.json','Investigation','Mixed payoff','мрачный','SELECT','INSERT','profileHash'])assert.ok(!text.includes(leak),'leaks '+leak);
// the vocabulary of classes is closed
assert.ok(timing.every(l=>Object.keys(l.classes).every(label=>/^(r2:[a-z_]{1,20}|d1:[a-z0-9_]{1,60})$/.test(label))));

// 3. Inert: with the timing off, and with a logger that throws, the answers and the stored records are the same.
const off=world({timing:false});const offRan=await script(off);
assert.equal(lines(off).length,0,'no line without the timer');
const loud=world({logger:'throw'});const loudRan=await script(loud);
const state=w=>normalize([...w.records.entries()]).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);
assert.deepEqual(normalize(offRan.answers),normalize(ran.answers),'answers are those of an uninstrumented run');
assert.deepEqual(normalize(loudRan.answers),normalize(ran.answers),'a throwing logger changes no answer');
assert.deepEqual(state(off),state(on),'the stored records are those of an uninstrumented run');
assert.deepEqual(state(loud),state(on),'a throwing logger changes no record');
assert.deepEqual(off.calls,on.calls,'the same R2 calls are made, none added or removed');

// 4. The timer: parallel calls are a union, not a sum; an overflow is flagged; a hostile note is dropped.
{
 const w=world();let t=0;w.ctx.fakeNow=()=>t;
 w.call('globalThis.timer=createStepTimer(fakeNow)');
 t=0;w.call('timer.record("r2","film_state","get",0,100,{bytesOut:10})');
 w.call('timer.record("r2","film_state","get",20,120,{bytesOut:10})');w.call('timer.record("d1","queue","all",300,350,{rowsRead:5})');
 t=400;w.ctx.fields={items:3,selected:12,filmId:'tmdb_9',bogus:-1,pending:'x',batchSize:1.5};w.call('timer.note(fields)');
 const summary=JSON.parse(JSON.stringify(w.call('timer.summary("next",{})')));
 assert.equal(summary.wallMs,400);assert.equal(summary.busyMs,170,'the two overlapping reads are one interval of 120 plus 50');
 assert.equal(summary.overlapMs,80);assert.equal(summary.unattributedMs,230);
 assert.equal(summary.r2.busyMs,120);assert.equal(summary.d1.busyMs,50);assert.equal(summary.r2.ms,200);assert.equal(summary.d1.rowsRead,5);
 assert.deepEqual(summary.notes,{items:3,selected:12},'only whitelisted non-negative integers survive');
 assert.equal(summary.classes['r2:film_state'].n,2);assert.equal(summary.classes['d1:queue'].n,1);
 w.call('for(let i=0;i<4100;i++)timer.record("r2","other","get",i,i+1)');
 assert.equal(JSON.parse(JSON.stringify(w.call('timer.summary("next",{})'))).truncated,true,'an overflow of the interval list is flagged');
}

// 5. The class of an R2 key and of a statement comes from a closed vocabulary.
{
 const w=world();const cls=key=>{w.ctx.k=key;return w.call('stepKeyClass(k)');};
 assert.equal(cls('enrichment/profile/current.json'),'profile');assert.equal(cls('enrichment/runner-lease.json'),'lease');assert.equal(cls('enrichment/writer-lease.json'),'lease');
 assert.equal(cls('enrichment/runs/abc.json'),'run');assert.equal(cls('enrichment/latest-run.json'),'run_latest');assert.equal(cls('enrichment/sources/abc.json'),'source');
 assert.equal(cls('enrichment/view-index.json'),'view_index');assert.equal(cls('enrichment/prediction-queue.json'),'queue');assert.equal(cls('programme.json'),'programme');
 assert.equal(cls('enrichment/films/tmdb_1/fingerprint.json'),'film_state');assert.equal(cls('enrichment/films/tmdb_1/predictions.json'),'film_state');assert.equal(cls('enrichment/films/tmdb_1/versions/x.json'),'film_other');
 assert.equal(cls('something/else.json'),'other');assert.equal(cls(undefined),'other');
 const sql=text=>{w.ctx.q=text;return w.call('stepSqlClass(q)');};
 assert.equal(sql('SELECT value FROM prediction_queue WHERE id=?'),'prediction_queue');assert.equal(sql('INSERT INTO prediction_pointer(a) VALUES(?)'),'prediction_pointer');
 assert.equal(sql('UPDATE "Weird" SET a=1'),'weird');assert.equal(sql('PRAGMA foreign_keys'),'other');assert.equal(sql(null),'other');
}

// 6. The D1 wrapper forwards every call unchanged and counts it: results, errors, a batch of wrapped statements, a session.
{
 const w=world();const file=path.join(fs.mkdtempSync(path.join(os.tmpdir(),'step-timing-')),'d1.sqlite');
 const bare=d1Standin(file);
 const prepare=sql=>bare.prepare(sql);
 await bare.batch([prepare('CREATE TABLE prediction_queue(id INTEGER PRIMARY KEY, v TEXT)').bind()]);
 const metaOf=get=>({get text(){return get().text;},first:async()=>(await get().first()),all:async()=>({...(await get().all()),meta:{rows_read:7,rows_written:0}}),run:async()=>({...(await get().run()),meta:{rows_read:0,rows_written:1}})});
 w.ctx.rawDb={prepare:sql=>{const s=bare.prepare(sql),unbound=metaOf(()=>s.bind());unbound.bind=(...p)=>metaOf(()=>s.bind(...p));return unbound;},batch:statements=>bare.batch(statements)};
 w.call('globalThis.timer=createStepTimer();globalThis.timedDb=timedDatabase(rawDb,timer)');
 const db=w.ctx.timedDb;
 const insert=db.prepare('INSERT INTO prediction_queue(id,v) VALUES(?,?)');
 assert.equal((await insert.bind(1,'a').run()).meta.rows_written,1);
 await db.batch([insert.bind(2,'b'),insert.bind(3,'c')]);
 const all=await db.prepare('SELECT id,v FROM prediction_queue ORDER BY id').all();
 assert.deepEqual(all.results.map(r=>r.v),['a','b','c'],'the batch of wrapped statements was applied');
 await assert.rejects(()=>db.batch([insert.bind(4,'d'),insert.bind(1,'dup')]),/UNIQUE|constraint/i,'a failing batch fails as before');
 assert.deepEqual((await db.prepare('SELECT COUNT(*) AS n FROM prediction_queue').all()).results,[{n:3}],'and rolled back as before');
 const summary=JSON.parse(JSON.stringify(w.call('timer.summary("next",{})')));
 assert.equal(summary.d1.batches,2);assert.equal(summary.d1.rowsWritten,1);assert.ok(summary.d1.rowsRead>=14);
 assert.ok(summary.classes['d1:prediction_queue'].n>=3);assert.ok(summary.classes['d1:batch'].n===2);
 assert.ok(!JSON.stringify(summary).includes('INSERT')&&!JSON.stringify(summary).includes('SELECT'));
}

// 7. The bucket wrapper forwards a failing call unchanged and still counts it.
{
 const w=world();w.ctx.failing={async get(){throw new Error('R2 down');},async put(){return null;},async head(){return null;},async delete(){},async list(){return {objects:[]};},extra:7,method(){return this.extra;}};
 w.call('globalThis.timer=createStepTimer();globalThis.timedB=timedBucket(failing,timer)');
 await assert.rejects(()=>w.ctx.timedB.get('enrichment/runs/x.json'),/R2 down/);
 assert.equal(await w.ctx.timedB.put('k','{}'),null);assert.equal(w.ctx.timedB.extra,7);assert.equal(w.ctx.timedB.method(),7,'other members are the bucket own');
 const summary=JSON.parse(JSON.stringify(w.call('timer.summary("submit",{})')));
 assert.equal(summary.r2.n,2);assert.equal(summary.classes['r2:run'].n,1);
}

// 8. The spread of the environment that some routes make keeps the timed bucket and the timer.
{
 const w=world();w.call('globalThis.timer=createStepTimer();globalThis.timedEnv=stepTimedEnv({...env,OTHER:1},timer)');
 const spread=w.call('({...timedEnv,epgPin:{programmeRunId:"x"}})');
 assert.equal(spread.OTHER,1);assert.ok(spread.BUCKET!==w.env.BUCKET,'the timed bucket survives a spread');
 w.ctx.spread=spread;w.call('noteStep(spread,()=>({items:2}))');assert.deepEqual(JSON.parse(JSON.stringify(w.call('timer.summary("next",{})'))).notes,{items:2});
}

// 9. Overhead: a timed call adds well under a millisecond to a call that takes none.
{
 const w=world();w.call('globalThis.timer=createStepTimer();globalThis.timedB=timedBucket(env.BUCKET,timer)');
 const bucket=w.ctx.timedB,plain=w.env.BUCKET;w.records.set('enrichment/view-index.json',{});
 const run=async b=>{const t0=process.hrtime.bigint();for(let i=0;i<5000;i++){const o=await b.get('enrichment/view-index.json');await o.json();}return Number(process.hrtime.bigint()-t0)/1e6/5000;};
 await run(plain);const base=await run(plain),timed=await run(bucket);
 assert.ok(timed-base<0.25,'added '+(timed-base).toFixed(4)+' ms per timed get+body (base '+base.toFixed(4)+' ms)');
 console.log(JSON.stringify({step_timing_overhead_ms_per_get:Number((timed-base).toFixed(4)),base_ms:Number(base.toFixed(4))}));
}
// 10. The D1 binding is wrapped through the prediction domain module, which is where the Worker reaches D1; without that module it is left as it is.
{
 const w=world();const fake={prepare:()=>({}),batch:async()=>[]};w.ctx.fakeDb=fake;
 w.call('globalThis.timer=createStepTimer()');
 assert.equal(w.call('stepTimedEnv({DB:fakeDb,BUCKET:env.BUCKET},timer).DB')===fake,true,'without the module the binding is the original');
 const {scoped}=await import('../scripts/bundle-scope.mjs');
 vm.runInContext(scoped('src/prediction-d1.js','PredictionD1'),w.ctx);
 assert.notEqual(w.call('stepTimedEnv({DB:fakeDb,BUCKET:env.BUCKET},timer).DB'),fake,'with the module the binding is the timed one');
 assert.equal(w.call('stepTimedEnv({BUCKET:env.BUCKET},timer).DB'),undefined,'no binding, no wrapper');
}
console.log('prediction step timing tests passed');
