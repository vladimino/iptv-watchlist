// AIR-543 / ADR 0179. The daily poster cron: weekly sweep on the first firing of a week, pending-only otherwise, one shared core with the owner
// route, one R2 checkpoint with a bounded outbox, idle = one read and no write, owed events replayed without TMDB, and the pure projection that the
// Monitor, the owner health read and the footer all use.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {migrated, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as W from '../src/catalog-poster-weekly.js';

// ---------- pure: week arithmetic, validity, plan, projection ----------
const T=s=>Date.parse(s);
assert.equal(W.weekStart(T('2026-11-19T10:00:00Z')),'2026-11-15T00:00:00.000Z','Thursday belongs to the week that started Sunday 15 November');
assert.equal(W.weekStart(T('2026-11-15T03:24:00Z')),'2026-11-15T00:00:00.000Z');
assert.equal(W.weekStart(T('2026-11-14T23:59:59Z')),'2026-11-08T00:00:00.000Z','Saturday night is still the old week');
assert.equal(new Date(W.nextFiring(T('2026-11-19T10:00:00Z'))).toISOString(),'2026-11-20T03:24:00.000Z');
assert.equal(new Date(W.nextFiring(T('2026-11-19T01:00:00Z'))).toISOString(),'2026-11-19T03:24:00.000Z');
assert.equal(W.CRON,'24 3 * * *');
assert.equal(W.eventId('2026-11-15T00:00:00.000Z','final'),'catalog_posters-2026-11-15-final');

const ok=(over={})=>({schemaVersion:1,runId:'catalog_posters-2026-11-15',weekStart:'2026-11-15T00:00:00.000Z',status:'completed',lastScheduledAt:'2026-11-15T03:24:00.000Z',lastAttemptAt:'2026-11-15T03:24:00.000Z',lastCompletedAt:'2026-11-15T03:24:00.000Z',cursor:null,nextRetryAt:null,retryAttempts:0,rateLimitStreak:0,deferredReported:false,summary:{hydrated:0},outbox:[],...over});
const entry=(id,at,delivered=null)=>({id,at,payload:{type:'catalog_posters'},deliveredAt:delivered});
assert.ok(W.parseCheckpoint(ok()),'a complete completed record is valid');
for(const [name,over] of Object.entries({
 'wrong schema':{schemaVersion:2},'completed without lastCompletedAt':{lastCompletedAt:null},'pending without nextRetryAt':{status:'pending',nextRetryAt:null},
 'pending without lastAttemptAt':{status:'pending',nextRetryAt:'2026-11-16T03:24:00.000Z',lastAttemptAt:null},'running without lastAttemptAt':{status:'running',lastAttemptAt:null},
 'failed without lastAttemptAt':{status:'failed',lastAttemptAt:null},'unparseable weekStart':{weekStart:'nope'},'unknown status':{status:'weird'},
 'outbox over the cap':{outbox:Array.from({length:9},(_,i)=>entry('e'+i,'2026-11-15T03:24:00.000Z'))},'outbox entry without payload':{outbox:[{id:'x',at:'2026-11-15T03:24:00.000Z',deliveredAt:null}]},
 'negative attempts':{retryAttempts:-1}
}))assert.equal(W.parseCheckpoint(ok(over)),null,name+' is invalid, never trusted');
assert.equal(W.parseCheckpoint([]),null);assert.equal(W.parseCheckpoint(null),null);

// plan
assert.equal(W.plan(null,T('2026-11-17T03:24:00Z')),'sweep','an absent checkpoint bootstraps on any day');
assert.equal(W.plan(ok(),T('2026-11-16T03:24:00Z')),'idle','Monday, week already reported: idle');
assert.equal(W.plan(ok(),T('2026-11-22T03:24:00Z')),'sweep','the first firing of the next week sweeps');
assert.equal(W.plan(ok({weekStart:'2026-11-08T00:00:00.000Z'}),T('2026-11-16T03:24:00Z')),'sweep','a missed Sunday is caught up on Monday');
const pending=ok({status:'pending',nextRetryAt:'2026-11-16T03:00:00.000Z',lastAttemptAt:'2026-11-15T03:24:00.000Z'});
assert.equal(W.plan(pending,T('2026-11-16T03:24:00Z')),'resume');
assert.equal(W.plan(ok({...pending,nextRetryAt:'2026-11-16T12:00:00.000Z'}),T('2026-11-16T03:24:00Z')),'idle','pending but not due: idle');
assert.equal(W.plan(ok({status:'failed',lastAttemptAt:'2026-11-15T03:24:00.000Z'}),T('2026-11-17T03:24:00Z')),'idle','a failed week is not retried until the next week');

// projection: first true predicate wins; Monitor vocabulary is healthy|waiting|delayed|degraded (ADR 0206: a failed run is degraded and critical)
const P=(read,markers,nowMs,monitorOn=true)=>W.project({read,markers,nowMs,monitorOn});
const absent={status:'absent',checkpoint:null},valid=cp=>({status:'ok',checkpoint:cp});
const NOW=T('2026-11-17T10:00:00Z');
assert.deepEqual([P({status:'invalid',checkpoint:null},{},NOW).state,P({status:'invalid',checkpoint:null},{},NOW).monitor],['unknown','degraded'],'corrupt is a fault, never green');
assert.equal(P({status:'unreadable',checkpoint:null},{},NOW).state,'unknown');
assert.equal(P(absent,{seenAt:'2026-11-08T00:00:00Z'},NOW).state,'lost','absent after it was ever seen is lost, not a new grace');
assert.equal(P(absent,{seenAt:'2026-11-08T00:00:00Z',baselineAt:new Date(NOW).toISOString()},NOW).state,'lost','a fresh baseline cannot re-arm grace after a seen checkpoint');
assert.equal(P(absent,{},NOW,false).state,'unknown','monitor off with no checkpoint: unknown');
let g=P(absent,{baselineAt:'2026-11-17T08:00:00Z'},NOW);assert.deepEqual([g.state,g.monitor],['grace','healthy']);
assert.equal(P(absent,{baselineAt:'2026-11-17T08:00:00Z'},T('2026-11-19T05:23:00Z')).state,'grace','still inside bootstrapDue (18th 03:24) + 26h');
let o=P(absent,{baselineAt:'2026-11-17T08:00:00Z'},T('2026-11-19T06:00:00Z'));assert.deepEqual([o.state,o.monitor],['overdue','delayed'],'absence cannot grant indefinite grace');
o=P(absent,{baselineAt:'2026-11-17T08:00:00Z'},T('2026-11-19T09:00:00Z'));assert.equal(o.monitor,'degraded','delayed first, then degraded');
let r=P(valid(ok()),{},NOW);assert.deepEqual([r.state,r.monitor],['healthy_idle','healthy']);
r=P(valid(ok({status:'failed'})),{},NOW);assert.deepEqual([r.state,r.monitor,r.critical],['failed','degraded',true]);
r=P(valid(ok({retryAttempts:6,status:'pending',nextRetryAt:'2026-11-17T09:00:00.000Z'})),{},NOW);assert.equal(r.state,'failed','retry exhaustion');
r=P(valid(ok({rateLimitStreak:2})),{},NOW);assert.equal(r.state,'failed','persistent 429');
r=P(valid(ok({status:'pending',nextRetryAt:'2026-11-18T03:00:00.000Z',lastAttemptAt:'2026-11-17T03:24:00.000Z'})),{},NOW);assert.deepEqual([r.state,r.monitor],['waiting','waiting'],'a legitimate backoff is not a fault');
r=P(valid(ok({status:'pending',nextRetryAt:'2026-11-15T10:00:00.000Z',lastAttemptAt:'2026-11-15T03:24:00.000Z'})),{},NOW);assert.deepEqual([r.state,r.monitor],['stalled','degraded'],'the due resumption did not happen');
r=P(valid(ok({status:'running',lastAttemptAt:'2026-11-17T09:00:00.000Z'})),{},NOW);assert.equal(r.state,'waiting','a fresh run in progress');
r=P(valid(ok({status:'running',lastAttemptAt:'2026-11-17T05:00:00.000Z'})),{},NOW);assert.equal(r.state,'stalled','a run older than its budget');
const full=Array.from({length:8},(_,i)=>entry('e'+i,'2026-11-17T09:00:00.000Z'));
r=P(valid(ok({outbox:full})),{},NOW);assert.deepEqual([r.state,r.monitor],['stalled','degraded'],'a full undelivered outbox is stalled even with status=completed');
r=P(valid(ok({outbox:[entry('old','2026-11-15T03:24:00.000Z')]})),{},NOW);assert.equal(r.state,'stalled','an undelivered entry older than 52 h');
r=P(valid(ok({outbox:[entry('fresh','2026-11-17T09:00:00.000Z')]})),{},NOW);assert.equal(r.state,'healthy_idle','a fresh undelivered entry is not yet a fault');
r=P(valid(ok({outbox:full.map(e=>({...e,deliveredAt:'2026-11-17T09:30:00.000Z'}))})),{},NOW);assert.equal(r.state,'healthy_idle','recovery after delivery');
// the week's sweep receipt: Sunday 22 Nov 03:24 + 26 h = Monday 05:24
const NEXTWEEK=ok({weekStart:'2026-11-15T00:00:00.000Z'});
assert.equal(P(valid(NEXTWEEK),{},T('2026-11-23T05:00:00Z')).state,'healthy_idle','the previous receipt before the new week grace expires');
r=P(valid(NEXTWEEK),{},T('2026-11-23T06:00:00Z'));assert.deepEqual([r.state,r.monitor],['overdue','delayed'],'no receipt for the new week');
assert.equal(P(valid(NEXTWEEK),{},T('2026-11-23T08:00:00Z')).monitor,'degraded');
r=P(valid(ok({weekStart:'2026-11-22T00:00:00.000Z'})),{},T('2026-11-23T06:00:00Z'));assert.equal(r.state,'healthy_idle');
assert.ok(P(valid(ok()),{},NOW).nextExpectedAt,'a next expected time is exposed');

// ---------- integration: the Worker with the real core ----------
const records=new Map(),etags=new Map();let revision=0,puts=[],gets=[],fetches=[],tmdb={},failEventPuts=0;
const bucket={
 async get(key){gets.push(key);return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(key.startsWith('events/items/')&&failEventPuts>0){failEventPuts--;throw new Error('event put failed');}
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key,customMetadata:{}})),truncated:false};}
};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console:{log(){},error(){},warn(){}},setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
 fetch:async input=>{
  const url=String(input instanceof Request?input.url:input);fetches.push(url);
  const match=url.match(/^https:\/\/api\.themoviedb\.org\/3\/movie\/(\d+)\?language=ru-RU$/);
  const reply=match?tmdb[match[1]]:null;
  if(typeof reply==='function')return reply();
  if(!reply)return new Response('unexpected',{status:599});
  return new Response(JSON.stringify(reply),{status:200});
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);
for(const file of ['src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
vm.runInContext(scoped('src/catalog-poster-weekly.js','CatalogPosterWeekly'),context);
// AIR-604: the shared upstream cooldown module is in scope from the start, as in the bundle; this file's `env` has no DB, so it reads `off` everywhere except the section that adds one.
vm.runInContext(scoped('src/upstream-cooldown.js','UpstreamCooldown'),context);
for(const file of ['src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const worker=context.worker;
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
const G1='11111111-1111-4111-8111-111111111111',LIVE='epg/discovered-films.json',COPY='epg/generations/'+G1+'/discovered-films.json',LEASE='epg/resolver-lease.json',POINTER='epg/published-generation.json',NEG='epg/catalog-poster-negatives.json',CP=W.CHECKPOINT_KEY;
const POSTER='https://image.tmdb.org/t/p/w342';
const film=(id,tmdbId,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,original:'Original '+id,year:2001,runtime:100,genres:['Драма'],poster:null,url:'https://www.themoviedb.org/movie/'+tmdbId,...extra});
function seed(films){
 records.clear();etags.clear();puts=[];gets=[];fetches=[];failEventPuts=0;
 for(const key of [LIVE,COPY]){records.set(key,structuredClone(films));etags.set(key,'seed-'+key);}
 records.set(POINTER,{programmeRunId:G1,phase:'published'});etags.set(POINTER,'p1');
}
const catalog=()=>({tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),tmdb_3:film('tmdb_3',3),tmdb_5:film('tmdb_5',5,{canonicalIdentity:null}),tmdb_6:film('tmdb_6',6)});
const TMDB=()=>({1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null},4:()=>new Response('boom',{status:500}),5:{id:5,poster_path:'/five.jpg'},6:{id:66,poster_path:'/other.jpg'}});
const fire=async(cron,iso)=>{const waits=[];await worker.scheduled({cron,scheduledTime:Date.parse(iso)},env,{waitUntil(p){waits.push(p);}});await Promise.all(waits);};
const daily=iso=>fire('24 3 * * *',iso);
const cp=()=>records.get(CP);
const eventKeys=()=>[...records.keys()].filter(k=>k.startsWith('events/items/'));
const cpPuts=()=>puts.filter(k=>k===CP).length;

// 1. The first firing (bootstrap, absent checkpoint) sweeps: hydrates a real poster, remembers a no-poster verdict, never asks about an unverified or mismatching identity.
seed(catalog());tmdb=TMDB();
await daily('2026-11-15T03:24:00Z');
assert.equal(records.get(LIVE).tmdb_1.poster,POSTER+'/one.jpg','a poster that appeared is written through the shared guarded core');
assert.equal(records.get(COPY).tmdb_1.poster,POSTER+'/one.jpg');
assert.equal(records.get(LIVE).tmdb_5.poster,null,'an unverified identity is never sent to TMDB');
assert.ok(!fetches.some(u=>u.includes('/movie/5?')),'no TMDB request for the unverified identity');
assert.equal(records.get(NEG).entries['3'].status,'no_poster_on_tmdb','no poster again: held 90 days');
assert.equal(records.get(NEG).entries['6'].status,'tmdb_id_mismatch');
assert.equal(cp().status,'completed');assert.equal(cp().weekStart,'2026-11-15T00:00:00.000Z');assert.equal(cp().summary.hydrated,1);
assert.equal(cpPuts(),2,'a successful week is exactly two checkpoint writes (result + delivered mark)');
assert.equal(eventKeys().length,1,'one final event');
const ev=records.get(eventKeys()[0]);assert.equal(ev.id,'catalog_posters-2026-11-15-final');assert.equal(ev.type,'catalog_posters');assert.equal(ev.outcome,'completed');assert.equal(ev.hydrated,1);assert.equal(ev.noPoster,1);
assert.ok(cp().outbox.every(e=>e.deliveredAt),'the event was marked delivered');

// 2. An idle firing (Monday, nothing pending or owed) is one read of the checkpoint and no write and no TMDB.
puts=[];gets=[];fetches=[];
await daily('2026-11-16T03:24:00Z');
assert.deepEqual(puts,[],'an idle firing writes nothing');assert.deepEqual(fetches,[],'an idle firing asks TMDB nothing');
assert.deepEqual(gets,[CP],'an idle firing reads only the checkpoint');

// 3. Overlapping or repeated firing on the same day is the same no-op.
await daily('2026-11-16T03:24:00Z');assert.deepEqual(puts,[]);assert.deepEqual(fetches,[]);

// 4. Next Sunday: the held no-poster verdict is not due (90 days), a new week sweeps with zero due and still reports once.
puts=[];fetches=[];
await daily('2026-11-22T03:24:00Z');
assert.deepEqual(fetches,[],'a held verdict and a remembered mismatch cost no TMDB request');
assert.equal(cpPuts(),2);assert.equal(eventKeys().length,2,'one report per week, even with nothing due');
assert.ok(!puts.includes(LIVE)&&!puts.includes(COPY)&&!puts.includes(NEG),'no domain write for a zero-due week');
assert.equal(records.get(eventKeys()[0].replace(/.*/,k=>k)).final,true);

// 5. A due verdict (90..97 days later) is checked on the weekly cadence and a poster that appeared is hydrated.
{
 const stored=records.get(NEG);stored.entries['3'].nextCheckAt='2026-11-01T00:00:00.000Z';records.set(NEG,stored);
 tmdb[3]={id:3,poster_path:'/three.jpg'};fetches=[];
 await daily('2026-11-29T03:24:00Z');
 assert.equal(records.get(LIVE).tmdb_3.poster,POSTER+'/three.jpg','an expired verdict is retried and the new poster reaches D1/catalog');
 assert.equal(records.get(NEG).entries['3'],undefined,'a hydrated record leaves the negative index');
}

// 6. A busy resolver lease defers the week (not skipped), emits one deferred report, and the next daily firing resumes and completes.
seed(catalog());tmdb=TMDB();records.set(LEASE,{id:'discovery',expiresAt:Date.parse('2026-11-15T05:00:00Z')});etags.set(LEASE,'l1');
const realNow=Date.now;
{
 // the lease expiry is compared with the real clock inside the core: keep it in the future for the first firing
 records.set(LEASE,{id:'discovery',expiresAt:Date.now()+3600000});
 await daily('2026-11-15T03:24:00Z');
 assert.equal(cp().status,'pending','a busy lease is a wait, not a skipped week');
 assert.equal(cp().summary.deferredBusy,1);assert.equal(cp().retryAttempts,1);
 assert.deepEqual(fetches,[],'busy: TMDB is not asked');
 assert.equal(eventKeys().length,1);assert.equal(records.get(eventKeys()[0]).outcome,'deferred');assert.equal(records.get(eventKeys()[0]).final,false,'a deferred report is never terminal success');
 records.delete(LEASE);etags.delete(LEASE);puts=[];
 await daily('2026-11-16T03:24:00Z');
 assert.equal(cp().status,'completed','the next daily firing resumes and completes');
 const keys=eventKeys();assert.equal(keys.length,2,'deferred then final: at most two events a week');
 assert.deepEqual(keys.map(k=>records.get(k).id).sort(),['catalog_posters-2026-11-15-deferred','catalog_posters-2026-11-15-final']);
 assert.equal(records.get(LIVE).tmdb_1.poster,POSTER+'/one.jpg');
}

// 7. 429 with Retry-After: no no-poster verdict is stored, the resume waits for the TMDB time, and a due firing before it stays idle.
seed(catalog());tmdb=TMDB();tmdb[3]=()=>new Response('slow',{status:429,headers:{'Retry-After':'172800'}});
await daily('2026-11-15T03:24:00Z');
assert.equal(cp().status,'pending');assert.equal(cp().rateLimitStreak,1);
assert.ok(Date.parse(cp().nextRetryAt)>=Date.now()+170000*1000-5000||Date.parse(cp().nextRetryAt)>Date.parse('2026-11-15T03:24:00Z'),'Retry-After is honoured');
assert.equal(records.get(NEG)?.entries?.['3'],undefined,'a 429 is never a no-poster verdict');
puts=[];fetches=[];
await daily('2026-11-16T03:24:00Z');
assert.deepEqual(fetches,[],'resume is not attempted before nextRetryAt');assert.deepEqual(puts,[]);

// 8. 5xx / timeout on one record: it stays due without a 90-day penalty, the cursor does not pass it, the attempts are counted.
seed({...catalog(),tmdb_4:film('tmdb_4',4)});tmdb=TMDB();
await daily('2026-11-15T03:24:00Z');
assert.equal(cp().status,'pending');assert.equal(cp().retryAttempts,1);assert.equal(records.get(NEG).entries['4'],undefined,'a 5xx is not a no-poster verdict');
tmdb[4]={id:4,poster_path:'/four.jpg'};
await daily('2026-11-16T03:24:00Z');
assert.equal(cp().status,'completed');assert.equal(records.get(LIVE).tmdb_4.poster,POSTER+'/four.jpg');

// 9. Retry exhaustion: after the cap the run is failed (degraded, critical) and a failed week is not retried until the next week.
seed({...catalog(),tmdb_4:film('tmdb_4',4)});tmdb=TMDB();
for(let day=15;day<22;day++){await daily('2026-11-'+day+'T03:24:00Z');if(cp().status==='failed')break;}
assert.equal(cp().status,'failed');assert.equal(cp().retryAttempts,W.RETRY_CAP);
assert.equal(W.project({read:{status:'ok',checkpoint:W.parseCheckpoint(cp())},nowMs:Date.parse('2026-11-21T10:00:00Z')}).monitor,'degraded');
assert.ok(eventKeys().some(k=>records.get(k).outcome==='failed'),'a failed week reports a failed event');

// 10. A lost event put leaves the entry owed; the next firing replays the SAME key and payload without TMDB (frozen `at`).
seed(catalog());tmdb=TMDB();failEventPuts=1;
await daily('2026-11-15T03:24:00Z');
assert.equal(eventKeys().length,0,'the put failed');assert.equal(cp().status,'completed');assert.equal(cp().outbox.length,1);assert.equal(cp().outbox[0].deliveredAt,null,'owed');
const frozen=JSON.stringify(cp().outbox[0]);fetches=[];puts=[];
await daily('2026-11-16T03:24:00Z');
assert.deepEqual(fetches,[],'replaying an owed event never asks TMDB');
assert.equal(eventKeys().length,1);const replayed=records.get(eventKeys()[0]);assert.equal(replayed.at,JSON.parse(frozen).at,'the frozen at is kept, so the key is stable');
assert.ok(cp().outbox[0].deliveredAt,'delivered and marked');

// 11. Deferred put lost, then the sweep completes: the final report does not overwrite the undelivered deferred report; both are delivered.
seed(catalog());tmdb=TMDB();records.set(LEASE,{id:'discovery',expiresAt:Date.now()+3600000});etags.set(LEASE,'l1');failEventPuts=1;
await daily('2026-11-15T03:24:00Z');
assert.equal(cp().outbox.length,1);assert.equal(cp().outbox[0].deliveredAt,null);
records.delete(LEASE);
await daily('2026-11-16T03:24:00Z');
assert.equal(eventKeys().length,2,'both the deferred and the final report exist');
assert.ok(cp().outbox.every(e=>e.deliveredAt));

// 12. Week supersession: an undelivered entry survives the Sunday rotation and is delivered first.
seed(catalog());tmdb=TMDB();failEventPuts=1;
await daily('2026-11-15T03:24:00Z');assert.equal(eventKeys().length,0);
failEventPuts=0;
await daily('2026-11-22T03:24:00Z');
assert.deepEqual(eventKeys().map(k=>records.get(k).id).sort(),['catalog_posters-2026-11-15-final','catalog_posters-2026-11-22-final'],'last week report was delivered before the rotation and nothing disappeared');

// 13. A full undelivered outbox stops new work and never asks TMDB; a corrupt checkpoint does the same.
seed(catalog());tmdb=TMDB();
records.set(CP,ok({outbox:Array.from({length:8},(_,i)=>entry('e'+i,'2026-11-15T03:24:00.000Z'))}));etags.set(CP,'c1');failEventPuts=99;
await daily('2026-11-23T03:24:00Z');assert.deepEqual(fetches,[],'a full outbox: no TMDB');
seed(catalog());tmdb=TMDB();records.set(CP,{schemaVersion:1,status:'pending'});etags.set(CP,'c1');
await daily('2026-11-16T03:24:00Z');assert.deepEqual(fetches,[],'a corrupt checkpoint: no TMDB and no repair');assert.deepEqual(puts,[],'a corrupt checkpoint is not rewritten');

// 14. CAS race on the checkpoint: a concurrent writer wins; this firing writes nothing over it, and the next firing converges (hydration is idempotent).
seed(catalog());tmdb=TMDB();
{
 const original=bucket.put;let raced=false;
 bucket.put=async(key,value,options)=>{if(key===CP&&!raced){raced=true;records.set(CP,ok({weekStart:'2026-11-15T00:00:00.000Z',status:'completed'}));etags.set(CP,'other');}return original(key,value,options);};
 await daily('2026-11-15T03:24:00Z');bucket.put=original;
 assert.equal(etags.get(CP),'other','the concurrent writer was not overwritten');
 fetches=[];await daily('2026-11-16T03:24:00Z');assert.deepEqual(fetches,[],'converged: nothing more to do');
}

// 15. Cron routing: the daily poster cron touches only poster keys and never the other schedules' work; the other crons never touch the checkpoint.
seed(catalog());tmdb=TMDB();
await fire('0 * * * *','2026-11-15T03:00:00Z');await fire('1-59/2 * * * *','2026-11-15T03:01:00Z');
assert.ok(!puts.includes(CP),'the hourly and fast crons never run the poster sweep');assert.ok(!fetches.some(u=>u.includes('/movie/')),'and never ask TMDB about posters');
puts=[];await daily('2026-11-15T03:24:00Z');
assert.ok(puts.every(k=>[CP,NEG,LIVE,COPY,LEASE].includes(k)||k.startsWith('events/items/')),'the poster cron writes only poster, lease, checkpoint and event keys');

// 16. The admission seed: complete detail with poster_path null is remembered with no second request; every incomplete shape is not.
{
 const seedOf=movie=>context.catalogPosterSeedNegative(env,movie);
 seed({});fetches=[];
 let result=await seedOf({id:77,title:'T',poster_path:null});
 assert.equal(result.seeded,true);assert.equal(records.get(NEG).entries['77'].status,'no_poster_on_tmdb');assert.equal(fetches.length,0,'no second TMDB request');
 const checked=Date.parse(records.get(NEG).entries['77'].checkedAt),next=Date.parse(records.get(NEG).entries['77'].nextCheckAt);assert.equal(next-checked,90*86400000,'90 days');
 for(const [name,movie] of Object.entries({'poster present':{id:78,title:'T',poster_path:'/x.jpg'},'poster key missing':{id:79,title:'T'},'no id':{title:'T',poster_path:null},'no title':{id:80,poster_path:null},'bad id':{id:'x1',title:'T',poster_path:null},'poster undefined':{id:81,title:'T',poster_path:undefined},'poster empty string':{id:82,title:'T',poster_path:''},'not an object':null})){
  puts=[];result=await seedOf(movie);assert.equal(result.seeded,false,name);assert.deepEqual(puts,[],name+' writes nothing');
 }
 puts=[];result=await seedOf({id:77,title:'T',poster_path:null});assert.equal(result.reason,'known');assert.deepEqual(puts,[],'a known id is left alone');
 records.set(NEG,{schemaVersion:1,entries:{'5':{status:'tmdb_id_mismatch',checkedAt:'2026-11-01T00:00:00.000Z'}}});
 result=await seedOf({id:5,title:'T',poster_path:null});assert.equal(records.get(NEG).entries['5'].status,'tmdb_id_mismatch','a remembered mismatch is never overwritten');
 records.set(NEG,{garbage:true});puts=[];result=await seedOf({id:90,title:'T',poster_path:null});assert.equal(result.seeded,false);assert.equal(result.reason,'unreadable');assert.deepEqual(puts,[],'an unreadable index never blocks and is never repaired');
 const throwing={BUCKET:{async get(){throw new Error('r2 down');},async put(){throw new Error('r2 down');}}};
 result=await context.catalogPosterSeedNegative(throwing,{id:91,title:'T',poster_path:null});assert.equal(result.seeded,false,'an index failure never throws into the admission');
}
// AIR-604 (ADR 0211 decision 5): an enforced TMDB cooldown. The firing sends no TMDB request, waits for the cooldown end, and charges neither a retry attempt nor the rate-limit streak
// (a real 429, section 7, still charges both). It writes no no-poster verdict.
{
 const file=migrated();sql(file,`INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'enforce', 1, ${Date.now()})`);
 const until=Date.now()+1800*1000;// the module reads the real clock; the firing's scheduledTime is only a label
 sql(file,`INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('tmdb', ${until}, 'rate_limited', NULL, 'seed', ${Date.now()})`);
 seed(catalog());tmdb=TMDB();
 const withDb={...env,DB:d1Standin(file)},waits=[];
 await worker.scheduled({cron:'24 3 * * *',scheduledTime:Date.parse('2026-11-15T03:24:00Z')},withDb,{waitUntil(p){waits.push(p);}});await Promise.all(waits);
 assert.deepEqual(fetches.filter(u=>u.includes('themoviedb')),[],'an active cooldown sends no TMDB request');
 assert.equal(cp().status,'pending');assert.equal(cp().retryAttempts,0,'a cooldown skip charges no retry attempt');assert.equal(cp().rateLimitStreak,0,'and no rate-limit streak');
 assert.equal(Date.parse(cp().nextRetryAt),new Date(until).getTime(),'the next firing waits for the cooldown end');
 assert.equal(records.get(NEG)?.entries?.['1'],undefined,'a skip is never a no-poster verdict');
}
console.log('catalog-poster-weekly: week arithmetic, checkpoint validity, plan, the ordered monitor projection, the bootstrap sweep, idle = one read and no write, held and due verdicts, busy lease defers and resumes, 429 and 5xx without a no-poster verdict, retry exhaustion, outbox replay with frozen at, deferred-then-final, week supersession, full outbox and corrupt checkpoint, CAS race, exact cron routing, and the admission seed');
