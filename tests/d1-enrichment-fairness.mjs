// AIR-388: the D1 enrichment projector must give every lane a real share of a run's budget. In production (2026-11-09) seven hourly runs
// with a granted window and no error wrote 2,950 Persons and no Film, because the queue was "all changed Persons, then all changed Films"
// and the Person backlog was refilled faster than it drained. A D1 stand-in applies the real migrations in the sqlite3 CLI; R2 is a memory
// bucket. Covered: with a Person backlog far larger than a run, every run still writes Films, Persons and, when there is any, housekeeping;
// Films a verified archive admitted and D1 never projected go first and the priority ends by itself; a Film's own Persons are written
// before it (the credit rows reference person rows) without waiting for the whole Person backlog; a run with almost no budget left after
// its load still writes a Film first; backlogs that grow every run still progress on both sides; the runs converge to exactly what one
// unconstrained run writes, with no duplicate write; sync and absent are not held back by the backlogs; the budget, wall time and
// window are not raised.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const source=fs.readFileSync('src/d1-enrichment.js','utf8');
assert.match(source,/const D1_ENRICHMENT_QUERY_BUDGET=800;/,'the query budget is not raised');
assert.match(source,/const D1_ENRICHMENT_WALL_MS=60000;/,'the wall time is not raised');
assert.match(source,/const D1_ENRICHMENT_PERSON_BATCH=25;/);
assert.doesNotMatch(source,/BUCKET\.(put|delete)\b/,'the projector never writes R2');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-fairness-'));
let databases=0;
const migrated=()=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state'])db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8').replace(/;\s*$/,''));
 return db;
};
const T='2026-10-28T10:00:00.000Z';
const person=(id,name)=>({id,name,original:name});
const film=(id,title,tmdbId,directors,actors)=>({id,title,original:title,year:1995,tmdbId,url:'https://letterboxd.com/film/'+id+'/',directors,actors});
const meta=record=>({...record,metadataAt:T,peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:T,runtime:120});
const ARCHIVE='a'.repeat(64);
// A watchlist Film with one director and `actors` actors of its own (so the Person backlog is larger than the Film backlog).
const listed=(index,actors)=>film('w'+index,'Film '+index,String(100+index),[person('director/d'+index,'Director '+index)],Array.from({length:actors},(_,k)=>person('actor/a'+index+'_'+k,'Actor '+index+'_'+k)));
const admission=index=>({tmdb:String(9000+index),sourceCode:'Ab'+index,archiveSha256:ARCHIVE,title:'Admitted '+index,year:2001,filmPath:null,verifiedAt:T,identity:'inferred',directors:[person('tmdb_director/'+index,'Admitted Director '+index)],actors:[person('tmdb_actor/'+index,'Admitted Actor '+index)]});
function sources({films,admitted=0}){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 if(admitted)put('letterboxd/admissions/verified-films.json',{schemaVersion:1,films:Object.fromEntries(Array.from({length:admitted},(_,index)=>['tmdb_'+(9000+index),admission(index)]))});
 return bucket;
}
const projector=projectorContext({log:()=>{}});
const run=(db,bucket,options={})=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'on'},options);
const dry=(db,bucket)=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'dry'});
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const dump=db=>JSON.stringify({films:db.sql('SELECT id FROM film ORDER BY id'),people:db.sql('SELECT id FROM person ORDER BY id'),credits:db.sql('SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY film_id,role,ordinal'),state:db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id')});
const admittedProjected=db=>one(db,"SELECT COUNT(*) FROM projection_state WHERE kind='film' AND id LIKE '%tmdb_90%'");
const listedProjected=db=>one(db,"SELECT COUNT(*) FROM projection_state WHERE kind='film' AND id LIKE '%w%' AND id NOT LIKE '%tmdb_90%'");
const dangling=db=>one(db,'SELECT COUNT(*) FROM film_person_credit c LEFT JOIN person p ON p.id=c.person_id WHERE p.id IS NULL');

const FILMS=Array.from({length:30},(_,index)=>listed(index,7));   // 30 Films, 240 Persons: the Person backlog is 8 times the Film backlog
const ADMITTED=12;

// The reference: one unconstrained run writes everything, 42 Films, and the Persons they need.
let reference;
{
 const db=migrated(),bucket=sources({films:FILMS,admitted:ADMITTED});
 const plan=await dry(db,bucket);
 assert.deepEqual([plan.changedFilms,plan.changedPeople,plan.admittedFirst],[42,240+2*ADMITTED,ADMITTED],'the dry plan names the admitted Films first');
 const full=await run(db,bucket,{queryBudget:1e6,wallMs:6e5});
 assert.equal(full.outcome,'complete',JSON.stringify(full));
 assert.deepEqual([full.writtenFilms,full.writtenPeople,full.errorCount],[42,264,0]);
 assert.equal(dangling(db),0);
 reference={dump:dump(db),films:42,people:264,loadQueries:plan.queries};
 // An unconstrained run leaves nothing to do, and a second one writes nothing: idempotent.
 const again=await run(db,bucket,{queryBudget:1e6,wallMs:6e5});
 assert.deepEqual([again.outcome,again.writtenFilms,again.writtenPeople,again.changedFilms,again.changedPeople],['complete',0,0,0,0]);
}

// 1. Tight budgets: the Person backlog (264) is far larger than one run can write, and still every run writes Films AND Persons. Admitted Films
// are the first Films projected, then the others; nothing is lost and the runs converge to the reference. No Film is ever written
// without its Persons (dangling credits would be a foreign key failure and an error).
{
 const db=migrated(),bucket=sources({films:FILMS,admitted:ADMITTED});
 const budget=reference.loadQueries+70;
 const ticks=[];let guard=0,last;
 do{
  last=await run(db,bucket,{queryBudget:budget,wallMs:6e5});
  ticks.push({outcome:last.outcome,films:last.writtenFilms,people:last.writtenPeople,forFilms:last.peopleForFilms,errors:last.errorCount,admittedFirst:last.admittedFirst,lanes:last.laneQueries,admitted:admittedProjected(db),listed:listedProjected(db)});
  assert.equal(dangling(db),0,'a Film is never written before its Persons');
 }while(last.outcome==='budget'&&++guard<80);
 assert.equal(last.outcome,'complete',JSON.stringify(ticks.slice(-3)));
 assert.ok(ticks.length>=4,'the budget really was tight: '+ticks.length+' runs');
 for(const tick of ticks.slice(0,-1)){
  assert.equal(tick.outcome,'budget');
  assert.ok(tick.films>0,'every run writes a Film: '+JSON.stringify(tick));
  assert.ok(tick.people>0,'every run writes Persons: '+JSON.stringify(tick));
  assert.equal(tick.errors,0);
  assert.ok(tick.lanes.film>0&&tick.lanes.people>=0&&tick.lanes.housekeeping>=0,JSON.stringify(tick.lanes));
 }
 // The first run writes admitted Films only; the other Films wait until the admitted ones are all projected.
 assert.ok(ticks[0].admitted>0&&ticks[0].listed===0,'the first run projects admitted Films first: '+JSON.stringify(ticks[0]));
 const firstWithListed=ticks.findIndex(tick=>tick.listed>0);
 assert.ok(firstWithListed>0,'other Films start only later');
 assert.equal(ticks[firstWithListed-1].admitted>0,true);
 assert.equal(ticks.at(-1).admitted,ADMITTED);
 // The priority ends by itself: once the admitted Films are projected none is "new" any more.
 const after=await run(db,sources({films:FILMS,admitted:ADMITTED}),{queryBudget:1e6});
 assert.equal(after.admittedFirst,0);
 assert.equal(dump(db),reference.dump,'the tight runs converge to exactly what one unconstrained run writes');
 // No duplicate write: the Films were written once each over the whole sequence.
 assert.equal(ticks.reduce((sum,tick)=>sum+tick.films,0),reference.films);
 assert.equal(ticks.reduce((sum,tick)=>sum+tick.people,0),reference.people);
}

// 2. A run whose load left almost no budget: whatever it writes first belongs to the first Film (its own Persons), never to the Person backlog,
// and the Film itself is written by the next run, without a long wait: every run still makes progress.
{
 let found=null;
 for(let extra=0;extra<40&&!found;extra++){
  const probe=migrated(),probeBucket=sources({films:FILMS,admitted:ADMITTED});
  const summary=await run(probe,probeBucket,{queryBudget:reference.loadQueries+extra,wallMs:6e5});
  if(summary.writtenFilms+summary.writtenPeople>0)found={extra,summary,db:probe,bucket:probeBucket};
 }
 assert.ok(found,'some small budget writes something');
 assert.equal(found.summary.writtenPeople,found.summary.peopleForFilms,'only the first Film\'s own Persons were written, none of the backlog: '+JSON.stringify([found.summary.writtenFilms,found.summary.writtenPeople,found.summary.peopleForFilms]));
 assert.ok(found.summary.writtenPeople>0);
 // The same tiny budget again: the Film whose Persons are checkpointed is written within a few runs, and no run is empty.
 let ticks=0,filmSeen=found.summary.writtenFilms>0;
 while(!filmSeen&&ticks++<4){
  const next=await run(found.db,found.bucket,{queryBudget:reference.loadQueries+found.extra,wallMs:6e5});
  assert.ok(next.writtenFilms+next.writtenPeople>0,'a starved run still makes progress');
  filmSeen=next.writtenFilms>0;
 }
 assert.ok(filmSeen,'the first Film is written within a few starved runs');
 assert.equal(dangling(found.db),0);
}

// 3. Both backlogs keep growing: every run adds a new watchlist Film with 8 new Persons (the Person backlog is refilled), and the runs
// stay tight. Both Films and Persons progress in every run, so neither backlog is held back by the other.
{
 const db=migrated();
 let films=[...FILMS],bucket=sources({films,admitted:ADMITTED});
 const budget=reference.loadQueries+70;
 const written=[];
 for(let tick=0;tick<8;tick++){
  films=[...films,listed(100+tick,7)];bucket=sources({films,admitted:ADMITTED});
  const summary=await run(db,bucket,{queryBudget:budget,wallMs:6e5});
  assert.equal(summary.outcome,'budget',JSON.stringify([tick,summary.outcome]));
  assert.ok(summary.writtenFilms>0&&summary.writtenPeople>0,'tick '+tick+': '+JSON.stringify([summary.writtenFilms,summary.writtenPeople]));
  assert.equal(summary.errorCount,0);assert.equal(dangling(db),0);
  written.push([summary.writtenFilms,summary.writtenPeople]);
 }
 assert.ok(written.every(([f,p])=>f>0&&p>0));
}

// 4. Housekeeping is not held back: a Film that no source lists any more is released in a run that is also writing Films and Persons,
// while both backlogs are still large.
{
 const db=migrated();
 const first=await run(db,sources({films:FILMS,admitted:ADMITTED}),{queryBudget:1e6,wallMs:6e5});
 assert.equal(first.outcome,'complete');
 const kept=FILMS.slice(2);   // two watchlist Films leave every source
 const more=Array.from({length:20},(_,index)=>listed(200+index,7));   // and a new backlog arrives
 const bucket=sources({films:[...kept,...more],admitted:ADMITTED});
 const plan=await dry(db,bucket);
 assert.equal(plan.absent,18,'the two Films and their 16 own Persons are absent now');
 const summary=await run(db,bucket,{queryBudget:reference.loadQueries+90,wallMs:6e5});
 assert.equal(summary.outcome,'budget');
 assert.ok(summary.released>0,'housekeeping progressed while the backlogs were large: '+JSON.stringify([summary.released,summary.writtenFilms,summary.writtenPeople]));
 assert.ok(summary.writtenFilms>0&&summary.writtenPeople>0);
 // With more runs everything converges, nothing is released twice and the sync clocks are not lost.
 let guard=0,last;
 do{last=await run(db,bucket,{queryBudget:reference.loadQueries+90,wallMs:6e5});}while(last.outcome==='budget'&&++guard<80);
 assert.equal(last.outcome,'complete');
 const released=await run(db,bucket,{queryBudget:1e6});
 assert.deepEqual([released.outcome,released.released,released.writtenFilms,released.writtenPeople],['complete',0,0,0]);
}

// 6. A Film with more than 25 prerequisite Persons (three groups) and a budget that runs out in the middle: no Film batch starts after the
// budget is spent, the Persons already written stay checkpointed, the Film stays pending, and the next runs complete it without duplicates.
{
 const wide=[listed(500,60)];   // one director and 60 actors: 61 Persons, groups of 25, 25 and 11
 const bucket=sources({films:wide});
 const refDb=migrated();
 const refPlan=await dry(refDb,bucket);
 assert.deepEqual([refPlan.changedFilms,refPlan.changedPeople],[1,61]);
 const full=await run(refDb,bucket,{queryBudget:1e6,wallMs:6e5});
 assert.deepEqual([full.outcome,full.writtenFilms,full.writtenPeople,full.errorCount],['complete',1,61,0]);
 const expected=dump(refDb);
 let exhausted=null;
 for(let extra=1;extra<200&&!exhausted;extra++){
  const db=migrated(),before=db.calls.batches;
  const summary=await run(db,bucket,{queryBudget:refPlan.queries+extra,wallMs:6e5});
  if(summary.outcome==='budget'&&summary.writtenFilms===0&&summary.writtenPeople>0)exhausted={extra,summary,db,batches:db.calls.batches-before};
 }
 assert.ok(exhausted,'a budget that runs out after some prerequisite Persons exists');
 const {summary,db}=exhausted;
 assert.equal(summary.writtenFilms,0,'no Film after the budget is spent');
 assert.equal(exhausted.batches,Math.ceil(summary.writtenPeople/25),'only Person batches were sent: no Film transaction started');
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM projection_state WHERE kind='film'"),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM projection_state WHERE kind='person'"),summary.writtenPeople,'the Persons written stay checkpointed');
 assert.ok(summary.remaining>=1+(61-summary.writtenPeople),'the Film and the Persons not written count as remaining: '+summary.remaining);
 assert.equal(summary.errorCount,0,'a Film not attempted for lack of budget is not an error');
 // The next runs finish the Film and its Persons, and the result is exactly the unconstrained one.
 let guard=0,last;
 do{last=await run(db,bucket,{queryBudget:refPlan.queries+exhausted.extra,wallMs:6e5});assert.equal(dangling(db),0);}while(last.outcome==='budget'&&++guard<20);
 assert.equal(last.outcome,'complete');
 assert.equal(dump(db),expected,'the same rows as one unconstrained run, no duplicate');
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),1);
 assert.equal(one(db,'SELECT COUNT(*) FROM person'),61);
 assert.equal(one(db,'SELECT COUNT(*) FROM film_person_credit'),61);
}

// 5. Error paths are those of before: a Film that cannot be written is an error, counted, and the run goes on; the lost lease still stops
// the run at once. (The fenced batches themselves are covered by d1-enrichment.mjs.)
{
 const db=migrated(),bucket=sources({films:FILMS.slice(0,4),admitted:2});
 const summary=await run(db,bucket,{queryBudget:1e6,wallMs:6e5});
 assert.equal(summary.errorCount,0);
 assert.equal(typeof summary.laneQueries.film,'number');
 assert.equal(typeof summary.peopleForFilms,'number');
}

console.log('D1 enrichment fairness (AIR-388): with a Person backlog of 264 and a budget that fits a fraction of it every run writes Films and Persons, admitted Films first and the priority ends by itself, a Film\'s own Persons come before it, a starved run writes only the first Film\'s own Persons and the Film follows, a Film that runs out of budget in the middle of its Persons is not started and is completed next run, growing backlogs both progress, housekeeping is not held back, and the runs converge to exactly what one unconstrained run writes with no duplicate.');
