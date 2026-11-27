#!/usr/bin/env node
// Owner-only operator of the single D1 migration window v38 -> v47 (checkpoint A) -> v54 (checkpoint B), AIR-603. DORMANT: merging it authorizes nothing.
// One documented operator for one ordered, pinned manifest of 16 unchanged files (0039..0054). `--apply` is the only production write a SEPARATE owner L3 GO may approve; it is
// schema-only: no row of its own, no marker, authority, lease, flag, Task, Workflow, backfill, import or activation. Modeled on the verified 0038 operator
// (scripts/producer-outcome-0038-production.mjs): pinned target, pinned bytes, zero retries, one atomic batch per file, readback, no blind re-run. Its limits are NOT copied.
//
//   --status   (default) strictly read-only. Digest of the manifest and of this operator, the pinned target identity, the actual version, the verified contiguous prefix, the
//              plan (the files still to apply to checkpoint A and B), the quiet-window facts, the step-specific guards, the decision per target. Counts and codes only.
//   --apply    --target iptv --through 47|54 --start <actual version> --confirm apply --manifest-sha256 <64 hex> --operator-sha256 <64 hex>
//              For each remaining file, in order: re-read the whole state, require every precondition, send ONE atomic D1 batch of the statements extracted from the unchanged
//              file, read back the version, the objects of the whole chain (stored CREATE text) and the unchanged invariants. Stops at the target, at the first refusal, and at any
//              unknown outcome. Never retried, never split, never one transaction of several files, never parallel.
//
// Atomicity is NOT assumed of the transport. Every file starts with a guard statement that aborts it before anything changes unless the exact predecessor is present, and ends with
// the version update; a partial outcome is therefore always visible as a version that did not move together with objects that exist (`partial_schema`), and a partial or unknown
// outcome stops the operator: there is no blind resume, only a new `--status` and an owner decision. There is no rollback: schema_contract.version never goes down.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createD1Adapter,D1Error} from './d1-backfill.mjs';
import {createPublishedBinding,migrationStatements,normalize,OperatorStop,PRODUCTION_ACCOUNT_ID,PRODUCTION_DATABASE_ID,PRODUCTION_DATABASE_NAME,productionTarget,readBookmark,trackProductionWrites} from './published-epg-production.mjs';
import {CHAIN_BOUNDARY_MARGIN_MS} from '../src/canonical-producer-fence.js';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
export const OPERATOR_PATH=fileURLToPath(import.meta.url);
export const BASE_VERSION=38;
export const CHECKPOINT_A=47;
export const CHECKPOINT_B=54;
export const TARGETS=[CHECKPOINT_A,CHECKPOINT_B];
const step=(version,name,blob,sha256,scope)=>({version,from:version-1,to:version,file:'migrations/'+String(version).padStart(4,'0')+'_'+name+'.sql',blob,sha256,scope});
// The approved manifest candidate: Git blobs from the AIR-603 card (main bd621cc29d020e7ef9ec8d75b396a2a36cd210b7), SHA-256 computed from those exact bytes. The operator
// refuses any file whose bytes differ from BOTH pins. It is the baseline for the review; the GO names the digest the status prints, which the executor re-verifies first.
export const MANIFEST=[
 step(39,'receipt_operation_key','976a35b9ff936344bc1cd032f18e3cd9bddb51a7','eea8b97e3479061d25f84e896ec6bc7115bb6b36280c2b87614e3f19590af5a3','AIR-603 R1'),
 step(40,'tmdb_retirement_decision_movie_index','9dfaa6886a6b518c5acc45550fb3c162a703737a','35b9266b530143a9c3a7d3831e7e1320903952d66ff22e98a43d5c321787b098','AIR-603 / AIR-667'),
 step(41,'film_identity_evidence','6fb13f8c081c907f31a8f56d3d7ff3285a8c4def','ae0b6459d20ebfb773c715a93cad60abef82bd8de6aa25284ee6e393592e4d25','AIR-603 E1'),
 step(42,'identity_evidence_writer_control','8cc69ce68ea8a0241f274c6001d90a43553f00df','17a5b0c9e393de9af676d63860254d7dff5c8e36040095cd2538bed5f8382b29','AIR-638 ECM'),
 step(43,'film_redirect_by_target','82531769f25cc90441ea6e2b9e0189f9a7f8755e','b44fce5e0258816b1a75a3ddb7383cef5512a744313e8ecb5bcbebbc5c1a634f','AIR-648 schema substep'),
 step(44,'identity_evidence_reconstruction_import','49e3390e4bbf18b213a629eb30fbe09c1b9e3f05','671d5cc4898b0a938fdfd1da50d731037c046e63aa166369e23b38f5cc39492e','AIR-640 ERM'),
 step(45,'upstream_cooldown','c232acbef86e5edcf37dd972878f181376edef02','2d031f02d35a56d298ee7db89dd2a9fac611decae027fd0fee657cdab2a8b44d','AIR-606 UC1'),
 step(46,'letterboxd_admission_authority','7e39e3abb0b2ceb03e702f374982e7842e3f6968','21b8ca405ecf3fdd930c5e116075382b2837b6c628ff980014b6edf4a284668d','AIR-603 A1'),
 step(47,'catalog_enrichment','3c570fad8745bf1028425b47370aa96cf43869e2','7f3f18e31538d889f6377e31246907e0b5648a6643bd08fdd2230a2075db5715','AIR-606 C1'),
 step(48,'film_lid_admission','2a3af828fdbd188b10a2bbbe062f016736e48e53','c25243bdb516ad758b7f854f8af323ab7c3b71339632cdf1a5ed9bec6966e92c','AIR-676'),
 step(49,'film_metadata_provenance','c46cd8d1c3d3ad18623950b50182053bd2c47e64','253ebddb266d049a00df62f7b70c92ae206d3b57868d01839cd16a10be4684cd','AIR-632 part 1'),
 step(50,'discovery_enrichment_scope','056e8b600ce034f58547b6e8a95add36577b3762','b462a85b3b0848ece82dc7e80c2ec6150c17b11cf962f9a15fb7d85e7aa68902','AIR-685 schema substep'),
 step(51,'lid_recheck_intent','85c8efc9c8c679204cfd067b1386730541933793','882faa700ca1eb2e3a4a82f8add0a7da1fc2029c8499b062531517b22d52eb6d','AIR-677 part 1'),
 step(52,'lid_tmdb_attach_writer','9119adb9a29ad23912296822ff969f9217235c8a','7acd0ef636c3b0fa5ef87d3bad20b9bfca583115043a9567d17159ec2dd2d81f','AIR-677 part 2'),
 step(53,'provenance_other_language','551bb8649a6d1960cc9fd52ef9ab0f85150fa2db','088c6a9f58dddb61caf6b7c7071e2ef11515fc33fb7d28f6813e0e7f0b51f52c','AIR-632 part 2'),
 step(54,'retire_legacy_identity_assertion_tables','15443386be326a8d5bbb7ba7e154bb87adc245c7','13aba4b93c73a36fd52b2f2a98acb02955deb9fe00dbb27f178c5bde97fde150','AIR-625'),
];
// The tables 0054 may drop, and the objects that must not exist for them (the same condition the file's own guard enforces).
export const RETIRED_TABLES=['identity_assertion','identity_rule_version','identity_application'];
// The hourly cron fires at :00 UTC (Producer reconcile, schema probes). No statement is sent within TICK_GUARD_MINUTES of it. A margin around a documented tick, not a quota.
export const TICK_GUARD_MINUTES=5;
// The quiet-window observation is valid only briefly: the apply re-reads the real clock before every file and refuses when the reads took longer.
export const PREFLIGHT_MAX_MS=60000;
const OPTIONS={'--target':'target','--confirm':'confirm','--through':'through','--start':'start','--manifest-sha256':'manifestSha256','--operator-sha256':'operatorSha256'};
const sha256=value=>createHash('sha256').update(value).digest('hex');
const gitBlob=bytes=>createHash('sha1').update(Buffer.concat([Buffer.from('blob '+bytes.length+'\0'),bytes])).digest('hex');
// Comments are dropped from both sides: the operator sends the extracted statements (no comments), a database built from the raw file keeps them.
const squash=text=>String(text||'').replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,' ').replace(/ IF NOT EXISTS/i,'').trim();
const num=value=>value===null||value===undefined?null:Number(value);

export const fileBytes=(item,root=ROOT)=>fs.readFileSync(path.join(root,item.file));
export const filePinned=(item,bytes)=>sha256(bytes)===item.sha256&&gitBlob(bytes)===item.blob;
// The digest the GO names covers the ordered files AND the pinned reference schema.
export const manifestText=(root=ROOT)=>MANIFEST.map(item=>item.version+' '+item.file+' '+item.sha256+' '+item.blob).join('\n')+'\nreference '+referenceSha256(root)+'\n';
export const manifestSha256=(root=ROOT)=>sha256(manifestText(root));
export const operatorSha256=()=>sha256(fs.readFileSync(OPERATOR_PATH));
export const stepOf=version=>MANIFEST.find(item=>item.version===version)||null;

// The statements of one unchanged file, checked for their shape and position: guard first, version update last, nothing a schema-only file may not contain.
export function stepStatements(item,bytes=fileBytes(item)){
 if(!filePinned(item,bytes))throw new OperatorStop('file_not_pinned',3,{file:item.file});
 const statements=migrationStatements(bytes.toString('utf8'));
 const first=statements[0]||'',last=statements[statements.length-1]||'';
 const shaped=statements.length>=3
  &&/^INSERT INTO schema_contract \(id, version, note\)\s+SELECT [01], 0, 'refused'\s+WHERE NOT\b/i.test(first)
  &&new RegExp('^UPDATE schema_contract\\s+SET version = '+item.to+'\\b[\\s\\S]*\\bWHERE id = 1 AND version = '+item.from+'$','i').test(last)
  &&statements.slice(1,-1).every(sql=>/^(CREATE|DROP|ALTER|INSERT)\b/i.test(sql))
  &&!statements.some(sql=>!/^CREATE TRIGGER\b/i.test(sql)&&/\b(COMMIT|ROLLBACK|ATTACH|DETACH|VACUUM|PRAGMA|SAVEPOINT|RELEASE|BEGIN)\b/i.test(sql.replace(/'(?:[^']|'')*'/g,"''")));
 if(!shaped)throw new OperatorStop('file_refused',3,{file:item.file});
 return statements;
}

// ---- the exact reference schema ----
// The expected schema of EVERY version 38..54 is a pinned reference (scripts/d1-migration-window-reference.json), generated from the unchanged migration files by
// scripts/d1-migration-window-reference.mjs on a scratch SQLite database (a test regenerates it and requires equality, so it cannot drift from the files). It holds the
// fingerprint (type, table, normalized CREATE text) of EVERY object, including the base v38 objects, the ALTERed tables, the renamed v53 tables and the IF NOT EXISTS
// definitions, so a status never certifies a predecessor by version and names alone. Its SHA-256 is part of the manifest digest the GO names.
export const REFERENCE_PATH=path.join(ROOT,'scripts/d1-migration-window-reference.json');
// Comments, whitespace, quoting, letter case and IF NOT EXISTS are dropped from both sides: the operator sends extracted statements (no comments), a database built from the
// raw file keeps them, and SQLite quotes a renamed table. Everything else (every column, CHECK, default, trigger body) counts.
export const normalizeSql=text=>String(text||'').replace(/--[^\n]*/g,'').replace(/\/\*[\s\S]*?\*\//g,'').replace(/["`]/g,'').replace(/\s+/g,'').toLowerCase().replace(/ifnotexists/g,'');
export const objectFingerprint=row=>[row.type,row.tbl??row.tbl_name,sha256(normalizeSql(row.sql)).slice(0,16)];
// Names that SQLite or the platform own: never part of the comparison.
export const ownedName=name=>name.startsWith('sqlite_')||name.startsWith('_cf_');
export const referenceBytes=(root=ROOT)=>fs.readFileSync(path.join(root,'scripts/d1-migration-window-reference.json'));
export const referenceSha256=(root=ROOT)=>sha256(referenceBytes(root));
const referenceCache=new Map();
// -> {at:version -> Map(name -> [type,tbl,hash]), later:name -> Map(hash -> lowest version carrying it)}
export function loadReference(root=ROOT){
 const bytes=referenceBytes(root),key=sha256(bytes);
 if(referenceCache.has(key))return referenceCache.get(key);
 const data=JSON.parse(bytes.toString('utf8'));
 if(data.format!==1)throw new OperatorStop('reference_invalid',3);
 const at=new Map();let current=new Map(Object.entries(data.base));at.set(BASE_VERSION,current);
 for(let version=BASE_VERSION+1;version<=CHECKPOINT_B;version++){
  const delta=data.steps[String(version)];
  if(!delta)throw new OperatorStop('reference_invalid',3);
  current=new Map(current);
  for(const name of delta.del)current.delete(name);
  for(const [name,value] of Object.entries(delta.set))current.set(name,value);
  at.set(version,current);
 }
 const loaded={at,sha256:key,transient:new Set(data.transient||[])};
 referenceCache.set(key,loaded);
 return loaded;
}

// ---- reads ----
// Every read must carry a result array: a missing or malformed answer is never read as "no rows" (an idle lease, an empty table). The reused adapter turns a missing
// result into []; the production binding of this operator uses allStrict, and this check covers any other binding.
const rowsOf=async(binding,sql)=>{
 const answer=await binding.prepare(sql).bind().all();
 if(!answer||!Array.isArray(answer.results))throw new OperatorStop('unknown_state',3,{reason:'malformed_read'});
 return answer.results;
};
// A COUNT or MAX read always answers exactly one row with numbers; anything else is unreadable, never zero.
const factOf=async(binding,sql,...keys)=>{
 const rows=await rowsOf(binding,sql);
 if(rows.length!==1||keys.some(key=>!Number.isFinite(Number(rows[0]?.[key]))||rows[0][key]===null))throw new OperatorStop('unknown_state',3,{reason:'malformed_fact'});
 return Object.fromEntries(keys.map(key=>[key,Number(rows[0][key])]));
};
const stable=value=>JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item);
const sortedRows=rows=>[...rows].sort((a,b)=>stable(a)<stable(b)?-1:stable(a)>stable(b)?1:0);
// Tables whose rows an apply must leave exactly as they are: every authority marker and the identity evidence writer control and its history (0052 rebuilds them).
const isMarker=name=>name.endsWith('_authority');
const CONTROL_TABLES=['identity_evidence_writer','identity_evidence_writer_change','film_metadata_provenance_control','catalog_enrichment_control','catalog_enrichment_scope'];
// Row-bearing tables a rebuild must preserve whole (0049 -> 0053): compared by count and a digest of their ordered rows.
const PRESERVED_TABLES=['film_metadata_field','film_metadata_history','film_metadata_owner_command','film_metadata_owner_release'];
// The large catalog tables are never read whole: a count and the highest rowid prove that no row came or went (a rebuild or a trigger of these files touches none of them).
const COUNTED_TABLES=['film','film_metadata','film_external_id','canonical_write_receipt','film_identity_evidence'];
// The quiet-window facts the window needs, and the version from which each table exists. A required fact that cannot be read is `state_unreadable`, never idle.
export const REQUIRED_QUIET=[['producerLiveLeases','canonical_producer_chain',23],['predictionLease','prediction_lease',7],['discoveryLease','discovery_lease',11],['discoveryTransferLoading','discovery_transfer',11],['projectorWindow','projector_window',18],['importRunsOpen','identity_evidence_import_run',44]];

export async function readState(binding,{clock=Date.now,root=ROOT}={}){
 try{
  const contract=(await rowsOf(binding,'SELECT id, version, typeof(version) AS kind FROM schema_contract ORDER BY id, version')).map(row=>({id:num(row.id),version:num(row.version),kind:row.kind}));
  const master=await rowsOf(binding,"SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE type IN ('table','index','trigger','view')");
  if(!master.length)throw new OperatorStop('unknown_state',3,{reason:'empty_schema'});
  const tables=new Set(master.filter(row=>row.type==='table').map(row=>row.name));
  const schemaVersion=contract.length===1&&contract[0].id===1&&contract[0].kind==='integer'?contract[0].version:null;
  const state={contract,schemaVersion,master,tables:[...tables].sort(),markers:{},control:{},preserved:{},quiet:null,retired:null,chain:null};
  for(const name of tables){
   if(isMarker(name))state.markers[name]=sortedRows(await rowsOf(binding,'SELECT * FROM '+name));
   else if(CONTROL_TABLES.includes(name))state.control[name]=sortedRows(await rowsOf(binding,'SELECT * FROM '+name));
  }
  for(const name of PRESERVED_TABLES)if(tables.has(name)){
   const rows=sortedRows(await rowsOf(binding,'SELECT * FROM '+name));
   state.preserved[name]={rows:rows.length,digest:sha256(stable(rows))};
  }
  for(const name of COUNTED_TABLES)if(tables.has(name)){
   const row=await factOf(binding,'SELECT COUNT(*) AS n, COALESCE(MAX(rowid), 0) AS top FROM '+name,'n','top');
   state.preserved[name]={rows:row.n,top:row.top};
  }
  // Quiet-window facts that live in D1. The Workflow instances, the Scheduled Tasks and the EPG orchestration documents are NOT visible here: the status says so (`unobservable`).
  const quiet={};
  if(tables.has('canonical_producer_chain')){
   const chains=await rowsOf(binding,"SELECT owner_state AS state, lease_expires_at AS lease FROM canonical_producer_chain WHERE owner_state IN ('pending','active','released')");
   const nowMs=clock();
   quiet.producerLiveLeases=chains.filter(row=>row.state==='pending'||(row.state==='active'&&!(Date.parse(row.lease)+CHAIN_BOUNDARY_MARGIN_MS<nowMs))).length;
  }
  const nowMs=clock();
  if(tables.has('prediction_lease'))quiet.predictionLease=(await factOf(binding,'SELECT COUNT(*) AS n FROM prediction_lease WHERE expires_at > '+nowMs,'n')).n;
  if(tables.has('discovery_lease'))quiet.discoveryLease=(await factOf(binding,'SELECT COUNT(*) AS n FROM discovery_lease WHERE lease_id IS NOT NULL AND expires_at > '+nowMs,'n')).n;
  if(tables.has('discovery_transfer'))quiet.discoveryTransferLoading=(await factOf(binding,"SELECT COUNT(*) AS n FROM discovery_transfer WHERE state = 'loading'",'n')).n;
  if(tables.has('projector_window'))quiet.projectorWindow=(await factOf(binding,"SELECT COUNT(*) AS n FROM projector_window WHERE state <> 'idle'",'n')).n;
  if(tables.has('identity_evidence_import_run'))quiet.importRunsOpen=(await factOf(binding,"SELECT COUNT(*) AS n FROM identity_evidence_import_run WHERE state IN ('staging', 'running')",'n')).n;
  state.quiet=quiet;
  // 0054: the three tables must hold nothing and nothing may depend on them (the same condition the file's own guard checks).
  const retired={present:RETIRED_TABLES.filter(name=>tables.has(name)),rows:{}};
  for(const name of retired.present)retired.rows[name]=(await factOf(binding,'SELECT COUNT(*) AS n FROM '+name,'n')).n;
  const needles=RETIRED_TABLES.map(name=>name.toLowerCase());
  retired.dependents=master.filter(row=>!RETIRED_TABLES.includes(row.name)&&row.sql&&needles.some(needle=>row.sql.toLowerCase().includes(needle))).map(row=>row.type+':'+row.name).sort();
  retired.attached=master.filter(row=>RETIRED_TABLES.includes(row.tbl)&&row.type!=='table'&&row.sql).map(row=>row.type+':'+row.name).sort();
  state.retired=retired;
  state.chain=chainReport(state,{root});
  return state;
 }catch(error){
  if(error instanceof OperatorStop)throw error;
  throw new OperatorStop('unknown_state',3);
 }
}

// The actual schema against the pinned reference of the actual version: every object (base v38 ones included) present with the reference fingerprint, nothing else.
//  missing: in the reference, absent here.  changed: same name, another type or text.  extra: here, not in the reference.
//  early: a changed or extra object that equals what a LATER version creates (the next file was started, or a staging table is left): a partial schema, never a resume.
export function chainReport(state,{root=ROOT}={}){
 const version=state.schemaVersion;
 const empty={verified:false,missing:[],changed:[],extra:[],early:[]};
 if(version===null||version<BASE_VERSION||version>CHECKPOINT_B)return empty;
 const {at,transient:transientNames}=loadReference(root);
 const reference=at.get(version);
 const actual=new Map(state.master.filter(row=>row.sql!==null&&row.sql!==undefined&&!ownedName(row.name)).map(row=>[row.name,objectFingerprint(row)]));
 const later=(name,fingerprint)=>{for(let v=version+1;v<=CHECKPOINT_B;v++){const spec=at.get(v).get(name);if(spec&&stable(spec)===stable(fingerprint))return true;}return false;};
 // a staging object a later file creates and removes again within itself (the pinned `transient` list) or a name a later version drops: its mere presence is a started file
 const transient=name=>transientNames.has(name)||(()=>{for(let v=version+1;v<=CHECKPOINT_B;v++)if(at.get(v).has(name)&&!at.get(CHECKPOINT_B).has(name))return true;return false;})();
 const missing=[],changed=[],extra=[],early=[];
 for(const [name,spec] of reference){
  const found=actual.get(name);
  if(!found)missing.push(spec[0]+':'+name);
  else if(stable(found)!==stable(spec)){changed.push(spec[0]+':'+name);if(later(name,found))early.push(spec[0]+':'+name);}
 }
 for(const [name,found] of actual)if(!reference.has(name)){extra.push(found[0]+':'+name);if(later(name,found)||transient(name))early.push(found[0]+':'+name);}
 return {verified:!missing.length&&!changed.length&&!extra.length,missing:missing.sort(),changed:changed.sort(),extra:extra.sort(),early:[...new Set(early)].sort()};
}

// ---- the dormant baseline: this window is schema-only ----
// Applying the files changes no behaviour only while the state they land on is the dormant one: Letterboxd admission at `r2` generation 0, no enrichment scope active or
// enabled and the control not active, provenance off, every identity evidence writer off. A different state is NOT silently treated as dormant: it needs an updated plan that
// names that baseline (for example a later B after A2 or C2 would), and the operator refuses until then.
export function dormantProblems(state){
 const problems=[];
 const admission=state.markers.letterboxd_admission_authority;
 if(admission){const row=admission[0];if(admission.length!==1||!row||row.mode!=='r2'||Number(row.generation)!==0)problems.push('letterboxd_admission_authority:not_r2_generation_0');}
 const scope=state.control.catalog_enrichment_scope;
 if(scope&&scope.some(row=>Number(row.activated)!==0||Number(row.enabled)!==0))problems.push('catalog_enrichment_scope:activated_or_enabled');
 const control=state.control.catalog_enrichment_control;
 if(control&&control.some(row=>row.state!=='inactive'||Number(row.generation)!==0))problems.push('catalog_enrichment_control:not_inactive_generation_0');
 const provenance=state.control.film_metadata_provenance_control;
 if(provenance&&(provenance.length!==1||provenance[0].mode!=='off'))problems.push('film_metadata_provenance_control:not_off');
 const writers=state.control.identity_evidence_writer;
 if(writers&&writers.some(row=>row.state!=='off'))problems.push('identity_evidence_writer:not_off');
 return problems;
}

// ---- decisions ----
// Inclusive on both sides: from :55:00.000 to :05:00.000 UTC the window is closed.
export const nearHourlyTick=nowMs=>{const date=new Date(nowMs);const intoHour=(date.getUTCMinutes()*60+date.getUTCSeconds())*1000+date.getUTCMilliseconds();return intoHour<=TICK_GUARD_MINUTES*60000||intoHour>=(60-TICK_GUARD_MINUTES)*60000;};
export function busyReason(state,item,{nowMs}){
 const q=state.quiet;
 if(!q)return 'state_unreadable';
 // fail closed: a fact the actual version requires that is missing or not a number is never idle
 const version=state.schemaVersion??0;
 for(const [key,,since] of REQUIRED_QUIET)if(version>=since&&!Number.isFinite(q[key]))return 'state_unreadable';
 if(q.producerLiveLeases>0)return 'producer_busy';
 if(q.predictionLease>0)return 'prediction_busy';
 if(q.discoveryLease>0)return 'discovery_busy';
 if(q.discoveryTransferLoading>0)return 'discovery_transfer_loading';
 if(q.projectorWindow>0)return 'projector_busy';
 if(q.importRunsOpen>0)return 'import_in_flight';
 if(nearHourlyTick(nowMs))return 'hourly_tick_window';
 return null;
}
// The step-specific refusals beyond the file's own guard. `defer` means: stop here WITHOUT undoing the verified predecessors (0054 with data or dependents).
export function stepGuard(state,item){
 if(item.version===50&&state.quiet?.discoveryTransferLoading!==0)return 'discovery_transfer_loading';
 if(item.version===54){
  const r=state.retired;
  if(!r||r.present.length!==RETIRED_TABLES.length)return 'defer_0054:tables_missing';
  if(RETIRED_TABLES.some(name=>r.rows[name]!==0))return 'defer_0054:tables_not_empty';
  if(r.dependents.length||r.attached.length)return 'defer_0054:dependents';
 }
 return null;
}
// What would happen next. `through` is the target (47 or 54); `start` is the version the caller pinned. Pure over the state.
export function decide(state,{through,start=null,nowMs=Date.now(),apply=false}={}){
 if(state.schemaVersion===null)return {decision:'schema_contract_unexpected'};
 const version=state.schemaVersion;
 if(version<BASE_VERSION||version>CHECKPOINT_B)return {decision:'schema_unexpected'};
 if(!state.chain.verified){
  // At v53 an extra object that names or is attached to a retired table is exactly what 0054 defers on (not a damaged predecessor): everything else must still match the reference.
  const known=new Set([...(state.retired?.dependents||[]),...(state.retired?.attached||[])]);
  const defers=version===53&&!state.chain.missing.length&&!state.chain.changed.length&&!state.chain.early.length&&state.chain.extra.length>0&&state.chain.extra.every(entry=>known.has(entry));
  if(!defers)return {decision:state.chain.early.length?'partial_schema':'predecessor_unverified'};
 }
 if(!TARGETS.includes(through))return {decision:'target_invalid'};
 if(apply&&start!==version)return {decision:'start_mismatch'};
 if(version===through)return {decision:'already_at_target'};
 if(version>through)return {decision:'target_behind'};
 const item=stepOf(version+1);
 const dormant=dormantProblems(state);
 if(dormant.length)return {decision:'baseline_not_dormant',detail:dormant.join(','),next:item.version};
 const guard=stepGuard(state,item);
 if(guard)return {decision:guard.startsWith('defer_0054')?'defer_0054':guard,detail:guard,next:item.version};
 const busy=busyReason(state,item,{nowMs});
 if(busy)return {decision:busy,next:item.version};
 return {decision:'apply',next:item.version};
}
const plan=(version,through)=>MANIFEST.filter(item=>item.from>=version&&item.to<=through).map(item=>item.version);

// The invariants one file must leave untouched, as a comparable value: every authority marker, every control row and the preserved tables; minus what that very file creates.
function invariants(state,item,root=ROOT){
 const {at}=loadReference(root);
 const created=new Set([...at.get(item.to).keys()].filter(name=>!at.get(item.from).has(name)));
 const pick=map=>Object.fromEntries(Object.entries(map).filter(([name])=>!created.has(name)));
 return stable({markers:pick(state.markers),control:pick(state.control),preserved:pick(state.preserved)});
}
// Expected new rows: 0046 inserts the Letterboxd marker as r2/0, 0049 the provenance control as off. Nothing else seeds a row.
export function seedProblems(state,item){
 const problems=[];
 if(item.version===46){const row=state.markers.letterboxd_admission_authority?.[0];if(!row||row.mode!=='r2'||Number(row.generation)!==0)problems.push('seed:letterboxd_admission_authority');}
 if(item.version>=49){const row=state.control.film_metadata_provenance_control?.[0];if(!row||row.mode!=='off')problems.push('seed:film_metadata_provenance_control');}
 return problems;
}

export const view=state=>state?({schemaVersion:state.schemaVersion,schemaContractRows:state.contract.length,chain:state.chain,quiet:state.quiet,dormantBaseline:{ok:dormantProblems(state).length===0,problems:dormantProblems(state)},
 retired54:state.retired?{present:state.retired.present.length,rows:state.retired.rows,dependents:state.retired.dependents,attached:state.retired.attached}:null,
 markers:Object.fromEntries(Object.entries(state.markers).map(([name,rows])=>[name,rows.map(row=>({mode:row.mode??null,cutover:row.cutover??null,generation:num(row.generation)}))])),controlRows:Object.fromEntries(Object.entries(state.control).map(([name,rows])=>[name,rows.length])),preserved:state.preserved}):null;

// One file, one batch. `ctx.submitted` names the file whose batch left this process, so every later exit can say which file the outcome belongs to.
async function write(binding,statements,ctx,before,item,{clock,root}){
 ctx.submitted={version:item.version,file:path.basename(item.file)};
 ctx.track('unknown');
 try{await binding.batch(statements);}
 catch(error){
  if(error instanceof OperatorStop){ctx.track('none');throw error;}
  let after=null;try{after=await readState(binding,{clock,root});}catch{after=null;}
  // Only a PROVEN statement rejection whose read-back equals the before-state in the version, the chain and every invariant may end as "not applied". Everything else is unknown.
  const clean=error instanceof D1Error&&error.kind==='statement'&&Boolean(after)&&after.schemaVersion===item.from&&after.chain.verified&&invariants(after,item,root)===invariants(before,item,root);
  ctx.track(clean?'none':'unknown');
  throw new OperatorStop(clean?'statement_failed':'write_uncertain',3,{file:item.file,fileOutcome:clean?'not_applied':'unknown',applied:[...(ctx.applied||[])],state:view(after)});
 }
}

export async function execute(command,{binding,ctx={track:()=>{}},params={},clock=Date.now,root=ROOT}={}){
 ctx.applied=ctx.applied||[];
 const done=ctx.applied;
 const startedMs=clock();
 let current=await readState(binding,{clock,root});
 const digest=manifestSha256(root),opDigest=operatorSha256();
 const decidedMs=clock();
 const pins=MANIFEST.every(item=>filePinned(item,fileBytes(item,root)));
 if(command==='status'){
  const beyond=fs.readdirSync(path.join(root,'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))>CHECKPOINT_B).sort();
  return {operation:'status',writes:false,writeState:'none',manifestSha256:digest,operatorSha256:opDigest,referenceSha256:referenceSha256(root),filesPinned:pins,
   files:MANIFEST.map(item=>({version:item.version,file:path.basename(item.file),sha256:item.sha256,gitBlob:item.blob,checkpoint:item.to<=CHECKPOINT_A?'A':'B',scope:item.scope})),
   treeBeyondManifest:beyond,at:new Date(decidedMs).toISOString(),...view(current),
   plan:Object.fromEntries(TARGETS.map(target=>[target,{remaining:current.schemaVersion===null?null:plan(current.schemaVersion,target),...decide(current,{through:target,nowMs:decidedMs})}])),
   unobservable:['Workflow instances','Scheduled Tasks','EPG orchestration documents','deployed Worker version','D1 account/UUID are checked by the transport, the deployed commit by the owner-approved preflight']};
 }
 if(params.manifestSha256!==digest)throw new OperatorStop('manifest_sha256_mismatch',3);
 if(params.operatorSha256!==opDigest)throw new OperatorStop('operator_sha256_mismatch',3);
 if(!pins)throw new OperatorStop('file_not_pinned',3);
 const {through,start}=params;
 // The freshness of every quiet-window observation is measured from when that observation BEGAN, never from when the previous readback ended. The first file uses the
 // observation above; every later file gets its own fresh observation (the readback of the previous file is verification only, not a preflight).
 let observedMs=startedMs;
 for(;;){
  const verdict=decide(current,{through,start:done.length?current.schemaVersion:start,nowMs:clock(),apply:true});
  if(verdict.decision==='already_at_target'&&done.length)return {operation:'apply',writes:true,writeState:'committed',manifestSha256:digest,operatorSha256:opDigest,through,applied:[...done],after:view(current)};
  if(verdict.decision!=='apply')throw new OperatorStop(verdict.decision,3,{applied:[...done],...(verdict.detail?{detail:verdict.detail}:{}),state:view(current)});
  const item=stepOf(verdict.next);
  const statements=stepStatements(item,fileBytes(item,root)).map(sql=>binding.prepare(sql).bind());
  // The write boundary: the real clock again, immediately before this file. A preflight that crossed into the tick guard, or whose observation began too long ago, refuses with nothing sent.
  const boundaryMs=clock();
  if(nearHourlyTick(boundaryMs))throw new OperatorStop('hourly_tick_window',3,{applied:[...done],at:new Date(boundaryMs).toISOString()});
  if(boundaryMs-observedMs>PREFLIGHT_MAX_MS)throw new OperatorStop('preflight_stale',3,{applied:[...done],elapsedMs:boundaryMs-observedMs});
  await write(binding,statements,ctx,current,item,{clock,root});
  let after;
  try{after=await readState(binding,{clock,root});}
  catch{ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{file:item.file,fileOutcome:'unknown',reason:'readback_unreadable',applied:[...done]});}
  const problems=[];
  if(after.schemaVersion!==item.to||after.contract.length!==1)problems.push('schema_version');
  if(!after.chain.verified)problems.push(...after.chain.missing.map(name=>'missing:'+name),...after.chain.changed.map(name=>'changed:'+name),...after.chain.extra.map(name=>'extra:'+name));
  if(invariants(after,item,root)!==invariants(current,item,root))problems.push('changed_invariant');
  problems.push(...seedProblems(after,item));
  if(item.version===54&&after.tables.some(name=>RETIRED_TABLES.includes(name)))problems.push('retired_table_present');
  if(problems.length){ctx.track('unknown');throw new OperatorStop('write_uncertain',3,{file:item.file,fileOutcome:'unknown',reason:'readback_mismatch',problems,applied:[...done],state:view(after)});}
  ctx.track('committed');
  done.push({version:item.version,file:path.basename(item.file),sha256:item.sha256,at:new Date(clock()).toISOString()});
  ctx.submitted=null;
  if(item.to>=through)return {operation:'apply',writes:true,writeState:'committed',manifestSha256:digest,operatorSha256:opDigest,through,applied:[...done],after:view(after)};
  // the next file's own fresh observation
  observedMs=clock();
  current=await readState(binding,{clock,root});
 }
}

export function parseArgs(argv){
 const args=argv.slice(2);
 const commands=args.filter(arg=>arg==='--status'||arg==='--apply');
 if(commands.length>1)throw new OperatorStop('usage',2);
 const parsed={};
 for(let index=0;index<args.length;index++){
  const arg=args[index];
  if(commands.includes(arg))continue;
  if(!OPTIONS[arg])throw new OperatorStop('usage',2);
  const next=args[index+1];
  if(next===undefined||next.startsWith('--')||parsed[OPTIONS[arg]]!==undefined)throw new OperatorStop('usage',2);
  parsed[OPTIONS[arg]]=next;index++;
 }
 const command=commands[0]?commands[0].slice(2):'status';
 if(parsed.target===undefined){
  if(command!=='status')throw new OperatorStop('target_required',2);
  return {report:{configured:false,writes:false,writeState:'none'}};
 }
 if(parsed.target!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_invalid',2);
 if(command==='status'){if(Object.keys(parsed).some(key=>key!=='target'))throw new OperatorStop('usage',2);return {command,params:{}};}
 if(parsed.confirm!=='apply')throw new OperatorStop('confirm',2);
 const through=Number(parsed.through),start=Number(parsed.start);
 if(!TARGETS.includes(through)||!/^\d+$/.test(parsed.through))throw new OperatorStop('usage',2);
 if(!/^\d+$/.test(parsed.start||'')||start<BASE_VERSION||start>=CHECKPOINT_B)throw new OperatorStop('usage',2);
 if(!/^[0-9a-f]{64}$/.test(parsed.manifestSha256||'')||!/^[0-9a-f]{64}$/.test(parsed.operatorSha256||''))throw new OperatorStop('usage',2);
 return {command,params:{through,start,manifestSha256:parsed.manifestSha256,operatorSha256:parsed.operatorSha256}};
}

// The production binding reads through allStrict: a response without a result array is an error, never an empty table.
const strictBinding=(binding,adapter)=>({...binding,prepare:sql=>({bind:(...params)=>{const bound=binding.prepare(sql).bind(...params);return {...bound,async all(){return {results:await adapter.allStrict(sql,params)};}};}})});

export async function runD1MigrationWindowProduction({argv=process.argv,env=process.env,fetchImpl=globalThis.fetch,deps=null,clock=Date.now,root=ROOT}={}){
 // `ctx` outlives the try: whatever happened before a failure (the committed prefix, the file whose batch was sent, the recovery bookmark) is reported on EVERY exit.
 const ctx={writeState:'none',applied:[],submitted:null,bookmark:null,track(state){ctx.writeState=state;}};
 let binding=null,target=null,readBookmarkAfter=null;
 try{
  const parsed=parseArgs(argv);
  if(parsed.report)return {exit:0,result:parsed.report};
  if(deps){
   ({binding}=deps);
   if(parsed.command==='apply'&&deps.bookmark){ctx.bookmark=await deps.bookmark();readBookmarkAfter=deps.bookmark;}
  }else{
   target=productionTarget(env);
   if(target.accountId!==PRODUCTION_ACCOUNT_ID)throw new OperatorStop('account_mismatch',3);
   const adapter=trackProductionWrites(createD1Adapter({target,databaseId:PRODUCTION_DATABASE_ID,fetchImpl,retries:0}),{writeState:'none'});
   const described=await adapter.describe();
   if(described.uuid!==PRODUCTION_DATABASE_ID||described.name!==PRODUCTION_DATABASE_NAME)throw new OperatorStop('target_identity_mismatch',3);
   binding=strictBinding(createPublishedBinding(adapter),adapter);
   // A Time Travel bookmark is the recovery point recorded before the first high-impact schema change; no whole-database restore without a separate GO.
   if(parsed.command==='apply'){ctx.bookmark=await readBookmark(target,fetchImpl);readBookmarkAfter=()=>readBookmark(target,fetchImpl);}
  }
  const result=await execute(parsed.command,{binding,ctx,params:parsed.params,clock,root});
  let after=null;
  if(parsed.command==='apply'&&readBookmarkAfter)try{after=await readBookmarkAfter();}catch{after=null;}
  return {exit:0,result:{...result,...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(after?{bookmarkAfter:after}:{})}};
 }catch(error){
  const stop=normalize(error);
  const applied=ctx.applied||[];
  // Aggregate outcome: a file whose batch may have committed is `unknown`; otherwise any committed file makes the run `committed` (partial); a refused or stopped-before run is `none`.
  const writeState=ctx.writeState==='unknown'?'unknown':applied.length?'committed':'none';
  const any=writeState!=='none';
  let postState,bookmarkAfter=null;
  if(any){
   try{postState=view(await readState(binding,{clock,root}));}catch{postState={readable:false};}
   if(readBookmarkAfter)try{bookmarkAfter=await readBookmarkAfter();}catch{bookmarkAfter=null;}
  }
  const details={...(stop.details||{})};delete details.applied;
  return {exit:stop.exit,result:{reason:stop.reason,writeState,writes:writeState==='none'?false:applied.length?true:null,...(any?{retry:false,partial:applied.length>0&&stop.reason!=='usage',applied,
   ...(ctx.submitted?{failedFile:ctx.submitted,failedFileOutcome:ctx.writeState==='unknown'?'unknown':'not_applied'}:{}),
   ...(postState?{postState}:{}),...(ctx.bookmark?{bookmarkBefore:ctx.bookmark}:{}),...(bookmarkAfter?{bookmarkAfter}:{})}:{}),
   ...(Object.keys(details).length?{details}:{})}};
 }
}
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const {exit,result}=await runD1MigrationWindowProduction();
 if(result.reason)process.stderr.write(result.reason+'\n');
 process.stdout.write(JSON.stringify(result)+'\n');
 process.exitCode=exit;
}
