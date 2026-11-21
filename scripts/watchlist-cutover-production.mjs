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
//   release         d1/held   G -> d1/open  G      pins: snapshot id, count, raw digest (the source may have moved; the snapshot must not)
//   hold-rollback   d1/open   G -> d1/held  G+1    pins: snapshot id, count, raw digest of the CURRENT snapshot, its version and its revision
//
// Not here: the rollback export into the published generation, the return to `epg`, the Ratings close, the Letterboxd mode switch, the binding and the cron.
import {pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {readState as readBase,verifyImported} from './watchlist-bootstrap-production.mjs';
import {LEASE_MARGIN_MS,livenessOf,membershipDigest} from '../src/watchlist-bootstrap.js';
import {listDigest} from '../src/watchlist-d1.js';
import {TRANSITIONS,transitionStatements} from '../src/watchlist-cutover.js';

export const COMMANDS=['status',...Object.keys(TRANSITIONS)];
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-generation':'generation','--expect-run':'run','--expect-epg-generation':'epgGeneration','--expect-count':'count','--expect-members-sha256':'membersSha256','--expect-sha256':'sha256','--expect-snapshot-id':'snapshotId','--expect-version':'version','--expect-revision':'revision'};
const NEEDS={
 hold:['generation','run','epgGeneration','count','membersSha256','sha256','snapshotId'],
 activate:['generation','run','epgGeneration','count','membersSha256','sha256','snapshotId'],
 release:['generation','count','sha256','snapshotId'],
 'release-abort':['generation'],
 'hold-rollback':['generation','count','sha256','snapshotId','version','revision'],
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

const view=state=>({schemaVersion:state.schemaVersion,marker:markerOf(state),pointer:pointerOf(state),counts:state.counts,published:state.published?{programmeRunId:state.published.programme_run_id,generation:Number(state.published.generation),certified:state.published.finalized_run_id===state.published.programme_run_id}:null,checkpoint:state.checkpoint?{mode:state.checkpoint.mode,writes:state.checkpoint.writes}:null,letterboxd:{rows:state.letterboxd?.rows?.length??0,closed:letterboxdFact(state)?.closed??null},liveness:state.orchestration?livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},0).ok?'valid':'unknown':null});

// ---- one transition ------------------------------------------------------------------------------------------------------------
export async function execute(command,{binding,args={},now,ctx={}}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding);
 if(state.tables.present!==state.tables.expected||state.schemaVersion<31||!state.marker||Number(state.marker.cas)!==1)throw new OperatorStop('schema_unready',3);
 if(command==='status'){
  const current=state.pointer&&Number(state.pointer.version)>=1?await verifyCurrent(binding,state):{ok:false,reason:'pointer_empty'};
  const live=livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock);
  return {operation:'status',writes:false,writeState:'none',...view(state),snapshot:current.ok?{ok:true,runId:current.runId,membersSha256:current.membersSha256}:{ok:false,reason:current.reason},epgBusy:live.ok?live.busy:'unknown'};
 }
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
   }else if(body.membersSha256!==undefined&&args.membersSha256!==undefined&&body.membersSha256!==args.membersSha256)throw new OperatorStop('pin_mismatch',3,{problems:['members_sha256']});
  }else if(Number(p.version)!==args.version||Number(p.revision)!==args.revision)throw new OperatorStop('pin_mismatch',3,{problems:['pointer']});
 }
 if(spec.needs.includes('checkpoint')){
  const c=state.checkpoint;
  if(!c||c.writes!=='open'||!['r2','d1'].includes(c.mode))throw new OperatorStop('checkpoint_not_settled',3,{checkpoint:c?{mode:c.mode,writes:c.writes}:null});
  facts.checkpoint={mode:c.mode};
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
 for(const key of ['run','snapshotId'])if(parsed[key]!==undefined){if(!parsed[key]||parsed[key].length>100)throw new OperatorStop('usage',2);out[key]=parsed[key];}
 // only the pins of the command are accepted
 for(const key of Object.keys(out))if(!NEEDS[command].includes(key))throw new OperatorStop('usage',2);
 return {command,args:out};
}

export async function runWatchlistCutoverProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  let binding,target=null;
  if(deps)({binding}=deps);
  else{
   target=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command!=='status')ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,args:parsed.args,now,ctx:{track}});
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
