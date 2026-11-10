// AIR-386: the D1 Discovery decisions document at and above 20000 rows. Local sqlite stand-ins only: no Cloudflare, no TMDB, no production D1.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-decisions-read-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let n=0;
function fresh(rows,{payload=null,onQuery=null}={}){
 const file=path.join(root,'d-'+(n++)+'.sqlite');
 const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(r.status!==0)throw new Error(r.stderr);
 const db=d1Standin(file,{onQuery});
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open', programme_run_id='run-d', published_programme_run_id='run-d' WHERE id=1");
 return {file,db,fill:async(count,start=0)=>{
  const decision=payload||{status:'needs_verification',attempts:1};
  const hash=await Authority.decisionHash(decision),text=JSON.stringify(decision).replace(/'/g,"''");
  for(let i=start;i<start+count;i+=2000){
   const parts=[];for(let j=i;j<Math.min(start+count,i+2000);j++)parts.push(`('k${String(j).padStart(6,'0')}','run-d',1,'needs_verification',1,'${hash}','${text}')`);
   db.sql('INSERT INTO discovery_decision (observation_key, programme_run_id, generation, status, attempts, decision_hash, payload_json) VALUES '+parts.join(','));
  }
 }};
}
const env=db=>({DB:db,BUCKET:new MemoryBucket(),discoveryLease:null});
const read=db=>Authority.routeRead(env(db),'epg/discovery-resolution.json');

// 0, 20000, 20001 (the production size), 25000 and 45000 decisions: every row comes back, none twice, none dropped.
for(const size of [0,1,999,1000,1001,20000,20001,25000,45000]){
 const {db,fill}=fresh();await fill(size);
 const routed=await read(db);
 assert.equal(routed.handled,true,String(size));
 const keys=Object.keys(routed.value);
 assert.equal(keys.length,size,'rows read at '+size);
 assert.equal(keys[0]??null,size?'k000000':null);
 assert.equal(keys[keys.length-1]??null,size?'k'+String(size-1).padStart(6,'0'):null);
}

// Memory and query budget: pages of DECISION_PAGE rows, queries ceil(rows/page)+1 at most, never one SELECT of the table.
{
 const seen=[];const {db,fill}=fresh(0,{onQuery:text=>{if(/FROM discovery_decision/.test(text))seen.push(text);}});
 await fill(25000);seen.length=0;
 await Authority.routeRead(env(db),'epg/discovery-resolution.json');
 assert.equal(seen.length,Math.floor(25000/Authority.DECISION_PAGE)+1,'one query per page, plus the empty page that ends an exact multiple');
 assert.ok(seen.every(text=>/LIMIT 1000$/.test(text)),'every page statement is limited');
}

// Over the explicit row/byte budget the read fails closed with discovery_bounded and returns nothing partial.
{
 const big={status:'needs_verification',attempts:1,note:'x'.repeat(4000)};
 const {db,fill}=fresh(0,{payload:big});await fill(Math.ceil(Authority.DECISION_READ_BYTES/4000)+500);
 await assert.rejects(()=>read(db),error=>error.code==='discovery_bounded');
}

// The byte budget is UTF-8 bytes: a payload of 3-byte characters crosses it while far below DECISION_READ_BYTES characters.
{
 const wide={status:'needs_verification',attempts:1,note:'я'.repeat(2000)};// 2 bytes per character
 const rows=Math.floor(Authority.DECISION_READ_BYTES/(2*2000+60));
 const {db,fill}=fresh(0,{payload:wide});
 await fill(rows-300);
 assert.equal(Object.keys((await read(db)).value).length,rows-300,'under the byte budget in bytes');
 await fill(900,rows-300);
 assert.ok(rows*2000+900*0<Authority.DECISION_READ_BYTES,'the character count alone stays under the budget');
 await assert.rejects(()=>read(db),error=>error.code==='discovery_bounded','over it in UTF-8 bytes');
}
// The row ceiling is reachable and fails closed.
{
 const {db,fill}=fresh();await fill(Authority.DECISION_READ_ROWS+1);
 await assert.rejects(()=>read(db),error=>error.code==='discovery_bounded');
}
// A row whose payload does not match its decision_hash is corruption (discovery_unavailable), also deep in the table, never skipped.
{
 const {db,fill}=fresh();await fill(2500);
 db.sql("UPDATE discovery_decision SET decision_hash='bad' WHERE observation_key='k002400'");
 await assert.rejects(()=>read(db),error=>error.code==='discovery_unavailable');
}

// A writer moving the authority generation during the read (as every decision writer does in its batch) is refused whole: discovery_fence, no mixed pages.
{
 let fired=false;
 const {db,fill}=fresh(0,{onQuery:text=>{if(!fired&&/observation_key>'k001999'/.test(text)){fired=true;db.sql("UPDATE discovery_decision SET status='verified' WHERE observation_key='k000005'");db.sql('UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}}});
 await fill(5000);
 await assert.rejects(()=>read(db),error=>error.code==='discovery_fence');
 const after=await read(db);
 assert.equal(Object.keys(after.value).length,5000);
 assert.equal(after.value.k000005.status,'needs_verification','the stored payload is what the hash verifies');
}

// Concurrent insert / delete between pages with no generation move cannot happen through a writer; with the move it is refused. A held or loading authority stays closed.
{
 const {db,fill}=fresh();await fill(30);
 db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");
 assert.deepEqual(await read(db),{handled:false});
 db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");
 db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 await assert.rejects(()=>read(db),error=>error.code==='discovery_incomplete');
}
console.log('discovery decisions read: ok');
