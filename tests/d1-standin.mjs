// A D1 binding stand-in over the sqlite3 CLI for tests (AIR-275): prepare().bind() with first(), all() and run(), and batch()
// applied as one transaction that rolls back whole when a statement fails, as D1 does. Foreign keys are on, as in D1.
import {sqliteSync} from './sqlite-session.mjs';

const literal=value=>{
 if(value===undefined)throw new Error('D1_TYPE_ERROR: undefined bound');
 if(value==null)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('bad number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 return "'"+String(value).replace(/'/g,"''")+"'";
};
// `rewrite(sql)` (tests only) changes the text of every statement before it runs: the way a test makes the database compute something other than the Worker expects.
// `rowStats` (tests only, AIR-553): an object {read,written}; reads add the rows RETURNED (a lower bound of the rows a D1 query scans) and writes add sqlite's `total_changes()` (rows changed, triggers included).
export function d1Standin(file,{onBatch=null,maxBinds=null,latencyMs=0,onQuery=null,rewrite=null,rowStats=null}={}){
 const calls={queries:0,batches:0,statements:0};
 const sqlite=(sql,json)=>{const result=sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql});if(result.status!==0)throw new Error(result.stderr.trim()||'sqlite failed');return result.stdout;};
 const rows=text=>{const out=sqlite(text+';',true).trim();const list=out?JSON.parse(out):[];if(rowStats)rowStats.read+=list.length;return list;};
 const changed=text=>{if(!rowStats){sqlite(text);return;}const out=sqlite(text+'\nSELECT total_changes() AS n;',true).trim();if(out){const list=JSON.parse(out);rowStats.written+=Number(list[list.length-1]?.n)||0;}};
 const statement=(sql,params)=>{
  if(maxBinds!=null&&params.length>maxBinds)throw new Error('D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR');
  if(rewrite)sql=rewrite(sql);
  let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('missing parameter');return literal(params[index++]);});
  if(index!==params.length)throw new Error('parameter count');
  // `latencyMs` models D1's round trip so a test can tell a sequential read from a concurrent one; `onQuery` sees each statement before it runs.
  const wait=async()=>{if(latencyMs)await new Promise(resolve=>setTimeout(resolve,latencyMs));if(onQuery)await onQuery(text);};
  return {text,async first(){calls.queries++;await wait();return rows(text)[0]??null;},async all(){calls.queries++;await wait();return {results:rows(text)};},async run(){calls.queries++;await wait();changed(text+';');return {success:true};}};
 };
 return {
  calls,
  prepare(sql){return {bind(...params){return statement(sql,params);},first(){return statement(sql,[]).first();},all(){return statement(sql,[]).all();},run(){return statement(sql,[]).run();}};},
  async batch(statements){
   calls.batches++;calls.statements+=statements.length;
   if(onBatch)await onBatch(statements);
   // A batch of reads only (ADR 0106's prefetch) answers with the rows of each statement, in order, as D1 does; a write batch is still one transaction.
   if(statements.every(item=>/^\s*SELECT/i.test(item.text)))return statements.map(item=>({success:true,results:rows(item.text)}));
   // A write batch that also contains SELECT statements (for example `SELECT changes()` after an UPDATE, as D1 allows) answers with the rows of each SELECT, in order, like D1's per-statement results.
   const selects=statements.map((item,index)=>/^\s*SELECT/i.test(item.text)?index:-1).filter(index=>index>=0);
   if(selects.length){
    const out=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\nBEGIN;\n'+statements.map(item=>item.text+';').join('\n')+'\nCOMMIT;'});
    if(out.status!==0)throw new Error(out.stderr.trim()||'sqlite failed');
    // sqlite prints one JSON array per SELECT that returned rows, in order; a SELECT with no row prints nothing, so every SELECT of these batches must return a row.
    const arrays=[];const text=String(out.stdout||'').trim();
    if(text){let depth=0,start=0;for(let i=0;i<text.length;i++){const c=text[i];if(c==='[')depth++;if(c===']'){depth--;if(depth===0){arrays.push(JSON.parse(text.slice(start,i+1)));start=i+1;while(/\s/.test(text[start]||''))start++;i=start-1;}}}}
    let next=0;
    return statements.map((item,index)=>selects.includes(index)?{success:true,results:arrays[next++]||[]}:{success:true});
   }
   changed('BEGIN;\n'+statements.map(item=>item.text+';').join('\n')+'\nCOMMIT;');
   return statements.map(()=>({success:true}));
  },
  sql:text=>rows(text),
 };
}
