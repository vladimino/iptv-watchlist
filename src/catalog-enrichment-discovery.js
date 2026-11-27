// AIR-684 (card C3c-D; ADR 0219 decisions 2, 3 and 4). The DISCOVERY-SPECIFIC intake of the Catalog Enrichment Producer. The common mechanism (inbox, scope row, retained member, drainer, producer step) is AIR-605's and is not
// copied here; this module only adds what is Discovery's own:
//   - `tmdbPartVersions`: the verified per-part versions of ONE TMDB response (core, credits, localization) from the producer's own pure projection (`Plan.coreVersion` and its siblings, which the producer stores as
//     `source_version` when a part is complete) and its own parser (`parseTmdb`), so an observer and the producer cannot disagree about what a part is; only VERIFIED sections have one;
//   - `emitSourceChanged`: the `source_changed` emitter of the Discovery revalidation: one inbox row per verified part, written ONLY for a Film that already holds a retained Discovery membership (so nothing
//     before the scope is activated and nothing for a Film of no scope) and only while the revalidation's Discovery lease is held; an identical digest writes nothing and wakes nothing; a failed write is REPORTED so the caller keeps
//     the verified outcome retryable;
//   - `activationPreflight`: the READ-ONLY proof C3c-A needs before it sets `activated` (compatible emitter and settlement deployed, no transfer loading, no stale staged signal, no unexpected membership).
// DORMANT: nothing reads the preflight in the Worker, and the emitter is a no-op without the scope tables, without the Discovery scope's retained members and without an active producer; it never fetches, never writes a canonical
// table and never touches the control. The Discovery detail uses the producer's own request shape (ADR 0224: `ru-RU`, translations and images in the same call), so both read the same Russian-first projection through the one parser
// and the core version covers all six selected fields. A part whose section is not verified is never signalled; the producer decides, from its own stored `source_version`, whether a signalled part needs a fetch.
import {parseTmdb} from './catalog-enrichment-sources.js';
import {coreVersion,creditsVersion,localizationVersion} from './catalog-enrichment-plan.js';
import {database,failed,many,one} from './film-person-authority.js';

const TMDB_ID=/^[1-9]\d{0,11}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// The verified per-part versions of one TMDB movie response, from the SAME pure projection the producer stores as `source_version` (`Plan.coreVersion`, `creditsVersion`, `localizationVersion`) and the SAME parser as its
// fetcher. -> {core, credits, localization} where a part whose section is not VERIFIED (unreadable credits, an unreadable, ambiguous or unsupported translations section) is null, or null as a whole when the document is not
// that movie's. A null part is never signalled.
export async function tmdbPartVersions(movie,tmdbId){
 if(!TMDB_ID.test(String(tmdbId)))return null;
 const parsed=parseTmdb(movie,String(tmdbId));
 if(!parsed)return null;
 const anchor=String(tmdbId);
 return {core:await coreVersion('tmdb',anchor,parsed.observation),credits:await creditsVersion('tmdb',anchor,parsed.credits),localization:await localizationVersion('tmdb',anchor,parsed.title)};
}
// One statement per verified part, each followed by `SELECT changes()` so the caller reads the rows THIS batch changed (never a count over the catalog). A part is written only for a Film that holds a Discovery membership at the
// time of the write and still holds the trusted, non-conflicting, non-redirected claim; with a `lease`, only while the Discovery lease of this revalidation is still held. And only when the producer's APPLIED state does not already
// say the same thing: the applicable part is complete at exactly this version (for credits: every ACTIVE chunk row of the tmdb source, superseded slots excluded, complete at this version). An enriched Film observed again with an
// equal complete response therefore writes nothing at all (no pending row, no wake, no epoch change); a changed, a first-observed-but-different and an equal-but-incomplete part are written. The upsert still re-arms an existing
// row only when its digest differs.
const DONE="('complete','complete_with_gaps')";
const APPLIED={
 core:`EXISTS (SELECT 1 FROM catalog_enrichment_state a WHERE a.film_id=e.film_id AND a.part='core' AND a.source='tmdb' AND a.slot=0 AND a.status IN ${DONE} AND a.source_version=?)`,
 localization:`EXISTS (SELECT 1 FROM catalog_enrichment_state a WHERE a.film_id=e.film_id AND a.part='localization' AND a.source='tmdb' AND a.slot=0 AND a.status IN ${DONE} AND a.source_version=?)`,
 credits:`(EXISTS (SELECT 1 FROM catalog_enrichment_state a WHERE a.film_id=e.film_id AND a.part='credits' AND a.source='tmdb' AND a.status IN ${DONE}) AND NOT EXISTS (SELECT 1 FROM catalog_enrichment_state b WHERE b.film_id=e.film_id AND b.part='credits' AND b.source='tmdb' AND b.status<>'not_applicable' AND NOT (b.status IN ${DONE} AND b.source_version=?)))`,
};
export function sourceChangedStatements({tmdbId,versions,at,lease=null}){
 if(!TMDB_ID.test(String(tmdbId))||!versions||!ISO.test(String(at)))throw failed('film_person_invalid');
 const held=lease?' AND EXISTS (SELECT 1 FROM discovery_lease WHERE id=1 AND lease_id=? AND expires_at>?)':'';
 const out=[];
 for(const part of ['core','credits','localization']){
  const digest=versions[part];
  if(digest==null)continue;
  if(!/^[0-9a-f]{64}$/.test(String(digest)))throw failed('film_person_invalid');
  out.push([`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_digest,cause_ref,armed_at,attempts) SELECT 'source_changed',e.film_id,'tmdb',?,1,0,'pending',?,'discovery_revalidation',?,0 FROM film_external_id e JOIN catalog_enrichment_member m ON m.film_id=e.film_id AND m.scope='discovery' WHERE e.scheme='tmdb' AND e.value=? AND e.trusted=1 AND e.conflicting=0 AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=e.film_id)${held} AND NOT ${APPLIED[part]} ON CONFLICT (kind,subject,source,part) DO UPDATE SET version=version+1,state='pending',cause_digest=excluded.cause_digest,cause_ref=excluded.cause_ref,armed_at=excluded.armed_at,attempts=0,last_error=NULL,retry_at=NULL WHERE enrichment_signal.cause_digest IS NOT excluded.cause_digest`,[part,digest,at,String(tmdbId),...(lease?[lease.id,Date.parse(at)]:[]),digest]]);
  out.push(['SELECT changes() AS n',[]]);
 }
 return out;
}
// Is this Film's revalidation an OBSERVER of the shared Russian-first projection? Only when the Catalog Enrichment schema of this change is applied AND the Film holds a retained `discovery` membership (a trusted tmdb claim, not
// redirected). One bounded, indexed read. Anything else (no schema, no scope, a Film outside it, a failed read) answers false, so a deployment alone, or a Film no scope holds, leaves the live revalidation request exactly as it was.
export async function observerEligible(env,tmdbId){
 const handle=database(env);
 if(!handle||!TMDB_ID.test(String(tmdbId)))return false;
 try{
  const row=await one(handle,"SELECT 1 AS ok FROM film_external_id e JOIN catalog_enrichment_member m ON m.film_id=e.film_id AND m.scope='discovery' WHERE e.scheme='tmdb' AND e.value=? AND e.trusted=1 AND e.conflicting=0 AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=e.film_id) LIMIT 1",[String(tmdbId)]);
  return !!row;
 }catch{return false;}
}
const absent=error=>/no such (table|column)/i.test(String(error?.cause?.message||error?.message||error));
// The causal wake, AFTER the write (never inside the batch): only when work is runnable; no runner (an old version, the producer dormant) is a no-op, and a lost wake is recovered by the reconcile cron.
async function wake(env){
 if(typeof CatalogEnrichmentRunner==='undefined')return;
 try{if(await CatalogEnrichmentRunner.hasRunnable(env,{now:new Date().toISOString()}))await CatalogEnrichmentRunner.kick(env);}catch{/* the reconcile recovers a lost wake */}
}
// The Discovery revalidation's source_changed emitter. -> {state, parts}:
//   'written'    at least one signal row was inserted or re-armed by this batch (counted from the batch's own `changes()`), the producer was woken;
//   'unchanged'  the observation is identical to what is stored, or the Film holds no Discovery membership, or the lease is gone: nothing was written and nothing woke;
//   'absent'     the schema of the Catalog Enrichment Producer is not applied or the document is not this movie's: nothing to do, the caller proceeds;
//   'failed'     the batch failed (the outcome is unknown: it may have landed): the CALLER must keep the verified outcome retryable and ask again, and the producer is woken anyway so a landed write is never left idle.
export async function emitSourceChanged(env,{tmdbId,movie,at=new Date().toISOString(),lease=null}){
 const handle=database(env);
 if(!handle||typeof handle.batch!=='function')return {state:'absent',parts:[]};
 let versions;
 try{versions=await tmdbPartVersions(movie,tmdbId);}catch{return {state:'absent',parts:[]};}
 if(!versions)return {state:'absent',parts:[]};
 const statements=sourceChangedStatements({tmdbId,versions,at,lease});
 if(!statements.length)return {state:'unchanged',parts:[]};
 let results;
 try{results=await handle.batch(statements.map(([sql,params])=>handle.prepare(sql).bind(...params)));}
 catch(error){
  if(absent(error))return {state:'absent',parts:[]};
  await wake(env);
  return {state:'failed',parts:[]};
 }
 const parts=[];
 let index=0;
 for(const part of ['core','credits','localization']){
  if(versions[part]==null)continue;
  const row=results?.[index+1]?.results?.[0];
  if(Number(row?.n)>0)parts.push(part);
  index+=2;
 }
 if(parts.length){await wake(env);return {state:'written',parts};}
 return {state:'unchanged',parts:[]};
}

// ---- the activation preflight (C3c-A reads it before it sets `activated`) ----
const TRIGGERS=['discovery_enrichment_staged','discovery_enrichment_admitted','discovery_enrichment_loading','discovery_enrichment_settle'];
// READ-ONLY. -> {ok, problems:[code,...], facts:{...}}. A problem is a reason the activation must not proceed: the schema of this change is not applied (`schema_not_applied`: a trigger or the transfer columns are missing),
// a transfer is loading (`transfer_loading`: an old-version `replaceCatalog` could strand staged facts across the activation), a staged signal exists (`stale_staged_signals`), or the transfer row cannot be read.
// Whether a compatible CODE version is deployed is proven by the deploy and the dated readback of the activation, not by a read of the database.
export async function activationPreflight(env){
 const handle=database(env);
 if(!handle)throw failed('film_person_unavailable');
 const problems=[],facts={};
 try{
  const present=new Set((await many(handle,"SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ("+TRIGGERS.map(()=>'?').join(',')+")",TRIGGERS)).map(row=>row.name));
  facts.triggers=TRIGGERS.filter(name=>present.has(name));
  const columns=new Set((await many(handle,"SELECT name FROM pragma_table_info('discovery_transfer') WHERE name IN ('origin','origin_batches')")).map(row=>row.name));
  facts.transferColumns=[...columns].sort();
  if(present.size!==TRIGGERS.length||columns.size!==2){problems.push('schema_not_applied');return {ok:false,problems,facts};}
  const transfer=await one(handle,'SELECT state, origin FROM discovery_transfer WHERE id=1');
  facts.transfer=transfer?{state:transfer.state,origin:transfer.origin??null}:null;
  if(!transfer)problems.push('transfer_unreadable');
  else if(transfer.state==='loading')problems.push('transfer_loading');
  const staged=await one(handle,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='admitted' AND source='discovery' AND state='staged'");
  facts.stagedSignals=Number(staged?.n||0);
  if(facts.stagedSignals>0)problems.push('stale_staged_signals');
  const scope=await one(handle,"SELECT activated, enabled FROM catalog_enrichment_scope WHERE scope='discovery'");
  facts.scope=scope?{activated:Number(scope.activated),enabled:Number(scope.enabled)}:null;
 }catch(error){
  if(absent(error)){problems.push('schema_not_applied');return {ok:false,problems,facts};}
  throw failed('film_person_unavailable',error);
 }
 return {ok:problems.length===0,problems,facts};
}
