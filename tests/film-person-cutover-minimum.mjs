// AIR-373: the separate `cutover_minimum` baseline gate (src/film-person-cutover-minimum.js). Pure fixtures: no R2, no D1, no production access. The mutation
// check (tests/film-person-cutover-minimum-mutation.mjs) points this file at a mutant through CUTOVER_MODULE; every mutant must make it fail.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
import {CLASSES,baselineGate,keyOf,ledgerDigest,recordBaselineVerified,sha256Hex} from '../src/film-person-baseline.js';

const target=process.env.CUTOVER_MODULE?pathToFileURL(path.resolve(process.env.CUTOVER_MODULE)).href:new URL('../src/film-person-cutover-minimum.js',import.meta.url).href;
const {OWNER_LINK_WAIVER,REQUIRED_CLASSES,buildCutoverMinimumLedger,cutoverDigest,cutoverMinimumGate}=await import(target);

// the waiver is pinned literally: the constant itself is not a free parameter
assert.deepEqual({...OWNER_LINK_WAIVER},{id:'AIR-373-owner-link-values-2026-11-10',decision:'AIR-373 owner decision of 2026-11-10',class:'ownerLink',scope:'link_values',approver:'owner'});
assert.equal(Object.isFrozen(OWNER_LINK_WAIVER),true);

const H=async text=>sha256Hex(text);
const SRC=await H('manifest');
const ETAGS=await H('etags');
const FACTS=await H('owner facts');
const identity={schema:11,marker:{mode:'r2',generation:3},baseline:'empty',published:{generation:7,etag:'"abc"'},owner:{mode:'d1',generation:1}};
const witness={film:{n:2,a:2},person:{n:1,a:1}};
const ownerKeys=[keyOf('film','alpha'),keyOf('person','beta')];

const classesFor=()=>Object.fromEntries(REQUIRED_CLASSES.map(name=>[name,[[keyOf(name,'k1'),'["v"]'],[keyOf(name,'k2'),'["w"]']]]));
const base=(over={})=>({
 expected:{classes:classesFor(),unavailable:['ownerLink'],complete:true},
 actual:{classes:{...classesFor(),ownerLink:ownerKeys.map((k,i)=>[k,JSON.stringify(['link:'+i,'verified'])])},consistent:true,complete:true},
 source:{aggregateSha256:SRC,verified:true,kind:'projector-input-capture'},
 ownerLink:{authority:{mode:'d1',generation:1},factsBefore:{count:2,digest:FACTS},factsAfter:{count:2,digest:FACTS}},
 evidence:{manifestDigest:SRC,r2Etags:{before:ETAGS,after:ETAGS},d1:{before:identity,after:identity},witness:{before:witness,after:witness},fenceHeld:true,leaseLost:false,probeComplete:true},
 waivers:[{...OWNER_LINK_WAIVER}],
 ...over,
});
const build=async over=>(await buildCutoverMinimumLedger(base(over))).ledger;
const redigest=async ledger=>{ledger.cutoverDigest=await cutoverDigest(ledger);return ledger;};
const failsWith=async(ledger,reason)=>{
 const gate=await cutoverMinimumGate(ledger);
 assert.equal(gate.pass,false,'must fail: '+reason);
 assert.ok(gate.reasons.some(item=>item===reason||item.startsWith(reason)),'expected '+reason+' in '+JSON.stringify(gate.reasons));
 assert.deepEqual(gate.accepted,[],'nothing is accepted on a failure');
 assert.ok(gate.notProved.length>0);
 return gate;
};

// ---- the passing case, and what it does and does not prove ----
{
 const ledger=await build();
 const gate=await cutoverMinimumGate(ledger);
 assert.deepEqual(gate.reasons,[]);
 assert.equal(gate.pass,true);
 assert.equal(gate.gate,'cutover_minimum');
 assert.equal(gate.version,1);
 assert.deepEqual(gate.accepted,[{id:OWNER_LINK_WAIVER.id,class:'ownerLink',scope:'link_values'}]);
 for(const item of ['r2_d1_not_atomic_snapshot','owner_link_values_not_compared','owner_review_keys_not_source_parity','baseline_recording_needs_separate_owner_approved_production_step'])assert.ok(gate.notProved.includes(item),item);
 assert.equal(REQUIRED_CLASSES.length,15);
 assert.equal(CLASSES.length,16);
 // the exact exception and accepted / notProved are in the ledger and covered by its digest
 assert.deepEqual(ledger.cutoverMinimum.waivers,[OWNER_LINK_WAIVER]);
 assert.deepEqual(ledger.cutoverMinimum.accepted,gate.accepted);
 assert.deepEqual(ledger.cutoverMinimum.notProved,gate.notProved);
 // the strict gate is untouched: it still refuses this ledger (ownerLink unavailable on the expected side) and so does the recorder
 const strict=await baselineGate(ledger);
 assert.equal(strict.pass,false);
 assert.ok(strict.reasons.includes('class_unavailable:ownerLink'));
 await assert.rejects(()=>recordBaselineVerified({},{ledger,expectedGeneration:3,at:'2026-11-10T00:00:00.000Z'}),error=>error.code==='baseline_gate_failed');
}
// link VALUES are not compared: different values still pass; a reconstructed key set makes the source-parity note disappear
{
 const ledger=await build({actual:{...base().actual,classes:{...base().actual.classes,ownerLink:ownerKeys.map(k=>[k,JSON.stringify(['other','held'])])}},ownerLink:{...base().ownerLink,expectedKeys:ownerKeys}});
 const gate=await cutoverMinimumGate(ledger);
 assert.deepEqual(gate.reasons,[]);
 assert.ok(!gate.notProved.includes('owner_review_keys_not_source_parity'));
}

// ---- unavailable required class (each of the 15) ----
for(const name of REQUIRED_CLASSES){
 await failsWith(await build({actual:{...base().actual,unavailable:[name]}}),'class_unavailable:'+name);
 const classes=classesFor();delete classes[name];
 await failsWith(await build({actual:{...base().actual,classes:{...classes,ownerLink:base().actual.classes.ownerLink}}}),'class_unavailable:'+name);
}
await failsWith(await build({expected:{...base().expected,complete:false}}),'incomplete');
await failsWith(await build({actual:{...base().actual,complete:false}}),'incomplete');
await failsWith(await build({actual:{...base().actual,consistent:false}}),'inconsistent_read');

// ---- ownerLink ----
await failsWith(await build({actual:{...base().actual,unavailable:['ownerLink']}}),'class_unavailable:ownerLink');
{const a=base().actual;delete a.classes.ownerLink;await failsWith(await build({actual:a}),'class_unavailable:ownerLink');}
await failsWith(await build({ownerLink:{...base().ownerLink,expectedKeys:[...ownerKeys,keyOf('film','gamma')]}}),'owner_review_key_missing');
await failsWith(await build({ownerLink:{...base().ownerLink,expectedKeys:[ownerKeys[0]]}}),'owner_review_key_extra');
await failsWith(await build({ownerLink:{...base().ownerLink,expectedKeys:[ownerKeys[0],keyOf('film','other')]}}),'owner_review_key_missing');
await failsWith(await build({ownerLink:{...base().ownerLink,factsAfter:{count:2,digest:await H('changed')}}}),'owner_review_facts_changed');
await failsWith(await build({ownerLink:{...base().ownerLink,factsBefore:null}}),'owner_review_facts_missing');
await failsWith(await build({ownerLink:{...base().ownerLink,factsBefore:{count:3,digest:FACTS},factsAfter:{count:3,digest:FACTS}}}),'owner_review_count_mismatch');
await failsWith(await build({ownerLink:{...base().ownerLink,authority:{mode:'r2',generation:0}}}),'owner_review_authority_not_d1');
await failsWith(await build({ownerLink:{...base().ownerLink,authority:null}}),'owner_review_authority_not_d1');
{
 // an expected key set that was not reconstructed is never declared equal: the key list is the D1 one and the note says so
 const ledger=await build();
 assert.equal(ledger.cutoverMinimum.ownerLink.expected,null);
 const gate=await cutoverMinimumGate(ledger);
 assert.ok(gate.notProved.includes('owner_review_keys_not_source_parity'));
}
{
 // a tampered expected digest (same counts) is caught by the key digest
 const ledger=await build({ownerLink:{...base().ownerLink,expectedKeys:ownerKeys}});
 ledger.cutoverMinimum.ownerLink.expected.digest=await H('other');
 await redigest(ledger);
 await failsWith(ledger,'owner_review_key_digest');
}

// ---- unexplained mismatch ----
{
 const actual=base().actual;
 actual.classes.film=[[keyOf('film','k1'),'["DIFFERENT"]'],[keyOf('film','k2'),'["w"]']];
 await failsWith(await build({actual}),'unexplained:film');
 const missing=base().actual;missing.classes.credit=[[keyOf('credit','k1'),'["v"]']];
 await failsWith(await build({actual:missing}),'unexplained:credit');
 const extra=base().actual;extra.classes.watchlist=[...extra.classes.watchlist,[keyOf('watchlist','k3'),'[]']];
 await failsWith(await build({actual:extra}),'unexplained:watchlist');
}

// ---- unauthorized waiver ----
const waiverCases=[
 ['free-text decision',[{...OWNER_LINK_WAIVER,decision:'the owner said it is fine'}]],
 ['arbitrary approver owner with free text',[{id:'x',class:'ownerLink',scope:'link_values',approver:'owner',decision:'because I say so'}]],
 ['other scope',[{...OWNER_LINK_WAIVER,scope:'keys'}]],
 ['other class',[{...OWNER_LINK_WAIVER,class:'credit'}]],
 ['wrong approver',[{...OWNER_LINK_WAIVER,approver:'executor'}]],
 ['wrong id',[{...OWNER_LINK_WAIVER,id:'AIR-999'}]],
 ['extra field',[{...OWNER_LINK_WAIVER,extra:true}]],
 ['a string',['owner']],
 ['an unrelated waiver next to the real one',[{...OWNER_LINK_WAIVER},{...OWNER_LINK_WAIVER,class:'credit',scope:'all'}]],
];
for(const [label,waivers] of waiverCases){
 const gate=await failsWith(await build({waivers}),'waiver_not_permitted');
 assert.ok(gate.reasons.length>=1,label);
}
await failsWith(await build({waivers:[]}),'waiver_missing:ownerLink/link_values');
await failsWith(await build({waivers:[{...OWNER_LINK_WAIVER},{...OWNER_LINK_WAIVER}]}),'waiver_duplicate');

// ---- tampered digest ----
{
 const ledger=await build();
 ledger.cutoverMinimum.waivers=[{...OWNER_LINK_WAIVER,decision:'forged'}];
 await failsWith(ledger,'cutover_digest_mismatch');
 const forged=await redigest(ledger);
 const gate=await failsWith(forged,'waiver_not_permitted');
 assert.ok(gate.reasons.includes('accepted_mismatch')||gate.reasons.includes('waiver_missing:ownerLink/link_values'));
}
{
 const ledger=await build();ledger.totals.unexplained=1;
 await failsWith(ledger,'digest_mismatch');
 // a consistently re-digested ledger that still counts an unexplained difference fails on its own
 ledger.digest=await ledgerDigest(ledger);await redigest(ledger);
 await failsWith(ledger,'unexplained_total');
}
{
 const ledger=await build();ledger.classes.film.expected.count=99;
 await failsWith(ledger,'digest_mismatch');
}
{
 const ledger=await build();ledger.cutoverMinimum.notProved=['nothing'];await redigest(ledger);
 await failsWith(ledger,'not_proved_mismatch');
}
{
 const ledger=await build();ledger.cutoverMinimum.accepted=[];await redigest(ledger);
 await failsWith(ledger,'accepted_mismatch');
}
{
 const ledger=await build();ledger.cutoverDigest='0'.repeat(64);
 await failsWith(ledger,'cutover_digest_mismatch');
 delete ledger.cutoverDigest;
 await failsWith(ledger,'cutover_digest_mismatch');
}
await failsWith(null,'ledger_version');
await failsWith({version:1,classes:{}},'cutover_minimum_missing');

// ---- unverified source (the Stage B shape is verified:false and must never pass) ----
await failsWith(await build({source:{aggregateSha256:SRC,verified:false,kind:'projector-input-capture'}}),'source_unverified');
await failsWith(await build({source:{aggregateSha256:'not-a-digest',verified:true}}),'source_unverified');
await failsWith(await build({source:null}),'source_unverified');
await failsWith(await build({evidence:{...base().evidence,manifestDigest:await H('another')}}),'source_manifest_mismatch');

// ---- a changing generation / ETag / witness, a lost fence, an incomplete probe ----
await failsWith(await build({evidence:{...base().evidence,r2Etags:{before:ETAGS,after:await H('moved')}}}),'r2_etags_changed');
await failsWith(await build({evidence:{...base().evidence,r2Etags:null}}),'r2_etags_missing');
await failsWith(await build({evidence:{...base().evidence,d1:{before:identity,after:{...identity,marker:{mode:'r2',generation:4}}}}}),'d1_identity_changed');
await failsWith(await build({evidence:{...base().evidence,d1:{before:identity,after:{...identity,published:{generation:7,etag:'"def"'}}}}}),'d1_identity_changed');
await failsWith(await build({evidence:{...base().evidence,d1:{before:identity,after:null}}}),'d1_identity_changed');
await failsWith(await build({evidence:{...base().evidence,d1:null}}),'d1_identity_changed');
await failsWith(await build({evidence:{...base().evidence,witness:{before:witness,after:{...witness,film:{n:3,a:3}}}}}),'witness_moved');
await failsWith(await build({evidence:{...base().evidence,witness:null}}),'witness_moved');
await failsWith(await build({evidence:{...base().evidence,fenceHeld:false}}),'fence_or_lease_lost');
await failsWith(await build({evidence:{...base().evidence,leaseLost:true}}),'fence_or_lease_lost');
await failsWith(await build({evidence:{...base().evidence,probeComplete:false}}),'probe_incomplete');
{
 // the evidence fields default to the failing side when absent
 const {evidence,...rest}=base();
 const ledger=(await buildCutoverMinimumLedger(rest)).ledger;
 const gate=await cutoverMinimumGate(ledger);
 assert.equal(gate.pass,false);
 for(const reason of ['source_manifest_mismatch','r2_etags_missing','d1_identity_changed','witness_moved','fence_or_lease_lost','probe_incomplete'])assert.ok(gate.reasons.includes(reason),reason);
}
// the strict ledger shape of a Stage B report (no cutoverMinimum section, verified:false) fails
{
 const {buildParityLedger}=await import('../src/film-person-baseline.js');
 const {ledger}=await buildParityLedger({expected:base().expected,actual:base().actual,source:{aggregateSha256:SRC,verified:false,kind:'projector-input-capture'}});
 await failsWith(ledger,'cutover_minimum_missing');
}
console.log('film-person-cutover-minimum: ok');
