// AIR-570 / ADR 0186 (review). The Letterboxd mode-epoch fence INSIDE the canonical writers' own batches: the `letterboxd` producer fence. A batch that carries it commits only while the executor mode is still
// `cloudflare` at the step's epoch; once the mode moved the whole batch aborts and ZERO statements of it apply. Offline on sqlite with the real SQL of the fence module. No network, no Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {sqliteSync} from './sqlite-session.mjs';
import {d1Standin} from './d1-standin.mjs';
import {FENCE_KINDS,requireFence,fenceStatements,letterboxdEpochSql} from '../src/canonical-producer-fence.js';

const root=fs.mkdtempSync(path.join(process.env.TMPDIR||os.tmpdir(),'iptv-lbfence-'));
process.on('exit',()=>{try{fs.rmSync(root,{recursive:true,force:true});}catch{/* best effort */}});
const file=path.join(root,'t.sqlite');
const sql=text=>{const r=sqliteSync(['-bail',file],{input:text});if(r.status!==0)throw new Error(r.stderr);};
sql(`
CREATE TABLE film_person_cas (id INTEGER PRIMARY KEY CHECK (id = 1), ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO film_person_cas VALUES (1,1);
CREATE TABLE letterboxd_sync_mode (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, epoch INTEGER NOT NULL);
CREATE TABLE canonical_write (k TEXT PRIMARY KEY, v TEXT);`);
const db=d1Standin(file);
const run=async(fence,key)=>db.batch([...fenceStatements(fence).map(([text,params])=>db.prepare(text).bind(...params)),db.prepare('INSERT INTO canonical_write (k,v) VALUES (?,?)').bind(key,'x')]);
const rows=()=>db.sql('SELECT k FROM canonical_write ORDER BY k').map(r=>r.k);

// 1. The kind exists, is validated and is the only one that reads the Letterboxd mode.
assert.ok(FENCE_KINDS.includes('letterboxd'));
assert.deepEqual(requireFence({kind:'letterboxd',epoch:3}),{kind:'letterboxd',epoch:3});
for(const bad of [{kind:'letterboxd'},{kind:'letterboxd',epoch:-1},{kind:'letterboxd',epoch:'3'},{kind:'letterboxd',epoch:1.5}])assert.throws(()=>requireFence(bad),e=>e.code==='producer_fence_missing');
assert.match(letterboxdEpochSql(),/letterboxd_sync_mode/);
assert.equal(fenceStatements({kind:'chain',programmeRunId:'p',inputGeneration:1,epoch:1,nonce:'n'}).length,1,'the existing kinds are unchanged');
assert.deepEqual(fenceStatements({kind:'dictionary'}),[]);

// 2. The mode is cloudflare at epoch 4: the batch commits.
sql("INSERT INTO letterboxd_sync_mode VALUES (1,'cloudflare',4);");
await run({kind:'letterboxd',epoch:4},'committed-at-4');assert.deepEqual(rows(),['committed-at-4']);
// 3. The mode moves (close admission: switching, epoch 5) while a step is in flight: the same batch from epoch 4 aborts and applies ZERO statements.
sql("UPDATE letterboxd_sync_mode SET mode='switching', epoch=5;");
await assert.rejects(()=>run({kind:'letterboxd',epoch:4},'stale-after-flip'),/CHECK constraint failed|film_person_cas/);
assert.deepEqual(rows(),['committed-at-4'],'no statement of the stale batch applied');
// 4. A switching mode at the right epoch is still refused (only `cloudflare` admits a writer); the new epoch after completion admits only the new owner.
await assert.rejects(()=>run({kind:'letterboxd',epoch:5},'switching-epoch-5'));
sql("UPDATE letterboxd_sync_mode SET mode='cloudflare', epoch=5;");
await assert.rejects(()=>run({kind:'letterboxd',epoch:4},'old-owner'),'the old epoch stays refused');
await run({kind:'letterboxd',epoch:5},'new-owner');assert.deepEqual(rows(),['committed-at-4','new-owner']);
// 5. Rolled back to external: nothing commits at any epoch.
sql("UPDATE letterboxd_sync_mode SET mode='external', epoch=6;");
for(const epoch of [4,5,6])await assert.rejects(()=>run({kind:'letterboxd',epoch},'external-'+epoch));
assert.deepEqual(rows(),['committed-at-4','new-owner']);
// 6. No mode row at all (dormant): refused, never admitted.
sql("DELETE FROM letterboxd_sync_mode;");await assert.rejects(()=>run({kind:'letterboxd',epoch:0},'no-row'));
console.log('letterboxd-sync-fence ok');
