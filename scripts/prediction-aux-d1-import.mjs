// Offline import / dry run of the batch_v2 auxiliary prediction state, R2 -> D1 (AIR-553; ADR 0194 decision 10). It reads a LOCAL export of the R2 objects
// (a directory that mirrors the keys, or one JSON file {"<key>": <document>, ...}), builds the rows the Worker itself writes (the same functions of
// src/prediction-aux-d1.js) and prints a report or guarded SQL to stdout. It opens no database, no bucket and no network connection and applies NOTHING: the
// operator applies printed SQL only under an owner GO, inside the AIR-554 cutover plan (legacy writers closed, import verified under that exclusion, then the marker flip).
//
//   node scripts/prediction-aux-d1-import.mjs report <export>     (default dry run: counts, digests, states, blockers; writes nothing)
//   node scripts/prediction-aux-d1-import.mjs sql    <export>     (guarded SQL: import only into EMPTY tables while the marker reads closed)
//   node scripts/prediction-aux-d1-import.mjs digest <export>     (the per-family digests only)
//   node scripts/prediction-aux-d1-import.mjs verify <export>     (guarded SQL that checks the IMPORTED rows against the export, row by row, byte by byte, with child totals, and aborts on any difference)
//   node scripts/prediction-aux-d1-import.mjs preflight <export>  (read-only SELECTs of the exported run ids against D1's prediction_run: finds true orphan sources before activation)
//
// Exit codes: 0 ok, 1 usage, 2 blocker (nothing is printed as SQL). A source the Worker could not read is a blocker: it never becomes an empty or partial import. Blockers: an unreadable or malformed
// pending index or index entry, an object under an event prefix whose key is not one the Worker writes, a manifest without its source, any statement over the D1 byte budget (checked on the exact
// UTF-8 text that would be sent), a stage over its caps, a record without a valid time, more than 256 active pending skipped records, a duplicate identity.
// Handoff (not a production apply): `sql` is ONE file meant to be applied as ONE all-or-nothing D1 batch, the same assumption as the other cutover SQL (a failing statement aborts the file through the fence row).
// The guard needs empty tables and the history tables refuse delete and update, so a partial apply is not resumable and not undoable by SQL: after any apply run `verify` and treat a difference as a
// stop for the AIR-554 plan (a restore is an owner operation). Chunking, if AIR-554 wants it, is its own decision.
// Mapping (deterministic, no clock): stage rows keep their order; every run's sources become revision 1 and every manifest a create-only manifest (all history is kept);
// every stop/start/skipped record becomes one outbox row: delivered and superseded as settled (settled_at = the event's own time, so an old record is compactable at once and its identity stays),
// an undelivered record as pending (or quarantined with its attempts and since, from the pending index), `since` = the index entry's, else the event's `at`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import * as Aux from '../src/prediction-aux-d1.js';

const STAGE_KEY='enrichment/batch-stage.json',OUTBOX_KEY='enrichment/event-outbox.json';
const SOURCE=/^enrichment\/sources\/([A-Za-z0-9_-]{1,100})\.json$/,MANIFEST=/^enrichment\/batch-manifest\/([A-Za-z0-9_-]{1,100})\.json$/;
const EVENT=/^enrichment\/(stop|start)-events\/(skipped-)?([A-Za-z0-9_-]{1,100})\.json$/;
const ITEM_KEYS=['filmId','fingerprint','prediction','failure','inputHash','assessment'];
const pick=item=>Object.fromEntries(ITEM_KEYS.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
const sqlq=value=>value===null||value===undefined?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
const isObject=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const journalKey=event=>'events/items/'+String(9999999999999-Date.parse(event.at)).padStart(13,'0')+'-'+event.id+'.json';
const sha=text=>crypto.createHash('sha256').update(text).digest('hex');
const blocker=(list,code,key,detail)=>list.push({code,key,...(detail?{detail}:{})});

export function readExport(target){
 const stat=fs.statSync(target);
 if(stat.isFile()){const data=JSON.parse(fs.readFileSync(target,'utf8'));if(!isObject(data))throw Object.assign(new Error('the export is not an object of key to document'),{blocker:true});return data;}
 const out={};
 const walk=dir=>{for(const name of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,name.name);if(name.isDirectory())walk(full);else if(name.name.endsWith('.json')){const key=path.relative(target,full).split(path.sep).join('/');try{out[key]=JSON.parse(fs.readFileSync(full,'utf8'));}catch{out[key]=Symbol.for('unreadable');}}}};
 walk(target);
 return out;
}

export async function buildPlan(objects){
 const blockers=[],plan={stage:[],sources:[],manifests:[],outbox:[],blockers,orphanIndexEntries:[],ignored:0};
 // held stage
 const stage=objects[STAGE_KEY];
 if(stage!==undefined){
  if(!isObject(stage)||!Array.isArray(stage.items))blocker(blockers,'stage_unreadable',STAGE_KEY);
  else{
   const sizes=stage.items.map(item=>new TextEncoder().encode(JSON.stringify(pick(item))).length),total=Aux.stageDocBytes(sizes);
   if(stage.items.length>Aux.AUX_LIMITS.stageItems)blocker(blockers,'stage_too_many_items',STAGE_KEY,stage.items.length);
   if(total>Aux.AUX_LIMITS.stageBytes)blocker(blockers,'stage_over_byte_cap',STAGE_KEY,total);
   const seen=new Set();
   stage.items.forEach((item,index)=>{
    if(!isObject(item)||typeof item.filmId!=='string'||!item.filmId||seen.has(item.filmId)||typeof item.itemDigest!=='string'||item.itemDigest.length<8){blocker(blockers,'stage_item_invalid',STAGE_KEY,index);return;}
    seen.add(item.filmId);
    plan.stage.push({filmId:item.filmId,position:index,itemDigest:item.itemDigest,heldByRunId:item.origin?.runId??null,heldAt:item.stagedAt||null,bodyBytes:sizes[index],itemJson:JSON.stringify(item)});
   });
   plan.stageHead={itemCount:plan.stage.length,totalBytes:total,updatedAt:stage.updatedAt||null};
  }
 }
 // sources (every historical run) and manifests
 for(const key of Object.keys(objects).sort()){
  const value=objects[key];
  let match;
  if((match=SOURCE.exec(key))){
   if(!isObject(value)){blocker(blockers,'source_unreadable',key);continue;}
   const text=JSON.stringify(value),pieces=Aux.splitPieces(text);
   plan.sources.push({runId:match[1],hash:await Aux.sha256(value),bytes:new TextEncoder().encode(text).length,pieces});
  }
  else if((match=MANIFEST.exec(key))){
   if(!isObject(value)||value.runId!==match[1]||!Array.isArray(value.films)||!value.films.length||!isObject(value.lease)||!Number.isInteger(value.lease.epoch)||typeof value.manifestHash!=='string'||!isObject(value.profile)||!isObject(value.contract)){blocker(blockers,'manifest_unusable',key);continue;}
   plan.manifests.push(await Aux.buildManifestRecord(match[1],value));
  }
  else if(!EVENT.test(key)&&key!==STAGE_KEY&&key!==OUTBOX_KEY)plan.ignored++;
 }
 // outbox: the records plus the pending index. An index that exists but cannot be read is a blocker: it carries attempts, quarantine and `since`, and an empty index would lose them silently.
 let index={};const indexed=new Set();
 if(OUTBOX_KEY in objects){
  const doc=objects[OUTBOX_KEY];
  if(!isObject(doc)||!isObject(doc.pending))blocker(blockers,'outbox_index_unreadable',OUTBOX_KEY);
  else{
   index=doc.pending;
   for(const [key,entry] of Object.entries(index)){
    if(!EVENT.test(key)){plan.ignoredIndexEntries=(plan.ignoredIndexEntries||0)+1;continue;}   // a non-event entry is ignored by the legacy contract (reported)
    const ok=isObject(entry)&&(entry.attempts===undefined||Number.isInteger(entry.attempts)&&entry.attempts>=0)&&(entry.since===undefined||typeof entry.since==='string'&&/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(entry.since))&&(entry.quarantined===undefined||typeof entry.quarantined==='boolean')&&(entry.lastAttemptAt===undefined||entry.lastAttemptAt===null||typeof entry.lastAttemptAt==='string');
    if(!ok)blocker(blockers,'outbox_index_entry_invalid',key);
   }
  }
 }
 // an object under an event prefix that is not a key the Worker writes is unknown content: a blocker, never silently skipped
 for(const key of Object.keys(objects))if((key.startsWith('enrichment/stop-events/')||key.startsWith('enrichment/start-events/'))&&!EVENT.test(key))blocker(blockers,'event_key_unknown',key);
 const seenKeys=new Set();
 for(const key of Object.keys(objects).sort()){
  const match=EVENT.exec(key);if(!match)continue;
  const record=objects[key];
  if(!isObject(record)||!isObject(record.event)||typeof record.event.id!=='string'||!record.event.id||typeof record.event.at!=='string'||!/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(record.event.at)||record.event.at.length!==24){blocker(blockers,'event_record_unreadable',key);continue;}
  const kind=match[2]?'skipped':match[1],identity=match[3];
  if(match[2]&&match[1]!=='stop'){blocker(blockers,'event_record_unreadable',key);continue;}
  const eventKey=Aux.outboxKey(kind,identity);
  if(seenKeys.has(eventKey)){blocker(blockers,'event_identity_duplicate',key);continue;}
  seenKeys.add(eventKey);
  const entry=isObject(index[key])?index[key]:null;if(entry)indexed.add(key);
  const settled=!!record.delivered;
  const state=settled?(record.superseded?'superseded':'delivered'):entry?.quarantined?'quarantined':'pending';
  plan.outbox.push({eventKey,kind,eventId:record.event.id,at:record.event.at,journalKey:journalKey(record.event),runId:kind==='skipped'?null:(identity),state,attempts:Number.isInteger(entry?.attempts)?entry.attempts:0,since:typeof entry?.since==='string'&&entry.since.length>=20?entry.since:record.event.at,lastAttemptAt:typeof entry?.lastAttemptAt==='string'?entry.lastAttemptAt:null,settledAt:settled?record.event.at:null,payloadDigest:await Aux.sha256(record.event),eventJson:JSON.stringify(record.event)});
 }
 for(const key of Object.keys(index))if(!indexed.has(key)&&EVENT.test(key))plan.orphanIndexEntries.push(key);
  // a manifest is written together with its source: a manifest without one is an incomplete export
 for(const row of plan.manifests)if(!plan.sources.some(source=>source.runId===row.runId))blocker(blockers,'source_missing_for_manifest','enrichment/sources/'+row.runId+'.json');
 const activeSkipped=plan.outbox.filter(row=>row.kind==='skipped'&&row.state==='pending').length;
 if(activeSkipped>Aux.AUX_LIMITS.skippedCap)blocker(blockers,'skipped_over_cap','outbox',activeSkipped);
 plan.outbox.sort((a,b)=>a.eventKey.localeCompare(b.eventKey));
 // every statement that would be sent must fit the D1 statement budget, measured on its exact UTF-8 text (quotes double, multi-byte characters count their bytes)
 for(const line of [...planSql(plan).split('\n'),...planVerifySql(plan).split('\n')])if(Buffer.byteLength(line,'utf8')>Aux.AUX_LIMITS.statementBytes)blocker(blockers,'statement_over_budget',line.slice(0,120),Buffer.byteLength(line,'utf8'));
 plan.sources.sort((a,b)=>a.runId.localeCompare(b.runId));plan.manifests.sort((a,b)=>a.runId.localeCompare(b.runId));
 return plan;
}

export async function planReport(plan){
 const outbox={};for(const row of plan.outbox)outbox[row.state]=(outbox[row.state]||0)+1;
 const digest=async rows=>sha(JSON.stringify(rows));
 return {
  blockers:plan.blockers,
  stage:{items:plan.stage.length,totalBytes:plan.stageHead?.totalBytes??0,digest:await digest(plan.stage.map(r=>[r.filmId,r.position,r.itemDigest,r.bodyBytes,sha(r.itemJson)]))},
  sources:{runs:plan.sources.length,revisions:plan.sources.length,bytes:plan.sources.reduce((n,r)=>n+r.bytes,0),digest:await digest(plan.sources.map(r=>[r.runId,r.hash]))},
  manifests:{count:plan.manifests.length,pieces:plan.manifests.reduce((n,r)=>n+r.pieces.length,0),digest:await digest(plan.manifests.map(r=>[r.runId,r.manifestHash,r.payloadDigest]))},
  outbox:{total:plan.outbox.length,byState:outbox,skippedActivePending:plan.outbox.filter(r=>r.kind==='skipped'&&r.state==='pending').length,digest:await digest(plan.outbox.map(r=>[r.eventKey,r.eventId,r.at,r.journalKey,r.state,r.attempts,r.since,r.settledAt,r.payloadDigest]))},
  orphanIndexEntries:plan.orphanIndexEntries.length,
  ignoredIndexEntries:plan.ignoredIndexEntries||0,
  runRowPreflight:{runIds:planRunPreflightSql(plan).ids.length,note:'run `preflight` against D1 (read-only): a source or manifest whose run id has no prediction_run row is a true orphan; the Worker reader refuses it (source_without_run), so classify it for preservation or as an activation blocker'},
  ignoredObjects:plan.ignored,
  writes:'none (a dry run reads a local export and prints; it opens no database)',
 };
}

// Guarded SQL. The first statement aborts the whole file unless the marker reads `closed` (ADR 0196: the import runs under the admission close, never while the old writers are admitted) and every
// auxiliary table is empty (an import never merges into existing history).
// Every statement is one line and holds at most one piece, so none exceeds the D1 statement budget.
export function planSql(plan){
 const empty=['prediction_batch_stage','prediction_run_source_head','prediction_run_manifest','prediction_event_outbox'].map(table=>'(SELECT count(*)=0 FROM '+table+')').join('*');
 const lines=["UPDATE prediction_aux_cas SET ok=(SELECT count(*) FROM prediction_aux_authority WHERE id=1 AND mode='closed')*"+empty+' WHERE id=1;'];
 const stamp='1970-01-01T00:00:00.000Z';
 for(const r of plan.stage)lines.push('INSERT INTO prediction_batch_stage (film_id, position, item_digest, held_by_run_id, held_at, body_bytes, item_json) VALUES ('+[sqlq(r.filmId),r.position,sqlq(r.itemDigest),sqlq(r.heldByRunId),sqlq(r.heldAt),r.bodyBytes,sqlq(r.itemJson)].join(', ')+');');
 if(plan.stage.length)lines.push('UPDATE prediction_batch_stage_head SET item_count='+plan.stageHead.itemCount+', total_bytes='+plan.stageHead.totalBytes+', revision=1, updated_at='+sqlq(plan.stageHead.updatedAt)+' WHERE id=1 AND revision=0;');
 for(const r of plan.sources){
  lines.push('INSERT INTO prediction_run_source_revision (run_id, revision, source_hash, bytes, piece_count, created_at) VALUES ('+[sqlq(r.runId),1,sqlq(r.hash),r.bytes,r.pieces.length,sqlq(stamp)].join(', ')+');');
  r.pieces.forEach((piece,i)=>lines.push('INSERT INTO prediction_run_source_piece (run_id, revision, piece_no, text) VALUES ('+[sqlq(r.runId),1,i,sqlq(piece)].join(', ')+');'));
  lines.push('INSERT INTO prediction_run_source_head (run_id, current_revision, source_hash) VALUES ('+[sqlq(r.runId),1,sqlq(r.hash)].join(', ')+');');
 }
 for(const r of plan.manifests){
  for(const [statement,params] of Aux.manifestStatements(r,stamp)){let n=0;lines.push(statement.replace(/\?/g,()=>sqlq(params[n++]))+';');}
 }
 for(const r of plan.outbox)lines.push('INSERT INTO prediction_event_outbox (event_key, kind, event_id, at, journal_key, run_id, state, attempts, since, last_attempt_at, settled_at, payload_digest, payload_compacted, event_json) VALUES ('+[sqlq(r.eventKey),sqlq(r.kind),sqlq(r.eventId),sqlq(r.at),sqlq(r.journalKey),sqlq(r.runId),sqlq(r.state),r.attempts,sqlq(r.since),sqlq(r.lastAttemptAt),sqlq(r.settledAt),sqlq(r.payloadDigest),0,sqlq(r.eventJson)].join(', ')+');');
 return lines.join('\n')+'\n';
}

// Guarded SQL that checks the imported rows against the export, one fence statement per row (each aborts the file when its row differs), then the family totals. It reads nothing outside the tables and
// writes only the fence row. Source pieces compare their bytes; manifest pieces their stored digests and lengths; the outbox its identity, state and digest.
export function planVerifySql(plan){
 const eq=(count,where)=>"UPDATE prediction_aux_cas SET ok=(SELECT count(*)="+count+" FROM "+where+") WHERE id=1;";
 const nul=value=>value===null||value===undefined?'NULL':sqlq(value);
 const lines=[];
 for(const r of plan.stage)lines.push(eq(1,"prediction_batch_stage WHERE film_id="+sqlq(r.filmId)+" AND position="+r.position+" AND item_digest="+sqlq(r.itemDigest)+" AND held_by_run_id IS "+nul(r.heldByRunId)+" AND body_bytes="+r.bodyBytes+" AND item_json="+sqlq(r.itemJson)));
 lines.push(eq(plan.stage.length,'prediction_batch_stage'));
 for(const r of plan.sources){
  lines.push(eq(1,"prediction_run_source_head WHERE run_id="+sqlq(r.runId)+" AND current_revision=1 AND source_hash="+sqlq(r.hash)));
  lines.push(eq(1,"prediction_run_source_revision WHERE run_id="+sqlq(r.runId)+" AND revision=1 AND source_hash="+sqlq(r.hash)+" AND bytes="+r.bytes+" AND piece_count="+r.pieces.length));
  r.pieces.forEach((piece,i)=>lines.push(eq(1,"prediction_run_source_piece WHERE run_id="+sqlq(r.runId)+" AND revision=1 AND piece_no="+i+" AND text="+sqlq(piece))));
  // child totals PER RUN: no extra revision and no extra piece of any revision may hide behind the checked ones
  lines.push(eq(1,"prediction_run_source_revision WHERE run_id="+sqlq(r.runId)));
  lines.push(eq(r.pieces.length,"prediction_run_source_piece WHERE run_id="+sqlq(r.runId)));
 }
 lines.push(eq(plan.sources.length,'prediction_run_source_head'));
 lines.push(eq(plan.sources.length,'prediction_run_source_revision'));
 lines.push(eq(plan.sources.reduce((n,r)=>n+r.pieces.length,0),'prediction_run_source_piece'));
 for(const r of plan.manifests){
  lines.push(eq(1,"prediction_run_manifest WHERE run_id="+sqlq(r.runId)+" AND manifest_hash="+sqlq(r.manifestHash)+" AND payload_digest="+sqlq(r.payloadDigest)+" AND selected_ids="+sqlq(r.selectedIds)+" AND drained_json IS "+nul(r.drainedJson)+" AND bytes="+r.bytes+" AND piece_count="+r.pieces.length+" AND part_index="+sqlq(r.partIndex)));
  // the actual bytes of every piece (not its stored digest alone): a different string of the same length cannot pass
  r.pieces.forEach((piece,i)=>lines.push(eq(1,"prediction_run_manifest_piece WHERE run_id="+sqlq(r.runId)+" AND piece_no="+i+" AND piece_digest="+sqlq(r.digests[i])+" AND text="+sqlq(piece))));
  lines.push(eq(r.pieces.length,"prediction_run_manifest_piece WHERE run_id="+sqlq(r.runId)));
 }
 lines.push(eq(plan.manifests.length,'prediction_run_manifest'));
 lines.push(eq(plan.manifests.reduce((n,r)=>n+r.pieces.length,0),'prediction_run_manifest_piece'));
 for(const r of plan.outbox)lines.push(eq(1,"prediction_event_outbox WHERE event_key="+sqlq(r.eventKey)+" AND kind="+sqlq(r.kind)+" AND event_id="+sqlq(r.eventId)+" AND at="+sqlq(r.at)+" AND journal_key="+sqlq(r.journalKey)+" AND run_id IS "+nul(r.runId)+" AND state="+sqlq(r.state)+" AND attempts="+r.attempts+" AND since="+sqlq(r.since)+" AND last_attempt_at IS "+nul(r.lastAttemptAt)+" AND settled_at IS "+nul(r.settledAt)+" AND payload_digest="+sqlq(r.payloadDigest)+" AND payload_compacted=0 AND event_json="+sqlq(r.eventJson)));
 lines.push(eq(plan.outbox.length,'prediction_event_outbox'));
 return lines.join('\n')+'\n';
}
// A read-only preflight for AIR-554: the run ids of the exported sources and manifests, as SELECTs over `prediction_run` (chunks of 100 ids). A legacy start wrote the R2 source object BEFORE the D1 run row, so a
// crash can leave a source with no run; the Worker's source reader refuses a head without its run row (`source_without_run`), so the importer's acceptance of such a source is NOT reader parity. The operator runs
// these SELECTs (no write, no live check is made here), takes the ids that are missing from the answer as true orphans and classifies each for preservation outside the Worker's readers or as an activation blocker.
export function planRunPreflightSql(plan){
 const ids=[...new Set([...plan.sources.map(r=>r.runId),...plan.manifests.map(r=>r.runId)])].sort();
 const out=[];
 for(let i=0;i<ids.length;i+=100)out.push("SELECT run_id FROM prediction_run WHERE run_id IN ("+ids.slice(i,i+100).map(sqlq).join(',')+") ORDER BY run_id;");
 return {ids,sql:out.length?out.join('\n')+'\n':''};
}
async function main(argv){
 const [command,target]=argv;
 if(!['report','sql','digest','verify','preflight'].includes(command)||!target){process.stderr.write('usage: prediction-aux-d1-import.mjs report|sql|digest|verify|preflight <r2-export>\n');return 1;}
 let plan;
 try{plan=await buildPlan(readExport(target));}catch(error){process.stderr.write('BLOCKER: '+error.message+'\n');return 2;}
 const report=await planReport(plan);
 if(plan.blockers.length){process.stderr.write('BLOCKER: '+JSON.stringify(plan.blockers)+'\n');if(command==='report')process.stdout.write(JSON.stringify(report,null,1)+'\n');return 2;}
 if(command==='sql')process.stdout.write(planSql(plan));
 else if(command==='verify')process.stdout.write(planVerifySql(plan));
 else if(command==='preflight')process.stdout.write(planRunPreflightSql(plan).sql);
 else if(command==='digest')process.stdout.write(JSON.stringify({stage:report.stage.digest,sources:report.sources.digest,manifests:report.manifests.digest,outbox:report.outbox.digest})+'\n');
 else process.stdout.write(JSON.stringify(report,null,1)+'\n');
 return 0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname))process.exitCode=await main(process.argv.slice(2));
