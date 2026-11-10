// AIR-373 (ADR 0099 and ADR 0110; owner decisions of 10 Nov 2026): the SEPARATE, VERSIONED `cutover_accepted` baseline gate. OFFLINE and INACTIVE like the rest
// of the baseline tooling: nothing in the Worker imports this module, it reads no R2 or D1 and it records nothing. The strict `baselineGate` and the
// `cutover_minimum` v1 gate are untouched; this gate is consulted by `recordBaselineVerified` only on its own explicit path
// (`path: RECORDING_PATHS.cutover_accepted`, reference `cutover_accepted/v1:<acceptedDigest>`), with no fallback to or from the other paths.
// It is `cutover_minimum` v1 with exactly two differences, each bound to one owner decision by a constant compared by deep equality:
//  (1) ACCEPTED_DISCREPANCIES v1, owner decision "ignore the discrepancies and prepare the migration": unexplained missing / extra rows are accepted up to a
//      per-class CAP taken from the measurement of 10 Nov 2026 plus headroom (10 percent rounded up, at least 2). A value that DIFFERS is never accepted, in any
//      class. A class above its cap, a class the constant does not list, or any differing value fails.
//  (2) OPERATOR_COPY_PERMISSION v1, owner decision "no token is needed, use the same path as before the pause": a source of kind `operator-copy` (the operator
//      copies D1 through the Cloudflare API connector, the run is local) may be `verified`. The verdict is DERIVED here from the facts of the run's evidence
//      files (operatorCopyReasons) and is not an argument of the builder.
// THE HONEST LIMIT: operator-copy evidence is OPERATOR ATTESTATION, not cryptographic proof. The evidence files are plain JSON the operator saved from the
// connector; a synthetic test builds such files. These checks prevent an accidental or incomplete run from being recorded; they do not authenticate one.
// A pass is evidence for an owner decision, never a permission: recording the baseline and `r2` to `prepared` are separate owner GOs.
import {readWitness,sha256Hex,stable} from './film-person-baseline.js';
import {OWNER_LINK_WAIVER,REQUIRED_CLASSES,acceptedOf,buildCutoverMinimumLedger,cutoverMinimumGate,notProvedOf} from './film-person-cutover-minimum.js';

export const CUTOVER_ACCEPTED_GATE='cutover_accepted';
export const CUTOVER_ACCEPTED_VERSION=1;
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
// measured: the unexplained differences per class of the production measurement of 10 Nov 2026 (docs/evidence/d1-migration/air-373-measured-parity-2026-11-10.md).
// caps: measured + max(2, ceil(measured / 10)). ownerLink is not listed: its values are waived by OWNER_LINK_WAIVER and its keys are checked by the v1 rules.
export const ACCEPTED_DISCREPANCIES=freeze({
 id:'AIR-373-accepted-discrepancies-2026-11-10',version:1,approver:'owner',
 decision:'AIR-373 owner decision of 2026-11-10: ignore the discrepancies and prepare the migration',
 scope:'unexplained_missing_or_extra',differs:0,
 measured:{film:8,person:6,filmExternalId:16,personExternalId:3,filmAlias:145,personAlias:147,credit:132,filmLocalization:8,personLocalization:3,watchlist:4,redirect:4,retirement:4,ratedAdmission:708,retention:401,projectionKey:11},
 caps:{film:10,person:8,filmExternalId:18,personExternalId:5,filmAlias:160,personAlias:162,credit:146,filmLocalization:10,personLocalization:5,watchlist:6,redirect:6,retirement:6,ratedAdmission:779,retention:442,projectionKey:13},
});
export const OPERATOR_COPY_KIND='operator-copy';
export const OPERATOR_COPY_PERMISSION=freeze({
 id:'AIR-373-operator-copy-2026-11-10',kind:OPERATOR_COPY_KIND,version:1,approver:'owner',attestation:'operator',
 decision:'AIR-373 owner decision of 2026-11-10: no token is needed, use the same path as before the pause',
});
// The D1 tables the Discovery Workflow keeps writing during a copy. They are copied last, re-read by one resync request, and they are the ONLY statements that
// may differ between the three production reads (see operatorCopyReasons).
export const DISCOVERY_COPY_TABLES=Object.freeze(['discovery_authority','discovery_lease','discovery_transfer','discovery_admission','discovery_decision']);
// The gate statements of the projector-input capture (its GATE_STATEMENTS constant), by id. A test pins this list to that constant.
export const GATE_IDS=Object.freeze(['schema','marker','fence','baseline','lease','window','discovery','discoveryLease','published','owner']);
const LEASE_ID='gate:lease';
export const movingStatement=id=>id==='gate:discovery'||id==='gate:discoveryLease'||DISCOVERY_COPY_TABLES.some(table=>id==='count:'+table);
const HEX64=/^[0-9a-f]{64}$/;
const hex=value=>HEX64.test(String(value||''));
const record=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const same=(candidate,pinned)=>record(candidate)&&stable(candidate)===stable(pinned);
const time=value=>typeof value==='string'&&Number.isFinite(Date.parse(value))?Date.parse(value):NaN;
// The witness names of readWitness, taken from the reviewed reader itself (a recording reader, no database).
export async function witnessIds(){return Object.keys(await readWitness({get:async()=>({})})).map(name=>'witness:'+name);}

// Pure. facts: what the evidence files of ONE connector run say (built by the connector tool under scripts/, carried in the ledger):
//  {version:1, leaseId, checks:{t0,t1,t2}: {at, digests:{<statement id>:sha256 of the rows}, lease:{id,startedAt,until}},
//   copy:{t1:{digests, lease:{id,startedAt}}}, released:{at, id}, discovery:{at, generationFirst, generationLast, production:{<table>:sha256}, copy:{<table>:sha256}},
//   r2:{manifestDigest, etagsBefore, etagsAfter}, probeComplete, readConsistent}
// context: what the run itself observed: {manifestDigest, r2Etags:{before,after}, discoveryGeneration, probeComplete, readConsistent}.
// Returns the reasons the source is NOT verified (empty = verified). Missing or inconsistent evidence is always a reason.
export async function operatorCopyReasons(facts,context){
 if(!record(facts)||facts.version!==1)return ['evidence_missing'];
 const reasons=[];
 const leaseId=typeof facts.leaseId==='string'&&facts.leaseId?facts.leaseId:null;
 if(!leaseId)reasons.push('lease_id_missing');
 const ids=[...await witnessIds(),...GATE_IDS.map(id=>'gate:'+id)];
 const checks=facts.checks||{};
 const stages=['t0','t1','t2'];
 for(const stage of stages){
  const check=checks[stage];
  if(!record(check)||!record(check.digests)||!Number.isFinite(time(check.at))){reasons.push('check_missing:'+stage);continue;}
  // the production projector lease is this run's, live, at every read
  const lease=check.lease;
  if(!(record(lease)&&leaseId&&lease.id===leaseId&&typeof lease.startedAt==='string'&&lease.startedAt===checks.t0?.lease?.startedAt&&time(lease.until)>time(check.at)))reasons.push('lease_not_held:'+stage);
 }
 if(!(time(checks.t0?.at)<time(checks.t1?.at)&&time(checks.t1?.at)<time(checks.t2?.at)))reasons.push('evidence_order');
 const counted=new Set(stages.flatMap(stage=>Object.keys(checks[stage]?.digests||{})).filter(id=>id.startsWith('count:')));
 for(const id of [...ids,...counted]){
  if(id===LEASE_ID)continue;
  const values=stages.map(stage=>checks[stage]?.digests?.[id]);
  if(!values.every(hex)){reasons.push('check_missing:'+id);continue;}
  if(movingStatement(id))continue;
  if(values[0]!==values[1]||values[1]!==values[2])reasons.push('production_moved:'+id);
  // the local copy answers every statement as production did at T1
  if(facts.copy?.t1?.digests?.[id]!==values[1])reasons.push('copy_mismatch:'+id);
 }
 const copied=facts.copy?.t1?.lease;
 if(!(record(copied)&&leaseId&&copied.id===leaseId&&copied.startedAt===checks.t1?.lease?.startedAt))reasons.push('copy_mismatch:'+LEASE_ID);
 // the lease was released after the last read
 const released=facts.released;
 if(!(record(released)&&released.id===null&&time(released.at)>=time(checks.t2?.at)))reasons.push('lease_not_released');
 // the discovery tables: one request, the generation read first and last, production and copy equal on every table's aggregate
 const discovery=facts.discovery;
 if(!record(discovery)||!Number.isFinite(time(discovery.at)))reasons.push('discovery_resync_missing');
 else{
  if(!(Number.isInteger(discovery.generationFirst)&&discovery.generationFirst===discovery.generationLast))reasons.push('discovery_generation_moved');
  if(discovery.generationLast!==context?.discoveryGeneration)reasons.push('discovery_generation_not_the_run_generation');
  if(!(time(discovery.at)>time(checks.t1?.at)&&time(discovery.at)<time(checks.t2?.at)))reasons.push('evidence_order:discovery');
  for(const table of DISCOVERY_COPY_TABLES){
   const production=discovery.production?.[table];
   if(!hex(production))reasons.push('discovery_resync_missing:'+table);
   else if(discovery.copy?.[table]!==production)reasons.push('discovery_copy_mismatch:'+table);
  }
 }
 // the R2 side and the read, as the run observed them
 const r2=facts.r2||{};
 if(!(hex(r2.manifestDigest)&&r2.manifestDigest===context?.manifestDigest))reasons.push('manifest_mismatch');
 if(!(hex(r2.etagsBefore)&&hex(r2.etagsAfter)&&r2.etagsBefore===context?.r2Etags?.before&&r2.etagsAfter===context?.r2Etags?.after))reasons.push('r2_etags_missing');
 else if(r2.etagsBefore!==r2.etagsAfter)reasons.push('r2_etags_changed');
 if(!(facts.probeComplete===true&&context?.probeComplete===true))reasons.push('probe_incomplete');
 if(!(facts.readConsistent===true&&context?.readConsistent===true))reasons.push('inconsistent_read');
 return [...new Set(reasons)];
}
const contextOf=(ledger,cm)=>({manifestDigest:cm?.source?.manifestDigest,r2Etags:cm?.source?.r2Etags,discoveryGeneration:cm?.source?.d1?.after?.discovery?.generation,probeComplete:cm?.source?.probeComplete,readConsistent:ledger?.readConsistent});

export const acceptedDigest=ledger=>sha256Hex(stable({gate:CUTOVER_ACCEPTED_GATE,version:CUTOVER_ACCEPTED_VERSION,ledgerDigest:ledger.digest,cutoverMinimum:ledger.cutoverMinimum,cutoverAccepted:ledger.cutoverAccepted}));
// The per-class counts the acceptance is applied to, from the ledger's own classes (never from an argument).
export function discrepanciesOf(ledger){
 const out={};
 for(const [name,entry] of Object.entries(ledger?.classes||{})){
  if(name==='ownerLink'||!entry||entry.unavailable)continue;
  out[name]={unexplained:entry.unexplained?.total??null,differs:entry.differs??null,cap:ACCEPTED_DISCREPANCIES.caps[name]??null};
 }
 return out;
}
const acceptedList=section=>[
 ...(same(section?.acceptance,ACCEPTED_DISCREPANCIES)?[{id:ACCEPTED_DISCREPANCIES.id,class:'*',scope:ACCEPTED_DISCREPANCIES.scope}]:[]),
 ...(section?.sourceKind===OPERATOR_COPY_KIND&&same(section?.permission,OPERATOR_COPY_PERMISSION)?[{id:OPERATOR_COPY_PERMISSION.id,class:'*',scope:'source_'+OPERATOR_COPY_KIND}]:[]),
];
export function notProvedAccepted(section){
 const out=['unexplained_differences_accepted_not_repaired','d1_activation_gaps_open:ratedAdmission,retention,retirement'];
 if(section?.sourceKind===OPERATOR_COPY_KIND)out.push('operator_copy_is_attestation_not_proof','d1_side_is_a_copy_not_a_live_read','discovery_copy_checked_by_aggregates_only','writers_that_keep_every_witness_aggregate');
 return out;
}

// The v1 ledger (buildCutoverMinimumLedger, unchanged) plus a digest-covered `cutoverAccepted` section and an `acceptedDigest`.
//  acceptance, permission: candidates, carried verbatim (the gate decides), so a forged one is visible in the ledger.
//  operatorCopy: the facts above. For a source of kind `operator-copy` the caller's `source.verified` is IGNORED: it is derived from the facts and the permission.
export async function buildCutoverAcceptedLedger({source,evidence={},actual,acceptance=null,permission=null,operatorCopy=null,...rest}){
 const kind=source?.kind??null;
 let verified=source?.verified===true,verification=[];
 if(kind===OPERATOR_COPY_KIND){
  verification=await operatorCopyReasons(operatorCopy,{manifestDigest:evidence.manifestDigest,r2Etags:evidence.r2Etags,discoveryGeneration:evidence.d1?.after?.discovery?.generation,probeComplete:evidence.probeComplete===true,readConsistent:actual?.consistent===true});
  if(!same(permission,OPERATOR_COPY_PERMISSION))verification.push('source_permission_not_permitted');
  verified=verification.length===0;
 }
 const {ledger,diffs}=await buildCutoverMinimumLedger({...rest,actual,evidence,source:{...source,verified}});
 const copy=value=>value&&typeof value==='object'?JSON.parse(stable(value)):value;
 const section={version:CUTOVER_ACCEPTED_VERSION,acceptance:copy(acceptance),discrepancies:discrepanciesOf(ledger),sourceKind:kind,permission:copy(permission),operatorCopy:copy(operatorCopy)};
 section.accepted=acceptedList(section);
 section.notProved=notProvedAccepted(section);
 ledger.cutoverAccepted=section;
 ledger.acceptedDigest=await acceptedDigest(ledger);
 return {ledger,diffs,verified,verification};
}

// Never throws on a malformed ledger: every defect is a reason. Returns {gate, version, pass, accepted, notProved, reasons, discrepancies}.
export async function cutoverAcceptedGate(ledger){
 const section=ledger?.cutoverAccepted,cm=ledger?.cutoverMinimum;
 // Every v1 check applies, except the one this gate replaces: zero unexplained differences. Nothing else of v1 is relaxed.
 const v1=await cutoverMinimumGate(ledger);
 const reasons=v1.reasons.filter(item=>!/^unexplained:/.test(item)&&item!=='unexplained_total');
 const done=()=>({gate:CUTOVER_ACCEPTED_GATE,version:CUTOVER_ACCEPTED_VERSION,pass:reasons.length===0,accepted:reasons.length===0?[...acceptedOf(cm?.waivers),...acceptedList(section)]:[],notProved:[...notProvedOf(cm),...notProvedAccepted(section)],reasons,discrepancies:discrepanciesOf(ledger)});
 if(!record(section)||section.version!==CUTOVER_ACCEPTED_VERSION){reasons.push('cutover_accepted_missing');return done();}
 // (1) the accepted discrepancies
 if(!same(section.acceptance,ACCEPTED_DISCREPANCIES))reasons.push('acceptance_not_permitted');
 let unexplained=0;
 for(const [name,entry] of Object.entries(ledger.classes||{})){
  if(name==='ownerLink'||!entry||entry.unavailable)continue;
  const cap=ACCEPTED_DISCREPANCIES.caps[name];
  if(!REQUIRED_CLASSES.includes(name)||!Number.isInteger(cap)){reasons.push('class_not_listed:'+name);continue;}
  if(entry.differs!==0||entry.unexplained?.differs!==0)reasons.push('differs:'+name);
  if(!Number.isInteger(entry.unexplained?.total)||entry.unexplained.total>cap)reasons.push('over_cap:'+name);
  if(entry.unexplained?.total!==(entry.unexplained?.missing??NaN)+(entry.unexplained?.extra??NaN)+(entry.unexplained?.differs??NaN))reasons.push('unexplained_inconsistent:'+name);
  unexplained+=entry.unexplained?.total||0;
 }
 if(ledger.totals?.differs!==0)reasons.push('differs_total');
 if(ledger.totals?.unexplained!==unexplained)reasons.push('totals_mismatch');
 if(stable(section.discrepancies)!==stable(discrepanciesOf(ledger)))reasons.push('discrepancies_mismatch');
 // (2) the source: an operator copy needs the pinned permission and evidence that still derives `verified`
 if(section.sourceKind!==(ledger.source?.kind??null))reasons.push('source_kind_mismatch');
 if(section.sourceKind===OPERATOR_COPY_KIND){
  if(!same(section.permission,OPERATOR_COPY_PERMISSION))reasons.push('source_permission_not_permitted');
  for(const item of await operatorCopyReasons(section.operatorCopy,contextOf(ledger,cm)))reasons.push('operator_copy:'+item);
 }else if(section.permission!==null||section.operatorCopy!==null)reasons.push('source_permission_not_permitted');
 // declared accepted / notProved must be what the code derives, and the digest must still match
 if(stable(section.accepted)!==stable(acceptedList(section)))reasons.push('accepted_mismatch');
 if(stable(section.notProved)!==stable(notProvedAccepted(section)))reasons.push('not_proved_mismatch');
 if(typeof ledger.acceptedDigest!=='string'||ledger.acceptedDigest!==await acceptedDigest(ledger))reasons.push('accepted_digest_mismatch');
 return done();
}
export {OWNER_LINK_WAIVER};
