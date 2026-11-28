// AIR-665 / ADR 0218 decision 4: one fixture per readiness rule (G1-G3, D1-D4, C1-C5, P1-P7), first-match order, usable-value rules, purity. Pure bodies in the
// shape of FilmAggregateV1 (src/film-aggregate.js); no D1, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {displayReady,catalogReady,predictionReady,deriveReadiness,usableCoreField,usableTitle,CORE_FIELDS} from '../src/film-readiness.js';

const lid={scheme:'letterboxd',value:'abc',trusted:true,conflicting:false};
const tmdb={scheme:'tmdb',value:'1',trusted:true,conflicting:false};
const tv={scheme:'tmdb_tv',value:'9',trusted:true,conflicting:false};
const present=value=>({status:'present',value,provenance:'unknown'});
const unknown={status:'unknown',provenance:'unknown'};
const fields=(over={})=>({title:unknown,originalTitle:unknown,...Object.fromEntries(CORE_FIELDS.map(n=>[n,unknown])),...over});
const body=({verdict='found',claims=[lid],display={status:'partial',fields:fields()},predictions={status:'partial',coverage:{status:'incomplete'}}}={})=>({contract:'film-aggregate/v1',identity:{verdict,claims},display,predictions});
const at=(fn,b,rule,value,reason,extra)=>{const r=fn(b,extra);assert.deepEqual([r.rule,r.value,r.reason],[rule,value,reason??null],rule);};

// Gate: every verdict, for all three predicates.
for(const fn of [displayReady,catalogReady,predictionReady]){
 at(fn,body({verdict:'unavailable'}),'G1','unknown','identity_unavailable');
 for(const v of ['absent','retired','conflict','unverified','cycle'])at(fn,body({verdict:v}),'G2','not_applicable',v);
 at(fn,{identity:{verdict:'invalid'}},'G1','unknown','identity_not_resolved');
}
// A retired or conflicting request that carries a verified lid is not ready, however complete the sections are.
at(displayReady,body({verdict:'retired',display:{status:'present',fields:fields({title:present('X')})}}),'G2','not_applicable','retired');
at(displayReady,body({verdict:'redirected',display:{status:'present',fields:fields({title:present('X')})}}),'D1',true);

// displayReady D1-D4
at(displayReady,body({display:{status:'partial',fields:fields({title:present('Heat')})}}),'D1',true);
at(displayReady,body({display:{status:'partial',fields:fields({originalTitle:present('Heat')})}}),'D1',true);
at(displayReady,body({display:{status:'partial',fields:fields({title:present('  '),originalTitle:present('')})}}),'D4','unknown','title_unknown');
at(displayReady,body({display:{status:'unavailable',reason:'generation_moved'}}),'D2','unknown','display_unavailable');
at(displayReady,body({display:{status:'partial',fields:fields({title:{status:'absent'},originalTitle:{status:'absent'}})}}),'D3',false,'no_title');
at(displayReady,body({display:{status:'conflict',fields:fields({title:{status:'conflict'}})}}),'D4','unknown','title_unknown');
at(displayReady,{...body(),display:undefined},'D2','unknown','display_unavailable');

// catalogReady C1-C5
at(catalogReady,body({claims:[tv],display:{status:'present',fields:fields({year:present(1995)})}}),'C1',false,'no_stable_alias');
at(catalogReady,body({claims:[{...lid,trusted:false}]}),'C1',false,'no_stable_alias');
at(catalogReady,body({claims:[{...tmdb,retired:true}]}),'C1',false,'no_stable_alias');
at(catalogReady,body({claims:[tmdb],display:{status:'partial',fields:fields({year:present(1995)})}}),'C2',true);
at(catalogReady,body({display:{status:'unavailable'}}),'C3','unknown','display_unavailable');
at(catalogReady,body({display:{status:'partial',fields:fields(Object.fromEntries(CORE_FIELDS.map(n=>[n,{status:'absent'}])))}}),'C4',false,'no_core_metadata');
at(catalogReady,body({display:{status:'partial',fields:fields({year:{status:'absent'}})}}),'C5','unknown','metadata_unknown');
// A usable positive wins over partial coverage of the others.
at(catalogReady,body({display:{status:'partial',fields:fields({poster:present('p.jpg'),year:{status:'absent'}})}}),'C2',true);
// Unusable values are unknown, never present and never absent.
for(const [n,v] of [['year',0],['year','1995'],['runtime',-1],['synopsis',''],['poster','  '],['url',null],['genres',[]],['genres',['']],['genres','[]']]){
 assert.equal(usableCoreField(n,v),false,n+JSON.stringify(v));
 at(catalogReady,body({display:{status:'partial',fields:fields({[n]:present(v)})}}),'C5','unknown','metadata_unknown');
}
assert.equal(usableCoreField('genres',['Drama']),true);assert.equal(usableCoreField('runtime',120),true);assert.equal(usableTitle(' x '),true);assert.equal(usableTitle(5),false);

// predictionReady P1-P7. P3/P5/P6 need an OBSERVATION (predictionEvidence) that coheres with an independently supplied, already fenced CONTEXT.
import {predictionEvidence,checkPredictionEvidence,authorizedStorageIds,PREDICTION_EVIDENCE_CONTRACT} from '../src/film-readiness.js';
const IT={generation:1,readSet:'sha256:i'},TOKEN={generation:1,pointers:'sha256:a'},CTOKEN='c1';
const P=(status,coverage='complete',extra={})=>({...body(),identity:{verdict:'found',filmId:'film:1',claims:[lid,tmdb],token:IT},predictions:{status,token:TOKEN,coverage:{status:coverage,token:CTOKEN},current:[{storageId:'abc',tasteProfileVersion:3}],...extra}});
const ids=['abc','tmdb_1'];
const CTX={identityToken:IT,profile:{version:4,hash:'p4'},registryToken:'r1',fingerprintToken:'f1',examinedStorageIds:ids};
const FACTS={fingerprint:{status:'present',storageIds:['abc']},compatibility:'compatible'};
const CAPTURED={filmId:'film:1',identityToken:IT,predictionToken:TOKEN,coverageToken:CTOKEN,profile:CTX.profile,registryToken:'r1',fingerprintToken:'f1',examinedStorageIds:ids};
const ev=(over={},facts=FACTS)=>({...predictionEvidence(facts,CAPTURED),...over});
const absent={fingerprint:{status:'absent'},compatibility:'unknown'};
const run=(b,e,c=CTX)=>predictionReady(b,e,c);
const atP=(b,rule,value,reason,e,c=CTX)=>{const r=run(b,e,c);assert.deepEqual([r.rule,r.value,r.reason],[rule,value,reason??null],rule+' '+reason);};
assert.deepEqual(authorizedStorageIds(P('present').identity),ids);
assert.equal(ev().contract,PREDICTION_EVIDENCE_CONTRACT);
assert.equal(checkPredictionEvidence(P('present'),ev(),CTX),null);
atP({...P('present'),predictions:{status:'unavailable'}},'P1','unknown','prediction_unavailable');
atP(P('present'),'P1','unknown','prediction_unavailable',ev({fingerprint:'unavailable'},{fingerprint:{status:'unavailable'}}));
// P2 has priority over a proved-absent fingerprint, whatever the coverage.
atP(P('conflict','incomplete'),'P2','unknown','conflict',ev({},absent));
atP(P('conflict','complete'),'P2','unknown','conflict',ev({},absent));
atP(P('partial','complete'),'P3',false,'fingerprint_absent',ev({},absent));
// P4 needs only the aggregate: independent of any evidence, valid or not, supplied or not.
for(const [e,c] of [[undefined,undefined],[ev({filmId:'film:2'}),CTX],[{bare:1},null]])atP(P('absent','complete',{reason:'none'}),'P4',false,'prediction_absent',e,c);
atP(P('present'),'P5',false,'incompatible',ev({},{fingerprint:{status:'present',storageIds:['abc']},compatibility:'incompatible'}));
// P5 needs no presence guard: a proved incompatible verdict follows P1-P4 even with unknown fingerprint and a partial section / incomplete coverage.
atP(P('partial','incomplete'),'P5',false,'incompatible',ev({},{fingerprint:{status:'unknown'},compatibility:'incompatible'}));
atP(P('present'),'P6',true,null,ev());
// Incomplete aggregate coverage with a present prediction stays unknown; so do unknown compatibility and unknown fingerprint.
atP(P('present','incomplete'),'P7','unknown','coverage_incomplete',ev());
atP(P('present'),'P7','unknown','compatibility_unknown',ev({},{fingerprint:{status:'present',storageIds:['abc']},compatibility:'unknown'}));
atP(P('present'),'P7','unknown','fingerprint_unknown',ev({},{fingerprint:{status:'unknown'},compatibility:'compatible'}));
atP(P('present'),'P7','unknown','fingerprint_unknown',undefined,null);
// Bare strings and an observation without a context are not evidence.
atP(P('present'),'P7','unknown','prediction_evidence_shape',{fingerprint:'present',compatibility:'compatible'});
atP(P('present'),'P7','unknown','prediction_context_missing',ev(),null);
// The evidence is compared with the EXPECTED context, never with values it carries itself. Same pointer, same aggregate tokens, but:
const stale=[
 ['prediction_evidence_profile_changed',ev(),{...CTX,profile:{version:5,hash:'p5'}}],                       // active profile moved v4 -> v5
 ['prediction_evidence_profile_changed',ev(),{...CTX,profile:{version:4,hash:'other'}}],                    // same version, different hash
 ['prediction_evidence_profile_changed',ev(),{...CTX,registryToken:'r2'}],                                  // compatibility registry changed
 ['prediction_evidence_fingerprint_changed',ev(),{...CTX,fingerprintToken:'f2'}],                           // fingerprint changed only
 ['prediction_evidence_identity_moved',ev(),{...CTX,identityToken:{generation:2,readSet:'sha256:j'}}],      // identity moved
 ['prediction_evidence_identity_moved',ev({identityToken:{generation:2,readSet:'sha256:j'}}),CTX],
 ['prediction_evidence_token_moved',ev({predictionToken:{generation:2,pointers:'sha256:b'}}),CTX],
 ['prediction_evidence_token_moved',ev({coverageToken:'c2'}),CTX],
 ['prediction_evidence_foreign_film',ev({filmId:'film:2'}),CTX],
 ['prediction_evidence_foreign_film',ev({fingerprintStorageIds:['other']}),CTX],
 ['prediction_evidence_incomplete_fingerprint_coverage',ev({examinedStorageIds:['abc']}),CTX],              // read omitted an authorized id
 ['prediction_evidence_incomplete_fingerprint_coverage',ev(),{...CTX,examinedStorageIds:['abc']}],
 ['prediction_evidence_incomplete_fingerprint_coverage',ev({examinedStorageIds:[]}),{...CTX,examinedStorageIds:[]}],
 ['prediction_evidence_incoherent',ev({fingerprint:'absent',fingerprintStorageIds:['abc']}),CTX],
];
for(const [reason,e,c] of stale){
 atP(P('present'),'P7','unknown',reason,e,c);                                                               // positive not certified
 if(!e.fingerprintStorageIds.length)atP(P('partial'),'P7','unknown',reason,{...e,fingerprint:'absent',compatibility:'incompatible'},c); // neither P3 nor P5 certified
}
// Missing or null proof is never equal to another missing or null proof.
for(const key of ['identityToken','predictionToken','coverageToken','profile','registryToken','fingerprintToken'])for(const v of [undefined,null,'',{}]){
 const e=ev({[key]:v}),c={...CTX,...(key in CTX?{[key]:v}:{})};
 assert.notEqual(run(P('present'),e,c).rule,'P6',key+String(v));
 assert.equal(run(P('present'),e,c).value,'unknown',key+String(v));
}
// Absent tokens in the body as well: an aggregate that states no token certifies nothing.
{const b=P('present');delete b.predictions.token;const r=run(b,ev({predictionToken:undefined}));assert.equal(r.value,'unknown');}
// A genuinely complete fingerprint absence (every authorized id examined, tokens agree) versus an omitted or unreadable read.
atP(P('partial','complete'),'P3',false,'fingerprint_absent',ev({},absent));
atP(P('partial','complete'),'P7','unknown','prediction_evidence_incomplete_fingerprint_coverage',ev({examinedStorageIds:['abc']},absent));
atP(P('partial','complete'),'P1','unknown','prediction_unavailable',ev({},{fingerprint:{status:'unavailable'},compatibility:'unknown'}));
atP({...P('present'),predictions:{status:'unavailable',reason:'generation_moved'}},'P1','unknown','prediction_unavailable',ev());
for(const s of ['present','partial','unknown'])assert.notEqual(predictionReady(P(s)).value,true);

// Report: provenance and freshness beside readiness, never required by it; the derivation does not mutate its input.
const b=body({display:{status:'partial',fields:fields({title:present('Heat'),year:{...present(1995),provenance:'unattributed'}})}});
const frozen=JSON.stringify(b);
const d=deriveReadiness(b);
assert.equal(JSON.stringify(b),frozen);
assert.equal(d.displayReady.value,true);assert.equal(d.freshness,'unknown');assert.equal(d.provenance.year,'unattributed');assert.equal(d.catalogReady.value,true);

// Dormant and pure: no import of D1/R2/network modules (so it is scoped as is). AIR-648 scopes it into the Worker bundle through scopedFilmAggregate() only (build.mjs names no readiness file), unrouted.
const src=fs.readFileSync('src/film-readiness.js','utf8');
assert.ok(!/^import\s/m.test(src),'no imports');
assert.ok(!fs.readFileSync('build.mjs','utf8').includes('src/film-readiness.js'),'build.mjs names no readiness file: only scopedFilmAggregate() scopes it');
assert.ok(fs.readFileSync('scripts/bundle-scope.mjs','utf8').includes("scoped('src/film-readiness.js','FilmReadiness')"),'the bundle scopes it, unrouted');
console.log('film-readiness: ok');
