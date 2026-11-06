// AIR-361: one aggregated `ratings` event per terminal run in the shared Events Log. Id from the runId, time from the run's real
// end, data only from the committed terminal state, no per-film detail; delivery survives a crash between the D1 terminal commit
// and the R2 put without repeating Diary, without duplicates and with bounded retries.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPages,diaryPage,diaryRow,migrated,RUN,SEPARATE,H,MIN,DAY,eventKeyOf,plain,g} from './ratings-harness.mjs';

const T0=Date.parse('2026-11-05T15:37:00.000Z');
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const env=baseEnv(bucket,{...SEPARATE});
 migrated(bucket);
 diaryPages(net,{pages:1,perPage:50});
 return {clock,net,bucket,ctx,env,R:g(ctx,'LetterboxdRatings')};
}
const events=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).sort().map(key=>({key,...bucket.records.get(key)}));
const ratings=bucket=>events(bucket).filter(event=>event.type==='ratings');
async function runOnce(R,env,clock,trigger='scheduled'){
 const started=plain(await R.start(env,{trigger}));assert.equal(started.created,true,JSON.stringify(started));
 let reply;for(let i=0;i<20;i++){reply=plain(await R.step(env,{runId:started.runId}));clock.now+=1000;if(reply.nextAction!=='continue')break;}
 return {runId:started.runId,reply};
}

// 1. A natural successful run: exactly one event with the real end time; 50 read, the written count is not the read count.
{
 const {bucket,env,R,clock,net}=setup();
 const {runId,reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished');
 const run=bucket.value(RUN),found=ratings(bucket);
 assert.equal(found.length,1,'one ratings event');
 const event=found[0];
 assert.equal(event.id,runId+'-ratings');assert.equal(event.runId,runId);assert.equal(event.at,run.finishedAt,'the time is the real end of the run');
 assert.equal(event.key,eventKeyOf(run.finishedAt,runId+'-ratings'),'reverse-timestamp key');
 assert.equal(event.state,'finished');assert.equal(event.cause,null);assert.equal(event.trigger,'scheduled');
 assert.equal(event.diary.rows,50,'50 rows read');assert.equal(event.diary.pages,1);
 assert.equal(event.diary.written,run.diary.facts.written);assert.ok(event.diary.written>=1,'new facts were written');
 assert.equal(event.diary.unchanged,run.diary.facts.unchanged);
 assert.equal(event.coverage,'recent_window','page one is not the whole archive');
 assert.deepEqual(Object.keys(event).sort(),['at','cause','coverage','diary','id','key','removal','runId','state','trigger','type'].sort(),'a stable minimal contract');
 assert.doesNotMatch(JSON.stringify(event),/lid\d|letterboxd\.com|film/i,'no titles, ids, urls or raw data');
 assert.ok(bucket.value(RUN).ratingsEventAt,'the run is marked delivered');
 // 2. The next successful run with nothing new: a new event for another runId with zero written.
 clock.now+=DAY;
 const second=await runOnce(R,env,clock);
 const both=ratings(bucket);
 assert.equal(both.length,2);assert.notEqual(second.runId,runId);
 const latest=both.find(item=>item.runId===second.runId);
 assert.equal(latest.diary.written,0,'no new facts on the no-change run');assert.equal(latest.diary.rows,50);assert.equal(latest.diary.unchanged+latest.diary.skipped,50,'every row already matched (skipped = already recorded)');
 assert.ok(latest.at>event.at,'chronological');
 assert.deepEqual(both.map(item=>item.key),[...both.map(item=>item.key)].sort(),'ordering follows the key');
 // The status is a read: it writes no event.
 const before=bucket.writes().length;await R.status(env);assert.equal(bucket.writes().length,before,'status writes nothing');
}

// 3. Blocked and rate-limited Diary: an error event, never a success; no event for a run that never started.
for(const [status,cause] of [[403,'blocked'],[429,'rate_limited']]){
 const {bucket,env,R,clock,net}=setup();
 net.diary.set(1,status);
 const {runId,reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'error',String(status));
 const found=ratings(bucket);assert.equal(found.length,1);
 eq([found[0].state,found[0].cause,found[0].id],['error',cause,runId+'-ratings']);
 assert.equal(found[0].diary.written,0);
}
{
 const {bucket,env,R,clock}=setup();
 const bad=baseEnv(bucket,{...SEPARATE});bucket.records.delete('enrichment/removal-rating-lookups.json');
 assert.equal(plain(await R.start(bad,{trigger:'scheduled'})).reason,'not_migrated');
 assert.equal(ratings(bucket).length,0,'no run started, no event');
}

// 4. Crash/timeout after the D1 terminal commit and before the R2 put: the run is not failed, Diary is not read again, and a later
// look delivers the event once.
{
 const {bucket,env,R,clock,net}=setup();
 let failing=true;bucket.hooks.beforePut=async key=>{if(failing&&key.startsWith('events/items/'))throw new Error('R2 unavailable');};
 const {runId,reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished','a failed event put does not fail the run');
 assert.equal(ratings(bucket).length,0,'no event yet');
 assert.equal(bucket.value(RUN).state,'finished');assert.equal(bucket.value(RUN).ratingsEventAt,undefined,'not marked delivered');
 const fetches=net.diaryFetches().length;
 failing=false;
 const repaired=plain(await R.reconcileEvent(env));assert.equal(repaired.written,1);
 assert.equal(net.diaryFetches().length,fetches,'recovery reads no Diary');
 assert.equal(ratings(bucket).length,1);assert.equal(ratings(bucket)[0].runId,runId);assert.ok(bucket.value(RUN).ratingsEventAt);
 // Idempotent: repeats, concurrent reconciles and a second delivery of the same event create nothing new.
 await Promise.all([R.reconcileEvent(env),R.reconcileEvent(env)]);
 assert.equal(ratings(bucket).length,1);
}

// 5. The record is replaced before the event could be delivered: the event is carried on the new run, bounded, and delivered later.
{
 const {bucket,env,R,clock}=setup();
 let failing=true;bucket.hooks.beforePut=async key=>{if(failing&&key.startsWith('events/items/'))throw new Error('R2 unavailable');};
 const first=await runOnce(R,env,clock);
 clock.now+=DAY;
 const next=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(next.created,true,'the failed delivery does not block the next run');
 const carried=bucket.value(RUN).pendingEvents;
 assert.equal(carried.length,1,'the earlier terminal outcome is carried, not lost');assert.equal(carried[0].event.runId,first.runId);
 // Bounded: five failed attempts drop it instead of retrying forever.
 for(let i=0;i<6;i++)await R.reconcileEvent(env);
 assert.equal(bucket.value(RUN).pendingEvents,undefined,'dropped after the attempt bound');assert.equal(ratings(bucket).length,0);
}
{
 const {bucket,env,R,clock}=setup();
 let failing=true;bucket.hooks.beforePut=async key=>{if(failing&&key.startsWith('events/items/'))throw new Error('R2 unavailable');};
 const first=await runOnce(R,env,clock);clock.now+=DAY;
 await R.start(env,{trigger:'scheduled'});
 assert.equal(bucket.value(RUN).pendingEvents.length,1);
 failing=false;
 const result=plain(await R.reconcileEvent(env));assert.equal(result.written,1);
 assert.equal(ratings(bucket).length,1);assert.equal(ratings(bucket)[0].runId,first.runId);assert.equal(bucket.value(RUN).pendingEvents,undefined);
}

// 6. An interrupted run that is closed as unknown gets an honest event at its close time, and a running run gets none.
{
 const {bucket,env,R,clock}=setup();
 const started=plain(await R.start(env,{trigger:'scheduled'}));
 assert.equal(ratings(bucket).length,0,'a running run has no event');
 clock.now+=2*H;
 const next=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(next.created,true);
 const found=ratings(bucket);assert.equal(found.length,1);
 eq([found[0].state,found[0].runId],['unknown',started.runId]);assert.ok(['abandoned','interrupted'].includes(found[0].cause));
 assert.equal(found[0].at,bucket.value(RUN).recent[0].endedAt,'at the time the run was closed');
}

// 7. The Events UI: compact Russian text, counts as numbers, honest errors, escaping, legacy types unchanged.
{
 const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''},matchMedia:()=>({matches:false}),addEventListener(){},scrollY:0,scrollTo(){}},localStorage:{getItem:()=>null,setItem(){}},fetch:()=>Promise.reject(new Error('no network'))});
 vm.runInContext(fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
 ctx.ev=(over={})=>({id:'r-ratings',type:'ratings',at:'2026-11-05T16:38:00.000Z',runId:'r',trigger:'scheduled',state:'finished',cause:null,coverage:'recent_window',diary:{pages:1,rows:50,added:1,updated:0,written:1,unchanged:49,skipped:0,conflicts:0},removal:{pending:0,checked:0,resolved:0},...over});
 const html=over=>vm.runInContext('eventHTML(ev('+JSON.stringify(over||{})+'))',ctx);
 let text=html();
 assert.match(text,/Рейтинги обновлены/);assert.match(text,/Diary: записей проверено<\/dt><dd>50</);assert.match(text,/Новых фактов<\/dt><dd>1</);assert.match(text,/Без изменений<\/dt><dd>49</);assert.match(text,/Удалений обработано<\/dt><dd>0</);
 assert.match(text,/последняя страница Diary, не вся история/);assert.match(text,/datetime="2026-11-05T16:38:00.000Z"/);assert.match(text,/17:38|5 нояб/);
 text=html({diary:{pages:1,rows:50,added:0,updated:0,written:0,unchanged:50,skipped:0,conflicts:0}});assert.match(text,/Новых фактов<\/dt><dd>0</,'a no-change run says zero');
 text=html({state:'error',cause:'blocked',diary:{pages:0,rows:0,added:0,updated:0,written:0,unchanged:0,skipped:0,conflicts:0}});
 assert.match(text,/Проверка рейтингов завершена с ошибкой/);assert.match(text,/Letterboxd заблокировал запрос/);assert.doesNotMatch(text,/Рейтинги обновлены/);
 text=html({state:'unknown',cause:'abandoned'});assert.match(text,/Проверка рейтингов прервана/);assert.match(text,/Выполнение прервано/);
 text=html({cause:'<img src=x>',state:'error',diary:{rows:'<b>1</b>',written:'x'}});assert.doesNotMatch(text,/<img|<b>/,'values are not interpolated unescaped');assert.match(text,/записей проверено<\/dt><dd>0</);
 assert.match(vm.runInContext("eventHTML({id:'e',type:'epg',at:'2026-11-05T16:00:00.000Z',films:1,archive:2,future:3,broadcasts:4})",ctx),/Обновлён EPG/,'legacy types render as before');
}
console.log('AIR-361 ratings event: one event per run with the real end time, no-change and error runs, crash between D1 and R2, carried bounded delivery, unknown close and the Events UI passed');
