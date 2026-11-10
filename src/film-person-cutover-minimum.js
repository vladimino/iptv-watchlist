// AIR-373 (ADR 0099, Accepted; owner decision of 10 Nov 2026): the SEPARATE, VERSIONED `cutover_minimum` baseline gate. OFFLINE and INACTIVE like the rest of
// the baseline tooling: nothing in the Worker imports this module, it reads no R2 or D1, and it records nothing itself. The strict `baselineGate` of
// film-person-baseline.js is untouched: it still fails on an unavailable ownerLink class and it is still the only gate the DEFAULT path of
// `recordBaselineVerified` consults. This gate is consulted by that recorder only on its explicit, versioned path (`path: RECORDING_PATHS.cutover_minimum`,
// reference `cutover_minimum/v1:<cutoverDigest>`); there is no fallback between the two. A pass of THIS gate is evidence for an owner decision, never a
// permission: a baseline can only be recorded by a separate, owner-approved production step.
// What it checks (returns {pass, accepted, notProved, reasons}):
// - the 15 classes other than ownerLink are checked fully (present, compared, zero unexplained differences); an unavailable, unexplained or inconsistent cut fails;
// - ownerLink: ONLY the values identity_link / identity_state are excluded. The existence and identity of each owner_review_entry by (kind, source_key), their
//   count and the manual owner-review facts (a count and a digest read before and after the cut) stay mandatory. When the expected key set cannot be
//   reconstructed independently, a D1-only key list is NOT presented as source parity: the preservation of the authoritative entries is checked and the
//   boundary is stated in notProved. An unknown expected set is never declared equal to the actual one;
// - the ONLY permitted waiver is ownerLink / link_values bound to the AIR-373 owner decision of 2026-11-10 (OWNER_LINK_WAIVER, pinned in code). A free-text
//   decision, another scope or class, or another approver creates no permission; a ledger changed without its digest fails;
// - the source is never bypassed: a verified measurement needs a real, successful bounded capture and parity (verified source, the R2 manifest digest and ETags,
//   the D1 identity before and after, the witness, a held fence, a complete probe and a consistent read). Any detected change fails. A mathematically atomic
//   R2 + D1 snapshot is NOT required and is recorded as not proved.
import {CLASSES,LEDGER_VERSION,buildParityLedger,ledgerDigest,sha256Hex,stable} from './film-person-baseline.js';

export const CUTOVER_MINIMUM_GATE='cutover_minimum';
export const CUTOVER_MINIMUM_VERSION=1;
export const REQUIRED_CLASSES=Object.freeze(CLASSES.map(item=>item.name).filter(name=>name!=='ownerLink'));
// The one waiver. A candidate is accepted only when it is deeply equal to this constant (no extra field, no other value).
export const OWNER_LINK_WAIVER=Object.freeze({id:'AIR-373-owner-link-values-2026-11-10',decision:'AIR-373 owner decision of 2026-11-10',class:'ownerLink',scope:'link_values',approver:'owner'});
const HEX64=/^[0-9a-f]{64}$/;
const waiverMatches=item=>!!item&&typeof item==='object'&&!Array.isArray(item)&&stable(item)===stable(OWNER_LINK_WAIVER);
const hex=value=>HEX64.test(String(value||''));
const keysOf=entries=>entries instanceof Map?[...entries.keys()]:Array.isArray(entries)?entries.map(item=>item[0]):Object.keys(entries||{});
const present=value=>value!==null&&value!==undefined;

export const cutoverDigest=ledger=>sha256Hex(stable({gate:CUTOVER_MINIMUM_GATE,version:CUTOVER_MINIMUM_VERSION,ledgerDigest:ledger.digest,cutoverMinimum:ledger.cutoverMinimum}));
export const acceptedOf=waivers=>(Array.isArray(waivers)?waivers:[]).filter(waiverMatches).map(item=>({id:item.id,class:item.class,scope:item.scope}));
export function notProvedOf(cm){
 const out=['r2_d1_not_atomic_snapshot','owner_link_values_not_compared','baseline_recording_needs_separate_owner_approved_production_step'];
 if(!cm?.ownerLink?.expected)out.push('owner_review_keys_not_source_parity');
 return out;
}
async function keyDigest(keys){return {count:keys.length,digest:await sha256Hex([...keys].sort().join('\n'))};}

// Pure. The strict parity ledger (buildParityLedger, unchanged) plus a digest-covered `cutoverMinimum` section and a `cutoverDigest`.
//  ownerLink: {authority:{mode,generation}, factsBefore:{count,digest}, factsAfter:{count,digest}, expectedKeys?:[key...]|null}; the actual keys are those of
//   actual.classes.ownerLink (their values are never compared). expectedKeys is given only when it was reconstructed independently of D1.
//  evidence: {manifestDigest, r2Etags:{before,after}, d1:{before,after}, witness:{before,after}, fenceHeld, leaseLost, probeComplete}, each a digest or an identity object.
//  waivers: candidates; they are carried verbatim (the gate decides) so a forged one is visible in the ledger.
export async function buildCutoverMinimumLedger({expected,actual,explanations,exceptions,context,source,ownerLink={},evidence={},waivers=[],listCap}){
 const {ledger,diffs}=await buildParityLedger({expected,actual,explanations,exceptions,context,source,listCap});
 const inputsComplete=actual?.complete!==false&&expected?.complete!==false;
 const entries=actual?.classes?.ownerLink;
 const unavailable=!entries||(actual?.unavailable||[]).includes('ownerLink');
 let owner={unavailable:true};
 if(!unavailable){
  const keys=keysOf(entries);
  owner={authority:ownerLink.authority??null,keys:await keyDigest(keys),facts:{before:ownerLink.factsBefore??null,after:ownerLink.factsAfter??null},expected:null,valuesCompared:false};
  if(Array.isArray(ownerLink.expectedKeys)){
   const e=new Set(ownerLink.expectedKeys.map(String)),a=new Set(keys.map(String));
   owner.expected={...await keyDigest([...e]),missing:[...e].filter(key=>!a.has(key)).length,extra:[...a].filter(key=>!e.has(key)).length};
  }
 }
 const cm={version:CUTOVER_MINIMUM_VERSION,inputsComplete,ownerLink:owner,waivers:(Array.isArray(waivers)?waivers:[]).map(item=>item&&typeof item==='object'?JSON.parse(stable(item)):item),
  source:{manifestDigest:evidence.manifestDigest??null,r2Etags:evidence.r2Etags??null,d1:evidence.d1??null,witness:evidence.witness??null,fenceHeld:evidence.fenceHeld===true,leaseLost:evidence.leaseLost!==false,probeComplete:evidence.probeComplete===true,atomicSnapshot:false}};
 cm.accepted=acceptedOf(cm.waivers);
 cm.notProved=notProvedOf(cm);
 ledger.cutoverMinimum=cm;
 ledger.cutoverDigest=await cutoverDigest(ledger);
 return {ledger,diffs};
}

const same=(a,b)=>present(a)&&present(b)&&stable(a)===stable(b);
// Never throws on a malformed ledger: every defect is a reason.
export async function cutoverMinimumGate(ledger){
 const reasons=[];
 const cm=ledger?.cutoverMinimum;
 const done=()=>({gate:CUTOVER_MINIMUM_GATE,version:CUTOVER_MINIMUM_VERSION,pass:reasons.length===0,accepted:reasons.length===0?acceptedOf(cm?.waivers):[],notProved:notProvedOf(cm),reasons});
 if(!ledger||ledger.version!==LEDGER_VERSION){reasons.push('ledger_version');return done();}
 if(!cm||cm.version!==CUTOVER_MINIMUM_VERSION){reasons.push('cutover_minimum_missing');return done();}
 if(cm.inputsComplete!==true)reasons.push('incomplete');
 if(ledger.readConsistent!==true)reasons.push('inconsistent_read');
 for(const name of REQUIRED_CLASSES){
  const entry=ledger.classes?.[name];
  if(!entry||entry.unavailable){reasons.push('class_unavailable:'+name);continue;}
  if(entry.unexplained?.total!==0)reasons.push('unexplained:'+name);
 }
 if(ledger.totals?.unexplained!==0)reasons.push('unexplained_total');
 // source
 const s=cm.source||{};
 if(!(ledger.source&&ledger.source.verified===true&&hex(ledger.source.aggregateSha256)))reasons.push('source_unverified');
 if(s.manifestDigest!==ledger.source?.aggregateSha256||!hex(s.manifestDigest))reasons.push('source_manifest_mismatch');
 if(!(hex(s.r2Etags?.before)&&hex(s.r2Etags?.after)))reasons.push('r2_etags_missing');
 else if(s.r2Etags.before!==s.r2Etags.after)reasons.push('r2_etags_changed');
 if(!same(s.d1?.before,s.d1?.after))reasons.push('d1_identity_changed');
 if(!same(s.witness?.before,s.witness?.after))reasons.push('witness_moved');
 if(s.fenceHeld!==true||s.leaseLost!==false)reasons.push('fence_or_lease_lost');
 if(s.probeComplete!==true)reasons.push('probe_incomplete');
 // ownerLink: keys and facts, never the link values
 const o=cm.ownerLink||{};
 if(o.unavailable||!o.keys)reasons.push('class_unavailable:ownerLink');
 else{
  if(!(o.authority?.mode==='d1'&&Number.isInteger(o.authority.generation)))reasons.push('owner_review_authority_not_d1');
  const before=o.facts?.before,after=o.facts?.after;
  if(!(Number.isInteger(before?.count)&&hex(before?.digest)&&Number.isInteger(after?.count)&&hex(after?.digest)))reasons.push('owner_review_facts_missing');
  else{
   if(stable(before)!==stable(after))reasons.push('owner_review_facts_changed');
   if(after.count!==o.keys.count)reasons.push('owner_review_count_mismatch');
  }
  if(o.expected){
   if(o.expected.missing!==0)reasons.push('owner_review_key_missing');
   if(o.expected.extra!==0)reasons.push('owner_review_key_extra');
   if(o.expected.digest!==o.keys.digest)reasons.push('owner_review_key_digest');
  }
 }
 // the one waiver
 const waivers=Array.isArray(cm.waivers)?cm.waivers:[];
 waivers.forEach((item,index)=>{if(!waiverMatches(item))reasons.push('waiver_not_permitted:'+index);});
 const good=waivers.filter(waiverMatches).length;
 if(good===0)reasons.push('waiver_missing:ownerLink/link_values');
 if(good>1)reasons.push('waiver_duplicate');
 // declared accepted / notProved must be what the code derives, and the digests must still match
 if(stable(cm.accepted)!==stable(acceptedOf(waivers)))reasons.push('accepted_mismatch');
 if(stable(cm.notProved)!==stable(notProvedOf(cm)))reasons.push('not_proved_mismatch');
 if(typeof ledger.digest!=='string'||ledger.digest!==await ledgerDigest(ledger))reasons.push('digest_mismatch');
 if(typeof ledger.cutoverDigest!=='string'||ledger.cutoverDigest!==await cutoverDigest(ledger))reasons.push('cutover_digest_mismatch');
 return done();
}
