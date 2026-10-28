import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';

// Every reader of current/stale follows the fingerprint transition rule the queue uses (ADR-0035): the view, the queue
// status, the status route, the queue overview and the per-film diagnostics (the MCP read tools return these bodies). Two
// Worker releases run over one bucket, as in tests/fingerprint-migration-queue.mjs: release 1 is the live code, release 2
// has schema 2 and a declared split of chase_escape. Strict stays today's behaviour; selective explains with reasons.
const records=new Map(),etags=new Map();let revision=0;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){const text=String(value),condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 list:async({prefix='',limit=1000,cursor}={})=>{const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort(),start=cursor?Number(cursor):0,truncated=start+limit<keys.length;return {objects:keys.slice(start,start+limit).map(key=>({key})),truncated,...(truncated?{cursor:String(start+limit)}:{})};}
};
const baseEnv={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');
const plain=value=>JSON.parse(JSON.stringify(value));
const domain=['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
const enrichmentSource=fs.readFileSync('src/enrichment.js','utf8');
const scratch=vm.createContext({});vm.runInContext(domain,scratch);
const canonical=vm.runInContext('profileImpactCanonical',scratch);
const split={transitionSchemaVersion:1,axis:'fingerprint_schema',from:1,to:2,scope:'selective',changes:[{kind:'value_split',field:'plotMechanics',from:'chase_escape',to:['chase','escape']}],selectors:[{kind:'mechanic',values:['chase_escape'],regenerate:{mode:'partial',fields:['plotMechanics']}}]};
split.approval={approvedBy:'owner',approvedAt:'2026-01-01T00:00:00.000Z',reviewRef:'decision-ref',declarationSha256:sha256(vm.runInContext('fingerprintTransitionDeclarationText',scratch)(split))};
function release(patch){
 const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,encodeURIComponent,decodeURIComponent,crypto:webcrypto,console});
 vm.runInContext(domain,ctx);
 for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext((file==='src/enrichment.js'?patch(enrichmentSource):fs.readFileSync(file,'utf8')).replace('export default','globalThis.worker='),ctx);
 vm.runInContext('globalThis.T={loadPredictionDiagnosticSnapshot,predictionFilmDiagnostic,predictionQueueOverview,GENERAL_EXECUTION,EXECUTION};',ctx);
 const api=async(path,method='GET',body,flags={})=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),{...baseEnv,...flags});return {status:response.status,data:await response.json()};};
 const diagnostics=async(id,flags={})=>plain(ctx.T.predictionFilmDiagnostic(await ctx.T.loadPredictionDiagnosticSnapshot({...baseEnv,...flags},id),id,Date.now()));
 const overview=async(flags={})=>plain(ctx.T.predictionQueueOverview(await ctx.T.loadPredictionDiagnosticSnapshot({...baseEnv,...flags}),Date.now()));
 return {ctx,T:ctx.T,api,diagnostics,overview};
}
const R1=release(source=>source);
const R2=release(source=>source.replace('const FINGERPRINT_SCHEMA_VERSION=1;','const FINGERPRINT_SCHEMA_VERSION=2;').replace('const FINGERPRINT_TRANSITIONS=[];','const FINGERPRINT_TRANSITIONS='+JSON.stringify([split])+';').replace("'chase_escape',","'chase','escape',"));
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const write=(key,value)=>{records.set(key,JSON.stringify(value));etags.set(key,'etag-'+(++revision));};
const SELECTIVE={PREDICTION_FINGERPRINT_COMPATIBILITY:'selective'},PROFILE_SELECTIVE={PREDICTION_PROFILE_COMPATIBILITY:'selective'},OBJECTS={FINGERPRINT_VERSION_OBJECTS:'on'};

// Five watchlist films airing now; A and C hold heist (unreached by the split), B and E chase_escape (reached), D has nothing.
const now=Date.now(),film=(id,genres)=>({id,tmdbId:String(100+id.charCodeAt(0)),title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres,synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
const films=[film('A',['Драма']),film('B',['Триллер']),film('C',['Комедия']),film('D',['Драма']),film('E',['Ужасы'])];
write('programme.json',{runId:'programme-1',updatedAt:new Date().toISOString(),window:{from:now-72*3600000,to:now+24*3600000},films,watchlistCount:films.length});write('sync.json',{runId:'programme-1',stage:'complete'});
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Rules matter',scifiAdventurePreferences:'Concept driven',actionPreferences:'Readable action',anchorFilms:[],hardSkips:[],calibration:'Half steps'};
assert.equal((await R1.api('enrichment/profile','PUT',{version:1,schemaVersion:1,profile})).status,200);
const execution=Object.fromEntries(R1.T.GENERAL_EXECUTION.map(key=>[key,R1.T.EXECUTION[key][0]]));
const fingerprintOf=mechanics=>({fingerprintSchemaVersion:1,plotMechanics:mechanics,execution,moodLabels:['напряжённый','мрачный'],strengths:['Good'],risks:[],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']});
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','мрачный']};
const mechanicsOf={A:['heist'],B:['chase_escape','rescue'],C:['heist'],E:['chase_escape']};
{
 const runId=(await R1.api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'})).data.runId;
 for(const id of ['A','B','C','E'])assert.equal((await R1.api('enrichment/submit','POST',{runId,items:[{filmId:id,fingerprint:fingerprintOf(mechanicsOf[id]),prediction}]},OBJECTS)).data.results[0].status,'created',id);
 await R1.api('enrichment/complete','POST',{runId,reason:'model_error'});
}
const reconcile=async(R,flags={})=>{assert.equal((await R.api('enrichment/queue/reconcile','POST',{},flags)).status,200);return read('enrichment/prediction-queue.json');};
const view=async(R,flags={})=>(await R.api('enrichment/view','GET',undefined,flags)).data;
const historyOf=id=>JSON.stringify(read('enrichment/films/'+id+'/predictions.json').history);
// This bucket has no catalog and no published EPG generation, which the overview reports as `_not_recorded` sources; the
// disagreements this test is about are the others.
const disagreements=o=>o.snapshot.reasons.filter(reason=>!reason.endsWith('_not_recorded'));
const historyBefore=Object.fromEntries(['A','B','C','E'].map(id=>[id,historyOf(id)]));

// Release 1, strict: every reader reports current, with the fingerprint provenance and the modes in force.
let queue=await reconcile(R1);
{
 const v=await view(R1);
 assert.deepEqual(plain(v.compatibility),{profileMode:'strict',fingerprintMode:'strict',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1});
 for(const id of ['A','B','C','E']){assert.equal(v.films[id].prediction.stale,false,id);assert.deepEqual(v.films[id].fingerprint.plotMechanics,mechanicsOf[id],id+' display facet');}
 assert.equal(v.films.D?.prediction??null,null,'a film never submitted has no index entry');
 const status=(await R1.api('enrichment/queue/status')).data;
 assert.equal(status.fingerprintCompatibility.mode,'strict');assert.deepEqual([status.fingerprintSchemaVersion,status.fingerprintPromptVersion,status.predictionPromptVersion],[1,1,1]);
 assert.deepEqual(plain(status.fingerprintCompatibility.classes),{unchanged:4,missing:1,prediction_only:0,fingerprint_and_prediction:0,migration:0,unknown:0});
 const runner=(await R1.api('enrichment/status')).data;
 assert.deepEqual([runner.fingerprintSchemaVersion,runner.fingerprintPromptVersion,runner.predictionPromptVersion,plain(runner.compatibility)],[1,1,1,{profileMode:'strict',fingerprintMode:'strict'}]);
 const a=await R1.diagnostics('A');
 assert.deepEqual(a.fingerprint,{presence:'recorded',schemaVersion:1,promptVersion:1,produced:'generated',previous:null,current:true,usable:true,invalidated:false,reason:'exact',migration:'none',mode:'strict'});
 assert.deepEqual(a.prediction,{presence:'recorded',current:true,stale:false,profileMatch:true,cause:'current',reason:'exact',requiredWork:'none',mode:'strict',fingerprintMode:'strict'});
 assert.equal(a.index,'agreed');
 const d=await R1.diagnostics('D');
 assert.deepEqual([d.fingerprint.presence,d.fingerprint.usable,d.fingerprint.reason,d.fingerprint.migration,d.prediction.cause],['not_recorded',false,'fingerprint_missing','full','not_recorded']);
 const o=await R1.overview();
 assert.deepEqual(disagreements(o),[]);
 assert.deepEqual(o.snapshot.fingerprint.mode,'strict');assert.deepEqual(o.snapshot.fingerprint.target,{fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1});
 assert.equal(o.snapshot.fingerprint.queue.classes.unchanged,4);assert.equal(o.snapshot.fingerprint.registryDigest,o.snapshot.fingerprint.queue.registryDigest);
 assert.deepEqual([o.coverage.current,o.coverage.total],[4,5]);
}

// A queue built by release 1 read by release 2 before any refresh: the overview names the changed versions and registry.
{
 const o=await R2.overview();
 assert.deepEqual(disagreements(o),['fingerprint_schema_differs','fingerprint_registry_differs']);assert.equal(o.snapshot.consistent,false);
 assert.equal(o.snapshot.fingerprint.target.fingerprintSchemaVersion,2);assert.notEqual(o.snapshot.fingerprint.registryDigest,o.snapshot.fingerprint.queue.registryDigest);
}

// Release 2, strict (no switch): a schema change makes every reader stale, with the strict reason; facets stay displayed.
queue=await reconcile(R2);
{
 const v=await view(R2);
 for(const id of ['A','B','C','E']){assert.equal(v.films[id].prediction.stale,true,id+' strict');assert.deepEqual(v.films[id].fingerprint.plotMechanics,mechanicsOf[id],id+' facet kept');}
 const a=await R2.diagnostics('A');
 assert.deepEqual([a.fingerprint.current,a.fingerprint.usable,a.fingerprint.reason,a.fingerprint.migration,a.fingerprint.mode],[false,false,'fingerprint_version_changed','full','strict']);
 assert.deepEqual([a.prediction.current,a.prediction.cause,a.prediction.reason,a.prediction.requiredWork,a.prediction.fingerprintMode],[false,'fingerprint_not_current','fingerprint_not_current','fingerprint_and_prediction','strict']);
 assert.equal(a.index,'agreed');
 const o=await R2.overview();
 assert.deepEqual(disagreements(o),[]);assert.deepEqual([o.coverage.current,o.pending.total],[0,5]);
}

// Release 2, selective: the kept films read as current everywhere, the reached ones as stale with the transition reason;
// queue, view, overview and diagnostics agree film by film.
queue=await reconcile(R2,SELECTIVE);
assert.deepEqual(queue.pending,['D','B','E']);
{
 const v=await view(R2,SELECTIVE);
 assert.deepEqual(plain([v.compatibility.fingerprintMode,v.films.A.prediction.stale,v.films.C.prediction.stale,v.films.B.prediction.stale,v.films.E.prediction.stale]),['selective',false,false,true,true]);
 const a=await R2.diagnostics('A',SELECTIVE);
 assert.deepEqual([a.fingerprint.current,a.fingerprint.usable,a.fingerprint.reason,a.fingerprint.migration,a.fingerprint.mode,a.fingerprint.schemaVersion],[false,true,'transition_unaffected','compatible','selective',1]);
 assert.deepEqual([a.prediction.current,a.prediction.cause,a.prediction.reason,a.prediction.requiredWork],[true,'current','exact','none'],'the prediction over a compatible fingerprint is current; the fingerprint block carries the compatibility');
 assert.equal(a.index,'agreed');
 const b=await R2.diagnostics('B',SELECTIVE);
 assert.deepEqual([b.fingerprint.usable,b.fingerprint.reason,b.fingerprint.migration,b.prediction.cause,b.prediction.reason,b.prediction.requiredWork,b.index,b.lane,b.eligibleNow],[false,'transition_impacted','partial','fingerprint_not_current','fingerprint_not_current','fingerprint_and_prediction','agreed','hot',true]);
 assert.equal(b.prediction.reason,queue.work.B.reason,'the diagnostics and the queue give the same reason');
 assert.equal(b.prediction.requiredWork,queue.work.B.requiredWork);
 const o=await R2.overview(SELECTIVE);
 assert.deepEqual(disagreements(o),[]);
 assert.deepEqual(plain(o.snapshot.fingerprint.queue.classes),{unchanged:2,missing:1,prediction_only:0,fingerprint_and_prediction:2,migration:2,unknown:0});
 assert.deepEqual([o.coverage.current,o.coverage.total,o.pending.total],[2,5,3]);
 const status=(await R2.api('enrichment/queue/status','GET',undefined,SELECTIVE)).data;
 assert.deepEqual(plain(status.fingerprintCompatibility.classes),plain(o.snapshot.fingerprint.queue.classes),'queue status and overview read the same block');
}

// Mismatch between the prediction and the fingerprint it names: prediction_only, never current.
{
 const bundle=read('enrichment/films/C/predictions.json'),saved=JSON.stringify(bundle);
 bundle.current.fingerprintHash='other';write('enrichment/films/C/predictions.json',bundle);
 const c=await R2.diagnostics('C',SELECTIVE);
 assert.deepEqual([c.fingerprint.usable,c.prediction.current,c.prediction.cause,c.prediction.reason,c.prediction.requiredWork],[true,false,'stale','fingerprint_changed','prediction_only']);
 records.set('enrichment/films/C/predictions.json',saved);
}

// An invalidated fingerprint is stale under every rule: no reader calls it or its prediction current.
{
 const pointer=read('enrichment/films/A/fingerprint.json'),saved=JSON.stringify(pointer),index=read('enrichment/view-index.json'),savedIndex=JSON.stringify(index);
 pointer.invalidatedAt='2026-01-01T00:00:00.000Z';write('enrichment/films/A/fingerprint.json',pointer);index.A.impactFeatures.invalidatedAt=pointer.invalidatedAt;write('enrichment/view-index.json',index);
 const a=await R2.diagnostics('A',SELECTIVE);
 assert.deepEqual([a.fingerprint.usable,a.fingerprint.invalidated,a.fingerprint.reason,a.prediction.current,a.prediction.cause,a.index],[false,true,'fingerprint_invalidated',false,'fingerprint_not_current','agreed']);
 assert.equal((await view(R2,SELECTIVE)).films.A.prediction.stale,true);
 assert.deepEqual((await reconcile(R2,SELECTIVE)).pending,['D','A','B','E']);
 records.set('enrichment/films/A/fingerprint.json',saved);records.set('enrichment/view-index.json',savedIndex);
 queue=await reconcile(R2,SELECTIVE);assert.deepEqual(queue.pending,['D','B','E']);
}

// Profile version 2 (an approved selective edit of horror preferences): the fingerprint rule is judged before the profile
// rule, and each rule follows its own switch.
{
 const h1=read('enrichment/profile/current.json').profileHash,changed={...profile,horrorPreferences:'Rules and causality matter'},h2=sha256(JSON.stringify(canonical(changed)));
 const impact={impactSchemaVersion:1,from:{version:1,profileHash:h1},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']}]};
 impact.approval={approvedBy:'owner',approvedAt:'2026-01-01T00:00:00.000Z',reviewRef:'decision-ref',declarationSha256:sha256(vm.runInContext('profileDeclarationText',scratch)(impact,{version:2,profileHash:h2}))};
 assert.equal((await R2.api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:changed,changeImpact:impact},SELECTIVE)).status,200);
 const strictProfile=await R2.diagnostics('A',SELECTIVE);
 assert.deepEqual([strictProfile.prediction.current,strictProfile.prediction.cause,strictProfile.prediction.reason,strictProfile.prediction.mode],[false,'profile_changed','profile_changed','strict'],'profile switch off: the new version makes the kept-fingerprint prediction stale');
 const both={...SELECTIVE,...PROFILE_SELECTIVE},a=await R2.diagnostics('A',both);
 assert.deepEqual([a.fingerprint.usable,a.prediction.current,a.prediction.profileMatch,a.prediction.cause,a.prediction.reason,a.prediction.requiredWork,a.prediction.mode],[true,true,false,'compatible','profile_unaffected','none','selective']);
 const e=await R2.diagnostics('E',both);
 assert.deepEqual([e.fingerprint.reason,e.prediction.cause,e.prediction.reason],['transition_impacted','fingerprint_not_current','fingerprint_not_current'],'the fingerprint verdict comes first');
 queue=await reconcile(R2,both);
 assert.deepEqual(queue.pending,['D','B','E'],'A and C are kept under both rules');
 assert.equal((await view(R2,both)).films.A.prediction.stale,false);
 assert.equal((await reconcile(R2,SELECTIVE)).pending.includes('A'),true,'with the profile switch off A is outstanding again');
 const o=await R2.overview(both);assert.deepEqual(disagreements(o),['index_ahead_of_queue'],'the stored queue was built under the other profile switch, so the index is ahead of it');
 await reconcile(R2,both);
}

// Strict fallback: with both switches unset the readers are back to exact equality.
{
 queue=await reconcile(R2);
 assert.deepEqual(queue.pending,['D','A','B','C','E']);
 const v=await view(R2);for(const id of ['A','B','C','E'])assert.equal(v.films[id].prediction.stale,true,id);
 assert.equal((await R2.diagnostics('A')).prediction.cause,'fingerprint_not_current');
}
for(const id of ['A','B','C','E'])assert.equal(historyOf(id),historyBefore[id],id+' prediction history untouched by every read');
assert.equal(read('enrichment/films/A/fingerprint.json').fingerprintSchemaVersion,1,'no read rewrote a fingerprint');
console.log('Fingerprint readers: view, queue status, status, overview and film diagnostics follow the fingerprint rule in force, agree with the queue film by film, name reasons, provenance and versions, fail closed on invalidated and mismatched records, judge the fingerprint before the profile, and leave history untouched');
