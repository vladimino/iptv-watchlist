import vm from 'node:vm';
// ENGINE-LEVEL ONLY (AIR-325). No HTTP route, MCP tool or entrypoint runs a Discovery chunk any more; only the Workflow does.
// This helper rebuilds the wrapper of the RETIRED external step (continuationStep, diagnostics ring, checkpoint marker) around
// the same advanceDiscovery engine the Workflow calls, so engine unit tests keep their coverage of leases, orphans, interruptions and
// the diagnostics vocabulary. It is not a production path and proves nothing about HTTP behaviour. Integration acceptance is in
// tests/discovery-workflow.mjs (real HTTP no-mutation/delegation/refusal and the Workflow entrypoint) and tests/interrupted-recovery.mjs.
export function engineChunkDriver(context,env,{route='/api/sync/epg',runId='sync-1',caller='http',branch='continuation',extra={}}={}){
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
