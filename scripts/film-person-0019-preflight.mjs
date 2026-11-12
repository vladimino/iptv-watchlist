// AIR-374 H0 (docs/runbooks/film-person-0019-apply.md): the OFFLINE operator preflight kit for migration 0019 (schema 18 to 19). It touches no network, no D1, no R2, no
// Cloudflare and no connector, and it never applies anything. It (1) recomputes the identity of the migration file (git blob hash, sha256, byte count, statement
// count) from the file, (2) EMITS the exact read-only SELECT statements of the preflight (runbook section 4) and of the readback (section 6), built from the migration
// file so they cannot drift from it, and (3) VERIFIES result JSON that an authorized operator pasted back, refusing anything else with named reasons.
// A pass is evidence, never permission: the owner's operation-specific GO (runbook section 3) is separate, and nothing here is a GO.
//
//   node scripts/film-person-0019-preflight.mjs identity [file]
//   node scripts/film-person-0019-preflight.mjs preflight-sql          the SELECT statements to run BEFORE the apply
//   node scripts/film-person-0019-preflight.mjs readback-sql           the SELECT statements to run AFTER the apply
//   node scripts/film-person-0019-preflight.mjs verify-preflight <results.json> --reference <GO baseline reference> [--now ISO]
//   node scripts/film-person-0019-preflight.mjs verify-readback <readback.json> --preflight <preflight.json> --reference <GO baseline reference>
//   either verify command with --diagnostic: shape only, never a GO pass (ok is always false, diagnosticOnly true)
// The GO-specific verification FAILS CLOSED: without the exact accepted baseline reference named in the GO (and, for the readback, the preflight results bundle) it refuses.
// A results file is {"<statement id>": <rows array | D1 response envelope [{success,results}]>}. Exit status 1 on a refusal.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReadOnly,expectedObjects,unwrap} from './schema-preflight.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MIGRATION='migrations/0019_canonical_write_receipt.sql';
export const FROM_VERSION=18;
export const TO_VERSION=19;
export const SHARED_TRIGGER='schema_contract_no_downgrade';
export const NOTE='Schema v19: durable canonical write receipt and activation baseline (empty). Follows a complete version 18.';
export const RECEIPT_TABLES=Object.freeze(['canonical_write_receipt','canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal']);
export const H1_TABLES=Object.freeze(['canonical_revision','film_rated_admission','film_retention','tmdb_retirement_decision']);
const REFERENCE=/^cutover_accepted\/v2:[0-9a-f]{64}$/;
const quote=name=>"'"+name+"'";

export function identityOf(text){
 const bytes=Buffer.from(text,'utf8');
 const statements=text.split('\n').filter(line=>/^(INSERT|CREATE|UPDATE)\b/.test(line)).length;
 return {
  file:MIGRATION,
  gitBlob:createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex'),
  sha256:createHash('sha256').update(bytes).digest('hex'),
  bytes:bytes.length,
  statements,
  expectedApplyResults:{statements,firstChanges:0,lastChanges:1,allSuccess:true},
 };
}
export const readMigration=(root=ROOT)=>fs.readFileSync(path.join(root,MIGRATION),'utf8');

// The eight prerequisite tables are read from the refuse-insert of the file itself.
export function prerequisiteTables(text){
 const match=/WHERE type = 'table' AND name IN \(([^)]*)\)/.exec(text);
 if(!match)throw new Error('refuse-insert prerequisite list not found in the migration');
 const out=match[1].split(',').map(item=>{const token=/^\s*'([a-z][a-z0-9_]*)'\s*$/.exec(item);if(!token)throw new Error('unexpected object name in the prerequisite list');return token[1];});
 if(out.length!==8)throw new Error('the prerequisite list must hold eight tables, found '+out.length);
 return out;
}
// Everything the file creates, by type, from the file (the shared trigger is separate).
export function expectedFromFile(text){
 const objects=expectedObjects(text);
 const by=type=>objects.filter(item=>item.type===type).map(item=>item.name).sort();
 return {tables:by('table'),indexes:by('index'),triggers:by('trigger')};
}

const NAMES=/^[a-z][a-z0-9_]*$/;
function names(list){for(const name of list)if(!NAMES.test(name))throw new Error('unexpected object name '+name);return list.map(quote).join(', ');}
export const COMPARED=Object.freeze(['projector_lease','projector_window','discovery_lease']);
export const step=(id,purpose,sql,expect)=>({id,purpose,sql:assertReadOnly(sql),expect});

export function preflightSteps(text=readMigration()){
 const prereq=prerequisiteTables(text);
 return [
  step('schema','runbook row 2: schema_contract','SELECT id, version, note FROM schema_contract ORDER BY id','exactly one row, version 18'),
  step('prerequisites','row 3: the eight prerequisite tables',"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("+names(prereq)+") ORDER BY name",'8 rows'),
  step('existing_receipt_objects','row 4: no object of 0019 exists yet',"SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_*receipt*' ORDER BY type, name",'0 rows'),
  step('shared_trigger','row 5: the shared trigger exists',"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = "+quote(SHARED_TRIGGER),'1 row'),
  step('canonical_revision','row 6: canonical_revision is empty','SELECT COUNT(*) AS n, MAX(revision) AS m FROM canonical_revision','n 0, m null (non-zero is reported, not a blocker)'),
  step('marker','row 7: marker','SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1','prepared / open / 1'),
  step('fence','row 7: fence','SELECT ok FROM film_person_cas WHERE id = 1','ok 1'),
  step('baseline','row 7: baseline','SELECT state, reference FROM film_person_baseline WHERE id = 1','verified, reference cutover_accepted/v2:<digest>'),
  step('projector_lease','row 8: projector lease',"SELECT lease_id, lease_until FROM projection_run WHERE projection = 'enrichment'",'no row, lease_id null, or lease_until earlier than now'),
  step('projector_window','row 9: projector window','SELECT state, expires_at FROM projector_window WHERE id = 1','idle'),
  step('discovery_lease','row 10: Discovery lease (expires_at is epoch milliseconds)','SELECT id, lease_id, expires_at FROM discovery_lease','no row, lease_id null, or expires_at in the past'),
 ];
}
// Not SQL: read through other paths and recorded by hand (runbook rows 1, 11, 12, 13).
export const MANUAL_STEPS=Object.freeze([
 'row 1: main SHA, the file identity recomputed from main equals the GO, deployed Worker version, D1 database named iptv and its id',
 'row 11: epg_status / sync.json stage and the EPG executor phase: no publication in flight (running, switching, metadata, epg mean wait)',
 'row 12: the D1 Time Travel bookmark of iptv recorded before the apply (a recovery point only)',
 'row 13: feature flags and the hourly Predictions Task registry, recorded as observed',
]);

export function readbackSteps(text=readMigration()){
 const rec=expectedFromFile(text);
 const objectNames=[...rec.tables,...rec.indexes,...rec.triggers,SHARED_TRIGGER].sort();
 const count=table=>'(SELECT COUNT(*) FROM '+table+') AS '+table;
 return [
  step('schema','schema_contract','SELECT id, version, note FROM schema_contract ORDER BY id','one row, version 19, the note of the file'),
  step('objects','the objects of 0019 by name',"SELECT type, name FROM sqlite_master WHERE name IN ("+names(objectNames)+") ORDER BY type, name",rec.tables.length+' tables, '+rec.indexes.length+' indexes, '+rec.triggers.length+' new triggers and the shared trigger'),
  step('foreign_objects','nothing else matches the receipt name pattern',"SELECT type, name FROM sqlite_master WHERE name GLOB 'canonical_*receipt*' AND name NOT IN ("+names(objectNames)+") ORDER BY type, name",'0 rows'),
  step('receipt_rows','row counts of the four new tables','SELECT '+RECEIPT_TABLES.map(count).join(', '),'0 each'),
  step('unchanged_rows','row counts that must not move','SELECT '+H1_TABLES.map(count).join(', '),'0 each (H1 has not run)'),
  step('marker','marker','SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1','prepared / open / 1'),
  step('fence','fence','SELECT ok FROM film_person_cas WHERE id = 1','ok 1'),
  step('baseline','baseline','SELECT state, reference FROM film_person_baseline WHERE id = 1','verified, the same reference as the preflight'),
  // the same statements as the preflight (rows 8 to 10): their rows are compared with the preflight bundle, not judged on their own
  ...preflightSteps(text).filter(item=>COMPARED.includes(item.id)),
 ];
}

// ---------- verification of pasted results ----------
// A value is either the rows array or a D1 envelope; an envelope that failed (or anything else) is a refusal, never an empty result.
function rowsOf(results,id,refusals){
 const value=results?.[id];
 if(value===undefined||value===null){refusals.push('result_missing:'+id);return null;}
 if(Array.isArray(value)&&value.length&&value[0]&&typeof value[0]==='object'&&('success' in value[0]||'results' in value[0])){
  const out=unwrap(value);
  if(out===null){refusals.push('result_failed:'+id);return null;}
  return out;
 }
 if(!Array.isArray(value)||value.some(row=>!row||typeof row!=='object'||Array.isArray(row))){refusals.push('result_malformed:'+id);return null;}
 return value;
}
const int=value=>typeof value==='number'&&Number.isInteger(value)?value:typeof value==='string'&&/^-?\d+$/.test(value)?Number(value):null;
const sameSet=(a,b)=>[...a].sort().join('\n')===[...b].sort().join('\n');

function commonState(results,refusals,{expectVersion,expectReference}){
 const schema=rowsOf(results,'schema',refusals);
 if(schema){
  if(schema.length!==1)refusals.push('schema_contract_rows:'+schema.length);
  else{
   if(int(schema[0].id)!==1)refusals.push('schema_contract_id:'+schema[0].id);
   if(int(schema[0].version)!==expectVersion)refusals.push('schema_version:'+schema[0].version);
   else if(expectVersion===TO_VERSION&&schema[0].note!==NOTE)refusals.push('schema_note_mismatch');
  }
 }
 const marker=rowsOf(results,'marker',refusals);
 if(marker){
  if(marker.length!==1)refusals.push('marker_rows:'+marker.length);
  else if(marker[0].mode!=='prepared'||marker[0].cutover!=='open'||int(marker[0].generation)!==1)refusals.push('marker_moved:'+marker[0].mode+'/'+marker[0].cutover+'/'+marker[0].generation);
 }
 const fence=rowsOf(results,'fence',refusals);
 if(fence){
  if(fence.length!==1)refusals.push('fence_rows:'+fence.length);
  else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);
 }
 const baseline=rowsOf(results,'baseline',refusals);
 if(baseline){
  if(baseline.length!==1)refusals.push('baseline_rows:'+baseline.length);
  else{
   if(baseline[0].state!=='verified')refusals.push('baseline_not_verified:'+baseline[0].state);
   else if(typeof baseline[0].reference!=='string'||!REFERENCE.test(baseline[0].reference))refusals.push('baseline_reference_shape');
   else if(typeof expectReference==='string'&&expectReference&&baseline[0].reference!==expectReference)refusals.push('baseline_reference_mismatch');
  }
 }
}
const verdict=(refusals,notes=[])=>({ok:refusals.length===0,refusals,notes});
// A shape-only diagnostic can never be mistaken for a GO pass: ok is always false.
const diagnosticVerdict=(refusals,notes)=>({ok:false,diagnosticOnly:true,shapeOk:refusals.length===0,refusals,notes:[...notes,'diagnostic only: no pinned reference, never a GO pass']});
// The GO names one exact accepted reference: without it the verification refuses.
function pinRefusals(expectReference){
 if(typeof expectReference!=='string'||expectReference==='')return ['expected_reference_missing'];
 if(!REFERENCE.test(expectReference))return ['expected_reference_invalid'];
 return [];
}

// Runbook section 4. ok is never a permission.
export function verifyPreflight(results,{text=readMigration(),now=new Date().toISOString(),expectReference=null,diagnostic=false}={}){
 const refusals=[],notes=[];
 if(!diagnostic)refusals.push(...pinRefusals(expectReference));
 commonState(results,refusals,{expectVersion:FROM_VERSION,expectReference});
 const prereq=rowsOf(results,'prerequisites',refusals);
 if(prereq){
  const want=prerequisiteTables(text);
  if(!sameSet(prereq.map(row=>row.name),want))refusals.push('prerequisites_incomplete:'+want.filter(name=>!prereq.some(row=>row.name===name)).length+'/'+want.length+' missing');
 }
 const existing=rowsOf(results,'existing_receipt_objects',refusals);
 if(existing&&existing.length)refusals.push('receipt_objects_present:'+existing.length);
 const shared=rowsOf(results,'shared_trigger',refusals);
 if(shared&&!(shared.length===1&&shared[0].name===SHARED_TRIGGER))refusals.push('shared_trigger_missing');
 const revision=rowsOf(results,'canonical_revision',refusals);
 if(revision){
  if(revision.length!==1||int(revision[0].n)===null)refusals.push('canonical_revision_unreadable');
  else if(int(revision[0].n)!==0||(revision[0].m!==null&&revision[0].m!==undefined))notes.push('canonical_revision_not_empty:'+revision[0].n);
 }
 const lease=rowsOf(results,'projector_lease',refusals);
 if(lease){
  if(lease.length>1)refusals.push('projector_lease_rows:'+lease.length);
  else if(lease.length===1&&lease[0].lease_id){
   if(typeof lease[0].lease_until!=='string'||!(lease[0].lease_until<now))refusals.push('projector_lease_live');
  }
 }
 const window=rowsOf(results,'projector_window',refusals);
 if(window){
  if(window.length!==1)refusals.push('projector_window_rows:'+window.length);
  else if(window[0].state!=='idle')refusals.push('projector_window_not_idle:'+window[0].state);
 }
 const discovery=rowsOf(results,'discovery_lease',refusals);
 if(discovery){
  const nowMs=Date.parse(now);
  for(const row of discovery){
   if(row.lease_id&&!(int(row.expires_at)!==null&&int(row.expires_at)<nowMs))refusals.push('discovery_lease_live');
  }
 }
 notes.push('manual rows still to record: 1, 11, 12, 13');
 return diagnostic?diagnosticVerdict(refusals,notes):verdict(refusals,notes);
}

// Runbook section 6.
export function verifyReadback(results,{text=readMigration(),expectReference=null,expectedCounts={},preflight=null,diagnostic=false}={}){
 const refusals=[];
 if(!diagnostic)refusals.push(...pinRefusals(expectReference));
 commonState(results,refusals,{expectVersion:TO_VERSION,expectReference});
 const rec=expectedFromFile(text);
 const objects=rowsOf(results,'objects',refusals);
 if(objects){
  const have=new Set(objects.map(row=>row.type+':'+row.name));
  const want=[...rec.tables.map(n=>'table:'+n),...rec.indexes.map(n=>'index:'+n),...rec.triggers.map(n=>'trigger:'+n),'trigger:'+SHARED_TRIGGER];
  const missing=want.filter(item=>!have.has(item));
  if(missing.length)refusals.push('objects_missing:'+missing.join(','));
  const extra=[...have].filter(item=>!want.includes(item));
  if(extra.length)refusals.push('objects_unexpected:'+extra.join(','));
  if(rec.tables.length!==4||rec.indexes.length!==2||rec.triggers.length!==19)refusals.push('migration_shape:'+rec.tables.length+'/'+rec.indexes.length+'/'+rec.triggers.length);
 }
 const foreign=rowsOf(results,'foreign_objects',refusals);
 if(foreign&&foreign.length)refusals.push('objects_unexpected:'+foreign.map(row=>row.type+':'+row.name).join(','));
 for(const [id,tables] of [['receipt_rows',RECEIPT_TABLES],['unchanged_rows',H1_TABLES]]){
  const counts=rowsOf(results,id,refusals);
  if(!counts)continue;
  if(counts.length!==1){refusals.push(id+'_rows:'+counts.length);continue;}
  for(const table of tables){
   const n=int(counts[0][table]);
   const want=expectedCounts[table]??0;
   if(n===null)refusals.push('count_unreadable:'+table);
   else if(n!==want)refusals.push('count_not_expected:'+table+':'+n);
  }
 }
 for(const id of COMPARED)rowsOf(results,id,refusals);
 compareWithPreflight(results,preflight,{expectReference,diagnostic,refusals});
 return diagnostic?diagnosticVerdict(refusals,[]):verdict(refusals,['not judged here: handoffReadiness (separate read); manual rows of the preflight']);
}

// The "unchanged" facts of runbook section 6 are compared with what the preflight observed: the readback bundle against the preflight bundle.
const canon=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
function compareWithPreflight(results,preflight,{expectReference,diagnostic,refusals}){
 if(preflight===null||preflight===undefined||typeof preflight!=='object'||Array.isArray(preflight)){if(!diagnostic)refusals.push('preflight_bundle_missing');return;}
 const own=[],changed=[];
 const schema=rowsOf(preflight,'schema',own);
 if(schema&&!(schema.length===1&&int(schema[0].version)===FROM_VERSION))own.push('preflight_not_version_18');
 const baseline=rowsOf(preflight,'baseline',own);
 const preRef=baseline&&baseline.length===1?baseline[0].reference:null;
 if(baseline&&!(typeof preRef==='string'&&REFERENCE.test(preRef)))own.push('baseline_reference_shape');
 else if(preRef){
  const post=rowsOf(results,'baseline',[]);
  if(post&&post.length===1&&post[0].reference!==preRef)changed.push('baseline_reference_changed');
  if(!diagnostic&&typeof expectReference==='string'&&expectReference&&preRef!==expectReference)changed.push('preflight_reference_mismatch');
 }
 // marker and fence are fixed values judged in both phases (prepared/open/1, ok 1), so they need no comparison; the lease and window rows are free-form and are compared
 for(const id of COMPARED){
  const a=rowsOf(preflight,id,own),b=rowsOf(results,id,[]);
  if(a&&b&&canon(a)!==canon(b))changed.push(id+'_changed');
 }
 refusals.push(...own.map(item=>'preflight:'+item),...changed);
}

// ---------- CLI ----------
function main(argv){
 const [command,arg]=argv;
 const flag=name=>{const index=argv.indexOf(name);return index>=0?argv[index+1]:null;};
 const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
 let out;
 if(command==='identity'){
  const text=arg&&!arg.startsWith('--')?fs.readFileSync(arg,'utf8'):readMigration();
  out=identityOf(text);
 }else if(command==='preflight-sql')out={steps:preflightSteps(),manual:MANUAL_STEPS};
 else if(command==='readback-sql')out={steps:readbackSteps()};
 else if(command==='verify-preflight'&&arg)out=verifyPreflight(read(arg),{now:flag('--now')||undefined,expectReference:flag('--reference'),diagnostic:argv.includes('--diagnostic')});
 else if(command==='verify-readback'&&arg){const pre=flag('--preflight');out=verifyReadback(read(arg),{expectReference:flag('--reference'),preflight:pre?read(pre):null,diagnostic:argv.includes('--diagnostic')});}
 else{console.error('usage: identity [file] | preflight-sql | readback-sql | verify-preflight <results.json> --reference R [--now ISO] | verify-readback <readback.json> --preflight <preflight.json> --reference R (either with --diagnostic)');return 2;}
 console.log(JSON.stringify(out,null,1));
 return out.ok===false?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
