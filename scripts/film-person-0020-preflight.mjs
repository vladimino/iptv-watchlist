// AIR-374 S4-2 (docs/runbooks/film-person-0020-apply.md): the OFFLINE operator preflight kit for migration 0020 (schema 19 to 20, the canonical producer run and unit result tables). It touches no network, no D1, no R2, no
// Cloudflare and no connector, and it never applies anything. It (1) recomputes the identity of the migration file (git blob hash, sha256, byte count, statement count and the digest of the statements themselves), (2) EMITS the exact
// read-only SELECT statements of the preflight (runbook section 4) and of the readback (section 6), built from the migration file so they cannot drift from it, and (3) VERIFIES result JSON that an authorized operator pasted
// back, refusing anything else with named reasons. A pass is evidence, never permission: the owner's operation-specific GO (runbook section 3) is separate, and nothing here is a GO.
//
//   node scripts/film-person-0020-preflight.mjs identity [file]
//   node scripts/film-person-0020-preflight.mjs preflight-sql          the SELECT statements to run BEFORE the apply
//   node scripts/film-person-0020-preflight.mjs readback-sql           the SELECT statements to run AFTER the apply
//   node scripts/film-person-0020-preflight.mjs verify-preflight <results.json> --marker <mode/cutover/generation> [--now ISO]
//   node scripts/film-person-0020-preflight.mjs verify-readback <readback.json> --preflight <preflight.json> --marker <mode/cutover/generation>
//   either verify command with --diagnostic: shape only, never a GO pass (ok is always false, diagnosticOnly true)
// The GO-specific verification FAILS CLOSED: without the exact marker the GO names (and, for the readback, the preflight results bundle) it refuses. The marker, the fence, the baseline, the three leases and the row counts of the
// tables that exist today are not judged against fixed values (0020 touches none of them and a canonical operator may have moved them since the 0019 apply): they are PINNED (the marker) or COMPARED (the rest) between the
// preflight and the readback. A results file is {"<statement id>": <rows array | D1 response envelope [{success,results}]>}. Exit status 1 on a refusal.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {assertReadOnly,expectedObjects,unwrap} from './schema-preflight.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const MIGRATION='migrations/0020_canonical_producer_run.sql';
export const FROM_VERSION=19;
export const TO_VERSION=20;
export const SHARED_TRIGGER='schema_contract_no_downgrade';
export const NOTE='Schema v20: durable canonical producer run and unit result tables (empty). Follows a complete version 19.';
export const PRODUCER_TABLES=Object.freeze(['canonical_producer_run','canonical_producer_unit_result']);
// The tables that exist today and that 0020 must not move: counted before and after and compared (not expected to be empty: a later operation may have loaded them).
export const UNCHANGED_TABLES=Object.freeze(['canonical_write_receipt','canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal','canonical_revision','film_rated_admission','film_retention','tmdb_retirement_decision']);
export const COMPARED=Object.freeze(['unchanged_rows','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);
export const OBJECT_PATTERN='canonical_producer_*';
const MARKER=/^(r2|prepared|d1)\/(open|held)\/\d{1,9}$/;
const quote=name=>"'"+name+"'";

// The statements of the file: every statement starts with INSERT, CREATE or UPDATE in column 0 (a trigger body is indented); comment lines and blank lines are not part of one.
export function statementsOf(text){
 const lines=text.split('\n'),out=[];
 for(const line of lines){
  if(/^(INSERT|CREATE|UPDATE)\b/.test(line))out.push([line]);
  else if(out.length&&!/^\s*--/.test(line))out[out.length-1].push(line);
 }
 return out.map(block=>{while(block.length&&block[block.length-1].trim()==='')block.pop();return block.join('\n').replace(/;$/,'');});
}
export function identityOf(text){
 const bytes=Buffer.from(text,'utf8');
 const statements=statementsOf(text);
 return {
  file:MIGRATION,
  gitBlob:createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex'),
  sha256:createHash('sha256').update(bytes).digest('hex'),
  bytes:bytes.length,
  statements:statements.length,
  // the digest of the statements alone (comments and blank lines removed, each without its closing semicolon, joined by ";\n"): what the database will store is derived from these texts
  statementsSha256:createHash('sha256').update(statements.join(';\n'),'utf8').digest('hex'),
  expectedApplyResults:{statements:statements.length,firstChanges:0,lastChanges:1,allSuccess:true},
 };
}
export const readMigration=(root=ROOT)=>fs.readFileSync(path.join(root,MIGRATION),'utf8');

// The prerequisite tables are read from the refuse-insert of the file itself.
export function prerequisiteTables(text){
 const match=/WHERE type = 'table' AND name IN \(([^)]*)\)/.exec(text);
 if(!match)throw new Error('refuse-insert prerequisite list not found in the migration');
 const out=match[1].split(',').map(item=>{const token=/^\s*'([a-z][a-z0-9_]*)'\s*$/.exec(item);if(!token)throw new Error('unexpected object name in the prerequisite list');return token[1];});
 if(out.length!==6)throw new Error('the prerequisite list must hold six tables, found '+out.length);
 return out;
}
// Everything the file creates, by type, from the file (the shared trigger is separate).
export function expectedFromFile(text){
 const objects=expectedObjects(text);
 const by=type=>objects.filter(item=>item.type===type).map(item=>item.name).sort();
 return {tables:by('table'),indexes:by('index'),triggers:by('trigger')};
}
// The CREATE statement of every object the file creates (the shared trigger excluded), by name: what sqlite_master must store.
export function definitionsOf(text){
 const out={};
 for(const statement of statementsOf(text)){
  const match=/^CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z][A-Za-z0-9_]*)/.exec(statement);
  if(match&&match[2]!==SHARED_TRIGGER)out[match[2]]=statement;
 }
 return out;
}

const NAMES=/^[a-z][a-z0-9_]*$/;
function names(list){for(const name of list)if(!NAMES.test(name))throw new Error('unexpected object name '+name);return list.map(quote).join(', ');}
export const step=(id,purpose,sql,expect)=>({id,purpose,sql:assertReadOnly(sql),expect});
const count=table=>'(SELECT COUNT(*) FROM '+table+') AS '+table;

export function preflightSteps(text=readMigration()){
 const prereq=prerequisiteTables(text);
 return [
  step('schema','runbook row 2: schema_contract','SELECT id, version, note FROM schema_contract ORDER BY id','exactly one row, version 19'),
  step('prerequisites','row 3: the six prerequisite tables',"SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("+names(prereq)+") ORDER BY name",'6 rows'),
  step('existing_producer_objects','row 4: no object of 0020 exists yet',"SELECT type, name FROM sqlite_master WHERE name GLOB '"+OBJECT_PATTERN+"' ORDER BY type, name",'0 rows'),
  step('shared_trigger','row 5: the shared trigger exists',"SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = "+quote(SHARED_TRIGGER),'1 row'),
  step('unchanged_rows','row 6: row counts of the tables 0020 must not move','SELECT '+UNCHANGED_TABLES.map(count).join(', '),'recorded; compared with the readback'),
  step('marker','row 7: marker','SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1','exactly the mode/cutover/generation the GO names'),
  step('fence','row 7: fence','SELECT ok FROM film_person_cas WHERE id = 1','ok 1'),
  step('baseline','row 7: baseline','SELECT state, reference FROM film_person_baseline WHERE id = 1','recorded; compared with the readback'),
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
 const created=[...rec.tables,...rec.indexes,...rec.triggers].sort();
 const objectNames=[...created,SHARED_TRIGGER].sort();
 return [
  step('schema','schema_contract','SELECT id, version, note FROM schema_contract ORDER BY id','one row, version 20, the note of the file'),
  step('objects','the objects of 0020 by name',"SELECT type, name FROM sqlite_master WHERE name IN ("+names(objectNames)+") ORDER BY type, name",rec.tables.length+' tables, '+rec.indexes.length+' indexes, '+rec.triggers.length+' new triggers and the shared trigger'),
  step('definitions','the stored text of every object of 0020',"SELECT type, name, sql FROM sqlite_master WHERE name IN ("+names(created)+") ORDER BY type, name",'each sql equals the CREATE statement of the file'),
  step('foreign_objects','nothing else matches the producer name pattern',"SELECT type, name FROM sqlite_master WHERE name GLOB '"+OBJECT_PATTERN+"' AND name NOT IN ("+names(objectNames)+") ORDER BY type, name",'0 rows'),
  step('producer_rows','row counts of the two new tables','SELECT '+PRODUCER_TABLES.map(count).join(', '),'0 each'),
  // the same statements as the preflight (rows 6 to 10): their rows are compared with the preflight bundle, not judged on their own
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
const markerOf=row=>row.mode+'/'+row.cutover+'/'+row.generation;

// The GO names the exact marker the database is at (any state is allowed; the apply is a DDL that does not read it): without it the verification refuses.
function pinRefusals(expectMarker){
 if(typeof expectMarker!=='string'||expectMarker==='')return ['expected_marker_missing'];
 if(!MARKER.test(expectMarker))return ['expected_marker_invalid'];
 return [];
}
function commonState(results,refusals,{expectVersion,expectMarker}){
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
  else if(!MARKER.test(markerOf(marker[0])))refusals.push('marker_unreadable:'+markerOf(marker[0]));
  else if(typeof expectMarker==='string'&&expectMarker&&markerOf(marker[0])!==expectMarker)refusals.push('marker_moved:'+markerOf(marker[0]));
 }
 const fence=rowsOf(results,'fence',refusals);
 if(fence){
  if(fence.length!==1)refusals.push('fence_rows:'+fence.length);
  else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);
 }
 const baseline=rowsOf(results,'baseline',refusals);
 if(baseline&&baseline.length!==1)refusals.push('baseline_rows:'+baseline.length);
 const unchanged=rowsOf(results,'unchanged_rows',refusals);
 if(unchanged){
  if(unchanged.length!==1)refusals.push('unchanged_rows_rows:'+unchanged.length);
  else for(const table of UNCHANGED_TABLES)if(int(unchanged[0][table])===null||int(unchanged[0][table])<0)refusals.push('count_unreadable:'+table);
 }
}
const verdict=(refusals,notes=[])=>({ok:refusals.length===0,refusals,notes});
// A shape-only diagnostic can never be mistaken for a GO pass: ok is always false.
const diagnosticVerdict=(refusals,notes)=>({ok:false,diagnosticOnly:true,shapeOk:refusals.length===0,refusals,notes:[...notes,'diagnostic only: no pinned marker, never a GO pass']});

// Runbook section 4. ok is never a permission.
export function verifyPreflight(results,{text=readMigration(),now=new Date().toISOString(),expectMarker=null,diagnostic=false}={}){
 const refusals=[],notes=[];
 if(!diagnostic)refusals.push(...pinRefusals(expectMarker));
 commonState(results,refusals,{expectVersion:FROM_VERSION,expectMarker});
 const prereq=rowsOf(results,'prerequisites',refusals);
 if(prereq){
  const want=prerequisiteTables(text);
  if(!sameSet(prereq.map(row=>row.name),want))refusals.push('prerequisites_incomplete:'+want.filter(name=>!prereq.some(row=>row.name===name)).length+'/'+want.length+' missing');
 }
 const existing=rowsOf(results,'existing_producer_objects',refusals);
 if(existing&&existing.length)refusals.push('producer_objects_present:'+existing.length);
 const shared=rowsOf(results,'shared_trigger',refusals);
 if(shared&&!(shared.length===1&&shared[0].name===SHARED_TRIGGER))refusals.push('shared_trigger_missing');
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
export function verifyReadback(results,{text=readMigration(),expectMarker=null,preflight=null,diagnostic=false}={}){
 const refusals=[];
 if(!diagnostic)refusals.push(...pinRefusals(expectMarker));
 commonState(results,refusals,{expectVersion:TO_VERSION,expectMarker});
 const rec=expectedFromFile(text);
 const objects=rowsOf(results,'objects',refusals);
 if(objects){
  const have=new Set(objects.map(row=>row.type+':'+row.name));
  const want=[...rec.tables.map(n=>'table:'+n),...rec.indexes.map(n=>'index:'+n),...rec.triggers.map(n=>'trigger:'+n),'trigger:'+SHARED_TRIGGER];
  const missing=want.filter(item=>!have.has(item));
  if(missing.length)refusals.push('objects_missing:'+missing.join(','));
  const extra=[...have].filter(item=>!want.includes(item));
  if(extra.length)refusals.push('objects_unexpected:'+extra.join(','));
  if(rec.tables.length!==2||rec.indexes.length!==7||rec.triggers.length!==22)refusals.push('migration_shape:'+rec.tables.length+'/'+rec.indexes.length+'/'+rec.triggers.length);
 }
 // what the database stored is the text of the file, statement by statement
 const definitions=rowsOf(results,'definitions',refusals);
 if(definitions){
  const want=definitionsOf(text);
  const stored=new Map(definitions.map(row=>[row.name,row.sql]));
  const wrong=Object.keys(want).filter(name=>stored.has(name)&&stored.get(name)!==want[name]);
  if(wrong.length)refusals.push('definition_mismatch:'+wrong.sort().join(','));
  const absent=Object.keys(want).filter(name=>!stored.has(name));
  if(absent.length)refusals.push('definitions_missing:'+absent.length);
 }
 const foreign=rowsOf(results,'foreign_objects',refusals);
 if(foreign&&foreign.length)refusals.push('objects_unexpected:'+foreign.map(row=>row.type+':'+row.name).join(','));
 const counts=rowsOf(results,'producer_rows',refusals);
 if(counts){
  if(counts.length!==1)refusals.push('producer_rows_rows:'+counts.length);
  else for(const table of PRODUCER_TABLES){
   const n=int(counts[0][table]);
   if(n===null)refusals.push('count_unreadable:'+table);
   else if(n!==0)refusals.push('count_not_expected:'+table+':'+n);
  }
 }
 for(const id of ['projector_lease','projector_window','discovery_lease'])rowsOf(results,id,refusals);
 compareWithPreflight(results,preflight,{expectMarker,diagnostic,refusals});
 return diagnostic?diagnosticVerdict(refusals,[]):verdict(refusals,['not judged here: the manual rows of the preflight']);
}

// The "unchanged" facts of runbook section 6 are compared with what the preflight observed: the readback bundle against the preflight bundle.
const canon=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
function compareWithPreflight(results,preflight,{expectMarker,diagnostic,refusals}){
 if(preflight===null||preflight===undefined||typeof preflight!=='object'||Array.isArray(preflight)){if(!diagnostic)refusals.push('preflight_bundle_missing');return;}
 const own=[],changed=[];
 const schema=rowsOf(preflight,'schema',own);
 if(schema&&!(schema.length===1&&int(schema[0].version)===FROM_VERSION))own.push('preflight_not_version_19');
 const marker=rowsOf(preflight,'marker',own);
 if(marker&&marker.length===1&&!diagnostic&&typeof expectMarker==='string'&&expectMarker&&markerOf(marker[0])!==expectMarker)changed.push('preflight_marker_mismatch');
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
 else if(command==='verify-preflight'&&arg)out=verifyPreflight(read(arg),{now:flag('--now')||undefined,expectMarker:flag('--marker'),diagnostic:argv.includes('--diagnostic')});
 else if(command==='verify-readback'&&arg){const pre=flag('--preflight');out=verifyReadback(read(arg),{expectMarker:flag('--marker'),preflight:pre?read(pre):null,diagnostic:argv.includes('--diagnostic')});}
 else{console.error('usage: identity [file] | preflight-sql | readback-sql | verify-preflight <results.json> --marker M [--now ISO] | verify-readback <readback.json> --preflight <preflight.json> --marker M (either with --diagnostic)');return 2;}
 console.log(JSON.stringify(out,null,1));
 return out.ok===false?1:0;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))process.exitCode=main(process.argv.slice(2));
