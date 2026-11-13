// AIR-374 M2b: the READER of the copy plan of scripts/epg-producer-m2b.mjs. OFFLINE until an owner GO: this file never runs by itself, touches no network, no file, no environment and no secret. `readCopy` is a PURE function over an injected `request`
// (the shape of `cloudflare.request({method, path, body})`), so the one reviewed text that an authorized operator would hand to an `execute` call is the same text the tests run against a fake connector over the sqlite D1 stand-in.
//
// What it does, in the order of the runbook protocol (docs/runbooks/film-person-m2b-dry-run-copy.md, section 2): it refuses a plan it does not recognise BEFORE any request; then sends ONE statement per request, in the printed order
// (the schema version check, the Film/Person marker read, then per table the count statement and the keyset pages), checks the response and the connector metrics of EACH response BEFORE it sends the next statement, and assembles exactly the
// results file that `verifyResults` of scripts/epg-producer-m2b.mjs accepts. On ANY problem it STOPS: it returns `{ok:false, stop:{code, ...}, requests}`, sends no further request and has no retry loop.
//
// `readCopy` is written to be self-contained (no import, no outer name except the JS built-ins), so `String(readCopy)` is its complete text: `bundleText` wraps that text for an `execute` call, and `readerDigest` is the digest of it.
// Nothing here is a GO: a production read needs its own exactly scoped owner GO.
import {createHash} from 'node:crypto';

export async function readCopy({request,accountId,databaseId,plan,pageRows:pageRowsOption,now}={}){
 // Ceilings the plan may lower and never raise (the same numbers as the proposals of the runbook and of the E6 measurement).
 const CEILING={rowsReadPerStatement:300000,rowsReadTotal:1500000,pageRows:2000,msPerStatement:5000,msTotal:120000,schemaVersion:21};
 const SCHEMA_SQL='SELECT version FROM schema_contract WHERE id = 1';
 const MARKER_SQL='SELECT mode, cutover, generation FROM film_person_authority WHERE id = 1';
 const IDENT=/^[a-z_][a-z0-9_]*$/;
 const state={requests:0};
 const halt=(code,detail)=>{const error=new Error(code);error.halt={code,...(detail||{})};throw error;};
 const isInt=value=>Number.isInteger(value)&&value>=0;
 // A statement is accepted only if it is one read-only SELECT of exactly the shape the plan builds; nothing else is ever sent.
 const readOnly=sql=>typeof sql==='string'&&/^\s*SELECT\b/i.test(sql)&&!sql.includes(';')&&!/\b(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|PRAGMA|ATTACH|DETACH|VACUUM|REINDEX|TRUNCATE)\b/i.test(sql);
 try{
  // ---- the plan, refused before any request ----
  if(typeof request!=='function')halt('request_missing');
  if(typeof accountId!=='string'||!accountId||typeof databaseId!=='string'||!databaseId)halt('target_missing');
  if(!plan||typeof plan!=='object'||typeof plan.statementsDigest!=='string'||!/^[0-9a-f]{64}$/.test(plan.statementsDigest))halt('plan_invalid',{why:'digest'});
  const caps=plan.caps;
  if(!caps||typeof caps!=='object')halt('plan_invalid',{why:'caps'});
  for(const key of Object.keys(CEILING)){
   if(!isInt(caps[key])||caps[key]<1)halt('plan_invalid',{why:'caps'});
   if(key==='schemaVersion'?caps[key]!==CEILING[key]:caps[key]>CEILING[key])halt('caps_over_ceiling',{key});
  }
  const pageRows=pageRowsOption===undefined?caps.pageRows:pageRowsOption;
  if(!isInt(pageRows)||pageRows<1||pageRows>caps.pageRows)halt('plan_invalid',{why:'pageRows'});
  const statements=plan.statements;
  if(!Array.isArray(statements)||statements.length<2||statements.length%2!==0)halt('plan_invalid',{why:'statements'});
  const tables=[];
  for(let index=0;index<statements.length;index+=2){
   const count=statements[index],page=statements[index+1];
   if(!count||!page||typeof count!=='object'||typeof page!=='object')halt('plan_invalid',{why:'statement'});
   const table=count.table;
   if(typeof table!=='string'||!IDENT.test(table)||page.table!==table||count.kind!=='count'||page.kind!=='page'||count.id!==table+'#count'||page.id!==table+'#page')halt('plan_invalid',{why:'pair'});
   if(!Array.isArray(page.columns)||page.columns.length<1||page.columns.some(column=>typeof column!=='string'||!IDENT.test(column)))halt('plan_invalid',{why:'columns'});
   const countSql='SELECT COUNT(*) AS n, MAX(rowid) AS max_rowid FROM '+table;
   const pageSql='SELECT rowid AS _rid, '+page.columns.join(', ')+' FROM '+table+' WHERE rowid > ? ORDER BY rowid LIMIT ?';
   if(count.sql!==countSql||page.sql!==pageSql||!readOnly(count.sql)||!readOnly(page.sql))halt('statement_not_read_only',{table});
   if(tables.some(item=>item.table===table))halt('plan_invalid',{why:'duplicate'});
   tables.push({table,columns:page.columns,countSql,pageSql});
  }
  // ---- one statement per request; every response is judged before the next request ----
  const target='/accounts/'+accountId+'/d1/database/'+databaseId+'/query';
  let totalRead=0,totalMs=0;
  const send=async(sql,params,id)=>{
   state.requests++;
   let envelope;
   try{envelope=await request({method:'POST',path:target,body:params===null?{sql}:{sql,params}});}
   catch(error){halt('request_failed',{id});}
   if(!envelope||envelope.success!==true)halt('response_not_success',{id});
   const answer=envelope.result;
   if(!Array.isArray(answer)||answer.length!==1||!answer[0]||answer[0].success!==true||!Array.isArray(answer[0].results))halt('response_shape',{id});
   const meta=answer[0].meta;
   if(!meta||!isInt(meta.rows_read)||typeof meta.duration!=='number'||!Number.isFinite(meta.duration)||meta.duration<0)halt('meta_missing',{id});
   totalRead+=meta.rows_read;totalMs+=meta.duration;
   if(meta.rows_read>caps.rowsReadPerStatement)halt('over_cap_rows_read',{id});
   if(meta.duration>caps.msPerStatement)halt('over_cap_duration',{id});
   if(totalRead>caps.rowsReadTotal)halt('over_cap_total_rows_read',{id});
   if(totalMs>caps.msTotal)halt('over_cap_total_duration',{id});
   return {rows:answer[0].results,meta:{rows_read:meta.rows_read,duration:meta.duration}};
  };
  // the schema version of the plan
  const schema=await send(SCHEMA_SQL,null,'schema_contract');
  if(schema.rows.length!==1||schema.rows[0].version!==caps.schemaVersion)halt('schema_version',{id:'schema_contract',found:schema.rows.length===1?schema.rows[0].version:null});
  // the Film/Person marker must be readable
  let marker;
  try{marker=await send(MARKER_SQL,null,'film_person_authority');}
  catch(error){
   if(error&&error.halt&&(error.halt.code==='request_failed'||error.halt.code==='response_not_success'||error.halt.code==='response_shape'))halt('marker_unreadable',{id:'film_person_authority'});
   throw error;
  }
  const mark=marker.rows.length===1?marker.rows[0]:null;
  if(!mark||typeof mark.mode!=='string'||typeof mark.cutover!=='string'||!isInt(mark.generation))halt('marker_unreadable',{id:'film_person_authority'});
  const result={};
  for(const item of tables){
   const countAnswer=await send(item.countSql,null,item.table+'#count');
   const row=countAnswer.rows.length===1?countAnswer.rows[0]:null;
   if(!row||!isInt(row.n)||!(row.max_rowid===null||isInt(row.max_rowid))||(row.n===0)!==(row.max_rowid===null))halt('count_invalid',{id:item.table+'#count'});
   if(row.n>caps.rowsReadPerStatement)halt('rows_over_cap',{id:item.table+'#count'});
   const allowed=new Set(['_rid',...item.columns]);
   const pages=[];
   let after=0,total=0,finished=false;
   // every page either ends the table (short, or the count is complete), or adds rows and moves the cursor, or stops with count_changed: the loop cannot run on
   for(let number=0;!finished;number++){
    const id=item.table+'#page'+number;
    const page=await send(item.pageSql,[after,pageRows],id);
    if(page.rows.length>pageRows)halt('page_over_size',{id});
    let previous=after;
    for(const line of page.rows){
     if(!line||typeof line!=='object'||Array.isArray(line))halt('row_not_object',{id});
     const keys=Object.keys(line);
     if(keys.length!==allowed.size||keys.some(key=>!allowed.has(key)))halt('columns_mismatch',{id});
     if(keys.some(key=>line[key]!==null&&typeof line[key]!=='string'&&typeof line[key]!=='number'))halt('value_not_scalar',{id});
     if(!isInt(line._rid)||line._rid<=previous)halt('rowid_order',{id});
     previous=line._rid;
    }
    pages.push({after,last:previous,rows:page.rows,meta:page.meta});
    total+=page.rows.length;after=previous;
    if(total>row.n)halt('count_changed',{id});
    // a short page ends the table, and so does a full page that completes the recorded count
    if(page.rows.length<pageRows||total===row.n)finished=true;
   }
   if(total!==row.n)halt('count_mismatch',{id:item.table});
   if(row.n>0&&after!==row.max_rowid)halt('max_rowid_mismatch',{id:item.table});
   result[item.table]={count:{n:row.n,maxRowid:row.max_rowid,meta:countAnswer.meta},pages};
  }
  const stamp=typeof now==='function'?now():new Date().toISOString();
  return {ok:true,requests:state.requests,checks:{schemaVersion:schema.rows[0].version,marker:{mode:mark.mode,cutover:mark.cutover,generation:mark.generation}},results:{_statementsDigest:plan.statementsDigest,_capturedAt:stamp,_pageRows:pageRows,tables:result}};
 }catch(error){
  // a stop is a RESULT; anything else is a defect of the reader and is reported as one, never as a copy
  if(error&&error.halt)return {ok:false,stop:error.halt,requests:state.requests};
  return {ok:false,stop:{code:'reader_defect'},requests:state.requests};
 }
}

// The text an authorized operator hands to an `execute` call: the function text, called with the plan and the target database inline. The plan is DATA (the output of `emit-sql`); the database id is the operator's.
export function bundleText({plan,databaseId,pageRows}){
 const options='{request:o=>cloudflare.request(o),accountId,databaseId:'+JSON.stringify(databaseId)+',plan:'+JSON.stringify(plan)+(pageRows===undefined?'':',pageRows:'+JSON.stringify(pageRows))+'}';
 return 'async () => {\n'+String(readCopy)+'\nreturn readCopy('+options+');\n}';
}
// The digest of the reader: of the text of `readCopy` alone, so it does not move with the plan or the database id.
export const readerDigest=()=>createHash('sha256').update(String(readCopy)).digest('hex');
export const bundleDigest=options=>createHash('sha256').update(bundleText(options)).digest('hex');
