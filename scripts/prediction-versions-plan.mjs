// Plans the one-time materialization of immutable prediction version objects from a local snapshot. It reads the snapshot
// directory only, hashes the exact bytes each version object would hold, and prints counts and keys. It writes nothing,
// opens no network connection and holds no credential: the production execution of this plan is a separately approved
// operation with its own runbook step.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ExportError,verifySnapshot} from './migration-export.mjs';
import {loadDomainRules} from './offline-import.mjs';

const BUNDLE=/^enrichment\/films\/([^/]+)\/predictions\.json$/;
const sha256=text=>createHash('sha256').update(Buffer.from(text,'utf8')).digest('hex');

export async function planMaterialization(directory,rules=loadDomainRules()){
 const absolute=path.resolve(directory);
 await verifySnapshot(absolute);
 const manifest=JSON.parse(await readFile(path.join(absolute,'manifest.json'),'utf8'));
 const byKey=new Map(manifest.objects.map(entry=>[entry.key,entry]));
 const films=[];const totals={bundles:0,recordsLinked:0,recordsPending:0,recordsMalformed:0,objectsToWrite:0,bytesToWrite:0,objectsAlreadyPresent:0,presentChecksumMismatch:0,bundlesToRewrite:0,unreadableBundles:0,unreferencedVersionObjects:0};
 const referenced=new Set();
 for(const entry of manifest.objects){
  const match=entry.key.match(BUNDLE);
  if(!match)continue;
  totals.bundles++;
  let storedId;try{storedId=decodeURIComponent(match[1]);}catch{storedId=match[1];}
  let bundle;try{bundle=JSON.parse(await readFile(path.join(absolute,entry.file),'utf8'));}catch{totals.unreadableBundles++;films.push({storedId,bundleKey:entry.key,unreadable:true});continue;}
  const plan=rules.predictionMaterializationPlan(storedId,bundle);
  for(const item of plan.linked)referenced.add(item.r2Key);
  const objects=[];
  for(const item of plan.pending){
   const sha=sha256(item.text),key=rules.predictionVersionKey(storedId,sha),present=byKey.get(key)||null;
   const action=present?(present.sha256===sha?'link_only':'checksum_mismatch'):'write';
   if(action==='write'){totals.objectsToWrite++;totals.bytesToWrite+=Buffer.byteLength(item.text,'utf8');}
   else if(action==='link_only')totals.objectsAlreadyPresent++;
   else totals.presentChecksumMismatch++;
   if(present)referenced.add(key);
   objects.push({role:item.role,index:item.index,key,sha256:sha,bytes:Buffer.byteLength(item.text,'utf8'),action});
  }
  totals.recordsLinked+=plan.linked.length;totals.recordsPending+=plan.pending.length;totals.recordsMalformed+=plan.malformed.length;
  if(plan.bundleRewriteNeeded)totals.bundlesToRewrite++;
  films.push({storedId,bundleKey:entry.key,bundleSha256:entry.sha256,linked:plan.linked.length,malformed:plan.malformed,objects,bundleRewriteNeeded:plan.bundleRewriteNeeded});
 }
 const unreferenced=manifest.objects.map(entry=>entry.key).filter(key=>rules.parsePredictionVersionKey(key)&&!referenced.has(key));
 totals.unreferencedVersionObjects=unreferenced.length;
 return {mode:'plan',writes:'none',network:false,snapshot:{finishedAt:manifest.finishedAt??null,aggregateSha256:manifest.totals?.aggregateSha256??null,status:manifest.status??null},totals,films,unreferenced,note:'Each pending record becomes one write-once object keyed by the SHA-256 of its canonical bytes, followed by one bundle rewrite that adds the pointers under the prediction writer lease. Executing this plan against production is a separately approved operation.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(new URL(import.meta.url))){
 const args=process.argv.slice(2),at=args.indexOf('--snapshot'),directory=at>=0?args[at+1]:null;
 if(!directory||!path.isAbsolute(directory)){console.error('Usage: node scripts/prediction-versions-plan.mjs --snapshot /absolute/private/snapshot-directory');process.exit(2);}
 try{console.log(JSON.stringify(await planMaterialization(directory)));}
 catch(error){console.error(error instanceof ExportError?error.kind+': '+error.message:'Plan failed');process.exit(1);}
}
