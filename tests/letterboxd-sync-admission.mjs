// AIR-570 / ADR 0186 decision 5. The bounded admission step over the REAL ledger of the Watchlist repository (full migration chain), with a fake identity bridge. Offline.
// Proves: due rows only, at most three per step, the slug of the first-seen snapshot, resolved by a verified id or by another writer's link (no second write), a pending backoff, a transport stop that
// does not use up an attempt, terminal after the bounded attempts, a missing slug, a superseded id (removed before it resolved), the epoch guard, and that membership is never touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import * as WatchlistD1 from '../src/watchlist-d1.js';
import {admissionStep,STEP_LIMIT,AGE_REPORT_MS} from '../src/letterboxd-sync-admission.js';
import {effectWriters} from '../src/letterboxd-sync-effects.js';

const AGE_KEEP=WatchlistD1.LIMITS.keepSnapshots;
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbadm-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const base=path.join(root,'base.sqlite');
{const r=sqliteSync(['-bail',base],{input:'PRAGMA foreign_keys=ON;\n'+chain});if(r.status!==0)throw new Error(r.stderr);}
let n=0;
const open=()=>{const file=path.join(root,'db-'+(n++)+'.sqlite');fs.copyFileSync(base,file);const r=sqliteSync(['-bail',file],{input:"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;"});if(r.status!==0)throw new Error(r.stderr);return {file,db:d1Standin(file)};};
const film=i=>({id:'f'+i,title:'F'+i,year:2000+i,url:'https://letterboxd.com/film/film-'+i+'/'});
const NOW=Date.parse('2026-11-21T12:00:00Z');
const GUARD='INSERT INTO watchlist_cas (id, ok) SELECT 1, 1 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok';
const epochGuard=()=>[GUARD,[]];
const ctx=env=>({env,epoch:1,now:()=>NOW,deadline:NOW+600000});
async function publish(env,list,id,at){const r=await WatchlistD1.publishSnapshot(env,list,{scanId:id,observedAt:at,runId:'r-'+id,slotKey:'k'},{now:Date.parse(at)});assert.equal(r.ok,true,JSON.stringify(r));return r;}
const ledger=db=>Object.fromEntries(db.sql('SELECT lid,state,attempts,next_retry_at,last_reason,resolved_by FROM watchlist_admission_pending').map(r=>[r.lid,r]));

// AIR-599: the fake check answers like the real one: an explicit outcome per id, copied by the ledger. `entries` are outcomes {reason,attempts,nextAttemptAt,class?}.
const CLASS={rate_limited:'transport',forbidden:'transport',challenge:'transport',timeout:'transport',upstream_5xx:'transport',network_error:'transport',deferred:'not_now',diary_cap:'not_now',not_found:'gone',owner_dismissed:'settled'};
function identity({labels=[],entries={},links={},max=3,throws=false,counts={}}={}){
 const calls={resolve:[],links:0,routes:[]};
 return {calls,MAX_ATTEMPTS:max,
  resolve:async(env,items,opts)=>{calls.resolve.push(items.map(i=>i.lid+':'+i.slug));calls.routes.push(opts.route);calls.items=items;if(throws)throw new Error('x');
   const outcomes=new Map();for(const item of items){const e=entries[item.lid];if(e)outcomes.set(item.lid,{checked:true,class:e.class||CLASS[e.reason]||'definite',reason:e.reason,retryAt:e.nextAttemptAt??null,attempts:e.attempts,streak:e.streak||0,terminal:e.attempts>=max});}
   return {labels:new Map(labels.map(l=>[l,{}])),counts,outcomes};},
  diaryLinks:async(env,lids)=>{calls.links++;return new Map(lids.filter(l=>links[l]).map(l=>[l,{tmdb:links[l]}]));}};
}
const step=(env,id)=>admissionStep({repository:WatchlistD1,identity:id,epochGuard})(ctx(env),{limit:3,now:NOW});

// 1. Promotion puts every added id in the ledger once; the step takes at most three, oldest first, with the slug of the member URL.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1),film(2),film(3),film(4)],'s1','2026-11-21T09:40:00.000Z');
 assert.equal(Object.keys(ledger(db)).length,5);
 const id=identity({labels:['f0'],entries:{f1:{reason:'review',attempts:1,nextAttemptAt:'2026-11-22T00:00:00.000Z'},f2:{reason:'rate_limited',attempts:0,streak:1,nextAttemptAt:'2026-11-21T14:00:00.000Z'}}});
 const out=await step(env,id);
 assert.deepEqual(id.calls.resolve,[['f0:film-0','f1:film-1','f2:film-2']],'three ids, slugs from the member URLs, in ledger order');
 assert.deepEqual(id.calls.routes,['watchlist_admission'],'the check is told its caller');
 assert.equal(STEP_LIMIT,3);
 const l=ledger(db);
 assert.equal(l.f0.state,'resolved');assert.match(l.f0.resolved_by,/^identity:/);
 assert.deepEqual([l.f1.state,l.f1.attempts,l.f1.next_retry_at,l.f1.last_reason],['pending',1,'2026-11-22T00:00:00.000Z','review']);
 assert.deepEqual([l.f2.state,l.f2.attempts,l.f2.next_retry_at,l.f2.last_reason],['pending',0,'2026-11-21T14:00:00.000Z','rate_limited'],'a transport stop does not use up an attempt and waits for its backoff');
 assert.deepEqual([out.counts.transport,out.counts.definite],[1,1]);
 assert.equal(l.f3.state,'pending');assert.equal(l.f3.attempts,0);
 assert.deepEqual([out.resolved,out.terminal],[1,0]);
 // The next step: f1 and f2 are not due yet (retry times in the future / f2 at 14:00), so the next ones go.
 const id2=identity({labels:['f3','f4']});const out2=await step(env,id2);
 assert.deepEqual(id2.calls.resolve,[['f3:film-3','f4:film-4']]);assert.equal(out2.resolved,2);
 assert.deepEqual(db.sql('SELECT COUNT(*) AS n FROM watchlist_member')[0],{n:5},'membership is untouched by admission');
}
// 2. Another writer admitted the Film first (a link exists): resolved from that link with no identity check of its own result needed, and no second write.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const id=identity({links:{f0:'603'}});await step(env,id);
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.resolved_by],['resolved','identity:603']);
}
// 3. Terminal after the bounded attempts, and then never retried automatically.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const fail=a=>identity({entries:{f0:{reason:'tmdb_mismatch',attempts:a,nextAttemptAt:'2026-11-21T11:59:00.000Z'}},max:3});
 await step(env,fail(1));assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts],['pending',1]);
 await step(env,fail(2));assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts],['pending',2]);
 const out=await step(env,fail(3));assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.last_reason],['terminal',3,'tmdb_mismatch']);assert.equal(out.terminal,1);
 const id=identity();const again=await step(env,id);assert.equal(id.calls.resolve.length,0,'a terminal row is not due');assert.equal(again.resolved,0);
}
// 4. A member without a usable film URL has no slug: charged once on the shared entry, backed off, eventually terminal.
{
 const {db}=open(),env={DB:db};await publish(env,[{id:'f0',title:'F0',year:2000,url:'https://letterboxd.com/film/UPPER_case/'}],'s1','2026-11-21T09:40:00.000Z');
 const id=identity({entries:{f0:{reason:'slug_missing',attempts:1,nextAttemptAt:'2026-11-22T00:00:00.000Z'}}});await step(env,id);
 // AIR-599: the row is offered without a slug and the check charges `slug_missing` on the shared entry, once; the ledger copies it.
 assert.deepEqual(id.calls.resolve,[['f0:null']]);assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.last_reason],['pending',1,'slug_missing']);
}
// 5. A step that is not reached (budget, facts not durable yet) leaves the row due and unchanged; a throwing bridge is an error that changes no row.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 await step(env,identity());assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.next_retry_at],['pending',0,null]);
 const out=await step(env,identity({throws:true}));assert.equal(out.error,'identity_check_failed');assert.equal(ledger(db).f0.attempts,0);
}
// 6. The epoch guard: no guard function is no step; a failing guard (stale epoch) writes nothing.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const none=await admissionStep({repository:WatchlistD1,identity:identity({labels:['f0']})})(ctx(env),{});assert.equal(none.error,'epoch_guard_absent');
 const bad=admissionStep({repository:WatchlistD1,identity:identity({labels:['f0']}),epochGuard:()=>['INSERT INTO watchlist_cas (id, ok) SELECT 1, 0 WHERE 1 ON CONFLICT(id) DO UPDATE SET ok=excluded.ok',[]]});
 await bad(ctx(env),{});assert.equal(ledger(db).f0.state,'pending','a stale epoch resolved nothing');
}
// 7. Superseded: an id removed before it resolved is not retried (the removal_enqueue effect does it, with the guard); a resolved one is left alone.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'s1','2026-11-21T09:40:00.000Z');
 await step(env,identity({labels:['f1']}));assert.deepEqual([ledger(db).f0.state,ledger(db).f1.state],['pending','resolved']);
 const second=await WatchlistD1.publishSnapshot(env,[film(5)],{scanId:'s2',observedAt:'2026-11-21T16:00:00.000Z',runId:'r2',slotKey:'k'},{now:Date.parse('2026-11-21T16:00:00.000Z')});
 assert.equal(second.ok,true,JSON.stringify(second));assert.deepEqual(second.removed.sort(),['f0','f1']);
 const writers=effectWriters({repository:WatchlistD1,facts:{applyWatchlistScan:async()=>({})},retention:{UNIT_CAP:2,writerOpen:async()=>false},removal:{enqueue:async()=>{}},tmdbOf:async()=>new Map(),removalRef:async(e,s)=>({eventKey:'events/items/0000000000001-x.json',sourceRunId:s.runId,at:s.observedAt}),epochGuard});
 // apply the removal effect of the version that removed f0 and f1 (drain strictly in order first)
 for(let i=0;i<20;i++){const next=(await WatchlistD1.pendingEffects(env)).effects[0];if(!next)break;const receipt=await writers[next.effect]({env,epoch:1,now:()=>NOW},next);assert.ok(receipt,next.effect);const done=await WatchlistD1.completeEffect(env,{snapshotId:next.snapshotId,effect:next.effect,receipt},{now:NOW,guards:[epochGuard()]});assert.equal(done.ok,true);}
 assert.deepEqual([ledger(db).f0.state,ledger(db).f1.state],['superseded','resolved'],'f0 left before it resolved; f1 keeps its resolution');
 assert.equal(ledger(db).f5.state,'pending','a newly added id is pending');
}
// 7b. Review: the identity check (its Ratings documents and canonical admission) runs with the epoch-fenced env; the ledger settle carries the guard as before.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 let seen=null;const id=identity({});const resolve=id.resolve;id.resolve=async(e,items,opts)=>{seen=e;return resolve(e,items,opts);};
 await admissionStep({repository:WatchlistD1,identity:id,epochGuard,fenceEnv:(e,epoch)=>({...e,fenced:true,epoch})})(ctx(env),{});
 assert.deepEqual([seen.fenced,seen.epoch],[true,1]);
}
// 7c. AIR-599 / ADR 0207 decision 4b: age no longer ends a row. A row pending longer than 14 days under a transport outage is NOT terminated (no `age_exceeded`), keeps its attempts and its place, and is
// REPORTED (`overdue`). Its queue position (first-seen version) stays ahead of newer rows.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'old','2026-11-01T09:40:00.000Z');
 await WatchlistD1.publishSnapshot(env,[film(0),film(1),film(2)],{scanId:'new',observedAt:'2026-11-20T09:40:00.000Z',runId:'r',slotKey:'k'},{now:Date.parse('2026-11-20T09:40:00.000Z')});
 const id=identity({entries:{f0:{reason:'forbidden',attempts:0,streak:3,nextAttemptAt:'2026-11-21T13:00:00.000Z'},f1:{reason:'rate_limited',attempts:0,streak:2,nextAttemptAt:'2026-11-21T12:30:00.000Z'},f2:{reason:'rate_limited',attempts:0,nextAttemptAt:'2026-11-21T12:15:00.000Z'}}});
 const out=await step(env,id);
 assert.deepEqual(id.calls.resolve,[['f0:film-0','f1:film-1','f2:film-2']],'the old rows are still checked, oldest first');
 const l=ledger(db);
 assert.deepEqual([l.f0.state,l.f0.attempts,l.f0.last_reason,l.f1.state,l.f1.attempts],['pending',0,'forbidden','pending',0],'no termination by age, no attempt for a transport stop');
 assert.ok(!Object.values(l).some(row=>row.last_reason==='age_exceeded'));
 assert.equal(out.terminal,0);assert.equal(out.counts.overdue,2,'the two rows older than 14 days are reported');assert.equal(out.counts.transport,3);
 assert.ok(NOW-Date.parse('2026-11-01T09:40:00.000Z')>AGE_REPORT_MS&&NOW-Date.parse('2026-11-20T09:40:00.000Z')<AGE_REPORT_MS);
 assert.equal(fs.readFileSync('src/letterboxd-sync-admission.js','utf8').includes("'age_exceeded'"),false,'age_exceeded is no longer a terminal reason');
}
// 7d. AIR-599: one shared check budget. The ledger COPIES the entry's count from the outcome (never adds to it): a stale entry is never charged again, a repeated settle (a restart between the check and
// the settle) changes nothing, and the cap is applied to the shared count. A 404 is `gone` and counts; six of them make a visible terminal row.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const stale=identity({entries:{f0:{reason:'tmdb_mismatch',attempts:2,nextAttemptAt:'2026-11-22T00:00:00.000Z',class:'definite'}}});
 await step(env,stale);assert.equal(ledger(db).f0.attempts,2);
 const later=Date.parse('2026-11-22T01:00:00.000Z');
 await admissionStep({repository:WatchlistD1,identity:stale,epochGuard})({...ctx(env),now:()=>later},{now:later});
 assert.equal(ledger(db).f0.attempts,2,'the same outcome copied twice charges nothing (restart between check and settle, stale entry)');
 const six=identity({entries:{f0:{reason:'not_found',attempts:6,nextAttemptAt:'2026-11-24T00:00:00.000Z'}},max:6});
 const out=await admissionStep({repository:WatchlistD1,identity:six,epochGuard})({...ctx(env),now:()=>later+48*3600000},{now:later+48*3600000});
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.last_reason],['terminal',6,'not_found'],'six real checks: terminal and visible');assert.equal(out.counts.atCap,1);assert.equal(out.counts.gone,1);
}
// 7d2. AIR-599: the Watchlist caller at a full Diary document gets `diary_cap`: not now, no attempt, its row keeps its place (due again at the next run).
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const id=identity({entries:{f0:{reason:'diary_cap',attempts:0,nextAttemptAt:null}},counts:{capRefused:1}});
 const out=await step(env,id);
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.next_retry_at,ledger(db).f0.last_reason],['pending',0,null,'diary_cap']);assert.equal(out.counts.capRefused,1);assert.equal(out.counts.notNow,1);
 // the row's attempts are offered as the seed of a new shared entry (the ledger's count is not reset by a missing entry)
 assert.deepEqual(id.calls.items.map(i=>[i.lid,i.attempts]),[['f0',0]]);
}
// 7d3. AIR-599: the owner dismissed the shared entry: the row is terminal `owner_dismissed`, no attempt.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 await step(env,identity({entries:{f0:{reason:'owner_dismissed',attempts:1,nextAttemptAt:null}}}));
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.last_reason],['terminal','owner_dismissed']);
}
// 7e. Review (owner visibility): the inventory read filters IN SQL and pages by keyset, so a terminal row behind more than a thousand historical rows is reachable and a full walk loses and repeats nothing.
{
 const {db,file}=open(),env={DB:db};
 await publish(env,[film(0)],'s1','2026-11-21T08:00:00.000Z');
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 // 1100 old resolved/superseded rows (versions 1..), then one NEWER terminal row (version 2), plus pending rows
 sql("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1100) INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) SELECT 'h'||printf('%05d',i), 'gone', 1, CASE WHEN i%2=0 THEN 'resolved' ELSE 'superseded' END, 1, NULL, NULL, CASE WHEN i%2=0 THEN 'identity:603' ELSE NULL END, '2026-11-01T00:00:00.000Z' FROM n;");
 sql("INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('t-new','gone',2,'terminal',3,NULL,'age_exceeded',NULL,'2026-11-21T00:00:00.000Z');");
 const owner=await WatchlistD1.admissionInventory(env,{filter:'owner_review',limit:25,now:NOW});
 assert.deepEqual([owner.ok,owner.rows.map(r=>r.lid),owner.more],[true,['t-new'],false],'the terminal row is reachable behind 1100 historical rows, with no false empty list');
 const open_=await WatchlistD1.admissionInventory(env,{filter:'open',limit:100,now:NOW});
 assert.ok(open_.rows.every(r=>r.state==='pending'||r.state==='terminal'),'resolved and superseded are not in the open list');
 assert.ok(open_.rows.some(r=>r.lid==='t-new')&&open_.rows.some(r=>r.lid==='f0'));
 // A full keyset walk of every row: no gap, no repeat, stable order.
 const seen=[];let after=null,pages=0,generation=null;
 for(;;){const page=await WatchlistD1.admissionInventory(env,{filter:'all',after,limit:100,now:NOW});assert.equal(page.ok,true);generation??=page.generation;assert.equal(page.generation,generation);seen.push(...page.rows.map(r=>r.lid));pages++;if(!page.more)break;const last=page.rows.at(-1);after={version:last.firstSeenVersion,lid:last.lid};}
 const all=db.sql('SELECT lid FROM watchlist_admission_pending ORDER BY first_seen_version, lid').map(r=>r.lid);
 assert.deepEqual(seen,all,'the walk visits every row exactly once, in keyset order');assert.ok(pages>=12);
 const history=await WatchlistD1.admissionInventory(env,{filter:'history',limit:100,now:NOW});assert.ok(history.rows.every(r=>r.state==='resolved'||r.state==='superseded'));
 assert.deepEqual(await WatchlistD1.admissionInventory(env,{filter:'nope'}),{ok:false,reason:'shape'});
 assert.deepEqual(await WatchlistD1.admissionInventory(env,{filter:'all',after:{version:'x',lid:'a'}}),{ok:false,reason:'shape'});
}
// 7f. AIR-599 (review of PR #1009): the owner requeue / dismiss of ledger rows is PLANNED here (one statement per row, each with its compare-and-swap token and a fence) and committed by the caller in the same D1 batch
// as the shared document. A stale token fails the WHOLE batch; an `age_exceeded` id no longer on the Watchlist is not requeued.
{
 const {db,file}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'s1','2026-11-21T09:40:00.000Z');
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("UPDATE watchlist_admission_pending SET state='terminal', attempts=6, last_reason='forbidden', updated_at='t1' WHERE lid='f0';");
 sql("UPDATE watchlist_admission_pending SET state='terminal', attempts=1, last_reason='age_exceeded', updated_at='t2' WHERE lid='f1';");
 sql("INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('gone1','x',1,'terminal',2,NULL,'age_exceeded',NULL,'t3');");
 const run=async plan=>{assert.equal(plan.ok,true,JSON.stringify(plan));try{await db.batch(plan.statements.map(([q,params])=>db.prepare(q).bind(...params)));return 'ok';}catch(error){return String(error.message||error);}};
 // read plan: the open rows of the ids, a row that cannot be requeued by rule is skipped and named
 const read=await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:['f0','gone1','none'],now:NOW});
 assert.deepEqual(read.tokens.map(t=>t.lid),['f0']);assert.deepEqual(read.skipped,[{lid:'gone1',reason:'not_on_watchlist'}]);
 // stale token: the whole batch fails and nothing changes
 const stale=await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:['f0','f1'],rows:[{lid:'f0',state:'terminal',attempts:5,updatedAt:'t1'},{lid:'f1',state:'terminal',attempts:1,updatedAt:'t2'}],now:NOW});
 assert.notEqual(await run(stale),'ok');assert.deepEqual([ledger(db).f0.state,ledger(db).f1.state],['terminal','terminal'],'one stale token refuses both rows');
 // explicit tokens of an age_exceeded id off the Watchlist: refused whole
 const off=await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:['gone1'],rows:[{lid:'gone1',state:'terminal',attempts:2,updatedAt:'t3'}],now:NOW});
 assert.notEqual(await run(off),'ok');assert.equal(ledger(db).gone1.state,'terminal');
 const ok=await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:['f0','f1'],rows:[{lid:'f0',state:'terminal',attempts:6,updatedAt:'t1'},{lid:'f1',state:'terminal',attempts:1,updatedAt:'t2'}],now:NOW});
 assert.equal(await run(ok),'ok');
 const back=await WatchlistD1.admissionRowsOf(env,['f0','f1']);
 assert.deepEqual(back.rows.map(r=>[r.lid,r.state,r.attempts,r.lastReason,r.nextRetryAt]).sort(),[['f0','pending',0,'owner_requeued',null],['f1','pending',0,'owner_requeued',null]]);
 const dismiss=await WatchlistD1.ownerAdmissionPlan(env,{action:'dismiss',lids:['f0'],now:NOW+1000});assert.equal(await run(dismiss),'ok');
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.last_reason],['terminal','owner_dismissed']);
 assert.deepEqual(await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:[]}),{ok:false,reason:'shape'});
 // a closed authority plans nothing
 sql("UPDATE watchlist_authority SET mode='epg' WHERE id=1;");assert.deepEqual(await WatchlistD1.ownerAdmissionPlan(env,{action:'requeue',lids:['f0']}),{ok:false,reason:'closed'});
}
// 7g. AIR-599 (review of PR #1009): snapshot retention keeps the HEADER of the first-seen snapshot of an open ledger row (its authoritative age) and trims only its members, changes and effects; the 14-day report and the
// slug survive real pruning. A legacy row whose snapshot is already gone has an UNKNOWN age, counted apart, never dropped; unavailable evidence is not absence.
{
 const {db,file}=open(),env={DB:db};
 await publish(env,[film(0)],'s1','2026-10-01T09:40:00.000Z');
 for(let i=1;i<=AGE_KEEP+2;i++)await publish(env,[film(0),film(100+i)],'s'+(i+1),'2026-11-'+String(10+i).padStart(2,'0')+'T09:40:00.000Z');
 const drain=async()=>{for(let i=0;i<60;i++){const next=(await WatchlistD1.pendingEffects(env)).effects[0];if(!next)break;const w=effectWriters({repository:WatchlistD1,facts:{applyWatchlistScan:async()=>({})},retention:{UNIT_CAP:2,writerOpen:async()=>false},removal:{enqueue:async()=>{}},tmdbOf:async()=>new Map(),removalRef:async(e,s)=>({eventKey:'events/items/0000000000001-x.json',sourceRunId:s.runId,at:s.observedAt}),epochGuard});const receipt=await w[next.effect]({env,epoch:1,now:()=>NOW},next);await WatchlistD1.completeEffect(env,{snapshotId:next.snapshotId,effect:next.effect,receipt},{now:NOW,guards:[epochGuard()]});}};
 await drain();
 for(let i=0;i<6;i++)assert.equal((await WatchlistD1.pruneSnapshots(env)).ok,true);
 const firstSeen=db.sql("SELECT first_seen_snapshot_id AS id FROM watchlist_admission_pending WHERE lid='f0'")[0].id;
 const heads=db.sql("SELECT snapshot_id FROM watchlist_snapshot WHERE snapshot_id='"+firstSeen+"'");
 assert.equal(heads.length,1,'the first-seen snapshot of the open row f0 keeps its header');
 assert.equal(db.sql("SELECT COUNT(*) AS n FROM watchlist_member WHERE snapshot_id='"+firstSeen+"'")[0].n,0,'its members are trimmed like any old snapshot\'s');
 const report=await WatchlistD1.admissionReport(env,{now:NOW,overdueBefore:new Date(NOW-14*86400000).toISOString()});
 assert.deepEqual([report.ok,report.overdue,report.overdueUnknown],[true,1,0],'f0 is still reported overdue after real pruning (age from the kept header)');
 assert.equal(report.oldestWorkAt,'2026-10-01T09:40:00.000Z');
 // the slug comes from the CURRENT snapshot's member when the first one has no members left; an unreadable read leaves the row due and unchanged
 const id=identity({entries:{f0:{reason:'rate_limited',attempts:0,nextAttemptAt:'2026-11-22T00:00:00.000Z'}}});
 await step(env,id);
 assert.ok(id.calls.resolve.flat().includes('f0:film-0'),'slug of the current snapshot member: '+JSON.stringify(id.calls.resolve));
 // a legacy row whose first-seen snapshot is already gone: unknown age, counted apart
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('legacy','pruned',1,'pending',1,NULL,'forbidden',NULL,'t');");
 const legacy=await WatchlistD1.admissionReport(env,{now:NOW,overdueBefore:new Date(NOW-14*86400000).toISOString()});
 assert.equal(legacy.overdueUnknown,1,'a legacy row of unknown age is counted, never dropped');
 // evidence read failure is not absence: the repository answers unavailable for the first-seen snapshot, the row is not offered and not charged
 const flaky={...WatchlistD1,readSnapshot:async()=>({ok:false,reason:'unavailable'}),currentMemberUrls:async()=>({ok:false,reason:'unavailable'})};
 const idU=identity();const outU=await admissionStep({repository:flaky,identity:idU,epochGuard})(ctx(env),{limit:3,now:NOW});
 assert.equal(idU.calls.resolve.length,0,'unreadable evidence: nothing is offered');assert.ok(outU.counts.notNow>=1);
 assert.deepEqual([ledger(db).legacy.attempts,ledger(db).f0.attempts],[1,0]);
}
// 7h. AIR-599 (review of PR #1009): the row keeps the attempts it already holds when the shared entry (materialized by the other caller) has fewer.
{
 const {db}=open(),env={DB:db};await publish(env,[film(0)],'s1','2026-11-21T09:40:00.000Z');
 const sqlFile=db.sql;db.sql("UPDATE watchlist_admission_pending SET attempts=5, last_reason='forbidden' WHERE lid='f0'");
 await step(env,identity({entries:{f0:{reason:'not_found',attempts:1,nextAttemptAt:'2026-11-22T00:00:00.000Z'}}}));
 assert.equal(ledger(db).f0.attempts,5,'the row is never lowered by a fresher, smaller shared count');void sqlFile;
}
// 8. Module hygiene: no SQL, no table, no EPG or Discovery state of its own.
{
 const text=fs.readFileSync('src/letterboxd-sync-admission.js','utf8');
 assert.doesNotMatch(text,/\b(SELECT|INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)|prepare\(|BUCKET|env\.DB|published_epg|discovery_|epg_checkpoint/i);
}
console.log('letterboxd-sync-admission ok');
