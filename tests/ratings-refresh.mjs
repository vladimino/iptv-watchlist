import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

const records=new Map(),etags=new Map();let revision=0,fetches=[];
const bucket={
 async get(key){return records.has(key)?{etag:etags.get(key),json:async()=>structuredClone(records.get(key))}:null;},
 async put(key,value,options={}){
  if(key.endsWith('/mood-facet.json')&&bucket.delayLegacy){bucket.delayLegacy=false;await post({});}
  if(key==='enrichment/view-index.json'&&bucket.failIndex)throw new Error('index failed');
  if(key==='enrichment/view-index.json'&&bucket.stealIndex){bucket.stealIndex=false;const current=structuredClone(records.get(key)||{});current.rated={...(current.rated||{}),fingerprintHash:'keep'};records.set(key,current);etags.set(key,String(++revision));return null;}
  if(key==='enrichment/ratings/published.json'&&bucket.failPointer)throw new Error('pointer failed');
  if(key==='enrichment/diagnostics/rating-observations.json'&&bucket.failObservations)throw new Error('observations failed');
  if(key.startsWith('events/items/')&&bucket.failEvents)throw new Error('events unavailable');
  const condition=options.onlyIf;
  if(condition?.etagDoesNotMatch==='*'&&records.has(key)||condition?.etagMatches&&condition.etagMatches!==etags.get(key))return null;
  records.set(key,JSON.parse(value));etags.set(key,String(++revision));return {etag:etags.get(key)};
 },
 async list({prefix=''}={}){if(!bucket.listEvents)return {objects:[],truncated:false};const keys=[...records.keys()].filter(key=>key.startsWith(prefix)).sort();return {objects:keys.map(key=>({key})),truncated:false};}
};
const page=(films,next)=>`<h1 title="${films.length}&nbsp;films"></h1>`+films.map(film=>`<li class="griditem"><div data-postered-identifier='{&quot;lid&quot;:&quot;${film.id}&quot;}'></div>${film.stars?`<span class="rating rated-${film.stars}"></span>`:''}</li>`).join('')+(next?`<a class="next" href="${next}"></a>`:'');
const review=(slug,rating)=>`<script type="application/ld+json">{"@type":"Review","author":[{"sameAs":"https://letterboxd.com/demo-user/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}}</script>`;
let filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null),diaryHtml=()=>'<html>no diary table</html>',race=false,split=false,splitResult=null,clock=Date.now();
function Clock(...args){const date=args.length?new Date(...args):new Date(clock);Object.setPrototypeOf(date,Clock.prototype);return date;}
Clock.prototype=Date.prototype;Clock.now=()=>clock;Clock.parse=Date.parse;Clock.UTC=Date.UTC;
const ctx=vm.createContext({Response,Request,URL,Date:Clock,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async url=>{
 fetches.push(String(url));
 if(bucket.rejectFilms&&String(url).includes('letterboxd.com'))throw new Error('films fetch');
 if(split&&String(url).includes('/films/')){split=false;clock+=121000;splitResult=await post({});return {ok:true,status:200,text:async()=>filmsHtml()};}
 if(String(url).includes('/films/page/2/'))return {ok:false,status:403,text:async()=>'<title>Just a moment...</title>'};
 if(String(url).includes('/films/')){if(race)records.set('enrichment/films/rated/actual.json',{rating:5,source:'letterboxd',updatedAt:new Date(clock+5000).toISOString()});return {ok:true,status:200,text:async()=>filmsHtml()};}
 if(String(url).includes('/film/missing/'))throw new Error('lookup failed');
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
records.set('enrichment/ratings/lease.json',{id:'held',expiresAt:clock+60000});etags.set('enrichment/ratings/lease.json','held');
let busy=await post({});assert.equal(busy.status,409);assert.equal(busy.data.error,'Ratings refresh is already running');assert.equal(fetches.length,0);
records.delete('enrichment/ratings/lease.json');
filmsHtml=()=>'<html>partial</html>';
let broken=await post({});assert.equal(broken.status,200);assert.equal(broken.data.state,'degraded');assert.equal(broken.data.attempt.cause,'incomplete');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(records.get('enrichment/ratings/published.json'),undefined);
records.delete('enrichment/ratings/status.json');
bucket.failIndex=true;filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null);
let failed=await post({});assert.equal(failed.data.state,'degraded');assert.equal(failed.data.attempt.cause,'publish_failed');assert.equal(failed.data.generationId,null);assert.ok(failed.data.pendingGenerationId);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(records.get('enrichment/ratings/published.json'),undefined);
bucket.failIndex=false;bucket.rejectFilms=true;const failedFetches=fetches.length;let resumed=await post({});assert.equal(resumed.data.state,'healthy');assert.equal(resumed.data.generationId,failed.data.pendingGenerationId);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);assert.equal(fetches.length,failedFetches);bucket.rejectFilms=false;
for(const key of [...records.keys()])if(key.startsWith('enrichment/ratings/'))records.delete(key);records.set('enrichment/view-index.json',{rated:{actualRating:1}});
const before=snapshot();fetches.length=0;filmsHtml=()=>page([{id:'rated',stars:9}],'/demo-user/films/page/2/');
let blocked=await post({});assert.equal(blocked.data.state,'blocked');assert.equal(blocked.data.attempt.cause,'anti_bot');assert.match(blocked.data.attempt.error,/HTTP 403 on page 2/);assert.equal(blocked.data.diary.cause,'incomplete_page');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,1);assert.equal(fetches.length,3);
const afterBlock=fetches.length;let waited=await post({});assert.equal(waited.status,409);assert.equal(waited.data.skipped,'backoff');assert.equal(fetches.length,afterBlock);
records.delete('enrichment/ratings/status.json');fetches.length=0;filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null);diaryHtml=()=>'<html>no diary table</html>';
let fresh=await post({});assert.equal(fresh.data.state,'healthy');assert.equal(fresh.data.diary.state,'degraded');assert.equal(fresh.data.diary.cause,'incomplete_page');assert.equal(fresh.data.pages,1);assert.equal(fresh.data.watched,2);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);assert.equal(records.get('enrichment/ratings/published.json').projected,true);
const generation=records.get('enrichment/ratings/published.json').generationId;let again=await post({});assert.equal(again.data.state,'healthy');assert.equal(again.data.generationId,generation);assert.equal([...records.keys()].filter(key=>key.startsWith('enrichment/ratings/generations/')).length,1);
filmsHtml=()=>page([{id:'rated',stars:8},{id:'other',stars:8}],null);bucket.failIndex=true;let crashIndex=await post({});assert.equal(crashIndex.data.attempt.outcome,'failed');assert.equal(crashIndex.data.generationId,generation);assert.ok(crashIndex.data.pendingGenerationId);assert.equal(records.get('enrichment/ratings/published.json').generationId,generation);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);
bucket.failIndex=false;bucket.rejectFilms=true;const beforeRecovery=fetches.length;let recovered=await post({});assert.equal(recovered.data.state,'healthy');assert.equal(recovered.data.generationId,crashIndex.data.pendingGenerationId);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4);assert.equal(fetches.length,beforeRecovery);bucket.rejectFilms=false;
filmsHtml=()=>page([{id:'rated',stars:7},{id:'other',stars:8}],null);bucket.failPointer=true;let crashPointer=await post({});assert.equal(crashPointer.data.generationId,recovered.data.generationId);assert.ok(crashPointer.data.pendingGenerationId);assert.equal(records.get('enrichment/ratings/published.json').generationId,recovered.data.generationId);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,3.5);
bucket.failPointer=false;bucket.rejectFilms=true;const beforePointer=fetches.length;let recoveredPointer=await post({});assert.equal(recoveredPointer.data.generationId,crashPointer.data.pendingGenerationId);assert.equal(records.get('enrichment/ratings/published.json').generationId,crashPointer.data.pendingGenerationId);assert.equal(fetches.length,beforePointer);bucket.rejectFilms=false;
records.set('enrichment/diagnostics/baseline.json',{films:[{filmId:'rated'}]});bucket.failObservations=true;filmsHtml=()=>page([{id:'rated',stars:9},{id:'other',stars:8}],null);
let crashObservations=await post({});assert.equal(crashObservations.data.attempt.cause,'publish_failed');assert.equal(records.get('enrichment/ratings/published.json').generationId,crashObservations.data.generationId);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);assert.equal(records.get('enrichment/diagnostics/rating-observations.json'),undefined);
const keptObservation={filmId:'kept',before:1,after:2,source:'letterboxd_member_film',sourceUrl:'https://letterboxd.com/demo-user/film/kept/'};records.set('enrichment/diagnostics/rating-observations.json',[keptObservation]);etags.set('enrichment/diagnostics/rating-observations.json','kept');
bucket.failObservations=false;bucket.rejectFilms=true;const beforeObservations=fetches.length;let recoveredObservations=await post({});assert.equal(recoveredObservations.data.state,'healthy');assert.equal(recoveredObservations.data.generationId,crashObservations.data.generationId);assert.equal(fetches.length,beforeObservations);const observed=records.get('enrichment/diagnostics/rating-observations.json');assert.equal(observed.filter(item=>item.filmId==='kept'&&item.after===2).length,1);assert.equal(observed.filter(item=>item.filmId==='rated'&&item.after===4.5).length,1);bucket.rejectFilms=false;records.delete('enrichment/diagnostics/baseline.json');
filmsHtml=()=>page([{id:'rated',stars:10},{id:'other',stars:8}],null);bucket.stealIndex=true;let merged=await post({});assert.equal(merged.data.state,'healthy');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,5);assert.equal(records.get('enrichment/view-index.json').rated.fingerprintHash,'keep');
const beforeSplit=[...records.keys()].filter(key=>key.startsWith('enrichment/ratings/generations/')).length;filmsHtml=()=>page([{id:'rated',stars:8},{id:'other',stars:8}],null);split=true;let stale=await post({});assert.equal(stale.status,409);assert.equal(stale.data.error,'Ratings lease lost');assert.equal(splitResult.data.state,'healthy');assert.equal(records.get('enrichment/ratings/published.json').generationId,splitResult.data.generationId);assert.equal([...records.keys()].filter(key=>key.startsWith('enrichment/ratings/generations/')).length,beforeSplit+1);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4);
filmsHtml=()=>page([{id:'rated',stars:6},{id:'other',stars:8}],null);race=true;records.delete('enrichment/ratings/status.json');
let raced=await post({});assert.equal(raced.data.state,'healthy');assert.equal(records.get('enrichment/view-index.json').rated.actualRating,5);assert.deepEqual(raced.data.attempt.preservedFilmIds,['rated']);
const keptGeneration=records.get('enrichment/ratings/published.json').generationId,keptSuccess=raced.data.lastSuccessAt;
filmsHtml=()=>page([{id:'rated',stars:9}],'/demo-user/films/page/2/');fetches.length=0;
let later=await post({});assert.equal(later.data.state,'blocked');assert.equal(later.data.generationId,keptGeneration);assert.equal(later.data.lastSuccessAt,keptSuccess);assert.equal(records.get('enrichment/view-index.json').rated.actualRating,5);assert.equal(records.get('enrichment/ratings/published.json').generationId,keptGeneration);
let repair=await post({mode:'repair',filmIds:['removed']});assert.equal(repair.data.state,'blocked');assert.equal(repair.data.attempt.kind,'repair');assert.equal(repair.data.attempt.saved,1);assert.equal(repair.data.lastSuccessAt,keptSuccess);assert.equal(records.get('enrichment/view-index.json').removed.actualRating,3);
let repairAgain=await post({mode:'repair',filmIds:['removed']});assert.equal(repairAgain.data.attempt.unchanged,1);assert.equal(records.get('enrichment/view-index.json').removed.actualRating,3);
let repairFailed=await post({mode:'repair',filmIds:['missing']});assert.equal(repairFailed.data.attempt.outcome,'failed');assert.equal(repairFailed.data.state,'blocked');assert.equal(repairFailed.data.lastSuccessAt,keptSuccess);assert.equal(repairFailed.data.attempt.saved,0);
let repairPartial=await post({mode:'repair',filmIds:['removed','missing']});assert.equal(repairPartial.data.attempt.outcome,'partial');assert.equal(repairPartial.data.attempt.unchanged,1);assert.equal(repairPartial.data.state,'blocked');assert.equal(repairPartial.data.lastSuccessAt,keptSuccess);
records.delete('enrichment/films/rated/actual.json');records.delete('enrichment/ratings/status.json');race=false;filmsHtml=()=>page([{id:'rated',stars:8},{id:'other',stars:8}],null);bucket.delayLegacy=true;
await ctx.updateViewIndex(env,'rated',{fingerprintHash:'late',prediction:{predictedRating:2}});
const late=records.get('enrichment/view-index.json').rated;assert.equal(late.actualRating,4);assert.equal(late.fingerprintHash,'late');assert.equal(late.prediction.predictedRating,2);
assert.deepEqual(snapshot(),before);assert.equal(fetches.some(url=>url.includes('epg.test')),false);
const decorateAt='2026-10-23T18:00:00.000Z',decorateKey='events/items/'+String(9999999999999-Date.parse(decorateAt)).padStart(13,'0')+'-run-decorate-watchlist.json';
records.set(decorateKey,{id:'run-decorate-watchlist',type:'watchlist',at:decorateAt,total:0,added:[],removed:[{id:'rated',title:'Rated',year:2020},{id:'plain',title:'Plain',year:2019}]});etags.set(decorateKey,'event-1');
bucket.listEvents=true;bucket.failEvents=true;records.delete('enrichment/ratings/status.json');filmsHtml=()=>page([{id:'rated',stars:8},{id:'other',stars:8}],null);fetches.length=0;
let eventFailed=await post({});assert.equal(eventFailed.data.state,'healthy');assert.equal(eventFailed.data.attempt.outcome,'succeeded');assert.equal(eventFailed.data.attempt.cause,null);assert.equal(records.get('enrichment/ratings/published.json').projected,true);assert.equal(records.get(decorateKey).removed.every(film=>film.rating==null),true);assert.equal(fetches.filter(url=>url.includes('/films/')).length,1);assert.equal(fetches.some(url=>url.includes('/film/')&&!url.includes('/films/')),false);assert.equal(fetches.some(url=>url.includes('epg.test')),false);
bucket.failEvents=false;fetches.length=0;
await ctx.enrichRecentRemovalRatings(env,{rated:4},'2026-10-23T18:05:00.000Z');
const decorated=records.get(decorateKey);assert.equal(decorated.removed.find(film=>film.id==='rated').rating,4);assert.equal(decorated.removed.find(film=>film.id==='rated').ratingObservedAt,'2026-10-23T18:05:00.000Z');assert.equal(decorated.removed.find(film=>film.id==='plain').rating,undefined);
await ctx.enrichRecentRemovalRatings(env,{rated:2},'2026-10-23T19:00:00.000Z');
assert.equal(records.get(decorateKey).removed.find(film=>film.id==='rated').rating,4);assert.equal(records.get(decorateKey).removed.find(film=>film.id==='rated').ratingObservedAt,'2026-10-23T18:05:00.000Z');assert.equal([...records.keys()].filter(key=>key.includes('run-decorate-watchlist')).length,1);assert.equal(fetches.length,0);bucket.listEvents=false;
console.log('Ratings refresh: blocked films list, preserved snapshot, separate diary, and no EPG writes passed');
