// AIR-374 P3c `discovery_admission`: mutation check of the Discovery admission unit and its call site (src/canonical-discovery-admission-producer.js, the call in src/discovery-authority.js, the registration in src/canonical-producers.js), in the pattern of
// tests/canonical-film-external-ids-producer-mutation.mjs. Each mutant is a copy of the whole src/ tree with ONE safety rule removed or inverted in ONE file; tests/canonical-discovery-admission-producer.mjs, pointed at the copy through DISCOVERY_ADM_SRC, must FAIL on it.
// A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree (a temporary directory, removed afterwards).
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const MUTANTS=[
 ["the title is not content", "canonical-discovery-admission-producer.js", "return {tmdbId:String(input.tmdbId),title};", "return {tmdbId:String(input.tmdbId)};"],
 ["a blank title is kept", "canonical-discovery-admission-producer.js", "typeof input.title==='string'&&input.title.trim()?input.title.trim():null", "typeof input.title==='string'?input.title:null"],
 ["an invalid tmdb id is accepted", "canonical-discovery-admission-producer.js", "!TMDB.test(String(input.tmdbId??''))", "false"],
 ["an untrusted or conflicting holder is not refused", "canonical-discovery-admission-producer.js", "if(trusted.length>1||holders.some(row=>!(row.trusted===1&&row.conflicting===0)&&!trusted.some(other=>other.film_id===row.film_id)))throw failed('identity_collision');", ""],
 ["a redirected Film is not refused", "canonical-discovery-admission-producer.js", "if(await one(db,'SELECT 1 AS x FROM film_redirect WHERE from_id=?',[id]))throw failed('film_person_redirect');", ""],
 ["a different trusted tmdb value is not refused", "canonical-discovery-admission-producer.js", "if(await one(db,\"SELECT 1 AS x FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value<>? AND trusted=1 AND conflicting=0\",[id,tmdbId]))throw failed('identity_collision');", ""],
 ["the Film holding the id is not reused", "canonical-discovery-admission-producer.js", "const id=trusted[0]?.film_id||'film:tmdb:'+tmdbId;", "const id='film:tmdb:'+tmdbId;"],
 ["a stored title is overwritten", "canonical-discovery-admission-producer.js", "const needsTitle=!!title&&!(typeof row?.original_title==='string'&&row.original_title.trim());", "const needsTitle=!!title;"],
 ["the stored contract version is overwritten", "canonical-discovery-admission-producer.js", "contractVersion:row?row.contract_version:1", "contractVersion:1"],
 ["nothing is ever a no-op", "canonical-discovery-admission-producer.js", "const noop=!!row&&hasId&&!needsTitle;", "const noop=false;"],
 ["the id is never considered stored", "canonical-discovery-admission-producer.js", "const hasId=trusted.length===1;", "const hasId=false;"],
 ["the tmdb id is written untrusted", "canonical-discovery-admission-producer.js", "{scheme:'tmdb',value:tmdbId,trusted:true,conflicting:false,", "{scheme:'tmdb',value:tmdbId,trusted:false,conflicting:false,"],
 ["the write has no receipt mark", "canonical-discovery-admission-producer.js", "receiptMark:mark(ctx,clock)});", "});"],
 ["the receipt plans revision zero", "canonical-discovery-admission-producer.js", "expectedRevision:plan.revision,digest", "expectedRevision:0,digest"],
 ["the apply gate ignores the route", "canonical-discovery-admission-producer.js", "if(route.writer!=='canonical')return {state:'skipped',reason:'projector_is_writer',receipt:false};", ""],
 ["the call site ignores the route", "canonical-discovery-admission-producer.js", "if(route.writer!=='canonical'){", "if(false){"],
 ["the skip cache is keyed by the environment object", "canonical-discovery-admission-producer.js", "(skipUntil.get(binding)||0)>Date.now())return", "(skipUntil.get(env)||0)>Date.now())return"],
 ["an entry without the verified identity is admitted", "canonical-discovery-admission-producer.js", "||entry.canonicalIdentity!=='tmdb:'+match[1]", ""],
 ["a tv entry is admitted", "canonical-discovery-admission-producer.js", "||entry.mediaType==='tv'||entry.kind==='tv')return null", "){return null;}"],
 ["the per-call cap is ignored", "canonical-discovery-admission-producer.js", "||out.applied+out.noop+out.refused+out.failed>=admitLimit", ""],
 ["the deadline is ignored", "canonical-discovery-admission-producer.js", "const late=()=>Number.isFinite(deadline)&&Date.now()>=deadline;", "const late=()=>false;"],
 ["the sweep takes superseded admissions", "canonical-discovery-admission-producer.js", "WHERE a.state='current' AND a.media_kind='movie'", "WHERE a.media_kind='movie'"],
 ["the sweep takes tv admissions", "canonical-discovery-admission-producer.js", "WHERE a.state='current' AND a.media_kind='movie'", "WHERE a.state='current'"],
 ["the sweep re-admits stored films", "canonical-discovery-admission-producer.js", "AND NOT EXISTS (SELECT 1 FROM film_external_id e", "AND EXISTS (SELECT 1 FROM film_external_id e"],
 ["a refusal escapes the call site", "canonical-discovery-admission-producer.js", "if(DISCOVERY_ADMISSION_REFUSALS.has(error?.code))out.refused++;else out.failed++;", "throw error;"],
 ["a moved source is replayed", "canonical-discovery-admission-producer.js", "if(!found.ok)throw failed('film_person_invalid');", ""],
 ["a moved source is not abandoned by readback", "canonical-discovery-admission-producer.js", "if(found&&!found.ok)return {disposition:'abandon',errorClass:SOURCE_CHANGED};", ""],
 ["revalidate always proceeds", "canonical-discovery-admission-producer.js", "return plan.noop?'superseded':'proceed';", "return 'proceed';"],
 ["every planner error is a missing plan", "canonical-discovery-admission-producer.js", "if(DISCOVERY_ADMISSION_REFUSALS.has(error?.code))return null;throw error;}};\n return defineOperation", "return null;}};\n return defineOperation"],
 ["the replan ignores the current admission", "canonical-discovery-admission-producer.js", "AND state='current'\",[String(tmdbId)]", "\",[String(tmdbId)]"],
 ["the call site is not guarded", "discovery-authority.js", "if(written.length&&typeof CanonicalDiscoveryAdmission!=='undefined'){", "if(written.length){"],
 ["the call site is not called", "discovery-authority.js", "await CanonicalDiscoveryAdmission.admitDiscoveryFilms(env,{films:", "await (async()=>0)(env,{films:"],
 ["the operation is not registered", "canonical-producers.js", "operationRegistry([discoveryAdmissionOperation({replan:async()=>null})])", "operationRegistry([])"],
 ["the route module never routes to the projector", "canonical-writer-route.js", "if(gate.r2Allowed===true)return {writer:'projector'", "if(false)return {writer:'projector'"]
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'discovery-adm-mutants-'));
try{
 const sources=new Map();
 const text=file=>{if(!sources.has(file))sources.set(file,fs.readFileSync(path.join('src',file),'utf8'));return sources.get(file);};
 for(const [name,file,from] of MUTANTS)assert.equal(text(file).split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in src/'+file);
 // One shared template database (the whole migration chain), built once.
 const template=path.join(dir,'template.sqlite');
 const chain=fs.readdirSync('migrations').filter(file=>/^\d{4}_.*\.sql$/.test(file)).sort();
 assert.equal(sqliteSync(['-bail',template],{input:chain.map(file=>fs.readFileSync('migrations/'+file,'utf8')).join('\n'),encoding:'utf8',maxBuffer:1<<26}).status,0);
 const run=(env)=>new Promise(resolve=>{
  const child=spawn(process.execPath,['tests/canonical-discovery-admission-producer.mjs'],{env:{...process.env,DISCOVERY_ADM_TEMPLATE:template,...env},stdio:['ignore','ignore','pipe']});
  let err='';child.stderr.on('data',chunk=>{err+=chunk;});
  child.on('close',code=>{assert.ok(!/SyntaxError|ReferenceError|ERR_MODULE_NOT_FOUND/.test(err),'broken mutant '+JSON.stringify(env)+': '+err.slice(0,300));resolve(code);});
 });
 assert.equal(await run({}),0,'the unmutated test passes');
 const queue=MUTANTS.map(([name,file,from,to],index)=>{
  const copy=path.join(dir,'src'+index);
  fs.cpSync('src',copy,{recursive:true});
  fs.writeFileSync(path.join(copy,file),text(file).replace(from,()=>to));
  return {name,env:{DISCOVERY_ADM_SRC:copy}};
 });
 const survivors=[];
 await Promise.all(Array.from({length:4},async()=>{while(queue.length){const item=queue.shift();const code=await run(item.env);fs.rmSync(item.env.DISCOVERY_ADM_SRC,{recursive:true,force:true});if(code===0)survivors.push(item.name);}}));
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('canonical-discovery-admission-producer-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
