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
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8')+'\n'+fs.readFileSync('src/domain/prediction-versions.js','utf8')+'\n'+fs.readFileSync('src/domain/profile-impact.js','utf8')+'\n'+fs.readFileSync('src/domain/prediction-compatibility.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
vm.runInContext('globalThis.testApi={writePredictionVersion,contentHash,predictionVersionBody,predictionVersionText,predictionVersionKey,predictionVersionLinked,parsePredictionVersionKey,predictionMaterializationPlan,predictionVersionsEnabled};',ctx);
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>JSON.parse(records.get(key));
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const versionKeys=id=>[...records.keys()].filter(key=>key.startsWith('enrichment/films/'+id+'/predictions/versions/'));

// Flag parsing: only the literal 'on' enables the writer.
// Flag parsing is strict: the exact string 'on' and nothing else; whitespace, case and non-string values stay off.
assert.equal(ctx.testApi.predictionVersionsEnabled({}),false);
assert.equal(ctx.testApi.predictionVersionsEnabled(undefined),false);
assert.equal(ctx.testApi.predictionVersionsEnabled({PREDICTION_VERSION_OBJECTS:'on'}),true);
for(const value of ['shadow',' on ','on ',' on','ON','On','yes','true','1',1,true,['on'],{value:'on'},null,undefined,''])assert.equal(ctx.testApi.predictionVersionsEnabled({PREDICTION_VERSION_OBJECTS:value}),false,JSON.stringify(value));
// The runner path honours the same strictness: a padded value writes no version object.
env.PREDICTION_VERSION_OBJECTS=' on ';

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

// The runner protocol end to end, flag off then on.
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Consistent rules',scifiAdventurePreferences:'Plot driven ideas',actionPreferences:'Readable action',anchorFilms:[{title:'Example',rating:4.5,reason:'Clever'}],hardSkips:['Cruelty for spectacle'],calibration:'Use full scale, be conservative'};
assert.equal((await api('enrichment/profile','PUT',{version:1,schemaVersion:1,profile})).status,200);
const now=Date.now(),film=id=>({id,title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres:['Боевик'],synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
const films=['film000','film001','film002'].map(film);
records.set('programme.json',JSON.stringify({runId:'programme-1',updatedAt:new Date().toISOString(),window:{from:now-72*3600000,to:now+24*3600000},films,watchlistCount:films.length}));records.set('sync.json',JSON.stringify({runId:'programme-1',stage:'complete'}));
const execution={plot_engine:'strong',pace:'fast',stakes:'high',decision_logic:'unknown',protagonist_competence:'unknown',opposition_competence:'unknown',problem_solving:'unknown',plan_counterplan_strength:'unknown',multi_party_goals:'unknown',chemistry:'unknown',payoff:'unknown',ending_quality:'unknown',technical_plausibility:'unknown',horror_rule_consistency:'strong',action_readability:'strong'};
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['напряжённый','расследование'],strengths:['Good mystery'],risks:[],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','расследование']};
async function startRun(){const started=await api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'});assert.equal(started.status,200);return started.data.runId;}
async function submit(runId,filmId,extra={}){const result=await api('enrichment/submit','POST',{runId,items:[{filmId,fingerprint,prediction:{...prediction,...extra}}]});assert.equal(result.status,200);return result.data.results[0];}

// Flag not exactly 'on': the bundle keeps its shape, no version object is written.
let runId=await startRun();
assert.equal((await submit(runId,'film000')).status,'created');
assert.equal(read('enrichment/films/film000/predictions.json').current.r2Key,undefined);
assert.equal(versionKeys('film000').length,0);
assert.equal([...records.keys()].some(key=>key.includes('/predictions/versions/')),false);
await api('enrichment/complete','POST',{runId,reason:'model_error'});
delete env.PREDICTION_VERSION_OBJECTS;

// Flag on: a version object is written first, the bundle current points at it, the view index carries the same record.
env.PREDICTION_VERSION_OBJECTS='on';
runId=await startRun();
assert.equal((await submit(runId,'film001')).status,'created');
const bundle1=read('enrichment/films/film001/predictions.json');
assert.equal(versionKeys('film001').length,1);
assert.equal(bundle1.current.r2Key,versionKeys('film001')[0]);
// Byte-hash invariant end to end: the pointer checksum is the SHA-256 of the exact stored bytes, the key names it, and the bundle record derives those same bytes.
assert.equal(sha256(records.get(bundle1.current.r2Key)),bundle1.current.contentSha256);
assert.equal(bundle1.current.r2Key.endsWith('/'+bundle1.current.contentSha256+'.json'),true);
assert.equal(sha256(ctx.testApi.predictionVersionText(bundle1.current)),bundle1.current.contentSha256);
assert.equal(ctx.testApi.predictionVersionLinked(bundle1.current,'film001'),true);
assert.equal(records.get(bundle1.current.r2Key),JSON.stringify(ctx.testApi.predictionVersionBody(bundle1.current)));
assert.equal(bundle1.current.predictedRating,4);
assert.deepEqual(bundle1.history,[]);
assert.equal(read('enrichment/view-index.json').film001.prediction.r2Key,bundle1.current.r2Key);
const versionPut=puts.findIndex(item=>item.key===bundle1.current.r2Key),bundlePut=puts.map(item=>item.key).lastIndexOf('enrichment/films/film001/predictions.json');
assert.equal(versionPut>=0&&versionPut<bundlePut,true,'the version object is written before the bundle');
// Backward compatibility: a pointer-carrying current prediction is still recognised as current.
assert.equal((await submit(runId,'film001')).status,'already_current');
assert.equal(versionKeys('film001').length,1);
assert.equal((await api('enrichment/view')).status,200);
await api('enrichment/complete','POST',{runId,reason:'model_error'});

// Recalculation after a profile change: the replaced record keeps its pointer in history, the new current has its own object.
assert.equal((await api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:{...profile,pace:'Slower is fine'},changeImpact:{impactSchemaVersion:1,from:{version:1,profileHash:JSON.parse(records.get('enrichment/profile/current.json')).profileHash},scope:'global',changedFields:['pace'],selectors:[]}})).status,200);
runId=await startRun();
assert.equal((await submit(runId,'film001',{predictedRating:3.5})).status,'recalculated');
const bundle2=read('enrichment/films/film001/predictions.json');
assert.equal(versionKeys('film001').length,2);
assert.equal(bundle2.history.length,1);
assert.equal(bundle2.history[0].r2Key,bundle1.current.r2Key);
assert.equal(bundle2.history[0].contentSha256,bundle1.current.contentSha256);
assert.equal(typeof bundle2.history[0].replacedAt,'string');
assert.notEqual(bundle2.current.r2Key,bundle1.current.r2Key);
assert.equal(sha256(records.get(bundle2.current.r2Key)),bundle2.current.contentSha256);
// The history body excludes replacedAt and the pointer, so it hashes to the stored object exactly.
assert.equal(sha256(ctx.testApi.predictionVersionText(bundle2.history[0])),bundle2.history[0].contentSha256);

// Partial commit: the bundle write fails after the version object exists. The bundle is unchanged, the object stays unreferenced,
// and the next successful submit writes a new version and points at that one.
failKey='enrichment/films/film002/predictions.json';
const failed=await submit(runId,'film002');
assert.equal(failed.status,'failed');
assert.equal(failed.error,'storage_error');
assert.equal(records.has('enrichment/films/film002/predictions.json'),false);
assert.equal(versionKeys('film002').length,1);
const orphan=versionKeys('film002')[0];
failKey='';
runId=await startRun();
assert.equal((await submit(runId,'film002')).status,'created');
const bundle3=read('enrichment/films/film002/predictions.json');
assert.equal(versionKeys('film002').length,2);
assert.notEqual(bundle3.current.r2Key,orphan);
assert.equal(records.has(orphan),true,'nothing deletes the unreferenced object');
await api('enrichment/complete','POST',{runId,reason:'model_error'});

// Materialization plan over a mixed bundle: linked records stay, unlinked ones get exact bytes, malformed pointers are reported.
{
 const plan=ctx.testApi.predictionMaterializationPlan('film001',{current:bundle2.current,history:[{...bundle1.current,r2Key:undefined,contentSha256:undefined,replacedAt:'2026-10-26T11:00:00.000Z'},{filmId:'film001',predictedRating:2,r2Key:'enrichment/films/film001/predictions.json',contentSha256:'abc'}]});
 assert.equal(plan.linked.length,1);
 assert.equal(plan.pending.length,1);
 assert.equal(plan.malformed.length,1);
 assert.equal(plan.pending[0].role,'history');
 assert.equal(plan.pending[0].text,ctx.testApi.predictionVersionText(bundle1.current));
 assert.equal(sha256(plan.pending[0].text),bundle1.current.contentSha256,'the plan reproduces the object the writer would have written');
 assert.equal(plan.bundleRewriteNeeded,true);
 assert.equal(ctx.testApi.predictionMaterializationPlan('film001',{current:bundle2.current,history:[bundle2.history[0]]}).bundleRewriteNeeded,false);
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
  'enrichment/films/film001/predictions.json':records.get('enrichment/films/film001/predictions.json'),
  [bundle2.current.r2Key]:records.get(bundle2.current.r2Key),
  [bundle2.history[0].r2Key]:records.get(bundle2.history[0].r2Key),
  [orphan]:records.get(orphan),
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
console.log('Prediction versions: flag gate, canonical bytes and shared hash, write-once retry and conflict, version-first commit order, history links, partial commit without a dangling pointer, backward compatibility and the materialization plan passed');
