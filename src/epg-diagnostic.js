// AIR-453 / ADR 0121. The isolated execution context of the EPG diagnostic canary, INERT: nothing here is wired to a route, a Workflow
// binding, a flag or a schedule, and `fromWorkerEnv` answers `diagnostic_bindings_absent` (and writes nothing) while the Worker has no
// diagnostic bindings, which is the case until the owner provisions them (AIR-456).
//
// The canary runs the REAL seal path (`planDiscoveryLedger`, `writeLedgerSegment`, `EpgOrchestration.assertStep`, the Discovery and
// published-generation fences). Every function of that path takes the storage it works on from its `env` argument, so the isolation is made
// by the `env` it is handed, not by a second algorithm: a strict allowlist built from scratch (never `{...env}` with two bindings swapped),
// holding the diagnostic D1 and bucket behind guards, and none of the production bindings, secrets or Workflow handles.
//
// What this is NOT: a platform privilege boundary. The same Worker is bound to the production resources too, so a routing defect in other
// code could still address them; this module bounds what the diagnostic path is given, refuses a contradictory context before a mutation, and
// makes a misrouting visible (denied binding names throw). The residual risk is stated in ADR 0121.
//
// Domain identity: the diagnostic D1 (table `epg_diagnostic_identity`, diagnostic-migrations/0001) and the diagnostic bucket (object
// `diagnostic/identity.json`) each hold the same {domain, resourceId}. A guarded write is refused until `verify` has read both and found them
// equal to the context's expected resourceId; a production database or bucket has no such record, so a mis-supplied one is refused before the
// first mutation. `provision` writes the identity only into an EMPTY database and an EMPTY bucket (a production bucket is never empty).
// Concatenated into the Worker like the other server modules: one global.
const EpgDiagnostic=(()=>{
 const DOMAIN='epg-diagnostic';
 const IDENTITY_OBJECT='diagnostic/identity.json',IDENTITY_TABLE='epg_diagnostic_identity';
 // The Worker env names under which the owner will bind the diagnostic resources (AIR-456). Absent today.
 const BINDING_NAMES={db:'EPG_DIAGNOSTIC_DB',bucket:'EPG_DIAGNOSTIC_BUCKET'};
 // The only keys a diagnostic env may carry. The step, fence and generation-pin carriers (`epgStep`, `epgFence`, `discoveryLease`, `epgPin`: values the executor and the readers set on a copy, never a binding) are set by the executor on a copy.
 const ALLOWED=new Set(['DB','BUCKET','DISCOVERY_LEDGER_MODE','epgDiagnostic','epgStep','epgFence','discoveryLease','epgPin']);
 const CARRIERS=new Set(['epgStep','epgFence','discoveryLease','epgPin']);
 const LEDGER_MODES=new Set(['bounded','frozen','full']);
 // Production bindings, secrets and Workflow handles. A read of one of these names on a diagnostic env is a misrouting and throws.
 const DENIED=['EPG_WORKFLOW','DISCOVERY_WORKFLOW','RATINGS_WORKFLOW','EPG_XML_URL','LETTERBOXD_USERNAME','TMDB_API_READ_ACCESS_TOKEN','TMDB_REQUEST_INTERVAL_MS','MONITOR','MONITOR_WEBHOOK_URL','MONITOR_HEARTBEAT_URL','MONITOR_TRANSPORT','MONITOR_TELEGRAM_BOT_TOKEN','MONITOR_TELEGRAM_CHAT_ID','MCP_ACCESS_AUD','MCP_ACCESS_TEAM_DOMAIN','MIGRATION_EXPORT_ENABLED','MIGRATION_EXPORT_KEY','MIGRATION_EXPORT_SITE_ID','D1_ENRICHMENT_WRITE','DISCOVERY_EXECUTOR','LIFECYCLE_LOCALIZATION','FOOTER_SOURCE_TIMEOUT_MS','RATINGS_DB_REQUIRED','PREDICTION_DB_REQUIRED'];
 const deniedError=name=>Object.assign(new Error('diagnostic_binding_denied'),{code:'diagnostic_binding_denied',binding:name});
 const refusal=(reason,extra={})=>({ok:false,reason,...extra});
 // Fail closed: a statement is a read only if it starts with SELECT (or WITH) and names no write keyword anywhere; anything else, a leading comment included, needs the verified identity.
 const READ_START=/^\s*(?:SELECT|WITH)\b/i,WRITE_WORD=/\b(?:INSERT|UPDATE|DELETE|REPLACE|DROP|ALTER|CREATE|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE)\b/i;
 const isWrite=sql=>{const text=String(sql);return !READ_START.test(text)||WRITE_WORD.test(text);};
 // Tables whose single row the migration chain itself inserts (the control and marker rows); every other table must be empty. A migration that seeds one more
 // makes `provision` refuse (fail closed) until it is listed here; the test applies the whole chain and provisions, so the omission shows in CI.
 const SEEDED=new Set(['schema_contract','metadata_cache_authority','metadata_cache_cas','prediction_domain_authority','prediction_domain_cas','published_epg_authority','published_epg_cas','owner_review_authority','owner_review_cas','ratings_domain_authority','ratings_domain_cas','discovery_authority','discovery_cas','discovery_transfer','discovery_lease','discovery_continuation','discovery_status','discovery_checkpoint','discovery_workflow','discovery_seal','film_person_authority','film_person_cas','film_person_baseline','projector_window']);
 const hasD1=db=>!!db&&typeof db.prepare==='function'&&typeof db.batch==='function';
 const hasBucket=bucket=>!!bucket&&['get','put','head','delete'].every(name=>typeof bucket[name]==='function');
 const newStats=()=>({d1:{reads:0,writes:0,batches:0},r2:{reads:0,writes:0,deletes:0,heads:0,lists:0},denied:0,refusedWrites:0});

 // ---- the guarded storage ---------------------------------------------------------------------------------
 // `gate()` throws until the identity has been verified for this context; it is called before every write, never for a read.
 function guardD1(db,state){
  const wrapStatement=(statement,sql)=>{
   const write=isWrite(sql);
   const out={
    _write:write,_inner:statement,
    bind:(...values)=>wrapStatement(statement.bind(...values),sql),
    async run(){if(write)state.gate();const r=await statement.run();write?state.stats.d1.writes++:state.stats.d1.reads++;return r;},
    async first(...a){if(write)state.gate();const r=await statement.first(...a);write?state.stats.d1.writes++:state.stats.d1.reads++;return r;},
    async all(){if(write)state.gate();const r=await statement.all();write?state.stats.d1.writes++:state.stats.d1.reads++;return r;},
    async raw(...a){if(write)state.gate();const r=await statement.raw(...a);write?state.stats.d1.writes++:state.stats.d1.reads++;return r;},
   };
   return out;
  };
  return {
   prepare:sql=>wrapStatement(db.prepare(sql),sql),
   async batch(statements){
    const list=Array.isArray(statements)?statements:[];
    // A statement that is not one of this guard's own is a statement that was prepared elsewhere: refused whole, nothing runs.
    if(list.some(item=>!item||typeof item._inner!=='object'))throw Object.assign(new Error('diagnostic_foreign_statement'),{code:'diagnostic_foreign_statement'});
    const writes=list.filter(item=>item._write).length;
    if(writes)state.gate();
    const r=await db.batch(list.map(item=>item._inner));
    state.stats.d1.batches++;state.stats.d1.writes+=writes;state.stats.d1.reads+=list.length-writes;
    return r;
   },
   async exec(){throw Object.assign(new Error('diagnostic_exec_refused'),{code:'diagnostic_exec_refused'});},
  };
 }
 function guardBucket(bucket,state){
  const counted=(group,name,run)=>async(...args)=>{state.stats.r2[name]++;return run(...args);};
  const out={
   get:counted('r2','reads',(...a)=>bucket.get(...a)),
   head:counted('r2','heads',(...a)=>bucket.head(...a)),
   async put(...a){state.gate();const r=await bucket.put(...a);state.stats.r2.writes++;return r;},
   async delete(...a){state.gate();const r=await bucket.delete(...a);state.stats.r2.deletes++;return r;},
  };
  if(typeof bucket.list==='function')out.list=counted('r2','lists',(...a)=>bucket.list(...a));
  return out;
 }

 // ---- the context --------------------------------------------------------------------------------------------
 // `production` (optional, the Worker's own DB and BUCKET) lets the caller state what the diagnostic bindings must NOT be: the same object,
 // under any alias, is a contradictory context and is refused. The expected resourceId names the diagnostic domain the owner provisioned.
 function create({DB,BUCKET,resourceId,ledgerMode='bounded',production=null}={}){
  if(typeof resourceId!=='string'||!/^[a-z0-9][a-z0-9-]{7,63}$/.test(resourceId))return refusal('context_malformed',{field:'resourceId'});
  if(!hasD1(DB))return refusal('context_malformed',{field:'DB'});
  if(!hasBucket(BUCKET))return refusal('context_malformed',{field:'BUCKET'});
  if(!LEDGER_MODES.has(ledgerMode))return refusal('context_malformed',{field:'ledgerMode'});
  if(DB===BUCKET)return refusal('context_contradictory',{field:'DB'});
  if(production){
   if(production.DB&&(production.DB===DB))return refusal('context_contradictory',{field:'DB'});
   if(production.BUCKET&&(production.BUCKET===BUCKET))return refusal('context_contradictory',{field:'BUCKET'});
  }
  const state={verified:false,resourceId,stats:newStats(),gate(){if(!state.verified){state.stats.refusedWrites++;throw Object.assign(new Error('diagnostic_unverified'),{code:'diagnostic_unverified'});}}};
  const allowed={DB:guardD1(DB,state),BUCKET:guardBucket(BUCKET,state),DISCOVERY_LEDGER_MODE:ledgerMode,epgDiagnostic:Object.freeze({domain:DOMAIN,resourceId})};
  // The real executor code sets `epgStep`, `epgFence` and `discoveryLease` on an env it copies; those are the only other own keys it may carry.
  const env=new Proxy(allowed,{
   get(target,name){
    if(typeof name==='string'&&DENIED.includes(name)){state.stats.denied++;throw deniedError(name);}
    return target[name];
   },
   set(target,name,value){
    if(!ALLOWED.has(name)){state.stats.denied++;throw deniedError(String(name));}
    target[name]=value;return true;
   },
   has(target,name){return Object.hasOwn(target,name);},
   // Only the step and fence carriers may be removed; the storage and the identity of the context cannot be.
   deleteProperty(target,name){if(!CARRIERS.has(name)){state.stats.denied++;throw deniedError(String(name));}delete target[name];return true;},
  });
  return {ok:true,env,resourceId,stats:()=>JSON.parse(JSON.stringify(state.stats)),verified:()=>state.verified,
   // Reads the identity of both resources through the UNGUARDED handles (reads only). Both must hold this domain and this resourceId.
   async verify(){
    let d1;try{d1=await DB.prepare('SELECT domain, resource_id FROM '+IDENTITY_TABLE+' WHERE id=1').bind().first();}catch{return refusal('identity_unreadable',{resource:'d1'});}
    if(!d1)return refusal('identity_missing',{resource:'d1'});
    let object;try{object=await BUCKET.get(IDENTITY_OBJECT);}catch{return refusal('identity_unreadable',{resource:'r2'});}
    if(!object)return refusal('identity_missing',{resource:'r2'});
    let record;try{record=await object.json();}catch{return refusal('identity_malformed',{resource:'r2'});}
    if(d1.domain!==DOMAIN||d1.resource_id!==resourceId)return refusal('identity_mismatch',{resource:'d1'});
    if(record?.domain!==DOMAIN||record?.resourceId!==resourceId)return refusal('identity_mismatch',{resource:'r2'});
    state.verified=true;
    return {ok:true,resourceId};
   },
  };
 }

 // The Worker env's diagnostic bindings, if any. Reads two property names and nothing else; creates no Workflow and writes nothing.
 function fromWorkerEnv(workerEnv,{resourceId,ledgerMode}={}){
  const DB=workerEnv?.[BINDING_NAMES.db],BUCKET=workerEnv?.[BINDING_NAMES.bucket];
  if(DB===undefined&&BUCKET===undefined)return refusal('diagnostic_bindings_absent');
  if(DB===undefined||BUCKET===undefined)return refusal('diagnostic_bindings_incomplete');
  return create({DB,BUCKET,resourceId,ledgerMode,production:{DB:workerEnv.DB,BUCKET:workerEnv.BUCKET}});
 }

 // ---- provisioning identity (used by AIR-456's operation, tested here) ----------------------------------------
 // Writes the identity into a database and a bucket that are both EMPTY of everything but the schema: the diagnostic D1 holds the production
 // chain of migrations (schema only) plus diagnostic-migrations/0001; a production database has rows, a production bucket has objects.
 async function provision({DB,BUCKET,resourceId}={}){
  if(typeof resourceId!=='string'||!/^[a-z0-9][a-z0-9-]{7,63}$/.test(resourceId))return refusal('context_malformed',{field:'resourceId'});
  if(!hasD1(DB)||!hasBucket(BUCKET)||typeof BUCKET.list!=='function')return refusal('context_malformed');
  let tables;try{tables=(await DB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").bind().all()).results||[];}catch{return refusal('identity_unreadable',{resource:'d1'});}
  if(!tables.some(row=>row.name===IDENTITY_TABLE))return refusal('schema_missing');
  // Any row of any table, other than the identity table and the singleton rows that the migrations themselves seed, means this is not an empty diagnostic database.
  for(const {name} of tables){
   if(name===IDENTITY_TABLE||SEEDED.has(name))continue;
   const row=await DB.prepare('SELECT 1 AS present FROM "'+String(name).replace(/"/g,'')+'" LIMIT 1').bind().first();
   if(row)return refusal('domain_not_empty',{resource:'d1'});
  }
  if(await DB.prepare('SELECT 1 AS present FROM '+IDENTITY_TABLE+' LIMIT 1').bind().first())return refusal('identity_exists',{resource:'d1'});
  const listed=await BUCKET.list({limit:1});
  if((listed?.objects||[]).length)return refusal('domain_not_empty',{resource:'r2'});
  const now=new Date().toISOString();
  const stored=await BUCKET.put(IDENTITY_OBJECT,JSON.stringify({domain:DOMAIN,resourceId,createdAt:now}),{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:'application/json'}});
  if(stored===null)return refusal('identity_exists',{resource:'r2'});
  await DB.prepare('INSERT INTO '+IDENTITY_TABLE+' (id, domain, resource_id, created_at) SELECT 1, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM '+IDENTITY_TABLE+' WHERE id=1)').bind(DOMAIN,resourceId,now).run();
  return {ok:true,resourceId};
 }
 return {DOMAIN,IDENTITY_OBJECT,IDENTITY_TABLE,BINDING_NAMES,ALLOWED,DENIED,create,fromWorkerEnv,provision,isWrite};
})();
