import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import * as PublishedEpg from '../src/published-epg.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const now=Date.parse('2026-11-16T12:00:00Z');
const SCAN='2026-11-16T10:00:00.000Z';
const DONE='2026-11-16T11:00:00.000Z';
const RUN='policy-proj-run';
const show={channelId:'c',channel:'C',start:now,end:now+3600000,basis:'title_year',matchReason:'title_year'};
const film=(id,tmdbId,title,genres,extra={})=>({id,tmdbId:String(tmdbId),title,original:title,year:2020,genres,actors:[],directors:[],shows:[show],...extra});
const fiction=film('wl-drama',11,'Dune',['Drama','Science Fiction'],{synopsis:'A fiction epic.'});
const documentary=film('wl-doc',99,'Planet Earth',['Documentary'],{synopsis:'A nature documentary series.'});
const concert=film('wl-concert',10402,'Queen Live at Wembley',['Music'],{synopsis:'Filmed live at Wembley Stadium.'});
const ambiguous=film('wl-live',22,'Live',['Music'],{synopsis:'A studio recording.'});
const catalogDoc={id:'tmdb_777',tmdbId:'777',canonicalIdentity:'tmdb:777',title:'Earth Doc',original:'Earth Doc',year:2018,genres:['Documentary'],actors:[],directors:[],aliases:[]};
const catalogFiction={id:'tmdb_888',tmdbId:'888',canonicalIdentity:'tmdb:888',title:'Catalog Drama',original:'Catalog Drama',year:2019,genres:['Drama'],actors:[],directors:[],aliases:[]};
const catalogEntry=(tmdb)=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,shows:[{...show,basis:'discovery'}]});

function workerContext(extra={}){
 const context=vm.createContext({Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,structuredClone,...extra});
 for(const file of ['src/domain/film-person.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/discovery.js','src/worker.js']){
  vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
 }
 return context;
}

const members=[fiction,documentary,concert,ambiguous];
const stats={epgStart:now-72*3600000,epgEnd:now+24*3600000,channels:1,scanned:1,uniqueFilms:4,titleMissing:0,titleProvisional:0,metadataMissing:0};
function programmeDoc(){
 return {runId:RUN,updatedAt:SCAN,watchlistUpdatedAt:SCAN,watchlistCount:4,films:members.map(item=>structuredClone(item)),stats,catalogFilms:[catalogEntry(777),catalogEntry(888)]};
}
function watchlistDoc(){
 return {updatedAt:SCAN,films:members.map(item=>({...structuredClone(item),shows:undefined}))};
}

{
 const records=new Map();
 records.set('programme.json',programmeDoc());
 records.set('watchlist.json',watchlistDoc());
 records.set('titles.json',{});
 records.set('sync.json',{runId:RUN,stage:'complete',startedAt:SCAN,updatedAt:DONE,completedAt:DONE});
 records.set('epg/generations/'+RUN+'/discovered-films.json',{tmdb_777:catalogDoc,tmdb_888:catalogFiction});
 const puts=[];
 const env={BUCKET:{
  async get(key){return records.has(key)?{etag:'test',json:async()=>structuredClone(records.get(key))}:null;},
  async put(key,value){puts.push(key);records.set(key,JSON.parse(value));return {etag:'test'};},
  async list(){return {objects:[],truncated:false};}
 }};
 const context=workerContext();
 const programme=await context.worker.fetch(new Request('https://site.example/api/programme'),env);
 assert.equal(programme.status,200);
 const body=await programme.json();
 assert.deepEqual(body.films.map(item=>item.id).sort(),['wl-drama','wl-live'],'proven documentary and concert leave the interesting programme');
 assert.ok(body.films.some(item=>item.id==='wl-drama'));
 assert.ok(body.films.some(item=>item.id==='wl-live'),'Music-only Live token stays');
 assert.deepEqual(body.catalogFilms.map(item=>item.id),['tmdb_888']);
 assert.deepEqual(body.catalogPart,{state:'ok',entries:2,presented:1,unpresented:1});
 const watchlist=await context.worker.fetch(new Request('https://site.example/api/watchlist'),env);
 assert.equal(watchlist.status,200);
 const listed=await watchlist.json();
 assert.deepEqual(listed.films.map(item=>item.id).sort(),['wl-concert','wl-doc','wl-drama','wl-live'],'GET /api/watchlist is unchanged');
 assert.deepEqual(records.get('programme.json').films.map(item=>item.id).sort(),['wl-concert','wl-doc','wl-drama','wl-live'],'sealed programme is unchanged');
 assert.deepEqual(records.get('watchlist.json').films.map(item=>item.id).sort(),['wl-concert','wl-doc','wl-drama','wl-live']);
 assert.deepEqual(puts,[],'GET writes no R2 object');
}

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-programme-policy-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
const file=path.join(root,'a.sqlite');
const migrated=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
if(migrated.status!==0)throw new Error(migrated.stderr||'migration failed');
const sql=(text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
const db=d1Standin(file);
const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
const taken=await Authority.acquireLease(env,{programmeRunId:null});
env.discoveryLease=taken.lease;
const programme=programmeDoc();
const watchlist=watchlistDoc();
sql(`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-16T11:00:00Z','x','2026-11-16T11:00:00Z')`);
for(const [kind,body] of [['programme',programme],['watchlist',watchlist]]){
 sql(`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','${kind}',0,'wl-drama')`);
 sql(`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','${kind}',0,'${JSON.stringify(body).replace(/'/g,"''")}')`);
}
sql(`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
await Authority.upsertAdmissions(env,{tmdb_777:catalogDoc,tmdb_888:catalogFiction},{lease:env.discoveryLease});
sql(`UPDATE discovery_authority SET programme_run_id='${RUN}'`);
const before=sql('SELECT generation FROM published_epg_authority');
const admissions=sql('SELECT film_id, state FROM discovery_admission ORDER BY film_id');
const context=workerContext({PublishedEpg,DiscoveryAuthority:Authority});
const answer=await context.worker.fetch(new Request('http://127.0.0.1/api/programme'),{DB:db,BUCKET:new MemoryBucket()},{waitUntil(){}});
assert.equal(answer.status,200,JSON.stringify(await answer.clone().json()).slice(0,400));
const body=await answer.json();
assert.deepEqual(body.films.map(item=>item.id).sort(),['wl-drama','wl-live']);
assert.deepEqual(body.catalogFilms.map(item=>item.id),['tmdb_888']);
assert.deepEqual(body.catalogPart,{state:'ok',entries:2,presented:1,unpresented:1});
const listed=await context.worker.fetch(new Request('http://127.0.0.1/api/watchlist'),{DB:db,BUCKET:new MemoryBucket()},{waitUntil(){}});
assert.equal(listed.status,200);
assert.deepEqual((await listed.json()).films.map(item=>item.id).sort(),['wl-concert','wl-doc','wl-drama','wl-live']);
assert.deepEqual(sql('SELECT generation FROM published_epg_authority'),before);
assert.deepEqual(sql('SELECT film_id, state FROM discovery_admission ORDER BY film_id'),admissions);
const sealed=JSON.parse(sql("SELECT payload_json FROM published_epg_document WHERE kind='programme'")[0].payload_json);
assert.deepEqual(sealed.films.map(item=>item.id).sort(),['wl-concert','wl-doc','wl-drama','wl-live']);
console.log('programme policy projection: watchlist documentary and concert withheld; fiction and ambiguous Music-only stay; catalog overlay withheld; sealed documents and D1 rows unchanged');
