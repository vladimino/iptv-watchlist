// AIR-619 / ADR 0215 (Accepted), card E2c: the `discovery_owner` evidence writer, driven through the real caller path (`ownerDecision` -> `commitOwnerWrite`, the only path that
// commits an owner intent) on the sqlite3-CLI D1 stand-in. Local only: no Worker, R2, network or production access.
// Covered: absent/off (no row, the domain step unchanged), pending/on rows for assign, reject, revoke (scoped, naming the exact key) and replacement (own row + scoped
// withdrawal, same and other candidate), group children (own batch and row each, partial group), reconsider (no row), `source_order` = the history revision of the writing batch
// (never `seq`), forward references, replay (no duplicate), a colliding row (the whole domain batch rolls back), a flip racing the batch, a fence failure, an unplannable step,
// statement counts under the cap, and a recorded break.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import * as Identity from '../src/domain/discovery-identity-review.js';
import {changeWriter,readWriter} from '../src/identity-evidence-writer.js';
import {ownerRowKey,planOwnerEvidence,ownerEvidenceStatements} from '../src/discovery-owner-evidence.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-owner-evidence-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const file=path.join(root,'owner.sqlite');
const built=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+files.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26});
if(built.status!==0)throw new Error(built.stderr);

// `batches` holds the statement count of each OWNER write batch (the one that carries the decision history insert and the intent receipt), nothing else.
const batches=[];
const raw=d1Standin(file,{onBatch:async statements=>{
 if(!(statements.some(item=>/INSERT INTO discovery_decision_history/.test(item.text))&&statements.some(item=>/state='receipt'/.test(item.text))))return;
 batches.push(statements.length);
 // `hook` runs inside the owner batch call, after the statements were planned and before they are applied: the race window between planning and commit.
 if(hook){const run=hook;hook=null;await run(statements);}
}});
let hook=null;
const db=raw;
db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
const count=sql=>Number(Object.values(db.sql(sql)[0]||{n:0})[0]||0);
const RUN='run-e2c';
const hash=value=>Authority.decisionHash(value);
const read=async key=>(await Authority.routeRead(env,'epg/discovery-resolution.json')).value[key];
const OPERATION={reason:'owner-approved activation',deployedVersion:'4b23276',evidenceLink:'https://trello.com/c/eXzl5TI8#activation'};
let tick=0;
const writerTo=async target=>{
 let state=await readWriter(env,'discovery_owner');
 const path={off:[],pending:['activate'],on:['activate','drain_complete']}[target];
 if(state.state!=='off'&&target!=='off'&&state.state===target)return;
 if(state.state!=='off'){await changeWriter(env,{writer:'discovery_owner',kind:'deactivate',expectedGeneration:state.generation,...OPERATION,now:new Date(Date.UTC(2026,10,25,12,0,++tick)).toISOString()});state=await readWriter(env,'discovery_owner');}
 let generation=state.generation;
 for(const kind of path){
  await changeWriter(env,{writer:'discovery_owner',kind,expectedGeneration:generation,...OPERATION,drainEvidence:kind==='drain_complete'?'one deployment at 100%, no older instance':undefined,now:new Date(Date.UTC(2026,10,25,12,0,++tick)).toISOString()});
  generation+=1;
 }
};

let lease=(await Authority.acquireLease(env,{programmeRunId:null,role:'epg'})).lease;
assert.ok(lease);
env.discoveryLease=lease;
const OBS=['obs-a','obs-b','obs-c','obs-d','obs-e','obs-f','obs-g','obs-h','obs-i','obs-j','obs-k','obs-l','obs-m','obs-n','obs-o','obs-p'];
const item=key=>({key,title:'T '+key,normalizedTitle:'t '+key,year:1999,durations:[100],shows:[{channelId:'news',channel:'News',start:5,end:9}],seenInLatestSnapshot:true,lastAiring:5});
await Authority.replaceLedger(env,{programmeRunId:RUN,items:OBS.map(item)});
const base=key=>({status:'needs_verification',attempts:1,evidenceKey:Authority.evidenceKey(item(key)),terminalReason:'awaiting_confirmation',retryAt:null,scoring:{status:'accepted',acceptedTmdbId:'41'}});
await Authority.routeWrite(env,'epg/discovery-resolution.json',Object.fromEntries(OBS.map(key=>[key,base(key)])));
db.sql("UPDATE published_epg_authority SET programme_run_id='run-e2c' WHERE id=1");
const renewed=await Authority.renewLease(env,lease,{programmeRunId:RUN});
if(renewed.lease){lease=renewed.lease;env.discoveryLease=lease;}

let sequence=0;
const idem=()=>'req-'+String(++sequence).padStart(14,'0');
let clock=0;
const confirmedAt=()=>new Date(Date.UTC(2026,10,25,9,0,++clock)).toISOString();
const ledger=()=>db.sql('SELECT seq,evidence_key,film_id,subject_value,object_kind,object_value,polarity,route,method,source_root,scope_evidence_key,observed_at,source_order,request_id,origin FROM film_identity_evidence ORDER BY seq');
const history=key=>db.sql("SELECT revision,writer FROM discovery_decision_history WHERE observation_key='"+key+"' ORDER BY revision");
const intentState=requestId=>db.sql("SELECT state FROM discovery_intent WHERE idempotency_key='"+requestId+"'")[0]?.state;

// One owner action through the real writer, exactly as the routes perform it.
async function act(key,kind,command,build,expectedHash,extra={}){
 const requestId=extra.requestId||idem();
 const issued=extra.issued===undefined?{capability:'x',confirmedAt:extra.confirmedAt||confirmedAt()}:extra.issued;
 const saved=await Authority.putIntent(env,{idempotencyKey:requestId,kind,observationKey:key,command,expectedHash,expiresAt:Date.now()+600000,issued});
 assert.equal(saved.saved,true);
 const previous=await read(key);
 const next=build(previous,requestId);
 const before=batches.length;
 const result=await Authority.ownerDecision(env,{idempotencyKey:requestId,key,expectedHash,next,lease,writer:extra.writer||'discovery_identity_correct',receipt:{state:'applied',effect:command.effect}});
 return {requestId,result,next,statements:batches.slice(before).at(-1)};
}
const AT='2026-11-25T10:00:00.000Z';
async function doAssign(key,id,extra={}){
 const previous=await read(key);
 const command={effect:'assign',tmdbId:id,basis:'owner says so',...(extra.command||{})};
 return act(key,'identity_assign',command,(p,requestId)=>Identity.appliedIdentityDecision(p,{effect:'assign',tmdbId:id,basis:'owner says so'},{at:extra.at||AT,requestId,programmeRunId:RUN}),extra.expectedHash||await hash(previous),extra);
}
async function doReject(key,id,extra={}){
 const previous=await read(key);
 const command={effect:'reject',tmdbId:id,basis:'owner says so',...(extra.command||{})};
 return act(key,'identity_reject',command,(p,requestId)=>Identity.appliedIdentityDecision(p,{effect:'reject',tmdbId:id,basis:'owner says so'},{at:AT,requestId,programmeRunId:RUN}),extra.expectedHash||await hash(previous),extra);
}
async function doRevoke(key,originalId,extra={}){
 const evidence=await Authority.readIdentityActionEvidence(env,originalId,key);
 const provenance=Identity.revokeProvenance({intent:evidence.intent,history:evidence.history,current:evidence.current});
 assert.equal(provenance.ok,true,'provenance '+provenance.reason);
 const command=Identity.revokeCommand(provenance,{basis:'wrong film'});
 const stored={effect:'revoke',revokes:command.revokes,basis:command.basis};
 const requestId=extra.requestId||idem();
 const saved=await Authority.putIntent(env,{idempotencyKey:requestId,kind:'identity_revoke',observationKey:key,command:stored,expectedHash:evidence.decisionHash,expiresAt:Date.now()+600000,issued:extra.issued===undefined?{capability:'x',confirmedAt:confirmedAt()}:extra.issued});
 assert.equal(saved.saved,true);
 const next=Identity.appliedRevokeDecision(evidence.current,stored,{at:AT,requestId,identityBasis:'b'.repeat(64)});
 const before=batches.length;
 const result=await Authority.ownerDecision(env,{idempotencyKey:requestId,key,expectedHash:evidence.decisionHash,next,lease,writer:'discovery_identity_revoke',receipt:{state:'applied',effect:'revoke'}});
 return {requestId,result,next,statements:batches.slice(before).at(-1)};
}
const rowOf=async(key,effect,id,requestId)=>ownerRowKey({key,effect,tmdbId:id,requestId});
const byRoot=requestId=>ledger().filter(row=>row.source_root===requestId);

// ===== 1. absent and off: no row, the domain step is unchanged =====
{
 assert.equal((await readWriter(env,'discovery_owner')).state,'off');
 const a=await doAssign('obs-a','41');
 assert.equal(a.result.outcome,'written');
 assert.equal(ledger().length,0,'off: no row');
 assert.equal((await read('obs-a')).ownerIdentity.requestId,a.requestId);
 assert.equal(intentState(a.requestId),'receipt');
 const offStatements=a.statements;
 // The same step with the writer pending: the same batch plus the evidence statements. Reconsider (no row by design) never gains any.
 await writerTo('pending');
 const b=await doAssign('obs-b','41');
 assert.equal(b.result.outcome,'written');
 assert.ok(b.statements>=offStatements,'an off writer already appends its (inert) insert, assertion and order assertion');
 assert.equal(ledger().length,1,'pending: one row');
 await writerTo('off');
}

// ===== 2. on: the rows of Table 3 =====
await writerTo('on');
{
 const before=ledger().length;
 // assign
 const a=await doAssign('obs-c','41',{at:'2026-11-25T10:30:00.000Z'});
 assert.equal(a.result.outcome,'written');
 const rows=byRoot(a.requestId);
 assert.equal(rows.length,1);
 const [row]=rows;
 assert.deepEqual([row.film_id,row.subject_value,row.object_kind,row.object_value,row.polarity,row.route,row.method,row.origin,row.scope_evidence_key],[null,'obs-c','tmdb_movie','41','asserts','owner_action','owner_statement','live',null]);
 assert.equal(row.evidence_key,await rowOf('obs-c','assign','41',a.requestId),'the deterministic key');
 assert.equal(row.observed_at,'2026-11-25T10:30:00.000Z','time = ownerIdentity.at');
 assert.equal(row.request_id,a.requestId);
 const h=history('obs-c');
 assert.equal(row.source_order,h.at(-1).revision,'source_order = the history revision of the writing batch');
 assert.equal(ledger().length,before+1);
 // reject: refutes, time = the intent's confirmedAt
 const stamp='2026-11-25T09:15:00.000Z';
 const r=await doReject('obs-d','41',{confirmedAt:stamp});
 assert.equal(r.result.outcome,'written');
 const [rr]=byRoot(r.requestId);
 assert.deepEqual([rr.polarity,rr.object_value,rr.observed_at,rr.scope_evidence_key],['refutes','41',stamp,null]);
 assert.equal(rr.evidence_key,await rowOf('obs-d','reject','41',r.requestId));
 assert.equal(rr.source_order,history('obs-d').at(-1).revision);
}

// ===== 3. revoke: a scoped withdrawal naming the exact key of the revoked row; the canonical claim and the other rows are untouched =====
{
 const a=await doAssign('obs-e','41');
 const assignKey=await rowOf('obs-e','assign','41',a.requestId);
 assert.equal(byRoot(a.requestId)[0].evidence_key,assignKey);
 const revoke=await doRevoke('obs-e',a.requestId);
 assert.equal(revoke.result.outcome,'written');
 const [w]=byRoot(revoke.requestId);
 assert.deepEqual([w.polarity,w.object_value,w.scope_evidence_key,w.method,w.route],['refutes','41',assignKey,'owner_statement','owner_action'],'scoped to the revoked assign');
 assert.equal(w.source_order,history('obs-e').at(-1).revision);
 assert.equal(byRoot(a.requestId).length,1,'the assign row is never rewritten or removed');
 assert.equal(count('SELECT COUNT(*) AS n FROM film'),0);
 // a revoked reject
 const j=await doReject('obs-f','41');
 const rejectKey=await rowOf('obs-f','reject','41',j.requestId);
 const jr=await doRevoke('obs-f',j.requestId);
 assert.equal(jr.result.outcome,'written');
 const [wr]=byRoot(jr.requestId);
 assert.deepEqual([wr.polarity,wr.scope_evidence_key],['refutes',rejectKey],'scoped to the revoked reject');
 assert.notEqual(assignKey,rejectKey);
}

// ===== 4. forward reference: an intent made while the writer was off is revoked while it is on =====
{
 await writerTo('off');
 const a=await doAssign('obs-g','41');
 assert.equal(byRoot(a.requestId).length,0,'no row for the intent made while off');
 await writerTo('on');
 const revoke=await doRevoke('obs-g',a.requestId);
 assert.equal(revoke.result.outcome,'written');
 const [w]=byRoot(revoke.requestId);
 assert.equal(w.scope_evidence_key,await rowOf('obs-g','assign','41',a.requestId),'the withdrawal names the exact key the reconstruction of that intent will write');
 assert.equal(count("SELECT COUNT(*) AS n FROM film_identity_evidence WHERE evidence_key='"+w.scope_evidence_key+"'"),0,'the named row is not stored yet');
}

// ===== 5. replacement: own row plus one scoped withdrawal, same batch, same or another candidate; reinstatement is a new intent =====
{
 const a=await doAssign('obs-h','41');
 const aKey=await rowOf('obs-h','assign','41',a.requestId);
 const hashA=await hash(await read('obs-h'));
 const other=await doAssign('obs-h','56',{command:{supersedes:{requestId:a.requestId,decisionHash:hashA}}});
 assert.equal(other.result.outcome,'written','another candidate replaces the assign');
 const own=byRoot(other.requestId);
 assert.equal(own.length,2,'its own row and the scoped withdrawal');
 const asserts=own.find(row=>row.polarity==='asserts'),withdrawal=own.find(row=>row.polarity==='refutes');
 assert.equal(asserts.object_value,'56');
 assert.deepEqual([withdrawal.object_value,withdrawal.scope_evidence_key],['41',aKey]);
 assert.equal(asserts.source_order,withdrawal.source_order);
 assert.equal(asserts.source_order,history('obs-h').at(-1).revision);
 assert.equal(asserts.observed_at,withdrawal.observed_at);
 assert.ok(other.statements<=Authority.STATEMENT_CAP);
 // The same candidate: a reject replacing an assign of the same id.
 const hashB=await hash(await read('obs-h'));
 const sameKey=await rowOf('obs-h','assign','56',other.requestId);
 const same=await doReject('obs-h','56',{command:{supersedes:{requestId:other.requestId,decisionHash:hashB}}});
 assert.equal(same.result.outcome,'written');
 const rows=byRoot(same.requestId);
 assert.equal(rows.length,2);
 assert.deepEqual(rows.map(row=>[row.polarity,row.object_value,row.scope_evidence_key]).sort(),[['refutes','56',null],['refutes','56',sameKey]].sort());
 assert.notEqual(rows[0].evidence_key,rows[1].evidence_key);
 // Reinstatement: a new assign of the original id is a new intent, a new root and a new asserts row; the old withdrawal is not touched.
 const again=await doAssign('obs-h','41');
 assert.equal(again.result.outcome,'written');
 const [reinstated]=byRoot(again.requestId);
 assert.equal(reinstated.polarity,'asserts');
 assert.notEqual(reinstated.evidence_key,aKey);
}

// ===== 6. group children: each child is its own intent, batch and row; a partial group is a set of independent rows =====
{
 const batchesBefore=batches.length,rowsBefore=ledger().length;
 const children=[];
 for(const key of ['obs-i','obs-j']){
  const previous=await read(key);
  children.push(await act(key,'identity_assign',{effect:'assign',tmdbId:'77',basis:'group'},(p,requestId)=>Identity.appliedIdentityDecision(p,{effect:'assign',tmdbId:'77',basis:'group'},{at:AT,requestId,programmeRunId:RUN}),await hash(previous),{writer:'discovery_identity_correct'}));
 }
 assert.ok(children.every(child=>child.result.outcome==='written'));
 assert.equal(batches.length-batchesBefore,2,'one batch per child');
 assert.equal(ledger().length-rowsBefore,2);
 assert.notEqual(byRoot(children[0].requestId)[0].evidence_key,byRoot(children[1].requestId)[0].evidence_key);
 // A child whose decision moved is refused whole: no row for it, while its sibling's row stands.
 const stale=await hash(await read('obs-i'));
 const sibling=await doAssign('obs-i','78');
 assert.equal(sibling.result.outcome,'written');
 const bad=await act('obs-i','identity_assign',{effect:'assign',tmdbId:'79',basis:'group'},(p,requestId)=>Identity.appliedIdentityDecision(p,{effect:'assign',tmdbId:'79',basis:'group'},{at:AT,requestId,programmeRunId:RUN}),stale);
 assert.equal(bad.result.outcome,'conflict');
 assert.equal(byRoot(bad.requestId).length,0,'a refused child writes nothing');
 assert.equal(byRoot(sibling.requestId).length,1);
}

// ===== 7. chronology: source_order is the history revision, never seq; history imported before and after live actions (ADR 0215 decision 6) =====
// The historical rows are RECONSTRUCTED rows: real deterministic keys (`ownerRowKey`), origin `reconstruction`, run and source provenance, the causal revision of their own history.
// They are inserted straight into the ledger (the delivered ER path has its own tests); what is asserted here are the ORDERING INPUTS and the WITHDRAWAL IDENTITY, not a reader:
// `effective` below is a test-only fold of ADR 0215 decision 6 (the latest unwithdrawn owner row of one observation by source_order, never seq).
const COLUMNS='evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order'.split(',');
const lit=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
async function importHistorical({key,effect,tmdbId,requestId,order,scope=null,at='2026-11-01T00:00:00.000Z'}){
 const evidence_key=scope===null?await rowOf(key,effect,tmdbId,requestId):null;
 // A scoped historical withdrawal is not needed here; only assign/reject rows are reconstructed.
 const row={evidence_key,film_id:null,subject_kind:'discovery_observation',subject_value:key,relation:'candidate_for',object_kind:'tmdb_movie',object_value:String(tmdbId),polarity:effect==='assign'?'asserts':'refutes',route:'owner_action',method:'owner_statement',
  source_root:requestId,source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:at,origin:'reconstruction',reconstruction_run:'run-hist-1',reconstructed_from:'rec-'+requestId,request_id:'import-run-hist-1',recorded_at:'2026-11-25T11:00:00.000Z',source_order:order};
 db.sql('INSERT INTO film_identity_evidence ('+COLUMNS.join(',')+') VALUES ('+COLUMNS.map(name=>lit(row[name])).join(',')+')');
 return evidence_key;
}
const effective=key=>{
 const rows=ledger().filter(row=>row.subject_value===key);
 const withdrawn=new Set(rows.filter(row=>row.scope_evidence_key).map(row=>row.scope_evidence_key));
 const standing=rows.filter(row=>!row.scope_evidence_key&&!withdrawn.has(row.evidence_key)).sort((x,y)=>x.source_order-y.source_order);
 const latest=standing.at(-1);
 return latest?{polarity:latest.polarity,object:latest.object_value,live:latest.origin==='live'}:null;
};
const nextRevision=key=>count("SELECT COALESCE(MAX(revision),0)+1 AS n FROM discovery_decision_history WHERE observation_key='"+key+"'");
{
 // (a) a historical reject OLDER than a live assign: both insertion orders give the same effective row, and seq does not decide.
 // Order A: live first, history imported after (higher seq, lower source_order).
 const live1=await doAssign('obs-k','41');
 assert.equal(live1.result.outcome,'written');
 await importHistorical({key:'obs-k',effect:'reject',tmdbId:'41',requestId:'hist-reject-k0000001',order:1});
 const rowsK=ledger().filter(row=>row.subject_value==='obs-k');
 assert.ok(rowsK.find(row=>row.origin==='reconstruction').seq>rowsK.find(row=>row.origin==='live').seq,'historical after live: the higher seq');
 // Order B: history first (lower seq), live after.
 await importHistorical({key:'obs-l',effect:'reject',tmdbId:'41',requestId:'hist-reject-l0000001',order:1});
 const live2=await doAssign('obs-l','41');
 assert.equal(live2.result.outcome,'written');
 const rowsL=ledger().filter(row=>row.subject_value==='obs-l');
 assert.ok(rowsL.find(row=>row.origin==='reconstruction').seq<rowsL.find(row=>row.origin==='live').seq,'historical before live: the lower seq');
 assert.deepEqual(effective('obs-k'),{polarity:'asserts',object:'41',live:true});
 assert.deepEqual(effective('obs-k'),effective('obs-l'),'the same effective row in both insertion orders');
 // the order inputs are the causal revisions: the historical reject precedes the live assign in both observations
 for(const key of ['obs-k','obs-l']){
  const rows=ledger().filter(row=>row.subject_value===key);
  assert.ok(rows.find(row=>row.origin==='reconstruction').source_order<rows.find(row=>row.origin==='live').source_order,key);
 }

 // (b) forward withdrawal: the live revoke names a target that is imported AFTER it (A) or BEFORE it (B); the withdrawal identity is the same and the effective set is empty in both.
 await writerTo('off');
 const hold=await doAssign('obs-m','41');           // while off: no live row; its row will come from the reconstruction
 await writerTo('on');
 const revokeM=await doRevoke('obs-m',hold.requestId);
 assert.equal(revokeM.result.outcome,'written');
 const targetKey=await rowOf('obs-m','assign','41',hold.requestId);
 const orderOfHold=history('obs-m').find(row=>row.writer==='discovery_identity_correct').revision;
 assert.equal(ledger().filter(row=>row.subject_value==='obs-m'&&row.scope_evidence_key===targetKey).length,1,'the withdrawal names the key before the target exists');
 await importHistorical({key:'obs-m',effect:'assign',tmdbId:'41',requestId:hold.requestId,order:orderOfHold});
 assert.equal(effective('obs-m'),null,'target arriving after its withdrawal: withdrawn');
 await writerTo('off');
 const holdN=await doAssign('obs-n','41');
 await writerTo('on');
 const orderOfHoldN=history('obs-n').find(row=>row.writer==='discovery_identity_correct').revision;
 await importHistorical({key:'obs-n',effect:'assign',tmdbId:'41',requestId:holdN.requestId,order:orderOfHoldN});
 const revokeN=await doRevoke('obs-n',holdN.requestId);
 assert.equal(revokeN.result.outcome,'written');
 assert.equal(effective('obs-n'),null,'target present before its withdrawal: withdrawn');
 assert.equal(effective('obs-m'),effective('obs-n'));
 // a withdrawal of another proposition than the target's is refused by the ledger when the target arrives
 await assert.rejects(async()=>db.sql("INSERT INTO film_identity_evidence ("+COLUMNS.join(',')+") VALUES ("+COLUMNS.map(name=>lit({evidence_key:targetKey,film_id:null,subject_kind:'discovery_observation',subject_value:'obs-other',relation:'candidate_for',object_kind:'tmdb_movie',object_value:'41',polarity:'asserts',route:'owner_action',method:'owner_statement',source_root:'x-other',source_ref:null,source_scope:null,scope_evidence_key:null,supersedes_key:null,observed_at:AT,origin:'reconstruction',reconstruction_run:'r',reconstructed_from:'x',request_id:'i',recorded_at:AT,source_order:1}[name])).join(',')+")"),/./,'a target of another proposition under a named key is refused');

 // (c) known-root equivalence and collision on the live write: the reconstruction already stored the row of an intent made with a known root.
 const equalId='req-known-equal-0001';
 const equalOrder=nextRevision('obs-o');
 await importHistorical({key:'obs-o',effect:'assign',tmdbId:'41',requestId:equalId,order:equalOrder});
 const equal=await doAssign('obs-o','41',{requestId:equalId});
 assert.equal(equal.result.outcome,'written','an equal known-root row is a valid duplicate, not a collision');
 const rowsO=ledger().filter(row=>row.subject_value==='obs-o');
 assert.equal(rowsO.length,1,'no second row');
 assert.equal(rowsO[0].source_order,equalOrder);
 assert.equal(db.sql("SELECT origin FROM film_identity_evidence WHERE subject_value='obs-o'")[0].origin,'reconstruction','the first row is immutable: not promoted to live');
 const clashId='req-known-clash-0001';
 await importHistorical({key:'obs-p',effect:'assign',tmdbId:'41',requestId:clashId,order:nextRevision('obs-p')+5});
 const hashP=await hash(await read('obs-p'));
 const clash=await doAssign('obs-p','41',{requestId:clashId});
 assert.equal(clash.result.outcome,'unknown','a known-root row at another causal position is a collision: the batch rolls back');
 assert.equal(await hash(await read('obs-p')),hashP);
}

// ===== 8. replay: no duplicate row =====
{
 const a=await doAssign('obs-a','42');
 const rows=ledger().length;
 const replay=await Authority.ownerDecision(env,{idempotencyKey:a.requestId,key:'obs-a',expectedHash:'stale',next:a.next,lease,writer:'discovery_identity_correct'});
 assert.equal(replay.outcome,'replay');
 assert.equal(ledger().length,rows,'a replay writes no row');
}

// ===== 9. atomicity: a colliding row rolls the whole domain batch back; an unplannable step is refused while active =====
{
 const hashBefore=await hash(await read('obs-b'));
 // The row of the next assign is planted with another causal position: a mismatch under the same key.
 const requestId=idem();
 const key=await rowOf('obs-b','assign','90',requestId);
 db.sql("INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order) VALUES ('"+key+"',NULL,'discovery_observation','obs-b','candidate_for','tmdb_movie','90','asserts','owner_action','owner_statement','"+requestId+"',NULL,NULL,NULL,NULL,'2026-11-25T10:00:00.000Z','live',NULL,NULL,'planted','2026-11-25T10:00:00.000Z',9999)");
 const rowsBefore=ledger().length,historyBefore=history('obs-b').length;
 const collided=await doAssign('obs-b','90',{requestId});
 assert.equal(collided.result.outcome,'unknown','the batch failed whole');
 assert.equal(await hash(await read('obs-b')),hashBefore,'the decision is unchanged');
 assert.equal(history('obs-b').length,historyBefore,'no history row');
 assert.equal(ledger().length,rowsBefore,'no second row');
 assert.equal(intentState(requestId),'running','the intent keeps the existing unknown-outcome state; nothing is retried blindly');
 // Writer off: the same collision is not asserted (the batch carries no coverage claim) and the step commits.
 await writerTo('off');
 const cleared=await doAssign('obs-b','91');
 assert.equal(cleared.result.outcome,'written');
 await writerTo('on');
 // An eligible step that cannot yield a valid row (no confirmedAt on a reject) is refused BEFORE anything is written while the writer is active ...
 const hashC=await hash(await read('obs-c'));
 const noTime=await doReject('obs-c','95',{issued:{capability:'x'}});
 assert.equal(noTime.result.outcome,'conflict');
 assert.equal(await hash(await read('obs-c')),hashC);
 assert.equal(intentState(noTime.requestId),'approved','the intent stays approved: a clean refusal, not an unknown outcome');
 // ... and written without a row while it is off.
 await writerTo('off');
 const quiet=await doReject('obs-d','96',{issued:{capability:'x'}});
 assert.equal(quiet.result.outcome,'written');
 assert.equal(byRoot(quiet.requestId).length,0);
 await writerTo('on');
}

// ===== 10. races: a flip between planning and commit, and a fence failure =====
{
 // off at planning, on at commit: the prepared statements already carry the insert, so the row is written (never a silent gap inside a claimed interval).
 await writerTo('off');
 const rows=ledger().length;
 hook=async()=>{await writerTo('pending');};
 const a=await doAssign('obs-e','101');
 // the hook runs inside the batch call, before it is applied: the control row is pending when the batch commits
 assert.equal(a.result.outcome,'written');
 assert.equal(byRoot(a.requestId).length,1,'the flip landed before the commit: the row is written');
 assert.equal(ledger().length,rows+1);
 // on at planning, off at commit: no row, the step still commits, the assertion passes for off.
 await writerTo('on');
 hook=async()=>{await writerTo('off');};
 const b=await doAssign('obs-f','102');
 assert.equal(b.result.outcome,'written');
 assert.equal(byRoot(b.requestId).length,0);
 await writerTo('on');
 // a fence failure (the authority is held between planning and commit): the batch fails whole, no row, no decision change.
 const hashF=await hash(await read('obs-g'));
 const rowsF=ledger().length;
 hook=async()=>{db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");};
 const held=await doAssign('obs-g','103');
 db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");
 assert.equal(held.result.outcome,'unknown');
 assert.equal(await hash(await read('obs-g')),hashF);
 assert.equal(ledger().length,rowsF);
}

// ===== 11. reconsider and other owner writers write no row; a stale plan rolls the batch back =====
{
 const rows=ledger().length;
 const previous=await read('obs-a');
 const intent=idem();
 await Authority.putIntent(env,{idempotencyKey:intent,kind:'reconsider',observationKey:'obs-a',command:null,expectedHash:await hash(previous),expiresAt:Date.now()+600000,issued:{capability:'discovery_reconsider',confirmedAt:confirmedAt()}});
 const result=await Authority.ownerDecision(env,{idempotencyKey:intent,key:'obs-a',expectedHash:await hash(previous),next:{...previous,terminalReason:null,retryAt:null},lease,writer:'discovery_reconsider',receipt:{state:'applied',capability:'discovery_reconsider'}});
 assert.equal(result.outcome,'written');
 assert.equal(ledger().length,rows,'reconsider writes no row');
 assert.deepEqual(await planOwnerEvidence({intent:{kind:'reconsider',idempotencyKey:intent,command:null},key:'obs-a',next:{},revision:1}),{eligible:false});
 assert.deepEqual(await ownerEvidenceStatements(env,{plan:{eligible:false},key:'obs-a',requestId:intent,at:AT,revision:1}),[]);
 // The order assertion: a plan made for another revision rolls the batch back while the writer is active.
 const plan=await planOwnerEvidence({intent:{kind:'identity_assign',idempotencyKey:'req-stale-order-001',command:{effect:'assign',tmdbId:'5'},issued:{confirmedAt:AT}},key:'obs-a',next:{ownerIdentity:{effect:'assign',tmdbId:'5',requestId:'req-stale-order-001',at:AT}},revision:999});
 const statements=await ownerEvidenceStatements(env,{plan,key:'obs-a',requestId:'req-stale-order-001',at:AT,revision:999});
 await assert.rejects(()=>db.batch(statements.map(([sql,params])=>db.prepare(sql).bind(...params))),/CHECK constraint failed/);
 assert.equal(count("SELECT COUNT(*) AS n FROM film_identity_evidence WHERE source_root='req-stale-order-001'"),0);
}

// ===== 12. statement counts under the cap, on the new-row and duplicate paths; budget deviation recorded in the ADR follow-up =====
{
 const one=await doAssign('obs-c','110');
 const replacement=await (async()=>{
  const first=await doAssign('obs-d','111');
  const h=await hash(await read('obs-d'));
  return doAssign('obs-d','112',{command:{supersedes:{requestId:first.requestId,decisionHash:h}}});
 })();
 assert.ok(one.statements>=10&&one.statements<=11,'one row: the 7-8 of the domain batch, 2 for the row, 1 for the order assertion: '+one.statements);
 assert.ok(replacement.statements>=12&&replacement.statements<=13,'a replacement carries two more: '+replacement.statements);
 assert.ok(Math.max(...batches)<=Authority.STATEMENT_CAP);
}

// ===== 13. a recorded break ends the interval; history stays =====
{
 await writerTo('on');
 const state=await readWriter(env,'discovery_owner');
 await changeWriter(env,{writer:'discovery_owner',kind:'break',expectedGeneration:state.generation,...OPERATION,breakFrom:'2026-11-25T11:59:00.000Z',now:'2026-11-25T13:00:00.000Z'});
 assert.equal((await readWriter(env,'discovery_owner')).state,'off');
 const rows=ledger().length;
 const a=await doAssign('obs-i','120');
 assert.equal(a.result.outcome,'written');
 assert.equal(ledger().length,rows,'off after a break: no row');
 assert.ok(ledger().length>0,'the history of rows is kept');
}
console.log('discovery owner evidence: ok');
