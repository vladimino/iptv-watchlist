// AIR-389 production incident: GET /api/enrichment/footer/status answered 502 `{"error":"discovery_incomplete"}` (32 bytes) while the Discovery transfer was
// `loading`, and the same GET ran PublishedEpg.repairMirrors (an R2 write, twice in parallel) when a D1 generation was published. The footer must stay readable
// when a source is closed, failing or silent, must never write, and must show unknown values as null. A real D1-published generation (migrations applied, sqlite
// D1 stand-in) is used; nothing here calls Cloudflare, TMDB or production.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as PublishedEpgModule from '../src/published-epg.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-footer-resilience-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).map(name=>name.slice(0,-4)).sort();
const G='22222222-2222-4222-8222-222222222222',now=Date.now(),hour=3600000;
let databases=0;
const mkdb=()=>{
 const seen=[];const db=d1Standin(path.join(root,'f'+(databases++)+'.sqlite'),{onQuery:async text=>{seen.push(text);}});
 for(const migration of names)db.sql(fs.readFileSync('migrations/'+migration+'.sql','utf8'));
 db.sql("UPDATE published_epg_authority SET mode='d1' WHERE id=1");
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 return {db,seen};
};
async function published(db){
 const mem=new Map(),bucket={async get(k){return mem.has(k)?{etag:'e',json:async()=>structuredClone(mem.get(k))}:null;},async put(k,v){mem.set(k,JSON.parse(v));return {etag:'e'};},async list(){return {objects:[],truncated:false};}};
 const film={id:'lid-w',tmdbId:'42',title:'Watch',original:'Watch',year:2020,genres:[],actors:[],directors:[],shows:[]};
 const r=await PublishedEpgModule.publishGeneration({DB:db,BUCKET:bucket},{programmeRunId:G,phase:'published',expectedProgrammeRunId:null,programme:{runId:G,updatedAt:new Date(now).toISOString(),watchlistCount:1,films:[film]},watchlist:{updatedAt:new Date(now).toISOString(),films:[film]}},{now});
 assert.equal(r.pointed,true,'a real D1-published generation');
}
const logs=[];
function worldFor(){
 const world=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},
  console:{error:(...args)=>logs.push(args.join(' ')),log(){},warn(){}},fetch:async input=>{fetches.push(String(input instanceof Request?input.url:input));return new Response('unexpected',{status:599});}});
 vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),world);
 vm.runInContext(scoped('src/published-epg.js','PublishedEpg'),world);vm.runInContext(scoped('src/discovery-authority.js','DiscoveryAuthority'),world);
 for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),world);
 return world;
}
const fetches=[];
const profile={version:7,updatedAt:'2026-10-12T18:00:00Z',profileHash:'p',profile:{}};
// A bucket whose compatibility mirrors are missing (or stale) and that fails the test on any write. `faulty` keys throw, `silent` keys never answer.
function bucketFor({mirrors='missing',faulty=[],silent=[]}={}){
 const mem=new Map([['enrichment/profile/current.json',profile],['enrichment/view-index.json',{}],['metadata.json',{}]]);
 if(mirrors==='stale'){mem.set('epg/published-generation.json',{phase:'published',programmeRunId:'11111111-1111-4111-8111-aaaaaaaaaaaa'});mem.set('programme.json',{runId:'old',films:[]});}
 const writes=[];
 return {writes,bucket:{
  async get(key){if(faulty.includes(key))throw new Error('r2 fault '+key);if(silent.includes(key))return new Promise(()=>{});return mem.has(key)?{etag:'e',json:async()=>structuredClone(mem.get(key))}:null;},
  async put(key){writes.push('put:'+key);throw new Error('R2 write in a GET: '+key);},async delete(key){writes.push('delete:'+key);throw new Error('R2 delete in a GET: '+key);},
  async list(){return {objects:[],truncated:false};},async head(key){return mem.has(key)?{etag:'e'}:null;}}};
}
const footer=async(world,env)=>{const response=await world.worker.fetch(new Request('https://iptv.example/api/enrichment/footer/status'),env,{waitUntil(){}});const text=await response.text();return {status:response.status,length:text.length,body:JSON.parse(text)};};
const LEGACY=['schemaVersion','generatedAt','profile','coverage','predictions','epgTmdb','watchlist','lastRun','integrations'];

const {db,seen}=mkdb();
await published(db);
const world=worldFor();

// ---- 1. The normal state: no write of any kind, from either source of mirrors ----
for(const mirrors of ['missing','stale']){
 const {bucket,writes}=bucketFor({mirrors});
 const before={batches:db.calls.batches,statements:db.calls.statements};seen.length=0;fetches.length=0;
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,mirrors+' mirrors: '+JSON.stringify(r.body));
 for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),'legacy field kept: '+key);
 assert.deepEqual(writes,[],mirrors+' mirrors: no R2 put or delete in a GET (no repairMirrors, not twice in parallel)');
 assert.equal(db.calls.batches,before.batches,'no D1 batch');assert.equal(db.calls.statements,before.statements,'no D1 statement written');
 assert.ok(seen.length>0&&seen.every(text=>/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)),'only reads reached D1: '+seen.filter(text=>!/^\s*(SELECT|PRAGMA|WITH)\b/i.test(text)).join(' | '));
 assert.deepEqual(fetches,[],'no provider request');
 assert.equal(Object.hasOwn(r.body,'degraded'),false,'a healthy footer names no degraded source');
 assert.equal(r.body.watchlist.films,1,'the programme and the watchlist are read from the D1 generation');
}

// ---- 2. The incident: the Discovery transfer is loading (a ledger seal, then with a pending admission) ----
const admission=(state)=>db.sql(`INSERT INTO discovery_admission (film_id, tmdb_id, media_kind, canonical_identity, generation, state, payload_json) VALUES ('tmdb_9','9','movie','tmdb:9',1,'${state}','{"id":"tmdb_9","tmdbId":"9","canonicalIdentity":"tmdb:9"}')`);
for(const variant of ['ledger seal','pending admission','held cutover']){ // the first two are the incident
 if(variant==='ledger seal')db.sql("UPDATE discovery_transfer SET state='loading' WHERE id=1");
 if(variant==='pending admission')admission('pending');
 if(variant==='held cutover'){db.sql("DELETE FROM discovery_admission");db.sql("UPDATE discovery_transfer SET state='idle' WHERE id=1");db.sql("UPDATE discovery_authority SET cutover='held' WHERE id=1");}
 const {bucket,writes}=bucketFor();
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,variant+': the footer stays readable instead of the generic 502 '+JSON.stringify(r.body).slice(0,120));
 assert.notEqual(r.length,32,variant+': not the 32-byte {"error":"discovery_incomplete"} of the incident');
 if(variant==='held cutover'){for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),variant+': legacy field kept: '+key);assert.deepEqual(writes,[],variant+': no write');continue;} // routeRead serves the compatibility copy while a cutover is held, as before
 assert.ok(Array.isArray(r.body.degraded)&&r.body.degraded.includes('ledger'),variant+': the closed ledger is named: '+JSON.stringify(r.body.degraded));
 for(const key of LEGACY)assert.ok(Object.hasOwn(r.body,key),variant+': legacy field kept: '+key);
 // What needs the closed sources is unknown (null), never 0 or 100%.
 assert.deepEqual([r.body.epgTmdb.recognizedFilms,r.body.epgTmdb.pendingRecognition,r.body.epgTmdb.historicalUnresolved,r.body.epgTmdb.ledgerTotal],[null,null,null,null],variant+': ledger counts are unknown');
 if(r.body.degraded.includes('catalog')){
  assert.deepEqual(Object.values(r.body.coverage),Array(Object.keys(r.body.coverage).length).fill(null),variant+': coverage is unknown without the catalog');
  assert.equal(r.body.collection.state,'unknown',variant+': the collection is unknown without the catalog');assert.equal(r.body.recommendations.newUnseen.state,'unknown');
 }
 assert.deepEqual(writes,[],variant+': still no write');
 assert.equal(r.body.integrations.sources.find(source=>source.id==='resolver')?.state,'unknown',variant+': the resolver is unknown, not healthy and not an error');
}
db.sql("UPDATE discovery_authority SET cutover='open' WHERE id=1");

// ---- 3. A failing or silent optional source never takes the footer down ----
for(const key of ['enrichment/profile/current.json','enrichment/view-index.json','metadata.json','sync.json','enrichment/latest-run.json','enrichment/prediction-queue.json','watchlist-ingest.json']){
 const {bucket,writes}=bucketFor({faulty:[key]});
 const r=await footer(world,{DB:db,BUCKET:bucket});
 assert.equal(r.status,200,'a failing '+key+' does not fail the footer');
 assert.ok(Array.isArray(r.body.degraded)&&r.body.degraded.length>0,key+' is named as degraded: '+JSON.stringify(r.body.degraded));
 for(const field of LEGACY)assert.ok(Object.hasOwn(r.body,field),key+': legacy field kept: '+field);
 assert.deepEqual(writes,[]);
}
// The metadata cache is what links identities: without it the new blocks are unknown, never "ok".
{const {bucket}=bucketFor({faulty:['metadata.json']});const r=await footer(world,{DB:db,BUCKET:bucket});assert.equal(r.body.collection.state,'unknown');assert.equal(r.body.recommendations.newUnseen.state,'unknown');}
// A source that never answers is cut off at the limit, and the footer answers.
{
 const {bucket}=bucketFor({silent:['sync.json','enrichment/latest-run.json']});
 const started=Date.now(),r=await footer(world,{DB:db,BUCKET:bucket,FOOTER_SOURCE_TIMEOUT_MS:60});const took=Date.now()-started;
 assert.equal(r.status,200,'a silent source does not hang the footer');assert.ok(took<3000,'bounded wait: '+took+' ms');
 assert.ok(r.body.degraded.includes('sync')&&r.body.degraded.includes('run'),'the silent sources are named: '+JSON.stringify(r.body.degraded));
}

// ---- 4. The cause of any other unhandled route error is now in the log (its code and message, nothing else) ----
{
 logs.length=0;
 const exploding={async get(){throw new Error('storage exploded');},async put(){},async list(){return {objects:[],truncated:false};}}; // no D1 binding: the published EPG read refuses with its own code
 const response=await world.worker.fetch(new Request('https://iptv.example/api/watchlist',{headers:{cookie:'secret=1',authorization:'Bearer secret-token'}}),{BUCKET:exploding},{waitUntil(){}});
 assert.equal(response.status,502);
 assert.equal(logs.length,1,'one structured line');
 const line=JSON.parse(logs[0]);
 assert.deepEqual(Object.keys(line).sort(),['code','event','message','method','path']);
 assert.deepEqual([line.event,line.method,line.path,line.code,line.message],['route_error','GET','/api/watchlist','published_epg_unavailable','published_epg_unavailable'],'the code and the message of the real cause');
 assert.doesNotMatch(logs[0],/secret|cookie|authorization/i,'no header or credential in the log');
}
console.log('Footer resilience: a real D1-published generation never writes on a footer GET (missing or stale mirrors), a loading, pending or held Discovery transfer no longer turns the footer into a 502 and leaves ledger-dependent values unknown, failing and silent sources are named and bounded, and an unhandled route error leaves a structured log line passed');
