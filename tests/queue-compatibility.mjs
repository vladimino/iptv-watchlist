import {installViewIndexFixture} from './view-index-fixture.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The prediction queue and the shared compatibility evaluator (ADR-0031): the selective rule always decides (ADR 0044:
// the PREDICTION_PROFILE_COMPATIBILITY switch is retired and inert), the strict outcome is counted beside it, an unknown
// or unapproved change fails closed, and impact features come from the full fingerprint, bound to its hash.
// Since ADR 0167 the only runner is batch runner v2 (D1 mode only); this R2 bucket is seeded through the shared writers a submit uses (`T.seedFilm`).
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
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
vm.runInContext(`globalThis.seedFilm=async(env,id,input,prediction)=>{
  const state=await readFilmState(env,id),profile=await loadJSON(env,profileKey);let fingerprint=state.fingerprint;
  if(input)fingerprint=await writeFingerprint(env,id,input,fingerprint,'generated',undefined,FINGERPRINT_PROMPT_VERSION,false);
  const old=state.predictions?.current||null,at=new Date().toISOString();
  const generated={...pickPrediction(prediction),filmId:id,generatedAt:at,tasteProfileVersion:profile.version,tasteProfileHash:profile.profileHash,fingerprintHash:fingerprint.fingerprintHash,fingerprintSchemaVersion:fingerprint.fingerprintSchemaVersion,fingerprintPromptVersion:fingerprint.fingerprintPromptVersion??1,predictionPromptVersion:PREDICTION_PROMPT_VERSION,runId:'seed',trigger:'manual',confidenceAssessment:assessPredictionConfidence({...fingerprint,fingerprintHash:fingerprint.fingerprintHash})};
  const stored={...generated,...(await writePredictionVersion(env,id,generated))},history=[...(state.predictions?.history||[])];if(old)history.push({...old,replacedAt:at});
  await saveJSON(env,filmKey(id)+'predictions.json',{current:stored,history});
  // AIR-558: no raw view-index writer exists; the fixture object stands in for the derived index.
  {const key='enrichment/view-index.json',got=await env.BUCKET.get(key),index=got?await got.json():{};index[id]={...(index[id]||{}),prediction:stored,fingerprintHash:fingerprint.fingerprintHash,fingerprint:fingerprintFacet(fingerprint,true),impactFeatures:fingerprintImpactFacet(fingerprint)};await env.BUCKET.put(key,JSON.stringify(index));}
  return old?'recalculated':'created';};
globalThis.restoreImpactFacet=async(env,id)=>{const state=await readFilmState(env,id);{const key='enrichment/view-index.json',got=await env.BUCKET.get(key),index=got?await got.json():{};index[id]={...(index[id]||{}),impactFeatures:fingerprintImpactFacet(state.fingerprint)};await env.BUCKET.put(key,JSON.stringify(index));}};`,ctx);
vm.runInContext('globalThis.T={seedFilm,restoreImpactFacet,fingerprintImpactFacet,EXECUTION,GENERAL_EXECUTION};',ctx);
const T=ctx.T;
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const write=(key,value)=>{records.set(key,JSON.stringify(value));etags.set(key,'etag-'+(++revision));};

// No selector: the retired switch is not read anywhere in the Worker.
for(const file of ['src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/env\??\.PREDICTION_PROFILE_COMPATIBILITY|predictionCompatibilityMode/,file+' reads no profile-rule switch');

// Impact features: a copy of the full fingerprint, bound to its hash; nothing without a hash.
const execution=Object.fromEntries(T.GENERAL_EXECUTION.map(key=>[key,T.EXECUTION[key][0]]));
const full={fingerprintSchemaVersion:1,fingerprintHash:'f-x',plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'},moodLabels:['a','b']};
assert.deepEqual(JSON.parse(JSON.stringify(T.fingerprintImpactFacet(full))),{fingerprintHash:'f-x',fingerprintSchemaVersion:1,fingerprintPromptVersion:null,invalidatedAt:null,plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'}},'unknown and genre-specific values are kept');
assert.equal(T.fingerprintImpactFacet({...full,fingerprintHash:''}),null);assert.equal(T.fingerprintImpactFacet(null),null);

// A programme of four watchlist films, all airing now.
const now=Date.now(),film=(id,genres)=>({id,tmdbId:String(100+Number(id.slice(-3))),title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres,synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
const films=[film('film000',['Драма']),film('film001',['Ужасы']),film('film002',['Драма']),film('film003',['Драма'])];
write('programme.json',{runId:'programme-1',updatedAt:new Date().toISOString(),window:{from:now-72*3600000,to:now+24*3600000},films,watchlistCount:films.length});write('sync.json',{runId:'programme-1',stage:'complete'});
write('epg/discovered-films.json',{}); // an existing, empty catalog: an absent catalog object makes the footer coverage unknown (AIR-389)
const profile={ratingScale:'Letterboxd half-star steps',positiveSignals:['Good plans'],negativeSignals:['Stupid choices'],characterLogic:'Characters reason clearly',pace:'Prefer momentum',payoffEnding:'Payoff matters',genrePreferences:'Mysteries welcome',comedyPreferences:'Smart humor',horrorPreferences:'Rules matter',scifiAdventurePreferences:'Concept driven',actionPreferences:'Readable action',anchorFilms:[],hardSkips:['Gross-out'],calibration:'Be calibrated'};
assert.equal((await api('enrichment/profile','PUT',{version:1,schemaVersion:1,profile})).status,200);
const fingerprint={fingerprintSchemaVersion:1,plotMechanics:['investigation'],execution,moodLabels:['напряжённый','расследование'],strengths:['Good mystery'],risks:[],confidence:'medium',sourceBasis:'model_knowledge',sourceRefs:['model_knowledge']};
const prediction={predictedRating:4,probability4Plus:.72,confidence:'medium',matchSignals:['Strong puzzle'],mainRisk:'Pace may lag',moodLabels:['напряжённый','расследование']};
for(const id of ['film000','film001','film002'])assert.equal(await ctx.T.seedFilm(env,id,fingerprint,prediction),'created');
const index=read('enrichment/view-index.json');
for(const id of ['film000','film001','film002']){assert.equal(index[id].impactFeatures.fingerprintHash,index[id].fingerprintHash,id+' submit stores impact features bound to the fingerprint');assert.deepEqual(index[id].impactFeatures.execution,execution);}
// film002 stands for an index entry written before impact features existed.
delete index.film002.impactFeatures;write('enrichment/view-index.json',index);

const reconcile=async()=>{const r=await api('enrichment/queue/reconcile','POST',{});assert.equal(r.status,200);return read('enrichment/prediction-queue.json');};
const pending=queue=>[...queue.pending].sort();
let queue=await reconcile();
// The fingerprint rule decides (ADR 0047): film002's entry has no impact facet, so the queue cannot judge it and fails closed;
// the runner's next repairs the facet from the stored fingerprint without a model run (below).
assert.deepEqual(pending(queue),['film002','film003']);
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

// AIR-475 (production acceptance of the permanent film page): the page reads the stored forecast through the SAME evaluator. A forecast made under profile v1 whose change does not touch the film is
// `compatible` and is shown, with v1 as its provenance; only a real `stale` verdict marks it, with the evaluator's own reason. The stored fingerprint shows whatever the forecast's freshness. The entry is
// indexed under the film's Letterboxd id and reached only through the verified alias the route passes; without the alias the TMDB entry has nothing to show.
{
 ctx.pageEnv=env;ctx.pageIndex=read('enrichment/view-index.json');ctx.pageProfile=read('enrichment/profile/current.json');
 const page=async(tmdb,genres,alias,index=ctx.pageIndex)=>{ctx.pageArgs={tmdb,genres,alias,index};return JSON.parse(JSON.stringify(await vm.runInContext("(async()=>{const a=pageArgs,freshness=await predictionFreshness(pageEnv,pageProfile);return catalogFilmPage({film:{id:'tmdb_'+a.tmdb,tmdbId:a.tmdb,title:'T',genres:a.genres,shows:[]},programmeRunId:null,index:a.index,alias:a.alias,profile:pageProfile,metadata:null,watchlist:null,programme:null,freshness,now:Date.now()});})()",ctx)));};
 const withTmdb=(tmdb,entry)=>({...ctx.pageIndex,['tmdb_'+tmdb]:entry});
 // film000: a drama predicted under v1, unaffected by the v2 horror edit.
 let f=await page('100',['Драма'],'film000',withTmdb(100,{watched:true}));
 assert.deepEqual([f.prediction.compatibility,f.prediction.tasteProfileVersion,f.prediction.stale],['compatible',1,undefined],'a v1 forecast the evaluator calls compatible is shown as usable with v1 as its provenance');
 assert.deepEqual([f.watched,f.actualRating],[true,null],'a watched film without a rating has none');assert.ok(f.fingerprint&&f.fingerprint.plotMechanics.length,'the stored fingerprint is shown');
 // film001: a horror film under the v2 horror edit: a real stale verdict, with its reason, still showing the stored facts.
 f=await page('101',['Ужасы'],'film001',withTmdb(101,{}));
 assert.deepEqual([f.prediction.stale,f.prediction.staleReason,f.prediction.compatibility],[true,'profile_impacted',undefined],'a really stale forecast says why');assert.ok(f.fingerprint,'the fingerprint is shown although the forecast is stale');
 // film002: no impact features stored: the evaluator has no fingerprint record to judge and says so with its own reason.
 f=await page('102',['Драма'],'film002',withTmdb(102,{}));assert.deepEqual([f.prediction.stale,f.prediction.staleReason],[true,'fingerprint_not_current']);
 // Without the verified alias the TMDB entry (watchlist facts only) has no forecast: the very defect of the production acceptance.
 f=await page('100',['Драма'],null,withTmdb(100,{watched:true}));assert.deepEqual([f.prediction,f.fingerprint,f.watched],[null,null,true]);
 // The merged rating: known on the alias, known on both and different is unknown, a rating is not a watched mark.
 const rated=(tmdb,own,aliased)=>({...ctx.pageIndex,['tmdb_'+tmdb]:own,film000:{...ctx.pageIndex.film000,...aliased}});
 f=await page('100',['Драма'],'film000',rated(100,{},{actualRating:4.5,watched:true}));assert.deepEqual([f.actualRating,f.watched],[4.5,true]);
 f=await page('100',['Драма'],'film000',rated(100,{actualRating:3},{actualRating:4.5}));assert.deepEqual([f.actualRating,f.watched],[null,false],'two different known ratings are unknown, never picked');
 f=await page('100',['Драма'],'film000',rated(100,{actualRating:4},{actualRating:4}));assert.deepEqual([f.actualRating,f.watched],[4,false],'a rating alone does not mark a film watched');
}
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
// The reached film is recalculated; the kept film keeps version 1 (the v5 runner's own already_current answer and index repair are retired with v5, ADR 0167).
assert.equal(read('enrichment/films/film000/predictions.json').current.tasteProfileVersion,1,'no recomputation, no version rewrite');
assert.equal(await ctx.T.seedFilm(env,'film001',fingerprint,prediction),'recalculated','the reached film is recalculated');
// The entry without impact features: its facet is restored from the full fingerprint by the shared index writer, so the queue and the view agree on the next refresh.
await ctx.T.restoreImpactFacet(env,'film002');
assert.equal(read('enrichment/view-index.json').film002.impactFeatures?.fingerprintHash,read('enrichment/view-index.json').film002.fingerprintHash,'the facet is bound to the fingerprint again');
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
