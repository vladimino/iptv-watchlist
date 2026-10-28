import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// The fingerprint transition evaluator (ADR-0035 sections 3, 4, 5, 7). It must reproduce every specification fixture with
// the live fingerprint vocabulary, fail closed on every unknown, and never touch the records it judges.
const source=fs.readFileSync('src/domain/fingerprint-compatibility.js','utf8');
assert.doesNotMatch(source,/\bfetch\b|\bBUCKET\b|crypto|await|Date\.now|Math\.random/,'the evaluator stays pure');
assert.match(fs.readFileSync('build.mjs','utf8'),/prediction-compatibility\.js'[^\n]*fingerprint-compatibility\.js/,'the Worker bundle includes the evaluator after the profile rule');
assert.doesNotMatch(fs.readFileSync('src/enrichment.js','utf8'),/fingerprintCompatibility|predictionTransitionCompatibility|fingerprintRegistryIssue/,'no consumer calls the evaluator yet');
const ctx=vm.createContext({});
vm.runInContext(['profile-impact','prediction-compatibility','fingerprint-compatibility'].map(file=>fs.readFileSync('src/domain/'+file+'.js','utf8')).join('\n')
 +'\nglobalThis.E={fingerprintCompatibility,fingerprintCompatibilityFresh,fingerprintRestoreCandidate,fingerprintTransitionIssue,fingerprintRegistryIssue,fingerprintSchemaVocabulary,fingerprintTransitionDeclarationText,predictionTransitionCompatibility,predictionCompatibility,predictionImpactFeatures,FINGERPRINT_CHANGE_KINDS,FINGERPRINT_TRANSITION_AXES,FINGERPRINT_TRANSITION_SCOPES,FINGERPRINT_FIELDS};',ctx);
const E=ctx.E,plain=value=>JSON.parse(JSON.stringify(value));
const enrichment=fs.readFileSync('src/enrichment.js','utf8');
const literal=(text,name)=>Function('return '+text.match(new RegExp('(?:const |,)'+name+'=(\\[[^\\]]*\\]|\\{[^;]*?\\})(?=[;,])'))[1])();
const spec=JSON.parse(fs.readFileSync('tests/fixtures/fingerprint-compatibility/cases.json','utf8')),profileSpec=JSON.parse(fs.readFileSync('tests/fixtures/profile-compatibility/cases.json','utf8'));
const vocabulary={mechanics:literal(enrichment,'MECHANICS'),execution:literal(enrichment,'EXECUTION'),general:literal(enrichment,'GENERAL_EXECUTION'),domains:profileSpec.vocabulary.genreDomains};
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const options={vocabulary,digest:sha256};
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;};
const {registries,fingerprints,fingerprintCases,predictionCases,declarations,vocabulary:v}=spec;
deepFreeze(registries);deepFreeze(fingerprints);

// Vocabulary: the evaluator's tables are the specification's, and the field list is the live submit contract's.
assert.deepEqual(plain(E.FINGERPRINT_TRANSITION_AXES),v.axes);
assert.deepEqual(plain(E.FINGERPRINT_TRANSITION_SCOPES),v.scopes);
assert.deepEqual(plain(E.FINGERPRINT_CHANGE_KINDS),v.changeKinds,'change kinds and their coverage are the specification table');
const liveFields=Object.keys(Function('return '+enrichment.match(/const FINGERPRINT_RULES=(\{[\s\S]*?\n\});/)[1].replace(/\b[A-Z_]{3,}\b/g,'null'))());
assert.deepEqual(plain(E.FINGERPRINT_FIELDS),liveFields,'the fingerprint fields are the live submit contract');

// Declarations: every fixture decides as the specification says, with the vocabulary of its `from` version.
const chainBefore=(t,previous)=>previous?[previous]:[];
for(const d of declarations){
 const t=d.transition,vocab=t.axis==='fingerprint_schema'&&Number.isInteger(t.from)?E.fingerprintSchemaVocabulary(chainBefore(t,d.previous),t.from,vocabulary):E.fingerprintSchemaVocabulary([],1,vocabulary);
 const code=E.fingerprintTransitionIssue(t,d.previous,vocab,sha256);
 assert.equal(code,d.expected.code??null,d.id);
}
// Registries: the fixtures' valid registries pass as a whole; the tampered approval is located.
for(const [name,registry] of Object.entries(registries)){
 const issue=E.fingerprintRegistryIssue(registry,options);
 if(name==='invalidApproval')assert.deepEqual(plain(issue),{code:'approval_mismatch',index:0},name);else assert.equal(issue,null,name);
}
assert.deepEqual(plain(E.fingerprintRegistryIssue('nope',options)),{code:'transition_schema_unknown',index:-1},'a registry that is not a list is unknown');

// Fingerprint cases.
const target=(c)=>({fingerprintSchemaVersion:c.target.fingerprintSchemaVersion,fingerprintPromptVersion:c.target.fingerprintPromptVersion});
for(const c of fingerprintCases){
 const fingerprint=c.fingerprint===null?null:fingerprints[c.fingerprint],metadata={genres:fingerprint?.genres??[]};
 const before=JSON.stringify([fingerprint,registries[c.registry]]);
 const got=E.fingerprintCompatibility(fingerprint,metadata,registries[c.registry],target(c),c.mode,options),e=c.expected;
 assert.deepEqual(plain({outcome:got.outcome,reason:got.reason,migration:got.migration,links:got.links,...(got.fields?{fields:got.fields}:{})}),
  {outcome:e.outcome,reason:e.reason,migration:e.migration,links:e.links,...(e.fields?{fields:e.fields}:{})},c.id);
 assert.equal(E.fingerprintCompatibilityFresh(got),e.outcome!=='stale',c.id+' fresh');
 assert.equal(JSON.stringify([fingerprint,registries[c.registry]]),before,c.id+' inputs untouched');
 if(e.restore){
  const history=c.history.map(name=>fingerprints[name]),candidate=E.fingerprintRestoreCandidate(history,metadata,registries[c.registry],target(c),options);
  assert.equal(candidate,fingerprints[e.restore],c.id+' restores the stored generation record');
  // A prompt rollback restores the same body under its earlier generation record; a schema rollback restores the earlier body.
  assert.equal(candidate.fingerprintHash===fingerprint.fingerprintHash,candidate.fingerprintSchemaVersion===fingerprint.fingerprintSchemaVersion,c.id+' body identity follows the schema');
 }else if(c.history)assert.equal(E.fingerprintRestoreCandidate(c.history.map(name=>fingerprints[name]),metadata,registries[c.registry],target(c),options),null,c.id);
}
assert.equal(E.fingerprintRestoreCandidate([fingerprints.heistDrama],{genres:['Драма']},registries.split,{fingerprintSchemaVersion:2,fingerprintPromptVersion:1},options),null,'a compatible record is not a restore candidate: only an exact one is');

// Prediction cases: the fingerprint boundary, the prediction prompt axis and the profile rule together.
const profileOf=c=>{
 const lineage=[{version:1,profileHash:'h1',changeImpact:null}];
 if(!c.profileLink)return {version:1,profileHash:'h1',lineage};
 const impact={impactSchemaVersion:1,from:{version:1,profileHash:'h1'},scope:c.profileLink.scope,changedFields:['positiveSignals'],selectors:c.profileLink.selectors};
 const text=ctx.profileDeclarationText(impact,{version:2,profileHash:'h2'});
 impact.approval={approvedBy:'owner',approvedAt:'2026-01-01T00:00:00.000Z',reviewRef:'decision-ref',declarationSha256:sha256(text)};
 return {version:2,profileHash:'h2',lineage:[...lineage,{version:2,profileHash:'h2',changeImpact:impact}]};
};
for(const c of predictionCases){
 const fingerprint=fingerprints[c.fingerprint],metadata={genres:fingerprint.genres},profile=profileOf(c),e=c.expected;
 const got=E.predictionTransitionCompatibility(c.prediction,fingerprint,metadata,profile,registries[c.registry],c.target,c.mode,options);
 assert.deepEqual(plain({outcome:got.outcome,reason:got.reason,requiredWork:got.requiredWork}),{outcome:e.outcome,reason:e.reason,requiredWork:e.requiredWork},c.id);
 assert.equal(got.fingerprint.outcome!=='stale',e.requiredWork!=='fingerprint_and_prediction',c.id+' fingerprint verdict matches the work');
 assert.deepEqual([c.prediction.tasteProfileVersion,c.prediction.tasteProfileHash],[1,'h1'],c.id+' provenance untouched');
}
// The cross-rule from the profile side: the same film and selector through the ADR-0031 evaluator with the fingerprint's own
// vocabulary is unknown, and with no featureVocabulary (today's callers) the behaviour is unchanged.
{
 const c=predictionCases.find(x=>x.id==='profile-selector-on-new-value'),fingerprint=fingerprints[c.fingerprint],profile=profileOf(c);
 const features=E.predictionImpactFeatures(fingerprint,fingerprint.genres),base={digest:sha256,fingerprintSchemaVersion:1,predictionPromptVersion:1};
 const own=E.fingerprintSchemaVocabulary([],1,vocabulary),targetVocabulary=E.fingerprintSchemaVocabulary(registries.split,2,vocabulary);
 assert.equal(E.predictionCompatibility(c.prediction,fingerprint,features,profile,'selective',{...base,vocabulary:targetVocabulary,featureVocabulary:own}).reason,'film_features_unknown');
 assert.equal(E.predictionCompatibility(c.prediction,fingerprint,features,profile,'selective',{...base,vocabulary:targetVocabulary}).reason,'profile_unaffected','without the option the target vocabulary answers, as before');
}

// Negative cases beyond the fixtures.
const t2={fingerprintSchemaVersion:2,fingerprintPromptVersion:1},t1={fingerprintSchemaVersion:1,fingerprintPromptVersion:1};
const heist=fingerprints.heistComedy,meta={genres:heist.genres};
assert.equal(E.fingerprintCompatibility({...heist,fingerprintSchemaVersion:'1'},meta,registries.split,t2,'selective',options).reason,'transition_unknown','a non-integer schema version is unknown');
assert.equal(E.fingerprintCompatibility(heist,meta,'not a registry',t2,'selective',options).reason,'transition_unknown');
assert.equal(E.fingerprintCompatibility(heist,meta,registries.split,t2,undefined,options).reason,'fingerprint_version_changed','an unknown mode is strict');
const tampered=plain(registries.split);tampered[0].selectors[0].values=['heist'];
assert.deepEqual(plain(E.fingerprintCompatibility(heist,meta,tampered,t2,'selective',options)),{outcome:'stale',reason:'transition_impact_unknown',migration:'global',links:1},'a selector edited after approval');
const unsigned=plain(registries.split);delete unsigned[0].approval;
assert.equal(E.fingerprintCompatibility(heist,meta,unsigned,t2,'selective',options).reason,'transition_impact_unknown');
assert.equal(E.fingerprintCompatibility(heist,meta,registries.split,t2,'selective',{...options,digest:undefined}).reason,'transition_impact_unknown','no digest, no approval check, no keeping');
const fork=[...registries.split,{...plain(registries.split[0]),to:3}];
assert.equal(E.fingerprintCompatibility(heist,meta,fork,t2,'selective',options).reason,'transition_impact_unknown','a forked chain is invalid as a whole, even where the walked path is fine');
const malformedMechanics={...heist,plotMechanics:['heist','not_a_mechanic']};
assert.equal(E.fingerprintCompatibility(malformedMechanics,meta,registries.split,t2,'selective',options).reason,'film_features_unknown','a stored value outside the own vocabulary is unknown, not unreached');
assert.equal(E.fingerprintCompatibility({...heist,plotMechanics:undefined},meta,registries.split,t2,'selective',options).reason,'film_features_unknown','absent mechanics are unknown for a mechanic selector');
// Mixed work across links: a global link wins over partial and full, and a full selector wins over partial.
const mixed=[...registries.split,{...plain(registries.global[0]),from:2,to:3}];
assert.deepEqual(plain(E.fingerprintCompatibility(fingerprints.chaseThriller,{genres:['Триллер']},mixed,{fingerprintSchemaVersion:3,fingerprintPromptVersion:1},'selective',options)),{outcome:'stale',reason:'transition_impacted',migration:'global',links:2},'the first stale reason, the widest work');
// Prompt provenance: records with the same body and different prompt versions are judged by their own versions.
const samePrompt1=fingerprints.prompt1Explicit,samePrompt2=fingerprints.prompt2SameContent;
assert.equal(samePrompt1.fingerprintHash,samePrompt2.fingerprintHash);
assert.equal(E.fingerprintCompatibility(samePrompt1,{genres:['Драма']},registries.fingerprintPrompt,{fingerprintSchemaVersion:1,fingerprintPromptVersion:2},'selective',options).reason,'transition_unaffected');
assert.equal(E.fingerprintCompatibility(samePrompt2,{genres:['Драма']},registries.fingerprintPrompt,{fingerprintSchemaVersion:1,fingerprintPromptVersion:2},'selective',options).reason,'exact');
// Prediction boundary negatives.
const pred={fingerprintHash:'f1',fingerprintSchemaVersion:1,predictionPromptVersion:1,tasteProfileVersion:1,tasteProfileHash:'h1'},profile={version:1,profileHash:'h1',lineage:[{version:1,profileHash:'h1',changeImpact:null}]},t111={...t1,predictionPromptVersion:1};
assert.equal(E.predictionTransitionCompatibility(null,heist,meta,profile,registries.none,t111,'selective',options).requiredWork,'prediction_only','no prediction, current fingerprint');
assert.equal(E.predictionTransitionCompatibility(pred,null,meta,profile,registries.none,t111,'selective',options).requiredWork,'fingerprint_and_prediction');
assert.equal(E.predictionTransitionCompatibility({...pred,predictionPromptVersion:'1'},heist,meta,profile,registries.predictionPrompt,{...t1,predictionPromptVersion:2},'selective',options).reason,'prompt_transition_unknown');
assert.equal(E.predictionTransitionCompatibility(pred,heist,meta,{version:2,profileHash:'h2',lineage:[]},registries.none,t111,'selective',options).reason,'profile_outside_lineage','the profile rule still runs after the fingerprint and prompt steps');
assert.equal(E.predictionTransitionCompatibility(pred,heist,meta,{version:2,profileHash:'h2',lineage:[]},registries.none,t111,'strict',options).reason,'profile_changed');
// The declaration text is canonical: key order does not change the hash the owner approved.
const t=registries.split[0],shuffled={...t,changes:t.changes.map(change=>Object.fromEntries(Object.entries(change).reverse()))};
assert.equal(E.fingerprintTransitionDeclarationText(shuffled),E.fingerprintTransitionDeclarationText(t));
console.log(`fingerprint compatibility: ${fingerprintCases.length} fingerprint, ${predictionCases.length} prediction and ${declarations.length} declaration fixtures reproduced, plus negative cases`);
