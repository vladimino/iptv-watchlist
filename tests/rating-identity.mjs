import assert from 'node:assert/strict';
import {actualUnit,identityResolver,projectSource,ratingIdentity} from '../src/offline-importer.js';
import {loadDomainRules} from '../scripts/offline-import.mjs';

// ADR-0027: an owner rating of a Letterboxd id that has no Film resolves through its own metadata.json TMDB id to exactly one
// trusted, non-conflicting Film that has no other rating. Every other case keeps the shared resolver's answer or a stricter one.
const rules=loadDomainRules(),at='2026-10-19T01:00:00.000Z';
const dim=dimension=>({dimension,status:'resolved',updatedAt:at});
const film=(id,ids)=>({contractVersion:1,id,canonicalIdentity:null,originalTitle:'Title',externalIds:ids,aliases:[],identity:dim('identity'),metadata:dim('metadata'),localization:dim('localization'),fingerprint:dim('fingerprint'),prediction:dim('prediction')});
const tmdb=(value,trusted=true,conflicting=false)=>({scheme:'tmdb',value,trusted,conflicting});
const letterboxd=value=>({scheme:'letterboxd',value,trusted:true,conflicting:false});
const meta=(id,tmdbId)=>({id,tmdbId,metadataAt:at});
const key=id=>'enrichment/films/'+id+'/actual.json';
const entry=id=>({key:key(id),sha256:'sha-'+id});
const body={rating:4.5,source:'letterboxd',updatedAt:at};
function build(films,metadata,ids){
 const identity=identityResolver({canonicalize:rules.canonicalFilmId,films});
 return {identity,ratings:ratingIdentity({identity,films,metadata,metadataSha256:'sha-metadata',ratings:ids.map(id=>({key:key(id)}))})};
}

// 1. The G2 shape: a departed watchlist film whose TMDB id is held by one trusted EPG-discovered Film without a rating.
{
 const films=[film('film:tmdb:101',[tmdb('101')]),film('film:kept',[letterboxd('kept')])];
 const {identity,ratings}=build(films,{gone:meta('gone','101'),kept:meta('kept','202')},['gone','kept']);
 assert.equal(identity.resolve('gone').reason,'film_unresolved','the shared resolver alone leaves it unresolved');
 const unit=actualUnit(entry('gone'),body,identity,ratings);
 assert.equal(unit.kind,'rating');assert.equal(unit.targetId,'film:tmdb:101');assert.equal(unit.sourceKey,key('gone'));assert.equal(unit.sourceSha256,'sha-gone');
 assert.deepEqual(unit.identity,{source:'gone',canonical:'film:gone',filmId:'film:tmdb:101',via:'metadata_tmdb',reason:null,tmdbId:'101',metadataSha256:'sha-metadata'});
 assert.equal(actualUnit(entry('kept'),body,identity,ratings).identity.via,'direct','a rating with its own Film is unchanged');
 assert.equal(actualUnit(entry('gone'),body,identity).kind,'unresolved','without the rule the record stays class C');
 // Deterministic: the same inputs give the same answer, in any input order.
 const again=build([...films].reverse(),{kept:meta('kept','202'),gone:meta('gone','101')},['kept','gone']);
 assert.deepEqual(actualUnit(entry('gone'),body,again.identity,again.ratings),unit);
 // The independent projection uses the same rule and expects the rating on the same Film.
 const projected=projectSource({keys:[key('gone')],bodies:{[key('gone')]:body},films,people:[],identity,deriveEvidence:rules.candidateEvidence,ratings});
 assert.deepEqual(projected.ratings,[{id:'film:tmdb:101',rating:4.5,source:'letterboxd',recordedAt:at}]);
 assert.equal(projected.records.find(record=>record.key===key('gone')).disposition,'mapped');
 assert.equal(projected.records.find(record=>record.key===key('gone')).identity.via,'metadata_tmdb');
}

// 2. Refusals: each stays unresolved, never a guess.
const cases=[
 ['no metadata record',[film('film:tmdb:101',[tmdb('101')])],{},'film_unresolved'],
 ['metadata record of another id',[film('film:tmdb:101',[tmdb('101')])],{gone:meta('other','101')},'film_unresolved'],
 ['metadata without a TMDB id',[film('film:tmdb:101',[tmdb('101')])],{gone:{id:'gone',metadataAt:at}},'film_unresolved'],
 ['metadata with a malformed TMDB id',[film('film:tmdb:101',[tmdb('101')])],{gone:meta('gone','tmdb_101')},'film_unresolved'],
 ['no Film holds the TMDB id (G3)',[film('film:tmdb:101',[tmdb('101')])],{gone:meta('gone','999')},'film_unresolved'],
 ['two Films hold the TMDB id',[film('film:tmdb:101',[tmdb('101')]),film('film:twin',[letterboxd('twin'),tmdb('101')])],{gone:meta('gone','101')},'identity_conflict'],
 ['the TMDB id is marked conflicting',[film('film:tmdb:101',[tmdb('101',false,true),tmdb('102',false,true)])],{gone:meta('gone','101')},'identity_conflict'],
 ['a conflict record claims the TMDB id',[film('film:tmdb:101',[tmdb('101')]),film('film:conflict:101+102',[])],{gone:meta('gone','101')},'identity_conflict'],
 ['the holder does not trust the TMDB id',[film('film:holder',[letterboxd('holder'),tmdb('101',false)])],{gone:meta('gone','101')},'identity_unlinked'],
 ['the holder has another Letterboxd id',[film('film:holder',[letterboxd('holder'),tmdb('101')])],{gone:meta('gone','101')},'identity_conflict'],
 ['two metadata records carry the TMDB id',[film('film:tmdb:101',[tmdb('101')])],{gone:meta('gone','101'),also:meta('also','101')},'identity_conflict'],
];
for(const [label,films,metadata,reason] of cases){
 const {identity,ratings}=build(films,metadata,['gone']);
 const unit=actualUnit(entry('gone'),body,identity,ratings);
 assert.equal(unit.kind,'unresolved',label);assert.equal(unit.reason,reason,label);assert.equal(unit.identity.filmId,null,label);
}

// 3. Rating conflicts: a Film gets at most one rating; the mapped one never joins or replaces another, equal or different.
{
 const films=[film('film:tmdb:101',[tmdb('101')])];
 for(const [label,metadata,ids] of [
  ['the Film has its own rating',{gone:meta('gone','101')},['gone','tmdb_101']],
  ['two departed ids map to one Film',{gone:meta('gone','101'),'tmdb_101':meta('tmdb_101','101')},['gone','tmdb_101']],
 ]){
  const {identity,ratings}=build(films,metadata,ids);
  const mapped=actualUnit(entry('gone'),body,identity,ratings);
  assert.equal(mapped.kind,'unresolved',label);assert.equal(mapped.reason,label==='two departed ids map to one Film'?'identity_conflict':'rating_conflict',label);
  assert.equal(actualUnit(entry('tmdb_101'),{...body,rating:4.5},identity,ratings).targetId,'film:tmdb:101',label+': the Film keeps its own rating');
 }
 const two=[film('film:tmdb:101',[tmdb('101')]),film('film:tmdb:102',[tmdb('102')])];
 const {identity,ratings}=build(two,{a:meta('a','101'),b:meta('b','102')},['a','b']);
 assert.deepEqual(['a','b'].map(id=>actualUnit(entry(id),body,identity,ratings).targetId),['film:tmdb:101','film:tmdb:102'],'two ratings to two different Films both resolve');
}

// 4. Only the film_unresolved case is widened: a conflict or unlinked answer of the shared resolver is never overridden.
{
 const films=[film('film:x',[letterboxd('x'),tmdb('101')]),film('film:y',[letterboxd('y'),tmdb('101')]),film('film:tmdb:102',[tmdb('102')])];
 const {identity,ratings}=build(films,{'tmdb_101':meta('tmdb_101','102')},['tmdb_101']);
 assert.equal(identity.resolve('tmdb_101').reason,'identity_conflict');
 assert.equal(actualUnit(entry('tmdb_101'),body,identity,ratings).reason,'identity_conflict','its metadata TMDB id is not consulted');
 assert.throws(()=>ratingIdentity({films:[]}),/identity resolver/);
}
console.log('Rating identity (ADR-0027): G2 shape resolves to the one trusted Film with provenance, deterministic, projection agrees; missing/foreign/malformed metadata, no holder, two holders, conflicting TMDB, conflict record, untrusted holder, foreign Letterboxd id, ambiguous metadata, rating conflicts and shared-resolver conflicts stay unresolved passed');
