#!/usr/bin/env node
// Operator entry for the prediction-domain marker (ADR 0076). Default is read-only status.
// --load copies a local snapshot into the tables and leaves mode r2.
// --activate sets mode d1 only when the generations still match that load.
// --revert sets mode r2 only when the generations still match, and it keeps the rows.
// Each write refuses without its own --confirm. --load needs --snapshot.
// This process never selects production D1 and never calls the network.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {activatePredictionDomain,importPredictionDomain,readPredictionAuthority,revertPredictionDomain} from '../src/prediction-d1.js';

const PRODUCTION=/3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb|(?:^|[\\/])iptv(?:[\\/]|$)/i;
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const load=args.includes('--load'),activate=args.includes('--activate'),revert=args.includes('--revert');
const confirm=value('--confirm'),database=value('--database'),snapshotPath=value('--snapshot');
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
if(load&&!snapshotPath)refuse('--snapshot is required');
if(!fs.existsSync(database))refuse('database file is missing');

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
const status=await readPredictionAuthority(db);
if(!load&&!activate&&!revert){console.log(JSON.stringify({...status,writes:false}));process.exit(0);}
const snapshot=load?JSON.parse(fs.readFileSync(snapshotPath,'utf8')):null;
function bucket(){
 const objects=new Map(Object.entries(snapshot.objects||{}).map(([key,body])=>[key,JSON.stringify(body)]));
 return {async get(key){const text=objects.get(key);return text==null?null:{text:async()=>text,json:async()=>JSON.parse(text)};},async put(){throw new Error('this script does not write R2');}};
}
const result=load?await importPredictionDomain(db,bucket(),snapshot):activate?await activatePredictionDomain(db,{generation:status.generation,queueGeneration:status.queueGeneration,profileGeneration:status.profileGeneration}):await revertPredictionDomain(db,{generation:status.generation,queueGeneration:status.queueGeneration,profileGeneration:status.profileGeneration});
console.log(JSON.stringify({...result,writes:true}));
