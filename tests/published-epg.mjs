// ADR 0078. D1 owns the published generation only after its own marker is d1.
// Counts and ids below are fixtures. Nothing here calls Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as PublishedEpg from '../src/published-epg.js';
import {CHUNK_BYTES,CHUNK_STATEMENTS,CLAIM_TTL_MS,MAX_STATEMENT_BYTES,activatePublished,currentGeneration,generationObjectKey,importPublished,patchProgramme,programmeShows,publishGeneration,readAuthority,readDocument,readMembers,readShows,repairMirrors,revertPublished,saveWatchlist,writeMirrors} from '../src/published-epg.js';
import {DEFAULT_CHUNK_BYTES,DEFAULT_CHUNK_STATEMENTS,MAX_ROW_STATEMENT_BYTES} from '../src/generation-stage.js';
import {generationProjection} from '../src/epg-repository.js';
import {readAuthority as readCache} from '../src/metadata-cache.js';
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
function open(stopAt=names.length,{onBatch=null}={}){
 const file=path.join(root,'epg-'+(databases++)+'.sqlite');
 const db=d1Standin(file,{onBatch});
 for(const name of names.slice(0,stopAt))db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
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
}

{
 const db=open();
 assert.equal((await readAuthority(db)).mode,'r2');
 assert.equal((await readAuthority(db)).version,8);
 assert.equal(await currentGeneration({DB:db}),null);
 assert.equal((await readCache(db)).mode,'r2');
 assert.equal((await readCache(db)).version,8);
 db.sql("UPDATE metadata_cache_authority SET mode='d1'");
 assert.equal((await readCache(db)).mode,'d1','a later contract version keeps the metadata marker');
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
 const pointer=await repaired.get('epg/published-generation.json');
 await activatePublished({DB:db,BUCKET:repaired},{confirm:'activate',pointerEtag:pointer.etag}).catch(()=>{});
 db.sql("UPDATE published_epg_authority SET mode='r2'");
 const imported=await importPublished({DB:db},{confirm:'load',programme:body,watchlist:list,programmeRunId:'run-m',pointerEtag:pointer.etag,watchlistEtag:'watch'});
 assert.equal(imported.mode,'r2');
 const active=await activatePublished({DB:db,BUCKET:repaired},{confirm:'activate',pointerEtag:pointer.etag});
 assert.equal(active.mode,'d1');
 const back=await revertPublished({DB:db,BUCKET:repaired},{confirm:'r2'});
 assert.equal(back.mode,'r2');
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
 assert.equal(seen.includes('programme.json'),false);
}

console.log('published EPG authority: marker, fence, lease, resume, empty shows, withheld, ordering, mirror and enrichment pin passed');
