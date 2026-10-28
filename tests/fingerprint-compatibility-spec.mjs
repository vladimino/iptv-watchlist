import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Specification fixtures for fingerprint schema and prompt transitions (ADR-0035). They hold no evaluator: this test keeps
// them internally consistent, derives each synthetic schema vocabulary from the live one through the declared changes, and
// checks every declaration case against the validation rules of the ADR, so the evaluator built later is tested against
// cases that use real mechanic, execution and genre names.
const spec=JSON.parse(fs.readFileSync('tests/fixtures/fingerprint-compatibility/cases.json','utf8'));
const profileSpec=JSON.parse(fs.readFileSync('tests/fixtures/profile-compatibility/cases.json','utf8'));
const enrichment=fs.readFileSync('src/enrichment.js','utf8');
const literal=(text,name)=>{const match=text.match(new RegExp('(?:const |,)'+name+'=(\\[[^\\]]*\\]|\\{[^;]*?\\})(?=[;,])'));assert(match,name+' literal found');return Function('return '+match[1])();};
const MECHANICS=literal(enrichment,'MECHANICS'),EXECUTION=literal(enrichment,'EXECUTION'),GENERAL=literal(enrichment,'GENERAL_EXECUTION');
const FINGERPRINT_FIELDS=Object.keys(Function('return '+enrichment.match(/const FINGERPRINT_RULES=(\{[\s\S]*?\n\});/)[1].replace(/\b[A-Z_]{3,}\b/g,'null'))());
assert.match(enrichment,/execution:\{kind:'enum_object',fields:EXECUTION,required:GENERAL_EXECUTION,optional:GENRE_EXECUTION\}/,'genre-specific execution dimensions are optional in the live validator');
const {vocabulary:v,registries,fingerprints,fingerprintCases,predictionCases,declarations}=spec;
const {genres:GENRES,genreAliases:ALIASES,genreDomains:DOMAINS}=profileSpec.vocabulary;

assert.equal(spec.specVersion,1);
assert(fs.existsSync(spec.decision),'the fixtures name an existing ADR');
assert.equal(JSON.stringify(spec).match(/https?:\/\//),null,'no URL in the fixtures');
assert.equal(enrichment.match(/const FINGERPRINT_SCHEMA_VERSION=(\d+);/)[1],'1','the live fingerprint schema is version 1, the root of every synthetic chain');

// Schema vocabularies: version 1 is the live contract; a later version is version 1 with the declared changes applied.
const clone=value=>JSON.parse(JSON.stringify(value));
const live={mechanics:[...MECHANICS],execution:clone(EXECUTION),general:[...GENERAL],domains:clone(DOMAINS)};
const listOf=(vocab,change)=>change.field==='plotMechanics'?vocab.mechanics:change.field==='execution'?vocab.execution[change.dimension]:null;
function applyChange(vocab,change){
 const next=clone(vocab),list=listOf(next,change);
 const replace=(from,to)=>{const at=list.indexOf(from);list.splice(at,1,...to);};
 if(change.kind==='value_added')list.push(...change.values);
 else if(change.kind==='value_removed')for(const value of change.values)list.splice(list.indexOf(value),1);
 else if(change.kind==='value_split')replace(change.from,change.to);
 else if(change.kind==='value_renamed')replace(change.from,[change.to]);
 else if(change.kind==='value_merged'){for(const value of change.from)list.splice(list.indexOf(value),1);list.push(change.to);}
 else if(change.kind==='dimension_added'){next.execution[change.dimension]=[...change.values];if(change.domain)next.domains[change.dimension]=[...change.domain];else next.general.push(change.dimension);}
 else if(change.kind==='dimension_removed'){delete next.execution[change.dimension];delete next.domains[change.dimension];next.general=next.general.filter(d=>d!==change.dimension);}
 return next;
}
const schemaTransitions=registry=>registry.filter(t=>t.axis==='fingerprint_schema');
function vocabularyAt(registry,version){let vocab=live;for(const t of schemaTransitions(registry)){if(t.to>version)break;for(const change of t.changes)vocab=applyChange(vocab,change);}return vocab;}

// Declaration rules (ADR-0035 section 3), in the order the ADR lists their rejection codes.
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const digest=t=>createHash('sha256').update(JSON.stringify(canonical([t.axis,t.from,t.to,t.scope,t.changes,t.selectors]))).digest('hex');
const genreOf=name=>ALIASES[String(name).toLowerCase()];
function changeValid(change,vocab,axis){
 const rule=v.changeKinds[change.kind];if(!rule.axes.includes(axis))return false;
 if(change.kind==='prompt_revised')return !change.fields||change.fields.every(f=>FINGERPRINT_FIELDS.includes(f));
 if(change.kind.startsWith('value_')){
  const list=listOf(vocab,change);if(!list||change.field==='execution'&&!(change.dimension in vocab.execution))return false;
  const old=change.kind==='value_added'?[]:change.kind==='value_merged'?change.from:change.kind==='value_split'||change.kind==='value_renamed'?[change.from]:change.values;
  const added=change.kind==='value_added'?change.values:change.kind==='value_split'?change.to:change.kind==='value_renamed'||change.kind==='value_merged'?[change.to]:[];
  return old.every(x=>list.includes(x))&&added.every(x=>!list.includes(x))&&(old.length||added.length)>0;
 }
 // A genre-scoped dimension is optional by contract (like every genre-specific dimension of the live schema), so a fingerprint
 // outside its domain passes the target validator without it; only a general dimension may be required, and that is global-only.
 if(change.kind==='dimension_added')return !(change.dimension in vocab.execution)&&change.values.includes('unknown')&&(change.required===undefined||typeof change.required==='boolean')&&(!change.domain||change.required!==true&&change.domain.length>0&&change.domain.every(g=>GENRES.includes(g)));
 if(change.kind==='dimension_removed'||change.kind==='dimension_redefined')return change.dimension in vocab.execution;
 return FINGERPRINT_FIELDS.includes(change.field)||change.kind==='field_added'&&!FINGERPRINT_FIELDS.includes(change.field);
}
function selectorValid(selector,vocab){
 const values=selector.values,mode=selector.regenerate?.mode;
 if(!Array.isArray(values)||!values.length||!v.regenerateModes.includes(mode))return false;
 if(mode==='partial'&&(!selector.regenerate.fields?.length||!selector.regenerate.fields.every(f=>FINGERPRINT_FIELDS.includes(f))))return false;
 if(selector.kind==='mechanic')return values.every(x=>vocab.mechanics.includes(x));
 if(selector.kind==='execution')return selector.dimension in vocab.execution&&values.every(x=>vocab.execution[selector.dimension].includes(x)&&!['unknown','not_applicable'].includes(x));
 return values.every(x=>GENRES.includes(x));
}
function covers(change,selectors){
 const coverage=v.changeKinds[change.kind].coverage;
 if(coverage==='value'){const old=change.kind==='value_merged'?change.from:change.kind==='value_split'||change.kind==='value_renamed'?[change.from]:change.values;
  return old.every(x=>selectors.some(s=>(change.field==='plotMechanics'?s.kind==='mechanic':s.kind==='execution'&&s.dimension===change.dimension)&&s.values.includes(x)));}
 if(coverage==='dimension')return selectors.some(s=>s.kind==='execution'&&s.dimension===change.dimension);
 return true;
}
function validate(t,previous){
 if(t.transitionSchemaVersion!==1)return 'transition_schema_unknown';
 if(!v.axes.includes(t.axis))return 'axis_unknown';
 if(!Number.isInteger(t.from)||!Number.isInteger(t.to)||t.to<=t.from)return 'version_not_increasing';
 if(previous&&previous.axis===t.axis&&t.from!==previous.to)return 'chain_broken';
 if(!v.scopes.includes(t.scope))return 'scope_unknown';
 if(t.changes.some(c=>!(c.kind in v.changeKinds)))return 'change_kind_unknown';
 const vocab=t.axis==='fingerprint_schema'?vocabularyAt(previous?[previous]:[],t.from):live;
 if(t.changes.some(c=>!changeValid(c,vocab,t.axis)))return 'change_invalid';
 if(t.scope==='identity'&&t.changes.some(c=>!v.identityCoverage.includes(v.changeKinds[c.kind].coverage)))return 'identity_change_not_compatible';
 if(t.scope==='identity'&&t.selectors.length)return 'identity_has_selectors';
 if(t.scope==='selective'&&t.changes.some(c=>v.changeKinds[c.kind].coverage==='global_only'))return 'global_only_change';
 if(t.scope!=='selective')return null;
 if(!t.selectors.length)return 'selective_requires_selectors';
 if(t.selectors.some(s=>!v.selectorKinds.includes(s.kind)))return 'selector_kind_unknown';
 if(t.selectors.some(s=>!selectorValid(s,vocab)||(t.axis==='prediction_prompt')!==(s.regenerate.mode==='prediction')))return 'selector_invalid';
 if(t.changes.some(c=>!covers(c,t.selectors)))return 'change_not_covered';
 for(const c of t.changes)if(c.kind==='dimension_added'&&c.domain&&!c.domain.every(g=>t.selectors.some(s=>s.kind==='genre'&&s.values.includes(g))))return 'genre_floor_missing';
 const changed=new Set(t.changes.flatMap(c=>c.kind==='prompt_revised'?c.fields||[]:[c.field??'execution']));
 if(t.selectors.some(s=>s.regenerate.mode==='partial'&&(t.axis==='fingerprint_prompt'?![...changed].every(f=>s.regenerate.fields.includes(f)):!s.regenerate.fields.some(f=>changed.has(f)))))return 'partial_fields_invalid';
 const a=t.approval;
 if(!a||a.approvedBy!=='owner'||!a.approvedAt||!a.reviewRef||!a.declarationSha256)return 'selective_requires_owner_approval';
 if(a.declarationSha256!==digest(t))return 'approval_mismatch';
 return null;
}

// Declarations: every case decides as expected and every rejection code is exercised.
for(const d of declarations){
 const code=validate(d.transition,d.previous);
 assert.equal(code===null?'accept':'reject',d.expected.decision,d.id+' decision ('+code+')');
 if(code)assert.equal(code,d.expected.code,d.id+' code');
 assert(v.declaration.decisions.includes(d.expected.decision),d.id);
}
for(const code of v.declaration.codes)assert(declarations.some(d=>d.expected.code===code),'declaration case for '+code);
assert.equal(new Set(declarations.map(d=>d.id)).size,declarations.length,'unique declaration ids');

// Registries: each axis is one contiguous chain; every transition but the deliberately broken approval is valid.
for(const [name,registry] of Object.entries(registries)){
 for(const axis of v.axes){const chain=registry.filter(t=>t.axis===axis);chain.forEach((t,i)=>{
  const code=validate(t,i?chain[i-1]:undefined);
  if(name==='invalidApproval')assert.equal(code,'approval_mismatch',name);else assert.equal(code,null,name+' '+axis+' '+t.from+'→'+t.to);
 });}
}

// Fingerprints use the vocabulary of their own schema version, derived from the live contract.
const schemaOf=f=>f.fingerprintSchemaVersion,promptOf=f=>f.fingerprintPromptVersion??1;
const knownGenres=f=>f.genres.length>0&&f.genres.every(g=>genreOf(g));
function wellFormed(f,registry){const vocab=vocabularyAt(registry,schemaOf(f));return f.plotMechanics.every(m=>vocab.mechanics.includes(m))&&Object.entries(f.execution).every(([d,x])=>vocab.execution[d]?.includes(x));}

// Reasons belong to exactly one outcome per evaluator; shared prediction reasons keep the ADR-0031 meaning.
const outcomeOf=reasons=>{const map=new Map();for(const [outcome,list] of Object.entries(reasons)){assert(v.outcomes.includes(outcome));for(const reason of list){assert(!map.has(reason),reason);map.set(reason,outcome);}}return map;};
const fingerprintOutcome=outcomeOf(v.fingerprintReasons),predictionOutcome=outcomeOf(v.predictionReasons),profileOutcome=outcomeOf(profileSpec.vocabulary.reasons);
for(const [reason,outcome] of predictionOutcome)if(profileOutcome.has(reason))assert.equal(profileOutcome.get(reason),outcome,reason+' keeps its ADR-0031 outcome');
const strictOnly=['fingerprint_version_changed','prompt_changed'];

// Fingerprint evaluation cases.
const ids=new Set(),pathLength=(registry,axis,from,to)=>{let at=from,n=0;for(const t of registry.filter(t=>t.axis===axis)){if(t.from===at&&t.to<=to){at=t.to;n++;}}return at===to?n:null;};
for(const c of fingerprintCases){
 assert(!ids.has(c.id),'unique '+c.id);ids.add(c.id);
 assert(v.modes.includes(c.mode),c.id);assert(c.registry in registries,c.id);const registry=registries[c.registry],e=c.expected;
 assert.equal(fingerprintOutcome.get(e.reason),e.outcome,c.id+' reason matches outcome');
 assert(v.migrations.includes(e.migration),c.id);
 assert.equal(e.migration==='none',e.outcome==='current',c.id+' migration none only for current');
 assert.equal(e.migration==='compatible',e.outcome==='compatible',c.id+' migration compatible only for compatible');
 assert.equal(strictOnly.includes(e.reason),c.mode==='strict'&&e.outcome!=='current',c.id+' strict reasons only in strict mode');
 assert.equal(e.fields!==undefined,e.migration==='partial',c.id+' fields exactly for partial');
 if(e.reason==='fingerprint_missing'){assert.equal(c.fingerprint,null,c.id);continue;}
 const f=fingerprints[c.fingerprint];assert(f,c.id+' fingerprint');assert(wellFormed(f,registry),c.id+' fingerprint uses the vocabulary of its schema');
 const s=schemaOf(f),p=promptOf(f),ts=c.target.fingerprintSchemaVersion,tp=c.target.fingerprintPromptVersion;
 if(e.reason==='exact')assert.deepEqual([s,p],[ts,tp],c.id);
 if(e.reason==='fingerprint_ahead')assert(s>ts||p>tp,c.id);
 if(e.reason==='fingerprint_invalidated')assert(f.invalidatedAt,c.id);
 if(e.reason==='transition_unknown')assert(pathLength(registry,'fingerprint_schema',s,ts)===null||pathLength(registry,'fingerprint_prompt',p,tp)===null,c.id);
 if(e.reason==='film_features_unknown')assert(!knownGenres(f),c.id+' unknown features come from genres that cannot be read');
 if(e.migration==='partial'){const allowed=registry.flatMap(t=>t.selectors).filter(sel=>sel.regenerate.mode==='partial').flatMap(sel=>sel.regenerate.fields);assert(e.fields.every(x=>allowed.includes(x)),c.id+' partial fields come from the registry');assert.deepEqual(e.fields,[...e.fields].sort(),c.id+' sorted fields');}
 if(e.outcome==='compatible'){assert.equal(c.mode,'selective',c.id);const n=(pathLength(registry,'fingerprint_schema',s,ts)??-99)+(pathLength(registry,'fingerprint_prompt',p,tp)??-99);assert.equal(e.links,n,c.id+' links');}
 if(e.restore){const old=fingerprints[e.restore];assert(c.history.includes(e.restore),c.id);assert.deepEqual([schemaOf(old),promptOf(old)],[ts,tp],c.id+' the restored version is current for the target');assert(!old.invalidatedAt,c.id);}
}
for(const category of ['exact','split','genre','diagnostic','structure','unknown','global','versions','repeat','rollback','transitive','prompt','strict','provenance'])assert(fingerprintCases.some(c=>c.category===category),'fingerprint case for '+category);
for(const reason of fingerprintOutcome.keys())assert(fingerprintCases.some(c=>c.expected.reason===reason),'fingerprint case for '+reason);

// Prediction cases: required work follows the fingerprint/prediction boundary of ADR-0035 section 5.
for(const c of predictionCases){
 assert(!ids.has(c.id),'unique '+c.id);ids.add(c.id);
 assert(v.modes.includes(c.mode),c.id);assert(c.registry in registries,c.id);const e=c.expected,f=fingerprints[c.fingerprint],p=c.prediction;
 assert(f,c.id);assert.equal(predictionOutcome.get(e.reason),e.outcome,c.id+' reason matches outcome');
 assert(v.requiredWork.includes(e.requiredWork),c.id);
 assert.equal(strictOnly.includes(e.reason),c.mode==='strict',c.id+' strict reasons only in strict mode');
 const work=e.outcome!=='stale'?'none':e.reason==='fingerprint_not_current'?'fingerprint_and_prediction':'prediction_only';
 assert.equal(e.requiredWork,work,c.id+' required work');
 if(e.reason==='fingerprint_changed')assert.notEqual(p.fingerprintHash,f.fingerprintHash,c.id);
 if(e.reason==='fingerprint_provenance_mismatch')assert(p.fingerprintHash===f.fingerprintHash&&p.fingerprintSchemaVersion!==schemaOf(f),c.id);
 if(e.reason==='prompt_ahead')assert(p.predictionPromptVersion>c.target.predictionPromptVersion,c.id);
 if(e.reason==='prompt_features_unknown')assert(!knownGenres(f),c.id);
 if(e.outcome!=='stale'||e.reason.startsWith('prompt_'))assert.equal(p.fingerprintHash,f.fingerprintHash,c.id+' a kept or prompt-only case keeps the fingerprint hash');
 if(c.profileLink){const vocab=vocabularyAt(registries[c.registry],schemaOf(f));assert(c.profileLink.selectors.some(sel=>sel.kind==='mechanic'&&sel.values.some(x=>!vocab.mechanics.includes(x))),c.id+' the profile selector names a value outside the fingerprint schema');}
}
for(const category of ['boundary','prompt','global','versions','unknown','strict','cross-rule','provenance'])assert(predictionCases.some(c=>c.category===category),'prediction case for '+category);
for(const reason of predictionOutcome.keys())assert(predictionCases.some(c=>c.expected.reason===reason),'prediction case for '+reason);
for(const work of v.requiredWork)assert(predictionCases.some(c=>c.expected.requiredWork===work),'prediction case for '+work);
console.log(`fingerprint compatibility spec: ${fingerprintCases.length} fingerprint, ${predictionCases.length} prediction and ${declarations.length} declaration fixtures consistent with the live vocabularies`);
