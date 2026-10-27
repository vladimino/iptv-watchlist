import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';

// Taste-profile publication (ADR-0031 sections 1, 4, 4a): a validated changeImpact, a create-only version record and a
// compare-and-swap move of current.json with a bounded lineage. A rejected publication writes nothing.
const domain=fs.readFileSync('src/domain/profile-impact.js','utf8');
assert.doesNotMatch(domain,/\bfetch\b|\bBUCKET\b|crypto|await/,'the impact rules stay pure');
assert.match(fs.readFileSync('build.mjs','utf8'),/profile-impact\.js/,'the Worker bundle includes the impact rules');

const records=new Map(),etags=new Map(),puts=[];let revision=0,beforePut=null;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){
  if(beforePut)await beforePut(key,options);
  const text=String(value),condition=options.onlyIf;
  puts.push({key,onlyIf:condition?JSON.parse(JSON.stringify(condition)):null});
  if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;
  if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};
 },
 list:async()=>({objects:[],truncated:false})
};
const env={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+domain,ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
vm.runInContext('globalThis.testApi={validateProfileImpact,profileDeclarationText,profileChangedFields,profileLineage,vocabulary:{mechanics:MECHANICS,execution:EXECUTION},fieldRules:PROFILE_FIELD_RULES};',ctx);
const T=ctx.testApi;
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const currentKey='enrichment/profile/current.json',versionKey=n=>'enrichment/profile/versions/'+n+'.json';
const snapshot=()=>JSON.stringify([...records.entries()].sort());

// 1. The pure validator reproduces every publication case of the specification fixtures, including the approval
// bound to the canonical declaration (keys sorted) and every rejection code in ADR order.
const spec=JSON.parse(fs.readFileSync('tests/fixtures/profile-compatibility/cases.json','utf8'));
assert.deepEqual(JSON.parse(JSON.stringify(T.fieldRules)),Object.fromEntries(Object.entries(spec.fieldRules).map(([field,rule])=>[field,rule.scope?{}:Object.fromEntries(Object.entries(rule).filter(([key])=>key!=='scope'))])),'the publisher field table is the specification table');
const base=Object.fromEntries(Object.keys(spec.fieldRules).map(field=>[field,'base '+field]));
for(const p of spec.publications){
 const previous={version:p.previous.version,profileHash:p.previous.profileHash,profile:base};
 const next={version:p.next.version,profileHash:p.next.profileHash,profile:{...base,...Object.fromEntries(p.actualChangedFields.map(field=>[field,'changed '+field]))}};
 const text=T.profileDeclarationText(p.changeImpact,p.next),result=T.validateProfileImpact({previous,next,impact:p.changeImpact,declarationSha256:text?sha256(text):null,vocabulary:T.vocabulary});
 assert.equal(result.ok,p.expected.decision==='accept',p.id+': '+result.code);
 assert.equal(result.code,p.expected.code??null,p.id);
 assert.deepEqual([...result.changedFields].sort(),[...p.actualChangedFields].sort(),p.id+' changed fields are computed by the server');
}
assert.equal(T.profileDeclarationText(null,{version:2,profileHash:'h'}),null);
assert.equal(T.profileDeclarationText({from:{version:1,profileHash:'a'},scope:'global',changedFields:['pace'],selectors:[{values:['x'],kind:'genre'}]},{version:2,profileHash:'b'}),'[1,"a",2,"b","global",["pace"],[{"kind":"genre","values":["x"]}]]','selector keys are sorted, changed fields sorted');
// Extra or malformed impact fields fail closed.
const prev={version:1,profileHash:'h1',profile:base},nxt={version:2,profileHash:'h2',profile:{...base,pace:'faster'}};
const check=impact=>T.validateProfileImpact({previous:prev,next:nxt,impact,declarationSha256:null,vocabulary:T.vocabulary}).code;
const global={impactSchemaVersion:1,from:{version:1,profileHash:'h1'},scope:'global',changedFields:['pace'],selectors:[]};
assert.equal(check(global),null);
assert.equal(check({...global,extra:true}),'impact_schema_unknown');
assert.equal(check({...global,rationale:7}),'impact_schema_unknown');
assert.equal(check({...global,from:{version:1,profileHash:'h1',x:1}}),'from_mismatch');
assert.equal(check({...global,changedFields:['pace','pace']}),'changed_fields_mismatch');
assert.equal(check({...global,selectors:[{kind:'genre',values:['horror']}]}),'selector_invalid','a global impact carries no selectors');
const selective={...global,scope:'selective',selectors:[{kind:'execution',dimension:'pace',values:['slow']}]};
assert.equal(check({...selective,selectors:[{kind:'execution',dimension:'pace',values:['slow','slow']}]}),'selector_invalid');
assert.equal(check({...selective,selectors:[{kind:'execution',dimension:'pace',values:['slow'],extra:1}]}),'selector_invalid');
assert.equal(check(selective),'selective_requires_owner_approval');
assert.equal(check({...selective,approval:{approvedBy:'owner',approvedAt:'not a date',reviewRef:'r',declarationSha256:'0'.repeat(64)}}),'selective_requires_owner_approval');
assert.equal(check({...selective,approval:{approvedBy:'owner',approvedAt:'2026-10-27T00:00:00Z',reviewRef:'r',declarationSha256:'0'.repeat(64)}}),'approval_mismatch');
// Lineage: a legacy current record starts it with its own link; at most 32 links, oldest dropped.
assert.deepEqual(JSON.parse(JSON.stringify(T.profileLineage({version:4,profileHash:'h4',profile:{}},{version:5,profileHash:'h5',changeImpact:global}))),[{version:4,profileHash:'h4',changeImpact:null},{version:5,profileHash:'h5',changeImpact:global}]);
const long={version:40,profileHash:'h',lineage:Array.from({length:32},(_,i)=>({version:i+9,profileHash:'h',changeImpact:null}))};
const capped=T.profileLineage(long,{version:41,profileHash:'h',changeImpact:null});
assert.equal(capped.length,32);assert.equal(capped[0].version,10);assert.equal(capped.at(-1).version,41);

// 2. The route.
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Rules matter',scifiAdventurePreferences:'Concept driven',actionPreferences:'Readable action',anchorFilms:[],hardSkips:['Gross-out'],calibration:'Be calibrated'};
const publish=body=>api('enrichment/profile','PUT',{schemaVersion:1,...body});

// First version: no predecessor, so no impact; an impact is refused and nothing is written.
let before=snapshot();
let r=await publish({version:1,profile,changeImpact:global});
assert.equal(r.status,409);assert.equal(r.data.code,'from_mismatch');assert.equal(snapshot(),before,'a refused first publication writes nothing');
r=await publish({version:1,profile});
assert.equal(r.status,200);assert.equal(r.data.version,1);assert.equal(r.data.changeImpact,null);
assert.deepEqual(r.data.lineage,[{version:1,profileHash:r.data.profileHash,changeImpact:null}]);
const v1=read(versionKey(1));assert.equal(v1.profileHash,r.data.profileHash);assert.equal(v1.lineage,undefined,'the version record holds no lineage');
assert.deepEqual(puts.filter(p=>p.key===versionKey(1)).map(p=>p.onlyIf),[{etagDoesNotMatch:'*'}],'the version record is create-only');
assert.deepEqual(puts.filter(p=>p.key===currentKey).map(p=>p.onlyIf),[{etagDoesNotMatch:'*'}],'the first current pointer is create-only');
const h1=r.data.profileHash;
assert.deepEqual((await api('enrichment/profile')).data,read(currentKey),'GET returns the current record with its lineage');

// Every rejection leaves current.json and the version records untouched, and writes no version record.
const changed={...profile,horrorPreferences:'Rules and causality matter'};
const horror={impactSchemaVersion:1,from:{version:1,profileHash:h1},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']},{kind:'execution',dimension:'horror_rule_consistency',values:['weak','mixed']}]};
for(const [impact,code,status] of [[undefined,'impact_missing',400],[{...horror,from:{version:1,profileHash:'stale'}},'from_mismatch',409],[{...horror,changedFields:['pace']},'changed_fields_mismatch',400],[{...horror,scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'execution',dimension:'horror_threat_causality',values:['weak']}]},'genre_floor_missing',400],[horror,'selective_requires_owner_approval',400]]){
 before=snapshot();const count=puts.length;
 r=await publish({version:2,profile:changed,...(impact===undefined?{}:{changeImpact:impact})});
 assert.equal(r.status,status,code);assert.equal(r.data.code,code);assert.equal(snapshot(),before,code+' writes nothing');assert.equal(puts.length,count,code+' attempts no write');
}
// A dry run validates and returns the hash an owner approval must carry, writing nothing.
before=snapshot();
r=await publish({version:2,profile:changed,changeImpact:horror,dryRun:true});
assert.equal(r.status,400,'without approval even the dry run is refused');assert.equal(r.data.code,'selective_requires_owner_approval');
const declarationSha256=r.data.declarationSha256;assert.match(declarationSha256,/^[0-9a-f]{64}$/);
const h2=r.data.profileHash;
assert.equal(declarationSha256,sha256(T.profileDeclarationText(horror,{version:2,profileHash:h2})),'the returned hash is the canonical declaration hash');
const approved={...horror,approval:{approvedBy:'owner',approvedAt:'2026-10-27T21:00:00.000Z',reviewRef:'trello-comment:test',declarationSha256},rationale:'Horror rule wording only'};
r=await publish({version:2,profile:changed,changeImpact:approved,dryRun:true});
assert.equal(r.status,200);assert.equal(r.data.dryRun,true);assert.equal(r.data.valid,true);assert.deepEqual(r.data.changedFields,['horrorPreferences']);assert.equal(snapshot(),before,'a dry run writes nothing');
assert.equal((await publish({version:2,profile:changed,changeImpact:approved,dryRun:'yes'})).status,400);
// An approval for another declaration (here: an extra selector added after approval) is refused.
r=await publish({version:2,profile:changed,changeImpact:{...approved,selectors:[...approved.selectors,{kind:'mechanic',values:['heist']}]}});
assert.equal(r.status,400);assert.equal(r.data.code,'approval_mismatch');assert.equal(snapshot(),before);
// The approved selective publication: immutable record with its impact, lineage of two links.
const etagBefore=etags.get(currentKey);
r=await publish({version:2,profile:changed,changeImpact:approved});
assert.equal(r.status,200);assert.equal(r.data.profileHash,h2);
assert.deepEqual(read(versionKey(2)).changeImpact,approved);
assert.deepEqual(r.data.lineage,[{version:1,profileHash:h1,changeImpact:null},{version:2,profileHash:h2,changeImpact:approved}]);
assert.deepEqual(puts.filter(p=>p.key===currentKey).at(-1).onlyIf,{etagMatches:etagBefore},'current moves by compare-and-swap on the ETag read first');
assert.equal(read(versionKey(1)).profileHash,h1,'the earlier record is untouched');
assert.equal((await publish({version:2,profile:changed,changeImpact:approved})).data.code,'version_not_increasing');

// Identity: same content, a new number.
const identity=(from,hash)=>({impactSchemaVersion:1,from,scope:'identity',changedFields:[],selectors:[]});
r=await publish({version:3,profile:changed,changeImpact:{...identity({version:2,profileHash:h2})}});
assert.equal(r.status,200);assert.equal(r.data.lineage.length,3);
assert.equal((await publish({version:4,profile:{...changed,pace:'x'},changeImpact:identity({version:3,profileHash:h2})})).data.code,'identity_requires_same_hash');

// A retry after a crash between the two writes finds its own version record and completes; another record under that
// number is a conflict.
const global4={impactSchemaVersion:1,from:{version:3,profileHash:h2},scope:'global',changedFields:['calibration'],selectors:[]};
const v4profile={...changed,calibration:'Recalibrated'};
beforePut=async key=>{if(key===currentKey){beforePut=null;throw new Error('Simulated crash after the version record');}};
let crashed;try{crashed=(await publish({version:4,profile:v4profile,changeImpact:global4})).status;}catch{crashed='thrown';}
assert.ok(crashed==='thrown'||crashed>=500,'the crash surfaces as a failure');
assert.ok(records.has(versionKey(4)),'the version record was written first');assert.equal(read(currentKey).version,3,'current did not move');
const orphanUpdatedAt=read(versionKey(4)).updatedAt;
r=await publish({version:4,profile:v4profile,changeImpact:global4});
assert.equal(r.status,200,'the retry completes');assert.equal(r.data.updatedAt,orphanUpdatedAt,'and reuses the record already written');assert.equal(read(currentKey).version,4);
records.set(versionKey(5),JSON.stringify({version:5,schemaVersion:1,profileHash:'someone-else',profile:{},changeImpact:null}));etags.set(versionKey(5),'etag-x');
before=snapshot();
r=await publish({version:5,profile:v4profile,changeImpact:identity({version:4,profileHash:read(currentKey).profileHash})});
assert.equal(r.status,409);assert.equal(r.data.code,'version_exists');assert.equal(snapshot(),before,'a conflicting record is never overwritten and current stays');
records.delete(versionKey(5));etags.delete(versionKey(5));

// Two concurrent publications: the one whose compare-and-swap loses is refused and current keeps the winner.
const h4=read(currentKey).profileHash;
beforePut=async key=>{if(key===currentKey){beforePut=null;const winner={...read(currentKey),version:99,profileHash:'winner'};records.set(currentKey,JSON.stringify(winner));etags.set(currentKey,'etag-'+(++revision));}};
r=await publish({version:5,profile:v4profile,changeImpact:identity({version:4,profileHash:h4})});
assert.equal(r.status,409);assert.equal(r.data.code,'profile_changed');assert.equal(read(currentKey).profileHash,'winner','the concurrent winner stays current');

// A legacy current record without lineage or impact (written before this contract) starts the lineage.
records.clear();etags.clear();
records.set(currentKey,JSON.stringify({version:7,schemaVersion:1,updatedAt:'2026-10-01T00:00:00.000Z',profileHash:'legacy',profile}));etags.set(currentKey,'etag-legacy');
r=await publish({version:8,profile:{...profile,pace:'Slower'},changeImpact:{impactSchemaVersion:1,from:{version:7,profileHash:'legacy'},scope:'global',changedFields:['pace'],selectors:[]}});
assert.equal(r.status,200);assert.deepEqual(r.data.lineage.map(link=>[link.version,link.changeImpact?.scope??null]),[[7,null],[8,'global']]);
assert.equal(records.has(versionKey(7)),false,'a legacy version record is not rewritten');
console.log('Profile publisher: fixture publication decisions, canonical approval hash, fail-closed impact shape, dry run, no write on rejection, create-only version record, compare-and-swap pointer, crash retry, version conflict, concurrent publication, identity and legacy lineage passed');
