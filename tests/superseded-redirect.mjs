import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {acceptanceClasses,fingerprintUnit,identityResolver,importBatch,predictionUnits,projectSource,supersededPayloads,verifyParity} from '../src/offline-importer.js';
import {loadDomainRules,openSqlite} from '../scripts/offline-import.mjs';

// ADR-0029: a fingerprint or prediction bundle of a retired Film id that a redirect maps to a survivor with its own strictly newer
// payload is superseded by the canonical payload. Every other collision keeps the class A fail-closed path.
const rules=loadDomainRules(),at='2026-10-19T01:00:00.000Z',older='2026-10-01T01:00:00.000Z',newer='2026-10-20T01:00:00.000Z';
const dim=dimension=>({dimension,status:'resolved',updatedAt:at,source:'letterboxd',sourceVersion:null,provenance:null,value:null,nextAction:'none',attempts:0});
const film=(id,ids,redirects=[])=>({contractVersion:1,id,canonicalIdentity:null,originalTitle:'Title',externalIds:ids,aliases:[],identity:dim('identity'),metadata:dim('metadata'),localization:dim('localization'),fingerprint:dim('fingerprint'),prediction:dim('prediction'),redirects});
const letterboxd=value=>({scheme:'letterboxd',value,trusted:true,conflicting:false});
const tmdb=value=>({scheme:'tmdb',value,trusted:true,conflicting:false});
const survivor=film('film:heat-1995',[letterboxd('heat-1995'),tmdb('7')],[{from:'film:tmdb:7',to:'film:heat-1995',at}]);
const sha=char=>char.repeat(64);
const fpKey=id=>'enrichment/films/'+id+'/fingerprint.json',bundleKey=id=>'enrichment/films/'+id+'/predictions.json';
const print=(hash,generatedAt)=>({fingerprintHash:hash,schemaVersion:1,generatedAt});
const version=(stored,checksum,updatedAt,extra={})=>({tasteProfileVersion:1,tasteProfileHash:'profile',fingerprintHash:'print',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:3.5,updatedAt,r2Key:'enrichment/films/'+stored+'/predictions/versions/'+checksum+'.json',contentSha256:checksum,...extra});
const identityFor=films=>identityResolver({canonicalize:rules.canonicalFilmId,films});
const index=(films,entries)=>supersededPayloads({identity:identityFor(films),entries});

// 1. The proven shape: the retired fingerprint is older than the survivor's own; it is superseded with both checksums.
{
 const entries=[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',older)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',newer)}];
 const result=index([survivor],entries);
 const decision=result.resolve(fpKey('tmdb_7'));
 assert.equal(decision.superseded,true);
 assert.equal(decision.reason,'superseded_by_canonical');
 assert.equal(decision.filmId,'film:heat-1995');
 assert.deepEqual(decision.supersededBy,{key:fpKey('heat-1995'),sha256:sha('b'),at:newer});
 assert.equal(decision.sourceAt,older);
 assert.equal(decision.identity.via,'redirect');
 assert.equal(result.resolve(fpKey('heat-1995')),null,'the canonical payload is imported as usual');
 const identity=identityFor([survivor]);
 const unit=fingerprintUnit(entries[0],entries[0].body,identity,result);
 assert.equal(unit.kind,'superseded');assert.equal(unit.superseded,true);assert.equal(unit.sourceSha256,sha('a'));assert.equal(unit.targetId,'film:heat-1995');
 assert.equal(fingerprintUnit(entries[0],entries[0].body,identity).kind,'fingerprint','without the rule the unit still collides');
 // Deterministic: entry order does not change the answer.
 assert.deepEqual(index([survivor],[...entries].reverse()).resolve(fpKey('tmdb_7')),decision);
 // The independent projection uses the same answer: one expected fingerprint, the retired key noted as superseded.
 const projected=projectSource({keys:entries.map(item=>item.key),bodies:Object.fromEntries(entries.map(item=>[item.key,item.body])),shas:Object.fromEntries(entries.map(item=>[item.key,item.sha256])),identity,deriveEvidence:rules.candidateEvidence,superseded:result});
 assert.deepEqual(projected.fingerprints.map(item=>item.r2Key),[fpKey('heat-1995')]);
 assert.equal(projected.records.find(record=>record.key===fpKey('tmdb_7')).disposition,'superseded');
}

// 2. Refusals: each keeps today's path (no decision, or a refusal reason), never a silent supersession.
const refusals=[
 ['no redirect: two unrelated Films',[film('film:a',[letterboxd('a')]),film('film:b',[letterboxd('b')])],[{key:fpKey('a'),sha256:sha('a'),body:print('x',older)},{key:fpKey('b'),sha256:sha('b'),body:print('y',newer)}],'a',null],
 ['target has no payload of its own',[survivor],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',older)}],'tmdb_7',null],
 ['target payload is older',[survivor],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',newer)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',older)}],'tmdb_7','canonical_not_newer'],
 ['same time, other hash',[survivor],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',at)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',at)}],'tmdb_7','canonical_not_newer'],
 ['target payload without a time',[survivor],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',older)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',null)}],'tmdb_7','canonical_unportable'],
 ['source payload without fields',[survivor],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:{generatedAt:older}},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',newer)}],'tmdb_7','source_unportable'],
 ['checksum missing',[survivor],[{key:fpKey('tmdb_7'),sha256:'sha-a',body:print('old',older)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',newer)}],'tmdb_7','checksum_missing'],
 ['two retired ids, no canonical payload',[{...survivor,redirects:[...survivor.redirects,{from:'film:tmdb:8',to:'film:heat-1995',at}]}],[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('a',older)},{key:fpKey('tmdb_8'),sha256:sha('c'),body:print('c',newer)}],'tmdb_7','canonical_missing'],
];
for(const [label,films,entries,stored,reason] of refusals){
 const decision=index(films,entries).resolve(fpKey(stored));
 if(reason==null)assert.equal(decision,null,label);
 else{assert.equal(decision.superseded,false,label);assert.equal(decision.reason,reason,label);}
}
// Reused identity: a retired id that is also a stored Film is a conflict of the shared resolver and is never superseded.
{
 const reused=[survivor,film('film:tmdb:7',[tmdb('7')])];
 assert.equal(identityFor(reused).resolve('tmdb_7').reason,'identity_conflict');
 assert.equal(index(reused,[{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',older)},{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',newer)}]).resolve(fpKey('tmdb_7')),null);
}

// 3. Prediction bundles: superseded only when both bundles are portable. A missing version object is never hidden behind the rule.
{
 const retired={current:version('tmdb_7',sha('c'),older),history:[version('tmdb_7',sha('d'),'2026-09-01T01:00:00.000Z')]};
 const canonical={current:version('heat-1995',sha('e'),newer),history:[]};
 const entries=[{key:bundleKey('tmdb_7'),sha256:sha('a'),body:retired},{key:bundleKey('heat-1995'),sha256:sha('b'),body:canonical}];
 const result=index([survivor],entries);
 const decision=result.resolve(bundleKey('tmdb_7'));
 assert.equal(decision.superseded,true);assert.equal(decision.records,2);assert.equal(decision.supersededBy.at,newer);
 const units=predictionUnits(entries[0],retired,identityFor([survivor]),null,result);
 assert.equal(units.length,1);assert.equal(units[0].kind,'superseded');assert.equal(units[0].records,2);
 const missing={current:{...version('tmdb_7',sha('c'),older),r2Key:undefined,contentSha256:undefined},history:[]};
 assert.equal(index([survivor],[{...entries[0],body:missing},entries[1]]).resolve(bundleKey('tmdb_7')).reason,'source_unportable','a retired bundle without version objects stays class A');
 const canonicalMissing={current:{...version('heat-1995',sha('e'),newer),r2Key:undefined,contentSha256:undefined},history:[]};
 assert.equal(index([survivor],[entries[0],{...entries[1],body:canonicalMissing}]).resolve(bundleKey('tmdb_7')).reason,'canonical_unportable');
 const absent={linked:(record,storedId)=>rules.predictionVersionLinked(record,storedId),exists:()=>false,sha:()=>null};
 assert.equal(supersededPayloads({identity:identityFor([survivor]),entries,links:absent}).resolve(bundleKey('tmdb_7')).reason,'canonical_unportable','a pointer to an object the snapshot lacks is not portable');
 const unsupersededUnits=predictionUnits({...entries[0],body:missing},missing,identityFor([survivor]),null,index([survivor],[{...entries[0],body:missing},entries[1]]));
 assert.equal(unsupersededUnits.every(unit=>unit.unportable&&unit.reason==='prediction_version_object_missing'),true);
}

// 4. End to end on SQLite: no stop, no row and no receipt from the superseded key, parity on the canonical payload, empty rerun.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-superseded-'));
async function run(name,entries,films){
 const file=path.join(root,name+'.sqlite');
 const db=openSqlite(file);
 await db.run(['0001_schema_v1.sql','0002_generation_stage.sql','0003_candidate_show_identity.sql'].map(item=>fs.readFileSync(path.join('migrations',item),'utf8')).join('\n').replace(/;\s*$/,''));
 const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
 const identity=identityFor(films),superseded=supersededPayloads({identity,entries});
 const units=[...films.map(item=>({family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:sha('f'),targetTable:'film',targetId:item.id,unportable:false,input:{film:item,watchlist:true}})),...entries.map(item=>fingerprintUnit(item,item.body,identity,superseded))];
 const expected=projectSource({keys:entries.map(item=>item.key),bodies:Object.fromEntries(entries.map(item=>[item.key,item.body])),shas:Object.fromEntries(entries.map(item=>[item.key,item.sha256])),identity,deriveEvidence:rules.candidateEvidence,superseded});
 const batch={importedAt:at,units,stopOn:{conflicts:true,unacknowledged:true},acknowledged:[],expected:{fingerprints:expected.fingerprints}};
 return {db,first:await importBatch(db,repositories,batch),again:()=>importBatch(db,repositories,batch)};
}
{
 const entries=[{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',newer)},{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',older)}];
 const {db,first,again}=await run('superseded',entries,[survivor]);
 assert.equal(first.stopped,false);
 assert.equal(first.superseded,1);
 assert.equal(first.parity.ok,true,'the stored row is the canonical payload');
 assert.equal(first.classes.S.count,1);assert.deepEqual(first.classes.S.families,{fingerprint:1});
 assert.equal(first.classes.C.count,0,'not a class C record to acknowledge');
 assert.equal(first.classes.A.open,0,'not a class A gap');
 assert.equal(first.claimsFullParity,false,'a superseded source is not lossless parity');
 const row=await db.get('SELECT fingerprint_hash,r2_key,content_sha256 FROM fingerprint_payload WHERE film_id=?',['film:heat-1995']);
 assert.deepEqual(row,{fingerprint_hash:'new',r2_key:fpKey('heat-1995'),content_sha256:sha('b')});
 assert.equal((await db.get('SELECT COUNT(*) AS n FROM import_receipt WHERE source_key=?',[fpKey('tmdb_7')])).n,0);
 const rerun=await again();
 assert.equal(rerun.applied,0);assert.equal(rerun.superseded,1);assert.equal(rerun.stopped,false);
 assert.deepEqual(rerun.ledger,first.ledger,'the rerun reports the same record');
}
// Outside the exception class A still stops the run: same time, other hash leaves fingerprint_kept.
{
 const entries=[{key:fpKey('heat-1995'),sha256:sha('b'),body:print('new',at)},{key:fpKey('tmdb_7'),sha256:sha('a'),body:print('old',at)}];
 const {first}=await run('kept',entries,[survivor]);
 assert.equal(first.stopped,true);
 assert.deepEqual(first.stopReasons,['class_a_blocker']);
 assert.equal(first.blockers[0].class,'A');assert.equal(first.blockers[0].reason,'fingerprint_kept');
 assert.equal(first.ledger.find(item=>item.sourceKey===fpKey('tmdb_7')).reason,'fingerprint_kept');
 assert.equal(first.superseded,0);
}
// acceptanceClasses keeps S apart from A and C.
{
 const classes=acceptanceClasses({counts:{},ledger:[{family:'fingerprint',outcome:'superseded',class:'S'}],parity:{ok:true}});
 assert.equal(classes.S.count,1);assert.equal(classes.C.count,0);assert.equal(classes.A.open,0);
}
fs.rmSync(root,{recursive:true,force:true});
console.log('Superseded redirect payloads (ADR-0029): proven retired fingerprint and bundle superseded with both checksums, deterministic, projection agrees; no redirect, missing/older/same-time/unportable target, unportable source, missing checksum, no canonical, reused identity and missing version objects refused; SQLite run writes no row or receipt for it, parity on canonical, empty rerun; class A outside the exception still stops passed');
