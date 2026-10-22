// Shared read of an owner-provided migration snapshot.
// It checks the manifest and loads records the caller already has on disk.
// It does not write the snapshot, R2, or this repository.
// The exporter source is the historical Site archive, not current production.
import {createHash} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifySnapshot,ExportError,SOURCE_SITE_ID,SOURCE_ORIGIN} from './migration-export.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fileId=key=>createHash('sha256').update(Buffer.from(key,'utf8')).digest('hex');

export class SnapshotError extends Error{constructor(message,exitCode=1){super(message);this.name='SnapshotError';this.exitCode=exitCode;}}

export function personOverridesFromSource(source){
 const match=String(source).match(/REVIEWED_PEOPLE\['actor\/chris-pratt'\]=(\{[\s\S]*?\});/);
 if(!match)throw new SnapshotError('Reviewed person override is missing from sources.js');
 const value=Function(`"use strict";return (${match[1]});`)();
 if(!value||typeof value.name!=='string'||!value.name||value.nameStatus!=='verified')throw new SnapshotError('Reviewed person override is incomplete');
 return {'actor/chris-pratt':value};
}

export async function loadLifecycleSnapshot(directory,{asOf}={}){
 const absolute=path.resolve(directory);
 if(absolute===root||absolute.startsWith(root+path.sep))throw new SnapshotError('Snapshot directory must be outside the Git repository',2);
 let manifest;
 try{manifest=JSON.parse(await readFile(path.join(absolute,'manifest.json'),'utf8'));}
 catch{throw new SnapshotError('Manifest is not JSON');}
 if(!manifest||manifest.schemaVersion!==1)throw new SnapshotError('Manifest schema is not 1');
 if(manifest.status!=='provisional_no_change_detected')throw new SnapshotError('Snapshot is not a complete provisional export');
 if(!Array.isArray(manifest.changes)||manifest.changes.length!==0)throw new SnapshotError('Snapshot recorded listing changes');
 if(manifest.sourceSiteId!==SOURCE_SITE_ID||manifest.sourceOrigin!==SOURCE_ORIGIN)throw new SnapshotError('Snapshot source identity does not match the exporter');
 const clockSource=asOf!==undefined?asOf:manifest.finishedAt;
 const now=Date.parse(clockSource||'');
 if(!Number.isFinite(now))throw new SnapshotError('Snapshot needs finishedAt or --as-of');
 try{await verifySnapshot(absolute);}
 catch(error){throw error instanceof ExportError?error:new SnapshotError('Snapshot could not be checked');}
 if(!Array.isArray(manifest.objects))throw new SnapshotError('Manifest has no object list');
 const listed=new Set(manifest.objects.map(entry=>path.basename(String(entry?.file||''))));
 let present=[];
 try{present=await readdir(path.join(absolute,'objects'));}
 catch{throw new SnapshotError('Snapshot object directory is missing');}
 if(present.some(name=>!listed.has(name)))throw new SnapshotError('Snapshot contains an object the manifest does not list');
 const byKey=new Map();
 for(const entry of manifest.objects){
  if(!entry||typeof entry.key!=='string'||byKey.has(entry.key))throw new SnapshotError('Manifest has a duplicate or unreadable object record');
  if(entry.file!=='objects/'+fileId(entry.key)+'.bin'||entry.file.includes('..'))throw new SnapshotError('Manifest object path is not the key hash');
  byKey.set(entry.key,entry);
 }
 for(const key of ['programme.json','watchlist.json'])if(!byKey.has(key))throw new SnapshotError('Snapshot is missing a required lifecycle object');
 async function loadKey(key){
  const entry=byKey.get(key);
  if(!entry)return null;
  const bytes=await readFile(path.join(absolute,entry.file));
  if(bytes.length!==entry.size||createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new SnapshotError('Snapshot checksum mismatch for a lifecycle object');
  try{return JSON.parse(bytes.toString('utf8'));}
  catch{throw new SnapshotError('Lifecycle object is not JSON');}
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
 return {store,now,finishedAt:manifest.finishedAt||null,loaded,manifest:{schemaVersion:1,status:manifest.status,objects:manifest.objects.length},historical:true,production:false};
}
