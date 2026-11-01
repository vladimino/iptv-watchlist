import fs from 'node:fs';import vm from 'node:vm';import assert from 'node:assert/strict';import {webcrypto} from 'node:crypto';
import {scoped} from '../scripts/bundle-scope.mjs';
const records=new Map(),film=id=>({id,url:'https://letterboxd.com/film/'+id+'/',title:id,original:id,year:2020,genres:[],shows:[]});
const report={runId:'published',films:[film('rated'),film('unrated'),film('broken')]};records.set('programme.json',structuredClone(report));
const review=(slug,rating)=>`<script type="application/ld+json">/* <![CDATA[ */ {"@type":"Review","author":[{"sameAs":"https://letterboxd.com/demo-user/"}],"itemReviewed":{"sameAs":"https://letterboxd.com/film/${slug}/"},"reviewRating":{"ratingValue":${rating}}} /* ]]> */</script>`;
const ctx=vm.createContext({Response,Request,URL,Date,Map,Set,JSON,TextEncoder,Uint8Array,AbortSignal,crypto:webcrypto,console,setTimeout:fn=>fn(),fetch:async url=>url.includes('/rated/')?{ok:true,status:200,text:async()=>review('rated',4.5)}:url.includes('/unrated/')?{ok:false,status:404}:{ok:false,status:503}});
const env={LETTERBOXD_USERNAME:'demo-user',EPG_XML_URL:'https://example.test/epg.xml',BUCKET:{get:async key=>records.has(key)?{json:async()=>structuredClone(records.get(key))}:null,put:async(key,value)=>{records.set(key,JSON.parse(value));}}};
vm.runInContext(fs.readFileSync('src/domain/film-person.js','utf8'),ctx);vm.runInContext(scoped('src/metadata-cache.js','MetadataCache'),ctx);for(const file of ['src/sources.js','src/discovery.js','src/letterboxd-facts.js','src/enrichment.js','src/letterboxd-diary.js','src/worker.js'])vm.runInContext(fs.readFileSync(file,'utf8').replace('export default','globalThis.worker='),ctx);
async function call(body){const r=await ctx.worker.fetch(new Request('https://site.example/api/enrichment/ratings/backfill',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),env);return {status:r.status,data:await r.json()};}
let r=await call({cursor:0,batchSize:3});assert.equal(r.status,200);assert.equal(r.data.total,3);assert.equal(r.data.done,true);assert.equal(r.data.results.find(x=>x.filmId==='rated').status,'saved');assert.equal(r.data.results.find(x=>x.filmId==='rated').rating,4.5);assert.equal(r.data.results.find(x=>x.filmId==='unrated').status,'not_found');assert(r.data.results.find(x=>x.filmId==='broken').error);assert.equal(records.get('enrichment/films/rated/actual.json').rating,4.5);assert(!records.has('enrichment/films/unrated/actual.json'));assert.deepEqual(records.get('programme.json'),report);
assert.equal((await call({cursor:0,batchSize:3,programmeRunId:'other'})).status,409);
assert.equal(vm.runInContext(`parsePersonalRating(${JSON.stringify(review('wrong',5))},'https://letterboxd.com/film/rated/','demo-user')`,ctx),null);
// A repeated lookup is a newer observation of the same rating (ADR-0023): the fact moves on, the value does not.
r=await call({cursor:1,batchSize:1});assert.equal(r.data.results[0].status,'saved');assert.equal(r.data.results[0].rating,4.5);assert.equal(records.get('enrichment/films/rated/actual.json').rating,4.5);
const listing='<h1 title="2&nbsp;films">Watched</h1><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;rated&quot;}\'></div><p class="poster-viewingdata"><span class="rating rated-9">★★★★½</span></p></li><li class="griditem"><div data-postered-identifier=\'{&quot;lid&quot;:&quot;unrated&quot;}\'></div></li>';
assert.equal(vm.runInContext(`parsePublicFilmsPage(${JSON.stringify(listing)},'demo-user').entries.length`,ctx),2);
ctx.fetch=async()=>({ok:true,status:200,text:async()=>listing});
const run={runId:'published',stage:'epg',watchlist:report.films,pending:[],ratingPending:['public-films-list'],events:[]};ctx.run=run;ctx.report=report;ctx.env=env;
const fetched=[];ctx.fetch=async url=>{fetched.push(String(url));return {ok:true,status:200,text:async()=>listing};};
const completed=await vm.runInContext('completeWithRatings(env,run,report)',ctx);assert.equal(records.get('sync.json').stage,'complete');
// ADR 0074: the EPG commit requests nothing from Letterboxd and opens no ratings attempt.
assert.equal(fetched.length,0,'no films-list request');assert.equal(completed.personalRatings,undefined);
assert.equal(completed.ratingsPipeline,'blocked');
assert.equal(records.get('sync.json').ratingAttempt,undefined);assert.equal(records.get('sync.json').ratingPending,undefined);assert.deepEqual(records.get('programme.json'),report);
ctx.fetch=async()=>({ok:true,status:200,text:async()=>listing});
records.set('watchlist.json',{films:[film('rated')]});const poster=id=>`<div data-component-class="LazyPoster" data-item-name="${id} (2020)" data-item-link="/film/${id}/" data-postered-identifier='{"lid":"${id}"}'></div>`;const watchlistHtml='<span class="js-watchlist-count">2</span>'+poster('rated')+poster('new');ctx.getHTML=async()=>watchlistHtml;const syncStart=await vm.runInContext('beginSync(env)',ctx);assert.equal(syncStart.watchlistCount,2);assert.equal(records.get('sync.json').ratingPending,undefined);
records.set('enrichment/diagnostics/baseline.json',{films:[{filmId:'rated',letterboxdUri:'https://letterboxd.com/film/rated/',actualAtFreeze:null}]});records.set('enrichment/view-index.json',{...(records.get('enrichment/view-index.json')||{}),rated:{actualRating:null},unrated:{actualRating:null},broken:{actualRating:null}});
await vm.runInContext('refreshRatingsFromFilms(env,{runId:"after",films:[{id:"unrated"}]})',ctx);
assert.equal(records.get('enrichment/view-index.json').rated.actualRating,4.5);
// The direct scan writes a fact observation of the films list; the legacy observation log is read-only history (ADR 0055).
const ratedFact=records.get('letterboxd/facts/films/lb-rated.json');assert.equal(ratedFact.rating.value,4.5);assert.equal(ratedFact.rating.source,'letterboxd_films_list');
assert.equal(records.has('enrichment/diagnostics/rating-observations.json'),false);
console.log('Ratings: exact film/user identity, public-films listing parser and direct scan, half-star values, programme isolation, and no films-list request from the EPG commit passed');
