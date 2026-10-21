import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {manifestFor} from '../scripts/migration-export.mjs';
import {personOverridesFromSource} from '../scripts/lifecycle-parity.mjs';

const fileId=key=>createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex');
const marker='zz-marker';
const visible='VISIBLE TITLE';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-lifecycle-'));

function writeSnapshot(directory,bodies,mutate){
 fs.rmSync(directory,{recursive:true,force:true});
 const objects=path.join(directory,'objects');
 fs.mkdirSync(objects,{recursive:true});
 const entries=Object.entries(bodies).map(([key,value])=>{
  const bytes=Buffer.from(JSON.stringify(value),'utf8');
  const name=fileId(key)+'.bin';
  fs.writeFileSync(path.join(objects,name),bytes);
  return {key,file:'objects/'+name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),metadata:{size:bytes.length}};
 });
 const manifest=manifestFor(entries,1,'2026-10-19T00:00:00.000Z','2026-10-19T01:00:00.000Z',[]);
 if(mutate)mutate(directory,manifest);
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
 return manifest;
}
function run(directory,extra=[]){
 return spawnSync(process.execPath,['scripts/lifecycle-parity.mjs','--snapshot',directory,...extra],{encoding:'utf8'});
}
const bodies={
 'programme.json':{films:[{id:marker,title:visible,original:'Original Title',actors:[{id:'actor/chris-pratt',name:'Stored Other',original:'Stored Other'}],directors:[]}],people:{actors:[],directors:[]}},
 'watchlist.json':{films:[{id:marker,title:visible,original:'Original Title'}]}
};
const directory=path.join(root,'ok');
writeSnapshot(directory,bodies);
const before=fs.readFileSync(path.join(directory,'manifest.json'));
const first=run(directory);
assert.equal(first.status,0,first.stderr);
assert.equal(fs.readFileSync(path.join(directory,'manifest.json')).equals(before),true);
assert.equal(first.stdout.includes(marker),false);
assert.equal(first.stdout.includes(visible),false);
const second=run(directory);
assert.equal(second.stdout,first.stdout);
const report=JSON.parse(first.stdout);
assert.equal(report.writes,0);
assert.equal(report.manifest.objects,2);
assert.equal(report.films.legacy,1);
assert.equal(report.films.lifecycle,1);
assert.equal(report.people.ok,true);
assert.equal(report.reconciliation.create>0,true);
assert.equal(report.reconciliation.conflict,0);
const overridden=run(directory,['--as-of','2026-10-19T01:00:00.000Z']);
assert.equal(overridden.stdout,first.stdout);

const source=fs.readFileSync('src/sources.js','utf8');
const overrides=personOverridesFromSource(source);
assert.match(source,/REVIEWED_PEOPLE\['actor\/chris-pratt'\]=/);
const domain=fs.readFileSync('src/domain/film-person.js','utf8');
const reader=fs.readFileSync('src/domain/film-person-reader.js','utf8');
const backfill=fs.readFileSync('src/domain/film-person-backfill.js','utf8');
const context=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={backfillLifecycle};',context);
const reviewed=context.api.backfillLifecycle({programme:bodies['programme.json'],watchlist:bodies['watchlist.json'],filmTitles:[],personNames:[],personOverrides:overrides},Date.parse('2026-10-19T01:00:00.000Z'));
const person=reviewed.sidecars['people.lifecycle.json']['actor/chris-pratt'];
assert.equal(person.localization.status,'reviewed');
assert.equal(person.localization.value,overrides['actor/chris-pratt'].name);
assert.equal(person.localization.value==='Stored Other',false);

function refuse(name,mutate){
 const dir=path.join(root,name);
 writeSnapshot(dir,bodies,mutate);
 const result=run(dir);
 assert.notEqual(result.status,0,name);
 assert.equal(result.stdout.includes(marker),false,name);
 assert.equal(result.stderr.includes(marker),false,name);
 assert.equal(result.stderr.includes(visible),false,name);
 assert.equal(result.stderr.includes('Stored Other'),false,name);
 return result;
}
const truncated=refuse('truncated',(_dir,manifest)=>{manifest.objects=manifest.objects.slice(0,-1);});
assert.match(truncated.stderr,/Manifest totals mismatch/);
const tampered=refuse('tampered',dir=>{
 const file=fs.readdirSync(path.join(dir,'objects'))[0];
 const target=path.join(dir,'objects',file);
 const bytes=fs.readFileSync(target);
 bytes[0]=bytes[0]^0xff;
 fs.writeFileSync(target,bytes);
});
assert.match(tampered.stderr,/Snapshot checksum or size mismatch/);
const changed=refuse('changed',(_dir,manifest)=>{manifest.changes=[{reason:'added_after'}];manifest.status='provisional_no_change_detected';});
assert.match(changed.stderr,/Snapshot recorded listing changes/);
const foreign=refuse('foreign',(_dir,manifest)=>{manifest.sourceSiteId='other-site';});
assert.match(foreign.stderr,/Snapshot source identity does not match the exporter/);
assert.equal(foreign.stderr.includes('other-site'),false);

const refused=spawnSync(process.execPath,['scripts/lifecycle-parity.mjs','--snapshot',process.cwd()],{encoding:'utf8'});
assert.equal(refused.status,2);
fs.rmSync(root,{recursive:true});
console.log('Lifecycle parity snapshot runner passed.');
