import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,fetches=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(key==='enrichment/ratings/published.json'&&bucket.failPointer)throw new Error('pointer failed');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list(){return {objects:[],truncated:false};}
};
const page=(films,next)=>`<h1 title="${films.length}&nbsp;films"></h1>`+films.map(film=>`<li class="griditem"><div data-postered-identifier='{&quot;lid&quot;:&quot;${film.id}&quot;}'></div>${film.stars?`<span class="rating rated-${film.stars}"></span>`:''}</li>`).join('')+(next?`<a class="next" href="${next}"></a>`:'');
const review=(slug,rating)=>`<script type="application/ld+json">{"@type":"Review","author":[{"sameAs":"https://letterboxd.com/demo-user/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}}</script>`;
let filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null),diaryHtml=()=>'<html>no diary table</html>',race=false;
const ctx=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async url=>{
 fetches.push(String(url));
 if(String(url).includes('/films/page/2/'))return {ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 if(String(url).includes('/films/')){if(race)records.set('enrichment/films/rated/actual.json',{rating:5,source:'letterboxd',updatedAt:new Date(Date.now()+5000).toISOString()});return {ok:true,status:200,text:async()=>filmsHtml()};}
 if(String(url).includes('/diary/'))return {ok:true,status:200,text:async()=>diaryHtml()};
 if(String(url).includes('/film/removed/'))return {ok:true,status:200,text:async()=>review('removed',3)};
 return {ok:false,status:404,text:async()=>''};
}});
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);
for(const file of ['src/sources.js','src/discovery.js','src/enrichment.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
const env={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://epg.test/guide.xml',BUCKET:bucket};
const film={id:'rated',url:'https://letterboxd.com/film/rated/',title:'Rated',original:'Rated',year:2020,genres:[],shows:[]};
records.set('programme.json',{runId:'run-1',films:[film]});
records.set('watchlist.json',{films:[film]});
records.set('sync.json',{runId:'run-1',stage:'complete',ratingPending:['public-films-list']});
records.set('enrichment/prediction-queue.json',{pendingCount:1});
records.set('events/items/1.json',{id:'keep'});
records.set('enrichment/view-index.json',{rated:{actualRating:1}});
function snapshot(){return ['programme.json','watchlist.json','sync.json','enrichment/prediction-queue.json','events/items/1.json'].map(key=>JSON.stringify(records.get(key)));}
async function post(body,extra={}){
 const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/ratings/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),{...env,...extra});
 return {status:response.status,data:await response.json()};
}
async function status(){const response=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/ratings/status'),env);return {status:response.status,data:await response.json()};}

let idle=await status();assert.equal(idle.status,200);assert.equal(idle.data.state,'idle');assert.equal(idle.data.enabled,false);
let off=await post({});assert.equal(off.status,409);assert.equal(off.data.error,'Ratings refresh is off');assert.equal(fetches.length,0);
env.RATINGS_REFRESH='on';
records.set('enrichment/ratings/lease.json',{id:'held',expiresAt:Date.now()+60000});etags.set('enrichment/ratings/lease.json','held');
let busy=await post({});assert.equal(busy.status,409);assert.equal(busy.data.error,'Ratings refresh is already running');assert.equal(fetches.length,0);
records.delete('enrichment/ratings/lease.json');
filmsHtml=()=>'<html>partial</html>';
let broken=await post({});assert.equal(broken.status,200);assert.equal(broken.data.state,'degraded');assert.equal(broken.data.attempt.cause,'incomplete');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(records.get('enrichment/ratings/published.json'),undefined);
records.delete('enrichment/ratings/status.json');
bucket.failPointer=true;filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null);
let failed=await post({});assert.equal(failed.data.state,'degraded');assert.equal(failed.data.attempt.cause,'publish_failed');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(records.get('enrichment/ratings/published.json'),undefined);
bucket.failPointer=false;for(const key of [...records.keys()])if(key.startsWith('enrichment/ratings/'))records.delete(key);
const before=snapshot();fetches.length=0;filmsHtml=()=>page([{id:'rated',stars:9}],'/demo-user/films/page/2/');
let blocked=await post({});assert.equal(blocked.data.state,'blocked');assert.equal(blocked.data.attempt.cause,'anti_bot');assert.match(blocked.data.attempt.error,/HTTP 403 on page 2/);assert.equal(blocked.data.diary.cause,'incomplete_page');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(fetches.length,3);
const afterBlock=fetches.length;let waited=await post({});assert.equal(waited.status,409);assert.equal(waited.data.skipped,'backoff');assert.equal(fetches.length,afterBlock);
records.delete('enrichment/ratings/status.json');fetches.length=0;filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null);diaryHtml=()=>'<html>no diary table</html>';
let fresh=await post({});assert.equal(fresh.data.state,'healthy');assert.equal(fresh.data.diary.state,'degraded');assert.equal(fresh.data.diary.cause,'incomplete_page');assert.equal(fresh.data.pages,1);assert.equal(fresh.data.watched,2);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);assert.equal(records.get('enrichment/ratings/published.json').projected,true);
const generation=records.get('enrichment/ratings/published.json').generationId;let again=await post({});assert.equal(again.data.state,'healthy');assert.equal(again.data.generationId,generation);assert.equal([...records.keys()].filter(key=>key.startsWith('enrichment/ratings/generations/')).length,1);
filmsHtml=()=>page([{id:'rated',stars:6},{id:'other',stars:8}],null);race=true;records.delete('enrichment/ratings/status.json');
let raced=await post({});assert.equal(raced.data.state,'healthy');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,5);assert.deepEqual(raced.data.attempt.preservedFilmIds,['rated']);
const keptGeneration=records.get('enrichment/ratings/published.json').generationId,keptSuccess=raced.data.lastSuccessAt;
filmsHtml=()=>page([{id:'rated',stars:9}],'/demo-user/films/page/2/');fetches.length=0;
let later=await post({});assert.equal(later.data.state,'blocked');assert.equal(later.data.generationId,keptGeneration);assert.equal(later.data.lastSuccessAt,keptSuccess);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,5);assert.equal(records.get('enrichment/ratings/published.json').generationId,keptGeneration);
let repair=await post({mode:'repair',filmIds:['removed']});assert.equal(repair.data.state,'blocked');assert.equal(repair.data.attempt.kind,'repair');assert.equal(repair.data.attempt.saved,1);assert.equal(repair.data.lastSuccessAt,keptSuccess);assert.equal(records.get('enrichment/view-index.json').removed.actualRating,3);
let repairAgain=await post({mode:'repair',filmIds:['removed']});assert.equal(repairAgain.data.attempt.unchanged,1);assert.equal(records.get('enrichment/view-index.json').removed.actualRating,3);
assert.deepEqual(snapshot(),before);assert.equal(fetches.some(url=>url.includes('epg.test')),false);
console.log('Ratings refresh: blocked films list, preserved snapshot, separate diary, and no EPG writes passed');
