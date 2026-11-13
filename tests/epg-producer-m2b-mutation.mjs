// AIR-374 M2b step 0: mutation check of the offline copy tooling (scripts/epg-producer-m2b.mjs), in the pattern of tests/epg-producer-dry-run-mutation.mjs. Each mutant is a copy of the script (with its src/, scripts/ and tests/ helpers beside it)
// with ONE rule removed or inverted; the check() of tests/epg-producer-m2b.mjs, run on the mutant in this process, must FAIL on it. A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. The copies live OUTSIDE the repository tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {check} from './epg-producer-m2b.mjs';

const MUTANTS=[
 ["the statements digest is not checked", "results._statementsDigest!==plan.statementsDigest", "false"],
 ["the capture time is not checked", "typeof results?._capturedAt!=='string'||!Number.isFinite(Date.parse(results._capturedAt))", "false"],
 ["the page size is not checked", "if(!Number.isInteger(pageRows)||pageRows<1||pageRows>caps.pageRows)refusals.push('page_rows_invalid');", ""],
 ["a table outside the plan is accepted", "if(!COPY_PLAN.some(item=>item.table===name))refusals.push(", "if(false)refusals.push("],
 ["a missing table is accepted", "if(!entry||typeof entry!=='object'||Array.isArray(entry)){refusals.push('table_missing:'+item.table);continue;}", "if(!entry||typeof entry!=='object'||Array.isArray(entry)){continue;}"],
 ["an invalid count is accepted", "if(!count||!isInt(count.n)||!(count.maxRowid===null||isInt(count.maxRowid))||(count.n===0)!==(count.maxRowid===null)){refusals.push('count_invalid:'+item.table);continue;}", ""],
 ["an empty page list is accepted", "if(!Array.isArray(pages)||pages.length===0){refusals.push('pages_missing:'+item.table);continue;}", "if(!Array.isArray(pages)){continue;}"],
 ["a broken page chain is accepted", "if(page.after!==after){refusals.push('page_chain_broken:'+item.table);chain=false;return;}", ""],
 ["a short page in the middle is accepted", "if(!final&&page.rows.length!==pageRows){refusals.push('page_not_full:'+item.table);chain=false;return;}", ""],
 ["an oversized page is accepted", "if(page.rows.length>pageRows){refusals.push('page_over_size:'+item.table);chain=false;return;}", ""],
 ["an unterminated chain is accepted", "if(pages[pages.length-1].rows.length>=pageRows&&rowTotal!==count.n){refusals.push('page_unterminated:'+item.table);continue;}", ""],
 ["the row total is not checked against the count", "if(rowTotal!==count.n)refusals.push('count_mismatch:'+item.table);\n  else if", "if(false)refusals.push('count_mismatch:'+item.table);\n  else if"],
 ["the last rowid is not checked against the maximum", "else if(count.n>0&&last!==count.maxRowid)refusals.push('max_rowid_mismatch:'+item.table);", ""],
 ["the row order is not checked", "if(!isInt(row._rid)||row._rid<=previous){refusals.push('rowid_order:'+item.table);chain=false;return;}", ""],
 ["the page cursor is not checked against its rows", "if(page.last!==previous){refusals.push('page_last_mismatch:'+item.table);chain=false;return;}", ""],
 ["extra or missing columns are accepted", "if(keys.length!==allowed.size||keys.some(key=>!allowed.has(key))){", "if(false){"],
 ["a non-scalar value is accepted", "if(keys.some(key=>row[key]!==null&&!['string','number'].includes(typeof row[key]))){", "if(false){"],
 ["a row that is not an object is accepted", "if(!row||typeof row!=='object'||Array.isArray(row)){refusals.push('row_not_object:'+item.table);chain=false;return;}", ""],
 ["a missing metric is accepted", "if(!ok){refusals.push('meta_missing:'+label);return;}", "if(!ok){return;}"],
 ["a metric over the per-statement cap is accepted", "if(ok.rows_read>caps.rowsReadPerStatement||ok.duration>caps.msPerStatement)refusals.push('meta_over_cap:'+label);", ""],
 ["the total rows read are not checked", "if(totalRead>caps.rowsReadTotal)refusals.push('meta_total_rows_read_over_cap');", ""],
 ["the total duration is not checked", "if(totalMs>caps.msTotal)refusals.push('meta_total_duration_over_cap');", ""],
 ["the per-table row cap is not checked", "if(count.n>caps.rowsReadPerStatement)refusals.push('rows_over_cap:'+item.table);", ""],
 ["the total row cap is not checked", "if(total>caps.rowsReadTotal)refusals.push('rows_total_over_cap');\n if(totalRead", "if(false)refusals.push('rows_total_over_cap');\n if(totalRead"],
 ["an existing output file is overwritten", "if(fs.existsSync(outFile))return {ok:false,refusals:['output_exists']};", ""],
 ["the manifest is not written", "lines.push('INSERT INTO '+MANIFEST+' (table_name,row_count,max_rowid) VALUES ('+literal(item.table)+','+literal(entry.count.n)+','+literal(entry.count.maxRowid)+');');", ""],
 ["a wrong schema version is accepted", "if(version!==CAPS.schemaVersion)refusals.push('schema_version:'+version);", ""],
 ["a missing manifest is accepted", "}catch{refusals.push('manifest_missing');}", "}catch{}"],
 ["a table that differs from its manifest is accepted", "if(manifest&&Number(manifest.get(item.table)?.row_count)!==count)refusals.push('manifest_mismatch:'+item.table);", ""],
 ["an unreadable copy is accepted", "}catch(error){refusals.push('copy_unreadable');}", "}catch(error){}"],
 ["foreign-key violations are accepted", "else refusals.push('foreign_key_violations:'+violations);", "else{}"],
 ["an inconsistent copy is reported representative", "representative:refusals.length===0&&nonrepresentative.length===0", "representative:refusals.length===0"],
 ["an inconsistent run is not labelled", "...(verdict.representative?{}:{nonrepresentative:verdict.nonrepresentative,notADCInput:true}),", ""],
 ["the run does not verify the copy first", "const verdict=verifyCopy(file,{allowInconsistent});\n if(!verdict.ok)return {ok:false,refusals:verdict.refusals};", "const verdict=verifyCopy(file,{allowInconsistent});"],
 ["the observed Films are every stored Film", "const scope=allFilms?stored:stored.filter(row=>watch.has(row.id));", "const scope=stored;"],
 ["the allFilms switch is ignored", "const scope=allFilms?stored:", "const scope=false?stored:"],
 ["a departed sample includes members", "stored.filter(row=>!watch.has(row.id)&&!ids.has(row.id))", "stored.filter(row=>!ids.has(row.id))"],
 ["a departed sample includes observed Films", "stored.filter(row=>!watch.has(row.id)&&!ids.has(row.id))", "stored.filter(row=>!watch.has(row.id))"],
 ["the Film bound is ignored", "const films=maxFilms?scope.slice(0,Number(maxFilms)):scope;", "const films=scope;"],
 ["every Person is a Person row", ".filter(row=>creditedPersons.has(row.id))", ""],
 ["credits of unobserved Films are kept", "if(!ids.has(row.film_id))continue;", ""],
 ["a Film off the watchlist is a member", "watchlist:watch.has(row.id),", "watchlist:true,"],
 ["the page key is inclusive", "WHERE rowid > ? ORDER BY rowid LIMIT ?'", "WHERE rowid >= ? ORDER BY rowid LIMIT ?'"],
 ["a column of the plan is dropped", "'canonical_identity','original_title','updated_at']}", "'canonical_identity','updated_at']}"],
 ["a table the harness reads is not copied", " {table:'person_alias',columns:['person_id','kind','value','provenance_json']},\n", ""],
 ["the count statement drops the maximum", "SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM '+item.table", "SELECT COUNT(*) AS n, 0 AS max_rowid FROM '+item.table"],
 ["the copy is loaded with the wrong column order", "INSERT INTO '+item.table+' ('+item.columns.join(',')+') VALUES ('+item.columns.map(column=>literal(row[column])).join(',')+');", "INSERT INTO '+item.table+' ('+item.columns.join(',')+') VALUES ('+[...item.columns].reverse().map(column=>literal(row[column])).join(',')+');"],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'m2b-mutants-'));
try{
 const original=fs.readFileSync('scripts/epg-producer-m2b.mjs','utf8');
 for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once');
 // ONE tree with its own src/, scripts/ and tests/ helpers, so the relative imports of a mutant resolve and the module graph is loaded once; every mutant is a sibling file of scripts/. The test body runs in THIS process for each mutant, one after the other.
 fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});fs.mkdirSync(path.join(dir,'tests'),{recursive:true});
 fs.cpSync('src',path.join(dir,'src'),{recursive:true});
 for(const file of ['scripts/schema-preflight.mjs','scripts/epg-producer-dry-run.mjs','tests/d1-standin.mjs','tests/sqlite-session.mjs'])fs.copyFileSync(file,path.join(dir,file));
 const place=(name,text)=>{const file=path.join(dir,'scripts','epg-producer-m2b.'+name+'.mjs');fs.writeFileSync(file,text);return file;};
 const run=async file=>{
  try{await check(await import(pathToFileURL(file).href),file);return 'passed';}
  catch(error){
   // a mutant that does not even load, or breaks on a name, is BROKEN, not killed
   assert.ok(!(error instanceof SyntaxError||error instanceof ReferenceError||error?.code==='ERR_MODULE_NOT_FOUND'),'broken mutant '+file+': '+String(error?.message).slice(0,300));
   return 'failed';
  }
 };
 assert.equal(await run(place('base',original)),'passed','the unmutated copy passes the whole test');
 const survivors=[];
 for(const [index,[name,from,to]] of MUTANTS.entries())if(await run(place('m'+index,original.replace(from,()=>to)))==='passed')survivors.push(name);
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 console.log('epg-producer-m2b-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
