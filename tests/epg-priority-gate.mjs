// ADR 0135 (AIR-459), the INERT D1 gate of the EPG-priority Discovery pause. Local sqlite stand-ins for D1 (the sqlite3 CLI, each batch one
// transaction) and a memory bucket for R2. Nothing here calls Cloudflare, TMDB or production, and migration 0022 is applied only to throwaway files.
// Covered: the migration file, an ABSENT table (byte-for-byte today), the race matrix T31-T41 on the real `acquireLease` / `writeWorkflow` /
// `writeContinuation` / `importSegment` / `publishGeneration` statements, soft-busy (no budget, no 502), the diagnostic fields, and a STRUCTURAL list of
// every generation-moving statement and every lease acquirer, so a new writer without the predicate or without the `epg` role fails here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import * as PublishedEpg from '../src/published-epg.js';
import {EPG_PRIORITY_LEAD_MINUTES,DISCOVERY_EPG_PRIORITY_POLL_MS} from '../src/domain/epg-priority-pause.js';
import {madridInstant} from '../src/domain/orchestration-policy.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-epg-priority-gate-'));
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=(upTo=22,opts={})=>{
 const file=path.join(root,'g-'+(databases++)+'.sqlite');
 const sql='PRAGMA foreign_keys=ON;\n'+files.filter(name=>Number(name.slice(0,4))<=upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
 const result=sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,opts)};
};
const first=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const generation=db=>Number(first(db,'SELECT generation FROM discovery_authority WHERE id=1'));
const row=db=>({...db.sql('SELECT state, owed_day_key AS owed, override_day_key AS override FROM discovery_epg_priority WHERE id=1')[0]});
const leaseRow=db=>({...db.sql('SELECT lease_id AS leaseId, expires_at AS expiresAt, holder_kind AS kind FROM discovery_lease WHERE id=1')[0]});
const envFor=(db,extra={})=>({DB:db,BUCKET:new MemoryBucket(),discoveryLease:null,...extra});

// A frozen clock. Every Worker statement reads `Date.now()`, so the Madrid wall time of each case is exact (CET in November, CEST in July).
const realNow=Date.now;
let clock=realNow();
Date.now=()=>clock;
const D1='2026-11-12',D2='2026-11-13',D3='2026-11-14';
const at=(day,h,m=0)=>{clock=madridInstant(day,h,m);return clock;};
const setPointer=(db,run,dayKey,pin=run)=>{
 db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+run+"'"+(dayKey===undefined?'':", madrid_run_key="+(dayKey?"'"+dayKey+"'":'NULL'))+" WHERE id=1");
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='"+pin+"', published_programme_run_id='"+pin+"' WHERE id=1");
};
// Yesterday (D1) published and handed off under run-1.
const armed=(upTo=22)=>{const made=migrated(upTo);setPointer(made.db,'run-1',upTo>=22?D1:undefined);return made;};
const take=(env,context={})=>Authority.acquireLease(env,{programmeRunId:'run-1',...context});

assert.equal(EPG_PRIORITY_LEAD_MINUTES,5);
assert.equal(DISCOVERY_EPG_PRIORITY_POLL_MS,60000);

// 0. The migration file: follows a complete version 21, refuses anything else, seeds ONE clear row, no expiry column, version 22 and never down.
{
 const sql=fs.readFileSync('migrations/0022_epg_priority_pause.sql','utf8');
 assert.match(sql,/version = 21/);
 assert.doesNotMatch(sql.split('\n').filter(line=>!line.startsWith('--')).join('\n'),/expires_at|expiry|ttl/i,'a business pause has no expiry column');
 assert.doesNotMatch(sql,/\b(DROP|DELETE FROM)\b/);
 const old=migrated(20);
 assert.notEqual(sqliteSync(['-bail',old.file],{input:sql,encoding:'utf8'}).status,0,'refuses version 20');
 const {db,file}=migrated(21);
 assert.equal(Number(first(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='discovery_epg_priority'")),0,'0021 alone has no pause table');
 const applied=sqliteSync(['-bail',file],{input:sql,encoding:'utf8'});
 assert.equal(applied.status,0,applied.stderr);
 assert.equal(Number(first(db,'SELECT version FROM schema_contract')),22);
 assert.deepEqual(row(db),{state:'clear',owed:null,override:null});
 assert.equal(Number(first(db,'SELECT COUNT(*) FROM discovery_epg_priority')),1);
 assert.throws(()=>db.sql("INSERT INTO discovery_epg_priority (id,state) VALUES (2,'clear')"));
 assert.throws(()=>db.sql("UPDATE discovery_epg_priority SET state='paused', owed_day_key=NULL WHERE id=1"),'paused names its date');
 assert.throws(()=>db.sql("UPDATE discovery_epg_priority SET override_day_key='tomorrow' WHERE id=1"),'an override is a date');
 assert.throws(()=>db.sql("UPDATE published_epg_authority SET madrid_run_key='13/11/2026' WHERE id=1"),'the published day is a date');
 assert.throws(()=>db.sql("UPDATE schema_contract SET version=21"),/downgrade/);
 assert.match(fs.readFileSync('migrations/README.md','utf8'),/0022_epg_priority_pause\.sql/);
}

// 1. The table ABSENT: today's behaviour, byte for byte. A deploy before the file changes nothing, and there is no flag.
{
 const {db}=armed(21);
 const env=envFor(db);
 assert.equal((await Authority.readAuthority(env)).priorityTable,false);
 at(D2,16,56);
 const taken=await take(env);
 assert.ok(taken.lease,'no pause table: a chunk is admitted at 16:56');
 assert.equal(Number(first(db,"SELECT COUNT(*) FROM sqlite_master WHERE name='discovery_epg_priority'")),0);
 assert.equal(Object.keys(db.sql('SELECT * FROM discovery_lease')[0]).includes('holder_kind'),false,'the lease statement is today\'s: no new column');
 await Authority.writeWorkflow(envFor(db),{schemaVersion:1,instanceId:'i-1',programmeRunId:'run-1',series:0},undefined);
}

// T31. Acquire at or after 16:55 Madrid, today unconfirmed, row still `clear`: the lease UPDATE matches nothing, the same batch arms the row,
// `epg_priority` / wait, the 60 s poll, no lease and no generation move. Before 16:55 the chunk is admitted.
{
 const {db}=armed();
 const env=envFor(db);
 assert.equal((await Authority.readAuthority(env)).priorityTable,true);
 at(D2,16,54);
 const before=await take(env);
 assert.ok(before.lease,'16:54 admits (yesterday published and pinned)');
 assert.equal(leaseRow(db).kind,'discovery');
 db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
 const generationBefore=generation(db);
 at(D2,16,55);
 const refused=await take(env);
 assert.equal(refused.lease,null);
 assert.equal(refused.busy.kind,'epg_priority');
 assert.equal(refused.busy.owedDayKey,D2);
 assert.equal(refused.busy.nextCatchUpAt,new Date(clock+60000).toISOString());
 assert.equal(refused.busy.pollMs,60000);
 assert.deepEqual(row(db),{state:'paused',owed:D2,override:null},'the second statement of the same batch armed the row');
 assert.equal(leaseRow(db).leaseId,null,'no lease row changed');
 assert.equal(generation(db),generationBefore);
 for(const [h,m] of [[17,0],[18,30],[19,59]]){at(D2,h,m);assert.equal((await take(env)).busy.kind,'epg_priority',h+':'+m+' still paused: no business TTL');}
}

// T32. The in-flight holder renews during the pause; renewLease carries no predicate; no new admission. EPG's own acquire (and sealStep) is exempt.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,54);
 clock+=30000;
 const holder=(await take(env)).lease;
 assert.ok(holder);
 at(D2,16,55);
 clock+=10000;
 const second=await take(envFor(db));
 assert.equal(second.lease,null);
 assert.equal(second.busy.kind,'epg_priority','the pause names itself ahead of lease_held');
 assert.equal(second.busy.ownerKind,'discovery');
 assert.equal(second.busy.holdExpiresAt,holder.expiresAt);
 const renewed=await Authority.renewLease(env,holder,{programmeRunId:'run-1'});
 assert.equal(renewed.ok,true,'the in-flight chunk keeps its lease');
 // The publication: role epg takes the lease the moment the holder drops it; the pause does not stop it, and the holder kind is recorded.
 db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
 const epg=await Authority.acquireLease(envFor(db),{programmeRunId:null,role:'epg'});
 assert.ok(epg.lease,'EPG publication is exempt');
 assert.equal(leaseRow(db).kind,'epg');
 const during=await take(envFor(db));
 assert.equal(during.busy.kind,'epg_priority');
 assert.equal(during.busy.ownerKind,'epg','the diagnostic names the owner kind');
 assert.deepEqual(Object.keys(during.busy).sort(),['expiresAt','holdExpiresAt','kind','nextCatchUpAt','owedDayKey','ownerKind','pollMs'],'no Film id, SQL or continuation body');
 // Expired lease, pause still open: the next acquire is refused and the pause is not released.
 clock+=Authority.LEASE_TTL_MS+1;
 const expired=await take(envFor(db));
 assert.equal(expired.busy.kind,'epg_priority');
 assert.equal(expired.busy.ownerKind,'none');
 assert.equal(row(db).state,'paused');
}

// T33. Row missing, or table presence unreadable, fails closed; only a verified-absent table admits as today.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,0);
 db.sql('DELETE FROM discovery_epg_priority');
 await assert.rejects(take(env),error=>error.code==='discovery_epg_priority_evidence');
 assert.equal(leaseRow(db).leaseId,null);
 assert.equal(row(db).state,undefined);
 // A malformed row (the CHECKs refuse it, so it is forced) is unreadable too.
 db.sql("INSERT INTO discovery_epg_priority (id,state) VALUES (1,'clear')");
 db.sql("PRAGMA ignore_check_constraints=ON; UPDATE discovery_epg_priority SET override_day_key='soon' WHERE id=1");
 await assert.rejects(take(env),error=>error.code==='discovery_epg_priority_evidence');
 assert.equal(leaseRow(db).leaseId,null);
 // The pure contract is the single rule (no copy in SQL or the Worker): undefined / null presence is `evidence_unreadable`.
 const pure=await import('../src/domain/epg-priority-pause.js');
 for(const tablePresent of [undefined,null,'yes'])assert.equal(pure.discoveryAdmission({tablePresent,action:'acquire',nowMs:clock}).reason,'evidence_unreadable');
 assert.equal(pure.discoveryAdmission({tablePresent:false,action:'acquire',nowMs:clock}).admit,true);
}

// T34. `sealArchive` moved the pin to run-2 while the pointer still names run-1: the pause stays, run-2 is not admitted, and run-1 waits as epg_priority
// (not yet stale_generation). T35a: pointer and pin name one run but the published day is NULL or another date: not publication of the owed day.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,58);
 db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
 assert.equal((await take(env)).busy.kind,'epg_priority','the previous id waits as epg_priority');
 const asked=await take(env,{programmeRunId:'run-2'});
 assert.equal(asked.lease,null);
 assert.equal(asked.busy.kind,'generation_mismatch','the new id is not admitted: a foreign id is the existing hard conflict (stale_generation)');
 // T35a: pointer run-2, pin run-2, day NULL, then the wrong date.
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-2', madrid_run_key=NULL WHERE id=1");
 assert.equal((await take(env,{programmeRunId:'run-2'})).busy.kind,'epg_priority','a NULL day matches no owed day');
 db.sql("UPDATE published_epg_authority SET madrid_run_key='"+D1+"' WHERE id=1");
 assert.equal((await take(env,{programmeRunId:'run-2'})).busy.kind,'epg_priority','a different date is not the owed day');
 assert.equal(leaseRow(db).leaseId,null);
}

// T35. The pointer batch of `publishGeneration`: pin already equal to the run and the stamped day is the owed date. That one UPDATE writes
// `programme_run_id` and `madrid_run_key` together and clears the row; it never writes the pin. Pin behind: the row stays `paused`, and the
// replay branch (or the next acquire) clears it once the pointer, the pin and the day agree. Only then may the new id acquire.
{
 const programme=run=>({runId:run,updatedAt:'2026-11-13T15:30:00.000Z',watchlistCount:0,films:[]});
 const publish=(db,run,key)=>PublishedEpg.publishGeneration({DB:db,BUCKET:new MemoryBucket()},{programmeRunId:run,phase:'published',expectedProgrammeRunId:'run-1',madridRunKey:key,programme:programme(run),watchlist:{updatedAt:programme(run).updatedAt,films:[]}},{now:0});
 {
  const {db}=armed();
  const env=envFor(db);
  at(D2,16,56);
  await take(env);
  assert.deepEqual(row(db),{state:'paused',owed:D2,override:null});
  db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
  const result=await publish(db,'run-2',D2);
  assert.equal(result.pointed,true);
  assert.equal(first(db,'SELECT madrid_run_key FROM published_epg_authority'),D2,'the day is written with the pointer');
  assert.equal(first(db,'SELECT programme_run_id FROM published_epg_authority'),'run-2');
  assert.deepEqual(row(db),{state:'clear',owed:null,override:null},'the pointer batch cleared the row');
  assert.equal(first(db,'SELECT published_programme_run_id FROM discovery_authority'),'run-2','the pointer batch did not write the pin');
  at(D2,17,30);
  assert.ok((await take(env,{programmeRunId:'run-2'})).lease,'the new id acquires');
  db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
  assert.equal((await take(envFor(db),{programmeRunId:'run-1'})).busy.kind,'generation_mismatch','the previous id is stale');
 }
 {
  // Pin behind: the pointer is published first, the row stays paused, and the replay branch clears it later.
  const {db}=armed();
  const env=envFor(db);
  at(D2,16,56);
  await take(env);
  const result=await publish(db,'run-2',D2);
  assert.equal(result.pointed,true);
  assert.equal(row(db).state,'paused','pin still names run-1: not cleared');
  assert.equal((await take(env,{programmeRunId:'run-2'})).busy.kind,'epg_priority','pointer run-2, pin run-1: the new id is not admitted');
  assert.equal((await take(env,{programmeRunId:'run-1'})).busy.kind,'generation_mismatch','the previous id is stale once the pointer moved');
  db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
  const replay=await publish(db,'run-2',D2);
  assert.equal(replay.replay,true);
  assert.deepEqual(row(db),{state:'clear',owed:null,override:null},'the replay branch cleared it once both name the run');
 }
 {
  // Pin behind and no replay: the next Discovery acquire clears the row (and admits) once pointer, pin and day agree.
  const {db}=armed();
  const env=envFor(db);
  at(D2,16,56);
  await take(env);
  await publish(db,'run-2',D2);
  db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
  assert.equal(row(db).state,'paused');
  assert.ok((await take(env,{programmeRunId:'run-2'})).lease);
  assert.deepEqual(row(db),{state:'clear',owed:null,override:null});
 }
 {
  // T35a at the pointer: a publication with no frozen key stamps NULL and does not lift the pause.
  const {db}=armed();
  const env=envFor(db);
  at(D2,16,56);
  await take(env);
  db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
  await publish(db,'run-2',null);
  assert.equal(first(db,'SELECT madrid_run_key FROM published_epg_authority'),null);
  assert.equal(row(db).state,'paused');
  assert.equal((await take(env,{programmeRunId:'run-2'})).busy.kind,'epg_priority','a seal with no frozen key does not lift the pause');
 }
 {
  // T35b. The run's frozen day is yesterday and the pointer commits after midnight: yesterday's pause lifts; today's opens only at 16:55 today.
  const {db}=armed();
  const env=envFor(db);
  at(D2,16,56);
  await take(env);
  db.sql("UPDATE discovery_authority SET programme_run_id='run-2', published_programme_run_id='run-2' WHERE id=1");
  at(D3,0,40);
  await publish(db,'run-2',D2);
  assert.equal(first(db,'SELECT madrid_run_key FROM published_epg_authority'),D2,'the stamped day stays the run\'s own frozen day');
  assert.deepEqual(row(db),{state:'clear',owed:null,override:null});
  assert.ok((await take(env,{programmeRunId:'run-2'})).lease,'after midnight, before 16:55: admitted');
  db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
  at(D3,16,56);
  assert.equal((await take(env,{programmeRunId:'run-2'})).busy.owedDayKey,D3,'today\'s pause waits for 16:55 today');
 }
 {
  // A published generation that is `withheld` moves no pointer and stamps nothing.
  const {db}=armed();
  at(D2,16,56);
  await take(envFor(db));
  await PublishedEpg.publishGeneration({DB:db,BUCKET:new MemoryBucket()},{programmeRunId:'run-w',phase:'withheld',madridRunKey:D2,programme:programme('run-w'),watchlist:{updatedAt:programme('run-w').updatedAt,films:[]}},{now:0});
  assert.equal(first(db,'SELECT madrid_run_key FROM published_epg_authority'),D1);
  assert.equal(row(db).state,'paused');
 }
 {
  // With the table absent the pointer statement is today's: `madrid_run_key` is not referenced at all (the column does not exist before 0022).
  const {db}=armed(21);
  const source=fs.readFileSync('src/published-epg.js','utf8');
  assert.match(source,/stage\.pausePresent===true/);
  const result=await PublishedEpg.publishGeneration({DB:db,BUCKET:new MemoryBucket()},{programmeRunId:'run-2',phase:'published',expectedProgrammeRunId:'run-1',madridRunKey:D2,programme:programme('run-2'),watchlist:{updatedAt:programme('run-2').updatedAt,films:[]}},{now:0});
  assert.equal(result.pointed,true);
  assert.equal(first(db,'SELECT programme_run_id FROM published_epg_authority'),'run-2');
 }
}

// T36. A failed, quarantined or stalled EPG, or no instance created: nothing here releases the pause. It has no expiry, and a missing instance is not created.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,56);
 await take(env);
 for(const hours of [1,3,9,20]){clock+=hours*3600000;if(clock>=madridInstant(D3,16,55))break;assert.equal((await take(env)).busy.kind,'epg_priority');}
 assert.equal(row(db).state,'paused');
 assert.equal(Number(first(db,"SELECT COUNT(*) FROM pragma_table_info('discovery_epg_priority') WHERE name LIKE '%expire%' OR name LIKE '%ttl%'")),0);
}

// T37. Midnight, then the next 16:55, owed day still unconfirmed: the owed date rolls at the next arming instant, and an override for the previous date does not apply.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,56);
 await take(env);
 assert.equal(row(db).owed,D2);
 at(D3,1,0);
 assert.equal((await take(env)).busy.owedDayKey,D2,'after midnight the same pause is the same owed date');
 assert.equal(row(db).owed,D2);
 db.sql("UPDATE discovery_epg_priority SET override_day_key='"+D2+"' WHERE id=1");
 at(D3,16,56);
 const rolled=await take(env);
 assert.equal(rolled.busy.owedDayKey,D3,'the owed date rolled at the next arming instant');
 assert.deepEqual(row(db),{state:'paused',owed:D3,override:null},'the override of the previous date was dropped');
}

// T38. Owner override for the owed date: admits only the programme id the pointer already names; a different id is stale_generation; a missing id stays closed;
// clearing the override closes admission again; nothing is published.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,56);
 await take(env);
 db.sql("UPDATE discovery_epg_priority SET override_day_key='"+D2+"' WHERE id=1");
 const pointerBefore=db.sql('SELECT programme_run_id, madrid_run_key, generation FROM published_epg_authority')[0];
 assert.equal((await take(env,{programmeRunId:'run-9'})).busy.kind,'generation_mismatch','a different id is stale_generation');
 await assert.rejects(take(env,{programmeRunId:null}),error=>error.code==='discovery_epg_priority_evidence','a missing id stays closed');
 const admitted=await take(env,{programmeRunId:'run-1'});
 assert.ok(admitted.lease,'the id the pointer names is admitted for the owed date');
 assert.deepEqual(db.sql('SELECT programme_run_id, madrid_run_key, generation FROM published_epg_authority')[0],pointerBefore,'nothing is published');
 db.sql('UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1');
 db.sql("UPDATE discovery_epg_priority SET override_day_key=NULL WHERE id=1");
 assert.equal((await take(env)).busy.kind,'epg_priority','clearing the override closes admission');
}

// T39. Projector window and the pause both active: the label is epg_priority, never the window deadline; the window's own contract is unchanged.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,56);
 const request=await Authority.requestProjectorWindow(env,{owner:'p-1',deadlineMs:Authority.WINDOW_DEADLINE_MS,now:clock});
 assert.equal(request.outcome,'requested');
 const refused=await take(env);
 assert.equal(refused.busy.kind,'epg_priority');
 assert.notEqual(refused.busy.expiresAt,request.expiresAt,'the window deadline is not the end of the pause');
 const grant=await Authority.grantProjectorWindow(env,{owner:'p-1',now:clock});
 if(grant.outcome==='granted'||grant.outcome==='held'){
  const held=await take(env);
  assert.equal(held.busy.kind,'epg_priority');
  assert.equal(held.busy.ownerKind,'projector');
  assert.equal(held.busy.holdExpiresAt,request.expiresAt);
 }
 clock=request.expiresAt+1000;
 assert.equal((await take(env)).busy.kind,'epg_priority','the window expired, the pause did not');
 // Without the pause (clear before 16:55 the next day) the window answers as before.
 const {db:plain}=armed();
 at(D2,10,0);
 const plainEnv=envFor(plain);
 const requested=await Authority.requestProjectorWindow(plainEnv,{owner:'p-2',deadlineMs:Authority.WINDOW_DEADLINE_MS,now:clock});
 assert.equal((await take(plainEnv)).busy.kind,'projector_window');
 assert.equal(requested.outcome,'requested');
}

// T40. A D1 error, or held authority, is fail-closed as before: the pause does not swallow it, and nothing is admitted.
{
 const {db}=armed();
 at(D2,16,56);
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await assert.rejects(take(envFor(db)),error=>error.code==='discovery_fence');
 db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");
 const broken=migrated(22,{rewrite:sql=>/FROM discovery_epg_priority WHERE id=1$/.test(sql)?'SELECT * FROM discovery_no_such_table':sql});
 setPointer(broken.db,'run-1',D1);
 at(D2,16,56);
 await assert.rejects(take(envFor(broken.db)),error=>error.code!=='epg_priority'&&!error.busy,'a D1 error is not a pause answer');
 assert.equal(leaseRow(broken.db).leaseId,null);
}

// T41. Reconcile, rollover, successor create, manual or admin acquire during the pause: no new lease, no generation move, no new owner; the in-flight chunk is not killed.
{
 const {db}=armed();
 const env=envFor(db);
 at(D2,16,56);
 await take(env);
 const generationBefore=generation(db);
 const workflowBefore=db.sql('SELECT revision, instance_id FROM discovery_workflow WHERE id=1')[0];
 // writeWorkflow / writeContinuation without a lease: a soft, typed refusal (code, not a 5xx), and nothing is written.
 for(const write of [()=>Authority.writeWorkflow(envFor(db),{schemaVersion:1,instanceId:'i-new',programmeRunId:'run-1',series:1},undefined),()=>Authority.writeContinuation(envFor(db),{stage:'running',programmeRunId:'run-1'},undefined)]){
  await assert.rejects(write(),error=>error.code==='discovery_epg_priority'&&error.priority.owedDayKey===D2&&typeof error.priority.nextCatchUpAt==='string');
 }
 assert.equal(generation(db),generationBefore);
 assert.deepEqual(db.sql('SELECT revision, instance_id FROM discovery_workflow WHERE id=1')[0],workflowBefore,'no new owner persisted');
 // importSegment (lease-free) is refused inside its own statement and fails closed.
 const items=[];
 const segment={sourceKey:'archive:test',items,contentSha256:await Authority.segmentContentSha(items),programmeRunId:'run-1'};
 await assert.rejects(Authority.importSegment(envFor(db),segment),error=>error.code==='discovery_fence'||error.code==='discovery_epg_priority');
 assert.equal(generation(db),generationBefore);
 // An in-flight holder (a chunk that took its lease at 16:50) finishes its continuation write; the pause refuses only a writer with no live lease.
 db.sql('UPDATE discovery_epg_priority SET state=\'clear\', owed_day_key=NULL');
 at(D2,16,54);
 clock+=30000;
 const holderEnv=envFor(db);
 const lease=(await take(holderEnv)).lease;
 assert.ok(lease);
 holderEnv.discoveryLease=lease;
 at(D2,16,55);
 clock+=10000;
 const saved=await Authority.writeContinuation(holderEnv,{stage:'running',programmeRunId:'run-1',hopId:lease.id},undefined);
 assert.equal(saved.saved,true,'the holder\'s own write is not refused');
 assert.equal(generation(db),generationBefore+1);
 // The same writer with no live lease, or with someone else's lease, is refused.
 await assert.rejects(Authority.writeContinuation(envFor(db,{discoveryLease:{id:'someone-else',expiresAt:clock+1000}}),{stage:'running',programmeRunId:'run-1'},undefined),error=>error.code==='discovery_epg_priority');
}

// Structural: every statement that moves `discovery_authority.generation`, and every lease acquirer, either carries the predicate, is the holder's, or is the EPG role.
{
 const source=fs.readFileSync('src/discovery-authority.js','utf8');
 const blocks=source.split(/\n(?=(?:export )?(?:async )?function )/).filter(block=>block.includes('generation=generation+1'));
 const names=blocks.map(block=>/function ([A-Za-z0-9_]+)/.exec(block)?.[1]);
 const classes={};
 for(const block of blocks){
  const name=/function ([A-Za-z0-9_]+)/.exec(block)[1];
  const priority=block.includes('priorityGuard(');
  const holder=/EXISTS \(SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=\?/.test(block)||/lease_id=\? AND expires_at>\?',\[nowMs\(\)\+LEASE_TTL_MS/.test(block);
  classes[name]=priority?'priority':holder?'holder':'unguarded';
 }
 assert.deepEqual(Object.entries(classes).filter(([,kind])=>kind==='unguarded'),[],'a generation writer without the predicate or the holder lease: '+names.join(','));
 for(const name of ['importSegment','writeContinuation','writeWorkflow'])assert.equal(classes[name],'priority',name+' carries the predicate');
 for(const name of ['loadingFence','beginLedgerSeal'])assert.equal(classes[name],'holder',name+' is the lease holder\'s');
 // Every acquireLease call outside the authority is `epg` or goes through the Discovery default.
 for(const file of ['src/worker.js','src/epg-diagnostic-run.js','src/discovery.js','src/discovery-workflow.js','src/monitor.js','src/mcp.js','src/d1-enrichment.js','src/admin/discovery-recovery.js']){
  const text=fs.readFileSync(file,'utf8');
  for(const match of text.matchAll(/DiscoveryAuthority\.acquireLease\(([^;]*);/g)){
   const argument=match[1];
   assert.ok(/role:'epg'/.test(argument)||/\.\.\.\(role\?\{role\}:\{\}\)/.test(argument),file+': '+match[0]);
  }
 }
 const discovery=fs.readFileSync('src/discovery.js','utf8');
 assert.match(discovery,/async function takeDiscoveryLease\(env,role=null\)/);
 const worker=fs.readFileSync('src/worker.js','utf8');
 assert.match(worker,/takeDiscoveryLease\(env,'epg'\)/,'the publication paths take the lease as the EPG role');
 assert.equal([...worker.matchAll(/takeDiscoveryLease\(env[^)]*\)/g)].length,1,'only the publication helper takes the lease in the Worker');
 const admin=fs.readFileSync('src/admin/discovery-recovery.js','utf8');
 assert.doesNotMatch(admin,/acquireDiscoveryLease\(env,'epg'\)/,'admin and manual paths are Discovery, never `epg`');
 assert.doesNotMatch(source,/expires_at\s*=\s*\(SELECT[^)]*discovery_epg_priority/,'no expiry on the pause');
}

Date.now=realNow;
console.log('epg priority gate ok');
