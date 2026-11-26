// AIR-499: marker-gated footer metadata.json and GET /api/enrichment/diagnostics/export?group=global.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {webcrypto} from 'node:crypto';
import {d1Standin} from './d1-standin.mjs';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {sqliteSync} from './sqlite-session.mjs';

const IMPORT='const {CREDIT_SELECTION_SQL,database,failed,many,one,readAuthority,readSource}=FilmPersonAuthority;\n';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-canonical-footer-'));
const names=fs.readdirSync('migrations').filter(name=>/^\d{4}_.*\.sql$/.test(name)).sort();
const sqlite=(file,text)=>{const r=sqliteSync(['-bail',file],{input:'PRAGMA foreign_keys=ON;\n'+text,encoding:'utf8',maxBuffer:1<<26});if(r.status!==0)throw new Error(r.stderr);};
const VERIFY="UPDATE film_person_baseline SET state='loading',reference='t' WHERE id=1;UPDATE film_person_baseline SET state='verified' WHERE id=1;";
const TO_OPEN="UPDATE film_person_authority SET mode='d1',generation=2 WHERE id=1;",TO_HELD="UPDATE film_person_authority SET cutover='held',generation=3 WHERE id=1;";
const MARKER={r2:'',prepared:VERIFY+"UPDATE film_person_authority SET mode='prepared',generation=1 WHERE id=1;"};
MARKER.open=MARKER.prepared+TO_OPEN;MARKER.held=MARKER.open+TO_HELD;
const T='2026-11-16T10:00:00.000Z';
const SEED=`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:heat-1995',1,'tmdb:7','Heat','${T}');
INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES
 ('film:heat-1995',1,1995,NULL,NULL,'https://a.example/p.jpg','https://letterboxd.com/film/heat-1995/','[]',NULL,'{}',NULL,NULL,'${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:heat-1995','letterboxd','heat-1995',1,0,NULL),
 ('film:heat-1995','tmdb','7',1,0,NULL);
INSERT INTO film_dimension (film_id,dimension,status,source,source_version,provenance_json,value,authority,updated_at) VALUES
 ('film:heat-1995','localization','provisional','wikidata','p','{"sources":[]}','Heat RU','automatic','${T}');
`;

let n=0;const BASE=new Map();
function database(state){
 const file=path.join(root,'f-'+(n++)+'.sqlite');
 const upTo=state==='legacy'?names.findIndex(name=>name.startsWith('0013')):names.length;
 if(!BASE.has(upTo)){const shared=process.env.CANONICAL_CATALOG_BASE_DIR,base=path.join(shared||root,'base-footer-'+upTo+'.sqlite');if(!(shared&&fs.existsSync(base)))sqlite(base,names.slice(0,upTo).map(name=>fs.readFileSync('migrations/'+name,'utf8')).join('\n'));BASE.set(upTo,base);}
 fs.copyFileSync(BASE.get(upTo),file);
 if(state!=='legacy')sqlite(file,SEED);
 if(state==='unknown-row'){sqlite(file,MARKER.prepared);sqlite(file,'DROP TRIGGER film_person_authority_no_delete;DELETE FROM film_person_authority;');}
 else if(state==='unknown-table')sqlite(file,'DROP TABLE film_person_cas;');
 else if(MARKER[state])sqlite(file,MARKER[state]);
 return file;
}
const standin=(file,state,extra={})=>d1Standin(file,{...extra,...(state==='unknown-read'?{rewrite:sql=>/FROM film_person_authority/.test(sql)?'SELECT nope FROM nowhere':sql}:{})});

const G1='22222222-2222-4222-8222-222222222222';
const records=new Map(),reads=[];
const bucket={
 async get(key){reads.push(key);return records.has(key)?{etag:'e',json:async()=>structuredClone(records.get(key)),text:async()=>JSON.stringify(records.get(key)),size:JSON.stringify(records.get(key)).length}:null;},
 async put(){throw new Error('no R2 write from a GET');},
 async list(){return {objects:[],truncated:false};}
};
const ctx=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,clearTimeout,ASSETS:{},INITIAL_PERSONAL_RATINGS:{},fetch:async()=>new Response('unexpected',{status:599})});
vm.runInContext(scoped('src/domain/film-availability.js','FilmAvailability'),ctx);
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/film-person-authority.js','FilmPersonAuthority'),ctx);vm.runInContext(scopedReplacing('src/canonical-catalog-reader.js','CanonicalCatalogReader',IMPORT),ctx);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
for(const file of ['src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/sources.js','src/discovery.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
installViewIndexFixture(ctx);
const worker=ctx.worker;

function seedFooter(){
 records.clear();reads.length=0;
 const now=Date.now(),hour=3600000;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 const film={id:'heat-1995',tmdbId:'7',canonicalIdentity:'tmdb:7',title:'Heat',original:'Heat',year:1995,runtime:170,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1};
 for(const key of ['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'])records.set(key,{tmdb_7:structuredClone({...film,id:'tmdb_7'})});
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:T,watchlistCount:1,films:[structuredClone(film)],stats:{}});
 records.set('watchlist.json',{updatedAt:T,films:[{id:'heat-1995',tmdbId:'7',title:'Heat'}]});
 records.set('epg/generations/'+G1+'/watchlist.json',structuredClone(records.get('watchlist.json')));
 records.set('metadata.json',{'heat-1995':{id:'heat-1995',tmdbId:'99',poster:'https://r2.example/stale.jpg',url:'https://letterboxd.com/film/stale/',year:1995,title:'Stale'}});
 records.set('titles.json',{'heat-1995':{title:'From titles',tmdbId:'7',status:'provisional',sources:null}});
 records.set(vm.runInContext('profileKey',ctx),{version:1,profileHash:'p1'});
 records.set(vm.runInContext('ENRICHMENT_KEY',ctx)+'view-index.json',{'heat-1995':{watched:true,actualRating:4,prediction:{predictedRating:4,probability4Plus:.5,confidence:'high',matchSignals:[],mainRisk:null,tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'f',fingerprintSchemaVersion:1,predictionPromptVersion:1},fingerprintHash:'f',impactFeatures:{fingerprintHash:'f',fingerprintSchemaVersion:1,fingerprintPromptVersion:1}}});
}

const ask=async(route,env)=>{const r=await worker.fetch(new Request('https://iptv.vladimino.workers.dev'+route),{BUCKET:bucket,...env},{waitUntil(){}});return {status:r.status,body:await r.json()};};
const footer=env=>ask('/api/enrichment/footer/status',env);
const exported=env=>ask('/api/enrichment/diagnostics/export?group=global',env);
const record=(body,key)=>(body.records||[]).find(item=>item.key===key);

{
 seedFooter();
 reads.length=0;
 const prepared=await footer({DB:standin(database('prepared'),'prepared')});
 assert.equal(prepared.status,503,'prepared is not served (ADR 0162)');
 assert.ok(!reads.includes('metadata.json'),'prepared never reads the frozen metadata.json');
}
{
 seedFooter();
 const open=await footer({DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.ok(!reads.includes('metadata.json'),'open footer does not GET frozen metadata.json');
 assert.equal(open.body.collection.state,'ok');
 assert.equal(open.body.collection.watched,1);
}
{
 seedFooter();
 records.delete('metadata.json');
 const open=await footer({DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.equal(open.body.collection.state,'ok','open footer uses bounded D1 even when the frozen object is absent');
}
{
 seedFooter();
 const held=await footer({DB:standin(database('held'),'held')});
 assert.equal(held.status,503);
 assert.equal(held.body.reason,'film_person_held');
 assert.ok(!reads.includes('metadata.json'),'held footer never falls back to R2 metadata.json');
}
{
 seedFooter();
 const unread=await footer({DB:standin(database('unknown-read'),'unknown-read')});
 assert.equal(unread.status,503);
 assert.equal(unread.body.reason,'film_person_unavailable');
}

{
 const file=database('open');seedFooter();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===3)sqlite(file,TO_HELD);}}})};
 const r=await footer(env);
 assert.equal(r.status,503,'open footer rechecks the marker after predictionFreshness');
 assert.equal(r.body.reason,'film_person_generation_moved');
}
{
 seedFooter();
 reads.length=0;
 const prepared=await exported({DB:standin(database('prepared'),'prepared')});
 assert.equal(prepared.status,503,'prepared is not served (ADR 0162)');
 assert.ok(!reads.includes('metadata.json')&&!reads.includes('titles.json'),'no frozen mirror is read');
}
{
 seedFooter();
 const open=await exported({DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.ok(!reads.includes('metadata.json'),'open export does not GET frozen metadata.json');
 assert.ok(!reads.includes('titles.json'),'open export does not GET frozen titles.json');
 const meta=record(open.body,'metadata.json');
 assert.equal(meta.etag,'d1:2');
 assert.equal(meta.value['heat-1995'].tmdbId,'7');
 assert.equal(meta.value['heat-1995'].poster,'https://a.example/p.jpg');
 const titles=record(open.body,'titles.json');
 assert.equal(titles.value['heat-1995'].title,'Heat RU');
}
{
 seedFooter();
 const held=await exported({DB:standin(database('held'),'held')});
 assert.equal(held.status,503);
 assert.equal(held.body.reason,'film_person_held');
 assert.ok(!reads.includes('metadata.json'));
 assert.ok(!reads.includes('titles.json'));
}
{
 const file=database('open');seedFooter();
 let gates=0;
 const env={BUCKET:bucket,DB:standin(file,'open',{onQuery:async text=>{if(/FROM film_person_authority/.test(text)){gates++;if(gates===4)sqlite(file,TO_HELD);}}})};
 const r=await exported(env);
 assert.equal(r.status,503,'open export rechecks the marker after the D1 projection');
 assert.equal(r.body.reason,'film_person_generation_moved');
}

function seedH95Footer(){
 records.clear();reads.length=0;
 const now=Date.now(),hour=3600000;
 records.set('epg/published-generation.json',{phase:'published',programmeRunId:G1});
 const lid={id:'h95',tmdbId:'7',title:'Heat',original:'Heat',year:1995,runtime:170,genres:[],poster:null,url:null,directors:[],actors:[],shows:[{channelId:'c1',channel:'One',start:now-hour,end:now+hour}],showsProgrammeRunId:G1};
 const catalogFilm={...lid,id:'tmdb_7',canonicalIdentity:'tmdb:7'};
 for(const key of ['epg/discovered-films.json','epg/generations/'+G1+'/discovered-films.json'])records.set(key,{tmdb_7:structuredClone(catalogFilm)});
 for(const key of ['programme.json','epg/generations/'+G1+'/programme.json'])records.set(key,{runId:G1,updatedAt:T,watchlistCount:1,films:[structuredClone(lid)],stats:{}});
 records.set('watchlist.json',{updatedAt:T,films:[{id:'h95',tmdbId:'7',title:'Heat'}]});
 records.set('epg/generations/'+G1+'/watchlist.json',structuredClone(records.get('watchlist.json')));
 records.set('metadata.json',{'h95':{id:'h95',tmdbId:'7',title:'Stale'}});
 records.set('titles.json',{});
 records.set(vm.runInContext('profileKey',ctx),{version:1,profileHash:'p1'});
 const pred=(id,rating)=>({fingerprintHash:'fp-'+id,impactFeatures:{fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,fingerprintPromptVersion:1},prediction:{predictedRating:rating,probability4Plus:.9,confidence:'high',tasteProfileVersion:1,tasteProfileHash:'p1',fingerprintHash:'fp-'+id,fingerprintSchemaVersion:1,predictionPromptVersion:1}});
 records.set(vm.runInContext('ENRICHMENT_KEY',ctx)+'view-index.json',{h95:{watched:true},tmdb_7:pred('7',4.8)});
}

const H95_FILM=`
UPDATE film_external_id SET trusted=0, conflicting=1 WHERE film_id='film:heat-1995' AND scheme='tmdb' AND value='7';
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES
 ('film:h95',1,'tmdb:7','Heat','${T}');
INSERT INTO film_metadata (film_id,schema_version,year,runtime,synopsis,poster,url,genres_json,people_version,payload_json,r2_key,content_sha256,updated_at) VALUES
 ('film:h95',1,1995,NULL,NULL,NULL,NULL,'[]',NULL,'{}',NULL,NULL,'${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES
 ('film:h95','letterboxd','h95',1,0,NULL),
 ('film:h95','tmdb','7',1,0,NULL);
`;
const TWO_TMDB=H95_FILM+"INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:h95','tmdb','8',1,0,NULL);\n";
const UNTRUSTED=H95_FILM+`
INSERT INTO film (id,contract_version,canonical_identity,original_title,updated_at) VALUES ('film:other',1,NULL,'Other','${T}');
INSERT INTO film_external_id (film_id,scheme,value,trusted,conflicting,provenance_json) VALUES ('film:other','tmdb','7',0,0,NULL);
`;

function assertUnbridgedFooter(body,label){
 assert.equal(body.collection.state,'ok',label);
 assert.equal(body.collection.watchlist,1,label+': one watchlist lid');
 assert.equal(body.collection.watched,1,label+': watched stays the unbridged lid');
 assert.ok(body.collection.total>=2,label+': catalog tmdb:7 is a second identity, not merged: '+JSON.stringify(body.collection));
 assert.equal(body.recommendations.newUnseen.state,'ok',label);
 assert.equal(body.recommendations.newUnseen.rating45plus,1,label+': unproven lid must not hide the catalog film from newUnseen');
}

{
 seedH95Footer();
 const file=database('open');
 sqlite(file,TWO_TMDB);
 const open=await footer({DB:standin(file,'open')});
 assert.equal(open.status,200);
 assertUnbridgedFooter(open.body,'two D1 TMDB claims');
 const dump=await exported({DB:standin(file,'open')});
 assert.equal(dump.status,200);
 assert.equal(record(dump.body,'metadata.json').value.h95.tmdbId,null);
 assert.equal(record(dump.body,'metadata.json').value.h95.identityBlocked,true,'export keeps the identity-blocked signal');
}
{
 seedH95Footer();
 const file=database('open');
 sqlite(file,UNTRUSTED);
 const open=await footer({DB:standin(file,'open')});
 assert.equal(open.status,200);
 assertUnbridgedFooter(open.body,'untrusted duplicate TMDB claim');
}
{
 seedFooter();
 const open=await footer({DB:standin(database('open'),'open')});
 assert.equal(open.status,200);
 assert.equal(open.body.collection.state,'ok');
 assert.equal(open.body.collection.watched,1,'trusted D1 claim still bridges');
 const dump=await exported({DB:standin(database('open'),'open')});
 assert.equal(record(dump.body,'metadata.json').value['heat-1995'].identityBlocked,undefined);
}

console.log('canonical-footer-export: footer/status and diagnostics/export?group=global keep R2 at prepared, bounded D1 at open, STOP on held/unreadable/generation move without frozen-key GET');

