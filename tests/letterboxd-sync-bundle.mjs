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
// AIR-558: the facts reader's view-index version token (viewIndexD1Version) reads both domain markers, so the stand-in runs the prediction domain in d1 as production does.
const file=path.join(root,'db.sqlite');
{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain+"\nUPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;\nUPDATE ratings_domain_authority SET mode='d1',cutover='open' WHERE id=1;\nUPDATE metadata_cache_authority SET mode='d1' WHERE id=1;UPDATE prediction_domain_authority SET mode='d1' WHERE id=1;"});assert.equal(r.status,0,r.stderr);}
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
// The Worker's own clock reads (`Date.now()`, `new Date()`) are frozen before every fixed time of this test, so the result does not depend on the day it runs (it once failed the moment the wall clock passed the fixed 2026-11-21 slot times).
const FROZEN=Date.parse('2026-11-21T00:00:00Z');
const FrozenDate=class extends Date{constructor(...args){super(...(args.length?args:[FROZEN]));}static now(){return FROZEN;}};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:FrozenDate,Intl,Map,Set,JSON,Math,TextEncoder,TextDecoder,Uint8Array,atob,btoa,encodeURIComponent,decodeURIComponent,structuredClone,crypto:webcrypto,setTimeout,clearTimeout,console:{log(){},error:(...a)=>process.stderr.write(a.join(' ')+'\n'),warn(){}},ASSETS:{},fetch:fakeFetch});
vm.runInContext(source.replace(/export \{[^}]+\};/g,'').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
const run=code=>vm.runInContext(code,context);
const G=name=>run(name);

// 1. The bundle has the ports and the control plane; the Watchlist phase and the three effect writers are the real ones.
assert.equal(typeof G('letterboxdPorts'),'function');
const ports=G('letterboxdPorts')(env);
assert.deepEqual(Object.keys(ports).sort(),['effects','handover','handoverGuards','mirror','ratings','reconcile','watchlist'],'every phase has a real adapter, the handover proof is read from live state and pinned at the commit, and the causal effects are read');
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
 // AIR-571 D (review): a legacy Ratings request ADMITTED while the Letterboxd mode was `external` must not commit after the mode moved. Its fence carries the Letterboxd mode revision it saw, and every authoritative
 // commit asserts it in its own batch: the same write that goes through before the close is rejected after it, with the data untouched.
 {
  const gate=await run("RatingsOrchestration.externalGate(__env,'start')");
  assert.equal(gate.reason,null);assert.equal(Number.isInteger(gate.fence.letterboxdRevision),true,'the admission records the Letterboxd mode revision');
  const attempt=()=>run("(async()=>{const cur=await LetterboxdRatings.readDocument(__env,'letterboxd/diary/state.json');const fenced={...__env,ratingsFence:"+JSON.stringify(gate.fence)+"};try{const saved=await LetterboxdRatings.writeDocument(fenced,'letterboxd/diary/state.json',cur.object,{...cur.value,probe:Math.random()});return saved?'written':'refused:fenced';}catch(error){return 'refused:'+(error.code||error.message);}})()");
  assert.equal(await attempt(),'written','before the close the admitted request commits');
  const gate2=await run("RatingsOrchestration.externalGate(__env,'start')");Object.assign(gate,{fence:gate2.fence});
  assert.equal(await attempt(),'written');
  await LetterboxdSync.switchMode(env,{action:'close_admission',target:'cloudflare'},ports,T('2026-11-21T09:39:00Z'));
  const afterClose=await attempt();
  assert.match(afterClose,/^refused:/,'after the Letterboxd mode moved, an already admitted legacy request commits nothing');
  // Review (TOCTOU at admission): the fence decision and the pin come from ONE read of the Letterboxd row. The row moves right AFTER that read (a close lands at the worst moment): the request was admitted
  // as `external` at revision R, and its commit is refused, on both legacy entry points; and there is no second read that could pick up the new owner's revision.
  {
   db.sql('DELETE FROM letterboxd_sync_mode');
   const modeReads=[];let mutateAfterRead=null;
   const watched=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const prepared=target.prepare(sql);if(!/letterboxd_sync_mode/.test(sql)||!/^\s*SELECT/i.test(sql))return prepared;modeReads.push(sql);return {bind:(...params)=>{const bound=prepared.bind(...params);return {...bound,async first(){const row=await bound.first();if(mutateAfterRead){const fn=mutateAfterRead;mutateAfterRead=null;fn();}return row;}};},async first(){const row=await prepared.first();if(mutateAfterRead){const fn=mutateAfterRead;mutateAfterRead=null;fn();}return row;}};};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
   const watchedEnv={...env,DB:watched};context.__watched=watchedEnv;
   for(const action of ['start','step']){
    modeReads.length=0;
    const gate=await run("RatingsOrchestration.externalGate(__watched,'"+action+"',{runId:'x'})");
    assert.equal(gate.reason,null);assert.equal(modeReads.length,1,'one read of the Letterboxd row decides the fence AND returns the pin ('+action+')');
    assert.equal(gate.fence.letterboxdRevision,0);
   }
   for(const [name,mutate] of [['the epoch closes (revision moves)',()=>db.sql("INSERT INTO letterboxd_sync_mode (id,mode,target,from_mode,epoch,changed_at,revision,write_id) VALUES (1,'switching','cloudflare','external',1,'2030-01-01T00:00:00.000Z',1,'w')")],['the mode flips without a revision move',null]]){
    db.sql('DELETE FROM letterboxd_sync_mode');
    if(!mutate){db.sql("INSERT INTO letterboxd_sync_mode (id,mode,epoch,changed_at,revision,write_id) VALUES (1,'external',0,'2030-01-01T00:00:00.000Z',5,'w')");}
    modeReads.length=0;
    mutateAfterRead=mutate||(()=>db.sql("UPDATE letterboxd_sync_mode SET mode='switching',target='cloudflare',from_mode='external' WHERE id=1"));
    const gate=await run("RatingsOrchestration.externalGate(__watched,'start')");
    assert.equal(gate.reason,null,name+': admitted by the read it saw');assert.equal(modeReads.length,1);
    gate.fence;Object.assign(globalThis,{});
    const attempted=await run("(async()=>{const cur=await LetterboxdRatings.readDocument(__env,'letterboxd/diary/state.json');const fenced={...__env,ratingsFence:"+JSON.stringify(gate.fence)+"};const saved=await LetterboxdRatings.writeDocument(fenced,'letterboxd/diary/state.json',cur.object,{...cur.value,probe:Math.random()});return saved?'written':'refused:fenced';})()");
    assert.equal(attempted,'refused:fenced',name+': the stale request commits nothing against the new owner');
   }
  }
  // AIR-571 D2 (preactivation QA): the Watchlist clause of the commit guard with REAL marker changes, and the Ratings `ensure` path with the same single admission pin.
  {
   const probe=async fence=>run("(async()=>{const cur=await LetterboxdRatings.readDocument(__env,'letterboxd/diary/state.json');const fenced={...__env,ratingsFence:"+JSON.stringify(fence)+"};const saved=await LetterboxdRatings.writeDocument(fenced,'letterboxd/diary/state.json',cur.object,{...cur.value,probe:Math.random()});return saved?'written':'refused:fenced';})()");
   const marker=db.sql('SELECT mode, writes FROM watchlist_authority')[0];
   // a reverse handover is complete (epoch 2, external) and the Watchlist is back on the inert authority: the legacy entry is admitted, with the Watchlist clause
   db.sql("DELETE FROM letterboxd_sync_mode");db.sql("INSERT INTO letterboxd_sync_mode (id,mode,epoch,changed_at,revision,write_id) VALUES (1,'external',2,'2030-01-01T00:00:00.000Z',7,'w')");
   db.sql("UPDATE watchlist_authority SET mode='epg',writes='open'");
   const admitted=await run("RatingsOrchestration.externalGate(__env,'start')");
   assert.equal(admitted.reason,null);assert.deepEqual([admitted.fence.letterboxdRevision,admitted.fence.watchlistGuard],[7,true]);
   assert.equal(await probe(admitted.fence),'written');
   for(const [name,change,restore] of [['writes held (a hold)',"UPDATE watchlist_authority SET writes='held'","UPDATE watchlist_authority SET writes='open'"],['the marker moves to d1 (a forward cutover began)',"UPDATE watchlist_authority SET mode='d1'","UPDATE watchlist_authority SET mode='epg'"]]){
    db.sql(change);
    assert.equal(await probe(admitted.fence),'refused:fenced','an admitted request commits nothing after: '+name);
    assert.equal((await run("RatingsOrchestration.externalGate(__env,'start')")).reason,'external_writer_fenced','and a new admission is refused: '+name);
    db.sql(restore);
   }
   // fail closed: the Watchlist authority table is gone after a recorded epoch (a partial schema): never the inert pre-switch state
   db.sql('ALTER TABLE watchlist_authority RENAME TO watchlist_authority_gone');
   assert.equal((await run("RatingsOrchestration.externalGate(__env,'start')")).reason,'external_writer_fenced','partial schema after a switch fails closed');
   db.sql('ALTER TABLE watchlist_authority_gone RENAME TO watchlist_authority');
   db.sql("UPDATE watchlist_authority SET mode='"+marker.mode+"',writes='"+marker.writes+"'");
  }
  db.sql('DELETE FROM letterboxd_sync_mode');// the owner's real abort is covered in letterboxd-sync.mjs; here the row returns to its absent default for the sections below
 }
 await LetterboxdSync.switchMode(env,{action:'close_admission',target:'cloudflare'},ports,T('2026-11-21T09:39:00Z'));
 const proof=await ports.handover(env);
 assert.deepEqual(JSON.parse(JSON.stringify(proof)),{ratingsClosed:true,ratingsDrained:true,legacyFenced:true,watchlistRepository:true,ratingsPhase:true});
 // A Ratings mode that is not closed refuses, whatever else holds.
 const ratingsOpen=await (async()=>{await run("LetterboxdRatings.writeDocument(__env,'letterboxd/ratings/executor.json',null,{schemaVersion:1,mode:'cloudflare',epoch:1,drain:null})");const p=await ports.handover(env);await run("LetterboxdRatings.readDocument(__env,'letterboxd/ratings/executor.json').then(r=>LetterboxdRatings.writeDocument(__env,'letterboxd/ratings/executor.json',r.object,{schemaVersion:1,mode:'external',epoch:2,drain:null}))");return p;})();
 assert.equal(ratingsOpen.ratingsClosed,false,'a Ratings executor that is still cloudflare is not closed');
 // The proof is read outside the commit and PINNED at it (AIR-571 D): the guards of the real port assert the Watchlist marker and the stored etags of the Ratings mode, control and run records in the same
 // batch as the mode write. A fact that changes after the proof was read aborts the completion; once it is as read again, the same completion goes through.
 {
  const proofNow=await ports.handover(env);
  const guards=await ports.handoverGuards(env,proofNow);
  assert.equal(Array.isArray(guards)&&guards.length,1,'the real port pins the facts of its proof');
  assert.match(guards[0][0],/watchlist_authority/);assert.match(guards[0][0],/ratings_document/);assert.match(guards[0][0],/ratings_domain_authority/);
  assert.equal(await ports.handoverGuards(env,{...proofNow}),null,'a proof copied without its captured evidence cannot be pinned');
  assert.equal(await ports.handoverGuards(env),null,'no proof, no pins');
  const before=await LetterboxdSync.readMode(env);
  const asOwner={expectEpoch:before.epoch,expectRevision:before.revision};
  const now=T('2026-11-21T09:39:00Z');
  // a fact moves AFTER the proof was read and BEFORE the guards are built (the real race): the guards still pin what the proof saw, so the commit is refused and nothing is written
  const moving=mutate=>({handover:async e=>{const proof=await ports.handover(e);mutate();return proof;},handoverGuards:ports.handoverGuards,effects:ports.effects});
  for(const [name,mutate,restore] of [
   ['the Watchlist marker generation',()=>db.sql("UPDATE watchlist_authority SET generation=generation+1 WHERE id=1"),()=>db.sql("UPDATE watchlist_authority SET generation=generation-1 WHERE id=1")],
   ['the Ratings domain generation (any Ratings commit)',()=>db.sql("UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1"),()=>db.sql("UPDATE ratings_domain_authority SET generation=generation-1 WHERE id=1")],
   ['the Ratings run record etag',()=>db.sql("UPDATE ratings_document SET etag='moved' WHERE key='letterboxd/ratings/run.json' AND part=0"),null],
  ]){
   const hadRun=db.sql("SELECT 1 AS x FROM ratings_document WHERE key='letterboxd/ratings/run.json' AND part=0").length>0;
   if(!hadRun&&!restore){continue;}
   const result=await LetterboxdSync.switchMode(env,{action:'complete',...asOwner},moving(mutate),now);
   if(restore)restore();
   assert.equal(result.refused,'handover_changed',name+' '+JSON.stringify(result));
   assert.equal((await LetterboxdSync.readMode(env)).mode,'switching','nothing was written');
  }
  // the proof itself is unstable when a fact moves WHILE it is read: it reads as false, never as a partly proven handover
  {
   let calls=0;
   const flaky=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const prepared=target.prepare(sql);if(/FROM ratings_domain_authority/.test(sql)&&++calls===2)target.sql("UPDATE ratings_domain_authority SET generation=generation+1 WHERE id=1");return prepared;};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
   const unstable=await ports.handover({...env,DB:flaky});
   db.sql("UPDATE ratings_domain_authority SET generation=generation-1 WHERE id=1");
   assert.equal(Object.values(JSON.parse(JSON.stringify(unstable))).every(value=>value===false),true,'a proof whose facts moved while it was read is false');
  }
  // a watchlist marker that is not an open d1 cannot be pinned: the port returns null and the handover is refused
  db.sql("UPDATE watchlist_authority SET writes='held' WHERE id=1");
  assert.equal(await ports.handoverGuards(env,await ports.handover(env)),null);
  db.sql("UPDATE watchlist_authority SET writes='open' WHERE id=1");
 }
 const modeNow=await LetterboxdSync.readMode(env);
 const done=await LetterboxdSync.switchMode(env,{action:'complete',expectEpoch:modeNow.epoch,expectRevision:modeNow.revision},ports,T('2026-11-21T09:39:00Z'));
 assert.equal(done.completed,true,JSON.stringify(done));
}
// 2a. The owner's control route (AIR-571 D): a read-only status and one command with its confirmation and pins, through the real Worker.
{
 const get=async()=>{const response=await context.worker.fetch(new Request('https://iptv.example/api/letterboxd/sync/mode'),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
 const post=async body=>{const response=await context.worker.fetch(new Request('https://iptv.example/api/letterboxd/sync/mode',{method:'POST',body:JSON.stringify(body)}),env,{waitUntil(){}});return {status:response.status,body:await response.json()};};
 const status=await get();
 assert.equal(status.status,200);assert.equal(status.body.readable,true);assert.equal(status.body.mode.mode,'cloudflare');assert.equal(status.body.sideEffects,'none');
 assert.equal(status.body.legacyFenced,true);assert.equal(status.body.letterboxdWriters,1);assert.equal(typeof status.body.effects.drained,'boolean');
 assert.equal(status.body.handover.ratingsClosed,true,'the proof is read from live state');
 const rowBefore=await LetterboxdSync.readMode(env);
 assert.equal((await get()).body.mode.revision,rowBefore.revision,'the status wrote nothing');
 // no confirmation / no pins: refused before anything runs
 assert.deepEqual((await post({action:'close_admission',target:'external'})).body,{error:'Missing confirm'});
 assert.equal((await post({action:'close_admission',target:'external'})).status,400);
 assert.deepEqual((await post({action:'complete',confirm:'complete',expectEpoch:rowBefore.epoch,expectRevision:rowBefore.revision})).body.refused,'not_switching');
 // a stale pin is refused and writes nothing
 const stale=await post({action:'close_admission',target:'external',confirm:'close_admission',expectEpoch:rowBefore.epoch+5,expectRevision:rowBefore.revision});
 assert.equal(stale.status,200);assert.deepEqual([stale.body.refused,stale.body.pin],['pin_mismatch','epoch']);
 assert.equal((await LetterboxdSync.readMode(env)).revision,rowBefore.revision,'a stale pin changed nothing');
}
// 2b. Active: the same status and monitor facts now carry the slot read model, read only.
{
 const model=await run('LetterboxdRatings.status(__env,'+T('2026-11-21T09:45:00Z')+').then(s=>s.letterboxdSync)');
 assert.equal(model.mode,'cloudflare');assert.equal(model.sideEffects,'none');assert.equal(model.slot.key,'2026-11-21T1030');
 const facts=await run('Monitor.collect(__env,'+T('2026-11-21T09:45:00Z')+',null)');
 assert.equal(facts.letterboxd.mode,'cloudflare');
 // AIR-599 (review of PR #1009): the real fact reader of the shared Letterboxd check. Nothing waiting is healthy and readable; an unreadable ledger is reported, never read as zero.
 const check=facts.letterboxd.identityCheck;
 assert.ok(check&&!check.error&&check.ledgerUnreadable===false,'the identity check facts are read: '+JSON.stringify(check));
 assert.deepEqual([check.work,check.backlog,check.overdue,check.overdueUnknown],[0,0,0,0]);
 db.sql('ALTER TABLE watchlist_admission_pending RENAME TO watchlist_admission_pending_hidden');
 const broken=await run('Monitor.collect(__env,'+T('2026-11-21T09:45:00Z')+',null)');
 assert.equal(broken.letterboxd.identityCheck.ledgerUnreadable,true,'an unreadable ledger is a fact, not a zero');
 db.sql('ALTER TABLE watchlist_admission_pending_hidden RENAME TO watchlist_admission_pending');
}
// 2c. AIR-691: the fact reader and the policy TOGETHER, on the real owner requeue/createMissing path. A backlog is the ordinary queue; only a document with no free place for a waiting id is a cap refusal.
{
 const at=T('2026-11-21T09:45:00Z'),iso=new Date(at).toISOString();
 const judge=async()=>{const facts=await run('Monitor.collect(__env,'+at+',null)');const check=facts.letterboxd.identityCheck;return {check,keys:[...run('MonitorPolicy').evaluateLetterboxd(facts.letterboxd,at).issues.map(issue=>issue.key).filter(key=>/identity_(cap_refused|backlog_full)/.test(key))]};};
 const owner=async(action,lids,extra='')=>{const version=await run('LetterboxdFacts.readDiaryIdentityVersioned(__env).then(r=>r.version)');return run('LetterboxdFacts.ownerAction(__env,'+JSON.stringify({action,lids,createMissing:true,slugs:Object.fromEntries(lids.map(l=>[l,'slug-'+l])),expectedVersion:version,by:'owner',why:'test',at:iso})+')');};
 const entry=(reason,over={})=>({reason,class:reason==='owner_dismissed'?'settled':'not_now',slug:null,attempts:0,streak:0,queuedAt:iso,lastAttemptAt:iso,nextAttemptAt:iso,...over});
 const put=set=>run('LetterboxdFacts.updateDiaryIdentity(__env,{set:'+JSON.stringify(set)+'})');
 // 1. owner requeue/createMissing into an empty document: a backlog with free room, a healthy slot, no cap_refused, no backlog_full
 const waiting=Array.from({length:14},(_,i)=>'wait'+i);
 assert.equal((await owner('requeue',waiting)).state,'applied');
 let seen=await judge();
 assert.equal(seen.check.backlog,14);assert.equal(seen.check.capFull,false);assert.equal(seen.check.capHeld,0);assert.deepEqual(seen.keys,[],'a backlog with free capacity is not a cap refusal: '+JSON.stringify(seen.check));
 // 2. real exhaustion: 200 entries no one may evict, ids waiting -> cap_refused (not backlog_full)
 const held=Object.fromEntries(Array.from({length:200},(_,i)=>['held'+i,entry('deferred')]));
 await put(held);
 seen=await judge();assert.deepEqual([seen.check.capHeld,seen.check.capFull,seen.check.backlogFull],[200,true,false]);assert.deepEqual(seen.keys,['letterboxd_identity_cap_refused']);
 // 3. an evictable owner_dismissed entry is free room: the same waiting ids are an ordinary queue again
 await put({held0:entry('owner_dismissed')});
 seen=await judge();assert.deepEqual([seen.check.capHeld,seen.check.capFull],[199,false]);assert.deepEqual(seen.keys,[],'room freed by an evictable entry');
 // 4. recovery: the freed place and a refilled one; an empty backlog never reports a refusal even with a full document
 await put({held0:entry('deferred')});
 assert.deepEqual((await judge()).keys,['letterboxd_identity_cap_refused']);
 await run('LetterboxdFacts.updateDiaryIdentity(__env,{backlogRemove:'+JSON.stringify(waiting)+'})');
 seen=await judge();assert.deepEqual([seen.check.backlog,seen.check.capFull],[0,false]);assert.deepEqual(seen.keys,[],'a full document without waiting ids is healthy');
 // 5. the backlog at its real bound stays backlog_full
 await run('LetterboxdFacts.updateDiaryIdentity(__env,{backlogAdd:'+JSON.stringify(Object.fromEntries(Array.from({length:2000},(_,i)=>['full'+i,{slug:null,queuedAt:iso,attempts:0}])))+'})');
 seen=await judge();assert.equal(seen.check.backlogFull,true);assert.deepEqual(seen.keys,['letterboxd_identity_backlog_full']);
 // 6. one snapshot (review of PR #1041): the document is read ONCE, so capacity and backlog come from the same version. An atomic transition (200 held, empty backlog) -> (199 held, one requeued id) that lands
 // between two reads would combine into 200 held + 1 waiting, a refusal neither committed state has.
 await run('LetterboxdFacts.updateDiaryIdentity(__env,{backlogRemove:'+JSON.stringify(Array.from({length:2000},(_,i)=>'full'+i))+'})');
 assert.deepEqual([(await judge()).check.backlog,(await judge()).check.capHeld],[0,200],'the starting version: full document, nothing waiting');
 await run(`(()=>{const F=LetterboxdFacts,identity=F.readDiaryIdentity,backlog=F.readDiaryBacklog;globalThis.__reads=[];
  const move=()=>F.updateDiaryIdentity(__env,{set:{held0:${JSON.stringify(entry('owner_dismissed'))}},backlogAdd:{late:{slug:null,queuedAt:${JSON.stringify(iso)},attempts:0}}});
  F.readDiaryIdentity=async env=>{__reads.push('identity');return identity(env);};
  F.readDiaryBacklog=async env=>{__reads.push('backlog');await move();return backlog(env);};
  globalThis.__undo=()=>{F.readDiaryIdentity=identity;F.readDiaryBacklog=backlog;};})()`);
 const snap=await judge();const reads=[...await run('__reads')];await run('__undo()');
 assert.deepEqual(reads,['identity'],'the document is read once and the backlog is its own field');
 assert.deepEqual([snap.check.capHeld,snap.check.backlog,snap.check.capFull],[200,0,false]);assert.deepEqual(snap.keys,[],'no refusal is built from two versions');
 await run('LetterboxdFacts.updateDiaryIdentity(__env,{set:{held0:'+JSON.stringify(entry('deferred'))+'},backlogRemove:["late"]})');
 // restore the document for the slots below
 await run('LetterboxdFacts.updateDiaryIdentity(__env,{clear:'+JSON.stringify(Object.keys(held))+',backlogRemove:'+JSON.stringify(Array.from({length:2000},(_,i)=>'full'+i))+'})');
 assert.deepEqual([(await judge()).check.backlog,(await judge()).check.capHeld],[0,0]);
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
// 5. Slot 3: a 1-for-1 replacement (f3 out, f9 in) is version 2 and the Event carries both. Its removal effect is applied IN THE SAME RUN (before phase 3): the REAL removal queue holds f3 with a reference to this slot's own
// Event key, and the member-page lookup of f3 happens in that very slot (the accepted sequence), even though the Event object is only stored when the slot closes.
{
 list=['f0','f1','f2','f9'];
 const lookupsBefore=fetched.filter(u=>/\/demo-user\/film\/f3\//.test(u)).length;
 await slot(T('2026-11-21T21:40:00Z'));
 assert.equal(rowOf('2026-11-21T2230').w,'committed');assert.equal(db.sql('SELECT version FROM watchlist_current')[0].version,2);
 const events=[...bucket.records.entries()].filter(([k])=>k.startsWith('events/items/')).map(([,v])=>v);
 const wl=events.find(e=>e.type==='watchlist'&&e.slot==='2026-11-21T2230');
 assert.equal(wl.addedCount,1);assert.equal(wl.removedCount,1);
 const queue=db.sql("SELECT key,body FROM ratings_document").find(r=>/removal/i.test(r.key));
 assert.ok(queue,'the real removal-lookup queue received the removed film');
 assert.match(String(queue.body),/f3/);
 assert.match(String(queue.body),/"lastResult":"fact"/,'f3 had a confirmed rating in the fact store: phase 3 reconciled it from that fact in the same run, with no request');
 const eventKey=[...bucket.records.keys()].find(k=>/lbsync-20261121T2230-watchlist/.test(k));
 assert.ok(eventKey,'the slot Event was delivered');
 assert.ok(String(queue.body).includes(eventKey),'the removal reference names exactly the key the slot Event was stored under');
}
// 5c. A removed film with NO stored rating is looked up by phase 3 of the SAME slot: f2 leaves at 03:40, and its member page is requested in that very run.
{
 list=['f0','f1','f9'];
 const lookups=()=>fetched.filter(u=>/\/demo-user\/film\/f2\//.test(u)).length;
 const before=lookups();
 await slot(T('2026-11-22T03:40:00Z'));
 assert.equal(rowOf('2026-11-22T0430').w,'committed');
 assert.ok(lookups()>before,'the removed, unrated film was looked up in the slot that observed its removal');
 assert.ok(db.sql("SELECT key,body FROM ratings_document WHERE key='enrichment/removal-rating-lookups.json'").map(r=>r.body).join('').includes('"f2"'),'f2 is in the real removal queue');
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
// 8b. Review P2 (ADR 0186 decision 5, ADR 0170): a TERMINAL admission row reaches the owner's identity work inventory as a `watchlist_admission` row needing an owner decision, with the title the first-seen
// snapshot listed; pending rows are listed as waiting or retryable; resolved and superseded rows only with include=resolved. Read only (the route writes nothing).
{
 const sqlRun=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sqlRun("UPDATE watchlist_admission_pending SET state='terminal', last_reason='age_exceeded', attempts=2, next_retry_at=NULL WHERE lid='f9';");
 const call=async query=>{context.__req=new Request('https://iptv.example/api/admin/identity-work'+query);context.__url=new URL(context.__req.url);const response=await run('adminIdentityWorkRoute(__req,__env,__url)');return {status:response.status,body:await response.json()};};
 context.__env=env;
 const before=JSON.stringify(db.sql('SELECT lid,state,attempts FROM watchlist_admission_pending ORDER BY lid'));
 const terminal=await call('?type=watchlist_admission&disposition=needs_owner_review');
 assert.equal(terminal.status,200);
 assert.deepEqual(terminal.body.rows.map(r=>[r.key,r.type,r.status,r.reason,r.disposition,r.title,r.year]),[['wla:f9','watchlist_admission','terminal','age_exceeded','needs_owner_review','Film f9',2001]]);
 assert.equal(terminal.body.rows[0].film,null,'the identity stays a Film fact: no Film link is claimed');
 assert.equal(terminal.body.coverage.watchlist_admission.state,'complete');
 assert.ok(terminal.body.vocabulary.types.includes('watchlist_admission'));
 const open=await call('?type=watchlist_admission');
 assert.ok(open.body.rows.every(r=>r.disposition!=='resolved'),'resolved and superseded rows are history');
 assert.ok(open.body.rows.some(r=>r.status==='pending'),'pending rows are listed');
 const all=await call('?type=watchlist_admission&include=resolved');
 assert.ok(all.body.rows.some(r=>r.status==='superseded'&&r.disposition==='resolved'),'a superseded row appears with include=resolved');
 assert.equal(JSON.stringify(db.sql('SELECT lid,state,attempts FROM watchlist_admission_pending ORDER BY lid')),before,'the route changed nothing');
}
// 8c. Review (owner visibility is complete): behind 1100 historical resolved/superseded rows the NEWEST terminal row is still listed by the real route with `type=watchlist_admission&disposition=needs_owner_review`
// (the filter is in SQL before any page limit), a full walk of the ledger lane by cursor loses and repeats nothing, a cursor does not cross a Watchlist authority switch, and the route writes nothing.
{
 const sqlRun=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
 sqlRun("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<1100) INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) SELECT 'h'||printf('%05d',i), 'gone', 1, CASE WHEN i%2=0 THEN 'resolved' ELSE 'superseded' END, 1, NULL, NULL, CASE WHEN i%2=0 THEN 'identity:603' ELSE NULL END, '2026-11-01T00:00:00.000Z' FROM n;");
 sqlRun("INSERT INTO watchlist_admission_pending (lid, first_seen_snapshot_id, first_seen_version, state, attempts, next_retry_at, last_reason, resolved_by, updated_at) VALUES ('newest-terminal','gone',9999,'terminal',6,NULL,'age_exceeded',NULL,'2026-11-21T09:00:00.000Z');");
 const call=async query=>{context.__req=new Request('https://iptv.example/api/admin/identity-work'+query);context.__url=new URL(context.__req.url);context.__env=env;const response=await run('adminIdentityWorkRoute(__req,__env,__url)');return {status:response.status,body:await response.json()};};
 const snapshot=()=>JSON.stringify(db.sql('SELECT lid,state,attempts,next_retry_at FROM watchlist_admission_pending ORDER BY lid'));
 const before=snapshot();
 const owner=await call('?type=watchlist_admission&disposition=needs_owner_review');
 assert.equal(owner.status,200);
 const keys=owner.body.rows.map(r=>r.key);
 assert.ok(keys.includes('wla:newest-terminal'),'the newest terminal row is reachable behind 1100 historical rows: '+keys.join(','));
 assert.ok(owner.body.rows.every(r=>r.disposition==='needs_owner_review'),'only owner-review rows');
 assert.ok(owner.body.rows.length>=1&&owner.body.coverage.watchlist_admission.state==='complete','no false empty worklist, no unexplained partial coverage');
 // A paged walk with include=resolved: every ledger row exactly once.
 let cursor=null,seen=[],pages=0;
 for(;pages<60;pages++){const page=await call('?type=watchlist_admission&include=resolved&limit=25'+(cursor?'&cursor='+encodeURIComponent(cursor):''));assert.equal(page.status,200,JSON.stringify(page.body));seen.push(...page.body.rows.map(r=>r.key));cursor=page.body.nextCursor;if(!cursor)break;}
 const expected=db.sql('SELECT lid FROM watchlist_admission_pending ORDER BY first_seen_version, lid').map(r=>'wla:'+r.lid);
 assert.deepEqual(seen,expected,'the cursor walk visits every ledger row exactly once, in keyset order');
 // A cursor minted under another Watchlist authority generation is refused, not silently continued.
 const first=await call('?type=watchlist_admission&include=resolved&limit=25');
 sqlRun("UPDATE watchlist_authority SET generation=generation+1;");
 const crossed=await call('?type=watchlist_admission&include=resolved&limit=25&cursor='+encodeURIComponent(first.body.nextCursor));
 assert.equal(crossed.status,400);assert.equal(crossed.body.error,'stale_cursor');
 sqlRun("UPDATE watchlist_authority SET generation=generation-1;");
 assert.equal(snapshot(),before,'the route and the whole walk changed nothing');
}
// 9. Review (stale writer): the owner closes admission WHILE an effect's side effect is in flight. A new promotion leaves effects pending; then the real facts module is made to flip the mode between the effect's
// entry and its commit. The commit goes through the fenced env, so the stale writer changes NOTHING (the ratings documents are byte-identical), no effect receipt is recorded, and the effect stays pending.
{
 list=['f0','f1','f2','f8'];
 const promoted=await ports.watchlist.run({env,slotKey:'2026-11-23T0430',runId:'promote',epoch:1,now:()=>T('2026-11-23T03:40:00Z'),deadline:T('2026-11-23T09:00:00Z')});
 assert.equal(promoted.outcome,'committed','a new promotion (its effects are not applied yet)');
 const pendingBefore=db.sql("SELECT COUNT(*) AS n FROM watchlist_effect WHERE status='pending'")[0].n;
 assert.ok(pendingBefore>=1,'the promotion left causal effects pending');
 const docs=()=>JSON.stringify(db.sql("SELECT key,part,etag FROM ratings_document ORDER BY key,part"));
 const before=docs();
 let flipped=0;
 context.__flipMode=()=>{flipped++;const r=sqliteSync(['-bail',file],{input:"UPDATE letterboxd_sync_mode SET mode='switching', target='external', from_mode='cloudflare', epoch=epoch+1;"});if(r.status!==0)throw new Error(r.stderr);};
 run("(()=>{const original=LetterboxdFacts.applyWatchlistScan;LetterboxdFacts.applyWatchlistScan=async(e,a)=>{__flipMode();return original(e,a);};})()");
 const drain=await ports.watchlist.afterRecorded({env,slotKey:'2026-11-23T0430',runId:'stale',epoch:1,now:()=>T('2026-11-23T03:50:00Z'),deadline:T('2026-11-23T09:00:00Z')});
 assert.equal(flipped,1,'the mode flipped between the effect entry and its commit');
 assert.equal(drain.drained,false,'the stale step applied nothing');
 assert.equal(docs(),before,'ZERO stale mutations: no ratings document changed');
 assert.equal(db.sql("SELECT COUNT(*) AS n FROM watchlist_effect WHERE status='pending'")[0].n,pendingBefore,'no receipt was recorded for the stale effect');
 assert.equal(db.sql('SELECT mode FROM letterboxd_sync_mode')[0].mode,'switching');
}
// AIR-571 E (activation plan): the Worker dispatches the independent `:30` cron to the Letterboxd `ensure` and to nothing else. The cron itself is NOT in wrangler.jsonc (the three existing triggers stay), so this
// dispatch is dormant until the owner's activation GO; with no mode row, or with the mode `external`, it creates nothing.
{
 assert.equal(await run('LetterboxdSync.CRON'),'30 * * * *');
 const fire=async(cron,when)=>{const pending=[];await context.worker.scheduled({cron,scheduledTime:when},env,{waitUntil:p=>pending.push(p)});await Promise.all(pending);};
 const created=()=>wf.created.length;
 // not `cloudflare`: nothing is created (dormant default and the closed modes)
 db.sql("UPDATE letterboxd_sync_mode SET mode='switching',target='cloudflare',from_mode='external'");
 let before=created();await fire('30 * * * *',T('2026-12-01T09:35:00Z'));assert.equal(created(),before,'switching: no slot');
 db.sql("UPDATE letterboxd_sync_mode SET mode='external',target=NULL,from_mode='external'");
 before=created();await fire('30 * * * *',T('2026-12-01T09:35:00Z'));assert.equal(created(),before,'external: no slot');
 // the running writer: the :30 tick claims and creates the slot instance of its Madrid slot (once: a second firing attaches to the same slot)
 db.sql("UPDATE letterboxd_sync_mode SET mode='cloudflare',target=NULL,from_mode='external'");
 before=created();await fire('30 * * * *',T('2026-12-01T09:35:00Z'));assert.equal(created(),before+1,'cloudflare: one instance for the current slot');
 await fire('30 * * * *',T('2026-12-01T09:36:00Z'));assert.equal(created(),before+1,'a duplicate firing creates no second instance');
 // the canary hold: through the real Worker dispatch only the named slot is created; the next days' slots wait for the owner's open_schedule
 db.sql("UPDATE letterboxd_sync_mode SET drain='canary:2026-12-03T1030'");
 const held=created();await fire('30 * * * *',T('2026-12-02T09:35:00Z'));assert.equal(created(),held,'canary hold: a slot of another day is not created');
 await fire('30 * * * *',T('2026-12-03T09:35:00Z'));assert.equal(created(),held+1,'the canary slot is created');
 await fire('30 * * * *',T('2026-12-03T15:35:00Z'));assert.equal(created(),held+1,'and nothing after it until open_schedule');
 db.sql("UPDATE letterboxd_sync_mode SET drain=NULL");
 // another cron expression never reaches the Letterboxd ensure
 const marker=created();await fire('24 3 * * *',T('2026-12-01T15:35:00Z'));assert.equal(created(),marker);
 // restore the state the file ended in
 db.sql("UPDATE letterboxd_sync_mode SET mode='switching',target='cloudflare',from_mode='cloudflare'");
}
console.log('letterboxd-sync-bundle ok');
