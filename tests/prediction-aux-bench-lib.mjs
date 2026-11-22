// AIR-553 / ADR 0194: the paired whole-cycle measurement of the batch_v2 auxiliary state, shared by the deterministic budget test (core) and the wall-clock benchmark script (non-functional).
// One cycle is the cycle a Scheduled Task runs (ADR 0193): a deferred start (receipt), the Workflow preparation, the bounded readback of every manifest part, the submits in groups of five, one
// heartbeat and the owned complete (which delivers the terminal Event). Three arms run the SAME revision over the SAME seeded queue, profile and catalog:
//   legacy   the PredictionAux module is absent: today's production before migration 0034 (R2 stage, sources, manifest, outbox)
//   r2marker migration 0034 applied, marker r2: the same R2 code plus the marker read (the dormant overhead)
//   d1       marker d1: the four families in D1, no R2 object of them
// Counts are exact and deterministic; wall time is the local stand-in (a sqlite process per statement, an in-memory R2) and is NOT Cloudflare latency.
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';

const AUX_R2=key=>key.startsWith('enrichment/sources/')||key.startsWith('enrichment/batch-manifest/')||key==='enrichment/batch-stage.json'||key.startsWith('enrichment/stop-events/')||key.startsWith('enrichment/start-events/')||key==='enrichment/event-outbox.json';
const WRITE=/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
export const ARMS=['legacy','r2marker','d1'];
export const AUX_TABLES=['prediction_batch_stage','prediction_batch_stage_head','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
const blank=()=>({ms:0,d1:{calls:0,batches:0,statements:0,readStatements:0,writeStatements:0,writeBytes:0,maxStatementBytes:0},r2:{get:0,head:0,put:0,list:0,delete:0,putBytes:0,auxOps:0}});
const add=(into,from)=>{into.ms+=from.ms;for(const k of Object.keys(into.d1))into.d1[k]=k==='maxStatementBytes'?Math.max(into.d1[k],from.d1[k]):into.d1[k]+from.d1[k];for(const k of Object.keys(into.r2))into.r2[k]+=from.r2[k];};

export async function arm(name,{films=40,seed=null}={}){
 const w=await flowWorld({films,aux:name==='legacy'?null:name==='r2marker'?'r2':'d1'});
 const cur={phase:null};w.metrics={};
 const at=()=>{const p=cur.phase;if(!p)return null;return w.metrics[p]??=blank();};
 // R2: every operation, by kind, with the auxiliary families counted separately
 const bucket=w.env.BUCKET;
 for(const op of ['get','head','put','list','delete']){
  const real=bucket[op].bind(bucket);
  bucket[op]=async(key,...rest)=>{const m=at();if(m){m.r2[op]++;if(typeof key==='string'&&AUX_R2(key))m.r2.auxOps++;if(op==='put'&&typeof rest[0]==='string')m.r2.putBytes+=rest[0].length;}return real(key,...rest);};
 }
 // D1: every statement (alone or inside a batch), reads and writes, bytes of the written statements
 const prevQuery=w.hooks.query;
 w.hooks.query=text=>{
  const m=at();if(m){m.d1.statements++;const write=WRITE.test(text);if(write){m.d1.writeStatements++;m.d1.writeBytes+=text.length;}else m.d1.readStatements++;m.d1.maxStatementBytes=Math.max(m.d1.maxStatementBytes,text.length);}
  if(prevQuery)prevQuery(text);
 };
 w.phase=async(name,work)=>{
  cur.phase=name;const m=at(),q0=w.stats.queries,b0=w.stats.batches,t0=performance.now();
  try{return await work();}finally{m.ms+=performance.now()-t0;m.d1.calls+=w.stats.queries-q0+w.stats.batches-b0;m.d1.batches+=w.stats.batches-b0;cur.phase=null;}
 };
 w.instances=[];
 w.env.PREDICTION_START_WORKFLOW={async create({id,params}){w.instances.push({id,params});return {id};},async get(id){if(w.instances.some(item=>item.id===id))return {id};throw new Error('instance.not_found');}};
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(toolName,args)=>{w.ctx.__a={name:toolName,args};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.step={do:async(name2,config,fn)=>fn()};
 await w.api('queue/reconcile',{});
 w.arm=name;
 if(seed)await seed(w);
 return w;
}
const body=result=>JSON.parse(result.content[0].text);
// The cycle of one Task run. Returns the phase metrics and the run summary.
export async function cycle(w,{manifestSize=5,groupSize=5,complete='manifest_spent',skipRefusal=false}={}){
 const key=body(await w.tool('prediction_batch_key',{})).invocationKey;
 const receipt=await w.phase('receipt',()=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize,deferred:true,invocationKey:key,capacity:{remainingPercent:100}}));
 if(receipt.status!==200)throw new Error('receipt '+receipt.status+' '+JSON.stringify(receipt.data).slice(0,200));
 const runId=receipt.data.runId;
 await w.phase('prepare',()=>w.ctx.runPredictionStartWorkflow(w.env,w.instances[w.instances.length-1].params,w.step));
 const envelope=await w.phase('readback',async()=>{
  const e=body(await w.tool('prediction_batch_manifest',{runId,part:'envelope'}));
  if(e.kind!=='envelope')throw new Error('readback '+JSON.stringify(e).slice(0,200));
  await w.tool('prediction_batch_manifest',{runId,part:'profile'});await w.tool('prediction_batch_manifest',{runId,part:'contract'});
  for(const part of e.parts.filter(p=>p.kind==='film'))await w.tool('prediction_batch_manifest',{runId,part:'film',filmId:part.filmId});
  return e;
 });
 const ids=envelope.parts.filter(p=>p.kind==='film').map(p=>p.filmId);
 const epoch=envelope.lease.epoch;
 // the plan of each film decides whether a fingerprint travels with its submit; the film part tells it
 const plans={};for(const id of ids)plans[id]=body(await w.tool('prediction_batch_manifest',{runId,part:'film',filmId:id})).film.plan;
 let committed=0;
 if(skipRefusal)await w.phase('refusal',()=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',capacity:{remainingPercent:100}}));
 for(let i=0;i<ids.length;i+=groupSize){
  const items=ids.slice(i,i+groupSize).map(id=>({filmId:id,...(plans[id]==='prediction_only'?{}:{fingerprint:w.fingerprint}),prediction:w.prediction}));
  const submit=await w.phase('submit',()=>w.api('batch/submit',{runId,epoch,items}));
  if(submit.status!==200)throw new Error('submit '+submit.status+' '+JSON.stringify(submit.data).slice(0,200));
  committed+=(submit.data.results||[]).filter(r=>r.status==='created'||r.status==='recalculated').length;
  if(i===0)await w.phase('heartbeat',()=>w.api('heartbeat',{runId}));
 }
 const done=await w.phase('complete',()=>w.api('complete',{runId,reason:complete}));
 if(done.status!==200)throw new Error('complete '+done.status+' '+JSON.stringify(done.data).slice(0,200));
 return {runId,films:ids.length,committed};
}
export function total(w){const out=blank();for(const m of Object.values(w.metrics))add(out,m);return out;}
export const rowCounts=w=>Object.fromEntries(AUX_TABLES.map(t=>[t,Number(sql(w.file,'SELECT count(*) AS n FROM '+t)[0].n)]));
export const fileBytes=w=>fs.statSync(w.file).size;
// A seeded history (an aged database): `runs` settled runs with a typical manifest, its source and a compacted outbox row, inserted by one SQL script (never through the Worker). It only fills the D1 arm's tables.
export async function seedHistory(w,{runs,manifestChars=38000}){
 if(w.arm!=='d1')return;
 const digest='a'.repeat(64),stamp='2026-10-01T00:00:00.000Z';
 const rows=[];
 for(let n=0;n<runs;n++){
  const id='hist-'+String(n).padStart(6,'0'),text='x'.repeat(manifestChars);
  rows.push("INSERT INTO prediction_run_manifest (run_id,manifest_hash,payload_digest,selected_ids,drained_json,bytes,piece_count,part_index,created_at) VALUES ('"+id+"','"+digest+"','"+digest+"','[]',NULL,"+manifestChars+",1,'{\"segments\":[],\"pieces\":["+manifestChars+"]}','"+stamp+"');");
  rows.push("INSERT INTO prediction_run_manifest_piece (run_id,piece_no,piece_digest,text) VALUES ('"+id+"',0,'"+digest+"','"+text+"');");
  rows.push("INSERT INTO prediction_run_source_revision (run_id,revision,source_hash,bytes,piece_count,created_at) VALUES ('"+id+"',1,'"+digest+"',4000,1,'"+stamp+"');");
  rows.push("INSERT INTO prediction_run_source_piece (run_id,revision,piece_no,text) VALUES ('"+id+"',1,0,'"+'y'.repeat(4000)+"');");
  rows.push("INSERT INTO prediction_run_source_head (run_id,current_revision,source_hash) VALUES ('"+id+"',1,'"+digest+"');");
  rows.push("INSERT INTO prediction_event_outbox (event_key,kind,event_id,at,journal_key,run_id,state,attempts,since,last_attempt_at,settled_at,payload_digest,payload_compacted,event_json) VALUES ('stop:"+id+"','stop','enrichment-"+id+"','"+stamp+"','events/items/"+id+".json','"+id+"','delivered',0,'"+stamp+"',NULL,'"+stamp+"','"+digest+"',1,NULL);");
 }
 const {sqliteSync}=await import('./sqlite-session.mjs');
 const r=sqliteSync(['-bail',w.file],{input:'BEGIN;\n'+rows.join('\n')+'\nCOMMIT;',encoding:'utf8',maxBuffer:1<<30});
 if(r.status!==0)throw new Error(r.stderr.trim());
}
