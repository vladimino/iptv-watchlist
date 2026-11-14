import vm from 'node:vm';
// AIR-325: no HTTP route runs a Discovery chunk any more; the Workflow drives the engine. Tests that cover the chunk engine
// and its diagnostics drive the same entry points the retired external step used.
export function engineStep(context,env,{route='/api/sync/epg',runId='sync-1',caller='http',branch='continuation',extra={}}={}){
 const f=name=>vm.runInContext(name,context);
 return async()=>{
  const started=Date.now(),step=f('continuationStep')(caller,route,runId);
  await f('openContinuationStep')(env,step,true);
  if(runId){const run=await f('loadJSON')(env,'sync.json');step.runStage=f('diagnosticCode')(f('DIAGNOSTIC_VOCABULARY').runStage,run?.stage??null);}
  step.branch=branch;
  let response;
  try{
   const outcome=await f('advanceDiscovery')(env,{...extra,caller:step.caller,trace:step.diagnostic,onCheckpoint:committed=>f('markContinuationCheckpoint')(env,step,true,committed)});
   step.discovery=f('discoverySummary')(outcome.discovery);
   response={status:200,data:JSON.parse(JSON.stringify({runId,stage:'complete',ratingsPending:false,discovery:outcome.discovery,diagnostic:outcome.diagnostic}))};
  }catch(error){await f('closeContinuationStep')(env,step,started,null,error,true);throw error;}
  await f('closeContinuationStep')(env,step,started,new Response(JSON.stringify(response.data)),null,true);
  return response;
 };
}
