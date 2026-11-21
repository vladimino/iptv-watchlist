#!/usr/bin/env node
// Owner-only production operator for the Watchlist marker transitions of holdpoint (d) of ADR 0186 decision 8 (AIR-571): hold, switch to `d1`, release, back out, and the first
// step of the data rollback. Default is read-only `status`. Every transition is ONE guarded D1 batch (src/watchlist-cutover.js) with an explicit `--confirm <command>`, the expected
// generation, the facts it verified re-asserted inside the batch, an independent readback, no retry and no repair. It writes the marker row and nothing else: no pointer, snapshot,
// member, journal row, no EPG, R2, flag, Task or other domain. It never calls Letterboxd, the Worker or the API.
//
//   status          read-only: the marker, the pointer, the verified import, the EPG liveness, the checkpoint authority and the Letterboxd mode
//   hold            epg/open  G -> epg/held G+1    pins: run, EPG generation, count, both digests, snapshot id (the bootstrap receipt)
//   release-abort   epg/held  G -> epg/open G
//   activate        epg/held  G -> d1/held  G+1    the same pins; re-asserted in the batch
//   release         d1/held   G -> d1/open  G      pins: run, count, both digests, snapshot id (the import must be whole; the old source may have moved on)
//   hold-rollback   d1/open   G -> d1/held  G+1    pins: snapshot id, count, raw digest of the CURRENT snapshot, its version and its revision
//   export-rollback d1/held   G (no marker move)   writes the CURRENT snapshot into the published generation's watchlist part through the EPG writer path; pins: the snapshot + pointer
//                   (version, revision) and the published run and EPG generation read before
//   revert-authority     d1/held G -> epg/held G+1   pins as export-rollback, with the EPG generation the export PRODUCED (read back: membership and order parity inside the batch)
//   release-rolled-back  epg/held G -> epg/open G
//   fence-root      epg/held G (no D1 write)  changes the ETAG of the root watchlist.json mirror in R2 (a conditional re-serialization of the same list), so that no EPG-side root writer that read the object
//                   before the fence can still write it; pins: the generation and the etag read before. `activate` then requires the etag the fence produced (--expect-root-etag)
//
// Not here: the Ratings close, the Letterboxd mode switch, the root mirror reconciliation, the binding and the cron.
import {pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {createS3Store,InstallError,readInstallCredentials} from './r2-s3-store.mjs';
import {readCredentials} from './r2-snapshot-export.mjs';
import {readState as readBase,verifyImported} from './watchlist-bootstrap-production.mjs';
import {LEASE_MARGIN_MS,livenessOf,membershipDigest} from '../src/watchlist-bootstrap.js';
import {listDigest,normalizeFilms} from '../src/watchlist-d1.js';
import * as PublishedEpg from '../src/published-epg.js';
import {exportGuards,TRANSITIONS,transitionStatements} from '../src/watchlist-cutover.js';

export const COMMANDS=['status',...Object.keys(TRANSITIONS),'export-rollback','fence-root'];
export const ROOT_KEY='watchlist.json';
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-generation':'generation','--expect-run':'run','--expect-epg-generation':'epgGeneration','--expect-count':'count','--expect-members-sha256':'membersSha256','--expect-sha256':'sha256','--expect-snapshot-id':'snapshotId','--expect-version':'version','--expect-revision':'revision','--expect-root-etag':'rootEtag'};
const NEEDS={
 hold:['generation','run','epgGeneration','count','membersSha256','sha256','snapshotId'],
 activate:['generation','run','epgGeneration','count','membersSha256','sha256','snapshotId','rootEtag'],
 'fence-root':['generation','rootEtag'],
 release:['generation','run','count','membersSha256','sha256','snapshotId'],
 'release-abort':['generation'],
 'hold-rollback':['generation','count','sha256','snapshotId','version','revision'],
 'export-rollback':['generation','count','sha256','snapshotId','version','revision','run','epgGeneration'],
 'revert-authority':['generation','count','sha256','snapshotId','version','revision','run','epgGeneration'],
 'release-rolled-back':['generation'],
};
const iso=ms=>new Date(ms).toISOString();
async function one(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).all()).results||[];}

// ---- state: the bootstrap operator's read plus the two independent facts a transition pins -----------------------------------
export async function readState(binding){
 const state=await readBase(binding);
 try{
  const names=(await many(binding,"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('epg_checkpoint_authority','letterboxd_sync_mode')")).map(row=>row.name);
  state.checkpoint=names.includes('epg_checkpoint_authority')?await one(binding,'SELECT mode, writes FROM epg_checkpoint_authority WHERE id=1'):null;
  state.letterboxd=names.includes('letterboxd_sync_mode')?{rows:await many(binding,'SELECT mode, revision FROM letterboxd_sync_mode')}:{rows:[]};
 }catch(error){if(error instanceof OperatorStop)throw error;throw new OperatorStop('unknown_state',3);}
 return state;
}
const letterboxdFact=state=>{const rows=state.letterboxd?.rows||[];if(rows.length>1)return null;if(!rows.length)return {revision:-1,closed:true};return {revision:Number(rows[0].revision),closed:rows[0].mode==='external'};};
const markerOf=state=>state.marker?{mode:state.marker.mode,writes:state.marker.writes,generation:Number(state.marker.generation)}:null;
const pointerOf=state=>state.pointer?{version:Number(state.pointer.version),snapshotId:state.pointer.snapshot_id,listSha256:state.pointer.list_sha256,filmCount:state.pointer.film_count===null?null:Number(state.pointer.film_count),revision:Number(state.pointer.revision),effectsDrainedVersion:Number(state.pointer.effects_drained_version),lastSuccessRun:state.pointer.last_success_run}:null;

// The snapshot the pointer names is complete and coherent: the snapshot row, every member (contiguous ordinals, count, digest) and no row the import must not have written.
export async function verifyCurrent(binding,state){
 const p=state.pointer;
 if(!p||!p.snapshot_id||Number(p.version)<1)return {ok:false,reason:'pointer_empty'};
 const snap=await one(binding,'SELECT version, film_count, list_sha256, run_id FROM watchlist_snapshot WHERE snapshot_id=?',[p.snapshot_id]);
 if(!snap||Number(snap.version)!==Number(p.version)||snap.list_sha256!==p.list_sha256||Number(snap.film_count)!==Number(p.film_count))return {ok:false,reason:'snapshot_inconsistent',problems:['snapshot']};
 const rows=await many(binding,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[p.snapshot_id]);
 const stored=rows.map(row=>({ordinal:Number(row.ordinal),lid:row.lid,title:row.title,year:row.year===null?null:Number(row.year),url:row.url}));
 if(stored.length!==Number(p.film_count)||stored.some((row,index)=>row.ordinal!==index)||await listDigest(stored)!==p.list_sha256)return {ok:false,reason:'snapshot_inconsistent',problems:['members']};
 return {ok:true,runId:snap.run_id,membersSha256:await membershipDigest(stored)};
}

// The causal effects of the current snapshot (facts, retention, removal queue) are all done before the writer is closed: once the mode is `external` and the authority is `epg`, nothing could drain them.
// Mirror delivery, Events and pending identity admission are NOT part of this check. -> null | {drainedVersion,version,pending}
export async function effectsPending(binding,state){
 const p=state.pointer;
 const pending=Number((await one(binding,"SELECT COUNT(*) AS n FROM watchlist_effect WHERE status<>'done'"))?.n);
 if(Number(p.effects_drained_version)===Number(p.version)&&pending===0)return null;
 return {drainedVersion:Number(p.effects_drained_version),version:Number(p.version),pending};
}

const view=state=>({schemaVersion:state.schemaVersion,marker:markerOf(state),pointer:pointerOf(state),counts:state.counts,published:state.published?{programmeRunId:state.published.programme_run_id,generation:Number(state.published.generation),certified:state.published.finalized_run_id===state.published.programme_run_id}:null,checkpoint:state.checkpoint?{mode:state.checkpoint.mode,writes:state.checkpoint.writes}:null,letterboxd:{rows:state.letterboxd?.rows?.length??0,closed:letterboxdFact(state)?.closed??null},liveness:state.orchestration?livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},0).ok?'valid':'unknown':null});


// ---- the rollback export: the current snapshot into the published generation, through the EPG writer path ------------------------------------
// ADR 0186 decision 8.5. Only in d1/held (after `hold-rollback`). The EPG writer path is `PublishedEpg.saveWatchlist`: a staged commit that replaces the watchlist part (document chunks and
// member rows) and moves the EPG generation by exactly one, compare-and-swapped on the generation read here. It does not write the programme, the shows or the R2 mirrors (a named
// writer reconciles them later); the root watchlist mirror belongs to the EPG again only after `revert-authority`.
export async function exportRollback(binding,state,args,clock,ctx={}){
 const m=markerOf(state);
 if(m.mode!=='d1'||m.writes!=='held'||m.generation!==args.generation)throw new OperatorStop('state_mismatch',3,{marker:m});
 const body=await verifyCurrent(binding,state);
 if(!body.ok)throw new OperatorStop(body.reason,3,{problems:body.problems});
 const p=state.pointer;
 if(p.snapshot_id!==args.snapshotId||p.list_sha256!==args.sha256||Number(p.film_count)!==args.count)throw new OperatorStop('pin_mismatch',3,{problems:['snapshot']});
 if(Number(p.version)!==args.version||Number(p.revision)!==args.revision)throw new OperatorStop('pin_mismatch',3,{problems:['pointer']});
 const undrained=await effectsPending(binding,state);
 if(undrained)throw new OperatorStop('effects_pending',3,undrained);
 const lb=letterboxdFact(state);
 if(!lb||!lb.closed)throw new OperatorStop('letterboxd_not_closed',3);
 const live=livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock);
 if(!live.ok)throw new OperatorStop('liveness_unknown',3,{reason:live.reason});
 if(live.busy)throw new OperatorStop('writer_active',3,{busy:live.busy});
 const pub=state.published;
 if(!pub||pub.mode!=='d1'||pub.cutover!=='open'||pub.programme_run_id!==args.run||pub.finalized_run_id!==pub.programme_run_id)throw new OperatorStop('published_moved',3,{published:pub?{programmeRunId:pub.programme_run_id,generation:Number(pub.generation)}:null});
 // The snapshot as the list (members in order). The stored document keeps every other field of a film it already has; the snapshot owns id, title, year and url.
 const members=await many(binding,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[p.snapshot_id]);
 const stored=state.source;
 if(!stored||!Array.isArray(stored.films))throw new OperatorStop('source_unreadable',3);
 const equalNow=await listDigest(normalizeFilms(stored.films)||[])===p.list_sha256&&JSON.stringify(state.sourceMembers)===JSON.stringify(members.map(row=>row.lid));
 if(equalNow&&Number(pub.generation)===args.epgGeneration)return {operation:'export-rollback',writes:false,writeState:'none',outcome:'already_exported',receipt:'verified_equal',published:{programmeRunId:pub.programme_run_id,generation:Number(pub.generation)}};
 if(Number(pub.generation)!==args.epgGeneration)throw new OperatorStop('published_moved',3,{published:{programmeRunId:pub.programme_run_id,generation:Number(pub.generation)}});
 const byId=new Map(stored.films.map(film=>[film?.id,film]));
 const films=members.map(row=>{const film={...(byId.get(row.lid)||{}),id:row.lid,title:row.title,url:row.url};if(row.year===null)delete film.year;else film.year=Number(row.year);return film;});
 const document={...stored,films};
 if(await listDigest(normalizeFilms(films))!==p.list_sha256)throw new OperatorStop('export_digest',3);
 // The commit guard travels INTO the staged writer: it is asserted in the same transaction as the replacement (marker d1/held at G, the pinned pointer with its effects done, the Letterboxd
 // mode and its revision, the liveness proof, the certified pinned publication), so a change during the multi-batch staging aborts the replacement. The binding is wrapped to count the batches
 // the writer actually sends: a staged commit writes its claim, chunks and validation before the final replacement.
 const guards=exportGuards({generation:args.generation,facts:{snapshot:{snapshotId:p.snapshot_id,sha256:p.list_sha256,count:Number(p.film_count),revision:Number(p.revision),version:Number(p.version)},published:{programmeRunId:args.run,epgGeneration:args.epgGeneration},letterboxd:{revision:lb.revision},liveness:{controlRevision:state.orchestration.control?.revision??-1,leaseRevision:state.orchestration.lease?.revision??-1,liveAfterIso:iso(clock-LEASE_MARGIN_MS)}}});
 const sent={started:0,completed:0,rejected:false};
 // The writer wraps a batch error in its own error type; the proven rejection (a statement error of the D1 API) is read here, from the original error.
 const tracked={prepare:sql=>binding.prepare(sql),batch:async statements=>{sent.started++;let result;try{result=await binding.batch(statements);}catch(error){sent.rejected=error instanceof D1Error&&error.kind==='statement';throw error;}sent.completed++;return result;}};
 if(ctx.track)ctx.track('unknown');
 let outcome,failure=null;
 try{outcome=await PublishedEpg.saveWatchlist(tracked,document,{expectedGeneration:args.epgGeneration,owner:ctx.owner,guards});}catch(error){failure=error;}
 let after=null;
 try{after=await readState(binding);}catch{after=null;}
 const moved=Boolean(after?.published)&&after.published.programme_run_id===args.run&&Number(after.published.generation)===args.epgGeneration+1;
 const unchanged=Boolean(after?.published)&&after.published.programme_run_id===args.run&&Number(after.published.generation)===args.epgGeneration;
 // The generation moving by one is OUR replacement only if the stored list is the snapshot; another writer's commit also moves it.
 const ours=moved&&Boolean(after?.source)&&await listDigest(normalizeFilms(after.source.films)||[])===p.list_sha256;
 if(failure||outcome!==true){
  // Two different facts. (1) Was the AUTHORITATIVE list replaced? The generation says: unchanged means no. (2) Were any database writes made? A staged commit writes its claim, chunks and validation in earlier
  // batches, and a cleanup can fail, so an unchanged generation does NOT prove writeState none. `none` only when no batch completed and the failure is a proven rejection (or no batch was sent at all).
  const rejected=sent.rejected||(failure instanceof D1Error&&failure.kind==='statement');
  const noWrites=sent.completed===0&&(sent.started===0||rejected);
  let stage=null;
  try{stage=(await many(binding,"SELECT programme_run_id AS id, state FROM published_epg_stage WHERE programme_run_id LIKE ?",[args.run+'#watchlist#%'])).map(row=>({id:row.id,state:row.state}));}catch{stage=null;}
  const authoritative=unchanged?'unchanged':ours?'replaced':moved?'moved_by_another_writer':'unknown';
  if(ctx.track)ctx.track(noWrites&&unchanged?'none':'unknown');
  const reason=unchanged&&(outcome===false||(rejected&&sent.completed>=0))?'export_refused':'write_uncertain';
  throw new OperatorStop(reason,3,{authoritative,batches:{started:sent.started,completed:sent.completed},stage,published:after?.published?{programmeRunId:after.published.programme_run_id,generation:Number(after.published.generation)}:null,...(ours?{reachedByUnknownOutcome:true}:{})});
 }
 if(!after||!moved)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch'});
 // Readback: the stored list equals the snapshot (digest, membership and order), the programme document and everything else did not move.
 const problems=[];
 const documentAfter=after.source;
 if(!documentAfter||await listDigest(normalizeFilms(documentAfter.films)||[])!==p.list_sha256)problems.push('document_digest');
 if(JSON.stringify(after.sourceMembers)!==JSON.stringify(members.map(row=>row.lid)))problems.push('member_rows');
 if(JSON.stringify(markerOf(after))!==JSON.stringify(m))problems.push('marker_moved');
 if(JSON.stringify(pointerOf(after))!==JSON.stringify(pointerOf(state)))problems.push('pointer_moved');
 if(JSON.stringify(after.counts)!==JSON.stringify(state.counts))problems.push('rows_moved');
 for(const table of Object.keys(state.markers))if(table!=='published_epg_authority'&&state.markers[table]!==after.markers[table])problems.push('marker_changed:'+table);
 if(problems.length)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems});
 if(ctx.track)ctx.track('committed');
 return {operation:'export-rollback',writes:true,writeState:'committed',published:{programmeRunId:after.published.programme_run_id,generation:Number(after.published.generation)},next:'revert-authority with --expect-epg-generation '+Number(after.published.generation)};
}


// ---- the root mirror fence ---------------------------------------------------------------------------------------------------
// The root `watchlist.json` mirror is written by EPG-side writers with a conditional put on the etag they read (see PublishedEpg.putWatchlistRoot). In `epg`/`held` no writer starts a new root write, but one
// that passed the marker check earlier is still in flight and its put would succeed. The fence removes it without a wait and without a lease: the operator rewrites the SAME list with a new whitespace-suffix token (a fresh
// nonce and the held generation, invisible to JSON readers) by a conditional put on the etag it read. The representation is never reused (every root write on every side carries a fresh nonce), so no etag read before the fence can match again,
// and `activate` accepts only a fence of its own generation. Content equivalence (the list, the token ignored) is checked before and after.
export async function fenceRoot(state,args,{readStore,writeStoreFactory,ctx={}}){
 const m=markerOf(state);
 if(m.mode!=='epg'||m.writes!=='held'||m.generation!==args.generation)throw new OperatorStop('state_mismatch',3,{marker:m});
 if(!readStore||!writeStoreFactory)throw new OperatorStop('root_store_required',2);
 let object;
 try{object=await readStore.get(ROOT_KEY);}catch{throw new OperatorStop('root_unreadable',3);}
 if(!object)throw new OperatorStop('root_absent',3);
 if(object.etag!==args.rootEtag)throw new OperatorStop('root_moved',3,{root:{etag:object.etag}});
 const text=await object.text();
 let parsed;
 try{parsed=JSON.parse(text);}catch{parsed=null;}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||!Array.isArray(parsed.films))throw new OperatorStop('root_unreadable',3);
 // The fence representation is NEW: the same list with a fresh nonce and the held generation. It can never equal an earlier representation, so no etag read before it can match again.
 const fenced=PublishedEpg.serializeRoot(parsed,{fenceGeneration:m.generation});
 const store=writeStoreFactory(new Set([ROOT_KEY]));
 if(ctx.track)ctx.track('unknown');
 let saved,failure=null;
 try{saved=await store.put(ROOT_KEY,fenced,{onlyIf:{etagMatches:args.rootEtag},httpMetadata:{contentType:'application/json'}});}catch(error){failure=error;}
 let after=null,afterText=null;
 try{after=await readStore.get(ROOT_KEY);afterText=after?await after.text():null;}catch{after=null;}
 const reached=Boolean(after)&&afterText===fenced&&after.etag!==args.rootEtag;
 if(failure||!saved){
  // A lost conditional put (another writer changed the object first) wrote nothing; an exception is unproven and is never retried.
  if(!failure&&saved==null&&after&&!reached){if(ctx.track)ctx.track('none');throw new OperatorStop('root_moved',3,{root:{etag:after.etag}});}
  if(ctx.track)ctx.track('unknown');
  throw new OperatorStop('write_uncertain',3,{root:after?{etag:after.etag,fenced:reached}:null});
 }
 const equivalent=PublishedEpg.rootSemantic(afterText)!==null&&PublishedEpg.rootSemantic(afterText)===PublishedEpg.rootSemantic(parsed);
 const fence=PublishedEpg.rootFence(afterText);
 if(!reached||!equivalent||!fence||fence.generation!==m.generation)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',root:after?{etag:after.etag}:null});
 if(ctx.track)ctx.track('committed');
 return {operation:'fence-root',writes:true,writeState:'committed',root:{etag:after.etag,previousEtag:args.rootEtag,fenceGeneration:fence.generation,nonce:fence.nonce},marker:m,next:'activate with --expect-root-etag '+after.etag};
}

// ---- one transition ------------------------------------------------------------------------------------------------------------
export async function execute(command,{binding,args={},now,ctx={},readStore=null,writeStoreFactory=null}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding);
 if(state.tables.present!==state.tables.expected||state.schemaVersion<31||!state.marker||Number(state.marker.cas)!==1)throw new OperatorStop('schema_unready',3);
 if(command==='status'){
  const current=state.pointer&&Number(state.pointer.version)>=1?await verifyCurrent(binding,state):{ok:false,reason:'pointer_empty'};
  const live=livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock);
  return {operation:'status',writes:false,writeState:'none',...view(state),snapshot:current.ok?{ok:true,runId:current.runId,membersSha256:current.membersSha256}:{ok:false,reason:current.reason},epgBusy:live.ok?live.busy:'unknown'};
 }
 if(command==='export-rollback')return exportRollback(binding,state,args,clock,ctx);
 if(command==='fence-root')return fenceRoot(state,args,{readStore,writeStoreFactory,ctx});
 const spec=TRANSITIONS[command];
 if(!spec)throw new OperatorStop('usage',2);
 const m=markerOf(state);
 if(m.mode!==spec.from.mode||m.writes!==spec.from.writes||m.generation!==args.generation)throw new OperatorStop('state_mismatch',3,{marker:m});
 // ---- the facts of this transition, verified now and re-asserted inside the batch
 const facts={};
 const p=state.pointer;
 if(spec.needs.some(key=>key.startsWith('snapshot'))){
  const body=await verifyCurrent(binding,state);
  if(!body.ok)throw new OperatorStop(body.reason,3,{problems:body.problems});
  if(p.snapshot_id!==args.snapshotId||p.list_sha256!==args.sha256||Number(p.film_count)!==args.count)throw new OperatorStop('pin_mismatch',3,{problems:['snapshot']});
  facts.snapshot={snapshotId:p.snapshot_id,sha256:p.list_sha256,count:Number(p.film_count),revision:Number(p.revision),version:Number(p.version),runId:body.runId};
  if(spec.needs.includes('snapshotImport')){
   if(Number(p.version)!==1||Number(p.effects_drained_version)!==1)throw new OperatorStop('not_the_import',3);
   if(spec.needs.includes('source')){
    // the import is still the current certified source: the full read-only proof of the bootstrap operator, with the same pins
    const proof=await verifyImported(binding,state,{run:args.run,epgGeneration:args.epgGeneration,count:args.count,membersSha256:args.membersSha256,sha256:args.sha256});
    if(!proof.ok)throw new OperatorStop(proof.reason,3,{problems:proof.problems,...(proof.published?{published:proof.published}:{})});
    facts.source={programmeRunId:args.run,epgGeneration:args.epgGeneration};
   }else{
    // `release`: the full import proof (snapshot, staging receipt, every member, no journal rows, the pins) without requiring the old EPG source to remain current.
    const proof=await verifyImported(binding,state,{run:args.run,count:args.count,membersSha256:args.membersSha256,sha256:args.sha256},{requireSource:false});
    if(!proof.ok)throw new OperatorStop(proof.reason,3,{problems:proof.problems});
   }
  }else{
   if(Number(p.version)!==args.version||Number(p.revision)!==args.revision)throw new OperatorStop('pin_mismatch',3,{problems:['pointer']});
   const undrained=await effectsPending(binding,state);
   if(undrained)throw new OperatorStop('effects_pending',3,undrained);
  }
 }
 if(command==='activate'){
  // C3: the root watchlist mirror must be fenced FOR THIS held authority generation. The fence is a token inside the object (a fresh nonce and the generation it was written for), so a bare current etag is
  // not a proof: an operator that skips `fence-root`, or reuses the proof of an earlier hold (a different generation), is refused. The etag is the one the fence produced and the root must still have it.
  if(!readStore)throw new OperatorStop('root_store_required',2);
  let object,rootText;
  try{object=await readStore.get(ROOT_KEY);rootText=object?await object.text():null;}catch{throw new OperatorStop('root_unreadable',3);}
  if(!object)throw new OperatorStop('root_absent',3);
  const fence=PublishedEpg.rootFence(rootText);
  if(!fence||fence.generation!==args.generation)throw new OperatorStop('root_not_fenced',3,{fence:fence?{generation:fence.generation}:null,expected:args.generation});
  if(object.etag!==args.rootEtag)throw new OperatorStop('root_fence_mismatch',3,{root:{etag:object.etag}});
 }
 if(spec.needs.includes('exportParity')){
  // The proof is read here and bound inside the batch: a certified run at the pinned generation, the stored list equal to the snapshot (normalized digest, title, year and url included, and the member
  // order), and the stored payload digest of the generation, which any later replacement changes.
  const pub=state.published;
  if(!pub||pub.mode!=='d1'||pub.cutover!=='open'||pub.programme_run_id!==args.run||Number(pub.generation)!==args.epgGeneration)throw new OperatorStop('published_moved',3,{published:pub?{programmeRunId:pub.programme_run_id,generation:Number(pub.generation)}:null});
  if(pub.finalized_run_id!==pub.programme_run_id)throw new OperatorStop('published_not_certified',3);
  const document=state.source;
  const rows=await many(binding,'SELECT lid FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[args.snapshotId]);
  const normalized=document&&Array.isArray(document.films)?normalizeFilms(document.films):null;
  if(!normalized||await listDigest(normalized)!==p.list_sha256||JSON.stringify(state.sourceMembers)!==JSON.stringify(rows.map(row=>row.lid)))throw new OperatorStop('parity_mismatch',3,{problems:['document_digest']});
  const generation=await one(binding,'SELECT payload_sha256 FROM published_epg_generation WHERE programme_run_id=?',[args.run]);
  if(!generation||!/^[0-9a-f]{64}$/.test(generation.payload_sha256||''))throw new OperatorStop('published_moved',3);
  facts.parity={programmeRunId:args.run,epgGeneration:args.epgGeneration,payloadSha256:generation.payload_sha256};
 }
 if(spec.needs.includes('checkpoint')){
  const c=state.checkpoint;
  if(!c||c.writes!=='open'||!['r2','d1'].includes(c.mode))throw new OperatorStop('checkpoint_not_settled',3,{checkpoint:c?{mode:c.mode,writes:c.writes}:null});
  // O4: the EPG checkpoint cutover comes first. The forward path never switches with the checkpoint still on R2.
  if(c.mode!=='d1')throw new OperatorStop('checkpoint_not_d1',3,{checkpoint:{mode:c.mode,writes:c.writes}});
  facts.checkpoint={mode:'d1'};
 }
 if(spec.needs.includes('letterboxdClosed')){
  const lb=letterboxdFact(state);
  if(!lb||!lb.closed)throw new OperatorStop('letterboxd_not_closed',3);
  facts.letterboxd={revision:lb.revision};
 }
 if(spec.needs.includes('liveness')){
  const live=livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock);
  if(!live.ok)throw new OperatorStop('liveness_unknown',3,{reason:live.reason});
  if(live.busy)throw new OperatorStop('writer_active',3,{busy:live.busy});
  facts.liveness={controlRevision:state.orchestration.control?.revision??-1,leaseRevision:state.orchestration.lease?.revision??-1,liveAfterIso:iso(clock-LEASE_MARGIN_MS)};
 }
 const plan=transitionStatements(command,{generation:args.generation,facts});
 if(ctx.track)ctx.track('unknown');
 let failure=null;
 try{await binding.batch(plan.statements.map(([sql,params])=>binding.prepare(sql).bind(...params)));}catch(error){failure=error;}
 let after=null;
 try{after=await readState(binding);}catch{after=null;}
 const reached=Boolean(after)&&after.marker?.mode===plan.target.mode&&after.marker?.writes===plan.target.writes&&Number(after.marker?.generation)===plan.target.generation;
 const unchanged=Boolean(after)&&after.marker?.mode===spec.from.mode&&after.marker?.writes===spec.from.writes&&Number(after.marker?.generation)===args.generation;
 if(failure){
  // Only a PROVEN rejection (the D1 API answered with a statement error) with the marker untouched is "not applied"; anything else is unproven and is never downgraded by a readback.
  const rejected=failure instanceof D1Error&&failure.kind==='statement';
  const untouched=rejected&&unchanged;
  if(ctx.track)ctx.track(untouched?'none':'unknown');
  throw new OperatorStop(untouched?'predicate_refused':'write_uncertain',3,{marker:after?markerOf(after):null,...(reached?{reachedByUnknownOutcome:true}:{})});
 }
 if(!after||!reached)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',marker:after?markerOf(after):null});
 const problems=readbackProblems(state,after);
 if(problems.length)throw new OperatorStop('write_uncertain',3,{reason:'readback_mismatch',problems,...view(after)});
 if(ctx.track)ctx.track('committed');
 return {operation:command,writes:true,writeState:'committed',before:m,marker:plan.target,after:view(after)};
}

// After a transition only the marker moved: the pointer, the snapshot rows and the journal are as read, and the STABLE fields of the other domains are unchanged (never whole-row digests of live counters).
export function readbackProblems(before,after){
 const problems=[];
 if(JSON.stringify(pointerOf(before))!==JSON.stringify(pointerOf(after)))problems.push('pointer_moved');
 if(JSON.stringify(before.counts)!==JSON.stringify(after.counts))problems.push('rows_moved');
 for(const table of Object.keys(before.markers))if(before.markers[table]!==after.markers[table])problems.push('marker_changed:'+table);
 if(JSON.stringify(before.checkpoint)!==JSON.stringify(after.checkpoint))problems.push('checkpoint_changed');
 if(JSON.stringify(letterboxdFact(before))!==JSON.stringify(letterboxdFact(after)))problems.push('letterboxd_changed');
 return problems;
}

// ---- CLI -----------------------------------------------------------------------------------------------------------------
export function parseArgs(argv){
 const args=argv.slice(2),parsed={};
 const commands=args.filter(arg=>arg.startsWith('--')&&COMMANDS.includes(arg.slice(2)));
 if(commands.length>1)throw new OperatorStop('usage',2);
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  const name=VALUE_FLAGS[arg],next=args[index+1];
  if(!name||next===undefined||next.startsWith('--')||parsed[name]!==undefined)throw new OperatorStop('usage',2);
  parsed[name]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(parsed.confirm!==undefined||Object.keys(parsed).some(key=>key!=='target'))throw new OperatorStop('usage',2);return {command,args:{}};}
 if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 for(const need of NEEDS[command])if(parsed[need]===undefined)throw new OperatorStop('usage',2);
 const out={};
 const digit=(key,pattern)=>{if(parsed[key]!==undefined){if(!pattern.test(parsed[key]))throw new OperatorStop('usage',2);out[key]=Number(parsed[key]);}};
 digit('generation',/^\d{1,9}$/);digit('epgGeneration',/^\d{1,9}$/);digit('count',/^\d{1,5}$/);digit('version',/^\d{1,9}$/);digit('revision',/^\d{1,9}$/);
 for(const key of ['sha256','membersSha256'])if(parsed[key]!==undefined){if(!/^[0-9a-f]{64}$/.test(parsed[key]))throw new OperatorStop('usage',2);out[key]=parsed[key];}
 if(parsed.rootEtag!==undefined){if(!/^[A-Za-z0-9._\-]{1,100}$/.test(parsed.rootEtag))throw new OperatorStop('usage',2);out.rootEtag=parsed.rootEtag;}
 for(const key of ['run','snapshotId'])if(parsed[key]!==undefined){if(!parsed[key]||parsed[key].length>100)throw new OperatorStop('usage',2);out[key]=parsed[key];}
 // only the pins of the command are accepted
 for(const key of Object.keys(out))if(!NEEDS[command].includes(key))throw new OperatorStop('usage',2);
 return {command,args:out};
}

function readStoreOf(env,fetchImpl){
 let credentials;
 try{credentials=readCredentials(env);}catch(error){throw normalize(error);}
 if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
 if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
 return createS3Store({credentials,fetchImpl});
}
function writeStoreFactoryOf(env,fetchImpl){
 return allowed=>{
  let credentials;
  try{credentials=readInstallCredentials(env);}catch(error){throw error instanceof InstallError?new OperatorStop('configuration',2):normalize(error);}
  if(credentials.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
  if(credentials.bucket!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('bucket_identity',3);
  return createS3Store({credentials,fetchImpl,allowedWrites:allowed});
 };
}

export async function runWatchlistCutoverProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,target=null,readStore=null,writeStoreFactory=null;
  if(deps)({binding,readStore=null,writeStoreFactory=null}=deps);
  else{
   target=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command!=='status')ctx.bookmark=await readBookmark(target,fetchImpl);
   if(['activate','fence-root'].includes(parsed.command)){readStore=readStoreOf(env,fetchImpl);if(parsed.command==='fence-root')writeStoreFactory=writeStoreFactoryOf(env,fetchImpl);}
  }
  const result=await execute(parsed.command,{binding,args:parsed.args,now,ctx:{track},readStore,writeStoreFactory});
  let bookmarkAfter=null;
  if(result.writes&&target)try{bookmarkAfter=await readBookmark(target,fetchImpl);}catch{bookmarkAfter=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(bookmarkAfter?{bookmarkAfter}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runWatchlistCutoverProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
