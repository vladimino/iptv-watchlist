// ADR 0195 (AIR-573): helpers of the tests that drive the real Worker as a standing Prediction Task. The MCP boundary requires the Task label `taskId` on a real scheduled start and on every run-scoped call;
// the tests of other behaviour add it here instead of repeating it at every call site. The ownership semantics themselves are tested in prediction-task-id.mjs, which does not use these helpers.
import {sql} from './prediction-d1-flow-lib.mjs';

const RUN_SCOPED=new Set(['prediction_batch_manifest','prediction_heartbeat','prediction_batch_hold','prediction_batch_submit','prediction_complete']);
export const TEST_TASK_ID='task00';
// The arguments a standing Task would send: the label is added where the MCP requires it and the caller did not set it.
export function withTaskId(name,args){
 if(!args||typeof args!=='object'||Array.isArray(args)||args.taskId!==undefined)return args;
 if(RUN_SCOPED.has(name)&&args.dryRun!==true)return {...args,taskId:TEST_TASK_ID};
 if(name==='prediction_batch_start'&&args.trigger==='scheduled'&&args.dryRun!==true&&args.invocationKey===undefined&&args.deferred===undefined)return {...args,taskId:TEST_TASK_ID};
 return args;
}
// HTTP calls on a run that carries a label send that label, as the Task does through the MCP. A run without a label is called without one.
export function labelledApi(w){
 const raw=w.api;
 w.api=async(route,body)=>{
  if(['heartbeat','complete','batch/hold','batch/submit'].includes(route)&&body&&typeof body.runId==='string'&&body.taskId===undefined&&body.dryRun!==true&&/^[A-Za-z0-9_-]{1,100}$/.test(body.runId)){
   const rows=sql(w.file,"SELECT document_json AS d FROM prediction_run WHERE run_id='"+body.runId+"'");
   const label=rows[0]?JSON.parse(rows[0].d).taskId:undefined;
   if(label)body={...body,taskId:label};
  }
  return raw(route,body);
 };
 return w;
}
