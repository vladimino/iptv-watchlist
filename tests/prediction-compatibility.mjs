import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

// The shared prediction compatibility evaluator (ADR-0031 sections 2, 3, 6). It must reproduce every specification
// fixture with the live fingerprint vocabulary, fail closed on every unknown and never rewrite provenance.
const source=fs.readFileSync('src/domain/prediction-compatibility.js','utf8'),impactSource=fs.readFileSync('src/domain/profile-impact.js','utf8');
assert.doesNotMatch(source,/\bfetch\b|\bBUCKET\b|crypto|await|Date\.now/,'the evaluator stays pure');
assert.match(fs.readFileSync('build.mjs','utf8'),/profile-impact\.js'[^\n]*prediction-compatibility\.js/,'the Worker bundle includes the evaluator after the impact rules');
const ctx=vm.createContext({});
vm.runInContext(impactSource+'\n'+source+'\nglobalThis.E={predictionCompatibility,predictionImpactFeatures,predictionCanonicalGenres,predictionCompatibilityFresh,profileDeclarationText,profileLineage,PROFILE_GENRE_ALIASES,PROFILE_GENRE_DOMAINS,PROFILE_GENRES,PREDICTION_COMPATIBILITY_MODES};',ctx);
const E=ctx.E,plain=value=>JSON.parse(JSON.stringify(value));
const enrichment=fs.readFileSync('src/enrichment.js','utf8'),sources=fs.readFileSync('src/sources.js','utf8');
const literal=(text,name)=>Function('return '+text.match(new RegExp('(?:const |,)'+name+'=(\\[[^\\]]*\\]|\\{[^;]*?\\})(?=[;,])'))[1])();
const vocabulary={mechanics:literal(enrichment,'MECHANICS'),execution:literal(enrichment,'EXECUTION'),general:literal(enrichment,'GENERAL_EXECUTION')};
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const options={vocabulary,digest:sha256,fingerprintSchemaVersion:Number(enrichment.match(/FINGERPRINT_SCHEMA_VERSION=(\d+)/)[1]),predictionPromptVersion:Number(enrichment.match(/PREDICTION_PROMPT_VERSION=(\d+)/)[1])};
const deepFreeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const item of Object.values(value))deepFreeze(item);}return value;};

// Vocabulary: the evaluator's tables are the specification's, and every genre name the sources store maps.
const spec=JSON.parse(fs.readFileSync('tests/fixtures/profile-compatibility/cases.json','utf8'));
for(const [name,genre] of Object.entries(spec.vocabulary.genreAliases))assert.equal(E.PROFILE_GENRE_ALIASES[name],genre,name);
for(const genre of Object.values(E.PROFILE_GENRE_ALIASES))assert(E.PROFILE_GENRES.includes(genre),genre);
assert.deepEqual(plain(E.PROFILE_GENRE_DOMAINS),spec.vocabulary.genreDomains);
assert.deepEqual(plain(E.PROFILE_GENRES),spec.vocabulary.genres);
assert.deepEqual(plain(E.PREDICTION_COMPATIBILITY_MODES),spec.vocabulary.modes);
for(const name of Object.values(literal(sources,'GENRE_MAP')))assert(E.predictionCanonicalGenres([name]),'Letterboxd label '+name);
for(const name of Object.keys(literal(sources,'GENRE_MAP')))assert(E.predictionCanonicalGenres([name]),'English TMDB name '+name);
assert.deepEqual(plain(E.predictionCanonicalGenres(['Ужасы','ужасы ',' Триллер'])),['horror','thriller'],'case-folded, trimmed, distinct');
assert.equal(E.predictionCanonicalGenres([]),null);assert.equal(E.predictionCanonicalGenres(['Драма','Аниме']),null,'one unknown name makes the genres unknown');assert.equal(E.predictionCanonicalGenres(null),null);

// Every specification case, with its outcome, reason, chain length and untouched provenance.
const profileOf=name=>{const chain=spec.lineages[name],last=chain.at(-1);return {version:last.version,profileHash:last.profileHash,lineage:chain};};
for(const c of spec.cases){
 const prediction=deepFreeze({...spec.defaults.prediction,...c.prediction}),fingerprint=deepFreeze({...spec.defaults.fingerprint,...(c.fingerprint||{})});
 const profile=deepFreeze(structuredClone(profileOf(c.lineage))),features=deepFreeze(structuredClone(spec.features[c.features]));
 const out=plain(E.predictionCompatibility(prediction,fingerprint,features,profile,c.mode,options));
 assert.deepEqual([out.outcome,out.reason,out.links],[c.expected.outcome,c.expected.reason,c.expected.links],c.id);
 assert.deepEqual(out.originalProfile,{version:prediction.tasteProfileVersion,profileHash:prediction.tasteProfileHash},c.id+' keeps the original provenance');
 assert.deepEqual(out.evaluatedAgainst,{version:profile.version,profileHash:profile.profileHash},c.id);
 assert.equal(E.predictionCompatibilityFresh(out),c.expected.outcome!=='stale',c.id);
}

// Negative and boundary cases beyond the fixtures.
const chain=spec.lineages.mechanic,profile=profileOf('mechanic'),fp={...spec.defaults.fingerprint,plotMechanics:['investigation'],execution:{pace:'medium'}};
const old={...spec.defaults.prediction,tasteProfileVersion:1,tasteProfileHash:'h1'};
const features=E.predictionImpactFeatures(fp,['Драма']);
const run=(p=profile,o=options,f=features,mode='selective',pred=old,print=fp)=>plain(E.predictionCompatibility(pred,print,f,p,mode,o));
assert.equal(run().reason,'profile_unaffected');
assert.equal(run(profile,{...options,digest:undefined}).reason,'profile_impact_unknown','without a digest no approval can be verified');
assert.equal(run(profile,{...options,digest:()=>'0'.repeat(64)}).reason,'profile_impact_unknown','an approval the digest does not confirm is unknown');
const tampered=structuredClone(profile);tampered.lineage[1].changeImpact.selectors[0].values=['heist'];
assert.equal(run(tampered).reason,'profile_impact_unknown','a selector changed after approval invalidates the link');
const unapproved=structuredClone(profile);delete unapproved.lineage[1].changeImpact.approval;
assert.equal(run(unapproved).reason,'profile_impact_unknown');
const moved=structuredClone(profile);moved.lineage[1].profileHash='other';
assert.equal(run(moved).reason,'profile_chain_broken','a lineage that does not end at the current version is broken');
const unordered={version:2,profileHash:'h2',lineage:[chain[0],chain[1],{...chain[1]}]};
assert.equal(run(unordered).reason,'profile_chain_broken','versions must increase along the lineage');
assert.equal(run({version:2,profileHash:'h2'}).reason,'profile_outside_lineage','a current record without lineage carries nothing forward');
assert.equal(run(null).reason,'profile_outside_lineage');
assert.equal(run(profile,options,features,'selective',null).outcome,'stale');
assert.equal(run(profile,options,features,'shadow').reason,'profile_changed','an unknown mode is strict');
assert.equal(run(profile,options,{...features,fingerprintHash:'another'}).reason,'film_features_unknown','features of another fingerprint are unknown');
assert.equal(run(profile,options,null).reason,'film_features_unknown');
assert.equal(run(profile,options,features,'selective',{...old,tasteProfileVersion:'1'}).reason,'profile_provenance_mismatch','a non-numeric version is never matched');
assert.equal(run(profile,options,features,'selective',{...old,fingerprintSchemaVersion:0}).reason,'fingerprint_changed');
const identityChanged={version:3,profileHash:'h3',lineage:[...chain,{version:3,profileHash:'h3',changeImpact:{impactSchemaVersion:1,from:{version:2,profileHash:'h2'},scope:'identity',changedFields:[],selectors:[]}}]};
assert.equal(run(identityChanged).reason,'profile_impact_unknown','an identity link that changes the hash is unknown');
assert.equal(run({...identityChanged,lineage:[...chain,{...identityChanged.lineage[2],changeImpact:{...identityChanged.lineage[2].changeImpact,scope:'global',selectors:[{kind:'genre',values:['horror']}]}}]}).reason,'profile_impact_unknown','a global link with selectors is malformed');

// Absent genre-specific dimensions: unaffected only when the genres prove the film is outside the dimension's genre.
const horrorRule=profileOf('positiveSignalsHorrorRule'),before={...old};
const absent=genres=>run(horrorRule,options,E.predictionImpactFeatures({...fp,execution:{pace:'medium'}},genres),'selective',before).reason;
assert.equal(absent(['Драма','Криминал']),'profile_unaffected');
assert.equal(absent(['Драма','Ужасы']),'film_features_unknown');
assert.equal(absent(['horror']),'film_features_unknown','English names count too');
assert.equal(absent([]),'film_features_unknown');
assert.equal(absent(['Драма','Нуар']),'film_features_unknown');
assert.equal(run(horrorRule,options,E.predictionImpactFeatures({...fp,execution:{pace:'medium',horror_rule_consistency:'strong'}},['Ужасы']),'selective',before).reason,'profile_unaffected','a present value outside the selector does not reach');
assert.equal(run(horrorRule,options,E.predictionImpactFeatures({...fp,execution:{pace:'medium',horror_rule_consistency:'unknown'}},['Драма']),'selective',before).reason,'film_features_unknown','an unknown value is unknown in any genre');
// A missing general dimension is unknown regardless of genres.
const paceProfile=profileOf('execution');
assert.equal(run(paceProfile,options,E.predictionImpactFeatures({...fp,execution:{}},['Драма']),'selective',{...old,tasteProfileVersion:4,tasteProfileHash:'h4'}).reason,'film_features_unknown');

// Feature extraction copies, never aliases, and keeps unknown and not_applicable values.
const stored=deepFreeze({fingerprintHash:'f1',plotMechanics:['heist'],execution:{pace:'unknown',opposition_competence:'not_applicable'}});
const extracted=E.predictionImpactFeatures(stored,['Драма']);
assert.deepEqual(plain(extracted),{fingerprintHash:'f1',plotMechanics:['heist'],execution:{pace:'unknown',opposition_competence:'not_applicable'},genres:['Драма']});
assert.notEqual(extracted.plotMechanics,stored.plotMechanics);
assert.equal(E.predictionImpactFeatures({fingerprintHash:'f1'},null).plotMechanics,undefined,'an absent mechanics list stays absent');

// End to end with the publisher's own lineage and canonical declaration: an approved selective version carries an
// unreached prediction forward, and strict mode (the rollback) turns it stale again without touching the record.
const declare=(impact,to)=>({...impact,approval:{approvedBy:'owner',approvedAt:'2026-10-27T21:00:00.000Z',reviewRef:'trello-comment:test',declarationSha256:sha256(E.profileDeclarationText(impact,to))}});
const v1={version:1,profileHash:'p1',changeImpact:null},v1current={...v1,lineage:E.profileLineage(null,v1)};
const v2={version:2,profileHash:'p2',changeImpact:declare({impactSchemaVersion:1,from:{version:1,profileHash:'p1'},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']}]},{version:2,profileHash:'p2'})};
const v2current={...v2,lineage:E.profileLineage(v1current,v2)};
const record=deepFreeze({...spec.defaults.prediction,tasteProfileVersion:1,tasteProfileHash:'p1',predictedRating:4});
const drama=E.predictionImpactFeatures(fp,['Драма']),horror=E.predictionImpactFeatures(fp,['Ужасы']);
assert.deepEqual([run(v2current,options,drama,'selective',record).outcome,run(v2current,options,horror,'selective',record).outcome,run(v2current,options,drama,'strict',record).reason],['compatible','stale','profile_changed']);
assert.equal(record.tasteProfileVersion,1,'the prediction record keeps its original version');
const v3={version:3,profileHash:'p1',changeImpact:declare({impactSchemaVersion:1,from:{version:2,profileHash:'p2'},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']}]},{version:3,profileHash:'p1'})};
const v3current={...v3,lineage:E.profileLineage(v2current,v3)};
assert.equal(run(v3current,options,horror,'selective',record).reason,'content_identical','restored content carries the original prediction');
assert.equal(run(v3current,options,horror,'selective',{...record,tasteProfileVersion:2,tasteProfileHash:'p2'}).reason,'profile_impacted','a prediction under the reverted rules is stale');
console.log(`Prediction compatibility: ${spec.cases.length} specification cases, vocabulary alignment, approval re-check on every link, chain integrity, absent genre dimensions, feature extraction, publisher lineage end to end and strict rollback passed`);
