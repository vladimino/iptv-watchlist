#!/usr/bin/env node
// Generates scripts/d1-migration-window-reference.json: the exact expected schema (fingerprint of every table, index, trigger and view) of each version 38..54 of the D1 migration
// window (AIR-603), by applying the unchanged migration files, as the statements the operator would send, to scratch SQLite databases. A developer and test tool: it needs the
// `sqlite3` CLI and touches no production database. `--write` rewrites the JSON; without it the generated value is printed. tests/d1-migration-window-production.mjs requires the
// committed JSON to equal the regenerated one, so it cannot drift from the files.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {migrationStatements} from './published-epg-production.mjs';
import {BASE_VERSION,CHECKPOINT_B,objectFingerprint,ownedName} from './d1-migration-window-production.mjs';

const ROOT=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const sqlite=(file,input,json=false)=>{
 const result=spawnSync('sqlite3',[...(json?['-json']:[]),'-bail',file],{input,encoding:'utf8',maxBuffer:1<<28});
 if(result.status!==0)throw new Error(result.stderr||'sqlite3 failed');
 return result.stdout;
};
const snapshot=file=>{
 const rows=JSON.parse(sqlite(file,"SELECT type, name, tbl_name AS tbl, sql FROM sqlite_master WHERE sql IS NOT NULL AND type IN ('table','index','trigger','view');",true)||'[]');
 return new Map(rows.filter(row=>!ownedName(row.name)).map(row=>[row.name,objectFingerprint(row)]));
};
export function buildReference(root=ROOT){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'air603-reference-'));
 try{
  const file=path.join(directory,'chain.sqlite');
  const names=fs.readdirSync(path.join(root,'migrations')).filter(name=>/^\d{4}_.*\.sql$/.test(name)&&Number(name.slice(0,4))<=CHECKPOINT_B).sort();
  let previous=null;const data={format:1,base:null,transient:[],steps:{}};
  for(const name of names){
   const version=Number(name.slice(0,4));
   // the statements as extracted (no comments), each ended by `;`, exactly what the operator sends
   sqlite(file,'PRAGMA foreign_keys=ON;\n'+migrationStatements(fs.readFileSync(path.join(root,'migrations',name),'utf8')).map(sql=>sql+';').join('\n')+'\n');
   if(version<BASE_VERSION)continue;
   const now=snapshot(file);
   // staging objects a file creates and removes again within itself (the `*_hold` and `*_v53` tables): never in a snapshot, but their presence means the file was started
   if(version>BASE_VERSION)for(const sql of migrationStatements(fs.readFileSync(path.join(root,'migrations',name),'utf8'))){
    const match=/^CREATE (?:TABLE|INDEX|TRIGGER)(?: IF NOT EXISTS)? "?([A-Za-z0-9_]+)"?/i.exec(sql);
    if(match&&!now.has(match[1])&&!(previous&&previous.has(match[1])))data.transient.push(match[1]);
   }
   if(version===BASE_VERSION)data.base=Object.fromEntries([...now].sort(([a],[b])=>a<b?-1:1));
   else{
    const set={},del=[];
    for(const [objectName,value] of now)if(!previous.has(objectName)||JSON.stringify(previous.get(objectName))!==JSON.stringify(value))set[objectName]=value;
    for(const objectName of previous.keys())if(!now.has(objectName))del.push(objectName);
    data.steps[String(version)]={set:Object.fromEntries(Object.entries(set).sort(([a],[b])=>a<b?-1:1)),del:del.sort()};
   }
   previous=now;
  }
  data.transient=[...new Set(data.transient)].sort();
  return data;
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}
export const serialize=data=>JSON.stringify(data,null,1)+'\n';
const invoked=process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href;
if(invoked){
 const text=serialize(buildReference());
 if(process.argv.includes('--write'))fs.writeFileSync(path.join(ROOT,'scripts/d1-migration-window-reference.json'),text);
 else process.stdout.write(text);
}
