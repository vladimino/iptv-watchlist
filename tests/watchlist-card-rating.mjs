// AIR-419. Diary fact for lid 1Vuo / TMDB 10750 must appear as «Моя оценка» on the main watchlist card
// next to an independent prediction. Offline: D1 ratings_view, overlay, GET /api/enrichment/view, card HTML.
// Nothing here calls Cloudflare, Letterboxd or production.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as RatingsD1 from '../src/ratings-d1.js';
import {d1Standin} from './d1-standin.mjs';
import {makeBucket,makeClock,makeNetwork,loadContext,baseEnv,SEPARATE,g} from './ratings-harness.mjs';

const LID='1Vuo',TMDB='10750',ALIAS='tmdb_'+TMDB,OTHER='9zzz';
const FILM={id:LID,tmdbId:TMDB,title:'Игрушечные солдатики',original:'Toy Soldiers',year:1991,runtime:112,genres:['Боевик'],shows:[],directors:[],actors:[],url:'https://letterboxd.com/film/toy-soldiers/'};
const OTHER_FILM={id:OTHER,tmdbId:'999001',title:'Другой',original:'Other',year:1990,runtime:90,genres:['Драма'],shows:[],directors:[],actors:[]};
const PREDICTION={predictedRating:4,probability4Plus:0.4,confidence:'medium',moodIds:[]};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'iptv-air-419-'));
let n=0;
const migrations=['0001_schema_v1','0002_generation_stage','0003_candidate_show_identity','0004_projection_state','0005_film_sync_state','0006_metadata_cache','0007_prediction_authority','0008_published_epg_authority'];
function openDb(){
 const db=d1Standin(path.join(root,'r-'+(n++)+'.sqlite'));
 for(const name of migrations)db.sql(fs.readFileSync('migrations/'+name+'.sql','utf8'));
 db.sql(fs.readFileSync('migrations/0010_ratings_authority.sql','utf8'));
 db.sql("UPDATE ratings_domain_authority SET mode='d1', cutover='open'");
 return db;
}
function world(){
 const db=openDb(),{clock,FakeDate,crypto}=makeClock(Date.parse('2026-11-10T16:01:00.000Z')),bucket=makeBucket(),net=makeNetwork();
 const ctx=loadContext({net,clock,FakeDate,crypto,extra:{RatingsD1}});
 const env=baseEnv(bucket,{...SEPARATE,DB:db,RATINGS_DB_REQUIRED:'on'});
 bucket.set('enrichment/view-index.json',{[LID]:{prediction:PREDICTION},[OTHER]:{prediction:{predictedRating:2.5,probability4Plus:0.1}}});
 bucket.set('programme.json',{runId:'run-air-419',updatedAt:'2026-11-10T16:00:00.000Z',watchlistCount:2,films:[FILM,OTHER_FILM],stats:{}});
 bucket.set('watchlist.json',{updatedAt:'2026-11-10T16:00:00.000Z',films:[FILM,OTHER_FILM]});
 return {db,bucket,ctx,env,Facts:g(ctx,'LetterboxdFacts'),worker:g(ctx,'worker')};
}
async function diary(Facts,env,{lid,tmdb,rating,watchedDate='2026-11-09'}){
 if(tmdb)await Facts.applyWatchlistScan(env,{scanId:'wl-'+lid,observedAt:'2026-11-10T15:00:00.000Z',films:[{id:lid,tmdbId:String(tmdb)}]});
 return Facts.applyDiaryEvidence(env,[{lid,watchedDate,rating,sourceRef:'diary:viewing:'+lid,readAt:'2026-11-10T16:01:00.000Z'}]);
}
async function viewGet(worker,env){
 const response=await worker.fetch(new Request('http://127.0.0.1/api/enrichment/view'),env);
 assert.equal(response.status,200);
 return response.json();
}
function renderCard(film,films){
 const ctx=vm.createContext({Date,Intl,Set,Map,document:{querySelector:()=>({})}});
 vm.runInContext(fs.readFileSync('public/return-home.js','utf8')+fs.readFileSync('public/app.js','utf8').replace(/init\(\);\s*$/,''),ctx);
 ctx.film=film;
 ctx.input={profile:null,films};
 vm.runInContext('enrichment=input',ctx);
 return vm.runInContext('card(film)',ctx);
}
function assertActualAndForecast(html,actual,forecast){
 assert.match(html,new RegExp('<span>МОЯ ОЦЕНКА</span><strong>'+actual.toFixed(1)+'</strong>'));
 assert.match(html,new RegExp('<span>ПРОГНОЗ</span><strong>'+forecast.toFixed(1)+'</strong>'));
}
function assertNoActual(html){assert.doesNotMatch(html,/<span>МОЯ ОЦЕНКА<\/span>/);}
const q=value=>"'"+String(value).replace(/'/g,"''")+"'";
function fillView(db,count){
 const now='2026-11-01T00:00:00.000Z';
 const rows=[];
 for(let i=0;i<count;i++)rows.push('('+[q('z'+String(i).padStart(5,'0')),q('filler-'+i),'NULL','NULL','NULL',0,q(now)].join(',')+')');
 for(let s=0;s<rows.length;s+=400)db.sql('INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES '+rows.slice(s,s+400).join(',')+';');
}

// 1. Reproduction: Diary lid 1Vuo with verified TMDB 10750, D1 projection, GET view, watchlist card HTML.
{
 const {db,bucket,ctx,env,Facts,worker}=world();
 fillView(db,RatingsD1.RATINGS_OVERLAY_PAGE*3+50);
 const written=await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:3.5});
 assert.equal(written.written,1);
 assert.equal(written.changes[0].lid,LID);
 assert.equal(String(written.changes[0].tmdb),TMDB);
 const aliases=db.sql("SELECT alias_id, actual_rating, rating_known, watched FROM ratings_view WHERE alias_id IN ('1Vuo','tmdb_10750') ORDER BY alias_id");
 assert.deepEqual(aliases.map(row=>[row.alias_id,row.actual_rating,row.rating_known,row.watched]),[[LID,3.5,1,1],[ALIAS,3.5,1,1]]);
 const writesBefore=bucket.writes().length,batchesBefore=db.calls.batches;
 const data=await viewGet(worker,env);
 assert.equal(data.films[LID].actualRating,3.5);
 assert.equal(data.films[LID].watched,true);
 assert.equal(data.films[LID].prediction.predictedRating,4);
 assert.equal(data.films[ALIAS].actualRating,3.5);
 const html=renderCard(FILM,data.films);
 assertActualAndForecast(html,3.5,4);
 assert.equal(bucket.writes().length,writesBefore,'GET view writes no R2 object');
 assert.equal(db.calls.batches,batchesBefore,'GET view writes no D1 batch');
 const again=await viewGet(worker,env);
 assert.equal(again.films[LID].actualRating,3.5);
 assert.equal(JSON.stringify(again.films[LID]),JSON.stringify(data.films[LID]));
 assert.equal(bucket.writes().length,writesBefore);
 assert.doesNotMatch(renderCard(OTHER_FILM,data.films),/<span>МОЯ ОЦЕНКА<\/span><strong>3\.5<\/strong>/);
}

// 2. Overlay pages past a truncated unbounded .all(): fillers sort after 1Vuo, the lid is still applied.
{
 const db=openDb();
 fillView(db,1100);
 const now='2026-11-10T16:01:00.000Z';
 db.sql("INSERT INTO ratings_view (alias_id,fact_key,watched,actual_rating,watchlist,rating_known,updated_at) VALUES ('1Vuo','tmdb-10750',1,3.5,1,1,"+q(now)+"),('tmdb_10750','tmdb-10750',1,3.5,1,1,"+q(now)+")");
 const orig=db.prepare.bind(db);
 db.prepare=sql=>{
  const prepared=orig(sql);
  const wrap=statement=>{
   const all=statement.all.bind(statement);
   statement.all=async()=>{
    const out=await all();
    if(!/\bLIMIT\b/i.test(String(sql)))return {results:(out.results||[]).slice(0,1000)};
    return out;
   };
   return statement;
  };
  return {bind(...params){return wrap(prepared.bind(...params));},first(){return prepared.first();},all(){return wrap(prepared).all();},run(){return prepared.run();}};
 };
 const overlaid=await RatingsD1.overlayView({DB:db},{[LID]:{prediction:PREDICTION,actualRating:9}});
 assert.equal(overlaid[LID].actualRating,3.5);
 assert.equal(overlaid[LID].prediction.predictedRating,4);
 assert.equal(overlaid[ALIAS].actualRating,3.5);
 assert.equal(overlaid[LID].actualRating===9,false);
}

// 3. Lid-only, no TMDB: the card still shows the rating on the Letterboxd id.
{
 const {env,Facts,worker}=world();
 await diary(Facts,env,{lid:LID,rating:3.5});
 const data=await viewGet(worker,env);
 assert.equal(data.films[LID].actualRating,3.5);
 assert.equal(data.films[ALIAS],undefined);
 assertActualAndForecast(renderCard({...FILM,tmdbId:null},data.films),3.5,4);
}

// 4. Alias conflict: a second TMDB id on the same lid is refused; the other film's card does not show 3.5.
{
 const {env,Facts,worker}=world();
 await Facts.linkFilm(env,{letterboxd:LID,tmdb:TMDB});
 await assert.rejects(Facts.linkFilm(env,{letterboxd:LID,tmdb:'1'}),error=>error.code==='alias_conflict');
 await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:3.5});
 const data=await viewGet(worker,env);
 assert.equal(data.films[LID].actualRating,3.5);
 assert.doesNotMatch(renderCard(OTHER_FILM,data.films),/<span>МОЯ ОЦЕНКА<\/span><strong>3\.5<\/strong>/);
}

// 5. Watched without a rating: no «Моя оценка», forecast stays.
{
 const {env,Facts,worker}=world();
 const summary=await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:null});
 assert.equal(summary.written,1);
 const data=await viewGet(worker,env);
 assert.equal(data.films[LID].watched,true);
 assert.equal(data.films[LID].actualRating,null);
 const html=renderCard(FILM,data.films);
 assertNoActual(html);
 assert.match(html,/<span>ПРОГНОЗ<\/span><strong>4\.0<\/strong>/);
}

// 6. Rating update 3.5 → 4.5 on a later diary write.
{
 const {env,Facts,worker}=world();
 await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:3.5,watchedDate:'2026-11-08'});
 await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:4.5,watchedDate:'2026-11-10'});
 const data=await viewGet(worker,env);
 assert.equal(data.films[LID].actualRating,4.5);
 assertActualAndForecast(renderCard(FILM,data.films),4.5,4);
}

// 7. No fact: no «Моя оценка». Stale prediction still shows with the actual when the fact exists.
{
 const {env,Facts,worker,bucket}=world();
 const empty=await viewGet(worker,env);
 assertNoActual(renderCard(FILM,empty.films));
 await diary(Facts,env,{lid:LID,tmdb:TMDB,rating:3.5});
 bucket.set('enrichment/view-index.json',{[LID]:{prediction:{...PREDICTION,stale:true}}});
 const stale=await viewGet(worker,env);
 const html=renderCard(FILM,stale.films);
 assertActualAndForecast(html,3.5,4);
 assert.match(html,/is-stale/);
}

// 8. Presentation reads the tmdb_<n> overlay key when the lid index entry has only the prediction (split keys).
{
 const films={[LID]:{prediction:PREDICTION,actualRating:null},[ALIAS]:{actualRating:3.5,watched:true}};
 assertActualAndForecast(renderCard(FILM,films),3.5,4);
 const conflicted={[LID]:{prediction:PREDICTION,actualRating:3.5},[ALIAS]:{actualRating:4,watched:true}};
 assertNoActual(renderCard(FILM,conflicted));
 assert.match(renderCard(FILM,conflicted),/<span>ПРОГНОЗ<\/span>/);
}

console.log('watchlist-card-rating: diary 1Vuo/tmdb_10750 overlay, paging, card HTML and edge cases passed');
