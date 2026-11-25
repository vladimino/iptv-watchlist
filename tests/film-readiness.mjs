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

// predictionReady P1-P7
const cov=status=>({status});
const P=(status,coverage='complete',extra={})=>body({predictions:{status,coverage:cov(coverage),...extra}});
at(predictionReady,body({predictions:{status:'unavailable'}}),'P1','unknown','prediction_unavailable');
at(predictionReady,P('present'),'P1','unknown','prediction_unavailable',{fingerprint:'unavailable'});
at(predictionReady,P('conflict','incomplete'),'P2','unknown','conflict',{fingerprint:'absent'});
at(predictionReady,P('partial','complete'),'P3',false,'fingerprint_absent',{fingerprint:'absent'});
at(predictionReady,P('partial','incomplete'),'P7','unknown','fingerprint_unknown',{fingerprint:'absent'});
at(predictionReady,P('absent','complete',{reason:'none'}),'P4',false,'prediction_absent',{fingerprint:'present'});
at(predictionReady,P('present'),'P5',false,'incompatible',{fingerprint:'present',compatibility:'incompatible'});
at(predictionReady,P('present'),'P6',true,null,{fingerprint:'present',compatibility:'compatible'});
// Incomplete coverage with a present prediction stays unknown (an unseen candidate could hold a conflicting pointer), and so does unknown compatibility.
at(predictionReady,P('present','incomplete'),'P7','unknown','coverage_incomplete',{fingerprint:'present',compatibility:'compatible'});
at(predictionReady,P('present'),'P7','unknown','compatibility_unknown',{fingerprint:'present'});
at(predictionReady,P('present'),'P7','unknown','fingerprint_unknown');
// Without the prediction-domain verdicts a negative is never inferred and the result is never true.
for(const s of ['present','partial','unknown'])assert.notEqual(predictionReady(P(s)).value,true);

// Report: provenance and freshness beside readiness, never required by it; the derivation does not mutate its input.
const b=body({display:{status:'partial',fields:fields({title:present('Heat'),year:{...present(1995),provenance:'unattributed'}})}});
const frozen=JSON.stringify(b);
const d=deriveReadiness(b);
assert.equal(JSON.stringify(b),frozen);
assert.equal(d.displayReady.value,true);assert.equal(d.freshness,'unknown');assert.equal(d.provenance.year,'unattributed');assert.equal(d.catalogReady.value,true);

// Dormant and pure: not bundled, no import of D1/R2/network modules.
const src=fs.readFileSync('src/film-readiness.js','utf8');
assert.ok(!/^import\s/m.test(src),'no imports');
assert.ok(!fs.readFileSync('build.mjs','utf8').includes('src/film-readiness.js'),'stays out of the bundle');
console.log('film-readiness: ok');
