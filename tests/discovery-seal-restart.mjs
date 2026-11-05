// ADR 0092: an unfinished ledger seal is durable state. A new epg_sync_start must neither replace the run that names it
// (whatever its age) nor start a run that cannot continue the D1 job. Local sqlite stand-in; nothing calls production.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import * as Authority from '../src/discovery-authority.js';
import {loadWorker} from '../scripts/discovery-ledger-offline.mjs';
import {d1Standin} from './d1-standin.mjs';

const context=loadWorker();
context.DiscoveryAuthority=Authority;
context.PublishedEpg={async readAuthority(){return {cutover:'open',mode:'d1'};}};
const call=code=>vm.runInContext(code,context);
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority','0012_discovery_seal'];
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-seal-restart-'));
const sql=(file,text)=>{const r=spawnSync('sqlite3',['-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);};
const database=()=>{const file=path.join(root,'r-'+Math.random().toString(36).slice(2)+'.sqlite');sql(file,'PRAGMA foreign_keys=ON;\n'+chain.map(x=>fs.readFileSync('migrations/'+x+'.sql','utf8')).join('\n'));sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");return file;};
const bucket=files=>({async get(key){return files[key]===undefined?null:{etag:'e',json:async()=>JSON.parse(files[key]),text:async()=>files[key]};},async put(key,value){files[key]=String(value);return {etag:'e'};}});

// 1. A seal run older than the 15 minute freshness window is still returned by its runId and is not replaced.
{
 const file=database();
 const old=new Date(Date.now()-3*3600000).toISOString();
 const files={'sync.json':JSON.stringify({runId:'run-seal',stage:'seal',updatedAt:old,seal:{phase:'ledger'}})};
 const env={DB:d1Standin(file),BUCKET:bucket(files),discoveryLease:null};
 const result=await context.beginSync(env);
 assert.equal(result.runId,'run-seal');assert.equal(result.stage,'seal');
 assert.equal(JSON.parse(files['sync.json']).runId,'run-seal','sync.json was not rewritten');
}

// 2. A D1 job in `items` that sync.json does not name refuses the start, writes nothing and resets nothing.
for(const phase of ['items','archive']){
 const file=database();
 sql(file,`UPDATE discovery_seal SET job_id='job-x', programme_run_id='run-x', phase='${phase}', updated_at=1 WHERE id=1`);
 const files={'sync.json':JSON.stringify({runId:'run-other',stage:'complete',updatedAt:new Date(Date.now()-3*3600000).toISOString()})};
 const env={DB:d1Standin(file),BUCKET:bucket(files),discoveryLease:null};
 await assert.rejects(()=>context.beginSync(env),error=>error.code==='discovery_seal_unfinished');
 assert.equal(JSON.parse(files['sync.json']).runId,'run-other');
 const check=spawnSync('sqlite3',[file,'SELECT phase FROM discovery_seal'],{encoding:'utf8'});
 assert.equal(check.stdout.trim(),phase,'the job is not reset');
}
console.log('discovery seal restart ok');
