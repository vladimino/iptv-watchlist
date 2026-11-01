// ADR 0079. D1 owns the published generation only after its own marker is d1.
// Counts and ids below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as PublishedEpg from '../src/published-epg.js';
import {CHUNK_BYTES,CHUNK_STATEMENTS,CLAIM_TTL_MS,MAX_STATEMENT_BYTES,activatePublished,advancedFence,currentGeneration,generationObjectKey,importPublished,patchProgramme,programmeShows,publishGeneration,readAuthority,readDocument,readDocumentAt,readMembers,readShows,repairMirrors,revertPublished,saveWatchlist,writeMirrors} from '../src/published-epg.js';
import {DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,MAX_ROW_STATEMENT_BYTES} from '../src/generation-stage.js';
import {generationProjection} from '../src/epg-repository.js';
import {readAuthority as readCache} from '../src/metadata-cache.js';
import {readPredictionAuthority, routeRead} from '../src/prediction-d1.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {projectorContext} from './d1-enrichment-context.mjs';

assert.equal(CHUNK_STATEMENTS,DEFAULT_CHUNK_STATEMENTS);
assert.equal(CHUNK_BYTES,DEFAULT_CHUNK_BYTES);
assert.equal(MAX_STATEMENT_BYTES,MAX_ROW_STATEMENT_BYTES);
assert.equal(CLAIM_TTL_MS,15*60*1000);
assert.equal(generationObjectKey('run-1','programme.json'),'epg/generations/run-1/programme.json');
assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/env\.DB\b/);
assert.doesNotMatch(fs.readFileSync('src/discovery.js','utf8'),/env\.DB\b/);
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/published-epg\.js','PublishedEpg'\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/PublishedEpg\.publishGeneration\(env,/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/PredictionD1\.routeRead\(env,key\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/PredictionD1\.overlayIndex\(env,value,canonicalMoodFacet\)/);
assert.match(fs.readFileSync('build.mjs','utf8'),/scoped\('src\/prediction-d1\.js','PredictionD1'\)/);
assert.match(fs.readFileSync('src/worker.js','utf8'),/published_epg_unavailable/);
const worker=fs.readFileSync('src/worker.js','utf8');
assert.ok(worker.indexOf('removalRefs')<worker.indexOf('generation_publish'),'removal handover is saved before publication');
assert.match(worker,/refreshPredictionQueue\(env,report,'programme_updated'\)/);
assert.match(fs.readFileSync('src/discovery.js','utf8'),/PublishedEpg\.currentGeneration\(env\)/);
assert.doesNotMatch(fs.readFileSync('src/published-epg.js','utf8'),/INTO candidate |INTO film |prediction_domain|film_person_credit|watchlist_film/);
assert.doesNotMatch(fs.readFileSync('src/admin/read.js','utf8'),/env\.DB\b/);
assert.match(fs.readFileSync('src/admin/read.js','utf8'),/PublishedEpg\.currentGeneration\(env\)/);
assert.match(fs.readFileSync('src/admin/posters.js','utf8'),/PublishedEpg\.currentGeneration\(env\)/);
assert.match(fs.readFileSync('src/letterboxd-ratings.js','utf8'),/PublishedEpg\.currentGeneration\(env\)/);
assert.doesNotMatch(fs.readFileSync('src/admin/letterboxd-archive.js','utf8').replace(/\/\/.*$/gm,''),/\.put\(|\.delete\(|\.list\(|\bfetch\(|console\.|waitUntil|caches\.|\benv\.(?!BUCKET\b)\w/);
assert.doesNotMatch(fs.readFileSync('scripts/published-epg-production.mjs','utf8'),/time_travel\/restore/);

const projected=generationProjection({programmeRunId:'run-1',phase:'published',expectedProgrammeRunId:null,publishedAt:'2026-11-01T00:00:00.000Z',films:[{filmId:'film:heat',shows:[{channelId:'ch',channel:'One',startMs:10,endMs:20,epgTitle:'Heat',basis:'title_year',matchReason:null}]}]});
assert.deepEqual(programmeShows([{id:'film:heat',shows:[{channelId:'ch',channel:'One',start:10,end:20,epgTitle:'Heat',basis:'title_year',matchReason:null}]}]).map(show=>({film_id:show.filmId,channel_id:show.channelId,channel:show.channel,start_ms:show.startMs,end_ms:show.endMs,epg_title:show.epgTitle,basis:show.basis,match_reason:show.matchReason})),projected.films[0].shows);
assert.deepEqual(programmeShows([{id:'film:heat',shows:[]}]),[]);
assert.deepEqual(programmeShows([{id:'film:heat'}]),[]);

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-published-epg-'));
let databases=0;
const names=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0008_published_epg_authority'];
const predictionTables=['prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent'];
function installPrediction(db){
 db.sql('UPDATE schema_contract SET version=7 WHERE id=1');
 for(const name of predictionTables)db.sql('CREATE TABLE '+name+' (id INTEGER PRIMARY KEY)');
}
function open(stopAt=names.length,{onBatch=null}={}){
 const file=path.join(root,'epg-'+(databases++)+'.sqlite');
 const db=d1Standin(file,{onBatch});
 for(const name of names.slice(0,stopAt)){
  if(name==='0008_published_epg_authority')db.sql(fs.readFileSync('migrations/0007_prediction_authority.sql','utf8'));
  db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 }
 return db;
}
const one=(db,sql)=>Object.values(db.sql(sql)[0]||{})[0];
const film=(id,extra={})=>({id,title:id,shows:[],...extra});
const programme=(run,films,extra={})=>({runId:run,updatedAt:'2026-11-01T12:00:00.000Z',watchlistCount:films.length,films,...extra});
const watch=(films)=>({updatedAt:'2026-11-01T12:00:00.000Z',films});
function arm(db){db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");return db;}

{
 const early=open(6);
 assert.equal((await currentGeneration({DB:early})),null);
 await assert.rejects(publishGeneration({DB:early},{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:null,programme:programme('run-a',[film('film:a')]),watchlist:watch([film('film:a')])}),/published_epg_not_authoritative/);
 const v5=open(5);
 let refused=false;
 try{v5.sql(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'));}catch{refused=true;}
 assert.equal(refused,true,'schema v5 cannot take the published EPG migration');
 assert.equal(one(v5,'SELECT version FROM schema_contract'),5);
 assert.equal(one(v5,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'published_epg%' OR name='schema_contract_no_downgrade'"),0);
 const v6=open(6);
 let blocked=false;
 try{v6.sql(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'));}catch{blocked=true;}
 assert.equal(blocked,true,'schema v6 cannot take the published EPG migration');
 assert.equal(one(v6,'SELECT version FROM schema_contract'),6);
 assert.equal(one(v6,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'published_epg%' OR name='schema_contract_no_downgrade'"),0);
}

{
 const chain=d1Standin(path.join(root,'chain-'+(databases++)+'.sqlite'));
 for(const name of ['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority'])chain.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 assert.equal(one(chain,'SELECT version FROM schema_contract'),8);
 assert.equal(one(chain,"SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('prediction_domain_authority','prediction_domain_cas','prediction_profile','prediction_fingerprint','prediction_pointer','prediction_lineage','prediction_queue','prediction_lease','prediction_run','prediction_domain_intent')"),10);
 assert.equal(one(chain,"SELECT mode FROM prediction_domain_authority WHERE id=1"),'r2');
 assert.equal(one(chain,"SELECT mode FROM published_epg_authority WHERE id=1"),'r2');
 const required={PREDICTION_DB_REQUIRED:'on'};
 assert.equal((await readPredictionAuthority(chain,required)).mode,'r2');
 assert.equal((await routeRead({DB:chain,...required},'enrichment/prediction-queue.json')).handled,false);
 assert.equal(await currentGeneration({DB:chain}),null);
 chain.sql("UPDATE prediction_domain_authority SET mode='d1' WHERE id=1");
 const routed=await routeRead({DB:chain,...required},'enrichment/prediction-queue.json');
 assert.equal(routed.handled,true);
 assert.equal(routed.value,null);
 assert.equal(await currentGeneration({DB:chain}),null,'published EPG stays on R2 while its own marker is r2');
 chain.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 assert.equal((await currentGeneration({DB:chain})).authority,'d1');
 assert.equal((await routeRead({DB:chain,...required},'enrichment/prediction-queue.json')).handled,true);
 const projector=projectorContext();
 const status=await projector.d1EnrichmentStatus(chain,{});
 assert.equal(status.schema,true);
 assert.equal(status.schemaVersion,8);
 assert.equal(status.predictionMode,'d1');
 assert.equal(status.cacheMode,'r2');
}

{
 const db=open();
 assert.equal((await readAuthority(db)).mode,'r2');
 assert.equal((await readAuthority(db)).version,8,'0008 moves a prepared version 7 contract to 8');
 assert.equal(await currentGeneration({DB:db}),null);
 assert.equal((await readCache(db)).mode,'r2');
 db.sql("UPDATE metadata_cache_authority SET mode='d1'");
 assert.equal((await readCache(db)).mode,'d1','a later contract version keeps the metadata marker');
 assert.equal((await readAuthority(db)).mode,'r2');
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:null,programme:programme('run-a',[film('film:a')]),watchlist:watch([film('film:a')])}),/published_epg_not_authoritative/);
}

{
 const db=arm(open());
 const bucket=new MemoryBucket();
 const shows=[{channelId:'ch',channel:'One',start:1_700_000_000_000,end:1_700_003_600_000,epgTitle:'Heat',basis:'title_year',matchReason:'year'}];
 const body=programme('run-a',[film('film:heat',{shows,availableUntil:'2026-11-04T12:00:00.000Z'}),film('film:ronin',{shows:[]})]);
 const list=watch([film('film:ronin'),film('film:heat')]);
 const published=await publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 assert.equal(published.replay,false);
 assert.equal(published.pointed,true);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0);
 assert.equal(one(db,'SELECT COUNT(*) FROM candidate'),0);
 assert.equal(one(db,'SELECT COUNT(*) FROM watchlist_film'),0);
 assert.equal(one(db,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'prediction%'"),one(open(),'SELECT COUNT(*) FROM sqlite_master WHERE name LIKE \'prediction%\''));
 assert.deepEqual((await readMembers(db,'run-a','watchlist')).map(row=>row.filmId),['film:ronin','film:heat']);
 assert.equal((await readShows(db,'run-a')).length,1);
 assert.equal((await readDocument(db,'run-a','programme')).films[1].shows.length,0);
 assert.equal((await readDocument(db,'run-a','programme')).films[0].availableUntil,'2026-11-04T12:00:00.000Z');
 const again=await publishGeneration({DB:db},{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:'run-a',programme:body,watchlist:list},{now:1});
 assert.equal(again.replay,true);
 assert.equal(one(db,'SELECT COUNT(*) FROM published_epg_generation'),1);
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-a',phase:'published',expectedProgrammeRunId:'run-a',programme:programme('run-a',[film('film:heat',{title:'Other'})]),watchlist:list}),/published_epg_conflict/);
 const held=programme('run-held',[film('film:heat',{shows:[]})]);
 await publishGeneration({DB:db},{programmeRunId:'run-held',phase:'withheld',programme:held,watchlist:list},{now:2});
 assert.equal((await readAuthority(db)).programmeRunId,'run-a');
 assert.equal((await readDocument(db,'run-held','programme')).runId,'run-held');
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-b',phase:'published',expectedProgrammeRunId:null,programme:programme('run-b',[film('film:heat',{shows:[]})]),watchlist:list}),/published_epg_fence/);
 const next=programme('run-b',[film('film:heat',{shows:[]})]);
 await publishGeneration({DB:db},{programmeRunId:'run-b',phase:'published',expectedProgrammeRunId:'run-a',programme:next,watchlist:watch([film('film:heat')])},{now:3});
 assert.equal((await currentGeneration({DB:db})).programmeRunId,'run-b');
 assert.equal((await readShows(db,'run-b')).length,0,'the new generation does not keep the previous shows');
 assert.equal((await readShows(db,'run-a')).length,1,'the old generation stays readable');
 assert.equal((await readDocument(db,'run-a','programme')).runId,'run-a');
 const patched=programme('run-b',[film('film:heat',{shows})]);
 assert.equal(await patchProgramme({DB:db,BUCKET:bucket},'run-b',patched,{now:4}),true);
 assert.equal((await readShows(db,'run-b')).length,1);
 assert.equal(await patchProgramme({DB:db},'run-a',body,{now:5}),false);
 const saved=await saveWatchlist({DB:db,BUCKET:bucket},watch([film('film:heat'),film('film:ronin')]),{now:6});
 assert.equal(saved,true);
 assert.deepEqual((await readMembers(db,'run-b','watchlist')).map(row=>row.filmId),['film:heat','film:ronin']);
 assert.equal(one(db,'SELECT COUNT(*) FROM film'),0);
}

{
 let kill=true;
 const seen=[];
 const db=arm(open(names.length,{onBatch(statements){
  seen.push(statements.map(item=>item.text).join('\n'));
  if(kill&&statements.some(item=>item.text.includes('INSERT INTO published_epg_generation')))throw new Error('killed');
 }}));
 const body=programme('run-c',[film('film:heat',{shows:[]})]);
 const list=watch([film('film:heat')]);
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-c',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0,claimTtlMs:1000,owner:'writer-a'}),/published_epg_unavailable/);
 assert.equal((await readAuthority(db)).programmeRunId,null);
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-c',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0,claimTtlMs:1000,owner:'writer-b'}),/published_epg_lease/);
 kill=false;
 const resumed=await publishGeneration({DB:db},{programmeRunId:'run-c',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:5000,claimTtlMs:1000,owner:'writer-b'});
 assert.equal(resumed.pointed,true);
 assert.equal((await readDocument(db,'run-c','programme')).runId,'run-c');
 assert.ok(seen.some(text=>text.includes('INSERT INTO published_epg_generation'))&&seen.every(text=>!/INTO candidate |INTO film |prediction_domain/.test(text)));
}

{
 const shows=Array.from({length:6},(_,index)=>({channelId:'ch-'+index,channel:'C',start:1000+index,end:2000+index,epgTitle:'Show'}));
 let widest=0,statements=0;
 const db=arm(open(names.length,{onBatch(batch){if(!batch.some(item=>item.text.startsWith('INSERT INTO published_epg_stage_row')))return;statements=Math.max(statements,batch.length);widest=Math.max(widest,...batch.map(item=>item.text.length));}}));
 const body=programme('run-wide',[film('film:heat',{shows})]);
 await publishGeneration({DB:db},{programmeRunId:'run-wide',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:watch([film('film:heat')])},{chunkStatements:4,chunkBytes:5000,now:0});
 assert.equal((await readShows(db,'run-wide')).length,6);
 assert.ok(statements<=4,'a chunk stays inside the statement cap');
 assert.ok(widest<=MAX_STATEMENT_BYTES);
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-huge',phase:'published',expectedProgrammeRunId:'run-wide',programme:programme('run-huge',[film('film:heat',{shows:[{channelId:'ch',start:1,epgTitle:'x'.repeat(100000)}]} )]),watchlist:watch([film('film:heat')])}),/published_epg_show/);
 assert.equal((await readAuthority(db)).programmeRunId,'run-wide');
}

{
 const db=arm(open());
 const body=programme('run-m',[film('film:heat',{shows:[]})]);
 const list=watch([film('film:heat')]);
 await publishGeneration({DB:db},{programmeRunId:'run-m',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const bucket=new MemoryBucket();
 bucket.put=async()=>{throw new Error('mirror down');};
 assert.equal(await writeMirrors({DB:db,BUCKET:bucket},{programmeRunId:'run-m',programme:body,watchlist:list,phase:'published'}),false);
 assert.equal((await readDocument(db,'run-m','programme')).runId,'run-m');
 const repaired=new MemoryBucket();
 const result=await repairMirrors({DB:db,BUCKET:repaired});
 assert.equal(result.mirrored,true);
 assert.equal(JSON.parse(repaired.objects.get('epg/published-generation.json').text).programmeRunId,'run-m');
 assert.equal(JSON.parse(repaired.objects.get('watchlist.json').text).films[0].id,'film:heat');
 const pointer=await repaired.get('epg/published-generation.json');
 const watchlistObject=await repaired.get('watchlist.json');
 await activatePublished({DB:db,BUCKET:repaired},{confirm:'activate',pointerEtag:pointer.etag}).catch(()=>{});
 db.sql("UPDATE published_epg_authority SET mode='r2'");
 const imported=await importPublished({DB:db},{confirm:'load',programme:body,watchlist:list,programmeRunId:'run-m',pointerEtag:pointer.etag,watchlistEtag:watchlistObject.etag});
 assert.equal(imported.mode,'r2');
 await repaired.put('watchlist.json',JSON.stringify({updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:other'}]}));
 await assert.rejects(activatePublished({DB:db,BUCKET:repaired},{confirm:'activate',pointerEtag:pointer.etag}),/published_epg_fence/);
 assert.equal((await readAuthority(db)).mode,'r2');
 await repaired.put('watchlist.json',JSON.stringify(list));
 const active=await activatePublished({DB:db,BUCKET:repaired},{confirm:'activate',pointerEtag:pointer.etag});
 assert.equal(active.mode,'d1');
 await repaired.put('watchlist.json',JSON.stringify({updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:stale'}]}));
 const back=await revertPublished({DB:db,BUCKET:repaired},{confirm:'r2'});
 assert.equal(back.mode,'r2');
 assert.equal(JSON.parse(repaired.objects.get('watchlist.json').text).films[0].id,'film:heat');
 assert.equal((await readDocument(db,'run-m','programme')).runId,'run-m');
}

{
 const db=arm(open());
 const films=[{id:'film:heat',title:'Heat',original:'Heat',year:1995,tmdbId:'949',shows:[]}];
 const body={runId:'run-d1',updatedAt:'2026-11-01T12:00:00.000Z',films};
 const list={updatedAt:'2026-11-01T12:00:00.000Z',films};
 await publishGeneration({DB:db},{programmeRunId:'run-d1',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const bucket=new MemoryBucket();
 const put=(key,value)=>bucket.put(key,JSON.stringify(value));
 put('epg/published-generation.json',{phase:'published',programmeRunId:'run-stale'});
 put('epg/generations/run-stale/programme.json',{runId:'run-stale',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:other',title:'Other',shows:[]}]});
 put('metadata.json',{'film:heat':{id:'film:heat',title:'Heat',metadataAt:'2026-11-01T12:00:00.000Z',peopleVersion:1,peopleNamesVersion:2,synopsis:'Synopsis',synopsisFetchedAt:'2026-11-01T12:00:00.000Z'}});
 put('titles.json',{});put('people.json',{});put('epg/discovery-resolution.json',{});
 put('epg/generations/run-d1/discovered-films.json',{});
 const projector=projectorContext();
 const summary=await projector.runD1EnrichmentProjection({DB:db,BUCKET:bucket,D1_ENRICHMENT_WRITE:'dry'});
 assert.equal(summary.programmeRunId,'run-d1');
 assert.notEqual(summary.outcome,'failed');
}

{
 const db=arm(open());
 const body={runId:'run-d1',updatedAt:'2026-11-01T12:00:00.000Z',films:[]};
 await publishGeneration({DB:db},{programmeRunId:'run-d1',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:{updatedAt:'2026-11-01T12:00:00.000Z',films:[]}},{now:0});
 const bucket=new MemoryBucket();
 const seen=[];
 const wrapped={async get(key){seen.push(key);return bucket.get(key);},async put(key,value,options){return bucket.put(key,value,options);}};
 await wrapped.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:'run-stale'}));
 await wrapped.put('epg/generations/run-stale/programme.json',JSON.stringify({runId:'run-stale',updatedAt:'2026-11-01T12:00:00.000Z',films:[{id:'film:other',shows:[]}]}));
 const context=vm.createContext({PublishedEpg,crypto:webcrypto,TextEncoder,TextDecoder,console});
 vm.runInContext(fs.readFileSync('src/admin/read.js','utf8'),context,{filename:'src/admin/read.js'});
 const snapshot=await context.adminLoadSnapshot({DB:db,BUCKET:wrapped},false);
 assert.equal(snapshot.info.programmeRunId,'run-d1');
 assert.equal(snapshot.programme.body.runId,'run-d1');
 assert.equal(snapshot.pointer.authority,'d1');
 assert.equal(seen.includes('epg/generations/run-stale/programme.json'),false);
 assert.equal(snapshot.programme.body.runId,'run-d1');
}

{
 await assert.rejects(readAuthority(undefined),/published_epg_unavailable/);
 await assert.rejects(currentGeneration({}),/published_epg_unavailable/);
 const empty=d1Standin(path.join(root,'empty-'+(databases++)+'.sqlite'));
 await assert.rejects(readAuthority(empty),/published_epg_unavailable/);
 await assert.rejects(readAuthority({DB:empty}),/published_epg_unavailable/);
 assert.equal((await readAuthority({DB:empty,PUBLISHED_EPG_DB_OPTIONAL:'standin'})).mode,'r2');
 assert.equal((await readAuthority({PUBLISHED_EPG_DB_OPTIONAL:'standin'})).mode,'r2');
 const contractOnly=d1Standin(path.join(root,'contract-only-'+(databases++)+'.sqlite'));
 contractOnly.sql('CREATE TABLE schema_contract (id INTEGER PRIMARY KEY, version, note)');
 await assert.rejects(readAuthority(contractOnly),/published_epg_unavailable/);
 assert.equal((await readAuthority({...contractOnly,PUBLISHED_EPG_DB_OPTIONAL:'standin'})).mode,'r2');
 const invalidContract=d1Standin(path.join(root,'contract-invalid-'+(databases++)+'.sqlite'));
 invalidContract.sql("CREATE TABLE schema_contract (id INTEGER PRIMARY KEY, version, note); INSERT INTO schema_contract (id, version, note) VALUES (1, 'nope', 'bad')");
 await assert.rejects(readAuthority(invalidContract),/published_epg_unavailable/);
 assert.equal((await readAuthority({...invalidContract,PUBLISHED_EPG_DB_OPTIONAL:'standin'})).mode,'r2');
 assert.doesNotMatch(fs.readFileSync('src/worker.js','utf8'),/PUBLISHED_EPG_DB_OPTIONAL/);
 assert.doesNotMatch(fs.readFileSync('wrangler.jsonc','utf8'),/PUBLISHED_EPG_DB_OPTIONAL/);
 assert.match(fs.readFileSync('scripts/local-dev.mjs','utf8'),/PUBLISHED_EPG_DB_OPTIONAL:'standin'/);
 assert.equal(advancedFence('d1:3:run-a','d1:4:run-a'),true);
 assert.equal(advancedFence('d1:3:run-a','d1:3:run-a'),false);
 assert.equal(advancedFence('d1:3:run-a','d1:5:run-a'),false);
 assert.equal(advancedFence('d1:3:run-a','d1:4:run-b'),false);
}

{
 const db=arm(open());
 const body=programme('run-take',[film('film:heat',{shows:[]})]);
 const list=watch([film('film:heat')]);
 let taken=false;
 await assert.rejects(publishGeneration({DB:db},{programmeRunId:'run-take',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0,claimTtlMs:1000,owner:'writer-a',afterValidate:async({db:database,stage})=>{
  taken=true;
  database.sql("UPDATE published_epg_stage SET claim_expires_at=0, owner_token='writer-b', claim_nonce='nonce-b', claim_generation=claim_generation+1, state='loading' WHERE programme_run_id='"+stage.id+"'");
 }}),/published_epg_fence/);
 assert.equal(taken,true);
 assert.equal((await readAuthority(db)).programmeRunId,null);
 assert.equal(one(db,"SELECT owner_token FROM published_epg_stage WHERE programme_run_id='run-take'"),'writer-b');
 const resumed=await publishGeneration({DB:db},{programmeRunId:'run-take',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:5000,claimTtlMs:1000,owner:'writer-b'});
 assert.equal(resumed.pointed,true);
 assert.equal((await readDocument(db,'run-take','programme')).runId,'run-take');
}

{
 const db=arm(open());
 const body=programme('run-pin',[film('film:heat',{shows:[]})]);
 const list=watch([film('film:heat')]);
 const bucket=new MemoryBucket();
 await publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:'run-pin',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const pinned=await currentGeneration({DB:db,BUCKET:bucket});
 assert.equal((await readDocumentAt({DB:db,BUCKET:bucket},'run-pin','programme',pinned.generation)).runId,'run-pin');
 const patched=programme('run-pin',[film('film:heat',{shows:[{channelId:'ch',start:10,end:20}]})]);
 assert.equal(await patchProgramme({DB:db,BUCKET:bucket},'run-pin',patched,{now:4,expectedGeneration:pinned.generation}),true);
 await assert.rejects(readDocumentAt({DB:db,BUCKET:bucket},'run-pin','watchlist',pinned.generation),/published_epg_fence/);
 const again=await currentGeneration({DB:db});
 assert.equal((await readDocumentAt({DB:db},'run-pin','watchlist',again.generation)).films[0].id,'film:heat');
 assert.equal((await readDocument(db,'run-pin','programme')).films[0].shows.length,1);
 db.sql('UPDATE published_epg_authority SET generation=generation+1');
 assert.equal(await patchProgramme({DB:db},'run-pin',patched,{expectedGeneration:again.generation}),false);
 assert.equal((await readDocument(db,'run-pin','programme')).films[0].shows.length,1);
}

{
 const stayed=open();
 assert.equal(one(stayed,'SELECT version FROM schema_contract'),8);
 let lowered=false;
 try{stayed.sql('UPDATE schema_contract SET version=5');}catch{lowered=true;}
 assert.equal(lowered,true);
 assert.equal(one(stayed,'SELECT version FROM schema_contract'),8);
 const tableNames=rows=>rows.map(row=>row.name);
 const predictionContract=(version,tables)=>{
  if(version==null||Number(version)<7)return 'r2';
  if(!predictionTables.every(name=>tables.includes(name)))throw new Error('prediction_domain_unavailable');
  return 'r2';
 };
 assert.equal(predictionContract(6,tableNames(open(6).sql("SELECT name FROM sqlite_master WHERE type='table'"))),'r2');
 assert.throws(()=>predictionContract(8,[]),/prediction_domain_unavailable/);
 const raised=open(6);
 installPrediction(raised);
 raised.sql(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'));
 assert.equal(one(raised,'SELECT version FROM schema_contract'),8);
 assert.equal(predictionContract(8,tableNames(raised.sql("SELECT name FROM sqlite_master WHERE type='table'"))),'r2');
 let hidden=false;
 try{raised.sql('UPDATE schema_contract SET version=7');}catch{hidden=true;}
 assert.equal(hidden,true);
 assert.equal(one(raised,'SELECT version FROM schema_contract'),8);
 const bare=open(6);
 bare.sql('UPDATE schema_contract SET version=7 WHERE id=1');
 let bareRefused=false;
 try{bare.sql(fs.readFileSync('migrations/0008_published_epg_authority.sql','utf8'));}catch{bareRefused=true;}
 assert.equal(bareRefused,true,'version 7 without the prediction tables creates nothing');
 assert.equal(one(bare,'SELECT version FROM schema_contract'),7);
 assert.equal(one(bare,"SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'published_epg%'"),0);
}

{
 const db=arm(open());
 const body=programme('run-mix',[film('film:heat',{shows:[]})]);
 const list=watch([film('film:heat')]);
 await publishGeneration({DB:db},{programmeRunId:'run-mix',phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 let watchPuts=0;
 const bucket=new MemoryBucket();
 const flaky={
  async get(key){return bucket.get(key);},
  async put(key,value,options){
   if(key==='watchlist.json'&&watchPuts++===0)throw new Error('mirror down');
   return bucket.put(key,value,options);
  },
 };
 assert.equal(await writeMirrors({DB:db,BUCKET:flaky},{programmeRunId:'run-mix',programme:body,watchlist:list,phase:'published'}),false);
 assert.equal(bucket.objects.has('programme.json'),true);
 assert.equal(bucket.objects.has('epg/published-generation.json'),false);
 const repaired=await repairMirrors({DB:db,BUCKET:flaky});
 assert.equal(repaired.mirrored,true);
 assert.equal(JSON.parse(bucket.objects.get('watchlist.json').text).films[0].id,'film:heat');
 assert.equal(JSON.parse(bucket.objects.get('epg/published-generation.json').text).programmeRunId,'run-mix');
}

{
 const db=arm(open());
 const run='run-d1';
 const shows=[{channelId:'ch',channel:'One',start:Date.now(),end:Date.now()+7200000,epgTitle:'Hot Film'}];
 const filmRow={id:'film:hot',title:'Hot Film',original:'Hot Film',year:2020,tmdbId:'42',shows:[]};
 const body=programme(run,[filmRow]);
 const list=watch([filmRow]);
 await publishGeneration({DB:db},{programmeRunId:run,phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const records=new Map();
 let revision=0;
 const env={DB:db,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0,BUCKET:{
  async get(key){return records.has(key)?{etag:String(revision),json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key))}:null;},
  async put(key,value,options={}){const condition=options.onlyIf;if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==String(revision))return null;records.set(key,JSON.parse(value));return {etag:String(++revision)};},
 }};
 const now=Date.now();
 const candidate={key:'hot film|2020',title:'Hot Film',normalizedTitle:'hot film',year:2020,duration:100,durations:[100],firstAiring:now,lastAiring:now,airings:1,shows};
 const movie={id:42,title:'Hot Film',original_title:'Hot Film',release_date:'2020-01-01',runtime:100,genres:[],credits:{crew:[],cast:[]},translations:{translations:[]},alternative_titles:{titles:[]}};
 records.set('epg/discovery-latest.json',{programmeRunId:run,items:[candidate]});
 records.set('epg/generations/'+run+'/discovery-latest.json',{programmeRunId:run,items:[candidate]});
 records.set('epg/discovery-resolution.json',{});
 records.set('epg/discovered-films.json',{});
 records.set('epg/generations/'+run+'/discovered-films.json',{});
 records.set('programme.json',body);
 const context=vm.createContext({PublishedEpg,Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,structuredClone,fetch:async url=>{assert.match(String(url),/movie\/42/);return new Response(JSON.stringify(movie));}});
 for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context,{filename:file});
 context.env=env;
 context.report=body;
 records.set('titles.json',{ok:true});
 assert.deepEqual(await vm.runInContext("loadJSON({BUCKET:env.BUCKET},'titles.json')",context),{ok:true});
 await assert.rejects(vm.runInContext("loadJSON({BUCKET:{async get(){throw new Error('programme read')}}},'programme.json')",context),/published_epg_unavailable/);
 const httpDb=arm(open());
 await publishGeneration({DB:httpDb},{programmeRunId:run,phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const httpBucket=new MemoryBucket();
 const httpEnv={DB:httpDb,BUCKET:httpBucket};
 assert.equal(await saveWatchlist(httpEnv,{updatedAt:'2026-11-01T13:00:00.000Z',films:[{id:'film:ronin',title:'Ronin',shows:[]}]}),true);
 const watchlistResponse=await context.worker.fetch(new Request('http://127.0.0.1/api/watchlist'),httpEnv,{waitUntil(){}});
 assert.equal(watchlistResponse.status,200);
 assert.deepEqual((await watchlistResponse.json()).films.map(film=>film.id),['film:ronin']);
 const savedPublished=context.PublishedEpg;
 let reads=0;
 context.PublishedEpg={...savedPublished,async readDocumentAt(...args){const document=await savedPublished.readDocumentAt(...args);if(++reads===1)httpDb.sql('UPDATE published_epg_authority SET generation=generation+1');return document;}};
 let mixed;
 try{mixed=await context.worker.fetch(new Request('http://127.0.0.1/api/programme'),httpEnv,{waitUntil(){}});}
 finally{context.PublishedEpg=savedPublished;}
 assert.equal(mixed.status,409);
 const mixedBody=await mixed.json();
 assert.equal(mixedBody.error,'published_epg_fence');
 assert.equal(mixedBody.retry,true);
 assert.equal(mixedBody.films,undefined);
 const result=await context.resolveDiscoveryBatch(env,body,1);
 assert.equal(result.stage==='programme_changed',false,JSON.stringify(result));
 assert.equal(result.checked,1);
 const stored=await readDocument(db,run,'programme');
 assert.equal(stored.films[0].shows.length,1);
 const stolen=arm(open());
 await publishGeneration({DB:stolen},{programmeRunId:run,phase:'published',expectedProgrammeRunId:null,programme:body,watchlist:list},{now:0});
 const stolenEnv={...env,DB:stolen,BUCKET:env.BUCKET};
 const wrapped={...PublishedEpg,async patchProgramme(target,programmeRunId,programme,options){target.DB.sql('UPDATE published_epg_authority SET generation=generation+1');return PublishedEpg.patchProgramme(target,programmeRunId,programme,options);}};
 records.set('epg/discovery-resolution.json',{});
 records.set('epg/discovery-status.json',{retryAt:null});
 records.set('epg/discovered-films.json',{});
 context.PublishedEpg=wrapped;
 const changed=await context.resolveDiscoveryBatch(stolenEnv,body,1);
 assert.equal(changed.stage,'programme_changed');
 assert.equal((await readDocument(stolen,run,'programme')).films[0].shows.length,0);
}

console.log('published EPG authority: marker, fence, lease, resume, empty shows, withheld, ordering, mirror and enrichment pin passed');
