#!/usr/bin/env node
// Operator entry for the metadata cache marker (ADR 0073). Default is read-only status.
// --load fills D1 from a local metadata.json and leaves mode r2. --activate sets mode d1
// only when the import still matches that file. --revert sets mode r2 only when that
// file matches the latest cache generation, and it keeps the rows.
// Each write refuses without its own --confirm. --load, --activate and --revert need --metadata.
// This process never selects production D1 and never calls the network.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {activateMetadataCache,importMetadataCache,readAuthority,revertMetadataCache} from '../src/metadata-cache.js';

const PRODUCTION=/3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb|(?:^|[\\/])iptv(?:[\\/]|$)/i;
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const load=args.includes('--load'),activate=args.includes('--activate'),revert=args.includes('--revert');
const confirm=value('--confirm'),database=value('--database'),metadata=value('--metadata');
const refuse=message=>{console.error('refuse: '+message);process.exit(2);};
if([load,activate,revert].filter(Boolean).length>1)refuse('pass only one of --load, --activate or --revert');
if(load&&confirm!=='load')refuse('--load requires --confirm load');
if(activate&&confirm!=='activate')refuse('--activate requires --confirm activate');
if(revert&&confirm!=='r2')refuse('--revert requires --confirm r2');
if(!database){
 console.log(JSON.stringify({configured:false,writes:false}));
 if(load||activate||revert)refuse('--database is required');
 process.exit(0);
}
if(PRODUCTION.test(database))refuse('this script does not select production D1');
if((load||activate||revert)&&!metadata)refuse('--metadata is required');

const literal=item=>{
 if(item===undefined)throw new Error('undefined bound');
 if(item==null)return 'NULL';
 if(typeof item==='number')return String(item);
 if(typeof item==='boolean')return item?'1':'0';
 return "'"+String(item).replace(/'/g,"''")+"'";
};
function sqlite(sql,{json=false}={}){
 const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',database],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',maxBuffer:1<<28});
 if(result.status!==0)throw new Error(result.stderr.trim()||'sqlite failed');
 return result.stdout;
}
const rows=sql=>{const out=sqlite(sql,{json:true}).trim();return out?JSON.parse(out):[];};
const statement=(sql,params)=>{
 let index=0;
 const text=sql.replace(/\?/g,()=>{if(index>=params.length)throw new Error('missing parameter');return literal(params[index++]);});
 if(index!==params.length)throw new Error('parameter count');
 return {text,async first(){return rows(text)[0]??null;},async all(){return {results:rows(text)};},async run(){sqlite(text+';');return {success:true};}};
};
const db={
 prepare(sql){return {bind(...params){return statement(sql,params);}};},
 async batch(statements){sqlite('BEGIN;\n'+statements.map(item=>item.text+';').join('\n')+'\nCOMMIT;');},
};
function etagOf(text){let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return (hash>>>0).toString(16)+'-'+text.length;}
function bucket(){
 const read=()=>fs.existsSync(metadata)?fs.readFileSync(metadata,'utf8'):null;
 return {
  async get(){const text=read();return text==null?null:{etag:etagOf(text),json:async()=>JSON.parse(text),text:async()=>text};},
  async head(){const text=read();return text==null?null:{etag:etagOf(text)};},
  async put(_key,body,options={}){
   const text=String(body),current=read(),only=options.onlyIf;
   if(only?.etagMatches!==undefined&&(current==null||etagOf(current)!==only.etagMatches))return null;
   if(only?.etagDoesNotMatch!==undefined&&current!=null&&(only.etagDoesNotMatch==='*'||etagOf(current)===only.etagDoesNotMatch))return null;
   fs.writeFileSync(metadata,text);
   return {etag:etagOf(text)};
  },
 };
}
const status=await readAuthority(db);
if(!load&&!activate&&!revert){console.log(JSON.stringify({...status,writes:false}));process.exit(0);}
const result=load?await importMetadataCache(db,bucket(),{confirm}):activate?await activateMetadataCache(db,bucket(),{confirm}):await revertMetadataCache(db,bucket(),{confirm});
console.log(JSON.stringify(result));
