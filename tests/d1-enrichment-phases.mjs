// AIR-392: the additive phase timing of one D1 enrichment projector run (src/d1-enrichment.js, ADR 0056/0103). The run summary gains `timing` (the run in
// order: lease, window, diff, write gate, write, release), `phases` (a sequential partition of the diff, so its entries add up with an explicit residual)
// and `detail` (the overlapping R2 and discovery reads). Covered: the shape and the closed set of names; additivity on a deterministic clock; that the
// timing changes NOTHING a run does (two clocks with different steps leave the same rows, keys, queries and lanes); the failed, dry, nothing-to-write and
// budget paths; no payload, id or key in the measurements; the old fields stay. A D1 stand-in over the sqlite3 CLI, a memory bucket for R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-phases-'));
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
const listed=(index,actors)=>film('w'+index,'Secret Title '+index,String(100+index),[person('director/d'+index,'Director '+index)],Array.from({length:actors},(_,k)=>person('actor/a'+index+'_'+k,'Actor '+index+'_'+k)));
function sources(films){
 const bucket=new MemoryBucket();const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('watchlist.json',{updatedAt:T,films});put('metadata.json',Object.fromEntries(films.map(item=>[item.id,meta(item)])));
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-1'});
 put('epg/generations/run-1/programme.json',{updatedAt:T,films:films.map(item=>({...item,shows:[]}))});
 put('epg/generations/run-1/discovered-films.json',{});
 return bucket;
}
const FILMS=Array.from({length:6},(_,index)=>listed(index,3));
// A deterministic clock: every Date.now() call advances by `step` ms; `new Date(x)` is the real one.
function clockedProjector(step,control=null){
 let now=1_800_000_000_000;
 class FakeDate extends Date{static now(){now+=step;return now;}}
 if(control)control.advance=ms=>{now+=ms;};
 return projectorContext({log:()=>{},globals:{Date:FakeDate}});
}
const run=(projector,db,bucket,options={})=>projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:options.mode||'on'},{queryBudget:1e9,wallMs:1e12,...options.run});
const dump=db=>JSON.stringify({films:db.sql('SELECT id FROM film ORDER BY id'),people:db.sql('SELECT id FROM person ORDER BY id'),credits:db.sql('SELECT film_id,person_id,role,ordinal FROM film_person_credit ORDER BY film_id,role,ordinal'),state:db.sql('SELECT kind,id,change_key FROM projection_state ORDER BY kind,id')});
const NAME=/^(store|diff|read)\.[A-Za-z]+$/;
const sum=(group)=>Object.values(group).reduce((total,item)=>total+item.ms,0);
const entryOk=item=>Object.keys(item).sort().join()==='ms,n,q,rows'&&Object.values(item).every(value=>Number.isInteger(value)&&value>=0);

// 1. Shape: timing in order, phases a partition of the diff, detail the overlapping reads; the old fields stay.
{
 const projector=clockedProjector(5),db=migrated(),bucket=sources(FILMS);
 const summary=await run(projector,db,bucket);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 for(const key of ['loadMs','viewMs','durationMs','queries','films','people','changedFilms','changedPeople','writtenFilms','writtenPeople'])assert.ok(Number.isFinite(summary[key]),'the old field stays: '+key);
 const timing=summary.timing;
 for(const key of ['leaseMs','diffMs','diffResidualMs','writeGateMs','writeMs','preTxnMs','preWriteMs','firstBatchPlanMs','firstBatchStatements','leaseReleaseMs','runMs'])assert.ok(Number.isInteger(timing[key])&&timing[key]>=0,key+' '+JSON.stringify(timing));
 assert.equal(timing.preWriteMs,timing.preTxnMs+timing.firstBatchPlanMs,'the first batch is the first transaction entered plus its planning');
 assert.equal(timing.windowMs,undefined,'no window: no window time');assert.equal(timing.windowReleaseMs,undefined);
 assert.ok(timing.leaseMs+timing.diffMs+timing.writeGateMs+timing.writeMs<=timing.runMs,'the run in order adds up: '+JSON.stringify(timing));
 assert.ok(timing.preWriteMs<=timing.leaseMs+timing.diffMs+timing.writeGateMs+timing.writeMs,'the first batch is inside the run');
 for(const group of [summary.phases,summary.detail])for(const [name,item] of Object.entries(group)){assert.match(name,NAME,name);assert.ok(entryOk(item),name+' '+JSON.stringify(item));}
 for(const name of ['store.writersIdle','store.publishedSnapshot','store.handoffGuard','store.readBlock','store.etagRecheck','store.build','diff.schemaContract','diff.lifecycle','diff.inputs','diff.storedRead','diff.plan','diff.membersRead'])assert.ok(summary.phases[name],'phase '+name);
 for(const name of ['read.metadata','read.catalog','read.resolution','read.people','read.verifiedFilms'])assert.ok(summary.detail[name],'detail '+name);
 assert.equal(summary.phases['diff.storedRead'].rows,0,'the first run found no checkpoint rows');
 assert.equal(summary.phases['diff.storedRead'].q,1,'one D1 query for the checkpoint read');
 assert.equal(summary.phases['diff.storedRead'].n,1);
 // additivity: the sequential phases never exceed the diff, the residual is the time no phase covers
 const covered=sum(summary.phases);
 assert.equal(covered+timing.diffResidualMs,timing.diffMs,'diffMs = the sum of phases + the named residual: '+JSON.stringify([covered,timing.diffResidualMs,timing.diffMs]));
 assert.ok(timing.diffResidualMs<=40*5,'the residual stays small on a 5 ms clock (only untimed glue): '+timing.diffResidualMs);
 // a second run reads the checkpoints it wrote
 const again=await run(projector,db,bucket);
 assert.equal(again.phases['diff.storedRead'].rows,FILMS.length+summary.writtenPeople,'rows read = checkpoints written');
 assert.equal(again.timing.preWriteMs,undefined,'nothing to write: no first batch, no pre-write time');
 assert.equal(again.timing.preTxnMs,undefined);assert.equal(again.timing.firstBatchPlanMs,undefined);
 assert.ok(Number.isInteger(again.timing.writeMs));
}

// 2. The timing changes nothing a run does: two clocks with different steps leave the same rows, keys, queries and lanes.
{
 const results=[];
 for(const step of [1,977]){
  const projector=clockedProjector(step),db=migrated(),bucket=sources(FILMS);
  const summary=await run(projector,db,bucket);
  results.push({dump:dump(db),outcome:summary.outcome,queries:summary.queries,lanes:summary.laneQueries,written:[summary.writtenFilms,summary.writtenPeople,summary.errorCount,summary.remaining]});
 }
 assert.equal(JSON.stringify(results[0]),JSON.stringify(results[1]),'the clock changes nothing a run writes, counts or schedules');
 // and a tight budget behaves the same under both clocks too (the wall budget uses the real run clock, not the measurements)
 const tight=[];
 for(const step of [1,3]){
  const projector=clockedProjector(step),db=migrated(),bucket=sources(FILMS);
  const summary=await run(projector,db,bucket,{run:{queryBudget:60,wallMs:1e12}});
  tight.push([summary.outcome,summary.writtenFilms,summary.writtenPeople,summary.remaining,summary.queries,dump(db)]);
 }
 assert.equal(JSON.stringify(tight[0]),JSON.stringify(tight[1]));assert.equal(tight[0][0],'budget');
 const budgeted=await run(clockedProjector(1),migrated(),sources(FILMS),{run:{queryBudget:60}});
 assert.ok(Number.isInteger(budgeted.timing.preWriteMs)&&Number.isInteger(budgeted.timing.writeMs),'a budget run still reports both: '+JSON.stringify(budgeted.timing));
}

// 3. The failed path: an input that is missing fails the run before any write, the completed phases are still reported, no write times exist.
{
 const projector=clockedProjector(5),db=migrated(),bucket=sources(FILMS);
 await bucket.delete('metadata.json');
 const summary=await run(projector,db,bucket);
 assert.equal([summary.outcome,summary.reason].join(),'failed,input_missing');
 assert.ok(summary.phases['store.writersIdle']&&summary.phases['store.readBlock'],'phases up to the failure');
 assert.ok(Number.isInteger(summary.timing.diffMs));
 assert.equal(sum(summary.phases)+summary.timing.diffResidualMs,summary.timing.diffMs,'the accounting holds when the diff fails');
 assert.equal(summary.timing.writeMs,undefined);assert.equal(summary.timing.preWriteMs,undefined);assert.equal(summary.timing.writeGateMs,undefined);
 assert.equal(db.sql('SELECT COUNT(*) AS n FROM film')[0].n,0);
}

// 4. A dry run reports the diff and nothing else, and writes nothing; off and a held lease report nothing new.
{
 const projector=clockedProjector(5),db=migrated(),bucket=sources(FILMS);
 const summary=await run(projector,db,bucket,{mode:'dry'});
 assert.equal(summary.outcome,'dry');assert.ok(Number.isInteger(summary.timing.diffMs));assert.equal(sum(summary.phases)+summary.timing.diffResidualMs,summary.timing.diffMs,'the accounting holds in a dry run');assert.equal(summary.timing.writeMs,undefined);
 assert.equal(db.sql('SELECT COUNT(*) AS n FROM film')[0].n,0);
 const off=await projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket},{});
 assert.equal(JSON.stringify(off),JSON.stringify({mode:'off',skipped:'off'}));
}

// 6. preWriteMs is the first batch SUBMITTED to D1, not the first transaction entered: the repository's own planning (its reads and the statement
// assembly) before binding.batch counts, and a batch that fails keeps its attempt.
{
 const control={},projector=clockedProjector(1,control),db=migrated(),bucket=sources(FILMS);
 const real=projector.CanonicalRepository.createCanonicalRepository;
 projector.CanonicalRepository.createCanonicalRepository=target=>{
  const repository=real(target);
  return {...repository,projectPerson:async input=>{control.advance(5000);return repository.projectPerson(input);},projectFilm:async input=>{control.advance(5000);return repository.projectFilm(input);}};
 };
 const summary=await run(projector,db,bucket);
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.ok(summary.timing.firstBatchPlanMs>=5000,'a 5 s planning delay before the first submission is in the measurement: '+JSON.stringify(summary.timing));
 assert.equal(summary.timing.preWriteMs,summary.timing.preTxnMs+summary.timing.firstBatchPlanMs);
 assert.ok(summary.timing.firstBatchStatements>=3,'the first batch carries the fence, the rows and the key');
 // the first attempt is kept when that batch fails (the run goes on or stops by its existing rules)
 const failing=clockedProjector(5),db2=migrated(),bucket2=sources(FILMS);
 let thrown=false;
 const binding={prepare:(...args)=>db2.prepare(...args),batch:async statements=>{if(!thrown){thrown=true;throw new Error('D1 unavailable');}return db2.batch(statements);}};
 const failed=await failing.runD1EnrichmentProjection({DB:binding,BUCKET:bucket2,D1_ENRICHMENT_WRITE:'on'},{queryBudget:1e9,wallMs:1e12});
 assert.ok(thrown,'the first submitted batch failed (the run retries a failed Person group one by one, as before)');
 assert.ok(Number.isInteger(failed.timing.preWriteMs),'the attempt is kept when the batch fails: '+JSON.stringify(failed.timing));
 assert.ok(failed.timing.firstBatchStatements>=3);
}

// 5. No payload, id, key, SQL or parameter in the measurements: a closed set of names, numbers only.
{
 const projector=clockedProjector(5),db=migrated(),bucket=sources(FILMS);
 const summary=await run(projector,db,bucket);
 const measured=JSON.stringify({timing:summary.timing,phases:summary.phases,detail:summary.detail});
 for(const word of ['Secret Title','film:','person:','actor/','director/','SELECT','INSERT','.json','run-1'])assert.ok(!measured.includes(word),'not in the measurements: '+word);
 for(const value of Object.values(summary.timing))assert.ok(Number.isInteger(value));
 assert.ok(measured.length<3000,'the added log and summary size stays small: '+measured.length);
 assert.ok(fs.readFileSync('src/d1-enrichment.js','utf8').split('\n').every(line=>!/timer\.(time|sync)\(['"][^'"]*\$\{/.test(line)),'phase names are literals, never built from data');
}
console.log('D1 enrichment phase timing (AIR-392): timing in run order, a sequential phase partition of the diff with a residual and overlapping reads as detail, the same rows, keys, queries and lanes under clocks of different steps, failed, dry, nothing-to-write and budget paths, a closed set of names with numbers only, and the old fields kept');
