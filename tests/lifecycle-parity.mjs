import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const fileId=key=>createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-lifecycle-'));
const objects=path.join(directory,'objects');
fs.mkdirSync(objects);
const marker='zz-marker';
const visible='VISIBLE TITLE';
const bodies={
 'programme.json':{films:[{id:marker,title:visible,original:'Original Title'}],people:{actors:[],directors:[]}},
 'watchlist.json':{films:[{id:marker,title:visible,original:'Original Title'}]}
};
const entries=Object.entries(bodies).map(([key,value])=>{
 const bytes=Buffer.from(JSON.stringify(value),'utf8');
 const name=fileId(key)+'.bin';
 fs.writeFileSync(path.join(objects,name),bytes);
 return {key,file:'objects/'+name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
});
fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({schemaVersion:1,status:'provisional_no_change_detected',objects:entries}));
const before=fs.readFileSync(path.join(directory,'manifest.json'));
const run=spawnSync(process.execPath,['scripts/lifecycle-parity.mjs','--snapshot',directory],{encoding:'utf8'});
assert.equal(run.status,0,run.stderr);
assert.equal(fs.readFileSync(path.join(directory,'manifest.json')).equals(before),true);
assert.equal(run.stdout.includes(marker),false);
assert.equal(run.stdout.includes(visible),false);
const report=JSON.parse(run.stdout);
assert.equal(report.writes,0);
assert.equal(report.manifest.objects,2);
assert.equal(report.films.legacy,1);
assert.equal(report.films.lifecycle,1);
assert.equal(report.reconciliation.create>0,true);
assert.equal(report.reconciliation.conflict,0);
const refused=spawnSync(process.execPath,['scripts/lifecycle-parity.mjs','--snapshot',process.cwd()],{encoding:'utf8'});
assert.equal(refused.status,2);
fs.rmSync(directory,{recursive:true});
console.log('Lifecycle parity snapshot runner passed.');
