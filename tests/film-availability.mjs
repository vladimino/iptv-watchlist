// AIR-433 (ADR 0114): the film-level availability lifecycle. Table-driven, offline, no storage, no clock of its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {scoped} from '../scripts/bundle-scope.mjs';
import {AVAILABILITY_ARCHIVE_MS as ARCHIVE,AVAILABILITY_SOON_MS as SOON,AVAILABILITY_LABELS,filmAvailability,normalizeShow,runtimeMs,showPhase} from '../src/domain/film-availability.js';

const H=3600000,M=60000;
// Madrid wall-clock to epoch milliseconds, from the UTC offset that applies on that date (CET +1 in winter, CEST +2 in summer).
const madrid=(iso,offsetHours)=>Date.parse(iso+':00.000Z')-offsetHours*H;
const NOW=madrid('2026-11-10T14:00',1);
const show=(startOffset,minutes,now=NOW)=>({start:now+startOffset,end:now+startOffset+minutes*M});
const view=(shows,now=NOW)=>{const r=filmAvailability(shows,now);return {state:r.state,appearsAt:r.appearsAt,appearsAtKnown:r.appearsAtKnown,archiveUntil:r.archiveUntil,onAir:r.onAir,nextStart:r.nextStart};};
const none={appearsAt:null,appearsAtKnown:null,archiveUntil:null,onAir:false,nextStart:null};

// ---- the three states and the words ----
assert.deepEqual(AVAILABILITY_LABELS,{available:'Доступно',soon:'Скоро',unavailable:'Недоступно'});
assert.equal(ARCHIVE,72*H);assert.equal(SOON,24*H);
const CASES=[
 // [name, shows, expected view fields (merged over `none`)]
 ['no shows',[],{state:'unavailable'}],
 ['a show that ended an hour ago is a ready archive',[show(-3*H,120)],{state:'available',archiveUntil:NOW-3*H+ARCHIVE}],
 ['a single show ending exactly now is a ready archive',[show(-2*H,120)],{state:'available',archiveUntil:NOW-2*H+ARCHIVE}],
 ['live is not an archive: on air now is soon, ready when it ends',[show(-30*M,120)],{state:'soon',appearsAt:NOW-30*M+120*M,appearsAtKnown:true,onAir:true}],
 ['a show that starts in the next 24 hours is soon, ready at its END not its start',[show(5*H,100)],{state:'soon',appearsAt:NOW+5*H+100*M,appearsAtKnown:true,nextStart:NOW+5*H}],
 ['a show beyond 24 hours is not soon',[show(24*H,100)],{state:'unavailable',nextStart:NOW+24*H}],
 ['a show a minute inside the 24-hour edge is soon',[show(24*H-M,100)],{state:'soon',appearsAt:NOW+24*H-M+100*M,appearsAtKnown:true,nextStart:NOW+24*H-M}],
 ['a show a week ahead is read as nothing',[show(160*H,100)],{state:'unavailable',nextStart:NOW+160*H}],
 ['archive plus a repeat later today stays available; the repeat is only the next start',[show(-10*H,90),show(3*H,90)],{state:'available',archiveUntil:NOW-10*H+ARCHIVE,nextStart:NOW+3*H}],
 ['archive plus the same film on air now stays available',[show(-5*H,90),show(-20*M,90)],{state:'available',archiveUntil:NOW-5*H+ARCHIVE,onAir:true}],
 ['archive plus a repeat after 24 hours stays available',[show(-5*H,90),show(30*H,90)],{state:'available',archiveUntil:NOW-5*H+ARCHIVE,nextStart:NOW+30*H}],
 ['the window counts from the start: 72 hours after the start the recording is gone',[show(-ARCHIVE,60)],{state:'unavailable'}],
 ['one millisecond before the window closes it is still offered',[{start:NOW-ARCHIVE+1,end:NOW-ARCHIVE+1+60*M}],{state:'available',archiveUntil:NOW+1}],
 ['an old show plus a repeat soon: only the repeat counts, so soon',[show(-ARCHIVE-H,60),show(2*H,60)],{state:'soon',appearsAt:NOW+3*H,appearsAtKnown:true,nextStart:NOW+2*H}],
 ['two ready shows: the later start decides how long the archive lasts',[show(-60*H,90),show(-8*H,90)],{state:'available',archiveUntil:NOW-8*H+ARCHIVE}],
 ['soon takes the earliest end among the candidates',[show(-10*M,300),show(2*H,60)],{state:'soon',appearsAt:NOW-10*M+300*M<NOW+2*H+60*M?NOW-10*M+300*M:NOW+2*H+60*M,appearsAtKnown:true,onAir:true,nextStart:NOW+2*H}],
 ['a missing end on a show that has started is ignored: never an archive and never promised',[{start:NOW-30*M}],{state:'unavailable'}],
 ['a missing end on a show that started long ago is ignored too',[{start:NOW-5*H}],{state:'unavailable'}],
 ['a started show without an end does not hide a future one',[{start:NOW-30*M},{start:NOW+2*H,end:NOW+3*H}],{state:'soon',appearsAt:NOW+3*H,appearsAtKnown:true,nextStart:NOW+2*H}],
 ['a missing end on a future show: soon without a promised hour',[{start:NOW+3*H}],{state:'soon',appearsAt:null,appearsAtKnown:false,nextStart:NOW+3*H}],
 ['an end that is not after the start is unknown, not zero-length',[{start:NOW+3*H,end:NOW+3*H}],{state:'soon',appearsAt:null,appearsAtKnown:false,nextStart:NOW+3*H}],
 ['an end before the start of a past show is unknown: no false archive and no promise',[{start:NOW-5*H,end:NOW-6*H}],{state:'unavailable'}],
 ['an unparseable end is unknown',[{start:NOW+H,end:'later'}],{state:'soon',appearsAt:null,appearsAtKnown:false,nextStart:NOW+H}],
 ['one known and one unknown end among the candidates: the known hour is given but not promised',[{start:NOW+H,end:NOW+2*H},{start:NOW+3*H}],{state:'soon',appearsAt:NOW+2*H,appearsAtKnown:false,nextStart:NOW+H}],
 ['a ready archive wins even when another show has an unknown end',[show(-4*H,60),{start:NOW-20*M}],{state:'available',archiveUntil:NOW-4*H+ARCHIVE}],
 ['ISO strings are read as times',[{start:new Date(NOW-4*H).toISOString(),end:new Date(NOW-3*H).toISOString()}],{state:'available',archiveUntil:NOW-4*H+ARCHIVE}],
 ['numeric strings are read as times',[{start:String(NOW-4*H),end:String(NOW-3*H)}],{state:'available',archiveUntil:NOW-4*H+ARCHIVE}],
 ['a show with no usable start is ignored',[{end:NOW-H},{start:null,end:NOW},{start:'x'},null,undefined,5,'show'],{state:'unavailable'}],
];
for(const [name,shows,expected] of CASES)assert.deepEqual(view(shows),{...none,...expected},name);
assert.deepEqual(view(null),{...none,state:'unavailable'});assert.deepEqual(view(undefined),{...none,state:'unavailable'});assert.deepEqual(view('x'),{...none,state:'unavailable'});
// a time that is not finite gives no state at all (the caller has no clock): unavailable, never available
for(const now of [NaN,Infinity,undefined,null])assert.equal(filmAvailability([show(-3*H,60)],now).state,'unavailable','now='+now);

// ---- the full transition of one show: future, on air, ended, archive, expired ----
{
 const start=NOW+5*H,end=start+100*M,only=[{start,end}];
 const at=offset=>filmAvailability(only,start+offset);
 assert.equal(at(-30*H).state,'unavailable','far ahead');
 assert.equal(at(-24*H).state,'unavailable','exactly 24 hours before the start: not yet inside the window');
 assert.equal(at(-24*H+1).state,'soon','one millisecond inside');
 assert.equal(at(-H).state,'soon','before the start');
 assert.deepEqual([at(-H).appearsAt,at(-H).onAir],[end,false]);
 assert.equal(at(0).state,'soon','at the start it is on air');assert.equal(at(0).onAir,true);
 assert.equal(at(50*M).state,'soon','on air');assert.equal(at(50*M).appearsAt,end);
 assert.equal(at(100*M-1).state,'soon','one millisecond before the end');
 assert.equal(at(100*M).state,'available','at the end it is a ready archive');assert.equal(at(100*M).onAir,false);
 assert.equal(at(100*M).archiveUntil,start+ARCHIVE);
 assert.equal(at(ARCHIVE-1).state,'available','one millisecond before the 72-hour window closes');
 assert.equal(at(ARCHIVE).state,'unavailable','the window is closed');
 assert.equal(at(ARCHIVE+30*H).state,'unavailable');
}
// the state never goes backwards through the lifecycle of a single show: unavailable -> soon -> available -> unavailable
{
 const only=[{start:NOW,end:NOW+90*M}],order=['unavailable','soon','available'];let rank=0,closed=false;
 for(let t=NOW-30*H;t<NOW+ARCHIVE+3*H;t+=7*M+13){
  const state=filmAvailability(only,t).state;
  if(state==='unavailable'&&t>NOW)closed=true;
  if(closed)assert.equal(state,'unavailable','after the window closes it stays closed');
  else{assert.ok(order.indexOf(state)>=rank,'no step back at '+(t-NOW)/M+' min: '+state);rank=order.indexOf(state);}
 }
 assert.equal(rank,2,'the lifecycle reached available');
}

// ---- the transition the diagram names: the last archive expires while a repeat is on air or ahead (available -> soon), and a late generation (unavailable -> available) ----
{
 const first={start:NOW-ARCHIVE+30*M,end:NOW-ARCHIVE+90*M};                 // the archive show: its window closes 30 minutes from now
 const repeatAhead={start:NOW+5*H,end:NOW+7*H};
 for(const [name,repeat] of [['repeat a minute after the expiry',{start:NOW+31*M,end:NOW+3*H}],['repeat hours ahead',repeatAhead]]){
  const before=filmAvailability([first,repeat],NOW);assert.equal(before.state,'available',name+': before the archive expires');
  const expiry=first.start+ARCHIVE,after=filmAvailability([first,repeat],expiry);
  assert.equal(after.state,'soon',name+': the last archive has expired and the repeat is the film now');assert.equal(after.archiveUntil,null);assert.ok(after.appearsAt>expiry);
 }
 const onAirAtExpiry=filmAvailability([first,{start:first.start+ARCHIVE-10*M,end:first.start+ARCHIVE+60*M}],first.start+ARCHIVE);
 assert.deepEqual([onAirAtExpiry.state,onAirAtExpiry.onAir,onAirAtExpiry.appearsAt],['soon',true,first.start+ARCHIVE+60*M],'a repeat on air at the moment the archive expires');
 // unavailable -> available: the same instant, a newer generation now lists a show that has already ended
 assert.equal(filmAvailability([],NOW).state,'unavailable');assert.equal(filmAvailability([{start:NOW-3*H,end:NOW-2*H}],NOW).state,'available');
}

// ---- the rolling 24 hours is elapsed time, not calendar days: 23:50 Madrid, a change of day, DST nights ----
{
 const now=madrid('2026-11-10T23:50',1);                         // 23:50 Madrid, CET
 const inside=madrid('2026-11-11T23:49',1),edge=madrid('2026-11-11T23:50',1),morning=madrid('2026-11-11T00:10',1);
 assert.equal(filmAvailability([{start:morning,end:morning+H}],now).state,'soon','after midnight is the next calendar day and still inside 24 hours');
 assert.equal(filmAvailability([{start:inside,end:inside+H}],now).state,'soon','a minute inside the edge, the day after');
 assert.equal(filmAvailability([{start:edge,end:edge+H}],now).state,'unavailable','exactly 24 hours later');
 assert.equal(filmAvailability([{start:now+10*M,end:now+70*M}],now).appearsAt,now+70*M,'the end is in the next day: still one instant');
 // 00:05 the same night: the day changed under the viewer, nothing else did
 const later=madrid('2026-11-11T00:05',1);
 assert.equal(filmAvailability([{start:morning,end:morning+H}],later).onAir,false);
 assert.equal(filmAvailability([{start:morning,end:morning+H}],morning+30*M).state,'soon');
 assert.equal(filmAvailability([{start:morning,end:morning+H}],morning+H).state,'available');
}
{ // autumn change: Madrid goes CEST (+2) to CET (+1) on Sunday 2026-10-25 at 03:00 local, so that day has 25 hours
 const now=madrid('2026-10-24T23:50',2),elapsed24=now+24*H;
 assert.equal(new Date(elapsed24).toISOString(),'2026-10-25T21:50:00.000Z');
 const justInside=madrid('2026-10-25T22:49',1),justOutside=madrid('2026-10-25T22:50',1),calendarNextDay=madrid('2026-10-25T23:30',1);
 assert.equal(filmAvailability([{start:justInside,end:justInside+H}],now).state,'soon');
 assert.equal(filmAvailability([{start:justOutside,end:justOutside+H}],now).state,'unavailable','24 elapsed hours, not "the same wall-clock time tomorrow"');
 assert.equal(filmAvailability([{start:calendarNextDay,end:calendarNextDay+H}],now).state,'unavailable');
 // across the change itself, an archive keeps its 72 elapsed hours
 const start=madrid('2026-10-24T20:00',2),end=start+2*H,afterChange=madrid('2026-10-27T19:30',1);
 assert.equal(afterChange-start,71.5*H+H,'the wall clock says 71.5 hours but 72.5 hours elapsed');
 assert.equal(filmAvailability([{start,end}],afterChange).state,'unavailable','72 elapsed hours have passed');
 assert.equal(filmAvailability([{start,end}],start+ARCHIVE-1).state,'available');
}
{ // spring change: CET to CEST on Sunday 2026-03-29 at 02:00 local, so that day has 23 hours
 const now=madrid('2026-03-28T23:50',1);
 assert.equal(new Date(now+24*H).toISOString(),'2026-03-29T22:50:00.000Z','24 elapsed hours land at 00:50 Madrid on the 30th, CEST');
 const sameWallClock=madrid('2026-03-29T23:50',2),justInside=madrid('2026-03-30T00:49',2),justOutside=madrid('2026-03-30T00:50',2);
 assert.equal(filmAvailability([{start:sameWallClock,end:sameWallClock+H}],now).state,'soon','23:50 the next day is only 23 elapsed hours away');
 assert.equal(filmAvailability([{start:justInside,end:justInside+H}],now).state,'soon');
 assert.equal(filmAvailability([{start:justOutside,end:justOutside+H}],now).state,'unavailable');
}

// ---- the per-show phase ----
{
 const p=item=>showPhase(item,NOW).phase;
 assert.equal(p({start:NOW+1,end:NOW+H}),'future');assert.equal(p({start:NOW,end:NOW+H}),'on_air','a show that starts now is on air');
 assert.equal(p({start:NOW-H,end:NOW}),'archive','ended exactly now');assert.equal(p({start:NOW-H,end:NOW+1}),'on_air');
 assert.equal(p({start:NOW-ARCHIVE,end:NOW-ARCHIVE+H}),'expired');assert.equal(p({start:NOW-5*H}),'unknown','no end, started');
 assert.equal(p({start:NOW-H}),'unknown');assert.equal(p({end:NOW}),'invalid');
 assert.equal(showPhase({start:NOW+H},NOW).endKnown,false);assert.equal(showPhase({start:NOW+H,end:NOW+2*H},NOW).endKnown,true);
 // a started show without a usable end and without a runtime is `unknown`, never an archive (the owner replaced the old per-show status that said `archive`)
 assert.notEqual(p({start:NOW-5*H}),'archive');assert.equal(p({start:NOW-30*M,end:null}),'unknown');
 assert.deepEqual(normalizeShow({start:'2026-11-10T13:00:00.000Z',end:'2026-11-10T14:00:00.000Z'}),{start:Date.parse('2026-11-10T13:00:00.000Z'),end:Date.parse('2026-11-10T14:00:00.000Z'),endSource:'epg'});
 assert.equal(normalizeShow({start:true}),null);assert.equal(normalizeShow({start:''}),null);assert.equal(normalizeShow({start:NOW,end:NOW-1}).end,null);
}

// ---- different published and retained windows: the helper reads the shows it is given and nothing else ----
{ // a reader holding 168 hours of shows gets the same answer as one holding only [-72 h, +24 h): the extra shows change nothing
 const near=[show(-10*H,90),show(3*H,90)],far=[...near,show(-100*H,90),show(60*H,90),show(150*H,90)];
 assert.deepEqual(view(far),view(near));
 const onlyFar=[show(60*H,90),show(150*H,90),show(-100*H,90)];assert.equal(view(onlyFar).state,'unavailable','nothing inside the product windows');
 // a retained window that starts later than 72 hours back: the missing archive shows are simply not there
 assert.equal(view([show(3*H,90)]).state,'soon');
}

// ---- invariants over a seeded sweep of random show lists and instants ----
{
 let seed=20261111;const random=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296;};
 const pick=list=>list[Math.floor(random()*list.length)];
 const randomShow=()=>{const start=NOW+Math.round((random()*200-100)*H),duration=pick([null,-30,0,25,60,90,200])??null;return duration===null||random()<.1?{start}:{start,end:start+duration*M};};
 for(let round=0;round<3000;round++){
  const shows=Array.from({length:Math.floor(random()*5)},randomShow),now=NOW+Math.round((random()*120-30)*H);
  const frozen=JSON.stringify(shows),r=filmAvailability(shows,now);
  assert.equal(JSON.stringify(shows),frozen,'the input is never changed');
  assert.deepEqual(filmAvailability(shows,now),r,'deterministic');
  assert.ok(['available','soon','unavailable'].includes(r.state));assert.equal(r.label,AVAILABILITY_LABELS[r.state]);
  const phases=shows.map(item=>showPhase(item,now).phase);
  if(r.state==='available'){assert.ok(phases.includes('archive'));assert.ok(r.archiveUntil>now);assert.equal(r.appearsAt,null,'available and soon never both');assert.ok(r.archiveShow.end<=now);}
  if(r.state==='soon'){assert.ok(!phases.includes('archive'),'a ready archive always wins');assert.equal(r.archiveUntil,null);assert.ok(r.appearsAt===null||r.appearsAt>now,'a soon film appears in the future');}
  if(r.state==='unavailable')assert.ok(!phases.includes('archive')&&!phases.includes('on_air')&&!shows.some(item=>{const n=normalizeShow(item);return n&&n.start>now&&n.start<now+SOON;}));
  // adding a repeat or a future show never turns available into anything else, and never changes when the archive ends
  if(r.state==='available'){const more=filmAvailability([...shows,{start:now+2*H,end:now+3*H},{start:now-M}],now);assert.equal(more.state,'available');assert.equal(more.archiveUntil,r.archiveUntil);}
 }
}
// ---- AIR-433 owner decisions: the effective end is the EPG end, else start + film runtime (minutes), else unknown ----
{
 const RUN=100; // minutes
 const ph=(item,now,runtimeMinutes=RUN)=>showPhase(item,now,{runtimeMinutes});
 // a show with no end: future -> on_air -> archive (exactly at start + runtime) -> expired (72 h from the START)
 const start=NOW+3*H,end=start+RUN*M;
 assert.equal(ph({start},start-1).phase,'future');assert.equal(ph({start},start).phase,'on_air');assert.equal(ph({start},end-1).phase,'on_air');
 assert.equal(ph({start},end).phase,'archive','ready at the effective end, with no delay');assert.equal(ph({start},start+ARCHIVE-1).phase,'archive');assert.equal(ph({start},start+ARCHIVE).phase,'expired','72 h elapsed from the START');
 assert.deepEqual([ph({start},end).end,ph({start},end).endSource],[end,'runtime']);
 // a valid EPG end wins over the runtime; an invalid one falls back to it
 assert.deepEqual([ph({start,end:start+30*M},start+40*M).phase,ph({start,end:start+30*M},start+40*M).endSource],['archive','epg']);
 for(const bad of [null,undefined,'',start,start-1,'later',true]) assert.equal(ph({start,end:bad},start+RUN*M-1).phase,'on_air','invalid end '+String(bad)+' falls back to the runtime');
 // no usable runtime: unknown, never invented
 for(const bad of [null,undefined,0,-5,'abc','',NaN,Infinity,true]) assert.equal(showPhase({start:NOW-H},NOW,{runtimeMinutes:bad}).phase,'unknown','runtime '+String(bad));
 assert.equal(runtimeMs('100'),6000000);assert.equal(runtimeMs(100.5),100.5*M);assert.equal(runtimeMs(0),null);assert.equal(runtimeMs(Infinity),null);
 // film level: a show with no end, with the runtime, goes soon (on air) -> available at the effective end -> unavailable 72 h after the start
 const film=(shows,now,runtimeMinutes=RUN)=>filmAvailability(shows,now,{runtimeMinutes});
 assert.deepEqual([film([{start}],start-H).state,film([{start}],start-H).appearsAt,film([{start}],start-H).appearsAtKnown,film([{start}],start-H).appearsAtEstimated],['soon',end,true,true]);
 assert.deepEqual([film([{start}],start+M).state,film([{start}],start+M).onAir],['soon',true]);
 assert.equal(film([{start}],end-1).state,'soon');assert.equal(film([{start}],end).state,'available');assert.equal(film([{start}],end).archiveUntil,start+ARCHIVE);
 assert.equal(film([{start}],start+ARCHIVE-1).state,'available');assert.equal(film([{start}],start+ARCHIVE).state,'unavailable');
 // archive wins over a future repeat; the repeat does not change the end of the window
 const repeat=film([{start:NOW-5*H,end:NOW-4*H},{start:NOW+2*H}],NOW);
 assert.equal(repeat.state,'available');assert.equal(repeat.archiveUntil,NOW-5*H+ARCHIVE);assert.equal(repeat.nextStart,NOW+2*H);
 // estimated or scheduled: the flag follows the source of the earliest end
 assert.equal(film([{start:NOW+H,end:NOW+2*H}],NOW).appearsAtEstimated,false);assert.equal(film([{start:NOW+H}],NOW).appearsAtEstimated,true);
 assert.equal(film([{start:NOW+H,end:NOW+2*H},{start:NOW+3*H}],NOW).appearsAtEstimated,false,'the earliest end is scheduled');
 assert.equal(film([],NOW).appearsAtEstimated,null);
 // neither a valid end nor a runtime: explicit unknown, as before
 assert.deepEqual([film([{start:NOW-30*M}],NOW,null).state,film([{start:NOW+3*H}],NOW,null).appearsAt,film([{start:NOW+3*H}],NOW,null).appearsAtKnown],['unavailable',null,false]);
 // the runtime only matters when it is passed: the default call is the old behaviour
 assert.equal(filmAvailability([{start:NOW-30*M}],NOW).state,'unavailable');
}
// ---- the browser and the Worker run the same source ----
{
 // As a classic script (what the browser gets at /film-availability.js and what the Worker bundle embeds): one top-level binding, the same answers.
 const code=scoped('src/domain/film-availability.js','FilmAvailability');
 const context=vm.createContext({});vm.runInContext(code,context);
 const FilmAvailability=vm.runInContext('FilmAvailability',context);
 assert.deepEqual(Object.keys(FilmAvailability).sort(),['AVAILABILITY_ARCHIVE_MS','AVAILABILITY_LABELS','AVAILABILITY_SOON_MS','AVAILABILITY_STATES','filmAvailability','normalizeShow','runtimeMs','showPhase']);
 for(const [name,shows] of CASES){const here=JSON.parse(JSON.stringify(filmAvailability(shows,NOW))),there=JSON.parse(JSON.stringify(FilmAvailability.filmAvailability(shows,NOW)));assert.deepEqual(there,here,'classic script, '+name);}
 // wired once into the browser asset, once into the Worker, and loaded before app.js
 const build=fs.readFileSync('build.mjs','utf8');
 assert.equal(build.split("scoped('src/domain/film-availability.js','FilmAvailability')").length-1,2,'the asset and the Worker bundle');
 assert.match(build,/assets\['\/film-availability\.js'\]/);
 const html=fs.readFileSync('public/index.html','utf8');
 assert.ok(html.indexOf('/film-availability.js')>0&&html.indexOf('/film-availability.js')<html.indexOf('/app.js'),'loaded before app.js');
 // it has no dependency of its own: no storage, no network, no clock, no time zone
 assert.doesNotMatch(fs.readFileSync('src/domain/film-availability.js','utf8'),/\bfetch\b|BUCKET|localStorage|Date\.now|new Date\(|Intl\.|process\.|require\(|^import /m);
}

console.log('Film availability: three states, archive wins over live and future, soon ends at the end of the show, missing end never promised, rolling 24 hours in elapsed time (23:50 Madrid, DST nights), 72-hour window, shows outside the product windows ignored and 3000 random lists kept the invariants passed');
