// AIR-374 P6 (offline): shared pieces of the differential harness. One migration-chain template database, copied per scenario; a D1 stand-in adapter for the projector
// repository; a table-by-table dump and diff of the rows both writers leave. Nothing here touches R2, Cloudflare or production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

export const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-differential-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
export const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
export const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const o=r.stdout.trim();return o?JSON.parse(o):[];};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;";
let preparedTemplate=null;
// The one template: the whole migration chain, baseline verified, marker `prepared`. Built once per process; every scenario database is a copy of it.
export function template(){
 if(preparedTemplate)return preparedTemplate;
 // The mutation check builds the template once and shares it with its child runs (the chain replay is the slow part, not the copy).
 if(process.env.DIFFERENTIAL_TEMPLATE&&fs.existsSync(process.env.DIFFERENTIAL_TEMPLATE))return preparedTemplate=process.env.DIFFERENTIAL_TEMPLATE;
 const file=path.join(root,'template-prepared.sqlite');
 sqlite(file,chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 sqlite(file,VERIFY);
 return preparedTemplate=file;
}
let n=0;
export const copyOf=(source,label)=>{const file=path.join(root,label+'-'+(n++)+'.sqlite');fs.copyFileSync(source,file);return file;};
export const fresh=()=>copyOf(template(),'p');
// The same database moved to `open` (what the handoff batch leaves): mode d1, generation 2. The rows stay exactly as they are.
export const opened=file=>{const out=copyOf(file,'c');sqlite(out,"UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1");return out;};
export const envOf=file=>({DB:d1Standin(file)});
// The projector repository's database adapter (run, get, all) over the stand-in.
export const adapter=file=>{const db=d1Standin(file);return {run:async(text,params=[])=>{await db.prepare(text).bind(...params).run();},get:async(text,params=[])=>db.prepare(text).bind(...params).first(),all:async(text,params=[])=>(await db.prepare(text).bind(...params).all()).results,transaction:async work=>{await work();}};};

// The compared tables and the columns that identify a row in each (the rest are compared as values).
export const TABLES=Object.freeze({
 film:['id'],person:['id'],film_external_id:['film_id','scheme','value'],person_external_id:['person_id','scheme','value'],film_alias:['film_id','kind','value'],person_alias:['person_id','kind','value'],
 film_person_credit:['film_id','person_id','role'],film_dimension:['film_id','dimension'],person_dimension:['person_id','dimension'],watchlist_film:['film_id'],film_redirect:['from_id'],
 film_sync_state:['film_id'],film_metadata:['film_id'],localization_conflict:['id'],
});
export const dumpTable=(file,table)=>rows(file,'SELECT * FROM '+table+' ORDER BY '+TABLES[table].join(','));
const keyOf=(table,row)=>TABLES[table].map(column=>String(row[column])).join('|');
// Every difference between two databases, table by table: a row only one side holds, or a column that differs on a row both hold.
export function diffDatabases(projectorFile,canonicalFile){
 const out=[];
 for(const table of Object.keys(TABLES)){
  const left=new Map(dumpTable(projectorFile,table).map(row=>[keyOf(table,row),row])),right=new Map(dumpTable(canonicalFile,table).map(row=>[keyOf(table,row),row]));
  for(const [key,row] of left){
   const other=right.get(key);
   if(!other){out.push({table,key,kind:'only_projector',row});continue;}
   for(const column of Object.keys(row))if((row[column]??null)!==(other[column]??null))out.push({table,key,kind:'column',column,projector:row[column]??null,canonical:other[column]??null,projectorRow:row,canonicalRow:other});
  }
  for(const [key,row] of right)if(!left.has(key))out.push({table,key,kind:'only_canonical',row});
 }
 return out;
}
