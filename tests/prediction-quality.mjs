import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto,createHash} from 'node:crypto';

// Prediction quality: blind pairs only where absence of the rating is observed after the prediction; everything else is
// classified with a reason, never counted as blind. Additive stats, honest N=0, and a read-only paged route.
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,
 ASSETS:{'/':{body:'<!doctype html>',type:'text/html'}},INITIAL_PERSONAL_RATINGS:{},fetch:async input=>{throw new Error('unexpected fetch '+input);}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/migration-export.js','src/prediction-diagnostics.js','src/mcp.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const plain=value=>JSON.parse(JSON.stringify(value));
const T=day=>new Date(Date.UTC(2026,9,day,12)).toISOString();
const pred=(day,rating,prob,extra={})=>({filmId:'f',predictedRating:rating,probability4Plus:prob,confidence:'medium',matchSignals:[],mainRisk:'r',moodLabels:['a','b'],generatedAt:T(day),tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'h',fingerprintSchemaVersion:1,fingerprintPromptVersion:1,predictionPromptVersion:1,runId:'run',trigger:'scheduled',...extra});
const change=(day,value,previous,id='o'+day,extra={})=>({kind:previous===undefined?'first_observed':'changed',recordedAt:T(day),value,observedAt:T(day),source:'letterboxd_films_list',sourceRef:'s',observationId:id,previous:previous===undefined?null:previous,...extra});
const absent=day=>({value:null,observedAt:T(day),source:'letterboxd_films_list',observationId:'n'+day});
function evaluate({current,history=[],ratingHistory=[],legacy=null}){
 const events=ctx.buildFilmHistory({filmId:'f',bundle:current?{current,history}:null,factRecord:{rating:null,ratingHistory},legacyLog:legacy}).events;
 return plain(ctx.classifyFilmQuality(events));
}
const only=result=>result.ratings.map(r=>r.class+':'+r.reason);

// True blind: the rating was observed absent (seen, not rated) after the prediction, then a value was observed.
{
 const r=evaluate({current:pred(2,3.5,.4),ratingHistory:[change(1,null),change(5,4,absent(3))]});
 assert.deepEqual(only(r),['excluded:rating_not_a_value','prospective:absent_after_prediction']);
 assert.equal(r.ratings[1].prediction.predictedRating,3.5);assert.equal(r.ratings[1].absenceObservedAt,T(3));
}
// Pre-existing: a first observation of a value says nothing about when it was given.
assert.deepEqual(only(evaluate({current:pred(2,4,.6),ratingHistory:[change(5,4)]})),['pre_existing_or_unknown:first_observed']);
// Unknown order: the only prediction falls between the absence and the value.
assert.deepEqual(only(evaluate({current:pred(4,4,.6),ratingHistory:[change(5,4,absent(3))]})),['unknown_order:prediction_inside_rating_window']);
// No absence time, rerating, no prediction at all, prediction only after the rating.
assert.deepEqual(only(evaluate({current:pred(1,4,.6),ratingHistory:[change(5,4,{value:null,source:'owner',observationId:'x'})]})),['unknown_order:no_absence_observation']);
assert.deepEqual(only(evaluate({current:pred(1,4,.6),ratingHistory:[change(5,4,{value:3,observedAt:T(3),source:'owner',observationId:'x'})]})),['rerating:previous_rating']);
assert.deepEqual(only(evaluate({ratingHistory:[change(5,4,absent(3))]})),['excluded:no_prediction']);
assert.deepEqual(only(evaluate({current:pred(9,4,.6),ratingHistory:[change(5,4,absent(3))]})),['excluded:no_prediction_before_rating']);
// Multiple predictions: the one current at the absence observation is used, its own values; a tie at the cutoff counts.
{
 const r=evaluate({current:pred(4,2,.1),history:[pred(1,3,.3,{replacedAt:T(2),tasteProfileVersion:1}),pred(2,4.5,.8,{replacedAt:T(4),tasteProfileVersion:2})],ratingHistory:[change(5,4,absent(3))]});
 assert.equal(r.ratings[0].class,'prospective');assert.equal(r.ratings[0].prediction.predictedRating,4.5);assert.equal(r.ratings[0].prediction.tasteProfileVersion,2);
 const tie=evaluate({current:pred(3,3,.5),ratingHistory:[change(5,4,absent(3))]});
 assert.equal(tie.ratings[0].class,'prospective','a prediction at the absence instant is before the rating');
 const two=evaluate({current:pred(3,3,.5,{runId:'b'}),history:[pred(3,2,.5,{runId:'a'})],ratingHistory:[change(5,4,absent(3))]});
 assert.equal(two.ratings[0].predictionTie,true);assert.equal(two.ratings[0].prediction.runId,'b','ties resolve by identity: current after history');
}
// Rollback and re-application: a standing rollback removes the pair; a re-application counts once.
{
 const applied=change(5,4,absent(3),'o5'),rolled={kind:'rolled_back',recordedAt:T(6),at:T(6),observationId:'o5',restored:null};
 assert.deepEqual(only(evaluate({current:pred(2,4,.6),ratingHistory:[applied,rolled]})),[]);
 const again={...applied,recordedAt:T(7)};
 assert.deepEqual(only(evaluate({current:pred(2,4,.6),ratingHistory:[applied,rolled,again]})),['prospective:absent_after_prediction']);
}
// A later value after the rating was cleared again is not a second blind pair; unchanged ratings write no events.
assert.deepEqual(only(evaluate({current:pred(2,4,.6),ratingHistory:[change(5,4,absent(3)),change(6,null,{value:4,observedAt:T(5),source:'owner',observationId:'o5'}),change(8,3,absent(7))]})),['prospective:absent_after_prediction','excluded:rating_not_a_value','excluded:later_rating_after_clear']);
// Legacy log entries are reported, never paired (no double count with the facts history).
{
 const r=evaluate({current:pred(2,4,.6),ratingHistory:[change(5,4,absent(3))],legacy:[{filmId:'f',before:null,after:4,observedAt:T(5),source:'letterboxd_public_films'}]});
 assert.equal(r.legacyUnverified,1);assert.deepEqual(only(r),['prospective:absent_after_prediction']);
}
// The value must be observed strictly after the absence: missing, equal or reversed times are unknown order, never blind.
{
 const missing=evaluate({current:pred(2,4,.6),ratingHistory:[change(5,4,absent(3),'m',{observedAt:null})]});
 assert.deepEqual(only(missing),['unknown_order:rating_time_missing']);
 const equal=evaluate({current:pred(2,4,.6),ratingHistory:[change(3,4,absent(3),'q')]});
 assert.deepEqual(only(equal),['unknown_order:rating_time_equals_absence']);
 const reversed=evaluate({current:pred(1,4,.6),ratingHistory:[change(5,4,absent(6),'v')]});
 assert.deepEqual(only(reversed),['unknown_order:rating_time_before_absence']);
 const stats=[missing,equal,reversed].reduce((s,f)=>ctx.addFilmQuality(s,f),ctx.emptyQualityStats());
 assert.equal(plain(ctx.finalizeQuality(stats)).denominator.n,0,'none of them enters the prospective denominator');
}
// Incomplete prediction and broken immutable object.
assert.deepEqual(only(evaluate({current:pred(2,4,null),ratingHistory:[change(5,4,absent(3))]})),['excluded:prediction_incomplete']);

// Metrics: zero N, bias sign, exact hits, Brier, calibration edges and sufficiency, segments, additivity and determinism.
{
 const zero=plain(ctx.finalizeQuality(ctx.emptyQualityStats()));
 assert.equal(zero.denominator.n,0);assert.equal(zero.mae,null);assert.equal(zero.bias,null);assert.equal(zero.exactHitRate,null);assert.equal(zero.probability4Plus.brier,null);
 assert.equal(zero.probability4Plus.calibration,null);assert.equal(zero.probability4Plus.calibrationStatus,'insufficient_n');
 const pairs=[];
 for(let i=0;i<30;i++)pairs.push({ratings:[{class:'prospective',reason:'absent_after_prediction',actual:i%2?4:3,prediction:{predictedRating:4,probability4Plus:i%2?1:0,tasteProfileVersion:i<10?1:2,predictionPromptVersion:1,fingerprintPromptVersion:i<5?null:1,runId:'r',version:{status:'linked'}},predictionTie:false}],legacyUnverified:0});
 const stats=pairs.reduce((s,f)=>ctx.addFilmQuality(s,f),ctx.emptyQualityStats());
 const m=plain(ctx.finalizeQuality(stats));
 assert.equal(m.denominator.n,30);assert.equal(m.bias,.5,'predicted minus actual: overprediction is positive');assert.equal(m.mae,.5);assert.equal(m.exactHits,15);
 assert.equal(m.probability4Plus.brier,0,'a probability of 1 for every 4.0+ and 0 for every 3.0');
 assert.equal(m.probability4Plus.calibrationStatus,'reported');assert.equal(m.probability4Plus.calibration[0].n,15);assert.equal(m.probability4Plus.calibration[4].n,15,'p = 1 falls in the last bin');
 assert.equal(m.probability4Plus.calibration[4].observedRate,1);assert.equal(m.probability4Plus.calibration[2].meanPredicted,null);
 assert.equal(m.caveats.lineageUnknown,5);
 assert.deepEqual(Object.keys(m.segments),['profile:1|prompt:1','profile:2|prompt:1']);assert.equal(m.segments['profile:1|prompt:1'].n,10);
 const halves=ctx.mergeQualityStats(pairs.slice(0,13).reduce((s,f)=>ctx.addFilmQuality(s,f),ctx.emptyQualityStats()),pairs.slice(13).reduce((s,f)=>ctx.addFilmQuality(s,f),ctx.emptyQualityStats()));
 assert.deepEqual(plain(ctx.finalizeQuality(halves)),m,'pages sum to the same metrics');
 assert.deepEqual(plain(ctx.finalizeQuality(pairs.reduce((s,f)=>ctx.addFilmQuality(s,f),ctx.emptyQualityStats()))),m,'deterministic');
}

// The route: one bounded page of fact records, read-only, additive stats, version check, cursor paging.
const records=new Map(),etags=new Map();let puts=[],lists=[];
const bucket={
 async get(key){if(!records.has(key))return null;const text=records.get(key);return {etag:etags.get(key),text:async()=>text,json:async()=>JSON.parse(text)};},
 async put(key){puts.push(key);return null;},async delete(key){puts.push('delete:'+key);},
 async list({prefix='',limit=1000,cursor}={}){lists.push({prefix,limit});const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort(),start=cursor?Number(cursor):0;return {objects:keys.slice(start,start+limit).map(key=>({key})),truncated:start+limit<keys.length,cursor:start+limit<keys.length?String(start+limit):undefined};}
};
const set=(key,value)=>{records.set(key,typeof value==='string'?value:JSON.stringify(value));etags.set(key,'e'+records.size);};
const sha=text=>createHash('sha256').update(text).digest('hex');
set('enrichment/profile/current.json',{version:2,profileHash:'p2'});
// A: blind, linked version, prediction under the Letterboxd id. B: pre-existing, prediction under the TMDB id.
// C: blind but its version object is tampered. D: redirected. E: no prediction.
const pa=pred(2,3.5,.3,{filmId:'la'}),body=JSON.stringify(ctx.predictionVersionBody(pa)),s=sha(body);Object.assign(pa,{r2Key:'enrichment/films/la/predictions/versions/'+s+'.json',contentSha256:s});set(pa.r2Key,body);
set('enrichment/films/la/predictions.json',{current:pa,history:[]});
set('letterboxd/facts/films/tmdb-1.json',{schemaVersion:1,factKey:'tmdb-1',links:{letterboxd:'la',tmdb:'1'},rating:{value:3,observedAt:T(5)},ratingHistory:[change(5,3,absent(3))]});
set('enrichment/films/tmdb_2/predictions.json',{current:pred(2,4,.7,{filmId:'tmdb_2'}),history:[]});
set('letterboxd/facts/films/tmdb-2.json',{schemaVersion:1,factKey:'tmdb-2',links:{letterboxd:null,tmdb:'2'},rating:{value:4},ratingHistory:[change(5,4)]});
const pc=pred(2,4,.6,{filmId:'lc'}),sc=sha(JSON.stringify(ctx.predictionVersionBody(pc)));Object.assign(pc,{r2Key:'enrichment/films/lc/predictions/versions/'+sc+'.json',contentSha256:sc});set(pc.r2Key,'{"tampered":1}');
set('enrichment/films/lc/predictions.json',{current:pc,history:[]});
set('letterboxd/facts/films/lb-lc.json',{schemaVersion:1,factKey:'lb-lc',links:{letterboxd:'lc',tmdb:null},ratingHistory:[change(5,4,absent(3))]});
set('letterboxd/facts/films/lb-old.json',{schemaVersion:1,factKey:'lb-old',links:{letterboxd:'old',tmdb:null},redirectTo:'tmdb-1'});
set('enrichment/films/lt/predictions.json',{current:pred(1,4,.6,{filmId:'lt'}),history:[]});
set('letterboxd/facts/films/lb-times.json',{schemaVersion:1,factKey:'lb-times',links:{letterboxd:'lt',tmdb:null},ratingHistory:[change(5,4,absent(3),'tm',{observedAt:null}),change(3,4,absent(3),'te'),change(5,4,absent(6),'tr')]});
set('letterboxd/facts/films/lb-none.json',{schemaVersion:1,factKey:'lb-none',links:{letterboxd:'none',tmdb:null},ratingHistory:[change(5,4,absent(3))]});
const env={BUCKET:bucket,EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};
async function quality(query=''){puts=[];lists=[];const response=await ctx.worker.fetch(new Request('https://iptv.vladimino.workers.dev/api/enrichment/quality'+query),env,{waitUntil(){throw new Error('no background work');}});const data=plain(await response.json());assert.deepEqual(puts,[],'no write');return {status:response.status,data};}
assert.equal((await quality('?limit=0')).status,400);assert.equal((await quality('?limit=51')).status,400);assert.equal((await quality('?cursor=%00')).status,400);
const all=await quality('?limit=50');
{
 const {status,data}=all;assert.equal(status,200);assert.equal(lists.length,1,'one bounded LIST per request');assert.equal(lists[0].limit,50);
 assert.equal(data.page.records,6);assert.equal(data.page.nextCursor,null);
 const byKey=Object.fromEntries(data.films.map(f=>[f.factKey,f]));
 assert.equal(byKey['tmdb-1'].ratings[0].class,'prospective');assert.equal(byKey['tmdb-1'].ratings[0].prediction.versionStatus,'linked');
 assert.equal(byKey['tmdb-2'].ratings[0].class,'pre_existing_or_unknown');
 assert.equal(byKey['lb-lc'].ratings[0].class,'excluded');assert.equal(byKey['lb-lc'].ratings[0].reason,'version_unverified');
 assert.equal(byKey['lb-old'].skipped,'redirected');
 assert.deepEqual(byKey['lb-times'].ratings.map(r=>r.class+':'+r.reason).sort(),['unknown_order:rating_time_before_absence','unknown_order:rating_time_equals_absence','unknown_order:rating_time_missing']);assert.equal(byKey['lb-none'].ratings[0].reason,'no_prediction');
 assert.equal(data.metrics.denominator.n,1);assert.equal(data.metrics.bias,.5);assert.equal(data.metrics.mae,.5);assert.equal(data.metrics.probability4Plus.calibrationStatus,'insufficient_n');
 assert.equal(data.metrics.excluded.excluded,2);assert.equal(data.metrics.excluded.pre_existing_or_unknown,1);assert.equal(data.metrics.excluded.unknown_order,3,'bad times do not enter the denominator');
 assert.equal(JSON.stringify(data).includes('tester'),false);
}
// Paging: two pages of three and two records sum to the single-page stats.
{
 const one=await quality('?limit=3');assert.equal(one.data.page.records,3);assert.ok(one.data.page.nextCursor);
 const two=await quality('?limit=3&cursor='+one.data.page.nextCursor);assert.equal(two.data.page.records,3);assert.equal(two.data.page.nextCursor,null);
 assert.deepEqual(plain(ctx.finalizeQuality(ctx.mergeQualityStats(one.data.stats,two.data.stats))),all.data.metrics);
 const again=await quality('?limit=50');assert.deepEqual({...again.data,readAt:null},{...all.data,readAt:null},'idempotent');
}
console.log('Prediction quality: blind vs pre-existing vs unknown order, missing, equal and reversed rating times, rerating, cutoff ties, multiple predictions, rollback and re-apply, cleared and re-rated, legacy overlap, incomplete and unverified predictions, zero N, bias sign, Brier and calibration edges, segments, additive pages and the read-only route passed');
