// Scored EPG-to-film resolution, PR 1 of AIR-43.
// Pure and storage-neutral. The Worker does not load or call this file.
const SCORER_VERSION=1;
const TITLE_WEIGHT=.5,YEAR_WEIGHT=.2,UNIQUENESS_WEIGHT=.15,RUNTIME_WEIGHT=.15;
const ACCEPT_SCORE=.82,AMBIGUOUS_SCORE=.7,ACCEPT_MARGIN=.12;
function scoreNorm(value){return String(value??'').normalize('NFKC').toLowerCase().replace(/ё/g,'е').replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
function scoreTokens(value){return scoreNorm(value).split(' ').filter(Boolean);}
function shortTitle(value){const text=scoreNorm(value);return scoreTokens(text).length<=1||text.length<=8;}
function finiteNumber(value){if(value==null||value==='')return null;const number=Number(value);return Number.isFinite(number)?number:null;}
function observationDurations(observation){return [...new Set([...(observation.durations||[]),observation.duration].map(finiteNumber).filter(value=>value!=null))];}
const STRUCTURAL_NUMBER_WORDS={1:'один',2:'два',3:'три',4:'четыре',5:'пять',6:'шесть',7:'семь',8:'восемь',9:'девять',10:'десять',11:'одиннадцать',12:'двенадцать'};
function spellSwap(token){
 if(!token||/[\s-]/u.test(token)||[...token].length>8)return null;
 if(token.includes('э'))return token.replace(/э/g,'е');
 if(token.includes('е'))return token.replace(/е/g,'э');
 return null;
}
function reversibleStructuralForm(observationTitle,candidateTitle){
 const observation=scoreNorm(observationTitle),candidate=scoreNorm(candidateTitle);
 if(!observation||!candidate||observation===candidate)return null;
 const lead=observation.match(/^(\d{1,2}) (\p{L}.*)$/u);
 if(lead&&/\p{Script=Cyrillic}/u.test(lead[2])&&STRUCTURAL_NUMBER_WORDS[Number(lead[1])]){
  const form=scoreNorm(STRUCTURAL_NUMBER_WORDS[Number(lead[1])]+' '+lead[2]);
  if(candidate===form)return {reason:'numeral',form};
 }
 const part=observation.match(/^(.*\p{L}.*) 1$/u),stem=part&&scoreNorm(part[1]).length>=3?scoreNorm(part[1]):null;
 if(stem&&candidate===stem)return {reason:'part_suffix',form:stem,part:1};
 const whole=spellSwap(observation);
 if(whole&&candidate===whole)return {reason:'spelling_e',form:whole};
 if(stem){const spelled=spellSwap(stem);if(spelled&&candidate===spelled)return {reason:'spelling_e',form:spelled,part:1};}
 return null;
}
function structuralClaim(candidate){
 const claim=candidate?.structural;
 if(!claim||!['part_suffix','spelling_e','numeral'].includes(claim.reason))return null;
 const query=scoreNorm(claim.query),matched=scoreNorm(claim.matched);
 if(!query||!matched||query!==matched)return null;
 return {reason:claim.reason,form:matched};
}
function titleEvidence(observation,fields){
 const wanted=scoreNorm(observation.normalizedTitle||observation.title),rank={title:0,original:1,alias:2};
 let found=null;
 for(const [source,value] of fields)if(wanted&&scoreNorm(value)===wanted&&(!found||rank[source]<rank[found.source]))found={quality:1,source,matched:scoreNorm(value)};
 return found||{quality:0,source:null,matched:null};
}
function structuralClaimsOf(candidate){
 const raw=[...(Array.isArray(candidate?.structuralClaims)?candidate.structuralClaims:[]),...(candidate?.structural?[candidate.structural]:[])];
 const out=[],seen=new Set();
 for(const claim of raw){
  const parsed=structuralClaim({structural:claim});
  if(!parsed)continue;
  const key=parsed.reason+'|'+parsed.form;
  if(seen.has(key))continue;
  seen.add(key);out.push(parsed);
 }
 return out;
}
function structuralTitleEvidence(observation,group){
 const rank={part_suffix:0,spelling_e:1,numeral:2},found=[];
 for(const claim of group.structuralClaims||[])for(const title of [...group.titles,...group.originals]){
  const form=reversibleStructuralForm(observation.normalizedTitle||observation.title,title);
  if(form&&form.reason===claim.reason&&form.form===claim.form)found.push(form);
 }
 found.sort((a,b)=>(rank[a.reason]??9)-(rank[b.reason]??9)||a.form.localeCompare(b.form));
 const match=found[0];
 return match?{quality:1,source:'structural',matched:match.form,structural:match}:null;
}
function aggregateCandidates(candidates){
 const groups=new Map();
 for(const candidate of candidates||[]){
  const tmdbId=candidate?.tmdbId==null?'':String(candidate.tmdbId);
  if(!tmdbId)continue;
  const group=groups.get(tmdbId)||{tmdbId,titles:[],originals:[],aliases:[],years:[],runtimes:[],trusted:false,sources:0,structuralClaims:[]};
  group.sources++;
  if(candidate.title)group.titles.push(candidate.title);
  if(candidate.original)group.originals.push(candidate.original);
  for(const extra of candidate.extraTitles||[])if(extra)group.titles.push(extra);
  for(const alias of candidate.aliases||[])if(alias)group.aliases.push(alias);
  const year=finiteNumber(candidate.year);if(year!=null)group.years.push(year);
  const runtime=finiteNumber(candidate.runtime);if(runtime!=null)group.runtimes.push(runtime);
  if(candidate.trusted===true)group.trusted=true;
  for(const claim of structuralClaimsOf(candidate))if(!group.structuralClaims.some(item=>item.reason===claim.reason&&item.form===claim.form))group.structuralClaims.push(claim);
  groups.set(tmdbId,group);
 }
 return [...groups.values()];
}
function chosenYear(years,observationYear){
 const unique=[...new Set(years)];
 if(!unique.length)return null;
 if(observationYear==null)return unique.sort((a,b)=>a-b)[0];
 return unique.sort((a,b)=>Math.abs(a-observationYear)-Math.abs(b-observationYear)||a-b)[0];
}
function chosenRuntime(runtimes,durations){
 if(!runtimes.length)return null;
 if(!durations.length)return runtimes.slice().sort((a,b)=>a-b)[0];
 return runtimes.slice().sort((a,b)=>Math.min(...durations.map(duration=>Math.abs(duration-a)))-Math.min(...durations.map(duration=>Math.abs(duration-b)))||a-b)[0];
}
function yearEvidence(observationYear,candidateYear,short,unique){
 if(observationYear==null)return short||!unique?{signal:.15,relation:'year_required'}:{signal:.75,relation:'year_absent_unique'};
 if(candidateYear==null)return {signal:.4,relation:'candidate_year_missing'};
 const diff=Math.abs(observationYear-candidateYear);
 if(diff===0)return {signal:1,relation:'year_exact'};
 if(diff===1)return {signal:.85,relation:'year_near'};
 return {signal:0,relation:'year_conflict',contradiction:'year_conflict'};
}
function runtimeEvidence(runtime,durations){
 if(runtime==null||!durations.length)return {signal:.5,distanceMinutes:null,relation:'runtime_unknown'};
 const distance=Math.min(...durations.map(duration=>Math.abs(duration-runtime)));
 const near=Math.max(8,runtime*.08),mid=Math.max(25,runtime*.2),far=Math.max(45,runtime*.4);
 if(distance<=near)return {signal:1,distanceMinutes:distance,relation:'runtime_near'};
 if(distance<=mid)return {signal:.55,distanceMinutes:distance,relation:'runtime_mid'};
 if(distance<=far)return {signal:.2,distanceMinutes:distance,relation:'runtime_far'};
 return {signal:0,distanceMinutes:distance,relation:'runtime_conflict',contradiction:'runtime_conflict'};
}
function compatible(observationYear,candidateYear){return observationYear==null||candidateYear==null||Math.abs(observationYear-candidateYear)<=1;}
function scoreFilmResolution(input){
 const observation=input?.observation||{},observationYear=finiteNumber(observation.year),durations=observationDurations(observation);
 const exact=[],prepared=[];
 for(const group of aggregateCandidates(input?.candidates)){
  const title=titleEvidence(observation,[...group.titles.map(value=>['title',value]),...group.originals.map(value=>['original',value]),...group.aliases.map(value=>['alias',value])]);
  const structural=title.quality===1?null:structuralTitleEvidence(observation,group);
  if(structural)Object.assign(title,structural);
  const row={tmdbId:group.tmdbId,title,year:chosenYear(group.years,observationYear),runtime:chosenRuntime(group.runtimes,durations),trusted:group.trusted,sources:group.sources};
  prepared.push(row);
  if(title.quality===1)exact.push(row);
 }
 const competitors=exact.filter(row=>compatible(observationYear,row.year));
 const unique=competitors.length===1,short=shortTitle(observation.normalizedTitle||observation.title);
 const considered=prepared.map(row=>{
  const inSet=competitors.includes(row);
  const uniqueness={value:inSet?1/competitors.length:0,competitors:competitors.length};
  const year=yearEvidence(observationYear,row.year,short,unique);
  const runtime=runtimeEvidence(row.runtime,durations);
  const contradictions=[year.contradiction,runtime.contradiction].filter(Boolean);
  const score=row.title.quality===0?0:Math.round((TITLE_WEIGHT*row.title.quality+YEAR_WEIGHT*year.signal+UNIQUENESS_WEIGHT*uniqueness.value+RUNTIME_WEIGHT*runtime.signal)*10000)/10000;
  return {tmdbId:row.tmdbId,sources:row.sources,score,title:row.title,uniqueness,year:{signal:year.signal,relation:year.relation},runtime:{signal:runtime.signal,distanceMinutes:runtime.distanceMinutes,relation:runtime.relation},contradictions,trusted:row.trusted};
 });
 considered.sort((a,b)=>b.score-a.score||a.tmdbId.localeCompare(b.tmdbId));
 const top=considered[0]||null,second=considered.find(row=>row.tmdbId!==top?.tmdbId)||null,score=top?.score||0;
 const remake=exact.some(row=>Math.abs((observationYear??NaN)-row.year)>=2);
 const titleBasis=top?.title?.quality===1?{source:top.title.source,form:top.title.matched,structural:top.title.structural||null}:null;
 let status='no_confident_match',reason=exact.length?'no_confident_score':'no_exact_title',acceptedTmdbId=null;
 if(top&&top.contradictions.length){status='contradicted';reason=top.contradictions.includes('year_conflict')?'contradicted_year':'contradicted_runtime';}
 else if(top&&top.title.quality===1&&(top.year.relation==='year_required'||top.uniqueness.value<1)){status='ambiguous';reason=short&&observationYear==null?'ambiguous_short_title_without_year':'ambiguous_collision';}
 else if(top&&score>=ACCEPT_SCORE&&(!second||score-second.score>ACCEPT_MARGIN)){status='accepted';acceptedTmdbId=top.tmdbId;reason=titleBasis?.structural?remake?'accepted_'+titleBasis.structural.reason+'_remake':'accepted_'+titleBasis.structural.reason:remake?'accepted_year_separates_remakes':'accepted_unique_evidence';}
 else if(top&&score>=AMBIGUOUS_SCORE){status='ambiguous';reason='ambiguous_margin';}
 return {scorerVersion:SCORER_VERSION,observationKey:observation.key??null,status,confidence:score,score,acceptedTmdbId,reason,titleBasis,considered};
}
function showMatchBasis(titleYear,observation,candidates){
 const score=scoreFilmResolution({observation,candidates:candidates||[]});
 if(score.status==='accepted')return {basis:titleYear?'title_year':'title_unique',hint:false,reason:score.reason};
 return {basis:'title_duration',hint:true,reason:score.reason};
}
