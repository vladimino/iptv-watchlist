import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// AIR-270: the post-commit ratings work carries a durable attempt marker; a killed request is closed as `unknown` by the
// next step on the completed run, without repeating the films-list scan.
const records=new Map(),etags=new Map(),fetches=[],logs=[];let revision=0,clock=Date.parse('2026-10-29T10:00:00.000Z');
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix='',cursor,limit=20}={}){const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort();const offset=Number(cursor||0),slice=keys.slice(offset,offset+limit);return {objects:slice.map(key=>({key})),truncated:offset+limit<keys.length,cursor:String(offset+limit)};}
};
function Clock(...args){const date=args.length?new Date(...args):new Date(clock);Object.setPrototypeOf(date,Clock.prototype);return date;}
Clock.prototype=Date.prototype;Clock.now=()=>clock;Clock.parse=Date.parse;Clock.UTC=Date.UTC;
const page=films=>`<h1 title="${films.length}&nbsp;films"></h1>`+films.map(film=>`<li class="griditem"><div data-postered-identifier='{&quot;lid&quot;:&quot;${film.id}&quot;}'></div><span class="rating rated-${film.stars}"></span></li>`).join('');
let filmsResponse=()=>({ok:true,status:200,text:async()=>page([{id:'w1',stars:8}])}),phaseAtFilms=null;
const ctx=vm.createContext({Response,Request,URL,Date:Clock,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,setTimeout:fn=>fn(),
 console:{...console,log:line=>logs.push(String(line))},
 fetch:async url=>{
  url=String(url);fetches.push(url);
  if(url.includes('/films/')){phaseAtFilms=records.get('sync.json')?.ratingAttempt?.phase;return filmsResponse();}
  if(url.includes('/diary/'))return {ok:true,status:200,text:async()=>'<html>no diary table</html>'};
  return {ok:false,status:404,text:async()=>''};
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};
const STALE=vm.runInContext('RATINGS_ATTEMPT_STALE_MS',ctx);
const at=new Date(clock).toISOString();
const report=runId=>({runId,updatedAt:at,watchlistCount:1,films:[{id:'w1',title:'W',year:2020,shows:[]}],stats:{}});
const newRun=runId=>({runId,stage:'epg',events:[{id:runId+'-watchlist',type:'watchlist',at,total:1,baseline:false,added:[],removed:[]},{id:runId+'-epg',type:'epg',at,films:1,archive:0,future:0,broadcasts:0}],ratingPending:['public-films-list'],watchlist:report(runId).films,pending:[]});
const sync=()=>records.get('sync.json');
const phases=()=>logs.map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(entry=>entry?.event==='epg_ratings_phase').map(entry=>entry.phase);
const lbFetches=()=>fetches.filter(url=>url.includes('letterboxd.com'));
const step=async runId=>{const trace={caller:'http',diagnostic:{}};try{await ctx.syncStep(env,'/api/sync/epg',{runId},trace);}catch{}return trace;};
const snapshot=()=>JSON.stringify([...records.entries()].filter(([key])=>key.startsWith('events/')||key==='programme.json').sort());

// 1. A successful scan: each phase is saved before it starts, the films list runs in phase films_list, the attempt finishes.
records.set('programme.json',report('run-ok'));
await ctx.completeWithRatings(env,newRun('run-ok'),report('run-ok'));
assert.equal(phaseAtFilms,'films_list','the phase is durable before the films list is requested');
assert.deepEqual(phases(),['post_commit','films_list']);
assert.equal(sync().ratingAttempt.state,'finished');
assert.equal(sync().ratingPending,undefined);
assert.ok(sync().ratingObservedAt);
assert.equal(typeof sync().ratingAttempt.id,'string');

// 2. A 403: the attempt ends as `error` with cause `blocked`; the error stays interpretable and is not a success.
logs.length=0;fetches.length=0;
filmsResponse=()=>({ok:false,status:403,text:async()=>'<title>Just a moment...</title>'});
await ctx.completeWithRatings(env,newRun('run-403'),report('run-403'));
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.cause,sync().ratingAttempt.phase],['error','blocked','repair']);
assert.match(sync().ratingError,/HTTP 403/);
assert.ok(sync().ratingAttempt.finishedAt);
assert.deepEqual(phases(),['post_commit','films_list','repair']);
assert.equal(lbFetches().filter(url=>url.includes('/films/')).length,3,'the existing three tries inside the one scan, no more');
const status=await ctx.syncStatus(env);
assert.equal(status.ratingAttempt.state,'error');

// 2b. Killed during the repairs after a 403: the attempt is still `started` (list outcome known, attempt not), so the
// next stale step closes it as unknown, keeps the list error and requests nothing from Letterboxd.
logs.length=0;fetches.length=0;records.set('programme.json',report('run-repair'));
let repairPhase=null;
const originalRepair=ctx.repairRemovedBaselineRatings;
ctx.repairRemovedBaselineRatings=async()=>{repairPhase=structuredClone(records.get('sync.json').ratingAttempt);throw Object.assign(new Error('isolate killed'),{kill:true});};
// Emulate the kill: the repair hook records what was durable, then the request ends before anything else is written.
const killDuringRepair=newRun('run-repair');
const realSave=bucket.put;let stopped=false;
bucket.put=async function(key,value,options){if(stopped)throw new Error('isolate gone');return realSave.call(this,key,value,options);};
const repairHook=ctx.repairRemovedBaselineRatings;
ctx.repairRemovedBaselineRatings=async(...args)=>{try{return await repairHook(...args);}finally{stopped=true;}};
try{await ctx.completeWithRatings(env,killDuringRepair,report('run-repair'));}catch{}
bucket.put=realSave;ctx.repairRemovedBaselineRatings=originalRepair;
assert.deepEqual([repairPhase.state,repairPhase.phase,repairPhase.listCause],['started','repair','blocked'],'still recoverable during the repairs');
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.phase],['started','repair']);
assert.match(sync().ratingError,/HTTP 403/);
clock+=STALE+1;fetches.length=0;
await step('run-repair');
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.interruptedPhase,sync().ratingAttempt.listCause],['unknown','repair','blocked']);
assert.equal(sync().ratingPending,undefined);
assert.match(sync().ratingError,/interrupted during repair; no outcome recorded; films list: Letterboxd films HTTP 403/);
assert.equal(lbFetches().length,0,'closing never retries Letterboxd');

// 3. Killed after the commit, before the films list: finishSync saved `stage: complete` with the attempt in post_commit.
logs.length=0;fetches.length=0;records.set('programme.json',report('run-kill'));
const killed=newRun('run-kill');
killed.ratingAttempt={id:'attempt-kill',state:'started',startedAt:at};
await vm.runInContext('ratingsPhase',ctx)(env,killed,'post_commit',false);
await ctx.finishSync(env,killed,report('run-kill'));
assert.deepEqual([sync().stage,sync().ratingAttempt.state,sync().ratingAttempt.phase],['complete','started','post_commit']);
assert.deepEqual(sync().ratingPending,['public-films-list']);
const beforeRecovery=snapshot();
// A step inside the stale window leaves a possibly running attempt alone.
clock+=STALE-1000;fetches.length=0;
await step('run-kill');
assert.equal(sync().ratingAttempt.state,'started');
assert.deepEqual(sync().ratingPending,['public-films-list']);
// Past the window the next step closes it as unknown, names the phase, and requests nothing from Letterboxd.
clock+=2000;
const trace=await step('run-kill');
assert.equal(trace.branch,'continuation');
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.cause,sync().ratingAttempt.interruptedPhase],['unknown','interrupted','post_commit']);
assert.equal(sync().ratingPending,undefined,'no endless pending');
assert.match(sync().ratingError,/interrupted during post_commit/);
assert.equal(lbFetches().length,0,'recovery never repeats the films list');
assert.equal(snapshot(),beforeRecovery,'no new EPG generation or event');
// Idempotent: further steps change nothing and request nothing.
const closed=JSON.stringify(sync());
for(let i=0;i<5;i++){clock+=STALE;await step('run-kill');}
assert.equal(JSON.stringify(sync()),closed);
assert.equal(lbFetches().length,0,'no runaway retries');

// 4. Killed during the films list: the closure names films_list.
records.set('sync.json',{...structuredClone(sync()),runId:'run-films',ratingPending:['public-films-list'],ratingError:undefined,ratingAttempt:{id:'attempt-films',state:'started',startedAt:at,phase:'films_list',at:new Date(clock).toISOString()}});
clock+=STALE+1;fetches.length=0;
await step('run-films');
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.interruptedPhase],['unknown','films_list']);
assert.equal(lbFetches().length,0);

// 5. A run written before this change (pending, no marker) is closed the same way once stale.
records.set('sync.json',{runId:'run-legacy',stage:'complete',updatedAt:new Date(clock).toISOString(),ratingPending:['public-films-list'],events:[]});
await step('run-legacy');
assert.equal(sync().ratingAttempt,undefined,'fresh legacy run untouched');
clock+=STALE+1;
await step('run-legacy');
assert.deepEqual([sync().ratingAttempt.state,sync().ratingAttempt.interruptedPhase],['unknown','not_recorded']);
assert.equal(sync().ratingPending,undefined);

// 6. Finished or failed attempts are never reopened by a step.
for(const state of ['finished','error']){
 records.set('sync.json',{runId:'run-'+state,stage:'complete',updatedAt:new Date(clock-10*STALE).toISOString(),ratingPending:['public-films-list'],ratingAttempt:{id:'a',state,phase:'repair',at:new Date(clock-10*STALE).toISOString()}});
 await step('run-'+state);
 assert.equal(sync().ratingAttempt.state,state);
 assert.deepEqual(sync().ratingPending,['public-films-list']);
}
assert.equal(lbFetches().length,0);

console.log('EPG ratings attempt (AIR-270): durable phases before work, finished and blocked outcomes, killed attempt kept while fresh and closed as unknown once stale with its phase, no films-list repeat, no new generation or events, idempotent steps, legacy runs closed, finished attempts untouched passed');
