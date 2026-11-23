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
import {admissionStep,STEP_LIMIT,AGE_MAX_MS,AGE_MAX_VERSIONS} from '../src/letterboxd-sync-admission.js';
import {effectWriters} from '../src/letterboxd-sync-effects.js';

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

function identity({labels=[],entries={},links={},max=3,throws=false}={}){
 const calls={resolve:[],links:0};
 return {calls,MAX_ATTEMPTS:max,
  resolve:async(env,items,opts)=>{calls.resolve.push(items.map(i=>i.lid+':'+i.slug));if(throws)throw new Error('x');return {labels:new Map(labels.map(l=>[l,{}])),counts:{}};},
  readIdentity:async()=>({films:entries}),
  diaryLinks:async(env,lids)=>{calls.links++;return new Map(lids.filter(l=>links[l]).map(l=>[l,{tmdb:links[l]}]));}};
}
const step=(env,id)=>admissionStep({repository:WatchlistD1,identity:id,epochGuard})(ctx(env),{limit:3,now:NOW});

// 1. Promotion puts every added id in the ledger once; the step takes at most three, oldest first, with the slug of the member URL.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1),film(2),film(3),film(4)],'s1','2026-11-21T09:40:00.000Z');
 assert.equal(Object.keys(ledger(db)).length,5);
 const id=identity({labels:['f0'],entries:{f1:{reason:'review',attempts:1,nextAttemptAt:'2026-11-22T00:00:00.000Z'},f2:{reason:'rate_limited',attempts:1,nextAttemptAt:'2026-11-21T14:00:00.000Z'}}});
 const out=await step(env,id);
 assert.deepEqual(id.calls.resolve,[['f0:film-0','f1:film-1','f2:film-2']],'three ids, slugs from the member URLs, in ledger order');
 assert.equal(STEP_LIMIT,3);
 const l=ledger(db);
 assert.equal(l.f0.state,'resolved');assert.match(l.f0.resolved_by,/^identity:/);
 assert.deepEqual([l.f1.state,l.f1.attempts,l.f1.next_retry_at,l.f1.last_reason],['pending',1,'2026-11-22T00:00:00.000Z','review']);
 assert.deepEqual([l.f2.state,l.f2.attempts],['pending',0],'a transport stop does not use up an attempt');
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
// 4. A member without a usable film URL has no slug: counted, backed off, eventually terminal; no identity call is made for it.
{
 const {db}=open(),env={DB:db};await publish(env,[{id:'f0',title:'F0',year:2000,url:'https://letterboxd.com/film/UPPER_case/'}],'s1','2026-11-21T09:40:00.000Z');
 const id=identity();await step(env,id);assert.equal(id.calls.resolve.length,0);assert.deepEqual([ledger(db).f0.state,ledger(db).f0.attempts,ledger(db).f0.last_reason],['pending',1,'slug_missing']);
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
// 7c. Review (ADR 0186 decision 5): a bounded AGE. A transport deferral never uses an attempt, so an id the source can never answer would stay pending for ever; past the age bound it becomes terminal with the reason
// `age_exceeded`, before any source request, and then waits for an owner decision. The age is the first-seen snapshot's commit time; when that snapshot is already pruned the age is bounded by versions instead.
{
 const {db}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'old','2026-11-01T09:40:00.000Z');
 await WatchlistD1.publishSnapshot(env,[film(0),film(1),film(2)],{scanId:'new',observedAt:'2026-11-20T09:40:00.000Z',runId:'r',slotKey:'k'},{now:Date.parse('2026-11-20T09:40:00.000Z')});
 const id=identity({entries:{f2:{reason:'rate_limited',attempts:1,nextAttemptAt:'2026-11-21T12:00:00.000Z'}}});
 const out=await step(env,id);
 assert.deepEqual(id.calls.resolve,[['f2:film-2']],'only the young id reaches the source; the aged ones never do');
 const l=ledger(db);
 assert.deepEqual([l.f0.state,l.f0.last_reason,l.f1.state,l.f1.last_reason],['terminal','age_exceeded','terminal','age_exceeded']);
 assert.deepEqual([l.f2.state,l.f2.attempts],['pending',0],'the young id keeps waiting without using an attempt');
 assert.equal(out.terminal,2);
 assert.ok(NOW-Date.parse('2026-11-01T09:40:00.000Z')>AGE_MAX_MS&&NOW-Date.parse('2026-11-20T09:40:00.000Z')<AGE_MAX_MS);
 const again=identity();await step(env,again);assert.ok(!again.calls.resolve.flat().some(x=>/^f[01]:/.test(x)),'terminal is final: never retried automatically');
}
{
 // The first-seen snapshot was pruned: the age falls back to versions.
 const {db,file}=open(),env={DB:db};
 await publish(env,[film(0)],'s1','2026-11-21T08:00:00.000Z');
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("UPDATE watchlist_admission_pending SET first_seen_snapshot_id='pruned' WHERE lid='f0';");
 for(let i=1;i<=AGE_MAX_VERSIONS;i++)await publish(env,[film(0),film(100+i)],'s'+(i+1),'2026-11-21T0'+(Math.min(i,9))+':30:00.000Z');
 const id=identity();await step(env,id);
 assert.equal(ledger(db).f0.state,'terminal');assert.equal(ledger(db).f0.last_reason,'age_exceeded');assert.ok(!id.calls.resolve.flat().includes('f0:film-0'));
}
// 7d. Review (age bound): a pending row already past the age bound whose retry time is in the FUTURE still becomes terminal today (it is selected regardless of its retry time); a deferral still uses no attempt.
{
 const {db,file}=open(),env={DB:db};
 await publish(env,[film(0),film(1)],'old','2026-11-01T09:40:00.000Z');
 const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sql("UPDATE watchlist_admission_pending SET next_retry_at='2026-11-22T12:00:00.000Z', attempts=1 WHERE lid='f0';");
 sql("UPDATE watchlist_admission_pending SET next_retry_at='2026-11-22T12:00:00.000Z', attempts=0, last_reason='deferred' WHERE lid='f1';");
 const id=identity();const out=await step(env,id);
 assert.deepEqual([ledger(db).f0.state,ledger(db).f0.last_reason,ledger(db).f1.state,ledger(db).f1.last_reason],['terminal','age_exceeded','terminal','age_exceeded'],'both are older than the bound: terminal although neither is due');
 assert.deepEqual([ledger(db).f0.attempts,ledger(db).f1.attempts],[1,0],'terminal by age uses no attempt');
 assert.equal(id.calls.resolve.length,0,'no source request for an aged row');assert.equal(out.terminal,2);
 // A young row with a future retry stays untouched (not due, not aged).
 const {db:db2,file:file2}=open(),env2={DB:db2};
 await publish(env2,[film(0)],'young','2026-11-20T09:40:00.000Z');
 const r=sqliteSync(['-bail',file2],{input:"UPDATE watchlist_admission_pending SET next_retry_at='2026-11-22T12:00:00.000Z' WHERE lid='f0';"});assert.equal(r.status,0);
 const id2=identity();await step(env2,id2);assert.equal(ledger(db2).f0.state,'pending');assert.equal(id2.calls.resolve.length,0);
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
// 8. Module hygiene: no SQL, no table, no EPG or Discovery state of its own.
{
 const text=fs.readFileSync('src/letterboxd-sync-admission.js','utf8');
 assert.doesNotMatch(text,/\b(SELECT|INSERT|UPDATE|DELETE)\b\s+(INTO|FROM)|prepare\(|BUCKET|env\.DB|published_epg|discovery_|epg_checkpoint/i);
}
console.log('letterboxd-sync-admission ok');
