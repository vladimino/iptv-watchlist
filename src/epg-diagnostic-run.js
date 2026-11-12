// AIR-455 / ADR 0121. The owner-only EPG diagnostic canary: initiate / status / result / stop / cleanup, the durable receipt and the real Cloudflare Workflow
// that runs the REAL ledger seal (`stageSealedGeneration`, `planDiscoveryLedger`, segment writes, manifest and pointer CAS, fences, `EpgOrchestration.assertStep`)
// on the isolated diagnostic domain of AIR-453 from a replay dataset of AIR-454. INERT until the owner provisions the diagnostic resources (AIR-456): without the
// diagnostic bindings every route answers `diagnostic_bindings_absent`, no Workflow instance is ever created and nothing is written.
//
// Boundaries. The routes run on the Worker's own env; the diagnostic work runs ONLY on the allowlisted context of `EpgDiagnostic` (diagnostic D1 and bucket, no
// production binding). The production env is used for READS only, to refuse a launch while the production EPG is active (lease live, seal in progress,
// instance running, switch open). Receipts live in the diagnostic D1 (table `epg_diagnostic_receipt`, diagnostic-migrations/0002). Reads (preflight, status,
// result) never write; the guard counters prove it. Launch, stop and cleanup are writing actions, each behind its own confirmation string, and each needs
// its own operation-specific owner GO that no code can grant.
// Limits stated plainly: the 300 s lease is our application lease; CPU and memory of a Worker invocation are not exposed to Worker code (reported as null with the
// reason); the diagnostic D1 and bucket latency is not production latency (`canary-measured`, never `production-measured`); the diagnostic domain must be PREPARED
// (published generation and Discovery markers at the dataset's generation) by the provisioning procedure of AIR-456, otherwise a run refuses `domain_not_prepared`.
// Concatenated into the Worker like the other server modules: one global.
const EpgDiagnosticRun=(()=>{
 const TABLE='epg_diagnostic_receipt';
 const CONFIRM={launch:'LAUNCH_EPG_DIAGNOSTIC_CANARY',stop:'STOP_EPG_DIAGNOSTIC_CANARY',cleanup:'CLEANUP_EPG_DIAGNOSTIC_DOMAIN'};
 const LIMITS=Object.freeze({minBudgetMs:60000,maxBudgetMs:20*60000,defaultBudgetMs:15*60000,maxDepartures:8000,maxReturns:2000,preflightProduction:true});
 const KEY_RE=/^[A-Za-z0-9_-]{16,80}$/,DIGEST_RE=/^[0-9a-f]{64}$/,SEED_RE=/^[A-Za-z0-9 ._:-]{1,64}$/;
 const ACTIVE=['reserved','created','running','stopping'];
 const QUIESCENCE_MS=60000;
 const datasetKey=digest=>'diagnostic/replay/'+digest+'.json';
 const MATERIALIZED_KEY='diagnostic/runs/materialized.json';
 const iso=ms=>new Date(ms).toISOString();
 const reply=(status,body)=>({status,body});
 const refuse=(status,code,extra={})=>reply(status,{refused:code,...extra});
 const noteWrites=ctx=>{const s=ctx.stats();return s.d1.writes+s.d1.batches+s.r2.writes+s.r2.deletes;};
 const sha256=text=>EpgReplay.sha256(text);

 // ---- authorization ---------------------------------------------------------------------------------------------------------------
 // Owner-only access is Cloudflare Access at the edge (owner decision of 12 Nov 2026, ADR 0124): there is no second JWT validator, audience or e-mail check in the Worker. The
 // confirmation strings and the same-origin rule for POST are guards against accident, not authorization. While the diagnostic bindings are absent every route fails closed
 // (`diagnostic_bindings_absent`); that the real edge policy protects these routes is an AIR-456 provisioning acceptance check.
 // The production env as the gates see it: reads pass, every write is refused and counted, so `productionWrites` of a report is a measurement.
 function readOnlyEnv(env,counter){
  const refuseWrite=()=>{counter.attempts++;throw Object.assign(new Error('production_write_refused'),{code:'production_write_refused'});};
  const known=new WeakMap();
  const wrap=(inner,sql)=>{
   const write=EpgDiagnostic.isWrite(sql);
   const call=method=>(...args)=>{if(write)refuseWrite();return inner[method](...args);};
   const out={bind:(...values)=>wrap(inner.bind(...values),sql),run:call('run'),first:call('first'),all:call('all'),raw:call('raw')};
   known.set(out,{inner,write});return out;
  };
  const DB=env?.DB?{
   prepare:sql=>wrap(env.DB.prepare(sql),sql),
   batch:statements=>{const list=(statements||[]).map(item=>known.get(item));if(list.some(item=>!item||item.write))refuseWrite();return env.DB.batch(list.map(item=>item.inner));},
   exec:refuseWrite,
  }:env?.DB;
  const BUCKET=env?.BUCKET?{get:(...a)=>env.BUCKET.get(...a),head:(...a)=>env.BUCKET.head(...a),list:(...a)=>env.BUCKET.list(...a),put:refuseWrite,delete:refuseWrite,createMultipartUpload:refuseWrite,resumeMultipartUpload:refuseWrite}:env?.BUCKET;
  return {...env,DB,BUCKET};
 }

 // ---- configuration: strict, immutable, fingerprinted -------------------------------------------------------------
 function validateConfig(body){
  if(!body||typeof body!=='object'||Array.isArray(body))return {error:'Invalid request'};
  const allowed=['idempotencyKey','confirm','datasetDigest','seed','departures','returns','budgetMs'];
  for(const name of Object.keys(body))if(!allowed.includes(name))return {error:'Unknown field'};
  if(typeof body.idempotencyKey!=='string'||!KEY_RE.test(body.idempotencyKey))return {error:'Invalid idempotencyKey'};
  if(typeof body.datasetDigest!=='string'||!DIGEST_RE.test(body.datasetDigest))return {error:'Invalid datasetDigest'};
  if(typeof body.seed!=='string'||!SEED_RE.test(body.seed))return {error:'Invalid seed'};
  if(!Number.isInteger(body.departures)||body.departures<1||body.departures>LIMITS.maxDepartures)return {error:'Invalid departures'};
  const returns=body.returns===undefined?0:body.returns;
  if(!Number.isInteger(returns)||returns<0||returns>LIMITS.maxReturns)return {error:'Invalid returns'};
  const budgetMs=body.budgetMs===undefined?LIMITS.defaultBudgetMs:body.budgetMs;
  if(!Number.isInteger(budgetMs)||budgetMs<LIMITS.minBudgetMs||budgetMs>LIMITS.maxBudgetMs)return {error:'Invalid budgetMs'};
  return {config:{datasetDigest:body.datasetDigest,seed:body.seed,departures:body.departures,returns,budgetMs},idempotencyKey:body.idempotencyKey};
 }
 const fingerprintOf=config=>sha256(EpgReplay.canonical(config));
 const instanceIdOf=async key=>'epgdiag-'+(await sha256('epg-diagnostic|'+key)).slice(0,32);
 const runIdOf=async key=>(await sha256('epg-diagnostic-run|'+key)).slice(0,32);

 // ---- the diagnostic context ----------------------------------------------------------------------------------------
 async function openContext(env,{verify=true}={}){
  const resourceId=env?.EPG_DIAGNOSTIC_RESOURCE_ID;
  if(typeof resourceId!=='string'||!resourceId)return {refused:'diagnostic_bindings_absent'};
  const made=EpgDiagnostic.fromWorkerEnv(env,{resourceId,ledgerMode:'bounded'});
  if(!made.ok)return {refused:made.reason,field:made.field};
  if(verify){const verified=await made.verify();if(!verified.ok)return {refused:verified.reason,resource:verified.resource};}
  return {ctx:made};
 }
 // ---- the production env, READ ONLY ------------------------------------------------------------------------------
 async function productionGate(realEnv,now=Date.now(),measure={attempts:0}){
  const env=readOnlyEnv(realEnv,measure);
  try{
   const lease=await EpgOrchestration.readLease(env);
   if(lease.malformed)return 'production_state_unreadable';
   const held=lease.record;
   if(held&&held.released!==true&&Date.parse(held.expiresAt||'')+EpgOrchestration.BOUNDARY_MARGIN_MS>now)return 'production_step_live';
   const mode=await EpgOrchestration.readMode(env);
   if(mode.malformed)return 'production_state_unreadable';
   if(mode.schema&&mode.record?.mode==='switching')return 'production_mode_switching';
   const control=await EpgOrchestration.readControl(env);
   if(control.malformed)return 'production_state_unreadable';
   if(control.record&&!control.record.doneAt&&!control.record.quarantine&&['starting','running','waiting'].includes(control.record.phase))return 'production_epg_active';
   const run=await loadJSON(env,'sync.json');
   if(run?.stage==='seal')return 'production_seal_active';
   if(run&&['metadata','epg'].includes(run.stage)&&Number.isFinite(Date.parse(run.updatedAt||''))&&now-Date.parse(run.updatedAt)<15*60000)return 'production_sync_active';
   return null;
  }catch(error){return error?.code==='production_write_refused'?'production_write_attempted':'production_state_unreadable';}
 }

 // ---- receipts (diagnostic D1) -----------------------------------------------------------------------------------
 const COLUMNS='idempotency_key, fingerprint, instance_id, status, slot, config_json, report_json, failure, revision, created_at, updated_at';
 async function readReceipt(env,key){
  return env.DB.prepare('SELECT '+COLUMNS+' FROM '+TABLE+' WHERE idempotency_key=?').bind(key).first();
 }
 async function activeReceipt(env){
  return env.DB.prepare('SELECT '+COLUMNS+' FROM '+TABLE+' WHERE slot=1').bind().first();
 }
 const constraintOf=error=>{const m=String(error?.message||error);return /UNIQUE constraint failed: [\w.]*\.slot|epg_diagnostic_one_active/i.test(m)?'slot':/UNIQUE constraint failed|PRIMARY KEY/i.test(m)?'key':/CHECK constraint/i.test(m)?'check':'other';};
 // The reservation: one atomic INSERT. The key is the primary key and the slot is unique while active.
 async function reserve(env,{key,fingerprint,instanceId,config,now}){
  try{
   await env.DB.prepare('INSERT INTO '+TABLE+' (idempotency_key, fingerprint, instance_id, status, slot, config_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, 1, ?, ?)').bind(key,fingerprint,instanceId,'reserved',JSON.stringify(config),iso(now),iso(now)).run();
   return {reserved:true};
  }catch(error){return {reserved:false,constraint:constraintOf(error)};}
 }
 // One conditional transition, judged by reading it back (revision moves by one, status is the target).
 async function transition(env,key,revision,from,to,{report=null,failure=null,now=Date.now()}={}){
  const active=ACTIVE.includes(to);
  await env.DB.prepare('UPDATE '+TABLE+' SET status=?, slot=?, report_json=COALESCE(?, report_json), failure=COALESCE(?, failure), revision=revision+1, updated_at=? WHERE idempotency_key=? AND revision=? AND status IN ('+from.map(()=>'?').join(',')+')').bind(to,active?1:null,report?JSON.stringify(report):null,failure,iso(now),key,revision,...from).run();
  const row=await readReceipt(env,key);
  return !!row&&row.status===to&&Number(row.revision)===revision+1;
 }
 const publicReceipt=row=>row?{idempotencyKey:row.idempotency_key,status:row.status,instanceId:row.instance_id,fingerprint:row.fingerprint,revision:Number(row.revision),createdAt:row.created_at,updatedAt:row.updated_at,failure:row.failure||null}:null;
 async function instanceStatus(binding,id){
  if(!binding||typeof binding.get!=='function')return 'unknown';
  try{
   const instance=await binding.get(id);
   const status=typeof instance?.status==='function'?await instance.status():instance?.status;
   const name=typeof status==='string'?status:status?.status;
   return typeof name==='string'?name:'unknown';
  }catch(error){return /not[ _.]found|does not exist|unknown instance/i.test(String(error?.message||''))?'absent':'unknown';}
 }
 const createError=error=>/already exists|already_exists|duplicate/i.test(String(error?.name||'')+' '+String(error?.message||''))?'exists':'uncertain';

 // ---- the dataset of a run -------------------------------------------------------------------------------------------
 async function loadDataset(env,digest){
  const object=await env.BUCKET.get(datasetKey(digest));
  if(!object)return {refused:'dataset_missing'};
  let dataset;try{dataset=JSON.parse(await object.text());}catch{return {refused:'dataset_malformed'};}
  const checked=await EpgReplay.verifyDataset(dataset,{expectedDigest:digest});
  if(!checked.ok)return {refused:'dataset_invalid',problems:checked.problems};
  return {dataset};
 }
 const helpers=()=>({segmentOf:ledgerArchiveSegment,candidateKey:discoveryCandidateKey});
 async function planOf(dataset,config){
  return EpgReplay.planMutation(dataset,{seed:config.seed,departures:config.departures,returns:config.returns},helpers());
 }

 // ---- preflight, status, result: reads only ------------------------------------------------------------------------
 async function preflight(env,{datasetDigest=null}={}){
  const opened=await openContext(env);
  const production=await productionGate(env);
  if(opened.refused)return reply(200,{ready:false,refused:opened.refused,production:production||'idle',sideEffects:'none'});
  const ctx=opened.ctx,checks={identity:'verified',workflow:typeof env.EPG_DIAGNOSTIC_WORKFLOW?.create==='function'?'bound':'absent'};
  let receiptsReady=true,active=null;
  try{active=await activeReceipt(ctx.env);}catch{receiptsReady=false;}
  checks.receipts=receiptsReady?'ready':'absent';
  checks.activeCanary=active?active.idempotency_key:null;
  if(datasetDigest){
   if(!DIGEST_RE.test(String(datasetDigest)))return reply(400,{error:'Invalid datasetDigest'});
   const loaded=await loadDataset(ctx.env,datasetDigest);
   checks.dataset=loaded.refused||'verified';
  }
  const ready=checks.workflow==='bound'&&receiptsReady&&!active&&!production&&(!datasetDigest||checks.dataset==='verified');
  return reply(200,{ready,datasetChecked:!!datasetDigest,production:production||'idle',checks,sideEffects:'none',writes:noteWrites(ctx)});
 }
 async function status(env,key){
  if(typeof key!=='string'||!KEY_RE.test(key))return reply(400,{error:'Invalid key'});
  const opened=await openContext(env);
  if(opened.refused)return refuse(503,opened.refused);
  const ctx=opened.ctx;
  let row;try{row=await readReceipt(ctx.env,key);}catch{return refuse(503,'receipts_unavailable');}
  if(!row)return reply(404,{error:'Unknown key'});
  const live=await instanceStatus(env.EPG_DIAGNOSTIC_WORKFLOW,row.instance_id);
  // Reconciliation is reported, never performed by a read: a receipt that says `reserved` while no instance exists is an unknown create outcome that only a repeated launch with the same key and parameters (or a stop) resolves.
  const hint=row.status==='reserved'?(live==='absent'?'repeat_launch_to_create':live==='unknown'?'instance_status_unknown':'repeat_launch_to_record'):ACTIVE.includes(row.status)&&['complete','errored','terminated'].includes(live)?'instance_ended_before_receipt':null;
  return reply(200,{receipt:publicReceipt(row),instance:live,reconcile:hint,sideEffects:'none',writes:noteWrites(ctx)});
 }
 async function result(env,key){
  if(typeof key!=='string'||!KEY_RE.test(key))return reply(400,{error:'Invalid key'});
  const opened=await openContext(env);
  if(opened.refused)return refuse(503,opened.refused);
  let row;try{row=await readReceipt(opened.ctx.env,key);}catch{return refuse(503,'receipts_unavailable');}
  if(!row)return reply(404,{error:'Unknown key'});
  if(row.status==='complete'||row.status==='failed'||row.status==='stopped'){
   let report=null;try{report=row.report_json?JSON.parse(row.report_json):null;}catch{report=null;}
   return reply(200,{receipt:publicReceipt(row),report,sideEffects:'none'});
  }
  return reply(202,{receipt:publicReceipt(row),report:null,sideEffects:'none'});
 }

 // ---- launch: a writing action -----------------------------------------------------------------------------------
 async function launch(env,body){
  const parsed=validateConfig(body);
  if(parsed.error)return reply(400,{error:parsed.error});
  if(body.confirm!==CONFIRM.launch)return refuse(400,'confirmation_required');
  const key=parsed.idempotencyKey,config=parsed.config;
  const opened=await openContext(env);
  if(opened.refused)return refuse(503,opened.refused,opened.field?{field:opened.field}:{});
  const ctx=opened.ctx;
  if(typeof env.EPG_DIAGNOSTIC_WORKFLOW?.create!=='function')return refuse(503,'workflow_unbound');
  const fingerprint=await fingerprintOf(config),instanceId=await instanceIdOf(key),now=Date.now();
  // A repeat of a known key is resolved first: the same parameters give the same run, other parameters fail, and nothing else is checked.
  let existing;try{existing=await readReceipt(ctx.env,key);}catch{return refuse(503,'receipts_unavailable');}
  if(existing){
   if(existing.fingerprint!==fingerprint)return refuse(409,'idempotency_conflict');
   // A reservation that is resumed (its create outcome was unknown) may create or attach an instance: the production EPG must be idle NOW.
   if(existing.status==='reserved'){const busy=await productionGate(env,now);if(busy)return refuse(409,busy,{receipt:publicReceipt(existing)});}
   return reconcile(env,ctx,existing);
  }
  const production=await productionGate(env,now);
  if(production)return refuse(409,production);
  // The configuration must be executable before anything is reserved: the dataset verifies and the plan derives.
  const loaded=await loadDataset(ctx.env,config.datasetDigest);
  if(loaded.refused)return refuse(409,loaded.refused,loaded.problems?{problems:loaded.problems}:{});
  try{await planOf(loaded.dataset,config);}catch(error){return refuse(400,error.reason?'plan_'+error.reason:'plan_invalid');}
  const taken=await reserve(ctx.env,{key,fingerprint,instanceId,config,now});
  if(!taken.reserved){
   if(taken.constraint==='slot')return refuse(409,'canary_active');
   if(taken.constraint==='key'){const again=await readReceipt(ctx.env,key);if(again&&again.fingerprint===fingerprint){const busy=again.status==='reserved'?await productionGate(env,now):null;if(busy)return refuse(409,busy);return reconcile(env,ctx,again);}return refuse(409,'idempotency_conflict');}
   return refuse(503,'reservation_failed');
  }
  return reconcile(env,ctx,await readReceipt(ctx.env,key));
 }
 // Drives a receipt towards `created` without ever creating a second instance: the instance id is deterministic, an existing instance is attached to, an unknown create outcome is left as it is.
 async function reconcile(env,ctx,row){
  if(row.status!=='reserved')return reply(200,{receipt:publicReceipt(row),reconciled:false,note:'already_'+row.status});
  const binding=env.EPG_DIAGNOSTIC_WORKFLOW;
  const known=await instanceStatus(binding,row.instance_id);
  let created=false,attached=false;
  if(['queued','running','waiting','paused','complete'].includes(known)){attached=true;created=true;}
  else if(known==='unknown')return reply(202,{receipt:publicReceipt(row),outcome:'unknown',note:'instance_status_unknown_no_retry'});
  else if(['errored','terminated'].includes(known))return refuse(409,'instance_ended_unrecorded',{receipt:publicReceipt(row)});
  if(!created){
   try{await binding.create({id:row.instance_id,params:{idempotencyKey:row.idempotency_key}});created=true;}
   catch(error){
    if(createError(error)==='exists'){created=true;attached=true;}
    else{
     const after=await instanceStatus(binding,row.instance_id);
     if(['queued','running','waiting','paused','complete'].includes(after)){created=true;attached=true;}
     else return reply(202,{receipt:publicReceipt(row),outcome:'unknown',note:'create_outcome_unknown_no_blind_retry'});
    }
   }
  }
  let recorded=false;
  try{recorded=await transition(ctx.env,row.idempotency_key,Number(row.revision),['reserved'],'created');}catch{recorded=false;}
  const fresh=await readReceipt(ctx.env,row.idempotency_key);
  return reply(recorded||fresh?.status!=='reserved'?200:202,{receipt:publicReceipt(fresh),created:true,attached,recorded:fresh?.status!=='reserved'});
 }

 // ---- stop and cleanup: writing actions --------------------------------------------------------------------------------
 // Stop keeps the domain FENCED until the former run is quiet. The receipt moves to `stopping` first (the slot stays taken, so no launch and no cleanup), the diagnostic step lease is
 // invalidated (a seal that is still writing loses it at its next fence and ends), the instance is terminated, and only when the instance has ended, the lease is quiet and a
 // quiescence interval has passed is the receipt `stopped` and the slot freed. Anything uncertain leaves it `stopping` (202): the owner repeats the same stop.
 async function leaseQuiet(ctxEnv,now){
  const lease=await EpgOrchestration.readLease(ctxEnv);
  if(lease.malformed)return false;
  const record=lease.record;
  return !record||record.released===true||Date.parse(record.expiresAt||'')+EpgOrchestration.BOUNDARY_MARGIN_MS<now;
 }
 async function stop(env,body,{now=()=>Date.now()}={}){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(name=>!['idempotencyKey','confirm'].includes(name)))return reply(400,{error:'Invalid request'});
  if(typeof body.idempotencyKey!=='string'||!KEY_RE.test(body.idempotencyKey))return reply(400,{error:'Invalid idempotencyKey'});
  if(body.confirm!==CONFIRM.stop)return refuse(400,'confirmation_required');
  const opened=await openContext(env);
  if(opened.refused)return refuse(503,opened.refused);
  const ctx=opened.ctx;
  let row;try{row=await readReceipt(ctx.env,body.idempotencyKey);}catch{return refuse(503,'receipts_unavailable');}
  if(!row)return reply(404,{error:'Unknown key'});
  if(!ACTIVE.includes(row.status))return reply(200,{receipt:publicReceipt(row),stopped:false,note:'not_active'});
  if(row.status!=='stopping'){
   if(!await transition(ctx.env,row.idempotency_key,Number(row.revision),['reserved','created','running'],'stopping',{failure:'stopped_by_owner',now:now()}))return refuse(409,'write_conflict');
   try{await ctx.env.DB.prepare("UPDATE "+EpgOrchestration.TABLE+" SET body=json_set(body,'$.holder','stopped-by-owner','$.expiresAt',?), revision=revision+1 WHERE key='lease'").bind(iso(now())).run();}catch{return reply(202,{receipt:publicReceipt(await readReceipt(ctx.env,row.idempotency_key)),stopped:false,note:'lease_invalidation_unconfirmed_repeat_stop'});}
   row=await readReceipt(ctx.env,row.idempotency_key);
  }
  let terminated='not_needed';
  const binding=env.EPG_DIAGNOSTIC_WORKFLOW;
  if(binding&&typeof binding.get==='function'){
   try{const instance=await binding.get(row.instance_id);if(typeof instance?.terminate==='function'){await instance.terminate();terminated='terminated';}}
   catch(error){terminated=/not[ _.]found|does not exist/i.test(String(error?.message||''))?'absent':'terminate_failed';}
  }
  const live=await instanceStatus(binding,row.instance_id);
  const ended=['terminated','complete','errored','absent'].includes(live);
  let quiet=false;try{quiet=await leaseQuiet(ctx.env,now());}catch{quiet=false;}
  const waitedMs=now()-Date.parse(row.updated_at);
  const quiescence={instance:live,terminate:terminated,leaseQuiet:quiet,waitedMs,requiredMs:QUIESCENCE_MS};
  if(!(ended&&quiet&&waitedMs>=QUIESCENCE_MS))return reply(202,{receipt:publicReceipt(row),stopped:false,note:'quiescence_unconfirmed_repeat_stop',quiescence});
  const done=await transition(ctx.env,row.idempotency_key,Number(row.revision),['stopping'],'stopped',{now:now()});
  return done?reply(200,{receipt:publicReceipt(await readReceipt(ctx.env,row.idempotency_key)),stopped:true,quiescence}):refuse(409,'write_conflict');
 }
 // Cleanup empties the baseline the runs materialize (objects under `epg/` and the run document) of the DIAGNOSTIC bucket, never the identity, the datasets or the receipts.
 async function cleanup(env,body){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(name=>name!=='confirm'))return reply(400,{error:'Invalid request'});
  if(body.confirm!==CONFIRM.cleanup)return refuse(400,'confirmation_required');
  const opened=await openContext(env);
  if(opened.refused)return refuse(503,opened.refused);
  const ctx=opened.ctx;
  let active;try{active=await activeReceipt(ctx.env);}catch{return refuse(503,'receipts_unavailable');}
  if(active)return refuse(409,'canary_active',{idempotencyKey:active.idempotency_key});
  let removed=0;
  const BUCKET=ctx.env.BUCKET;
  for(const prefix of ['epg/','sync.json',MATERIALIZED_KEY]){
   let cursor;
   for(let page=0;page<50;page++){
    const listed=await ctx.env.BUCKET.list({prefix,limit:500,...(cursor?{cursor}:{})});
    for(const object of listed.objects||[]){await BUCKET.delete(object.key);removed++;}
    if(!listed.truncated)break;cursor=listed.cursor;
   }
  }
  return reply(200,{cleaned:true,removed});
 }

 // ---- the Workflow instance ---------------------------------------------------------------------------------------------
 // Writes the baseline of the dataset into the diagnostic bucket at the keys the real planner reads: the generation ledger, the archive (segments at their own
 // keys, manifest, pointer) and the EPG generation pointer. Idempotent by a marker written last; another dataset's baseline is never overwritten.
 async function materialize(ctxEnv,dataset){
  // Nothing is written to a domain whose Discovery authority is not d1/open: the replay would not be the production path (fail closed on a missing module or a read error).
  if(typeof DiscoveryAuthority==='undefined')return {refused:'diagnostic_module_unavailable'};
  let gate;try{gate=await DiscoveryAuthority.readAuthority(ctxEnv);}catch{return {refused:'domain_not_prepared'};}
  if(gate.ready!==true)return {refused:'domain_not_prepared'};
  const marker=await ctxEnv.BUCKET.get(MATERIALIZED_KEY);
  // A baseline that a run has already sealed on is consumed: the archive has moved on, so a second run on it would not compare with the dataset. The owner's cleanup resets it.
  if(marker){const body=JSON.parse(await marker.text());return body.datasetDigest===dataset.digest&&!body.consumedBy?{reused:true}:{refused:'domain_not_clean'};}
  const listed=await ctxEnv.BUCKET.list({prefix:'epg/',limit:1});
  if((listed.objects||[]).length)return {refused:'domain_not_clean'};
  const BUCKET=ctxEnv.BUCKET,id=dataset.source.programmeRunId,json={httpMetadata:{contentType:'application/json'}},put=(key,text)=>BUCKET.put(key,text,json);
  const archive=dataset.baseline.archive;
  if(archive){
   for(const segment of archive.segments)if(segment.object)await put(segment.object,segment.text);
   await put(EpgReplay.MANIFEST_KEY(archive.manifestId),JSON.stringify(archive.manifest));
   await put('epg/discovery-archive/v1/current.json',JSON.stringify({manifestId:archive.manifestId}));
  }
  await put('epg/generations/'+id+'/discovery-latest.json',JSON.stringify({...dataset.baseline.generation,items:dataset.baseline.items}));
  await put(EPG_GENERATION_KEY,JSON.stringify({phase:'published',programmeRunId:id}));
  // With the Discovery authority of the diagnostic domain in D1, the ledger of the generation is loaded the way a handoff loads it, by the real writer, so that the Discovery lease
  // and its fences work on the same generation as in production. Marker last.
  {
   const taken=await DiscoveryAuthority.acquireLease(ctxEnv,{programmeRunId:null});
   if(!taken.lease)return {refused:'discovery_lease_unavailable'};
   ctxEnv.discoveryLease=taken.lease;
   try{await DiscoveryAuthority.ingestLedger(ctxEnv,{programmeRunId:id,handoff:true,lease:taken.lease,items:(async function*(){for(const item of dataset.baseline.items)yield item;})()});}
   finally{await DiscoveryAuthority.releaseLease(ctxEnv,taken.lease);ctxEnv.discoveryLease=null;}
  }
  await put(MATERIALIZED_KEY,JSON.stringify({datasetDigest:dataset.digest,programmeRunId:id}));
  return {written:true};
 }
 // The published generation the fences compare against: from the D1 authority when it is the diagnostic domain's, otherwise the R2 pointer.
 async function publicationOf(ctxEnv,dataset){
  const id=dataset.source.programmeRunId;
  if(typeof PublishedEpg!=='undefined'){
   const live=await PublishedEpg.currentGeneration(ctxEnv);
   if(live){if(live.programmeRunId!==id)return {refused:'domain_not_prepared'};return {publication:{programmeRunId:id,phase:'published',fence:live.fence}};}
  }
  const pointer=await ctxEnv.BUCKET.get(EPG_GENERATION_KEY);
  if(!pointer?.etag)return {refused:'domain_not_prepared'};
  return {publication:{programmeRunId:id,phase:'published',fence:pointer.etag}};
 }
 async function readActual(ctxEnv,before){
  const pointer=await ctxEnv.BUCKET.get('epg/discovery-archive/v1/current.json');
  const manifestId=pointer?(await pointer.json())?.manifestId||null:null;
  if(!manifestId)return {manifestId:null,upsertedKeys:[],segmentsRewritten:[]};
  const manifest=await (await ctxEnv.BUCKET.get(EpgReplay.MANIFEST_KEY(manifestId))).json();
  const rewritten=manifest.segments.map((entry,index)=>(entry.object||null)!==(before[index]||null)?index:-1).filter(index=>index>=0);
  return {manifestId,upsertedKeys:manifest.upsertedKeys||[],segmentsRewritten:rewritten,moved:manifestId!==before.manifestId};
 }
 // The real seal on the diagnostic domain. Returns a plain outcome; never throws.
 async function sealRun(env,key,config,{now=()=>Date.now()}={}){
  const opened=await openContext(env);
  if(opened.refused)return {failure:{code:opened.refused}};
  const ctx=opened.ctx,started=now(),before=ctx.stats(),BUCKET=ctx.env.BUCKET,measure={attempts:0};
  let step=null,phases=[],runId=await runIdOf(key);
  try{
   // The production EPG must be idle at the moment the run actually starts, not only when it was launched (read only, fail closed).
   const busy=await productionGate(env,now(),measure);
   if(busy)return {failure:{code:busy}};
   const loaded=await loadDataset(ctx.env,config.datasetDigest);
   if(loaded.refused)return {failure:{code:loaded.refused}};
   const dataset=loaded.dataset,plan=await planOf(dataset,config);
   // The Discovery authority is checked inside `materialize`, before the first write (the ledger of production is D1-owned; the legacy R2 path would measure nothing about production).
   const materialized=await materialize(ctx.env,dataset);
   if(materialized.refused)return {failure:{code:materialized.refused}};
   const published=await publicationOf(ctx.env,dataset);
   if(published.refused)return {failure:{code:published.refused}};
   // The run claims the baseline before its first seal mutation.
   await BUCKET.put(MATERIALIZED_KEY,JSON.stringify({datasetDigest:dataset.digest,programmeRunId:dataset.source.programmeRunId,consumedBy:runId}),{httpMetadata:{contentType:'application/json'}});
   const scan=await EpgReplay.replayScan(dataset,plan,helpers());
   const publishedMark=async()=>{const now2=await publicationOf(ctx.env,dataset);return JSON.stringify(now2.publication?now2.publication.fence:now2.refused||null);};
   const publishedBefore=await publishedMark();
   const archivePointer=await ctx.env.BUCKET.get('epg/discovery-archive/v1/current.json');
   const manifestBefore=archivePointer?(await (await ctx.env.BUCKET.get(EpgReplay.MANIFEST_KEY((await archivePointer.json()).manifestId))).json()):null;
   const segmentsBefore=Object.assign((manifestBefore?.segments||[]).map(entry=>entry.object||null),{manifestId:manifestBefore?.manifestId||null});
   // The step lease of the diagnostic domain, taken before the first mutation of the seal and kept by its boundaries.
   const taken=await EpgOrchestration.acquireStep(ctx.env,{kind:'executor',modeRevision:null,now:now()});
   if(!taken.step)return {failure:{code:taken.busy?'step_lease_held':taken.reason||'step_lease_unavailable'}};
   step=taken.step;ctx.env.epgStep=step;
   // The budget is enforced by the real step guard at every mutation boundary of the seal (`assertStep` refuses past the deadline), not only reported afterwards.
   ctx.env.epgDeadline=started+config.budgetMs;
   const leaseBefore=await EpgOrchestration.readLease(ctx.env);
   const at=iso(now()),run={runId,stage:'epg',startedAt:at,updatedAt:at,watchlist:[],events:[]};
   await BUCKET.put('sync.json',JSON.stringify(run),{httpMetadata:{contentType:'application/json'}});
   ctx.setLedgerMode('bounded');
   EPG_PHASE_SINKS.set(runId,event=>{phases.push(event);});
   const sealStarted=now();
   try{
    await stageSealedGeneration(ctx.env,run,{holder:{discovery:scan},meta:{programmeRunId:runId,updatedAt:at},pending:{'programme.json':{runId,updatedAt:at},'discovered-films.json':{}},nextWatchlist:{updatedAt:at,films:[]},uncertain:[],publication:published.publication});
   }finally{EPG_PHASE_SINKS.delete(runId);}
   const sealMs=now()-sealStarted;
   const leaseAfter=await EpgOrchestration.readLease(ctx.env);
   const actual=await readActual(ctx.env,segmentsBefore);
   const after=ctx.stats(),diff=(a,b)=>Object.fromEntries(Object.keys(a).map(name=>[name,typeof a[name]==='object'?diff(a[name],b[name]):a[name]-b[name]]));
   const phase=name=>{const exit=phases.filter(event=>event.phase===name&&event.edge==='exit').pop();if(!exit)return null;const {event,runId:rid,phase:p,edge,at:when,...fields}=exit;void event;void rid;void p;void edge;void when;return fields;};
   const errored=phases.filter(event=>event.edge==='error').map(({phase:p,reason})=>({phase:p,reason:reason||null}));
   const expected={departures:plan.departureCount,segmentsRewritten:plan.archive.segmentsRewritten};
   const publishedAfter=await publishedMark();
   const report={
    schemaVersion:1,label:'canary-measured',published:publishedAfter!==publishedBefore,productionWrites:measure.attempts,
    dataset:{digest:dataset.digest,programmeRunId:dataset.source.programmeRunId,builtAt:dataset.builtAt,fidelity:dataset.fidelity,items:dataset.counts.items,archivedItems:dataset.counts.archivedItems},
    plan:{seed:plan.seed,departures:plan.departureCount,returns:plan.returnCount,segmentsRewritten:plan.archive.segmentsRewritten,upsertedKeysDigest:plan.archive.upsertedKeysDigest,digest:plan.digest},
    runId,phases:{seal_stage_plan:phase('seal_stage_plan'),seal_stage_archive:phase('seal_stage_archive'),seal_stage_emit:phase('seal_stage_emit')},
    wall:{totalMs:now()-started,sealStageMs:sealMs},
    storage:diff(after,before),
    lease:{holderKept:leaseAfter.record?.holder===step.holder,renewals:Number(leaseAfter.revision)-Number(leaseBefore.revision),leaseMs:EpgOrchestration.LEASE_MS},
    retries:0,failures:errored,
    cpuMs:null,memory:null,cpuMemoryNote:'not exposed to Worker code',
    expectedVsActual:{expected,actual:{departures:actual.upsertedKeys.length,segmentsRewritten:actual.segmentsRewritten},departuresMatch:JSON.stringify(actual.upsertedKeys)===JSON.stringify(plan.departures),segmentsMatch:JSON.stringify(actual.segmentsRewritten)===JSON.stringify(plan.archive.segmentsRewritten)},
    invariants:{published:publishedAfter!==publishedBefore,productionWrites:measure.attempts,deniedAccesses:after.denied,refusedWrites:after.refusedWrites,identityVerified:ctx.verified(),archivePointerMoved:actual.moved===true,productionBindingsExposed:false},
    withinBudget:now()-started<=config.budgetMs,
    limits:['canary-measured: diagnostic D1 and bucket latency, not production latency','application-enforced isolation, not platform isolation (ADR 0121)','a passing canary is not AIR-444 acceptance'],
   };
   const violations=[];
   if(!report.withinBudget)violations.push('budget_exceeded');
   if(!report.expectedVsActual.departuresMatch)violations.push('departures_mismatch');
   if(!report.expectedVsActual.segmentsMatch)violations.push('segments_mismatch');
   if(plan.departureCount>0&&!report.invariants.archivePointerMoved)violations.push('archive_pointer_not_moved');
   if(report.invariants.deniedAccesses>0)violations.push('denied_accesses');
   if(report.invariants.refusedWrites>0)violations.push('refused_writes');
   if(errored.length)violations.push('phase_error');
   if(!report.lease.holderKept)violations.push('lease_not_kept');
   if(report.published)violations.push('published_generation_moved');
   if(report.productionWrites>0)violations.push('production_write_attempted');
   report.outcome={ok:violations.length===0,violations};
   return {report};
  }catch(error){
   if(error?.code==='epg_step_budget')return {failure:{code:'budget_exceeded'},phases};
   return {failure:{code:EpgOrchestration.classifyThrown(error)==='step_failed'&&error?.reason?String(error.reason):EpgOrchestration.classifyThrown(error)},phases};
  }finally{
   if(step)await EpgOrchestration.endStep(ctx.env,step).catch(()=>false);
   if(ctx.env.epgStep)delete ctx.env.epgStep;
   if(Number.isFinite(ctx.env.epgDeadline))delete ctx.env.epgDeadline;
  }
 }
 // The Workflow body. Every step returns a plain outcome and none throws, so the Workflow engine never retries a step that may have written.
 async function run(env,payload,step,hooks={}){
  const key=payload?.idempotencyKey;
  if(typeof key!=='string'||!KEY_RE.test(key))return {stopped:true,reason:'invalid_payload'};
  const opened=await openContext(env);
  if(opened.refused)return {stopped:true,reason:opened.refused};
  const ctx=opened.ctx,now=hooks.now||(()=>Date.now());
  // begin: the receipt must exist and be created; it becomes running (a stopped or finished receipt ends the instance here).
  const begun=await step.do('begin',async()=>{
   try{
    const row=await readReceipt(ctx.env,key);
    if(!row)return {ok:false,code:'receipt_missing'};
    if(row.status==='running')return {ok:true,config:JSON.parse(row.config_json),resumed:true};
    if(row.status!=='created'&&row.status!=='reserved')return {ok:false,code:'receipt_'+row.status};
    // Production must be idle when the instance actually starts: a busy production ends this run as failed (the owner launches again later); it is never raced.
    const busy=await productionGate(env,now());
    if(busy){await transition(ctx.env,key,Number(row.revision),['reserved','created'],'failed',{failure:busy,now:now()});return {ok:false,code:busy};}
    if(!await transition(ctx.env,key,Number(row.revision),['reserved','created'],'running',{now:now()}))return {ok:false,code:'write_conflict'};
    return {ok:true,config:JSON.parse(row.config_json)};
   }catch{return {ok:false,code:'receipts_unavailable'};}
  });
  if(!begun.ok)return {stopped:true,reason:begun.code};
  const sealed=await step.do('seal',async()=>{try{return await sealRun(env,key,begun.config,{now});}catch(error){return {failure:{code:'step_failed'}};}});
  const finished=await step.do('finish',async()=>{
   try{
    const row=await readReceipt(ctx.env,key);
    if(!row)return {recorded:false,code:'receipt_missing'};
    if(row.status!=='running')return {recorded:false,code:'receipt_'+row.status};
    // `complete` only when the measured postconditions hold; a finished run that violated one is a failed receipt that still carries its full report.
    const ok=sealed.report?.outcome?.ok===true;
    const done=ok?await transition(ctx.env,key,Number(row.revision),['running'],'complete',{report:sealed.report,now:now()}):sealed.report?await transition(ctx.env,key,Number(row.revision),['running'],'failed',{failure:('postcondition_failed:'+(sealed.report.outcome?.violations||[]).join(',')).slice(0,80),report:sealed.report,now:now()}):await transition(ctx.env,key,Number(row.revision),['running'],'failed',{failure:String(sealed.failure?.code||'step_failed').slice(0,80),report:{schemaVersion:1,label:'canary-measured',published:false,productionWrites:0,failure:sealed.failure,partial:true},now:now()});
    return {recorded:done};
   }catch{return {recorded:false,code:'receipts_unavailable'};}
  });
  return {stopped:true,reason:sealed.report?(sealed.report.outcome?.ok===true?'complete':'postcondition_failed'):String(sealed.failure?.code||'failed'),recorded:finished.recorded===true};
 }

 // ---- the routes (the Worker's dispatcher calls this for `/api/epg/diagnostic/…`) -----------------------------------------------
 async function route(request,env,url){
  const name=url.pathname.slice('/api/epg/diagnostic/'.length);
  const respond=result=>new Response(JSON.stringify(result.body),{status:result.status,headers:{'content-type':'application/json'}});
  const read=async()=>{try{return await request.json();}catch{return undefined;}};
  if(request.method==='GET'){
   if(name==='preflight')return respond(await preflight(env,{datasetDigest:url.searchParams.get('dataset')}));
   if(name==='status')return respond(await status(env,url.searchParams.get('key')));
   if(name==='result')return respond(await result(env,url.searchParams.get('key')));
   return respond(['launch','stop','cleanup'].includes(name)?reply(405,{error:'Method not allowed'}):reply(404,{error:'Not found'}));
  }
  if(request.method==='POST'&&['launch','stop','cleanup'].includes(name)){
   const body=await read();
   if(body===undefined)return respond(reply(400,{error:'Invalid JSON'}));
   const action=name==='launch'?launch:name==='stop'?stop:cleanup;
   return respond(await action(env,body));
  }
  return respond(reply(405,{error:'Method not allowed'}));
 }
 return {TABLE,CONFIRM,LIMITS,ACTIVE,datasetKey,MATERIALIZED_KEY,validateConfig,fingerprintOf,instanceIdOf,runIdOf,preflight,status,result,launch,stop,cleanup,run,route,productionGate,materialize,sealRun};
})();
async function runEpgDiagnosticWorkflow(env,payload,step){return EpgDiagnosticRun.run(env,payload,step);}
