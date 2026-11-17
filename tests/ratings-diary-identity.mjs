// AIR-489 / ADR 0160: the Ratings run with the bounded same-run identity check. Fixtures use the ids `vMEO` (3.5) and `Aj8u` (4.0) only; their movie is NOT assumed.
// Synthetic pages and a stub D1 canonical writer; nothing here calls Letterboxd, TMDB or a production store.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {scoped,scopedReplacing} from '../scripts/bundle-scope.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,diaryPage,diaryRow,migrated,RUN,SEPARATE,plain,g,SERVER_FILES} from './ratings-harness.mjs';

const T0=Date.parse('2026-11-17T16:00:00.000Z');
const canonical={applied:[],gate:{mode:'d1',state:'open',generation:2},bridge:{}};
const stubs={
 CanonicalCatalogReader:{catalogReaderGate:async()=>canonical.gate,catalogFilmIdentityBridge:async(env,lid)=>canonical.bridge[lid]||{state:'absent'},catalogTitlesFromD1:async()=>({}),catalogMetadataFromD1:async()=>({}),catalogReaderStill:async()=>{},
  readAdmissions:async(env,ids)=>new Map(ids.map(id=>{const entry=bucketOf.value('letterboxd/admissions/verified-films.json')?.films?.['tmdb_'+id.slice(10)];return [id,{ratedAdmission:entry?{title:entry.title,year:entry.year}:null}];}))},
 CanonicalRatedAdmission:{applyRatedAdmissionRetention:async(env,input)=>{canonical.applied.push(input);return {state:'complete',failed:0,unknown:0,preflightFailed:0,deferred:0,refused:0};},assertRatedAdmissionAccepted:out=>out},
};
let bucketOf=null;
const filmPage=({lid,slug,title,year,tmdb})=>`<html><head><link rel="canonical" href="https://letterboxd.com/film/${slug}/"><link rel="shortlink" href="https://boxd.it/${lid}"><meta property="og:title" content="${title} (${year})"><script type="application/ld+json">${JSON.stringify({name:title,releasedEvent:[{startDate:String(year)}]})}</script></head><body class="film" data-tmdb-type="movie" data-tmdb-id="${tmdb}"></body></html>`;
function setup(){
 const {clock,FakeDate,crypto}=makeClock(T0),net=makeNetwork(),bucket=makeBucket();bucketOf=bucket;
 const web=new Map(),movies=new Map();canonical.applied.length=0;canonical.bridge={};canonical.gate={mode:'d1',state:'open',generation:2};
 const base=net.fetch;
 net.fetch=async(input,init)=>{
  const url=String(input);net.fetches.push(url);
  const boxd=/^https:\/\/boxd\.it\/([A-Za-z0-9]+)$/.exec(url);
  if(boxd){const item=web.get(boxd[1]);if(!item)return new Response('',{status:404});if(item.status)return new Response('',{status:item.status});return new Response('',{status:301,headers:{location:'https://letterboxd.com/film/'+item.slug+'/'}});}
  const film=/^https:\/\/letterboxd\.com\/film\/([a-z0-9-]+)\/$/.exec(url);
  if(film){const item=[...web.values()].find(entry=>entry.slug===film[1]);return item&&item.html?new Response(item.html):new Response('',{status:404});}
  const tm=/api\.themoviedb\.org\/3\/movie\/(\d+)/.exec(url);if(tm)return movies.has(tm[1])?new Response(movies.get(tm[1])):new Response('',{status:404});
  net.fetches.pop();return base(input,init);
 };
 const ctx=loadContext({net,clock,FakeDate,crypto,extra:stubs});
 vm.runInContext('globalThis.__x=1',ctx);
 vm.runInContext('"use strict";'+fs.readFileSync('src/domain/tmdb-tv-identity.js','utf8'),ctx);
 vm.runInContext(scoped('src/letterboxd-match.js','LetterboxdMatch')+'\n'+scopedReplacing('src/letterboxd-identity.js','LetterboxdIdentity','const normTitle=LetterboxdMatch.normTitle;\n')+'\n'+scoped('src/domain/letterboxd-rated-admission.js','LetterboxdRatedAdmission'),ctx);
 for(const file of ['src/letterboxd-rated-candidates.js','src/letterboxd-diary-identity.js'])vm.runInContext(fs.readFileSync(file,'utf8'),ctx);
 const env=baseEnv(bucket,{...SEPARATE,TMDB_API_READ_ACCESS_TOKEN:'fixture-token'});
 const add=(lid,slug,tmdb,title,year)=>{web.set(lid,{slug,html:filmPage({lid,slug,title,year,tmdb})});movies.set(tmdb,JSON.stringify({id:Number(tmdb),title,original_title:title,release_date:year+'-05-01'}));};
 return {clock,net,bucket,ctx,env,web,add,R:g(ctx,'LetterboxdRatings')};
}
async function runOnce(R,env,clock){
 const started=plain(await R.start(env,{trigger:'scheduled'}));assert.equal(started.created,true,JSON.stringify(started));
 let reply;for(let i=0;i<30;i++){reply=plain(await R.step(env,{runId:started.runId}));clock.now+=1000;if(reply.nextAction!=='continue')break;}
 return {reply};
}
const ratingsEvents=bucket=>[...bucket.records.keys()].filter(key=>key.startsWith('events/items/')).sort().map(key=>bucket.records.get(key)).filter(event=>event.type==='ratings');
const page=(...rows)=>diaryPage(rows);

// 1. A new rated-only id: verified in the same run, the event and the run record carry the title, the rating fact is untouched.
{
 const {clock,net,bucket,env,add,R}=setup();migrated(bucket,{films:{}});
 add('vMEO','vmeo','900001','Fixture Alpha',2023);
 net.diary.set(1,page(diaryRow('vMEO',7,'2026-11-15','1587643799')));
 const {reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 const run=bucket.value(RUN),added=run.diary.pageChanges['1'].added[0];
 assert.deepEqual([added.id,added.title,added.year,added.tmdb,added.rating],['vMEO','Fixture Alpha',2023,'900001',3.5],'the label is on the planned film before the event is finalised');
 assert.equal(run.diary.identity.verified,1);
 const event=ratingsEvents(bucket)[0];assert.equal(event.details.added[0].title,'Fixture Alpha');assert.equal(event.details.added[0].tmdb,'900001');
 const record=bucket.value('letterboxd/facts/films/lb-vMEO.json');assert.equal(record.rating.value,3.5);assert.equal(record.links.tmdb,'900001');
 assert.equal(bucket.value('enrichment/view-index.json').tmdb_900001.watched,true,'Finds sees the watched movie by its TMDB id');
 assert.equal(canonical.applied.length,1);
 // a replay of the same page: no second admission, no second source request, the same facts.
 const calls=net.fetches.filter(url=>url.startsWith('https://boxd.it/')).length;
 clock.now+=3600000;const again=await runOnce(R,env,clock);assert.equal(again.reply.state,'finished');
 assert.equal(net.fetches.filter(url=>url.startsWith('https://boxd.it/')).length,calls,'an id already bridged is not requested again');assert.equal(canonical.applied.length,1);
}

// 2. The source says 403: the run still finishes, the rating is stored, the event is honest (no title), the id waits for an ordinary later run.
{
 const {clock,net,bucket,env,add,web,R,ctx}=setup();migrated(bucket,{films:{}});
 web.set('Aj8u',{slug:'ajzu',status:403});
 net.diary.set(1,page(diaryRow('Aj8u',8,'2026-11-17','1600000001')));
 const {reply}=await runOnce(R,env,clock);
 assert.equal(reply.state,'finished',JSON.stringify(reply));
 const run=bucket.value(RUN);assert.equal(run.diary.pageChanges['1'].added[0].title,null);assert.equal(run.diary.pageChanges['1'].added[0].rating,4);
 assert.equal(run.diary.identity.pending,1);assert.equal(bucket.value('letterboxd/facts/films/lb-Aj8u.json').rating.value,4);
 const pending=bucket.value('letterboxd/facts/scans/diary-identity.json').films.Aj8u;assert.equal(pending.reason,'forbidden');assert.equal(canonical.applied.length,0);
 // 3. read side: after a later verified check, the stored event is presented with the title and is not rewritten.
 add('Aj8u','ajzu','900002','Fixture Beta',2024);
 clock.now+=3*3600000;
 const out=await g(ctx,'LetterboxdDiaryIdentity').resolve(env,[{lid:'Aj8u',slug:'ajzu'}],{clock:()=>clock.now,remaining:()=>120000,fetchImpl:net.fetch});
 assert.equal(out.counts.verified,1);
 const key=[...bucket.records.keys()].find(k=>k.startsWith('events/items/')&&bucket.records.get(k).type==='ratings'),stored=JSON.stringify(bucket.records.get(key));
 const page1=plain(await vm.runInContext('eventPage',ctx)(env,null));
 const shown=page1.events.find(event=>event.type==='ratings').details.added[0];
 assert.deepEqual([shown.title,shown.tmdb],['Fixture Beta','900002'],'historical event presented through the verified bridge');
 assert.equal(JSON.stringify(bucket.records.get(key)),stored,'the stored event is not rewritten');
}
console.log('ratings-diary-identity: ok');
