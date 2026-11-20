// AIR-543 / ADR 0179, review of PR 799. The new cron branch against the AUTHORITATIVE catalog: Discovery in D1 mode `d1`, cutover `open`, real sqlite as the D1 stand-in,
// the actual Worker entry (`worker.scheduled` with the exact cron). Proves positive guarded D1 hydration with no R2 catalog object read or written, a zero-due week
// that takes no lease and asks nobody even while Discovery is busy, a busy lease and an EPG-priority pause that defer and resume, and idempotent recovery from an uncertain D1 write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as Authority from '../src/discovery-authority.js';
import {MemoryBucket} from './memory-bucket.mjs';
import {d1Standin} from './d1-standin.mjs';
import {sqliteSync} from './sqlite-session.mjs';
import {scoped} from '../scripts/bundle-scope.mjs';
import * as W from '../src/catalog-poster-weekly.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-poster-weekly-d1-'));
const chain=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
let databases=0;
const migrated=()=>{
 const file=path.join(root,'weekly-'+(databases++)+'.sqlite');
 const result=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+chain.map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'),encoding:'utf8'});
 if(result.status!==0)throw new Error(result.stderr||'migration failed');
 const db=d1Standin(file);
 db.sql("UPDATE discovery_authority SET mode='d1', cutover='open' WHERE id=1");
 return db;
};
const POSTER='https://image.tmdb.org/t/p/w342',RUN='11111111-1111-4111-8111-111111111111',NEG='epg/catalog-poster-negatives.json',CP=W.CHECKPOINT_KEY;
const film=(id,tmdbId,extra={})=>({id,tmdbId:String(tmdbId),canonicalIdentity:'tmdb:'+tmdbId,title:'Film '+id,year:2001,poster:null,...extra});
const stored=(db,id)=>JSON.parse(db.sql("SELECT payload_json FROM discovery_admission WHERE film_id='"+id+"'")[0].payload_json);
const leaseRow=db=>JSON.stringify(db.sql('SELECT * FROM discovery_lease'));

async function harness(films){
 const db=migrated();
 const bucket=new MemoryBucket();
 await bucket.put('epg/published-generation.json',JSON.stringify({phase:'published',programmeRunId:RUN}));
 const env={DB:db,BUCKET:bucket,discoveryLease:null};
 let taken=await Authority.acquireLease(env,{programmeRunId:null});
 // Production schema (through 0026): today's EPG publication is owed until it is certified, and the pause refuses the lease. The fixture publishes the owed day, as a settled day is in production at 03:24 UTC.
 if(!taken.lease&&taken.busy?.kind==='epg_priority'){
  db.sql("UPDATE published_epg_authority SET mode='d1', cutover='open', programme_run_id='"+RUN+"', madrid_run_key='"+taken.busy.owedDayKey+"', finalized_run_id='"+RUN+"' WHERE id=1");
  db.sql("UPDATE discovery_authority SET published_programme_run_id='"+RUN+"' WHERE id=1");
  taken=await Authority.acquireLease(env,{programmeRunId:null});
 }
 assert.ok(taken.lease,'the fixture can take the lease: '+JSON.stringify(taken.busy));
 env.discoveryLease=taken.lease;
 await Authority.replaceLedger(env,{programmeRunId:RUN,items:[]});
 await Authority.replaceCatalog(env,films);
 await Authority.releaseLease(env,env.discoveryLease);
 const r2Writes=[],r2Reads=[],fetches=[];let tmdb={},priority=null;
 const guarded={async get(key){r2Reads.push(key);return bucket.get(key);},async head(key){return bucket.head(key);},async put(key,body,options){r2Writes.push(key);return bucket.put(key,body,options);},async delete(){throw new Error('delete');},async list(){return {objects:[],truncated:false};}};
 // The Authority as the Worker sees it; `priority` makes the lease refuse with an EPG-priority pause, exactly as the production gate answers.
 const authority={...Authority,acquireLease:async(...args)=>priority?{lease:null,busy:{kind:'epg_priority',nextCatchUpAt:priority}}:Authority.acquireLease(...args)};
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,Uint32Array,DataView,atob,btoa,crypto:webcrypto,console:{log(){},error(){},warn(){}},setTimeout,clearTimeout,structuredClone,encodeURIComponent,decodeURIComponent,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},FILM_TITLE_DICTIONARY:[],PERSON_NAME_DICTIONARY:[],DiscoveryAuthority:authority,
  fetch:async input=>{const url=String(input instanceof Request?input.url:input);fetches.push(url);const match=url.match(/\/movie\/(\d+)\?/);const reply=match?tmdb[match[1]]:null;if(typeof reply==='function')return reply();if(!reply)return new Response('x',{status:599});return new Response(JSON.stringify(reply),{status:200});}});
 vm.runInContext(scoped('src/domain/discovery-observation-index.js','DiscoveryIndex'),context);
 for(const file of ['src/domain/film-person.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext(scoped('src/catalog-poster-weekly.js','CatalogPosterWeekly'),context);
 for(const file of ['src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext(scoped('src/domain/admin-query.js','AdminQuery'),context);
 for(const file of ['src/admin/owner-reviews.js','src/admin/read.js'])vm.runInContext(fs.readFileSync(file,'utf8'),context);
 vm.runInContext(scoped('src/domain/data-health.js','DataHealth'),context);
 vm.runInContext(fs.readFileSync('src/admin/posters.js','utf8'),context);
 vm.runInContext(scoped('src/domain/limbo-inventory.js','LimboInventory'),context);
 vm.runInContext(fs.readFileSync('src/admin/limbo.js','utf8'),context);
 vm.runInContext(scoped('src/domain/admin-actions.js','AdminActions'),context);
 vm.runInContext(scoped('src/domain/discovery-identity-review.js','DiscoveryIdentity'),context);
 vm.runInContext(scoped('src/domain/discovery-recovery.js','DiscoveryRecovery'),context);
 vm.runInContext(fs.readFileSync('src/admin/discovery-recovery.js','utf8'),context);
 vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),context);
 vm.runInContext(fs.readFileSync('src/worker.js','utf8').replace('export default','globalThis.worker='),context);
 const base={DB:db,BUCKET:guarded,TMDB_API_READ_ACCESS_TOKEN:'test',TMDB_REQUEST_INTERVAL_MS:0};
 const fire=async(iso,extra={})=>{const waits=[];await context.worker.scheduled({cron:'24 3 * * *',scheduledTime:Date.parse(iso)},{...base,...extra},{waitUntil(p){waits.push(p);}});await Promise.all(waits);};
 const checkpoint=async()=>{const object=await bucket.get(CP);return object?JSON.parse(await object.text()):null;};
 const events=async()=>{const listed=await bucket.list({prefix:'events/items/'});return Promise.all(listed.objects.map(async item=>JSON.parse(await (await bucket.get(item.key)).text())));};
 return {db,bucket,env,fire,checkpoint,events,r2Writes,r2Reads,fetches,setTmdb:value=>{tmdb=value;},setPriority:value=>{priority=value;},base,context};
}
const noR2Catalog=h=>{assert.deepEqual(h.r2Writes.filter(key=>key.includes('discovered-films')),[],'no R2 catalog write');assert.ok(!h.r2Reads.some(key=>key.includes('discovered-films')),'no R2 catalog read');};

// 1. Positive guarded D1 hydration through the cron entry: the poster reaches `discovery_admission`, nothing of the R2 catalog is read or written, the verdicts and the report are right.
{
 const h=await harness({tmdb_1:film('tmdb_1',1),tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),tmdb_3:film('tmdb_3',3),tmdb_6:film('tmdb_6',6),tmdb_8:film('tmdb_8',8,{poster:'http://insecure.example/x.jpg'})});
 h.setTmdb({1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null},6:{id:66,poster_path:'/other.jpg'},8:{id:8,poster_path:'/eight.jpg'}});
 await h.fire('2026-11-15T03:24:00Z');
 assert.equal(stored(h.db,'tmdb_1').poster,POSTER+'/one.jpg','positive hydration written to D1');
 assert.equal(stored(h.db,'tmdb_3').poster,null);assert.equal(stored(h.db,'tmdb_8').poster,POSTER+'/eight.jpg','a non-https poster counts as missing and is replaced by the guarded https one');
 assert.ok(!h.fetches.some(url=>url.includes('/movie/2?')),'a film that already has a poster is not requested');
 noR2Catalog(h);
 assert.ok(h.r2Writes.every(key=>key===NEG||key===CP||key.startsWith('events/items/')),'only the negative index, the checkpoint and the event are written to R2: '+h.r2Writes);
 const cp=await h.checkpoint();assert.equal(cp.status,'completed');assert.equal(cp.summary.hydrated,2);assert.equal(cp.summary.noPoster,1);
 const evs=await h.events();assert.equal(evs.length,1);assert.equal(evs[0].outcome,'completed');assert.equal(evs[0].hydrated,2);
 // The same D1 value is what the Discovery catalog read returns.
 assert.equal((await Authority.routeRead(h.env,'epg/discovered-films.json')).value.tmdb_1.poster,POSTER+'/one.jpg');
 // Idle on Monday: one read, no write, no TMDB.
 h.r2Writes.length=0;h.fetches.length=0;await h.fire('2026-11-16T03:24:00Z');assert.deepEqual(h.r2Writes,[]);assert.deepEqual(h.fetches,[]);
}

// 2. A zero-due week while Discovery HOLDS the lease: no lease write, no TMDB, no catalog write, one successful weekly report (two checkpoint CAS + one event put).
{
 const h=await harness({tmdb_2:film('tmdb_2',2,{poster:POSTER+'/kept.jpg'}),tmdb_3:film('tmdb_3',3)});
 // tmdb_3 has no poster and a held 90-day verdict: nothing is due.
 await h.bucket.put(NEG,JSON.stringify({schemaVersion:1,entries:{'3':{status:'no_poster_on_tmdb',checkedAt:'2026-11-10T00:00:00.000Z',nextCheckAt:'2027-02-08T00:00:00.000Z'}}}));
 h.db.sql("UPDATE discovery_lease SET lease_id='discovery-chunk-owner', expires_at="+(Date.now()+3600000)+", programme_run_id='"+RUN+"' WHERE id=1");
 const before=leaseRow(h.db),admissions=JSON.stringify(h.db.sql('SELECT * FROM discovery_admission ORDER BY film_id'));
 h.r2Writes.length=0;
 await h.fire('2026-11-15T03:24:00Z',{TMDB_API_READ_ACCESS_TOKEN:undefined});
 assert.equal(leaseRow(h.db),before,'no lease write: the busy holder is untouched');
 assert.equal(JSON.stringify(h.db.sql('SELECT * FROM discovery_admission ORDER BY film_id')),admissions,'no D1 catalog write');
 assert.deepEqual(h.fetches,[],'no TMDB call, and no TMDB credential was needed');
 noR2Catalog(h);
 const cp=await h.checkpoint();assert.equal(cp.status,'completed','busy Discovery does not defer an empty week');assert.equal(cp.retryAttempts,0);assert.equal(cp.summary.due,0);
 assert.equal(h.r2Writes.filter(key=>key===CP).length,2,'two checkpoint CAS');assert.equal(h.r2Writes.filter(key=>key.startsWith('events/items/')).length,1,'one event put');
 assert.equal(h.r2Writes.filter(key=>key===NEG).length,0,'no negative index write');
 const evs=await h.events();assert.equal(evs.length,1);assert.equal(evs[0].outcome,'completed');assert.equal(evs[0].due,0);
}

// 3. Due work with a busy lease defers (nothing written, no TMDB), then resumes on the next daily firing once Discovery is free. An EPG-priority pause defers the same way.
{
 const h=await harness({tmdb_1:film('tmdb_1',1)});
 h.setTmdb({1:{id:1,poster_path:'/one.jpg'}});
 h.db.sql("UPDATE discovery_lease SET lease_id='discovery-chunk-owner', expires_at="+(Date.now()+3600000)+", programme_run_id='"+RUN+"' WHERE id=1");
 await h.fire('2026-11-15T03:24:00Z');
 let cp=await h.checkpoint();assert.equal(cp.status,'pending');assert.equal(cp.summary.deferredBusy,1);assert.deepEqual(h.fetches,[]);assert.equal(stored(h.db,'tmdb_1').poster,null);
 assert.equal((await h.events())[0].outcome,'deferred');
 h.db.sql("UPDATE discovery_lease SET lease_id=NULL, expires_at=0 WHERE id=1");
 h.setPriority('2026-11-16T10:00:00.000Z');
 await h.fire('2026-11-16T03:24:00Z');
 cp=await h.checkpoint();assert.equal(cp.status,'pending','an EPG-priority pause defers');assert.equal(stored(h.db,'tmdb_1').poster,null);assert.deepEqual(h.fetches,[]);
 assert.ok(Date.parse(cp.nextRetryAt)>=Date.parse('2026-11-16T10:00:00.000Z'),'the pause time is the retry gate');
 h.setPriority(null);
 await h.fire('2026-11-17T03:24:00Z');
 cp=await h.checkpoint();assert.equal(cp.status,'completed');assert.equal(stored(h.db,'tmdb_1').poster,POSTER+'/one.jpg');noR2Catalog(h);
 const ids=(await h.events()).map(item=>item.id).sort();assert.deepEqual(ids,['catalog_posters-2026-11-15-deferred','catalog_posters-2026-11-15-final']);
}

// 4. An uncertain D1 write: the batch fails with no answer. Nothing is remembered, the run stays pending (no blind success), and the next firing converges idempotently.
{
 const h=await harness({tmdb_1:film('tmdb_1',1),tmdb_3:film('tmdb_3',3)});
 h.setTmdb({1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:null}});
 const flaky={prepare:sql=>h.db.prepare(sql),batch:async statements=>{if(statements.some(item=>String(item.text).includes("json_set(payload_json,'$.poster'")&&String(item.text).startsWith('UPDATE discovery_admission')))throw new Error('D1 batch failed: unknown');return h.db.batch(statements);}};
 await h.fire('2026-11-15T03:24:00Z',{DB:flaky});
 let cp=await h.checkpoint();assert.equal(cp.status,'pending','an uncertain write is never reported as completed');assert.ok(cp.retryAttempts>=1);
 assert.ok(!h.r2Writes.includes(NEG),'no remembered answer after an uncertain write');
 assert.equal((await h.events())[0].outcome,'deferred');
 await h.fire('2026-11-16T03:24:00Z');
 cp=await h.checkpoint();assert.equal(cp.status,'completed');assert.equal(stored(h.db,'tmdb_1').poster,POSTER+'/one.jpg');
 assert.equal(h.db.sql("SELECT count(*) AS n FROM discovery_admission WHERE film_id='tmdb_1'")[0].n,1,'one row, written once');
 assert.equal(JSON.parse((await h.bucket.get(NEG)).text?await (await h.bucket.get(NEG)).text():'{}').entries['3'].status,'no_poster_on_tmdb');
 noR2Catalog(h);
}

// 5. A malformed or incomplete TMDB detail is retryable and never remembered as "no poster" (review of PR 799): missing key, empty and malformed values, then a real poster on retry.
{
 const h=await harness({tmdb_1:film('tmdb_1',1),tmdb_3:film('tmdb_3',3),tmdb_4:film('tmdb_4',4)});
 h.setTmdb({1:{id:1,title:'x'},3:{id:3,poster_path:''},4:{id:4,poster_path:'not a path'}});
 await h.fire('2026-11-15T03:24:00Z');
 let cp=await h.checkpoint();assert.equal(cp.status,'pending','incomplete answers keep the run open');
 const neg=await h.bucket.get(NEG);assert.equal(neg,null,'nothing was remembered as no-poster for a missing, empty or malformed poster_path');
 for(const id of ['tmdb_1','tmdb_3','tmdb_4'])assert.equal(stored(h.db,id).poster,null);
 h.setTmdb({1:{id:1,poster_path:'/one.jpg'},3:{id:3,poster_path:'/three.jpg'},4:{id:4,poster_path:null}});
 await h.fire('2026-11-16T03:24:00Z');
 cp=await h.checkpoint();assert.equal(cp.status,'completed');assert.equal(stored(h.db,'tmdb_1').poster,POSTER+'/one.jpg');assert.equal(stored(h.db,'tmdb_3').poster,POSTER+'/three.jpg');
 assert.equal(JSON.parse(await (await h.bucket.get(NEG)).text()).entries['4'].status,'no_poster_on_tmdb','an explicit poster_path:null is the only verdict that is remembered');
}
console.log('catalog-poster-weekly-d1: the cron branch over real sqlite in d1/open mode: positive D1 hydration with no R2 catalog read or write, a zero-due week under a busy lease with no lease write, no TMDB and one report, busy lease and EPG priority defer and resume, an uncertain D1 write converges idempotently, and incomplete TMDB details are never remembered as no-poster');
