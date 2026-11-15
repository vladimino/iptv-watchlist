// AIR-480: typed discovery_conflict must survive chunkSummary / continuation, with bounded failedAt and failureKind.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-conflict-diag-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
const file=path.join(root,'d.sqlite');
const migrated=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
if(migrated.status!==0)throw new Error(migrated.stderr||'migration failed');
const sql=(text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};

const context=vm.createContext({console,Date,JSON,Math,Number,Object,Array,String,Promise,Map,Set,Error,TypeError,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,fetch:async()=>new Response('{}')});
vm.runInContext(fs.readFileSync('src/discovery.js','utf8'),context);
const code=name=>vm.runInContext(name,context);

assert.equal(code('diagnosticErrorCode')({code:'discovery_conflict',message:'discovery_conflict'}),'discovery_conflict');
assert.equal(code('diagnosticErrorCode')(Object.assign(new Error('discovery_conflict'),{code:'discovery_conflict'})),'discovery_conflict');
assert.equal(code('diagnosticErrorCode')({code:'discovery_fence',message:'discovery_fence'}),'discovery_fence');
assert.notEqual(code('diagnosticErrorCode')({code:'discovery_fence'}),'discovery_conflict');
assert.equal(code('diagnosticErrorCode')(new Error('Hot Film UNIQUE title')),'unknown');
assert.equal(code('diagnosticFailureKind')({code:'discovery_conflict',failureKind:'input_invariant'}),'input_invariant');
assert.equal(code('diagnosticFailureKind')({code:'discovery_fence'}),'fence');
assert.equal(code('diagnosticFailureKind')({code:'discovery_conflict',failureKind:'unique_constraint',cause:{message:'UNIQUE constraint failed: published_epg_show.programme_run_id'}}),'unique_constraint');

const unique=Object.assign(new Error('discovery_conflict'),{code:'discovery_conflict',failureKind:'unique_constraint',failureConstraint:'unique.published_epg_show',failedAt:'replay_assignment',cause:{message:'UNIQUE constraint failed: published_epg_show.programme_run_id, channel_id, start_ms film=Hot Film'}});
const summary=code('chunkSummary')({stage:'error',error:unique.error||unique.message,failedAt:unique.failedAt,failureKind:unique.failureKind,failureConstraint:unique.failureConstraint,checked:0,remaining:null});
assert.equal(summary.error,'discovery_conflict');
assert.equal(summary.failedAt,'replay_assignment');
assert.equal(summary.failureKind,'unique_constraint');
assert.equal(summary.failureConstraint,'unique.published_epg_show');
assert.equal(JSON.stringify(summary).includes('Hot Film'),false);
assert.equal(JSON.stringify(summary).includes('UNIQUE constraint failed'),false);
assert.equal(JSON.stringify(summary).includes('channel_id'),false);

const fields=code('discoveryFailureFields')({code:'discovery_conflict',message:'discovery_conflict',failedAt:'replay_assignment',failureKind:'unique_constraint',failureConstraint:'unique.published_epg_show'});
assert.equal(fields.error,'discovery_conflict');
assert.equal(fields.failedAt,'replay_assignment');
assert.equal(fields.failureKind,'unique_constraint');
assert.equal(fields.failureConstraint,'unique.published_epg_show');

const fence=code('chunkSummary')({stage:'error',error:'discovery_fence',failureKind:'fence',failedAt:'cheap_decision',checked:0});
assert.equal(fence.error,'discovery_fence');
assert.equal(fence.failureKind,'fence');
assert.notEqual(fence.error,'discovery_conflict');

sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
await assert.rejects(()=>Authority.readFilmAdmission(env,'007'),error=>{
 assert.equal(error.code,'discovery_conflict');
 assert.equal(error.failureKind,'input_invariant');
 assert.equal(error.failureConstraint,undefined);
 return true;
});

const taken=await Authority.acquireLease(env,{programmeRunId:null});
env.discoveryLease=taken.lease;
const movieA={id:'tmdb_1',tmdbId:'1',canonicalIdentity:'tmdb:1',title:'A'};
const first=await Authority.upsertAdmissions(env,{tmdb_1:movieA},{lease:taken.lease});
assert.ok(first.written.includes('tmdb_1'));
const clash=await Authority.upsertAdmissions(env,{other:{id:'other',tmdbId:'1',canonicalIdentity:'tmdb:1',title:'Other'}},{lease:taken.lease});
assert.equal(clash.refused[0]?.reason,'identity_conflict');
await assert.rejects(()=>Authority.ingestLedger(env,{programmeRunId:'run-dup',handoff:true,lease:taken.lease,items:(async function*(){const item={key:'dup',title:'D',normalizedTitle:'d',year:2001,durations:[90],shows:[]};yield item;yield item;})()}),error=>{
 assert.equal(error.code,'discovery_conflict');
 assert.equal(error.failureKind,'input_invariant');
 return true;
});
await Authority.releaseLease(env,taken.lease);

const RUN='run-assign',START=Date.parse('2026-11-15T12:00:00Z'),MIN=60000;
sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const file2=path.join(root,'p.sqlite');
const m2=sqliteSync(['-bail',file2],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
if(m2.status!==0)throw new Error(m2.stderr);
const sql2=(text)=>{const result=sqliteSync(['-json','-bail',file2],{input:text+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
sql2("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const env2={DB:d1Standin(file2),BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
const taken2=await Authority.acquireLease(env2,{programmeRunId:null});
env2.discoveryLease=taken2.lease;
const obs={key:'a',title:'Film a',normalizedTitle:'film a',year:2001,durations:[90],shows:[{channelId:'c',channel:'C',start:START+3600000,end:START+3600000+90*MIN}],seenInLatestSnapshot:true,lastAiring:START+3600000};
await Authority.ingestLedger(env2,{programmeRunId:RUN,handoff:true,lease:taken2.lease,items:(async function*(){yield obs;})()});
sql2(`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
sql2(`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
sql2(`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:'101',shows:[]}]})}')`);
sql2(`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
await Authority.writeDecisionDelta(env2,{a:{previous:null,next:{status:'verified',filmId:'member-1',tmdbId:'101',canonicalIdentity:'tmdb:101',identitySource:'tmdb_detail',anchor:[90],evidenceKey:Authority.evidenceKey(obs)}}});
const uniqueErr=()=>{const error=new Error('discovery_conflict');error.code='discovery_conflict';error.failureKind='unique_constraint';error.failureConstraint='unique.published_epg_show';error.cause=new Error('UNIQUE constraint failed: published_epg_show.programme_run_id, published_epg_show.channel_id, published_epg_show.start_ms');return error;};
const wrapped=new Proxy(Authority,{
 get(target,prop,receiver){
  const value=Reflect.get(target,prop,receiver);
  if(prop!=='assignObservationSlots'||typeof value!=='function')return value;
  return async()=>{throw uniqueErr();};
 }
});
await wrapped.releaseLease(env2,taken2.lease);
env2.discoveryLease=null;
const page=vm.createContext({console,Date,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
 nextCatchUpAt:()=>new Date(Math.floor(Date.now()/3600000+1)*3600000).toISOString(),
 hourlyTaskRunAt:(from=Date.now())=>new Date(Math.floor(from/3600000+1)*3600000).toISOString(),
 fetch(){return Promise.resolve(new Response(JSON.stringify({results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
 DiscoveryAuthority:wrapped,pinEpg:async value=>value,refreshPredictionQueue:async()=>{},
 loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[{id:'member-1',tmdbId:'101',title:'Film a',original:'Film a',year:2001,runtime:90,shows:[]}]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await wrapped.routeRead(target,key);return routed.handled?routed.value:null;},
 saveJSON:async(target,key,value)=>{const routed=await wrapped.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
for(const name of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(name,'utf8'),page);
try{
 const outcome=await page.advanceDiscovery(env2,{caller:'internal'});
 assert.equal(outcome.stage,'error');
 assert.equal(outcome.error,'discovery_conflict');
 assert.equal(outcome.failedAt,'replay_assignment');
 assert.equal(outcome.failureKind,'unique_constraint');
 assert.equal(outcome.failureConstraint,'unique.published_epg_show');
 const traced=page.chunkSummary(outcome);
 assert.equal(traced.error,'discovery_conflict');
 assert.equal(traced.failedAt,'replay_assignment');
 assert.equal(traced.failureKind,'unique_constraint');
 assert.equal(JSON.stringify(traced).includes('Hot Film')||JSON.stringify(traced).includes('UNIQUE constraint failed'),false);
 assert.equal(outcome.discovery?.reason,'discovery_conflict');
 assert.equal(page.workflowStepRecoverable?null:null,null);
}finally{
 const row=sql2('SELECT lease_id FROM discovery_lease WHERE id=1')[0];
 if(row?.lease_id)await wrapped.releaseLease(env2,{id:row.lease_id,expiresAt:Date.now()+60000});
}

vm.runInContext(fs.readFileSync('src/discovery-workflow.js','utf8'),page);
assert.equal(page.workflowStepRecoverable(uniqueErr(),false),false);
assert.equal(page.workflowStepRecoverable(Object.assign(new Error('discovery_fence'),{code:'discovery_fence'}),false),false);
assert.equal(page.workflowStepRecoverable(Object.assign(new Error('discovery_unavailable'),{code:'discovery_unavailable'}),false),true);
