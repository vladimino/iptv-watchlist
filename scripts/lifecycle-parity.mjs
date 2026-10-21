// Read-only lifecycle parity for an owner-provided migration snapshot.
// It checks the manifest and prints counts. It does not write the snapshot, R2, or this repository.
// The 19 October 2026 snapshot is a historical archive, not a current copy of production.
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {verifySnapshot,ExportError,SOURCE_SITE_ID,SOURCE_ORIGIN} from './migration-export.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fileId=key=>createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex');
const fail=message=>{console.error(message);process.exit(1);};

export function personOverridesFromSource(source){
 const match=String(source).match(/REVIEWED_PEOPLE\['actor\/chris-pratt'\]=(\{[\s\S]*?\});/);
 if(!match)throw new Error('Reviewed person override is missing from sources.js');
 const value=Function(`"use strict";return (${match[1]});`)();
 if(!value||typeof value.name!=='string'||!value.name||value.nameStatus!=='verified')throw new Error('Reviewed person override is incomplete');
 return {'actor/chris-pratt':value};
}

async function main(){
 const snapshotAt=process.argv.indexOf('--snapshot');
 const requested=snapshotAt>=0?process.argv[snapshotAt+1]:'';
 if(!requested){console.error('Usage: node scripts/lifecycle-parity.mjs --snapshot /absolute/private/snapshot-directory [--as-of ISO-timestamp]');process.exit(2);}
 const directory=path.resolve(requested);
 if(directory===root||directory.startsWith(root+path.sep)){console.error('Snapshot directory must be outside the Git repository');process.exit(2);}
 let manifest;
 try{manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));}
 catch{fail('Manifest is not JSON');}
 if(!manifest||manifest.schemaVersion!==1)fail('Manifest schema is not 1');
 if(manifest.status!=='provisional_no_change_detected')fail('Snapshot is not a complete provisional export');
 if(!Array.isArray(manifest.changes)||manifest.changes.length!==0)fail('Snapshot recorded listing changes');
 if(manifest.sourceSiteId!==SOURCE_SITE_ID||manifest.sourceOrigin!==SOURCE_ORIGIN)fail('Snapshot source identity does not match the exporter');
 const asOfAt=process.argv.indexOf('--as-of');
 const clockSource=asOfAt>=0?process.argv[asOfAt+1]:manifest.finishedAt;
 const now=Date.parse(clockSource||'');
 if(!Number.isFinite(now))fail('Snapshot needs finishedAt or --as-of');
 try{await verifySnapshot(directory);}
 catch(error){fail(error instanceof ExportError?error.message:'Snapshot could not be checked');}
 if(!Array.isArray(manifest.objects))fail('Manifest has no object list');
 const listed=new Set(manifest.objects.map(entry=>path.basename(String(entry?.file||''))));
 let present=[];
 try{present=await readdir(path.join(directory,'objects'));}
 catch{fail('Snapshot object directory is missing');}
 if(present.some(name=>!listed.has(name)))fail('Snapshot contains an object the manifest does not list');
 const byKey=new Map();
 for(const entry of manifest.objects){
  if(!entry||typeof entry.key!=='string'||byKey.has(entry.key))fail('Manifest has a duplicate or unreadable object record');
  if(entry.file!=='objects/'+fileId(entry.key)+'.bin'||entry.file.includes('..'))fail('Manifest object path is not the key hash');
  byKey.set(entry.key,entry);
 }
 for(const key of ['programme.json','watchlist.json'])if(!byKey.has(key))fail('Snapshot is missing a required lifecycle object');

 async function loadKey(key){
  const entry=byKey.get(key);
  if(!entry)return null;
  const bytes=await readFile(path.join(directory,entry.file));
  if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)fail('Snapshot checksum mismatch for a lifecycle object');
  try{return JSON.parse(bytes.toString('utf8'));}
  catch{fail('Lifecycle object is not JSON');}
 }
 const fingerprints={},predictions={},persistedSidecars={};
 let loaded=0;
 for(const key of byKey.keys()){
  const fingerprint=key.match(/^enrichment\/films\/([^/]+)\/fingerprint\.json$/);
  const prediction=key.match(/^enrichment\/films\/([^/]+)\/predictions\.json$/);
  if(!fingerprint&&!prediction&&!key.endsWith('.lifecycle.json'))continue;
  const value=await loadKey(key);
  loaded++;
  if(fingerprint)fingerprints[decodeURIComponent(fingerprint[1])]=value;
  else if(prediction)predictions[decodeURIComponent(prediction[1])]=value;
  else persistedSidecars[key]=value;
 }
 const named=['programme.json','watchlist.json','metadata.json','titles.json','people.json','sync.json','epg/discovered-films.json','epg/discovery-resolution.json','epg/discovery-latest.json','enrichment/profile/current.json'];
 const loadedNamed={};
 for(const key of named){if(!byKey.has(key))continue;loadedNamed[key]=await loadKey(key);loaded++;}
 const domain=await readFile(path.join(root,'src/domain/film-person.js'),'utf8');
 const reader=await readFile(path.join(root,'src/domain/film-person-reader.js'),'utf8');
 const backfill=await readFile(path.join(root,'src/domain/film-person-backfill.js'),'utf8');
 const context=vm.createContext({Date,Map,Set,JSON,Object,encodeURIComponent});
 vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={backfillLifecycle};',context);
 const store={
  watchlist:loadedNamed['watchlist.json'],
  programme:loadedNamed['programme.json'],
  metadata:loadedNamed['metadata.json'],
  titles:loadedNamed['titles.json']||{},
  people:loadedNamed['people.json']||{},
  sync:loadedNamed['sync.json']||{failures:[]},
  discoveredFilms:loadedNamed['epg/discovered-films.json']||{},
  discoveryResolution:loadedNamed['epg/discovery-resolution.json']||{},
  discoveryLatest:loadedNamed['epg/discovery-latest.json']||{items:[]},
  profile:loadedNamed['enrichment/profile/current.json']||null,
  fingerprints,predictions,persistedSidecars,
  filmTitles:JSON.parse(await readFile(path.join(root,'data/film-titles.json'),'utf8')),
  personNames:JSON.parse(await readFile(path.join(root,'data/person-names.json'),'utf8')),
  personOverrides:personOverridesFromSource(await readFile(path.join(root,'src/sources.js'),'utf8'))
 };
 const result=context.api.backfillLifecycle(store,now);
 const fieldCounts=items=>{const counts={};for(const item of items||[])counts[item.field]=(counts[item.field]||0)+1;return counts;};
 const reasonCounts=items=>{const counts={};for(const item of items||[])counts[item.reason]=(counts[item.reason]||0)+1;return counts;};
 console.log(JSON.stringify({
  writes:0,
  manifest:{schemaVersion:1,status:manifest.status,objects:manifest.objects.length},
  loadedLifecycleObjects:loaded,
  films:{ok:result.report.films.ok,legacy:result.report.films.legacy.length,lifecycle:result.report.films.lifecycle.length,missing:result.report.films.missing.length,extra:result.report.films.extra.length,mismatchFields:fieldCounts(result.report.films.mismatches)},
  people:{ok:result.report.people.ok,legacy:result.report.people.legacy.length,lifecycle:result.report.people.lifecycle.length,missing:result.report.people.missing.length,extra:result.report.people.extra.length,mismatchFields:fieldCounts(result.report.people.mismatches)},
  reconciliation:{create:result.reconciliation.create.length,update:result.reconciliation.update.length,unchanged:result.reconciliation.unchanged.length,orphan:result.reconciliation.orphan.length,conflict:result.reconciliation.conflict.length,conflictReasons:reasonCounts(result.reconciliation.conflict)}
 }));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{console.error(error instanceof ExportError?error.message:'Snapshot could not be checked');process.exit(1);});
}
