#!/usr/bin/env node
// AIR-275 phase 2 (ADR 0056). After an offline import fills a database from a snapshot, this writes the enrichment projector's
// change keys for that snapshot into projection_state, so the first projector run after a reload writes only what R2 changed
// since the snapshot instead of every Film and Person. A key is written only for a Film or Person the database holds; anything
// the import left out is written by the projector. The keys come from the same store, reader and derivation the Worker uses.
// Local only: it writes the SQLite file it is given and nothing else.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {enrichmentInputs,enrichmentStore,filmChangeKey,personChangeKey} from '../src/enrichment-projection.js';
import {openSqlite} from './offline-import.mjs';
import {loadLifecycleSnapshot} from './snapshot-store.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const PROJECTION='enrichment';

export function lifecycleReader(){
 const context=vm.createContext({Date,Map,Set,WeakMap,JSON,Object,URL,encodeURIComponent});
 vm.runInContext(fs.readFileSync(path.join(ROOT,'src/domain/film-person.js'),'utf8')+'\n'+fs.readFileSync(path.join(ROOT,'src/domain/film-person-reader.js'),'utf8')+'\nglobalThis.api={readLifecycle};',context);
 return (store,now)=>context.api.readLifecycle(store,now,{entitiesOnly:true});
}

// The change keys of one snapshot: [{kind,id,key}] for every Film and Person of its enrichment view.
export async function snapshotChangeKeys(directory){
 const {store,now}=await loadLifecycleSnapshot(directory);
 const lean=enrichmentStore({watchlist:store.watchlist,programme:store.programme,metadata:store.metadata,titles:store.titles,people:store.people,discoveredFilms:store.discoveredFilms,discoveryResolution:store.discoveryResolution,diaryHistory:store.diaryHistory,filmTitles:store.filmTitles,personNames:store.personNames,personOverrides:store.personOverrides});
 const inputs=enrichmentInputs({view:lifecycleReader()(lean,now),store:lean});
 const nowIso=new Date(now).toISOString();
 return {at:nowIso,keys:[...inputs.people.map(entry=>({kind:'person',id:entry.id,key:personChangeKey(entry,nowIso)})),...inputs.films.map(entry=>({kind:'film',id:entry.id,key:filmChangeKey(entry,nowIso)}))]};
}

export async function seedProjection(db,{keys,at}){
 const tables=(await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='projection_state'")).length;
 if(!tables)throw new Error('projection_state is missing: apply migrations/0004_projection_state.sql first');
 const films=new Set((await db.all('SELECT id FROM film')).map(row=>row.id)),people=new Set((await db.all('SELECT id FROM person')).map(row=>row.id));
 const held=keys.filter(item=>(item.kind==='film'?films:people).has(item.id));
 await db.transaction(async()=>{
  await db.run('DELETE FROM projection_state WHERE projection=?',[PROJECTION]);
  for(const item of held)await db.run('INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES (?,?,?,?,?)',[PROJECTION,item.kind,item.id,item.key,at]);
 });
 return {seeded:held.length,skipped:keys.length-held.length,films:held.filter(item=>item.kind==='film').length,people:held.filter(item=>item.kind==='person').length};
}

async function main(){
 const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:null;};
 const snapshot=value('--snapshot'),database=value('--database');
 if(!snapshot||!database){console.error('Usage: node scripts/d1-projection-seed.mjs --snapshot <dir> --database <sqlite file>');process.exit(2);}
 const result=await seedProjection(openSqlite(database),await snapshotChangeKeys(snapshot));
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exit(1);});
