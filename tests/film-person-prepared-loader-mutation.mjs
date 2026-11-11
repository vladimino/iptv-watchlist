// AIR-374 P5: mutation check of the essential guards of scripts/film-person-prepared-loader.mjs, in the pattern of tests/film-person-connector-mutation.mjs. Each mutant is a copy
// of the loader with ONE guard removed or inverted; tests/film-person-prepared-loader.mjs, pointed at the mutant through LOADER_MODULE, must FAIL on it. A surviving mutant is a guard
// no test depends on. A mutant that does not parse or load is BROKEN and fails this check: it is never counted as killed. The mutants are written OUTSIDE the repository tree
// (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const LOADER=[
 // the dry/apply boundary
 ['apply must be true',"if(apply!==true)throw stop('apply_required');",''],
 ['apply is a strict boolean',"if(apply!==true)","if(!apply)"],
 ['pinned digest required',"if(typeof planDigest!=='string'||!HEX64.test(planDigest))throw stop('plan_digest_required');",''],
 ['pinned digest is a sha256',"||!HEX64.test(planDigest))throw stop('plan_digest_required');","||false)throw stop('plan_digest_required');"],
 ['pinned digest equals the plan digest',"if(planDigest!==digest)throw stop('plan_digest_mismatch');",''],
 ['plan digest recomputed from the content',"if(sha(stable(core))!==digest)throw stop('plan_tampered');",''],
 ['every batch digest checked',"if(sha(stable(batch.statements))!==core.batches[index].digest||core.batches[index].class!==batch.class)throw stop('plan_tampered');",''],
 ['batch count checked',"if(core.batches.length!==batchStatements.length)throw stop('plan_tampered');",''],
 ['batch shape checked',"batch.statements.length!==batch.rows||batch.rows<1||batch.rows>BATCH_STATEMENT_CAP)throw stop('plan_tampered');","false)throw stop('plan_tampered');"],
 ['batch table bound to its class',"batch.table!==TABLES[batch.class]||","false||"],
 ['only the three tables',"if(!new RegExp('^INSERT INTO '+batch.table+' ').test(item.sql))throw stop('statement_outside_scope');",''],
 ['every statement carries its fence',"if(!item.sql.includes('CASE WHEN ('))throw stop('statement_unguarded');",''],
 ['run cap on emit',"if(total>RUN_STATEMENTS||artefacts.length>RUN_BATCHES)throw stop('run_cap_exceeded');",''],
 // the fence inside every row
 ['marker mode is prepared',"a.mode='prepared' AND ",''],
 ['marker generation is the planned one',"AND a.generation=? AND b.id=1","AND b.id=1"],
 ['baseline is verified',"AND b.state='verified' AND b.reference=?)=1","AND b.reference=?)=1"],
 ['baseline reference is the planned one',"AND b.state='verified' AND b.reference=?)=1","AND b.state='verified')=1"],
 ['the lease is the run\'s',"WHERE projection='enrichment' AND lease_id=? AND lease_until>","WHERE projection='enrichment' AND lease_until>"],
 ['the lease is live by the database clock',"AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))=1","AND 1)=1"],
 ['the window is the run\'s',"WHERE id=1 AND state='held' AND owner=? AND expires_at>","WHERE id=1 AND state='held' AND expires_at>"],
 ['the window is live',"AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)=1","AND 1)=1"],
 ['a pinned window is asserted',"if(windowOwner!==null)parts.push(","if(false)parts.push("],
 ['class count upper bound',"[initial,total-1]","[initial,total]"],
 ['admission identity: trusted owner',"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0) AND","EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=?) AND"],
 ['admission identity: no other claim',"AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=1 AND","AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)>=1 AND"],
 ['retention identity: the Film carries the id',"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=?) AND","1 AND"],
 ['retention identity: one Film only',"AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=1 AND","AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)>=1 AND"],
 ['a redirect source is not written to',"const SAME_FILM=\"NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)\";","const SAME_FILM=\"1=1 OR ?=?\";"],
 ['an existing identical row is skipped (admission)',"AND title IS ? AND year IS ? AND receipt_key=? AND receipt_film_key=? AND verified_at=? AND request_id=?)","AND title IS ? AND year IS ? AND receipt_key=? AND receipt_film_key=? AND verified_at=? AND request_id=? AND 0)"],
 ['an existing identical row is skipped (retirement)',"WHERE request_id=? AND payload_json=?)","WHERE request_id=? AND payload_json=? AND 0)"],
 // the plan
 ['planning needs the prepared marker',"if(marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_not_prepared:'+marker.mode+'/'+marker.cutover);",''],
 ['planning needs the verified baseline',"if(!baseline||baseline.state!=='verified'||typeof baseline.reference!=='string'||!baseline.reference)reasons.push('baseline_not_verified');",''],
 ['planning needs schema 16',"if(!(version>=16))reasons.push('schema_below_16');",''],
 ['the pinned instant is checked',"if(typeof at!=='string'||!ISO.test(at)||new Date(at).toISOString()!==at)reasons.push('at_invalid');",''],
 ['the lease id is checked',"reasons.push('lease_id_invalid');",'void 0;'],
 ['the window owner is checked',"reasons.push('window_owner_invalid');",'void 0;'],
 ['the expectation is checked',"reasons.push('expected_invalid');",'void 0;'],
 ['the batch size cap',"bounds.batchRows<=BATCH_STATEMENT_CAP&&",''],
 ['the run batch cap',"bounds.runBatches<=RUN_BATCHES&&",''],
 ['the run statement cap',"bounds.runStatements<=RUN_STATEMENTS))return","true))return"],
 ['a run is bounded',"if(batches.length>=bounds.runBatches||statements+slice.length>bounds.runStatements){deferred+=slice.length;continue;}",''],
 ['source digest checked',"if(item.sha256!==undefined&&item.sha256!==digest){reasons.push('source_digest_mismatch:'+id);continue;}",''],
 ['source missing refused',"reasons.push('source_missing:'+id);continue;}","continue;}"],
 ['receipts shape checked',"reasons.push('source_malformed:verifiedFilms');\n","void 0;\n"],
 ['view index shape checked',"reasons.push('source_malformed:viewIndex');\n","void 0;\n"],
 ['an invalid retirement object refuses everything',"if(!prepared.ok)reasons.push('retirements_invalid:'+prepared.reasons.length);",''],
 ['unverified receipts are not admitted',"if(!checked.ok){skipped.ratedAdmission.unverified++;continue;}",''],
 ['no Film, no admission',"if(!owner){skipped.ratedAdmission.noFilm++;continue;}",''],
 ['a held movie id is not admitted',"if(claims.some(row=>!(row.trusted===1&&row.conflicting===0&&row.film_id===owner))){skipped.ratedAdmission.identityHeld++;continue;}",''],
 ['a redirect is not admitted',"if(redirects.has(owner)){skipped.ratedAdmission.redirected++;continue;}",''],
 ['one short code, one Film',"if(seenCode.has(admission.sourceCode))reasons.push('duplicate_source_code');",''],
 ['an ambiguous Letterboxd id refuses',"if(films.size>1){reasons.push('retention_ambiguous');continue;}",''],
 ['a redirect keeps no retention',"if(redirects.has(filmId)){skipped.retention.redirected++;continue;}",''],
 ['no Film, no retention',"if(!films||films.size===0){skipped.retention.noFilm++;continue;}",''],
 ['a stored row with other content refuses',"else reasons.push('mismatch:'+name);",'else already[name]++;'],
 ['a stored row the plan does not know refuses',"if([...stored.keys()].some(key=>!planned.has(key)))reasons.push('unknown_rows:'+name);",''],
 ['counts are pinned',"if(planned.size!==expected[name])reasons.push('count_mismatch:'+name+':'+planned.size);",''],
 ['the accepted measurement is the default expectation',"Object.fromEntries(CLASSES.map(name=>[name,ACCEPTED_DISCREPANCIES.caps[name]]))","Object.fromEntries(CLASSES.map(name=>[name,ACCEPTED_DISCREPANCIES.caps[name]+1]))"],
 ['request ids are content-derived (admission)',"request_id:'p5-load:'+receiptsSha16+':'+admission.receiptFilmKey","request_id:'p5-load:'+Math.random()+':'+admission.receiptFilmKey"],
 // the sources client
 ['the ETag is checked after the GET',"if(!second||second.etag!==first.etag||second.size!==first.size)throw stop('source_changed',id);",''],
 ['the GET is conditional',"response=await limited.get(key,{ifMatch:first.etag});","response=await limited.get(key);"],
 ['the object size is checked',"if(bytes.length!==first.size)throw stop('source_size_mismatch',id);",''],
 ['the object size is capped',"if(!(first.size<=maxBytes))throw stop('source_too_large',id);",''],
 ['a missing object refuses',"if(!first)throw stop('source_missing',id);",'if(!first)continue;'],
 // the readback
 ['readback: the marker is where it was',"if(!marker||marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_moved');","if(false)reasons.push('marker_moved');"],
 ['readback: the generation is the pinned one',"else if(Number(marker.generation)!==plan.gate.generation)reasons.push('generation_moved');",''],
 ['readback: the baseline is the pinned one',"if(!baseline||baseline.state!=='verified'||baseline.reference!==plan.gate.baselineReference)reasons.push('baseline_changed');",''],
 ['readback: a class must match exactly',"const ok=missing===0&&different===0&&unexpected===0&&stored.size===plan.classes[name].expected;","const ok=missing===0&&different===0;"],
 ['readback: the pins are checked',"if(expectGeneration!==plan.gate.generation||expectReference!==plan.gate.baselineReference)reasons.push('gate_not_the_pinned_one');",''],
 // the CLI
 ['the CLI plan is dry',"if(command==='plan'){\n  if(option('out'))writePrivate(path.join(privatePath(option('out')),'plan.private.json'),built.plan);\n  return print({ok:true,mode:'dry-run',...summarize(built.plan)});\n }\n const emitted=emitLoadSql({plan:built.plan,apply:rest.includes('--apply'),planDigest:option('plan-digest')});","if(command==='plan'){\n  return print({ok:true,mode:'dry-run',...summarize(built.plan)});\n }\n const emitted=emitLoadSql({plan:built.plan,apply:true,planDigest:option('plan-digest')});"],
 ['the CLI emits only against --apply',"apply:rest.includes('--apply')","apply:true"],
 ['the CLI output is private',"const privatePath=file=>{const full=path.resolve(file);if(!path.relative(ROOT,full).startsWith('..'))throw stop('private_path_inside_repository');return full;};","const privatePath=file=>path.resolve(file);"],
 ['a refused plan is not emitted',"if(!built.ok){process.exitCode=2;return print({ok:false,reasons:built.reasons,counts:built.counts??null});}","if(!built.ok&&command==='plan'){process.exitCode=2;return print({ok:false,reasons:built.reasons,counts:built.counts??null});}"],
];

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prepared-loader-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
const ROOT_LINE="const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');";
// a copy outside the tree keeps the repository root of the original, or its private-path rule would judge the temporary directory
const absolute=(text,from)=>text.replace(ROOT_LINE,'const ROOT='+JSON.stringify(process.cwd())+';').replace(/(from\s*|import\()'(\.\.?\/[^']+)'/g,(_match,head,specifier)=>head+JSON.stringify(pathToFileURL(path.resolve(path.dirname(from),specifier)).href));
const run=(file)=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-prepared-loader.mjs'],{env:{...process.env,LOADER_MODULE:file},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError|does not provide an export/.test(err)?err.slice(0,300):null}));
});
try{
 const source='scripts/film-person-prepared-loader.mjs';
 const original=fs.readFileSync(source,'utf8');
 assert.equal(original.split(ROOT_LINE).length,2,'the root line of the loader is found once');
 for(const [name,from] of LOADER)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+source);
 // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
 const control=path.join(dir,'loader.control.mjs');
 fs.writeFileSync(control,absolute(original,source));
 const queue=[{name:'control',file:control,control:true}];
 LOADER.forEach(([name,from,to],index)=>{
  const file=path.join(dir,'loader.mutant'+index+'.mjs');
  fs.writeFileSync(file,absolute(original.replace(from,()=>to),source));
  queue.push({name,file});
 });
 const survivors=[],broken=[];
 let killed=0;
 const workers=Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(queue.length){
   const item=queue.shift();
   const out=await run(item.file);
   if(item.control){assert.equal(out.code,0,'the unmutated copy must pass '+(out.broken||''));continue;}
   if(out.broken)broken.push(item.name+': '+out.broken);
   else if(out.code===0)survivors.push(item.name);
   else killed++;
  }
 });
 await Promise.all(workers);
 assert.deepEqual(broken,[],'broken mutants (they do not parse or load, so they prove nothing)');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,LOADER.length);
 console.log('film-person-prepared-loader-mutation: ok ('+LOADER.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
