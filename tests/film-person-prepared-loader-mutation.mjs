// AIR-374 P5: mutation check of the essential guards of scripts/film-person-prepared-loader.mjs, in the pattern of tests/film-person-connector-mutation.mjs. Each mutant is a copy
// of the loader with ONE guard removed or inverted; tests/film-person-prepared-loader.mjs, pointed at the mutant through LOADER_MODULE, must FAIL on it. A surviving mutant is a guard
// no test depends on. A mutant that does not parse or load is BROKEN and fails this check: it is never counted as killed. The mutants are written OUTSIDE the repository tree
// (a fresh temporary directory, removed afterwards), so a mutant copy can never be committed.
// AIR-374: the last element of a mutant is the section of the loader test that kills it (LOADER_SECTIONS: 0 = sections 1-3 only, otherwise 1-3 plus that one), so a mutant costs
// one section and not the whole file. The number is only where to look first: a mutant that passes its section is run against the WHOLE file before it is called a survivor, so a
// stale number costs time and never hides a survivor. The unmutated control always runs the whole file, and tests/film-person-prepared-loader.mjs passes unmutated with every section alone.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const LOADER=[
 // the dry/apply boundary
 ['apply must be true',"if(apply!==true)throw stop('apply_required');",'',0],
 ['apply is a strict boolean',"if(apply!==true)","if(!apply)",0],
 ['pinned digest required',"if(typeof planDigest!=='string'||!HEX64.test(planDigest))throw stop('plan_digest_required');",'',0],
 ['pinned digest is a sha256',"||!HEX64.test(planDigest))throw stop('plan_digest_required');","||false)throw stop('plan_digest_required');",0],
 ['pinned digest equals the plan digest',"if(planDigest!==digest)throw stop('plan_digest_mismatch');",'',0],
 ['plan digest recomputed from the content',"if(sha(stable(core))!==digest)throw stop('plan_tampered');",'',0],
 ['every batch digest checked',"if(sha(stable(batch.statements))!==core.batches[index].digest||core.batches[index].class!==batch.class)throw stop('plan_tampered');",'',0],
 ['batch count checked',"if(core.batches.length!==batchStatements.length)throw stop('plan_tampered');",'',0],
 ['batch shape checked',"batch.statements.length!==batch.rows||batch.rows<1||batch.rows>BATCH_STATEMENT_CAP)throw stop('plan_tampered');","false)throw stop('plan_tampered');",0],
 ['batch table bound to its class',"batch.table!==TABLES[batch.class]||","false||",0],
 ['only the three tables',"if(!new RegExp('^INSERT INTO '+batch.table+' ').test(item.sql))throw stop('statement_outside_scope');",'',0],
 ['every statement carries its fence',"if(!item.sql.includes('CASE WHEN ('))throw stop('statement_unguarded');",'',0],
 ['run cap on emit',"if(total>RUN_STATEMENTS||artefacts.length>RUN_BATCHES)throw stop('run_cap_exceeded');",'',0],
 // the fence inside every row
 ['marker mode is prepared',"a.mode='prepared' AND ",'',0],
 ['marker generation is the planned one',"AND a.generation=? AND b.id=1","AND b.id=1",0],
 ['baseline is verified',"AND b.state='verified' AND b.reference=?)=1","AND b.reference=?)=1",0],
 ['baseline reference is the planned one',"AND b.state='verified' AND b.reference=?)=1","AND b.state='verified')=1",0],
 ['the lease is the run\'s',"WHERE projection='enrichment' AND lease_id=? AND lease_until>","WHERE projection='enrichment' AND lease_until>",0],
 ['the lease is live by the database clock',"AND lease_until>strftime('%Y-%m-%dT%H:%M:%fZ','now'))=1","AND 1)=1",4],
 ['the window is the run\'s',"WHERE id=1 AND state='held' AND owner=? AND expires_at>","WHERE id=1 AND state='held' AND expires_at>",4],
 ['the window is live',"AND expires_at>CAST(strftime('%s','now') AS INTEGER)*1000)=1","AND 1)=1",4],
 ['a pinned window is asserted',"if(windowOwner!==null)parts.push(","if(false)parts.push(",0],
 ['class count upper bound',"[initial,total-1]","[initial,total]",4],
 ['admission identity: trusted owner',"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=? AND trusted=1 AND conflicting=0) AND","EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='tmdb' AND value=?) AND",4],
 ['admission identity: no other claim',"AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)=1 AND","AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='tmdb' AND value=?)>=1 AND",4],
 ['retention identity: the Film carries the id',"EXISTS (SELECT 1 FROM film_external_id WHERE film_id=? AND scheme='letterboxd' AND value=?) AND","1 AND",0],
 ['retention identity: one Film only',"AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)=1 AND","AND (SELECT COUNT(*) FROM film_external_id WHERE scheme='letterboxd' AND value=?)>=1 AND",4],
 ['a redirect source is not written to',"const SAME_FILM=\"NOT EXISTS (SELECT 1 FROM film_redirect WHERE from_id=?)\";","const SAME_FILM=\"1=1 OR ?=?\";",0],
 ['an existing identical row is skipped (admission)',"AND title IS ? AND year IS ? AND receipt_key=? AND receipt_film_key=? AND verified_at=? AND request_id=?)","AND title IS ? AND year IS ? AND receipt_key=? AND receipt_film_key=? AND verified_at=? AND request_id=? AND 0)",0],
 ['an existing identical row is skipped (retirement)',"WHERE request_id=? AND payload_json=?)","WHERE request_id=? AND payload_json=? AND 0)",0],
 // the plan
 ['planning needs the prepared marker',"if(marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_not_prepared:'+marker.mode+'/'+marker.cutover);",'',4],
 ['planning needs the verified baseline',"if(!baseline||baseline.state!=='verified'||typeof baseline.reference!=='string'||!baseline.reference)reasons.push('baseline_not_verified');",'',5],
 ['planning needs schema 16',"if(!(version>=16))reasons.push('schema_below_16');",'',5],
 ['the pinned instant is checked',"if(typeof at!=='string'||!ISO.test(at)||new Date(at).toISOString()!==at)reasons.push('at_invalid');",'',5],
 ['the lease id is checked',"reasons.push('lease_id_invalid');",'void 0;',5],
 ['the window owner is checked',"reasons.push('window_owner_invalid');",'void 0;',5],
 ['the expectation is checked',"reasons.push('expected_invalid');",'void 0;',5],
 ['the batch size cap',"bounds.batchRows<=BATCH_STATEMENT_CAP&&",'',5],
 ['the run batch cap',"bounds.runBatches<=RUN_BATCHES&&",'',5],
 ['the run statement cap',"bounds.runStatements<=RUN_STATEMENTS))return","true))return",5],
 ['a run is bounded',"if(batches.length>=bounds.runBatches||statements+slice.length>bounds.runStatements){deferred+=slice.length;continue;}",'',6],
 ['source digest checked',"if(item.sha256!==undefined&&item.sha256!==digest){reasons.push('source_digest_mismatch:'+id);continue;}",'',5],
 ['source missing refused',"reasons.push('source_missing:'+id);continue;}","continue;}",5],
 ['receipts shape checked',"reasons.push('source_malformed:verifiedFilms');\n","void 0;\n",5],
 ['view index shape checked',"reasons.push('source_malformed:viewIndex');\n","void 0;\n",5],
 ['an invalid retirement object refuses everything',"if(!prepared.ok)reasons.push('retirements_invalid:'+prepared.reasons.length);",'',5],
 ['unverified receipts are not admitted',"if(!checked.ok){skipped.ratedAdmission.unverified++;continue;}",'',0],
 ['no Film, no admission',"if(!owner){skipped.ratedAdmission.noFilm++;continue;}",'',0],
 ['a held movie id is not admitted',"if(claims.some(row=>!(row.trusted===1&&row.conflicting===0&&row.film_id===owner))){skipped.ratedAdmission.identityHeld++;continue;}",'',5],
 ['a redirect is not admitted',"if(redirects.has(owner)){skipped.ratedAdmission.redirected++;continue;}",'',5],
 ['one short code, one Film',"if(seenCode.has(admission.sourceCode))reasons.push('duplicate_source_code');",'',5],
 ['an ambiguous Letterboxd id refuses',"if(films.size>1){reasons.push('retention_ambiguous');continue;}",'',5],
 ['a redirect keeps no retention',"if(redirects.has(filmId)){skipped.retention.redirected++;continue;}",'',5],
 ['no Film, no retention',"if(!films||films.size===0){skipped.retention.noFilm++;continue;}",'',0],
 ['a stored row with other content refuses',"else reasons.push('mismatch:'+name);",'else already[name]++;',5],
 ['a stored row the plan does not know refuses',"if([...stored.keys()].some(key=>!planned.has(key)))reasons.push('unknown_rows:'+name);",'',5],
 ['counts are pinned',"if(planned.size!==expected[name])reasons.push('count_mismatch:'+name+':'+planned.size);",'',5],
 ['the owner-accepted 12 Nov counts are the default expectation',"Object.freeze({ratedAdmission:708,retention:398,retirement:4})","Object.freeze({ratedAdmission:708,retention:399,retirement:4})",5],
 ['request ids are content-derived (admission)',"request_id:'p5-load:'+receiptsSha16+':'+admission.receiptFilmKey","request_id:'p5-load:'+Math.random()+':'+admission.receiptFilmKey",0],
 // the sources client
 ['the ETag is checked after the GET',"if(!second||second.etag!==first.etag||second.size!==first.size)throw stop('source_changed',id);",'',8],
 ['the GET is conditional',"response=await limited.get(key,{ifMatch:first.etag});","response=await limited.get(key);",8],
 ['the object size is checked',"if(bytes.length!==first.size)throw stop('source_size_mismatch',id);",'',8],
 ['the object size is capped',"if(!(first.size<=maxBytes))throw stop('source_too_large',id);",'',8],
 ['a missing object refuses',"if(!first)throw stop('source_missing',id);",'if(!first)continue;',8],
 // the readback
 ['readback: the marker is where it was',"if(!marker||marker.mode!=='prepared'||marker.cutover!=='open')reasons.push('marker_moved');","if(false)reasons.push('marker_moved');",7],
 ['readback: the generation is the pinned one',"else if(Number(marker.generation)!==plan.gate.generation)reasons.push('generation_moved');",'',7],
 ['readback: the baseline is the pinned one',"if(!baseline||baseline.state!=='verified'||baseline.reference!==plan.gate.baselineReference)reasons.push('baseline_changed');",'',7],
 ['readback: a class must match exactly',"const ok=missing===0&&different===0&&unexpected===0&&stored.size===plan.classes[name].expected;","const ok=missing===0&&different===0;",7],
 ['readback: the pins are checked',"if(expectGeneration!==plan.gate.generation||expectReference!==plan.gate.baselineReference)reasons.push('gate_not_the_pinned_one');",'',7],
 // the copy must be a finished connector copy
 ['copyReadBinding checks the copy log',"assertCopyComplete(driver);\n return {prepare","return {prepare",11],
 ['no log table: not a connector copy',"if(present.length===0)return false;","",11],
 ['the log tables come as a pair',"if(COPY_LOG_TABLES.some(name=>!present.includes(name)))throw stop('copy_incomplete','log');","",11],
 ['an unreadable log refuses',"catch{throw stop('copy_incomplete','log');}","catch{logged=[];}",11],
 ['done is exactly 0 or 1',"||!(row.done===0||row.done===1)||","||",11],
 ['a table logged twice refuses',"||done.has(row.name))throw stop('copy_incomplete','log');",")throw stop('copy_incomplete','log');",11],
 ['a nameless log row refuses',"if(typeof row?.name!=='string'||","if(",11],
 ['every state table must be done',"if(done.get(table)!==true)throw stop('copy_incomplete',id);","if(done.get(table)===undefined)throw stop('copy_incomplete',id);",11],
 ['a state table missing from the log refuses',"if(done.get(table)!==true)throw stop('copy_incomplete',id);","if(done.get(table)===false)throw stop('copy_incomplete',id);",11],
 // the CLI
 ['the CLI plan is dry',"if(command==='plan'){\n  if(option('out'))writePrivate(path.join(privatePath(option('out')),'plan.private.json'),built.plan);\n  return print({ok:true,mode:'dry-run',...summarize(built.plan)});\n }\n const emitted=emitLoadSql({plan:built.plan,apply:rest.includes('--apply'),planDigest:option('plan-digest')});","if(command==='plan'){\n  return print({ok:true,mode:'dry-run',...summarize(built.plan)});\n }\n const emitted=emitLoadSql({plan:built.plan,apply:true,planDigest:option('plan-digest')});",10],
 ['the CLI emits only against --apply',"apply:rest.includes('--apply')","apply:true",10],
 ['the CLI output is private',"const privatePath=file=>{const full=path.resolve(file);if(!path.relative(ROOT,full).startsWith('..'))throw stop('private_path_inside_repository');return full;};","const privatePath=file=>path.resolve(file);",10],
 ['a refused plan is not emitted',"if(!built.ok){process.exitCode=2;return print({ok:false,reasons:built.reasons,counts:built.counts??null});}","if(!built.ok&&command==='plan'){process.exitCode=2;return print({ok:false,reasons:built.reasons,counts:built.counts??null});}",10],
];

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-prepared-loader-mutants-'));
assert.ok(path.relative(process.cwd(),dir).startsWith('..'),'the mutants are written outside the repository tree');
const ROOT_LINE="const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');";
// a copy outside the tree keeps the repository root of the original, or its private-path rule would judge the temporary directory
const absolute=(text,from)=>text.replace(ROOT_LINE,'const ROOT='+JSON.stringify(process.cwd())+';').replace(/(from\s*|import\()'(\.\.?\/[^']+)'/g,(_match,head,specifier)=>head+JSON.stringify(pathToFileURL(path.resolve(path.dirname(from),specifier)).href));
const run=(file,sections='')=>new Promise(resolve=>{
 const child=spawn(process.execPath,['tests/film-person-prepared-loader.mjs'],{env:{...process.env,LOADER_MODULE:file,LOADER_SECTIONS:sections},stdio:['ignore','ignore','pipe']});
 let err='';child.stderr.on('data',chunk=>{err+=chunk;});
 child.on('close',code=>resolve({code,broken:/SyntaxError|ERR_MODULE_NOT_FOUND|ReferenceError|does not provide an export/.test(err)?err.slice(0,300):null}));
});
try{
 const source='scripts/film-person-prepared-loader.mjs';
 const original=fs.readFileSync(source,'utf8');
 assert.equal(original.split(ROOT_LINE).length,2,'the root line of the loader is found once');
 for(const [name,from,,hint] of LOADER)assert.ok(Number.isInteger(hint)&&hint>=0&&hint<=11,'the section of "'+name+'"');
 for(const [name,from] of LOADER)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once in '+source);
 // the unmutated copy, moved the same way, must PASS: otherwise every mutant would be "killed" by the move itself
 const control=path.join(dir,'loader.control.mjs');
 fs.writeFileSync(control,absolute(original,source));
 const queue=[{name:'control',file:control,control:true}];
 LOADER.forEach(([name,from,to,hint],index)=>{
  const file=path.join(dir,'loader.mutant'+index+'.mjs');
  fs.writeFileSync(file,absolute(original.replace(from,()=>to),source));
  queue.push({name,file,hint});
 });
 const survivors=[],broken=[];
 let killed=0,fullRuns=0;
 const workers=Array.from({length:Math.max(2,Math.min(8,os.availableParallelism()))},async()=>{
  while(queue.length){
   const item=queue.shift();
   if(item.control){const whole=await run(item.file);assert.equal(whole.code,0,'the unmutated copy must pass '+(whole.broken||''));continue;}
   let out=await run(item.file,String(item.hint));
   if(!out.broken&&out.code===0){fullRuns++;out=await run(item.file);}
   if(out.broken)broken.push(item.name+': '+out.broken);
   else if(out.code===0)survivors.push(item.name);
   else killed++;
  }
 });
 await Promise.all(workers);
 assert.deepEqual(broken,[],'broken mutants (they do not parse or load, so they prove nothing)');
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.equal(killed,LOADER.length);
 console.log('film-person-prepared-loader-mutation: ok ('+LOADER.length+' mutants killed'+(fullRuns?', '+fullRuns+' needed the whole file: update their section':'')+')');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
assert.ok(!fs.existsSync(dir));
