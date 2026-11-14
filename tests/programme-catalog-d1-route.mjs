import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as PublishedEpg from '../src/published-epg.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-programme-catalog-d1-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'a-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-catalog',MIN=60000,H=3600000,START=Date.parse('2026-11-15T12:00:00Z');
const obs=(key,tmdb,hours,minutes)=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[minutes],shows:[{channelId:'c',channel:'Channel c',start:START+hours*H,end:START+hours*H+minutes*MIN}],seenInLatestSnapshot:true,lastAiring:START+hours*H});
const decision=(item,tmdb)=>({status:'verified',filmId:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,identitySource:'tmdb_detail',anchor:[90],evidenceKey:Authority.evidenceKey(item)});
const record=tmdb=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Catalog '+tmdb,original:'Catalog '+tmdb,year:2001,genres:[],actors:[],directors:[],aliases:['Alias '+tmdb],shows:[{start:1}],hotEnteredAt:'stale'});

async function world({superseded=false}={}){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const db=d1Standin(file);
 const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 const items=[obs('a','555',1,90),obs('b','556',3,90)];
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){for(const item of items)yield item;})()});
 const programme={runId:RUN,updatedAt:'2026-11-15T10:00:00.000Z',watchlistCount:1,films:[{id:'member-1',tmdbId:'101',title:'Member',original:'Member',year:2000,genres:[],actors:[],directors:[],shows:[]}]};
 const watchlist={updatedAt:'2026-11-15T10:00:00.000Z',films:[{id:'member-1',tmdbId:'101',title:'Member',original:'Member',year:2000,genres:[],actors:[],directors:[]}]};
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 for(const [kind,body] of [['programme',programme],['watchlist',watchlist]]){
  sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','${kind}',0,'member-1')`);
  sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','${kind}',0,'${JSON.stringify(body)}')`);
 }
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 const films={tmdb_555:record(555)};
 films.tmdb_556=record(556);
 await Authority.upsertAdmissions(env,films,{lease:env.discoveryLease});
 for(const [item,tmdb] of [[items[0],'555'],[items[1],'556']]){
  await Authority.writeDecisionDelta(env,{[item.key]:{previous:null,next:decision(item,tmdb)}});
  await Authority.assignObservationSlots(env,{observationKey:item.key});
 }
 if(superseded)sql(file,"UPDATE discovery_admission SET state='superseded' WHERE film_id='tmdb_556'");
 return {file,db};
}

const context=vm.createContext({PublishedEpg,DiscoveryAuthority:Authority,Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,structuredClone});
for(const file of ['src/domain/film-person.js','src/sources.js','src/discovery.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const programme=async(db)=>{
 const response=await context.worker.fetch(new Request('http://127.0.0.1/api/programme'),{DB:db,BUCKET:new MemoryBucket()},{waitUntil(){}});
 return {status:response.status,body:await response.json()};
};
const plain=value=>JSON.parse(JSON.stringify(value));
const writes=file=>plain(sql(file,'SELECT generation FROM published_epg_authority'));

// 1. The D1 path end to end: completed read plus the current admission records.
{
 const {file,db}=await world();
 const before=writes(file);
 const answer=await programme(db);
 assert.equal(answer.status,200,JSON.stringify(answer.body).slice(0,300));
 assert.deepEqual(answer.body.films.map(film=>film.id),['member-1'],'the member part is the watchlist');
 assert.deepEqual(answer.body.catalogFilms.map(film=>film.title).sort(),['Catalog 555','Catalog 556']);
 const film=answer.body.catalogFilms.find(item=>item.id==='tmdb_555');
 assert.equal(film.shows.length,1);assert.equal(film.shows[0].basis,'discovery');
 assert.equal(film.shows[0].start,START+H,'the showing is the assigned row, not the admission record stale shows');
 assert.equal(film.availableUntil,new Date(START+H+72*H).toISOString());
 assert.equal(film.hotEnteredAt,undefined);assert.equal(film.onWatchlist,false);
 assert.deepEqual(answer.body.catalogPart,{state:'ok',entries:2,presented:2,unpresented:0});
 assert.deepEqual(writes(file),before,'a read moves no generation');
}

// 2. A catalog entry whose admission record is no longer current is counted, not presented.
{
 const {file,db}=await world({superseded:true});
 const answer=await programme(db);
 assert.equal(answer.status,200);
 assert.deepEqual(answer.body.catalogFilms.map(film=>film.id),['tmdb_555']);
 assert.deepEqual(answer.body.catalogPart,{state:'ok',entries:2,presented:1,unpresented:1});
}

// 3. A refusal of the Discovery read: a held marker, a Discovery run that is not the pinned run, an incomplete transfer. Members stay, the catalog part says unavailable.
for(const [name,statement] of [
 ['held',"UPDATE discovery_authority SET cutover='held'"],
 ['other run',"UPDATE discovery_authority SET programme_run_id='another-run'"],
 ['not ready',"UPDATE discovery_authority SET mode='r2'"],
]){
 const {file,db}=await world();
 try{sql(file,statement);}catch(error){throw new Error(name+': '+error.message);}
 const answer=await programme(db);
 assert.equal(answer.status,200,name+' '+JSON.stringify(answer.body).slice(0,200));
 assert.deepEqual(answer.body.films.map(film=>film.id),['member-1'],name+': members intact');
 assert.deepEqual(answer.body.catalogFilms,[],name);
 assert.deepEqual(answer.body.catalogPart,{state:'unavailable',entries:2},name);
}
console.log('programme catalog D1 route ok');
