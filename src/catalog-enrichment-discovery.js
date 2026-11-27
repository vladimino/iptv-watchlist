// AIR-684 (card C3c-D; ADR 0219 decisions 2, 3 and 4). The DISCOVERY-SPECIFIC intake of the Catalog Enrichment Producer. The common mechanism (inbox, scope row, retained member, drainer, producer step) is AIR-605's and is not
// copied here; this module only adds what is Discovery's own:
//   - `tmdbPartDigests`: the verified per-part digests of ONE TMDB response of a Film (core, credits, localization), a pure function of the parsed response and the anchor, with the SAME parser the producer's own
//     fetcher uses (`parseTmdb`), so a Discovery revalidation and the producer's fetch cannot disagree about what a part is;
//   - `emitSourceChanged`: the `source_changed` emitter of the Discovery revalidation: one inbox row per part, written ONLY for a Film that already holds a retained Discovery membership, so it records nothing before the scope
//     is activated and nothing for a Film that belongs to no scope; an identical digest writes nothing and wakes nothing (the cause digest is the change token);
//   - `activationPreflight`: the READ-ONLY proof C3c-A needs before it sets `activated` (compatible emitter and settlement deployed, no transfer loading, no stale staged signal, no unexpected membership).
// DORMANT: nothing reads the preflight in the Worker, and the emitter is a no-op without the scope tables, without the Discovery scope's retained members and without an active producer; it never fetches, never writes a canonical
// table and never touches the control. The language of the Discovery detail request is `ru-RU`, so the CORE digest covers only the language-independent fields (year and runtime): a synopsis, genre names and a poster path vary
// with the request language and would raise a false change; a real change of those is found by the producer's own fetch. Credits (the role and the provider key of each credit) and the translations list do not depend on it.
import {parseTmdb} from './catalog-enrichment-sources.js';
import {digestOf} from './catalog-enrichment-plan.js';
import {database,failed,many,one} from './film-person-authority.js';

const TMDB_ID=/^[1-9]\d{0,11}$/;
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// -> {core, credits, localization} (SHA-256 hex) of a TMDB movie detail with `credits` and `translations`, or null when the document is not that movie's.
export async function tmdbPartDigests(movie,tmdbId){
 if(!TMDB_ID.test(String(tmdbId)))return null;
 const parsed=parseTmdb(movie,String(tmdbId));
 if(!parsed)return null;
 const anchor=String(tmdbId);
 // core: only what the request language cannot change. credits: an unreadable section has its own digest, never "no credits". localization: exactly what the producer applies as the part's source version.
 const core=await digestOf({source:'tmdb',part:'core',anchor,fields:{year:parsed.fields.year,runtime:parsed.fields.runtime}});
 const credits=await digestOf({source:'tmdb',part:'credits',anchor,status:parsed.credits.status,items:parsed.credits.items.map(item=>[item.role,item.key])});
 const title=parsed.title;
 const localization=await digestOf(title.status==='value'?{source:'tmdb',anchor,title:title.value}:{source:'tmdb',part:'localization',anchor,status:title.status});
 return {core,credits,localization};
}
// The statements of one verified observation. A part is written only for a Film that holds a Discovery membership AT THE TIME OF THE WRITE; the same upsert as every emitter (a new row is version 1, an existing row is raised and pending
// again), except that an identical digest changes nothing, so a repeated revalidation of an unchanged Film writes and wakes nothing.
export function sourceChangedStatements({tmdbId,digests,at}){
 if(!TMDB_ID.test(String(tmdbId))||!digests||!ISO.test(String(at)))throw failed('film_person_invalid');
 return ['core','credits','localization'].map(part=>{
  if(!/^[0-9a-f]{64}$/.test(String(digests[part]||'')))throw failed('film_person_invalid');
  // The FIRST sight of a part is not a change. Localization has a stored source version with the same digest the producer applies, so its first signal is `pending` and the producer drops it without a fetch when the part
  // is complete for that version. Core and credits keep no comparable stored digest, so their first sight is recorded as an already CONSUMED baseline (no refresh); only a later DIFFERENT digest re-arms them.
  const baseline=part!=='localization';
  return [`INSERT INTO enrichment_signal (kind,subject,source,part,version,acked_version,state,cause_digest,cause_ref,armed_at,attempts) SELECT 'source_changed',e.film_id,'tmdb',?,1,?,?,?,'discovery_revalidation',?,0 FROM film_external_id e JOIN catalog_enrichment_member m ON m.film_id=e.film_id AND m.scope='discovery' WHERE e.scheme='tmdb' AND e.value=? AND e.trusted=1 AND e.conflicting=0 AND NOT EXISTS (SELECT 1 FROM film_redirect r WHERE r.from_id=e.film_id) ON CONFLICT (kind,subject,source,part) DO UPDATE SET version=version+1,state='pending',cause_digest=excluded.cause_digest,cause_ref=excluded.cause_ref,armed_at=excluded.armed_at,attempts=0,last_error=NULL,retry_at=NULL WHERE enrichment_signal.cause_digest IS NOT excluded.cause_digest`,[part,baseline?1:0,baseline?'consumed':'pending',digests[part],at,String(tmdbId)]];
 });
}
const absent=error=>/no such (table|column)/i.test(String(error?.cause?.message||error?.message||error));
// Best effort and never a failure of the Discovery chunk: a verified response of a Film the producer does not hold, an absent schema (before the apply) and a transient D1 error all end quietly; the producer's own refresh events and
// the reconcile recover a missed signal. -> {emitted:boolean, reason?}
export async function emitSourceChanged(env,{tmdbId,movie,at=new Date().toISOString()}){
 const handle=database(env);
 if(!handle||typeof handle.batch!=='function')return {emitted:false,reason:'no_database'};
 let digests;
 try{digests=await tmdbPartDigests(movie,tmdbId);}catch{return {emitted:false,reason:'unreadable'};}
 if(!digests)return {emitted:false,reason:'not_this_movie'};
 try{
  const before=await one(handle,"SELECT COALESCE(SUM(version),0) AS v, COUNT(*) AS n FROM enrichment_signal WHERE kind='source_changed' AND source='tmdb' AND cause_ref='discovery_revalidation'");
  await handle.batch(sourceChangedStatements({tmdbId,digests,at}).map(([sql,params])=>handle.prepare(sql).bind(...params)));
  const after=await one(handle,"SELECT COALESCE(SUM(version),0) AS v, COUNT(*) AS n FROM enrichment_signal WHERE kind='source_changed' AND source='tmdb' AND cause_ref='discovery_revalidation'");
  return {emitted:Number(after?.v)!==Number(before?.v)||Number(after?.n)!==Number(before?.n)};
 }catch(error){return {emitted:false,reason:absent(error)?'schema_absent':'unavailable'};}
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
