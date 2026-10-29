import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';

// The fingerprint migration queue, immutable fingerprint storage and run binding (ADR-0035 sections 2, 6, 7). Two Worker
// "releases" run over one bucket: release 1 is the live code (schema 1, empty registry); release 2 is the same code with
// FINGERPRINT_SCHEMA_VERSION 2, a declared split of chase_escape and the matching MECHANICS. The shared transition verdict
// always decides (ADR 0047); the strict outcome is only counted beside it, and a stale PREDICTION_FINGERPRINT_COMPATIBILITY
// binding of any value is inert.
const records=new Map(),etags=new Map();let revision=0;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){const text=String(value),condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 // Paginated like R2: `limit` objects per page and an opaque cursor while more remain.
 list:async({prefix='',limit=1000,cursor}={})=>{const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort(),start=cursor?Number(cursor):0,truncated=start+limit<keys.length;return {objects:keys.slice(start,start+limit).map(key=>({key})),truncated,...(truncated?{cursor:String(start+limit)}:{})};}
};
const baseEnv={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value));
const domain=['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
const enrichmentSource=fs.readFileSync('src/enrichment.js','utf8');
assert.match(enrichmentSource,/const FINGERPRINT_SCHEMA_VERSION=1;/);assert.match(enrichmentSource,/const FINGERPRINT_TRANSITIONS=\[\];/);assert.match(enrichmentSource,/'chase_escape',/);

// The declared transition of release 2, approved by the owner (digest over the canonical declaration).
const scratch=vm.createContext({});vm.runInContext(domain,scratch);
const split={transitionSchemaVersion:1,axis:'fingerprint_schema',from:1,to:2,scope:'selective',changes:[{kind:'value_split',field:'plotMechanics',from:'chase_escape',to:['chase','escape']}],selectors:[{kind:'mechanic',values:['chase_escape'],regenerate:{mode:'partial',fields:['plotMechanics']}}]};
split.approval={approvedBy:'owner',approvedAt:'2026-01-01T00:00:00.000Z',reviewRef:'decision-ref',declarationSha256:sha256(vm.runInContext('fingerprintTransitionDeclarationText',scratch)(split))};

function release(patch){
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
 vm.runInContext(domain,ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext((file==='src/enrichment.js'?patch(enrichmentSource):fs.readFileSync(file,'utf8')).replace('export default','globalThis.worker='),ctx);
 vm.runInContext('globalThis.T={writeFingerprint,predictionFreshness,queueBatchIds,fingerprintSchemaVocabulary,FINGERPRINT_SCHEMA_BASE,FINGERPRINT_TRANSITIONS,FINGERPRINT_SCHEMA_VERSION,MECHANICS,EXECUTION,GENERAL_EXECUTION,PROFILE_GENRE_DOMAINS,PROFILE_GENRE_ALIASES};',ctx);
 const api=async(path,method='GET',body,flags={})=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{...baseEnv,...flags});return {status:response.status,data:await response.json()};};
 return {ctx,T:ctx.T,api};
}
const R1=release(source=>source);
const R2=release(source=>source.replace('const FINGERPRINT_SCHEMA_VERSION=1;','const FINGERPRINT_SCHEMA_VERSION=2;').replace('const FINGERPRINT_TRANSITIONS=[];','const FINGERPRINT_TRANSITIONS='+JSON.stringify([split])+';').replace("'chase_escape',","'chase','escape',"));
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const write=(key,value)=>{records.set(key,JSON.stringify(value));etags.set(key,'etag-'+(++revision));};
const keysUnder=prefix=>[...records.keys()].filter(key=>key.startsWith(prefix)).sort();
const SELECTIVE={PREDICTION_FINGERPRINT_COMPATIBILITY:'selective'},STRICT={PREDICTION_FINGERPRINT_COMPATIBILITY:'strict'},OBJECTS={FINGERPRINT_VERSION_OBJECTS:'on'}; // a stale binding of the retired writer switch (ADR 0046): inert

// Flags: only the exact strings.
// The fingerprint rule has no switch any more (ADR 0047): no code path reads PREDICTION_FINGERPRINT_COMPATIBILITY.
for(const file of ['src/enrichment.js','src/worker.js','src/sources.js','src/discovery.js','src/prediction-diagnostics.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.PREDICTION_FINGERPRINT_COMPATIBILITY|fingerprintCompatibilityMode/,file+' reads no fingerprint rule switch');
// The immutable fingerprint writer has no switch any more (ADR 0046): no code path reads FINGERPRINT_VERSION_OBJECTS.
for(const file of ['src/enrichment.js','src/worker.js','src/sources.js','src/discovery.js','src/prediction-diagnostics.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.FINGERPRINT_VERSION_OBJECTS|fingerprintVersionsEnabled/,file+' reads no fingerprint writer switch');

// The registry applied to the frozen schema-1 base reproduces the live vocabulary of each release.
for(const [name,R] of [['release 1',R1],['release 2',R2]]){
 const derived=R.T.fingerprintSchemaVocabulary(R.T.FINGERPRINT_TRANSITIONS.filter(t=>t.axis==='fingerprint_schema'),R.T.FINGERPRINT_SCHEMA_VERSION,R.T.FINGERPRINT_SCHEMA_BASE);
 assert.deepEqual(plain({mechanics:derived.mechanics,execution:derived.execution,general:derived.general,domains:derived.domains}),plain({mechanics:R.T.MECHANICS,execution:R.T.EXECUTION,general:R.T.GENERAL_EXECUTION,domains:R.T.PROFILE_GENRE_DOMAINS}),name+': registry and constants agree');
}
assert.deepEqual(plain(R1.T.FINGERPRINT_SCHEMA_BASE),plain({mechanics:R1.T.MECHANICS,execution:R1.T.EXECUTION,general:R1.T.GENERAL_EXECUTION,domains:R1.T.PROFILE_GENRE_DOMAINS}),'the frozen base is schema 1');

// Five watchlist films airing now. A and C hold heist (unreached by the split), B and E chase_escape (reached), D has no fingerprint.
const now=Date.now(),film=(id,genres)=>({id,tmdbId:String(100+id.charCodeAt(0)),title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres,synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
const films=[film('A',['Драма']),film('B',['Триллер']),film('C',['Комедия']),film('D',['Драма']),film('E',['Ужасы'])];
const programme=list=>{write('programme.json',{runId:'programme-1',updatedAt:new Date().toISOString(),window:{from:now-72*3600000,to:now+24*3600000},films:list,watchlistCount:list.length});write('sync.json',{runId:'programme-1',stage:'complete'});};
programme(films);
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Rules matter',scifiAdventurePreferences:'Concept driven',actionPreferences:'Readable action',anchorFilms:[],hardSkips:[],calibration:'Half steps'};
assert.equal((await R1.api('enrichment/profile','PUT',{version:1,schemaVersion:1,profile})).status,200);
const execution=Object.fromEntries(R1.T.GENERAL_EXECUTION.map(key=>[key,R1.T.EXECUTION[key][0]]));
const fingerprintOf=(mechanics,schema=1)=>({fingerprintSchemaVersion:schema,plotMechanics:mechanics,execution,moodLabels:['напряжённый','мрачный'],strengths:['Good'],risks:[],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']});
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','мрачный']};
const mechanicsOf={A:['heist'],B:['chase_escape','rescue'],C:['heist'],E:['chase_escape']};
const reconcile=async(R,flags={})=>{const r=await R.api('enrichment/queue/reconcile','POST',{},flags);assert.equal(r.status,200);return read('enrichment/prediction-queue.json');};
// Everything but the clock: refreshedAt and the milliseconds-to-deadline of each priority entry.
const stable=queue=>{const {refreshedAt,priority,...rest}=plain(queue);return {...rest,priority:Object.fromEntries(Object.entries(priority).map(([id,p])=>{const {expiresInMs,...fixed}=p;return [id,fixed];}))};};
const startRun=async(R,flags={},batchSize)=>{const r=await R.api('enrichment/start','POST',{scope:'watchlist_all',mode:'queued',...(batchSize?{batchSize}:{})},flags);assert.equal(r.status,200,JSON.stringify(r.data));return r.data.runId;};
const next=async(R,runId,flags={})=>{const r=await R.api('enrichment/next','POST',{runId},flags);return r;};
const finish=(R,runId)=>R.api('enrichment/complete','POST',{runId,reason:'model_error'});

// Release 1: fingerprints and predictions for A, B, C, E with version objects on; D stays missing.
{
 const runId=(await R1.api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'})).data.runId;
 for(const id of ['A','B','C','E'])assert.equal((await R1.api('enrichment/submit','POST',{runId,items:[{filmId:id,fingerprint:fingerprintOf(mechanicsOf[id]),prediction}]},OBJECTS)).data.results[0].status,'created',id);
 await finish(R1,runId);
}
const pointer=id=>read('enrichment/films/'+id+'/fingerprint.json');
for(const id of ['A','B','C','E']){
 const p=pointer(id);
 assert.deepEqual([p.fingerprintSchemaVersion,p.fingerprintPromptVersion,p.produced,p.previous],[1,1,'generated',null],id+' pointer provenance');
 assert.deepEqual(keysUnder('enrichment/films/'+id+'/fingerprints/'),['enrichment/films/'+id+'/fingerprints/'+p.fingerprintHash+'.json'],id+' one content body');
 assert.deepEqual(keysUnder('enrichment/films/'+id+'/fingerprint-generations/'),['enrichment/films/'+id+'/fingerprint-generations/'+p.fingerprintHash+'-s1-p1.json'],id+' one generation record');
 const body=read('enrichment/films/'+id+'/fingerprints/'+p.fingerprintHash+'.json'),record=read('enrichment/films/'+id+'/fingerprint-generations/'+p.fingerprintHash+'-s1-p1.json');
 assert.equal(body.fingerprintHash,p.fingerprintHash);assert.equal(body.fingerprintPromptVersion,undefined,'the body is content only');
 assert.deepEqual(plain(record),{filmId:id,fingerprintHash:p.fingerprintHash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,generatedAt:p.generatedAt,produced:'generated',previous:null});
 assert.equal(read('enrichment/view-index.json')[id].impactFeatures.fingerprintPromptVersion,1,id+' facet carries the prompt version');
 assert.equal(read('enrichment/films/'+id+'/predictions.json').current.fingerprintSchemaVersion,1);
}

// Release 1: with an empty registry every schema-1 fingerprint is exact; the work map names the missing film.
let queue=await reconcile(R1);
assert.deepEqual(queue.pending,['D']);
assert.deepEqual(plain(queue.fingerprintCompatibility),{mode:'selective',evaluatorVersion:1,registryDigest:sha256('[]'),target:{fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1},films:5,unindexed:0,strict:{current:4,stale:0},selective:{current:4,compatible:0,stale:0},reasons:{exact:4},fingerprintReasons:{exact:4},migration:{none:4,compatible:0,partial:0,full:0,global:0},classes:{unchanged:4,missing:1,prediction_only:0,fingerprint_and_prediction:0,migration:0,unknown:0},wouldKeep:0,wouldRequeue:0,strictDisagreements:0});
assert.deepEqual(plain(queue.work),{D:{class:'missing',requiredWork:'fingerprint_and_prediction',migration:null,reason:null}});
assert.deepEqual([queue.fingerprintSchemaVersion,queue.fingerprintPromptVersion,queue.predictionPromptVersion],[1,1,1],'the queue is bound to the versions it was built with');
assert.deepEqual(stable(await reconcile(R1)),stable(queue),'a repeated refresh is identical');
for(const binding of [SELECTIVE,STRICT,{PREDICTION_FINGERPRINT_COMPATIBILITY:' Strict'}])assert.deepEqual(stable(await reconcile(R1,binding)),stable(queue),'a stale binding is inert: '+JSON.stringify(binding));

// Same body, two prompt versions: a second generation record, one body; the pointer names the record it replaced.
{
 const before=pointer('C'),{filmId:_i,fingerprintHash:_h,generatedAt:_g,invalidatedAt:_n,fingerprintPromptVersion:_p,produced:_r,previous:_v,...content}=before;
 const after=await R1.T.writeFingerprint({...baseEnv,...OBJECTS},'C',content,before,'generated',undefined,2);
 assert.equal(after.fingerprintHash,before.fingerprintHash,'identical content keeps the hash');
 assert.deepEqual(plain([after.fingerprintPromptVersion,after.produced,after.previous]),[2,'generated',{fingerprintHash:before.fingerprintHash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1}]);
 assert.equal(keysUnder('enrichment/films/C/fingerprints/').length,1,'one body');
 assert.deepEqual(keysUnder('enrichment/films/C/fingerprint-generations/').map(key=>key.slice(key.lastIndexOf('-s'))),['-s1-p1.json','-s1-p2.json'],'two generation records');
 assert.equal(read('enrichment/films/C/fingerprint-generations/'+before.fingerprintHash+'-s1-p1.json').generatedAt,before.generatedAt,'the first record is untouched');
}
// No binding and every stale binding write the same three objects (ADR 0046): body, generation record, then the pointer.
{
 const {filmId:_i,fingerprintHash:_h,generatedAt:_g,invalidatedAt:_n,fingerprintPromptVersion:_p,produced:_r,previous:_v,...content}=pointer('C');
 const shapes=[];
 for(const [n,binding] of [[undefined],['off'],['on'],['On'],[{value:'on'}]].entries()){
  const id='W'+n,env={...baseEnv,...(binding[0]===undefined?{}:{FINGERPRINT_VERSION_OBJECTS:binding[0]})};
  const value=await R1.T.writeFingerprint(env,id,content,null,'generated');
  const body=read('enrichment/films/'+id+'/fingerprints/'+value.fingerprintHash+'.json'),record=read('enrichment/films/'+id+'/fingerprint-generations/'+value.fingerprintHash+'-s1-p1.json');
  assert.equal(body.fingerprintHash,value.fingerprintHash,String(binding[0]));assert.equal(record.fingerprintHash,value.fingerprintHash,String(binding[0]));
  const {filmId:_a,fingerprintHash:_b,...bodyRest}=body,{filmId:_c,fingerprintHash:_d,generatedAt:_e,...recordRest}=record;
  shapes.push(JSON.stringify(plain({body:bodyRest,record:recordRest,pointer:[value.produced,value.previous,value.fingerprintPromptVersion]})));
  for(const key of [...records.keys()].filter(key=>key.startsWith('enrichment/films/'+id+'/'))){records.delete(key);etags.delete(key);}
  const index=read('enrichment/view-index.json');if(index){delete index[id];write('enrichment/view-index.json',index);}
 }
 assert.equal(new Set(shapes).size,1,'the binding changes nothing');
}
// Release 1: the prompt-2 record is ahead of the code, even with a stale strict binding; the runner restores the prompt-1
// record, no model call. Exact equality would have kept C; the rule in force does not.
queue=await reconcile(R1,STRICT);
assert.equal(queue.fingerprintCompatibility.mode,'selective');
assert.deepEqual(plain([queue.fingerprintCompatibility.fingerprintReasons,queue.fingerprintCompatibility.reasons]),[{exact:3,fingerprint_ahead:1},{exact:3,fingerprint_not_current:1}]);
queue=await reconcile(R1);
assert.deepEqual(queue.pending,['D','C'],'missing work before migration work');
assert.deepEqual(plain(queue.work.C),{class:'fingerprint_and_prediction',requiredWork:'fingerprint_and_prediction',migration:'full',reason:'fingerprint_not_current'});
{
 const runId=await startRun(R1,SELECTIVE);
 const r=await next(R1,runId,SELECTIVE);assert.equal(r.status,200);
 assert.deepEqual(plain(r.data.items.map(item=>item.filmId)),['D'],'C needs no work after the restore');
 assert.deepEqual(plain([r.data.fingerprintSchemaVersion,r.data.fingerprintPromptVersion,r.data.predictionPromptVersion]),[1,1,1]);
 const p=pointer('C');
 assert.deepEqual([p.fingerprintPromptVersion,p.produced,p.previous.fingerprintPromptVersion],[1,'restored',2]);
 assert.equal(keysUnder('enrichment/films/C/fingerprint-generations/').length,2,'a restore adds no record');
 assert.deepEqual(read('enrichment/runs/'+runId+'.json').restored,['C']);
 await finish(R1,runId);
}

// Release 2 with a stale strict binding: the transition rule decides; the shadow counters show that exact equality would
// have made every schema-1 fingerprint stale; migration work is bounded per batch and follows missing work.
queue=await reconcile(R2,STRICT);
assert.deepEqual(queue.pending,['D','B','E']);
{
 const f=plain(queue.fingerprintCompatibility);
 assert.equal(f.registryDigest,sha256(JSON.stringify(vm.runInContext('profileImpactCanonical',scratch)([split]))),'the registry digest is over the canonical declaration list');
 assert.deepEqual([f.mode,f.target.fingerprintSchemaVersion,f.strict,f.selective,f.reasons,f.fingerprintReasons,f.migration,f.classes,f.wouldKeep,f.wouldRequeue],['selective',2,{current:0,stale:4},{current:2,compatible:0,stale:2},{exact:2,fingerprint_not_current:2},{transition_unaffected:2,transition_impacted:2},{none:0,compatible:2,partial:2,full:0,global:0},{unchanged:2,missing:1,prediction_only:0,fingerprint_and_prediction:2,migration:2,unknown:0},2,0]);
 assert.equal(queue.work.A,undefined,'the unaffected film is kept');
 assert.deepEqual(plain(R2.T.queueBatchIds(queue,queue.pending,3)),['D','B','E'],'3 slots: the missing film plus at most 2 migration films');
 assert.deepEqual(plain(R2.T.queueBatchIds(queue,queue.pending,2)),['D','B'],'2 slots: at most 1 migration film');
 assert.deepEqual(plain(R2.T.queueBatchIds(queue,['B','E'],2)),['B'],'slots migration cannot fill stay empty');
}

// Release 2: only the reached films migrate; a partial class names its fields; a regenerated fingerprint keeps its
// predecessor's identity and provenance; the kept film's prediction is untouched.
queue=await reconcile(R2);
assert.deepEqual(queue.pending,['D','B','E']);
assert.deepEqual(plain(queue.work.B),{class:'fingerprint_and_prediction',requiredWork:'fingerprint_and_prediction',migration:'partial',reason:'fingerprint_not_current',fields:['plotMechanics']});
assert.deepEqual(plain(queue.fingerprintCompatibility.classes),{unchanged:2,missing:1,prediction_only:0,fingerprint_and_prediction:2,migration:2,unknown:0});
assert.equal(queue.fingerprintCompatibility.strictDisagreements,0);
assert.deepEqual(stable(await reconcile(R2,SELECTIVE)),stable(queue),'a repeated selective refresh is identical');
{
 const freshness=await R2.T.predictionFreshness({...baseEnv,...SELECTIVE},read('enrichment/profile/current.json')),state=id=>({prediction:read('enrichment/films/'+id+'/predictions.json').current,fingerprint:pointer(id)});
 assert.equal(freshness.work(state('E').prediction,state('E').fingerprint,['Ужасы']).reason,queue.work.E.reason,'the queue and the runner give the same stale reason');
 assert.equal(freshness.work(state('A').prediction,state('A').fingerprint,['Драма']).outcome,'current');
 const runId=await startRun(R2,SELECTIVE,3);
 let r=await next(R2,runId,SELECTIVE);assert.equal(r.status,200);
 assert.deepEqual(plain(r.data.items.map(item=>[item.filmId,item.requiredWork])),[['D','fingerprint_and_prediction'],['B','fingerprint_and_prediction'],['E','fingerprint_and_prediction']]);
 const oldB=pointer('B'),oldPredictionA=read('enrichment/films/A/predictions.json').current;
 r=await R2.api('enrichment/submit','POST',{runId,items:[{filmId:'B',fingerprint:fingerprintOf(['chase','rescue'],2),prediction}]},{...SELECTIVE,...OBJECTS});
 assert.equal(r.data.results[0].status,'recalculated',JSON.stringify(r.data));
 const newB=pointer('B');
 assert.deepEqual([newB.fingerprintSchemaVersion,newB.fingerprintPromptVersion,newB.produced,newB.previous],[2,1,'generated',{fingerprintHash:oldB.fingerprintHash,fingerprintSchemaVersion:1,fingerprintPromptVersion:1}]);
 assert.notEqual(newB.fingerprintHash,oldB.fingerprintHash);
 assert.equal(keysUnder('enrichment/films/B/fingerprints/').length,2);assert.equal(keysUnder('enrichment/films/B/fingerprint-generations/').length,2);
 assert.equal(read('enrichment/films/B/predictions.json').current.fingerprintSchemaVersion,2,'the new prediction carries its fingerprint schema');
 assert.equal(read('enrichment/films/B/predictions.json').history.at(-1).fingerprintHash,oldB.fingerprintHash,'the old prediction is history');
 r=await R2.api('enrichment/submit','POST',{runId,items:[{filmId:'D',fingerprint:fingerprintOf(['heist'],2),prediction}]},{...SELECTIVE,FINGERPRINT_VERSION_OBJECTS:'off'});
 assert.equal(r.data.results[0].status,'created');
 assert.deepEqual([pointer('D').fingerprintPromptVersion,pointer('D').produced,pointer('D').previous],[1,'generated',null],'the pointer is stamped');
 assert.deepEqual(keysUnder('enrichment/films/D/fingerprints/'),['enrichment/films/D/fingerprints/'+pointer('D').fingerprintHash+'.json'],'a stale off binding is inert: the body is written');
 assert.deepEqual(keysUnder('enrichment/films/D/fingerprint-generations/'),['enrichment/films/D/fingerprint-generations/'+pointer('D').fingerprintHash+'-s2-p1.json'],'and so is the generation record');
 assert.equal((await R2.api('enrichment/submit','POST',{runId,items:[{filmId:'A',prediction}]},SELECTIVE)).data.results[0].error,'Film not selected','a kept film is not work');
 assert.deepEqual(read('enrichment/films/A/predictions.json').current,oldPredictionA,'the kept prediction keeps its schema-1 provenance');
 // Preemption: a new hot film without a prediction enters the batch before the waiting migration film.
 programme([...films,film('G',['Драма'])]);
 r=await next(R2,runId,SELECTIVE);assert.equal(r.status,200);
 assert.deepEqual(plain(r.data.items.map(item=>item.filmId)),['G'],'the one free slot goes to the new hot film; E waits');
 assert.equal((await next(R1,runId,SELECTIVE)).status,409,'the run is bound to the release that started it');
 assert.equal((await next(R1,runId,SELECTIVE)).data.code,'contract_changed');
 assert.equal((await R1.api('enrichment/complete','POST',{runId},SELECTIVE)).data.code,'contract_changed');
 assert.equal((await finish(R2,runId)).status,200,'a reasoned stop is still accepted');
}

// Rollback to release 1: E (schema 1) is exact again. B is restored from its stored schema-1 record (prediction_only from
// there); D, whose only stored generation is schema 2, has nothing to restore and regenerates. A stale strict binding does
// not bring back the full regeneration of the rollback floor.
programme(films);
queue=await reconcile(R1,STRICT);
assert.deepEqual(queue.pending,['B','D']);
assert.deepEqual([queue.work.B.reason,queue.work.B.migration,queue.work.D.reason,queue.work.D.migration,queue.fingerprintCompatibility.fingerprintReasons.fingerprint_ahead],['fingerprint_not_current','full','fingerprint_not_current','full',2]);
{
 const schema2=pointer('B');
 const runId=await startRun(R1,SELECTIVE);
 const r=await next(R1,runId,SELECTIVE);
 assert.deepEqual(plain(r.data.items.map(item=>[item.filmId,item.requiredWork])),[['B','prediction_only']],'the restored schema-1 fingerprint is reused; D waits for the next batch');
 assert.equal(r.data.items[0].fingerprint.fingerprintSchemaVersion,1);
 assert.deepEqual(plain(read('enrichment/runs/'+runId+'.json').restored),['B']);
 const restored=pointer('B');
 assert.deepEqual([restored.fingerprintSchemaVersion,restored.produced,restored.previous],[1,'restored',{fingerprintHash:schema2.fingerprintHash,fingerprintSchemaVersion:2,fingerprintPromptVersion:1}]);
 assert.equal(read('enrichment/films/B/predictions.json').current.fingerprintHash,schema2.fingerprintHash,'history predictions are not promoted back');
 assert.equal(keysUnder('enrichment/films/B/fingerprint-generations/').length,2,'a restore adds no record');
 assert.equal((await R1.api('enrichment/submit','POST',{runId,items:[{filmId:'B',prediction}]},SELECTIVE)).data.results[0].status,'recalculated','a prediction from the restored fingerprint, no fingerprint sent');
 assert.deepEqual([read('enrichment/films/B/predictions.json').current.fingerprintHash,read('enrichment/films/B/predictions.json').current.fingerprintSchemaVersion],[restored.fingerprintHash,1]);
 const again=await next(R1,runId,SELECTIVE);
 assert.deepEqual(plain(again.data.items.map(item=>[item.filmId,item.requiredWork])),[['D','fingerprint_and_prediction']],'D has no stored record to restore and regenerates');
 assert.equal(pointer('D').fingerprintSchemaVersion,2,'nothing was restored for D');
 await finish(R1,runId);
}

// Storage safety. A planted object under a generation record's key is accepted only when it is a valid record of the same
// identity with a stored body; a corrupted or foreign object is a storage conflict and the pointer and index do not move.
{
 const canonical=vm.runInContext('profileImpactCanonical',scratch),hashOf=(id,content)=>sha256(JSON.stringify(canonical({...content,filmId:id})));
 programme([...films,film('H',['Драма']),film('J',['Драма'])]);
 const contentH=fingerprintOf(['heist']),hashH=hashOf('H',contentH),contentJ=fingerprintOf(['scam']),hashJ=hashOf('J',contentJ);
 write('enrichment/films/H/fingerprint-generations/'+hashH+'-s1-p1.json',{filmId:'H',fingerprintHash:'other',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,generatedAt:'2026-01-01T00:00:00.000Z',produced:'generated',previous:null});
 records.set('enrichment/films/J/fingerprint-generations/'+hashJ+'-s1-p1.json','{not json');etags.set('enrichment/films/J/fingerprint-generations/'+hashJ+'-s1-p1.json','etag-planted');
 const runId=(await R1.api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'})).data.runId;
 const r=await R1.api('enrichment/submit','POST',{runId,items:[{filmId:'H',fingerprint:contentH,prediction},{filmId:'J',fingerprint:contentJ,prediction}]},OBJECTS);
 for(const result of r.data.results)assert.deepEqual([result.status,result.error,result.failureScope],['failed','storage_error','run'],result.filmId+' is a storage conflict');
 for(const id of ['H','J']){assert.equal(pointer(id),null,id+' pointer not written');assert.equal(read('enrichment/view-index.json')[id]?.fingerprintHash,undefined,id+' index not written');assert.equal(read('enrichment/films/'+id+'/predictions.json'),null,id+' no prediction');}
 assert.equal(read('enrichment/films/H/fingerprint-generations/'+hashH+'-s1-p1.json').fingerprintHash,'other','the planted object is left as it is');
 // A valid record of the same identity written earlier (a retried submit) is accepted and keeps its first values.
 write('enrichment/films/H/fingerprint-generations/'+hashH+'-s1-p1.json',{filmId:'H',fingerprintHash:hashH,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,generatedAt:'2026-01-01T00:00:00.000Z',produced:'generated',previous:null});
 write('enrichment/films/H/fingerprints/'+hashH+'.json',{...contentH,filmId:'H',fingerprintHash:hashH});
 await finish(R1,runId);
 const retryRunId=(await R1.api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'})).data.runId,again=await R1.api('enrichment/submit','POST',{runId:retryRunId,items:[{filmId:'H',fingerprint:contentH,prediction}]},OBJECTS);
 assert.equal(again.data.results[0].status,'created',JSON.stringify(again.data));
 assert.equal(pointer('H').fingerprintHash,hashH);assert.equal(read('enrichment/films/H/fingerprint-generations/'+hashH+'-s1-p1.json').generatedAt,'2026-01-01T00:00:00.000Z','first values kept');
 await finish(R1,retryRunId);
}

// Rollback history beyond one list page: the matching record on a later page is still found; a history over the scan limit
// is a storage error, not a silent regeneration.
{
 programme(films);
 const dummy=(id,n)=>'enrichment/films/'+id+'/fingerprint-generations/'+String(n).padStart(64,'0')+'-s1-p1.json';
 const schema1=read('enrichment/films/B/fingerprint-generations/'+keysUnder('enrichment/films/B/fingerprint-generations/').find(key=>key.endsWith('-s1-p1.json')).split('/').at(-1)),schema2Key=keysUnder('enrichment/films/B/fingerprint-generations/').find(key=>key.endsWith('-s2-p1.json')),schema2=read(schema2Key),body2=read('enrichment/films/B/fingerprints/'+schema2.fingerprintHash+'.json');
 const {filmId:_i2,fingerprintHash:_h2,...content2}=body2,backToSchema2=()=>R1.T.writeFingerprint(baseEnv,'B',content2,pointer('B'),'generated',undefined,1);
 await backToSchema2();
 for(let n=0;n<150;n++)write(dummy('B',n),{filmId:'B',fingerprintHash:'missing-'+n,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,generatedAt:'2025-01-01T00:00:00.000Z',produced:'generated',previous:null});
 assert.equal(keysUnder('enrichment/films/B/fingerprint-generations/').indexOf('enrichment/films/B/fingerprint-generations/'+schema1.fingerprintHash+'-s1-p1.json')>=100,true,'the real record sorts onto the second page');
 queue=await reconcile(R1,SELECTIVE);assert.deepEqual(queue.pending,['B','D']);
 let runId=await startRun(R1,SELECTIVE);
 let r=await next(R1,runId,SELECTIVE);assert.equal(r.status,200);
 assert.equal(pointer('B').fingerprintHash,schema1.fingerprintHash,'restored from the second page');
 assert.deepEqual(plain(read('enrichment/runs/'+runId+'.json').restored),['B']);
 assert.deepEqual(plain(r.data.items.map(item=>[item.filmId,item.requiredWork])),[['D','fingerprint_and_prediction']],'B is current again with its restored prediction, so the slot goes to D');
 await finish(R1,runId);
 for(let n=150;n<=1000;n++)write(dummy('B',n),{filmId:'B',fingerprintHash:'missing-'+n,fingerprintSchemaVersion:1,fingerprintPromptVersion:1,generatedAt:'2025-01-01T00:00:00.000Z',produced:'generated',previous:null});
 await backToSchema2();
 queue=await reconcile(R1,SELECTIVE);assert.deepEqual(queue.pending,['B','D']);
 runId=await startRun(R1,SELECTIVE);
 r=await next(R1,runId,SELECTIVE);
 assert.equal(r.status,502,'a history over the scan limit fails the step with the storage error status instead of regenerating');
 assert.equal(pointer('B').fingerprintSchemaVersion,2,'nothing moved');
 for(let n=0;n<=1000;n++){records.delete(dummy('B',n));etags.delete(dummy('B',n));}
 await finish(R1,runId);
}

// Zero and one film.
programme([]);queue=await reconcile(R1,SELECTIVE);assert.deepEqual([queue.pending,queue.fingerprintCompatibility.films,plain(queue.work)],[[],0,{}]);
programme([films[0]]);queue=await reconcile(R1,SELECTIVE);assert.deepEqual([queue.pending,queue.fingerprintCompatibility.classes.unchanged],[[],1]);
console.log('Fingerprint migration queue: immutable body/record/pointer storage with no writer switch (stale bindings inert), same body under two prompt versions, no fingerprint rule switch (stale bindings inert) with strict shadow counters, work classes and partial fields, bounded migration batches after missing work, hot preemption, run binding to every axis, pointer restore on rollback and the strict rollback floor passed');
