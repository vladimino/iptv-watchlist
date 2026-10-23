import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {manifestFor} from '../scripts/migration-export.mjs';

const fileId=key=>createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-diagnostics-'));
const filmId='zz-film';
const roleId='actor/zz-role';
const title='VISIBLE TITLE';
const payload='payload-secret';
const mechanics='plotMechanics-secret';
const history='history-secret';
const fresh='2026-10-18T00:00:00.000Z';

function writeSnapshot(directory,bodies){
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
 fs.writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));
}
function filesOf(directory){
 const out=[];
 const walk=dir=>{for(const name of fs.readdirSync(dir)){const full=path.join(dir,name);if(fs.statSync(full).isDirectory())walk(full);else out.push(full+'\0'+fs.readFileSync(full).toString('hex'));}};
 walk(directory);
 return out.sort().join('\n');
}
function run(directory,args){
 return spawnSync(process.execPath,['scripts/lifecycle-diagnostics.mjs','--snapshot',directory,...args],{encoding:'utf8'});
}
function report(result){
 assert.equal(result.status,0,result.stderr);
 return JSON.parse(result.stdout);
}
const film={id:filmId,title,original:'Original Title',tmdbId:'9001',metadataAt:fresh,actors:[{id:roleId,name:'Stored Name',original:'Stored Name'}],directors:[]};
const linked={
 'programme.json':{films:[film],people:{actors:[],directors:[]}},
 'watchlist.json':{films:[film]},
 'metadata.json':{[filmId]:{id:filmId,tmdbId:'9001',original:'Original Title',metadataAt:fresh,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:fresh,directors:[],actors:[{id:roleId,name:'Stored Name',original:'Stored Name'}]}},
 'epg/discovered-films.json':{tmdb_9001:{id:'tmdb_9001',tmdbId:'9001',title,original:'Original Title',discoveredAt:fresh,synopsis:'Overview',directors:[],actors:[]}},
 ['enrichment/films/'+filmId+'/fingerprint.json']:{fingerprintSchemaVersion:1,invalidatedAt:null,generatedAt:fresh,fingerprintHash:'print-a',plotMechanics:[mechanics]},
 ['enrichment/films/'+filmId+'/predictions.json']:{current:{tasteProfileVersion:1,tasteProfileHash:'profile-a',fingerprintHash:'print-a',fingerprintSchemaVersion:1,predictionPromptVersion:1,predictedRating:4},history:[{note:history}]}
};
const linkedDir=path.join(root,'linked');
writeSnapshot(linkedDir,linked);
const before=filesOf(linkedDir);
const summary=report(run(linkedDir,['--summary']));
assert.equal(filesOf(linkedDir),before);
assert.equal(summary.writes,0);
assert.equal(summary.scope,'historical-snapshot');
assert.equal(summary.production,false);
assert.equal(summary.snapshotFinishedAt,'2026-10-19T01:00:00.000Z');
assert.match(summary.note,/19 October 2026/);
assert.match(summary.note,/not current production counts/);
assert.equal(summary.films.total>=1,true);
assert.equal(typeof summary.films.nextAction,'object');
assert.equal(typeof summary.films.displayReady,'number');
assert.equal(typeof summary.parity.missing,'number');
assert.equal(typeof summary.parity.extra,'number');
assert.equal(typeof summary.parity.mismatches,'number');
assert.equal(typeof summary.conflicts,'number');
for(const secret of [filmId,'tmdb_9001',roleId,title,payload,mechanics,history,'predictedRating'])assert.equal(summary.stdout?false:JSON.stringify(summary).includes(secret),false,secret);
const again=run(linkedDir,['--summary','--as-of','2026-10-19T01:00:00.000Z']);
const repeated=run(linkedDir,['--summary','--as-of','2026-10-19T01:00:00.000Z']);
assert.equal(again.stdout,repeated.stdout);
assert.equal(filesOf(linkedDir),before);
const stored=report(run(linkedDir,['--film','tmdb_9001','--as-of','2026-10-19T01:00:00.000Z']));
const former=report(run(linkedDir,['--film','film:tmdb:9001','--as-of','2026-10-19T01:00:00.000Z']));
assert.equal(stored.found,true);
assert.equal(stored.id,'film:'+filmId);
assert.equal(stored.canonicalIdentity,'tmdb:9001');
assert.equal(JSON.stringify(stored),JSON.stringify(former));
assert.equal(stored.externalIds.some(item=>item.scheme==='tmdb'&&item.value==='9001'),true);
assert.equal(Array.isArray(stored.aliases),true);
assert.equal(Array.isArray(stored.localizationConflicts),true);
assert.equal(stored.dimensions.metadata.status,'fresh');
assert.equal(stored.dimensions.identity.nextAction!=null,true);
assert.equal(Object.hasOwn(stored,'predictionHistory'),false);
for(const secret of [payload,mechanics,history,'predictedRating'])assert.equal(JSON.stringify(stored).includes(secret),false,secret);
const later=report(run(linkedDir,['--film',filmId,'--as-of','2026-12-19T01:00:00.000Z']));
assert.equal(later.dimensions.metadata.status,'stale');
assert.equal(later.asOf,'2026-12-19T01:00:00.000Z');
const person=report(run(linkedDir,['--person',roleId]));
assert.equal(person.found,true);
assert.equal(person.kind,'person');
assert.equal(person.externalIds.some(item=>item.value===roleId),true);
assert.equal(person.dimensions.localization.nextAction!=null,true);
assert.equal(Object.hasOwn(person,'predictionHistory'),false);
const missing=report(run(linkedDir,['--film','missing-id']));
assert.equal(missing.found,false);
assert.equal(missing.id,'missing-id');
assert.equal(JSON.stringify(missing).includes(filmId),false);
assert.equal(JSON.stringify(missing).includes(title),false);

const ambiguous={
 'programme.json':{films:[{id:filmId,tmdbId:'9001',original:'Original Title',title}]},
 'watchlist.json':{films:[{id:filmId,original:'Original Title',title}]},
 'metadata.json':{[filmId]:{tmdbId:'9001',metadataAt:fresh,peopleVersion:1,peopleNamesVersion:2,synopsis:'Text',synopsisFetchedAt:fresh}},
 'epg/discovered-films.json':{tmdb_9001:{id:'tmdb_9001',tmdbId:'9001',original:'Original Title',title,discoveredAt:fresh,synopsis:'Overview'}},
 'epg/discovery-resolution.json':{'heat|1995':{status:'ambiguous',tmdbId:'9001',filmId:'tmdb_9001',retryAt:'2026-10-20T01:00:00.000Z'}}
};
const ambiguousDir=path.join(root,'ambiguous');
writeSnapshot(ambiguousDir,ambiguous);
const splitStored=report(run(ambiguousDir,['--film','tmdb_9001','--as-of','2026-10-19T01:00:00.000Z']));
const splitLifecycle=report(run(ambiguousDir,['--film','film:tmdb:9001','--as-of','2026-10-19T01:00:00.000Z']));
const splitLetterboxd=report(run(ambiguousDir,['--film',filmId,'--as-of','2026-10-19T01:00:00.000Z']));
assert.equal(splitStored.id,'film:tmdb:9001');
assert.equal(splitStored.dimensions.identity.status,'ambiguous');
assert.equal(JSON.stringify(splitStored),JSON.stringify(splitLifecycle));
assert.equal(splitLetterboxd.id,'film:'+filmId);
assert.notEqual(splitLetterboxd.id,splitStored.id);
const splitSummary=report(run(ambiguousDir,['--summary']));
assert.equal(splitSummary.production,false);
assert.equal(JSON.stringify(splitSummary).includes(filmId),false);
assert.equal(JSON.stringify(splitSummary).includes('tmdb_9001'),false);

for(const file of ['build.mjs','src/worker.js','src/discovery.js','src/enrichment.js','src/sources.js','src/mcp.js','src/continuation.js'])assert.doesNotMatch(fs.readFileSync(file,'utf8'),/lifecycle-diagnostics|presentDiagnosis/,file);
const refused=spawnSync(process.execPath,['scripts/lifecycle-diagnostics.mjs','--snapshot',process.cwd(),'--summary'],{encoding:'utf8'});
assert.equal(refused.status,2);
assert.equal(refused.stdout.includes(filmId),false);
fs.rmSync(root,{recursive:true});
console.log('Lifecycle diagnostics snapshot runner passed.');
