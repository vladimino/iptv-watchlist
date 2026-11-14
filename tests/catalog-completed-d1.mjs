import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as Authority from '../src/discovery-authority.js';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as PublishedEpg from '../src/published-epg.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-catalog-completed-d1-'));
const chain=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority','0009_owner_review_authority','0010_ratings_authority','0011_discovery_authority'];
let databases=0;
const migrated=()=>{
 const file=path.join(root,'a-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name+'.sql','utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 return file;
};
const sql=(file,text)=>{const result=sqliteSync(['-json','-bail',file],{input:text+';',encoding:'utf8',maxBuffer:1<<28});if(result.status!==0)throw new Error(result.stderr);const out=result.stdout.trim();return out?JSON.parse(out):[];};
const RUN='run-finds',MIN=60000,H=3600000,NOW=Date.now(),START=NOW+H;
const obs=(key,hours)=>({key,title:'Film '+key,normalizedTitle:'film '+key,year:2001,durations:[90],confirmedTmdbId:null,shows:[{channelId:'c',channel:'Channel c',start:START+hours*H,end:START+hours*H+90*MIN}],seenInLatestSnapshot:true,lastAiring:START+hours*H});
const decision=(item,tmdb,extra={})=>({status:'verified',filmId:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,identitySource:'known_epg_alias',anchor:[90],evidenceKey:Authority.evidenceKey(item),...extra});
const staleShow={channelId:'z',channel:'Z',start:START+9*H,end:START+10*H};
const record=tmdb=>({id:'tmdb_'+tmdb,tmdbId:String(tmdb),canonicalIdentity:'tmdb:'+tmdb,title:'Catalog '+tmdb,original:'Catalog '+tmdb,year:2001,runtime:90,genres:[],actors:[],directors:[],aliases:[],shows:[staleShow],showsProgrammeRunId:RUN});

async function world(){
 const file=migrated();
 sql(file,"UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 const db=d1Standin(file);
 const env={DB:db,BUCKET:new MemoryBucket(),discoveryLease:null};
 const taken=await Authority.acquireLease(env,{programmeRunId:null});
 env.discoveryLease=taken.lease;
 const items=[obs('a',1),obs('m',2)];
 await Authority.ingestLedger(env,{programmeRunId:RUN,handoff:true,lease:taken.lease,items:(async function*(){for(const item of items)yield item;})()});
 const member={id:'member-1',tmdbId:'101',title:'Member',original:'Member',year:2000,runtime:90,genres:[],actors:[],directors:[],shows:[{channelId:'m',channel:'M',start:START+5*H,end:START+6*H,basis:'title_year'}]};
 const programme={runId:RUN,updatedAt:'2026-11-15T10:00:00.000Z',watchlistCount:1,films:[member]};
 const watchlist={updatedAt:'2026-11-15T10:00:00.000Z',films:[{...member,shows:undefined}]};
 sql(file,`INSERT INTO published_epg_generation (programme_run_id, phase, published_at, payload_sha256, created_at) VALUES ('${RUN}','published','2026-11-15T10:00:00Z','x','2026-11-15T10:00:00Z')`);
 for(const [kind,body] of [['programme',programme],['watchlist',watchlist]]){
  sql(file,`INSERT INTO published_epg_member (programme_run_id, kind, ordinal, film_id) VALUES ('${RUN}','${kind}',0,'member-1')`);
  sql(file,`INSERT INTO published_epg_document (programme_run_id, kind, ordinal, payload_json) VALUES ('${RUN}','${kind}',0,'${JSON.stringify(body).replace(/'/g,"''")}')`);
 }
 sql(file,`UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='${RUN}', generation=7`);
 await Authority.upsertAdmissions(env,{tmdb_555:record(555),tmdb_556:record(556)},{lease:env.discoveryLease});
 return {file,db,env,items};
}
const assign=async(env,item,next,previous=null)=>{await Authority.writeDecisionDelta(env,{[item.key]:{previous,next}});return Authority.assignObservationSlots(env,{observationKey:item.key});};

const context=vm.createContext({PublishedEpg,DiscoveryAuthority:Authority,Response,Request,URL,URLSearchParams,AbortSignal,Date,Map,Set,JSON,TextEncoder,Uint8Array,crypto:webcrypto,console,setTimeout,structuredClone});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),context);
for(const file of ['src/domain/film-person.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-versions.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/prediction-diagnostics.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const plain=value=>JSON.parse(JSON.stringify(value));
const facet={prediction:{predictedRating:4,probability4Plus:.5,fingerprintHash:'h'},fingerprint:{fingerprintHash:'h',plotMechanics:[],execution:{}},fingerprintHash:'h'};

// What the routes read, from the real modules: the completed programme and the current catalog records.
async function reads(db,{authority='d1'}={}){
 const env={DB:db,BUCKET:new MemoryBucket()};
 const programme=await PublishedEpg.readDocumentAt(env,RUN,'programme',7);
 const catalog=await Authority.routeRead(env,'epg/generations/'+RUN+'/discovered-films.json');
 return {programme:plain(programme),catalog:plain(catalog.value),authority};
}
vm.runInContext('globalThis.now='+NOW,context);
const finds=({programme,catalog},completedOnly=true)=>{
 const input={catalog,programme,watchlist:{films:[{id:'member-1',tmdbId:'101'}]},index:Object.fromEntries(Object.keys(catalog).map(id=>[id,facet])),profile:{version:1},metadata:{},programmeRunId:RUN,pinned:true,completedOnly,now:NOW,titleExclusion:{state:'unavailable'}};
 return plain(vm.runInContext('(()=>{const input=Object.assign({},'+JSON.stringify(input)+');input.freshness={indexed:()=>true};return catalogAvailable(input).films.map(film=>[film.id,film.shows.map(show=>show.start)]);})()',context));
};
const page=async(db,tmdb)=>{
 const response=await context.worker.fetch(new Request('http://127.0.0.1/api/catalog/film/'+tmdb),{DB:db,BUCKET:new MemoryBucket()},{waitUntil(){}});
 return {status:response.status,body:await response.json()};
};
const starts=film=>(film?.shows||[]).map(show=>show.start);

// (a) a scan-confirmed catalog observation: no row yet, so no showing (the legacy record shows are not a source); the replay assigns it and both readers show it.
{
 const {db,env,items}=await world();
 let read=await reads(db);
 assert.deepEqual(finds(read),[],'no assigned row: no catalog showing, even though the record carries same-run shows');
 const before=await page(db,'555');
 assert.equal(before.status,200,JSON.stringify(before.body).slice(0,300));
 assert.deepEqual(starts(before.body.film),[],'the film page shows zero showings and still answers 200 for a verified Film');
 assert.equal(before.body.film.tmdbId,'555');
 await assign(env,items[0],decision(items[0],'555'));
 read=await reads(db);
 assert.deepEqual(finds(read).map(item=>item[0]),['tmdb_555']);
 assert.deepEqual(finds(read)[0][1],[START+H],'exactly the assigned slot');
 assert.deepEqual(starts((await page(db,'555')).body.film),[START+H],'the film page agrees with Finds');
}

// (b) a correction moves the slot from A to B: A no longer shows its old slot although its record still has a same-run shows entry.
{
 const {db,env,items}=await world();
 const first=decision(items[0],'555');
 await assign(env,items[0],first);
 assert.deepEqual(finds(await reads(db)).map(item=>item[0]),['tmdb_555']);
 const moved=decision(items[0],'556');
 await assign(env,items[0],moved,first);
 const read=await reads(db);
 assert.deepEqual(finds(read).map(item=>item[0]),['tmdb_556'],'the slot is B, never A and B');
 assert.deepEqual(starts((await page(db,'555')).body.film),[],'A shows no stale slot on the film page');
 assert.deepEqual(starts((await page(db,'556')).body.film),[START+H]);
 await assign(env,items[0],{...moved,status:'rejected'},moved);
 assert.deepEqual(finds(await reads(db)),[],'a rejection leaves zero showings');
 assert.deepEqual(starts((await page(db,'556')).body.film),[]);
}

// (d) a member Film's showings are the sealed shows plus its assigned rows (the completed programme), and a member is never offered by Finds.
{
 const {db,env,items}=await world();
 await assign(env,items[1],decision(items[1],'101',{filmId:'member-1',canonicalIdentity:'tmdb:101'}));
 const read=await reads(db);
 const member=read.programme.films.find(film=>film.id==='member-1');
 assert.deepEqual(member.shows.map(show=>show.start),[START+2*H,START+5*H],'sealed show and the assigned slot');
 assert.deepEqual(finds(read),[]);
}

// (e) R2 authority keeps the record shows; a D1 completed programme that cannot be read fails closed.
{
 const {db}=await world();
 const read=await reads(db);
 assert.deepEqual(finds(read,false).map(item=>item[0]).sort(),['tmdb_555','tmdb_556'],'outside D1 the record shows are used as before');
 const response=await context.worker.fetch(new Request('http://127.0.0.1/api/catalog/available'),{DB:d1Standin(path.join(root,'missing-'+(databases++)+'.sqlite')),BUCKET:new MemoryBucket()},{waitUntil(){}});
 assert.notEqual(response.status,200,'an unreadable D1 programme never offers legacy showings');
}
console.log('catalog completed read, D1 route level ok');
