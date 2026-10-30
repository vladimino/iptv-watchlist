// Read-only lifecycle diagnostics for one Film, one Person, or the aggregate counts.
// It reads an already verified migration snapshot. It does not write the snapshot, R2, or this repository.
// The snapshot is a historical archive. Its figures are not current production counts.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {ExportError} from './migration-export.mjs';
import {loadLifecycleSnapshot,SnapshotError} from './snapshot-store.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));
const usage='Usage: node scripts/lifecycle-diagnostics.mjs --snapshot /absolute/private/snapshot-directory [--as-of ISO-timestamp] (--film ID | --person ID | --summary)';
const fail=(message,exitCode=1)=>{console.error(message);process.exit(exitCode);};
function option(name){
 const at=process.argv.indexOf(name);
 if(at<0)return undefined;
 const value=process.argv[at+1];
 return !value||value.startsWith('--')?'':value;
}

async function main(){
 const requested=option('--snapshot');
 if(!requested)fail(usage,2);
 const actions=['--film','--person','--summary'].filter(name=>process.argv.includes(name));
 if(actions.length!==1)fail(usage,2);
 const film=option('--film'),person=option('--person'),summary=process.argv.includes('--summary');
 if((process.argv.includes('--film')&&!film)||(process.argv.includes('--person')&&!person))fail(usage,2);
 const asOfAt=process.argv.indexOf('--as-of');
 let loaded;
 try{loaded=await loadLifecycleSnapshot(requested,{asOf:asOfAt>=0?process.argv[asOfAt+1]:undefined});}
 catch(error){fail(error instanceof ExportError||error instanceof SnapshotError?error.message:'Snapshot could not be checked',error.exitCode||1);}
 const domain=await readFile(path.join(root,'src/domain/film-person.js'),'utf8');
 const reader=await readFile(path.join(root,'src/domain/film-person-reader.js'),'utf8');
 const diagnostics=await readFile(path.join(root,'src/domain/film-person-diagnostics.js'),'utf8');
 const context=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(domain+'\n'+reader+'\n'+diagnostics+'\nglobalThis.api={diagnoseFilm,diagnosePerson,lifecycleCounts,presentDiagnosis};',context);
 const archive=String(loaded.finishedAt||'').startsWith('2026-10-19');
 const report={
  writes:0,
  scope:'historical-snapshot',
  production:false,
  asOf:new Date(loaded.now).toISOString(),
  snapshotFinishedAt:loaded.finishedAt,
  note:archive?'The 19 October 2026 snapshot is a historical archive. These figures are not current production counts.':'Historical migration snapshot. These figures are not current production counts.'
 };
 if(summary)Object.assign(report,context.api.lifecycleCounts(loaded.store,loaded.now));
 else{
  const result=film!==undefined?context.api.diagnoseFilm(loaded.store,film,loaded.now):context.api.diagnosePerson(loaded.store,person,loaded.now);
  Object.assign(report,context.api.presentDiagnosis(result));
 }
 console.log(JSON.stringify(report));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(error=>{console.error(error instanceof ExportError?error.message:'Snapshot could not be checked');process.exit(1);});
}
