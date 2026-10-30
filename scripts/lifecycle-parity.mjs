// Read-only lifecycle parity for an owner-provided migration snapshot.
// It checks the manifest and prints counts. It does not write the snapshot, R2, or this repository.
// The 19 October 2026 snapshot is a historical archive, not a current copy of production.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {ExportError} from './migration-export.mjs';
import {loadLifecycleSnapshot,personOverridesFromSource,SnapshotError} from './snapshot-store.mjs';

export {personOverridesFromSource};

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const fail=(message,exitCode=1)=>{console.error(message);process.exit(exitCode);};

async function main(){
 const snapshotAt=process.argv.indexOf('--snapshot');
 const requested=snapshotAt>=0?process.argv[snapshotAt+1]:'';
 if(!requested){console.error('Usage: node scripts/lifecycle-parity.mjs --snapshot /absolute/private/snapshot-directory [--as-of ISO-timestamp]');process.exit(2);}
 const asOfAt=process.argv.indexOf('--as-of');
 let loaded;
 try{loaded=await loadLifecycleSnapshot(requested,{asOf:asOfAt>=0?process.argv[asOfAt+1]:undefined});}
 catch(error){fail(error instanceof ExportError||error instanceof SnapshotError?error.message:'Snapshot could not be checked',error.exitCode||1);}
 const domain=await readFile(path.join(root,'src/domain/film-person.js'),'utf8');
 const reader=await readFile(path.join(root,'src/domain/film-person-reader.js'),'utf8');
 const backfill=await readFile(path.join(root,'src/domain/film-person-backfill.js'),'utf8');
 const context=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(domain+'\n'+reader+'\n'+backfill+'\nglobalThis.api={backfillLifecycle};',context);
 const result=context.api.backfillLifecycle(loaded.store,loaded.now);
 const fieldCounts=items=>{const counts={};for(const item of items||[])counts[item.field]=(counts[item.field]||0)+1;return counts;};
 const reasonCounts=items=>{const counts={};for(const item of items||[])counts[item.reason]=(counts[item.reason]||0)+1;return counts;};
 console.log(JSON.stringify({
  writes:0,
  manifest:loaded.manifest,
  loadedLifecycleObjects:loaded.loaded,
  films:{ok:result.report.films.ok,legacy:result.report.films.legacy.length,lifecycle:result.report.films.lifecycle.length,missing:result.report.films.missing.length,extra:result.report.films.extra.length,mismatchFields:fieldCounts(result.report.films.mismatches)},
  people:{ok:result.report.people.ok,legacy:result.report.people.legacy.length,lifecycle:result.report.people.lifecycle.length,missing:result.report.people.missing.length,extra:result.report.people.extra.length,mismatchFields:fieldCounts(result.report.people.mismatches)},
  reconciliation:{create:result.reconciliation.create.length,update:result.reconciliation.update.length,unchanged:result.reconciliation.unchanged.length,orphan:result.reconciliation.orphan.length,conflict:result.reconciliation.conflict.length,conflictReasons:reasonCounts(result.reconciliation.conflict)}
 }));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{console.error(error instanceof ExportError?error.message:'Snapshot could not be checked');process.exit(1);});
}
