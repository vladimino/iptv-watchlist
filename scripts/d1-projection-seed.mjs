#!/usr/bin/env node
// AIR-275 phase 2 (ADR 0056). After an offline import fills a database from a snapshot, this writes the enrichment projector's
// change keys for that snapshot into projection_state, so the first projector run after a reload writes only what R2 changed
// since the snapshot instead of every Film and Person. A key is written only for a Film or Person the database holds; anything
// the import left out is written by the projector. The keys come from the same store, reader and derivation the Worker uses.
// Two targets. --database writes a local SQLite file (a reload build) in one transaction. --target d1 writes production D1 through
// the HTTP API, read-only unless --apply is given: see seedProjectionD1 for its fences.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {enrichmentInputs,enrichmentStore,filmChangeKey,personChangeKey} from '../src/enrichment-projection.js';
import {BackfillStop,createD1Adapter,IDENTITY_SOURCE_KEY,IDENTITY_TARGET_TABLE,readTarget,SCHEMA_VERSION} from './d1-backfill.mjs';
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
 const {store,now,manifest}=await loadLifecycleSnapshot(directory);
 const lean=enrichmentStore({watchlist:store.watchlist,programme:store.programme,metadata:store.metadata,titles:store.titles,people:store.people,discoveredFilms:store.discoveredFilms,discoveryResolution:store.discoveryResolution,diaryHistory:store.diaryHistory,filmTitles:store.filmTitles,personNames:store.personNames,personOverrides:store.personOverrides});
 const inputs=enrichmentInputs({view:lifecycleReader()(lean,now),store:lean});
 const nowIso=new Date(now).toISOString();
 return {at:nowIso,aggregateSha256:manifest.aggregateSha256,keys:[...inputs.people.map(entry=>({kind:'person',id:entry.id,key:personChangeKey(entry,nowIso)})),...inputs.films.map(entry=>({kind:'film',id:entry.id,key:filmChangeKey(entry,nowIso)}))]};
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

// Seeds production D1 with the change keys of the snapshot it was built from. It is not one transaction: rows go in bounded
// chunks, each an idempotent INSERT that leaves an existing row alone, so an interrupted run is finished by running it again.
// Before any write, every fence must hold, and none is skipped by --apply:
// - the database is the configured one, by uuid and name;
// - it carries all of migration 0004: the three projection tables and schema_contract version SCHEMA_VERSION;
// - its baseline receipt names the snapshot the keys come from;
// - no projector run holds the lease;
// - every key belongs to a Film or Person the database holds. Rows only D1 holds, such as the AIR-286 TMDB people, get no key;
// - no stored key disagrees with the plan, and no stored key lies outside it.
// After the writes, every stored key is read back and must equal the plan exactly. Nothing else is written or deleted.
export const SEED_CHUNK_ROWS=250;
export async function seedProjectionD1(adapter,target,plan,{apply=false,now=Date.now(),chunkRows=SEED_CHUNK_ROWS}={}){
 const described=await adapter.describe();
 if(described.uuid!==target.databaseId||described.name!==target.databaseName)throw new BackfillStop('target_identity_mismatch',{expected:{uuid:target.databaseId,name:target.databaseName},actual:described});
 const tables=(await adapter.all("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projection_state','projection_run','projection_fence') ORDER BY name")).map(row=>row.name);
 const version=(await adapter.get('SELECT version FROM schema_contract WHERE id=1'))?.version??null;
 if(tables.length!==3||version!==SCHEMA_VERSION)throw new BackfillStop('schema_not_v4',{tables,version});
 const receipts=await adapter.all('SELECT source_sha256 FROM import_receipt WHERE source_key=? AND target_table=?',[IDENTITY_SOURCE_KEY,IDENTITY_TARGET_TABLE]);
 if(receipts.length!==1||receipts[0].source_sha256!==plan.aggregateSha256)throw new BackfillStop('baseline_mismatch',{expected:plan.aggregateSha256,receipts:receipts.map(row=>row.source_sha256)});
 const lease=await adapter.get('SELECT lease_until FROM projection_run WHERE projection=?',[PROJECTION]);
 if(lease?.lease_until&&lease.lease_until>new Date(now).toISOString())throw new BackfillStop('projector_running',{leaseUntil:lease.lease_until});
 const films=new Set((await adapter.all('SELECT id FROM film')).map(row=>row.id)),people=new Set((await adapter.all('SELECT id FROM person')).map(row=>row.id));
 const missing=plan.keys.filter(item=>!(item.kind==='film'?films:people).has(item.id));
 if(missing.length)throw new BackfillStop('entity_missing',{count:missing.length,sample:missing.slice(0,5).map(item=>item.kind+':'+item.id)});
 const wanted=new Map(plan.keys.map(item=>[item.kind+'\n'+item.id,item.key]));
 const stateOf=async()=>new Map((await adapter.all('SELECT kind,id,change_key FROM projection_state WHERE projection=?',[PROJECTION])).map(row=>[row.kind+'\n'+row.id,row.change_key]));
 const stored=await stateOf();
 const conflicting=[...stored].filter(([id,key])=>wanted.has(id)&&wanted.get(id)!==key).length,foreign=[...stored.keys()].filter(id=>!wanted.has(id)).length;
 if(conflicting||foreign)throw new BackfillStop('state_conflict',{conflicting,foreign});
 const pending=plan.keys.filter(item=>!stored.has(item.kind+'\n'+item.id));
 const report={databaseId:described.uuid,schemaVersion:version,baseline:plan.aggregateSha256,planned:plan.keys.length,films:plan.keys.filter(item=>item.kind==='film').length,people:plan.keys.filter(item=>item.kind==='person').length,heldFilms:films.size,heldPeople:people.size,dOnlyPeople:[...people].filter(id=>!wanted.has('person\n'+id)).length,alreadyStored:stored.size,pending:pending.length,apply,written:0,requests:0};
 if(!apply)return {...report,outcome:'plan'};
 for(let index=0;index<pending.length;index+=chunkRows){
  const rows=pending.slice(index,index+chunkRows);
  await adapter.run('INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES '+rows.map(()=>'(?,?,?,?,?)').join(',')+' ON CONFLICT(projection,kind,id) DO NOTHING',rows.flatMap(item=>[PROJECTION,item.kind,item.id,item.key,plan.at]));
  report.written+=rows.length;report.requests++;
 }
 const after=await stateOf();
 const mismatched=[...wanted].filter(([id,key])=>after.get(id)!==key).length,extra=[...after.keys()].filter(id=>!wanted.has(id)).length;
 if(mismatched||extra||after.size!==wanted.size)throw new BackfillStop('verify_failed',{mismatched,extra,stored:after.size,planned:wanted.size});
 return {...report,stored:after.size,outcome:'verified'};
}

async function main(){
 const args=process.argv.slice(2),value=name=>{const index=args.indexOf(name);return index>=0?args[index+1]:null;};
 const snapshot=value('--snapshot'),database=value('--database'),d1=value('--target')==='d1';
 if(!snapshot||(!database&&!d1)){console.error('Usage: node scripts/d1-projection-seed.mjs --snapshot <dir> (--database <sqlite file> | --target d1 [--apply])');process.exit(2);}
 if(d1){
  const target=readTarget();
  const result=await seedProjectionD1(createD1Adapter({target,databaseId:target.databaseId}),target,await snapshotChangeKeys(snapshot),{apply:args.includes('--apply')});
  console.log(JSON.stringify(result));
  return;
 }
 const result=await seedProjection(openSqlite(database),await snapshotChangeKeys(snapshot));
 console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error instanceof BackfillStop?JSON.stringify({outcome:'stopped',reason:error.reason,details:error.details}):error.message);process.exit(error instanceof BackfillStop?3:1);});
