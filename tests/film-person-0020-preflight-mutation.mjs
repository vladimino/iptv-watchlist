// AIR-374 H0: mutation check of scripts/film-person-0020-preflight.mjs. Each mutant is a copy of the module with ONE guard removed or inverted; the test
// (tests/film-person-0020-preflight.mjs, pointed at the mutant through PREFLIGHT_MODULE) must FAIL on it. A surviving mutant is a guard no test depends on.
// The mutants are written OUTSIDE the repository tree (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const source='scripts/film-person-0020-preflight.mjs';
const original=fs.readFileSync(source,'utf8');
const MUTANTS=[
 ['git blob header',"Buffer.from('blob '+bytes.length+'\\0')","Buffer.from('')"],
 ['sha256 of the bytes',"sha256:createHash('sha256').update(bytes).digest('hex'),","sha256:createHash('sha256').update(text.trim()).digest('hex'),"],
 ['byte count not characters',"bytes:bytes.length,","bytes:text.length,"],
 ['statement start',"/^(INSERT|CREATE|UPDATE)\\b/.test(line)","/^(CREATE)\\b/.test(line)"],
 ['comments are not statements',"else if(out.length&&!/^\\s*--/.test(line))out[out.length-1].push(line);","else if(out.length)out[out.length-1].push(line);"],
 ['statement semicolon',"return block.join('\\n').replace(/;$/,'');","return block.join('\\n');"],
 ['statements digest',"createHash('sha256').update(statements.join(';\\n'),'utf8')","createHash('sha256').update(statements.join(''),'utf8')"],
 ['expected first changes',"firstChanges:0,lastChanges:1","firstChanges:1,lastChanges:1"],
 ['prerequisite count',"if(out.length!==6)throw","if(false)throw"],
 ['prerequisite token strict',"if(!token)throw new Error('unexpected object name in the prerequisite list');","if(!token)return '';"],
 ['name guard',"if(!NAMES.test(name))throw new Error('unexpected object name '+name);","void 0;"],
 ['read-only guard',"sql:assertReadOnly(sql)","sql"],
 ['glob inventory',"WHERE name GLOB '\"+OBJECT_PATTERN+\"' ORDER BY type, name\",'0 rows')","WHERE name GLOB 'canonical_producer_run' ORDER BY type, name\",'0 rows')"],
 ['object pattern',"export const OBJECT_PATTERN='canonical_producer_*';","export const OBJECT_PATTERN='canonical_producer_run*';"],
 ['readback includes shared trigger',"const objectNames=[...created,SHARED_TRIGGER].sort();","const objectNames=[...created].sort();"],
 ['definitions of the shared trigger',"if(match&&match[2]!==SHARED_TRIGGER)out[match[2]]=statement;","if(match)out[match[2]]=statement;"],
 ['envelope failure',"if(out===null){refusals.push('result_failed:'+id);return null;}","if(out===null)return [];"],
 ['missing result',"refusals.push('result_missing:'+id);return null;","return [];"],
 ['malformed result',"refusals.push('result_malformed:'+id);return null;","return [];"],
 ['one schema row',"if(schema.length!==1)refusals.push('schema_contract_rows:'+schema.length);","if(schema.length<1)refusals.push('schema_contract_rows:'+schema.length);"],
 ['schema id',"if(int(schema[0].id)!==1)refusals.push('schema_contract_id:'+schema[0].id);","void 0;"],
 ['schema version',"if(int(schema[0].version)!==expectVersion)refusals.push","if(false)refusals.push"],
 ['schema note',"else if(expectVersion===TO_VERSION&&schema[0].note!==NOTE)refusals.push('schema_note_mismatch');",""],
 ['marker readable',"else if(!MARKER.test(markerOf(marker[0])))refusals.push('marker_unreadable:'+markerOf(marker[0]));",""],
 ['marker pinned',"else if(typeof expectMarker==='string'&&expectMarker&&markerOf(marker[0])!==expectMarker)refusals.push('marker_moved:'+markerOf(marker[0]));",""],
 ['marker single row',"if(marker.length!==1)refusals.push('marker_rows:'+marker.length);","if(marker.length<1)refusals.push('marker_rows:'+marker.length);"],
 ['marker shape mode',"const MARKER=/^(r2|prepared|d1)\\/(open|held)\\/\\d{1,9}$/;","const MARKER=/^(\\w+)\\/(open|held)\\/\\d{1,9}$/;"],
 ['marker shape generation',"\\/(open|held)\\/\\d{1,9}$/;","\\/(open|held)\\/.*$/;"],
 ['fence ok',"else if(int(fence[0].ok)!==1)refusals.push('fence_not_ok:'+fence[0].ok);",""],
 ['fence single row',"if(fence.length!==1)refusals.push('fence_rows:'+fence.length);","if(fence.length<1)refusals.push('fence_rows:'+fence.length);"],
 ['baseline single row',"if(baseline&&baseline.length!==1)refusals.push('baseline_rows:'+baseline.length);",""],
 ['unchanged counts single row',"if(unchanged.length!==1)refusals.push('unchanged_rows_rows:'+unchanged.length);","if(unchanged.length<1)refusals.push('unchanged_rows_rows:'+unchanged.length);"],
 ['unchanged counts readable',"if(int(unchanged[0][table])===null||int(unchanged[0][table])<0)refusals.push('count_unreadable:'+table);","void 0;"],
 ['unchanged counts non-negative',"||int(unchanged[0][table])<0)refusals","||false)refusals"],
 ['prerequisites complete',"if(!sameSet(prereq.map(row=>row.name),want))refusals.push","if(false)refusals.push"],
 ['existing objects',"if(existing&&existing.length)refusals.push('producer_objects_present:'+existing.length);",""],
 ['shared trigger present',"if(shared&&!(shared.length===1&&shared[0].name===SHARED_TRIGGER))refusals.push('shared_trigger_missing');",""],
 ['lease rows',"if(lease.length>1)refusals.push('projector_lease_rows:'+lease.length);","if(false)void 0;"],
 ['lease live',"if(typeof lease[0].lease_until!=='string'||!(lease[0].lease_until<now))refusals.push('projector_lease_live');",""],
 ['lease until strict',"!(lease[0].lease_until<now)","false"],
 ['window rows',"if(window.length!==1)refusals.push('projector_window_rows:'+window.length);","if(false)void 0;"],
 ['window idle',"else if(window[0].state!=='idle')refusals.push('projector_window_not_idle:'+window[0].state);",""],
 ['discovery lease',"if(row.lease_id&&!(int(row.expires_at)!==null&&int(row.expires_at)<nowMs))refusals.push('discovery_lease_live');",""],
 ['discovery expiry ms',"int(row.expires_at)<nowMs","int(row.expires_at)<nowMs+1e12"],
 ['objects missing',"if(missing.length)refusals.push('objects_missing:'+missing.join(','));",""],
 ['objects unexpected',"if(extra.length)refusals.push('objects_unexpected:'+extra.join(','));",""],
 ['object type counted',"const have=new Set(objects.map(row=>row.type+':'+row.name));","const have=new Set(objects.map(row=>'table:'+row.name));"],
 ['shape guard',"if(rec.tables.length!==2||rec.indexes.length!==7||rec.triggers.length!==22)refusals.push","if(false)refusals.push"],
 ['definition text',"const wrong=Object.keys(want).filter(name=>stored.has(name)&&stored.get(name)!==want[name]);","const wrong=[];"],
 ['definitions present',"if(absent.length)refusals.push('definitions_missing:'+absent.length);",""],
 ['foreign objects',"if(foreign&&foreign.length)refusals.push(","if(false)refusals.push("],
 ['count rows',"if(counts.length!==1)refusals.push('producer_rows_rows:'+counts.length);","if(counts.length<1)refusals.push('producer_rows_rows:'+counts.length);"],
 ['count unreadable',"if(n===null)refusals.push('count_unreadable:'+table);","if(n===null)void 0;"],
 ['count expected zero',"else if(n!==0)refusals.push('count_not_expected:'+table+':'+n);",""],
 ['producer tables counted',"for(const table of PRODUCER_TABLES){\n   const n=int","for(const table of []){\n   const n=int"],
 ['pin missing',"if(typeof expectMarker!=='string'||expectMarker==='')return ['expected_marker_missing'];","if(false)return [];"],
 ['pin invalid',"if(!MARKER.test(expectMarker))return ['expected_marker_invalid'];",""],
 ['pin enforced in preflight',"if(!diagnostic)refusals.push(...pinRefusals(expectMarker));\n commonState(results,refusals,{expectVersion:FROM_VERSION","commonState(results,refusals,{expectVersion:FROM_VERSION"],
 ['pin enforced in readback',"if(!diagnostic)refusals.push(...pinRefusals(expectMarker));\n commonState(results,refusals,{expectVersion:TO_VERSION","commonState(results,refusals,{expectVersion:TO_VERSION"],
 ['diagnostic never ok',"{ok:false,diagnosticOnly:true,","{ok:true,diagnosticOnly:true,"],
 ['diagnostic shape flag',"shapeOk:refusals.length===0,","shapeOk:true,"],
 ['diagnostic note',"'diagnostic only: no pinned marker, never a GO pass'","'x'"],
 ['preflight diagnostic result',"return diagnostic?diagnosticVerdict(refusals,notes):verdict(refusals,notes);","return verdict(refusals,notes);"],
 ['readback diagnostic result',"return diagnostic?diagnosticVerdict(refusals,[]):verdict(","return verdict(refusals,[]);//("],
 ['bundle required',"if(!diagnostic)refusals.push('preflight_bundle_missing');return;}","return;}"],
 ['bundle is version 19',"if(schema&&!(schema.length===1&&int(schema[0].version)===FROM_VERSION))own.push('preflight_not_version_19');",""],
 ['bundle rows prefixed',"refusals.push(...own.map(item=>'preflight:'+item),...changed);","refusals.push(...own.map(item=>item),...changed);"],
 ['bundle marker pinned',"if(marker&&marker.length===1&&!diagnostic&&typeof expectMarker==='string'&&expectMarker&&markerOf(marker[0])!==expectMarker)changed.push('preflight_marker_mismatch');",""],
 ['compared facts',"if(a&&b&&canon(a)!==canon(b))changed.push(id+'_changed');",""],
 ['canonical row compare',"JSON.stringify(value,(key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(name=>[name,item[name]])):item)","JSON.stringify(value)"],
 ['compared list',"export const COMPARED=Object.freeze(['unchanged_rows','marker','fence','baseline','projector_lease','projector_window','discovery_lease']);","export const COMPARED=Object.freeze(['unchanged_rows','marker','fence','baseline','projector_lease','projector_window']);"],
 ['compared lease results required',"for(const id of ['projector_lease','projector_window','discovery_lease'])rowsOf(results,id,refusals);",""],
 ['readback emits compared',"...preflightSteps(text).filter(item=>COMPARED.includes(item.id)),",""],
 ['unchanged tables list',"'canonical_write_receipt','canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal','canonical_revision'","'canonical_write_receipt','canonical_receipt_baseline','canonical_receipt_watermark','canonical_receipt_baseline_seal'"],
 ['cli preflight bundle',"preflight:pre?read(pre):null","preflight:null"],
 ['cli diagnostic',"expectMarker:flag('--marker'),diagnostic:argv.includes('--diagnostic')});\n else if","expectMarker:flag('--marker')});\n else if"],
 ['cli marker flag',"{now:flag('--now')||undefined,expectMarker:flag('--marker'),","{now:flag('--now')||undefined,expectMarker:null,"],
 ['verdict ok',"ok:refusals.length===0","ok:true"],
 ['cli refusal exit',"return out.ok===false?1:0;","return 0;"],
];
for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+source);
const dir=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'preflight-0020-mutants-'));
const schemaPreflight=pathToFileURL(path.resolve('scripts/schema-preflight.mjs')).href;
// the copy lives outside the tree: its imports and its repository root are pinned to this checkout
const moved=text=>text.replace("'./schema-preflight.mjs'",JSON.stringify(schemaPreflight)).replace("path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')",JSON.stringify(process.cwd()));
const run=file=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-0020-preflight.mjs'],{env:{...process.env,PREFLIGHT_MODULE:file},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 // a mutant that does not even parse or load is a broken mutant, not a killed one
 child.on('close',code=>{assert.ok(!/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError/.test(err),'broken mutant '+file+': '+err.slice(0,300));resolve(code);});
});
try{
 // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
 const control=path.join(dir,'control.mjs');
 fs.writeFileSync(control,moved(original));
 assert.equal(await run(control),0,'the unmutated, moved copy must pass');
 const queue=MUTANTS.map(([name,from,to],index)=>{
  const file=path.join(dir,'mutant'+index+'.mjs');
  fs.writeFileSync(file,moved(original.replace(from,()=>to)));
  return {name,file};
 });
 const survivors=[];
 const workers=Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();if(await run(item.file)===0)survivors.push(item.name);}});
 await Promise.all(workers);
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('film-person-0020-preflight-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
