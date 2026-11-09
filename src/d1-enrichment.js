// AIR-275 phase 2 (ADR 0056): the enrichment projector. R2 stays authoritative; D1 follows it.
// One run reads the R2 records the enrichment writers keep (watchlist, programme, metadata, people, titles, the catalog of
// discovered films, the discovery resolution and the Letterboxd diary), builds the whole Film/Person view with the same reader and
// the same derivation as the offline import, and compares each Film and Person with the change key D1 holds for it. Only a changed
// one is written, in one D1 batch that also stores its new key, so a key never claims a write that did not commit. A Film that no R2
// source lists, and that no watchlist fact admits, loses its watchlist membership and is marked absent. A Film a watchlist fact admits stays in the view; only its membership is removed. The run works from a cron trigger, never from a sync
// or discovery step, so it adds nothing to the R2 pipeline. D1_ENRICHMENT_WRITE: off (default) reads nothing; dry reads R2 and
// the D1 keys and logs the diff without writing; on writes. Every batch starts with the lease fence, so a run that lost its lease
// writes nothing and an older run cannot overwrite a newer one.
const D1_ENRICHMENT_PROJECTION='enrichment';
const METADATA_SYNC_PROJECTION='metadata_sync';
const D1_ENRICHMENT_LEASE_MS=10*60000;
const D1_ENRICHMENT_QUERY_BUDGET=800;
const D1_ENRICHMENT_WALL_MS=60000;
const D1_ENRICHMENT_PERSON_BATCH=25;
// AIR-395 (interim, before the bucket reconciliation): the checkpoint read of the diff goes out as a few pages at once instead of one query that
// ships every row (about 32,000, 6 to 11 s in the AIR-392 runs). The result is the same Map; D1 allows six simultaneous connections per invocation.
const D1_ENRICHMENT_STORED_PAGE=6000,D1_ENRICHMENT_STORED_CONCURRENCY=6;
// Guards against input that is well formed but incomplete, such as an empty or truncated watchlist. Both are absolute: the size
// of the projection does not widen them. A run past either writes nothing; a real mass removal goes through a reload instead.
const D1_ENRICHMENT_ABSENT_FILMS=25,D1_ENRICHMENT_ABSENT_PEOPLE=250;
const D1_ENRICHMENT_MEMBERSHIP_MIN=5,D1_ENRICHMENT_MEMBERSHIP_SHARE=0.02;
const D1_ENRICHMENT_FENCE='INSERT INTO projection_fence (held) SELECT COUNT(*) FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?';
// ADR 0103 (AIR-383). Behind D1_ENRICHMENT_WINDOW (off by default) a run asks for an exclusive window: Discovery stops admitting new
// chunks, the existing discovery_lease is granted to this run, and the strict generation pin, projector lease and batch fences below
// run unchanged while nothing else can move the generation. With the flag off, the table absent or the Discovery authority not d1, no
// line of this runs and the run is what it was.
const D1_ENRICHMENT_WINDOW_POLL_MS=2000;
const D1_ENRICHMENT_WINDOW_FENCE='INSERT INTO projection_fence (held) SELECT COUNT(*) FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>? AND (SELECT COUNT(*) FROM projector_window WHERE state=\'held\' AND owner=? AND expires_at>?)=1';
function d1EnrichmentWindowMode(env){return env?.D1_ENRICHMENT_WINDOW==='on'?'on':'off';}
const D1_ENRICHMENT_STATE="INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES (?,?,?,?,?) ON CONFLICT(projection,kind,id) DO UPDATE SET change_key=excluded.change_key,projected_at=excluded.projected_at";

// AIR-392: additive phase timing of one run, for the log line and projection_run.summary_json. It only measures: it reads the clock around
// calls the run already makes, in the same order, and never changes what a call does, returns or throws. `phases` is a sequential partition
// of the time between the window grant and the first write (so its entries do not overlap and add up, with an explicit residual); `detail` holds
// timings that overlap or are nested (the individual R2 and discovery reads run concurrently), and must not be added to `phases`. Each entry
// is {ms, n calls, q D1 queries of the adapter, rows read}. No payload, id, key, SQL or parameter is recorded: only fixed phase names and counts.
// Date.now() in a Worker advances only across I/O, so pure CPU work between two calls shows as 0 ms and appears in the I/O phase that follows it.
function d1EnrichmentPhases(db){
 const groups={phases:{},detail:{}};
 const entry=(group,name)=>groups[group][name]||(groups[group][name]={ms:0,n:0,q:0,rows:0});
 // AIR-396: `sqlUs` (the database's own sql_duration_ms, in microseconds), `dbRows` (D1 rows_read), `dbN` (reads that carried a D1 meta) and `replica` (of those, served by a replica) are added to an entry only when its reads carried a meta.
 const snap=()=>{const meter=db?.meter;return meter?{...meter}:null;};
 const done=(group,name,at,queries,rows,before=null)=>{
  const item=entry(group,name);item.ms+=Date.now()-at;item.n++;item.q+=(db?db.queries:0)-queries;if(Number.isFinite(rows))item.rows+=rows;
  const meter=db?.meter;
  if(before&&meter&&meter.metas>before.metas){item.sqlUs=(item.sqlUs||0)+meter.sqlUs-before.sqlUs;item.dbRows=(item.dbRows||0)+meter.rowsRead-before.rowsRead;item.dbN=(item.dbN||0)+meter.metas-before.metas;item.replica=(item.replica||0)+meter.replica-before.replica;}
 };
 return {
  ...groups,
  async time(name,fn,{detail=false,rows=null}={}){
   const at=Date.now(),queries=db?db.queries:0,before=snap();let count=null;
   try{const value=await fn();if(rows){try{count=rows(value);}catch{count=null;}}return value;}
   finally{done(detail?'detail':'phases',name,at,queries,count,before);}
  },
  sync(name,fn){const at=Date.now(),queries=db?db.queries:0;try{return fn();}finally{done('phases',name,at,queries,null);}},
 };
}
const D1_ENRICHMENT_NO_TIMER={phases:{},detail:{},time:(name,fn)=>fn(),sync:(name,fn)=>fn()};

function d1EnrichmentMode(env){const value=env?.D1_ENRICHMENT_WRITE;return value==='on'?'on':value==='dry'?'dry':'off';}

// The repository's database interface over the D1 binding. Reads go out at once and count against the run's query budget.
// Writes inside transaction() are collected and sent as one db.batch, which D1 applies atomically.
function d1EnrichmentAdapter(binding,marks=null){
 let buffer=null,queries=0,sent=0;
 // AIR-396: the D1 `meta` of every read, summed (whole numbers only): the database's own sql_duration_ms in microseconds, rows_read, how many reads
 // carried a meta and how many of those were served by a replica. Measurement only: a read returns what it returned before.
 const meter={sqlUs:0,rowsRead:0,metas:0,replica:0};
 const sample=result=>{const meta=result?.meta;if(!meta||typeof meta!=='object')return;meter.metas++;const sql=Number(meta.timings?.sql_duration_ms??meta.duration);if(Number.isFinite(sql)&&sql>=0)meter.sqlUs+=Math.round(sql*1000);const rows=Number(meta.rows_read);if(Number.isFinite(rows)&&rows>=0)meter.rowsRead+=rows;if(meta.served_by_primary===false)meter.replica++;};
 const statement=(sql,params)=>binding.prepare(sql).bind(...params);
 return {
  get queries(){return queries;},
  meter,
  // ADR 0106: statements sent to D1 (a read or a single write is one, a batch is the number of its statements). The grouped path accounts its lanes in this unit.
  get statements(){return sent;},
  async get(sql,params=[]){queries++;sent++;const result=await statement(sql,params).all();sample(result);return (result.results||[])[0]??null;},
  async all(sql,params=[]){queries++;sent++;const result=await statement(sql,params).all();sample(result);return result.results||[];},
  async run(sql,params=[]){if(buffer){buffer.push(statement(sql,params));return;}queries++;sent++;await statement(sql,params).run();},
  // ADR 0106: one round trip for several reads (a D1 batch is one query); the rows of each statement, in order.
  async readBatch(list){queries++;sent+=list.length;const out=await binding.batch(list.map(item=>statement(item.sql,item.params)));return out.map(item=>{sample(item);return item?.results||[];});},
  // ADR 0106: one atomic batch of already collected writes. Marks the first batch submitted exactly as transaction() does.
  async writeBatch(list){queries++;sent+=list.length;if(marks&&marks.firstBatchAt==null){marks.firstBatchAt=Date.now();marks.firstBatchStatements=list.length;}await binding.batch(list.map(item=>statement(item.sql,item.params)));},
  async transaction(fn){
   if(buffer)return fn();
   buffer=[];let statements;
   try{await fn();statements=buffer;}finally{buffer=null;}
   // AIR-392: the first batch the run SUBMITS (the instant before binding.batch is called, so a failing batch still has its attempt). Measurement only.
   if(statements.length){queries++;sent+=statements.length;if(marks&&marks.firstBatchAt==null){marks.firstBatchAt=Date.now();marks.firstBatchStatements=statements.length;}await binding.batch(statements);}
  },
 };
}

// The inputs fail closed. Every object the view needs must be present and of its shape: a missing object stops the run before
// any D1 write, while a present, empty one is a real empty dataset. Three objects are optional: the Letterboxd diary, absent while its
// own switch is off, the owner-approved TMDB retirements (ADR 0057), absent until a correction is approved, and the view index,
// whose watchlist booleans admit Films that have left the current lists. A missing view index admits nobody. A missing
// verified-films admission admits nobody either: deploy does not upsert a rated Film that has not been verified.
// A retirements
// object that is present but fails its check as a whole stops the run as input_invalid. The read must also be one consistent cut
// of R2:
// - it does not start while a writer of these objects is at work: a live discovery lease, or a sync in its metadata or EPG stage;
// - the programme and the catalog come from the copies of the one generation the pointer names as published, never the root ones;
// - after every read, each object is checked again by its etag, and the writer checks are repeated. The published generation's
//   catalog and the resolution are updated in place, so the same programmeRunId does not prove the same content. Any change
//   defers the run before any D1 write; the next hourly run reads again.
class D1EnrichmentInputError extends Error{constructor(reason,key,cause){super(reason+(key?': '+key:''));this.reason=reason;this.key=key||null;this.inputCause=cause||null;}}
const D1_ENRICHMENT_DEFERRED=['writer_active','input_changed','generation_pending','authority_unavailable','window_busy','window_not_granted','window_lost','authority_moved'];
const d1EnrichmentRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const d1EnrichmentFilmList=value=>d1EnrichmentRecord(value)&&Array.isArray(value.films);
// AIR-392: the fixed label of an input for the phase timing: never the key itself (the catalog key carries a run id).
function d1EnrichmentReadLabel(key){
 const names={'watchlist.json':'watchlist','metadata.json':'metadata','titles.json':'titles','people.json':'people','epg/discovery-resolution.json':'resolution','letterboxd/diary/history.json':'diary','enrichment/view-index.json':'viewIndex','letterboxd/admissions/verified-films.json':'verifiedFilms','admin/owner-reviews.json':'ownerMirror'};
 if(Object.prototype.hasOwnProperty.call(names,key))return names[key];
 if(key===TMDB_RETIREMENTS_KEY)return 'retirements';
 return /\/programme\.json$/.test(key)?'programme':/\/discovered-films\.json$/.test(key)?'catalog':'other';
}
async function d1EnrichmentRead(env,etags,key,shape,required=true){
 return (etags.timer||D1_ENRICHMENT_NO_TIMER).time('read.'+d1EnrichmentReadLabel(key),()=>d1EnrichmentReadObject(env,etags,key,shape,required),{detail:true});
}
async function d1EnrichmentReadObject(env,etags,key,shape,required){
 const object=await env.BUCKET.get(key);
 etags.set(key,object?.etag??null);
 if(!object){if(required)throw new D1EnrichmentInputError('input_missing',key);return null;}
 let value;
 try{value=await object.json();}catch{throw new D1EnrichmentInputError('input_invalid',key);}
 if(!shape(value))throw new D1EnrichmentInputError('input_invalid',key);
 return value;
}
// AIR-363: between the D1 ledger seal and the publish step the discovery authority already names the new run while the pointer still
// names the old one, and the old generation's R2 catalog copy may be absent. That window is not an input failure: the run is deferred
// before any read or write, never reads another generation's catalog, and the next hourly run reads again once the pointer moved.
// An authority that is not D1 (absent module, `ready` false: no D1 discovery marker, or the R2 marker) has no handoff window and the R2
// catalog stays the source, as before. A D1 authority that cannot be read, or is held, is unknown: the run defers (`authority_unavailable`)
// instead of guessing. The guard runs before the reads and again right before the D1 write.
async function d1EnrichmentHandoffGuard(env,runId,expected=null){
 if(typeof DiscoveryAuthority==='undefined'||typeof DiscoveryAuthority.readAuthority!=='function')return null;
 let gate;
 try{gate=await DiscoveryAuthority.readAuthority(env);}catch{throw new D1EnrichmentInputError('authority_unavailable','discovery_authority');}
 if(gate?.held)throw new D1EnrichmentInputError('authority_unavailable','discovery_authority');
 if(gate?.ready&&gate.programmeRunId&&gate.programmeRunId!==runId)throw new D1EnrichmentInputError('generation_pending','discovery_authority');
 // A D1 authority needs a finite generation: without it the inputs read through it could not be proven unchanged.
 if(gate?.ready&&!Number.isFinite(gate.generation))throw new D1EnrichmentInputError('authority_unavailable','discovery_authority');
 // The authority that owned the reads must still be the one that owns the write: the same ready D1 mode and cutover, the same run, and the
 // generation read with the inputs (a fenced discovery write bumps it). A transition away from D1, or any other change, means the inputs may
 // be stale or changed: defer, never write. (An authority that was not D1 at the first read has no expectation and keeps the R2 inputs.)
 if(expected&&(!gate?.ready||gate.mode!==expected.mode||gate.cutover!==expected.cutover||gate.programmeRunId!==expected.programmeRunId||gate.generation!==expected.generation))throw new D1EnrichmentInputError('input_changed','discovery_authority');
 return gate||null;
}
// What a ready D1 authority looked like when the inputs were read; null for an authority that is not D1.
const d1EnrichmentAuthoritySnapshot=gate=>gate?.ready?{mode:gate.mode,cutover:gate.cutover,programmeRunId:gate.programmeRunId,generation:gate.generation}:null;
// AIR-375: under a D1 discovery authority the catalog of a generation is not an R2 object. A write of
// `epg/generations/<run>/discovered-films.json` is routed to the D1 catalog and no R2 copy is made (the published-EPG mirrors cover the
// programme and the watchlist only), so reading that key straight from R2 failed `input_missing` on every run once a generation was
// published under D1 authority. The shared decisions (`epg/discovery-resolution.json`) are read the same way: their R2 object is a copy frozen at the
// cutover, so reading it directly would silently project stale decisions. Both are read through the same authority route every other reader uses (`loadJSON`). Only an
// authority that is not D1 (absent module, not ready) keeps the R2 copy as the source, and then a missing copy is still a failed input.
// A read that was D1-owned never falls back to R2: a route that no longer handles the key (a transition) defers. A catalog read the authority cannot answer for now (fence, ledger seal in progress) defers like the handoff window; an answer that cannot
// be used (bounded, unreadable payload) fails closed as input_invalid. The authority generation is recorded with the read and checked
// again before the write, which is the D1 counterpart of the etag check on an R2 object.
const D1_ENRICHMENT_DISCOVERY_DEFER=['discovery_fence','discovery_incomplete'];
// `missing` names what an authority answer of null means: for the catalog of a generation the authority no longer names it is a handoff
// (`generation_pending`); for the shared decisions a D1 authority always answers, so null is an absent input.
async function d1EnrichmentDiscoveryRead(env,etags,key,gate,missing){
 // The authority was not D1 when the run began: the R2 object is the source, as before, and its etag is checked after the reads.
 if(!gate?.ready)return d1EnrichmentRead(env,etags,key,d1EnrichmentRecord);
 // The authority was D1: the read goes through it or it does not happen. A route that is absent, or that no longer handles the key because
 // the authority moved away from D1 since the first read, defers; an R2 copy of the key is never consulted, however fresh it looks.
 if(typeof DiscoveryAuthority.routeRead!=='function')throw new D1EnrichmentInputError('authority_unavailable','discovery_authority');
 let routed;
 try{routed=await (etags.timer||D1_ENRICHMENT_NO_TIMER).time('read.'+d1EnrichmentReadLabel(key),()=>DiscoveryAuthority.routeRead(env,key),{detail:true});}
 catch(error){const defer=D1_ENRICHMENT_DISCOVERY_DEFER.includes(error?.code);throw new D1EnrichmentInputError(defer?'authority_unavailable':'input_invalid',defer?'discovery_authority':key,typeof error?.code==='string'&&error.code.startsWith('discovery_')?error.code:'discovery_read_failed');}
 if(!routed?.handled)throw new D1EnrichmentInputError('authority_unavailable','discovery_authority');
 if(routed.value==null)throw new D1EnrichmentInputError(missing,missing==='generation_pending'?'discovery_authority':key);
 if(!d1EnrichmentRecord(routed.value))throw new D1EnrichmentInputError('input_invalid',key);
 return routed.value;
}
async function d1EnrichmentWritersIdle(env,now=Date.now()){
 const [lease,sync]=await Promise.all([DISCOVERY_LEASE_KEY,'sync.json'].map(async key=>{const object=await env.BUCKET.get(key);try{return object?await object.json():null;}catch{return null;}}));
 if(Number(lease?.expiresAt)>now)throw new D1EnrichmentInputError('writer_active',DISCOVERY_LEASE_KEY);
 if(['metadata','epg'].includes(sync?.stage)&&now-Date.parse(sync.updatedAt)<15*60000)throw new D1EnrichmentInputError('writer_active','sync.json');
}
async function d1EnrichmentStore(env,timer=D1_ENRICHMENT_NO_TIMER){
 const etags=new Map();
 etags.timer=timer;
 await timer.time('store.writersIdle',()=>d1EnrichmentWritersIdle(env));
 const published=typeof PublishedEpg==='undefined'?null:await timer.time('store.publishedSnapshot',()=>PublishedEpg.authoritativeSnapshot(env));
 let runId,watchlist,programme;
 if(published){
  if(!published.programmeRunId||!d1EnrichmentFilmList(published.programme)||!d1EnrichmentFilmList(published.watchlist))throw new D1EnrichmentInputError('generation_unpublished','published_epg');
  runId=published.programmeRunId;watchlist=published.watchlist;programme=published.programme;
 }else{
  const pointer=await d1EnrichmentRead(env,etags,EPG_GENERATION_KEY,d1EnrichmentRecord);
  if(pointer.phase!=='published'||typeof pointer.programmeRunId!=='string'||!pointer.programmeRunId)throw new D1EnrichmentInputError('generation_unpublished',EPG_GENERATION_KEY);
  runId=pointer.programmeRunId;
 }
 const authority=await timer.time('store.handoffGuard',()=>d1EnrichmentHandoffGuard(env,runId));
 // The reads run together; `store.readBlock` is their wall time, each read's own time is `detail` (recorded by d1EnrichmentRead).
 const [watchlistObject,programmeObject,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory,tmdbRetirements,viewIndex,archiveDocument]=await timer.time('store.readBlock',()=>Promise.all([
  published?null:d1EnrichmentRead(env,etags,'watchlist.json',d1EnrichmentFilmList),
  published?null:d1EnrichmentRead(env,etags,epgGenerationKey(runId,'programme.json'),d1EnrichmentFilmList),
  d1EnrichmentRead(env,etags,'metadata.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'titles.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,etags,'people.json',d1EnrichmentRecord),
  d1EnrichmentDiscoveryRead(env,etags,epgGenerationKey(runId,'discovered-films.json'),authority,'generation_pending'),
  d1EnrichmentDiscoveryRead(env,etags,'epg/discovery-resolution.json',authority,'input_missing'),
  d1EnrichmentRead(env,etags,'letterboxd/diary/history.json',d1EnrichmentRecord,false),
  d1EnrichmentRead(env,etags,TMDB_RETIREMENTS_KEY,d1EnrichmentRecord,false),
  d1EnrichmentRead(env,etags,'enrichment/view-index.json',d1EnrichmentRecord,false),
  d1EnrichmentRead(env,etags,'letterboxd/admissions/verified-films.json',value=>d1EnrichmentRecord(value)&&value.schemaVersion===1&&d1EnrichmentRecord(value.films),false),
 ]));
 if(!published){watchlist=watchlistObject;programme=programmeObject;}
 let ownerGate=null,ownerMirror=null,ownerDocument=null;
 if(typeof OwnerReview!=='undefined'){
  await timer.time('store.ownerReview',async()=>{
   ownerGate=await OwnerReview.readAuthority(env);
   if(ownerGate.failClosed)throw new D1EnrichmentInputError('owner_review_unavailable','owner_review');
   if(!ownerGate.legacy&&ownerGate.mode==='r2')ownerMirror=await d1EnrichmentRead(env,etags,'admin/owner-reviews.json',value=>!!value&&typeof value==='object'&&!Array.isArray(value)&&value.contractVersion===1&&plainOwner(value),false);
  });
 }
 await timer.time('store.etagRecheck',async()=>{for(const [key,etag] of etags)if(((await env.BUCKET.head(key))?.etag??null)!==etag)throw new D1EnrichmentInputError('input_changed',key);},{rows:()=>etags.size});
 if(published){
  const again=await timer.time('store.publishedSnapshot',()=>PublishedEpg.authoritativeSnapshot(env));
  if(!again||again.generation!==published.generation||again.programmeRunId!==runId)throw new D1EnrichmentInputError('input_changed','published_epg');
 }
 await timer.time('store.writersIdle',()=>d1EnrichmentWritersIdle(env));
 if(ownerGate&&!ownerGate.legacy){
  ownerDocument=ownerMirror;
  if(ownerGate.mode==='d1'){
   const snap=await timer.time('store.ownerReview',()=>OwnerReview.readFenced(env));
   if(!snap.ok||snap.mode!=='d1'||snap.generation!==ownerGate.generation)throw new D1EnrichmentInputError('owner_review_unavailable','owner_review');
   ownerDocument=snap.body;
  }
  if(ownerDocument){OwnerReview.stampLocalized(programme,ownerDocument);OwnerReview.stampLocalized(watchlist,ownerDocument);}
 }
 const store=timer.sync('store.build',()=>EnrichmentProjection.enrichmentStore({watchlist,programme,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory,tmdbRetirements,watchlistAdmissions:EnrichmentProjection.watchlistAdmissionsFromIndex(viewIndex),archiveAdmissions:archiveDocument?EnrichmentProjection.archiveAdmissionsFromDocument(archiveDocument):null,filmTitles:FILM_TITLE_DICTIONARY,personNames:PERSON_NAME_DICTIONARY,personOverrides:{'actor/chris-pratt':REVIEWED_PEOPLE['actor/chris-pratt']}}));
 if(ownerDocument)store.ownerReviews=ownerDocument;
 return {store,programmeRunId:runId,discoveryGate:d1EnrichmentAuthoritySnapshot(authority)};
}
function plainOwner(value){return !!value.films&&typeof value.films==='object'&&!Array.isArray(value.films)&&!!value.people&&typeof value.people==='object'&&!Array.isArray(value.people);}

// AIR-388: among the changed Films, those a verified rated archive admitted (letterboxd/admissions/verified-films.json) and D1 has never
// projected go first; the others keep their order. A stable partition, so it changes only the order, never the set or the change keys.
// Once projected a Film is no longer "new", so the priority ends by itself and cannot hold back the other Films.
function d1EnrichmentAdmittedFirst(films,store,stored){
 const admitted=new Set(Object.values(store?.archiveAdmissions||{}).map(item=>String(item?.tmdb)));
 if(!admitted.size)return {films,count:0};
 const isNew=entry=>!stored.has('film\n'+entry.id)&&(entry.film?.externalIds||[]).some(item=>item?.scheme==='tmdb'&&admitted.has(String(item.value)));
 const first=[],rest=[];
 for(const entry of films)(isNew(entry)?first:rest).push(entry);
 return {films:[...first,...rest],count:first.length};
}

// The plan of one run: every Person and Film whose change key differs from the stored one, and every stored entity the view
// no longer has. A Film's own Persons are written just before it (see d1EnrichmentWrite). A held Film (a TMDB retirement under owner review,
// ADR 0057) is neither written nor released, whether or not the view still has it: D1 keeps it as it is until the review
// settles.
function d1EnrichmentPlan(inputs,stored,nowIso,held=new Set(),keys=null){
 const people=[],films=[],absent=[],seen=new Set();
 for(const entry of inputs.people){
  const key=keys?keys.get(entry):EnrichmentProjection.personChangeKey(entry,nowIso);
  seen.add('person\n'+entry.id);
  if(stored.get('person\n'+entry.id)!==key)people.push({...entry,key});
 }
 for(const entry of inputs.films){
  const key=keys?keys.get(entry):EnrichmentProjection.filmChangeKey(entry,nowIso);
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

// ADR 0103. The window steps for one run. Returns the window record for the summary, or null when no window applies (flag off,
// table absent or the Discovery authority not d1: the run goes on exactly as before). A refusal throws a deferred input error and
// leaves nothing behind: a request that was made is released by the caller's finally.
async function d1EnrichmentWindowAcquire(env,leaseId,options,state){
 if(typeof DiscoveryAuthority==='undefined'||typeof DiscoveryAuthority.requestProjectorWindow!=='function')return null;
 const clock=options.clock||{now:()=>Date.now(),sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms))};
 const deadlineMs=options.deadlineMs??DiscoveryAuthority.WINDOW_DEADLINE_MS,minRunMs=options.minRunMs??DiscoveryAuthority.WINDOW_MIN_RUN_MS,pollMs=options.pollMs??D1_ENRICHMENT_WINDOW_POLL_MS;
 // The existing writer-idle checks (the metadata and EPG sync stages) come first: a window is never requested into a running sync.
 await d1EnrichmentWritersIdle(env);
 const waitStarted=clock.now();
 const requested=await DiscoveryAuthority.requestProjectorWindow(env,{owner:leaseId,deadlineMs,now:waitStarted});
 if(requested.outcome==='not_applicable')return {outcome:'not_applicable',reason:requested.reason};
 if(requested.outcome==='busy')throw new D1EnrichmentInputError('window_busy','projector_window');
 state.requested=true;
 for(;;){
  const granted=await DiscoveryAuthority.grantProjectorWindow(env,{owner:leaseId,minRunMs,now:clock.now()});
  if(granted.outcome==='granted'){
   state.granted=true;state.heldStarted=clock.now();
   return {outcome:'granted',waitMs:clock.now()-waitStarted,expiresAt:granted.expiresAt,generationAtGrant:granted.generation};
  }
  if(granted.outcome==='lost')throw new D1EnrichmentInputError('window_lost','projector_window');
  if(granted.outcome==='too_late')throw new D1EnrichmentInputError('window_not_granted','projector_window');
  // pending: an in-flight lease or a loading transfer. Wait for it without a busy loop, never past the point where too little time is left.
  if(Number.isFinite(requested.expiresAt)&&requested.expiresAt-clock.now()<minRunMs+pollMs)throw new D1EnrichmentInputError('window_not_granted','projector_window');
  await clock.sleep(pollMs);
 }
}
// AIR-395: every checkpoint row, equal to `SELECT kind,id,change_key FROM projection_state WHERE projection=?`. The first page is one query by the primary key order; a table
// that fits in it (every table of the tests, and a young one) costs that one query, as before. A larger table is counted and the remaining pages go out together (at most six at a
// time, D1's limit per invocation). The pages are accepted only when they add up exactly: the row count equals the count and no row came twice. A short or overlapping page (a
// change under the read) throws the pages away and reads the whole table once, as before. The projector is the only writer of these rows and holds its lease, so the pages see
// one state; the check is the proof that does not rely on it.
async function d1EnrichmentStoredRows(db,{page=D1_ENRICHMENT_STORED_PAGE,concurrency=D1_ENRICHMENT_STORED_CONCURRENCY}={}){
 const whole=()=>db.all('SELECT kind,id,change_key FROM projection_state WHERE projection=?',[D1_ENRICHMENT_PROJECTION]);
 if(!(page>0))return whole();
 const pageAt=index=>db.all('SELECT kind,id,change_key FROM projection_state WHERE projection=? ORDER BY kind,id LIMIT ? OFFSET ?',[D1_ENRICHMENT_PROJECTION,page,index*page]);
 const rows=[...await pageAt(0)];
 if(rows.length<page)return rows;
 const total=Number((await db.get('SELECT COUNT(*) AS n FROM projection_state WHERE projection=?',[D1_ENRICHMENT_PROJECTION]))?.n);
 if(!Number.isInteger(total)||total<rows.length)return whole();
 const pages=Math.ceil(total/page);
 for(let from=1;from<pages;from+=concurrency){
  const wave=[];
  for(let index=from;index<Math.min(pages,from+concurrency);index++)wave.push(pageAt(index));
  for(const part of await Promise.all(wave))for(const row of part)rows.push(row);
 }
 if(rows.length!==total||new Set(rows.map(row=>row.kind+'\n'+row.id)).size!==total)return whole();
 return rows;
}
// AIR-395: checkpoint reconciliation by buckets. The diff needs to know, for every entity of the view, whether D1 already holds its fresh change key. Shipping all ~32,000
// stored keys to the Worker costs 6 to 11 s; D1 can instead summarize them where they are (about 40 ms). The view and the table are cut into the same buckets (kind and a hash of the last four
// characters of the id, 4,096 buckets); for each bucket D1 returns the number of stored keys and two sums of 32-bit slices of the hash part of the key (the last 28 characters, two 53-bit hashes in hex,
// see projectionKey), and the Worker computes the same from the fresh keys. A bucket whose count and both sums agree holds exactly the view's entities with their fresh keys and no
// other live entity, so none of them is changed or absent; a collision of a changed key needs both 32-bit sums to agree (about 2^-64 for one change, owner-accepted). Only the buckets that
// differ are read row by row, and the unchanged plan function runs over those entities and rows. When too many buckets differ (a backlog) or the key is not of the expected shape, the whole
// table is read as before. `absent` rows are left out of the sums, so an entity whose stored key is `absent` always makes its bucket differ.
const D1_ENRICHMENT_BUCKET_MIN_ENTITIES=5000,D1_ENRICHMENT_BUCKET_PARAMS=90,D1_ENRICHMENT_BUCKET_MAX_SHARE=0.4,D1_ENRICHMENT_BUCKET_MAX_MISSING=0.25,D1_ENRICHMENT_BUCKET_WAVE=6,D1_ENRICHMENT_HEX='0123456789abcdef',D1_ENRICHMENT_BUCKETS=4096;
// The bucket number of an id: a multiplicative hash of its last four characters, the same integer arithmetic in SQL and in JavaScript (an id always has more than four characters: `film:`, `person:`).
// 4,096 buckets hold about 8 stored keys each, so the digest is small and a changed entity pulls in few rows (the two-character suffix of the first version put 240 numeric ids in one bucket).
const D1_ENRICHMENT_BUCKET_EXPR="((unicode(substr(id,-1,1))*1664525+unicode(substr(id,-2,1))*22695477+unicode(substr(id,-3,1))*48271+unicode(substr(id,-4,1))*69069)%4096)";
const d1EnrichmentBucketSlice=from=>Array.from({length:8},(_,j)=>`(instr('0123456789abcdef',substr(change_key,${-from+j},1))-1)*${16**(7-j)}`).join('+');
const D1_ENRICHMENT_BUCKET_SQL=`SELECT kind||':'||${D1_ENRICHMENT_BUCKET_EXPR} AS b,COUNT(*) AS n,SUM(${d1EnrichmentBucketSlice(28)}) AS a,SUM(${d1EnrichmentBucketSlice(20)}) AS c FROM projection_state WHERE projection=? AND change_key<>'absent' GROUP BY b`;
const d1EnrichmentBucketOf=(kind,id)=>{
 const at=id.length;
 return kind+':'+((id.charCodeAt(at-1)*1664525+id.charCodeAt(at-2)*22695477+id.charCodeAt(at-3)*48271+id.charCodeAt(at-4)*69069)%D1_ENRICHMENT_BUCKETS);
};
// The two 32-bit slices of a key, as the SQL above computes them (a character outside the hex digits counts -1, as instr()-1 does). Null for a key too short to have them.
function d1EnrichmentKeySums(key){
 if(typeof key!=='string'||key.length<28)return null;
 const slice=from=>{let total=0;for(let j=0;j<8;j++)total+=D1_ENRICHMENT_HEX.indexOf(key[key.length-from+j])*16**(7-j);return total;};
 return [slice(28),slice(20)];
}
// Returns {stored,inputs,total,mode}: `stored` the checkpoint Map the plan needs and `inputs` the entities it has to look at. mode `full`: every checkpoint and every entity (the previous behaviour);
// mode `buckets`: only the differing buckets' rows and entities.
async function d1EnrichmentCheckpoints(db,{inputs,keys,timer,storedPage,bucketMin=D1_ENRICHMENT_BUCKET_MIN_ENTITIES,summary}){
 const full=async()=>{
  const rows=await timer.time('diff.storedRead',()=>d1EnrichmentStoredRows(db,{page:storedPage}),{rows:value=>value.length});
  return {stored:new Map(rows.map(row=>[row.kind+'\n'+row.id,row.change_key])),inputs,total:rows.length,mode:'full'};
 };
 if(!keys||inputs.people.length+inputs.films.length<bucketMin)return full();
 const expected=new Map();
 for(const [kind,list] of [['person',inputs.people],['film',inputs.films]])for(const entry of list){
  const sums=d1EnrichmentKeySums(keys.get(entry));
  if(!sums)return full();
  const bucket=d1EnrichmentBucketOf(kind,entry.id),item=expected.get(bucket)||[0,0,0];
  item[0]++;item[1]+=sums[0];item[2]+=sums[1];expected.set(bucket,item);
 }
 // A backlog cannot gain: entities the table has never stored each make a bucket differ, so when the view has far more entities than the table has rows the buckets would all differ. One count
 // (also the `stored` of the summary) tells it before any digest is asked for, and the whole table is read as before.
 const total=Number((await timer.time('diff.checkpointCount',()=>db.get('SELECT COUNT(*) AS n FROM projection_state WHERE projection=?',[D1_ENRICHMENT_PROJECTION])))?.n);
 if(!Number.isInteger(total))return full();
 const missing=Math.max(0,inputs.people.length+inputs.films.length-total);
 if(missing>expected.size*D1_ENRICHMENT_BUCKET_MAX_MISSING){summary.checkpointBuckets={expected:expected.size,missing,skipped:'backlog'};return full();}
 const digest=await timer.time('diff.checkpointDigest',()=>db.all(D1_ENRICHMENT_BUCKET_SQL,[D1_ENRICHMENT_PROJECTION]),{rows:value=>value.length});
 const actual=new Map(digest.map(row=>[row.b,[Number(row.n),Number(row.a),Number(row.c)]]));
 const differing=new Set();
 for(const [bucket,item] of expected){const found=actual.get(bucket);if(!found||found[0]!==item[0]||found[1]!==item[1]||found[2]!==item[2])differing.add(bucket);}
 for(const bucket of actual.keys())if(!expected.has(bucket))differing.add(bucket);
 summary.checkpointBuckets={expected:expected.size,stored:actual.size,differing:differing.size};
 if(differing.size>expected.size*D1_ENRICHMENT_BUCKET_MAX_SHARE)return full();
 const byKind={person:[],film:[]};
 for(const bucket of differing){const at=bucket.indexOf(':');byKind[bucket.slice(0,at)]?.push(bucket.slice(at+1));}
 const statements=[];
 for(const kind of ['person','film'])for(let from=0;from<byKind[kind].length;from+=D1_ENRICHMENT_BUCKET_PARAMS){
  const part=byKind[kind].slice(from,from+D1_ENRICHMENT_BUCKET_PARAMS);
  statements.push(()=>db.all('SELECT kind,id,change_key FROM projection_state WHERE projection=? AND kind=? AND '+D1_ENRICHMENT_BUCKET_EXPR+' IN ('+part.map(()=>'?').join(',')+')',[D1_ENRICHMENT_PROJECTION,kind,...part.map(Number)]));
 }
 const rows=[];
 await timer.time('diff.checkpointRows',async()=>{
  for(let from=0;from<statements.length;from+=D1_ENRICHMENT_BUCKET_WAVE)for(const part of await Promise.all(statements.slice(from,from+D1_ENRICHMENT_BUCKET_WAVE).map(run=>run())))for(const row of part)rows.push(row);
 },{rows:()=>rows.length});
 const look=(kind,list)=>list.filter(entry=>differing.has(d1EnrichmentBucketOf(kind,entry.id)));
 return {stored:new Map(rows.map(row=>[row.kind+'\n'+row.id,row.change_key])),inputs:{...inputs,people:look('person',inputs.people),films:look('film',inputs.films)},total,mode:'buckets'};
}
async function runD1EnrichmentProjection(env,{now=Date.now(),trigger='cron',queryBudget=D1_ENRICHMENT_QUERY_BUDGET,wallMs=D1_ENRICHMENT_WALL_MS,window:windowOptions={},storedPage=D1_ENRICHMENT_STORED_PAGE,bucketMin=D1_ENRICHMENT_BUCKET_MIN_ENTITIES,bulk:bulkOverrides={}}={}){
 const mode=d1EnrichmentMode(env);
 if(mode==='off')return {mode,skipped:'off'};
 if(!env.DB||!env.BUCKET)return {mode,skipped:'binding_missing'};
 const begun=Date.now();let started=begun;
 const marks={};
 const nowIso=new Date(now).toISOString(),db=d1EnrichmentAdapter(env.DB,marks),leaseId=crypto.randomUUID();
 const windowState={requested:false,granted:false,heldStarted:null};
 const summary={projection:D1_ENRICHMENT_PROJECTION,mode,trigger,startedAt:nowIso,version:EnrichmentProjection.ENRICHMENT_PROJECTION_VERSION};
 // AIR-392: `timing` partitions the run in order (lease, window request to grant, diff, pre-write guards, write loop, release); `phases` splits the
 // diff and `detail` its overlapping reads. Measurement only; see d1EnrichmentPhases.
 const timer=d1EnrichmentPhases(db),timing={};
 summary.timing=timing;summary.phases=timer.phases;summary.detail=timer.detail;
 const leaseAt=Date.now();
 const leased=mode==='on'?await d1EnrichmentLease(db,leaseId):null;
 timing.leaseMs=Date.now()-leaseAt;
 if(mode==='on'&&!leased)return {...summary,skipped:'lease_held'};
 try{
  if(mode==='on'&&d1EnrichmentWindowMode(env)==='on'){
   const windowAt=Date.now();
   try{
    const window=await d1EnrichmentWindowAcquire(env,leaseId,windowOptions,windowState);
    if(window){summary.window=window;started=Date.now();}
   }finally{timing.windowMs=Date.now()-windowAt;}
  }
  const diffAt=Date.now();
  let plan;
  try{plan=await d1EnrichmentDiff(env,db,now,summary,timer,{storedPage,bucketMin});}
  finally{
   timing.diffMs=Date.now()-diffAt;
   // The named remainder of the additive accounting: diffMs = the sum of `phases` + diffResidualMs (untimed glue and CPU). `detail` overlaps and is not in it.
   const covered=Object.values(timer.phases).reduce((total,item)=>total+item.ms,0);
   timing.diffResidualMs=Math.max(0,timing.diffMs-covered);
  }
  // More absences or lost watchlist memberships than a routine sync explains point at broken input: nothing is written.
  const guard=d1EnrichmentGuard(plan,summary);
  if(guard){summary.outcome=guard;return summary;}
  if(mode==='dry'){summary.outcome='dry';return summary;}
  const gateAt=Date.now();
  const writeGate=await d1EnrichmentHandoffGuard(env,summary.programmeRunId,summary.discoveryGate);
  timing.writeGateMs=Date.now()-gateAt;
  if(summary.window?.outcome==='granted'&&writeGate&&Number.isFinite(writeGate.generation))summary.window.generationAtFirstBatch=writeGate.generation;
  const writeAt=Date.now();
  let written;
  // ADR 0106: null unless D1_ENRICHMENT_BULK is `on`; the held window's absolute expiry bounds every group.
  const bulk=d1EnrichmentBulkOptions(env,bulkOverrides);
  try{written=await d1EnrichmentWrite(db,plan,{leaseId,started,queryBudget,wallMs,windowOwner:windowState.granted?leaseId:null,marks,bulk,windowExpiresAt:windowState.granted&&Number.isFinite(summary.window?.expiresAt)?summary.window.expiresAt:null});}
  finally{
   timing.writeMs=Date.now()-writeAt;
   // From the budget clock's start (the grant, or the run start with no window): to the first fenced transaction entered (`preTxnMs`), to the first
   // batch SUBMITTED to D1 (`preWriteMs`, an attempt: kept if that batch fails), and the planning between the two (`firstBatchPlanMs`: the repository's
   // own reads and the statement assembly). Each is absent when the run got that far never.
   if(marks.firstTxnAt!=null)timing.preTxnMs=marks.firstTxnAt-started;
   if(marks.firstBatchAt!=null){timing.preWriteMs=marks.firstBatchAt-started;timing.firstBatchStatements=marks.firstBatchStatements;if(marks.firstTxnAt!=null)timing.firstBatchPlanMs=marks.firstBatchAt-marks.firstTxnAt;}
  }
  Object.assign(summary,written,{outcome:written.leaseLost?'lease_lost':written.errorCount?'partial':written.remaining?'budget':'complete'});
  // A window that ended under the run is a deferred outcome with its own reason, never a success.
  if(written.windowLost&&!written.leaseLost){summary.outcome='deferred';summary.reason='window_lost';summary.inputKey='projector_window';}
  // ADR 0106: the Film/Person authority marker is no longer the projector's: nothing more is written through any path.
  if(written.authorityMoved&&!written.leaseLost&&!written.windowLost){summary.outcome='deferred';summary.reason='authority_moved';summary.inputKey='film_person_authority';}
  return summary;
 }catch(error){
  summary.outcome='failed';summary.error=String(error?.message||error).slice(0,200);
  if(error instanceof D1EnrichmentInputError){summary.reason=error.reason;summary.inputKey=error.key;if(error.inputCause)summary.inputCause=error.inputCause;if(D1_ENRICHMENT_DEFERRED.includes(error.reason))summary.outcome='deferred';}
  return summary;
 }finally{
  summary.queries=db.queries;summary.durationMs=Date.now()-begun;
  // Free only this run's own window and lease. A failed or unknown release is not retried: the row and the lease expire by themselves.
  if(windowState.requested){
   if(summary.window&&windowState.heldStarted!=null)summary.window.heldMs=Date.now()-windowState.heldStarted;
   if(!summary.window)summary.window={outcome:summary.reason&&D1_ENRICHMENT_DEFERRED.includes(summary.reason)&&summary.reason.startsWith('window_')?summary.reason:'released'};
   const releaseAt=Date.now();
   await DiscoveryAuthority.releaseProjectorWindow(env,{owner:leaseId}).catch(()=>{});
   timing.windowReleaseMs=Date.now()-releaseAt;
  }
  // The stored summary_json is written by the lease release below, so the lease release time can only be in the log line.
  const leaseReleaseAt=Date.now();
  if(mode==='on')await d1EnrichmentRelease(db,leaseId,summary).catch(()=>{});
  timing.leaseReleaseMs=Date.now()-leaseReleaseAt;
  timing.runMs=Date.now()-begun;
  console.log(JSON.stringify({event:'d1_enrichment_projection',...summary}));
 }
}

// The R2 records, the view and every input live only inside this function: once it returns, only the changed entries remain,
// so the write phase does not hold the whole view (about 50 MB of heap on the 2026-10-29 snapshot, ADR 0056).
async function d1EnrichmentDiff(env,db,now,summary,timer=D1_ENRICHMENT_NO_TIMER,{storedPage=D1_ENRICHMENT_STORED_PAGE,bucketMin=D1_ENRICHMENT_BUCKET_MIN_ENTITIES}={}){
 const started=Date.now(),nowIso=new Date(now).toISOString();
 const {store,programmeRunId,discoveryGate}=await d1EnrichmentStore(env,timer);
 summary.programmeRunId=programmeRunId;summary.discoveryGeneration=discoveryGate?discoveryGate.generation:null;
 // The full snapshot guards the write but stays out of the logged summary.
 Object.defineProperty(summary,'discoveryGate',{value:discoveryGate,enumerable:false});
 summary.loadMs=Date.now()-started;
 // Schema v6 and every later version can name a D1 metadata cache. v4 and v5 keep the R2 object
 // and do not query the cache tables. Mode d1 replaces that object before the view is built.
 // Version 6 or newer without the cache tables or a valid marker fails the run before any write
 // and does not project from the R2 object. A failed cache read does the same.
 // Version 7 or newer with this domain installed requires every prediction table and a valid marker.
 // The projector does not write that domain. A partial set of those tables fails the run before a write.
 // None of the tables means a later migration advanced the contract without this domain. Prediction stays
 // on the objects, and the run does not fail for that absence.
 // Owner reviews are a separate marker. Before their tables exist the view is unchanged.
 // Once they exist, a reviewed owner localization replaces a dictionary value on the view
 // and a d1 read does not use the R2 mirror.
 const version=(await timer.time('diff.schemaContract',()=>db.get('SELECT version FROM schema_contract WHERE id=1')))?.version??null;
 summary.schemaVersion=version;
 if(Number(version)>=6){
  try{await timer.time('diff.metadataCache',()=>MetadataCache.useAuthoritativeMetadata(db,store));}
  catch(error){if(error?.code==='metadata_cache_unavailable')throw new D1EnrichmentInputError('metadata_cache_unavailable','metadata_cache');throw error;}
 }
 if(Number(version)>=7){
  try{
   const authority=await timer.time('diff.predictionAuthority',()=>PredictionD1.readPredictionAuthority(db,env));
   if(authority.domain!=='absent'){
    if(!authority.tables)throw new D1EnrichmentInputError('prediction_domain_unavailable','prediction_domain');
    summary.predictionMode=authority.mode;
   }
  }catch(error){
   if(error instanceof D1EnrichmentInputError)throw error;
   if(error?.code==='prediction_domain_unavailable')throw new D1EnrichmentInputError('prediction_domain_unavailable','prediction_domain');
   throw error;
  }
 }
 const view=timer.sync('diff.lifecycle',()=>LifecycleReader.readLifecycle(store,now,{entitiesOnly:true})),retirements=view.tmdbRetirements||null;
 if(store.ownerReviews&&typeof OwnerReview!=='undefined')timer.sync('diff.ownerOverlay',()=>OwnerReview.applyViewOverlay(view,store.ownerReviews));
 if(retirements){
  summary.tmdbRetirements={valid:retirements.valid,applied:retirements.applied.length,held:retirements.held.slice(0,20),reasons:retirements.reasons.slice(0,20)};
  if(!retirements.valid)throw new D1EnrichmentInputError('input_invalid',TMDB_RETIREMENTS_KEY);
 }
 const inputs=timer.sync('diff.inputs',()=>EnrichmentProjection.enrichmentInputs({view,store}));
 summary.viewMs=Date.now()-started-summary.loadMs;
 // AIR-395: the fresh change keys are computed once here when the buckets can be used, and the plan reuses them; below the bucket threshold the plan computes them as before.
 const bucketed=inputs.people.length+inputs.films.length>=bucketMin;
 const keys=bucketed?timer.sync('diff.keys',()=>{const map=new Map();for(const entry of inputs.people)map.set(entry,EnrichmentProjection.personChangeKey(entry,nowIso));for(const entry of inputs.films)map.set(entry,EnrichmentProjection.filmChangeKey(entry,nowIso));return map;}):null;
 const checkpoint=await d1EnrichmentCheckpoints(db,{inputs,keys,timer,storedPage,bucketMin,summary});
 const stored=checkpoint.stored;summary.checkpointMode=checkpoint.mode;
 const held=new Set((retirements?.held||[]).map(item=>item.filmId));
 const plan=timer.sync('diff.plan',()=>d1EnrichmentPlan(checkpoint.inputs,stored,nowIso,held,keys));
 const prioritized=timer.sync('diff.admittedFirst',()=>d1EnrichmentAdmittedFirst(plan.films,store,stored));
 plan.films=prioritized.films;summary.admittedFirst=prioritized.count;
 // Membership is guarded on its own: a Film can stay in the view and still drop off the watchlist. A held Film keeps its row.
 const listed=new Set(inputs.films.filter(film=>film.watchlist).map(film=>film.id));
 const members=(await timer.time('diff.membersRead',()=>db.all('SELECT film_id FROM watchlist_film'),{rows:value=>value.length})).map(row=>row.film_id);
 plan.membership={members:members.length,removed:members.filter(id=>!listed.has(id)&&!held.has(id)).length};
 Object.assign(summary,{members:plan.membership.members,membershipRemoved:plan.membership.removed,films:inputs.films.length,people:inputs.people.length,stored:checkpoint.total,changedPeople:plan.people.length,changedFilms:plan.films.length,absent:plan.absent.length,unmatchedCreditFilms:inputs.films.filter(film=>film.unmatched).length});
 // Schema v4 keeps the plan above and writes nothing else. Sync clocks are written when the contract
 // is version 5 or 6 and film_sync_state exists. A version without the table does not write them.
 // The film change key is not involved, so a v4 database does not rewrite its Films because these fields exist.
 plan.syncReady=Number(version)>=5&&!!(await timer.time('diff.syncProbe',()=>db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='film_sync_state'")));
 plan.sync=[];
 if(plan.syncReady){
  const storedSync=new Map((await timer.time('diff.storedSyncRead',()=>db.all("SELECT id,change_key FROM projection_state WHERE projection=? AND kind='film'",[METADATA_SYNC_PROJECTION]),{rows:value=>value.length})).map(row=>[row.id,row.change_key]));
  const viewed=new Set();
  for(const entry of inputs.films){
   if(held.has(entry.id))continue;
   viewed.add(entry.id);
   // No usable cache: leave the stored clocks. A null sync here would delete them.
   if(entry.preserveCanonical)continue;
   const key=EnrichmentProjection.filmSyncChangeKey(entry.sync);
   const previous=storedSync.get(entry.id);
   if(entry.sync){if(previous!==key)plan.sync.push({id:entry.id,sync:entry.sync,key});}
   else if(previous&&previous!=='absent')plan.sync.push({id:entry.id,sync:null,key:'absent'});
  }
  // Leaving the view releases membership only. metadata.json keeps the cache, and beginSync reads it if the Film returns,
  // so the sync row follows that entry. The foreign key is an existing film.id: a metadata.json key with no Film row
  // does not mint a Film and does not get a row. A held Film is left untouched.
  const known=new Set((await timer.time('diff.knownFilmsRead',()=>db.all('SELECT id FROM film'),{rows:value=>value.length})).map(row=>row.id));
  const aliases=new Map();
  for(const row of await timer.time('diff.aliasesRead',()=>db.all("SELECT film_id,value FROM film_external_id WHERE scheme='letterboxd'"),{rows:value=>value.length})){
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

// ADR 0106 (stage a, inert). Behind D1_ENRICHMENT_BULK (off by default; only a D1_ENRICHMENT_WRITE=on run reads it) the projector writes in groups. One cycle:
// (a) the repository's own planning is run once against a recording database that answers every read with nothing: that is the TRACE of the reads the group depends on;
// (b) the traced reads and a digest of each, plus the Film/Person authority marker, go out as ONE read batch;
// (c) the unchanged repository plans again, now reading only from that answer, and its writes are collected instead of sent;
// (d) the collected writes go out as ONE atomic batch that first asserts the lease (or the held window), the marker (mode r2 or prepared, cutover open, the generation planned under) and
//     that every traced read still digests to what the prefetch saw. The two batches are two round trips and NOT one snapshot, so nothing is assumed from their timing: any difference fails a
//     CHECK and rolls the whole batch back, and the group is written again by the per-entity path (one fenced transaction per Person group and per Film, unchanged). The same fallback applies to a
//     read shape that cannot be digested, a read the second pass issues that the trace did not (a data-dependent branch), a planning error of any entity, a batch over the statement cap and any
//     constraint (a trusted external id another Film of the group takes, a missing Person, a unique role id). Nothing is kept from one cycle to the next, so no plan outlives its group.
// A Film that carries redirects (its link writes depend on rows an earlier item of the group may retire) never joins a group: it takes the per-entity path. With the flag off none of this runs.
const D1_ENRICHMENT_BULK_GROUP=10,D1_ENRICHMENT_BULK_PERSON_GROUP=25,D1_ENRICHMENT_BULK_MAX_STATEMENTS=1500,D1_ENRICHMENT_BULK_RESERVE_MS=15000,D1_ENRICHMENT_BULK_FIRST_GROUP_MS=5000;
const D1_ENRICHMENT_BULK_DIGEST_MAX=8000,D1_ENRICHMENT_BULK_MAX_PARAMS=99;
const D1_ENRICHMENT_BULK_FALLBACK_SHARE=0.05,D1_ENRICHMENT_BULK_FALLBACK_MIN_GROUPS=10;
const D1_ENRICHMENT_MARKER_READ='SELECT mode,cutover,generation FROM film_person_authority WHERE id=1';
const D1_ENRICHMENT_MARKER_GUARD="INSERT INTO projection_fence (held) SELECT COUNT(*) FROM film_person_authority WHERE id=1 AND mode IN ('r2','prepared') AND cutover='open' AND generation=?";
const D1_ENRICHMENT_READ_GUARD='INSERT INTO projection_fence (held) SELECT CASE WHEN ';
function d1EnrichmentBulkMode(env){return env?.D1_ENRICHMENT_BULK==='on'?'on':'off';}
// The options of a run: defaults plus the run's own overrides. Null when the grouped path is not selected.
function d1EnrichmentBulkOptions(env,overrides){
 if(d1EnrichmentBulkMode(env)!=='on')return null;
 const o=overrides||{},positive=(value,fallback)=>Number.isInteger(value)&&value>0?value:fallback;
 return {groupSize:positive(o.groupSize,D1_ENRICHMENT_BULK_GROUP),personGroupSize:positive(o.personGroupSize,D1_ENRICHMENT_BULK_PERSON_GROUP),maxStatements:positive(o.maxStatements,D1_ENRICHMENT_BULK_MAX_STATEMENTS),
  reserveMs:Number.isFinite(o.reserveMs)&&o.reserveMs>=0?o.reserveMs:D1_ENRICHMENT_BULK_RESERVE_MS,firstGroupMs:Number.isFinite(o.firstGroupMs)&&o.firstGroupMs>=0?o.firstGroupMs:D1_ENRICHMENT_BULK_FIRST_GROUP_MS,
  statementBudget:Number.isInteger(o.statementBudget)&&o.statementBudget>0?o.statementBudget:null,
  fallbackShare:Number.isFinite(o.fallbackShare)?o.fallbackShare:D1_ENRICHMENT_BULK_FALLBACK_SHARE,fallbackMinGroups:positive(o.fallbackMinGroups,D1_ENRICHMENT_BULK_FALLBACK_MIN_GROUPS)};
}
const d1EnrichmentReadKey=(sql,params)=>sql+'\u0000'+JSON.stringify(params);
// The digest expression of a plain `SELECT <columns> FROM ...`: the rows as one JSON text, in the row order of the query. A function call in the column list, GROUP BY or UNION cannot be digested (null).
function d1EnrichmentDigestSql(sql){
 const match=/^\s*SELECT\s+(.+?)\s+FROM\s+/is.exec(sql);
 if(!match||match[1].includes('(')||/\bGROUP\b|\bUNION\b/i.test(sql))return null;
 const names=match[1].split(',').map(item=>{const parts=item.trim().split(/\s+AS\s+/i);return (parts[1]||parts[0]).trim();});
 return `(SELECT COALESCE(json_group_array(json_array(${names.join(',')})),'[]') FROM (${sql}))`;
}
// One group cycle (see above). items: [{kind:'person'|'film',entry,pending?}] in write order (a Film's own Persons before it). Returns {outcome:'applied'|'fallback'|'stop',reason,...stats}.
// `stop` is a lost lease, a lost window or an authority marker that is no longer the projector's: the run must write nothing more through any path.
async function d1EnrichmentGroupCycle(db,items,{leaseId,windowOwner=null,maxStatements=D1_ENRICHMENT_BULK_MAX_STATEMENTS,marks={}}){
 const stats={reads:0,guards:0,prefetchMisses:0,statements:0,prefetchStatements:0,prefetchMs:0,applyMs:0};
 const fallback=(reason,extra)=>({...stats,outcome:'fallback',reason,...extra});
 if(marks.firstTxnAt==null)marks.firstTxnAt=Date.now();
 const stateWrite=(db2,projection,kind,id,key)=>db2.run(D1_ENRICHMENT_STATE,[projection,kind,id,key,new Date().toISOString()]);
 // What one item asks of the repository: exactly the calls the per-entity path makes (without redirect links: such a Film is never grouped).
 const apply=async(db2,repository,item)=>{
  const entry=item.entry;
  if(item.kind==='person'){await repository.projectPerson({person:entry.person});await stateWrite(db2,D1_ENRICHMENT_PROJECTION,'person',entry.id,entry.key);return;}
  await repository.projectFilm({film:entry.film,watchlist:entry.watchlist,credits:entry.credits,metadata:entry.metadata??undefined,preserveCanonical:entry.preserveCanonical===true});
  if(item.pending){await repository.projectFilmSyncState({filmId:item.pending.id,sync:item.pending.sync});await stateWrite(db2,METADATA_SYNC_PROJECTION,'film',item.pending.id,item.pending.key);}
  await stateWrite(db2,D1_ENRICHMENT_PROJECTION,'film',entry.id,entry.key);
 };
 // (a) the trace
 const seen=new Map();let tracedWrites=0;
 const tracer={async get(sql,params=[]){seen.set(d1EnrichmentReadKey(sql,params),{sql,params});return null;},async all(sql,params=[]){seen.set(d1EnrichmentReadKey(sql,params),{sql,params});return [];},async run(){tracedWrites++;},async transaction(fn){return fn();}};
 try{const traced=CanonicalRepository.createCanonicalRepository(tracer);for(const item of items)await apply(tracer,traced,item);}
 catch{return fallback('plan_error');}
 const reads=[...seen.values()],digests=reads.map(read=>d1EnrichmentDigestSql(read.sql));
 if(digests.some(digest=>digest===null)||reads.some(read=>read.params.length>D1_ENRICHMENT_BULK_MAX_PARAMS))return fallback('undigestable_read');
 // the statement cap covers the prefetch (the marker read and two statements per read) and the write batch (two fences, a guard per read, the writes, the fence delete); an estimate before any round trip
 const prefetchStatements=1+2*reads.length,estimatedWrites=3+reads.length+tracedWrites;
 stats.reads=reads.length;
 if(Math.max(prefetchStatements,estimatedWrites)>maxStatements)return fallback('too_large',{estimate:Math.max(prefetchStatements,estimatedWrites)});
 // (b) one read batch
 const batch=[{sql:D1_ENRICHMENT_MARKER_READ,params:[]}];
 reads.forEach((read,index)=>{batch.push({sql:read.sql,params:read.params});batch.push({sql:'SELECT '+digests[index]+' AS d',params:read.params});});
 let out;const prefetchAt=Date.now();
 try{out=await db.readBatch(batch);}
 catch(error){stats.prefetchMs=Date.now()-prefetchAt;stats.prefetchStatements=prefetchStatements;return fallback(/no such table/i.test(String(error?.message||error))?'marker_unavailable':'prefetch_error',{error:String(error?.message||error).slice(0,160)});}
 stats.prefetchMs=Date.now()-prefetchAt;stats.prefetchStatements=prefetchStatements;
 const marker=out[0]?.[0];
 if(!marker)return fallback('marker_unavailable');
 const generation=Number(marker.generation);
 if(!['r2','prepared'].includes(marker.mode)||marker.cutover!=='open'||!Number.isInteger(generation))return {...stats,outcome:'stop',reason:'authority_moved'};
 const answers=new Map(),expected=[];
 for(let index=0;index<reads.length;index++){
  answers.set(d1EnrichmentReadKey(reads[index].sql,reads[index].params),out[1+index*2]);
  const digest=out[2+index*2]?.[0]?.d;
  if(typeof digest!=='string'||digest.length>D1_ENRICHMENT_BULK_DIGEST_MAX)return fallback('digest_unusable');
  expected.push(digest);
 }
 // (c) the second planning pass, reading the answer only, collecting its writes
 const writes=[windowOwner?{sql:D1_ENRICHMENT_WINDOW_FENCE,params:[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString(),windowOwner,Date.now()]}:{sql:D1_ENRICHMENT_FENCE,params:[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]},
  {sql:D1_ENRICHMENT_MARKER_GUARD,params:[generation]}];
 reads.forEach((read,index)=>{writes.push({sql:D1_ENRICHMENT_READ_GUARD+digests[index]+'=? THEN 1 ELSE 0 END',params:[...read.params,expected[index]]});stats.guards++;});
 const collector={
  async get(sql,params=[]){const rows=answers.get(d1EnrichmentReadKey(sql,params));if(rows)return rows[0]??null;stats.prefetchMisses++;return null;},
  async all(sql,params=[]){const rows=answers.get(d1EnrichmentReadKey(sql,params));if(rows)return rows;stats.prefetchMisses++;return [];},
  async run(sql,params=[]){writes.push({sql,params});},
  async transaction(fn){return fn();}};
 try{const repository=CanonicalRepository.createCanonicalRepository(collector);for(const item of items)await apply(collector,repository,item);}
 catch{return fallback('plan_error');}
 if(stats.prefetchMisses)return fallback('prefetch_miss');
 writes.push({sql:'DELETE FROM projection_fence',params:[]});
 if(writes.length>maxStatements)return fallback('too_large',{estimate:writes.length});
 // (d) one atomic batch
 const applyAt=Date.now();
 try{await db.writeBatch(writes);}
 catch(error){
  stats.applyMs=Date.now()-applyAt;
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message)){
   // Which assertion failed is told by re-reading, never by the error text.
   const lease=await db.get('SELECT 1 AS ok FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?',[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]).catch(()=>null);
   if(!lease)return {...stats,outcome:'stop',reason:'lease_lost'};
   if(windowOwner){
    const held=await db.get("SELECT 1 AS ok FROM projector_window WHERE state='held' AND owner=? AND expires_at>?",[windowOwner,Date.now()]).catch(()=>null);
    if(!held)return {...stats,outcome:'stop',reason:'window_lost'};
   }
   const now=await db.get(D1_ENRICHMENT_MARKER_READ,[]).catch(()=>null);
   if(!now||!['r2','prepared'].includes(now.mode)||now.cutover!=='open'||Number(now.generation)!==generation)return {...stats,outcome:'stop',reason:'authority_moved'};
   return fallback('guard_refused');
  }
  // A constraint the per-entity path reports on its own (a trusted external id taken by another Film of the group, a missing Person, a unique role id): the batch rolled back whole, the group is replayed one by one.
  if(/constraint failed|UNIQUE|FOREIGN KEY/i.test(message))return fallback('constraint',{error:message.slice(0,160)});
  // Any other failure (a D1 limit, a network error) leaves the outcome unknown; the per-entity replay writes the same rows (idempotent) and the grouped path is switched off for the rest of the run.
  return fallback('batch_error',{error:message.slice(0,160),latch:true});
 }
 stats.applyMs=Date.now()-applyAt;stats.statements=writes.length;
 return {...stats,outcome:'applied',reason:null};
}

// One batch per Film and one per group of Persons. Each starts with the fence, writes the rows, stores the change keys and
// clears the fence row. A failed batch writes nothing and its entities keep their old keys, so the next run tries them again.
async function d1EnrichmentWrite(db,plan,{leaseId,started,queryBudget,wallMs,windowOwner=null,marks={},bulk=null,windowExpiresAt=null}){
 const repository=CanonicalRepository.createCanonicalRepository(db);
 const result={writtenPeople:0,writtenFilms:0,released:0,syncWrites:0,errorCount:0,errors:[],remaining:0,leaseLost:false,windowLost:false};
 const fenced=async(write)=>{
  // AIR-392: the instant the first fenced transaction is entered (its planning starts); the submission is marked by the adapter. Measurement only.
  if(marks.firstTxnAt==null)marks.firstTxnAt=Date.now();
  try{
   await db.transaction(async()=>{
    // Inside a window every batch also asserts, in the same statement, that this run still owns an unexpired `held` window.
    if(windowOwner)await db.run(D1_ENRICHMENT_WINDOW_FENCE,[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString(),windowOwner,Date.now()]);
    else await db.run(D1_ENRICHMENT_FENCE,[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]);
    await write();
    await db.run('DELETE FROM projection_fence');
   });
  }catch(error){
   // A refused fence is told apart by re-reading, never by the error text: the lease lost and the window lost are different outcomes.
   if(windowOwner&&/CHECK constraint failed/i.test(String(error?.message||error))){
    const held=await db.get('SELECT 1 AS ok FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?',[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]).catch(()=>null);
    try{error.fenceCause=held?'window':'lease';}catch{}
   }
   throw error;
  }
 };
 const state=(kind,id,key)=>db.run(D1_ENRICHMENT_STATE,[D1_ENRICHMENT_PROJECTION,kind,id,key,new Date().toISOString()]);
 const syncState=(id,key)=>db.run(D1_ENRICHMENT_STATE,[METADATA_SYNC_PROJECTION,'film',id,key,new Date().toISOString()]);
 const writeSync=async item=>{await repository.projectFilmSyncState({filmId:item.id,sync:item.sync});await syncState(item.id,item.key);};
 const budgetLeft=()=>db.queries<queryBudget&&Date.now()-started<wallMs;
 const failed=(kind,id,error)=>{
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message)){if(error?.fenceCause==='window')result.windowLost=true;else result.leaseLost=true;}
  result.errorCount++;
  if(result.errors.length<20)result.errors.push({kind,id,error:message.slice(0,160)});
 };
 const writePeople=async items=>{await fenced(async()=>{for(const entry of items){await repository.projectPerson({person:entry.person});await state('person',entry.id,entry.key);}});result.writtenPeople+=items.length;};
 // AIR-388 (fairness): the work of one run is three lanes that share ONE budget, not one queue in a fixed order. A strict order
 // "all changed Persons, then all changed Films" lets a Person backlog that is refilled faster than it drains (new credits arrive with
 // every Discovery chunk) keep the Films from ever being written. The lanes are Films (a Film a verified archive admitted and D1 has
 // never projected first, then the other changed Films, see d1EnrichmentAdmittedFirst), Persons (in plan order) and housekeeping
 // (the Film sync clocks, then the Films no source lists any more). Each step takes the lane with the lowest spent/weight, where spent
 // is the lane's own cost in the unit of the budget, queries, so a lane with dearer tasks does not get a larger share; a tie goes to
 // Films, then Persons, then housekeeping, so even a run whose load used most of the wall time writes a Film before anything else.
 // Nothing here raises the budget, the wall time or the window, and every batch is fenced exactly as before.
 // A Film's credits reference Person rows (film_person_credit.person_id -> person.id), so before a Film its own Persons that are still
 // in the plan are written, in the same step; they leave the Person lane, and a Person that failed is not retried in the run.
 const WEIGHT={film:3,people:2,housekeeping:1};
 const spent={film:0,people:0,housekeeping:0};
 const personOrder=plan.people.map(entry=>entry.id),personById=new Map(plan.people.map(entry=>[entry.id,entry])),tried=new Set();
 const syncById=new Map((plan.sync||[]).map(item=>[item.id,item]));
 const filmIds=new Set(plan.films.map(film=>film.id));
 const housekeeping=[];
 for(const item of plan.sync||[])if(!filmIds.has(item.id))housekeeping.push({kind:'sync',item});
 for(const entity of plan.absent)housekeeping.push({kind:'absent',item:entity});
 let personAt=0,filmAt=0,houseAt=0,peopleForFilms=0;
 const skipTried=()=>{while(personAt<personOrder.length&&tried.has(personOrder[personAt]))personAt++;};
 const untriedPeople=()=>personOrder.length-tried.size;
 // One Person that cannot be written must not hold back the rest of its group: a failed group is retried one by one.
 const writePeopleGroup=async items=>{
  for(const entry of items)tried.add(entry.id);
  try{await writePeople(items);}
  catch(error){
   if(items.length===1||/CHECK constraint failed/i.test(String(error?.message||error))){for(const entry of items)failed('person',entry.id,error);return;}
   for(const entry of items){if(result.leaseLost||result.windowLost||!budgetLeft())break;try{await writePeople([entry]);}catch(single){failed('person',entry.id,single);}}
  }
 };
 const takePeople=limit=>{const items=[];skipTried();while(personAt<personOrder.length&&items.length<limit){const id=personOrder[personAt++];if(!tried.has(id))items.push(personById.get(id));}return items;};
 const remaining=()=>untriedPeople()+(plan.films.length-filmAt)+(housekeeping.length-houseAt);
 // ADR 0106: the grouped path (null `bulk`: not selected, none of the following runs). Lanes are then accounted in statements sent, the unit of ADR 0106 decision 6; `bulkOff` switches the grouped path off for the rest of the run
 // (an unknown batch outcome, an unreadable marker, a fallback share over the stop share); `perEntityFilms` is how many Films of a refused group the per-entity path must still take one by one.
 let bulkOff=!bulk,perEntityFilms=0,groupMaxMs=0;
 const bulkStats=bulk?(result.bulk={groups:0,filmGroups:0,personGroups:0,groupSize:bulk.groupSize,applied:0,fallbacks:0,fallbackReasons:{},guardRefusals:0,constraintFallbacks:0,prefetchReads:0,guards:0,prefetchMisses:0,statements:0,prefetchStatements:0,prefetchMs:0,applyMs:0,films:0,people:0,stop:null,errors:[]}):null;
 if(bulk)result.authorityMoved=false;
 const cost=()=>bulk?db.statements:db.queries;
 // The clock left for a step: the run's wall budget or the held window's absolute expiry (whichever is first), minus the reserve (release, one group's latency and margin).
 const bulkFits=()=>Math.min(started+wallMs,windowExpiresAt??Infinity)-Date.now()-bulk.reserveMs>=(groupMaxMs||bulk.firstGroupMs)&&(bulk.statementBudget==null||db.statements<bulk.statementBudget);
 const bulkBook=(kind,cycle)=>{
  bulkStats.groups++;bulkStats[kind==='film'?'filmGroups':'personGroups']++;
  bulkStats.prefetchReads+=cycle.reads;bulkStats.guards+=cycle.guards;bulkStats.prefetchMisses+=cycle.prefetchMisses;bulkStats.statements+=cycle.statements;bulkStats.prefetchStatements+=cycle.prefetchStatements;bulkStats.prefetchMs+=cycle.prefetchMs;bulkStats.applyMs+=cycle.applyMs;
  groupMaxMs=Math.max(groupMaxMs,cycle.prefetchMs+cycle.applyMs);
  if(cycle.outcome==='applied'){bulkStats.applied++;return;}
  if(cycle.outcome==='stop')return;
  bulkStats.fallbacks++;bulkStats.fallbackReasons[cycle.reason]=(bulkStats.fallbackReasons[cycle.reason]||0)+1;
  if(cycle.reason==='guard_refused')bulkStats.guardRefusals++;
  if(cycle.reason==='constraint')bulkStats.constraintFallbacks++;
  if(cycle.error&&bulkStats.errors.length<5)bulkStats.errors.push({reason:cycle.reason,error:cycle.error});
  if(cycle.latch||cycle.reason==='marker_unavailable'){bulkOff=true;bulkStats.stop=cycle.latch?'batch_error':'marker_unavailable';}
  else if(bulkStats.groups>=bulk.fallbackMinGroups&&bulkStats.fallbacks/bulkStats.groups>bulk.fallbackShare){bulkOff=true;bulkStats.stop='fallback_rate';}
 };
 const bulkStop=reason=>{if(reason==='lease_lost')result.leaseLost=true;else if(reason==='window_lost')result.windowLost=true;else result.authorityMoved=true;bulkStats.stop=reason;};
 // The items of a Film group in write order: every still unwritten Person its Films credit (once), then the Films.
 const bulkItems=films=>{
  const items=[],seen=new Set();
  for(const entry of films)for(const id of new Set((entry.credits||[]).map(credit=>credit.personId)))if(personById.has(id)&&!tried.has(id)&&!seen.has(id)){seen.add(id);items.push({kind:'person',entry:personById.get(id)});}
  for(const entry of films)items.push({kind:'film',entry,pending:syncById.get(entry.id)||null});
  return items;
 };
 // One group of Films (stopping at a Film that carries redirects), shrunk by halves until it fits the statement cap, written by one cycle. Returns 'applied', 'fallback' or 'stop'.
 const bulkFilms=async()=>{
  const films=[];
  for(let at=filmAt;at<plan.films.length&&films.length<bulk.groupSize;at++){const entry=plan.films[at];if((entry.film?.redirects||[]).length)break;films.push(entry);}
  let count=films.length,items,cycle;
  for(;;){
   items=bulkItems(films.slice(0,count));
   cycle=await d1EnrichmentGroupCycle(db,items,{leaseId,windowOwner,maxStatements:bulk.maxStatements,marks});
   if(cycle.reason==='too_large'&&count>1){count=Math.ceil(count/2);continue;}
   break;
  }
  bulkBook('film',cycle);
  if(cycle.outcome==='stop'){bulkStop(cycle.reason);return 'stop';}
  if(cycle.outcome!=='applied'){perEntityFilms=count;return 'fallback';}
  for(const item of items){
   if(item.kind==='person'){tried.add(item.entry.id);result.writtenPeople++;peopleForFilms++;bulkStats.people++;}
   else{result.writtenFilms++;bulkStats.films++;if(item.pending)result.syncWrites++;}
  }
  filmAt+=count;
  return 'applied';
 };
 while(true){
  skipTried();
  const available=[];
  if(filmAt<plan.films.length)available.push('film');
  if(personAt<personOrder.length)available.push('people');
  if(houseAt<housekeeping.length)available.push('housekeeping');
  if(!available.length)break;
  if(result.leaseLost||result.windowLost||result.authorityMoved||!budgetLeft()){result.remaining=remaining();break;}
  let lane=available[0],best=Infinity;
  for(const name of available){const score=(spent[name]+1)/WEIGHT[name];if(score<best){best=score;lane=name;}}
  // The grouped path starts no step it cannot finish inside the reserve (the held window's absolute expiry included).
  if(bulk&&!bulkOff&&lane!=='housekeeping'&&!bulkFits()){bulkStats.stop=bulkStats.stop||'budget';result.remaining=remaining();break;}
  const before=cost();
  let task=null;
  try{
   if(lane==='people'){
    task={kind:'people',items:takePeople(bulk&&!bulkOff?bulk.personGroupSize:D1_ENRICHMENT_PERSON_BATCH)};
    let grouped=false;
    if(bulk&&!bulkOff&&task.items.length){
     const cycle=await d1EnrichmentGroupCycle(db,task.items.map(entry=>({kind:'person',entry})),{leaseId,windowOwner,maxStatements:bulk.maxStatements,marks});
     bulkBook('person',cycle);
     if(cycle.outcome==='stop'){bulkStop(cycle.reason);result.remaining=remaining();break;}
     if(cycle.outcome==='applied'){for(const entry of task.items)tried.add(entry.id);result.writtenPeople+=task.items.length;bulkStats.people+=task.items.length;grouped=true;}
    }
    if(!grouped)await writePeopleGroup(task.items);
   }else if(lane==='film'){
    // ADR 0106: a group of Films first, when the grouped path is selected, still on, and the next Film carries no redirect. A refused group leaves its Films to the per-entity code below, one by one.
    let grouped=false;
    if(bulk&&!bulkOff&&perEntityFilms===0&&!(plan.films[filmAt].film?.redirects||[]).length){
     const outcome=await bulkFilms();
     if(outcome==='stop'){result.remaining=remaining();break;}
     grouped=outcome==='applied';
    }
    if(grouped)task={kind:'bulk'};
    else{
    const consumed=perEntityFilms>0;if(consumed)perEntityFilms--;
    const entry=plan.films[filmAt++];
    task={kind:'film',item:entry};
    // This Film's own Persons first (see above); a failure there is recorded by writePeopleGroup and does not stop the Film attempt.
    const needed=[...new Set((entry.credits||[]).map(credit=>credit.personId))].filter(id=>personById.has(id)&&!tried.has(id));
    for(let i=0;i<needed.length&&!result.leaseLost&&!result.windowLost&&budgetLeft();i+=D1_ENRICHMENT_PERSON_BATCH){
     const group=needed.slice(i,i+D1_ENRICHMENT_PERSON_BATCH).map(id=>personById.get(id));
     await writePeopleGroup(group);peopleForFilms+=group.length;
    }
    // The Film's own batch starts only inside the budget and only with the lease and the window: the Persons just written can have used
    // what was left. A Film not attempted for that reason stays in the lane (the next run finds it again, its Persons already
    // checkpointed) and counts as remaining; it is not an error.
    if(result.leaseLost||result.windowLost||result.authorityMoved||!budgetLeft()){filmAt--;if(consumed)perEntityFilms++;continue;}
    const pending=syncById.get(entry.id)||null;
    await fenced(async()=>{
     await repository.projectFilm({film:entry.film,watchlist:entry.watchlist,credits:entry.credits,metadata:entry.metadata??undefined,preserveCanonical:entry.preserveCanonical===true});
     for(const redirect of entry.film.redirects||[])await repository.projectLink({survivor:entry.film,redirect});
     if(pending)await writeSync(pending);
     await state('film',entry.id,entry.key);
    });
    result.writtenFilms++;
    if(pending)result.syncWrites++;
    }
   }else{
    task=housekeeping[houseAt++];
    if(task.kind==='sync'){
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
   }
  }catch(error){
   if(task?.kind==='film'||task?.kind==='sync'||task?.kind==='absent')failed(task.kind==='sync'?'film_sync':task.kind==='absent'?task.item.kind||'film':'film',task.item.id,error);
   else if(task?.kind==='people')for(const entry of task.items)failed('person',entry.id,error);
   else failed('film',null,error);
  }finally{
   spent[lane]+=Math.max(1,cost()-before);
  }
 }
 result.laneQueries={...spent};result.peopleForFilms=peopleForFilms;
 if(bulkStats){const seconds=Math.max(0.001,(Date.now()-started)/1000);bulkStats.perWindowSecond={films:+(bulkStats.films/seconds).toFixed(2),people:+(bulkStats.people/seconds).toFixed(2)};}
 return result;
}

// The read-only status of the projector for /api/d1/status. schema is true for the whole of migration 0004 (its three tables
// and schema_contract version 4), for migration 0005 (those tables, film_sync_state and version 5), for migration 0006
// (those plus metadata_cache, metadata_cache_authority, metadata_cache_cas and version 6), and for version 7 or newer
// when the ten prediction-domain tables are all present or all absent. A partial prediction domain is false.
// A later additive version without those tables stays true: another migration may have advanced the contract.
// Version 4 stays true when the sync table is absent. Version 5 stays true when the cache tables are absent.
// Version 6 stays true when the prediction-domain tables are absent.
// ownerReviewMode is reported only when the three owner-review tables exist; version 9 is not that proof by itself.
async function d1EnrichmentStatus(binding,env){
 const mode=d1EnrichmentMode(env);
 const present=((await binding.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('projection_state','projection_run','projection_fence','film_sync_state','metadata_cache','metadata_cache_authority','metadata_cache_cas','prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent')").bind().all()).results||[]).map(row=>row.name);
 const tables=present.filter(name=>name==='projection_state'||name==='projection_run'||name==='projection_fence').sort();
 const syncTable=present.includes('film_sync_state');
 const cacheReady=present.includes('metadata_cache')&&present.includes('metadata_cache_authority')&&present.includes('metadata_cache_cas');
 const predictionNames=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
 const predictionReady=predictionNames.every(name=>present.includes(name));
 const predictionAbsent=predictionNames.every(name=>!present.includes(name));
 const version=(await binding.prepare('SELECT version FROM schema_contract WHERE id=1').bind().first())?.version??null;
 if(tables.length!==3||!(version===4||(version===5&&syncTable)||(version===6&&syncTable&&cacheReady)||(Number(version)>=7&&syncTable&&cacheReady&&(predictionReady||predictionAbsent))))return {mode,schema:false,schemaVersion:version,projectionTables:tables};
 const [run,counts]=await Promise.all([
  binding.prepare('SELECT lease_until leaseUntil,started_at startedAt,finished_at finishedAt,outcome,summary_json summary FROM projection_run WHERE projection=?').bind(D1_ENRICHMENT_PROJECTION).first(),
  binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent,MAX(projected_at) AS lastWriteAt FROM projection_state WHERE projection=?").bind(D1_ENRICHMENT_PROJECTION).first(),
 ]);
 let summary=null;try{summary=run?.summary?JSON.parse(run.summary):null;}catch{}
 const lastWriteAt=counts?.lastWriteAt||null,lastWriteMs=Date.parse(lastWriteAt||'');
 const status={mode,schema:true,checkpoints:counts?.total??0,absent:counts?.absent??0,lastWriteAt,lastWriteAgeSec:Number.isFinite(lastWriteMs)?Math.max(0,Math.round((Date.now()-lastWriteMs)/1000)):null,windowMode:d1EnrichmentWindowMode(env),lastRun:run?{startedAt:run.startedAt,finishedAt:run.finishedAt,outcome:run.outcome,leaseHeld:!!run.leaseUntil,summary}:null};
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
