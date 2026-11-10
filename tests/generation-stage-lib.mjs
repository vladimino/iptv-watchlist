// AIR-418: the shared fixtures of the three generation-stage test files (published 1.25x, withheld 1.25x, fault matrix). One file ran all three in sequence and was
// the longest file of the suite; the sections never depended on each other's databases, so each is its own process now. Nothing here asserts; every helper
// is what the single file had, unchanged except `dump`, which compares the rows as the lines sqlite printed instead of parsing and re-serializing each row.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {StageStop} from '../src/generation-stage.js';
import {D1Error} from '../scripts/d1-backfill.mjs';
import {openSqlite as openSqliteProcess} from '../scripts/offline-import.mjs';
import {sqliteSync,sqliteRunner} from './sqlite-session.mjs';
// AIR-408: the offline-import adapter keeps one sqlite3 process per database instead of starting one per statement.
export const openSqlite=file=>openSqliteProcess(file,{runner:sqliteRunner});

// ADR-0021 implemented: a generation staged in bounded chunks and published by one commit writes exactly the final rows the
// legacy publishGeneration writes, at 1.25x the production order of magnitude, and every interruption, refusal or mismatch
// leaves the final tables as the previous commit left them.
export const sha256=text=>createHash('sha256').update(text,'utf8').digest('hex');
export const schema=fs.readFileSync('migrations/0001_schema_v1.sql','utf8')+'\n'+fs.readFileSync('migrations/0002_generation_stage.sql','utf8');
export const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-generation-stage-'));
export const FINAL=['programme_generation','published_generation','film_generation','film_show','film_epg_last_airing','candidate','candidate_generation','candidate_show'];
export const PRODUCTION={films:2300,candidates:22199},SCALED={films:2300,candidates:27749};
export const sqlite=(file,input,{json=false}={})=>sqliteSync([...(json?['-json']:[]),'-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+input,encoding:'utf8',maxBuffer:1<<30});
export const ok=(file,input)=>{const result=sqlite(file,input);assert.equal(result.status,0,result.stderr);};
export const rows=(file,sql)=>{const result=sqlite(file,sql,{json:true});assert.equal(result.status,0,result.stderr);return result.stdout.trim()?JSON.parse(result.stdout):[];};
export const one=(file,sql)=>rows(file,sql)[0];
// The rows of the final tables as sqlite printed them (JSON mode: one object per line), sorted. Two databases are equal row for row exactly when these are equal;
// parsing every row and serializing it again (650 MB over the 1.25x fixtures) added nothing to that comparison.
const rowLines=text=>{const body=text.trim();if(!body)return [];return body.slice(1,-1).split(',\n').sort();};
export const dump=file=>Object.fromEntries(FINAL.map(table=>{const result=sqlite(file,'SELECT * FROM '+table+';',{json:true});assert.equal(result.status,0,result.stderr);return [table,rowLines(result.stdout)];}));
export const filmIds=count=>Array.from({length:count},(_,index)=>'film:'+('f'+index+'-'.repeat(24)).slice(0,24));
export function database(name,{films=100,staged=true}={}){
 const file=path.join(root,name+'.sqlite');
 ok(file,staged?schema:fs.readFileSync('migrations/0001_schema_v1.sql','utf8'));
 const ids=filmIds(films);
 for(let index=0;index<ids.length;index+=500)ok(file,'INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES '+ids.slice(index,index+500).map(id=>"('"+id+"',1,NULL,'Film','2026-10-26T00:00:00.000Z')").join(',')+';');
 return file;
}
// The dry-run SQLite adapter with injected faults. A write request is buffered by the caller and sent as one sqlite3 batch;
// 'lost' drops it unsent with an uncertain-write error, 'after500' executes it and then reports an uncertain write,
// 'failLast' appends a failing last statement. Every write request is counted, so a retry would be visible. hooks[index] runs
// before write request index is sent, so another execution can act in between two requests of this one.
export function adapter(file,faults={},hooks={}){
 const base=openSqlite(file),log={writes:0,attempts:[]};
 let buffer=null;
 return {log,
  run(sql,params=[]){if(buffer){buffer.push([sql,params]);return Promise.resolve();}return base.run(sql,params);},
  get:(sql,params)=>base.get(sql,params),
  all:(sql,params)=>base.all(sql,params),
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];
   let statements;
   try{await fn();statements=buffer;}finally{buffer=null;}
   const index=log.writes++,fault=faults[index]||(typeof faults.match==='function'?faults.match(statements,index):null);
   if(hooks[index])await hooks[index]();
   log.attempts.push({index,first:statements[0]?.[0].slice(0,40),fault:fault||null});
   if(fault==='lost')throw new D1Error('write_uncertain','injected lost response');
   await base.transaction(async()=>{for(const [sql,params] of statements)await base.run(sql,params);if(fault==='failLast')await base.run('INSERT INTO stage_missing_table VALUES (1)');});
   if(fault==='after500')throw new D1Error('write_uncertain','injected HTTP 500 after commit',{status:500});
  },
 };
}
// Each context is a later execution: its clock starts a day after the previous one, past any earlier claim's expiry, so a rerun
// after an interruption takes the abandoned claim over. at() pins a time, to run two executions while a claim is live.
export const DAY=24*60*60*1000;let executions=0;
// How many execution contexts were made so far: the clock of the next one starts DAY times this.
export const executionCount=()=>executions;
export const at=offset=>()=>new Date(Date.UTC(2026,9,26,2)+offset).toISOString();
export const context=(owner='owner-a',baseline='baseline-a',{execution=executions++,nonce='nonce-'+execution,fence=1,now=at(DAY*execution)}={})=>({owner,baseline,sha256,nonce,fence,now});
export const withPrior=generation=>({...generation,candidates:generation.candidates.map((candidate,index)=>index<5?{...candidate,evidenceKey:candidate.evidenceKey+'|changed'}:candidate)});
export const seedAttempts=file=>ok(file,"UPDATE candidate SET attempts=3,last_attempt_at='2026-10-26T01:30:00.000Z',retry_at='2026-10-27T00:00:00.000Z',terminal_reason='repeated_uncertain_match' WHERE observation_key IN (SELECT observation_key FROM candidate ORDER BY observation_key LIMIT 10);");
export const stopReason=async promise=>{try{await promise;return null;}catch(error){return error instanceof StageStop?error.reason:'error:'+error.message;}};
export const cleanup=()=>fs.rmSync(root,{recursive:true,force:true});
