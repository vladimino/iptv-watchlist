#!/usr/bin/env node
// AIR-476: grader for the offline evidence-aware scoring regression.
// It scores generator outputs for the blind fixtures in tests/fixtures/prediction-scoring-air-476 against the
// grader-only rubric. It checks policy properties (provenance, use of the readable corpus, no unknown->negative shortcut,
// justified negatives kept, honest uncertainty), never a "correct" rating. Whether a claim is true of the evidence cannot
// be proven by string checks: every case carries a mandatory `grounding_review` flag, so no case is ever clean, and the
// pattern checks only point the reviewer at likely problems. It calls no model, no network and no production service.
//
// Usage: node scripts/prediction-scoring-rubric.mjs <outputs.json>
//   outputs.json = {"outputs":[{"caseId","fingerprint"?,"prediction":{...},"assessment":{...}}]}
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR=path.join(here,'..','tests','fixtures','prediction-scoring-air-476');
export const loadFixtures=()=>({
 inputs:JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR,'generator-inputs.json'),'utf8')),
 rubric:JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR,'grader-rubric.json'),'utf8')),
});

const ACCESS_RANK={search_snippet:1,partial_text:2,full_text:3};
const texts=v=>typeof v==='string'?[v]:[];
// Generator output is untrusted: a list field of the wrong type is graded as missing for claim iteration, never thrown on.
export const list=v=>Array.isArray(v)?v:[];

// Every https ref the output uses as web research, from the assessment and the fingerprint evidence map.
function webRefs(output){
 const refs=[];
 for(const s of list(output.assessment?.sources))if(s?.kind==='web_research')refs.push({ref:s.ref,access:s.access,where:'assessment.sources'});
 const ev=output.fingerprint?.evidence||{};
 for(const group of ['plotMechanics','execution'])for(const [key,items] of Object.entries(ev[group]&&typeof ev[group]==='object'?ev[group]:{}))for(const item of list(items))if(item?.basis==='web_research')for(const ref of list(item?.refs))refs.push({ref,access:null,where:`fingerprint.evidence.${group}.${key}`});
 return refs;
}

export function evaluateCase(caseRubric,film,output,{defectPattern,uncertaintyPattern}){
 const checks=[],add=(id,status,detail)=>checks.push({id,status,detail});
 const p=output.prediction||{},a=output.assessment||{},e=caseRubric.expect||{};
 const defect=new RegExp(defectPattern,'i'),unsure=new RegExp(uncertaintyPattern,'i');
 // Shape of the scoring fields.
 const r=p.predictedRating,q=p.probability4Plus;
 add('rating_shape',Number.isFinite(r)&&r>=0.5&&r<=5&&Number.isInteger(r*2)&&Number.isFinite(q)&&q>=0&&q<=1?'pass':'fail',`predictedRating=${r}, probability4Plus=${q}`);
 // Provenance: no URL outside the closed corpus, no access stronger than the corpus gave.
 const corpus=new Map(list(film.researchCorpus).map(c=>[c.url,c]));
 const bad=[];
 for(const w of webRefs(output)){const c=corpus.get(w.ref);if(!c)bad.push(`${w.where}: ${w.ref} not in corpus`);else if(w.access&&ACCESS_RANK[w.access]>ACCESS_RANK[c.access])bad.push(`${w.where}: ${w.ref} claims ${w.access}, corpus gave ${c.access}`);}
 add('provenance',bad.length?'fail':'pass',bad.join('; ')||'all web refs in corpus at or below corpus access');
 const status=a.research?.status,hasWeb=list(a.sources).some(s=>s?.kind==='web_research');
 add('research_status_consistent',(status==='attempted_found')===hasWeb?'pass':'fail',`status=${status}, webResearchSources=${hasWeb}`);
 // Closed corpus: when it holds a readable review, the protocol says the searches found it. An output that cites none of
 // the readable reviews has not used the only evidence of execution available, so its execution claims are unsupported.
 const readable=list(film.researchCorpus).filter(c=>c.access==='full_text'||c.access==='partial_text').map(c=>c.url);
 if(readable.length){const used=list(a.sources).filter(s=>s?.kind==='web_research'&&readable.includes(s.ref)&&(s.access==='full_text'||s.access==='partial_text'));
  add('readable_corpus_used',used.length?'pass':'fail',used.length?`cited ${used.length} of ${readable.length} readable reviews`:`none of ${readable.length} readable reviews cited as read; status=${status}`);}
 if(e.forbidFullTextClaims){const claimed=list(a.sources).filter(s=>s?.access==='full_text'||s?.access==='partial_text');add('no_read_claim_without_text',claimed.length?'fail':'pass',claimed.map(s=>s.ref).join(', ')||'no full/partial text claimed');}
 if(e.noFingerprint)add('prediction_only_no_fingerprint',output.fingerprint===undefined?'pass':'fail','prediction_only must not send a fingerprint');
 if(e.confidenceNot)add('confidence_honest',e.confidenceNot.includes(p.confidence)?'fail':'pass',`confidence=${p.confidence}, not allowed: ${e.confidenceNot.join('/')}`);
 if(e.minUncertainties!==undefined){const n=list(a.uncertainties).length;add('uncertainty_recorded',n>=e.minUncertainties?'pass':'fail',`uncertainties=${n}`);}
 if(e.maxPredictedRating!==undefined)add('justified_negative_kept',Number.isFinite(r)&&r<=e.maxPredictedRating?'pass':'fail',`predictedRating=${r}, expected <= ${e.maxPredictedRating} because of confirmed defects`);
 const signals=list(a.tasteSignals),against=signals.filter(s=>s?.direction==='against'),supports=signals.filter(s=>s?.direction==='supports');
 if(e.minAgainstSignals!==undefined)add('negative_signal_present',against.length>=e.minAgainstSignals?'pass':'fail',`against=${against.length}`);
 const highRisks=list(a.risks).filter(x=>x?.severity==='high');
 if(e.maxHighRisks!==undefined)add('no_unfounded_high_risk',highRisks.length<=e.maxHighRisks?'pass':'flag',`high risks=${highRisks.length}`);
 // Extremes need at least a signal in that direction (grounding itself is a human check).
 if(r<=2.5||q<=0.2)add('low_extreme_has_negative',against.length?'flag':'fail',against.length?'negative extreme with an against signal; verify it names a confirmed fact':'negative extreme without any against signal');
 if(r>=4.5||q>=0.8)add('high_extreme_has_positive',supports.length?'flag':'fail',supports.length?'positive extreme with a supports signal; verify it names a confirmed fact':'positive extreme without any supports signal');
 // Unknown -> negative shortcut: defect wording without a confirmed minus in the rubric is flagged for review.
 if(e.forbidUngroundedNegatives&&!(caseRubric.confirmedMinus||[]).length){
  const suspects=[...against.map(s=>s.signal),...highRisks.map(x=>x.risk),...texts(p.mainRisk),...texts(a.ratingBasis),...texts(a.probability4PlusBasis)]
   .filter(t=>typeof t==='string'&&defect.test(t)&&!unsure.test(t));
  add('no_unknown_to_negative',suspects.length?'flag':'pass',suspects.length?`defect wording without uncertainty marker: ${suspects.map(t=>JSON.stringify(t.slice(0,120))).join(' | ')}`:'no defect wording on unconfirmed aspects');
 }
 // Claims on aspects the rubric marks unknown for this case, stated without an uncertainty marker, in either direction.
 const allClaims=[...signals.map(s=>s?.signal),...list(a.risks).map(x=>x?.risk),...texts(p.mainRisk),...texts(a.ratingBasis),...texts(a.probability4PlusBasis),...list(p.matchSignals)].filter(t=>typeof t==='string');
 if(caseRubric.keyUnknownPattern){const re=new RegExp(caseRubric.keyUnknownPattern,'i'),hits=allClaims.filter(t=>re.test(t)&&!unsure.test(t));
  add('unknown_claimed_as_fact',hits.length?'flag':'pass',hits.length?`claims on rubric-unknown aspects without an uncertainty marker: ${hits.map(t=>JSON.stringify(t.slice(0,120))).join(' | ')}`:'no claim on rubric-unknown aspects');}
 // prediction.matchSignals: positive taste matches only. Shape is mechanical; content is a heuristic pointer for the reviewer.
 const ms=p.matchSignals;
 add('match_signals_shape',Array.isArray(ms)&&ms.length<=3&&ms.every(x=>typeof x==='string')?'pass':'fail',`matchSignals=${Array.isArray(ms)?ms.length+' items':typeof ms}`);
 if(Array.isArray(ms)){
  const premise=/premise|премис|завязк/i,suspect=caseRubric.matchSignalSuspectPattern?new RegExp(caseRubric.matchSignalSuspectPattern,'i'):null;
  const hits=ms.filter(t=>typeof t==='string'&&!premise.test(t)&&!unsure.test(t)&&(defect.test(t)||(suspect&&suspect.test(t))));
  add('match_signal_suspect',hits.length?'flag':'pass',hits.length?`match signals that may be negative, neutral or unconfirmed: ${hits.map(t=>JSON.stringify(t.slice(0,120))).join(' | ')}`:'no suspect match signal');
 }
 // Whether a claim is true of the evidence is semantic. No string check can prove it, so every output with a substantive
 // claim gets a mandatory human review item and a case is never clean.
 const substantive=[...list(p.matchSignals).map(t=>'matchSignal: '+t),...signals.map(s=>`${s?.direction}: ${s?.signal}`),...list(a.risks).map(x=>`risk ${x?.severity}: ${x?.risk}`),...texts(p.mainRisk).map(t=>'mainRisk: '+t),...texts(a.ratingBasis).map(t=>'ratingBasis: '+t)];
 add('grounding_review','flag',substantive.length?`human check: each claim must match a confirmed fact in the corpus or metadata (${substantive.length} claims)`:'human check: no substantive claim stated');
 return checks;
}

export function evaluate(outputs,{inputs,rubric}=loadFixtures()){
 const films=new Map(inputs.films.map(f=>[f.caseId,f])),byCase=new Map(list(outputs).map(o=>[o.caseId,o]));
 const cases=[];
 for(const [caseId,caseRubric] of Object.entries(rubric.cases)){
  const output=byCase.get(caseId);
  const checks=output?evaluateCase(caseRubric,films.get(caseId),output,rubric):[{id:'output_present',status:'fail',detail:'no output for this case'}];
  cases.push({caseId,label:caseRubric.label,checks});
 }
 const all=cases.flatMap(c=>c.checks),count=s=>all.filter(c=>c.status===s).length;
 return {cases,summary:{pass:count('pass'),flag:count('flag'),fail:count('fail')}};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const file=process.argv[2];
 if(!file){console.error('usage: node scripts/prediction-scoring-rubric.mjs <outputs.json>');process.exit(2);}
 const result=evaluate(JSON.parse(fs.readFileSync(file,'utf8')).outputs);
 console.log(JSON.stringify(result,null,1));
 process.exit(result.summary.fail?1:0);
}
