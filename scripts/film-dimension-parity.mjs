// AIR-660 / ADR 0218 stage 1: the offline Film dimension parity report over a PRIVATE SQLite copy of the D1 database. It opens the file with
// `sqlite3 -readonly`, pages through every Film with src/film-dimension-parity.js and prints one JSON report: counts per dimension and class,
// reasons, proof, statements and rows returned. No network, no D1 binding, no R2, no write: the copy is opened read-only and every statement is
// checked to be a SELECT before it runs. Ids and values are printed only with --detail, and then only to stdout (keep that output private).
//
//   node scripts/film-dimension-parity.mjs --d1-sqlite /private/copy.sqlite [--page 100] [--max-films 50000] [--detail]
//
// The copy is whatever the owner exported; this script does not fetch one, and a report is evidence about that copy only, not about live production.
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readDimensionParity,PARITY_PAGE_DEFAULT,PARITY_PAGE_MAX} from '../src/film-dimension-parity.js';
import {summarize} from '../src/domain/film-dimension-parity.js';

const literal=value=>value==null?'NULL':typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";
// A D1-shaped read-only binding over the sqlite3 shell: prepare().bind().all()/first(), nothing else.
export function sqliteReadOnlyBinding(file){
 const run=(sql,params)=>{
  let index=0;const text=sql.replace(/\?/g,()=>literal(params[index++]));
  const result=spawnSync('sqlite3',['-readonly','-json',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});
  if(result.status!==0)throw new Error((result.stderr||'sqlite3 failed').trim());
  const out=result.stdout.trim();return out?JSON.parse(out):[];
 };
 const statement=(sql,params)=>({async all(){return {results:run(sql,params)};},async first(){return run(sql,params)[0]??null;}});
 return {prepare(sql){return {bind(...params){return statement(sql,params);},all(){return statement(sql,[]).all();},first(){return statement(sql,[]).first();}};}};
}

export async function parityReport(env,{page=PARITY_PAGE_DEFAULT,maxFilms=50000,detail=false}={}){
 const classified=[],markers=new Set();
 let after='',films=0,statements=0,rows=0,pages=0,truncated=false;
 for(;;){
  const result=await readDimensionParity(env,{after,limit:page});
  pages++;films+=result.films;statements+=result.cost.statements;rows+=result.cost.rowsReturned;markers.add(JSON.stringify(result.markers));
  classified.push(...result.classified);
  if(!result.next)break;
  if(films>=maxFilms){truncated=true;break;}
  after=result.next;
 }
 return {writes:0,films,pages,truncated,markers:[...markers].map(item=>JSON.parse(item)),summary:summarize(classified),cost:{statements,rowsReturned:rows,rowsWritten:0},...(detail?{rows:classified}:{})};
}

async function main(argv){
 const value=name=>{const at=argv.indexOf(name);return at>=0?argv[at+1]:undefined;};
 const file=value('--d1-sqlite');
 if(!file){console.error('Usage: node scripts/film-dimension-parity.mjs --d1-sqlite /private/copy.sqlite [--page N] [--max-films N] [--detail]');process.exit(2);}
 if(!path.isAbsolute(file)||!fs.existsSync(file)){console.error('The copy must be an existing absolute path.');process.exit(2);}
 const page=Number(value('--page')||PARITY_PAGE_DEFAULT),maxFilms=Number(value('--max-films')||50000);
 if(!Number.isInteger(page)||page<1||page>PARITY_PAGE_MAX||!Number.isInteger(maxFilms)||maxFilms<1){console.error('--page must be 1..'+PARITY_PAGE_MAX+' and --max-films a positive integer.');process.exit(2);}
 const report=await parityReport({DB:sqliteReadOnlyBinding(file)},{page,maxFilms,detail:argv.includes('--detail')});
 console.log(JSON.stringify(report,null,1));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main(process.argv.slice(2)).catch(error=>{console.error('Parity report failed: '+(error.code||error.message));process.exit(1);});
}
