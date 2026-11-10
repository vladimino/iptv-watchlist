// AIR-373 (ADR 0110): the `cutover_accepted` gate (src/film-person-cutover-accepted.js) and its recording path. Pure fixtures and the sqlite D1 stand-in: no R2,
// no production access. It proves: the two pinned owner decisions are the only permissions; the caps (at cap passes, cap + 1 fails, any differing value fails, an
// unlisted class fails); `verified:true` for an operator copy only with complete evidence and false for each missing piece; the strict and `cutover_minimum` v1
// paths are unchanged; nothing is recorded when the gate fails. The mutation check (tests/film-person-connector-mutation.mjs) points this file at a mutant
// through ACCEPTED_MODULE or BASELINE_RECORD_MODULE.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {OWNER_LINK_WAIVER,REQUIRED_CLASSES,cutoverDigest,cutoverMinimumGate} from '../src/film-person-cutover-minimum.js';
import {GATE_STATEMENTS} from '../scripts/film-person-capture.mjs';
const B=await import(process.env.BASELINE_RECORD_MODULE?pathToFileURL(path.resolve(process.env.BASELINE_RECORD_MODULE)).href:'../src/film-person-baseline.js');
const A=await import(process.env.ACCEPTED_MODULE?pathToFileURL(path.resolve(process.env.ACCEPTED_MODULE)).href:'../src/film-person-cutover-accepted.js');
const {RECORDING_PATHS,baselineGate,keyOf,ledgerDigest,recordBaselineVerified,sha256Hex}=B;
const {ACCEPTED_DISCREPANCIES,COPY_TABLES,OPERATOR_COPY_PERMISSION,DISCOVERY_COPY_TABLES,GATE_IDS,requiredStatementIds,acceptedDigest,buildCutoverAcceptedLedger,cutoverAcceptedGate,operatorCopyReasons,witnessIds}=A;

// ---------- the pinned constants ----------
const MEASURED={film:8,person:6,filmExternalId:16,personExternalId:3,filmAlias:145,personAlias:147,credit:132,filmLocalization:8,personLocalization:3,watchlist:4,redirect:4,retirement:4,ratedAdmission:708,retention:401,projectionKey:11};
// owner decision of 10 Nov 2026, "exact measured numbers": the caps ARE the measurement, with no headroom
const CAPS={...MEASURED};
assert.deepEqual(JSON.parse(JSON.stringify(ACCEPTED_DISCREPANCIES)),{id:'AIR-373-accepted-discrepancies-2026-11-10',version:1,approver:'owner',decision:'AIR-373 owner decisions of 2026-11-10: ignore the discrepancies and prepare the migration; exact measured numbers',scope:'unexplained_missing_or_extra',differs:0,measured:MEASURED,caps:CAPS});
assert.deepEqual({...OPERATOR_COPY_PERMISSION},{id:'AIR-373-operator-copy-2026-11-10',kind:'operator-copy',version:1,approver:'owner',attestation:'operator',decision:'AIR-373 owner decision of 2026-11-10: no token is needed, use the same path as before the pause'});
assert.ok(Object.isFrozen(ACCEPTED_DISCREPANCIES)&&Object.isFrozen(ACCEPTED_DISCREPANCIES.caps)&&Object.isFrozen(ACCEPTED_DISCREPANCIES.measured)&&Object.isFrozen(OPERATOR_COPY_PERMISSION));
// the caps are exactly the measurement; the total is the 1,600 of the evidence file; every required class has a cap
assert.deepEqual({...ACCEPTED_DISCREPANCIES.caps},{...ACCEPTED_DISCREPANCIES.measured});
assert.equal(Object.values(ACCEPTED_DISCREPANCIES.caps).reduce((a,b)=>a+b,0),1600);
assert.deepEqual(Object.keys(CAPS).sort(),[...REQUIRED_CLASSES].sort());
assert.deepEqual([...GATE_IDS],Object.keys(GATE_STATEMENTS),'the gate ids are the reviewed GATE_STATEMENTS');
assert.equal((await witnessIds()).length,20);
assert.deepEqual({...RECORDING_PATHS.cutover_accepted},{gate:'cutover_accepted',version:1});

// ---------- fixtures ----------
const H=text=>sha256Hex(text);
const SRC=await H('manifest'),ETAGS=await H('etags'),FACTS=await H('owner facts');
const identity={schema:{version:18},marker:{mode:'r2',cutover:'open',generation:0},fence:{ok:1},baseline:{state:'empty',reference:null},discovery:{mode:'d1',cutover:'open',generation:73043},published:{mode:'d1',generation:7},owner:{mode:'d1',generation:1}};
const witness={film:'{"n":2}'};
const ownerKeys=[keyOf('film','alpha'),keyOf('person','beta')];
// unexplained[name] keys are missing in D1; `differs` makes one value differ in that class
const classesFor=(unexplained={},differs=null)=>{
 const expected={},actual={};
 for(const name of REQUIRED_CLASSES){
  expected[name]=[[keyOf(name,'k1'),'["v"]']];actual[name]=[[keyOf(name,'k1'),name===differs?'["other"]':'["v"]']];
  for(let i=0;i<(unexplained[name]||0);i++)expected[name].push([keyOf(name,'m'+i),'["v"]']);
 }
 return {expected,actual};
};
const AT={t0:'2026-11-10T18:00:00.000Z',t1:'2026-11-10T18:20:00.000Z',resync:'2026-11-10T18:25:00.000Z',t2:'2026-11-10T18:40:00.000Z',released:'2026-11-10T18:41:00.000Z'};
const LEASE='connector:test-lease';
const IDS=await requiredStatementIds();
// the required statement set is fixed by reviewed constants: 20 witness, 10 gate and one count per table of the copy plan
assert.deepEqual(IDS,[...await witnessIds(),...GATE_IDS.map(id=>'gate:'+id),...COPY_TABLES.map(table=>'count:'+table)]);
assert.equal(COPY_TABLES.length,39);assert.equal(IDS.length,69);assert.ok(Object.isFrozen(COPY_TABLES)&&Object.isFrozen(GATE_IDS));
const factsOf=async()=>{
 const digests=Object.fromEntries(await Promise.all(IDS.map(async id=>[id,await H(id)])));
 const lease={id:LEASE,startedAt:'2026-11-10T17:59:00.000Z',until:'2026-11-10T18:44:00.000Z'};
 const check=at=>({at,digests:{...digests},lease:{...lease}});
 const discovery=Object.fromEntries(await Promise.all(DISCOVERY_COPY_TABLES.map(async table=>[table,await H('resync '+table)])));
 return {version:1,leaseId:LEASE,checks:{t0:check(AT.t0),t1:check(AT.t1),t2:check(AT.t2)},copy:{t1:{digests:{...digests},lease:{id:LEASE,startedAt:lease.startedAt}}},released:{at:AT.released,id:null},
  discovery:{at:AT.resync,generationFirst:73043,generationLast:73043,production:{...discovery},copy:{...discovery}},r2:{manifestDigest:SRC,etagsBefore:ETAGS,etagsAfter:ETAGS},probeComplete:true,readConsistent:true};
};
const CONTEXT={manifestDigest:SRC,r2Etags:{before:ETAGS,after:ETAGS},discoveryGeneration:73043,probeComplete:true,readConsistent:true};
const base=async({unexplained={},differs=null,...over}={})=>{
 const {expected,actual}=classesFor(unexplained,differs);
 return {
  expected:{classes:expected,unavailable:['ownerLink'],complete:true},
  actual:{classes:{...actual,ownerLink:ownerKeys.map((key,index)=>[key,JSON.stringify(['link:'+index,'verified'])])},consistent:true,complete:true},
  source:{aggregateSha256:SRC,kind:'operator-copy'},
  ownerLink:{authority:{mode:'d1',generation:1},factsBefore:{count:2,digest:FACTS},factsAfter:{count:2,digest:FACTS}},
  evidence:{manifestDigest:SRC,r2Etags:{before:ETAGS,after:ETAGS},d1:{before:identity,after:identity},witness:{before:witness,after:witness},fenceHeld:true,leaseLost:false,probeComplete:true},
  waivers:[{...OWNER_LINK_WAIVER}],acceptance:ACCEPTED_DISCREPANCIES,permission:OPERATOR_COPY_PERMISSION,operatorCopy:await factsOf(),
  ...over,
 };
};
const build=async over=>(await buildCutoverAcceptedLedger(await base(over))).ledger;
const redigest=async ledger=>{ledger.digest=await ledgerDigest(ledger);ledger.cutoverDigest=await cutoverDigest(ledger);ledger.acceptedDigest=await acceptedDigest(ledger);return ledger;};
const failsWith=async(ledger,reason)=>{
 const gate=await cutoverAcceptedGate(ledger);
 assert.equal(gate.pass,false,'must fail: '+reason);
 assert.ok(gate.reasons.includes(reason),'expected '+reason+' in '+JSON.stringify(gate.reasons));
 assert.deepEqual(gate.accepted,[],'nothing is accepted on a failure');
 return gate;
};
const AT_CAP=Object.fromEntries(Object.entries(CAPS));

// ---------- 1. the measured counts and the caps ----------
{
 const measured=await build({unexplained:MEASURED});
 const gate=await cutoverAcceptedGate(measured);
 assert.deepEqual(gate.reasons,[]);assert.equal(gate.pass,true);
 assert.deepEqual([gate.gate,gate.version],['cutover_accepted',1]);
 assert.equal(measured.totals.unexplained,1600);assert.equal(measured.source.verified,true);
 // the acceptance, the counts and the caps are in the ledger, under its digest, and in the gate result
 assert.deepEqual(measured.cutoverAccepted.acceptance,JSON.parse(JSON.stringify(ACCEPTED_DISCREPANCIES)));
 assert.deepEqual(measured.cutoverAccepted.discrepancies.ratedAdmission,{unexplained:708,differs:0,cap:708});
 assert.deepEqual(gate.discrepancies,measured.cutoverAccepted.discrepancies);
 assert.deepEqual(gate.accepted.map(item=>item.id),['AIR-373-owner-link-values-2026-11-10','AIR-373-accepted-discrepancies-2026-11-10','AIR-373-operator-copy-2026-11-10']);
 for(const item of ['r2_d1_not_atomic_snapshot','owner_link_values_not_compared','unexplained_differences_accepted_not_repaired','d1_activation_gaps_open:ratedAdmission,retention,retirement','operator_copy_is_attestation_not_proof','d1_side_is_a_copy_not_a_live_read','discovery_copy_checked_by_aggregates_only'])assert.ok(gate.notProved.includes(item),item);
 // the two older gates still refuse this ledger: nothing of theirs was relaxed
 assert.ok((await cutoverMinimumGate(measured)).reasons.includes('unexplained_total'));
 assert.ok((await baselineGate(measured)).reasons.includes('unexplained:1600'));
 // at the cap passes; one above fails, for every class
 assert.equal((await cutoverAcceptedGate(await build({unexplained:AT_CAP}))).pass,true,'every class exactly at its cap, which is the measured count');
 for(const name of REQUIRED_CLASSES){
  const over=await failsWith(await build({unexplained:{...AT_CAP,[name]:CAPS[name]+1}}),'over_cap:'+name);
  assert.deepEqual(over.reasons,['over_cap:'+name],'the only reason');
  assert.equal(over.discrepancies[name].unexplained,CAPS[name]+1,'the failing count is shown');
 }
 assert.equal((await cutoverAcceptedGate(await build())).pass,true,'no difference at all passes too');
 // any differing value fails, in any class, explained or not
 for(const name of REQUIRED_CLASSES){
  const gate2=await failsWith(await build({differs:name}),'differs:'+name);
  assert.ok(gate2.reasons.includes('differs_total'));
 }
 const explainedDiffers=await build({differs:'film',exceptions:[{class:'film',key:keyOf('film','k1'),reason:'owner reviewed',approvedBy:'owner'}]});
 assert.equal(explainedDiffers.classes.film.unexplained.total,0);
 await failsWith(explainedDiffers,'differs:film');
 // a class the acceptance does not list fails
 const extra=await build();extra.classes.newClass=JSON.parse(JSON.stringify(extra.classes.film));
 await failsWith(await redigest(extra),'class_not_listed:newClass');
 // an unavailable class still fails by the v1 rule
 const gone=await base();delete gone.actual.classes.credit;
 await failsWith((await buildCutoverAcceptedLedger(gone)).ledger,'class_unavailable:credit');
}

// ---------- 2. tampering ----------
{
 const good=await build({unexplained:MEASURED});
 const clone=()=>JSON.parse(JSON.stringify(good));
 // a count lowered by hand: the class digest no longer matches the ledger digest
 const lowered=clone();lowered.classes.film.unexplained.total=0;lowered.classes.film.unexplained.missing=0;
 await failsWith(lowered,'digest_mismatch');
 // ... and with every digest recomputed the totals and the declared discrepancies still disagree
 const lowered2=clone();lowered2.classes.ratedAdmission.unexplained.total=1;lowered2.classes.ratedAdmission.unexplained.missing=1;
 const relabelled=await failsWith(await redigest(lowered2),'totals_mismatch');assert.ok(relabelled.reasons.includes('discrepancies_mismatch'));
 const inconsistent=clone();inconsistent.classes.film.unexplained.total=1;
 await failsWith(await redigest(inconsistent),'unexplained_inconsistent:film');
 // the acceptance: another cap, another text, another approver, an extra field, or none
 for(const change of [a=>{a.caps.film=9999;},a=>{a.decision='AIR-373 owner decision of 2026-11-10';},a=>{a.decision='the owner said it is fine';},a=>{a.approver='coordinator';},a=>{a.note='x';},a=>{a.differs=5;},a=>{delete a.caps.credit;},a=>{a.version=2;}]){
  const ledger=clone();change(ledger.cutoverAccepted.acceptance);
  await failsWith(await redigest(ledger),'acceptance_not_permitted');
 }
 for(const acceptance of [null,undefined,'ignore the discrepancies',{},{...OWNER_LINK_WAIVER}])await failsWith(await build({unexplained:MEASURED,acceptance}),'acceptance_not_permitted');
 // changed without its digest
 const stale=clone();stale.cutoverAccepted.discrepancies.film.cap=9999;
 const staleGate=await failsWith(stale,'accepted_digest_mismatch');assert.ok(staleGate.reasons.includes('discrepancies_mismatch'));
 const noSection=clone();delete noSection.cutoverAccepted;await failsWith(noSection,'cutover_accepted_missing');
 const otherVersion=clone();otherVersion.cutoverAccepted.version=2;await failsWith(await redigest(otherVersion),'cutover_accepted_missing');
 const declared=clone();declared.cutoverAccepted.accepted=[];await failsWith(await redigest(declared),'accepted_mismatch');
 const proved=clone();proved.cutoverAccepted.notProved=[];await failsWith(await redigest(proved),'not_proved_mismatch');
 // the v1 rules still apply: the pinned ownerLink waiver, the fence, the witness
 await failsWith(await build({waivers:[]}),'waiver_missing:ownerLink/link_values');
 await failsWith(await build({evidence:{...(await base()).evidence,fenceHeld:false}}),'fence_or_lease_lost');
 await failsWith(await build({evidence:{...(await base()).evidence,witness:{before:witness,after:{film:'{"n":3}'}}}}),'witness_moved');
 for(const value of [null,undefined,{},'ledger',{version:1,classes:{}}])assert.equal((await cutoverAcceptedGate(value)).pass,false);
}

// ---------- 3. the operator-copy source: verified only with complete evidence ----------
{
 assert.deepEqual(await operatorCopyReasons(await factsOf(),CONTEXT),[]);
 const verdict=async(change,context=CONTEXT)=>{const facts=await factsOf();change(facts);return operatorCopyReasons(facts,context);};
 const has=async(change,reason,context)=>{const reasons=await verdict(change,context);assert.ok(reasons.includes(reason),reason+': '+reasons.join());};
 const other=await H('other');
 // production moved between the three reads
 await has(f=>{f.checks.t1.digests['witness:film']=other;},'production_moved:witness:film');
 await has(f=>{f.checks.t2.digests['gate:marker']=other;},'production_moved:gate:marker');
 await has(f=>{f.checks.t0.digests['count:film']=other;},'production_moved:count:film');
 await has(f=>{delete f.checks.t2.digests['witness:person'];},'check_missing:witness:person');
 await has(f=>{delete f.checks.t1;},'check_missing:t1');
 // THE STATEMENT SET IS REQUIRED, not taken from the evidence: a table count absent from EVERY snapshot and from the copy is still missing
 await has(f=>{for(const item of [f.checks.t0,f.checks.t1,f.checks.t2,f.copy.t1])delete item.digests['count:film_metadata'];},'check_missing:count:film_metadata');
 for(const table of COPY_TABLES)assert.deepEqual(await verdict(f=>{for(const item of [f.checks.t0,f.checks.t1,f.checks.t2,f.copy.t1])delete item.digests['count:'+table];}),['check_missing:count:'+table],table);
 for(const stage of ['t0','t1','t2'])await has(f=>{delete f.checks[stage].digests['count:person_alias'];},'check_missing:count:person_alias');
 await has(f=>{delete f.copy.t1.digests['count:person_alias'];},'copy_missing:count:person_alias');
 await has(f=>{delete f.copy.t1.digests['count:discovery_decision'];},'copy_missing:count:discovery_decision');
 await has(f=>{delete f.copy.t1.digests['gate:lease'];},'copy_missing:gate:lease');
 await has(f=>{delete f.checks.t1.digests['gate:lease'];},'check_missing:gate:lease');
 // an id outside the reviewed set is refused, wherever it appears (it is not ignored)
 for(const place of [f=>f.checks.t0,f=>f.checks.t2,f=>f.copy.t1])assert.deepEqual(await verdict(f=>{place(f).digests['count:candidate']=other;}),['check_unknown:count:candidate']);
 await has(f=>{for(const item of [f.checks.t0,f.checks.t1,f.checks.t2,f.copy.t1])item.digests['witness:extra']=other;},'check_unknown:witness:extra');
 await has(f=>{f.checks.t2.at='not a time';},'check_missing:t2');
 await has(f=>{f.checks.t1.at=AT.t0;},'evidence_order');
 // only the Discovery statements may move
 for(const id of ['gate:discovery','gate:discoveryLease','count:discovery_decision'])assert.deepEqual(await verdict(f=>{f.checks.t1.digests[id]=other;f.checks.t2.digests[id]=SRC;}),[],id+' may move');
 // the copy differs from production at T1
 await has(f=>{f.copy.t1.digests['witness:credit']=other;},'copy_mismatch:witness:credit');
 await has(f=>{delete f.copy.t1.digests['gate:baseline'];},'copy_missing:gate:baseline');
 await has(f=>{f.copy=null;},'copy_missing:witness:film');
 await has(f=>{f.copy.t1.lease.id='other';},'copy_mismatch:gate:lease');
 // the Discovery resync
 await has(f=>{f.discovery.generationLast=73044;},'discovery_generation_moved');
 await has(f=>{f.discovery.generationFirst=73042;f.discovery.generationLast=73042;},'discovery_generation_not_the_run_generation');
 await has(f=>{f.discovery.copy.discovery_decision=other;},'discovery_copy_mismatch:discovery_decision');
 await has(f=>{delete f.discovery.production.discovery_admission;},'discovery_resync_missing:discovery_admission');
 await has(f=>{f.discovery=null;},'discovery_resync_missing');
 await has(f=>{f.discovery.at=AT.t0;},'evidence_order:discovery');
 // the production projector lease: held by this run at T0, T1 and T2, then released
 for(const stage of ['t0','t1','t2']){
  await has(f=>{f.checks[stage].lease=null;},'lease_not_held:'+stage);
  await has(f=>{f.checks[stage].lease.id='another';},'lease_not_held:'+stage);
  await has(f=>{f.checks[stage].lease.until=f.checks[stage].at;},'lease_not_held:'+stage);
 }
 await has(f=>{f.checks.t2.lease.startedAt='2026-11-10T18:30:00.000Z';},'lease_not_held:t2');
 await has(f=>{f.leaseId='';},'lease_id_missing');
 await has(f=>{f.released=null;},'lease_not_released');
 await has(f=>{f.released.id=LEASE;},'lease_not_released');
 await has(f=>{f.released.id=undefined;},'lease_not_released');
 await has(f=>{f.released.at=AT.t1;},'lease_not_released');
 // R2, the probe and the read
 await has(f=>{f.r2.etagsAfter=other;},'r2_etags_missing');
 assert.ok((await operatorCopyReasons({...(await factsOf()),r2:{manifestDigest:SRC,etagsBefore:ETAGS,etagsAfter:other}},{...CONTEXT,r2Etags:{before:ETAGS,after:other}})).includes('r2_etags_changed'),'a changed ETag');
 await has(f=>{f.r2.manifestDigest=other;},'manifest_mismatch');
 await has(f=>{f.probeComplete=false;},'probe_incomplete');
 await has(()=>{},'probe_incomplete',{...CONTEXT,probeComplete:false});
 await has(f=>{f.readConsistent=false;},'inconsistent_read');
 await has(()=>{},'inconsistent_read',{...CONTEXT,readConsistent:false});
 for(const value of [null,undefined,{},{version:2},'yes',[]])assert.deepEqual(await operatorCopyReasons(value,CONTEXT),['evidence_missing']);

 // through the builder: the verdict is derived, never passed
 const pushed=await buildCutoverAcceptedLedger(await base({source:{aggregateSha256:SRC,kind:'operator-copy',verified:true},operatorCopy:null}));
 assert.equal(pushed.verified,false);assert.equal(pushed.ledger.source.verified,false);assert.deepEqual(pushed.verification,['evidence_missing']);
 const pushedGate=await failsWith(pushed.ledger,'source_unverified');assert.ok(pushedGate.reasons.includes('operator_copy:evidence_missing'));
 const moved=await factsOf();moved.checks.t2.digests['witness:film']=other;
 const movedLedger=await buildCutoverAcceptedLedger(await base({operatorCopy:moved}));
 assert.equal(movedLedger.ledger.source.verified,false);assert.deepEqual(movedLedger.verification,['production_moved:witness:film']);
 // a ledger whose verdict was set by hand, with every digest recomputed, is still refused: the gate derives it again from the carried facts
 const forged=JSON.parse(JSON.stringify(movedLedger.ledger));forged.source.verified=true;
 const forgedGate=await failsWith(await redigest(forged),'operator_copy:production_moved:witness:film');assert.ok(!forgedGate.reasons.includes('source_unverified'));
 // A DIGEST-CONSISTENT ledger in which one required count is missing from ALL snapshots and from the copy: the builder does not verify it, and with the
 // verdict set by hand and every digest recomputed the gate still refuses it, because the required set comes from COPY_TABLES and not from the evidence.
 const thin=await factsOf();for(const item of [thin.checks.t0,thin.checks.t1,thin.checks.t2,thin.copy.t1])delete item.digests['count:film_retention'];
 const thinBuilt=await buildCutoverAcceptedLedger(await base({operatorCopy:thin}));
 assert.equal(thinBuilt.verified,false);assert.deepEqual(thinBuilt.verification,['check_missing:count:film_retention']);
 const thinForged=JSON.parse(JSON.stringify(thinBuilt.ledger));thinForged.source.verified=true;
 const thinGate=await failsWith(await redigest(thinForged),'operator_copy:check_missing:count:film_retention');
 assert.deepEqual(thinGate.reasons,['operator_copy:check_missing:count:film_retention'],'the only defect of that ledger, and it is enough');
 const WHEN2='2026-11-10T19:00:00.000Z';
 await assert.rejects(()=>recordBaselineVerified({prepare(){throw new Error('the recorder must not reach the database');}},{ledger:thinForged,expectedGeneration:0,at:WHEN2,path:RECORDING_PATHS.cutover_accepted}),error=>error.code==='baseline_gate_failed'&&error.reasons.includes('operator_copy:check_missing:count:film_retention'));
 const padded=await factsOf();for(const item of [padded.checks.t0,padded.checks.t1,padded.checks.t2,padded.copy.t1])item.digests['count:candidate']=other;
 const paddedForged=JSON.parse(JSON.stringify((await buildCutoverAcceptedLedger(await base({operatorCopy:padded}))).ledger));paddedForged.source.verified=true;
 await failsWith(await redigest(paddedForged),'operator_copy:check_unknown:count:candidate');
 // the permission: only the pinned constant, only for this source kind
 for(const permission of [null,{},{...OPERATOR_COPY_PERMISSION,decision:'the operator says the copy is good'},{...OPERATOR_COPY_PERMISSION,approver:'operator'},{...OPERATOR_COPY_PERMISSION,extra:1},{...ACCEPTED_DISCREPANCIES},'use the connector']){
  const out=await buildCutoverAcceptedLedger(await base({permission}));
  assert.equal(out.verified,false);assert.ok(out.verification.includes('source_permission_not_permitted'));
  await failsWith(out.ledger,'source_permission_not_permitted');
  const again=JSON.parse(JSON.stringify(out.ledger));again.source.verified=true;
  await failsWith(await redigest(again),'source_permission_not_permitted');
 }
 // another source kind: the HTTP capture keeps its own verdict and carries no operator evidence
 const http=await buildCutoverAcceptedLedger(await base({source:{aggregateSha256:SRC,verified:true,kind:'projector-input-capture'},permission:null,operatorCopy:null}));
 assert.equal((await cutoverAcceptedGate(http.ledger)).pass,true);
 assert.deepEqual((await cutoverAcceptedGate(http.ledger)).accepted.map(item=>item.id),['AIR-373-owner-link-values-2026-11-10','AIR-373-accepted-discrepancies-2026-11-10']);
 const unverifiedHttp=await buildCutoverAcceptedLedger(await base({source:{aggregateSha256:SRC,verified:false,kind:'projector-input-capture'},permission:null,operatorCopy:null}));
 await failsWith(unverifiedHttp.ledger,'source_unverified');
 await failsWith((await buildCutoverAcceptedLedger(await base({source:{aggregateSha256:SRC,verified:true,kind:'projector-input-capture'}}))).ledger,'source_permission_not_permitted');
 const relabel=JSON.parse(JSON.stringify(http.ledger));relabel.source.kind='operator-copy';
 await failsWith(relabel,'source_kind_mismatch');
}

// ---------- 4. the recording path ----------
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-cutover-accepted-'));
process.on('exit',()=>fs.rmSync(root,{recursive:true,force:true}));
{
 const sql=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text});if(r.status!==0)throw new Error(r.stderr);};
 const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';'});if(r.status!==0)throw new Error(r.stderr);const out=r.stdout.trim();return out?JSON.parse(out):[];};
 const template=path.join(root,'template.sqlite');
 sql(template,fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort().map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 let n=0;const database=()=>{const file=path.join(root,'a-'+(n++)+'.sqlite');fs.copyFileSync(template,file);return file;};
 const baselineRow=file=>rows(file,'SELECT state, reference FROM film_person_baseline')[0];
 const WHEN='2026-11-10T19:00:00.000Z',PATH=RECORDING_PATHS.cutover_accepted;
 const good=await build({unexplained:MEASURED});
 const refuses=async(ledger,recordPath,reason,expectedGeneration=0)=>{
  const file=database();
  await assert.rejects(()=>recordBaselineVerified({DB:d1Standin(file)},{ledger,expectedGeneration,at:WHEN,path:recordPath}),error=>reason(error),'must refuse');
  assert.deepEqual(baselineRow(file),{state:'empty',reference:null},'nothing is written when the recorder refuses');
 };
 const gateFailed=reason=>error=>error.code==='baseline_gate_failed'&&error.reasons.includes(reason);
 // recorded on its own path, with a reference that names gate and version
 const file=database();
 const recorded=await recordBaselineVerified({DB:d1Standin(file)},{ledger:good,expectedGeneration:0,at:WHEN,path:PATH});
 assert.deepEqual(recorded,{state:'verified',reference:'cutover_accepted/v1:'+good.acceptedDigest,already:false});
 assert.deepEqual(baselineRow(file),{state:'verified',reference:'cutover_accepted/v1:'+good.acceptedDigest});
 assert.deepEqual(rows(file,'SELECT mode, cutover, generation FROM film_person_authority')[0],{mode:'r2',cutover:'open',generation:0},'the marker is not moved');
 assert.equal((await recordBaselineVerified({DB:d1Standin(file)},{ledger:good,expectedGeneration:0,at:WHEN,path:{gate:'cutover_accepted',version:1}})).already,true,'a replay is a no-op');
 // no fallback: the other paths refuse this ledger, and this path refuses what the other paths would take
 await refuses(good,undefined,gateFailed('unexplained:1600'));
 await refuses(good,RECORDING_PATHS.strict,gateFailed('unexplained:1600'));
 await refuses(good,RECORDING_PATHS.cutover_minimum,gateFailed('unexplained_total'));
 const clean=await build();
 const plain=JSON.parse(JSON.stringify(clean));delete plain.cutoverAccepted;delete plain.acceptedDigest;
 assert.equal((await cutoverMinimumGate(plain)).pass,true,'a v1 ledger');
 await refuses(plain,PATH,gateFailed('cutover_accepted_missing'));
 // a failing gate, a wrong generation, an unknown path
 await refuses(await build({unexplained:{...MEASURED,film:CAPS.film+1}}),PATH,gateFailed('over_cap:film'));
 await refuses(await build({differs:'person'}),PATH,gateFailed('differs:person'));
 await refuses(await build({operatorCopy:null}),PATH,gateFailed('source_unverified'));
 await refuses(good,PATH,gateFailed('ledger_generation_mismatch'),1);
 for(const bad of [{gate:'cutover_accepted',version:2},{gate:'cutover_accepted'},{gate:'cutover_accepted',version:1,caps:'any'},'cutover_accepted',{gate:'accepted',version:1}])await refuses(good,bad,error=>error.code==='baseline_path_invalid');
}

// ---------- 5. static: inactive ----------
{
 const importers=[];
 const walk=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full);else if(/\.(js|mjs)$/.test(entry.name)&&fs.readFileSync(full,'utf8').includes('film-person-cutover-accepted'))importers.push(full);}};
 walk('src');
 assert.deepEqual(importers.map(file=>path.basename(file)).sort(),['film-person-baseline.js'],'only the recorder names the gate');
 const recorder=fs.readFileSync('src/film-person-baseline.js','utf8');
 assert.ok(recorder.includes("await import('./film-person-cutover-accepted.js')")&&!/^import[^;]*film-person-cutover-accepted/m.test(recorder),'and only through the dynamic import of its explicit path');
 for(const name of ['build.mjs','package.json','wrangler.toml','wrangler.jsonc'])if(fs.existsSync(name))assert.ok(!fs.readFileSync(name,'utf8').includes('film-person-cutover-accepted'),name+' does not bundle the gate');
 const text=fs.readFileSync('src/film-person-cutover-accepted.js','utf8').replace(/\/\/.*$/gm,'');
 assert.ok(!/fetch\(|process\.|node:|\.prepare\(|BUCKET/.test(text),'no network, no environment, no database, no R2');
}
console.log('film-person-cutover-accepted: ok');
