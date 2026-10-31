// Shared offline harness of the separate ratings pipeline tests (ADR 0060). Running this file alone tests nothing.
// The bucket keeps an etag per object and honours `onlyIf` (etagMatches, etagDoesNotMatch '*') like R2; `hooks` can
// delay or kill a get or put at a chosen key, and every operation is logged so a test can count writes and reads.
import fs from 'node:fs';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';

export const QUEUE='enrichment/removal-rating-lookups.json';
export const CURSOR='letterboxd/diary/state.json';
export const HISTORY='letterboxd/diary/history.json';
export const RUN='letterboxd/ratings/run.json';
export const WITNESS='letterboxd/ratings/migration.json';
export const USER='demo-user';
export const H=3600000,MIN=60000,DAY=86400000;

export function makeBucket(){
 const records=new Map(),etags=new Map(),log=[];let revision=0;
 const hooks={beforeGet:null,beforePut:null};
 const bucket={records,etags,log,hooks,
  async get(key){
   if(hooks.beforeGet)await hooks.beforeGet(key);
   log.push({op:'get',key});
   return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;
  },
  async put(key,value,options={}){
   if(hooks.beforePut)await hooks.beforePut(key,JSON.parse(value),options);
   const condition=options.onlyIf;
   if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key)){log.push({op:'conflict',key});return null;}
   records.set(key,JSON.parse(value));etags.set(key,'e'+(++revision));log.push({op:'put',key,conditional:!!condition});
   return {etag:etags.get(key)};
  },
  async delete(key){log.push({op:'delete',key});records.delete(key);etags.delete(key);},
  async list({prefix='',cursor,limit=1000}={}){
   log.push({op:'list',prefix});
   const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort(),offset=Number(cursor||0),slice=keys.slice(offset,offset+limit);
   return {objects:slice.map(key=>({key})),truncated:offset+limit<keys.length,cursor:String(offset+limit)};
  },
  writes(){return log.filter(item=>item.op==='put'||item.op==='delete');},
  set(key,value){records.set(key,structuredClone(value));etags.set(key,'e'+(++revision));},
  value(key){return records.has(key)?structuredClone(records.get(key)):null;},
  snapshot(){return Object.fromEntries([...records.keys()].sort().map(key=>[key,records.get(key)]));},
 };
 return bucket;
}

// A deterministic clock and UUID source inside the context: `new Date()` and Date.now() read `clock.now`.
export function makeClock(start){
 const clock={now:start,uuid:0};
 class FakeDate extends Date{constructor(...args){if(args.length)super(...args);else super(clock.now);}static now(){return clock.now;}}
 const crypto={subtle:webcrypto.subtle,getRandomValues:value=>webcrypto.getRandomValues(value),randomUUID:()=>{const n=String(++clock.uuid).padStart(12,'0');return `00000000-0000-4000-8000-${n}`;}};
 return {clock,FakeDate,crypto};
}

// The Letterboxd network: diary pages by number (HTML, or a status code), member film pages by slug (a rating, 'none',
// or a status code). Every request is logged; anything else is refused.
export function makeNetwork(){
 const net={diary:new Map(),members:new Map(),fetches:[],epg:null,watchlist:null,films:new Map(),hang:null};
 net.fetch=async input=>{
  const url=String(input);net.fetches.push(url);
  if(net.hang&&net.hang(url))throw new Error('network down');
  const diary=url.match(new RegExp(`^https://letterboxd\\.com/${USER}/diary/(?:page/(\\d+)/)?$`));
  if(diary){const page=Number(diary[1]||1),value=net.diary.get(page);return typeof value==='string'?new Response(value):new Response(value===403||value===429?'<title>Just a moment...</title>':'',{status:typeof value==='number'?value:404});}
  const member=url.match(new RegExp(`^https://letterboxd\\.com/${USER}/film/([a-z0-9-]+)/$`));
  if(member){const value=net.members.get(member[1]);if(value===403||value===429||value===404)return new Response('<title>Just a moment...</title>',{status:value});if(typeof value==='number')return new Response(review(member[1],value));return new Response('<html>no review</html>');}
  if(url===`https://letterboxd.com/${USER}/watchlist/`&&net.watchlist)return new Response(net.watchlist);
  if(net.films.has(url))return new Response(net.films.get(url));
  if(url==='https://epg.test/guide.xml'&&net.epg)return new Response(net.epg());
  if(url.startsWith('https://query.wikidata.org/sparql'))return Response.json({results:{bindings:[]}});
  throw new Error('Unexpected network access '+url);
 };
 net.diaryFetches=()=>net.fetches.filter(url=>url.includes(`/${USER}/diary/`));
 net.memberFetches=()=>net.fetches.filter(url=>url.includes(`/${USER}/film/`));
 net.watchlistFetches=()=>net.fetches.filter(url=>url.includes('/watchlist/'));
 return net;
}
export const review=(slug,rating)=>`<script type="application/ld+json">{"@type":"Review","author":[{"sameAs":"https://letterboxd.com/${USER}/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}}</script>`;
export function diaryRow(lid,stars,date,viewingId=null){
 const [y,m,d]=date.split('-');
 return `<tr class="diary-entry-row"${viewingId?` data-viewing-id="${viewingId}"`:''}><td><a href="/${USER}/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;}"></div><a href="/film/${lid}/">${lid}</a></td><td>${stars?`<span class="rating rated-${stars}"></span>`:''}</td></tr>`;
}
export const diaryPage=(rows,next)=>`<table>${rows.join('')}</table>${next?'<a class="next" href="#">Older</a>':''}`;
// A diary of `pages` pages, `perPage` rows each, one viewing id per row, newest first from `newest`.
export function diaryPages(net,{pages,perPage=50,newest='2026-10-30',stars=8,prefix='lid'}){
 let n=0;const base=Date.parse(newest+'T00:00:00Z');
 for(let page=1;page<=pages;page++){
  const rows=[];for(let i=0;i<perPage;i++,n++)rows.push(diaryRow(`${prefix}${n}`,stars,new Date(base-Math.floor(n/2)*DAY).toISOString().slice(0,10),String(100000+n)));
  net.diary.set(page,diaryPage(rows,page<pages));
 }
}

export const SERVER_FILES=['src/sources.js','src/ratings-seed.js','src/discovery.js','src/domain/profile-impact.js','src/domain/prediction-compatibility.js','src/domain/fingerprint-compatibility.js','src/domain/prediction-versions.js','src/domain/film-history.js','src/domain/prediction-quality.js','src/domain/scored-resolution.js','src/domain/resolution-acceptance.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/letterboxd-ratings.js','src/migration-export.js','src/prediction-diagnostics.js','src/feature-flags.js','src/mcp.js','src/continuation.js','src/worker.js'];
// One Worker context from the given server files (read from `root`, the repository by default).
export function loadContext({net,clock,FakeDate,crypto,root='.',files=SERVER_FILES,extra={}}){
 const context=vm.createContext({Response,Request,Headers,URL,URLSearchParams,AbortSignal,Date:FakeDate||Date,Intl,Map,Set,JSON,Math,TextEncoder,TextDecoder,Uint8Array,atob,btoa,encodeURIComponent,decodeURIComponent,structuredClone,crypto:crypto||webcrypto,console:{log(){},warn(){},error(){}},setTimeout,ASSETS:{},fetch:net.fetch,...extra});
 vm.runInContext(fs.readFileSync(root+'/src/domain/film-person.js','utf8'),context);
 for(const file of files){
  const path=root+'/'+file;if(!fs.existsSync(path))continue;
  vm.runInContext(fs.readFileSync(path,'utf8').replace('export default','globalThis.worker=').replace('export const DiscoveryContinuation','const DiscoveryContinuation'),context,{filename:file});
 }
 return context;
}
export function baseEnv(bucket,extra={}){return {BUCKET:bucket,LETTERBOXD_USERNAME:USER,EPG_XML_URL:'https://epg.test/guide.xml',...extra};}
export const SEPARATE={RATINGS_PIPELINE:'separate',LETTERBOXD_DIARY_HISTORY:'on',REMOVAL_RATING_LOOKUP:'on'};
export const plain=value=>JSON.parse(JSON.stringify(value));
// A top-level binding of the context (a `const` is not a property of the global object).
export const g=(context,name)=>vm.runInContext(name,context);
export const eventKeyOf=(at,id)=>'events/items/'+String(9999999999999-Date.parse(at)).padStart(13,'0')+'-'+id+'.json';
export const film=slug=>({id:slug,url:`https://letterboxd.com/film/${slug}/`});
// Migrated storage: a version 2 queue, a merge-form cursor and the witness, as ratings_storage_migrate leaves them.
export function migrated(bucket,{films={},cursor={}}={},at='2026-10-31T00:00:00.000Z'){
 bucket.set(QUEUE,{schemaVersion:2,films,droppedRefs:0,migratedAt:at});
 bucket.set(CURSOR,{schemaVersion:2,coverage:{newestWatchedDate:null,oldestWatchedDate:null,reachedEnd:false},resumePage:null,writer:{runId:'ratings-storage-migrate',step:'migrate'},...cursor});
 bucket.set(WITNESS,{schemaVersion:1,queue:{migratedAt:at},cursor:{migratedAt:at}});
}
// A seeded pseudo-random generator for the property tests.
export function seeded(seed){let state=seed>>>0;return ()=>{state=(state*1664525+1013904223)>>>0;return state/4294967296;};}
