// AIR-362: the seal step's busy answer carries the holder's real lease expiry, bounded, and tells the holder kinds apart.
// Local sqlite stand-in, no Cloudflare, no production. Time is a fake clock shared by the Worker and the authority.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const context=loadWorker();context.DiscoveryAuthority=Authority;
const call=code=>vm.runInContext(code,context);
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-busy-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
const sql=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const migrate=()=>{const file=path.join(root,'b.sqlite');fs.rmSync(file,{force:true});const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'),encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
const TTL=Authority.LEASE_TTL_MS;
const run={runId:'run-1',stage:'seal',seal:{jobId:'job-1',phase:'ledger'}};
const envOf=file=>({DB:d1Standin(file),BUCKET:{async get(){return null;}},discoveryLease:null});
try{
 const file=migrate();
 // 1. A step cancelled right after it took the lease: the lease stays for the full TTL. Every call until expiry waits for it.
 const owner=envOf(file);
 const held=await Authority.acquireLease(owner,{programmeRunId:null});assert.ok(held.lease);
 const t0=clock;
 for(const elapsed of [1000,30000,TTL-5000]){
  clock=t0+elapsed;
  const out=await call('sealStep')(envOf(file),run);
  assert.equal(out.discovery.state,'busy');assert.equal(out.discovery.nextAction,'wait');assert.equal(out.discovery.reason,'busy');
  assert.equal(out.discovery.busyKind,'lease_held');
  assert.equal(Date.parse(out.discovery.nextCatchUpAt),held.lease.expiresAt+3000,'the real expiry plus the margin');
  assert.equal(out.discovery.retryAfterSec,Math.ceil((held.lease.expiresAt+3000-clock)/1000));
  assert.ok(out.discovery.retryAfterSec<=Math.ceil((TTL+3000)/1000),'never more than one lease TTL and margin');
  assert.equal(out.seal.phase,'ledger','no phase moved');
 }
 // 2. Duplicate callers all see the same expiry and none of them takes the lease.
 clock=t0+2000;
 const answers=await Promise.all([1,2,3].map(()=>call('sealStep')(envOf(file),run)));
 assert.equal(new Set(answers.map(a=>a.discovery.nextCatchUpAt)).size,1);
 assert.equal(sql(file,'SELECT lease_id FROM discovery_lease WHERE id=1')[0].lease_id,held.lease.id,'the holder is untouched');
 // 3. Before the margin has passed the call is refused again (no premature continuation); after expiry it is not busy.
 clock=held.lease.expiresAt;
 const edge=await call('acquireDiscoveryLease')(envOf(file));
 assert.ok(edge,'a lease whose time has come is taken by CAS, the answer only says when to call again');
 await Authority.releaseLease(envOf(file),edge);
 // 4. A lease row that expired between the failed update and the read is a lost race with a short bounded wait.
 const raced=await call('sealBusyResponse')(run,{busy:{kind:'lost_race',expiresAt:null}},clock);
 assert.equal(raced.discovery.busyKind,'lost_race');assert.equal(raced.discovery.retryAfterSec,5);
 // 5. A holder expiry far in the future (clock skew, corrupt row) is capped at one TTL from now.
 const far=await call('sealBusyResponse')(run,{busy:{kind:'lease_held',expiresAt:clock+10*TTL}},clock);
 assert.equal(Date.parse(far.discovery.nextCatchUpAt),clock+TTL+3000);
 // 6. A past or missing expiry never answers "retry now": at least one second.
 const past=await call('sealBusyResponse')(run,{busy:{kind:'lease_held',expiresAt:clock-5000}},clock);
 assert.ok(past.discovery.retryAfterSec>=1);
 // 7. A bounded client wait loop ends with an acquired lease, in a finite number of calls, with no zero-progress spin.
 const second=await Authority.acquireLease(envOf(file),{programmeRunId:null});assert.ok(second.lease);
 const start=clock;let calls=0;
 for(;;){
  calls++;assert.ok(calls<=3,'bounded');
  const t=await Authority.acquireLease(envOf(file),{programmeRunId:null});
  if(t.lease)break;
  assert.equal(t.busy.kind,'lease_held');
  clock=Math.max(clock+1000,t.busy.expiresAt+3000);
 }
 assert.ok(clock-start<=TTL+3000);
 // 8. A different programme is a hard conflict, exactly: the authority names `generation_mismatch`, never a held lease.
 sql(file,'UPDATE discovery_lease SET expires_at=0 WHERE id=1');
 sql(file,"UPDATE discovery_authority SET programme_run_id='run-a' WHERE id=1");
 const other=await Authority.acquireLease(envOf(file),{programmeRunId:'run-b'});
 assert.equal(other.lease,null);assert.equal(other.busy.kind,'generation_mismatch');assert.equal(other.busy.expiresAt,null);
 // 9. A hard conflict never becomes a wait: through the helper and through the real step path, with no retry time.
 for(const answer of [await call('sealBusyResponse')(run,{busy:{kind:'generation_mismatch',expiresAt:null}},clock)]){
  assert.equal(answer.discovery.nextAction,'stop');assert.equal(answer.discovery.nextCatchUpAt,null);assert.equal(answer.discovery.retryAfterSec,null);assert.notEqual(answer.discovery.state,'busy');
 }
 const original=context.DiscoveryAuthority;
 context.DiscoveryAuthority={...Authority,acquireLease:async()=>({handled:true,lease:null,busy:{kind:'generation_mismatch',expiresAt:null}})};
 try{
  const stopped=await call('sealStep')(envOf(file),run);
  assert.equal(stopped.discovery.nextAction,'stop');assert.equal(stopped.discovery.nextCatchUpAt,null);assert.equal(stopped.discovery.busyKind,'generation_mismatch');
 }finally{context.DiscoveryAuthority=original;}
 // 10. A holder whose expiry is unknown or invalid is not promised a lease-based catch-up.
 for(const expiresAt of [null,undefined,0,NaN,'x']){
  const answer=await call('sealBusyResponse')(run,{busy:{kind:'lease_held',expiresAt}},clock);
  assert.equal(answer.discovery.busyKind,'lost_race');assert.equal(answer.discovery.retryAfterSec,5);
 }
 console.log('discovery seal busy ok');
}finally{Date.now=realNow;}
