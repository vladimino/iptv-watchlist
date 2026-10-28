// Prediction quality over stored history (contract: docs/reference/api/prediction-quality.md). Pure functions over the
// events of src/domain/film-history.js: which (prediction, rating) pairs are blind, which are not and why, and additive
// sufficient statistics that pages of films can be summed into. Nothing here reads storage or infers a missing time.
const PREDICTION_QUALITY_SCHEMA_VERSION=1;
const QUALITY_MIN_CALIBRATION_N=30;
const QUALITY_BINS=[0,.2,.4,.6,.8];
const QUALITY_CLASSES=['prospective','pre_existing_or_unknown','unknown_order','rerating','excluded'];
// Rating applications that stand: each observation once (a re-application after a rollback is the same observation), and
// only when its last event applies it. Ordered by the history's own order.
function standingRatingEvents(events){
 const last=new Map();
 for(const event of events)if(event.type==='rating'&&event.observationId)last.set(event.observationId,event);
 return [...last.values()].filter(event=>event.kind==='first_observed'||event.kind==='changed');
}
function isHalfStar(value){return typeof value==='number'&&Number.isFinite(value)&&value>=.5&&value<=5&&value*2%1===0;}
function predictionUsable(event){return typeof event.predictedRating==='number'&&Number.isFinite(event.predictedRating)&&typeof event.probability4Plus==='number'&&event.probability4Plus>=0&&event.probability4Plus<=1;}
// The prediction that was current at `cutoff`: the latest one generated at or before it; ties by identity, reported.
function predictionAtOrBefore(predictions,cutoff){
 const before=predictions.filter(p=>p.at!==null&&p.at<=cutoff);
 if(!before.length)return {prediction:null,tie:false};
 const latest=before[before.length-1];
 return {prediction:latest,tie:before.filter(p=>p.at===latest.at).length>1};
}
// One film: every standing rating event classified, at most one prospective pair.
// A pair is prospective (blind) only when the rating was observed as explicitly absent (previous value null) at or after
// the prediction was made, and the change to a number was observed later: the rating did not exist when it was predicted.
function classifyFilmQuality(events){
 // Same instant: a replaced record is older than the record that replaced it (history before current, history by index).
 const order=e=>[e.position==='current'?1:0,Number(String(e.identity).split('|').pop())||0];
 const predictions=events.filter(e=>e.type==='prediction').sort((a,b)=>{
  if(a.at!==b.at)return a.at===null?1:b.at===null?-1:a.at<b.at?-1:1;
  const [pa,ia]=order(a),[pb,ib]=order(b);if(pa!==pb)return pa-pb;if(ia!==ib)return ia-ib;
  return a.identity<b.identity?-1:a.identity>b.identity?1:0;
 });
 const results=[];let prospective=false;
 for(const rating of standingRatingEvents(events)){
  const base={observationId:rating.observationId,actual:rating.value,ratingObservedAt:rating.observedAt,source:rating.source};
  if(!isHalfStar(rating.value)){results.push({...base,class:'excluded',reason:'rating_not_a_value'});continue;}
  if(rating.kind==='first_observed'){results.push({...base,class:'pre_existing_or_unknown',reason:'first_observed'});continue;}
  const previous=rating.previous;
  if(previous&&isHalfStar(previous.value)){results.push({...base,class:'rerating',reason:'previous_rating'});continue;}
  if(!previous||previous.value!==null||!previous.observedAt){results.push({...base,class:'unknown_order',reason:'no_absence_observation'});continue;}
  // The value must be observed strictly after the absence; a missing, equal or earlier time proves no order.
  if(!rating.observedAt){results.push({...base,class:'unknown_order',reason:'rating_time_missing'});continue;}
  if(rating.observedAt===previous.observedAt){results.push({...base,class:'unknown_order',reason:'rating_time_equals_absence'});continue;}
  if(rating.observedAt<previous.observedAt){results.push({...base,class:'unknown_order',reason:'rating_time_before_absence'});continue;}
  if(prospective){results.push({...base,class:'excluded',reason:'later_rating_after_clear'});continue;}
  const cutoff=previous.observedAt,{prediction,tie}=predictionAtOrBefore(predictions,cutoff);
  if(!prediction){
   const inside=predictions.some(p=>p.at!==null&&p.at>cutoff&&p.at<=rating.observedAt);
   results.push({...base,class:inside?'unknown_order':'excluded',reason:inside?'prediction_inside_rating_window':predictions.length?'no_prediction_before_rating':'no_prediction'});continue;
  }
  const pair={...base,absenceObservedAt:cutoff,prediction:{identity:prediction.identity,at:prediction.at,predictedRating:prediction.predictedRating,probability4Plus:prediction.probability4Plus,tasteProfileVersion:prediction.tasteProfileVersion,predictionPromptVersion:prediction.predictionPromptVersion,fingerprintPromptVersion:prediction.fingerprintPromptVersion,runId:prediction.runId,version:prediction.version},predictionTie:tie};
  if(!predictionUsable(prediction)){results.push({...pair,class:'excluded',reason:'prediction_incomplete'});continue;}
  if(['missing','mismatch','invalid'].includes(prediction.version?.status)){results.push({...pair,class:'excluded',reason:'version_unverified'});continue;}
  prospective=true;results.push({...pair,class:'prospective',reason:'absent_after_prediction'});
 }
 const legacy=events.filter(e=>e.type==='legacy_rating').length;
 return {ratings:results,legacyUnverified:legacy};
}
// Additive statistics: two pages' stats are combined by mergeQualityStats, and finalizeQuality turns them into metrics.
function emptyQualityStats(){return {films:0,classes:Object.fromEntries(QUALITY_CLASSES.map(c=>[c,0])),reasons:{},legacyUnverified:0,prospective:{n:0,exactHits:0,absoluteErrorSum:0,signedErrorSum:0,brierSum:0,positives:0,lineageUnknown:0,versionNone:0,predictionTies:0,bins:QUALITY_BINS.map(()=>({n:0,probabilitySum:0,positives:0}))},segments:{}};}
function addFilmQuality(stats,film){
 stats.films++;stats.legacyUnverified+=film.legacyUnverified;
 for(const item of film.ratings){
  stats.classes[item.class]=(stats.classes[item.class]||0)+1;stats.reasons[item.reason]=(stats.reasons[item.reason]||0)+1;
  if(item.class!=='prospective')continue;
  const p=stats.prospective,pred=item.prediction.predictedRating,error=pred-item.actual,prob=item.prediction.probability4Plus,positive=item.actual>=4?1:0;
  p.n++;p.absoluteErrorSum+=Math.abs(error);p.signedErrorSum+=error;if(Math.round(pred*2)/2===item.actual)p.exactHits++;
  p.brierSum+=(prob-positive)**2;p.positives+=positive;
  if(item.prediction.runId===null||item.prediction.fingerprintPromptVersion===null)p.lineageUnknown++;
  if(!item.prediction.version||item.prediction.version.status==='none')p.versionNone++;
  if(item.predictionTie)p.predictionTies++;
  const bin=p.bins[Math.min(QUALITY_BINS.length-1,Math.floor(prob*5))];bin.n++;bin.probabilitySum+=prob;bin.positives+=positive;
  const key='profile:'+(item.prediction.tasteProfileVersion??'unknown')+'|prompt:'+(item.prediction.predictionPromptVersion??'unknown');
  const s=stats.segments[key]||(stats.segments[key]={n:0,absoluteErrorSum:0,signedErrorSum:0,exactHits:0});
  s.n++;s.absoluteErrorSum+=Math.abs(error);s.signedErrorSum+=error;if(Math.round(pred*2)/2===item.actual)s.exactHits++;
 }
 return stats;
}
function mergeQualityStats(a,b){
 const out=emptyQualityStats();
 for(const s of [a,b]){
  if(!s)continue;
  out.films+=s.films||0;out.legacyUnverified+=s.legacyUnverified||0;
  for(const [k,v] of Object.entries(s.classes||{}))out.classes[k]=(out.classes[k]||0)+v;
  for(const [k,v] of Object.entries(s.reasons||{}))out.reasons[k]=(out.reasons[k]||0)+v;
  const p=s.prospective||{};for(const k of ['n','exactHits','absoluteErrorSum','signedErrorSum','brierSum','positives','lineageUnknown','versionNone','predictionTies'])out.prospective[k]+=p[k]||0;
  (p.bins||[]).forEach((bin,i)=>{out.prospective.bins[i].n+=bin.n;out.prospective.bins[i].probabilitySum+=bin.probabilitySum;out.prospective.bins[i].positives+=bin.positives;});
  for(const [k,v] of Object.entries(s.segments||{})){const t=out.segments[k]||(out.segments[k]={n:0,absoluteErrorSum:0,signedErrorSum:0,exactHits:0});for(const f of ['n','absoluteErrorSum','signedErrorSum','exactHits'])t[f]+=v[f];}
 }
 return out;
}
const qualityRatio=(num,den)=>den?num/den:null;
function finalizeQuality(stats){
 const p=stats.prospective,n=p.n,sufficient=n>=QUALITY_MIN_CALIBRATION_N;
 return {
  denominator:{name:'prospective',n,description:'blind pairs: rating observed absent at or after the prediction, then a half-star value'},
  excluded:Object.fromEntries(Object.entries(stats.classes).filter(([k])=>k!=='prospective')),reasons:stats.reasons,legacyUnverified:stats.legacyUnverified,
  exactHits:p.exactHits,exactHitRate:qualityRatio(p.exactHits,n),mae:qualityRatio(p.absoluteErrorSum,n),bias:qualityRatio(p.signedErrorSum,n),biasDirection:'predicted_minus_actual',
  probability4Plus:{target:'actual >= 4.0',n,positives:p.positives,brier:qualityRatio(p.brierSum,n),calibration:sufficient?QUALITY_BINS.map((from,i)=>({from,to:i===QUALITY_BINS.length-1?1:QUALITY_BINS[i+1],n:p.bins[i].n,meanPredicted:qualityRatio(p.bins[i].probabilitySum,p.bins[i].n),observedRate:qualityRatio(p.bins[i].positives,p.bins[i].n)})):null,calibrationStatus:sufficient?'reported':'insufficient_n',minimumN:QUALITY_MIN_CALIBRATION_N},
  caveats:{lineageUnknown:p.lineageUnknown,versionNone:p.versionNone,predictionTies:p.predictionTies},
  segments:Object.fromEntries(Object.entries(stats.segments).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,s])=>[k,{n:s.n,mae:qualityRatio(s.absoluteErrorSum,s.n),bias:qualityRatio(s.signedErrorSum,s.n),exactHitRate:qualityRatio(s.exactHits,s.n)}]))
 };
}
