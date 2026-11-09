// ADR 0106 stage (a): offline benchmark of the REAL grouped write path (src/d1-enrichment.js behind D1_ENRICHMENT_BULK, loaded as the Worker bundle
// carries it) against the REAL per-entity path, on the in-memory SQLite stand-in of the AIR-391 spike. Not part of the Worker bundle, never run by CI
// or by any production path: it reads no R2, no D1 and no network. Counts are exact (every read, single write, batch and statement the projector
// sends); wall time is a MODEL: the stand-in has no network, so the latency of a round trip (`rtt`) and of a statement in a batch (`stmt`) are the
// calibrated parameters of the spike (rtt 35 to 50 ms, stmt 1 to 2 ms, two production anchors, see the AIR-391 evidence).
//   node scripts/projector-bulk-bench.mjs [--films 5000] [--pool 8000] [--group 10] [--backlog 1]
// With --backlog 1 a second scenario runs the same Films as an existing backlog: a database already holding every Person, every Film changed.
// Variants: A0 = the current per-entity path (flag off, measured); C = the grouped path (flag on, measured). A (concurrent reads, modelled in the
// spike, never built) and B (Workflow, rejected by ADR 0102) are not reproduced here.
import {pathToFileURL} from 'node:url';
import {standin,sources,seedFilms,filmRecord,dump,wallMs} from './projector-spike-bench.mjs';
import {projectorContext} from '../tests/d1-enrichment-context.mjs';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
const trips=calls=>calls.reads+calls.singleWrites+calls.batches;
const hash=(index,salt)=>(Math.imul(index+salt,2654435761)>>>0)/4294967296;
// Films like production's (mean 12.2 credits): 75 % have 11 actors, 20 % 6, 5 % 35; new Persons per Film 1 to 5 (mean 3), never more than the actors.
export const workload=(films,pool)=>Array.from({length:films},(_,index)=>{const u=hash(index,1),count=u<0.75?11:u<0.95?6:35;return filmRecord(index,Math.min(count,1+Math.floor(hash(index,7)*5)),pool,count);});

async function runVariant({films,pool,bulk,prefill}){
 const db=standin(),projector=projectorContext({log:()=>{}});
 // The database already holds the pool's Persons (the spike's seed), as production does; `prefill` also writes every Film once, so the measured run is a pure change of them.
 await projector.runD1EnrichmentProjection({DB:db,BUCKET:sources(seedFilms(pool)),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 if(prefill)await projector.runD1EnrichmentProjection({DB:db,BUCKET:sources([...seedFilms(pool),...films]),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 const changed=prefill?films.map(film=>({...film,year:film.year+1})):films;
 db.resetCalls();
 const started=process.hrtime.bigint();
 const summary=await projector.runD1EnrichmentProjection({DB:db,BUCKET:sources([...seedFilms(pool),...changed]),D1_ENRICHMENT_WRITE:'on',...(bulk?{D1_ENRICHMENT_BULK:'on'}:{})},{queryBudget:1e9,wallMs:1e9,bulk:bulk?{groupSize:bulk}:undefined});
 const seconds=Number(process.hrtime.bigint()-started)/1e9;
 if(summary.outcome!=='complete')throw new Error('incomplete '+JSON.stringify({...summary,phases:undefined,detail:undefined}));
 return {db,summary,seconds,calls:{...db.calls}};
}
export async function benchmark({films:FILMS=5000,pool:POOL=8000,group=10,backlog=false}={}){
 const films=workload(FILMS,POOL),out={films:FILMS,pool:POOL,group,scenarios:{}};
 for(const scenario of backlog?['new','backlog']:['new']){
  const prefill=scenario==='backlog';
  const a=await runVariant({films,pool:POOL,bulk:0,prefill}),c=await runVariant({films,pool:POOL,bulk:group,prefill});
  const view=(label,run)=>{
   const written=run.summary.writtenFilms;
   return {writtenFilms:written,writtenPeople:run.summary.writtenPeople,calls:run.calls,perFilm:{roundTrips:+(trips(run.calls)/written).toFixed(3),statements:+(run.calls.batchStatements/written).toFixed(1)},
    modelledSecondsPerFilm:Object.fromEntries([[35,1],[50,1.5],[50,2]].map(([rtt,stmt])=>[rtt+'/'+stmt,+(wallMs(run.calls,{rtt,stmt})/1000/written).toFixed(4)])),wallSecondsOnThisMachine:+run.seconds.toFixed(1),label};
  };
  const result={A0:view('per-entity (flag off)',a),C:view('grouped (flag on)',c),sameRows:dump(a.db)===dump(c.db),bulk:c.summary.bulk};
  result.speedup=Object.fromEntries(Object.keys(result.A0.modelledSecondsPerFilm).map(key=>[key,+(result.A0.modelledSecondsPerFilm[key]/result.C.modelledSecondsPerFilm[key]).toFixed(2)]));
  // Films one window writes if it spends `s` seconds on writes at the model's cost per Film (an assumption, not a measurement: the stand-in cannot say how D1 behaves under a batch of about a thousand statements).
  result.filmsPerWriteSeconds=Object.fromEntries([60,150,184,217].map(s=>[s,{A0:Object.fromEntries(Object.entries(result.A0.modelledSecondsPerFilm).map(([key,per])=>[key,Math.floor(s/per)])),C:Object.fromEntries(Object.entries(result.C.modelledSecondsPerFilm).map(([key,per])=>[key,Math.floor(s/per)]))}]));
  out.scenarios[scenario]=result;
 }
 return out;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const result=await benchmark({films:arg('films',5000),pool:arg('pool',8000),group:arg('group',10),backlog:arg('backlog',0)===1});
 console.log(JSON.stringify(result,null,1));
}
