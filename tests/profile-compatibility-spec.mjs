import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// Specification fixtures for selective prediction compatibility (ADR-0030). They hold no evaluator: this test only keeps them
// internally consistent and aligned with the live fingerprint and profile vocabularies, so the evaluator and publisher built
// later are tested against cases that use real mechanic, execution, genre and profile field names.
const spec=JSON.parse(fs.readFileSync('tests/fixtures/profile-compatibility/cases.json','utf8'));
const enrichment=fs.readFileSync('src/enrichment.js','utf8'),sources=fs.readFileSync('src/sources.js','utf8');
const literal=(text,name)=>{const match=text.match(new RegExp('(?:const |,)'+name+'=(\\[[^\\]]*\\]|\\{[^;]*?\\})(?=[;,])'));assert(match,name+' literal found');return Function('return '+match[1])();};
const MECHANICS=literal(enrichment,'MECHANICS'),EXECUTION=literal(enrichment,'EXECUTION'),GENERAL=literal(enrichment,'GENERAL_EXECUTION');
const GENRE_DIMENSIONS=Object.keys(EXECUTION).filter(key=>!GENERAL.includes(key));
const PROFILE_FIELDS=Function('return '+enrichment.match(/function validateProfile\(p\)\{[\s\S]*?for\(const key of (\[[^\]]*\])\)if\(!\(key in p\)\)/)[1])();
const GENRE_MAP=literal(sources,'GENRE_MAP');
const {vocabulary:v,fieldRules,lineages,features,cases,publications}=spec;

assert.equal(spec.specVersion,1);
assert(fs.existsSync(spec.decision),'the fixtures name an existing ADR');
assert.equal(JSON.stringify(spec).match(/https?:\/\//),null,'no URL in the fixtures');

// Profile fields: every field the publisher validates has exactly one rule, global or with permitted selector kinds.
assert.deepEqual(Object.keys(fieldRules).sort(),[...PROFILE_FIELDS].sort(),'one rule per published profile field');
for(const [field,rule] of Object.entries(fieldRules)){
 if(rule.scope){assert.equal(rule.scope,'global',field);assert.equal(rule.kinds,undefined,field);continue;}
 assert(rule.kinds.length&&rule.kinds.every(kind=>v.selectorKinds.includes(kind)),field+' kinds');
 for(const dimension of rule.dimensions||[])assert(dimension in EXECUTION,field+' dimension '+dimension);
 if(rule.genreFloor){
  assert(rule.genreFloor.every(genre=>v.genres.includes(genre)),field+' floor');
  assert((rule.dimensions||[]).every(dimension=>GENRE_DIMENSIONS.includes(dimension)),field+' permits only its genre-specific dimensions');
 }
}
assert.deepEqual(Object.entries(fieldRules).filter(([,rule])=>rule.scope==='global').map(([field])=>field).sort(),['anchorFilms','calibration','ratingScale']);

// Genres: every stored genre name the sources produce maps to the closed vocabulary.
for(const value of Object.values(v.genreAliases))assert(v.genres.includes(value),'alias target '+value);
for(const name of Object.values(GENRE_MAP))assert(name.toLowerCase() in v.genreAliases,'stored genre '+name+' has an alias');

// Genre-specific dimensions: each has a closed genre domain, so an absent dimension is proved irrelevant only by known genres outside it.
assert.deepEqual(Object.keys(v.genreDomains).sort(),[...GENRE_DIMENSIONS].sort(),'one domain per genre-specific dimension');
for(const [dimension,domain] of Object.entries(v.genreDomains))assert(domain.length&&domain.every(genre=>v.genres.includes(genre)),dimension);
for(const [field,rule] of Object.entries(fieldRules))if(rule.genreFloor)for(const dimension of rule.dimensions)assert(v.genreDomains[dimension].every(genre=>rule.genreFloor.includes(genre)),field+' floor covers '+dimension);

// Owner approval: a selective declaration is bound by SHA-256 to the transition and its exact content.
const digest=(impact,to)=>createHash('sha256').update(JSON.stringify([impact.from.version,impact.from.profileHash,to.version,to.profileHash,impact.scope,[...impact.changedFields].sort(),impact.selectors])).digest('hex');
const approved=(impact,to)=>!!impact.approval&&impact.approval.approvedBy==='owner'&&!!impact.approval.reviewRef&&!!impact.approval.approvedAt&&impact.approval.declarationSha256===digest(impact,to);

// Reasons belong to exactly one outcome.
const reasonOutcome=new Map();
for(const [outcome,reasons] of Object.entries(v.reasons)){assert(v.outcomes.includes(outcome));for(const reason of reasons){assert(!reasonOutcome.has(reason),reason);reasonOutcome.set(reason,outcome);}}

// Selectors: valid ones use real vocabulary; invalid ones appear only in lineages whose cases expect profile_impact_unknown.
const selectorValid=selector=>selector.kind==='mechanic'?selector.values.length>0&&selector.values.every(value=>MECHANICS.includes(value))
 :selector.kind==='execution'?selector.dimension in EXECUTION&&selector.values.length>0&&selector.values.every(value=>EXECUTION[selector.dimension].includes(value)&&!['unknown','not_applicable'].includes(value))
 :selector.kind==='genre'?selector.values.length>0&&selector.values.every(value=>v.genres.includes(value)):false;
const impactValid=(impact,to)=>!!impact&&impact.impactSchemaVersion===1&&v.scopes.includes(impact.scope)&&impact.selectors.every(selectorValid)&&(impact.scope!=='selective'||impact.selectors.length>0&&approved(impact,to));
for(const [name,versions] of Object.entries(lineages)){
 assert(versions.length>=2,name);
 for(let i=1;i<versions.length;i++){
  assert(versions[i].version>versions[i-1].version,name+' versions increase');
  const impact=versions[i].changeImpact;
  if(!impactValid(impact,versions[i]))assert(cases.some(c=>c.lineage===name&&c.expected.reason==='profile_impact_unknown'),name+' carries an invalid impact only for unknown cases');
  if(impact?.scope==='identity')assert.equal(impact.from.profileHash,versions[i].profileHash,name+' identity keeps the hash');
 }
}
for(const [name,value] of Object.entries(features)){
 if(value.plotMechanics)assert(value.plotMechanics.every(m=>MECHANICS.includes(m)),name);
 for(const [dimension,level] of Object.entries(value.execution||{}))assert(EXECUTION[dimension]?.includes(level),name+' '+dimension);
}

// Evaluation cases: closed vocabulary, every reference resolves, and every behaviour the ADR names is covered.
const ids=new Set();
for(const c of cases){
 assert(!ids.has(c.id),'unique '+c.id);ids.add(c.id);
 assert(v.modes.includes(c.mode),c.id);assert(c.lineage in lineages,c.id);assert(c.features in features,c.id);
 assert.equal(reasonOutcome.get(c.expected.reason),c.expected.outcome,c.id+' reason matches outcome');
 assert(Number.isInteger(c.expected.links)&&c.expected.links>=0,c.id);
 const chain=lineages[c.lineage],current=chain.at(-1),start=chain.findIndex(item=>item.version===c.prediction.tasteProfileVersion);
 if(c.expected.reason==='exact')assert.deepEqual([c.prediction.tasteProfileVersion,c.prediction.tasteProfileHash],[current.version,current.profileHash],c.id);
 if(c.expected.reason==='profile_outside_lineage')assert.equal(start,-1,c.id);
 if(c.expected.reason==='profile_ahead')assert(c.prediction.tasteProfileVersion>current.version,c.id);
 if(c.expected.outcome==='compatible'){assert.equal(c.mode,'selective',c.id+': strict mode never carries a prediction forward');assert.equal(chain[start].profileHash,c.prediction.tasteProfileHash,c.id+' original provenance is a published record');assert.equal(c.expected.links,chain.length-1-start,c.id+' links');}
}
for(const category of ['exact','mechanic','execution','genre','global','unknown','rollback','transitive','non-profile'])assert(cases.some(c=>c.category===category),'covers '+category);
for(const reasons of Object.values(v.reasons))for(const reason of reasons)assert(cases.some(c=>c.expected.reason===reason),'case for '+reason);

// Publication cases: every rejection code is exercised once at least, accepted impacts are valid.
const pids=new Set();
for(const p of publications){
 assert(!pids.has(p.id),'unique '+p.id);pids.add(p.id);
 assert(v.publication.decisions.includes(p.expected.decision),p.id);
 assert(p.next.version>p.previous.version,p.id);
 for(const field of p.actualChangedFields)assert(field in fieldRules,p.id+' '+field);
 if(p.expected.decision==='accept'){assert(impactValid(p.changeImpact,p.next),p.id);assert.equal(p.expected.code,undefined,p.id);}
 else assert(v.publication.codes.includes(p.expected.code),p.id);
}
for(const code of v.publication.codes)assert(publications.some(p=>p.expected.code===code),'publication case for '+code);
console.log(`profile compatibility spec: ${cases.length} evaluation and ${publications.length} publication fixtures consistent with the live vocabularies`);
