import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {historicalEvidenceOutput} from '../scripts/air-86-replay.mjs';

const samples=[
 {
  path:'docs/evidence/scored-resolver/air-86-replay-manifest.json',
  sha256:'38f86f7475a7559861f806853440f13a888f061935d9c284d342a3d7428740a5',
 },
 {
  path:'docs/evidence/scored-resolver/air-86-replay-results.json',
  sha256:'5c4d268d231a7fe5cdbda01d47eb212a07ff9bc4b09afdf762953caf397477b4',
 },
 {
  path:'docs/evidence/scored-resolver/air-99-detail.json',
  sha256:'a32ddb406c54939030ebeb1d46e82ea043176c2313dc5a28e6315603325c89ef',
 },
 {
  path:'docs/evidence/d1-migration/air-73-offline-run.json',
  sha256:'61dd4c396e4bf3b9ef94011aa4b60bb0599a701b53cb990a9ae6b55800c72f3e',
 },
];
const retired=[
 'docs/air-86-replay-manifest.json',
 'docs/air-86-replay-results.json',
 'docs/air-99-detail.json',
 'docs/air-73-offline-run.json',
];

for(const sample of samples){
 const bytes=fs.readFileSync(sample.path);
 assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'),sample.sha256,sample.path);
}
for(const path of retired)assert.equal(fs.existsSync(path),false,path);

const manifest=JSON.parse(fs.readFileSync(samples[0].path,'utf8'));
assert.equal(manifest.items.length,38);
assert.equal(manifest.plannedSearches,87);
assert.equal(manifest.observations,38);
assert.equal(manifest.tmdbCalls,0);
assert.equal(manifest.censusAt,'2026-10-23T17:19:42.476Z');
assert.equal(manifest.capturedAt,'2026-10-23T17:52:50.645Z');
assert.equal(manifest.programmeRunId,'cf3ba3ac-f962-4475-b9cd-3de1b07bd1eb');
assert.equal(manifest.resolutionCount,8797);
assert.equal(manifest.proposedHttpCap,130);

const results=JSON.parse(fs.readFileSync(samples[1].path,'utf8'));
assert.equal(results.rows.length,38);
assert.equal(results.now,'2026-10-23T17:52:50.645Z');
assert.equal(results.programmeRunId,manifest.programmeRunId);
assert.equal(results.cap,130);
assert.equal(results.http.total,101);
assert.equal(results.http.search,87);
assert.equal(results.http.detail,2);
assert.equal(results.http.alias,12);
assert.equal(results.diagnosticCalls,0);
assert.deepEqual(results.groups.blocked_year,{rows:28,evaluated:28,partial:0,none:0,search:56,detail:0,alias:2,accepted:0,detailVerified:0});
assert.deepEqual(results.groups.blocked_structural,{rows:2,evaluated:2,partial:0,none:0,search:7,detail:0,alias:4,accepted:0,detailVerified:0});
assert.deepEqual(results.groups.eligible_structural,{rows:8,evaluated:8,partial:0,none:0,search:24,detail:2,alias:6,accepted:2,detailVerified:2});

const detail=JSON.parse(fs.readFileSync(samples[2].path,'utf8'));
assert.equal(detail.cap,5);
assert.equal(detail.http,5);
assert.equal(detail.halted,false);
assert.equal(detail.calls.length,5);
assert.equal(detail.rows.length,5);

const offline=JSON.parse(fs.readFileSync(samples[3].path,'utf8'));
assert.equal(offline.archive.status,'provisional_no_change_detected');
assert.equal(offline.archive.aggregateSha256,'8b21c82db0cf8580250f1d8c8ecd51f114eba437a48c3ec4d3b0ca41f1f39ca9');
assert.equal(offline.archive.startedAt,'2026-10-18T23:31:38.829Z');
assert.equal(offline.archive.finishedAt,'2026-10-19T00:32:22.364Z');

const replay=fs.readFileSync('scripts/air-86-replay.mjs','utf8');
const rescore=fs.readFileSync('scripts/air-97-rescore.mjs','utf8');
const detailScript=fs.readFileSync('scripts/air-99-detail.mjs','utf8');
for(const sample of samples)assert.equal(replay.includes(sample.path),true,sample.path);
assert.equal(rescore.includes(samples[0].path),true);
assert.equal(rescore.includes(samples[1].path),true);
assert.equal(fs.readFileSync('tests/air-86-replay.mjs','utf8').includes(samples[0].path),true);
assert.match(detailScript,/historicalEvidenceOutput\(process\.argv\[2\]\)/);
assert.match(replay,/historicalEvidenceOutput\(process\.argv\[2\]\)/);
assert.doesNotMatch(detailScript,/writeFileSync\(process\.argv\[2\]\|\|/);
assert.doesNotMatch(replay,/writeFileSync\(process\.argv\[2\]\|\|/);

function runScript(script,args){
 return spawnSync(process.execPath,[script,...args],{
  encoding:'utf8',
  env:{...process.env,TMDB_API_READ_ACCESS_TOKEN:'offline-test'},
 });
}
const commands=['scripts/air-86-replay.mjs','scripts/air-99-detail.mjs'];
for(const script of commands){
 const missing=runScript(script,[]);
 assert.equal(missing.status,2,script);
 assert.match(missing.stderr,/output path is required/);
 assert.equal(missing.stdout,'');
}
const protectedPaths=[
 samples[0].path,
 path.resolve(samples[1].path),
 'docs/evidence/d1-migration/../scored-resolver/air-86-replay-results.json',
 'docs/evidence/scored-resolver/../d1-migration/air-73-offline-run.json',
 samples[2].path,
 samples[3].path,
];
const before=new Map(samples.map(sample=>[sample.path,fs.readFileSync(sample.path)]));
for(const script of commands){
 for(const target of protectedPaths){
  const refused=runScript(script,[target]);
  assert.equal(refused.status,2,`${script} ${target}`);
  assert.match(refused.stderr,/refusing to overwrite historical evidence/);
  assert.equal(refused.stdout,'');
 }
}
for(const [file,bytes] of before)assert.equal(fs.readFileSync(file).equals(bytes),true,file);
if(process.platform!=='linux')assert.equal(historicalEvidenceOutput(samples[2].path.replace('air-99-detail.json','AIR-99-DETAIL.json')).ok,false);

const link=path.join(os.tmpdir(),`air115-evidence-${process.pid}.json`);
try{
 fs.symlinkSync(path.resolve(samples[2].path),link);
 for(const script of commands){
  const refused=runScript(script,[link]);
  assert.equal(refused.status,2,`${script} symlink`);
  assert.match(refused.stderr,/refusing to overwrite historical evidence/);
  assert.equal(refused.stdout,'');
 }
}finally{
 fs.rmSync(link,{force:true});
}

console.log('Evidence JSON paths passed');
