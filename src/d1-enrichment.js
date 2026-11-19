// AIR-537 slice 3 (ADR 0155, ADR 0162): the enrichment projector itself is retired. Its runner (`runD1EnrichmentProjection`), the
// R2 reads, the checkpoint diff and the `legacy`/`r2`/`prepared` D1 write arms were unreachable in production after AIR-308 (the
// Worker cron does not call them; `D1_ENRICHMENT_WRITE`, `D1_ENRICHMENT_WINDOW` and `D1_ENRICHMENT_BULK` are retired and ignored)
// and were removed. Film/Person writes are the fenced D1 adapters; R2 holds the immutable sources.
// What remains is the read-only status for /api/d1/status (src/catalog-d1.js). Retired, never written by this module: `mode` and
// `windowMode` are always null. The `projector_window` table and the Discovery fences that read it live in src/discovery-authority.js.
const D1_ENRICHMENT_PROJECTION='enrichment';
const METADATA_SYNC_PROJECTION='metadata_sync';

// The read-only status of the projector for /api/d1/status. schema is true for the whole of migration 0004 (its three tables
// and schema_contract version 4), for migration 0005 (those tables, film_sync_state and version 5), for migration 0006
// (those plus metadata_cache, metadata_cache_authority, metadata_cache_cas and version 6), and for version 7 or newer
// when the ten prediction-domain tables are all present or all absent. A partial prediction domain is false.
// A later additive version without those tables stays true: another migration may have advanced the contract.
// Version 4 stays true when the sync table is absent. Version 5 stays true when the cache tables are absent.
// Version 6 stays true when the prediction-domain tables are absent.
// ownerReviewMode is reported only when the three owner-review tables exist; version 9 is not that proof by itself.
async function d1EnrichmentStatus(binding,env){
 const mode=null;
 const present=((await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projection_state','projection_run','projection_fence','film_sync_state','metadata_cache','metadata_cache_authority','metadata_cache_cas','prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent')").bind().all()).results||[]).map(row=>row.name);
 const tables=present.filter(name=>name==='projection_state'||name==='projection_run'||name==='projection_fence').sort();
 const syncTable=present.includes('film_sync_state');
 const cacheReady=present.includes('metadata_cache')&&present.includes('metadata_cache_authority')&&present.includes('metadata_cache_cas');
 const predictionNames=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
 const predictionReady=predictionNames.every(name=>present.includes(name));
 const predictionAbsent=predictionNames.every(name=>!present.includes(name));
 const version=(await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first())?.version??null;
 if(tables.length!==3||!(version===4||(version===5&&syncTable)||(version===6&&syncTable&&cacheReady)||(Number(version)>=7&&syncTable&&cacheReady&&(predictionReady||predictionAbsent))))return {mode,retired:true,schema:false,schemaVersion:version,projectionTables:tables};
 const [run,counts]=await Promise.all([
  binding.prepare('SELECT lease_until leaseUntil,started_at startedAt,finished_at finishedAt,outcome,summary_json summary FROM projection_run WHERE projection=?').bind(D1_ENRICHMENT_PROJECTION).first(),
  binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent,MAX(projected_at) AS lastWriteAt FROM projection_state WHERE projection=?").bind(D1_ENRICHMENT_PROJECTION).first(),
 ]);
 let summary=null;try{summary=run?.summary?JSON.parse(run.summary):null;}catch{}
 const lastWriteAt=counts?.lastWriteAt||null,lastWriteMs=Date.parse(lastWriteAt||'');
 const status={mode,retired:true,schema:true,checkpoints:counts?.total??0,absent:counts?.absent??0,lastWriteAt,lastWriteAgeSec:Number.isFinite(lastWriteMs)?Math.max(0,Math.round((Date.now()-lastWriteMs)/1000)):null,windowMode:null,lastRun:run?{startedAt:run.startedAt,finishedAt:run.finishedAt,outcome:run.outcome,leaseHeld:!!run.leaseUntil,summary}:null};
 if(Number(version)>=5){
  const sync=await binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent FROM projection_state WHERE projection=?").bind(METADATA_SYNC_PROJECTION).first();
  status.schemaVersion=version;status.syncCheckpoints=sync?.total??0;status.syncAbsent=sync?.absent??0;
 }
 if(Number(version)>=6){
  const marker=await binding.prepare('SELECT mode AS cacheMode, cache_generation AS cacheGeneration, mirror_generation AS mirrorGeneration FROM metadata_cache_authority WHERE id=1').bind().first();
  status.cacheMode=marker?.cacheMode??null;status.cacheGeneration=marker?.cacheGeneration??null;status.mirrorGeneration=marker?.mirrorGeneration??null;
  const ownerNames=((await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('owner_review_entry','owner_review_authority','owner_review_cas')").bind().all()).results||[]).map(row=>row.name);
  if(ownerNames.length===3){
   const owner=await binding.prepare('SELECT mode AS ownerReviewMode, generation AS ownerReviewGeneration FROM owner_review_authority WHERE id=1').bind().first();
   status.ownerReviewMode=owner?.ownerReviewMode??null;status.ownerReviewGeneration=owner?.ownerReviewGeneration??null;
  }
 }
 if(Number(version)>=7&&predictionReady){
  const marker=await binding.prepare('SELECT mode AS predictionMode, generation AS predictionGeneration, queue_generation AS queueGeneration, profile_generation AS profileGeneration, writes AS predictionWrites FROM prediction_domain_authority WHERE id=1').bind().first();
  status.predictionMode=marker?.predictionMode??null;status.predictionGeneration=marker?.predictionGeneration??null;status.queueGeneration=marker?.queueGeneration??null;status.profileGeneration=marker?.profileGeneration??null;status.predictionWrites=marker?.predictionWrites??null;
 }
 return status;
}
