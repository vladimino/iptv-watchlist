// Fingerprint compatibility across fingerprint schema and prompt versions (ADR-0035). One pure rule: is a stored fingerprint
// current, compatible (kept through declared, approved transitions) or stale, and what work does a film need. Builds on
// src/domain/prediction-compatibility.js (selector reach, genre aliases, the profile rule) and src/domain/profile-impact.js
// (canonical JSON, approval shape). No I/O: the live schema-1 vocabulary and a synchronous SHA-256 are passed in by the caller.
const FINGERPRINT_COMPATIBILITY_VERSION=1;
const FINGERPRINT_TRANSITION_SCHEMA_VERSION=1;
const FINGERPRINT_TRANSITION_AXES=['fingerprint_schema','fingerprint_prompt','prediction_prompt'];
const FINGERPRINT_TRANSITION_SCOPES=['identity','selective','global'];
const FINGERPRINT_TRANSITION_KEYS=['transitionSchemaVersion','axis','from','to','scope','changes','selectors','approval'];
const FINGERPRINT_LIST_FIELDS=['plotMechanics','moodLabels','strengths','risks','sourceRefs'];
const FINGERPRINT_FIELDS=['fingerprintSchemaVersion','plotMechanics','execution','moodLabels','strengths','risks','confidence','sourceBasis','sourceRefs'];
// Change kind -> axes it may appear on and how its reach is covered (ADR-0035 section 3).
const FINGERPRINT_CHANGE_KINDS={
 value_added:{axes:['fingerprint_schema'],coverage:'owner_selectors'},
 value_removed:{axes:['fingerprint_schema'],coverage:'value'},
 value_split:{axes:['fingerprint_schema'],coverage:'value'},
 value_merged:{axes:['fingerprint_schema'],coverage:'value'},
 value_renamed:{axes:['fingerprint_schema'],coverage:'value'},
 value_redefined:{axes:['fingerprint_schema'],coverage:'value'},
 dimension_added:{axes:['fingerprint_schema'],coverage:'genre_domain'},
 dimension_removed:{axes:['fingerprint_schema'],coverage:'none'},
 dimension_redefined:{axes:['fingerprint_schema'],coverage:'dimension'},
 field_added:{axes:['fingerprint_schema'],coverage:'global_only'},
 field_removed:{axes:['fingerprint_schema'],coverage:'none'},
 field_redefined:{axes:['fingerprint_schema'],coverage:'global_only'},
 constraint_relaxed:{axes:['fingerprint_schema'],coverage:'none'},
 constraint_tightened:{axes:['fingerprint_schema'],coverage:'structure'},
 prompt_revised:{axes:['fingerprint_prompt','prediction_prompt'],coverage:'owner_selectors'}
};
const FINGERPRINT_MIGRATION_RANK={compatible:0,partial:1,full:2,global:3};
const fingerprintPlain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fingerprintClone=value=>JSON.parse(JSON.stringify(value));

// The canonical declaration an owner approval is bound to.
function fingerprintTransitionDeclarationText(transition){
 return JSON.stringify(profileImpactCanonical([transition.axis,transition.from,transition.to,transition.scope,transition.changes,transition.selectors]));
}
// Old values a value-level change retires, and new values it introduces.
function fingerprintChangeValues(change){
 const old=change.kind==='value_added'?[]:change.kind==='value_merged'?change.from:change.kind==='value_split'||change.kind==='value_renamed'?[change.from]:change.values;
 const added=change.kind==='value_added'?change.values:change.kind==='value_split'?change.to:change.kind==='value_renamed'||change.kind==='value_merged'?[change.to]:[];
 return {old:Array.isArray(old)?old:[],added:Array.isArray(added)?added:[]};
}
const fingerprintChangeList=(vocabulary,change)=>change.field==='plotMechanics'?vocabulary.mechanics:change.field==='execution'?vocabulary.execution[change.dimension]:null;

// The vocabulary and tightened constraints of schema `version`: the base (schema 1) with every schema change up to it applied.
// `transitions` is the schema chain from 1 in order; a gap or an unknown change leaves the vocabulary unknown (null).
function fingerprintSchemaVocabulary(transitions,version,base){
 let vocabulary={mechanics:[...base.mechanics],execution:fingerprintClone(base.execution),general:[...base.general],domains:fingerprintClone(base.domains||{}),constraints:{}},at=1;
 for(const transition of transitions){
  if(transition.to>version)break;
  if(transition.from!==at)return null;
  for(const change of transition.changes){vocabulary=fingerprintApplyChange(vocabulary,change);if(!vocabulary)return null;}
  at=transition.to;
 }
 return at===version?vocabulary:null;
}
function fingerprintApplyChange(vocabulary,change){
 const next=fingerprintClone(vocabulary),list=fingerprintChangeList(next,change),{old,added}=fingerprintChangeValues(change);
 if(change.kind.startsWith('value_')){
  if(!list)return null;
  if(change.kind==='value_redefined')return next;
  // New values take the place of the first retired one, so a vocabulary keeps its order across releases.
  const at=old.length?list.indexOf(old[0]):list.length;
  for(const value of old){const index=list.indexOf(value);if(index<0)return null;list.splice(index,1);}
  list.splice(Math.min(at,list.length),0,...added);
 }
 else if(change.kind==='dimension_added'){next.execution[change.dimension]=[...change.values];if(change.domain)next.domains[change.dimension]=[...change.domain];else next.general.push(change.dimension);}
 else if(change.kind==='dimension_removed'){delete next.execution[change.dimension];delete next.domains[change.dimension];next.general=next.general.filter(dimension=>dimension!==change.dimension);}
 else if(change.kind==='constraint_tightened')next.constraints[change.field]={...(next.constraints[change.field]||{}),...change.rule};
 else if(change.kind==='constraint_relaxed'){const current={...(next.constraints[change.field]||{})};for(const key of Object.keys(change.rule||{}))delete current[key];next.constraints[change.field]=current;}
 return next;
}

function fingerprintChangeValid(change,vocabulary,axis){
 const rule=FINGERPRINT_CHANGE_KINDS[change.kind];
 if(!rule.axes.includes(axis))return false;
 if(change.kind==='prompt_revised')return change.fields===undefined||Array.isArray(change.fields)&&change.fields.every(field=>FINGERPRINT_FIELDS.includes(field));
 if(change.kind.startsWith('value_')){
  if(change.field==='execution'&&!(change.dimension in vocabulary.execution))return false;
  const list=fingerprintChangeList(vocabulary,change),{old,added}=fingerprintChangeValues(change);
  if(!list||!old.every(value=>typeof value==='string')||!added.every(value=>typeof value==='string'))return false;
  return old.length+added.length>0&&old.every(value=>list.includes(value))&&added.every(value=>!list.includes(value));
 }
 // A genre-scoped added dimension is optional (like every genre-specific dimension of the live schema); only a general one may
 // be required, and that change is global-only.
 if(change.kind==='dimension_added')return typeof change.dimension==='string'&&!(change.dimension in vocabulary.execution)&&Array.isArray(change.values)&&change.values.includes('unknown')
  &&(change.required===undefined||typeof change.required==='boolean')&&(change.domain===undefined||change.required!==true&&Array.isArray(change.domain)&&change.domain.length>0&&change.domain.every(genre=>PROFILE_GENRES.includes(genre)));
 if(change.kind==='dimension_removed'||change.kind==='dimension_redefined')return change.dimension in vocabulary.execution;
 if(change.kind==='field_added')return typeof change.field==='string'&&!FINGERPRINT_FIELDS.includes(change.field);
 if(change.kind==='constraint_relaxed'||change.kind==='constraint_tightened')return FINGERPRINT_FIELDS.includes(change.field)&&fingerprintPlain(change.rule)&&Object.keys(change.rule).length>0
  &&Object.entries(change.rule).every(([key,value])=>['minItems','maxItems','maxLength'].includes(key)&&Number.isInteger(value)&&value>=0);
 return FINGERPRINT_FIELDS.includes(change.field);
}
function fingerprintSelectorValid(selector,vocabulary,axis){
 if(!fingerprintPlain(selector)||!fingerprintPlain(selector.regenerate))return false;
 const mode=selector.regenerate.mode;
 if(!['partial','full','prediction'].includes(mode)||(axis==='prediction_prompt')!==(mode==='prediction'))return false;
 if(mode==='partial'&&!(Array.isArray(selector.regenerate.fields)&&selector.regenerate.fields.length&&selector.regenerate.fields.every(field=>FINGERPRINT_FIELDS.includes(field))))return false;
 const {regenerate,...rest}=selector;
 return profileSelectorValid(rest,vocabulary);
}
function fingerprintChangeCovered(change,selectors){
 const coverage=FINGERPRINT_CHANGE_KINDS[change.kind].coverage;
 if(coverage==='value'){
  const {old}=fingerprintChangeValues(change),kind=change.field==='plotMechanics'?'mechanic':'execution';
  return old.every(value=>selectors.some(selector=>selector.kind===kind&&(kind==='mechanic'||selector.dimension===change.dimension)&&selector.values.includes(value)));
 }
 if(coverage==='dimension')return selectors.some(selector=>selector.kind==='execution'&&selector.dimension===change.dimension);
 return true;
}
const fingerprintChangedFields=transition=>new Set(transition.changes.flatMap(change=>change.kind==='prompt_revised'?change.fields||[]:[change.field??'execution']));

// fingerprintTransitionIssue(transition, previous, vocabulary, digest) -> null or a rejection code, in the order of ADR-0035
// section 3. `previous` is the transition before it on the same axis (or none); `vocabulary` is the schema vocabulary at
// `transition.from` for a schema transition, the target schema's otherwise.
function fingerprintTransitionIssue(transition,previous,vocabulary,digest){
 const t=transition;
 if(!fingerprintPlain(t)||t.transitionSchemaVersion!==FINGERPRINT_TRANSITION_SCHEMA_VERSION||Object.keys(t).some(key=>!FINGERPRINT_TRANSITION_KEYS.includes(key))||!Array.isArray(t.changes)||!Array.isArray(t.selectors))return 'transition_schema_unknown';
 if(!FINGERPRINT_TRANSITION_AXES.includes(t.axis))return 'axis_unknown';
 if(!Number.isInteger(t.from)||!Number.isInteger(t.to)||t.from<1||t.to<=t.from)return 'version_not_increasing';
 if(previous&&previous.axis===t.axis&&t.from!==previous.to)return 'chain_broken';
 if(!previous&&t.from!==1)return 'chain_broken';
 if(!FINGERPRINT_TRANSITION_SCOPES.includes(t.scope))return 'scope_unknown';
 if(t.changes.some(change=>!fingerprintPlain(change)||!Object.hasOwn(FINGERPRINT_CHANGE_KINDS,change.kind)))return 'change_kind_unknown';
 if(!vocabulary||t.changes.some(change=>!fingerprintChangeValid(change,vocabulary,t.axis)))return 'change_invalid';
 if(t.scope==='identity'&&t.changes.some(change=>!['none','structure'].includes(FINGERPRINT_CHANGE_KINDS[change.kind].coverage)))return 'identity_change_not_compatible';
 if(t.scope==='identity'&&t.selectors.length)return 'identity_has_selectors';
 if(t.scope==='selective'&&t.changes.some(change=>FINGERPRINT_CHANGE_KINDS[change.kind].coverage==='global_only'||change.kind==='dimension_added'&&!change.domain))return 'global_only_change';
 if(t.scope!=='selective')return t.selectors.length&&t.scope==='global'?'selector_invalid':null;
 if(!t.selectors.length)return 'selective_requires_selectors';
 if(t.selectors.some(selector=>!fingerprintPlain(selector)||!PROFILE_SELECTOR_KINDS.includes(selector.kind)))return 'selector_kind_unknown';
 if(t.selectors.some(selector=>!fingerprintSelectorValid(selector,vocabulary,t.axis)))return 'selector_invalid';
 if(t.changes.some(change=>!fingerprintChangeCovered(change,t.selectors)))return 'change_not_covered';
 for(const change of t.changes)if(change.kind==='dimension_added'&&change.domain&&!change.domain.every(genre=>t.selectors.some(selector=>selector.kind==='genre'&&selector.values.includes(genre))))return 'genre_floor_missing';
 const changed=fingerprintChangedFields(t);
 const partialFieldsValid=selector=>t.axis==='fingerprint_prompt'?[...changed].every(field=>selector.regenerate.fields.includes(field)):selector.regenerate.fields.some(field=>changed.has(field));
 if(t.selectors.some(selector=>selector.regenerate.mode==='partial'&&!partialFieldsValid(selector)))return 'partial_fields_invalid';
 if(!profileApprovalComplete(t.approval))return 'selective_requires_owner_approval';
 if(typeof digest!=='function'||digest(fingerprintTransitionDeclarationText(t))!==t.approval.declarationSha256)return 'approval_mismatch';
 return null;
}
// The whole registry: each axis one contiguous chain from version 1, every transition valid. -> null or {code, index}.
function fingerprintRegistryIssue(registry,options){
 if(!Array.isArray(registry))return {code:'transition_schema_unknown',index:-1};
 const schema=registry.filter(t=>t?.axis==='fingerprint_schema'),target=options.vocabulary;
 for(let i=0;i<registry.length;i++){
  const t=registry[i],chain=registry.slice(0,i).filter(other=>other?.axis===t?.axis),previous=chain.at(-1);
  const vocabulary=t?.axis==='fingerprint_schema'?fingerprintSchemaVocabulary(schema.slice(0,schema.indexOf(t)),t.from,target):fingerprintSchemaVocabulary(schema,schema.at(-1)?.to??1,target);
  const code=fingerprintTransitionIssue(t,previous,vocabulary,options.digest);
  if(code)return {code,index:i};
 }
 return null;
}

// The links on one axis from `from` to `to`, or null when the registry has no such path.
function fingerprintTransitionPath(registry,axis,from,to){
 const chain=registry.filter(t=>t?.axis===axis),path=[];let at=from;
 while(at<to){const next=chain.find(t=>t.from===at);if(!next||next.to>to)return null;path.push(next);at=next.to;}
 return path;
}
// A selector value or dimension the fingerprint's own schema does not have cannot be answered by that fingerprint: unknown.
function fingerprintSelectorWithin(selector,vocabulary){
 if(selector.kind==='mechanic')return selector.values.every(value=>vocabulary.mechanics.includes(value));
 if(selector.kind==='execution')return Array.isArray(vocabulary.execution[selector.dimension])&&selector.values.every(value=>vocabulary.execution[selector.dimension].includes(value));
 return true;
}
function fingerprintReach(selector,fingerprint,genres,vocabulary){
 if(!vocabulary||!fingerprintSelectorWithin(selector,vocabulary))return 'unknown';
 return predictionSelectorReach(selector,predictionImpactFeatures(fingerprint,genres),vocabulary);
}
// The target schema's differences from the fingerprint's own schema: retired values the path does not name, and tightened
// constraints. A fingerprint passed its own schema's validator at submit, so only what the transitions changed can fail.
function fingerprintStructureCompatible(fingerprint,targetVocabulary,covered){
 const mechanics=Array.isArray(fingerprint.plotMechanics)?fingerprint.plotMechanics:[];
 if(mechanics.some(value=>!targetVocabulary.mechanics.includes(value)&&!covered.mechanics.has(value)))return false;
 for(const [dimension,value] of Object.entries(fingerprintPlain(fingerprint.execution)?fingerprint.execution:{})){
  const levels=targetVocabulary.execution[dimension];
  if(levels&&!levels.includes(value)&&!covered.execution.has(dimension+'\u0000'+value))return false;
 }
 for(const [field,rule] of Object.entries(targetVocabulary.constraints||{})){
  const value=fingerprint[field];if(value===undefined)continue;
  if(Array.isArray(value)){
   if(rule.maxItems!==undefined&&value.length>rule.maxItems||rule.minItems!==undefined&&value.length<rule.minItems)return false;
   if(rule.maxLength!==undefined&&value.some(item=>typeof item==='string'&&item.length>rule.maxLength))return false;
  }else if(typeof value==='string'&&rule.maxLength!==undefined&&value.length>rule.maxLength)return false;
 }
 return true;
}
const fingerprintPromptVersion=fingerprint=>fingerprint?.fingerprintPromptVersion??1;

// fingerprintCompatibility(fingerprint, metadata, registry, target, mode, options) -> {outcome, reason, migration, fields, links}.
// `fingerprint` is the generation record the pointer names (content plus its schema and prompt versions); `metadata` is
// {genres}; `target` is {fingerprintSchemaVersion, fingerprintPromptVersion}; options: {vocabulary: {mechanics, execution,
// general, domains} of schema 1, digest(text) -> SHA-256 hex}. Checks run in the order of ADR-0035 section 4.
function fingerprintCompatibility(fingerprint,metadata,registry,target,mode,options){
 const result=(outcome,reason,migration,links=0,fields)=>({outcome,reason,migration,...(fields?{fields}:{}),links});
 if(!fingerprint)return result('stale','fingerprint_missing','full');
 if(fingerprint.invalidatedAt)return result('stale','fingerprint_invalidated','full');
 const schema=fingerprint.fingerprintSchemaVersion,prompt=fingerprintPromptVersion(fingerprint),ts=target.fingerprintSchemaVersion,tp=target.fingerprintPromptVersion;
 if(!Number.isInteger(schema)||!Number.isInteger(prompt))return result('stale','transition_unknown','global');
 if(schema>ts||prompt>tp)return result('stale','fingerprint_ahead','full');
 if(schema===ts&&prompt===tp)return result('current','exact','none');
 // links: the version steps between the record and the target on both axes, whether or not the registry covers them.
 const links=(ts-schema)+(tp-prompt);
 if(mode!=='selective')return result('stale','fingerprint_version_changed','full',links);
 const list=Array.isArray(registry)?registry:[];
 const schemaPath=fingerprintTransitionPath(list,'fingerprint_schema',schema,ts),promptPath=fingerprintTransitionPath(list,'fingerprint_prompt',prompt,tp);
 if(!schemaPath||!promptPath)return result('stale','transition_unknown','global',links);
 if(fingerprintRegistryIssue(list,options))return result('stale','transition_impact_unknown','global',links);
 const schemaChain=list.filter(t=>t.axis==='fingerprint_schema'),own=fingerprintSchemaVocabulary(schemaChain,schema,options.vocabulary),targetVocabulary=fingerprintSchemaVocabulary(schemaChain,ts,options.vocabulary);
 if(!own||!targetVocabulary)return result('stale','transition_impact_unknown','global',links);
 const covered={mechanics:new Set(),execution:new Set()};
 for(const t of schemaPath)for(const change of t.changes)if(change.kind.startsWith('value_')&&change.kind!=='value_redefined'){
  for(const value of fingerprintChangeValues(change).old)change.field==='plotMechanics'?covered.mechanics.add(value):covered.execution.add(change.dimension+'\u0000'+value);
 }
 const structural=fingerprintStructureCompatible(fingerprint,targetVocabulary,covered),genres=metadata?.genres;
 let first=null,widest='compatible',fields=new Set();
 const stale=(reason,migration,partial)=>{first||=reason;if(FINGERPRINT_MIGRATION_RANK[migration]>FINGERPRINT_MIGRATION_RANK[widest])widest=migration;for(const field of partial||[])fields.add(field);};
 // Per link: global first, then the selectors (a stored value outside the own vocabulary is unknown, never "unreached"),
 // then the structural check once for the schema axis, so a malformed record is reported as unknown rather than as a
 // structure difference the transitions never declared.
 let structureJudged=false;
 for(const t of [...schemaPath,...promptPath]){
  if(t.scope==='global'){stale('transition_global','global');continue;}
  if(t.scope==='selective'){
   const reach=t.selectors.map(selector=>fingerprintReach(selector,fingerprint,genres,own)),reached=t.selectors.filter((selector,i)=>reach[i]==='reached');
   if(reached.length){
    const full=reached.some(selector=>selector.regenerate.mode!=='partial');
    stale('transition_impacted',full?'full':'partial',full?[]:reached.flatMap(selector=>selector.regenerate.fields));
   }else if(reach.includes('unknown'))stale('film_features_unknown','full');
  }
  if(t.axis==='fingerprint_schema'&&!structureJudged){structureJudged=true;if(!structural)stale('fingerprint_structure_incompatible','full');}
 }
 if(!first)return result('compatible','transition_unaffected','compatible',links);
 return result('stale',first,widest,links,widest==='partial'?[...fields].sort():undefined);
}
const fingerprintCompatibilityFresh=verdict=>verdict?.outcome==='current'||verdict?.outcome==='compatible';

// The first stored generation record that is current for `target`: a rollback restores the pointer to it without a model run.
function fingerprintRestoreCandidate(history,metadata,registry,target,options){
 return (Array.isArray(history)?history:[]).find(record=>fingerprintCompatibility(record,metadata,registry,target,'selective',options).outcome==='current')||null;
}

// The prediction prompt step of ADR-0035 section 5 (3). -> {outcome, reason}; `pass` when the versions are equal.
function fingerprintPredictionPrompt(prediction,fingerprint,metadata,registry,target,mode,options,ownVocabulary){
 const version=prediction.predictionPromptVersion,wanted=target.predictionPromptVersion;
 if(version===wanted)return {outcome:'current',reason:'exact'};
 if(mode!=='selective')return {outcome:'stale',reason:'prompt_changed'};
 if(!Number.isInteger(version))return {outcome:'stale',reason:'prompt_transition_unknown'};
 if(version>wanted)return {outcome:'stale',reason:'prompt_ahead'};
 const list=Array.isArray(registry)?registry:[],path=fingerprintTransitionPath(list,'prediction_prompt',version,wanted);
 if(!path||fingerprintRegistryIssue(list,options))return {outcome:'stale',reason:'prompt_transition_unknown'};
 let unknown=false;
 for(const t of path){
  if(t.scope==='global')return {outcome:'stale',reason:'prompt_global_change'};
  if(t.scope!=='selective')continue;
  const reach=t.selectors.map(selector=>fingerprintReach(selector,fingerprint,metadata?.genres,ownVocabulary));
  if(reach.includes('reached'))return {outcome:'stale',reason:'prompt_impacted'};
  if(reach.includes('unknown'))unknown=true;
 }
 return unknown?{outcome:'stale',reason:'prompt_features_unknown'}:{outcome:'compatible',reason:'prompt_unaffected'};
}

// predictionTransitionCompatibility(prediction, fingerprint, metadata, profile, registry, target, mode, options) ->
// {outcome, reason, requiredWork, fingerprint, prompt, profile}. Step 1 of ADR-0031 section 3 as replaced by ADR-0035
// section 5, then the unchanged profile rule (predictionCompatibility). `target` also carries predictionPromptVersion.
// `mode` is one mode for every axis, or {fingerprint, prompt, profile} when the fingerprint rule and the profile rule are
// switched separately. Profile selectors are validated against the target schema and answered by the fingerprint in its own.
function predictionTransitionCompatibility(prediction,fingerprint,metadata,profile,registry,target,mode,options){
 const modes=mode&&typeof mode==='object'?{fingerprint:mode.fingerprint,prompt:mode.prompt,profile:mode.profile}:{fingerprint:mode,prompt:mode,profile:mode};
 const verdict=fingerprintCompatibility(fingerprint,metadata,registry,target,modes.fingerprint,options);
 const done=(outcome,reason,extra={})=>({outcome,reason,requiredWork:!fingerprintCompatibilityFresh(verdict)?'fingerprint_and_prediction':outcome==='stale'?'prediction_only':'none',fingerprint:verdict,...extra});
 if(!prediction)return done('stale','fingerprint_changed');
 if(!fingerprintCompatibilityFresh(verdict))return done('stale','fingerprint_not_current');
 if(prediction.fingerprintHash!==fingerprint.fingerprintHash)return done('stale','fingerprint_changed');
 if(prediction.fingerprintSchemaVersion!==fingerprint.fingerprintSchemaVersion)return done('stale','fingerprint_provenance_mismatch');
 const schemaChain=(Array.isArray(registry)?registry:[]).filter(t=>t?.axis==='fingerprint_schema');
 const own=fingerprintSchemaVocabulary(schemaChain,fingerprint.fingerprintSchemaVersion,options.vocabulary),targetVocabulary=fingerprintSchemaVocabulary(schemaChain,target.fingerprintSchemaVersion,options.vocabulary);
 const prompt=fingerprintPredictionPrompt(prediction,fingerprint,metadata,registry,target,modes.prompt,options,own);
 if(prompt.outcome==='stale')return done('stale',prompt.reason,{prompt});
 const profileResult=predictionCompatibility(prediction,fingerprint,predictionImpactFeatures(fingerprint,metadata?.genres),profile,modes.profile,{
  vocabulary:targetVocabulary||options.vocabulary,featureVocabulary:own||undefined,digest:options.digest,
  fingerprintSchemaVersion:fingerprint.fingerprintSchemaVersion,predictionPromptVersion:prediction.predictionPromptVersion});
 if(profileResult.outcome==='stale'||profileResult.outcome==='compatible')return done(profileResult.outcome,profileResult.reason,{prompt,profile:profileResult});
 return prompt.outcome==='compatible'?done('compatible',prompt.reason,{prompt,profile:profileResult}):done('current','exact',{prompt,profile:profileResult});
}
