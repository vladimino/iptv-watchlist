// AIR-617 / ADR 0215 (Accepted), card E2a: the DORMANT `discovery_decision` identity evidence writer, proved on the actual caller paths of the Discovery decision write
// (`writeDecisionDelta`, the chunk path, and `routeWrite('epg/discovery-resolution.json')` = `writeDecisions`, the document path), against local sqlite stand-ins.
// Nothing here calls Cloudflare, TMDB or production D1; nothing applies a migration to production or flips a flag.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {changeWriter,readWriter,readWriterChanges} from '../src/identity-evidence-writer.js';
import {evidenceKeyOf,normalizeEvidence} from '../src/identity-evidence.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const WRITER='discovery_decision';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const WRITER_FILE='0042_identity_evidence_writer_control.sql';
const upTo=name=>files.slice(0,files.indexOf(name)+1);
const chain41=upTo('0041_film_identity_evidence.sql'),chain42=upTo(WRITER_FILE);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-e2a-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
let databases=0;
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const count=(file,text)=>Number(Object.values(sql(file,text)[0]||{n:0})[0]);
const ledger=file=>sql(file,'SELECT seq,evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_scope,source_order,observed_at,origin,request_id FROM film_identity_evidence ORDER BY seq');
const OPERATION={reason:'owner-approved activation',deployedVersion:'7d8d4b3',evidenceLink:'https://trello.com/c/IfAZDYDj#activation'};
const START=Date.now()+3600000,MIN=60000,RUN='run-e2a';
const KEYS=['a|2001','b|2002','c|2003','d|2004','e|2005','f|2006','g|2007','h|2008'];
const CHECKED='2026-11-20T10:00:00.000Z',CHECKED_LATER='2026-11-21T11:30:00.000Z';

// A Discovery world at d1/open with one active observation per key and the lease of the programme run; the chain is complete up to 0041 (no control tables) or 0042.
async function world(chain,{keys=KEYS}={}){
 const file=path.join(root,'w-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null,role:'epg'});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){
  for(const [index,key] of keys.entries())yield {key,title:key.split('|')[0].toUpperCase(),normalizedTitle:key.split('|')[0],year:Number(key.split('|')[1]),durations:[100],duration:100,
   shows:[{channelId:'c'+index,channel:'C'+index,start:START+index*4*3600000,end:START+index*4*3600000+100*MIN}],seenInLatestSnapshot:true,lastAiring:START};
 })()});
 return {file,env,lease:taken.lease};
}
const setWriter=async(env,target)=>{
 let generation=(await readWriter(env,WRITER)).generation;
 for(const kind of {off:[],pending:['activate'],on:['activate','drain_complete']}[target]){
  await changeWriter(env,{writer:WRITER,kind,expectedGeneration:generation,...OPERATION,drainEvidence:kind==='drain_complete'?'one deployment at 100%, no older instance running':undefined,now:new Date(Date.now()-10000+generation).toISOString()});
  generation++;
 }
};
const detail=(over={})=>({status:'verified',filmId:'tmdb_603',tmdbId:'603',canonicalIdentity:'tmdb:603',identitySource:'tmdb_detail',checkedAt:CHECKED,attempts:1,...over});
const alias=(source,over={})=>({status:'verified',filmId:'tmdb_603',tmdbId:'603',identitySource:source,checkedAt:CHECKED,...over});
const delta=(world,key,next,previous=null)=>Authority.writeDecisionDelta(world.env,{[key]:{previous,next}},{lease:world.lease});
const stored=(file,key)=>sql(file,"SELECT payload_json,decision_hash FROM discovery_decision WHERE observation_key='"+key+"'")[0]||null;
const history=(file,key)=>count(file,"SELECT COUNT(*) FROM discovery_decision_history WHERE observation_key='"+key+"'");
const hashOf=decision=>Authority.decisionHash(decision);
const rejects=(promise,pattern)=>assert.rejects(promise,error=>{assert.match(String(error.code||error.message),pattern,String(error.stack||error));return true;});
// The batch the decision write sends, recorded without changing it (statement counts and order).
const recorded=(file,statements)=>d1Standin(file,{onBatch:async batch=>{statements.push(batch.map(item=>item.text));}});

// ===== 1. the pure mapping of ADR 0215 Table 3 =====
{
 const input=Authority.decisionEvidenceInput('a|2001',detail());
 assert.deepEqual(input,{subject:{kind:'discovery_observation',value:'a|2001'},relation:'candidate_for',object:{kind:'tmdb_movie',value:'603'},polarity:'asserts',route:'discovery_scan',method:'tmdb_detail_check',sourceRoot:'a|2001',sourceScope:null,observedAt:CHECKED});
 assert.equal(input.sourceRoot,input.subject.value,'the root is the observation key');
 assert.equal(Authority.decisionEvidenceInput('a|2001',alias('known_epg_alias')).method,'known_alias');
 assert.equal(Authority.decisionEvidenceInput('a|2001',alias('known_epg_alias')).sourceScope,'known_epg_alias');
 assert.equal(Authority.decisionEvidenceInput('a|2001',alias('known_alias_year_runtime')).sourceScope,'known_alias_year_runtime');
 assert.equal(Authority.decisionEvidenceInput('a|2001',detail({canonicalIdentity:'tmdb_tv:1396',tmdbId:'1396',filmId:'tmdb_tv1396'})).object.kind,'tmdb_tv','a TV decision names a TV id');
 // Every other decision states no checked identity: no row. The time is the decision's own, never the write time.
 for(const [name,decision] of [
  ['an unknown status',detail({status:'unresolved'})],
  ['a deferral',{status:'deferred',attempts:2,retryAt:'2026-11-22T00:00:00.000Z',terminalReason:'tmdb_rate_limited'}],
  ['a policy exclusion',{status:'excluded_nonfilm',terminalReason:'policy_documentary'}],
  ['a decision without identitySource',{status:'verified',filmId:'tmdb_603',tmdbId:'603',checkedAt:CHECKED}],
  ['an unknown identitySource',detail({identitySource:'owner_guess'})],
  ['an inherited identitySource name',detail({identitySource:'constructor'})],
  ['an owner decision',detail({identitySource:'owner'})],
  ['an owner-reviewed marker',detail({ownerIdentity:{requestId:'r',at:CHECKED}})],
  ['a verified decision without a TMDB id',detail({tmdbId:null})],
  ['null',null],
 ])assert.equal(Authority.decisionEvidenceInput('a|2001',decision),null,name);
 assert.equal(Authority.decisionEvidenceInput('',detail()),null);
 // The model refuses what it cannot record; the writer turns that into no row (the domain step is unchanged), see section 5.
 assert.throws(()=>normalizeEvidence(Authority.decisionEvidenceInput('a|2001',detail({checkedAt:undefined}))),error=>error.reason==='unchecked_no_observed_at');
}

// ===== 2. no control tables (schema 41) and `off`: the domain write is unchanged and writes no row =====
{
 // Before migration 0042 the batch carries ONE commit-time guard, never nothing, so a batch prepared before the migration cannot commit after it without its row.
 const w=await world(chain41);
 const batches=[];
 const env={...w.env,DB:recorded(w.file,batches)};
 const wrote=await Authority.writeDecisionDelta(env,{'a|2001':{previous:null,next:detail()}},{lease:w.lease});
 assert.deepEqual(wrote.written,['a|2001']);
 assert.equal(count(w.file,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'identity_evidence_writer%' OR name='film_identity_evidence'"),1,'schema 41 has the ledger only');
 const sent=batches.at(-1);
 assert.equal(sent.length,7,'the domain batch (6) plus one absence guard');
 assert.ok(sent.some(text=>/NOT EXISTS \(SELECT 1 FROM sqlite_master WHERE type='table' AND name IN \('identity_evidence_writer','identity_evidence_writer_change'\)\)/.test(text)),'the guard asserts the control tables are still absent');
 assert.equal(count(w.file,'SELECT COUNT(*) FROM film_identity_evidence'),0);
 assert.deepEqual(JSON.parse(stored(w.file,'a|2001').payload_json),detail());
 // The batch prepared on schema 41 fails closed if 0042 lands before it commits: the domain row is not written either.
 const racing=await world(chain41);
 const hooked={...racing.env,DB:d1Standin(racing.file,{onBatch:async()=>{
  const result=sqliteSync(['-bail',racing.file],{input:'PRAGMA foreign_keys=ON;\n'+fs.readFileSync('migrations/'+WRITER_FILE,'utf8')});
  if(result.status!==0)throw new Error(result.stderr);
 }})};
 await rejects(Authority.writeDecisionDelta(hooked,{'a|2001':{previous:null,next:detail()}},{lease:racing.lease}),/discovery_fence/);
 assert.equal(stored(racing.file,'a|2001'),null,'the domain write rolled back with the guard');
 assert.equal(history(racing.file,'a|2001'),0);
 // The replan sees schema 42 (off): the decision commits, no row.
 const again=await Authority.writeDecisionDelta({...racing.env,DB:d1Standin(racing.file)},{'a|2001':{previous:null,next:detail()}},{lease:racing.lease});
 assert.deepEqual(again.written,['a|2001']);
 assert.equal(count(racing.file,'SELECT COUNT(*) FROM film_identity_evidence'),0);
}
{
 // Schema 42 with no control row (= off), and an explicit off after a deactivation: both write no row, on both caller paths.
 const w=await world(chain42);
 assert.equal((await readWriter(w.env,WRITER)).state,'off');
 await delta(w,'a|2001',detail());
 await Authority.routeWrite(w.env,'epg/discovery-resolution.json',{'b|2002':detail({tmdbId:'604',filmId:'tmdb_604'})},{lease:w.lease});
 assert.equal(count(w.file,'SELECT COUNT(*) FROM film_identity_evidence'),0,'absent control row: no row');
 assert.ok(stored(w.file,'a|2001')&&stored(w.file,'b|2002'),'both decisions committed');
 await setWriter(w.env,'pending');
 await changeWriter(w.env,{writer:WRITER,kind:'deactivate',expectedGeneration:1,...OPERATION,now:new Date().toISOString()});
 await delta(w,'c|2003',detail());
 assert.equal(count(w.file,'SELECT COUNT(*) FROM film_identity_evidence'),0,'an explicit off writes no row');
}

// ===== 3. pending and on: a new verified decision writes its row in its own batch (chunk path) =====
for(const state of ['pending','on']){
 const w=await world(chain42);
 await setWriter(w.env,state);
 const batches=[];
 const env={...w.env,DB:recorded(w.file,batches)};
 const next=detail();
 const wrote=await Authority.writeDecisionDelta(env,{'a|2001':{previous:null,next}},{lease:w.lease});
 assert.deepEqual(wrote.written,['a|2001'],state);
 const hash=await hashOf(next);
 const [row,...rest]=ledger(w.file);
 assert.equal(rest.length,0,state+': exactly one row');
 assert.deepEqual([row.film_id,row.subject_kind,row.subject_value,row.relation,row.object_kind,row.object_value,row.polarity,row.route,row.method,row.source_root,row.source_scope,row.source_order,row.observed_at,row.origin,row.request_id],
  [null,'discovery_observation','a|2001','candidate_for','tmdb_movie','603','asserts','discovery_scan','tmdb_detail_check','a|2001',null,null,CHECKED,'live','discovery_decision:'+hash],state);
 assert.equal(row.evidence_key,await evidenceKeyOf(Authority.decisionEvidenceInput('a|2001',next)),'the key is the unchanged ADR 0213 key');
 // The statement count stays under the cap: the six domain statements plus the insert and its assertion.
 assert.equal(batches.at(-1).length,8,state+': the batch is 8 statements');
 assert.ok(batches.at(-1).length<=Authority.STATEMENT_CAP);
 // The row sits before the history insert, so the history row and the decision commit with it (same batch).
 const order=batches.at(-1).map(text=>/INSERT INTO film_identity_evidence/.test(text)?'evidence':/INSERT INTO discovery_decision_history/.test(text)?'history':/INSERT INTO discovery_decision /.test(text)?'decision':'other');
 assert.ok(order.indexOf('evidence')<order.indexOf('history')&&order.indexOf('history')<order.indexOf('decision'),order.join());
 // An unchanged decision (same hash): no batch, no new row.
 const repeat=await Authority.writeDecisionDelta(w.env,{'a|2001':{previous:next,next}},{lease:w.lease});
 assert.deepEqual([repeat.written,repeat.skipped],[[],[{key:'a|2001',reason:'unchanged'}]]);
 assert.equal(ledger(w.file).length,1,state+': a repeated decision writes no row');
 // The same decision re-stored with another attempt count is a new decision hash but the same proposition and root: the same key, so no second row and the batch commits.
 const bumped=detail({attempts:2});
 const second=await delta(w,'a|2001',bumped,next);
 assert.deepEqual(second.written,['a|2001']);
 assert.equal(history(w.file,'a|2001'),2,'the history row of the new decision was written');
 assert.equal(ledger(w.file).length,1,state+': the same key writes no second row');
 assert.equal(ledger(w.file)[0].seq,row.seq);
 assert.equal(ledger(w.file)[0].request_id,row.request_id,'the first writer of a key keeps it');
}

// ===== 4. every verified source, the revalidation, TV, and the decisions that write nothing =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 // known_epg_alias, then its revalidation into a detail check (a new decision hash, a new method, a new key): two distinct rows of one root.
 const known=alias('known_epg_alias');
 await delta(w,'a|2001',known);
 const confirmed=detail({checkedAt:CHECKED_LATER});
 await delta(w,'a|2001',confirmed,known);
 const rows=ledger(w.file);
 assert.deepEqual(rows.map(row=>[row.method,row.source_scope,row.observed_at]),[['known_alias','known_epg_alias',CHECKED],['tmdb_detail_check',null,CHECKED_LATER]]);
 assert.equal(new Set(rows.map(row=>row.source_root)).size,1,'both rows share the observation key as root: never independent of each other');
 assert.equal(new Set(rows.map(row=>row.evidence_key)).size,2);
 // known_alias_year_runtime keeps its own scope.
 await delta(w,'b|2002',alias('known_alias_year_runtime',{tmdbId:'604',filmId:'tmdb_604'}));
 assert.deepEqual(ledger(w.file).at(-1).source_scope,'known_alias_year_runtime');
 // A TV decision names a TV id.
 await delta(w,'c|2003',detail({tmdbId:'1396',filmId:'tmdb_tv1396',canonicalIdentity:'tmdb_tv:1396'}));
 assert.deepEqual([ledger(w.file).at(-1).object_kind,ledger(w.file).at(-1).object_value],['tmdb_tv','1396']);
 const before=ledger(w.file).length;
 // No row: a deferral, a policy exclusion, a verified decision without identitySource, an owner decision; each decision itself is written.
 await delta(w,'d|2004',{status:'deferred',attempts:1,retryAt:'2026-11-22T00:00:00.000Z',terminalReason:'tmdb_rate_limited'});
 await delta(w,'e|2005',{status:'excluded_nonfilm',terminalReason:'policy_documentary'});
 await delta(w,'f|2006',{status:'verified',filmId:'tmdb_605',tmdbId:'605',checkedAt:CHECKED});
 await delta(w,'g|2007',detail({identitySource:'owner',tmdbId:'606',filmId:'tmdb_606',ownerIdentity:{requestId:'req-owner-1',at:CHECKED}}));
 for(const key of ['d|2004','e|2005','f|2006','g|2007'])assert.ok(stored(w.file,key),key+' committed');
 assert.equal(ledger(w.file).length,before,'no other decision writes a row');
 // A decision whose id or time the ledger model refuses states no recordable check: no row, the domain step is unchanged.
 await delta(w,'h|2008',detail({tmdbId:'0',filmId:'tmdb_0'}));
 await Authority.routeWrite(w.env,'epg/discovery-resolution.json',{'h|2008':detail({tmdbId:'not-a-number',filmId:'tmdb_x',checkedAt:'yesterday'})},{lease:w.lease});
 assert.ok(stored(w.file,'h|2008'));
 assert.equal(ledger(w.file).length,before);
 // The Film is never touched: no Film revision and no canonical receipt (a domain row names no Film).
 assert.ok(ledger(w.file).every(row=>row.film_id===null));
 assert.equal(count(w.file,'SELECT COUNT(*) FROM canonical_write_receipt'),0);
}

// ===== 5. the document path (writeDecisions): a new decision writes, an unchanged one does not, statements stay under the cap =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 const first={'a|2001':detail(),'b|2002':alias('known_epg_alias',{tmdbId:'604',filmId:'tmdb_604'}),'c|2003':{status:'excluded_nonfilm',terminalReason:'policy_documentary'}};
 await Authority.routeWrite(w.env,'epg/discovery-resolution.json',first,{lease:w.lease});
 assert.deepEqual(ledger(w.file).map(row=>[row.subject_value,row.method]),[['a|2001','tmdb_detail_check'],['b|2002','known_alias']]);
 // The whole document again: every decision is unchanged (the history insert is conditional on the same hash), so no row is added.
 await Authority.routeWrite(w.env,'epg/discovery-resolution.json',first,{lease:w.lease});
 assert.equal(ledger(w.file).length,2,'an unchanged document writes no row');
 assert.equal(history(w.file,'a|2001'),1);
 // Only the changed decision writes its row, in the same batch as its history row.
 await Authority.routeWrite(w.env,'epg/discovery-resolution.json',{...first,'c|2003':detail({tmdbId:'607',filmId:'tmdb_607',checkedAt:CHECKED_LATER})},{lease:w.lease});
 assert.deepEqual(ledger(w.file).map(row=>row.subject_value),['a|2001','b|2002','c|2003']);
 // A document of many new decisions splits into capped batches, each row with its history row.
 const many={};
 const keys=Array.from({length:12},(_,index)=>'m'+index+'|2010');
 const big=await world(chain42,{keys});
 await setWriter(big.env,'on');
 for(const [index,key] of keys.entries())many[key]=detail({tmdbId:String(700+index),filmId:'tmdb_'+(700+index)});
 const batches=[];
 await Authority.routeWrite({...big.env,DB:recorded(big.file,batches)},'epg/discovery-resolution.json',many,{lease:big.lease});
 assert.equal(ledger(big.file).length,12);
 assert.ok(batches.every(batch=>batch.length<=Authority.STATEMENT_CAP),'every batch is under the statement cap: '+batches.map(batch=>batch.length));
 assert.ok(batches.length>=3,'the document is split across several batches');
}

// ===== 6. collision: a row under the same key with another identity rolls the domain effect back =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 const next=detail();
 const key=await evidenceKeyOf(Authority.decisionEvidenceInput('a|2001',next));
 // A row under the planned key that states something else (the key is a hash, so only a forged or damaged row can do this).
 sql(w.file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order) VALUES ('"+key+"',NULL,'discovery_observation','a|2001','candidate_for','tmdb_movie','999','asserts','discovery_scan','tmdb_detail_check','a|2001',NULL,NULL,NULL,NULL,'"+CHECKED+"','live',NULL,NULL,'forged','"+CHECKED+"',NULL)");
 await rejects(delta(w,'a|2001',next),/discovery_fence/);
 assert.equal(stored(w.file,'a|2001'),null,'the domain effect rolled back: no decision');
 assert.equal(history(w.file,'a|2001'),0,'and no history row');
 assert.equal(count(w.file,'SELECT COUNT(*) FROM film_identity_evidence'),1,'the forged row is untouched');
 // The same collision on the document path rolls the document batch back whole, and the transfer does not end committed.
 await rejects(Authority.routeWrite(w.env,'epg/discovery-resolution.json',{'a|2001':next},{lease:w.lease}),/discovery_/);
 assert.equal(stored(w.file,'a|2001'),null);
 // The same mismatch while `off` is not a collision: the writer is not recording.
 const off=await world(chain42);
 sql(off.file,"INSERT INTO film_identity_evidence (evidence_key,film_id,subject_kind,subject_value,relation,object_kind,object_value,polarity,route,method,source_root,source_ref,source_scope,scope_evidence_key,supersedes_key,observed_at,origin,reconstruction_run,reconstructed_from,request_id,recorded_at,source_order) VALUES ('"+key+"',NULL,'discovery_observation','a|2001','candidate_for','tmdb_movie','999','asserts','discovery_scan','tmdb_detail_check','a|2001',NULL,NULL,NULL,NULL,'"+CHECKED+"','live',NULL,NULL,'forged','"+CHECKED+"',NULL)");
 assert.deepEqual((await delta(off,'a|2001',next)).written,['a|2001']);
}

// ===== 7. pending / drain / activation races inside one batch =====
{
 // The writer flips off -> pending between the plan and the commit: the statements are state-independent, so the batch records the row.
 const w=await world(chain42);
 const flip={...w.env,DB:d1Standin(w.file,{onBatch:async()=>{await setWriter(w.env,'pending');}})};
 assert.deepEqual((await Authority.writeDecisionDelta(flip,{'a|2001':{previous:null,next:detail()}},{lease:w.lease})).written,['a|2001']);
 assert.equal(ledger(w.file).length,1,'a flip to pending before the commit still records the row');
 // The writer flips pending -> on (drain complete) and on -> off (break) around a commit: each commit is consistent with the state it ran under.
 const second=await world(chain42);
 await setWriter(second.env,'pending');
 await delta(second,'a|2001',detail());
 await changeWriter(second.env,{writer:WRITER,kind:'drain_complete',expectedGeneration:1,...OPERATION,drainEvidence:'one deployment at 100%, no older instance running',now:new Date().toISOString()});
 await delta(second,'b|2002',detail({tmdbId:'604',filmId:'tmdb_604'}));
 await changeWriter(second.env,{writer:WRITER,kind:'break',expectedGeneration:2,...OPERATION,breakFrom:new Date(Date.now()-1000).toISOString(),now:new Date().toISOString()});
 await delta(second,'c|2003',detail({tmdbId:'605',filmId:'tmdb_605'}));
 assert.deepEqual(ledger(second.file).map(row=>row.subject_value),['a|2001','b|2002'],'a row while pending and on; none after the break');
 assert.deepEqual((await readWriterChanges(second.env,WRITER)).map(entry=>entry.kind),['activate','drain_complete','break']);
 assert.ok(stored(second.file,'c|2003'),'the domain write committed after the break');
 // A version that predates the writer commits the same step with no row; the evidence is simply absent, never a false claim (coverage comes from the drain proof, not from a row).
 const old=await world(chain42);
 await setWriter(old.env,'pending');
 const previous=Authority.decisionEvidenceInput('a|2001',detail());
 assert.ok(previous);
 const hash=await hashOf(detail());
 const legacy=[
  ['INSERT INTO discovery_decision_history (observation_key, revision, generation, written_at, writer, payload_json) SELECT ?, 1, 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)',['a|2001',CHECKED,'resolver_chunk',JSON.stringify(detail()),'a|2001',hash]],
 ];
 const handle=d1Standin(old.file);
 await handle.batch(legacy.map(([text,params])=>handle.prepare(text).bind(...params)));
 assert.equal(ledger(old.file).length,0,'an older version writes no row while pending');
}

// ===== 8. fence, lease and hold: the row rolls back with the domain effect =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 // A stale lease fails the fence: nothing of the batch is written, the row included.
 await Authority.releaseLease(w.env,w.lease);
 await rejects(delta(w,'a|2001',detail()),/discovery_(lease|fence)/);
 assert.equal(stored(w.file,'a|2001'),null);
 assert.equal(ledger(w.file).length,0,'a failed fence leaves no row');
 // A held domain writes nothing: no decision, no row, no missed coverage.
 const held=await world(chain42);
 await setWriter(held.env,'on');
 sql(held.file,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 await rejects(delta(held,'a|2001',detail()),/discovery_/);
 await rejects(Authority.routeWrite(held.env,'epg/discovery-resolution.json',{'a|2001':detail()},{lease:held.lease}),/discovery_/);
 assert.equal(ledger(held.file).length,0);
 assert.equal(stored(held.file,'a|2001'),null);
 // A decision whose observation is gone (the CAS of the batch) is skipped whole: no decision and no row.
 const gone=await world(chain42);
 await setWriter(gone.env,'on');
 const missing=await delta(gone,'zz|1999',detail());
 assert.deepEqual([missing.written,missing.skipped.map(item=>item.reason)],[[],['observation_gone']]);
 assert.equal(ledger(gone.file).length,0);
 // A decision another writer changed meanwhile wins and the chunk skips the key: no row for the losing write.
 const raced=await world(chain42);
 await setWriter(raced.env,'on');
 await delta(raced,'a|2001',detail());
 const loser=await delta(raced,'a|2001',detail({tmdbId:'604',filmId:'tmdb_604',checkedAt:CHECKED_LATER}),null);
 assert.deepEqual(loser.written,[]);
 assert.equal(loser.skipped[0].reason,'conflict');
 assert.equal(ledger(raced.file).length,1,'the skipped write recorded nothing');
}

// ===== 9. replay: a response lost after the commit counts as written and never duplicates a row =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 let lost=true;
 const flaky={...w.env,DB:d1Standin(w.file,{onBatch:async()=>{}})};
 const real=flaky.DB.batch.bind(flaky.DB);
 flaky.DB.batch=async statements=>{const result=await real(statements);if(lost&&statements.some(item=>/INSERT INTO film_identity_evidence/.test(item.text))){lost=false;throw new Error('D1_ERROR: network connection lost');}return result;};
 const wrote=await Authority.writeDecisionDelta(flaky,{'a|2001':{previous:null,next:detail()}},{lease:w.lease});
 assert.deepEqual(wrote.written,['a|2001'],'the landed write is diagnosed from the stored rows');
 assert.equal(ledger(w.file).length,1);
 const replay=await Authority.writeDecisionDelta(w.env,{'a|2001':{previous:null,next:detail()}},{lease:w.lease});
 assert.deepEqual(replay.written.concat(replay.skipped.map(item=>item.reason)).length>0,true);
 assert.equal(ledger(w.file).length,1,'a replay never duplicates the row');
}

// ===== 10. a damaged evidence schema fails the decision write closed =====
{
 const w=await world(chain42);
 await setWriter(w.env,'on');
 sql(w.file,'DROP TABLE identity_evidence_writer_change');
 await rejects(delta(w,'a|2001',detail()),/discovery_unavailable/);
 assert.equal(stored(w.file,'a|2001'),null,'a damaged control schema never serves a silent gap inside a claimed interval');
 // A decision that states no evidence does not read the schema at all.
 assert.deepEqual((await delta(w,'b|2002',{status:'deferred',attempts:1})).written,['b|2002']);
}

// ===== 11. dormant: the bundle holds the writer but nothing activates it; no reader, no import =====
{
 const source=fs.readFileSync('src/discovery-authority.js','utf8');
 assert.doesNotMatch(source,/changeWriter|INSERT INTO identity_evidence_writer/,'the Discovery authority never flips a control row');
 assert.doesNotMatch(source,/SELECT[^`'"]*FROM film_identity_evidence/i,'the Discovery authority never reads the ledger to decide anything (ADR 0213 decision 8)');
 assert.match(fs.readFileSync('scripts/bundle-scope.mjs','utf8'),/scopedIdentityEvidence/);
 assert.match(fs.readFileSync('build.mjs','utf8'),/scopedIdentityEvidence\(\)\+'\\n'\+scopedDiscoveryAuthority\(\)/,'the writer is scoped in front of the Discovery authority');
 for(const workflow of fs.readdirSync('.github/workflows')){
  assert.ok(!/migrations\s+apply|d1\s+execute|0042_identity/.test(fs.readFileSync('.github/workflows/'+workflow,'utf8')),workflow+' applies no migration');
 }
}
console.log('identity evidence discovery decision writer (E2a): ok');
