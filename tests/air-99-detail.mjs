import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fetchDetailCards} from '../scripts/air-99-detail.mjs';

const ids=[];
const ok=await fetchDetailCards(async path=>{ids.push(path);const id=path.match(/movie\/(\d+)/)[1];return {status:200,json:{id:Number(id),title:'x',original_title:'x',release_date:'1999-01-01',runtime:100}};});
assert.equal(ok.http,5);
assert.equal(ok.halted,false);
assert.equal(ids.length,5);
assert.deepEqual(ok.calls.map(call=>call.id),['36647','161','395','163','603']);

let haltedCalls=0;
const halted=await fetchDetailCards(async()=>{haltedCalls++;return {status:haltedCalls===1?429:200,json:{}};});
assert.equal(haltedCalls,1);
assert.equal(halted.http,1);
assert.equal(halted.halted,true);
assert.equal(halted.rows.filter(row=>row.skipped==='halted').length,4);

const missing=spawnSync(process.execPath,['scripts/air-99-detail.mjs'],{encoding:'utf8',env:{...process.env,TMDB_API_READ_ACCESS_TOKEN:''}});
assert.equal(missing.status,2);
assert.match(missing.stderr,/TMDB_API_READ_ACCESS_TOKEN is unset/);
assert.equal(missing.stdout,'');
console.log('AIR-99 detail budget passed');
