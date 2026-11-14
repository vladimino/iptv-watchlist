// AIR-480 stage 3 (ADR 0142 decision 6, owner decisions R1 and R4): bounded revalidation of drifted durations inside the paged Discovery chunk.
// The pure plan first, then the real chunk against a sqlite stand-in with a recording TMDB stub. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {revalidationPlan,revalidatedDecision,REVALIDATION_LIMIT} from '../src/domain/slot-evidence.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const verified=extra=>({status:'verified',filmId:'member-1',tmdbId:'101',identitySource:'tmdb_detail',anchor:[90],evidenceKey:'film r|2001|90|c:1',...extra});
assert.equal(REVALIDATION_LIMIT,12);
assert.deepEqual(revalidationPlan(verified(),[96,90,96]).todo,[96],'the anchor duration is not drifted work; one attempt per distinct duration');
assert.deepEqual(revalidationPlan(verified({failedDurations:[96]}),[96,99]).todo,[99],'a failed duration gets no further call');
assert.equal(revalidationPlan(verified({identitySource:'owner'}),[96]).eligible,false,'an owner decision is never revalidated');
assert.equal(revalidationPlan({status:'no_confident_match'},[96]).eligible,false);
const eleven=[100,101,102,103,104,105,106,107,108,109,110];
const full=revalidationPlan(verified({failedDurations:[...eleven,111]}),[150]);
assert.equal(full.exhausted,true);assert.deepEqual(full.todo,[],'twelve failed durations end automatic revalidation for good');
assert.deepEqual(revalidationPlan({status:'verified',tmdbId:'1',filmId:'f',identitySource:'known_epg_alias'},[90]).todo,[90],'a decision without an anchor is revalidated per duration');
const rewritten=revalidatedDecision(verified({identitySource:'known_epg_alias',anchor:undefined,evidenceKey:'film r|2001|90|c:1'}),{reconfirmed:[96],failed:[120],proposedTmdbId:'555'},{evidenceKey:'film r|2001|90,96|c:2',checkedAt:'2026-11-15T00:00:00.000Z',provenance:{authority:'tmdb_detail'}});
assert.equal(rewritten.tmdbId,'101');assert.equal(rewritten.filmId,'member-1');assert.equal(rewritten.status,'verified');
assert.deepEqual(rewritten.anchor,[96],'an anchorless decision gains only the reconfirmed duration');
assert.deepEqual(rewritten.failedDurations,[120]);
assert.equal(rewritten.proposedTmdbId,undefined,'a reconfirmation drops a stale proposal');
const kept=revalidatedDecision(verified({evidenceKey:'film r|2001|90|c:1'}),{failed:[96],proposedTmdbId:'555'},{evidenceKey:'film r|2001|90,96|c:2',checkedAt:'x'});
assert.deepEqual(kept.anchor,[90]);assert.equal(kept.identitySource,'tmdb_detail');assert.equal(kept.proposedTmdbId,'555');assert.deepEqual(kept.failedDurations,[96]);
const legacy=revalidatedDecision({status:'verified',tmdbId:'104',filmId:'tmdb_104',identitySource:'tmdb_detail',evidenceKey:'film m|2001|90|c:1'},{failed:[180]},{evidenceKey:'film m|2001|90,180|c:2',checkedAt:'x'});
assert.deepEqual(legacy.anchor,[90],'the first write stores the anchor read from the old one-duration key');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-revalidation-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'r-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-reval',MIN=60000,START=Date.now()+3600000;

async function world({durations,decision,movieRuntime=96,failFetch=false,fillers=0}){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const setup={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(setup,{programmeRunId:null});
 setup.discoveryLease=taken.lease;
 const item={key:'film r|2001',title:'Film R',normalizedTitle:'film r',year:2001,durations:[...durations],duration:durations[0],shows:durations.map((minutes,index)=>({channelId:'c'+index,channel:'C'+index,start:START+index*4*3600000,end:START+index*4*3600000+minutes*MIN})),seenInLatestSnapshot:true,lastAiring:START};
 await Authority.ingestLedger(setup,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield item;for(let index=0;index<fillers;index++)yield {key:'filler '+index+'|2005',title:'Filler '+index,normalizedTitle:'filler '+index,year:2005,durations:[100],duration:100,shows:[{channelId:'f',channel:'F',start:START+index*1000,end:START+index*1000+100*MIN}],seenInLatestSnapshot:true,lastAiring:START+index*1000+1};})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
 sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:'101',shows:[]}]})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const stored={...decision,evidenceKey:sql(file,"SELECT evidence_key FROM discovery_observation WHERE observation_key='film r|2001'")[0].evidence_key};
 const wrote=await Authority.writeDecisionDelta(setup,{[item.key]:{previous:null,next:stored}},{lease:taken.lease});
 assert.deepEqual(wrote.written,[item.key],JSON.stringify(wrote));
 await Authority.releaseLease(setup,taken.lease);
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const fetched=[];
 const movie={id:101,title:'Film R',original_title:'Film R',release_date:'2001-05-01',runtime:movieRuntime,genres:[],credits:{crew:[],cast:[]},translations:{translations:[]},alternative_titles:{titles:[]}};
 const context=vm.createContext({console,Date,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url);fetched.push(parsed.pathname);if(failFetch.value)return Promise.resolve(new Response('{}',{status:429,headers:{'Retry-After':'30'}}));return Promise.resolve(new Response(JSON.stringify(parsed.pathname.includes('/movie/')?movie:{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:Authority,pinEpg:async value=>value,refreshPredictionQueue:async()=>{},
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const name of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const report={films:[{id:'member-1',tmdbId:'101',title:'Film R',original:'Film R',year:2001,runtime:90,canonicalIdentity:'tmdb:101',shows:[]}]};
 const chunk=async()=>{
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  try{
   sql(file,"DELETE FROM discovery_status");
   return await context.resolveDiscoveryChunk(env,report,24,lease.lease);
  }finally{await Authority.releaseLease(env,lease.lease);}
 };
 return {file,env,chunk,fetched,item};
}
const decisionOf=file=>JSON.parse(sql(file,"SELECT payload_json FROM discovery_decision WHERE observation_key='film r|2001'")[0].payload_json);
const rowsOf=file=>sql(file,"SELECT channel_id, start_ms, end_ms, basis FROM published_epg_show ORDER BY start_ms");
const movieCalls=fetched=>fetched.filter(pathname=>pathname.includes('/movie/')).length;

// A. Reconfirmed: anchor 90, slot of 96 in drift; the gates accept the same TMDB id for 96 alone. The anchor becomes 90 and 96, the row is inserted, the identity is untouched.
{
 const {file,chunk,fetched}=await world({durations:[90,96],decision:verified({anchor:[90]})});
 const first=await chunk();
 assert.equal(first.revalidation.revalidated,1,JSON.stringify(first.revalidation)+JSON.stringify(first.assignment));
 assert.equal(first.revalidation.revalidation_failed,0);
 const decision=decisionOf(file);
 assert.deepEqual(decision.anchor,[90,96]);assert.equal(decision.tmdbId,'101');assert.equal(decision.filmId,'member-1');assert.equal(decision.status,'verified');
 assert.deepEqual(decision.failedDurations,[]);
 assert.equal(rowsOf(file).length,2,'both slots are rows: the 90 minutes by the anchor, the 96 minutes after the reconfirmation');
 assert.equal(movieCalls(fetched),1,'one TMDB detail call for the observation');
 const again=await chunk();
 assert.equal(movieCalls(fetched),1,'a duration in the anchor gets no further call');
 assert.equal(again.revalidation.revalidated,0);
}

// B. Not reconfirmed: the detail runtime is far from 96, so the gate refuses. The identity stays; the duration is recorded as failed and never tried again.
{
 const {file,chunk,fetched}=await world({durations:[90,96],decision:verified({anchor:[90]}),movieRuntime:150});
 const first=await chunk();
 assert.equal(first.revalidation.revalidation_failed,1,JSON.stringify(first.revalidation));
 const decision=decisionOf(file);
 assert.deepEqual(decision.anchor,[90]);assert.deepEqual(decision.failedDurations,[96]);assert.equal(decision.tmdbId,'101');assert.equal(decision.status,'verified');
 assert.equal(rowsOf(file).length,1,'the 96-minute slot stays a broadcast; the row of the 90-minute slot stays');
 assert.equal(first.assignment.evidence_drift>=1,true);
 const calls=movieCalls(fetched);
 await chunk();
 assert.equal(movieCalls(fetched),calls,'a failed duration gets no second TMDB call');
}

// C. A TMDB failure completes no evaluation: nothing is recorded and the decision stays byte-identical.
{
 const flag={value:true};
 const {file,chunk}=await world({durations:[90,96],decision:verified({anchor:[90]}),failFetch:flag});
 const before=JSON.stringify(decisionOf(file));
 const result=await chunk();
 assert.equal(result.revalidation.revalidation_failed,0);assert.equal(result.revalidation.revalidated,0);
 assert.equal(JSON.stringify(decisionOf(file)),before);
 flag.value=false;
}

// D. An owner decision is never revalidated, whatever the durations.
{
 const {file,chunk,fetched}=await world({durations:[90,200],decision:verified({identitySource:'owner',anchor:undefined,ownerIdentity:{tmdbId:'101'}})});
 const result=await chunk();
 assert.equal(result.revalidation.observations,0);assert.equal(movieCalls(fetched),0);
 assert.equal(rowsOf(file).length,2,'the owner rule assigns every slot');
 void file;
}

// E. Twelve failed durations: automatic revalidation stops for good; the anchor still assigns what it covers.
{
 const failed=[100,101,102,103,104,105,106,107,108,109,110,111];
 const {file,chunk,fetched}=await world({durations:[90,97,150],decision:verified({anchor:[90,97],failedDurations:failed})});
 const result=await chunk();
 assert.equal(result.revalidation.revalidation_exhausted,1,JSON.stringify(result.revalidation));
 assert.equal(movieCalls(fetched),0,'no TMDB call for an exhausted observation');
 assert.equal(rowsOf(file).length,2,'the anchored slots keep their rows');
 assert.deepEqual(decisionOf(file).failedDurations,failed);
}

// F. Candidates without a decision come first: when they use the 16 calls of the chunk, the drifted observation gets no call and records nothing.
{
 const {file,chunk,fetched}=await world({durations:[90,96],decision:verified({anchor:[90]}),fillers:12});
 const before=JSON.stringify(decisionOf(file));
 const result=await chunk();
 assert.equal(result.tmdbCalls,16,'the candidates took every call');
 assert.equal(movieCalls(fetched),0);
 assert.equal(JSON.stringify(decisionOf(file)),before,'nothing recorded');
 assert.equal(result.revalidation.revalidated+result.revalidation.revalidation_failed,0);
}

console.log('discovery revalidation ok');
