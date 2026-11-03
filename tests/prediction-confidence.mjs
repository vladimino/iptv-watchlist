// AIR-19: deterministic evidence confidence. The assessor is pure and unused by the Worker.
// Legacy fingerprints stay low/legacy. A metadata-only execution claim does not count as support.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const source=fs.readFileSync('src/domain/prediction-confidence.js','utf8');
assert.doesNotMatch(source,/\bfetch\b|\bBUCKET\b|crypto|await |Date\.now|Math\.random|actualRating|predictedRating|sourceBasis/,'the assessor stays off storage, ratings and the derived basis');
assert.doesNotMatch(fs.readFileSync('build.mjs','utf8'),/prediction-confidence\.js/,'the Worker bundle does not load the assessor');
for(const file of ['src/enrichment.js','src/worker.js','src/mcp.js','src/prediction-diagnostics.js','public/app.js'])
 assert.doesNotMatch(fs.readFileSync(file,'utf8'),/assessPredictionConfidence/,'no live path calls the assessor: '+file);
const ctx=vm.createContext({URL});
vm.runInContext(source+'\nglobalThis.A={assessPredictionConfidence,presentConfidenceAssessment,CONFIDENCE_ASSESSMENT_VERSION,CONFIDENCE_ASSESSMENT_THRESHOLDS,KEY_EXECUTION,GENRE_EXECUTION,EXECUTION_VOCABULARY,CONFIDENCE_MECHANICS,REASON_ORDER};',ctx);
const A=ctx.A,plain=value=>JSON.parse(JSON.stringify(value));
const enrichment=fs.readFileSync('src/enrichment.js','utf8');
const literal=(name,text)=>Function('return '+text.match(new RegExp('(?:const |,)'+name+'=(\\[[^\\]]*\\]|\\{[^;]*?\\})(?=[;,])'))[1])();
const same=value=>JSON.parse(JSON.stringify(value));
assert.deepEqual(same(A.KEY_EXECUTION),literal('GENERAL_EXECUTION',enrichment));
assert.deepEqual(same(A.CONFIDENCE_MECHANICS),literal('MECHANICS',enrichment));
assert.deepEqual(same(A.EXECUTION_VOCABULARY),literal('EXECUTION',enrichment));
assert.deepEqual(same(A.GENRE_EXECUTION),Object.keys(same(A.EXECUTION_VOCABULARY)).filter(key=>!same(A.KEY_EXECUTION).includes(key)));
assert.equal(A.CONFIDENCE_ASSESSMENT_VERSION,1);
assert.deepEqual(same(A.CONFIDENCE_ASSESSMENT_THRESHOLDS),{highUnknownMax:2,highSupportedMin:8,mediumSupportedMin:4});

const HASH='ab'.repeat(32);
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;};
const item=(basis,refs,confidence='high')=>({basis,refs,confidence});
const model=confidence=>item('model_knowledge',['model_knowledge'],confidence);
const concrete=['plot_engine','decision_logic','protagonist_competence','problem_solving','plan_counterplan_strength','multi_party_goals','chemistry','payoff','ending_quality'];
const valueOf=key=>key==='protagonist_competence'?'high':'strong';
function fingerprint(extra={}){
 const execution={};
 for(const key of A.KEY_EXECUTION)execution[key]=extra.execution?.[key]??'unknown';
 Object.assign(execution,extra.genre||{});
 return {fingerprintSchemaVersion:1,fingerprintHash:extra.hash===undefined?HASH:extra.hash,plotMechanics:extra.mechanics??['heist'],execution,evidence:extra.evidence,confidence:'high',sourceBasis:'mixed',actualRating:5};
}
function evidenceFor(dimensions,confidence='high',mechanic=model('high')){
 const execution={};
 for(const key of dimensions)execution[key]=[model(confidence)];
 return {plotMechanics:{heist:[mechanic]},execution};
}
const high=fingerprint({
 execution:{pace:'unknown',stakes:'unknown',opposition_competence:'not_applicable',technical_plausibility:'not_applicable',...Object.fromEntries(concrete.map(key=>[key,valueOf(key)]))},
 evidence:evidenceFor(concrete)
});
const once=A.assessPredictionConfidence(high);
const twice=A.assessPredictionConfidence(plain(high));
assert.deepEqual(once,twice,'the same input returns the same assessment');
assert.equal(JSON.stringify(high),JSON.stringify(deepFreeze(plain(high))),'building the fixture did not depend on a clock');
deepFreeze(high);
assert.deepEqual(A.assessPredictionConfidence(high),once,'a frozen fingerprint is not mutated');
assert.equal(once.assessmentVersion,1);
assert.equal(once.level,'high');
assert.equal(once.status,'evidenced');
assert.equal(once.fingerprintHash,HASH);
assert.equal(once.coverage.keySupported,9);
assert.equal(once.coverage.keyUnknown,2);
assert.equal(once.coverage.keyNotApplicable,2);
assert.ok(once.reasonCodes.includes('declared_source_not_verified'));
assert.ok(once.reasonCodes.includes('unknown_gap'));
assert.ok(once.reasonCodes.includes('not_applicable_excluded'));
assert.ok(once.reasonCodes.includes('key_coverage_complete'));
assert.ok(!once.reasonCodes.includes('metadata_only_execution'));
assert.deepEqual(once.reasonCodes,A.REASON_ORDER.filter(code=>once.reasonCodes.includes(code)),'reason codes keep the fixed order');

const changed=fingerprint({
 execution:high.execution,
 evidence:high.evidence,
 hash:'cd'.repeat(32)
});
changed.confidence='low';
changed.sourceBasis='metadata';
changed.actualRating=1;
changed.prediction={confidence:'low',predictedRating:1};
assert.equal(A.assessPredictionConfidence(changed).level,'high');
assert.equal(A.assessPredictionConfidence(changed).fingerprintHash,'cd'.repeat(32));
assert.equal(A.assessPredictionConfidence({...high,fingerprintHash:'ZZ'}).fingerprintHash,null);

const legacy=fingerprint();
delete legacy.evidence;
assert.deepEqual(A.assessPredictionConfidence(legacy).status,'legacy');
assert.equal(A.assessPredictionConfidence(legacy).level,'low');
assert.deepEqual(same(A.assessPredictionConfidence(legacy).reasonCodes),['legacy_no_evidence']);
assert.equal(A.assessPredictionConfidence({...legacy,evidence:null}).status,'insufficient');
assert.equal(A.assessPredictionConfidence({...legacy,evidence:{}}).status,'insufficient');
assert.equal(A.assessPredictionConfidence({...legacy,evidence:{plotMechanics:{},execution:{}},fingerprintSchemaVersion:2}).status,'insufficient');
assert.deepEqual(same(A.assessPredictionConfidence({...legacy,fingerprintSchemaVersion:2}).reasonCodes),['unsupported_schema']);
for(const sample of [A.assessPredictionConfidence(legacy),A.assessPredictionConfidence({...legacy,evidence:null}),A.assessPredictionConfidence({evidence:'nope'})]){
 assert.equal(sample.level,'low');
 assert.notEqual(sample.status,'evidenced');
}

const metadataMechanic=fingerprint({
 evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'])]},execution:{}}
});
const mechanicOnly=A.assessPredictionConfidence(metadataMechanic);
assert.equal(mechanicOnly.status,'evidenced');
assert.equal(mechanicOnly.level,'low');
assert.ok(mechanicOnly.reasonCodes.includes('metadata_mechanic'));
assert.equal(mechanicOnly.coverage.mechanicsSupported,1);
assert.equal(mechanicOnly.coverage.keySupported,0);

const metadataExecution=fingerprint({
 execution:{...high.execution,chemistry:'strong'},
 evidence:{plotMechanics:{heist:[model('high')]},execution:{chemistry:[item('metadata',['metadata:synopsis'],'high')]}}
});
const rejectedQuality=A.assessPredictionConfidence(metadataExecution);
assert.equal(rejectedQuality.coverage.keySupported,0);
assert.ok(rejectedQuality.reasonCodes.includes('metadata_only_execution'));
assert.notEqual(rejectedQuality.level,'high');

const mediumKeys=['chemistry','plot_engine','decision_logic','protagonist_competence','problem_solving','payoff','ending_quality'];
const mixed=fingerprint({
 execution:Object.fromEntries(mediumKeys.map(key=>[key,valueOf(key)])),
 evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis']),model('medium')]},execution:Object.fromEntries(mediumKeys.map(key=>[key,key==='chemistry'?[item('metadata',['metadata:synopsis']),model('medium')]:[model('medium')]]))}
});
const mixedResult=A.assessPredictionConfidence(mixed);
assert.equal(mixedResult.status,'evidenced');
assert.equal(mixedResult.level,'medium');
assert.ok(mixedResult.reasonCodes.includes('declared_source_not_verified'));
assert.ok(!mixedResult.reasonCodes.includes('metadata_mechanic'));
assert.ok(!mixedResult.reasonCodes.includes('metadata_only_execution'));
assert.equal(mixedResult.coverage.keySupported,7);

const lowItems=fingerprint({
 execution:{plot_engine:'strong',decision_logic:'strong',protagonist_competence:'high',problem_solving:'strong'},
 evidence:evidenceFor(['plot_engine','decision_logic','protagonist_competence','problem_solving'],'low')
});
const lowResult=A.assessPredictionConfidence(lowItems);
assert.equal(lowResult.level,'low');
assert.ok(lowResult.reasonCodes.includes('low_item_confidence'));
assert.equal(lowResult.status,'evidenced');

const duplicated=fingerprint({
 execution:high.execution,
 evidence:{plotMechanics:{heist:[model('high'),model('high')]},execution:evidenceFor(concrete).execution}
});
const dup=A.assessPredictionConfidence(duplicated);
assert.ok(dup.reasonCodes.includes('duplicate_ref'));
assert.notEqual(dup.level,'high');

const genreFree=A.assessPredictionConfidence(high);
const genrePresent=fingerprint({
 execution:high.execution,
 genre:{action_readability:'unknown'},
 evidence:high.evidence
});
assert.equal(A.assessPredictionConfidence(genrePresent).level,'high');
assert.ok(A.assessPredictionConfidence(genrePresent).reasonCodes.includes('genre_optional'));
assert.equal(genreFree.level,'high');
const genreMetadata=fingerprint({
 execution:high.execution,
 genre:{action_readability:'strong'},
 evidence:{...high.evidence,execution:{...high.evidence.execution,action_readability:[item('metadata',['metadata:synopsis'],'high')]}}
});
assert.notEqual(A.assessPredictionConfidence(genreMetadata).level,'high');
assert.ok(A.assessPredictionConfidence(genreMetadata).reasonCodes.includes('metadata_only_execution'));

const partialMechanics=fingerprint({
 mechanics:['heist','chase_escape'],
 execution:Object.fromEntries(mediumKeys.map(key=>[key,valueOf(key)])),
 evidence:{plotMechanics:{heist:[model('medium')]},execution:Object.fromEntries(mediumKeys.map(key=>[key,[model('medium')]]))}
});
const partial=A.assessPredictionConfidence(partialMechanics);
assert.equal(partial.level,'medium');
assert.ok(partial.reasonCodes.includes('partial_mechanic_coverage'));
assert.equal(partial.coverage.mechanicsAsserted,2);
assert.equal(partial.coverage.mechanicsSupported,1);

const noMechanics=fingerprint({mechanics:[],execution:{plot_engine:'strong',decision_logic:'strong',protagonist_competence:'high',problem_solving:'strong'},evidence:{execution:{plot_engine:[model('high')],decision_logic:[model('high')],protagonist_competence:[model('high')],problem_solving:[model('high')]}}});
assert.equal(A.assessPredictionConfidence(noMechanics).level,'low');
assert.ok(A.assessPredictionConfidence(noMechanics).reasonCodes.includes('no_asserted_mechanics'));

const privateUrl=fingerprint({
 evidence:{plotMechanics:{heist:[item('web_research',['https://127.0.0.1/secret'],'high')]},execution:{}}
});
assert.equal(A.assessPredictionConfidence(privateUrl).coverage.mechanicsSupported,0);
assert.equal(A.assessPredictionConfidence(privateUrl).status,'insufficient');
const web=fingerprint({
 execution:Object.fromEntries(mediumKeys.map(key=>[key,valueOf(key)])),
 evidence:{plotMechanics:{heist:[item('web_research',['https://example.com/note'],'medium')]},execution:Object.fromEntries(mediumKeys.map(key=>[key,[key==='plot_engine'?item('web_research',['https://example.com/note'],'medium'):model('medium')]]))}
});
assert.equal(A.assessPredictionConfidence(web).level,'medium');
assert.ok(A.assessPredictionConfidence(web).reasonCodes.includes('declared_source_not_verified'));
assert.equal(JSON.stringify(A.assessPredictionConfidence(web)).includes('example.com'),false,'the assessment does not copy a URL');

assert.equal(A.presentConfidenceAssessment(once).level,'high');
assert.equal(A.presentConfidenceAssessment({...once,level:'high',status:'legacy'}),null);
assert.equal(A.presentConfidenceAssessment({...once,reasonCodes:['nope','declared_source_not_verified']}).reasonCodes.includes('nope'),false);
assert.equal(A.presentConfidenceAssessment(null),null);

// AIR-46 validator boundary: a synopsis-only execution claim is invalid_ref, not a coerced unknown.
const worker=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),worker);
for(const file of ['src/sources.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])
 vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),worker);
const unknown=Object.fromEntries(Object.entries(A.EXECUTION_VOCABULARY).map(([key,values])=>[key,values.includes('unknown')?'unknown':values[0]]));
worker.boundary={fingerprintSchemaVersion:1,plotMechanics:['heist'],execution:{...unknown,chemistry:'strong'},moodLabels:['мрачный','напряжённый'],strengths:['A'],risks:['B'],confidence:'medium',sourceBasis:'metadata',sourceRefs:['metadata:synopsis'],evidence:{plotMechanics:{heist:[item('metadata',['metadata:synopsis'],'medium')]},execution:{chemistry:[item('metadata',['metadata:synopsis'],'high')]}}};
worker.meta={synopsis:'A crew plans a robbery.',genres:['Crime'],runtime:100,directors:['A']};
const issues=vm.runInContext('fingerprintIssues(boundary, meta).map(issue=>issue.path+" "+issue.code)',worker);
assert.ok(issues.includes('fingerprint.evidence.execution.chemistry invalid_ref'),issues.join(','));
