// AIR-393: the `ratings` event names the films a run changed (optional `details`), from the committed run record only: new watched facts and
// ratings, changed ratings, removed films whose rating was found, and removal references settled. Bounded, idempotent, read-compatible.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPage,diaryRow,migrated,QUEUE,RUN,SEPARATE,H,DAY,eventKeyOf,plain,g} from './ratings-harness.mjs';

const T0=Date.parse('2026-11-09T15:37:00.000Z');
const at=ms=>new Date(ms).toISOString();
const eq=(actual,expected,message)=>assert.deepEqual(plain(actual),plain(expected),message);
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();
 const ctx=loadContext({net,clock,FakeDate,crypto});
 const env=baseEnv(bucket,{...SEPARATE});
 return {clock,net,bucket,ctx,env,R:g(ctx,'LetterboxdRatings')};
}
const ratings=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).sort().map(key=>({key,...bucket.records.get(key)})).filter(event=>event.type==='ratings');
async function runOnce(R,env,clock){
 const started=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(started.created,true,JSON.stringify(started));
 let reply;for(let i=0;i<30;i++){reply=plain(await R.step(env,{runId:started.runId}));clock.now+=1000;if(reply.nextAction!=='continue')break;}
 return {runId:started.runId,reply};
}
const removalEvent=(id,films)=>({id,type:'watchlist',at:at(T0-3*H),total:10,baseline:false,added:[],removed:films});
const queueEntry=(slug,eventKey,eventAt)=>({url:`https://letterboxd.com/film/${slug}/`,state:'pending',attempts:0,enqueuedAt:at(T0-3*H),nextAttemptAt:at(T0-H),lastAttemptAt:null,lastResult:null,claim:null,refs:[{eventKey,sourceRunId:'run-1',at:eventAt,resolved:false}]});

// 1. One run, every group: added (with and without a rating), updated, rated (found by the Diary) and resolved (the reference settled).
{
 const {clock,net,bucket,env,R}=setup();
 const eventAt=at(T0-3*H),eventKey=eventKeyOf(eventAt,'run-1-watchlist');
 bucket.set(eventKey,removalEvent('run-1-watchlist',[{id:'lidR',title:'Удалённый фильм',year:1999}]));
 migrated(bucket,{films:{lidR:queueEntry('lidR',eventKey,eventAt)}});
 bucket.set('enrichment/view-index.json',{lidU:{watched:true,actualRating:3}});
 bucket.set('metadata.json',{lidA:{id:'lidA',title:'Фильм А',year:2001,tmdbId:'111'},lidU:{id:'lidU',title:'Фильм У',year:1990,tmdbId:'222'},lidB:{id:'lidB',title:'Фильм Б',year:2010}});
 net.diary.set(1,diaryPage([diaryRow('lidA',8,'2026-11-08','v1'),diaryRow('lidB',0,'2026-11-07','v2'),diaryRow('lidU',9,'2026-11-06','v3'),diaryRow('lidR',7,'2026-11-05','v4')]));
 const {runId,reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 const found=ratings(bucket);assert.equal(found.length,1);const event=found[0];
 assert.equal(event.removal.rated,1,'one removed film rated');assert.equal(event.removal.resolved,1,'one reference settled');assert.equal(event.diary.written,4);
 const d=plain(event.details);
 eq(d.added.map(f=>[f.id,f.title,f.year,f.tmdb,f.rating]).sort(),[['lidA','Фильм А',2001,'111',4],['lidB','Фильм Б',2010,null,null],['lidR',null,null,null,3.5]].sort(),'new watched facts, with the rating when the entry has one; the removed film is not in metadata, so no name here');
 eq(d.updated.map(f=>[f.id,f.title,f.tmdb,f.from,f.rating]),[['lidU','Фильм У','222',3,4.5]],'a changed rating keeps the stored earlier one');
 eq(d.rated.map(f=>[f.id,f.title,f.year,f.rating]),[['lidR','Удалённый фильм',1999,3.5]],'the removed film is named from its removal event');
 eq(d.resolved.map(f=>[f.id,f.title,f.year,f.rating]),[['lidR','Удалённый фильм',1999,3.5]],'and the settled reference names the same film; the two counters measure different things');
 assert.equal(d.more,undefined,'nothing over the cap');
 assert.doesNotMatch(JSON.stringify(event.details),/https?:|letterboxd\.com|rows|payload/i,'no urls, rows or raw data in the details');
 // The aggregates are untouched by the details: written/unchanged/rated/resolved keep their meaning.
 assert.equal(event.diary.rows,4);assert.equal(event.diary.unchanged,0);
 // The details live on the committed run record, so a repeated delivery is the same event and writes nothing new.
 const run=bucket.value(RUN);assert.ok(run.diary.changes&&run.diary.changes.updated.length===1,'kept on the run record');
 const before=JSON.stringify(ratings(bucket));await R.reconcileEvent(env);assert.equal(JSON.stringify(ratings(bucket)),before,'a repeat is the same event');
 assert.equal(ratings(bucket).length,1,'one event per run');
}

// 1b. One film with two references (removed, re-added and removed again): `resolved` counts the references, the list names the film once.
{
 const {clock,net,bucket,env,R}=setup();
 const first=at(T0-5*H),second=at(T0-3*H),k1=eventKeyOf(first,'run-0-watchlist'),k2=eventKeyOf(second,'run-1-watchlist');
 for(const [key,id,when] of [[k1,'run-0-watchlist',first],[k2,'run-1-watchlist',second]])bucket.set(key,{...removalEvent(id,[{id:'twice',title:'Дважды удалён',year:1988}]),at:when});
 migrated(bucket,{films:{twice:{...queueEntry('twice',k1,first),refs:[{eventKey:k1,sourceRunId:'run-0',at:first,resolved:false},{eventKey:k2,sourceRunId:'run-1',at:second,resolved:false}]}}});
 net.diary.set(1,diaryPage([diaryRow('twice',8,'2026-11-08','v1')]));
 await runOnce(R,env,clock);
 const event=ratings(bucket)[0];
 assert.equal(event.removal.resolved,2,'two references settled');assert.equal(event.details.resolved.length,1,'the film is named once');assert.equal(event.details.rated.length,1);
}

// 2. A run that changed nothing carries no details and no empty groups.
{
 const {clock,net,bucket,env,R}=setup();
 migrated(bucket);
 bucket.set('enrichment/view-index.json',{lidA:{watched:true,actualRating:4}});
 net.diary.set(1,diaryPage([diaryRow('lidA',8,'2026-11-08','v1')]));
 await runOnce(R,env,clock);
 // The first run records the fact; the second finds the film unchanged.
 clock.now+=2*H;await runOnce(R,env,clock);
 const found=ratings(bucket);assert.equal(found.length,2);
 const quiet=found[found.length-1];assert.equal(quiet.details,undefined,'no details for a run that changed no film');assert.equal(Object.hasOwn(quiet,'details'),false);
}

// 3. The cap: over 25 in a group the rest are counted, never dropped silently, and the aggregate counter is whole.
{
 const {clock,net,bucket,env,R}=setup();
 migrated(bucket);
 net.diary.set(1,diaryPage(Array.from({length:40},(_,i)=>diaryRow('lid'+String(i).padStart(2,'0'),8,'2026-11-08','v'+i))));
 await runOnce(R,env,clock);
 const event=ratings(bucket)[0];
 assert.equal(event.diary.written,40);assert.equal(event.details.added.length,25);assert.equal(event.details.more.added,15,'the rest are counted');
 assert.ok(JSON.stringify(event).length<20000,'the event stays small');
}

// 4. A failed Events Log put keeps the same details for the later delivery; no film is lost or listed twice.
{
 const {clock,net,bucket,env,R}=setup();
 migrated(bucket);
 bucket.set('metadata.json',{lidA:{id:'lidA',title:'Фильм А',year:2001,tmdbId:'111'}});
 net.diary.set(1,diaryPage([diaryRow('lidA',8,'2026-11-08','v1')]));
 let fail=true;bucket.hooks.beforePut=async(key,value)=>{if(fail&&key.startsWith('events/items/')&&value?.type==='ratings')throw new Error('events log down');};
 await runOnce(R,env,clock);
 assert.equal(ratings(bucket).length,0,'not delivered yet');
 const record=bucket.value(RUN);assert.equal(record.ratingsEventAt,undefined,'still owed');assert.equal(record.diary.changes.added[0].id,'lidA','the committed record keeps what the event needs');
 fail=false;clock.now+=DAY;await R.reconcileEvent(env);
 const found=ratings(bucket);assert.equal(found.length,1);
 eq(found[0].details.added.map(f=>[f.id,f.title,f.tmdb]),[['lidA','Фильм А','111']],'the delivered event has the details the run recorded');
 await R.reconcileEvent(env);assert.equal(ratings(bucket).length,1,'no duplicate after another look');
}

// 5. The details survive the checkpoint between steps: a run with more removal lookups than one step handles keeps the Diary changes.
{
 const {clock,net,bucket,env,R}=setup();
 const eventAt=at(T0-3*H),eventKey=eventKeyOf(eventAt,'run-1-watchlist'),films={},removed=[];
 for(let i=0;i<12;i++){const id='gone'+i;films[id]=queueEntry(id,eventKey,eventAt);removed.push({id,title:'Удалён '+i,year:2000+i});net.members.set(id,4);}
 bucket.set(eventKey,removalEvent('run-1-watchlist',removed));
 migrated(bucket,{films});
 bucket.set('metadata.json',{lidA:{id:'lidA',title:'Фильм А',year:2001,tmdbId:'111'}});
 net.diary.set(1,diaryPage([diaryRow('lidA',8,'2026-11-08','v1')]));
 const {reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 const event=ratings(bucket)[0];
 assert.equal(event.details.added.length,1,'the Diary change is kept across the removal steps');
 assert.ok(event.removal.rated>=1&&event.details.rated.length===event.removal.rated,'every rating found by a lookup is named: '+JSON.stringify([event.removal,event.details.rated?.length]));
 assert.equal(new Set(event.details.rated.map(f=>f.id)).size,event.details.rated.length,'no film twice in a group');
}

// 6. A record written before this field (no changes anywhere) builds the same short event as before.
{
 const {bucket,R}=setup();
 const run={schemaVersion:1,runId:'old',trigger:'scheduled',state:'finished',phase:'done',finishedAt:at(T0),diary:{outcome:'ok',counts:{pages:1,rows:50},facts:{written:0,unchanged:50},historicalCoverage:'incomplete'},removal:{settled:{},lookup:{}}};
 const event=plain(R.ratingsEventOf(run));assert.equal(Object.hasOwn(event,'details'),false);assert.equal(event.diary.rows,50);
}

// 7. The Events UI: groups, links only with a TMDB id, a readable unknown, escaping, the honest remainder, legacy events unchanged.
{
 const ctx=vm.createContext({Date,Intl,URL,URLSearchParams,Set,Map,JSON,console,document:{querySelector(){return null;},querySelectorAll(){return [];},documentElement:{classList:{toggle(){}}}},window:{history:{state:null,pushState(){},replaceState(){}},location:{href:'https://iptv.local/',pathname:'/',search:'',hash:''},addEventListener(){},matchMedia:()=>({matches:false,addEventListener(){}})},localStorage:{getItem(){return null;},setItem(){}},fetch:async()=>({ok:false,json:async()=>({})}),setTimeout,clearTimeout});
 try{
  vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
 }catch(error){throw error;}
 const base={id:'r-ratings',type:'ratings',at:'2026-11-09T16:00:00.000Z',runId:'r',trigger:'scheduled',state:'finished',cause:null,coverage:'recent_window',diary:{pages:1,rows:50,added:1,updated:0,written:1,unchanged:49,skipped:0,conflicts:0},removal:{pending:0,checked:0,rated:1,resolved:1}};
 ctx.ev=base;const html=details=>{ctx.ev={...base,...(details?{details}:{})};return vm.runInContext('eventHTML(ev)',ctx);};
 let text=html();
 assert.doesNotMatch(text,/event-group/,'an event without details keeps the short summary');assert.match(text,/Diary: записей проверено/);
 text=html({added:[{id:'a',title:'Фильм А',year:2001,tmdb:'111',rating:4},{id:'b',title:'Фильм Б',year:2010,tmdb:null,rating:null}],updated:[{id:'u',title:'Фильм У',year:1990,tmdb:'222',from:3,rating:4.5},{id:'n',title:'Новая оценка',year:2000,tmdb:null,from:null,rating:3.5}],rated:[{id:'r',title:'Удалённый',year:1999,tmdb:null,rating:3.5}],resolved:[{id:'r',title:'Удалённый',year:1999,tmdb:null,rating:3.5}],more:{added:3}});
 assert.match(text,/Новые просмотры и оценки · 5/,'the header counts the films and the remainder');
 assert.match(text,/<a href="\/film\/tmdb_111">Фильм А \(2001\)<\/a> · 4\.0 ★/);assert.match(text,/Фильм Б \(2010\) · просмотр без оценки/,'a watched film without a rating is a view, not a rating');
 assert.match(text,/<a href="\/film\/tmdb_222">Фильм У \(1990\)<\/a> · 3\.0 → 4\.5 ★/);assert.match(text,/Новая оценка \(2000\) · оценка добавлена: 3\.5 ★/,'no invented earlier rating');
 assert.doesNotMatch(text,/<a href="[^"]*">Фильм Б/,'no link without a TMDB id');assert.match(text,/ещё 3 без детализации/);
 assert.match(text,/Найдена оценка удалённого из watchlist фильма · 1/);assert.match(text,/Оценка записана в событие об удалении · 1/);assert.match(text,/Удалённый \(1999\) · 3\.5 ★/);
 text=html({added:[{id:'lid123',title:null,year:null,tmdb:null,rating:4},{id:'x',title:'<img src=x onerror=1>',year:2000,tmdb:'1"><b>',rating:4.2}]});
 assert.match(text,/Название недоступно · 4\.0 ★/);assert.doesNotMatch(text,/lid123/,'a technical id is never shown as a title');
 assert.doesNotMatch(text,/<img|<b>/,'values are escaped');assert.doesNotMatch(text,/<a href=[^>]*tmdb_1/,'a malformed TMDB id makes no link');assert.doesNotMatch(text,/4\.2/,'only half-star ratings are shown');
 text=html({added:[],more:{}});assert.doesNotMatch(text,/event-group/,'no empty group');
 text=html({added:'x',updated:{},rated:[null,1,'s'],more:{rated:-1}});assert.doesNotMatch(text,/event-group/,'malformed details draw nothing');
}
console.log('AIR-393 ratings event details: every group, caps, retry and delivery, checkpoint, no-change and legacy compatibility, links and unknown titles passed');
