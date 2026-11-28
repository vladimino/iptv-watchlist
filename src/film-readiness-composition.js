// AIR-665 / ADR 0218 stage 5: the real FilmAggregateV1 read (AIR-647) followed by the pure readiness derivation (src/film-readiness.js).
// DORMANT like both modules it joins: scoped into the Worker bundle (AIR-648, scopedFilmAggregate()) but called by nothing: no route and no consumer. The derivation adds ZERO D1
// statements, no write, no R2 and no network. It is the composition that offline aggregate, diagnostics and parity use today; the activation (AIR-648, its own owner GO) calls this same function.
// `prediction` is `{evidence, context}` (or a function (body) => that): the observation (predictionEvidence) and the independently supplied, already fenced
// expected context (identity token, active profile, registry, fingerprint read-set) of the caller's own trusted reader; see src/film-readiness.js. Without
// both, or when they do not cohere, every prediction fact only the prediction domain can state stays `unknown`.
// `predictionReader` (AIR-648) is the activation's own handle on the prediction domain: with it the composition READS that evidence itself (src/film-readiness-reader.js), inside the
// request's shared statement budget and before the final identity fence.
import {readFilmAggregate,readSections} from './film-aggregate.js';
import {readFilmAggregateIdentity,REQUEST_STATEMENT_BUDGET} from './film-aggregate-resolver.js';
import {deriveReadiness} from './film-readiness.js';
import {beginPredictionEvidence,finishPredictionEvidence} from './film-readiness-reader.js';

// AIR-648 stage 5 wiring. `predictionReader` ({registryToken(), verdictOf({pointer, fingerprint, genres, profile})}) is the activation's own, trusted handle on the prediction domain; when it
// is supplied the observation and its expected context are read HERE, inside the request's shared statement budget and before the final identity fence (src/film-readiness-reader.js:
// two reserved statements, the second one after every section read). Without it, `prediction` (the caller's own observation and context) is used exactly as before.
// Every failure of the reader is `no evidence`, never an error and never a negative.
export async function readFilmReadiness(env,input,{prediction=null,budgetLimit,predictionReader=null}={}){
 if(predictionReader==null){
  const result=await readFilmAggregate(env,input,budgetLimit==null?{}:{budgetLimit});
  return finish(result,prediction);
 }
 let evidence=null;
 const result=await readFilmAggregateIdentity(env,input,{budgetLimit:budgetLimit??REQUEST_STATEMENT_BUDGET,sections:async(resolution,budget)=>{
  const begun=await beginPredictionEvidence(env,resolution,budget,predictionReader);
  const sections=await readSections(env,resolution,budget);
  const body={identity:{filmId:resolution.filmId,token:resolution.token},...sections};
  try{evidence=await finishPredictionEvidence(env,resolution,body,budget,begun,predictionReader);}catch{evidence=null;}
  return sections;
 }});
 return finish(result,evidence);
}
function finish(result,prediction){
 let evidence=null;
 try{evidence=typeof prediction==='function'?prediction(result.body):prediction;}catch{evidence=null;}
 return {http:result.http,body:result.body,readiness:deriveReadiness(result.body,{prediction:evidence})};
}
