// AIR-391 offline spike. Not part of the Worker bundle and never run by CI or any production path: it measures the D1 enrichment
// projector's write phase on an in-memory SQLite database with a virtual clock for the D1 network (no sleeping, no production
// access). The REAL projector (src/d1-enrichment.js) and the REAL repository (src/canonical-repository.js) are loaded as the Worker
// bundle carries them, so statement and round-trip counts are exact; only the latency of a round trip and of a statement is a
// parameter, calibrated against two production anchors (docs/evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md).
//   node scripts/projector-spike-bench.mjs [--films 5000] [--pool 8000]
// The group cycle of variant C (`bulkGroup`) is exported for tests/projector-bulk-spike.mjs, which proves its read-validity guards.
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {MemoryBucket} from '../tests/memory-bucket.mjs';
import {projectorContext} from '../tests/d1-enrichment-context.mjs';

export const MIGRATIONS=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'];
const isRead=sql=>/^\s*SELECT/i.test(sql);

// D1 stand-in over node:sqlite. Counts every round trip and statement; the virtual clock is derived from the counters afterwards.
// `film_person_authority` is a one-row stand-in of the marker of migration 0013 (mode, cutover, generation).
export function standin(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON;');
 for(const name of MIGRATIONS)sqlite.exec(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 sqlite.exec("CREATE TABLE film_person_authority (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, cutover TEXT NOT NULL, generation INTEGER NOT NULL); INSERT INTO film_person_authority VALUES (1,'r2','open',0);");
 const calls={reads:0,singleWrites:0,batches:0,batchStatements:0,batchReads:0};
 let cpuNs=0n;
 const timed=fn=>{const start=process.hrtime.bigint();try{return fn();}finally{cpuNs+=process.hrtime.bigint()-start;}};
 const exec=(sql,params)=>timed(()=>{const stmt=sqlite.prepare(sql);return isRead(sql)?{results:stmt.all(...params)}:(stmt.run(...params),{results:[]});});
 const statement=(sql,params)=>({sql,params,
  async first(){calls.reads++;return exec(sql,params).results[0]??null;},
  async all(){calls.reads++;return exec(sql,params);},
  async run(){calls.singleWrites++;return exec(sql,params);}});
 return {
  calls,sqlite,
  get cpuMs(){return Number(cpuNs)/1e6;},
  resetCalls(){for(const key of Object.keys(calls))calls[key]=0;cpuNs=0n;},
  prepare(sql){return {bind:(...params)=>statement(sql,params)};},
  async batch(statements){
   calls.batches++;calls.batchStatements+=statements.length;calls.batchReads+=statements.filter(item=>isRead(item.sql)).length;
   sqlite.exec('BEGIN');
   try{const out=statements.map(item=>exec(item.sql,item.params));sqlite.exec('COMMIT');return out;}
   catch(error){sqlite.exec('ROLLBACK');throw error;}
  },
 };
}
// One round trip costs rtt; a statement inside a batch costs stmt on top of its batch's round trip.
export const wallMs=(calls,{rtt,stmt})=>(calls.reads+calls.singleWrites+calls.batches)*rtt+calls.batchStatements*stmt;

// ---- synthetic workload ------------------------------------------------------------------------------------------------------------------
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+record.id,synopsisFetchedAt:T,runtime:120});
// 1 director and 11 actors per Film (12 credits, production 12.2), `fresh` of them new Persons (production: about 3 per projected Film) and the rest
// from a pool of `pool` Persons the database already holds.
export function filmRecord(index,fresh,pool,count=11){
 const actors=[];
 for(let k=0;k<count;k++)actors.push(k<fresh?person('actor/n'+index+'_'+k,'New '+index+'_'+k):person('actor/pool'+((index*7+k*13)%pool),'Pool '+((index*7+k*13)%pool)));
 return {id:'w'+index,title:'Film '+index,original:'Film '+index,year:1995,tmdbId:String(100+index),url:'https://letterboxd.com/film/w'+index+'/',directors:[person('director/d'+index,'Director '+index)],actors};
}
export function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}
export const seedFilms=pool=>Array.from({length:Math.ceil(pool/11)},(_,index)=>({...filmRecord(1000000+index,0,pool),actors:Array.from({length:11},(_,k)=>{const n=(index*11+k)%pool;return person('actor/pool'+n,'Pool '+n);})}));

// Record what the real run hands to the repository, so the variants replay exactly the same Films and Persons.
export function recordingProjector(){
 const projector=projectorContext({log:()=>{}});
 const captured=[];
 const real=projector.CanonicalRepository.createCanonicalRepository;
 projector.CanonicalRepository.createCanonicalRepository=db=>{
  const repository=real(db);
  return {...repository,
   projectFilm:input=>{captured.push({kind:'film',input});return repository.projectFilm(input);},
   projectPerson:input=>{captured.push({kind:'person',input});return repository.projectPerson(input);},
   projectLink:input=>repository.projectLink(input)};
 };
 return {projector,captured};
}
const TABLES=['film','film_external_id','film_alias','film_dimension','film_person_credit','film_metadata','watchlist_film','person','person_external_id','person_alias','person_dimension','projection_state'];
export const dump=db=>JSON.stringify(TABLES.map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(table==='projection_state'?[row.projection,row.kind,row.id]:Object.values(row).map(value=>typeof value==='string'?value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g,'<run time>'):value))).sort()));

// ---- variant C: one group cycle with read validation ------------------------------------------------------------------------------------
// Permitted writers while the cycle runs: the projector alone (ADR 0099 decision 11: with the film_person_authority marker r2 or prepared the
// R2-sourced projector is the only canonical writer; the fenced canonical mutations refuse unless the marker is d1). Beyond that exclusivity,
// the cycle proves its reads instead of trusting them: every distinct read it prefetched is re-run INSIDE the write batch and compared with the
// digest the prefetch saw, and the marker generation is asserted in the same batch. Any difference makes the batch fail its CHECK, roll back whole
// and send the group to the per-entity path (the existing fenced transaction per Film and per Person). A read shape that cannot be digested, or a read
// the traced pass did not see, does the same. Nothing is written from a read that was not re-proven in the batch that writes.
const FENCE='INSERT INTO projection_fence (held) SELECT COUNT(*) FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?';
const STATE='INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES (?,?,?,?,?) ON CONFLICT(projection,kind,id) DO UPDATE SET change_key=excluded.change_key,projected_at=excluded.projected_at';
const readKey=(sql,params)=>sql+'\u0000'+JSON.stringify(params);
// The digest expression of a simple SELECT: the rows as one JSON text. Only `SELECT <plain columns> FROM ...` shapes qualify (no function calls in the list).
export function digestSql(sql){
 const match=/^\s*SELECT\s+(.+?)\s+FROM\s+/is.exec(sql);
 if(!match||match[1].includes('(')||/\bGROUP\b|\bUNION\b/i.test(sql))return null;
 const names=match[1].split(',').map(item=>{const parts=item.trim().split(/\s+AS\s+/i);return (parts[1]||parts[0]).trim();});
 return `(SELECT COALESCE(json_group_array(json_array(${names.join(',')})),'[]') FROM (${sql}))`;
}
export async function bulkGroup(projector,db,items,{lease,expectedGeneration=0,beforeApply=null}={}){
 const stats={reads:0,guards:0,prefetchMisses:0,outcome:'applied',reason:null};
 const seen=new Map();
 const trace={async get(sql,params=[]){seen.set(readKey(sql,params),{sql,params});return null;},async all(sql,params=[]){seen.set(readKey(sql,params),{sql,params});return [];},async run(){},async transaction(fn){return fn();}};
 const traceRepository=projector.CanonicalRepository.createCanonicalRepository(trace);
 for(const item of items)await (item.kind==='film'?traceRepository.projectFilm(item.input):traceRepository.projectPerson(item.input));
 const reads=[...seen.values()],digests=reads.map(read=>digestSql(read.sql));
 if(digests.some(item=>item===null))return {...stats,outcome:'fallback',reason:'undigestable_read'};
 // ONE round trip: every read and its digest.
 const batch=[];reads.forEach((read,index)=>{batch.push({sql:read.sql,params:read.params});batch.push({sql:'SELECT '+digests[index]+' AS d',params:read.params});});
 const out=await db.batch(batch);
 const answers=new Map(),expected=[];
 reads.forEach((read,index)=>{answers.set(readKey(read.sql,read.params),out[index*2].results);expected.push(out[index*2+1].results[0].d);});
 stats.reads=reads.length;
 if(beforeApply)await beforeApply();
 const writes=[{sql:FENCE,params:['enrichment',lease,new Date().toISOString()]}];
 // the marker generation the group was planned under is asserted again inside the batch
 writes.push({sql:"INSERT INTO projection_fence (held) SELECT COUNT(*) FROM film_person_authority WHERE id=1 AND mode IN ('r2','prepared') AND cutover='open' AND generation=?",params:[expectedGeneration]});
 reads.forEach((read,index)=>{writes.push({sql:'INSERT INTO projection_fence (held) SELECT CASE WHEN '+digests[index]+'=? THEN 1 ELSE 0 END',params:[...read.params,expected[index]]});stats.guards++;});
 const collector={
  async get(sql,params=[]){const key=readKey(sql,params);if(answers.has(key))return answers.get(key)[0]??null;stats.prefetchMisses++;return null;},
  async all(sql,params=[]){const key=readKey(sql,params);if(answers.has(key))return answers.get(key);stats.prefetchMisses++;return [];},
  async run(sql,params=[]){writes.push({sql,params});},
  async transaction(fn){return fn();}};
 const repository=projector.CanonicalRepository.createCanonicalRepository(collector);
 let failure=null;
 for(const item of items){
  try{
   if(item.kind==='film'){await repository.projectFilm(item.input);writes.push({sql:STATE,params:['enrichment','film',item.input.film.id,item.key||'k',T]});}
   else{await repository.projectPerson(item.input);writes.push({sql:STATE,params:['enrichment','person',item.input.person.id,item.key||'k',T]});}
  }catch(error){failure=error;break;}
 }
 if(failure||stats.prefetchMisses)return {...stats,outcome:'fallback',reason:failure?'plan_error':'prefetch_miss'};
 writes.push({sql:'DELETE FROM projection_fence',params:[]});
 try{await db.batch(writes);}
 catch(error){
  if(!/CHECK constraint failed/i.test(String(error?.message||error)))throw error;
  return {...stats,outcome:'fallback',reason:'guard_refused'};
 }
 stats.statements=writes.length;
 return stats;
}
// The per-entity path the group falls back to: the existing fenced transaction per Film and per Person, exactly as the projector does it today.
export async function perEntity(projector,db,items,{lease}){
 const adapter=projector.d1EnrichmentAdapter({prepare:sql=>({bind:(...params)=>db.prepare(sql).bind(...params)}),batch:statements=>db.batch(statements)});
 const repository=projector.CanonicalRepository.createCanonicalRepository(adapter);
 const errors=[];
 for(const item of items){
  const id=item.kind==='film'?item.input.film.id:item.input.person.id;
  try{
   await adapter.transaction(async()=>{
    await adapter.run(FENCE,['enrichment',lease,new Date().toISOString()]);
    await (item.kind==='film'?repository.projectFilm(item.input):repository.projectPerson(item.input));
    await adapter.run(STATE,['enrichment',item.kind,id,item.key||'k',T]);
    await adapter.run('DELETE FROM projection_fence',[]);
   });
  }catch(error){errors.push({id,error:String(error?.message||error).slice(0,120)});}
 }
 return errors;
}
export const holdLease=(db,lease='lease-bench')=>db.sqlite.prepare('INSERT INTO projection_run (projection,lease_id,lease_until) VALUES (?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until').run('enrichment',lease,new Date(Date.now()+6e5).toISOString());

// ---- the benchmark ---------------------------------------------------------------------------------------------------------------------
const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
const percentile=(values,p)=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor(p*sorted.length))];};
async function seeded(pool){
 const db=standin(),{projector}=recordingProjector();
 await projector.runD1EnrichmentProjection({DB:db,BUCKET:sources(seedFilms(pool)),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 db.resetCalls();
 return {db,projector};
}
const sum=(items,pick)=>items.reduce((total,item)=>total+pick(item),0);
const trips=calls=>calls.reads+calls.singleWrites+calls.batches;
// The measured cost of every unit the simulation schedules, taken from the real counters of the runs above.
export async function measure({films:FILMS=5000,pool:POOL=8000,group:GROUP=10}={}){
 // Films differ like production's (mean 12.2 credits): 75 % have 11 actors, 20 % 6, 5 % 35; new Persons per Film 1 to 5 (mean 3), never more than the actors.
 const hash=(index,salt)=>(Math.imul(index+salt,2654435761)>>>0)/4294967296;
 const measured=Array.from({length:FILMS},(_,index)=>{const u=hash(index,1),count=u<0.75?11:u<0.95?6:35;return filmRecord(index,Math.min(count,1+Math.floor(hash(index,7)*5)),POOL,count);});
 const {db:a0Db}=await seeded(POOL);
 const rec=recordingProjector();
 const t0=process.hrtime.bigint();
 const summary=await rec.projector.runD1EnrichmentProjection({DB:a0Db,BUCKET:sources([...seedFilms(POOL),...measured]),D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 const a0Seconds=Number(process.hrtime.bigint()-t0)/1e9;
 if(summary.outcome!=='complete')throw new Error('A0 incomplete '+JSON.stringify(summary));
 const a0Calls={...a0Db.calls},a0Dump=dump(a0Db);
 const films=rec.captured.filter(item=>item.kind==='film'),people=rec.captured.filter(item=>item.kind==='person');
 const out={films:FILMS,pool:POOL,a0:{writtenFilms:summary.writtenFilms,writtenPeople:summary.writtenPeople,inView:{films:summary.films,people:summary.people},loadMsCpu:summary.loadMs,viewMsCpu:summary.viewMs,wallSecondsOnThisMachine:+a0Seconds.toFixed(1),calls:a0Calls,perFilm:{roundTrips:+(trips(a0Calls)/FILMS).toFixed(2),statements:+(a0Calls.batchStatements/FILMS).toFixed(1)}}};
 // C: the same inputs in groups with read validation; the rows must equal A0's
 const {db:cDb,projector}=await seeded(POOL);
 holdLease(cDb);
 const byPerson=new Map(people.map(item=>[item.input.person.id,item]));
 const written=new Set(),filmGroups=[],personGroups=[];
 let applied=0,fallbacks=0;
 const cycle=async(items,bucket)=>{
  const before={...cDb.calls},cpuBefore=cDb.cpuMs;
  const stats=await bulkGroup(projector,cDb,items,{lease:'lease-bench'});
  if(stats.outcome==='applied')applied++;else{fallbacks++;await perEntity(projector,cDb,items,{lease:'lease-bench'});}
  bucket.push({calls:Object.fromEntries(Object.keys(before).map(key=>[key,cDb.calls[key]-before[key]])),cpuMs:cDb.cpuMs-cpuBefore,items:items.length,films:items.filter(item=>item.kind==='film').length,people:items.filter(item=>item.kind==='person').length});
 };
 for(let at=0;at<films.length;at+=GROUP){
  const group=films.slice(at,at+GROUP),items=[];
  for(const film of group)for(const credit of film.input.credits||[])if(byPerson.has(credit.personId)&&!written.has(credit.personId)){written.add(credit.personId);items.push(byPerson.get(credit.personId));}
  for(const film of group)items.push(film);
  await cycle(items,filmGroups);
 }
 const leftovers=people.filter(item=>!written.has(item.input.person.id));
 for(let at=0;at<leftovers.length;at+=25)await cycle(leftovers.slice(at,at+25),personGroups);
 out.c={group:GROUP,applied,fallbacks,calls:{...cDb.calls},sameRowsAsA0:dump(cDb)===a0Dump,
  perFilm:{roundTrips:+(trips(cDb.calls)/FILMS).toFixed(3),statements:+(cDb.calls.batchStatements/FILMS).toFixed(1)},cpuMsPerFilm:+(cDb.cpuMs/FILMS).toFixed(2)};
 out.unit={filmGroup:{roundTrips:sum(filmGroups,x=>trips(x.calls))/filmGroups.length,statements:sum(filmGroups,x=>x.calls.batchStatements)/filmGroups.length,films:sum(filmGroups,x=>x.films)/filmGroups.length,people:sum(filmGroups,x=>x.people)/filmGroups.length},
  personGroup:personGroups.length?{roundTrips:sum(personGroups,x=>trips(x.calls))/personGroups.length,statements:sum(personGroups,x=>x.calls.batchStatements)/personGroups.length,people:sum(personGroups,x=>x.people)/personGroups.length}:null};
 // a Person-only unit is measured on a fresh database too, so the Person lane has its own cost
 {
  const {db,projector:p}=await seeded(POOL);holdLease(db);
  const fresh=Array.from({length:250},(_,index)=>({kind:'person',input:{person:{...people[index].input.person,id:'person:actor/extra'+index,roleId:'actor/extra'+index}}}));
  const before={...db.calls};
  const probe=[];
  for(let at=0;at<fresh.length;at+=25){const b={...db.calls};await bulkGroup(p,db,fresh.slice(at,at+25),{lease:'lease-bench'});probe.push(Object.fromEntries(Object.keys(b).map(key=>[key,db.calls[key]-b[key]])));}
  out.unit.personGroup={roundTrips:sum(probe,x=>trips(x))/probe.length,statements:sum(probe,x=>x.batchStatements)/probe.length,people:25};
  void before;
 }
 out.filmGroupCalls=filmGroups.map(x=>x.calls);
 return out;
}
async function main(){
 const FILMS=arg('films',5000),POOL=arg('pool',8000);
 const out=await measure({films:FILMS,pool:POOL});
 const {filmGroupCalls,...printable}=out;
 console.log(JSON.stringify(printable,null,1));
 const latencies=[[35,1],[50,1.5],[50,2]].map(([rtt,stmt])=>{const values=filmGroupCalls.map(calls=>wallMs(calls,{rtt,stmt}));return {rtt,stmt,groupMs:{p50:Math.round(percentile(values,0.5)),p95:Math.round(percentile(values,0.95)),max:Math.round(Math.max(...values))},a0MsPerFilm:Math.round(wallMs(out.a0.calls,{rtt,stmt})/FILMS)};});
 console.log(JSON.stringify({groupLatency:latencies},null,1));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
