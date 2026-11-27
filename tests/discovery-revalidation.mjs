// AIR-480 stage 3 (ADR 0142 decision 6, owner decisions R1 and R4): bounded revalidation of drifted durations inside the paged Discovery chunk.
// The pure plan first, then the real chunk against a sqlite stand-in with a recording TMDB stub. Nothing here calls Cloudflare, TMDB or production D1.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as EnrichmentDiscovery from '../src/catalog-enrichment-discovery.js';
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
// A controllable clock for the chunk's own code: the stub below can move it forward when TMDB answers, to cross the persist limit between the read and the writes.
const clock={offset:0},advance={ms:0},slowAll={ms:0};
class SteppedDate extends Date{static now(){return super.now()+clock.offset;}}

async function world({durations,decision,movieRuntime=96,failFetch=false,fillers=0,cachedRuntime=90,observed={title:'Film R',normalized:'film r'},catalog=null,movieTitles={translations:[],alternatives:[]},authority=Authority,extras=[],watchlist=false,movies={},enrichment=false}){
 clock.offset=0;advance.ms=0;slowAll.ms=0;
 const file=migrated();
 if(enrichment&&enrichment.schema!==false){// AIR-684: the rest of the real chain (0012 onward), so the Catalog Enrichment inbox, the scope tables and the Discovery triggers exist
  const rest=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)&&!chain.includes(name.slice(0,-4))).sort();
  const applied=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+rest.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
  if(applied.status!==0)throw new Error(applied.stderr||'migration failed');
  // These tests are not about the EPG-priority pause (ADR 0135): the table of a schema that predates it is the one the lease code already supports.
  sql(file,'DROP TABLE discovery_epg_priority');
 }
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const setup={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(setup,{programmeRunId:null});
 setup.discoveryLease=taken.lease;
 const item={key:observed.normalized+'|2001',title:observed.title,normalizedTitle:observed.normalized,year:2001,durations:[...durations],duration:durations[0],shows:durations.map((minutes,index)=>({channelId:'c'+index,channel:'C'+index,start:START+index*4*3600000,end:START+index*4*3600000+minutes*MIN})),seenInLatestSnapshot:true,lastAiring:START};
 const extraItems=extras.map((extra,index)=>({key:extra.normalized+'|2001',title:extra.title,normalizedTitle:extra.normalized,year:2001,durations:[...extra.durations],duration:extra.durations[0],shows:extra.durations.map((minutes,at)=>({channelId:'x'+index+'c'+at,channel:'X'+index+'C'+at,start:START+(index+1)*MIN+at*4*3600000,end:START+(index+1)*MIN+at*4*3600000+minutes*MIN})),seenInLatestSnapshot:true,lastAiring:START}));
 await Authority.ingestLedger(setup,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){yield item;for(const extraItem of extraItems)yield extraItem;for(let index=0;index<fillers;index++)yield {key:'filler '+index+'|2005',title:'Filler '+index,normalizedTitle:'filler '+index,year:2005,durations:[100],duration:100,shows:[{channelId:'f',channel:'F',start:START+index*1000,end:START+index*1000+100*MIN}],seenInLatestSnapshot:true,lastAiring:START+index*1000+1};})()});
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','programme',0,'member-1')`);
 sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','programme',0,'${JSON.stringify({runId:RUN,films:[{id:'member-1',tmdbId:'101',shows:[]}]})}')`);
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const stored={...decision,evidenceKey:sql(file,`SELECT evidence_key FROM discovery_observation WHERE observation_key='${item.key}'`)[0].evidence_key};
 const wrote=await Authority.writeDecisionDelta(setup,{[item.key]:{previous:null,next:stored}},{lease:taken.lease});
 assert.deepEqual(wrote.written,[item.key],JSON.stringify(wrote));
 for(const extra of extras){
  const key=extra.normalized+'|2001';
  const evidence=sql(file,`SELECT evidence_key FROM discovery_observation WHERE observation_key='${key}'`)[0].evidence_key;
  const placed=await Authority.writeDecisionDelta(setup,{[key]:{previous:null,next:{...extra.decision,evidenceKey:evidence}}},{lease:taken.lease});
  assert.deepEqual(placed.written,[key],JSON.stringify(placed));
  if(extra.catalog){const seeded=await Authority.upsertAdmissions(setup,{[extra.catalog.id]:extra.catalog},{lease:taken.lease});assert.deepEqual(seeded.written,[extra.catalog.id],JSON.stringify(seeded));}
 }
 if(catalog){const seeded=await Authority.upsertAdmissions(setup,{[catalog.id]:catalog},{lease:taken.lease});assert.deepEqual(seeded.written,[catalog.id],JSON.stringify(seeded));}
 await Authority.releaseLease(setup,taken.lease);
 const env={DB:d1Standin(file),BUCKET:new MemoryBucket(),discoveryLease:null,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const fetched=[],queries=[];
 const movie={id:101,title:'Film R',original_title:'Film R',release_date:'2001-05-01',runtime:movieRuntime,genres:[{id:18,name:'Drama'}],credits:{crew:[],cast:[]},translations:{translations:movieTitles.translations},images:{posters:[]},poster_path:null,alternative_titles:{titles:movieTitles.alternatives}};
 const context=vm.createContext({console,Date:SteppedDate,Promise,URL,URLSearchParams,AbortSignal,TextEncoder,TextDecoder,crypto:webcrypto,setTimeout,clearTimeout,
  fetch(url){const parsed=new URL(url);fetched.push(parsed.pathname);if(parsed.pathname.includes('/movie/'))queries.push(parsed.search);clock.offset+=slowAll.ms;if(parsed.pathname.includes('/movie/'))clock.offset+=advance.ms;if(failFetch.value)return Promise.resolve(new Response('{}',{status:429,headers:{'Retry-After':'30'}}));const wanted=Number((parsed.pathname.match(/\/movie\/(\d+)/)||[])[1]);return Promise.resolve(new Response(JSON.stringify(parsed.pathname.includes('/movie/')?(movies[wanted]||movie):{results:[]}),{status:200,headers:{'Content-Type':'application/json'}}));},
  DiscoveryAuthority:authority,...(enrichment?{CatalogEnrichmentDiscovery:EnrichmentDiscovery,CatalogEnrichmentRunner:enrichment.runner}:{}),pinEpg:async value=>value,refreshPredictionQueue:async()=>{},
  loadJSON:async(target,key)=>{if(key==='programme.json')return {runId:RUN,films:[]};if(key==='epg/published-generation.json')return {phase:'published',programmeRunId:RUN};const routed=await Authority.routeRead(target,key);return routed.handled?routed.value:null;},
  saveJSON:async(target,key,value)=>{const routed=await Authority.routeWrite(target,key,value);if(!routed.handled)throw new Error('not stored');}});
 for(const name of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js'])vm.runInContext(fs.readFileSync(name,'utf8'),context);
 const report={films:catalog&&!watchlist?[]:[{id:'member-1',tmdbId:'101',title:'Film R',original:'Film R',year:2001,runtime:cachedRuntime,canonicalIdentity:'tmdb:101',shows:[]}]};
 const chunk=async(options={})=>{
  const lease=await Authority.acquireLease(env,{programmeRunId:RUN});env.discoveryLease=lease.lease;
  try{
   if(!options.keep)sql(file,"DELETE FROM discovery_status");
   if(options.prior)sql(file,`UPDATE discovery_status SET programme_run_id='${RUN}', payload_json='${JSON.stringify(options.prior)}' WHERE id=1`);
   return await context.resolveDiscoveryChunk(env,report,24,lease.lease);
  }finally{await Authority.releaseLease(env,lease.lease);}
 };
 return {file,env,chunk,fetched,queries,item,context};
}
const decisionOf=(file,key='film r|2001')=>JSON.parse(sql(file,`SELECT payload_json FROM discovery_decision WHERE observation_key='${key}'`)[0].payload_json);
const admissionOf=(file,id)=>JSON.parse(sql(file,`SELECT payload_json FROM discovery_admission WHERE film_id='${id}'`)[0].payload_json);
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

// G. The fresh detail is the runtime evidence: the cached Film says 90, TMDB now says 180, the slot is 180. The duration becomes an anchor and no failure is consumed.
{
 const {file,chunk}=await world({durations:[90,180],decision:verified({anchor:[90]}),cachedRuntime:90,movieRuntime:180});
 const result=await chunk();
 assert.equal(result.revalidation.revalidated,1,JSON.stringify(result.revalidation));
 const decision=decisionOf(file);
 assert.deepEqual(decision.anchor,[90,180]);assert.deepEqual(decision.failedDurations,[]);
 assert.equal(rowsOf(file).length,2);
}
// H. Fresh detail that genuinely disagrees keeps the failure valid.
{
 const {file,chunk}=await world({durations:[90,180],decision:verified({anchor:[90]}),cachedRuntime:90,movieRuntime:90});
 const result=await chunk();
 assert.equal(result.revalidation.revalidation_failed,1,JSON.stringify(result.revalidation));
 assert.deepEqual(decisionOf(file).failedDurations,[180]);assert.equal(rowsOf(file).length,1);
}
// I. The transition to exhaustion (example 38): eleven failures and two new drifted durations. Only the first is evaluated, it is the twelfth, the second is not; later chunks make no call.
{
 const eleven=[100,101,102,103,104,105,106,107,108,109,110];
 const {file,chunk,fetched}=await world({durations:[90,150,160],decision:verified({anchor:[90],failedDurations:eleven}),movieRuntime:90});
 const first=await chunk();
 assert.equal(first.revalidation.revalidation_failed,1,JSON.stringify(first.revalidation));
 assert.equal(first.revalidation.revalidation_exhausted,1);
 assert.deepEqual(decisionOf(file).failedDurations,[...eleven,150],'160 was not evaluated');
 const calls=movieCalls(fetched);
 const later=await chunk();
 assert.equal(movieCalls(fetched),calls,'no automatic call after the twelfth failure');
 assert.equal(later.revalidation.revalidation_exhausted,1);
 assert.deepEqual(decisionOf(file).failedDurations,[...eleven,150]);
}

// J. AIR-503 / ADR 0158: a catalog-only Film whose stored decision came from an alias. TMDB lists the observed title (a Ukrainian translation), so the
// drifted duration is reconfirmed alone, becomes an anchor, and the movie's own titles are recorded as the Film's provenance by one fenced admission write.
const unanchored=extra=>{const value=verified(extra);delete value.anchor;return value;};
const legacyCatalog=extra=>({id:'tmdb_101',tmdbId:'101',title:'Film R',original:'Film R',year:2001,runtime:96,canonicalIdentity:'tmdb:101',aliases:['Film R','Фільм Р','Series R'],...extra});
{
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}},{iso_639_1:'de',data:{title:'Film R DE'}}],alternatives:[{iso_3166_1:'US',title:'Film R: The Movie'},{iso_3166_1:'FR',title:'Film R FR'}]}});
 assert.equal(admissionOf(file,'tmdb_101').movieTitles,undefined,'a legacy record starts without provenance');
 const result=await chunk();
 assert.equal(result.revalidation.revalidated,1,JSON.stringify(result.revalidation));
 const decision=decisionOf(file,'фільм р|2001');
 assert.deepEqual(decision.anchor,[96]);assert.equal(decision.identitySource,'tmdb_detail');
 const stored=admissionOf(file,'tmdb_101');
 assert.deepEqual(stored.movieTitles,['Film R','Фільм Р','Film R: The Movie'],'only what TMDB lists for this movie (ru/uk/en translations, RU/UA/US/GB alternatives)');
 assert.equal(stored.aliases.includes('Series R'),true,'existing aliases are kept');
 assert.equal(stored.aliases.includes('Film R DE'),false,'a translation outside ru/uk/en is not recorded');
 const again=await chunk();
 assert.equal(again.revalidation.revalidated,0);
 assert.deepEqual(admissionOf(file,'tmdb_101').movieTitles,stored.movieTitles,'a later chunk writes nothing more');
}
// K. The alias is not a title of the movie. The stored alias `Series R` matches the observation and the scorer accepts it, but TMDB does not list it: the movie-detail
// gate requires the observed title among the titles of the fetched detail (`detail_title_mismatch`), so the duration fails, no anchor is stored, no provenance is written
// and the aliases are unchanged. A stored alias never reconfirms a duration on its own.
{
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Series R',normalized:'series r'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const result=await chunk();
 assert.equal(result.revalidation.revalidation_failed,1,JSON.stringify(result.revalidation));assert.equal(result.revalidation.revalidated,0);
 const decision=decisionOf(file,'series r|2001');
 assert.equal(decision.anchor===undefined||decision.anchor.length===0,true,'no anchor from an alias');assert.deepEqual(decision.failedDurations,[96]);
 assert.equal(decision.tmdbId,'101');assert.equal(decision.status,'verified','the decision is not deleted or rejected');
 const record=admissionOf(file,'tmdb_101');
 assert.equal(record.movieTitles,undefined,'no provenance is written for an alias that TMDB does not list');
 assert.deepEqual(record.aliases,['Film R','Фільм Р','Series R'],'the stored aliases are not rewritten');
 assert.equal(rowsOf(file).length,0,'the 96 minute slot under the alias key stays a broadcast');
}

// L. AIR-503 retryability. The provenance is written before the decision that makes the duration an anchor. When the admission write does not land (the Film is not in `written`),
// nothing durable has changed: no anchor, no failed duration, no provenance, so the drift persists and the next chunk evaluates the duration again and completes both.
{
 const skip={value:true};
 const wrapped={...Authority,upsertAdmissions:(target,films,context)=>skip.value&&Object.values(films).some(film=>(film.movieTitles||[]).includes('Фільм Р'))?Promise.resolve({written:[],refused:[],skipped:[]}):Authority.upsertAdmissions(target,films,context)};
 const {file,chunk,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),authority:wrapped,
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const before=JSON.stringify(decisionOf(file,'фільм р|2001'));
 const first=await chunk();
 assert.equal(first.revalidation.revalidated,0,JSON.stringify(first.revalidation));assert.equal(first.revalidation.deferred,1,'the skipped write is a deferral, not a verdict');
 assert.equal(JSON.stringify(decisionOf(file,'фільм р|2001')),before,'the decision is byte-identical: no anchor, no failed duration');
 assert.equal(admissionOf(file,'tmdb_101').movieTitles,undefined);
 const calls=movieCalls(fetched);
 skip.value=false;
 const second=await chunk();
 assert.equal(movieCalls(fetched)>calls,true,'the duration was still drifted work and is evaluated again');
 assert.equal(second.revalidation.revalidated,1,JSON.stringify(second.revalidation));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 assert.deepEqual(admissionOf(file,'tmdb_101').movieTitles,['Film R','Фільм Р'],'both the anchor and the provenance are stored after the retry');
}

// M. AIR-503 time-budget boundary. TMDB answers inside the budget, then the persist limit is crossed before the writes: the provenance and the decision both wait. Nothing durable
// changes (no anchor, no provenance, no failed duration), the observation counts as deferred, and a later chunk with time completes both.
{
 const {file,chunk,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const before=JSON.stringify(decisionOf(file,'фільм р|2001'));
 advance.ms=33000;
 const late=await chunk();
 assert.equal(late.revalidation.deferred,1,JSON.stringify(late.revalidation));assert.equal(late.revalidation.revalidated,0);
 assert.equal(JSON.stringify(decisionOf(file,'фільм р|2001')),before,'the decision is untouched: no anchor, so the drift stays');
 assert.equal(admissionOf(file,'tmdb_101').movieTitles,undefined,'and no provenance was written');
 const calls=movieCalls(fetched);
 advance.ms=0;clock.offset=0;
 const next=await chunk();
 assert.equal(movieCalls(fetched)>calls,true);
 assert.equal(next.revalidation.revalidated,1,JSON.stringify(next.revalidation));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 assert.deepEqual(admissionOf(file,'tmdb_101').movieTitles,['Film R','Фільм Р']);
}

// N. AIR-503 reserve. Candidates without a decision took every TMDB call of the chunk in scenario F, so a drifted decision never got one. A legacy `known_epg_alias` decision of a catalog-only Film
// whose observed title has no movie provenance now holds one call back for itself (at most four): the candidates stop one call earlier, the chunk still makes at most sixteen calls,
// and the revalidation records the provenance. A drifted decision that is not in that class (scenario F) gets no reserve.
{
 const {file,chunk,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),fillers:12,
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const result=await chunk();
 assert.equal(result.tmdbCalls<=16,true,'the chunk never exceeds its sixteen calls');
 assert.equal(result.tmdbCalls,16,'the candidates and the revalidation used every call: '+result.tmdbCalls);
 assert.equal(movieCalls(fetched)>=1,true);
 assert.equal(result.revalidation.revalidated,1,JSON.stringify(result.revalidation));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 assert.deepEqual(admissionOf(file,'tmdb_101').movieTitles,['Film R','Фільм Р']);
}
// O. The reserve is for that class only and does not widen what counts as evidence: the same starved chunk with an alias that TMDB does not list reserves a call, spends it, fails the
// gate and writes neither an anchor nor provenance.
{
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Series R',normalized:'series r'},catalog:legacyCatalog(),fillers:12,
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const result=await chunk();
 assert.equal(result.revalidation.revalidation_failed,1,JSON.stringify(result.revalidation));
 assert.equal(admissionOf(file,'tmdb_101').movieTitles,undefined);
 assert.deepEqual(decisionOf(file,'series r|2001').failedDurations,[96]);
}

// P. The legacy cohort of a chunk is bounded: at most four decisions are revalidated before the candidates, found by their own keyset read (not by the replay or touch pages).
{
 const source=fs.readFileSync('src/discovery.js','utf8');
 assert.match(source,/const PAGED_LEGACY_REVALIDATION_KEYS=4;/);
 assert.match(source,/want:PAGED_LEGACY_REVALIDATION_KEYS/);
 assert.match(source,/selectLegacyAliasObservations/);
 assert.doesNotMatch(source,/callCap|PAGED_REVALIDATION_RESERVE/,'no call quota is held back: the cohort goes first instead');
 assert.doesNotMatch(source,/if\(revalidatedFirst\.size>=PAGED_LEGACY_REVALIDATION_KEYS\)break;/,'the cohort no longer walks driftSeen');
}

// Q. AIR-503 priority. A drifted decision that is NOT in the legacy class sorts before the legacy one and candidates are plentiful. The legacy decision is revalidated first (its detail
// call is the first movie request of the chunk), the other drift keeps its place after the candidates, and the chunk stays within its 16 calls.
{
 const legacyFilm=legacyCatalog({id:'tmdb_202',tmdbId:'202',canonicalIdentity:'tmdb:202'});
 const {file,chunk,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_202',tmdbId:'202',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyFilm,watchlist:true,fillers:14,
  movies:{202:{id:202,title:'Film R',original_title:'Film R',release_date:'2001-05-01',runtime:96,genres:[{id:18,name:'Drama'}],credits:{crew:[],cast:[]},translations:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}]},alternative_titles:{titles:[]}}},
  extras:[{title:'Aaa Drift',normalized:'aaa drift',durations:[90,96],decision:verified({anchor:[90]})}]});
 const result=await chunk();
 const movieRequests=fetched.filter(pathname=>pathname.includes('/movie/'));
 assert.equal(movieRequests[0].includes('/movie/202'),true,'the legacy decision is revalidated first: '+movieRequests.join(','));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96],'it was executed, not deferred');
 assert.deepEqual(admissionOf(file,'tmdb_202').movieTitles,['Film R','Фільм Р']);
 assert.equal(result.tmdbCalls<=16,true,'the cap of sixteen calls holds: '+result.tmdbCalls);
 assert.equal(result.tmdbCalls>1,true,'the candidates still ran');
}

// R. AIR-503 time pressure. Every TMDB answer takes 5 seconds of the chunk's clock and there are many candidates. A reserve of calls would not help here, because the candidates would use the
// time; the legacy decision runs before them, so it is executed, the 40 second chunk budget is not exceeded, and the candidates get what is left.
{
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),fillers:14,
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 slowAll.ms=5000;
 const result=await chunk();
 assert.equal(result.revalidation.revalidated,1,JSON.stringify(result.revalidation));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 assert.equal(clock.offset<=40000,true,'the chunk budget of 40 seconds is not exceeded: '+clock.offset);
 assert.equal(result.tmdbCalls<=16,true,String(result.tmdbCalls));
 assert.equal(result.tmdbCalls>1,true,'the candidates got the time that was left');
 assert.equal(result.error??null,null,'the chunk ends normally, with its checkpoint');
}

// AIR-503 handoff of 21 Nov 2026: the cohort must not depend on the replay page meeting the touch page. Helpers for several legacy Films.
const LETTERS=['Альфа','Браво','Чарлі','Дельта','Ехо','Фокстрот','Гольф','Готель'];
const listed=(id,uk)=>({id,title:'Film L'+id,original_title:'Film L'+id,release_date:'2001-05-01',runtime:96,genres:[{id:18,name:'Drama'}],credits:{crew:[],cast:[]},translations:{translations:uk?[{iso_639_1:'uk',data:{title:uk}}]:[]},alternative_titles:{titles:[]}});
const legacyExtra=(index,{listedTitle=true}={})=>{
 const id=String(300+index),title=LETTERS[index-1];
 return {extra:{title,normalized:title.toLowerCase(),durations:[96],decision:unanchored({filmId:'tmdb_'+id,tmdbId:id,identitySource:'known_epg_alias'}),
   catalog:{id:'tmdb_'+id,tmdbId:id,title:'Film L'+id,original:'Film L'+id,year:2001,runtime:96,canonicalIdentity:'tmdb:'+id,aliases:['Film L'+id,title]}},
  id,key:title.toLowerCase()+'|2001',movie:listed(Number(id),listedTitle?title:null)};
};
const statusOf=file=>JSON.parse(sql(file,"SELECT payload_json FROM discovery_status WHERE id=1")[0].payload_json);
const showsOf=file=>sql(file,"SELECT film_id, match_reason FROM published_epg_show");

// S. The touch page misses the legacy keys. Forty verified keys sort before them, so the 38-key touch page never reaches them and the replay and touch pages cannot meet on them.
// The cohort has its own read: both legacy keys are revalidated in the one chunk. (On the previous implementation neither is, because candidateByKey comes from the touch page.)
{
 const first=legacyExtra(1),second=legacyExtra(2);
 const plain=Array.from({length:40},(_,n)=>({title:'Aa '+n,normalized:'aa'+String(n).padStart(2,'0'),durations:[90],decision:verified({anchor:[90]})}));
 const {file,chunk}=await world({durations:[90],decision:verified({anchor:[90]}),extras:[...plain,first.extra,second.extra],movies:{[first.id]:first.movie,[second.id]:second.movie}});
 const result=await chunk();
 assert.equal(result.revalidation.revalidated,2,JSON.stringify(result.revalidation));
 for(const item of [first,second]){
  assert.deepEqual(decisionOf(file,item.key).anchor,[96],item.key);
  assert.deepEqual(admissionOf(file,'tmdb_'+item.id).movieTitles,['Film L'+item.id,item.extra.title]);
 }
 assert.equal(result.tmdbCalls<=16,true,String(result.tmdbCalls));
}

// T. The replay is resting (a lap just ended), so `driftSeen` is empty: the previous implementation revalidated nothing. The cohort does not need it. The diagnostics say what was
// eligible, attempted and deferred, so a natural run can tell "not considered" from "TMDB refused".
{
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 const result=await chunk({keep:true,prior:{schemaVersion:2,programmeRunId:RUN,replayAfter:'',replayLapAt:new Date().toISOString()}});
 assert.equal(result.revalidation.revalidated,1,JSON.stringify(result.revalidation));
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 const legacy=statusOf(file).legacyRevalidation;
 assert.equal(legacy.eligible,1);assert.equal(legacy.attempted,1);assert.equal(legacy.deferred,0);assert.equal(legacy.scanned>=1,true);
 assert.equal(legacy.totals.attempted,1);
 assert.equal(Object.keys(legacy).length<=12&&Object.keys(legacy.totals).length<=5,true,'the payload is bounded');
}

// U. Nine legacy keys and a cap of four per chunk, the replay resting (so only the cohort pass works), the status kept between chunks so the cursor is exercised. Every key gets its attempt and a terminal outcome across three chunks,
// no key is asked twice, each chunk stays within sixteen calls and four keys, and the lap closes.
{
 const items=[1,2,3,4,5,6,7,8].map(index=>legacyExtra(index));
 const {file,chunk,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]},extras:items.map(item=>item.extra),movies:Object.fromEntries(items.map(item=>[item.id,item.movie]))});
 const keys=['фільм р|2001',...items.map(item=>item.key)];
 const anchored=()=>keys.filter(key=>(decisionOf(file,key).anchor||[]).length>0).length;
 const attempts=[],expected=[4,8,9];
 for(let round=0;round<3;round++){
  const result=await chunk(round===0?{keep:true,prior:{schemaVersion:2,programmeRunId:RUN,replayAfter:'',replayLapAt:new Date().toISOString()}}:{keep:true});
  assert.equal(anchored(),expected[round],'keys with a terminal outcome after chunk '+(round+1)+': '+anchored());
  assert.equal(result.tmdbCalls<=16,true,String(result.tmdbCalls));
  const legacy=statusOf(file).legacyRevalidation;
  assert.equal(legacy.attempted<=4,true,'at most four keys per chunk: '+legacy.attempted);
  attempts.push(legacy.attempted);
 }
 for(const key of keys)assert.deepEqual(decisionOf(file,key).anchor,[96],'a terminal outcome for '+key);
 assert.equal(movieCalls(fetched),9,'every key was asked once and none twice: '+movieCalls(fetched));
 assert.deepEqual(attempts,[4,4,1],'four, four, one: '+JSON.stringify(attempts));
 assert.equal(statusOf(file).legacyRevalidation.totals.attempted,9);
}

// V. The movie authority decides. Under a resting replay one legacy key's title is listed by TMDB and another's is not (a series title, a namesake): the first gets its anchor and
// `movieTitles`; the second fails the detail gate, is written to `failedDurations`, gets no anchor, no provenance and no show.
{
 const ok=legacyExtra(1),refused=legacyExtra(2,{listedTitle:false});
 const {file,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]},extras:[ok.extra,refused.extra],movies:{[ok.id]:ok.movie,[refused.id]:refused.movie}});
 const result=await chunk({keep:true,prior:{schemaVersion:2,programmeRunId:RUN,replayAfter:'',replayLapAt:new Date().toISOString()}});
 assert.equal(result.revalidation.revalidated,2,JSON.stringify(result.revalidation));assert.equal(result.revalidation.revalidation_failed,1,JSON.stringify(result.revalidation));
 assert.deepEqual(decisionOf(file,ok.key).anchor,[96]);
 assert.deepEqual(admissionOf(file,'tmdb_'+ok.id).movieTitles,['Film L'+ok.id,'Альфа']);
 const refusedDecision=decisionOf(file,refused.key);
 assert.deepEqual(refusedDecision.failedDurations,[96],'the refusal is a recorded outcome, not silence');
 assert.equal(refusedDecision.anchor===undefined||refusedDecision.anchor.length===0,true);assert.equal(refusedDecision.status,'verified');
 assert.equal(admissionOf(file,'tmdb_'+refused.id).movieTitles,undefined);
 assert.equal(showsOf(file).some(row=>row.film_id==='tmdb_'+refused.id),false,'no false Film assignment for the refused title');
 const legacy=statusOf(file).legacyRevalidation;
 assert.equal(legacy.attempted,3);assert.equal(legacy.eligible,3);
}

// W, X, Y, Z. AIR-503, review of 21 Nov 2026: the sweep must be part of the series, through the REAL hop (`advanceDiscovery`, the call the Workflow makes, which runs the chunk, computes
// `continuationAfterChunk` and returns the contract), not through chunks the test calls by hand. No ordinary candidate remains and the replay is resting, which is the case in which the series used to
// end after the first four keys.
const resting=()=>({schemaVersion:2,programmeRunId:RUN,replayAfter:'',replayLapAt:new Date().toISOString()});
const hopsUntilStop=async(context,env,limit)=>{
 const hops=[];
 for(let hop=0;hop<limit;hop++){
  const out=await context.advanceDiscovery(env,{});
  hops.push({stage:out.stage,next:out.discovery&&out.discovery.nextAction,pending:out.legacyPending,calls:out.tmdbCalls});
  if(!out.discovery||out.discovery.nextAction!=='continue')break;
 }
 return hops;
};
// W. Nine eligible aliases: the series continues after the first four and completes after the ninth.
{
 const items=[1,2,3,4,5,6,7,8].map(index=>legacyExtra(index));
 const {file,env,context,fetched,chunk}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]},extras:items.map(item=>item.extra),movies:Object.fromEntries(items.map(item=>[item.id,item.movie]))});
 sql(file,`UPDATE discovery_status SET programme_run_id='${RUN}', payload_json='${JSON.stringify(resting())}' WHERE id=1`);
 const hops=await hopsUntilStop(context,env,8);
 assert.deepEqual(hops.map(hop=>hop.next),['continue','continue','stop'],JSON.stringify(hops));
 assert.deepEqual(hops.map(hop=>hop.stage),['partial','partial','complete'],JSON.stringify(hops));
 assert.deepEqual(hops.map(hop=>hop.pending),[true,true,false]);
 assert.equal(hops.every(hop=>hop.calls<=16),true);
 const keys=['фільм р|2001',...items.map(item=>item.key)];
 for(const key of keys)assert.deepEqual(decisionOf(file,key).anchor,[96],'a terminal outcome for '+key);
 assert.equal(movieCalls(fetched),9,'every key was asked once: '+movieCalls(fetched));
 const legacy=statusOf(file).legacyRevalidation;
 assert.equal(legacy.pending,false);assert.equal(legacy.lapComplete,true);assert.equal(legacy.capReached,false);assert.equal(legacy.totals.attempted,9);assert.equal(legacy.totals.sweepChunks,2);
 // Y. The lap rests: a chunk of the same run after the lap does not scan or ask TMDB again, and the series stays complete.
 const after=await chunk({keep:true});
 assert.equal(after.stage,'complete');
 assert.equal(statusOf(file).legacyRevalidation.resting,true);assert.equal(statusOf(file).legacyRevalidation.scanned,0);
 assert.equal(movieCalls(fetched),9,'no key is asked twice after the lap');
}
// X. The cap. A run that has already spent 40 sweep chunks completes at once, with the eligible keys unattempted, and says so (`capReached`): the loop is bounded and the stop is visible.
{
 const items=[1,2,3].map(index=>legacyExtra(index));
 const {file,env,context,fetched}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]},extras:items.map(item=>item.extra),movies:Object.fromEntries(items.map(item=>[item.id,item.movie]))});
 sql(file,`UPDATE discovery_status SET programme_run_id='${RUN}', payload_json='${JSON.stringify({...resting(),legacyRevalidation:{totals:{sweepChunks:40}}})}' WHERE id=1`);
 const hops=await hopsUntilStop(context,env,4);
 assert.deepEqual(hops.map(hop=>hop.stage),['complete'],JSON.stringify(hops));
 assert.equal(movieCalls(fetched),0,'the cap stops the sweep');
 const legacy=statusOf(file).legacyRevalidation;
 assert.equal(legacy.capReached,true);assert.equal(legacy.pending,false);assert.equal(legacy.attempted,0);
 assert.equal((decisionOf(file,'фільм р|2001').anchor||[]).length,0);
}
// Z. Without a cohort the completion semantics are unchanged: one hop, complete, and the lap rests.
{
 const {file,env,context}=await world({durations:[90],decision:verified({anchor:[90]})});
 const hops=await hopsUntilStop(context,env,4);
 assert.deepEqual(hops.map(hop=>hop.stage),['complete'],JSON.stringify(hops));
 const legacy=statusOf(file).legacyRevalidation;
 assert.equal(legacy.pending,false);assert.equal(legacy.attempted,0);
}

// AA. AIR-503, second review of 21 Nov 2026: a skipped durable write is not a handled key. Through the REAL hop, a resting replay and one eligible alias whose provenance write does not land:
// the hop must not complete (no anchor, no failed duration and no provenance exist), the cursor and the lap stay open, and after the write works the next hop stores both and completes.
{
 const skip={value:true};
 const wrapped={...Authority,upsertAdmissions:(target,films,context)=>skip.value&&Object.values(films).some(film=>(film.movieTitles||[]).includes('Фільм Р'))?Promise.resolve({written:[],refused:[],skipped:[]}):Authority.upsertAdmissions(target,films,context)};
 const {file,env,context}=await world({durations:[96],decision:unanchored({filmId:'tmdb_101',identitySource:'known_epg_alias'}),observed:{title:'Фільм Р',normalized:'фільм р'},catalog:legacyCatalog(),authority:wrapped,
  movieTitles:{translations:[{iso_639_1:'uk',data:{title:'Фільм Р'}}],alternatives:[]}});
 sql(file,`UPDATE discovery_status SET programme_run_id='${RUN}', payload_json='${JSON.stringify(resting())}' WHERE id=1`);
 const before=JSON.stringify(decisionOf(file,'фільм р|2001'));
 const first=await context.advanceDiscovery(env,{});
 assert.equal(first.stage,'partial',JSON.stringify(first.discovery));assert.equal(first.discovery.nextAction,'continue','the Workflow must hop again');assert.equal(first.legacyPending,true);
 assert.equal(JSON.stringify(decisionOf(file,'фільм р|2001')),before,'nothing durable changed');
 assert.equal(statusOf(file).legacyRevalidation.lapComplete,false);assert.equal(statusOf(file).legacyRevalidation.deferred,1);
 skip.value=false;
 const second=await context.advanceDiscovery(env,{});
 assert.equal(second.stage,'complete',JSON.stringify(second.discovery));assert.equal(second.discovery.nextAction,'stop');
 assert.deepEqual(decisionOf(file,'фільм р|2001').anchor,[96]);
 assert.deepEqual(admissionOf(file,'tmdb_101').movieTitles,['Film R','Фільм Р']);
 assert.equal(statusOf(file).legacyRevalidation.lapComplete,true);
}


// AIR-684 (ADR 0219 decision 2): the REAL revalidation path writes the Discovery `source_changed` signals, wakes an idle producer without any other admission or cron, keeps a failed enqueue retryable and never loses the change.
{
 const T0='2026-11-27T10:00:00.000Z';
 const seedFilm=file=>sql(file,`INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:tmdb:101',2,NULL,'Film R','${T0}');INSERT INTO film_external_id VALUES ('film:tmdb:101','tmdb','101',1,0,NULL);INSERT INTO catalog_enrichment_member (film_id,scope,admitted_at,signal_key) VALUES ('film:tmdb:101','discovery','${T0}','k')`);
 const signals=file=>sql(file,"SELECT part,state,version FROM enrichment_signal WHERE kind='source_changed' AND subject='film:tmdb:101' ORDER BY part").map(r=>r.part+'='+r.state+'@v'+r.version);
 const calls=[];
 const runner={hasRunnable:async()=>{calls.push('has');return true;},kick:async()=>{calls.push('kick');}};
 globalThis.CatalogEnrichmentRunner=runner;// the module is a real ES module in this realm: it reads the runner global exactly as the bundled Worker does
 {
  // a Film that holds a retained Discovery membership: the verified response becomes durable signals, the producer is woken, and the outcome of the revalidation is written
  const {file,chunk,queries}=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner}});
  seedFilm(file);calls.length=0;
  const first=await chunk();
  assert.equal(queries.length,1,'one detail call');
  assert.equal(decodeURIComponent(queries[0]),'?language=ru-RU&append_to_response=credits,translations,alternative_titles,images&include_image_language=ru,en,null','an approved observer (the schema applied, a retained Discovery membership): the existing call (its alternative_titles kept) also carries the tagged image lists, the producer\'s request shape, never a second request');
  assert.equal(first.revalidation.revalidated,1);
  assert.deepEqual(decisionOf(file).anchor,[90,96],'the revalidation outcome is durable');
  assert.deepEqual(signals(file),['core=pending@v1','credits=pending@v1','localization=pending@v1'],'one signal per VERIFIED part of the detail');
  assert.deepEqual(calls,['has','kick'],'the producer is woken from the revalidation itself: no admission, no cron');
  assert.equal(sql(file,"SELECT COUNT(*) AS n FROM enrichment_signal WHERE kind='admitted'")[0].n,0,'Discovery admission behaviour is unchanged: no admitted signal, no second queue');
 }
 {
  // a Film with no retained membership: nothing is written and nothing wakes, and the LIVE request is the former one
  const {file,chunk,queries}=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner}});
  calls.length=0;
  await chunk();
  assert.equal(decodeURIComponent(queries[0]),'?language=ru-RU&append_to_response=credits,translations,alternative_titles','the schema is applied but no scope holds this Film: the live revalidation request is unchanged');
  assert.deepEqual(signals(file),[]);assert.deepEqual(calls,[]);
  assert.deepEqual(decisionOf(file).anchor,[90,96],'the revalidation is not delayed by an unobserved Film');
 }
 {
  // an enqueue failure: the verified outcome is NOT made durable, the key stays eligible, the producer is still woken (the write may have landed), and the next chunk observes again and succeeds
  const {file,env,chunk,fetched}=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner}});
  seedFilm(file);calls.length=0;
  const real=env.DB;
  env.DB={...real,prepare:text=>{if(/INSERT INTO enrichment_signal/.test(text))throw new Error('D1 unavailable');return real.prepare(text);},batch:real.batch.bind(real)};
  const failedChunk=await chunk();
  assert.equal(failedChunk.revalidation.revalidated,0);assert.ok(failedChunk.revalidation.deferred>=1,'the revalidation is deferred, not completed');
  assert.deepEqual(decisionOf(file).anchor,[90],'no decision was written without the verified change being enqueued');
  assert.deepEqual(signals(file),[]);assert.deepEqual(calls,['has','kick'],'woken after the uncertain outcome');
  env.DB=real;calls.length=0;
  const recovered=await chunk({keep:false});
  assert.equal(recovered.revalidation.revalidated,1,'recovered on the next chunk');
  assert.deepEqual(decisionOf(file).anchor,[90,96]);
  assert.deepEqual(signals(file),['core=pending@v1','credits=pending@v1','localization=pending@v1']);
  assert.equal(movieCalls(fetched),2,'the observation was made again, not guessed');
  // and the change that landed is not duplicated by a repeated observation
  assert.deepEqual(calls,['has','kick']);
 }
 {
  // a FAILED eligibility read for a retained member: nothing is committed and no upstream request is made (the drift event is not consumed without its verified change), and the retry emits once
  const {file,env,chunk,queries}=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner}});
  seedFilm(file);calls.length=0;
  const real=env.DB;
  env.DB={...real,prepare:text=>{if(/catalog_enrichment_member/.test(text))throw new Error('D1 unavailable');return real.prepare(text);},batch:real.batch.bind(real)};
  const failedChunk=await chunk();
  assert.equal(failedChunk.revalidation.revalidated,0);assert.ok(failedChunk.revalidation.deferred>=1,'deferred, not completed');
  assert.deepEqual(decisionOf(file).anchor,[90],'no decision was committed');
  assert.deepEqual(queries,[],'and no upstream request was made');
  assert.deepEqual(signals(file),[]);
  env.DB=real;
  const retried=await chunk({keep:false});
  assert.equal(retried.revalidation.revalidated,1);assert.deepEqual(decisionOf(file).anchor,[90,96]);
  assert.deepEqual(signals(file),['core=pending@v1','credits=pending@v1','localization=pending@v1'],'the retry emits the verified change');
  assert.equal(queries.length,1,'one upstream request in total: the failed read cost none');
 }
 {
  // a lost Discovery lease at the causal write applies nothing: a held lease is part of the statement
  const lost=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner}});
  seedFilm(lost.file);
  const out=await EnrichmentDiscovery.emitSourceChanged(lost.env,{tmdbId:'101',movie:{id:101,release_date:'2001-05-01',runtime:96,credits:{cast:[],crew:[]},translations:{translations:[]}},lease:{id:'not-held',expiresAt:1}});
  assert.equal(out.state,'unchanged');assert.deepEqual(signals(lost.file),[]);
 }
}

// Dormancy of the live request: before the enrichment schema is applied (or without the module, as an older Worker) the revalidation asks for exactly what `main` asked for, and no signal can exist.
{
 // the NEW code deployed before the migration is applied: the module is present, the tables are not
 {
  const {queries,chunk}=await world({durations:[90,96],decision:verified({anchor:[90]}),enrichment:{runner:null,schema:false}});
  assert.equal((await chunk()).revalidation.revalidated,1);
  assert.deepEqual(queries.map(decodeURIComponent),['?language=ru-RU&append_to_response=credits,translations,alternative_titles'],'new code, old schema: the live request is unchanged and nothing fails');
 }
 const {file,chunk,queries}=await world({durations:[90,96],decision:verified({anchor:[90]})});
 const out=await chunk();
 assert.equal(out.revalidation.revalidated,1);
 assert.deepEqual(queries.map(decodeURIComponent),['?language=ru-RU&append_to_response=credits,translations,alternative_titles'],'before the apply: the live request, byte for byte');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM sqlite_master WHERE name='enrichment_signal'")[0].n,0);
}
delete globalThis.CatalogEnrichmentRunner;
console.log('discovery revalidation ok');
