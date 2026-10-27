import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// The prediction queue and the shared compatibility evaluator (ADR-0031): strict equality decides by default, the
// selective outcome is always counted, PREDICTION_PROFILE_COMPATIBILITY=selective lets it decide, and impact features
// come from the full fingerprint, bound to its hash. Readers stay strict here.
const records=new Map(),etags=new Map();let revision=0;
const store={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key,value,options={}){const text=String(value),condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key))return null;if(condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;records.set(key,text);etags.set(key,'etag-'+(++revision));return {key,etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 list:async()=>({objects:[],truncated:false})
};
const env={TMDB_REQUEST_INTERVAL_MS:0,BUCKET:store};
const ctx=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console});
vm.runInContext(['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
vm.runInContext('globalThis.T={fingerprintImpactFacet,predictionCompatibilityMode,EXECUTION,GENERAL_EXECUTION};',ctx);
const T=ctx.T;
const api=async(path,method='GET',body)=>{const response=await ctx.worker.fetch(new Request('https://site.example/api/'+path,{method,headers:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})}),env);return {status:response.status,data:await response.json()};};
const read=key=>records.has(key)?JSON.parse(records.get(key)):null;
const write=(key,value)=>{records.set(key,JSON.stringify(value));etags.set(key,'etag-'+(++revision));};

// Mode: only the exact string 'selective'.
for(const [value,mode] of [[undefined,'strict'],['strict','strict'],['selective','selective'],['Selective','strict'],[' selective','strict'],['on','strict'],[true,'strict']])assert.equal(T.predictionCompatibilityMode({PREDICTION_PROFILE_COMPATIBILITY:value}),mode,String(value));

// Impact features: a copy of the full fingerprint, bound to its hash; nothing without a hash.
const execution=Object.fromEntries(T.GENERAL_EXECUTION.map(key=>[key,T.EXECUTION[key][0]]));
const full={fingerprintSchemaVersion:1,fingerprintHash:'f-x',plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'},moodLabels:['a','b']};
assert.deepEqual(JSON.parse(JSON.stringify(T.fingerprintImpactFacet(full))),{fingerprintHash:'f-x',fingerprintSchemaVersion:1,invalidatedAt:null,plotMechanics:['heist'],execution:{...execution,pace:'unknown',horror_rule_consistency:'weak'}},'unknown and genre-specific values are kept');
assert.equal(T.fingerprintImpactFacet({...full,fingerprintHash:''}),null);assert.equal(T.fingerprintImpactFacet(null),null);

// A programme of four watchlist films, all airing now.
const now=Date.now(),film=(id,genres)=>({id,title:id,original:id,url:'https://letterboxd.com/film/'+id+'/',year:2020,genres,synopsis:'A plot',directors:[],actors:[],shows:[{start:now}]});
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
assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility)),{mode:'strict',evaluatorVersion:1,profileVersion:1,films:4,missing:1,strict:{current:3,stale:0},selective:{current:3,compatible:0,stale:0},reasons:{exact:3},wouldKeep:0,wouldRequeue:0,strictDisagreements:0});
assert.deepEqual((await api('enrichment/queue/status')).data.compatibility,queue.compatibility,'queue status exposes the counters');

// v2: an approved selective edit of horror preferences.
const h1=read('enrichment/profile/current.json').profileHash,changed={...profile,horrorPreferences:'Rules and causality matter'};
const horror={impactSchemaVersion:1,from:{version:1,profileHash:h1},scope:'selective',changedFields:['horrorPreferences'],selectors:[{kind:'genre',values:['horror']}]};
const dry=await api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:changed,changeImpact:horror,dryRun:true});
assert.equal(dry.data.code,'selective_requires_owner_approval');
const approved={...horror,approval:{approvedBy:'owner',approvedAt:'2026-10-27T22:00:00.000Z',reviewRef:'trello-comment:test',declarationSha256:dry.data.declarationSha256}};
assert.equal((await api('enrichment/profile','PUT',{version:2,schemaVersion:1,profile:changed,changeImpact:approved})).status,200);
// Strict (default): every predicted film is pending again; the shadow shows which ones selective would keep.
queue=read('enrichment/prediction-queue.json');
assert.equal(queue.trigger,'profile_updated');
assert.deepEqual(pending(queue),['film000','film001','film002','film003']);
assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility)),{mode:'strict',evaluatorVersion:1,profileVersion:2,films:4,missing:1,strict:{current:0,stale:3},selective:{current:0,compatible:1,stale:2},reasons:{profile_unaffected:1,profile_impacted:1,film_features_unknown:1},wouldKeep:1,wouldRequeue:0,strictDisagreements:0});
// Queue/reader agreement under strict: a predicted film is pending exactly when the view calls its prediction stale.
const view=(await api('enrichment/view')).data.films;
for(const id of ['film000','film001','film002'])assert.equal(queue.pending.includes(id),view[id].prediction.stale===true,id);

// Selective: the unaffected drama keeps its prediction (no recomputation), the horror film and the film without
// impact features are pending, the film without a prediction stays pending.
env.PREDICTION_PROFILE_COMPATIBILITY='selective';
queue=await reconcile();
assert.equal(queue.compatibility.mode,'selective');
assert.deepEqual(pending(queue),['film001','film002','film003']);
assert.equal(read('enrichment/films/film000/predictions.json').current.tasteProfileVersion,1,'the carried prediction keeps its original version');
// Readers are not switched by this mode: they still call the carried prediction stale (until the readers adopt the evaluator).
assert.equal((await api('enrichment/view')).data.films.film000.prediction.stale,true);

// An approval that no longer matches its declaration in the stored lineage is unknown, i.e. global.
const current=read('enrichment/profile/current.json'),tampered=structuredClone(current);
tampered.lineage[1].changeImpact.selectors=[{kind:'genre',values:['comedy']}];write('enrichment/profile/current.json',tampered);
queue=await reconcile();
assert.deepEqual(pending(queue),['film000','film001','film002','film003']);assert.equal(queue.compatibility.reasons.profile_impact_unknown,3);
write('enrichment/profile/current.json',current);

// v3: a global edit makes every prediction stale in either mode.
assert.equal((await api('enrichment/profile','PUT',{version:3,schemaVersion:1,profile:{...changed,calibration:'Recalibrated'},changeImpact:{impactSchemaVersion:1,from:{version:2,profileHash:current.profileHash},scope:'global',changedFields:['calibration'],selectors:[]}})).status,200);
queue=read('enrichment/prediction-queue.json');
// The first failing link decides: the drama passes v2 and stops at the global v3, the horror film already at v2.
assert.deepEqual(pending(queue),['film000','film001','film002','film003']);assert.deepEqual(JSON.parse(JSON.stringify(queue.compatibility.reasons)),{profile_global_change:1,profile_impacted:1,film_features_unknown:1});
assert.equal(queue.compatibility.selective.compatible,0);

// Back to strict (the rollback): decisions return to plain equality, no record changed.
delete env.PREDICTION_PROFILE_COMPATIBILITY;
queue=await reconcile();
assert.equal(queue.compatibility.mode,'strict');assert.deepEqual(pending(queue),['film000','film001','film002','film003']);
console.log('Queue compatibility: exact mode switch, impact features from the full fingerprint, strict default with shadow counters, queue/reader agreement, selective keeps the unaffected film, unbound features and tampered approvals stale, global edit and strict rollback passed');
