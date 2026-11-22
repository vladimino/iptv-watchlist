// AIR-553 / ADR 0194: the paired whole-cycle measurement of the batch_v2 auxiliary state, shared by the deterministic budget test (core) and the wall-clock benchmark script (non-functional).
// One cycle is the cycle a Scheduled Task runs (ADR 0193), counted ONCE from its first call to its last: key issuance, the deferred start (receipt), the Workflow preparation, the bounded readback of every
// manifest part (each film part once: it also tells the plan of the film), the submits in groups of five, one heartbeat and the owned complete (which delivers the terminal Event). Four arms run the SAME
// revision over the SAME seeded queue, profile and catalog:
//   legacy    schema 33, the PredictionAux module absent: what production runs today (R2 stage, sources, manifest, outbox)
//   shipped33 schema 33, the module PRESENT (the Worker of this revision before migration 0034 is applied): the real "no overhead before the migration" arm
//   r2marker  schema 34 applied, marker r2: the same R2 code plus the marker read (the dormant overhead)
//   d1        marker d1: the four families in D1, no R2 object of them
// Counts are exact and deterministic. Rows read are the rows RETURNED (a lower bound of what D1 bills as scanned) and rows written are sqlite's changes including triggers: estimates, not billed telemetry.
// Wall time is the local stand-in (a sqlite process per statement, an in-memory R2) and is NOT Cloudflare latency.
import fs from 'node:fs';
import vm from 'node:vm';
import {flowWorld, sql,labelStarts} from './prediction-d1-flow-lib.mjs';
import {withTaskId,labelledApi} from './prediction-task-id-lib.mjs';
labelStarts();// ADR 0195: the runs of this test are started as a standing Task starts them, with its label

const AUX_R2=key=>key.startsWith('enrichment/sources/')||key.startsWith('enrichment/batch-manifest/')||key==='enrichment/batch-stage.json'||key.startsWith('enrichment/stop-events/')||key.startsWith('enrichment/start-events/')||key==='enrichment/event-outbox.json';
const WRITE=/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i;
export const ARMS=['legacy','shipped33','r2marker','d1'];
export const AUX_TABLES=['prediction_batch_stage','prediction_batch_stage_head','prediction_run_source_head','prediction_run_source_revision','prediction_run_source_piece','prediction_run_manifest','prediction_run_manifest_piece','prediction_event_outbox'];
// Illustrative list prices as recalled, NOT billed telemetry and not an acceptance threshold; the real conversion uses the account's plan (AIR-554). USD per million.
export const PRICES={d1RowsReadPerMillion:0.001,d1RowsWrittenPerMillion:1.00,r2ClassAPerMillion:4.50,r2ClassBPerMillion:0.36};
const blank=()=>({ms:0,requests:0,d1:{calls:0,batches:0,statements:0,readStatements:0,writeStatements:0,writeBytes:0,maxStatementBytes:0,rowsRead:0,rowsWritten:0},r2:{get:0,head:0,put:0,list:0,delete:0,putBytes:0,auxOps:0}});
const add=(into,from)=>{into.ms+=from.ms;into.requests+=from.requests;for(const k of Object.keys(into.d1))into.d1[k]=k==='maxStatementBytes'?Math.max(into.d1[k],from.d1[k]):into.d1[k]+from.d1[k];for(const k of Object.keys(into.r2))into.r2[k]+=from.r2[k];};
const archFor=name=>({legacy:{aux:null,schema:33},shipped33:{aux:'r2',schema:33},r2marker:{aux:'r2',schema:Infinity},d1:{aux:'d1',schema:Infinity}}[name]);

export async function arm(name,{films=40,seed=null}={}){
 const rowStats={read:0,written:0};
 const {aux,schema}=archFor(name);
 const w=await flowWorld({films,aux,schema,rowStats});
 const cur={phase:null};w.metrics={};w.rowStats=rowStats;
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
 // every request the Task makes (an HTTP call or a tool call) is counted once in the phase it belongs to
 const api=w.api;w.api=(...args)=>{const m=at();if(m)m.requests++;return api(...args);};
 w.phase=async(name2,work)=>{
  cur.phase=name2;const m=at(),q0=w.stats.queries,b0=w.stats.batches,r0=rowStats.read,w0=rowStats.written,t0=performance.now();
  try{return await work();}finally{m.ms+=performance.now()-t0;m.d1.calls+=w.stats.queries-q0+w.stats.batches-b0;m.d1.batches+=w.stats.batches-b0;m.d1.rowsRead+=rowStats.read-r0;m.d1.rowsWritten+=rowStats.written-w0;cur.phase=null;}
 };
 w.instances=[];
 w.env.PREDICTION_START_WORKFLOW={async create({id,params}){w.instances.push({id,params});return {id};},async get(id){if(w.instances.some(item=>item.id===id))return {id};throw new Error('instance.not_found');}};
 vm.runInContext(fs.readFileSync('src/mcp.js','utf8').replace('export default','globalThis.mcpWorker=').replace(/^export /gm,''),w.ctx);
 w.tool=async(toolName,args)=>{const m=at();if(m)m.requests++;w.ctx.__a={name:toolName,args:withTaskId(toolName,args)};w.ctx.__env=w.env;return (await vm.runInContext('mcpCallTool({name:__a.name,arguments:__a.args},"2025-06-18",__env,{waitUntil(){}})',w.ctx)).result;};
 w.step={do:async(name2,config,fn)=>fn()};
 await w.api('queue/reconcile',{});
 w.arm=name;
 if(seed)await seed(w);
 w.metrics={};rowStats.read=0;rowStats.written=0;
 return w;
}
const body=result=>JSON.parse(result.content[0].text);
// The cycle of one Task run. Returns the summary; the per-phase metrics are in `w.metrics`.
export async function cycle(w,{manifestSize=5,groupSize=5,complete='manifest_spent',skipRefusal=false}={}){
 const key=body(await w.phase('key',()=>w.tool('prediction_batch_key',{}))).invocationKey;
 const receipt=await w.phase('receipt',()=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',manifestSize,deferred:true,invocationKey:key,capacity:{remainingPercent:100}}));
 if(receipt.status!==200)throw new Error('receipt '+receipt.status+' '+JSON.stringify(receipt.data).slice(0,200));
 const runId=receipt.data.runId;
 await w.phase('prepare',()=>w.ctx.runPredictionStartWorkflow(w.env,w.instances[w.instances.length-1].params,w.step));
 // the readback: envelope, profile, contract and every film part ONCE (the film part also says whether a fingerprint travels with the submit)
 const plans={};let envelope;
 await w.phase('readback',async()=>{
  envelope=body(await w.tool('prediction_batch_manifest',{runId,part:'envelope'}));
  if(envelope.kind!=='envelope')throw new Error('readback '+JSON.stringify(envelope).slice(0,200));
  await w.tool('prediction_batch_manifest',{runId,part:'profile'});await w.tool('prediction_batch_manifest',{runId,part:'contract'});
  for(const part of envelope.parts.filter(p=>p.kind==='film'))plans[part.filmId]=body(await w.tool('prediction_batch_manifest',{runId,part:'film',filmId:part.filmId})).film.plan;
 });
 const ids=envelope.parts.filter(p=>p.kind==='film').map(p=>p.filmId);
 const epoch=envelope.lease.epoch;
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
export const r2Ops=t=>t.r2.get+t.r2.head+t.r2.put+t.r2.list+t.r2.delete;
// Estimated storage cost of one cycle per committed film, from the counts and the stated price table (an estimate under assumptions, never a measured bill). R2 class A: put, list; class B: get, head.
export function costPerFilm(t,committed,prices=PRICES){
 const usd=t.d1.rowsRead/1e6*prices.d1RowsReadPerMillion+t.d1.rowsWritten/1e6*prices.d1RowsWrittenPerMillion+(t.r2.put+t.r2.list)/1e6*prices.r2ClassAPerMillion+(t.r2.get+t.r2.head)/1e6*prices.r2ClassBPerMillion;
 return committed?usd/committed:null;
}
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
  rows.push("INSERT INTO prediction_run (run_id,latest,updated_at,document_json) VALUES ('"+id+"',0,'"+stamp+"','{\"runId\":\""+id+"\"}');");
  rows.push("INSERT INTO prediction_run_source_head (run_id,current_revision,source_hash) VALUES ('"+id+"',1,'"+digest+"');");
  rows.push("INSERT INTO prediction_event_outbox (event_key,kind,event_id,at,journal_key,run_id,state,attempts,since,last_attempt_at,settled_at,payload_digest,payload_compacted,event_json) VALUES ('stop:"+id+"','stop','enrichment-"+id+"','"+stamp+"','events/items/"+id+".json','"+id+"','delivered',0,'"+stamp+"',NULL,'"+stamp+"','"+digest+"',1,NULL);");
 }
 const {sqliteSync}=await import('./sqlite-session.mjs');
 const r=sqliteSync(['-bail',w.file],{input:'BEGIN;\n'+rows.join('\n')+'\nCOMMIT;',encoding:'utf8',maxBuffer:1<<30});
 if(r.status!==0)throw new Error(r.stderr.trim());
}
