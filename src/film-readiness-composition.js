// AIR-665 / ADR 0218 stage 5, offline composition: the real FilmAggregateV1 read (AIR-647) followed by the pure readiness derivation (src/film-readiness.js).
// DORMANT like both modules it joins: not in the Worker bundle, nothing imports it, no route and no consumer. It adds ZERO D1 statements (the derivation reads
// only the aggregate body), no write, no R2 and no network. It is the composition that offline aggregate, diagnostics and parity use today; the D1 reader wiring
// of the stage-5 reader switch belongs to the aggregate activation (AIR-648), which calls this same function behind its own owner GO.
// `prediction` is prediction-domain evidence (predictionEvidence, bound to the Film, tokens and profile) or a function (body) => evidence supplied by the
// caller's own trusted reader; without it every prediction fact only the prediction domain can state stays `unknown`.
import {readFilmAggregate} from './film-aggregate.js';
import {deriveReadiness} from './film-readiness.js';

export async function readFilmReadiness(env,input,{prediction=null,budgetLimit}={}){
 const result=await readFilmAggregate(env,input,budgetLimit==null?{}:{budgetLimit});
 let evidence=null;
 try{evidence=typeof prediction==='function'?prediction(result.body):prediction;}catch{evidence=null;}
 return {http:result.http,body:result.body,readiness:deriveReadiness(result.body,{prediction:evidence})};
}
