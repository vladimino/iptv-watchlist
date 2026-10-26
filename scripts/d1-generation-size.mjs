// Measures the statement list one programme generation unit produces today, by running the real EPG repository
// against a recording adapter on a synthetic generation of the given size. It reads and writes nothing else: no R2,
// no database. The numbers size the staged import design; they are not a production measurement.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createEpgRepository} from '../src/epg-repository.js';
import {renderSql} from './d1-backfill.mjs';

const kindOf=statement=>{
 const match=statement.match(/^\s*(INSERT INTO|UPDATE|DELETE FROM)\s+([a-z_]+)/i);
 return match?match[1].split(' ')[0].toUpperCase()+' '+match[2]:'OTHER';
};

export function syntheticGeneration({films=0,showsPerFilm=1,candidates=0,showsPerCandidate=1,titleLength=24,keyLength=24,runId='run-measure',previousRunId=null}={}){
 const pad=(text,length)=>(text+'-'.repeat(length)).slice(0,length);
 const at=Date.UTC(2026,9,26);
 return {
  programmeRunId:runId,phase:'published',expectedProgrammeRunId:previousRunId,publishedAt:new Date(at).toISOString(),
  films:Array.from({length:films},(_,index)=>({filmId:'film:'+pad('f'+index,keyLength),shows:Array.from({length:showsPerFilm},(_,show)=>({channelId:'channel-'+(show%40),channel:pad('Channel '+(show%40),18),startMs:at+show*3600000+index,endMs:at+show*3600000+index+5400000,epgTitle:pad('Title '+index,titleLength),basis:'title_duration',matchReason:null}))})),
  candidates:Array.from({length:candidates},(_,index)=>{
   const key=pad('c'+index,keyLength)+'|1999';
   return {observationKey:key,title:pad('Title '+index,titleLength),normalizedTitle:pad('title '+index,titleLength),year:1999,rawTitles:[pad('Raw '+index,titleLength)],durations:[95],description:null,firstAiringMs:at,lastAiringMs:at+3600000,airings:showsPerCandidate,confirmedTmdbId:null,evidenceKey:pad('title '+index,titleLength)+'|1999|95|channel-1:'+at,activity:'current',lastSeenAt:new Date(at).toISOString(),lastSeenProgrammeRunId:runId,seenInLatest:true,shows:Array.from({length:showsPerCandidate},(_,show)=>({channelId:'channel-'+(show%40),channel:pad('Channel '+(show%40),18),startMs:at+show*3600000+index,endMs:at+show*3600000+index+5400000,epgTitle:pad('Title '+index,titleLength)}))};
  }),
 };
}

export async function measureGenerationUnit(options={}){
 const statements=[];
 const db={
  run(sql,params=[]){statements.push(renderSql(sql,params)+';');return Promise.resolve();},
  get(){return Promise.resolve(null);},
  all(){return Promise.resolve([]);},
  async transaction(fn){return fn();},
 };
 await createEpgRepository(db).publishGeneration(syntheticGeneration(options));
 const byKind={};
 let bytes=0,largest={kind:null,bytes:0};
 for(const statement of statements){
  const size=Buffer.byteLength(statement,'utf8'),kind=kindOf(statement);
  bytes+=size;
  byKind[kind]=byKind[kind]||{statements:0,bytes:0};
  byKind[kind].statements++;byKind[kind].bytes+=size;
  if(size>largest.bytes)largest={kind,bytes:size};
 }
 return {input:{films:options.films??0,showsPerFilm:options.showsPerFilm??1,candidates:options.candidates??0,showsPerCandidate:options.showsPerCandidate??1},statements:statements.length,bytes,largestStatement:largest,byKind};
}

// statements = 3 + F + F*sf + (sf>0 ? F : 0) + 2C + C*sc + 1 for a published generation with F films and C candidates.
export function expectedStatements({films=0,showsPerFilm=1,candidates=0,showsPerCandidate=1}={}){
 return 3+films+films*showsPerFilm+(showsPerFilm>0?films:0)+2*candidates+candidates*showsPerCandidate+1;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),value=(flag,fallback)=>{const index=args.indexOf(flag);return index<0?fallback:Number(args[index+1]);};
 const result=await measureGenerationUnit({films:value('--films',2300),showsPerFilm:value('--shows-per-film',2),candidates:value('--candidates',22199),showsPerCandidate:value('--shows-per-candidate',2)});
 console.log(JSON.stringify(result,null,1));
}
