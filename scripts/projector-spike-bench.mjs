// AIR-391 offline spike. Not part of the Worker bundle and never run by CI or any production path: it measures the D1 enrichment
// projector's write phase on an in-memory SQLite database with a virtual clock for the D1 network (no sleeping, no production
// access). The REAL projector (src/d1-enrichment.js) and the REAL repository (src/canonical-repository.js) are loaded as the Worker
// bundle carries them, so statement and round-trip counts are exact; only the latency of a round trip and of a statement is a
// parameter, swept against two production anchors (see docs/evidence/d1-migration/air-391-bulk-projector-spike-2026-11-09.md).
//   node --experimental-sqlite scripts/projector-spike-bench.mjs [--films N] [--json]
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {MemoryBucket} from '../tests/memory-bucket.mjs';
import {projectorContext} from '../tests/d1-enrichment-context.mjs';

const arg=(name,fallback)=>{const at=process.argv.indexOf('--'+name);return at>0?Number(process.argv[at+1]):fallback;};
const FILMS=arg('films',120),PER_GROUP=arg('group',10),JSON_OUT=process.argv.includes('--json');
const MIGRATIONS=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'];

// D1 stand-in over node:sqlite. Counts every round trip and statement; the virtual clock is derived from the counters afterwards.
function standin(){
 const sqlite=new DatabaseSync(':memory:');
 sqlite.exec('PRAGMA foreign_keys=ON;');
 for(const name of MIGRATIONS)sqlite.exec(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 const calls={reads:0,singleWrites:0,batches:0,batchStatements:0,batchReads:0};
 let cpuNs=0n;
 const timed=fn=>{const start=process.hrtime.bigint();try{return fn();}finally{cpuNs+=process.hrtime.bigint()-start;}};
 const isRead=sql=>/^\s*SELECT/i.test(sql);
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

// The latency model: one round trip costs RTT; a statement inside a batch costs S on top of the batch's own round trip.
const wallMs=(calls,{rtt,stmt})=>(calls.reads+calls.singleWrites+calls.batches)*rtt+calls.batchStatements*stmt;

// Synthetic Films shaped like production (2026-11-09: 12.2 credits per Film, 3053 Films / 29691 Persons / 37321 credits in D1): one director and
// eleven actors, of which `fresh` are new Persons (production: about 3 new Persons per projected Film, 25 Persons for 8 Films) and the
// rest come from a pool the database already holds.
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+record.id,synopsisFetchedAt:T,runtime:120});
const POOL=300;
function filmRecord(index,fresh){
 const actors=[];
 for(let k=0;k<11;k++)actors.push(k<fresh?person('actor/n'+index+'_'+k,'New '+index+'_'+k):person('actor/pool'+((index*7+k*13)%POOL),'Pool '+((index*7+k*13)%POOL)));
 return {id:'w'+index,title:'Film '+index,original:'Film '+index,year:1995,tmdbId:String(100+index),url:'https://letterboxd.com/film/w'+index+'/',directors:[person('director/d'+index,'Director '+index)],actors};
}
function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}

// Record what the real run hands to the repository, so the variants can replay exactly the same Films and Persons.
function recordingProjector(){
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
 return {projector,captured,restore:()=>{projector.CanonicalRepository.createCanonicalRepository=real;}};
}
const one=(db,sql)=>Object.values(db.sqlite.prepare(sql).get()||{})[0];
const dump=db=>JSON.stringify(['film','film_external_id','film_alias','film_dimension','film_person_credit','film_metadata','watchlist_film','person','person_external_id','person_alias','person_dimension','projection_state'].map(table=>db.sqlite.prepare('SELECT * FROM '+table).all().map(row=>JSON.stringify(table==='projection_state'?[row.projection,row.kind,row.id]:Object.values(row).map(value=>typeof value==='string'?value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g,'<run time>'):value))).sort()));

// --- Variant A0: the current projector, unmodified (real run) ---------------------------------------------------------------------------
const seedFilms=Array.from({length:Math.ceil(POOL/11)},(_,index)=>({...filmRecord(1000+index,0),actors:Array.from({length:11},(_,k)=>{const n=(index*11+k)%POOL;return person('actor/pool'+n,'Pool '+n);})}));       // seeds the whole Person pool (unmeasured)
const measured=Array.from({length:FILMS},(_,index)=>filmRecord(index,3));
const seedEnv=db=>({DB:db,BUCKET:sources(seedFilms),D1_ENRICHMENT_WRITE:'on'});
async function seeded(){
 const db=standin();
 const {projector}=recordingProjector();
 await projector.runD1EnrichmentProjection(seedEnv(db),{queryBudget:1e9,wallMs:1e9});
 // The pool persons are now in D1; the seed Films are checkpointed and stay unchanged in every later run.
 db.resetCalls();
 return {db,projector};
}
const results={films:FILMS,group:PER_GROUP};
let a0Dump,a0Calls,captured;
{
 const {db}=await seeded();
 const rec=recordingProjector();
 const bucket=sources([...seedFilms,...measured]);
 const summary=await rec.projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e9});
 if(summary.outcome!=='complete'||summary.writtenFilms!==FILMS)throw new Error('baseline did not complete: '+JSON.stringify(summary));
 captured=rec.captured;
 a0Calls={...db.calls};a0Dump=dump(db);
 const people=summary.writtenPeople;
 results.a0={writtenFilms:summary.writtenFilms,writtenPeople:people,queries:summary.queries,calls:a0Calls,
  perFilm:{roundTrips:+((a0Calls.reads+a0Calls.singleWrites+a0Calls.batches)/FILMS).toFixed(2),statements:+(a0Calls.batchStatements/FILMS).toFixed(1),reads:+(a0Calls.reads/FILMS).toFixed(2)},cpuMs:db.cpuMs};
 results.shape={credits:one(db,'SELECT COUNT(*) FROM film_person_credit'),filmRows:one(db,'SELECT COUNT(*) FROM film'),personRows:one(db,'SELECT COUNT(*) FROM person')};
}

// Split the captured A0 calls by kind so the Film-only and Person-only unit costs can be reported (reads of a Person: 1; of a Film: see below).
const filmInputs=captured.filter(item=>item.kind==='film').map(item=>item.input);
const personInputs=captured.filter(item=>item.kind==='person').map(item=>item.input);
const personsOf=film=>new Set((film.credits||[]).map(credit=>credit.personId));

// --- Variant C: bulk write into the existing repository ---------------------------------------------------------------------------------
// One cycle = G Films and their still unwritten Persons. Pass 1 traces the reads the repository will make (nothing is written, reads answer
// "absent"), one batch of SELECTs fetches them all (one round trip), pass 2 runs the same repository calls against that read cache and
// COLLECTS the writes, and one fenced batch applies them atomically. The repository, its statements and the change keys are not changed.
const FENCE='INSERT INTO projection_fence (held) SELECT COUNT(*) FROM projection_run WHERE projection=? AND lease_id=? AND lease_until>?';
function keyOf(sql,params){return sql+'\u0000'+JSON.stringify(params);}
async function bulkRun(projector,db,groupSize){
 const lease='lease-bench',until=new Date(Date.now()+6e5).toISOString();
 db.sqlite.prepare('INSERT INTO projection_run (projection,lease_id,lease_until) VALUES (?,?,?) ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until').run('enrichment',lease,until);
 const stats={cycles:0,prefetched:0,misses:0,statements:0};
 const writtenPersons=new Set();
 const people=new Map(personInputs.map(input=>[input.person.id,input]));
 const state=(kind,id)=>['INSERT INTO projection_state (projection,kind,id,change_key,projected_at) VALUES (?,?,?,?,?) ON CONFLICT(projection,kind,id) DO UPDATE SET change_key=excluded.change_key,projected_at=excluded.projected_at',['enrichment',kind,id,'k',T]];
 for(let at=0;at<filmInputs.length;at+=groupSize){
  const films=filmInputs.slice(at,at+groupSize);
  const items=[];
  for(const film of films)for(const id of personsOf(film))if(people.has(id)&&!writtenPersons.has(id)){writtenPersons.add(id);items.push({kind:'person',input:people.get(id)});}
  for(const film of films)items.push({kind:'film',input:film});
  const trace=new Set();
  const tracer={async get(sql,params=[]){trace.add(keyOf(sql,params));return null;},async all(sql,params=[]){trace.add(keyOf(sql,params));return [];},async run(){},async transaction(fn){return fn();}};
  const traceRepo=projector.CanonicalRepository.createCanonicalRepository(tracer);
  for(const item of items)await (item.kind==='film'?traceRepo.projectFilm({...item.input,preserveCanonical:false}):traceRepo.projectPerson(item.input));
  // one round trip for every read of the cycle
  const reads=[...trace].map(key=>{const [sql,params]=key.split('\u0000');return {sql,params:JSON.parse(params)};});
  const answers=new Map();
  if(reads.length){const out=await db.batch(reads.map(read=>({sql:read.sql,params:read.params})));reads.forEach((read,index)=>answers.set(keyOf(read.sql,read.params),out[index].results));}
  stats.prefetched+=reads.length;
  const writes=[{sql:FENCE,params:['enrichment',lease,new Date().toISOString()]}];
  const collector={
   async get(sql,params=[]){const key=keyOf(sql,params);if(answers.has(key))return answers.get(key)[0]??null;stats.misses++;return (await db.prepare(sql).bind(...params).first());},
   async all(sql,params=[]){const key=keyOf(sql,params);if(answers.has(key))return answers.get(key);stats.misses++;return (await db.prepare(sql).bind(...params).all()).results;},
   async run(sql,params=[]){writes.push({sql,params});},
   async transaction(fn){return fn();}};
  const repo=projector.CanonicalRepository.createCanonicalRepository(collector);
  for(const item of items){
   if(item.kind==='film'){await repo.projectFilm(item.input);writes.push({sql:state('film',item.input.film.id)[0],params:state('film',item.input.film.id)[1]});}
   else{await repo.projectPerson(item.input);writes.push({sql:state('person',item.input.person.id)[0],params:state('person',item.input.person.id)[1]});}
  }
  writes.push({sql:'DELETE FROM projection_fence',params:[]});
  await db.batch(writes);
  stats.cycles++;stats.statements+=writes.length;
 }
 return stats;
}
// One Film + its Persons per cycle (group of 1) up to the group sizes under study.
results.c={};
for(const groupSize of [1,5,10,25,50]){
 const {db,projector}=await seeded();
 // the seed run also checkpointed the seed Films; the measured Films are written by the bulk run only
 const stats=await bulkRun(projector,db,groupSize);
 const calls={...db.calls};
 const filmCount=filmInputs.length;
 results.c[groupSize]={cycles:stats.cycles,misses:stats.misses,calls,perFilm:{roundTrips:+((calls.reads+calls.singleWrites+calls.batches)/filmCount).toFixed(3),statements:+(calls.batchStatements/filmCount).toFixed(1)},cpuMs:db.cpuMs,sameRowsAsA0:dumpRows(db)===a0Rows(),differing:tableDiff(a0Rows(),dumpRows(db))};
 db.release=null;
}
function tableDiff(a,b){const x=JSON.parse(a),y=JSON.parse(b),names=['film','film_external_id','film_alias','film_dimension','film_person_credit','film_metadata','watchlist_film','person','person_external_id','person_alias','person_dimension','projection_state'];return names.filter((name,i)=>JSON.stringify(x[i])!==JSON.stringify(y[i])).map(name=>name+':'+JSON.parse(a)[names.indexOf(name)].length+'/'+JSON.parse(b)[names.indexOf(name)].length);}
// Row equivalence: A0 and C must leave identical canonical rows (change keys differ in their opaque text, so projection_state is compared by id only).
function a0Rows(){return a0Dump;}
function firstDiff(a,b,table){const names=['film','film_external_id','film_alias','film_dimension','film_person_credit','film_metadata','watchlist_film','person','person_external_id','person_alias','person_dimension','projection_state'];const i=names.indexOf(table),x=JSON.parse(a)[i],y=JSON.parse(b)[i];for(let k=0;k<x.length;k++)if(x[k]!==y[k])return [x[k],y[k]];return null;}
function dumpRows(db){return dump(db);}

// --- latency sweep and the two production anchors --------------------------------------------------------------------------------------
// Anchor P (Persons only, 2026-11-09 06:01 and 07:01 UTC): 775 Persons written in 37.6 s and 42.5 s of write phase (822 queries).
// Anchor F (Films, 08:00 and 09:00 UTC): 17 Films with 80 of their Persons in about 12 s of write phase; film lane 4.0 to 4.8 queries per Film.
const person775=(()=>{ // cost of the Person lane from real counters: one read per Person plus one batch of 25 statements-groups
 const reads=personInputs.length,batches=Math.ceil(personInputs.length/25);
 return {reads,batches};
})();
results.anchors={personWriteSeconds:[37.6,42.5],personsPerTick:775,filmSecondsEach:0.7};
const rttGrid=[15,25,35,50,75],stmtGrid=[0.25,0.5,1,2,4];
results.sweep=[];
for(const rtt of rttGrid)for(const stmt of stmtGrid){
 const a0=wallMs(a0Calls,{rtt,stmt})/FILMS;                       // ms per Film in the current projector, Persons included
 const c10=wallMs(results.c[10].calls,{rtt,stmt})/FILMS;
 const c25=wallMs(results.c[25].calls,{rtt,stmt})/FILMS;
 // Person-only anchor: 775 Persons, one read each and 31 batches of 25 Persons; statements per Person measured below
 results.sweep.push({rtt,stmt,a0MsPerFilm:+a0.toFixed(0),c10MsPerFilm:+c10.toFixed(0),c25MsPerFilm:+c25.toFixed(0)});
}
// statements per Person and per Film, measured on the captured inputs (batch only)
{
 const {db,projector}=await seeded();
 const repo=projector.CanonicalRepository.createCanonicalRepository({async get(){return null;},async all(){return [];},async run(){db.calls.batchStatements++;},async transaction(fn){return fn();}});
 db.resetCalls();
 for(const input of personInputs.slice(0,50))await repo.projectPerson(input);
 results.unit={statementsPerPerson:+(db.calls.batchStatements/50).toFixed(1)};
 db.resetCalls();
 for(const input of filmInputs.slice(0,50))await repo.projectFilm({...input});
 results.unit.statementsPerFilm=+(db.calls.batchStatements/50).toFixed(1);
}
// Person anchor from the model: 775 reads + 31 batches of 25 Persons
results.personAnchor=rttGrid.flatMap(rtt=>stmtGrid.map(stmt=>({rtt,stmt,seconds:+((775*rtt+31*rtt+775*results.unit.statementsPerPerson*stmt)/1000).toFixed(1)})));


// --- capacity per hourly window (analytic over the measured counters) ---------------------------------------------------------------
// Films an hour = write seconds / cost per Film, cost from the real counters at a calibrated (rtt, stmt). The write seconds are the wall budget
// minus the load that ran after the grant (production: 5.8 s fast ticks, 29-33 s slow ticks, 2026-11-09), times the share of the budget the
// Film lane may use (the scheduler gives Films 3 of 6 weights, so about 50-60 % when Persons are also pending). A1 = the current structure with
// the reads of D1 issued six at a time (the D1 connection limit) and a Film's Persons in its own batch; modelled from the A0 counters.
const a1Calls={...a0Calls,reads:Math.ceil(a0Calls.reads/6),batches:Math.ceil(a0Calls.batches/2)};
results.capacity=[];
for(const [rtt,stmt] of [[50,1],[50,1.5],[50,2],[35,2]])for(const [wall,load] of [[60,6],[60,30],[150,30],[300,30]])for(const share of [0.6,1]){
 const row={rtt,stmt,wallS:wall,loadS:load,share};
 for(const [name,calls] of [['A0',a0Calls],['A1',a1Calls],['C10',results.c[10].calls]]){const perFilm=wallMs(calls,{rtt,stmt})/FILMS/1000;row[name]=Math.round((wall-load)*share/perFilm);}
 results.capacity.push(row);
}
if(process.argv.includes('--diff')){const {db,projector}=await seeded();await bulkRun(projector,db,10);console.log(JSON.stringify(firstDiff(a0Dump,dump(db),'film')),JSON.stringify(firstDiff(a0Dump,dump(db),'person')));}
if(JSON_OUT)console.log(JSON.stringify(results,null,1));
else{
 console.log('A0 (current projector, real run):',JSON.stringify(results.a0));
 console.log('unit statements:',JSON.stringify(results.unit),'shape:',JSON.stringify(results.shape));
 for(const [size,item] of Object.entries(results.c))console.log('C group',size,JSON.stringify({cycles:item.cycles,misses:item.misses,perFilm:item.perFilm,cpuMs:+item.cpuMs.toFixed(1),sameRows:item.sameRowsAsA0,differing:item.differing}));
}
