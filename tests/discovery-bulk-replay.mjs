// AIR-523: the batched replay of the assigned rows of a NEW programme generation (ADR 0142 decision 5).
// Local sqlite stand-ins only. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-bulk-replay-'));
const chain=fs.readdirSync('migrations').filter(name=>/^00(0[1-9]|1[01])_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=()=>{
 const file=path.join(root,'a-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const OLD='run-old',NEW='run-new',MIN=60000,DAY=86400000,START=Date.parse('2026-11-17T12:00:00Z');
const slotsOf=(offset,...items)=>items.map(([channelId,hours,minutes])=>({channelId,channel:'Channel '+channelId,start:START+offset+hours*3600000,end:START+offset+hours*3600000+minutes*MIN}));
const obs=(key,shows,extra={})=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[90],shows,seenInLatestSnapshot:true,lastAiring:shows[0].start,...extra});
const verifiedFor=(item,filmId,tmdbId,extra={})=>({status:'verified',filmId,tmdbId,canonicalIdentity:'tmdb:'+tmdbId,identitySource:'tmdb_detail',anchor:[90],evidenceKey:Authority.evidenceKey(item),...extra});

// `members` are watchlist Films of the new run; `catalog` are `tmdb_<id>` Films with a current admission.
const hook={fn:null};
async function newRun(items,{members=[],catalog=[],latencyMs=0}={}){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const standin=d1Standin(file,{latencyMs,onQuery:async text=>{if(hook.fn)await hook.fn(text);}});
 const env={DB:standin,BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:NEW,handoff:true,lease:taken.lease,items:(async function*(){for(const item of items)yield item;})()});
 for(const run of [OLD,NEW])sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${run}','published','2026-11-1${run===OLD?6:7}T10:00:00Z','x','2026-11-17T10:00:00Z')`);
 members.forEach((member,index)=>sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${NEW}','programme',${index},'${member.id}')`));
 if(members.length)sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${NEW}','programme',0,'${JSON.stringify({runId:NEW,films:members.map(member=>({id:member.id,tmdbId:member.tmdbId,shows:[]}))})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${NEW}', generation=7`);
 for(const tmdb of catalog){
  const film={id:'tmdb_'+tmdb,tmdbId:tmdb,canonicalIdentity:'tmdb:'+tmdb,title:'Catalog '+tmdb,shows:[]};
  await Authority.upsertAdmissions(env,{['tmdb_'+tmdb]:film},{lease:taken.lease});
 }
 return {file,env,standin};
}
const rows=file=>sql(file,"SELECT film_id, channel_id, start_ms, end_ms, basis, match_reason FROM published_epg_show WHERE programme_run_id='"+NEW+"' ORDER BY start_ms, channel_id");
const published=file=>sql(file,'SELECT generation, watchlist_generation, programme_run_id FROM published_epg_authority')[0];
const discoveryGeneration=file=>Number(sql(file,'SELECT generation FROM discovery_authority')[0].generation);
const decide=async(env,item,next)=>assert.deepEqual((await Authority.writeDecisionDelta(env,{[item.key]:{previous:null,next}})).written,[item.key]);

// 1. Thousands-shaped regression, scaled: yesterday's run holds assigned rows at yesterday's slots; the new run has the SAME verified identities at NEW slots and no
// assigned row. One replay restores every eligible slot of the new run from the new observation rows, never copying an old timestamp, and does so in few round trips.
{
 const COUNT=120;
 const items=[];
 for(let n=0;n<COUNT;n++)items.push(obs('k'+String(n).padStart(3,'0'),slotsOf(DAY,['c'+n,1+(n%20),90],['d'+n,30+(n%20),92])));
 const {file,env,standin}=await newRun(items,{catalog:[...Array(COUNT).keys()].map(n=>String(1000+n))});
 for(let n=0;n<COUNT;n++)await decide(env,items[n],verifiedFor(items[n],'tmdb_'+(1000+n),String(1000+n)));
 // Yesterday's assigned rows of the same observations, at yesterday's coordinates, for the OLD run.
 for(let n=0;n<COUNT;n++)sql(file,`INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('${OLD}','tmdb_${1000+n}','c${n}',${START+(1+(n%20))*3600000},${START+(1+(n%20))*3600000+90*MIN},'Channel','',  'discovery','k${String(n).padStart(3,'0')}')`);
 const before=published(file),g0=discoveryGeneration(file),queries0=standin.calls.queries,batches0=standin.calls.batches;
 let result,passes=0,cursor='';
 do{result=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:cursor});cursor=result.after;passes++;assert.ok(passes<10,'the replay terminates');}while(!result.complete);
 const stored=rows(file);
 assert.equal(stored.length,COUNT*2,'every eligible slot of the new run is assigned');
 assert.equal(new Set(stored.map(row=>row.channel_id+':'+row.start_ms)).size,stored.length,'one Film per slot');
 for(const row of stored){assert.equal(row.basis,'discovery');assert.ok(row.start_ms>=START+DAY,'coordinates come from the new run, no old slot timestamp is copied');}
 assert.equal(sql(file,`SELECT COUNT(*) AS n FROM published_epg_show WHERE programme_run_id='${OLD}'`)[0].n,COUNT,"yesterday's rows are untouched");
 assert.deepEqual(published(file),before,'the published generation, watchlist generation and run do not move');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM published_epg_member")[0].n,0,'no member row is added');
 const roundTrips=(standin.calls.queries-queries0)+(standin.calls.batches-batches0);
 assert.ok(roundTrips<COUNT/2,`${COUNT} observations took ${roundTrips} round trips; the per-observation path needs about ten each`);
 assert.ok(discoveryGeneration(file)-g0<=result.pages*Math.ceil(Authority.REPLAY_PAGE*2/38),'one generation step per insert batch (at most three per page of forty observations), not per observation');
 // Idempotent: a second lap writes nothing, not even the generation.
 const g1=discoveryGeneration(file);
 const again=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:''});
 assert.equal(again.complete,true);assert.equal(again.outcomes.assigned,0);assert.equal(discoveryGeneration(file),g1);
 assert.equal(rows(file).length,COUNT*2);
}

// 2. Guards stay in force: a slot held by another Film, an ineligible duration, a Film with no record and a decision that is not verified assign nothing, and the circle still ends.
{
 const good=obs('a',slotsOf(DAY,['c',1,90]));
 const drift=obs('b',slotsOf(DAY,['c',2,150]));
 const absent=obs('c',slotsOf(DAY,['c',3,90]));
 const taken=obs('d',slotsOf(DAY,['c',4,90]));
 const unverified=obs('e',slotsOf(DAY,['c',5,90]));
 const {file,env}=await newRun([good,drift,absent,taken,unverified],{catalog:['11','12','14']});
 await decide(env,good,verifiedFor(good,'tmdb_11','11'));
 await decide(env,drift,verifiedFor(drift,'tmdb_12','12'));
 await decide(env,absent,verifiedFor(absent,'tmdb_13','13'));
 await decide(env,taken,verifiedFor(taken,'tmdb_14','14'));
 await decide(env,unverified,{status:'needs_verification',checkedAt:'2026-11-17T10:00:00Z'});
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${NEW}','programme',0,'member-x')`);
 sql(file,`INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('${NEW}','member-x','c',${START+DAY+4*3600000},${START+DAY+4*3600000+90*MIN},'Channel c','x','title_unique',NULL)`);
 const result=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:''});
 assert.equal(result.complete,true,'observations that can never be assigned do not keep the replay open');
 assert.equal(result.outcomes.assigned,1);assert.equal(result.outcomes.evidence_drift,1);assert.equal(result.outcomes.film_absent,1);
 assert.deepEqual(rows(file).filter(row=>row.basis==='discovery').map(row=>[row.film_id,row.match_reason]),[['tmdb_11','a']]);
 assert.equal(rows(file).find(row=>row.channel_id==='c'&&row.start_ms===START+DAY+4*3600000).film_id,'member-x','the slot of another Film is not taken');
}

// 3. A watchlist member takes its slots only when the sealed document of the run links it to the decision's TMDB id.
{
 const linked=obs('m',slotsOf(DAY,['c',1,90]));
 const wrong=obs('n',slotsOf(DAY,['c',2,90]));
 const {file,env}=await newRun([linked,wrong],{members:[{id:'member-1',tmdbId:'101'},{id:'member-2',tmdbId:'102'}]});
 await decide(env,linked,verifiedFor(linked,'member-1','101'));
 await decide(env,wrong,verifiedFor(wrong,'member-2','999'));
 const result=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:''});
 assert.equal(result.outcomes.assigned,1);assert.equal(result.outcomes.film_absent,1);
 assert.deepEqual(rows(file).map(row=>row.film_id),['member-1']);
}

// 4. Bounded and resumable: a stop signal ends the call with its cursor, the next call continues from it and finishes; a wrong or old run is a no-op.
{
 const N=Authority.REPLAY_PAGE*2+20,items=[];for(let n=0;n<N;n++)items.push(obs('r'+String(n).padStart(3,'0'),slotsOf(DAY,['c'+n,1+(n%20),90])));
 const {file,env}=await newRun(items,{catalog:[...Array(N).keys()].map(n=>String(2000+n))});
 for(let n=0;n<N;n++)await decide(env,items[n],verifiedFor(items[n],'tmdb_'+(2000+n),String(2000+n)));
 // Stop checks come at the head of a page, before its counts and before every write group. A stop between the first and second group keeps what was written and does not advance the cursor: the rows already inserted are no longer selected.
 const midPage=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:'',shouldStop:(()=>{let calls=0;return()=>calls++>=3;})()});
 assert.equal(midPage.complete,false);assert.equal(midPage.after,'');assert.equal(midPage.outcomes.assigned,38);assert.equal(rows(file).length,38);
 // A stop between pages ends with the cursor of the last finished page.
 const first=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:'',shouldStop:(()=>{let calls=0;return()=>calls++>=Math.ceil(Authority.REPLAY_PAGE/38)+2;})()});
 assert.equal(first.complete,false);
 assert.equal(first.after,'r'+String(38+Authority.REPLAY_PAGE-1).padStart(3,'0'),'the cursor is the last key of the last finished page (the first 38 are already assigned)');
 assert.equal(rows(file).length,38+first.outcomes.assigned);
 let cursor=first.after,done=false,guard=0;
 while(!done&&guard++<10){const next=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:cursor});cursor=next.after;done=next.complete;}
 assert.equal(done,true);assert.equal(rows(file).length,N);
 const stale=await Authority.replayUnassignedSlots(env,{programmeRunId:OLD,after:''});
 assert.equal(stale.stale,true);assert.equal(stale.outcomes.assigned,0);
}

// 5. A lost lease is a fence failure, not a silent skip.
{
 const item=obs('z',slotsOf(DAY,['c',1,90]));
 const {env}=await newRun([item],{catalog:['31']});
 await decide(env,item,verifiedFor(item,'tmdb_31','31'));
 await assert.rejects(()=>Authority.replayUnassignedSlots({...env,discoveryLease:null},{programmeRunId:NEW}),error=>error?.code==='discovery_lease'||/lease/i.test(String(error?.message)));
}

// 6. Review of AIR-523: the absence probes use the existing (programme_run_id, start_ms) index, on a run that already holds thousands of assigned shows.
const inline=(text,params)=>{let index=0;return text.replace(/\?/g,()=>{const value=params[index++];return typeof value==='number'?String(value):"'"+String(value).replace(/'/g,"''")+"'";});};
const plan=(file,text,params)=>{const result=sqliteSync(['-bail',file],{input:'EXPLAIN QUERY PLAN '+inline(text,params)+';',encoding:'utf8'});if(result.status!==0)throw new Error(result.stderr);return result.stdout;};
const SLOT_INDEX=/SEARCH p USING (COVERING )?INDEX published_epg_show_by_generation \(programme_run_id=\? AND start_ms=\?\)/;
{
 const DENSE=6000,COUNT=60;
 const items=[];for(let n=0;n<COUNT;n++)items.push(obs('d'+String(n).padStart(3,'0'),slotsOf(DAY,['k'+n,1+(n%20),90])));
 const {file,env,standin}=await newRun(items,{catalog:[...Array(COUNT).keys()].map(n=>String(3000+n))});
 for(let n=0;n<COUNT;n++)await decide(env,items[n],verifiedFor(items[n],'tmdb_'+(3000+n),String(3000+n)));
 // A populated run: thousands of rows of other Films, none on the slots of the observations above except the first five (a slot held by another Film stays held).
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${NEW}','programme',0,'member-x')`);
 sql(file,`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<${DENSE-1}) INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) SELECT '${NEW}','member-x','z'||i,${START+DAY}+i*60000,${START+DAY}+i*60000+5400000,'Channel','x','title_unique',NULL FROM n`);
 for(let n=0;n<5;n++)sql(file,`INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('${NEW}','member-x','k${n}',${START+DAY+(1+(n%20))*3600000},${START+DAY+(1+(n%20))*3600000+90*MIN},'Channel','x','title_unique',NULL)`);
 // The plan, not a clock: the probe is a (programme_run_id, start_ms) index search in all three statements.
 assert.match(plan(file,Authority.REPLAY_SELECT_SQL,[NEW,'',NEW,40]),SLOT_INDEX,'the selection probe');
 assert.match(plan(file,Authority.replaySlotsSql(2),['a','b',NEW]),SLOT_INDEX,'the free-slot probe');
 const insertPlan=plan(file,Authority.SLOT_INSERT_SQL,[NEW,'f','a',NEW,'a','c',1,2,NEW,'a','1','h','f',NEW,'f','f','1','f','1',NEW,'c',1]);
 assert.match(insertPlan,/INDEX published_epg_show_by_generation \(programme_run_id=\? AND start_ms=\?\)/,'the guarded insert probe');
 assert.doesNotMatch(insertPlan,/SEARCH published_epg_show USING (COVERING )?INDEX sqlite_autoindex_published_epg_show_1 \(programme_run_id=\?\)\s*$/m,'the guard is not a scan of the whole run');
 const before=published(file);
 let result,laps=0,cursor='';
 do{result=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:cursor});cursor=result.after;assert.ok(++laps<10);}while(!result.complete);
 const assigned=rows(file).filter(row=>row.basis==='discovery');
 assert.equal(assigned.length,COUNT-5,'the five observations whose slot another Film holds are not assigned, all others are');
 assert.equal(rows(file).filter(row=>row.film_id==='member-x').length,DENSE+5,"the other Film's rows are untouched");
 assert.equal(new Set(rows(file).map(row=>row.channel_id+':'+row.start_ms)).size,rows(file).length,'one Film per slot');
 assert.deepEqual(published(file),before);
 const again=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:''});
 assert.equal(again.outcomes.assigned,0);assert.equal(again.complete,true);
}

// 7. Review of AIR-523: the replay deadline is checked before every write group, the first included. Reads that use the slice up leave no batch started and the cursor where the page began.
for(const [label,pattern] of [['after the free-slot read',/FROM discovery_observation_show s WHERE s\.source_key='active' AND s\.observation_key IN/],['at the count before the first write',/SELECT COUNT\(\*\) AS n FROM published_epg_show/]]){
 const items=[];for(let n=0;n<10;n++)items.push(obs('e'+n,slotsOf(DAY,['c'+n,1+n,90])));
 const {file,env,standin}=await newRun(items,{catalog:[...Array(10).keys()].map(n=>String(4000+n))});
 for(let n=0;n<10;n++)await decide(env,items[n],verifiedFor(items[n],'tmdb_'+(4000+n),String(4000+n)));
 let expired=false;
 hook.fn=text=>{if(pattern.test(text))expired=true;};
 const batches=standin.calls.batches,generation=discoveryGeneration(file);
 const stopped=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:'',shouldStop:()=>expired});
 hook.fn=null;
 assert.equal(standin.calls.batches,batches,'no write batch starts once the slice is used up '+label);
 assert.equal(rows(file).length,0);assert.equal(discoveryGeneration(file),generation);
 assert.equal(stopped.complete,false);assert.equal(stopped.after,'','the cursor stays where the page began');
 const resumed=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:stopped.after});
 assert.equal(resumed.complete,true);assert.equal(rows(file).length,10,'the next call, with time, restores the page');
}

// 8. A lap ends at the end of the key space. Observations that can never be assigned (here: evidence drift) are scanned once per lap, never twice: a
// lap resumed after a stop continues to the end and completes, without wrapping back over the keys the lap already visited.
{
 const N=Authority.REPLAY_PAGE*2+20,items=[];for(let n=0;n<N;n++)items.push(obs('p'+String(n).padStart(3,'0'),slotsOf(DAY,['c'+n,1+(n%20),150])));
 const {file,env}=await newRun(items,{catalog:[...Array(N).keys()].map(n=>String(5000+n))});
 for(let n=0;n<N;n++)await decide(env,items[n],verifiedFor(items[n],'tmdb_'+(5000+n),String(5000+n)));
 let calls=0;
 const first=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:'',shouldStop:()=>calls++>=1});
 assert.equal(first.complete,false);assert.equal(first.observations,Authority.REPLAY_PAGE);assert.equal(first.outcomes.evidence_drift,Authority.REPLAY_PAGE);
 assert.equal(first.after,'p'+String(Authority.REPLAY_PAGE-1).padStart(3,'0'));
 const rest=await Authority.replayUnassignedSlots(env,{programmeRunId:NEW,after:first.after});
 assert.equal(rest.complete,true,'the end of the key space ends the lap');
 assert.equal(rest.observations,N-Authority.REPLAY_PAGE,'no wrap back over the keys this lap already scanned');
 assert.equal(rest.after,'');assert.equal(rows(file).length,0);
}
console.log('discovery-bulk-replay ok');
