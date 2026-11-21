// AIR-570 / ADR 0186. The BUNDLED Worker (dist/server/index.js, built here) runs one whole Letterboxd Sync slot through the REAL adapters: the real `letterboxdPorts`, the real `WatchlistD1`
// repository on the full migration chain, the real facts module and the real removal queue, with a fake Letterboxd (HTML pages), a fake R2 bucket and the sqlite D1 stand-in. Offline: no
// network, no Cloudflare, nothing applied to production. It proves the wiring the reviewer asked for: `letterboxdPorts` exists in the bundle, a first slot publishes version 1, the next slot drains
// its causal effects with real writers and publishes a 1-for-1 replacement, the removal reaches the real queue, exactly two Events per slot exist, and the mode switch still refuses without proof.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {webcrypto} from 'node:crypto';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {makeBucket,diaryPage,diaryRow} from './ratings-harness.mjs';

const T=s=>Date.parse(s);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbbundle-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
// Build into a private copy of the worker bundle: the same build script, its own output directory is not configurable, so build in place (atomic) and read the result.
const built=spawnSync(process.execPath,['build.mjs'],{encoding:'utf8',maxBuffer:1<<26});
assert.equal(built.status,0,built.stderr);
const source=fs.readFileSync('dist/server/index.js','utf8');

const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const file=path.join(root,'db.sqlite');
{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain+"\nUPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;\nUPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;\nUPDATE metadata_cache_authority SET mode='d1' WHERE id=1;"});assert.equal(r.status,0,r.stderr);}
const db=d1Standin(file);

// A fake Letterboxd: a watchlist of `list` ids in pages of 3.
let list=['f0','f1','f2','f3'];
const poster=id=>`<div data-component-class="LazyPoster" data-item-name="Film ${id} (2001)" data-item-link="/film/${id}/" data-postered-identifier='{"lid":"${id}"}'></div>`;
const page=n=>{const per=3,items=list.slice((n-1)*per,n*per),last=n*per>=list.length;return `<span class="js-watchlist-count">${list.length}</span>${items.map(poster).join('')}${last?'':`<a class="next" href="/demo-user/watchlist/page/${n+1}/">Next</a>`}`;};
const fetched=[];
const fakeFetch=async url=>{fetched.push(String(url));if(/\/demo-user\/diary\//.test(String(url)))return new Response(diaryPage([diaryRow('f0',8,'2026-11-20','100001'),diaryRow('f3',8,'2026-11-19','100002')],false),{status:200});const m=/\/demo-user\/watchlist\/(?:page\/(\d+)\/)?$/.exec(String(url));if(!m)return new Response('not found',{status:404});return new Response(page(Number(m[1]||1)),{status:200});};

const bucket=makeBucket();
const env={DB:db,BUCKET:bucket,LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/x.xml',METADATA_CACHE_DB_OPTIONAL:'standin'};
const wf={instances:new Map(),created:[],async create({id,params}){if(this.instances.has(id))throw new Error('already exists');this.instances.set(id,{status:'running',params});this.created.push(id);},async get(id){if(!this.instances.has(id))throw new Error('not found');return {status:async()=>({status:this.instances.get(id).status})};}};
env.LETTERBOXD_WORKFLOW=wf;
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,Math,TextEncoder,TextDecoder,Uint8Array,atob,btoa,encodeURIComponent,decodeURIComponent,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,console:{log(){},error:(...a)=>process.stderr.write(a.join(' ')+'\n'),warn(){}},ASSETS:{},fetch:fakeFetch});
vm.runInContext(source.replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const run=code=>vm.runInContext(code,context);
const G=name=>run(name);

// 1. The bundle has the ports and the control plane; the Watchlist phase and the three effect writers are the real ones.
assert.equal(typeof G('letterboxdPorts'),'function');
const ports=G('letterboxdPorts')(env);
assert.deepEqual(Object.keys(ports).sort(),['handover','ratings','reconcile','watchlist'],'every phase has a real adapter and the handover proof is read from live state');
assert.equal(typeof ports.watchlist.run,'function');
const LetterboxdSync=G('LetterboxdSync');
// Supported ratings storage (version 2 queue and a merge-form Diary cursor), seeded into the D1-owned ratings documents exactly as a migrated production store holds them.
context.__env=env;
await run("LetterboxdRatings.writeDocument(__env,'enrichment/removal-rating-lookups.json',null,{schemaVersion:2,films:{},droppedRefs:0,migratedAt:'2026-10-31T00:00:00.000Z'})");
await run("LetterboxdRatings.writeDocument(__env,'letterboxd/diary/state.json',null,{schemaVersion:2,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null,writer:{runId:'ratings-storage-migrate',step:'migrate'}})");
const step={async do(name,fn){return fn();},async sleepUntil(){}};

// 1b. Dormant: with no mode row the status and the monitor carry nothing of the executor (today's behavior), and a stale-safe read never fails them.
{
 const status0=await run('LetterboxdRatings.status(__env,'+T('2026-11-21T09:30:00Z')+')');
 assert.equal(status0.letterboxdSync,null,'no Letterboxd mode row: the Ratings status is unchanged');
 const facts0=await run('Monitor.collect(__env,'+T('2026-11-21T09:30:00Z')+',null)');
 assert.ok(!('letterboxd' in facts0),'a dormant executor adds no monitor stream');
}
// 2. Activation is decided by LIVE evidence, nothing is injected: while the Letterboxd mode is not switching the legacy entry is not fenced, so the switch is refused; once admission is closed
// (`switching`) the legacy Ratings entry is fenced, Ratings is closed and drained, the Watchlist authority is an open d1 and all phases exist, so `complete` is admitted.
{
 assert.equal((await ports.handover(env)).legacyFenced,false,'no Letterboxd switch yet: the legacy entry is not fenced');
 await LetterboxdSync.switchMode(env,{action:'close_admission',target:'cloudflare'},ports,T('2026-11-21T09:39:00Z'));
 const proof=await ports.handover(env);
 assert.deepEqual(JSON.parse(JSON.stringify(proof)),{ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true});
 // A Ratings mode that is not closed refuses, whatever else holds.
 const ratingsOpen=await (async()=>{await run("LetterboxdRatings.writeDocument(__env,'letterboxd/ratings/executor.json',null,{schemaVersion:1,mode:'cloudflare',epoch:1,drain:null})");const p=await ports.handover(env);await run("LetterboxdRatings.readDocument(__env,'letterboxd/ratings/executor.json').then(r=>LetterboxdRatings.writeDocument(__env,'letterboxd/ratings/executor.json',r.object,{schemaVersion:1,mode:'external',epoch:2,drain:null}))");return p;})();
 assert.equal(ratingsOpen.ratingsClosed,false,'a Ratings executor that is still cloudflare is not closed');
 const done=await LetterboxdSync.switchMode(env,{action:'complete'},ports,T('2026-11-21T09:39:00Z'));
 assert.equal(done.completed,true,JSON.stringify(done));
}
// 2b. Active: the same status and monitor facts now carry the slot read model, read only.
{
 const model=await run('LetterboxdRatings.status(__env,'+T('2026-11-21T09:45:00Z')+').then(s=>s.letterboxdSync)');
 assert.equal(model.mode,'cloudflare');assert.equal(model.sideEffects,'none');assert.equal(model.slot.key,'2026-11-21T1030');
 const facts=await run('Monitor.collect(__env,'+T('2026-11-21T09:45:00Z')+',null)');
 assert.equal(facts.letterboxd.mode,'cloudflare');
}
async function slot(now){
 const started=await LetterboxdSync.ensure(env,{now});
 const result=await LetterboxdSync.run(env,{slotKey:started.slot,series:0,epoch:1},step,{now:()=>now+60000,ports});
 return {started,result};
}
const rowOf=key=>db.sql("SELECT watchlist_outcome AS w,status FROM letterboxd_slot WHERE slot_key='"+key+"'")[0];

// 3. Slot 1 scans the fake Letterboxd (2 pages + the repeat of page 1) and publishes version 1 through the real repository.
{
 const r=await slot(T('2026-11-21T09:40:00Z'));
 assert.equal(r.result.reason,'complete');assert.equal(rowOf('2026-11-21T1030').w,'committed');
 assert.equal(db.sql('SELECT version,film_count FROM watchlist_current')[0].film_count,4);
 assert.equal(fetched.filter(u=>/watchlist/.test(u)).length,3,'page 1, page 2 and the repeat read of page 1');
}
// The Film/Person marker of this stand-in is the default `r2`, which the canonical writer refuses; opening it needs a verified baseline (a separate, owner-gated state). The retention effect is
// therefore exercised here on the documented closed-writer path (the same `facts_only` the EPG scan took); its open-writer behaviour has its own test (letterboxd-sync-effects.mjs).
run('CanonicalRatedAdmission.ratedAdmissionWriterOpen=async()=>false');
// 4. Slot 2: the same list is a no-op AFTER version 1's causal effects were drained by the real writers (facts in the real store).
{
 fetched.length=0;
 const r=await slot(T('2026-11-21T15:40:00Z'));
 assert.equal(rowOf('2026-11-21T1630').w,'no_change');
 assert.equal(db.sql('SELECT effects_drained_version AS v FROM watchlist_current')[0].v,1);
 assert.equal(db.sql("SELECT COUNT(*) AS n FROM watchlist_effect WHERE status='done'")[0].n,3);
 const docs=db.sql("SELECT key FROM ratings_document").map(r=>r.key);
 assert.ok(docs.some(k=>/watchlist/i.test(k)),'the real facts module wrote the watchlist scan summary into the ratings documents: '+docs.join(','));
}
// 5. Slot 3: a 1-for-1 replacement (f3 out, f9 in) is version 2 and the Event carries both; its removal effect is drained by slot 4 into the REAL removal queue.
{
 list=['f0','f1','f2','f9'];
 await slot(T('2026-11-21T21:40:00Z'));
 assert.equal(rowOf('2026-11-21T2230').w,'committed');assert.equal(db.sql('SELECT version FROM watchlist_current')[0].version,2);
 const events=[...bucket.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
 const wl=events.find(e=>e.type==='watchlist'&&e.slot==='2026-11-21T2230');
 assert.equal(wl.addedCount,1);assert.equal(wl.removedCount,1);
 await slot(T('2026-11-22T03:40:00Z')); // the 22:30 slot's window; the next slot drains version 2's effects
 const next=await LetterboxdSync.ensure(env,{now:T('2026-11-22T04:40:00Z')});
 assert.ok(next.slot);
 const queue=db.sql("SELECT key,body FROM ratings_document").find(r=>/removal/i.test(r.key));
 assert.ok(queue,'the real removal-lookup queue received the removed film');
 assert.match(String(queue.body),/f3/);
}
// 5b. The real admission step ran through the real identity bridge: the ids added by the promotions are in the durable ledger. With the canonical catalog reader closed (the default marker here) the bridge
// defers them WITHOUT any source request, so the rows stay pending and unchanged; nothing was guessed and no Film was admitted from a title.
{
 const rows=db.sql('SELECT lid,state,attempts FROM watchlist_admission_pending ORDER BY lid');
 assert.ok(rows.length>=5,'the ledger holds the added ids: '+rows.map(r=>r.lid).join(','));
 assert.ok(rows.every(r=>r.state==='pending'||r.state==='superseded'),'nothing resolved without a verified identity');
 assert.ok(rows.filter(r=>r.state==='pending').every(r=>r.attempts===0),'a deferral is not an attempt');
 assert.deepEqual(fetched.filter(u=>/boxd\.it|themoviedb|\/film\/[a-z0-9-]+\/$/.test(u)&&!/\/demo-user\/film\//.test(u)),[],'no identity check reached the source for an unverifiable id (the member-page lookup of a removed film is the removal reconciliation, not admission)');
 assert.equal(rows.find(r=>r.lid==='f3')?.state,'superseded','f3 left the Watchlist before it resolved');
}
// 6. Exactly two Events per closed slot, whatever the outcome; never a third.
{
 const events=[...bucket.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v).filter(e=>/^lbsync-/.test(e.id));
 const per=new Map();for(const e of events)per.set(e.slot,(per.get(e.slot)||0)+1);
 for(const [slotKey,count] of per)assert.equal(count,2,slotKey);
 assert.ok(per.size>=3);
}
// 7. The real Ratings and reconciliation phases ran for every slot, the pipeline wrote NO Event of its own (only the slot outbox did), and the Diary writes are fenced by the Letterboxd epoch.
{
 const slots=db.sql("SELECT slot_key,status,ratings_outcome AS r,reconciliation_outcome AS c FROM letterboxd_slot WHERE closed_at IS NOT NULL");
 assert.ok(slots.length>=3);
 for(const row of slots){assert.equal(row.r,'finished',row.slot_key+' ratings');assert.equal(row.c,'done',row.slot_key+' reconciliation');}
 const runDoc=db.sql("SELECT body FROM ratings_document WHERE key='letterboxd/ratings/run.json'");
 const run=JSON.parse(runDoc.map(r=>r.body).join(''));
 assert.ok(run.slotKey&&/^\d{4}-\d{2}-\d{2}T\d{4}$/.test(run.slotKey),'the pipeline run carries the slot key');
 assert.equal(run.state,'finished');
 const eventIds=[...bucket.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v.id);
 assert.ok(eventIds.length>0&&eventIds.every(id=>/^lbsync-/.test(id)),'no ratings Event of the pipeline: '+eventIds.join(','));
 // A stale epoch: the Diary phase refuses and the run document is untouched.
 const before=JSON.stringify(db.sql("SELECT key,etag FROM ratings_document WHERE key='letterboxd/ratings/run.json'"));
 const stale=await G('letterboxdPorts')(env).ratings.run({env,slotKey:'2026-11-23T0430',runId:'x',epoch:99,now:()=>T('2026-11-23T04:40:00Z')}).then(()=>'resolved',()=>'rejected');
 assert.equal(stale,'rejected','a stale epoch is refused');
 assert.equal(JSON.stringify(db.sql("SELECT key,etag FROM ratings_document WHERE key='letterboxd/ratings/run.json'")),before,'nothing was written');
}
// 8. Review: the two Events keep their business contracts, through the REAL `GET /api/events`: the `watchlist` Event lists films with `id`, `title` and `year` (never `id: "undefined"`), the removed film carries
// its stored confirmed rating, and the `ratings` Event carries the AIR-361 groups (state, diary, removal, details) frozen from the real pipeline run, including the newly rated film. Exactly two keys per slot.
{
 const response=await context.worker.fetch(new Request('https://iptv.example/api/events'),env,{waitUntil(){}});
 assert.equal(response.status,200);
 const body=await response.json();
 const events=body.events||body.items||body;
 assert.ok(Array.isArray(events),'the events list: '+JSON.stringify(Object.keys(body)));
 const mine=events.filter(e=>/^lbsync-/.test(String(e.id)));
 assert.ok(mine.length>=6,'the slot Events are listed: '+mine.length);
 assert.ok(!mine.some(e=>e.id==='undefined'||(e.added||[]).concat(e.removed||[]).some(f=>f.id==='undefined'||f.id==null)),'no film lost its identity');
 const replacement=mine.find(e=>e.type==='watchlist'&&e.slot==='2026-11-21T2230');
 assert.deepEqual((replacement.added||[]).map(f=>[f.id,f.title,f.year]),[['f9','Film f9',2001]]);
 assert.equal(replacement.removed.length,1);assert.equal(replacement.removed[0].id,'f3');assert.equal(replacement.removed[0].title,'Film f3');assert.equal(replacement.removed[0].rating,4,'the removed film shows the confirmed rating the fact store held');
 const first=mine.find(e=>e.type==='ratings'&&e.slot==='2026-11-21T1030');
 assert.equal(first.state,'finished');assert.ok(first.diary&&first.diary.rows>=2,'the Diary group of the contract');assert.ok(first.removal,'the removal group of the contract');assert.ok(first.details,'the details of the films the run changed');
 assert.equal(first.diary.added,2,'both newly rated Diary films were recorded');assert.equal(first.diary.written,2);
 assert.ok(first.at&&first.runId&&first.trigger,'the contract identity fields');
 const keys=[...bucket.records.keys()].filter(k=>k.startsWith('events/items/')&&/lbsync-/.test(k));
 const perSlot=new Map();for(const k of keys){const slotKey=bucket.records.get(k).slot;perSlot.set(slotKey,(perSlot.get(slotKey)||0)+1);}
 for(const [k,count] of perSlot)assert.equal(count,2,'exactly two keys for '+k);
}
console.log('letterboxd-sync-bundle ok');
