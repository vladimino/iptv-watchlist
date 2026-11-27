// AIR-605 (card C1; ADR 0211 as amended by ADR 0219). The PRODUCER STEP: one Film's due enrichment work, from its anchors to its receipted units and its state rows. DORMANT: nothing in the Worker imports it; without a control
// row in `active` every call answers `not_active` before any request. It never creates, merges or redirects a Film and never writes a claim, an alias or `canonical_identity`.
//   anchors -> applicable sources -> (one request round per applicable source, in parallel) -> decideCore / localization / credits (pure planner) -> receipted units (fill-only, add-only, every guard inside the batch) -> state.
// Every state write asserts the lease and the control generation; the units additionally assert the anchor set, the plan epoch and the metadata lock. A stale plan therefore writes nothing and is replanned.
import {database,failed,many,one} from './film-person-authority.js';
import {Plan} from './catalog-enrichment-plan.js';
import {readControl} from './catalog-enrichment-store.js';
import {runUnit as runUnitRaw,unitKeys} from './catalog-enrichment-units.js';
import {fetchLetterboxd,fetchTmdb,fetchWikidata} from './catalog-enrichment-sources.js';

export const CODE_VERSION='c1-2';
export const REPAIR_WAKE_LIMIT=20;
export const REPAIR_WAKE_MIN_AGE_MS=15*60000;
const CORE_FIELDS=Plan.CORE_FIELDS;
const db=env=>{const handle=database(env);if(!handle)throw failed('film_person_unavailable');return handle;};
const parse=text=>{if(text==null)return null;try{return JSON.parse(text);}catch{return null;}};
const json=value=>value==null?null:JSON.stringify(value);
const guardSql=ctx=>{const lease=Plan.leaseGuard(ctx.leaseId,ctx.now),control=Plan.controlGuard(ctx.generation);return {sql:`${lease.sql} AND ${control.sql}`,params:[...lease.params,...control.params]};};
const sha=value=>Plan.digestOf(value);
// The refusals of a batch whose guards no longer hold (a stale plan) or whose authority fence moved: retryable by a replan, never a failure of the Film and never a crash of the run.
export const STALE_CODES=new Set(['film_person_precondition','film_person_fence','film_person_revision_conflict','operation_key_moved','operation_key_in_flight','localization_inputs_moved']);
async function runUnit(env,spec){
 try{return await runUnitRaw(env,spec);}
 catch(error){
  if(STALE_CODES.has(error?.code))return {state:'stale',code:error.code};
  throw error;
 }
}

// ---- state rows ----
const COLUMNS='film_id,part,source,slot,status,reason,cohort,anchor,source_version,refresh_epoch,plan_epoch,failures,transport_streak,failure_class,failure_signature,code_version,response_digest,pending_since,retry_at,due_since,expected_json,gaps_json,conflicts_json,hints_json,film_json,updated_at';
export const rowView=row=>row&&{filmId:row.film_id,part:row.part,source:row.source,slot:Number(row.slot),status:row.status,reason:row.reason,cohort:row.cohort,anchor:row.anchor,sourceVersion:row.source_version,refreshEpoch:Number(row.refresh_epoch),planEpoch:Number(row.plan_epoch),failures:Number(row.failures),transportStreak:Number(row.transport_streak),failureClass:row.failure_class,failureSignature:row.failure_signature,codeVersion:row.code_version,responseDigest:row.response_digest,pendingSince:row.pending_since,retryAt:row.retry_at,dueSince:row.due_since,expected:parse(row.expected_json),gaps:parse(row.gaps_json),conflicts:parse(row.conflicts_json),hints:parse(row.hints_json),film:parse(row.film_json),updatedAt:row.updated_at};
export async function readRows(env,filmId){return (await many(db(env),`SELECT ${COLUMNS} FROM catalog_enrichment_state WHERE film_id=?`,[filmId])).map(rowView);}
const key=row=>[row.part,row.source,row.slot??0].join('|');
// Insert a missing row or update the one the plan read, guarded by lease and control; an update is also matched on the row's `refresh_epoch` (an older plan changes nothing).
function rowStatement(ctx,row,{expectEpoch=null}={}){
 const guard=guardSql(ctx);
 const values=[row.filmId,row.part,row.source,row.slot??0,row.status,row.reason??null,row.cohort||'live',row.anchor??null,row.sourceVersion??null,row.refreshEpoch??0,row.planEpoch??0,row.failures??0,row.transportStreak??0,row.failureClass??null,row.failureSignature??null,CODE_VERSION,row.responseDigest??null,row.pendingSince??null,row.retryAt??null,row.dueSince||ctx.now,json(row.expected),json(row.gaps),json(row.conflicts),json(row.hints),json(row.film),ctx.now];
 const update='status=excluded.status,reason=excluded.reason,anchor=excluded.anchor,source_version=excluded.source_version,refresh_epoch=excluded.refresh_epoch,plan_epoch=excluded.plan_epoch,failures=excluded.failures,transport_streak=excluded.transport_streak,failure_class=excluded.failure_class,failure_signature=excluded.failure_signature,code_version=excluded.code_version,response_digest=excluded.response_digest,pending_since=excluded.pending_since,retry_at=excluded.retry_at,expected_json=excluded.expected_json,gaps_json=excluded.gaps_json,conflicts_json=excluded.conflicts_json,hints_json=excluded.hints_json,film_json=excluded.film_json,updated_at=excluded.updated_at';
 const epoch=expectEpoch===null?'':row.part==='film'?` AND catalog_enrichment_state.plan_epoch=?`:` AND catalog_enrichment_state.refresh_epoch=?`;
 const statement=`INSERT INTO catalog_enrichment_state (${COLUMNS}) SELECT ${values.map(()=>'?').join(',')} WHERE ${guard.sql} ON CONFLICT(film_id,part,source,slot) DO UPDATE SET ${update} WHERE ${guard.sql}${epoch}`;
 return [statement,[...values,...guard.params,...guard.params,...(expectEpoch===null?[]:[expectEpoch])]];
}
async function putRow(env,ctx,row,options){
 const [statement,params]=rowStatement(ctx,row,options);
 await db(env).prepare(statement).bind(...params).run();
}
// ATOMIC publication of several rows: one D1 batch is one transaction, so a published plan is wholly there or wholly absent (never a prefix).
async function putRowsAtomic(env,ctx,rows,extra=[]){
 const handle=db(env);
 await handle.batch([...rows.map(row=>rowStatement(ctx,row)),...extra].map(([statement,params])=>handle.prepare(statement).bind(...params)));
}

// ---- reading what a plan needs ----
async function readContext(env,filmId){
 const handle=db(env);
 const film=await one(handle,'SELECT id,contract_version FROM film WHERE id=?',[filmId]);
 if(!film)return null;
 if(await one(handle,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[filmId]))return {redirected:true};
 const anchorRows=await many(handle,`SELECT e.scheme,e.value,e.trusted,e.conflicting,EXISTS (SELECT 1 FROM film_external_id o WHERE o.scheme=e.scheme AND o.value=e.value AND o.trusted=1 AND o.film_id<>e.film_id) AS other_owner,EXISTS (SELECT 1 FROM tmdb_retirement_decision r WHERE e.scheme='tmdb' AND r.film_id=e.film_id AND r.movie_id=e.value AND r.kind='retire' AND NOT EXISTS (SELECT 1 FROM tmdb_retirement_decision s WHERE s.supersedes_seq=r.seq)) AS retired FROM film_external_id e WHERE e.film_id=? AND e.scheme IN ('tmdb','letterboxd') AND e.trusted=1`,[filmId]);
 const anchors=Plan.computeAnchors(anchorRows.map(row=>({scheme:row.scheme,value:row.value,trusted:row.trusted,conflicting:row.conflicting,otherOwner:!!row.other_owner,retired:!!row.retired})));
 const metadata=await one(handle,'SELECT year,runtime,synopsis,poster,url,genres_json FROM film_metadata WHERE film_id=?',[filmId]);
 const stored={year:metadata?.year??null,runtime:metadata?.runtime??null,synopsis:metadata?.synopsis??null,poster:metadata?.poster??null,url:metadata?.url??null,genres:parse(metadata?.genres_json)||[]};
 const locked=!!await one(handle,"SELECT 1 AS x FROM film_dimension WHERE film_id=? AND dimension='metadata' AND (status='reviewed' OR COALESCE(authority,'')='owner')",[filmId]);
 const credits=await many(handle,'SELECT person_id,role FROM film_person_credit WHERE film_id=?',[filmId]);
 return {film:{id:film.id,contractVersion:Number(film.contract_version)},anchors,stored,locked,credits,rows:await readRows(env,filmId)};
}
const lockGuard=filmId=>({sql:"NOT EXISTS (SELECT 1 FROM film_dimension WHERE film_id=? AND dimension='metadata' AND (status='reviewed' OR COALESCE(authority,'')='owner'))",params:[filmId]});

// ---- the step ----
// Processes ONE Film. ctx: {leaseId, generation, now, tools, fetchImpl, coordinator, env}. -> {state:'not_active'|'absent'|'blocked'|'done', ...}
// `budget` (optional): {canStart:()=>boolean}, the resource-bounded drainer's own answer to "does the remaining statement budget cover one more unit group plus the finalize-and-successor reserve". It is asked before EVERY unit
// group of a Film (core, a localization row, each Person, each credits chunk): a Film spans as many steps and instances as it needs, progress is durable per unit, and nothing here caps credits or Films.
export async function processFilm(env,{filmId,leaseId,generation,now,tools,fetchImpl=fetch,coordinator=null,budget=null}){
 const canStart=()=>!budget||budget.canStart();
 const partial=(report,reason='budget')=>({state:'partial',report:{...report,partial:reason}});
 // The WRITE BOUNDARY: before every group of canonical writes the drainer is asked (1) whether the remaining statement budget covers it and (2) whether a progressing EPG publication holds the writes. Fetching, anchor checks and the planning rows above
 // this boundary are not held; a held boundary stops the Film here with everything persisted so far, and the Film resumes from D1 when the hold ends.
 const mayWrite=async()=>{if(!canStart())return 'budget';if(budget&&typeof budget.writesHeld==='function'&&await budget.writesHeld())return 'held';return null;};
 const control=await readControl(env);
 if(control.state!=='active'||control.generation!==generation)return {state:'not_active'};
 const ctx={leaseId,generation,now};
 const context=await readContext(env,filmId);
 if(!context)return {state:'absent'};
 if(context.redirected)return {state:'redirected'};
 const report={written:[],units:[],transport:[],failed:[],disagreement:null,gaps:[],conflicts:[],hints:[]};
 const applicable=Plan.applicableSources(context.anchors);
 const digest=await Plan.anchorDigest(context.anchors);
 const byKey=new Map(context.rows.map(row=>[key(row),row]));
 let filmRow=byKey.get('film|*|0');
 if(!filmRow)return {state:'not_admitted'};
 const known=filmRow.film||{};
 // The anchor check (decision 3b): a changed digest raises the plan epoch. An anchor VALUE change of a source that stays applicable is an identity correction: every row is invalidated, the agreement and a disagreement
 // are lifted, and credits this producer wrote are held for the owner; values written under the old anchor stay and are listed.
 if(known.anchorDigest!==digest){
  const previous=known.anchors||{};
  const nowAnchors={letterboxd:context.anchors.letterboxd?.value??null,tmdb:context.anchors.tmdb?.value??null};
  const corrected=['letterboxd','tmdb'].some(scheme=>previous[scheme]&&nowAnchors[scheme]&&previous[scheme]!==nowAnchors[scheme]);
  const next={...known,anchorDigest:digest,anchors:nowAnchors,anchorCheckedAt:now,applicable};
  if(corrected){
   next.agreedAnchorDigest=null;next.disagreement=null;
   const superseded=context.rows.filter(row=>row.part==='credits'&&row.status!=='not_applicable'&&row.film?.wroteCredits);
   next.writtenUnderSupersededAnchor=[...(known.writtenUnderSupersededAnchor||[]),...(known.writtenFields||[]).map(field=>({field,anchor:previous}))];
   for(const row of context.rows.filter(item=>item.part!=='film')){
    const held=row.part==='credits'&&row.film?.wroteCredits;
    await putRow(env,ctx,{...row,status:held?'needs_attention':'due',reason:held?'superseded_credits':null,failures:0,transportStreak:0,pendingSince:null,retryAt:null,expected:null,refreshEpoch:row.refreshEpoch+1},{expectEpoch:row.refreshEpoch});
   }
   void superseded;
  }
  // the marker stays until the second pass has created or reopened the rows: a Film whose rows do not exist yet must stay in the queue
  filmRow={...filmRow,status:corrected?'active':filmRow.status,reason:'check_anchors',retryAt:null,planEpoch:filmRow.planEpoch+1,film:next};
  await putRow(env,ctx,filmRow,{expectEpoch:filmRow.planEpoch-1});
  return {state:'replan',reason:corrected?'identity_corrected':'anchors_changed'};
 }
 // the anchors are unchanged: the pending anchor-check marker of an admission or an anchor signal is settled
 if(filmRow.reason==='check_anchors'){filmRow={...filmRow,reason:null,retryAt:null,transportStreak:0};await putRow(env,ctx,filmRow,{expectEpoch:filmRow.planEpoch});}
 if(filmRow.status==='identity_disagreement')return {state:'blocked',reason:'identity_disagreement'};
 // the rows of the applicable sources; a missing one is created due, a removed source becomes not_applicable (its earlier writes remain)
 const need=[];
 // the cohort of a Film's rows follows its retained memberships: a Film in any live scope (rated, Watchlist, Discovery) is `live`; one held only by the historical widening is `history` (decision 5)
 const memberScopes=(await many(db(env),'SELECT scope FROM catalog_enrichment_member WHERE film_id=?',[filmId])).map(row=>row.scope);
 const cohort=memberScopes.length&&!memberScopes.some(scope=>['rated','c3b','discovery'].includes(scope))?'history':'live';
 for(const source of Plan.SOURCES){
  const isApplicable=applicable.includes(source);
  const parts=source==='wikidata'?['localization']:['core','credits','localization'];
  for(const part of parts){
   const row=byKey.get([part,source,0].join('|'));
   if(isApplicable&&!row)need.push({filmId,part,source,slot:0,status:'due',planEpoch:0,refreshEpoch:0,anchor:source==='letterboxd'?context.anchors.letterboxd.value:context.anchors.tmdb.value,dueSince:now,cohort});
   else if(!isApplicable&&row&&row.status!=='not_applicable')await putRow(env,ctx,{...row,status:'not_applicable',reason:'source_not_applicable'},{expectEpoch:row.refreshEpoch});
  }
 }
 for(const row of need){await putRow(env,ctx,row);byKey.set(key(row),row);}
 const rowOf=(part,source,slot=0)=>byKey.get([part,source,slot].join('|'));
 // The sources that have due work now. A row whose retry is in the future is not asked again; it counts as pending (transport) for the precedence rule.
 const dueRows=[...byKey.values()].filter(row=>row.part!=='film'&&applicable.includes(row.source)&&['due','deferred_repair'].includes(row.status)&&(!row.retryAt||row.retryAt<=now));
 // A credits chunk row that already holds its persisted expected set is RESUMED from D1: completing persisted units never makes an upstream request.
 // A PUBLISHED credits plan: every slot 0..total-1 of ONE source holds the same expected-set digest and the same total. A partial or mixed set of chunk rows (a crash, an old slot) is NOT a plan and is never resumed:
 // it is replaced by a fresh fetch. Only the due rows of a published plan are resumed from D1.
 const publishedPlan=source=>{
  const rows=[...byKey.values()].filter(row=>row.part==='credits'&&row.source===source&&row.status!=='not_applicable'&&row.expected&&Array.isArray(row.expected.items));
  if(!rows.length)return null;
  const total=rows[0].expected.total,digest=rows[0].expected.digest;
  if(!Number.isInteger(total)||total<1||rows.length!==total||!rows.every(row=>row.expected.total===total&&row.expected.digest===digest))return null;
  const slots=new Set(rows.map(row=>row.slot));
  for(let i=0;i<total;i++)if(!slots.has(i))return null;
  return {total,digest,rows:rows.sort((a,b)=>a.slot-b.slot)};
 };
 const plans=Object.fromEntries(Plan.SOURCES.map(source=>[source,publishedPlan(source)]));
 const resumeRows=dueRows.filter(row=>row.part==='credits'&&plans[row.source]&&plans[row.source].rows.includes(row));
 const toFetch=[...new Set(dueRows.filter(row=>!resumeRows.includes(row)).map(row=>row.source))];
 if(!toFetch.length&&!resumeRows.length)return {state:'idle'};
 report.fetched=[...toFetch];
 const lbAnchor=context.anchors.letterboxd,tmdbAnchor=context.anchors.tmdb;
 const answers={};
 await Promise.all(toFetch.map(async source=>{
  if(source==='letterboxd')answers.letterboxd=await fetchLetterboxd(env,{lid:lbAnchor.value,tmdbAnchor:tmdbAnchor?.value??null,coordinator,fetchImpl,tools});
  else if(source==='tmdb')answers.tmdb=await fetchTmdb(env,{id:tmdbAnchor.value,coordinator,fetchImpl});
  else answers.wikidata=await fetchWikidata(env,{tmdbId:tmdbAnchor.value,coordinator,fetchImpl});
 }));
 // outcomes onto every row of the source
 for(const [source,answer] of Object.entries(answers)){
  const rows=[...byKey.values()].filter(row=>row.source===source&&row.part!=='film'&&['due','deferred_repair'].includes(row.status));
  const outcome=answer.status==='ok'?{type:'success'}:answer.status==='transport'?{type:'transport',cooldownUntil:answer.cooldownUntil}:answer.status==='disagreement'?{type:'owner_required'}:{type:'repairable',signature:answer.reason,responseDigest:await sha({source,reason:answer.reason,status:answer.httpStatus??null})};
  if(answer.status==='transport')report.transport.push({source,reason:answer.reason,cooldown:answer.reason==='upstream_cooldown'});
  if(answer.status==='failed')report.failed.push({source,reason:answer.reason});
  // Success is classified PER APPLICABLE PART: a 200 whose translations or credits section is unreadable is not a recovery of that part, so its counter is preserved here and incremented by the section-specific outcome below
  // (repeated identical malformed responses therefore reach quarantine instead of sitting at one failure).
  const sectionOk=row=>answer.status!=='ok'||(row.part==='localization'?!(answer.title&&answer.title.status==='unreadable'):row.part==='credits'?answer.credits?.status!=='unreadable':true);
  for(const row of rows){
   if(!sectionOk(row))continue;
   const next=Plan.afterOutcome(row,outcome,now);
   if(answer.status==='disagreement')next.status='due'; // the Film row carries the disagreement; the part rows stay due until the owner retries
   if(JSON.stringify(next)!==JSON.stringify(row)){await putRow(env,ctx,next,{expectEpoch:row.refreshEpoch});byKey.set(key(row),next);}
  }
 }
 // SOURCE RECOVERY (ADR 0219 decision 7), classified per part and BOUNDED: a valid section of a source wakes only the deferred repairable items of THAT part and source in other Films, at most REPAIR_WAKE_LIMIT per success, and
 // only items whose last attempt is older than REPAIR_WAKE_MIN_AGE_MS, so repeated unrelated successes cannot create a hot loop; settled parts are untouched.
 for(const [source,answer] of Object.entries(answers))if(answer.status==='ok'){
  const valid={core:true,localization:!(answer.title&&answer.title.status==='unreadable'),credits:answer.credits?.status==='ok'};
  const guard=guardSql(ctx),cutoff=new Date(Date.parse(now)-REPAIR_WAKE_MIN_AGE_MS).toISOString();
  for(const part of Object.keys(valid))if(valid[part])await db(env).prepare(`UPDATE catalog_enrichment_state SET retry_at=NULL,updated_at=? WHERE rowid IN (SELECT rowid FROM catalog_enrichment_state WHERE part=? AND source=? AND status='deferred_repair' AND failure_class='repairable' AND retry_at IS NOT NULL AND retry_at>? AND film_id<>? AND updated_at<=? ORDER BY updated_at LIMIT ?) AND ${guard.sql}`).bind(now,part,source,now,filmId,cutoff,REPAIR_WAKE_LIMIT,...guard.params).run().catch(()=>{});
 }
 // a page disagreement stops every source for this Film (decision 2): nothing is written
 const disagreement=Object.values(answers).find(answer=>answer.status==='disagreement');
 if(disagreement){
  report.disagreement={reasons:disagreement.reasons,hints:disagreement.hints};
  await putRow(env,ctx,{...filmRow,status:'identity_disagreement',planEpoch:filmRow.planEpoch,film:{...known,disagreement:{reasons:disagreement.reasons,at:now,source:'letterboxd'}}},{expectEpoch:filmRow.planEpoch});
  return {state:'blocked',reason:'identity_disagreement',report};
 }
 const letterboxdAnswer=answers.letterboxd;
 let agreed=known.agreedAnchorDigest===digest;
 if(letterboxdAnswer?.status==='ok'&&letterboxdAnswer.agreed){agreed=true;if(known.agreedAnchorDigest!==digest){filmRow={...filmRow,film:{...(filmRow.film||{}),agreedAnchorDigest:digest,anchorCheckedAt:now}};await putRow(env,ctx,filmRow,{expectEpoch:filmRow.planEpoch});}}
 if(letterboxdAnswer?.hints?.length)report.hints.push(...letterboxdAnswer.hints);
 const hasLb=!!lbAnchor;
 const pendingSince=Object.fromEntries(['letterboxd','tmdb'].map(source=>[source,rowOf('core',source)?.pendingSince||null]));
 // a source with a future retry that was not asked this tick is pending transport (its pending_since decides the fallback), never a local failure
 const asAnswer=source=>{
  if(!applicable.includes(source))return undefined;
  const answer=answers[source];
  if(answer){return answer.status==='ok'?{status:'ok',fields:answer.fields}:answer.status==='transport'?{status:'transport'}:{status:'failed'};}
  const row=rowOf('core',source);
  if(row&&['complete','complete_with_gaps'].includes(row.status))return {status:'ok',fields:{}};
  return row?.pendingSince?{status:'transport'}:{status:'stopped'};
 };
 const coreAnswers={letterboxd:asAnswer('letterboxd'),tmdb:asAnswer('tmdb')};
 const stored=context.stored;
 const core=Plan.decideCore({applicable,hasLetterboxdAnchor:hasLb,agreed,disagreement:false,stored,answers:coreAnswers,pendingSince,now});
 report.conflicts.push(...core.conflicts);
 const metadataEligible=!context.locked&&dueRows.some(row=>row.part==='core');
 const writeFields=Object.keys(core.writes);
 if(metadataEligible&&writeFields.length){
  const sourceRow=rowOf('core',core.writes[writeFields[0]].source);
  const sync=CORE_FIELDS.every(field=>!Plan.blank(stored[field])||core.writes[field]);
  const anchorGuard=Plan.anchorSetGuard(filmId,context.anchors);
  const guards=[...writeFields.map(field=>Plan.blankFieldGuard(filmId,field)),anchorGuard,Plan.epochGuard(filmId,{part:'core',source:sourceRow.source,refreshEpoch:sourceRow.refreshEpoch,planEpoch:filmRow.planEpoch}),lockGuard(filmId),Plan.leaseGuard(leaseId,now),Plan.controlGuard(generation)];
  const metadata={updatedAt:now,...Object.fromEntries(writeFields.map(field=>[field,core.writes[field].value]))};
  const input={id:filmId,at:now,film:{contractVersion:context.film.contractVersion},metadata,...(sync?{sync:{metadataAt:now}}:{}),requireExisting:true,guards};
  {const stop=await mayWrite();if(stop)return partial(report,stop);}
  const unit=await runUnit(env,{kind:'facts',unitKey:unitKeys.core(filmId),input,now:()=>now});
  report.units.push({part:'core',state:unit.state});
  if(['applied','noop','settled'].includes(unit.state)){
   report.written.push(...writeFields);
   const next=[...byKey.values()].filter(row=>row.part==='core'&&applicable.includes(row.source));
   for(const row of next){
    const complete=core.complete||CORE_FIELDS.every(field=>!Plan.blank(stored[field])||core.writes[field]);
    await putRow(env,ctx,{...row,status:complete?(core.gaps.length?'complete_with_gaps':'complete'):row.status,gaps:core.gaps,conflicts:core.conflicts,hints:report.hints,sourceVersion:await sha({source:row.source,anchor:row.anchor,fields:answers[row.source]?.fields||null}),failures:0,transportStreak:0,pendingSince:null,retryAt:null,film:{...(row.film||{}),fallbackFill:core.fallbackFill,unconfirmedAgreement:core.unconfirmedAgreement}},{expectEpoch:row.refreshEpoch});
   }
   if(core.fallbackFill.length||core.unconfirmedAgreement.length||core.storedDiffers.length){
    const refreshed=(await readRows(env,filmId)).find(row=>row.part==='film');
    await putRow(env,ctx,{...refreshed,film:{...(refreshed.film||{}),fallbackFill:core.fallbackFill,unconfirmedAgreement:core.unconfirmedAgreement,storedDiffers:core.storedDiffers,writtenFields:[...new Set([...(refreshed.film?.writtenFields||[]),...writeFields])]}},{expectEpoch:refreshed.planEpoch});
   }
  }
 }
 // ---- localization: each applicable source writes its OWN row, needing only its own anchor ----
 for(const source of Plan.SOURCES){
  const row=rowOf('localization',source);
  const answer=answers[source];
  if(!row||!answer||answer.status!=='ok'||!['due','deferred_repair'].includes(row.status))continue;
  const title=answer.title;
  // a missing or malformed section is a REPAIRABLE failure: it backs off (1 h, 6 h, 24 h at the cap) and counts, never an immediate endless retry
  if(!title||title.status==='unreadable'){await putRow(env,ctx,{...Plan.afterOutcome(row,{type:'repairable',signature:'unreadable_translations',responseDigest:await sha({source,reason:'unreadable_translations'})},now),reason:'unreadable_translations'},{expectEpoch:row.refreshEpoch});continue;}
  if(title.status==='ambiguous'){await putRow(env,ctx,{...row,status:'needs_attention',reason:'ambiguous_translation',failureClass:'owner_required'},{expectEpoch:row.refreshEpoch});continue;}
  // unsupported coverage (the Letterboxd page has no typed title): the source cannot supply this part, which is neither a failure nor a verified absence
  if(title.status==='unsupported'){await putRow(env,ctx,{...row,status:'not_applicable',reason:'no_typed_title_in_source',failures:0,retryAt:null,pendingSince:null},{expectEpoch:row.refreshEpoch});continue;}
  if(title.status==='absent'){await putRow(env,ctx,{...row,status:'complete_with_gaps',reason:'no_russian_title',gaps:['no_russian_title'],failures:0,retryAt:null,pendingSince:null},{expectEpoch:row.refreshEpoch});continue;}
  const sourceVersion=await sha({source,anchor:row.anchor,title:title.value});
  const input={id:filmId,at:now,film:{contractVersion:context.film.contractVersion},localization:{sources:[{source,value:title.value,sourceVersion,observedAt:now,provenance:{anchor:row.anchor}}]},requireExisting:true,
   guards:[Plan.anchorSetGuard(filmId,context.anchors),Plan.epochGuard(filmId,{part:'localization',source,refreshEpoch:row.refreshEpoch,planEpoch:filmRow.planEpoch}),Plan.leaseGuard(leaseId,now),Plan.controlGuard(generation)]};
  {const stop=await mayWrite();if(stop)return partial(report,stop);}
  const unit=await runUnit(env,{kind:'facts',unitKey:unitKeys.localization(filmId,source),input,now:()=>now});
  report.units.push({part:'localization',source,state:unit.state});
  if(['applied','noop','settled'].includes(unit.state))await putRow(env,ctx,{...row,status:'complete',sourceVersion,failures:0,retryAt:null,pendingSince:null,reason:null},{expectEpoch:row.refreshEpoch});
 }
 // ---- credits: one namespace per Film, the expected set paged into chunk rows, Persons first ----
 const creditsDue=dueRows.some(row=>row.part==='credits');
 // a complete response whose credits section is unreadable is repairable too: it backs off and is rechecked, never read as "no credits"
 {const source=['letterboxd','tmdb'].find(name=>answers[name]?.status==='ok'&&answers[name].credits?.status==='unreadable');
  const row=source&&rowOf('credits',source);
  if(row&&['due','deferred_repair'].includes(row.status))await putRow(env,ctx,{...Plan.afterOutcome(row,{type:'repairable',signature:'unreadable_credits',responseDigest:await sha({source,reason:'unreadable_credits'})},now),reason:'unreadable_credits'},{expectEpoch:row.refreshEpoch});}
 const choice=Plan.creditSource(context.credits.map(item=>item.person_id),applicable);
 // the credit source is fixed by the first plan and never reopened for another source: the other applicable sources have no credits to give
 if(choice.source)for(const row of [...byKey.values()].filter(item=>item.part==='credits'&&item.source!==choice.source&&['due','deferred_repair'].includes(item.status)))await putRow(env,ctx,{...row,status:'not_applicable',reason:'other_credit_source',retryAt:null},{expectEpoch:row.refreshEpoch});
 if(creditsDue&&choice.gap){report.gaps.push(choice.gap);await putRow(env,ctx,{...rowOf('credits',choice.source||'letterboxd')||{filmId,part:'credits',source:'letterboxd',slot:0,dueSince:now,cohort:'live',planEpoch:0,refreshEpoch:0},status:'complete_with_gaps',reason:choice.gap,gaps:[choice.gap]});}
 else if(creditsDue&&choice.source){
  // The expected set comes from a FRESH complete response, or - when persisted chunk rows already hold it - from D1 alone (a resume makes no upstream request).
  const fresh=answers[choice.source]?.status==='ok'&&answers[choice.source].credits.status==='ok'?answers[choice.source].credits.items:null;
  const persisted=plans[choice.source]?resumeRows.filter(row=>row.source===choice.source).sort((a,b)=>a.slot-b.slot):[];
  let expected=null,chunks=null,digestOfSet=null;
  if(fresh){
   expected=Plan.expectedCredits(choice.source,fresh);
   chunks=Plan.chunkCredits(expected.items);
   digestOfSet=await Plan.expectedDigest(expected.items);
  }else if(persisted.length){
   const planRows=plans[choice.source].rows;
   chunks=planRows.map(row=>({slot:row.slot,items:row.expected.items.map(([personId,role])=>({personId,role,roleId:personId.slice('person:'.length)}))}));
   expected={items:chunks.flatMap(chunk=>chunk.items),gaps:(planRows.find(row=>row.gaps)?.gaps)||[]};
   digestOfSet=plans[choice.source].digest;
  }
  const lbOld=Plan.fallbackElapsed(pendingSince.letterboxd,now);
  const gateOpen=!hasLb||agreed||(choice.source!=='letterboxd'&&lbOld);
  if(expected&&gateOpen){
   const have=new Set((await many(db(env),'SELECT person_id,role FROM film_person_credit WHERE film_id=?',[filmId])).map(item=>item.person_id+'|'+item.role));
   const people=new Set((await many(db(env),`SELECT id FROM person WHERE id IN (SELECT value FROM json_each(?))`,[JSON.stringify(expected.items.map(item=>item.personId))])).map(item=>item.id));
   const base=rowOf('credits',choice.source)||{filmId,part:'credits',source:choice.source,slot:0,planEpoch:0,refreshEpoch:0,dueSince:now,cohort:'live'};
   // The WHOLE expected set is published as durable chunk rows BEFORE the first unit, in ONE atomic batch together with the supersession of every old slot of another plan: a crash can never leave a prefix, and an old
   // slot can never be mixed into a new plan or silently omitted (the explicit completeness invariant is `total` slots with one digest, checked on resume).
   if(fresh){
    const stale=chunks.some(chunk=>{const stored=rowOf('credits',choice.source,chunk.slot);return !(stored&&stored.status==='complete'&&stored.expected?.digest===digestOfSet&&stored.expected?.total===chunks.length);});
    if(stale){
     const guard=guardSql(ctx);
     const rowsOut=chunks.map(chunk=>{const stored=rowOf('credits',choice.source,chunk.slot);return {...base,slot:chunk.slot,status:'due',expected:{digest:digestOfSet,total:chunks.length,items:chunk.items.map(item=>[item.personId,item.role])},gaps:expected.gaps.length?expected.gaps:null,refreshEpoch:stored?.refreshEpoch??base.refreshEpoch,failures:0,retryAt:null,pendingSince:null};});
     await putRowsAtomic(env,ctx,rowsOut,[[`UPDATE catalog_enrichment_state SET status='not_applicable',reason='superseded_plan',expected_json=NULL,updated_at=? WHERE film_id=? AND part='credits' AND source=? AND slot>=? AND ${guard.sql}`,[now,filmId,choice.source,chunks.length,...guard.params]]]);
    }
   }
   let allDone=true;
   for(const chunk of chunks){
    const slotRow={...base,slot:chunk.slot,status:'due',expected:{digest:digestOfSet,total:chunks.length,items:chunk.items.map(item=>[item.personId,item.role])},gaps:expected.gaps.length?expected.gaps:null,refreshEpoch:rowOf('credits',choice.source,chunk.slot)?.refreshEpoch??base.refreshEpoch};
    const missing=Plan.missingForChunk(chunk,{have,people});
    if(!missing.credits.length){await putRow(env,ctx,{...slotRow,status:'complete',failures:0,retryAt:null,pendingSince:null});continue;}
    // the chunk row (with the persisted expected set and its epoch) is durable BEFORE its first unit: an interrupted Film resumes from it
    await putRow(env,ctx,slotRow);
    // every unit of the chunk asserts the anchor set, the Film's plan epoch and the chunk row's own epoch, the lease and the control generation
    const guards=[Plan.anchorSetGuard(filmId,context.anchors),Plan.epochGuard(filmId,{part:'credits',source:choice.source,slot:chunk.slot,refreshEpoch:slotRow.refreshEpoch,planEpoch:filmRow.planEpoch}),Plan.leaseGuard(leaseId,now),Plan.controlGuard(generation)];
    for(const personId of missing.persons){
     {const stop=await mayWrite();if(stop)return partial(report,stop);}
     const item=chunk.items.find(entry=>entry.personId===personId);
     const unit=await runUnit(env,{kind:'person',unitKey:unitKeys.person(personId),input:{id:personId,at:now,person:{roleId:item.roleId,contractVersion:context.film.contractVersion},guards},now:()=>now});
     report.units.push({part:'person',state:unit.state});
     if(!['applied','noop','settled'].includes(unit.state)){allDone=false;}
     else people.add(personId);
    }
    if(missing.persons.every(personId=>people.has(personId))){
     {const stop=await mayWrite();if(stop)return partial(report,stop);}
     const unit=await runUnit(env,{kind:'credits',unitKey:unitKeys.credits(filmId,choice.source,chunk.slot),input:{id:filmId,at:now,credits:missing.credits.map(item=>({personId:item.personId,role:item.role})),guards},now:()=>now});
     report.units.push({part:'credits',slot:chunk.slot,state:unit.state});
     if(['applied','noop','settled'].includes(unit.state)){for(const item of missing.credits)have.add(item.personId+'|'+item.role);await putRow(env,ctx,{...slotRow,status:'complete',failures:0,retryAt:null,pendingSince:null,film:{wroteCredits:true}});}
     else allDone=false;
    }else allDone=false;
   }
   report.creditsComplete=allDone&&Plan.creditsComplete(chunks,have);
   if(expected.gaps.length)report.gaps.push(...expected.gaps.map(item=>item.gap));
  }
 }
 return {state:'done',report};
}
