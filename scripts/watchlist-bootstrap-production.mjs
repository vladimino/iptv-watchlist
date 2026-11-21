#!/usr/bin/env node
// Owner-only production operator for holdpoint (c) of ADR 0186 decision 8: the bootstrap import of the current published watchlist into snapshot version 1,
// while the Watchlist marker is still `epg`. AIR-571. Default is read-only `status`; the only write is `bootstrap`, with an explicit `--confirm bootstrap`.
// It is NOT a scan: it writes the staging row, the ordered members, the snapshot row and the pointer in ONE atomic D1 batch (src/watchlist-bootstrap.js) and
// nothing else (no change, effect or pending-admission row, no fact, no marker move). It never calls Letterboxd, the Worker or R2.
//
//   status     read-only: schema, marker, pointer, the published generation and its certificate, the source list and its digest, the pin check, the EPG liveness
//   digest     --file <saved GET /api/watchlist response>   local and read-only: count and membership digest (ids in order) of the presented list
//   bootstrap  --expect-run <programmeRunId> --expect-epg-generation <n> --expect-count <n> --expect-members-sha256 <digest> --expect-sha256 <digest>
//              two separate pins. Membership and order parity (members-sha256) come from the authoritative API response, which localizes titles at read time and so
//              cannot pin titles. The raw payload pin (sha256, titles included) is bound to the exact generation and is read from the stored source by `status`; a mismatch of either refuses
//
// Fail-closed: exactly marker epg/open at the generation read, pointer version 0, empty watchlist tables, a published generation that is certified complete
// (finalized_run_id = programme_run_id) and equal to the pin, a source list that normalizes (unique ids, order, shape) and whose digest equals the pin, and no executing
// EPG step. After the batch the state is read back independently; an unproven outcome is `write_uncertain`, never retried, never downgraded by a readback.
// A second run on an equal import answers `already_applied` and writes nothing. Stable fields are compared, never whole-row digests of live counters.
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,normalize,OperatorStop,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {listDigest} from '../src/watchlist-d1.js';
import {bootstrapStatements,LEASE_MARGIN_MS,livenessOf,membershipDigest,sourceList} from '../src/watchlist-bootstrap.js';

export const COMMANDS=['status','bootstrap','digest'];
const WATCHLIST_TABLES=['watchlist_authority','watchlist_cas','watchlist_current','watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
const EMPTY_TABLES=['watchlist_staging','watchlist_snapshot','watchlist_member','watchlist_change','watchlist_effect','watchlist_admission_pending'];
const VALUE_FLAGS={'--target':'target','--confirm':'confirm','--expect-run':'run','--expect-count':'count','--expect-sha256':'sha256','--expect-members-sha256':'membersSha256','--expect-epg-generation':'epgGeneration','--file':'file'};
const iso=ms=>new Date(ms).toISOString();

async function one(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).first())??null;}
async function many(binding,sql,params=[]){return (await binding.prepare(sql).bind(...params).all()).results||[];}
const json=text=>{try{return JSON.parse(text);}catch{return undefined;}};

// ---- state (D1, read-only) ------------------------------------------------------------------------------------------------
export async function readState(binding){
 try{
  const version=Number((await one(binding,'SELECT version FROM schema_contract WHERE id=1'))?.version);
  const names=(await many(binding,"SELECT name FROM sqlite_master WHERE type='table'")).map(row=>row.name);
  const present=WATCHLIST_TABLES.filter(name=>names.includes(name));
  const state={schemaVersion:Number.isFinite(version)?version:null,tables:{present:present.length,expected:WATCHLIST_TABLES.length},marker:null,pointer:null,counts:null,published:null,source:null,sourceMembers:null,orchestration:{},markers:{}};
  if(present.length===WATCHLIST_TABLES.length){
   state.marker=await one(binding,'SELECT mode, generation, writes, (SELECT COUNT(*) FROM watchlist_cas WHERE id=1) AS cas FROM watchlist_authority WHERE id=1');
   state.pointer=await one(binding,'SELECT version, snapshot_id, list_sha256, film_count, last_success_run, effects_drained_version, revision FROM watchlist_current WHERE id=1');
   state.counts={};
   for(const table of EMPTY_TABLES)state.counts[table]=Number((await one(binding,'SELECT COUNT(*) AS n FROM '+table))?.n);
  }
  if(names.includes('published_epg_authority')){
   state.published=await one(binding,'SELECT mode, cutover, programme_run_id, generation, finalized_run_id, finalized_at FROM published_epg_authority WHERE id=1');
   const run=state.published?.programme_run_id;
   if(run&&names.includes('published_epg_document')){
    const rows=await many(binding,"SELECT ordinal, payload_json FROM published_epg_document WHERE programme_run_id=? AND kind='watchlist' ORDER BY ordinal",[run]);
    let text='',contiguous=rows.length>0;
    rows.forEach((row,index)=>{if(Number(row.ordinal)!==index)contiguous=false;text+=row.payload_json;});
    state.source=contiguous?json(text)??null:null;
    state.sourceMembers=(await many(binding,"SELECT film_id FROM published_epg_member WHERE programme_run_id=? AND kind='watchlist' ORDER BY ordinal",[run])).map(row=>row.film_id);
   }
  }
  if(names.includes('epg_orchestration_document'))for(const row of await many(binding,'SELECT key, body, revision FROM epg_orchestration_document'))state.orchestration[row.key]={revision:Number(row.revision),body:json(row.body)??null};
  // Stable fields of the other domains' markers (never a digest of a whole row: those rows carry live counters).
  for(const [table,columns] of [['epg_checkpoint_authority','mode, writes'],['published_epg_authority','mode, cutover'],['ratings_domain_authority','mode, cutover'],['film_person_authority','mode, cutover'],['discovery_authority','mode, cutover'],['letterboxd_sync_mode','mode, epoch']])
   if(names.includes(table))state.markers[table]=JSON.stringify(await many(binding,'SELECT '+columns+' FROM '+table+' ORDER BY 1'));
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}

// The source list of the published generation, checked against the pin. -> {ok,films,digest,reason?}
export async function sourceOf(state){
 const list=await sourceList(state.source);
 if(!list.ok)return list;
 // The two stored forms of the same membership agree: the document order is the member row order.
 if(!state.sourceMembers||state.sourceMembers.length!==list.films.length||state.sourceMembers.some((id,index)=>id!==list.films[index].lid))return {ok:false,reason:'source_mismatch'};
 return {...list,membersSha256:await membershipDigest(list.films)};
}

// Decision of the bootstrap from the stored state alone.
export function decision(state){
 if(state.tables.present!==state.tables.expected)return state.tables.present?'partial_schema':'schema_absent';
 if(state.schemaVersion<31)return 'schema_unexpected';
 const m=state.marker;
 if(!m||Number(m.cas)!==1||m.mode!=='epg'||m.writes!=='open')return 'marker_not_epg_open';
 const p=state.pointer;
 if(!p)return 'pointer_missing';
 if(Number(p.version)!==0)return 'already_bootstrapped';
 if(p.snapshot_id!==null)return 'pointer_contradiction';
 if(EMPTY_TABLES.some(table=>state.counts[table]!==0))return 'tables_not_empty';
 const pub=state.published;
 if(!pub||pub.mode!=='d1'||pub.cutover!=='open'||!pub.programme_run_id)return 'published_unavailable';
 if(pub.finalized_run_id!==pub.programme_run_id)return 'published_not_certified';
 // Fail closed: a missing record is idle, a present record that does not satisfy the EPG record contract (known phase, schemaVersion and budget; holder, parseable expiry and boolean released) is unknown.
 if(!livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},0).ok)return 'liveness_unknown';
 return 'ready';
}

export function pinProblems(state,source,args){
 const problems=[];
 if(args.run!==state.published.programme_run_id)problems.push('run');
 if(args.epgGeneration!==Number(state.published.generation))problems.push('epg_generation');
 if(args.count!==source.films.length)problems.push('count');
 if(args.membersSha256!==source.membersSha256)problems.push('members_sha256');
 if(args.sha256!==source.digest)problems.push('sha256');
 return problems;
}

// A read-only proof that an existing import is complete and still the import of the CURRENT source. It validates the snapshot row, the staging row, every member row (count,
// order, digest), the absence of unexpected rows and the pointer; then the published source against the pins. Nothing is written. `verified_equal` is a receipt of equality only:
// it is never an authorization for the next holdpoint.
export async function verifyImported(binding,state,args,{requireSource=true}={}){
 const problems=[];
 const p=state.pointer,c=state.counts;
 if(Number(p.version)!==1||!p.snapshot_id)return {ok:false,reason:'already_bootstrapped',problems:['pointer_version']};
 const id=p.snapshot_id;
 const snap=await one(binding,'SELECT version, scan_id, film_count, list_sha256, prev_version, run_id FROM watchlist_snapshot WHERE snapshot_id=?',[id]);
 const stage=await one(binding,'SELECT run_id, expected_count, expected_sha256 FROM watchlist_staging WHERE snapshot_id=?',[id]);
 if(!snap||Number(snap.version)!==1||Number(snap.prev_version)!==0||snap.list_sha256!==p.list_sha256||Number(snap.film_count)!==Number(p.film_count)||snap.scan_id!=='bootstrap:'+snap.run_id||snap.run_id!==p.last_success_run)problems.push('snapshot');
 if(!stage||stage.expected_sha256!==p.list_sha256||Number(stage.expected_count)!==Number(p.film_count)||stage.run_id!==snap?.run_id)problems.push('staging');
 if(c.watchlist_staging!==1||c.watchlist_snapshot!==1||c.watchlist_member!==Number(p.film_count)||c.watchlist_change!==0||c.watchlist_effect!==0||c.watchlist_admission_pending!==0||Number(p.effects_drained_version)!==1)problems.push('rows');
 const rows=await many(binding,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[id]);
 const stored=rows.map(row=>({ordinal:Number(row.ordinal),lid:row.lid,title:row.title,year:row.year===null?null:Number(row.year),url:row.url}));
 if(stored.length!==Number(p.film_count)||stored.some((row,index)=>row.ordinal!==index)||await listDigest(stored)!==p.list_sha256)problems.push('members');
 if(problems.length)return {ok:false,reason:'snapshot_inconsistent',problems};
 // The pins describe the import that was approved; they must equal it and the current published source must still be that source.
 if(args.run!==snap.run_id||args.sha256!==p.list_sha256||args.count!==Number(p.film_count)||args.membersSha256!==await membershipDigest(stored))return {ok:false,reason:'already_bootstrapped',problems:['pins_differ']};
 if(!requireSource)return {ok:true};
 const pub=state.published;
 if(!pub||pub.mode!=='d1'||pub.cutover!=='open'||pub.programme_run_id!==snap.run_id||Number(pub.generation)!==args.epgGeneration||pub.finalized_run_id!==pub.programme_run_id)return {ok:false,reason:'source_moved',problems:['published'],published:pub?{programmeRunId:pub.programme_run_id,generation:Number(pub.generation)}:null};
 const source=await sourceOf(state);
 if(!source.ok||source.digest!==p.list_sha256)return {ok:false,reason:'source_moved',problems:['source_digest']};
 return {ok:true};
}

const view=state=>({schemaVersion:state.schemaVersion,marker:state.marker?{mode:state.marker.mode,writes:state.marker.writes,generation:Number(state.marker.generation)}:null,pointer:state.pointer?{version:Number(state.pointer.version),snapshotId:state.pointer.snapshot_id,filmCount:state.pointer.film_count===null?null:Number(state.pointer.film_count),listSha256:state.pointer.list_sha256,revision:Number(state.pointer.revision)}:null,counts:state.counts,published:state.published?{mode:state.published.mode,cutover:state.published.cutover,programmeRunId:state.published.programme_run_id,generation:Number(state.published.generation),certified:state.published.finalized_run_id===state.published.programme_run_id}:null});

// What the independent readback must show after the batch.
export async function readbackProblems(binding,after,before,{snapshotId,pin,films}){
 const problems=[];
 const m=after.marker;
 if(!m||m.mode!=='epg'||m.writes!=='open'||Number(m.generation)!==Number(before.marker.generation)||Number(m.cas)!==1)problems.push('marker_changed');
 const p=after.pointer;
 if(!p||Number(p.version)!==1||p.snapshot_id!==snapshotId||p.list_sha256!==pin.sha256||Number(p.film_count)!==pin.count||Number(p.effects_drained_version)!==1||Number(p.revision)!==Number(before.pointer.revision)+1||p.last_success_run!==pin.programmeRunId)problems.push('pointer');
 const c=after.counts;
 if(!c||c.watchlist_staging!==1||c.watchlist_snapshot!==1||c.watchlist_member!==pin.count||c.watchlist_change!==0||c.watchlist_effect!==0||c.watchlist_admission_pending!==0)problems.push('rows');
 const rows=await many(binding,'SELECT ordinal, lid, title, year, url FROM watchlist_member WHERE snapshot_id=? ORDER BY ordinal',[snapshotId]);
 const stored=rows.map(row=>({ordinal:Number(row.ordinal),lid:row.lid,title:row.title,year:row.year===null?null:Number(row.year),url:row.url}));
 if(stored.length!==films.length||await listDigest(stored)!==pin.sha256)problems.push('member_digest');
 const snap=await one(binding,'SELECT version, film_count, list_sha256, prev_version, run_id FROM watchlist_snapshot WHERE snapshot_id=?',[snapshotId]);
 if(!snap||Number(snap.version)!==1||Number(snap.film_count)!==pin.count||snap.list_sha256!==pin.sha256||Number(snap.prev_version)!==0||snap.run_id!==pin.programmeRunId)problems.push('snapshot');
 if(!after.published||after.published.programme_run_id!==before.published.programme_run_id||Number(after.published.generation)!==Number(before.published.generation))problems.push('published_moved');
 for(const table of Object.keys(before.markers))if(before.markers[table]!==after.markers[table])problems.push('marker_changed:'+table);
 return problems;
}

export async function execute(command,{binding,args={},now,ctx={}}){
 const clock=typeof now==='function'?now():now;
 const state=await readState(binding);
 const verdict=decision(state);
 let source=null;
 if(verdict==='ready'||verdict==='already_bootstrapped'){source=verdict==='ready'?await sourceOf(state):null;}
 if(command==='status')return {operation:'status',writes:false,writeState:'none',decision:verdict,...view(state),source:source?source.ok?{count:source.films.length,sha256:source.digest,membersSha256:source.membersSha256,epgGeneration:state.published?Number(state.published.generation):null}:{problem:source.reason}:null,epgBusy:livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock).busy??null};
 if(command!=='bootstrap')throw new OperatorStop('usage',2);
 if(verdict==='already_bootstrapped'){
  // An import that already exists is verified read-only, never trusted from the pointer alone. Equal and current: a receipt, nothing written. Anything else is refused with its reason.
  const proof=await verifyImported(binding,state,args);
  if(!proof.ok)throw new OperatorStop(proof.reason,3,{problems:proof.problems,...(proof.published?{published:proof.published}:{})});
  return {operation:'bootstrap',writes:false,writeState:'none',outcome:'already_applied',receipt:'verified_equal',note:'a receipt of equality, not an authorization for the next holdpoint',...view(state)};
 }
 if(verdict!=='ready')throw new OperatorStop(verdict,3);
 if(!source.ok)throw new OperatorStop(source.reason,3);
 const problems=pinProblems(state,source,args);
 if(problems.length)throw new OperatorStop('pin_mismatch',3,{problems});
 const live=livenessOf({control:state.orchestration.control,lease:state.orchestration.lease},clock);
 if(!live.ok)throw new OperatorStop('liveness_unknown',3,{reason:live.reason});
 if(live.busy)throw new OperatorStop('writer_active',3,{busy:live.busy});
 const snapshotId=ctx.snapshotId??randomUUID();
 const pin={programmeRunId:state.published.programme_run_id,epgGeneration:Number(state.published.generation),count:source.films.length,sha256:source.digest,observedAt:iso(Date.parse(state.published.finalized_at||'')||clock)};
 const plan=bootstrapStatements({films:source.films,pin,snapshotId,at:iso(clock),generation:Number(state.marker.generation),revision:Number(state.pointer.revision),liveness:{controlRevision:state.orchestration.control?.revision??-1,leaseRevision:state.orchestration.lease?.revision??-1,liveAfterIso:iso(clock-LEASE_MARGIN_MS)}});
 if(ctx.track)ctx.track('unknown');
 try{await binding.batch(plan.statements.map(([sql,params])=>binding.prepare(sql).bind(...params)));}
 catch(error){
  // The batch is atomic. Read the state before saying anything; never retry. Only a PROVEN rejection (a D1 statement error) with an untouched readback is "not applied".
  let after=null;
  try{after=await readState(binding);}catch{after=null;}
  const rejected=error instanceof D1Error&&error.kind==='statement';
  const untouched=rejected&&Boolean(after)&&Number(after.pointer?.version)===0&&EMPTY_TABLES.every(table=>after.counts?.[table]===0);
  if(ctx.track)ctx.track(untouched?'none':'unknown');
  throw new OperatorStop(untouched?'statement_failed':'write_uncertain',3,{snapshotId,after:after?view(after):null});
 }
 let after,problemsAfter;
 try{after=await readState(binding);problemsAfter=await readbackProblems(binding,after,state,{snapshotId,pin,films:source.films});}
 catch{throw new OperatorStop('write_uncertain',3,{snapshotId,reason:'readback_unreadable'});}
 if(problemsAfter.length)throw new OperatorStop('write_uncertain',3,{snapshotId,reason:'readback_mismatch',problems:problemsAfter,...view(after)});
 if(ctx.track)ctx.track('committed');
 return {operation:'bootstrap',writes:true,writeState:'committed',snapshotId,statements:plan.statements.length,pin,before:view(state),after:view(after)};
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
 if(command==='digest'){if(parsed.file===undefined||parsed.target!==undefined||parsed.confirm!==undefined)throw new OperatorStop('usage',2);return {command,args:{file:parsed.file}};}
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(parsed.confirm!==undefined)throw new OperatorStop('usage',2);return {command,args:{}};}
 if(parsed.confirm!==command)throw new OperatorStop('confirm',2);
 for(const need of ['run','epgGeneration','count','membersSha256','sha256'])if(parsed[need]===undefined)throw new OperatorStop('usage',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.sha256)||!/^[0-9a-f]{64}$/.test(parsed.membersSha256)||!/^\d{1,5}$/.test(parsed.count)||!/^\d{1,9}$/.test(parsed.epgGeneration)||parsed.run.length>100)throw new OperatorStop('usage',2);
 parsed.count=Number(parsed.count);parsed.epgGeneration=Number(parsed.epgGeneration);
 return {command,args:parsed};
}

// The membership pin of a saved authoritative `GET /api/watchlist` response: count and digest of the ids in order. Local and read-only; titles are never hashed.
export async function digestOfFile(file){
 let body;
 try{body=JSON.parse(fs.readFileSync(file,'utf8'));}catch{throw new OperatorStop('digest_input',2);}
 if(!body||!Array.isArray(body.films)||!body.films.length||body.films.some(film=>typeof film?.id!=='string'||!film.id))throw new OperatorStop('digest_input',2);
 const ids=body.films.map(film=>film.id);
 if(new Set(ids).size!==ids.length)throw new OperatorStop('digest_input',2);
 return {operation:'digest',writes:false,writeState:'none',count:ids.length,membersSha256:await membershipDigest(ids.map((id,ordinal)=>({ordinal,lid:id})))};
}

export async function runWatchlistBootstrapProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,now=()=>Date.now(),deps=null}={}){
 const ctx={writeState:'none',bookmark:null};
 const track=state=>{ctx.writeState=state;};
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  if(parsed.command==='digest')return {exit:0,result:await digestOfFile(parsed.args.file)};
  let binding,target=null;
  if(deps)({binding}=deps);
  else{
   target=productionTarget(env);
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=createPublishedBinding(adapter);
   if(parsed.command==='bootstrap')ctx.bookmark=await readBookmark(target,fetchImpl);
  }
  const result=await execute(parsed.command,{binding,args:parsed.args,now,ctx:{track}});
  let bookmarkAfter=null;
  if(parsed.command==='bootstrap'&&result.writes&&target)try{bookmarkAfter=await readBookmark(target,fetchImpl);}catch{bookmarkAfter=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(bookmarkAfter?{bookmarkAfter}:{})}};
 }catch(error){
  const stop=normalize(error);
  const writeState=ctx.writeState==='committed'||ctx.writeState==='unknown'?ctx.writeState:'none';
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='committed'?true:writeState==='unknown'?null:false,...(writeState!=='none'?{retry:false}:{}),...(stop.details&&Object.keys(stop.details).length?{details:stop.details}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runWatchlistBootstrapProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
