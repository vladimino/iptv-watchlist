// AIR-480 stage 4 (ADR 0142 decisions 11 and 12): the completed read, the mirrors and the revert guard. Local sqlite stand-ins only; nothing calls Cloudflare.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as PublishedEpg from '../src/published-epg.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const H=3600000;
const sealed={runId:'run-c',updatedAt:'2026-11-15T10:00:00.000Z',films:[
 {id:'member-1',tmdbId:'101',title:'Member',shows:[{channelId:'b',channel:'B',start:5*H,end:6*H,epgTitle:'Member',basis:'title_year',matchReason:null}],availableUntil:new Date(5*H+72*H).toISOString()},
 {id:'member-2',tmdbId:'102',title:'Other',shows:[]},
]};
const assigned=[
 {film_id:'member-1',channel_id:'a',channel:'A',start_ms:2*H,end_ms:3*H,match_reason:'obs-1'},
 {film_id:'member-1',channel_id:'b',channel:'B',start_ms:5*H,end_ms:6*H,match_reason:'obs-1'},
 {film_id:'tmdb_777',channel_id:'c',channel:'C',start_ms:4*H,end_ms:5*H,match_reason:'obs-2'},
 {film_id:'tmdb_777',channel_id:'a',channel:'A',start_ms:1*H,end_ms:2*H,match_reason:'obs-2'},
];
assert.equal(PublishedEpg.completeProgramme(sealed,[]),sealed,'no assigned row: the completed programme is the sealed document itself');
const completed=PublishedEpg.completeProgramme(sealed,assigned);
assert.deepEqual(completed.films[0].shows.map(show=>[show.channelId,show.start]),[['a',2*H],['b',5*H]],'shows sorted by start, an address already in the sealed part is not doubled');
assert.equal(completed.films[0].shows[1].basis,'title_year','the sealed show wins its address');
assert.equal(completed.films[0].availableUntil,new Date(5*H+72*H).toISOString(),'availableUntil is recomputed from the latest start');
assert.equal(completed.films[1],sealed.films[1],'a member without assigned rows is untouched');
assert.deepEqual(completed.catalogFilms.map(film=>[film.id,film.tmdbId,film.canonicalIdentity,film.shows.length]),[['tmdb_777','777','tmdb:777',2]],'catalog Films carry identity and shows only');
assert.deepEqual(Object.keys(completed.catalogFilms[0]).sort(),['canonicalIdentity','id','shows','tmdbId']);
assert.equal(sealed.films[0].shows.length,1,'the sealed document is not mutated');

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-completed-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
async function world(){
 const file=path.join(root,'c-'+(databases++)+'.sqlite');
 const made=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(made.status!==0)throw new Error(made.stderr);
 const watchlist={updatedAt:sealed.updatedAt,films:[{id:'member-1',tmdbId:'101'},{id:'member-2',tmdbId:'102'}]};
 const programmeText=JSON.stringify(sealed).replace(/'/g,"''"),watchText=JSON.stringify(watchlist);
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('run-c','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 sql(file,"INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('run-c','programme',0,'member-1'),('run-c','programme',1,'member-2'),('run-c','watchlist',0,'member-1'),('run-c','watchlist',1,'member-2')");
 sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('run-c','programme',0,'${programmeText}'),('run-c','watchlist',0,'${watchText}')`);
 sql(file,"INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-c','member-1','b',18000000,21600000,'B','Member','title_year',NULL)");
 sql(file,"UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='run-c', generation=7, watchlist_generation=7");
 const db=d1Standin(file),bucket=new MemoryBucket();
 return {file,env:{DB:db,BUCKET:bucket}};
}
const assignRow=(file,film,channel,start,key='obs-1')=>sql(file,`INSERT INTO published_epg_show (programme_run_id, film_id, channel_id, start_ms, end_ms, channel, epg_title, basis, match_reason) VALUES ('run-c','${film}','${channel}',${start},${start+H},'${channel.toUpperCase()}',NULL,'discovery','${key}')`);

// The sealed read stays the stored document; the completed read and readDocumentAt add the assigned rows from the same published tables.
{
 const {file,env}=await world();
 assignRow(file,'member-1','a',2*H);assignRow(file,'tmdb_777','c',4*H,'obs-2');
 const sealedRead=await PublishedEpg.readDocument(env,'run-c','programme');
 assert.equal(sealedRead.films[0].shows.length,1);assert.equal(sealedRead.catalogFilms,undefined);
 const read=await PublishedEpg.readCompletedProgramme(env,'run-c');
 assert.equal(read.films[0].shows.length,2);assert.equal(read.catalogFilms.length,1);
 const at=await PublishedEpg.readDocumentAt(env,'run-c','programme',7);
 assert.deepEqual(at,read,'readDocumentAt of the programme is the completed read');
 const watch=await PublishedEpg.readDocumentAt(env,'run-c','watchlist',7);
 assert.deepEqual(watch.films.map(film=>film.id),['member-1','member-2'],'the watchlist document never gains a catalog Film');
 const snapshot=await PublishedEpg.authoritativeSnapshot(env);
 assert.deepEqual(snapshot.programme,read,'the projector snapshot is the completed programme');
 assert.equal(sql(file,'SELECT generation FROM published_epg_authority')[0].generation,7,'assigned rows never move the published generation');
 assert.equal(sql(file,"SELECT COUNT(*) AS n FROM published_epg_member WHERE kind='programme'")[0].n,2,'a catalog Film is not a member');
}

// The mirrors hold the completed programme; the hourly repair rewrites them when an assignment lands, and is idempotent afterwards.
{
 const {file,env}=await world();
 assert.equal((await PublishedEpg.repairMirrors(env)).mirrored,true);
 const before=JSON.parse(await (await env.BUCKET.get('programme.json')).text());
 assert.equal(before.catalogFilms,undefined);
 assignRow(file,'member-1','a',2*H);assignRow(file,'tmdb_777','c',4*H,'obs-2');
 const repaired=await PublishedEpg.repairMirrors(env);
 assert.equal(repaired.wrote,true,'an assignment after the mirror write is picked up');
 const after=JSON.parse(await (await env.BUCKET.get('programme.json')).text());
 assert.equal(after.films[0].shows.length,2);assert.equal(after.catalogFilms.length,1);
 const copy=JSON.parse(await (await env.BUCKET.get('epg/generations/run-c/programme.json')).text());
 assert.deepEqual(copy,after);
 assert.equal((await PublishedEpg.repairMirrors(env)).wrote,false,'a second repair writes nothing');
 assert.equal(sql(file,'SELECT generation FROM published_epg_authority')[0].generation,7);
}

// Revert reads the completed programme and fails when a Discovery write lands between its comparison and the flip.
{
 const {file,env}=await world();
 assignRow(file,'member-1','a',2*H);
 let reverted=await PublishedEpg.revertPublished(env,{confirm:'r2'});
 assert.equal(reverted.mode,'r2');
 const mirror=JSON.parse(await (await env.BUCKET.get('programme.json')).text());
 assert.equal(mirror.films[0].shows.length,2,'R2 holds exactly what readers saw');
 sql(file,"UPDATE published_epg_authority SET mode='d1'");
 const racing={...env,DB:d1Standin(file,{onBatch:statements=>{if(statements.some(item=>/UPDATE published_epg_authority SET mode='r2'/.test(String(item.sql??item.text??item[0]??item))))sql(file,'UPDATE discovery_authority SET generation=generation+1 WHERE id=1');}})};
 await assert.rejects(()=>PublishedEpg.revertPublished(racing,{confirm:'r2'}),error=>error.code==='published_epg_fence');
 assert.equal(sql(file,'SELECT mode FROM published_epg_authority')[0].mode,'d1','a Discovery write between the comparison and the flip leaves the mode unchanged');
 reverted=await PublishedEpg.revertPublished(env,{confirm:'r2'});
 assert.equal(reverted.mode,'r2','a retry without a concurrent write flips');
}

// The revert guard fails closed: an unreadable or missing Discovery generation aborts before any flip.
{
 const {file,env}=await world();
 sql(file,"UPDATE published_epg_authority SET mode='d1'");
 const broken={...env,DB:d1Standin(file,{onQuery:text=>{if(/FROM discovery_authority/.test(String(text)))throw new Error('D1 read failed');}})};
 await assert.rejects(()=>PublishedEpg.revertPublished(broken,{confirm:'r2'}),error=>error.code==='published_epg_fence');
 assert.equal(sql(file,'SELECT mode FROM published_epg_authority')[0].mode,'d1');
 sql(file,'DELETE FROM discovery_authority');
 await assert.rejects(()=>PublishedEpg.revertPublished(env,{confirm:'r2'}),error=>error.code==='published_epg_fence');
 assert.equal(sql(file,'SELECT mode FROM published_epg_authority')[0].mode,'d1','a missing generation never disables the fence');
}

console.log('published EPG completed read: completion, mirrors and revert guard ok');
