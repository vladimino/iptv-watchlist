// AIR-622: the read-only dry-run operator of family (b) (scripts/identity-evidence-family-b-dry-run.mjs), offline: a scratch sqlite database built from the real migration chain behind the
// D1 stand-in and an in-memory R2 store. No network, no credential value, no production access.
//  - arguments and the private output; the acquisition order and its fail-closed cases (an incomplete or moving R2 listing, a missing / changed / undecodable object, an incoherent D1 fence);
//  - the store is used for list and get ONLY (any other method throws); the D1 SELECT-only transport itself is the AIR-653 guard, tested in tests/letterboxd-claim-cohort-preflight-production.mjs;
//  - the printed report is sanitized (no observation key, object key, movie id or payload) and says `no_import` unless the coverage is complete and a manifest exists;
//  - the production wrapper stops on a missing credential before any request, and refuses a private path inside the repository.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {parseArgs,acquireAndPlan,sanitize,run,describeFailure} from '../scripts/identity-evidence-family-b-dry-run.mjs';
import {R2_ACTION_PREFIX} from '../src/identity-evidence-family-b.js';
import {ControlledError,UsageError} from '../scripts/letterboxd-claim-cohort-preflight-production.mjs';
import {InstallError} from '../scripts/r2-s3-store.mjs';

const NEW='0044_identity_evidence_reconstruction_import.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const chain=files.slice(0,files.indexOf(NEW)+1);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-family-b-dry-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const ok=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});assert.equal(r.status,0,r.stderr);};
const template=path.join(root,'template.sqlite');
ok(template,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
ok(template,"UPDATE discovery_authority SET mode='d1',cutover='open',generation=5 WHERE id=1");
const lit=value=>"'"+String(value).replace(/'/g,"''")+"'";
let n=0;
const database=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const argv=(...rest)=>['node','script',...rest];

// ---- 1. arguments ----
assert.throws(()=>parseArgs(argv()),/--out/);
assert.throws(()=>parseArgs(argv('--out')),/needs a path/);
assert.throws(()=>parseArgs(argv('--out','x','--run-id','bad id')),/--run-id/);
assert.throws(()=>parseArgs(argv('--out','x','--unknown')),/unknown option/);
assert.deepEqual(parseArgs(argv('--out','/tmp/x')),{out:'/tmp/x',runId:null,acceptR2Residual:false},'the R2 residual is never accepted by default');
assert.equal(parseArgs(argv('--out','/tmp/x','--accept-r2-residual','--run-id','r1')).acceptR2Residual,true);
assert.ok(new UsageError('x') instanceof Error);

// ---- fixtures ----
const OBS='film secret-title|2000';
const KEY=R2_ACTION_PREFIX+'req-r2-1.json';
const record=()=>({schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:'req-r2-1',state:'succeeded',command:{effect:'reject',tmdbId:'555'},provenance:{observationKey:OBS},
 receipt:{state:'succeeded',outcomes:[{id:OBS,outcome:'written'}]},issued:{confirmedAt:'2026-11-01T00:00:00.000Z'},finishedAt:'2026-11-01T00:01:00.000Z'});
const seed=file=>ok(file,'INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ('+[lit('film other|1999'),1,1,lit('2026-11-02T00:00:00.000Z'),lit('resolver_chunk'),lit(JSON.stringify({status:'verified',identitySource:'tmdb_detail',tmdbId:100,checkedAt:'2026-11-01T00:00:00.000Z'}))].join(',')+')');
// An in-memory R2 store: list and get only. Any other method (put, delete, head, a write) throws, so an attempted write fails the test.
const memory=(objects,{onList=null}={})=>{
 const calls={list:0,get:0};
 const base={
  async list({prefix}){calls.list++;onList?.(calls.list);return {objects:Object.entries(objects).filter(([key])=>key.startsWith(prefix)).map(([key,value])=>({key,size:1,etag:value.etag})),truncated:false};},
  async get(key){calls.get++;const value=objects[key];if(!value)return null;return {etag:value.etag,json:async()=>{if(value.bad)throw new Error('bad json');return value.record;}};},
 };
 return new Proxy(base,{get(target,name){if(name==='calls')return calls;if(name in target)return target[name];throw new Error('store method not allowed: '+String(name));}});
};
const plan=async(over={})=>{const file=database();seed(file);return acquireAndPlan({db:d1Standin(file),store:memory({[KEY]:{etag:'e1',record:record()}}),runId:'run-dry',...over});};

// ---- 2. a coherent acquisition ----
{
 const refused=await plan();
 assert.equal(refused.listingStable,true);
 const report=sanitize(refused);
 assert.equal(report.decision,'no_import','without the owner acceptance of the R2 residual the R2 record is an exclusion, so the coverage is not complete');
 assert.ok(report.reasons.includes('coverage_not_complete'));assert.equal(refused.result.coverage.acquisition.r2.established,true);
 const accepted=await plan({acceptR2Residual:true});
 const acceptedReport=sanitize(accepted);
 assert.equal(acceptedReport.decision,'manifest_candidate');assert.match(acceptedReport.digest,/^[0-9a-f]{64}$/);
 assert.equal(accepted.result.coverage.complete,true);
 assert.ok(Date.parse(accepted.cohortAt)>=Date.parse(accepted.sources.acquisition.acquiredAt)&&Date.parse(accepted.cohortAt)>=Date.parse(accepted.listedAt),'the cohort is never earlier than either acquisition');
 // Sanitized: no observation key, object key, movie id or request id anywhere in the printed report.
 const text=JSON.stringify(acceptedReport);
 for(const secret of ['secret-title','req-r2-1',KEY,'film other','"555"'])assert.ok(!text.includes(secret),'the report must not carry '+secret);
 assert.deepEqual(Object.keys(acceptedReport.coverage.lateArrivals).sort(),['history','intents','r2'],'late-arrival samples are dropped');
}

// ---- 3. fail closed ----
{
 // A listing that moves while the run reads (an object appears between the two listings): the R2 acquisition is not complete.
 const objects={[KEY]:{etag:'e1',record:record()}};
 const file=database();seed(file);
 const moving=await acquireAndPlan({db:d1Standin(file),store:memory(objects,{onList:count=>{if(count===2)objects[R2_ACTION_PREFIX+'late.json']={etag:'e9',record:record()};}}),acceptR2Residual:true});
 assert.equal(moving.listingStable,false);assert.equal(moving.result.coverage.acquisition.r2.established,false);assert.equal(moving.result.coverage.complete,false);
 const report=sanitize(moving);assert.equal(report.decision,'no_import');assert.ok(report.reasons.includes('r2_listing_moved'));
 // An object that disappears, changes ETag or is undecodable is an unresolved read failure, never a no-row.
 for(const [name,store,expected] of [
  ['missing',()=>{const s=memory({[KEY]:{etag:'e1',record:record()}});const get=s.get;s.get=async()=>null;return s;},'read_failed'],
  ['etag changed',()=>{const s=memory({[KEY]:{etag:'e1',record:record()}});s.get=async()=>({etag:'e2',json:async()=>record()});return s;},'not_in_frozen_listing'],
  ['undecodable',()=>memory({[KEY]:{etag:'e1',bad:true}}),'read_failed'],
 ]){
  const f=database();seed(f);
  const result=await acquireAndPlan({db:d1Standin(f),store:store(),acceptR2Residual:true});
  assert.equal(result.result.coverage.complete,false,name);assert.equal(sanitize(result).decision,'no_import',name);
  assert.ok(result.result.coverage.dispositions.r2[expected]>=1,name+': '+JSON.stringify(result.result.coverage.dispositions.r2));
 }
 // A truncated or malformed listing stops the run.
 const f=database();seed(f);
 await assert.rejects(()=>acquireAndPlan({db:d1Standin(f),store:{async list(){return {objects:[],truncated:true};},async get(){return null;}}}),error=>error instanceof ControlledError&&error.code==='r2_listing_incomplete');
 await assert.rejects(()=>acquireAndPlan({db:d1Standin(f),store:{async list(){return {objects:[{key:'other/x.json',etag:'e'}],truncated:false};},async get(){return null;}}}),error=>error.code==='r2_listing_malformed');
 // A held Discovery authority makes the D1 acquisition incoherent: no manifest is certified.
 const held=database();seed(held);ok(held,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 const incoherent=await acquireAndPlan({db:d1Standin(held),store:memory({}),acceptR2Residual:true});
 assert.equal(incoherent.result.manifest,null);assert.equal(sanitize(incoherent).decision,'no_import');
 // A store that tries anything but list and get is refused by the test store, and the operator never calls it.
 const guarded=memory({});assert.throws(()=>guarded.put,/not allowed/);
 const used=await plan();assert.ok(used);
}
assert.equal(describeFailure(new InstallError('x',3)),'r2_credential_refused');assert.equal(describeFailure(new InstallError('x')),'r2_request_failed');

// ---- 4. the production wrapper ----
{
 const calls=[];const fetchImpl=async()=>{calls.push(1);throw new Error('network');};
 await assert.rejects(()=>run({argv:argv('--out',path.join(root,'out')),env:{},fetchImpl,log:()=>{}}),error=>error.reason==='configuration');
 assert.equal(calls.length,0,'no request before the credentials are checked');
 await assert.rejects(()=>run({argv:argv('--out','docs/evidence/x'),env:{},fetchImpl,log:()=>{}}),/outside the repository/);
 assert.equal(calls.length,0);
}
console.log('identity evidence family (b) dry-run operator tests passed');
