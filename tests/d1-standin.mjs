// A D1 binding stand-in over the sqlite3 CLI for tests (AIR-275): prepare().bind() with first(), all() and run(), and batch()
// applied as one transaction that rolls back whole when a statement fails, as D1 does. Foreign keys are on, as in D1.
import {spawnSync} from 'node:child_process';

const literal=value=>{
 if(value===undefined)throw new Error('D1_TYPE_ERROR: undefined bound');
 if(value==null)return 'NULL';
 if(typeof value==='number'){if(!Number.isFinite(value))throw new Error('bad number');return String(value);}
 if(typeof value==='boolean')return value?'1':'0';
 return "'"+String(value).replace(/'/g,"''")+"'";
};
export function d1Standin(file,{onBatch=null}={}){
 const calls={queries:0,batches:0,statements:0};
 const sqlite=(sql,json)=>{const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr.trim()||'sqlite failed');return result.stdout;};
 const rows=text=>{const out=sqlite(text+';',true).trim();return out?JSON.parse(out):[];};
 const statement=(sql,params)=>{
  let index=0;const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('missing parameter');return literal(params[index++]);});
  if(index!==params.length)throw new Error('parameter count');
  return {text,async first(){calls.queries++;return rows(text)[0]??null;},async all(){calls.queries++;return {results:rows(text)};},async run(){calls.queries++;sqlite(text+';');return {success:true};}};
 };
 return {
  calls,
  prepare(sql){return {bind(...params){return statement(sql,params);},first(){return statement(sql,[]).first();},all(){return statement(sql,[]).all();},run(){return statement(sql,[]).run();}};},
  async batch(statements){
   calls.batches++;calls.statements+=statements.length;
   if(onBatch)await onBatch(statements);
   sqlite('BEGIN;\n'+statements.map(item=>item.text+';').join('\n')+'\nCOMMIT;');
   return statements.map(()=>({success:true}));
  },
  sql:text=>rows(text),
 };
}
