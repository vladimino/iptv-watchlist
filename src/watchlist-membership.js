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
export const HANDOFF_STEP_LIMIT=8;
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

// The `membership` effect writer (the same `(ctx, effect) -> receipt | {progress,more} | null` shape as the three legacy ones). `effect.attempts` counts the earlier failed calls of THIS effect.
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
  // Deterministic queue (added, then removed, each in the stored order): a resume point is an index into it. An unreadable or out of range point starts over (every unit is idempotent), it never skips ahead.
  const queue=[...changes.added.map(item=>({lid:item.lid,member:true})),...changes.removed.map(item=>({lid:item.lid,member:false}))];
  const resumed=/^membership-cursor:(\d{1,6})$/.exec(String(effect.progress??''));
  const start=resumed&&Number(resumed[1])<=queue.length?Number(resumed[1]):0;
  const part=queue.slice(start,start+slice);
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
  if(transient&&!exhausted)return start>0?{progress:'membership-cursor:'+start,more:false}:null;
  const next=start+part.length;
  if(next<queue.length)return {progress:'membership-cursor:'+next,more:true};
  return ('membership:'+snapshot.scanId+':w'+written+':s'+(stale+skipped)+':h'+handoff.length).slice(0,200);
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
