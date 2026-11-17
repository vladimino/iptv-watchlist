import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash,webcrypto} from 'node:crypto';
import {manifestFor} from '../scripts/migration-export.mjs';
import {planMaterialization} from '../scripts/prediction-versions-plan.mjs';

// The plan tool and the domain module never reach a network or a bucket binding.
assert.doesNotMatch(fs.readFileSync('scripts/prediction-versions-plan.mjs','utf8'),/\bfetch\b|\bBUCKET\b|wrangler|\.put\(/);
assert.doesNotMatch(fs.readFileSync('src/domain/prediction-versions.js','utf8'),/\bfetch\b|\bBUCKET\b|crypto|await/);
assert.match(fs.readFileSync('build.mjs','utf8'),/prediction-versions\.js/);

// A fake bucket with ETags, write-once conditions and text bodies, plus failure injection on one key.
const records=new Map(),etags=new Map(),puts=[];let failKey='',revision=0;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){
  if(key===failKey)throw new Error('Simulated storage failure');
  const text=typeof value==='string'?value:String(value);
  const condition=options.onlyIf;
  puts.push({key,onlyIf:condition||null});
  if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;
  if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};
 },
 list:async()=>({objects:[],truncated:false})
};
const env={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/prediction-versions.js','utf8')+'\n'+fs.readFileSync('src/domain/profile-impact.js','utf8')+'\n'+fs.readFileSync('src/domain/prediction-compatibility.js','utf8')+'\n'+fs.readFileSync('src/domain/fingerprint-compatibility.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
vm.runInContext('globalThis.testApi={writePredictionVersion,contentHash,predictionVersionBody,predictionVersionText,predictionVersionKey,predictionVersionLinked,parsePredictionVersionKey,predictionMaterializationPlan};',ctx);
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>JSON.parse(records.get(key));
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const versionKeys=id=>[...records.keys()].filter(key=>key.startsWith('enrichment/films/'+id+'/predictions/versions/'));

// The writer has no switch any more (ADR 0045): no code path reads PREDICTION_VERSION_OBJECTS, and a stale binding is inert.
for(const file of ['src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js','src/sources.js','src/discovery.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.PREDICTION_VERSION_OBJECTS|predictionVersionsEnabled|version_objects_off/,file+' reads no version writer switch');
// The runner path ignores a stale binding: even 'off' writes a version object.
env.PREDICTION_VERSION_OBJECTS='off';

// Pure rules: canonical body, key shape, linkage.
{
 const record={filmId:'tmdb_7',predictedRating:4,generatedAt:'2026-10-26T10:00:00.000Z',nested:{b:1,a:[{z:1,y:2}]},r2Key:'x',contentSha256:'y',replacedAt:'later'};
 assert.equal(ctx.testApi.predictionVersionText(record),'{"filmId":"tmdb_7","generatedAt":"2026-10-26T10:00:00.000Z","nested":{"a":[{"y":2,"z":1}],"b":1},"predictedRating":4}');
 const sha=sha256(ctx.testApi.predictionVersionText(record));
 assert.equal(await ctx.testApi.contentHash(ctx.testApi.predictionVersionBody(record)),sha,'Worker hash of the canonical body equals the Node hash of the stored bytes');
 assert.equal(ctx.testApi.predictionVersionKey('tmdb_7',sha),'enrichment/films/tmdb_7/predictions/versions/'+sha+'.json');
 assert.equal(ctx.testApi.predictionVersionKey('a b/c',sha),'enrichment/films/a%20b%2Fc/predictions/versions/'+sha+'.json');
 assert.equal(JSON.stringify(ctx.testApi.parsePredictionVersionKey('enrichment/films/a%20b%2Fc/predictions/versions/'+sha+'.json')),JSON.stringify({filmId:'a b/c',sha256:sha}));
 assert.equal(ctx.testApi.parsePredictionVersionKey('enrichment/films/tmdb_7/predictions.json'),null);
 assert.equal(ctx.testApi.predictionVersionLinked({r2Key:ctx.testApi.predictionVersionKey('tmdb_7',sha),contentSha256:sha},'tmdb_7'),true);
 assert.equal(ctx.testApi.predictionVersionLinked({r2Key:ctx.testApi.predictionVersionKey('tmdb_7',sha),contentSha256:sha},'tmdb_8'),false,'another film\'s object is not a link');
 assert.equal(ctx.testApi.predictionVersionLinked({r2Key:ctx.testApi.predictionVersionKey('tmdb_7',sha),contentSha256:'0'.repeat(64)},'tmdb_7'),false,'the key must name the checksum');
 assert.equal(ctx.testApi.predictionVersionLinked({r2Key:'enrichment/films/tmdb_7/predictions.json',contentSha256:sha},'tmdb_7'),false);
}

// Write-once semantics: a retry with the same body is idempotent; an existing object with other bytes is a conflict.
{
 const record={filmId:'zz-once',predictedRating:3.5,generatedAt:'2026-10-26T10:00:00.000Z'};
 const first=await ctx.testApi.writePredictionVersion(env,'zz-once',record);
 const second=await ctx.testApi.writePredictionVersion(env,'zz-once',record);
 assert.equal(JSON.stringify(first),JSON.stringify(second));
 assert.equal(puts.filter(item=>item.key===first.r2Key).length,2,'the second put was attempted');
 assert.equal(puts.filter(item=>item.key===first.r2Key).every(item=>item.onlyIf?.etagDoesNotMatch==='*'),true,'every version write is conditional on absence');
 assert.equal(records.get(first.r2Key),ctx.testApi.predictionVersionText(record));
 assert.equal(sha256(records.get(first.r2Key)),first.contentSha256);
 records.set(first.r2Key,'{"tampered":true}');
 await assert.rejects(ctx.testApi.writePredictionVersion(env,'zz-once',record),/conflicts/);
 records.delete(first.r2Key);etags.delete(first.r2Key);
}

// The submit path end to end on batch runner v2 (the only runner since ADR 0162), D1 mode: first with a stale 'off' binding, then without any binding.
// D1 holds the pointers; R2 holds the immutable version objects and the bundle mirror read below. Puts are recorded and one key can be made to fail.
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Consistent rules',scifiAdventurePreferences:'Plot driven ideas',actionPreferences:'Readable action',anchorFilms:[{title:'Example',rating:4.5,reason:'Clever'}],hardSkips:['Cruelty for spectacle'],calibration:'Use full scale, be conservative'};
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','расследование']};
const {flowWorld,sql}=await import('./prediction-d1-flow-lib.mjs');
const w=await flowWorld({films:3});
const v2Text=key=>w.records.has(key)?JSON.stringify(w.records.get(key)):undefined;
const v2Read=key=>w.records.has(key)?structuredClone(w.records.get(key)):null;
const v2Keys=id=>[...w.records.keys()].filter(key=>key.startsWith('enrichment/films/'+id+'/predictions/versions/')).sort();
const v2Puts=[];
{const put=w.env.BUCKET.put.bind(w.env.BUCKET);w.env.BUCKET.put=async(key,value,options={})=>{v2Puts.push({key,onlyIf:options.onlyIf||null});return put(key,value,options);};}
const v2Api=async(route,method='POST',body)=>{const r=await w.ctx.worker.fetch(new Request('https://site.example/api/enrichment/'+route,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),w.env);return {status:r.status,data:await r.json()};};
// The flow world publishes a minimal profile version 1; version 2 is the full test profile over it (a global change of the fields that differ).
const publish=async(version,body)=>{const from=(await v2Api('profile','GET')).data;const ask=changedFields=>v2Api('profile','PUT',{version,schemaVersion:1,profile:body,changeImpact:{impactSchemaVersion:1,from:{version:from.version,profileHash:from.profileHash},scope:'global',changedFields,selectors:[]}});let r=await ask([]);if(r.data.code==='changed_fields_mismatch')r=await ask(r.data.changedFields);assert.equal(r.status,200,JSON.stringify(r.data));};
await publish(2,profile);
async function startRun(){assert.equal((await v2Api('queue/reconcile','POST',{})).status,200);const started=await v2Api('batch/start','POST',{scope:'watchlist_all',mode:'queued',trigger:'manual'});assert.equal(started.status,200,JSON.stringify(started.data).slice(0,300));return started.data;}
async function submit(run,filmId,extra={}){const result=await v2Api('batch/submit','POST',{runId:run.runId,epoch:run.lease.epoch,items:[{filmId,fingerprint:w.fingerprint,prediction:{...prediction,...extra}}]});assert.equal(result.status,200,JSON.stringify(result.data).slice(0,300));return result.data.results[0];}
const stop=run=>v2Api('complete','POST',{runId:run.runId,reason:'model_error'});
const [f0,f1,f2]=['tmdb_1','tmdb_2','tmdb_3'];

// A stale 'off' binding changes nothing: the version object is written and the bundle current points at it.
w.env.PREDICTION_VERSION_OBJECTS='off';
let run=await startRun();
assert.equal((await submit(run,f0)).status,'created');
assert.equal(v2Keys(f0).length,1);
assert.equal(v2Read('enrichment/films/'+f0+'/predictions.json').current.r2Key,v2Keys(f0)[0]);
assert.equal(ctx.testApi.predictionVersionLinked(v2Read('enrichment/films/'+f0+'/predictions.json').current,f0),true);
assert.equal((await stop(run)).status,200);
delete w.env.PREDICTION_VERSION_OBJECTS;

// No binding: a version object is written first, the bundle current points at it.
run=await startRun();
assert.equal((await submit(run,f1)).status,'created');
const bundle1=v2Read('enrichment/films/'+f1+'/predictions.json');
assert.equal(v2Keys(f1).length,1);
assert.equal(bundle1.current.r2Key,v2Keys(f1)[0]);
// Byte-hash invariant end to end: the pointer checksum is the SHA-256 of the exact stored bytes, the key names it, and the bundle record derives those same bytes.
assert.equal(sha256(v2Text(bundle1.current.r2Key)),bundle1.current.contentSha256);
assert.equal(bundle1.current.r2Key.endsWith('/'+bundle1.current.contentSha256+'.json'),true);
assert.equal(sha256(ctx.testApi.predictionVersionText(bundle1.current)),bundle1.current.contentSha256);
assert.equal(ctx.testApi.predictionVersionLinked(bundle1.current,f1),true);
assert.equal(v2Text(bundle1.current.r2Key),JSON.stringify(ctx.testApi.predictionVersionBody(bundle1.current)));
assert.equal(bundle1.current.predictedRating,4);
assert.deepEqual(bundle1.history,[]);
const versionPut=v2Puts.findIndex(item=>item.key===bundle1.current.r2Key),bundlePut=v2Puts.map(item=>item.key).lastIndexOf('enrichment/films/'+f1+'/predictions.json');
assert.equal(versionPut>=0&&versionPut<bundlePut,true,'the version object is written before the bundle');
assert.equal(v2Puts[versionPut].onlyIf?.etagDoesNotMatch,'*','the version write is conditional on absence');
// The identical submit again is a replay of the committed film and writes no second object.
{const again=await submit(run,f1);assert.equal(again.replayed,true,JSON.stringify(again));assert.equal(v2Keys(f1).length,1);}
assert.equal((await v2Api('view','GET')).status,200);
assert.equal((await stop(run)).status,200);

// Recalculation after a profile change: the replaced record keeps its pointer in history, the new current has its own object.
await publish(3,{...profile,pace:'Slower is fine'});
run=await startRun();
assert.equal((await submit(run,f1,{predictedRating:3.5})).status,'recalculated');
const bundle2=v2Read('enrichment/films/'+f1+'/predictions.json');
assert.equal(v2Keys(f1).length,2);
assert.equal(bundle2.history.length,1);
assert.equal(bundle2.history[0].r2Key,bundle1.current.r2Key);
assert.equal(bundle2.history[0].contentSha256,bundle1.current.contentSha256);
assert.equal(typeof bundle2.history[0].replacedAt,'string');
assert.notEqual(bundle2.current.r2Key,bundle1.current.r2Key);
assert.equal(sha256(v2Text(bundle2.current.r2Key)),bundle2.current.contentSha256);
// The history body excludes replacedAt and the pointer, so it hashes to the stored object exactly.
assert.equal(sha256(ctx.testApi.predictionVersionText(bundle2.history[0])),bundle2.history[0].contentSha256);
// Lineage of every new record: the run that produced it, its trigger and the fingerprint's full identity, also inside the
// immutable object; the replaced record keeps the run it came from.
assert.equal(bundle2.current.runId,run.runId);assert.equal(bundle2.current.trigger,'manual');assert.equal(bundle2.current.fingerprintPromptVersion,1);
assert.equal(bundle2.current.fingerprintHash,v2Read('enrichment/films/'+f1+'/fingerprint.json').fingerprintHash);
assert.equal(bundle2.current.tasteProfileVersion,3);assert.equal(bundle2.history[0].tasteProfileVersion,2);
assert.notEqual(bundle2.history[0].runId,run.runId);assert.equal(typeof bundle2.history[0].runId,'string');
assert.equal(JSON.parse(v2Text(bundle2.current.r2Key)).runId,run.runId);
assert.equal(JSON.parse(v2Text(bundle2.current.r2Key)).replacedAt,undefined);

// Partial commit: the authoritative D1 commit of the pointer fails after the version object exists. No pointer names it, the object stays
// unreferenced, and the next successful submit writes a new version and points at that one.
w.hooks.write=statements=>{if(statements.some(item=>/prediction_pointer/i.test(item.text)&&!/^\s*SELECT/i.test(item.text)))throw new Error('Simulated storage failure');};
const failed=await v2Api('batch/submit','POST',{runId:run.runId,epoch:run.lease.epoch,items:[{filmId:f2,fingerprint:w.fingerprint,prediction}]});
assert.notEqual(failed.data?.results?.[0]?.status,'created','the film is not committed: '+JSON.stringify(failed.data).slice(0,300));
assert.equal(v2Keys(f2).length,1,'the version object was written first');
const orphan=v2Keys(f2)[0];
w.hooks.write=null;
assert.ok(!sql(w.file,"SELECT film_id FROM prediction_pointer").some(row=>row.film_id===f2),'no D1 pointer names the object');
await stop(run);
run=await startRun();
assert.equal((await submit(run,f2)).status,'created');
const bundle3=v2Read('enrichment/films/'+f2+'/predictions.json');
assert.equal(v2Keys(f2).length,2);
assert.notEqual(bundle3.current.r2Key,orphan);
assert.equal(w.records.has(orphan),true,'nothing deletes the unreferenced object');
await stop(run);

// Materialization plan over a mixed bundle: linked records stay, unlinked ones get exact bytes, malformed pointers are reported.
{
 const plan=ctx.testApi.predictionMaterializationPlan(f1,{current:bundle2.current,history:[{...bundle1.current,r2Key:undefined,contentSha256:undefined,replacedAt:'2026-10-26T11:00:00.000Z'},{filmId:f1,predictedRating:2,r2Key:'enrichment/films/'+f1+'/predictions.json',contentSha256:'abc'}]});
 assert.equal(plan.linked.length,1);
 assert.equal(plan.pending.length,1);
 assert.equal(plan.malformed.length,1);
 assert.equal(plan.pending[0].role,'history');
 assert.equal(plan.pending[0].text,ctx.testApi.predictionVersionText(bundle1.current));
 assert.equal(sha256(plan.pending[0].text),bundle1.current.contentSha256,'the plan reproduces the object the writer would have written');
 assert.equal(plan.bundleRewriteNeeded,true);
 assert.equal(ctx.testApi.predictionMaterializationPlan(f1,{current:bundle2.current,history:[bundle2.history[0]]}).bundleRewriteNeeded,false);
}

// The plan tool over a snapshot directory: counts, link-only detection, checksum mismatch, unreferenced objects; no file is written.
{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prediction-plan-'));
 const legacy={current:{filmId:'tmdb_7',predictedRating:4,generatedAt:'2026-10-26T09:00:00.000Z',tasteProfileVersion:1},history:[{filmId:'tmdb_7',predictedRating:3,generatedAt:'2026-10-25T09:00:00.000Z',tasteProfileVersion:1,replacedAt:'2026-10-26T09:00:00.000Z'}]};
 const presentText=ctx.testApi.predictionVersionText(legacy.history[0]),presentSha=sha256(presentText),presentKey=ctx.testApi.predictionVersionKey('tmdb_7',presentSha);
 const mismatchText=ctx.testApi.predictionVersionText(legacy.current),mismatchSha=sha256(mismatchText),mismatchKey=ctx.testApi.predictionVersionKey('tmdb_7',mismatchSha);
 const bodies={
  'watchlist.json':JSON.stringify({films:[]}),'programme.json':JSON.stringify({runId:'run-plan',films:[]}),
  'enrichment/films/tmdb_7/predictions.json':JSON.stringify(legacy),
  [presentKey]:presentText,
  [mismatchKey]:'{"corrupt":true}',
  ['enrichment/films/'+f1+'/predictions.json']:v2Text('enrichment/films/'+f1+'/predictions.json'),
  [bundle2.current.r2Key]:v2Text(bundle2.current.r2Key),
  [bundle2.history[0].r2Key]:v2Text(bundle2.history[0].r2Key),
  [orphan]:v2Text(orphan),
 };
 fs.mkdirSync(path.join(root,'objects'),{recursive:true});
 const entries=Object.entries(bodies).map(([key,text])=>{const bytes=Buffer.from(text,'utf8');const name=createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex')+'.bin';fs.writeFileSync(path.join(root,'objects',name),bytes);return {key,file:'objects/'+name,size:bytes.length,sha256:sha256(text),metadata:{size:bytes.length}};});
 fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifestFor(entries,1,'2026-10-26T00:00:00.000Z','2026-10-26T01:00:00.000Z',[])));
 const before=JSON.stringify(fs.readdirSync(root).sort())+JSON.stringify(fs.readdirSync(path.join(root,'objects')).sort());
 const plan=await planMaterialization(root);
 assert.equal(plan.writes,'none');
 assert.equal(plan.totals.bundles,2);
 assert.equal(plan.totals.recordsLinked,2);
 assert.equal(plan.totals.recordsPending,2);
 assert.equal(plan.totals.objectsAlreadyPresent,1);
 assert.equal(plan.totals.presentChecksumMismatch,1);
 assert.equal(plan.totals.objectsToWrite,0);
 assert.equal(plan.totals.bundlesToRewrite,1);
 assert.deepEqual(plan.unreferenced,[orphan]);
 const legacyPlan=plan.films.find(item=>item.storedId==='tmdb_7');
 assert.equal(legacyPlan.objects.find(item=>item.role==='history').action,'link_only');
 assert.equal(legacyPlan.objects.find(item=>item.role==='current').action,'checksum_mismatch');
 assert.equal(JSON.stringify(fs.readdirSync(root).sort())+JSON.stringify(fs.readdirSync(path.join(root,'objects')).sort()),before,'the plan wrote nothing');
 const cli=spawnSync(process.execPath,['scripts/prediction-versions-plan.mjs','--snapshot',root],{encoding:'utf8'});
 assert.equal(cli.status,0,cli.stderr);
 assert.equal(JSON.parse(cli.stdout).totals.bundles,2);
 assert.equal(spawnSync(process.execPath,['scripts/prediction-versions-plan.mjs','--snapshot','relative'],{encoding:'utf8'}).status,2);
 fs.rmSync(root,{recursive:true,force:true});
}
console.log('Prediction versions: no writer switch (a stale binding is inert), canonical bytes and shared hash, write-once retry and conflict, version-first commit order, history links, partial commit without a dangling pointer, backward compatibility and the materialization plan passed');
