// ADR 0203 (AIR-582): the canonical Watchlist membership projection by the Letterboxd Sync (option C of AIR-572). Offline only: the sqlite D1 stand-in with the REAL migration chain; no production database, bucket,
// Letterboxd or Cloudflare is opened and nothing here activates anything. Covers: migration 0037 (additive, the marker is `producer`, the effect rebuild keeps rows), legacy compatibility (three effects, the Producer
// still owns membership), the marker-decided effect set and the switch race, the version-fenced Film writer (V vs V+1, add/remove/re-add, tombstone), the `membership` effect (trusted Film only, no shadow Film, unresolved ->
// durable handoff, one bad id never holds the version, a failed effect is bounded and the next publication is not blocked), the handoff reconcile against the CURRENT snapshot, the one-time baseline (dry run, bounded
// apply, proof), the guarded switch, the single-writer source audit and the Producer plan without membership.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {d1Standin} from './d1-standin.mjs';import {sqliteSync} from './sqlite-session.mjs';
import * as Watchlist from '../src/watchlist-d1.js';
import {setFilmMembership,writeFilmFacts,membershipMarker} from '../src/canonical-film-writers.js';
import {resolveSourceIdentitiesEach,filmFactsOf} from '../src/canonical-producer-workflow.js';
import {membershipEffect,membershipReconcile,membershipBaseline,planBaseline,MEMBERSHIP_EFFECT_MAX_ATTEMPTS,HANDOFF_MAX_ATTEMPTS} from '../src/watchlist-membership.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-watchlist-membership-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const refuses=(file,text,pattern)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.notEqual(r.status,0,'must be refused: '+text.slice(0,80));if(pattern)assert.match(r.stderr,pattern);};
const chain=upTo=>names.filter(name=>name<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const OPEN=VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;";
const full=path.join(root,'full.sqlite');sqlite(full,chain('9999')+'\n'+OPEN);
const NOW=Date.parse('2026-11-23T10:00:00.000Z');const T=new Date(NOW).toISOString();
let copies=0;
const open=(mode='producer',options={})=>{const file=path.join(root,'db-'+(copies++)+'.sqlite');fs.copyFileSync(full,file);if(mode==='sync')sqlite(file,"UPDATE watchlist_membership_authority SET mode='sync',generation=1 WHERE id=1;");return {file,env:{DB:d1Standin(file,options)}};};
const GUARD=[Watchlist.guardOf('1'),[]];
const film=(i,extra={})=>({id:'lb'+i,title:'Film '+i,year:2000+i,url:'https://letterboxd.com/film/film-'+i+'/',...extra});
const list=(...ids)=>ids.map(i=>film(i));
let scans=0;
const publish=async(made,films)=>{const id='scan-'+(scans++);const out=await Watchlist.publishSnapshot(made.env,films,{scanId:id,observedAt:T,runId:'run-'+id,slotKey:'20261123-1030'},{now:NOW});assert.equal(out.ok,true,JSON.stringify(out));return out;};
const addFilm=(file,lid,{claim=true,owner='film:'+lid,trusted=1,conflicting=0}={})=>{sqlite(file,"INSERT OR IGNORE INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('"+owner+"',1,NULL,'T "+lid+"','"+T+"');"+(claim?"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('"+owner+"','letterboxd','"+lid+"',"+trusted+","+conflicting+",NULL);":''));};
const members=file=>rows(file,'SELECT film_id FROM watchlist_film ORDER BY film_id').map(row=>row.film_id);
const fences=file=>rows(file,'SELECT film_id,version,member FROM watchlist_film_fence ORDER BY film_id').map(row=>[row.film_id,Number(row.version),Number(row.member)]);
const effectsOf=file=>rows(file,'SELECT s.version AS v,e.effect AS effect,e.status AS status FROM watchlist_effect e JOIN watchlist_snapshot s ON s.snapshot_id=e.snapshot_id ORDER BY s.version,e.effect').map(row=>row.v+':'+row.effect+':'+row.status);
const current=file=>rows(file,'SELECT version,effects_drained_version FROM watchlist_current')[0];
const handoff=file=>rows(file,'SELECT lid,state,attempts,first_version,reason FROM watchlist_membership_handoff ORDER BY lid');
const ctxOf=(env,extra={})=>({env,epoch:1,now:()=>NOW,...extra});
const repository=Watchlist;
const deps=(extra={})=>({repository,resolve:(env,lids)=>resolveSourceIdentitiesEach(env,lids),setMembership:(env,input)=>setFilmMembership(env,input),epochGuard:()=>GUARD,fenceEnv:env=>env,...extra});
// completes the three legacy effects of the oldest pending version with a plain receipt (their writers are not under test here), leaving `membership` to the writer under test
const completeLegacy=async made=>{for(;;){const todo=await Watchlist.pendingEffects(made.env);const next=todo.effects.find(item=>item.effect!=='membership');if(!next||todo.effects[0].effect==='membership')return;const out=await Watchlist.completeEffect(made.env,{snapshotId:next.snapshotId,effect:next.effect,receipt:'r:'+next.effect},{now:NOW,guards:[GUARD]});assert.equal(out.ok,true,JSON.stringify(out));}};
const runMembership=async(made,writer)=>{await completeLegacy(made);const todo=await Watchlist.pendingEffects(made.env);const next=todo.effects[0];assert.equal(next?.effect,'membership');const receipt=await writer(ctxOf(made.env),next);return {next,receipt};};
const drainOne=async(made,writer)=>{const {next,receipt}=await runMembership(made,writer);assert.equal(typeof receipt,'string',JSON.stringify(receipt));const out=await Watchlist.completeEffect(made.env,{snapshotId:next.snapshotId,effect:'membership',receipt},{now:NOW,guards:[GUARD]});assert.equal(out.ok,true,JSON.stringify(out));return receipt;};

// ===== 1. migration 0037 =====
{
 const m='0037_watchlist_membership_projection.sql';
 assert.equal(names[names.length-1],m,'0037 is the newest migration');
 assert.equal(names[names.length-2],'0036_epg_discovery_lookup_indexes.sql','0037 follows 0036');
 const v36=path.join(root,'v36.sqlite');sqlite(v36,chain('0036_epg_discovery_lookup_indexes.sql'));
 const v35=path.join(root,'v35.sqlite');sqlite(v35,chain('0035_prediction_aux_import_receipts.sql'));
 refuses(v35,fs.readFileSync('migrations/'+m,'utf8'),/CHECK|constraint|NOT NULL/i);
 assert.equal(rows(v35,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='watchlist_membership_authority'")[0].n,0,'a refused file leaves no table');
 // rows of the old effect table survive the rebuild, in the old schema (three effects) with their statuses
 sqlite(v36,OPEN.replace(/UPDATE film_person[^;]*;/g,'').replace(/UPDATE watchlist_authority[^;]*;/,"UPDATE watchlist_authority SET mode='d1',generation=1 WHERE id=1;"));
 {
  const old={env:{DB:d1Standin(v36)}};
  await Watchlist.publishSnapshot(old.env,list(1,2),{scanId:'s0',observedAt:T,runId:'r0',slotKey:'x'},{now:NOW});
  assert.deepEqual(rows(v36,'SELECT effect FROM watchlist_effect ORDER BY effect').map(r=>r.effect),['removal_enqueue','retention','scan_facts'],'schema 36 publishes exactly three effects, without any marker');
  const first=(await Watchlist.pendingEffects(old.env)).effects[0];
  assert.equal((await Watchlist.completeEffect(old.env,{snapshotId:first.snapshotId,effect:first.effect,receipt:'kept'},{now:NOW})).ok,true);
  const before=rows(v36,'SELECT * FROM watchlist_effect ORDER BY effect');
  sqlite(v36,fs.readFileSync('migrations/'+m,'utf8'));
  assert.deepEqual(rows(v36,'SELECT * FROM watchlist_effect ORDER BY effect'),before,'every existing effect row is carried over unchanged');
 }
 assert.equal(rows(v36,'SELECT version FROM schema_contract WHERE id=1')[0].version,37);
 assert.deepEqual(rows(v36,'SELECT mode,generation,baseline_version FROM watchlist_membership_authority')[0],{mode:'producer',generation:0,baseline_version:null},'the marker starts as producer');
 assert.equal(rows(v36,'SELECT COUNT(*) AS n FROM watchlist_film_fence')[0].n+rows(v36,'SELECT COUNT(*) AS n FROM watchlist_membership_handoff')[0].n,0,'it copies and switches nothing');
 refuses(v36,'UPDATE schema_contract SET version=36 WHERE id=1',/schema_contract_downgrade/);
 refuses(v36,'DELETE FROM watchlist_membership_authority',/watchlist_membership_authority_required/);
 refuses(v36,"UPDATE watchlist_membership_authority SET mode='sync' WHERE id=1",/watchlist_membership_authority_regress/);
 refuses(v36,"UPDATE watchlist_membership_authority SET generation=5 WHERE id=1",/watchlist_membership_authority_regress/);
 refuses(v36,"INSERT INTO watchlist_effect (snapshot_id,effect,status,attempts) VALUES ('nope','bogus','pending',0)",/CHECK|FOREIGN/i);
 // the rebuilt table keeps its immutability trigger and now accepts the fourth effect
 const made=open('sync');
 await publish(made,list(1));
 const firstEffect=(await Watchlist.pendingEffects(made.env)).effects[0];
 assert.equal((await Watchlist.completeEffect(made.env,{snapshotId:firstEffect.snapshotId,effect:firstEffect.effect,receipt:'r'},{now:NOW,guards:[GUARD]})).ok,true);
 refuses(made.file,"UPDATE watchlist_effect SET status='pending',done_at=NULL WHERE effect='scan_facts'",/watchlist_effect_regress|CHECK/);
 sqlite(made.file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:z',1,'z','"+T+"');INSERT INTO watchlist_film_fence (film_id,version,member,updated_at) VALUES ('film:z',3,1,'"+T+"');");
 refuses(made.file,"UPDATE watchlist_film_fence SET version=2 WHERE film_id='film:z'",/watchlist_film_fence_regress/);
}

// ===== 2. the marker decides the effect set; legacy keeps three; the switch cannot race a promotion =====
{
 const legacy=open('producer');
 await publish(legacy,list(1,2));
 assert.deepEqual(effectsOf(legacy.file),['1:removal_enqueue:pending','1:retention:pending','1:scan_facts:pending'],'producer mode: the legacy three effects and no membership effect');
 const sync=open('sync');
 await publish(sync,list(1,2));
 assert.deepEqual(effectsOf(sync.file),['1:membership:pending','1:removal_enqueue:pending','1:retention:pending','1:scan_facts:pending'],'sync mode: four effects');
 // order: membership is last; it cannot complete before the three
 const snapshotId=rows(sync.file,'SELECT snapshot_id FROM watchlist_snapshot')[0].snapshot_id;
 assert.deepEqual((await Watchlist.completeEffect(sync.env,{snapshotId,effect:'membership',receipt:'x'},{now:NOW,guards:[GUARD]})),{ok:false,reason:'out_of_order'});
 assert.deepEqual((await Watchlist.pendingEffects(sync.env)).effects.map(item=>item.effect),['scan_facts','retention','removal_enqueue','membership'],'drain order');
 // the switch lands between the promotion's marker read and its batch: the batch is refused whole
 const raced=open('producer',{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO watchlist_snapshot/.test(item.text)))sqlite(raced.file,"UPDATE watchlist_membership_authority SET mode='sync',generation=1 WHERE id=1;");}});
 const out=await Watchlist.publishSnapshot(raced.env,list(1),{scanId:'race',observedAt:T,runId:'rr',slotKey:'x'},{now:NOW});
 assert.deepEqual([out.ok,out.reason],[false,'conflict'],'a promotion that read the old marker cannot commit after the switch');
 assert.equal(rows(raced.file,'SELECT COUNT(*) AS n FROM watchlist_snapshot')[0].n,0);
 // a schema below 37 has no marker table and is the legacy state
 assert.deepEqual(await Watchlist.readMembershipAuthority(legacy.env),{ok:true,present:true,mode:'producer',generation:0,baselineVersion:null});
}

// ===== 3. the guarded switch: no switch without the baseline proof of the exact, fully drained version =====
{
 const made=open('producer');
 await publish(made,list(1));
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:0,version:1,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'refused without a baseline proof');
 assert.deepEqual(await Watchlist.recordMembershipBaseline(made.env,{version:1,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'refused while the effects of the version are not drained');
 await completeLegacy(made);
 for(const effect of ['scan_facts','retention','removal_enqueue']){const todo=await Watchlist.pendingEffects(made.env);assert.equal(todo.effects.length>0,false,'all three completed by completeLegacy: '+effect);break;}
 assert.equal(current(made.file).effects_drained_version,1);
 assert.deepEqual(await Watchlist.recordMembershipBaseline(made.env,{version:2,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'a baseline names the exact current version');
 assert.deepEqual(await Watchlist.recordMembershipBaseline(made.env,{version:1,now:NOW},{guards:[GUARD]}),{ok:true});
 assert.equal((await Watchlist.readMembershipAuthority(made.env)).baselineVersion,1);
 // a newer promotion invalidates the proof
 await publish(made,list(1,2));
 await completeLegacy(made);
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:0,version:2,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'the proof of version 1 is not a proof of version 2');
 assert.deepEqual(await Watchlist.recordMembershipBaseline(made.env,{version:2,now:NOW},{guards:[GUARD]}),{ok:true});
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:7,version:2,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'wrong generation');
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:0,version:2,now:NOW},{guards:[GUARD]}),{ok:true});
 assert.deepEqual(await Watchlist.readMembershipAuthority(made.env),{ok:true,present:true,mode:'sync',generation:1,baselineVersion:2});
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:0,version:2,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'a second switch is refused');
 assert.deepEqual(await Watchlist.recordMembershipBaseline(made.env,{version:2,now:NOW},{guards:[GUARD]}),{ok:false,reason:'conflict'},'no baseline write once the marker is sync');
}

// ===== 4. the version-fenced Film writer =====
{
 const made=open('sync');
 addFilm(made.file,'lb1');
 const write=(member,version,extra={})=>setFilmMembership(made.env,{id:'film:lb1',member,version,at:T,...extra});
 assert.deepEqual((await write(true,1)).written,true);assert.deepEqual(members(made.file),['film:lb1']);assert.deepEqual(fences(made.file),[['film:lb1',1,1]]);
 assert.equal((await write(true,1)).reason,'unchanged','the same version and state is an idempotent replay');
 assert.equal((await write(false,2)).written,true);assert.deepEqual(members(made.file),[]);assert.deepEqual(fences(made.file),[['film:lb1',2,0]],'the removal keeps a tombstone');
 assert.equal((await write(true,1)).reason,'stale','a late add of V1 cannot land over the removal of V2');assert.deepEqual(members(made.file),[]);
 assert.equal((await write(true,3)).written,true);assert.deepEqual(members(made.file),['film:lb1']);
 assert.equal((await write(false,2)).reason,'stale','add -> remove -> add: a late remove of V2 cannot land over the re-add of V3');assert.deepEqual(members(made.file),['film:lb1']);
 // the fence is also in the batch: a newer version that lands between the read and the batch rolls it back
 const raceMade=open('sync',{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO watchlist_film_fence/.test(item.text)))sqlite(raceMade.file,"INSERT OR REPLACE INTO watchlist_film_fence (film_id,version,member,updated_at) VALUES ('film:lb1',9,0,'"+T+"');");}});
 addFilm(raceMade.file,'lb1');
 await assert.rejects(()=>setFilmMembership(raceMade.env,{id:'film:lb1',member:true,version:4,at:T}),error=>error.code==='film_person_precondition','a newer version applied after the read refuses the batch');
 assert.deepEqual(members(raceMade.file),[]);
 // only an EXISTING, non-redirected Film; proofs are asserted in the batch; no Film is ever created
 await assert.rejects(()=>setFilmMembership(made.env,{id:'film:ghost',member:true,version:1,at:T}),error=>error.code==='film_person_precondition');
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM film WHERE id='film:ghost'")[0].n,0,'zero shadow Film');
 addFilm(made.file,'lb2');sqlite(made.file,"INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('film:lb2','film:lb1','"+T+"');");
 await assert.rejects(()=>setFilmMembership(made.env,{id:'film:lb2',member:true,version:1,at:T}),error=>error.code==='film_person_redirect','a redirected Film is refused');
 await assert.rejects(()=>setFilmMembership(made.env,{id:'film:lb1',member:true,version:5,at:T,guards:[{sql:'EXISTS (SELECT 1 FROM film WHERE id=?)',params:['film:none']}]}),error=>error.code==='film_person_precondition','a failed identity proof refuses the batch');
 // producer mode: only the baseline may write; legacy (marker absent) refuses
 const legacy=open('producer');addFilm(legacy.file,'lb1');
 await assert.rejects(()=>setFilmMembership(legacy.env,{id:'film:lb1',member:true,version:1,at:T}),error=>error.code==='film_person_membership_closed');
 assert.equal((await setFilmMembership(legacy.env,{id:'film:lb1',member:true,version:1,at:T,baseline:true})).written,true,'the one-time baseline may write while the marker is producer');
 // the Producer path: writeFilmFacts refuses ANY membership input in sync mode (set, clear, release), while the other Film facts still write; in producer mode it still writes and asserts the marker in its batch
 const facts=(over={})=>({id:'film:lb1',expectedRevision:0,at:T,requestId:'req-'+Math.random(),film:{contractVersion:1,originalTitle:'T lb1',source:'letterboxd'},...over});
 const sy=open('sync');addFilm(sy.file,'lb1');
 const rev=()=>Number(rows(sy.file,"SELECT revision FROM canonical_revision WHERE kind='film' AND id='film:lb1'")[0]?.revision??0);
 for(const watchlist of [true,false])await assert.rejects(()=>writeFilmFacts(sy.env,facts({watchlist,expectedRevision:rev()})),error=>error.code==='film_person_membership_owned','sync mode refuses Producer membership: '+watchlist);
 assert.deepEqual(members(sy.file),[]);
 const plain=await writeFilmFacts(sy.env,facts({expectedRevision:rev(),film:{contractVersion:1,originalTitle:'Changed lb1',source:'letterboxd'}}));
 assert.equal(plain.written,true,'a facts write without membership is untouched by the switch');
 const pm=open('producer');addFilm(pm.file,'lb1');
 assert.equal((await writeFilmFacts(pm.env,facts({watchlist:true}))).written,true);assert.deepEqual(members(pm.file),['film:lb1'],'producer mode: the Producer still owns membership (legacy behaviour)');
 const raced=open('producer',{onBatch:async statements=>{if(statements.some(item=>/INSERT INTO watchlist_film \(/.test(item.text)))sqlite(raced.file,"UPDATE watchlist_membership_authority SET mode='sync',generation=1 WHERE id=1;");}});
 addFilm(raced.file,'lb1');
 await assert.rejects(()=>writeFilmFacts(raced.env,facts({watchlist:true})),error=>error.code==='film_person_precondition','a switch that lands inside a Producer write aborts that write');
 assert.deepEqual(members(raced.file),[],'no mixed writer');
 assert.deepEqual(filmFactsOf({id:'film:lb1'},undefined).watchlist,undefined);assert.equal('watchlist' in filmFactsOf({id:'film:lb1'},undefined),false,'a plan for an owned membership has no watchlist key');
 assert.equal(filmFactsOf({id:'film:lb1'},true).watchlist,true);
}

// ===== 5. the membership effect: trusted Film only, durable non-blocking handoff, fenced against V/V+1 =====
{
 const made=open('sync');
 for(const i of [1,2,3])addFilm(made.file,'lb'+i);
 sqlite(made.file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:tmdb:9',1,'T9','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:tmdb:9','letterboxd','lb9',1,0);");
 const films=()=>rows(made.file,'SELECT COUNT(*) AS n FROM film')[0].n;
 const before=films();
 const writer=membershipEffect(deps());
 await publish(made,list(1,2,3,4,9));
 const receipt=await drainOne(made,writer);
 assert.match(receipt,/^membership:scan-\d+:w4:s0:h1$/,'the receipt counts what was written and handed off');
 assert.deepEqual(members(made.file),['film:lb1','film:lb2','film:lb3','film:tmdb:9'],'trusted lid-owned and TMDB-owned Films alike; lb4 has no Film');
 assert.equal(films(),before,'ZERO shadow Film: no Film was created');
 assert.deepEqual(handoff(made.file),[{lid:'lb4',state:'pending',attempts:0,first_version:1,reason:'unresolved'}],'the unresolved id has a durable handoff and did not hold the version');
 assert.equal(current(made.file).effects_drained_version,1,'the version is fully drained');
 // the next slot's publication is not blocked; a removal clears membership (Film, claim and fence tombstone stay)
 await publish(made,list(1,3,4,9));
 await drainOne(made,writer);
 assert.deepEqual(members(made.file),['film:lb1','film:lb3','film:tmdb:9']);
 assert.deepEqual(fences(made.file).filter(item=>item[0]==='film:lb2'),[['film:lb2',2,0]]);
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb2'")[0].n,1,'membership removal deletes no Film');
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM film_external_id WHERE film_id='film:lb2'")[0].n,1);
 // a collision (two trusted-looking owners) refuses the id by name and never guesses
 sqlite(made.file,"INSERT INTO film (id,contract_version,original_title,updated_at) VALUES ('film:dup1',1,'d1','"+T+"'),('film:dup2',1,'d2','"+T+"');INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting) VALUES ('film:dup1','letterboxd','lb5',1,0),('film:dup2','letterboxd','lb5',0,1);");
 await publish(made,list(1,3,4,5,9));
 await drainOne(made,writer);
 assert.equal(members(made.file).some(id=>id.startsWith('film:dup')),false,'an ambiguous claim is never guessed');
 assert.ok(handoff(made.file).some(row=>row.lid==='lb5'&&row.state==='pending'));
 assert.equal(current(made.file).effects_drained_version,3);
}

// ===== 6. late effects: V1 after V3 never overwrites; add -> remove -> add through the effect =====
{
 const made=open('sync');addFilm(made.file,'lb1');addFilm(made.file,'lb2');
 const writer=membershipEffect(deps());
 await publish(made,list(1,2));      // v1: add lb1, lb2
 await publish(made,list(2));        // v2: remove lb1
 await publish(made,list(1,2));      // v3: re-add lb1
 const ids=rows(made.file,'SELECT snapshot_id,version FROM watchlist_snapshot ORDER BY version').map(row=>row.snapshot_id);
 const apply=async(index)=>writer(ctxOf(made.env),{snapshotId:ids[index],attempts:0,progress:null});
 // out of order on purpose (the drain would not do this; a second drainer or a replay could): v3 first, then v2, then v1
 assert.match(await apply(2),/^membership:.*:w1:/,'v3 applies the re-add of lb1');assert.deepEqual(members(made.file),['film:lb1']);
 assert.match(await apply(1),/^membership:.*:w0:s1:/,'v2 (remove lb1) is stale: the re-add of V3 stays');assert.deepEqual(members(made.file),['film:lb1']);
 assert.match(await apply(0),/^membership:.*:w1:s1:/,'v1: its add of lb1 is stale, its add of lb2 (never applied by a newer version) lands');assert.deepEqual(members(made.file),['film:lb1','film:lb2']);
 assert.deepEqual(fences(made.file),[['film:lb1',3,1],['film:lb2',1,1]].sort(),'the per-film latest applied version');
}

// ===== 7. a failing effect is bounded and never blocks the next publication =====
{
 const made=open('sync');addFilm(made.file,'lb1');addFilm(made.file,'lb2');
 const boom=Object.assign(new Error('x'),{code:'film_person_unavailable'});
 let failing=true;
 const writer=membershipEffect(deps({setMembership:async(env,input)=>{if(failing)throw boom;return setFilmMembership(env,input);}}));
 await publish(made,list(1,2));
 await completeLegacy(made);
 const first=(await Watchlist.pendingEffects(made.env)).effects[0];
 for(let attempt=0;attempt<MEMBERSHIP_EFFECT_MAX_ATTEMPTS;attempt++){
  const out=await writer(ctxOf(made.env),{...first,attempts:attempt});
  assert.equal(out,null,'a system fault holds the effect for a bounded number of attempts: '+attempt);
  assert.equal((await Watchlist.recordEffectAttempt(made.env,first,{now:NOW,guards:[GUARD]})).ok,true);
 }
 assert.equal(rows(made.file,"SELECT attempts FROM watchlist_effect WHERE effect='membership'")[0].attempts,MEMBERSHIP_EFFECT_MAX_ATTEMPTS);
 const bounded=await writer(ctxOf(made.env),{...first,attempts:MEMBERSHIP_EFFECT_MAX_ATTEMPTS});
 assert.equal(typeof bounded,'string','after the bound the effect completes');assert.match(bounded,/:h2$/,'both ids were handed off, none lost');
 assert.deepEqual(handoff(made.file).map(row=>[row.lid,row.state,row.reason]),[['lb1','pending','deferred_unavailable'],['lb2','pending','deferred_unavailable']]);
 assert.equal((await Watchlist.completeEffect(made.env,{snapshotId:first.snapshotId,effect:'membership',receipt:bounded},{now:NOW,guards:[GUARD]})).drained,true);
 await publish(made,list(1,2,3));
 assert.equal(current(made.file).version,2,'the next Watchlist publication is not blocked by the failed effect');
 // the handoff is reconciled against the CURRENT snapshot once the system is healthy again
 failing=false;
 const reconcile=membershipReconcile(deps());
 const step=await reconcile(ctxOf(made.env),{now:NOW});
 assert.equal(step.settled,2);assert.deepEqual(members(made.file),['film:lb1','film:lb2']);
 assert.deepEqual(handoff(made.file).map(row=>row.state),['settled','settled']);
}

// ===== 7b. a removal that cannot be applied after the bound is handed off too, and the reconcile clears it against CURRENT =====
{
 const made=open('sync');addFilm(made.file,'lb1');
 const good=membershipEffect(deps());
 await publish(made,list(1));await drainOne(made,good);
 assert.deepEqual(members(made.file),['film:lb1']);
 await publish(made,list());
 await completeLegacy(made);
 const next=(await Watchlist.pendingEffects(made.env)).effects[0];
 const down=membershipEffect(deps({setMembership:async()=>{throw Object.assign(new Error('x'),{code:'film_person_unavailable'});}}));
 const receipt=await down(ctxOf(made.env),{...next,attempts:MEMBERSHIP_EFFECT_MAX_ATTEMPTS});
 assert.match(receipt,/:h1$/,'the removal that could not be applied is handed off, not lost');
 assert.deepEqual(members(made.file),['film:lb1'],'still a member until the reconcile runs');
 assert.equal((await Watchlist.completeEffect(made.env,{snapshotId:next.snapshotId,effect:'membership',receipt},{now:NOW,guards:[GUARD]})).ok,true);
 assert.equal((await membershipReconcile(deps())(ctxOf(made.env),{now:NOW})).settled,1);
 assert.deepEqual(members(made.file),[],'the reconcile applies the CURRENT state: lb1 is no longer listed');
}

// ===== 8. late admission: the handoff reconciles against CURRENT membership, with backoff and a bound =====
{
 const made=open('sync');
 const writer=membershipEffect(deps());
 const reconcile=membershipReconcile(deps());
 await publish(made,list(1,2));
 await drainOne(made,writer);
 assert.deepEqual(handoff(made.file).map(row=>row.lid),['lb1','lb2']);
 assert.equal((await reconcile(ctxOf(made.env),{now:NOW})).settled,0);
 assert.deepEqual(handoff(made.file).map(row=>[row.attempts,row.state]),[[1,'pending'],[1,'pending']],'an unresolved id uses an attempt and backs off');
 assert.equal((await reconcile(ctxOf(made.env),{now:NOW})).processed,0,'not due before its backoff');
 // lb2 leaves the list while unresolved: nothing is owed for it
 await publish(made,list(1));
 await drainOne(made,writer);
 // the Film for lb1 is admitted LATE (a different writer): the next due step applies CURRENT membership without waiting for any EPG pass
 addFilm(made.file,'lb1');addFilm(made.file,'lb2');
 const later=NOW+13*3600000;
 const step=await reconcile(ctxOf(made.env,{now:()=>later}),{now:later});
 assert.equal(step.processed,2);
 assert.deepEqual(members(made.file),['film:lb1'],'lb1 is a current member; lb2 left the list and is NOT added from the stale version that first listed it');
 assert.deepEqual(handoff(made.file).map(row=>[row.lid,row.state]),[['lb1','settled'],['lb2','settled']]);
 assert.deepEqual(fences(made.file).filter(item=>item[0]==='film:lb1'),[['film:lb1',2,1]],'applied at the CURRENT version');
 // bounded attempts: an id that never resolves becomes terminal, then a new addition re-opens it
 const stuck=open('sync');
 const w2=membershipEffect(deps());const r2=membershipReconcile(deps());
 await publish(stuck,list(7));await drainOne(stuck,w2);
 let at=NOW;
 for(let i=0;i<HANDOFF_MAX_ATTEMPTS+2;i++){at+=13*3600000;await r2(ctxOf(stuck.env,{now:()=>at}),{now:at});}
 assert.deepEqual(handoff(stuck.file).map(row=>[row.lid,row.state,row.attempts]),[['lb7','terminal',HANDOFF_MAX_ATTEMPTS]],'terminal after the bound: it waits for the baseline operator, nothing is guessed');
 await publish(stuck,list());await drainOne(stuck,w2);
 await publish(stuck,list(7));await drainOne(stuck,w2);
 assert.deepEqual(handoff(stuck.file).map(row=>[row.state,row.attempts,row.first_version]),[['pending',0,3]],'a new addition re-opens a terminal handoff');
 // dormant until the switch: a producer-mode database is never touched by the step
 const prod=open('producer');
 assert.deepEqual(await membershipReconcile(deps())(ctxOf(prod.env),{now:NOW}),{skipped:true,reason:'marker_not_sync'});
 assert.equal(await membershipEffect(deps())(ctxOf(prod.env),{snapshotId:'x',attempts:0}),null,'the effect writer does nothing before the switch');
}

// ===== 9. one-time baseline: dry run reads only, apply is bounded and idempotent, the proof unlocks the switch =====
{
 const made=open('producer');
 for(const i of [1,2,3])addFilm(made.file,'lb'+i);
 addFilm(made.file,'lb9',{claim:false});
 await publish(made,list(1,2,3,4));          // lb4 has no Film
 await completeLegacy(made);
 // drift left by the old Producer: lb1 present, lb2 missing, lb9 stale (left the list long ago)
 sqlite(made.file,"INSERT INTO watchlist_film (film_id,updated_at) VALUES ('film:lb1','"+T+"'),('film:lb9','"+T+"');");
 const baseline=membershipBaseline(deps({readStored:async env=>(await env.DB.prepare('SELECT film_id FROM watchlist_film').all()).results.map(row=>row.film_id),limit:1}));
 const writes=made.env.DB.calls.batches;
 const dry=await baseline.dryRun(ctxOf(made.env));
 assert.deepEqual(dry,{ok:true,version:1,decision:'drift',counts:{current:4,stored:2,add:2,remove:1,keep:1,unresolved:1}});
 assert.equal(made.env.DB.calls.batches,writes,'the dry run opens no batch');
 assert.deepEqual(members(made.file),['film:lb1','film:lb9'],'and changes nothing');
 const a1=await baseline.apply(ctxOf(made.env));
 assert.deepEqual([a1.decision,a1.written,a1.remaining],['partial',1,2],'bounded: one Film per call');
 const a2=await baseline.apply(ctxOf(made.env));const a3=await baseline.apply(ctxOf(made.env));
 assert.deepEqual([a3.decision,a3.remaining],['baseline_recorded',0]);
 assert.deepEqual(members(made.file),['film:lb1','film:lb2','film:lb3'],'drift removed and missing added; the unresolved lb4 is not guessed');
 assert.equal(rows(made.file,"SELECT COUNT(*) AS n FROM film WHERE id='film:lb9'")[0].n,1,'the stale Film itself is kept (membership only)');
 assert.deepEqual(handoff(made.file).map(row=>[row.lid,row.reason]),[['lb4','baseline_unresolved']],'the unresolved id is handed off durably');
 assert.equal((await Watchlist.readMembershipAuthority(made.env)).baselineVersion,1,'the proof names the version');
 assert.equal((await baseline.dryRun(ctxOf(made.env))).decision,'already_current','idempotent: a rerun finds nothing to do');
 assert.deepEqual(await Watchlist.activateMembershipSync(made.env,{expectedGeneration:0,version:1,now:NOW},{guards:[GUARD]}),{ok:true},'the proof unlocks the switch');
 // pending effects block a baseline
 const busy=open('producer');await publish(busy,list(1));
 assert.deepEqual(await membershipBaseline(deps({readStored:async()=>[]})).dryRun(ctxOf(busy.env)),{ok:false,reason:'effects_pending',version:1});
 // the planner is pure and deterministic
 const plan=planBaseline({current:['b','a'],stored:['film:z'],byId:new Map([['a',{target:'film:a',guards:[]}],['b',{refused:'producer_identity_unresolved'}]])});
 assert.deepEqual([plan.add.map(i=>i.filmId),plan.remove,plan.unresolved.map(i=>i.lid),plan.converged],[['film:a'],['film:z'],['b'],false]);
}

// ===== 10. single writer, proven in the source =====
{
 const read=file=>fs.readFileSync(file,'utf8');
 const writers=fs.readdirSync('src').filter(name=>name.endsWith('.js')).filter(name=>/(INSERT INTO|DELETE FROM|UPDATE) watchlist_film\b/.test(read('src/'+name))).sort();
 assert.deepEqual(writers,['canonical-film-writers.js','canonical-mutations.js','canonical-repository.js'],'the only files of src that write watchlist_film: the Film writer (Sync projection + the guarded Producer path), the identity merge (moves membership with the Film) and the legacy repository');
 // the legacy repository has no caller in the Worker source (offline scripts only); nothing in src constructs it
 for(const name of fs.readdirSync('src').filter(n=>n.endsWith('.js')&&n!=='canonical-repository.js'))assert.equal(/createCanonicalRepository\(/.test(read('src/'+name)),false,name+' does not construct the legacy repository');
 // inside the Film writer, the membership statements are in exactly two writers: writeFilmFacts (refused once the marker is sync) and setFilmMembership
 const w=read('src/canonical-film-writers.js');
 assert.equal((w.match(/INSERT INTO watchlist_film \(/g)||[]).length,2);assert.equal((w.match(/DELETE FROM watchlist_film/g)||[]).length,2);
 assert.match(w,/film_person_membership_owned/);
 // the Producer plans no membership under the marker, and its reads of the membership table are gone in that mode
 const pw=read('src/canonical-producer-workflow.js');
 assert.match(pw,/membershipOwned\?undefined:true/);assert.match(pw,/departed=membershipOwned\?\[\]/);
 // the delivery hold is untouched by this change
 assert.match(pw,/export const PRODUCER_DELIVERY_HOLD=true;/);
}
console.log('watchlist-membership: ok');
