// AIR-374 M2b reader: mutation check of the STOP RULES of scripts/epg-producer-m2b-reader.mjs, in the pattern of tests/epg-producer-m2b-mutation.mjs. Each mutant is a copy of the reader with ONE rule removed or inverted; the check() of tests/epg-producer-m2b-reader.mjs,
// run on the mutant in this process, must FAIL on it with an ASSERTION. A surviving mutant is a rule no test depends on; a mutant that does not load is BROKEN. Controls: a fresh work directory per check(), the unmutated reader passes twice in a row, a neutral change survives.
// The copies live OUTSIDE the repository tree.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {check} from './epg-producer-m2b-reader.mjs';

const MUTANTS=[
 ["no request function is accepted", "if(typeof request!=='function')halt('request_missing');", ""],
 ["a missing account or database is accepted", "if(typeof accountId!=='string'||!accountId||typeof databaseId!=='string'||!databaseId)halt('target_missing');", ""],
 ["the statements digest is not checked", "||typeof plan.statementsDigest!=='string'||!/^[0-9a-f]{64}$/.test(plan.statementsDigest))halt('plan_invalid',{why:'digest'});", ")halt('plan_invalid',{why:'digest'});"],
 ["missing caps are accepted", "if(!caps||typeof caps!=='object')halt('plan_invalid',{why:'caps'});", ""],
 ["a missing or invalid cap is accepted", "if(!isInt(caps[key])||caps[key]<1)halt('plan_invalid',{why:'caps'});", ""],
 ["a cap of zero is accepted", "||caps[key]<1)halt('plan_invalid',{why:'caps'});", ")halt('plan_invalid',{why:'caps'});"],
 ["a negative number is an integer", "Number.isInteger(value)&&value>=0", "Number.isInteger(value)"],
 ["a cap may be raised", "if(key==='schemaVersion'?caps[key]!==CEILING[key]:caps[key]>CEILING[key])halt('caps_over_ceiling',{key});", ""],
 ["another schema version is accepted in the caps", "caps[key]!==CEILING[key]:caps[key]>CEILING[key]", "false:caps[key]>CEILING[key]"],
 ["the ceiling of rows per statement is raised", "rowsReadPerStatement:300000", "rowsReadPerStatement:300001"],
 ["the ceiling of rows in total is raised", "rowsReadTotal:1500000", "rowsReadTotal:1500001"],
 ["the ceiling of the page size is raised", "pageRows:2000,", "pageRows:2001,"],
 ["the ceiling of milliseconds per statement is raised", "msPerStatement:5000", "msPerStatement:5001"],
 ["the ceiling of milliseconds in total is raised", "msTotal:120000", "msTotal:120001"],
 ["the page size is not bounded", "if(!isInt(pageRows)||pageRows<1||pageRows>caps.pageRows)halt('plan_invalid',{why:'pageRows'});", ""],
 ["the page size option is ignored", "pageRowsOption===undefined?caps.pageRows:pageRowsOption", "caps.pageRows"],
 ["the statement list is not checked", "if(!Array.isArray(statements)||statements.length<2||statements.length%2!==0)halt('plan_invalid',{why:'statements'});", ""],
 ["a statement that is not an object is accepted", "if(!count||!page||typeof count!=='object'||typeof page!=='object')halt('plan_invalid',{why:'statement'});", ""],
 ["the pairing of statements is not checked", "if(typeof table!=='string'||!IDENT.test(table)||page.table!==table||count.kind!=='count'||page.kind!=='page'||count.id!==table+'#count'||page.id!==table+'#page')halt('plan_invalid',{why:'pair'});", ""],
 ["an unsafe name is an identifier", "const IDENT=/^[a-z_][a-z0-9_]*$/;", "const IDENT=/^.*$/;"],
 ["a page statement without columns is accepted", "if(!Array.isArray(page.columns)||page.columns.length<1||page.columns.some(column=>typeof column!=='string'||!IDENT.test(column)))halt('plan_invalid',{why:'columns'});", ""],
 ["a statement other than the planned shape is accepted", "if(count.sql!==countSql||page.sql!==pageSql||!readOnly(count.sql)||!readOnly(page.sql))halt('statement_not_read_only',{table});", ""],
 ["the read-only check accepts everything", "const readOnly=sql=>typeof sql==='string'&&/^\\s*SELECT\\b/i.test(sql)&&!sql.includes(';')&&!/\\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|TRUNCATE)\\b/i.test(sql);", "const readOnly=sql=>true;"],
 ["a table twice is accepted", "if(tables.some(item=>item.table===table))halt('plan_invalid',{why:'duplicate'});", ""],
 ["a failing request is retried or rethrown", "catch(error){halt('request_failed',{id});}", "catch(error){throw error;}"],
 ["a request is not counted", "state.requests++;", ""],
 ["the request path is wrong", "+databaseId+'/query'", "+databaseId+'/queryx'"],
 ["a statement without parameters carries null parameters", "body:params===null?{sql}:{sql,params}", "body:{sql,params}"],
 ["a response that is not a success is accepted", "if(!envelope||envelope.success!==true)halt('response_not_success',{id});", ""],
 ["a response of the wrong shape is accepted", "if(!Array.isArray(answer)||answer.length!==1||!answer[0]||answer[0].success!==true||!Array.isArray(answer[0].results))halt('response_shape',{id});", ""],
 ["a response without metrics is accepted", "if(!meta||!isInt(meta.rows_read)||typeof meta.duration!=='number'||!Number.isFinite(meta.duration)||meta.duration<0)halt('meta_missing',{id});", ""],
 ["rows read over the per-statement cap are accepted", "if(meta.rows_read>caps.rowsReadPerStatement)halt('over_cap_rows_read',{id});", ""],
 ["a duration over the per-statement cap is accepted", "if(meta.duration>caps.msPerStatement)halt('over_cap_duration',{id});", ""],
 ["the running total of rows read is not checked", "if(totalRead>caps.rowsReadTotal)halt('over_cap_total_rows_read',{id});", ""],
 ["the running total of milliseconds is not checked", "if(totalMs>caps.msTotal)halt('over_cap_total_duration',{id});", ""],
 ["the totals are not accumulated", "totalRead+=meta.rows_read;totalMs+=meta.duration;", ""],
 ["the schema version query is changed", "'SELECT version FROM schema_contract WHERE id = 1'", "'SELECT version FROM schema_contract WHERE id = 2'"],
 ["a schema version other than the plan is accepted", "||schema.rows[0].version!==caps.schemaVersion)halt('schema_version'", ")halt('schema_version'"],
 ["a missing schema version row is not a stop", "if(schema.rows.length!==1||schema.rows[0].version", "if(schema.rows[0].version"],
 ["a failed marker request is not an unreadable marker", "error.halt.code==='request_failed'||", ""],
 ["a marker answer that is not a success is not an unreadable marker", "||error.halt.code==='response_not_success'", ""],
 ["a marker answer of the wrong shape is not an unreadable marker", "||error.halt.code==='response_shape'))halt('marker_unreadable'", "))halt('marker_unreadable'"],
 ["an unreadable marker row is accepted", "if(!mark||typeof mark.mode!=='string'||typeof mark.cutover!=='string'||!isInt(mark.generation))halt('marker_unreadable',{id:'film_person_authority'});", ""],
 ["a marker without a mode is accepted", "||typeof mark.mode!=='string'", ""],
 ["a marker without a cutover is accepted", "||typeof mark.cutover!=='string'", ""],
 ["the marker generation is not checked", "||!isInt(mark.generation))halt('marker_unreadable'", ")halt('marker_unreadable'"],
 ["an invalid count is accepted", "if(!row||!isInt(row.n)||!(row.max_rowid===null||isInt(row.max_rowid))||(row.n===0)!==(row.max_rowid===null))halt('count_invalid',{id:item.table+'#count'});", ""],
 ["a count that is not a number is accepted", "!isInt(row.n)||", ""],
 ["a maximum rowid that is not a number is accepted", "!(row.max_rowid===null||isInt(row.max_rowid))||", ""],
 ["a positive count without a maximum is accepted", "||(row.n===0)!==(row.max_rowid===null))halt('count_invalid'", ")halt('count_invalid'"],
 ["a count over the per-statement cap is accepted", "if(row.n>caps.rowsReadPerStatement)halt('rows_over_cap',{id:item.table+'#count'});", ""],
 ["the page request uses a fixed cursor", "send(item.pageSql,[after,pageRows],id)", "send(item.pageSql,[0,pageRows],id)"],
 ["the cursor does not move", "total+=page.rows.length;after=previous;", "total+=page.rows.length;"],
 ["a page over the page size is accepted", "if(page.rows.length>pageRows)halt('page_over_size',{id});", ""],
 ["a row that is not an object is accepted", "if(!line||typeof line!=='object'||Array.isArray(line))halt('row_not_object',{id});", ""],
 ["columns other than planned are accepted", "if(keys.length!==allowed.size||keys.some(key=>!allowed.has(key)))halt('columns_mismatch',{id});", ""],
 ["a missing column is accepted", "keys.length!==allowed.size||", ""],
 ["a renamed column is accepted", "||keys.some(key=>!allowed.has(key)))halt('columns_mismatch'", ")halt('columns_mismatch'"],
 ["a value that is not a scalar is accepted", "if(keys.some(key=>line[key]!==null&&typeof line[key]!=='string'&&typeof line[key]!=='number'))halt('value_not_scalar',{id});", ""],
 ["the row order is not checked", "if(!isInt(line._rid)||line._rid<=previous)halt('rowid_order',{id});", ""],
 ["a rowid that does not increase is accepted", "||line._rid<=previous)halt('rowid_order'", ")halt('rowid_order'"],
 ["a rowid that is not a number is accepted", "if(!isInt(line._rid)||", "if("],
 ["the page cursor is recorded wrongly", "pages.push({after,last:previous,rows:page.rows,meta:page.meta});", "pages.push({after,last:after,rows:page.rows,meta:page.meta});"],
 ["the metrics of a page are not recorded", "rows:page.rows,meta:page.meta}", "rows:page.rows,meta:{rows_read:0,duration:0}}"],
 ["a table that grew is not a stop", "if(total>row.n)halt('count_changed',{id});", ""],
 ["a full page that completes the count does not end the table", "||total===row.n)finished=true;", ")finished=true;"],
 ["a row total other than the count is accepted", "if(total!==row.n)halt('count_mismatch',{id:item.table});", ""],
 ["a last rowid other than the maximum is accepted", "if(row.n>0&&after!==row.max_rowid)halt('max_rowid_mismatch',{id:item.table});", ""],
 ["the metrics of the count are not recorded", "maxRowid:row.max_rowid,meta:countAnswer.meta}", "maxRowid:row.max_rowid,meta:{rows_read:0,duration:0}}"],
 ["the capture time is not injected", "typeof now==='function'?now():new Date().toISOString()", "new Date().toISOString()"],
 ["the page size is not recorded", "_pageRows:pageRows,", "_pageRows:caps.pageRows,"],
 ["the checks are not reported", "checks:{schemaVersion:schema.rows[0].version,marker:{mode:mark.mode,cutover:mark.cutover,generation:mark.generation}}", "checks:{}"],
 ["a defect of the reader is not reported as one", "return {ok:false,stop:{code:'reader_defect'},requests:state.requests};", "throw error;"],
 ["the approved digest is not checked", "if(plan.statementsDigest!==APPROVED_DIGEST||tables.length!==APPROVED.length)halt('plan_not_approved',{why:'plan'});", "if(tables.length!==APPROVED.length)halt('plan_not_approved',{why:'plan'});"],
 ["a plan with fewer tables than the approved plan is accepted", "||tables.length!==APPROVED.length)halt('plan_not_approved'", ")halt('plan_not_approved'"],
 ["the approved tables and columns are not checked", "if(!approved||approved[0]!==table||approved[1].length!==page.columns.length||approved[1].some((column,place)=>column!==page.columns[place]))halt('plan_not_approved',{why:'table',table});", ""],
 ["an extra table beyond the approved list is accepted", "if(!approved||approved[0]", "if(approved&&approved[0]"],
 ["the approved table name is not compared", "approved[0]!==table||", ""],
 ["the approved column count is not compared", "approved[1].length!==page.columns.length||", ""],
 ["the approved column names are not compared", "||approved[1].some((column,place)=>column!==page.columns[place])", ""],
 ["the approved digest of the text is another plan", "const APPROVED_DIGEST='ca84fae5", "const APPROVED_DIGEST='ca84fae6"],
 ["the approved list drops a column", '["film",["id","contract_version",', '["film",["id",'],
 ["the approved list adds a table", '["canonical_revision",["kind","id","revision","updated_at"]]]', '["canonical_revision",["kind","id","revision","updated_at"]],["schema_contract",["version"]]]'],
 ["the operator bundle is offered", "export function bundleText(){throw new Error('single_result_delivery_blocked');}", "export function bundleText(options){return executeBodyText(options);}"],
];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'m2b-reader-mutants-'));
try{
 const original=fs.readFileSync('scripts/epg-producer-m2b-reader.mjs','utf8');
 for(const [name,from] of MUTANTS)assert.equal(original.split(from).length,2,'the mutation text of "'+name+'" must occur exactly once');
 // ONE tree with its own src/, scripts/ and tests/ helpers, so the relative imports of a mutant resolve and the module graph is loaded once; every mutant is a sibling file of scripts/. The test body runs in THIS process for each mutant, one after the other.
 fs.mkdirSync(path.join(dir,'scripts'),{recursive:true});fs.mkdirSync(path.join(dir,'tests'),{recursive:true});
 fs.cpSync('src',path.join(dir,'src'),{recursive:true});
 for(const file of ['scripts/schema-preflight.mjs','scripts/epg-producer-dry-run.mjs','scripts/epg-producer-m2b.mjs','tests/d1-standin.mjs','tests/sqlite-session.mjs'])fs.copyFileSync(file,path.join(dir,file));
 const place=(name,text)=>{const file=path.join(dir,'scripts','epg-producer-m2b-reader.'+name+'.mjs');fs.writeFileSync(file,text);return file;};
 // A kill counts only when the TEST ASSERTION about the altered rule failed. A setup failure or any other error is not a kill: it would mean the mutants die before the altered rule is tested.
 const SETUP=/EEXIST|ENOENT|no such file or directory|CANTOPEN|database is locked|EBUSY/i;
 const run=async file=>{
  try{await check(await import(pathToFileURL(file).href),file);return {state:'passed'};}
  catch(error){
   // a mutant that does not even load, or breaks on a name, is BROKEN, not killed
   assert.ok(!(error instanceof SyntaxError||error instanceof ReferenceError||error?.code==='ERR_MODULE_NOT_FOUND'),'broken mutant '+file+': '+String(error?.message).slice(0,300));
   return {state:'failed',error};
  }
 };
 // sanity controls: the UNMUTATED reader passes twice in a row in this one process (no state is left behind), and a semantically neutral change survives
 assert.equal((await run(place('base',original))).state,'passed','the unmutated reader passes the whole test');
 assert.equal((await run(place('base-again',original))).state,'passed','the unmutated reader passes a second time in the same process');
 const neutral=original.replace("const IDENT=/^[a-z_][a-z0-9_]*$/;","const IDENT=/^[a-z_][a-z0-9_]*$/;const NEUTRAL_MARKER=1;");
 assert.notEqual(neutral,original);
 assert.equal((await run(place('neutral',neutral))).state,'passed','a neutral change survives: the control that a kill is not a harness failure');
 const survivors=[],invalid=[];
 for(const [index,[name,from,to]] of MUTANTS.entries()){
  const result=await run(place('m'+index,original.replace(from,()=>to)));
  if(result.state==='passed'){survivors.push(name);continue;}
  const error=result.error;
  if(process.env.M2B_MUTATION_REASONS)console.log(String(index).padStart(2)+' '+name+' => '+String(error?.message).split('\n')[0].slice(0,110));
  if(error?.code!=='ERR_ASSERTION'||SETUP.test(String(error?.message)))invalid.push(name+': '+String(error?.code||error?.name)+' '+String(error?.message).split('\n')[0].slice(0,120));
 }
 assert.deepEqual(survivors,[],'mutants that no test kills: '+survivors.join(', '));
 assert.deepEqual(invalid,[],'mutants killed by something other than the assertion about the altered rule: '+invalid.join(' | '));
 console.log('epg-producer-m2b-reader-mutation: ok ('+MUTANTS.length+' mutants killed)');
}finally{fs.rmSync(dir,{recursive:true,force:true});}
