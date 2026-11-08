// AIR-373: the READ-ONLY preflight kit for applying schema 13..16 (migrations/0013..0016) to the production D1 `iptv`. This module touches no
// network, no D1 and no R2: it only (1) lists the exact SELECT statements an authorized reader runs, built from the migration files so they
// cannot drift from them, and (2) judges the rows that reader brings back. It never applies anything. Applying a migration is a separate,
// operation-specific owner decision with its own readback (docs/runbooks/film-person-schema-preflight.md).
import fs from 'node:fs';
import path from 'node:path';

export const SEQUENCE=Object.freeze(['0013_film_person_authority','0014_localization_source','0015_film_admission','0016_tmdb_retirement_decision']);
const VERSION_OF=name=>Number(name.slice(0,4));
// A trigger that earlier migrations also create with IF NOT EXISTS is not an object that proves a migration ran.
const SHARED=new Set(['schema_contract_no_downgrade']);
const NAME=/^[a-z][a-z0-9_]*$/;

export function expectedObjects(sql){
 const out=[];
 const pattern=/CREATE\s+(?:UNIQUE\s+)?(TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z][A-Za-z0-9_]*)/gi;
 for(const match of sql.replace(/--.*$/gm,'').matchAll(pattern)){
  const name=match[2];
  if(!SHARED.has(name)&&!out.some(item=>item.name===name))out.push({type:match[1].toLowerCase(),name});
 }
 return out;
}
export function loadExpected(dir='migrations'){
 const out={};
 for(const name of SEQUENCE)out[name]=expectedObjects(fs.readFileSync(path.join(dir,name+'.sql'),'utf8'));
 return out;
}

// Only a single SELECT is ever produced or accepted.
export function assertReadOnly(sql){
 const text=String(sql).trim().replace(/;$/,'');
 if(!/^SELECT\b/i.test(text)||text.includes(';')||/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA|ATTACH|VACUUM|REINDEX)\b/i.test(text))throw new Error('preflight statements must be one read-only SELECT');
 return text;
}
export function inventorySql(expected=loadExpected()){
 const names=[...new Set(Object.values(expected).flat().map(item=>item.name))].sort();
 for(const name of names)if(!NAME.test(name))throw new Error('unexpected object name '+name);
 return assertReadOnly("SELECT type, name FROM sqlite_master WHERE name IN ("+names.map(name=>"'"+name+"'").join(', ')+") ORDER BY type, name");
}
// The prerequisite tables of a complete schema 12 (the first statement of 0013 refuses anything else).
export const V12_TABLES=Object.freeze(['film','person','film_external_id','person_external_id','film_alias','person_alias','film_redirect','film_person_credit','film_generation','film_epg_last_airing','discovery_authority','discovery_seal']);
export function preflightSteps(expected=loadExpected()){
 const marks=V12_TABLES.map(name=>"'"+name+"'").join(', ');
 return [
  {id:'version',purpose:'schema_contract: exactly one row, its version',sql:assertReadOnly('SELECT id, version, note FROM schema_contract ORDER BY id')},
  {id:'prerequisites',purpose:'the twelve tables of a complete schema 12',sql:assertReadOnly("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ("+marks+") ORDER BY name")},
  {id:'inventory',purpose:'which objects of migrations 0013..0016 already exist',sql:inventorySql(expected)},
  {id:'projector_lease',purpose:'is the enrichment projector running (lease live)?',sql:assertReadOnly("SELECT lease_id, lease_until, started_at, finished_at, outcome FROM projection_run WHERE projection = 'enrichment'")},
 ];
}
// Stage 2: only when the version is at least 13 and the 0013 tables exist (a SELECT on a missing table would fail).
export const MARKER_STEPS=Object.freeze([
 {id:'marker',purpose:'film_person_authority',sql:assertReadOnly('SELECT id, mode, cutover, generation FROM film_person_authority')},
 {id:'fence',purpose:'film_person_cas',sql:assertReadOnly('SELECT id, ok FROM film_person_cas')},
 {id:'baseline',purpose:'film_person_baseline',sql:assertReadOnly('SELECT id, state, reference FROM film_person_baseline')},
]);

// results: {version:[{id,version,note}], prerequisites:[{name}], inventory:[{type,name}], projector_lease?:[{...}]|null, marker?:[..], fence?:[..], baseline?:[..]}
// Returns the verdict. `ok` is true only when the state is consistent AND there is a next migration to apply or nothing left to apply; it is
// never a permission: the owner's operation-specific GO is separate.
export function evaluatePreflight(results,{expected=loadExpected(),now=new Date().toISOString()}={}){
 const blockers=[],notes=[];
 const versions=Array.isArray(results?.version)?results.version:[];
 if(versions.length!==1||!Number.isInteger(Number(versions[0]?.version)))return {ok:false,state:'unknown',version:null,next:null,remaining:[],blockers:['schema_contract_rows:'+versions.length],notes};
 const version=Number(versions[0].version);
 const present=new Set((results.inventory||[]).map(row=>row.type+':'+row.name));
 const have=new Set((results.prerequisites||[]).map(row=>row.name));
 if(version<12)blockers.push('below_v12:'+version);
 if(version>=12){const missing=V12_TABLES.filter(name=>!have.has(name));if(missing.length&&version===12)blockers.push('v12_tables_missing:'+missing.join(','));}
 const progress=[];
 for(const name of SEQUENCE){
  const wanted=expected[name].map(item=>item.type+':'+item.name);
  const there=wanted.filter(item=>present.has(item));
  const applied=version>=VERSION_OF(name);
  if(applied&&there.length!==wanted.length)blockers.push('missing_after_version:'+name+':'+wanted.filter(item=>!present.has(item)).join(','));
  if(!applied&&there.length)blockers.push('partial_or_ahead:'+name+':'+there.join(','));
  progress.push({migration:name,applied,objects:there.length+'/'+wanted.length});
 }
 const lease=Array.isArray(results.projector_lease)?results.projector_lease[0]:null;
 if(lease?.lease_id&&lease.lease_until&&lease.lease_until>now)blockers.push('projector_lease_live:'+lease.lease_until);
 if(version>=13){
  const marker=results.marker?.[0],fence=results.fence?.[0],baseline=results.baseline?.[0];
  if(!marker||!fence||!baseline)blockers.push('marker_unread');
  else{
   const initial=marker.mode==='r2'&&marker.cutover==='open'&&Number(marker.generation)===0&&Number(fence.ok)===1&&baseline.state==='empty';
   if(!initial)notes.push('marker_not_initial:'+marker.mode+'/'+marker.cutover+'/'+marker.generation+' fence '+fence.ok+' baseline '+baseline.state);
   if(marker.mode!=='r2'&&version<16)blockers.push('authority_moved_before_schema_complete');
  }
 }
 const remaining=SEQUENCE.filter(name=>version<VERSION_OF(name));
 const consistent=blockers.length===0;
 const state=!consistent?'inconsistent':version>=16?'complete':version===12?'ready_v12':'at_v'+version;
 return {ok:consistent,state,version,next:consistent&&remaining.length?remaining[0]:null,remaining:consistent?remaining:[],progress,blockers,notes};
}
