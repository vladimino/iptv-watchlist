// AIR-132 / ADR 0178: migration 0027 widens discovery_intent.kind to identity_revoke and loses nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-intent-0027-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{}});
const run=(file,text)=>sqliteSync(['-bail',file],{input:text,encoding:'utf8',maxBuffer:1<<26});
const rows=(file,text)=>{const r=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):[];};
const files=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const read=name=>fs.readFileSync('migrations/'+name,'utf8');
const last=files.at(-1);
assert.equal(last,'0027_discovery_intent_identity_revoke.sql');
const before=files.slice(0,-1);
const base=path.join(root,'v26.sqlite');
assert.equal(run(base,before.map(read).join('\n')).status,0);
assert.equal(rows(base,'SELECT version FROM schema_contract WHERE id=1')[0].version,26);
const seed="INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key,before_json,receipt_json,issued_json,command_json,expected_hash,expires_at,generation) VALUES "
 +"('k-assign-0000000001','identity_assign','receipt','obs:a','{\"s\":1}','{\"state\":\"applied\"}','{\"i\":1}','{\"effect\":\"assign\",\"tmdbId\":\"1\"}','h1',1700000000000,7),"
 +"('k-reject-0000000001','identity_reject','approved','obs:b',NULL,NULL,'{\"i\":2}','{\"effect\":\"reject\",\"tmdbId\":\"2\"}','h2',1700000000001,8),"
 +"('k-recons-0000000001','reconsider','running','obs:c',NULL,NULL,NULL,NULL,NULL,NULL,NULL);";
assert.equal(run(base,seed).status,0);
assert.notEqual(run(base,"INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key) VALUES ('k-revoke-0000000001','identity_revoke','approved','obs:a');").status,0,'0026 refuses the new kind');
const snapshot=rows(base,'SELECT * FROM discovery_intent ORDER BY idempotency_key');

const file=path.join(root,'v27.sqlite');
fs.copyFileSync(base,file);
assert.equal(run(file,read(last)).status,0);
assert.equal(rows(file,'SELECT version FROM schema_contract WHERE id=1')[0].version,27);
assert.deepEqual(rows(file,'SELECT * FROM discovery_intent ORDER BY idempotency_key'),snapshot,'every row is copied unchanged');
assert.equal(run(file,"INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key) VALUES ('k-revoke-0000000001','identity_revoke','approved','obs:a');").status,0,'the new kind is accepted');
assert.notEqual(run(file,"INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key) VALUES ('k-bad-00000000001','identity_other','approved','obs:a');").status,0,'an unknown kind is refused');
assert.notEqual(run(file,"INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key) VALUES ('k-assign-0000000001','identity_assign','approved','obs:a');").status,0,'the primary key still holds');
assert.notEqual(run(file,"INSERT INTO discovery_intent (idempotency_key,kind,state,observation_key) VALUES ('k-state-0000000001','identity_assign','done','obs:a');").status,0,'the state CHECK still holds');
assert.equal(rows(file,"SELECT sql FROM sqlite_master WHERE name='discovery_intent'")[0].sql.includes('STRICT'),true,'the table stays STRICT');
assert.deepEqual(rows(file,"SELECT name FROM sqlite_master WHERE name LIKE 'discovery_intent%'").map(r=>r.name),['discovery_intent'],'no leftover table');
assert.equal(rows(file,'SELECT COUNT(*) AS n FROM discovery_decision_history')[0].n,0);
assert.notEqual(run(file,"UPDATE schema_contract SET version=26 WHERE id=1;").status,0,'the version never goes down');

const replay=path.join(root,'again.sqlite');
fs.copyFileSync(file,replay);
assert.notEqual(run(replay,read(last)).status,0,'0027 refuses a second apply');
const old=path.join(root,'v25.sqlite');
assert.equal(run(old,before.slice(0,-1).map(read).join('\n')).status,0);
assert.notEqual(run(old,read(last)).status,0,'0027 refuses anything but a complete version 26');
assert.deepEqual(rows(old,"SELECT sql FROM sqlite_master WHERE name='discovery_intent'").length,1);
console.log('discovery-intent-migration-0027 ok');
