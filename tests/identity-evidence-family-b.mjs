// AIR-622 / ADR 0215 (Accepted), card E3b: family (b), the Discovery history, mapped for the manifest-bound import path (src/identity-evidence-family-b.js), on the sqlite3-CLI D1
// stand-in. No Worker, R2, network or production access; every object below is synthetic and shaped like the real writers' output (`appliedIdentityDecision`,
// `appliedRevokeDecision`, the R2 action record of src/admin/discovery-recovery.js).
// Covered (ADR 0215 Table 4, decision 7): the mapping of b1 and b2 through the LIVE E2a function (same evidence key as a live row, time from `checkedAt`), b3 / b6 / b7 as counts, b4
// through the LIVE E2c planner (chronology by the history revision, unknown order and time left unknown, a recorded proposition kept when its time is invalid), b5 (terminal R2 records
// only, real shape), THE COHORT (a late history row is not re-imported through its decision, an owner action linked to a late row is late, R2 `finishedAt`, an unprovable record), the
// coherent acquisition (a generation that moves, a held authority, a backdated record), THE DEPENDENCY RULE (what a record's source pins, and what cannot be staged and is reported),
// commit-time guards (every pinned field mutated or deleted after staging fails ITS chunk as `source_moved`, with zero ledger rows and zero receipts), reconciled counts, a
// deterministic manifest, a dry run that writes nothing, and the import of the family on sqlite (four counts, replay).
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
import {appliedIdentityDecision,appliedRevokeDecision} from '../src/domain/discovery-identity-review.js';
import {loadAndSealManifest,importRun,readImportRun,readImportReport,planManifest} from '../src/identity-evidence-import.js';
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
ok(template,"UPDATE discovery_authority SET mode='d1',cutover='open',generation=5 WHERE id=1");
let n=0;
const copy=()=>{const file=path.join(root,'w-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
const BASE=Date.parse('2026-11-25T10:00:00.000Z');
const at=ms=>new Date(BASE+ms).toISOString();
const COHORT=at(0);
const WRITTEN=at(-3600000);
const envOf=file=>({DB:d1Standin(file)});
const code=expected=>error=>{assert.equal(error.code,expected,String(error?.stack||error));return true;};

// ---- fixtures ----
const OBS=i=>'film '+i+'|2000';
const hist=(i,revision,writer,payload,written=WRITTEN)=>({observation_key:OBS(i),revision,generation:1,written_at:written,writer,payload_json:JSON.stringify(payload)});
const verified=(over={})=>({status:'verified',identitySource:'tmdb_detail',tmdbId:100,checkedAt:'2026-11-01T00:00:00.000Z',...over});
const insertHistory=(file,row)=>ok(file,'INSERT INTO discovery_decision_history (observation_key,revision,generation,written_at,writer,payload_json) VALUES ('+[row.observation_key,row.revision,row.generation,row.written_at,row.writer,row.payload_json].map(lit).join(',')+')');
const insertIntent=(file,row)=>ok(file,'INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key,before_json,receipt_json,issued_json,command_json,expected_hash,expires_at,generation) VALUES ('+
 [row.idempotency_key,row.kind,row.state,row.observation_key,row.before_json??'{}',row.receipt_json,row.issued_json,row.command_json,row.expected_hash??'0'.repeat(64),row.expires_at??BASE+9000000,row.generation??1].map(lit).join(',')+')');
const ACQ={coherent:true,reason:null,acquiredAt:at(-60000),generationBefore:5,generationAfter:5,mode:'d1',cutover:'open'};
const sourcesOf=(partial={})=>({history:[],decisions:[],intents:[],r2Objects:[],counts:{observations:0,confirmedTmdbIds:0,admissions:0},acquisition:ACQ,...partial});
const manifestRows=manifest=>manifest?manifest.chunks.flatMap(chunk=>chunk.rows):[];
const plan=async(sources,over={})=>dryRunFamilyB({runId:'run-b',cohortAt:COHORT,sources,planManifest,...over});
const reconciled=coverage=>Object.values(coverage.reconciled).every(Boolean);
// An operator's cohort is its extraction: never earlier than the acquisition it read (an earlier cohort plus a later acquisition proves nothing about the earlier state).
const cohortOf=sources=>sources.acquisition.acquiredAt;
const FUTURE=()=>new Date(Date.now()+3600000).toISOString();
// A stored intent as `readFamilyBSources` selects it.
const intentRow=(id,kind,observation,{command,issued={confirmedAt:at(-1800000)},receipt})=>({idempotency_key:id,kind,state:'receipt',observation_key:observation,receipt_json:receipt===null?null:JSON.stringify(receipt),
 issued_json:issued===null?null:JSON.stringify(issued),command_json:JSON.stringify(command),expected_hash:'0'.repeat(64)});
// The decisions the real writers store for an owner action, and their receipts.
const ASSIGN_AT=at(-7200000);
const assignDecision=(tmdbId,requestId,when=ASSIGN_AT)=>appliedIdentityDecision({},{effect:'assign',tmdbId,basis:'owner check'},{at:when,requestId,programmeRunId:'prog-1'});
const rejectDecision=(tmdbId,requestId,when=at(-1800000))=>appliedIdentityDecision({status:'unresolved'},{effect:'reject',tmdbId,basis:'owner check'},{at:when,requestId,programmeRunId:'prog-1'});
const applied=async payload=>({state:'applied',decisionHash:await decisionHash(payload)});

// ===== 1. b1 / b2 / b3 / b6: one decision, through the LIVE E2a function =====
{
 const key=OBS(1);
 const b1=mapDecision(key,verified());
 assert.equal(b1.source,'tmdb_detail');assert.equal(b1.timeUnknown,false);
 assert.deepEqual(b1.input,decisionEvidenceInput(key,verified()),'the mapping IS the live E2a mapping, not a copy');
 assert.equal(b1.input.observedAt,'2026-11-01T00:00:00.000Z','the time is the payload checkedAt');
 assert.equal(b1.input.method,'tmdb_detail_check');assert.equal(b1.input.sourceScope,null);assert.equal(b1.input.sourceRoot,key);
 assert.equal(mapDecision(key,verified({identitySource:'known_epg_alias'})).input.sourceScope,'known_epg_alias');
 assert.equal(mapDecision(key,verified({identitySource:'known_alias_year_runtime'})).input.sourceScope,'known_alias_year_runtime');
 assert.equal(mapDecision(key,verified({canonicalIdentity:'tmdb_tv:5'})).input.object.kind,'tmdb_tv');
 assert.equal(mapDecision(key,verified({checkedAt:undefined})).input.observedAt,null);assert.equal(mapDecision(key,verified({checkedAt:undefined})).timeUnknown,true);
 assert.equal(mapDecision(key,verified({checkedAt:'yesterday'})).input.observedAt,null);assert.equal(mapDecision(key,verified({checkedAt:'yesterday'})).timeUnknown,true);
 assert.deepEqual(mapDecision(key,verified({identitySource:undefined})),{none:'no_identity_source'});
 assert.deepEqual(mapDecision(key,verified({identitySource:'owner'})),{none:'owner_source'});
 assert.deepEqual(mapDecision(key,verified({status:'deferred'})),{none:'not_verified'});
 assert.deepEqual(mapDecision(key,verified({tmdbId:null})),{none:'no_tmdb_id'});
 assert.deepEqual(mapDecision(key,null),{none:'payload_unreadable'});
 assert.deepEqual(mapDecision(key,verified({identitySource:'something_else'})),{none:'other_source'});
}

// ===== 2. the reconstructed key is the live key (decision 7) =====
{
 const result=await plan(sourcesOf({history:[hist(1,1,'resolver_chunk',verified())]}));
 const [row]=manifestRows(result.manifest);
 const live=await evidenceKeyOf(normalizeEvidence({origin:'live',...decisionEvidenceInput(OBS(1),verified())}));
 assert.equal(row.key,live,'a live row and the reconstructed row of one fact share a key');
 assert.equal(row.reconstructedFrom.startsWith('d1:discovery_decision_history:'),true);
 assert.equal(result.manifest.family,'b');assert.deepEqual(result.manifest.writers,['discovery_decision','discovery_owner']);
 assert.equal(row.observedAt,'2026-11-01T00:00:00.000Z');assert.notEqual(row.observedAt,WRITTEN,'never written_at');
}

// ===== 3. the dry run: b1 / b2 / b3 / b6 / b7, duplicates, late arrivals, reconciled counts, determinism =====
{
 const history=[
  hist(1,1,'resolver_chunk',verified()),
  hist(1,2,'resolver_chunk',verified({checkedAt:'2026-11-02T00:00:00.000Z'})),
  hist(2,1,'resolver_chunk',verified({identitySource:'known_epg_alias',tmdbId:200})),
  hist(3,1,'resolver_chunk',verified({identitySource:'known_alias_year_runtime',tmdbId:300})),
  hist(4,1,'resolver_chunk',verified({identitySource:undefined,tmdbId:400})),
  hist(5,1,'catalog_policy_exclude',{status:'excluded'}),
  hist(6,1,'resolver_chunk',{status:'deferred'}),
  hist(7,1,'discovery_reconsider',{status:'unresolved'}),
  hist(8,1,'resolver_chunk',verified({tmdbId:800}),at(60000)),
 ];
 const decisions=[{observation_key:OBS(11),decision_hash:'a'.repeat(64),status:'verified',payload_json:JSON.stringify(verified({identitySource:undefined,tmdbId:1100}))},
  {observation_key:OBS(12),decision_hash:'b'.repeat(64),status:'deferred',payload_json:JSON.stringify({status:'deferred'})},
  {observation_key:OBS(1),decision_hash:'c'.repeat(64),status:'verified',payload_json:JSON.stringify(verified())}];
 const sources=sourcesOf({history,decisions,counts:{observations:82004,confirmedTmdbIds:3,admissions:12536}});
 const result=await plan(sources);
 const counts=result.coverage.counts;
 assert.equal(counts.b1.pairs,1);assert.equal(counts.b2.known_epg_alias.pairs,1);assert.equal(counts.b2.known_alias_year_runtime.pairs,1);
 assert.equal(counts.b3.pairs,2,'b3 counts the history pair and the history-less current decision, each once');
 assert.equal(counts.b6.historyByWriterAndStatus['catalog_policy_exclude|excluded'],1);assert.equal(counts.b6.historyByWriterAndStatus['resolver_chunk|deferred'],1);
 assert.equal(counts.b7.observations,82004);assert.equal(counts.b7.admissions,12536);
 assert.equal(result.coverage.lateArrivals.history,1);assert.equal(result.coverage.lateArrivals.sample.history[0].observationKey,OBS(8));
 assert.equal(manifestRows(result.manifest).length,3,'b3, b6, b7 and the late arrival give none');
 assert.equal(result.report.duplicates.length,1);
 assert.equal(manifestRows(result.manifest)[0].observedAt,'2026-11-01T00:00:00.000Z','the earliest revision owns the key');
 // Every source row is in exactly one disposition, and they add up to what was read (current decisions included, not only the history).
 assert.equal(reconciled(result.coverage),true);
 assert.deepEqual(result.coverage.dispositions.history,{late:1,mapped:4,'no_row:no_identity_source':1,'no_row:non_identity_writer':2,'no_row:not_verified':1});
 assert.deepEqual(result.coverage.dispositions.decisions,{history_present:1,'no_row:no_identity_source':1,'no_row:not_verified':1});
 assert.equal(result.coverage.counts.currentDecisionsWithHistory.count,1);
 const shuffled=await plan(sourcesOf({history:[...history].reverse(),decisions:[...decisions].reverse(),counts:sources.counts}));
 assert.equal(shuffled.digest,result.digest);
 assert.equal(manifestRows(result.manifest).every(row=>row.route==='discovery_scan'&&row.polarity==='asserts'),true);
}

// ===== 4. b4: owner actions through the LIVE E2c planner; what one source can pin is staged, the rest is reported =====
{
 const assignPayload=assignDecision('111','intent-assign');
 const rejectPayload=rejectDecision('222','intent-reject');
 const history=[hist(1,1,'resolver_chunk',verified({tmdbId:100})),hist(1,2,'discovery_identity_correct',assignPayload),hist(2,1,'discovery_identity_correct',rejectPayload)];
 const intents=[
  intentRow('intent-assign','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'111',basis:'owner check'},receipt:await applied(assignPayload)}),           // linked: staged from its history row
  intentRow('intent-reject','identity_reject',OBS(2),{command:{effect:'reject',tmdbId:'222',basis:'owner check'},receipt:await applied(rejectPayload)}),          // linked reject: two source rows, unresolved
  intentRow('intent-reject-2','identity_reject',OBS(3),{command:{effect:'reject',tmdbId:'333'},receipt:{state:'applied',decisionHash:'f'.repeat(64)}}),             // unlinked: staged from its intent
  intentRow('intent-revoke','identity_revoke',OBS(4),{command:{effect:'revoke',revokes:{requestId:'intent-assign-4',effect:'assign',tmdbId:'444'}},receipt:{state:'applied',decisionHash:'e'.repeat(64)}}),
  intentRow('intent-assign-5','identity_assign',OBS(5),{command:{effect:'assign',tmdbId:'555'},receipt:{state:'applied',decisionHash:'d'.repeat(64)}}),               // unlinked assign: no recorded time
 ];
 const result=await plan(sourcesOf({history,intents}));
 const owner=manifestRows(result.manifest).filter(row=>row.route==='owner_action');
 const byRoot=Object.fromEntries(owner.map(row=>[row.sourceRoot,row]));
 // The linked assign: asserts, root = the intent key, time = ownerIdentity.at, source_order = the revision of its history row (2), the live key, sourced from the history row.
 const assign=byRoot['intent-assign'];
 assert.equal(assign.polarity,'asserts');assert.equal(assign.observedAt,ASSIGN_AT);assert.equal(assign.sourceOrder,2);
 assert.equal(assign.key,await ownerRowKey({key:OBS(1),effect:'assign',tmdbId:'111',requestId:'intent-assign'}),'the live key');
 assert.equal(assign.reconstructedFrom.startsWith('d1:discovery_decision_history:'),true);
 // The linked reject consumes two rows (the intent for the movie and the time, the history row for the order): not staged, reported, never imported with a guessed order.
 assert.equal(byRoot['intent-reject'],undefined);
 assert.deepEqual(result.coverage.unresolved.ownerActionsUnbound,{reject:1});assert.equal(result.coverage.dispositions.intents['unbound:reject'],1);
 // An unlinked reject: its intent is its only source; movie and time come from the intent, the order is unknown.
 const reject=byRoot['intent-reject-2'];
 assert.equal(reject.polarity,'refutes');assert.equal(reject.observedAt,at(-1800000));assert.equal(reject.sourceOrder,null);
 assert.equal(reject.key,await ownerRowKey({key:OBS(3),effect:'reject',tmdbId:'333',requestId:'intent-reject-2'}));
 assert.equal(reject.reconstructedFrom.startsWith('d1:discovery_intent:'),true);
 // An unlinked revoke: a scoped refutation naming the exact key of the revoked assign (a forward reference), order unknown.
 const revoke=byRoot['intent-revoke'];
 assert.equal(revoke.polarity,'refutes');assert.equal(revoke.sourceOrder,null);
 assert.equal(revoke.scopeEvidenceKey,await ownerRowKey({key:OBS(4),effect:'assign',tmdbId:'444',requestId:'intent-assign-4'}));
 // An unlinked assign: no history row, no recorded time (its time is ownerIdentity.at, never inferred), order unknown.
 assert.equal(byRoot['intent-assign-5'].observedAt,null);assert.equal(byRoot['intent-assign-5'].sourceOrder,null);
 const b4=result.coverage.counts.b4;
 assert.equal(b4.actions,5);assert.equal(b4.linkedAssigns,1);assert.equal(b4.unlinked,3);assert.equal(b4.orderUnknown,3);assert.equal(b4.timeUnknown,1);
 assert.equal(result.coverage.complete,false,'an unresolved owner action is never presented as complete coverage');
 assert.equal(reconciled(result.coverage),true);
 // The owner history rows are never read as E2a decisions: the assign payload carries identitySource 'owner'.
 assert.equal(manifestRows(result.manifest).filter(row=>row.route==='discovery_scan').length,1);
}

// ===== 4b. a replacement: its own row is staged, its scoped withdrawal (which reads the superseded intent) is reported =====
{
 const firstPayload=assignDecision('100','intent-1',at(-9000000)),secondPayload=assignDecision('200','intent-2',at(-8000000));
 const history=[hist(1,1,'discovery_identity_correct',firstPayload),hist(1,2,'discovery_identity_correct',secondPayload)];
 const intents=[
  intentRow('intent-1','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'100'},receipt:await applied(firstPayload)}),
  intentRow('intent-2','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'200',supersedes:{requestId:'intent-1',decisionHash:await decisionHash(firstPayload)}},receipt:await applied(secondPayload)}),
 ];
 const result=await plan(sourcesOf({history,intents}));
 const owner=manifestRows(result.manifest).filter(row=>row.route==='owner_action');
 assert.equal(owner.length,2,'intent-1 and intent-2; the scoped withdrawal of intent-1 consumes a second intent and is not staged');
 assert.equal(owner.find(row=>row.sourceRoot==='intent-2').sourceOrder,2);
 assert.equal(result.coverage.unresolved.ownerWithdrawalsUnbound,1);assert.equal(result.coverage.complete,false);
 // Chronology is the history revision, not the clock: reversing the input and the history order changes nothing.
 const reversed=await plan(sourcesOf({history:[...history].reverse(),intents:[...intents].reverse()}));
 assert.equal(reversed.digest,result.digest);
}

// ===== 4c. an unknown time does not drop a recorded proposition; a placeholder is never stored =====
{
 const badAssign=assignDecision('111','intent-bad-at','not a time');
 const history=[hist(1,1,'discovery_identity_correct',badAssign)];
 const intents=[
  intentRow('intent-bad-at','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'111'},receipt:await applied(badAssign)}),                       // linked, invalid ownerIdentity.at
  intentRow('intent-no-time','identity_reject',OBS(2),{command:{effect:'reject',tmdbId:'222'},issued:{},receipt:{state:'applied',decisionHash:'1'.repeat(64)}}),   // unlinked, no confirmedAt
  intentRow('intent-bad-time','identity_reject',OBS(3),{command:{effect:'reject',tmdbId:'333'},issued:{confirmedAt:'soon'},receipt:{state:'applied',decisionHash:'2'.repeat(64)}}),
  intentRow('intent-revoke-time','identity_revoke',OBS(4),{command:{effect:'revoke',revokes:{requestId:'r',effect:'assign',tmdbId:'444'}},issued:null,receipt:{state:'applied',decisionHash:'3'.repeat(64)}}),
 ];
 const result=await plan(sourcesOf({history,intents}));
 const owner=manifestRows(result.manifest).filter(row=>row.route==='owner_action');
 assert.equal(owner.length,4,'every recorded proposition is kept with an unknown time');
 assert.equal(owner.every(row=>row.observedAt===null),true,'the unknown time is null, never the planner placeholder');
 assert.equal(JSON.stringify(result.manifest).includes('1970-01-01'),false,'no placeholder reaches the manifest');
 assert.equal(result.coverage.counts.b4.timeUnknown,4);assert.equal(reconciled(result.coverage),true);
 // Without a proven acquisition covering the cohort, a record with no valid time is NOT guessed into it: it is unprovable and reported.
 const unproven=await plan(sourcesOf({history,intents,acquisition:undefined}),{unfenced:true});
 assert.equal(manifestRows(unproven.manifest).filter(row=>row.route==='owner_action').length,1,'only the assign linked to a history row with a valid written_at is provably in the cohort');
 assert.equal(unproven.coverage.dispositions.intents.cohort_unprovable,3);assert.equal(unproven.coverage.dispositions.history.cohort_unprovable===undefined,true,'the history row has a valid written_at');
 assert.equal(unproven.coverage.complete,false);
}

// ===== 5. b5: pre-D1 R2 actions, in their real shape (src/admin/discovery-recovery.js) =====
{
 const KEYED=i=>OBS(i);
 const record=(id,over={})=>({schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:id,state:'succeeded',issued:{confirmedAt:at(-5000000)},command:{effect:'reject',tmdbId:'555',basis:'owner check'},
  provenance:{actor:'owner',authority:'cloudflare_access',observationKey:KEYED(9)},afterImage:{resolutionEtag:null,decisionHash:'a'.repeat(64),decision:{}},finishedAt:at(-4000000),
  receipt:{state:'succeeded',counts:{written:1},outcomes:[{id:KEYED(9),outcome:'written'}],audit:{actor:'owner',confirmedAt:at(-5000000)}},...over});
 const object=(id,rec,etag='etag-'+id)=>({key:R2_ACTION_PREFIX+id+'.json',etag,record:rec});
 const assignRec=record('r2-assign',{command:{effect:'assign',tmdbId:'666'},afterImage:{resolutionEtag:null,decisionHash:'b'.repeat(64),decision:assignDecision('666','r2-assign',at(-4500000))}});
 const objects=[
  object('r2-reject',record('r2-reject')),
  object('r2-assign',assignRec),
  object('r2-assign-notime',record('r2-assign-notime',{command:{effect:'assign',tmdbId:'777'}})),                               // no afterImage ownerIdentity: unknown time
  object('r2-assign-other',record('r2-assign-other',{command:{effect:'assign',tmdbId:'888'},afterImage:{decision:assignDecision('999','r2-assign-other')}})),   // another movie: not this action's time
  object('r2-bad-confirm',record('r2-bad-confirm',{issued:{confirmedAt:'x'}})),                                                 // malformed time: kept, time unknown
  object('r2-failed',record('r2-failed',{state:'failed',receipt:{state:'failed',outcomes:[{id:KEYED(9),outcome:'failed'}]}})),
  object('r2-noobs',record('r2-noobs',{provenance:{}})),
  object('r2-nomovie',record('r2-nomovie',{command:{effect:'assign'}})),
  object('r2-mismatch',record('other-key')),
  object('r2-shape',{schemaVersion:9}),
  object('r2-late',record('r2-late',{finishedAt:at(60000)})),
  object('r2-nofinish',record('r2-nofinish',{finishedAt:null})),                                                            // untimed: in the cohort only through the frozen R2 listing
  {key:'admin/actions/other/v1/x.json',etag:'e',record:{}},
 ];
 assert.deepEqual(r2Action(objects[5]),{none:'not_terminal'});assert.deepEqual(r2Action(objects[6]),{none:'observation_not_stated'});assert.deepEqual(r2Action(objects[7]),{none:'movie_not_stated'});
 assert.deepEqual(r2Action(objects[8]),{none:'key_mismatch'});assert.deepEqual(r2Action(objects[9]),{none:'unknown_shape'});assert.deepEqual(r2Action(objects[12]),{none:'not_an_action_object'});
 const LISTING={complete:true,listedAt:at(-30000),objects:objects.map(item=>({key:item.key,etag:item.etag}))};
 // The D1 acquisition is coherent (ACQ), but it says nothing about R2: with no frozen R2 listing the untimed record is unprovable, and the census is not complete.
 const refused=await plan(sourcesOf({r2Objects:objects}));
 assert.equal(refused.manifest,null);assert.equal(refused.report.excluded.filter(item=>item.reason==='r2_residual_not_accepted').length,5);
 assert.equal(refused.coverage.dispositions.r2.cohort_unprovable,1,'a D1 acquisition flag cannot prove an R2 object into the cohort');
 assert.equal(refused.coverage.acquisition.r2.established,false);assert.equal(refused.coverage.complete,false);
 const accepted=await plan(sourcesOf({r2Objects:objects,r2Acquisition:LISTING}),{acceptR2Residual:true});
 const byRoot=Object.fromEntries(manifestRows(accepted.manifest).map(row=>[row.sourceRoot,row]));
 assert.equal(byRoot['r2-reject'].observedAt,at(-5000000));assert.equal(byRoot['r2-reject'].sourceOrder,null,'no history revision in R2: the order is unknown');
 assert.equal(byRoot['r2-assign'].observedAt,at(-4500000),'the time of an R2 assign is afterImage.decision.ownerIdentity.at when it names this action and movie');
 assert.equal(byRoot['r2-assign-notime'].observedAt,null);assert.equal(byRoot['r2-assign-other'].observedAt,null,'another movie\'s ownerIdentity is never used');
 assert.equal(byRoot['r2-bad-confirm'].observedAt,null,'a malformed time keeps the recorded proposition with an unknown time');
 assert.equal(byRoot['r2-reject'].key,await ownerRowKey({key:KEYED(9),effect:'reject',tmdbId:'555',requestId:'r2-reject'}));
 assert.deepEqual(accepted.coverage.dispositions.r2,{late:1,mapped:6,'ineligible:key_mismatch':1,'ineligible:movie_not_stated':1,'ineligible:not_an_action_object':1,'ineligible:not_terminal':1,'ineligible:observation_not_stated':1,'ineligible:unknown_shape':1});
 assert.equal(accepted.coverage.counts.b5.eligible,6,'the record with no finishedAt is in the cohort through the frozen R2 listing that names it');
 assert.equal(accepted.coverage.acquisition.r2.established,true);
 assert.equal(reconciled(accepted.coverage),true);
 // Only a listing that names the object and its ETag counts: an object missing from the frozen listing, or with another ETag, is unresolved. A listing listed AFTER the cohort proves nothing about it.
 const partial=await plan(sourcesOf({r2Objects:objects,r2Acquisition:{...LISTING,objects:LISTING.objects.filter(item=>item.key!==objects[0].key).map(item=>item.key===objects[1].key?{...item,etag:'other'}:item)}}),{acceptR2Residual:true});
 assert.equal(partial.coverage.dispositions.r2.not_in_frozen_listing,2);assert.equal(partial.coverage.unresolved.r2NotInFrozenListing,2);assert.equal(partial.coverage.complete,false);
 const afterCohort=await plan(sourcesOf({r2Objects:objects,r2Acquisition:{...LISTING,listedAt:at(60000)}}),{acceptR2Residual:true});
 assert.equal(afterCohort.coverage.dispositions.r2.cohort_unprovable,1,'a listing made after the cohort cannot prove an earlier state');
 const incomplete=await plan(sourcesOf({r2Objects:objects,r2Acquisition:{...LISTING,complete:false}}),{acceptR2Residual:true});
 assert.equal(incomplete.coverage.acquisition.r2.established,false);assert.equal(incomplete.coverage.dispositions.r2.cohort_unprovable,1);
 // A D1 intent and an R2 object of one action give one key: the D1 record (first in manifest order) owns it, the R2 record is a reported duplicate.
 const intent=intentRow('r2-reject','identity_reject',KEYED(9),{command:{effect:'reject',tmdbId:'555'},issued:{confirmedAt:at(-5000000)},receipt:{state:'applied',decisionHash:'9'.repeat(64)}});
 const both=await plan(sourcesOf({intents:[intent],r2Objects:[objects[0]],r2Acquisition:{complete:true,listedAt:at(-30000),objects:[{key:objects[0].key,etag:objects[0].etag}]}}),{acceptR2Residual:true});
 assert.equal(manifestRows(both.manifest).length,1);assert.equal(both.report.duplicates.length,1);
}

// ===== 6. the cohort: the fallbacks cannot bypass it =====
{
 const payload=verified({tmdbId:700});
 const decisionRow=async(i,p)=>({observation_key:OBS(i),decision_hash:await decisionHash(p),status:p.status,tmdb_id:p.tmdbId,media_kind:'movie',payload_json:JSON.stringify(p)});
 // (a) A late history row plus the current decision of the same pair: the decision is NOT imported through the fallback.
 const lateOnly=await plan(sourcesOf({history:[hist(7,1,'resolver_chunk',payload,at(60000))],decisions:[await decisionRow(7,payload)]}));
 assert.equal(lateOnly.manifest,null,'nothing is eligible: the post-cohort state is reported, not imported');
 assert.equal(lateOnly.coverage.dispositions.history.late,1);assert.equal(lateOnly.coverage.dispositions.decisions.history_present,1);assert.equal(lateOnly.coverage.lateArrivals.history,1);
 assert.equal(reconciled(lateOnly.coverage),true);
 // (b) A decision with an earlier history row AND a late one: only the earlier history row maps; the decision (post-cohort state) is not used.
 const mixed=await plan(sourcesOf({history:[hist(7,1,'resolver_chunk',payload),hist(7,2,'resolver_chunk',verified({tmdbId:701}),at(60000))],decisions:[await decisionRow(7,verified({tmdbId:701}))]}));
 assert.deepEqual(manifestRows(mixed.manifest).map(row=>row.objectValue),['700']);
 // (c) A genuinely history-less R2-era decision is imported through its decision row, and is distinguished from (a).
 const historyLess=await plan(sourcesOf({decisions:[await decisionRow(7,payload)]}));
 assert.equal(manifestRows(historyLess.manifest).length,1);assert.equal(manifestRows(historyLess.manifest)[0].reconstructedFrom.startsWith('d1:discovery_decision:'),true);
 // (d) An owner action linked ONLY to a late history row is late: it is not reinterpreted as an unlinked, unknown-order action.
 const assignPayload=assignDecision('111','intent-late');
 const intent=intentRow('intent-late','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'111'},receipt:await applied(assignPayload)});
 const lateLink=await plan(sourcesOf({history:[hist(1,1,'discovery_identity_correct',assignPayload,at(60000))],intents:[intent]}));
 assert.equal(lateLink.manifest,null);assert.equal(lateLink.coverage.dispositions.intents.late,1);assert.equal(lateLink.coverage.lateArrivals.intents,1);
 assert.equal(lateLink.coverage.counts.b4.timeUnknown,0,'not imported with a null order');
 // (e) An unlinked intent confirmed after the cohort is late; a backdated history row is judged by its own written_at.
 const lateIntent=intentRow('intent-later','identity_reject',OBS(2),{command:{effect:'reject',tmdbId:'222'},issued:{confirmedAt:at(60000)},receipt:{state:'applied',decisionHash:'4'.repeat(64)}});
 assert.equal((await plan(sourcesOf({intents:[lateIntent]}))).coverage.dispositions.intents.late,1);
 // (f) A history row with no valid time and no proven acquisition is unprovable (reported, unresolved), never guessed.
 const noTime=await plan(sourcesOf({history:[{...hist(7,1,'resolver_chunk',payload),written_at:'garbage'}],acquisition:undefined}),{unfenced:true});
 assert.equal(noTime.coverage.dispositions.history.cohort_unprovable,1);assert.equal(noTime.coverage.unresolved.cohortUnprovable,1);assert.equal(noTime.manifest,null);
}

// ===== 6b. links and decisions are never certified from absence =====
{
 const assignPayload=assignDecision('111','intent-link');
 const intent=intentRow('intent-link','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'111'},receipt:await applied(assignPayload)});
 // (a) The matching history row has no provable time (and no acquisition proves it): the action is NOT staged as an unlinked, unknown-order action.
 const unprovable=await plan(sourcesOf({history:[{...hist(1,1,'discovery_identity_correct',assignPayload),written_at:'garbage'}],intents:[intent],acquisition:undefined}),{unfenced:true});
 assert.equal(unprovable.coverage.dispositions.intents.link_unprovable,1);assert.equal(unprovable.coverage.unresolved.linkUnprovable,1);assert.equal(unprovable.coverage.counts.b4.unlinked,0);
 assert.equal(manifestRows(unprovable.manifest).length,0,'no false null-order action');
 // (b) Two history rows carry the receipt's hash: ambiguous, not "no history".
 const ambiguous=await plan(sourcesOf({history:[hist(1,1,'discovery_identity_correct',assignPayload),hist(1,2,'discovery_identity_correct',assignPayload)],intents:[intent]}));
 assert.equal(ambiguous.coverage.dispositions.intents.link_ambiguous,1);assert.equal(ambiguous.coverage.unresolved.linkAmbiguous,1);assert.equal(ambiguous.coverage.counts.b4.unlinked,0);
 assert.equal(manifestRows(ambiguous.manifest).filter(row=>row.sourceRoot==='intent-link').length,0);
 // (c) A late link is late (covered above); only a hash that NO owner row carries is "history-less" and may keep a null order.
 const none=await plan(sourcesOf({history:[hist(1,1,'discovery_identity_correct',assignDecision('222','other-intent'))],intents:[intent]}));
 assert.equal(none.coverage.counts.b4.unlinked,1);
 // (d) A mutable current decision is frozen as read: without the coherent D1 acquisition it is unprovable.
 const payload=verified({tmdbId:700});
 const decisionRow={observation_key:OBS(7),decision_hash:await decisionHash(payload),status:'verified',payload_json:JSON.stringify(payload)};
 const unfencedDecision=await plan(sourcesOf({decisions:[decisionRow],acquisition:undefined}),{unfenced:true});
 assert.equal(unfencedDecision.coverage.dispositions.decisions.cohort_unprovable,1);assert.equal(manifestRows(unfencedDecision.manifest).length,0);
 // (e) An owner-writer history row no intent names: an assign is fully recorded in it and is staged from it (order = revision); a reject cannot be read without its intent and is unresolved.
 const orphans=await plan(sourcesOf({history:[hist(1,1,'discovery_identity_correct',assignDecision('111','orphan-assign')),hist(2,1,'discovery_identity_correct',rejectDecision('222','orphan-reject'))]}));
 assert.equal(orphans.coverage.counts.b4.historyOnlyAssigns,1);assert.equal(orphans.coverage.unresolved.unlinkedOwnerHistory,1);
 assert.equal(manifestRows(orphans.manifest).find(row=>row.sourceRoot==='orphan-assign').sourceOrder,1);
}

// ===== 6c. `complete` is not `reconciled`: it needs every eligible proposition staged and both acquisitions =====
{
 const base=()=>({history:[hist(1,1,'resolver_chunk',verified())],r2Acquisition:{complete:true,listedAt:at(-30000),objects:[]}});
 const complete=await plan(sourcesOf(base()));
 assert.equal(complete.coverage.complete,true);assert.equal(complete.coverage.unresolvedCount,0);assert.deepEqual(complete.coverage.manifest,{conflicts:0,excluded:0,duplicates:0});
 // Each of these keeps `complete` false although every source row is accounted for (`reconciled` stays true).
 const cases={
  'no R2 acquisition':sourcesOf({history:base().history}),
  'an unresolved owner history row':sourcesOf({...base(),history:[...base().history,hist(2,1,'discovery_identity_correct',rejectDecision('222','orphan-reject'))]}),
  'a guard that cannot be pinned':sourcesOf({...base(),history:[hist(3,1,'resolver_chunk',verified({id:{nested:true}}))]}),
  'an eligible proposition the model refuses':sourcesOf({...base(),history:[hist(4,1,'discovery_identity_correct',assignDecision('1','x'))],intents:[intentRow('x','identity_assign',OBS(4),{command:{effect:'assign',tmdbId:'abc'},receipt:{state:'applied',decisionHash:'1'.repeat(64)}})]}),
 };
 for(const [name,sources] of Object.entries(cases)){
  const result=await plan(sources);
  assert.equal(result.coverage.complete,false,name);assert.equal(reconciled(result.coverage),true,name+': reconciled is not complete');
 }
 // A manifest conflict (two sources, one key, different identity) and an R2 record the owner has not accepted: eligible propositions that did not reach the manifest.
 const assign=assignDecision('111','same-key');
 const r2=(key,rec)=>({key:R2_ACTION_PREFIX+key+'.json',etag:'e-'+key,record:rec});
 const rec={schemaVersion:1,kind:'discovery_identity_action',idempotencyKey:'same-key',state:'succeeded',issued:{confirmedAt:at(-5000000)},command:{effect:'assign',tmdbId:'111'},provenance:{observationKey:OBS(1)},
  afterImage:{decision:assign},finishedAt:at(-4000000),receipt:{state:'succeeded',outcomes:[{id:OBS(1),outcome:'written'}]}};
 const withR2={...base(),history:[hist(1,1,'discovery_identity_correct',assign)],r2Objects:[r2('same-key',rec)],r2Acquisition:{complete:true,listedAt:at(-30000),objects:[{key:R2_ACTION_PREFIX+'same-key.json',etag:'e-same-key'}]}};
 const conflict=await plan(sourcesOf(withR2),{acceptR2Residual:true});
 assert.equal(conflict.coverage.manifest.conflicts,1,'the history row (order 1) and the R2 record (order unknown) disagree on one key');assert.equal(conflict.coverage.complete,false);
 const notAccepted=await plan(sourcesOf(withR2));
 assert.equal(notAccepted.coverage.manifest.excluded>0,true);assert.equal(notAccepted.coverage.complete,false);
}

// ===== 7. the acquisition is fenced by the Discovery authority =====
{
 const file=copy();
 insertHistory(file,hist(1,1,'resolver_chunk',verified()));
 const db=d1Standin(file);
 const coherent=await readFamilyBSources(db);
 assert.equal(coherent.acquisition.coherent,true);assert.equal(coherent.acquisition.generationBefore,5);assert.equal(coherent.acquisition.generationAfter,5);assert.equal(typeof coherent.acquisition.acquiredAt,'string');
 // A Discovery write while the tables are paged (the generation moves): incoherent, and the dry run REFUSES to certify a manifest.
 const moving=copy();insertHistory(moving,hist(1,1,'resolver_chunk',verified()));
 const movingDb=d1Standin(moving);let bumped=false;
 const watched={prepare:sql=>{if(!bumped&&/FROM discovery_decision /.test(sql)){bumped=true;ok(moving,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}return movingDb.prepare(sql);},batch:movingDb.batch.bind(movingDb)};
 const incoherent=await readFamilyBSources(watched);
 assert.equal(incoherent.acquisition.coherent,false);assert.equal(incoherent.acquisition.reason,'generation_moved');
 const refused=await dryRunFamilyB({runId:'run-x',cohortAt:COHORT,sources:incoherent,planManifest});
 assert.equal(refused.manifest,null);assert.equal(refused.digest,null);assert.equal(refused.report.disposition,'acquisition_not_coherent');assert.equal(refused.coverage.complete,false);
 // A record backdated during the acquisition (its own written_at is old, but a Discovery write moved the generation) is caught by the same fence.
 const backdate=copy();insertHistory(backdate,hist(1,1,'resolver_chunk',verified()));
 const backdateDb=d1Standin(backdate);let inserted=false;
 const backdated={prepare:sql=>{if(!inserted&&/FROM discovery_intent /.test(sql)){inserted=true;insertHistory(backdate,hist(2,1,'resolver_chunk',verified({tmdbId:200}),at(-86400000)));ok(backdate,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}return backdateDb.prepare(sql);},batch:backdateDb.batch.bind(backdateDb)};
 assert.equal((await readFamilyBSources(backdated)).acquisition.reason,'generation_moved');
 // A held or not-d1 authority is not a coherent source either.
 const held=copy();ok(held,"UPDATE discovery_authority SET cutover='held' WHERE id=1");
 assert.equal((await readFamilyBSources(d1Standin(held))).acquisition.reason,'authority_not_open');
 const r2=copy();ok(r2,"UPDATE discovery_authority SET mode='r2' WHERE id=1");
 assert.equal((await readFamilyBSources(d1Standin(r2))).acquisition.reason,'authority_not_open');
 // No acquisition proof at all (a caller-supplied source): refused unless the caller states it is unfenced.
 const none=await dryRunFamilyB({runId:'run-y',cohortAt:COHORT,sources:{...sourcesOf({history:[hist(1,1,'resolver_chunk',verified())]}),acquisition:undefined},planManifest});
 assert.equal(none.manifest,null);assert.equal(none.report.disposition,'acquisition_not_coherent');
}

// ===== 8. reading the sources is SELECT only, and the whole family imports on sqlite =====
const activate=async env=>{
 const set=(writer,kind,generation,extra={})=>changeWriter(env,{writer,kind,expectedGeneration:generation,reason:'test',deployedVersion:'abc',evidenceLink:'https://example.test/e',now:at(1100+generation),...extra});
 await set('discovery_decision','activate',0);await set('discovery_decision','drain_complete',1,{drainEvidence:'drained'});
 await set('discovery_owner','activate',0);await set('discovery_owner','drain_complete',1,{drainEvidence:'drained'});
};
{
 const file=copy();
 const assignPayload=assignDecision('111','intent-assign');
 insertHistory(file,hist(1,1,'resolver_chunk',verified()));
 insertHistory(file,hist(2,1,'resolver_chunk',verified({identitySource:'known_epg_alias',tmdbId:200})));
 insertHistory(file,hist(3,1,'resolver_chunk',verified({identitySource:undefined,tmdbId:300})));
 insertHistory(file,hist(4,1,'discovery_identity_correct',assignPayload));
 insertHistory(file,hist(5,1,'resolver_chunk',verified({tmdbId:500}),FUTURE()));
 insertIntent(file,{...intentRow('intent-assign','identity_assign',OBS(4),{command:{effect:'assign',tmdbId:'111'},receipt:await applied(assignPayload)})});
 insertIntent(file,{...intentRow('intent-reject','identity_reject',OBS(6),{command:{effect:'reject',tmdbId:'666'},receipt:{state:'applied',decisionHash:'f'.repeat(64)}})});
 insertIntent(file,{idempotency_key:'intent-pending',kind:'identity_assign',state:'approved',observation_key:OBS(7),receipt_json:null,issued_json:JSON.stringify({}),command_json:JSON.stringify({effect:'assign',tmdbId:'1'})});
 const statements=[];
 const db=d1Standin(file);
 const watched={prepare:sql=>{statements.push(sql);return db.prepare(sql);},batch:db.batch.bind(db)};
 const sources=await readFamilyBSources(watched,{pageSize:2});
 assert.equal(statements.length>0,true);assert.equal(statements.every(sql=>/^SELECT /.test(sql)),true,'the extraction only SELECTs: '+statements.filter(sql=>!/^SELECT /.test(sql)));
 assert.equal(sources.history.length,5);assert.equal(sources.intents.length,2,'only identity intents with a receipt');assert.equal(sources.acquisition.coherent,true);
 const result=await dryRunFamilyB({runId:'run-b',cohortAt:cohortOf(sources),sources,planManifest});
 assert.equal(result.coverage.lateArrivals.history,1);assert.equal(reconciled(result.coverage),true);
 assert.equal(manifestRows(result.manifest).length,4,'b1, b2, the linked owner assign and the unlinked owner reject; b3 and the late arrival give nothing');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0,'the dry run wrote nothing');
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 await activate(env);
 const done=await importRun(env,{runId:'run-b',approvedDigest:result.digest,owner:'operator-a',now:at(2000)});
 assert.equal(done.state,'complete');
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),4);
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE origin='reconstruction' AND reconstruction_run='run-b'"),4);
 const report=await readImportReport(env,'run-b');
 const totals=report.receipts.reduce((total,item)=>({inserted:total.inserted+item.inserted,already:total.already+item.alreadyImported,live:total.live+item.liveCovered,equal:total.equal+item.reconstructedEquivalent}),{inserted:0,already:0,live:0,equal:0});
 assert.equal(totals.inserted+totals.already+totals.live+totals.equal,4,'the four counts add up to the staged keys');assert.equal(totals.inserted,4);
 assert.equal(one(file,"SELECT source_order FROM film_identity_evidence WHERE route='owner_action' AND polarity='asserts'"),1,'the linked assign carries the history revision');
 assert.equal(one(file,"SELECT source_order FROM film_identity_evidence WHERE route='owner_action' AND polarity='refutes'"),null,'the unlinked reject has an unknown order');
 assert.equal(one(file,"SELECT COUNT(*) FROM film_identity_evidence WHERE observed_at LIKE '1970-%'"),0,'no placeholder time is stored');
 // A cohort EARLIER than the acquisition that read the mutable rows proves nothing about the earlier state: the unlinked receipt is unprovable, never imported on the strength of a later read.
 const earlier=await dryRunFamilyB({runId:'run-early',cohortAt:COHORT,sources,planManifest});
 assert.equal(earlier.coverage.dispositions.intents.cohort_unprovable,1);assert.equal(earlier.coverage.complete,false);
 assert.equal(manifestRows(earlier.manifest).some(row=>row.sourceRoot==='intent-reject'),false);
 const again=await dryRunFamilyB({runId:'run-b2',cohortAt:cohortOf(sources),sources,planManifest});
 await loadAndSealManifest(env,{manifest:again.manifest,approvedDigest:again.digest,now:at(3000)});
 await importRun(env,{runId:'run-b2',approvedDigest:again.digest,owner:'operator-a',now:at(4000)});
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),4,'no duplicate rows');
}

// ===== 9. commit-time guards: every pinned dependency, mutated or deleted after staging, fails ITS chunk =====
// Each case stages a manifest on its own database, changes ONE field the mapping consumed (or deletes the source), and the import must stop as `source_moved` with zero ledger rows
// and zero receipts: not a broad exception, and not an import of stale evidence.
const mutation=async(name,seed,change)=>{
 const file=copy();
 await seed(file);
 const sources=await readFamilyBSources(d1Standin(file));
 const result=await dryRunFamilyB({runId:'run-m',cohortAt:cohortOf(sources),sources,planManifest});
 assert.ok(result.manifest,name+': a manifest exists before the change');
 const env=envOf(file);
 await loadAndSealManifest(env,{manifest:result.manifest,approvedDigest:result.digest,now:at(1000)});
 await activate(env);
 ok(file,change);
 await assert.rejects(()=>importRun(env,{runId:'run-m',approvedDigest:result.digest,owner:'operator-a',now:at(2000)}),code('identity_evidence_import_source_moved'),name);
 const run=await readImportRun(env,'run-m');
 assert.deepEqual([run.state,run.stopReason],['stopped','source_moved'],name);
 assert.equal(one(file,'SELECT COUNT(*) FROM film_identity_evidence'),0,name+': no ledger row');
 assert.equal(one(file,'SELECT COUNT(*) FROM identity_evidence_import_receipt'),0,name+': no receipt');
};
{
 const lit2=lit;
 // b1: the decision payload fields the mapping reads.
 const seedB1=async file=>insertHistory(file,hist(1,1,'resolver_chunk',verified()));
 await mutation('b1 tmdbId',seedB1,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.tmdbId',999)");
 await mutation('b1 identitySource',seedB1,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.identitySource','known_epg_alias')");
 await mutation('b1 checkedAt',seedB1,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.checkedAt','2026-01-01T00:00:00.000Z')");
 await mutation('b1 deleted',seedB1,'DELETE FROM discovery_decision_history');
 // A linked assign: staged from its history row, which pins ownerIdentity.{effect,tmdbId,requestId,at} and the revision.
 const assignPayload=assignDecision('111','intent-assign');
 const seedAssign=async file=>{insertHistory(file,hist(1,1,'discovery_identity_correct',assignPayload));insertIntent(file,intentRow('intent-assign','identity_assign',OBS(1),{command:{effect:'assign',tmdbId:'111'},receipt:await applied(assignPayload)}));};
 await mutation('assign ownerIdentity.at',seedAssign,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.at','2026-01-01T00:00:00.000Z')");
 await mutation('assign ownerIdentity.tmdbId',seedAssign,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.tmdbId','999')");
 await mutation('assign ownerIdentity.requestId',seedAssign,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.requestId','other')");
 await mutation('assign ownerIdentity.effect',seedAssign,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.effect','reject')");
 await mutation('assign history deleted',seedAssign,'DELETE FROM discovery_decision_history');
 await mutation('assign writer',seedAssign,"UPDATE discovery_decision_history SET writer='owner'");
 // An unlinked reject: staged from its intent, which pins every field consumed and the receipt association.
 const seedReject=async file=>insertIntent(file,intentRow('intent-reject','identity_reject',OBS(2),{command:{effect:'reject',tmdbId:'222'},receipt:{state:'applied',decisionHash:'f'.repeat(64)}}));
 await mutation('reject command.tmdbId',seedReject,"UPDATE discovery_intent SET command_json=json_set(command_json,'$.tmdbId','999')");
 await mutation('reject command.effect',seedReject,"UPDATE discovery_intent SET command_json=json_set(command_json,'$.effect','assign')");
 await mutation('reject issued.confirmedAt',seedReject,"UPDATE discovery_intent SET issued_json=json_set(issued_json,'$.confirmedAt','2026-01-01T00:00:00.000Z')");
 await mutation('reject receipt.decisionHash',seedReject,"UPDATE discovery_intent SET receipt_json=json_set(receipt_json,'$.decisionHash','"+'0'.repeat(64)+"')");
 await mutation('reject state',seedReject,"UPDATE discovery_intent SET state='running'");
 await mutation('reject deleted',seedReject,'DELETE FROM discovery_intent');
 // An unlinked revoke: the nested `revokes.*` references are pinned.
 const seedRevoke=async file=>insertIntent(file,intentRow('intent-revoke','identity_revoke',OBS(4),{command:{effect:'revoke',revokes:{requestId:'intent-assign-4',effect:'assign',tmdbId:'444'}},receipt:{state:'applied',decisionHash:'e'.repeat(64)}}));
 await mutation('revoke revokes.tmdbId',seedRevoke,"UPDATE discovery_intent SET command_json=json_set(command_json,'$.revokes.tmdbId','999')");
 await mutation('revoke revokes.requestId',seedRevoke,"UPDATE discovery_intent SET command_json=json_set(command_json,'$.revokes.requestId','other')");
 await mutation('revoke revokes.effect',seedRevoke,"UPDATE discovery_intent SET command_json=json_set(command_json,'$.revokes.effect','reject')");
 // A history-less decision: the decision hash is pinned.
 const seedDecision=async file=>{const payload=verified({tmdbId:700});ok(file,'INSERT INTO discovery_decision (observation_key,generation,status,attempts,decision_hash,payload_json) VALUES ('+[OBS(7),1,'verified',0,await decisionHash(payload),JSON.stringify(payload)].map(lit2).join(',')+')');};
 await mutation('decision payload only, stored hash unchanged',seedDecision,"UPDATE discovery_decision SET payload_json=json_set(payload_json,'$.tmdbId',999)");
 await mutation('decision identitySource only, stored hash unchanged',seedDecision,"UPDATE discovery_decision SET payload_json=json_set(payload_json,'$.identitySource','known_epg_alias')");
 // A history-only owner assign (no intent names it) is staged from its history row alone.
 const seedOrphan=async file=>insertHistory(file,hist(1,1,'discovery_identity_correct',assignDecision('111','orphan-assign')));
 await mutation('history-only assign ownerIdentity.at',seedOrphan,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.at','2026-01-01T00:00:00.000Z')");
 await mutation('history-only assign ownerIdentity.requestId',seedOrphan,"UPDATE discovery_decision_history SET payload_json=json_set(payload_json,'$.ownerIdentity.requestId','other')");
 await mutation('decision hash',seedDecision,"UPDATE discovery_decision SET decision_hash='"+'0'.repeat(64)+"'");
 await mutation('decision deleted',seedDecision,'DELETE FROM discovery_decision');
}

// ===== 10. dormant: nothing in the Worker imports the module, it never imports the import path, and it contains no write =====
{
 const srcFiles=fs.readdirSync('src',{recursive:true}).filter(name=>String(name).endsWith('.js'));
 const importers=srcFiles.filter(name=>/identity-evidence-family-b/.test(fs.readFileSync(path.join('src',String(name)),'utf8'))&&!String(name).endsWith('identity-evidence-family-b.js'));
 assert.deepEqual(importers,[],'no Worker module imports the family (b) extraction');
 const text=fs.readFileSync('src/identity-evidence-family-b.js','utf8').replace(/\/\/.*$/gm,'');
 assert.equal(/\b(INSERT|UPDATE|DELETE)\s/.test(text),false,'no write statement in the module');
 assert.equal(/from\s+['"]\.\/identity-evidence-import\.js['"]/.test(text),false,'the import path is handed in, never imported');
 assert.equal(await planManifest({runId:'noop',family:'b',cohortAt:COHORT,records:[]}).then(result=>result.manifest),null,'an empty family is a report-only dry run');
 await assert.rejects(()=>dryRunFamilyB({runId:'x',cohortAt:COHORT,sources:sourcesOf()}),/plan_manifest_required/);
}
console.log('identity evidence family (b) tests passed');
