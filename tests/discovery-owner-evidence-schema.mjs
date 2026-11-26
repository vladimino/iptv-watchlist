// AIR-619 / ADR 0215 decision 4 (review of PR #1023): the `discovery_owner` writer on the PRE-0042 schema (the deployed predecessor, a database that is migrated through 0041 only),
// and the migration/activation race between planning and the owner batch. Local sqlite stand-ins only; migration 0042 is applied to a COPY inside the test, never to production.
// Covered: the same decision/history/receipt/assigned-row effect as the full schema with the writer off, no dependency on the control or ledger tables, the commit-time ABSENT guard
// (a batch prepared before 0042 cannot commit after it, nor after an activation), for a single row and for a replacement with two planned rows, with rollback of the decision,
// the history row, the evidence and the receipt; the replan afterwards writes its rows; and a lost response AFTER a successful commit (durable receipt, replay writes no second row).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import * as Identity from '../src/domain/discovery-identity-review.js';
import {changeWriter,identityEvidenceControlStatus} from '../src/identity-evidence-writer.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-owner-evidence-schema-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const PREDECESSOR='0041_film_identity_evidence.sql',NEW='0042_identity_evidence_writer_control.sql';
assert.ok(files.includes(PREDECESSOR)&&files.includes(NEW));
const upTo=name=>files.slice(0,files.indexOf(name)+1);
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const build=(file,names)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+names.map(read).join('\n'),encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const pre=path.join(root,'pre.sqlite'),full=path.join(root,'full.sqlite');
build(pre,upTo(PREDECESSOR));
build(full,files);
let copies=0;
const copy=source=>{const file=path.join(root,'w-'+(copies++)+'.sqlite');fs.copyFileSync(source,file);return file;};
const OPERATION={reason:'owner-approved activation',deployedVersion:'4b23276',evidenceLink:'https://trello.com/c/eXzl5TI8#activation'};
const AT='2026-11-25T10:00:00.000Z';
const RUN='run-schema';

async function world(source){
 const file=copy(source);
 let hook=null;
 const db=d1Standin(file,{onBatch:async statements=>{
  if(!(statements.some(item=>/INSERT INTO discovery_decision_history/.test(item.text))&&statements.some(item=>/state='receipt'/.test(item.text))))return;
  if(hook){const run=hook;hook=null;await run(statements);}
 }});
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
 const lease0=(await Authority.acquireLease(env,{programmeRunId:null,role:'epg'})).lease;
 env.discoveryLease=lease0;
 const item=key=>({key,title:'T '+key,normalizedTitle:'t '+key,year:1999,durations:[100],shows:[{channelId:'news',channel:'News',start:5,end:9}],seenInLatestSnapshot:true,lastAiring:5});
 await Authority.replaceLedger(env,{programmeRunId:RUN,items:[item('obs-a')]});
 const base={status:'needs_verification',attempts:1,evidenceKey:Authority.evidenceKey(item('obs-a')),terminalReason:'awaiting_confirmation',retryAt:null,scoring:{status:'accepted',acceptedTmdbId:'41'}};
 await Authority.routeWrite(env,'epg/discovery-resolution.json',{'obs-a':base});
 db.sql("UPDATE published_epg_authority SET programme_run_id='run-schema' WHERE id=1");
 db.sql("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-schema','tmdb_41','c',1,2,'C',NULL,'discovery','obs-a')");
 const renewed=await Authority.renewLease(env,lease0,{programmeRunId:RUN});
 const lease=renewed.lease||lease0;
 env.discoveryLease=lease;
 let n=0;
 const w={file,db,env,lease,setHook:fn=>{hook=fn;},file0:file};
 w.read=async()=>(await Authority.routeRead(env,'epg/discovery-resolution.json')).value['obs-a'];
 w.act=async(kind,command,build,extra={})=>{
  const requestId=extra.requestId||'req-'+String(++n).padStart(14,'0');
  const previous=await w.read();
  const expectedHash=await Authority.decisionHash(previous);
  assert.equal((await Authority.putIntent(env,{idempotencyKey:requestId,kind,observationKey:'obs-a',command,expectedHash,expiresAt:Date.now()+600000,issued:{capability:'x',confirmedAt:'2026-11-25T09:00:00.000Z'}})).saved,true);
  const next=build(previous,requestId);
  const result=await Authority.ownerDecision(env,{idempotencyKey:requestId,key:'obs-a',expectedHash,next,lease,writer:'discovery_identity_correct',receipt:{state:'applied',effect:command.effect}});
  return {requestId,result,next,expectedHash};
 };
 w.assign=(id,extra={})=>w.act('identity_assign',{effect:'assign',tmdbId:id,basis:'owner',...(extra.command||{})},(p,requestId)=>Identity.appliedIdentityDecision(p,{effect:'assign',tmdbId:id,basis:'owner'},{at:AT,requestId,programmeRunId:RUN}),extra);
 // The observable domain effect: decision, history payloads and revisions, intent receipts, assigned rows.
 w.snapshot=()=>JSON.stringify({
  decision:db.sql("SELECT status, tmdb_id, film_id, decision_hash FROM discovery_decision WHERE observation_key='obs-a'"),
  history:db.sql("SELECT revision, writer, payload_json FROM discovery_decision_history WHERE observation_key='obs-a' ORDER BY revision"),
  intents:db.sql('SELECT idempotency_key, kind, state, receipt_json FROM discovery_intent ORDER BY idempotency_key'),
  shows:db.sql("SELECT COUNT(*) AS n FROM published_epg_show WHERE match_reason='obs-a'"),
 });
 w.ledger=()=>db.sql('SELECT seq,evidence_key,polarity,object_value,scope_evidence_key,source_order,request_id FROM film_identity_evidence ORDER BY seq');
 return w;
}

// ===== 1. the pre-0042 schema: identical effect to the full schema with the writer off, and no dependency on the control or ledger tables =====
{
 const a=await world(pre),b=await world(full);
 assert.equal(await identityEvidenceControlStatus(a.env),'absent','the predecessor schema has no control tables');
 assert.equal(await identityEvidenceControlStatus(b.env),'ready');
 const sequence=async w=>{
  const first=await w.assign('41',{requestId:'req-pre-assign-001'});
  assert.equal(first.result.outcome,'written');
  const hash=await Authority.decisionHash(await w.read());
  const second=await w.assign('56',{requestId:'req-pre-replace-01',command:{supersedes:{requestId:'req-pre-assign-001',decisionHash:hash}}});
  assert.equal(second.result.outcome,'written','a replacement commits on the predecessor schema too');
  return w.snapshot();
 };
 const snapA=await sequence(a),snapB=await sequence(b);
 const strip=text=>JSON.stringify(JSON.parse(text),(key,value)=>key==='generation'||key==='written_at'?undefined:value);
 assert.equal(strip(snapA),strip(snapB),'the same decision, history, receipts and assigned rows with and without the control tables');
 assert.equal(a.db.sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'identity_evidence_writer%'")[0].n,0,'the predecessor schema was never given the control tables');
 assert.equal(a.db.sql("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='film_identity_evidence'")[0].n,1,'0041 has the ledger, 0042 only the control');
 assert.equal(b.ledger().length,0,'writer off on the full schema: no row');
}

// ===== 2. a batch prepared before 0042 cannot commit after it (and after an activation): the whole owner step rolls back; the replan writes its rows =====
async function race({replacement}){
 const w=await world(pre);
 let first=null,hash=null;
 if(replacement){
  first=await w.assign('41',{requestId:'req-race-assign-001'});
  assert.equal(first.result.outcome,'written');
  hash=await Authority.decisionHash(await w.read());
 }
 const before=w.snapshot();
 // Between preparation and the owner batch: migration 0042 lands, and the writer is activated and drained to `on` (the worst case: coverage is claimed).
 w.setHook(async()=>{
  const r=sqliteSync(['-bail',w.file],{input:'PRAGMA foreign_keys=ON;\n'+read(NEW),encoding:'utf8',maxBuffer:1<<26});
  assert.equal(r.status,0,r.stderr);
  let generation=0;
  for(const kind of ['activate','drain_complete']){
   await changeWriter(w.env,{writer:'discovery_owner',kind,expectedGeneration:generation,...OPERATION,drainEvidence:kind==='drain_complete'?'one deployment at 100%, no older instance':undefined,now:'2026-11-25T12:0'+generation+':00.000Z'});
   generation+=1;
  }
 });
 const raced=replacement
  ?await w.assign('56',{requestId:'req-race-replace-01',command:{supersedes:{requestId:'req-race-assign-001',decisionHash:hash}}})
  :await w.assign('41',{requestId:'req-race-assign-002'});
 assert.equal(raced.result.outcome,'unknown','the batch failed whole');
 assert.equal(w.ledger().length,0,'no evidence landed');
 const after=JSON.parse(w.snapshot()),prior=JSON.parse(before);
 assert.deepEqual(after.decision,prior.decision,'the decision is unchanged');
 assert.deepEqual(after.history,prior.history,'no history row');
 assert.equal(after.shows[0].n,prior.shows[0].n,'the assigned rows are untouched');
 const rolled=after.intents.find(row=>row.idempotency_key===raced.requestId);
 assert.equal(rolled.state,'running');
 assert.equal(rolled.receipt_json,null,'no receipt: nothing of the step is committed');
 // The replan (a new intent) reads the schema again: now it carries the insert and its rows are written.
 const redo=replacement
  ?await w.assign('56',{requestId:'req-race-replace-02',command:{supersedes:{requestId:'req-race-assign-001',decisionHash:hash}}})
  :await w.assign('41',{requestId:'req-race-assign-003'});
 assert.equal(redo.result.outcome,'written');
 const rows=w.ledger().filter(row=>row.request_id===redo.requestId);
 assert.equal(rows.length,replacement?2:1,'the replan writes its own row'+(replacement?' and the scoped withdrawal':''));
}
await race({replacement:false});
await race({replacement:true});

// ===== 3. a lost response after a successful commit: durable receipt and rows, replay writes nothing =====
{
 const w=await world(full);
 await changeWriter(w.env,{writer:'discovery_owner',kind:'activate',expectedGeneration:0,...OPERATION,now:'2026-11-25T12:00:00.000Z'});
 // The response of the owner batch is lost after D1 applied it: the caller sees an exception.
 const real=w.env.DB.batch.bind(w.env.DB);
 let lose=false;
 w.env.DB.batch=async statements=>{
  const result=await real(statements);
  if(lose&&statements.some(item=>/INSERT INTO discovery_decision_history/.test(item.text))&&statements.some(item=>/state='receipt'/.test(item.text))){lose=false;throw new Error('lost response');}
  return result;
 };
 const historyBefore=JSON.parse(w.snapshot()).history.length;
 lose=true;
 const lost=await w.assign('41',{requestId:'req-lost-assign-001'});
 assert.equal(lost.result.outcome,'unknown','a lost response is an unknown outcome to the caller');
 const stored=JSON.parse(w.snapshot());
 assert.equal(stored.intents.find(row=>row.idempotency_key==='req-lost-assign-001').state,'receipt','the receipt is durable: the commit succeeded');
 assert.equal(stored.history.length,historyBefore+1,'the history row is durable');
 assert.equal(w.ledger().length,1,'the evidence row landed with it');
 // The durable record is the truth: a replay returns the receipt and adds no row.
 const replay=await Authority.ownerDecision(w.env,{idempotencyKey:'req-lost-assign-001',key:'obs-a',expectedHash:'stale',next:lost.next,lease:w.lease,writer:'discovery_identity_correct'});
 assert.equal(replay.outcome,'replay');
 assert.equal(w.ledger().length,1,'no duplicate row');
}
console.log('discovery owner evidence on the predecessor schema: ok');
