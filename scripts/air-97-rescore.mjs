import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {loadProduction} from './air-86-replay.mjs';

const RUN_ID = 'cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb';
// Catalog films named by the AIR-86 report and the earlier parity record.
// Runtimes were not stored on the replay rows, so they stay null.
const DOCUMENTED_PRIORS = {
 'убежище':[{tmdbId:'1290821',title:'Убежище',original:'Shelter',year:2026,runtime:null}],
 'чудо женщина':[{tmdbId:'297762',title:'Чудо-женщина',original:'Wonder Woman',year:2017,runtime:null}]
};

function invoke(live,name,args){
 live.__args = args;
 return vm.runInContext(`${name}(...__args)`,live);
}
function read(path){return JSON.parse(fs.readFileSync(path,'utf8'));}

export function rescoreFrozen(){
 const live = loadProduction();
 const results = read('docs/air-86-replay-results.json');
 const manifest = read('docs/air-86-replay-manifest.json');
 if(results.rows.length!==38||manifest.items.length!==38||results.programmeRunId!==RUN_ID)throw new Error('frozen cohort changed');
 const items = new Map(manifest.items.map(item=>[item.key,item]));
 const now = Date.parse(results.now);
 const norm = value=>invoke(live,'scoreNorm',[value]);
 const rows = results.rows.map(row=>{
  const item = items.get(row.key);
  if(!item)throw new Error('missing manifest '+row.key);
  const normalizedTitle = row.key.slice(0,row.key.lastIndexOf('|'));
  const priors = DOCUMENTED_PRIORS[normalizedTitle]||[];
  if(priors.length!==row.priorCount)throw new Error('prior count '+row.key);
  const claimFor = hit=>{
   if(!['part_suffix','spelling_e','numeral'].includes(hit.variantReason))return null;
   const matched = [hit.title,hit.original].find(title=>title&&norm(title)===norm(hit.query));
   return matched?{reason:hit.variantReason,query:hit.query,matched}:null;
  };
  const scoredHits = claims=>row.hits.map(hit=>{
   const claim = claims?claimFor(hit):null;
   return {tmdbId:hit.tmdbId,title:hit.title,original:hit.original,year:hit.year,runtime:hit.runtime??null,trusted:false,...(claim?{structuralClaims:[claim]}:{})};
  });
  const priorCandidates = priors.map(film=>({tmdbId:film.tmdbId,title:film.title,original:film.original,year:film.year,runtime:film.runtime,trusted:false,aliases:[]}));
  const observation = {key:row.key,title:row.title,normalizedTitle,year:row.year,durations:item.durations};
  const scoreOf = claims=>invoke(live,'scoreFilmResolution',[{observation,candidates:[...priorCandidates,...scoredHits(claims)]}]);
  const baseline = scoreOf(false);
  const current = scoreOf(true);
  if(baseline.status!==row.score.status||baseline.reason!==row.score.reason||(baseline.acceptedTmdbId??null)!==(row.score.acceptedTmdbId??null))throw new Error('baseline drift '+row.key+' '+baseline.status+'/'+baseline.reason+'/'+baseline.acceptedTmdbId);
  const detail = row.detail?.checked?invoke(live,'tmdbDetailFromMovie',[{id:row.detail.tmdbId,title:row.detail.title,original_title:row.detail.original,release_date:row.detail.year?String(row.detail.year)+'-01-01':'',runtime:row.detail.runtime,alternative_titles:{titles:[]},translations:{translations:[]}}]):null;
  const sameEvidence = item.evidenceState==='same'||item.evidenceState==='missing';
  const liveAuthorizes = !(item.terminalReason&&sameEvidence)&&!(item.retryAt&&Date.parse(item.retryAt)>now&&sameEvidence);
  const gateFor = (score,authorizes)=>{
   const competitors = priorCandidates.filter(film=>String(film.tmdbId)!==String(score.acceptedTmdbId)).map(film=>({tmdbId:film.tmdbId,title:film.title,original:film.original,year:film.year}));
   return invoke(live,'acceptScoredIdentity',[{score,observationKey:row.key,pinnedProgrammeRunId:RUN_ID,observationProgrammeRunId:RUN_ID,discovery:authorizes?{eligible:true,activity:'current',evidenceChanged:false,terminal:false}:{eligible:false,activity:'current',evidenceChanged:false,terminal:false},film:null,observation,competitors,tmdbDetail:detail,confirmation:null,appliedObservationKeys:[]}]);
  };
  const storedRecognitionRefused = row.recognitionGate.outcome==='refused';
  if(storedRecognitionRefused)throw new Error('recognition was not authorized '+row.key);
  const baselineRecognition = gateFor(baseline,true);
  const baselineLive = gateFor(baseline,liveAuthorizes);
  // AIR-96 changes this row's gate. Every other frozen gate must still match.
  if(row.key!=='убежище|2022'){
   if(baselineRecognition.outcome!==row.recognitionGate.outcome||baselineRecognition.reason!==row.recognitionGate.reason)throw new Error('recognition drift '+row.key);
   if(baselineLive.outcome!==row.liveGate.outcome||baselineLive.reason!==row.liveGate.reason)throw new Error('live drift '+row.key);
  }
  const recognition = gateFor(current,true);
  const liveGate = gateFor(current,liveAuthorizes);
  const verification = current.status!=='accepted'?'not_applicable':detail?'evaluated':'not_evaluated';
  const aliasOnly = (row.aliases||[]).filter(alias=>alias.matched&&alias.feedsScorer===false).map(alias=>({tmdbId:alias.tmdbId,matched:alias.matched}));
  return {
   order:row.order,group:row.group,key:row.key,
   baseline:{status:row.score.status,reason:row.score.reason,acceptedTmdbId:row.score.acceptedTmdbId??null,score:row.score.score,recognition:row.recognitionGate,live:row.liveGate},
   rescoredBaselineScore:baseline.score,
   after:{status:current.status,reason:current.reason,acceptedTmdbId:current.acceptedTmdbId??null,score:current.score,recognition:{outcome:recognition.outcome,reason:recognition.reason},live:{outcome:liveGate.outcome,reason:liveGate.reason},competingEditions:recognition.competingEditions||null},
   claim:row.hits.map(claimFor).find(Boolean)||null,
   verification,
   aliasOnly,
   liveAuthorizes
  };
 });
 const accepted = rows.filter(row=>row.after.status==='accepted');
 const verified = rows.filter(row=>row.verification==='evaluated'&&row.after.recognition.outcome==='detail_verified');
 const held = rows.filter(row=>row.verification==='evaluated'&&row.after.recognition.outcome==='needs_verification');
 const missingDetail = accepted.filter(row=>row.verification==='not_evaluated');
 const changed = rows.filter(row=>row.baseline.reason!==row.after.reason||row.baseline.recognition.outcome!==row.after.recognition.outcome||row.baseline.recognition.reason!==row.after.recognition.reason);
 return {programmeRunId:RUN_ID,capturedAt:results.now,rows,accepted,verified,held,missingDetail,changed,aliasOnly:rows.filter(row=>row.aliasOnly.length)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report = rescoreFrozen();
 const brief = report.rows.map(row=>({order:row.order,group:row.group,key:row.key,before:row.baseline.reason+' / '+row.baseline.recognition.outcome,after:row.after.reason+' / '+row.after.recognition.outcome+' / '+row.after.recognition.reason,id:row.after.acceptedTmdbId,verification:row.verification,live:row.after.live.outcome+' / '+row.after.live.reason,editions:row.after.competingEditions}));
 console.log(JSON.stringify({changed:brief.filter((_,index)=>report.changed.some(row=>row.order===report.rows[index].order)),verified:report.verified.map(row=>row.key),held:report.held.map(row=>row.key),missingDetail:report.missingDetail.map(row=>({key:row.key,id:row.after.acceptedTmdbId,reason:row.after.reason})),aliasOnly:report.aliasOnly.map(row=>({key:row.key,alias:row.aliasOnly})),scoreDrift:report.rows.filter(row=>row.rescoredBaselineScore!==row.baseline.score).map(row=>({key:row.key,stored:row.baseline.score,rescored:row.rescoredBaselineScore}))},null,2));
}
