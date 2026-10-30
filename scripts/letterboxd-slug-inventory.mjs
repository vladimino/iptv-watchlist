// Read-only Letterboxd slug inventory (AIR-276) for an owner-provided snapshot.
// It projects the lifecycle sidecars with their `letterboxd_slug` aliases from the records already in the snapshot and
// prints counts only: no Letterboxd or TMDB request, no write to the snapshot, R2, D1 or this repository.
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {ExportError} from './migration-export.mjs';
import {loadLifecycleSnapshot,SnapshotError} from './snapshot-store.mjs';

const root=path.resolve(fileURLToPath(new URL('..',import.meta.url)));

export async function slugInventory(store,now){
 const sources=await Promise.all(['src/domain/film-person.js','src/domain/film-person-reader.js','src/domain/film-person-backfill.js'].map(file=>readFile(path.join(root,file),'utf8')));
 const context=vm.createContext({Date,Map,Set,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(sources.join('\n')+'\nglobalThis.api={backfillLifecycle,letterboxdSlugFromUrl,LETTERBOXD_SLUG_SCHEME};',context);
 const {backfillLifecycle,letterboxdSlugFromUrl,LETTERBOXD_SLUG_SCHEME}=context.api;
 const result=backfillLifecycle(store,now);
 const films=new Map();
 for(const body of Object.values(result.sidecars))for(const record of body&&typeof body==='object'&&!Array.isArray(body)?(body.externalIds?[body]:Object.values(body)):[])if(String(record?.id||'').startsWith('film:')&&record.externalIds)films.set(record.id,record);
 const counts={films:films.size,withLid:0,tmdbOnly:0,withSlug:0,withoutSlug:0,current:0,ambiguous:0,observedOnly:0,historical:0,conflicting:0};
 for(const film of films.values()){
  const lid=film.externalIds.some(item=>item.scheme==='letterboxd'),slugs=film.externalIds.filter(item=>item.scheme===LETTERBOXD_SLUG_SCHEME);
  if(!lid){counts.tmdbOnly++;continue;}
  counts.withLid++;
  if(!slugs.length){counts.withoutSlug++;continue;}
  counts.withSlug++;
  const status=new Set(slugs.map(item=>item.provenance?.status));
  if(status.has('current'))counts.current++;else if(status.has('ambiguous'))counts.ambiguous++;else if(status.has('observed'))counts.observedOnly++;
  if(status.has('historical'))counts.historical++;
  if(slugs.some(item=>item.conflicting))counts.conflicting++;
 }
 const records=[...(store.programme?.films||[]),...(store.watchlist?.films||[])].filter(film=>film&&!String(film.id).startsWith('tmdb_'));
 const urls={records:new Set(records.map(film=>String(film.id))).size,permalink:new Set(records.filter(film=>letterboxdSlugFromUrl(film.url)).map(film=>String(film.id))).size};
 urls.other=new Set(records.filter(film=>film.url&&!letterboxdSlugFromUrl(film.url)).map(film=>String(film.id))).size;
 return {writes:0,requests:0,films:counts,letterboxdRecords:urls,diaryEntries:Object.keys(store.diaryHistory?.entries||{}).length,collisions:result.report.aliasConflicts.length,
  reconciliation:{create:result.reconciliation.create.length,update:result.reconciliation.update.length,unchanged:result.reconciliation.unchanged.length,orphan:result.reconciliation.orphan.length,conflict:result.reconciliation.conflict.length}};
}

async function main(){
 const snapshotAt=process.argv.indexOf('--snapshot');
 const requested=snapshotAt>=0?process.argv[snapshotAt+1]:'';
 if(!requested){console.error('Usage: node scripts/letterboxd-slug-inventory.mjs --snapshot /absolute/private/snapshot-directory [--as-of ISO-timestamp]');process.exit(2);}
 const asOfAt=process.argv.indexOf('--as-of');
 let loaded;
 try{loaded=await loadLifecycleSnapshot(requested,{asOf:asOfAt>=0?process.argv[asOfAt+1]:undefined});}
 catch(error){console.error(error instanceof ExportError||error instanceof SnapshotError?error.message:'Snapshot could not be checked');process.exit(error.exitCode||1);}
 console.log(JSON.stringify({manifest:loaded.manifest,...await slugInventory(loaded.store,loaded.now)}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 main().catch(()=>{console.error('Snapshot could not be checked');process.exit(1);});
}
