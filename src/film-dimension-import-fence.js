// AIR-661 / ADR 0218 (Accepted), decision 7 stage 2. The target contract of the offline importer (W2/W3) and the protected-row predicates.
// Nothing in the Worker imports this module.
//
// Why a write gate and not a production migration: an importer that predates stage 2 checks nothing on its target, and in SQL its statements are
// the same as those of a runtime writer. A trigger on the production schema cannot tell them apart, so it would either let the old importer through
// or refuse the Worker too. Production D1 is not an offline import target: the old `scripts/d1-backfill.mjs` refuses every schema version but 4
// before its first write, and production is far past 4. The offline targets (a local SQLite file, a schema-4 backfill database) get this contract
// instead. It installs, on EVERY table of the target, BEFORE INSERT, UPDATE and DELETE triggers that abort unless a row of
// `offline_import_session` exists. The current importer inserts that row as the first statement of each of its transactions and deletes it as the
// last, so the row exists only inside its own atomic batches and never between them. An old importer never writes the row, so its FIRST write of any
// kind (a person, a receipt, a Film, an identity receipt) is refused: nothing it does lands. The contract row carries the version; the importer reads
// it, the trigger set and the session table before any write and refuses a target that is missing, of another version, incomplete or held open.
// Installing this contract on any non-local database is its own owner GO; it is never part of the production migration chain.

export const OFFLINE_IMPORT_CONTRACT_VERSION=1;
export const OFFLINE_IMPORT_CONTRACT_TABLE='offline_import_contract';
export const OFFLINE_IMPORT_SESSION_TABLE='offline_import_session';
const GATE_TABLES=new Set([OFFLINE_IMPORT_CONTRACT_TABLE,OFFLINE_IMPORT_SESSION_TABLE]);
const OPERATIONS=['insert','update','delete'];
// Tables a target may hold that are not data: SQLite and D1 internals.
const internal=name=>/^sqlite_/.test(name)||/^_cf_/.test(name)||/^d1_/.test(name);
const safeName=name=>{if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))throw new Error('offline_import_fence_table_name');return name;};

export const fenceTriggerName=(table,operation)=>`offline_import_fence_${table}_${operation}`;
export function fenceTriggerSql(table,operation){
 safeName(table);
 return `CREATE TRIGGER ${fenceTriggerName(table,operation)} BEFORE ${operation.toUpperCase()} ON ${table} FOR EACH ROW WHEN NOT EXISTS (SELECT 1 FROM ${OFFLINE_IMPORT_SESSION_TABLE}) BEGIN SELECT RAISE(ABORT, 'offline_import_target_fenced'); END`;
}
const CONTRACT_GUARDS=[
 `CREATE TRIGGER offline_import_contract_no_update BEFORE UPDATE ON ${OFFLINE_IMPORT_CONTRACT_TABLE} BEGIN SELECT RAISE(ABORT, 'offline_import_contract_immutable'); END`,
 `CREATE TRIGGER offline_import_contract_no_delete BEFORE DELETE ON ${OFFLINE_IMPORT_CONTRACT_TABLE} BEGIN SELECT RAISE(ABORT, 'offline_import_contract_immutable'); END`,
];

// The install script for a target whose data tables are `tables` (every user table of the target). It creates the two gate tables, the contract row
// and one trigger per table and operation. It refuses a target that already carries a contract (the PRIMARY KEY of the contract row).
export function offlineImportFenceSql(tables){
 const data=[...new Set(tables)].filter(name=>!internal(name)&&!GATE_TABLES.has(name)).map(safeName).sort();
 if(!data.length)throw new Error('offline_import_fence_no_tables');
 return [
  CONTRACT_TABLE_SQL,
  SESSION_TABLE_SQL,
  `INSERT INTO ${OFFLINE_IMPORT_CONTRACT_TABLE} (id, version, tables_json) VALUES (1, ${OFFLINE_IMPORT_CONTRACT_VERSION}, '${JSON.stringify(data)}')`,
  ...CONTRACT_GUARDS,
  ...data.flatMap(table=>OPERATIONS.map(operation=>fenceTriggerSql(table,operation))),
 ].join(';\n')+';\n';
}
// The tables a schema script creates (and keeps): what offlineImportFenceSql needs for a target built from migration text.
export function schemaTablesOf(sql){
 const created=[...sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>match[1]);
 const gone=new Set([...sql.matchAll(/ALTER TABLE ([A-Za-z_][A-Za-z0-9_]*) RENAME TO/g),...sql.matchAll(/DROP TABLE (?:IF EXISTS )?([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>match[1]));
 const renamed=[...sql.matchAll(/ALTER TABLE [A-Za-z_][A-Za-z0-9_]* RENAME TO ([A-Za-z_][A-Za-z0-9_]*)/g)].map(match=>match[1]);
 return [...new Set([...created.filter(name=>!gone.has(name)),...renamed])];
}
// A schema script followed by its fence: how a target the importer creates (or a test) is built.
export const withOfflineImportFence=sql=>sql.replace(/;\s*$/,'')+';\n'+offlineImportFenceSql(schemaTablesOf(sql));

const normalized=text=>String(text||'').replace(/\s+/g,' ').trim();
// The gate tables are part of the contract: a session table without CHECK (id = 1) could hold a second row that the write triggers (any row) honour
// but a probe of id = 1 never sees, leaving the target open to every old importer.
const CONTRACT_TABLE_SQL=`CREATE TABLE ${OFFLINE_IMPORT_CONTRACT_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, tables_json TEXT NOT NULL) STRICT`;
const SESSION_TABLE_SQL=`CREATE TABLE ${OFFLINE_IMPORT_SESSION_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), opened_at TEXT NOT NULL) STRICT`;
const tableShape=sql=>normalized(sql).replace(/^CREATE TABLE IF NOT EXISTS /i,'CREATE TABLE ');

// Read before any write: the contract version, the exact gate tables, the declared and the actual coverage, the exact trigger of every table and
// operation, and that no session row exists (any row, as the triggers test). `schemaVersions` (optional) also pins the supported schema_contract version
// of the target: the two CLI paths (scripts/offline-import.mjs, scripts/d1-backfill.mjs) pass the versions they can write.
export async function verifyImportFence(db,{schemaVersions=null}={}){
 const objects=await db.all("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','trigger')");
 const tableRows=objects.filter(item=>item.type==='table');
 const tables=tableRows.map(item=>item.name);
 if(!tables.includes(OFFLINE_IMPORT_CONTRACT_TABLE)||!tables.includes(OFFLINE_IMPORT_SESSION_TABLE))return {ok:false,reason:'import_target_unfenced'};
 const shapes=new Map(tableRows.map(item=>[item.name,tableShape(item.sql)]));
 if(shapes.get(OFFLINE_IMPORT_CONTRACT_TABLE)!==CONTRACT_TABLE_SQL||shapes.get(OFFLINE_IMPORT_SESSION_TABLE)!==SESSION_TABLE_SQL)return {ok:false,reason:'import_target_fence_invalid',missing:['gate_table_shape']};
 const contracts=await db.all(`SELECT id,version,tables_json FROM ${OFFLINE_IMPORT_CONTRACT_TABLE}`);
 if(contracts.length!==1||contracts[0].id!==1)return {ok:false,reason:'import_target_unfenced'};
 const contract=contracts[0];
 if(contract.version!==OFFLINE_IMPORT_CONTRACT_VERSION)return {ok:false,reason:'import_target_contract_unsupported',version:contract.version,supported:OFFLINE_IMPORT_CONTRACT_VERSION};
 const data=tables.filter(name=>!internal(name)&&!GATE_TABLES.has(name)).sort();
 let declared;
 try{declared=JSON.parse(contract.tables_json);}catch{declared=null;}
 if(!Array.isArray(declared)||JSON.stringify([...declared].sort())!==JSON.stringify(data))return {ok:false,reason:'import_target_fence_invalid',missing:['declared_coverage']};
 const triggers=new Map(objects.filter(item=>item.type==='trigger').map(item=>[item.name,item]));
 const missing=[];
 for(const table of data)for(const operation of OPERATIONS){
  const found=triggers.get(fenceTriggerName(table,operation));
  if(!found||found.tbl_name!==table||normalized(found.sql)!==normalized(fenceTriggerSql(table,operation)))missing.push(table+':'+operation);
 }
 for(const guard of CONTRACT_GUARDS){const name=guard.split(' ')[2];if(normalized(triggers.get(name)?.sql)!==normalized(guard))missing.push(name);}
 if(missing.length)return {ok:false,reason:'import_target_fence_invalid',missing};
 const open=await db.all(`SELECT id,opened_at FROM ${OFFLINE_IMPORT_SESSION_TABLE}`);
 if(open.length)return {ok:false,reason:'import_target_session_open',openedAt:open[0].opened_at};
 if(schemaVersions){
  const schema=tables.includes('schema_contract')?await db.get('SELECT version FROM schema_contract WHERE id=1'):null;
  const version=schema?.version??null;
  if(!schemaVersions.includes(version))return {ok:false,reason:'import_target_schema_unsupported',version,supported:schemaVersions};
 }
 return {ok:true,version:contract.version};
}

// Every write of the importer goes through the session: each transaction opens and closes the session row inside its own batch, and a write outside
// a transaction becomes a transaction of one. The adapter object is shared with the repositories, so it is patched in place and restored by close().
// The adapter's transaction must be atomic (one BEGIN..COMMIT script or one D1 request), as every importer adapter is.
export function openImportSession(db,{now=()=>new Date().toISOString()}={}){
 // An enclosing session (the backfill opens one before its identity receipt) stays open: the inner close() is a no-op.
 if(db.__importSession)return {close(){}};
 const run=db.run.bind(db),transaction=db.transaction.bind(db);
 let depth=0;
 const sessioned=async fn=>{
  if(depth>0)return fn();
  depth++;
  try{
   let result;
   await transaction(async()=>{
    await run(`INSERT INTO ${OFFLINE_IMPORT_SESSION_TABLE} (id, opened_at) VALUES (1, ?)`,[now()]);
    result=await fn();
    await run(`DELETE FROM ${OFFLINE_IMPORT_SESSION_TABLE} WHERE id = 1`);
   });
   return result;
  }finally{depth--;}
 };
 db.transaction=sessioned;
 db.run=(sql,params=[])=>depth>0?run(sql,params):sessioned(()=>run(sql,params));
 const session={close(){db.run=run;db.transaction=transaction;delete db.__importSession;}};
 db.__importSession=session;
 return session;
}

// The protected-row predicates live in the repository itself (it is bundled and may not import); re-exported here for the importer and tests.
export {DIMENSION_STATUSES,PROTECTED_ROW_SQL,REPLACEABLE_IDENTITY_SQL,PROVISIONAL_LOCALIZATION_SQL,REPLACEABLE_LOCALIZATION_SQL,protectedReasons,provisionalLocalization,replaceableIdentity,replaceableLocalization} from './canonical-repository.js';
