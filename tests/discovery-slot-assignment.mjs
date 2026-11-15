// AIR-480 stage 2 (ADR 0142 decisions 4 and 5): the conditional per-slot insert and the atomic removal with the decision.
// Local sqlite stand-ins only. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import {slotEligibility,decisionAnchor,evidenceKeyDurations,anchorTolerance,slotMinutes} from '../src/domain/slot-evidence.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-slot-assign-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'a-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-assign',MIN=60000,START=Date.parse('2026-11-15T12:00:00Z');

// The pure rule first (decisions 5 and 6): tolerance, anchor, legacy recovery, owner and scan-confirmed rules.
assert.equal(anchorTolerance(90),5);assert.equal(anchorTolerance(120),6);assert.equal(anchorTolerance(180),9);assert.equal(anchorTolerance(250),10);
assert.equal(slotMinutes(0,90*MIN),90);assert.equal(slotMinutes(0,0),null);
assert.deepEqual(evidenceKeyDurations('film a|2001|90|c:1,c:2'),[90]);
assert.deepEqual(evidenceKeyDurations('film a|2001|90,180|c:1'),[90,180]);
assert.deepEqual(evidenceKeyDurations('a|b film|2001|90|c:1'),[90],'only the title part may contain a separator');
assert.deepEqual(decisionAnchor({status:'verified',identitySource:'tmdb_detail',evidenceKey:'film a|2001|90|c:1'}),[90],'an earlier decision with one recorded duration keeps it');
assert.deepEqual(decisionAnchor({status:'verified',identitySource:'known_epg_alias',evidenceKey:'film a|2001|90|c:1'}),[],'a known_epg_alias decision never infers an anchor');
assert.deepEqual(decisionAnchor({status:'verified',identitySource:'tmdb_detail',evidenceKey:'film a|2001|90,180|c:1'}),[],'two recorded durations give no anchor');
assert.deepEqual(decisionAnchor({status:'verified',anchor:[96,90,90],evidenceKey:'film a|2001|90,180|c:1'}),[90,96],'a recorded anchor wins and is normalized');
const slot=minutes=>({start:0,end:minutes*MIN});
const verified=extra=>({status:'verified',tmdbId:'101',filmId:'f1',identitySource:'tmdb_detail',anchor:[90],...extra});
assert.equal(slotEligibility(verified(),slot(95)).eligible,true,'90 + 5');
assert.equal(slotEligibility(verified(),slot(96)).eligible,false,'90 + 6');
assert.equal(slotEligibility(verified(),slot(85)).eligible,true);assert.equal(slotEligibility(verified(),slot(84)).eligible,false);
assert.equal(slotEligibility(verified({anchor:[]}),slot(90)).eligible,false,'an empty anchor and no other rule: nothing is eligible');
assert.equal(slotEligibility(verified({anchor:[],identitySource:'owner'}),slot(240)).rule,'owner');
assert.equal(slotEligibility(verified({anchor:[]}),slot(240),'101').rule,'scan_confirmed');
assert.equal(slotEligibility(verified({anchor:[]}),slot(240),'999').eligible,false,'a scan-confirmed other id does not help');
assert.equal(slotEligibility({status:'needs_verification'},slot(90)).eligible,false);
assert.equal(slotEligibility(verified({anchor:[90,96]}),slot(101)).eligible,true,'every anchored duration has its own tolerance, no chaining past it');
assert.equal(slotEligibility(verified({anchor:[90,96]}),slot(107)).eligible,false);

const shows=(...items)=>items.map(([channelId,hours,minutes])=>({channelId,channel:'Channel '+channelId,start:START+hours*3600000,end:START+hours*3600000+minutes*MIN}));
const obs=(key,extra={})=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[90],shows:shows(['c',1,90]),seenInLatestSnapshot:true,lastAiring:START+3600000,...extra});

async function setup(items,{member=true,sealedTmdb='101'}={}){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){for(const item of items)yield item;})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 if(member)sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
 if(member)sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:sealedTmdb,shows:[]}]})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 return {file,env};
}
const rows=file=>sql(file,"SELECT film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason FROM published_epg_show ORDER BY start_ms, channel_id");
const published=file=>sql(file,'SELECT generation, watchlist_generation, programme_run_id FROM published_epg_authority')[0];
const discoveryGeneration=file=>Number(sql(file,'SELECT generation FROM discovery_authority')[0].generation);
const verifiedDecision=(item,extra={})=>({status:'verified',filmId:'member-1',tmdbId:'101',canonicalIdentity:'tmdb:101',identitySource:'tmdb_detail',anchor:[90],evidenceKey:Authority.evidenceKey(item),...extra});
const write=async(env,item,next,previous=null)=>Authority.writeDecisionDelta(env,{[item.key]:{previous,next}});

// 1. A member Film takes only its eligible slots, with no coordinate from the writer; the published generation does not move; replay inserts nothing.
{
 const item=obs('a',{shows:shows(['c',1,90],['d',2,95],['c',3,96],['e',4,240])});
 const {file,env}=await setup([item]);
 const before=published(file);
 assert.deepEqual((await write(env,item,verifiedDecision(item))).written,['a']);
 const g0=discoveryGeneration(file);
 const first=await Authority.assignObservationSlots(env,{observationKey:'a'});
 assert.equal(first.outcomes.assigned,2,'90 and 95 minutes are inside the tolerance of 90, 96 and 240 are not');
 assert.equal(first.outcomes.evidence_drift,2);
 assert.deepEqual(first.skipped.map(item=>item.reason),['evidence_drift','evidence_drift']);
 const stored=rows(file);
 assert.equal(stored.length,2);
 assert.deepEqual(stored.map(row=>[row.film_id,row.channel_id,row.start_ms,row.end_ms,row.channel,row.epg_title,row.basis,row.match_reason]),[
  ['member-1','c',START+3600000,START+3600000+90*MIN,'Channel c',null,'discovery','a'],
  ['member-1','d',START+7200000,START+7200000+95*MIN,'Channel d',null,'discovery','a'],
 ]);
 assert.deepEqual(published(file),before,'the published generation, watchlist generation and run do not move');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM published_epg_member")[0].n,1,'no member row is added');
 assert.equal(discoveryGeneration(file),g0+1,'the batch moves the Discovery generation once');
 const again=await Authority.assignObservationSlots(env,{observationKey:'a'});
 assert.equal(again.outcomes.assigned,0);assert.equal(again.outcomes.present,2);
 assert.equal(discoveryGeneration(file),g0+1,'a replay writes nothing, not even the generation');
 assert.equal(rows(file).length,2);
}

// 2. An earlier decision keeps an anchor only with one recorded duration; with two it assigns nothing until the owner or a revalidation.
{
 const single=obs('s',{durations:[90],shows:shows(['c',1,92])});
 const multi=obs('m',{durations:[90,180],shows:shows(['c',2,90],['d',3,180])});
 const {file,env}=await setup([single,multi]);
 const legacy=item=>({status:'verified',filmId:'member-1',tmdbId:'101',canonicalIdentity:'tmdb:101',identitySource:'tmdb_detail',evidenceKey:Authority.evidenceKey(item)});
 await write(env,single,legacy(single));await write(env,multi,legacy(multi));
 assert.equal((await Authority.assignObservationSlots(env,{observationKey:'s'})).outcomes.assigned,1,'one recorded duration is the anchor');
 const none=await Authority.assignObservationSlots(env,{observationKey:'m'});
 assert.equal(none.outcomes.assigned,0);assert.equal(none.outcomes.evidence_drift,2,'no anchor: every slot is drift');
 // The owner's confirmation needs no anchor.
 await write(env,multi,{...legacy(multi),identitySource:'owner',ownerReviewed:true},legacy(multi));
 const owner=await Authority.assignObservationSlots(env,{observationKey:'m'});
 assert.equal(owner.outcomes.assigned,2);
}

// 3. A slot that another Film holds is never overwritten, and the same slot of a second observation is refused.
{
 const item=obs('t',{shows:shows(['c',1,90],['d',2,90])});
 const {file,env}=await setup([item]);
 sql(file,`INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('${RUN}','sealed-film','c',${START+3600000},${START+3600000+90*MIN},'Channel c','Sealed title','title_year',NULL)`);
 await write(env,item,verifiedDecision(item));
 const result=await Authority.assignObservationSlots(env,{observationKey:'t'});
 assert.equal(result.outcomes.assigned,1);assert.equal(result.outcomes.slot_taken,1);
 const sealed=rows(file).find(row=>row.film_id==='sealed-film');
 assert.equal(sealed.epg_title,'Sealed title');assert.equal(sealed.basis,'title_year','the sealed row is untouched');
 assert.equal(rows(file).length,2);
}

// 4. The Film must have a record in the run: a member, or the catalog id with a current admission.
{
 const item=obs('u');
 const {file,env}=await setup([item],{member:false});
 await write(env,item,verifiedDecision(item,{filmId:'tmdb_101'}));
 const absent=await Authority.assignObservationSlots(env,{observationKey:'u'});
 assert.equal(absent.outcomes.film_absent,1);assert.equal(rows(file).length,0);
 await Authority.upsertAdmissions(env,{tmdb_101:{id:'tmdb_101',tmdbId:'101',canonicalIdentity:'tmdb:101',title:'Catalog Film'}},{lease:env.discoveryLease});
 const catalog=await Authority.assignObservationSlots(env,{observationKey:'u'});
 assert.equal(catalog.outcomes.assigned,1);
 assert.deepEqual(rows(file).map(row=>row.film_id),['tmdb_101']);
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM published_epg_member")[0].n,0,'a catalog Film does not join the watchlist');
}

// 5. A decision that leaves `verified` or changes its Film removes its rows in the same batch; a rewrite of the same identity keeps them.
{
 const item=obs('v',{shows:shows(['c',1,90],['d',2,92])});
 const other=obs('w',{shows:shows(['e',5,90])});
 const {file,env}=await setup([item,other]);
 const decision=verifiedDecision(item);
 await write(env,item,decision);await write(env,other,verifiedDecision(other));
 await Authority.assignObservationSlots(env,{observationKey:'v'});await Authority.assignObservationSlots(env,{observationKey:'w'});
 assert.equal(rows(file).length,3);
 const wider=verifiedDecision(item,{anchor:[90,96]});
 await write(env,item,wider,decision);
 assert.equal(rows(file).filter(row=>row.match_reason==='v').length,2,'the same identity with a wider anchor keeps its rows');
 await write(env,item,{status:'no_confident_match',attempts:1,evidenceKey:decision.evidenceKey},wider);
 assert.equal(rows(file).filter(row=>row.match_reason==='v').length,0,'a decision that leaves verified removes its rows with it');
 assert.equal(rows(file).filter(row=>row.match_reason==='w').length,1,'another observation keeps its row');
 const g=discoveryGeneration(file);
 await write(env,item,verifiedDecision(item,{filmId:'member-2',tmdbId:'102'}),{status:'no_confident_match',attempts:1,evidenceKey:decision.evidenceKey});
 const stale=await Authority.assignObservationSlots(env,{observationKey:'v'});
 assert.equal(stale.outcomes.film_absent,2,'the new Film has no record in the run');
 assert.ok(discoveryGeneration(file)>g);
}

// 6. A replaced run or a changed decision refuses the insert; the statement itself repeats the guards.
{
 const item=obs('x');
 const {file,env}=await setup([item]);
 await write(env,item,verifiedDecision(item));
 sql(file,"UPDATE published_epg_authority SET programme_run_id='run-next'");
 const stale=await Authority.assignObservationSlots(env,{observationKey:'x'});
 assert.equal(stale.reason,'stale_run');assert.equal(rows(file).length,0);
 sql(file,`UPDATE published_epg_authority SET programme_run_id='${RUN}'`);
 const explicit=await Authority.assignObservationSlots(env,{observationKey:'x',programmeRunId:'run-old'});
 assert.equal(explicit.reason,'stale_run','a caller that names another run is refused');
 const missing=await Authority.assignObservationSlots(env,{observationKey:'nope'});
 assert.equal(missing.reason,'decision_changed');
 // The statement alone, with a decision hash that is no longer the stored one, writes nothing.
 const db=d1Standin(file);
 const tampered=await db.prepare("INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) SELECT ?, ?, s.channel_id, s.start_ms, s.end_ms, s.channel, NULL, 'discovery', ? FROM discovery_observation o JOIN discovery_observation_show s ON s.source_key=o.source_key AND s.observation_key=o.observation_key WHERE o.source_key='active' AND o.observation_key=? AND EXISTS (SELECT 1 FROM discovery_decision WHERE observation_key=? AND decision_hash=?)").bind(RUN,'member-1','x','x','x','deadbeef').run();
 assert.equal(rows(file).length,0,'a stale hash writes no row');
 void tampered;
}

// 7. Discovery assigns while the sealed generation is unchanged, so a new EPG publication starts without Discovery rows.
{
 const item=obs('y');
 const {file,env}=await setup([item]);
 await write(env,item,verifiedDecision(item));
 await Authority.assignObservationSlots(env,{observationKey:'y'});
 assert.equal(rows(file).length,1);
 sql(file,"DELETE FROM published_epg_show WHERE programme_run_id='"+RUN+"'");
 sql(file,"UPDATE published_epg_authority SET programme_run_id='run-next', generation=8");
 assert.equal((await Authority.assignObservationSlots(env,{observationKey:'y'})).reason,'stale_run','the next run is not touched by the old assignment');
 assert.equal(rows(file).length,0);
}

// 8. Review fixes: removal is scoped to the published run, follows the TMDB identity, and a member must carry the decision's TMDB id in the sealed document.
{
 const item=obs('h',{shows:shows(['c',1,90])});
 const {file,env}=await setup([item]);
 const decision=verifiedDecision(item);
 await write(env,item,decision);
 await Authority.assignObservationSlots(env,{observationKey:'h'});
 sql(file,"INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('run-old','published','2026-11-01T10:00:00Z','x','2026-11-01T10:00:00Z')");
 sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-old','member-1','c',1,2,'C',NULL,'discovery','h')");
 const rejected={status:'rejected',attempts:1,evidenceKey:decision.evidenceKey};
 await write(env,item,rejected,decision);
 assert.equal(rows(file).filter(row=>row.match_reason==='h').length,1,'only the published run loses its rows; a historical run keeps its own');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM published_epg_show WHERE programme_run_id='run-old'")[0].n,1);
}
{
 const item=obs('t');
 const {file,env}=await setup([item]);
 const decision=verifiedDecision(item);
 await write(env,item,decision);
 await Authority.assignObservationSlots(env,{observationKey:'t'});
 assert.equal(rows(file).length,1);
 await write(env,item,verifiedDecision(item,{tmdbId:'102',canonicalIdentity:'tmdb:102'}),decision);
 assert.equal(rows(file).length,0,'a TMDB identity change with the same Film id removes the rows');
 const again=verifiedDecision(item,{tmdbId:'102',canonicalIdentity:'tmdb:102'});
 await Authority.assignObservationSlots(env,{observationKey:'t'});
 assert.equal(rows(file).length,0,'member-1 carries TMDB 101 in the sealed document, so the 102 decision is refused');
 void again;
}
{
 const item=obs('m');
 const {file,env}=await setup([item],{sealedTmdb:'555'});
 await write(env,item,verifiedDecision(item));
 const result=await Authority.assignObservationSlots(env,{observationKey:'m'});
 assert.equal(result.reason,'film_absent');
 assert.equal(rows(file).length,0,'a member whose sealed TMDB id differs from the decision gets no row');
}
{
 const item=obs('k');
 const {file,env}=await setup([item]);
 const alias=verifiedDecision(item,{identitySource:'known_epg_alias'});
 delete alias.anchor;
 await write(env,item,alias);
 const result=await Authority.assignObservationSlots(env,{observationKey:'k'});
 assert.equal(result.outcomes.evidence_drift,1,'a known_epg_alias decision does not infer an anchor from its evidence key');
 assert.equal(rows(file).length,0);
}

// Example 17: a skipped decision write never reaches the insert.
{
 const item=obs('cas');
 const {file,env}=await setup([item]);
 const first=verifiedDecision(item);
 await write(env,item,first);
 const skipped=await write(env,item,verifiedDecision(item,{attempts:2}),{status:'needs_verification',attempts:1,evidenceKey:first.evidenceKey});
 assert.deepEqual(skipped.skipped,[{key:'cas',reason:'conflict'}]);
 assert.equal(rows(file).length,0);
}

// Example 18: the decision lands, the process stops, the next assign completes the rows.
{
 const item=obs('crash');
 const {file,env}=await setup([item]);
 await write(env,item,verifiedDecision(item));
 assert.equal(rows(file).length,0,'the decision write does not insert');
 const again=await Authority.assignObservationSlots(env,{observationKey:'crash'});
 assert.equal(again.outcomes.assigned,1);
 assert.equal(rows(file).length,1);
}

// Example 20: an inactive observation, and a slot whose end_ms changed after the writer evaluated it.
{
 const item=obs('dead');
 const {file,env}=await setup([item]);
 await write(env,item,verifiedDecision(item));
 sql(file,"UPDATE discovery_observation SET seen_in_latest=0 WHERE observation_key='dead'");
 const inactive=await Authority.assignObservationSlots(env,{observationKey:'dead'});
 assert.equal(inactive.reason,'observation_inactive');
 assert.equal(rows(file).length,0);
}
{
 const item=obs('moved');
 const {file,env}=await setup([item]);
 await write(env,item,verifiedDecision(item));
 env.DB=d1Standin(file,{onBatch:async(statements)=>{
  if(statements.some(item=>item.text.includes('INSERT INTO published_epg_show'))){
   sqliteSync(['-bail',file],{input:"PRAGMA foreign_keys=ON;\nUPDATE discovery_observation_show SET end_ms=end_ms+60000 WHERE observation_key='moved';",encoding:'utf8'});
  }
 }});
 const result=await Authority.assignObservationSlots(env,{observationKey:'moved'});
 assert.equal(result.outcomes.slot_absent,1);
 assert.equal(result.outcomes.assigned,0);
 assert.equal(rows(file).length,0);
}

console.log('discovery slot assignment ok');
