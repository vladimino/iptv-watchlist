import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// GET routes that may write to R2. Each one is documented in README.md; extend both together.
const WRITING_GET_ROUTES=['/api/enrichment/runs','/api/enrichment/status','/api/enrichment/view','/api/events'];

const sources=['src/worker.js','src/enrichment.js'].map(file=>fs.readFileSync(file,'utf8')).join('\n');
const routes=new Set([...sources.matchAll(/(?:url\.pathname|path)==='(\/api\/[^']+)'&&request\.method==='GET'/g)].map(m=>m[1]));
for(const m of sources.matchAll(/\[((?:'\/api\/[^']+',?)+)\]\.includes\((?:url\.pathname|path)\)&&request\.method==='GET'/g))for(const path of m[1].split(','))routes.add(path.slice(1,-1));
for(const path of ['/','/api/migration-export/manifest'])routes.add(path);
assert(routes.size>=20,'route extraction found '+routes.size+' GET routes');
for(const path of WRITING_GET_ROUTES)assert(routes.has(path),path);

const records=new Map(),etags=new Map();let revision=0,puts=[],fetches=[],background=0,dispatches=0;
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),uploaded:new Date(0),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){const c=options.onlyIf;if(c?.etagDoesNotMatch==='*'&&records.has(key)||c?.etagMatches&&c.etagMatches!==etags.get(key))return null;records.set(key,JSON.parse(value));etags.set(key,String(++revision));puts.push(key);return {etag:etags.get(key)};},
 async delete(key){puts.push('delete:'+key);records.delete(key);},
 async list({prefix='',limit=1000}={}){const keys=[...records.keys()].filter(k=>k.startsWith(prefix)).sort();return {objects:keys.slice(0,limit).map(key=>({key,customMetadata:{}})),truncated:false};}
};
const env={BUCKET:bucket,TMDB_API_READ_ACCESS_TOKEN:'test',EPG_XML_URL:'https://epg.test/guide.xml',LETTERBOXD_USERNAME:'tester'};
const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date,Intl,Map,Set,JSON,TextEncoder,TextDecoder,Uint8Array,crypto:webcrypto,console,setTimeout,
 ASSETS:{'/':{body:'<!doctype html>',type:'text/html'}},INITIAL_PERSONAL_RATINGS:{w1:4},
 fetch:async input=>{const url=String(input instanceof Request?input.url:input);fetches.push(url);return url.startsWith('https://api.themoviedb.org/3/movie/11')?new Response('{"id":11}'):new Response('unexpected',{status:599});}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),context);for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/migration-export.js','src/filter-presets.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),context);
const constant=name=>vm.runInContext(name,context);
const execution={waitUntil:()=>{background++;},exports:{DiscoveryContinuation:{fetch:async()=>{dispatches++;return new Response('{}');}}}};

const past=new Date(Date.now()-3600000).toISOString();
function seed(recovery){
 records.clear();etags.clear();
 const film={id:'w1',tmdbId:'42',title:'Hot Film',original:'Hot Film',year:2020,runtime:100,shows:[]};
 records.set('programme.json',{runId:'run-1',updatedAt:past,watchlistCount:1,films:[film],stats:{}});
 records.set('watchlist.json',{updatedAt:past,films:[film]});
 records.set('sync.json',{runId:'run-1',stage:'complete',updatedAt:past});
 records.set(constant('profileKey'),{version:1,profileHash:'p'});
 records.set(constant('ENRICHMENT_KEY')+'view-index.json',recovery?{}:{w1:{actualRating:4}});
 if(!recovery)return;
 records.set(constant('STOP_EVENT_PREFIX')+'run-stopped.json',{event:{id:'stop-run-stopped',type:'enrichment',runId:'run-stopped',reason:'quota',at:past},delivered:false});
 records.set(constant('RUN_DIAGNOSTICS_PREFIX')+'run-expired.json',{runId:'run-expired',state:'running',startedAt:past,leaseAcquiredAt:past,leaseExpiredAt:past});
}

const writers=new Set();
for(const recovery of [false,true])for(const path of [...routes].sort()){
 seed(recovery);puts=[];fetches=[];
 const response=await context.worker.fetch(new Request('https://iptv.vladimino.workers.dev'+path),env,execution);
 assert(response.status<500,path+' returned '+response.status+': '+await response.clone().text());
 if(puts.length){assert(recovery,path+' wrote without pending recovery: '+puts.join(', '));writers.add(path);}
 assert.deepEqual(fetches,path==='/api/integrations/tmdb/status'?['https://api.themoviedb.org/3/movie/11?language=en-US']:[],path+' made an outbound request');
}
assert.deepEqual([...writers].sort(),WRITING_GET_ROUTES,'GET routes that write to R2');
assert.equal(background,0,'no GET schedules background work');assert.equal(dispatches,0,'no GET starts a continuation');

console.log(`GET side effects: ${routes.size} routes, writers limited to ${WRITING_GET_ROUTES.join(', ')}, no background work or hidden requests`);
