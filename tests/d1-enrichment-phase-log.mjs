// The diagnostic boundary line of the D1 enrichment projector (src/d1-enrichment.js): one `event: d1_enrichment_phase`, `stage: diff_complete_write_start`, logged
// after the diff is complete and immediately before the write starts, so that a run ended by the platform without a summary can be placed on one side of that boundary.
// Covered: exactly one line per run that reaches the write, logged before the first write batch and before the run's own summary line; the counts and timings it
// carries; none for a dry run or a run the guard refuses; the same line on the grouped path; no id, title or payload; and, by source, no await, clock read or query in
// the statement. A D1 stand-in over the sqlite3 CLI, a memory bucket for R2.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-d1-phase-log-'));
let databases=0;
const migrated=options=>{
 const db=d1Standin(path.join(root,'d1-'+(databases++)+'.sqlite'),options);
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
const isWrite=statements=>statements.some(item=>!/^\s*(SELECT|WITH)/i.test(item.sql));
// One run with its log lines and the position of the log at the first write batch.
async function observed({films=FILMS,mode='on',bulk=false,db=null,bucket=null,run={}}={}){
 const lines=[];let atFirstWrite=null;
 const database=db||migrated({onBatch:statements=>{if(atFirstWrite==null&&isWrite(statements))atFirstWrite=lines.length;}});
 // the one-row stand-in of the Film/Person marker that the grouped path reads and asserts (migration 0013)
 if(bulk&&!db)database.sql("CREATE TABLE film_person_authority (id INTEGER PRIMARY KEY, mode TEXT NOT NULL, cutover TEXT NOT NULL, generation INTEGER NOT NULL); INSERT INTO film_person_authority VALUES (1,'r2','open',0)");
 const projector=projectorContext({log:line=>lines.push(JSON.parse(line))});
 const env={DB:database,BUCKET:bucket||sources(films),D1_ENRICHMENT_WRITE:mode,...(bulk?{D1_ENRICHMENT_BULK:'on'}:{})};
 const summary=await projector.runD1EnrichmentProjection(env,{queryBudget:1e9,wallMs:1e12,...run});
 return {summary,lines,atFirstWrite,database,bucket:env.BUCKET};
}
const phases=lines=>lines.filter(line=>line.event==='d1_enrichment_phase');
const finals=lines=>lines.filter(line=>line.event==='d1_enrichment_projection');

// 1. A run that writes: exactly one boundary line, before the first write batch and before the run's own summary line.
{
 const {summary,lines,atFirstWrite}=await observed();
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(phases(lines).length,1,'exactly one boundary line per run');
 assert.equal(finals(lines).length,1);
 const at=lines.findIndex(line=>line.event==='d1_enrichment_phase');
 assert.ok(atFirstWrite!=null,'the run wrote');
 assert.ok(at<atFirstWrite,'the line is logged before the first write batch: '+JSON.stringify([at,atFirstWrite]));
 assert.ok(at<lines.findIndex(line=>line.event==='d1_enrichment_projection'),'and before the run\'s own summary line');
 const line=lines[at];
 assert.equal(line.stage,'diff_complete_write_start');
 assert.equal(line.projection,'enrichment');assert.equal(line.mode,'on');assert.equal(line.trigger,summary.trigger);assert.equal(line.startedAt,summary.startedAt);
 assert.deepEqual(Object.keys(line.timing).sort(),['diffMs','leaseMs','writeGateMs'],'no window in this run: no window time (it is dropped, not null)');
 assert.equal(line.timing.diffMs,summary.timing.diffMs);assert.equal(line.timing.writeGateMs,summary.timing.writeGateMs);assert.equal(line.timing.leaseMs,summary.timing.leaseMs);
 for(const key of ['films','people','stored','changedFilms','changedPeople'])assert.equal(line[key],summary[key],key);
 assert.equal(line.plan.films,summary.writtenFilms,'the plan holds what the run then wrote: '+JSON.stringify(line.plan));
 assert.equal(line.plan.people,summary.writtenPeople);
 assert.equal(line.plan.absent,0);
 assert.equal(line.bulk,false);assert.equal(line.bulkBudget,null);
 assert.ok(Number.isInteger(line.queries)&&line.queries>0&&line.queries<summary.queries,'the queries so far: fewer than the whole run '+JSON.stringify([line.queries,summary.queries]));
 // the run's own summary is unchanged by the line: no new key
 assert.equal(Object.keys(summary).some(key=>/phase_?log|boundary/i.test(key)),false);
}

// 2. The grouped path logs the same line, with the flag and the budget it will use.
{
 const {summary,lines,atFirstWrite}=await observed({bulk:true});
 assert.equal(summary.outcome,'complete',JSON.stringify(summary));
 assert.equal(phases(lines).length,1);
 const at=lines.findIndex(line=>line.event==='d1_enrichment_phase');
 assert.ok(at<atFirstWrite);
 const line=lines[at];
 assert.equal(line.bulk,true);
 assert.equal(JSON.stringify(line.bulkBudget),JSON.stringify(summary.bulkBudget),'the budget the write will use');
 assert.ok(line.bulkBudget&&Number.isFinite(line.bulkBudget.wallMs));
}

// 3. A second run with nothing to write still reaches the boundary: the plan is empty.
{
 const first=await observed();
 const again=await observed({db:first.database,bucket:first.bucket});
 assert.equal(phases(again.lines).length,1);
 assert.equal(JSON.stringify(phases(again.lines)[0].plan),JSON.stringify({films:0,people:0,sync:0,absent:0}));
 assert.equal(again.atFirstWrite,null,'nothing was written');
}

// 4. No line for a run that never reaches the write: a dry run, and a run whose input is missing.
{
 const dry=await observed({mode:'dry'});
 assert.equal(dry.summary.outcome,'dry');
 assert.equal(phases(dry.lines).length,0,'a dry run does not reach the write');
 assert.equal(finals(dry.lines).length,1);
 const bucket=sources(FILMS);await bucket.delete('metadata.json');
 const failed=await observed({bucket});
 assert.notEqual(failed.summary.outcome,'complete');
 assert.equal(phases(failed.lines).length,0,'a run that failed before the write logs no boundary: '+JSON.stringify(failed.summary.outcome));
}

// 5. No id, title or payload in the line; it stays small.
{
 const {lines}=await observed();
 const text=JSON.stringify(phases(lines)[0]);
 for(const secret of ['Secret Title','Director ','Actor ','film:','w0','actor/','director/','letterboxd.com'])assert.equal(text.includes(secret),false,'no '+secret+' in the line');
 assert.ok(text.length<900,'a small line: '+text.length);
}

// 6. By source: the statement reads no clock, sends no query and awaits nothing, and sits before the write call and after the budget it reports.
{
 const source=fs.readFileSync('src/d1-enrichment.js','utf8');
 const start=source.indexOf("console.log(JSON.stringify({event:'d1_enrichment_phase'");
 assert.ok(start>0,'the statement exists');
 const end=source.indexOf('}));',start)+4;
 const statement=source.slice(start,end);
 assert.equal(source.indexOf("event:'d1_enrichment_phase'",end),-1,'one statement');
 assert.doesNotMatch(statement,/await|Date\.|new Date|db\.(get|all|run|batch)|env\.|fetch\(/,'no clock read, query or await in the statement: '+statement);
 assert.ok(source.indexOf('summary.bulkBudget={',0)<start,'after the budget it reports');
 assert.ok(start<source.indexOf('written=await d1EnrichmentWrite(',start),'immediately before the write call');
 assert.ok(source.indexOf('written=await d1EnrichmentWrite(',start)-end<40,'nothing but the write call between them');
}

console.log('d1-enrichment-phase-log OK');
