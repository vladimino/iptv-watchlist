// ADR 0203 (AIR-582, owner option C of AIR-572). The canonical Watchlist MEMBERSHIP projection by the Letterboxd Sync: the fourth causal effect `membership`, the bounded reconcile of the durable handoff ledger, and the
// one-time baseline reconciliation (planner, dry run and bounded apply). DORMANT by construction: every function below does nothing unless the membership marker (schema 37, `watchlist_membership_authority`) says
// `sync`; until the owner switches it, the three legacy effects run and the EPG Producer owns `watchlist_film` exactly as before.
//
// Protocol (ADR 0203):
//  - A committed snapshot only means "the list is stored"; the projection catches up through the effect of that version, in version order (the existing drain), never faster than the drain.
//  - The effect reads the DURABLE change rows of its version (added/removed), resolves each Letterboxd id to a TRUSTED canonical Film (one trusted, non-conflicting `letterboxd` claim, or an existing Film of that exact name,
//    redirect followed one hop; never a guess, never a created Film) and writes membership through `setFilmMembership`, whose per-film VERSION FENCE refuses a write older than the newest applied one.
//  - An id that cannot be resolved or written for a reason that is about THAT id (unresolved, ambiguous, redirect chain, proof changed) never holds the version: an added id goes to the durable handoff ledger and the effect
//    completes. A reason that is about the system (D1 unavailable, writer fence, revision conflict) holds the effect for a bounded number of attempts (one per 4/day slot); after that the not yet applied ids are handed off and
//    the effect completes, so a persistent fault can never block the next Watchlist publication for ever.
//  - The handoff ledger is reconciled against the CURRENT snapshot (never against the version that first listed the id), with a bounded backoff, a bounded number of attempts, then `terminal` (left for the baseline operator).
// Everything is injected: the Watchlist repository, the identity resolver and the Film writer. No import (the module is bundled in its own scope).
export const MEMBERSHIP_LIDS_PER_CALL=60;
export const MEMBERSHIP_EFFECT_MAX_ATTEMPTS=6;
export const HANDOFF_STEP_LIMIT=25;
export const HANDOFF_MAX_ATTEMPTS=12;
const HOUR=3600000;
const BACKOFF_MS=[1*HOUR,3*HOUR,12*HOUR];
const SOFT=new Set(['film_person_precondition','film_person_redirect','film_person_reference','identity_collision']);
const TRANSIENT=new Set(['film_person_unavailable','film_person_held','film_person_fence','film_person_revision_conflict','film_person_membership_closed','film_person_bounded']);
const codeOf=error=>String(error?.code||'');
// The identity resolver is bounded (1000 distinct lids per call) while a valid Watchlist may hold up to 5000: a whole list is resolved in chunks of at most RESOLVE_CHUNK and the per-id answers are merged. A chunk that fails
// fails the whole answer (`ok:false`, never a partial "not referenced"). Trust, proofs and guards are exactly those of the resolver, chunk by chunk.
export const RESOLVE_CHUNK=1000;
export async function resolveInChunks(resolve,env,lids,size=RESOLVE_CHUNK){
 const unique=[...new Set(lids)];
 if(unique.length<=size)return resolve(env,unique);
 const byId=new Map();
 for(let from=0;from<unique.length;from+=size){
  const out=await resolve(env,unique.slice(from,from+size));
  if(!out||!out.ok)return out&&out.ok===false?out:{ok:false};
  for(const [lid,item] of out.byId)byId.set(lid,item);
 }
 return {ok:true,byId};
}
// The Films referenced by a list of Letterboxd ids (their resolved targets). Several lids may name ONE Film (`film_external_id` is keyed by film, scheme and value), so a Film leaves the Watchlist only when NO lid of the
// list still resolves to it. null when the identity reads fail (the caller treats that as a system fault, never as "not referenced").
async function referencedFilms(deps,env,lids){
 const out=await resolveInChunks(deps.resolve,env,lids);
 if(!out.ok)return null;
 const films=new Set();
 for(const item of out.byId.values())if(item&&item.target)films.add(item.target);
 return films;
}

// One id, one write. -> {kind:'written'|'stale'|'unchanged'} | {kind:'soft',reason} | {kind:'transient',reason}
async function applyOne(deps,env,{lid,member,version,at,resolution}){
 if(!resolution||resolution.refused)return {kind:'soft',reason:String(resolution?.refused||'unresolved').replace(/^producer_identity_/,'').slice(0,60)};
 for(let attempt=0;attempt<2;attempt++){
  try{
   const out=await deps.setMembership(env,{id:resolution.target,member,version,at,guards:resolution.guards});
   return {kind:out.written?'written':out.reason==='stale'?'stale':'unchanged'};
  }catch(error){
   const code=codeOf(error);
   // One in-line retry for a lost revision race (another writer bumped the Film between the read and the batch).
   if(code==='film_person_revision_conflict'&&attempt===0)continue;
   if(SOFT.has(code))return {kind:'soft',reason:code.replace(/^film_person_/,'').slice(0,60)};
   if(TRANSIENT.has(code))return {kind:'transient',reason:code.replace(/^film_person_/,'').slice(0,60)};
   return {kind:'transient',reason:'error'};
  }
 }
 return {kind:'transient',reason:'revision_conflict'};
}

// The `membership` effect writer (the same `(ctx, effect) -> receipt | null` shape as the three legacy ones). `effect.attempts` counts the earlier failed calls of THIS effect.
export function membershipEffect(deps){
 const {repository,fenceEnv=env=>env,epochGuard,slice=MEMBERSHIP_LIDS_PER_CALL,maxAttempts=MEMBERSHIP_EFFECT_MAX_ATTEMPTS}=deps;
 return async function membership(ctx,effect){
  const marker=await repository.readMembershipAuthority(ctx.env);
  if(!marker.ok||!marker.present||marker.mode!=='sync')return null;
  const read=await repository.readSnapshot(ctx.env,effect.snapshotId);
  if(!read.ok)return null;
  const snapshot=read.snapshot;
  const changes=await repository.readChanges(ctx.env,effect.snapshotId);
  if(!changes.ok)return null;
  // Deterministic queue (added, then removed, in the stored order of the change rows). ONE call applies at most `slice` of them inline; every later change row of the version is handed to the durable ledger in ONE
  // set-based statement (no resolution, no Film write), so the effect completes in a bounded number of calls however large a valid diff is and routine catch-up can never starve the next scan behind the strict
  // drain-before-scan rule. The ledger is reconciled against the CURRENT snapshot, a few rows per slot (no id is lost, none is applied from a stale version).
  const queue=[...changes.added.map(item=>({lid:item.lid,member:true})),...changes.removed.map(item=>({lid:item.lid,member:false}))];
  const part=queue.slice(0,slice);
  const deferred=queue.length-part.length;
  const writeEnv=fenceEnv(ctx.env,ctx.epoch);
  const at=new Date(ctx.now()).toISOString();
  const guards=typeof epochGuard==='function'&&Number.isInteger(ctx.epoch)?[epochGuard(ctx.epoch)]:null;
  if(!guards)return null;
  const resolved=part.length?await deps.resolve(ctx.env,part.map(item=>item.lid)):{ok:true,byId:new Map()};
  const exhausted=Number(effect.attempts)>=maxAttempts;
  const handoff=[];
  let written=0,stale=0,skipped=0,transient=null;
  if(!resolved.ok){
    // The identity reads failed as a whole: a system fault, not a fact about any id. After the bound EVERY unprocessed id of this slice (removals too) is handed off for reconcile against the CURRENT snapshot before the
    // effect may advance or complete; if that cannot be recorded the effect is held (below), nothing is lost.
    transient='identity_unreadable';
    if(exhausted)for(const item of part)handoff.push({lid:item.lid,reason:'deferred_identity_unreadable'});
  }else{
    // A removal clears a Film only when no other lid of THIS version's list still resolves to it (two lids may name one Film).
    let listed;
    for(const item of part){
      let member=item.member;
      const resolution=resolved.byId.get(item.lid);
      if(!member&&resolution&&resolution.target){
        if(listed===undefined)listed=await referencedFilms(deps,ctx.env,snapshot.films.map(film=>film.lid));
        if(listed===null){transient='identity_unreadable';if(exhausted){handoff.push({lid:item.lid,reason:'deferred_identity_unreadable'});continue;}break;}
        if(listed.has(resolution.target))member=true;
      }
      const out=await applyOne(deps,writeEnv,{lid:item.lid,member,version:snapshot.version,at,resolution});
      if(out.kind==='written')written++;
      else if(out.kind==='stale')stale++;
      else if(out.kind==='unchanged')skipped++;
      else if(out.kind==='soft'){if(item.member)handoff.push({lid:item.lid,reason:out.reason});else skipped++;}
      else{transient=out.reason;if(exhausted)handoff.push({lid:item.lid,reason:'deferred_'+out.reason});else break;}
    }
  }
  // Ids that could not be applied are made durable BEFORE the effect can complete; a failure to record them holds the effect (nothing is lost).
  if(handoff.length){
    for(let from=0;from<handoff.length;from+=50){
      const chunk=handoff.slice(from,from+50);
      const out=await repository.recordMembershipHandoff(ctx.env,{lids:chunk.map(item=>item.lid),version:snapshot.version,reason:chunk[0].reason,now:ctx.now()},{guards});
      if(!out.ok)return null;
    }
  }
  if(transient&&!exhausted)return null;
  // The rest of the version is made durable BEFORE the effect can complete; if that cannot be recorded the effect is held (nothing is lost).
  if(deferred>0){
   const out=await repository.handoffVersionRemainder(ctx.env,{snapshotId:effect.snapshotId,version:snapshot.version,offset:part.length,reason:'remainder',now:ctx.now()},{guards});
   if(!out.ok)return null;
  }
  return ('membership:'+snapshot.scanId+':w'+written+':s'+(stale+skipped)+':h'+handoff.length+':q'+deferred).slice(0,200);
 };
}

// ONE bounded reconcile step of the handoff ledger, against the CURRENT snapshot. Called by the Sync slot after the scan (never before the drain, never when the marker is not `sync`). Its failure never undoes anything and
// never blocks a slot. -> {processed,settled,pending,terminal} | {skipped:true,reason}
export function membershipReconcile(deps){
 const {repository,fenceEnv=env=>env,epochGuard,limit=HANDOFF_STEP_LIMIT,maxAttempts=HANDOFF_MAX_ATTEMPTS}=deps;
 return async function reconcile(ctx,{now=ctx.now(),limit:cap=limit}={}){
  const marker=await repository.readMembershipAuthority(ctx.env);
  if(!marker.ok||!marker.present||marker.mode!=='sync')return {skipped:true,reason:'marker_not_sync'};
  const guards=typeof epochGuard==='function'&&Number.isInteger(ctx.epoch)?[epochGuard(ctx.epoch)]:null;
  if(!guards)return {skipped:true,reason:'epoch_guard_absent'};
  const due=await repository.dueMembershipHandoffs(ctx.env,{now,limit:Math.min(cap,limit)});
  if(!due.ok)return {skipped:true,reason:'ledger_unreadable'};
  if(!due.rows.length)return {processed:0,settled:0,pending:due.pending,terminal:due.terminal};
  const current=await repository.readCurrentMembers(ctx.env);
  if(!current.ok||current.version<1)return {skipped:true,reason:'current_unreadable'};
  const resolved=await deps.resolve(ctx.env,due.rows.map(row=>row.lid));
  const writeEnv=fenceEnv(ctx.env,ctx.epoch);
  const at=new Date(now).toISOString();
  let settled=0,terminal=0;
  // Every due attempt uses the retry budget, whatever failed (a system fault included), so a row can never stay pending for ever at its first attempt count.
  const retry=async(row,reason)=>{
   const attempts=row.attempts+1;
   if(attempts>=maxAttempts){if((await repository.settleMembershipHandoff(ctx.env,{lid:row.lid,state:'terminal',attempts,reason,now},{guards})).ok)terminal++;return;}
   await repository.settleMembershipHandoff(ctx.env,{lid:row.lid,state:'pending',attempts,nextRetryAt:new Date(now+BACKOFF_MS[Math.min(attempts-1,BACKOFF_MS.length-1)]).toISOString(),reason,now},{guards});
  };
  if(!resolved.ok){for(const row of due.rows)await retry(row,'identity_unreadable');return {processed:due.rows.length,settled:0,pending:Math.max(0,due.pending-terminal),terminal:due.terminal+terminal,error:'identity_unreadable'};}
  let listed;
  for(const row of due.rows){
   const resolution=resolved.byId.get(row.lid);
   // Desired membership of the Film comes from the WHOLE current snapshot: a lid that left the list does not clear a Film another current lid still resolves to.
   let member=current.lids.has(row.lid);
   if(!member&&resolution&&resolution.target){
    if(listed===undefined)listed=await referencedFilms(deps,ctx.env,[...current.lids]);
    if(listed===null){await retry(row,'identity_unreadable');continue;}
    member=listed.has(resolution.target);
   }
   const out=await applyOne(deps,writeEnv,{lid:row.lid,member,version:current.version,at,resolution});
   if(out.kind==='written'||out.kind==='stale'||out.kind==='unchanged'){
    if((await repository.settleMembershipHandoff(ctx.env,{lid:row.lid,state:'settled',attempts:row.attempts,reason:out.kind,now},{guards})).ok)settled++;
    continue;
   }
   // A lid that left the Watchlist and still has no Film has nothing to apply: nothing is owed.
   if(!member&&out.kind==='soft'){if((await repository.settleMembershipHandoff(ctx.env,{lid:row.lid,state:'settled',attempts:row.attempts,reason:'not_listed',now},{guards})).ok)settled++;continue;}
   await retry(row,out.reason);
  }
  return {processed:due.rows.length,settled,pending:Math.max(0,due.pending-settled-terminal),terminal:due.terminal+terminal};
 };
}

// ---- the one-time baseline reconciliation (ADR 0203, rollout step) ----------------------------------------------------------
// PURE planner. `current` = the Letterboxd ids of the CURRENT snapshot, `stored` = the Film ids now in `watchlist_film`, `byId` = the identity resolution of every current id (resolveSourceIdentitiesEach).
// desired = the resolved Films of the current ids. Result: `add` (desired, not stored), `keep`, `remove` (stored, not desired: drift from the Producer's old behaviour), `unresolved` (current ids with no trusted Film: they go to
// the handoff ledger, nothing is guessed). Deterministic order (by id) so every call of an apply is the same plan.
export function planBaseline({current=[],stored=[],byId=new Map()}={}){
 const desired=new Map();
 const unresolved=[];
 for(const lid of [...new Set(current)].sort()){
  const item=byId.get(lid);
  if(!item||item.refused){unresolved.push({lid,reason:String(item?.refused||'unresolved').replace(/^producer_identity_/,'')});continue;}
  if(!desired.has(item.target))desired.set(item.target,{filmId:item.target,lid,guards:item.guards});
 }
 const have=new Set(stored);
 const add=[...desired.values()].filter(item=>!have.has(item.filmId)).sort((a,b)=>a.filmId<b.filmId?-1:1);
 const keep=[...desired.values()].filter(item=>have.has(item.filmId)).sort((a,b)=>a.filmId<b.filmId?-1:1);
 const remove=[...have].filter(id=>!desired.has(id)).sort();
 return {add,keep,remove,unresolved,desired:desired.size,stored:have.size,converged:add.length===0&&remove.length===0};
}

// The baseline operator, as a pair of calls over injected ports: `readStored(env)` -> [film ids in watchlist_film], `resolve`, `setMembership` (the Film writer, called with `baseline: true`), and the repository.
// `dryRun` reads only. `apply` writes at most `limit` Film changes per call (bounded D1 cost), idempotent (a replay finds the plan shorter), never creates a Film and never touches anything but `watchlist_film` and its fence.
// It records the baseline proof (`baseline_version`) ONLY when nothing remains to apply for the exact version it read, with the current version fully drained.
export function membershipBaseline(deps){
 const {repository,fenceEnv=env=>env,epochGuard,limit=25}=deps;
 const plan=async ctx=>{
  const current=await repository.readCurrentMembers(ctx.env);
  if(!current.ok||current.version<1)return {ok:false,reason:'current_unreadable'};
  if(current.effectsDrainedVersion<current.version)return {ok:false,reason:'effects_pending',version:current.version};
  const stored=await deps.readStored(ctx.env).catch(()=>null);
  if(!stored)return {ok:false,reason:'stored_unreadable'};
  const resolved=await resolveInChunks(deps.resolve,ctx.env,[...current.lids]);
  if(!resolved.ok)return {ok:false,reason:'identity_unreadable'};
  return {ok:true,version:current.version,plan:planBaseline({current:[...current.lids],stored,byId:resolved.byId})};
 };
 return {
  async dryRun(ctx){
   const out=await plan(ctx);
   if(!out.ok)return out;
   const {plan:p}=out;
   return {ok:true,version:out.version,decision:p.converged?'already_current':'drift',counts:{current:p.desired+p.unresolved.length,stored:p.stored,add:p.add.length,remove:p.remove.length,keep:p.keep.length,unresolved:p.unresolved.length}};
  },
  async apply(ctx){
   const guards=typeof epochGuard==='function'&&Number.isInteger(ctx.epoch)?[epochGuard(ctx.epoch)]:null;
   if(!guards)return {ok:false,reason:'epoch_guard_absent'};
   const marker=await repository.readMembershipAuthority(ctx.env);
   if(!marker.ok||!marker.present)return {ok:false,reason:'schema_absent'};
   const out=await plan(ctx);
   if(!out.ok)return out;
   const {plan:p,version}=out;
   const writeEnv=fenceEnv(ctx.env,ctx.epoch);
   const at=new Date(ctx.now()).toISOString();
   const work=[...p.add.map(item=>({id:item.filmId,member:true,guards:item.guards})),...p.remove.map(id=>({id,member:false,guards:[]}))].slice(0,limit);
   let written=0,failed=0;
   for(const item of work){
    try{const done=await deps.setMembership(writeEnv,{id:item.id,member:item.member,version,at,guards:item.guards,baseline:true});if(done.written)written++;}
    catch{failed++;}
   }
   if(p.unresolved.length){
    for(let from=0;from<p.unresolved.length;from+=50){
     const chunk=p.unresolved.slice(from,from+50);
     const handoff=await repository.recordMembershipHandoff(ctx.env,{lids:chunk.map(item=>item.lid),version,reason:'baseline_unresolved',now:ctx.now()},{guards});
     if(!handoff.ok)return {ok:false,reason:'handoff_failed',written,failed};
    }
   }
   const remaining=p.add.length+p.remove.length-written;
   if(remaining>0||failed>0)return {ok:true,version,decision:'partial',written,failed,remaining:Math.max(0,remaining),unresolved:p.unresolved.length};
   const proved=await repository.recordMembershipBaseline(ctx.env,{version,now:ctx.now()},{guards});
   return {ok:true,version,decision:proved.ok?'baseline_recorded':'baseline_not_recorded',written,failed:0,remaining:0,unresolved:p.unresolved.length,reason:proved.ok?undefined:proved.reason};
  }
 };
}

// ---- the owner-only operator of the baseline apply and the writer switch (ADR 0203 rollout steps 2 and 3; AIR-572) ----------------------------------------------
// One handler behind the owner-only MCP tool `watchlist_membership_operator` (the /mcp endpoint is Cloudflare Access with the Worker's own owner JWT check). It adds NO writer and NO SQL: it calls the existing
// `membershipBaseline().apply` (at most `limit` Film membership changes per call, idempotent, version-fenced) and `repository.activateMembershipSync` (guarded switch), under the Letterboxd Sync epoch fence the
// effects use. Inert without a call. `mode` defaults to `status`; only an explicit `baseline_apply` or `switch` with `confirmGo: true` and the expected pins read from a status call can write.
//   status            read-only: marker, current Watchlist version and drain, the Sync epoch, the Producer hold and its non-terminal chains, and what a switch would need.
//   baseline_dry_run  read-only counts of the baseline plan (the same planner the apply uses).
//   baseline_apply    confirmGo, expectedVersion, expectedMarkerGeneration: one bounded apply; records the baseline proof only when nothing remains for the exact version read with that version fully drained.
//   switch            confirmGo, expectedVersion, expectedMarkerGeneration: marker `producer` at the expected generation, proof equal to the current drained version, the Producer delivery hold ON and no non-terminal
//                     Producer chain, then the guarded switch to `sync` (roll-forward only).
// deps: repository (readMembershipAuthority, readCurrentMembers, recordMembershipHandoff, recordMembershipBaseline, activateMembershipSync), resolve, setMembership, readStored, epochGuard(epoch), fenceEnv(env,epoch),
// readSyncEpoch(env) -> {ok, mode, epoch}, producerState(env) -> {ok, held, nonTerminal}, now() -> ms.
export const MEMBERSHIP_OPERATOR_MODES=Object.freeze(['status','baseline_dry_run','baseline_apply','switch']);
export function membershipOperator(deps){
 const {repository,readSyncEpoch,producerState,now=()=>Date.now(),limit=25}=deps;
 const baseline=membershipBaseline({...deps,limit});
 const reply=(status,body)=>({status,body});
 const pin=value=>Number.isInteger(value)&&value>=0;
 async function snapshot(env){
  const [marker,current,sync,producer]=await Promise.all([
   repository.readMembershipAuthority(env).catch(()=>({ok:false})),
   repository.readCurrentMembers(env).catch(()=>({ok:false})),
   readSyncEpoch(env).catch(()=>({ok:false})),
   producerState(env).catch(()=>({ok:false}))]);
  return {marker,current,sync,producer};
 }
 const view=s=>({
  marker:s.marker.ok&&s.marker.present?{mode:s.marker.mode,generation:s.marker.generation,baselineVersion:s.marker.baselineVersion}:null,
  watchlist:s.current.ok?{version:s.current.version,drainedVersion:s.current.effectsDrainedVersion,drained:s.current.effectsDrainedVersion>=s.current.version}:null,
  sync:s.sync.ok?{mode:s.sync.mode,epoch:s.sync.epoch}:null,
  producer:s.producer.ok?{held:s.producer.held===true,nonTerminalChains:s.producer.nonTerminal}:null,
 });
 // The reasons a write is refused before any statement. Every pin is re-read here, right before the write; the batches assert the rest themselves.
 function refusal(s,{expectedVersion,expectedMarkerGeneration},forSwitch){
  if(!s.marker.ok||!s.marker.present)return 'schema_absent';
  if(!s.current.ok)return 'watchlist_unreadable';
  if(!s.sync.ok||s.sync.mode!=='cloudflare'||!Number.isInteger(s.sync.epoch))return 'sync_not_cloudflare';
  if(s.marker.mode!=='producer')return 'already_switched';
  if(s.marker.generation!==expectedMarkerGeneration)return 'marker_generation_moved';
  if(s.current.version!==expectedVersion)return 'version_moved';
  if(s.current.effectsDrainedVersion<s.current.version)return 'effects_pending';
  if(forSwitch){
   if(s.marker.baselineVersion!==expectedVersion)return 'baseline_not_proved';
   if(!s.producer.ok)return 'producer_unreadable';
   if(s.producer.held!==true)return 'producer_not_held';
   if(s.producer.nonTerminal!==0)return 'producer_chain_open';
  }
  return null;
 }
 return async function handle(env,args={}){
  if(!args||typeof args!=='object'||Array.isArray(args))return reply(400,{ok:false,reason:'invalid'});
  const mode=args.mode===undefined?'status':args.mode;
  if(!MEMBERSHIP_OPERATOR_MODES.includes(mode))return reply(400,{ok:false,reason:'invalid_mode'});
  if(args.confirmGo!==undefined&&typeof args.confirmGo!=='boolean')return reply(400,{ok:false,reason:'invalid_confirm'});
  if(mode==='status'){
   const s=await snapshot(env);
   const v=view(s);
   return reply(200,{ok:true,mode,sideEffects:'none',...v,expect:v.marker&&v.watchlist?{expectedVersion:v.watchlist.version,expectedMarkerGeneration:v.marker.generation}:null});
  }
  if(mode==='baseline_dry_run'){
   const out=await baseline.dryRun({env});
   return out.ok?reply(200,{ok:true,mode,sideEffects:'none',version:out.version,decision:out.decision,counts:out.counts}):reply(409,{ok:false,mode,reason:out.reason,...(out.version!=null?{version:out.version}:{})});
  }
  if(args.confirmGo!==true)return reply(400,{ok:false,mode,reason:'confirm_required',writes:0});
  if(!pin(args.expectedVersion)||args.expectedVersion<1)return reply(400,{ok:false,mode,reason:'invalid_expected_version',writes:0});
  if(!pin(args.expectedMarkerGeneration))return reply(400,{ok:false,mode,reason:'invalid_expected_marker_generation',writes:0});
  const s=await snapshot(env);
  const refused=refusal(s,args,mode==='switch');
  if(refused)return reply(409,{ok:false,mode,reason:refused,writes:0,...view(s)});
  const epoch=s.sync.epoch;
  if(mode==='baseline_apply'){
   const out=await baseline.apply({env,epoch,now});
   if(!out.ok)return reply(409,{ok:false,mode,reason:out.reason,writes:out.written??0,...(out.failed!=null?{failed:out.failed}:{})});
   return reply(200,{ok:true,mode,version:out.version,decision:out.decision,written:out.written,failed:out.failed,remaining:out.remaining,unresolved:out.unresolved,...(out.reason?{reason:out.reason}:{})});
  }
  const switched=await repository.activateMembershipSync(env,{expectedGeneration:args.expectedMarkerGeneration,version:args.expectedVersion,now:now()},{guards:[deps.epochGuard(epoch)]});
  if(!switched.ok)return reply(409,{ok:false,mode,reason:switched.reason,writes:0});
  const after=await snapshot(env);
  return reply(200,{ok:true,mode,switched:true,...view(after)});
 };
}
// The two read ports of the operator, as plain bounded reads (one row each), so the Worker and the tests use the same SQL. A chain is NON-TERMINAL while it can still write: pending, active, released, or
// stopped with an automatically recoverable class (the hourly reconcile would reopen it once the hold is lifted). `held` is the Producer's static delivery hold, passed in by the Worker.
export const PRODUCER_OPEN_CHAINS_SQL="SELECT COUNT(*) AS n FROM canonical_producer_chain WHERE owner_state IN ('pending','active','released') OR (owner_state='stopped' AND recovery_class IN ('transient','receipt','authority'))";
export function operatorReads({held}){
 const first=async(env,sql)=>(await env.DB.prepare(sql).bind().first())??null;
 return {
  readSyncEpoch:async env=>{const row=await first(env,'SELECT mode, epoch FROM letterboxd_sync_mode WHERE id=1');return row?{ok:true,mode:row.mode,epoch:Number(row.epoch)}:{ok:false};},
  producerState:async env=>{const row=await first(env,PRODUCER_OPEN_CHAINS_SQL);return {ok:true,held:held()===true,nonTerminal:Number(row?.n??0)};},
  readStored:async env=>((await env.DB.prepare('SELECT film_id FROM watchlist_film').bind().all()).results||[]).map(row=>row.film_id),
 };
}
