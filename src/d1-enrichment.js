// AIR-275 phase 2 (ADR 0056): the enrichment projector. R2 stays authoritative; D1 follows it.
// One run reads the R2 records the enrichment writers keep (watchlist, programme, metadata, people, titles, the catalog of
// discovered films, the discovery resolution and the Letterboxd diary), builds the whole Film/Person view with the same reader and
// the same derivation as the offline import, and compares each Film and Person with the change key D1 holds for it. Only a changed
// one is written, in one D1 batch that also stores its new key, so a key never claims a write that did not commit. A Film no R2
// source lists any more loses its watchlist membership and is marked absent. The run works from a cron trigger, never from a sync
// or discovery step, so it adds nothing to the R2 pipeline. D1_ENRICHMENT_WRITE: off (default) reads nothing; dry reads R2 and
// the D1 keys and logs the diff without writing; on writes. Every batch starts with the lease fence, so a run that lost its lease
// writes nothing and an older run cannot overwrite a newer one.
const D1_ENRICHMENT_PROJECTION='enrichment';
const METADATA_SYNC_PROJECTION='metadata_sync';
const D1_ENRICHMENT_LEASE_MS=10*60000;
const D1_ENRICHMENT_QUERY_BUDGET=800;
const D1_ENRICHMENT_WALL_MS=60000;
const D1_ENRICHMENT_PERSON_BATCH=25;
// Guards against input that is well formed but incomplete, such as an empty or truncated watchlist. Both are absolute: the size
// of the projection does not widen them. A run past either writes nothing; a real mass removal goes through a reload instead.
const D1_ENRICHMENT_ABSENT_FILMS=25,D1_ENRICHMENT_ABSENT_PEOPLE=250;
const D1_ENRICHMENT_MEMBERSHIP_MIN=5,D1_ENRICHMENT_MEMBERSHIP_SHARE=0.02;
const D1_ENRICHMENT_FENCE='INSERT INTO projection_fence (held) SELECT COUNT(*) FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?';
const D1_ENRICHMENT_STATE="INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES (?,?,?,?,?) ON CONFLICT(projection,kind,id) DO UPDATE SET change_key=excluded.change_key,projected_at=excluded.projected_at";

function d1EnrichmentMode(env){const value=env?.D1_ENRICHMENT_WRITE;return value==='on'?'on':value==='dry'?'dry':'off';}

// The repository's database interface over the D1 binding. Reads go out at once and count against the run's query budget.
// Writes inside transaction() are collected and sent as one db.batch, which D1 applies atomically.
function d1EnrichmentAdapter(binding){
 let buffer=null,queries=0;
 const statement=(sql,params)=>binding.prepare(sql).bind(...params);
 return {
  get queries(){return queries;},
  async get(sql,params=[]){queries++;return (await statement(sql,params).first())??null;},
  async all(sql,params=[]){queries++;return (await statement(sql,params).all()).results||[];},
  async run(sql,params=[]){if(buffer){buffer.push(statement(sql,params));return;}queries++;await statement(sql,params).run();},
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];let statements;
   try{await fn();statements=buffer;}finally{buffer=null;}
   if(statements.length){queries++;await binding.batch(statements);}
  },
 };
}

// The inputs fail closed. Every object the view needs must be present and of its shape: a missing object stops the run before
// any D1 write, while a present, empty one is a real empty dataset. Two objects are optional: the Letterboxd diary, absent while its
// own switch is off, and the owner-approved TMDB retirements (ADR 0057), absent until a correction is approved. A retirements
// object that is present but fails its check as a whole stops the run as input_invalid. The read must also be one consistent cut
// of R2:
// - it does not start while a writer of these objects is at work: a live discovery lease, or a sync in its metadata or EPG stage;
// - the programme and the catalog come from the copies of the one generation the pointer names as published, never the root ones;
// - after every read, each object is checked again by its etag, and the writer checks are repeated. The published generation's
//   catalog and the resolution are updated in place, so the same programmeRunId does not prove the same content. Any change
//   defers the run before any D1 write; the next hourly run reads again.
class D1EnrichmentInputError extends Error{constructor(reason,key){super(reason+(key?': '+key:''));this.reason=reason;this.key=key||null;}}
const D1_ENRICHMENT_DEFERRED=['writer_active','input_changed'];
const d1EnrichmentRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const d1EnrichmentFilmList=value=>d1EnrichmentRecord(value)&&Array.isArray(value.films);
async function d1EnrichmentRead(env,etags,key,shape,required=true){
 const object=await env.BUCKET.get(key);
 etags.set(key,object?.etag??null);
 if(!object){if(required)throw new D1EnrichmentInputError('input_missing',key);return null;}
 let value;
 try{value=await object.json();}catch{throw new D1EnrichmentInputError('input_invalid',key);}
 if(!shape(value))throw new D1EnrichmentInputError('input_invalid',key);
 return value;
}
async function d1EnrichmentWritersIdle(env,now=Date.now()){
 const [lease,sync]=await Promise.all([DISCOVERY_LEASE_KEY,'sync.json'].map(async key=>{const object=await env.BUCKET.get(key);try{return object?await object.json():null;}catch{return null;}}));
 if(Number(lease?.expiresAt)>now)throw new D1EnrichmentInputError('writer_active',DISCOVERY_LEASE_KEY);
 if(['metadata','epg'].includes(sync?.stage)&&now-Date.parse(sync.updatedAt)<15*60000)throw new D1EnrichmentInputError('writer_active','sync.json');
}
async function d1EnrichmentStore(env){
 const etags=new Map();
 await d1EnrichmentWritersIdle(env);
 const pointer=await d1EnrichmentRead(env,etags,EPG_GENERATION_KEY,d1EnrichmentRecord);
 if(pointer.phase!=='published'||typeof pointer.programmeRunId!=='string'||!pointer.programmeRunId)throw new D1EnrichmentInputError('generation_unpublished',EPG_GENERATION_KEY);
 const runId=pointer.programmeRunId;
 const [watchlist,programme,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory,tmdbRetirements]=await Promise.all([
  d1EnrichmentRead(env,etags,'watchlist.json',d1EnrichmentFilmList),
  d1EnrichmentRead(env,etags,epgGenerationKey(runId,'programme.json'),d1EnrichmentFilmList),
  d1EnrichmentRead(env,etags,'metadata.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'titles.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'people.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,epgGenerationKey(runId,'discovered-films.json'),d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'epg/discovery-resolution.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'letterboxd/diary/history.json',d1EnrichmentRecord,false),
  d1EnrichmentRead(env,etags,TMDB_RETIREMENTS_KEY,d1EnrichmentRecord,false),
 ]);
 for(const [key,etag] of etags)if(((await env.BUCKET.head(key))?.etag??null)!==etag)throw new D1EnrichmentInputError('input_changed',key);
 await d1EnrichmentWritersIdle(env);
 const store=EnrichmentProjection.enrichmentStore({watchlist,programme,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory,tmdbRetirements,filmTitles:FILM_TITLE_DICTIONARY,personNames:PERSON_NAME_DICTIONARY,personOverrides:{'actor/chris-pratt':REVIEWED_PEOPLE['actor/chris-pratt']}});
 return {store,programmeRunId:runId};
}

// The plan of one run: every Person and Film whose change key differs from the stored one, and every stored entity the view
// no longer has. Persons come first so a Film's credits find their people. A held Film (a TMDB retirement under owner review,
// ADR 0057) is neither written nor released, whether or not the view still has it: D1 keeps it as it is until the review
// settles.
function d1EnrichmentPlan(inputs,stored,nowIso,held=new Set()){
 const people=[],films=[],absent=[],seen=new Set();
 for(const entry of inputs.people){
  const key=EnrichmentProjection.personChangeKey(entry,nowIso);
  seen.add('person\n'+entry.id);
  if(stored.get('person\n'+entry.id)!==key)people.push({...entry,key});
 }
 for(const entry of inputs.films){
  const key=EnrichmentProjection.filmChangeKey(entry,nowIso);
  seen.add('film\n'+entry.id);
  if(held.has(entry.id))continue;
  if(stored.get('film\n'+entry.id)!==key)films.push({...entry,key});
 }
 for(const [id,key] of stored){
  if(seen.has(id)||key==='absent')continue;
  const [kind,entityId]=id.split('\n');
  if(kind==='film'&&held.has(entityId))continue;
  absent.push({kind,id:entityId});
 }
 return {people,films,absent};
}

async function runD1EnrichmentProjection(env,{now=Date.now(),trigger='cron',queryBudget=D1_ENRICHMENT_QUERY_BUDGET,wallMs=D1_ENRICHMENT_WALL_MS}={}){
 const mode=d1EnrichmentMode(env);
 if(mode==='off')return {mode,skipped:'off'};
 if(!env.DB||!env.BUCKET)return {mode,skipped:'binding_missing'};
 const started=Date.now(),nowIso=new Date(now).toISOString(),db=d1EnrichmentAdapter(env.DB),leaseId=crypto.randomUUID();
 const summary={projection:D1_ENRICHMENT_PROJECTION,mode,trigger,startedAt:nowIso,version:EnrichmentProjection.ENRICHMENT_PROJECTION_VERSION};
 if(mode==='on'&&!(await d1EnrichmentLease(db,leaseId)))return {...summary,skipped:'lease_held'};
 try{
  const plan=await d1EnrichmentDiff(env,db,now,summary);
  // More absences or lost watchlist memberships than a routine sync explains point at broken input: nothing is written.
  const guard=d1EnrichmentGuard(plan,summary);
  if(guard){summary.outcome=guard;return summary;}
  if(mode==='dry'){summary.outcome='dry';return summary;}
  const written=await d1EnrichmentWrite(db,plan,{leaseId,started,queryBudget,wallMs});
  Object.assign(summary,written,{outcome:written.leaseLost?'lease_lost':written.errorCount?'partial':written.remaining?'budget':'complete'});
  return summary;
 }catch(error){
  summary.outcome='failed';summary.error=String(error?.message||error).slice(0,200);
  if(error instanceof D1EnrichmentInputError){summary.reason=error.reason;summary.inputKey=error.key;if(D1_ENRICHMENT_DEFERRED.includes(error.reason))summary.outcome='deferred';}
  return summary;
 }finally{
  summary.queries=db.queries;summary.durationMs=Date.now()-started;
  if(mode==='on')await d1EnrichmentRelease(db,leaseId,summary).catch(()=>{});
  console.log(JSON.stringify({event:'d1_enrichment_projection',...summary}));
 }
}

// The R2 records, the view and every input live only inside this function: once it returns, only the changed entries remain,
// so the write phase does not hold the whole view (about 50 MB of heap on the 2026-10-29 snapshot, ADR 0056).
async function d1EnrichmentDiff(env,db,now,summary){
 const started=Date.now(),nowIso=new Date(now).toISOString();
 const {store,programmeRunId}=await d1EnrichmentStore(env);
 summary.programmeRunId=programmeRunId;
 summary.loadMs=Date.now()-started;
 // Schema v6 and every later version can name a D1 metadata cache. v4 and v5 keep the R2 object
 // and do not query the cache tables. Mode d1 replaces that object before the view is built.
 // Version 6 or newer without the cache tables or a valid marker fails the run before any write
 // and does not project from the R2 object. A failed cache read does the same.
 // Version 7 or newer also requires the prediction-domain tables and a valid marker. The projector
 // does not write that domain. A missing table fails the run before any write. A later additive
 // version keeps that rule; it does not drop the domain back onto R2.
 const version=(await db.get('SELECT version FROM schema_contract WHERE id=1'))?.version??null;
 summary.schemaVersion=version;
 if(Number(version)>=6){
  try{await MetadataCache.useAuthoritativeMetadata(db,store);}
  catch(error){if(error?.code==='metadata_cache_unavailable')throw new D1EnrichmentInputError('metadata_cache_unavailable','metadata_cache');throw error;}
 }
 if(Number(version)>=7){
  try{
   const authority=await PredictionD1.readPredictionAuthority(db);
   if(!authority.tables)throw new D1EnrichmentInputError('prediction_domain_unavailable','prediction_domain');
   summary.predictionMode=authority.mode;
  }catch(error){
   if(error instanceof D1EnrichmentInputError)throw error;
   if(error?.code==='prediction_domain_unavailable')throw new D1EnrichmentInputError('prediction_domain_unavailable','prediction_domain');
   throw error;
  }
 }
 const view=LifecycleReader.readLifecycle(store,now,{entitiesOnly:true}),retirements=view.tmdbRetirements||null;
 if(retirements){
  summary.tmdbRetirements={valid:retirements.valid,applied:retirements.applied.length,held:retirements.held.slice(0,20),reasons:retirements.reasons.slice(0,20)};
  if(!retirements.valid)throw new D1EnrichmentInputError('input_invalid',TMDB_RETIREMENTS_KEY);
 }
 const inputs=EnrichmentProjection.enrichmentInputs({view,store});
 summary.viewMs=Date.now()-started-summary.loadMs;
 const stored=new Map((await db.all('SELECT kind,id,change_key FROM projection_state WHERE projection=?',[D1_ENRICHMENT_PROJECTION])).map(row=>[row.kind+'\n'+row.id,row.change_key]));
 const held=new Set((retirements?.held||[]).map(item=>item.filmId));
 const plan=d1EnrichmentPlan(inputs,stored,nowIso,held);
 // Membership is guarded on its own: a Film can stay in the view and still drop off the watchlist. A held Film keeps its row.
 const listed=new Set(inputs.films.filter(film=>film.watchlist).map(film=>film.id));
 const members=(await db.all('SELECT film_id FROM watchlist_film')).map(row=>row.film_id);
 plan.membership={members:members.length,removed:members.filter(id=>!listed.has(id)&&!held.has(id)).length};
 Object.assign(summary,{members:plan.membership.members,membershipRemoved:plan.membership.removed,films:inputs.films.length,people:inputs.people.length,stored:stored.size,changedPeople:plan.people.length,changedFilms:plan.films.length,absent:plan.absent.length,unmatchedCreditFilms:inputs.films.filter(film=>film.unmatched).length});
 // Schema v4 keeps the plan above and writes nothing else. Sync clocks are written when the contract
 // is version 5 or 6 and film_sync_state exists. A version without the table does not write them.
 // The film change key is not involved, so a v4 database does not rewrite its Films because these fields exist.
 plan.syncReady=Number(version)>=5&&!!(await db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='film_sync_state'"));
 plan.sync=[];
 if(plan.syncReady){
  const storedSync=new Map((await db.all("SELECT id,change_key FROM projection_state WHERE projection=? AND kind='film'",[METADATA_SYNC_PROJECTION])).map(row=>[row.id,row.change_key]));
  const viewed=new Set();
  for(const entry of inputs.films){
   if(held.has(entry.id))continue;
   viewed.add(entry.id);
   const key=EnrichmentProjection.filmSyncChangeKey(entry.sync);
   const previous=storedSync.get(entry.id);
   if(entry.sync){if(previous!==key)plan.sync.push({id:entry.id,sync:entry.sync,key});}
   else if(previous&&previous!=='absent')plan.sync.push({id:entry.id,sync:null,key:'absent'});
  }
  // Leaving the view releases membership only. metadata.json keeps the cache, and beginSync reads it if the Film returns,
  // so the sync row follows that entry. The foreign key is an existing film.id: a metadata.json key with no Film row
  // does not mint a Film and does not get a row. A held Film is left untouched.
  const known=new Set((await db.all('SELECT id FROM film')).map(row=>row.id));
  const aliases=new Map();
  for(const row of await db.all("SELECT film_id,value FROM film_external_id WHERE scheme='letterboxd'")){
   if(!aliases.has(row.film_id))aliases.set(row.film_id,[]);
   aliases.get(row.film_id).push(row.value);
  }
  const leaving=new Map(plan.absent.filter(item=>item.kind==='film').map(item=>[item.id,item]));
  for(const id of new Set([...known,...leaving.keys()])){
   if(viewed.has(id)||held.has(id))continue;
   const sync=EnrichmentProjection.filmSyncState(EnrichmentProjection.metadataForFilmId(store.metadata,id,aliases.get(id)));
   const previous=storedSync.get(id);
   const key=EnrichmentProjection.filmSyncChangeKey(sync);
   const release=leaving.get(id)||null;
   if(sync){
    if(!known.has(id)||previous===key)continue;
    const item={id,sync,key};
    if(release)release.syncUpdate=item;
    else plan.sync.push(item);
   }else if(previous&&previous!=='absent'){
    if(release)release.clearSync=true;
    else plan.sync.push({id,sync:null,key:'absent'});
   }
  }
  summary.changedSync=plan.sync.length+plan.absent.filter(item=>item.syncUpdate||item.clearSync).length;
 }
 return plan;
}

function d1EnrichmentGuard(plan,summary){
 const absentFilms=plan.absent.filter(item=>item.kind==='film').length,absentPeople=plan.absent.length-absentFilms;
 if(absentFilms>D1_ENRICHMENT_ABSENT_FILMS||absentPeople>D1_ENRICHMENT_ABSENT_PEOPLE){Object.assign(summary,{absentFilms,absentPeople,absentLimit:{films:D1_ENRICHMENT_ABSENT_FILMS,people:D1_ENRICHMENT_ABSENT_PEOPLE}});return 'absent_guard';}
 const membershipLimit=Math.max(D1_ENRICHMENT_MEMBERSHIP_MIN,Math.ceil(plan.membership.members*D1_ENRICHMENT_MEMBERSHIP_SHARE));
 if(plan.membership.removed>membershipLimit){summary.membershipLimit=membershipLimit;return 'membership_guard';}
 return null;
}

// The lease and its fence run on the wall clock, whatever time the view is built for.
async function d1EnrichmentLease(db,leaseId){
 const now=Date.now(),at=new Date(now).toISOString(),until=new Date(now+D1_ENRICHMENT_LEASE_MS).toISOString();
 await db.run('INSERT INTO projection_run (projection,lease_id,lease_until,started_at) VALUES (?,?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until,started_at=excluded.started_at WHERE projection_run.lease_until IS NULL OR projection_run.lease_until<?',[D1_ENRICHMENT_PROJECTION,leaseId,until,at,at]);
 return (await db.get('SELECT lease_id FROM projection_run WHERE projection=?',[D1_ENRICHMENT_PROJECTION]))?.lease_id===leaseId;
}

async function d1EnrichmentRelease(db,leaseId,summary){
 await db.run('UPDATE projection_run SET lease_id=NULL,lease_until=NULL,finished_at=?,outcome=?,summary_json=? WHERE projection=? AND lease_id=?',[new Date().toISOString(),summary.outcome||null,JSON.stringify(summary),D1_ENRICHMENT_PROJECTION,leaseId]);
}

// One batch per Film and one per group of Persons. Each starts with the fence, writes the rows, stores the change keys and
// clears the fence row. A failed batch writes nothing and its entities keep their old keys, so the next run tries them again.
async function d1EnrichmentWrite(db,plan,{leaseId,started,queryBudget,wallMs}){
 const repository=CanonicalRepository.createCanonicalRepository(db);
 const result={writtenPeople:0,writtenFilms:0,released:0,syncWrites:0,errorCount:0,errors:[],remaining:0,leaseLost:false};
 const fenced=async(write)=>{
  await db.transaction(async()=>{
   await db.run(D1_ENRICHMENT_FENCE,[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]);
   await write();
   await db.run('DELETE FROM projection_fence');
  });
 };
 const state=(kind,id,key)=>db.run(D1_ENRICHMENT_STATE,[D1_ENRICHMENT_PROJECTION,kind,id,key,new Date().toISOString()]);
 const syncState=(id,key)=>db.run(D1_ENRICHMENT_STATE,[METADATA_SYNC_PROJECTION,'film',id,key,new Date().toISOString()]);
 const writeSync=async item=>{await repository.projectFilmSyncState({filmId:item.id,sync:item.sync});await syncState(item.id,item.key);};
 const budgetLeft=()=>db.queries<queryBudget&&Date.now()-started<wallMs;
 const failed=(kind,id,error)=>{
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))result.leaseLost=true;
  result.errorCount++;
  if(result.errors.length<20)result.errors.push({kind,id,error:message.slice(0,160)});
 };
 const writePeople=async items=>{await fenced(async()=>{for(const entry of items){await repository.projectPerson({person:entry.person});await state('person',entry.id,entry.key);}});result.writtenPeople+=items.length;};
 const queue=[];
 const syncById=new Map((plan.sync||[]).map(item=>[item.id,item]));
 const filmIds=new Set(plan.films.map(film=>film.id));
 for(let i=0;i<plan.people.length;i+=D1_ENRICHMENT_PERSON_BATCH)queue.push({kind:'people',items:plan.people.slice(i,i+D1_ENRICHMENT_PERSON_BATCH)});
 for(const film of plan.films)queue.push({kind:'film',item:film});
 for(const item of plan.sync||[])if(!filmIds.has(item.id))queue.push({kind:'sync',item});
 for(const entity of plan.absent)queue.push({kind:'absent',item:entity});
 for(let index=0;index<queue.length;index++){
  if(result.leaseLost||!budgetLeft()){result.remaining=queue.slice(index).reduce((sum,task)=>sum+(task.items?.length||1),0);break;}
  const task=queue[index];
  try{
   if(task.kind==='people'){
    // One Person that cannot be written must not hold back the rest of its group: a failed group is retried one by one.
    try{await writePeople(task.items);}
    catch(error){
     if(task.items.length===1||/CHECK constraint failed/i.test(String(error?.message||error)))throw error;
     for(const entry of task.items){if(result.leaseLost||!budgetLeft())break;try{await writePeople([entry]);}catch(single){failed('person',entry.id,single);}}
    }
   }else if(task.kind==='film'){
    const entry=task.item;
    const pending=syncById.get(entry.id)||null;
    await fenced(async()=>{
     await repository.projectFilm({film:entry.film,watchlist:entry.watchlist,credits:entry.credits,metadata:entry.metadata??undefined});
     for(const redirect of entry.film.redirects||[])await repository.projectLink({survivor:entry.film,redirect});
     if(pending)await writeSync(pending);
     await state('film',entry.id,entry.key);
    });
    result.writtenFilms++;
    if(pending)result.syncWrites++;
   }else if(task.kind==='sync'){
    await fenced(async()=>{await writeSync(task.item);});
    result.syncWrites++;
   }else{
    const entity=task.item;
    await fenced(async()=>{
     if(entity.kind==='film')await repository.releaseFilm(entity.id);
     if(entity.syncUpdate)await writeSync(entity.syncUpdate);
     else if(entity.clearSync)await writeSync({id:entity.id,sync:null,key:'absent'});
     await state(entity.kind,entity.id,'absent');
    });
    result.released++;
    if(entity.syncUpdate||entity.clearSync)result.syncWrites++;
   }
  }catch(error){
   if(task.kind==='people')for(const entry of task.items)failed('person',entry.id,error);
   else failed(task.kind==='sync'?'film_sync':task.item.kind||'film',task.item.id,error);
  }
 }
 return result;
}

// The read-only status of the projector for /api/d1/status. schema is true for the whole of migration 0004 (its three tables
// and schema_contract version 4), for migration 0005 (those tables, film_sync_state and version 5), for migration 0006
// (those plus metadata_cache, metadata_cache_authority, metadata_cache_cas and version 6), and for version 7 or newer
// (those plus the prediction-domain tables). A partial schema is false. A later additive version stays true only
// while the prediction tables and the earlier tables are all present.
// Version 4 stays true when the sync table is absent. Version 5 stays true when the cache tables are absent.
// Version 6 stays true when the prediction-domain tables are absent.
async function d1EnrichmentStatus(binding,env){
 const mode=d1EnrichmentMode(env);
 const present=((await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projection_state','projection_run','projection_fence','film_sync_state','metadata_cache','metadata_cache_authority','metadata_cache_cas','prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run')").bind().all()).results||[]).map(row=>row.name);
 const tables=present.filter(name=>name==='projection_state'||name==='projection_run'||name==='projection_fence').sort();
 const syncTable=present.includes('film_sync_state');
 const cacheReady=present.includes('metadata_cache')&&present.includes('metadata_cache_authority')&&present.includes('metadata_cache_cas');
 const predictionNames=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run'];
 const predictionReady=predictionNames.every(name=>present.includes(name));
 const version=(await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first())?.version??null;
 if(tables.length!==3||!(version===4||(version===5&&syncTable)||(version===6&&syncTable&&cacheReady)||(Number(version)>=7&&syncTable&&cacheReady&&predictionReady)))return {mode,schema:false,schemaVersion:version,projectionTables:tables};
 const [run,counts]=await Promise.all([
  binding.prepare('SELECT lease_until leaseUntil,started_at startedAt,finished_at finishedAt,outcome,summary_json summary FROM projection_run WHERE projection=?').bind(D1_ENRICHMENT_PROJECTION).first(),
  binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent FROM projection_state WHERE projection=?").bind(D1_ENRICHMENT_PROJECTION).first(),
 ]);
 let summary=null;try{summary=run?.summary?JSON.parse(run.summary):null;}catch{}
 const status={mode,schema:true,checkpoints:counts?.total??0,absent:counts?.absent??0,lastRun:run?{startedAt:run.startedAt,finishedAt:run.finishedAt,outcome:run.outcome,leaseHeld:!!run.leaseUntil,summary}:null};
 if(Number(version)>=5){
  const sync=await binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent FROM projection_state WHERE projection=?").bind(METADATA_SYNC_PROJECTION).first();
  status.schemaVersion=version;status.syncCheckpoints=sync?.total??0;status.syncAbsent=sync?.absent??0;
 }
 if(Number(version)>=6){
  const marker=await binding.prepare('SELECT mode AS cacheMode, cache_generation AS cacheGeneration, mirror_generation AS mirrorGeneration FROM metadata_cache_authority WHERE id=1').bind().first();
  status.cacheMode=marker?.cacheMode??null;status.cacheGeneration=marker?.cacheGeneration??null;status.mirrorGeneration=marker?.mirrorGeneration??null;
 }
 if(Number(version)>=7){
  const marker=await binding.prepare('SELECT mode AS predictionMode, generation AS predictionGeneration, queue_generation AS queueGeneration, profile_generation AS profileGeneration FROM prediction_domain_authority WHERE id=1').bind().first();
  status.predictionMode=marker?.predictionMode??null;status.predictionGeneration=marker?.predictionGeneration??null;status.queueGeneration=marker?.queueGeneration??null;status.profileGeneration=marker?.profileGeneration??null;
 }
 return status;
}
