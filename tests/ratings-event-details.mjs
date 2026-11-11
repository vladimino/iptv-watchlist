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
 eq(d.added.map(f=>[f.id,f.title,f.year,f.tmdb,f.rating]).sort(),[['lidA','Фильм А',2001,'111',4],['lidB','Фильм Б',2010,null,null],['lidR','Удалённый фильм',1999,null,3.5]].sort(),'new watched facts, with the rating when the entry has one; the removed film is named from its removal event');
 eq(d.updated.map(f=>[f.id,f.title,f.tmdb,f.from,f.rating]),[['lidU','Фильм У','222',3,4.5]],'a changed rating keeps the stored earlier one');
 // AIR-443: the removed film is one news line (its new fact), not also a `rated` and a `resolved` line; the counters keep their separate measures.
 assert.equal(d.rated,undefined,'no second line for the same film');assert.equal(d.resolved,undefined,'a settled reference is service work, not news');
 assert.equal(d.more,undefined,'nothing over the cap');
 assert.doesNotMatch(JSON.stringify(event.details),/https?:|letterboxd\.com|rows|payload/i,'no urls, rows or raw data in the details');
 // The aggregates are untouched by the details: written/unchanged/rated/resolved keep their meaning.
 assert.equal(event.diary.rows,4);assert.equal(event.diary.unchanged,0);
 // The details live on the committed run record, so a repeated delivery is the same event and writes nothing new.
 const run=bucket.value(RUN);assert.ok(run.diary.pageChanges?.['1']?.updated.length===1,'kept on the run record under the page key');
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
 assert.equal(event.removal.resolved,2,'two references settled');assert.equal(event.details.resolved,undefined,'a settled reference is not listed');assert.equal(event.details.added.length,1,'the film is named once, as the new fact it is');assert.equal(event.details.rated,undefined);
}

// 1c. AIR-393 durability: a crash at every point between the facts and the end of the step still gives the event the exact films, and a replay of a
// capped page does not inflate the remainder.
{
 const lids=Array.from({length:40},(_,i)=>'lid'+String(i).padStart(2,'0'));
 const crashAt=async(label,when,rows)=>{
  const {clock,net,bucket,env,R}=setup();
  migrated(bucket);
  bucket.set('metadata.json',{lid00:{id:'lid00',title:'Первый',year:2001,tmdbId:'100'}});
  net.diary.set(1,diaryPage(lids.map((lid,i)=>diaryRow(lid,8,'2026-11-08','v'+i))));
  let armed=true;bucket.hooks.beforePut=async(key,value)=>{if(armed&&key===RUN&&when(value)){armed=false;throw new Error('worker killed '+label);}};
  const started=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(started.created,true);
  let killed=0,reply;
  for(let i=0;i<30;i++){
   try{reply=plain(await R.step(env,{runId:started.runId}));}catch(error){assert.match(String(error.message),/worker killed/);killed++;clock.now+=4*60000;continue;}
   clock.now+=1000;if(reply.nextAction!=='continue')break;
  }
  assert.equal(killed,1,label+': the step really was killed once');
  const found=ratings(bucket);assert.equal(found.length,1,label+': one event');
  const d=plain(found[0].details);
  assert.equal(d.added.length,25,label+': the visible films');assert.equal(d.more.added,15,label+': the remainder is exact, not doubled');
  assert.equal(d.added.find(f=>f.id==='lid00').title,'Первый',label);assert.equal(d.added.find(f=>f.id==='lid00').tmdb,'100',label);
  assert.equal(found[0].diary.rows,rows,label+': the aggregates keep their existing semantics');
  return {found,bucket};
 };
 // After the facts, before the page checkpoint: the page is read again, its facts are already written (unchanged), the stored plan is the details.
 await crashAt('before the page checkpoint',value=>value?.checkpoint?.diaryPagesRead===1,40);
 // After the page checkpoint, before the step's summary: the step ends with the stored page contribution.
 // (The counters of the page are saved with the step summary, as before this card: that step's counts are the ones a kill loses, never the films.)
 await crashAt('before the step summary',value=>value?.phase==='removal',0);
}

// 1e. AIR-393: a plan is an intent, not a receipt. Only applied contributions reach the event; a replay keeps what the stored view still shows.
{
 const rows=()=>diaryPage([diaryRow('lidA',8,'2026-11-08','v1'),diaryRow('lidU',9,'2026-11-06','v3')]);
 const base=()=>{const s=setup();migrated(s.bucket);s.bucket.set('enrichment/view-index.json',{lidU:{watched:true,actualRating:3}});s.bucket.set('metadata.json',{lidA:{id:'lidA',title:'Фильм А',year:2001,tmdbId:'111'},lidU:{id:'lidU',title:'Фильм У',year:1990,tmdbId:'222'}});s.net.diary.set(1,rows());return s;};
 const stepAll=async(R,env,clock,runId)=>{let reply;for(let i=0;i<30;i++){try{reply=plain(await R.step(env,{runId}));}catch(error){clock.now+=4*60000;continue;}clock.now+=1000;if(reply.nextAction!=='continue')break;}return reply;};
 // (i) A plan with no completed writes: the facts cannot be written, the page fails, the run ends in error. The plan stays a plan; the event has no details.
 {
  const {clock,bucket,env,R,ctx}=base();
  const linksKey=g(ctx,'LetterboxdFacts').FACTS_KEYS.links;
  bucket.hooks.beforePut=async key=>{if(key===linksKey)throw new Error('facts store down');};
  const {runId,reply}=await runOnce(R,env,clock);
  const record=bucket.value(RUN);assert.equal(record.diary.pageChanges?.['1']?.state,'planned','the plan was saved before the facts');
  const found=ratings(bucket);assert.equal(found.length,1);assert.equal(found[0].state,'error');assert.equal(found[0].details,undefined,'a plan that never completed is not an event detail');
 }
 // (ii) A kill after the facts are written and before the page checkpoint, then another writer sets a newer rating for a planned film: the replay
 // finds that write older, so only the effects the stored view still shows are claimed.
 {
  const {clock,bucket,env,R,ctx}=base();
  let armed=true;bucket.hooks.beforePut=async(key,value)=>{if(armed&&key===RUN&&value?.checkpoint?.diaryPagesRead===1){armed=false;throw new Error('worker killed');}};
  const started=plain(await R.start(env,{trigger:'scheduled'}));
  await assert.rejects(()=>R.step(env,{runId:started.runId}),/worker killed/);
  assert.equal(bucket.value(RUN).diary.pageChanges['1'].state,'planned','the plan survived the kill');
  await g(ctx,'LetterboxdFacts').applyDiaryEvidence(env,[{lid:'lidU',watchedDate:'2026-11-09',rating:5,ratingState:'rated',readAt:at(T0)}]);
  clock.now+=4*60000;
  const reply=await stepAll(R,env,clock,started.runId);assert.equal(reply.state,'finished',JSON.stringify(reply));
  const event=ratings(bucket)[0],d=plain(event.details||{});
  eq((d.added||[]).map(f=>f.id),['lidA'],'the new watched fact is still shown');
  assert.equal((d.updated||[]).length,0,'the rating another writer set later is not claimed by this page');
  assert.equal(bucket.value(RUN).diary.pageChanges['1'].state,'applied');
 }
 // (iii) Capture that cannot be made is surfaced, never a complete-looking list: the facts are still written.
 {
  const {clock,bucket,env,R,ctx}=base();
  const viewKey=g(ctx,'LetterboxdFacts').FACTS_KEYS.viewIndex;let reads=0;
  bucket.hooks.beforeGet=async key=>{if(key===viewKey&&++reads===1)throw new Error('view unavailable');};
  const {reply}=await runOnce(R,env,clock);assert.equal(reply.state,'finished',JSON.stringify(reply));
  const event=ratings(bucket)[0];assert.equal(event.diary.written>=1,true,'the facts were written');
  assert.equal(event.details?.incomplete,true,'the event says the list is incomplete');assert.equal(event.details.added,undefined,'and lists nothing it did not capture');
 }
}

// 1f. AIR-393: the remainder is reconciled to confirmed effects across the whole page, not only the 25 shown: a film outside the visible 25 that
// is rejected or loses to a newer write is not counted, on the first attempt and on an interrupted replay.
{
 const ids=Array.from({length:30},(_,i)=>'lid'+String(i).padStart(2,'0')),view=()=>Object.fromEntries(ids.map(id=>[id,{watched:true,actualRating:3}]));
 const newer={lid:'lid27',watchedDate:'2026-11-09',rating:5,ratingState:'rated',readAt:at(T0)};
 const prepare=()=>{const s=setup();migrated(s.bucket);s.bucket.set('enrichment/view-index.json',view());s.net.diary.set(1,diaryPage(ids.map((id,i)=>diaryRow(id,8,'2026-11-08','v'+i))));return s;};
 const check=(event,label)=>{const d=plain(event.details);assert.equal(d.updated.length,25,label);assert.equal(d.more.updated,4,label+': 29 confirmed films, not 30');assert.equal(d.incomplete,undefined,label+': exact, not marked incomplete');assert.equal(d.updated.some(f=>f.id==='lid27'),false,label+': the losing film is not claimed');};
 // First attempt: a newer observation of lid27 already exists, so this page's write is older and is not a change.
 {
  const {clock,bucket,env,R,ctx}=prepare();
  await g(ctx,'LetterboxdFacts').applyDiaryEvidence(env,[newer]);
  const {reply}=await runOnce(R,env,clock);assert.equal(reply.state,'finished',JSON.stringify(reply));
  check(ratings(bucket)[0],'first attempt');
 }
 // Interrupted replay: killed after the facts, then the newer write lands; the replay confirms against the stored view.
 {
  const {clock,bucket,env,R,ctx}=prepare();
  let armed=true;bucket.hooks.beforePut=async(key,value)=>{if(armed&&key===RUN&&value?.checkpoint?.diaryPagesRead===1){armed=false;throw new Error('worker killed');}};
  const started=plain(await R.start(env,{trigger:'scheduled'}));
  await assert.rejects(()=>R.step(env,{runId:started.runId}),/worker killed/);
  const planned=bucket.value(RUN).diary.pageChanges['1'];assert.equal(planned.state,'planned');assert.equal(planned.updated.length,30,'the stored plan keeps every candidate, not 25');
  await g(ctx,'LetterboxdFacts').applyDiaryEvidence(env,[newer]);
  clock.now+=4*60000;let reply;for(let i=0;i<30;i++){reply=plain(await R.step(env,{runId:started.runId}));clock.now+=1000;if(reply.nextAction!=='continue')break;}
  assert.equal(reply.state,'finished',JSON.stringify(reply));check(ratings(bucket)[0],'replay');
 }
 // Past the stored ceiling the count is a lower bound and the event says so.
 {
  const {clock,net,bucket,env,R}=setup();migrated(bucket);
  net.diary.set(1,diaryPage(Array.from({length:120},(_,i)=>diaryRow('big'+String(i).padStart(3,'0'),8,'2026-11-08','b'+i))));
  await runOnce(R,env,clock);
  const d=plain(ratings(bucket)[0].details);assert.equal(d.added.length,25);assert.equal(d.incomplete,true,'more than the ceiling: stated as incomplete');assert.ok(d.more.added>=75,'a lower bound, never less than what is known');
 }
}

// 1g. AIR-393 durability of the removal groups: a step killed after its lookup or its settlement, before anything is confirmed, is recovered
// from the stored intents on the next step; the event names the exact films, once each, and the counters keep their meaning.
{
 const build=()=>{
  const {clock,net,bucket,env,R}=setup();
  const eventAt=at(T0-3*H),k1=eventKeyOf(eventAt,'run-1-watchlist'),eventAt2=at(T0-2*H),k2=eventKeyOf(eventAt2,'run-2-watchlist');
  const removed=['gone0','gone1','gone2','settled1'].map((id,i)=>({id,title:'Удалён '+i,year:2000+i}));
  bucket.set(k1,removalEvent('run-1-watchlist',removed));bucket.set(k2,{...removalEvent('run-2-watchlist',[removed[0]]),at:eventAt2});
  const films={
   gone0:{...queueEntry('gone0',k1,eventAt),refs:[{eventKey:k1,sourceRunId:'run-1',at:eventAt,resolved:false},{eventKey:k2,sourceRunId:'run-2',at:eventAt2,resolved:false}]},
   gone1:queueEntry('gone1',k1,eventAt),gone2:queueEntry('gone2',k1,eventAt),unrated1:queueEntry('unrated1',k1,eventAt),
   // Already rated, reference not yet settled: the batch settlement writes the event.
   settled1:{...queueEntry('settled1',k1,eventAt),state:'rated',rating:3.5,lastResult:'diary',checkedAt:at(T0-H),nextAttemptAt:null},
   // Rated, but its removal event is not stored: the settlement cannot resolve the reference, so nothing may be claimed for it.
   noevent1:{...queueEntry('noevent1','events/items/9999999999999-missing.json',eventAt),state:'rated',rating:3,lastResult:'diary',checkedAt:at(T0-H),nextAttemptAt:null},
  };
  migrated(bucket,{films});for(const id of ['gone0','gone1','gone2'])net.members.set(id,4);net.members.set('unrated1','none');
  bucket.set('enrichment/view-index.json',{lidx:{watched:true,actualRating:4}});net.diary.set(1,diaryPage([diaryRow('lidx',8,'2026-11-08','v1')]));
  return {clock,net,bucket,env,R};
 };
 const resume=async(R,env,clock,runId)=>{let reply;for(let i=0;i<30;i++){try{reply=plain(await R.step(env,{runId}));}catch(error){assert.match(String(error.message),/killed/);clock.now+=4*60000;continue;}clock.now+=1000;if(reply.nextAction!=='continue')break;}return reply;};
 for(const [label,when] of [
  ['after the first lookup, before its checkpoint',value=>value?.checkpoint?.removalChecked===1],
  ['after the batch settlement, before anything is confirmed',value=>Array.isArray(value?.removal?.changeSteps)&&value.removal.changeSteps.some(id=>String(id).startsWith('step:'))],
 ]){
  const {clock,bucket,env,R}=build();
  let armed=true;bucket.hooks.beforePut=async(key,value)=>{if(armed&&key===RUN&&when(value)){armed=false;throw new Error('worker killed '+label);}};
  const started=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(started.created,true);
  let killedOnce=false,reply;
  for(let i=0;i<30;i++){
   try{reply=plain(await R.step(env,{runId:started.runId}));}catch(error){assert.match(String(error.message),/killed/);killedOnce=true;clock.now+=4*60000;continue;}
   clock.now+=1000;if(reply.nextAction!=='continue')break;
  }
  assert.equal(killedOnce,true,label+': the step was killed');assert.equal(reply.state,'finished',label+': '+JSON.stringify(reply));
  const event=ratings(bucket)[0],d=plain(event.details||{});
  eq((d.rated||[]).map(f=>f.id).sort(),['gone0','gone1','gone2'],label+': every rating found by a lookup is named');
  // AIR-443: settling references is service work: not a news line (the counter keeps it), and a film already known (settled1) is not announced again.
  assert.equal(d.resolved,undefined,label+': no list of settled references');assert.equal(JSON.stringify(d).includes('settled1'),false,label+': a rating known earlier is not announced again');
  assert.equal(d.rated.find(f=>f.id==='gone0').title,'Удалён 0',label);
  assert.equal(bucket.value(RUN).removal.intents?.length||0,0,label+': no intent is left behind');
  // Nothing is claimed twice and the queue semantics are unchanged: every reference ended resolved.
  const queue=bucket.value(QUEUE);assert.ok(Object.entries(queue.films).filter(([id])=>id!=='unrated1'&&id!=='noevent1').every(([,entry])=>(entry.refs||[]).every(ref=>ref.resolved===true)),label);
  assert.equal(JSON.stringify(d).includes('unrated1'),false,label+': a looked-up film that was not rated is not claimed (the intent is dropped, the effect never happened)');
  assert.equal(JSON.stringify(d).includes('noevent1'),false,label+': a reference that could not be settled is not claimed');
 }
}

// 1h. AIR-443, the Toy Soldiers case across three runs: day A records a new fact (news), day B removes the film from the watchlist (queued), day C settles the removal
// with the rating that is already known. Day C must not announce the same unchanged rating again, in any list, while the removal event still receives the rating and
// the counters keep their separate measures. A real change of that rating later is news once.
{
 const {clock,net,bucket,env,R}=setup();
 bucket.set('metadata.json',{toy:{id:'toy',title:'Игрушечные солдатики',year:1991,tmdbId:'10750'}});
 net.diary.set(1,diaryPage([diaryRow('toy',7,'2026-11-09','v1')]));
 migrated(bucket);
 const dayA=await runOnce(R,env,clock);assert.equal(dayA.reply.state,'finished');
 let list=ratings(bucket);assert.equal(list.length,1);eq(plain(list[0].details).added.map(f=>[f.id,f.rating]),[['toy',3.5]],'day A: the new fact is the one news line');
 // Day B: the watchlist event registers the removal; the queue holds the film with its reference.
 clock.now+=24*H;const eventAt=at(clock.now-H),eventKey=eventKeyOf(eventAt,'day-b-watchlist');
 bucket.set(eventKey,{...removalEvent('day-b-watchlist',[{id:'toy',title:'Игрушечные солдатики',year:1991}]),at:eventAt});
 migrated(bucket,{films:{toy:{...queueEntry('toy',eventKey,eventAt),enqueuedAt:eventAt,nextAttemptAt:eventAt}}});
 // Day C: the Diary still lists the same viewing; the fact is unchanged and the queued film is settled by it.
 clock.now+=24*H;const dayC=await runOnce(R,env,clock);assert.equal(dayC.reply.state,'finished',JSON.stringify(dayC.reply));
 list=ratings(bucket);assert.equal(list.length,2,'one event per run');
 const eventC=list.find(event=>event.runId===dayC.runId),detailsC=plain(eventC.details||{});
 assert.equal(JSON.stringify(detailsC).includes('toy'),false,'day C names the unchanged rating nowhere: no added, rated or resolved line');
 assert.equal(detailsC.rated,undefined);assert.equal(detailsC.resolved,undefined);assert.equal(detailsC.added,undefined);
 assert.equal(eventC.removal.rated,1,'the aggregate keeps counting the technical work');assert.equal(eventC.removal.resolved,1);assert.equal(eventC.diary.added+eventC.diary.updated+eventC.diary.written,0,'the fact itself was not rewritten');
 assert.equal(JSON.stringify(bucket.value(eventKey)).includes('3.5'),true,'the removal event still receives the rating');
 assert.equal(list.filter(event=>JSON.stringify(event.details||{}).includes('toy')).length,1,'the film is news in exactly one event');
 // A real change of the rating is news once, as an update with the earlier value.
 net.diary.set(1,diaryPage([diaryRow('toy',8,'2026-11-10','v2')]));clock.now+=24*H;
 const dayD=await runOnce(R,env,clock);assert.equal(dayD.reply.state,'finished');
 const detailsD=plain(ratings(bucket).find(event=>event.runId===dayD.runId).details);eq(detailsD.updated.map(f=>[f.id,f.from,f.rating]),[['toy',3.5,4]],'day D: the real change is one update line');assert.equal(detailsD.rated,undefined);
}

// 1i. A run recorded before this change (its stored contribution lists `resolved` and a `rated` film that the same run reported as added) builds the event without the repeats.
{
 const {R}=setup();
 const run={diary:{pageChanges:{1:{state:'applied',added:[{id:'a',rating:4}],updated:[],rated:[{id:'a',rating:4},{id:'b',rating:3}],resolved:[{id:'a',rating:4},{id:'b',rating:3}],more:{resolved:2}}}},removal:{changes:{added:[],updated:[],rated:[],resolved:[{id:'c',rating:2}],more:{}}}};
 const out=plain(R.detailsOf(run));
 {eq(out.details.added.map(f=>f.id),['a']);eq(out.details.rated.map(f=>f.id),['b'],'a film is not listed as rated when the run reported it as added');assert.equal(out.details.resolved,undefined);assert.equal(out.details.more?.resolved,undefined);}
}

// 1d. A repeated merge of the same contribution is ignored, never added again.
{
 const {R}=setup();
 const capped={added:Array.from({length:25},(_,i)=>({id:'x'+i,rating:4})),updated:[],rated:[],resolved:[],more:{added:15}};
 const once=plain(R.mergeChanges(null,capped));eq(once.more,{added:15});
 const run={removal:{}};
 const first=plain(R.removalChangeFields(run,capped,'step-1'));eq(first.changeSteps,['step-1']);eq(first.changes.more,{added:15});
 const again=plain(R.removalChangeFields({removal:first},capped,'step-1'));eq(again.changes.more,{added:15},'the same step is not merged twice');eq(again.changeSteps,['step-1']);
 const other=plain(R.removalChangeFields({removal:first},{added:[],updated:[],rated:[{id:'r',rating:3.5}],resolved:[],more:{}},'step-2'));
 eq(other.changes.rated.map(f=>f.id),['r']);eq(other.changes.more,{added:15},'another step adds its own films');eq(other.changeSteps,['step-1','step-2']);
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
 const record=bucket.value(RUN);assert.equal(record.ratingsEventAt,undefined,'still owed');assert.equal(record.diary.pageChanges['1'].added[0].id,'lidA','the committed record keeps what the event needs');
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
 text=html({incomplete:true});assert.match(text,/Часть изменений не удалось назвать/,'an incomplete capture is stated');assert.doesNotMatch(text,/event-group/);
 text=html({incomplete:true,added:[{id:'a',title:'Фильм А',year:2001,tmdb:null,rating:4}]});assert.match(text,/список неполный/);assert.match(text,/Фильм А \(2001\)/);
 text=html({added:'x',updated:{},rated:[null,1,'s'],more:{rated:-1}});assert.doesNotMatch(text,/event-group/,'malformed details draw nothing');
}
console.log('AIR-393 ratings event details: every group, caps, retry and delivery, checkpoint, no-change and legacy compatibility, links and unknown titles passed');
