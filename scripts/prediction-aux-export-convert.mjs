// AIR-554 (ADR 0196, handoff of 22 Nov 2026): the bridge from the verified production R2 snapshot to the input of scripts/prediction-aux-d1-import.mjs.
//
// scripts/r2-snapshot-export.mjs snapshots the WHOLE bucket into `objects/<sha256 of the key>.bin` plus `manifest.json`; the importer reads a directory that mirrors the original R2 keys as `.json` files
// (or one key-to-document map). This script is the missing conversion. It is offline and read-only on the snapshot: it opens no database, no bucket and no network connection, and writes only inside its
// output directory, which must be absolute, outside the Git repository and new or empty.
//
//   node scripts/prediction-aux-export-convert.mjs <snapshot-dir> <output-dir>
//
// Output (nothing of it is ever committed or uploaded; a public report carries counts and digests only):
//   <output-dir>/tree/<original key>      the exact stored bytes of every object of the four families and of the pending index (the importer's `<r2-export>`)
//   <output-dir>/identity.json            [{key, etag, size, sha256}] sorted by key: the identity the cutover compares at every boundary (auxFlipRefusal compares key, ETag and size)
//   <output-dir>/converter-report.json    counts, bytes and digests per family, the snapshot's own digest; written LAST, so its presence marks a complete conversion
//
// The output directory is judged by where it REALLY is (symlinks resolved; the output itself may not be a symlink; a path that resolves into the repository is refused), and a key of the four families that the
// importer would not consume (an unknown name, a backup copy, a non-JSON file) is refused here, never copied and counted as if it were imported.
// A snapshot is refused (exit 2, nothing left behind) unless verifyProductionSnapshot passes (every object re-hashed against the manifest, totals equal) AND its status is `consistent_fenced` with no
// NO-GO reason, no change between the listings and a fence that held. Every copied object is read once, hashed again at the moment of the copy and compared with the manifest's size and SHA-256; its
// metadata must name the same key and size and carry a strong ETag; a key that could leave the tree is refused; a duplicate, a missing or a changed object is a refusal. The bytes are never parsed or
// rewritten here: a malformed document reaches the importer unchanged and is a blocker there. Exit codes: 0 converted, 1 usage, 2 refusal.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {verifyProductionSnapshot,STATUS_CONSISTENT} from './r2-snapshot-export.mjs';
import {auxExportFamily,auxConsumableKey} from './prediction-aux-d1-import.mjs';

const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export class Refusal extends Error{constructor(code,detail={}){super(code);this.name='Refusal';this.code=code;this.detail=detail;}}
const refuse=(code,detail)=>{throw new Refusal(code,detail);};

// Where a directory REALLY is, not where its text says: the nearest existing ancestor is resolved through the filesystem (every symlink on the way), the rest is appended. A path that ends up inside the
// repository is refused, whatever its spelling or the symlink that leads there (review of PR 896: a link in /tmp to an empty directory of this public repository would have received the private bodies).
// The output directory itself must not be a symlink at all; a dangling link anywhere on the way is not a location.
function locate(directory,name,{allowSymlinkTarget}){
 if(typeof directory!=='string'||!path.isAbsolute(directory))refuse('path_not_absolute',{name});
 const lexical=path.resolve(directory);
 let probe=lexical;const rest=[];
 for(;;){
  const stat=fs.lstatSync(probe,{throwIfNoEntry:false});
  if(stat){
   if(stat.isSymbolicLink()&&probe===lexical&&!allowSymlinkTarget)refuse('path_symlink',{name});
   break;
  }
  const parent=path.dirname(probe);
  if(parent===probe)break;
  rest.unshift(path.basename(probe));probe=parent;
 }
 let base;
 try{base=fs.realpathSync(probe);}catch{refuse('path_unresolvable',{name});}
 const real=path.join(base,...rest);
 let repository;
 try{repository=fs.realpathSync(REPO_ROOT);}catch{repository=REPO_ROOT;}
 if(real===repository||real.startsWith(repository+path.sep)||lexical===REPO_ROOT||lexical.startsWith(REPO_ROOT+path.sep))refuse('path_inside_repository',{name});
 return real;
}
// The key becomes a path inside the tree: every segment must be a plain name.
export function safeSegments(key){
 const segments=key.split('/');
 if(!segments.length||segments.some(segment=>!segment||segment==='.'||segment==='..'||/[\\\u0000]/.test(segment)))refuse('unsafe_key',{keyDigest:sha(key).slice(0,12)});
 return segments;
}
const strongEtag=etag=>typeof etag==='string'&&etag.length>0&&!/^W\//.test(etag);

// `afterVerify` is a test seam only (it runs between the verification of the snapshot and the copy, to prove that the bytes are hashed again AT the copy); the CLI never passes it.
export async function convertSnapshot({snapshot,output,afterVerify=null}){
 const source=locate(snapshot,'snapshot',{allowSymlinkTarget:true}),target=locate(output,'output',{allowSymlinkTarget:false});
 if(target===source||target.startsWith(source+path.sep)||source.startsWith(target+path.sep))refuse('paths_overlap');
 // 1. The snapshot must verify and must be a consistent fenced cut.
 let verified;
 try{verified=await verifyProductionSnapshot(source);}
 catch(error){refuse('snapshot_not_verified',{kind:error?.kind||'unreadable',message:error?.kind?String(error.message):'the snapshot could not be read'});}
 if(verified.status!==STATUS_CONSISTENT)refuse('snapshot_not_consistent',{status:verified.status,reasons:verified.noGoReasons});
 let manifest;
 try{manifest=JSON.parse(fs.readFileSync(path.join(source,'manifest.json'),'utf8'));}catch{refuse('snapshot_not_verified',{kind:'manifest',message:'manifest.json could not be read'});}
 if(!Array.isArray(manifest.objects))refuse('snapshot_not_verified',{kind:'manifest',message:'the manifest lists no objects'});
 if(typeof afterVerify==='function')await afterVerify({snapshot:source});
 // 2. The objects of the four families, in key order, each checked before anything is written.
 const selected=[],seen=new Set();
 for(const entry of manifest.objects){
  const family=auxExportFamily(entry?.key);
  if(!family)continue;
  if(seen.has(entry.key))refuse('duplicate_key',{keyDigest:sha(entry.key).slice(0,12)});
  seen.add(entry.key);
  const segments=safeSegments(entry.key);
  // A key of a family that the importer would not consume (an unknown name, a backup copy, a non-JSON file) is refused here: the importer must never be the only thing between a selected object and a silent loss.
  if(!auxConsumableKey(entry.key))refuse('unconsumed_key',{family,keyDigest:sha(entry.key).slice(0,12)});
  if(entry.metadata?.key!==entry.key||entry.metadata?.size!==entry.size)refuse('metadata_mismatch',{family,keyDigest:sha(entry.key).slice(0,12)});
  if(!strongEtag(entry.metadata?.etag))refuse('etag_missing_or_weak',{family,keyDigest:sha(entry.key).slice(0,12)});
  if(!Number.isSafeInteger(entry.size)||entry.size<0||typeof entry.sha256!=='string'||!/^[0-9a-f]{64}$/.test(entry.sha256)||typeof entry.file!=='string')refuse('entry_invalid',{family,keyDigest:sha(entry.key).slice(0,12)});
  const file=path.resolve(source,entry.file);
  if(!file.startsWith(path.join(source,'objects')+path.sep))refuse('unsafe_object_path',{family,keyDigest:sha(entry.key).slice(0,12)});
  selected.push({entry,family,segments,file});
 }
 selected.sort((a,b)=>Buffer.compare(Buffer.from(a.entry.key),Buffer.from(b.entry.key)));
 // 3. The output directory is new or empty; whatever this run creates it removes again on a refusal.
 let created=false;
 if(fs.existsSync(target)){
  if(!fs.statSync(target).isDirectory()||fs.readdirSync(target).length)refuse('output_not_empty');
 }
 else{fs.mkdirSync(target,{recursive:true,mode:0o700});created=true;}
 const tree=path.join(target,'tree');
 try{
  // The directory exists now: its real location must still be the one that was checked (nothing swapped it for a link in between).
  if(fs.realpathSync(target)!==target)refuse('path_changed',{name:'output'});
  fs.mkdirSync(tree,{mode:0o700});
  const identity=[],families={};
  for(const {entry,family,segments,file} of selected){
   let bytes;
   try{bytes=fs.readFileSync(file);}catch{refuse('object_missing',{family,keyDigest:sha(entry.key).slice(0,12)});}
   // The bytes are hashed again AT the copy: a file changed after the snapshot verified is caught here.
   if(bytes.length!==entry.size||sha(bytes)!==entry.sha256)refuse('object_changed',{family,keyDigest:sha(entry.key).slice(0,12)});
   const destination=path.join(tree,...segments);
   if(path.relative(tree,destination).startsWith('..'))refuse('unsafe_key',{keyDigest:sha(entry.key).slice(0,12)});
   fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
   fs.writeFileSync(destination,bytes,{flag:'wx',mode:0o600});
   identity.push({key:entry.key,etag:entry.metadata.etag,size:entry.size,sha256:entry.sha256});
   const row=families[family]??={objects:0,bytes:0};row.objects++;row.bytes+=entry.size;
  }
  const identityText=JSON.stringify(identity)+'\n';
  fs.writeFileSync(path.join(target,'identity.json'),identityText,{flag:'wx',mode:0o600});
  const report={
   schemaVersion:1,
   snapshot:{status:verified.status,objects:verified.objects,bytes:verified.bytes,aggregateSha256:verified.aggregateSha256,startedAt:manifest.startedAt??null,finishedAt:manifest.finishedAt??null,
    // Where the cut was taken (the exporter's own record of the source): the cutover operator requires the two captures it compares to name the same source.
    source:{kind:manifest.source?.kind??null,bucket:manifest.source?.bucket??null,accountId:manifest.source?.accountId??null}},
   converted:{objects:identity.length,bytes:identity.reduce((sum,item)=>sum+item.size,0),skippedObjects:manifest.objects.length-identity.length,families,identitySha256:sha(identityText)},
   input:'tree',
   next:['node scripts/prediction-aux-d1-import.mjs report <output-dir>/tree','node scripts/prediction-aux-d1-import.mjs digest <output-dir>/tree','node scripts/prediction-aux-d1-import.mjs preflight <output-dir>/tree','node scripts/prediction-aux-d1-import.mjs sql <output-dir>/tree --generation N','node scripts/prediction-aux-d1-import.mjs verify <output-dir>/tree']
  };
  fs.writeFileSync(path.join(target,'converter-report.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx',mode:0o600});
  return report;
 }catch(error){
  // Only what this run created is removed; a pre-existing empty directory stays, its contents go.
  try{if(created)fs.rmSync(target,{recursive:true,force:true});else fs.rmSync(tree,{recursive:true,force:true});for(const name of ['identity.json','converter-report.json'])fs.rmSync(path.join(target,name),{force:true});}catch{/* best effort */}
  throw error;
 }
}

async function main(argv){
 const [snapshot,output]=argv;
 if(!snapshot||!output||argv.length!==2){process.stderr.write('usage: prediction-aux-export-convert.mjs <snapshot-dir> <output-dir>\n');return 1;}
 try{
  const report=await convertSnapshot({snapshot,output});
  process.stdout.write(JSON.stringify(report,null,2)+'\n');
  return 0;
 }catch(error){
  if(error instanceof Refusal){process.stderr.write('REFUSED: '+error.code+(Object.keys(error.detail).length?' '+JSON.stringify(error.detail):'')+'\n');return 2;}
  process.stderr.write('REFUSED: unexpected\n');return 2;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(fileURLToPath(import.meta.url)))process.exitCode=await main(process.argv.slice(2));
