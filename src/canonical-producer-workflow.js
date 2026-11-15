// AIR-497 / ADR 0141. Bounded Producer Workflow chain. Dormant unless the Film/Person marker is d1/open
// AND env.PRODUCER_WORKFLOW exists. Launched ONLY from hourly reconcileProducerChain. No new cron, flag or Task.
import {failed,readAuthority} from './film-person-authority.js';
import {readDocument,readMembers,readAuthority as readPublished} from './published-epg.js';
import {runEpgProducerPass,retryEpgProducerResults,readCanonicalFreshness} from './canonical-producer-driver.js';
import {reconcileEpgRun} from './canonical-epg-person-producer.js';
import {
 CHAIN_BOUNDARY_MARGIN_MS,CHAIN_CREATE_ATTEMPTS,CHAIN_FLOOR_D1_CALLS,CHAIN_FLOOR_D1_STATEMENTS,CHAIN_LEASE_MS,
 CHAIN_MAX_SLICES,CHAIN_QUIET_MS,CHAIN_REBASE_CAP,CHAIN_SLICE_DEADLINE_MS,CHAIN_SLICE_SIZE,successorDecision,
 snapshotLabel,generationOrder,producerInstanceId,requireFence,
} from './canonical-producer-fence.js';
import {
 claimChain,handoffChain,launchChain,listNonterminalChains,readChain,rebaseChain,recoverChain,relaunchChain,
 reopenChain,stopChain,supersedeChain,takeoverChain,yieldChain,
} from './canonical-producer-chain.js';
import {epgRunForGeneration} from './canonical-producer-store.js';

const iso=ms=>new Date(ms).toISOString();
function meterD1(db,meter){
 if(!db||typeof db.prepare!=='function')return db;
 return new Proxy(db,{get(target,prop){
  if(prop==='prepare')return sql=>{meter.statements++;meter.calls++;return target.prepare(sql);};
  if(prop==='batch')return statements=>{meter.batches++;meter.calls++;return target.batch(statements);};
  const value=Reflect.get(target,prop,target);
  return typeof value==='function'?value.bind(target):value;
 }});
}
function meteredEnv(env,meter){
 if(!env?.DB)return env;
 return new Proxy(env,{get(target,prop){return prop==='DB'?meterD1(target.DB,meter):Reflect.get(target,prop,target);}});
}
function createError(error){
 const text=String(error?.message||error||'');
 if(/already exists|duplicate/i.test(text))return 'exists';
 return 'uncertain';
}

export async function acquireSealedSnapshot(env,programmeRunId){
 const before=await readPublished(env);
 if(!before?.ready||before.programmeRunId!==programmeRunId)return {ok:false,code:'producer_generation_superseded'};
 const g0=Number(before.generation);
 const programme=await readDocument(env,programmeRunId,'programme');
 const watchlist=await readDocument(env,programmeRunId,'watchlist');
 const members=await readMembers(env,programmeRunId,'watchlist');
 const after=await readPublished(env);
 if(!after?.ready||after.programmeRunId!==programmeRunId||Number(after.generation)!==g0)return {ok:false,code:'producer_input_superseded'};
 const films=(Array.isArray(programme?.films)?programme.films:[]).map(film=>{
  const raw=String(film?.id||'');
  const id=raw.startsWith('film:')?raw:raw.startsWith('tmdb_')?'film:tmdb:'+raw.slice(5):raw?('film:'+raw):null;
  if(!id)return null;
  return {id,facts:{watchlist:true,film:{contractVersion:1,canonicalIdentity:film.canonicalIdentity||null,originalTitle:film.original||film.title||null}}};
 }).filter(Boolean);
 const departed=[];
 return {ok:true,generation:g0,programmeRunId,films,departed,persons:[],credits:[],personRows:[],label:snapshotLabel(programmeRunId,g0),members,watchlist};
}

async function createInstance(env,id,params){
 const binding=env.PRODUCER_WORKFLOW;
 if(!binding||typeof binding.create!=='function')return {ok:false,reason:'workflow_unavailable'};
 for(let attempt=0;attempt<CHAIN_CREATE_ATTEMPTS;attempt++){
  try{await binding.create({id,params});return {ok:true,reason:'started'};}
  catch(error){
   if(createError(error)==='exists')return {ok:true,reason:'attached'};
  }
 }
 return {ok:false,reason:'create_uncertain'};
}

export async function reconcileProducerChain(env,{now=Date.now()}={}){
 try{
  if(typeof env?.PRODUCER_WORKFLOW?.create!=='function')return {ran:false,reason:'workflow_unavailable'};
  let marker;
  try{marker=await readAuthority(env);}catch{return {ran:false,reason:'marker_unreadable'};}
  if(marker.state!=='open')return {ran:false,reason:'dormant',marker:marker.state};
  let published;
  try{published=await readPublished(env);}catch{return {ran:false,reason:'authority_unreadable'};}
  if(!published?.ready||!published.programmeRunId)return {ran:false,reason:'epg_not_open'};
  const P=published.programmeRunId,g=Number(published.generation),at=iso(now);
  const counts={launched:0,takeover:0,relaunch:0,reopen:0,recover:0,supersede:0,skipped:0};
  const chain=await readChain(env,P).catch(()=>null);
  const passed=await epgRunForGeneration(env,{sourceGeneration:snapshotLabel(P,g)}).catch(()=>null);
  const rows=await listNonterminalChains(env).catch(()=>[]);
  for(const row of rows){
   if(row.programme_run_id===P)continue;
   try{await supersedeChain(env,{chain:row,at});counts.supersede++;}catch{counts.skipped++;}
  }
  const start=async(result)=>{
   if(!result||result.state==='skipped'||result.state==='skip'||result.state==='live'||result.state==='wait'||result.state==='held')return;
   const id=result.instanceId||producerInstanceId(P,result.epoch);
   await createInstance(env,id,{programmeRunId:P,epoch:result.epoch});
  };
  if(!chain){
   if(passed?.pass_state==='passed')return {ran:true,reason:'already_current',...counts};
   const launched=await launchChain(env,{programmeRunId:P,generation:g,at,nowMs:now});
   if(launched.state==='launched'||launched.state==='exists'){
    counts.launched++;
    await createInstance(env,launched.instanceId||producerInstanceId(P,launched.chain?.owner_epoch||1),{programmeRunId:P,epoch:launched.epoch||launched.chain?.owner_epoch||1});
   }
   return {ran:true,reason:'launch',...counts};
  }
  const expired=Date.parse(chain.lease_expires_at)+CHAIN_BOUNDARY_MARGIN_MS<now;
  if((chain.owner_state==='pending'||chain.owner_state==='active')&&expired){
   const t=await takeoverChain(env,{chain,generation:g,at,nowMs:now});counts.takeover++;await start(t);
  }else if(chain.owner_state==='released'){
   const t=await relaunchChain(env,{chain,generation:g,at,nowMs:now});counts.relaunch++;await start(t);
  }else if(chain.owner_state==='complete'||chain.owner_state==='stopped'){
   const quiet=chain.updated_at&&(now-Date.parse(chain.updated_at)>=CHAIN_QUIET_MS);
   if(chain.owner_state==='stopped'&&(chain.recovery_class==='transient'||chain.recovery_class==='receipt'||chain.recovery_class==='authority')){
    const t=await recoverChain(env,{chain,generation:g,at,nowMs:now});if(t.state==='pending'){counts.recover++;await start(t);}
   }else{
    const t=await reopenChain(env,{chain,generation:g,at,nowMs:now,quiet});if(t.state==='pending'){counts.reopen++;await start(t);}
   }
  }
  return {ran:true,reason:'reconciled',...counts};
 }catch(error){
  return {ran:false,reason:error?.code||'error'};
 }
}

async function reconcileReceiptsStep(env,plan,fence){
 const fenced={...env,producerFence:fence};
 return reconcileEpgRun(fenced,{plan:plan?.personPlan,filmPlan:plan?.filmPlan,limit:10});
}

export async function runProducerWorkflow(env,payload,step){
 const P=payload?.programmeRunId,epoch=Number(payload?.epoch);
 if(typeof P!=='string'||!P||!Number.isInteger(epoch)||epoch<1)return {state:'invalid'};
 const doStep=typeof step?.do==='function'?step.do.bind(step):(name,fn)=>fn();
 const totals={calls:0,statements:0,invocations:0,maxCalls:0,maxStatements:0};
 const nonce=await doStep('nonce',async()=>crypto.randomUUID());
 let chain=await readChain(env,P);
 if(!chain||chain.owner_epoch!==epoch)return {state:'not_owner'};
 let published=await readPublished(env);
 if(!published?.ready||published.programmeRunId!==P)return {state:'producer_generation_superseded'};
 const claimed=await doStep('claim',async()=>claimChain(env,{programmeRunId:P,epoch,instanceId:producerInstanceId(P,epoch),nonce,generation:Number(published.generation),revision:chain.revision,at:new Date().toISOString(),nowMs:Date.now()}));
 if(claimed.state!=='owned')return {state:'not_owner'};
 chain=claimed.chain;
 let fence={kind:'chain',programmeRunId:P,epoch,nonce,inputGeneration:Number(chain.input_generation),revision:chain.revision};
 let rebases=0;
 const work=async()=>{
  const meter={calls:0,statements:0,batches:0};
  const scoped=meteredEnv({...env,producerFence:fence},meter);
  const snap=await acquireSealedSnapshot(scoped,P);
  if(!snap.ok){
   if(snap.code==='producer_input_superseded'||snap.code==='producer_generation_superseded'){
    if(rebases>=CHAIN_REBASE_CAP){await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_input_unstable'});return {state:'stopped',code:'producer_input_unstable'};}
    published=await readPublished(env);
    const rebased=await rebaseChain(env,{fence,revision:fence.revision,generation:Number(published.generation),at:new Date().toISOString()});
    if(rebased.state==='rebased'){fence=rebased.fence;rebases++;return work();}
    return {state:'stopped',code:'producer_input_superseded'};
   }
   return {state:'stopped',code:snap.code};
  }
  fence.inputGeneration=snap.generation;
  await reconcileReceiptsStep(scoped,null,fence).catch(()=>{});
  const pass=await runEpgProducerPass(scoped,{
   runId:P,sourceGeneration:snap.label,at:new Date().toISOString(),films:snap.films,departed:snap.departed,
   persons:snap.persons,credits:snap.credits,personRows:snap.personRows,
   sliceSize:CHAIN_SLICE_SIZE,maxSlicesPerRun:CHAIN_MAX_SLICES,sliceDeadlineMs:CHAIN_SLICE_DEADLINE_MS,
   prerequisites:async()=>({}),generationOrder,inputProvenance:{complete:true,committed:true,sealed:true,publishedGeneration:snap.label},
  });
  totals.invocations++;totals.calls+=meter.calls;totals.statements+=meter.statements;
  totals.maxCalls=Math.max(totals.maxCalls,meter.calls);totals.maxStatements=Math.max(totals.maxStatements,meter.statements);
  if(pass.state==='complete'){
   await reconcileReceiptsStep(scoped,null,fence).catch(()=>{});
   return {state:'complete',pass};
  }
  if(pass.state==='skipped')return {state:'dormant',pass};
  if(pass.state==='stopped'||pass.state==='error'){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:pass.code||'unclassified'}).catch(()=>{});
   return {state:'stopped',code:pass.code,pass};
  }
  const decision=successorDecision({spentCalls:totals.calls,spentStatements:totals.statements,estimateCalls:totals.maxCalls||CHAIN_FLOOR_D1_CALLS,estimateStatements:totals.maxStatements||CHAIN_FLOOR_D1_STATEMENTS});
  if(decision.reason==='producer_budget_infeasible'){
   await stopChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),stoppedBy:'producer_budget_infeasible'});
   return {state:'stopped',code:'producer_budget_infeasible'};
  }
  if(!decision.continue){
   const hand=await handoffChain(scoped,{fence,revision:fence.revision,at:new Date().toISOString(),nowMs:Date.now()});
   if(hand.state==='handed_off')await createInstance(env,hand.instanceId,{programmeRunId:P,epoch:hand.epoch});
   return {state:'handoff',epoch:hand.epoch};
  }
  return work();
 };
 return doStep('work',work);
}

export async function retryEpgProducerResultsFenced(env,params){
 const published=await readPublished(env);
 if(!published?.ready)return {state:'error',code:'producer_generation_superseded'};
 const fence={kind:'retry',programmeRunId:published.programmeRunId,inputGeneration:Number(published.generation)};
 requireFence(fence,['retry']);
 return retryEpgProducerResults({...env,producerFence:fence},{...params,sourceGeneration:snapshotLabel(published.programmeRunId,published.generation)});
}

export {readCanonicalFreshness,CHAIN_LEASE_MS,CHAIN_BOUNDARY_MARGIN_MS};
