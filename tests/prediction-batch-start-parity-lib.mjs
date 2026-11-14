// AIR-471: one deterministic set of batch_start scenarios, run unchanged against any tree that has tests/prediction-d1-flow-lib.mjs.
// `runParity()` returns {results, metrics}. `results` is normalized (ids, order, lanes, plans, hashes, response fields, queue and run state after, diagnostics);
// `metrics` are the offline counts, bytes and wall time of each start (they never decide parity). scripts/prediction-batch-start-diff.mjs runs this file in a
// baseline worktree and in the current tree; tests/prediction-batch-start-parity.mjs compares the current tree with the committed baseline result.
import {createHash} from 'node:crypto';
import {flowWorld,sql} from './prediction-d1-flow-lib.mjs';
import * as PredictionD1 from '../src/prediction-d1.js';

const batch=(w,body={})=>w.api('batch/start',{scope:'watchlist_all',mode:'queued',trigger:'scheduled',...body});
const reconcile=async w=>{await w.api('queue/reconcile',{});return w;};
const timing=w=>w.logs.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(l=>l?.event==='prediction_step_timing'&&l.step==='batch_start');
const setProfile=async(w,version)=>{const profile={version,profileHash:'p'+version,profile:{ratingScale:'Scale '+version}};w.records.set('enrichment/profile/versions/'+version+'.json',profile);await PredictionD1.saveMutable(w.env,'enrichment/profile/current.json',profile);};
const normalize=value=>JSON.parse(JSON.stringify(value)
 .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g,'<time>').replace(/\b1\d{12}\b/g,'"<ms>"').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,'<uuid>'));
const sha=text=>createHash('sha256').update(text).digest('hex');
const queueState=w=>{
 const rows=sql(w.file,'SELECT chunk_text AS c FROM prediction_queue ORDER BY seq');if(!rows.length)return null;
 const q=JSON.parse(rows.map(r=>r.c).join(''));
 return {pending:q.pending,hotPending:q.hotPending,coldPending:q.coldPending,priorityCount:q.priorityCount,coldRemaining:q.coldRemaining,retries:Object.keys(q.retries||{}).sort(),profileVersion:q.profileVersion};
};
const runState=w=>{
 const runs=sql(w.file,'SELECT document_json AS d FROM prediction_run ORDER BY run_id').map(r=>JSON.parse(r.d)).map(r=>({protocol:r.protocol,status:r.status,epoch:r.epoch,manifestHash:r.manifestHash,manifestBytes:r.manifestBytes,manifestSize:r.manifestSize,selectedIds:r.selectedIds,startResult:r.startResult,tasteProfileVersion:r.tasteProfileVersion})).sort((a,b)=>(a.epoch??0)-(b.epoch??0)||(a.manifestHash<b.manifestHash?-1:1));
 const lease=sql(w.file,"SELECT document_json AS d FROM prediction_lease WHERE name='runner'")[0];
 const diagnostics=[...w.records.keys()].filter(k=>k.startsWith('enrichment/run-diagnostics/')&&!k.endsWith('-settle.json')).map(k=>w.records.get(k)).map(d=>({state:d.state,startResult:d.startResult,stopReason:d.stopReason,trigger:d.trigger,steps:(d.steps||[]).map(s=>s.step)})).sort((a,b)=>JSON.stringify(a)<JSON.stringify(b)?-1:1);
 return {runs,lease:lease?(({epoch,expiresAt})=>({epoch,live:expiresAt>Date.now()}))(JSON.parse(lease.d)):null,diagnostics};
};
const view=data=>{
 if(!data||!Array.isArray(data.films))return data;
 const {films,profile,contract,...rest}=data;
 return {...rest,films:films.map(f=>({filmId:f.filmId,lane:f.lane,plan:f.plan,fingerprintHash:f.fingerprint?.fingerprintHash??null,metadataSha:sha(JSON.stringify(f.modelMetadata))})),profileHash:profile?.hash,profileSha:sha(JSON.stringify(profile)),contractSha:sha(JSON.stringify(contract))};
};
const results={},metrics={};
async function scenario(name,w,start){
 w.logs.length=0;const t0=Date.now(),r=await start();const wallMs=Date.now()-t0;
 const line=timing(w).at(-1);
 results[name]={status:r.status,body:normalize(view(r.data)),queue:queueState(w),state:runState(w)};
 metrics[name]=line?{r2:line.r2.n,d1:line.d1.n,statements:line.d1.statements,bytes:line.r2.bytesIn+line.r2.bytesOut,wallMs,manifestBytes:line.notes?.manifestBytes??null}:null;
 return r;
}
export async function runParity(){
 {const w=await reconcile(await flowWorld({films:40}));
  await scenario('clean5',w,()=>batch(w,{manifestSize:5}));
  await scenario('already_running',w,()=>batch(w,{manifestSize:5}));}
 {const w=await reconcile(await flowWorld({films:40}));
  await scenario('dry_run',w,()=>batch(w,{dryRun:true,manifestSize:5}));
  const ids=results.dry_run.body.films.map(f=>f.filmId);
  await scenario('dry_run_pin',w,()=>batch(w,{dryRun:true,manifestSize:5,pin:{filmIds:ids}}));
  await scenario('dry_run_pin_too_many',w,()=>batch(w,{dryRun:true,manifestSize:2,pin:{filmIds:ids}}));
  await scenario('invalid_size',w,()=>batch(w,{manifestSize:0}));}
 {const w=await reconcile(await flowWorld({films:130}));await scenario('size100',w,()=>batch(w,{manifestSize:100}));}
 {const w=await flowWorld({films:30});
  sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.shows',json('[]')) WHERE film_id IN ('tmdb_2','tmdb_4','tmdb_6','tmdb_8','tmdb_20')");
  await reconcile(w);await scenario('hot_cold',w,()=>batch(w,{manifestSize:10}));}
 {const w=await reconcile(await flowWorld({films:100}));await setProfile(w,2);await scenario('stale_profile',w,()=>batch(w,{manifestSize:5}));}
 {const w=await reconcile(await flowWorld({films:100}));
  const dry=await batch(w,{dryRun:true,manifestSize:5});const gone=dry.data.films.slice(0,3).map(f=>f.filmId);
  sql(w.file,"DELETE FROM discovery_admission WHERE film_id IN ("+gone.map(id=>"'"+id+"'").join(',')+")");
  await scenario('missing_admission_in_window',w,()=>batch(w,{manifestSize:5}));}
 {const w=await reconcile(await flowWorld({films:100}));
  const dry=await batch(w,{dryRun:true,manifestSize:100});const ids=dry.data.films.map(f=>f.filmId);
  sql(w.file,"DELETE FROM discovery_admission WHERE film_id IN ('"+ids[0]+"','"+ids[50]+"')");
  await scenario('missing_admission_far',w,()=>batch(w,{manifestSize:5}));}
 {const w=await flowWorld({films:100});
  sql(w.file,"UPDATE discovery_admission SET payload_json=json_set(payload_json,'$.synopsis','"+'x'.repeat(4000)+"')");
  await reconcile(w);await scenario('manifest_too_large',w,()=>batch(w));}
 {const w=await reconcile(await flowWorld({films:20}));
  const first=await batch(w,{manifestSize:5});
  const items=first.data.films.map(f=>({filmId:f.filmId,fingerprint:w.fingerprint,prediction:w.prediction}));
  await w.api('batch/submit',{runId:first.data.runId,epoch:first.data.lease.epoch,items});
  await w.api('complete',{runId:first.data.runId,reason:'manifest_spent'});
  await setProfile(w,2);await reconcile(w);
  await scenario('prediction_only',w,()=>batch(w,{manifestSize:20}));}
 return {results,metrics};
}
if(import.meta.url===new URL(process.argv[1],'file://').href)console.log(JSON.stringify(await runParity()));
