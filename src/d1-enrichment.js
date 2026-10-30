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
const D1_ENRICHMENT_LEASE_MS=10*60000;
const D1_ENRICHMENT_QUERY_BUDGET=800;
const D1_ENRICHMENT_WALL_MS=60000;
const D1_ENRICHMENT_PERSON_BATCH=25;
const D1_ENRICHMENT_ABSENT_MIN=25,D1_ENRICHMENT_ABSENT_SHARE=0.02;
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
// any D1 write, while a present, empty one is a real empty dataset. The programme and the catalog are read from the one published
// generation the pointer names, never from the root copies, and the pointer must name that same generation after the reads, so
// a run never mixes two generations. Only the Letterboxd diary is optional: it is absent while its own switch is off.
class D1EnrichmentInputError extends Error{constructor(reason,key){super(reason+(key?': '+key:''));this.reason=reason;this.key=key||null;}}
const d1EnrichmentRecord=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const d1EnrichmentFilmList=value=>d1EnrichmentRecord(value)&&Array.isArray(value.films);
async function d1EnrichmentRead(env,key,shape,required=true){
 const object=await env.BUCKET.get(key);
 if(!object){if(required)throw new D1EnrichmentInputError('input_missing',key);return null;}
 let value;
 try{value=await object.json();}catch{throw new D1EnrichmentInputError('input_invalid',key);}
 if(!shape(value))throw new D1EnrichmentInputError('input_invalid',key);
 return value;
}
async function d1EnrichmentGeneration(env){
 const pointer=await d1EnrichmentRead(env,EPG_GENERATION_KEY,d1EnrichmentRecord);
 if(pointer.phase!=='published'||typeof pointer.programmeRunId!=='string'||!pointer.programmeRunId)throw new D1EnrichmentInputError('generation_unpublished',EPG_GENERATION_KEY);
 return pointer.programmeRunId;
}
async function d1EnrichmentStore(env){
 const runId=await d1EnrichmentGeneration(env);
 const [watchlist,programme,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory]=await Promise.all([
  d1EnrichmentRead(env,'watchlist.json',d1EnrichmentFilmList),
  d1EnrichmentRead(env,epgGenerationKey(runId,'programme.json'),d1EnrichmentFilmList),
  d1EnrichmentRead(env,'metadata.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,'titles.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,'people.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,epgGenerationKey(runId,'discovered-films.json'),d1EnrichmentRecord),
  d1EnrichmentRead(env,'epg/discovery-resolution.json',d1EnrichmentRecord),
  d1EnrichmentRead(env,'letterboxd/diary/history.json',d1EnrichmentRecord,false),
 ]);
 if(await d1EnrichmentGeneration(env)!==runId)throw new D1EnrichmentInputError('generation_moved',EPG_GENERATION_KEY);
 const store=EnrichmentProjection.enrichmentStore({watchlist,programme,metadata,titles,people,discoveredFilms,discoveryResolution,diaryHistory,filmTitles:FILM_TITLE_DICTIONARY,personNames:PERSON_NAME_DICTIONARY,personOverrides:{'actor/chris-pratt':REVIEWED_PEOPLE['actor/chris-pratt']}});
 return {store,programmeRunId:runId};
}

// The plan of one run: every Person and Film whose change key differs from the stored one, and every stored entity the view
// no longer has. Persons come first so a Film's credits find their people.
function d1EnrichmentPlan(inputs,stored,nowIso){
 const people=[],films=[],absent=[],seen=new Set();
 for(const entry of inputs.people){
  const key=EnrichmentProjection.personChangeKey(entry,nowIso);
  seen.add('person\n'+entry.id);
  if(stored.get('person\n'+entry.id)!==key)people.push({...entry,key});
 }
 for(const entry of inputs.films){
  const key=EnrichmentProjection.filmChangeKey(entry,nowIso);
  seen.add('film\n'+entry.id);
  if(stored.get('film\n'+entry.id)!==key)films.push({...entry,key});
 }
 for(const [id,key] of stored){
  if(seen.has(id)||key==='absent')continue;
  const [kind,entityId]=id.split('\n');
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
  // More absences than a routine sync explains point at broken input, not at real removals: nothing is written.
  const absentLimit=Math.max(D1_ENRICHMENT_ABSENT_MIN,Math.ceil(summary.stored*D1_ENRICHMENT_ABSENT_SHARE));
  if(plan.absent.length>absentLimit){summary.outcome='absent_guard';summary.absentLimit=absentLimit;return summary;}
  if(mode==='dry'){summary.outcome='dry';return summary;}
  const written=await d1EnrichmentWrite(db,plan,{leaseId,started,queryBudget,wallMs});
  Object.assign(summary,written,{outcome:written.leaseLost?'lease_lost':written.errorCount?'partial':written.remaining?'budget':'complete'});
  return summary;
 }catch(error){
  summary.outcome='failed';summary.error=String(error?.message||error).slice(0,200);
  if(error instanceof D1EnrichmentInputError){summary.reason=error.reason;summary.inputKey=error.key;}
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
 const inputs=EnrichmentProjection.enrichmentInputs({view:LifecycleReader.readLifecycle(store,now,{entitiesOnly:true}),store});
 summary.viewMs=Date.now()-started-summary.loadMs;
 const stored=new Map((await db.all('SELECT kind,id,change_key FROM projection_state WHERE projection=?',[D1_ENRICHMENT_PROJECTION])).map(row=>[row.kind+'\n'+row.id,row.change_key]));
 const plan=d1EnrichmentPlan(inputs,stored,nowIso);
 Object.assign(summary,{films:inputs.films.length,people:inputs.people.length,stored:stored.size,changedPeople:plan.people.length,changedFilms:plan.films.length,absent:plan.absent.length,unmatchedCreditFilms:inputs.films.filter(film=>film.unmatched).length});
 return plan;
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
 const result={writtenPeople:0,writtenFilms:0,released:0,errorCount:0,errors:[],remaining:0,leaseLost:false};
 const fenced=async(write)=>{
  await db.transaction(async()=>{
   await db.run(D1_ENRICHMENT_FENCE,[D1_ENRICHMENT_PROJECTION,leaseId,new Date().toISOString()]);
   await write();
   await db.run('DELETE FROM projection_fence');
  });
 };
 const state=(kind,id,key)=>db.run(D1_ENRICHMENT_STATE,[D1_ENRICHMENT_PROJECTION,kind,id,key,new Date().toISOString()]);
 const budgetLeft=()=>db.queries<queryBudget&&Date.now()-started<wallMs;
 const failed=(kind,id,error)=>{
  const message=String(error?.message||error);
  if(/CHECK constraint failed/i.test(message))result.leaseLost=true;
  result.errorCount++;
  if(result.errors.length<20)result.errors.push({kind,id,error:message.slice(0,160)});
 };
 const writePeople=async items=>{await fenced(async()=>{for(const entry of items){await repository.projectPerson({person:entry.person});await state('person',entry.id,entry.key);}});result.writtenPeople+=items.length;};
 const queue=[];
 for(let i=0;i<plan.people.length;i+=D1_ENRICHMENT_PERSON_BATCH)queue.push({kind:'people',items:plan.people.slice(i,i+D1_ENRICHMENT_PERSON_BATCH)});
 for(const film of plan.films)queue.push({kind:'film',item:film});
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
    await fenced(async()=>{
     await repository.projectFilm({film:entry.film,watchlist:entry.watchlist,credits:entry.credits,metadata:entry.metadata??undefined});
     for(const redirect of entry.film.redirects||[])await repository.projectLink({survivor:entry.film,redirect});
     await state('film',entry.id,entry.key);
    });
    result.writtenFilms++;
   }else{
    const entity=task.item;
    await fenced(async()=>{if(entity.kind==='film')await repository.releaseFilm(entity.id);await state(entity.kind,entity.id,'absent');});
    result.released++;
   }
  }catch(error){
   if(task.kind==='people')for(const entry of task.items)failed('person',entry.id,error);
   else failed(task.item.kind||'film',task.item.id,error);
  }
 }
 return result;
}

// The read-only status of the projector for /api/d1/status. A database without schema v4 has no projector tables yet.
async function d1EnrichmentStatus(binding,env){
 const mode=d1EnrichmentMode(env);
 const present=(await binding.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('projection_state','projection_run')").bind().first())?.n===2;
 if(!present)return {mode,schema:false};
 const [run,counts]=await Promise.all([
  binding.prepare('SELECT lease_until leaseUntil,started_at startedAt,finished_at finishedAt,outcome,summary_json summary FROM projection_run WHERE projection=?').bind(D1_ENRICHMENT_PROJECTION).first(),
  binding.prepare("SELECT COUNT(*) AS total,SUM(change_key='absent') AS absent FROM projection_state WHERE projection=?").bind(D1_ENRICHMENT_PROJECTION).first(),
 ]);
 let summary=null;try{summary=run?.summary?JSON.parse(run.summary):null;}catch{}
 return {mode,schema:true,checkpoints:counts?.total??0,absent:counts?.absent??0,lastRun:run?{startedAt:run.startedAt,finishedAt:run.finishedAt,outcome:run.outcome,leaseHeld:!!run.leaseUntil,summary}:null};
}
