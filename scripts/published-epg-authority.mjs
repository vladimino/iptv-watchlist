#!/usr/bin/env node
// Offline operator for the published EPG marker (ADR 0079). Default is read-only status.
// --load copies local programme.json and watchlist.json into D1 and leaves mode r2.
// --activate holds the cutover, then opens it only when the local files still match. It does not leave a visible d1 before that.
// --revert repairs the pointer, programme.json, watchlist.json and their generation copies, then sets mode r2. It keeps the rows.
// Each write refuses without its own --confirm. This process never selects production D1 and never calls the network.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {activatePublished, importPublished, readAuthority, revertPublished, sealPublished} from '../src/published-epg.js';

const PRODUCTION=/3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb|(?:^|[\\/])iptv(?:[\\/]|$)/i;
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const load=args.includes('--load'),activate=args.includes('--activate'),revert=args.includes('--revert');
const confirm=value('--confirm'),database=value('--database');
const programmePath=value('--programme'),watchlistPath=value('--watchlist'),pointerPath=value('--pointer');
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
if((load||activate||revert)&&(!programmePath||!watchlistPath||!pointerPath))refuse('--programme, --watchlist and --pointer are required');

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
function readFile(file){return fs.readFileSync(file,'utf8');}
function bucket(){
 const files=new Map([['epg/published-generation.json',pointerPath],['programme.json',programmePath],['watchlist.json',watchlistPath]]);
 const extra=new Map();
 const read=key=>{
  if(extra.has(key))return extra.get(key);
  const file=files.get(key);
  if(!file||!fs.existsSync(file))return null;
  return readFile(file);
 };
 return {
  async get(key){const text=read(key);return text==null?null:{etag:etagOf(text),json:async()=>JSON.parse(text),text:async()=>text};},
  async head(key){const text=read(key);return text==null?null:{etag:etagOf(text)};},
  async put(key,body){
   const text=String(body);
   const file=files.get(key);
   if(file){fs.writeFileSync(file,text);return {etag:etagOf(text)};}
   if(/^epg\/generations\/[^/]+\/(?:programme|watchlist)\.json$/.test(key)){extra.set(key,text);return {etag:etagOf(text)};}
   return null;
  },
 };
}
const status=await readAuthority(db);
if(!load&&!activate&&!revert){console.log(JSON.stringify({mode:status.mode,tables:status.tables,version:status.version,programmeRunId:status.programmeRunId??null,generation:status.generation??null,writes:false}));process.exit(0);}
const programmeText=readFile(programmePath),watchlistText=readFile(watchlistPath),pointerText=readFile(pointerPath);
const programme=JSON.parse(programmeText),watchlist=JSON.parse(watchlistText),pointer=JSON.parse(pointerText);
const env={...db,BUCKET:bucket()};
const result=load
 ?await importPublished(env,{confirm:'load',programme,watchlist,programmeRunId:pointer.programmeRunId,publishedAt:programme.updatedAt??null,pointerEtag:etagOf(pointerText),watchlistEtag:etagOf(watchlistText)})
 :activate
  ?await sealPublished(env,await activatePublished(env,{confirm:'activate',pointerEtag:etagOf(pointerText)}))
  :await revertPublished(env,{confirm:'r2'});
console.log(JSON.stringify({mode:result.mode,programmeRunId:result.programmeRunId??null,generation:result.generation??null,writes:true}));
