// AIR-622 / ADR 0215 (Accepted), card E3b: family (b), the Discovery history, mapped for the manifest-bound import path (src/identity-evidence-family-b.js), on the sqlite3-CLI D1
// stand-in. No Worker, R2, network or production access; every object below is synthetic.
// Covered (ADR 0215 Table 4, decision 7): the mapping of b1 and b2 through the LIVE E2a function (same evidence key as a live row, time from `checkedAt`), b3 as no row and a count, b4 through
// the LIVE E2c planner (assign, reject, revoke, replacement, chronology by the history revision, unknown order and time left unknown), b5 (terminal R2 records only), b6 and b7 as counts,
// the cohort (a late arrival excluded and reported), the deterministic manifest, a dry run that writes nothing, and the import of the whole family on sqlite (four counts, replay, a moved
// source).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {evidenceKeyOf,normalizeEvidence} from '../src/identity-evidence.js';
import {changeWriter} from '../src/identity-evidence-writer.js';
import {decisionEvidenceInput,decisionHash} from '../src/discovery-authority.js';
import {ownerRowKey} from '../src/discovery-owner-evidence.js';
import {loadAndSealManifest,importRun,readImportReport,planManifest} from '../src/identity-evidence-import.js';
import * as FamilyB from '../src/identity-evidence-family-b.js';

const {mapDecision,r2Action,reconstructFamilyB,readFamilyBSources,dryRunFamilyB,R2_ACTION_PREFIX}=FamilyB;

const NEW='0044_identity_evidence_reconstruction_import.sql';
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const chain=files.slice(0,files.indexOf(NEW)+1);
const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-family-b-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const sqlite=(file,text)=>sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const one=(file,text)=>Object.values(rows(file,text)[0]||{})[0];
const ok=(file,text)=>{const r=sqlite(file,text);assert.equal(r.status,0,r.stderr+' <- '+text);};
const lit=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const template=path.join(root,'template.sqlite');
ok(template,chain.map(read).join('\n'));
let n=0;
const copy=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const BASE=Date.parse('2026-11-25T10:00:00.000Z');
const at=ms=>new Date(BASE+ms).toISOString();
const COHORT=at(0);
const WRITTEN=at(-3600000);
const envOf=file=>({DB:d1Standin(file)});

// ---- fixtures ----
const OBS=i=>'film '+i+'|2000';
const hist=(i,revision,writer,payload,written=WRITTEN)=>({observation_key:OBS(i),revision,generation:1,written_at:written,writer,payload_json:JSON.stringify(payload)});
const verified=(over={})=>({status:'verified',identitySource:'tmdb_detail',tmdbId:100,checkedAt:'2026-11-01T00:00:00.000Z',...over});
const insertHistory=(file,row)=>ok(file,'INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ('+[row.observation_key,row.revision,row.generation,row.written_at,row.writer,row.payload_json].map(lit).join(',')+')');
const insertIntent=(file,row)=>ok(file,'INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key,before_json,receipt_json,issued_json,command_json,expected_hash,expires_at,generation) VALUES ('+
 [row.idempotency_key,row.kind,row.state,row.observation_key,row.before_json??'{}',row.receipt_json,row.issued_json,row.command_json,row.expected_hash??'0'.repeat(64),row.expires_at??BASE+9000000,row.generation??1].map(lit).join(',')+')');
const insertDecision=(file,row)=>ok(file,'INSERT INTO discovery_decision (observation_key,generation,status,attempts,decision_hash,payload_json) VALUES ('+[row.observation_key,1,row.status||'verified',0,row.decision_hash,row.payload_json].map(lit).join(',')+')');
const sourcesOf=(partial={})=>({history:[],decisions:[],intents:[],r2Objects:[],counts:{observations:0,confirmedTmdbIds:0,admissions:0},...partial});
const manifestRows=manifest=>manifest.chunks.flatMap(chunk=>chunk.rows);
const plan=async(sources,over={})=>dryRunFamilyB({runId:'run-b',cohortAt:COHORT,sources,planManifest,...over});
// A stored intent as `readFamilyBSources` selects it.
const intentRow=async(id,kind,observation,{command,issued={confirmedAt:at(-1800000)},receipt,state='receipt'})=>({idempotency_key:id,kind,state,observation_key:observation,receipt_json:receipt===null?null:JSON.stringify(receipt),issued_json:JSON.stringify(issued),command_json:JSON.stringify(command),expected_hash:'0'.repeat(64)});

// ===== 1. b1 / b2 / b3 / b6: one decision, through the LIVE E2a function =====
{
 const key=OBS(1);
 const b1=mapDecision(key,verified());
 assert.equal(b1.source,'tmdb_detail');assert.equal(b1.timeUnknown,false);
 assert.deepEqual(b1.input,decisionEvidenceInput(key,verified()),'the mapping IS the live E2a mapping, not a copy');
 assert.equal(b1.input.observedAt,'2026-11-01T00:00:00.000Z','the time is the payload checkedAt');
 assert.equal(b1.input.method,'tmdb_detail_check');assert.equal(b1.input.sourceScope,null);assert.equal(b1.input.sourceRoot,key);
 const epg=mapDecision(key,verified({identitySource:'known_epg_alias'}));
 assert.equal(epg.input.method,'known_alias');assert.equal(epg.input.sourceScope,'known_epg_alias');
 const yr=mapDecision(key,verified({identitySource:'known_alias_year_runtime'}));
 assert.equal(yr.input.sourceScope,'known_alias_year_runtime');
 assert.equal(mapDecision(key,verified({canonicalIdentity:'tmdb_tv:5'})).input.object.kind,'tmdb_tv','a TV decision names a TV id');
 assert.equal(mapDecision(key,verified()).input.object.kind,'tmdb_movie');
 // Unknowns stay unknown: a time that is missing or not an instant is a null time, never written_at or the current time.
 assert.equal(mapDecision(key,verified({checkedAt:undefined})).input.observedAt,null);assert.equal(mapDecision(key,verified({checkedAt:undefined})).timeUnknown,true);
 assert.equal(mapDecision(key,verified({checkedAt:'yesterday'})).input.observedAt,null);assert.equal(mapDecision(key,verified({checkedAt:'yesterday'})).timeUnknown,true);
 // No row: b3 (no identitySource), an owner decision, other statuses, no id, an unreadable payload.
 assert.deepEqual(mapDecision(key,verified({identitySource:undefined})),{none:'no_identity_source'});
 assert.deepEqual(mapDecision(key,verified({identitySource:'owner'})),{none:'owner_source'});
 assert.deepEqual(mapDecision(key,verified({status:'deferred'})),{none:'not_verified'});
 assert.deepEqual(mapDecision(key,verified({tmdbId:null})),{none:'no_tmdb_id'});
 assert.deepEqual(mapDecision(key,null),{none:'payload_unreadable'});
 assert.deepEqual(mapDecision(key,verified({identitySource:'something_else'})),{none:'other_source'});
}

// ===== 2. the reconstructed key is the live key (decision 7: same mapping, same key when the root is known) =====
{
 const sources=sourcesOf({history:[hist(1,1,'resolver_chunk',verified())]});
 const result=await plan(sources);
 const [row]=manifestRows(result.manifest);
 const live=await evidenceKeyOf(normalizeEvidence({origin:'live',...decisionEvidenceInput(OBS(1),verified())}));
 assert.equal(row.key,live,'a live row and the reconstructed row of one fact share a key');
 assert.equal(row.reconstructedFrom.startsWith('d1:discovery_decision_history:'),true);
 assert.equal(result.manifest.family,'b');assert.deepEqual(result.manifest.writers,['discovery_decision','discovery_owner']);
 assert.equal(row.observedAt,'2026-11-01T00:00:00.000Z');assert.notEqual(row.observedAt,WRITTEN,'never written_at');
}

// ===== 3. the dry run: b1 / b2 / b3 / b6 / b7, duplicates, late arrivals, determinism =====
{
 const history=[
  hist(1,1,'resolver_chunk',verified()),                                    // b1
  hist(1,2,'resolver_chunk',verified({checkedAt:'2026-11-02T00:00:00.000Z'})),  // the same pair again: one key, a reported duplicate
  hist(2,1,'resolver_chunk',verified({identitySource:'known_epg_alias',tmdbId:200})),   // b2
  hist(3,1,'resolver_chunk',verified({identitySource:'known_alias_year_runtime',tmdbId:300})), // b2
  hist(4,1,'resolver_chunk',verified({identitySource:undefined,tmdbId:400})), // b3
  hist(5,1,'catalog_policy_exclude',{status:'excluded'}),                    // b6
  hist(6,1,'resolver_chunk',{status:'deferred'}),                            // b6
  hist(7,1,'discovery_reconsider',{status:'unresolved'}),                    // b6
  hist(8,1,'resolver_chunk',verified({tmdbId:800}),at(60000)),               // a late arrival
 ];
 const sources=sourcesOf({history,counts:{observations:82004,confirmedTmdbIds:3,admissions:12536}});
 const result=await plan(sources);
 const counts=result.coverage.counts;
 assert.equal(counts.b1.pairs,1);assert.equal(counts.b2.known_epg_alias.pairs,1);assert.equal(counts.b2.known_alias_year_runtime.pairs,1);
 assert.equal(counts.b3.pairs,1);assert.equal(result.coverage.noRow.no_identity_source,1);
 assert.equal(counts.b6.byWriterAndStatus['catalog_policy_exclude|excluded'],1);assert.equal(counts.b6.byWriterAndStatus['resolver_chunk|deferred'],1);
 assert.equal(counts.b7.observations,82004);assert.equal(counts.b7.admissions,12536);
 assert.equal(result.coverage.lateArrivals.count,1);assert.equal(result.coverage.lateArrivals.sample[0].observationKey,OBS(8));
 assert.equal(manifestRows(result.manifest).length,3,'one row per distinct fact; b3, b6, b7 and the late arrival give none');
 assert.equal(result.report.duplicates.length,1,'the repeated pair is a reported duplicate, the first record owns the key');
 const [first]=manifestRows(result.manifest);assert.equal(first.observedAt,'2026-11-01T00:00:00.000Z','the earliest revision owns the key');
 // Deterministic: the same sources in any order give the same digest.
 const shuffled=await plan(sourcesOf({history:[...history].reverse(),counts:sources.counts}));
 assert.equal(shuffled.digest,result.digest);
 // Nothing is invented: no owner statement, no admission, no check for a row without a method.
 assert.equal(manifestRows(result.manifest).every(row=>row.route==='discovery_scan'&&row.polarity==='asserts'),true);
}

// ===== 4. b4: owner intents through the LIVE E2c planner =====
{
 const history=[
  hist(1,1,'resolver_chunk',verified({tmdbId:100})),
 ];
 const assignPayload={status:'verified',identitySource:'owner',tmdbId:111,ownerIdentity:{effect:'assign',tmdbId:111,requestId:'intent-assign',at:at(-7200000)}};
 const rejectPayload={status:'unresolved',rejectedTmdbIds:[222]};
 history.push(hist(1,2,'discovery_identity_correct',assignPayload),hist(2,1,'discovery_identity_correct',rejectPayload));
 const intents=[
  await intentRow('intent-assign','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:111,basis:'owner'},receipt:{state:'applied',decisionHash:await decisionHash(assignPayload)}}),
  await intentRow('intent-reject','identity_reject',OBS(2),{command:{effect:'reject',tmdbId:222,basis:'owner'},receipt:{state:'applied',decisionHash:await decisionHash(rejectPayload)}}),
  // A revoke of the assign (its history row is not in the source: the order stays unknown), and a replacement whose superseded intent is not in the source.
  await intentRow('intent-revoke','identity_revoke',OBS(1),{command:{effect:'revoke',revokes:{requestId:'intent-assign',effect:'assign',tmdbId:111}},receipt:{state:'applied',decisionHash:'f'.repeat(64)}}),
  await intentRow('intent-replace','identity_assign',OBS(3),{command:{effect:'assign',tmdbId:333,supersedes:{requestId:'intent-gone',decisionHash:'a'.repeat(64)}},receipt:{state:'applied',decisionHash:'e'.repeat(64)}}),
 ];
 const result=await plan(sourcesOf({history,intents}));
 const byRoot={};for(const row of manifestRows(result.manifest).filter(item=>item.route==='owner_action'))(byRoot[row.sourceRoot]=byRoot[row.sourceRoot]||[]).push(row);   // CI runs Node 20: no Object.groupBy
 // The assign: asserts, root = the intent key, time = ownerIdentity.at, source_order = the history revision of the very write (2), and the live key.
 const assign=byRoot['intent-assign'][0];
 assert.equal(assign.polarity,'asserts');assert.equal(assign.observedAt,at(-7200000));assert.equal(assign.sourceOrder,2);
 assert.equal(assign.key,await ownerRowKey({key:OBS(1),effect:'assign',tmdbId:111,requestId:'intent-assign'}),'the live key');
 assert.equal(assign.reconstructedFrom.startsWith('d1:discovery_decision_history:'),true,'a linked action is sourced from its immutable history row');
 // The reject: refutes, time = issued.confirmedAt, order = the revision of its history row (1).
 const reject=byRoot['intent-reject'][0];
 assert.equal(reject.polarity,'refutes');assert.equal(reject.observedAt,at(-1800000));assert.equal(reject.sourceOrder,1);
 assert.equal(reject.key,await ownerRowKey({key:OBS(2),effect:'reject',tmdbId:222,requestId:'intent-reject'}));
 // The revoke: a scoped refutation naming the exact key of the revoked assign (a forward reference is fine); order unknown, never guessed.
 const revoke=byRoot['intent-revoke'][0];
 assert.equal(revoke.polarity,'refutes');assert.equal(revoke.scopeEvidenceKey,assign.key);assert.equal(revoke.sourceOrder,null,'no linked history row: the order stays unknown');
 assert.equal(revoke.reconstructedFrom.startsWith('d1:discovery_intent:'),true,'an unlinked action is sourced from its intent');
 // The replacement whose superseded intent is gone: its own row is kept, the scoped withdrawal cannot be named and is reported, not invented. The assign has no history row: unknown time.
 const replace=byRoot['intent-replace'];
 assert.equal(replace.length,1);assert.equal(replace[0].observedAt,null,'an assign without its history row has no recorded time');assert.equal(replace[0].sourceOrder,null);
 const counts=result.coverage.counts.b4;
 assert.equal(counts.actions,4);assert.equal(counts.linkedToHistory,2);assert.equal(counts.orderUnknown,2);assert.equal(counts.timeUnknown,1);assert.equal(counts.scopedWithdrawalUnavailable,1);
 // The owner history rows are never read as E2a decisions (b1 / b2): the assign payload has identitySource 'owner'.
 assert.equal(manifestRows(result.manifest).filter(row=>row.route==='discovery_scan').length,1);
}

// ===== 4b. replacement chronology: both intents present, own row plus the scoped withdrawal, order by the revision =====
{
 const firstPayload={status:'verified',identitySource:'owner',tmdbId:100,ownerIdentity:{effect:'assign',tmdbId:100,requestId:'intent-1',at:at(-9000000)}};
 const secondPayload={status:'verified',identitySource:'owner',tmdbId:200,ownerIdentity:{effect:'assign',tmdbId:200,requestId:'intent-2',at:at(-8000000)}};
 const history=[hist(1,1,'discovery_identity_correct',firstPayload),hist(1,2,'discovery_identity_correct',secondPayload)];
 const intents=[
  await intentRow('intent-1','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:100},receipt:{state:'applied',decisionHash:await decisionHash(firstPayload)}}),
  await intentRow('intent-2','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:200,supersedes:{requestId:'intent-1',decisionHash:await decisionHash(firstPayload)}},receipt:{state:'applied',decisionHash:await decisionHash(secondPayload)}}),
 ];
 const result=await plan(sourcesOf({history,intents}));
 const owner=manifestRows(result.manifest).filter(row=>row.route==='owner_action');
 assert.equal(owner.length,3,'intent-1, intent-2 and the scoped withdrawal of intent-1');
 const withdrawal=owner.find(row=>row.sourceRoot==='intent-2'&&row.polarity==='refutes');
 assert.equal(withdrawal.objectValue,'100');assert.equal(withdrawal.scopeEvidenceKey,owner.find(row=>row.sourceRoot==='intent-1').key);
 assert.equal(withdrawal.sourceOrder,2,'the withdrawal shares the order of the replacing write');
 assert.equal(result.coverage.counts.b4.scopedWithdrawalUnavailable,0);
 // Chronology is the history revision, not the clock: reversing the input and the history order changes nothing.
 const reversed=await plan(sourcesOf({history:[...history].reverse(),intents:[...intents].reverse()}));
 assert.equal(reversed.digest,result.digest);
}

// ===== 5. b5: pre-D1 R2 actions, terminal records that state everything, otherwise no row =====
{
 const object=(id,record,etag='etag-'+id)=>({key:R2_ACTION_PREFIX+id+'.json',etag,record});
 const base=id=>({schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:id,state:'applied',issued:{confirmedAt:at(-5000000)},command:{effect:'reject',tmdbId:555,basis:'owner'},provenance:{observationKey:OBS(9)}});
 const objects=[
  object('r2-reject',base('r2-reject')),
  object('r2-assign',{...base('r2-assign'),command:{effect:'assign',tmdbId:666}}),
  object('r2-running',{...base('r2-running'),state:'running'}),
  object('r2-nomovie',{...base('r2-nomovie'),command:{effect:'assign'}}),
  object('r2-noobs',{...base('r2-noobs'),provenance:{}}),
  object('r2-mismatch',{...base('other-key')}),
  object('r2-shape',{schemaVersion:9}),
  {key:'admin/actions/other/v1/x.json',etag:'e',record:{}},
 ];
 assert.deepEqual(r2Action(objects[2]),{none:'not_terminal'});assert.deepEqual(r2Action(objects[3]),{none:'movie_not_stated'});assert.deepEqual(r2Action(objects[4]),{none:'observation_not_stated'});
 assert.deepEqual(r2Action(objects[5]),{none:'key_mismatch'});assert.deepEqual(r2Action(objects[6]),{none:'unknown_shape'});assert.deepEqual(r2Action(objects[7]),{none:'not_an_action_object'});
 // Without the owner's acceptance of the residual window an R2 record is excluded (reported), never imported silently.
 const refused=await plan(sourcesOf({r2Objects:objects}));
 assert.equal(refused.manifest,null);assert.equal(refused.report.excluded.filter(item=>item.reason==='r2_residual_not_accepted').length,2);
 const accepted=await plan(sourcesOf({r2Objects:objects}),{acceptR2Residual:true});
 const rowsB5=manifestRows(accepted.manifest);
 assert.equal(rowsB5.length,2);
 const reject=rowsB5.find(row=>row.sourceRoot==='r2-reject'),assign=rowsB5.find(row=>row.sourceRoot==='r2-assign');
 assert.equal(reject.observedAt,at(-5000000));assert.equal(reject.sourceOrder,null,'no history revision in R2: the order is unknown');
 assert.equal(assign.observedAt,null,'the time of an R2 assign is not recorded: unknown, never inferred');
 assert.equal(reject.key,await ownerRowKey({key:OBS(9),effect:'reject',tmdbId:555,requestId:'r2-reject'}));
 const b5=accepted.coverage.counts.b5;
 assert.equal(b5.eligible,2);assert.equal(b5.listed,8);assert.equal(b5.ineligible.not_terminal,1);assert.equal(b5.ineligible.movie_not_stated,1);assert.equal(b5.ineligible.observation_not_stated,1);
 // A D1 intent and an R2 object of one action give one key: the D1 record (first in manifest order) owns it, the R2 record is a reported duplicate.
 const intent=await intentRow('r2-reject','identity_reject',OBS(9),{command:{effect:'reject',tmdbId:555},receipt:{state:'applied',decisionHash:'9'.repeat(64)}});
 const both=await plan(sourcesOf({intents:[intent],r2Objects:[objects[0]]}),{acceptR2Residual:true});
 assert.equal(manifestRows(both.manifest).length,1);assert.equal(both.report.duplicates.length,1);
}

// ===== 6. the current decision rows: used only where the history does not cover the pair =====
{
 const payload=verified({tmdbId:700});
 const decisionRow={observation_key:OBS(7),decision_hash:await decisionHash(payload),status:'verified',tmdb_id:700,media_kind:'movie',payload_json:JSON.stringify(payload)};
 const covered=await plan(sourcesOf({history:[hist(7,1,'resolver_chunk',payload)],decisions:[decisionRow]}));
 assert.equal(manifestRows(covered.manifest).length,1);assert.equal(covered.coverage.counts.decisionsCoveredByHistory,1);
 assert.equal(manifestRows(covered.manifest)[0].reconstructedFrom.startsWith('d1:discovery_decision_history:'),true);
 const alone=await plan(sourcesOf({decisions:[decisionRow]}));
 assert.equal(manifestRows(alone.manifest).length,1);assert.equal(manifestRows(alone.manifest)[0].reconstructedFrom.startsWith('d1:discovery_decision:'),true,'an R2-era decision with no history row is sourced from the decision row');
}

// ===== 7. reading the sources is SELECT only, and the whole family imports on sqlite =====
{
 const file=copy();
 const guardAssign={status:'verified',identitySource:'owner',tmdbId:111,ownerIdentity:{effect:'assign',tmdbId:111,requestId:'intent-assign',at:at(-7200000)}};
 insertHistory(file,hist(1,1,'resolver_chunk',verified()));
 insertHistory(file,hist(2,1,'resolver_chunk',verified({identitySource:'known_epg_alias',tmdbId:200})));
 insertHistory(file,hist(3,1,'resolver_chunk',verified({identitySource:undefined,tmdbId:300})));
 insertHistory(file,hist(4,1,'discovery_identity_correct',guardAssign));
 insertHistory(file,hist(5,1,'resolver_chunk',verified({tmdbId:500}),at(60000)));
 insertIntent(file,{idempotency_key:'intent-assign',kind:'identity_assign',state:'receipt',observation_key:OBS(4),receipt_json:JSON.stringify({state:'applied',decisionHash:await decisionHash(guardAssign)}),
  issued_json:JSON.stringify({confirmedAt:at(-7200000)}),command_json:JSON.stringify({effect:'assign',tmdbId:111})});
 insertIntent(file,{idempotency_key:'intent-pending',kind:'identity_assign',state:'approved',observation_key:OBS(6),receipt_json:null,issued_json:JSON.stringify({}),command_json:JSON.stringify({effect:'assign',tmdbId:1})});
 const statements=[];
 const db=d1Standin(file);
 const watched={prepare:sql=>{statements.push(sql);return db.prepare(sql);},batch:db.batch.bind(db)};
 const sources=await readFamilyBSources(watched,{pageSize:2});
 assert.equal(statements.length>0,true);assert.equal(statements.every(sql=>/^SELECT /.test(sql)),true,'the extraction only SELECTs: '+statements.filter(sql=>!/^SELECT /.test(sql)));
 assert.equal(sources.history.length,5);assert.equal(sources.intents.length,1,'only identity intents with a receipt');
 const result=await dryRunFamilyB({runId:'run-b',cohortAt:COHORT,sources,planManifest});
 assert.equal(result.coverage.lateArrivals.count,1);
 assert.equal(manifestRows(result.manifest).length,3,'b1, b2 and the owner assign; b3 and the late arrival give nothing');
 // The dry run wrote nothing: the ledger is still empty.
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0);
 // Stage, activate both writers, import.
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 const set=(writer,kind,generation,extra={})=>changeWriter(env,{writer,kind,expectedGeneration:generation,reason:'test',deployedVersion:'abc',evidenceLink:'https://example.test/e',now:at(1100+generation),...extra});
 await set('discovery_decision','activate',0);await set('discovery_decision','drain_complete',1,{drainEvidence:'drained'});
 await set('discovery_owner','activate',0);await set('discovery_owner','drain_complete',1,{drainEvidence:'drained'});
 const done=await importRun(env,{runId:'run-b',approvedDigest:result.digest,owner:'operator-a',now:at(2000)});
 assert.equal(done.state,'complete');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),3);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE origin='reconstruction' AND reconstruction_run='run-b'"),3);
 const report=await readImportReport(env,'run-b');
 const totals=report.receipts.reduce((sum,item)=>({inserted:sum.inserted+item.inserted,already:sum.already+item.alreadyImported,live:sum.live+item.liveCovered,equal:sum.equal+item.reconstructedEquivalent}),{inserted:0,already:0,live:0,equal:0});
 assert.equal(totals.inserted+totals.already+totals.live+totals.equal,3,'the four counts add up to the staged keys');
 assert.equal(totals.inserted,3);
 // The owner row carries the history revision as its source_order.
 assert.equal(one(file,"SELECT source_order FROM film_identity_evidence WHERE route='owner_action'"),1);
 // A second run of the same cohort imports nothing new: every key is already imported (idempotent replay under another run id).
 const again=await dryRunFamilyB({runId:'run-b2',cohortAt:COHORT,sources,planManifest});
 await loadAndSealManifest(env,{manifest:again.manifest,approvedDigest:again.digest,now:at(3000)});
 await importRun(env,{runId:'run-b2',approvedDigest:again.digest,owner:'operator-a',now:at(4000)});
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),3,'no duplicate rows');
}

// ===== 8. a source that moves after the dry run fails its chunk and writes nothing =====
{
 const file=copy();
 insertHistory(file,hist(1,1,'resolver_chunk',verified()));
 const sources=await readFamilyBSources(d1Standin(file));
 const result=await dryRunFamilyB({runId:'run-m',cohortAt:COHORT,sources,planManifest});
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 const set=(writer,kind,generation,extra={})=>changeWriter(env,{writer,kind,expectedGeneration:generation,reason:'test',deployedVersion:'abc',evidenceLink:'https://example.test/e',now:at(1100+generation),...extra});
 await set('discovery_decision','activate',0);await set('discovery_decision','drain_complete',1,{drainEvidence:'drained'});
 await set('discovery_owner','activate',0);await set('discovery_owner','drain_complete',1,{drainEvidence:'drained'});
 ok(file,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.tmdbId',999) WHERE observation_key="+lit(OBS(1)));
 await assert.rejects(()=>importRun(env,{runId:'run-m',approvedDigest:result.digest,owner:'operator-a',now:at(2000)}),error=>{assert.match(String(error.code||error.message),/source_moved|identity_evidence_import/);return true;});
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0,'a moved source writes nothing');
}

// ===== 9. dormant: nothing in the Worker imports the module, and it exports no writer =====
{
 const srcFiles=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js'));
 const importers=srcFiles.filter(name=>/identity-evidence-family-b/.test(fs.readFileSync(path.join('src',String(name)),'utf8'))&&!String(name).endsWith('identity-evidence-family-b.js'));
 assert.deepEqual(importers,[],'no Worker module imports the family (b) extraction');
 const text=fs.readFileSync('src/identity-evidence-family-b.js','utf8');
 assert.equal(/\b(INSERT|UPDATE|DELETE)\s/.test(text.replace(/\/\/.*$/gm,'')),false,'no write statement in the module');
 assert.equal(await planManifest({runId:'noop',family:'b',cohortAt:COHORT,records:[]}).then(result=>result.manifest),null,'an empty family is a report-only dry run');
 await assert.rejects(()=>dryRunFamilyB({runId:'x',cohortAt:COHORT,sources:sourcesOf()}),/plan_manifest_required/,'the import path is handed in, never imported');
}
console.log('identity evidence family (b) tests passed');
