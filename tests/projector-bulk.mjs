// ADR 0106, stage (a): the grouped write path of the D1 enrichment projector, behind D1_ENRICHMENT_BULK (off by default). A D1 stand-in over
// the sqlite3 CLI runs the whole migration chain (the real film_person_authority marker, triggers, unique indexes and foreign keys); R2 is a
// memory bucket. Nothing here calls Cloudflare or production. Covered: the flag; row parity with the per-entity path (new and pooled Persons,
// owner-reviewed names, D1-only TMDB credits, sync clocks, a changed, removed and added Film); two round trips for a group; every conflict
// between the prefetch and the write batch (an appearing redirect, an owner review of a read Person, a marker generation move, a lost lease,
// a lost window) refuses the whole batch and writes nothing; an unseen read, an undigestable read, a planning error, a unique conflict, a
// missing Person, a statement cap, an unknown batch outcome (also one that committed) and a D1 limit fall back with the same final rows;
// partial budgets and the window expiry; replay convergence; the fallback-rate latch; lane order.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-projector-bulk-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=(opts={})=>{
 const file=path.join(root,'b-'+(databases++)+'.sqlite');
 const result=spawnSync('sqlite3',['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return {file,db:d1Standin(file,opts)};
};
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis of '+record.id,synopsisFetchedAt:T,runtime:120});
// 1 director and `count` actors per Film; `fresh` of them are Persons only this Film has, the rest come from a pool the database already holds.
function filmRecord(index,{fresh=3,count=6,pool=12,shared=null}={}){
 const actors=[];
 for(let k=0;k<count;k++)actors.push(k<fresh?person('actor/n'+index+'_'+k,'New '+index+'_'+k):person('actor/pool'+((index*5+k*3)%pool),'Pool '+((index*5+k*3)%pool)));
 if(shared)actors.push(person('actor/shared','Shared Actor'));
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
const logs=[];
const projector=projectorContext({log:line=>logs.push(JSON.parse(line))});
const BIG={queryBudget:1e9,wallMs:1e9};
const envFor=(db,bucket,bulk)=>({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on',...(bulk?{D1_ENRICHMENT_BULK:bulk}:{})});
const run=(db,bucket,bulk,options={})=>projector.runD1EnrichmentProjection(envFor(db,bucket,bulk),{...BIG,...options});
const TABLES=['film','film_external_id','film_alias','film_dimension','film_person_credit','film_metadata','watchlist_film','person','person_external_id','person_alias','person_dimension','film_sync_state','localization_conflict','film_redirect','projection_state'];
// The rows of every table the projector writes, with the clock of the run normalized away; projection_state without its time.
const dump=db=>JSON.stringify(TABLES.map(table=>db.sql('SELECT * FROM '+table).map(row=>JSON.stringify(Object.entries(row).filter(([key])=>!(table==='projection_state'&&key==='projected_at')).map(([,value])=>typeof value==='string'?value.replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d+Z/g,'<run time>'):value))).sort()));
const fkProblems=db=>db.sql('PRAGMA foreign_key_check').length;
const danglingCredits=db=>Number(one(db,'SELECT COUNT(*) AS n FROM film_person_credit c LEFT JOIN person p ON p.id=c.person_id WHERE p.id IS NULL'));
const count=(db,table)=>Number(one(db,'SELECT COUNT(*) AS n FROM '+table));
const WRITE_BATCH=statements=>/^INSERT INTO projection_fence/i.test(statements[0].text)&&statements.some(item=>/INSERT INTO (film|person)\b/.test(item.text));

// 0. The flag: exact `on` only, read by the write run only; a dry run and an off run never see it.
{
 for(const value of ['off','On',' on','true','',undefined,{}])assert.equal(projector.d1EnrichmentBulkMode({D1_ENRICHMENT_BULK:value}),'off');
 assert.equal(projector.d1EnrichmentBulkMode({D1_ENRICHMENT_BULK:'on'}),'on');
 assert.equal(projector.d1EnrichmentBulkOptions({},{}),null);
 assert.deepEqual({...projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{groupSize:-1,maxStatements:'x',reserveMs:-5})},{...projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},{})},'invalid overrides are ignored');
 const films=[filmRecord(1),filmRecord(2)];
 const off=migrated(),dry=migrated(),on=migrated();
 const a=await run(off.db,sources(films),'off');
 assert.equal(a.bulk,undefined,'flag off: no grouped path and no grouped summary');assert.equal(a.outcome,'complete');
 const d=await projector.runD1EnrichmentProjection({DB:dry.db,BUCKET:sources(films),D1_ENRICHMENT_WRITE:'dry',D1_ENRICHMENT_BULK:'on'},BIG);
 assert.equal(d.outcome,'dry');assert.equal(d.bulk,undefined);assert.equal(count(dry.db,'film'),0);assert.equal(dry.db.calls.batches,0,'dry writes nothing');
 const c=await run(on.db,sources(films),'on');
 assert.equal(c.outcome,'complete');assert.equal(c.bulk.applied,1);assert.equal(c.bulk.fallbacks,0);
 assert.equal(dump(on.db),dump(off.db),'the same rows with the flag off and on');
}

// 1. Parity over a richer data set and a second, changed pass (a Film changed, one removed, one added; a Person renamed under an owner review).
{
 const phase1=[filmRecord(1),filmRecord(2,{count:11,fresh:5}),filmRecord(3,{shared:true}),filmRecord(4,{shared:true}),filmRecord(5,{fresh:0}),filmRecord(6),filmRecord(7)];
 const phase2=[{...filmRecord(1),title:'Film 1 renamed',actors:filmRecord(1).actors.slice(1)},filmRecord(2,{count:11,fresh:5}),filmRecord(3,{shared:true}),filmRecord(5,{fresh:0}),filmRecord(6),filmRecord(7),filmRecord(8)];
 const result={};
 for(const bulk of ['off','on']){
  const {db}=migrated();
  const first=await run(db,sources(phase1),bulk);
  assert.equal(first.outcome,'complete',JSON.stringify(first));assert.equal(first.errorCount,0);
  // an owner reviewed a Person's name and a D1-only TMDB credit was added to a watchlist Film (both must survive the second pass)
  db.sql("UPDATE person_dimension SET status='reviewed',source='owner',authority='owner',value='Owner Name' WHERE person_id='person:actor/n2_0' AND dimension='localization'");
  db.sql("INSERT INTO person (id,role_id,contract_version,updated_at) VALUES ('person:tmdb_9','role:tmdb_9',1,'t')");
  db.sql("INSERT INTO film_person_credit (film_id,person_id,role,ordinal) VALUES ('film:w5','person:tmdb_9','actor',90)");
  const second=await run(db,sources(phase2),bulk);
  assert.equal(second.outcome,'complete',JSON.stringify(second));assert.equal(second.errorCount,0);
  assert.equal(fkProblems(db),0);assert.equal(danglingCredits(db),0);
  result[bulk]={rows:dump(db),first,second,calls:{...db.calls},owner:one(db,"SELECT value FROM person_dimension WHERE person_id='person:actor/n2_0' AND dimension='localization'"),kept:one(db,"SELECT COUNT(*) AS n FROM film_person_credit WHERE person_id='person:tmdb_9'")};
 }
 assert.equal(result.on.rows,result.off.rows,'every canonical table, the sync clocks and the change keys equal the per-entity path');
 assert.equal(result.on.owner,'Owner Name');assert.equal(Number(result.on.kept),1,'owner review and D1-only credit survive');
 assert.equal(result.on.first.writtenFilms,result.off.first.writtenFilms);assert.equal(result.on.first.writtenPeople,result.off.first.writtenPeople);
 assert.equal(result.on.second.writtenFilms,result.off.second.writtenFilms);assert.equal(result.on.second.syncWrites,result.off.second.syncWrites);
 assert.equal(result.on.first.bulk.fallbacks+result.on.second.bulk.fallbacks,0,JSON.stringify([result.on.first.bulk,result.on.second.bulk]));
 assert.ok(result.on.calls.batches<result.off.calls.batches,'fewer batches than the per-entity path: '+result.on.calls.batches+' vs '+result.off.calls.batches);
 assert.ok(result.on.calls.queries<result.off.calls.queries,'far fewer single round trips: '+result.on.calls.queries+' vs '+result.off.calls.queries);
 const bulk=result.on.first.bulk;
 assert.ok(bulk.statements>0&&bulk.prefetchReads>0&&bulk.guards===bulk.prefetchReads);
 assert.equal(bulk.films,7);assert.equal(typeof bulk.perWindowSecond.films,'number');
}

// ---- cycle-level tests on a real plan -----------------------------------------------------------------------------------------------------
// The plan of the real diff over a fresh database; the same plan is replayed on other fresh databases, so the per-entity path and the grouped path write the same input.
async function planned(films){
 const {db,file}=migrated();
 const bucket=sources(films);
 const plan=await projector.d1EnrichmentDiff({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},projector.d1EnrichmentAdapter(db),Date.now(),{});
 return {db,file,plan,bucket};
}
const itemsOf=(plan,n)=>{
 const byId=new Map(plan.people.map(entry=>[entry.id,entry])),seen=new Set(),items=[];
 const films=plan.films.slice(0,n);
 for(const entry of films)for(const id of new Set((entry.credits||[]).map(credit=>credit.personId)))if(personEntry(byId,id)&&!seen.has(id)){seen.add(id);items.push({kind:'person',entry:byId.get(id)});}
 for(const entry of films)items.push({kind:'film',entry,pending:(plan.sync||[]).find(item=>item.id===entry.id)||null});
 return items;
};
const personEntry=(byId,id)=>byId.has(id);
const holdLease=(db,lease='lease-test')=>db.sql("INSERT INTO projection_run (projection,lease_id,lease_until) VALUES ('enrichment','"+lease+"','"+new Date(Date.now()+6e5).toISOString()+"') ON CONFLICT(projection) DO UPDATE SET lease_id=excluded.lease_id,lease_until=excluded.lease_until");
const rowCount=db=>count(db,'film')+count(db,'person')+count(db,'film_person_credit')+count(db,'projection_state');
const films4=Array.from({length:4},(_,index)=>filmRecord(index+1,{shared:true}));
const MARKER0={mode:'r2',cutover:'open',generation:0};
const cycle=(binding,items,options={})=>projector.d1EnrichmentGroupCycle(projector.d1EnrichmentAdapter(binding),items,{leaseId:'lease-test',expectedMarker:MARKER0,...options});
// A second stand-in over the same file whose hook runs before every batch (after the call, before the statements): the way another writer lands between two batches.
const hooked=(file,onBatch,extra={})=>d1Standin(file,{onBatch,...extra});
const isWrite=statements=>!/^\s*SELECT/i.test(statements[0].text);

// 2. A group with no interference is two round trips and no single query; every read has a guard.
{
 const {db,file,plan}=await planned(films4);
 holdLease(db);
 const stand=hooked(file,null);
 const stats=await cycle(stand,itemsOf(plan,4));
 assert.equal(stats.outcome,'applied',JSON.stringify(stats));
 assert.equal(stand.calls.batches,2,'one read batch and one write batch');assert.equal(stand.calls.queries,0,'no single query');
 assert.equal(stats.guards,stats.reads);assert.ok(stats.reads>=4*3);assert.equal(stats.prefetchMisses,0);
 assert.equal(stats.prefetchStatements,1+2*stats.reads);
 assert.equal(stats.statements,stand.calls.statements-stats.prefetchStatements,'the write batch is every statement but the prefetch');
 assert.equal(count(db,'film'),4);assert.equal(danglingCredits(db),0);assert.equal(fkProblems(db),0);
 // the marker, the lease and the generation the group was planned under are asserted in the batch itself
 assert.equal(Number(one(db,'SELECT COUNT(*) AS n FROM projection_fence')),0,'the fence row is cleared');
}

// 3. A change between the prefetch and the write batch refuses the whole batch and writes nothing.
const dropTriggers='DROP TRIGGER film_person_authority_transition;DROP TRIGGER film_person_authority_needs_baseline;';
const conflicts=[
 ['a redirect appears for a Film of the group',(db,items)=>{const id=items.find(item=>item.kind==='film').entry.id;db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'x','t')");db.sql("INSERT INTO film_redirect (from_id,to_film_id,at) VALUES ('"+id+"','film:other','t')");},'fallback','guard_refused'],
 ['an owner review of a read Person appears',(db,items)=>{const id=items.find(item=>item.kind==='person').entry.id;db.sql("INSERT OR IGNORE INTO person (id,role_id,contract_version,updated_at) VALUES ('"+id+"','role:"+id+"',1,'t')");db.sql("INSERT OR REPLACE INTO person_dimension (person_id,dimension,status,source,source_version,provenance_json,value,authority,last_error,failure_reason,retry_at,attempts,next_action,updated_at) VALUES ('"+id+"','localization','reviewed','owner',NULL,NULL,'Owner value','owner',NULL,NULL,NULL,0,'none','t')");},'fallback','guard_refused'],
 ['a trusted external id appears for a Film of the group',(db,items)=>{const entry=items.find(item=>item.kind==='film').entry;db.sql("INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'x','t')");const tmdb=entry.film.externalIds.find(item=>item.scheme==='tmdb'&&item.trusted);db.sql("INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','tmdb','"+tmdb.value+"',1,0,NULL)");},'fallback','guard_refused'],
 ['the marker generation moves',db=>db.sql(dropTriggers+'UPDATE film_person_authority SET generation=generation+1'),'stop','authority_moved'],
 ['the marker leaves the projector',db=>db.sql(dropTriggers+"UPDATE film_person_authority SET mode='d1',generation=generation+1"),'stop','authority_moved'],
 ['the projector lease is lost',db=>db.sql("UPDATE projection_run SET lease_id='someone-else'"),'stop','lease_lost'],
];
for(const [name,mutate,outcome,reason] of conflicts){
 const {db,file,plan}=await planned(films4);
 holdLease(db);
 const items=itemsOf(plan,4);
 let before=null,fired=0;
 const stand=hooked(file,async statements=>{if(isWrite(statements)&&!fired++){mutate(db,items);before=rowCount(db);}});
 const stats=await cycle(stand,items);
 assert.equal(stats.outcome,outcome,name+': '+JSON.stringify(stats));assert.equal(stats.reason,reason,name);
 assert.equal(fired,1,name+': the write batch was attempted once');
 assert.equal(rowCount(db),before,name+': the refused batch wrote nothing');
 assert.equal(Number(one(db,'SELECT COUNT(*) AS n FROM projection_fence')),0,name+': no fence row left behind');
}
// a lost window is told from a lost lease: the lease is held, the window row expired under the group
{
 const {db,file,plan}=await planned(films4);
 holdLease(db);
 db.sql("UPDATE projector_window SET state='held',owner='lease-test',requested_at="+Date.now()+",expires_at="+(Date.now()+290000));
 const items=itemsOf(plan,4);
 let fired=0;
 const stand=hooked(file,async statements=>{if(isWrite(statements)&&!fired++)db.sql('UPDATE projector_window SET expires_at=1');});
 const stats=await cycle(stand,items,{windowOwner:'lease-test'});
 assert.deepEqual([stats.outcome,stats.reason],['stop','window_lost']);assert.equal(count(db,'film'),0);
 // and with the window still held the same group applies
 const again=await planned(films4);holdLease(again.db);
 again.db.sql("UPDATE projector_window SET state='held',owner='lease-test',requested_at="+Date.now()+",expires_at="+(Date.now()+290000));
 const applied=await cycle(hooked(again.file,null),itemsOf(again.plan,4),{windowOwner:'lease-test'});
 assert.equal(applied.outcome,'applied',JSON.stringify(applied));
}

// 3b. The planning generation is pinned: a marker that moved after the plan and before the prefetch, a missing planning marker and an absent table all stop with nothing written.
{
 const {db,file,plan}=await planned(films4);holdLease(db);
 db.sql(dropTriggers+'UPDATE film_person_authority SET generation=7');
 const moved=await cycle(hooked(file,null),itemsOf(plan,4));
 assert.deepEqual([moved.outcome,moved.reason],['stop','authority_moved'],'planned under generation 0, found 7 at prefetch');assert.equal(rowCount(db),0);
 const unpinned=await cycle(hooked(file,null),itemsOf(plan,4),{expectedMarker:null});
 assert.deepEqual([unpinned.outcome,unpinned.reason],['stop','authority_unavailable']);assert.equal(rowCount(db),0);
 const bare=await planned(films4);holdLease(bare.db);bare.db.sql('DROP TABLE film_person_authority');
 const absent=await cycle(hooked(bare.file,null),itemsOf(bare.plan,4));
 assert.deepEqual([absent.outcome,absent.reason],['stop','authority_unavailable']);assert.equal(rowCount(bare.db),0);
}
// 4. Reads the trace did not see, reads that cannot be digested and planning errors are never written from.
const realCreate=projector.CanonicalRepository.createCanonicalRepository;
const patch=wrap=>{let calls=0;projector.CanonicalRepository.createCanonicalRepository=target=>wrap(realCreate(target),target,++calls);};
const unpatch=()=>{projector.CanonicalRepository.createCanonicalRepository=realCreate;};
try{
 // a read only the second (collecting) pass issues
 {
  const {db,file,plan}=await planned(films4);holdLease(db);
  patch((repository,target,call)=>call===2?{...repository,projectPerson:async input=>{await target.get('SELECT 1 AS ok FROM person WHERE id=?',[input.person.id+'#second-pass-only']);return repository.projectPerson(input);}}:repository);
  const stats=await cycle(hooked(file,null),itemsOf(plan,4));
  assert.deepEqual([stats.outcome,stats.reason],['fallback','prefetch_miss']);assert.ok(stats.prefetchMisses>0);assert.equal(rowCount(db),0,'nothing of the group was written');
  unpatch();
 }
 // a read shape the digest cannot express: the group never leaves the Worker
 {
  const {db,file,plan}=await planned(films4);holdLease(db);
  patch((repository,target,call)=>call===1?{...repository,projectPerson:async input=>{await target.get('SELECT COUNT(*) AS n FROM film',[]);return repository.projectPerson(input);}}:repository);
  const stand=hooked(file,null);
  const stats=await cycle(stand,itemsOf(plan,4));
  assert.deepEqual([stats.outcome,stats.reason],['fallback','undigestable_read']);assert.equal(stand.calls.batches+stand.calls.queries,0,'no round trip was spent');
  unpatch();
 }
 // a planning error of the trace pass and of the collecting pass
 for(const failing of [1,2]){
  const {db,file,plan}=await planned(films4);holdLease(db);
  patch((repository,target,call)=>call===failing?{...repository,projectFilm:async()=>{throw new Error('planning failed');}}:repository);
  const stats=await cycle(hooked(file,null),itemsOf(plan,4));
  assert.deepEqual([stats.outcome,stats.reason],['fallback','plan_error'],'pass '+failing);assert.equal(rowCount(db),0);
  unpatch();
 }
}finally{unpatch();}
assert.equal(projector.d1EnrichmentDigestSql('SELECT COUNT(*) AS n FROM film'),null);
assert.equal(projector.d1EnrichmentDigestSql('SELECT a FROM t GROUP BY a'),null);
assert.equal(projector.d1EnrichmentDigestSql('SELECT a FROM t UNION SELECT b FROM u'),null);
assert.match(projector.d1EnrichmentDigestSql('SELECT person_id,role,ordinal FROM film_person_credit WHERE film_id=? ORDER BY role,ordinal'),/json_group_array\(json_array\(person_id,role,ordinal\)\)/);
assert.match(projector.d1EnrichmentDigestSql('SELECT 1 AS ok FROM watchlist_film WHERE film_id=?'),/json_array\(ok\)/);

// ---- write-level tests: the grouped path against the per-entity path on the same plan --------------------------------------------------------
async function writeWith(binding,plan,{bulk=null,...options}={}){
 const adapter=projector.d1EnrichmentAdapter(binding),leaseId='lease-'+Math.random().toString(16).slice(2);
 assert.ok(await projector.d1EnrichmentLease(adapter,leaseId));
 // the marker the run is planned under, as the run reads it before its diff
 let marker=null;try{const row=binding.sql('SELECT mode,cutover,generation FROM film_person_authority WHERE id=1')[0];if(row)marker={mode:row.mode,cutover:row.cutover,generation:Number(row.generation)};}catch{}
 const bulkOptions=bulk?projector.d1EnrichmentBulkOptions({D1_ENRICHMENT_BULK:'on'},bulk):null;
 if(bulkOptions&&marker)bulkOptions.expectedMarker=marker;
 const result=await projector.d1EnrichmentWrite(adapter,plan,{leaseId,started:Date.now(),queryBudget:1e9,wallMs:1e9,bulk:bulkOptions,...options});
 binding.sql("UPDATE projection_run SET lease_id=NULL,lease_until=NULL WHERE projection='enrichment' AND lease_id='"+leaseId+"'");
 return {result,adapter,leaseId};
}
const clone=value=>JSON.parse(JSON.stringify(value));
// Both paths over the same plan on fresh databases; returns both rows dumps and results.
async function both(plan,mutatePlan=null,bulk={},hookFor=null){
 const a=migrated(),c=migrated();
 const planA=clone(plan),planC=clone(plan);
 if(mutatePlan){mutatePlan(planA);mutatePlan(planC);}
 const off=await writeWith(a.db,planA);
 const stand=hookFor?hookFor(c):c.db;
 const on=await writeWith(stand,planC,{bulk});
 return {a,c,off:off.result,on:on.result,same:dump(a.db)===dump(c.db)};
}
const bigPlan=await planned(Array.from({length:7},(_,index)=>filmRecord(index+1,{shared:index%2===0})));

// 5. Parity of the whole write, the groups it needs, and the order of the Films.
{
 const {off,on,same,c}=await both(bigPlan.plan,null,{groupSize:3});
 assert.ok(same,'rows equal');assert.deepEqual([on.writtenFilms,on.writtenPeople,on.errorCount],[off.writtenFilms,off.writtenPeople,off.errorCount]);
 assert.equal(on.bulk.filmGroups,3,'7 Films in groups of 3: 3, 3 and 1');assert.equal(on.bulk.fallbacks,0);assert.equal(on.bulk.films,7);
 assert.ok(on.peopleForFilms>0&&on.peopleForFilms<=on.writtenPeople,'the Person lane also took its turn: '+on.peopleForFilms+' of '+on.writtenPeople);
 assert.deepEqual(c.db.sql("SELECT id FROM projection_state WHERE projection='enrichment' AND kind='film' ORDER BY rowid").map(row=>row.id),[...bigPlan.plan.films].map(entry=>entry.id),'Films are written in plan order (admitted-first order is the plan order)');
 assert.equal(danglingCredits(c.db),0);assert.equal(fkProblems(c.db),0);
 assert.ok(on.laneQueries.film>0,'lanes are accounted in statements: '+JSON.stringify(on.laneQueries));
}

// 3c. Under the grouped path the per-entity writes carry the marker guard too: a group that falls back cannot write after the marker moved.
{
 const a=migrated(),c=migrated();
 let fired=0;
 const stand=hooked(c.file,async statements=>{if(isWrite(statements)&&!fired++)c.db.sql(dropTriggers+'UPDATE film_person_authority SET generation=generation+1');});
 const {result}=await writeWith(stand,clone(bigPlan.plan),{bulk:{groupSize:7,maxStatements:12}});
 assert.equal(result.authorityMoved,true);assert.equal(result.authorityReason,'authority_moved');assert.equal(result.leaseLost,false);assert.equal(count(c.db,'film'),0,'nothing written after the marker moved');
 void a;
}

// 6. A Person lane step is a grouped write too, and both lanes share the budget (weights 3:2, Films first).
{
 const extras=plan=>{for(let index=0;index<30;index++){const base=plan.people[0];plan.people.push({...base,id:'person:actor/extra'+index,key:'extra'+index,person:{...base.person,id:'person:actor/extra'+index,roleId:'actor/extra'+index}});}};
 const {off,on,same}=await both(bigPlan.plan,extras,{groupSize:2,personGroupSize:10});
 assert.ok(same);assert.equal(on.writtenPeople,off.writtenPeople);assert.ok(on.bulk.personGroups>=3,'the Person lane writes in groups of up to 10: '+on.bulk.personGroups);assert.equal(on.bulk.fallbacks,0);
 assert.ok(on.laneQueries.people>0&&on.laneQueries.film>0);
}

// 7. A Film with a redirect never joins a group; the others still do.
{
 const redirect=plan=>{const entry=plan.films[3];entry.film.redirects=[{from:'film:old-one',to:entry.film.id,at:T}];};
 const {off,on,same}=await both(bigPlan.plan,redirect,{groupSize:10});
 assert.ok(same,'rows equal, whatever the redirect does');assert.equal(on.errorCount,off.errorCount);
 assert.equal(on.bulk.films,6,'the Film with the redirect was written by the per-entity path');assert.equal(on.bulk.filmGroups,2,'a group before it and a group after it');
}

// 8. Constraints: a trusted external id another Film of the group takes, a missing Person. The batch rolls back whole and the group replays one by one.
{
 const duplicate=plan=>{const first=plan.films[0],copy=clone(first);copy.id='film:dupe';copy.film.id='film:dupe';copy.key='dupe';copy.credits=[];plan.films.splice(1,0,copy);};
 const {off,on,same,c}=await both(bigPlan.plan,duplicate,{groupSize:4});
 assert.ok(same);assert.equal(off.errorCount,1,JSON.stringify(off.errors));assert.equal(on.errorCount,1,'the per-entity replay reports the same collision');assert.match(on.errors[0].error,/identity_collision/);
 assert.equal(on.bulk.constraintFallbacks,1);assert.equal(on.bulk.stop,null,'one constraint does not switch the grouped path off');
 assert.equal(count(c.db,'film_external_id')>0,true);
 const missing=plan=>{const credited=plan.films[0].credits[0].personId;plan.people=plan.people.filter(entry=>entry.id!==credited);};
 const lost=await both(bigPlan.plan,missing,{groupSize:4});
 assert.ok(lost.same);assert.equal(lost.on.errorCount,lost.off.errorCount);assert.ok(lost.on.errorCount>=1);assert.equal(danglingCredits(lost.c.db),0,'no dangling credit');assert.equal(fkProblems(lost.c.db),0);
 assert.ok(lost.on.bulk.constraintFallbacks>=1);
}

// 9. The statement cap shrinks a group by halves, then sends a Film that still does not fit to the per-entity path.
{
 const small=await both(bigPlan.plan,null,{groupSize:7,maxStatements:400});
 assert.ok(small.same);assert.ok(small.on.bulk.filmGroups>=2,'the group was halved: '+JSON.stringify(small.on.bulk));assert.equal(small.on.bulk.fallbacks,0);
 assert.ok(small.on.bulk.statements<=400*small.on.bulk.groups);
 const tiny=await both(bigPlan.plan,null,{groupSize:7,maxStatements:12});
 assert.ok(tiny.same);assert.ok(tiny.on.bulk.fallbackReasons.too_large>0);assert.equal(tiny.on.errorCount,0);
}

// 10. Unknown batch outcomes: the replay is the per-entity path, the rows converge, the grouped path is off for the rest of the run.
{
 for(const [label,fail] of [['network error before the commit',async()=>{throw new Error('D1_ERROR: Network connection lost');}],['a D1 size limit',async()=>{throw new Error('D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR');}]]){
  let fired=0;
  const {off,on,same}=await both(bigPlan.plan,null,{groupSize:3},c=>hooked(c.file,async statements=>{if(isWrite(statements)&&statements.length>20&&!fired++)await fail();}));
  assert.ok(same,label);assert.equal(on.errorCount,off.errorCount);assert.equal(on.bulk.stop,'batch_error',label);assert.equal(on.bulk.fallbackReasons.batch_error,1);assert.equal(on.bulk.groups,1,'no further group after the latch');
 }
 // the batch committed and the answer was lost: the replay over committed rows writes the same rows again, once
 let fired=0;
 const {off,on,same,a}=await both(bigPlan.plan,null,{groupSize:3},stand=>{const real=hooked(stand.file,null);const batch=real.batch.bind(real);real.batch=async statements=>{const out=await batch(statements);if(isWrite(statements)&&statements.length>20&&!fired++)throw new Error('D1_ERROR: Network connection lost');return out;};return real;});
 assert.ok(same,'a committed group replayed converges to the same rows');assert.equal(on.errorCount,off.errorCount);assert.equal(on.bulk.stop,'batch_error');
 assert.equal(Number(one(a.db,'SELECT COUNT(*) AS n FROM (SELECT film_id,role,ordinal FROM film_person_credit GROUP BY film_id,role,ordinal HAVING COUNT(*)>1)')),0,'no credit is written twice (the unique order index would refuse)');
}

// 11. Partial budgets converge across runs; the window's absolute expiry and the wall reserve stop a group from starting.
{
 const a=migrated(),c=migrated();
 await writeWith(a.db,clone(bigPlan.plan));
 let total=0,runs=0,first=null;
 for(;;){
  const {plan}=await (async()=>{const bucket=bigPlan.bucket;const p=await projector.d1EnrichmentDiff({DB:c.db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},projector.d1EnrichmentAdapter(c.db),Date.now(),{});return {plan:p};})();
  if(!plan.films.length&&!plan.people.length&&!plan.absent.length)break;
  const {result}=await writeWith(c.db,plan,{bulk:{groupSize:2},queryBudget:3});
  first=first||result;total+=result.writtenFilms;runs++;
  assert.ok(runs<10,'converges');
 }
 assert.ok(first.remaining>0&&runs>1,'the first run stopped on its query budget with work left: '+JSON.stringify([first.remaining,runs]));assert.equal(total,7);
 assert.equal(dump(c.db),dump(a.db),'the budgeted runs converge to the same rows');
 // the held window's absolute expiry and the reserve: nothing is started that cannot finish
 const w=migrated();
 const stopped=await writeWith(w.db,clone(bigPlan.plan),{bulk:{reserveMs:15000},windowExpiresAt:Date.now()+1000});
 assert.equal(stopped.result.writtenFilms,0);assert.equal(stopped.result.bulk.stop,'budget');assert.ok(stopped.result.remaining>0);assert.equal(w.db.calls.batches,0);
 const wall=migrated();
 const wallStop=await writeWith(wall.db,clone(bigPlan.plan),{bulk:{reserveMs:2000,firstGroupMs:0},wallMs:1500});
 assert.equal(wallStop.result.bulk.stop,'budget');assert.equal(wallStop.result.writtenFilms,0);
 const room=migrated();
 const fits=await writeWith(room.db,clone(bigPlan.plan),{bulk:{reserveMs:0,firstGroupMs:0},windowExpiresAt:Date.now()+600000});
 assert.equal(fits.result.writtenFilms,7);assert.equal(fits.result.remaining,0);
 // near exhaustion: whatever the budget, the statements sent never pass it (a group is admitted for its whole cost: read batch, write batch and the replay of a refused group)
 for(const budget of [60,200,400,700,1200,2500]){
  const near=migrated();
  const bounded=await writeWith(near.db,clone(bigPlan.plan),{bulk:{groupSize:7,statementBudget:budget}});
  assert.ok(bounded.adapter.statements<=budget,'budget '+budget+' sent '+bounded.adapter.statements);
  assert.ok(bounded.result.errorCount===0&&danglingCredits(near.db)===0&&fkProblems(near.db)===0,'budget '+budget);
  if(bounded.result.remaining>0)assert.equal(bounded.result.bulk.stop,'budget','budget '+budget+': '+JSON.stringify(bounded.result.bulk));
 }
 const roomy=migrated();
 const whole=await writeWith(roomy.db,clone(bigPlan.plan),{bulk:{groupSize:7,statementBudget:100000}});
 assert.equal(whole.result.writtenFilms,7);assert.equal(whole.result.remaining,0);
 const cap=migrated();
 const capped=await writeWith(cap.db,clone(bigPlan.plan),{bulk:{groupSize:2,statementBudget:1}});
 assert.equal(capped.result.writtenFilms,0,'a spent statement budget starts no group');assert.ok(capped.result.remaining>0);assert.equal(cap.db.calls.batches,0);
}

// 11b. The statement budget is a hard cap on EVERY path: a read, a single write or a batch that would pass it is not sent (checked before submission, on the actual count).
{
 const budgets=[3,12,60,200,600,1600];
 const extras=plan=>{for(let index=0;index<30;index++){const base=plan.people[0];plan.people.push({...base,id:'person:actor/extra'+index,key:'extra'+index,person:{...base.person,id:'person:actor/extra'+index,roleId:'actor/extra'+index}});}};
 const redirect=plan=>{const entry=plan.films[3];entry.film.redirects=[{from:'film:old-one',to:entry.film.id,at:T}];};
 const housekeeping=plan=>{plan.absent=[{kind:'film',id:'film:gone1'},{kind:'film',id:'film:gone2'},{kind:'person',id:'person:actor/gone'}];};
 const scenarios=[
  ['a Film with a redirect (per entity inside the grouped run)',redirect,{groupSize:7}],
  ['every group too large: the per-entity fallback of Films and their Persons',null,{groupSize:7,maxStatements:12}],
  ['Person replay: Person groups too large',extras,{groupSize:2,personGroupSize:10,maxStatements:12}],
  ['housekeeping next to groups',housekeeping,{groupSize:3}],
  ['plain groups',null,{groupSize:3}],
 ];
 for(const [label,mutate,bulk] of scenarios){
  const base=migrated(),basePlan=clone(bigPlan.plan);if(mutate)mutate(basePlan);
  const baseline=await writeWith(base.db,basePlan,{bulk:{...bulk,statementBudget:100000}});
  assert.equal(baseline.result.remaining,0,label);
  let partial=0;
  for(const budget of budgets){
   const m=migrated(),plan=clone(bigPlan.plan);if(mutate)mutate(plan);
   const r=await writeWith(m.db,plan,{bulk:{...bulk,statementBudget:budget}});
   assert.ok(r.adapter.statements<=budget,label+': budget '+budget+' but '+r.adapter.statements+' statements were sent');
   assert.ok(r.result.errorCount<=baseline.result.errorCount,label+': a refused step is not an error ('+budget+')');
   assert.equal(danglingCredits(m.db),0,label);assert.equal(fkProblems(m.db),0,label);
   if(r.result.remaining>0){partial++;assert.ok(r.result.budgetStop===true||r.result.bulk?.stop==='budget'||budget<=5,label+': an unfinished run says why ('+budget+') '+JSON.stringify(r.result.bulk?.stop));}
  }
  assert.ok(partial>=2,label+': the cap actually bound the run for several budgets ('+partial+')');
 }
 // one statement of room: nothing of any kind is sent past it
 const one=migrated();
 const tight=await writeWith(one.db,clone(bigPlan.plan),{bulk:{groupSize:7,statementBudget:3}});
 assert.ok(tight.adapter.statements<=3);assert.equal(tight.result.writtenFilms,0);assert.ok(tight.result.remaining>0);
}

// 12. The fallback share: a path that refuses every group is switched off after the minimum number of groups; the rest is per-entity and the rows are the same.
// (The write creates its own repository first; each group then creates two: the trace pass and the collecting pass, the latter an odd call from 3 on.)
try{
 const a=migrated(),c=migrated();
 await writeWith(a.db,clone(bigPlan.plan));
 patch((repository,target,call)=>call>=3&&call%2===1?{...repository,projectFilm:async input=>{await target.get('SELECT 1 AS ok FROM film WHERE id=?',[input.film.id+'#unseen']);return repository.projectFilm(input);}}:repository);
 const {result}=await writeWith(c.db,clone(bigPlan.plan),{bulk:{groupSize:1,fallbackMinGroups:3}});
 unpatch();
 assert.equal(result.bulk.stop,'fallback_rate');assert.equal(result.bulk.groups,3,'a Person group (applied) and two refused Film groups');assert.equal(result.bulk.fallbackReasons.prefetch_miss,2);assert.equal(result.bulk.filmGroups,2);
 assert.equal(dump(c.db),dump(a.db));assert.equal(result.writtenFilms,7);
}finally{unpatch();}

// ---- the whole projector run ---------------------------------------------------------------------------------------------------------------
const phase=Array.from({length:6},(_,index)=>filmRecord(index+1,{shared:index%2===0}));

// 13. A lost lease, a marker that left the projector and a missing marker table, in a real run.
{
 const lost=migrated({onBatch:async statements=>{if(isWrite(statements)&&statements.length>20)lost.db.sql("UPDATE projection_run SET lease_id='someone-else'");}});
 const summary=await run(lost.db,sources(phase),'on');
 assert.equal(summary.outcome,'lease_lost');assert.equal(summary.leaseLost,true);assert.equal(count(lost.db,'film'),0);assert.equal(summary.bulk.stop,'lease_lost');

 const moved=migrated({onBatch:async statements=>{if(isWrite(statements)&&statements.length>20)moved.db.sql(dropTriggers+'UPDATE film_person_authority SET generation=generation+1');}});
 const deferred=await run(moved.db,sources(phase),'on');
 assert.deepEqual([deferred.outcome,deferred.reason,deferred.inputKey],['deferred','authority_moved','film_person_authority']);assert.equal(count(moved.db,'film'),0,'nothing is written through any path once the marker moved');
 assert.ok(deferred.remaining>0);

 const d1=migrated();d1.db.sql(dropTriggers+"UPDATE film_person_authority SET mode='d1',generation=1");
 const refused=await run(d1.db,sources(phase),'on');
 assert.deepEqual([refused.outcome,refused.reason],['deferred','authority_unavailable'],'at d1 the projector is not the writer: the run is planned under no marker and writes nothing');assert.equal(count(d1.db,'film'),0);assert.equal(d1.db.calls.batches,0);

 // an absent marker table is fail-closed with the flag on: zero writes, no batch of any kind, the diff is not even started
 const bare=migrated();bare.db.sql('DROP TABLE film_person_authority');
 const without=await run(bare.db,sources(phase),'on');
 assert.deepEqual([without.outcome,without.reason,without.inputKey],['deferred','authority_unavailable','film_person_authority']);
 assert.equal(count(bare.db,'film'),0);assert.equal(count(bare.db,'person'),0);assert.equal(count(bare.db,'projection_state'),0);assert.equal(bare.db.calls.batches,0);
 // with the flag off the same database is written as before (the marker is not the per-entity path's business)
 const legacy=await run(bare.db,sources(phase),'off');assert.equal(legacy.outcome,'complete');assert.equal(count(bare.db,'film'),6);

 // a marker that moves between the planning read and the prefetch fails closed with nothing written
 let first=0;
 const between=migrated({onBatch:async()=>{if(!first++)between.db.sql(dropTriggers+'UPDATE film_person_authority SET generation=generation+1');}});
 const pinned=await run(between.db,sources(phase),'on');
 assert.deepEqual([pinned.outcome,pinned.reason],['deferred','authority_moved'],JSON.stringify(pinned.bulk));assert.equal(count(between.db,'film'),0);assert.equal(count(between.db,'person'),0);
}

// 14. Idempotent: a second run over converged rows writes nothing, with the flag on or off; a run from the other flag value converges to the same rows.
{
 const {db}=migrated();
 const first=await run(db,sources(phase),'on');assert.equal(first.writtenFilms,6);
 const second=await run(db,sources(phase),'on');assert.equal(second.writtenFilms,0);assert.equal(second.writtenPeople,0);assert.equal(second.changedFilms,0);
 const third=await run(db,sources(phase),'off');assert.equal(third.writtenFilms,0);
 const mixed=migrated(),ref=migrated();
 await run(mixed.db,sources(phase.slice(0,3)),'off');await run(mixed.db,sources(phase),'on');await run(ref.db,sources(phase),'off');
 assert.equal(dump(mixed.db),dump(ref.db),'off then on equals one off run');
}

// 15. The source: the grouped path adds no second writer and no R2 write, reads no flag but its own, and the repository is unchanged.
{
 const source=fs.readFileSync('src/d1-enrichment.js','utf8');
 assert.doesNotMatch(source,/\bBUCKET\.(put|delete)\b/);
 assert.equal((source.match(/D1_ENRICHMENT_BULK\b/g)||[]).length>0,true);
 assert.match(source,/function d1EnrichmentBulkMode\(env\)\{return env\?\.D1_ENRICHMENT_BULK==='on'\?'on':'off';\}/);
 assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/D1_ENRICHMENT_BULK/,'no route or job reads the flag');
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/D1_ENRICHMENT_BULK/,'a deploy sets nothing');
}

console.log('projector-bulk: the grouped write path leaves the per-entity path\'s rows (new and pooled Persons, owner reviews, D1-only credits, sync clocks, a changed, removed and added Film), is two round trips a group, refuses the whole batch on an appearing redirect, owner review or trusted id, a marker move, a lost lease or window and writes nothing, falls back on an unseen or undigestable read, a planning error, a unique or foreign key conflict, the statement cap and an unknown batch outcome with the same final rows, converges across budgeted runs, stops before the window expiry, latches off past the fallback share and stays inert with the flag off');
