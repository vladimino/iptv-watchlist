// AIR-264: the offline importer reads the immutable fingerprint storage of ADR-0035 section 2 (AIR-210). The objects are written by
// the Worker's own writeFingerprint with FINGERPRINT_VERSION_OBJECTS=on. The body and generation record that the current
// fingerprint.json names are mapped through it; valid objects nothing current names are unreferenced; every malformed or
// inconsistent object is a blocker before any write. The hash rule is the Worker's own canonical content hash.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {MemoryBucket} from './memory-bucket.mjs';
import {classifyObject,identityResolver,inventory,isFingerprintVersionKey,projectSource,readFingerprintVersions} from '../src/offline-importer.js';
import {loadDomainRules} from '../scripts/offline-import.mjs';

const rules=loadDomainRules();
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const writeFingerprint=vm.runInContext('writeFingerprint',ctx),contentHash=vm.runInContext('contentHash',ctx);

// R2 conditional put: the writer's create-only objects keep their first bytes, as they do in production.
class CreateOnlyBucket extends MemoryBucket{async put(key,body,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&this.objects.has(key))return null;await super.put(key,body,options);return {key};}}
const bucket=new CreateOnlyBucket(),env={BUCKET:bucket,FINGERPRINT_VERSION_OBJECTS:'on'};
const first={fingerprintSchemaVersion:1,mechanics:['heist'],execution:{pace:'fast'}};
const second={fingerprintSchemaVersion:1,mechanics:['heist','chase_escape'],execution:{pace:'medium'}};
const one=await writeFingerprint(env,'tmdb_1',first,null,'generated');
await writeFingerprint(env,'tmdb_1',second,one,'generated');
await writeFingerprint(env,'tmdb_2',first,null,'generated');
const snapshot=()=>{const bodies={};for(const [key,item] of bucket.objects)bodies[key]=JSON.parse(item.text);return {keys:[...bucket.objects.keys()].sort(),bodies};};
const base=snapshot();
const versionKeys=base.keys.filter(isFingerprintVersionKey);
const body=(film,hash)=>'enrichment/films/'+film+'/fingerprints/'+hash+'.json';
const generation=(film,hash,s=1,p=1)=>'enrichment/films/'+film+'/fingerprint-generations/'+hash+'-s'+s+'-p'+p+'.json';
const current=id=>base.bodies['enrichment/films/'+id+'/fingerprint.json'];

// 1. The rule is the Worker's: the importer's hash of a stored body without its hash is the hash the writer gave it.
{
 const stored=base.bodies[body('tmdb_2',current('tmdb_2').fingerprintHash)];
 const {fingerprintHash,...content}=stored;
 assert.equal(rules.fingerprintContentSha256(content),fingerprintHash);
 assert.equal(await contentHash(content),fingerprintHash);
}
// 2. Classification: every body and generation key is mapped-family coverage; neighbours stay unknown.
{
 assert.equal(versionKeys.length,6,'two films: three bodies and three generation records');
 for(const key of versionKeys)assert.equal(classifyObject(key),'mapped');
 assert.equal(classifyObject('enrichment/films/tmdb_1/fingerprints/'+'a'.repeat(63)+'.json'),'unmapped');
 assert.equal(classifyObject('enrichment/films/tmdb_1/fingerprint-generations/'+'a'.repeat(64)+'.json'),'unmapped');
 assert.equal(classifyObject('enrichment/films/tmdb_1/fingerprints/extra/'+'a'.repeat(64)+'.json'),'unmapped');
 assert.equal(inventory({keys:base.keys}).coverage.unmapped.length,0);
 // Alias spellings of the Worker's layout are unknown, not versions: leading zeros in the versions, and a film segment that is not
 // exactly encodeURIComponent of its id (lower-case or needless escapes, an undecodable escape). A properly encoded id is a key.
 const hash='a'.repeat(64);
 for(const key of ['enrichment/films/tmdb_1/fingerprint-generations/'+hash+'-s01-p1.json','enrichment/films/tmdb_1/fingerprint-generations/'+hash+'-s1-p01.json',
  'enrichment/films/tmdb%5F1/fingerprints/'+hash+'.json','enrichment/films/a%2fb/fingerprints/'+hash+'.json','enrichment/films/%E0%A4%A/fingerprints/'+hash+'.json',
  'enrichment/films/a b/fingerprint-generations/'+hash+'-s1-p1.json']){
  assert.equal(isFingerprintVersionKey(key),false,key);assert.equal(classifyObject(key),'unmapped',key);
  assert.deepEqual(inventory({keys:[key]}).coverage.unmapped,[key]);
  assert.deepEqual(readFingerprintVersions({keys:[key],bodies:{},contentSha256:rules.fingerprintContentSha256}).records,[]);
 }
 for(const key of ['enrichment/films/a%2Fb/fingerprints/'+hash+'.json','enrichment/films/'+encodeURIComponent('film:the-thing')+'/fingerprint-generations/'+hash+'-s10-p2.json'])assert.equal(classifyObject(key),'mapped',key);
}
// 3. The current record's body and generation are mapped through it; the replaced generation is unreferenced history; no blocker.
{
 const result=readFingerprintVersions({keys:base.keys,bodies:base.bodies,contentSha256:rules.fingerprintContentSha256});
 assert.deepEqual(result.blockers,[]);
 assert.deepEqual(result.summary,{bodies:3,generations:3,mapped:4,unreferenced:2,blocked:0});
 const disposition=key=>result.records.find(record=>record.key===key)?.disposition;
 const h1=one.fingerprintHash,h2=current('tmdb_1').fingerprintHash,h3=current('tmdb_2').fingerprintHash;
 assert.notEqual(h1,h2);
 assert.equal(disposition(body('tmdb_1',h2)),'mapped');assert.equal(disposition(generation('tmdb_1',h2)),'mapped');
 assert.equal(disposition(body('tmdb_1',h1)),'unreferenced');assert.equal(disposition(generation('tmdb_1',h1)),'unreferenced');
 assert.equal(disposition(body('tmdb_2',h3)),'mapped');assert.equal(disposition(generation('tmdb_2',h3)),'mapped');
 // Deterministic: the same input gives the same records.
 assert.deepEqual(readFingerprintVersions({keys:[...base.keys].reverse(),bodies:base.bodies,contentSha256:rules.fingerprintContentSha256}).records,result.records);
}
// 4. A body written before its record (a crash in between) is unreferenced, not a blocker.
{
 const keys=base.keys.filter(key=>key!==generation('tmdb_2',current('tmdb_2').fingerprintHash));
 const result=readFingerprintVersions({keys,bodies:base.bodies,contentSha256:rules.fingerprintContentSha256});
 assert.deepEqual(result.blockers,[]);
 assert.equal(result.records.find(record=>record.key===body('tmdb_2',current('tmdb_2').fingerprintHash)).disposition,'unreferenced');
}
// 4a. A film id that needs encoding keeps its pair mapped: the segment is the Worker's encodeURIComponent of the id.
{
 const encoded=new CreateOnlyBucket(),id='film:the-thing';
 await writeFingerprint({BUCKET:encoded,FINGERPRINT_VERSION_OBJECTS:'on'},id,first,null,'generated');
 const bodies={};for(const [key,item] of encoded.objects)bodies[key]=JSON.parse(item.text);
 const keys=[...encoded.objects.keys()].sort();
 assert.equal(keys.filter(isFingerprintVersionKey).length,2);assert.ok(keys.filter(isFingerprintVersionKey).every(key=>key.startsWith('enrichment/films/film%3Athe-thing/')));
 const result=readFingerprintVersions({keys,bodies,contentSha256:rules.fingerprintContentSha256});
 assert.deepEqual(result.blockers,[]);assert.deepEqual(result.summary,{bodies:1,generations:1,mapped:2,unreferenced:0,blocked:0});
 assert.ok(result.records.every(record=>record.id===id));
}
// 4b. A rewrite of identical content (a restore or a regeneration with the same result) reuses the body and record: the pointer's
// generatedAt, produced and previous differ from the record's first values, and the pair is still mapped.
{
 const reuse=new CreateOnlyBucket(),reuseEnv={BUCKET:reuse,FINGERPRINT_VERSION_OBJECTS:'on'};
 const a=await writeFingerprint(reuseEnv,'tmdb_5',first,null,'generated');
 const b=await writeFingerprint(reuseEnv,'tmdb_5',second,a,'generated');
 await new Promise(resolve=>setTimeout(resolve,5));
 await writeFingerprint(reuseEnv,'tmdb_5',first,b,'restored');
 const bodies={};for(const [key,item] of reuse.objects)bodies[key]=JSON.parse(item.text);
 const keys=[...reuse.objects.keys()].sort(),pointer=bodies['enrichment/films/tmdb_5/fingerprint.json'];
 assert.equal(pointer.produced,'restored');assert.notEqual(pointer.generatedAt,bodies[generation('tmdb_5',a.fingerprintHash)].generatedAt);
 const result=readFingerprintVersions({keys,bodies,contentSha256:rules.fingerprintContentSha256});
 assert.deepEqual(result.blockers,[]);
 assert.deepEqual(result.summary,{bodies:2,generations:2,mapped:2,unreferenced:2,blocked:0});
 assert.equal(result.records.find(record=>record.key===generation('tmdb_5',a.fingerprintHash)).disposition,'mapped');
}
// 5. Fail closed: each defect is a blocker on fingerprint_payload for that film, and the object is never mapped.
const h=current('tmdb_2').fingerprintHash,bodyKey=body('tmdb_2',h),generationKey=generation('tmdb_2',h);
const blocked=(mutate,keys=base.keys)=>{const bodies=JSON.parse(JSON.stringify(base.bodies));mutate(bodies);const result=readFingerprintVersions({keys,bodies,contentSha256:rules.fingerprintContentSha256});return {reasons:result.blockers.map(item=>item.reason),result};};
{
 let r=blocked(bodies=>{bodies[bodyKey].mechanics=['siege'];});
 assert.deepEqual(r.reasons,['fingerprint_body_hash_mismatch'],'a body whose content does not hash to its key');
 assert.equal(r.result.blockers[0].targetTable,'fingerprint_payload');assert.equal(r.result.blockers[0].targetId,'tmdb_2');
 assert.ok(!r.result.records.some(record=>record.key===bodyKey));
 r=blocked(bodies=>{bodies[bodyKey].filmId='tmdb_3';});
 assert.deepEqual(r.reasons,['fingerprint_body_identity_mismatch'],'a body naming another film');
 r=blocked(bodies=>{bodies[bodyKey]=null;});
 assert.deepEqual(r.reasons,['fingerprint_version_unreadable']);
 r=blocked(bodies=>{bodies[generationKey].fingerprintSchemaVersion=2;});
 assert.deepEqual(r.reasons,['fingerprint_generation_invalid'],'a record that disagrees with its key');
 r=blocked(bodies=>{bodies[generationKey].extra=true;});
 assert.deepEqual(r.reasons,['fingerprint_generation_invalid'],'a record with an unknown field');
 r=blocked(bodies=>{bodies[generationKey].produced='invented';});
 assert.deepEqual(r.reasons,['fingerprint_generation_invalid']);
 r=blocked(bodies=>{bodies[generationKey].previous={fingerprintHash:1};});
 assert.deepEqual(r.reasons,['fingerprint_generation_invalid']);
 r=blocked(()=>{},base.keys.filter(key=>key!==bodyKey));
 assert.deepEqual(r.reasons,['fingerprint_generation_body_missing'],'a record without its body');
 // The current record claims the body's hash but carries other content: the pointer and its immutable form disagree.
 r=blocked(bodies=>{bodies['enrichment/films/tmdb_2/fingerprint.json'].mechanics=['siege'];});
 assert.deepEqual(r.reasons,['fingerprint_current_body_mismatch']);
}
// 6. The hash rule is required as soon as there is a version key; a snapshot without them needs none.
assert.throws(()=>readFingerprintVersions({keys:base.keys,bodies:base.bodies}),/content hash rule is required/);
assert.deepEqual(readFingerprintVersions({keys:['watchlist.json'],bodies:{}}).records,[]);
// 7. projectSource: the objects are accounted (mapped or unreferenced, never unprojected), blockers reach the expectation, and the
// fingerprint row still comes from fingerprint.json alone.
{
 const identity=identityResolver({canonicalize:rules.canonicalFilmId,films:[{id:'film:tmdb_1'},{id:'film:tmdb_2'}].map(film=>({...film,canonicalIdentity:film.id}))});
 const expected=projectSource({keys:base.keys,bodies:base.bodies,identity,deriveEvidence:rules.candidateEvidence,fingerprintContentSha256:rules.fingerprintContentSha256});
 for(const key of versionKeys)assert.ok(expected.records.some(record=>record.key===key),key);
 assert.ok(!expected.unprojected.some(isFingerprintVersionKey));
 assert.deepEqual(expected.fingerprintVersions,{bodies:3,generations:3,mapped:4,unreferenced:2,blocked:0});
 assert.deepEqual(expected.blockers,[]);
 const bodies=JSON.parse(JSON.stringify(base.bodies));bodies[bodyKey].mechanics=['siege'];
 const failing=projectSource({keys:base.keys,bodies,identity,deriveEvidence:rules.candidateEvidence,fingerprintContentSha256:rules.fingerprintContentSha256});
 assert.deepEqual(failing.blockers.map(item=>item.reason),['fingerprint_body_hash_mismatch']);
}
console.log('Fingerprint version import: Worker hash rule, mapped-family coverage with alias spellings unknown, encoded film id, current pointer mapping, reused body and record after a restore, unreferenced history and orphan body, nine fail-closed defects, required rule, projectSource accounting passed');
