#!/usr/bin/env node
// Operator entry for the owner-review marker (ADR 0081). Default is read-only status.
// --load copies a local admin/owner-reviews.json into the rows and leaves mode r2.
// An absent file is an empty document only when the get returns no object.
// --activate sets mode d1 only when that file still matches the rows.
// --revert sets mode r2 only after the R2 mirror matches the rows. If the mirror
// cannot be written, the mode stays d1.
// Each write refuses without its own --confirm. This process never selects
// production D1 and never calls the network. It is not the production entry.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {activateOwnerReviews,importOwnerReviews,OWNER_REVIEWS_KEY,readAuthority,revertOwnerReviews} from '../src/owner-review-d1.js';

const PRODUCTION=/3fba0e0a-44e9-4a3a-a7ba-edaee6bcafcb|(?:^|[\\/])iptv(?:[\\/]|$)/i;
const args=process.argv.slice(2);
const value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:undefined;};
const load=args.includes('--load'),activate=args.includes('--activate'),revert=args.includes('--revert');
const confirm=value('--confirm'),database=value('--database'),reviews=value('--reviews');
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
if((load||activate||revert)&&!reviews)refuse('--reviews is required');

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
 const read=()=>fs.existsSync(reviews)?fs.readFileSync(reviews,'utf8'):null;
 return {
  async get(key){if(key!==OWNER_REVIEWS_KEY)return null;const text=read();return text==null?null:{etag:etagOf(text),json:async()=>JSON.parse(text),text:async()=>text};},
  async head(key){if(key!==OWNER_REVIEWS_KEY)return null;const text=read();return text==null?null:{etag:etagOf(text)};},
  async put(key,body,options={}){
   if(key!==OWNER_REVIEWS_KEY)return null;
   const text=String(body),current=read(),only=options.onlyIf;
   if(only?.etagMatches!==undefined&&(current==null||etagOf(current)!==only.etagMatches))return null;
   if(only?.etagDoesNotMatch!==undefined&&current!=null&&(only.etagDoesNotMatch==='*'||etagOf(current)===only.etagDoesNotMatch))return null;
   fs.writeFileSync(reviews,text);
   return {etag:etagOf(text)};
  },
 };
}
const status=await readAuthority(db);
if(!load&&!activate&&!revert){console.log(JSON.stringify({...status,writes:false}));process.exit(0);}
const store=bucket();
const result=load?await importOwnerReviews(db,store,{confirm}):activate?await activateOwnerReviews(db,store,{confirm}):await revertOwnerReviews(db,store,{confirm});
console.log(JSON.stringify(result));
