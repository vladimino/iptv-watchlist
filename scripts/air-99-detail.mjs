import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
import {historicalEvidenceOutput,loadProduction} from './air-86-replay.mjs';

const CAP = 5;
const IDS = ['36647','161','395','163','603'];
const RUN_ID = 'cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb';
const OBSERVATIONS = [
 {id:'36647',key:'блейд 1|1998',title:'Блейд 1',year:1998,durations:[120],claim:{reason:'spelling_e',query:'Блэйд'}},
 {id:'161',key:'11 друзей оушена|2001',title:'11 друзей Оушена',year:2001,durations:[117],claim:{reason:'numeral',query:'одиннадцать друзей Оушена'}},
 {id:'395',key:'чужой против хищника 1|2004',title:'Чужой против Хищника 1',year:2004,durations:[101],claim:{reason:'part_suffix',query:'Чужой против Хищника'}},
 {id:'163',key:'12 друзей оушена|2004',title:'12 друзей Оушена',year:2004,durations:[125],claim:{reason:'numeral',query:'двенадцать друзей Оушена'}},
 {id:'603',key:'матрица 1|1999',title:'Матрица 1',year:1999,durations:[136,137],claim:{reason:'part_suffix',query:'Матрица'}}
];

function detailPath(id){
 return `movie/${id}?language=ru-RU&append_to_response=credits,translations,alternative_titles`;
}
function safeMovie(movie){
 if(!movie||typeof movie!=='object')return null;
 const aliases=[...(movie.alternative_titles?.titles||[]).map(item=>item?.title),...(movie.translations?.translations||[]).map(item=>item?.data?.title)].filter(title=>typeof title==='string');
 return {id:movie.id??null,title:movie.title||'',original_title:movie.original_title||'',release_date:typeof movie.release_date==='string'?movie.release_date.slice(0,10):'',runtime:movie.runtime??null,aliases};
}

export async function fetchDetailCards(request){
 const calls=[],rows=[];
 let halted=false;
 for(const id of IDS){
  if(halted||calls.length>=CAP){rows.push({id,skipped:halted?'halted':'budget'});continue;}
  const response=await request(detailPath(id));
  const status=response?.status??0;
  calls.push({id,status});
  if(status===429)halted=true;
  rows.push({id,status,skipped:false,movie:response?.json??null});
 }
 return {cap:CAP,http:calls.length,halted,calls,rows};
}

function invoke(live,name,args){
 live.__args=args;
 return vm.runInContext(`${name}(...__args)`,live);
}
export function gateFetched(live,observation,movie,competitors=[]){
 const norm=value=>invoke(live,'scoreNorm',[value]);
 const exact=['part_suffix','spelling_e','numeral'].includes(observation.claim.reason)?[movie?.title,movie?.original_title].find(title=>title&&norm(title)===norm(observation.claim.query)):null;
 const claim=exact?{reason:observation.claim.reason,query:observation.claim.query,matched:exact}:null;
 const candidate={tmdbId:String(movie?.id??''),title:movie?.title||'',original:movie?.original_title||'',year:Number(String(movie?.release_date||'').slice(0,4))||null,runtime:movie?.runtime??null,trusted:false,...(claim?{structuralClaims:[claim]}:{})};
 const normalizedTitle=observation.key.slice(0,observation.key.lastIndexOf('|'));
 const scored=invoke(live,'scoreFilmResolution',[{observation:{key:observation.key,title:observation.title,normalizedTitle,year:observation.year,durations:observation.durations},candidates:[candidate]}]);
 const detail=invoke(live,'tmdbDetailFromMovie',[movie]);
 const gate=invoke(live,'acceptScoredIdentity',[{score:scored,observationKey:observation.key,pinnedProgrammeRunId:RUN_ID,observationProgrammeRunId:RUN_ID,discovery:{eligible:true,activity:'current',evidenceChanged:false,terminal:false},film:null,observation:{normalizedTitle,year:observation.year,durations:observation.durations},competitors,tmdbDetail:detail,confirmation:null,appliedObservationKeys:[]}]);
 return {score:{status:scored.status,reason:scored.reason,acceptedTmdbId:scored.acceptedTmdbId??null},gate:{outcome:gate.outcome,reason:gate.reason},competingEditions:gate.competingEditions||null};
}

async function main(){
 const token=process.env.TMDB_API_READ_ACCESS_TOKEN;
 if(!token){console.error('TMDB_API_READ_ACCESS_TOKEN is unset');process.exit(2);}
 const output=historicalEvidenceOutput(process.argv[2]);
 if(!output.ok){console.error(output.reason);process.exit(2);}
 const live=loadProduction();
 const result=await fetchDetailCards(async path=>{
  const response=await fetch('https://api.themoviedb.org/3/'+path,{headers:{Authorization:'Bearer '+token,Accept:'application/json'},signal:AbortSignal.timeout(12000)});
  const json=response.status===204?null:await response.json().catch(()=>null);
  return {status:response.status,json};
 });
 const byId=new Map(OBSERVATIONS.map(row=>[row.id,row]));
 result.rows=result.rows.map(row=>{
  const observation=byId.get(row.id);
  const gated=row.movie&&observation?gateFetched(live,observation,row.movie,[]):{};
  return {...row,...gated,movie:row.movie?safeMovie(row.movie):null};
 });
 fs.writeFileSync(output.path,JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify({http:result.http,halted:result.halted,ids:result.calls.map(call=>call.id)}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main();
