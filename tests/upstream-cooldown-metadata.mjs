// AIR-604 (UC1 acceptance, review of PR #1021, P1-1): the REAL metadata sync step with an active Wikidata cooldown. A skipped Wikidata request is an INCOMPLETE localization, not a completed one:
// no request is sent, the films are not marked `peopleNamesVersion` 2 / `peopleLocalizedAt`, no failure is recorded, the run carries the bounded evidence counters, and after the cooldown has
// expired the next metadata step asks Wikidata and completes the marker. Offline: one scripted fetch, a sqlite D1 stand-in only for the cooldown tables, no network, no production.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
import {installViewIndexFixture} from './view-index-fixture.mjs';
import {migrated, sql} from './prediction-d1-flow-lib.mjs';
import {d1Standin} from './d1-standin.mjs';

const WATCHLIST_HTML='<span class="js-watchlist-count">1</span><div data-component-class="LazyPoster" data-item-name="Heat (1995)" data-item-link="/film/heat-1995/" data-postered-identifier="{&quot;lid&quot;:&quot;film1&quot;}"></div>';
const FILM_HTML='<meta name="description" content="A crew plans a robbery."><span data-tmdb-id="1656"></span><script type="application/ld+json">{"name":"Heat","genre":"Crime","duration":"PT2H50M","director":{"name":"Michael Mann","sameAs":"https://letterboxd.com/director/michael-mann/"},"actor":[{"name":"Al Pacino","sameAs":"https://letterboxd.com/actor/al-pacino/"}]}</script>';
const FILMS_HTML='<span title="1&nbsp;films"></span><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;film1&quot;}\'></div></li>';
const fetches=[],logs=[];
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,atob,encodeURIComponent,decodeURIComponent,crypto:webcrypto,setTimeout,ASSETS:{},
 console:{...console,log:line=>{if(String(line).includes('"event":"upstream_cooldown"'))logs.push(JSON.parse(line));}},
 fetch:async url=>{
  const href=String(url);fetches.push(href);
  if(href==='https://letterboxd.com/fixture/watchlist/')return new Response(WATCHLIST_HTML);
  if(href==='https://letterboxd.com/film/heat-1995/')return new Response(FILM_HTML);
  if(href==='https://letterboxd.com/fixture/films/')return new Response(FILMS_HTML);
  if(href.startsWith('https://query.wikidata.org/sparql'))return Response.json({results:{bindings:[]}});
  throw new Error('Unexpected network access '+href);
 }});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);vm.runInContext(fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),context);vm.runInContext(scoped('src/metadata-cache.js','MetadataCache'),context);
vm.runInContext(scoped('src/upstream-cooldown.js','UpstreamCooldown'),context);// in scope before any call, as in the bundle
for(const file of ['src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/sources.js','src/ratings-seed.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/continuation.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context);
installViewIndexFixture(context);context.RatingsD1=new Proxy({projectView:async(env,records)=>({owned:true,changed:records.length}),ratingsMutableKey:()=>false},{get:(t,n)=>n in t?t[n]:async()=>({owned:false,handled:false,changed:0})});
const worker=context.worker;

let records=new Map(),etags=new Map(),revision=0;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};},
 async delete(key){records.delete(key);etags.delete(key);},
 async list({prefix=''}={}){return {objects:[...records.keys()].filter(k=>k.startsWith(prefix)).sort().map(key=>({key})),truncated:false};}
};
// The harness runs the metadata cache as its explicit local stand-in, which needs a D1 below schema 6; so the cooldown tables (taken from the real migration, not copied) are created on a schema-1
// database. The migration itself is proven on the full chain in tests/upstream-cooldown.mjs.
const file=migrated(1);
sql(file,fs.readFileSync('migrations/0045_upstream_cooldown.sql','utf8').match(/CREATE TABLE[\s\S]*?\);/g).join('\n'));
sql(file,`INSERT INTO upstream_coordination (id, mode, revision, updated_at) VALUES (1, 'enforce', 1, ${Date.now()})`);
const env={BUCKET:bucket,DB:d1Standin(file),LETTERBOXD_USERNAME:'fixture',EPG_XML_URL:'https://epg.test/guide.xml',METADATA_CACHE_DB_OPTIONAL:'standin'};
const execution={waitUntil(){}};
const post=async(path,body={})=>{const response=await worker.fetch(new Request('https://iptv.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env,execution);return {status:response.status,data:await response.json()};};
const wikidata=()=>fetches.filter(href=>href.startsWith('https://query.wikidata.org/'));
const syncRun=()=>records.get('sync.json');
const film=()=>syncRun().watchlist?.[0]||syncRun().films?.[0];

// 1. an enforced, active Wikidata cooldown: the step runs, asks Wikidata nothing, and does not mark the film localized
sql(file,`INSERT INTO upstream_cooldown (scope, until_at, reason, retry_after_s, set_by, updated_at) VALUES ('wikidata', ${Date.now()+3600000}, 'rate_limited', NULL, 'seed', ${Date.now()})`);
let start=await post('/api/sync/start');assert.equal(start.status,200,JSON.stringify(start.data));
let metadata=await post('/api/sync/metadata',{runId:start.data.runId});
assert.equal(metadata.status,200,JSON.stringify(metadata.data));
assert.deepEqual(wikidata(),[],'an active Wikidata cooldown sends no Wikidata request');
assert.ok(fetches.includes('https://letterboxd.com/film/heat-1995/'),'the Letterboxd film page is another scope and is still read');
const first=film();
assert.ok(first,'the run keeps its watchlist: '+Object.keys(syncRun()).join());
assert.notEqual(first.peopleNamesVersion,2,'a skipped people localization is not recorded as completed');
assert.equal(first.peopleLocalizedAt,undefined,'and has no completion time');
assert.equal(syncRun().localizationErrors||0,0,'a skip is no localization failure');
assert.equal(syncRun().titleLocalizationErrors||0,0);
assert.deepEqual(syncRun().failures||[],[],'and no film failure');
assert.ok(syncRun().upstreamCooldown?.skipped>=1,'the run carries the bounded evidence counters: '+JSON.stringify(syncRun().upstreamCooldown));
assert.ok(logs.some(line=>line.decision==='skipped'&&line.scope==='wikidata'&&line.caller==='metadata-sync'),'and the decision is in the Worker log');

// 2. after the cooldown has expired the next step asks Wikidata and completes the marker
sql(file,`UPDATE upstream_cooldown SET until_at = ${Date.now()-1000} WHERE scope = 'wikidata'`);
fetches.length=0;
records.delete('sync.json');etags.delete('sync.json');// the first run is still open at its `epg` stage; a new run starts from the metadata cache the first one left
start=await post('/api/sync/start');assert.equal(start.status,200,JSON.stringify(start.data));assert.equal(start.data.stage,'metadata','the film is pending again: its people localization never completed');
metadata=await post('/api/sync/metadata',{runId:start.data.runId});
assert.equal(metadata.status,200,JSON.stringify(metadata.data));
assert.ok(wikidata().length>=1,'the retry asks Wikidata');
assert.equal(film().peopleNamesVersion,2,'and completes the localization marker');
assert.ok(film().peopleLocalizedAt);

// 3. off: today's behaviour, even with a seeded cooldown (a film is localized, Wikidata is asked)
sql(file,`UPDATE upstream_coordination SET mode = 'off'`);
sql(file,`UPDATE upstream_cooldown SET until_at = ${Date.now()+3600000} WHERE scope = 'wikidata'`);
fetches.length=0;
records.delete('sync.json');etags.delete('sync.json');
start=await post('/api/sync/start');metadata=await post('/api/sync/metadata',{runId:start.data.runId});
assert.equal(metadata.status,200);assert.equal(syncRun().upstreamCooldown?.skipped??0,0,'off skips nothing and records no evidence');

console.log('upstream-cooldown-metadata: ok');
