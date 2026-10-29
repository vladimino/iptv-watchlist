import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The prediction queue and the shared compatibility evaluator (ADR-0031): the selective rule always decides (ADR 0043:
// the PREDICTION_PROFILE_COMPATIBILITY switch is retired and inert), the strict outcome is counted beside it, an unknown
// or unapproved change fails closed, and impact features come from the full fingerprint, bound to its hash.
const records=new Map(),etags=new Map();let revision=0;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){const text=String(value),condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 list:async()=>({objects:[],truncated:false})
};
const env={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
vm.runInContext('globalThis.T={fingerprintImpactFacet,EXECUTION,GENERAL_EXECUTION};',ctx);
const T=ctx.T;
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const write=(key,value)=>{records.set(key,JSON.stringify(value));etags.set(key,'etag-'+(++revision));};

// No selector: the retired switch is not read anywhere in the Worker.
for(const file of ['src/enrichment.js','src/prediction-diagnostics.js','src/worker.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.PREDICTION_PROFILE_COMPATIBILITY|predictionCompatibilityMode/,file+' reads no profile-rule switch');

// Impact features: a copy of the full fingerprint, bound to its hash; nothing without a hash.
const execution=Object.fromEntries(T.GENERAL_EXECUTION.map(key=>[key,T.EXECUTION[key][0]]));
const full={fingerprintSchemaVersion:1,fingerprintHash:'f-x',plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'},moodLabels:['a','b']};
assert.deepEqual(JSON.parse(JSON.stringify(T.fingerprintImpactFacet(full))),{fingerprintHash:'f-x',fingerprintSchemaVersion:1,fingerprintPromptVersion:null,invalidatedAt:null,plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'}},'unknown and genre-specific values are kept');
assert.equal(T.fingerprintImpactFacet({...full,fingerprintHash:''}),null);assert.equal(T.fingerprintImpactFacet(null),null);

// A programme of four watchlist films, all airing now.
const now=Date.now(),film=(id,genres)=>({id,tmdbId:String(100+Number(id.slice(-3))),title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres,synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
const films=[film('film000',['Драма']),film('film001',['Ужасы']),film('film002',['Драма']),film('film003',['Драма'])];
write('programme.json',{runId:'programme-1',updatedAt:new Date().toISOString(),window:{from:now-72*3600000,to:now+24*3600000},films,watchlistCount:films.length});write('sync.json',{runId:'programme-1',stage:'complete'});
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Rules matter',scifiAdventurePreferences:'Concept driven',actionPreferences:'Readable action',anchorFilms:[],hardSkips:['Gross-out'],calibration:'Be calibrated'};
assert.equal((await api('enrichment/profile','PUT',{version:1,schemaVersion:1,profile})).status,200);
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['напряжённый','расследование'],strengths:['Good mystery'],risks:[],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','расследование']};
let started=await api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'});assert.equal(started.status,200);
for(const id of ['film000','film001','film002'])assert.equal((await api('enrichment/submit','POST',{runId:started.data.runId,items:[{filmId:id,fingerprint,prediction}]})).data.results[0].status,'created');
await api('enrichment/complete','POST',{runId:started.data.runId,reason:'model_error'});
const index=read('enrichment/view-index.json');
for(const id of ['film000','film001','film002']){assert.equal(index[id].impactFeatures.fingerprintHash,index[id].fingerprintHash,id+' submit stores impact features bound to the fingerprint');assert.deepEqual(index[id].impactFeatures.execution,execution);}
// film002 stands for an index entry written before impact features existed.
delete index.film002.impactFeatures;write('enrichment/view-index.json',index);

const reconcile=async()=>{const r=await api('enrichment/queue/reconcile','POST',{});assert.equal(r.status,200);return read('enrichment/prediction-queue.json');};
const pending=queue=>[...queue.pending].sort();
let queue=await reconcile();
assert.deepEqual(pending(queue),['film003']);
assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility)),{mode:'selective',evaluatorVersion:1,profileVersion:1,films:4,missing:1,strict:{current:3,stale:0},selective:{current:3,compatible:0,stale:0},reasons:{exact:3},wouldKeep:0,wouldRequeue:0,strictDisagreements:0});
assert.deepEqual((await api('enrichment/queue/status')).data.compatibility,queue.compatibility,'queue status exposes the counters');

// v2: an approved selective edit of horror preferences.
const h1=read('enrichment/profile/current.json').profileHash,changed={...profile,horrorPreferences:'Rules and causality matter'};
const horror={impactSchemaVersion:1,from:{version:1,profileHash:h1},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']}]};
const dry=await api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:changed,changeImpact:horror,dryRun:true});
assert.equal(dry.data.code,'selective_requires_owner_approval');
const approved={...horror,approval:{approvedBy:'owner',approvedAt:'2026-10-27T22:00:00.000Z',reviewRef:'trello-comment:test',declarationSha256:dry.data.declarationSha256}};
assert.equal((await api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:changed,changeImpact:approved})).status,200);
// Selective decides with no variable: the unaffected drama keeps its prediction; the shadow shows what strict would requeue.
queue=read('enrichment/prediction-queue.json');
assert.equal(queue.trigger,'profile_updated');
assert.deepEqual(pending(queue),['film001','film002','film003']);
assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility)),{mode:'selective',evaluatorVersion:1,profileVersion:2,films:4,missing:1,strict:{current:0,stale:3},selective:{current:0,compatible:1,stale:2},reasons:{profile_unaffected:1,profile_impacted:1,film_features_unknown:1},wouldKeep:1,wouldRequeue:0,strictDisagreements:0});
// Queue/reader agreement: a predicted film is pending exactly when the view calls its prediction stale.
const view=(await api('enrichment/view')).data.films;
for(const id of ['film000','film001','film002'])assert.equal(queue.pending.includes(id),view[id].prediction.stale===true,id);

// The unaffected drama keeps its prediction (no recomputation), the horror film and the film without impact features are
// pending, the film without a prediction stays pending. A stale binding of any value changes nothing.
for(const value of ['strict','selective','Selective',' strict',true]){env.PREDICTION_PROFILE_COMPATIBILITY=value;queue=await reconcile();assert.equal(queue.compatibility.mode,'selective',String(value));assert.deepEqual(pending(queue),['film001','film002','film003'],'binding '+String(value));}
delete env.PREDICTION_PROFILE_COMPATIBILITY;
queue=await reconcile();
assert.equal(queue.compatibility.mode,'selective');
assert.deepEqual(pending(queue),['film001','film002','film003']);
assert.equal(read('enrichment/films/film000/predictions.json').current.tasteProfileVersion,1,'the carried prediction keeps its original version');
// Every consumer follows the same mode and snapshot: the view, coverage, diagnostics, the runner and the catalog.
const selectiveView=(await api('enrichment/view')).data.films;
for(const id of ['film000','film001','film002'])assert.equal(selectiveView[id].prediction.stale,queue.pending.includes(id),id+' view agrees with the queue under selective');
const footer=(await api('enrichment/footer/status')).data;
assert.equal(footer.coverage.currentPredictionsTotal,1,'coverage counts the carried prediction');
ctx.diagEnv=env;
const diagnostic=film=>vm.runInContext(`(async()=>JSON.parse(JSON.stringify(predictionFilmDiagnostic(await loadPredictionDiagnosticSnapshot(diagEnv,'${film}'),'${film}',Date.now()))))()`,ctx);
const kept=await diagnostic('film000'),reached=await diagnostic('film001');
assert.deepEqual([kept.prediction.current,kept.prediction.cause,kept.prediction.mode,kept.index],[true,'compatible','selective','agreed']);
assert.deepEqual([reached.prediction.current,reached.prediction.cause,reached.index],[false,'profile_changed','agreed']);
// Catalog and Finds: the same rule on catalog records.
const indexNow=read('enrichment/view-index.json'),catalogFilm=(id,genres)=>({id,tmdbId:id.slice(5),canonicalIdentity:'tmdb:'+id.slice(5),title:id,original:id,year:2020,genres,shows:[{channelId:'c1',channel:'One',start:now}],showsProgrammeRunId:'programme-1'});
ctx.catalogInput={catalog:{tmdb_900:catalogFilm('tmdb_900',['Драма']),tmdb_901:catalogFilm('tmdb_901',['Ужасы'])},programme:read('programme.json'),watchlist:{films:[]},index:{tmdb_900:indexNow.film000,tmdb_901:indexNow.film001},profile:read('enrichment/profile/current.json'),metadata:{},programmeRunId:'programme-1',pinned:false,now:Date.now()};
const offered=async()=>vm.runInContext("(async()=>catalogAvailable({...catalogInput,freshness:await predictionFreshness(diagEnv,catalogInput.profile)}).films.map(film=>film.id))()",ctx);
assert.deepEqual([...await offered()],['tmdb_900'],'the catalog offers the carried prediction, not the reached one');
// The runner: start does not count the kept film as pending; a submit for it is already_current and keeps version 1.
started=await api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'});assert.equal(started.status,200);
// The runner reads the full fingerprint, so it also keeps film002, whose index entry lacks the impact facet.
assert.equal(started.data.pendingCount,2,'film001 and film003 are pending; film000 and film002 are kept');
assert.equal((await api('enrichment/submit','POST',{runId:started.data.runId,items:[{filmId:'film000',fingerprint,prediction}]})).data.results[0].status,'already_current');
assert.equal(read('enrichment/films/film000/predictions.json').current.tasteProfileVersion,1,'no recomputation, no version rewrite');
assert.equal((await api('enrichment/submit','POST',{runId:started.data.runId,items:[{filmId:'film001',fingerprint,prediction}]})).data.results[0].status,'recalculated','the reached film is recalculated');
await api('enrichment/complete','POST',{runId:started.data.runId,reason:'model_error'});
// The entry without impact features: the runner, which reads the full fingerprint, keeps it, and its repair restores the
// facet so the queue and the view agree with it on the next refresh.
started=await api('enrichment/start','POST',{scope:'watchlist_all',mode:'legacy'});
await api('enrichment/next','POST',{runId:started.data.runId});
assert.equal(read('enrichment/view-index.json').film002.impactFeatures?.fingerprintHash,read('enrichment/view-index.json').film002.fingerprintHash,'next repairs the missing impact facet');
await api('enrichment/complete','POST',{runId:started.data.runId,reason:'model_error'});
queue=await reconcile();
assert.deepEqual(pending(queue),['film003']);
const afterRepair=(await api('enrichment/view')).data.films;
for(const id of ['film000','film001','film002'])assert.equal(afterRepair[id].prediction.stale,false,id);
// The former strict rollback no longer exists: a binding strict keeps the carried prediction current everywhere.
env.PREDICTION_PROFILE_COMPATIBILITY='strict';
queue=await reconcile();
assert.deepEqual(pending(queue),['film003']);
assert.equal((await api('enrichment/view')).data.films.film000.prediction.stale,false);
assert.deepEqual([...await offered()],['tmdb_900']);
delete env.PREDICTION_PROFILE_COMPATIBILITY;
queue=await reconcile();

// An approval that no longer matches its declaration in the stored lineage is unknown, i.e. global.
const current=read('enrichment/profile/current.json'),tampered=structuredClone(current);
tampered.lineage[1].changeImpact.selectors=[{kind:'genre',values:['comedy']}];write('enrichment/profile/current.json',tampered);
queue=await reconcile();
// film001 was recalculated under v2 (exact); the two carried predictions lose their link.
assert.deepEqual(pending(queue),['film000','film002','film003']);assert.equal(queue.compatibility.reasons.profile_impact_unknown,2);assert.equal(queue.compatibility.reasons.exact,1);
write('enrichment/profile/current.json',current);

// v3: a global edit makes every prediction stale in either mode.
assert.equal((await api('enrichment/profile','PUT',{version:3,schemaVersion:1,profile:{...changed,calibration:'Recalibrated'},changeImpact:{impactSchemaVersion:1,from:{version:2,profileHash:current.profileHash},scope:'global',changedFields:['calibration'],selectors:[]}})).status,200);
queue=read('enrichment/prediction-queue.json');
// The dramas pass v2 and stop at the global v3; the horror film recalculated under v2 stops there too.
assert.deepEqual(pending(queue),['film000','film001','film002','film003']);assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility.reasons)),{profile_global_change:3});
assert.equal(queue.compatibility.selective.compatible,0);

// A binding strict after the global edit: still selective, every prediction stays pending.
env.PREDICTION_PROFILE_COMPATIBILITY='strict';
queue=await reconcile();
assert.equal(queue.compatibility.mode,'selective');assert.deepEqual(pending(queue),['film000','film001','film002','film003']);
delete env.PREDICTION_PROFILE_COMPATIBILITY;
console.log('Queue and reader compatibility: no profile-rule switch (retired binding inert), impact features from the full fingerprint, selective decides with strict shadow counters, queue/reader agreement, selective keeps the unaffected film in queue, view, coverage, diagnostics, catalog and runner, facet repair, unbound features and tampered approvals stale, global edit with a stale strict binding passed');
