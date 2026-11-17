import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// ADR 0074: the EPG commit hands removed films over and never looks them up. The direct per-film lookup that this file used to drive (ADR 0077) is gone from the Worker; the Ratings step keeps the same claim, outcome and backoff rules, proved by ratings-queue-v2.mjs and ratings-orchestration.mjs.
const records=new Map(),etags=new Map(),fetches=[];let revision=0;
const QUEUE='enrichment/removal-rating-lookups.json';
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(bucket.killOutcome&&key===QUEUE&&Object.values(JSON.parse(value).films).some(entry=>entry.lastResult&&entry.lastResult!=='claimed'))throw new Error('isolate killed');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix='',cursor,limit=20}={}){const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort();const offset=Number(cursor||0),slice=keys.slice(offset,offset+limit);return {objects:slice.map(key=>({key})),truncated:offset+limit<keys.length,cursor:String(offset+limit)};}
};
const review=(slug,rating)=>`<script type="application/ld+json">{"@type":"Review","author":[{"sameAs":"https://letterboxd.com/demo-user/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}}</script>`;
// Per-film page behavior by slug: a number is the owner's rating, 'none' a page without the owner's rating, 404, 403 or 429.
const pages=new Map();let diaryPage=null;
const diaryRow=(lid,stars,date)=>{const [y,m,d]=date.split('-');return `<tr class="diary-entry-row"><td><a href="/demo-user/diary/films/for/${y}/${m}/${d}/">${d}</a></td><td><div data-postered-identifier="{&quot;lid&quot;:&quot;${lid}&quot;}"></div></td><td>${stars?`<span class="rating rated-${stars}"></span>`:''}</td></tr>`;};
const ctx=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async url=>{
 url=String(url);fetches.push(url);
 if(url.includes('/films/'))return {ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 if(url.includes('/diary/'))return diaryPage?{ok:true,status:200,text:async()=>diaryPage}:{ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 const slug=url.match(/\/film\/([a-z0-9-]+)\/$/)?.[1],page=pages.get(slug);
 if(page===403||page===429)return {ok:false,status:page,text:async()=>'<title>Just a moment...</title>'};
 if(typeof page==='number')return {ok:true,status:200,text:async()=>review(slug,page)};
 if(page==='none')return {ok:true,status:200,text:async()=>'<html>no review</html>'};
 return {ok:false,status:404,text:async()=>''};
}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/domain/prediction-confidence.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const off={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};
const env={...off,REMOVAL_RATING_LOOKUP:'on'};
const film=slug=>({id:'lb-'+slug,url:`https://letterboxd.com/film/${slug}/`});
const memberPages=()=>fetches.filter(url=>/\/demo-user\/film\//.test(url));
const queue=()=>records.get(QUEUE);
const plain=value=>JSON.parse(JSON.stringify(value));
const T0=Date.parse('2026-10-29T10:00:00.000Z'),H=3600000;

const at='2026-10-29T09:00:00.000Z';

// 10. The worker hands over only the films removed in this diff, with their Letterboxd URL.
assert.deepEqual(plain(vm.runInContext('removalLookupFilm',ctx)({id:'x',url:'https://letterboxd.com/film/x/',title:'X'})),{id:'x',url:'https://letterboxd.com/film/x/'});
assert.equal(vm.runInContext('removalLookupFilm',ctx)({id:'x',url:'https://letterboxd.com/demo-user/film/x/'}),null);
const source=fs.readFileSync('src/worker.js','utf8');
assert.match(source,/removed\.has\(String\(film\.id\)\)\)\.map\(removalLookupFilm\)/,'the hand-over is built from the removed ids of this run');

// 11. A hand-over left on a completed run is not looked up by the next step while migration is not complete (ADR 0074).
// The direct lookup above still rates a film, and a killed lookup still leaves the claim.
records.delete(QUEUE);fetches.length=0;pages.set('crash',3.5);
const crashEvent={id:'run-2-watchlist',type:'watchlist',at,total:0,baseline:false,added:[],removed:[{id:'lb-crash',title:'Crash',year:2018}]};
const crashReport={runId:'run-2',updatedAt:at,watchlistCount:0,films:[],stats:{}};
const crashRun={runId:'run-2',stage:'epg',events:[structuredClone(crashEvent)],ratingPending:['letterboxd-diary'],watchlist:[],pending:[],removalLookups:[film('crash')]};
await ctx.finishSync(env,crashRun,crashReport);
let saved=records.get('sync.json');
assert.equal(saved.stage,'complete');
assert.deepEqual(plain(saved.removalLookups),[film('crash')],'the hand-over survives in sync.json');
assert.equal(records.has(QUEUE),false,'nothing was queued');
const step={caller:'http',diagnostic:{}};
try{await ctx.syncStep(env,'/api/sync/epg',{runId:'run-2'},step);}catch{}
assert.equal(step.branch,'delegated');
assert.equal(records.has(QUEUE),false,'the continuation does not look up or enqueue');
saved=records.get('sync.json');
assert.deepEqual(plain(saved.removalLookups),[film('crash')]);
assert.equal(memberPages().length,0);
fetches.length=0;
try{await ctx.syncStep(env,'/api/sync/epg',{runId:'run-2'},{caller:'http',diagnostic:{}});}catch{}
assert.equal(memberPages().length,0,'a further step still requests nothing');
assert.deepEqual(plain(records.get('sync.json').removalLookups),[film('crash')]);

console.log('Removal hand-over (ADR 0074): only the films removed in this diff are handed over with their Letterboxd URL, and a hand-over left on a completed run is neither looked up nor enqueued by the next step');
