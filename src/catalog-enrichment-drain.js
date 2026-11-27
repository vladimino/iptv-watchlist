// AIR-605 (card C1; ADR 0219 decisions 2, 5 and 6). The RESOURCE-BOUNDED, WORK-CONSERVING QUEUE DRAINER of the Catalog Enrichment Producer. DORMANT: nothing in the Worker imports it; with no active control it answers
// `not_active` before any request. One call is ONE RUN (the body of a Workflow instance): it owns the `projection_run` lease, consumes the runnable signals of the inbox (guarded, exactly once), picks due Films live-first
// with a background share measured in COMMITTED units (about one in eight), processes each Film through the producer step, and stops only for a REASON:
//   idle       no runnable work and nothing deferred;     parked    every remaining item is deferred: `wakeAt` is the earliest due time;
//   handover   the statement budget: the caller creates the successor;   paused / generation_moved   the control;   lease_lost / lease_held   the lease;   yield   the EPG publication window (injected predicate).
// There are NO throughput quotas here (no 2-Film bound, no tick deadline): the only budgets are safety budgets: statements (failing and replayed calls included), steps and the lease. A local stop never counts toward the
// 72 h fallback and sets no cooldown: the producer step handles outcomes, this module only schedules.
import {database,many,one} from './film-person-authority.js';
import {acquireLease,consumeSignal,readControl,releaseLease,renewLease,runnableSignals} from './catalog-enrichment-store.js';
import {nextClass,priorityClass} from './catalog-enrichment-plan.js';
import {processFilm,CODE_VERSION} from './catalog-enrichment-producer.js';

// Engineering-owned defaults (ADR 0219 decision 6), one module, reported in each run's outbox entry. The statement budget is the ADR 0094 guard, not a provider limit; a handover happens at HANDOVER_AT, half the documented
// 10,000; a step starts only when the remaining budget covers its own work plus the finalize-and-successor reserve.
// `requests` is the UPSTREAM subrequest budget of one drain (every fetch the sources actually send, redirect hops included): a Worker invocation has a fixed subrequest ceiling, and the drain hands over at `requestsHandoverAt`, which
// leaves headroom for the D1 and orchestration calls of the same invocation. It is a conservative engineering placeholder, not a product limit: a Film that needs more resumes from its persisted state in the next run.
export const BUDGET=Object.freeze({statements:6000,handoverAt:5000,reserve:1000,window:50,stepEstimate:150,unitEstimate:60,requests:400,requestsHandoverAt:350});

async function repairGuard(handle,leaseId,generation,now){
 const lease=`EXISTS (SELECT 1 FROM projection_run WHERE projection='catalog_enrichment' AND lease_id=? AND lease_until>?) AND EXISTS (SELECT 1 FROM catalog_enrichment_control WHERE id=1 AND state='active' AND generation=?)`;
 void handle;
 return {sql:lease,params:[leaseId,now,generation]};
}

// A D1 binding that counts every statement it issues, failing calls included.
export function countingEnv(env){
 const base=database(env);
 const counter={statements:0,failed:0};
 const wrapStatement=statement=>new Proxy(statement,{get(target,prop){
  if(prop==='run'||prop==='first'||prop==='all')return async(...args)=>{counter.statements++;try{return await target[prop](...args);}catch(error){counter.failed++;throw error;}};
  return target[prop];
 }});
 const wrapped=new Proxy(base,{get(target,prop){
  if(prop==='prepare')return sql=>{const prepared=target.prepare(sql);return new Proxy(prepared,{get(inner,name){
   if(name==='bind')return(...params)=>wrapStatement(inner.bind(...params));
   if(name==='run'||name==='first'||name==='all')return async(...args)=>{counter.statements++;try{return await inner[name](...args);}catch(error){counter.failed++;throw error;}};
   return inner[name];
  }});};
  if(prop==='batch')return async list=>{counter.statements+=list.length;try{return await target.batch(list);}catch(error){counter.failed+=list.length;throw error;}};
  const value=target[prop];
  return typeof value==='function'?value.bind(target):value;
 }});
 return {env:{...(env&&env.DB?env:{}),DB:wrapped},counter};
}

// The AUTHORITATIVE relevance facts of ADR 0219 decision 5, read for the Films one pick examined. UNKNOWN IS NOT FALSE: a fact that cannot be established is null, and a Film with a null fact is live.
//  personal   true: an authoritative Watchlist member or a verified rated admission. false: a Film held ONLY by the Discovery scope that has neither. A missing Watchlist projection row is never read as a negative for a Film
//             any other scope holds (the projection lags its authority by design).
//  available  true: a member of the pinned PUBLISHED EPG generation; false: the pinned generation is readable and the Film is not in it; null: no readable pinned generation.
export async function relevanceFacts(env,filmIds){
 const handle=database(env);
 const facts=new Map(filmIds.map(id=>[id,{personal:null,available:null,cohorts:new Set()}]));
 if(!filmIds.length)return facts;
 const json=JSON.stringify(filmIds);
 // A READ THAT FAILS IS NOT AN ABSENCE: the result keeps `ok:false` and every fact derived from it stays unknown (null), so an unreadable Watchlist or admission table can never become proof that a Film is not personal.
 const read=async(sql,params)=>{try{return {ok:true,rows:await many(handle,sql,params)};}catch{return {ok:false,rows:[]};}};
 const [watch,rated,scopes]=await Promise.all([
  read('SELECT film_id FROM watchlist_film WHERE film_id IN (SELECT value FROM json_each(?))',[json]),
  read('SELECT film_id FROM film_rated_admission WHERE film_id IN (SELECT value FROM json_each(?))',[json]),
  read('SELECT film_id,scope FROM catalog_enrichment_member WHERE film_id IN (SELECT value FROM json_each(?))',[json]),
 ]);
 const positive=new Set([...watch.rows,...rated.rows].map(row=>row.film_id));
 const negativeReadable=watch.ok&&rated.ok&&scopes.ok; // a "not personal" claim needs every source of personal facts to have been readable
 const held=new Map();
 for(const row of scopes.rows){if(!held.has(row.film_id))held.set(row.film_id,new Set());held.get(row.film_id).add(row.scope);}
 // The PUBLISHED EPG programme facts of the pinned generation. null: the authority or its members are unreadable, not pinned to a D1 generation, or the generation is not open (a projection or authority lag is unknown, never a negative).
 let members=null;
 try{
  const pinned=await one(handle,"SELECT programme_run_id FROM published_epg_authority WHERE id=1 AND mode='d1' AND cutover='open' AND programme_run_id IS NOT NULL");
  if(pinned)members=new Set((await many(handle,"SELECT DISTINCT film_id FROM published_epg_member WHERE programme_run_id=? AND kind IN ('programme','watchlist') AND film_id IN (SELECT value FROM json_each(?))",[pinned.programme_run_id,json])).map(row=>row.film_id));
 }catch{members=null;}
 for(const id of filmIds){
  const fact=facts.get(id),scopeSet=held.get(id)||new Set();
  for(const scope of scopeSet)fact.cohorts.add(scope==='c3a'?'history':'live');
  if(!scopeSet.size)fact.cohorts.add('live'); // an unreadable or empty membership is live by default
  fact.personal=positive.has(id)?true:(negativeReadable&&scopeSet.size&&[...scopeSet].every(scope=>scope==='discovery')?false:null);
  fact.available=members?members.has(id):null;
 }
 return facts;
}

// Due Films, by INDEXED PAGING. Per cohort a pick pages through the two partial indexes of migration 0047 (the runnable part rows, and the Films that still need their anchor check) in index order with a keyset cursor over
// (run-after time, due since, Film, part, source, slot). A page reads at most `window` index rows; the rows read ARE the examined work (reported exactly), whatever the filters then do to them, so a head of blocked rows, of
// repeated slots of one Film or of Films skipped in this run can neither hide the rows behind it nor make the work unbounded: paging goes on (at most MAX_PAGES pages per stream) until `window` distinct runnable Films are found.
// A backed-off item has its run-after time in the future, so it is not in the scanned range at all. The authoritative facts are read only for the Films found. Rows held back by an owner lock or an identity disagreement are
// returned in `blocked` so the drainer can defer them DURABLY (they then leave the head). -> {live, background, blocked, examined:{live,history}, pages}, oldest first within a class.
export const MAX_PAGES=4;
const LOCKED_CORE="(s.part='core' AND EXISTS (SELECT 1 FROM film_dimension d WHERE d.film_id=s.film_id AND d.dimension='metadata' AND (d.status='reviewed' OR COALESCE(d.authority,'')='owner')))";
const STREAMS=Object.freeze({
 runnable:{where:"s.part<>'film' AND s.status IN ('due','deferred_repair') AND s.held=0",key:'COALESCE(s.retry_at,\'\'),s.due_since,s.film_id,s.part,s.source,s.slot',cursor:['','','','','',0],extra:`, ${LOCKED_CORE} AS locked, EXISTS (SELECT 1 FROM catalog_enrichment_state f WHERE f.film_id=s.film_id AND f.part='film' AND f.status='identity_disagreement') AS disagree`},
 anchor:{where:"s.part='film' AND s.status='active' AND s.reason='check_anchors' AND s.held=0",key:'COALESCE(s.retry_at,\'\'),s.due_since,s.film_id',cursor:['','',''],extra:', 0 AS locked, 0 AS disagree'},
});
// RANGE EXHAUSTED is distinguished from PAGE BUDGET EXHAUSTED: `incomplete` is true when a stream stopped at its page budget with more of its range unread and found nothing, so "nothing found" is not "nothing there". The caller keeps a
// `cursors` map for the run: an incomplete stream continues from its cursor at the next pick (real forward progress past a head of rows that are not runnable), and a stream that found work or exhausted its range starts again at its head.
export async function dueFilms(env,{now,window=BUDGET.window,skip=new Set(),maxPages=MAX_PAGES,cursors=null}){
 const handle=database(env);
 const examined={live:0,history:0},picked=new Map(),blocked=[];
 let pages=0,incomplete=false;
 for(const cohort of ['live','history']){
  for(const stream of Object.values(STREAMS)){
   const cursorKey=cohort+':'+(stream===STREAMS.runnable?'runnable':'anchor');
   let cursor=cursors?.get(cursorKey)||stream.cursor,found=0,exhausted=false;
   for(let page=0;page<maxPages&&found<window;page++){
    const tuple=cursor.map(()=>'?').join(',');
    const rows=await many(handle,`SELECT r.*, EXISTS (SELECT 1 FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1 WHERE m.film_id=r.film_id) AS enabled FROM (SELECT s.film_id AS film_id,s.part AS part,s.source AS source,s.slot AS slot,s.due_since AS due_since,s.retry_at AS retry_at,COALESCE(s.retry_at,'') AS ra${stream.extra} FROM catalog_enrichment_state s WHERE s.cohort=? AND ${stream.where} AND COALESCE(s.retry_at,'')<=? AND (${stream.key})>(${tuple}) ORDER BY ${stream.key} LIMIT ?) AS r ORDER BY r.ra,r.due_since,r.film_id,r.part,r.source,r.slot`,[cohort,now,...cursor,window]);
    pages++;examined[cohort]+=rows.length;
    for(const row of rows){
     if(!Number(row.enabled)||skip.has(row.film_id))continue; // a disabled scope holds its work; a Film skipped in this run stays out of the run
     if(Number(row.disagree)||Number(row.locked)){blocked.push({filmId:row.film_id,part:row.part,why:Number(row.disagree)?'identity_disagreement':'owner_locked'});continue;}
     const known=picked.get(row.film_id);
     if(!known)found++; // DISTINCT Films: the repeated slots of one Film are one Film
     if(!known||row.due_since<known.dueSince)picked.set(row.film_id,{filmId:row.film_id,dueSince:row.due_since});
    }
    if(rows.length<window){exhausted=true;break;} // the index range is exhausted
    const last=rows[rows.length-1];
    cursor=stream===STREAMS.runnable?[last.ra,last.due_since,last.film_id,last.part,last.source,Number(last.slot)]:[last.ra,last.due_since,last.film_id];
   }
   if(!exhausted&&found===0){incomplete=true;cursors?.set(cursorKey,cursor);}else cursors?.delete(cursorKey);
  }
 }
 const facts=await relevanceFacts(handle,[...picked.keys()]);
 const out={live:[],background:[],blocked,examined,pages,incomplete};
 for(const entry of [...picked.values()].sort((a,b)=>a.dueSince<b.dueSince?-1:a.dueSince>b.dueSince?1:a.filmId<b.filmId?-1:1)){
  const fact=facts.get(entry.filmId);
  out[priorityClass({cohorts:fact.cohorts,personal:fact.personal,available:fact.available})].push({...entry,personal:fact.personal,available:fact.available});
 }
 return out;
}
// A new code version is a repair event: deferred repairable items of an OLDER version are pending a wake even while their retry is in the future. The reconcile counts this as runnable work, so a deploy alone starts the
// drainer that performs the wake; an item attempted by the running version records that version and is no longer pending.
export async function repairPending(env){
 const row=await one(database(env),"SELECT COUNT(*) AS n FROM catalog_enrichment_state WHERE status='deferred_repair' AND failure_class='repairable' AND retry_at IS NOT NULL AND COALESCE(code_version,'')<>?",[CODE_VERSION]);
 return Number(row?.n??0)>0;
}
// The narrow EPG yield (ADR 0219 decision 6, P4 = B). The evidence that an EPG publication or seal phase is ACTIVE AND PROGRESSING comes from the publication's OWN durable state, read at the write boundary:
//   - a stage of the published EPG (`published_epg_stage`) that is `loading` or `validated` and whose publisher claim is still live (`claim_expires_at` ahead): the staging and validation of a programme generation is in progress;
//   - the `held` cutover marker of the published EPG authority: the authority itself refuses concurrent writers;
//   - the EPG-held resolver lease (`discovery_lease` with `holder_kind = 'epg'` and an expiry ahead).
// A stage whose claim expired (a stalled publisher), a Discovery-held lease, no row and an unreadable row are NOT a hold: a failed or stalled EPG never holds enrichment and no timeout is invented. The hold ends the moment that state
// changes, so the caller re-checks on a SHORT interval (EPG_RECHECK_MS) instead of waiting for a lease expiry. -> {until: ms, evidence} or null.
export const EPG_RECHECK_MS=15000;
export const HOLD_CACHE_MS=5000;
export async function epgPublicationWindow(env,nowMs){
 const handle=database(env);
 const probe=async(sql,params=[])=>{try{return await one(handle,sql,params);}catch{return null;}};
 const stage=await probe("SELECT MAX(claim_expires_at) AS expiresAt FROM published_epg_stage WHERE state IN ('loading','validated') AND claim_expires_at IS NOT NULL AND claim_expires_at>?",[nowMs]);
 if(Number.isFinite(Number(stage?.expiresAt))&&Number(stage.expiresAt)>nowMs)return {until:Math.min(Number(stage.expiresAt),nowMs+EPG_RECHECK_MS),evidence:'epg_stage'};
 const held=await probe("SELECT 1 AS held FROM published_epg_authority WHERE id=1 AND cutover='held'");
 if(held?.held)return {until:nowMs+EPG_RECHECK_MS,evidence:'epg_cutover_held'};
 const lease=await probe("SELECT expires_at AS expiresAt FROM discovery_lease WHERE id=1 AND lease_id IS NOT NULL AND holder_kind='epg'");
 const until=Number(lease?.expiresAt);
 return Number.isFinite(until)&&until>nowMs?{until:Math.min(until,nowMs+EPG_RECHECK_MS),evidence:'epg_lease'}:null;
}
// Durable per-item deferral after a contention or authority-fence failure: a SHORT bounded backoff on the Film's due rows (1, 5, 15 minutes, then hourly; ADR 0098 tiers), guarded by the lease and the control generation. It sets no
// pending_since, consumes no failure and sets no cooldown: the 72 h fallback never counts a local failure. The Film resumes by itself when the retry is due.
export const DEFER_MINUTES=Object.freeze([1,5,15,60]);
export async function deferFilm(env,{filmId,leaseId,generation,now}){
 const row=await one(database(env),"SELECT MAX(transport_streak) AS streak FROM catalog_enrichment_state WHERE film_id=? AND ((status IN ('due','deferred_repair') AND part<>'film') OR (part='film' AND reason='check_anchors'))",[filmId]);
 const streak=Number(row?.streak??0)+1;
 const retryAt=new Date(Date.parse(now)+DEFER_MINUTES[Math.min(streak-1,DEFER_MINUTES.length-1)]*60000).toISOString();
 const guard=await repairGuard(null,leaseId,generation,now);
 await database(env).prepare(`UPDATE catalog_enrichment_state SET transport_streak=?,retry_at=?,updated_at=? WHERE film_id=? AND ((part<>'film' AND status IN ('due','deferred_repair')) OR (part='film' AND reason='check_anchors')) AND ${guard.sql}`).bind(streak,retryAt,now,filmId,...guard.params).run();
 return retryAt;
}
// Rows held back by an owner lock on the metadata or by an identity disagreement are not due work for anyone but the owner: they are deferred DURABLY for an hour (guarded by the lease and the control generation) so they leave the head
// of the index. They carry `reason = 'owner_blocked'`, which keeps them out of the due-time wake: nothing is waiting for the clock, only for the owner. The release of the lock or the anchor change reopens them at once (the reopening effect clears the retry time and the reason). At most DEFER_BLOCKED_LIMIT Films per pick, so the cleanup itself is bounded.
export const BLOCKED_DEFER_MS=3600000,DEFER_BLOCKED_LIMIT=20;
export async function deferBlocked(env,{blocked,leaseId,generation,now}){
 const films=[...new Map(blocked.map(item=>[item.filmId,item])).values()].slice(0,DEFER_BLOCKED_LIMIT);
 if(!films.length)return 0;
 const retryAt=new Date(Date.parse(now)+BLOCKED_DEFER_MS).toISOString();
 const guard=await repairGuard(null,leaseId,generation,now);
 let deferred=0;
 for(const item of films){
  const part=item.why==='owner_locked'?"AND part='core'":"AND part<>'film'";
  await database(env).prepare(`UPDATE catalog_enrichment_state SET retry_at=?,reason='owner_blocked',updated_at=? WHERE film_id=? ${part} AND status IN ('due','deferred_repair') AND (retry_at IS NULL OR retry_at<?) AND ${guard.sql}`).bind(retryAt,now,item.filmId,retryAt,...guard.params).run();
  deferred++;
 }
 return deferred;
}
// The earliest time a deferred item becomes runnable again, or null: the due time of a parked run.
export async function earliestWake(env,{now}){
 const row=await one(database(env),`SELECT MIN(s.retry_at) AS at FROM catalog_enrichment_state s WHERE s.film_id IN (SELECT m.film_id FROM catalog_enrichment_member m JOIN catalog_enrichment_scope c ON c.scope=m.scope AND c.enabled=1) AND s.part<>'film' AND s.status IN ('due','deferred_repair') AND COALESCE(s.reason,'')<>'owner_blocked' AND s.retry_at>?`,[now]);
 // A backed-off SIGNAL (a failed consume retries hourly) is a due-time too: the park wakes for it, so a pending signal never waits for the cron alone. Over-waking on a signal whose scope is off is harmless (the re-check finds nothing runnable).
 const sig=await one(database(env),"SELECT MIN(retry_at) AS at FROM enrichment_signal WHERE state='pending' AND acked_version<version AND retry_at IS NOT NULL");
 const times=[row?.at,sig?.at].filter(Boolean).sort();
 return times[0]??null;
}

// One run. opts: {runId, clock:()=>iso, tools, fetchImpl, coordinator, budget, shouldYield?:async()=>boolean, maxFilms?}. -> {stop, wakeAt?, counts}
export async function drain(rawEnv,{runId,clock=()=>new Date().toISOString(),tools,fetchImpl:rawFetch,coordinator=null,budget=BUDGET,shouldYield=null,maxFilms=Infinity}){
 // every request the sources actually send, a redirect hop included, is counted at the fetch boundary (a cooldown skip sends none)
 const sent={n:0};
 const fetchImpl=rawFetch?(...args)=>{sent.n++;return rawFetch(...args);}:rawFetch;
 const {env,counter}=countingEnv(rawEnv);
 // The background share is measured in COMMITTED units across runs (a handover must not reset it): the recent runs' outbox entries are the baseline.
 let baseLive=0,baseBackground=0;
 try{for(const row of await many(database(rawEnv),'SELECT counts_json FROM catalog_enrichment_tick ORDER BY started_at DESC LIMIT 20')){try{const c=JSON.parse(row.counts_json);baseLive+=Number(c.committedLive)||0;baseBackground+=Number(c.committedBackground)||0;}catch{/* a malformed entry counts as nothing */}}}catch{/* no outbox: no baseline */}
 const counts={films:0,signals:0,units:0,committedLive:0,committedBackground:0,statements:0,failedStatements:0,requests:0,transport:0,failed:0,disagreements:0,steps:0,errors:0,yields:0,deferred:0,bySource:{}};
 const holdCache={at:null,value:null},cursors=new Map();
 const finish=(stop,extra={})=>({stop,...extra,counts:{...counts,statements:counter.statements,failedStatements:counter.failed,requests:sent.n}});
 const control=await readControl(env);
 if(control.state!=='active')return finish(control.state==='paused'?'paused':'not_active');
 const generation=control.generation;
 const leaseId='lease-'+runId;
 const lease=await acquireLease(env,{leaseId,now:clock()});
 if(!lease.acquired)return finish('lease_held');
 const tickId=runId;
 const handle=database(env);
 try{await handle.prepare("INSERT INTO catalog_enrichment_tick (tick_id,started_at,state,counts_json) VALUES (?,?,'started','{}') ON CONFLICT(tick_id) DO NOTHING").bind(tickId,clock()).run();}catch{/* the outbox never blocks the work */}
 // A NEW CODE VERSION is a repair event (ADR 0219 decision 7): a deploy is not a causal change the Worker can hook, so the first run of a new version makes every deferred repairable item runnable at once, whatever its old retry_at.
 try{
  const lease=(await repairGuard(handle,leaseId,generation,clock()));
  await handle.prepare(`UPDATE catalog_enrichment_state SET retry_at=NULL,updated_at=? WHERE status='deferred_repair' AND failure_class='repairable' AND retry_at IS NOT NULL AND COALESCE(code_version,'')<>? AND ${lease.sql}`).bind(clock(),CODE_VERSION,...lease.params).run();
 }catch{/* a repair wake never blocks the run */}
 let result;
 // Films this run processed without any progress (blocked, waiting, nothing due): not picked again in this run, so a deferred or blocked Film can never keep a run spinning.
 const skip=new Set();
 try{
  result=await loop();
 }finally{
  try{await handle.prepare("UPDATE catalog_enrichment_tick SET state=?,finished_at=?,counts_json=? WHERE tick_id=?").bind(result?.stop==='handover'||result?.stop==='idle'||result?.stop==='parked'?'finished':'stopped',clock(),JSON.stringify({...(result?.counts||counts),stop:result?.stop||'error',budget:{statements:budget.statements,handoverAt:budget.handoverAt}}),tickId).run();}catch{/* best effort */}
  try{await releaseLease(env,{leaseId,now:clock()});}catch{/* the lease expires */}
 }
 return result;

 async function loop(){
  for(;;){
   // a step starts only when the remaining budget covers its own work plus the reserve (no whole-Film-fit rule: a Film spans as many steps and runs as it needs)
   if(counter.statements+budget.stepEstimate+budget.reserve>budget.statements||counter.statements>=budget.handoverAt||(budget.requestsHandoverAt&&sent.n>=budget.requestsHandoverAt))return finish('handover');
   const fresh=await readControl(env);
   if(fresh.state==='paused')return finish('paused');
   if(fresh.state!=='active')return finish('not_active');
   if(fresh.generation!==generation)return finish('generation_moved');
   if(!await renewLease(env,{leaseId,now:clock()}))return finish('lease_lost');
   // (the narrow yield is decided below, after the inbox: signal consumption and anchor planning write only the producer's own state, never canonical Film or Person state)
   // the inbox first: runnable signals are consumed exactly once, each by one guarded batch; one failing signal never blocks the others
   let consumed=0;
   for(const signal of await runnableSignals(env,{now:clock(),limit:50})){
    // the inbox is budgeted like every other statement: what the budget cannot cover stays pending for the successor (it is durable and re-armed by nothing)
    if(counter.statements+budget.reserve>=budget.statements||counter.statements>=budget.handoverAt)break;
    const outcome=await consumeSignal(env,{signal,generation,leaseId,now:clock()});
    if(outcome.consumed){consumed++;counts.signals++;}
   }
   const due=await dueFilms(env,{now:clock(),skip,cursors});
   let cleared=0;
   if(due.blocked.length){try{cleared=await deferBlocked(env,{blocked:due.blocked,leaseId,generation,now:clock()});counts.deferred+=cleared;}catch{/* the in-run pass still excludes them: they are not picked */}}
   const klass=nextClass({hasLive:due.live.length>0,hasBackground:due.background.length>0,committedLive:baseLive+counts.committedLive,committedBackground:baseBackground+counts.committedBackground});
   if(!klass){
    if(consumed)continue; // new work may have become due by the signals just consumed
    // progress without a pick is still progress: rows were deferred out of the head, or a stream stopped at its page budget and continues from its cursor; both are bounded by the statement budget, which hands over
    if(cleared>0||due.incomplete)continue;
    const wakeAt=await earliestWake(env,{now:clock()});
    return wakeAt?finish('parked',{wakeAt}):finish('idle');
   }
   if(counts.films>=maxFilms)return finish('handover');
   const pick=due[klass][0];
   let step;
   // the unit-group gate: before EVERY group of units of a Film the producer asks whether the remaining budget covers it plus the finalize-and-successor reserve (no whole-Film-fit rule: a Film resumes from its persisted state)
   let held=null;
   const gate={canStart:()=>counter.statements+(budget.unitEstimate||60)+budget.reserve<=budget.statements&&counter.statements<budget.handoverAt&&(!budget.requestsHandoverAt||sent.n<budget.requestsHandoverAt),
    // the narrow yield, asked at the WRITE boundary (see processFilm): an injected predicate for offline runs, the publication's own state otherwise
    // the answer is reused for HOLD_CACHE_MS of the run's own clock: every write boundary would otherwise repeat three reads. A publication that starts inside the window can see a few more enrichment writes, which the canonical
    // Film/Person authority fence in each write batch still serializes; the hold is a courtesy to the publication, not a correctness fence.
    writesHeld:async()=>{
     const nowMs=Date.parse(clock());
     if(holdCache.at!==null&&nowMs-holdCache.at<HOLD_CACHE_MS&&!shouldYield){if(holdCache.value){held=holdCache.value;return true;}return false;}
     const hold=shouldYield?await shouldYield():await epgPublicationWindow(env,nowMs);
     holdCache.at=nowMs;holdCache.value=hold||null;
     if(hold){held=hold;return true;}return false;}};
   try{step=await processFilm(env,{filmId:pick.filmId,leaseId,generation,now:clock(),tools,fetchImpl,coordinator,budget:gate});}
   catch(error){
    // Reactive yield (ADR 0219 decision 6): a storage or authority failure defers THIS Film for the rest of the run and the independent work continues; repeated failures back the whole run off. Never a crash.
    counts.errors++;skip.add(pick.filmId);counts.lastError=String(error?.code||'error').slice(0,80);
    try{await deferFilm(env,{filmId:pick.filmId,leaseId,generation,now:clock()});counts.deferred++;}catch{/* the in-run skip still holds */}
    if(counts.errors>=3)return finish('error_backoff');
    continue;
   }
   counts.steps++;
   if(step.state==='not_active')return finish('generation_moved');
   if(step.report){
    counts.films++;
    const committed=step.report.units.filter(unit=>['applied'].includes(unit.state)).length;
    counts.units+=committed;
    if(klass==='live')counts.committedLive+=committed;else counts.committedBackground+=committed;
    counts.transport+=step.report.transport.length;counts.failed+=step.report.failed.length;if(step.report.disagreement)counts.disagreements++;
    // per SOURCE: requests actually asked (a cooldown skip sends none), transport outcomes, definite failures and cooldown skips
    for(const source of step.report.fetched||[]){const entry=(counts.bySource[source]||={requests:0,transport:0,failed:0,cooldownSkips:0});const skipped=step.report.transport.some(item=>item.source===source&&item.cooldown);if(skipped)entry.cooldownSkips++;else entry.requests++;}
    for(const item of step.report.transport){const entry=(counts.bySource[item.source]||={requests:0,transport:0,failed:0,cooldownSkips:0});entry.transport++;}
    for(const item of step.report.failed){const entry=(counts.bySource[item.source]||={requests:0,transport:0,failed:0,cooldownSkips:0});entry.failed++;}
   }
   if(['idle','blocked','not_admitted','absent','redirected'].includes(step.state)||(step.state==='done'&&!step.report.units.length))skip.add(pick.filmId);
   if(step.state==='partial'&&held){
    // the Film stopped at a held write boundary with its progress durable; no further Film is started in this run (each would stop at the same boundary), and the run parks for a SHORT re-check, not until a lease expiry
    counts.yields++;
    const until=typeof held==='object'&&Number.isFinite(held.until)?held.until:Date.parse(clock())+EPG_RECHECK_MS;
    return finish('yield',{wakeAt:new Date(Math.max(until,Date.parse(clock())+1000)).toISOString(),reason:typeof held==='object'&&held.evidence?held.evidence:'epg_publication'});
   }
   if(step.state==='partial')return finish('handover'); // progress is durable per unit: the successor resumes this Film from D1, without a new upstream request
   // a Film that made no progress (blocked, a parked source, a replan that only settled a marker) leaves the head by its own retry_at or state; a replan is cheap and continues at once
   if(step.state==='absent'||step.state==='redirected'||step.state==='not_admitted')await handle.prepare("UPDATE catalog_enrichment_state SET reason=NULL WHERE film_id=? AND part='film' AND reason='check_anchors'").bind(pick.filmId).run().catch(()=>{});
  }
 }
}
