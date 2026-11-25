// AIR-661 / ADR 0218 (Accepted) decision 7 stage 2: the safe offline importer (W2), the retirement fence (W3) and the target-side fence that
// refuses an importer predating stage 2. Real SQLite (the sqlite3 CLI), no Worker, R2, network or production access.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCanonicalRepository} from '../src/canonical-repository.js';
import {createEpgRepository} from '../src/epg-repository.js';
import {createPredictionRepository} from '../src/prediction-repository.js';
import {importBatch} from '../src/offline-importer.js';
import {DIMENSION_STATUSES,FILM_DIMENSION_IMPORT_FENCE_SQL,PROTECTED_ROW_SQL,REPLACEABLE_IDENTITY_SQL,protectedReasons,replaceableIdentity,verifyImportFence} from '../src/film-dimension-import-fence.js';
import {KNOWN_STATUSES} from '../src/domain/film-dimension-parity.js';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-import-fence-'));
const V1=fs.readFileSync('migrations/0001_schema_v1.sql','utf8');
const MIGRATION_0040=fs.readFileSync('migrations/0040_film_dimension_import_fence.sql','utf8');
const AT='2026-11-20T10:00:00.000Z',LATER='2026-11-21T10:00:00.000Z';
let files=0;

// ---- helpers ------------------------------------------------------------------------------------------------------------------------------------------------
const literal=value=>value==null?'NULL':typeof value==='number'?String(value):typeof value==='boolean'?(value?'1':'0'):"'"+String(value).replaceAll("'","''")+"'";
const render=(sql,params=[])=>{let i=0;const text=sql.replace(/\?/g,()=>literal(params[i++]));assert.equal(i,params.length,'every parameter is used');return text;};
function exec(file,sql){const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+sql,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0){const error=new Error(r.stderr||'sqlite failed');error.stderr=r.stderr;throw error;}}
function query(file,sql,params=[]){const r=sqliteSync(['-json','-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+render(sql,params)+';',encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);const t=r.stdout.trim();return t?JSON.parse(t):[];}
// The adapter shape of scripts/offline-import.mjs: reads are single statements, the writes of a transaction go out as one BEGIN..COMMIT script.
// `before` runs once, right before the next transaction is sent (after its plan read the database): the race window.
function openSqlite(file,stats={statements:0}){
 const state={buffer:null,before:null};
 return {
  stats,
  race(fn){state.before=fn;},
  run(sql,params=[]){stats.statements++;const s=render(sql,params)+';';if(state.buffer)state.buffer.push(s);else exec(file,s);return Promise.resolve();},
  get(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params)[0]??null);},
  all(sql,params=[]){if(state.buffer)throw new Error('Read inside the import transaction');return Promise.resolve(query(file,sql,params));},
  async transaction(fn){
   if(state.buffer)return fn();
   state.buffer=[];
   try{await fn();if(state.before){const hook=state.before;state.before=null;hook();}exec(file,'BEGIN;\n'+state.buffer.join('\n')+'\nCOMMIT;\n');}
   finally{state.buffer=null;}
  },
 };
}
function target({fence=true}={}){const file=path.join(root,'t-'+(files++)+'.sqlite');exec(file,V1+(fence?'\n'+FILM_DIMENSION_IMPORT_FENCE_SQL:''));return file;}
const row=(file,id,dimension)=>query(file,'SELECT * FROM film_dimension WHERE film_id=? AND dimension=?',[id,dimension])[0]??null;
const dims=(file,id)=>query(file,'SELECT * FROM film_dimension WHERE film_id=? ORDER BY dimension',[id]);
const filmRow=(file,id)=>query(file,'SELECT id,canonical_identity,original_title FROM film WHERE id=?',[id])[0]??null;
const insert=(table,values)=>`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.values(values).map(literal).join(',')});`;
const dimRow=(film_id,dimension,over={})=>insert('film_dimension',{film_id,dimension,status:{identity:'resolved',metadata:'fresh',localization:'provisional',fingerprint:'current',prediction:'current'}[dimension],source:'legacy',source_version:'v0',provenance_json:null,value:null,authority:null,last_error:'old error',failure_reason:'old',retry_at:AT,attempts:3,next_action:'retry',updated_at:AT,...over});
const state=(dimension,status,extra={})=>({dimension,status,updatedAt:extra.updatedAt||LATER,source:extra.source||'letterboxd',sourceVersion:null,provenance:extra.provenance??null,value:extra.value??null,nextAction:extra.nextAction??'retry',attempts:extra.attempts??2,lastError:extra.lastError??'boom',failureReason:extra.failureReason??'fetch',retryAt:extra.retryAt??LATER});
const film=(id,title,extra={})=>({contractVersion:1,id,canonicalIdentity:extra.canonicalIdentity??null,originalTitle:title,externalIds:[{scheme:'letterboxd',value:id.slice(5),trusted:true,conflicting:false}],aliases:[],identity:state('identity','resolved',{provenance:extra.identityProvenance??null}),metadata:state('metadata','fresh'),fingerprint:state('fingerprint','current'),prediction:state('prediction','current'),localization:state('localization','missing',{nextAction:'none',attempts:0,lastError:null,failureReason:null,retryAt:null})});
// A Film already in the target with every legacy dimension row (processing fields filled, as an old import left them).
function seed(file,id,{identity={},title='Stored Title',identityRow=true}={}){
 exec(file,'PRAGMA foreign_keys=OFF;'+insert('film',{id,contract_version:1,canonical_identity:'tmdb:1',original_title:title,updated_at:AT})+
  (identityRow?dimRow(id,'identity',identity):'')+dimRow(id,'metadata',{status:'reviewed',authority:'owner',provenance_json:'{"authority":"owner"}'})+
  dimRow(id,'fingerprint')+dimRow(id,'prediction'));
}
// seed() runs before the fence exists on the file; a fenced target gets its legacy rows the same way (fence dropped and restored).
function seedFenced(file,id,options){exec(file,'DROP TRIGGER film_dimension_import_fence;');seed(file,id,options);exec(file,FILM_DIMENSION_IMPORT_FENCE_SQL);}
const repoOf=file=>{const db=openSqlite(file);return {db,repo:createCanonicalRepository(db)};};

// ---- 1. Contract pins -------------------------------------------------------------------------------------------------------------------------------------
assert.deepEqual(JSON.parse(JSON.stringify(DIMENSION_STATUSES)),JSON.parse(JSON.stringify(KNOWN_STATUSES)),'the repository statuses are the parity classifier statuses');
assert.ok(MIGRATION_0040.includes(FILM_DIMENSION_IMPORT_FENCE_SQL),'migration 0040 carries exactly the fence the importer checks and creates');
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/film-dimension-import-fence/);
assert.match(fs.readFileSync('scripts/offline-import.mjs','utf8'),/FILM_DIMENSION_IMPORT_FENCE_SQL/,'a file the offline import creates is fenced');

// ---- 2. Migration 0040 on the full chain: applies once after a complete 39, refuses a second apply and an older schema, writes no row --------------------
{
 const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
 assert.equal(names.at(-1),'0040_film_dimension_import_fence.sql');
 const before=names.slice(0,-1).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n');
 const file=path.join(root,'chain.sqlite');exec(file,before);
 const tables=()=>query(file,"SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name");
 const shape=JSON.stringify(tables());
 exec(file,MIGRATION_0040);
 assert.equal(query(file,'SELECT version FROM schema_contract WHERE id=1')[0].version,40);
 assert.equal(JSON.stringify(tables()),shape,'no table changes');
 assert.deepEqual(await verifyImportFence(openSqlite(file)),{ok:true});
 assert.throws(()=>exec(file,MIGRATION_0040),/UNIQUE|constraint/i,'a second apply refuses before any change');
 assert.equal(query(file,'SELECT version FROM schema_contract WHERE id=1')[0].version,40);
 const old=path.join(root,'v38.sqlite');exec(old,names.slice(0,-2).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));
 assert.throws(()=>exec(old,MIGRATION_0040),/UNIQUE|constraint/i,'a schema older than 39 is refused');
 assert.equal(query(old,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='film_dimension_import_fence'")[0].n,0);
 // The fence refuses new fingerprint and prediction rows only: identity, metadata and localization inserts, and UPDATE/DELETE of legacy rows, stay allowed.
 exec(file,"PRAGMA foreign_keys=OFF;"+insert('film',{id:'film:x',contract_version:1,canonical_identity:null,original_title:'X',updated_at:AT})+dimRow('film:x','identity')+dimRow('film:x','metadata')+dimRow('film:x','localization'));
 for(const dimension of ['fingerprint','prediction'])assert.throws(()=>exec(file,dimRow('film:x',dimension)),/film_dimension_import_fence/);
 exec(file,"DROP TRIGGER film_dimension_import_fence;"+dimRow('film:x','fingerprint')+FILM_DIMENSION_IMPORT_FENCE_SQL);
 exec(file,"UPDATE film_dimension SET status='stale' WHERE film_id='film:x' AND dimension='fingerprint';DELETE FROM film_dimension WHERE film_id='film:x' AND dimension='fingerprint';");
}

// ---- 3. An importer that predates stage 2 against a fenced target: its Film unit aborts before any of its mutation lands ---------------------------------
// The exact statement sequence of the pre-AIR-661 writeFilm (src/canonical-repository.js at d3e1a4d): title overwrite, delete of every non-localization
// dimension row, then the four inserts, all in one transaction.
{
 const file=target();seedFenced(file,'film:old',{identity:{status:'reviewed',authority:'owner',provenance_json:'{"authority":"owner","titleSource":{"source":"owner","at":"x"}}'}});
 const before={film:filmRow(file,'film:old'),dims:dims(file,'film:old')};
 const old=['INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET contract_version=excluded.contract_version,canonical_identity=excluded.canonical_identity,original_title=excluded.original_title,updated_at=excluded.updated_at',
  "DELETE FROM film_dimension WHERE film_id='film:old' AND dimension<>'localization'"];
 const params=[['film:old',1,null,'Import Title',LATER],[]];
 const inserts=['identity','metadata','fingerprint','prediction'].map(dimension=>dimRow('film:old',dimension,{updated_at:LATER}));
 assert.throws(()=>exec(file,'BEGIN;\n'+old.map((sql,i)=>render(sql,params[i])+';').join('\n')+'\n'+inserts.join('\n')+'\nCOMMIT;'),/film_dimension_import_fence/);
 assert.deepEqual({film:filmRow(file,'film:old'),dims:dims(file,'film:old')},before,'title, control identity, locked metadata, fingerprint and prediction rows are untouched');
 // The same old sequence on an unfenced target is exactly the loss the fence prevents.
 const open=target({fence:false});seed(open,'film:old',{identity:{status:'reviewed',authority:'owner'}});
 exec(open,'BEGIN;\n'+old.map((sql,i)=>render(sql,params[i])+';').join('\n')+'\n'+inserts.join('\n')+'\nCOMMIT;');
 assert.equal(filmRow(open,'film:old').original_title,'Import Title');
 assert.equal(row(open,'film:old','identity').status,'resolved','without the fence the old importer overwrote the reviewed identity');
}

// ---- 4. The current importer reads the target before any mutation and refuses an unfenced one ---------------------------------------------------------
{
 const file=target({fence:false});
 const db=openSqlite(file);
 const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
 const unit={family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:'sha-a',targetTable:'film',targetId:'film:new',unportable:false,input:{film:film('film:new','New'),watchlist:true}};
 const result=await importBatch(db,repositories,{importedAt:AT,units:[unit]});
 assert.equal(result.stopped,true);
 assert.deepEqual(result.stopReasons,['import_target_unfenced']);
 assert.equal(db.stats.statements,0,'no write statement was sent');
 assert.equal(query(file,'SELECT COUNT(*) AS n FROM film')[0].n,0);
 assert.equal(query(file,'SELECT COUNT(*) AS n FROM import_receipt')[0].n,0);
}

// ---- 5. W2 over a Film with every legacy row: metadata (locked), fingerprint, prediction byte-identical; none inserted; no processing field -------------
{
 const file=target();seedFenced(file,'film:keep');
 exec(file,'DROP TRIGGER film_dimension_import_fence;'+insert('film',{id:'film:unlocked',contract_version:1,canonical_identity:null,original_title:'U',updated_at:AT})+dimRow('film:unlocked','identity')+dimRow('film:unlocked','metadata')+dimRow('film:unlocked','fingerprint',{status:'stale'})+FILM_DIMENSION_IMPORT_FENCE_SQL);
 const {repo}=repoOf(file);
 const legacy=id=>dims(file,id).filter(item=>item.dimension!=='identity'&&item.dimension!=='localization');
 const before={keep:legacy('film:keep'),unlocked:legacy('film:unlocked')};
 const saved=await repo.saveFilm({film:film('film:keep','Import Title')});
 await repo.saveFilm({film:film('film:unlocked','Import U')});
 assert.deepEqual(legacy('film:keep'),before.keep,'locked metadata, fingerprint and prediction rows byte-identical');
 assert.deepEqual(legacy('film:unlocked'),before.unlocked,'unlocked metadata and a stale fingerprint byte-identical');
 // A new Film gets an identity and a localization row only.
 await repo.saveFilm({film:film('film:fresh','Fresh')});
 assert.deepEqual(dims(file,'film:fresh').map(item=>item.dimension),['identity','localization']);
 // The replaceable identity row was rewritten with the import, without processing fields.
 const identity=row(file,'film:keep','identity');
 assert.equal(identity.status,'resolved');assert.equal(identity.updated_at,LATER);
 assert.deepEqual([identity.last_error,identity.failure_reason,identity.retry_at,identity.attempts,identity.next_action],[null,null,null,0,'none']);
 assert.equal(filmRow(file,'film:keep').original_title,'Import Title','a replaceable identity row lets the import write the title');
 assert.equal(saved.originalTitle,'Import Title');
}

// ---- 6. W2 keeps the title, identity and row under every control or unknown_legacy identity row; strips a titleSource it did not rank --------------------
{
 const cases=[
  ['reviewed',{status:'reviewed'}],
  ['owner',{authority:'owner',provenance_json:'{"authority":"owner"}'}],
  ['titleSource',{provenance_json:'{"titleSource":{"source":"tmdb","at":"2026-11-01T00:00:00.000Z"}}'}],
  ['unknown status',{status:'mystery'}],
  ['malformed provenance',{provenance_json:'{not json'}],
  ['array provenance',{provenance_json:'[1]'}],
  ['unknown authority',{authority:'robot'}],
 ];
 for(const [name,identity] of cases){
  const file=target();seedFenced(file,'film:c',{identity});
  const before={film:filmRow(file,'film:c'),dims:dims(file,'film:c').filter(item=>item.dimension!=='localization')};
  const {repo}=repoOf(file);
  const saved=await repo.saveFilm({film:film('film:c','Import Title',{canonicalIdentity:'tmdb:2'})});
  assert.deepEqual({film:filmRow(file,'film:c'),dims:dims(file,'film:c').filter(item=>item.dimension!=='localization')},before,name+': title, identity and every non-localization row kept');
  assert.equal(saved.originalTitle,'Stored Title',name);
 }
 // An import carrying a titleSource of its own does not bind it: the stored identity row has none.
 const file=target();const {repo}=repoOf(file);
 await repo.saveFilm({film:film('film:ts','Imported',{identityProvenance:{titleSource:{source:'owner',at:AT},note:'kept'}})});
 assert.deepEqual(JSON.parse(row(file,'film:ts','identity').provenance_json),{note:'kept'});
 // A second import over it is not blocked by its own row (it stays replaceable).
 await repo.saveFilm({film:film('film:ts','Imported again')});
 assert.equal(filmRow(file,'film:ts').original_title,'Imported again');
}

// ---- 7. JS and SQL predicates agree on the same rows ------------------------------------------------------------------------------------------------
{
 const file=target({fence:false});
 exec(file,'PRAGMA foreign_keys=OFF;'+insert('film',{id:'film:p',contract_version:1,canonical_identity:null,original_title:'P',updated_at:AT}));
 const samples=[];
 const provenances=[null,'{}','null','{"a":1}','{"authority":"owner"}','{"titleSource":null}','{"titleSource":{"source":"tmdb"}}','{bad','[1]','"text"'];
 const authorities=[null,'','owner','dictionary','robot'];
 for(const [dimension,statuses] of Object.entries(KNOWN_STATUSES))for(const status of [...statuses,'mystery'])for(const provenance_json of provenances)for(const authority of authorities)samples.push({dimension,status,provenance_json,authority});
 for(let at=0;at<samples.length;at+=400){
  const chunk=samples.slice(at,at+400);
  const values=chunk.map((item,i)=>`(${at+i},${literal(item.dimension)},${literal(item.status)},${literal(item.provenance_json)},${literal(item.authority)})`).join(',');
  const sql=`WITH s(i,dimension,status,provenance_json,authority) AS (VALUES ${values}) SELECT i,${REPLACEABLE_IDENTITY_SQL} AS replaceable,${PROTECTED_ROW_SQL} AS protected FROM s ORDER BY i`;
  for(const result of query(file,sql)){
   const sample=samples[result.i];
   assert.equal(!!result.protected,protectedReasons(sample).length>0,'protected twin: '+JSON.stringify(sample));
   if(sample.dimension==='identity')assert.equal(!!result.replaceable,replaceableIdentity(sample),'replaceable twin: '+JSON.stringify(sample));
  }
 }
 assert.equal(replaceableIdentity(null),true,'an empty identity slot is replaceable');
}

// ---- 8. Races: a row that becomes control after the plan read is still kept (W2) or still refuses (W3) --------------------------------------------------
{
 const file=target();seedFenced(file,'film:race');
 const {db,repo}=repoOf(file);
 db.race(()=>exec(file,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:race' AND dimension='identity'"));
 await repo.saveFilm({film:film('film:race','Import Title')});
 assert.equal(filmRow(file,'film:race').original_title,'Stored Title','the in-batch guard kept the title');
 assert.equal(row(file,'film:race','identity').status,'reviewed','and the row');
}
{
 const file=target();
 const {db,repo}=repoOf(file);
 await repo.saveFilm({film:film('film:retired','Retired')});
 await repo.saveFilm({film:film('film:survivor','Survivor')});
 const before={films:query(file,'SELECT id FROM film ORDER BY id'),dims:dims(file,'film:retired'),redirects:query(file,'SELECT * FROM film_redirect')};
 db.race(()=>exec(file,"UPDATE film_dimension SET status='reviewed' WHERE film_id='film:retired' AND dimension='localization'"));
 await assert.rejects(()=>repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:retired',to:'film:survivor',at:LATER},releasing:['film:retired']}),/NOT NULL|constraint/i);
 assert.deepEqual(query(file,'SELECT id FROM film ORDER BY id'),before.films,'nothing retired');
 assert.equal(dims(file,'film:retired').length,before.dims.length,'no row of the retired Film deleted');
 assert.deepEqual(query(file,'SELECT * FROM film_redirect'),before.redirects,'no redirect');
}

// ---- 9. W3 refuses a Film holding a protected row at plan time, and retires one holding only replaceable rows -----------------------------------------
{
 for(const [name,over,dimension] of [['metadata lock',{status:'reviewed'},'metadata'],['owner identity',{authority:'owner'},'identity'],['titleSource',{provenance_json:'{"titleSource":{"source":"tmdb"}}'},'identity'],['unknown legacy fingerprint',{authority:'robot'},'fingerprint']]){
  const file=target();
  const {repo}=repoOf(file);
  await repo.saveFilm({film:film('film:survivor','Survivor')});
  exec(file,'DROP TRIGGER film_dimension_import_fence;PRAGMA foreign_keys=OFF;'+insert('film',{id:'film:gone',contract_version:1,canonical_identity:null,original_title:'Gone',updated_at:AT})+dimRow('film:gone',dimension,over)+FILM_DIMENSION_IMPORT_FENCE_SQL);
  const statements=repoOf(file);
  await assert.rejects(()=>statements.repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:gone',to:'film:survivor',at:LATER}}),error=>error.code==='film_retirement_protected_rows'&&error.rows.some(item=>item.dimension===dimension),name);
  assert.equal(statements.db.stats.statements,0,name+': refused at the plan, before any write');
  assert.equal(filmRow(file,'film:gone').original_title,'Gone');
 }
 const file=target();const {repo}=repoOf(file);
 await repo.saveFilm({film:film('film:survivor','Survivor')});
 exec(file,'DROP TRIGGER film_dimension_import_fence;PRAGMA foreign_keys=OFF;'+insert('film',{id:'film:gone',contract_version:1,canonical_identity:null,original_title:'Gone',updated_at:AT})+dimRow('film:gone','identity')+dimRow('film:gone','metadata')+dimRow('film:gone','fingerprint')+FILM_DIMENSION_IMPORT_FENCE_SQL);
 const merged=await repo.applyLink({survivor:film('film:survivor','Survivor'),redirect:{from:'film:gone',to:'film:survivor',at:LATER}});
 assert.equal(merged.id,'film:survivor');
 assert.equal(filmRow(file,'film:gone'),null);
 assert.equal(query(file,"SELECT to_film_id FROM film_redirect WHERE from_id='film:gone'")[0].to_film_id,'film:survivor');
}

// ---- 10. importBatch end to end: replay is idempotent, a kept title is explained (not a conflict), nothing lost; bounded statements per Film ----------
{
 const file=target();seedFenced(file,'film:owned',{identity:{status:'reviewed'}});
 const stats={statements:0};
 const db=openSqlite(file,stats);
 const repositories={canonical:createCanonicalRepository(db),epg:createEpgRepository(db),prediction:createPredictionRepository(db)};
 const unit=(id,title,sha)=>({family:'watchlist',kind:'film',sourceKey:'watchlist.json',sourceSha256:sha,targetTable:'film',targetId:id,unportable:false,input:{film:film(id,title),watchlist:true}});
 const units=[unit('film:owned','Import Title','sha-1'),...Array.from({length:5},(_,i)=>unit('film:n'+i,'Title '+i,'sha-n'+i))];
 const before=dims(file,'film:owned');
 const first=await importBatch(db,repositories,{importedAt:AT,units});
 assert.equal(first.stopped,false,JSON.stringify(first.stopReasons));
 assert.equal(first.explained,1);
 assert.equal(first.ledger.find(item=>item.targetId==='film:owned')?.reason,'identity_control_kept');
 assert.equal(first.applied,5);
 assert.deepEqual(dims(file,'film:owned').filter(item=>item.dimension!=='localization'),before,'the owned Film kept every row');
 assert.equal(filmRow(file,'film:owned').original_title,'Stored Title');
 const perFilm=(stats.statements)/units.length;
 assert.ok(perFilm<=40,'bounded statements per Film unit: '+perFilm);
 const snapshot=JSON.stringify(query(file,'SELECT * FROM film_dimension ORDER BY film_id,dimension'))+JSON.stringify(query(file,'SELECT * FROM film ORDER BY id'));
 const again=await importBatch(db,repositories,{importedAt:AT,units});
 assert.equal(again.applied,0);
 assert.equal(JSON.stringify(query(file,'SELECT * FROM film_dimension ORDER BY film_id,dimension'))+JSON.stringify(query(file,'SELECT * FROM film ORDER BY id')),snapshot,'a replay changes nothing');
 assert.equal(query(file,"SELECT COUNT(*) AS n FROM film_dimension WHERE dimension IN ('fingerprint','prediction') AND film_id LIKE 'film:n%'")[0].n,0,'no derived row inserted');
}

console.log('film-dimension-import-fence: migration 0040 applies once after 39 and pins the importer fence; an old importer aborts on a fenced target with nothing changed; the current importer refuses an unfenced target before any write; W2 keeps metadata, fingerprint and prediction rows byte-identical, inserts none, writes no processing field, keeps the title under every control or unknown_legacy identity row and binds no imported titleSource; W3 refuses protected rows at the plan and in the batch; JS and SQL predicates agree; replay is idempotent and bounded');
