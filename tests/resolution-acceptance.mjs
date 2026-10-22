import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const scorer=fs.readFileSync('src/domain/scored-resolution.js','utf8');
const gate=fs.readFileSync('src/domain/resolution-acceptance.js','utf8');
assert.doesNotMatch(gate,/\b(fetch|import|export|BUCKET|wrangler)\b/);
assert.doesNotMatch(gate,/resolutionActionability|candidateActivity|candidateEvidence/);
for(const file of ['src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','build.mjs'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/resolution-acceptance|acceptScoredIdentity/,file);
const ctx=vm.createContext({Map,Set,JSON});
vm.runInContext(scorer+'\n'+gate+'\nglobalThis.api={scoreFilmResolution,acceptScoredIdentity};',ctx);
const film=(tmdbId,title,year,runtime,extra={})=>({tmdbId,title,original:title,year,runtime,...extra});
const observe=(key,title,year,duration)=>({key,title,normalizedTitle:title.toLowerCase(),year,duration,durations:[duration]});
function score(observation,candidates){ctx.observation=observation;ctx.candidates=candidates;return vm.runInContext('scoreFilmResolution({observation,candidates})',ctx);}
function accept(input){ctx.input=input;return vm.runInContext('acceptScoredIdentity(input)',ctx);}
const pinned={pinnedProgrammeRunId:'run-b',observationProgrammeRunId:'run-b'};
const current={eligible:true,activity:'current',evidenceChanged:false};

let scored=score(observe('dune|1984','Dune',1984,137),[film('11','Dune',1984,137,{trusted:true}),film('438631','Dune',2021,155)]);
assert.equal(scored.status,'accepted');
assert.equal(scored.acceptedTmdbId,'11');
const unverified=accept({score:scored,...pinned,discovery:current,film:{id:'film:new',canonicalIdentity:null,externalIds:[]}});
assert.equal(unverified.outcome,'needs_verification');
assert.equal(unverified.linkEvidence,null);
assert.equal(unverified.filmChange,null);
assert.equal(unverified.transition,null);
assert.equal(unverified.candidateDecision,null);
assert.equal(unverified.scoring.status,'accepted');
assert.equal(unverified.scoring.acceptedTmdbId,'11');
assert.equal(unverified.provenance.observationKey,'dune|1984');
assert.notEqual(unverified.provenance.observationKey,unverified.scoring.acceptedTmdbId);
assert.equal(scored.considered.some(row=>row.trusted===true),true);

const forced=JSON.parse(JSON.stringify(scored));
forced.considered=forced.considered.map(row=>({...row,trusted:true}));
const stillUnverified=accept({score:forced,...pinned,discovery:current});
assert.equal(stillUnverified.outcome,'needs_verification');
assert.equal(stillUnverified.linkEvidence,null);

const fromScore=accept({score:scored,...pinned,confirmation:{confirmed:true,tmdbId:'11',source:'score'}});
assert.equal(fromScore.outcome,'needs_verification');

const otherKey=accept({score:{...scored,observationKey:'dune|other'},...pinned,discovery:current});
assert.equal(otherKey.outcome,'needs_verification');
assert.equal(otherKey.observationKey,'dune|other');
assert.notEqual(otherKey.provenance.observationKey,unverified.provenance.observationKey);
assert.equal(otherKey.scoring.acceptedTmdbId,unverified.scoring.acceptedTmdbId);

const confirmed=accept({score:scored,...pinned,discovery:current,confirmation:{confirmed:true,tmdbId:'11',source:'verified_record'},film:{id:'film:28nq',canonicalIdentity:null,externalIds:[{scheme:'letterboxd',value:'28nq',trusted:true,conflicting:false}]}});
assert.equal(confirmed.outcome,'trusted_acceptance');
assert.equal(confirmed.linkEvidence,null);
assert.equal(confirmed.filmChange,null);
assert.equal(confirmed.transition.kind,'identity_transition');
assert.equal(confirmed.transition.tmdbId,'11');
assert.equal(confirmed.transition.observationKey,'dune|1984');
assert.equal(confirmed.transition.programmeRunId,'run-b');
assert.notEqual(confirmed.transition.verified,true);
assert.deepEqual(confirmed.scoring,unverified.scoring);
const again=accept({score:scored,...pinned,discovery:current,confirmation:{confirmed:true,tmdbId:'11',source:'verified_record'},film:{id:'film:28nq',canonicalIdentity:'tmdb:11',externalIds:[{scheme:'tmdb',value:'11',trusted:true,conflicting:false}]},appliedObservationKeys:['dune|1984']});
assert.equal(again.outcome,'already_applied');
assert.equal(again.filmChange,null);
assert.equal(again.transition,null);
assert.deepEqual(accept({score:scored,...pinned,discovery:current}),accept({score:scored,...pinned,discovery:current}));

const collided=accept({score:scored,...pinned,confirmation:{confirmed:true,tmdbId:'11',source:'verified_record'},film:{id:'film:other',canonicalIdentity:'tmdb:999',externalIds:[{scheme:'tmdb',value:'999',trusted:true,conflicting:false}]}});
assert.equal(collided.outcome,'refused');
assert.equal(collided.reason,'identity_collision');
assert.equal(collided.filmChange,null);
const stale=accept({score:scored,pinnedProgrammeRunId:'run-b',observationProgrammeRunId:'run-a',confirmation:{confirmed:true,tmdbId:'11',source:'verified_record'}});
assert.equal(stale.outcome,'refused');
assert.equal(stale.reason,'stale_generation');
assert.equal(stale.filmChange,null);
const noKey=accept({score:{...scored,observationKey:null},...pinned});
assert.equal(noKey.outcome,'refused');
assert.equal(noKey.reason,'missing_observation_key');

const year=score(observe('dune|1984','Dune',1984,137),[film('438631','Dune',2021,155)]);
assert.equal(year.status,'contradicted');
assert.equal(year.reason,'contradicted_year');
const yearGate=accept({score:year,...pinned,discovery:current});
assert.equal(yearGate.outcome,'candidate_decision');
assert.equal(yearGate.candidateDecision.status,'no_confident_match');
assert.equal(yearGate.candidateDecision.reason,'contradicted_year');
assert.equal(yearGate.candidateDecision.evidence.status,'contradicted');
assert.equal(yearGate.scoring.status,'contradicted');
assert.equal(yearGate.filmChange,null);

const runtime=score(observe('stalker|1979','Stalker',1979,162),[film('2','Stalker',1979,80)]);
assert.equal(runtime.reason,'contradicted_runtime');
const runtimeGate=accept({score:runtime,...pinned});
assert.equal(runtimeGate.candidateDecision.status,'duration_mismatch');
assert.equal(runtimeGate.candidateDecision.evidence.reason,'contradicted_runtime');
assert.equal(runtimeGate.scoring.reason,'contradicted_runtime');

const ambiguous=score(observe('dune|','Dune',null,137),[film('11','Dune',1984,137),film('438631','Dune',2021,155)]);
assert.equal(ambiguous.status,'ambiguous');
const ambiguousGate=accept({score:ambiguous,...pinned,discovery:{eligible:false,activity:'historical',evidenceChanged:false}});
assert.equal(ambiguousGate.candidateDecision.status,'ambiguous');
assert.equal(ambiguousGate.candidateDecision.reason,ambiguous.reason);
assert.equal(ambiguousGate.candidateDecision.evidence.status,'ambiguous');
assert.equal(ambiguousGate.provenance.discovery.activity,'historical');

const none=score(observe('missing|1999','Missing Film',1999,100),[]);
assert.equal(none.status,'no_confident_match');
const noneGate=accept({score:none,...pinned});
assert.equal(noneGate.candidateDecision.status,'no_confident_match');
assert.equal(noneGate.candidateDecision.evidence.status,'no_confident_match');
assert.equal(noneGate.scoring.observationKey,'missing|1999');

const held={id:'film:28nq',canonicalIdentity:'tmdb:11',externalIds:[{scheme:'tmdb',value:'11',trusted:true,conflicting:false}]};
const before=JSON.stringify(held);
accept({score:scored,...pinned,film:held,confirmation:{confirmed:true,tmdbId:'11',source:'verified_record'}});
assert.equal(JSON.stringify(held),before);

console.log('Scored identity acceptance passed.');
